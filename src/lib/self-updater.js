// Self-updater — smart pull for the orchestrator repo itself.
// Used by toolOrchestratorPull (chat MCP tool) and the `self pull` CLI command.
//
// pull()        → runs git pull --ff-only, captures the diff, returns a PullResult
// analyzeDiff() → categorises changed files into restart/install buckets
// applyPull()   → runs npm install if package.json changed; returns what still needs manual restart

import path from 'node:path';
import fs from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

export const PID_FILE  = path.join(REPO_ROOT, 'state', 'web-server.pid');
export const SHA_FILE  = path.join(REPO_ROOT, 'state', 'web-server-sha.txt');

// ─── Deployment state ────────────────────────────────────────────────────────

/** Write current PID + HEAD sha. Called by startWebUi() on startup. */
export async function writeDeploymentState() {
  await fs.mkdir(path.dirname(PID_FILE), { recursive: true });
  const sha = await headSha();
  await Promise.all([
    fs.writeFile(PID_FILE, String(process.pid), 'utf-8'),
    fs.writeFile(SHA_FILE, sha || '', 'utf-8'),
  ]);
}

/** Read the deployed PID (null if file absent or stale). */
export async function readDeployedPid() {
  try {
    const raw = (await fs.readFile(PID_FILE, 'utf-8')).trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

/** Read the sha the running web server was started on (null if absent). */
export async function readDeployedSha() {
  try {
    const sha = (await fs.readFile(SHA_FILE, 'utf-8')).trim();
    return sha || null;
  } catch { return null; }
}

/** Check if a PID is currently alive (POSIX signal 0). */
export function pidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ─── Git helpers ─────────────────────────────────────────────────────────────

async function git(...args) {
  try {
    const { stdout, stderr } = await execAsync(
      `git ${args.map((a) => JSON.stringify(a)).join(' ')}`,
      { cwd: REPO_ROOT, timeout: 30_000 }
    );
    return { ok: true, out: stdout.trim(), err: stderr.trim() };
  } catch (e) {
    return { ok: false, out: '', err: String(e.message || e) };
  }
}

async function headSha() {
  const r = await git('rev-parse', 'HEAD');
  return r.ok ? r.out.slice(0, 40) : null;
}

async function isClean() {
  const r = await git('status', '--porcelain');
  return r.ok && r.out.trim() === '';
}

async function lastCommitInfo() {
  const r = await git('log', '-1', '--pretty=format:%h|%s|%an|%ar');
  if (!r.ok || !r.out) return null;
  const [sha, subject, author, ago] = r.out.split('|');
  return { sha, subject, author, ago };
}

async function diffNames(fromSha, toSha) {
  const r = await git('diff', '--name-only', `${fromSha}..${toSha}`);
  if (!r.ok || !r.out) return [];
  return r.out.split('\n').map((f) => f.trim()).filter(Boolean);
}

async function currentBranch() {
  const r = await git('branch', '--show-current');
  return r.ok ? r.out : null;
}

// ─── Diff analysis ───────────────────────────────────────────────────────────

/**
 * Given a list of changed file paths, return what actions are needed.
 * @returns {{ needsNpmInstall, needsWebRestart, needsMcpRestart, changedCategories }}
 */
export function analyzeDiff(files) {
  const cats = new Set();
  let needsNpmInstall = false;
  let needsWebRestart = false;
  let needsMcpRestart = false;

  for (const f of files) {
    if (f === 'package.json' || f === 'package-lock.json') {
      needsNpmInstall = true; cats.add('deps');
    }
    if (f.startsWith('src/public/'))    { needsWebRestart = true; cats.add('ui-assets'); }
    if (f.startsWith('src/web-ui'))     { needsWebRestart = true; cats.add('web-server'); }
    if (f.startsWith('src/server/'))    { needsWebRestart = true; cats.add('server-handlers'); }
    if (f.startsWith('src/commands/'))  { needsWebRestart = true; cats.add('commands'); }
    if (f.startsWith('src/chat/'))      { needsWebRestart = true; cats.add('chat'); }
    if (f.startsWith('src/mcp/'))       { needsMcpRestart = true; cats.add('mcp'); }
    if (f === 'src/state.js')           { needsWebRestart = true; cats.add('state+migrations'); }
    if (f.startsWith('src/lib/'))       { needsWebRestart = true; cats.add('lib'); }
    if (f.startsWith('src/'))           { needsWebRestart = true; cats.add('src'); }
    if (f.startsWith('config/'))        { needsWebRestart = true; cats.add('config'); }
    if (f.startsWith('prompts/'))       { cats.add('prompts'); } // no restart needed
  }

  return { needsNpmInstall, needsWebRestart, needsMcpRestart, changedCategories: [...cats] };
}

// ─── Pull + apply ─────────────────────────────────────────────────────────────

/**
 * Pull the orchestrator repo and return a structured PullResult.
 * Does NOT restart any processes — that is the caller's job.
 */
export async function pull() {
  const clean = await isClean();
  if (!clean) {
    throw new Error('Working tree has uncommitted changes — commit or stash first. Nothing was pulled.');
  }

  const beforeSha = await headSha();
  const branch = await currentBranch();

  const r = await git('pull', '--ff-only');
  if (!r.ok) {
    throw new Error(`git pull --ff-only failed: ${(r.err || r.out || 'unknown').slice(0, 300)}`);
  }

  const afterSha = await headSha();
  const updated = beforeSha !== afterSha;

  let diff = { needsNpmInstall: false, needsWebRestart: false, needsMcpRestart: false, changedCategories: [] };
  let changedFiles = [];
  if (updated && beforeSha && afterSha) {
    changedFiles = await diffNames(beforeSha, afterSha);
    diff = analyzeDiff(changedFiles);
  }

  const commit = await lastCommitInfo();

  return {
    updated, branch,
    from: beforeSha?.slice(0, 8) || null,
    to:   afterSha?.slice(0, 8)  || null,
    changedFiles,
    diff,
    commit,
  };
}

/**
 * After a successful pull, run npm install if needed (sync, in-process).
 * Returns { installedDeps: bool, error?: string }.
 */
export async function applyPull(pullResult) {
  if (!pullResult.updated || !pullResult.diff.needsNpmInstall) {
    return { installedDeps: false };
  }
  try {
    await execAsync('npm install --prefer-offline --no-audit --no-fund', {
      cwd: REPO_ROOT, timeout: 120_000,
    });
    return { installedDeps: true };
  } catch (e) {
    return { installedDeps: false, error: String(e.message || e).slice(0, 500) };
  }
}

// ─── Web server restart ───────────────────────────────────────────────────────

/**
 * Restart the web server gracefully:
 *   1. Spawn a new server process (detached).
 *   2. Kill the old PID after a short delay (shell-scripted, fire-and-forget).
 *
 * Uses a small shell one-liner spawned detached so the MCP server process
 * (which runs inside the chat turn, not inside the web server) can return a
 * response before the old server process is killed.
 *
 * @param {object} opts
 * @param {number} [opts.port] port the web server should bind to (default 4242)
 * @param {number} [opts.delaySec] seconds to wait before killing old pid (default 3)
 * @returns {{ queued: boolean, newPid?: number, killedPid?: number }}
 */
export async function restartWebServer({ port = 4242, delaySec = 3 } = {}) {
  const oldPid = await readDeployedPid();
  const node   = process.execPath;
  const entry  = path.join(REPO_ROOT, 'src', 'orchestrator.js');

  // Shell one-liner: sleep, kill old, start new in background
  const killOld = oldPid && pidAlive(oldPid)
    ? `sleep ${delaySec} && kill -15 ${oldPid} 2>/dev/null; `
    : '';
  const startNew = `${JSON.stringify(node)} ${JSON.stringify(entry)} web --port ${port} >> ${JSON.stringify(path.join(REPO_ROOT, 'logs', 'web-server.log'))} 2>&1 &`;
  const script = killOld + startNew;

  // Spawn detached via /bin/sh
  const child = spawn('/bin/sh', ['-c', script], {
    detached: true, stdio: 'ignore', cwd: REPO_ROOT,
  });
  child.unref();

  return { queued: true, killedPid: oldPid || null };
}

// ─── Health check ─────────────────────────────────────────────────────────────

/**
 * Return a structured snapshot of the orchestrator's own health.
 * Used by toolSelfStatus and buildSelfContextSnapshot.
 */
export async function selfHealth() {
  const branch   = await currentBranch();
  const headShaV = await headSha();
  const commit   = await lastCommitInfo();
  const clean    = await isClean();

  const deployedPid = await readDeployedPid();
  const deployedSha = await readDeployedSha();
  const webAlive    = pidAlive(deployedPid);
  const webStale    = webAlive && deployedSha && deployedSha !== headShaV;

  return {
    git: {
      branch, sha: headShaV?.slice(0, 8) || null,
      clean, commit,
    },
    webServer: {
      pid: deployedPid, alive: webAlive,
      deployedSha: deployedSha?.slice(0, 8) || null,
      stale: webStale,
    },
  };
}
