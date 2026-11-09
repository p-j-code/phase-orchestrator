// Log + outputs cleanup. Prunes old artifacts from logs/, dashboard files
// from outputs/, and stale rows from the calls table. Tuned via config.cleanup.
//
// Safety contract:
//   - Only touches logs/*.log, outputs/dashboard-*.html, and the calls table
//   - Never touches .guide/, workspace/, project zips, state.db besides calls
//   - Skips files newer than min_age_minutes so active subprocesses are safe
//   - All errors swallowed; cleanup must never crash the caller

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { pruneOldCalls } from '../state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

export async function runCleanup(cfg, { dryRun = false, verbose = false } = {}) {
  const c = (cfg && cfg.cleanup) || {};
  if (c.enabled === false) {
    return { skipped: true, reason: 'cleanup.enabled is false' };
  }

  const logsMaxDays  = c.logs_retention_days    ?? 30;
  const logsMaxFiles = c.logs_max_files         ?? 5000;
  const outMaxDays   = c.outputs_retention_days ?? 14;
  const callsMaxDays = c.calls_retention_days   ?? 90;
  const minAgeMin    = c.min_age_minutes        ?? 60;

  const stats = {
    logs_deleted: 0,
    logs_bytes_freed: 0,
    outputs_deleted: 0,
    outputs_bytes_freed: 0,
    calls_pruned: 0,
    dryRun,
  };

  await pruneByAgeAndCount(path.join(REPO_ROOT, 'logs'), {
    maxDays: logsMaxDays,
    maxFiles: logsMaxFiles,
    minAgeMin,
    extensions: ['.log'],
    dryRun,
    stats,
    bucket: 'logs',
  });

  await pruneByAgeAndCount(path.join(REPO_ROOT, 'outputs'), {
    maxDays: outMaxDays,
    maxFiles: null,
    minAgeMin,
    filenamePattern: /^dashboard-\d+\.html$/,
    dryRun,
    stats,
    bucket: 'outputs',
  });

  if (callsMaxDays > 0 && !dryRun) {
    try { stats.calls_pruned = pruneOldCalls(callsMaxDays); } catch { /* sqlite locked etc */ }
  }

  if (verbose || stats.logs_deleted || stats.outputs_deleted || stats.calls_pruned) {
    const tag = dryRun ? chalk.yellow('[cleanup:dry-run]') : chalk.dim('[cleanup]');
    console.log(
      `${tag} logs=${stats.logs_deleted} (${formatBytes(stats.logs_bytes_freed)}) `
      + `outputs=${stats.outputs_deleted} (${formatBytes(stats.outputs_bytes_freed)}) `
      + `calls=${stats.calls_pruned}`,
    );
  }

  return stats;
}

async function pruneByAgeAndCount(dir, opts) {
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return; // dir not present yet
  }

  const cutoffAge = Date.now() - opts.maxDays * 24 * 3600 * 1000;
  const minAge = Date.now() - opts.minAgeMin * 60 * 1000;

  const files = [];
  for (const name of entries) {
    if (opts.extensions && !opts.extensions.some((e) => name.endsWith(e))) continue;
    if (opts.filenamePattern && !opts.filenamePattern.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const st = await fs.stat(full);
      if (!st.isFile()) continue;
      files.push({ full, mtime: st.mtimeMs, size: st.size });
    } catch { /* ignore */ }
  }

  files.sort((a, b) => a.mtime - b.mtime); // oldest first

  const toDelete = new Set();

  // Age policy
  for (const f of files) {
    if (f.mtime <= cutoffAge && f.mtime <= minAge) toDelete.add(f);
  }

  // Count policy (oldest first, only files past the safe-age threshold)
  if (opts.maxFiles) {
    const eligible = files.filter((f) => f.mtime <= minAge);
    const overflow = eligible.length - opts.maxFiles;
    for (let i = 0; i < overflow; i += 1) toDelete.add(eligible[i]);
  }

  for (const f of toDelete) {
    try {
      if (!opts.dryRun) await fs.unlink(f.full);
      opts.stats[`${opts.bucket}_deleted`] += 1;
      opts.stats[`${opts.bucket}_bytes_freed`] += f.size;
    } catch { /* file vanished, perm error, etc */ }
  }
}

function formatBytes(b) {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / (1024 * 1024)).toFixed(1)}MB`;
}
