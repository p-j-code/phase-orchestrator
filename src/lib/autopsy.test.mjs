// Tests for the structured failure autopsy (phase 62).
// In-memory SQLite via DB_PATH=:memory: (set before importing state).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = ':memory:';

const {
  upsertProject, startAutoRun, pauseAutoRun, getAutoRunById,
  recordRunEvent, recordCall, recordHealingAttempt, recordVerifyResult,
  listPendingOutbox, getDb,
} = await import('../state.js');

const {
  runAutopsy, validateAutopsy, buildAutopsySchema,
  assembleAutopsyContext, enumerateRecommendedActions,
} = await import('./autopsy.js');

const { mapStreamJsonLine } = await import('./stream-log.js');

// ─── Seeding helpers ─────────────────────────────────────────────────────────

let seq = 0;
async function makeProjDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopsy-test-'));
  return dir;
}

// Seed a project + a finalized (paused-on-error, or failed) auto_run row plus a
// bit of deterministic context. Returns { project, runId }.
function seedRun({ project, reason, pauseKind }) {
  upsertProject({ name: project, tech_stack: 'node', total_phases: 3 });
  const runId = startAutoRun({ project });
  // Widen the window so the errored call (recorded "now") is inside [start, end].
  getDb().prepare(`UPDATE auto_runs SET started_at = ? WHERE id = ?`).run('2020-01-01T00:00:00.000Z', runId);

  recordRunEvent(runId, 'phase-started', { project, phase: 2 });
  recordRunEvent(runId, 'dev-completed', { project, phase: 2, is_error: true });
  recordCall({ project, phase: 2, task: 'dev-execution', model: 'claude-sonnet-5', is_error: 1, error_message: 'tests failed: 3 assertions' });
  const hid = recordHealingAttempt({ project, error_kind: 'validation_failed', error_message: 'npm test exited 1', strategy: 'reprompt' });
  recordVerifyResult({ project, phase: 2, verdict: 'fail', criteria_met: 4, criteria_unmet: 2, unverifiable: 1 });

  // finalize() persists the row; mirror its pause write.
  pauseAutoRun(runId, reason, pauseKind ?? null);
  return { runId, hid };
}

// ─── AC1 — error-pause with a valid-JSON stub ────────────────────────────────

test('error-pause: valid-JSON stub populates autopsy JSON, the .md file, one outbox row (leading with the action), and one issue thread', async () => {
  const project = `ap-ac1-${++seq}`;
  const { runId } = seedRun({ project, reason: 'phase-error: dev reported errors', pauseKind: 'mid-build' });
  const projDir = await makeProjDir();

  const cfg = {
    models: { autopsy: 'claude-haiku-4-5' },
    tools: { allowed_default: ['Read'] },
    paths: { workspace_subdir: 'workspace' },
  };

  const recommended = `/run ${project} resume`; // priority-100 action for a mid-build pause
  const claudeCalls = [];
  const issueThreads = [];
  const runClaudeStub = async (args) => {
    claudeCalls.push(args);
    return {
      result: JSON.stringify({
        what_ran: 'phase 2 dev', what_failed: 'tests failed', what_was_tried: 'one reprompt',
        root_cause_hypothesis: 'assertion drift', recommended_action: recommended, confidence: 'medium',
      }),
      session_id: 'sid', is_error: false,
    };
  };

  const out = await runAutopsy({ cfg, projectName: project, runId }, {
    runClaude: runClaudeStub,
    windowStatus: () => ({ state: 'ok' }),
    openIssueThread: (a) => { issueThreads.push(a); return 1; },
    projDir,
    logsDir: path.join(projDir, 'no-logs'),
  });

  // Made exactly one haiku call, task='autopsy', model=haiku, tools locked to [].
  assert.equal(claudeCalls.length, 1);
  assert.equal(claudeCalls[0].task, 'autopsy');
  assert.equal(claudeCalls[0].cfg.model, 'claude-haiku-4-5');
  assert.deepEqual(claudeCalls[0].cfg.tools.allowed_default, []);
  assert.equal(claudeCalls[0].role, null);
  assert.equal(claudeCalls[0].sessionId, null); // roleless + sessionless — never resumed

  // auto_runs.autopsy populated with the validated JSON.
  const row = getAutoRunById(runId);
  assert.ok(row.autopsy, 'auto_runs.autopsy should be populated');
  const stored = JSON.parse(row.autopsy);
  assert.equal(stored.recommended_action, recommended);
  assert.equal(out.deterministic, false);

  // The .md artifact exists and names the recommended action.
  const md = await fs.readFile(path.join(projDir, '.guide', 'autopsies', `run-${runId}.md`), 'utf-8');
  assert.match(md, /Failure autopsy/);
  assert.ok(md.includes(recommended));

  // Exactly one pending outbox row, leading with the recommended action.
  const pending = listPendingOutbox(50).filter((r) => r.project === project);
  assert.equal(pending.length, 1);
  assert.ok(pending[0].text.startsWith(recommended), `outbox text should lead with the action, got: ${pending[0].text}`);

  // Exactly one issue thread, kind 'autopsy'.
  assert.equal(issueThreads.length, 1);
  assert.equal(issueThreads[0].kind, 'autopsy');
  assert.equal(issueThreads[0].project, project);
  assert.ok(issueThreads[0].detail && issueThreads[0].detail.length > 0);
});

