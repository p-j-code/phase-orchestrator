// Project Watchdog — periodically scans for projects paused by recoverable
// blockers and auto-resumes them through the durable SQLite queue.
//
// Design rules:
//   - Only resumes projects paused due to a *recoverable* error kind
//     (network, git-dirty, phase-stuck, dependency).  git-diverged and
//     orchestrator-bug are NOT auto-resumed — they need a heal pass first.
//   - Skips projects that already have a running auto-run (no double-spawn).
//   - Rate-limits to `maxResumesPerWindow` per project per `windowMinutes`
//     to prevent infinite resume loops on permanently broken projects.
//   - Records every resume attempt in `healing_log` with kind='watchdog-resume'
//     so the web UI and `getRecentHealingAttempts` can enforce the limit.
//
// Usage:
//   import { startWatchdog, stopWatchdog } from './lib/project-watchdog.js';
//   const stop = startWatchdog({ intervalMs: 60_000, cfg, notifier });
//   // on shutdown:
//   stop();

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { classifyError } from './error-classifier.js';
import { isTransientError, getRateLimitRetryAt } from './unattended-retry.js';
import { isProviderRateLimitError } from './transient-errors.js';
import {
  getDb, listProjects, getLastAutoRun,
  recordHealingAttempt, getRecentHealingAttempts,
} from '../state.js';
import { AutoHealer } from './auto-healer.js';
import { enqueueUniqueResumeJob } from '../server/job-queue.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// These kinds are safe to resume without a pre-heal step.
// The auto-runner's inner healing will fix the root cause on the next run.
const RESUME_WITHOUT_HEAL = new Set(['network', 'git-dirty', 'phase-stuck', 'dependency']);

// git-diverged needs a workspace heal pass before resuming.
const HEAL_THEN_RESUME = new Set(['git-diverged']);

/**
 * Provider errors normally carry `resetsAt`. When they do not, use the paused
 * run's timestamp plus the normal transient cooldown; otherwise a watchdog
 * tick would immediately relaunch the same known-rate-limited work.
 */
export function rateLimitResumeAt(lastRun, fallbackMinutes = 60) {
  const pausedAt = Date.parse(lastRun?.ended_at || lastRun?.started_at || '');
  return getRateLimitRetryAt(lastRun?.pause_reason, {
    retryWaitMinutes: fallbackMinutes,
    nowMs: Number.isFinite(pausedAt) ? pausedAt : Date.now(),
  });
}

/**
 * Decide how the watchdog treats a paused run's error, from its classification.
 *   - providerLimit: a quota pause — resume only after its (reset) cooldown.
 *   - network: a transient blip that is NOT a quota — resume after a SHORT delay
 *     rather than idling the full rate-limit cooldown.
 *   - otherwise a recoverable kind in the resume sets falls through to resume.
 * `skip` is true when none of those apply (nothing safe to resume this tick).
 */
