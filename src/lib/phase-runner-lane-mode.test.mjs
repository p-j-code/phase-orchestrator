// runDev() lane mode (Phase 67 / brief 05 P2) — src/lib/phase-runner-lane-mode.test.mjs
//
// Proves the lane-mode contract on runDev():
//   - completion bookkeeping (markPhaseCompleted / setCurrentPhase / pushBranch)
//     is routed through INJECTABLE SEAMS (`deps.X ?? X`) — the raw imports are
//     never called directly, so a lane-mode run can be spied to assert zero calls;
//   - in lane mode runDev RETURNS before any of those seam calls (and before
//     marker cleanup), so a lane never marks a phase complete / advances
//     current_phase / pushes — the orchestrator-side merge (P3) owns completion;
//   - the non-lane path is byte-identical (the lane branches are all gated on
//     `laneMode`, which defaults false).
//
// runDev() is universally source-tested in this repo (a real end-to-end call
// needs the full projects/ tree + config cascade + a repomix spawn — see
// phase-runner-cache-discipline.test.mjs's note, and the runDev() wiring blocks
// in verify-report-mode / turn-continuation / guide-head-delta tests). These are
// SEAM + placement assertions in that same idiom: they pin that the seams exist
// and that lane mode returns ahead of every seam call site.
//
// Run with: node --test src/lib/phase-runner-lane-mode.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, 'phase-runner.js'), 'utf-8');

// The runDev() function body, sliced out so assertions can't accidentally match
// a different function.
const FN_START = SRC.indexOf('export async function runDev(');
const FN_END = SRC.indexOf('export function parseCriteriaSelfAssessment(', FN_START);
assert.ok(FN_START > -1 && FN_END > FN_START, 'located runDev() body');
const BODY = SRC.slice(FN_START, FN_END);

// ── signature + seams ─────────────────────────────────────────────────────────

test('runDev signature adds lane options { laneMode, laneDir, laneBranch, lanePhaseN } (defaults preserve non-lane behavior)', () => {
  const sig = BODY.slice(0, BODY.indexOf('\n')); // the single-line signature
  assert.match(sig, /laneMode = false/, 'laneMode defaults false');
  assert.match(sig, /laneDir = null/, 'laneDir defaults null');
  assert.match(sig, /laneBranch = null/, 'laneBranch defaults null');
  assert.match(sig, /lanePhaseN = null/, 'lanePhaseN defaults null (Phase 68 — pins a lane to its own phase)');
});

test('lane mode pins nextPhase to lanePhaseN (each lane runs its OWN phase, not the shared current_phase+1)', () => {
  assert.match(BODY, /\(laneMode && Number\.isInteger\(lanePhaseN\)\)\s*\n\s*\? lanePhaseN/);
});

test('the three completion functions are wired through injectable seams (deps.X ?? X)', () => {
  assert.match(BODY, /const markPhaseCompletedFn = deps\.markPhaseCompleted \?\? markPhaseCompleted;/);
  assert.match(BODY, /const setCurrentPhaseFn = deps\.setCurrentPhase \?\? setCurrentPhase;/);
  assert.match(BODY, /const pushBranchFn = deps\.pushBranch \?\? pushBranch;/);
});