// ─── AC2 — window-paused → NO LLM call, deterministic autopsy ─────────────────

test('window-paused (windowStatus.state === "pause") makes NO LLM call and emits a plain-text deterministic autopsy', async () => {
  const project = `ap-ac2-${++seq}`;
  const { runId } = seedRun({ project, reason: 'phase-error: dev reported errors', pauseKind: 'mid-build' });
  const projDir = await makeProjDir();
  const cfg = { models: { autopsy: 'claude-haiku-4-5' }, tools: { allowed_default: [] }, paths: { workspace_subdir: 'workspace' } };

  let claudeInvoked = 0;
  const out = await runAutopsy({ cfg, projectName: project, runId }, {
    runClaude: async () => { claudeInvoked += 1; throw new Error('the stub must not be invoked when the window is paused'); },
    windowStatus: () => ({ state: 'pause' }),
    openIssueThread: () => 1,
    projDir,
    logsDir: path.join(projDir, 'no-logs'),
  });

  assert.equal(claudeInvoked, 0, 'runClaude must not be called on a paused window');
  assert.equal(out.deterministic, true);

  const row = getAutoRunById(runId);
  assert.ok(row.autopsy, 'deterministic autopsy JSON should still be persisted');
  const md = await fs.readFile(path.join(projDir, '.guide', 'autopsies', `run-${runId}.md`), 'utf-8');
  assert.match(md, /deterministic \(no LLM\)/);
});

test('provider-limit pause makes NO autopsy LLM call even when the local billing window says ok', async () => {
  const project = `ap-provider-${++seq}`;
  const { runId } = seedRun({
    project,
    reason: "phase-error: You've hit your session limit · resets 6pm (Asia/Calcutta)",
    pauseKind: 'mid-build',
  });
  const projDir = await makeProjDir();
  const issueThreads = [];
  let claudeInvoked = 0;
  const out = await runAutopsy({
    cfg: { models: { autopsy: 'claude-haiku-4-5' }, tools: {}, paths: { workspace_subdir: 'workspace' } },
    projectName: project,
    runId,
  }, {
    runClaude: async () => { claudeInvoked += 1; throw new Error('must not run'); },
    windowStatus: () => ({ state: 'ok' }),
    openIssueThread: (args) => { issueThreads.push(args); return 1; },
    projDir,
    logsDir: path.join(projDir, 'no-logs'),
  });
  assert.equal(claudeInvoked, 0);
  assert.equal(out.deterministic, true);
  assert.equal(issueThreads[0].suppressAutoFix, true);
});

// ─── AC3 — invalid JSON → exactly one re-ask, then deterministic fallback ─────

