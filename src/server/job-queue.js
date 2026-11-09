// Job Queue — SQLite-backed FIFO for Telegram-initiated jobs.
//
// Tables (created via migrate.js v0.5):
//   tg_users:  telegram_user_id, telegram_handle, allowlisted_at, label
//   tg_jobs:   id, project, action, args_json, requested_by, requested_at,
//              started_at, ended_at, status, result_summary, error_message,
//              worker_pid, lease_expires_at, recovery_count
//
// status: pending | running | completed | failed | cancelled

import { randomUUID } from 'node:crypto';
import { getDb, pidAlive, queueNotify } from '../state.js';
import { windowStatus } from '../billing-guard.js';

// Queue jobs run in-process in the bot server. A renewable lease makes a
// `running` row self-describing across server restarts and protects a second
// server instance from reclaiming work still owned by a healthy first one.
export const JOB_LEASE_MS = 5 * 60 * 1000;
export const JOB_HEARTBEAT_MS = 30 * 1000;

// The worker dispatch switch is the authoritative implementation surface.
// Exporting the same vocabulary lets HTTP callers reject arbitrary action
// strings before they ever reach the durable queue.
export const QUEUE_ACTIONS = Object.freeze([
  'go', 'resume', 'suggestions', 'brief-chain', 'audit', 'bugs', 'pipeline', 'roadmap',
  'retro', 'brief', 'next-brief', 'guide', 'next', 'review', 'handoff',
  'qa', 'qa-handoff', 'package', 'validate', 'reset-brief', 'retry-phase', 'sync', 'ship', 'discuss', 'eval',
]);
export const QUEUE_ACTION_SET = new Set(QUEUE_ACTIONS);

// These actions can perform an irreversible/external side effect just before
// a worker dies. Retrying them automatically would risk duplicating that side
// effect, so the generic retry control fails closed.
export const NON_RETRYABLE_ACTIONS = new Set(['ship', 'package', 'reset-brief', 'retry-phase', 'discuss']);

// These handlers do not run their work through claude-runner's supervised
// process registry and therefore cannot be interrupted safely once dispatch
// starts.  A durable cancel flag would only make the ledger say "cancelled"
// after the filesystem/git/external side effect had already completed.  Keep
// the operator contract honest: callers may dequeue them while pending, but a
// running row must be allowed to finish and inspected normally.
export const NON_CANCELLABLE_ACTIONS = new Set([
  'qa', 'qa-handoff', 'package', 'validate', 'reset-brief', 'retry-phase',
  'sync', 'ship', 'eval',
]);

export function jobCancellationCapability(jobOrAction) {
  const action = typeof jobOrAction === 'string' ? jobOrAction : jobOrAction?.action;
  if (!action) return { cancellable: false, reason: 'Job action is unknown' };
  if (NON_CANCELLABLE_ACTIONS.has(action)) {
    return {
      cancellable: false,
      reason: `Action '${action}' cannot be stopped safely after it starts`,
    };
  }
  return { cancellable: true, reason: null };
}

function leaseExpiry(nowMs = Date.now(), leaseMs = JOB_LEASE_MS) {
  return new Date(nowMs + Math.max(1_000, Number(leaseMs) || JOB_LEASE_MS)).toISOString();
}

// ─── Phase 79 (P2) — window-aware job cost classes ───────────────────────────
//
// Every queue action is either HEAVY (makes any provider/model call) or CHEAP
// (deterministic local work only). A short guide call still consumes Max-plan
// admission and can replay a large context, so it must never bypass the warn
// gate merely because its expected output is small.
// At a 'warn' billing window the picker admits only cheap jobs and defers heavy
// ones to the projected reset (see nextPendingJobForFreeProject). This map is
// STATIC + keyed by action; an operator overrides individual actions via
// billing.job_cost_class (config) which flows in as the `overrides` arg below.
//
// Composition note: this is a QUEUE-admission cost filter only. Brief 05
// fair-share (src/claude-runner.js admitFairShare / src/billing-guard.js
// fairShareStatus) remains the SPAWN-time weighted-share yield — a separate
// layer this deliberately does NOT duplicate. The picker selects the FIFO
// candidate (the same selection fair-share admission later gates), and the
// cost-class filter is applied to that candidate; neither reimplements the other.
export const JOB_COST_CLASS = {
  // HEAVY — spawns a dev/guide run that consumes many window calls.
  go: 'heavy',
  resume: 'heavy',
  suggestions: 'heavy',
  audit: 'heavy',
  bugs: 'heavy',
  pipeline: 'heavy',
  roadmap: 'heavy',
  brief: 'heavy',
  'brief-chain': 'heavy',
  'next-brief': 'heavy',
  next: 'heavy',
  discuss: 'heavy',
  review: 'heavy',
  handoff: 'heavy',
  'qa-handoff': 'heavy',
  guide: 'heavy',
  'context-refresh': 'heavy',
  retro: 'heavy',
  eval: 'heavy',
  // CHEAP — deterministic local work with no Claude/provider call.
  validate: 'cheap',
  qa: 'cheap',
  package: 'cheap',
  'reset-brief': 'cheap',
  'retry-phase': 'cheap',
  ship: 'cheap',
  sync: 'cheap',
};

/**
 * Classify a job action as 'heavy' or 'cheap'. An operator override
 * (billing.job_cost_class, passed as `overrides`) wins outright; an unknown
 * action falls back to 'heavy' — the billing-safe default (an unrecognised
 * action is deferred at warn rather than racing the pause threshold).
 * @param {string} action
 * @param {Object|null} [overrides] - billing.job_cost_class, action → class
 * @returns {'heavy'|'cheap'}
 */
export function jobCostClass(action, overrides = null) {
  if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
    const o = overrides[action];
    if (o === 'heavy' || o === 'cheap') return o;
  }
  return JOB_COST_CLASS[action] === 'cheap' ? 'cheap' : 'heavy';
}

