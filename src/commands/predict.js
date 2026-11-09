// Cost Prediction v0.9 — predicts the cost of upcoming work before kicking off.
//
// Algorithm:
//   1. Identify upcoming work: remaining phases OR current bug round's fixes
//   2. For each unit of work, simulate routing (calls routeModel, makes no API call)
//   3. Multiply by historical averages from SQLite `calls` table grouped by (model, task)
//   4. Render a table + budget impact check
//
// Used by:
//   - `npm run predict -- <project>` (standalone)
//   - `npm run go` flow (shown before execution, optional y/n prompt)

import path from 'node:path';
import fs from 'node:fs/promises';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';

import { getProject, getDb, callsInLastHours } from '../state.js';
import { resolve as resolveConfig } from '../config-resolver.js';
import { routeModel } from '../model-router.js';
import { windowStatus, summarizeReclaim, billingCallWeight } from '../billing-guard.js';
import { planJsonPath, fixPlanJsonPath, detectHighestBugRound } from '../lib/guide-paths.js';
import { projectCallCount, getProjectCallCap } from './budget-guard.js';

const HOUR_MS = 3600 * 1000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

// Hardcoded fallbacks for when no historical data exists for a (model, task) combo.
// These are intentionally on the high side — better to over-predict than surprise
// the user. Re-based 2026-07-20 on 19 days of calls telemetry (the old sonnet
// fallback of $0.04 was ~100x under the observed $3.45/call average, and fable
// had no entry at all — it fell back to that same stale sonnet figure).
const FALLBACK_COST = {
  fable:  { cost_usd: 8.0, duration_ms: 150000 },
  opus:   { cost_usd: 5.0, duration_ms: 120000 },
  sonnet: { cost_usd: 4.0, duration_ms: 90000 },
  haiku:  { cost_usd: 0.1, duration_ms: 15000 },
};

const TIER_BY_MODEL_PREFIX = {
  'claude-fable':   'fable',
  'claude-opus':    'opus',
  'claude-sonnet':  'sonnet',
  'claude-haiku':   'haiku',
};

function modelTier(model) {
  for (const [prefix, tier] of Object.entries(TIER_BY_MODEL_PREFIX)) {
    if (model && model.startsWith(prefix)) return tier;
  }
  return 'sonnet'; // safe fallback
}

async function readJson(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf-8')); } catch { return null; }
}

/**
 * Returns historical averages for a (model, task) combo from the calls table.
 * If no data, falls back to tier defaults.
 *
 * @returns {{ cost_usd: number, duration_ms: number, sample_size: number, fallback: boolean }}
 */
function historicalAverage(model, task) {
  const db = getDb();
  const row = db.prepare(
    `SELECT AVG(cost_usd) AS avg_cost, AVG(duration_ms) AS avg_dur, COUNT(*) AS n
     FROM calls
     WHERE model = ? AND task = ? AND is_error = 0
       AND cost_usd IS NOT NULL`,
  ).get(model, task);

  if (row && row.n > 0 && row.avg_cost != null) {
    return {
      cost_usd: row.avg_cost,
      duration_ms: row.avg_dur || 0,
      sample_size: row.n,
      fallback: false,
    };
  }

  // Fall back to tier-level avg for the same model across all tasks
  const tierRow = db.prepare(
    `SELECT AVG(cost_usd) AS avg_cost, AVG(duration_ms) AS avg_dur, COUNT(*) AS n
     FROM calls
     WHERE model = ? AND is_error = 0 AND cost_usd IS NOT NULL`,
  ).get(model);

  if (tierRow && tierRow.n > 0 && tierRow.avg_cost != null) {
    return {
      cost_usd: tierRow.avg_cost,
      duration_ms: tierRow.avg_dur || 0,
      sample_size: tierRow.n,
      fallback: false,
    };
  }

  // Last resort: hardcoded tier defaults
  const tier = modelTier(model);
  const def = FALLBACK_COST[tier] || FALLBACK_COST.sonnet;
  return { ...def, sample_size: 0, fallback: true };
}

/**
 * Phase 63 (P7) — would the acceptance checker actually fire for this phase?
 * Mirrors verify-loop's gate cheaply so the forecast unit builder counts the
 * per-phase acceptance-check call (a real window call) instead of pretending a
 * `go` run is dev-only. Conservative: verify off, or a criteria-less phase
 * under skip_when_no_criteria (default on), means no checker call. Pure over
 * cfg + the plan phase spec — no fs, no routing.
 */
