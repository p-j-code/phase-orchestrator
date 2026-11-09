// Tests for phase-51 (P1 / par-02) — async report-mode acceptance check.
// Moves the report-mode checker OFF the phase critical path. Covers:
//   A. shouldDeferAcceptanceCheck  — pure defer/no-defer decision (report+async
//      +deferVerify only; gate mode, async_report:false, fixes, and a
//      no-defer caller all stay inline)
//   B. runDetachedAcceptanceCheck  — worktree pinning against a REAL temp git
//      repo: the checker seam reads a worktree whose HEAD == commitSha even
//      after the main tree advances; the worktree is removed in a finally,
//      including on check rejection; a bogus sha fails open to 'inconclusive'
//   C. spawnDetachedVerify         — settle behavior: identical outcome line +
//      identical maybeRecordReportModeVerifyFailLesson lesson as inline report
//      mode; the returned promise NEVER rejects (a rejected check degrades to
//      null, advisory-only)
//   D. source assertions           — runDev()'s defer wiring (deferred_verify
//      populated, checker skipped in the defer branch, still completes+pushes;
//      inline hook intact for every non-defer caller) and auto-runner's cap-1
//      barriers (guide dispatch, cap-1-before-respawn, finalize())
//
// No real `claude` subprocess is ever spawned.
//
// Run with: node --test src/lib/verify-async-report.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.env.DB_PATH = ':memory:';

const {
  shouldDeferAcceptanceCheck,
  formatVerifyOutcomeLine,
  maybeRecordReportModeVerifyFailLesson,
} = await import('./phase-runner.js');
const { runDetachedAcceptanceCheck } = await import('./verify-loop.js');
const { getHeadSha } = await import('./git.js');
const { worktreesRoot } = await import('./guide-paths.js');
const { readLessons } = await import('./lessons.js');
const { spawnDetachedVerify } = await import('../auto-runner.js');

const PHASE_META = {
  n: 5,
  title: 'FVU file builder',
  goal: 'Build the NSDL FVU export.',
  acceptance_criteria: ['Generates a valid FVU file', 'Rejects malformed challans'],
  files_expected: ['backend/services/fvuBuilder.js'],
};

const FAIL_OUTCOME = {
  status: 'fail',
  verdict: {
    verdict: 'fail',
    criteria: [
      { criterion: 'Generates a valid FVU file', status: 'unmet' },
      { criterion: 'Rejects malformed challans', status: 'met' },
    ],
    must_fix: ['Implement FVU generation'],
  },
};

function makeProjDir(label) {
  const d = mkdtempSync(path.join(tmpdir(), `aorch-async-report-${label}-`));
  mkdirSync(path.join(d, '.guide'), { recursive: true });
  return d;
}

function makeRepo(label) {
  const projDir = makeProjDir(label);
  const workspaceDir = mkdtempSync(path.join(tmpdir(), `aorch-async-ws-${label}-`));
  execSync('git init -q', { cwd: workspaceDir });
  execSync('git config user.email t@example.com', { cwd: workspaceDir });
  execSync('git config user.name test', { cwd: workspaceDir });
  return { projDir, workspaceDir };
}

function writeAndCommit(workspaceDir, file, content, message) {
  writeFileSync(path.join(workspaceDir, file), content);
  execSync('git add -A', { cwd: workspaceDir });
  execSync(`git commit -q -m ${JSON.stringify(message)}`, { cwd: workspaceDir });
}

// ─── A. shouldDeferAcceptanceCheck — pure defer decision ────────────────────

const RUN = { run: true, skipReason: null };

test('shouldDeferAcceptanceCheck: report + async_report:true + deferVerify + checkDecision.run → true', () => {
  assert.equal(shouldDeferAcceptanceCheck({
    verifyCfg: { mode: 'report', async_report: true }, fix: null, deferVerify: true, checkDecision: RUN,
  }), true);
});

test('shouldDeferAcceptanceCheck: mode absent defaults to "report" — still defers when async+deferVerify+run', () => {
  assert.equal(shouldDeferAcceptanceCheck({
    verifyCfg: { async_report: true }, fix: null, deferVerify: true, checkDecision: RUN,
  }), true);
});

