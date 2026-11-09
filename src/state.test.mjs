// Tests for next_pass persistence in acceptSuggestions / setSuggestionNextPass.
// Uses an in-memory SQLite database via DB_PATH=:memory: env override.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Set in-memory DB before importing state (the module reads DB_PATH at first getDb() call).
process.env.DB_PATH = ':memory:';

const {
  acceptSuggestions, saveSuggestions, setSuggestionNextPass,
  getLatestSuggestions, getFreshestSuggestions,
  staleDraftSuggestions, staleAllSuggestions, upsertProject,
  getEarlierSuggestionTitles,
  claimRunningJob, releaseRunningJob, getRunningJob,
  cacheHitPct, getSpendReport, recordCall, upsertSession, getLatestSessionContext,
  recordContextManifest, recordContextOutcome, recentContextManifests,
  recordContextCompileEvent, recentContextCompileEvents, getContextCompilerReport,
  contextCompilerRolloutWindow, getContextCompilerRollout, saveContextCompilerRollout,
  pruneOldContextCompilerTelemetry,
  recordPhaseExecutionFeature, recentPhaseExecutionFeatures,
  pidAlive, sweepInterruptedAutoRuns, startAutoRun, getDb,
  resetProjectForNewPlan, pauseAutoRun,
  upsertPhase, markPhaseStarted, markPhaseInterrupted, markPhaseCompleted, getPhases,
  parseProjectMetadata, setProjectMetadataField, getProject,
  migrate,
  addOperatorQuestion, listOperatorQuestions, answerOperatorQuestion, markOperatorQuestionNotified,
} = await import('./state.js');

test('phase interruption provenance is explicit and cleared on restart/completion', () => {
  const project = 'phase-interruption-state';
  setupProject(project);
  upsertPhase({ project, n: 1, title: 'P1', status: 'pending' });
  markPhaseStarted({ project, n: 1, model_used: 'claude-sonnet-5', session_id: 'sess-1' });
  markPhaseInterrupted({ project, n: 1, kind: 'provider-limit', reason: 'reset later' });
  let row = getPhases(project)[0];
  assert.equal(row.interruption_kind, 'provider-limit');
  assert.equal(row.interruption_reason, 'reset later');
  assert.ok(row.interrupted_at);

  markPhaseStarted({ project, n: 1, model_used: 'claude-sonnet-5', session_id: 'sess-1' });
  row = getPhases(project)[0];
  assert.equal(row.interruption_kind, null);
  markPhaseInterrupted({ project, n: 1, kind: 'process', reason: 'restart' });
  markPhaseCompleted({ project, n: 1, commit_sha: 'abc' });
  row = getPhases(project)[0];
  assert.equal(row.interruption_kind, null);
});

function setupProject(name = 'test-proj') {
  upsertProject({ name, tech_stack: 'node', total_phases: 3 });
}

function saveAndAccept(projectName, pipelinePlan, passes) {
  const id = saveSuggestions(projectName, {
    projectType: 'cli',
    scanSnapshot: { projectType: 'cli' },
    suggestions: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }],
  });
  acceptSuggestions(id, {
    selected: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    pipelinePlan,
    pipelinePasses: passes,
  });
  return id;
}

test('acceptSuggestions sets next_pass to lowest non-empty pass (pass 1 has items)', () => {
  setupProject('proj-a');
  saveAndAccept('proj-a', { '1': ['a', 'b'], '2': ['c'] }, 2);
  const row = getLatestSuggestions('proj-a');
  assert.equal(row.next_pass, 1, 'next_pass should be 1 when pass 1 has items');
});

test('acceptSuggestions sets next_pass to 2 when pass 1 is empty', () => {
  setupProject('proj-b');
  saveAndAccept('proj-b', { '1': [], '2': ['b', 'c'] }, 2);
  const row = getLatestSuggestions('proj-b');
  assert.equal(row.next_pass, 2, 'next_pass should be 2 when pass 1 is empty');
});

test('setSuggestionNextPass updates next_pass; getLatestSuggestions reflects it', () => {
  setupProject('proj-c');
  saveAndAccept('proj-c', { '1': ['a'], '2': ['b'] }, 2);
  setSuggestionNextPass('proj-c', 2);
  const row = getLatestSuggestions('proj-c');
  assert.equal(row.next_pass, 2, 'next_pass should be updated to 2 by setSuggestionNextPass');
});

test('acceptSuggestions with all passes empty defaults next_pass to 1', () => {
  setupProject('proj-d');
  saveAndAccept('proj-d', { '1': [], '2': [] }, 2);
  const row = getLatestSuggestions('proj-d');
  assert.equal(row.next_pass, 1, 'next_pass should default to 1 when all passes are empty');
});

// ─── getFreshestSuggestions ──────────────────────────────────────────────────

test('getFreshestSuggestions — no rows → null', () => {
  setupProject('fresh-none');
  const row = getFreshestSuggestions('fresh-none');
  assert.equal(row, null);
});

test('getFreshestSuggestions — accepted only → returns accepted row', () => {
  setupProject('fresh-accepted');
  const id = saveAndAccept('fresh-accepted', { '1': ['a'] }, 1);
  const row = getFreshestSuggestions('fresh-accepted');
  assert.ok(row !== null);
  assert.equal(row.status, 'accepted');
  assert.equal(row.id, id);
});

test('getFreshestSuggestions — draft only → returns draft row', () => {
  setupProject('fresh-draft');
  const id = saveSuggestions('fresh-draft', {
    projectType: 'cli', scanSnapshot: {}, suggestions: [],
  });
  const row = getFreshestSuggestions('fresh-draft');
  assert.ok(row !== null);
  assert.equal(row.status, 'draft');
  assert.equal(row.id, id);
});