export function shouldPredictAcceptanceCheck(cfg, phaseMeta) {
  const verify = cfg?.verify || {};
  if (verify.enabled === false) return false;
  const criteria = phaseMeta?.acceptance_criteria;
  if (verify.skip_when_no_criteria !== false && !(Array.isArray(criteria) && criteria.length > 0)) {
    return false;
  }
  return true;
}

/**
 * Predicts upcoming work for a project.
 *
 * @returns {{ mode: 'phases'|'bug-round'|'idle', units: Array, totals: object, budget: object }}
 */
export async function predictUpcoming(projectName) {
  const project = getProject(projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);

  const projDir = path.join(PROJECTS_DIR, projectName);
  const cfg = await resolveConfig({ project: projectName, task: 'dev-execution' });

  // Detect if we're in a bug round or in normal phases
  const highestRound = await detectHighestBugRound(projDir);
  const bugPlan = highestRound ? await readJson(fixPlanJsonPath(projDir, highestRound)) : null;
  const inBugRound = !!(bugPlan && bugPlan.fixes && bugPlan.fixes.length > 0);

  const plan = await readJson(planJsonPath(projDir));
  const totalPhases = plan?.phases?.length || project.total_phases || 0;
  const remainingPhases = Math.max(0, totalPhases - (project.current_phase || 0));

  const units = [];

  if (inBugRound) {
    // Bug round prediction
    // v0.14.40: fix-prompt guide calls only happen with inline_fix_prompts
    // off (v0.14.37 default is inline) — predict must mirror the runtime or
    // it overestimates every fix by one sonnet call.
    const fixPromptGenRuns = cfg.fixes?.inline_fix_prompts === false;
    for (const fix of bugPlan.fixes) {
      // fix-prompt: guide call (usually sonnet) — only when not inlined
      const promptRouting = fixPromptGenRuns ? await routeModel({
        cfg, task: 'fix-prompt-gen', phaseMeta: null, projectName,
      }) : null;
      // fix-execution: dev call, route on the fix's metadata
      const execRouting = await routeModel({
        cfg, task: 'fix-execution',
        phaseMeta: {
          title: fix.title || '',
          goal: fix.description || fix.what || '',
          notes: fix.notes || '',
          acceptance_criteria: fix.acceptance_criteria || [],
        },
        projectName,
      });

      if (promptRouting) {
        units.push({
          label: `fix r${highestRound}.${fix.n}`,
          title: fix.title || `fix ${fix.n}`,
          task: 'fix-prompt-gen',
          model: promptRouting.model,
        });
      }
      units.push({
        label: `fix r${highestRound}.${fix.n}`,
        title: fix.title || `fix ${fix.n}`,
        task: 'fix-execution',
        model: execRouting.model,
      });
    }
  } else if (remainingPhases > 0) {
    // Normal phase prediction
    const reviewEvery = cfg.review?.run_every_n_phases || 3;
    for (let i = project.current_phase + 1; i <= totalPhases; i += 1) {
      const phaseMeta = plan?.phases?.find((p) => p.n === i) || null;

      // v0.14.40: phase prompt-gen only runs with inline_phase_prompts off
      // (v0.14.35 default is inline; reprompts are exceptional, not priced).
      const phasePromptGenRuns = cfg.phases?.inline_phase_prompts === false;
      const promptRouting = phasePromptGenRuns ? await routeModel({
        cfg, task: 'phase-prompt-gen', phaseMeta, projectName,
      }) : null;
      const execRouting = await routeModel({
        cfg, task: 'dev-execution', phaseMeta, projectName,
      });

      if (promptRouting) {
        units.push({
          label: `phase ${i}`,
          title: phaseMeta?.title || `phase ${i}`,
          task: 'phase-prompt-gen',
          model: promptRouting.model,
          phase: i,
        });
      }
      units.push({
        label: `phase ${i}`,
        title: phaseMeta?.title || `phase ${i}`,
        task: 'dev-execution',
        model: execRouting.model,
        phase: i,
      });

      // Phase 63 (P7, verdict correction a): the per-phase acceptance-check is a
      // real window call on every `go` run with verify enabled — count it in the
      // unit stream so the forecast walker spends it, rather than fudging the
      // walker. The checker runs on models['acceptance-check'] (verify-loop's
      // flat baseline before tiering), not the dev tier.
      if (shouldPredictAcceptanceCheck(cfg, phaseMeta)) {
        units.push({
          label: `phase ${i}`,
          title: phaseMeta?.title || `phase ${i}`,
          task: 'acceptance-check',
          model: cfg.models?.['acceptance-check'] || execRouting.model,
          phase: i,
        });
      }

      // Reviews after every N phases
      if (i % reviewEvery === 0 || i === totalPhases) {
        const reviewRouting = await routeModel({
          cfg, task: '3-phase-review', phaseMeta: null, projectName,
        });
        units.push({
          label: `review after ${i}`,
          title: `review`,
          task: '3-phase-review',
          model: reviewRouting.model,
          phase: i,
        });
      }
    }
  }

  // Attach historical averages to each unit
  let totalCost = 0;
  let totalDur = 0;
  let fallbackCount = 0;
  for (const u of units) {
    const hist = historicalAverage(u.model, u.task);
    u.cost_usd = hist.cost_usd;
    u.duration_ms = hist.duration_ms;
    u.sample_size = hist.sample_size;
    u.fallback = hist.fallback;
    totalCost += u.cost_usd;
    totalDur += u.duration_ms;
    if (u.fallback) fallbackCount += 1;
  }

  // Budget impact
  const callsInThisRun = units.length;
  const cap = getProjectCallCap(cfg, projectName);
  const currentCount = projectCallCount(projectName);
  const remaining = cap ? cap - currentCount : null;
  const afterRun = currentCount + callsInThisRun;
  const budget = {
    cap,
    current: currentCount,
    remaining,
    afterRun,
    pctAfter: cap ? (afterRun / cap) * 100 : null,
    wouldExceed: cap ? afterRun > cap : false,
  };

  return {
    mode: inBugRound ? 'bug-round' : (remainingPhases > 0 ? 'phases' : 'idle'),
    bugRound: inBugRound ? highestRound : null,
    units,
    totals: {
      calls: units.length,
      cost_usd: totalCost,
      duration_ms: totalDur,
      fallbackCount,
    },
    budget,
  };
}