test('NO raw markPhaseCompleted/setCurrentPhase/pushBranch CALL survives in runDev — every call goes through the *Fn seam', () => {
  // markPhaseCompletedFn( does not match \bmarkPhaseCompleted\( (the next char is
  // "F", not "("), so any match here is a raw, un-seamed call — which a spy could
  // not intercept.
  assert.equal(/\bmarkPhaseCompleted\(/.test(BODY), false, 'raw markPhaseCompleted( call present');
  assert.equal(/\bsetCurrentPhase\(/.test(BODY), false, 'raw setCurrentPhase( call present');
  assert.equal(/\bpushBranch\(/.test(BODY), false, 'raw pushBranch( call present');
  // And the seam calls DO exist.
  assert.ok(/\bmarkPhaseCompletedFn\(/.test(BODY));
  assert.ok(/\bsetCurrentPhaseFn\(/.test(BODY));
  assert.ok(/\bpushBranchFn\(/.test(BODY));
});

// ── lane-mode returns BEFORE any completion bookkeeping ───────────────────────

test('the lane-mode early return sits BEFORE every completion seam call site', () => {
  const laneReturn = BODY.indexOf('if (laneMode) {');
  const laneReturnShape = BODY.indexOf('lane: true', laneReturn);
  assert.ok(laneReturn > -1 && laneReturnShape > -1, 'lane-mode return block found');

  // Every completion call reachable in lane mode must be AFTER the lane return.
  // Phase 68 extracted the primary completion into completeMergedPhase(); the
  // only *Fn calls at a lower offset are the commit-reconcile ones, which are
  // guarded by `!laneMode` (asserted separately below) and thus unreachable in
  // a lane run.
  const primaryComplete = BODY.indexOf('completeMergedPhase(');
  const pushCall = BODY.indexOf('await pushBranchFn(workspaceDir');
  assert.ok(primaryComplete > laneReturnShape, 'primary completeMergedPhase() call is after the lane return');
  assert.ok(pushCall > laneReturnShape, 'pushBranchFn is after the lane return');
});

// ── Phase 68: the primary completion is the shared completeMergedPhase() ───────

test('runDev serial completion delegates to the shared completeMergedPhase() helper (single implementation, not a duplicated block)', () => {
  // The serial primary-completion path calls the SAME helper the parallel merge
  // step (auto-runner.js's runPhaseWave) calls — extracted, never duplicated.
  assert.match(BODY, /completeMergedPhase\(\s*\n\s*\{ projectName, n: nextPhase, commit_sha, projDir \}/);
  // Threads runDev's own seams through so a spy on deps.markPhaseCompleted still
  // intercepts the serial completion.
  assert.match(BODY, /\{ markPhaseCompleted: markPhaseCompletedFn, setCurrentPhase: setCurrentPhaseFn \}/);
});

test('the extracted marker cleanup no longer lives inline in the serial primary-completion block (moved into completeMergedPhase)', () => {
  // The primary completion block used to unlink escalateMarkerPath +
  // legacyEscalateMarkerPath inline right after markPhaseCompleted; that cleanup
  // is now inside completeMergedPhase. The remaining inline unlinks of those
  // vars are the reconcile-shortcut + gate-pass paths (both distinct blocks).
  const ledgerIdx = BODY.indexOf('recordPhaseLedgerEntry({');
  const completeIdx = BODY.indexOf('completeMergedPhase(');
  assert.ok(completeIdx > -1 && ledgerIdx > completeIdx, 'ledger append follows the completeMergedPhase() call inline');
});

test('the lane-mode return carries commit_sha, branch, validator_outcome, verify_outcome and lane:true', () => {
  // lastIndexOf → the RETURN `if (laneMode) {` (there is an earlier one for the
  // relaxed pre-flight); slice to the completion block that follows it.
  const start = BODY.lastIndexOf('if (laneMode) {');
  const block = BODY.slice(start, BODY.indexOf('if (!fix) {', start));
  assert.match(block, /lane: true/);
  assert.match(block, /commit_sha,/);
  assert.match(block, /branch,/);
  assert.match(block, /validator_outcome: result\.validator_outcome/);
  assert.match(block, /verify_outcome: result\.verify_outcome/);
  assert.match(block, /git_result: \{ ok: true, branch, commit_sha, lane: true \}/);
});

// ── the completion / marker paths a lane must skip are gated on !laneMode ──────

test('both commit-reconcile shortcuts (which markPhaseCompleted/return-complete) are guarded by !laneMode', () => {
  assert.match(BODY, /if \(fix && !laneMode\) \{/, 'fix idempotency reconcile guarded');
  // Phase 70 added `&& !isBatch` (a single-call batch has no single phase identity).
  assert.match(BODY, /if \(!fix && !laneMode && !isBatch\) \{/, 'phase idempotency reconcile guarded');
});

test('failure-marker cleanup after a passing validator gate is guarded by !laneMode', () => {
  const cleanupIdx = BODY.indexOf('fs.unlink(validationMarkerPath).catch(() => {});\n          fs.unlink(escalateMarkerPath)');
  assert.ok(cleanupIdx > -1, 'gate-pass marker cleanup block found');
  const guardIdx = BODY.lastIndexOf('if (!laneMode) {', cleanupIdx);
  assert.ok(guardIdx > -1 && guardIdx < cleanupIdx, 'marker cleanup wrapped in if (!laneMode)');
  // The guard must be close to the cleanup (same block, not a distant one).
  assert.ok(cleanupIdx - guardIdx < 120, 'the !laneMode guard immediately wraps the marker unlinks');
});

test('acceptance-check deferral is disabled in lane mode (willDeferVerify gated on !laneMode → check runs in-lane)', () => {
  assert.match(BODY, /const willDeferVerify = !laneMode && shouldDeferAcceptanceCheck\(/);
});

// ── the single laneDir thread through the workspaceDir computation ────────────

test('workspaceDir resolves to laneDir in lane mode, and to the original expression otherwise', () => {
  assert.match(BODY, /const workspaceDir = \(laneMode && laneDir\)\s*\n\s*\? laneDir\s*\n\s*: path\.join\(projDir, cfg\.paths\.workspace_subdir\);/);
});

test('relaxed lane pre-flight: skips the remote requirement (requireRemote:false), checks the lane branch, keeps a tracked-file clean-tree check', () => {
  const laneBlock = BODY.slice(BODY.indexOf('if (laneMode) {'), BODY.indexOf('} else if (expectedBranch) {'));
  assert.match(laneBlock, /preflightForDev\(workspaceDir, \{ expectedBranch: laneBranch, requireRemote: false \}\)/);
  assert.match(laneBlock, /workspaceStatus\(workspaceDir, \{ includeUntracked: false \}\)/);
  // The non-lane branch still runs syncWithRemote; the lane branch must NOT
  // actually CALL it (the comment explains why it's skipped, hence match the call).
  assert.ok(!/await syncWithRemote\(/.test(laneBlock), 'lane pre-flight must not sync with remote');
});

test('a lane run always enters the git block and computes preSha (independent of project.git_branch)', () => {
  // Phase 70 added `|| isBatch`; Phase 81 made preSha a `let` (re-read after a
  // test-first commit) — the lane/batch entry condition is otherwise unchanged.
  assert.match(BODY, /let preSha = \(laneMode \|\| isBatch \|\| gitProject\.git_branch\) \? await getHeadSha\(workspaceDir\) : null;/);
  assert.match(BODY, /if \(expectedBranch2 \|\| laneMode \|\| isBatch\) \{/);
});

// ── non-lane path is untouched (all lane logic is gated) ──────────────────────

test('every lane-specific branch is gated on laneMode/laneDir/laneBranch — non-lane runs cannot enter them', () => {
  // Each lane construct is behind an explicit lane gate; there is no lane code
  // that runs unconditionally. (Guards against a future edit dropping a gate.)
  assert.match(BODY, /if \(laneMode\) \{/);           // relaxed pre-flight + early return
  assert.match(BODY, /\(laneMode && laneDir\)/);      // workspaceDir
  assert.match(BODY, /\(laneMode \|\| isBatch \|\| gitProject\.git_branch\)/); // preSha (Phase 70 isBatch)
  assert.match(BODY, /\(expectedBranch2 \|\| laneMode \|\| isBatch\)/);     // git block entry (Phase 70 isBatch)
  assert.match(BODY, /!laneMode &&/);                 // willDeferVerify
});