test('shouldDeferAcceptanceCheck: gate mode NEVER defers (stays fully synchronous), even with async_report:true', () => {
  assert.equal(shouldDeferAcceptanceCheck({
    verifyCfg: { mode: 'gate', async_report: true }, fix: null, deferVerify: true, checkDecision: RUN,
  }), false);
});

test('shouldDeferAcceptanceCheck: mode "off" never defers', () => {
  assert.equal(shouldDeferAcceptanceCheck({
    verifyCfg: { mode: 'off', async_report: true }, fix: null, deferVerify: true, checkDecision: RUN,
  }), false);
});

test('shouldDeferAcceptanceCheck: async_report:false → inline (no defer)', () => {
  assert.equal(shouldDeferAcceptanceCheck({
    verifyCfg: { mode: 'report', async_report: false }, fix: null, deferVerify: true, checkDecision: RUN,
  }), false);
});

test('shouldDeferAcceptanceCheck: async_report absent requires an EXPLICIT true — no implicit opt-in', () => {
  assert.equal(shouldDeferAcceptanceCheck({
    verifyCfg: { mode: 'report' }, fix: null, deferVerify: true, checkDecision: RUN,
  }), false);
});

test('shouldDeferAcceptanceCheck: a caller that does not pass deferVerify (falsy) keeps the inline path', () => {
  assert.equal(shouldDeferAcceptanceCheck({
    verifyCfg: { mode: 'report', async_report: true }, fix: null, deferVerify: false, checkDecision: RUN,
  }), false);
});

test('shouldDeferAcceptanceCheck: a fix NEVER defers, regardless of config', () => {
  assert.equal(shouldDeferAcceptanceCheck({
    verifyCfg: { mode: 'report', async_report: true }, fix: { round: 1, n: 2 }, deferVerify: true, checkDecision: RUN,
  }), false);
});

test('shouldDeferAcceptanceCheck: defer is a WHEN not a WHETHER change — a phase the checker would skip is never deferred', () => {
  const skip = { run: false, skipReason: 'no acceptance_criteria' };
  assert.equal(shouldDeferAcceptanceCheck({
    verifyCfg: { mode: 'report', async_report: true }, fix: null, deferVerify: true, checkDecision: skip,
  }), false);
});

// ─── B. runDetachedAcceptanceCheck — worktree pinning (real git repo) ───────

test('runDetachedAcceptanceCheck: the checker seam reads a worktree whose HEAD == commitSha even after the main tree advances; worktree removed afterward', async () => {
  const { projDir, workspaceDir } = makeRepo('pin');
  writeAndCommit(workspaceDir, 'a.js', 'const a = 1;\n', 'phase pre');
  const preSha = await getHeadSha(workspaceDir);
  writeAndCommit(workspaceDir, 'a.js', 'const a = 2;\n', 'phase commit');
  const commitSha = await getHeadSha(workspaceDir);
  // Main tree moves ON to phase N+1 BEFORE the background check runs.
  writeAndCommit(workspaceDir, 'a.js', 'const a = 3;\n', 'next phase');
  const laterSha = await getHeadSha(workspaceDir);
  assert.notEqual(commitSha, laterSha);

  let seenWorkspaceDir = null;
  let headDuringCheck = null;
  let existedDuringCheck = false;
  const deps = {
    runAcceptanceCheck: async (args) => {
      seenWorkspaceDir = args.workspaceDir;
      headDuringCheck = await getHeadSha(args.workspaceDir);
      existedDuringCheck = existsSync(args.workspaceDir);
      // The seam also receives the reconstructed inline args verbatim.
      assert.equal(args.preSha, preSha);
      assert.equal(args.commitSha, commitSha);
      assert.equal(args.nextPhase, 5);
      return { status: 'pass', verdict: { verdict: 'pass', criteria: [] } };
    },
  };

  const out = await runDetachedAcceptanceCheck(
    { cfg: {}, projectName: 'demo', projDir, workspaceDir, job: { phaseN: 5, phaseMeta: PHASE_META, preSha, commitSha } },
    deps,
  );

  assert.equal(out.status, 'pass');
  assert.equal(existedDuringCheck, true, 'worktree existed while the check ran');
  assert.equal(headDuringCheck, commitSha, 'the check reads a tree pinned to commitSha, NOT the advanced main HEAD');
  assert.notEqual(seenWorkspaceDir, workspaceDir, 'the check reads the worktree, not the live workspace');
  const wtDir = path.join(worktreesRoot(projDir), `verify-${commitSha.slice(0, 8)}`);
  assert.equal(seenWorkspaceDir, wtDir);
  assert.ok(!existsSync(wtDir), 'worktree removed after the check (finally)');
});

