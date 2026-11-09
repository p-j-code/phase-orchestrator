// Git helpers — single point for all git operations across the orchestrator.
//
// Design notes:
//   - All commands run with cwd = workspaceDir; we NEVER run git in projDir
//     (which would touch the orchestrator's own repo or contain .guide files).
//   - Every helper returns a Result-like object { ok, stdout?, stderr?, code? }
//     for callers that want to handle failures gracefully. The throwing
//     variants suffix with "OrThrow".
//   - Push failures are NEVER allowed to fail a phase. They surface as
//     warnings via the returned object; callers decide how to notify.
//   - No --force, ever. The orchestrator never overwrites remote history.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Run an arbitrary git command. Returns { ok, code, stdout, stderr }.
 * Never throws — callers branch on `.ok`.
 */
export function runGit(workspaceDir, args, { timeout = 60_000, maxOutputChars = null } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timed = false;
    let truncated = false;

    const proc = spawn('git', args, {
      cwd: workspaceDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, // never block on auth prompt
      detached: true,
    });

    const t = setTimeout(() => {
      timed = true;
      try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* setsid race — retry coming */ }
      setTimeout(() => {
        try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* already dead */ }
      }, 100).unref?.();
      setTimeout(() => {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* already dead */ }
      }, 5000).unref?.();
    }, timeout);
    t.unref?.();

    proc.stdout.on('data', (d) => {
      if (truncated) return;
      stdout += d.toString();
      if (Number.isFinite(maxOutputChars) && maxOutputChars > 0 && stdout.length > maxOutputChars) {
        stdout = stdout.slice(0, maxOutputChars);
        truncated = true;
        try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* already exited */ }
      }
    });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => {
      clearTimeout(t);
      resolve({ ok: false, code: -1, stdout, stderr: err.message });
    });
    proc.on('exit', (code) => {
      clearTimeout(t);
      if (timed) return resolve({ ok: false, code: -1, stdout, stderr: stderr + '\n[git timed out]', truncated });
      resolve({ ok: code === 0 || truncated, code, stdout: stdout.trim(), stderr: stderr.trim(), truncated });
    });
  });
}

export async function runGitOrThrow(workspaceDir, args, opts) {
  const r = await runGit(workspaceDir, args, opts);
  if (!r.ok) throw new Error(`git ${args.join(' ')} failed (exit ${r.code}): ${r.stderr}`);
  return r.stdout;
}

// ── Inspection ────────────────────────────────────────────────────────────

export async function isGitRepo(workspaceDir) {
  try {
    await fs.access(path.join(workspaceDir, '.git'));
  } catch {
    // .git may be a file (worktree) or missing
    const r = await runGit(workspaceDir, ['rev-parse', '--git-dir']);
    return r.ok;
  }
  return true;
}

export async function hasRemote(workspaceDir, name = 'origin') {
  const r = await runGit(workspaceDir, ['remote', 'get-url', name]);
  return r.ok ? r.stdout : null;
}