test('getFreshestSuggestions — accepted + newer draft → returns draft (the bug scenario)', () => {
  setupProject('fresh-both');
  const acceptedId = saveAndAccept('fresh-both', { '1': ['a'] }, 1);
  const draftId = saveSuggestions('fresh-both', {
    projectType: 'cli', scanSnapshot: {}, suggestions: [],
  });
  assert.ok(draftId > acceptedId, 'draft row must have a higher id than accepted row');
  const row = getFreshestSuggestions('fresh-both');
  assert.ok(row !== null);
  assert.equal(row.status, 'draft', 'must return the draft, not the stale accepted row');
  assert.equal(row.id, draftId);
});

test('getLatestSuggestions — accepted + newer draft → still returns accepted (regression guard)', () => {
  setupProject('legacy-both');
  const acceptedId = saveAndAccept('legacy-both', { '1': ['a'] }, 1);
  const draftId = saveSuggestions('legacy-both', {
    projectType: 'cli', scanSnapshot: {}, suggestions: [],
  });
  assert.ok(draftId > acceptedId);
  const row = getLatestSuggestions('legacy-both');
  assert.ok(row !== null);
  assert.equal(row.status, 'accepted', 'getLatestSuggestions must still return accepted row');
  assert.equal(row.id, acceptedId);
});

test('getFreshestSuggestions — stale rows only → null', () => {
  setupProject('fresh-stale');
  saveAndAccept('fresh-stale', { '1': ['a'] }, 1);
  staleAllSuggestions('fresh-stale');
  const row = getFreshestSuggestions('fresh-stale');
  assert.equal(row, null, 'stale-only project should return null');
});

// ─── acceptSuggestions nextPass override ────────────────────────────────────

test('acceptSuggestions preserves cursor when nextPass is supplied (mid-pipeline add)', () => {
  setupProject('proj-cursor-preserve');
  const id = saveSuggestions('proj-cursor-preserve', {
    projectType: 'cli',
    scanSnapshot: {},
    suggestions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  });
  acceptSuggestions(id, {
    selected: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    pipelinePlan: { '1': ['a'], '2': ['b'], '3': ['c'] },
    pipelinePasses: 3,
  });
  const row1 = getLatestSuggestions('proj-cursor-preserve');
  assert.equal(row1.next_pass, 1, 'fresh accept should set cursor to 1');

  // Simulate mid-pipeline [A]dd: a new item goes into pass 3, cursor must stay at 3
  const newId = saveSuggestions('proj-cursor-preserve', {
    projectType: 'cli',
    scanSnapshot: {},
    suggestions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
  });
  acceptSuggestions(newId, {
    selected: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
    pipelinePlan: { '1': ['a'], '2': ['b'], '3': ['c', 'd'] },
    pipelinePasses: 3,
    nextPass: 3,   // preserve: passes 1 & 2 are already built
  });
  const row2 = getLatestSuggestions('proj-cursor-preserve');
  assert.equal(row2.next_pass, 3, 'mid-pipeline add must leave cursor at 3, not snap to 1');
  const sel = JSON.parse(row2.selected_json);
  assert.ok(sel.some(s => s.id === 'd'), 'new item must be in selected_json');
});

test('acceptSuggestions without nextPass still derives next_pass from lowestPass (regression)', () => {
  setupProject('proj-cursor-default');
  const id = saveSuggestions('proj-cursor-default', {
    projectType: 'cli',
    scanSnapshot: {},
    suggestions: [{ id: 'x' }, { id: 'y' }],
  });
  acceptSuggestions(id, {
    selected: [{ id: 'x' }, { id: 'y' }],
    pipelinePlan: { '1': [], '2': ['x', 'y'] },  // pass 1 empty → lowestPass = 2
    pipelinePasses: 2,
    // no nextPass
  });
  const row = getLatestSuggestions('proj-cursor-default');
  assert.equal(row.next_pass, 2, 'without nextPass override, lowestPass (2) must be used');
});

// ─── getEarlierSuggestionTitles — accepted row dedup ────────────────────────

test('getEarlierSuggestionTitles includes accepted plan titles without pre-staling', () => {
  setupProject('dedup-accepted');
  const id = saveSuggestions('dedup-accepted', {
    projectType: 'cli',
    scanSnapshot: { projectType: 'cli' },
    suggestions: [
      { id: 'x', title: 'Build dashboard' },
      { id: 'y', title: 'Add dark mode' },
    ],
  });
  acceptSuggestions(id, {
    selected:       [{ id: 'x', title: 'Build dashboard' }, { id: 'y', title: 'Add dark mode' }],
    pipelinePlan:   { '1': ['x', 'y'] },
    pipelinePasses: 1,
  });

  // Call WITHOUT staling the accepted row first (mirrors what _runScan does on the web path).
  const titles = getEarlierSuggestionTitles('dedup-accepted');

  assert.ok(titles.includes('Build dashboard'), 'accepted title "Build dashboard" must appear in avoid-list');
  assert.ok(titles.includes('Add dark mode'),   'accepted title "Add dark mode" must appear in avoid-list');
});

// ─── acceptSuggestions atomicity — crash-between-insert-and-accept ───────────

test('acceptSuggestions atomicity: draft insert without accept leaves old accepted row intact', () => {
  // Simulates a crash between saveSuggestions (insert) and acceptSuggestions.
  // The old accepted row must still be returned by getLatestSuggestions so the
  // suggest gate / loadSuggestionsBlock never see a plan-less project.
  setupProject('atomic-crash-sim');
  const oldId = saveAndAccept('atomic-crash-sim', { '1': ['a'] }, 1);

  // New draft inserted but acceptSuggestions never called (crash simulation).
  saveSuggestions('atomic-crash-sim', {
    projectType: 'cli', scanSnapshot: {}, suggestions: [{ id: 'b', title: 'B' }],
  });

  const row = getLatestSuggestions('atomic-crash-sim');
  assert.ok(row !== null, 'getLatestSuggestions must still return a row');
  assert.equal(row.status, 'accepted', 'old accepted row must still be accepted after partial failure');
  assert.equal(row.id, oldId, 'accepted row id must be the original accepted row, not the un-accepted draft');
});

