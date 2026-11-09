// Phase 54 (par-07) — fair-share window admission.
//
// Covers:
//   (A) billing-guard.js fairShareStatus — weighted per-project share of the
//       shared window, dead-pid exclusion, single-project whole-pool.
//   (B) claude-runner.js admitFairShare — the pre-spawn yield loop: waits while
//       over-share, proceeds when the other run dies, aborts within one
//       iteration on cancel, and NEVER waits when disabled / single-project /
//       budget-exhausted (proceeds, never throws).
//   (C) The hard-pause throw is unchanged even with fair-share enabled.
//
// Run: node src/fair-share.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

// In-memory DB before any state.js import (state reads DB_PATH at first getDb()).
process.env.DB_PATH = ':memory:';
process.env.ASHMERO_ROLE = 'mac';
process.env.ASHMERO_HOST_ID = 'mac';
// Keep runClaude's headless-trust write off the operator's real ~/.claude.json.
process.env.ORCHESTRATOR_SKIP_TRUST = '1';

const {
  upsertProject, claimRunningJob, releaseRunningJob, recordCall,
  callsInLastHoursForProject, getRunningJobs, pidAlive,
} = await import('./state.js');
const { fairShareStatus } = await import('./billing-guard.js');
const { admitFairShare, runClaude } = await import('./claude-runner.js');

const ALIVE = process.pid;       // this test process — provably alive
const DEAD = 2 ** 31 - 1;        // 2147483647 — no such pid → pidAlive() false

function billing({ pauseCalls = 100, priority = 1, windowHours = 5 } = {}) {
  return {
    billing: {
      mode: 'max_pooled', window_reset_hours: windowHours,
      warn_at_calls: 1, pause_at_calls: pauseCalls, priority,
      warn_at_cost_usd: 1e9, pause_at_cost_usd: 1e9, allow_api_fallback: false,
    },
  };
}

// ─── (A) fairShareStatus ─────────────────────────────────────────────────────

test('fairShareStatus: 2 live equal-weight projects → share == pause_at_calls/2', async () => {
  upsertProject({ name: 'a1', tech_stack: 't' });
  upsertProject({ name: 'a1b', tech_stack: 't' });
  claimRunningJob('a1', ALIVE);
  claimRunningJob('a1b', ALIVE);

  const fs = await fairShareStatus(billing({ pauseCalls: 100 }), 'a1', {
    weightForProject: () => 1,
  });
  assert.equal(fs.activeCount, 2, 'both live claims counted');
  assert.equal(fs.share, 50, 'equal split → half the pool');
  assert.equal(fs.projectCalls, 0, 'no calls recorded yet');
  assert.equal(fs.overShare, false, '0 calls is under a 50 share');

  releaseRunningJob('a1'); releaseRunningJob('a1b');
});

test('fairShareStatus: weights 2:1 → 2/3 and 1/3 of the pool', async () => {
  upsertProject({ name: 'w2', tech_stack: 't' });
  upsertProject({ name: 'w1', tech_stack: 't' });
  claimRunningJob('w2', ALIVE);
  claimRunningJob('w1', ALIVE);
  const weightForProject = (name) => (name === 'w2' ? 2 : 1);

  const heavy = await fairShareStatus(billing({ pauseCalls: 90 }), 'w2', { weightForProject });
  const light = await fairShareStatus(billing({ pauseCalls: 90 }), 'w1', { weightForProject });
  assert.equal(heavy.activeCount, 2);
  assert.ok(Math.abs(heavy.share - 90 * 2 / 3) < 1e-9, `heavy share ${heavy.share} == 60`);
  assert.ok(Math.abs(light.share - 90 * 1 / 3) < 1e-9, `light share ${light.share} == 30`);

  releaseRunningJob('w2'); releaseRunningJob('w1');
});

test('fairShareStatus: running_jobs rows with a dead pid are excluded (real pidAlive)', async () => {
  upsertProject({ name: 'live', tech_stack: 't' });
  upsertProject({ name: 'zombie', tech_stack: 't' });
  claimRunningJob('live', ALIVE);
  claimRunningJob('zombie', DEAD);
  assert.equal(pidAlive(DEAD), false, 'sentinel pid must read as dead');

  // Default isAlive = real pidAlive; asker 'live', zombie's dead claim dropped.
  const fs = await fairShareStatus(billing({ pauseCalls: 100 }), 'live', {
    weightForProject: () => 1,
  });
  assert.equal(fs.activeCount, 1, 'dead-pid claim excluded → only the asker is active');
  assert.equal(fs.share, 100, 'sole live project gets the whole pool');

  releaseRunningJob('live'); releaseRunningJob('zombie');
});

