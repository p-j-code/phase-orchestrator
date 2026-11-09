// v0.15.0 verifier — brief P3, gate-mode acceptance verification (refine →
// re-check → escalate) closes the verify-loop feature area opened in P1/P2
// (phases 1, 2, 3, 5):
//
//   A. mode isolation             — shouldRunGateRefine (functional)
//   B. refine → re-gate → re-check loop, bounded, no real claude spawn (functional)
//   C. terminal-failure marker + error_message shape (functional, via the loop's
//      return value — mirrors exactly what runDev()'s call site writes)
//   D. runDev() wiring            — placement, marker append, no-push, escalation
//      routing untouched (source assertions, per repo convention)
//   E. error-classifier.js        — VALIDATION kind, never ORCHESTRATOR_BUG (functional)
//   F. checker routing independence — no session/role clobber under refine (functional)
//   G. version                    — 0.15.0 stamp (1)
//
// No real `claude` subprocess is ever spawned — all claude/validator/checker
// interaction goes through the deps seam runAcceptanceGateLoop already exposes
// (mirrors phases 3/5's deps-injection convention; VERIFY_LOOP.md's original
// "__testHooks" reference predates that convention).
//
// Run with: node scripts/verify-v0_15_0.mjs

import { readFileSync, existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import chalk from 'chalk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

let passed = 0;
let failed = 0;
function check(label, ok, details) {
  if (ok) { console.log(chalk.green('  OK  '), label); passed += 1; }
  else    { console.log(chalk.red('  FAIL'), label, details ? chalk.dim(`— ${details}`) : ''); failed += 1; }
}
function readSrc(rel) {
  const p = resolve(REPO_ROOT, rel);
  if (!existsSync(p)) throw new Error(`Missing file: ${rel}`);
  return readFileSync(p, 'utf8');
}
function makeProjDir() {
  const d = mkdtempSync(join(tmpdir(), 'v0150-proj-'));
  mkdirSync(join(d, '.guide'), { recursive: true });
  mkdirSync(join(d, 'workspace'), { recursive: true });
  return d;
}

console.log(chalk.bold('\n── v0.15.0 verifier ──\n'));

const pr = await import(resolve(REPO_ROOT, 'src/lib/phase-runner.js'));
const { classifyError, ERROR_KINDS } = await import(resolve(REPO_ROOT, 'src/lib/error-classifier.js'));
const prSrc = readSrc('src/lib/phase-runner.js');

const PHASE_META = {
  n: 5, title: 'FVU file builder', goal: 'Build the NSDL FVU export.',
  acceptance_criteria: ['Generates a valid FVU file', 'Rejects malformed challans'],
  files_expected: ['backend/services/fvuBuilder.js'],
};
const FAIL_OUTCOME = {
  status: 'fail',
  verdict: {
    verdict: 'fail',
    criteria: [{ criterion: 'Generates a valid FVU file', status: 'unmet', evidence: 'no such function found' }],
    must_fix: ['Implement FVU generation in backend/services/fvuBuilder.js'],
  },
};
const PASS_OUTCOME = { status: 'pass', verdict: { verdict: 'pass', criteria: [{ criterion: 'x', status: 'met' }] } };

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
    projectName: 'demo', projDir, workspaceDir: join(projDir, 'workspace'),
    phaseMeta: PHASE_META, fix: null, preSha: 'abc1234', commitSha: 'def5678', nextPhase: 5,
    sessionId: 'dev-sess-1', gateEvent: { phase: 5, phaseTitle: PHASE_META.title }, gateLabel: 'Phase 5',
    devSystemPromptExtra: null,
    ...overrides,
  };
}

// ─── A. mode isolation ────────────────────────────────────────────────────
console.log(chalk.bold('A. mode isolation'));

check('shouldRunGateRefine: report mode (default) never triggers regardless of outcome',
  pr.shouldRunGateRefine({ verifyCfg: { mode: 'report' }, outcomeStatus: 'fail' }) === false
  && pr.shouldRunGateRefine({ verifyCfg: undefined, outcomeStatus: 'fail' }) === false);
