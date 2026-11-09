#!/usr/bin/env node
// migrate-all — chains all incremental SQLite migrations in dependency order.
// Idempotent: safe to run on an already-migrated DB.

import path from 'node:path';
import fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { getDb } from './state.js';
import { runMigrateTotalPhases } from './migrate-total-phases.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

export async function runMigrateAll() {
  console.log(chalk.bold.cyan('Running migrate-all…'));
  // Step 1: core tables (projects, phases, sessions, calls, auto_runs, bug_rounds)
  getDb();
  // Step 2–5: incremental tables in dependency order
  await import('./migrate-bot.js');
  await import('./migrate-requirements.js');
  await import('./migrate-validators.js');
  // migrate-bug-inbox.js has a hardcoded state/ path and no mkdirSync guard —
  // ensure the directory exists so it can open its DB connection.
  fsSync.mkdirSync(path.join(REPO_ROOT, 'state'), { recursive: true });
  await import('./migrate-bug-inbox.js');
  // Phase 48: operator_questions has no FK dependency on any other table —
  // chained right after bug-inbox, the other standalone-inbox-shaped table.
  await import('./migrate-operator-questions.js');
  await import('./migrate-pause-kind.js');
  const { runMigrateDiscussions } = await import('./migrate-discussions.js');
  runMigrateDiscussions();
  // Phase 65 (Execution DAG P1): phase_lanes — inert scaffolding, no scheduler
  // writes to it yet.
  const { runMigrateLanes } = await import('./migrate-lanes.js');
  runMigrateLanes();
  // Phase 79 (P2): tg_jobs.deferred_count — the picker's starvation guard for
  // window-deferred heavy jobs. Idempotent ALTER (backfills existing DBs).
  const { runMigrateWindowScheduling } = await import('./migrate-window-scheduling.js');
  runMigrateWindowScheduling();
  // Phase 85 (Portfolio autopilot P7a): autopilot_approvals — the standing,
  // always-expiring approval store gating autonomous overnight brief jobs.
  // Idempotent CREATE ... IF NOT EXISTS (backfills existing DBs).
  const { runMigrateAutopilot } = await import('./migrate-autopilot.js');
  runMigrateAutopilot();
  console.log(chalk.green('\n✓ migrate-all complete — all 20 tables present (+ discussions, phase_lanes).'));
  // Phase 14: convert legacy free-form .guide/decisions.md → schema-validated
  // .guide/decisions.jsonl (file migration; idempotent, preserves originals).
  console.log(chalk.bold('\nMigrating decisions logs to JSONL…'));
  const { runMigrateDecisions } = await import('./migrate-decisions.js');
  await runMigrateDecisions();
  console.log(chalk.bold('\nBackfilling total_phases from existing plan.json files…'));
  await runMigrateTotalPhases();
}

// Allow running directly: node src/migrate-all.js
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runMigrateAll().catch((err) => {
    console.error(chalk.red(`\nmigrate-all failed: ${err.message}`));
    process.exit(1);
  });
}
