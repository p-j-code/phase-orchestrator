// Claude Runner — spawns `claude -p` subprocesses and parses JSON output.
// v0.2.1: Closes stdin to avoid the 3s warning. Persists full transcripts to
// logs/. Retries transient errors with backoff. Surfaces real failure causes.

import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import {
  recordCall, upsertSession, setGuideSessionId, setLastDevSessionId,
  upsertLiveProgress, deleteLiveProgress, avgCallDurationMs,
  tryAcquireProviderCallLease, renewProviderCallLease, releaseProviderCallLease,
  isQueueJobCancellationRequested,
} from './state.js';
import { ProgressTracker } from './lib/live-progress.js';
import { modelToTier } from './model-router.js';
import { shouldPause, windowStatus, fairShareStatus } from './billing-guard.js';
import { preventSleep, allowSleep } from './lib/wake-lock.js';
import { liveStatus, formatElapsed as formatElapsedShared } from './lib/live-status.js';
import { getWorkerContext, withJobKey } from './lib/worker-context.js';
import {
  assertProviderCircuitClosed,
  providerCircuitScope,
  tripProviderCircuitFromError,
  tripProviderCircuitFromStreamEvent,
  recordWindowObservationFromStreamEvent,
} from './lib/provider-circuit-breaker.js';
import { isProviderRateLimitError, isTransientError } from './lib/transient-errors.js';
import { assertExecutionHost } from './lib/execution-host-policy.js';

// par-01-jobkeys: re-exported so callers that already import claude-runner.js
// for runClaude/killCurrent don't need a second import from worker-context.js
// just to isolate a concurrent spawn's job-tracking key.
export { withJobKey };
import { guideRoot, assertInsideDir } from './lib/guide-paths.js';
import { MCP_SERVER_NAME, qualifiedMcpToolNames } from './mcp/tool-names.js';

const execFileAsync = promisify(execFile);

/**
 * Run a read-only git command and return trimmed stdout, or null on any error.
 * Guaranteed not to throw — a non-repo dir, missing git binary, or timeout all
 * return null silently, consistent with project-scanner's best-effort reads.
 * Uses array-form args — no shell, no injection risk.
 *
 * @param {string[]} args  — e.g. ['log', '--oneline', '-12']
 * @param {{ cwd: string, timeout?: number }} opts
 * @returns {Promise<string|null>}
 */
export async function runGit(args, { cwd, timeout = 5000 } = {}) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOGS_DIR = path.join(REPO_ROOT, 'logs');

// Execution-host policy is static for the lifetime of a process. Cache the
// result after the first check so repeated runClaude() calls don't re-read
// the policy file from disk on every spawn (costly on NAS spinning disk).
let _executionHostResult = null;
async function assertExecutionHostOnce(entrypoint) {
  if (!_executionHostResult) {
    // Cache only success. A cached rejection (policy file mid-rewrite during a
    // deploy rsync, transient EIO) would poison every later runClaude in this
    // long-lived process until a manual restart.
    _executionHostResult = assertExecutionHost({ entrypoint }).catch((err) => {
      _executionHostResult = null;
      throw err;
    });
  }
  return _executionHostResult;
}

// ─── Cancellation support (per-job, worker-pool-safe) ───────────────────────
//
// The orchestrator runs up to max_workers_cap (default 8) jobs CONCURRENTLY via
// the worker pool (src/server.js). The pre-pool design tracked the running
// subprocess in a module-level singleton ("safe because the server runs ONE job
// at a time") — an invariant the v0.14.4 worker pool broke. With a singleton,
// every spawn overwrote it, so /cancel could only ever target the
// most-recently-spawned proc: cancelling project A would SIGTERM project B's
// claude, the intended job kept running, and a normally-completing job could be
// misclassified as cancelled by the shared flag.
//
// We now key both the process handle and the cancel flag by jobId, which the
// worker context (src/lib/worker-context.js) carries for every job. CLI
// invocations have no worker context, so they fall back to a single sentinel
// key — safe when the CLI runs exactly one job per process, as it does today.
//
// par-01-jobkeys: that "one job per process" invariant is what breaks the
// moment two runClaude calls run CONCURRENTLY in one process without going
// through the worker pool's ALS (e.g. a future parallel-spawn caller) — both
// would fall back to the SAME CLI_JOB_KEY sentinel and clobber each other's
// _procs entry, so killCurrent() could only ever target the most recently
// spawned of the two, exactly the pre-pool bug reintroduced one level down.
// The fix is NOT to mint a key per spawn inside spawnClaude — spawnClaude
// runs once PER RETRY ATTEMPT within runClaude's own retry loop, and the
// retry-backoff cancel check a few hundred lines below deliberately depends
// on the SAME jobKey surviving from one attempt to the next (a cancel that
// lands during the backoff sleep must still be honored when the next attempt
// spawns). Instead, a caller that wants isolated per-job tracking wraps its
// whole call in worker-context.js's `withJobKey(key, fn)`, which mints ONE
// key for the entire logical job (every attempt inside it) via ALS — the
// same pattern the worker pool already uses at server-telegram.js/
// server-discord.js's `workerContext.run({..., jobId: job.id}, ...)`, just
// available to bare-CLI/concurrent-caller code paths too. currentJobKey()
// itself is unchanged: it reads whatever jobId is in the ALS store (set by
// either the worker pool or withJobKey) and only falls back to the shared
// sentinel when no ALS context exists at all.

const CLI_JOB_KEY = '__cli__';

// jobId → { proc, meta }
const _procs = new Map();
// jobIds for which a cancel has been requested (the Set entry survives across
// retry backoff so a cancel that lands between attempts still takes effect).
const _cancelRequested = new Set();
// jobIds whose subprocess was killed because their heavy-call lease was lost
// (slot reclaimed after a TTL lapse). This is NOT a manual cancel: the close
// handler must reject with a transient-matching message so the job re-queues
// for a fresh lease instead of failing permanently.
const _leaseLostJobs = new Set();

// Exported (par-01-jobkeys) so callers using withJobKey() can confirm which
// key their spawns will be tracked under — e.g. to pass an explicit jobId
// into killCurrent({ jobId }) from outside the ALS frame that set it.
export function currentJobKey() {
  const ctx = getWorkerContext();
  return (ctx && ctx.jobId != null) ? ctx.jobId : CLI_JOB_KEY;
}

// Internal: called by spawnClaude on spawn / on close|error.
function trackProcess(jobKey, proc, meta) { _procs.set(jobKey, { proc, meta }); }
function untrackProcess(jobKey) { _procs.delete(jobKey); }

// Injectable group-kill: sends sig to the entire process group of pid.
// Replaced by __testHooks.setGroupKill so verify scripts can intercept it
// without spawning real processes or hitting OS-level PIDs.
let _groupKill = (pid, sig) => process.kill(-pid, sig);

/**
 * Kill the subprocess for a specific job. `jobId` defaults to the caller's
 * worker-context job. Marks the job cancel-requested first (so a kill that
 * races ahead of the spawn still sticks), then SIGTERMs that job's proc and
 * SIGKILLs it after 5s if it ignores the term. Returns { killed, pid?, meta?, reason }.
 */
export function killCurrent({ jobId, reason = 'manual cancel' } = {}) {
  const key = (jobId != null) ? jobId : currentJobKey();
  _cancelRequested.add(key);
  const entry = _procs.get(key);
  if (!entry || !entry.proc) {
    return { killed: false, reason: `no subprocess running for job #${key}` };
  }
  const { proc, meta } = entry;
  // Kill the entire process group so bash-spawned children (test runners, tsc,
  // git, etc.) are also terminated, not just the claude process — orphaned
  // children hold git lock files and open handles in the workspace.
  // Pass the POSITIVE pid: _groupKill negates internally (process.kill(-pid))
  // to target the group. Passing -proc.pid here double-negates to a single-
  // process kill, which is exactly the orphaning bug this fixes.
  try { _groupKill(proc.pid, 'SIGTERM'); } catch { /* setsid race — retry coming */ }
  // Capture `proc` in the closure (not a lookup) so a later spawn reusing the
  // same key can never cause us to SIGKILL the wrong process.
  // 100ms retry covers the setsid race window: if the first SIGTERM lands before
  // setsid() completes (PGID didn't exist yet → ESRCH), the second attempt
  // arrives after setsid() has certainly finished.
  setTimeout(() => { try { _groupKill(proc.pid, 'SIGTERM'); } catch { /* already dead or race-window */ } }, 100).unref?.();
  setTimeout(() => { try { _groupKill(proc.pid, 'SIGKILL'); } catch { /* already dead */ } }, 5000).unref?.();
  return { killed: true, reason, pid: proc.pid, meta };
}

/**
 * Kill every tracked subprocess. Used by the server's forced-shutdown / drain-
 * timeout paths so a Ctrl-C never orphans in-flight claude processes. Returns
 * the number of processes signalled.
 */
export function killAll({ reason = 'server shutdown' } = {}) {
  let n = 0;
  for (const key of [..._procs.keys()]) {
    if (killCurrent({ jobId: key, reason }).killed) n += 1;
  }
  return n;
}

export function getCurrentProcess(jobId) {
  const entry = _procs.get((jobId != null) ? jobId : currentJobKey());
  return (entry && entry.proc) ? { pid: entry.proc.pid, meta: entry.meta } : null;
}

export function clearCancellation(jobId) { _cancelRequested.delete((jobId != null) ? jobId : currentJobKey()); }
export function isCancellationRequested(jobId) {
  const key = (jobId != null) ? jobId : currentJobKey();
  if (_cancelRequested.has(key)) return true;
  const numeric = Number(key);
  if (Number.isInteger(numeric) && numeric > 0 && isQueueJobCancellationRequested(numeric)) {
    _cancelRequested.add(key);
    return true;
  }
  return false;
}

// Test-only seam: lets verify scripts register fake process handles and assert
// per-job kill targeting without spawning a real `claude`. Not used in prod.
export const __testHooks = {
  track: trackProcess,
  untrack: untrackProcess,
  reset() { _procs.clear(); _cancelRequested.clear(); _groupKill = (pid, sig) => process.kill(-pid, sig); },
  has: (jobKey) => _procs.has(jobKey),
  setGroupKill: (fn) => { _groupKill = fn; },
  // Restore the production default. Mirrors the real _groupKill — it negates
  // internally so a POSITIVE pid → process.kill(-pid) → group kill. (The prior
  // non-negating form silently degraded to a single-process kill once the call
  // sites were corrected to pass a positive pid, so it is realigned here.)
  resetGroupKill: () => { _groupKill = (pid, sig) => process.kill(-pid, sig); },
  // Exposed for unit tests: lets the wall-clock-timeout and idle-watchdog kill
  // paths inside spawnClaude be exercised with a fake hanging binary +
  // setGroupKill, asserting they hand _groupKill a POSITIVE pid (group kill).
  spawnClaude: (opts) => spawnClaude(opts),
};


const TRANSIENT_PATTERNS = [
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /socket hang up/i,
  // v0.14.10: Claude CLI's wording for the same underlying issue —
  // the JSON it emits says "socket connection was closed unexpectedly".
  // Without these patterns the v0.14.8 error caught no retry and the
  // job died after a single attempt, burning ~$0.30 on a transient.
  /socket.*closed/i,
  /connection.*closed/i,
  /network error/i,
  /rate.?limit/i,
  // Word-bounded: a bare /502/ substring-matches commit hashes ("502f…") and
  // large numbers, misclassifying hard failures as transient.
  /\b50[234]\b/,
  /token (?:expired|refresh)/i,
  // Wall-clock timeout: the subprocess was killed after exceeding subprocess_timeout_ms.
  // Retry — the agent may take a different path on the next attempt (e.g. skip
  // a hanging test, use --force-exit, or the transient hang self-resolves).
  /timed out after \d+m/i,
  // Idle/stall kill: the subprocess went silent (hung test / infinite loop).
  // Retry for the same reason as wall-clock — the next attempt may not stall.
  /stalled — no output for/i,
  // Smart health: a tool call (bash etc.) never returned — likely a hung command.
  // Retry — the next attempt may avoid the problematic command or use a timeout.
  /tool call hung for \d+m/i,
  // Smart health: Claude generated output continuously but never finished a turn.
  // Retry — the next attempt may produce a more focused, shorter response.
  /turn stalled — no completion for \d+m/i,
  // Heavy-call lease reclaimed mid-call (TTL lapse under an event-loop stall).
  // Retry: the next attempt re-acquires a fresh lease, so the account-wide
  // concurrency cap is never violated and the job is not lost as a "cancel".
  /heavy-call lease lost/i,
];