export async function getCurrentBranch(workspaceDir) {
  const r = await runGit(workspaceDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.ok ? r.stdout : null;
}

export async function getHeadSha(workspaceDir) {
  const r = await runGit(workspaceDir, ['rev-parse', 'HEAD']);
  return r.ok ? r.stdout : null;
}

/**
 * Return the first parent of a commit, or null when the commit is missing or
 * is the repository root. Used by interrupted-phase reconciliation so the
 * existing phase commit can flow through the normal diff-scoped validators
 * without asking the dev agent to recreate it.
 */
export async function getCommitParentSha(workspaceDir, sha) {
  if (!sha) return null;
  const r = await runGit(workspaceDir, ['rev-parse', `${sha}^`]);
  return r.ok ? r.stdout : null;
}

export async function branchExists(workspaceDir, branch) {
  const r = await runGit(workspaceDir, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  return r.ok;
}

export async function remoteBranchExists(workspaceDir, branch, remote = 'origin') {
  const r = await runGit(workspaceDir, ['ls-remote', '--exit-code', '--heads', remote, branch]);
  return r.ok;
}

/**
 * Returns { clean: boolean, dirty: string[] }.
 * `includeUntracked:false` (phase-67 lane clean-tree check) passes
 * `--untracked-files=no` so only modifications to TRACKED files count as dirty —
 * a provisioned lane worktree legitimately carries untracked files (node_modules
 * symlink, copied .env, materialized .claude/skills) that must not fail the check.
 */
export async function workspaceStatus(workspaceDir, { includeUntracked = true } = {}) {
  const args = ['status', '--porcelain'];
  if (!includeUntracked) args.push('--untracked-files=no');
  const r = await runGit(workspaceDir, args);
  if (!r.ok) return { clean: false, dirty: [], error: r.stderr };
  const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  return { clean: lines.length === 0, dirty: lines };
}

/** Returns { ahead: number, behind: number } vs origin/<branch>, or null if no upstream. */
export async function aheadBehind(workspaceDir, branch, remote = 'origin') {
  const ref = `${remote}/${branch}`;
  const exists = await runGit(workspaceDir, ['rev-parse', '--verify', ref]);
  if (!exists.ok) return null;
  const r = await runGit(workspaceDir, ['rev-list', '--left-right', '--count', `${ref}...HEAD`]);
  if (!r.ok) return null;
  const [behind, ahead] = r.stdout.split(/\s+/).map((n) => parseInt(n, 10) || 0);
  return { ahead, behind };
}

/**
 * Files changed between <sha> and HEAD (v0.14.34 — incremental re-audits).
 * Returns { ok: true, files: string[] } or { ok: false, error }.
 * A missing/garbage-collected sha (e.g. after a force-push) returns ok:false —
 * callers treat that as "do a full audit", never as an error to surface.
 */
export async function changedFilesSince(workspaceDir, sha) {
  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) {
    return { ok: false, error: `invalid sha: ${sha}` };
  }
  const res = await runGit(workspaceDir, ['diff', '--name-only', `${sha}..HEAD`]);
  if (!res.ok) return { ok: false, error: res.stderr || `git diff exited ${res.code}` };
  return { ok: true, files: res.stdout.split('\n').map((s) => s.trim()).filter(Boolean) };
}

/**
 * Insertions+deletions between <sha> and HEAD via a single `git diff
 * --shortstat` invocation (phase-28 — the prescan trigger's other signal,
 * alongside changedFilesSince's file count). Returns
 * { ok: true, insertions: number, deletions: number, text: string } or
 * { ok: false, error }. Mirrors changedFilesSince's fail-open contract: a
 * missing/garbage-collected sha is never surfaced as an error — callers
 * treat ok:false as "no diffstat, don't gate on it".
 */
export async function diffStatSince(workspaceDir, sha) {
  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) {
    return { ok: false, error: `invalid sha: ${sha}` };
  }
  const res = await runGit(workspaceDir, ['diff', '--shortstat', `${sha}..HEAD`]);
  if (!res.ok) return { ok: false, error: res.stderr || `git diff exited ${res.code}` };
  const text = res.stdout.trim();
  const insMatch = text.match(/(\d+) insertion/);
  const delMatch = text.match(/(\d+) deletion/);
  return {
    ok: true,
    insertions: insMatch ? parseInt(insMatch[1], 10) : 0,
    deletions: delMatch ? parseInt(delMatch[1], 10) : 0,
    text,
  };
}

/**
 * Per-file `git diff --stat <sha>..HEAD` (phase-40 — the assembled review
 * context's diff block; distinct from diffStatSince's single --shortstat
 * summary line). Returns { ok: true, text } (the full multi-line --stat output,
 * one line per changed file plus a summary line — the CALLER caps line count)
 * or { ok: false, error }. Same fail-open contract as diffStatSince /
 * changedFilesSince: a missing/garbage-collected sha is never surfaced as an
 * error, callers treat ok:false as "no diffstat, don't inject it".
 */
export async function diffStatDetailedSince(workspaceDir, sha) {
  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) {
    return { ok: false, error: `invalid sha: ${sha}` };
  }
  const res = await runGit(workspaceDir, ['diff', '--stat', `${sha}..HEAD`]);
  if (!res.ok) return { ok: false, error: res.stderr || `git diff exited ${res.code}` };
  return { ok: true, text: res.stdout };
}

