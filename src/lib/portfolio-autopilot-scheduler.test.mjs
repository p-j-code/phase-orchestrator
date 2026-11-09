// Phase 86 (P7b) — portfolio autopilot scheduler + morning digest.
//
// Covers the NEW P7b surface on top of P7a's pure plan()/execute() core:
//   - resolveSandbox() — brief-04 deny-rule mechanism presence check.
//   - runNightlyPlan() — FAILS CLOSED (execute never reached, nothing enqueued)
//     when the sandbox is unresolvable; plans+enqueues + stamps the cursor when ok.
//   - autopilotTick() — at-most-once-per-calendar-night planning (a mid-night
//     restart with the same injected clock does not double-plan); disabled config
//     is a pure no-op; once-per-day digest.
//   - startAutopilot() — no-ops (registers NO timer) when disabled OR when the
//     sandbox is unresolvable (fail closed).
//   - composeDigest() — always emits ran / finished / paused / needs-approval.
//   - runMorningDigest() — enqueues the digest THROUGH notify_outbox.
//
// Real :memory: DB (real enqueueJob + notify_outbox + autopilot cursor) with a
// deterministic injected clock and injected gatherState — no real spawn, no LLM.
//
// Run with: node --test src/lib/portfolio-autopilot-scheduler.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.ORCHESTRATOR_SKIP_TRUST = '1';

const {
  resolveSandbox, runNightlyPlan, autopilotTick,
  startAutopilot, stopAutopilot, isAutopilotRunning, computeWindowBudget,
} = await import('./portfolio-autopilot.js');
const { composeDigest, runMorningDigest } = await import('./autopilot-digest.js');
const { getDb, getAutopilotState, recordAutopilotPlanned, listPendingOutbox } = await import('../state.js');
const { listPendingJobs } = await import('../server/job-queue.js');

// A resolved-config shape with brief-04's sandbox PRESENT.
const CFG = {
  autopilot: {
    enabled: true, start_hour: 1, digest_hour: 8, max_projects_per_night: 3,
    priority_order: ['resume', 'brief', 'bugs', 'audit', 'suggestions'],
    require_operator_approval_for: [], // no approval gating in these scheduler tests
  },
  billing: { window_headroom_min_calls: 4, pause_at_calls: 80, warn_at_calls: 50, window_reset_hours: 5 },
  security: { deny_rules: ['Read(../../../config/**)', 'Bash(curl:*)'] },
  tools: { allowed_default: [] },
};

// A gatherState that reports one project with a queued brief (deterministic).
const gatherOneBrief = async () => [{ name: 'sched-p', queuedBriefs: 1, predicted: 3 }];

// ─── resolveSandbox ─────────────────────────────────────────────────────────────

test('resolveSandbox: ok when cfg.security.deny_rules is an array', () => {
  const r = resolveSandbox(CFG);
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
});

test('resolveSandbox: NOT ok when security.deny_rules is absent (the unit seam)', () => {
  assert.equal(resolveSandbox({}).ok, false);
  assert.equal(resolveSandbox({ security: {} }).ok, false);
  assert.equal(resolveSandbox({ security: { deny_rules: 'nope' } }).ok, false);
});

// ─── runNightlyPlan — fail closed ───────────────────────────────────────────────

test('runNightlyPlan: sandbox unresolvable → FAILS CLOSED, execute never reached, nothing enqueued', async () => {
  const before = listPendingJobs().length;
  const res = await runNightlyPlan(
    { cfg: CFG, now: new Date('2020-01-01T01:30:00') },
    { resolveSandbox: () => ({ ok: false, reason: 'unit seam: sandbox unresolvable' }), gatherState: gatherOneBrief },
  );
  assert.equal(res.ranPlan, false);
  assert.equal(res.sandboxOk, false);
  assert.deepEqual(res.enqueued, []);
  assert.equal(listPendingJobs().length, before, 'no job was enqueued under a missing sandbox');
  // The night cursor is NOT stamped on a fail-closed pass (so it retries later).
  assert.notEqual(getAutopilotState().last_planned_date, '2020-01-01');
});

test('runNightlyPlan: sandbox ok → plans, enqueues via enqueueJob, stamps last_planned_date', async () => {
  const res = await runNightlyPlan(
    { cfg: CFG, now: new Date('2020-02-02T01:30:00') },
    { gatherState: gatherOneBrief },
  );
  assert.equal(res.ranPlan, true);
  assert.equal(res.sandboxOk, true);
  assert.ok(res.nightPlan.some((j) => j.project === 'sched-p' && j.action === 'brief'));
  assert.ok(listPendingJobs().some((j) => j.project === 'sched-p' && j.action === 'brief'));
  assert.equal(getAutopilotState().last_planned_date, '2020-02-02');
});

// ─── autopilotTick — once per night / disabled no-op ────────────────────────────

test('autopilotTick: disabled config is a pure no-op', async () => {
  const before = listPendingJobs().length;
  const res = await autopilotTick(
    { cfg: { ...CFG, autopilot: { ...CFG.autopilot, enabled: false } }, now: new Date('2020-03-03T01:30:00') },
    { gatherState: gatherOneBrief },
  );
  assert.equal(res.planned, false);
  assert.equal(res.digested, false);
  assert.equal(listPendingJobs().length, before, 'disabled → no side effects');
});