const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

// Hard-pause backstop. Throws the billing-window-exhausted error (with the
// provider reset timestamp) when the shared 5h window is over threshold. Called
// at runClaude entry AND again immediately after the heavy-call FIFO lease is
// granted — that wait can be up to 45 min, during which sibling processes may
// have pushed the shared window past the threshold, so an entry-only check is
// not sufficient to keep the invariant.
function throwIfWindowExhausted(cfg) {
  if (!shouldPause(cfg)) return;
  const s = windowStatus(cfg);
  const reasons = [];
  if (s.callsInWindow >= s.pauseThreshold) {
    reasons.push(`${s.callsInWindow} heavy-equivalent units in last ${s.windowHours}h exceeds pause threshold (${s.pauseThreshold})`);
  }
  if (s.costThresholdsEnforced && s.totalCostInWindow >= s.pauseCostThreshold) {
    reasons.push(`$${s.totalCostInWindow.toFixed(2)} spent in last ${s.windowHours}h exceeds pause threshold ($${s.pauseCostThreshold})`);
  }
  const resetsAt = s.pauseClearAt ? Math.ceil(s.pauseClearAt / 1000) : null;
  const retryAt = resetsAt ? ` {"resetsAt": ${resetsAt}}` : '';
  throw new Error(`Paused: billing window exhausted — ${reasons.join(' and ')}.${retryAt}`);
}

// ─── Phase 54 (par-07) — fair-share window admission ─────────────────────────
const FAIR_SHARE_POLL_MS = 60 * 1000; // re-check cadence while yielding

/**
 * Before spawning, yield the shared billing window when this project is over its
 * weighted fair share and another project is actively running. Called by
 * runClaude immediately after (and never in place of) the hard-pause backstop.
 *
 * Contract (correctness under concurrency + billing safety — the Opus override):
 *   - Cancellation is checked FIRST every iteration, so a Ctrl-C landing during a
 *     60s yield aborts within ONE iteration (clean Error, never a hung wait).
 *   - Budget exhausted (fair_wait_max_minutes reached) PROCEEDS with one warning
 *     — it MUST NOT throw, or it would recreate the mid-phase kill it removes.
 *     The hard pause stays the only runaway backstop.
 *   - Single-project runs are mathematically unaffected: activeCount is 1, so the
 *     wait condition (activeCount > 1) is never met and this returns immediately.
 *   - Zero tokens burn while queued — the wait is entirely before spawn.
 *
 * @param {Object} args
 * @param {Object} args.cfg - resolved config (reads billing.fair_share.*)
 * @param {string} [args.project] - the asking project (no project → no wait)
 * @param {Object} [deps] - test seams (each defaults to the production impl)
 * @param {Function} [deps.sleep] - (ms) => Promise
 * @param {Function} [deps.now] - () => epoch ms
 * @param {Function} [deps.status] - (cfg) => windowStatus()
 * @param {Function} [deps.fairShare] - (cfg, project) => Promise<fairShareStatus()>
 * @param {Function} [deps.isCancelled] - () => boolean
 * @param {Function} [deps.log] - (msg) => void
 * @returns {Promise<void>}
 */
export async function admitFairShare({ cfg, project }, {
  sleep = SLEEP,
  now = () => Date.now(),
  status = windowStatus,
  fairShare = fairShareStatus,
  isCancelled = isCancellationRequested,
  log = (msg) => console.log(chalk.yellow(msg)),
} = {}) {
  if (cfg?.billing?.fair_share?.enabled === false) return; // explicit opt-out
  if (!project) return;                                    // CLI/no-project calls
  const waitMaxMinutes = cfg.billing?.fair_share?.fair_wait_max_minutes ?? 15;
  const deadline = now() + waitMaxMinutes * 60 * 1000;

  for (;;) {
    // Cancellation FIRST — a cancel during the previous sleep must win before we
    // do anything else, so Ctrl-C never hangs the wait for up to 15 minutes.
    if (isCancelled()) {
      throw new Error('cancelled while waiting for window fair share');
    }
    // Only warn-state windows gate: 'ok' has room to proceed, 'pause' already
    // threw at the hard backstop above.
    if (status(cfg).state !== 'warn') return;
    const fs = await fairShare(cfg, project);
    if (!(fs.activeCount > 1 && fs.overShare)) return; // within share / alone → go
    if (now() >= deadline) {
      // Budget exhausted — PROCEED (never throw). The hard pause remains the
      // runaway backstop; config layer named so the operator can tune it.
      log(`${project}: fair-share wait budget (billing.fair_share.fair_wait_max_minutes=${waitMaxMinutes}m) exhausted — proceeding`);
      return;
    }
    log(`${project}: over fair share (${fs.projectCalls}/${Math.floor(fs.share)} heavy-equivalent units, ${fs.activeCount} active runs) — yielding window`);
    await sleep(FAIR_SHARE_POLL_MS);
  }
}

// ─── Global provider/account heavy-call lease ───────────────────────────────

const DEFAULT_CHEAP_CLAUDE_TASKS = Object.freeze([
  // These are deliberately tiny, bounded helper calls. Unknown/new tasks are
  // heavy by default so future pipelines inherit account protection safely.
  'ledger-extract', 'autopsy', 'autopilot-digest',
]);

export function resolveHeavyCallLeaseConfig(cfg = {}) {
  const raw = cfg.billing?.heavy_call_lease || {};
  const numberOr = (value, fallback, min = 1) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, n) : fallback;
  };
  const ttlMs = numberOr(raw.lease_ttl_ms, 180_000, 1_000);
  const pollMs = numberOr(raw.poll_ms, 2_000, 10);
  return {
    enabled: raw.enabled !== false,
    maxConcurrent: Math.max(1, Math.trunc(numberOr(raw.max_concurrent, 1))),
    leaseTtlMs: ttlMs,
    heartbeatMs: Math.min(
      Math.max(250, numberOr(raw.heartbeat_ms, 30_000, 250)),
      Math.max(250, Math.floor(ttlMs / 2)),
    ),
    pollMs,
    waiterTtlMs: Math.max(numberOr(raw.waiter_ttl_ms, 60_000, 1_000), pollMs * 3),
    waitTimeoutMs: numberOr(raw.wait_timeout_ms, 45 * 60 * 1000, 1_000),
    cheapTasks: new Set(Array.isArray(raw.cheap_tasks) ? raw.cheap_tasks : DEFAULT_CHEAP_CLAUDE_TASKS),
    heavyTasks: new Set(Array.isArray(raw.heavy_tasks) ? raw.heavy_tasks : []),
  };
}

/** Unknown tasks are heavy; explicit heavy_tasks wins over cheap_tasks. */
export function isHeavyClaudeCall({ cfg, task }) {
  const leaseCfg = resolveHeavyCallLeaseConfig(cfg);
  if (!leaseCfg.enabled) return false;
  if (leaseCfg.heavyTasks.has(task)) return true;
  if (leaseCfg.cheapTasks.has(task)) return false;
  return true;
}

export class HeavyCallLeaseTimeoutError extends Error {
  constructor(waitTimeoutMs, retryAtMs) {
    super(
      `Paused: billing window heavy-call concurrency admission timed out after `
      + `${Math.ceil(waitTimeoutMs / 60000)}m. {"resetsAt": ${Math.ceil(retryAtMs / 1000)}}`,
    );
    this.name = 'HeavyCallLeaseTimeoutError';
    this.code = 'HEAVY_CALL_LEASE_TIMEOUT';
    this.resetsAt = Math.ceil(retryAtMs / 1000);
  }
}

/**
 * FIFO, cross-process admission. Returns the active lease identity; the caller
 * must release it in finally. Waiting never consumes a Claude call.
 */
export async function admitHeavyClaudeCall({ cfg, project, task }, {
  sleep = SLEEP,
  now = () => Date.now(),
  isCancelled = isCancellationRequested,
  assertCircuit = assertProviderCircuitClosed,
  tryAcquire = tryAcquireProviderCallLease,
  release = releaseProviderCallLease,
  log = (msg) => console.log(chalk.yellow(msg)),
} = {}) {
  const leaseCfg = resolveHeavyCallLeaseConfig(cfg);
  if (!leaseCfg.enabled || !isHeavyClaudeCall({ cfg, task })) return null;

  const scope = providerCircuitScope(cfg);
  const token = randomUUID();
  const owner = `${process.pid}:${String(currentJobKey())}:${token}`;
  const startedAt = now();
  const waitUntilMs = startedAt + leaseCfg.waitTimeoutMs;
  let lastLogAt = 0;

  try {
    for (;;) {
      if (isCancelled()) throw new Error('cancelled while waiting for provider heavy-call lease');
      // If another process discovers provider exhaustion while we are queued,
      // abort admission immediately instead of waiting out the local semaphore.
      assertCircuit(cfg, { nowMs: now() });

      const at = now();
      if (at >= waitUntilMs) {
        throw new HeavyCallLeaseTimeoutError(leaseCfg.waitTimeoutMs, at + 60_000);
      }

      let claim;
      try {
        claim = tryAcquire({
          provider: scope.provider,
          account: scope.account,
          token,
          owner,
          project,
          task,
          pid: process.pid,
          maxConcurrent: leaseCfg.maxConcurrent,
          ttlMs: leaseCfg.leaseTtlMs,
          waiterTtlMs: leaseCfg.waiterTtlMs,
          waitUntilMs,
          nowMs: at,
        });
      } catch (err) {
        // A short cross-process SQLITE_BUSY should behave like another occupied
        // slot, not abort a night run. Other DB errors remain actionable.
        if (!/SQLITE_BUSY|database is locked/i.test(String(err?.message || err))) throw err;
        claim = null;
      }

      if (claim?.acquired) {
        return {
          token, owner, provider: scope.provider, account: scope.account,
          task, project, acquiredAt: at, waitedMs: at - startedAt,
          ttlMs: leaseCfg.leaseTtlMs, heartbeatMs: leaseCfg.heartbeatMs,
        };
      }
      if (claim?.timed_out) {
        throw new HeavyCallLeaseTimeoutError(leaseCfg.waitTimeoutMs, at + 60_000);
      }
      if (at - lastLogAt >= 30_000) {
        log(`[runner] ${project || 'global'}:${task} waiting for provider heavy-call slot `
          + `(${claim?.active ?? '?'}/${leaseCfg.maxConcurrent} active, queue #${claim?.position ?? '?'})`);
        lastLogAt = at;
      }
      await sleep(Math.min(leaseCfg.pollMs, Math.max(1, waitUntilMs - at)));
    }
  } catch (err) {
    try { release({ token, owner }); } catch { /* TTL still guarantees cleanup */ }
    throw err;
  }
}

function startHeavyLeaseHeartbeat(lease) {
  if (!lease) return null;
  const jobId = currentJobKey();
  const timer = setInterval(() => {
    try {
      const renewed = renewProviderCallLease({
        token: lease.token, owner: lease.owner, ttlMs: lease.ttlMs,
      });
      if (!renewed) {
        // A reclaimed/lost lease means another process may now own the only
        // slot. Stop this subprocess instead of knowingly violating the cap.
        // Flag it as lease-loss (not a manual cancel) FIRST so the close
        // handler rejects transiently and the job re-queues for a fresh lease.
        _leaseLostJobs.add(jobId);
        killCurrent({ jobId, reason: 'provider heavy-call lease lost' });
      }
    } catch (err) {
      console.warn(chalk.yellow(`[runner] provider heavy-call lease heartbeat failed: ${err.message}`));
    }
  }, lease.heartbeatMs);
  timer.unref?.();
  return timer;
}

