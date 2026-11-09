// unattended-retry — shared retry-on-transient-error loop for driving an
// orchestrator run to completion without a human/agent manually re-issuing
// `resume` after a rate-limit or budget pause.
//
// Used by scripts/brief-chain.mjs (queue mode: reset-brief per queued file)
// and scripts/launch-with-retry.mjs (single-project mode: go --unattended).
// Both need the exact same "wait for the window to reset, then resume"
// behavior — this module is the one place that logic lives.

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { isTransientError as canonicalIsTransientError, isProviderRateLimitError } from './transient-errors.js';

// Transient Claude API error patterns — rate limit / overload / network.
// 'rate_limit_event' and 'five_hour' match the real Anthropic Max-plan
// session-limit payload shape (distinct from the orchestrator's own
// internal cost/call billing-guard pauses, which are not transient).
// DEPRECATED: kept only for external readers — isTransientError below now
// delegates to lib/transient-errors.js (the canonical classifier, which also
// carries the NON_TRANSIENT guard this local copy never had: without it a
// validator-gate failure mentioning "network" would loop wait-and-resume).
export const TRANSIENT_RE = /rate.?limit|session.?limit|usage.?limit|weekly.{0,24}(?:usage|rate|token|message)?.{0,12}limit|(?:usage|rate|token|message).{0,24}weekly.{0,12}limit|provider circuit (?:breaker )?open|heavy-call lease lost|overload|too many requests|\b429\b|\b529\b|(?:http|status|code|error)[ :]{0,3}5\d\d\b|service.?unavailable|temporarily unavailable|billing window|quota.{0,20}exceeded|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|network error|socket hang.?up|rate_limit_event|five_hour/i;

export function isTransientError(text) {
  if (!text) return false;
  return canonicalIsTransientError(text) || isProviderRateLimitError(text);
}

