// Durable, restart-safe brief queue driver used by queue workers.
//
// Unlike scripts/brief-chain.mjs this runs in-process, so the queue worker can
// keep renewing its SQLite lease. Progress is checkpointed in the project's
// metadata_json before every filesystem/state transition. A crash at any line
// therefore re-enters as one of: repeat staging/reset, resume the current
// brief, or archive an already-completed brief—never skip unknown work.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoRun } from '../auto-runner.js';
import { resetBrief } from '../commands/reset-brief.js';
import {
  getProject,
  getLastAutoRun,
  parseProjectMetadata,
  setProjectMetadataField,
} from '../state.js';
import { PAUSE_KINDS } from './pause-classifier.js';
import { isTransientError } from './transient-errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_PROJECTS_DIR = path.join(REPO_ROOT, 'projects');
const COMPLETE_PAUSES = new Set([PAUSE_KINDS.ALL_PHASES_COMPLETE, PAUSE_KINDS.FIX_ROUND_COMPLETE]);

export function briefChainState(projectRow) {
  const value = parseProjectMetadata(projectRow?.metadata_json)?.brief_chain;
  return value && typeof value === 'object'
    ? value
    : { active: false, state: 'idle', file: null };
}

export function briefRunCompleted(result, projectRow, lastRun = null) {
  if (result?.status === 'completed' || COMPLETE_PAUSES.has(result?.pauseKind)) return true;
  // The persisted run outcome is authoritative over project.status. resetBrief
  // clears current_phase but NOT status, so a freshly-staged brief inherits the
  // previous brief's terminal status — trusting it would archive unrun work.
  // Mirror classifyLastRun: consult the last run's verdict before the status.
  if (lastRun) return lastRun.status === 'completed' || COMPLETE_PAUSES.has(lastRun.pause_kind);
  return ['ready-for-qa', 'completed'].includes(projectRow?.status);
}

/**
 * Restart-safe completion probe. A terminal outcome only counts as completion
 * of the CURRENT brief when the run that produced it actually started at or
 * after this brief was dispatched — otherwise it is the previous brief's run
 * and its stale 'ready-for-qa' status must never archive the queued brief.
 */
export function completedSinceDispatch(lastRun, dispatchedAt) {
  if (!lastRun || !dispatchedAt || !lastRun.started_at) return false;
  if (String(lastRun.started_at) < String(dispatchedAt)) return false;
  return lastRun.status === 'completed' || COMPLETE_PAUSES.has(lastRun.pause_kind);
}

export function briefRunRecoverable(result) {
  return result?.status === 'paused'
    && (result?.pauseKind === PAUSE_KINDS.BUDGET
      || result?.pauseKind === PAUSE_KINDS.WINDOW_HEADROOM
      || isTransientError(result?.reason));
}