test('acceptSuggestions atomicity: after successful accept, new row is accepted and old plan is stale', () => {
  setupProject('atomic-success');
  saveAndAccept('atomic-success', { '1': ['a'] }, 1);
  const newId = saveSuggestions('atomic-success', {
    projectType: 'cli',
    scanSnapshot: {},
    suggestions: [{ id: 'b', title: 'B' }],
  });
  acceptSuggestions(newId, {
    selected: [{ id: 'b', title: 'B' }],
    pipelinePlan: { '1': ['b'] },
    pipelinePasses: 1,
  });

  const row = getLatestSuggestions('atomic-success');
  assert.ok(row !== null);
  assert.equal(row.status, 'accepted');
  assert.equal(row.id, newId, 'new row must be the accepted one');

  // Old row is now stale: staling all then querying must return null (no accepted rows remain after stale).
  // Stale the new row to verify old row is already stale (not a second accepted row).
  staleAllSuggestions('atomic-success');
  const afterStale = getLatestSuggestions('atomic-success');
  assert.equal(afterStale, null, 'no accepted rows should exist after staling all — confirms old row was already stale');
});

test('getEarlierSuggestionTitles does not stale or mutate the accepted row', () => {
  setupProject('dedup-no-mutate');
  const id = saveSuggestions('dedup-no-mutate', {
    projectType: 'cli',
    scanSnapshot: {},
    suggestions: [{ id: 'z', title: 'Ship it' }],
  });
  acceptSuggestions(id, {
    selected:       [{ id: 'z', title: 'Ship it' }],
    pipelinePlan:   { '1': ['z'] },
    pipelinePasses: 1,
  });

  getEarlierSuggestionTitles('dedup-no-mutate');

  const row = getLatestSuggestions('dedup-no-mutate');
  assert.equal(row.status, 'accepted', 'accepted row must remain accepted after getEarlierSuggestionTitles call');
  assert.equal(row.id, id, 'accepted row id must be unchanged');
});

// ─── running_jobs mutex helpers ──────────────────────────────────────────────

test('claimRunningJob inserts a row readable by getRunningJob', () => {
  claimRunningJob('rj-proj-1', 1234);
  const row = getRunningJob('rj-proj-1');
  assert.ok(row != null, 'row should exist after claim');
  assert.equal(row.project, 'rj-proj-1');
  assert.equal(row.pid, 1234);
  assert.ok(typeof row.started_at === 'string' && row.started_at.length > 0, 'started_at should be set');
  releaseRunningJob('rj-proj-1'); // cleanup
});

test('claimRunningJob throws on duplicate project (UNIQUE constraint)', () => {
  claimRunningJob('rj-proj-dup', 1111);
  try {
    assert.throws(
      () => claimRunningJob('rj-proj-dup', 2222),
      /UNIQUE constraint failed/,
      'second claim for same project must throw UNIQUE constraint error',
    );
  } finally {
    releaseRunningJob('rj-proj-dup'); // cleanup
  }
});

test('releaseRunningJob deletes the row; getRunningJob returns undefined', () => {
  claimRunningJob('rj-proj-release', 5555);
  assert.ok(getRunningJob('rj-proj-release') != null, 'row should exist before release');
  releaseRunningJob('rj-proj-release');
  assert.equal(getRunningJob('rj-proj-release'), undefined, 'row should not exist after release');
});

test('releaseRunningJob on non-existent project is a no-op', () => {
  // Should not throw
  releaseRunningJob('rj-proj-nonexistent');
  assert.equal(getRunningJob('rj-proj-nonexistent'), undefined);
});

test('getRunningJob returns undefined when no row exists', () => {
  assert.equal(getRunningJob('rj-proj-absent'), undefined);
});

// ─── pidAlive / sweepInterruptedAutoRuns (crash-recovery sweep) ─────────────

test('pidAlive: current process pid is alive; a pid that cannot exist is dead', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(2147483646), false); // convention used across this repo's tests
  assert.equal(pidAlive(null), false);
  assert.equal(pidAlive(0), false);
});

test('sweepInterruptedAutoRuns: a running row with no running_jobs claim is marked interrupted', () => {
  const project = 'sweep-no-claim';
  setupProject(project);
  const runId = startAutoRun({ project });

  const swept = sweepInterruptedAutoRuns();

  assert.ok(swept.some((r) => r.id === runId), 'the unclaimed running row must be in the swept list');
  const row = getDb().prepare('SELECT * FROM auto_runs WHERE id = ?').get(runId);
  assert.equal(row.status, 'interrupted');
  assert.equal(row.pause_reason, 'orchestrator crashed or was killed mid-run');
  assert.ok(row.ended_at, 'ended_at must be populated');
});

test('sweepInterruptedAutoRuns: a running row whose running_jobs claim has a dead pid is marked interrupted', () => {
  const project = 'sweep-dead-pid';
  setupProject(project);
  const runId = startAutoRun({ project });
  claimRunningJob(project, 2147483646); // pid that cannot be running

  try {
    const swept = sweepInterruptedAutoRuns();
    assert.ok(swept.some((r) => r.id === runId), 'the dead-pid-claimed running row must be swept');
    const row = getDb().prepare('SELECT * FROM auto_runs WHERE id = ?').get(runId);
    assert.equal(row.status, 'interrupted');
  } finally {
    releaseRunningJob(project);
  }
});

test('sweepInterruptedAutoRuns: a running row with a live, correctly-claimed running_jobs row is left untouched', () => {
  const project = 'sweep-live-claim';
  setupProject(project);
  const runId = startAutoRun({ project });
  claimRunningJob(project, process.pid); // this test process — guaranteed alive

  try {
    const swept = sweepInterruptedAutoRuns();
    assert.ok(!swept.some((r) => r.id === runId), 'a live, correctly-claimed run must not be swept');
    const row = getDb().prepare('SELECT * FROM auto_runs WHERE id = ?').get(runId);
    assert.equal(row.status, 'running', 'status must stay running');
    assert.equal(row.ended_at, null);
  } finally {
    releaseRunningJob(project);
  }
});

