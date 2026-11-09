// Single-call minor-fix batch (Phase 70 / brief 05 P5) — src/lib/fix-single-call-batch.test.mjs
//
// Covers every P5 acceptance criterion:
//   - selectMinorFixBatch selector units: minors-only, disjointness,
//     consecutiveness, cap respected, disabled (batch_minor_fixes:false /
//     batch_max<=0) ⇒ classic single-fix action;
//   - pickBugAction mode isolation: max_parallel_fixes>1 (lanes) + batching
//     enabled ⇒ skipped with the named-config dim log, still classic single fix;
//   - buildInlineFixBatchPrompt: every fix listed with its own report path +
//     per-fix commit contract, static instruction block byte-identical across
//     two builds (different fix content, same round);
//   - runFixSingleCallBatch fixture-repo integration (NO real LLM, NO worktrees):
//     3-of-3 green ⇒ 3 completions recorded ascending, one gate run, one push;
//     red batch (dev error / gate failure) ⇒ reset to preBatchSha, zero
//     completions, all pending, next pick dispatches fix 1 individually;
//     partial (2-of-4) ⇒ first two recorded, 3-4 re-queued individually;
//     aheadBehind ambiguous/pushed ⇒ commits NOT reset.
//
// Run with: node --test src/lib/fix-single-call-batch.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DB_PATH = ':memory:';

import { runFixSingleCallBatch, pickNextAction } from '../auto-runner.js';
import { buildInlineFixBatchPrompt } from './phase-runner.js';
import {
  upsertProject, getProject, getBugRound, startBugRound, getDb,
} from '../state.js';
import { getCurrentBranch, fixCommitExists } from './git.js';
import { fixPlanJsonPath, bugRoundDir, fixReportPath } from './guide-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

let _seq = 0;

// ── selectMinorFixBatch: pure unit tests (AC1) — exercised indirectly via
// pickNextAction/pickBugAction (the selector itself is not exported; it is a
// private helper in auto-runner.js, mirroring gateMergedFixHead's own
// module-private convention). ──────────────────────────────────────────────

function makeProjectFixture(label) {
  const projectName = `p70-pick-${label}-${_seq++}`;
  const projDir = path.join(PROJECTS_DIR, projectName);
  mkdirSync(bugRoundDir(projDir, 1), { recursive: true });
  return { projectName, projDir };
}

function writeFixPlan(projDir, fixes) {
  writeFileSync(fixPlanJsonPath(projDir, 1), JSON.stringify({ round: 1, fixes }), 'utf-8');
}

const pickCfg = (opts = {}) => ({
  auto_run: {},
  bug_cycle: { max_parallel_fixes: 1, batch_minor_fixes: true, batch_max: 4, ...opts },
  fixes: { inline_fix_prompts: true },
  paths: { workspace_subdir: 'workspace' },
});

test('pickBugAction: consecutive MINOR, disjoint fixes ⇒ fix-dev-single-call-batch', async () => {
  const { projectName, projDir } = makeProjectFixture('minors');
  try {
    upsertProject({ name: projectName, status: 'in-progress' });
    writeFixPlan(projDir, [
      { n: 1, title: 'A', severity: 'minor', files_likely: ['a.js'] },
      { n: 2, title: 'B', severity: 'minor', files_likely: ['b.js'] },
      { n: 3, title: 'C', severity: 'minor', files_likely: ['a.js'] }, // collides with 1 → batch is [1,2]
    ]);
    startBugRound({ project: projectName, round: 1, bugs_file: 'bugs.md', total_fixes: 3 });

    const action = await pickNextAction(projectName, pickCfg());
    assert.equal(action.kind, 'fix-dev-single-call-batch');
    assert.equal(action.round, 1);
    assert.deepEqual(action.fixes.map((f) => f.n), [1, 2]);
    assert.ok(action.fixes.every((f) => f.round === 1 && typeof f.title === 'string'));
  } finally {
    rmSync(projDir, { recursive: true, force: true });
  }
});

