// Billing Guard — enforces the four-rule fence:
//
//   1. No ANTHROPIC_API_KEY in env
//   2. Subscription billing only (cannot be programmatically verified — manual /status check)
//   3. Track window consumption, warn + pause near limits
//   4. Never fall back to pay-as-you-go (config.billing.allow_api_fallback = false)

import chalk from 'chalk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callsInLastHours, callsInLastHoursForProject, getRunningJobs, pidAlive, getProviderWindowObservation } from './state.js';
import { providerCircuitScope } from './lib/provider-circuit-breaker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PROJECTS_ROOT = path.join(REPO_ROOT, 'projects');

// A fair-share weight must be a positive number; anything else (missing, zero,
// negative, non-numeric) falls back to the documented default of 1. Kept here so
// the config default and the project.json read below agree on the same rule the
// project.schema.json `billing.priority` constraint (number > 0) enforces.
function sanitizeWeight(w) {
  return (typeof w === 'number' && Number.isFinite(w) && w > 0) ? w : 1;
}

// Best-effort async read of another live project's project-layer
// billing.priority (projects/<name>/project.json → overrides.billing.priority).
// Unreadable / absent / invalid → weight 1, never throws. Only used for the
// OTHER active projects sharing the window — the asker's own weight comes from
// its already-resolved cfg (which folds in user/profile/project layers too).
async function readProjectPriority(projectName) {
  try {
    const raw = await fs.readFile(path.join(PROJECTS_ROOT, projectName, 'project.json'), 'utf-8');
    return sanitizeWeight(JSON.parse(raw)?.overrides?.billing?.priority);
  } catch {
    return 1;
  }
}

export function preflightCheck(cfg) {
  const errors = [];
  const warnings = [];

  // Rule 1 — API key in env is forbidden
  if (process.env.ANTHROPIC_API_KEY) {
    errors.push(
      'ANTHROPIC_API_KEY is set in your environment. This would bypass your Max plan and bill pay-as-you-go.\n' +
      '   Run: unset ANTHROPIC_API_KEY (and remove it from ~/.zshrc if present)',
    );
  }

  // Rule 4 — explicit allow_api_fallback check
  if (cfg.billing.allow_api_fallback === true) {
    errors.push(
      'config.billing.allow_api_fallback is true. This permits overage billing.\n' +
      '   Set it to false in config/defaults.json or your project overrides.',
    );
  }

  // Mode sanity
  const validModes = ['max_pooled', 'agent_sdk_credit', 'interactive_tmux'];
  if (!validModes.includes(cfg.billing.mode)) {
    warnings.push(`Unknown billing mode: ${cfg.billing.mode}`);
  }

  // June 15, 2026 advisory
  const cutover = new Date('2026-06-15T00:00:00Z');
  const now = new Date();
  if (now >= cutover && cfg.billing.mode === 'max_pooled') {
    warnings.push(
      'Today is past June 15 2026. `claude -p` may now draw from Agent SDK credit, not Max pool.\n' +
      '   Verify with `claude /status` and consider switching billing.mode to "agent_sdk_credit".',
    );
  }

  return { errors, warnings };
}

const HOUR_MS = 3600 * 1000;
const DEFAULT_CHEAP_TASKS = Object.freeze([
  'ledger-extract', 'autopsy', 'autopilot-digest',
]);
const DEFAULT_CHEAP_CALL_WEIGHT = 0.25;