function releaseHeavyClaudeCall(lease, heartbeat) {
  if (heartbeat) clearInterval(heartbeat);
  if (!lease) return;
  try {
    releaseProviderCallLease({ token: lease.token, owner: lease.owner });
  } catch (err) {
    // Never turn a completed Claude result into a failure; the short TTL is the
    // crash-safe backstop and the next claimant atomically reclaims it.
    console.warn(chalk.yellow(`[runner] provider heavy-call lease release failed: ${err.message}`));
  }
}

/**
 * Resolve the --max-turns value for a call. Resolution order:
 *   1. phases.task_max_turns[task] — wins outright over every other cap
 *      (unchanged pre-v0.17 semantics).
 *   2. LEGACY: phases.max_turns_per_opus_phase for /opus/i models — kept with
 *      its historical outright-win semantics so existing project overrides of
 *      this key keep behaving verbatim.
 *   3. v0.17 (MI-1): phases.max_turns_per_tier[tier], tier derived from the
 *      model id via modelToTier (cfg tier_models first, heuristic fallback) —
 *      this is what bounds a fable call at 60 turns instead of silently
 *      inheriting the 150-turn shared budget the old /opus/i check gave it.
 *      Narrowest wins between the tier cap and max_turns_per_phase, so a
 *      complexity-lowered shared cap (turn_budget_by_complexity) still bites
 *      under a higher tier cap.
 *   4. phases.max_turns_per_phase.
 *
 * @param {Object} args
 * @param {string} args.model - the resolved model id for this call
 * @param {string} args.task - task id (e.g. 'dev-execution', 'acceptance-check')
 * @param {Object} [args.phases] - cfg.phases
 * @param {Object} [args.tierModels] - cfg.model_routing.tier_models (optional;
 *   the model-id heuristic covers callers that omit it)
 * @returns {number|undefined}
 */
export function resolveMaxTurns({ model, task, phases, tierModels }) {
  const taskCap = phases?.task_max_turns?.[task];
  const hardCap = phases?.max_turns_hard_cap;
  const applyHardCap = (cap) => (hardCap != null && cap != null) ? Math.min(cap, hardCap) : cap;
  if (taskCap != null) return applyHardCap(taskCap);
  const shared = phases?.max_turns_per_phase;
  const opusCap = phases?.max_turns_per_opus_phase;
  if (/opus/i.test(model) && opusCap != null) return applyHardCap(opusCap);
  const tierCap = phases?.max_turns_per_tier?.[modelToTier(model, tierModels)];
  if (tierCap != null) return applyHardCap((shared != null) ? Math.min(tierCap, shared) : tierCap);
  return applyHardCap(shared);
}

// ─── v0.17 — complexity-tiered turn budgets + per-task effort (MI-4) ─────────

// Claude Code effort ladder, lowest → highest. 'high' is the CLI default, so
// an escalation boost from an unset task effort lands on 'xhigh'.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'];

/**
 * One-level effort boost for escalated re-runs (MI-4). Unset/unknown base
 * effort is treated as the CLI default ('high'); already-max stays 'xhigh'.
 */
export function bumpEffort(effort) {
  const idx = EFFORT_LEVELS.indexOf(effort);
  const base = idx === -1 ? EFFORT_LEVELS.indexOf('high') : idx;
  return EFFORT_LEVELS[Math.min(base + 1, EFFORT_LEVELS.length - 1)];
}

/**
 * Look up the turn budget for a routed complexity ('low'|'medium'|'high'|
 * 'critical') in phases.turn_budget_by_complexity. Returns null when the map
 * is absent/disabled or has no finite entry for this complexity (including
 * routing-disabled 'unknown'), meaning "no budget — leave caps alone".
 */
export function resolveComplexityTurnBudget(phases, complexity) {
  const budget = phases?.turn_budget_by_complexity?.[complexity];
  return (typeof budget === 'number' && Number.isFinite(budget)) ? budget : null;
}

/**
 * Return a shallow-cloned phases object with every turn cap clamped to
 * `budget` (never raised — Math.min against each configured cap, so the
 * narrowest-cap-wins rule in resolveMaxTurns is preserved for every tier).
 * task_max_turns is deliberately left untouched: per-task caps are explicit
 * operator decisions that win outright.
 */
export function applyTurnBudget(phases, budget) {
  const p = phases || {};
  const clamp = (v) => (typeof v === 'number' && Number.isFinite(v)) ? Math.min(v, budget) : budget;
  const clamped = { ...p, max_turns_per_phase: clamp(p.max_turns_per_phase) };
  if (typeof p.max_turns_per_opus_phase === 'number') {
    clamped.max_turns_per_opus_phase = Math.min(p.max_turns_per_opus_phase, budget);
  }
  if (p.max_turns_per_tier && typeof p.max_turns_per_tier === 'object') {
    clamped.max_turns_per_tier = Object.fromEntries(
      Object.entries(p.max_turns_per_tier).map(([tier, cap]) => [
        tier, (typeof cap === 'number' && Number.isFinite(cap)) ? Math.min(cap, budget) : cap,
      ]),
    );
  }
  return clamped;
}

