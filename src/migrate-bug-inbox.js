// Migrate: add bug_inbox table for v0.12.0 (bug capture / triage / promote)
//
// Idempotent. Re-running is a no-op.
//
// Schema mirrors requirements but with severity-based triage instead of
// priority + scope, and a "promoted_to_round" pointer instead of "promoted_to".

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DB_PATH = process.env.DB_PATH || path.join(REPO_ROOT, 'state', 'orchestrator.db');

const migrations = [
  {
    name: 'bug_inbox table',
    sql: `CREATE TABLE IF NOT EXISTS bug_inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      refined_text TEXT,
      severity TEXT NOT NULL DEFAULT 'unassigned',  -- critical | major | minor | unassigned
      status TEXT NOT NULL DEFAULT 'inbox',         -- inbox | refined | promoted | dropped
      source TEXT,                                   -- telegram | cli | audit
      reported_by INTEGER,                           -- telegram_user_id or NULL
      tags TEXT,
      promoted_to_round INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  },
  { name: 'bug_inbox.project index',  sql: 'CREATE INDEX IF NOT EXISTS idx_bug_inbox_project  ON bug_inbox(project)' },
  { name: 'bug_inbox.status index',   sql: 'CREATE INDEX IF NOT EXISTS idx_bug_inbox_status   ON bug_inbox(status)' },
  { name: 'bug_inbox.severity index', sql: 'CREATE INDEX IF NOT EXISTS idx_bug_inbox_severity ON bug_inbox(severity)' },
  // Extend tg_capture_modes with kind ('req' or 'bug') for cross-inbox capture routing.
  // SQLite's "ADD COLUMN IF NOT EXISTS" isn't supported pre-3.35; guard with PRAGMA check.
];

// Conditional ADD COLUMN for tg_capture_modes.kind (handled after the prepared migrations above)

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

console.log(chalk.bold.cyan('Running bug-inbox migration…'));
for (const m of migrations) {
  try {
    db.exec(m.sql);
    console.log(chalk.dim(`  ✓ ${m.name}`));
  } catch (err) {
    console.error(chalk.red(`  ✗ ${m.name}: ${err.message}`));
    process.exit(1);
  }
}

// Conditional: add `kind` column to tg_capture_modes if missing
try {
  const cols = db.prepare("PRAGMA table_info(tg_capture_modes)").all();
  const hasKind = cols.some((c) => c.name === 'kind');
  if (!hasKind && cols.length > 0) {
    db.exec(`ALTER TABLE tg_capture_modes ADD COLUMN kind TEXT NOT NULL DEFAULT 'req'`);
    console.log(chalk.dim('  ✓ tg_capture_modes.kind column'));
  } else if (cols.length === 0) {
    console.log(chalk.dim('  · tg_capture_modes does not exist yet — run migrate-bot first (column will be created with default)'));
  } else {
    console.log(chalk.dim('  · tg_capture_modes.kind already present, skipping'));
  }
} catch (err) {
  console.error(chalk.red(`  ✗ tg_capture_modes.kind: ${err.message}`));
}

const count = db.prepare('SELECT COUNT(*) as n FROM bug_inbox').get();
console.log(chalk.green(`\nbug_inbox ready. ${count.n} existing rows.`));
db.close();
