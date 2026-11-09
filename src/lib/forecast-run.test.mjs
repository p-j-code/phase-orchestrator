// Tests for Phase 63 (P7) — the pre-flight run forecast (predict × live 5h
// window). Deterministic, ZERO Claude calls. Covers the four acceptance
// criteria across the surfaces that share one forecastRun() object:
//   1. commands/predict.js — simulateForecast / buildForecast / forecastRun on
//      synthetic histories: empty→run-now; near-full+mid-run-reclaim→pauseAtUnit
//      + waitForFullFitMs; cost-bound→pause predicted by cost; ÷0/no-history
//      covered + marked low-confidence.
//   2. predictUpcoming unit builder grows by the per-phase acceptance-check
//      call when verify is enabled.
//   3. GET /api/projects/:name/forecast and forecast_run return the same object;
//      WindowGauge renders the reclaim line from a fixture; the per-phase
//      completion ping contains the window line when the fixture run won't fit.
//   4. No LLM in the forecast path (asserted by construction — the whole path is
//      SQL + arithmetic; a grep proof lives in the phase report).
// In-memory SQLite via DB_PATH=:memory: (same convention as run-events/quality
// tests). The predictUpcoming/endpoint integration uses a throwaway project dir
// under projects/, torn down in `after`.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

process.env.DB_PATH = ':memory:';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');
const TMP_PROJECT = 'forecast-test-tmp'; // must match project.schema's ^[a-z0-9-]+$
const TMP_DIR = path.join(PROJECTS_DIR, TMP_PROJECT);

const {
  simulateForecast, buildForecast, computeWaitForFullFit, forecastRun,
  formatForecastWindowLine, renderForecastLine, shouldPredictAcceptanceCheck,
  taskErrorRate, predictUpcoming,
} = await import('../commands/predict.js');
const { upsertProject, recordCall, getDb } = await import('../state.js');
const { summarizeReclaim, windowStatus } = await import('../billing-guard.js');
const { buildPhaseCompletionNotifyText } = await import('../auto-runner.js');
const { toolForecastRun } = await import('../chat/control-actions.js');
const { createWebUiApp } = await import('../web-ui.js');
const WindowGauge = (await import('../public/js/components/widgets/WindowGauge.js')).default;

const HOUR = 3600 * 1000;
const NOW = 1_700_000_000_000; // fixed clock for reproducible sims

// A synthetic window-status snapshot (the subset buildForecast reads).
function ws({ pauseCalls = 80, pauseCost = 1e9, callsInWindow = 0, cost = 0, hours = 5, costEnforced = true } = {}) {
  return {
    windowHours: hours, pauseThreshold: pauseCalls, pauseCostThreshold: pauseCost,
    callsInWindow, totalCostInWindow: cost, costThresholdsEnforced: costEnforced,
  };
}
function unit({ calls = 1, cost = 0.04, dur = 60000, phase = 1 } = {}) {
  return { duration_ms: dur, expected_calls: calls, expected_cost: cost, phase };
}

// ── AC1: pure simulator — empty window yields run-now ─────────────────────────
test('empty window: the whole run fits → fitsInWindow, run-now, no wait', () => {
  const f = buildForecast({
    projectName: 't', mode: 'phases',
    units: [unit(), unit()], ws: ws(), recent: [], now: NOW, lowConfidence: false,
  });
  assert.equal(f.fitsInWindow, true);
  assert.equal(f.pauseAtUnit, null);
  assert.equal(f.pauseAtPhase, null);
  assert.equal(f.waitForFullFitMs, 0);
  assert.equal(f.recommendation, 'run-now');
  assert.equal(f.reclaim.next, null); // no in-window calls → nothing to reclaim
});