// SQLite datetime literal ('YYYY-MM-DD HH:MM:SS', UTC) — the exact format
// enqueueRetryJob writes not_before in, and the format datetime('now') compares
// against in the picker filter. Keep the two byte-identical.
function toSqliteDatetime(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function fromPersistedDatetime(value) {
  if (!value) return null;
  const raw = String(value);
  return new Date(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`);
}

/**
 * Phase 79 (P2) — resolve the per-tick window gate the picker consumes. Called
 * ONCE per pick tick (in each server's pickAndClaim) so windowStatus runs once,
 * not per candidate. windowStatus reads the LIVE call count each call; the
 * billing thresholds come from the already-resolved server cfg. projectedReset
 * is when the oldest in-window call ages out (oldestCallAt + window_reset_hours),
 * the not_before a deferred heavy job is stamped with.
 * @param {Object} cfg - a resolved config (reads billing.*)
 * @returns {{windowState: object, projectedReset: Date, costClass: Object|null}}
 */
export function windowGate(cfg) {
  const windowState = windowStatus(cfg);
  const hours = cfg?.billing?.window_reset_hours || 5;
  const base = windowState.oldestCallAt ? new Date(windowState.oldestCallAt).getTime() : Date.now();
  const projectedReset = new Date(base + hours * 3600 * 1000);
  const jcc = cfg?.billing?.job_cost_class;
  const costClass = (jcc && typeof jcc === 'object' && !Array.isArray(jcc)) ? jcc : null;
  return { windowState, projectedReset, costClass };
}

// ─── Users (allowlist) ──────────────────────────────────────────────────────

export function listUsers() {
  return getDb().prepare('SELECT * FROM tg_users ORDER BY allowlisted_at').all();
}

export function isAllowlisted(telegramUserId) {
  const row = getDb().prepare('SELECT 1 FROM tg_users WHERE telegram_user_id = ?').get(telegramUserId);
  return !!row;
}

export function addUser({ telegramUserId, handle, label }) {
  getDb().prepare(`
    INSERT INTO tg_users (telegram_user_id, telegram_handle, allowlisted_at, label)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(telegram_user_id) DO UPDATE SET telegram_handle = excluded.telegram_handle, label = excluded.label
  `).run(telegramUserId, handle || null, new Date().toISOString(), label || null);
}

export function removeUser(telegramUserId) {
  return getDb().prepare('DELETE FROM tg_users WHERE telegram_user_id = ?').run(telegramUserId);
}

// ─── Auth codes (one-time, ephemeral) ───────────────────────────────────────
// Codes are kept in-memory only — generated at server start, displayed in
// terminal, single-use. Surviving restart not required — operator regenerates.

// Auth codes are persisted in SQLite (tg_auth_codes table) so the issuer
// process (`npm run bot-auth-code`) and the consumer process (`npm run server`'s
// /auth handler) can share state. Previously these lived in a per-process
// in-memory Map, which silently failed across process boundaries.

const AUTH_CODE_TTL_MS = 15 * 60 * 1000;

function sweepExpiredAuthCodes() {
  try {
    getDb().prepare(`DELETE FROM tg_auth_codes WHERE expires_at < datetime('now')`).run();
  } catch { /* sweeping is best-effort */ }
}

export function issueAuthCode(label = null) {
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + AUTH_CODE_TTL_MS);
  sweepExpiredAuthCodes();
  getDb().prepare(
    `INSERT INTO tg_auth_codes (code, issued_at, expires_at, label) VALUES (?, ?, ?, ?)`,
  ).run(code, now.toISOString(), expiresAt.toISOString(), label);
  return code;
}

export function consumeAuthCode(code) {
  const db = getDb();
  const row = db.prepare(
    `SELECT label, expires_at FROM tg_auth_codes WHERE code = ?`,
  ).get(code);
  if (!row) return null;
  // Single-use: delete regardless of expiry result
  db.prepare(`DELETE FROM tg_auth_codes WHERE code = ?`).run(code);
  if (new Date(row.expires_at) < new Date()) return null;
  return { label: row.label };
}

export function listAuthCodes() {
  sweepExpiredAuthCodes();
  return getDb().prepare(
    `SELECT code, issued_at, expires_at, label FROM tg_auth_codes ORDER BY issued_at DESC`,
  ).all();
}

// ─── Pinned project per user ────────────────────────────────────────────────
//
// When a user runs a command without specifying a project, we use whichever
// project they last pinned. /pin to set, /unpin to clear, /pinned to view.

export function getPinnedProject(telegramUserId) {
  const row = getDb().prepare(
    `SELECT project FROM tg_pinned_projects WHERE telegram_user_id = ?`,
  ).get(telegramUserId);
  return row ? row.project : null;
}

export function pinProject(telegramUserId, project) {
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO tg_pinned_projects (telegram_user_id, project, pinned_at)
     VALUES (?, ?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET project = excluded.project, pinned_at = excluded.pinned_at`,
  ).run(telegramUserId, project, now);
}

export function unpinProject(telegramUserId) {
  return getDb().prepare(
    `DELETE FROM tg_pinned_projects WHERE telegram_user_id = ?`,
  ).run(telegramUserId);
}

// ─── Jobs (queue) ───────────────────────────────────────────────────────────

function assertProjectNotTombstoned(db, project, action) {
  const tombstone = db.prepare(`
    SELECT deleted_at FROM project_tombstones WHERE project = ?
  `).get(project);
  if (!tombstone) return;
  const err = new Error(`Project '${project}' was deleted; refusing to enqueue '${action}'`);
  err.code = 'PROJECT_DELETED';
  err.deletedAt = tombstone.deleted_at;
  throw err;
}

// v0.14.44: re-enqueue a job for a deferred transient retry. not_before is a
// UTC ISO string compared against datetime('now') in the picker.
export function enqueueRetryJob({ project, action, args, requestedBy, notBefore, retryCount }) {
  const db = getDb();
  return db.transaction(() => {
    assertProjectNotTombstoned(db, project, action);
    const now = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO tg_jobs (project, action, args_json, requested_by, requested_at, status, not_before, retry_count)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(project, action, JSON.stringify(args || {}), requestedBy, now,
           toSqliteDatetime(notBefore), retryCount);
    return result.lastInsertRowid;
  }).immediate();
}

/**
 * Persist at most one pending/running unattended resume for a project.
 *
 * Provider finalization, the queue runner, the watchdog, and a brief-chain can
 * all observe the same pause. Their old check-then-insert sequences could race
 * and create several resume jobs. This transaction is the authoritative
 * dedupe gate shared by every durable scheduler.
 *
 * @returns {{scheduled:boolean, jobId:number|bigint, notBefore:Date|null}}
 */
export function enqueueUniqueResumeJob({
  project,
  args = { unattended: true },
  requestedBy = null,
  notBefore = null,
  retryCount = 0,
  excludeJobId = null,
}) {
  if (!project) throw new Error('enqueueUniqueResumeJob requires project');
  const db = getDb();
  return db.transaction(() => {
    assertProjectNotTombstoned(db, project, 'resume');
    const existing = db.prepare(`
      SELECT id, not_before FROM tg_jobs
      WHERE project = ? AND action = 'resume' AND status IN ('pending', 'running')
        AND (? IS NULL OR id <> ?)
      ORDER BY id ASC LIMIT 1
    `).get(project, excludeJobId, excludeJobId);
    if (existing) {
      return {
        scheduled: false,
        jobId: existing.id,
        notBefore: fromPersistedDatetime(existing.not_before),
      };
    }

    const now = new Date().toISOString();
    const notBeforeSql = notBefore instanceof Date ? toSqliteDatetime(notBefore) : null;
    const result = db.prepare(`
      INSERT INTO tg_jobs (
        project, action, args_json, requested_by, requested_at, status,
        not_before, retry_count
      ) VALUES (?, 'resume', ?, ?, ?, 'pending', ?, ?)
    `).run(project, JSON.stringify(args || {}), requestedBy, now, notBeforeSql, retryCount);
    return { scheduled: true, jobId: result.lastInsertRowid, notBefore };
  }).immediate();
}

export function enqueueJob({ project, action, args, requestedBy }) {
  const db = getDb();
  return db.transaction(() => {
    assertProjectNotTombstoned(db, project, action);
    const now = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO tg_jobs (project, action, args_json, requested_by, requested_at, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `).run(project, action, JSON.stringify(args || {}), requestedBy, now);
    return result.lastInsertRowid;
  }).immediate();
}

/** Atomically enqueue one action per project while it is pending/running. */
export function enqueueUniqueActionJob({ project, action, args = {}, requestedBy = null }) {
  if (!project || !action) throw new Error('enqueueUniqueActionJob requires project and action');
  return getDb().transaction(() => {
    // `guide` is a dispatcher namespace, not one unit of work. A queued plan
    // must not cause a project-context refresh (or review/handoff) to be
    // reported as deduplicated when it was never scheduled. Other actions keep
    // their action-level uniqueness, which intentionally collapses repeated
    // clicks with slightly different UI args.
    const existing = action === 'guide'
      ? getDb().prepare(`
          SELECT id FROM tg_jobs
          WHERE project = ? AND action = 'guide' AND status IN ('pending', 'running')
            AND COALESCE(json_extract(args_json, '$.task'), 'plan') = ?
          ORDER BY id ASC LIMIT 1
        `).get(project, String(args?.task || 'plan'))
      : getDb().prepare(`
          SELECT id FROM tg_jobs
          WHERE project = ? AND action = ? AND status IN ('pending', 'running')
          ORDER BY id ASC LIMIT 1
        `).get(project, action);
    if (existing) return { scheduled: false, jobId: existing.id };
    const jobId = enqueueJob({ project, action, args, requestedBy });
    return { scheduled: true, jobId };
  }).immediate();
}

/**
 * Atomically enqueue only when the project has no queued/running work of any
 * kind and no active auto-run. Operator lifecycle controls use this stricter
 * gate so two different actions cannot be stacked by racing HTTP requests.
 */
export function enqueueProjectIdleActionJob({ project, action, args = {}, requestedBy = null }) {
  if (!project || !action) throw new Error('enqueueProjectIdleActionJob requires project and action');
  return getDb().transaction(() => {
    const queued = getDb().prepare(`
      SELECT id, action, status FROM tg_jobs
      WHERE project = ? AND status IN ('pending', 'running')
      ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END,
        COALESCE(queue_position, id), id
      LIMIT 1
    `).get(project);
    if (queued) {
      return {
        scheduled: false,
        busy: true,
        blocker: { type: 'job', id: Number(queued.id), action: queued.action, status: queued.status },
      };
    }
    const autoRun = getDb().prepare(`
      SELECT id FROM auto_runs
      WHERE project = ? AND status = 'running'
      ORDER BY id DESC LIMIT 1
    `).get(project);
    if (autoRun) {
      return {
        scheduled: false,
        busy: true,
        blocker: { type: 'auto_run', id: Number(autoRun.id), status: 'running' },
      };
    }
    const jobId = enqueueJob({ project, action, args, requestedBy });
    return { scheduled: true, busy: false, jobId };
  }).immediate();
}

/**
 * Atomically enqueue a roadmap job for a project. Returns the new job's
 * lastInsertRowid, or null if a pending or running roadmap job already
 * exists for this project. The check + insert run in a single synchronous
 * better-sqlite3 transaction — no async callback can interleave between them.
 * This is the authoritative queue-stacking gate for roadmap jobs.
 */
export function enqueueRoadmapJob({ project, args, requestedBy }) {
  const db = getDb();
  return db.transaction(() => {
    assertProjectNotTombstoned(db, project, 'roadmap');
    const existing = db.prepare(
      `SELECT 1 FROM tg_jobs
       WHERE project = ? AND action = 'roadmap' AND status IN ('pending', 'running')
       LIMIT 1`,
    ).get(project);
    if (existing) return null;
    const result = db.prepare(
      `INSERT INTO tg_jobs (project, action, args_json, requested_by, requested_at, status)
       VALUES (?, 'roadmap', ?, ?, ?, 'pending')`,
    ).run(project, JSON.stringify(args || {}), requestedBy, new Date().toISOString());
    return result.lastInsertRowid;
  }).immediate();
}

/**
 * Atomically enqueue a project-context-gen refresh job (Phase 19, brief P2
 * auto-refresh half). Dispatches as action='guide' + args.task='project-context-gen'
 * — the same shape job-runner.js's executeJob 'guide' case already handles for
 * any queue-safe guide task (see src/server/job-runner.js's `case 'guide':`).
 * Returns the new job's lastInsertRowid, or null if a pending or running
 * project-context-gen refresh already exists for this project — same atomic
 * check-then-insert transaction shape as enqueueRoadmapJob, the precedent this
 * mirrors (json_extract reads the task back out of args_json since 'guide' is
 * shared by every guide task, unlike roadmap's dedicated action name).
 */
export function enqueueContextRefreshJob({ project, requestedBy = null }) {
  const db = getDb();
  return db.transaction(() => {
    assertProjectNotTombstoned(db, project, 'guide');
    const existing = db.prepare(`
      SELECT 1 FROM tg_jobs
       WHERE project = ? AND action = 'guide' AND status IN ('pending', 'running')
         AND json_extract(args_json, '$.task') = 'project-context-gen'
       LIMIT 1`,
    ).get(project);
    if (existing) return null;
    const result = db.prepare(`
      INSERT INTO tg_jobs (project, action, args_json, requested_by, requested_at, status)
       VALUES (?, 'guide', ?, ?, ?, 'pending')`,
    ).run(project, JSON.stringify({ task: 'project-context-gen' }), requestedBy, new Date().toISOString());
    return result.lastInsertRowid;
  }).immediate();
}

export function nextPendingJob() {
  return getDb().prepare(`
    SELECT * FROM tg_jobs WHERE status = 'pending'
    ORDER BY COALESCE(queue_position, id) ASC, id ASC LIMIT 1
  `).get();
}

// The per-project FIFO candidate set (SELECT * ... this fragment ... ORDER BY):
// the oldest DUE pending job per free project (no running tg_job and no running
// auto_run for that project), with an earlier-due-pending-in-same-project guard
// so FIFO within a project is preserved. v0.14.44's sleeping-retry not_before
// filter is applied to both j and the earlier-guard so a deferred job never
// blocks its project's FIFO. Shared verbatim between the unchanged single-pick
// path and the phase-79 warn-state candidate walk so the two never drift.
const FREE_PROJECT_FIFO_FROM_WHERE = `
  FROM tg_jobs AS j
  WHERE j.status = 'pending'
    AND NOT EXISTS (
      SELECT 1 FROM project_tombstones AS deleted WHERE deleted.project = j.project
    )
    AND (j.not_before IS NULL OR j.not_before <= datetime('now'))
    AND j.project NOT IN (
      SELECT project FROM tg_jobs WHERE status = 'running'
    )
    AND j.project NOT IN (
      SELECT project FROM auto_runs WHERE status = 'running'
    )
    AND NOT EXISTS (
      SELECT 1 FROM tg_jobs AS earlier
      WHERE earlier.project = j.project
        AND earlier.status = 'pending'
        AND (earlier.not_before IS NULL OR earlier.not_before <= datetime('now'))
        AND (
          COALESCE(earlier.queue_position, earlier.id) < COALESCE(j.queue_position, j.id)
          OR (
            COALESCE(earlier.queue_position, earlier.id) = COALESCE(j.queue_position, j.id)
            AND earlier.id < j.id
          )
        )
    )
`;

/**
 * Per-project FIFO picker: returns the oldest pending job whose project does
 * NOT currently have a running job. Excludes jobs whose project also has an
 * older pending job (so FIFO within a project is preserved).
 *
 * Used by the worker pool (v0.14+). Each worker independently calls this and
 * then atomically claims via tryClaimJob().
 *
 * Phase 79 (P2) — window-aware admission. `opts.windowState` (from windowGate,
 * computed ONCE per tick) makes the picker cost-class-aware:
 *   - absent / state 'ok' / state 'pause' → UNCHANGED FIFO behavior. ('ok'
 *     opportunistically drains everything due, including any once-deferred
 *     heavy jobs whose not_before has since matured; the hard pause_at_calls
 *     stop is enforced at spawn in claude-runner.js, never here.)
 *   - state 'warn' → only CHEAP jobs (or a heavy job already deferred once,
 *     deferred_count>=1) are eligible. A never-deferred heavy FIFO head is
 *     DEFERRED: its not_before is stamped to the projected window reset and
 *     deferred_count is bumped to 1. STARVATION GUARD: a heavy job defers at
 *     MOST ONCE — on its next due tick deferred_count>=1 admits it regardless
 *     of warn, so it can never be starved indefinitely by a persistently warm
 *     window.
 *
 * The cost-class filter is applied to the SAME FIFO candidate this picker
 * already selected (and that brief-05 fair-share admission gates at spawn) — it
 * does not reimplement fair-share's weighted-share admission.
 *
 * @param {Object} [opts]
 * @param {Object|null} [opts.windowState] - windowStatus() result (state/…)
 * @param {Date|null}   [opts.projectedReset] - not_before for a deferred heavy job
 * @param {Object|null} [opts.costClass] - billing.job_cost_class override map
 */
export function nextPendingJobForFreeProject(opts = {}) {
  const { windowState = null, projectedReset = null, costClass = null } = opts;
  const db = getDb();

  // Unchanged path — no window gate, or the window has room ('ok') / is already
  // hard-stopped upstream ('pause'). Byte-identical to the pre-phase-79 pick.
  if (!windowState || windowState.state !== 'warn') {
    return db.prepare(`SELECT * ${FREE_PROJECT_FIFO_FROM_WHERE}
      ORDER BY COALESCE(j.queue_position, j.id) ASC, j.id ASC LIMIT 1`).get();
  }

  // 'warn' — walk the FIFO candidates in id order, admit the first eligible one,
  // and defer-once any heavy head we skip past.
  const candidates = db.prepare(`SELECT * ${FREE_PROJECT_FIFO_FROM_WHERE}
    ORDER BY COALESCE(j.queue_position, j.id) ASC, j.id ASC`).all();
  const resetStr = projectedReset ? toSqliteDatetime(projectedReset) : null;
  const deferStmt = resetStr
    ? db.prepare(`UPDATE tg_jobs SET not_before = ?, deferred_count = deferred_count + 1 WHERE id = ? AND status = 'pending'`)
    : db.prepare(`UPDATE tg_jobs SET deferred_count = deferred_count + 1 WHERE id = ? AND status = 'pending'`);

  for (const job of candidates) {
    const deferred = Number(job.deferred_count) || 0; // NULL (legacy rows) → 0
    if (jobCostClass(job.action, costClass) === 'cheap' || deferred >= 1) {
      return job; // eligible at warn: cheap, or a heavy job already deferred once
    }
    // Heavy + never deferred → defer to the projected reset, skip this tick.
    if (resetStr) deferStmt.run(resetStr, job.id);
    else deferStmt.run(job.id);
  }
  return undefined; // nothing admissible this tick — the worker sleeps + retries
}

/**
 * Atomically claim a pending job by ID. Returns true if this caller won the
 * race, false if someone else already picked it. Combined with the in-process
 * picker lock, the practical race window is microseconds, but this is the
 * authoritative gate.
 */
export function tryClaimJob(id, {
  workerPid = process.pid,
  leaseToken = randomUUID(),
  nowMs = Date.now(),
  leaseMs = JOB_LEASE_MS,
} = {}) {
  const result = getDb().prepare(`
    UPDATE tg_jobs SET status = 'running', started_at = ?, worker_pid = ?,
      lease_token = ?, lease_expires_at = ?, cancel_requested_at = NULL
    WHERE id = ? AND status = 'pending'
      AND (not_before IS NULL OR not_before <= datetime('now'))
      -- Project-freeness is enforced INSIDE the claim so it is atomic: the
      -- picker's SELECT can pass for two different jobs of one project in the
      -- window between pick and claim (across worker/telegram/discord
      -- processes), but only the first claim wins here — the second sees the
      -- project already running and fails, preventing a double-spawn / doubled
      -- token spend on one project. The row being claimed is still 'pending'
      -- during WHERE evaluation, so it never excludes itself.
      AND project NOT IN (SELECT project FROM tg_jobs WHERE status = 'running')
      AND project NOT IN (SELECT project FROM auto_runs WHERE status = 'running')
      AND NOT EXISTS (
        SELECT 1 FROM project_tombstones AS deleted WHERE deleted.project = tg_jobs.project
      )
  `).run(new Date(nowMs).toISOString(), workerPid, leaseToken, leaseExpiry(nowMs, leaseMs), id);
  return result.changes === 1;
}

/** Renew a running job's owner lease. A stale/finished/reclaimed row is never touched. */
export function heartbeatJobLease(id, {
  workerPid = process.pid,
  leaseToken = null,
  nowMs = Date.now(),
  leaseMs = JOB_LEASE_MS,
} = {}) {
  const result = leaseToken
    ? getDb().prepare(`
        UPDATE tg_jobs SET lease_expires_at = ?
        WHERE id = ? AND status = 'running' AND worker_pid = ? AND lease_token = ?
      `).run(leaseExpiry(nowMs, leaseMs), id, workerPid, leaseToken)
    : getDb().prepare(`
        UPDATE tg_jobs SET lease_expires_at = ?
        WHERE id = ? AND status = 'running' AND worker_pid = ?
      `).run(leaseExpiry(nowMs, leaseMs), id, workerPid);
  return result.changes === 1;
}

/**
 * Build the per-job heartbeat callback used by every queue worker.
 *
 * A false renewal is materially different from a transient SQLite exception:
 * it proves this worker no longer owns the row (another owner reclaimed it, or
 * the job was terminalized). Latch that state and invoke `onLeaseLost` exactly
 * once so the caller can cancel the matching subprocess and prevent any later
 * provider spawn under the stale job identity. Exceptions remain retryable — a
 * single busy/IO error does not, by itself, prove ownership was lost.
 */
export function createJobLeaseGuard({
  id,
  leaseToken,
  workerPid = process.pid,
  renew = heartbeatJobLease,
  onLeaseLost = () => {},
  onHeartbeatError = () => {},
} = {}) {
  if (id == null) throw new Error('createJobLeaseGuard requires id');
  if (!leaseToken) throw new Error('createJobLeaseGuard requires leaseToken');

  let leaseLost = false;
  return {
    get leaseLost() { return leaseLost; },
    heartbeat() {
      if (leaseLost) return false;
      try {
        const renewed = renew(id, { workerPid, leaseToken });
        if (!renewed) {
          leaseLost = true;
          try {
            onLeaseLost({ id, workerPid, leaseToken });
          } catch (err) {
            onHeartbeatError(err);
          }
        }
        return renewed;
      } catch (err) {
        onHeartbeatError(err);
        return null;
      }
    },
  };
}

export function listRunningJobs() {
  return getDb().prepare(`
    SELECT * FROM tg_jobs WHERE status = 'running' ORDER BY started_at ASC
  `).all();
}

/**
 * Per-project running-jobs query (v0.14.8 / BUG-5). The per-project FIFO
 * picker guarantees at most one row today, but the function returns an array
 * so future "concurrent jobs per project" support doesn't break the signature.
 * Used by handleCancel for the `/cancel <project>` path.
 */
export function getRunningJobsForProject(project) {
  return getDb().prepare(`
    SELECT * FROM tg_jobs WHERE status = 'running' AND project = ?
    ORDER BY started_at ASC
  `).all(project);
}

/**
 * Per-project pending-jobs query, oldest first (FIFO order). Surfaces jobs
 * that are queued but not yet claimable (see FREE_PROJECT_FIFO_FROM_WHERE) —
 * e.g. a resume click enqueued while the project already has a running job
 * or auto_run — so the UI can show "queued" instead of looking like a no-op.
 */
export function getPendingJobsForProject(project) {
  return getDb().prepare(`
    SELECT * FROM tg_jobs WHERE status = 'pending' AND project = ?
    ORDER BY COALESCE(queue_position, id) ASC, id ASC
  `).all(project);
}

export function getCurrentRunningJob() {
  return getDb().prepare(`
    SELECT * FROM tg_jobs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1
  `).get();
}

export function getJob(id) {
  return getDb().prepare('SELECT * FROM tg_jobs WHERE id = ?').get(id);
}

/** Persist a cross-process cancellation request for the active job. */
export function requestJobCancellation(id, reason = 'cancelled by user') {
  const row = getDb().prepare(`SELECT action, status FROM tg_jobs WHERE id = ?`).get(id);
  if (!row || row.status !== 'running' || !jobCancellationCapability(row).cancellable) return false;
  const result = getDb().prepare(`
    UPDATE tg_jobs
    SET cancel_requested_at = COALESCE(cancel_requested_at, ?),
      error_message = COALESCE(error_message, ?)
    WHERE id = ? AND status = 'running'
  `).run(new Date().toISOString(), reason, id);
  return result.changes === 1;
}

export function markJobRunning(id, {
  workerPid = process.pid,
  leaseToken = randomUUID(),
  nowMs = Date.now(),
  leaseMs = JOB_LEASE_MS,
} = {}) {
  getDb().prepare(`
    UPDATE tg_jobs SET status = 'running', started_at = ?, worker_pid = ?,
      lease_token = ?, lease_expires_at = ?, cancel_requested_at = NULL
    WHERE id = ?
  `).run(new Date(nowMs).toISOString(), workerPid, leaseToken, leaseExpiry(nowMs, leaseMs), id);
}

export function markJobCompleted(id, summary, { leaseToken = null } = {}) {
  // Guarded to status='running': a job that was cancelled (or already
  // finalized) must not be resurrected/overwritten by a late completion from a
  // killed subprocess. Without this guard, /cancel followed by the un-killed
  // job finishing would flip the row back to 'completed'.
  const sql = `UPDATE tg_jobs SET status = 'completed', ended_at = ?, result_summary = ?,
      worker_pid = NULL, lease_token = NULL, lease_expires_at = NULL
    WHERE id = ? AND status = 'running' AND cancel_requested_at IS NULL${leaseToken ? ' AND lease_token = ?' : ''}`;
  const result = getDb().prepare(sql).run(new Date().toISOString(), summary || null, id, ...(leaseToken ? [leaseToken] : []));
  return result.changes === 1;
}

export function markJobFailed(id, errorMessage, { leaseToken = null } = {}) {
  // Guarded to status='running' (same rationale as markJobCompleted).
  const sql = `UPDATE tg_jobs SET status = 'failed', ended_at = ?, error_message = ?,
      worker_pid = NULL, lease_token = NULL, lease_expires_at = NULL
    WHERE id = ? AND status = 'running' AND cancel_requested_at IS NULL${leaseToken ? ' AND lease_token = ?' : ''}`;
  const result = getDb().prepare(sql).run(new Date().toISOString(), errorMessage || null, id, ...(leaseToken ? [leaseToken] : []));
  return result.changes === 1;
}

export function markJobCancelled(id, reason, { leaseToken = null } = {}) {
  // Cancellation applies to a running job and is terminal: once set, the
  // status='running'-guarded completed/failed writes above can no longer
  // overwrite it. Guarding cancel itself to 'running' also means a job that
  // finished a moment before the user confirmed can't be falsely cancelled.
  const sql = `UPDATE tg_jobs SET status = 'cancelled', ended_at = ?, error_message = ?,
      worker_pid = NULL, lease_token = NULL, lease_expires_at = NULL
    WHERE id = ? AND status = 'running'${leaseToken ? ' AND lease_token = ?' : ''}`;
  const result = getDb().prepare(sql).run(new Date().toISOString(), reason || 'cancelled by user', id, ...(leaseToken ? [leaseToken] : []));
  return result.changes === 1;
}

export function listPendingJobs() {
  return getDb().prepare(`SELECT * FROM tg_jobs WHERE status = 'pending'
    ORDER BY COALESCE(queue_position, id) ASC, id ASC`).all();
}

export function listRecentJobs(limit = 20) {
  return getDb().prepare(`
    SELECT * FROM tg_jobs ORDER BY id DESC LIMIT ?
  `).all(limit);
}

export function dequeuePendingJob(id) {
  return getDb().prepare(`DELETE FROM tg_jobs WHERE id = ? AND status = 'pending'`).run(id);
}

/**
 * Terminalize selected pending jobs while retaining their audit rows. When
 * actions is omitted every pending job for the project is cancelled.
 */
export function cancelPendingJobsForProject(project, {
  actions = null,
  reason = 'cancelled by user',
  now = new Date(),
} = {}) {
  const allow = actions == null ? null : new Set(actions);
  const db = getDb();
  return db.transaction(() => {
    const pending = db.prepare(`
      SELECT id, action FROM tg_jobs
      WHERE project = ? AND status = 'pending'
      ORDER BY COALESCE(queue_position, id), id
    `).all(project).filter((row) => allow == null || allow.has(row.action));
    if (pending.length === 0) return [];
    const endedAt = (now instanceof Date ? now : new Date(now)).toISOString();
    const cancel = db.prepare(`
      UPDATE tg_jobs SET status = 'cancelled', ended_at = ?, error_message = ?,
        worker_pid = NULL, lease_token = NULL, lease_expires_at = NULL
      WHERE id = ? AND status = 'pending'
    `);
    const cancelled = [];
    for (const row of pending) {
      if (cancel.run(endedAt, reason, row.id).changes === 1) cancelled.push(Number(row.id));
    }
    return cancelled;
  }).immediate();
}

/**
 * Reorder one pending job without mutating its durable id. `beforeId:null`
 * moves it to the end; `direction` is a convenience for one-step controls.
 */
export function reorderPendingJob(id, { beforeId = undefined, direction = null } = {}) {
  const db = getDb();
  return db.transaction(() => {
    const rows = db.prepare(`SELECT id FROM tg_jobs WHERE status = 'pending'
      ORDER BY COALESCE(queue_position, id), id`).all();
    const ids = rows.map((row) => Number(row.id));
    const from = ids.indexOf(Number(id));
    if (from < 0) return { reordered: false, reason: 'not_pending' };

    const [moving] = ids.splice(from, 1);
    let target;
    if (direction === 'up' || direction === 'down') {
      target = direction === 'up' ? Math.max(0, from - 1) : Math.min(ids.length, from + 1);
    } else if (beforeId === null) {
      target = ids.length;
    } else if (beforeId !== undefined) {
      target = ids.indexOf(Number(beforeId));
      if (target < 0) return { reordered: false, reason: 'before_not_pending' };
    } else {
      return { reordered: false, reason: 'missing_target' };
    }
    ids.splice(target, 0, moving);
    const update = db.prepare(`UPDATE tg_jobs SET queue_position = ? WHERE id = ? AND status = 'pending'`);
    ids.forEach((jobId, index) => update.run(index + 1, jobId));
    return { reordered: true, order: ids };
  }).immediate();
}

/** Create a new, auditable retry row for a failed/cancelled replay-safe job. */
export function retryTerminalJob(id, { requestedBy = null } = {}) {
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM tg_jobs WHERE id = ?').get(id);
    if (!row) return { retried: false, reason: 'not_found' };
    if (!['failed', 'cancelled'].includes(row.status)) {
      return { retried: false, reason: 'not_terminal', job: row };
    }
    if (!QUEUE_ACTION_SET.has(row.action)) {
      return { retried: false, reason: 'unsupported_action', job: row };
    }
    if (NON_RETRYABLE_ACTIONS.has(row.action)) {
      return { retried: false, reason: 'not_replay_safe', job: row };
    }
    const action = recoveredAction(row.action);
    let args = {};
    try { args = JSON.parse(row.args_json || '{}') || {}; } catch { /* malformed legacy args -> empty */ }
    const newId = enqueueJob({
      project: row.project,
      action,
      args: { ...args, retryOfJobId: Number(row.id) },
      requestedBy,
    });
    return { retried: true, jobId: newId, action, retryOfJobId: Number(row.id) };
  }).immediate();
}

/** Upsert/read idle-worker liveness, independent of active job leases. */
export function heartbeatWorker({
  pid = process.pid,
  startedAt,
  capacity = 1,
  activeJobs = [],
  hostId = process.env.ASHMERO_HOST_ID || ((process.env.ASHMERO_ROLE || 'mac') === 'mac' ? 'mac' : null),
  role = process.env.ASHMERO_ROLE || 'mac',
  now = new Date(),
} = {}) {
  const nowIso = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const startIso = startedAt || nowIso;
  getDb().prepare(`
    INSERT INTO worker_heartbeats (pid, started_at, last_seen_at, capacity, active_jobs, host_id, role)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pid) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      capacity = excluded.capacity,
      active_jobs = excluded.active_jobs,
      host_id = excluded.host_id,
      role = excluded.role
  `).run(pid, startIso, nowIso, Math.max(1, Number(capacity) || 1), JSON.stringify(activeJobs || []), hostId, role);
  return nowIso;
}

export function listWorkerHeartbeats() {
  return getDb().prepare(`SELECT * FROM worker_heartbeats ORDER BY last_seen_at DESC`).all();
}

export function removeWorkerHeartbeat(pid = process.pid) {
  return getDb().prepare(`DELETE FROM worker_heartbeats WHERE pid = ?`).run(pid);
}

// Restarting these actions is unsafe because their external or destructive
// side effect may have completed immediately before the server died. All other
// queue actions are state-driven/idempotent enough for at-least-once recovery.
const NON_REPLAY_SAFE_ACTIONS = NON_RETRYABLE_ACTIONS;

function recoveredAction(action) {
  // A crashed go/next may have committed part of a phase. Resume is the only
  // safe entry: it preserves the existing plan/session instead of starting a
  // second top-level run or selecting another phase.
  return action === 'go' || action === 'next' || action === 'suggestions' ? 'resume' : action;
}

/**
 * Requeue the job a supervised worker was executing when it received a host /
 * PM2 shutdown signal. The worker first terminates its Claude process group,
 * then calls this after cancellation settles (or immediately before a forced
 * exit). A short not_before delay fences the old process from the new owner.
 */
export function recoverJobAfterWorkerShutdown(id, {
  reason = 'worker shutdown interrupted this job',
  delayMs = 15_000,
  nowMs = Date.now(),
  leaseToken = null,
} = {}) {
  // Recovery is an ownership mutation, not a generic status reset. A caller
  // without the claim token cannot prove it is the worker being shut down.
  if (!leaseToken) return { recovered: false, missingLeaseToken: true };

  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM tg_jobs WHERE id = ?').get(id);
    if (!row) return { recovered: false, missing: true };
    if (row.status === 'pending') return { recovered: false, alreadyPending: true, action: row.action };
    if (row.status !== 'running') {
      return { recovered: false, terminal: row.status };
    }
    if (row.lease_token !== leaseToken) {
      return { recovered: false, ownershipLost: true, action: row.action };
    }
    if (row.cancel_requested_at) {
      db.prepare(`
        UPDATE tg_jobs SET status = 'cancelled', ended_at = COALESCE(ended_at, ?),
          error_message = COALESCE(error_message, 'cancelled by user'),
          worker_pid = NULL, lease_token = NULL, lease_expires_at = NULL
        WHERE id = ? AND status = 'running' AND lease_token = ?
      `).run(new Date(nowMs).toISOString(), id, leaseToken);
      return { recovered: false, cancelled: true, action: row.action };
    }

    const action = recoveredAction(row.action);
    const nowIso = new Date(nowMs).toISOString();
    if (NON_REPLAY_SAFE_ACTIONS.has(row.action)) {
      db.prepare(`
        UPDATE tg_jobs SET status = 'failed', ended_at = ?, error_message = ?,
          worker_pid = NULL, lease_token = NULL, lease_expires_at = NULL
        WHERE id = ? AND status = 'running' AND lease_token = ?
      `).run(nowIso, `${reason}; automatic replay is unsafe for action '${row.action}'`, id, leaseToken);
      return { recovered: false, unsafe: true, action: row.action };
    }

    if (action === 'resume') {
      const duplicate = db.prepare(`
        SELECT id FROM tg_jobs
        WHERE project = ? AND action = 'resume' AND status IN ('pending', 'running') AND id <> ?
        ORDER BY id ASC LIMIT 1
      `).get(row.project, id);
      if (duplicate) {
        db.prepare(`
          UPDATE tg_jobs SET status = 'failed', ended_at = ?, error_message = ?,
            worker_pid = NULL, lease_token = NULL, lease_expires_at = NULL
          WHERE id = ? AND status = 'running' AND lease_token = ?
        `).run(nowIso, `${reason}; continuation already queued as job #${duplicate.id}`, id, leaseToken);
        return { recovered: false, deduplicated: true, jobId: duplicate.id, action };
      }
    }

    db.prepare(`
      UPDATE auto_runs SET status = 'interrupted', ended_at = ?, pause_reason = ?
      WHERE project = ? AND status = 'running'
    `).run(nowIso, reason, row.project);
    db.prepare(`
      UPDATE phases SET interruption_kind = 'process', interruption_reason = ?, interrupted_at = ?
      WHERE project = ? AND status = 'in-progress'
    `).run(String(reason).slice(0, 1000), nowIso, row.project);
    db.prepare(`
      UPDATE projects SET status = 'paused'
      WHERE name = ? AND status IN ('in-progress', 'cancelled')
    `).run(row.project);
    db.prepare(`
      UPDATE tg_jobs SET action = ?, status = 'pending', started_at = NULL,
        ended_at = NULL, result_summary = NULL, error_message = ?,
        not_before = ?, worker_pid = NULL, lease_token = NULL,
        lease_expires_at = NULL, recovery_count = COALESCE(recovery_count, 0) + 1
      WHERE id = ? AND status = 'running' AND lease_token = ?
    `).run(
      action,
      reason,
      toSqliteDatetime(new Date(nowMs + Math.max(1_000, Number(delayMs) || 15_000))),
      id,
      leaseToken,
    );
    return { recovered: true, action, jobId: id };
  }).immediate();
}

