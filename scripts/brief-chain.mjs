#!/usr/bin/env node
/**
 * brief-chain — run multiple briefs for a project in sequence, unattended.
 *
 * Usage:
 *   node scripts/brief-chain.mjs <project> [brief1.md brief2.md ...]
 *
 * Queue-dir convention (no file args needed):
 *   Drop briefs as  projects/<project>/inputs/queue/01.md  02.md  03.md …
 *   Then run:  node scripts/brief-chain.mjs <project>
 *   Files are processed in alphabetical order.
 *
 * Retry behaviour (src/lib/unattended-retry.js):
 *   The orchestrator's auto-healer handles most errors internally (network,
 *   git, phase-stuck, orchestrator bugs). This script adds one extra layer:
 *   if the run exits with a Claude API error (rate-limit, overload, 529, etc.)
 *   it waits for the rate-limit window to reset then resumes automatically.
 *   Budget-window pauses are NOT assumed — we only retry on actual API errors.
 *
 * Exit codes:
 *   0 — all briefs completed (status = ready-for-qa / completed)
 *   1 — unrecoverable failure; remaining briefs skipped
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { createWriteStream, readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  isTransientError, getLastRun, getProjectStatus, markProjectWaitingForResume,
  runOrchestratorWithRetry,
} from '../src/lib/unattended-retry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ORC       = path.join(REPO_ROOT, 'src', 'orchestrator.js');
const PROJ_ROOT = path.join(REPO_ROOT, 'projects');
const DB_PATH   = process.env.DB_PATH || path.join(REPO_ROOT, 'state', 'orchestrator.db');

// Minutes to wait before retrying after a Claude API error.
const RETRY_WAIT_MINUTES = Number(process.env.RETRY_WAIT_MINUTES ?? 30);

// ── logging (stdout + persistent log file) ───────────────────────────────────

let _logStream = null;

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means a live process owned by another user. Treat it as locked.
    return err?.code === 'EPERM';
  }
}

/** Acquire a single-writer lock, reclaiming only a verifiably stale PID. */
export async function acquirePidLock(pidPath, pid = process.pid) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(pidPath, 'wx');
      try {
        await handle.writeFile(String(pid), 'utf-8');
      } finally {
        await handle.close();
      }
      return;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;

      const raw = await fs.readFile(pidPath, 'utf-8').catch(() => '');
      const existingPid = Number.parseInt(raw.trim(), 10);
      if (isPidAlive(existingPid)) {
        throw new Error(`brief-chain is already running for this project (pid ${existingPid})`);
      }
      await fs.unlink(pidPath).catch((unlinkErr) => {
        if (unlinkErr?.code !== 'ENOENT') throw unlinkErr;
      });
    }
  }
  throw new Error(`could not acquire brief-chain lock: ${pidPath}`);
}

/** Release a lock only when this process still owns it. */
export function releasePidLock(pidPath, pid = process.pid) {
  try {
    if (readFileSync(pidPath, 'utf-8').trim() === String(pid)) unlinkSync(pidPath);
  } catch { /* lock is already gone or inaccessible */ }
}

function _write(stream, msg) {
  try { stream.write(msg); } catch { /* ignore write errors on closed streams */ }
}

function log(msg) {
  const line = `[brief-chain] ${msg}\n`;
  process.stdout.write(line);
  if (_logStream) _write(_logStream, line);
}
function err(msg) {
  const line = `[brief-chain] ERROR: ${msg}\n`;
  process.stderr.write(line);
  if (_logStream) _write(_logStream, line);
}

/**
 * Stage one brief into inputs/brief.md and run it to completion.
 *
 * If the same brief is already staged AND the project has a paused run, we
 * resume instead of reset-brief — so restarting brief-chain mid-brief keeps
 * all the phase progress already committed rather than starting from zero.
 */
async function runBriefWithRetry(project, briefFile, briefLabel) {
  const inputsBriefPath = path.join(PROJ_ROOT, project, 'inputs', 'brief.md');
  const targetContent   = await fs.readFile(briefFile, 'utf-8');

  let initialArgs;
  try {
    const stagedContent = await fs.readFile(inputsBriefPath, 'utf-8');
    const lastRun = getLastRun(project, DB_PATH);
    const status  = getProjectStatus(project, DB_PATH);
    const sameContent = stagedContent.trim() === targetContent.trim();
    const hasPausedRun = lastRun?.status === 'paused'
      && status !== 'ready-for-qa' && status !== 'completed';
    if (sameContent && hasPausedRun) {
      log(`Brief already staged and run is paused — resuming (skipping reset-brief)`);
      initialArgs = ['resume', project, '--unattended'];
    }
  } catch { /* can't read staged brief — fall back to reset */ }

  if (!initialArgs) {
    await fs.mkdir(path.join(PROJ_ROOT, project, 'inputs'), { recursive: true });
    await fs.writeFile(inputsBriefPath, targetContent, 'utf-8');
    log(`Staged ${briefLabel} → inputs/brief.md`);
    initialArgs = ['reset-brief', project, '--go'];
  }

  return runOrchestratorWithRetry(
    ORC, DB_PATH, project,
    initialArgs,
    ['resume', project, '--unattended'],
    { log, err, retryWaitMinutes: RETRY_WAIT_MINUTES },
  );
}

