// Portfolio autopilot core (Phase 85 — P7a).
//
// The PURE planning + execution core for the overnight portfolio autopilot.
// This module deliberately does NOT contain a scheduler (P7b wires the nightly
// tick) and MUST NOT import src/claude-runner.js — execute() enqueues jobs via
// the EXISTING enqueueJob only, letting the queue's serialization, P2 cost
// classes, and brief-05 fair-share do the actual spawning downstream.
//
// Two halves:
//   plan(input)  — a PURE function (no IO/DB/Date). The caller gathers portfolio
//                  state and passes it in; plan() returns an ordered, budget-
//                  packed [{ project, action, args, predicted_calls, reason,
//                  needs_approval }].
//   execute(nightPlan) — impure. Enqueues each non-approval job. A needs_approval
//                  job enqueues ONLY IF a VALID, UNEXPIRED standing approval
//                  exists in autopilot_approvals; on use the approval is
//                  decremented / recorded for the calendar night. Once exhausted
//                  the action reverts to a digest recommendation. An approval is
//                  NEVER a permanent silent bypass of the overnight-brief guard.

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import {
  getDb, listProjects, getLastAutoRun, listProjectsWithBugs, getLatestSuggestions,
  getAutopilotState, recordAutopilotPlanned,
} from '../state.js';
import { enqueueJob } from '../server/job-queue.js';
import { windowStatus } from '../billing-guard.js';
// Brief 04's config-driven deny-rule sandbox — the SAME mechanism P5/runtime-qa
// gates on. Imported here purely so resolveSandbox() can prove it is resolvable
// at load time; the autopilot itself adds NO new spawn path (execute() only
// enqueues existing job actions, whose spawns route through the sandbox later).
import { mergeDenyRules, PUSH_DENY_RULE } from './workspace-skills.js';
import { rawThoughtsPath, briefPath, auditDir } from './guide-paths.js';
import { runMorningDigest } from './autopilot-digest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

// ─── Config-constant fallbacks ────────────────────────────────────────────────
// These mirror the shipped config.autopilot defaults so plan() behaves
// identically whether cfg carries the block (normal) or a frozen snapshot
// predating phase 85 omits it (backward compatibility NFR).
const DEFAULT_PRIORITY_ORDER = ['resume', 'brief', 'bugs', 'audit', 'suggestions'];
const DEFAULT_MAX_PROJECTS = 3;
const DEFAULT_APPROVAL_ACTIONS = ['brief'];
// P2's window-headroom margin (billing.window_headroom_min_calls, default 4) —
// the packer always leaves this many calls unclaimed so the last enqueued job
// can't race the window pause threshold.
const DEFAULT_HEADROOM = 4;
// An audit becomes a candidate once this many days have elapsed since the last.
const AUDIT_DUE_DAYS = 7;
// Per-action predicted-call fallback when a project carries no predictUpcoming
// history. Intentionally on the high side — better to over-predict and pack
// fewer jobs than to overshoot the window.
const DEFAULT_PREDICTED_CALLS = { resume: 6, brief: 4, bugs: 5, audit: 3, suggestions: 4 };
const GENERIC_PREDICTED_CALLS = 5;

// ─── plan() — pure ─────────────────────────────────────────────────────────────

/**
 * Choose a project's single highest-priority applicable action for tonight.
 * One action per project (the packer's cap is max_projects_per_night, not
 * per-action), so a project with both a paused run and queued briefs resumes.
 * @returns {{action: string, reason: string}|null}
 */
function chooseAction(p, priorityOrder) {
  for (const action of priorityOrder) {
    const reason = actionReason(p, action);
    if (reason) return { action, reason };
  }
  return null;
}

/** Applicability + human reason for a single (project, action). null = N/A. */
function actionReason(p, action) {
  switch (action) {
    case 'resume':
      return p && p.pausedRun ? 'resume paused run' : null;
    case 'brief': {
      const n = (p && p.queuedBriefs) || 0;
      return n > 0 ? `${n} queued brief${n === 1 ? '' : 's'}` : null;
    }
    case 'bugs': {
      const n = (p && p.bugInboxCount) || 0;
      return n > 0 ? `${n} bug inbox item${n === 1 ? '' : 's'}` : null;
    }
    case 'audit': {
      const d = p && p.daysSinceLastAudit;
      return (typeof d === 'number' && d >= AUDIT_DUE_DAYS) ? `audit due (${d}d since last)` : null;
    }
    case 'suggestions': {
      const n = (p && p.approvedSuggestions) || 0;
      return n > 0 ? `${n} approved suggestion${n === 1 ? '' : 's'}` : null;
    }
    default:
      return null;
  }
}