/**
 * Reconcile queue rows whose worker lease no longer has a healthy owner.
 *
 * - live PID + fresh lease: preserve (another server instance owns it)
 * - replay-safe action: put the SAME row back to pending, preserving FIFO
 * - go/next: normalize to resume so partial phase work is continued
 * - non-replay-safe action: fail closed for operator inspection
 * - duplicate resume: keep the already pending/live resume and terminalize the
 *   stale row, preventing one provider pause from multiplying overnight
 *
 * Associated `auto_runs.status='running'` rows are marked `interrupted`, which
 * removes the picker block while retaining an honest crash history.
 */
/**
 * Expire pending jobs that have been waiting longer than `maxAgeHours` with no
 * worker consuming them. Without this, the first worker start on a host fires
 * every heavy Claude job queued days earlier (surprise spend); the operator
 * re-queues anything still wanted. Notice goes through the durable outbox.
 * @returns {Array} the expired rows
 */
export function expireStalePendingJobs({ maxAgeHours = 48, nowMs = Date.now() } = {}) {
  const db = getDb();
  const cutoffIso = new Date(nowMs - maxAgeHours * 3600 * 1000).toISOString();
  const nowIso = new Date(nowMs).toISOString();
  return db.transaction(() => {
    const rows = db.prepare(
      `SELECT * FROM tg_jobs WHERE status = 'pending' AND requested_at < ? ORDER BY id ASC`,
    ).all(cutoffIso);
    for (const row of rows) {
      db.prepare(`
        UPDATE tg_jobs SET status = 'cancelled', ended_at = ?,
          error_message = ? WHERE id = ? AND status = 'pending'
      `).run(nowIso, `expired: pending since ${row.requested_at} with no worker (>${maxAgeHours}h) — re-queue if still wanted`, row.id);
      try {
        queueNotify({
          project: row.project,
          text: `⌛ Queue job #${row.id} (${row.project} ${row.action}) expired — pending since ${row.requested_at} with no worker. Re-queue if still wanted.`,
        });
      } catch { /* non-fatal */ }
    }
    return rows;
  })();
}

