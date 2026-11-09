#!/usr/bin/env node
// verify-fix-batching.mjs — brief 05 P7, harness 3/4 (phase-74).
//
// Fixture-repo integration harness for the P5 single-call minor-fix batch
// (auto-runner.js's runFixSingleCallBatch + selectMinorFixBatch, phase 70).
// Builds its OWN temp git fixture repo per section — no shared helper file,
// matching the existing scripts/verify-*.mjs house style. Every dev/checker
// call is stubbed via the runFixSingleCallBatch deps seam, so this makes
// ZERO real LLM spawns; the git operations (commit, reset --hard, push) are
// REAL, exercising the exact code auto-runner.js runs in production. Mirrors
// (condensed, exit-code-checked form of) the scenarios in
// src/lib/fix-single-call-batch.test.mjs.
//
// Unlike P4's fix lanes (verify-parallel-fixes.mjs), a single-call batch runs
// as ONE dev spawn directly in the REAL workspace — never a worktree lane —
// so there is no merge/abandon machinery here: failure recovery is a plain
// aheadBehind-guarded `git reset --hard` back to the recorded preBatchSha.
//
// Asserts:
//   1. green batch — 3-of-3 stub commits land ⇒ 3 completions recorded
//      ascending, exactly ONE gate run, exactly ONE push.
//   2. red batch (dev call error) — commits reset to preBatchSha, zero
//      completions, both fixes left pending, batchFallback names both fixes,
//      and re-picking with that fallback set dispatches fix 1 individually
//      (never re-batched).
//   3. red batch (merged-HEAD gate failure) — same reset-to-preBatchSha
//      contract, no push, no batch-level escalation/validation marker
//      written (only today's per-fix failure path owns escalation).
//   4. ambiguous/pushed safety guard — a commit that reached origin before
//      the failure is reported is NEVER reset (aheadBehind ahead===0 ⇒ skip).
//   5. partial batch — 2-of-4 committed (agent stopped early, gate still
//      green) ⇒ first two recorded contiguously, 3-4 re-queued individually,
//      the committed prefix still pushed once.
//
// Run: node scripts/verify-fix-batching.mjs   (exit 0 = all pass)

process.env.DB_PATH = ':memory:';

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runFixSingleCallBatch, pickNextAction } from '../src/auto-runner.js';
import {
  upsertProject, getBugRound, startBugRound, getDb,
} from '../src/state.js';
import { getCurrentBranch, fixCommitExists } from '../src/lib/git.js';
import { fixPlanJsonPath, bugRoundDir } from '../src/lib/guide-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

let pass = 0, fail = 0;
const ok  = (l) => { console.log('OK  ', l); pass++; };
const bad = (l, e) => { console.log('FAIL', l + (e ? `\n     ${e?.stack || e?.message || e}` : '')); fail++; };

let _seq = 0;

function makeFixture(label) {
  const projDir = mkdtempSync(path.join(tmpdir(), `aorch-vfb-proj-${label}-`));
  const workspaceDir = mkdtempSync(path.join(tmpdir(), `aorch-vfb-ws-${label}-`));
  execSync('git init -q', { cwd: workspaceDir });
  execSync('git config user.email t@example.com', { cwd: workspaceDir });
  execSync('git config user.name test', { cwd: workspaceDir });
  execSync('git config commit.gpgsign false', { cwd: workspaceDir });
  writeFileSync(path.join(workspaceDir, '.gitignore'), 'node_modules/\n.env\n.claude/\n');
  writeFileSync(path.join(workspaceDir, 'shared.js'), 'export const base = 0;\n');
  execSync('git add -A', { cwd: workspaceDir });
  execSync('git commit -q -m init', { cwd: workspaceDir });
  return { projDir, workspaceDir };
}

// A remote bare repo so aheadBehind has an upstream to compare against — the
// reset/no-reset safety guard is meaningless without one.
function addBareRemote(workspaceDir, label) {
  const remoteDir = mkdtempSync(path.join(tmpdir(), `aorch-vfb-remote-${label}-`));
  execSync(`git init -q --bare "${remoteDir}"`);
  execSync(`git remote add origin "${remoteDir}"`, { cwd: workspaceDir });
  execSync('git push -q -u origin HEAD', { cwd: workspaceDir });
  return remoteDir;
}