test('fairShareStatus: single live project → share == the whole pool', async () => {
  upsertProject({ name: 'solo', tech_stack: 't' });
  claimRunningJob('solo', ALIVE);

  const fs = await fairShareStatus(billing({ pauseCalls: 77, priority: 3 }), 'solo', {
    weightForProject: () => 3,
  });
  assert.equal(fs.activeCount, 1);
  assert.equal(fs.share, 77, 'weight cancels in numerator/denominator → whole pool');

  releaseRunningJob('solo');
});

test('fairShareStatus: overShare flips true once projectCalls reaches the slice', async () => {
  upsertProject({ name: 'busy', tech_stack: 't' });
  upsertProject({ name: 'idle', tech_stack: 't' });
  claimRunningJob('busy', ALIVE);
  claimRunningJob('idle', ALIVE);
  // pause 4, two equal projects → share 2. Record 3 calls for 'busy' → over.
  for (let i = 0; i < 3; i += 1) {
    recordCall({ project: 'busy', task: 'dev-execution', model: 'm', is_error: false });
  }
  assert.equal(callsInLastHoursForProject(5, 'busy').length, 3, 'per-project filter counts only busy');

  const fs = await fairShareStatus(billing({ pauseCalls: 4 }), 'busy', { weightForProject: () => 1 });
  assert.equal(fs.share, 2);
  assert.equal(fs.projectCalls, 3);
  assert.equal(fs.overShare, true, '3 calls >= 2 share → over');

  releaseRunningJob('busy'); releaseRunningJob('idle');
});

// ─── (B) admitFairShare ──────────────────────────────────────────────────────

// A deps harness: injectable sleep (counts + resolves immediately so tests are
// instant), fixed clock, scripted window state + fairShare verdicts, cancel flag.
function harness({ states, verdicts, cancels = [], nowValues = null, maxMinutes = 15 } = {}) {
  const log = [];
  let sleepCount = 0;
  let statusI = 0; let verdictI = 0; let cancelI = 0; let nowI = 0;
  const deps = {
    sleep: async () => { sleepCount += 1; },
    now: () => (nowValues ? nowValues[Math.min(nowI++, nowValues.length - 1)] : 0),
    status: () => ({ state: states[Math.min(statusI++, states.length - 1)] }),
    fairShare: async () => verdicts[Math.min(verdictI++, verdicts.length - 1)],
    isCancelled: () => (cancels.length ? !!cancels[Math.min(cancelI++, cancels.length - 1)] : false),
    log: (m) => log.push(m),
  };
  const cfg = { billing: { fair_share: { enabled: true, fair_wait_max_minutes: maxMinutes } } };
  return { deps, cfg, log, sleeps: () => sleepCount };
}

const OVER = { activeCount: 2, overShare: true, projectCalls: 9, share: 4 };
const OK_ALONE = { activeCount: 1, overShare: true, projectCalls: 9, share: 9 };

test('admitFairShare: over-share + warn + 2 active → waits, then proceeds when the other run dies', async () => {
  const h = harness({
    states: ['warn'],
    // over-share twice, then the other claim's pid dies → activeCount 1 → proceed
    verdicts: [OVER, OVER, OK_ALONE],
  });
  await admitFairShare({ cfg: h.cfg, project: 'p' }, h.deps);
  assert.equal(h.sleeps(), 2, 'yielded across exactly two 60s poll cycles');
  assert.equal(h.log.filter((l) => /yielding window/.test(l)).length, 2, 'one yield log per wait');
  assert.match(h.log[0], /p: over fair share \(9\/4 heavy-equivalent units, 2 active runs\) — yielding window/);
});