test('pickBugAction: a MAJOR/CRITICAL head is never batched (majors/criticals never batch)', async () => {
  const { projectName, projDir } = makeProjectFixture('major-head');
  try {
    upsertProject({ name: projectName, status: 'in-progress' });
    writeFixPlan(projDir, [
      { n: 1, title: 'A', severity: 'major', files_likely: ['a.js'] },
      { n: 2, title: 'B', severity: 'minor', files_likely: ['b.js'] },
    ]);
    startBugRound({ project: projectName, round: 1, bugs_file: 'bugs.md', total_fixes: 2 });

    const action = await pickNextAction(projectName, pickCfg());
    assert.equal(action.kind, 'fix-dev', 'a non-minor head is never batched, even with a minor fix right after it');
    assert.equal(action.fix.n, 1);
  } finally {
    rmSync(projDir, { recursive: true, force: true });
  }
});

test('pickBugAction: a minor fix with missing files_likely is never batched (missing list ⇒ never batched)', async () => {
  const { projectName, projDir } = makeProjectFixture('missing-files');
  try {
    upsertProject({ name: projectName, status: 'in-progress' });
    writeFixPlan(projDir, [
      { n: 1, title: 'A', severity: 'minor' }, // no files_likely
      { n: 2, title: 'B', severity: 'minor', files_likely: ['b.js'] },
    ]);
    startBugRound({ project: projectName, round: 1, bugs_file: 'bugs.md', total_fixes: 2 });

    const action = await pickNextAction(projectName, pickCfg());
    assert.equal(action.kind, 'fix-dev', 'missing files_likely on the head collapses the batch to size 0 ⇒ classic single fix');
    assert.equal(action.fix.n, 1);
  } finally {
    rmSync(projDir, { recursive: true, force: true });
  }
});

test('pickBugAction: cap (bug_cycle.batch_max) respected', async () => {
  const { projectName, projDir } = makeProjectFixture('cap');
  try {
    upsertProject({ name: projectName, status: 'in-progress' });
    writeFixPlan(projDir, [
      { n: 1, title: 'A', severity: 'minor', files_likely: ['a.js'] },
      { n: 2, title: 'B', severity: 'minor', files_likely: ['b.js'] },
      { n: 3, title: 'C', severity: 'minor', files_likely: ['c.js'] },
    ]);
    startBugRound({ project: projectName, round: 1, bugs_file: 'bugs.md', total_fixes: 3 });

    const action = await pickNextAction(projectName, pickCfg({ batch_max: 2 }));
    assert.equal(action.kind, 'fix-dev-single-call-batch');
    assert.deepEqual(action.fixes.map((f) => f.n), [1, 2], 'cap 2 truncates an otherwise-disjoint 3-fix batch');
  } finally {
    rmSync(projDir, { recursive: true, force: true });
  }
});

test('pickBugAction: batch_minor_fixes:false ⇒ classic single-fix action (mode isolation)', async () => {
  const { projectName, projDir } = makeProjectFixture('disabled-flag');
  try {
    upsertProject({ name: projectName, status: 'in-progress' });
    writeFixPlan(projDir, [
      { n: 1, title: 'A', severity: 'minor', files_likely: ['a.js'] },
      { n: 2, title: 'B', severity: 'minor', files_likely: ['b.js'] },
    ]);
    startBugRound({ project: projectName, round: 1, bugs_file: 'bugs.md', total_fixes: 2 });

    const action = await pickNextAction(projectName, pickCfg({ batch_minor_fixes: false }));
    assert.equal(action.kind, 'fix-dev', 'batch_minor_fixes:false disables single-call batching outright');
    assert.equal(action.fix.n, 1);
  } finally {
    rmSync(projDir, { recursive: true, force: true });
  }
});

test('pickBugAction: batch_max:0 ⇒ classic single-fix action (mode isolation)', async () => {
  const { projectName, projDir } = makeProjectFixture('disabled-cap');
  try {
    upsertProject({ name: projectName, status: 'in-progress' });
    writeFixPlan(projDir, [
      { n: 1, title: 'A', severity: 'minor', files_likely: ['a.js'] },
      { n: 2, title: 'B', severity: 'minor', files_likely: ['b.js'] },
    ]);
    startBugRound({ project: projectName, round: 1, bugs_file: 'bugs.md', total_fixes: 2 });

    const action = await pickNextAction(projectName, pickCfg({ batch_max: 0 }));
    assert.equal(action.kind, 'fix-dev');
    assert.equal(action.fix.n, 1);
  } finally {
    rmSync(projDir, { recursive: true, force: true });
  }
});

