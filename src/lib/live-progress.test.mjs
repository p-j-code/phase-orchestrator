// Tests for Phase 59 — live phase telemetry (live_progress → SSE → header/chat).
// Covers: the pure ProgressTracker parser seam (turns, current_tool transitions,
// bounded files_touched, <=1 write per 3s window, final write on result), the
// deterministic ETA blend, the header formatter, the state.js DB round-trip
// (incl. max_turns), and the get_live_progress chat tool's idle/running shapes.
//
// Uses an in-memory SQLite database via DB_PATH=:memory: (set BEFORE importing
// state), the same discipline as run-events.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';

import {
  ProgressTracker, computeEtaMs, formatProgressHeader, formatDurationShort,
  FILES_TOUCHED_CAP, PROGRESS_THROTTLE_MS,
} from './live-progress.js';

const {
  upsertLiveProgress, getLiveProgress, deleteLiveProgress, avgCallDurationMs,
  upsertProject, upsertPhase, recordCall,
} = await import('../state.js');

const { toolGetLiveProgress } = await import('../chat/control-actions.js');

// ─── Stream-event fixtures ───────────────────────────────────────────────────
const asstToolUse = (id, name, input) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name, input }] },
});
const asstText = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const userToolResult = (id) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id }] },
});
const resultEv = () => ({ type: 'result', subtype: 'success' });

// A controllable clock: each read returns the current value; advance() bumps it.
function fakeClock(start = 0) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; return t; };
  now.set = (ms) => { t = ms; return t; };
  return now;
}

// ─── Parser seam ─────────────────────────────────────────────────────────────

test('turns count on user-turn events only (not assistant/result)', () => {
  const now = fakeClock(0);
  const tr = new ProgressTracker({ project: 'p', startedAt: 0, now, throttleMs: 0 });
  tr.onEvent(asstToolUse('t1', 'Bash', { command: 'ls' }));
  assert.equal(tr.turns, 0, 'assistant tool_use does not advance the turn count');
  tr.onEvent(userToolResult('t1'));
  assert.equal(tr.turns, 1, 'a user tool_result is one turn');
  tr.onEvent(asstText('thinking'));
  tr.onEvent(userToolResult('t2'));
  assert.equal(tr.turns, 2);
  tr.onEvent(resultEv());
  assert.equal(tr.turns, 2, 'the result event does not advance turns');
});

test('current_tool transitions: set on tool_use, cleared on matching tool_result', () => {
  const now = fakeClock(1000);
  const tr = new ProgressTracker({ project: 'p', startedAt: 1000, now, throttleMs: 0 });
  assert.equal(tr.currentTool(), null, 'no pending tool initially');

  tr.onEvent(asstToolUse('a', 'Bash', { command: 'npm test' }));
  assert.equal(tr.snapshot().current_tool, 'Bash: npm test');
  assert.equal(tr.snapshot().current_tool_started_at, 1000);

  // A second pending tool: the oldest (Bash) stays "current".
  now.advance(500);
  tr.onEvent(asstToolUse('b', 'Read', { file_path: '/x/y/state.js' }));
  assert.equal(tr.snapshot().current_tool, 'Bash: npm test', 'oldest pending tool is current');

  // Clear the oldest → the next pending becomes current. The label keeps the
  // last two path segments (basename-ish) for a compact header.
  tr.onEvent(userToolResult('a'));
  assert.equal(tr.snapshot().current_tool, 'Read: y/state.js');

  // Clear the last → no current tool.
  tr.onEvent(userToolResult('b'));
  assert.equal(tr.snapshot().current_tool, null);
});

test('files_touched collects file_path and command, bounded at FILES_TOUCHED_CAP (50)', () => {
  const now = fakeClock(0);
  const tr = new ProgressTracker({ project: 'p', startedAt: 0, now, throttleMs: 0 });
  // 40 distinct file_path edits + 30 distinct commands = 70 candidates, cap 50.
  for (let i = 0; i < 40; i += 1) tr.onEvent(asstToolUse(`f${i}`, 'Edit', { file_path: `/repo/src/file${i}.js` }));
  for (let i = 0; i < 30; i += 1) tr.onEvent(asstToolUse(`c${i}`, 'Bash', { command: `echo ${i}` }));
  const snap = tr.snapshot();
  assert.equal(snap.files_touched.length, FILES_TOUCHED_CAP, 'set is capped at 50');
  assert.ok(snap.files_touched.includes('/repo/src/file0.js'), 'a file_path was recorded');
  assert.ok(snap.files_touched.includes('echo 0'), 'a command was recorded (first 50 admitted)');
});

test('files_touched dedupes repeated touches of the same file', () => {
  const now = fakeClock(0);
  const tr = new ProgressTracker({ project: 'p', startedAt: 0, now, throttleMs: 0 });
  for (let i = 0; i < 10; i += 1) tr.onEvent(asstToolUse(`e${i}`, 'Edit', { file_path: '/repo/same.js' }));
  assert.equal(tr.snapshot().files_touched.length, 1);
});

