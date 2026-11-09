import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getDb, getProject, deleteProject, reserveProjectDeletion, releaseProjectDeletion,
  getActiveAutoRun, getRunningJob, pidAlive,
} from '../state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

/**
 * Remove a project from the orchestrator — DB rows + optional disk cleanup.
 *
 * @param {object} opts
 * @param {string}  opts.name       Project slug
 * @param {boolean} [opts.keepFiles=false]  If true, skip rm -rf of projects/<name>/
 * @returns {Promise<{ok: boolean, dbDeleted: boolean, filesDeleted: boolean, filesError?: string}>}
 */
export async function removeProject({ name, keepFiles = false } = {}) {
  const proj = getProject(name);
  if (!proj) throw new Error(`Project not found: ${name}`);

  // Deleting a project underneath a queue worker or detached command can
  // remove workspace/.guide while it is writing. Refuse on every durable and
  // process-backed source of work; stale runs must be recovered explicitly.
  const activeAutoRun = getActiveAutoRun(name);
  const queueJobs = getDb().prepare(`
    SELECT id, action, status, worker_pid FROM tg_jobs
    WHERE project = ? AND status IN ('pending', 'running') ORDER BY id
  `).all(name);
  const runningOwner = getRunningJob(name);
  const detached = getDb().prepare(`
    SELECT id, action, pid FROM detached_spawns
    WHERE project = ? AND pid IS NOT NULL ORDER BY id DESC
  `).all(name).filter((row) => pidAlive(row.pid));
  if (activeAutoRun || queueJobs.length || (runningOwner && pidAlive(runningOwner.pid)) || detached.length) {
    const err = new Error(`Project '${name}' has active or queued work; stop/cancel it before removal`);
    err.code = 'PROJECT_BUSY';
    err.details = {
      autoRunId: activeAutoRun?.id ?? null,
      queueJobs: queueJobs.map(({ id, action, status }) => ({ id, action, status })),
      runningPid: runningOwner && pidAlive(runningOwner.pid) ? runningOwner.pid : null,
      detached: detached.map(({ id, action, pid }) => ({ id, action, pid })),
    };
    throw err;
  }

  // Close the check→filesystem-rename race under a SQLite write lock. Queue
  // enqueue/claim and CLI running-job claims all refuse this tombstone.
  reserveProjectDeletion(name);

  if (keepFiles) {
    try {
      deleteProject(name);
      return { ok: true, dbDeleted: true, filesDeleted: false };
    } catch (err) {
      releaseProjectDeletion(name);
      throw err;
    }
  }

  const projDir = path.resolve(PROJECTS_DIR, name);
  if (!projDir.startsWith(`${PROJECTS_DIR}${path.sep}`)) {
    releaseProjectDeletion(name);
    throw new Error(`Refusing unsafe project path: ${name}`);
  }

  // Stage the directory with an atomic rename first. If the DB transaction
  // fails, restore it. If the final recursive delete fails, report a non-OK
  // partial result while leaving the staged directory recoverable.
  let stagedDir = null;
  try {
    await fs.access(projDir);
    stagedDir = path.join(PROJECTS_DIR, `.removing-${name}-${Date.now()}-${process.pid}`);
    await fs.rename(projDir, stagedDir);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      releaseProjectDeletion(name);
      throw e;
    }
  }

  try {
    deleteProject(name);
  } catch (dbError) {
    if (stagedDir) {
      try { await fs.rename(stagedDir, projDir); }
      catch (restoreError) {
        releaseProjectDeletion(name);
        const err = new Error(`Database deletion failed and project files could not be restored: ${dbError.message}; restore: ${restoreError.message}`);
        err.code = 'PROJECT_REMOVE_PARTIAL';
        err.details = { dbDeleted: false, filesStaged: true, stagedDir };
        throw err;
      }
    }
    releaseProjectDeletion(name);
    throw dbError;
  }

  if (!stagedDir) {
    return { ok: true, dbDeleted: true, filesDeleted: false, filesMissing: true };
  }
  try {
    await fs.rm(stagedDir, { recursive: true, force: true });
    return { ok: true, dbDeleted: true, filesDeleted: true };
  } catch (e) {
    return {
      ok: false,
      dbDeleted: true,
      filesDeleted: false,
      filesStaged: true,
      stagedDir,
      filesError: e.message,
    };
  }
}
