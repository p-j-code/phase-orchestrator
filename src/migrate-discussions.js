#!/usr/bin/env node
// migrate-discussions — ensures discussion tables exist (idempotent).
// Tables are now also bootstrapped inside state.js migrate(), so this
// file is only needed for existing DBs that predate the state.js change.

import { getDb } from './state.js';
import chalk from 'chalk';

export function runMigrateDiscussions() {
  // state.js migrate() already runs CREATE TABLE IF NOT EXISTS for all four
  // discussion tables when getDb() is first called. Calling getDb() here
  // is sufficient to guarantee the tables exist on an older DB.
  getDb();
  console.log(chalk.green('  ✓ discussion tables present (discussions, disc_agents, disc_messages, disc_conclusions)'));
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runMigrateDiscussions();
}