// ─── Phase 46 — env allowlist for spawned sessions (P2 secondary hygiene) ────
// Spawned claude sessions used to inherit the operator's ENTIRE shell env
// (a plain `{ ...process.env }` spread) — every CI token, cloud credential, or
// personal API key sitting in the operator's shell leaked into every
// dev/fix/guide/chat subprocess. This is shell-var hygiene only (CI/cloud
// creds); it does NOT protect the file-based bot tokens under
// projects/<name>/.guide — that's phase-45's filesystem deny-rule sandbox's job.
//
// cfg.security.env_mode:
//   'allowlist' (default) — only a small, named set of vars pass through:
//     exact names (PATH/HOME/SHELL/USER/LOGNAME/TMPDIR/TERM/TZ/LANG), prefix
//     matches (LC_*/XDG_*), proxy vars (upper+lowercase), plus anything named
//     in cfg.security.env_passthrough (an exact var name or a trailing-`*`
//     prefix, e.g. 'MY_CI_TOKEN' or 'MY_PREFIX_*').
//   'inherit' — reproduces the exact pre-phase-46 behavior (full env spread)
//     as the rollback switch.
// ANTHROPIC_API_KEY is stripped in BOTH modes — Max plan OAuth billing
// depends on its absence regardless of the env policy; the CLI's own OAuth
// credentials ride on HOME, which always passes through in either mode.
// CLAUDE_* is deliberately NOT allowlisted as a prefix: when the
// orchestrator/MCP server itself runs inside a Claude Code session (e.g. the
// chat control-plane), vars like CLAUDE_PROJECT_DIR point at THAT session's
// root and would leak into every spawned guide/dev subprocess, which can then
// resolve its own relative output paths (e.g. the 'plan' task's
// `.guide/plan.json`) against the leaked parent project dir instead of its
// actual `cwd`. This caused a real incident: an aorch plan write landed in
// the orchestrator repo root instead of projects/aorch/.guide/.
// CLAUDE_CODE_OAUTH_TOKEN is the one exact-name exception: it carries no
// path semantics — it's the Max-plan OAuth credential itself, and on headless
// hosts (the NAS) it is the ONLY way spawned sessions can authenticate when
// no interactive login ever populated ~/.claude/.credentials.json.
const ENV_ALLOWLIST_EXACT = new Set(['PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'TMPDIR', 'TERM', 'TZ', 'LANG', 'CLAUDE_CODE_OAUTH_TOKEN']);
const ENV_ALLOWLIST_PREFIXES = ['LC_', 'XDG_'];
const ENV_PROXY_VARS = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']);

/**
 * Build the env object handed to a spawned claude subprocess. Pure function of
 * (cfg, baseEnv) — no globals touched — so it's directly unit-testable without
 * mutating process.env.
 *
 * @param {Object} cfg - resolved config (reads cfg.security.env_mode/env_passthrough)
 * @param {Object} [baseEnv] - the env to filter/copy from; defaults to process.env
 * @returns {Object} the env object to pass to child_process.spawn
 */
export function buildChildEnv(cfg, baseEnv = process.env) {
  const mode = cfg?.security?.env_mode ?? 'allowlist';
  let env;
  if (mode === 'inherit') {
    env = { ...baseEnv };
  } else {
    const passthrough = Array.isArray(cfg?.security?.env_passthrough) ? cfg.security.env_passthrough : [];
    const passthroughExact = new Set();
    const passthroughPrefixes = [];
    for (const entry of passthrough) {
      if (typeof entry !== 'string' || !entry) continue;
      if (entry.endsWith('*')) passthroughPrefixes.push(entry.slice(0, -1));
      else passthroughExact.add(entry);
    }
    env = {};
    for (const [key, value] of Object.entries(baseEnv)) {
      if (value === undefined) continue;
      const allowed = ENV_ALLOWLIST_EXACT.has(key)
        || ENV_ALLOWLIST_PREFIXES.some((prefix) => key.startsWith(prefix))
        || ENV_PROXY_VARS.has(key)
        || passthroughExact.has(key)
        || passthroughPrefixes.some((prefix) => key.startsWith(prefix));
      if (allowed) env[key] = value;
    }
  }
  delete env.ANTHROPIC_API_KEY;
  // Anti-hang hardening: the dev agent's Bash tool runs headless — any command
  // that opens a pager, an editor, or a credential prompt blocks forever and
  // dies 5 minutes later as "tool call hung for 5m (tool: Bash, SIGKILL)",
  // burning the whole subprocess (and its retries) on one stuck prompt. Force
  // the common interactive surfaces into non-interactive mode. These are
  // defaults only — an explicit value already in the (allowlisted) parent env
  // wins, and workspaces can still override per-command.
  const nonInteractive = {
    GIT_TERMINAL_PROMPT: '0', // git credential prompt → fail fast with an error the agent can read
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    LESS: 'FRX',
    EDITOR: 'true',           // git commit/rebase editor → no-op success
    VISUAL: 'true',
    npm_config_yes: 'true',   // npx "Ok to proceed? (y)" package-install prompt
    NO_UPDATE_NOTIFIER: '1',
    // Graceful Bash-tool timeouts INSIDE the CLI, below the orchestrator's
    // tool-hang watchdog (5m default): a runaway command now returns a
    // readable timeout error the agent can react to (background it, split it,
    // extend the per-call timeout up to the max) instead of the whole
    // subprocess dying by SIGKILL and burning the attempt. Long legitimate
    // runs (full test chains) can still request up to BASH_MAX_TIMEOUT_MS —
    // pair with a raised phases.tool_hang_timeout_ms so the CLI timeout
    // always fires first (see docs/retro/config-patch-2026-07-20.md).
    BASH_DEFAULT_TIMEOUT_MS: '240000',
    BASH_MAX_TIMEOUT_MS: '600000',
  };
  for (const [key, value] of Object.entries(nonInteractive)) {
    if (env[key] === undefined) env[key] = value;
  }
  return env;
}

// ─── Headless workspace trust ────────────────────────────────────────────────
// `claude -p` silently ignores the workspace's .claude/settings.json
// permission entries ("Ignoring N permissions.allow entries … this workspace
// has not been trusted") unless the cwd is marked trusted in ~/.claude.json.
// The trust dialog is interactive-only, so print-mode spawns on a headless
// host (the NAS) can never accept it — every project would need a manual
// interactive `claude` visit first. Instead, runClaude marks its cwd trusted
// before spawning. Every spawn flows through claude-runner (repo convention),
// so new projects are covered automatically the first time anything runs in
// them. This is equivalent to the operator accepting the dialog: the
// orchestrator itself authors those workspaces and their settings files.
const _trustedDirs = new Set();

/**
 * Ensure `cwd` is marked trusted in the Claude CLI's ~/.claude.json.
 * Best-effort and idempotent: returns true if trusted (already or newly),
 * false if the write failed or was skipped (never throws). An unparseable
 * existing file is left untouched — the CLI may be mid-write, and clobbering
 * it would destroy the operator's CLI state; only a missing file is created.
 *
 * Skips entirely when ORCHESTRATOR_SKIP_TRUST=1 (set by the unit tests so
 * fake-binary spawns don't write temp-dir entries into the operator's real
 * CLI state; also the operator's opt-out). The default path honors
 * CLAUDE_CONFIG_DIR, matching where the CLI itself keeps .claude.json.
 *
 * @param {string} cwd - workspace directory the subprocess will run in
 * @param {{ claudeJsonPath?: string }} [opts] - override for tests
 * @returns {Promise<boolean>}
 */
export async function ensureWorkspaceTrust(cwd, { claudeJsonPath = path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json') } = {}) {
  if (process.env.ORCHESTRATOR_SKIP_TRUST === '1') return false;
  if (!cwd) return false;
  const dir = path.resolve(cwd);
  const cacheKey = `${claudeJsonPath}\0${dir}`;
  if (_trustedDirs.has(cacheKey)) return true;
  try {
    let root = {};
    try {
      root = JSON.parse(await fsp.readFile(claudeJsonPath, 'utf-8'));
      if (!root || typeof root !== 'object' || Array.isArray(root)) return false;
    } catch (err) {
      if (err.code !== 'ENOENT') return false; // unreadable/corrupt — don't clobber
    }
    if (!root.projects || typeof root.projects !== 'object') root.projects = {};
    const entry = root.projects[dir];
    if (entry?.hasTrustDialogAccepted === true) {
      _trustedDirs.add(cacheKey);
      return true;
    }
    root.projects[dir] = { ...(entry && typeof entry === 'object' ? entry : {}), hasTrustDialogAccepted: true };
    const tmp = `${claudeJsonPath}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(root, null, 2), 'utf-8');
    await fsp.rename(tmp, claudeJsonPath);
    _trustedDirs.add(cacheKey);
    return true;
  } catch (err) {
    console.warn(chalk.yellow(`[runner] workspace-trust write failed for ${dir}: ${err.message}`));
    return false;
  }
}

/**
 * Phase 11 — writes the per-project MCP config JSON pointing `claude` at this
 * repo's `src/mcp/state-server.mjs`, under the PROJECT directory (never
 * /tmp) so it survives and is inspectable across runs. Only called when
 * `cfg.mcp.enabled` is true (see the call site in runClaude below) — this
 * function itself has no config-gating of its own, keeping the dark-launch
 * kill-switch in exactly one place.
 *
 * @param {string} projectDir - absolute path to `projects/<name>`
 * @param {string} project - project name (passed to state-server.mjs's --project)
 * @param {{manifestId:string, workspaceDir:string}|null} contextBinding - exact
 * manifest/worktree bound to this invocation; null preserves the original
 * mcp-config path and contents
 * @returns {Promise<string>} absolute path to the written mcp-config.json
 */
async function writeMcpConfig(projectDir, project, contextBinding = null) {
  const realProjectDir = await fsp.realpath(projectDir);
  const requestedGuideDir = guideRoot(projectDir);
  // Anchor containment at the real project root before mkdir. Validating a
  // config relative to .guide itself is insufficient when .guide is already a
  // symlink to an attacker-controlled directory outside the project.
  const guideCreationPath = await assertInsideDir(realProjectDir, requestedGuideDir);
  await fsp.mkdir(guideCreationPath, { recursive: true });
  const guideDir = await assertInsideDir(realProjectDir, requestedGuideDir);
  const contextManifestId = contextBinding?.manifestId || null;
  const boundWorkspaceDir = contextManifestId
    ? await assertInsideDir(projectDir, contextBinding?.workspaceDir)
    : null;
  // Context-enabled invocations get an immutable manifest-specific config
  // filename. Parallel phases can otherwise overwrite the shared config after
  // this call but before Claude reads it, silently binding a task to another
  // phase's latest manifest. Shadow/core-only behavior deliberately retains
  // the original filename and byte-identical server args.
  const workspaceHash = boundWorkspaceDir
    ? createHash('sha256').update(boundWorkspaceDir).digest('hex').slice(0, 16)
    : null;
  const configName = contextManifestId
    ? `mcp-config-${contextManifestId}-${workspaceHash}.json`
    : 'mcp-config.json';
  const mcpConfigPath = await assertInsideDir(guideDir, path.join(guideDir, configName));
  const serverArgs = [path.join(REPO_ROOT, 'src', 'mcp', 'state-server.mjs'), '--project', project];
  if (contextManifestId) {
    serverArgs.push('--context-manifest-id', contextManifestId, '--workspace-dir', boundWorkspaceDir);
  }
  const config = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: process.execPath,
        args: serverArgs,
      },
    },
  };
  const contents = JSON.stringify(config, null, 2);
  if (!contextManifestId) {
    // Preserve the historical core/shadow write exactly.
    await assertInsideDir(realProjectDir, guideDir);
    await fsp.writeFile(mcpConfigPath, contents, 'utf-8');
  } else {
    // Publish only after the complete file exists, and never overwrite an
    // already-published binding. link(2) is an atomic no-clobber publication;
    // a duplicate logical invocation may reuse the file only if byte-identical.
    const tempPath = await assertInsideDir(guideDir, path.join(guideDir, `.${configName}.${process.pid}.${randomUUID()}.tmp`));
    await assertInsideDir(realProjectDir, guideDir);
    await fsp.writeFile(tempPath, contents, { encoding: 'utf-8', flag: 'wx' });
    try {
      try {
        await assertInsideDir(realProjectDir, guideDir);
        await fsp.link(tempPath, mcpConfigPath);
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        const existing = await fsp.readFile(mcpConfigPath, 'utf-8');
        if (existing !== contents) {
          throw new Error(`[runner] immutable MCP config collision at ${mcpConfigPath}`);
        }
      }
    } finally {
      await fsp.unlink(tempPath).catch(() => {});
    }
  }
  return mcpConfigPath;
}

/**
 * Run a Claude Code invocation in headless mode.
 *
 * @param {Object} opts (same as v0.2 plus retry config from cfg)
 * @param {Object} [deps] optional test seams; production callers omit this
 */
export async function runClaude({
  cfg, cwd, prompt, systemPromptFile, systemPromptExtra,
  sessionId, role, project, phase, task = 'dev-execution', projectDir,
  // Chat control plane (v0.16): when set, allowedToolsOverride REPLACES
  // cfg.tools.allowed_default (e.g. [] = MCP tools only), and
  // mcpConfigOverride {path, toolNames} wires --mcp-config independent of the
  // dark-launched cfg.mcp.enabled state-server path. Both default to absent,
  // leaving every existing call site's assembled args byte-identical.
  // Phase 46: when this parameter is left at its null default, a matching
  // cfg.tools.task_profiles[task] array (default map {}) is used in its
  // place — an explicit parameter always wins outright over the profile.
  allowedToolsOverride = null, mcpConfigOverride = null,
  // v0.17 (OBS-2): optional routing metadata the caller already computed via
  // routeModel() — { tier, reasoning: string[], attempt, escalated }. Purely
  // additive telemetry threaded into recordCall; every field is optional and
  // a caller that omits `routing` entirely (every pre-OBS-2 call site) gets
  // identical behavior — recordCall just persists NULLs for those columns.
  routing = null,
  // Optional callback fired for each parsed stream-json event as it arrives
  // from the claude subprocess. Used by the chat SSE endpoint to push live
  // tool-use events to the client without waiting for the full turn.
  onStreamEvent = null,
}, {
  retrySleep = SLEEP,
  retryBackoffMs = [0, 5000, 15000],
} = {}) {
  // Mac and NAS keep separate SQLite admission state. Enforce the checked-in
  // single-writer authority at the final spawn boundary as well as worker
  // startup, so a stray CLI/script cannot bypass provider serialization.
  await assertExecutionHostOnce(`Claude provider call (${task})`);

  // Account-wide admission gate. This is checked before every Claude call,
  // including roleless helpers (chat, autopsy, acceptance, ledger), so the
  // first process that observes a provider limit stops every sibling brief
  // chain from producing a same-window rejection cascade.
  assertProviderCircuitClosed(cfg);

  // Preserve the exact unblock timestamp in the error. pauseClearAt walks
  // calls in expiry order until units drop BELOW pauseThreshold — more
  // accurate than reclaim.next (oldest call's expiry) when cheap calls
  // age out first without actually clearing the window.
  throwIfWindowExhausted(cfg);

  // Phase 54 (par-07) — fair-share window admission. Runs AFTER (never replaces)
  // the hard-pause backstop above: runaway spend still hard-stops. When two
  // projects share one billing window and it is merely 'warn' (not yet 'pause'),
  // a project that is over its weighted slice YIELDS here — before spawning, so
  // zero tokens burn while queued — letting the under-share project claim the
  // remaining window instead of both racing to the pause threshold and killing
  // the loser mid-phase. Dormant on the shipped pause_at_calls:9999 (share is
  // effectively infinite). Budget-exhausted PROCEEDS (never throws — that would
  // recreate the very mid-phase kill this removes); only a cancellation throws.
  await admitFairShare({ cfg, project });

  const claudeBin = cfg._resolved.claude_bin;
  let model = cfg.model;

  // OBS-2 follow-up: helper tasks that deliberately bypass routeModel (chat,
  // acceptance-check, ledger-extract, autopsy…) used to record NULL
  // routing_tier, making them indistinguishable from pre-OBS-2 legacy rows in
  // the dashboard and invisible to demotion learning. Synthesize a static
  // baseline here so routing_tier NULL now means exactly one thing: legacy.
  if (!routing) {
    routing = {
      tier: modelToTier(model, cfg.model_routing?.tier_models),
      reasoning: [`static baseline models.${task} (no router pass)`],
    };
  }
  // stream-json (not plain json) so the runner sees output incrementally and can
  // detect a stall — a hung test/infinite loop goes silent on stdout, which the
  // idle-timeout below catches in minutes instead of waiting out the full
  // wall-clock. Print-mode stream-json REQUIRES --verbose. The final
  // {"type":"result",...} line carries the same fields the old single-object
  // json output did (session_id, total_cost_usd, usage, result, is_error).
  const args = ['-p', prompt, '--model', model, '--output-format', 'stream-json', '--verbose'];

  // Phase 11 — MCP state server (dark-launched behind cfg.mcp.enabled, default
  // false). Only wired when the caller also passes `projectDir` (today:
  // runDev()'s dev-role calls in phase-runner.js) — every other call site
  // (guide/audit/acceptance-check/etc.) never passes it and is unaffected
  // regardless of the flag. When cfg.mcp.enabled is false OR projectDir is
  // absent, this block is a complete no-op and the assembled args are
  // byte-identical to pre-phase-11 (claude-runner.test.mjs asserts this — the
  // same cache-stability discipline phase 1 established for the system
  // prompt, applied here to spawn args).
  // Phase 46: a null allowedToolsOverride (the parameter default — no caller
  // opinion) falls back to a per-task profile when configured; an explicit
  // parameter (even []) always wins outright and never consults the map.
  const taskProfile = cfg.tools?.task_profiles?.[task];
  const effectiveToolsOverride = allowedToolsOverride !== null
    ? allowedToolsOverride
    : (Array.isArray(taskProfile) ? taskProfile : null);
  const allowedToolsList = Array.isArray(effectiveToolsOverride)
    ? [...effectiveToolsOverride]
    : [...(cfg.tools?.allowed_default || [])];
  let mcpConfigPath = null;
  if (mcpConfigOverride?.path) {
    mcpConfigPath = mcpConfigOverride.path;
    allowedToolsList.push(...(mcpConfigOverride.toolNames || []));
  } else if (cfg.mcp?.enabled && projectDir && project) {
    const contextMode = cfg._context_compiler?.mode || cfg.context_compiler?.mode;
    const currentManifestId = cfg._context_compiler?.manifest_id;
    const includeContext = cfg.context_compiler?.enabled === true
      && (contextMode === 'assist' || contextMode === 'enforce')
      && /^[a-f0-9]{64}$/.test(String(currentManifestId || ''))
      // A compiled artifact can still be shadow-only, enforce-degraded, or
      // fail to render. In those cases it remains useful telemetry but was not
      // exposed to this invocation, so advertising its context tools would
      // violate the same safety decision that retained the broad repo map.
      && cfg._context_compiler?.exposed === true;
    mcpConfigPath = await writeMcpConfig(projectDir, project, includeContext
      ? { manifestId: currentManifestId, workspaceDir: cwd }
      : null);
    allowedToolsList.push(...qualifiedMcpToolNames({ includeContext }));
  }
  const allowedTools = allowedToolsList.join(',');
  if (allowedTools) args.push('--allowedTools', allowedTools);
  if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath);
  if (cfg.tools?.permission_mode) args.push('--permission-mode', cfg.tools.permission_mode);
  const maxTurns = resolveMaxTurns({ model, task, phases: cfg.phases, tierModels: cfg.model_routing?.tier_models });
  if (maxTurns) args.push('--max-turns', String(maxTurns));
  // v0.17 (MI-4, corrected): per-task reasoning depth via the CLI's
  // effortLevel setting — the adaptive-thinking model generation removed
  // budget_tokens, so MAX_THINKING_TOKENS is a no-op there and --settings is
  // the per-invocation lever (JSON-string form, supported by claude ≥2.0.53).
  // cfg._effort_override (set by phase-runner's escalation path) wins over
  // the static phases.task_effort map; tasks with neither add NO arg, so the
  // assembled args stay byte-identical for unconfigured tasks (same
  // cache/arg-stability discipline the MCP wiring follows above).
  const effortLevel = cfg._effort_override ?? cfg.phases?.task_effort?.[task];
  if (effortLevel) args.push('--settings', JSON.stringify({ effortLevel }));
  if (systemPromptFile) {
    let systemPrompt = await fsp.readFile(systemPromptFile, 'utf-8');
    if (systemPromptExtra) {
      systemPrompt = `${systemPrompt}\n\n${systemPromptExtra}`;
    }
    args.push('--append-system-prompt', systemPrompt);
  } else if (systemPromptExtra) {
    args.push('--append-system-prompt', systemPromptExtra);
  }
  // activeSessionId can be cleared mid-retry if the session has corrupt
  // thinking blocks (the API 400s when we try to --resume it).
  let activeSessionId = sessionId;
  if (activeSessionId) args.push('--resume', activeSessionId);

  // A resumed call normally relies on context already present in the Claude
  // conversation and therefore does not repeat the compiled block. The runner
  // can, however, discard a corrupt or stalled session during its internal
  // retry loop. Restore the exact bounded block only on that fresh retry so it
  // never continues with neither compiled context nor the historical repo map.
  const restoreCompiledContextForFreshRetry = () => {
    const block = cfg._context_compiler?.recovery_block;
    if (typeof block !== 'string' || !block.trim()) return false;
    const manifestId = cfg._context_compiler?.manifest_id;
    const marker = `<compiled_context manifest_id="${manifestId}"`;
    if (String(args[1] || '').includes(marker)) return false;
    const safeBlock = block.replace(/\0/g, '');
    args[1] = `${safeBlock}\n\n<context_recovery>\nThe prior resumed session could not be reused. Continue from the current workspace state; do not redo completed work.\n</context_recovery>\n\n${args[1]}`;
    return true;
  };

  const env = buildChildEnv(cfg);

  // Headless trust: without this, print-mode spawns on hosts where the cwd
  // was never visited interactively (the NAS) ignore the workspace's
  // .claude/settings.json permission entries. Best-effort — a failed write
  // degrades to the old behavior, it never blocks the spawn.
  await ensureWorkspaceTrust(cwd);

  // Strip null bytes from every string in args. The LLM occasionally emits a
  // raw \0 in its output, which propagates into guide-generated prompt files
  // and then into spawn args. Node's spawn() rejects strings with null bytes
  // ("args[1] must be a string without null bytes"). Sanitize once here so
  // prompts, system prompts, and project-context blocks are all covered.
  let nullByteStripped = 0;
  for (let i = 0; i < args.length; i += 1) {
    if (typeof args[i] === 'string' && args[i].indexOf('\0') !== -1) {
      args[i] = args[i].replace(/\0/g, '');
      nullByteStripped += 1;
    }
  }
  if (nullByteStripped > 0) {
    console.warn(chalk.yellow(`[runner] stripped null bytes from ${nullByteStripped} arg(s) before spawn`));
  }

  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const logBase = path.join(
    LOGS_DIR,
    `${project || 'unknown'}-${task}-${Date.now()}`,
  );
  const stdoutLog = `${logBase}.stdout.log`;
  const stderrLog = `${logBase}.stderr.log`;

  // Retry policy
  const maxAttempts = 3;
  const backoffMs = retryBackoffMs;

  // ─── Live-status entry (v0.14.9) ──────────────────────────────────────────
  // Replaces the per-call `ora` spinner that broke under cross-project
  // concurrency (v0.14.8 BUG-?: multiple ora instances fought over the same
  // TTY, leaving ghosted "running…" lines and tacking console.log output
  // onto the spinner row). The shared LiveStatus owns one anchored region
  // at the bottom of stdout, one row per active worker, with a [wN project]
  // tag so parallel runs are visually distinct. Wake lock keeps macOS awake
  // during the call (no-op on Linux/NAS).
  //
  // The live entry is keyed by `${jobId || phase || start}:${task}` so two
  // runClaude calls in the same worker (e.g. dev-execution followed by a
  // post-phase review) don't collide. The worker tag comes from the ALS
  // context set by server.js; outside the server (e.g. CLI `npm run dev`)
  // it falls back to no-tag rendering.
  const overallStart = Date.now();
  const ctx = getWorkerContext();
  const liveKey = `w${ctx?.workerId ?? 'cli'}:${ctx?.jobId ?? overallStart}:${task}`;
  let spinnerState = 'running'; // 'running' | 'retry-wait'
  let spinnerAttempt = 0;
  const noSpinner = process.env.ORCHESTRATOR_NO_SPINNER === '1' || !process.stdout.isTTY;

  if (noSpinner) {
    // Non-TTY / silenced: emit an explicit start line so the log file still
    // has a record of what we tried to run.
    console.log(chalk.dim(`▸ ${task} starting…`));
  } else {
    liveStatus.set(liveKey, {
      workerId: ctx?.workerId ?? '?',
      project: ctx?.project ?? project ?? '?',
      task,
      startedAt: overallStart,
      state: 'running',
      maxAttempts,
    });
  }

  preventSleep();

  let lastError = null;
  // A caller-level routing `attempt` (e.g. the second, Opus-escalated phase
  // attempt) is not the same thing as runClaude's internal transient retry.
  // Mint one stable identity for this logical invocation and number every
  // actual subprocess launch independently. This lets billing and reliability
  // reports see all consumed attempts without inventing an extra summary row.
  const logicalCallId = randomUUID();
  let subprocessAttempts = 0;
  const handleStreamEvent = (event) => {
    try {
      // Persist EVERY window observation (utilization + resetsAt per type) so
      // billing-guard can track the provider's actual meter, then evaluate
      // whether this event should trip the shared breaker.
      recordWindowObservationFromStreamEvent(cfg, event);
      const warning = tripProviderCircuitFromStreamEvent(cfg, event, { project, task });
      if (warning?.open) {
        console.warn(chalk.yellow(
          `[provider] five-hour window warning received; new calls paused until ${new Date(warning.blocked_until_ms).toISOString()}`,
        ));
      }
    } catch (err) {
      console.warn(chalk.yellow(`[runner] could not persist provider warning: ${err.message}`));
    }
    if (onStreamEvent) onStreamEvent(event);
  };
  // Consecutive stalls are tracked for diagnostics only. Transport/liveness
  // failures never change model tier: a larger model cannot create network,
  // timeout, or context headroom and silently escalating here was an expensive
  // contradiction of the outer failure router.
  let stallCount = 0;
  // Cap on thinking-block/redacted_thinking 400 retries. Without this cap a
  // permanently-corrupt session could decrement `attempt` indefinitely via
  // `attempt -= 1; continue`, bypassing maxAttempts entirely.
  let thinkingBlockRetries = 0;
  const MAX_THINKING_BLOCK_RETRIES = 2;
  // Cap on in-process retries for a lost heavy-call lease. A single retry
  // recovers the common transient case (a brief slot contention / renewal
  // blip) by re-acquiring a fresh lease through the FIFO. But a PERSISTENT
  // lease loss means a sustained event-loop stall or clock skew, and re-
  // spawning into it would just burn another partial call, then another —
  // exactly the token-burn cycle we must avoid. After one retry we stop
  // re-spawning and surface the (transient) error so the DURABLE queue re-
  // schedules with backoff, giving the underlying stall time to clear.
  let leaseLossRetries = 0;
  const MAX_LEASE_LOSS_RETRIES = 1;
  try {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0) {
        spinnerState = 'retry-wait';
        spinnerAttempt = attempt;
        if (!noSpinner) {
          liveStatus.update(liveKey, { state: 'retry-wait', attempt: spinnerAttempt });
        } else {
          console.log(chalk.yellow(`▸ ${task} retry ${spinnerAttempt}/${maxAttempts - 1} — waiting…`));
        }
        await retrySleep(backoffMs[attempt] ?? backoffMs.at(-1) ?? 0);
        spinnerState = 'running';
        if (!noSpinner) {
          liveStatus.update(liveKey, { state: 'running' });
        }
      }

    // A sibling process may have opened the shared breaker while this call was
    // in retry backoff. Re-check immediately before the actual subprocess
    // spawn; a blocked admission is not recorded as a Claude call.
    assertProviderCircuitClosed(cfg);

    let result;
    // Wall-clock ceiling: per-task override (e.g. fix-execution capped tighter)
    // falls back to the global subprocess_timeout_ms, then a 30-min default.
    const taskTimeoutOverride = cfg.phases?.task_timeout_ms?.[task];
    const timeoutMs = taskTimeoutOverride ?? cfg.phases?.subprocess_timeout_ms ?? 30 * 60 * 1000;
    // Idle/stall ceiling: kill if the subprocess emits no stream output for this
    // long. null disables it (wall-clock only). This is the "smart" timeout —
    // it distinguishes a working session (constant stream events) from a stuck
    // one (silence) without waiting out the full wall-clock.
    const idleTimeoutMs = cfg.phases?.idle_timeout_ms ?? 5 * 60 * 1000;
    // Smart health timeouts: parsed from stream-json events in real-time.
    // tool_hang: a tool_use event fired but tool_result never arrived.
    // turn_stall: no turn boundary (user/result) for too long — Claude stuck generating.
    const toolHangTimeoutMs = cfg.phases?.tool_hang_timeout_ms ?? 5 * 60 * 1000;
    const turnStallTimeoutMs = cfg.phases?.turn_stall_timeout_ms ?? 20 * 60 * 1000;

    // Serialize expensive calls across every process sharing this provider /
    // account. Acquire per ATTEMPT (not for the whole retry loop), so backoff
    // time yields the slot to another project. Cheap bounded helper tasks are
    // configurable exemptions; unknown tasks are protected by default.
    const heavyLease = await admitHeavyClaudeCall({ cfg, project, task });
    try {
      // The provider breaker may have opened while this call waited in the FIFO.
      assertProviderCircuitClosed(cfg);
      // The shared 5h window may also have crossed the hard-pause threshold
      // during the (up to 45 min) FIFO wait as siblings kept spending. Re-run
      // the same backstop before spawning so a queued call cannot burn into an
      // already-exhausted window. Release the lease first so the pause does not
      // hold the single slot.
      throwIfWindowExhausted(cfg);
    } catch (err) {
      releaseHeavyClaudeCall(heavyLease, null);
      throw err;
    }
    const heavyLeaseHeartbeat = startHeavyLeaseHeartbeat(heavyLease);
    const startTime = Date.now();
    const subprocessAttempt = ++subprocessAttempts;
    try {
      // Phase 59: thread the resolved maxTurns (+ phase/model) into spawn meta
      // so the live_progress row's cap and header land correctly. maxTurns here
      // is exactly resolveMaxTurns()'s value assembled into --max-turns above.
      result = await spawnClaude({ claudeBin, args, cwd, env, stdoutLog, stderrLog, meta: { project, task, role, phase, model, maxTurns }, timeoutMs, idleTimeoutMs, toolHangTimeoutMs, turnStallTimeoutMs, liveKey, noSpinner, onStreamEvent: handleStreamEvent });

      // Persist an authoritative rejection BEFORE releasing the only heavy
      // slot. Otherwise a queued sibling could win the slot in the small gap
      // between spawn completion and result bookkeeping and make one needless
      // rejected call. Some CLI builds emit error_* with is_error=false, so
      // normalize the subtype at this boundary as well.
      if (typeof result.subtype === 'string' && result.subtype.startsWith('error') && !result.is_error) {
        result.is_error = true;
        if (!result.result) result.result = `Ended with subtype: ${result.subtype}`;
      }
      if (result.is_error && isProviderRateLimitError(result.result)) {
        try {
          tripProviderCircuitFromError(cfg, result.result, { project, task });
        } catch (breakerErr) {
          console.warn(chalk.yellow(`[runner] could not persist provider circuit breaker: ${breakerErr.message}`));
        }
      }
    } catch (err) {
      lastError = err;

      // Persist EVERY actual spawn outcome, not only the terminal failure.
      // Transient/stall/timeout/thinking-block/provider errors can all consume
      // a provider request before runClaude retries. Recording here, before
      // any `continue`, gives each subprocess exactly one row. The terminal
      // branch below therefore must not insert a second logical-summary row.
      recordCall({
        // Only role-bound guide/dev sessions are inserted into sessions.
        // Roleless resumptions track continuity elsewhere and must not violate
        // calls.session_id's FK.
        session_id: (project && role) ? (activeSessionId || null) : null,
        project: project || null,
        phase: phase || null,
        task,
        model,
        duration_ms: Date.now() - startTime,
        is_error: true,
        error_message: err.message,
        max_turns: maxTurns,
        routing_tier: routing?.tier,
        routing_reason: routing?.reasoning?.join('\n'),
        attempt: routing?.attempt,
        escalated: routing?.escalated,
        logical_call_id: logicalCallId,
        subprocess_attempt: subprocessAttempt,
        context_manifest_id: cfg._context_compiler?.manifest_id,
        context_provider: cfg._context_compiler?.provider,
        context_mode: cfg._context_compiler?.mode,
        context_injected_tokens: cfg._context_compiler?.injected_tokens,
      });

      // Phase 59: drop the live_progress row the moment a spawn attempt fails,
      // so a stale "turn 12/150 · tool …" never lingers through the retry
      // backoff (or after a permanent failure). Covers "deleted after error"
      // AND "deleted between retry attempts" — every retry path below flows
      // through here first, and the next attempt's tracker re-UPSERTs fresh.
      if (project) deleteLiveProgress(project);

      // Thinking-block corruption: the API refuses to resume a session whose
      // thinking/redacted_thinking blocks were modified (e.g. by compaction).
      // Drop the session and retry immediately without --resume so the call
      // completes in a fresh context rather than burning the attempt budget.
      const isThinkingBlocksError = /thinking.*blocks.*cannot be modified|redacted_thinking.*cannot be modified/i.test(err.message);
      if (isThinkingBlocksError && activeSessionId) {
        if (thinkingBlockRetries < MAX_THINKING_BLOCK_RETRIES) {
          console.warn(chalk.yellow(`[runner] ${task}: thinking-block 400 on --resume ${activeSessionId} — dropping session and retrying fresh (${thinkingBlockRetries + 1}/${MAX_THINKING_BLOCK_RETRIES})`));
          const rIdx = args.indexOf('--resume');
          if (rIdx !== -1) args.splice(rIdx, 2);
          activeSessionId = null;
          restoreCompiledContextForFreshRetry();
          if (project && role === 'guide') setGuideSessionId(project, null);
          if (project && role === 'dev') setLastDevSessionId(project, null);
          thinkingBlockRetries += 1;
          // Don't charge this against the retry budget — the session drop is a
          // correction, not a transient. Undo the increment so the next
          // iteration uses the same attempt slot.
          attempt -= 1;
          continue;
        }
        // Cap exceeded — fall through to normal attempt budget. The error is not
        // in TRANSIENT_PATTERNS so it rethrows immediately from the block below.
      }

      // Bound in-process re-spawns for a lost heavy-call lease (see the
      // MAX_LEASE_LOSS_RETRIES rationale). After one retry, defer to the
      // durable queue so a persistent stall cannot burn attempt after attempt.
      const isLeaseLost = /heavy-call lease lost/i.test(err.message);
      if (isLeaseLost) {
        leaseLossRetries += 1;
        if (leaseLossRetries > MAX_LEASE_LOSS_RETRIES) {
          liveStatus.delete(liveKey);
          console.log(chalk.red(
            `✗ ${task}: heavy-call lease lost ${leaseLossRetries}× — deferring to durable retry instead of re-spawning (avoids token burn).`,
          ));
          throw enrichError(err, { stdoutLog, stderrLog, attempt });
        }
      }

      const isProviderLimit = isProviderRateLimitError(err.message);
      if (isProviderLimit) {
        try {
          tripProviderCircuitFromError(cfg, err.message, { project, task });
        } catch (breakerErr) {
          console.warn(chalk.yellow(`[runner] could not persist provider circuit breaker: ${breakerErr.message}`));
        }
      }
      // Union the local runner-specific patterns (timeouts/stalls, which the
      // shared classifier deliberately excludes) with the canonical transient
      // classifier — the local list had drifted and missed 529/5xx/overloaded/
      // ECONNREFUSED/EAI_AGAIN/EPIPE/fetch-failed, so those network/overload
      // errors died after one attempt. Provider quota/rate-limit errors are still
      // caught by isProviderLimit below and thrown immediately (never retried).
      const isTransient = TRANSIENT_PATTERNS.some((p) => p.test(err.message)) || isTransientError(err.message);
      // Provider quota/session/weekly-limit failures must never use the local
      // three-attempt transient retry loop: another Claude call cannot repair
      // an exhausted account. Persist the breaker and surface immediately.
      if (isProviderLimit || !isTransient || attempt === maxAttempts - 1) {
        // Permanent failure or out of retries. This subprocess was already
        // recorded at catch entry; do not double-count it as a logical outcome.
        liveStatus.delete(liveKey);
        console.log(
          chalk.red(`✗ ${task} failed after ${formatElapsedShared(Date.now() - overallStart)} — ${err.message.split('\n')[0]}`),
        );
        throw enrichError(err, { stdoutLog, stderrLog, attempt });
      }

      // Stall handling: if the subprocess
      // produced no output (not a hung command — that still streams), the model
      // got stuck. First stall: retry on the SAME model with a fresh session —
      // stalls are usually context/environment, and dropping --resume clears the
      // bloated context that caused them. Later bounded attempts remain on the
      // same model; after exhaustion, durable recovery decides when to resume.
      const isStall = /stalled — no output for/i.test(err.message);
      if (isStall) {
        stallCount += 1;
        if (stallCount === 1) {
          if (activeSessionId) {
            const rIdx = args.indexOf('--resume');
            if (rIdx !== -1) args.splice(rIdx, 2);
            activeSessionId = null;
            restoreCompiledContextForFreshRetry();
            if (project && role === 'guide') setGuideSessionId(project, null);
            if (project && role === 'dev') setLastDevSessionId(project, null);
            console.warn(chalk.yellow(`[runner] ${task}: stall #1 on ${model} — retrying same model with fresh session (no --resume)`));
          } else {
            console.warn(chalk.yellow(`[runner] ${task}: stall #1 on ${model} — retrying same model`));
          }
        } else {
          console.warn(chalk.yellow(
            `[runner] ${task}: stall #${stallCount} on ${model} — bounded same-tier retry ${attempt + 1}/${maxAttempts - 1}`,
          ));
        }
      } else {
        stallCount = 0; // non-stall transient breaks the consecutive streak
      }

      // Transient — loop back to retry. Don't stop spinner; loop iteration will flip state.
      continue;
    } finally {
      // Runs for success, provider rejection, retry `continue`, cancellation,
      // timeout, and thrown parse/spawn errors. Process death is covered by TTL.
      releaseHeavyClaudeCall(heavyLease, heavyLeaseHeartbeat);
      // Clear the lease-lost flag unconditionally so it can never leak into a
      // later spawn under the same job key (e.g. if the close handler resolved
      // normally in the race window after the flag was set).
      _leaseLostJobs.delete(currentJobKey());
    }

    // Success
    const duration = Date.now() - startTime;
    const returnedSessionId = result.session_id;
    if (returnedSessionId && role && project) {
      upsertSession({ session_id: returnedSessionId, project, role });
      if (role === 'guide') setGuideSessionId(project, returnedSessionId);
      if (role === 'dev') setLastDevSessionId(project, returnedSessionId);
    }

    // v0.14.16: when project is null (e.g. cmdRefine on _inbox, which v0.14.12
    // routed through this path with project=null to skip session bookkeeping),
    // we skipped upsertSession above — so no row exists in `sessions` for
    // returnedSessionId. recordCall would then insert into `calls` with a
    // session_id pointing at a non-existent sessions row, and the FK
    // constraint `FOREIGN KEY (session_id) REFERENCES sessions(session_id)`
    // (state.js:87) fires AFTER the successful Sonnet call had already
    // consumed tokens. v0.14.12's fix dodged the project FK on `sessions`
    // but not this transitive FK on `calls.session_id`. Gate session_id on
    // both project AND role — role is required for upsertSession, and without
    // an inserted sessions row (e.g. roleless discussion-engine calls) the FK
    // fires. Discussion sessions are tracked in disc_agents, not sessions.
    const recordSessionId = (project && role) ? returnedSessionId : null;

    recordCall({
      session_id: recordSessionId,
      project: project || null,
      phase: phase || null,
      task,
      model,
      duration_ms: duration,
      cost_usd: result.total_cost_usd,
      input_tokens: result.usage?.input_tokens,
      output_tokens: result.usage?.output_tokens,
      cache_read_tokens: result.usage?.cache_read_input_tokens,
      cache_creation_tokens: result.usage?.cache_creation_input_tokens,
      // v0.17 telemetry: the stream-json result event's turn count. This is
      // the calibration source for phases.turn_budget_by_complexity — tune
      // budgets from real per-tier turn distributions, never below p90.
      num_turns: Number.isFinite(result.num_turns) ? result.num_turns : null,
      // Phase 31: last assistant turn's per-request context size (see
      // lastTurnContextTokens in spawnClaude) — the calibration/telemetry
      // source for phases.handoff_when_context_tokens_exceed, and what
      // runGuide()'s compaction trigger thresholds on. null when no
      // assistant usage event was ever seen for this call.
      context_tokens: Number.isFinite(result.last_turn_context_tokens) ? result.last_turn_context_tokens : null,
      is_error: !!result.is_error,
      error_message: result.is_error ? String(result.result || '').slice(0, 500) : null,
      // v0.17 (OBS-2): the turn budget this call actually ran under, plus the
      // caller's routing decision (tier + human-readable reasoning trail) and
      // attempt/escalation bookkeeping — see the `routing` param doc above.
      max_turns: maxTurns,
      routing_tier: routing?.tier,
      routing_reason: routing?.reasoning?.join('\n'),
      attempt: routing?.attempt,
      escalated: routing?.escalated,
      logical_call_id: logicalCallId,
      subprocess_attempt: subprocessAttempt,
      context_manifest_id: cfg._context_compiler?.manifest_id,
      context_provider: cfg._context_compiler?.provider,
      context_mode: cfg._context_compiler?.mode,
      context_injected_tokens: cfg._context_compiler?.injected_tokens,
    });

    liveStatus.delete(liveKey);
    if (project) deleteLiveProgress(project); // Phase 59: no ghost row after success
    console.log(chalk.green(`✓ ${task} done in ${formatElapsedShared(Date.now() - overallStart)}`));
    return result;
  }

  // Should be unreachable, but just in case
  liveStatus.delete(liveKey);
  if (project) deleteLiveProgress(project); // Phase 59: mirror the ghost-row cleanup
  console.log(chalk.red(`✗ ${task} exhausted retries after ${formatElapsedShared(Date.now() - overallStart)}`));
  throw lastError || new Error('runClaude: exhausted retries with no error captured');
  } finally {
    // Belt-and-braces: if any path above threw without first deleting the
    // entry (e.g. enrichError throws inside throw enrichError), the entry
    // would persist as a ghost row in the live region. delete() is a no-op
    // if the key isn't present, so this is safe to call unconditionally.
    liveStatus.delete(liveKey);
    // Phase 59: same belt-and-braces for the live_progress row — if any path
    // above threw without deleting it, this guarantees no ghost row survives.
    // DELETE WHERE project=? on an absent row is a no-op, so unconditional.
    if (project) deleteLiveProgress(project);
    allowSleep();
  }
}

