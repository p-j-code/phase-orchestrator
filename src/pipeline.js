// Pipeline (v0.14.33) — chains every safe-to-automate stage of a project's
// lifecycle in ONE command, so the operator's single "/run <p> pipeline" carries
// from intake all the way to a ship-ready state:
//
//   requirements/roadmap intake  →  brief  →  build (plan + phases + reviews)
//     →  drain bug inbox (round → fixes)  →  audit → promote → fixes  (× rounds,
//        re-auditing until an audit comes back clean)  →  QA handoff  →  STOP.
//
// DESIGN: this is a THIN sequencer over already-tested primitives —
//   performReqPromote, runGuide('brief-author'|'audit'), autoRun (which itself
//   auto-plans, runs phases/reviews, and any existing bug rounds), performBugPromote,
//   promoteAuditToBugs, generateQaHandoff. The pipeline adds only the ordering +
//   the stop logic. It deliberately does NOT:
//   - ship (ship is the human review gate — the pipeline ends at ship-ready on
//     develop and hands back to the operator), or
//   - spin off new projects from roadmap items (that needs a name/profile).
//
// It stops at the FIRST blocker (a build/fix run that ends failed/cancelled or
// pauses on budget / validator / mid-build), surfacing it for the operator. A
// run that ends "completed" or pauses on a clean terminal kind (all-phases- or
// fix-round-complete) is NOT a blocker — the pipeline advances.

import path from 'node:path';
import fs from 'node:fs/promises';
import { briefPath, planJsonPath, suggestionsPath, archiveSupersededPhases } from './lib/guide-paths.js';
import { PAUSE_KINDS } from './lib/pause-classifier.js';

const CLEAN_PAUSE = new Set([PAUSE_KINDS.FIX_ROUND_COMPLETE, PAUSE_KINDS.ALL_PHASES_COMPLETE]);
const STAGE_ORDER = ['brief', 'build', 'fixes', 'qa'];

/**
 * Did an autoRun round end WITHOUT a blocker? Exported + pure so it can be
 * unit-tested. `null` means nothing ran (e.g. a clean audit produced no round) —
 * that is not a blocker.
 */
export function roundCleanlyDone(result) {
  if (!result) return true;
  if (result.status === 'completed') return true;
  return result.status === 'paused' && CLEAN_PAUSE.has(result.pauseKind);
}

/** Should `stage` run, given an early-stop point? Exported + pure for testing. */
export function stageEnabled(stage, stopAfter) {
  const stopIdx = STAGE_ORDER.indexOf(stopAfter);
  const safeStop = stopIdx === -1 ? STAGE_ORDER.length - 1 : stopIdx;
  return STAGE_ORDER.indexOf(stage) <= safeStop;
}

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

// Local notify wrapper — a Telegram-side failure must never abort the pipeline.
async function note(notifier, job, text) {
  if (!notifier) return;
  try {
    await notifier.notify({ text, job });
  } catch (err) {
    console.warn(`[pipeline] notify failed: ${err.message} (continuing — Telegram outage does not abort pipeline)`);
  }
}

/**
 * Run the full pipeline.
 *
 * @param {object}  o
 * @param {string}  o.projectName
 * @param {string}  o.projectsDir            absolute path to the projects/ dir
 * @param {number} [o.rounds=1]              audit→fix loop iterations (clamped 1..10)
 * @param {string} [o.stopAfter='qa']        'brief' | 'build' | 'fixes' | 'qa'
 * @param {boolean}[o.autoBrief=false]        build on a freshly-authored brief without stopping for review
 * @param {object} [o.notifier=null]         Telegram notifier (optional)
 * @param {object} [o.job=null]              job row for notifier payloads
 * @returns {Promise<{ stoppedAt: string, reason: string, ranStages: string[], lastResult: object|null }>}
 *          stoppedAt: 'ship-gate' on full success; a stage name on early-stop/blocker.
 */