test('runDetachedAcceptanceCheck: the worktree is removed even when the check REJECTS (finally runs)', async () => {
  const { projDir, workspaceDir } = makeRepo('reject');
  writeAndCommit(workspaceDir, 'a.js', 'x\n', 'pre');
  const preSha = await getHeadSha(workspaceDir);
  writeAndCommit(workspaceDir, 'a.js', 'y\n', 'commit');
  const commitSha = await getHeadSha(workspaceDir);
  const wtDir = path.join(worktreesRoot(projDir), `verify-${commitSha.slice(0, 8)}`);

  await assert.rejects(
    runDetachedAcceptanceCheck(
      { cfg: {}, projectName: 'demo', projDir, workspaceDir, job: { phaseN: 7, phaseMeta: null, preSha, commitSha } },
      { runAcceptanceCheck: async () => { throw new Error('checker boom'); } },
    ),
    /checker boom/,
  );
  assert.ok(!existsSync(wtDir), 'worktree removed despite the rejection');
});

test('runDetachedAcceptanceCheck: a bogus commitSha (worktree add fails) fails open to inconclusive without calling the checker', async () => {
  const { projDir, workspaceDir } = makeRepo('bogus');
  writeAndCommit(workspaceDir, 'a.js', 'x\n', 'pre');
  let called = 0;
  const out = await runDetachedAcceptanceCheck(
    { cfg: {}, projectName: 'demo', projDir, workspaceDir, job: { phaseN: 9, phaseMeta: null, preSha: null, commitSha: 'deadbeefdeadbeef' } },
    { runAcceptanceCheck: async () => { called += 1; return { status: 'pass' }; } },
  );
  assert.equal(called, 0, 'the checker is never reached when the worktree cannot be created');
  assert.equal(out.status, 'inconclusive');
  assert.match(out.errors[0], /detached worktree failed/);
});

// ─── C. spawnDetachedVerify — settle behavior mirrors inline report mode ────

test('spawnDetachedVerify: returns { promise, phaseN, label } with label === "Phase N" (inline-identical)', () => {
  const { promise, phaseN, label } = spawnDetachedVerify(
    { cfg: { verify: { mode: 'report' } }, projectName: 'demo', projDir: makeProjDir('shape'), workspaceDir: '/tmp/x', job: { phaseN: 5, phaseMeta: PHASE_META } },
    { runDetachedAcceptanceCheck: async () => ({ status: 'pass', verdict: { verdict: 'pass', criteria: [] } }) },
  );
  assert.equal(phaseN, 5);
  assert.equal(label, 'Phase 5');
  return promise; // let it settle so the test runner doesn't leave a dangling promise
});