test('at most one write per 3s window (throttle), with a forced final write on result', () => {
  const now = fakeClock(0);
  const writes = [];
  const tr = new ProgressTracker({
    project: 'p', startedAt: 0, now,
    throttleMs: PROGRESS_THROTTLE_MS,
    write: (snap) => writes.push({ at: now(), snap }),
  });

  // Burst of 6 events inside the first 3s window → exactly one write (the first).
  for (let i = 0; i < 6; i += 1) {
    tr.onEvent(asstToolUse(`t${i}`, 'Bash', { command: `step ${i}` }));
    now.advance(400); // 0,400,800,1200,1600,2000 — all < 3000
  }
  assert.equal(writes.length, 1, 'one write in the first 3s window');
  assert.equal(writes[0].at, 0, 'the first event writes immediately');

  // Cross the window boundary → next event is allowed to write.
  now.set(3000);
  tr.onEvent(userToolResult('t0'));
  assert.equal(writes.length, 2, 'a second write once >=3s has elapsed');

  // Another in-window burst → still throttled.
  now.set(4000);
  tr.onEvent(asstText('mid'));
  assert.equal(writes.length, 2, 'still throttled within the same 3s window');

  // The result event forces a final write, bypassing the throttle.
  now.set(4500);
  tr.onEvent(resultEv());
  assert.equal(writes.length, 3, 'result forces a final write regardless of throttle');
});

test('onEvent never throws on malformed / partial events and swallows writer errors', () => {
  const now = fakeClock(0);
  const tr = new ProgressTracker({ project: 'p', startedAt: 0, now, throttleMs: 0, write: () => { throw new Error('boom'); } });
  assert.doesNotThrow(() => {
    tr.onEvent(null);
    tr.onEvent({});
    tr.onEvent({ type: 'assistant' });
    tr.onEvent({ type: 'assistant', message: { content: 'not-an-array' } });
    tr.onEvent(asstToolUse('x', 'Bash', { command: 'ok' })); // triggers the throwing writer
    tr.onEvent(resultEv());
  });
});

// ─── Deterministic ETA ───────────────────────────────────────────────────────

test('computeEtaMs: null when there is no usable signal', () => {
  assert.equal(computeEtaMs({ now: 1000, startedAt: 0, turns: 0, maxTurns: null, historicalAvgMs: null }), null);
  // turns=0 → observed rate undefined; no historical → null.
  assert.equal(computeEtaMs({ now: 1000, startedAt: 0, turns: 0, maxTurns: 150, historicalAvgMs: null }), null);
});

test('computeEtaMs: observed turn rate only', () => {
  // 10 turns in 10s → 1s/turn; 140 remaining → 140_000ms.
  const eta = computeEtaMs({ now: 10_000, startedAt: 0, turns: 10, maxTurns: 150, historicalAvgMs: null });
  assert.equal(eta, 140_000);
});

test('computeEtaMs: historical only (no turns yet)', () => {
  // avg 300s, 60s elapsed → 240s remaining.
  const eta = computeEtaMs({ now: 60_000, startedAt: 0, turns: 0, maxTurns: 150, historicalAvgMs: 300_000 });
  assert.equal(eta, 240_000);
});

test('computeEtaMs: blends observed and historical (mean), never negative', () => {
  // observed: 10 turns/10s, 140 remaining → 140_000; historical: 100_000-10_000=90_000.
  const eta = computeEtaMs({ now: 10_000, startedAt: 0, turns: 10, maxTurns: 150, historicalAvgMs: 100_000 });
  assert.equal(eta, Math.round((140_000 + 90_000) / 2));
  // historical already exceeded → clamps to 0, not negative.
  const past = computeEtaMs({ now: 500_000, startedAt: 0, turns: 0, maxTurns: 150, historicalAvgMs: 100_000 });
  assert.equal(past, 0);
});

// ─── Header formatter ────────────────────────────────────────────────────────

test('formatProgressHeader renders the canonical one-line header', () => {
  const row = {
    turns: 34, max_turns: 150,
    current_tool: 'Bash: npm test', current_tool_started_at: 1_000,
    files_touched: new Array(12).fill('f'),
    eta_ms: 6 * 60_000,
  };
  const hdr = formatProgressHeader(row, { now: 1_000 + 42_000 });
  assert.equal(hdr, 'turn 34/150 · tool Bash: npm test (42s) · 12 files · ETA ~6m');
});

test('formatProgressHeader: null row → null (widget falls back), sparse row omits empty segments', () => {
  assert.equal(formatProgressHeader(null), null);
  // turns only, no tool / files / eta.
  assert.equal(formatProgressHeader({ turns: 3, max_turns: 60, files_touched: [] }), 'turn 3/60');
  // single file → singular label.
  assert.equal(formatProgressHeader({ turns: 1, max_turns: 60, files_touched: ['a'] }), 'turn 1/60 · 1 file');
});