test('invalid JSON triggers exactly one re-ask then the deterministic fallback', async () => {
  const project = `ap-ac3-${++seq}`;
  const { runId } = seedRun({ project, reason: 'phase-error: dev reported errors', pauseKind: 'mid-build' });
  const projDir = await makeProjDir();
  const cfg = { models: { autopsy: 'claude-haiku-4-5' }, tools: { allowed_default: [] }, paths: { workspace_subdir: 'workspace' } };

  let calls = 0;
  const out = await runAutopsy({ cfg, projectName: project, runId }, {
    runClaude: async () => { calls += 1; return { result: 'this is not json at all', session_id: 'sid', is_error: false }; },
    windowStatus: () => ({ state: 'ok' }),
    openIssueThread: () => 1,
    projDir,
    logsDir: path.join(projDir, 'no-logs'),
  });

  assert.equal(calls, 2, 'one initial call + exactly one re-ask');
  assert.equal(out.deterministic, true);
  const row = getAutoRunById(runId);
  assert.ok(row.autopsy, 'fallback autopsy JSON should be persisted');
});

test('an always-rejecting runClaude stub does not throw and does not fail finalization', async () => {
  const project = `ap-ac3b-${++seq}`;
  const { runId } = seedRun({ project, reason: 'failed: uncaught TypeError', pauseKind: null });
  const projDir = await makeProjDir();
  const cfg = { models: { autopsy: 'claude-haiku-4-5' }, tools: { allowed_default: [] }, paths: { workspace_subdir: 'workspace' } };

  let calls = 0;
  let threw = false;
  let out;
  try {
    out = await runAutopsy({ cfg, projectName: project, runId }, {
      runClaude: async () => { calls += 1; throw new Error('spawn EACCES'); },
      windowStatus: () => ({ state: 'ok' }),
      openIssueThread: () => 1,
      projDir,
      logsDir: path.join(projDir, 'no-logs'),
    });
  } catch { threw = true; }

  assert.equal(threw, false, 'runAutopsy must never throw');
  assert.equal(calls, 1, 'a thrown call goes straight to deterministic — no re-ask');
  assert.equal(out.deterministic, true);
  assert.ok(getAutoRunById(runId).autopsy);
});

// ─── AC4 — recommended_action outside the allowed set fails AJV ───────────────

test('a recommended_action outside the allowed getNextActions set fails AJV validation', () => {
  const allowed = ['/run p resume', 'npm run inspect -- p'];
  const base = {
    what_ran: 'x', what_failed: 'y', what_was_tried: 'z',
    root_cause_hypothesis: 'h', confidence: 'low',
  };
  const bad = validateAutopsy({ ...base, recommended_action: '/rm -rf /' }, allowed);
  assert.equal(bad.ok, false);
  assert.ok(
    bad.errors.some((e) => /recommended_action/.test(e) && /allowed values/.test(e)),
    `expected a recommended_action enum error, got ${JSON.stringify(bad.errors)}`,
  );

  const good = validateAutopsy({ ...base, recommended_action: '/run p resume' }, allowed);
  assert.equal(good.ok, true);

  // Missing required key also fails.
  const missing = validateAutopsy({ what_ran: 'x' }, allowed);
  assert.equal(missing.ok, false);

  // The schema constrains recommended_action to exactly the allowed enum.
  const schema = buildAutopsySchema(allowed);
  assert.deepEqual(schema.properties.recommended_action.enum, allowed);
});

// ─── enumerateRecommendedActions wiring ──────────────────────────────────────

test('enumerateRecommendedActions returns getNextActions cmd strings for the run state', async () => {
  const project = `ap-enum-${++seq}`;
  const { runId } = seedRun({ project, reason: 'phase-error: dev reported errors', pauseKind: 'mid-build' });
  const ctx = await assembleAutopsyContext({ projectName: project, runId }, { logsDir: '/nonexistent' });
  const cmds = enumerateRecommendedActions(ctx);
  assert.ok(cmds.includes(`/run ${project} resume`), 'a mid-build pause should offer Resume');
  assert.equal(new Set(cmds).size, cmds.length, 'cmds are de-duped');
});

// ─── AC5 — the extracted parser behaves identically ──────────────────────────

test('mapStreamJsonLine (extracted into stream-log.js) parses stream-json lines', () => {
  assert.deepEqual(
    mapStreamJsonLine(JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-haiku-4-5' })),
    [{ t: 'init', detail: 'session started (model claude-haiku-4-5)' }],
  );
  assert.deepEqual(
    mapStreamJsonLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } })),
    [{ t: 'tool', name: 'Bash', detail: 'npm test' }],
  );
  assert.deepEqual(mapStreamJsonLine('not json at all'), []);
});