/**
 * Resolve predicted_calls for a (project, action). Prefers a predictUpcoming-
 * derived estimate carried on the project (a plain number, or a per-action map),
 * falling back to the config-constant per-action default when there is no
 * history.
 */
function predictedCallsFor(p, action) {
  const pred = p ? p.predicted : null;
  if (typeof pred === 'number' && Number.isFinite(pred) && pred > 0) return pred;
  if (pred && typeof pred === 'object') {
    const v = pred[action];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  }
  return DEFAULT_PREDICTED_CALLS[action] ?? GENERIC_PREDICTED_CALLS;
}

/**
 * PURE. Build the night's ordered, budget-packed plan.
 *
 * @param {Object} input
 * @param {Array}  input.projects  - [{ name, status, pausedRun, queuedBriefs,
 *   bugInboxCount, approvedSuggestions, daysSinceLastAudit, predicted }]
 * @param {number} input.windowBudget - heavy-eq units available right now
 * @param {Object} input.cfg  - a resolved config (reads autopilot.* + billing.*)
 * @returns {Array<{project:string, action:string, args:Object,
 *   predicted_calls:number, reason:string, needs_approval:boolean}>}
 */
export function plan(input = {}) {
  const { projects = [], windowBudget = 0, cfg = {} } = input || {};
  const ap = (cfg && cfg.autopilot) || {};
  const priorityOrder = Array.isArray(ap.priority_order) && ap.priority_order.length
    ? ap.priority_order : DEFAULT_PRIORITY_ORDER;
  const maxProjects = Number.isInteger(ap.max_projects_per_night)
    ? ap.max_projects_per_night : DEFAULT_MAX_PROJECTS;
  const approvalActions = new Set(
    Array.isArray(ap.require_operator_approval_for) ? ap.require_operator_approval_for : DEFAULT_APPROVAL_ACTIONS,
  );
  const headroom = Number.isInteger(cfg && cfg.billing && cfg.billing.window_headroom_min_calls)
    ? cfg.billing.window_headroom_min_calls : DEFAULT_HEADROOM;
  const usable = Math.max(0, windowBudget - headroom);

  // 1. One candidate per project — its highest-priority applicable action.
  const candidates = [];
  for (let i = 0; i < projects.length; i += 1) {
    const p = projects[i];
    if (!p || !p.name) continue;
    const chosen = chooseAction(p, priorityOrder);
    if (!chosen) continue;
    const pi = priorityOrder.indexOf(chosen.action);
    candidates.push({
      project: p.name,
      action: chosen.action,
      reason: chosen.reason,
      predicted_calls: predictedCallsFor(p, chosen.action),
      needs_approval: approvalActions.has(chosen.action),
      _priority: pi === -1 ? priorityOrder.length : pi,
      _idx: i,
    });
  }

  // 2. Deterministic order: priority tier, then input order.
  candidates.sort((a, b) => (a._priority - b._priority) || (a._idx - b._idx));

  // 3. Greedy fill of the usable budget, capped at max_projects_per_night.
  //    Skip a candidate that doesn't fit but keep trying smaller later ones.
  const out = [];
  let remaining = usable;
  for (const c of candidates) {
    if (out.length >= maxProjects) break;
    if (c.predicted_calls > remaining) continue;
    remaining -= c.predicted_calls;
    out.push({
      project: c.project,
      action: c.action,
      args: { unattended: true },
      predicted_calls: c.predicted_calls,
      reason: c.reason,
      needs_approval: c.needs_approval,
    });
  }
  return out;
}

// ─── Approvals (impure — the expiring-approval security core) ───────────────────

