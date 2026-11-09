// Tests for the acceptance-check hook wired into runDev() (brief P2 part
// 3/3 — report mode). Covers:
//   A. shouldRunAcceptanceCheck  — pure skip/run decision (mode:off, fixes
//      excluded, no-criteria skip)
//   B. formatVerifyOutcomeLine   — exact log-line wording for fail/
//      inconclusive/pass
//   C. runPhaseAcceptanceCheck   — wiring: calls the injected checker with
//      the right args, or doesn't call it at all when skipped
//   D. end-to-end via the REAL verify-loop.js runAcceptanceCheck (only its
//      innermost runClaude is faked) — proves verify.json lands on disk,
//      is ajv-valid, and the role:null / tools-sandbox invariants survive
//      the full call chain from phase-runner's wrapper down
//   E. source assertions — hook placement relative to the validator gate /
//      markPhaseCompleted / pushBranch, and that the hook touches nothing
//      on `result` besides `verify_outcome` (return-shape regression proxy)
//   F. QL-7 — parseCriteriaSelfAssessment / selectPriorityCriteria (pure),
//      plus runPhaseAcceptanceCheck's report-read-and-thread wiring
//   G. phase-26 — shouldFailClosedOnInconclusive / maybeRecordInconclusiveLesson:
//      honoring verify.fail_open on an 'inconclusive' checker outcome, plus
//      source assertions pinning the runDev() wiring (mirrors section E)
//
// No real `claude` subprocess is ever spawned.
//
// Run with: node --test src/lib/verify-report-mode.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Ajv from 'ajv';

process.env.DB_PATH = ':memory:';

const {
  shouldRunAcceptanceCheck,
  shouldRunAcceptancePanel,
  formatVerifyOutcomeLine,
  runPhaseAcceptanceCheck,
  maybeRecordReportModeVerifyFailLesson,
  shouldFailClosedOnInconclusive,
  maybeRecordInconclusiveLesson,
  parseCriteriaSelfAssessment,
  selectPriorityCriteria,
} = await import('./phase-runner.js');
const { runAcceptanceCheck } = await import('./verify-loop.js');
const { readLessons } = await import('./lessons.js');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERDICT_SCHEMA = JSON.parse(readFileSync(path.join(REPO_ROOT, 'config', 'schemas', 'verify.schema.json'), 'utf-8'));
const ajv = new Ajv({ allErrors: true, strict: false });
const validateVerdict = ajv.compile(VERDICT_SCHEMA);

const PHASE_META = {
  n: 5,
  title: 'FVU file builder',
  goal: 'Build the NSDL FVU export.',
  acceptance_criteria: ['Generates a valid FVU file', 'Rejects malformed challans'],
  files_expected: ['backend/services/fvuBuilder.js'],
};

function makeProjDir() {
  const d = mkdtempSync(path.join(tmpdir(), 'aorch-verify-report-mode-'));
  mkdirSync(path.join(d, '.guide'), { recursive: true });
  mkdirSync(path.join(d, 'workspace'), { recursive: true });
  return d;
}

const VALID_VERDICT_JSON = JSON.stringify({
  verdict: 'pass',
  criteria: [
    { criterion: 'Generates a valid FVU file', status: 'met', evidence: 'backend/services/fvuBuilder.js:20' },
    { criterion: 'Rejects malformed challans', status: 'met', evidence: 'backend/services/fvuBuilder.js:44' },
  ],
});

// ─── A. shouldRunAcceptanceCheck — pure skip/run decision ───────────────────
//
// phase-30: `verify.include_fixes` is now three-valued (false | true |
// 'major+', default 'major+') and fixes are subject to the SAME
// hasCriteria check phases always had (previously unreachable for fixes,
// since the old unconditional include_fixes:false default excluded them
// before hasCriteria was ever consulted).

test('shouldRunAcceptanceCheck: mode "off" skips regardless of fix/criteria', () => {
  assert.equal(shouldRunAcceptanceCheck({ verifyCfg: { mode: 'off' }, fix: null, hasCriteria: true }).run, false);
  assert.equal(shouldRunAcceptanceCheck({ verifyCfg: { mode: 'off' }, fix: { round: 1, n: 1 }, hasCriteria: true }).run, false);
});

test('shouldRunAcceptanceCheck: include_fixes:false skips every fix regardless of severity/criteria', () => {
  const decision = shouldRunAcceptanceCheck({ verifyCfg: { mode: 'report', include_fixes: false }, fix: { round: 2, n: 3 }, hasCriteria: true, severity: 'critical' });
  assert.equal(decision.run, false);
  assert.match(decision.skipReason, /include_fixes=false/);
});

test('shouldRunAcceptanceCheck: include_fixes:true verifies every severity (critical/major/minor/missing), subject only to the criteria check', () => {
  for (const severity of ['critical', 'major', 'minor', undefined]) {
    const decision = shouldRunAcceptanceCheck({ verifyCfg: { mode: 'report', include_fixes: true }, fix: { round: 2, n: 3 }, hasCriteria: true, severity });
    assert.equal(decision.run, true, `severity ${severity} should run under include_fixes:true`);
  }
});

test('shouldRunAcceptanceCheck: include_fixes absent defaults to "major+" (fix-checking is ON by default as of phase-30)', () => {
  const decision = shouldRunAcceptanceCheck({ verifyCfg: { mode: 'report' }, fix: { round: 2, n: 3 }, hasCriteria: true, severity: 'major' });
  assert.equal(decision.run, true);
});

test('shouldRunAcceptanceCheck: "major+" verifies critical and major fixes', () => {
  assert.equal(shouldRunAcceptanceCheck({ verifyCfg: { mode: 'report', include_fixes: 'major+' }, fix: { round: 2, n: 3 }, hasCriteria: true, severity: 'critical' }).run, true);
  assert.equal(shouldRunAcceptanceCheck({ verifyCfg: { mode: 'report', include_fixes: 'major+' }, fix: { round: 2, n: 3 }, hasCriteria: true, severity: 'major' }).run, true);
});

test('shouldRunAcceptanceCheck: "major+" skips minor fixes with a severity-specific reason', () => {
  const decision = shouldRunAcceptanceCheck({ verifyCfg: { mode: 'report', include_fixes: 'major+' }, fix: { round: 2, n: 3 }, hasCriteria: true, severity: 'minor' });
  assert.equal(decision.run, false);
  assert.match(decision.skipReason, /minor/);
});

test('shouldRunAcceptanceCheck: "major+" treats a missing severity as major — verifies it, does not skip', () => {
  const decision = shouldRunAcceptanceCheck({ verifyCfg: { mode: 'report', include_fixes: 'major+' }, fix: { round: 2, n: 3 }, hasCriteria: true, severity: undefined });
  assert.equal(decision.run, true);
});

test('shouldRunAcceptanceCheck: a fix with no acceptance_criteria skips with a criteria-specific reason, independent of include_fixes', () => {
  const decision = shouldRunAcceptanceCheck({ verifyCfg: { mode: 'report', include_fixes: true }, fix: { round: 2, n: 3 }, hasCriteria: false, severity: 'critical' });
  assert.equal(decision.run, false);
  assert.match(decision.skipReason, /acceptance_criteria/);
});

test('shouldRunAcceptanceCheck: a phase with no acceptance_criteria is skipped (skip_when_no_criteria defaults true)', () => {
  const decision = shouldRunAcceptanceCheck({ verifyCfg: { mode: 'report' }, fix: null, hasCriteria: false });
  assert.equal(decision.run, false);
  assert.match(decision.skipReason, /no acceptance_criteria/);
});

