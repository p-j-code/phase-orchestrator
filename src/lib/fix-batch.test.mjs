// Parallel independent fix batches (Phase 69 / brief 05 P4) — src/lib/fix-batch.test.mjs
//
// Covers every P4 acceptance criterion:
//   - selectFixBatch selector units: consecutive-prefix, pairwise disjointness,
//     missing files_likely ends the batch, cap respected, max_parallel_fixes:1 ⇒
//     a single fix (the classic path);
//   - pickBugAction (via pickNextAction) mode isolation: max_parallel_fixes:1 ⇒
//     classic fix-dev; >1 + disjoint ⇒ fix-dev-batch; a head fix that already
//     fell back to serial (laneFallbackFixes) ⇒ classic fix-dev (re-picked serially);
//   - runFixBatch fixture-repo integration (NO real LLM): 3 disjoint fixes → 3
//     lanes → ascending merges → fixes_completed=3, ONE push, fixCommitExists true
//     for every fix on the merged branch;
//   - the failed-middle-lane prefix rule: fix k fails, k+1 succeeded → only fixes
//     < k recorded, k+1 abandoned, fix k has an escalate marker + serial fallback;
//   - a property-style counter invariant: fixes_completed === count of contiguous
//     committed fixes after every scripted outcome permutation (incl. a red
//     merged-HEAD gate that rolls the whole prefix back);
//   - reconciliation is free: fix-rR-N: subjects survive --no-ff merges, so
//     pickBugAction's self-heal walk reconciles a batch that committed but never
//     recorded — no change to the walk.
//
// Run with: node --test src/lib/fix-batch.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DB_PATH = ':memory:';

import { runFixBatch, pickNextAction } from '../auto-runner.js';
import { selectFixBatch } from './lane-manager.js';
import {
  upsertProject, getProject, getBugRound, startBugRound, setBugRoundFixPlan,
  listPhaseLanesForProject, getDb,
} from '../state.js';
import { getCurrentBranch, branchExists, fixCommitExists } from './git.js';
import { escalationMarkerPath } from './escalation.js';
import { fixPlanJsonPath, bugRoundDir } from './guide-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

let _seq = 0;

// ── Selector: pure unit tests (AC1) ────────────────────────────────────────────

const cfgFixes = (max) => ({ bug_cycle: { max_parallel_fixes: max } });

test('selectFixBatch: mode isolation — max_parallel_fixes:1 ⇒ a single fix (the classic single-fix path)', () => {
  const fixes = [
    { n: 1, files_likely: ['a.js'] },
    { n: 2, files_likely: ['b.js'] },
  ];
  const { batch } = selectFixBatch({ fixes, completed: 0, cfg: cfgFixes(1) });
  assert.equal(batch.length, 1, 'cap 1 never widens the batch');
  assert.equal(batch[0].n, 1);
});

test('selectFixBatch: consecutive-prefix + pairwise disjointness — batches disjoint fixes up to the first collision', () => {
  const fixes = [
    { n: 1, files_likely: ['a.js'] },
    { n: 2, files_likely: ['b.js'] },
    { n: 3, files_likely: ['a.js'] },   // collides with fix 1 → ends the batch BEFORE it
    { n: 4, files_likely: ['d.js'] },
  ];
  const { batch } = selectFixBatch({ fixes, completed: 0, cfg: cfgFixes(4) });
  assert.deepEqual(batch.map((f) => f.n), [1, 2], 'stops at the first fix whose files intersect the batch');
});

test('selectFixBatch: pairwise (not just adjacent) disjointness — fix 3 collides with fix 1, not fix 2', () => {
  const fixes = [
    { n: 1, files_likely: ['shared.js'] },
    { n: 2, files_likely: ['b.js'] },
    { n: 3, files_likely: ['shared.js'] },  // intersects fix 1 (two back) → ends batch
  ];
  const { batch } = selectFixBatch({ fixes, completed: 0, cfg: cfgFixes(4) });
  assert.deepEqual(batch.map((f) => f.n), [1, 2]);
});