/**
 * Git-tracked file paths at HEAD (`git ls-files`), forward-slash-relative to
 * workspaceDir. Used by the incremental repo-map path (phase-39) to rebuild
 * the directory tree without a full repomix repack. Same fail-open shape as
 * changedFilesSince — a missing/non-git workspace resolves to ok:false so
 * callers fall back to a full repack rather than treating this as an error.
 */
export async function listTrackedFiles(workspaceDir) {
  const res = await runGit(workspaceDir, ['ls-files']);
  if (!res.ok) return { ok: false, error: res.stderr || `git ls-files exited ${res.code}` };
  return { ok: true, files: res.stdout.split('\n').map((s) => s.trim()).filter(Boolean) };
}

export async function lastCommitOneLine(workspaceDir) {
  const r = await runGit(workspaceDir, ['log', '-1', '--format=%h %s']);
  return r.ok ? r.stdout : null;
}

/**
 * True if a commit whose subject starts with `fix-r{round}-{n}:` already
 * exists in the workspace history. Used to detect a fix that a prior run
 * applied + committed but never recorded as complete (crash / timeout before
 * recordFixCompletion fired) — so the orchestrator never re-dispatches it.
 *
 * The trailing colon in the pattern prevents `fix-r9-6:` from matching
 * `fix-r9-60:`. `--fixed-strings` is NOT used because we anchor with `-E`.
 */
export async function fixCommitExists(workspaceDir, round, n) {
  const r = await runGit(workspaceDir, [
    'log', '-E', `--grep=^fix-r${round}-${n}:`, '--format=%h', '-n', '1',
  ]);
  return r.ok && r.stdout.trim().length > 0;
}

/**
 * Returns the commit SHA of an already-committed phase, or null if not found.
 * Used to reconcile "no-commit" phase runs when a previous attempt committed
 * the work but the DB wasn't updated (e.g. crash after commit, before recordPhase).
 */
export async function phaseCommitSha(workspaceDir, n) {
  const r = await runGit(workspaceDir, [
    'log', '-E', `--grep=^phase-${n}:`, '--format=%H', '-n', '1',
  ]);
  const sha = r.ok ? r.stdout.trim() : '';
  return sha.length > 0 ? sha : null;
}

/**
 * Sync workspace with remote — fetches and fast-forwards if behind.
 * Never force-pulls. Never auto-rebases on divergence (data integrity).
 *
 * Returns { ok, action, behind, ahead, error? }
 *   action ∈ 'noop'         (already in sync)
 *          | 'pulled'        (fast-forwarded from behind)
 *          | 'ahead-only'    (local has unpushed commits; nothing to pull)
 *          | 'diverged'      (both ahead and behind; halt — ok: false)
 *          | 'dirty'         (uncommitted changes would be overwritten; halt — ok: false)
 *          | 'fetch-failed'  (network/auth; halt — ok: false)
 *          | 'pull-failed'   (unexpected merge issue; halt — ok: false)
 *          | 'no-upstream'   (branch has no remote tracking — treated as ok)
 */
