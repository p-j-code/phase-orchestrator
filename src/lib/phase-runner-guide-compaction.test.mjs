// Phase 31 — end-to-end fixture tests for runGuide()'s usage-based guide
// session compaction trigger, wiring the previously-dead
// phases.handoff_when_context_tokens_exceed config. Mirrors
// phase-runner-guide-reground.test.mjs's harness (same fixture-project
// pattern, same deps.runClaude seam) — that suite covers the git-drift-based
// reground trigger (Phase 22); this one covers the independent token-based
// compaction trigger this phase adds. Both triggers reuse the SAME two
// primitives (generate a handoff, clear guide_session_id), so the assertions
// below read the actual args passed to the mocked runClaude and the actual
// DB row after the call, exactly like the reground suite.
//
// Run with: node --test src/lib/phase-runner-guide-compaction.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DB_PATH = ':memory:';

const { runGuide } = await import('./phase-runner.js');
const {
  upsertProject, deleteProject, getProject,
  setGuideSessionId, parseProjectMetadata,
} = await import('../state.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

// Default phases.handoff_when_context_tokens_exceed (config/defaults.json) — no
// project-level config override is created in these fixtures, so every test
// exercises this exact threshold via the plain cascade default.
const THRESHOLD = 150000;

// ─── Fixture helpers (mirrors phase-runner-guide-reground.test.mjs) ─────────

async function makeFixtureProject(label) {
  const name = `test-compaction-${label}-${randomUUID()}`;
  const projDir = path.join(PROJECTS_DIR, name);
  const workspaceDir = path.join(projDir, 'workspace');
  await fs.mkdir(path.join(projDir, '.guide'), { recursive: true });
  // No `git init` — no git_branch on the project, so runGuide()'s git
  // preflight/sync block is skipped entirely (expectedBranch is falsy), and
  // isGitRepo(workspaceDir) fails open to false for the last_guide_head_sha
  // tracking block, exactly as it would for any non-git-managed project.
  await fs.mkdir(workspaceDir, { recursive: true });

  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
    $schema_version: 1, name, created_at: new Date(0).toISOString(),
  }), 'utf-8');
  await fs.writeFile(path.join(projDir, '.guide', 'plan.json'), JSON.stringify({ phases: [] }), 'utf-8');
  await fs.writeFile(path.join(projDir, '.guide', 'brief.md'), '# Brief\n\nTest brief.\n', 'utf-8');

  upsertProject({ name, tech_stack: 'node', total_phases: 1 });

  return { name, projDir, workspaceDir };
}

async function cleanup(projDir, name) {
  await fs.rm(projDir, { recursive: true, force: true }).catch(() => {});
  try { deleteProject(name); } catch { /* ignore */ }
}

// Builds a deps.runClaude stub whose return value (session_id, is_error,
// last_turn_context_tokens) is scripted per-call via `plan`, keyed by the
// runClaude task id (e.g. 'phase-prompt-gen', 'handoff-creation'). Mirrors
// claude-runner.js's real post-call contract: a session_id returned for a
// role==='guide' call updates guide_session_id (see the reground suite's
// identical note).
function makeScriptedStub(plan) {
  const calls = [];
  const runClaude = async (opts) => {
    calls.push(opts);
    const scripted = plan[opts.task] || {};
    const session_id = scripted.session_id !== undefined ? scripted.session_id : `sess-${opts.task}-${calls.length}`;
    if (session_id && opts.role === 'guide') setGuideSessionId(opts.project, session_id);
    return {
      result: scripted.is_error ? 'boom' : 'ok',
      session_id,
      is_error: !!scripted.is_error,
      last_turn_context_tokens: scripted.last_turn_context_tokens ?? null,
    };
  };
  return { calls, runClaude };
}

// ─── Above threshold — compacts exactly once ─────────────────────────────────

test('above-threshold resumed-task result: exactly one handoff spawn, guide_session_id cleared, metadata stamped', async () => {
  const { name, projDir, workspaceDir } = await makeFixtureProject('above');
  try {
    setGuideSessionId(name, 'sess-old-resumed');

    const { calls, runClaude } = makeScriptedStub({
      'phase-prompt-gen': { session_id: 'sess-old-resumed', last_turn_context_tokens: THRESHOLD + 10000 },
      'handoff-creation': { session_id: 'sess-handoff-1' },
    });
    const result = await runGuide({ projectName: name, task: 'next-prompt' }, { runClaude });

    assert.equal(result.is_error, false);
    assert.equal(calls.length, 2, 'main call + exactly one recursive handoff spawn');
    assert.equal(calls[0].task, 'phase-prompt-gen');
    assert.equal(calls[1].task, 'handoff-creation', 'the handoff spawn happens AFTER the main call (post-call trigger)');
    assert.equal(calls[1].sessionId, null, 'handoff is always a fresh-session task');

    const row = getProject(name);
    assert.equal(row.guide_session_id, null, 'compaction clears guide_session_id (explicit setGuideSessionId(null) wins over the handoff sub-call\'s own session_id)');

    const metadata = parseProjectMetadata(row.metadata_json);
    assert.equal(metadata.last_compact_session_id, 'sess-old-resumed', 'stamped with the MAIN call\'s session_id, not the handoff sub-call\'s');

    assert.ok(result._guide_reground.reason.includes(`${THRESHOLD + 10000} tokens > ${THRESHOLD} tokens`));
    assert.equal(result._guide_reground.notifyText, `↺ ${name}: guide re-grounded — ${result._guide_reground.reason}`, 'reuses buildGuideRegroundNotifyText verbatim — same builder family as the drift reground');
  } finally {
    await cleanup(projDir, name);
    void workspaceDir;
  }
});

