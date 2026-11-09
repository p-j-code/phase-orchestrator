// Lane manager (Phase 67 / brief 05 P2) — src/lib/lane-manager.test.mjs
//
// Fixture-repo integration tests with NO real LLM spawn: provisionLane creates a
// real git worktree + branch and provisions the untracked files a bare worktree
// lacks (.claude/settings.json, a node_modules symlink); destroyLane removes the
// worktree + branch and marks the row done; sweepOrphanLanes cleans a manufactured
// leftover lane dir + a stale running phase_lanes row (→ abandoned).
//
// Run with: node --test src/lib/lane-manager.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// In-memory DB — phase_lanes accessors migrate lazily on first getDb().
process.env.DB_PATH = ':memory:';

import {
  provisionLane, destroyLane, sweepOrphanLanes, laneName, laneBranchName, laneJobKey,
  pickReadyPhases, selectPhaseWave, computeWaveStopPhases,
} from './lane-manager.js';
import { getPhaseLane, createPhaseLane, listPhaseLanesForProject } from '../state.js';
import { getHeadSha, getCurrentBranch, branchExists } from './git.js';

let _seq = 0;
function makeFixture(label) {
  const projDir = mkdtempSync(path.join(tmpdir(), `aorch-lane-proj-${label}-`));
  const workspaceDir = mkdtempSync(path.join(tmpdir(), `aorch-lane-ws-${label}-`));
  execSync('git init -q', { cwd: workspaceDir });
  execSync('git config user.email t@example.com', { cwd: workspaceDir });
  execSync('git config user.name test', { cwd: workspaceDir });
  // A committed .gitignore keeps the provisioned node_modules symlink + .env out
  // of the tree (matches production, where these are ignored).
  writeFileSync(path.join(workspaceDir, '.gitignore'), 'node_modules/\n.env\n');
  writeFileSync(path.join(workspaceDir, 'index.js'), 'export const v = 1;\n');
  execSync('git add -A', { cwd: workspaceDir });
  execSync('git commit -q -m init', { cwd: workspaceDir });
  // A node_modules store in the primary workspace, so the symlink has a target.
  mkdirSync(path.join(workspaceDir, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(path.join(workspaceDir, 'node_modules', 'left-pad', 'index.js'), '// dep\n');
  return { projDir, workspaceDir };
}

const cfg = (nodeModules = 'symlink') => ({
  parallel_lanes: { dir: '.worktrees', node_modules: nodeModules },
  security: { deny_rules: [] },
});

// ── provisionLane ───────────────────────────────────────────────────────────

test('provisionLane: creates a worktree on lane/<name>, materializes .claude/settings.json + a node_modules symlink, inserts a running row', async () => {
  const { projDir, workspaceDir } = makeFixture(`prov-${_seq++}`);
  const baseSha = await getHeadSha(workspaceDir);

  const lane = await provisionLane({
    projectName: 'demo', workspaceDir, projDir, kind: 'phase', n: 1, baseSha, cfg: cfg('symlink'),
  });

  // Naming + path convention (all under projects/<p>/<parallel_lanes.dir>/).
  assert.equal(lane.name, 'phase-1');
  assert.equal(lane.branch, 'lane/phase-1');
  assert.equal(lane.laneDir, path.join(projDir, '.worktrees', 'phase-1'));
  assert.equal(lane.jobKey, laneJobKey('demo', 'phase-1'));
  assert.equal(lane.gateInLane, true);

  // The worktree exists and is checked out on the private branch.
  assert.ok(existsSync(lane.laneDir), 'lane worktree dir exists');
  assert.equal(await getCurrentBranch(lane.laneDir), 'lane/phase-1');
  assert.ok(await branchExists(workspaceDir, 'lane/phase-1'), 'lane branch exists in the parent repo');

  // Provisioned untracked files a bare worktree lacks.
  assert.ok(existsSync(path.join(lane.laneDir, '.claude', 'settings.json')), '.claude/settings.json materialized');
  const nm = path.join(lane.laneDir, 'node_modules');
  assert.ok(existsSync(nm), 'node_modules present');
  assert.ok(lstatSync(nm).isSymbolicLink(), 'node_modules is a symlink into the shared store');

  // A running phase_lanes row was inserted with the lane's identity.
  const row = getPhaseLane(lane.laneId);
  assert.ok(row, 'phase_lanes row exists');
  assert.equal(row.status, 'running');
  assert.equal(row.branch, 'lane/phase-1');
  assert.equal(row.worktree_path, lane.laneDir);
  assert.equal(row.base_sha, baseSha);
  assert.equal(row.kind, 'phase');
  assert.equal(row.n, 1);
});

test("provisionLane: node_modules:'none' skips the symlink and flags gateInLane:false", async () => {
  const { projDir, workspaceDir } = makeFixture(`none-${_seq++}`);
  const baseSha = await getHeadSha(workspaceDir);

  const lane = await provisionLane({
    projectName: 'demo2', workspaceDir, projDir, kind: 'phase', n: 2, baseSha, cfg: cfg('none'),
  });

  assert.equal(lane.gateInLane, false);
  assert.ok(!existsSync(path.join(lane.laneDir, 'node_modules')), 'no node_modules provisioned');
  // settings still materialized regardless of node_modules mode.
  assert.ok(existsSync(path.join(lane.laneDir, '.claude', 'settings.json')));
});

test('provisionLane: a workspace with no node_modules flags gateInLane:false even under symlink mode', async () => {
  const { projDir, workspaceDir } = makeFixture(`nostore-${_seq++}`);
  // Remove the store the fixture created.
  execSync('rm -rf node_modules', { cwd: workspaceDir });
  const baseSha = await getHeadSha(workspaceDir);

  const lane = await provisionLane({
    projectName: 'demo3', workspaceDir, projDir, kind: 'fix', n: 4, round: 2, baseSha, cfg: cfg('symlink'),
  });

  assert.equal(lane.name, 'fix-r2-4');
  assert.equal(lane.branch, 'lane/fix-r2-4');
  assert.equal(lane.gateInLane, false);
  assert.ok(!existsSync(path.join(lane.laneDir, 'node_modules')));
});

// ── destroyLane ───────────────────────────────────────────────────────────────

test('destroyLane: removes the worktree + branch and transitions the row running → done', async () => {
  const { projDir, workspaceDir } = makeFixture(`destroy-${_seq++}`);
  const baseSha = await getHeadSha(workspaceDir);
  const lane = await provisionLane({
    projectName: 'demo', workspaceDir, projDir, kind: 'phase', n: 1, baseSha, cfg: cfg('symlink'),
  });
  assert.equal(getPhaseLane(lane.laneId).status, 'running');

  await destroyLane({
    workspaceDir, laneDir: lane.laneDir, branch: lane.branch, laneId: lane.laneId,
    status: 'done', head_sha: baseSha,
  });

  assert.equal(existsSync(lane.laneDir), false, 'worktree dir removed');
  assert.equal(await branchExists(workspaceDir, lane.branch), false, 'lane branch deleted');
  const row = getPhaseLane(lane.laneId);
  assert.equal(row.status, 'done');
  assert.equal(row.head_sha, baseSha);
  assert.ok(row.ended_at, 'ended_at stamped on terminal transition');
});

test('destroyLane: crash-safe — never throws against a missing dir / already-removed lane', async () => {
  const { workspaceDir } = makeFixture(`crashsafe-${_seq++}`);
  await assert.doesNotReject(async () => {
    await destroyLane({
      workspaceDir,
      laneDir: path.join(workspaceDir, '..', 'does-not-exist', 'phase-99'),
      branch: 'lane/never-created',
      laneId: null,
    });
  });
});

// ── sweepOrphanLanes ──────────────────────────────────────────────────────────

test('sweepOrphanLanes: cleans a manufactured leftover lane dir AND transitions a stale running row → abandoned', async () => {
  const { projDir, workspaceDir } = makeFixture(`sweep-${_seq++}`);
  const baseSha = await getHeadSha(workspaceDir);
  const wtRoot = path.join(projDir, '.worktrees');
  mkdirSync(wtRoot, { recursive: true });

  // (a) A stale 'running' row from a "crashed prior run", whose worktree_path is
  //     a leftover dir on disk (not a registered worktree).
  const staleDir = path.join(wtRoot, 'phase-8');
  mkdirSync(staleDir, { recursive: true });
  writeFileSync(path.join(staleDir, 'leftover.txt'), 'stale\n');
  const staleId = createPhaseLane({
    project: 'sweepproj', kind: 'phase', n: 8, branch: 'lane/phase-8',
    worktree_path: staleDir, base_sha: baseSha,
  });

  // (b) A leftover lane dir on disk with NO backing row (crash before insert).
  const orphanDir = path.join(wtRoot, 'fix-r1-3');
  mkdirSync(orphanDir, { recursive: true });
  writeFileSync(path.join(orphanDir, 'junk.txt'), 'orphan\n');

  // (c) A detached read-only worktree dir (phase-50) — must be LEFT ALONE.
  const detachedDir = path.join(wtRoot, 'verify-abc12345');
  mkdirSync(detachedDir, { recursive: true });
  writeFileSync(path.join(detachedDir, 'keep.txt'), 'keep\n');

  const res = await sweepOrphanLanes({ projectName: 'sweepproj', workspaceDir, projDir, cfg: cfg('symlink') });

  // Stale row abandoned + its dir gone.
  assert.equal(getPhaseLane(staleId).status, 'abandoned');
  assert.equal(existsSync(staleDir), false, 'stale lane dir removed');
  // Leftover unbacked lane dir gone.
  assert.equal(existsSync(orphanDir), false, 'unbacked leftover lane dir removed');
  // Detached read-only worktree dir preserved.
  assert.equal(existsSync(detachedDir), true, 'phase-50 detached worktree dir must NOT be swept');

  assert.ok(res.sweptRows >= 1, 'at least the stale row was abandoned');
  assert.ok(res.sweptDirs >= 1, 'at least one leftover lane dir removed');
});

test('sweepOrphanLanes: idempotent no-op when there are no lanes (only a log line + prune)', async () => {
  const { projDir, workspaceDir } = makeFixture(`sweep-noop-${_seq++}`);
  const res = await sweepOrphanLanes({ projectName: 'emptyproj', workspaceDir, projDir, cfg: cfg('symlink') });
  assert.equal(res.sweptRows, 0);
  assert.equal(res.sweptDirs, 0);
  assert.equal(listPhaseLanesForProject('emptyproj').length, 0);
});

// ── name helpers ──────────────────────────────────────────────────────────────

test('laneName / laneBranchName: phase | fix | duo naming', () => {
  assert.equal(laneName({ kind: 'phase', n: 7 }), 'phase-7');
  assert.equal(laneName({ kind: 'fix', round: 3, n: 2 }), 'fix-r3-2');
  assert.equal(laneName({ kind: 'duo', tier: 'opus' }), 'duo-opus');
  assert.equal(laneBranchName('phase-7'), 'lane/phase-7');
  assert.throws(() => laneName({ kind: 'bogus' }), /unknown lane kind/);
});

// ─── Phase 68 (brief 05 P3) — pure wave selectors ─────────────────────────────

const files = (arr) => arr; // readability helper for files_expected
const phase = (n, extra = {}) => ({ n, title: `P${n}`, files_expected: [`f${n}.js`], ...extra });

// pickReadyPhases — reuse resolveEffectiveDependsOn's previous-entry compat rule.

test('pickReadyPhases: a linear (implicit previous-entry) plan is serial — only the first uncompleted phase is ready', () => {
  const plan = { phases: [phase(1), phase(2), phase(3)] }; // no depends_on → implicit chain
  assert.deepEqual(pickReadyPhases(plan, []).map((p) => p.n), [1]);
  assert.deepEqual(pickReadyPhases(plan, [{ n: 1, status: 'completed' }]).map((p) => p.n), [2]);
  assert.deepEqual(pickReadyPhases(plan, [{ n: 1, status: 'completed' }, { n: 2, status: 'completed' }]).map((p) => p.n), [3]);
});

test('pickReadyPhases: an explicit DAG where 2,3 depend only on 1 makes BOTH ready once 1 completes', () => {
  const plan = { phases: [phase(1), phase(2, { depends_on: [1] }), phase(3, { depends_on: [1] })] };
  assert.deepEqual(pickReadyPhases(plan, []).map((p) => p.n), [1]);                    // 2,3 blocked on 1
  assert.deepEqual(pickReadyPhases(plan, [{ n: 1, status: 'completed' }]).map((p) => p.n), [2, 3]);
});

test('pickReadyPhases: an in-progress/failed row is NOT completed, so it (not its dependants) is ready', () => {
  const plan = { phases: [phase(1), phase(2, { depends_on: [1] })] };
  assert.deepEqual(pickReadyPhases(plan, [{ n: 1, status: 'in-progress' }]).map((p) => p.n), [1]);
});

// selectPhaseWave — the guards. ANY miss ⇒ wave of 1 (serial).

const indep = (n, f) => ({ n, title: `P${n}`, depends_on: [], files_expected: f }); // all-independent
const waveCfg = (over = {}) => ({
  auto_run: { max_parallel_phases: 4, checkpoint_policy: { mode: 'all' }, auto_pause_after_phase_1: false, ...over.auto_run },
  phases: { review_every_n_phases: 99, ...over.phases },
});

test('selectPhaseWave: max_parallel_phases:1 (default) always returns a single phase — the serial path', () => {
  const plan = { phases: [indep(1, ['a.js']), indep(2, ['b.js'])] };
  const cfg = waveCfg({ auto_run: { max_parallel_phases: 1, checkpoint_policy: { mode: 'all' }, auto_pause_after_phase_1: false } });
  const { wave } = selectPhaseWave({ plan, phasesTable: [], cfg, dagClean: true });
  assert.deepEqual(wave.map((p) => p.n), [1]);
});

test('selectPhaseWave: a clean DAG with disjoint files co-schedules ready phases up to the cap', () => {
  const plan = { phases: [indep(1, ['a.js']), indep(2, ['b.js']), indep(3, ['c.js'])] };
  const { wave } = selectPhaseWave({ plan, phasesTable: [], cfg: waveCfg(), dagClean: true });
  assert.deepEqual(wave.map((p) => p.n), [1, 2, 3]);
});

test('selectPhaseWave: DAG problems (dagClean:false) collapse to serial', () => {
  const plan = { phases: [indep(1, ['a.js']), indep(2, ['b.js'])] };
  const { wave } = selectPhaseWave({ plan, phasesTable: [], cfg: waveCfg(), dagClean: false });
  assert.deepEqual(wave.map((p) => p.n), [1]);
});

test('selectPhaseWave: intersecting files_expected are never co-scheduled — the wave stops before the colliding phase', () => {
  const plan = { phases: [indep(1, ['shared.js']), indep(2, ['shared.js']), indep(3, ['c.js'])] };
  const { wave } = selectPhaseWave({ plan, phasesTable: [], cfg: waveCfg(), dagClean: true });
  assert.deepEqual(wave.map((p) => p.n), [1]); // 2 collides with 1 → wave stops at 1
});

test('selectPhaseWave: a phase with MISSING/EMPTY files_expected always runs in a wave of 1', () => {
  const planFirst = { phases: [indep(1, []), indep(2, ['b.js'])] };
  assert.deepEqual(selectPhaseWave({ plan: planFirst, phasesTable: [], cfg: waveCfg(), dagClean: true }).wave.map((p) => p.n), [1]);
  const planSecond = { phases: [indep(1, ['a.js']), indep(2, [])] };
  assert.deepEqual(selectPhaseWave({ plan: planSecond, phasesTable: [], cfg: waveCfg(), dagClean: true }).wave.map((p) => p.n), [1]); // empty 2 not co-scheduled
});

test("selectPhaseWave: a guide 'independent' annotation alone NEVER widens a wave — only in-code file disjointness does", () => {
  // Two phases the guide flagged independent:true but whose files collide on disk.
  const plan = { phases: [indep(1, ['same.js']), { n: 2, depends_on: [], files_expected: ['same.js'], independent: true }] };
  const { wave } = selectPhaseWave({ plan, phasesTable: [], cfg: waveCfg(), dagClean: true });
  assert.deepEqual(wave.map((p) => p.n), [1]); // annotation ignored; files intersect → serial
});

test('selectPhaseWave: a wave never spans a REVIEW-cadence boundary — the boundary phase is the wave\'s last member', () => {
  const plan = { phases: [indep(1, ['a.js']), indep(2, ['b.js']), indep(3, ['c.js']), indep(4, ['d.js'])] };
  const cfg = waveCfg({ phases: { review_every_n_phases: 3 } });
  const { wave } = selectPhaseWave({ plan, phasesTable: [], cfg, dagClean: true });
  assert.deepEqual(wave.map((p) => p.n), [1, 2, 3]); // 3 is the review boundary (last); 4 excluded
});

test('selectPhaseWave: a wave never spans a CHECKPOINT/pause phase (auto_pause_after_phases)', () => {
  const plan = { phases: [indep(1, ['a.js']), indep(2, ['b.js']), indep(3, ['c.js'])] };
  const cfg = waveCfg({ auto_run: { max_parallel_phases: 4, checkpoint_policy: { mode: 'all' }, auto_pause_after_phase_1: false, auto_pause_after_phases: [2] } });
  const { wave } = selectPhaseWave({ plan, phasesTable: [], cfg, dagClean: true });
  assert.deepEqual(wave.map((p) => p.n), [1, 2]); // 2 is a custom pause point (last); 3 excluded
});

test('computeWaveStopPhases: intent-mode pauses BEFORE a pause-intent phase ⇒ the PREVIOUS phase is a stop phase', () => {
  const plan = { phases: [indep(1, ['a.js']), { n: 2, checkpoint: 'schema' }, indep(3, ['c.js'])] };
  const cfg = { auto_run: { checkpoint_policy: { mode: 'intent', pause_intents: ['schema'] } }, phases: { review_every_n_phases: 99 } };
  const stop = computeWaveStopPhases({ plan, cfg });
  assert.equal(stop.has(1), true, 'phase 1 stops the wave so the pause fires before schema-phase 2');
  assert.equal(stop.has(3), true, 'the final phase always stops');
});