export async function syncWithRemote(workspaceDir, { branch = null, remote = 'origin' } = {}) {
  const targetBranch = branch || (await getCurrentBranch(workspaceDir));
  if (!targetBranch) {
    return { ok: false, action: 'error', behind: 0, ahead: 0, error: 'Could not determine branch' };
  }

  // Fetch is the only step that hits the network. Bound it.
  const fetch = await runGit(workspaceDir, ['fetch', remote, targetBranch], { timeout: 60_000 });
  if (!fetch.ok) {
    return {
      ok: false, action: 'fetch-failed', behind: 0, ahead: 0,
      error: `git fetch ${remote} ${targetBranch} failed: ${fetch.stderr}`,
    };
  }

  const ab = await aheadBehind(workspaceDir, targetBranch, remote);
  if (!ab) {
    // No upstream tracking — fresh branch, never pushed. That's fine; the
    // next push-with-upstream from pushBranch() will wire tracking up.
    return { ok: true, action: 'no-upstream', behind: 0, ahead: 0 };
  }

  if (ab.behind === 0 && ab.ahead === 0) {
    return { ok: true, action: 'noop', behind: 0, ahead: 0 };
  }

  if (ab.behind > 0 && ab.ahead > 0) {
    return {
      ok: false, action: 'diverged', behind: ab.behind, ahead: ab.ahead,
      error:
        `Workspace and ${remote}/${targetBranch} have diverged: ` +
        `${ab.ahead} local commit(s), ${ab.behind} remote commit(s). ` +
        `Reconcile manually:\n` +
        `  cd ${workspaceDir}\n` +
        `  git log ${remote}/${targetBranch}..HEAD   # what you have that remote doesn't\n` +
        `  git log HEAD..${remote}/${targetBranch}   # what remote has that you don't\n` +
        `  # then: git pull --rebase ${remote} ${targetBranch}   (or merge)`,
    };
  }

  if (ab.behind > 0 && ab.ahead === 0) {
    // Guard: uncommitted changes to tracked files would be overwritten by the pull.
    // Untracked files (e.g. .claude/, .guide/) are not touched by ff-only pull.
    const status = await workspaceStatus(workspaceDir, { includeUntracked: false });
    if (!status.clean) {
      return {
        ok: false, action: 'dirty', behind: ab.behind, ahead: 0,
        error:
          `Cannot pull: workspace has ${status.dirty.length} uncommitted change(s) that would be overwritten.\n` +
          `Commit or stash them first:\n` +
          `  cd ${workspaceDir}\n` +
          `  git stash   # then: git stash pop after the pull`,
      };
    }
    let pull = await runGit(workspaceDir, ['pull', '--ff-only', remote, targetBranch], { timeout: 60_000 });
    if (!pull.ok) {
      // git pull fails when untracked local files conflict with remote paths.
      // Parse the list, remove them, and retry once — they are not committed
      // work and the remote version is authoritative.
      const conflictMatch = pull.stderr.match(
        /The following untracked working tree files would be overwritten by merge:\n([\s\S]+?)\nPlease move or remove them/,
      );
      if (conflictMatch) {
        const paths = conflictMatch[1].split('\n').map((p) => p.trim()).filter(Boolean);
        await Promise.all(paths.map(async (p) => {
          const abs = path.join(workspaceDir, p);
          await fs.rm(abs, { force: true, recursive: true }).catch(() => {});
        }));
        pull = await runGit(workspaceDir, ['pull', '--ff-only', remote, targetBranch], { timeout: 60_000 });
      }
    }
    if (!pull.ok) {
      return {
        ok: false, action: 'pull-failed', behind: ab.behind, ahead: 0,
        error: `git pull --ff-only failed: ${pull.stderr}`,
      };
    }
    return { ok: true, action: 'pulled', behind: ab.behind, ahead: 0 };
  }

  // ahead > 0 && behind === 0 — local has commits to push. Don't pull,
  // don't fail. The next phase's push will catch them up.
  return { ok: true, action: 'ahead-only', behind: 0, ahead: ab.ahead };
}

/**
 * Probe a remote URL for refs. Used to decide whether to clone (has refs)
 * or init + push (empty repo / repo doesn't exist remotely yet).
 *
 * Returns { ok, hasRefs, error? }
 *   ok=true, hasRefs=true   → the remote exists and has commits — clone it
 *   ok=true, hasRefs=false  → the remote exists but is empty — init + push
 *   ok=false                → couldn't reach the remote (auth, network, bad URL)
 */
export function remoteHasRefs(url, { timeout = 30_000 } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timed = false;

    const proc = spawn('git', ['ls-remote', '--heads', url], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      detached: true,
    });

    const t = setTimeout(() => {
      timed = true;
      try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* setsid race — retry coming */ }
      setTimeout(() => {
        try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* already dead */ }
      }, 100).unref?.();
      setTimeout(() => {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* already dead */ }
      }, 5000).unref?.();
    }, timeout);
    t.unref?.();

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => {
      clearTimeout(t);
      resolve({ ok: false, hasRefs: false, error: err.message });
    });
    proc.on('exit', (code) => {
      clearTimeout(t);
      if (timed) return resolve({ ok: false, hasRefs: false, error: 'ls-remote timed out' });
      if (code !== 0) return resolve({ ok: false, hasRefs: false, error: stderr.trim() || `ls-remote exited ${code}` });
      resolve({ ok: true, hasRefs: stdout.trim().length > 0 });
    });
  });
}