check('shouldRunGateRefine: gate mode + fail → true; gate mode + pass/inconclusive → false',
  pr.shouldRunGateRefine({ verifyCfg: { mode: 'gate' }, outcomeStatus: 'fail' }) === true
  && pr.shouldRunGateRefine({ verifyCfg: { mode: 'gate' }, outcomeStatus: 'pass' }) === false
  && pr.shouldRunGateRefine({ verifyCfg: { mode: 'gate' }, outcomeStatus: 'inconclusive' }) === false);
check('shouldRunGateRefine: mode "off" never triggers',
  pr.shouldRunGateRefine({ verifyCfg: { mode: 'off' }, outcomeStatus: 'fail' }) === false);

// ─── B. refine → re-gate → re-check loop ────────────────────────────────────
console.log(chalk.bold('\nB. refine → re-gate → re-check loop'));

{
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
  const result = await pr.runAcceptanceGateLoop(baseArgs({ initialOutcome: FAIL_OUTCOME }), deps);

  check('exactly one refine resume of the ORIGINAL dev session',
    claudeCalls.length === 1 && claudeCalls[0].sessionId === 'dev-sess-1' && claudeCalls[0].role === 'dev');
  check('refine prompt carries must_fix bullets + "(acceptance fix)" commit-suffix instruction',
    /Implement FVU generation/.test(claudeCalls[0].prompt) && /\(acceptance fix\)/.test(claudeCalls[0].prompt));
  check('validator gate re-runs exactly once; checker re-checks exactly once with the post-refine SHA',
    gateCalls.length === 1 && checkCalls.length === 1 && checkCalls[0].commitSha === 'newsha123');
  check('checker re-check is never given a sessionId override (verify-loop.js always spawns fresh)',
    !('sessionId' in checkCalls[0]));
  check('second consecutive fail → failed:true, attempts:1 (bounded by max_refine_attempts:1)',
    result.failed === true && result.attempts === 1);
}

{
  let claudeCalls = 0;
  const deps = {
    runClaude: async () => { claudeCalls += 1; return { session_id: 'x', is_error: false, result: 'done' }; },
    runValidatorGate: async () => ({ results: [], allPassed: true, hasFailures: false }),
    runAcceptanceCheck: async () => FAIL_OUTCOME,
    changedFilesSince: async () => ({ ok: true, files: [] }),
    getHeadSha: async () => 'sha',
  };
  const args = baseArgs({ initialOutcome: FAIL_OUTCOME });
  args.cfg.verify.max_refine_attempts = 3;
  const result = await pr.runAcceptanceGateLoop(args, deps);
  check('refine count never exceeds cfg.verify.max_refine_attempts (tested with 3)',
    claudeCalls === 3 && result.attempts === 3);
}

{
  let claudeCalls = 0;
  const deps = {
    runClaude: async () => { claudeCalls += 1; return { session_id: 'x', is_error: false, result: 'done' }; },
    runValidatorGate: async () => ({ results: [], allPassed: true, hasFailures: false }),
    runAcceptanceCheck: async () => PASS_OUTCOME,
    changedFilesSince: async () => ({ ok: true, files: [] }),
    getHeadSha: async () => 'sha',
  };
  const result = await pr.runAcceptanceGateLoop(baseArgs({ initialOutcome: PASS_OUTCOME }), deps);
  check('report-mode-shaped call (initial outcome already pass) never enters the loop — 0 refine calls',
    claudeCalls === 0 && result.failed === false && result.attempts === 0);
}

