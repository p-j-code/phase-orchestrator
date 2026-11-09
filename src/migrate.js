// Migrate — applies v0.2 SQLite schema additions to existing databases.
//
// Safe to run multiple times. Only adds new tables/columns, never drops.

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DB_PATH = path.join(REPO_ROOT, 'state', 'orchestrator.db');

const dbPath = process.env.DB_PATH || DEFAULT_DB_PATH;
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

console.log(chalk.bold('Orchestrator v0.2 migration'));
console.log(chalk.dim(`DB: ${dbPath}\n`));

// Add new tables (IF NOT EXISTS is idempotent)
const migrations = [
  {
    name: 'auto_runs table',
    sql: `CREATE TABLE IF NOT EXISTS auto_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      pause_reason TEXT,
      unattended INTEGER NOT NULL DEFAULT 0
    )`,
  },
  {
    name: 'bug_rounds table',
    sql: `CREATE TABLE IF NOT EXISTS bug_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      round INTEGER NOT NULL,
      bugs_file TEXT,
      fix_plan_file TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL DEFAULT 'in-progress',
      fixes_completed INTEGER NOT NULL DEFAULT 0,
      total_fixes INTEGER NOT NULL DEFAULT 0,
      UNIQUE (project, round)
    )`,
  },
  {
    name: 'auto_runs index',
    sql: 'CREATE INDEX IF NOT EXISTS idx_auto_runs_project ON auto_runs(project, started_at)',
  },
  {
    name: 'bug_rounds index',
    sql: 'CREATE INDEX IF NOT EXISTS idx_bug_rounds_project ON bug_rounds(project, round)',
  },
];

let applied = 0;
for (const m of migrations) {
  try {
    db.exec(m.sql);
    console.log(chalk.green(`✓ ${m.name}`));
    applied += 1;
  } catch (err) {
    console.error(chalk.red(`✗ ${m.name}: ${err.message}`));
    process.exit(1);
  }
}

// Backfill: ensure existing projects have a sensible status
const projects = db.prepare('SELECT name, status, current_phase, total_phases FROM projects').all();
for (const p of projects) {
  if (!p.status || p.status === '') {
    db.prepare('UPDATE projects SET status = ? WHERE name = ?').run('planning', p.name);
    console.log(chalk.dim(`  backfilled status=planning on ${p.name}`));
  }
}

console.log(chalk.green(`\n✓ Migration complete (${applied} steps).`));
db.close();