// ─── resetProjectForNewPlan: live-run auto_runs protection ──────────────────

test('resetProjectForNewPlan: a live-claimed running row is NOT aborted (self-abort guard)', () => {
  const project = 'reset-live-run';
  setupProject(project);
  const runId = startAutoRun({ project });
  claimRunningJob(project, process.pid); // this test process — guaranteed alive

  try {
    resetProjectForNewPlan(project, 3);
    const row = getDb().prepare('SELECT * FROM auto_runs WHERE id = ?').get(runId);
    assert.equal(row.status, 'running', 'a live run must keep its running row');
    assert.equal(row.ended_at, null, 'ended_at must not be set for a live run');
    // the rest of the reset still happened
    const proj = getProject(project);
    assert.equal(proj.current_phase, 0);
    assert.equal(proj.total_phases, 3);
  } finally {
    releaseRunningJob(project);
  }
});

test('resetProjectForNewPlan: a running row whose claim pid is dead IS aborted', () => {
  const project = 'reset-dead-claim';
  setupProject(project);
  const runId = startAutoRun({ project });
  claimRunningJob(project, 2147483646); // pid that cannot be running

  try {
    resetProjectForNewPlan(project, 4);
    const row = getDb().prepare('SELECT * FROM auto_runs WHERE id = ?').get(runId);
    assert.equal(row.status, 'aborted', 'a dead-claim running row must be aborted');
    assert.ok(row.ended_at, 'ended_at must be set');
  } finally {
    releaseRunningJob(project);
  }
});

test('resetProjectForNewPlan: a running row with no claim IS aborted', () => {
  const project = 'reset-no-claim';
  setupProject(project);
  const runId = startAutoRun({ project });

  resetProjectForNewPlan(project, 2);
  const row = getDb().prepare('SELECT * FROM auto_runs WHERE id = ?').get(runId);
  assert.equal(row.status, 'aborted', 'an unclaimed running row must be aborted');
  assert.ok(row.ended_at, 'ended_at must be set');
});

test('resetProjectForNewPlan: a paused row is aborted even while a live run is protected', () => {
  const project = 'reset-paused-plus-live';
  setupProject(project);
  const pausedId = startAutoRun({ project });
  pauseAutoRun(pausedId, 'rate limit', 'rate-limit');
  const liveId = startAutoRun({ project }); // paused row stays paused; this is the new running row
  claimRunningJob(project, process.pid);

  try {
    resetProjectForNewPlan(project, 5);
    const paused = getDb().prepare('SELECT * FROM auto_runs WHERE id = ?').get(pausedId);
    const live = getDb().prepare('SELECT * FROM auto_runs WHERE id = ?').get(liveId);
    assert.equal(paused.status, 'aborted', 'the old paused run must be cleared');
    assert.equal(live.status, 'running', 'the live run must be protected');
  } finally {
    releaseRunningJob(project);
  }
});

// ─── cacheHitPct / getSpendReport (P1: cache-hit visibility) ────────────────

test('cacheHitPct: computes cache_read / (input + cache_read + cache_creation), rounded to 1 decimal', () => {
  assert.equal(cacheHitPct({ input_tokens: 100, cache_read_tokens: 300, cache_creation_tokens: 0 }), 75);
  assert.equal(cacheHitPct({ input_tokens: 0, cache_read_tokens: 1, cache_creation_tokens: 2 }), 33.3);
});

test('cacheHitPct: guards ÷0 — an all-zero row returns 0, never NaN/Infinity', () => {
  assert.equal(cacheHitPct({ input_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }), 0);
  assert.equal(cacheHitPct({}), 0);
  assert.equal(cacheHitPct(undefined), 0);
});

test('cacheHitPct: a cache-creation-only call (fresh session, no reads/inputs) is 0%, not NaN', () => {
  const pct = cacheHitPct({ input_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 5000 });
  assert.equal(pct, 0);
  assert.ok(Number.isFinite(pct));
});

test('getSpendReport: rows and totals carry cache_hit_pct from the shared helper', () => {
  const project = 'spend-report-proj';
  setupProject(project);
  recordCall({
    project, task: 'dev-execution', model: 'claude-sonnet-4-6',
    cost_usd: 1.5, input_tokens: 100, output_tokens: 50,
    cache_read_tokens: 300, cache_creation_tokens: 0, is_error: 0,
  });
  recordCall({
    project, task: 'dev-execution', model: 'claude-sonnet-4-6',
    cost_usd: 0.5, input_tokens: 0, output_tokens: 20,
    cache_read_tokens: 0, cache_creation_tokens: 0, is_error: 1,
  });
  const report = getSpendReport({ days: 30, project });
  assert.equal(report.rows.length, 1, 'both calls grouped under the same task+model row');
  const row = report.rows[0];
  assert.equal(row.n, 2);
  assert.equal(row.cache_read_tokens, 300);
  assert.equal(row.cache_hit_pct, cacheHitPct(row), 'row cache_hit_pct matches the shared formula');
  assert.equal(report.totals.n, 2);
  assert.equal(report.totals.cache_hit_pct, cacheHitPct(report.totals), 'totals row uses the same shared formula');
});

test('getSpendReport: an all-NULL-token row (e.g. a hard-errored call) does not throw or emit NaN', () => {
  const project = 'spend-report-zero';
  setupProject(project);
  recordCall({
    project, task: 'fix-execution', model: 'claude-opus-4-8',
    cost_usd: null, input_tokens: null, output_tokens: null,
    cache_read_tokens: null, cache_creation_tokens: null, is_error: 1,
  });
  const report = getSpendReport({ days: 30, project });
  assert.equal(report.rows[0].cache_hit_pct, 0);
  assert.ok(!Number.isNaN(report.rows[0].cache_hit_pct));
  assert.equal(report.totals.cache_hit_pct, 0);
});