/**
 * Spawns claude as a subprocess and resolves with parsed JSON, or rejects on
 * non-zero exit / parse failure. Closes stdin to avoid the 3s warning.
 *
 * Registers the process under its worker-context jobId for per-job cancellation.
 */
function spawnClaude({ claudeBin, args, cwd, env, stdoutLog, stderrLog, meta = null, timeoutMs = null, idleTimeoutMs = null, toolHangTimeoutMs = null, turnStallTimeoutMs = null, liveKey = null, noSpinner = false, onStreamEvent = null }) {
  return new Promise((resolve, reject) => {
    let stdoutTail = '';
    let stderr = '';
    let timedOut = false;
    let stalledOut = false;
    let toolHungOut = null;   // { name, durationMs } when a tool call hangs
    let turnStalledOut = false;
    // Liveness clock for stall detection — bumped on every byte from the
    // subprocess (stdout OR stderr). Initialized at spawn so slow startup
    // (auth, model load) before the first stream event doesn't false-trigger.
    let lastActivityAt = Date.now();
    // Turn-level progress tracking — bumped when a user/tool_result or result
    // event arrives (i.e. Claude actually completed a turn).
    let lastTurnAt = Date.now();
    // Phase 31 — last-seen per-request usage from an assistant turn. NOT the
    // same signal as the final result event's `usage`, which is CUMULATIVE
    // across every API turn in a resumed session (thresholding on that would
    // fire on every single call). Overwritten (not summed) on each assistant
    // event, so this always reflects the MOST RECENT turn's context size —
    // the number that actually determines whether the next turn's prompt is
    // bloated. Stays null if no assistant event ever carried `message.usage`
    // (e.g. some fallback output modes).
    let lastTurnContextTokens = null;
    // Pending tool calls: toolUseId → { name, startTime }
    const pendingToolCalls = new Map();
    // Line buffer for incremental stream-json parsing
    let lineBuffer = '';

    const stdoutStream = fs.createWriteStream(stdoutLog);
    const stderrStream = fs.createWriteStream(stderrLog);

    const proc = spawn(claudeBin, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'], // ← key fix: stdin ignored, no 3s wait
      detached: true, // makes claude the process group leader so we can kill descendants
    });

    // Register for cancellation under THIS job's key. Do NOT clear the cancel
    // flag here — a cancel that arrived during the retry backoff sleep must
    // survive into this spawn so the close handler still classifies it cancelled.
    const jobKey = currentJobKey();
    trackProcess(jobKey, proc, meta);
    const numericJobId = Number(jobKey);
    if (Number.isInteger(numericJobId) && numericJobId > 0
        && isQueueJobCancellationRequested(numericJobId)) {
      _cancelRequested.add(jobKey);
    }

    // Phase 59 — live progress: feed every parsed stream event to a throttled
    // (>=3s) writer that UPSERTs this project's live_progress row (turn count vs
    // cap, current tool + elapsed, files touched, ETA). Best-effort: a
    // no-project spawn owns no row, and any construction/write failure degrades
    // to no telemetry — it must never fail the run. The row is DELETEd in
    // runClaude's cleanup/retry paths, so a completed/failed/retried spawn never
    // leaves a ghost. historicalAvgMs is one sync read at spawn time (not per
    // event), keeping the hot path free of extra sync work beyond the throttle.
    let progress = null;
    if (meta?.project) {
      try {
        progress = new ProgressTracker({
          project: meta.project,
          pid: proc.pid,
          task: meta.task,
          phase: Number.isFinite(meta.phase) ? meta.phase : null,
          model: meta.model ?? null,
          maxTurns: Number.isFinite(meta.maxTurns) ? meta.maxTurns : null,
          startedAt: Date.now(),
          historicalAvgMs: (meta.model && meta.task) ? avgCallDurationMs(meta.model, meta.task) : null,
          write: upsertLiveProgress,
        });
      } catch { progress = null; }
    }

    // If a cancel was already requested for this job before the subprocess
    // existed (e.g. it landed during retry backoff, or between claim and first
    // spawn), kill the just-spawned proc now rather than letting the retry burn
    // budget to completion before the close handler reports it cancelled.
    if (_cancelRequested.has(jobKey)) {
      // Positive pid → _groupKill negates internally → whole-group kill.
      try { _groupKill(proc.pid, 'SIGTERM'); } catch { /* setsid race — retry coming */ }
      setTimeout(() => {
        try { _groupKill(proc.pid, 'SIGTERM'); } catch { /* close handler will surface it */ }
      }, 100).unref?.();
      setTimeout(() => {
        try { _groupKill(proc.pid, 'SIGKILL'); } catch { /* already dead */ }
      }, 5000).unref?.();
    }

    // Cross-process cancellation: the web UI may not own the worker process
    // that owns this Claude child. Poll the durable job flag and translate it
    // into the same per-job group kill used by bot-local cancellation.
    let queueCancelTimer = null;
    if (Number.isInteger(numericJobId) && numericJobId > 0) {
      let cancellationSeen = false;
      queueCancelTimer = setInterval(() => {
        if (cancellationSeen || !isQueueJobCancellationRequested(numericJobId)) return;
        cancellationSeen = true;
        _cancelRequested.add(jobKey);
        try { _groupKill(proc.pid, 'SIGTERM'); } catch { /* setsid race */ }
        setTimeout(() => { try { _groupKill(proc.pid, 'SIGTERM'); } catch {} }, 100).unref?.();
        setTimeout(() => { try { _groupKill(proc.pid, 'SIGKILL'); } catch {} }, 5000).unref?.();
      }, 1000);
      queueCancelTimer.unref?.();
    }

    // Wall-clock timeout: kill the subprocess if it runs too long. This catches
    // hanging integration tests or infinite loops inside the dev agent's Bash
    // calls that would otherwise block the orchestrator forever.
    // Pass the POSITIVE pid so _groupKill reaps the whole process group (bash-
    // spawned grandchildren — test runners, tsc, git — included), preventing
    // orphans that hold workspace locks across the retry.
    let killTimer = null;
    if (timeoutMs != null && timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        try { _groupKill(proc.pid, 'SIGTERM'); } catch { /* setsid race — retry coming */ }
        setTimeout(() => {
          try { _groupKill(proc.pid, 'SIGTERM'); } catch { /* already dead */ }
        }, 100).unref?.();
        setTimeout(() => {
          try { _groupKill(proc.pid, 'SIGKILL'); } catch { /* already dead */ }
        }, 5000).unref?.();
      }, timeoutMs);
      killTimer.unref?.();
    }

    // Idle/stall watchdog: poll the liveness clock; if the subprocess has
    // emitted nothing for idleTimeoutMs, it's stuck (hung test, infinite loop,
    // deadlocked tool call). Kill the whole group — far faster than the
    // wall-clock ceiling. Poll cadence is idleTimeout/10 (bounded 5–30s) so we
    // notice promptly without busy-looping. Routes through _groupKill (positive
    // pid) like every other kill path, so it is uniform and interceptable via
    // __testHooks.setGroupKill — previously it called process.kill(-proc.pid)
    // directly, the only path that happened to group-kill correctly.
    let idleTimer = null;
    if (idleTimeoutMs != null && idleTimeoutMs > 0) {
      const pollMs = Math.min(30_000, Math.max(5_000, Math.floor(idleTimeoutMs / 10)));
      idleTimer = setInterval(() => {
        if (Date.now() - lastActivityAt < idleTimeoutMs) return;
        stalledOut = true;
        try { _groupKill(proc.pid, 'SIGTERM'); } catch { /* close handler will surface it */ }
        setTimeout(() => {
          try { _groupKill(proc.pid, 'SIGKILL'); } catch { /* already dead */ }
        }, 5000).unref?.();
      }, pollMs);
      idleTimer.unref?.();
    }

    // Smart health watchdog — parses turn-level and tool-call-level signals
    // from the stream to catch hangs the idle timeout can't detect (e.g. Claude
    // actively streaming a 100k response, or a bash tool call that never returns).
    let smartHealthTimer = null;
    const hasSmartTimeout = (toolHangTimeoutMs != null && toolHangTimeoutMs > 0)
      || (turnStallTimeoutMs != null && turnStallTimeoutMs > 0);
    if (hasSmartTimeout) {
      const minActive = [toolHangTimeoutMs, turnStallTimeoutMs].filter((v) => v != null && v > 0);
      const pollMs = Math.min(30_000, Math.max(5_000, Math.floor(Math.min(...minActive) / 10)));
      smartHealthTimer = setInterval(() => {
        const now = Date.now();

        // Tool-call hang: tool_use fired but tool_result never came back.
        if (toolHangTimeoutMs != null && toolHangTimeoutMs > 0) {
          for (const [, info] of pendingToolCalls) {
            if (now - info.startTime > toolHangTimeoutMs) {
              toolHungOut = { name: info.name, durationMs: now - info.startTime };
              try { _groupKill(proc.pid, 'SIGTERM'); } catch { /* close handler surfaces it */ }
              setTimeout(() => { try { _groupKill(proc.pid, 'SIGKILL'); } catch {} }, 5000).unref?.();
              return;
            }
          }
        }

        // Turn stall: no turn boundary (user/result event) for too long —
        // Claude is either generating one infinite response or a tool result
        // silently vanished.
        if (turnStallTimeoutMs != null && turnStallTimeoutMs > 0
            && now - lastTurnAt > turnStallTimeoutMs) {
          turnStalledOut = true;
          try { _groupKill(proc.pid, 'SIGTERM'); } catch { /* close handler surfaces it */ }
          setTimeout(() => { try { _groupKill(proc.pid, 'SIGKILL'); } catch {} }, 5000).unref?.();
          return;
        }

        // Update live-status hint so the terminal shows what Claude is doing.
        if (!noSpinner && liveKey) {
          let hint;
          if (pendingToolCalls.size > 0) {
            const [, info] = [...pendingToolCalls][0];
            hint = `${info.name}:running(${formatElapsedShared(now - info.startTime)})`;
          } else {
            const sinceLastTurn = now - lastTurnAt;
            hint = sinceLastTurn > 10_000 ? `generating(${formatElapsedShared(sinceLastTurn)})` : null;
          }
          liveStatus.update(liveKey, { hint });
        }
      }, pollMs);
      smartHealthTimer.unref?.();
    }

    proc.stdout.on('data', (d) => {
      lastActivityAt = Date.now();
      const chunk = d.toString();
      // Bounded tail: keep the last 512KB in memory (result line is always near
      // the end). Full stream is still written to disk via stdoutStream.write.
      stdoutTail += chunk;
      if (stdoutTail.length > 768_000) stdoutTail = stdoutTail.slice(stdoutTail.length - 512_000);
      stdoutStream.write(d);

      // Incrementally parse stream-json events for smart health detection.
      // We maintain a line buffer because data chunks don't align to lines.
      lineBuffer += chunk;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop(); // last element is incomplete
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let ev;
        try { ev = JSON.parse(trimmed); } catch { continue; }
        if (!ev || typeof ev.type !== 'string') continue;

        if (ev.type === 'assistant') {
          const content = ev.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block?.type === 'tool_use' && block.id) {
                pendingToolCalls.set(block.id, { name: block.name || 'tool', startTime: Date.now() });
              }
            }
          }
          // Phase 31: track the LAST assistant turn's per-request usage (see
          // lastTurnContextTokens declaration above for why this must not be
          // summed across turns).
          const turnUsage = ev.message?.usage;
          if (turnUsage) {
            lastTurnContextTokens = (turnUsage.input_tokens || 0)
              + (turnUsage.cache_read_input_tokens || 0)
              + (turnUsage.cache_creation_input_tokens || 0);
          }
        } else if (ev.type === 'user') {
          const content = ev.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block?.type === 'tool_result' && block.tool_use_id) {
                pendingToolCalls.delete(block.tool_use_id);
              }
            }
          }
          lastTurnAt = Date.now();
        } else if (ev.type === 'result') {
          pendingToolCalls.clear();
          lastTurnAt = Date.now();
        }
        // Phase 59: feed the same parsed event to the live-progress tracker.
        // The tracker owns its own >=3s throttle, so this adds no unthrottled
        // sync write on the hot path; onEvent never throws by construction.
        if (progress) {
          try { progress.onEvent(ev); } catch { /* live telemetry is best-effort */ }
        }
        if (onStreamEvent) {
          try { onStreamEvent(ev); } catch { /* never let a callback crash the runner */ }
        }
      }
    });
    proc.stderr.on('data', (d) => {
      lastActivityAt = Date.now();
      stderr += d.toString();
      stderrStream.write(d);
    });

    proc.on('error', (err) => {
      clearTimeout(killTimer);
      clearInterval(idleTimer);
      clearInterval(smartHealthTimer);
      clearInterval(queueCancelTimer);
      untrackProcess(jobKey);
      stdoutStream.end();
      stderrStream.end();
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    proc.on('close', (code, signal) => {
      clearTimeout(killTimer);
      clearInterval(idleTimer);
      clearInterval(smartHealthTimer);
      clearInterval(queueCancelTimer);
      untrackProcess(jobKey);
      stdoutStream.end();
      stderrStream.end();

      // Tool-call hang: a bash/tool call inside Claude never returned.
      // TRANSIENT — the next attempt may use a different path or avoid the hang.
      if (toolHungOut) {
        const mins = Math.round(toolHangTimeoutMs / 60000);
        return reject(new Error(`tool call hung for ${mins}m (tool: ${toolHungOut.name}, signal: ${signal || 'unknown'}). Subprocess killed. A bash command or tool call inside the dev agent did not return — likely an interactive prompt, infinite loop, or missing timeout.`));
      }

      // Turn stall: Claude generated output continuously but never completed a
      // turn. TRANSIENT — retry may produce a more focused response.
      if (turnStalledOut) {
        const mins = Math.round(turnStallTimeoutMs / 60000);
        return reject(new Error(`turn stalled — no completion for ${mins}m (signal: ${signal || 'unknown'}). Subprocess killed. Claude generated output but did not finish a turn — possibly an excessively long response or a missing tool_result event.`));
      }

      // Stall takes priority over wall-clock: if both somehow fire, the stall is
      // the more specific cause. Message intentionally matches a TRANSIENT
      // pattern so the call is retried (a different path may not hang).
      if (stalledOut) {
        const mins = Math.round(idleTimeoutMs / 60000);
        return reject(new Error(`claude subprocess stalled — no output for ${mins}m (signal: ${signal || 'unknown'}). Subprocess group killed. Likely a hung test, infinite loop, or a long-running command started without a timeout.`));
      }

      if (timedOut) {
        const mins = Math.round(timeoutMs / 60000);
        return reject(new Error(`claude subprocess timed out after ${mins}m (signal: ${signal || 'unknown'}). Subprocess killed. Check for hanging tests or infinite loops in the dev agent.`));
      }

      // Lease-loss kill takes priority over the generic cancel classification.
      // Its message intentionally matches a TRANSIENT pattern (see
      // transient-errors.js) so the job re-queues for a fresh lease instead of
      // being terminalised as a manual cancellation.
      if (_leaseLostJobs.has(jobKey)) {
        _leaseLostJobs.delete(jobKey);
        _cancelRequested.delete(jobKey);
        return reject(new Error(`provider heavy-call lease lost — slot reclaimed mid-call (signal: ${signal || 'unknown'}); retrying for a fresh lease`));
      }

      // Per-job cancel check (was a shared global, which mis-cancelled siblings).
      if (_cancelRequested.has(jobKey) || signal === 'SIGTERM' || signal === 'SIGKILL') {
        _cancelRequested.delete(jobKey);
        return reject(new Error(`claude subprocess cancelled (signal: ${signal || 'unknown'})`));
      }

      if (code !== 0) {
        // Claude can emit a complete structured error result before exiting 1
        // (error_max_turns, provider five-hour/weekly usage limit, etc.). Parse
        // and resolve every such result so its session_id survives. Downstream
        // routing can then distinguish a resumable turn cap from an account
        // pause and automatically resume the exact session after reset. An
        // opaque rejection here discarded that durable continuation handle.
        try {
          const parsed = parseStreamJson(stdoutTail);
          if (parsed && (parsed.is_error || String(parsed.subtype || '').startsWith('error'))) {
            if (!parsed.is_error) parsed.is_error = true;
            if (!parsed.result) parsed.result = `Ended with subtype: ${parsed.subtype}`;
            parsed.last_turn_context_tokens = lastTurnContextTokens;
            return resolve(parsed);
          }
        } catch { /* not parseable — fall through to normal rejection */ }

        const summary = (stderr || stdoutTail).trim().split('\n').slice(-3).join('\n');
        return reject(new Error(`claude exited ${code}: ${summary || '(no output)'}`));
      }

      // Some stderr warnings are harmless ("no stdin data received") — log
      // but don't block parse.
      if (!stdoutTail.trim()) {
        return reject(new Error(`claude exited 0 but stdout was empty. stderr: ${stderr.trim().slice(0, 200)}`));
      }

      try {
        const parsed = parseStreamJson(stdoutTail);
        parsed.last_turn_context_tokens = lastTurnContextTokens;
        resolve(parsed);
      } catch (err) {
        reject(new Error(`Failed to parse stream-json output: ${err.message}\nFull stdout saved to: ${stdoutLog}`));
      }
    });
  });
}