{
  let checkCalls = 0;
  const deps = {
    runClaude: async () => ({ session_id: 'dev-sess-2', is_error: false, result: 'done' }),
    runValidatorGate: async () => ({ results: [{ validator_name: 'default:npm-test', pass: false, output: 'boom' }], allPassed: false, hasFailures: true }),
    runAcceptanceCheck: async () => { checkCalls += 1; return PASS_OUTCOME; },
    changedFilesSince: async () => ({ ok: true, files: [] }),
    getHeadSha: async () => 'brokensha',
  };
  const result = await pr.runAcceptanceGateLoop(baseArgs({ initialOutcome: FAIL_OUTCOME }), deps);
  check('a validator-gate failure mid-refine terminates WITHOUT spending a checker call',
    checkCalls === 0 && result.failed === true);
}

// ─── C. terminal-failure marker + error_message shape ───────────────────────
console.log(chalk.bold('\nC. terminal-failure marker + error_message shape'));

{
  const deps = {
    runClaude: async () => ({ session_id: 'dev-sess-2', is_error: false, result: 'done' }),
    runValidatorGate: async () => ({ results: [], allPassed: true, hasFailures: false }),
    runAcceptanceCheck: async () => FAIL_OUTCOME,
    changedFilesSince: async () => ({ ok: true, files: [] }),
    getHeadSha: async () => 'newsha123',
  };
  const result = await pr.runAcceptanceGateLoop(baseArgs({ initialOutcome: FAIL_OUTCOME }), deps);
  const mustFix = result.outcome?.verdict?.must_fix || [];
  const markerBlock = `\n\n## Acceptance verification failed\n${mustFix.map((m) => `- ${m}`).join('\n')}\n`;
  check('the outcome returned on terminal failure carries must_fix bullets the runDev() call site appends verbatim under "## Acceptance verification failed"',
    result.failed === true && /## Acceptance verification failed/.test(markerBlock) && /Implement FVU generation/.test(markerBlock));
  const acceptLabel = 'Phase 5';
  const errorMessage = `${acceptLabel} committed but failed acceptance verification (after ${result.attempts} refine attempt(s)): ${mustFix.slice(0, 3).join('; ')}`;
  check('error_message (as constructed by the runDev() call site) starts with "Phase {n} committed but failed acceptance verification"',
    errorMessage.startsWith('Phase 5 committed but failed acceptance verification'));
}

// ─── D. runDev() wiring — source assertions ──────────────────────────────────
console.log(chalk.bold('\nD. runDev() wiring'));

const hookIdx = prSrc.indexOf('const verifyOutcome = await runPhaseAcceptanceCheck({');
const gateBlockIdx = prSrc.indexOf('if (shouldRunGateRefine({ verifyCfg: cfg.verify, outcomeStatus: verifyOutcome?.status })) {');
const completeIdx = prSrc.indexOf('markPhaseCompleted({ project: projectName, n: nextPhase, commit_sha });');
const pushIdx = prSrc.indexOf('const push = await pushBranch(workspaceDir, { branch });');
check('gate-mode block sits after the report-mode hook, before markPhaseCompleted and pushBranch',
  hookIdx > -1 && gateBlockIdx > -1 && completeIdx > -1 && pushIdx > -1
  && hookIdx < gateBlockIdx && gateBlockIdx < completeIdx && gateBlockIdx < pushIdx);

const gateBlockSrc = prSrc.slice(gateBlockIdx, prSrc.indexOf("if (!fix) {\n        markPhaseCompleted", gateBlockIdx));
check('terminal failure appends to validationMarkerPath (the SAME marker the validator gate writes) — never a new marker file',
  /fs\.appendFile\(validationMarkerPath, `\\n\\n## Acceptance verification failed\\n\$\{bullets\}\\n`/.test(gateBlockSrc));
check('terminal failure: upsertPhase(failed), is_error:true, no pushBranch call, git_result.ok:false',
  /upsertPhase\(\{ project: projectName, n: nextPhase, status: 'failed' \}\);/.test(gateBlockSrc)
  && /is_error: true,/.test(gateBlockSrc)
  && /git_result: \{ ok: false, branch, commit_sha, error: 'acceptance-verification-failed' \}/.test(gateBlockSrc)
  && !/pushBranch/.test(gateBlockSrc));
check('refine resumes sessionId: result.session_id (per the phase spec), passes cfg through unmodified (Opus escalation carries into refine)',
  /sessionId: result\.session_id \|\| null,/.test(gateBlockSrc)
  && /cfg, projectName, projDir, workspaceDir, phaseMeta: phaseMeta \|\| null, fix,/.test(gateBlockSrc));

// routeDevFailure itself must be UNTOUCHED — this phase must not add any
// acceptance-verification-specific branching into the routing decision.
const arSrc = readSrc('src/auto-runner.js');
const routeDevFailureSrc = arSrc.slice(arSrc.indexOf('export function routeDevFailure('), arSrc.indexOf('\n}\n', arSrc.indexOf('export function routeDevFailure(')));
check('routeDevFailure() has ZERO acceptance-verification-specific branching — the new failure mode flows through unmodified',
  !/acceptance/i.test(routeDevFailureSrc) && !/verify/i.test(routeDevFailureSrc));

// ─── E. error-classifier.js ─────────────────────────────────────────────────
console.log(chalk.bold('\nE. error-classifier.js'));

check('"...failed acceptance verification..." classifies as VALIDATION, never ORCHESTRATOR_BUG',
  classifyError(new Error('Phase 5 committed but failed acceptance verification (after 1 refine attempt(s)): x')).kind === ERROR_KINDS.VALIDATION);
check('VALIDATION kind is non-recoverable (maxAttempts:0) — routes straight to escalation, never retried by the healer',
  classifyError('failed acceptance verification').recoverable === false
  && classifyError('failed acceptance verification').maxAttempts === 0);
check('error-classifier.js source carries the new pattern literally',
  /\/failed acceptance verification\/i/.test(readSrc('src/lib/error-classifier.js')));

// ─── F. checker routing independence — no session/role clobber ─────────────
console.log(chalk.bold('\nF. checker routing independence'));

{
  const claudeCalls = [];
  const deps = {
    runClaude: async (opts) => { claudeCalls.push(opts); return { session_id: 'dev-sess-2', is_error: false, result: 'done' }; },
    runValidatorGate: async () => ({ results: [], allPassed: true, hasFailures: false }),
    runAcceptanceCheck: async () => PASS_OUTCOME,
    changedFilesSince: async () => ({ ok: true, files: [] }),
    getHeadSha: async () => 'sha',
  };
  const args = baseArgs({ initialOutcome: FAIL_OUTCOME });
  args.cfg.model = 'claude-opus-4-8'; // an already-escalated phase
  await pr.runAcceptanceGateLoop(args, deps);
  check('refine (dev) call inherits the phase\'s already-escalated cfg.model verbatim',
    claudeCalls[0].cfg.model === 'claude-opus-4-8');
}
check('runAcceptanceCheck (verify-loop.js) resolves the checker model from cfg.models[\'acceptance-check\'] independent of cfg.model — unchanged since Phase 3',
  /model: cfg\.models\?\.\['acceptance-check'\]/.test(readSrc('src/lib/verify-loop.js')));
check('runAcceptanceCheck always spawns role:null, sessionId:null — unchanged since Phase 3 (no clobber of guide_session_id/last_dev_session_id)',
  /role: null,/.test(readSrc('src/lib/verify-loop.js')) && /sessionId: null,/.test(readSrc('src/lib/verify-loop.js')));

// ─── G. version ──────────────────────────────────────────────────────────────
console.log(chalk.bold('\nG. version'));
const pkg = JSON.parse(readSrc('package.json'));
check('package.json version is 0.15.0', pkg.version === '0.15.0', pkg.version);

console.log('');
if (failed === 0) {
  console.log(chalk.green.bold(`✓ All ${passed} checks passed.`));
  process.exit(0);
} else {
  console.log(chalk.red.bold(`✗ ${failed} failed, ${passed} passed.`));
  process.exit(1);
}