test('shouldRunAcceptanceCheck: skip_when_no_criteria:false forces the check to run even with no criteria', () => {
  const decision = shouldRunAcceptanceCheck({ verifyCfg: { mode: 'report', skip_when_no_criteria: false }, fix: null, hasCriteria: false });
  assert.equal(decision.run, true);
});

test('shouldRunAcceptanceCheck: a phase with criteria runs under the default (mode absent → "report")', () => {
  const decision = shouldRunAcceptanceCheck({ verifyCfg: {}, fix: null, hasCriteria: true });
  assert.equal(decision.run, true);
  assert.equal(decision.skipReason, null);
});

test('shouldRunAcceptanceCheck: development cadence skips only routine non-periodic phases', () => {
  const verifyCfg = { mode: 'gate', cadence: { mode: 'checkpoints', every_n_phases: 3 } };
  const skipped = shouldRunAcceptanceCheck({
    verifyCfg, fix: null, hasCriteria: true, phaseOrdinal: 2,
    isFinalPhase: false, complexity: 'medium', checkpoint: 'routine',
  });
  assert.equal(skipped.run, false);
  assert.match(skipped.skipReason, /deterministic validators/);

  assert.equal(shouldRunAcceptanceCheck({
    verifyCfg, fix: null, hasCriteria: true, phaseOrdinal: 3,
    isFinalPhase: false, complexity: 'medium', checkpoint: 'routine',
  }).run, true, 'periodic phase keeps the checker');
});

test('shouldRunAcceptanceCheck: final, high-risk, and checkpoint phases always run under development cadence', () => {
  const verifyCfg = { mode: 'gate', cadence: { mode: 'checkpoints', every_n_phases: 10 } };
  const base = { verifyCfg, fix: null, hasCriteria: true, phaseOrdinal: 2 };
  assert.equal(shouldRunAcceptanceCheck({ ...base, isFinalPhase: true, complexity: 'low' }).run, true);
  assert.equal(shouldRunAcceptanceCheck({ ...base, complexity: 'high' }).run, true);
  assert.equal(shouldRunAcceptanceCheck({ ...base, complexity: 'low', checkpoint: 'schema' }).run, true);
});

test('shouldRunAcceptanceCheck: fix verification ignores phase cadence', () => {
  const decision = shouldRunAcceptanceCheck({
    verifyCfg: { mode: 'gate', include_fixes: true, cadence: { mode: 'checkpoints', every_n_phases: 99 } },
    fix: { round: 1, n: 1 }, hasCriteria: true, severity: 'major', phaseOrdinal: 1,
  });
  assert.equal(decision.run, true);
});

// ─── B. formatVerifyOutcomeLine — exact log-line wording ────────────────────

test('formatVerifyOutcomeLine: fail → "acceptance verify FAILED (report-only) — X/Y criteria unmet"', () => {
  const outcome = {
    status: 'fail',
    verdict: {
      verdict: 'fail',
      criteria: [
        { criterion: 'a', status: 'unmet' },
        { criterion: 'b', status: 'met' },
      ],
      must_fix: ['fix a'],
    },
  };
  const line = formatVerifyOutcomeLine('Phase 5', outcome);
  assert.equal(line.level, 'warn');
  assert.equal(line.text, '⚠ Phase 5: acceptance verify FAILED (report-only) — 1/2 criteria unmet');
});

test('formatVerifyOutcomeLine: inconclusive → warns and never mentions blocking completion', () => {
  const outcome = { status: 'inconclusive', verdict: null, errors: ['spawn timed out'] };
  const line = formatVerifyOutcomeLine('Phase 5', outcome);
  assert.equal(line.level, 'warn');
  assert.match(line.text, /inconclusive/);
  assert.match(line.text, /spawn timed out/);
  assert.match(line.text, /not blocking completion/);
});

test('formatVerifyOutcomeLine: pass → info line, no warning', () => {
  const outcome = { status: 'pass', verdict: { verdict: 'pass', criteria: [{ criterion: 'a', status: 'met' }] } };
  const line = formatVerifyOutcomeLine('Phase 5', outcome);
  assert.equal(line.level, 'info');
  assert.equal(line.text, '✓ Phase 5: acceptance verify passed');
});

// ─── C. runPhaseAcceptanceCheck — wiring via the deps seam ──────────────────

test('runPhaseAcceptanceCheck: skipped phase (no criteria) never calls the checker', async () => {
  const projDir = makeProjDir();
  let calls = 0;
  const deps = { runAcceptanceCheck: async () => { calls += 1; return { status: 'pass' }; } };
  const result = await runPhaseAcceptanceCheck({
    cfg: { verify: { mode: 'report' } },
    projectName: 'demo', projDir, workspaceDir: path.join(projDir, 'workspace'),
    phaseMeta: { n: 5, title: 'no criteria phase', acceptance_criteria: [] },
    fix: null, preSha: 'abc1234', commitSha: 'def5678', nextPhase: 5,
  }, deps);
  assert.equal(calls, 0);
  assert.equal(result, null);
});

test('runPhaseAcceptanceCheck: a fix run DOES call the checker under default config as of phase-30 (include_fixes defaults to "major+", and a resolve failure fails OPEN rather than skipping)', async () => {
  const projDir = makeProjDir(); // no round plan on disk — resolveFixPhaseMeta fails open (hasCriteria:true)
  let calls = 0;
  const deps = { runAcceptanceCheck: async () => { calls += 1; return { status: 'pass', verdict: { verdict: 'pass', criteria: [] } }; } };
  const result = await runPhaseAcceptanceCheck({
    cfg: { verify: { mode: 'report' } },
    projectName: 'demo', projDir, workspaceDir: path.join(projDir, 'workspace'),
    phaseMeta: false, fix: { round: 1, n: 2, title: 'some fix' }, preSha: 'abc1234', commitSha: 'def5678', nextPhase: null,
  }, deps);
  assert.equal(calls, 1);
  assert.equal(result.status, 'pass');
});

test('runPhaseAcceptanceCheck: verify.include_fixes:false still skips a fix run entirely (explicit opt-out survives the phase-30 default flip)', async () => {
  const projDir = makeProjDir();
  let calls = 0;
  const deps = { runAcceptanceCheck: async () => { calls += 1; return { status: 'pass' }; } };
  const result = await runPhaseAcceptanceCheck({
    cfg: { verify: { mode: 'report', include_fixes: false } },
    projectName: 'demo', projDir, workspaceDir: path.join(projDir, 'workspace'),
    phaseMeta: false, fix: { round: 1, n: 2, title: 'some fix' }, preSha: 'abc1234', commitSha: 'def5678', nextPhase: null,
  }, deps);
  assert.equal(calls, 0);
  assert.equal(result, null);
});

test('runPhaseAcceptanceCheck: a fix with a genuinely empty acceptance_criteria list in its round-plan entry is skipped (dim log), even though the round plan itself resolved fine', async () => {
  const projDir = makeProjDir();
  const roundDir = path.join(projDir, '.guide', 'bug-rounds', 'round-1');
  mkdirSync(roundDir, { recursive: true });
  writeFileSync(path.join(roundDir, 'plan.json'), JSON.stringify({
    fixes: [{ n: 2, title: 'some fix', goal: 'g', severity: 'critical', acceptance_criteria: [], files_likely: [] }],
  }), 'utf-8');
  let calls = 0;
  const deps = { runAcceptanceCheck: async () => { calls += 1; return { status: 'pass' }; } };
  const result = await runPhaseAcceptanceCheck({
    cfg: { verify: { mode: 'report' } },
    projectName: 'demo', projDir, workspaceDir: path.join(projDir, 'workspace'),
    phaseMeta: null, fix: { round: 1, n: 2, title: 'some fix' }, preSha: 'abc1234', commitSha: 'def5678', nextPhase: null,
  }, deps);
  assert.equal(calls, 0, 'a resolved entry with an explicitly empty acceptance_criteria skips, unlike an unresolvable round plan (fail-open)');
  assert.equal(result, null);
});