function roundBillingUnits(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

/**
 * Resolve how much one bounded helper attempt consumes from call-based window
 * admission. The task allowlist is deliberately shared with the account-wide
 * heavy-call lease config: unknown/future task ids remain one full unit, while
 * an explicit heavy_tasks entry wins when an operator accidentally lists a
 * task in both arrays. A cheap attempt is never free (weight must be > 0), so
 * retries and errored subprocess attempts continue to move the window meter.
 */
export function billingCallWeight(cfg, callOrTask) {
  const lease = cfg?.billing?.heavy_call_lease || {};
  const task = typeof callOrTask === 'string' ? callOrTask : callOrTask?.task;
  const cheapTasks = new Set(Array.isArray(lease.cheap_tasks) ? lease.cheap_tasks : DEFAULT_CHEAP_TASKS);
  const heavyTasks = new Set(Array.isArray(lease.heavy_tasks) ? lease.heavy_tasks : []);
  const configuredWeight = Number(lease.cheap_call_weight);
  const cheapWeight = Number.isFinite(configuredWeight) && configuredWeight >= 0.01 && configuredWeight <= 1
    ? configuredWeight
    : DEFAULT_CHEAP_CALL_WEIGHT;

  if (!task || heavyTasks.has(task)) return 1;
  return cheapTasks.has(task) ? cheapWeight : 1;
}

/** Sum raw call rows as heavy-equivalent billing-window admission units. */
export function heavyEquivalentCallUnits(calls, cfg) {
  return roundBillingUnits((calls || []).reduce(
    (sum, call) => sum + billingCallWeight(cfg, call),
    0,
  ));
}

/**
 * Phase 63 (P7) — pure reclaim summary for a set of already-in-window calls.
 * Each attempt ages out of the rolling window at `started_at + windowHours`; the
 * "next reclaim" is the soonest such age-out in the future, and `count` is how
 * many calls age out in the same ~minute (they free up together). Powers both
 * windowStatus().reclaim (→ WindowGauge's "+12 calls reclaim in 48m" line) and
 * forecastRun's mid-run reclaim walk. No DB read — the caller passes the rows.
 *
 * @param {Array<{started_at:string}>} recentCalls - callsInLastHours(hours) rows
 * @param {number} windowHours
 * @param {number} [now=Date.now()] - reference clock (ms); injectable for tests
 * @param {Object|null} [cfg=null] - optional billing config for weighted units
 * @returns {{ next:string|null, inMs:number|null, count:number, units:number, windowHours:number }}
 */
export function summarizeReclaim(recentCalls, windowHours, now = Date.now(), cfg = null) {
  const hours = windowHours || 5;
  const windowMs = hours * HOUR_MS;
  const expiring = (recentCalls || [])
    .map((call) => ({ call, at: new Date(call.started_at).getTime() + windowMs }))
    .filter((row) => Number.isFinite(row.at) && row.at > now)
    .sort((a, b) => a.at - b.at);
  if (expiring.length === 0) {
    return { next: null, inMs: null, count: 0, units: 0, windowHours: hours };
  }
  const nextAt = expiring[0].at;
  const BUCKET_MS = 60 * 1000; // calls aging out within the same minute reclaim together
  const bucket = expiring.filter((row) => row.at <= nextAt + BUCKET_MS);
  return {
    next: new Date(nextAt).toISOString(),
    inMs: nextAt - now,
    count: bucket.length,
    units: heavyEquivalentCallUnits(bucket.map((row) => row.call), cfg),
    windowHours: hours,
  };
}

/**
 * Find the exact ms timestamp when rolling-window units will drop BELOW
 * pauseThreshold — i.e. the first moment a new call can proceed. Iterates
 * calls sorted by expiry order, subtracting their weight, until the running
 * total falls under the threshold. This is more accurate than using
 * oldestCallAt + windowHours because cheap calls (0.25 weight) expiring first
 * often don't move the needle enough to unblock the window.
 *
 * Returns null if already below threshold, or now+windowMs as a fallback
 * if somehow no subset clears it (should not happen in practice).
 */
export function pauseClearAt(calls, windowHours, pauseThreshold, cfg, now = Date.now(), targetThreshold = pauseThreshold) {
  const windowMs = (windowHours || 5) * HOUR_MS;
  let units = heavyEquivalentCallUnits(calls, cfg);
  if (units < targetThreshold) return null;

  const expiring = (calls || [])
    .map((c) => ({ weight: billingCallWeight(cfg, c), expiresAt: new Date(c.started_at).getTime() + windowMs }))
    .filter((r) => Number.isFinite(r.expiresAt) && r.expiresAt >= now)
    .sort((a, b) => a.expiresAt - b.expiresAt);

  for (const { weight, expiresAt } of expiring) {
    units = roundBillingUnits(units - weight);
    if (units < targetThreshold) return expiresAt;
  }
  return now + windowMs;
}

export function windowStatus(cfg) {
  const hours = cfg.billing.window_reset_hours || 5;
  const recent = callsInLastHours(hours);
  const rawCount = recent.length;
  const units = heavyEquivalentCallUnits(recent, cfg);
  const totalCost = recent.reduce((sum, c) => sum + (c.cost_usd || 0), 0);

  const warnCalls  = cfg.billing.warn_at_calls  ?? 50;
  const pauseCalls = cfg.billing.pause_at_calls ?? 80;
  // Token-derived dollar estimates are useful telemetry on a Max subscription,
  // but they are not an account limit. They pause only under an explicit opt-in;
  // provider-window units and real provider limit events remain authoritative.
  // Fallbacks match config/defaults.json (18/24) — a migrated snapshot that
  // predates warn_at_cost_usd must behave like the shipped defaults, not a
  // stale 30/60 policy.
  const warnCost   = cfg.billing.warn_at_cost_usd  ?? 18;
  const pauseCost  = cfg.billing.pause_at_cost_usd ?? 24;
  const costThresholdsEnforced = cfg.billing.enforce_cost_thresholds === true;

  let state = 'ok';
  if (units >= pauseCalls || (costThresholdsEnforced && totalCost >= pauseCost))      state = 'pause';
  else if (units >= warnCalls || (costThresholdsEnforced && totalCost >= warnCost))   state = 'warn';

  // Provider-authoritative override: the CLI streams a five_hour utilization
  // figure on essentially every call, and it meters the ACTUAL Max-plan window
  // (tokens, account-wide across Mac+NAS) while `units` counts only this DB's
  // calls. When a fresh observation exists (≤10 min), its utilization can only
  // TIGHTEN the state — a low provider figure never relaxes the local counter,
  // so the call-count backstop still protects windows with stale telemetry.
  let provider = null;
  try {
    const scope = providerCircuitScope(cfg);
    const obs = getProviderWindowObservation(scope.provider, scope.account, 'five_hour');
    const freshMs = (cfg.billing?.provider_observation_fresh_minutes ?? 10) * 60 * 1000;
    if (obs && Date.now() - obs.observed_at_ms <= freshMs && Number.isFinite(obs.utilization)) {
      provider = { utilization: obs.utilization, resetsAtMs: obs.resets_at_ms, status: obs.status, observedAtMs: obs.observed_at_ms };
      const pauseUtil = cfg.billing?.provider_pause_utilization ?? 0.97;
      const warnUtil  = cfg.billing?.provider_warn_utilization  ?? 0.85;
      if (obs.utilization >= pauseUtil || obs.status === 'rejected') state = 'pause';
      else if (obs.utilization >= warnUtil && state === 'ok') state = 'warn';
    }
  } catch { /* observation read is best-effort — the unit proxy stands alone */ }

  return {
    state,
    providerWindow: provider,
    // Compatibility/admission field: all existing hard-pause, headroom,
    // forecast and queue consumers now operate on heavy-equivalent units.
    callsInWindow: units,
    heavyEquivalentCallsInWindow: units,
    // Observability field: the exact number of subprocess attempts recorded.
    rawCallsInWindow: rawCount,
    windowHours: hours,
    warnThreshold: warnCalls,
    pauseThreshold: pauseCalls,
    warnCostThreshold: warnCost,
    pauseCostThreshold: pauseCost,
    costThresholdsEnforced,
    totalCostInWindow: totalCost,
    oldestCallAt: recent.length ? recent[recent.length - 1].started_at : null,
    // Phase 63 (P7) — when the oldest window attempts age out. `units` drives
    // admission; `count` preserves the raw attempts in that reclaim bucket.
    reclaim: summarizeReclaim(recent, hours, Date.now(), cfg),
    // Exact ms timestamp when units will drop BELOW pauseThreshold (the real
    // unblock time). More accurate than oldestCallAt+windowHours when the
    // oldest call is cheap (0.25 weight) and its expiry alone doesn't clear
    // the threshold. null when already below threshold.
    pauseClearAt: pauseClearAt(recent, hours, pauseCalls, cfg),
    // Same computation targeting the warn threshold — used by
    // maybePauseForWindowHeadroom to find the true resume time in warn state
    // (units < pauseCalls so pauseClearAt is always null there).
    warnClearAt: pauseClearAt(recent, hours, warnCalls, cfg),
  };
}

export function shouldPause(cfg) {
  const status = windowStatus(cfg);
  return status.state === 'pause';
}

/**
 * Weekly usage summary for the Claude Max plan usage panel.
 * Counts calls in the last 168h (7 days) and computes the next weekly reset.
 *
 * billing.weekly_reset_day (0=Sun…6=Sat, default 1=Mon) controls which
 * weekday the Max plan billing week starts — set to match your actual plan.
 */
export function weeklyUsage(cfg) {
  const resetDay = cfg.billing.weekly_reset_day ?? 1;
  const now = new Date();

  // Find the most recent weekly-reset boundary (resetDay at midnight UTC).
  // daysSinceReset: 0 if today is the reset day, 1..6 otherwise.
  const daysSinceReset = (now.getUTCDay() - resetDay + 7) % 7;
  const lastResetAt = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceReset,
  ));
  const hoursSinceReset = (now.getTime() - lastResetAt.getTime()) / HOUR_MS;

  const recent = callsInLastHours(hoursSinceReset);
  const count = recent.length;
  const totalCost = recent.reduce((sum, c) => sum + (c.cost_usd || 0), 0);

  let daysUntil = (resetDay - now.getUTCDay() + 7) % 7 || 7;
  const nextReset = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntil,
  ));

  return {
    callsThisWeek: count,
    costThisWeek: totalCost,
    nextResetAt: nextReset.toISOString(),
    nextResetInMs: nextReset.getTime() - Date.now(),
  };
}

