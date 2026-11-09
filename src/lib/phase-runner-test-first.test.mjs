// runDev() test-first pre-dev seam (Phase 81 P4a + Phase 82 P4b) —
// src/lib/phase-runner-test-first.test.mjs
//
// runDev() is universally source-tested in this repo (a real end-to-end call
// needs the full projects/ tree + config cascade + a spawn — see
// phase-runner-lane-mode.test.mjs's header). These are SEAM + placement + gating
// assertions in that same idiom. They pin that:
//   - preSha is a reassignable `let` (the re-read after a test commit needs it);
//   - the pre-dev seam is gated on isTestFirstActive (default OFF ⇒ inert) AND
//     runs BEFORE the dev spawn (a test commit must precede the dev);
//   - the seam is injectable (deps.runTestFirstPreDev ?? runTestFirstPreDev);
//   - preSha is re-read AND testFirstInfo captured when the seam commits a test
//     scaffold (P4b);
//   - P4b wiring: the committed authored test is injected into the validator
//     gate (extraRules/extraValidators), the dev prompt gains the "make it pass,
//     don't edit it" note, and the acceptance check receives covered/postTestsSha;
//   - with the harness off the whole block is unreachable — the runDev path is
//     behavior-identical to before (regression guard).
//
// Run with: node --test src/lib/phase-runner-test-first.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, 'phase-runner.js'), 'utf-8');

const FN_START = SRC.indexOf('export async function runDev(');
const FN_END = SRC.indexOf('export function parseCriteriaSelfAssessment(', FN_START);
assert.ok(FN_START > -1 && FN_END > FN_START, 'located runDev() body');
const BODY = SRC.slice(FN_START, FN_END);

test('phase-runner imports the test-first primitives (isTestFirstActive + runTestFirstPreDev)', () => {
  assert.match(SRC, /import \{ isTestFirstActive, runTestFirstPreDev \} from '\.\/test-first\.js';/);
});

test('preSha is a reassignable `let` (the re-read after a test commit requires it)', () => {
  assert.match(BODY, /let preSha = \(laneMode \|\| isBatch \|\| gitProject\.git_branch\) \? await getHeadSha\(workspaceDir\) : null;/);
  // And the old immutable binding must be gone (a `const preSha =` would make
  // the re-read a runtime TypeError).
  assert.equal(/const preSha = \(/.test(BODY), false, 'preSha must not be declared const');
});

test('the pre-dev seam is gated on isTestFirstActive AND a non-null preSha (default OFF ⇒ inert)', () => {
  assert.match(
    BODY,
    /if \(preSha != null && isTestFirstActive\(\{ cfg, phaseMeta, fix, isBatch \}\)\) \{/,
  );
});

test('the seam is injectable (deps.runTestFirstPreDev ?? runTestFirstPreDev)', () => {
  assert.match(BODY, /const preDevFn = deps\.runTestFirstPreDev \?\? runTestFirstPreDev;/);
});

test('preSha is re-read AND testFirstInfo captured only when the seam reports a committed test scaffold (P4b)', () => {
  assert.match(BODY, /if \(tf\?\.committed\) \{ preSha = await getHeadSha\(workspaceDir\); testFirstInfo = tf; \}/);
  // testFirstInfo is a reassignable `let`, initialized null (inert when off).
  assert.match(BODY, /let testFirstInfo = null;/);
});

test('the whole seam runs BEFORE the dev runClaude spawn (a test commit must precede the dev)', () => {
  const gateIdx = BODY.indexOf('isTestFirstActive({ cfg, phaseMeta, fix, isBatch })');
  const reReadIdx = BODY.indexOf('preSha = await getHeadSha(workspaceDir); testFirstInfo = tf;');
  // The dev spawn may sit behind interrupted-commit reconciliation, but it
  // must still follow the test-first seam whenever that branch is selected.
  const devSpawnIdx = BODY.indexOf(': await runClaudeFn({');
  assert.ok(gateIdx > -1 && reReadIdx > -1 && devSpawnIdx > -1, 'located seam + dev spawn');
  assert.ok(gateIdx < devSpawnIdx, 'the test-first gate precedes the dev spawn');
  assert.ok(reReadIdx < devSpawnIdx, 'the preSha re-read precedes the dev spawn');
});

test('the seam sits AFTER the original preSha capture (re-read never runs before the initial capture)', () => {
  const captureIdx = BODY.indexOf('let preSha = (laneMode || isBatch || gitProject.git_branch)');
  const gateIdx = BODY.indexOf('if (preSha != null && isTestFirstActive(');
  assert.ok(captureIdx > -1 && gateIdx > captureIdx, 'the seam follows the initial preSha capture');
});

// ── P4b wiring: the committed authored test reaches the gate, prompt, checker ──

test('a committed authored test is injected into the validator gate via extraRules/extraValidators', () => {
  // tfGate carries the seam's synthetic rule + validator, empty otherwise.
  assert.match(BODY, /const tfGate = testFirstInfo\?\.committed/);
  assert.match(BODY, /extraRules: testFirstInfo\.extraRules, extraValidators: testFirstInfo\.extraValidators/);
  // Both gate calls (initial + mechanical retry) forward the injected rules.
  const gateCalls = BODY.match(/extraRules: tfGate\.extraRules, extraValidators: tfGate\.extraValidators/g) || [];
  assert.equal(gateCalls.length, 2, 'both the initial and the retry gate calls forward the injected rules');
});

test('the dev prompt gains the "make the authored test pass, do not edit it" note only when committed', () => {
  assert.match(BODY, /if \(testFirstInfo\?\.committed\) \{\s*\n\s*promptWithReportHeader \+=/);
  assert.match(BODY, /<test_first>/);
  assert.match(BODY, /Do NOT edit, delete, weaken, or move/);
});

test('the acceptance check receives the covered list + postTestsSha (met-by-test + tamper guard)', () => {
  assert.match(BODY, /testFirst: testFirstInfo\?\.committed \? \{ covered: testFirstInfo\.covered, postTestsSha: testFirstInfo\.postTestsSha \} : null,/);
});