/**
 * Renders a prediction as terminal output. Returns the rendered string for
 * programmatic use (e.g. Telegram).
 */
export function renderPrediction(prediction, { compact = false } = {}) {
  const lines = [];

  if (prediction.mode === 'idle') {
    lines.push(chalk.dim('  No upcoming work — project is at current_phase = total_phases and no active bug round.'));
    return lines.join('\n');
  }

  const modeLabel = prediction.mode === 'bug-round'
    ? `bug round ${prediction.bugRound} (${prediction.units.length / 2} fixes)`
    : 'remaining phases';

  lines.push(chalk.bold(`\nPredicted: ${modeLabel}`));
  lines.push('');

  if (!compact) {
    // Detailed table
    lines.push(
      '  ' + pad('Unit', 22) + pad('Task', 22) + pad('Model', 28) + pad('Cost', 10) + pad('Time', 10),
    );
    lines.push(chalk.dim('  ' + '─'.repeat(92)));
    for (const u of prediction.units) {
      const titleShort = u.title.length > 18 ? u.title.slice(0, 17) + '…' : u.title;
      const modelShort = u.model.length > 26 ? u.model.slice(0, 25) + '…' : u.model;
      const cost = u.fallback ? chalk.dim(`~$${u.cost_usd.toFixed(2)}`) : `$${u.cost_usd.toFixed(2)}`;
      const time = formatDuration(u.duration_ms);
      lines.push(
        '  ' + pad(u.label + (titleShort ? ` (${titleShort})` : ''), 22)
        + pad(u.task, 22)
        + pad(modelShort, 28)
        + pad(cost, 10)
        + pad(time, 10),
      );
    }
    lines.push(chalk.dim('  ' + '─'.repeat(92)));
  }

  // Totals
  const totalCost = `$${prediction.totals.cost_usd.toFixed(2)}`;
  const totalTime = formatDuration(prediction.totals.duration_ms);
  lines.push(
    '  ' + chalk.bold(pad('TOTAL', 22) + pad(`${prediction.totals.calls} calls`, 22) + pad('', 28))
    + chalk.bold(pad(totalCost, 10) + pad(totalTime, 10)),
  );
  if (prediction.totals.fallbackCount > 0) {
    lines.push(chalk.dim(`  (${prediction.totals.fallbackCount} unit(s) use fallback estimates — no historical data for that model/task)`));
  }

  // Budget impact
  lines.push('');
  lines.push(chalk.bold('Budget impact:'));
  const b = prediction.budget;
  lines.push(`  Window calls before:   ${chalk.dim(b.current)}`);
  if (b.cap !== null) {
    const pctColor = b.pctAfter >= 100 ? chalk.red : b.pctAfter >= 90 ? chalk.yellow : chalk.green;
    lines.push(`  Project cap:           ${b.cap}`);
    lines.push(`  After this run:        ${pctColor(b.afterRun + '/' + b.cap + ' (' + b.pctAfter.toFixed(0) + '%)')}`);
    if (b.wouldExceed) {
      lines.push(chalk.red(`  ⚠  Would exceed cap. Bump max_total_calls in project.json or run with --ignore-budget.`));
    }
  } else {
    lines.push(`  Project cap:           ${chalk.dim('(no cap set)')}`);
    lines.push(`  After this run:        ${b.afterRun} (no cap)`);
  }

  return lines.join('\n');
}