/**
 * Clone a git URL into <parentDir>/<targetName>. Returns { ok, branch, error }.
 * `targetName` must not exist yet (or must be empty). 5-minute default timeout
 * (large repos / slow networks). branch=null clones the remote's default.
 */
export async function cloneRepo({ parentDir, targetName, url, branch = null, timeout = 300_000 }) {
  const args = ['clone'];
  if (branch) args.push('--branch', branch);
  args.push(url, targetName);

  const { ok, code, stdout, stderr, error } = await new Promise((resolve) => {
    let out = '';
    let err = '';
    let timed = false;

    const proc = spawn('git', args, {
      cwd: parentDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      detached: true,
    });

    const t = setTimeout(() => {
      timed = true;
      try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* setsid race — retry coming */ }
      setTimeout(() => {
        try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* already dead */ }
      }, 100).unref?.();
      setTimeout(() => {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* already dead */ }
      }, 5000).unref?.();
    }, timeout);
    t.unref?.();

    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (spawnErr) => {
      clearTimeout(t);
      resolve({ ok: false, error: spawnErr.message });
    });
    proc.on('exit', (exitCode) => {
      clearTimeout(t);
      if (timed) return resolve({ ok: false, error: 'clone timed out (>5 min). Re-run on a faster network, or clone manually then npm run migrate-git.' });
      if (exitCode !== 0) return resolve({ ok: false, error: err.trim() || `clone exited ${exitCode}` });
      resolve({ ok: true, code: exitCode, stdout: out.trim(), stderr: err.trim() });
    });
  });

  if (!ok) return { ok: false, error };

  // Discover what branch we landed on — done outside the Promise so async
  // errors propagate normally instead of being swallowed by the executor.
  const cloned = await getCurrentBranch(`${parentDir}/${targetName}`);
  return { ok: true, branch: cloned, stdout, stderr };
}

/**
 * Add a detached worktree at `dir`, pinned to `sha` (phase-50 — the
 * read-only-concurrency primitive consumed by verify/review/scout). Worktrees
 * share the object DB with workspaceDir, so git diff/log/show run inside
 * `dir` see every commit — but `dir`'s working tree is fixed at `sha` and
 * never observes uncommitted/later changes on the main tree.
 * Returns { ok: true, dir } or { ok: false, error }.
 */
export async function addDetachedWorktree(workspaceDir, { sha, dir }) {
  try {
    await fs.mkdir(path.dirname(dir), { recursive: true });
  } catch (err) {
    return { ok: false, error: `mkdir ${path.dirname(dir)} failed: ${err.message}` };
  }
  const r = await runGit(workspaceDir, ['worktree', 'add', '--detach', dir, sha]);
  if (!r.ok) return { ok: false, error: r.stderr || `git worktree add exited ${r.code}` };
  return { ok: true, dir };
}

/**
 * Remove a worktree directory and prune its metadata. Best-effort — NEVER
 * throws, even against a missing / already-removed / never-created dir, so
 * callers (the auto-runner's stale-worktree sweep, and every verify/review/
 * scout cleanup path) can call it unconditionally in a finally block.
 */
export async function removeWorktree(workspaceDir, dir) {
  try {
    await runGit(workspaceDir, ['worktree', 'remove', '--force', dir]);
    await runGit(workspaceDir, ['worktree', 'prune']);
  } catch {
    // best-effort — never throw
  }
}

// ── Lane worktree lifecycle (phase-67 — src/lib/lane-manager.js) ────────────
//
// A LANE (unlike phase-50's detached read-only worktree) is checked out on a
// private BRANCH `lane/<name>` off a base sha, so the dev agent can commit into
// it. These are the git primitives lane-manager.js composes; each routes through
// runGit — never a raw spawn — so the repo-wide "no raw git spawn outside
// git.js" invariant holds (src/lib/no-raw-git-spawn.test.mjs).

/**
 * Add a worktree at `path` on a NEW branch `branch` (created off `startSha`, or
 * off the current HEAD when startSha is omitted). Parent dir is created first.
 * Returns { ok: true, path, branch } or { ok: false, error }.
 */
