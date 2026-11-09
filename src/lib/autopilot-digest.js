// Morning autopilot digest (Phase 86 — P7b).
//
// After the nightly plan+execute pass runs (portfolio-autopilot.js), the operator
// wakes up and wants ONE message: what ran, what finished, what paused and why,
// what needs approval, and what to do next. This module composes that digest.
//
//   composeDigest(input)   — PURE. Deterministic text from the gathered rows.
//                            ALWAYS emits the ran / finished / paused /
//                            needs-approval sections (empty → "none").
//   maybePolishDigest(...)  — OPTIONAL single haiku call (task autopilot-digest,
//                            claude-haiku-4-5) that tightens the prose — ONLY when
//                            the deterministic text is long (>30 lines). Fails
//                            OPEN to the deterministic text (never blocks a run).
//   runMorningDigest(...)   — gathers rows since the night start, composes,
//                            optionally polishes, and delivers THROUGH brief 06's
//                            notify_outbox (queueNotify) — falling back to the
//                            plain notifier ONLY if the outbox enqueue is genuinely
//                            unavailable. Stamps last_digest_date (once/day).
//
// This module — NOT portfolio-autopilot.js — owns the claude-runner dependency,
// so the pure planner/executor core stays claude-runner-free (asserted by a unit
// test that reads portfolio-autopilot.js's source).

import { runClaude } from '../claude-runner.js';
import { windowStatus } from '../billing-guard.js';
import {
  getAutopilotState, recordAutopilotDigest, queueNotify,
  listAutoRunsSince, listHealingLogSince, listJobsSince,
} from '../state.js';

// ─── Static instruction block (byte-identical across calls — cache rule) ─────
// NOTHING volatile goes here; the digest text itself rides the user prompt.
const DIGEST_SYSTEM_PROMPT =
  `You are the morning-digest editor for an overnight software-development ` +
  `autopilot. You are given a deterministic ops digest the orchestrator already ` +
  `assembled (what ran overnight, what finished, what paused and why, what needs ` +
  `operator approval, and recommended next commands). Tighten it for reading on a ` +
  `phone: improve concision and flow, keep it terse and technical, and PRESERVE ` +
  `every fact, project name, section, and command VERBATIM — never invent, drop, ` +
  `or reword a command. Reply with ONLY the polished digest text (no preamble, no ` +
  `markdown fence).`;

function safe(fn, fallback) {
  try { const v = fn(); return v == null ? fallback : v; } catch { return fallback; }
}
function trunc(s, n) { const str = String(s ?? ''); return str.length > n ? `${str.slice(0, n)}…` : str; }
function firstLine(s) { return String(s ?? '').split('\n')[0].trim(); }

