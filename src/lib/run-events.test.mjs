// Tests for state.js's run_events append-only timeline (Phase 57 — P1).
// Uses an in-memory SQLite database via DB_PATH=:memory: env override.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';

const {
  recordRunEvent, listRunEvents, pruneOldRunEvents, getDb, upsertProject, startAutoRun,
} = await import('../state.js');

// The chat control tool wraps the same listRunEvents read — imported here so
// "get_run_timeline returns the same rows" is asserted against the state layer.
const { toolGetRunTimeline } = await import('../chat/control-actions.js');

function setupProject(name = 'run-events-proj') {
  upsertProject({ name, tech_stack: 'node', total_phases: 3 });
  return name;
}

test('recordRunEvent: a normal insert is id-ordered and readable via listRunEvents', () => {
  const project = setupProject();
  const runId = startAutoRun({ project });
  recordRunEvent(runId, 'run-started', { project, unattended: false });
  recordRunEvent(runId, 'phase-started', { project, phase: 1 });
  recordRunEvent(runId, 'dev-completed', { project, phase: 1 });
  const rows = listRunEvents(runId);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.kind), ['run-started', 'phase-started', 'dev-completed']);
  assert.ok(rows[0].id < rows[1].id && rows[1].id < rows[2].id, 'ordered by id ascending');
  assert.equal(rows[1].phase, 1);
});

test('a simulated run lifecycle produces id-ordered rows covering run-started, phase-started, dev-completed, and the closing pause/complete', () => {
  const project = setupProject('run-events-lifecycle');
  const runId = startAutoRun({ project });
  // The documented per-run transition sequence, in the order auto-runner.js
  // fires them for a single-phase run that ends paused.
  recordRunEvent(runId, 'run-started', { project, unattended: false });
  recordRunEvent(runId, 'plan-created', { project, phases: 1 });
  recordRunEvent(runId, 'phase-started', { project, phase: 1 });
  recordRunEvent(runId, 'dev-completed', { project, phase: 1 });
  recordRunEvent(runId, 'acceptance-pass', { project, phase: 1, unmet: 0 });
  recordRunEvent(runId, 'run-paused', { project, reason: 'checkpoint' });
  const rows = listRunEvents(runId);
  const kinds = rows.map((r) => r.kind);
  // id-ordered
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].id < rows[i].id, 'rows are ascending by id');
  for (const required of ['run-started', 'phase-started', 'dev-completed']) {
    assert.ok(kinds.includes(required), `timeline covers ${required}`);
  }
  assert.ok(kinds.includes('run-paused') || kinds.includes('run-completed'), 'timeline covers a closing pause/complete');
  // ordering is authoritative: run-started first, the closer last.
  assert.equal(kinds[0], 'run-started');
  assert.equal(kinds[kinds.length - 1], 'run-paused');
});

test('recordRunEvent: never throws on undefined/empty detail — stores NULL detail', () => {
  const project = setupProject('run-events-undefined-detail');
  const runId = startAutoRun({ project });
  // ctx omitted entirely (undefined) — defaults to {}. Since `project` is
  // NOT NULL on the table, an insert with no project resolves silently to a
  // no-row outcome rather than throwing (same never-throw contract as a
  // missing runId) — assert only that it never throws.
  assert.doesNotThrow(() => recordRunEvent(runId, 'run-started'));
  // ctx WITH project but no extra keys beyond project/phase — this is the
  // "undefined detail" case that actually produces a row, with detail NULL.
  assert.doesNotThrow(() => recordRunEvent(runId, 'phase-started', { project, phase: 1 }));
  const rows = listRunEvents(runId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].detail, null);
});

test('recordRunEvent: a detail object serializing over ~2KB is truncated, never throws', () => {
  const project = setupProject('run-events-big-detail');
  const runId = startAutoRun({ project });
  const hugeString = 'x'.repeat(5000);
  assert.doesNotThrow(() => recordRunEvent(runId, 'dev-failed', { project, phase: 1, blob: hugeString }));
  const rows = listRunEvents(runId);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].detail.length <= 2000, `detail length ${rows[0].detail.length} must be <= 2000`);
});

test('recordRunEvent: a missing/null/undefined runId warns and writes NO row, never throws', () => {
  const project = setupProject('run-events-missing-runid');
  const before = getDb().prepare('SELECT COUNT(*) AS n FROM run_events').get().n;
  assert.doesNotThrow(() => recordRunEvent(null, 'run-started', { project }));
  assert.doesNotThrow(() => recordRunEvent(undefined, 'run-started', { project }));
  const after = getDb().prepare('SELECT COUNT(*) AS n FROM run_events').get().n;
  assert.equal(after, before, 'no row written for a missing runId');
});

test('listRunEvents: an unknown/legacy run id returns [] rather than throwing', () => {
  assert.deepEqual(listRunEvents(999999), []);
});

test('pruneOldRunEvents: deletes only backdated rows, leaves recent ones', () => {
  const project = setupProject('run-events-retention');
  const runId = startAutoRun({ project });
  recordRunEvent(runId, 'run-started', { project });
  // Backdate one row to 200 days ago directly (recordRunEvent always stamps "now").
  getDb().prepare(
    `UPDATE run_events SET ts = datetime('now', '-200 days') WHERE run_id = ?`,
  ).run(runId);
  recordRunEvent(runId, 'run-completed', { project }); // fresh row, same run
  const deleted = pruneOldRunEvents(90);
  assert.equal(deleted, 1, 'only the backdated row is deleted');
  const remaining = listRunEvents(runId);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].kind, 'run-completed');
});

// ─── get_run_timeline chat tool (Phase 57 — P1) ─────────────────────────────

test('get_run_timeline: returns the same id-ordered rows as listRunEvents for an explicit run_id', async () => {
  const project = setupProject('run-events-tool');
  const runId = startAutoRun({ project });
  recordRunEvent(runId, 'run-started', { project });
  recordRunEvent(runId, 'phase-started', { project, phase: 1 });
  recordRunEvent(runId, 'dev-completed', { project, phase: 1 });
  const out = await toolGetRunTimeline({ project, run_id: runId });
  assert.equal(out.run_id, runId);
  assert.deepEqual(out.events, listRunEvents(runId), 'tool rows are byte-identical to listRunEvents');
  assert.deepEqual(out.events.map((e) => e.kind), ['run-started', 'phase-started', 'dev-completed']);
});

test('get_run_timeline: defaults to the most recent run when run_id is omitted', async () => {
  const project = setupProject('run-events-tool-default');
  const runId = startAutoRun({ project });
  recordRunEvent(runId, 'run-started', { project });
  const out = await toolGetRunTimeline({ project });
  assert.equal(out.run_id, runId, 'resolved to the last run');
  assert.equal(out.events.length, 1);
});

test('get_run_timeline: a legacy run with no events returns events:[] with a "no timeline" hint, never throws', async () => {
  const project = setupProject('run-events-tool-legacy');
  const runId = startAutoRun({ project }); // run row exists, but no events ever recorded
  const out = await toolGetRunTimeline({ project, run_id: runId });
  assert.deepEqual(out.events, []);
  assert.match(out.hint, /no timeline recorded/i);
});
