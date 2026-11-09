// Speculative opus+fable duo (Phase 72 / brief P6, blueprint MI-8 weakened) —
// the LAST RESORT before a force_tier-critical PHASE pauses for a human.
//
// When a phase forced to a top tier by a `force_tier` keyword rule
// (regulatory-core / security-core in config/model-routing.json) has burned
// its attempt AND its escalation ladder and would otherwise pause, this races
// two competing retry legs — opus and fable — concurrently in separate git
// worktree lanes, with the acceptance checker as the JUDGE. The winner is
// merged into the real workspace; if neither wins, the run pauses exactly as it
// would have. Opt-in (auto_run.speculative_duo_on_double_failure, default
// false); with it off, ZERO of this module runs.
//
// SAFETY-CRITICAL. Before the duo can branch two lanes off a clean base it must
// git reset --hard the REAL workspace back to the phase's pre-attempt sha
// (origin tip) to discard the failed attempt commit(s). That reset is guarded
// by aheadBehind + a per-commit subject check: the local-beyond-origin commits
// must be ONLY this phase's failed attempts, still unpushed. Anything pushed,
// diverged, or foreign ABORTS the duo (no reset → normal pause). A wrong guard
// here destroys committed work.
//
// Conventions (brief 05): ALL git through src/lib/git.js; ALL paths via
// path.join/path.resolve; all fs async fs/promises; ALL subprocess spawning
// through the lane machinery's runDev (→ claude-runner). Reuses phase 67's
// provisionLane/destroyLane, phase 68's completeMergedPhase + merged-HEAD gate,
// and verify-loop.js's runAcceptanceCheck unchanged.

import fs from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import {
  aheadBehind, resetHard, mergeNoFf, mergeAbort, phaseCommitSha, getHeadSha,
  pushBranch, changedFilesSince, runGit,
} from './git.js';
import { provisionLane, destroyLane } from './lane-manager.js';
import { runDev, completeMergedPhase } from './phase-runner.js';
import { runAcceptanceCheck, decideVerdict } from './verify-loop.js';
import { windowStatus } from '../billing-guard.js';
import { withJobKey } from '../claude-runner.js';
import { runValidatorGate, gateFailureExcerpt } from './validators.js';
import { escalationMarkerPath, legacyEscalationMarkerPath } from './escalation.js';
import { phaseDir } from './guide-paths.js';
import { getProject, recordRunEvent } from '../state.js';

// The duo makes exactly four billable calls at minimum: two dev legs + two
// judge acceptance checks. It only fires when the window has headroom for all
// four BEFORE warn_at_calls (the in-lane acceptance check is skipped for duo
// legs — see runDev's modelOverride path — so the judge's two checks are the
// only checker calls). No new budget math; just a headroom gate.
export const DUO_MIN_WINDOW_CALLS = 4;

// The two competing tiers, in deterministic order (opus first). A force_tier
// phase routes BOTH legs to the same tier; the model override on each leg is
// what makes them race DIFFERENT models off the same phase.
export function duoLegDefs(cfg) {
  const tierModels = cfg?.model_routing?.tier_models || {};
  return [
    { tier: 'opus', model: tierModels.opus || 'claude-opus-4-8' },
    { tier: 'fable', model: tierModels.fable || 'claude-fable-5' },
  ];
}

/**
 * Did routeModel resolve this phase via a `force_tier` keyword rule? Inspects
 * the routing reasoning trail (model-router.js emits
 * `keyword [<label>] force_tier <tier> wins outright ...` for exactly that
 * case). Pure — the caller passes an already-computed routeModel() result.
 */
export function routingMatchedForceTier(routing) {
  const reasoning = Array.isArray(routing?.reasoning) ? routing.reasoning : [];
  return reasoning.some((r) => /\bforce_tier\b/.test(r) && /\bwins outright\b/.test(r));
}

/**
 * Pure eligibility gate — ALL conditions checked just before the pause. Ordered
 * so the flag is the FIRST check: with the flag off, the caller never reaches
 * any duo code (mode isolation). Returns { eligible, reason }.
 *
 * @param {object} a
 * @param {object} a.cfg              resolved config (auto_run.speculative_duo_on_double_failure)
 * @param {object} a.action          the failing action ({ kind, phaseN, ... })
 * @param {boolean} a.isForceTier     routingMatchedForceTier(routeModel(...))
 * @param {object} a.windowStatus     billing-guard windowStatus(cfg) result
 */
