// Parallel phase waves (Phase 68 / brief 05 P3) — src/lib/phase-wave.test.mjs
//
// Fixture-repo integration tests for runPhaseWave with NO real LLM spawn: real
// git worktree lanes (provisionLane) + real merges (mergeNoFf/mergeAbort) + real
// completeMergedPhase bookkeeping, with runDev/gateMergedHead/pushBranch stubbed
// via the deps seam. Proves:
//   - ascending merge of a clean wave (phases 2,3) → both rows completed,
//     current_phase=3, exactly ONE push;
//   - a merge conflict on the second lane → first merges, second's branch gone,
//     phase reset pending, lane-conflict lesson recorded, re-run flagged serial;
//   - the prefix rule → lane N fails, N+1 abandoned, N gets an escalation marker;
//   - mode isolation (selectPhaseWave cap 1 → single phase, no wave).
//
// Run with: node --test src/lib/phase-wave.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DB_PATH = ':memory:';

import { runPhaseWave, computeDevWave } from '../auto-runner.js';
import { selectPhaseWave } from './lane-manager.js';
import {
  upsertProject, getProject, upsertPhase, getPhases, listPhaseLanesForProject,
} from '../state.js';
import { getCurrentBranch, branchExists } from './git.js';
import { escalationMarkerPath } from './escalation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _seq = 0;
function makeFixture(label) {
  const projDir = mkdtempSync(path.join(tmpdir(), `aorch-wave-proj-${label}-`));
  const workspaceDir = mkdtempSync(path.join(tmpdir(), `aorch-wave-ws-${label}-`));
  execSync('git init -q', { cwd: workspaceDir });
  execSync('git config user.email t@example.com', { cwd: workspaceDir });
  execSync('git config user.name test', { cwd: workspaceDir });
  execSync('git config commit.gpgsign false', { cwd: workspaceDir });
  writeFileSync(path.join(workspaceDir, '.gitignore'), 'node_modules/\n.env\n');
  writeFileSync(path.join(workspaceDir, 'shared.js'), 'export const base = 0;\n');
  execSync('git add -A', { cwd: workspaceDir });
  execSync('git commit -q -m init', { cwd: workspaceDir });
  return { projDir, workspaceDir };
}

// A wave cfg: node_modules 'none' skips the symlink (no store needed); validators
// are stubbed via the gateMergedHead seam so nothing spawns.
const waveCfg = () => ({
  parallel_lanes: { dir: '.worktrees', node_modules: 'none' },
  security: { deny_rules: [] },
  auto_run: { max_parallel_phases: 3 },
  validators: { enabled: false },
});

// A runDev stub: each lane writes its file(s) and commits `phase-N: ...` in its
// OWN worktree, mirroring the real lane run (which also upserts an in-progress
// phase row before the early return). Configurable to fail or to collide on a
// shared file to force a merge conflict.
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

import { getDb } from '../state.js';
async function primeProject({ projectName, workspaceDir, currentPhase = 1, phases = [] }) {
  upsertProject({ name: projectName, status: 'in-progress' });
  const branch = await getCurrentBranch(workspaceDir);
  getDb().prepare('UPDATE projects SET git_branch = ?, current_phase = ? WHERE name = ?').run(branch, currentPhase, projectName);
  for (const n of phases) upsertPhase({ project: projectName, n, title: `P${n}`, status: 'pending' });
  return branch;
}

const passGate = async () => ({ hasFailures: false, results: [] });

// ── AC2: clean 2-lane wave → ascending merge, current_phase=3, exactly ONE push ─

test('runPhaseWave: phases 2,3 (disjoint files) merge ascending → rows completed, current_phase=3, exactly ONE push', async () => {
  const projectName = `wave-clean-${_seq++}`;
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

  assert.deepEqual(outcome.mergedPhases, [2, 3]);
  assert.equal(outcome.failure, null);
  assert.equal(outcome.pushed, true);
  assert.equal(pushCount, 1, 'exactly ONE push per wave');

  const byN = Object.fromEntries(getPhases(projectName).map((r) => [r.n, r]));
  assert.equal(byN[2].status, 'completed');
  assert.equal(byN[3].status, 'completed');
  assert.equal(getProject(projectName).current_phase, 3, 'current_phase = max contiguous completed n');

  // Both lane files landed in the primary workspace HEAD; lanes torn down.
  assert.ok(existsSync(path.join(workspaceDir, 'f2.js')));
  assert.ok(existsSync(path.join(workspaceDir, 'f3.js')));
  assert.equal(await branchExists(workspaceDir, 'lane/phase-2'), false, 'lane branch cleaned up');
  assert.equal(await branchExists(workspaceDir, 'lane/phase-3'), false);
  const rows = listPhaseLanesForProject(projectName);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.status === 'done'), 'both lane rows → done');
});