/** Local calendar-night key ('YYYY-MM-DD') from a Date — the per-night bucket. */
function calendarNight(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Write a standing approval row. Exactly one expiry bound is set:
 *   - `until` (ISO/parseable timestamp) → expires_at, remaining_nights NULL
 *   - else `nights` (default 1)         → remaining_nights, expires_at NULL
 * @returns the inserted row descriptor.
 */
export function grantApproval({ project, action, nights = null, until = null, scope = 'all' } = {}, deps = {}) {
  const db = deps.db || getDb();
  const now = deps.now ? deps.now() : new Date();
  if (!project || !action) {
    throw new Error('[autopilot approve] project and action are required to grant an approval');
  }

  let remainingNights = null;
  let expiresAt = null;
  if (until != null) {
    const t = new Date(until);
    if (Number.isNaN(t.getTime())) {
      throw new Error(`[autopilot approve] invalid --until timestamp: ${until}`);
    }
    expiresAt = t.toISOString();
  } else {
    const n = nights == null ? 1 : nights;
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`[autopilot approve] --nights must be a positive integer, got: ${nights}`);
    }
    remainingNights = n;
  }

  const createdAt = now.toISOString();
  const info = db.prepare(`
    INSERT INTO autopilot_approvals
      (project, action, scope, remaining_nights, expires_at, consumed_nights, last_consumed_night, created_at)
    VALUES (?, ?, ?, ?, ?, 0, NULL, ?)
  `).run(project, action, scope || 'all', remainingNights, expiresAt, createdAt);

  return {
    id: info.lastInsertRowid,
    project,
    action,
    scope: scope || 'all',
    remaining_nights: remainingNights,
    expires_at: expiresAt,
    created_at: createdAt,
  };
}

/**
 * The oldest VALID, UNEXPIRED approval for a (project, action) at `now`, or null.
 * An approval is invalid when its timestamp has passed, its night-count is spent,
 * OR it carries NO expiry bound at all (never a permanent silent bypass).
 */
export function findValidApproval({ project, action }, now, db) {
  const _db = db || getDb();
  const rows = _db.prepare(
    'SELECT * FROM autopilot_approvals WHERE project = ? AND action = ? ORDER BY id ASC',
  ).all(project, action);
  const nowMs = now.getTime();
  for (const r of rows) {
    if (r.expires_at == null && r.remaining_nights == null) continue; // no bound → invalid
    if (r.expires_at != null && new Date(r.expires_at).getTime() <= nowMs) continue; // timestamp passed
    if (r.remaining_nights != null && r.remaining_nights <= 0) continue; // night-count spent
    return r;
  }
  return null;
}

// ─── execute() — impure ────────────────────────────────────────────────────────

/**
 * Enqueue a night's plan. Non-approval jobs go straight onto the queue via the
 * existing enqueueJob. A needs_approval job enqueues ONLY against a valid,
 * unexpired standing approval, which is consumed (decremented / stamped for the
 * calendar night) in the same transaction as the enqueue; a second execute()
 * the same night is idempotent, and an exhausted / missing / expired approval
 * reverts the action to a digest recommendation.
 *
 * @returns {{enqueued:Array, recommendations:Array, skipped:Array}}
 *   enqueued        - [{ project, action, jobId, approvalId? }]
 *   recommendations - [{ project, action, reason }] (deferred to the digest)
 *   skipped         - [{ project, action, reason }] (idempotent no-ops)
 */
export function execute(nightPlan = [], deps = {}) {
  const _enqueueJob = deps.enqueueJob || enqueueJob;
  const db = deps.db || getDb();
  const now = deps.now ? deps.now() : new Date();
  const nightKey = calendarNight(now);

  const enqueued = [];
  const recommendations = [];
  const skipped = [];

  for (const job of nightPlan) {
    if (!job || !job.project || !job.action) continue;
    const args = job.args || { unattended: true };

    if (!job.needs_approval) {
      const jobId = _enqueueJob({ project: job.project, action: job.action, args, requestedBy: null });
      enqueued.push({ project: job.project, action: job.action, jobId });
      continue;
    }

    // Approval-gated action — the ONLY path allowed to enqueue autonomous briefs.
    const approval = findValidApproval({ project: job.project, action: job.action }, now, db);
    if (!approval) {
      recommendations.push({
        project: job.project,
        action: job.action,
        reason: job.reason || 'operator approval required',
      });
      continue;
    }

    // Per-night idempotency: if this approval already fired tonight, the job was
    // already enqueued — don't re-enqueue or re-decrement.
    if (approval.last_consumed_night === nightKey) {
      skipped.push({ project: job.project, action: job.action, reason: 'already enqueued tonight' });
      continue;
    }

    // Consume + enqueue atomically: if the enqueue throws, the consumption rolls
    // back so a spent approval never leaves a job un-enqueued (fails CLOSED).
    let jobId = null;
    const txn = db.transaction(() => {
      const newRemaining = approval.remaining_nights == null
        ? null
        : Math.max(0, approval.remaining_nights - 1);
      db.prepare(`
        UPDATE autopilot_approvals
        SET remaining_nights = ?, consumed_nights = consumed_nights + 1, last_consumed_night = ?
        WHERE id = ?
      `).run(newRemaining, nightKey, approval.id);
      jobId = _enqueueJob({ project: job.project, action: job.action, args, requestedBy: null });
    });
    txn();
    enqueued.push({ project: job.project, action: job.action, jobId, approvalId: approval.id });
  }

  return { enqueued, recommendations, skipped };
}