// ── AC1: near-full window + mid-run reclaim → pauseAtUnit + waitForFullFitMs ──
test('near-full window: pauses mid-run at the correct unit, and waitForFullFitMs = when the window clears', () => {
  // 9 calls in a window with a pause threshold of 10; all 9 started 4h ago, so
  // they age out (started + 5h) exactly 1h from now.
  const recent = Array.from({ length: 9 }, () => ({ started_at: new Date(NOW - 4 * HOUR).toISOString() }));
  const units = [
    unit({ phase: 1, dur: 30 * 60 * 1000 }),
    unit({ phase: 1, dur: 30 * 60 * 1000 }),
    unit({ phase: 2, dur: 30 * 60 * 1000 }),
    unit({ phase: 2, dur: 30 * 60 * 1000 }),
  ];
  const f = buildForecast({
    projectName: 't', mode: 'phases',
    units, ws: ws({ pauseCalls: 10, callsInWindow: 9, cost: 0.5 }),
    recent, now: NOW, lowConfidence: false,
  });
  assert.equal(f.fitsInWindow, false);
  assert.equal(f.pauseAtUnit, 1, 'first unit fits (9→10), second crosses (→11)');
  assert.equal(f.pauseAtPhase, 1);
  assert.equal(f.pauseReason, 'calls');
  // After the 9 calls age out (+1h), the 4-call run fits from a fresh window.
  assert.equal(f.waitForFullFitMs, HOUR + 1);
  assert.equal(f.recommendation, 'wait-60m');
});

// ── AC1: a cost-bound crossing is a pause predicted by COST, not calls ────────
test('cost-bound crossing: pause is attributed to cost when calls are fine but cost isn\'t', () => {
  const units = [unit({ calls: 1, cost: 5, phase: 3 }), unit({ calls: 1, cost: 5, phase: 4 })];
  const f = buildForecast({
    projectName: 't', mode: 'phases',
    units, ws: ws({ pauseCalls: 100, pauseCost: 6, callsInWindow: 0, cost: 4 }),
    recent: [], now: NOW, lowConfidence: false,
  });
  assert.equal(f.fitsInWindow, false);
  assert.equal(f.pauseReason, 'cost');
  assert.equal(f.pauseAtUnit, 0, 'cost crosses on the very first unit (4→9 > 6)');
  assert.equal(f.pauseAtPhase, 3);
  assert.equal(f.costShort, 3); // 9 - 6
  assert.equal(f.callsShort, 0);
});

test('monitor-only cost threshold never predicts a development pause', () => {
  const f = buildForecast({
    projectName: 't', mode: 'phases',
    units: [unit({ calls: 1, cost: 50, phase: 3 })],
    ws: ws({ pauseCalls: 100, pauseCost: 6, callsInWindow: 0, cost: 4, costEnforced: false }),
    recent: [], now: NOW, lowConfidence: false,
  });
  assert.equal(f.fitsInWindow, true);
  assert.equal(f.costThresholdsEnforced, false);
  assert.equal(f.pauseReason, null);
});

// ── AC1: ÷0 / no-history — never crashes, and marks low-confidence ────────────
test('no upcoming units / no history: run-now, low-confidence, no div-by-zero', () => {
  const f = buildForecast({
    projectName: 't', mode: 'idle',
    units: [], ws: ws(), recent: [], now: NOW, lowConfidence: true,
  });
  assert.equal(f.fitsInWindow, true);
  assert.equal(f.recommendation, 'run-now');
  assert.equal(f.totalUnits, 0);
  assert.equal(f.totalExpectedCalls, 0);
  assert.equal(f.lowConfidence, true);
});

test('simulateForecast: empty reclaim list + empty units do not divide by zero', () => {
  const sim = simulateForecast({
    units: [], reclaimAtMs: [], callsInWindow: 5, costInWindow: 2,
    pauseCalls: 10, pauseCost: 10, windowMs: 5 * HOUR, now: NOW,
  });
  assert.equal(sim.fitsInWindow, true);
  assert.equal(sim.etaMs, 0);
});

test('simulateForecast reclaims the weighted units carried by a cheap historical attempt', () => {
  const sim = simulateForecast({
    units: [unit({ calls: 0.4, cost: 0 })],
    reclaimAtMs: [{ at: NOW + HOUR, units: 0.25 }],
    callsInWindow: 1.25,
    costInWindow: 0,
    pauseCalls: 2,
    pauseCost: 1e9,
    windowMs: 5 * HOUR,
    now: NOW,
    startDelayMs: HOUR + 1,
  });
  assert.equal(sim.fitsInWindow, true);
  assert.equal(sim.peakCalls, 1.4, '1.25 - 0.25 cheap reclaim + 0.4 spend');
});

