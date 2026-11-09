// Job Runner — executes one queued job by invoking existing orchestrator
// command paths. Reports progress + completion via the notifier.
//
// Supported actions include go/resume, brief-chain, audit, bugs, roadmap, ship.
//
// v0.14.7 changes:
//   - BUG-3: every notifier.notify call is wrapped in its own try/catch so a
//     Telegram outage / revoked token / rate-limit on the start-of-job notify
//     can no longer propagate before markJobFailed runs. Previously a throw
//     here stranded the job at status='running' forever, which made
//     nextPendingJobForFreeProject treat the project as busy and silently
//     blocked every subsequent job on that project until next server restart.
//   - BUG-3: removed the redundant markJobRunning(job.id) at the top of
//     executeJob. tryClaimJob in src/server.js already set status='running'
//     and started_at when it claimed the job. Re-running it here was just
//     bumping started_at, throwing off the v0.14.5 elapsed-time display in
//     /status.
//   - BUG-6: autoRun returns {status: 'failed'|'paused'|'completed', reason}
//     rather than throwing. Pre-v0.14.7 we called markJobCompleted
//     unconditionally, so paused and failed auto-runs ended up with
//     tg_jobs.status='completed' AND auto_runs.status='failed' simultaneously,
//     the Telegram header read "✓ Completed: ... — failed: <reason>"
//     (self-contradictory), and the "What next" suggestions landed in the
//     auto-run-completed branch (Mark shipped / QA handoff) — exactly wrong
//     for a budget pause or validator failure. Now we hoist `result` to the
//     outer scope and branch post-switch into failed / paused / completed,
//     using auto-run-failed and auto-run-paused as the next-actions keys.

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  markJobCompleted, markJobFailed, markJobCancelled, getJob,
  enqueueRetryJob, enqueueUniqueResumeJob, enqueueUniqueActionJob,
} from './job-queue.js';
import { isTransientError } from '../lib/transient-errors.js';
import { extractResetsAt } from '../lib/unattended-retry.js';
import { autoRun, detectNewBugRound, notifyContextDriftIfAny } from '../auto-runner.js';
import { runGuide } from '../lib/phase-runner.js';
import { formatConvergenceStallReason } from '../lib/audit-promote.js';
import { startBugCycle } from '../bug-cycle.js';
import {
  setProjectStatus, getProject, resetProjectForNewPlan, recordAuditYield, getBugRound,
  parseProjectMetadata, setProjectMetadataField,
} from '../state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');
// These actions can complete an external/destructive side effect immediately
// before a transient acknowledgement failure. Blind replay could duplicate it.
const TRANSIENT_RETRY_UNSAFE_ACTIONS = new Set(['ship', 'package', 'reset-brief', 'retry-phase', 'discuss']);

// notifySafe — wrap notifier.notify so a Telegram-side failure can never
// strand the caller. All three notify sites (start, paused/completed,
// failure) go through here. `which` is the greppable tag ('start',
// 'completion', 'paused', 'failure').
async function notifySafe(notifier, which, jobId, payload) {
  try {
    await notifier.notify(payload);
  } catch (notifyErr) {
    console.warn(
      `[notifier] ${which}-notify failed for job #${jobId}: ${notifyErr.message} ` +
      `(continuing — Telegram outage does not strand the job)`,
    );
  }
}

// chainAuditEnabled — resolve whether a *config* default opts this project's
// audits into the audit → bugs → fixes chain (auto_run.chain_audit_to_bugs).
// The per-invocation --auto/--chain flag (args.chain) takes precedence and is
// checked first by the caller; this is only consulted when no flag is present.
// Defaults to false on any resolution error so the chain is strictly opt-in.