// ── AC3: two lanes collide on disk → first merges, second conflicts → serial ───

test('runPhaseWave: a second lane that conflicts on merge → first merges, conflicting lane discarded, phase pending + lane-conflict lesson + serial re-run', async () => {
  const projectName = `wave-conflict-${_seq++}`;
  const { projDir, workspaceDir } = makeFixture(projectName);
  await primeProject({ projectName, workspaceDir, currentPhase: 1, phases: [2, 3] });

  // Both lanes rewrite the SAME committed file to DIFFERENT content → the second
  // merge (base→v3 onto a HEAD already at v2) conflicts. files_expected LOOKED
  // disjoint upstream; the ascending-merge conflict path is the real backstop.
  const outcome = await runPhaseWave(
    { projectName, cfg: waveCfg(), projDir, workspaceDir, wave: [{ n: 2 }, { n: 3 }] },
    {
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
  assert.equal(byN[2].status, 'completed');
  assert.equal(byN[3].status, 'pending', 'conflicting phase reset to pending');
  assert.equal(getProject(projectName).current_phase, 2);

  // The conflicting lane's branch is GONE and the working tree is clean (no
  // dangling conflict markers — the merge was aborted).
  assert.equal(await branchExists(workspaceDir, 'lane/phase-3'), false, 'conflicting lane branch discarded');
  const st = execSync('git status --porcelain', { cwd: workspaceDir }).toString().trim();
  assert.equal(st, '', 'workspace clean after merge --abort');

  // A lane-conflict lesson was recorded.
  const lessons = readFileSync(path.join(projDir, '.guide', 'lessons.jsonl'), 'utf-8');
  assert.match(lessons, /"kind":"lane-conflict"/);
});

// ── AC4: prefix rule → lane N fails, N+1 abandoned, N gets an escalation marker ─

test('runPhaseWave: prefix rule — a middle lane fails → its prefix merges+pushes, the failed phase escalates, ALL later lanes are abandoned', async () => {
  const projectName = `wave-prefix-${_seq++}`;
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
  assert.equal(getProject(projectName).current_phase, 2);

  // The failed phase entered the existing failure ladder — escalation marker present.
  assert.ok(existsSync(escalationMarkerPath(projDir, { phaseN: 3 })), 'escalation marker written for the failed phase');
  assert.equal(existsSync(escalationMarkerPath(projDir, { phaseN: 4 })), false, 'no marker for the abandoned phase');

  // Both lane branches cleaned up; phase-4's row abandoned, phase-2's done.
  assert.equal(await branchExists(workspaceDir, 'lane/phase-4'), false);
  const lessons = readFileSync(path.join(projDir, '.guide', 'lessons.jsonl'), 'utf-8');
  assert.match(lessons, /"kind":"lane-abandoned"/, 'abandoned lane recorded a lesson');
});

// ── AC1 mode isolation (selector) + AC5 single-implementation (source) ─────────

test('mode isolation: selectPhaseWave with max_parallel_phases:1 returns a single phase — the serial path (no wave)', () => {
  const plan = { phases: [{ n: 2, depends_on: [1], files_expected: ['a.js'] }, { n: 3, depends_on: [1], files_expected: ['b.js'] }] };
  const cfg = { auto_run: { max_parallel_phases: 1 }, phases: {} };
  const { wave } = selectPhaseWave({ plan, phasesTable: [{ n: 1, status: 'completed' }], cfg, dagClean: true });
  assert.equal(wave.length, 1, 'cap 1 never widens the wave');
});

test('mode isolation (auto-runner): BOTH lane entrypoints are gated on max_parallel_phases>1 — a default (cap 1) run makes ZERO lane-manager calls', () => {
  // Per repo convention auto-runner.js has no end-to-end test — mode isolation is
  // proven by source-inspecting that every path reaching the lane manager sits
  // behind an `ar.max_parallel_phases > 1` guard. With the shipped default of 1
  // both short-circuit, so sweepOrphanLanes / selectPhaseWave / provisionLane are
  // unreachable and the serial path runs unchanged.
  const autoRunnerSrc = readFileSync(path.join(__dirname, '..', 'auto-runner.js'), 'utf-8');
  // (a) the run-start orphan sweep. Phase 69 (P4) widened the gate to also fire
  //     for fix lanes (`|| bc.max_parallel_fixes > 1`) — with BOTH caps at their
  //     shipped default of 1 the combined condition is still false, so a default
  //     run makes zero lane-manager calls.
  assert.match(
    autoRunnerSrc,
    /if \(ar\.max_parallel_phases > 1 \|\| bc\.max_parallel_fixes > 1\) \{[\s\S]{0,120}?await sweepOrphanLanes\(/,
    'sweepOrphanLanes gated on max_parallel_phases>1 OR max_parallel_fixes>1',
  );
  // (b) the per-'dev'-action wave dispatch (also skips phases already in serial fallback).
  assert.match(
    autoRunnerSrc,
    /if \(action\.kind === 'dev' && ar\.max_parallel_phases > 1 && !laneFallbackPhases\.has\(action\.phaseN\)\) \{[\s\S]{0,200}?computeDevWave\(/,
    'wave dispatch gated on max_parallel_phases>1',
  );
});

test('single-implementation: completeMergedPhase is the ONE shared completion helper — runDev (serial) and runPhaseWave (merge step) both use it', () => {
  const phaseRunnerSrc = readFileSync(path.join(__dirname, 'phase-runner.js'), 'utf-8');
  const autoRunnerSrc = readFileSync(path.join(__dirname, '..', 'auto-runner.js'), 'utf-8');

  // Exported once, from phase-runner.js.
  assert.match(phaseRunnerSrc, /export function completeMergedPhase\(/);
  // runDev's serial path calls it.
  assert.match(phaseRunnerSrc, /completeMergedPhase\(\s*\n\s*\{ projectName, n: nextPhase, commit_sha, projDir \}/);
  // auto-runner imports the SAME symbol and the merge step routes through it
  // (via the deps seam `_completeMergedPhase ?? completeMergedPhase`).
  assert.match(autoRunnerSrc, /import \{[^}]*completeMergedPhase[^}]*\} from '\.\/lib\/phase-runner\.js'/s);
  assert.match(autoRunnerSrc, /const _completeMergedPhase = deps\.completeMergedPhase \?\? completeMergedPhase;/);
  assert.match(autoRunnerSrc, /_completeMergedPhase\(\{ projectName, n: phase\.n, commit_sha, projDir \}\)/);
  // auto-runner does NOT hand-roll its own markPhaseCompleted+setCurrentPhase
  // completion block in the merge walk — it only calls the shared helper.
  const walkStart = autoRunnerSrc.indexOf('Ascending merge of the contiguous successful prefix');
  const walkEnd = autoRunnerSrc.indexOf('mandatory merged-HEAD validator gate', walkStart);
  const walk = autoRunnerSrc.slice(walkStart, walkEnd);
  assert.equal(/markPhaseCompleted\(/.test(walk), false, 'merge walk must not call markPhaseCompleted directly');
});

// ── computeDevWave: fails safe to serial when the wave head != next phase ──────

test('computeDevWave: returns serial when parallelism cannot produce a valid multi-phase wave', async () => {
  const projectName = `wave-cdw-${_seq++}`;
  const { projDir, workspaceDir } = makeFixture(projectName);
  await primeProject({ projectName, workspaceDir, currentPhase: 0, phases: [] });
  // No plan.json on disk → { wave: [], reason: 'no plan' } (serial fallback).
  const res = await computeDevWave({ projectName, cfg: waveCfg(), projDir, action: { kind: 'dev', phaseN: 1 } });
  assert.ok(res.wave.length <= 1, 'no plan → serial');
});