// ── AC1: a run larger than a whole window can never fully fit (waitForFullFit=null)
test('run bigger than a full window: computeWaitForFullFit returns null → run-partial recommendation', () => {
  const units = [unit({ phase: 1 }), unit({ phase: 2 }), unit({ phase: 3 }), unit({ phase: 4 }), unit({ phase: 5 })];
  const base = {
    units, reclaimAtMs: [], callsInWindow: 0, costInWindow: 0,
    pauseCalls: 3, pauseCost: 1e9, windowMs: 5 * HOUR, now: NOW,
  };
  assert.equal(computeWaitForFullFit(base), null);
  const f = buildForecast({
    projectName: 't', mode: 'phases', units, ws: ws({ pauseCalls: 3 }),
    recent: [], now: NOW, lowConfidence: false,
  });
  assert.equal(f.fitsInWindow, false);
  assert.equal(f.waitForFullFitMs, null);
  assert.equal(f.recommendation, 'run-partial-then-pause-at-4', 'pauses at phase 4 (4th call crosses the 3-call cap)');
});

// ── AC1: taskErrorRate div-by-zero guard + a real rate ────────────────────────
test('taskErrorRate: no rows → {rate:0,n:0}; with rows → the errored fraction', () => {
  assert.deepEqual(taskErrorRate('nonexistent-task'), { rate: 0, n: 0 });
  recordCall({ task: 'er-task', model: 'm', is_error: 0 });
  recordCall({ task: 'er-task', model: 'm', is_error: 0 });
  recordCall({ task: 'er-task', model: 'm', is_error: 1 });
  recordCall({ task: 'er-task', model: 'm', is_error: 1 });
  const er = taskErrorRate('er-task');
  assert.equal(er.n, 4);
  assert.equal(er.rate, 0.5);
});

// ── AC1: forecastRun wrapper — error rate inflates expected calls, and a
// fallback/no-history unit marks low-confidence (all deps injected; no DB/disk).
test('forecastRun: attaches (1 + per-task error rate) per unit and marks low-confidence on sparse history', async () => {
  const f = await forecastRun('proj', {
    resolveConfig: async () => ({ billing: { window_reset_hours: 5 } }),
    predictUpcoming: async () => ({
      mode: 'phases',
      units: [
        { task: 'dev-execution', model: 'm', cost_usd: 0.04, duration_ms: 60000, phase: 1, fallback: true },
      ],
      totals: { fallbackCount: 1 },
    }),
    windowStatus: () => ws(),
    callsInLastHours: () => [],
    taskErrorRate: () => ({ rate: 0, n: 0 }),
    now: () => NOW,
  });
  assert.equal(f.lowConfidence, true, 'fallbackCount>0 AND no error-rate history');
  assert.equal(f.fitsInWindow, true);
  assert.equal(f.recommendation, 'run-now');
  assert.equal(f.totalExpectedCalls, 1);
});

test('forecastRun: real per-task error history inflates the call estimate and is NOT low-confidence', async () => {
  const f = await forecastRun('proj', {
    resolveConfig: async () => ({ billing: { window_reset_hours: 5 } }),
    predictUpcoming: async () => ({
      mode: 'phases',
      units: [
        { task: 'dev-execution', model: 'm', cost_usd: 0.04, duration_ms: 60000, phase: 1, fallback: false },
        { task: 'dev-execution', model: 'm', cost_usd: 0.04, duration_ms: 60000, phase: 2, fallback: false },
      ],
      totals: { fallbackCount: 0 },
    }),
    windowStatus: () => ws(),
    callsInLastHours: () => [],
    taskErrorRate: () => ({ rate: 0.5, n: 20 }),
    now: () => NOW,
  });
  assert.equal(f.lowConfidence, false);
  assert.equal(f.totalExpectedCalls, 3); // 2 units × (1 + 0.5)
});

test('forecastRun weights a configured cheap helper but preserves its raw expected attempts', async () => {
  const f = await forecastRun('proj', {
    resolveConfig: async () => ({
      billing: {
        window_reset_hours: 5,
        heavy_call_lease: { cheap_tasks: ['autopsy'], cheap_call_weight: 0.25 },
      },
    }),
    predictUpcoming: async () => ({
      mode: 'phases',
      units: [{ task: 'autopsy', model: 'haiku', cost_usd: 0.005, duration_ms: 1000, phase: 1 }],
      totals: { fallbackCount: 0 },
    }),
    windowStatus: () => ws(),
    callsInLastHours: () => [],
    taskErrorRate: () => ({ rate: 0.5, n: 20 }),
    now: () => NOW,
  });
  assert.equal(f.totalExpectedAdmissionUnits, 0.38, '0.25 × 1.5 attempts, rounded');
  assert.equal(f.totalExpectedCalls, 0.38, 'compatibility field follows admission units');
  assert.equal(f.totalExpectedRawCalls, 1.5);
});