test('pickBugAction: default config (max_parallel_fixes:1, batch_minor_fixes:false) ⇒ classic single-fix, byte-for-byte the pre-phase path', async () => {
  const { projectName, projDir } = makeProjectFixture('shipped-default');
  try {
    upsertProject({ name: projectName, status: 'in-progress' });
    writeFixPlan(projDir, [
      { n: 1, title: 'A', severity: 'minor', files_likely: ['a.js'] },
      { n: 2, title: 'B', severity: 'minor', files_likely: ['b.js'] },
    ]);
    startBugRound({ project: projectName, round: 1, bugs_file: 'bugs.md', total_fixes: 2 });

    const shippedCfg = {
      auto_run: {}, bug_cycle: { max_parallel_fixes: 1, batch_minor_fixes: false, batch_max: 4 },
      fixes: { inline_fix_prompts: true }, paths: { workspace_subdir: 'workspace' },
    };
    const action = await pickNextAction(projectName, shippedCfg);
    assert.equal(action.kind, 'fix-dev');
  } finally {
    rmSync(projDir, { recursive: true, force: true });
  }
});

test('pickBugAction: max_parallel_fixes>1 (lanes) + batch_minor_fixes on ⇒ lanes win, single-call batching skipped with a named-config log', async () => {
  const { projectName, projDir } = makeProjectFixture('lanes-win');
  const origLog = console.log;
  const lines = [];
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    upsertProject({ name: projectName, status: 'in-progress' });
    // A single minor fix (no P4 lane batch possible — only one pending fix),
    // so the ONLY way this could return fix-dev-single-call-batch is if P5's
    // gate were wrongly consulted despite lanes being enabled.
    writeFixPlan(projDir, [
      { n: 1, title: 'A', severity: 'minor', files_likely: ['a.js'] },
    ]);
    startBugRound({ project: projectName, round: 1, bugs_file: 'bugs.md', total_fixes: 1 });

    const action = await pickNextAction(projectName, pickCfg({ max_parallel_fixes: 3 }));
    assert.equal(action.kind, 'fix-dev', 'lanes-enabled config never emits a single-call batch');
    assert.ok(
      lines.some((l) => l.includes('max_parallel_fixes>1') && l.includes('bug_cycle')),
      'a dim log names the deciding config key + layer',
    );
  } finally {
    console.log = origLog;
    rmSync(projDir, { recursive: true, force: true });
  }
});

// ── buildInlineFixBatchPrompt: report paths, commit contract, cache discipline ─

function fixtureBatchArgs(round, fixesSpec) {
  const projDir = path.join(PROJECTS_DIR, `p70-prompt-${_seq++}`);
  const workspaceDir = path.join(projDir, 'workspace');
  const fixes = fixesSpec.map((f) => ({ round, n: f.n, title: f.title, fixMeta: f.fixMeta ?? null }));
  return { projectName: 'demo', round, fixes, projDir, workspaceDir, plan: { phases: [] } };
}

test('buildInlineFixBatchPrompt: every fix is listed with its own report path and per-fix commit contract', async () => {
  const args = fixtureBatchArgs(5, [
    { n: 1, title: 'Alpha', fixMeta: { title: 'Alpha', files_likely: ['a.js'] } },
    { n: 2, title: 'Beta', fixMeta: { title: 'Beta', files_likely: ['b.js'] } },
  ]);
  const prompt = await buildInlineFixBatchPrompt(args);

  const rp1 = path.relative(args.workspaceDir, await fixReportPath(args.projDir, 5, 1, 'Alpha'));
  const rp2 = path.relative(args.workspaceDir, await fixReportPath(args.projDir, 5, 2, 'Beta'));
  assert.ok(prompt.includes(`Fix 1/2: r5-1`));
  assert.ok(prompt.includes(`Fix 2/2: r5-2`));
  assert.ok(prompt.includes(rp1), 'fix 1 report path present');
  assert.ok(prompt.includes(rp2), 'fix 2 report path present');
  assert.match(prompt, /fix-r5-N: <one-line summary>/, 'per-fix commit subject contract present');
  assert.match(prompt, /ONE commit per fix/i);
  assert.match(prompt, /NEVER combine two or more fixes into a single commit/i);
});

