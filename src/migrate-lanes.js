#!/usr/bin/env node
// migrate-lanes — ensures the phase_lanes table exists (idempotent).
//
// Phase 65 (Execution DAG P1, inert scaffolding): DB surface for a future
// parallel-lane scheduler (one row per phase/fix/duo git-worktree lane).
// state.js's migrate() already creates the table on a FRESH DB (getDb() runs
// migrate() on first open); this script backfills an EXISTING DB that
// predates phase 65 — same dual pattern as migrate-discussions.js /
// migrate-operator-questions.js.

import { getDb } from './state.js';
import chalk from 'chalk';

export function runMigrateLanes() {
  getDb();
  console.log(chalk.green('  ✓ phase_lanes table present'));
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runMigrateLanes();
}