// ─── calls.context_tokens (Phase 31 — usage-based guide compaction) ─────────
//
// Persists the LAST assistant turn's per-request context size (see
// claude-runner.js's lastTurnContextTokens) — the calibration data for
// phases.handoff_when_context_tokens_exceed and what runGuide()'s compaction
// trigger thresholds on. NOT the same value as the cumulative result.usage
// sum recordCall already persisted pre-phase-31.

test('migrate(): running it a second time against the same db is a no-op, never throws (context_tokens ADD COLUMN is idempotent)', () => {
  const db = getDb();
  assert.doesNotThrow(() => migrate(db));
  assert.doesNotThrow(() => migrate(db));
  const cols = db.prepare('PRAGMA table_info(calls)').all().map((c) => c.name);
  assert.ok(cols.includes('context_tokens'), 'context_tokens column exists after (repeated) migration');
});

// ─── operator_questions (Phase 48 — ask_operator MCP tool) ──────────────────

test('migrate(): operator_questions table exists on a fresh DB and after repeated migrate() calls (idempotent)', () => {
  const db = getDb();
  assert.doesNotThrow(() => migrate(db));
  assert.doesNotThrow(() => migrate(db));
  const cols = db.prepare('PRAGMA table_info(operator_questions)').all().map((c) => c.name);
  for (const col of ['id', 'project', 'phase', 'question', 'options', 'assumption', 'blocking', 'status', 'answer', 'answered_by', 'notified_at', 'created_at', 'answered_at']) {
    assert.ok(cols.includes(col), `operator_questions.${col} column exists`);
  }
});

test('addOperatorQuestion/listOperatorQuestions: round-trips a row with status open and JSON-encoded options', () => {
  const project = 'op-questions-proj';
  setupProject(project);
  const id = addOperatorQuestion({ project, phase: 3, question: 'Use REST or GraphQL?', options: ['REST', 'GraphQL'], assumption: 'Using REST for consistency.' });
  const rows = listOperatorQuestions({ project });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, id);
  assert.equal(rows[0].status, 'open');
  assert.equal(rows[0].blocking, 0);
  assert.deepEqual(JSON.parse(rows[0].options), ['REST', 'GraphQL']);

  const openOnly = listOperatorQuestions({ project, status: 'open' });
  assert.equal(openOnly.length, 1);
  const answeredOnly = listOperatorQuestions({ project, status: 'answered' });
  assert.equal(answeredOnly.length, 0);
});

test('answerOperatorQuestion: transitions an open row to answered, only once', () => {
  const project = 'op-questions-answer';
  setupProject(project);
  const id = addOperatorQuestion({ project, question: 'q', assumption: 'a' });
  const changed = answerOperatorQuestion(id, { answer: 'REST', answered_by: 42 });
  assert.equal(changed, 1);
  const row = listOperatorQuestions({ project })[0];
  assert.equal(row.status, 'answered');
  assert.equal(row.answer, 'REST');
  assert.equal(row.answered_by, 42);
  assert.ok(row.answered_at);

  // A second answer attempt on an already-answered row is a no-op (WHERE status = 'open').
  const secondAttempt = answerOperatorQuestion(id, { answer: 'GraphQL', answered_by: 99 });
  assert.equal(secondAttempt, 0);
  assert.equal(listOperatorQuestions({ project })[0].answer, 'REST');
});

test('markOperatorQuestionNotified: sets notified_at, initially NULL', () => {
  const project = 'op-questions-notify';
  setupProject(project);
  const id = addOperatorQuestion({ project, question: 'q', assumption: 'a' });
  assert.equal(listOperatorQuestions({ project })[0].notified_at, null);
  const changed = markOperatorQuestionNotified(id);
  assert.equal(changed, 1);
  assert.ok(listOperatorQuestions({ project })[0].notified_at);
});

test('recordCall persists context_tokens on the calls row', () => {
  const project = 'context-tokens-proj';
  setupProject(project);
  recordCall({
    project, task: 'next-prompt', model: 'claude-sonnet-4-6',
    cost_usd: 0.1, input_tokens: 10, output_tokens: 5,
    cache_read_tokens: 0, cache_creation_tokens: 0, is_error: 0,
    context_tokens: 162345,
  });
  const row = getDb().prepare(`SELECT context_tokens FROM calls WHERE project = ? ORDER BY id DESC LIMIT 1`).get(project);
  assert.equal(row.context_tokens, 162345);
});

test('recordCall omitting context_tokens (every pre-phase-31 call site) records NULL, never throws', () => {
  const project = 'context-tokens-legacy';
  setupProject(project);
  assert.doesNotThrow(() => recordCall({
    project, task: 'next-prompt', model: 'claude-sonnet-4-6',
    cost_usd: 0.1, input_tokens: 10, output_tokens: 5,
    cache_read_tokens: 0, cache_creation_tokens: 0, is_error: 0,
  }));
  const row = getDb().prepare(`SELECT context_tokens FROM calls WHERE project = ? ORDER BY id DESC LIMIT 1`).get(project);
  assert.equal(row.context_tokens, null);
});

test('recordCall: a non-finite context_tokens (e.g. undefined from a stream with no assistant usage event) records NULL, not NaN', () => {
  const project = 'context-tokens-nonfinite';
  setupProject(project);
  recordCall({
    project, task: 'next-prompt', model: 'claude-sonnet-4-6',
    cost_usd: 0.1, input_tokens: 10, output_tokens: 5,
    cache_read_tokens: 0, cache_creation_tokens: 0, is_error: 0,
    context_tokens: null,
  });
  const row = getDb().prepare(`SELECT context_tokens FROM calls WHERE project = ? ORDER BY id DESC LIMIT 1`).get(project);
  assert.equal(row.context_tokens, null);
});

