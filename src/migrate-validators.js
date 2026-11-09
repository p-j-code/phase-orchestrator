#!/usr/bin/env node
// Migrate Validators — adds v0.9 SQLite table for validator run history.
// Safe to run multiple times.

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DB_PATH = process.env.DB_PATH || path.join(REPO_ROOT, 'state', 'orchestrator.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

console.log(chalk.bold('Validators schema migration (v0.9)'));
console.log(chalk.dim(`DB: ${DB_PATH}\n`));

const migrations = [
  {
    name: 'validator_runs table',
    sql: `CREATE TABLE IF NOT EXISTS validator_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      phase INTEGER,
      fix_round INTEGER,
      fix_n INTEGER,
      validator_name TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_ms INTEGER,
      exit_code INTEGER,
      status TEXT NOT NULL DEFAULT 'running',
      stdout_excerpt TEXT,
      stderr_excerpt TEXT,
      error_message TEXT
    )`,
  },
  { name: 'validator_runs.project index', sql: 'CREATE INDEX IF NOT EXISTS idx_validator_project ON validator_runs(project, started_at DESC)' },
  { name: 'validator_runs.status index', sql: 'CREATE INDEX IF NOT EXISTS idx_validator_status ON validator_runs(status, started_at DESC)' },
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

console.log(chalk.green(`\n✓ Migration complete (${applied} steps).`));
db.close();