test('selectFixBatch: a missing/empty files_likely ENDS the batch (intersects-with-everything)', () => {
  const missing = [
    { n: 1, files_likely: ['a.js'] },
    { n: 2 },                              // no files_likely → ends the batch here
    { n: 3, files_likely: ['c.js'] },
  ];
  assert.deepEqual(selectFixBatch({ fixes: missing, completed: 0, cfg: cfgFixes(4) }).batch.map((f) => f.n), [1]);

  const empty = [
    { n: 1, files_likely: ['a.js'] },
    { n: 2, files_likely: [] },            // empty → ends the batch here
    { n: 3, files_likely: ['c.js'] },
  ];
  assert.deepEqual(selectFixBatch({ fixes: empty, completed: 0, cfg: cfgFixes(4) }).batch.map((f) => f.n), [1]);
});

test('selectFixBatch: a HEAD fix with missing files_likely runs ALONE (batch of 1)', () => {
  const fixes = [
    { n: 1 },                              // head has no estimate → alone
    { n: 2, files_likely: ['b.js'] },
  ];
  const { batch } = selectFixBatch({ fixes, completed: 0, cfg: cfgFixes(4) });
  assert.deepEqual(batch.map((f) => f.n), [1]);
});

test('selectFixBatch: cap respected — never exceeds max_parallel_fixes even with more disjoint fixes', () => {
  const fixes = [
    { n: 1, files_likely: ['a.js'] },
    { n: 2, files_likely: ['b.js'] },
    { n: 3, files_likely: ['c.js'] },
    { n: 4, files_likely: ['d.js'] },
  ];
  const { batch } = selectFixBatch({ fixes, completed: 0, cfg: cfgFixes(2) });
  assert.deepEqual(batch.map((f) => f.n), [1, 2], 'cap 2 truncates an otherwise-disjoint batch');
});

test('selectFixBatch: the prefix starts at `completed` (already-done fixes are skipped)', () => {
  const fixes = [
    { n: 1, files_likely: ['a.js'] },      // completed
    { n: 2, files_likely: ['b.js'] },
    { n: 3, files_likely: ['c.js'] },
  ];
  const { batch } = selectFixBatch({ fixes, completed: 1, cfg: cfgFixes(4) });
  assert.deepEqual(batch.map((f) => f.n), [2, 3], 'batch begins at fixes[completed]');
});

// ── pickBugAction via pickNextAction: mode isolation + batch emission (AC1/AC3) ─

function makeProjectFixture(label) {
  const projectName = `p69-pick-${label}-${_seq++}`;
  const projDir = path.join(PROJECTS_DIR, projectName);
  mkdirSync(bugRoundDir(projDir, 1), { recursive: true });
  return { projectName, projDir };
}

function writeFixPlan(projDir, fixes) {
  writeFileSync(fixPlanJsonPath(projDir, 1), JSON.stringify({ round: 1, fixes }), 'utf-8');
}

const pickCfg = (max) => ({
  auto_run: {},
  bug_cycle: { max_parallel_fixes: max },
  fixes: { inline_fix_prompts: true },
  paths: { workspace_subdir: 'workspace' },
});

test('pickBugAction (mode isolation): max_parallel_fixes:1 ⇒ the classic single fix-dev action, never a batch', async () => {
  const { projectName, projDir } = makeProjectFixture('serial');
  try {
    upsertProject({ name: projectName, status: 'in-progress' });   // no git_branch → self-heal skipped
    writeFixPlan(projDir, [{ n: 1, files_likely: ['a.js'] }, { n: 2, files_likely: ['b.js'] }]);
    startBugRound({ project: projectName, round: 1, bugs_file: 'bugs.md', total_fixes: 2 });

    const action = await pickNextAction(projectName, pickCfg(1));
    assert.equal(action.kind, 'fix-dev', 'cap 1 keeps today\'s single-fix action');
    assert.equal(action.fix.n, 1);
  } finally {
    rmSync(projDir, { recursive: true, force: true });
  }
});