export function classifyWatchdogResume({ recoverable, kind, pauseReason }) {
  const providerLimit = !recoverable && isProviderRateLimitError(pauseReason);
  const network = !recoverable && !providerLimit && isTransientError(pauseReason);
  const resumableKind = recoverable && (RESUME_WITHOUT_HEAL.has(kind) || HEAL_THEN_RESUME.has(kind));
  return { skip: !providerLimit && !network && !resumableKind, providerLimit, network };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isProjectRunning(projectName) {
  return !!getDb()
    .prepare(`SELECT id FROM auto_runs WHERE project = ? AND status = 'running' LIMIT 1`)
    .get(projectName);
}

// ─── Single watchdog tick ─────────────────────────────────────────────────────

/**
 * Scan all projects for recoverable pauses and resume them.
 * @returns {Array<{project, kind, jobId}>} list of projects queued this tick
 */
export async function watchdogTick({ cfg = null, notifier = null } = {}) {
  if (cfg?.auto_heal?.enabled === false) return [];

  const maxResumesPerWindow = cfg?.auto_heal?.watchdog_max_resumes ?? 3;
  const windowMinutes       = 60;
  const fallbackMinutes     = Math.max(1, Number(cfg?.auto_run?.transient_retry_minutes) || 60);
  // A pure network blip must not wait out the full provider rate-limit cooldown.
  const networkFallbackMinutes = Math.max(1, Number(cfg?.auto_heal?.network_retry_minutes) || 2);
  const resumed             = [];

  for (const project of listProjects()) {
    // Only care about projects that are in-progress or paused
    if (!['in-progress', 'paused'].includes(project.status)) continue;

    // 'failed' runs (real terminal status since endAutoRunTerminal) are still
    // watchdog-eligible: classifyWatchdogResume only resumes transient /
    // provider-limit reasons, so hard failures keep skipping below.
    const lastRun = getLastAutoRun(project.name);
    if (!lastRun || !['paused', 'failed'].includes(lastRun.status)) continue;
    if (isProjectRunning(project.name)) continue; // already running

    // reprompt-exhausted is a terminal operator pause: the phase burned its
    // cross-run reprompt budget and still fails identically — resuming just
    // replays the loop. The kind is authoritative over the reason text (which
    // embeds the raw phase-stuck error and would classify resumable).
    if (lastRun.pause_kind === 'reprompt-exhausted') continue;

    // One project's failure must not starve the rest of the tick.
    try {
    const pauseReason = lastRun.pause_reason || '';
    const fakeErr     = new Error(pauseReason);
    const { kind, recoverable } = classifyError(fakeErr);

    // Special case: API 5-hour / rate-limit budget pauses are transient — auto-resume
    // once the window has reset. The error-classifier marks BUDGET as non-recoverable
    // (to block the self-heal agent from retrying indefinitely), but the watchdog
    // CAN safely resume here because we verify the reset timestamp first.
    // A provider quota pause waits for its (possibly advertised) reset. A pure
    // NETWORK blip is transient too, but a second call can succeed immediately —
    // it must resume after a SHORT delay, not idle out the full rate-limit
    // cooldown. Both are marked non-recoverable so the self-healer can't loop on
    // them; the watchdog resumes them itself on the right cadence.
    const { skip, providerLimit: isProviderLimit, network: isNetwork } = classifyWatchdogResume({ recoverable, kind, pauseReason });
    if (skip) continue;
    if (isProviderLimit) {
      const retryAtMs = rateLimitResumeAt(lastRun, fallbackMinutes);
      const remainingMs = retryAtMs - Date.now();
      if (remainingMs > 0) {
        const minLeft = Math.ceil(remainingMs / 60000);
        console.log(chalk.dim(`  ⏳ watchdog: ${project.name} rate-limit, ${minLeft}min until reset`));
        continue; // window not yet reset — check again next tick
      }
      // Window/cooldown has elapsed — fall through to spawn resume.
    } else if (isNetwork) {
      const pausedAtMs = Date.parse(lastRun?.ended_at || lastRun?.started_at || '');
      const resumeAtMs = (Number.isFinite(pausedAtMs) ? pausedAtMs : Date.now()) + networkFallbackMinutes * 60000;
      const remainingMs = resumeAtMs - Date.now();
      if (remainingMs > 0) {
        console.log(chalk.dim(`  ⏳ watchdog: ${project.name} network blip, ${Math.ceil(remainingMs / 60000)}min short cooldown`));
        continue; // brief network cooldown not yet elapsed
      }
      // Short network cooldown elapsed — fall through to spawn resume.
    } else if (!RESUME_WITHOUT_HEAL.has(kind) && !HEAL_THEN_RESUME.has(kind)) {
      continue;
    }

    // Rate-limit: don't resume more than maxResumesPerWindow times per hour
    const recent = getRecentHealingAttempts(project.name, 'watchdog-resume', windowMinutes);
    if (recent.length >= maxResumesPerWindow) {
      console.log(chalk.yellow(
        `  ⚠  watchdog: ${project.name} skipped — ${recent.length} resume(s) already attempted this hour`,
      ));
      continue;
    }

    // For git-diverged: attempt workspace heal before queueing resume
    if (HEAL_THEN_RESUME.has(kind)) {
      const { resolve: resolveConfig } = await import('../config-resolver.js');
      const projCfg = await resolveConfig({ project: project.name, task: 'dev-execution' }).catch(() => null);
      const workspaceDir = projCfg
        ? path.join(REPO_ROOT, 'projects', project.name, projCfg.paths?.workspace_subdir || 'workspace')
        : path.join(REPO_ROOT, 'projects', project.name, 'workspace');

      const healer = new AutoHealer({ projectName: project.name, workspaceDir, cfg: projCfg, notifier });
      const heal   = await healer.heal(fakeErr, { projectName: project.name, workspaceDir, branch: project.git_branch })
        .catch(() => ({ healed: false, reason: 'heal threw' }));

      if (!heal.healed) {
        console.log(chalk.yellow(`  ⚠  watchdog: ${project.name} — pre-heal failed (${heal.reason}), skipping resume`));
        continue;
      }
      console.log(chalk.green(`  ✓  watchdog: healed ${project.name} (${heal.reason})`));
    }

    const queued = enqueueUniqueResumeJob({
      project: project.name,
      args: { unattended: !!lastRun.unattended },
      requestedBy: null,
    });
    if (!queued.scheduled) {
      console.log(chalk.dim(`  ⏳ watchdog: ${project.name} already has resume job #${queued.jobId}`));
      continue;
    }

    recordHealingAttempt({
      project: project.name,
      error_kind: 'watchdog-resume',
      error_message: pauseReason.slice(0, 300),
      context_json: JSON.stringify({ kind, pauseKind: lastRun.pause_kind, isProviderLimit, jobId: queued.jobId }),
      strategy: isProviderLimit ? 'watchdog:rate-limit-reset' : `watchdog:${kind}`,
    });
    resumed.push({ project: project.name, kind, jobId: queued.jobId });

    const label = isProviderLimit ? 'rate-limit-reset' : kind;
    console.log(chalk.cyan(
      `  🔁 watchdog: queued resume ${project.name} (${label} blocker, job #${queued.jobId})`,
    ));

    if (notifier) {
      notifier.notify({
        text: `🔁 Watchdog auto-resumed <b>${project.name}</b>\nBlocker: <code>${label}</code> — ${pauseReason.slice(0, 120)}`,
      }).catch(() => {});
    }
    } catch (err) {
      console.log(chalk.yellow(`  ⚠  watchdog: ${project.name} tick failed — ${err.message}`));
    }
  }

  return resumed;
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

let _timer   = null;
let _running = false;

/**
 * Start the watchdog on a periodic interval.
 * @returns {() => void}  stop function
 */
export function startWatchdog({ intervalMs = 60_000, cfg = null, notifier = null } = {}) {
  if (_timer) return () => stopWatchdog(); // already running

  const tick = async () => {
    if (_running) return; // skip if previous tick still in progress
    _running = true;
    try {
      await watchdogTick({ cfg, notifier });
    } catch (e) {
      console.warn(chalk.yellow(`[watchdog] tick error: ${e.message}`));
    } finally {
      _running = false;
    }
  };

  // Run once at startup (after a short delay so server is fully up)
  setTimeout(tick, 10_000);
  _timer = setInterval(tick, intervalMs);
  if (_timer.unref) _timer.unref(); // don't block process exit

  console.log(chalk.dim(`✓ Project watchdog started (interval: ${intervalMs / 1000}s)`));
  return () => stopWatchdog();
}

export function stopWatchdog() {
  if (_timer) {
    clearInterval(_timer);
    _timer   = null;
    _running = false;
  }
}