test('runPhaseAcceptanceCheck: "major+" (explicit) skips a minor-severity fix even when it has criteria', async () => {
  const projDir = makeProjDir();
  const roundDir = path.join(projDir, '.guide', 'bug-rounds', 'round-1');
  mkdirSync(roundDir, { recursive: true });
  writeFileSync(path.join(roundDir, 'plan.json'), JSON.stringify({
    fixes: [{ n: 2, title: 'some fix', goal: 'g', severity: 'minor', acceptance_criteria: ['tidy up logging'], files_likely: ['a.js'] }],
  }), 'utf-8');
  let calls = 0;
  const deps = { runAcceptanceCheck: async () => { calls += 1; return { status: 'pass' }; } };
  const result = await runPhaseAcceptanceCheck({
    cfg: { verify: { mode: 'report', include_fixes: 'major+' } },
    projectName: 'demo', projDir, workspaceDir: path.join(projDir, 'workspace'),
    phaseMeta: null, fix: { round: 1, n: 2, title: 'some fix' }, preSha: 'abc1234', commitSha: 'def5678', nextPhase: null,
  }, deps);
  assert.equal(calls, 0);
  assert.equal(result, null);
});

test('runPhaseAcceptanceCheck: mode "off" never calls the checker even with criteria present', async () => {
  const projDir = makeProjDir();
  let calls = 0;
  const deps = { runAcceptanceCheck: async () => { calls += 1; return { status: 'pass' }; } };
  const result = await runPhaseAcceptanceCheck({
    cfg: { verify: { mode: 'off' } },
    projectName: 'demo', projDir, workspaceDir: path.join(projDir, 'workspace'),
    phaseMeta: PHASE_META, fix: null, preSha: 'abc1234', commitSha: 'def5678', nextPhase: 5,
  }, deps);
  assert.equal(calls, 0);
  assert.equal(result, null);
});

test('runPhaseAcceptanceCheck: a checkable phase calls the checker with preSha/commitSha reused (not recomputed) and no role/sessionId override', async () => {
  const projDir = makeProjDir();
  const captured = [];
  const deps = {
    runAcceptanceCheck: async (args) => { captured.push(args); return { status: 'pass', verdict: { verdict: 'pass', criteria: [] } }; },
  };
  const result = await runPhaseAcceptanceCheck({
    cfg: { verify: { mode: 'report' }, model: 'claude-sonnet-5' },
    projectName: 'demo', projDir, workspaceDir: path.join(projDir, 'workspace'),
    phaseMeta: PHASE_META, fix: null, preSha: 'abc1234', commitSha: 'def5678', nextPhase: 5,
  }, deps);
  assert.equal(captured.length, 1);
  const call = captured[0];
  assert.equal(call.preSha, 'abc1234');
  assert.equal(call.commitSha, 'def5678');
  assert.equal(call.nextPhase, 5);
  assert.equal(call.phaseMeta, PHASE_META);
  assert.ok(!('role' in call), 'call site does not override role');
  assert.ok(!('sessionId' in call), 'call site does not override sessionId');
  assert.deepEqual(result, { status: 'pass', verdict: { verdict: 'pass', criteria: [] } }, 'outcome is passed through unchanged');
});

test('runPhaseAcceptanceCheck: an inconclusive outcome is still returned (report mode never blocks — no throw)', async () => {
  const projDir = makeProjDir();
  const deps = { runAcceptanceCheck: async () => ({ status: 'inconclusive', verdict: null, errors: ['boom'] }) };
  const result = await runPhaseAcceptanceCheck({
    cfg: { verify: { mode: 'report', fail_open: true } },
    projectName: 'demo', projDir, workspaceDir: path.join(projDir, 'workspace'),
    phaseMeta: PHASE_META, fix: null, preSha: 'abc1234', commitSha: 'def5678', nextPhase: 5,
  }, deps);
  assert.equal(result.status, 'inconclusive');
});

// ─── D. end-to-end via the REAL verify-loop.js runAcceptanceCheck ───────────
// Only the innermost runClaude is faked — everything else (skip decision,
// prompt build, ajv parse, disk write, tool sandbox construction) is the
// real production code path.