test('pickBugAction: max_parallel_fixes>1 + disjoint files ⇒ a fix-dev-batch action', async () => {
  const { projectName, projDir } = makeProjectFixture('batch');
  try {
    upsertProject({ name: projectName, status: 'in-progress' });
    writeFixPlan(projDir, [
      { n: 1, title: 'A', files_likely: ['a.js'] },
      { n: 2, title: 'B', files_likely: ['b.js'] },
      { n: 3, title: 'C', files_likely: ['a.js'] },  // collides with fix 1 → batch is [1,2]
    ]);
    startBugRound({ project: projectName, round: 1, bugs_file: 'bugs.md', total_fixes: 3 });

    const action = await pickNextAction(projectName, pickCfg(3));
    assert.equal(action.kind, 'fix-dev-batch');
    assert.equal(action.round, 1);
    assert.deepEqual(action.fixes.map((f) => f.n), [1, 2]);
    assert.ok(action.fixes.every((f) => f.round === 1 && typeof f.title === 'string'));
  } finally {
    rmSync(projDir, { recursive: true, force: true });
  }
});

test('pickBugAction: a head fix in laneFallbackFixes collapses the batch back to a classic single fix-dev (re-picked serially)', async () => {
  const { projectName, projDir } = makeProjectFixture('fallback');
  try {
    upsertProject({ name: projectName, status: 'in-progress' });
    writeFixPlan(projDir, [
      { n: 1, title: 'A', files_likely: ['a.js'] },
      { n: 2, title: 'B', files_likely: ['b.js'] },
    ]);
    startBugRound({ project: projectName, round: 1, bugs_file: 'bugs.md', total_fixes: 2 });

    // Head fix r1-1 previously failed in a lane → runs SERIALLY, not re-batched.
    const action = await pickNextAction(projectName, pickCfg(2), { laneFallbackFixes: new Set(['r1-1']) });
    assert.equal(action.kind, 'fix-dev', 'a fallen-back head fix is never re-batched');
    assert.equal(action.fix.n, 1);
  } finally {
    rmSync(projDir, { recursive: true, force: true });
  }
});

// ── runFixBatch fixture-repo harness (real git worktrees, stubbed dev calls) ────

function makeRepoFixture(label) {
  const projDir = mkdtempSync(path.join(tmpdir(), `aorch-fixbatch-proj-${label}-`));
  const workspaceDir = mkdtempSync(path.join(tmpdir(), `aorch-fixbatch-ws-${label}-`));
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

// node_modules 'none' skips the symlink; validators stubbed via the gate seam.
const batchCfg = () => ({
  parallel_lanes: { dir: '.worktrees', node_modules: 'none' },
  security: { deny_rules: [] },
  bug_cycle: { max_parallel_fixes: 4 },
  validators: { enabled: false },
});

// A runDev stub for a fix lane: writes the fix's file(s) and commits a
// `fix-rR-N: ...` subject in its OWN worktree, mirroring a real lane fix run.
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

async function primeBugRound({ projectName, workspaceDir, round = 1, totalFixes, fixesCompleted = 0 }) {
  upsertProject({ name: projectName, status: 'in-progress' });
  const branch = await getCurrentBranch(workspaceDir);
  getDb().prepare('UPDATE projects SET git_branch = ? WHERE name = ?').run(branch, projectName);
  startBugRound({ project: projectName, round, bugs_file: 'bugs.md', total_fixes: totalFixes });
  if (fixesCompleted > 0) {
    getDb().prepare('UPDATE bug_rounds SET fixes_completed = ? WHERE project = ? AND round = ?')
      .run(fixesCompleted, projectName, round);
  }
  return branch;
}

const passGate = async () => ({ hasFailures: false, results: [] });

// ── AC2: 3 disjoint fixes → 3 lanes → ascending merges → fixes_completed=3, ONE push

test('runFixBatch: 3 disjoint fixes → 3 lanes → ascending merges → fixes_completed=3, ONE push, fixCommitExists true for every fix', async () => {
  const projectName = `fixbatch-clean-${_seq++}`;
  const { projDir, workspaceDir } = makeRepoFixture(projectName);
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

  // Every fix commit survives the --no-ff merges and is greppable on the merged HEAD.
  for (const n of [1, 2, 3]) {
    assert.equal(await fixCommitExists(workspaceDir, 1, n), true, `fix-r1-${n}: reachable on merged branch`);
    assert.ok(existsSync(path.join(workspaceDir, `f${n}.js`)), `fix ${n}'s file landed in the primary workspace`);
  }

  // Lanes torn down; all rows → done.
  for (const n of [1, 2, 3]) assert.equal(await branchExists(workspaceDir, `lane/fix-r1-${n}`), false);
  const rows = listPhaseLanesForProject(projectName);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.status === 'done' && r.kind === 'fix'));
});

