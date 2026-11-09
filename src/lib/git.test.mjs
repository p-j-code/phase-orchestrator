// Detached-worktree primitive (Phase 50) — src/lib/git.test.mjs
//
// Covers addDetachedWorktree / removeWorktree against a real temp git repo:
// a worktree pinned to an older sha must show that sha's content while the
// main tree moves ahead, changedFilesSince must work from inside it, and
// removeWorktree must clean up (and never throw on a bogus dir).
//
// Run with: node --test src/lib/git.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  runGit, getHeadSha, changedFilesSince, addDetachedWorktree, removeWorktree,
  worktreeAdd, worktreeRemove, worktreePrune, deleteBranch, mergeNoFf,
  getCurrentBranch, branchExists, workspaceStatus, commitAll,
} from './git.js';
import { worktreesRoot } from './guide-paths.js';

function makeRepo(label) {
  const projDir = mkdtempSync(path.join(tmpdir(), `aorch-git-proj-${label}-`));
  const workspaceDir = mkdtempSync(path.join(tmpdir(), `aorch-git-ws-${label}-`));
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

test('addDetachedWorktree pins a worktree to an older sha while the main tree moves ahead', async () => {
  const { workspaceDir } = makeRepo('pin');
  writeAndCommit(workspaceDir, 'file.txt', 'v1\n', 'init');
  const oldSha = await getHeadSha(workspaceDir);

  writeAndCommit(workspaceDir, 'file.txt', 'v2\n', 'second');
  const headSha = await getHeadSha(workspaceDir);
  assert.notEqual(oldSha, headSha);

  const wtDir = path.join(workspaceDir, '..', `wt-${path.basename(workspaceDir)}`, `verify-${oldSha.slice(0, 8)}`);
  const r = await addDetachedWorktree(workspaceDir, { sha: oldSha, dir: wtDir });
  try {
    assert.equal(r.ok, true, r.error);
    assert.equal(r.dir, wtDir);

    const worktreeContent = readFileSync(path.join(wtDir, 'file.txt'), 'utf-8');
    const mainContent = readFileSync(path.join(workspaceDir, 'file.txt'), 'utf-8');
    assert.equal(worktreeContent, 'v1\n');
    assert.equal(mainContent, 'v2\n');
  } finally {
    await removeWorktree(workspaceDir, wtDir);
  }
});

test('changedFilesSince works from inside a detached worktree pinned to a fixed sha, even after the main tree moves further ahead', async () => {
  const { workspaceDir } = makeRepo('changed-files');
  writeAndCommit(workspaceDir, 'a.txt', 'a1\n', 'init');
  const oldSha = await getHeadSha(workspaceDir);

  writeAndCommit(workspaceDir, 'b.txt', 'b1\n', 'add b');
  const pinnedSha = await getHeadSha(workspaceDir);

  // Pin the worktree to pinnedSha — this is the "point-in-time view" P2/P3/P6
  // use: a fixed sha to diff against, independent of whatever the main tree
  // does next.
  const wtDir = path.join(workspaceDir, '..', `wt2-${path.basename(workspaceDir)}`, `verify-${pinnedSha.slice(0, 8)}`);
  const r = await addDetachedWorktree(workspaceDir, { sha: pinnedSha, dir: wtDir });
  assert.equal(r.ok, true, r.error);

  try {
    const changed = await changedFilesSince(wtDir, oldSha);
    assert.equal(changed.ok, true);
    assert.deepEqual(changed.files, ['b.txt']);

    // Main tree keeps moving after the worktree was pinned — the worktree's
    // view (and thus changedFilesSince computed inside it) must not shift.
    writeAndCommit(workspaceDir, 'c.txt', 'c1\n', 'add c (after pin)');
    const changedAfterMainMoved = await changedFilesSince(wtDir, oldSha);
    assert.equal(changedAfterMainMoved.ok, true);
    assert.deepEqual(changedAfterMainMoved.files, ['b.txt'], 'worktree diff must stay pinned even though the main tree advanced further');
  } finally {
    await removeWorktree(workspaceDir, wtDir);
  }
});

test('removeWorktree cleans the directory and drops the entry from `git worktree list`', async () => {
  const { workspaceDir } = makeRepo('remove');
  writeAndCommit(workspaceDir, 'file.txt', 'v1\n', 'init');
  const sha = await getHeadSha(workspaceDir);

  const wtDir = path.join(workspaceDir, '..', `wt3-${path.basename(workspaceDir)}`, `verify-${sha.slice(0, 8)}`);
  const added = await addDetachedWorktree(workspaceDir, { sha, dir: wtDir });
  assert.equal(added.ok, true, added.error);
  assert.ok(existsSync(wtDir));

  const beforeList = await runGit(workspaceDir, ['worktree', 'list', '--porcelain']);
  assert.ok(beforeList.stdout.includes(wtDir));

  await removeWorktree(workspaceDir, wtDir);

  assert.equal(existsSync(wtDir), false, 'worktree directory should be removed from disk');
  const afterList = await runGit(workspaceDir, ['worktree', 'list', '--porcelain']);
  assert.ok(!afterList.stdout.includes(wtDir), 'worktree entry should be gone from `git worktree list`');
});

test('removeWorktree never throws for a missing / never-created / bogus dir', async () => {
  const { workspaceDir } = makeRepo('never-throw');
  writeAndCommit(workspaceDir, 'file.txt', 'v1\n', 'init');

  await assert.doesNotReject(async () => {
    await removeWorktree(workspaceDir, path.join(workspaceDir, '..', 'does-not-exist', 'bogus-worktree-dir'));
  });

  // Calling it a second time on the same (now nonexistent, formerly real) dir
  // is the "already-removed" case — also must not throw.
  const sha = await getHeadSha(workspaceDir);
  const wtDir = path.join(workspaceDir, '..', `wt4-${path.basename(workspaceDir)}`, `verify-${sha.slice(0, 8)}`);
  await addDetachedWorktree(workspaceDir, { sha, dir: wtDir });
  await removeWorktree(workspaceDir, wtDir);
  await assert.doesNotReject(async () => {
    await removeWorktree(workspaceDir, wtDir);
  });
});

test('every git invocation in addDetachedWorktree/removeWorktree goes through runGit (no direct spawn)', () => {
  const src = readFileSync(new URL('./git.js', import.meta.url), 'utf-8');
  const start = src.indexOf('export async function addDetachedWorktree');
  const end = src.indexOf('// ── Operations');
  const section = src.slice(start, end);
  assert.ok(!/\bspawn\(/.test(section), 'addDetachedWorktree/removeWorktree must call runGit, not spawn() directly');
  assert.ok(section.includes('runGit(workspaceDir'), 'expected runGit calls in the worktree section');
});

// ── Lane worktree lifecycle helpers (Phase 67) ──────────────────────────────

test('worktreeAdd creates a worktree on a NEW branch off startSha; worktreeRemove + deleteBranch tear it down', async () => {
  const { workspaceDir } = makeRepo('lane-add');
  writeAndCommit(workspaceDir, 'file.txt', 'v1\n', 'init');
  const baseSha = await getHeadSha(workspaceDir);
  writeAndCommit(workspaceDir, 'file.txt', 'v2\n', 'second'); // main advances past baseSha

  const laneDir = path.join(workspaceDir, '..', `lane-${path.basename(workspaceDir)}`, 'phase-1');
  const add = await worktreeAdd(workspaceDir, { path: laneDir, branch: 'lane/phase-1', startSha: baseSha });
  try {
    assert.equal(add.ok, true, add.error);
    assert.equal(add.path, laneDir);
    assert.equal(add.branch, 'lane/phase-1');
    assert.ok(existsSync(laneDir));
    // Checked out on the new branch, pinned to baseSha's content.
    assert.equal(await getCurrentBranch(laneDir), 'lane/phase-1');
    assert.equal(readFileSync(path.join(laneDir, 'file.txt'), 'utf-8'), 'v1\n');
    assert.ok(await branchExists(workspaceDir, 'lane/phase-1'));
  } finally {
    const rm = await worktreeRemove(workspaceDir, laneDir);
    assert.equal(rm.ok, true, rm.error);
    await worktreePrune(workspaceDir);
    const del = await deleteBranch(workspaceDir, 'lane/phase-1');
    assert.equal(del.ok, true, del.error);
  }
  assert.equal(existsSync(laneDir), false, 'worktree dir removed');
  assert.equal(await branchExists(workspaceDir, 'lane/phase-1'), false, 'lane branch deleted');
});

test('mergeNoFf brings a lane branch commit into the current branch with a merge commit (--no-ff)', async () => {
  const { workspaceDir } = makeRepo('lane-merge');
  writeAndCommit(workspaceDir, 'a.txt', 'a\n', 'init');
  const baseSha = await getHeadSha(workspaceDir);

  const laneDir = path.join(workspaceDir, '..', `lanemerge-${path.basename(workspaceDir)}`, 'phase-1');
  const add = await worktreeAdd(workspaceDir, { path: laneDir, branch: 'lane/phase-1', startSha: baseSha });
  assert.equal(add.ok, true, add.error);
  try {
    // Commit inside the lane.
    writeFileSync(path.join(laneDir, 'lane.txt'), 'lane work\n');
    execSync('git add -A', { cwd: laneDir });
    execSync('git commit -q -m "phase-1: lane work"', { cwd: laneDir });

    // Merge the lane branch into the primary (currently on the default branch).
    const merge = await mergeNoFf(workspaceDir, { branch: 'lane/phase-1', message: 'merge phase-1 lane' });
    assert.equal(merge.ok, true, merge.error);
    assert.ok(existsSync(path.join(workspaceDir, 'lane.txt')), 'lane commit content is in the primary tree');

    // --no-ff → HEAD is a merge commit (2 parents).
    const parents = await runGit(workspaceDir, ['rev-list', '--parents', '-n', '1', 'HEAD']);
    assert.equal(parents.stdout.trim().split(/\s+/).length, 3, 'HEAD has 2 parents (merge commit)');
  } finally {
    await worktreeRemove(workspaceDir, laneDir);
    await worktreePrune(workspaceDir);
    await deleteBranch(workspaceDir, 'lane/phase-1');
  }
});

test('worktreeRemove / deleteBranch return { ok:false } (never throw) against a missing worktree / branch', async () => {
  const { workspaceDir } = makeRepo('lane-missing');
  writeAndCommit(workspaceDir, 'a.txt', 'a\n', 'init');
  const rm = await worktreeRemove(workspaceDir, path.join(workspaceDir, '..', 'nope', 'phase-1'));
  assert.equal(rm.ok, false);
  assert.ok(rm.error);
  const del = await deleteBranch(workspaceDir, 'lane/does-not-exist');
  assert.equal(del.ok, false);
  assert.ok(del.error);
});

// ── commitAll (Phase 81 — test-first harness primitive) ──────────────────────

test('commitAll stages and commits every change (tracked mods + new files) and advances HEAD', async () => {
  const { workspaceDir } = makeRepo('commit-all');
  writeAndCommit(workspaceDir, 'tracked.txt', 'v1\n', 'init');
  const before = await getHeadSha(workspaceDir);

  // A modified tracked file AND a brand-new untracked file — commitAll must
  // pick up both (`git add -A`).
  writeFileSync(path.join(workspaceDir, 'tracked.txt'), 'v2\n');
  writeFileSync(path.join(workspaceDir, 'authored.test.mjs'), 'export const red = true;\n');

  const r = await commitAll(workspaceDir, 'phase-1: authored failing test');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.committed, true);
  const after = await getHeadSha(workspaceDir);
  assert.equal(r.sha, after);
  assert.notEqual(after, before, 'HEAD advanced');

  // Both paths are in the tree now, and the working tree is clean.
  assert.equal((await workspaceStatus(workspaceDir)).clean, true);
  assert.deepEqual((await changedFilesSince(workspaceDir, before)).files.sort(), ['authored.test.mjs', 'tracked.txt']);
});

test('commitAll is a no-op on a clean tree (committed:false, HEAD unchanged, no empty commit)', async () => {
  const { workspaceDir } = makeRepo('commit-all-clean');
  writeAndCommit(workspaceDir, 'file.txt', 'v1\n', 'init');
  const before = await getHeadSha(workspaceDir);

  const r = await commitAll(workspaceDir, 'phase-1: nothing to commit');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.committed, false, 'clean tree must not produce a commit');
  assert.equal(await getHeadSha(workspaceDir), before, 'HEAD must not move on a clean tree');
});

