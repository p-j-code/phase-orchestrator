// migrate-skills.mjs — Phase 10 one-shot backfill.
//
// The `workspace-claude-md` guide task now materializes workspace/.claude/
// skills/{phase-report,commit-conventions,orchestrator-context}/SKILL.md
// (byte-identical copies of prompts/skills/*) and merges a git-push deny rule
// into workspace/.claude/settings.json for every NEW project. This script
// backfills EXISTING projects that predate that change.
//
// Deterministic — same src/lib/workspace-skills.js used by the live guide
// task (src/lib/phase-runner.js), no `claude` subprocess involved.
//
// Idempotent: a workspace that already has `.claude/skills/` is skipped
// entirely, so re-running (e.g. after `aorch new` adds another project) only
// touches projects that still need it.
//
// Run with: npm run migrate-skills

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { resolve as resolveConfig } from '../src/config-resolver.js';
import { materializeWorkspaceSkills, hasWorkspaceSkills } from '../src/lib/workspace-skills.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PROMPTS_DIR = path.join(REPO_ROOT, 'prompts');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/**
 * Backfill a single project. Takes an explicit `projDir` (rather than always
 * deriving it from `projectName`) so a verify/test harness can point this at
 * a throwaway fixture directory — note `resolveConfig` itself still reads
 * `projects/<projectName>/project.json` off the real repo root (its REPO_ROOT
 * is not injectable), so per-project override tests must use a real fixture
 * project folder under `projects/`, not an arbitrary tmpdir.
 *
 * @returns {Promise<{ status: 'migrated'|'already-scaffolded'|'opted-out'|'no-workspace', reason?: string, detail?: object }>}
 */
export async function migrateProjectDir(projectName, projDir, promptsDir = PROMPTS_DIR) {
  const cfg = await resolveConfig({ project: projectName, task: 'workspace-claude-md' });
  const wcfg = cfg.workspace_claude_md || {};

  if (wcfg.generate_skills === false) {
    return { status: 'opted-out', reason: 'workspace_claude_md.generate_skills:false' };
  }
  if (!wcfg.auto_generate_on_new && !wcfg.auto_generate_during_autorun) {
    return { status: 'opted-out', reason: 'auto_generate_on_new and auto_generate_during_autorun both false' };
  }

  const workspaceDir = path.join(projDir, cfg.paths?.workspace_subdir || 'workspace');
  if (!(await fileExists(workspaceDir))) return { status: 'no-workspace' };
  if (await hasWorkspaceSkills(workspaceDir)) return { status: 'already-scaffolded' };

  const preserveExisting = wcfg.preserve_existing !== false;
  const detail = await materializeWorkspaceSkills(workspaceDir, promptsDir, { preserveExisting });
  return { status: 'migrated', detail };
}

async function main() {
  let entries;
  try {
    entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch (err) {
    console.error(chalk.red(`Cannot read projects dir: ${PROJECTS_DIR} (${err.message})`));
    process.exitCode = 1;
    return;
  }

  const projectNames = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  console.log(chalk.bold(`\n── migrate-skills: scanning ${projectNames.length} project(s) ──\n`));

  const summary = { migrated: [], 'already-scaffolded': [], 'opted-out': [], 'no-workspace': [], errored: [] };

  for (const name of projectNames) {
    const projDir = path.join(PROJECTS_DIR, name);
    try {
      const result = await migrateProjectDir(name, projDir);
      summary[result.status].push(name);
      if (result.status === 'migrated') {
        const d = result.detail;
        console.log(chalk.green(`✓ ${name}`) + chalk.dim(` — wrote [${d.written.join(', ') || 'none'}], settings.json ${d.settingsChanged ? 'updated' : 'unchanged'}`));
      } else {
        console.log(chalk.dim(`  ${name} — ${result.status}${result.reason ? ` (${result.reason})` : ''}`));
      }
    } catch (err) {
      summary.errored.push(name);
      console.warn(chalk.yellow(`⚠ ${name} — error: ${err.message}`));
    }
  }

  console.log(chalk.bold('\n── summary ──'));
  console.log(`  migrated:           ${summary.migrated.length}`);
  console.log(`  already-scaffolded: ${summary['already-scaffolded'].length}`);
  console.log(`  opted-out:          ${summary['opted-out'].length}`);
  console.log(`  no-workspace:       ${summary['no-workspace'].length}`);
  if (summary.errored.length) {
    console.log(chalk.red(`  errored:            ${summary.errored.length} (${summary.errored.join(', ')})`));
    process.exitCode = 1;
  }
  console.log('');
}

// Only run when invoked directly (`node scripts/migrate-skills.mjs` /
// `npm run migrate-skills`) — not when imported by a verify/test harness.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