// ── AC3: failed-middle-lane — fix k fails, k+1 abandoned, fix k escalate marker ─

test('runFixBatch: failed-middle-lane — fix 2 fails while fix 3 succeeded → only fix 1 recorded, fix 3 abandoned, fix 2 escalated + serial fallback', async () => {
  const projectName = `fixbatch-middle-${_seq++}`;
  const { projDir, workspaceDir } = makeRepoFixture(projectName);
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
  assert.equal(await fixCommitExists(workspaceDir, 1, 2), false, 'failed fix never committed to the workspace');
  assert.equal(await fixCommitExists(workspaceDir, 1, 3), false, 'abandoned later fix never committed');

  // The failed fix entered the existing single-fix ladder — escalate marker present.
  assert.ok(existsSync(escalationMarkerPath(projDir, { fix: { round: 1, n: 2 } })), 'escalate marker for the failed fix');
  assert.equal(existsSync(escalationMarkerPath(projDir, { fix: { round: 1, n: 3 } })), false, 'no marker for the abandoned fix');

  // The abandoned lane recorded a lesson; its branch is gone.
  const lessons = readFileSync(path.join(projDir, '.guide', 'lessons.jsonl'), 'utf-8');
  assert.match(lessons, /"kind":"lane-abandoned"/);
  assert.match(lessons, /"kind":"escalation"/);
  assert.equal(await branchExists(workspaceDir, 'lane/fix-r1-3'), false);
});

// ── AC3 companion: a merge CONFLICT falls back to serial (files_likely was wrong)

test('runFixBatch: a second lane that conflicts on merge → first merges+recorded, conflicting fix reset serial + lane-conflict lesson', async () => {
  const projectName = `fixbatch-conflict-${_seq++}`;
  const { projDir, workspaceDir } = makeRepoFixture(projectName);
  await primeBugRound({ projectName, workspaceDir, totalFixes: 2 });

  // Both lanes rewrite the SAME committed file to DIFFERENT content → the second
  // merge (base→v2 onto a HEAD already at v1) conflicts.
  const outcome = await runFixBatch(
    { projectName, cfg: batchCfg(), projDir, workspaceDir, round: 1,
      fixes: [{ round: 1, n: 1, title: 'A' }, { round: 1, n: 2, title: 'B' }] },
    {
      runDev: makeFixRunDevStub({ writes: (n) => ({ 'shared.js': `export const base = ${n};\n` }) }),
      gateMergedFixHead: passGate,
      pushBranch: async () => ({ ok: true }),
    },
  );

  assert.equal(outcome.failure.kind, 'conflict');
  assert.equal(outcome.failure.fixN, 2);
  assert.deepEqual(outcome.mergedFixes, [1]);
  assert.deepEqual(outcome.serialFallback, ['r1-2']);
  assert.equal(getBugRound(projectName, 1).fixes_completed, 1);

  const st = execSync('git status --porcelain', { cwd: workspaceDir }).toString().trim();
  assert.equal(st, '', 'workspace clean after merge --abort');
  assert.equal(await branchExists(workspaceDir, 'lane/fix-r1-2'), false, 'conflicting lane branch discarded');
  const lessons = readFileSync(path.join(projDir, '.guide', 'lessons.jsonl'), 'utf-8');
  assert.match(lessons, /"kind":"lane-conflict"/);
});

// ── AC4: property-style counter invariant across scripted outcome permutations ─

