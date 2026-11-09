// Retry Phase — safely revert a failed (or merely-disappointing) phase
// to clean state so it can be re-run.
//
// What it does:
//   1. Verifies the phase exists and was previously executed
//   2. Identifies the git commit produced by that phase (if any)
//   3. Auto-stashes any uncommitted workspace changes (safety net)
//   4. Either: resets to the phase's PARENT commit (default),
//      OR:    resets to a specified earlier commit
//   5. Marks the phase as 'pending' in SQLite
//   6. Sets project.current_phase back to (n - 1)
//   7. Removes the phase's prompt + report from .guide/ (optional)
//
// Critical safety: requires explicit confirmation unless --force.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { getProject, upsertPhase, setCurrentPhase, getPhases } from '../state.js';
import { runGitOrThrow } from '../lib/git.js';
import { phaseDir, planJsonPath } from '../lib/guide-paths.js';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

async function readJson(p) { try { return JSON.parse(await fs.readFile(p, 'utf-8')); } catch { return null; } }

// All git goes through src/lib/git.js (repo convention + no-raw-git-spawn
// invariant). runGitOrThrow returns trimmed stdout on success and throws
// `git <args> failed (exit N): <stderr>` on failure — a drop-in for the old
// local spawn helper, with the added safety of runGit's timeout + group-kill.
const gitRun = (workspaceDir, args) => runGitOrThrow(workspaceDir, args);

async function confirm(question) {
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question(question);
  rl.close();
  return /^(y|yes)$/i.test(answer.trim());
}

export async function retryPhase({ projectName, phaseN, force = false, keepPromptReport = false, dryRun = false }) {
  const project = getProject(projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);

  const projDir = path.join(PROJECTS_DIR, projectName);
  const workspaceDir = path.join(projDir, 'workspace');

  const phases = getPhases(projectName);
  const phase = phases.find((p) => p.n === phaseN);
  if (!phase) throw new Error(`Phase ${phaseN} not found for project ${projectName}`);

  // Read the plan for the phase title (folder naming)
  const plan = await readJson(planJsonPath(projDir));
  const phaseMeta = plan?.phases?.find((p) => p.n === phaseN);
  const phaseTitle = phase.title || phaseMeta?.title || `phase-${phaseN}`;

  console.log(chalk.bold.cyan(`\n═══ Retry Phase ${phaseN}: ${phaseTitle} ═══${dryRun ? chalk.yellow(' (DRY RUN)') : ''}\n`));

  console.log(chalk.dim('Current state:'));
  console.log(chalk.dim(`  status:        ${phase.status}`));
  console.log(chalk.dim(`  commit_sha:    ${phase.commit_sha || '(none)'}`));
  console.log(chalk.dim(`  model_used:    ${phase.model_used || '(unknown)'}`));
  console.log(chalk.dim(`  current_phase: ${project.current_phase} (project)`));
  console.log('');

  // Check workspace has git
  if (!fsSync.existsSync(path.join(workspaceDir, '.git'))) {
    throw new Error(`No git repo in ${workspaceDir}. Cannot safely reset.`);
  }

  // Identify the target commit (parent of this phase's commit, or HEAD~1 if no commit recorded)
  let targetCommit = null;
  let stashRef = null;

  if (phase.commit_sha) {
    try {
      targetCommit = await gitRun(workspaceDir, ['rev-parse', `${phase.commit_sha}^`]);
      console.log(chalk.dim(`Target commit: ${targetCommit.slice(0, 12)} (parent of phase ${phaseN} commit ${phase.commit_sha.slice(0, 12)})`));
    } catch (err) {
      console.log(chalk.yellow(`⚠ Could not resolve parent of ${phase.commit_sha}: ${err.message}`));
      console.log(chalk.yellow(`  Will use current HEAD~1 instead.`));
    }
  }

  if (!targetCommit) {
    try {
      targetCommit = await gitRun(workspaceDir, ['rev-parse', 'HEAD~1']);
      console.log(chalk.dim(`Target commit: ${targetCommit.slice(0, 12)} (HEAD~1)`));
    } catch (err) {
      throw new Error(`Cannot determine target commit: ${err.message}. Workspace may not have enough history.`);
    }
  }

  // Confirm
  console.log('');
  console.log(chalk.yellow('This will:'));
  console.log(chalk.yellow(`  • Auto-stash any uncommitted workspace changes (safety stash)`));
  console.log(chalk.yellow(`  • git reset --hard ${targetCommit.slice(0, 12)}`));
  console.log(chalk.yellow(`  • Mark phase ${phaseN} as 'pending' in SQLite`));
  console.log(chalk.yellow(`  • Set project.current_phase = ${phaseN - 1}`));
  if (!keepPromptReport) {
    console.log(chalk.yellow(`  • Remove .guide/phases/<NN-slug>/prompt.md and report.md`));
  }
  console.log('');

  if (dryRun) {
    console.log(chalk.dim('Dry run — no changes made. Re-run without --dry-run to apply.'));
    return {
      dryRun: true,
      phaseN,
      phaseTitle,
      parentSha: targetCommit,
      currentSha: phase.commit_sha || null,
    };
  }

  if (!force) {
    const ok = await confirm(chalk.bold('Proceed? [y/N] '));
    if (!ok) {
      console.log(chalk.dim('\nAborted.'));
      return;
    }
  }

  // Execute: safety stash
  try {
    const stashOutput = await gitRun(workspaceDir, ['stash', 'push', '-u', '-m', `orchestrator-retry-phase-${phaseN}-${new Date().toISOString()}`]);
    if (stashOutput.includes('No local changes')) {
      console.log(chalk.dim(`\n  Stash: no uncommitted changes`));
    } else {
      stashRef = await gitRun(workspaceDir, ['stash', 'list']).then((s) => s.split('\n')[0]?.split(':')[0] || null);
      console.log(chalk.green(`\n  ✓ Stashed uncommitted changes → ${stashRef || 'stash@{0}'}`));
    }
  } catch (err) {
    console.log(chalk.yellow(`  ⚠ Stash failed (continuing): ${err.message}`));
  }

  // Execute: hard reset
  try {
    await gitRun(workspaceDir, ['reset', '--hard', targetCommit]);
    console.log(chalk.green(`  ✓ Reset workspace to ${targetCommit.slice(0, 12)}`));
  } catch (err) {
    throw new Error(`git reset failed: ${err.message}`);
  }

  // Update SQLite
  upsertPhase({ project: projectName, n: phaseN, title: phaseTitle, status: 'pending' });
  setCurrentPhase(projectName, phaseN - 1);
  console.log(chalk.green(`  ✓ Marked phase ${phaseN} as pending; project.current_phase = ${phaseN - 1}`));

  // Remove prompt + report unless --keep
  if (!keepPromptReport) {
    const dir = await phaseDir(projDir, phaseN, phaseTitle);
    for (const f of ['prompt.md', 'report.md']) {
      const p = path.join(dir, f);
      try {
        await fs.unlink(p);
        console.log(chalk.green(`  ✓ Removed ${path.relative(projDir, p)}`));
      } catch { /* already gone */ }
    }
  }

  console.log('');
  console.log(chalk.bold.green('Retry prepared.'));
  if (stashRef) {
    console.log(chalk.dim(`\nIf you need to recover stashed changes:`));
    console.log(chalk.dim(`  cd ${workspaceDir} && git stash list   # find your stash`));
    console.log(chalk.dim(`  cd ${workspaceDir} && git stash pop ${stashRef}`));
  }
  console.log(chalk.dim('\nResume the project to re-run this phase:'));
  console.log(chalk.dim(`  npm run resume -- ${projectName}`));
}
