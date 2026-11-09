// Migrate: add operator_questions table for Phase 48 (non-blocking
// ask_operator MCP tool).
//
// Idempotent. Re-running is a no-op.
//
// Dual pattern mirrors migrate-bug-inbox.js: state.js's baseline DDL already
// creates this table on a FRESH DB (getDb() runs migrate() on first open);
// this script backfills an EXISTING DB that predates Phase 48.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DB_PATH = process.env.DB_PATH || path.join(REPO_ROOT, 'state', 'orchestrator.db');

const migrations = [
  {
    name: 'operator_questions table',
    sql: `CREATE TABLE IF NOT EXISTS operator_questions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      project       TEXT NOT NULL,
      phase         INTEGER,
      question      TEXT NOT NULL,
      options       TEXT,                          -- JSON array, nullable
      assumption    TEXT NOT NULL,
      blocking      INTEGER NOT NULL DEFAULT 0,     -- recorded, ignored for control flow in v1
      status        TEXT NOT NULL DEFAULT 'open',   -- open | answered | expired
      answer        TEXT,
      answered_by   INTEGER,
      notified_at   TEXT,                           -- set by phase-49's poller; NULL = not yet
      created_at    TEXT NOT NULL,
      answered_at   TEXT
    )`,
  },
  { name: 'operator_questions.project index', sql: 'CREATE INDEX IF NOT EXISTS idx_operator_questions_project ON operator_questions(project)' },
  { name: 'operator_questions.status index',  sql: 'CREATE INDEX IF NOT EXISTS idx_operator_questions_status  ON operator_questions(status)' },
];

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

console.log(chalk.bold.cyan('Running operator-questions migration…'));
for (const m of migrations) {
  try {
    db.exec(m.sql);
    console.log(chalk.dim(`  ✓ ${m.name}`));
  } catch (err) {
    console.error(chalk.red(`  ✗ ${m.name}: ${err.message}`));
    process.exit(1);
  }
}

const count = db.prepare('SELECT COUNT(*) as n FROM operator_questions').get();
console.log(chalk.green(`\noperator_questions ready. ${count.n} existing rows.`));
db.close();