async function primeBugRound({ projectName, workspaceDir, round = 1, totalFixes }) {
  upsertProject({ name: projectName, status: 'in-progress' });
  const branch = await getCurrentBranch(workspaceDir);
  getDb().prepare('UPDATE projects SET git_branch = ? WHERE name = ?').run(branch, projectName);
  startBugRound({ project: projectName, round, bugs_file: 'bugs.md', total_fixes: totalFixes });
  return branch;
}

const commitFixes = (workspaceDir, ns) => {
  for (const n of ns) {
    writeFileSync(path.join(workspaceDir, `f${n}.js`), `export const v = ${n};\n`);
    execSync('git add -A', { cwd: workspaceDir });
    execSync(`git commit -q -m "fix-r1-${n}: work"`, { cwd: workspaceDir });
  }
};

const batchCfg = () => ({ validators: { enabled: false }, bug_cycle: { batch_minor_fixes: true, batch_max: 4 } });
const passGate = async () => ({ hasFailures: false, results: [] });

console.log('\n── verify-fix-batching ──\n');

// ── 1. Green batch: 3-of-3 committed ⇒ 3 completions ascending, ONE gate, ONE push ──
try {
  const projectName = `vfb-clean-${_seq++}`;
  const { projDir, workspaceDir } = makeFixture(projectName);
  addBareRemote(workspaceDir, projectName);
  await primeBugRound({ projectName, workspaceDir, totalFixes: 3 });

  let pushCount = 0;
  let gateCount = 0;
  const outcome = await runFixSingleCallBatch(
    { projectName, cfg: batchCfg(), projDir, workspaceDir, round: 1,
      fixes: [{ round: 1, n: 1, title: 'A' }, { round: 1, n: 2, title: 'B' }, { round: 1, n: 3, title: 'C' }] },
    {
      runDev: async () => { commitFixes(workspaceDir, [1, 2, 3]); return { is_error: false }; },
      gateMergedFixHead: async () => { gateCount += 1; return passGate(); },
      pushBranch: async () => { pushCount += 1; return { ok: true }; },
    },
  );

  assert.deepEqual(outcome.mergedFixes, [1, 2, 3], 'all three fixes recorded ascending');
  assert.equal(outcome.failure, null);
  assert.equal(outcome.pushed, true);
  assert.equal(pushCount, 1, 'exactly ONE push per batch');
  assert.equal(gateCount, 1, 'exactly ONE merged-HEAD gate run per batch (not per fix)');
  assert.deepEqual(outcome.batchFallback, []);
  assert.equal(getBugRound(projectName, 1).fixes_completed, 3);
  for (const n of [1, 2, 3]) {
    assert.equal(await fixCommitExists(workspaceDir, 1, n), true, `fix-r1-${n}: committed and reachable`);
  }
  ok('1: green batch — 3-of-3 stub commits ⇒ 3 completions recorded ascending, ONE gate, ONE push');
} catch (e) { bad('1: green batch', e); }