test('runPhaseAcceptanceCheck + real runAcceptanceCheck: writes an ajv-valid verify.json next to the phase report, sandboxed and session-safe end-to-end', async () => {
  const projDir = makeProjDir();
  const captured = [];
  const fakeRunClaude = async (opts) => {
    captured.push(opts);
    return { result: VALID_VERDICT_JSON, session_id: 'sess-checker-1', is_error: false };
  };
  const deps = {
    runAcceptanceCheck: (args) => runAcceptanceCheck(args, { runClaude: fakeRunClaude }),
  };

  const cfg = {
    verify: { mode: 'report' },
    model: 'claude-sonnet-5',
    models: { 'acceptance-check': 'claude-sonnet-5', 'dev-execution': 'claude-sonnet-5' },
    tools: { allowed_default: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'], permission_mode: 'acceptEdits' },
    phases: {},
  };

  const outcome = await runPhaseAcceptanceCheck({
    cfg, projectName: 'demo', projDir, workspaceDir: path.join(projDir, 'workspace'),
    phaseMeta: PHASE_META, fix: null, preSha: 'abc1234', commitSha: 'def5678', nextPhase: 5,
  }, deps);

  assert.equal(outcome.status, 'pass');

  // verify.json lands next to the phase report, and is ajv-valid.
  const verdictFile = path.join(projDir, '.guide', 'phases', '05-fvu-file-builder', 'verify.json');
  assert.ok(existsSync(verdictFile), 'verify.json written to the phase dir');
  const written = JSON.parse(readFileSync(verdictFile, 'utf-8'));
  assert.ok(validateVerdict(written), `written verify.json is ajv-valid: ${JSON.stringify(validateVerdict.errors)}`);

  // The checker call that produced it never touches session bookkeeping and
  // cannot mutate the workspace — proven at the innermost runClaude call,
  // reached through phase-runner's wrapper + the real verify-loop.js.
  assert.equal(captured.length, 1);
  const call = captured[0];
  assert.equal(call.role, null, 'role:null end-to-end — guide_session_id/last_dev_session_id untouched');
  assert.equal(call.sessionId, null, 'fresh session — never resumes dev/guide context');
  assert.equal(call.task, 'acceptance-check');
  const tools = call.cfg.tools.allowed_default;
  assert.ok(!tools.includes('Write'), 'tools-sandbox cfg clone strips Write');
  assert.ok(!tools.includes('Edit'), 'tools-sandbox cfg clone strips Edit');
  assert.ok(!tools.includes('Bash'), 'tools-sandbox cfg clone strips unrestricted Bash');
  // The ORIGINAL cfg passed to runPhaseAcceptanceCheck is untouched (a clone
  // was sandboxed, not the caller's object) — the dev-execution call right
  // after this in runDev() must still see the full tool set.
  assert.deepEqual(cfg.tools.allowed_default, ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']);
});

test('runPhaseAcceptanceCheck + real runAcceptanceCheck: a failing verdict is recorded to disk but the call still returns normally (report mode never throws)', async () => {
  const projDir = makeProjDir();
  const failJson = JSON.stringify({
    verdict: 'fail',
    criteria: [{ criterion: 'Generates a valid FVU file', status: 'unmet', evidence: 'no such function found' }],
    must_fix: ['Implement FVU generation'],
  });
  const deps = {
    runAcceptanceCheck: (args) => runAcceptanceCheck(args, { runClaude: async () => ({ result: failJson, session_id: 's1', is_error: false }) }),
  };
  const cfg = { verify: { mode: 'report' }, models: { 'acceptance-check': 'claude-sonnet-5' }, tools: { allowed_default: ['Read', 'Write'] }, phases: {} };
  const outcome = await runPhaseAcceptanceCheck({
    cfg, projectName: 'demo', projDir, workspaceDir: path.join(projDir, 'workspace'),
    phaseMeta: PHASE_META, fix: null, preSha: 'abc1234', commitSha: 'def5678', nextPhase: 5,
  }, deps);
  assert.equal(outcome.status, 'fail');
  const verdictFile = path.join(projDir, '.guide', 'phases', '05-fvu-file-builder', 'verify.json');
  assert.ok(existsSync(verdictFile));
  assert.ok(validateVerdict(JSON.parse(readFileSync(verdictFile, 'utf-8'))));
});

// ─── H. shouldRunAcceptancePanel / runPhaseAcceptanceCheck panel routing (phase-29) ──

test('shouldRunAcceptancePanel: disabled by default (panel cfg absent) — never true regardless of complexity', () => {
  assert.equal(shouldRunAcceptancePanel({ verifyCfg: {}, fix: null, complexity: 'critical' }), false);
});

test('shouldRunAcceptancePanel: enabled:true but complexity does not match the trigger (default "critical") — false', () => {
  const verifyCfg = { panel: { enabled: true } };
  assert.equal(shouldRunAcceptancePanel({ verifyCfg, fix: null, complexity: 'high' }), false);
  assert.equal(shouldRunAcceptancePanel({ verifyCfg, fix: null, complexity: 'medium' }), false);
});

test('shouldRunAcceptancePanel: enabled:true and complexity matches the default trigger ("critical") — true', () => {
  const verifyCfg = { panel: { enabled: true } };
  assert.equal(shouldRunAcceptancePanel({ verifyCfg, fix: null, complexity: 'critical' }), true);
});

test('shouldRunAcceptancePanel: a fix is NEVER routed to the panel, even with enabled:true and a matching complexity', () => {
  const verifyCfg = { panel: { enabled: true } };
  assert.equal(shouldRunAcceptancePanel({ verifyCfg, fix: { round: 1, n: 1 }, complexity: 'critical' }), false);
});

test('shouldRunAcceptancePanel: honors a custom panel.trigger', () => {
  const verifyCfg = { panel: { enabled: true, trigger: 'high' } };
  assert.equal(shouldRunAcceptancePanel({ verifyCfg, fix: null, complexity: 'high' }), true);
  assert.equal(shouldRunAcceptancePanel({ verifyCfg, fix: null, complexity: 'critical' }), false);
});

test('runPhaseAcceptanceCheck: panel disabled (default) — a critical-complexity phase still calls the single checker (deps.runAcceptanceCheck), never deps.runAcceptancePanel', async () => {
  const projDir = makeProjDir();
  let singleCalls = 0;
  let panelCalls = 0;
  const deps = {
    runAcceptanceCheck: async () => { singleCalls += 1; return { status: 'pass', verdict: { verdict: 'pass', criteria: [] } }; },
    runAcceptancePanel: async () => { panelCalls += 1; return { status: 'pass', verdict: { verdict: 'pass', criteria: [] } }; },
  };
  await runPhaseAcceptanceCheck({
    cfg: { verify: { mode: 'report' } },
    projectName: 'demo', projDir, workspaceDir: path.join(projDir, 'workspace'),
    phaseMeta: PHASE_META, fix: null, preSha: 'abc1234', commitSha: 'def5678', nextPhase: 5,
    complexity: 'critical',
  }, deps);
  assert.equal(singleCalls, 1);
  assert.equal(panelCalls, 0);
});

test('runPhaseAcceptanceCheck: panel enabled + complexity matches trigger — calls deps.runAcceptancePanel instead of deps.runAcceptanceCheck', async () => {
  const projDir = makeProjDir();
  let singleCalls = 0;
  let panelCalls = 0;
  const deps = {
    runAcceptanceCheck: async () => { singleCalls += 1; return { status: 'pass', verdict: { verdict: 'pass', criteria: [] } }; },
    runAcceptancePanel: async () => { panelCalls += 1; return { status: 'pass', verdict: { verdict: 'pass', criteria: [] } }; },
  };
  const outcome = await runPhaseAcceptanceCheck({
    cfg: { verify: { mode: 'report', panel: { enabled: true, trigger: 'critical' } } },
    projectName: 'demo', projDir, workspaceDir: path.join(projDir, 'workspace'),
    phaseMeta: PHASE_META, fix: null, preSha: 'abc1234', commitSha: 'def5678', nextPhase: 5,
    complexity: 'critical',
  }, deps);
  assert.equal(singleCalls, 0);
  assert.equal(panelCalls, 1);
  assert.equal(outcome.status, 'pass');
});

test('runPhaseAcceptanceCheck: panel enabled but complexity is "high" (not "critical") — falls back to the single checker', async () => {
  const projDir = makeProjDir();
  let singleCalls = 0;
  let panelCalls = 0;
  const deps = {
    runAcceptanceCheck: async () => { singleCalls += 1; return { status: 'pass', verdict: { verdict: 'pass', criteria: [] } }; },
    runAcceptancePanel: async () => { panelCalls += 1; return { status: 'pass', verdict: { verdict: 'pass', criteria: [] } }; },
  };
  await runPhaseAcceptanceCheck({
    cfg: { verify: { mode: 'report', panel: { enabled: true, trigger: 'critical' } } },
    projectName: 'demo', projDir, workspaceDir: path.join(projDir, 'workspace'),
    phaseMeta: PHASE_META, fix: null, preSha: 'abc1234', commitSha: 'def5678', nextPhase: 5,
    complexity: 'high',
  }, deps);
  assert.equal(singleCalls, 1);
  assert.equal(panelCalls, 0);
});

test('runPhaseAcceptanceCheck: a fix is never routed to the panel even with panel.enabled:true and a matching complexity (phases-only invariant, phase 30 relies on it)', async () => {
  const projDir = makeProjDir();
  let singleCalls = 0;
  let panelCalls = 0;
  const deps = {
    runAcceptanceCheck: async () => { singleCalls += 1; return { status: 'pass', verdict: { verdict: 'pass', criteria: [] } }; },
    runAcceptancePanel: async () => { panelCalls += 1; return { status: 'pass', verdict: { verdict: 'pass', criteria: [] } }; },
  };
  await runPhaseAcceptanceCheck({
    cfg: { verify: { mode: 'report', include_fixes: true, panel: { enabled: true, trigger: 'critical' } } },
    projectName: 'demo', projDir, workspaceDir: path.join(projDir, 'workspace'),
    phaseMeta: false, fix: { round: 1, n: 2, title: 'some fix' }, preSha: 'abc1234', commitSha: 'def5678', nextPhase: null,
    complexity: 'critical',
  }, deps);
  assert.equal(singleCalls, 1, 'a fix still runs the single checker (include_fixes:true)');
  assert.equal(panelCalls, 0, 'but never the panel — fixes are excluded by design');
});

// ─── F. maybeRecordReportModeVerifyFailLesson — report-mode lesson capture ──
// (brief FR1 gap-fix, phase 13) — the checker's effective-fail outcome must
// land in .guide/lessons.jsonl even when verify.mode is "report" (the
// default), since report mode never enters the gate-mode refine loop that
// used to be the only place a verify-fail lesson got recorded
// (see verify-gate-mode.test.mjs for the gate-mode dedup regression tests).

test('maybeRecordReportModeVerifyFailLesson: report mode + fail outcome → exactly one verify-fail lesson on disk, sourced "phase-runner:acceptance-check-report-mode"', async () => {
  const projDir = makeProjDir();
  const verifyOutcome = {
    status: 'fail',
    verdict: {
      verdict: 'fail',
      criteria: [{ criterion: 'Generates a valid FVU file', status: 'unmet', evidence: 'no such function found' }],
      must_fix: ['Implement FVU generation'],
    },
  };
  const recorded = await maybeRecordReportModeVerifyFailLesson({
    cfg: { verify: { mode: 'report' } }, projDir, phaseMeta: PHASE_META, fix: null, nextPhase: 5, verifyOutcome,
  });
  assert.equal(recorded, true);
  const lessons = await readLessons(projDir);
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0].kind, 'verify-fail');
  assert.equal(lessons[0].source, 'phase-runner:acceptance-check-report-mode');
  assert.equal(lessons[0].phase, 5);
  assert.equal(lessons[0].fix, null);
  assert.match(lessons[0].lesson, /Implement FVU generation/);
  assert.deepEqual(lessons[0].files, PHASE_META.files_expected);
});