test('autopilotTick: fires AT MOST once per calendar night — a mid-night restart does not double-plan', async () => {
  const now = new Date('2020-04-04T01:30:00');
  const p1 = 'once-p1';
  const gather = async () => [{ name: p1, queuedBriefs: 1, predicted: 3 }];

  const first = await autopilotTick({ cfg: CFG, now, projectsDir: null }, { gatherState: gather });
  assert.equal(first.planned, true);
  const afterFirst = listPendingJobs().filter((j) => j.project === p1).length;
  assert.equal(afterFirst, 1, 'exactly one job enqueued on the first tick');

  // Second tick, SAME injected clock (simulating a mid-night process restart).
  const second = await autopilotTick({ cfg: CFG, now, projectsDir: null }, { gatherState: gather });
  assert.equal(second.planned, false, 'the same calendar night is not planned twice');
  assert.equal(listPendingJobs().filter((j) => j.project === p1).length, 1, 'no second job enqueued');
});

// ─── startAutopilot — fail closed / disabled ────────────────────────────────────

test('startAutopilot: disabled config registers NO timer', () => {
  stopAutopilot();
  const stop = startAutopilot({ cfg: { ...CFG, autopilot: { ...CFG.autopilot, enabled: false } } });
  assert.equal(isAutopilotRunning(), false, 'no interval when disabled');
  stop();
});

test('startAutopilot: sandbox unresolvable registers NO timer (fail closed)', () => {
  stopAutopilot();
  const stop = startAutopilot({ cfg: CFG }, { resolveSandbox: () => ({ ok: false, reason: 'unit seam' }) });
  assert.equal(isAutopilotRunning(), false, 'fail closed — no scheduler under a missing sandbox');
  stop();
});

test('startAutopilot: enabled + sandbox ok registers a timer, stopAutopilot clears it', () => {
  stopAutopilot();
  const stop = startAutopilot({ cfg: CFG, intervalMs: 60_000 });
  assert.equal(isAutopilotRunning(), true);
  stop();
  assert.equal(isAutopilotRunning(), false);
});

// ─── composeDigest — required sections ──────────────────────────────────────────

test('composeDigest: always emits ran / finished / paused / needs-approval sections', () => {
  const now = new Date('2020-05-05T08:00:00');
  const text = composeDigest({
    jobs: [
      { project: 'a', action: 'brief', status: 'completed', result_summary: 'brief drafted' },
      { project: 'b', action: 'resume', status: 'failed', error_message: 'boom' },
    ],
    autoRuns: [{ project: 'c', status: 'paused', pause_reason: 'budget window', pause_kind: 'budget' }],
    healing: [{ project: 'c', error_kind: 'network', status: 'ok' }],
    recommendations: [{ project: 'd', action: 'brief', reason: '1 queued brief' }],
    now,
  });
  assert.match(text, /Overnight autopilot digest — 2020-05-05/);
  assert.match(text, /Ran \(2\)/);
  assert.match(text, /Finished \(1\)/);
  assert.match(text, /Paused/);
  assert.match(text, /Needs approval \(1\)/);
  assert.match(text, /brief a/);       // ran/finished lists the brief
  assert.match(text, /resume b/);      // failed job surfaced
  assert.match(text, /approve d brief/); // recommended next action for the deferred approval
});

test('composeDigest: empty inputs still emit all four sections (each "none")', () => {
  const text = composeDigest({ now: new Date('2020-05-05T08:00:00') });
  assert.match(text, /Ran \(0\)/);
  assert.match(text, /Finished \(0\)/);
  assert.match(text, /Paused \/ needs attention \(0\)/);
  assert.match(text, /Needs approval \(0\)/);
});

// ─── runMorningDigest — delivers through notify_outbox ──────────────────────────

test('runMorningDigest: composes from since-rows and enqueues the digest to notify_outbox', async () => {
  // Seed the night cursor + a couple of "since" rows via injected readers.
  recordAutopilotPlanned({
    date: '2020-06-06', at: '2020-06-06T01:00:00.000Z',
    planJson: JSON.stringify({ recommendations: [{ project: 'z', action: 'brief', reason: '1 queued brief' }] }),
  });
  const res = await runMorningDigest(
    { cfg: CFG, notifier: null, now: new Date('2020-06-06T08:15:00') },
    {
      listJobsSince: () => [{ project: 'z', action: 'brief', status: 'completed', result_summary: 'brief drafted' }],
      listAutoRunsSince: () => [],
      listHealingLogSince: () => [],
    },
  );
  assert.ok(res.outboxId != null, 'digest enqueued through notify_outbox (queueNotify id returned)');
  assert.equal(res.delivered, true);
  const row = listPendingOutbox(50).find((r) => r.id === res.outboxId);
  assert.ok(row, 'the outbox row exists');
  assert.match(row.text, /Overnight autopilot digest/);
  assert.match(row.text, /Needs approval \(1\)/);
  // The digest cursor is stamped (once-per-day guard).
  assert.equal(getAutopilotState().last_digest_date, '2020-06-06');
});

test('runMorningDigest: falls back to the plain notifier ONLY when the outbox enqueue is unavailable', async () => {
  const delivered = [];
  const notifier = { notify: async (p) => { delivered.push(p); return { delivered: 1, total: 1 }; } };
  const res = await runMorningDigest(
    { cfg: CFG, notifier, now: new Date('2020-07-07T08:15:00') },
    {
      queueNotify: () => null, // simulate the outbox module/table being genuinely absent
      listJobsSince: () => [], listAutoRunsSince: () => [], listHealingLogSince: () => [],
    },
  );
  assert.equal(res.outboxId, null);
  assert.equal(delivered.length, 1, 'fell back to the plain notifier exactly once');
  assert.match(delivered[0].text, /Overnight autopilot digest/);
});

// ─── computeWindowBudget ────────────────────────────────────────────────────────

test('computeWindowBudget: pause threshold minus calls-in-window, fail-safe 0', () => {
  assert.equal(computeWindowBudget(CFG, { windowStatus: () => ({ pauseThreshold: 80, callsInWindow: 30 }) }), 50);
  assert.equal(computeWindowBudget(CFG, { windowStatus: () => { throw new Error('x'); } }), 0);
});