// v0.14.44: deferred transient retry. When a job dies (or pauses) because the
// WORLD broke — rate limit, overload, 5xx, network — re-enqueue the identical
// job with not_before = now + cooldown and let the picker run it when due,
// recursively until it works (or transient_retry_max). State-driven actions
// (go/resume/audit chains) re-enter where they left off. Returns true if a
// retry was scheduled.
async function maybeScheduleTransientRetry({ job, action, project, reasonText, notifier }) {
  try {
    if (!isTransientError(reasonText)) return false;
    if (TRANSIENT_RETRY_UNSAFE_ACTIONS.has(action)) {
      console.warn(`[transient-retry] ${action} ${project}: automatic replay is unsafe; operator inspection required`);
      return false;
    }
    const { resolve: resolveConfig } = await import('../config-resolver.js');
    const cfg = await resolveConfig({ project, task: 'dev-execution' });
    const ar = cfg?.auto_run || {};
    if (ar.retry_transient === false) return false;
    const max = Number(ar.transient_retry_max) || 0; // 0 = unlimited
    const prior = Number(job.retry_count) || 0;
    if (max > 0 && prior >= max) return false;
    // Use the resetsAt baked into the error for precision timing.
    // If the window clears in the future: schedule at resetsAt + 5min.
    // If resetsAt is already past (window should be clear but still blocked):
    //   retry in 15 min — don't wait another full interval.
    // Fall back to the configured transient_retry_minutes when no resetsAt.
    const resetsAtSec = extractResetsAt(reasonText);
    const resetsAtMs = resetsAtSec ? resetsAtSec * 1000 : null;
    const now = Date.now();
    let notBefore;
    if (resetsAtMs && resetsAtMs > now) {
      notBefore = new Date(resetsAtMs + 5 * 60 * 1000); // 5 min after exact reset
    } else if (resetsAtMs) {
      notBefore = new Date(now + 15 * 60 * 1000); // past reset but still blocked — try in 15 min
    } else {
      const minutes = Math.max(1, Number(ar.transient_retry_minutes) || 60);
      notBefore = new Date(now + minutes * 60 * 1000);
    }
    const args = JSON.parse(job.args_json || '{}');
    // A partially-run go/next must continue from state, not start another
    // top-level attempt. Resume scheduling is globally deduplicated because
    // autoRun.finalize may already have persisted the exact provider-reset job.
    const retryAction = ['go', 'resume', 'next', 'suggestions'].includes(action) ? 'resume' : action;
    let id;
    let newlyScheduled = true;
    if (retryAction === 'resume') {
      // excludeJobId: this runs while the CURRENT job is still status='running'
      // (it is terminalized right after). Without the exclusion the dedupe
      // SELECT finds the job being finalized, reports "existing durable resume",
      // and no successor is ever scheduled — a silently lost overnight retry.
      const queued = enqueueUniqueResumeJob({
        project, args: { ...args, unattended: true }, requestedBy: job.requested_by,
        notBefore, retryCount: prior + 1, excludeJobId: job.id,
      });
      id = queued.jobId;
      newlyScheduled = queued.scheduled;
    } else {
      id = enqueueRetryJob({
        project, action: retryAction, args, requestedBy: job.requested_by,
        notBefore, retryCount: prior + 1,
      });
    }
    const { sanitizeForTelegram } = await import('../lib/telegram-fmt.js');
    const retryInMin = Math.round((notBefore.getTime() - Date.now()) / 60000);
    await notifySafe(notifier, 'transient-retry', job.id, {
      text: newlyScheduled
        ? `⏳ External/API issue — auto-retry <b>#${prior + 1}</b> of <b>${retryAction} ${sanitizeForTelegram(project)}</b> scheduled in ${retryInMin}m (job #${id}).\n<i>${sanitizeForTelegram(reasonText.slice(0, 200))}</i>`
        : `⏳ External/API issue — existing <b>${retryAction} ${sanitizeForTelegram(project)}</b> job #${id} will continue after reset.\n<i>${sanitizeForTelegram(reasonText.slice(0, 200))}</i>`,
      job,
    });
    console.log(`[transient-retry] ${retryAction} ${project}: ${newlyScheduled ? `retry #${prior + 1} scheduled` : 'using existing durable resume'} as job #${id} at ${notBefore.toISOString()}`);
    return true;
  } catch (e) {
    console.warn(`[transient-retry] scheduling failed (non-fatal): ${e.message}`);
    return false;
  }
}

async function chainAuditEnabled(project) {
  try {
    const { resolve: resolveConfig } = await import('../config-resolver.js');
    const cfg = await resolveConfig({ project, task: 'dev-execution' });
    return cfg?.auto_run?.chain_audit_to_bugs === true;
  } catch {
    return false;
  }
}

// ─── Recurring-findings stop (Phase 34) ─────────────────────────────────────

/**
 * Pure decision helper for the audit chain's recurring-findings circuit
 * breaker: stop only when BOTH fingerprints exist and are identical — the
 * previous round already ran a full fix round against this exact finding set
 * and the re-audit promoted it again unchanged. NULL on either side (legacy
 * rows, clean audits, non-BUG-shaped promotions) can never trigger a stop.
 *
 * @param {string|null|undefined} prevFingerprint    previous round's bug_rounds.audit_fingerprint
 * @param {string|null|undefined} currentFingerprint current promotion's fingerprint
 * @returns {boolean}
 */
export function shouldStopForRecurringFindings(prevFingerprint, currentFingerprint) {
  return prevFingerprint != null && currentFingerprint != null && prevFingerprint === currentFingerprint;
}

// ─── Audit auto-chain loop ───────────────────────────────────────────────────
// v0.14.33: optional audit → bugs → fixes auto-chain, repeatable N rounds.
// ONE audit job runs the full pipeline up to `rounds` times:
//   [audit] → promote findings → fix-plan → every fix → [re-audit] → …
// The initial audit already ran in the caller (executeJob's 'audit' case);
// each subsequent round re-audits the now-changed workspace first. The loop
// stops early when:
//   - an audit comes back clean (nothing to promote) — the natural "done"
//     signal: keep auditing+fixing until there's nothing left; or
//   - a round ends on a blocker (error / budget / max-actions) — surfaced
//     with Resume, exactly "run until we hit a blocker"; or
//   - Phase 34: the re-audit re-promotes the IDENTICAL finding set a full fix
//     round already ran against (title fingerprints equal — fixes are not
//     landing). Gated behind audit.stop_on_recurring_findings (default true);
//     false restores today's behavior. This stop lives ONLY in this chain
//     loop — manual `ashmero audit` and single autoRun invocations never see it.
// Nothing is shipped to main — everything stays in workspace/ on develop.
//
// Phase 34: extracted from executeJob with an optional deps seam (mirrors
// verify-loop.js's runAcceptanceCheck pattern) so the stop conditions are
// fixture-testable without spawning subprocesses. Every production caller
// omits `deps` and gets the real collaborators.
//
// @returns {Promise<{summary: string, result: object|null}>} — `result` is the
//   last autoRun result (null when no fix round ran), shaped for executeJob's
//   post-switch dispatch exactly as before the extraction.
export async function runAuditChain({ job, notifier, project, projDir, args, initialAuditResult }, deps = {}) {
  const runGuideFn = deps.runGuide ?? runGuide;
  const autoRunFn = deps.autoRun ?? autoRun;
  const detectNewBugRoundFn = deps.detectNewBugRound ?? detectNewBugRound;
  const recordAuditYieldFn = deps.recordAuditYield ?? recordAuditYield;
  const getBugRoundFn = deps.getBugRound ?? getBugRound;
  const promoteFn = deps.promoteAuditToBugs ?? (await import('../lib/audit-promote.js')).promoteAuditToBugs;

  // v0.14.43: rounds:'inf' = until-clean mode — loop until a clean audit
  // (or a blocker / audit failure) instead of a fixed N. Hard ceiling
  // auto_run.max_chain_rounds (default 25) prevents infinite
  // audit↔fix oscillation on a pathological project.
  const untilClean = args.rounds === 'inf';
  let chainCeiling = 25;
  // Phase 34: fail-safe false on any config-resolution error — the recurring
  // stop reverts to today's behavior (no early stop) when config is unreadable.
  let stopOnRecurring = false;
  try {
    const resolveConfigFn = deps.resolveConfig ?? (await import('../config-resolver.js')).resolve;
    const chainCfg = await resolveConfigFn({ project, task: 'dev-execution' });
    chainCeiling = Math.max(1, Number(chainCfg?.auto_run?.max_chain_rounds) || 25);
    stopOnRecurring = chainCfg?.audit?.stop_on_recurring_findings === true;
  } catch { /* keep defaults */ }
  const maxRounds = untilClean ? chainCeiling : Math.max(1, Math.min(10, Number(args.rounds) || 1));
  const roundsLabel = untilClean ? '∞' : String(maxRounds);
  const { sanitizeForTelegram } = await import('../lib/telegram-fmt.js');
  const { PAUSE_KINDS } = await import('../lib/pause-classifier.js');
  const CLEAN_PAUSE = new Set([PAUSE_KINDS.FIX_ROUND_COMPLETE, PAUSE_KINDS.ALL_PHASES_COMPLETE]);

  let completedRounds = 0;
  let stoppedReason = null; // set when we break early for a non-budget reason
  let result = null;
  // Phase 34: the audit call whose output the NEXT promote extracts — the
  // initial audit for round 1, then each re-audit. Its routing.model and
  // audit_scope ('full'|'incremental'|'full-clean-skip', phases 32/33) are
  // what recordAuditYield persists per promoted round.
  let lastAudit = initialAuditResult || null;

  for (let i = 0; i < maxRounds; i++) {
    // Re-audit before every round after the first (the first audit ran in the caller).
    if (i > 0) {
      await notifySafe(notifier, 'progress', job.id, {
        text: `🔁 Auto pipeline ${i + 1}/${roundsLabel} — re-auditing ${sanitizeForTelegram(project)}…`,
        job,
      });
      const reAudit = await runGuideFn({ projectName: project, task: 'audit' });
      await notifyContextDriftIfAny(reAudit, notifier);
      if (reAudit?.is_error) {
        // v0.14.39: completed rounds are real progress — stop the chain
        // with the actual audit failure instead of throwing it away (the
        // old path mislabeled this as "duplicate audit").
        stoppedReason = `audit failed on round ${i + 1}: ${(reAudit.error_message || reAudit.result || 'guide error').toString().slice(0, 300)}`;
        break;
      }
      lastAudit = reAudit;
    }

    const promo = await promoteFn({ projDir, projectName: project });

    // Phase 34: best-effort yield telemetry, keyed by (project, promo.round).
    // The bug_rounds row for a FRESH promotion doesn't exist yet here (autoRun's
    // startBugRound creates it when the fix round starts), so this first write
    // usually no-ops and only lands on re-promotions of an existing round; the
    // post-autoRun write below is the one that sticks for fresh rounds.
    // recordAuditYield is an UPDATE by (project, round) — never throws past
    // the chain, never inserts.
    const yieldMeta = {
      promoted: Number.isFinite(promo.findings_count) ? promo.findings_count : null,
      clean: promo.clean ? 1 : 0,
      model: lastAudit?.routing?.model ?? null,
      scope: lastAudit?.audit_scope ?? null,
      fingerprint: promo.fingerprint ?? null,
    };
    const recordYield = () => {
      if (promo.round == null) return;
      try { recordAuditYieldFn(project, promo.round, yieldMeta); } catch { /* best-effort telemetry */ }
    };
    recordYield();

    if (!promo.promoted) {
      // Distinguish a sentinel block (same audit re-promoted) from a genuine
      // clean audit. Both stop the chain correctly; the operator needs to tell
      // them apart in the job summary.
      const isDuplicateAudit = promo.reason?.startsWith('Audit already promoted') || promo.reason?.startsWith('Concurrent');
      if (isDuplicateAudit) {
        stoppedReason = `duplicate audit — pipeline stopped: ${promo.reason}`;
      } else {
        // v0.14.42: a clean audit no longer ends the chain past a
        // manually dropped bugs round sitting on disk — the dropped
        // round IS the operator's work order. Drain it via autoRun
        // (bug-plan if needed, then every fix through the gate), then
        // let the loop re-audit if budget remains.
        const pending = await detectNewBugRoundFn(projDir, project);
        if (pending) {
          await notifySafe(notifier, 'progress', job.id, {
            text: `🔍 Audit clean, but pending manual <b>bugs round ${pending.round}</b> detected — running fixes…`,
            job,
          });
          result = await autoRunFn({ projectName: project, unattended: true, dryRun: false, notifier });
          completedRounds += 1;
          const drainedCleanly = result.status === 'completed'
            || (result.status === 'paused' && CLEAN_PAUSE.has(result.pauseKind));
          if (!drainedCleanly) break;
          continue; // re-audit next iteration (budget permitting) to verify the manual fixes
        }
        // Clean audit, nothing pending — the SUCCESS terminal state.
        // v0.14.46: if the most recent fix round completed but hasn't
        // shipped (working branch still ahead of main), say so — the
        // clean-audit message used to go silent about the one thing
        // that actually needs the operator (re-test + ship).
        let qaNote = '';
        try {
          const { getBugRound: getBugRoundState, getProject: getProjectState } = await import('../state.js');
          const { detectHighestBugRound } = await import('../lib/guide-paths.js');
          const hr = (await detectHighestBugRound(projDir)) || 0;
          const lastRound = hr > 0 ? getBugRoundState(project, hr) : null;
          const proj = getProjectState(project);
          const unshipped = !!proj?.git_branch && proj.git_branch !== 'main';
          if (lastRound?.status === 'completed' && unshipped) {
            qaNote = `\n→ bugs round ${hr} is fixed and awaiting your re-test — then <code>/ship ${project}</code>.`;
          }
        } catch { /* note is best-effort */ }
        stoppedReason = (completedRounds === 0
          ? `✅ pipeline complete — audit came back clean, nothing to fix (${promo.reason || 'nothing to promote'})`
          : `✅ pipeline complete — clean after ${completedRounds} fix round(s) (${promo.reason || 'nothing to promote'})`)
          + qaNote;
      }
      break;
    }

    // Phase 43 (P7): per-finding convergence stall — computed inside
    // promoteAuditToBugs itself from parsed Bug-N findings + cross-round
    // finding-history.jsonl (title-Jaccard / shared-file matching), independent
    // of the whole-section fingerprint check below. This round's bugs.md was
    // already written (findings are real) — we just refuse to burn another
    // fix round against an approach that isn't landing. Explicit branch on
    // the flag itself, never a string-match on stoppedReason.
    if (promo.convergence_stall) {
      stoppedReason = formatConvergenceStallReason(promo.recurring, project);
      break;
    }

    // Phase 34: recurring-findings circuit breaker — checked BEFORE starting
    // another fix round. If this promotion's fingerprint equals the PREVIOUS
    // round's stored audit_fingerprint, a full fix round already ran against
    // this exact finding set and the re-audit promoted it again unchanged.
    // Only breaks a loop already bounded by max_chain_rounds; NULL
    // fingerprints (legacy rows, clean audits) can never trigger it.
    if (stopOnRecurring) {
      let prevFingerprint = null;
      try { prevFingerprint = getBugRoundFn(project, promo.round - 1)?.audit_fingerprint ?? null; } catch { /* best-effort */ }
      if (shouldStopForRecurringFindings(prevFingerprint, promo.fingerprint ?? null)) {
        stoppedReason = 'audit findings recurring unchanged across rounds — fixes are not landing; stopping the chain for operator review';
        break;
      }
    }

    await notifySafe(notifier, 'progress', job.id, {
      text: `🔍→🐞 Round ${i + 1}/${roundsLabel}: promoted to <b>bugs round ${promo.round}</b> — ${sanitizeForTelegram(project)}` +
        (promo.warning ? `\n⚠ ${sanitizeForTelegram(promo.warning.slice(0, 300))}` : '') +
        `\nRunning unattended fixes…`,
      job,
    });

    result = await autoRunFn({ projectName: project, unattended: true, dryRun: false, notifier });
    completedRounds += 1;
    // Phase 34: the fix round's autoRun created the bug_rounds row via
    // startBugRound — re-record so the yield lands for fresh rounds too.
    recordYield();

    // Continue the pipeline only if the round finished cleanly. Anything
    // else (failed / cancelled / error- or budget-pause / max-actions) is a
    // blocker: stop and let the post-switch dispatch surface it with Resume.
    const cleanlyDone = result.status === 'completed'
      || (result.status === 'paused' && CLEAN_PAUSE.has(result.pauseKind));
    if (!cleanlyDone) break;
  }

  // Shape the final summary + result so the post-switch dispatch renders the
  // right glyph and next-actions. When we stopped on a clean audit there is
  // no fix run to inherit a status from, so present it as completed.
  let summary;
  if (stoppedReason) {
    summary = `auto pipeline (${completedRounds}/${roundsLabel}) — ${stoppedReason}`;
    if (completedRounds === 0) result = null; // pure audit → "✓ Completed" + Promote
  } else {
    summary = `auto pipeline ×${maxRounds}: ${completedRounds} round(s), last ${result?.status || 'n/a'}`
      + (result?.reason ? ` (${result.reason})` : '');
  }
  return { summary, result };
}

export async function executeJob(job, notifier, deps = {}) {
  // deps is an optional test seam (mirrors runAuditChain's deps pattern above):
  // the unattended-autopilot keystone (scripts/verify-autopilot-e2e.mjs) drives
  // the REAL dispatch end-to-end but injects a fake runGuide so the 'brief' job
  // completes without a live Claude spawn. Production callers omit deps.
  const runGuideFn = deps.runGuide ?? runGuide;
  const autoRunFn = deps.autoRun ?? autoRun;
  // During a worker shutdown drain the job must NOT be terminalized here:
  // leaving the row 'running' lets the worker's recoverJobAfterWorkerShutdown
  // requeue it as a fenced resume. Terminalizing first makes recovery a no-op
  // and a graceful restart drops the job (strictly worse than a crash).
  const isShuttingDown = deps.isShuttingDown ?? (() => false);
  const project = job.project;
  const action = job.action;
  const leaseFence = job.lease_token ? { leaseToken: job.lease_token } : {};
  let args = {};
  try { args = JSON.parse(job.args_json || '{}'); } catch { /* ignore */ }

  // Cancellation is a durable database flag, so it must fence every action —
  // including deterministic actions that never enter claude-runner's polling
  // loop. The completion UPDATE has the same guard for the final race between
  // this check and the terminal write.
  let cancellationNotified = false;
  const stopForRequestedCancellation = async (stage) => {
    const current = getJob(job.id);
    if (!current || (current.status !== 'cancelled' && !current.cancel_requested_at)) return false;
    const reason = current.error_message || 'cancelled by user';
    if (current.status === 'running' && !isShuttingDown()) {
      markJobCancelled(job.id, reason, leaseFence);
    }
    if (!isShuttingDown() && !cancellationNotified) {
      cancellationNotified = true;
      await notifySafe(notifier, 'cancelled', job.id, {
        text: `⏹ Cancelled: job #${job.id} (${stage})`,
        job,
      });
    }
    return true;
  };

  // A cancellation can be requested after claim but before executeJob starts.
  // Never dispatch that row, even when its action is a synchronous local one.
  if (await stopForRequestedCancellation('before dispatch')) return;

  // tryClaimJob already set status='running' + started_at when it claimed
  // the job. No need to re-mark it here.
  await notifySafe(notifier, 'start', job.id, {
    text: `▶ Starting: ${action} ${project} (job #${job.id})`,
    job,
  });

  // Hoisted to outer scope so the post-switch dispatch can branch on it.
  // go/resume/next populate `result` so errors surface the Failed header.
  // For audit/bugs/roadmap/ship it stays null and we land in the completed branch.
  let result = null;
  let summary = '';

  try {
    switch (action) {
      case 'go':
      case 'resume':
      case 'suggestions': {
        result = await autoRunFn({
          projectName: project,
          unattended: args.unattended || false,
          dryRun: false,
          notifier,
        });
        summary = `${result.status}: ${result.reason || ''}`;
        // No inline notify here anymore. The post-switch dispatch below
        // handles failed / paused / completed uniformly.
        break;
      }

      case 'brief-chain': {
        const proj = getProject(project);
        if (!proj) throw new Error(`Project not found: ${project}`);
        const { runDurableBriefChain } = await import('../lib/durable-brief-chain.js');
        result = await (deps.runDurableBriefChain ?? runDurableBriefChain)({ project, notifier });
        summary = `${result.status}: ${result.reason || ''}`;
        break;
      }

      case 'audit': {
        const proj = getProject(project);
        if (!proj) throw new Error(`Project not found: ${project}`);
        // v0.14.39: the audit result was ignored — a failed audit (two-stage
        // scan error, exhausted retries, API error) let the chain proceed to
        // promote against the PREVIOUS audit file, which then stopped on its
        // sentinel as "duplicate audit", hiding the real cause. Fail honestly.
        const initialAudit = await runGuideFn({ projectName: project, task: 'audit' });
        await notifyContextDriftIfAny(initialAudit, notifier);
        if (initialAudit?.is_error) {
          throw new Error(`audit failed: ${(initialAudit.error_message || initialAudit.result || 'guide error').toString().slice(0, 300)}`);
        }

        // v0.14.33: optional audit → bugs → fixes auto-chain, repeatable N rounds.
        // Triggered by --auto/--chain on /run (args.chain), the "Auto ×N" Telegram
        // buttons (args.chain + args.rounds), or the config default
        // auto_run.chain_audit_to_bugs. Without any of these, behaviour is EXACTLY
        // as before: the audit completes and the post-switch dispatch shows the
        // manual "Promote" next-action.
        //
        // Phase 34: the chain loop itself lives in runAuditChain() above —
        // see its header comment for the round/stop semantics.
        const wantsChain = args.chain || args.auto || (await chainAuditEnabled(project));
        if (!wantsChain) {
          summary = 'audit complete — see .guide/audits/';
          break;
        }

        const projDir = path.join(PROJECTS_DIR, project);
        const chain = await runAuditChain({
          job, notifier, project, projDir, args, initialAuditResult: initialAudit,
        }, deps);
        summary = chain.summary;
        result = chain.result;
        break;
      }

      case 'bugs': {
        const wantsAuto = args.auto || args.chain;
        if (!wantsAuto) {
          // Plan only — user will run `go` manually to execute fixes.
          const r = await startBugCycle({ projectName: project });
          summary = `bug round ${r.round}: ${r.fixCount} fixes planned`;
          break;
        }

        // Auto mode: plan + execute each pending bug round in order (lowest first),
        // chaining rounds until no more pending bugs.md files exist or a blocker hit.
        const { sanitizeForTelegram: _sf } = await import('../lib/telegram-fmt.js');
        const { PAUSE_KINDS: PK } = await import('../lib/pause-classifier.js');
        const CLEAN_PAUSE = new Set([PK.FIX_ROUND_COMPLETE, PK.ALL_PHASES_COMPLETE]);
        const maxRounds = Math.max(1, Math.min(20, Number(args.rounds) || 20));

        let completedRounds = 0;
        let stoppedReason = null;

        for (let i = 0; i < maxRounds; i++) {
          let r;
          try {
            r = await startBugCycle({ projectName: project });
          } catch (err) {
            stoppedReason = completedRounds === 0
              ? `no bug rounds found: ${err.message}`
              : `no more pending rounds after ${completedRounds} completed`;
            break;
          }

          await notifySafe(notifier, 'progress', job.id, {
            text: `🐞 Bug round ${r.round}: ${r.fixCount} fix(es) planned — running fixes unattended…`,
            job,
          });

          result = await autoRunFn({ projectName: project, unattended: true, dryRun: false, notifier });
          completedRounds += 1;

          const cleanlyDone = result.status === 'completed'
            || (result.status === 'paused' && CLEAN_PAUSE.has(result.pauseKind));
          if (!cleanlyDone) break;
        }

        if (stoppedReason) {
          summary = `bugs auto (${completedRounds} round(s) done) — ${stoppedReason}`;
          if (completedRounds === 0) result = null;
        } else {
          summary = `bugs auto ×${completedRounds}: ${result?.status || 'n/a'}` +
            (result?.reason ? ` (${result.reason})` : '');
        }
        break;
      }

      case 'pipeline': {
        // v0.14.33: full lifecycle autopilot. Chains intake → brief → build →
        // drain bug inbox → audit→fix loop (×rounds) → QA handoff, then STOPS at
        // the ship gate (never ships, never spins off new projects). Stops on the
        // first blocker. The driver is a thin sequencer in src/pipeline.js over
        // already-tested primitives (autoRun, runGuide, promote*, qa-handoff).
        const { runPipeline } = await import('../pipeline.js');
        const pipe = await runPipeline({
          projectName: project,
          projectsDir: PROJECTS_DIR,
          rounds: args.rounds,
          stopAfter: args.stopAfter || 'qa',
          autoBrief: args.autoBrief === true,
          notifier,
          job,
        });
        // Inherit the last build/fix result so the post-switch dispatch renders the
        // right glyph + next-actions: a blocker (lastResult non-clean) shows
        // Resume/Bump; a clean finish (ship-gate) falls through to "✓ Completed".
        result = pipe.lastResult && !['ship-gate'].includes(pipe.stoppedAt) ? pipe.lastResult : null;
        summary = `pipeline → ${pipe.stoppedAt}: ${pipe.reason}`
          + (pipe.ranStages.length ? ` [${pipe.ranStages.join(' → ')}]` : '');
        break;
      }

      case 'roadmap': {
        const gRes = await runGuideFn({ projectName: project, task: 'roadmap' });
        await notifyContextDriftIfAny(gRes, notifier);
        if (gRes?.is_error) throw new Error(`roadmap failed: ${(gRes.error_message || gRes.result || 'guide error').toString().slice(0, 300)}`);
        summary = 'roadmap complete — see .guide/roadmaps/';
        break;
      }

      case 'retro': {
        const { runRetrospective, DEFAULT_WINDOW_DAYS } = await import('../commands/retro.js');
        const days = Number.isFinite(Number(args.days)) ? Number(args.days) : DEFAULT_WINDOW_DAYS;
        const retro = await runRetrospective({ projectName: project, days });
        summary = retro.skippedGuideCall
          ? `retrospective complete — no activity in the trailing ${retro.aggregate.window_days} day(s)`
          : `retrospective complete — ${path.relative(REPO_ROOT, retro.reportPath)}`;
        break;
      }

      // v0.14.16: cases below were documented in TELEGRAM_BOT.md as
      // valid /run actions but the dispatcher didn't handle them. Surfaced
      // when v0.14.11's /req_promote --plan queued brief + guide jobs and
      // both failed with "Unknown action".

      case 'brief': {
        const proj = getProject(project);
        if (!proj) throw new Error(`Project not found: ${project}`);
        // Mirrors `npm run brief -- <project>` — drafts .guide/brief.md
        // and .guide/brief-questions.md from raw-thoughts.md.
        const gRes = await runGuideFn({ projectName: project, task: 'brief-author' });
        await notifyContextDriftIfAny(gRes, notifier);
        if (gRes?.is_error) throw new Error(`brief-author failed: ${(gRes.error_message || gRes.result || 'guide error').toString().slice(0, 300)}`);
        summary = 'brief drafted — see .guide/brief.md and .guide/brief-questions.md';
        break;
      }

      case 'next-brief': {
        const proj = getProject(project);
        if (!proj) throw new Error(`Project not found: ${project}`);

        // Durable two-step web action: generate the next brief, then start the
        // build. Persist the boundary so a worker crash after brief generation
        // resumes the build without paying for the brief-author call twice.
        const checkpoint = parseProjectMetadata(proj.metadata_json)?.next_brief_chain;
        if (checkpoint?.state !== 'generated') {
          setProjectMetadataField(project, 'next_brief_chain', {
            state: 'generating', updated_at: new Date().toISOString(), job_id: job.id,
          });
          const gRes = await runGuideFn({ projectName: project, task: 'brief-author' });
          await notifyContextDriftIfAny(gRes, notifier);
          if (gRes?.is_error) {
            throw new Error(`brief-author failed: ${(gRes.error_message || gRes.result || 'guide error').toString().slice(0, 300)}`);
          }
          setProjectMetadataField(project, 'next_brief_chain', {
            state: 'generated', updated_at: new Date().toISOString(), job_id: job.id,
          });
        }

        result = await autoRunFn({
          projectName: project,
          unattended: true,
          dryRun: false,
          notifier,
        });
        setProjectMetadataField(project, 'next_brief_chain', {
          state: 'completed', updated_at: new Date().toISOString(), job_id: job.id,
          run_status: result?.status || null,
        });
        summary = `${result.status}: ${result.reason || 'next brief generated and build started'}`;
        break;
      }

      case 'guide': {
        const proj = getProject(project);
        if (!proj) throw new Error(`Project not found: ${project}`);
        // Default task is 'plan' — produces .guide/plan.json from brief.md.
        // Queue-safe guide tasks (plan, next-prompt, review, handoff,
        // workspace-claude-md) can now be requested via
        // `/run <project> guide --task <type>`; handleQueue validates the task
        // against src/lib/guide-tasks.js before enqueueing it as args.task.
        // Tasks needing extra context (bug-plan, fix-prompt, requirement-refine)
        // remain CLI-only — handleQueue rejects them with a pointer to the CLI.
        const task = (args && args.task) || 'plan';
        const gRes = await runGuideFn({ projectName: project, task });
        await notifyContextDriftIfAny(gRes, notifier);
        if (gRes?.is_error) throw new Error(`${task} failed: ${(gRes.error_message || gRes.result || 'guide error').toString().slice(0, 300)}`);
        const isPlanTask = task === 'plan' || task === 'plan-creation';
        if (isPlanTask) {
          try {
            const { planJsonPath, archiveSupersededPhases } = await import('../lib/guide-paths.js');
            const projDir = path.join(PROJECTS_DIR, project);
            const planRaw = await fs.readFile(planJsonPath(projDir), 'utf-8');
            const plan = JSON.parse(planRaw);
            const n = plan?.phases?.length || 0;
            const maxN = n > 0 ? plan.phases[n - 1].n : 0;
            // Reset current_phase to 0 so the runner starts from phase 1 of the
            // new plan instead of inheriting stale state from a prior plan.
            resetProjectForNewPlan(project, maxN);
            // Archive phase folders from superseded plans so findPhaseDir
            // never picks them up as prompts for new-plan phases.
            await archiveSupersededPhases(projDir, plan);
          } catch { /* plan not written yet or malformed — non-fatal */ }

          // Auto-start dev execution — a guide:plan job that succeeds should
          // immediately kick off the run, matching the go-loop behaviour.
          // enqueueUnique is a no-op if a resume job is already pending/running.
          const { scheduled, jobId } = enqueueUniqueResumeJob({ project, requestedBy: 'plan-complete-auto' });
          if (scheduled) {
            notifier?.notify?.({ text: `▶ Plan complete — auto-queued resume job #${jobId}` });
          }
        }
        summary = `guide ${task} complete`;
        break;
      }

      case 'next': {
        // Mirrors `npm run next -- <project>` — runs the next dev phase.
        // Note: heavy. Prefer 'go' for chained phases; 'next' is single-phase.
        const { runDev } = await import('../lib/phase-runner.js');
        const r = await runDev({ projectName: project });
        await notifyContextDriftIfAny(r, notifier);
        summary = r.is_error
          ? `phase reported errors: ${String(r.result || '').slice(0, 200)}`
          : `phase complete (session: ${r.session_id})`;
        result = { status: r.is_error ? 'failed' : 'completed', reason: r.is_error ? String(r.result || '').slice(0, 200) : null };
        break;
      }

      case 'review': {
        const gRes = await runGuideFn({ projectName: project, task: 'review' });
        await notifyContextDriftIfAny(gRes, notifier);
        if (gRes?.is_error) throw new Error(`review failed: ${(gRes.error_message || gRes.result || 'guide error').toString().slice(0, 300)}`);
        summary = 'review complete — see .guide/reviews/';
        break;
      }

      case 'handoff': {
        const { setGuideSessionId } = await import('../state.js');
        const gRes = await runGuideFn({ projectName: project, task: 'handoff' });
        await notifyContextDriftIfAny(gRes, notifier);
        if (gRes?.is_error) throw new Error(`handoff failed: ${(gRes.error_message || gRes.result || 'guide error').toString().slice(0, 300)}`);
        setGuideSessionId(project, null);
        summary = 'handoff complete; guide session reset';
        break;
      }

      case 'qa': {
        // Status flip only — no Claude call. Matches `npm run qa -- <project>`
        // (without --shipped). Use /ship to flip to completed.
        setProjectStatus(project, 'ready-for-qa');
        summary = `${project} marked ready-for-qa`;
        break;
      }

      case 'qa-handoff': {
        const { generateQaHandoff } = await import('../commands/qa-handoff.js');
        const projDir = path.join(PROJECTS_DIR, project);
        const handoff = await generateQaHandoff(project, {
          round: args.round == null ? null : Number(args.round),
          phaseStart: args.phaseStart == null ? null : Number(args.phaseStart),
          phaseEnd: args.phaseEnd == null ? null : Number(args.phaseEnd),
          withSteps: args.withSteps === true,
        });
        summary = `QA handoff generated: ${path.relative(projDir, handoff.outputPath)} (${handoff.bugs} item(s), ${handoff.fixes} fix(es))`;
        break;
      }

      case 'package': {
        const packageProjectFn = deps.packageProject
          ?? (await import('../commands/package-project.js')).packageProject;
        const packaged = await packageProjectFn({
          projectName: project,
          // Release jobs exclude Git metadata unless the durable arguments
          // explicitly opt in; never inherit packageProject's CLI default.
          includeGit: args.includeGit === true,
          quiet: true,
        });
        summary = `Release package created: ${packaged.filename} (${packaged.sizeBytes} bytes)`;
        break;
      }

      case 'validate': {
        const { runValidators } = await import('../lib/validators.js');
        const outcome = await runValidators({ projectName: project, event: args.event || {} });
        if (outcome.hasFailures) {
          const failed = (outcome.results || []).filter((r) => r.status === 'fail').map((r) => r.name).filter(Boolean);
          throw new Error(`validators failed${failed.length ? `: ${failed.join(', ')}` : ''}`);
        }
        summary = outcome.skipped
          ? `validators skipped: ${outcome.skipped}`
          : `validators passed (${(outcome.results || []).length} check(s))`;
        break;
      }

      case 'reset-brief': {
        // Mirrors `ashmero reset-brief <project>` — refresh .guide/brief.md from
        // inputs/, archive the stale plan, rewind current_phase to 0. resetBrief
        // throws on guard failure (missing/empty/unresolved brief, in-progress),
        // which the outer try/catch turns into markJobFailed — never kills the
        // server. We never pass go:true here; the operator runs `/run <p> go`
        // next so the reset and the (heavy) pipeline are separate, cancellable jobs.
        const { resetBrief } = await import('../commands/reset-brief.js');
        const r = await resetBrief(project, { go: false, noArchive: false });
        summary = `reset-brief: .guide/brief.md refreshed from inputs/, current_phase reset to 0`
          + (r.archived.length ? ` (archived ${r.archived.length} file(s))` : '');
        break;
      }

      case 'retry-phase': {
        const phaseN = Number(args.phase);
        if (!Number.isInteger(phaseN) || phaseN < 1) {
          throw new Error('retry-phase requires args.phase as a positive integer');
        }
        const { retryPhase } = await import('../commands/retry-phase.js');
        await retryPhase({
          projectName: project,
          phaseN,
          force: true,
          keepPromptReport: args.keepPromptReport === true,
        });
        summary = `phase ${phaseN} reset to pending; resume to re-run it`;
        break;
      }

      case 'sync': {
        const proj = getProject(project);
        if (!proj) throw new Error(`Project not found: ${project}`);
        if (!proj.git_branch) throw new Error(`Project '${project}' is not under git management`);
        const { syncWithRemote } = await import('../lib/git.js');
        const syncResult = await syncWithRemote(path.join(PROJECTS_DIR, project, 'workspace'), {
          branch: proj.git_branch,
        });
        if (!syncResult.ok) {
          throw new Error(`sync failed (${syncResult.action}): ${syncResult.error}`);
        }
        summary = syncResult.action === 'pulled'
          ? `pulled ${syncResult.behind} commit(s) from origin/${proj.git_branch}`
          : syncResult.action === 'ahead-only'
            ? `${syncResult.ahead} unpushed commit(s) on ${proj.git_branch}`
            : `sync ${syncResult.action}`;
        break;
      }

      case 'ship': {
        const { shipProject } = await import('../commands/ship.js');
        const shipResult = await shipProject({ projectName: project, target: args.target || 'main', tag: args.tag || null });
        if (!shipResult.ok) throw new Error(shipResult.error);
        if (shipResult.noop) {
          summary = `${project}: ${shipResult.source} already at ${shipResult.target} — nothing to ship`;
        } else {
          setProjectStatus(project, 'completed');
          summary = `${project}: shipped ${shipResult.source} → ${shipResult.target} (${shipResult.fromSha?.slice(0, 8)} → ${shipResult.toSha?.slice(0, 8)})${shipResult.tag ? `, tagged ${shipResult.tag}` : ''}`;
        }
        break;
      }

      case 'discuss': {
        const { runDiscussion, resumeDiscussion, formatConclusionSummary } = await import('../lib/discussion-engine.js');
        let discId, conclusion;
        const autoStart = args.autoStart !== false; // default true
        if (args.resumeId) {
          ({ discId, conclusion } = await resumeDiscussion({ discId: args.resumeId, notifier, autoStart }));
        } else {
          const topic = args.topic;
          const mode = args.mode || 'auto';
          if (!topic) throw new Error('discuss action requires args.topic');
          ({ discId, conclusion } = await runDiscussion({ projectName: project, topic, mode, notifier, autoStart }));
        }
        const recs = (conclusion.top_recommendations || []).slice(0, 3);
        const recLines = recs.map((r) => `${r.rank}. ${r.title} (cost:${r.cost}, effort:${r.effort})`).join('\n');
        summary = `[discuss #${discId}] Done — ${recs.length} recommendations\n${recLines}`;
        break;
      }

      case 'eval': {
        // Phase 84 (P6): prompt-eval harness. Classed HEAVY in JOB_COST_CLASS:
        // its isolated child invokes provider-backed judge calls. Run as
        // a FRESH child `node` process (like scripts/verify-*.mjs) — NOT in-process
        // and NOT via claude-runner.js (whose mandate is claude CLI spawns): the
        // harness sets process.env.DB_PATH to a throwaway temp DB for isolation,
        // which an in-process run cannot do (the server already bound the state
        // singleton to the production DB, so fixture projects/calls would leak into
        // production). A child process gets a clean module registry + its own DB.
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const runNode = promisify(execFile);
        const scriptPath = path.join(REPO_ROOT, 'scripts', 'eval-prompts.mjs');
        const evalArgs = [scriptPath];
        if (args.task) evalArgs.push('--task', String(args.task));
        if (args.updateBaseline) evalArgs.push('--update-baseline');
        try {
          const { stdout } = await runNode('node', evalArgs, {
            cwd: REPO_ROOT, timeout: 20 * 60 * 1000, maxBuffer: 8 * 1024 * 1024,
          });
          const tail = stdout.trim().split('\n').slice(-2).join(' ');
          summary = `eval passed — ${tail.slice(0, 300)}`;
        } catch (e) {
          const out = `${e.stdout || ''}\n${e.stderr || ''}`.trim();
          const tail = out.split('\n').slice(-3).join(' ');
          // Exit 3 = billing-guard refusal (window warn/pause). Not a failure —
          // the eval simply deferred; complete the job with a note.
          if (e.code === 3) { summary = `eval deferred — ${tail.slice(0, 300)}`; break; }
          throw new Error(`eval regression (exit ${e.code ?? '?'}): ${tail.slice(0, 300)}`);
        }
        break;
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }

    // Deterministic/local actions do not have a subprocess cancellation poll.
    // Re-read the durable flag after dispatch so they cannot be reported as
    // completed when cancellation arrived while their handler was running.
    if (await stopForRequestedCancellation('after dispatch')) return;

    // A provider-paused chain leaves an ordinary durable resume in front of
    // it. Once that resume completes the current brief, enqueue the chain
    // driver again so it archives that brief and advances to the next queue
    // item without an operator click. The project metadata checkpoint is the
    // durable chain intent; the unique enqueue makes repeated completion
    // surfaces harmless.
    const resumedProject = action === 'resume' ? getProject(project) : null;
    const resumeFinishedBrief = result?.status === 'completed'
      || ['ready-for-qa', 'completed'].includes(resumedProject?.status)
      || ['all-phases-complete', 'fix-round-complete'].includes(result?.pauseKind);
    if (action === 'resume' && resumeFinishedBrief) {
      const chain = parseProjectMetadata(resumedProject?.metadata_json)?.brief_chain;
      if (chain?.active === true) {
        const queued = enqueueUniqueActionJob({
          project, action: 'brief-chain', args: { unattended: true }, requestedBy: job.requested_by,
        });
        console.log(`[brief-chain] resume completed; ${queued.scheduled ? `queued continuation job #${queued.jobId}` : `continuation already job #${queued.jobId}`}`);
      }
    }

    // ─── Post-switch dispatch (BUG-6 fix) ──────────────────────────────
    // For go/resume, autoRun returns {status, reason} rather than throwing.
    // Map that onto the right combination of (DB row state, header glyph,
    // next-actions key). For non-auto-run actions, result is null and we
    // land in the completed branch.
    const nextActionsKey =
      result?.status === 'failed' ? 'auto-run-failed' :
      result?.status === 'cancelled' ? 'auto-run-cancelled' :
      result?.status === 'paused' ? 'auto-run-paused' :
      action;

    const proj = getProject(project);
    const baseState = {
      currentPhase: proj?.current_phase,
      totalPhases: proj?.total_phases,
      pauseReason: result?.reason || null,
      pauseKind: result?.pauseKind ?? null,
    };

    let replyMarkup = null;
    try {
      const { getNextActions, renderNextActionsDiscord, renderNextActionsTelegram } = await import('../lib/next-actions.js');
      const actions = getNextActions({ project, lastAction: nextActionsKey, state: baseState });
      const renderer = notifier?.platform === 'telegram' ? renderNextActionsTelegram : renderNextActionsDiscord;
      const rendered = await renderer(actions, {
        compact: true,
        contextId: `${project}|${nextActionsKey}`,
      });
      replyMarkup = rendered.keyboard;
    } catch { /* notify without buttons if rendering fails */ }

    // v0.14.26: sanitize the auto-runner's reason text before it lands in a
    // Telegram HTML message. The reason can contain filenames like
    // "bugs-round-1.md" that Telegram would otherwise turn into clickable
    // URLs (Moldova's .md ccTLD). sanitizeForTelegram escapes HTML AND
    // wraps recognised filenames in <code>. Loaded lazily so the CLI path
    // (no Telegram) doesn't pay the import cost.
    const { sanitizeForTelegram } = await import('../lib/telegram-fmt.js');

    if (result?.status === 'failed') {
      if (!markJobFailed(job.id, summary, leaseFence)) {
        await stopForRequestedCancellation('before failure finalization');
        return;
      }
      const retried = await maybeScheduleTransientRetry({ job, action, project, reasonText: result.reason || summary || '', notifier });
      await notifySafe(notifier, 'failure', job.id, {
        text: `✗ Failed: ${action} ${project}\n${sanitizeForTelegram((result.reason || '').slice(0, 500))}` +
              (retried ? '' : '\n\n<b>What next:</b>'),
        job,
        replyMarkup: retried ? undefined : replyMarkup,
      });
    } else if (result?.status === 'paused' && isTransientError(result.reason || '')) {
      // v0.14.44: a pause caused by external weather is not an operator
      // decision point when a durable successor exists. Schedule FIRST; never
      // call the only continuation completed if config/cap/DB failure prevented
      // the retry from being persisted.
      const retried = await maybeScheduleTransientRetry({ job, action, project, reasonText: result.reason || '', notifier });
      if (retried) {
        if (!markJobCompleted(job.id, summary, leaseFence)) {
          await stopForRequestedCancellation('before retry finalization');
          return;
        }
      } else {
        if (!markJobFailed(job.id, `${summary}; transient pause had no durable retry`, leaseFence)) {
          await stopForRequestedCancellation('before pause finalization');
          return;
        }
        await notifySafe(notifier, 'paused-without-retry', job.id, {
          text: `⏸ Paused without an automatic retry: ${action} ${project}\n${sanitizeForTelegram((result.reason || '').slice(0, 500))}\n\n<b>What next:</b>`,
          job,
          replyMarkup,
        });
      }
    } else if (result?.status === 'paused') {
      // Paused auto-runs land in tg_jobs.status='completed' with summary
      // starting `paused:`. The information isn't lost and we don't need
      // a new enum value on tg_jobs.status — see CHANGELOG and the
      // Phase 2 spec's "Task D" rationale.
      if (!markJobCompleted(job.id, summary, leaseFence)) {
        await stopForRequestedCancellation('before pause finalization');
        return;
      }
      await notifySafe(notifier, 'paused', job.id, {
        text: `⏸ Paused: ${action} ${project}\n${sanitizeForTelegram((result.reason || '').slice(0, 500))}\n\n<b>What next:</b>`,
        job,
        replyMarkup,
      });
    } else if (result?.status === 'cancelled') {
      if (isShuttingDown()) {
        // Shutdown drain, not an operator cancel: leave the row 'running' so
        // the worker's shutdown recovery can requeue it as a fenced resume.
        console.log(`[job-runner] job #${job.id} cancelled by shutdown drain — leaving row for recovery requeue`);
      } else {
        markJobCancelled(job.id, summary, leaseFence);
        await notifySafe(notifier, 'cancelled', job.id, {
          text: `⏹ Cancelled: ${action} ${project}\n${sanitizeForTelegram((result.reason || '').slice(0, 500))}\n\n<b>What next:</b>`,
          job,
          replyMarkup,
        });
      }
    } else {
      if (!markJobCompleted(job.id, summary, leaseFence)) {
        await stopForRequestedCancellation('before completion finalization');
        return;
      }
      await notifySafe(notifier, 'completion', job.id, {
        text: `✓ Completed: ${action} ${project}\n${sanitizeForTelegram(summary || '')}\n\n<b>What next:</b>`,
        job,
        replyMarkup,
      });
    }
  } catch (err) {
    // This catch handles synchronous throws from runGuide / startBugCycle /
    // setProjectStatus, or the rare case where autoRun itself throws rather
    // than returning {status: 'failed'}. The auto-runner.js:125-127 catch
    // converts most errors into a returned {status: 'failed'} — but if
    // anything escapes (e.g. an import failure, a syntax error in a
    // dynamically loaded module), we want belt-and-braces here. The
    // worker-catch sweep in server.js is a third layer for anything that
    // escapes this one too.
    const msg = err.message || String(err);

    // Cancellation path: if the user cancelled this job, killCurrent SIGTERM'd
    // its subprocess, which surfaces here as a throw. The /cancel handler has
    // already marked the row 'cancelled' and replied "⊘ Cancelled" — so we must
    // NOT send a scary "✗ Failed" notification or re-throw into the worker sweep.
    // Detect via the DB row (handler set it) or the spawnClaude reject signature.
    const cur = getJob(job.id);
    const isCancellation = (cur && (cur.status === 'cancelled' || cur.cancel_requested_at))
      || /cancelled.*(?:signal|before spawn|by user|while waiting)/i.test(msg);
    if (isCancellation) {
      // Shutdown drain: leave the row 'running' so the worker's shutdown
      // recovery requeues it as a fenced resume. Genuine /cancel: the handler
      // already marked the row; if not (raced), terminalize it here.
      if (cur && cur.status === 'running' && !isShuttingDown()) {
        markJobCancelled(job.id, 'cancelled', leaseFence);
      }
      return; // already-notified — swallow, no failure notify, no re-throw
    }

    if (!markJobFailed(job.id, msg, leaseFence)) {
      await stopForRequestedCancellation('before error finalization');
      return;
    }
    const retried = await maybeScheduleTransientRetry({
      job, action, project, reasonText: msg, notifier,
    });
    let replyMarkup = null;
    try {
      const { getNextActions, renderNextActionsDiscord, renderNextActionsTelegram } = await import('../lib/next-actions.js');
      const proj = getProject(project);
      const state = {
        currentPhase: proj?.current_phase,
        totalPhases: proj?.total_phases,
        pauseReason: msg,
      };
      const actions = getNextActions({ project, lastAction: 'auto-run-failed', state });
      const renderer = notifier?.platform === 'telegram' ? renderNextActionsTelegram : renderNextActionsDiscord;
      const rendered = await renderer(actions, { compact: true, contextId: `${project}|failed` });
      replyMarkup = rendered.keyboard;
    } catch { /* ignore */ }
    await notifySafe(notifier, 'failure', job.id, {
      text: `✗ Failed: ${action} ${project}\n${(await import('../lib/telegram-fmt.js')).sanitizeForTelegram(msg.slice(0, 500))}`
        + (retried ? '' : '\n\n<b>What next:</b>'),
      job,
      replyMarkup: retried ? undefined : replyMarkup,
    });
    throw err;
  }
}
