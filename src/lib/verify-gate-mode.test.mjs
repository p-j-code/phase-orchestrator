// Tests for gate-mode verification (brief P3, v0.15.0) — the refine → re-check
// → escalate loop that closes the acceptance-check loop opened in report mode
// (phase 5 / verify-report-mode.test.mjs). Covers:
//   A. shouldRunGateRefine     — pure mode-isolation decision
//   B. runAcceptanceGateLoop   — deps-injected refine/re-gate/re-check loop
//      (exactly one refine by default, must_fix bullets + "(acceptance fix)"
//      suffix in the prompt, fresh checker session every re-check, bounded by
//      max_refine_attempts, validator-gate-failure-mid-refine short-circuits,
//      refine-call-error short-circuits, checker model never inherits an
//      escalated cfg.model)
//   C. decideVerdict at the gate boundary — verdict:"pass" + an unmet
//      criterion still triggers a refine, proven through the REAL
//      verify-loop.js runAcceptanceCheck (only its innermost runClaude faked)
//   D. report-mode lesson-capture guard vs. the gate-mode refine loop (brief
//      FR1 gap-fix, phase 13) — a since-corrected gate-mode fail records NO
//      lesson; an exhausted refine loop records exactly ONE (no duplicate
//      from the new immediate report-mode path)
//   E. runDev() wiring — source assertions: placement, marker heading/append,
//      no-push-on-fail, error_message format, upsertPhase(failed), mode
//      isolation via shouldRunGateRefine
//   F. error-classifier.js — "failed acceptance verification" → VALIDATION,
//      never ORCHESTRATOR_BUG
//
// No real `claude` subprocess is ever spawned.
//
// Run with: node --test src/lib/verify-gate-mode.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.env.DB_PATH = ':memory:';

const {
  shouldRunGateRefine,
  runAcceptanceGateLoop,
  maybeRecordReportModeVerifyFailLesson,
  maybeRecordGateRefinedLesson,
} = await import('./phase-runner.js');
const { runAcceptanceCheck, decideVerdict } = await import('./verify-loop.js');
const { classifyError, ERROR_KINDS } = await import('./error-classifier.js');
const { recordLesson, readLessons } = await import('./lessons.js');
const { failedTierFromResult, writeEscalationMarker } = await import('./escalation.js');