// ─── Fail-closed sandbox guard (Phase 86 — P7b) ─────────────────────────────────

/** Best-effort helper: run `fn`, return `fallback` on throw/nullish. */
function safe(fn, fallback) {
  try { const v = fn(); return v == null ? fallback : v; } catch { return fallback; }
}
async function safeAsync(fn, fallback) {
  try { const v = await fn(); return v == null ? fallback : v; } catch { return fallback; }
}
async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/**
 * Resolve brief 04's config-driven deny-rule sandbox at load time — the SAME
 * mechanism P5/runtime-qa gates on. "Resolvable" means the merge primitive and
 * the always-on push guard are importable AND the config layer carries a
 * `security.deny_rules` array (so spawned overnight jobs run under real deny
 * rules). If ANY of that is missing the autopilot FAILS CLOSED: no fallback,
 * because unattended overnight jobs must NEVER run under unrestricted Bash.
 *
 * @param {object} cfg - a resolved config (reads security.deny_rules)
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function resolveSandbox(cfg) {
  if (typeof mergeDenyRules !== 'function') {
    return { ok: false, reason: 'brief-04 sandbox unresolvable: mergeDenyRules is not a function' };
  }
  if (typeof PUSH_DENY_RULE !== 'string' || !PUSH_DENY_RULE) {
    return { ok: false, reason: 'brief-04 sandbox unresolvable: PUSH_DENY_RULE is missing' };
  }
  if (!cfg || !cfg.security || !Array.isArray(cfg.security.deny_rules)) {
    return { ok: false, reason: 'brief-04 sandbox unresolvable: cfg.security.deny_rules is not an array' };
  }
  return { ok: true, reason: null };
}

// ─── Portfolio-state gathering (impure — feeds the pure plan()) ─────────────────

/** True when a brief is authored-and-waiting: raw-thoughts on disk, no brief yet. */
async function hasQueuedBrief(projDir, deps = {}) {
  if (deps.hasQueuedBrief) return !!(await deps.hasQueuedBrief(projDir));
  const rawExists = await fileExists(rawThoughtsPath(projDir));
  if (!rawExists) return false;
  const briefExists = await fileExists(briefPath(projDir));
  return !briefExists;
}

/** Whole-days since the most recent audit artifact, or null when there's none. */
async function daysSinceAudit(projDir, now, deps = {}) {
  if (deps.daysSinceAudit) return deps.daysSinceAudit(projDir);
  const dir = auditDir(projDir);
  const entries = await safeAsync(() => fs.readdir(dir), []);
  const audits = entries.filter((f) => f.endsWith('.md'));
  if (!audits.length) return null;
  let newest = 0;
  for (const f of audits) {
    const st = await safeAsync(() => fs.stat(path.join(dir, f)), null);
    if (st && st.mtimeMs > newest) newest = st.mtimeMs;
  }
  if (!newest) return null;
  return Math.floor((now.getTime() - newest) / (24 * 3600 * 1000));
}

/**
 * Gather the portfolio state the PURE plan() consumes — one row per project with
 * the signals plan() ranks (pausedRun, queuedBriefs, bugInboxCount,
 * approvedSuggestions, daysSinceLastAudit). Best-effort and NEVER throws: every
 * read degrades to a benign default so a missing table/file never breaks the
 * nightly pass (backward-compat NFR). The whole function is an injectable seam
 * (deps.gatherState) so the pure planner can be driven deterministically.
 *
 * @param {{cfg?: object, projectsDir?: string, now?: Date}} args
 * @param {object} [deps] - injectable readers for tests
 * @returns {Promise<Array>} plan()'s `projects` input
 */
