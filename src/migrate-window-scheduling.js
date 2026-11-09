#!/usr/bin/env node
// migrate-window-scheduling — adds tg_jobs.deferred_count (idempotent).
//
// Phase 79 (P2, window-aware job scheduling): the picker
// (src/server/job-queue.js nextPendingJobForFreeProject) defers a HEAVY pending
// job when the shared billing window is merely 'warn', stamping a future
// not_before and bumping deferred_count. The STARVATION GUARD reads this column:
// a heavy job defers AT MOST ONCE (deferred_count>=1 → admitted regardless of
// warn on its next due tick).
//
// state.js's migrate() already adds the column on a FRESH DB (getDb() runs
// migrate() on first open); this script backfills an EXISTING DB that predates
// phase 79 — the same dual pattern as migrate-lanes.js / migrate-pause-kind.js.
// It performs its OWN guarded ALTER so it is self-contained + independently
// runnable (node src/migrate-window-scheduling.js), and honors DB_PATH via
// getDb(). Strictly idempotent: running it twice is a no-op (duplicate-column
// ALTERs are swallowed), and old tg_jobs rows without the column read as 0
// (INTEGER NOT NULL DEFAULT 0 backfills them).

import { getDb } from './state.js';
import chalk from 'chalk';

export function runMigrateWindowScheduling() {
  const db = getDb();
  const cols = db.pragma('table_info(tg_jobs)').map((c) => c.name);
  if (cols.includes('deferred_count')) {
    console.log(chalk.dim('migrate-window-scheduling: deferred_count column already exists — skipping.'));
    return;
  }
  db.exec(`ALTER TABLE tg_jobs ADD COLUMN deferred_count INTEGER NOT NULL DEFAULT 0`);
  console.log(chalk.green('migrate-window-scheduling: added deferred_count column to tg_jobs.'));
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runMigrateWindowScheduling();
}