test('admitFairShare: cancellation aborts within one iteration with the clean Error', async () => {
  const h = harness({
    states: ['warn'],
    verdicts: [OVER, OVER, OVER],
    cancels: [false, true], // cancel lands during the first sleep
  });
  await assert.rejects(
    admitFairShare({ cfg: h.cfg, project: 'p' }, h.deps),
    /^Error: cancelled while waiting for window fair share$/,
  );
  assert.equal(h.sleeps(), 1, 'aborted on the very next iteration — one sleep, not up to 15 min');
});

test('admitFairShare: cancellation before the first check throws immediately (zero sleeps)', async () => {
  const h = harness({ states: ['warn'], verdicts: [OVER], cancels: [true] });
  await assert.rejects(
    admitFairShare({ cfg: h.cfg, project: 'p' }, h.deps),
    /cancelled while waiting for window fair share/,
  );
  assert.equal(h.sleeps(), 0);
});

test('admitFairShare: enabled:false never waits', async () => {
  const h = harness({ states: ['warn'], verdicts: [OVER, OVER, OVER] });
  h.cfg.billing.fair_share.enabled = false;
  await admitFairShare({ cfg: h.cfg, project: 'p' }, h.deps);
  assert.equal(h.sleeps(), 0, 'opt-out short-circuits before any status/fairShare/sleep');
});

test('admitFairShare: single-project (activeCount 1) never waits', async () => {
  const h = harness({ states: ['warn'], verdicts: [OK_ALONE] });
  await admitFairShare({ cfg: h.cfg, project: 'p' }, h.deps);
  assert.equal(h.sleeps(), 0);
});

test('admitFairShare: no project → returns immediately', async () => {
  const h = harness({ states: ['warn'], verdicts: [OVER] });
  await admitFairShare({ cfg: h.cfg, project: null }, h.deps);
  assert.equal(h.sleeps(), 0);
});

test('admitFairShare: window not warn (ok) → proceeds without a fairShare call', async () => {
  let fairShareCalls = 0;
  const h = harness({ states: ['ok'], verdicts: [OVER] });
  h.deps.fairShare = async () => { fairShareCalls += 1; return OVER; };
  await admitFairShare({ cfg: h.cfg, project: 'p' }, h.deps);
  assert.equal(h.sleeps(), 0);
  assert.equal(fairShareCalls, 0, "'ok' window never consults fair share");
});

test('admitFairShare: budget exhausted → PROCEEDS with a warning, never throws', async () => {
  // fair_wait_max_minutes 0 → deadline == now() → exhausted on the first pass.
  const h = harness({ states: ['warn'], verdicts: [OVER], maxMinutes: 0 });
  await admitFairShare({ cfg: h.cfg, project: 'p' }, h.deps); // must resolve, not reject
  assert.equal(h.sleeps(), 0, 'no sleep — budget already exhausted');
  const warn = h.log.find((l) => /exhausted — proceeding/.test(l));
  assert.ok(warn, 'logs a budget-exhausted proceed line');
  assert.match(warn, /billing\.fair_share\.fair_wait_max_minutes/, 'names the config layer');
});

// ─── (C) hard-pause regression ───────────────────────────────────────────────

test('hard-pause throw is unchanged even with fair-share enabled', async () => {
  upsertProject({ name: 'hardpause', tech_stack: 't' });
  // 3 recent calls, pause_at_calls 2 → shouldPause true regardless of fair-share.
  for (let i = 0; i < 3; i += 1) {
    recordCall({ project: 'hardpause', task: 'dev-execution', model: 'm', is_error: false });
  }
  const cfg = {
    _resolved: { claude_bin: '/nonexistent' },
    model: 'claude-sonnet-5',
    tools: { allowed_default: [] },
    phases: {},
    billing: {
      mode: 'max_pooled', window_reset_hours: 5,
      warn_at_calls: 1, pause_at_calls: 2,
      warn_at_cost_usd: 1e9, pause_at_cost_usd: 1e9, allow_api_fallback: false,
      fair_share: { enabled: true, fair_wait_max_minutes: 15 },
    },
  };
  await assert.rejects(
    runClaude({ cfg, cwd: os.tmpdir(), prompt: 'x', role: 'dev', task: 'dev-execution', project: 'hardpause' }),
    /Paused:/,
    'runaway spend hard-stops BEFORE fair-share admission ever runs',
  );

  releaseRunningJob('hardpause');
});