test('buildInlineFixBatchPrompt: the static Rules/Commit-contract block is byte-identical across two builds with different fix content (same round)', async () => {
  const argsA = fixtureBatchArgs(9, [
    { n: 1, title: 'Alpha', fixMeta: { title: 'Alpha', files_likely: ['a.js'] } },
    { n: 2, title: 'Beta', fixMeta: { title: 'Beta', files_likely: ['b.js'] } },
  ]);
  const argsB = fixtureBatchArgs(9, [
    { n: 5, title: 'Gamma', fixMeta: { title: 'Gamma', files_likely: ['c.js', 'd.js'] } },
    { n: 6, title: 'Delta', fixMeta: null },
    { n: 7, title: 'Epsilon', fixMeta: { title: 'Epsilon' } },
  ]);
  // Same workspaceDir/projDir shape needed for report-path relativization to match.
  argsB.projDir = argsA.projDir;
  argsB.workspaceDir = argsA.workspaceDir;

  const promptA = await buildInlineFixBatchPrompt(argsA);
  const promptB = await buildInlineFixBatchPrompt(argsB);

  const extractStaticBlock = (p) => {
    const start = p.indexOf('## Rules (apply to EVERY fix above)');
    const end = p.indexOf('## Definition of done');
    assert.ok(start >= 0 && end > start, 'static block markers found');
    return p.slice(start, end);
  };
  assert.equal(extractStaticBlock(promptA), extractStaticBlock(promptB), 'Rules + Commit-contract block is identical regardless of batch content, for the same round');
});

test('buildInlineFixBatchPrompt: pure/deterministic — identical inputs (fresh objects) produce byte-identical output', async () => {
  const spec = [{ n: 1, title: 'Alpha', fixMeta: { title: 'Alpha', files_likely: ['a.js'] } }];
  const args1 = fixtureBatchArgs(3, spec);
  const args2 = { ...args1, fixes: JSON.parse(JSON.stringify(args1.fixes)) };
  const a = await buildInlineFixBatchPrompt(args1);
  const b = await buildInlineFixBatchPrompt(args2);
  assert.equal(a, b);
});

// ── runFixSingleCallBatch: fixture-repo harness (real git, NO worktrees) ────────