function pad(s, w) {
  s = String(s);
  if (stripAnsi(s).length >= w) {
    // Don't truncate colored strings — just don't pad
    return s + ' ';
  }
  return s + ' '.repeat(w - stripAnsi(s).length);
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function formatDuration(ms) {
  if (!ms || ms < 1000) return '<1s';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/**
 * Interactive y/n prompt. Returns true if user confirms.
 * In non-TTY environments (server, piped), always returns true.
 */
export async function confirmPrediction(prediction, { threshold = 1.00, autoYes = false } = {}) {
  if (autoYes) return true;
  if (!process.stdin.isTTY) return true;
  // Only prompt if predicted cost meets threshold OR budget would be exceeded
  const promptNeeded = prediction.totals.cost_usd >= threshold || prediction.budget.wouldExceed;
  if (!promptNeeded) return true;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise((res) => {
    rl.question(chalk.yellow(`\nProceed? [y/N] `), (a) => { rl.close(); res(a); });
  });
  return /^y(es)?$/i.test(ans.trim());
}

// ─── Pre-flight run forecast (Phase 63 / P7) ─────────────────────────────────
//
// Combines predictUpcoming's per-unit estimates with the LIVE 5-hour window
// (windowStatus thresholds + callsInLastHours reclaim timestamps) to answer the
// one question the plain cost predictor never could: "will this run FIT, or
// will it burn half the window and pause mid-phase?". Deterministic — no LLM,
// no API call anywhere in this path. The heavy lifting is a pure simulator so
// the edge cases (empty window, mid-run reclaim, cost-bound crossing, no
// history) are fixture-testable without a DB.

/**
 * Historical per-task error rate from the calls table — the fraction of that
 * task's calls that errored. Drives the "expected extra attempts" a unit costs
 * (a reprompt/escalation is a second window call). Div-by-zero guarded: no rows
 * → { rate: 0, n: 0 } (and n===0 marks the forecast low-confidence upstream).
 */
export function taskErrorRate(task) {
  const db = getDb();
  const row = db.prepare(
    `SELECT AVG(CASE WHEN is_error = 1 THEN 1.0 ELSE 0.0 END) AS rate, COUNT(*) AS n
     FROM calls WHERE task = ?`,
  ).get(task);
  if (row && row.n > 0 && row.rate != null) return { rate: row.rate, n: row.n };
  return { rate: 0, n: 0 };
}

/**
 * PURE forecast walker. Advances a simulated clock unit-by-unit; at each step
 * reclaims any window call that has aged out (started_at + windowMs ≤ clock),
 * then spends the unit's `expected_calls` / `expected_cost`. Pauses the instant
 * either the call OR the cost threshold would be crossed — a pause is calls OR
 * cost (verdict correction b). No DB / config / Date.now — every input is
 * passed in.
 *
 * @param {Object} a
 * @param {Array}  a.units - execution order; each { duration_ms, expected_calls, expected_cost, phase }
 * @param {Array<number|{at:number,units:number}>} a.reclaimAtMs - absolute ms
 *   and admission units each in-window attempt reclaims (legacy numbers = 1)
 * @param {number} a.callsInWindow
 * @param {number} a.costInWindow
 * @param {number} a.pauseCalls
 * @param {number} a.pauseCost
 * @param {number} a.windowMs
 * @param {number} a.now - simulated clock start (ms)
 * @param {number} [a.startDelayMs=0] - delay the start (used by the wait search)
 */
export function simulateForecast({
  units, reclaimAtMs, callsInWindow, costInWindow,
  pauseCalls, pauseCost, windowMs, now, startDelayMs = 0,
}) {
  const existing = (reclaimAtMs || [])
    .map((entry) => (typeof entry === 'number'
      ? { at: entry, units: 1 }
      : { at: Number(entry?.at), units: Number(entry?.units) || 1 }))
    .filter((entry) => Number.isFinite(entry.at))
    .sort((a, b) => a.at - b.at);
  // Cost is a window aggregate, not per-call, so age it out proportionally as
  // the calls behind it expire.
  const costPerExisting = existing.length > 0 ? costInWindow / existing.length : 0;

  let clock = now + Math.max(0, startDelayMs);
  let calls = callsInWindow;
  let cost = costInWindow;
  let ei = 0;
  const futureReclaims = []; // this run's own calls, aging out windowMs later

  const reclaimUpTo = (t) => {
    while (ei < existing.length && existing[ei].at <= t) {
      calls = Math.max(0, calls - existing[ei].units);
      cost = Math.max(0, cost - costPerExisting);
      ei += 1;
    }
    for (const fr of futureReclaims) {
      if (!fr.done && fr.at <= t) {
        calls = Math.max(0, calls - fr.count);
        cost = Math.max(0, cost - fr.cost);
        fr.done = true;
      }
    }
  };

  const round2 = (n) => Math.round(n * 100) / 100;
  let etaMs = 0;
  let peakCalls = calls;
  let peakCost = cost;

  for (let i = 0; i < units.length; i += 1) {
    const u = units[i];
    reclaimUpTo(clock);
    const spendCalls = u.expected_calls != null ? u.expected_calls : 1;
    const spendCost = u.expected_cost != null ? u.expected_cost : (u.cost_usd || 0);
    const newCalls = calls + spendCalls;
    const newCost = cost + spendCost;
    const overCalls = newCalls > pauseCalls;
    const overCost = newCost > pauseCost;
    if (overCalls || overCost) {
      return {
        fitsInWindow: false,
        pauseAtUnit: i,
        pauseAtPhase: u.phase != null ? u.phase : null,
        pauseReason: overCost && !overCalls ? 'cost' : (overCalls && !overCost ? 'calls' : 'calls+cost'),
        etaMs,
        callsShort: overCalls ? round2(newCalls - pauseCalls) : 0,
        costShort: overCost ? round2(newCost - pauseCost) : 0,
        peakCalls: round2(Math.max(peakCalls, newCalls)),
        peakCost: round2(Math.max(peakCost, newCost)),
      };
    }
    calls = newCalls;
    cost = newCost;
    peakCalls = Math.max(peakCalls, calls);
    peakCost = Math.max(peakCost, cost);
    futureReclaims.push({ at: clock + windowMs, count: spendCalls, cost: spendCost, done: false });
    clock += (u.duration_ms || 0);
    etaMs += (u.duration_ms || 0);
  }

  return {
    fitsInWindow: true,
    pauseAtUnit: null,
    pauseAtPhase: null,
    pauseReason: null,
    etaMs,
    callsShort: 0,
    costShort: 0,
    peakCalls: round2(peakCalls),
    peakCost: round2(peakCost),
  };
}

/**
 * Smallest start delay (ms) after which the WHOLE run fits, or null if no wait
 * helps (the run itself needs more than a full window's admission units/cost).
 * Candidate delays are the reclaim instants of the current window attempts — the
 * only times the picture changes — so this is a short bounded scan, not a
 * continuous search.
 */
export function computeWaitForFullFit(baseArgs) {
  const existing = (baseArgs.reclaimAtMs || [])
    .map((entry) => (typeof entry === 'number' ? entry : Number(entry?.at)))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const candidates = [0];
  for (const t of existing) {
    const d = (t - baseArgs.now) + 1; // +1ms so the call at t counts as reclaimed
    if (d > 0) candidates.push(d);
  }
  for (const d of candidates) {
    if (simulateForecast({ ...baseArgs, startDelayMs: d }).fitsInWindow) return d;
  }
  return null;
}

/**
 * PURE assembly of the public forecast object from already-gathered inputs
 * (units carrying expected_calls/cost, the windowStatus snapshot, the raw
 * in-window call rows, and a clock). forecastRun() is the thin DB/config-reading
 * wrapper over this; tests drive this directly with synthetic histories.
 */
export function buildForecast({ projectName, mode, units, ws, recent, now, lowConfidence, cfg = null }) {
  const windowHours = ws.windowHours || 5;
  const windowMs = windowHours * HOUR_MS;
  const pauseCalls = ws.pauseThreshold;
  const pauseCost = ws.costThresholdsEnforced === false
    ? Number.POSITIVE_INFINITY
    : ws.pauseCostThreshold;

  const reclaimAtMs = (recent || [])
    .map((c) => ({
      at: new Date(c.started_at).getTime() + windowMs,
      units: billingCallWeight(cfg, c),
    }))
    .filter((entry) => Number.isFinite(entry.at));

  const baseArgs = {
    units,
    reclaimAtMs,
    callsInWindow: ws.callsInWindow,
    costInWindow: ws.totalCostInWindow,
    pauseCalls,
    pauseCost,
    windowMs,
    now,
  };

  const sim = simulateForecast(baseArgs);
  const waitForFullFitMs = sim.fitsInWindow ? 0 : computeWaitForFullFit(baseArgs);

  const totalExpectedCalls = units.reduce((s, u) => s + (u.expected_calls != null ? u.expected_calls : 1), 0);
  const totalExpectedRawCalls = units.reduce(
    (s, u) => s + (u.expected_raw_calls != null ? u.expected_raw_calls : 1),
    0,
  );
  const totalExpectedCost = units.reduce((s, u) => s + (u.expected_cost != null ? u.expected_cost : (u.cost_usd || 0)), 0);
  const windowCallsLeft = Math.max(0, pauseCalls - ws.callsInWindow);

  let recommendation;
  if (sim.fitsInWindow) {
    recommendation = 'run-now';
  } else if (waitForFullFitMs != null && waitForFullFitMs > 0) {
    recommendation = `wait-${Math.max(1, Math.round(waitForFullFitMs / 60000))}m`;
  } else {
    recommendation = sim.pauseAtPhase != null
      ? `run-partial-then-pause-at-${sim.pauseAtPhase}`
      : 'run-partial-then-pause-at-K';
  }

  return {
    project: projectName,
    mode,
    fitsInWindow: sim.fitsInWindow,
    pauseAtUnit: sim.pauseAtUnit,
    pauseAtPhase: sim.pauseAtPhase,
    pauseReason: sim.pauseReason,
    etaMs: sim.etaMs,
    callsShort: sim.callsShort,
    costShort: sim.costShort,
    waitForFullFitMs,
    recommendation,
    lowConfidence: !!lowConfidence,
    totalUnits: units.length,
    // Compatibility field: this is now admission units (heavy-equivalent),
    // matching windowStatus.callsInWindow and the pause threshold.
    totalExpectedCalls: Math.round(totalExpectedCalls * 100) / 100,
    totalExpectedAdmissionUnits: Math.round(totalExpectedCalls * 100) / 100,
    totalExpectedRawCalls: Math.round(totalExpectedRawCalls * 100) / 100,
    totalExpectedCost: Math.round(totalExpectedCost * 1000) / 1000,
    windowCallsLeft,
    callsInWindow: ws.callsInWindow,
    rawCallsInWindow: ws.rawCallsInWindow ?? ws.callsInWindow,
    pauseThreshold: pauseCalls,
    costThresholdsEnforced: ws.costThresholdsEnforced !== false,
    windowHours,
    reclaim: summarizeReclaim(recent, windowHours, now, cfg),
  };
}

/**
 * Forecast a project's next run against the live 5-hour window. Deterministic,
 * zero LLM calls. Returns the object GET /api/projects/:name/forecast and the
 * forecast_run chat tool both surface verbatim.
 *
 * `deps` are test seams (each defaults to the production impl) so the DB/config
 * reads can be stubbed; the numeric core is already pure (buildForecast).
 */
export async function forecastRun(projectName, deps = {}) {
  const resolveConfigFn = deps.resolveConfig || resolveConfig;
  const windowStatusFn = deps.windowStatus || windowStatus;
  const callsInLastHoursFn = deps.callsInLastHours || callsInLastHours;
  const predictUpcomingFn = deps.predictUpcoming || predictUpcoming;
  const errorRateFn = deps.taskErrorRate || taskErrorRate;
  const now = (deps.now || Date.now)();

  const cfg = await resolveConfigFn({ project: projectName, task: 'dev-execution' });
  const prediction = await predictUpcomingFn(projectName);
  const rawUnits = prediction.units || [];

  // Attach expected admission units/cost = task weight ×
  // (1 + historical per-task error rate), preserving raw expected attempts.
  const errCache = new Map();
  let lowConfidence = (prediction.totals?.fallbackCount || 0) > 0;
  const units = rawUnits.map((u) => {
    if (!errCache.has(u.task)) errCache.set(u.task, errorRateFn(u.task));
    const er = errCache.get(u.task) || { rate: 0, n: 0 };
    if (!er.n) lowConfidence = true; // no error-rate history for this task
    return {
      ...u,
      error_rate: er.rate,
      error_sample: er.n,
      expected_calls: billingCallWeight(cfg, u) * (1 + er.rate),
      expected_raw_calls: 1 + er.rate,
      expected_cost: (u.cost_usd || 0) * (1 + er.rate),
    };
  });

  const ws = windowStatusFn(cfg);
  const recent = callsInLastHoursFn(ws.windowHours || cfg.billing?.window_reset_hours || 5);

  return buildForecast({ projectName, mode: prediction.mode, units, ws, recent, now, lowConfidence, cfg });
}

/**
 * PURE one-liner appended to the per-phase completion ping when the run will
 * NOT fit the current window — "window: 31 units left — run needs ~18 more,
 * will pause at phase 9". Empty string when the run fits (nothing to warn about) or
 * on a null forecast, so the call site can append it unconditionally.
 */
export function formatForecastWindowLine(forecast) {
  if (!forecast || forecast.fitsInWindow) return '';
  const left = forecast.windowCallsLeft != null ? forecast.windowCallsLeft : '?';
  const needs = Math.ceil(forecast.totalExpectedCalls || 0);
  const where = forecast.pauseAtPhase != null
    ? `phase ${forecast.pauseAtPhase}`
    : (forecast.pauseAtUnit != null ? `unit ${forecast.pauseAtUnit + 1}` : 'mid-run');
  return `window: ${left} units left — run needs ~${needs} more, will pause at ${where}`;
}

/**
 * PURE terminal/log summary of a forecast — the "one best-effort forecast line"
 * the auto-runner preflight prints, and the confirm line the web/chat surfaces
 * echo. Never throws.
 */
export function renderForecastLine(forecast) {
  if (!forecast) return '';
  const lc = forecast.lowConfidence ? ' (rough estimate — sparse history)' : '';
  if (forecast.mode === 'idle' || forecast.totalUnits === 0) {
    return `Forecast: no upcoming run to size${lc}.`;
  }
  const eta = formatDuration(forecast.etaMs);
  const units = Math.ceil(forecast.totalExpectedAdmissionUnits ?? forecast.totalExpectedCalls ?? 0);
  if (forecast.fitsInWindow) {
    return `Forecast: fits the ${forecast.windowHours}h window — ~${units} heavy-eq units, ETA ~${eta}${lc}.`;
  }
  if (forecast.recommendation.startsWith('wait-')) {
    const mins = Math.max(1, Math.round((forecast.waitForFullFitMs || 0) / 60000));
    return `Forecast: won't fit now — will pause at ${forecast.pauseAtPhase != null ? 'phase ' + forecast.pauseAtPhase : 'unit ' + ((forecast.pauseAtUnit ?? 0) + 1)}; wait ~${mins}m for the window to clear, or run partial${lc}.`;
  }
  return `Forecast: won't fit — run partial, will pause at ${forecast.pauseAtPhase != null ? 'phase ' + forecast.pauseAtPhase : 'mid-run'} (${forecast.pauseReason || 'calls'}); ~${units} heavy-eq units needed, ${forecast.windowCallsLeft} left${lc}.`;
}