export async function gatherPortfolioState({ cfg = null, projectsDir = null, now = new Date() } = {}, deps = {}) {
  const listProjectsFn = deps.listProjects ?? listProjects;
  const getLastAutoRunFn = deps.getLastAutoRun ?? getLastAutoRun;
  const listProjectsWithBugsFn = deps.listProjectsWithBugs ?? listProjectsWithBugs;
  const getLatestSuggestionsFn = deps.getLatestSuggestions ?? getLatestSuggestions;
  const dir = projectsDir ?? PROJECTS_DIR;

  const bugCounts = {};
  for (const r of safe(() => listProjectsWithBugsFn(), [])) {
    if (r && r.project) bugCounts[r.project] = r.n || 0;
  }

  const out = [];
  for (const p of safe(() => listProjectsFn(), [])) {
    if (!p || !p.name) continue;
    // A completed project is dormant — nothing for the autopilot to do overnight.
    if (p.status === 'completed') continue;
    const projDir = path.join(dir, p.name);
    const last = safe(() => getLastAutoRunFn(p.name), null);
    const pausedRun = last && last.status === 'paused' ? last : null;
    const approvedSuggestions = safe(() => {
      const s = getLatestSuggestionsFn(p.name);
      return s && s.status === 'accepted' ? 1 : 0;
    }, 0);
    out.push({
      name: p.name,
      status: p.status,
      pausedRun,
      queuedBriefs: (await hasQueuedBrief(projDir, deps)) ? 1 : 0,
      bugInboxCount: bugCounts[p.name] || 0,
      approvedSuggestions,
      daysSinceLastAudit: await daysSinceAudit(projDir, now, deps),
      predicted: null, // no predictUpcoming history wired yet → config-constant fallback
    });
  }
  return out;
}

/**
 * Heavy-equivalent window units available to pack tonight: the hard pause
 * threshold minus units already in the window. plan() further subtracts P2's
 * headroom margin.
 * Fails SAFE to 0 (pack nothing) if the window can't be read.
 */
export function computeWindowBudget(cfg, deps = {}) {
  const windowStatusFn = deps.windowStatus ?? windowStatus;
  try {
    const s = windowStatusFn(cfg);
    const pause = Number.isFinite(s?.pauseThreshold) ? s.pauseThreshold : (cfg?.billing?.pause_at_calls || 80);
    return Math.max(0, pause - (s?.callsInWindow || 0));
  } catch {
    return 0;
  }
}

// ─── The nightly plan+execute pass (guarded) ────────────────────────────────────

/**
 * The night's plan+execute pass, gated by the fail-closed sandbox check. If the
 * sandbox is unresolvable this returns early WITHOUT calling execute(), so NO
 * job is ever enqueued under unrestricted Bash. On success it gathers state,
 * packs the plan, enqueues it, and stamps the restart-safe cursor
 * (last_planned_date) so the same night is never planned twice.
 *
 * @param {{cfg: object, now?: Date, projectsDir?: string}} args
 * @param {object} [deps] - injectable seams (resolveSandbox, gatherState,
 *   windowBudget, execute, recordAutopilotPlanned, executeDeps)
 * @returns {Promise<object>} { ranPlan, sandboxOk, reason, nightPlan, enqueued,
 *   recommendations, skipped }
 */
export async function runNightlyPlan({ cfg, now = new Date(), projectsDir = null } = {}, deps = {}) {
  const resolveSandboxFn = deps.resolveSandbox ?? resolveSandbox;
  const gatherStateFn = deps.gatherState ?? gatherPortfolioState;
  const windowBudgetFn = deps.windowBudget ?? computeWindowBudget;
  const executeFn = deps.execute ?? execute;
  const recordPlannedFn = deps.recordAutopilotPlanned ?? recordAutopilotPlanned;

  const sandbox = resolveSandboxFn(cfg);
  if (!sandbox.ok) {
    // FAIL CLOSED — execute() is never reached; nothing is enqueued.
    return {
      ranPlan: false, sandboxOk: false, reason: sandbox.reason,
      nightPlan: [], enqueued: [], recommendations: [], skipped: [],
    };
  }

  const projects = await gatherStateFn({ cfg, projectsDir, now }, deps);
  const windowBudget = windowBudgetFn(cfg, deps);
  const nightPlan = plan({ projects, windowBudget, cfg });
  // execute()'s deps.now is a FUNCTION returning the calendar-night clock.
  const result = executeFn(nightPlan, { now: () => now, ...(deps.executeDeps || {}) });

  safe(() => recordPlannedFn({
    date: calendarNight(now),
    at: now.toISOString(),
    planJson: JSON.stringify({ nightPlan, ...result }),
  }), null);

  return { ranPlan: true, sandboxOk: true, reason: null, nightPlan, ...result };
}

