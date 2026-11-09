// Upgrade Project — brings an existing project up to current orchestrator
// conventions. Idempotent. Runs migrations + checks for missing convention
// files + offers to backfill them.
//
// Specifically:
//   1. Migrate .guide/ folder layout v1 → v2 (if not already done)
//   2. Add session-ids.json if missing
//   3. Add workspace/CLAUDE.md if missing (offers Sonnet call)
//   4. Bump project.json schema_version
//   5. Report any other inconsistencies found

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import chalk from 'chalk';
import { getProject } from '../state.js';
import {
  guideRoot, planJsonPath, sessionIdsPath,
} from '../lib/guide-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

async function fileExists(p) { try { await fs.access(p); return true; } catch { return false; } }
async function readJson(p) { try { return JSON.parse(await fs.readFile(p, 'utf-8')); } catch { return null; } }

export async function upgradeProject({ projectName, generateClaudeMd = false, dryRun = false }) {
  const project = getProject(projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);

  const projDir = path.join(PROJECTS_DIR, projectName);
  if (!fsSync.existsSync(projDir)) throw new Error(`Project directory missing: ${projDir}`);

  console.log(chalk.bold.cyan(`\n═══ Upgrading ${projectName} ═══${dryRun ? chalk.yellow(' (DRY RUN)') : ''}\n`));

  const actions = [];
  const skipped = [];

  // ─── Check 1: project.json schema version + guide_layout_version ──────────
  const projectJsonPath = path.join(projDir, 'project.json');
  const projectJson = await readJson(projectJsonPath);

  if (!projectJson) {
    actions.push({ name: 'create project.json', reason: 'missing entirely' });
  } else {
    const currentLayoutVer = projectJson.guide_layout_version || 1;
    if (currentLayoutVer < 2) actions.push({ name: 'set guide_layout_version=2', reason: `currently v${currentLayoutVer}` });
    else skipped.push({ name: 'guide_layout_version', reason: 'already v2' });
  }

  // ─── Check 2: nested .guide/ folder layout ───────────────────────────────
  const guideDir = guideRoot(projDir);
  if (fsSync.existsSync(guideDir)) {
    const entries = await fs.readdir(guideDir);
    const hasFlatPhases = entries.some((e) => /^phase-\d+-(prompt|report)\.md$/.test(e));
    const hasNestedPhases = entries.includes('phases');

    if (hasFlatPhases && !hasNestedPhases) {
      actions.push({ name: 'migrate-layout (flat → nested)', reason: 'old phase-N-prompt.md files at .guide/ root' });
    } else if (hasNestedPhases) {
      skipped.push({ name: 'folder layout', reason: 'already nested (v2)' });
    } else {
      skipped.push({ name: 'folder layout', reason: 'no phases yet' });
    }
  }

  // ─── Check 3: session-ids.json ────────────────────────────────────────────
  if (!await fileExists(sessionIdsPath(projDir))) {
    actions.push({ name: 'create session-ids.json', reason: 'mirror of SQLite session ids' });
  } else {
    skipped.push({ name: 'session-ids.json', reason: 'already exists' });
  }

  // ─── Check 4: workspace/CLAUDE.md ─────────────────────────────────────────
  const workspaceClaudeMd = path.join(projDir, 'workspace', 'CLAUDE.md');
  const workspaceSkippedNote = path.join(guideDir, 'workspace-claude-md-skipped.md');
  if (!await fileExists(workspaceClaudeMd) && !await fileExists(workspaceSkippedNote)) {
    if (generateClaudeMd) {
      actions.push({ name: 'generate workspace/CLAUDE.md', reason: 'missing (will spawn Sonnet call)' });
    } else {
      skipped.push({ name: 'workspace/CLAUDE.md', reason: 'missing, but --generate-claude-md not set (run separately: npm run claude-md -- ' + projectName + ')' });
    }
  } else {
    skipped.push({ name: 'workspace/CLAUDE.md', reason: await fileExists(workspaceClaudeMd) ? 'exists' : 'previously skipped' });
  }

  // ─── Check 5: directory existence ─────────────────────────────────────────
  for (const d of ['workspace', 'inputs', 'outputs']) {
    if (!fsSync.existsSync(path.join(projDir, d))) {
      actions.push({ name: `create ${d}/`, reason: 'missing standard directory' });
    }
  }

  // ─── Report plan ──────────────────────────────────────────────────────────
  if (actions.length === 0) {
    console.log(chalk.green('No upgrades needed. Project is current.\n'));
    if (skipped.length > 0) {
      console.log(chalk.dim('Checks that passed:'));
      for (const s of skipped) console.log(chalk.dim(`  • ${s.name} — ${s.reason}`));
    }
    return { upgraded: 0, skipped: skipped.length };
  }

  console.log(chalk.yellow(`Found ${actions.length} action(s) to take:\n`));
  for (const a of actions) {
    console.log(chalk.yellow(`  → ${a.name}`));
    console.log(chalk.dim(`    ${a.reason}`));
  }

  if (dryRun) {
    console.log(chalk.dim('\nDry run — no changes made. Re-run without --dry-run to apply.'));
    return { upgraded: 0, skipped: skipped.length, planned: actions.length };
  }

  console.log(chalk.cyan('\nApplying…\n'));

  // ─── Apply ────────────────────────────────────────────────────────────────
  let applied = 0;

  for (const action of actions) {
    try {
      if (action.name === 'create project.json') {
        const newProjectJson = {
          $schema_version: 1, name: projectName,
          tech_stack: project.tech_stack || '', profile: project.profile || null,
          created_at: project.created_at || new Date().toISOString(),
          current_phase: project.current_phase || 0,
          total_phases: project.total_phases || 0,
          guide_session_id: null, last_dev_session_id: null,
          status: project.status || 'planning',
          guide_layout_version: 2,
          overrides: {}, metadata: {},
        };
        await fs.writeFile(projectJsonPath, JSON.stringify(newProjectJson, null, 2));
        console.log(chalk.green(`  ✓ Created project.json`));
        applied += 1;
      } else if (action.name.startsWith('set guide_layout_version')) {
        projectJson.guide_layout_version = 2;
        await fs.writeFile(projectJsonPath, JSON.stringify(projectJson, null, 2));
        console.log(chalk.green(`  ✓ Bumped project.json guide_layout_version to 2`));
        applied += 1;
      } else if (action.name === 'migrate-layout (flat → nested)') {
        // Shell out to the migrate-layout script for safety
        await runChild('node', ['src/migrate-guide-layout.js', projectName], { cwd: REPO_ROOT });
        console.log(chalk.green(`  ✓ Migrated .guide/ folder layout`));
        applied += 1;
      } else if (action.name === 'create session-ids.json') {
        await fs.mkdir(guideDir, { recursive: true });
        await fs.writeFile(sessionIdsPath(projDir), JSON.stringify({
          guide: { current: project.guide_session_id || null, history: [] },
          dev_sessions: project.last_dev_session_id ? [project.last_dev_session_id] : [],
        }, null, 2));
        console.log(chalk.green(`  ✓ Created session-ids.json`));
        applied += 1;
      } else if (action.name === 'generate workspace/CLAUDE.md') {
        // Lazy-import to avoid circular deps
        const { runGuide } = await import('../lib/phase-runner.js');
        await runGuide({ projectName, task: 'workspace-claude-md' });
        console.log(chalk.green(`  ✓ Generated workspace/CLAUDE.md (or wrote skipped note)`));
        applied += 1;
      } else if (action.name.startsWith('create ')) {
        const dirName = action.name.replace('create ', '').replace('/', '');
        await fs.mkdir(path.join(projDir, dirName), { recursive: true });
        console.log(chalk.green(`  ✓ Created ${dirName}/`));
        applied += 1;
      }
    } catch (err) {
      console.log(chalk.red(`  ✗ ${action.name}: ${err.message}`));
    }
  }

  console.log(chalk.green(`\n✓ Upgrade complete. ${applied}/${actions.length} actions applied.`));
  return { upgraded: applied, skipped: skipped.length };
}

function runChild(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: 'inherit' });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}`));
    });
    child.on('error', reject);
  });
}