test('runFixBatch: PROPERTY — fixes_completed === count of contiguous committed fixes after every scripted outcome', async () => {
  // Each scenario runs a fresh 3-fix batch and asserts the invariant. `failOn`
  // fails one lane; `gateFails` fails the merged-HEAD gate (rolls the prefix back).
  const scenarios = [
    { label: 'all-green', failOn: null, gateFails: false, expectCommitted: [1, 2, 3] },
    { label: 'head-fails', failOn: 1, gateFails: false, expectCommitted: [] },
    { label: 'middle-fails', failOn: 2, gateFails: false, expectCommitted: [1] },
    { label: 'tail-fails', failOn: 3, gateFails: false, expectCommitted: [1, 2] },
    { label: 'gate-red', failOn: null, gateFails: true, expectCommitted: [] },
  ];

  for (const sc of scenarios) {
    const projectName = `fixbatch-prop-${sc.label}-${_seq++}`;
    const { projDir, workspaceDir } = makeRepoFixture(projectName);
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
    // eslint-disable-next-line no-await-in-loop
    const committed = [];
    for (const n of [1, 2, 3]) {
      // eslint-disable-next-line no-await-in-loop
      if (await fixCommitExists(workspaceDir, 1, n)) committed.push(n);
    }
    assert.deepEqual(committed, sc.expectCommitted, `[${sc.label}] committed fixes on the workspace`);
    assert.equal(fixesCompleted, sc.expectCommitted.length,
      `[${sc.label}] fixes_completed (${fixesCompleted}) === committed count (${sc.expectCommitted.length})`);
  }
});

// ── AC4 companion: red merged-HEAD gate escalates the lowest merged fix ─────────

test('runFixBatch: a red merged-HEAD gate rolls the prefix back to base, records NOTHING, escalates the lowest merged fix', async () => {
  const projectName = `fixbatch-gate-${_seq++}`;
  const { projDir, workspaceDir } = makeRepoFixture(projectName);
  const base = await primeBugRound({ projectName, workspaceDir, totalFixes: 2 });
  const baseSha = execSync('git rev-parse HEAD', { cwd: workspaceDir }).toString().trim();

  const outcome = await runFixBatch(
    { projectName, cfg: batchCfg(), projDir, workspaceDir, round: 1,
      fixes: [{ round: 1, n: 1, title: 'A' }, { round: 1, n: 2, title: 'B' }] },
    {
      runDev: makeFixRunDevStub({ writes: (n) => ({ [`f${n}.js`]: `export const v = ${n};\n` }) }),
      gateMergedFixHead: async () => ({ hasFailures: true, results: [{ pass: false, validator_name: 'x' }] }),
      pushBranch: async () => { throw new Error('must not push a red HEAD'); },
    },
  );

  assert.equal(outcome.failure.kind, 'gate');
  assert.equal(outcome.failure.fixN, 1, 'lowest merged fix is the escalation target');
  assert.deepEqual(outcome.mergedFixes, [], 'nothing recorded on a rolled-back gate');
  assert.equal(outcome.pushed, false);
  assert.equal(getBugRound(projectName, 1).fixes_completed, 0, 'counter never advanced past committed');
  assert.equal(execSync('git rev-parse HEAD', { cwd: workspaceDir }).toString().trim(), baseSha, 'HEAD reset to base');
  assert.deepEqual(outcome.serialFallback, ['r1-1']);
  assert.ok(existsSync(escalationMarkerPath(projDir, { fix: { round: 1, n: 1 } })), 'lowest merged fix escalated');
  assert.equal(base, await getCurrentBranch(workspaceDir), 'still on the project branch');
});

// ── Reconciliation is free: fix-rR-N: subjects survive --no-ff merges (AC / prompt) ─

test('reconciliation: fixCommitExists greps fix-rR-N: subjects that survive --no-ff merges (no self-heal change needed)', async () => {
  const { workspaceDir } = makeRepoFixture(`recon-git-${_seq++}`);
  // Simulate a batch: 3 fix commits each on their own branch, each merged --no-ff.
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
  // The trailing-colon anchor still prevents fix-r7-1 matching a fix-r7-10 subject.
  assert.equal(await fixCommitExists(workspaceDir, 7, 10), false);
});