export function isDuoEligible({ cfg, action, isForceTier, windowStatus: ws }) {
  if (cfg?.auto_run?.speculative_duo_on_double_failure !== true) {
    return { eligible: false, reason: 'speculative_duo_on_double_failure disabled (default)' };
  }
  // A FIX never duos — fixes park (on_double_failure), phases build on each other.
  if (action?.kind !== 'dev') {
    return { eligible: false, reason: `action is '${action?.kind}', not a phase (fixes park, never duo)` };
  }
  if (!isForceTier) {
    return { eligible: false, reason: 'phase routing did not match a force_tier keyword rule' };
  }
  const headroom = (ws?.warnThreshold ?? 0) - (ws?.callsInWindow ?? 0);
  if (headroom < DUO_MIN_WINDOW_CALLS) {
    return { eligible: false, reason: `insufficient window headroom (${headroom} < ${DUO_MIN_WINDOW_CALLS} calls before warn_at_calls)` };
  }
  return { eligible: true, reason: 'eligible' };
}

/**
 * Is a leg result a refusal? Fable can return a `refusal` stop_reason on
 * security-adjacent content. A refusal is a LOST LEG — never an is_error to
 * heal or escalate. Tolerant of the shapes claude-runner / a stubbed dev may
 * surface. Pure.
 */
export function isRefusalResult(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.stop_reason === 'refusal') return true;
  if (result.refusal === true) return true;
  if (typeof result.subtype === 'string' && /refus/i.test(result.subtype)) return true;
  return false;
}

/**
 * Pure judge over the surviving legs. Rules (brief P6):
 *   - pass beats fail (only a leg whose acceptance status is 'pass' can win);
 *   - both pass  → fewer unmet criteria wins;
 *   - exact tie  → fable;
 *   - no leg passed → no winner (caller pauses).
 * `legs` carry { tier, model, judge: { status, unmet }, ... }. Returns
 * { winner: leg|null, reason }.
 */
export function decideDuoWinner(legs) {
  const passing = (legs || []).filter((l) => l?.judge && l.judge.status === 'pass');
  if (passing.length === 0) {
    return { winner: null, reason: 'no leg passed acceptance verification' };
  }
  if (passing.length === 1) {
    return { winner: passing[0], reason: `only ${passing[0].tier} passed acceptance` };
  }
  const [a, b] = passing;
  if (a.judge.unmet < b.judge.unmet) {
    return { winner: a, reason: `${a.tier} passed with fewer unmet criteria (${a.judge.unmet} < ${b.judge.unmet})` };
  }
  if (b.judge.unmet < a.judge.unmet) {
    return { winner: b, reason: `${b.tier} passed with fewer unmet criteria (${b.judge.unmet} < ${a.judge.unmet})` };
  }
  const fable = passing.find((l) => l.tier === 'fable') || passing[0];
  return { winner: fable, reason: `both passed with ${a.judge.unmet} unmet — exact tie → fable wins` };
}

// ── Internal helpers (exported where a test needs to drive them directly) ────

/**
 * Safety-critical restore. Verifies the local-beyond-origin commits contain
 * ONLY this phase's failed attempt(s) and are still unpushed, then resets the
 * REAL workspace HARD back to origin tip (= the phase's pre-attempt sha).
 * ABORTS (ok:false) — with NO reset — on anything pushed, diverged, or foreign.
 *
 * @returns {Promise<{ok:true, preSha:string} | {ok:false, reason:string}>}
 */
