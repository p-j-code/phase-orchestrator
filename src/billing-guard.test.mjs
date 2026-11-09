// Weighted billing-window admission tests. Cheap bounded helpers consume a
// positive fraction of one heavy call while raw subprocess-attempt telemetry is
// preserved separately.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';

const { recordCall, getDb } = await import('./state.js');
const {
  billingCallWeight,
  heavyEquivalentCallUnits,
  summarizeReclaim,
  windowStatus,
  fairShareStatus,
  renderStatus,
} = await import('./billing-guard.js');

function cfg({ cheapWeight = 0.25, warn = 8, pause = 12, enforceCost = false, warnCost = 1e9, pauseCost = 1e9 } = {}) {
  return {
    billing: {
      mode: 'max_pooled',
      window_reset_hours: 5,
      warn_at_calls: warn,
      pause_at_calls: pause,
      warn_at_cost_usd: warnCost,
      pause_at_cost_usd: pauseCost,
      enforce_cost_thresholds: enforceCost,
      allow_api_fallback: false,
      priority: 1,
      heavy_call_lease: {
        cheap_tasks: ['ledger-extract', 'autopsy', 'autopilot-digest'],
        heavy_tasks: [],
        cheap_call_weight: cheapWeight,
      },
    },
  };
}

beforeEach(() => {
  getDb().prepare('DELETE FROM calls').run();
});

test('billingCallWeight uses the lease cheap list, defaults unknown tasks heavy, and lets heavy_tasks win', () => {
  const base = cfg();
  assert.equal(billingCallWeight(base, 'dev-execution'), 1);
  assert.equal(billingCallWeight(base, 'ledger-extract'), 0.25);
  assert.equal(billingCallWeight(base, { task: 'autopsy' }), 0.25);
  assert.equal(billingCallWeight(base, null), 1);

  const overridden = cfg({ cheapWeight: 0.5 });
  overridden.billing.heavy_call_lease.heavy_tasks = ['autopsy'];
  assert.equal(billingCallWeight(overridden, 'ledger-extract'), 0.5);
  assert.equal(billingCallWeight(overridden, 'autopsy'), 1, 'explicit heavy override wins');
});

test('invalid/zero cheap weight fails safe to a positive default so no subprocess attempt is free', () => {
  for (const bad of [0, 0.001, -1, 2, Number.NaN, 'n/a']) {
    assert.equal(billingCallWeight(cfg({ cheapWeight: bad }), 'autopsy'), 0.25);
  }
});

test('windowStatus admits on heavy-equivalent units while preserving every raw attempt, including errors', () => {
  recordCall({ task: 'dev-execution', model: 'sonnet', is_error: false, subprocess_attempt: 1 });
  recordCall({ task: 'ledger-extract', model: 'haiku', is_error: false, subprocess_attempt: 1 });
  recordCall({ task: 'autopsy', model: 'haiku', is_error: true, subprocess_attempt: 1 });
  recordCall({ task: 'autopilot-digest', model: 'haiku', is_error: false, subprocess_attempt: 2 });

  const status = windowStatus(cfg({ warn: 1.5, pause: 2 }));
  assert.equal(status.rawCallsInWindow, 4, 'every subprocess attempt remains observable');
  assert.equal(status.callsInWindow, 1.75, '1 heavy + 3 cheap×0.25');
  assert.equal(status.heavyEquivalentCallsInWindow, 1.75);
  assert.equal(status.state, 'warn', 'admission thresholds use weighted units, not raw 4');
});

test('estimated Max-plan dollar thresholds are monitor-only unless explicitly enabled', () => {
  recordCall({ task: 'dev-execution', model: 'sonnet', cost_usd: 100, is_error: false });

  const monitored = windowStatus(cfg({ warn: 100, pause: 200, warnCost: 1, pauseCost: 2 }));
  assert.equal(monitored.totalCostInWindow, 100);
  assert.equal(monitored.costThresholdsEnforced, false);
  assert.equal(monitored.state, 'ok', 'estimated cost cannot stop development by default');

  const enforced = windowStatus(cfg({ warn: 100, pause: 200, warnCost: 1, pauseCost: 2, enforceCost: true }));
  assert.equal(enforced.costThresholdsEnforced, true);
  assert.equal(enforced.state, 'pause', 'explicit opt-in preserves a real dollar cap');
});

test('heavyEquivalentCallUnits and reclaim expose weighted units plus raw expiring count', () => {
  const now = Date.parse('2026-07-16T00:00:00.000Z');
  const startedAt = new Date(now - 4 * 60 * 60 * 1000).toISOString();
  const rows = [
    { task: 'dev-execution', started_at: startedAt },
    { task: 'ledger-extract', started_at: startedAt },
    { task: 'autopsy', started_at: startedAt },
  ];
  assert.equal(heavyEquivalentCallUnits(rows, cfg()), 1.5);
  const reclaim = summarizeReclaim(rows, 5, now, cfg());
  assert.equal(reclaim.count, 3);
  assert.equal(reclaim.units, 1.5);
  assert.equal(reclaim.inMs, 60 * 60 * 1000);
});

test('fairShareStatus compares project heavy-equivalent units and returns raw project attempts separately', async () => {
  const rows = [
    { task: 'dev-execution' },
    { task: 'ledger-extract' },
    { task: 'autopsy' },
    { task: 'autopilot-digest' },
    { task: 'ledger-extract' },
  ]; // 1 + 4×0.25 = 2 units; 5 raw attempts
  const billingCfg = cfg({ pause: 4 });
  const result = await fairShareStatus(billingCfg, 'weighted', {
    runningJobs: () => [{ project: 'other', pid: 123 }],
    isAlive: () => true,
    callsForProject: () => rows,
    weightForProject: () => 1,
  });
  assert.equal(result.share, 2);
  assert.equal(result.projectCalls, 2);
  assert.equal(result.rawProjectCalls, 5);
  assert.equal(result.overShare, true);
});

test('terminal status labels admission units and raw attempts distinctly', () => {
  recordCall({ task: 'dev-execution', model: 'sonnet', is_error: false });
  recordCall({ task: 'autopsy', model: 'haiku', is_error: false });
  const rendered = renderStatus(cfg()).replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(rendered, /Units:\s+1\.25 .*heavy-equivalent/);
  assert.match(rendered, /Attempts:\s+2 raw subprocess calls/);
  assert.match(rendered, /monitor-only on Max plan/);
});