test('reconciliation (self-heal walk): pickBugAction reconciles a batch that committed but never recorded → fixes_completed catches up, round completes', async () => {
  const projectName = `fixbatch-selfheal-${_seq++}`;
  const projDir = path.join(PROJECTS_DIR, projectName);
  const workspaceDir = path.join(projDir, 'workspace');
  try {
    mkdirSync(workspaceDir, { recursive: true });
    execSync('git init -q', { cwd: workspaceDir });
    execSync('git config user.email t@example.com', { cwd: workspaceDir });
    execSync('git config user.name test', { cwd: workspaceDir });
    execSync('git config commit.gpgsign false', { cwd: workspaceDir });
    writeFileSync(path.join(workspaceDir, '.gitignore'), 'node_modules/\n');
    execSync('git add -A', { cwd: workspaceDir });
    execSync('git commit -q -m init', { cwd: workspaceDir });
    // Three fix commits merged --no-ff (a completed batch that crashed before recordFixCompletion).
    for (const n of [1, 2, 3]) {
      execSync(`git checkout -q -b lane/fix-r1-${n}`, { cwd: workspaceDir });
      writeFileSync(path.join(workspaceDir, `f${n}.js`), `export const v = ${n};\n`);
      execSync('git add -A', { cwd: workspaceDir });
      execSync(`git commit -q -m "fix-r1-${n}: work"`, { cwd: workspaceDir });
      execSync('git checkout -q -', { cwd: workspaceDir });
      execSync(`git merge --no-ff -q -m "Merge lane/fix-r1-${n} (parallel fix batch)" lane/fix-r1-${n}`, { cwd: workspaceDir });
    }

    const branch = await getCurrentBranch(workspaceDir);
    upsertProject({ name: projectName, status: 'in-progress' });
    getDb().prepare('UPDATE projects SET git_branch = ? WHERE name = ?').run(branch, projectName);
    mkdirSync(bugRoundDir(projDir, 1), { recursive: true });
    writeFixPlan(projDir, [
      { n: 1, title: 'A', files_likely: ['f1.js'] },
      { n: 2, title: 'B', files_likely: ['f2.js'] },
      { n: 3, title: 'C', files_likely: ['f3.js'] },
    ]);
    startBugRound({ project: projectName, round: 1, bugs_file: 'bugs.md', total_fixes: 3 });  // fixes_completed = 0

    // Even with lanes enabled, the self-heal walk reconciles all three committed
    // fixes BEFORE any batch is considered, so the round completes.
    const action = await pickNextAction(projectName, pickCfg(3));
    assert.equal(getBugRound(projectName, 1).fixes_completed, 3, 'self-heal reconciled all committed fixes');
    assert.equal(action.kind, 'wait-for-human', 'round complete after reconciliation');
    assert.equal(action.readyForQaTransition, true, 'round complete reaches the ready-for-qa transition — deferred to autoRun after the runtime-qa gate');
    assert.notEqual(getProject(projectName).status, 'ready-for-qa', 'not flipped inline — pickBugAction defers the transition');
  } finally {
    rmSync(projDir, { recursive: true, force: true });
  }
});

// ── Mode isolation (source inspection): the fix-batch entrypoints are gated ─────

test('mode isolation (auto-runner source): the fix-batch dispatch and orphan sweep are gated on max_parallel_fixes>1', () => {
  const src = readFileSync(path.join(__dirname, '..', 'auto-runner.js'), 'utf-8');
  // (a) the fix-dev-batch dispatch runs runFixBatch and is only reachable when
  //     pickBugAction emits the kind, which itself is gated on max_parallel_fixes>1.
  assert.match(
    src,
    /if \(action\.kind === 'fix-dev-batch'\) \{[\s\S]{0,200}?runFixBatch\(/,
    'fix-dev-batch dispatch calls runFixBatch',
  );
  // (b) pickBugAction only emits fix-dev-batch behind the cap>1 + inline-prompts
  //     + not-fallen-back guard.
  assert.match(
    src,
    /maxParallelFixes > 1[\s\S]{0,400}?kind: 'fix-dev-batch'/,
    'fix-dev-batch emission gated on max_parallel_fixes>1',
  );
  // (c) the orphan sweep now also fires for fix lanes.
  assert.match(
    src,
    /if \(ar\.max_parallel_phases > 1 \|\| bc\.max_parallel_fixes > 1\) \{[\s\S]{0,120}?await sweepOrphanLanes\(/,
    'orphan sweep gated on phase OR fix lanes',
  );
});
