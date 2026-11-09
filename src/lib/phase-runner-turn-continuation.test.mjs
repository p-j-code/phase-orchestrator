// Tests for the v0.18 turn-budget continuation (runTurnContinuationLoop) —
// the same-session "+N turns" resume that fires on an error_max_turns dev/fix
// result BEFORE the phase falls into fresh-session failure-driven escalation.
// Covers:
//   A. Trigger conditions — fires only on is_error + subtype 'error_max_turns'
//      with a session_id and a positive budget; everything else returns the
//      initial result untouched with zero spawns.
//   B. The continuation call itself — resumes the SAME session id, caps turns
//      via a task_max_turns cfg-clone entry (proven through the REAL
//      resolveMaxTurns), never mutates the caller's cfg, uses the dev system
//      prompt + devSystemPromptExtra, and its prompt forbids redoing work.
//   C. Bounds — max_continuation_attempts caps repeat exhaustions; a non-
//      max_turns continuation outcome (success OR different error) ends the
//      loop immediately; max_turns_continuation: 0 disables entirely.
//   D. Failure isolation — a THROWN continuation (billing pause, spawn error)
//      returns the ORIGINAL result so normal failure routing proceeds.
//   E. Session recording — continuation session ids are recorded; phase
//      backfill fires for phases, never for fixes.
//   F. runDev() wiring — source assertions: the loop sits after the initial
//      dev call's session recording and before the git no-commit guard, gated
//      on subtype 'error_max_turns', with the caller's runClaudeFn threaded
//      through deps.
//
// No real `claude` subprocess is ever spawned.
//
// Run with: node --test src/lib/phase-runner-turn-continuation.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.env.DB_PATH = ':memory:';

const {
  runTurnContinuationLoop,
  buildTurnContinuationPrompt,
  buildFreshTurnRecoveryPrompt,
  contextCompilerFollowupCfg,
} = await import('./phase-runner.js');
const { resolveMaxTurns } = await import('../claude-runner.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_TURNS_RESULT = Object.freeze({
  is_error: true,
  subtype: 'error_max_turns',
  session_id: 'dev-sess-initial',
  result: 'Ended with subtype: error_max_turns',
});

function baseArgs(overrides = {}) {
  return {
    cfg: {
      model: 'claude-sonnet-5',
      phases: { max_turns_per_phase: 150, task_max_turns: { 'acceptance-check': 40 } },
      tools: { allowed_default: ['Read', 'Write', 'Edit', 'Bash'], permission_mode: 'acceptEdits' },
    },
    projectName: 'demo',
    projDir: '/tmp/aorch-test-proj',
    workspaceDir: '/tmp/aorch-test-proj/workspace',
    nextPhase: 7,
    fix: null,
    devSystemPromptExtra: 'STABLE-PREFIX',
    initialResult: { ...MAX_TURNS_RESULT },
    routing: { tier: 'sonnet' },
    escalated: false,
    ...overrides,
  };
}

// Deps stub: never touches the real DB / disk.
function makeDeps(runClaudeImpl) {
  const calls = { runClaude: [], recordDevSession: [], backfill: [] };
  return {
    calls,
    deps: {
      runClaude: async (args) => { calls.runClaude.push(args); return runClaudeImpl(args, calls.runClaude.length); },
      recordDevSession: async (projDir, sid) => { calls.recordDevSession.push({ projDir, sid }); },
      backfillPhaseSessionId: (args) => { calls.backfill.push(args); },
    },
  };
}

// ─── A. Trigger conditions ───────────────────────────────────────────────────

test('no continuation on a successful result — zero spawns, result untouched', async () => {
  const ok = { is_error: false, session_id: 's1', result: 'done' };
  const { calls, deps } = makeDeps(() => { throw new Error('must not spawn'); });
  const out = await runTurnContinuationLoop(baseArgs({ initialResult: ok }), deps);
  assert.equal(out, ok);
  assert.equal(calls.runClaude.length, 0);
});

test('no continuation on a NON-max_turns error (e.g. error_during_execution)', async () => {
  const err = { is_error: true, subtype: 'error_during_execution', session_id: 's1', result: 'boom' };
  const { calls, deps } = makeDeps(() => { throw new Error('must not spawn'); });
  const out = await runTurnContinuationLoop(baseArgs({ initialResult: err }), deps);
  assert.equal(out, err);
  assert.equal(calls.runClaude.length, 0);
});

test('no continuation when the max_turns result carries no session_id (nothing to resume)', async () => {
  const err = { is_error: true, subtype: 'error_max_turns', session_id: null, result: 'x' };
  const { calls, deps } = makeDeps(() => { throw new Error('must not spawn'); });
  const out = await runTurnContinuationLoop(baseArgs({ initialResult: err }), deps);
  assert.equal(out, err);
  assert.equal(calls.runClaude.length, 0);
});