test('formatDurationShort: s / m / h thresholds', () => {
  assert.equal(formatDurationShort(42_000), '42s');
  assert.equal(formatDurationShort(6 * 60_000), '6m');
  assert.equal(formatDurationShort(72 * 60_000), '1h 12m');
  assert.equal(formatDurationShort(-1), null);
  assert.equal(formatDurationShort(NaN), null);
});

// ─── state.js DB round-trip ──────────────────────────────────────────────────

test('upsert → get → delete round-trip; max_turns persists exactly; files_touched decoded to array', () => {
  const project = 'lp-roundtrip';
  upsertProject({ name: project, tech_stack: 'node', total_phases: 1 });
  upsertLiveProgress({
    project, pid: 4242, task: 'dev-execution', phase: 7, model: 'claude-opus-4-8',
    turns: 12, max_turns: 150, current_tool: 'Bash: npm test', current_tool_started_at: 111,
    files_touched: ['a.js', 'b.js'], last_text: 'hi', started_at: 100, eta_ms: 5000, updated_at: 200,
  });
  const row = getLiveProgress(project);
  assert.equal(row.max_turns, 150, 'max_turns persists exactly (acceptance: cap lands in row)');
  assert.equal(row.turns, 12);
  assert.equal(row.phase, 7);
  assert.deepEqual(row.files_touched, ['a.js', 'b.js'], 'files_touched decoded to an array');
  assert.equal(row.updated_at, 200);

  // UPSERT overwrites the same single row (one row per project).
  upsertLiveProgress({ project, turns: 20, max_turns: 150, updated_at: 300, files_touched: [] });
  assert.equal(getLiveProgress(project).turns, 20);

  deleteLiveProgress(project);
  assert.equal(getLiveProgress(project), null, 'row deleted → idle (null)');
});

test('upsertLiveProgress caps files_touched at 50 on write; no-ops with a falsy project', () => {
  const project = 'lp-cap';
  upsertProject({ name: project, tech_stack: 'node', total_phases: 1 });
  const many = Array.from({ length: 80 }, (_, i) => `f${i}.js`);
  upsertLiveProgress({ project, turns: 1, files_touched: many, updated_at: 1 });
  assert.equal(getLiveProgress(project).files_touched.length, 50);
  // Falsy project is a no-op, never throws.
  assert.doesNotThrow(() => upsertLiveProgress({ project: null, turns: 1 }));
  assert.doesNotThrow(() => deleteLiveProgress(null));
  assert.equal(getLiveProgress(null), null);
});

test('avgCallDurationMs averages only successful calls for the (model, task) pair', () => {
  const task = 'lp-task';
  const model = 'lp-model';
  assert.equal(avgCallDurationMs(model, task), null, 'no samples → null');
  recordCall({ session_id: null, project: null, phase: null, task, model, duration_ms: 1000, is_error: false });
  recordCall({ session_id: null, project: null, phase: null, task, model, duration_ms: 3000, is_error: false });
  recordCall({ session_id: null, project: null, phase: null, task, model, duration_ms: 99_000, is_error: true });
  assert.equal(avgCallDurationMs(model, task), 2000, 'mean of the two successful durations (errored excluded)');
});

// ─── get_live_progress chat tool ─────────────────────────────────────────────

test('get_live_progress returns a clean idle when no row exists', async () => {
  const project = 'lp-idle';
  upsertProject({ name: project, tech_stack: 'node', total_phases: 1 });
  const out = await toolGetLiveProgress({ project });
  assert.equal(out.state, 'idle');
  assert.equal(out.progress, null);
  assert.ok(/idle/i.test(out.hint));
});

test('get_live_progress returns the row, a formatted header, and the phase title when running', async () => {
  const project = 'lp-running';
  upsertProject({ name: project, tech_stack: 'node', total_phases: 3 });
  upsertPhase({ project, n: 2, title: 'Wire the SSE loop', status: 'in-progress' });
  upsertLiveProgress({
    project, pid: 1, task: 'dev-execution', phase: 2, model: 'claude-opus-4-8',
    turns: 5, max_turns: 60, current_tool: 'Edit: src/web-ui.js', current_tool_started_at: 0,
    files_touched: ['src/web-ui.js'], last_text: 'editing', started_at: 0, eta_ms: 120_000, updated_at: 10,
  });
  const out = await toolGetLiveProgress({ project });
  assert.equal(out.state, 'running');
  assert.equal(out.phase_title, 'Wire the SSE loop');
  assert.equal(out.progress.turns, 5);
  assert.ok(out.header.startsWith('turn 5/60'), 'header is formatted from the row');
});