/**
 * Phase 54 (par-07) — fair-share view of the shared billing window.
 *
 * The window (windowStatus / callsInLastHours) is a single GLOBAL pool with no
 * project filter, so two concurrent projects race each other toward the same
 * pause threshold and the loser dies mid-phase. fairShareStatus answers the
 * narrower question a spawner needs at admission time: "am I over MY slice of
 * the pool right now?" — where each active project's slice is
 *   pause_at_calls * weight / sum(active weights)
 * weighted by its project-layer billing.priority (default 1).
 *
 * The active set is every running_jobs claim whose pid is still alive, PLUS the
 * asking project itself (it may not have claimed a row yet — it is about to
 * spawn). The asker's weight comes from its resolved cfg.billing.priority; the
 * other projects' weights are read best-effort from their project.json.
 *
 * Async only because the default weight resolver reads project.json via
 * fs/promises (repo convention: no sync file IO). Advisory-only — a rejected
 * read degrades to weight 1; it never fails a real call.
 *
 * @param {Object} cfg - the ASKER's resolved config (reads billing.window_reset_hours,
 *   billing.pause_at_calls, billing.priority)
 * @param {string} projectName - the asking project
 * @param {Object} [deps] - test seams (each defaults to the production impl)
 * @param {Function} [deps.runningJobs] - () => running_jobs rows
 * @param {Function} [deps.isAlive] - (pid) => boolean
 * @param {Function} [deps.callsForProject] - (hours, project) => call rows
 * @param {Function} [deps.weightForProject] - (name) => number|Promise<number>;
 *   overrides BOTH the cfg-based asker weight and the project.json read
 * @returns {Promise<{activeCount:number, share:number, projectCalls:number, rawProjectCalls:number, overShare:boolean}>}
 */
