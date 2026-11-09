// Phase 22 (brief P3, large-drift reground half) — end-to-end fixture tests
// for runGuide()'s reground gate. Unlike the pure-function tests in
// context-freshness.test.mjs (buildGuideRegroundReason/buildGuideRegroundNotifyText)
// and the source-assertion tests in phase-runner-guide-head-delta.test.mjs
// (placement/ordering, no live call), these exercise the REAL runGuide() —
// real DB (better-sqlite3 :memory:), real git repo, real config resolution —
// with only `runClaude` itself mocked via the deps.runClaude seam phase 22
// added (mirrors verify-loop.js's runAcceptanceCheck seam). Assertions read
// the actual args passed to the mocked runClaude and the actual DB row after
// the call, not just a source-level read.
//
// config-resolver.js's loadProject() requires a REAL projects/<name>/project.json
// on disk (throws otherwise) — there is no injectable seam for PROJECTS_DIR, so
// (matching this repo's own convention in auto-runner.test.mjs /
// auto-runner-automation.test.mjs) these fixtures are created under the ACTUAL
// projects/ directory with a randomUUID-suffixed name and torn down in a
// `finally` block, never left behind on failure.
//
// Run with: node --test src/lib/phase-runner-guide-reground.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DB_PATH = ':memory:';

const { runGuide } = await import('./phase-runner.js');
const {
  upsertProject, deleteProject, getProject,
  setGuideSessionId, setProjectMetadataField, parseProjectMetadata,
} = await import('../state.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

// ─── Fixture helpers ─────────────────────────────────────────────────────────

async function makeFixtureProject(label) {
  const name = `test-reground-${label}-${randomUUID()}`;
  const projDir = path.join(PROJECTS_DIR, name);
  const workspaceDir = path.join(projDir, 'workspace');
  await fs.mkdir(path.join(projDir, '.guide'), { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });

  // Minimal but schema-valid project.json — config-resolver.js's loadProject()
  // throws "Project not found" if this file is absent, and validate()s it
  // against config/schemas/project.schema.json (required: $schema_version,
  // name, created_at). No git_branch → the DB row's git_branch stays NULL →
  // runGuide()'s expectedBranch gate is falsy → the git preflight/sync block
  // (which needs a real remote) is skipped entirely.
  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
    $schema_version: 1, name, created_at: new Date(0).toISOString(),
  }), 'utf-8');

  // Empty-phases plan: buildGuidePrompt's 'next-prompt' case degrades to
  // phaseN = current_phase + 1 with no phase meta — irrelevant to what this
  // suite actually verifies (reground gating), so kept minimal.
  await fs.writeFile(path.join(projDir, '.guide', 'plan.json'), JSON.stringify({ phases: [] }), 'utf-8');
  await fs.writeFile(path.join(projDir, '.guide', 'brief.md'), '# Brief\n\nTest brief.\n', 'utf-8');

  execSync('git init -q', { cwd: workspaceDir });
  execSync('git config user.email t@example.com', { cwd: workspaceDir });
  execSync('git config user.name test', { cwd: workspaceDir });

  upsertProject({ name, tech_stack: 'node', total_phases: 1 });

  return { name, projDir, workspaceDir };
}

function commit(dir, file, content, message) {
  writeFileSync(path.join(dir, file), content);
  execSync('git add -A', { cwd: dir });
  execSync(`git commit -q -m ${JSON.stringify(message)}`, { cwd: dir });
  return execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
}

function headSha(dir) {
  return execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
}

async function cleanup(projDir, name) {
  await fs.rm(projDir, { recursive: true, force: true }).catch(() => {});
  try { deleteProject(name); } catch { /* ignore */ }
}

// Mirrors claude-runner.js's real post-call contract (lines ~520-525): when a
// session_id comes back for a role==='guide' call, the DB's guide_session_id
// is updated — regardless of is_error. runGuide() itself never touches this
// column on success (only on reground, where it explicitly clears it); the
// REAL runClaude does the re-set. Since these fixtures replace runClaude
// entirely, the stub must replicate this one specific, documented side effect
// for the "cleared then replaced" assertions below to be meaningful at all.
function makeStub(sessionPrefix, { isError = false } = {}) {
  const calls = [];
  let n = 0;
  const runClaude = async (opts) => {
    n += 1;
    calls.push(opts);
    const session_id = isError ? null : `${sessionPrefix}-${n}`;
    if (session_id && opts.role === 'guide') setGuideSessionId(opts.project, session_id);
    return { result: isError ? 'boom' : 'ok', session_id, is_error: isError };
  };
  return { calls, runClaude };
}

// ─── Small drift: resume path ────────────────────────────────────────────────

