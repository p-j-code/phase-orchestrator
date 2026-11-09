// migrate-pause-kind — adds pause_kind TEXT column to auto_runs.
// Idempotent: safe to run on an already-migrated DB.

import chalk from 'chalk';
import { getDb } from './state.js';

const db = getDb();
const cols = db.pragma('table_info(auto_runs)').map((c) => c.name);
if (cols.includes('pause_kind')) {
  console.log(chalk.dim('migrate-pause-kind: pause_kind column already exists — skipping.'));
} else {
  db.exec(`ALTER TABLE auto_runs ADD COLUMN pause_kind TEXT`);
  console.log(chalk.green('migrate-pause-kind: added pause_kind column to auto_runs.'));
}