test('spawnDetachedVerify: a background FAIL produces the SAME outcome line and the SAME lesson as inline report mode', async () => {
  const projDir = makeProjDir('fail');
  const notified = [];
  const notifier = { notify: async (msg) => { notified.push(msg); } };

  const { promise } = spawnDetachedVerify(
    { cfg: { verify: { mode: 'report' } }, projectName: 'demo', projDir, workspaceDir: '/tmp/x', job: { phaseN: 5, phaseMeta: PHASE_META }, notifier },
    { runDetachedAcceptanceCheck: async () => FAIL_OUTCOME },
  );
  const outcome = await promise;
  assert.equal(outcome, FAIL_OUTCOME, 'the settled promise resolves to the raw outcome');

  // Same '... FAILED (report-only)' outcome line as inline report mode.
  const inlineLine = formatVerifyOutcomeLine('Phase 5', FAIL_OUTCOME);
  assert.equal(inlineLine.text, '⚠ Phase 5: acceptance verify FAILED (report-only) — 1/2 criteria unmet');
  assert.equal(notified.length, 1);
  assert.equal(notified[0].text, `🔍 ${inlineLine.text}`, 'notify carries the byte-identical inline outcome line');

  // Same lesson maybeRecordReportModeVerifyFailLesson records inline.
  const bgLessons = await readLessons(projDir);
  assert.equal(bgLessons.length, 1);
  const bg = bgLessons[0];

  const inlineDir = makeProjDir('fail-inline');
  await maybeRecordReportModeVerifyFailLesson({
    cfg: { verify: { mode: 'report' } }, projDir: inlineDir, phaseMeta: PHASE_META, fix: null, nextPhase: 5, verifyOutcome: FAIL_OUTCOME,
  });
  const inlineLessons = await readLessons(inlineDir);
  assert.equal(inlineLessons.length, 1);
  const inline = inlineLessons[0];

  for (const key of ['kind', 'source', 'phase', 'fix', 'lesson']) {
    assert.deepEqual(bg[key], inline[key], `lesson.${key} matches the inline report-mode lesson`);
  }
  assert.deepEqual(bg.files, inline.files);
  assert.equal(bg.kind, 'verify-fail');
  assert.equal(bg.source, 'phase-runner:acceptance-check-report-mode');
});

test('spawnDetachedVerify: a PASS outcome records no lesson and notifies with the pass line', async () => {
  const projDir = makeProjDir('pass');
  const notified = [];
  const { promise } = spawnDetachedVerify(
    { cfg: { verify: { mode: 'report' } }, projectName: 'demo', projDir, workspaceDir: '/tmp/x', job: { phaseN: 3, phaseMeta: PHASE_META }, notifier: { notify: async (m) => notified.push(m) } },
    { runDetachedAcceptanceCheck: async () => ({ status: 'pass', verdict: { verdict: 'pass', criteria: [] } }) },
  );
  await promise;
  assert.equal((await readLessons(projDir)).length, 0);
  assert.equal(notified[0].text, '🔍 ✓ Phase 3: acceptance verify passed');
});

test('spawnDetachedVerify: a REJECTED background check degrades to null — the promise NEVER rejects (barrier-safe)', async () => {
  const projDir = makeProjDir('reject-safe');
  const notified = [];
  const { promise } = spawnDetachedVerify(
    { cfg: { verify: { mode: 'report' } }, projectName: 'demo', projDir, workspaceDir: '/tmp/x', job: { phaseN: 8, phaseMeta: PHASE_META }, notifier: { notify: async (m) => notified.push(m) } },
    { runDetachedAcceptanceCheck: async () => { throw new Error('detached boom'); } },
  );
  const settled = await promise; // must not throw
  assert.equal(settled, null);
  assert.equal((await readLessons(projDir)).length, 0, 'no lesson on a rejected check');
  assert.equal(notified.length, 0, 'no notify on a rejected check');
});

// ─── D. source assertions — runDev() defer wiring + auto-runner barriers ────

const phaseRunnerSrc = readFileSync(fileURLToPath(new URL('./phase-runner.js', import.meta.url)), 'utf-8');
const autoRunnerSrc = readFileSync(fileURLToPath(new URL('../auto-runner.js', import.meta.url)), 'utf-8');

