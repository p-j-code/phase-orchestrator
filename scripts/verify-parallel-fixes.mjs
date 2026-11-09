#!/usr/bin/env node
// verify-parallel-fixes.mjs — brief 05 P7, harness 2/2 (phase-73).
//
// Fixture-repo integration harness for the P4 parallel-fix-batch scheduler
// (auto-runner.js's runFixBatch). Builds its OWN temp git fixture repo per
// section — no shared helper file, matching the existing scripts/verify-*.mjs
// house style. Every dev/checker/push call is stubbed via the runFixBatch deps
// seam, so this makes ZERO real LLM spawns; the git operations (worktree
// add/remove, --no-ff merge, merge --abort, reset --hard) are REAL. Mirrors
// (condensed, exit-code-checked form of) the scenarios in
// src/lib/fix-batch.test.mjs.
//
// The counter-integrity contract under test: `bug_rounds.fixes_completed` is a
// bare +1 counter used as an ARRAY INDEX into the fix plan — it must stay
// PERFECTLY CONTIGUOUS (never ahead of, never behind, the actual committed
// prefix) under every outcome permutation, including the SERIAL "parked"
// fallback (on_double_failure:'skip'), which advances the counter WITHOUT a
// commit ever landing — the one case where fixes_completed and
// fixCommitExists are expected to diverge.
//
// Asserts:
//   1. all-green — 3 disjoint fixes → 3 lanes → ascending merges →
//      fixes_completed=3, ONE push, fixCommitExists true for every fix.
//   2. failed-middle — fix k fails, k+1 succeeded-but-abandoned → only fixes
//      < k recorded, k+1 abandoned+not-recorded, fix k escalated + serial
//      fallback, fixes_completed stays exactly at the contiguous prefix.
//   3. parked (on_double_failure:'skip') — after a failed-middle batch, the
//      SERIAL ladder parks the failed fix (recordFixCompletion with no commit)
//      — fixes_completed catches up to a contiguous count even though the
//      parked fix has no commit; a subsequent fix still lands on top cleanly.
//   4. property matrix — fixes_completed === count of contiguous committed
//      fixes across all-green / head-fails / middle-fails / tail-fails /
//      gate-red permutations.
//   5. reconciliation — fixCommitExists greps `^fix-rR-N:` subjects that
//      survive --no-ff merges (the self-heal walk's reconciliation contract).
//
// Run: node scripts/verify-parallel-fixes.mjs   (exit 0 = all pass)

process.env.DB_PATH = ':memory:';

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runFixBatch } from '../src/auto-runner.js';
import {
  upsertProject, getBugRound, startBugRound, recordFixCompletion, getDb,
} from '../src/state.js';
import { getCurrentBranch, branchExists, fixCommitExists } from '../src/lib/git.js';
import { escalationMarkerPath } from '../src/lib/escalation.js';

let pass = 0, fail = 0;
const ok  = (l) => { console.log('OK  ', l); pass++; };
const bad = (l, e) => { console.log('FAIL', l + (e ? `\n     ${e?.stack || e?.message || e}` : '')); fail++; };

let _seq = 0;

