// migrate-git — bring an existing project under orchestrator git management.
//
// What it does:
//   1. Verifies workspace is a git repo (or runs `git init` if not + --init)
//   2. Verifies origin remote (or sets it if --remote <url> given)
//   3. Creates the target branch (default `develop`) from the current HEAD
//      if it doesn't exist, then checks it out
//   4. Pushes the branch to origin with --set-upstream
//   5. Updates project.git_branch + project.git_remote in SQLite
//   6. Appends a sane .gitignore (won't overwrite existing entries)
//
// Idempotent — running it twice on the same project is a no-op past step 5.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import {
  runGit, isGitRepo, hasRemote, getCurrentBranch, branchExists,
  remoteBranchExists, pushBranch, workspaceStatus,
} from '../lib/git.js';
import { getProject, setProjectGitConfig } from '../state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

const DEFAULT_GITIGNORE_ENTRIES = [
  '# OS noise',
  '.DS_Store',
  'Thumbs.db',
  '',
  '# Editor',
  '.vscode/',
  '.idea/',
  '*.swp',
  '',
  '# Node',
  'node_modules/',
  '.env',
  '.env.local',
  '.env.*.local',
  'npm-debug.log*',
  'yarn-error.log*',
  '',
  '# Build outputs',
  'dist/',
  'build/',
  '.next/',
  'coverage/',
];

async function ensureGitignore(workspaceDir) {
  const giPath = path.join(workspaceDir, '.gitignore');
  let existing = '';
  try { existing = await fs.readFile(giPath, 'utf-8'); } catch { /* no file */ }

  const existingLines = new Set(existing.split('\n').map((l) => l.trim()));
  const toAdd = DEFAULT_GITIGNORE_ENTRIES.filter((line) => {
    if (line.startsWith('#') || line === '') return false; // never dedupe comments/blanks
    return !existingLines.has(line);
  });

  if (toAdd.length === 0) return { changed: false, added: 0 };

  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  const block = prefix + '\n# Added by orchestrator migrate-git\n' + toAdd.join('\n') + '\n';
  await fs.writeFile(giPath, existing + block);
  return { changed: true, added: toAdd.length };
}