test('small drift (2 external commits since last_guide_head_sha) → delta block injected, sessionId unchanged (still resumes), no reground', async () => {
  const { name, projDir, workspaceDir } = await makeFixtureProject('small-drift');
  try {
    const initSha = commit(workspaceDir, 'a.txt', 'a', 'init');
    setProjectMetadataField(name, 'last_guide_head_sha', initSha);
    setGuideSessionId(name, 'sess-old-resumed');
    commit(workspaceDir, 'b.txt', 'b', 'Manual hotfix #1');
    commit(workspaceDir, 'c.txt', 'c', 'Manual hotfix #2');

    const { calls, runClaude } = makeStub('sess-continued');
    const result = await runGuide({ projectName: name, task: 'next-prompt' }, { runClaude });

    assert.equal(calls.length, 1, 'no reground → no recursive handoff-generation call, just the main call');
    assert.equal(calls[0].task, 'phase-prompt-gen');
    assert.equal(calls[0].sessionId, 'sess-old-resumed', 'small drift keeps --resume — sessionId passed to runClaude is unchanged');
    // CE-3 / cache-stable-system-prefix: deltaCtx is volatile (changes every
    // phase) and now rides in the user prompt (`prompt`), never
    // systemPromptExtra — a resumed call must keep systemPromptExtra
    // byte-stable regardless of how much drift occurred.
    assert.ok(calls[0].prompt.includes('<context_delta>'), 'classified delta block is injected into the prompt');
    assert.ok(calls[0].prompt.includes('[EXTERNAL] Manual hotfix #1'));
    assert.ok(calls[0].prompt.includes('[EXTERNAL] Manual hotfix #2'));
    assert.ok(!calls[0].systemPromptExtra || !calls[0].systemPromptExtra.includes('<context_delta>'), 'delta block must never appear in systemPromptExtra — that would bust the cached system prefix on every phase');

    assert.equal(result._guide_reground.reason, null, 'small drift never re-grounds');
    assert.equal(result._guide_reground.notifyText, null);

    const row = getProject(name);
    assert.equal(row.guide_session_id, 'sess-continued-1', 'DB reflects the resumed session\'s continuation id (set by the simulated runClaude side effect)');
  } finally {
    await cleanup(projDir, name);
  }
});

// ─── Large drift: reground path ──────────────────────────────────────────────

test('16 commits of drift since last_guide_head_sha → reground: NO --resume, guide_session_id cleared then replaced, handoff generated, prompt carries handoff + delta', async () => {
  const { name, projDir, workspaceDir } = await makeFixtureProject('large-drift');
  try {
    const initSha = commit(workspaceDir, 'a.txt', 'a', 'init');
    setProjectMetadataField(name, 'last_guide_head_sha', initSha);
    setGuideSessionId(name, 'sess-old-resumed');

    // Pre-seed an existing handoff on disk — simulates a handoff written by an
    // earlier, unrelated guide call. handoffCtx (loadMostRecentHandoffBlock)
    // is injected UNCONDITIONALLY in runGuide (not gated by reground), so this
    // lets us assert the reground call's prompt carries handoff content
    // alongside the delta block without needing to fake the LLM actually
    // writing a file during the mocked handoff-generation call below.
    await fs.mkdir(path.join(projDir, '.guide', 'handoffs'), { recursive: true });
    await fs.writeFile(
      path.join(projDir, '.guide', 'handoffs', 'handoff-seed.md'),
      `Prior state: phase 3 complete.\nGenerated at commit: ${initSha}\n`,
      'utf-8',
    );

    for (let i = 0; i < 16; i += 1) commit(workspaceDir, `f${i}.txt`, String(i), `external commit ${i}`);
    const drifted = headSha(workspaceDir);

    const { calls, runClaude } = makeStub('sess-new');
    const result = await runGuide({ projectName: name, task: 'next-prompt' }, { runClaude });

    assert.equal(calls.length, 2, 'reground makes exactly 2 runClaude calls: handoff generation, then the main call');
    const handoffCall = calls.find((c) => c.task === 'handoff-creation');
    const mainCall = calls.find((c) => c.task === 'phase-prompt-gen');
    assert.ok(handoffCall, 'a handoff-generation call was made as part of the reground action');
    assert.equal(handoffCall.sessionId, null, 'handoff is always a fresh-session task');
    assert.ok(mainCall, 'the main call still runs after regrounding');
    assert.equal(mainCall.sessionId, null, 'large drift re-grounds — NO --resume for the main call');

    // CE-3 / cache-stable-system-prefix: handoffCtx is gated to fresh sessions
    // only (sessionId === null) — the reground path forces exactly that for
    // the main call, so handoffCtx still lands in systemPromptExtra here.
    // deltaCtx is volatile and always rides in the prompt, reground or not.
    assert.ok(mainCall.systemPromptExtra.includes('<previous_handoff>'), 'fresh-session main call still gets handoffCtx in systemPromptExtra');
    assert.ok(mainCall.systemPromptExtra.includes('Prior state: phase 3 complete.'));
    assert.ok(mainCall.prompt.includes('<context_delta>'), 'prompt carries the classified delta block');
    assert.ok(mainCall.prompt.includes('[EXTERNAL] external commit 0'));
    assert.ok(mainCall.prompt.includes('[EXTERNAL] external commit 15'));

    const row = getProject(name);
    assert.equal(row.guide_session_id, 'sess-new-2', 'guide_session_id cleared during reground, then replaced by the MAIN call\'s new session id (call #2 — the handoff call #1\'s id was overwritten by the explicit clear)');

    const metadata = parseProjectMetadata(row.metadata_json);
    assert.equal(metadata.last_reground_sha, drifted, 'last_reground_sha stamped to the drifted HEAD');
    assert.equal(metadata.last_guide_head_sha, drifted, 'last_guide_head_sha also advances (tracked on every successful guide-role call, reground or not)');

    assert.ok(result._guide_reground.reason && result._guide_reground.reason.includes('16 commit'));
    assert.equal(result._guide_reground.notifyText, `↺ ${name}: guide re-grounded — ${result._guide_reground.reason}`);
    assert.ok(result._guide_reground.notifyText.startsWith('↺'), 'distinct lead glyph from the plain ⚠ drift notice');
  } finally {
    await cleanup(projDir, name);
  }
});

