#!/usr/bin/env node
// migrate-total-phases — backfills projects.total_phases from .guide/plan.json
// for any project row that still has total_phases=0.
// Idempotent: skips projects that already have a non-zero value.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { getProject, setTotalPhases } from './state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

export async function runMigrateTotalPhases() {
  let dirs;
  try { dirs = await fs.readdir(PROJECTS_DIR); }
  catch { console.log(chalk.dim('No projects/ directory yet.')); return; }

  let updated = 0;
  let skipped = 0;
  for (const name of dirs) {
    const stat = await fs.stat(path.join(PROJECTS_DIR, name)).catch(() => null);
    if (!stat?.isDirectory()) continue;

    const proj = getProject(name);
    if (!proj) continue;
    if (proj.total_phases !== 0) {
      skipped++;
      continue;
    }

    const planPath = path.join(PROJECTS_DIR, name, '.guide', 'plan.json');
    let plan;
    try {
      plan = JSON.parse(await fs.readFile(planPath, 'utf-8'));
    } catch {
      console.log(chalk.dim(`  · ${name}: no plan.json, skipping`));
      continue;
    }

    if (!plan?.phases || !Array.isArray(plan.phases)) {
      console.log(chalk.yellow(`  ⚠ ${name}: plan.json has no phases array, skipping`));
      continue;
    }

    setTotalPhases(name, plan.phases.length);
    console.log(chalk.green(`  ✓ ${name}: total_phases → ${plan.phases.length}`));
    updated++;
  }
  console.log(chalk.bold(`\nBackfill done. ${updated} updated, ${skipped} already set.`));
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) { await runMigrateTotalPhases(); }
