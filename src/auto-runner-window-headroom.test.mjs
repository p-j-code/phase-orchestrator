// Phase 79 (P2) — auto-runner window-headroom pause seam.
//
// Covers maybePauseForWindowHeadroom: before a HEAVY next action (dev/audit) at
// a 'warn' window with insufficient projected headroom, the run PAUSES with
// pause_reason='window-headroom' and a 'resume' job is scheduled for the
// projected reset. Cheap actions, 'ok' windows, enough headroom, and the
// opt-out are all no-ops. Uses a real :memory: DB (real enqueueRetryJob +
// pauseAutoRun) with windowStatus/predictUpcoming stubbed via the deps seam —
// no real spawn.
//
// Run with: node --test src/auto-runner-window-headroom.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.ORCHESTRATOR_SKIP_TRUST = '1';

const { upsertProject, startAutoRun, getAutoRunById } = await import('./state.js');
const { maybePauseForWindowHeadroom } = await import('./auto-runner.js');
const { listPendingJobs } = await import('./server/job-queue.js');

const CFG = { billing: { window_reset_hours: 5 } }; // window_headroom_min_calls unset → constant 4
const parseSqliteUtc = (s) => new Date(s.replace(' ', 'T') + 'Z');

// windowStatus stub factory.
const ws = (state, {
  pauseThreshold = 100,
  callsInWindow = 0,
  // Keep the projected five-hour reset in the future no matter when the test
  // runs; the old fixed July 2026 timestamp eventually made this fixture fail.
  oldestCallAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(),
} = {}) =>
  () => ({ state, pauseThreshold, callsInWindow, oldestCallAt });

function freshRun(project) {
  upsertProject({ name: project, tech_stack: 't' });
  return startAutoRun({ project });
}
function resumeJobsFor(project) {
  return listPendingJobs().filter((j) => j.project === project && j.action === 'resume');
}

test('warn + heavy dev action + low headroom → PAUSES window-headroom, resume row scheduled, run paused (NOT failed)', async () => {
  const project = 'wh-pause';
  const runId = freshRun(project);
  const res = await maybePauseForWindowHeadroom(
    { cfg: CFG, projectName: project, action: { kind: 'dev', phaseN: 3 }, runId },
    { windowStatus: ws('warn', { pauseThreshold: 100, callsInWindow: 98 }), // remaining 2 < 4
      predictUpcoming: async () => { throw new Error('no plan'); } },      // → constant fallback (4)
  );
  assert.equal(res.paused, true);
  assert.match(res.reason, /^window-headroom \{"resetsAt": \d+\}$/);
  assert.equal(res.pauseKind, 'window-headroom');

  // auto_runs row is PAUSED (not failed) with a reset-aware window-headroom reason.
  const run = getAutoRunById(runId);
  assert.equal(run.status, 'paused', 'the run is paused');
  assert.notEqual(run.status, 'failed', 'and NOT failed');
  assert.equal(run.pause_reason, res.reason);
  assert.equal(run.pause_kind, 'window-headroom');

  // A resume job exists with a future not_before.
  const resumes = resumeJobsFor(project);
  assert.equal(resumes.length, 1, 'exactly one resume job scheduled');
  assert.equal(resumes[0].status, 'pending');
  assert.ok(resumes[0].not_before, 'resume job has a not_before');
  assert.ok(parseSqliteUtc(resumes[0].not_before) > new Date(), 'resume not_before is in the future (projected reset)');
});

test('warn + heavy AUDIT guide action + low headroom → also pauses (audit is heavy)', async () => {
  const project = 'wh-audit';
  const runId = freshRun(project);
  const res = await maybePauseForWindowHeadroom(
    { cfg: CFG, projectName: project, action: { kind: 'guide', task: 'audit' }, runId },
    { windowStatus: ws('warn', { pauseThreshold: 100, callsInWindow: 99 }),
      predictUpcoming: async () => ({ units: [] }) },
  );
  assert.equal(res.paused, true);
  assert.equal(getAutoRunById(runId).status, 'paused');
  assert.equal(resumeJobsFor(project).length, 1);
});

test('warn + CHEAP action (guide/review) → no pause, no resume job, run stays running', async () => {
  const project = 'wh-cheap';
  const runId = freshRun(project);
  const res = await maybePauseForWindowHeadroom(
    { cfg: CFG, projectName: project, action: { kind: 'guide', task: 'review', phaseN: 3 }, runId },
    { windowStatus: ws('warn', { pauseThreshold: 100, callsInWindow: 99 }),
      predictUpcoming: async () => { throw new Error('should not be consulted'); } },
  );
  assert.equal(res.paused, false, 'cheap actions never pause here');
  assert.equal(getAutoRunById(runId).status, 'running');
  assert.equal(resumeJobsFor(project).length, 0);
});

test("'ok' window + heavy action → no pause (proceeds)", async () => {
  const project = 'wh-ok';
  const runId = freshRun(project);
  const res = await maybePauseForWindowHeadroom(
    { cfg: CFG, projectName: project, action: { kind: 'dev', phaseN: 1 }, runId },
    { windowStatus: ws('ok', { pauseThreshold: 100, callsInWindow: 5 }),
      predictUpcoming: async () => { throw new Error('should not be consulted at ok'); } },
  );
  assert.equal(res.paused, false);
  assert.equal(getAutoRunById(runId).status, 'running');
});

test('warn + heavy + ENOUGH headroom (predictUpcoming per-phase estimate fits) → no pause', async () => {
  const project = 'wh-room';
  const runId = freshRun(project);
  const res = await maybePauseForWindowHeadroom(
    { cfg: CFG, projectName: project, action: { kind: 'dev', phaseN: 7 }, runId },
    { windowStatus: ws('warn', { pauseThreshold: 100, callsInWindow: 10 }), // remaining 90
      predictUpcoming: async () => ({ units: [{ phase: 7, task: 'dev-execution' }, { phase: 7, task: 'acceptance-check' }] }) }, // needs 2
  );
  assert.equal(res.paused, false, 'remaining 90 >= estimated 2 → proceed');
  assert.equal(getAutoRunById(runId).status, 'running');
});

test('billing.window_headroom_pause:false opts the pause out even at warn + heavy + low headroom', async () => {
  const project = 'wh-optout';
  const runId = freshRun(project);
  const res = await maybePauseForWindowHeadroom(
    { cfg: { billing: { window_reset_hours: 5, window_headroom_pause: false } },
      projectName: project, action: { kind: 'dev', phaseN: 2 }, runId },
    { windowStatus: ws('warn', { pauseThreshold: 100, callsInWindow: 99 }),
      predictUpcoming: async () => { throw new Error('should not be consulted when opted out'); } },
  );
  assert.equal(res.paused, false);
  assert.equal(getAutoRunById(runId).status, 'running');
  assert.equal(resumeJobsFor(project).length, 0);
});