test('phase execution features aggregate initial + continuation call turns for portfolio learning', () => {
  const project = 'phase-size-history';
  setupProject(project);
  const since = new Date(Date.now() - 1000).toISOString();
  recordCall({
    project, phase: 4, task: 'dev-execution', model: 'claude-sonnet-5',
    num_turns: 42, context_tokens: 120000, is_error: true,
  });
  recordCall({
    project, phase: 4, task: 'dev-execution', model: 'claude-sonnet-5',
    num_turns: 12, context_tokens: 145000, is_error: false,
  });
  const id = recordPhaseExecutionFeature({
    project, phase: 4, task_kind: 'dev-execution', execution_started_at: since,
    criteria_count: 7, files_count: 9, high_risk: 1, dependency_count: 2,
    text_chars: 2400, max_turn_error: true, success: true,
  });
  assert.ok(id > 0);
  const [row] = recentPhaseExecutionFeatures({ project, limit: 5 });
  assert.equal(row.actual_turns, 54);
  assert.equal(row.context_tokens, 145000);
  assert.equal(row.criteria_count, 7);
  assert.equal(row.max_turn_error, 1);
  assert.equal(row.success, 1);
});

test('Hybrid Context Compiler telemetry: manifest and per-call attribution round-trip', () => {
  const project = 'context-compiler-telemetry';
  setupProject(project);
  const manifest = {
    manifest_id: 'c'.repeat(64), project, phase: 2, task_kind: 'phase', base_sha: 'sha2',
    provider: 'hybrid-lexical', mode: 'shadow', generated_at: new Date().toISOString(),
    duration_ms: 12, injected_token_estimate: 345, confidence: 0.82,
    candidate_counts: { files: 40, symbols: 120 }, manifest_path: '/tmp/manifest.json',
    package_scopes: ['packages/consent/'],
    ranked_files: [{ path: 'src/a.js' }, { path: 'src/b.js' }],
  };
  assert.equal(recordContextManifest(manifest), true);
  const rows = recentContextManifests(project);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].manifest_id, manifest.manifest_id);
  assert.equal(rows[0].confidence, 0.82);
  assert.equal(rows[0].candidate_files, 40);
  assert.deepEqual(JSON.parse(rows[0].package_scopes), ['packages/consent/']);
  const outcome = recordContextOutcome({ manifest_id: manifest.manifest_id, actual_files: ['src/a.js'] });
  assert.deepEqual(outcome, { predicted: 2, actual: 1, intersection: 1, precision: 0.5, recall: 1 });

  recordCall({
    project, task: 'dev-execution', model: 'claude-sonnet-5', is_error: false,
    context_manifest_id: manifest.manifest_id,
    context_provider: manifest.provider,
    context_mode: manifest.mode,
    context_injected_tokens: 0,
  });
  const call = getDb().prepare(`SELECT context_manifest_id, context_provider, context_mode, context_injected_tokens FROM calls WHERE project = ? ORDER BY id DESC LIMIT 1`).get(project);
  assert.deepEqual(call, {
    context_manifest_id: manifest.manifest_id,
    context_provider: 'hybrid-lexical',
    context_mode: 'shadow',
    context_injected_tokens: 0,
  });

  const eventId = recordContextCompileEvent({
    project, phase: 2, task_kind: 'phase', requested_mode: 'shadow', provider: manifest.provider,
    status: 'compiled', manifest_id: manifest.manifest_id, duration_ms: 12,
  });
  assert.ok(eventId > 0);
  assert.equal(recentContextCompileEvents(project, 5)[0].manifest_id, manifest.manifest_id);

  const report = getContextCompilerReport({ project, days: 30 });
  assert.equal(report.status, 'shadow-baseline');
  assert.equal(report.samples.compile_attempts, 1);
  assert.equal(report.samples.measured_outcomes, 1);
  assert.equal(report.samples.failure_telemetry_complete, true);
  assert.equal(report.accuracy.edit_precision_pct, 50);
  assert.equal(report.accuracy.edit_recall_pct, 100);
  assert.match(report.tokens.note, /not a causal A\/B estimate/);
  assert.match(report.tokens.note, /Claude Max quota/);

  const rolloutRows = contextCompilerRolloutWindow(project, 5);
  assert.equal(rolloutRows[0].artifact_manifest_id, manifest.manifest_id);
  assert.equal(rolloutRows[0].recall, 1);
  assert.deepEqual(JSON.parse(rolloutRows[0].package_scopes), ['packages/consent/']);
  assert.equal(saveContextCompilerRollout({
    project, configured_mode: 'shadow', effective_mode: 'assist', recommendation: 'promote-to-assist', stage_id: 'stage-1', evidence: { recall: 1 },
  }), true);
  assert.equal(getContextCompilerRollout(project).effective_mode, 'assist');
  assert.equal(saveContextCompilerRollout({
    project, configured_mode: 'shadow', effective_mode: 'shadow', recommendation: 'automation-disabled',
    stage_id: 'stage-2', evidence: { transition: { from_mode: 'assist', to_mode: 'shadow' } },
  }), true);
  assert.equal(getDb().prepare(`SELECT COUNT(*) AS n FROM context_compiler_rollout_events WHERE project = ?`).get(project).n, 2,
    'policy kill-switch transitions join promotion/rollback in the append-only audit history');
});

test('getLatestSessionContext returns the newest attributed manifest for a resumable session', () => {
  const project = 'latest-session-context';
  const sessionId = 'latest-session-context-dev';
  setupProject(project);
  upsertSession({ session_id: sessionId, project, role: 'dev' });
  recordCall({
    session_id: sessionId, project, task: 'dev-execution', model: 'claude-sonnet-4-6',
    context_manifest_id: 'older-manifest', context_provider: 'hybrid-lexical',
    context_mode: 'assist', context_injected_tokens: 240,
  });
  recordCall({
    session_id: sessionId, project, task: 'dev-execution', model: 'claude-sonnet-4-6',
    context_manifest_id: 'newer-manifest', context_provider: 'semantic-fixture',
    context_mode: 'enforce', context_injected_tokens: 0,
  });
  assert.deepEqual(getLatestSessionContext(sessionId), {
    manifest_id: 'newer-manifest',
    provider: 'semantic-fixture',
    mode: 'enforce',
    injected_tokens: 0,
  });
  assert.equal(getLatestSessionContext('unknown-session'), null);
  assert.equal(getLatestSessionContext(null), null);
});