test('runDev(): signature gains deferVerify defaulting to false (every non-defer caller keeps inline behavior)', () => {
  // Phase 67 (P2) appended lane options after deferVerify; deferVerify=false must stay.
  assert.match(phaseRunnerSrc, /export async function runDev\(\{ projectName, fix,.*deferVerify = false,/);
});

test('runDev(): the defer branch attaches result.deferred_verify = { phaseN, phaseMeta, preSha, commitSha } (no spawn)', () => {
  assert.match(phaseRunnerSrc, /result\.deferred_verify = \{ phaseN: nextPhase, phaseMeta: phaseMeta \|\| null, preSha, commitSha: commit_sha \};/);
});

test('runDev(): the defer branch does NOT call the checker (runPhaseAcceptanceCheck lives only in the else/inline branch)', () => {
  const start = phaseRunnerSrc.indexOf('if (willDeferVerify) {');
  const inlineHook = phaseRunnerSrc.indexOf('// ── Acceptance-check hook (brief P2 part 3/3 report mode; P3 gate mode) ─', start);
  assert.ok(start > -1 && inlineHook > start, 'defer branch precedes the inline hook');
  const deferBranch = phaseRunnerSrc.slice(start, inlineHook);
  // A CALL (with paren) — the explanatory comment inside the branch legitimately
  // names runPhaseAcceptanceCheck in prose ("...would have made inline").
  assert.ok(!/runPhaseAcceptanceCheck\(/.test(deferBranch), 'no checker call inside the defer branch');
});

test('runDev(): after the defer/inline hook, markPhaseCompleted + pushBranch run unconditionally (deferred phase still completes + pushes)', () => {
  // Phase 67 (P2) routed these through injectable seams; Phase 68 (P3) extracted
  // the primary completion into the shared completeMergedPhase() helper — anchor
  // on its unique call-site argument literal. The ordering guarantee is unchanged.
  const deferIdx = phaseRunnerSrc.indexOf('result.deferred_verify = { phaseN: nextPhase');
  const completeIdx = phaseRunnerSrc.indexOf('{ projectName, n: nextPhase, commit_sha, projDir }');
  const pushIdx = phaseRunnerSrc.indexOf('const push = await pushBranchFn(workspaceDir, { branch });');
  assert.ok(deferIdx > -1 && completeIdx > deferIdx && pushIdx > completeIdx, 'deferred_verify assignment precedes completeMergedPhase, which precedes pushBranch');
});

test('runDev(): the inline hook is preserved for the non-defer branch (byte-for-byte inline check still fires when not deferring)', () => {
  assert.match(phaseRunnerSrc, /\} else \{\s*\n\s*\/\/ ── Acceptance-check hook \(brief P2 part 3\/3 report mode; P3 gate mode\) ─/);
  assert.match(phaseRunnerSrc, /const verifyOutcome = await runPhaseAcceptanceCheck\(\{/);
});

test('auto-runner: dev actions pass deferVerify:true (opt-in for the async path)', () => {
  assert.match(autoRunnerSrc, /const result = await runDev\(\{ projectName, deferVerify: true \}\);/);
});

test('auto-runner: a guide action settle-awaits the pendingVerify barrier BEFORE dispatch', () => {
  assert.match(autoRunnerSrc, /if \(action\.kind === 'guide' && pendingVerify\) \{\s*\n\s*await pendingVerify\.promise;\s*\n\s*pendingVerify = null;/);
});

test('auto-runner: cap-1 — the previous background check is awaited before a new one is spawned', () => {
  const blockStart = autoRunnerSrc.indexOf('if (!result.is_error && result.deferred_verify) {');
  const block = autoRunnerSrc.slice(blockStart, blockStart + 400);
  assert.match(block, /if \(pendingVerify\) await pendingVerify\.promise;/);
  assert.match(block, /pendingVerify = spawnDetachedVerify\(\{/);
});

test('auto-runner: finalize() is async and awaits the pendingVerify barrier on every terminal path', () => {
  // Phase 52 (par-03) added a trailing pendingReview = null param to the same signature;
  // Phase 58 (notify_outbox) added a trailing notifier = null so the paused branch can
  // queue a pause ping only for notifier:null runs (job-runner owns the live-notifier one).
  assert.match(autoRunnerSrc, /async function finalize\(\{ runId, status, reason, pauseKind = null, projectName, runStartTime, pendingVerify = null, pendingReview = null, notifier = null \}\)/);
  const finalizeIdx = autoRunnerSrc.indexOf('async function finalize(');
  const body = autoRunnerSrc.slice(finalizeIdx, finalizeIdx + 700);
  assert.match(body, /if \(pendingVerify\?\.promise\) \{\s*\n\s*try \{ await pendingVerify\.promise; \}/);
});