export async function verifyAndRestore(
  { workspaceDir, branch, phaseN },
  deps = {},
) {
  const _aheadBehind = deps.aheadBehind ?? aheadBehind;
  const _runGit = deps.runGit ?? runGit;
  const _resetHard = deps.resetHard ?? resetHard;
  const log = deps.log ?? ((m) => console.log(m));

  if (!branch) return { ok: false, reason: 'no git_branch on record — cannot verify push state' };

  const ab = await _aheadBehind(workspaceDir, branch);
  if (!ab) return { ok: false, reason: `no upstream origin/${branch} to compare against — ambiguous, not resetting` };
  if (ab.behind > 0) return { ok: false, reason: `workspace diverged from origin/${branch} (behind ${ab.behind}) — ambiguous, not resetting` };
  // ahead===0 ⇒ nothing local to discard: the failed attempt was pushed (its
  // commit reached origin, so resetting to origin tip would NOT roll it back) or
  // never committed. Either way the pre-attempt state is unrecoverable here —
  // ABORT (matches src/auto-runner.js's resetIfUnpushed `ab.ahead === 0` rule).
  if (ab.ahead === 0) return { ok: false, reason: `no un-pushed local commit ahead of origin/${branch} — the failed attempt was pushed or never committed; ambiguous, not resetting` };

  // preSha = origin tip. All of this phase's failed attempts are unpushed
  // (a failed phase never pushes), so origin tip IS the pre-attempt sha.
  const rp = await _runGit(workspaceDir, ['rev-parse', `origin/${branch}`]);
  const preSha = rp.ok ? rp.stdout.trim() : '';
  if (!/^[0-9a-f]{7,40}$/i.test(preSha)) return { ok: false, reason: `could not resolve origin/${branch} tip` };

  // Every commit ahead of origin MUST be one of THIS phase's attempts. A
  // foreign commit (e.g. a prior phase whose push failed and stayed local)
  // means resetting to origin tip would destroy committed work → ABORT.
  const logRes = await _runGit(workspaceDir, ['log', '--format=%s', `${preSha}..HEAD`]);
  if (!logRes.ok) return { ok: false, reason: `could not list commits ${preSha.slice(0, 8)}..HEAD` };
  const subjects = logRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const foreign = subjects.filter((s) => !s.startsWith(`phase-${phaseN}:`));
  if (foreign.length) {
    return {
      ok: false,
      reason: `${foreign.length} local commit(s) ahead of origin are NOT phase-${phaseN} attempts (e.g. "${foreign[0].slice(0, 60)}") — ambiguous, not resetting`,
    };
  }

  const reset = await _resetHard(workspaceDir, preSha);
  if (!reset.ok) return { ok: false, reason: `git reset --hard ${preSha.slice(0, 8)} failed: ${reset.error}` };
  log(chalk.dim(`  → Duo restore: reset workspace to origin/${branch} tip ${preSha.slice(0, 8)} (discarded ${subjects.length} failed phase-${phaseN} commit(s))`));
  return { ok: true, preSha };
}

/** Delete the phase's failure markers (validation-failed + escalate, new + legacy). */
async function deletePhaseFailureMarkers(projDir, phaseN) {
  const paths = [
    path.join(projDir, '.guide', `phase-${phaseN}-validation-failed.marker`),
    escalationMarkerPath(projDir, { phaseN }),
    legacyEscalationMarkerPath(projDir, { phaseN }),
  ];
  for (const p of paths) {
    // eslint-disable-next-line no-await-in-loop
    await fs.unlink(p).catch(() => {});
  }
}

/** The ONE merged-HEAD validator gate for the duo winner — mirrors phase 68's gateMergedHead. */
async function gateDuoMergedHead({ projectName, workspaceDir, cfg, baseSha, phaseN }) {
  if (cfg?.validators?.enabled === false) return { hasFailures: false, skipped: 'validators disabled', results: [] };
  const changed = baseSha ? await changedFilesSince(workspaceDir, baseSha) : { ok: false };
  return runValidatorGate({
    projectName, workspaceDir,
    event: { phase: phaseN, phaseTitle: `speculative duo winner (phase ${phaseN})` },
    changedFiles: changed.ok ? changed.files : [], cfg,
  });
}

/** Persist one leg's judge verdict under the phase dir (per-tier, so the two never clobber). */
async function writeLegVerify({ projDir, phaseN, phaseTitle, tier, verdict }) {
  try {
    const dir = await phaseDir(projDir, phaseN, phaseTitle);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `duo-${tier}-verify.json`), JSON.stringify(verdict ?? null, null, 2), 'utf-8');
  } catch { /* best-effort — duo.json still records the verdict summary */ }
}

/** Write the duo.json summary to the phase dir (on EVERY outcome). */
async function writeDuoSummary({ projDir, phaseN, phaseTitle, summary }) {
  try {
    const dir = await phaseDir(projDir, phaseN, phaseTitle);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'duo.json'), JSON.stringify(summary, null, 2), 'utf-8');
  } catch (err) {
    console.warn(chalk.yellow(`[duo] could not write duo.json for phase ${phaseN}: ${err.message}`));
  }
}