export async function worktreeAdd(workspaceDir, { path: worktreePath, branch, startSha } = {}) {
  if (!worktreePath) return { ok: false, error: 'worktreeAdd: path is required' };
  try {
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  } catch (err) {
    return { ok: false, error: `mkdir ${path.dirname(worktreePath)} failed: ${err.message}` };
  }
  const args = ['worktree', 'add'];
  if (branch) args.push('-b', branch);
  args.push(worktreePath);
  if (startSha) args.push(startSha);
  const r = await runGit(workspaceDir, args);
  if (!r.ok) return { ok: false, error: r.stderr || `git worktree add exited ${r.code}` };
  return { ok: true, path: worktreePath, branch: branch || null };
}

/**
 * Force-remove a worktree registration + working directory. Returns
 * { ok, error? }. Does NOT throw (git remove of a missing/never-registered dir
 * returns ok:false with the git error); crash-safe teardown pairs this with a
 * fs.rm fallback (destroyLane / sweepOrphanLanes in lane-manager.js).
 */
export async function worktreeRemove(workspaceDir, worktreePath) {
  const r = await runGit(workspaceDir, ['worktree', 'remove', '--force', worktreePath]);
  if (!r.ok) return { ok: false, error: r.stderr || `git worktree remove exited ${r.code}` };
  return { ok: true };
}

/** Prune stale worktree admin entries (dirs deleted out from under git). */
export async function worktreePrune(workspaceDir) {
  const r = await runGit(workspaceDir, ['worktree', 'prune']);
  if (!r.ok) return { ok: false, error: r.stderr || `git worktree prune exited ${r.code}` };
  return { ok: true };
}

/**
 * Delete a local branch (force `-D` by default — a lane branch's commits live on
 * in the merged HEAD after mergeNoFf, so a force delete of the now-merged lane
 * branch loses nothing). Returns { ok, error? }; never throws.
 */
export async function deleteBranch(workspaceDir, branch, { force = true } = {}) {
  if (!branch) return { ok: false, error: 'deleteBranch: branch is required' };
  const r = await runGit(workspaceDir, ['branch', force ? '-D' : '-d', branch]);
  if (!r.ok) return { ok: false, error: r.stderr || `git branch delete exited ${r.code}` };
  return { ok: true };
}

/**
 * Merge `branch` into the current branch with `--no-ff` (always a merge commit —
 * preserves lane identity in history, which is why the fix-commit reconciliation
 * `--grep` scans survive lane merges). Returns { ok: true, output } or
 * { ok: false, error } (a conflict leaves ok:false; the caller aborts + falls
 * back to serial — P3).
 */
export async function mergeNoFf(workspaceDir, { branch, message } = {}) {
  if (!branch) return { ok: false, error: 'mergeNoFf: branch is required' };
  const args = ['merge', '--no-ff', branch];
  if (message) args.push('-m', message);
  const r = await runGit(workspaceDir, args);
  if (!r.ok) return { ok: false, error: r.stderr || `git merge --no-ff exited ${r.code}` };
  return { ok: true, output: r.stdout };
}

/**
 * Abort an in-progress merge, restoring the working tree + index to pre-merge
 * state (Phase 68 — the parallel-wave scheduler calls this the instant a lane
 * merge conflicts, before it discards the lane and falls back to serial).
 * Returns { ok, error? }; never throws (a no-merge-in-progress call returns
 * ok:false, which the caller swallows — the tree is already clean).
 */
export async function mergeAbort(workspaceDir) {
  const r = await runGit(workspaceDir, ['merge', '--abort']);
  if (!r.ok) return { ok: false, error: r.stderr || `git merge --abort exited ${r.code}` };
  return { ok: true };
}

/**
 * Hard-reset the current branch to `sha` (Phase 68 — used to roll a wave's
 * merged HEAD back to its pre-wave base when the mandatory merged-HEAD
 * validator gate fails, so a red HEAD is never pushed and every wave phase can
 * re-run serially from the same base). Returns { ok, error? }; never throws.
 */