test('maybeRecordReportModeVerifyFailLesson: report mode (default, verify cfg absent) + fail outcome still records', async () => {
  const projDir = makeProjDir();
  const recorded = await maybeRecordReportModeVerifyFailLesson({
    cfg: {}, projDir, phaseMeta: PHASE_META, fix: null, nextPhase: 5,
    verifyOutcome: { status: 'fail', verdict: { verdict: 'fail', criteria: [], must_fix: ['fix it'] } },
  });
  assert.equal(recorded, true);
  const lessons = await readLessons(projDir);
  assert.equal(lessons.length, 1);
});

test('maybeRecordReportModeVerifyFailLesson: report mode + pass outcome → no lesson recorded', async () => {
  const projDir = makeProjDir();
  const recorded = await maybeRecordReportModeVerifyFailLesson({
    cfg: { verify: { mode: 'report' } }, projDir, phaseMeta: PHASE_META, fix: null, nextPhase: 5,
    verifyOutcome: { status: 'pass', verdict: { verdict: 'pass', criteria: [] } },
  });
  assert.equal(recorded, false);
  const lessons = await readLessons(projDir);
  assert.equal(lessons.length, 0);
});

test('maybeRecordReportModeVerifyFailLesson: report mode + inconclusive outcome → no lesson recorded', async () => {
  const projDir = makeProjDir();
  const recorded = await maybeRecordReportModeVerifyFailLesson({
    cfg: { verify: { mode: 'report' } }, projDir, phaseMeta: PHASE_META, fix: null, nextPhase: 5,
    verifyOutcome: { status: 'inconclusive', verdict: null, errors: ['boom'] },
  });
  assert.equal(recorded, false);
  const lessons = await readLessons(projDir);
  assert.equal(lessons.length, 0);
});

test('maybeRecordReportModeVerifyFailLesson: null verifyOutcome (skipped checker) is a no-op', async () => {
  const projDir = makeProjDir();
  const recorded = await maybeRecordReportModeVerifyFailLesson({
    cfg: { verify: { mode: 'report' } }, projDir, phaseMeta: PHASE_META, fix: null, nextPhase: 5, verifyOutcome: null,
  });
  assert.equal(recorded, false);
  assert.equal((await readLessons(projDir)).length, 0);
});

test('maybeRecordReportModeVerifyFailLesson: gate mode + fail outcome never records here — deferred to the refine loop\'s own terminal check (mode isolation, see verify-gate-mode.test.mjs)', async () => {
  const projDir = makeProjDir();
  const recorded = await maybeRecordReportModeVerifyFailLesson({
    cfg: { verify: { mode: 'gate' } }, projDir, phaseMeta: PHASE_META, fix: null, nextPhase: 5,
    verifyOutcome: { status: 'fail', verdict: { verdict: 'fail', criteria: [], must_fix: ['x'] } },
  });
  assert.equal(recorded, false);
  assert.equal((await readLessons(projDir)).length, 0);
});

test('maybeRecordReportModeVerifyFailLesson: a fix-scoped report-mode fail records with the fix-round lesson shape (phase:null, fix:"rN-M")', async () => {
  const projDir = makeProjDir();
  const recorded = await maybeRecordReportModeVerifyFailLesson({
    cfg: { verify: { mode: 'report', include_fixes: true } }, projDir, phaseMeta: PHASE_META,
    fix: { round: 2, n: 3, title: 'some fix' }, nextPhase: null,
    verifyOutcome: { status: 'fail', verdict: { verdict: 'fail', criteria: [], must_fix: ['fix it'] } },
  });
  assert.equal(recorded, true);
  const lessons = await readLessons(projDir);
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0].phase, null);
  assert.equal(lessons[0].fix, 'r2-3');
});

test('maybeRecordReportModeVerifyFailLesson: falls back to decideVerdict-derived unmet criteria when the verdict has no must_fix array', async () => {
  const projDir = makeProjDir();
  await maybeRecordReportModeVerifyFailLesson({
    cfg: { verify: { mode: 'report' } }, projDir, phaseMeta: PHASE_META, fix: null, nextPhase: 5,
    verifyOutcome: {
      status: 'fail',
      verdict: { verdict: 'fail', criteria: [{ criterion: 'Rejects malformed challans', status: 'unmet' }] },
    },
  });
  const lessons = await readLessons(projDir);
  assert.match(lessons[0].lesson, /Rejects malformed challans/);
});

// ─── E. source assertions — hook placement + return-shape regression proxy ──

const phaseRunnerSrc = readFileSync(fileURLToPath(new URL('./phase-runner.js', import.meta.url)), 'utf-8');

test('runDev(): the report-mode lesson-capture call sits inside the report-mode hook block, right after result.verify_outcome is set', () => {
  const hookStart2 = phaseRunnerSrc.indexOf('// ── Acceptance-check hook (brief P2 part 3/3 report mode; P3 gate mode) ─');
  const hookEnd2 = phaseRunnerSrc.indexOf('// ── v0.15.0 gate-mode refine → re-check → escalate (brief P3) ──────────', hookStart2);
  const block = phaseRunnerSrc.slice(hookStart2, hookEnd2);
  assert.match(block, /maybeRecordReportModeVerifyFailLesson\(\{ cfg, projDir, phaseMeta: phaseMeta \|\| null, fix, nextPhase, verifyOutcome \}\);/);
});

test('runDev(): acceptance-check hook sits AFTER the validator gate re-reads commit_sha and BEFORE markPhaseCompleted/pushBranch', () => {
  const gateIdx = phaseRunnerSrc.indexOf('The retry may have advanced HEAD — record the SHA that actually passed.');
  const hookIdx = phaseRunnerSrc.indexOf('const verifyOutcome = await runPhaseAcceptanceCheck({');
  // Phase 68 (P3): the primary completion now routes through the shared
  // completeMergedPhase() helper — anchor on its unique call-site argument
  // literal (the function DEFINITION precedes runDev, so a bare name match
  // would find the wrong offset).
  const completeIdx = phaseRunnerSrc.indexOf('{ projectName, n: nextPhase, commit_sha, projDir }');
  const pushIdx = phaseRunnerSrc.indexOf('const push = await pushBranchFn(workspaceDir, { branch });');
  assert.ok(gateIdx > -1 && hookIdx > -1 && completeIdx > -1 && pushIdx > -1, 'all anchors found in source');
  assert.ok(gateIdx < hookIdx, 'hook runs after the gate re-reads commit_sha');
  assert.ok(hookIdx < completeIdx, 'hook runs before markPhaseCompleted');
  assert.ok(hookIdx < pushIdx, 'hook runs before pushBranch');
});