async function filesInQueue(queueDir) {
  const names = await fs.readdir(queueDir).catch((err) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  return names.filter((name) => name.endsWith('.md')).sort();
}

async function archiveBrief(queueDir, file) {
  const source = path.join(queueDir, file);
  const archiveDir = path.join(path.dirname(queueDir), 'queue-archive');
  await fs.mkdir(archiveDir, { recursive: true });
  let destination = path.join(archiveDir, file);
  try {
    await fs.access(destination);
    const ext = path.extname(file);
    const stem = path.basename(file, ext);
    destination = path.join(archiveDir, `${stem}-${Date.now()}${ext}`);
  } catch { /* original destination is free */ }
  await fs.rename(source, destination).catch((err) => {
    if (err.code !== 'ENOENT') throw err;
  });
  return destination;
}

/**
 * Process queued briefs until complete or a pause requires a durable resume.
 * On a recoverable provider/window pause the chain stays active and returns
 * the autoRun result; job-runner's ordinary resume job later re-enqueues this
 * action after the current brief has completed.
 */
export async function runDurableBriefChain({ project, notifier = null }, deps = {}) {
  const projectsDir = deps.projectsDir ?? DEFAULT_PROJECTS_DIR;
  const getProjectFn = deps.getProject ?? getProject;
  const getLastAutoRunFn = deps.getLastAutoRun ?? getLastAutoRun;
  const setMetadataFn = deps.setProjectMetadataField ?? setProjectMetadataField;
  const resetBriefFn = deps.resetBrief ?? resetBrief;
  const autoRunFn = deps.autoRun ?? autoRun;
  const projDir = path.join(projectsDir, project);
  const queueDir = path.join(projDir, 'inputs', 'queue');
  const activeBrief = path.join(projDir, 'inputs', 'brief.md');

  let checkpoint = briefChainState(getProjectFn(project));
  if (!checkpoint.active) {
    checkpoint = { active: true, state: 'idle', file: null, started_at: new Date().toISOString() };
    setMetadataFn(project, 'brief_chain', checkpoint);
  }

  let completed = 0;
  for (;;) {
    checkpoint = briefChainState(getProjectFn(project));
    const queue = await filesInQueue(queueDir);
    // Once a brief is staged/running it owns the cursor even if somebody adds
    // a lexically earlier queue file. Advancing strictly from queue[0] here
    // would abandon paid work after a restart. A missing running source is
    // also resumable from inputs/brief.md; a missing staging source fails
    // honestly when read below instead of silently skipping it.
    const pinnedFile = checkpoint.active
      && ['staging', 'running'].includes(checkpoint.state)
      && typeof checkpoint.file === 'string'
      && checkpoint.file
      ? checkpoint.file
      : null;
    if (queue.length === 0 && !pinnedFile) {
      const done = { ...checkpoint, active: false, state: 'completed', file: null, completed_at: new Date().toISOString() };
      setMetadataFn(project, 'brief_chain', done);
      return { status: 'completed', reason: `brief queue complete (${completed} processed)`, completed };
    }

    const file = pinnedFile || queue[0];

    // New queue head, or a crash during staging: deterministically stage and
    // reset again. The checkpoint is written BEFORE the file mutation so a
    // crash can never mistake the previous brief's ready-for-qa status for
    // completion of this new item.
    if (checkpoint.file !== file || checkpoint.state !== 'running') {
      // Clear dispatched_at when staging a NEW file: it still holds the PREVIOUS
      // brief's dispatch timestamp, and a crash between the 'running' write below
      // and the real dispatched_at write (line ~163) would otherwise leave this
      // new file marked running with a stale dispatched_at — completedSinceDispatch
      // would then read the prior brief's terminal status and archive this brief
      // without ever running it. Null forces a safe re-run instead.
      checkpoint = { ...checkpoint, active: true, state: 'staging', file, dispatched_at: null, updated_at: new Date().toISOString() };
      setMetadataFn(project, 'brief_chain', checkpoint);
      const content = await fs.readFile(path.join(queueDir, file), 'utf-8');
      await fs.mkdir(path.dirname(activeBrief), { recursive: true });
      await fs.writeFile(activeBrief, content, 'utf-8');
      await resetBriefFn(project, { go: false, noArchive: false });
      checkpoint = { ...checkpoint, state: 'running', updated_at: new Date().toISOString() };
      setMetadataFn(project, 'brief_chain', checkpoint);
    } else if (completedSinceDispatch(getLastAutoRunFn(project), checkpoint.dispatched_at)) {
      // Crash/restart after THIS brief's run committed completion but before
      // archive. Gated on dispatched_at so a previous brief's stale terminal
      // status can never archive a queued brief that has not run yet.
      await archiveBrief(queueDir, file);
      completed += 1;
      checkpoint = { ...checkpoint, state: 'idle', file: null, dispatched_at: null, updated_at: new Date().toISOString() };
      setMetadataFn(project, 'brief_chain', checkpoint);
      continue;
    }

    // Record dispatch immediately before the run so a restart can tell "the run
    // began — trust its recorded outcome" from "crashed before dispatch — must
    // run". The previous brief's stale status is never consulted.
    checkpoint = { ...checkpoint, dispatched_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    setMetadataFn(project, 'brief_chain', checkpoint);

    const result = await autoRunFn({ projectName: project, unattended: true, dryRun: false, notifier });
    const latestProject = getProjectFn(project);
    if (briefRunCompleted(result, latestProject, getLastAutoRunFn(project))) {
      await archiveBrief(queueDir, file);
      completed += 1;
      checkpoint = { ...checkpoint, state: 'idle', file: null, updated_at: new Date().toISOString() };
      setMetadataFn(project, 'brief_chain', checkpoint);
      continue;
    }

    // Keep the checkpoint active. A provider/window pause already persisted a
    // deduplicated resume job; hard pauses remain available for manual resume.
    return { ...result, brief_chain_active: true, recoverable: briefRunRecoverable(result), completed };
  }
}