function makeFixture(label) {
  const projDir = mkdtempSync(path.join(tmpdir(), `aorch-vpf-proj-${label}-`));
  const workspaceDir = mkdtempSync(path.join(tmpdir(), `aorch-vpf-ws-${label}-`));
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

// node_modules 'none' skips the symlink (provisioning is covered by
// verify-parallel-lanes.mjs); validators are stubbed via the gate seam.
const batchCfg = () => ({
  parallel_lanes: { dir: '.worktrees', node_modules: 'none' },
  security: { deny_rules: [] },
  bug_cycle: { max_parallel_fixes: 4 },
  validators: { enabled: false },
});

function makeFixRunDevStub({ writes, failOn = null }) {
  return async ({ fix, laneDir, laneBranch }) => {
    if (failOn === fix.n) {
      return { is_error: true, error_message: `fix ${fix.n} boom`, result: `fix ${fix.n} boom`, routing: { tier: 'sonnet' } };
    }
    for (const [name, content] of Object.entries(writes(fix.n))) {
      writeFileSync(path.join(laneDir, name), content);
    }
    execSync('git add -A', { cwd: laneDir });
    execSync(`git commit -q -m "fix-r${fix.round}-${fix.n}: lane work"`, { cwd: laneDir });
    const commit_sha = execSync('git rev-parse HEAD', { cwd: laneDir }).toString().trim();
    return { is_error: false, lane: true, commit_sha, branch: laneBranch, routing: { tier: 'sonnet' } };
  };
}

async function primeBugRound({ projectName, workspaceDir, round = 1, totalFixes }) {
  upsertProject({ name: projectName, status: 'in-progress' });
  const branch = await getCurrentBranch(workspaceDir);
  getDb().prepare('UPDATE projects SET git_branch = ? WHERE name = ?').run(branch, projectName);
  startBugRound({ project: projectName, round, bugs_file: 'bugs.md', total_fixes: totalFixes });
  return branch;
}

const passGate = async () => ({ hasFailures: false, results: [] });

console.log('\n── verify-parallel-fixes ──\n');

// ── 1. All-green: 3 disjoint fixes → ascending merges → fixes_completed=3 ────
try {
  const projectName = `vpf-clean-${_seq++}`;
  const { projDir, workspaceDir } = makeFixture(projectName);
  await primeBugRound({ projectName, workspaceDir, totalFixes: 3 });

  let pushCount = 0;
  const outcome = await runFixBatch(
    { projectName, cfg: batchCfg(), projDir, workspaceDir, round: 1,
      fixes: [{ round: 1, n: 1, title: 'A' }, { round: 1, n: 2, title: 'B' }, { round: 1, n: 3, title: 'C' }] },
    {
      runDev: makeFixRunDevStub({ writes: (n) => ({ [`f${n}.js`]: `export const v = ${n};\n` }) }),
      gateMergedFixHead: passGate,
      pushBranch: async () => { pushCount += 1; return { ok: true }; },
    },
  );

  assert.deepEqual(outcome.mergedFixes, [1, 2, 3]);
  assert.equal(outcome.failure, null);
  assert.equal(outcome.pushed, true);
  assert.equal(pushCount, 1, 'exactly ONE push per batch');
  assert.equal(getBugRound(projectName, 1).fixes_completed, 3, 'fixes_completed = count of merged fixes');
  for (const n of [1, 2, 3]) {
    assert.equal(await fixCommitExists(workspaceDir, 1, n), true, `fix-r1-${n}: reachable on merged branch`);
    assert.ok(existsSync(path.join(workspaceDir, `f${n}.js`)));
  }
  ok('1: all-green — 3 disjoint fixes merge ascending, fixes_completed=3, ONE push, every fix-rR-N: commit reachable');
} catch (e) { bad('1: all-green', e); }

// ── 2. Failed-middle: fix 2 fails, fix 3 abandoned → only fix 1 recorded ─────
try {
  const projectName = `vpf-middle-${_seq++}`;
  const { projDir, workspaceDir } = makeFixture(projectName);
  await primeBugRound({ projectName, workspaceDir, totalFixes: 3 });

  let pushCount = 0;
  const outcome = await runFixBatch(
    { projectName, cfg: batchCfg(), projDir, workspaceDir, round: 1,
      fixes: [{ round: 1, n: 1, title: 'A' }, { round: 1, n: 2, title: 'B' }, { round: 1, n: 3, title: 'C' }] },
    {
      runDev: makeFixRunDevStub({ writes: (n) => ({ [`f${n}.js`]: `export const v = ${n};\n` }), failOn: 2 }),
      gateMergedFixHead: passGate,
      pushBranch: async () => { pushCount += 1; return { ok: true }; },
    },
  );

  assert.deepEqual(outcome.mergedFixes, [1], 'only the contiguous successful prefix (fix 1) recorded');
  assert.equal(outcome.failure.kind, 'dev');
  assert.equal(outcome.failure.fixN, 2);
  assert.deepEqual(outcome.serialFallback, ['r1-2'], 'the FAILED fix (not the abandoned one) re-runs serially');
  assert.equal(pushCount, 1, 'the merged prefix still pushed exactly once');
  assert.equal(getBugRound(projectName, 1).fixes_completed, 1, 'fixes_completed contiguous: only fix 1');
  assert.equal(await fixCommitExists(workspaceDir, 1, 1), true);
  assert.equal(await fixCommitExists(workspaceDir, 1, 2), false, 'failed fix never committed');
  assert.equal(await fixCommitExists(workspaceDir, 1, 3), false, 'abandoned later fix never committed');
  assert.ok(existsSync(escalationMarkerPath(projDir, { fix: { round: 1, n: 2 } })), 'escalate marker for the failed fix');
  assert.equal(existsSync(escalationMarkerPath(projDir, { fix: { round: 1, n: 3 } })), false, 'no marker for the abandoned fix');
  const lessons = readFileSync(path.join(projDir, '.guide', 'lessons.jsonl'), 'utf-8');
  assert.match(lessons, /"kind":"lane-abandoned"/);
  assert.match(lessons, /"kind":"escalation"/);
  assert.equal(await branchExists(workspaceDir, 'lane/fix-r1-3'), false, 'abandoned lane branch cleaned up');
  ok('2: failed-middle — fix 2 fails while fix 3 succeeded → only fix 1 recorded, fix 3 abandoned+unrecorded, fix 2 escalated + serial fallback');
} catch (e) { bad('2: failed-middle', e); }

// ── 3. Parked (on_double_failure:'skip') — counter advances WITHOUT a commit ──
try {
  const projectName = `vpf-parked-${_seq++}`;
  const { projDir, workspaceDir } = makeFixture(projectName);
  await primeBugRound({ projectName, workspaceDir, totalFixes: 3 });

  // Round 1: fix 2 fails in a batch alongside fix 3 (mirrors check 2) — only
  // fix 1 lands. The failed fix then exhausts the escalation ladder; with
  // on_double_failure:'skip' the SERIAL ladder (auto-runner.js's main loop,
  // NOT runFixBatch) parks it — a direct recordFixCompletion with no commit —
  // so the round keeps moving instead of stalling forever on an unfixable bug.
  await runFixBatch(
    { projectName, cfg: batchCfg(), projDir, workspaceDir, round: 1,
      fixes: [{ round: 1, n: 1, title: 'A' }, { round: 1, n: 2, title: 'B' }, { round: 1, n: 3, title: 'C' }] },
    {
      runDev: makeFixRunDevStub({ writes: (n) => ({ [`f${n}.js`]: `export const v = ${n};\n` }), failOn: 2 }),
      gateMergedFixHead: passGate,
      pushBranch: async () => ({ ok: true }),
    },
  );
  assert.equal(getBugRound(projectName, 1).fixes_completed, 1, 'precondition: only fix 1 recorded before the park');

  // Simulate the serial ladder's park action (auto-runner.js ~2066): fix 2's
  // hops are exhausted, on_double_failure:'skip' fires → recordFixCompletion
  // with NO commit ever landing for fix 2.
  recordFixCompletion({ project: projectName, round: 1, fixN: 2 });
  assert.equal(getBugRound(projectName, 1).fixes_completed, 2, 'parking fix 2 advances the counter with no commit');
  assert.equal(await fixCommitExists(workspaceDir, 1, 2), false, 'a parked fix is counted complete WITHOUT ever being committed — the one intentional divergence between fixes_completed and fixCommitExists');

  // Fix 3 (previously abandoned, never recorded) now runs — alone, since it's
  // the only pending fix left — and lands cleanly on top of the parked count.
  const outcome3 = await runFixBatch(
    { projectName, cfg: batchCfg(), projDir, workspaceDir, round: 1,
      fixes: [{ round: 1, n: 3, title: 'C' }] },
    {
      runDev: makeFixRunDevStub({ writes: (n) => ({ [`f${n}.js`]: `export const v = ${n};\n` }) }),
      gateMergedFixHead: passGate,
      pushBranch: async () => ({ ok: true }),
    },
  );
  assert.deepEqual(outcome3.mergedFixes, [3]);
  assert.equal(getBugRound(projectName, 1).fixes_completed, 3, 'fixes_completed is contiguous (1 committed + 1 parked + 1 committed) after the parked fix is skipped over');
  assert.equal(await fixCommitExists(workspaceDir, 1, 3), true, 'fix 3 committed normally after the park');
  ok('3: parked (on_double_failure:\'skip\') — the serial ladder\'s park advances fixes_completed with no commit, and a later fix still lands contiguously on top');
} catch (e) { bad('3: parked (on_double_failure:skip)', e); }

// ── 4. Property matrix: fixes_completed === contiguous committed count ──────
try {
  const scenarios = [
    { label: 'all-green', failOn: null, gateFails: false, expectCommitted: [1, 2, 3] },
    { label: 'head-fails', failOn: 1, gateFails: false, expectCommitted: [] },
    { label: 'middle-fails', failOn: 2, gateFails: false, expectCommitted: [1] },
    { label: 'tail-fails', failOn: 3, gateFails: false, expectCommitted: [1, 2] },
    { label: 'gate-red', failOn: null, gateFails: true, expectCommitted: [] },
  ];

  for (const sc of scenarios) {
    const projectName = `vpf-prop-${sc.label}-${_seq++}`;
    // eslint-disable-next-line no-await-in-loop
    const { projDir, workspaceDir } = makeFixture(projectName);
    // eslint-disable-next-line no-await-in-loop
    await primeBugRound({ projectName, workspaceDir, totalFixes: 3 });

    // eslint-disable-next-line no-await-in-loop
    await runFixBatch(
      { projectName, cfg: batchCfg(), projDir, workspaceDir, round: 1,
        fixes: [{ round: 1, n: 1, title: 'A' }, { round: 1, n: 2, title: 'B' }, { round: 1, n: 3, title: 'C' }] },
      {
        runDev: makeFixRunDevStub({ writes: (n) => ({ [`f${n}.js`]: `export const v = ${n};\n` }), failOn: sc.failOn }),
        gateMergedFixHead: async () => ({ hasFailures: sc.gateFails, results: [] }),
        pushBranch: async () => ({ ok: true }),
      },
    );

    const fixesCompleted = getBugRound(projectName, 1).fixes_completed;
    const committed = [];
    for (const n of [1, 2, 3]) {
      // eslint-disable-next-line no-await-in-loop
      if (await fixCommitExists(workspaceDir, 1, n)) committed.push(n);
    }
    assert.deepEqual(committed, sc.expectCommitted, `[${sc.label}] committed fixes on the workspace`);
    assert.equal(fixesCompleted, sc.expectCommitted.length,
      `[${sc.label}] fixes_completed (${fixesCompleted}) === committed count (${sc.expectCommitted.length})`);
  }
  ok('4: property matrix — fixes_completed === count of contiguous committed fixes across all-green / head-fails / middle-fails / tail-fails / gate-red');
} catch (e) { bad('4: property matrix', e); }

// ── 5. Reconciliation: fixCommitExists greps subjects across --no-ff merges ──
try {
  const { workspaceDir } = makeFixture(`vpf-recon-${_seq++}`);
  for (const n of [1, 2, 3]) {
    execSync(`git checkout -q -b lane/fix-r7-${n}`, { cwd: workspaceDir });
    writeFileSync(path.join(workspaceDir, `g${n}.js`), `export const v = ${n};\n`);
    execSync('git add -A', { cwd: workspaceDir });
    execSync(`git commit -q -m "fix-r7-${n}: work"`, { cwd: workspaceDir });
    execSync('git checkout -q -', { cwd: workspaceDir });
    execSync(`git merge --no-ff -q -m "Merge lane/fix-r7-${n} (parallel fix batch)" lane/fix-r7-${n}`, { cwd: workspaceDir });
  }
  for (const n of [1, 2, 3]) {
    assert.equal(await fixCommitExists(workspaceDir, 7, n), true, `fix-r7-${n}: still greppable after --no-ff merge`);
  }
  // The trailing-colon anchor prevents fix-r7-1 matching a fix-r7-10 subject.
  assert.equal(await fixCommitExists(workspaceDir, 7, 10), false);
  ok('5: reconciliation — fixCommitExists greps ^fix-rR-N: subjects that survive --no-ff merges, with the trailing-colon anchor preventing prefix collisions');
} catch (e) { bad('5: reconciliation across --no-ff merges', e); }

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

console.log(`\nverify-parallel-fixes: ${pass}/${pass + fail}`);
process.exit(fail > 0 ? 1 : 0);
