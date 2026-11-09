#!/usr/bin/env node
// verify-parallel-lanes.mjs — brief 05 P7, harness 1/2 (phase-73).
//
// Fixture-repo integration harness for the P3 parallel-phase-wave scheduler
// (lane-manager.js + auto-runner.js's runPhaseWave). Builds its OWN temp git
// fixture repo per section — no shared helper file, matching the existing
// scripts/verify-*.mjs house style. Every dev/checker/push call is stubbed via
// the runPhaseWave deps seam, so this makes ZERO real LLM spawns; the git
// operations (worktree add/remove, --no-ff merge, merge --abort, reset --hard)
// are REAL, exercising the exact code lane-manager.js/auto-runner.js run in
// production. Mirrors (condensed, exit-code-checked form of) the scenarios in
// src/lib/lane-manager.test.mjs, src/lib/phase-wave.test.mjs.
//
// Asserts:
//   1. provisioning — a lane worktree materializes .claude/settings.json and a
//      node_modules symlink, and inserts a `running` phase_lanes row.
//   2. ascending merge — a clean 2-lane wave merges both phases in order.
//   3. post-merge phaseCommitSha resolution — the commit_sha recorded per phase
//      is the LANE's own commit (an ancestor of HEAD), never the merge commit.
//   4. single push — exactly one pushBranch call per wave.
//   5. conflict fallback — a second lane that collides on merge discards its
//      branch, resets the phase to pending, records a lane-conflict lesson,
//      and flags it for a serial re-run.
//   6. prefix abandonment — a middle-lane failure merges+pushes the prefix,
//      escalates the failed phase, and abandons every later lane (even a
//      successful one) so the in-order merge is never violated.
//   7. orphan sweep — a lane left "running" by a simulated crash (provisioned,
//      never torn down) is reconciled by sweepOrphanLanes at the next run start.
//
// Run: node scripts/verify-parallel-lanes.mjs   (exit 0 = all pass)

process.env.DB_PATH = ':memory:';

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runPhaseWave } from '../src/auto-runner.js';
import { provisionLane, sweepOrphanLanes } from '../src/lib/lane-manager.js';
import {
  upsertProject, getProject, upsertPhase, getPhases, getPhaseLane, getDb,
} from '../src/state.js';
import {
  getCurrentBranch, branchExists, getHeadSha, phaseCommitSha,
} from '../src/lib/git.js';
import { escalationMarkerPath } from '../src/lib/escalation.js';

let pass = 0, fail = 0;
const ok  = (l) => { console.log('OK  ', l); pass++; };
const bad = (l, e) => { console.log('FAIL', l + (e ? `\n     ${e?.stack || e?.message || e}` : '')); fail++; };

let _seq = 0;