export async function resetHard(workspaceDir, sha) {
  if (!sha) return { ok: false, error: 'resetHard: sha is required' };
  const r = await runGit(workspaceDir, ['reset', '--hard', sha]);
  if (!r.ok) return { ok: false, error: r.stderr || `git reset --hard exited ${r.code}` };
  return { ok: true };
}

// ── Operations ────────────────────────────────────────────────────────────

/**
 * Pre-flight before dispatching a phase or fix.
 * Returns { ok, error } — error is human-readable, suitable for surfacing
 * to a Telegram message or CLI.
 */
export async function preflightForDev(workspaceDir, { expectedBranch, requireRemote = true } = {}) {
  if (!(await isGitRepo(workspaceDir))) {
    return { ok: false, error: `Workspace is not a git repo: ${workspaceDir}. Run: npm run migrate-git -- --project <name>` };
  }
  if (requireRemote && !(await hasRemote(workspaceDir))) {
    return { ok: false, error: `Workspace has no 'origin' remote. Run: npm run migrate-git -- --project <name> --remote <url>` };
  }
  const current = await getCurrentBranch(workspaceDir);
  if (expectedBranch && current !== expectedBranch) {
    return { ok: false, error: `Workspace is on '${current}', expected '${expectedBranch}'. Run: cd ${workspaceDir} && git checkout ${expectedBranch}` };
  }
  return { ok: true };
}

/**
 * Stage every change (tracked + untracked) and commit it with `message`.
 * Phase 81 (brief 05 P4a — test-first harness): the primitive the opt-in
 * test-first harness uses to land an AUTHORED test as its OWN commit BEFORE the
 * dev spawn, so the failing test rides into history and the dev's later commit
 * is measured against the post-test HEAD (see phase-runner's preSha re-read
 * seam). Routed through runGit so the repo-wide "no raw git spawn outside
 * git.js" invariant holds (src/lib/no-raw-git-spawn.test.mjs).
 *
 * No-op on a clean tree: `git add -A` stages nothing, so an empty index
 * (`git diff --cached --quiet` exits 0) short-circuits to
 * { ok: true, committed: false } WITHOUT creating an empty commit. Otherwise it
 * commits and returns { ok: true, committed: true, sha }. Never throws — a git
 * failure surfaces as { ok: false, error }.
 */
export async function commitAll(workspaceDir, message) {
  if (!message || !String(message).trim()) {
    return { ok: false, error: 'commitAll: a non-empty commit message is required' };
  }
  const add = await runGit(workspaceDir, ['add', '-A']);
  if (!add.ok) return { ok: false, error: add.stderr || `git add -A exited ${add.code}` };

  // Nothing staged → clean tree → no-op (never manufacture an empty commit).
  // `git diff --cached --quiet` exits 0 (ok) when the index is empty, 1 when it
  // carries staged changes.
  const staged = await runGit(workspaceDir, ['diff', '--cached', '--quiet']);
  if (staged.ok) return { ok: true, committed: false };

  const commit = await runGit(workspaceDir, ['commit', '-m', message]);
  if (!commit.ok) return { ok: false, error: commit.stderr || `git commit exited ${commit.code}` };
  const sha = await getHeadSha(workspaceDir);
  return { ok: true, committed: true, sha };
}

/**
 * Push current branch to remote. Never force-pushes. Returns { ok, error }.
 * Push failures are warnings, not errors — caller decides notification.
 */
export async function pushBranch(workspaceDir, { remote = 'origin', branch = null } = {}) {
  const targetBranch = branch || (await getCurrentBranch(workspaceDir));
  if (!targetBranch) return { ok: false, error: 'Could not determine current branch' };
  // Use --set-upstream so first push from a new branch wires up tracking
  const r = await runGit(workspaceDir, ['push', '--set-upstream', remote, targetBranch], { timeout: 120_000 });
  if (!r.ok) {
    return {
      ok: false,
      branch: targetBranch,
      error: r.stderr || `push exited ${r.code}`,
    };
  }
  return { ok: true, branch: targetBranch, output: r.stdout };
}