/**
 * Run the speculative opus+fable duo for a force_tier-critical phase that has
 * burned its attempt + escalation and would otherwise pause. Assumes the caller
 * has ALREADY gated on isDuoEligible (flag + phase + force_tier + window). The
 * ONE thing this re-owns unconditionally is the safety-critical restore guard.
 *
 * Flow: verify+restore workspace to preSha → provision duo-opus / duo-fable
 * lanes off preSha → run both concurrently (runDev laneMode + modelOverride) →
 * judge each surviving committed leg with a fresh runAcceptanceCheck against its
 * laneDir → pick the winner (pass beats fail; fewer-unmet wins; tie → fable) →
 * mergeNoFf the winner + re-gate merged HEAD + completeMergedPhase + ONE push.
 * duo.json written on EVERY outcome; both lanes torn down in `finally`.
 *
 * @returns {Promise<{ran:boolean, outcome:'merged'|'both-fail'|'gate-fail'|'aborted',
 *   winner:{tier:string,model:string}|null, pushed:boolean, reason:string, actions:number}>}
 *   outcome 'merged' ⇒ the phase is now complete (caller continues); any other
 *   outcome ⇒ the caller pauses exactly as it would have.
 */
export async function runSpeculativeDuo(
  { projectName, cfg, projDir, workspaceDir, phaseN, phaseTitle = null, phaseMeta = null, runId = null, notifier = null },
  deps = {},
) {
  const _provisionLane = deps.provisionLane ?? provisionLane;
  const _destroyLane = deps.destroyLane ?? destroyLane;
  const _runDev = deps.runDev ?? runDev;
  const _runAcceptanceCheck = deps.runAcceptanceCheck ?? runAcceptanceCheck;
  const _mergeNoFf = deps.mergeNoFf ?? mergeNoFf;
  const _mergeAbort = deps.mergeAbort ?? mergeAbort;
  const _resetHard = deps.resetHard ?? resetHard;
  const _phaseCommitSha = deps.phaseCommitSha ?? phaseCommitSha;
  const _getHeadSha = deps.getHeadSha ?? getHeadSha;
  const _pushBranch = deps.pushBranch ?? pushBranch;
  const _completeMergedPhase = deps.completeMergedPhase ?? completeMergedPhase;
  const _gateMergedHead = deps.gateMergedHead ?? gateDuoMergedHead;
  const _verifyAndRestore = deps.verifyAndRestore ?? verifyAndRestore;
  const _withJobKey = deps.withJobKey ?? withJobKey;
  const _getProject = deps.getProject ?? getProject;
  const _recordRunEvent = deps.recordRunEvent ?? recordRunEvent;
  const _writeDuoSummary = deps.writeDuoSummary ?? writeDuoSummary;
  const _now = deps.now ?? (() => new Date().toISOString());
  const log = deps.log ?? ((m) => console.log(m));

  const project = _getProject(projectName);
  const branch = project?.git_branch || null;
  const legDefs = duoLegDefs(cfg);

  // duo.json skeleton — always written, regardless of outcome.
  const summary = {
    phase: phaseN,
    at: _now(),
    outcome: 'aborted',
    preSha: null,
    chosen: null,
    pushed: false,
    reason: '',
    legs: legDefs.map((d) => ({ tier: d.tier, model: d.model, lane: `duo-${d.tier}`, status: 'not-run', commit_sha: null, judge: null })),
  };

  const lanes = [];                 // { def, lane }
  const laneStatus = new Map();     // laneId → terminal phase_lanes status for teardown

  const finish = async (outcome, reason, { pushed = false, winner = null, ran = true } = {}) => {
    summary.outcome = outcome;
    summary.reason = reason;
    summary.pushed = pushed;
    if (winner) summary.chosen = winner.tier;
    await _writeDuoSummary({ projDir, phaseN, phaseTitle, summary });
    return { ran, outcome, winner, pushed, reason, actions: lanes.length };
  };

  // ── 1. Workspace restore (safety-critical) ────────────────────────────────
  const restore = await _verifyAndRestore({ workspaceDir, branch, phaseN }, { log });
  if (!restore.ok) {
    log(chalk.yellow(`  → Speculative duo ABORTED (${restore.reason}) — normal pause.`));
    return finish('aborted', restore.reason, { ran: false });
  }
  const preSha = restore.preSha;
  summary.preSha = preSha;
  await deletePhaseFailureMarkers(projDir, phaseN);

  try {
    // ── 2. Provision both lanes off preSha, race both legs concurrently ─────
    for (const def of legDefs) {
      // eslint-disable-next-line no-await-in-loop
      const lane = await _provisionLane({ projectName, workspaceDir, projDir, kind: 'duo', tier: def.tier, n: phaseN, baseSha: preSha, cfg });
      lanes.push({ def, lane });
      laneStatus.set(lane.laneId, 'abandoned');
    }
    _recordRunEvent(runId, 'phase-started', { project: projectName, phase: phaseN });
    log(chalk.cyan(`  ⇉ Speculative duo: phase ${phaseN} — racing ${legDefs.map((d) => `${d.tier}(${d.model})`).join(' vs ')} in ${lanes.length} lane(s) (base ${preSha.slice(0, 8)})`));

    const settled = await Promise.allSettled(lanes.map(({ def, lane }) =>
      _withJobKey(lane.jobKey, () => _runDev({
        projectName, laneMode: true, laneDir: lane.laneDir, laneBranch: lane.branch,
        lanePhaseN: phaseN, modelOverride: def.model,
      })),
    ));

    // ── 3. Classify each leg: surviving-committed vs LOST (error/refusal) ────
    const legs = lanes.map(({ def, lane }, i) => {
      const s = settled[i];
      const value = s.status === 'fulfilled' ? s.value : null;
      const rejected = s.status === 'rejected';
      const refused = !rejected && isRefusalResult(value);
      const lost = rejected || refused || !value || value.is_error;
      const summaryLeg = summary.legs[i];
      if (lost) {
        // REFUSAL = LOST LEG: phase_lanes.status='failed'; a refusal is NEVER
        // routed to auto-heal or the escalation ladder — this path owns the
        // leg outcome directly and imports neither.
        summaryLeg.status = refused ? 'refused' : 'lost';
        laneStatus.set(lane.laneId, 'failed');
        const why = rejected ? (s.reason?.message || 'lane threw')
          : refused ? 'refusal stop_reason'
            : (value?.error_message || value?.result || 'lane error');
        log(chalk.yellow(`  → Duo leg ${def.tier} LOST (${String(why).slice(0, 160)}) — lane recorded failed; duo continues on the surviving leg`));
      } else {
        summaryLeg.status = 'committed';
        summaryLeg.commit_sha = value.commit_sha || null;
      }
      return { def, lane, survived: !lost, commit_sha: lost ? null : (value.commit_sha || null), summaryLeg, judge: null, verdict: null };
    });

    const survivors = legs.filter((l) => l.survived);
    if (survivors.length === 0) {
      log(chalk.red('  ✗ Speculative duo: both legs lost (errored/refused) — pausing for human.'));
      return finish('both-fail', 'both legs lost (errored/refused) — no committed leg to judge');
    }

    // ── 4. Judge each surviving leg (fresh checker, workspaceDir = laneDir) ──
    for (const leg of survivors) {
      // eslint-disable-next-line no-await-in-loop
      const jr = await _runAcceptanceCheck({
        cfg, projectName, projDir, workspaceDir: leg.lane.laneDir,
        phaseMeta: phaseMeta || null, preSha, commitSha: leg.commit_sha, nextPhase: phaseN,
      });
      // Tiebreaker for two PASSING legs: a 'pass' has 0 truly-unmet criteria
      // (decideVerdict turns any unmet into an effective fail), so "fewer unmet
      // wins" is scored over criteria NOT cleanly met (unmet + unverifiable) —
      // the leg that verifiably met more of its criteria wins.
      const dv = decideVerdict(jr?.verdict || {});
      const unmet = dv.unmet.length + dv.unverifiable.length;
      leg.judge = { status: jr?.status || 'inconclusive', unmet };
      leg.verdict = jr?.verdict || null;
      leg.summaryLeg.judge = { status: leg.judge.status, unmet };
      // Keep BOTH legs' verify.json (per-tier — the both-fail case needs both).
      // eslint-disable-next-line no-await-in-loop
      await writeLegVerify({ projDir, phaseN, phaseTitle, tier: leg.def.tier, verdict: leg.verdict });
      _recordRunEvent(runId, jr?.status === 'pass' ? 'acceptance-pass' : 'acceptance-fail', { project: projectName, phase: phaseN, unmet });
    }

    // ── 5. Decide the winner ────────────────────────────────────────────────
    const { winner, reason: judgeReason } = decideDuoWinner(survivors);
    if (!winner) {
      log(chalk.red(`  ✗ Speculative duo: ${judgeReason} — pausing (both verify.json kept, no merge).`));
      return finish('both-fail', `no winner: ${judgeReason}`);
    }
    const winnerModel = { tier: winner.def.tier, model: winner.def.model };

    // ── 6. Merge winner → re-gate merged HEAD → complete → ONE push ─────────
    // Merge message must NOT start with "phase-N:" or phaseCommitSha would
    // resolve the merge commit instead of the leg's actual dev commit.
    const merge = await _mergeNoFf(workspaceDir, { branch: winner.lane.branch, message: `Merge ${winner.lane.branch} (speculative duo winner, phase ${phaseN})` });
    if (!merge.ok) {
      await _mergeAbort(workspaceDir).catch(() => {});
      await _resetHard(workspaceDir, preSha).catch(() => {});
      log(chalk.red(`  ✗ Speculative duo winner (${winner.def.tier}) merge conflict onto ${preSha.slice(0, 8)} — rolled back; pausing.`));
      return finish('gate-fail', `winner ${winner.def.tier} merge conflicted onto preSha: ${merge.error}`, { winner: winnerModel });
    }
    const commit_sha = (await _phaseCommitSha(workspaceDir, phaseN)) || (await _getHeadSha(workspaceDir));

    const gate = await _gateMergedHead({ projectName, workspaceDir, cfg, baseSha: preSha, phaseN });
    if (gate?.hasFailures) {
      // Never push a red HEAD: roll the merge back to preSha, pause.
      await _resetHard(workspaceDir, preSha).catch(() => {});
      const excerpt = (gateFailureExcerpt(gate) || 'merged-HEAD validators failed').slice(0, 300);
      log(chalk.red(`  ✗ Speculative duo winner (${winner.def.tier}) FAILED the merged-HEAD validator gate — rolled back to ${preSha.slice(0, 8)}; pausing.`));
      return finish('gate-fail', `merged-HEAD validator gate failed for winner ${winner.def.tier}: ${excerpt}`, { winner: winnerModel });
    }

    // Gate passed — the SAME completeMergedPhase phase 68 introduced (single
    // implementation; never runDev's serial completion machinery), then ONE push.
    _completeMergedPhase({ projectName, n: phaseN, commit_sha, projDir });
    laneStatus.set(winner.lane.laneId, 'done');
    _recordRunEvent(runId, 'dev-completed', { project: projectName, phase: phaseN });

    let pushed = false;
    if (branch) {
      const push = await _pushBranch(workspaceDir, { branch });
      pushed = !!push.ok;
      if (push.ok) log(chalk.green(`  ✓ Speculative duo: phase ${phaseN} won by ${winner.def.tier} (${winner.def.model}) → merged + pushed ${branch} (${commit_sha?.slice(0, 8) || '?'})`));
      else log(chalk.yellow(`  ⚠ Speculative duo winner merged but push failed (${branch}): ${push.error} — commit is local only.`));
    } else {
      log(chalk.dim('  (no git_branch — duo winner merged locally, not pushed)'));
    }
    return finish('merged', `winner ${winner.def.tier}: ${judgeReason}`, { pushed, winner: winnerModel });
  } catch (err) {
    // Any unexpected throw (e.g. provisionLane worktree-add failure): the
    // workspace is already reset to preSha, so pause cleanly. duo.json records it.
    log(chalk.red(`  ✗ Speculative duo errored (${err.message}) — pausing.`));
    return finish('both-fail', `duo execution error: ${err.message}`);
  } finally {
    // Destroy BOTH lanes, bounded + crash-safe (merged winner → done, else abandoned/failed).
    for (const { lane } of lanes) {
      // eslint-disable-next-line no-await-in-loop
      await _destroyLane({
        workspaceDir, laneDir: lane.laneDir, branch: lane.branch, laneId: lane.laneId,
        status: laneStatus.get(lane.laneId) || 'abandoned',
      }).catch(() => {});
    }
  }
}
