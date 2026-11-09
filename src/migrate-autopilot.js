#!/usr/bin/env node
// migrate-autopilot — ensures the autopilot_approvals table exists (idempotent).
//
// Phase 85 (Portfolio autopilot P7a): DB surface for standing, always-expiring
// operator approvals of autopilot actions (default: 'brief'). execute()
// (src/lib/portfolio-autopilot.js) consumes rows here as the ONLY gate that lets
// an autonomous overnight brief job enqueue.
//
// state.js's migrate() already creates the table on a FRESH DB (getDb() runs
// migrate() on first open); this script backfills an EXISTING DB that predates
// phase 85 — the same dual pattern as migrate-window-scheduling.js /
// migrate-lanes.js. It honors DB_PATH via getDb() (process.env.DB_PATH ||
// state/orchestrator.db) and performs its OWN guarded CREATE TABLE / CREATE
// INDEX so it is self-contained + independently runnable
// (node src/migrate-autopilot.js). Strictly idempotent: CREATE ... IF NOT
// EXISTS makes a second run a no-op.

import { getDb } from './state.js';
import chalk from 'chalk';

export function runMigrateAutopilot() {
  // getDb() opens process.env.DB_PATH || the default and runs migrate(), which
  // already contains this DDL — so the table exists after this call regardless.
  // We still issue the guarded DDL explicitly so this module is self-contained
  // and does not silently depend on state.js's baseline never regressing.
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS autopilot_approvals (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      project             TEXT NOT NULL,
      action              TEXT NOT NULL,
      scope               TEXT NOT NULL DEFAULT 'all',
      remaining_nights    INTEGER,
      expires_at          TEXT,
      consumed_nights     INTEGER NOT NULL DEFAULT 0,
      last_consumed_night TEXT,
      created_at          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_autopilot_approvals_lookup ON autopilot_approvals(project, action);
  `);
  // Phase 86 (P7b): the nightly scheduler's restart-safe cursor. Same
  // self-contained/idempotent pattern — state.js's migrate() already creates it
  // on a fresh DB; this backfills an existing DB that predates phase 86.
  db.exec(`
    CREATE TABLE IF NOT EXISTS autopilot (
      id                INTEGER PRIMARY KEY CHECK (id = 1),
      last_planned_date TEXT,
      last_planned_at   TEXT,
      last_plan_json    TEXT,
      last_digest_date  TEXT,
      last_digest_at    TEXT
    );
    INSERT OR IGNORE INTO autopilot (id) VALUES (1);
  `);
  console.log(chalk.green('  ✓ autopilot_approvals + autopilot tables present'));
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runMigrateAutopilot();
}