// ── AC3: the per-phase completion ping carries the window line only when the
// run won't fit; formatForecastWindowLine is the pure source of that line.
test('formatForecastWindowLine: exact weighted-unit line when not fitting, empty when fitting', () => {
  assert.equal(
    formatForecastWindowLine({ fitsInWindow: false, windowCallsLeft: 31, totalExpectedCalls: 18, pauseAtPhase: 9 }),
    'window: 31 units left — run needs ~18 more, will pause at phase 9',
  );
  assert.equal(formatForecastWindowLine({ fitsInWindow: true }), '');
  assert.equal(formatForecastWindowLine(null), '');
});

test('buildPhaseCompletionNotifyText: appends the window line when the fixture run does NOT fit, omits it when it does', () => {
  const common = { projectName: 'p', phaseN: 5, lastN: 12, title: 't', sha8: 'abcd1234', branch: 'develop', isLast: false };
  const notFit = buildPhaseCompletionNotifyText({
    ...common,
    forecast: { fitsInWindow: false, windowCallsLeft: 31, totalExpectedCalls: 18, pauseAtPhase: 9 },
  });
  assert.match(notFit, /window: 31 units left — run needs ~18 more, will pause at phase 9/);

  const fit = buildPhaseCompletionNotifyText({ ...common, forecast: { fitsInWindow: true } });
  assert.doesNotMatch(fit, /will pause at/);

  const none = buildPhaseCompletionNotifyText(common); // no forecast passed at all
  assert.doesNotMatch(none, /will pause at/);
});

// ── AC3: WindowGauge renders the reclaim line from a fixture ───────────────────
test('WindowGauge: reclaimLine renders weighted units and raw attempts from windowStatus().reclaim', () => {
  const recent = [
    { started_at: new Date(NOW - 4 * HOUR).toISOString() },
    { started_at: new Date(NOW - 4 * HOUR).toISOString() },
  ];
  const reclaim = summarizeReclaim(recent, 5, NOW); // ages out +1h from NOW
  assert.equal(reclaim.count, 2);
  const ctx = { w: { reclaim }, now: NOW };
  const line = WindowGauge.computed.reclaimLine.call(ctx);
  assert.match(line, /^\+2 units \(2 attempts\) reclaim in 1h 00m$/);

  // Legacy windowInfo without a reclaim block (or nothing aging out) → no line.
  assert.equal(WindowGauge.computed.reclaimLine.call({ w: {}, now: NOW }), null);
  assert.equal(WindowGauge.computed.reclaimLine.call({ w: null, now: NOW }), null);
  assert.equal(
    WindowGauge.computed.reclaimLine.call({ w: { reclaim: { next: null, count: 0 } }, now: NOW }),
    null,
  );
  // The template statically wires the line so a render-path regression is caught.
  assert.match(WindowGauge.template, /reclaimLine/);
});

// ── AC1/AC2: shouldPredictAcceptanceCheck gate ────────────────────────────────
test('shouldPredictAcceptanceCheck: verify off → false; criteria-less phase under skip → false; criteria present → true', () => {
  const withCriteria = { acceptance_criteria: ['a', 'b'] };
  const noCriteria = { acceptance_criteria: [] };
  assert.equal(shouldPredictAcceptanceCheck({ verify: { enabled: false } }, withCriteria), false);
  assert.equal(shouldPredictAcceptanceCheck({ verify: { enabled: true, skip_when_no_criteria: true } }, noCriteria), false);
  assert.equal(shouldPredictAcceptanceCheck({ verify: { enabled: true } }, withCriteria), true);
  // skip_when_no_criteria:false still checks a criteria-less phase.
  assert.equal(shouldPredictAcceptanceCheck({ verify: { enabled: true, skip_when_no_criteria: false } }, noCriteria), true);
});