test('max_turns_continuation: 0 disables the feature entirely', async () => {
  const { calls, deps } = makeDeps(() => { throw new Error('must not spawn'); });
  const args = baseArgs();
  args.cfg.phases.max_turns_continuation = 0;
  const out = await runTurnContinuationLoop(args, deps);
  assert.equal(out, args.initialResult);
  assert.equal(calls.runClaude.length, 0);
});

// ─── B. The continuation call ────────────────────────────────────────────────

test('continuation resumes the SAME session and returns the successful result', async () => {
  const success = { is_error: false, session_id: 'dev-sess-cont', result: 'finished' };
  const { calls, deps } = makeDeps(() => success);
  const out = await runTurnContinuationLoop(baseArgs(), deps);
  assert.equal(out, success);
  assert.equal(calls.runClaude.length, 1);
  assert.equal(calls.runClaude[0].sessionId, 'dev-sess-initial');
  assert.equal(calls.runClaude[0].task, 'dev-execution');
  assert.equal(calls.runClaude[0].systemPromptExtra, 'STABLE-PREFIX');
  assert.match(calls.runClaude[0].systemPromptFile, /dev-system\.md$/);
});

test('continuation cfg caps turns via task_max_turns — proven through the real resolveMaxTurns', async () => {
  const { calls, deps } = makeDeps(() => ({ is_error: false, session_id: 's2', result: 'ok' }));
  const args = baseArgs();
  args.cfg.phases.max_turns_continuation = 30;
  await runTurnContinuationLoop(args, deps);
  const contCfg = calls.runClaude[0].cfg;
  const resolved = resolveMaxTurns({ model: 'claude-sonnet-5', task: 'dev-execution', phases: contCfg.phases });
  assert.equal(resolved, 30, 'the continuation call must be capped at max_turns_continuation, not the 150 shared budget');
  // Pre-existing task caps ride along untouched.
  assert.equal(contCfg.phases.task_max_turns['acceptance-check'], 40);
});

test('caller cfg is never mutated by the continuation clone', async () => {
  const { deps } = makeDeps(() => ({ is_error: false, session_id: 's2', result: 'ok' }));
  const args = baseArgs();
  const before = JSON.stringify(args.cfg);
  await runTurnContinuationLoop(args, deps);
  assert.equal(JSON.stringify(args.cfg), before);
});

test('same-session continuation retains compiled-context token exposure accounting', async () => {
  const { calls, deps } = makeDeps(() => ({ is_error: false, session_id: 's2', result: 'ok' }));
  const args = baseArgs();
  args.cfg._context_compiler = {
    manifest_id: 'a'.repeat(64), provider: 'hybrid-lexical', mode: 'assist', injected_tokens: 321, exposed: true,
  };
  await runTurnContinuationLoop(args, deps);
  assert.equal(calls.runClaude[0].sessionId, 'dev-sess-initial');
  assert.equal(calls.runClaude[0].cfg._context_compiler.injected_tokens, 321,
    'the resumed call can still see the manifest block in conversation history');
  assert.equal(args.cfg._context_compiler.injected_tokens, 321, 'caller cfg remains untouched');
});

test('follow-up accounting zeros only a fresh session that omits the compiled block', () => {
  const cfg = {
    model: 'claude-sonnet-5',
    _context_compiler: {
      manifest_id: 'b'.repeat(64), provider: 'hybrid-lexical', mode: 'assist', injected_tokens: 222, exposed: true,
    },
  };
  assert.equal(contextCompilerFollowupCfg(cfg, { sessionId: 'same-session' }), cfg,
    'same-session replay retains attribution');
  assert.equal(contextCompilerFollowupCfg(cfg, { contextBlockIncluded: true }), cfg,
    'a fresh prompt that explicitly repeats the block retains attribution');
  const freshWithoutBlock = contextCompilerFollowupCfg(cfg);
  assert.notEqual(freshWithoutBlock, cfg);
  assert.equal(freshWithoutBlock._context_compiler.injected_tokens, 0);
  assert.equal(freshWithoutBlock._context_compiler.exposed, false);
  assert.equal(cfg._context_compiler.injected_tokens, 222, 'zeroing path clones instead of mutating');
});

test('fix continuation uses fix-execution task and the fix prompt wording', async () => {
  const { calls, deps } = makeDeps(() => ({ is_error: false, session_id: 's2', result: 'ok' }));
  await runTurnContinuationLoop(baseArgs({ fix: { round: 2, n: 3, title: 'x' }, nextPhase: null }), deps);
  assert.equal(calls.runClaude[0].task, 'fix-execution');
  assert.match(calls.runClaude[0].prompt, /this fix/);
});