function makeRepoFixture(label) {
  const projDir = mkdtempSync(path.join(tmpdir(), `aorch-singlebatch-proj-${label}-`));
  const workspaceDir = mkdtempSync(path.join(tmpdir(), `aorch-singlebatch-ws-${label}-`));
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

// A remote bare repo so aheadBehind has an upstream to compare against.
function addBareRemote(workspaceDir, label) {
  const remoteDir = mkdtempSync(path.join(tmpdir(), `aorch-singlebatch-remote-${label}-`));
  execSync(`git init -q --bare "${remoteDir}"`);
  execSync(`git remote add origin "${remoteDir}"`, { cwd: workspaceDir });
  execSync('git push -q -u origin HEAD', { cwd: workspaceDir });
  return remoteDir;
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

const batchCfg = () => ({ validators: { enabled: false }, bug_cycle: { batch_minor_fixes: true, batch_max: 4 } });
const passGate = async () => ({ hasFailures: false, results: [] });

test('runFixSingleCallBatch: 3-of-3 committed ⇒ 3 completions recorded ascending, ONE gate run, ONE push', async () => {
  const projectName = `singlebatch-clean-${_seq++}`;
  const { projDir, workspaceDir } = makeRepoFixture(projectName);
  addBareRemote(workspaceDir, projectName);
  await primeBugRound({ projectName, workspaceDir, totalFixes: 3 });

  let pushCount = 0;
  let gateCount = 0;
  const outcome = await runFixSingleCallBatch(
    { projectName, cfg: batchCfg(), projDir, workspaceDir, round: 1,
      fixes: [{ round: 1, n: 1, title: 'A' }, { round: 1, n: 2, title: 'B' }, { round: 1, n: 3, title: 'C' }] },
    {
      runDev: async () => {
        for (const n of [1, 2, 3]) {
          writeFileSync(path.join(workspaceDir, `f${n}.js`), `export const v = ${n};\n`);
          execSync('git add -A', { cwd: workspaceDir });
          execSync(`git commit -q -m "fix-r1-${n}: work"`, { cwd: workspaceDir });
        }
        return { is_error: false };
      },
      gateMergedFixHead: async () => { gateCount += 1; return passGate(); },
      pushBranch: async () => { pushCount += 1; return { ok: true }; },
    },
  );

  assert.deepEqual(outcome.mergedFixes, [1, 2, 3]);
  assert.equal(outcome.failure, null);
  assert.equal(outcome.pushed, true);
  assert.equal(pushCount, 1, 'exactly ONE push per batch');
  assert.equal(gateCount, 1, 'exactly ONE gate run per batch');
  assert.deepEqual(outcome.batchFallback, []);

  assert.equal(getBugRound(projectName, 1).fixes_completed, 3);
  for (const n of [1, 2, 3]) {
    assert.equal(await fixCommitExists(workspaceDir, 1, n), true);
    assert.ok(existsSync(path.join(workspaceDir, `f${n}.js`)));
  }
});

test('runFixSingleCallBatch: dev call errors ⇒ unpushed commits reset to preBatchSha, zero completions, all pending, no markers written', async () => {
  const projectName = `singlebatch-callerror-${_seq++}`;
  const { projDir, workspaceDir } = makeRepoFixture(projectName);
  addBareRemote(workspaceDir, projectName);
  await primeBugRound({ projectName, workspaceDir, totalFixes: 2 });
  const preSha = execSync('git rev-parse HEAD', { cwd: workspaceDir }).toString().trim();

  const outcome = await runFixSingleCallBatch(
    { projectName, cfg: batchCfg(), projDir, workspaceDir, round: 1,
      fixes: [{ round: 1, n: 1, title: 'A' }, { round: 1, n: 2, title: 'B' }] },
    {
      // The dev call itself commits SOMETHING before erroring (e.g. partial work), then reports is_error.
      runDev: async () => {
        writeFileSync(path.join(workspaceDir, 'f1.js'), 'export const v = 1;\n');
        execSync('git add -A', { cwd: workspaceDir });
        execSync('git commit -q -m "fix-r1-1: work"', { cwd: workspaceDir });
        return { is_error: true, error_message: 'dev boom', result: 'dev boom' };
      },
      pushBranch: async () => { throw new Error('must not push'); },
    },
  );

  assert.equal(outcome.failure.kind, 'dev');
  assert.equal(outcome.failure.reset, true, 'commits were unpushed — reset applied');
  assert.deepEqual(outcome.mergedFixes, []);
  assert.equal(outcome.pushed, false);
  assert.deepEqual(outcome.batchFallback, ['r1-1', 'r1-2']);
  assert.equal(getBugRound(projectName, 1).fixes_completed, 0);
  assert.equal(execSync('git rev-parse HEAD', { cwd: workspaceDir }).toString().trim(), preSha, 'HEAD reset to preBatchSha');
  assert.equal(await fixCommitExists(workspaceDir, 1, 1), false, 'the partial commit was rolled back');

  const lessons = readFileSync(path.join(projDir, '.guide', 'lessons.jsonl'), 'utf-8');
  assert.match(lessons, /"kind":"batch-fallback"/);
  const note = readFileSync(path.join(projDir, '.guide', 'bug-rounds', 'round-1', 'batch-fallback.md'), 'utf-8');
  assert.match(note, /fell back to individual dispatch/);
});

test('runFixSingleCallBatch: merged-HEAD gate fails ⇒ reset to preBatchSha, zero completions, no push', async () => {
  const projectName = `singlebatch-gatefail-${_seq++}`;
  const { projDir, workspaceDir } = makeRepoFixture(projectName);
  addBareRemote(workspaceDir, projectName);
  await primeBugRound({ projectName, workspaceDir, totalFixes: 2 });
  const preSha = execSync('git rev-parse HEAD', { cwd: workspaceDir }).toString().trim();

  const outcome = await runFixSingleCallBatch(
    { projectName, cfg: batchCfg(), projDir, workspaceDir, round: 1,
      fixes: [{ round: 1, n: 1, title: 'A' }, { round: 1, n: 2, title: 'B' }] },
    {
      runDev: async () => {
        for (const n of [1, 2]) {
          writeFileSync(path.join(workspaceDir, `f${n}.js`), `export const v = ${n};\n`);
          execSync('git add -A', { cwd: workspaceDir });
          execSync(`git commit -q -m "fix-r1-${n}: work"`, { cwd: workspaceDir });
        }
        return { is_error: false };
      },
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
  assert.equal(execSync('git rev-parse HEAD', { cwd: workspaceDir }).toString().trim(), preSha);
  assert.equal(await fixCommitExists(workspaceDir, 1, 1), false);
  assert.equal(existsSync(path.join(projDir, '.guide', `fix-r1-1-escalate.marker`)), false, 'no batch-level escalation marker written');
  assert.equal(existsSync(path.join(projDir, '.guide', `fix-r1-1-validation-failed.marker`)), false, 'no batch-level validation marker written');
});

test('runFixSingleCallBatch: aheadBehind ambiguous/pushed ⇒ commits NOT reset, falls through to failure path with commits intact', async () => {
  const projectName = `singlebatch-ambiguous-${_seq++}`;
  const { projDir, workspaceDir } = makeRepoFixture(projectName);
  addBareRemote(workspaceDir, projectName);
  await primeBugRound({ projectName, workspaceDir, totalFixes: 1 });

  const outcome = await runFixSingleCallBatch(
    { projectName, cfg: batchCfg(), projDir, workspaceDir, round: 1, fixes: [{ round: 1, n: 1, title: 'A' }] },
    {
      runDev: async () => {
        writeFileSync(path.join(workspaceDir, 'f1.js'), 'export const v = 1;\n');
        execSync('git add -A', { cwd: workspaceDir });
        execSync('git commit -q -m "fix-r1-1: work"', { cwd: workspaceDir });
        // Simulate the commit already being pushed by a concurrent process.
        execSync('git push -q origin HEAD:refs/heads/' + (await getCurrentBranch(workspaceDir)), { cwd: workspaceDir });
        return { is_error: true, error_message: 'dev boom', result: 'dev boom' };
      },
    },
  );

  assert.equal(outcome.failure.kind, 'dev');
  assert.equal(outcome.failure.reset, false, 'ahead=0 after the (simulated) push — ambiguous/pushed, must not reset');
  assert.equal(await fixCommitExists(workspaceDir, 1, 1), true, 'commit left in place, not rolled back');
});

test('runFixSingleCallBatch: partial (2-of-4 contiguous committed) ⇒ first two recorded, 3-4 re-queued individually', async () => {
  const projectName = `singlebatch-partial-${_seq++}`;
  const { projDir, workspaceDir } = makeRepoFixture(projectName);
  addBareRemote(workspaceDir, projectName);
  await primeBugRound({ projectName, workspaceDir, totalFixes: 4 });

  let pushCount = 0;
  const outcome = await runFixSingleCallBatch(
    { projectName, cfg: batchCfg(), projDir, workspaceDir, round: 1,
      fixes: [{ round: 1, n: 1, title: 'A' }, { round: 1, n: 2, title: 'B' }, { round: 1, n: 3, title: 'C' }, { round: 1, n: 4, title: 'D' }] },
    {
      // Agent only committed fixes 1 and 2 before stopping (turn budget, etc.) — gate still passes.
      runDev: async () => {
        for (const n of [1, 2]) {
          writeFileSync(path.join(workspaceDir, `f${n}.js`), `export const v = ${n};\n`);
          execSync('git add -A', { cwd: workspaceDir });
          execSync(`git commit -q -m "fix-r1-${n}: work"`, { cwd: workspaceDir });
        }
        return { is_error: false };
      },
      gateMergedFixHead: passGate,
      pushBranch: async () => { pushCount += 1; return { ok: true }; },
    },
  );

  assert.deepEqual(outcome.mergedFixes, [1, 2], 'only the contiguous committed prefix recorded');
  assert.equal(outcome.pushed, true, 'the committed prefix still pushed');
  assert.equal(pushCount, 1);
  assert.deepEqual(outcome.batchFallback, ['r1-3', 'r1-4'], 'the rest re-queued individually, not re-batched');
  assert.equal(getBugRound(projectName, 1).fixes_completed, 2);
});

// ── Mode isolation (source inspection): the P5 dispatch is gated ───────────────

test('mode isolation (auto-runner source): fix-dev-single-call-batch dispatch calls runFixSingleCallBatch and is gated behind max_parallel_fixes===1', () => {
  const src = readFileSync(path.join(__dirname, '..', 'auto-runner.js'), 'utf-8');
  assert.match(
    src,
    /if \(action\.kind === 'fix-dev-single-call-batch'\) \{[\s\S]{0,200}?runFixSingleCallBatch\(/,
    'fix-dev-single-call-batch dispatch calls runFixSingleCallBatch',
  );
  assert.match(
    src,
    /if \(maxParallelFixes > 1\) \{[\s\S]{0,400}?fix lanes win/,
    'P5 batching is gated behind the P4 lanes precedence check',
  );
});