/**
 * Parse `--output-format stream-json` output. Each stdout line is one JSON
 * message (system/init, assistant, user/tool-result, …) and the FINAL
 * {"type":"result",...} line carries the fields the old single-object `json`
 * format put at top level (session_id, total_cost_usd, usage, result, is_error,
 * subtype). We walk from the end so we grab the result line even if trailing
 * output follows it, and return that object verbatim — so every downstream
 * consumer of runClaude()'s return value keeps working unchanged.
 *
 * Throws if no result line exists. By the time we parse, kill paths (stall /
 * wall-clock / cancel) have already been handled, so a missing result line is a
 * genuine anomaly (truncated/garbled stream) and should fail the call.
 */
function parseStreamJson(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error('stream produced no output lines');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let obj;
    try { obj = tolerantJsonParse(lines[i]); } catch { continue; }
    if (obj && obj.type === 'result') return obj;
  }
  // No result message — surface a short tail so the log shows what we did get.
  const tail = lines.slice(-3).join(' | ').slice(0, 300);
  throw new Error(`no {"type":"result"} message in stream output. Last lines: ${tail}`);
}

/**
 * Some Claude Code versions occasionally emit a single JSON object followed by
 * whitespace or stray text. Try strict parse first, then extract the first
 * top-level {...} block.
 */