export async function fairShareStatus(cfg, projectName, {
  runningJobs = getRunningJobs,
  isAlive = pidAlive,
  callsForProject = callsInLastHoursForProject,
  weightForProject = null,
} = {}) {
  const hours = cfg.billing.window_reset_hours || 5;
  const pauseCalls = cfg.billing.pause_at_calls ?? 80;

  // Active set: live claims + the asker (deduped).
  const activeNames = new Set([projectName]);
  for (const row of runningJobs()) {
    if (row?.project && isAlive(row.pid)) activeNames.add(row.project);
  }

  // Resolve each active project's weight. weightForProject (test seam) wins
  // outright; otherwise the asker uses its resolved cfg, others read project.json.
  const resolveWeight = weightForProject
    ? (name) => weightForProject(name)
    : (name) => (name === projectName
        ? sanitizeWeight(cfg.billing.priority)
        : readProjectPriority(name));

  let sumWeights = 0;
  let myWeight = 1;
  for (const name of activeNames) {
    const w = sanitizeWeight(await resolveWeight(name));
    sumWeights += w;
    if (name === projectName) myWeight = w;
  }

  const share = pauseCalls * myWeight / sumWeights;
  const projectRows = callsForProject(hours, projectName);
  const projectCalls = heavyEquivalentCallUnits(projectRows, cfg);

  return {
    activeCount: activeNames.size,
    share,
    projectCalls,
    rawProjectCalls: projectRows.length,
    overShare: projectCalls >= share,
  };
}

export function renderStatus(cfg) {
  const s = windowStatus(cfg);
  const stateColor = s.state === 'ok' ? chalk.green : s.state === 'warn' ? chalk.yellow : chalk.red;

  const lines = [
    chalk.bold('Window Status'),
    `  Mode:       ${cfg.billing.mode}`,
    `  Units:      ${stateColor(s.callsInWindow)} / warn ${s.warnThreshold} / pause ${s.pauseThreshold} (heavy-equivalent)`,
    `  Attempts:   ${s.rawCallsInWindow} raw subprocess calls`,
    `  Cost:       ${stateColor('$' + s.totalCostInWindow.toFixed(2))} / warn $${s.warnCostThreshold} / pause $${s.pauseCostThreshold} (${s.costThresholdsEnforced ? 'enforced' : 'monitor-only on Max plan'})`,
    `  Window:     last ${s.windowHours}h`,
    `  State:      ${stateColor(s.state.toUpperCase())}`,
  ];
  return lines.join('\n');
}