// Full 4-rung tier_models map — production cfg always carries this (defaults.json
// model_routing.tier_models); the gate loop resolves the one-tier-up bump model
// from it. Tests that assert the bumped model MUST include it in cfg.
const TIER_MODELS = { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-4-8', fable: 'claude-fable-5' };

const PHASE_META = {
  n: 5,
  title: 'FVU file builder',
  goal: 'Build the NSDL FVU export.',
  acceptance_criteria: ['Generates a valid FVU file', 'Rejects malformed challans'],
  files_expected: ['backend/services/fvuBuilder.js'],
};

function makeProjDir() {
  const d = mkdtempSync(path.join(tmpdir(), 'aorch-verify-gate-mode-'));
  mkdirSync(path.join(d, '.guide'), { recursive: true });
  mkdirSync(path.join(d, 'workspace'), { recursive: true });
  return d;
}

function baseArgs(overrides = {}) {
  const projDir = makeProjDir();
  return {
    cfg: {
      model: 'claude-sonnet-5',
      models: { 'acceptance-check': 'claude-sonnet-5', 'dev-execution': 'claude-sonnet-5' },
      verify: { mode: 'gate', max_refine_attempts: 1 },
      tools: { allowed_default: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'], permission_mode: 'acceptEdits' },
      phases: {},
    },
    projectName: 'demo',
    projDir,
    workspaceDir: path.join(projDir, 'workspace'),
    phaseMeta: PHASE_META,
    fix: null,
    preSha: 'abc1234',
    commitSha: 'def5678',
    nextPhase: 5,
    sessionId: 'dev-sess-1',
    gateEvent: { phase: 5, phaseTitle: PHASE_META.title },
    gateLabel: 'Phase 5',
    devSystemPromptExtra: null,
    ...overrides,
  };
}

const FAIL_OUTCOME = {
  status: 'fail',
  verdict: {
    verdict: 'fail',
    criteria: [{ criterion: 'Generates a valid FVU file', status: 'unmet', evidence: 'no such function found' }],
    must_fix: ['Implement FVU generation in backend/services/fvuBuilder.js'],
  },
};

const PASS_OUTCOME = {
  status: 'pass',
  verdict: { verdict: 'pass', criteria: [{ criterion: 'Generates a valid FVU file', status: 'met', evidence: 'x:1' }] },
};

// ─── A. shouldRunGateRefine — pure mode-isolation decision ──────────────────

test('shouldRunGateRefine: mode "gate" + status "fail" → true', () => {
  assert.equal(shouldRunGateRefine({ verifyCfg: { mode: 'gate' }, outcomeStatus: 'fail' }), true);
});

test('shouldRunGateRefine: mode "report" (default) never triggers, regardless of outcome status', () => {
  assert.equal(shouldRunGateRefine({ verifyCfg: { mode: 'report' }, outcomeStatus: 'fail' }), false);
  assert.equal(shouldRunGateRefine({ verifyCfg: undefined, outcomeStatus: 'fail' }), false, 'absent verify cfg defaults to report');
});

test('shouldRunGateRefine: mode "gate" but outcome "pass" or "inconclusive" → false', () => {
  assert.equal(shouldRunGateRefine({ verifyCfg: { mode: 'gate' }, outcomeStatus: 'pass' }), false);
  assert.equal(shouldRunGateRefine({ verifyCfg: { mode: 'gate' }, outcomeStatus: 'inconclusive' }), false, 'inconclusive stays fail_open even in gate mode');
});

test('shouldRunGateRefine: mode "gate" but outcome "skipped-trivial" (phase-26 docs-only skip) → false — a trivial docs-only diff never enters the refine loop', () => {
  assert.equal(shouldRunGateRefine({ verifyCfg: { mode: 'gate' }, outcomeStatus: 'skipped-trivial' }), false);
});

test('shouldRunGateRefine: mode "off" never triggers', () => {
  assert.equal(shouldRunGateRefine({ verifyCfg: { mode: 'off' }, outcomeStatus: 'fail' }), false);
});

// ─── B. runAcceptanceGateLoop — deps-injected refine/re-gate/re-check loop ──

test('runAcceptanceGateLoop: exactly one refine resume (correct sessionId, must_fix bullets, "(acceptance fix)" suffix) → re-gate → re-check with a FRESH checker session; a second fail returns failed:true', async () => {
  const claudeCalls = [];
  const gateCalls = [];
  const checkCalls = [];
  const deps = {
    runClaude: async (opts) => { claudeCalls.push(opts); return { session_id: 'dev-sess-2', is_error: false, result: 'done' }; },
    runValidatorGate: async (opts) => { gateCalls.push(opts); return { results: [], allPassed: true, hasFailures: false }; },
    runAcceptanceCheck: async (opts) => { checkCalls.push(opts); return FAIL_OUTCOME; },
    changedFilesSince: async () => ({ ok: true, files: ['backend/services/fvuBuilder.js'] }),
    getHeadSha: async () => 'newsha123',
  };

  const result = await runAcceptanceGateLoop(baseArgs({ initialOutcome: FAIL_OUTCOME }), deps);

  assert.equal(claudeCalls.length, 1, 'exactly one refine resume');
  const call = claudeCalls[0];
  assert.equal(call.sessionId, 'dev-sess-1', 'resumes the ORIGINAL dev session (sessionId passed in)');
  assert.equal(call.role, 'dev');
  assert.match(call.prompt, /Implement FVU generation in backend\/services\/fvuBuilder\.js/, 'must_fix bullets injected');
  assert.match(call.prompt, /\(acceptance fix\)/, '"(acceptance fix)" suffix instruction present');
  assert.match(call.prompt, /FAILED acceptance verification/);

  assert.equal(gateCalls.length, 1, 'validator gate re-run exactly once');
  assert.equal(checkCalls.length, 1, 'checker re-run exactly once');
  assert.equal(checkCalls[0].commitSha, 'newsha123', 're-check uses the post-refine HEAD');
  assert.ok(!('sessionId' in checkCalls[0]), 'gate loop never overrides the checker session — runAcceptanceCheck always spawns fresh internally');

  assert.equal(result.failed, true, 'second fail → terminal failure');
  assert.equal(result.outcome.status, 'fail');
  assert.deepEqual(result.outcome.verdict, FAIL_OUTCOME.verdict);
  assert.deepEqual(result.outcome.refine_tiers, ['sonnet'], 'the single attempt ran on the dev tier');
  assert.equal(result.attempts, 1);
  assert.equal(result.sessionId, 'dev-sess-2', 'the refine session id is threaded back out');
});

test('runAcceptanceGateLoop: context-compiler assist starts a fresh compact repair session, injects its manifest, then resumes only that repair session', async () => {
  const calls = [];
  let checks = 0;
  const args = baseArgs({
    initialOutcome: FAIL_OUTCOME,
    cfg: {
      ...baseArgs().cfg,
      verify: { mode: 'gate', max_refine_attempts: 2 },
      context_compiler: { enabled: true, mode: 'assist', fresh_repair_session: true, token_budget: { repair: 300, hard_max: 500 } },
    },
  });
  const manifest = {
    manifest_id: 'a'.repeat(64), project: 'demo', task_kind: 'acceptance-repair', phase: 5,
    base_sha: 'def5678', provider: 'hybrid-lexical', mode: 'assist', confidence: 0.9,
    token_budget: 300, injected_token_estimate: 120, ranked_files: [{ path: 'backend/services/fvuBuilder.js', kind: 'production', score: 100, reasons: ['failed criterion'] }],
    ranked_symbols: [], criteria_map: [], relations: [], warnings: [], test_plan: { targeted_files: [], requires_full_suite: false },
    candidate_counts: { files: 1, symbols: 0 }, generated_at: new Date().toISOString(), duration_ms: 1,
  };
  const deps = {
    runClaude: async (opts) => { calls.push(opts); return { session_id: 'repair-sess-1', is_error: false, result: 'done' }; },
    runValidatorGate: async () => ({ results: [], allPassed: true, hasFailures: false }),
    runAcceptanceCheck: async () => { checks += 1; return checks === 1 ? FAIL_OUTCOME : PASS_OUTCOME; },
    changedFilesSince: async () => ({ ok: true, files: ['backend/services/fvuBuilder.js'] }),
    getHeadSha: async () => 'repairsha',
    compileContextManifest: async () => manifest,
    recordContextManifest: () => true,
  };

  const result = await runAcceptanceGateLoop(args, deps);
  assert.equal(result.failed, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].sessionId, null, 'first repair does not resume the bloated original dev session');
  assert.equal(calls[1].sessionId, 'repair-sess-1', 'second refine resumes the compact repair session');
  assert.match(calls[0].prompt, /<compiled_context/);
  assert.equal(calls[0].cfg._context_compiler.manifest_id, manifest.manifest_id);
  assert.equal(calls[0].cfg._context_compiler.injected_tokens, 120);
});

test('runAcceptanceGateLoop: compiler-safe repair rechecks only failed criteria from the exact attempt base SHA and carries the full baseline', async () => {
  const checkCalls = [];
  const changedFrom = [];
  const baseline = {
    status: 'fail',
    verdict: {
      verdict: 'fail',
      criteria: [
        { criterion: 'Generates a valid FVU file', status: 'met', evidence: 'backend/services/fvuBuilder.js:10' },
        { criterion: 'Rejects malformed challans', status: 'unmet', evidence: 'missing guard' },
      ],
      must_fix: ['Reject malformed challans'],
    },
  };
  const manifest = {
    manifest_id: 'b'.repeat(64), project: 'demo', task_kind: 'acceptance-repair', phase: 5,
    base_sha: 'def5678', provider: 'hybrid-lexical', mode: 'assist', confidence: 0.9,
    token_budget: 300, injected_token_estimate: 120,
    ranked_files: [
      { path: 'backend/services/fvuWriter.js', kind: 'production', score: 90, reasons: ['met criterion'] },
      { path: 'backend/services/fvuBuilder.js', kind: 'production', score: 100, reasons: ['failed criterion'] },
    ],
    ranked_symbols: [],
    criteria_map: [
      {
        criterion: 'Generates a valid FVU file',
        production_files: ['backend/services/fvuWriter.js'], tests: [], configuration: [],
      },
      {
        criterion: 'Rejects malformed challans',
        production_files: ['backend/services/fvuBuilder.js'], tests: [], configuration: [],
      },
    ],
    relations: [], warnings: [],
    test_plan: { targeted_files: [], requires_full_suite: false },
    candidate_counts: { files: 1, symbols: 0 }, generated_at: new Date().toISOString(), duration_ms: 1,
  };
  const args = baseArgs({
    initialOutcome: baseline,
    cfg: {
      ...baseArgs().cfg,
      context_compiler: {
        enabled: true, mode: 'assist', fresh_repair_session: true,
        delta_acceptance_recheck: true, token_budget: { repair: 300, hard_max: 500 },
      },
    },
  });
  let headReads = 0;
  const result = await runAcceptanceGateLoop(args, {
    runClaude: async () => ({ session_id: 'repair-sess', is_error: false, result: 'done' }),
    runValidatorGate: async () => ({ results: [], allPassed: true, hasFailures: false }),
    runAcceptanceCheck: async (opts) => {
      checkCalls.push(opts);
      return PASS_OUTCOME;
    },
    changedFilesSince: async (_workspaceDir, sha) => {
      changedFrom.push(sha);
      return { ok: true, files: ['backend/services/fvuBuilder.js'] };
    },
    getHeadSha: async () => (++headReads === 1 ? 'def5678' : 'repairsha'),
    compileContextManifest: async () => manifest,
    recordContextManifest: () => true,
  });

  assert.equal(result.failed, false);
  assert.deepEqual(changedFrom, ['abc1234', 'def5678'], 'telemetry context uses the phase base, while repair validation uses the exact attempt base');
  assert.equal(checkCalls.length, 1);
  assert.equal(checkCalls[0].preSha, 'def5678', 'delta evidence starts at the commit immediately before this repair attempt');
  assert.deepEqual(checkCalls[0].phaseMeta.acceptance_criteria, ['Rejects malformed challans']);
  assert.equal(checkCalls[0].baselineVerdict, baseline.verdict, 'the full prior verdict is carried so untouched met criteria survive the merge');
});

test('runAcceptanceGateLoop: refine that fixes everything → failed:false, updated commitSha', async () => {
  const deps = {
    runClaude: async () => ({ session_id: 'dev-sess-2', is_error: false, result: 'done' }),
    runValidatorGate: async () => ({ results: [], allPassed: true, hasFailures: false }),
    runAcceptanceCheck: async () => PASS_OUTCOME,
    changedFilesSince: async () => ({ ok: true, files: [] }),
    getHeadSha: async () => 'fixedsha456',
  };
  const result = await runAcceptanceGateLoop(baseArgs({ initialOutcome: FAIL_OUTCOME }), deps);
  assert.equal(result.failed, false);
  assert.equal(result.outcome.status, 'pass');
  assert.equal(result.commitSha, 'fixedsha456');
  assert.equal(result.attempts, 1);
});

test('runAcceptanceGateLoop: inconclusive recheck fails open without being mislabeled verified', async () => {
  const deps = {
    runClaude: async () => ({ session_id: 'dev-sess-2', is_error: false, result: 'done' }),
    runValidatorGate: async () => ({ results: [], allPassed: true, hasFailures: false }),
    runAcceptanceCheck: async () => ({ status: 'inconclusive', verdict: null, errors: ['checker timed out'] }),
    changedFilesSince: async () => ({ ok: true, files: [] }),
    getHeadSha: async () => 'refinedsha',
  };
  const result = await runAcceptanceGateLoop(baseArgs({ initialOutcome: FAIL_OUTCOME }), deps);
  assert.equal(result.failed, false, 'default fail-open policy does not stop unattended execution');
  assert.equal(result.verified, false, 'lack of a verdict is never reported as an acceptance pass');
  assert.equal(result.inconclusive, true);
  assert.equal(result.outcome.status, 'inconclusive');
  assert.deepEqual(result.outcome.errors, ['checker timed out']);
});

test('runAcceptanceGateLoop: usage-limit recheck is never reported as verified — it pauses', async () => {
  const deps = {
    runClaude: async () => ({ session_id: 'dev-sess-2', is_error: false, result: 'done' }),
    runValidatorGate: async () => ({ results: [], allPassed: true, hasFailures: false }),
    runAcceptanceCheck: async () => ({ status: 'usage-limit', verdict: null, errors: ["You've hit your session limit · resets 3pm"] }),
    changedFilesSince: async () => ({ ok: true, files: [] }),
    getHeadSha: async () => 'refinedsha',
  };
  const result = await runAcceptanceGateLoop(baseArgs({ initialOutcome: FAIL_OUTCOME }), deps);
  assert.equal(result.verified, false, 'a provider window closing is never an acceptance pass');
  assert.equal(result.failed, false, 'nor is it a checker fail — it must pause, not refine');
  assert.equal(result.inconclusive, false);
  assert.equal(result.usageLimited, true, 'the caller pauses via the same chokepoint as the initial check');
  assert.equal(result.outcome.status, 'usage-limit');
});

test('runAcceptanceGateLoop: an unrecognized recheck status lands as inconclusive, never a silent pass', async () => {
  const deps = {
    runClaude: async () => ({ session_id: 'dev-sess-2', is_error: false, result: 'done' }),
    runValidatorGate: async () => ({ results: [], allPassed: true, hasFailures: false }),
    runAcceptanceCheck: async () => ({ status: 'some-future-status', verdict: null, errors: [] }),
    changedFilesSince: async () => ({ ok: true, files: [] }),
    getHeadSha: async () => 'refinedsha',
  };
  const result = await runAcceptanceGateLoop(baseArgs({ initialOutcome: FAIL_OUTCOME }), deps);
  assert.equal(result.verified, false);
  assert.equal(result.inconclusive, true);
  assert.match(result.outcome.errors[0], /unrecognized status 'some-future-status'/);
});

test('runAcceptanceGateLoop: inconclusive recheck fails closed when verify.fail_open=false', async () => {
  const args = baseArgs({ initialOutcome: FAIL_OUTCOME });
  args.cfg.verify.fail_open = false;
  const result = await runAcceptanceGateLoop(args, {
    runClaude: async () => ({ session_id: 'dev-sess-2', is_error: false, result: 'done' }),
    runValidatorGate: async () => ({ results: [], allPassed: true, hasFailures: false }),
    runAcceptanceCheck: async () => ({ status: 'inconclusive', verdict: null, errors: ['invalid checker JSON'] }),
    changedFilesSince: async () => ({ ok: true, files: [] }),
    getHeadSha: async () => 'refinedsha',
  });
  assert.equal(result.failed, true);
  assert.equal(result.verified, false);
  assert.equal(result.inconclusive, false, 'fail-closed conversion is an actionable failure');
  assert.equal(result.outcome.status, 'fail');
  assert.match(result.outcome.verdict.must_fix[0], /fail_open=false.*invalid checker JSON/);
});

test('runAcceptanceGateLoop: refine count never exceeds cfg.verify.max_refine_attempts', async () => {
  let claudeCalls = 0;
  let checkCalls = 0;
  const deps = {
    runClaude: async () => { claudeCalls += 1; return { session_id: 'dev-sess-x', is_error: false, result: 'done' }; },
    runValidatorGate: async () => ({ results: [], allPassed: true, hasFailures: false }),
    runAcceptanceCheck: async () => { checkCalls += 1; return FAIL_OUTCOME; },
    changedFilesSince: async () => ({ ok: true, files: [] }),
    getHeadSha: async () => 'sha',
  };
  const args = baseArgs({ initialOutcome: FAIL_OUTCOME });
  args.cfg.verify.max_refine_attempts = 3;
  const result = await runAcceptanceGateLoop(args, deps);
  assert.equal(claudeCalls, 3, 'exactly max_refine_attempts refine calls, no more');
  assert.equal(checkCalls, 3);
  assert.equal(result.attempts, 3);
  assert.equal(result.failed, true, 'still failing after budget exhausted');
});

test('runAcceptanceGateLoop: a validator-gate failure mid-refine is a terminal fail for that attempt WITHOUT spending a checker call', async () => {
  let checkCalls = 0;
  const deps = {
    runClaude: async () => ({ session_id: 'dev-sess-2', is_error: false, result: 'done' }),
    runValidatorGate: async () => ({ results: [{ validator_name: 'default:npm-test', pass: false, output: 'boom' }], allPassed: false, hasFailures: true }),
    runAcceptanceCheck: async () => { checkCalls += 1; return PASS_OUTCOME; },
    changedFilesSince: async () => ({ ok: true, files: [] }),
    getHeadSha: async () => 'brokensha',
  };
  const result = await runAcceptanceGateLoop(baseArgs({ initialOutcome: FAIL_OUTCOME }), deps);
  assert.equal(checkCalls, 0, 'checker never re-runs on a broken commit');
  assert.equal(result.failed, true);
  assert.match(result.outcome.verdict.must_fix[0], /Validator gate failed/);
  assert.equal(result.commitSha, 'brokensha');
});

test('runAcceptanceGateLoop: a refine dev-call error is a terminal fail WITHOUT a gate or checker call', async () => {
  let gateCalls = 0;
  let checkCalls = 0;
  const deps = {
    runClaude: async () => ({ session_id: null, is_error: true, error_message: 'claude exited 1', result: 'claude exited 1' }),
    runValidatorGate: async () => { gateCalls += 1; return { results: [], allPassed: true, hasFailures: false }; },
    runAcceptanceCheck: async () => { checkCalls += 1; return PASS_OUTCOME; },
    changedFilesSince: async () => ({ ok: true, files: [] }),
    getHeadSha: async () => 'sha',
  };
  const result = await runAcceptanceGateLoop(baseArgs({ initialOutcome: FAIL_OUTCOME }), deps);
  assert.equal(gateCalls, 0);
  assert.equal(checkCalls, 0);
  assert.equal(result.failed, true);
  assert.match(result.outcome.verdict.must_fix[0], /Refine attempt errored/);
});

test('runAcceptanceGateLoop: an already-passing initial outcome never enters the loop (0 refine calls)', async () => {
  let claudeCalls = 0;
  const deps = {
    runClaude: async () => { claudeCalls += 1; return { session_id: 'x', is_error: false, result: 'done' }; },
    runValidatorGate: async () => ({ results: [], allPassed: true, hasFailures: false }),
    runAcceptanceCheck: async () => PASS_OUTCOME,
    changedFilesSince: async () => ({ ok: true, files: [] }),
    getHeadSha: async () => 'sha',
  };
  const result = await runAcceptanceGateLoop(baseArgs({ initialOutcome: PASS_OUTCOME }), deps);
  assert.equal(claudeCalls, 0);
  assert.equal(result.failed, false);
  assert.equal(result.attempts, 0);
  assert.equal(result.commitSha, 'def5678', 'commitSha unchanged when the loop never runs');
});

test('runAcceptanceGateLoop: attempt 1 (the only attempt at max_refine_attempts:1) passes cfg model UNCHANGED — an Opus-escalated phase refines on Opus too', async () => {
  const claudeCalls = [];
  const deps = {
    runClaude: async (opts) => { claudeCalls.push(opts); return { session_id: 'dev-sess-2', is_error: false, result: 'done' }; },
    runValidatorGate: async () => ({ results: [], allPassed: true, hasFailures: false }),
    runAcceptanceCheck: async () => PASS_OUTCOME,
    changedFilesSince: async () => ({ ok: true, files: [] }),
    getHeadSha: async () => 'sha',
  };
  const args = baseArgs({ initialOutcome: FAIL_OUTCOME });
  args.cfg.model = 'claude-opus-4-8'; // simulates a failure-driven escalation marker already in effect
  await runAcceptanceGateLoop(args, deps); // max_refine_attempts:1 → attempt 1 only, never a bump
  assert.equal(claudeCalls[0].cfg.model, 'claude-opus-4-8', 'attempt 1 inherits whatever model the phase is already running on');
});

// ─── B2. phase-25 tier-escalating rung (attempt 2+ bumps ONE tier up) ───────

test('runAcceptanceGateLoop: attempt 1 runs on the dev model resuming the dev session; attempt 2 resumes the SAME session with the model one tier up', async () => {
  const claudeCalls = [];
  const deps = {
    // Return the SAME session id each call so "same session id" is provable
    // across both attempts (production --resume keeps one conversation).
    runClaude: async (opts) => { claudeCalls.push({ model: opts.cfg.model, sessionId: opts.sessionId, tier: opts.routing?.tier }); return { session_id: 'dev-sess-1', is_error: false, result: 'done' }; },
    runValidatorGate: async () => ({ results: [], allPassed: true, hasFailures: false }),
    runAcceptanceCheck: async () => FAIL_OUTCOME, // never resolves → uses the full refine budget
    changedFilesSince: async () => ({ ok: true, files: [] }),
    getHeadSha: async () => 'sha',
  };
  const args = baseArgs({ initialOutcome: FAIL_OUTCOME });
  args.cfg.verify.max_refine_attempts = 2;
  args.cfg.model = 'claude-sonnet-5';
  args.cfg.model_routing = { tier_models: TIER_MODELS };

  const result = await runAcceptanceGateLoop(args, deps);

  assert.equal(claudeCalls.length, 2, 'both refine attempts spent');
  assert.equal(claudeCalls[0].model, 'claude-sonnet-5', 'attempt 1 on the dev model');
  assert.equal(claudeCalls[0].sessionId, 'dev-sess-1', 'attempt 1 resumes the dev session');
  assert.equal(claudeCalls[0].tier, 'sonnet');
  assert.equal(claudeCalls[1].model, 'claude-opus-4-8', 'attempt 2 bumps ONE tier up (sonnet→opus)');
  assert.equal(claudeCalls[1].sessionId, 'dev-sess-1', 'attempt 2 resumes the SAME session id (context is the asset)');
  assert.equal(claudeCalls[1].tier, 'opus');
  assert.deepEqual(result.outcome.refine_tiers, ['sonnet', 'opus'], 'refine_tiers records the tiers actually tried');
  assert.deepEqual(result.refine_tiers, ['sonnet', 'opus'], 'and surfaced top-level too');
});

test('runAcceptanceGateLoop: a fable dev model gets NO bump on attempt 2 (already the top rung)', async () => {
  const claudeCalls = [];
  const deps = {
    runClaude: async (opts) => { claudeCalls.push({ model: opts.cfg.model, tier: opts.routing?.tier }); return { session_id: 'dev-sess-1', is_error: false, result: 'done' }; },
    runValidatorGate: async () => ({ results: [], allPassed: true, hasFailures: false }),
    runAcceptanceCheck: async () => FAIL_OUTCOME,
    changedFilesSince: async () => ({ ok: true, files: [] }),
    getHeadSha: async () => 'sha',
  };
  const args = baseArgs({ initialOutcome: FAIL_OUTCOME });
  args.cfg.verify.max_refine_attempts = 2;
  args.cfg.model = 'claude-fable-5';
  args.cfg.model_routing = { tier_models: TIER_MODELS };

  const result = await runAcceptanceGateLoop(args, deps);

  assert.equal(claudeCalls.length, 2);
  assert.equal(claudeCalls[0].model, 'claude-fable-5', 'attempt 1 on the fable dev model');
  assert.equal(claudeCalls[1].model, 'claude-fable-5', 'attempt 2 stays on fable — no rung above it');
  assert.deepEqual(result.outcome.refine_tiers, ['fable', 'fable'], 'both attempts recorded at the fable tier');
});

// ─── B3. refine_tiers → failedTierFromResult → escalation marker target ──────

test('gate-fail refine_tiers thread onto verify_outcome so failedTierFromResult picks the HIGHEST tier tried, and the marker targets one rung above it', async () => {
  const cfg = { model: 'claude-sonnet-5', model_routing: { tier_models: TIER_MODELS } };
  // Shape mirrors runDev()'s gate-fail is_error return: routing.tier = the dev
  // run tier (sonnet); verify_outcome.refine_tiers = the gate loop's rungs.
  const gateFailResult = {
    is_error: true,
    routing: { tier: 'sonnet' },
    verify_outcome: { status: 'fail', refine_tiers: ['sonnet', 'opus'] },
  };
  const failedTier = failedTierFromResult(gateFailResult, cfg);
  assert.equal(failedTier, 'opus', 'highest tier across the dev run (sonnet) and refine rungs (sonnet, opus)');

  const projDir = makeProjDir();
  const { written, targetTier } = await writeEscalationMarker({ projDir, phaseN: 5, failedTier, reason: 'gate fail', at: 'T' });
  assert.equal(written, true);
  assert.equal(targetTier, 'fable', 'target_tier lands exactly one rung above the highest refine tier tried (opus→fable)');

  // Prove the persisted marker body carries it (executeAction's single write site).
  const marker = JSON.parse(readFileSync(path.join(projDir, '.guide', 'phase-5-escalate.marker'), 'utf-8'));
  assert.equal(marker.target_tier, 'fable');
  assert.equal(marker.failed_tier, 'opus');
});

test('failedTierFromResult: absent/empty refine_tiers is byte-identical to the pre-phase-25 behavior (falls back to routing.tier / cfg.model)', () => {
  const cfg = { model: 'claude-sonnet-5', model_routing: { tier_models: TIER_MODELS } };
  assert.equal(failedTierFromResult({ routing: { tier: 'sonnet' } }, cfg), 'sonnet', 'no verify_outcome → routing tier');
  assert.equal(failedTierFromResult({ verify_outcome: { refine_tiers: [] } }, cfg), 'sonnet', 'empty refine_tiers → cfg.model tier');
  assert.equal(failedTierFromResult({}, cfg), 'sonnet', 'nothing → cfg.model heuristic');
});

// ─── B4. phase-30: fix-aware gate loop (re-check threading + escalation marker) ─

test('runAcceptanceGateLoop: a fix run threads `fix` into the internal re-check call to runAcceptanceCheckFn (so it resolves verify.json/phaseMeta under the fix dir, not a phase dir)', async () => {
  const checkCalls = [];
  const deps = {
    runClaude: async () => ({ session_id: 'dev-sess-2', is_error: false, result: 'done' }),
    runValidatorGate: async () => ({ results: [], allPassed: true, hasFailures: false }),
    runAcceptanceCheck: async (opts) => { checkCalls.push(opts); return PASS_OUTCOME; },
    changedFilesSince: async () => ({ ok: true, files: [] }),
    getHeadSha: async () => 'fixedsha456',
  };
  const fix = { round: 2, n: 3, title: 'Upload security hardening' };
  const args = baseArgs({ fix, phaseMeta: null, gateEvent: { fixRound: fix.round, fixN: fix.n, fixTitle: fix.title }, gateLabel: `Fix r${fix.round}-${fix.n}`, initialOutcome: FAIL_OUTCOME });
  const result = await runAcceptanceGateLoop(args, deps);
  assert.equal(result.failed, false);
  assert.equal(checkCalls.length, 1);
  assert.deepEqual(checkCalls[0].fix, fix, 're-check carries the SAME fix object the loop itself received');
});

test('gate-fail refine_tiers thread onto verify_outcome for a FIX result too, and writeEscalationMarker persists the fix-shaped marker file (fix-rR-N-escalate.marker)', async () => {
  const cfg = { model: 'claude-sonnet-5', model_routing: { tier_models: TIER_MODELS } };
  const fix = { round: 2, n: 3 };
  // Shape mirrors runDev()'s gate-fail is_error return for a FIX (routing.tier
  // = the fix-execution run tier; verify_outcome.refine_tiers = the gate
  // loop's rungs) — the B3 test above proves the same for a phase.
  const gateFailResult = {
    is_error: true,
    routing: { tier: 'sonnet' },
    verify_outcome: { status: 'fail', refine_tiers: ['sonnet', 'opus'] },
  };
  const failedTier = failedTierFromResult(gateFailResult, cfg);
  assert.equal(failedTier, 'opus');

  const projDir = makeProjDir();
  const { written, targetTier } = await writeEscalationMarker({ projDir, fix, failedTier, reason: 'gate fail', at: 'T' });
  assert.equal(written, true);
  assert.equal(targetTier, 'fable');

  const marker = JSON.parse(readFileSync(path.join(projDir, '.guide', `fix-r${fix.round}-${fix.n}-escalate.marker`), 'utf-8'));
  assert.equal(marker.target_tier, 'fable');
  assert.equal(marker.failed_tier, 'opus');
});

// ─── C. decideVerdict at the gate boundary — via the REAL checker ───────────

test('runAcceptanceGateLoop + REAL verify-loop.js runAcceptanceCheck: verdict:"pass" with an unmet criterion is still an effective fail that triggers a refine', async () => {
  const PASS_BUT_UNMET_JSON = JSON.stringify({
    verdict: 'pass', // the checker itself got the top-level field wrong
    criteria: [
      { criterion: 'Generates a valid FVU file', status: 'unmet', evidence: 'no such function found' },
      { criterion: 'Rejects malformed challans', status: 'met', evidence: 'x:44' },
    ],
    must_fix: ['Implement FVU generation'],
  });
  const RECHECK_PASS_JSON = JSON.stringify({
    verdict: 'pass',
    criteria: [
      { criterion: 'Generates a valid FVU file', status: 'met', evidence: 'x:20' },
      { criterion: 'Rejects malformed challans', status: 'met', evidence: 'x:44' },
    ],
  });

  // Reproduce phase-runner's own initial call to prove the SAME real
  // decision-making (decideVerdict inside runAcceptanceCheck) that would run
  // in production resolves this to status:'fail' before the gate loop ever sees it.
  const initialOutcome = await runAcceptanceCheck(
    { cfg: baseArgs().cfg, projectName: 'demo', projDir: makeProjDir(), workspaceDir: path.join(tmpdir(), 'unused'), phaseMeta: PHASE_META, preSha: 'abc1234', commitSha: 'def5678', nextPhase: 5 },
    { runClaude: async () => ({ result: PASS_BUT_UNMET_JSON, session_id: 's1', is_error: false }) },
  );
  assert.equal(initialOutcome.status, 'fail', 'verdict:"pass" + an unmet criterion resolves to status:"fail" (decideVerdict), not just at the unit-test level');

  let checkerCallCount = 0;
  const deps = {
    runClaude: async () => ({ session_id: 'dev-sess-2', is_error: false, result: 'done' }),
    runValidatorGate: async () => ({ results: [], allPassed: true, hasFailures: false }),
    // The real runAcceptanceCheck, only its innermost runClaude faked — proves the
    // gate boundary inherits the SAME effective_fail decision on re-check too.
    runAcceptanceCheck: (args) => {
      checkerCallCount += 1;
      return runAcceptanceCheck(args, { runClaude: async () => ({ result: RECHECK_PASS_JSON, session_id: 's2', is_error: false }) });
    },
    changedFilesSince: async () => ({ ok: true, files: [] }),
    getHeadSha: async () => 'fixedsha',
  };

  const result = await runAcceptanceGateLoop(baseArgs({ initialOutcome }), deps);
  assert.equal(checkerCallCount, 1, 'the gate loop refined and re-checked exactly once');
  assert.equal(result.failed, false, 'the re-check (all criteria genuinely met) resolves the gate');
});

// ─── D. report-mode lesson-capture guard vs. the gate-mode refine loop ──────
// (brief FR1 gap-fix, phase 13) — proves the NEW immediate report-mode lesson
// path (maybeRecordReportModeVerifyFailLesson, verify-report-mode.test.mjs)
// and the EXISTING deferred gate-mode lesson path (the recordLesson call at
// the `if (gateLoop.failed)` site in runDev(), source:'phase-runner:acceptance-gate')
// never both fire for the same outcome, and that a since-corrected gate-mode
// failure produces no lesson at all. `simulateAcceptanceHook` reproduces
// runDev()'s own hook sequence — mode isolation via shouldRunGateRefine, then
// the gate loop, then the SAME recordLesson call runDev() makes on
// gateLoop.failed — since exercising the real runDev() needs a full
// git/DB/workspace fixture (see phase-runner-cache-discipline.test.mjs for
// the same "shadow reimplementation" testing pattern used elsewhere in this
// codebase). None of the underlying decision functions (shouldRunGateRefine,
// runAcceptanceGateLoop, maybeRecordReportModeVerifyFailLesson) are faked —
// only their call SEQUENCE is reproduced, and that sequence itself is pinned
// by the section-E source assertions below.

async function simulateAcceptanceHook({ cfg, projDir, phaseMeta, fix, nextPhase, verifyOutcome, gateLoopArgs, gateLoopDeps, fixLessonMeta = null }) {
  await maybeRecordReportModeVerifyFailLesson({ cfg, projDir, phaseMeta, fix, nextPhase, verifyOutcome });
  if (!shouldRunGateRefine({ verifyCfg: cfg.verify, outcomeStatus: verifyOutcome?.status })) return { ranGateLoop: false, gateLoop: null };
  const gateLoop = await runAcceptanceGateLoop({ ...gateLoopArgs, initialOutcome: verifyOutcome }, gateLoopDeps);
  if (gateLoop.failed) {
    const failMustFix = gateLoop.outcome?.verdict?.must_fix?.length
      ? gateLoop.outcome.verdict.must_fix
      : decideVerdict(gateLoop.outcome?.verdict || {}).unmet.map((c) => c.criterion);
    const bullets = (failMustFix.length ? failMustFix : ['(see verify.json for details)']).map((m) => `- ${m}`).join('\n');
    await recordLesson(projDir, { kind: 'verify-fail', phase: fix ? null : nextPhase, fix: fix ? `r${fix.round}-${fix.n}` : null, source: 'phase-runner:acceptance-gate', lesson: bullets, files: phaseMeta?.files_expected || fixLessonMeta?.files_expected || [] }, cfg);
  } else {
    // Phase 41 (CE-9): mirror runDev — a gate that passed only after >=1 refine
    // records a 'verify-refined' lesson (the near-miss the refine had to rescue).
    await maybeRecordGateRefinedLesson({ cfg, projDir, phaseMeta, fixLessonMeta, fix, nextPhase, initialOutcome: verifyOutcome, gateLoop });
  }
  return { ranGateLoop: true, gateLoop };
}

test('gate mode: initial fail that a refine attempt fixes → exactly ONE "verify-refined" lesson (Phase 41: near-misses now teach too), with the INITIALLY-unmet criteria and the phase files', async () => {
  const args = baseArgs({ initialOutcome: FAIL_OUTCOME });
  const deps = {
    runClaude: async () => ({ session_id: 'dev-sess-2', is_error: false, result: 'done' }),
    runValidatorGate: async () => ({ results: [], allPassed: true, hasFailures: false }),
    runAcceptanceCheck: async () => PASS_OUTCOME,
    changedFilesSince: async () => ({ ok: true, files: [] }),
    getHeadSha: async () => 'fixedsha456',
  };
  const { gateLoop } = await simulateAcceptanceHook({
    cfg: args.cfg, projDir: args.projDir, phaseMeta: args.phaseMeta, fix: args.fix, nextPhase: args.nextPhase,
    verifyOutcome: FAIL_OUTCOME, gateLoopArgs: args, gateLoopDeps: deps,
  });
  assert.equal(gateLoop.failed, false);
  assert.ok(gateLoop.attempts >= 1);
  const lessons = await readLessons(args.projDir);
  assert.equal(lessons.length, 1, 'a since-corrected gate-mode failure now records the verify-refined near-miss');
  assert.equal(lessons[0].kind, 'verify-refined');
  assert.equal(lessons[0].source, 'phase-runner:acceptance-gate-refined');
  assert.equal(lessons[0].phase, 5);
  assert.deepEqual(lessons[0].files, PHASE_META.files_expected, 'carries the phase files so future phases inherit it');
  assert.ok(lessons[0].lesson.includes('Implement FVU generation'), 'records the INITIALLY-unmet criterion');
});

test('gate mode: a clean FIRST-PASS gate (never entered the refine loop) records nothing — verify-refined only fires on a refined pass', async () => {
  const args = baseArgs({ initialOutcome: PASS_OUTCOME });
  const { ranGateLoop } = await simulateAcceptanceHook({
    cfg: args.cfg, projDir: args.projDir, phaseMeta: args.phaseMeta, fix: args.fix, nextPhase: args.nextPhase,
    verifyOutcome: PASS_OUTCOME, gateLoopArgs: args, gateLoopDeps: {},
  });
  assert.equal(ranGateLoop, false, 'shouldRunGateRefine is false for a passing outcome → no gate loop');
  assert.equal((await readLessons(args.projDir)).length, 0, 'a clean first-pass gate records nothing new');
});

test('gate mode: refine loop exhausted/failed → exactly ONE verify-fail lesson (the existing acceptance-gate path), not two', async () => {
  const args = baseArgs({ initialOutcome: FAIL_OUTCOME });
  const deps = {
    runClaude: async () => ({ session_id: 'dev-sess-2', is_error: false, result: 'done' }),
    runValidatorGate: async () => ({ results: [], allPassed: true, hasFailures: false }),
    runAcceptanceCheck: async () => FAIL_OUTCOME,
    changedFilesSince: async () => ({ ok: true, files: [] }),
    getHeadSha: async () => 'newsha123',
  };
  const { gateLoop } = await simulateAcceptanceHook({
    cfg: args.cfg, projDir: args.projDir, phaseMeta: args.phaseMeta, fix: args.fix, nextPhase: args.nextPhase,
    verifyOutcome: FAIL_OUTCOME, gateLoopArgs: args, gateLoopDeps: deps,
  });
  assert.equal(gateLoop.failed, true);
  const lessons = await readLessons(args.projDir);
  assert.equal(lessons.length, 1, 'exactly one lesson — no duplicate from the new report-mode path');
  assert.equal(lessons[0].source, 'phase-runner:acceptance-gate');
});

test('report mode is never reachable from this file\'s gate-mode fixtures — maybeRecordReportModeVerifyFailLesson is a true no-op whenever shouldRunGateRefine is true', async () => {
  // Belt-and-suspenders: mode:'gate' + status:'fail' always satisfies
  // shouldRunGateRefine (tested in section A above), so the immediate
  // report-mode path must never write a lesson for ANY gate-mode fail,
  // independent of whether the loop that follows ultimately fixes it.
  const projDir = makeProjDir();
  const recorded = await maybeRecordReportModeVerifyFailLesson({
    cfg: { verify: { mode: 'gate', max_refine_attempts: 1 } }, projDir, phaseMeta: PHASE_META, fix: null, nextPhase: 5,
    verifyOutcome: FAIL_OUTCOME,
  });
  assert.equal(recorded, false);
  assert.equal((await readLessons(projDir)).length, 0);
});

// ─── E. runDev() wiring — source assertions ──────────────────────────────────

const phaseRunnerSrc = readFileSync(fileURLToPath(new URL('./phase-runner.js', import.meta.url)), 'utf-8');

test('runDev(): gate-mode exhausted-refine lesson call site (source:"phase-runner:acceptance-gate") records the phase OR fix files (Phase 41: fix files no longer empty)', () => {
  assert.match(
    phaseRunnerSrc,
    /recordLesson\(projDir, \{ kind: 'verify-fail', phase: fix \? null : nextPhase, fix: fix \? `r\$\{fix\.round\}-\$\{fix\.n\}` : null, source: 'phase-runner:acceptance-gate', lesson: bullets, files: phaseMeta\?\.files_expected \|\| fixLessonMeta\?\.files_expected \|\| \[\] \}, cfg\);/,
  );
});

test('runDev(): a gate-mode PASS after >=1 refine records a verify-refined lesson via maybeRecordGateRefinedLesson (source assertion)', () => {
  assert.match(phaseRunnerSrc, /await maybeRecordGateRefinedLesson\(\{/);
  assert.match(phaseRunnerSrc, /kind: 'verify-refined'/);
});

test('runDev(): the report-mode lesson-capture call sits BEFORE the gate-mode block that computes gateLoop, matching simulateAcceptanceHook\'s sequence above', () => {
  const hookIdx = phaseRunnerSrc.indexOf('maybeRecordReportModeVerifyFailLesson({ cfg, projDir, phaseMeta: phaseMeta || null, fix, nextPhase, verifyOutcome });');
  const gateIdx = phaseRunnerSrc.indexOf('if (shouldRunGateRefine({ verifyCfg: cfg.verify, outcomeStatus: verifyOutcome?.status })) {');
  assert.ok(hookIdx > -1 && gateIdx > -1);
  assert.ok(hookIdx < gateIdx);
});

test('runDev(): gate-mode block sits AFTER the acceptance-check hook and BEFORE markPhaseCompleted/pushBranch', () => {
  const hookIdx = phaseRunnerSrc.indexOf('const verifyOutcome = await runPhaseAcceptanceCheck({');
  const gateIdx = phaseRunnerSrc.indexOf('if (shouldRunGateRefine({ verifyCfg: cfg.verify, outcomeStatus: verifyOutcome?.status })) {');
  // Phase 68 (P3): the primary completion routes through the shared
  // completeMergedPhase() helper — anchor on its unique call-site argument literal.
  const completeIdx = phaseRunnerSrc.indexOf('{ projectName, n: nextPhase, commit_sha, projDir }');
  const pushIdx = phaseRunnerSrc.indexOf('const push = await pushBranchFn(workspaceDir, { branch });');
  assert.ok(hookIdx > -1 && gateIdx > -1 && completeIdx > -1 && pushIdx > -1, 'all anchors found in source');
  assert.ok(hookIdx < gateIdx, 'gate block runs after the report-mode hook computes verifyOutcome');
  assert.ok(gateIdx < completeIdx, 'gate block runs before markPhaseCompleted');
  assert.ok(gateIdx < pushIdx, 'gate block runs before pushBranch');
});

test('runDev(): gate-mode terminal failure appends the "## Acceptance verification failed" heading + must_fix bullets to the SAME validationMarkerPath the validator gate uses', () => {
  const block = phaseRunnerSrc.slice(
    phaseRunnerSrc.indexOf('if (shouldRunGateRefine('),
    phaseRunnerSrc.indexOf('if (!fix) {\n        // Phase 68'),
  );
  assert.match(block, /fs\.appendFile\(validationMarkerPath, `\\n\\n## Acceptance verification failed\\n\$\{bullets\}\\n`/);
});

test('runDev(): gate-mode terminal failure returns is_error:true, error_message starting "Phase {n} committed but failed acceptance verification", upsertPhase(failed), and a git_result with ok:false (no pushBranch call precedes the return)', () => {
  const block = phaseRunnerSrc.slice(
    phaseRunnerSrc.indexOf('if (shouldRunGateRefine('),
    phaseRunnerSrc.indexOf('if (!fix) {\n        // Phase 68'),
  );
  assert.match(block, /is_error: true,/);
  assert.match(block, /error_message: `\$\{acceptLabel\} committed but failed acceptance verification/);
  assert.match(block, /upsertPhase\(\{ project: projectName, n: nextPhase, status: 'failed' \}\);/);
  assert.match(block, /git_result: \{ ok: false, branch, commit_sha, error: 'acceptance-verification-failed' \}/);
  // A CALL, not the bare word — Phase 67's lane-return comment names pushBranch in prose.
  assert.ok(!/pushBranch\w*\(/.test(block), 'no pushBranch call anywhere inside the gate-failure block — commit never reaches origin');
});

test('runDev(): the acceptLabel "Phase {n}" resolves the required error_message prefix literally (gateLabel/acceptLabel convention already used by the validator gate)', () => {
  assert.match(phaseRunnerSrc, /const acceptLabel = fix \? `Fix r\$\{fix\.round\}-\$\{fix\.n\}` : `Phase \$\{nextPhase\}`;/);
});

test('runDev(): gate-mode block is gated by shouldRunGateRefine — mode isolation is structural, not duplicated inline logic', () => {
  assert.match(phaseRunnerSrc, /if \(shouldRunGateRefine\(\{ verifyCfg: cfg\.verify, outcomeStatus: verifyOutcome\?\.status \}\)\) \{/);
});

test('runDev(): refine session resumes result.session_id per the phase spec', () => {
  assert.match(phaseRunnerSrc, /sessionId: result\.session_id \|\| null,\s*\n\s*gateEvent: acceptGateEvent, gateLabel: acceptLabel, devSystemPromptExtra,/);
});

// ─── F. error-classifier.js — VALIDATION, never ORCHESTRATOR_BUG ────────────

test('classifyError: "Phase N committed but failed acceptance verification..." → VALIDATION kind, not ORCHESTRATOR_BUG', () => {
  const msg = 'Phase 5 committed but failed acceptance verification (after 1 refine attempt(s)): Implement FVU generation';
  const result = classifyError(new Error(msg));
  assert.equal(result.kind, ERROR_KINDS.VALIDATION);
  assert.notEqual(result.kind, ERROR_KINDS.ORCHESTRATOR_BUG);
});

test('classifyError: a fix-scoped acceptance-verification failure message also classifies as VALIDATION', () => {
  const msg = 'Fix r2-3 committed but failed acceptance verification (after 1 refine attempt(s)): some criterion';
  assert.equal(classifyError(msg).kind, ERROR_KINDS.VALIDATION);
});

test('classifyError: VALIDATION kind is non-recoverable with maxAttempts 0 (same as every other validation failure — routes straight to escalation, never retried by the healer)', () => {
  const result = classifyError('failed acceptance verification');
  assert.equal(result.recoverable, false);
  assert.equal(result.maxAttempts, 0);
});
