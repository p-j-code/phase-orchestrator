#!/usr/bin/env node
// Migrate Bot — adds v0.5 SQLite tables for Telegram bot.
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

console.log(chalk.bold('Bot schema migration (v0.5)'));
console.log(chalk.dim(`DB: ${DB_PATH}\n`));

const migrations = [
  {
    name: 'tg_users table',
    sql: `CREATE TABLE IF NOT EXISTS tg_users (
      telegram_user_id INTEGER PRIMARY KEY,
      telegram_handle TEXT,
      allowlisted_at TEXT NOT NULL,
      label TEXT
    )`,
  },
  {
    name: 'tg_jobs table',
    sql: `CREATE TABLE IF NOT EXISTS tg_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      action TEXT NOT NULL,
      args_json TEXT,
      requested_by INTEGER,
      requested_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      result_summary TEXT,
      error_message TEXT
    )`,
  },
  { name: 'tg_jobs.status index', sql: 'CREATE INDEX IF NOT EXISTS idx_tg_jobs_status ON tg_jobs(status, id)' },
  { name: 'tg_jobs.project index', sql: 'CREATE INDEX IF NOT EXISTS idx_tg_jobs_project ON tg_jobs(project)' },
  {
    name: 'tg_auth_codes table',
    sql: `CREATE TABLE IF NOT EXISTS tg_auth_codes (
      code TEXT PRIMARY KEY,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      label TEXT
    )`,
  },
  { name: 'tg_auth_codes.expires_at index', sql: 'CREATE INDEX IF NOT EXISTS idx_tg_auth_codes_expires ON tg_auth_codes(expires_at)' },
  {
    name: 'tg_pinned_projects table',
    sql: `CREATE TABLE IF NOT EXISTS tg_pinned_projects (
      telegram_user_id INTEGER PRIMARY KEY,
      project TEXT NOT NULL,
      pinned_at TEXT NOT NULL
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