test('continuation prompt forbids redoing finished work and demands a commit', () => {
  const p = buildTurnContinuationPrompt({ fix: null });
  assert.match(p, /do NOT redo/i);
  assert.match(p, /commit/i);
  assert.match(p, /this phase/);
});

// ─── C. Bounds ───────────────────────────────────────────────────────────────

test('a continuation that ALSO exhausts turns stops after max_continuation_attempts and returns the last error', async () => {
  const again = { is_error: true, subtype: 'error_max_turns', session_id: 'dev-sess-cont', result: 'again' };
  const { calls, deps } = makeDeps(() => again);
  const args = baseArgs();
  args.cfg.phases.max_continuation_attempts = 2;
  const out = await runTurnContinuationLoop(args, deps);
  assert.equal(calls.runClaude.length, 2, 'bounded by max_continuation_attempts');
  assert.equal(out, again, 'the error result falls through so normal escalation routing proceeds');
  assert.equal(calls.runClaude[1].sessionId, 'dev-sess-cont', 'attempt 2 resumes the continuation session, not the stale initial one');
});

test('default bound is exactly ONE continuation attempt', async () => {
  const again = { is_error: true, subtype: 'error_max_turns', session_id: 's-next', result: 'again' };
  const { calls, deps } = makeDeps(() => again);
  await runTurnContinuationLoop(baseArgs(), deps);
  assert.equal(calls.runClaude.length, 1);
});

test('inherited continuation hard cap defeats a stale project override requesting three attempts', async () => {
  const again = { is_error: true, subtype: 'error_max_turns', session_id: 's-next', result: 'again' };
  const { calls, deps } = makeDeps(() => again);
  const args = baseArgs();
  args.cfg.phases.max_continuation_attempts = 3;
  args.cfg.phases.max_continuation_attempts_hard_cap = 1;
  const out = await runTurnContinuationLoop(args, deps);
  assert.equal(calls.runClaude.length, 1);
  assert.equal(out, again);
});

test('large context skips same-session replay and performs one fresh compact recovery', async () => {
  const recovered = { is_error: false, session_id: 'fresh-sess', result: 'finished' };
  const { calls, deps } = makeDeps(() => recovered);
  const args = baseArgs({
    taskMeta: {
      n: 7,
      title: 'Consent audit trail',
      goal: 'Record consent changes.',
      acceptance_criteria: ['Every change is attributable'],
      files_expected: ['src/consent.js'],
    },
    relReportPath: '../.guide/phases/phase-7/report.md',
    initialResult: { ...MAX_TURNS_RESULT, last_turn_context_tokens: 220000 },
  });
  args.cfg.phases.max_continuation_context_tokens = 180000;
  args.cfg.phases.fresh_recovery_after_max_turns = true;
  args.cfg.phases.fresh_recovery_max_turns = 30;
  const out = await runTurnContinuationLoop(args, deps);
  assert.equal(out, recovered);
  assert.equal(calls.runClaude.length, 1, 'no expensive resume call is made above the context ceiling');
  assert.equal(calls.runClaude[0].sessionId, null);
  assert.equal(calls.runClaude[0].cfg.phases.task_max_turns['dev-execution'], 30);
  assert.match(calls.runClaude[0].prompt, /Consent audit trail/);
  assert.match(calls.runClaude[0].prompt, /git status --short/);
  assert.match(calls.runClaude[0].prompt, /phase-7\/report\.md/);
});

test('one exhausted continuation falls back to one fresh recovery, never another resume loop', async () => {
  const again = { is_error: true, subtype: 'error_max_turns', session_id: 'continued-sess', result: 'again', last_turn_context_tokens: 170000 };
  const recovered = { is_error: false, session_id: 'fresh-sess', result: 'done' };
  const { calls, deps } = makeDeps((_args, n) => n === 1 ? again : recovered);
  const args = baseArgs({ taskMeta: { n: 7, title: 'P7', acceptance_criteria: [] } });
  args.cfg.phases.max_continuation_attempts = 3;
  args.cfg.phases.max_continuation_attempts_hard_cap = 1;
  args.cfg.phases.max_continuation_context_tokens = 180000;
  args.cfg.phases.fresh_recovery_after_max_turns = true;
  const out = await runTurnContinuationLoop(args, deps);
  assert.equal(out, recovered);
  assert.equal(calls.runClaude.length, 2);
  assert.equal(calls.runClaude[0].sessionId, 'dev-sess-initial');
  assert.equal(calls.runClaude[1].sessionId, null);
});