// ─── Below threshold — nothing happens ───────────────────────────────────────

test('below-threshold resumed-task result: no compaction, no extra call', async () => {
  const { name, projDir } = await makeFixtureProject('below');
  try {
    setGuideSessionId(name, 'sess-old-resumed');
    const { calls, runClaude } = makeScriptedStub({
      'phase-prompt-gen': { session_id: 'sess-old-resumed', last_turn_context_tokens: 1000 },
    });
    const result = await runGuide({ projectName: name, task: 'next-prompt' }, { runClaude });

    assert.equal(calls.length, 1, 'no recursive handoff spawn below threshold');
    assert.equal(result._guide_reground.reason, null);
    assert.equal(result._guide_reground.notifyText, null);

    const row = getProject(name);
    assert.equal(row.guide_session_id, 'sess-old-resumed', 'session untouched');
    assert.equal(parseProjectMetadata(row.metadata_json).last_compact_session_id, undefined);
  } finally {
    await cleanup(projDir, name);
  }
});

// ─── task:'handoff' above threshold — never triggers a second handoff ───────

test("task:'handoff' itself, even with a huge last_turn_context_tokens, never triggers a recursive compaction handoff", async () => {
  const { name, projDir } = await makeFixtureProject('handoff-task');
  try {
    const { calls, runClaude } = makeScriptedStub({
      'handoff-creation': { session_id: 'sess-handoff-only', last_turn_context_tokens: THRESHOLD + 50000 },
    });
    const result = await runGuide({ projectName: name, task: 'handoff' }, { runClaude });

    assert.equal(calls.length, 1, 'a handoff call must never spawn ANOTHER handoff');
    assert.equal(result._guide_reground.reason, null);
    assert.equal(result._guide_reground.notifyText, null);
  } finally {
    await cleanup(projDir, name);
  }
});

// ─── is_error result — nothing happens ───────────────────────────────────────

test('an is_error result never triggers compaction, even above threshold', async () => {
  const { name, projDir } = await makeFixtureProject('is-error');
  try {
    setGuideSessionId(name, 'sess-old-resumed');
    const { calls, runClaude } = makeScriptedStub({
      'phase-prompt-gen': { session_id: null, is_error: true, last_turn_context_tokens: THRESHOLD + 10000 },
    });
    const result = await runGuide({ projectName: name, task: 'next-prompt' }, { runClaude });

    assert.equal(result.is_error, true);
    assert.equal(calls.length, 1, 'no recursive handoff spawn on an errored result');
    assert.equal(result._guide_reground.reason, null);
  } finally {
    await cleanup(projDir, name);
  }
});

// ─── Idempotency — same session_id twice compacts only once ────────────────

test('same session_id across two calls compacts once — the second call at the identical session_id is a no-op', async () => {
  const { name, projDir } = await makeFixtureProject('idempotent');
  try {
    setGuideSessionId(name, 'sess-heavy');

    // Attempt 1: compacts.
    const attempt1 = makeScriptedStub({
      'phase-prompt-gen': { session_id: 'sess-heavy', last_turn_context_tokens: THRESHOLD + 1 },
      'handoff-creation': { session_id: 'sess-handoff-1' },
    });
    const result1 = await runGuide({ projectName: name, task: 'next-prompt' }, { runClaude: attempt1.runClaude });
    assert.equal(attempt1.calls.length, 2, 'attempt 1 compacts: main call + handoff spawn');
    assert.ok(result1._guide_reground.reason);

    const rowAfter1 = getProject(name);
    assert.equal(rowAfter1.guide_session_id, null);
    assert.equal(parseProjectMetadata(rowAfter1.metadata_json).last_compact_session_id, 'sess-heavy');

    // Attempt 2: the resumed session happens to still report session_id
    // 'sess-heavy' (simulating the orchestrator racing a retry at the same
    // session before the clear was visible) and is still above threshold —
    // the idempotency guard must still block a second compaction.
    setGuideSessionId(name, 'sess-heavy');
    const attempt2 = makeScriptedStub({
      'phase-prompt-gen': { session_id: 'sess-heavy', last_turn_context_tokens: THRESHOLD + 1 },
      'handoff-creation': { session_id: 'sess-handoff-2' },
    });
    const result2 = await runGuide({ projectName: name, task: 'next-prompt' }, { runClaude: attempt2.runClaude });

    assert.equal(attempt2.calls.length, 1, 'no second handoff spawn — same session_id already compacted once');
    assert.equal(result2._guide_reground.reason, null, 'no duplicate notice either');

    const rowAfter2 = getProject(name);
    assert.equal(rowAfter2.guide_session_id, 'sess-heavy', 'not cleared a second time');
  } finally {
    await cleanup(projDir, name);
  }
});