/** Poll until the project is no longer in-progress. */
async function waitForIdle(project, pollMs = 20_000) {
  log(`Waiting for current run of "${project}" to finish…`);
  for (;;) {
    const status = getProjectStatus(project, DB_PATH);
    if (status !== 'in-progress') {
      log(`Run finished — status: ${status ?? 'unknown'}`);
      return status;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const [project, ...rawArgs] = process.argv.slice(2);

  if (!project) {
    err('Usage: node scripts/brief-chain.mjs <project> [brief1.md brief2.md ...]');
    process.exit(1);
  }

  // ── persistent log file (survives nohup / detached runs) ──
  const logsDir  = path.join(REPO_ROOT, 'logs');
  const logPath  = path.join(logsDir, `brief-chain-${project}.log`);
  const pidPath  = path.join(logsDir, `brief-chain-${project}.pid`);
  await fs.mkdir(logsDir, { recursive: true });
  try {
    await acquirePidLock(pidPath);
  } catch (lockErr) {
    err(lockErr.message);
    process.exit(1);
  }
  _logStream = createWriteStream(logPath, { flags: 'a' });
  process.on('exit', () => releasePidLock(pidPath));
  log(`Started  pid=${process.pid}  log=${logPath}`);

  // Resolve brief files — from args or queue dir
  let briefs = [];
  let queueDir = null;
  if (rawArgs.length > 0) {
    briefs = rawArgs.map(f => path.resolve(f));
  } else {
    queueDir = path.join(PROJ_ROOT, project, 'inputs', 'queue');
    let entries;
    try { entries = await fs.readdir(queueDir); }
    catch {
      err(`No brief files passed and no queue dir at: ${queueDir}`);
      process.exit(1);
    }
    briefs = entries.filter(f => f.endsWith('.md')).sort().map(f => path.join(queueDir, f));
    if (briefs.length === 0) { err('Queue dir has no .md files'); process.exit(1); }
  }

  for (const b of briefs) {
    try { await fs.access(b); }
    catch { err(`Brief file not found: ${b}`); process.exit(1); }
  }

  log(`Project      : ${project}`);
  log(`Queue        : ${briefs.length} brief(s)`);
  log(`API retry    : wait for rate-limit window reset, poll every 5min`);
  briefs.forEach((b, i) => log(`  ${i + 1}. ${path.basename(b)}`));

  // Wait for any currently-running pipeline to finish first.
  // If stuck in-progress after a recoverable pause, record an honest waiting
  // state instead of fabricating ready-for-qa or polling forever.
  if (getProjectStatus(project, DB_PATH) === 'in-progress') {
    const run = getLastRun(project, DB_PATH);
    const pauseKind   = run?.pause_kind   ?? '';
    const pauseReason = run?.pause_reason ?? '';
    if (isTransientError(pauseReason) || pauseKind === 'budget') {
      log('Project has a prior recoverable pause — marking it waiting for automatic resume…');
      markProjectWaitingForResume(project, DB_PATH, log);
    } else {
      await waitForIdle(project);
    }
  }

  // Process each brief in sequence
  for (let i = 0; i < briefs.length; i++) {
    const briefFile  = briefs[i];
    const briefLabel = path.basename(briefFile);

    log(`\n${'─'.repeat(56)}`);
    log(`Brief ${i + 1}/${briefs.length}: ${briefLabel}`);
    log(`${'─'.repeat(56)}`);

    const ok = await runBriefWithRetry(project, briefFile, briefLabel);
    if (!ok) {
      err(`Brief ${i + 1}/${briefs.length} failed — stopping queue.`);
      process.exit(1);
    }

    log(`Brief ${i + 1}/${briefs.length} complete ✓`);

    // Archive the completed brief so a restart skips it (idempotent: ignore if
    // the file was already moved by a prior run or renamed externally).
    if (queueDir) {
      const archiveDir = path.join(path.dirname(queueDir), 'queue-archive');
      await fs.mkdir(archiveDir, { recursive: true });
      const dest = path.join(archiveDir, path.basename(briefFile));
      await fs.rename(briefFile, dest).catch(() => {});
      log(`Archived ${path.basename(briefFile)} → queue-archive/`);
    }
  }

  log(`\nAll ${briefs.length} brief(s) completed for "${project}" ✓`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { err(e.message); process.exit(1); });
}