/**
 * Fast-forward `target` to `source`. Used by /ship to advance main to develop.
 * Returns { ok, error, fromSha, toSha }.
 *
 * Behavior:
 *   - Checkout target
 *   - Pull --ff-only origin target (sync with remote first)
 *   - Merge --ff-only source
 *   - Push target
 *   - Checkout source again (leave workspace where we found it)
 */
export async function fastForwardMerge(workspaceDir, { source, target, remote = 'origin' }) {
  const initialBranch = await getCurrentBranch(workspaceDir);
  const status = await workspaceStatus(workspaceDir);
  if (!status.clean) {
    return { ok: false, error: `Workspace is dirty (${status.dirty.length} change(s)). Commit or stash first.` };
  }

  const sourceSha = await getHeadSha(workspaceDir);

  // Make sure target branch exists locally; fetch from remote if needed
  if (!(await branchExists(workspaceDir, target))) {
    const fetch = await runGit(workspaceDir, ['fetch', remote, target]);
    if (!fetch.ok) return { ok: false, error: `Could not fetch ${remote}/${target}: ${fetch.stderr}` };
    const create = await runGit(workspaceDir, ['branch', target, `${remote}/${target}`]);
    if (!create.ok) return { ok: false, error: `Could not create local ${target}: ${create.stderr}` };
  }

  // Capture target's current sha for the from/to report
  const targetRef = await runGit(workspaceDir, ['rev-parse', target]);
  const targetSha = targetRef.ok ? targetRef.stdout : null;

  // Quick check: is target already at source? Then nothing to do.
  if (targetSha === sourceSha) {
    return { ok: true, noop: true, fromSha: targetSha, toSha: sourceSha };
  }

  // Verify source is ahead of target (i.e., FF is possible)
  const ffCheck = await runGit(workspaceDir, ['merge-base', '--is-ancestor', target, source]);
  if (!ffCheck.ok) {
    return {
      ok: false,
      error: `${target} is not an ancestor of ${source} — cannot fast-forward. ${target} has commits that aren't in ${source}.`,
    };
  }

  // Now: checkout target, pull --ff-only, merge --ff-only source, push, return to source
  const checkoutTarget = await runGit(workspaceDir, ['checkout', target]);
  if (!checkoutTarget.ok) return { ok: false, error: `Could not checkout ${target}: ${checkoutTarget.stderr}` };

  // Best-effort sync with remote target first
  const pull = await runGit(workspaceDir, ['pull', '--ff-only', remote, target], { timeout: 120_000 });
  if (!pull.ok) {
    // Restore branch and return error
    await runGit(workspaceDir, ['checkout', initialBranch || source]);
    return { ok: false, error: `git pull --ff-only ${remote} ${target} failed: ${pull.stderr}` };
  }

  const merge = await runGit(workspaceDir, ['merge', '--ff-only', source]);
  if (!merge.ok) {
    await runGit(workspaceDir, ['checkout', initialBranch || source]);
    return { ok: false, error: `merge --ff-only failed: ${merge.stderr}` };
  }

  const push = await runGit(workspaceDir, ['push', remote, target], { timeout: 120_000 });
  if (!push.ok) {
    // Local main is now ahead of remote main — surface this loudly
    await runGit(workspaceDir, ['checkout', initialBranch || source]);
    return {
      ok: false,
      partial: true,
      error: `Local ${target} fast-forwarded but push failed: ${push.stderr}. Run: cd ${workspaceDir} && git push ${remote} ${target}`,
    };
  }

  // Return to source branch
  await runGit(workspaceDir, ['checkout', source]);

  const finalSha = await getHeadSha(workspaceDir);
  return { ok: true, fromSha: targetSha, toSha: sourceSha || finalSha };
}

/**
 * Create an annotated tag at HEAD and push it.
 * Returns { ok, error }.
 */
export async function tagAndPush(workspaceDir, { tag, message, remote = 'origin' }) {
  const create = await runGit(workspaceDir, ['tag', '-a', tag, '-m', message || tag]);
  if (!create.ok) return { ok: false, error: `tag failed: ${create.stderr}` };
  const push = await runGit(workspaceDir, ['push', remote, tag], { timeout: 60_000 });
  if (!push.ok) return { ok: false, error: `tag push failed: ${push.stderr}` };
  return { ok: true };
}