// ─── Idempotency: never re-ground twice for the same drifted HEAD ───────────

test('same-HEAD idempotency: a second call at the identical drifted HEAD does not re-ground again, even when last_guide_head_sha never advanced (both prior calls failed)', async () => {
  const { name, projDir, workspaceDir } = await makeFixtureProject('idempotent');
  try {
    const initSha = commit(workspaceDir, 'a.txt', 'a', 'init');
    setProjectMetadataField(name, 'last_guide_head_sha', initSha);
    setGuideSessionId(name, 'sess-old-resumed');
    for (let i = 0; i < 16; i += 1) commit(workspaceDir, `f${i}.txt`, String(i), `external commit ${i}`);
    const drifted = headSha(workspaceDir);

    // Attempt 1: BOTH the handoff sub-call and the main call fail (is_error,
    // no session_id) — so last_guide_head_sha is NEVER advanced by either
    // call's post-success tracking block. Without the last_reground_sha guard,
    // a naive implementation would see the SAME 'some'/16-commit drift again
    // on attempt 2 and re-ground a second time purely because
    // last_guide_head_sha stayed stale.
    const attempt1 = makeStub('sess-failed', { isError: true });
    const result1 = await runGuide({ projectName: name, task: 'next-prompt' }, { runClaude: attempt1.runClaude });

    assert.equal(attempt1.calls.length, 2, 'attempt 1 still re-grounds: handoff call + main call, both failing');
    assert.equal(result1.is_error, true);
    assert.ok(result1._guide_reground.reason, 'attempt 1 is a genuine reground episode');

    const rowAfter1 = getProject(name);
    assert.equal(rowAfter1.guide_session_id, null, 'cleared by the reground action; never replaced (neither call returned a session_id)');
    const metaAfter1 = parseProjectMetadata(rowAfter1.metadata_json);
    assert.equal(metaAfter1.last_reground_sha, drifted, 'last_reground_sha stamped despite the main call failing');
    assert.equal(metaAfter1.last_guide_head_sha, initSha, 'last_guide_head_sha stays STALE — neither call succeeded');

    // Attempt 2: same HEAD, no new commits, this time both calls succeed.
    const attempt2 = makeStub('sess-recovered');
    const result2 = await runGuide({ projectName: name, task: 'next-prompt' }, { runClaude: attempt2.runClaude });

    assert.equal(attempt2.calls.length, 1, 'idempotent — no second handoff-generation call this time');
    assert.equal(attempt2.calls[0].task, 'phase-prompt-gen');
    assert.equal(attempt2.calls[0].sessionId, null, 'reground already discarded the session on attempt 1 — nothing left to resume');
    // regroundReason is computed unconditionally (it's the pure threshold
    // read — "does this delta still cross the line"), so it still reports
    // the same 16-commit reason; shouldReground (the ACTION gate, keyed on
    // last_reground_sha) is what actually stayed false here — proven by
    // calls.length===1 above (no second handoff call) and notifyText below
    // (no second Telegram notice).
    assert.ok(result2._guide_reground.reason, 'the threshold read itself is unconditional and still reports the drift');
    assert.equal(result2._guide_reground.notifyText, null, 'no duplicate Telegram notice — the ACTION did not re-fire');

    const rowAfter2 = getProject(name);
    const metaAfter2 = parseProjectMetadata(rowAfter2.metadata_json);
    assert.equal(metaAfter2.last_reground_sha, drifted, 'unchanged — still the same episode\'s sha, not bumped again');
    assert.equal(metaAfter2.last_guide_head_sha, drifted, 'NOW advances, since the main call succeeded this time');
  } finally {
    await cleanup(projDir, name);
  }
});
