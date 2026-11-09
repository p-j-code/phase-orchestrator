#!/usr/bin/env node
// Migrate Guide Layout — convert .guide/ from flat (v1) to nested (v2).
//
// Usage:
//   node src/migrate-guide-layout.js                    # migrate all projects
//   node src/migrate-guide-layout.js <project>          # one project
//   node src/migrate-guide-layout.js --dry-run          # show what would change
//
// Idempotent — running twice is safe. Already-migrated projects are skipped.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { slugify, pad2 } from './lib/slug.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const targetProject = args.find((a) => !a.startsWith('--'));

async function readJson(p) { try { return JSON.parse(await fs.readFile(p, 'utf-8')); } catch { return null; } }
async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }
async function move(from, to, log) {
  log(`  ${path.relative(REPO_ROOT, from)} → ${path.relative(REPO_ROOT, to)}`);
  if (dryRun) return;
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.rename(from, to);
}

async function migrateProject(projectName) {
  const projDir = path.join(PROJECTS_DIR, projectName);
  const guideDir = path.join(projDir, '.guide');
  if (!await exists(guideDir)) {
    console.log(chalk.dim(`  ${projectName}: no .guide/ folder, skipping`));
    return;
  }

  const projectJson = await readJson(path.join(projDir, 'project.json'));
  if (projectJson?.guide_layout_version === 2 && !force) {
    console.log(chalk.dim(`  ${projectName}: already v2, skipping (use --force / --repair to consolidate stray flat files anyway)`));
    return;
  }
  if (projectJson?.guide_layout_version === 2 && force) {
    console.log(chalk.yellow(`  ${projectName}: already v2 — running in --force mode to catch stray flat files`));
  }

  console.log(chalk.bold.cyan(`\n  ${projectName}:`));

  const log = (m) => console.log(chalk.dim(m));
  const planPath = path.join(guideDir, 'plan.json');
  const plan = await readJson(planPath);
  const titlesByN = new Map();
  for (const p of (plan?.phases || [])) titlesByN.set(p.n, p.title);

  // Scan .guide/ for files to move
  const entries = await fs.readdir(guideDir);

  // 1. Phase prompts and reports → phases/NN-slug/
  for (const e of entries) {
    let m = e.match(/^phase-(\d+)-(prompt|report)\.md$/);
    if (m) {
      const n = parseInt(m[1], 10);
      const kind = m[2];
      const title = titlesByN.get(n) || `phase-${n}`;
      const dest = path.join(guideDir, 'phases', `${pad2(n)}-${slugify(title)}`, `${kind}.md`);
      await move(path.join(guideDir, e), dest, log);
    }
  }

  // 2. Reviews → reviews/after-N.md
  for (const e of entries) {
    const m = e.match(/^review-after-(\d+)\.md$/);
    if (m) {
      const n = parseInt(m[1], 10);
      const dest = path.join(guideDir, 'reviews', `after-${n}.md`);
      await move(path.join(guideDir, e), dest, log);
    }
  }

  // 3. Bug rounds — bugs-round-R.md, fix-plan-round-R.{json,md}, fix-round-R-fix-N-*.md
  for (const e of entries) {
    let m = e.match(/^bugs-round-(\d+)\.md$/);
    if (m) {
      const r = parseInt(m[1], 10);
      await move(path.join(guideDir, e), path.join(guideDir, 'bug-rounds', `round-${r}`, 'bugs.md'), log);
      continue;
    }
    m = e.match(/^fix-plan-round-(\d+)\.(json|md)$/);
    if (m) {
      const r = parseInt(m[1], 10);
      const ext = m[2];
      await move(path.join(guideDir, e), path.join(guideDir, 'bug-rounds', `round-${r}`, `plan.${ext}`), log);
      continue;
    }
    m = e.match(/^fix-round-(\d+)-fix-(\d+)-(prompt|report)\.md$/);
    if (m) {
      const r = parseInt(m[1], 10);
      const n = parseInt(m[2], 10);
      const kind = m[3];
      // Try to get fix title from fix plan (already moved or still legacy)
      let title = `fix-${n}`;
      const fixPlanNew = path.join(guideDir, 'bug-rounds', `round-${r}`, 'plan.json');
      const fixPlanOld = path.join(guideDir, `fix-plan-round-${r}.json`);
      const fixPlan = await readJson(fixPlanNew) || await readJson(fixPlanOld);
      const fix = (fixPlan?.fixes || []).find((f) => f.n === n);
      if (fix?.title) title = fix.title;
      const dest = path.join(guideDir, 'bug-rounds', `round-${r}`, 'fixes', `${pad2(n)}-${slugify(title)}`, `${kind}.md`);
      await move(path.join(guideDir, e), dest, log);
      continue;
    }
  }

  // 4. Handoff → handoffs/handoff-<stamp>.md
  const handoffPath = path.join(guideDir, 'handoff.md');
  if (await exists(handoffPath)) {
    const stat = await fs.stat(handoffPath);
    const ts = new Date(stat.mtimeMs).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    await move(handoffPath, path.join(guideDir, 'handoffs', `handoff-${ts}.md`), log);
  }

  // 5. Update project.json with new layout version
  if (!dryRun && projectJson) {
    projectJson.guide_layout_version = 2;
    await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify(projectJson, null, 2));
    log(`  project.json: guide_layout_version = 2`);
  }

  console.log(chalk.green(`  ✓ ${projectName} migrated`));
}

async function main() {
  console.log(chalk.bold(`Guide Layout Migration v1 → v2${dryRun ? chalk.yellow(' (DRY RUN)') : ''}`));

  let names;
  if (targetProject) {
    names = [targetProject];
  } else {
    try {
      names = (await fs.readdir(PROJECTS_DIR)).filter((e) => !e.startsWith('.'));
    } catch {
      console.error(chalk.red(`Cannot read ${PROJECTS_DIR}`));
      process.exit(1);
    }
  }

  for (const n of names) {
    try { await migrateProject(n); }
    catch (err) { console.error(chalk.red(`  ${n}: ${err.message}`)); }
  }

  console.log(chalk.green(dryRun ? '\nDry run complete. Re-run without --dry-run to apply.' : '\nMigration complete.'));
}

main().catch((err) => { console.error(chalk.red(err.message)); process.exit(1); });