test('commitAll rejects an empty/blank message without touching the repo', async () => {
  const { workspaceDir } = makeRepo('commit-all-msg');
  writeAndCommit(workspaceDir, 'file.txt', 'v1\n', 'init');
  const before = await getHeadSha(workspaceDir);
  writeFileSync(path.join(workspaceDir, 'new.txt'), 'x\n');

  const r = await commitAll(workspaceDir, '   ');
  assert.equal(r.ok, false);
  assert.match(r.error, /message/i);
  assert.equal(await getHeadSha(workspaceDir), before, 'no commit created for a blank message');
});

test('commitAll goes through runGit only (no direct spawn in its body)', () => {
  const src = readFileSync(new URL('./git.js', import.meta.url), 'utf-8');
  const start = src.indexOf('export async function commitAll');
  const end = src.indexOf('export async function pushBranch', start);
  const section = src.slice(start, end);
  assert.ok(!/\bspawn\(/.test(section), 'commitAll must call runGit, not spawn() directly');
  assert.ok(section.includes('runGit(workspaceDir'), 'expected runGit calls in commitAll');
});

test('workspaceStatus includeUntracked:false ignores untracked files but still reports tracked-file modifications', async () => {
  const { workspaceDir } = makeRepo('status-uno');
  writeAndCommit(workspaceDir, 'tracked.txt', 'v1\n', 'init');

  // An untracked file → clean under -uno, dirty under the default.
  writeFileSync(path.join(workspaceDir, 'untracked.txt'), 'new\n');
  assert.equal((await workspaceStatus(workspaceDir, { includeUntracked: false })).clean, true);
  assert.equal((await workspaceStatus(workspaceDir)).clean, false);

  // A modified TRACKED file → dirty under both.
  writeFileSync(path.join(workspaceDir, 'tracked.txt'), 'v2\n');
  assert.equal((await workspaceStatus(workspaceDir, { includeUntracked: false })).clean, false);
});