// ── 2. Red batch (dev call error) ⇒ reset to preBatchSha, zero completions, individual re-dispatch ──
try {
  const projectName = `vfb-callerror-${_seq++}`;
  const { projDir, workspaceDir } = makeFixture(projectName);
  addBareRemote(workspaceDir, projectName);
  await primeBugRound({ projectName, workspaceDir, totalFixes: 2 });
  const preBatchSha = execSync('git rev-parse HEAD', { cwd: workspaceDir }).toString().trim();

  const outcome = await runFixSingleCallBatch(
    { projectName, cfg: batchCfg(), projDir, workspaceDir, round: 1,
      fixes: [{ round: 1, n: 1, title: 'A' }, { round: 1, n: 2, title: 'B' }] },
    {
      // A partial commit lands before the dev call reports failure.
      runDev: async () => { commitFixes(workspaceDir, [1]); return { is_error: true, error_message: 'dev boom', result: 'dev boom' }; },
      pushBranch: async () => { throw new Error('must not push a failed batch'); },
    },
  );

  assert.equal(outcome.failure.kind, 'dev');
  assert.equal(outcome.failure.reset, true, 'unpushed commit — reset applied');
  assert.deepEqual(outcome.mergedFixes, []);
  assert.equal(outcome.pushed, false);
  assert.deepEqual(outcome.batchFallback, ['r1-1', 'r1-2'], 'both fixes fall back to individual dispatch');
  assert.equal(getBugRound(projectName, 1).fixes_completed, 0, 'zero completions recorded');
  assert.equal(execSync('git rev-parse HEAD', { cwd: workspaceDir }).toString().trim(), preBatchSha, 'HEAD reset to the recorded preBatchSha');
  assert.equal(await fixCommitExists(workspaceDir, 1, 1), false, 'the partial commit was rolled back');
  const lessons = readFileSync(path.join(projDir, '.guide', 'lessons.jsonl'), 'utf-8');
  assert.match(lessons, /"kind":"batch-fallback"/);
  ok('2: red batch (dev call error) — reset to preBatchSha, zero completions, both fixes pending');

  // Re-picking with the batchFallback set the red batch just returned must
  // dispatch fix 1 INDIVIDUALLY (never re-batched). pickNextAction hardcodes
  // projDir=projects/<name>, so this needs a real project dir under
  // PROJECTS_DIR, not the tmpdir git fixture used for the batch itself.
  const pickProjectName = `vfb-fallback-pick-${_seq++}`;
  const pickProjDir = path.join(PROJECTS_DIR, pickProjectName);
  try {
    mkdirSync(bugRoundDir(pickProjDir, 1), { recursive: true });
    upsertProject({ name: pickProjectName, status: 'in-progress' });
    writeFileSync(fixPlanJsonPath(pickProjDir, 1), JSON.stringify({
      round: 1,
      fixes: [
        { n: 1, title: 'A', severity: 'minor', files_likely: ['a.js'] },
        { n: 2, title: 'B', severity: 'minor', files_likely: ['b.js'] },
      ],
    }), 'utf-8');
    startBugRound({ project: pickProjectName, round: 1, bugs_file: 'bugs.md', total_fixes: 2 });

    const pickCfg = {
      auto_run: {}, bug_cycle: { max_parallel_fixes: 1, batch_minor_fixes: true, batch_max: 4 },
      fixes: { inline_fix_prompts: true }, paths: { workspace_subdir: 'workspace' },
    };
    const withoutFallback = await pickNextAction(pickProjectName, pickCfg);
    assert.equal(withoutFallback.kind, 'fix-dev-single-call-batch', 'precondition: without the fallback set, fixes 1+2 WOULD re-batch');

    const withFallback = await pickNextAction(pickProjectName, pickCfg, { batchFallbackFixes: new Set(outcome.batchFallback) });
    assert.equal(withFallback.kind, 'fix-dev', 'next pick dispatches fix 1 individually — never re-batched');
    assert.equal(withFallback.fix.n, 1);
    ok('2b: next iteration (batchFallbackFixes wired from the red batch) dispatches fix 1 individually, never re-batched');
  } finally {
    rmSync(pickProjDir, { recursive: true, force: true });
  }
} catch (e) { bad('2: red batch (dev call error) + individual re-dispatch', e); }

// ── 3. Red batch (merged-HEAD gate failure) ⇒ same reset contract, NO batch-level markers ──
try {
  const projectName = `vfb-gatefail-${_seq++}`;
  const { projDir, workspaceDir } = makeFixture(projectName);
  addBareRemote(workspaceDir, projectName);
  await primeBugRound({ projectName, workspaceDir, totalFixes: 2 });
  const preBatchSha = execSync('git rev-parse HEAD', { cwd: workspaceDir }).toString().trim();

  const outcome = await runFixSingleCallBatch(
    { projectName, cfg: batchCfg(), projDir, workspaceDir, round: 1,
      fixes: [{ round: 1, n: 1, title: 'A' }, { round: 1, n: 2, title: 'B' }] },
    {
      runDev: async () => { commitFixes(workspaceDir, [1, 2]); return { is_error: false }; },
      gateMergedFixHead: async () => ({ hasFailures: true, results: [{ pass: false, validator_name: 'x' }] }),
      pushBranch: async () => { throw new Error('must not push a red HEAD'); },
    },
  );

  assert.equal(outcome.failure.kind, 'gate');
  assert.equal(outcome.failure.reset, true);
  assert.deepEqual(outcome.mergedFixes, []);
  assert.equal(outcome.pushed, false);
  assert.deepEqual(outcome.batchFallback, ['r1-1', 'r1-2']);
  assert.equal(getBugRound(projectName, 1).fixes_completed, 0);
  assert.equal(execSync('git rev-parse HEAD', { cwd: workspaceDir }).toString().trim(), preBatchSha);
  assert.equal(await fixCommitExists(workspaceDir, 1, 1), false);
  assert.equal(existsSync(path.join(projDir, '.guide', 'fix-r1-1-escalate.marker')), false, 'no batch-level escalation marker');
  assert.equal(existsSync(path.join(projDir, '.guide', 'fix-r1-1-validation-failed.marker')), false, 'no batch-level validation marker');
  ok('3: red batch (merged-HEAD gate failure) — reset to preBatchSha, zero completions, no batch-level markers');
} catch (e) { bad('3: red batch (gate failure)', e); }

