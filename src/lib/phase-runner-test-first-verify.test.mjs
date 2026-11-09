// runPhaseAcceptanceCheck × test-first (Phase 82 / brief 05 P4b) —
// src/lib/phase-runner-test-first-verify.test.mjs
//
// The CHECKER-side wiring of the test-first harness, kept in its own lean file
// (verify-report-mode.test.mjs is prone to a Node test-runner IPC-deserialize
// flake under its heavy end-to-end machinery — these small, spawn-free tests
// stay reliable on their own):
//   - buildTestTamperOutcome: the pure forced-fail verdict shape.
//   - TAMPER GUARD: a dev commit that touches tests/acceptance/ forces an UNMET
//     verdict + must_fix and short-circuits the checker (even a PASSING one).
//   - CHECKER INTERACTION: the covered list threads through to the checker as
//     coveredByTest, and an untouched authored test lets the checker verdict stand.
//
// The tamper detection's ONE side effect (git.js changedFilesSince) is injected
// via deps.changedFilesSince, so this suite makes ZERO real spawns and no DB
// writes. The checker is the deps.runAcceptanceCheck seam (fake).
//
// Run with: node --test src/lib/phase-runner-test-first-verify.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DB_PATH = ':memory:';

const { runPhaseAcceptanceCheck, buildTestTamperOutcome } = await import('./phase-runner.js');

const PHASE_META = {
  n: 5,
  title: 'FVU file builder',
  goal: 'Build the NSDL FVU export.',
  acceptance_criteria: ['Generates a valid FVU file', 'Rejects malformed challans'],
  files_expected: ['backend/services/fvuBuilder.js'],
};

function makeProjDir() {
  const d = mkdtempSync(path.join(tmpdir(), 'aorch-tf-verify-'));
  mkdirSync(path.join(d, '.guide'), { recursive: true });
  mkdirSync(path.join(d, 'workspace'), { recursive: true });
  return d;
}

test('buildTestTamperOutcome: fail status + fail verdict + must_fix + an UNMET synthetic criterion', () => {
  const o = buildTestTamperOutcome({ nextPhase: 7, postTestsSha: 'abc1234', tampered: ['tests/acceptance/phase-7.test.mjs'] });
  assert.equal(o.status, 'fail');
  assert.equal(o.verdict.verdict, 'fail');
  assert.equal(o.verdict.phase, 7);
  assert.equal(o.verdict.must_fix.length, 1);
  assert.match(o.verdict.must_fix[0], /tests\/acceptance/);
  assert.ok(o.verdict.criteria.some((c) => c.status === 'unmet'), 'a criterion is marked unmet');
  assert.deepEqual(o.tamper.files, ['tests/acceptance/phase-7.test.mjs']);
});

test('runPhaseAcceptanceCheck: tampering with tests/acceptance/ in the dev commit forces UNMET + must_fix, overriding a PASSING checker', async () => {
  const projDir = makeProjDir();
  let checkerCalled = 0;
  const deps = {
    // The dev commit touched the authored test AND some impl — only the
    // tests/acceptance change should trip the guard (impl.js must not).
    changedFilesSince: async () => ({ ok: true, files: ['tests/acceptance/phase-5.test.mjs', 'impl.js'] }),
    runAcceptanceCheck: async () => { checkerCalled += 1; return { status: 'pass', verdict: { verdict: 'pass', criteria: [] } }; },
  };
  const outcome = await runPhaseAcceptanceCheck({
    cfg: { verify: { mode: 'gate' } },
    projectName: 'demo', projDir, workspaceDir: path.join(projDir, 'workspace'),
    phaseMeta: PHASE_META, fix: null, preSha: 'aaaaaaa', commitSha: 'bbbbbbb', nextPhase: 5,
    testFirst: { covered: [1], postTestsSha: 'aaaaaaa' },
  }, deps);

  assert.equal(outcome.status, 'fail', 'a tampered phase fails regardless of the checker verdict');
  assert.equal(outcome.verdict.verdict, 'fail');
  assert.ok(outcome.verdict.must_fix.length >= 1, 'a must_fix entry is present');
  assert.ok(outcome.verdict.criteria.some((c) => c.status === 'unmet'), 'a criterion is marked unmet');
  assert.equal(checkerCalled, 0, 'the checker is short-circuited — a tampered phase spends no checker call');
  assert.deepEqual(outcome.tamper.files, ['tests/acceptance/phase-5.test.mjs'], 'only the tests/acceptance change is flagged, not impl.js');
});

test('runPhaseAcceptanceCheck: a failed git diff (ok:false) is NOT treated as tampering — the phase proceeds to the checker', async () => {
  const projDir = makeProjDir();
  let checkerCalled = 0;
  const deps = {
    changedFilesSince: async () => ({ ok: false, error: 'gc\'d sha' }),
    runAcceptanceCheck: async () => { checkerCalled += 1; return { status: 'pass', verdict: { verdict: 'pass', criteria: [] } }; },
  };
  const outcome = await runPhaseAcceptanceCheck({
    cfg: { verify: { mode: 'gate' } },
    projectName: 'demo', projDir, workspaceDir: path.join(projDir, 'workspace'),
    phaseMeta: PHASE_META, fix: null, preSha: 'aaaaaaa', commitSha: 'bbbbbbb', nextPhase: 5,
    testFirst: { covered: [1], postTestsSha: 'aaaaaaa' },
  }, deps);
  assert.equal(outcome.status, 'pass');
  assert.equal(checkerCalled, 1, 'an unresolvable diff falls through to the checker rather than fabricating a tamper fail');
});

test('runPhaseAcceptanceCheck: no tampering — the checker runs, its outcome is returned, and covered → coveredByTest', async () => {
  const projDir = makeProjDir();
  let coveredSeen;
  const deps = {
    // The dev commit touched ONLY implementation, never the authored test.
    changedFilesSince: async () => ({ ok: true, files: ['impl.js'] }),
    runAcceptanceCheck: async (a) => { coveredSeen = a.coveredByTest; return { status: 'pass', verdict: { verdict: 'pass', criteria: [] } }; },
  };
  const outcome = await runPhaseAcceptanceCheck({
    cfg: { verify: { mode: 'gate' } },
    projectName: 'demo', projDir, workspaceDir: path.join(projDir, 'workspace'),
    phaseMeta: PHASE_META, fix: null, preSha: 'aaaaaaa', commitSha: 'bbbbbbb', nextPhase: 5,
    testFirst: { covered: [1, 2], postTestsSha: 'aaaaaaa' },
  }, deps);

  assert.equal(outcome.status, 'pass', 'an untouched authored test lets the checker verdict stand');
  assert.deepEqual(coveredSeen, [1, 2], 'the covered list is threaded to the checker as coveredByTest');
});