test('runDev(): hook call reuses preSha/commit_sha (does not recompute HEAD before calling the checker)', () => {
  assert.match(phaseRunnerSrc, /runPhaseAcceptanceCheck\(\{\s*\n\s*cfg, projectName, projDir, workspaceDir, phaseMeta: phaseMeta \|\| null, fix, preSha, commitSha: commit_sha, nextPhase,/);
});

test('runDev(): the report-mode hook (before the v0.15.0 gate-mode block) touches `result` only via `verify_outcome`, with no role/sessionId override', () => {
  // Scoped to JUST the report-mode computation (runPhaseAcceptanceCheck call
  // through to the start of the gate-mode `if`) — the gate-mode block that
  // follows legitimately re-assigns `result.verify_outcome` again (the
  // refined outcome) and legitimately passes a `sessionId` to resume the dev
  // session for refine (see verify-gate-mode.test.mjs). Those are new,
  // intentional v0.15.0 behaviors, not a regression of THIS invariant, which
  // is about the report-mode-only computation never touching session state.
  const hookStart = phaseRunnerSrc.indexOf('// ── Acceptance-check hook (brief P2 part 3/3 report mode; P3 gate mode) ─');
  const hookEnd = phaseRunnerSrc.indexOf('// ── v0.15.0 gate-mode refine → re-check → escalate (brief P3) ──────────', hookStart);
  assert.ok(hookStart > -1 && hookEnd > hookStart);
  const block = phaseRunnerSrc.slice(hookStart, hookEnd);
  const resultAssignments = block.match(/result\.\w+\s*=/g) || [];
  assert.deepEqual(resultAssignments, ['result.verify_outcome ='], 'the report-mode hook assigns exactly one new field on result — nothing else on the success-path return shape changes');
  assert.ok(!/role:/.test(block), 'hook never overrides role at the call site');
  assert.ok(!/sessionId:/.test(block), 'hook never overrides sessionId at the call site');
  assert.ok(!/recordDevSession|recordGuideSession|backfillPhaseSessionId/.test(block), 'hook never touches session bookkeeping');
});

test('runDev(): across the FULL hook (report-mode computation + v0.15.0 gate-mode block), the only `result` field ever assigned is `verify_outcome`', () => {
  const hookStart = phaseRunnerSrc.indexOf('// ── Acceptance-check hook (brief P2 part 3/3 report mode; P3 gate mode) ─');
  // Phase 68 (P3): completion routes through the shared completeMergedPhase()
  // helper — anchor on its unique call-site argument literal. The lane-mode
  // early return (which precedes this) only READS result.* into an object
  // literal — it never assigns result.*, so the invariant still holds.
  const hookEnd = phaseRunnerSrc.indexOf('{ projectName, n: nextPhase, commit_sha, projDir }');
  assert.ok(hookStart > -1 && hookEnd > hookStart);
  const block = phaseRunnerSrc.slice(hookStart, hookEnd);
  const resultAssignments = block.match(/result\.\w+\s*=/g) || [];
  assert.deepEqual([...new Set(resultAssignments)], ['result.verify_outcome ='], 'no field other than verify_outcome is ever assigned on result, in either mode');
});

test('runDev(): a fix run is excluded from the acceptance-check hook per v1 scope (verify.include_fixes false in v1)', () => {
  // Covered functionally above (shouldRunAcceptanceCheck / runPhaseAcceptanceCheck
  // fix-skip tests); this asserts the hook is reached for BOTH phases and fixes
  // (the `fix` param is threaded through, not phase-only-gated at the call site),
  // relying on shouldRunAcceptanceCheck's own include_fixes gate rather than a
  // separate `if (!fix)` wrapper around the whole hook.
  const hookIdx = phaseRunnerSrc.indexOf('const verifyOutcome = await runPhaseAcceptanceCheck({');
  // Phase 68 (P3): the `if (!fix)` completion block now calls completeMergedPhase();
  // anchor on its unique call-site argument literal after the hook.
  const nextIfFix = phaseRunnerSrc.indexOf('{ projectName, n: nextPhase, commit_sha, projDir }', hookIdx);
  assert.ok(hookIdx > -1 && nextIfFix > hookIdx, 'hook call is unconditional on fix — skip logic lives inside shouldRunAcceptanceCheck');
});

// ─── F. QL-7 — dev self-assessment contract ────────────────────────────────

const SAMPLE_REPORT = `# Phase 5 Report — demo

**Status:** COMPLETED

## Acceptance criteria self-assessment

| Criterion | Status | Evidence (file:line) | Confidence |
|---|---|---|---|
| Generates a valid FVU file | done | \`backend/services/fvuBuilder.js:20\` | high |
| Rejects malformed challans | uncertain | \`backend/services/fvuBuilder.js:44\` | low |
| Handles empty batch input | partial | (not fully verified) | med |

## Deviations from prompt

None.
`;

test('parseCriteriaSelfAssessment: parses all three rows with the right columns, skipping the header/separator rows', () => {
  const rows = parseCriteriaSelfAssessment(SAMPLE_REPORT);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { criterion: 'Generates a valid FVU file', status: 'done', evidence: '`backend/services/fvuBuilder.js:20`', confidence: 'high' });
  assert.equal(rows[1].status, 'uncertain');
  assert.equal(rows[1].confidence, 'low');
  assert.equal(rows[2].status, 'partial');
});

test('parseCriteriaSelfAssessment: no such section at all → empty array, never throws', () => {
  assert.deepEqual(parseCriteriaSelfAssessment('# Phase 5 Report\n\nNo table here.\n'), []);
});

test('parseCriteriaSelfAssessment: null/undefined/non-string input → empty array, never throws', () => {
  assert.deepEqual(parseCriteriaSelfAssessment(null), []);
  assert.deepEqual(parseCriteriaSelfAssessment(undefined), []);
  assert.deepEqual(parseCriteriaSelfAssessment(42), []);
  assert.deepEqual(parseCriteriaSelfAssessment(''), []);
});

test('parseCriteriaSelfAssessment: section present but malformed table (no pipe rows) → empty array, fail-open', () => {
  const text = '## Acceptance criteria self-assessment\n\nI checked everything, looks good.\n\n## Next section\n';
  assert.deepEqual(parseCriteriaSelfAssessment(text), []);
});

test('parseCriteriaSelfAssessment: only reads the table WITHIN the section — a later, unrelated pipe-table is not picked up', () => {
  const text = `## Acceptance criteria self-assessment

| Criterion | Status | Evidence (file:line) | Confidence |
|---|---|---|---|
| One thing | done | \`a.js:1\` | high |

## Some other section

| Not | A | Self | Assessment |
|---|---|---|---|
| row | x | y | z |
`;
  const rows = parseCriteriaSelfAssessment(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].criterion, 'One thing');
});

test('parseCriteriaSelfAssessment: heading match is case-insensitive and tolerant of heading level', () => {
  const text = `### ACCEPTANCE CRITERIA SELF-ASSESSMENT

| Criterion | Status | Evidence (file:line) | Confidence |
|---|---|---|---|
| Thing | done | \`a.js:1\` | high |
`;
  const rows = parseCriteriaSelfAssessment(text);
  assert.equal(rows.length, 1);
});