/** Local 'YYYY-MM-DD' for a Date — the per-day digest bucket. */
function calendarDay(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// tg_jobs.status → coarse bucket. A paused auto-run lands in tg_jobs as
// status='completed' with a `paused:`-prefixed summary (see job-runner.js), so
// the summary text — not just the status — decides the "paused" bucket.
function jobBucket(job) {
  const status = job.status || '';
  const summary = job.result_summary || '';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (/^\s*paused:/i.test(summary) || /\bpaused\b/i.test(summary)) return 'paused';
  if (status === 'completed') return 'finished';
  if (status === 'running') return 'running';
  return 'pending';
}

/**
 * PURE. Build the deterministic digest text. ALWAYS emits the four required
 * sections (ran / finished / paused / needs approval) plus a recommended-actions
 * footer, so a downstream contains-check is stable regardless of row counts.
 *
 * @param {Object} input
 * @param {Array}  input.autoRuns      - auto_runs rows since the night start
 * @param {Array}  input.healing       - healing_log rows since the night start
 * @param {Array}  input.jobs          - tg_jobs rows since the night start
 * @param {Array}  input.recommendations - [{ project, action, reason }] deferred
 *   to approval (from the night's execute() result)
 * @param {Date}   input.now
 * @returns {string}
 */
export function composeDigest({ autoRuns = [], healing = [], jobs = [], recommendations = [], now = null } = {}) {
  const day = now ? calendarDay(now) : 'overnight';
  const lines = [];
  lines.push(`🌙 Overnight autopilot digest — ${day}`);

  // Classify jobs once.
  const ran = jobs.slice();
  const finished = jobs.filter((j) => jobBucket(j) === 'finished');
  const pausedJobs = jobs.filter((j) => jobBucket(j) === 'paused');
  const failedJobs = jobs.filter((j) => jobBucket(j) === 'failed');
  const pausedRuns = autoRuns.filter((r) => r.status === 'paused');

  // ── Ran ──────────────────────────────────────────────────────────────────
  lines.push('', `▶ Ran (${ran.length})`);
  if (!ran.length) {
    lines.push('  none — no jobs were enqueued overnight.');
  } else {
    for (const j of ran) lines.push(`  • ${j.action} ${j.project} — ${jobBucket(j)}`);
  }

  // ── Finished ───────────────────────────────────────────────────────────────
  lines.push('', `✓ Finished (${finished.length})`);
  if (!finished.length) lines.push('  none.');
  else for (const j of finished) lines.push(`  • ${j.action} ${j.project}${j.result_summary ? ` — ${trunc(firstLine(j.result_summary), 140)}` : ''}`);

  // ── Paused / failed ────────────────────────────────────────────────────────
  const stalled = pausedJobs.length + failedJobs.length + pausedRuns.length;
  lines.push('', `⏸ Paused / needs attention (${stalled})`);
  if (!stalled) {
    lines.push('  none.');
  } else {
    for (const j of pausedJobs) lines.push(`  • ⏸ ${j.action} ${j.project} — ${trunc(firstLine(j.result_summary) || 'paused', 140)}`);
    for (const j of failedJobs) lines.push(`  • ✗ ${j.action} ${j.project} — ${trunc(firstLine(j.error_message) || 'failed', 140)}`);
    for (const r of pausedRuns) lines.push(`  • ⏸ run ${r.project} — ${trunc(firstLine(r.pause_reason) || r.pause_kind || 'paused', 140)}`);
  }
  if (healing.length) {
    lines.push(`  ${healing.length} auto-heal attempt(s): ${healing.slice(0, 4).map((h) => `${h.project}:${h.error_kind}→${h.status}`).join(', ')}`);
  }

  // ── Needs approval ─────────────────────────────────────────────────────────
  lines.push('', `🔑 Needs approval (${recommendations.length})`);
  if (!recommendations.length) {
    lines.push('  none — nothing waited on an operator approval.');
  } else {
    for (const rec of recommendations) {
      lines.push(`  • ${rec.action} ${rec.project} — ${trunc(rec.reason || 'operator approval required', 140)}`);
    }
  }

  // ── Recommended next actions ───────────────────────────────────────────────
  lines.push('', '→ Recommended next actions');
  const next = [];
  for (const rec of recommendations) {
    next.push(`  ashmero autopilot approve ${rec.project} ${rec.action}   # then it runs the next night`);
  }
  for (const j of failedJobs) next.push(`  ashmero resume ${j.project}   # ${j.action} failed overnight`);
  for (const r of pausedRuns) next.push(`  ashmero resume ${r.project}   # run paused overnight`);
  if (!next.length) next.push('  nothing — the fleet is idle or clean.');
  lines.push(...next);

  return lines.join('\n');
}

/**
 * OPTIONAL haiku polish — a single bounded call that tightens the prose. Called
 * ONLY when the deterministic text is long (>30 lines). Budget-guarded (never
 * runs under a paused window) and fails OPEN to the deterministic text on any
 * error / missing model / invalid reply.
 */
export async function maybePolishDigest(text, { cfg = null } = {}, deps = {}) {
  const runClaudeFn = deps.runClaude ?? runClaude;
  const windowStatusFn = deps.windowStatus ?? windowStatus;
  const model = cfg?.models?.['autopilot-digest'];
  if (!model) return text; // no model configured → deterministic text as-is

  const state = safe(() => windowStatusFn(cfg)?.state, 'ok');
  if (state === 'pause') return text; // never spend a call under a paused window

  try {
    const polishCfg = { ...cfg, model, tools: { ...(cfg?.tools || {}), allowed_default: [] } };
    delete polishCfg._effort_override;
    const res = await runClaudeFn({
      cfg: polishCfg,
      cwd: null,
      systemPromptFile: null,
      systemPromptExtra: DIGEST_SYSTEM_PROMPT,
      sessionId: null,
      role: null,
      project: null,
      phase: null,
      task: 'autopilot-digest',
      prompt: `Polish this overnight ops digest for a phone. Keep every fact, section, project name, and command verbatim.\n\n${text}`,
    });
    if (res && !res.is_error && typeof res.result === 'string' && res.result.trim()) {
      return res.result.trim();
    }
  } catch (e) {
    console.warn(`[autopilot-digest] polish failed (non-fatal): ${e.message}`);
  }
  return text; // fail OPEN to the deterministic text
}

/** Fallback "since" cutoff when no plan ran (ISO): the last ~14 hours. */
function defaultSince(now) {
  return new Date(now.getTime() - 14 * 3600 * 1000).toISOString();
}

/**
 * Compose + (optionally) polish + DELIVER the morning digest. Gathers auto_runs,
 * healing_log, and tg_jobs rows since the night's plan timestamp
 * (autopilot.last_planned_at) and the night's approval recommendations (from
 * last_plan_json). Delivery goes THROUGH brief 06's notify_outbox (queueNotify);
 * the plain notifier is used ONLY if that enqueue is genuinely unavailable.
 * Stamps last_digest_date so the digest fires at most once per calendar day.
 * Best-effort: never throws.
 *
 * @param {{cfg?: object, notifier?: object, now?: Date}} args
 * @param {object} [deps] - injectable seams for tests
 * @returns {Promise<{text, outboxId, delivered, since}>}
 */
export async function runMorningDigest({ cfg = null, notifier = null, now = new Date() } = {}, deps = {}) {
  const getStateFn = deps.getAutopilotState ?? getAutopilotState;
  const listRunsFn = deps.listAutoRunsSince ?? listAutoRunsSince;
  const listHealingFn = deps.listHealingLogSince ?? listHealingLogSince;
  const listJobsFn = deps.listJobsSince ?? listJobsSince;
  const queueNotifyFn = deps.queueNotify ?? queueNotify;
  const recordDigestFn = deps.recordAutopilotDigest ?? recordAutopilotDigest;

  const state = safe(() => getStateFn(), {});
  const since = state.last_planned_at || defaultSince(now);
  const autoRuns = safe(() => listRunsFn(since), []);
  const healing = safe(() => listHealingFn(since), []);
  const jobs = safe(() => listJobsFn(since), []);
  let recommendations = [];
  try { recommendations = JSON.parse(state.last_plan_json || '{}').recommendations || []; } catch { /* ignore */ }

  let text = composeDigest({ autoRuns, healing, jobs, recommendations, now });

  // Optional haiku polish — ONLY when the deterministic text is long.
  if (text.split('\n').length > 30) {
    text = await maybePolishDigest(text, { cfg }, deps);
  }

  // Deliver THROUGH notify_outbox (brief 06). queueNotify is sync + never-throwing
  // and returns the new row id, or null if the insert failed (table genuinely
  // absent). Fall back to the plain notifier ONLY in that null case.
  let outboxId = null;
  try { outboxId = queueNotifyFn({ project: null, text }); } catch { outboxId = null; }
  if (outboxId == null && notifier && typeof notifier.notify === 'function') {
    try { await notifier.notify({ text }); } catch { /* best-effort */ }
  }

  safe(() => recordDigestFn({ date: calendarDay(now), at: now.toISOString() }), null);
  return { text, outboxId, delivered: outboxId != null, since };
}