export async function runPipeline({
  projectName, projectsDir, rounds = 1, stopAfter = 'qa', autoBrief = false, notifier = null, job = null,
}) {
  // Lazy-import the DB layer so module load (and the unit tests of the pure
  // helpers above) don't pull in better-sqlite3.
  const { getProject, listBugs } = await import('./state.js');
  const proj = getProject(projectName);
  if (!proj) throw new Error(`Project not found: ${projectName}`);

  const projDir = path.join(projectsDir, projectName);
  const maxRounds = Math.max(1, Math.min(10, Number(rounds) || 1));
  const ran = [];
  const tell = (t) => note(notifier, job, t);
  // A guide task throws is_preflight_error on git divergence / branch mismatch.
  // Convert that into a clean pipeline stop (with the reconcile guidance from
  // syncWithRemote) instead of a raw job failure.
  const gitStop = (e) => ({ stoppedAt: 'git', reason: e.message, ranStages: ran, lastResult: null });
  const inboxPending = () => {
    try {
      return listBugs({ project: projectName, status: 'inbox' }).length
        + listBugs({ project: projectName, status: 'refined' }).length;
    } catch { return 0; }
  };

  // Lazy imports — these pull in heavy/server-side primitives; keep them out of
  // module load so a plain `import { roundCleanlyDone }` stays cheap.
  const { runGuide } = await import('./lib/phase-runner.js');
  const { autoRun } = await import('./auto-runner.js');
  const { promoteAuditToBugs } = await import('./lib/audit-promote.js');
  const { performBugPromote } = await import('./commands/bugs-inbox.js');
  const { performReqPromote } = await import('./commands/req-promote.js');

  // ── Intake: promote any scope=now (auto-scoped) requirements into raw-thoughts
  //    so a (re)brief picks them up. Roadmap items that were dumped to the inbox
  //    flow through here too. No-op (and no error) when there's nothing to promote.
  let reqsPromoted = 0;
  try {
    const r = await performReqPromote({ project: projectName, scope: 'now', autoScope: true });
    reqsPromoted = r?.promoted || 0;
    if (reqsPromoted) { ran.push('req-intake'); await tell(`📥 Promoted ${reqsPromoted} requirement(s) into raw-thoughts.`); }
  } catch { /* nothing promotable — fine */ }

  // ── Brief: author only if missing, or if intake added new requirements.
  if (stageEnabled('brief', stopAfter)) {
    const briefMissing = !(await fileExists(briefPath(projDir)));
    const needBrief = briefMissing || reqsPromoted > 0;
    if (needBrief) {
      await tell(`📝 Authoring brief for ${projectName}…`);
      let briefRes;
      try { briefRes = await runGuide({ projectName, task: 'brief-author' }); }
      catch (e) { if (e?.is_preflight_error) return gitStop(e); throw e; }
      // v0.14.41: a failed brief-author RESULT previously fell through — the
      // review gate then said "review .guide/brief.md" for a file that was
      // never written, or --auto-brief runs died downstream on the
      // missing-brief gate with the wrong reason.
      if (briefRes?.is_error) {
        return { stoppedAt: 'brief', reason: `brief-author failed: ${(briefRes.error_message || briefRes.result || 'guide error').toString().slice(0, 300)}`, ranStages: ran, lastResult: null };
      }
      ran.push('brief');
    }
    if (stopAfter === 'brief') {
      await tell(`⏸ Stopping after brief — review .guide/brief.md, then re-run the pipeline.`);
      return { stoppedAt: 'brief', reason: 'brief drafted — review before continuing', ranStages: ran, lastResult: null };
    }
    // Safety gate: a brief authored FROM SCRATCH is unreviewed — don't build on
    // it unattended unless explicitly told to (--auto-brief). A pre-existing
    // brief (even one we just appended new requirements to) is assumed reviewed,
    // so the pipeline flows straight through for the common dogfooding case.
    if (briefMissing && needBrief && !autoBrief) {
      await tell(`⏸ Stopping after authoring a NEW brief — review .guide/brief.md, then re-run (or use --auto-brief to skip this gate).`);
      return { stoppedAt: 'brief-review', reason: 'brief authored from scratch — review before building (pass --auto-brief to bypass)', ranStages: ran, lastResult: null };
    }
  }

  // ── Plan: regenerate plan.json when brief.md or suggestions.md is newer than
  //    plan.json. Covers: (a) brief just authored above, (b) operator rewrote
  //    brief.md for a new cycle, (c) /suggest ran and produced fresh suggestions.md.
  if (stageEnabled('build', stopAfter)) {
    const planFile = planJsonPath(projDir);
    const briefFile = briefPath(projDir);
    const suggestFile = suggestionsPath(projDir);
    let needsPlan = false;
    try {
      const [bStat, pStat, sStat] = await Promise.all([
        fs.stat(briefFile).catch(() => null),
        fs.stat(planFile).catch(() => null),
        fs.stat(suggestFile).catch(() => null),
      ]);
      const briefNewer = !!bStat && (!pStat || bStat.mtimeMs > pStat.mtimeMs);
      const suggestNewer = !!sStat && (!pStat || sStat.mtimeMs > pStat.mtimeMs);
      needsPlan = briefNewer || suggestNewer;
    } catch { needsPlan = false; }
    if (needsPlan) {
      await tell(`📋 Regenerating plan for ${projectName} (brief or suggestions updated)…`);
      let planRes;
      try { planRes = await runGuide({ projectName, task: 'plan' }); }
      catch (e) { if (e?.is_preflight_error) return gitStop(e); throw e; }
      // v0.14.41: (a) a failed plan RESULT previously fell through; (b) this
      // pre-plan path bypassed the .36 structural gate that lives in
      // executeAction — pipeline-built plans got NO validation/regen. Both
      // closed via the shared ensureValidPlan.
      if (planRes?.is_error) {
        return { stoppedAt: 'build', reason: `plan failed: ${(planRes.error_message || planRes.result || 'guide error').toString().slice(0, 300)}`, ranStages: ran, lastResult: null };
      }
      {
        const { ensureValidPlan } = await import('./auto-runner.js');
        const ev = await ensureValidPlan({ projectName, projDir });
        if (!ev.ok) {
          return { stoppedAt: 'build', reason: ev.error.slice(0, 400), ranStages: ran, lastResult: null };
        }
      }
      ran.push('plan');
      // Reset DB so autoRun starts from the new plan's first phase, not the old
      // current_phase. Also archive stale phase directories so findPhaseDir never
      // picks up old prompts for new-plan phase numbers.
      try {
        const { resetProjectForNewPlan } = await import('./state.js');
        const planRaw = await fs.readFile(planFile, 'utf-8');
        const plan = JSON.parse(planRaw);
        const maxN = plan.phases?.length > 0 ? plan.phases[plan.phases.length - 1].n : 0;
        resetProjectForNewPlan(projectName, maxN);
        await archiveSupersededPhases(projDir, plan);
      } catch { /* non-fatal — autoRun will still pick up new phases by n value */ }
    }
  }

  // ── Build: autoRun auto-plans (if no plan.json), generates workspace/CLAUDE.md,
  //    runs phases + reviews, and executes any pre-existing bug rounds. unattended.
  if (stageEnabled('build', stopAfter)) {
    await tell(`▶ Building ${projectName} (plan → phases → reviews)…`);
    const buildRes = await autoRun({ projectName, unattended: true, notifier });
    ran.push('build');
    if (!roundCleanlyDone(buildRes)) {
      return { stoppedAt: 'build', reason: `build blocker: ${buildRes?.reason || buildRes?.status}`, ranStages: ran, lastResult: buildRes };
    }
    if (stopAfter === 'build') {
      return { stoppedAt: 'build', reason: 'build complete', ranStages: ran, lastResult: buildRes };
    }
  }

  // ── Fixes: (1) drain the bug inbox, then (2) audit→promote→fix until clean / N.
  if (stageEnabled('fixes', stopAfter)) {
    // (1) Bug inbox — each pending batch becomes a round, then runs to completion.
    let guard = 0;
    while (inboxPending() > 0 && guard < maxRounds + 5) {
      guard += 1;
      let promo;
      try { promo = await performBugPromote({ project: projectName }); }
      catch { break; } // nothing left to promote
      if (!promo || !promo.round) break;
      await tell(`🐞 Inbox → bugs round ${promo.round} (${promo.totalFixes ?? '?'} fix(es)). Running…`);
      const r = await autoRun({ projectName, unattended: true, notifier });
      ran.push(`inbox-fix-${promo.round}`);
      if (!roundCleanlyDone(r)) {
        return { stoppedAt: 'fixes', reason: `inbox-fix blocker: ${r?.reason || r?.status}`, ranStages: ran, lastResult: r };
      }
    }

    // (2) Audit → promote → fixes, repeated until an audit is clean or N rounds.
    let lastFix = null;
    for (let i = 0; i < maxRounds; i++) {
      await tell(`🔍 Audit ${i + 1}/${maxRounds} — ${projectName}…`);
      let auditRes;
      try { auditRes = await runGuide({ projectName, task: 'audit' }); }
      catch (e) { if (e?.is_preflight_error) return gitStop(e); throw e; }
      // v0.14.39: a failed audit RESULT (not a throw) previously fell through
      // to promote, which then hit the previous audit's sentinel — the chain
      // stopped as "duplicate" with the real failure swallowed.
      if (auditRes?.is_error) {
        return { stoppedAt: 'fixes', reason: `audit failed (round ${i + 1}): ${(auditRes.error_message || auditRes.result || 'guide error').toString().slice(0, 300)}`, ranStages: ran, lastResult: lastFix };
      }
      let p;
      try { p = await promoteAuditToBugs({ projDir, projectName }); }
      catch (e) { return { stoppedAt: 'fixes', reason: `promote error: ${e.message}`, ranStages: ran, lastResult: lastFix }; }
      if (!p.promoted) {
        await tell(`✓ Audit ${i + 1} clean — nothing to fix. Pipeline fix phase done.`);
        break;
      }
      await tell(`🐞 Audit → bugs round ${p.round}. Running fixes…`);
      lastFix = await autoRun({ projectName, unattended: true, notifier });
      ran.push(`audit-fix-${p.round}`);
      if (!roundCleanlyDone(lastFix)) {
        return { stoppedAt: 'fixes', reason: `audit-fix blocker: ${lastFix?.reason || lastFix?.status}`, ranStages: ran, lastResult: lastFix };
      }
    }
    if (stopAfter === 'fixes') {
      return { stoppedAt: 'fixes', reason: 'fixes complete', ranStages: ran, lastResult: lastFix };
    }
  }

  // ── QA handoff (doc only; best-effort — a failure here doesn't fail the run).
  if (stageEnabled('qa', stopAfter)) {
    try {
      const { generateQaHandoff } = await import('./commands/qa-handoff.js');
      await generateQaHandoff(projectName, { withSteps: true });
      ran.push('qa-handoff');
      await tell(`📋 QA handoff generated under .guide/qa-handoffs/.`);
    } catch (e) {
      await tell(`⚠ QA handoff skipped: ${e.message}`);
    }
  }

  // ── Terminal: ship-ready. The pipeline NEVER ships — that's your review gate.
  await tell(`✅ Pipeline complete for ${projectName} — ready for your review + /ship.`);
  return { stoppedAt: 'ship-gate', reason: 'pipeline complete — ready for review + ship', ranStages: ran, lastResult: null };
}
