#!/usr/bin/env node
// Migrate Requirements — adds v0.7 SQLite tables for the requirements inbox.
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

console.log(chalk.bold('Requirements schema migration (v0.7)'));
console.log(chalk.dim(`DB: ${DB_PATH}\n`));

const migrations = [
  {
    name: 'requirements table',
    sql: `CREATE TABLE IF NOT EXISTS requirements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      refined_text TEXT,
      source TEXT,
      priority TEXT NOT NULL DEFAULT 'unassigned',
      scope TEXT NOT NULL DEFAULT 'unassigned',
      status TEXT NOT NULL DEFAULT 'inbox',
      tags TEXT,
      promoted_to TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by INTEGER
    )`,
  },
  { name: 'requirements.project index', sql: 'CREATE INDEX IF NOT EXISTS idx_req_project ON requirements(project, status)' },
  { name: 'requirements.status index', sql: 'CREATE INDEX IF NOT EXISTS idx_req_status ON requirements(status)' },
  {
    name: 'tg_capture_modes table',
    sql: `CREATE TABLE IF NOT EXISTS tg_capture_modes (
      telegram_user_id INTEGER PRIMARY KEY,
      project TEXT NOT NULL,
      started_at TEXT NOT NULL
    )`,
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

console.log(chalk.green(`\n✓ Migration complete (${applied} steps).`));
db.close();