function tolerantJsonParse(text) {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }

  // Find first { ... } at top level. Walk braces.
  const start = trimmed.indexOf('{');
  if (start < 0) throw new Error('no JSON object found');
  let depth = 0;
  for (let i = start; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const slice = trimmed.slice(start, i + 1);
        return JSON.parse(slice);
      }
    }
  }
  throw new Error('unterminated JSON');
}

function enrichError(err, { stdoutLog, stderrLog, attempt }) {
  const hint = inferHint(err.message);
  const msg = [
    err.message,
    '',
    `Attempts: ${attempt + 1}`,
    `Logs:`,
    `  stdout: ${stdoutLog}`,
    `  stderr: ${stderrLog}`,
    hint ? `\nHint: ${hint}` : '',
  ].filter(Boolean).join('\n');
  const wrapped = new Error(msg);
  wrapped.cause = err;
  wrapped.stdoutLog = stdoutLog;
  wrapped.stderrLog = stderrLog;
  return wrapped;
}

function inferHint(msg) {
  // v0.14.10: Order matters — more specific patterns first. The previous
  // version's `/permission/i || /denied/i` test fired on the
  // `"permission_denials":[]` JSON field name the Claude CLI ALWAYS emits,
  // turning every CLI failure into a misleading "permission denied" hint.

  // error_max_turns: must come before generic login/auth check because the raw
  // JSON in the error message can contain substrings that trigger those patterns.
  if (/error_max_turns/i.test(msg) || /reached maximum number of turns/i.test(msg)) {
    return 'The dev agent exhausted the turn budget (max_turns_per_phase). '
         + 'The phase will be auto-retried and Claude will resume from where it stopped. '
         + 'If this phase consistently hits the limit, increase max_turns_per_phase in config.';
  }

  if (/tool call hung for \d+m/i.test(msg)) {
    return 'A bash/tool call inside the dev agent did not return within tool_hang_timeout_ms. '
         + 'The command is likely interactive, has an infinite loop, or is waiting for user input. '
         + 'Add an explicit timeout to long-running bash commands in the dev prompt, or increase tool_hang_timeout_ms.';
  }

  if (/turn stalled — no completion for \d+m/i.test(msg)) {
    return 'Claude generated output continuously but did not complete a turn within turn_stall_timeout_ms. '
         + 'The model may be generating an excessively long response. '
         + 'The next retry may produce a more focused result. Increase turn_stall_timeout_ms if the task legitimately needs long generation.';
  }

  if (/timed out after \d+m/i.test(msg)) {
    return 'The subprocess hit the wall-clock limit (subprocess_timeout_ms). '
         + 'The dev agent likely ran a Bash command that hung (e.g. an integration test with no teardown). '
         + 'Increase subprocess_timeout_ms in config or add explicit connection teardown to the hanging test.';
  }

  // Transient network — happens when the API socket drops mid-stream.
  // We only see this hint AFTER retries exhaust (claude-runner classifies
  // these as transient and retries up to maxAttempts).
  if (/socket.*closed/i.test(msg)
      || /connection.*closed/i.test(msg)
      || /socket hang up/i.test(msg)
      || /ECONNRESET/.test(msg)) {
    return 'Transient network error — the API connection dropped mid-stream. '
         + 'Already retried up to maxAttempts. If this keeps happening, check '
         + 'local network or wait a few minutes and retry the job.';
  }

  // Actual permission errors. Cover (a) OS-level EACCES from fs writes,
  // (b) plain English "permission denied" from Claude CLI tool wrappers,
  // (c) a non-empty permission_denials JSON array — the field is always
  // present; only a non-empty one means a tool actually got denied.
  if (/\bpermission denied\b/i.test(msg)
      || /\bEACCES\b/.test(msg)
      || /\boperation not permitted\b/i.test(msg)
      || /"permission_denials":\s*\[\s*\{/i.test(msg)) {
    return 'Permission denied. Check .claude/settings.json — workspace tools may be too restrictive for the path Claude is writing to.';
  }
  if (/exit (?:1|2)/.test(msg) && /no stdin/i.test(msg)) {
    return 'Old stdin-warning issue. Run "npm run migrate" then retry — claude-runner.js should be patched to use stdio:ignore for stdin.';
  }
  if (/ANTHROPIC_API_KEY/.test(msg)) {
    return 'API key conflict. Run: unset ANTHROPIC_API_KEY (and remove from ~/.zshrc).';
  }
  if (/thinking.*blocks.*cannot be modified|redacted_thinking.*cannot be modified/i.test(msg)) {
    return 'The resumed session had thinking/redacted_thinking blocks that the API rejected (400). '
         + 'The session was automatically cleared and retried fresh. '
         + 'If this keeps recurring, the session may be corrupted beyond recovery — check the guide_session_id in the DB.';
  }
  if (/no JSON|unterminated|parse/i.test(msg)) {
    return 'Claude output was not valid JSON. Check the stdout log — it may have hit a tool budget, oauth flow, or context limit.';
  }
  if (/login|auth|oauth/i.test(msg)) {
    return 'OAuth issue. Run: claude /logout && claude /login (decline API credit offers).';
  }
  if (/rate.?limit|429/i.test(msg)) {
    return 'Rate limited. Wait for the 5-hour window to roll over, or check claude.ai for usage.';
  }
  return null;
}