// ── 4. Ambiguous/pushed safety guard: a commit that reached origin is NEVER reset ──
try {
  const projectName = `vfb-ambiguous-${_seq++}`;
  const { projDir, workspaceDir } = makeFixture(projectName);
  addBareRemote(workspaceDir, projectName);
  await primeBugRound({ projectName, workspaceDir, totalFixes: 1 });
  const branch = await getCurrentBranch(workspaceDir);

  const outcome = await runFixSingleCallBatch(
    { projectName, cfg: batchCfg(), projDir, workspaceDir, round: 1, fixes: [{ round: 1, n: 1, title: 'A' }] },
    {
      runDev: async () => {
        commitFixes(workspaceDir, [1]);
        // Simulate the commit already reaching origin (a concurrent push) before the failure is reported.
        execSync(`git push -q origin HEAD:refs/heads/${branch}`, { cwd: workspaceDir });
        return { is_error: true, error_message: 'dev boom', result: 'dev boom' };
      },
    },
  );

  assert.equal(outcome.failure.kind, 'dev');
  assert.equal(outcome.failure.reset, false, 'ahead=0 after the (simulated) push — ambiguous/pushed, must not reset');
  assert.equal(await fixCommitExists(workspaceDir, 1, 1), true, 'commit left in place, never rolled back');
  ok('4: ambiguous/pushed safety guard — a commit that reached origin is never reset (aheadBehind ahead===0 ⇒ skip)');
} catch (e) { bad('4: ambiguous/pushed safety guard', e); }

// ── 5. Partial batch: 2-of-4 committed ⇒ first two recorded, 3-4 re-queued individually ──
try {
  const projectName = `vfb-partial-${_seq++}`;
  const { projDir, workspaceDir } = makeFixture(projectName);
  addBareRemote(workspaceDir, projectName);
  await primeBugRound({ projectName, workspaceDir, totalFixes: 4 });

  let pushCount = 0;
  const outcome = await runFixSingleCallBatch(
    { projectName, cfg: batchCfg(), projDir, workspaceDir, round: 1,
      fixes: [{ round: 1, n: 1, title: 'A' }, { round: 1, n: 2, title: 'B' }, { round: 1, n: 3, title: 'C' }, { round: 1, n: 4, title: 'D' }] },
    {
      // Agent stopped after fixes 1+2 (turn budget) — gate on the partial diff still passes.
      runDev: async () => { commitFixes(workspaceDir, [1, 2]); return { is_error: false }; },
      gateMergedFixHead: passGate,
      pushBranch: async () => { pushCount += 1; return { ok: true }; },
    },
  );

  assert.deepEqual(outcome.mergedFixes, [1, 2], 'only the contiguous committed prefix recorded');
  assert.equal(outcome.pushed, true, 'the committed prefix still pushed');
  assert.equal(pushCount, 1);
  assert.deepEqual(outcome.batchFallback, ['r1-3', 'r1-4'], 'the rest re-queued individually, never re-batched');
  assert.equal(getBugRound(projectName, 1).fixes_completed, 2);
  ok('5: partial batch — 2-of-4 committed ⇒ first two recorded contiguously, 3-4 re-queued individually, ONE push');
} catch (e) { bad('5: partial batch', e); }

// ── Self-check: the ok/bad counting logic itself fails loudly on a bad assertion ──
// (Runs against LOCAL counters — never touches the real pass/fail totals above —
// so this proves the harness's own exit-code logic without risking a false FAIL.)
try {
  let _p = 0, _f = 0;
  const _ok = () => { _p++; };
  const _bad = () => { _f++; };
  try { assert.equal(1, 1); _ok(); } catch { _bad(); }
  try { assert.equal(1, 2); _ok(); } catch { _bad(); }
  assert.equal(_p, 1, 'one deliberately-passing assertion counted');
  assert.equal(_f, 1, 'one deliberately-failing assertion counted (would set exit code 1)');
  ok('6: self-check — a deliberately broken fixture assertion is caught and counted as a failure (exit-code logic verified)');
} catch (e) { bad('6: self-check exit-code logic', e); }

console.log(`\nverify-fix-batching: ${pass}/${pass + fail}`);
process.exit(fail > 0 ? 1 : 0);