/** Extract the Unix timestamp from a rate-limit event's resetsAt field. */
export function extractResetsAt(text) {
  if (!text) return null;
  const m = String(text).match(/"resetsAt"\s*:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Parse Claude's plain-text "resets 6pm (Asia/Calcutta)" fallback. */
export function extractHumanResetAt(text, { nowMs = Date.now() } = {}) {
  if (!text) return null;
  const match = String(text).match(/\bresets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!match) return null;

  let hour = Number(match[1]) % 12;
  if (match[3].toLowerCase() === 'pm') hour += 12;
  const minute = Number(match[2] || 0);

  const dateParts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Calcutta',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(nowMs))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );

  // Asia/Calcutta is fixed UTC+05:30 (no DST).
  let candidate = Date.UTC(
    dateParts.year,
    dateParts.month - 1,
    dateParts.day,
    hour - 5,
    minute - 30,
  );
  if (candidate <= nowMs) candidate += 24 * 60 * 60 * 1000;
  return candidate;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function getDb(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

export function getLastRun(project, dbPath) {
  try {
    const db = getDb(dbPath);
    const row = db.prepare(
      `SELECT * FROM auto_runs WHERE project = ? ORDER BY started_at DESC LIMIT 1`,
    ).get(project);
    db.close();
    return row ?? null;
  } catch { return null; }
}

export function getProjectStatus(project, dbPath) {
  try {
    const db = getDb(dbPath);
    const row = db.prepare('SELECT status FROM projects WHERE name = ?').get(project);
    db.close();
    return row?.status ?? null;
  } catch { return null; }
}

/** Mark a recoverable stop honestly while the wrapper waits for capacity. */
export function markProjectWaitingForResume(project, dbPath, log = () => {}) {
  try {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    const changed = db.prepare(
      "UPDATE projects SET status='paused' WHERE name=? AND status='in-progress'",
    ).run(project).changes;
    db.close();
    if (changed) log(`Project "${project}" is waiting for automatic resume (in-progress → paused)`);
    return changed > 0;
  } catch (e) {
    log(`Could not mark project waiting: ${e.message}`);
    return false;
  }
}

/** Flip the waiting state back only when a resume process is about to run. */
export function markProjectResuming(project, dbPath, log = () => {}) {
  try {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    const changed = db.prepare(
      "UPDATE projects SET status='in-progress' WHERE name=? AND status='paused'",
    ).run(project).changes;
    db.close();
    if (changed) log(`Resuming project "${project}" (paused → in-progress)`);
    return changed > 0;
  } catch (e) {
    log(`Could not mark project resuming: ${e.message}`);
    return false;
  }
}

// Backward-compatible export for older launch scripts. Its semantics are now
// safe: it marks a wait, never fabricates a ready-for-qa completion state.
export const resetProjectStatus = markProjectWaitingForResume;

/**
 * Classify the outcome of a completed orchestrator run:
 *   'success'   — all phases done (or checkpoint reached, unattended skips it)
 *   'transient' — Claude threw a rate-limit/API error; wait and resume
 *   'abort'     — hard failure or a decision only a human can make
 */
export function classifyLastRun(project, dbPath, log = () => {}) {
  const status = getProjectStatus(project, dbPath);
  const run = getLastRun(project, dbPath);
  const kind = run?.pause_kind ?? '';
  const reason = run?.pause_reason ?? '';

  log(`  project status : ${status}`);
  log(`  pause_kind     : ${kind || '(none)'}`);
  log(`  pause_reason   : ${reason || '(none)'}`);

  // The latest run outcome is authoritative over the project status. A run can
  // fail before planning creates any phases while the project still carries
  // ready-for-qa from the previous brief. Checking that stale status first
  // falsely marks the new brief complete and lets brief-chain archive it.
  if (kind === 'budget' || kind === 'window-headroom') return 'transient';
  if (isTransientError(reason)) return 'transient';

  if (status === 'ready-for-qa' || status === 'completed') return 'success';
  if (kind === 'all-phases-complete') return 'success';
  if (kind === 'fix-round-complete') return 'success';
  if (kind === 'review-checkpoint') return 'success'; // unattended skipped it

  return 'abort';
}

const POLL_INTERVAL_MS = 5 * 60 * 1000; // check every 5 min

/**
 * Return the next safe retry time for a provider-limited run. Prefer the
 * provider's authoritative `resetsAt`; when it is absent, use the configured
 * cooldown rather than immediately issuing another call that is likely to
 * fail. `nowMs` keeps the fallback deterministic in tests.
 */
export function getRateLimitRetryAt(pauseReason, { retryWaitMinutes = 30, nowMs = Date.now() } = {}) {
  const resetsAt = extractResetsAt(pauseReason);
  if (resetsAt) return resetsAt * 1000;

  const humanResetAt = extractHumanResetAt(pauseReason, { nowMs });
  if (humanResetAt) return humanResetAt;

  const minutes = Math.max(1, Number(retryWaitMinutes) || 30);
  return nowMs + (minutes * 60 * 1000);
}

/** Poll until the rate-limit window has reset, then return. */
export async function waitForRateLimitReset(pauseReason, {
  log = () => {},
  retryWaitMinutes = 30,
  now = () => Date.now(),
  sleepFn = sleep,
  pollIntervalMs = POLL_INTERVAL_MS,
} = {}) {
  const resetsAt = extractResetsAt(pauseReason);
  const humanResetAt = extractHumanResetAt(pauseReason, { nowMs: now() });
  const retryAtMs = getRateLimitRetryAt(pauseReason, { retryWaitMinutes, nowMs: now() });
  const resetStr = new Date(retryAtMs).toLocaleTimeString('en-IN', { timeZone: 'Asia/Calcutta' });

  log(`Rate limit hit — ${resetsAt || humanResetAt ? 'window resets' : 'no reset timestamp; retrying'} at ${resetStr}. Polling every 5min…`);

  for (;;) {
    const remainingMs = retryAtMs - now();
    if (remainingMs <= 0) {
      log(`Rate limit window has reset. Retrying…`);
      return;
    }
    log(`  Rate limit: ${Math.ceil(remainingMs / 60000)}min remaining (resets ${resetStr})…`);
    await sleepFn(Math.min(pollIntervalMs, remainingMs));
  }
}

/** Run one orchestrator command synchronously (blocks — caller must run this off the main event loop, e.g. in a spawned/detached process, never inline in a request handler). */
function runOrchestrator(orchestratorPath, args, log) {
  log(`→ node src/orchestrator.js ${args.join(' ')}`);
  const r = spawnSync(process.execPath, [orchestratorPath, ...args], {
    stdio: 'inherit',
    timeout: 6 * 60 * 60 * 1000, // 6 h hard ceiling
  });
  return r.status ?? 1;
}

/**
 * Drive one orchestrator run to completion, transparently waiting out and
 * resuming through transient rate-limit/budget pauses. Returns true on
 * success, false on a hard failure or a pause that needs a human decision.
 *
 * NOTE: this blocks synchronously (spawnSync under the hood) for as long as
 * it takes — potentially hours. Only call it from a standalone script /
 * detached child process, never from inside an Express request handler.
 *
 * @param {string} orchestratorPath - absolute path to src/orchestrator.js
 * @param {string} dbPath - absolute path to state/orchestrator.db
 * @param {string} project
 * @param {string[]} initialArgs - e.g. ['go', '--unattended', project]
 * @param {string[]} resumeArgs - e.g. ['resume', project, '--unattended']
 * @param {{log?: Function, err?: Function, retryWaitMinutes?: number}} [opts]
 */
export async function runOrchestratorWithRetry(orchestratorPath, dbPath, project, initialArgs, resumeArgs, opts = {}) {
  const log = opts.log ?? (() => {});
  const err = opts.err ?? (() => {});
  const retryWaitMinutes = opts.retryWaitMinutes ?? 30;
  const runOrchestratorFn = opts.runOrchestrator ?? runOrchestrator;
  const getLastRunFn = opts.getLastRun ?? getLastRun;
  const classifyLastRunFn = opts.classifyLastRun ?? classifyLastRun;
  const markProjectWaitingFn = opts.markProjectWaitingForResume
    ?? opts.resetProjectStatus
    ?? markProjectWaitingForResume;
  const markProjectResumingFn = opts.markProjectResuming ?? markProjectResuming;
  const waitForRateLimitResetFn = opts.waitForRateLimitReset ?? waitForRateLimitReset;

  // reset-brief is destructive to the current plan state. It is allowed ONCE;
  // every transient failure afterwards resumes the already-created run. The
  // old nested loop broke back to initialArgs after a failed resume, resetting
  // and replanning the same queue item from scratch.
  let commandArgs = initialArgs;
  for (;;) {
    const code = runOrchestratorFn(orchestratorPath, commandArgs, log);

    if (code !== 0) {
      const run = getLastRunFn(project, dbPath);
      const pauseReason = run?.pause_reason ?? '';
      if (isTransientError(pauseReason)) {
        markProjectWaitingFn(project, dbPath, log);
        await waitForRateLimitResetFn(pauseReason, { log, retryWaitMinutes });
        markProjectResumingFn(project, dbPath, log);
        commandArgs = resumeArgs;
        continue;
      }
      err(`orchestrator command crashed (exit ${code}): ${commandArgs.join(' ')}`);
      return false;
    }

    const result = classifyLastRunFn(project, dbPath, log);
    if (result === 'success') return true;

    if (result === 'transient') {
      const run = getLastRunFn(project, dbPath);
      markProjectWaitingFn(project, dbPath, log);
      await waitForRateLimitResetFn(run?.pause_reason ?? '', { log, retryWaitMinutes });
      log(`Resuming "${project}" after rate limit reset…`);
      markProjectResumingFn(project, dbPath, log);
      commandArgs = resumeArgs;
      continue;
    }

    // 'abort' — hard failure or a decision only a human can make
    const run = getLastRunFn(project, dbPath);
    err(`Run failed for "${project}"`);
    err(`  pause_reason: ${(run?.pause_reason ?? 'unknown').slice(0, 200)}`);
    return false;
  }
}