// ── AC2: the real predictUpcoming builder emits one acceptance-check unit per
// phase when verify is enabled, so the unit count grows accordingly. ──────────
async function seedTmpProject() {
  await fs.rm(TMP_DIR, { recursive: true, force: true });
  await fs.mkdir(path.join(TMP_DIR, '.guide'), { recursive: true });
  const plan = {
    phases: [
      { n: 1, title: 'phase one', goal: 'g1', acceptance_criteria: ['c1', 'c2'], files_likely: [] },
      { n: 2, title: 'phase two', goal: 'g2', acceptance_criteria: ['c3'], files_likely: [] },
    ],
  };
  await fs.writeFile(path.join(TMP_DIR, '.guide', 'plan.json'), JSON.stringify(plan, null, 2), 'utf-8');
  const projectJson = {
    $schema_version: 1,
    name: TMP_PROJECT,
    created_at: '2026-07-11T00:00:00.000Z',
    current_phase: 0,
    total_phases: 2,
    status: 'in-progress',
    overrides: {},
    metadata: {},
  };
  await fs.writeFile(path.join(TMP_DIR, 'project.json'), JSON.stringify(projectJson, null, 2), 'utf-8');
  upsertProject({ name: TMP_PROJECT, tech_stack: 'node', total_phases: 2, status: 'in-progress' });
}

after(async () => { await fs.rm(TMP_DIR, { recursive: true, force: true }); });

test('predictUpcoming: a verify-enabled 2-phase plan emits a per-phase acceptance-check unit (unit count grows by 2)', async () => {
  await seedTmpProject();
  const pred = await predictUpcoming(TMP_PROJECT);
  const acUnits = pred.units.filter((u) => u.task === 'acceptance-check');
  assert.equal(acUnits.length, 2, 'one acceptance-check per phase');
  assert.deepEqual(acUnits.map((u) => u.phase).sort(), [1, 2]);
  // Without the acceptance-check additions the run would be dev+review only;
  // the 2 extra units are the growth the criterion asks for.
  const nonAc = pred.units.filter((u) => u.task !== 'acceptance-check');
  assert.equal(pred.units.length, nonAc.length + 2);
});

// ── AC3: GET /forecast and the forecast_run tool return the same object ────────
test('endpoint + forecast_run parity: same forecast object across the web endpoint and the chat tool', async () => {
  await seedTmpProject();
  const app = createWebUiApp({ authToken: null });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/api/projects/${TMP_PROJECT}/forecast`);
    assert.equal(res.status, 200);
    const endpoint = await res.json();
    const tool = await toolForecastRun({ project: TMP_PROJECT });

    // The tool spreads the forecast object and adds a `hint`; the shared object
    // must match on every structural field (timing-independent under the default
    // dormant thresholds, where the run always fits).
    assert.ok(typeof tool.hint === 'string' && tool.hint.length > 0);
    for (const k of ['project', 'mode', 'fitsInWindow', 'recommendation', 'totalUnits', 'totalExpectedCalls', 'pauseAtPhase']) {
      assert.deepEqual(endpoint[k], tool[k], `field ${k} matches across surfaces`);
    }
    assert.equal(endpoint.fitsInWindow, true, 'default pause thresholds are dormant → the run fits');
    assert.equal(endpoint.recommendation, 'run-now');

    // A 404 for an unknown project (not a 500).
    const r404 = await fetch(`${base}/api/projects/no-such-forecast-proj/forecast`);
    assert.equal(r404.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ── renderForecastLine — the terminal/log/summary one-liner never throws ──────
test('renderForecastLine: readable summaries for fits / wait / partial / idle; never throws', () => {
  assert.match(renderForecastLine({ mode: 'phases', totalUnits: 3, fitsInWindow: true, windowHours: 5, etaMs: 300000, totalExpectedCalls: 3, lowConfidence: false, recommendation: 'run-now' }), /fits the 5h window/);
  assert.match(renderForecastLine({ mode: 'phases', totalUnits: 3, fitsInWindow: false, windowHours: 5, etaMs: 0, totalExpectedCalls: 5, pauseAtPhase: 4, waitForFullFitMs: 30 * 60 * 1000, windowCallsLeft: 2, recommendation: 'wait-30m', lowConfidence: false }), /wait ~30m/);
  assert.match(renderForecastLine({ mode: 'phases', totalUnits: 9, fitsInWindow: false, windowHours: 5, etaMs: 0, totalExpectedCalls: 9, pauseAtPhase: 4, waitForFullFitMs: null, windowCallsLeft: 1, pauseReason: 'calls', recommendation: 'run-partial-then-pause-at-4', lowConfidence: true }), /run partial/);
  assert.match(renderForecastLine({ mode: 'idle', totalUnits: 0 }), /no upcoming run/);
  assert.equal(renderForecastLine(null), '');
});