test('fresh recovery prompt is bounded and carries the contract without conversation history', () => {
  const prompt = buildFreshTurnRecoveryPrompt({
    taskMeta: {
      n: 4,
      title: 'Large task',
      goal: 'g'.repeat(10000),
      acceptance_criteria: Array.from({ length: 30 }, (_, i) => `criterion-${i}`),
      files_expected: Array.from({ length: 40 }, (_, i) => `src/f${i}.js`),
    },
    priorSessionId: 'old-session',
  });
  assert.ok(prompt.length < 12000, `compact recovery prompt unexpectedly large: ${prompt.length}`);
  assert.match(prompt, /criterion-0/);
  assert.doesNotMatch(prompt, /criterion-20/);
  assert.match(prompt, /Do not restart the task/);
});

test('a DIFFERENT continuation error ends the loop immediately (no retry burn)', async () => {
  const other = { is_error: true, subtype: 'error_during_execution', session_id: 's2', result: 'boom' };
  const { calls, deps } = makeDeps(() => other);
  const args = baseArgs();
  args.cfg.phases.max_continuation_attempts = 3;
  const out = await runTurnContinuationLoop(args, deps);
  assert.equal(calls.runClaude.length, 1);
  assert.equal(out, other);
});

// ─── D. Failure isolation ────────────────────────────────────────────────────

test('a THROWN continuation returns the ORIGINAL result — normal failure routing proceeds', async () => {
  const { deps } = makeDeps(() => { throw new Error('Paused: budget'); });
  const args = baseArgs();
  const out = await runTurnContinuationLoop(args, deps);
  assert.equal(out, args.initialResult, 'the original error_max_turns result must survive a continuation crash');
});

// ─── E. Session recording ────────────────────────────────────────────────────

test('continuation session is recorded; phase backfill fires for phases', async () => {
  const { calls, deps } = makeDeps(() => ({ is_error: false, session_id: 'dev-sess-cont', result: 'ok' }));
  await runTurnContinuationLoop(baseArgs(), deps);
  assert.deepEqual(calls.recordDevSession, [{ projDir: '/tmp/aorch-test-proj', sid: 'dev-sess-cont' }]);
  assert.deepEqual(calls.backfill, [{ project: 'demo', n: 7, session_id: 'dev-sess-cont' }]);
});

test('fix continuation records the session but never backfills a phase row', async () => {
  const { calls, deps } = makeDeps(() => ({ is_error: false, session_id: 'fix-sess-cont', result: 'ok' }));
  await runTurnContinuationLoop(baseArgs({ fix: { round: 1, n: 2 }, nextPhase: null }), deps);
  assert.equal(calls.recordDevSession.length, 1);
  assert.equal(calls.backfill.length, 0, 'fixes have no phases-table row — backfill would violate NOT NULL');
});

// ─── F. runDev() wiring — source assertions ──────────────────────────────────

test('runDev wires the continuation between session recording and the git guard, threading runClaudeFn', () => {
  const src = readFileSync(path.join(__dirname, 'phase-runner.js'), 'utf-8');

  const resultDecl = src.indexOf('let result = reconciledCommitSha');
  const devCall = src.indexOf(': await runClaudeFn({', resultDecl);
  assert.ok(resultDecl !== -1 && devCall !== -1, 'the dev/reconciliation outcome must assign to a reassignable `let result`');

  const wiring = src.indexOf("if (result.is_error && result.subtype === 'error_max_turns') {", devCall);
  assert.ok(wiring !== -1, 'continuation must be gated on subtype error_max_turns');

  const loopCall = src.indexOf('result = await runTurnContinuationLoop({', wiring);
  const gitGuard = src.indexOf('let git_result = null;', devCall);
  assert.ok(loopCall !== -1 && loopCall < gitGuard, 'continuation must run BEFORE the git no-commit guard so its outcome flows through the unchanged downstream pipeline');

  const wiringBlock = src.slice(wiring, gitGuard);
  assert.match(wiringBlock, /\{ runClaude: runClaudeFn \}/, 'runDev must thread its own deps-injected runClaudeFn into the loop');
});

test('runDev mechanical validator retry derives accounting from the actual resume session', () => {
  const src = readFileSync(path.join(__dirname, 'phase-runner.js'), 'utf-8');
  const retryStart = src.indexOf('const retrySessionId = result.session_id || null;');
  const retryEnd = src.indexOf('if (retryRes.session_id)', retryStart);
  assert.ok(retryStart !== -1 && retryEnd > retryStart, 'mechanical retry block located');
  const retryBlock = src.slice(retryStart, retryEnd);
  assert.match(retryBlock, /contextCompilerFollowupCfg\(cfg, \{ sessionId: retrySessionId \}\)/,
    'same-session retries retain exposure; fresh no-session retries are zeroed by the helper');
  assert.match(retryBlock, /sessionId: retrySessionId/,
    'the accounting decision and subprocess use the exact same session value');
});