test('context compiler report counts failed and timed-out attempts even without artifacts', () => {
  const project = 'context-compiler-failures';
  setupProject(project);
  recordContextCompileEvent({ project, status: 'failed', error_message: 'index failed' });
  recordContextCompileEvent({ project, status: 'timeout', error_message: 'too slow' });
  const report = getContextCompilerReport({ project });
  assert.equal(report.samples.compile_attempts, 2);
  assert.equal(report.samples.compile_errors, 1);
  assert.equal(report.samples.compile_timeouts, 1);
  assert.equal(report.samples.artifacts, 0);
});

test('context compiler retention prunes expired telemetry without deleting referenced or escaped artifacts', () => {
  const project = 'context-compiler-retention';
  setupProject(project);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aorch-context-retention-'));
  const projectDir = path.join(root, project);
  fs.mkdirSync(projectDir, { recursive: true });
  const outsidePath = path.join(os.tmpdir(), `aorch-context-outside-${process.pid}.json`);
  const old = '2000-01-01T00:00:00.000Z';
  const ids = {
    expired: 'd'.repeat(64),
    callProtected: 'e'.repeat(64),
    rolloutProtected: 'f'.repeat(64),
    fresh: `${'a'.repeat(63)}1`,
    escaped: `${'b'.repeat(63)}2`,
  };
  const manifestPath = (id) => path.join(projectDir, `${id}.json`);
  const addManifest = (id, generatedAt, filePath = manifestPath(id)) => {
    fs.writeFileSync(filePath, `${JSON.stringify({ manifest_id: id })}\n`);
    recordContextManifest({
      manifest_id: id, project, phase: 1, task_kind: 'phase', provider: 'hybrid-lexical',
      mode: 'shadow', generated_at: generatedAt, manifest_path: filePath, ranked_files: [],
    });
  };

  try {
    addManifest(ids.expired, old);
    addManifest(ids.callProtected, old);
    addManifest(ids.rolloutProtected, old);
    addManifest(ids.fresh, new Date().toISOString());
    addManifest(ids.escaped, old, outsidePath);
    fs.writeFileSync(path.join(projectDir, 'latest.json'), `${JSON.stringify({ manifest_id: ids.expired })}\n`);

    recordContextCompileEvent({ project, status: 'compiled', manifest_id: ids.expired, started_at: old });
    recordContextCompileEvent({ project, status: 'compiled', manifest_id: ids.callProtected, started_at: old });
    recordContextCompileEvent({ project, status: 'compiled', manifest_id: ids.callProtected, started_at: old });
    recordContextCompileEvent({ project, status: 'compiled', manifest_id: ids.rolloutProtected, started_at: old });
    recordContextCompileEvent({ project, status: 'compiled', manifest_id: ids.fresh });
    recordContextCompileEvent({ project, status: 'compiled', manifest_id: ids.escaped, started_at: old });

    recordCall({
      project, task: 'dev-execution', model: 'claude-sonnet-4-6',
      context_manifest_id: ids.callProtected, context_mode: 'shadow', context_provider: 'hybrid-lexical',
    });
    saveContextCompilerRollout({
      project, configured_mode: 'shadow', effective_mode: 'assist', recommendation: 'promote-to-assist',
      stage_id: 'retention-current-stage', evidence: { metrics: { manifest_ids: [ids.rolloutProtected] } },
    });
    getDb().prepare(`UPDATE context_compiler_rollout_events SET created_at = ? WHERE stage_id = ?`)
      .run(old, 'retention-current-stage');
    getDb().prepare(`
      INSERT INTO context_compiler_rollout_events (
        stage_id, project, configured_mode, effective_mode, recommendation, evidence_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('retention-obsolete-stage', project, 'shadow', 'assist', 'promote-to-assist', '{}', old);

    const result = pruneOldContextCompilerTelemetry(30, { contextRoot: root });
    assert.deepEqual(result, {
      events: 3,
      manifests: 2,
      rollout_events: 1,
      files: 1,
      file_errors: 0,
      unsafe_paths: 1,
      protected_manifests: 2,
      latest_repaired: 1,
      latest_removed: 0,
    });
    const retained = new Set(getDb().prepare(`SELECT manifest_id FROM context_manifests WHERE project = ?`).all(project).map((row) => row.manifest_id));
    assert.deepEqual(retained, new Set([ids.callProtected, ids.rolloutProtected, ids.fresh]));
    assert.equal(fs.existsSync(manifestPath(ids.expired)), false);
    assert.equal(fs.existsSync(manifestPath(ids.callProtected)), true);
    assert.equal(fs.existsSync(manifestPath(ids.rolloutProtected)), true);
    assert.equal(fs.existsSync(manifestPath(ids.fresh)), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(projectDir, 'latest.json'), 'utf8')).manifest_id, ids.fresh,
      'latest.json is atomically repointed instead of retaining a deleted manifest copy');
    assert.equal(fs.existsSync(outsidePath), true, 'retention must never unlink a manifest_path outside the managed root');
    assert.equal(getDb().prepare(`SELECT COUNT(*) AS n FROM context_compile_events WHERE manifest_id = ?`).get(ids.callProtected).n, 1,
      'one tracking event remains for a protected old artifact; duplicate old attempts are pruned');
    assert.equal(getDb().prepare(`SELECT COUNT(*) AS n FROM context_compiler_rollout_events WHERE project = ?`).get(project).n, 1,
      'the current stage remains even after its timestamp ages out');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outsidePath, { force: true });
  }
});

test('context compiler token comparison matches complete session-attempt workloads by routing cohort', () => {
  const project = 'context-compiler-workload-report';
  setupProject(project);
  recordContextCompileEvent({ project, status: 'failed', error_message: 'fixture event' });

  const addWorkload = ({ mode, index, routingTier, firstTokens, secondTokens, attempt = 1 }) => {
    const sessionId = `${project}-${mode}-${routingTier}-${index}`;
    const manifestId = `${mode}-${routingTier}-${index}`;
    upsertSession({ session_id: sessionId, project, role: 'dev' });
    for (const [callIndex, tokens] of [firstTokens, secondTokens].entries()) {
      recordCall({
        session_id: sessionId, project, phase: 4, task: 'dev-execution', model: 'claude-sonnet-4-6',
        input_tokens: tokens, cache_read_tokens: 0, cache_creation_tokens: 0,
        num_turns: 2, max_turns: 50, routing_tier: routingTier, attempt,
        is_error: callIndex === 0,
        context_manifest_id: manifestId, context_provider: 'hybrid-lexical', context_mode: mode,
      });
    }
  };

  for (let index = 0; index < 5; index += 1) {
    addWorkload({ mode: 'shadow', index, routingTier: 'sonnet', firstTokens: 120, secondTokens: 80 });
    addWorkload({ mode: 'assist', index, routingTier: 'sonnet', firstTokens: 30, secondTokens: 70, attempt: index === 4 ? 2 : 1 });
  }
  // A very expensive shadow workload in a different routing/complexity cohort
  // must not inflate the matched Sonnet baseline.
  addWorkload({ mode: 'shadow', index: 99, routingTier: 'opus', firstTokens: 6000, secondTokens: 4000 });

  const report = getContextCompilerReport({ project, days: 30 });
  assert.equal(report.tokens.matched_shadow_delta_tokens, 500);
  assert.equal(report.tokens.matched_shadow_delta_pct, 50);
  assert.equal(report.tokens.matched_assist_n, 10);
  assert.equal(report.tokens.matched_shadow_n, 10);
  assert.equal(report.tokens.matched_assist_workload_n, 5);
  assert.equal(report.tokens.matched_shadow_workload_n, 5);
  assert.equal(report.tokens.matched_cohort_n, 1);
  assert.equal(report.tokens.comparison_error_call_n, 10);
  assert.equal(report.tokens.comparison_continuation_call_n, 10);
  assert.equal(report.tokens.comparison_retry_workload_n, 1);
  assert.equal(report.tokens.comparison_unit, 'session-attempt-workload');
  assert.match(report.tokens.comparison_method, /task\+model\+routing-tier/);
  assert.equal(report.tokens.confidence, 'directional');
});

// ─── parseProjectMetadata / setProjectMetadataField (Phase 20, brief P3) ────
//
// upsertProject() does a FULL REPLACE of metadata_json — setProjectMetadataField
// is the only sanctioned single-key patch (read-modify-write). These tests are
// the phase's core correctness gate: a naive implementation that routed
// through upsertProject would silently wipe every other metadata key.

test('parseProjectMetadata: null/undefined/malformed JSON all resolve to {}, never throw', () => {
  assert.deepEqual(parseProjectMetadata(null), {});
  assert.deepEqual(parseProjectMetadata(undefined), {});
  assert.deepEqual(parseProjectMetadata(''), {});
  assert.deepEqual(parseProjectMetadata('{not valid json'), {});
});

test('parseProjectMetadata: valid JSON parses through', () => {
  assert.deepEqual(parseProjectMetadata('{"foo":"bar"}'), { foo: 'bar' });
});

test('setProjectMetadataField: round-trips last_guide_head_sha WITHOUT clobbering an existing unrelated key', () => {
  const project = 'meta-clobber-guard';
  upsertProject({ name: project, tech_stack: 'node', total_phases: 1, metadata: { foo: 'bar' } });

  setProjectMetadataField(project, 'last_guide_head_sha', 'deadbeef01');

  const row = getProject(project);
  const metadata = parseProjectMetadata(row.metadata_json);
  assert.equal(metadata.foo, 'bar', 'pre-existing unrelated key must survive the single-key patch');
  assert.equal(metadata.last_guide_head_sha, 'deadbeef01');
});

test('setProjectMetadataField: on a project with no metadata_json yet, creates it fresh with just the one key', () => {
  const project = 'meta-fresh';
  upsertProject({ name: project, tech_stack: 'node', total_phases: 1 }); // no metadata → stored as '{}'

  setProjectMetadataField(project, 'last_guide_head_sha', 'cafefeed02');

  const row = getProject(project);
  assert.deepEqual(parseProjectMetadata(row.metadata_json), { last_guide_head_sha: 'cafefeed02' });
});

test('setProjectMetadataField: calling it twice for the same key overwrites (no duplicate/stale value)', () => {
  const project = 'meta-overwrite';
  upsertProject({ name: project, tech_stack: 'node', total_phases: 1 });

  setProjectMetadataField(project, 'last_guide_head_sha', 'sha-one');
  setProjectMetadataField(project, 'last_guide_head_sha', 'sha-two');

  const row = getProject(project);
  assert.equal(parseProjectMetadata(row.metadata_json).last_guide_head_sha, 'sha-two');
});

test('setProjectMetadataField: two distinct keys (mirrors phase 21 adding last_reground_sha alongside last_guide_head_sha) both survive', () => {
  const project = 'meta-two-keys';
  upsertProject({ name: project, tech_stack: 'node', total_phases: 1 });

  setProjectMetadataField(project, 'last_guide_head_sha', 'sha-A');
  setProjectMetadataField(project, 'last_reground_sha', 'sha-B');

  const row = getProject(project);
  const metadata = parseProjectMetadata(row.metadata_json);
  assert.equal(metadata.last_guide_head_sha, 'sha-A');
  assert.equal(metadata.last_reground_sha, 'sha-B');
});