export async function migrateGit({ projectName, branch = 'develop', remote = null, init = false }) {
  const project = getProject(projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);

  const projDir = path.join(PROJECTS_DIR, projectName);
  const workspaceDir = path.join(projDir, 'workspace');

  console.log(chalk.bold.cyan(`\n═══ Migrate Git: ${projectName} → branch '${branch}' ═══\n`));

  // 1. Is it a git repo?
  if (!(await isGitRepo(workspaceDir))) {
    if (!init) {
      throw new Error(`Workspace is not a git repo: ${workspaceDir}\n  Pass --init to initialize, or set it up manually first.`);
    }
    console.log(chalk.dim(`Initializing git repo in ${workspaceDir}...`));
    const initRes = await runGit(workspaceDir, ['init', '-b', branch]);
    if (!initRes.ok) throw new Error(`git init failed: ${initRes.stderr}`);
    // Initial commit so the branch has something to push
    await ensureGitignore(workspaceDir);
    await runGit(workspaceDir, ['add', '.gitignore']);
    const commit = await runGit(workspaceDir, ['commit', '-m', 'chore: initial commit (orchestrator)']);
    if (!commit.ok) throw new Error(`initial commit failed: ${commit.stderr}`);
    console.log(chalk.green(`  ✓ git init -b ${branch} + initial commit`));
  } else {
    console.log(chalk.green(`  ✓ Workspace is a git repo`));
  }

  // 2. Remote
  const currentRemote = await hasRemote(workspaceDir);
  if (!currentRemote) {
    if (!remote) {
      throw new Error(`Workspace has no 'origin' remote. Pass --remote <url> to set one.`);
    }
    const add = await runGit(workspaceDir, ['remote', 'add', 'origin', remote]);
    if (!add.ok) throw new Error(`Could not add remote: ${add.stderr}`);
    console.log(chalk.green(`  ✓ Set origin → ${remote}`));
  } else if (remote && remote !== currentRemote) {
    console.warn(chalk.yellow(`  ⚠ Existing origin (${currentRemote}) differs from --remote (${remote}). Not changing — pass --force-remote to override.`));
  } else {
    console.log(chalk.green(`  ✓ origin already set: ${currentRemote}`));
  }
  const finalRemote = await hasRemote(workspaceDir);

  // 3. Branch — create from HEAD if missing, then checkout
  const current = await getCurrentBranch(workspaceDir);
  if (current !== branch) {
    if (await branchExists(workspaceDir, branch)) {
      console.log(chalk.dim(`  Checking out existing '${branch}'...`));
      const co = await runGit(workspaceDir, ['checkout', branch]);
      if (!co.ok) throw new Error(`checkout ${branch}: ${co.stderr}`);
    } else {
      console.log(chalk.dim(`  Creating '${branch}' from current HEAD (${current})...`));
      const co = await runGit(workspaceDir, ['checkout', '-b', branch]);
      if (!co.ok) throw new Error(`checkout -b ${branch}: ${co.stderr}`);
    }
    console.log(chalk.green(`  ✓ On branch '${branch}'`));
  } else {
    console.log(chalk.green(`  ✓ Already on branch '${branch}'`));
  }

  // 4. .gitignore housekeeping (only if workspace is otherwise clean — we
  // don't want to bundle our changes with unrelated uncommitted edits)
  const status = await workspaceStatus(workspaceDir);
  if (status.clean) {
    const gi = await ensureGitignore(workspaceDir);
    if (gi.changed) {
      await runGit(workspaceDir, ['add', '.gitignore']);
      const commit = await runGit(workspaceDir, ['commit', '-m', 'chore: orchestrator .gitignore additions']);
      if (commit.ok) console.log(chalk.green(`  ✓ .gitignore: ${gi.added} new entries committed`));
    } else {
      console.log(chalk.dim(`  .gitignore already has standard entries`));
    }
  } else {
    console.log(chalk.yellow(`  ⚠ Workspace dirty (${status.dirty.length} change(s)) — skipping .gitignore update. Run again after committing.`));
  }

  // 5. Push to origin
  console.log(chalk.dim(`  Pushing ${branch} to origin...`));
  const push = await pushBranch(workspaceDir, { branch });
  if (push.ok) {
    console.log(chalk.green(`  ✓ Pushed ${branch} → origin`));
  } else {
    console.warn(chalk.yellow(`  ⚠ Push failed: ${push.error}`));
    console.warn(chalk.yellow(`    Migration recorded locally; push manually when you can:`));
    console.warn(chalk.yellow(`      cd ${workspaceDir} && git push --set-upstream origin ${branch}`));
  }

  // 6. Persist on the project row + project.json
  setProjectGitConfig(projectName, { git_branch: branch, git_remote: finalRemote });

  // Also reflect in project.json for visibility
  const pjPath = path.join(projDir, 'project.json');
  try {
    const pj = JSON.parse(await fs.readFile(pjPath, 'utf-8'));
    pj.git_branch = branch;
    pj.git_remote = finalRemote;
    await fs.writeFile(pjPath, JSON.stringify(pj, null, 2) + '\n');
  } catch (e) {
    console.warn(chalk.yellow(`  ⚠ Could not update project.json: ${e.message}`));
  }

  console.log(chalk.bold.green(`\n✓ ${projectName} is now under orchestrator git management.`));
  console.log(chalk.dim(`   Branch: ${branch} → ${finalRemote}`));
  console.log(chalk.dim(`   All future phases/fixes will commit + push to ${branch}.`));
  console.log(chalk.dim(`   When ready, promote develop → main with:  npm run ship -- ${projectName}\n`));

  return { ok: true, branch, remote: finalRemote, pushed: push.ok };
}