// ─── The scheduler tick + lifecycle (startWatchdog pattern) ─────────────────────

/**
 * One scheduler tick. Enabled + at start_hour and not yet planned this calendar
 * night → runNightlyPlan (at most once/night). Enabled + at digest_hour and not
 * yet digested today → runMorningDigest (at most once/day). An injected `now`
 * (local Date) makes both decisions deterministic; the persisted cursors make a
 * mid-night restart a no-op rather than a double-plan.
 *
 * @param {{cfg: object, notifier?: object, now?: Date, projectsDir?: string}} args
 * @param {object} [deps] - injectable seams (getAutopilotState, runMorningDigest,
 *   plus everything runNightlyPlan accepts)
 */
export async function autopilotTick({ cfg, notifier = null, now = new Date(), projectsDir = null } = {}, deps = {}) {
  const ap = (cfg && cfg.autopilot) || {};
  if (ap.enabled !== true) return { planned: false, digested: false, reason: 'autopilot disabled' };

  const getStateFn = deps.getAutopilotState ?? getAutopilotState;
  const runDigestFn = deps.runMorningDigest ?? runMorningDigest;
  const startHour = Number.isInteger(ap.start_hour) ? ap.start_hour : 1;
  const digestHour = Number.isInteger(ap.digest_hour) ? ap.digest_hour : 8;
  const hour = now.getHours();
  const today = calendarNight(now);
  const state = safe(() => getStateFn(), {});

  const out = { planned: false, digested: false };

  if (hour === startHour && state.last_planned_date !== today) {
    out.plan = await runNightlyPlan({ cfg, now, projectsDir }, deps);
    out.planned = true;
  }
  if (hour === digestHour && state.last_digest_date !== today) {
    out.digest = await runDigestFn({ cfg, notifier, now }, deps);
    out.digested = true;
  }
  return out;
}

let _timer = null;
let _running = false;

/**
 * Start the nightly autopilot on a periodic interval (startWatchdog pattern,
 * src/lib/project-watchdog.js). Two hard gates BEFORE any timer is registered:
 *   1. autopilot.enabled must be true (default false → opt-in fleet execution).
 *   2. brief 04's sandbox must be resolvable (resolveSandbox). If not, the
 *      scheduler NO-OPS with a clear reason and registers NO interval — unattended
 *      overnight jobs must never run under unrestricted Bash (fail closed).
 * @returns {() => void} stop function (a no-op when the scheduler didn't start)
 */
export function startAutopilot({ cfg = null, notifier = null, intervalMs = 5 * 60_000 } = {}, deps = {}) {
  if (_timer) return () => stopAutopilot();

  const ap = (cfg && cfg.autopilot) || {};
  if (ap.enabled !== true) {
    console.log(chalk.dim('· Portfolio autopilot disabled (autopilot.enabled=false) — scheduler not started.'));
    return () => {};
  }

  const resolveSandboxFn = deps.resolveSandbox ?? resolveSandbox;
  const sandbox = resolveSandboxFn(cfg);
  if (!sandbox.ok) {
    console.warn(chalk.yellow(
      `⚠ Portfolio autopilot NOT started — ${sandbox.reason}. ` +
      `Unattended overnight jobs must never run under unrestricted Bash (fail closed).`,
    ));
    return () => {};
  }

  const tick = async () => {
    if (_running) return;
    _running = true;
    try {
      await autopilotTick({ cfg, notifier, now: new Date() }, deps);
    } catch (e) {
      console.warn(chalk.yellow(`[autopilot] tick error: ${e.message}`));
    } finally {
      _running = false;
    }
  };

  _timer = setInterval(tick, intervalMs);
  if (_timer.unref) _timer.unref(); // don't block process exit
  console.log(chalk.dim(
    `✓ Portfolio autopilot started (interval ${intervalMs / 1000}s; ` +
    `plan ${ap.start_hour ?? 1}:00, digest ${ap.digest_hour ?? 8}:00 local).`,
  ));
  return () => stopAutopilot();
}

export function stopAutopilot() {
  if (_timer) { clearInterval(_timer); _timer = null; _running = false; }
}

/** Test/introspection seam — true while the scheduler interval is registered. */
export function isAutopilotRunning() {
  return _timer !== null;
}