test('selectPriorityCriteria: done+high confidence rows are excluded; uncertain/partial/low-confidence rows are included', () => {
  const rows = parseCriteriaSelfAssessment(SAMPLE_REPORT);
  const priority = selectPriorityCriteria(rows);
  assert.equal(priority.length, 2, 'uncertain + partial rows; the done/high row is excluded');
  assert.ok(priority.some((r) => r.criterion === 'Rejects malformed challans'));
  assert.ok(priority.some((r) => r.criterion === 'Handles empty batch input'));
  assert.ok(!priority.some((r) => r.criterion === 'Generates a valid FVU file'));
});

test('selectPriorityCriteria: a "done" row with low confidence still makes the priority list', () => {
  const rows = [{ criterion: 'Shaky done', status: 'done', evidence: 'x.js:1', confidence: 'low' }];
  const priority = selectPriorityCriteria(rows);
  assert.equal(priority.length, 1);
  assert.equal(priority[0].criterion, 'Shaky done');
});

test('selectPriorityCriteria: empty/null input never throws', () => {
  assert.deepEqual(selectPriorityCriteria([]), []);
  assert.deepEqual(selectPriorityCriteria(null), []);
  assert.deepEqual(selectPriorityCriteria(undefined), []);
});

test('runPhaseAcceptanceCheck: reads the dev report on disk and threads its priority criteria into the checker call', async () => {
  const projDir = makeProjDir();
  const phaseDirPath = path.join(projDir, '.guide', 'phases', '05-fvu-file-builder');
  mkdirSync(phaseDirPath, { recursive: true });
  writeFileSync(path.join(phaseDirPath, 'report.md'), SAMPLE_REPORT, 'utf-8');

  const captured = [];
  const deps = {
    runAcceptanceCheck: async (args) => { captured.push(args); return { status: 'pass', verdict: { verdict: 'pass', criteria: [] } }; },
  };
  await runPhaseAcceptanceCheck({
    cfg: { verify: { mode: 'report' } },
    projectName: 'demo', projDir, workspaceDir: path.join(projDir, 'workspace'),
    phaseMeta: PHASE_META, fix: null, preSha: 'abc1234', commitSha: 'def5678', nextPhase: 5,
  }, deps);

  assert.equal(captured.length, 1);
  const priorityCriteria = captured[0].priorityCriteria;
  assert.equal(priorityCriteria.length, 2);
  assert.ok(priorityCriteria.some((r) => r.criterion === 'Rejects malformed challans'));
});

test('runPhaseAcceptanceCheck: no report on disk yet → priorityCriteria is an empty array, checker call still proceeds normally', async () => {
  const projDir = makeProjDir();
  const captured = [];
  const deps = {
    runAcceptanceCheck: async (args) => { captured.push(args); return { status: 'pass', verdict: { verdict: 'pass', criteria: [] } }; },
  };
  await runPhaseAcceptanceCheck({
    cfg: { verify: { mode: 'report' } },
    projectName: 'demo', projDir, workspaceDir: path.join(projDir, 'workspace'),
    phaseMeta: PHASE_META, fix: null, preSha: 'abc1234', commitSha: 'def5678', nextPhase: 5,
  }, deps);
  assert.deepEqual(captured[0].priorityCriteria, []);
});

test('runPhaseAcceptanceCheck: a report WITHOUT a parseable self-assessment table records an "agent"-kind lesson (visible, not silent)', async () => {
  const projDir = makeProjDir();
  const phaseDirPath = path.join(projDir, '.guide', 'phases', '05-fvu-file-builder');
  mkdirSync(phaseDirPath, { recursive: true });
  writeFileSync(path.join(phaseDirPath, 'report.md'), '# Phase 5 Report\n\nDone, no table included.\n', 'utf-8');

  const deps = { runAcceptanceCheck: async () => ({ status: 'pass', verdict: { verdict: 'pass', criteria: [] } }) };
  await runPhaseAcceptanceCheck({
    cfg: { verify: { mode: 'report' } },
    projectName: 'demo', projDir, workspaceDir: path.join(projDir, 'workspace'),
    phaseMeta: PHASE_META, fix: null, preSha: 'abc1234', commitSha: 'def5678', nextPhase: 5,
  }, deps);

  const lessons = await readLessons(projDir);
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0].kind, 'agent');
  assert.equal(lessons[0].source, 'phase-runner:self-assessment-parse');
});

test('runPhaseAcceptanceCheck: a report WITH a parseable table (even if empty priority list) never records the malformed-table lesson', async () => {
  const projDir = makeProjDir();
  const phaseDirPath = path.join(projDir, '.guide', 'phases', '05-fvu-file-builder');
  mkdirSync(phaseDirPath, { recursive: true });
  const cleanReport = `# Phase 5 Report\n\n## Acceptance criteria self-assessment\n\n| Criterion | Status | Evidence (file:line) | Confidence |\n|---|---|---|---|\n| Generates a valid FVU file | done | \`a.js:1\` | high |\n`;
  writeFileSync(path.join(phaseDirPath, 'report.md'), cleanReport, 'utf-8');

  const deps = { runAcceptanceCheck: async () => ({ status: 'pass', verdict: { verdict: 'pass', criteria: [] } }) };
  await runPhaseAcceptanceCheck({
    cfg: { verify: { mode: 'report' } },
    projectName: 'demo', projDir, workspaceDir: path.join(projDir, 'workspace'),
    phaseMeta: PHASE_META, fix: null, preSha: 'abc1234', commitSha: 'def5678', nextPhase: 5,
  }, deps);

  assert.deepEqual(await readLessons(projDir), []);
});

// ─── G. phase-26 — honoring verify.fail_open on an 'inconclusive' outcome ───

// ─── shouldFailClosedOnInconclusive — pure decision ─────────────────────────

test('shouldFailClosedOnInconclusive: inconclusive + fail_open:false → true', () => {
  assert.equal(shouldFailClosedOnInconclusive({ verifyCfg: { fail_open: false }, outcomeStatus: 'inconclusive' }), true);
});

test('shouldFailClosedOnInconclusive: inconclusive + fail_open:true (or absent, the default) → false', () => {
  assert.equal(shouldFailClosedOnInconclusive({ verifyCfg: { fail_open: true }, outcomeStatus: 'inconclusive' }), false);
  assert.equal(shouldFailClosedOnInconclusive({ verifyCfg: {}, outcomeStatus: 'inconclusive' }), false, 'absent verify cfg defaults to fail-open');
  assert.equal(shouldFailClosedOnInconclusive({ verifyCfg: undefined, outcomeStatus: 'inconclusive' }), false);
});

test('shouldFailClosedOnInconclusive: only "inconclusive" triggers it — "fail"/"pass"/"skipped-trivial" never do, even with fail_open:false', () => {
  assert.equal(shouldFailClosedOnInconclusive({ verifyCfg: { fail_open: false }, outcomeStatus: 'fail' }), false);
  assert.equal(shouldFailClosedOnInconclusive({ verifyCfg: { fail_open: false }, outcomeStatus: 'pass' }), false);
  assert.equal(shouldFailClosedOnInconclusive({ verifyCfg: { fail_open: false }, outcomeStatus: 'skipped-trivial' }), false);
});

// ─── maybeRecordInconclusiveLesson — wiring ─────────────────────────────────