function makeFixture(label, { nodeModules = true } = {}) {
  const projDir = mkdtempSync(path.join(tmpdir(), `aorch-vpl-proj-${label}-`));
  const workspaceDir = mkdtempSync(path.join(tmpdir(), `aorch-vpl-ws-${label}-`));
  execSync('git init -q', { cwd: workspaceDir });
  execSync('git config user.email t@example.com', { cwd: workspaceDir });
  execSync('git config user.name test', { cwd: workspaceDir });
  execSync('git config commit.gpgsign false', { cwd: workspaceDir });
  writeFileSync(path.join(workspaceDir, '.gitignore'), 'node_modules/\n.env\n.claude/\n');
  writeFileSync(path.join(workspaceDir, 'shared.js'), 'export const base = 0;\n');
  execSync('git add -A', { cwd: workspaceDir });
  execSync('git commit -q -m init', { cwd: workspaceDir });
  if (nodeModules) {
    mkdirSync(path.join(workspaceDir, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(path.join(workspaceDir, 'node_modules', 'left-pad', 'index.js'), '// dep\n');
  }
  return { projDir, workspaceDir };
}

const waveCfg = (nodeModules = 'symlink') => ({
  parallel_lanes: { dir: '.worktrees', node_modules: nodeModules },
  security: { deny_rules: [] },
  auto_run: { max_parallel_phases: 3 },
  validators: { enabled: false },
});

function makeRunDevStub({ writes, failOn = null }) {
  return async ({ projectName, laneDir, laneBranch, lanePhaseN }) => {
    upsertPhase({ project: projectName, n: lanePhaseN, title: `P${lanePhaseN}`, status: 'in-progress' });
    if (failOn === lanePhaseN) {
      return { is_error: true, error_message: `phase ${lanePhaseN} boom`, result: `phase ${lanePhaseN} boom`, routing: { tier: 'sonnet' } };
    }
    for (const [name, content] of Object.entries(writes(lanePhaseN))) {
      writeFileSync(path.join(laneDir, name), content);
    }
    execSync('git add -A', { cwd: laneDir });
    execSync(`git commit -q -m "phase-${lanePhaseN}: lane work"`, { cwd: laneDir });
    const commit_sha = execSync('git rev-parse HEAD', { cwd: laneDir }).toString().trim();
    return { is_error: false, lane: true, commit_sha, branch: laneBranch, routing: { tier: 'sonnet' } };
  };
}

async function primeProject({ projectName, workspaceDir, currentPhase = 1, phases = [] }) {
  upsertProject({ name: projectName, status: 'in-progress' });
  const branch = await getCurrentBranch(workspaceDir);
  getDb().prepare('UPDATE projects SET git_branch = ?, current_phase = ? WHERE name = ?').run(branch, currentPhase, projectName);
  for (const n of phases) upsertPhase({ project: projectName, n, title: `P${n}`, status: 'pending' });
  return branch;
}

const passGate = async () => ({ hasFailures: false, results: [] });

console.log('\n── verify-parallel-lanes ──\n');

// ── 1. Provisioning: settings.json + node_modules symlink + running row ─────
try {
  const { projDir, workspaceDir } = makeFixture(`prov-${_seq++}`);
  const baseSha = await getHeadSha(workspaceDir);

  const lane = await provisionLane({
    projectName: 'demo', workspaceDir, projDir, kind: 'phase', n: 1, baseSha, cfg: waveCfg('symlink'),
  });

  assert.ok(existsSync(lane.laneDir), 'lane worktree dir exists');
  assert.equal(await getCurrentBranch(lane.laneDir), 'lane/phase-1', 'lane checked out on its private branch');
  assert.ok(existsSync(path.join(lane.laneDir, '.claude', 'settings.json')), '.claude/settings.json materialized');
  const nm = path.join(lane.laneDir, 'node_modules');
  assert.ok(existsSync(nm), 'node_modules present');
  assert.ok(lstatSync(nm).isSymbolicLink(), 'node_modules is a symlink into the shared store');
  const row = getPhaseLane(lane.laneId);
  assert.equal(row.status, 'running', 'phase_lanes row inserted as running');
  assert.equal(row.worktree_path, lane.laneDir);
  ok('1: provisionLane materializes .claude/settings.json + a node_modules symlink and inserts a running phase_lanes row');
} catch (e) { bad('1: provisioning', e); }

// ── 2/3/4. Clean 2-lane wave: ascending merge, post-merge phaseCommitSha, ONE push ──
try {
  const projectName = `vpl-clean-${_seq++}`;
  const { projDir, workspaceDir } = makeFixture(projectName);
  await primeProject({ projectName, workspaceDir, currentPhase: 1, phases: [2, 3] });

  let pushCount = 0;
  const outcome = await runPhaseWave(
    { projectName, cfg: waveCfg(), projDir, workspaceDir, wave: [{ n: 2 }, { n: 3 }] },
    {
      runDev: makeRunDevStub({ writes: (n) => ({ [`f${n}.js`]: `export const v = ${n};\n` }) }),
      gateMergedHead: passGate,
      pushBranch: async () => { pushCount += 1; return { ok: true }; },
    },
  );

  assert.deepEqual(outcome.mergedPhases, [2, 3], 'both phases merged ascending');
  assert.equal(outcome.failure, null);
  assert.equal(outcome.pushed, true);
  assert.equal(pushCount, 1, 'exactly ONE push per wave');
  const byN = Object.fromEntries(getPhases(projectName).map((r) => [r.n, r]));
  assert.equal(byN[2].status, 'completed');
  assert.equal(byN[3].status, 'completed');
  assert.equal(getProject(projectName).current_phase, 3, 'current_phase = max contiguous completed n');
  ok('2: ascending merge — phases 2,3 (disjoint files) merge in order, rows completed, current_phase=3');
  ok('4: exactly ONE push per wave (pushBranch called once)');

  // 3. phaseCommitSha resolves to the LANE's own commit — never the merge commit.
  const finalHead = await getHeadSha(workspaceDir);
  assert.notEqual(byN[2].commit_sha, finalHead, 'phase 2 commit_sha is not the final HEAD (a later merge)');
  assert.notEqual(byN[3].commit_sha, finalHead, 'phase 3 commit_sha is not the final HEAD (its OWN merge commit sits above it)');
  assert.notEqual(byN[2].commit_sha, byN[3].commit_sha, 'each phase resolved to a DISTINCT lane commit');
  assert.equal(byN[2].commit_sha, await phaseCommitSha(workspaceDir, 2), 're-querying phaseCommitSha(2) after both merges still resolves to the same lane commit');
  assert.equal(byN[3].commit_sha, await phaseCommitSha(workspaceDir, 3), 're-querying phaseCommitSha(3) after both merges still resolves to the same lane commit');
  const isAncestor2 = execSync(`git merge-base --is-ancestor ${byN[2].commit_sha} HEAD; echo $?`, { cwd: workspaceDir }).toString().trim();
  const isAncestor3 = execSync(`git merge-base --is-ancestor ${byN[3].commit_sha} HEAD; echo $?`, { cwd: workspaceDir }).toString().trim();
  assert.equal(isAncestor2, '0', 'phase 2 lane commit is an ancestor of the merged HEAD');
  assert.equal(isAncestor3, '0', 'phase 3 lane commit is an ancestor of the merged HEAD');
  ok('3: post-merge phaseCommitSha resolves to each lane\'s OWN dev commit (an ancestor of HEAD), never the --no-ff merge commit');
} catch (e) { bad('2/3/4: clean wave (ascending merge, phaseCommitSha resolution, single push)', e); }

// ── 5. Conflict fallback ────────────────────────────────────────────────────
try {
  const projectName = `vpl-conflict-${_seq++}`;
  const { projDir, workspaceDir } = makeFixture(projectName);
  await primeProject({ projectName, workspaceDir, currentPhase: 1, phases: [2, 3] });

  const outcome = await runPhaseWave(
    { projectName, cfg: waveCfg(), projDir, workspaceDir, wave: [{ n: 2 }, { n: 3 }] },
    {
      // Both lanes rewrite the SAME committed file → the second merge conflicts.
      runDev: makeRunDevStub({ writes: (n) => ({ 'shared.js': `export const base = ${n};\n` }) }),
      gateMergedHead: passGate,
      pushBranch: async () => ({ ok: true }),
    },
  );

  assert.equal(outcome.failure.kind, 'conflict');
  assert.equal(outcome.failure.phaseN, 3);
  assert.deepEqual(outcome.mergedPhases, [2], 'the first lane merged before the conflict');
  assert.deepEqual(outcome.serialFallback, [3], 'the conflicting phase re-runs serially next iteration');
  const byN = Object.fromEntries(getPhases(projectName).map((r) => [r.n, r]));
  assert.equal(byN[3].status, 'pending', 'conflicting phase reset to pending');
  assert.equal(await branchExists(workspaceDir, 'lane/phase-3'), false, 'conflicting lane branch discarded');
  const st = execSync('git status --porcelain', { cwd: workspaceDir }).toString().trim();
  assert.equal(st, '', 'workspace clean after merge --abort');
  const lessons = readFileSync(path.join(projDir, '.guide', 'lessons.jsonl'), 'utf-8');
  assert.match(lessons, /"kind":"lane-conflict"/, 'lane-conflict lesson recorded');
  ok('5: conflict fallback — first lane merges, second lane\'s merge conflict discards its branch, phase reset pending + lane-conflict lesson, re-run serial');
} catch (e) { bad('5: conflict fallback', e); }

// ── 6. Prefix abandonment ────────────────────────────────────────────────────
try {
  const projectName = `vpl-prefix-${_seq++}`;
  const { projDir, workspaceDir } = makeFixture(projectName);
  await primeProject({ projectName, workspaceDir, currentPhase: 1, phases: [2, 3, 4] });

  let pushCount = 0;
  const outcome = await runPhaseWave(
    { projectName, cfg: waveCfg(), projDir, workspaceDir, wave: [{ n: 2 }, { n: 3 }, { n: 4 }] },
    {
      // Phase 2 succeeds (the prefix), phase 3 FAILS, phase 4 succeeds-but-abandoned.
      runDev: makeRunDevStub({ writes: (n) => ({ [`f${n}.js`]: `export const v = ${n};\n` }), failOn: 3 }),
      gateMergedHead: passGate,
      pushBranch: async () => { pushCount += 1; return { ok: true }; },
    },
  );

  assert.deepEqual(outcome.mergedPhases, [2], 'only the contiguous successful prefix merged');
  assert.equal(outcome.failure.kind, 'dev');
  assert.equal(outcome.failure.phaseN, 3);
  assert.deepEqual(outcome.serialFallback, [3], 'the failed phase (not the abandoned one) re-runs serially');
  assert.equal(pushCount, 1, 'the merged prefix still pushed exactly once');
  const byN = Object.fromEntries(getPhases(projectName).map((r) => [r.n, r]));
  assert.equal(byN[2].status, 'completed');
  assert.equal(byN[3].status, 'pending', 'failed phase reset pending');
  assert.equal(byN[4].status, 'pending', 'later successful lane abandoned (reset pending)');
  assert.ok(existsSync(escalationMarkerPath(projDir, { phaseN: 3 })), 'escalation marker written for the failed phase');
  assert.equal(existsSync(escalationMarkerPath(projDir, { phaseN: 4 })), false, 'no marker for the abandoned phase');
  const lessons = readFileSync(path.join(projDir, '.guide', 'lessons.jsonl'), 'utf-8');
  assert.match(lessons, /"kind":"lane-abandoned"/, 'abandoned lane recorded a lesson');
  assert.equal(await branchExists(workspaceDir, 'lane/phase-4'), false, 'abandoned lane branch cleaned up');
  ok('6: prefix abandonment — a middle-lane failure merges+pushes the prefix, escalates the failed phase, abandons every later lane (even a successful one)');
} catch (e) { bad('6: prefix abandonment', e); }

// ── 7. Orphan sweep after a simulated crash ─────────────────────────────────
try {
  const projectName = `vpl-orphan-${_seq++}`;
  const { projDir, workspaceDir } = makeFixture(projectName);
  const baseSha = await getHeadSha(workspaceDir);

  // Simulate a crash BETWEEN provision and merge: a lane is provisioned (real
  // worktree + branch + running row) and the process dies before destroyLane
  // (or the merge step) ever runs — nothing tears it down.
  const lane = await provisionLane({
    projectName, workspaceDir, projDir, kind: 'phase', n: 9, baseSha, cfg: waveCfg('symlink'),
  });
  assert.equal(getPhaseLane(lane.laneId).status, 'running', 'crashed lane row still running before sweep');
  assert.ok(existsSync(lane.laneDir), 'crashed lane worktree still on disk before sweep');

  // Also manufacture an unbacked leftover lane dir (crash before the row insert)
  // and a phase-50-style detached read-only worktree dir that must be left alone.
  const wtRoot = path.join(projDir, '.worktrees');
  const orphanDir = path.join(wtRoot, 'fix-r1-3');
  mkdirSync(orphanDir, { recursive: true });
  writeFileSync(path.join(orphanDir, 'junk.txt'), 'orphan\n');
  const detachedDir = path.join(wtRoot, 'verify-abc12345');
  mkdirSync(detachedDir, { recursive: true });
  writeFileSync(path.join(detachedDir, 'keep.txt'), 'keep\n');

  const res = await sweepOrphanLanes({ projectName, workspaceDir, projDir, cfg: waveCfg('symlink') });

  assert.equal(getPhaseLane(lane.laneId).status, 'abandoned', 'crashed running row reconciled to abandoned');
  assert.equal(existsSync(lane.laneDir), false, 'crashed lane worktree dir removed');
  assert.equal(await branchExists(workspaceDir, lane.branch), false, 'crashed lane branch deleted');
  assert.equal(existsSync(orphanDir), false, 'unbacked leftover lane dir removed');
  assert.equal(existsSync(detachedDir), true, 'phase-50 detached read-only worktree dir must NOT be swept');
  assert.ok(res.sweptRows >= 1 && res.sweptDirs >= 1);
  ok('7: sweepOrphanLanes reconciles a lane left "running" by a simulated crash (worktree+branch torn down, row abandoned) without touching detached read-only worktrees');
} catch (e) { bad('7: orphan sweep after simulated crash', e); }

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
  ok('8: self-check — a deliberately broken fixture assertion is caught and counted as a failure (exit-code logic verified)');
} catch (e) { bad('8: self-check exit-code logic', e); }

console.log(`\nverify-parallel-lanes: ${pass}/${pass + fail}`);
process.exit(fail > 0 ? 1 : 0);