export function reconcileStaleRunningJobs({
  reason = 'server restarted before this job finished',
  nowMs = Date.now(),
  pidAliveFn = pidAlive,
} = {}) {
  const db = getDb();
  const nowIso = new Date(nowMs).toISOString();

  return db.transaction(() => {
    const rows = db.prepare(`SELECT * FROM tg_jobs WHERE status = 'running' ORDER BY id ASC`).all();
    const result = { recovered: [], failed: [], deduplicated: [], preserved: [] };

    for (const row of rows) {
      const leaseUntil = row.lease_expires_at ? Date.parse(row.lease_expires_at) : NaN;
      const ownerHealthy = Number.isInteger(row.worker_pid)
        && pidAliveFn(row.worker_pid)
        && Number.isFinite(leaseUntil)
        && leaseUntil > nowMs;
      if (ownerHealthy) {
        result.preserved.push(row.id);
        continue;
      }

      if (row.cancel_requested_at) {
        db.prepare(`
          UPDATE tg_jobs SET status = 'cancelled', ended_at = ?,
            error_message = COALESCE(error_message, 'cancelled by user'),
            worker_pid = NULL, lease_token = NULL, lease_expires_at = NULL
          WHERE id = ? AND status = 'running'
        `).run(nowIso, row.id);
        result.failed.push(row.id);
        continue;
      }

      db.prepare(`
        UPDATE auto_runs
        SET status = 'interrupted', ended_at = ?, pause_reason = ?
        WHERE project = ? AND status = 'running'
      `).run(nowIso, reason, row.project);

      db.prepare(`
        UPDATE phases SET interruption_kind = 'process', interruption_reason = ?, interrupted_at = ?
        WHERE project = ? AND status = 'in-progress'
      `).run(String(reason).slice(0, 1000), nowIso, row.project);

      const nextAction = recoveredAction(row.action);
      if (NON_REPLAY_SAFE_ACTIONS.has(row.action)) {
        db.prepare(`
          UPDATE tg_jobs
          SET status = 'failed', ended_at = ?, error_message = ?,
              worker_pid = NULL, lease_token = NULL, lease_expires_at = NULL
          WHERE id = ? AND status = 'running'
        `).run(nowIso, `${reason}; automatic replay is unsafe for action '${row.action}'`, row.id);
        result.failed.push(row.id);
        continue;
      }

      if (nextAction === 'resume') {
        // Project-level status is presentation/state, not the scheduler. Keep it
        // honest while waiting even when another durable resume already exists;
        // autoRun flips it back only after that resume is actually claimed.
        db.prepare(`
          UPDATE projects SET status = 'paused'
          WHERE name = ? AND status = 'in-progress'
        `).run(row.project);

        const duplicate = db.prepare(`
          SELECT id FROM tg_jobs
          WHERE project = ? AND action = 'resume'
            AND status IN ('pending', 'running') AND id <> ?
          ORDER BY id ASC LIMIT 1
        `).get(row.project, row.id);
        if (duplicate) {
          db.prepare(`
            UPDATE tg_jobs
            SET status = 'failed', ended_at = ?, error_message = ?,
                worker_pid = NULL, lease_token = NULL, lease_expires_at = NULL
            WHERE id = ? AND status = 'running'
          `).run(nowIso, `${reason}; recovery deduplicated into resume job #${duplicate.id}`, row.id);
          result.deduplicated.push(row.id);
          continue;
        }
      }

      db.prepare(`
        UPDATE tg_jobs
        SET action = ?, status = 'pending', started_at = NULL, ended_at = NULL,
            result_summary = NULL, error_message = ?, not_before = ?,
            worker_pid = NULL, lease_token = NULL, lease_expires_at = NULL,
            recovery_count = COALESCE(recovery_count, 0) + 1
        WHERE id = ? AND status = 'running'
      `).run(nextAction, `${reason}; recovered for automatic retry`,
             toSqliteDatetime(new Date(nowMs + 15_000)), row.id);
      result.recovered.push(row.id);
    }
    return result;
  }).immediate();
}

/** Backward-compatible count API for older startup callers. */
export function clearStaleRunningJobs(reason) {
  const out = reconcileStaleRunningJobs({ reason });
  return out.recovered.length + out.failed.length + out.deduplicated.length;
}