test('maybeRecordInconclusiveLesson: inconclusive + fail_open:true (default) → records exactly one "verify-unverified" lesson', async () => {
  const projDir = makeProjDir();
  const recorded = await maybeRecordInconclusiveLesson({
    cfg: { verify: { mode: 'report' } }, projDir, phaseMeta: PHASE_META, fix: null, nextPhase: 5,
    verifyOutcome: { status: 'inconclusive', verdict: null, errors: ['checker reply unparseable twice, opus fallback also unparseable'] },
  });
  assert.equal(recorded, true);
  const lessons = await readLessons(projDir);
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0].kind, 'verify-unverified');
  assert.equal(lessons[0].source, 'phase-runner:acceptance-check-inconclusive');
  assert.equal(lessons[0].phase, 5);
  assert.equal(lessons[0].fix, null);
  assert.match(lessons[0].lesson, /opus fallback also unparseable/);
  assert.deepEqual(lessons[0].files, PHASE_META.files_expected);
});

test('maybeRecordInconclusiveLesson: absent verify cfg (defaults to fail-open) still records', async () => {
  const projDir = makeProjDir();
  const recorded = await maybeRecordInconclusiveLesson({
    cfg: {}, projDir, phaseMeta: PHASE_META, fix: null, nextPhase: 5,
    verifyOutcome: { status: 'inconclusive', verdict: null, errors: [] },
  });
  assert.equal(recorded, true);
  const lessons = await readLessons(projDir);
  assert.equal(lessons.length, 1);
  assert.match(lessons[0].lesson, /no verdict produced/, 'falls back to a generic reason when errors is empty');
});

test('maybeRecordInconclusiveLesson: inconclusive + fail_open:false → no lesson recorded here (that case fails the phase outright instead)', async () => {
  const projDir = makeProjDir();
  const recorded = await maybeRecordInconclusiveLesson({
    cfg: { verify: { fail_open: false } }, projDir, phaseMeta: PHASE_META, fix: null, nextPhase: 5,
    verifyOutcome: { status: 'inconclusive', verdict: null, errors: ['boom'] },
  });
  assert.equal(recorded, false);
  assert.equal((await readLessons(projDir)).length, 0);
});

test('maybeRecordInconclusiveLesson: a "fail" or "pass" outcome is a no-op — this hook only ever acts on "inconclusive"', async () => {
  const projDir = makeProjDir();
  assert.equal(await maybeRecordInconclusiveLesson({
    cfg: {}, projDir, phaseMeta: PHASE_META, fix: null, nextPhase: 5,
    verifyOutcome: { status: 'fail', verdict: { verdict: 'fail', criteria: [], must_fix: ['x'] } },
  }), false);
  assert.equal(await maybeRecordInconclusiveLesson({
    cfg: {}, projDir, phaseMeta: PHASE_META, fix: null, nextPhase: 5,
    verifyOutcome: { status: 'pass', verdict: { verdict: 'pass', criteria: [] } },
  }), false);
  assert.equal((await readLessons(projDir)).length, 0);
});

test('maybeRecordInconclusiveLesson: null verifyOutcome (checker skipped) is a no-op', async () => {
  const projDir = makeProjDir();
  const recorded = await maybeRecordInconclusiveLesson({
    cfg: {}, projDir, phaseMeta: PHASE_META, fix: null, nextPhase: 5, verifyOutcome: null,
  });
  assert.equal(recorded, false);
  assert.equal((await readLessons(projDir)).length, 0);
});

test('maybeRecordInconclusiveLesson: a fix-scoped inconclusive outcome records with the fix-round lesson shape (phase:null, fix:"rN-M")', async () => {
  const projDir = makeProjDir();
  const recorded = await maybeRecordInconclusiveLesson({
    cfg: { verify: { include_fixes: true } }, projDir, phaseMeta: PHASE_META,
    fix: { round: 2, n: 3, title: 'some fix' }, nextPhase: null,
    verifyOutcome: { status: 'inconclusive', verdict: null, errors: ['boom'] },
  });
  assert.equal(recorded, true);
  const lessons = await readLessons(projDir);
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0].phase, null);
  assert.equal(lessons[0].fix, 'r2-3');
});

// ─── source assertions — runDev() wiring (mirrors section E) ────────────────

test('runDev(): the fail_open-on-inconclusive check sits AFTER the report-mode lesson-capture call and BEFORE the gate-mode refine block', () => {
  const afterReportLesson = phaseRunnerSrc.indexOf('maybeRecordReportModeVerifyFailLesson({ cfg, projDir, phaseMeta: phaseMeta || null, fix, nextPhase, verifyOutcome });');
  const failClosedIdx = phaseRunnerSrc.indexOf('if (shouldFailClosedOnInconclusive({ verifyCfg: cfg.verify, outcomeStatus: verifyOutcome?.status })) {');
  const gateIdx = phaseRunnerSrc.indexOf('if (shouldRunGateRefine({ verifyCfg: cfg.verify, outcomeStatus: verifyOutcome?.status })) {');
  assert.ok(afterReportLesson > -1 && failClosedIdx > -1 && gateIdx > -1, 'all anchors found in source');
  assert.ok(afterReportLesson < failClosedIdx, 'fail_open check runs after the report-mode lesson capture');
  assert.ok(failClosedIdx < gateIdx, 'fail_open check runs before the gate-mode refine block');
});

test('runDev(): fail_open:false + inconclusive returns is_error:true, an error_message matching the classifier pattern, upsertPhase(failed), and a git_result with ok:false — no pushBranch precedes the return', () => {
  const block = phaseRunnerSrc.slice(
    phaseRunnerSrc.indexOf('if (shouldFailClosedOnInconclusive('),
    phaseRunnerSrc.indexOf('maybeRecordInconclusiveLesson({ cfg, projDir, phaseMeta: phaseMeta || null, fix, nextPhase, verifyOutcome });'),
  );
  assert.match(block, /is_error: true,/);
  assert.match(block, /error_message: `\$\{acceptLabel\} committed but failed acceptance verification \(inconclusive, fail_closed\)/);
  assert.match(block, /upsertPhase\(\{ project: projectName, n: nextPhase, status: 'failed' \}\);/);
  assert.match(block, /git_result: \{ ok: false, branch, commit_sha, error: 'acceptance-verification-inconclusive' \}/);
  assert.ok(!/pushBranch/.test(block), 'no pushBranch call inside the fail-closed block — commit never reaches origin');
});

test('runDev(): the maybeRecordInconclusiveLesson call site is only reached when NOT fail-closed (sits after the fail-closed block\'s return, not inside it)', () => {
  const failClosedIdx = phaseRunnerSrc.indexOf('if (shouldFailClosedOnInconclusive(');
  const failClosedReturnIdx = phaseRunnerSrc.indexOf('git_result: { ok: false, branch, commit_sha, error: \'acceptance-verification-inconclusive\' },', failClosedIdx);
  const lessonCallIdx = phaseRunnerSrc.indexOf('maybeRecordInconclusiveLesson({ cfg, projDir, phaseMeta: phaseMeta || null, fix, nextPhase, verifyOutcome });');
  assert.ok(failClosedIdx > -1 && failClosedReturnIdx > failClosedIdx && lessonCallIdx > failClosedReturnIdx);
});

test('classifyError: "Phase N committed but failed acceptance verification (inconclusive, fail_closed): ..." classifies as VALIDATION, never ORCHESTRATOR_BUG', async () => {
  const { classifyError, ERROR_KINDS } = await import('./error-classifier.js');
  const msg = 'Phase 5 committed but failed acceptance verification (inconclusive, fail_closed): checker reply unparseable twice';
  const result = classifyError(new Error(msg));
  assert.equal(result.kind, ERROR_KINDS.VALIDATION);
  assert.notEqual(result.kind, ERROR_KINDS.ORCHESTRATOR_BUG);
  assert.equal(result.recoverable, false);
});
