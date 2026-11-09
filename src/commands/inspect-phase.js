// Inspect Phase — render a phase's diff + report together for quick review.
//
// Useful after a phase completes (or fails) when you want to see "what
// actually changed" plus "what the dev claimed it did" without bouncing
// between git and the file system.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { getProject, getPhases } from '../state.js';
import { phaseDir, planJsonPath } from '../lib/guide-paths.js';
import { runGit } from '../claude-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

async function readJson(p) { try { return JSON.parse(await fs.readFile(p, 'utf-8')); } catch { return null; } }
async function readText(p) { try { return await fs.readFile(p, 'utf-8'); } catch { return null; } }


function colorizeDiff(diff) {
  return diff.split('\n').map((line) => {
    if (line.startsWith('+++') || line.startsWith('---')) return chalk.bold(line);
    if (line.startsWith('@@')) return chalk.cyan(line);
    if (line.startsWith('+')) return chalk.green(line);
    if (line.startsWith('-')) return chalk.red(line);
    if (line.startsWith('diff ')) return chalk.bold.yellow(line);
    return chalk.dim(line);
  }).join('\n');
}

export async function inspectPhase({ projectName, phaseN, diffOnly = false, reportOnly = false, statOnly = false, fullDiff = false }) {
  const project = getProject(projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);

  const projDir = path.join(PROJECTS_DIR, projectName);
  const workspaceDir = path.join(projDir, 'workspace');

  const phases = getPhases(projectName);
  const phase = phases.find((p) => p.n === phaseN);
  if (!phase) throw new Error(`Phase ${phaseN} not found for project ${projectName}`);

  const plan = await readJson(planJsonPath(projDir));
  const phaseMeta = plan?.phases?.find((p) => p.n === phaseN);
  const phaseTitle = phase.title || phaseMeta?.title || `phase-${phaseN}`;

  // ─── Header ──────────────────────────────────────────────────────────────
  console.log(chalk.bold.cyan(`\n═══ Phase ${phaseN}: ${phaseTitle} ═══\n`));
  console.log(chalk.bold('Metadata:'));
  console.log(`  Status:        ${phase.status === 'completed' ? chalk.green(phase.status) : chalk.yellow(phase.status)}`);
  console.log(`  Commit:        ${phase.commit_sha ? phase.commit_sha.slice(0, 12) : chalk.dim('(none)')}`);
  console.log(`  Model:         ${phase.model_used || chalk.dim('(unknown)')}`);
  console.log(`  Started:       ${phase.started_at || chalk.dim('(unknown)')}`);
  console.log(`  Completed:     ${phase.completed_at || chalk.dim('(unknown)')}`);
  if (phase.commit_sha) {
    const stat = await runGit(['show', '--stat', '--format=%h %ai %s', phase.commit_sha], { cwd: workspaceDir });
    if (stat) {
      const lines = stat.split('\n').filter(Boolean);
      console.log(`  Author info:   ${lines[0]}`);
    }
  }
  console.log('');

  // ─── Report ──────────────────────────────────────────────────────────────
  if (!diffOnly && !statOnly) {
    const dir = await phaseDir(projDir, phaseN, phaseTitle);
    const reportText = await readText(path.join(dir, 'report.md'));
    if (reportText) {
      console.log(chalk.bold.cyan('── Phase Report ──\n'));
      // Render with light formatting for headings
      const formatted = reportText.split('\n').map((line) => {
        if (line.startsWith('# ')) return chalk.bold.yellow(line);
        if (line.startsWith('## ')) return chalk.bold.cyan(line);
        if (line.startsWith('### ')) return chalk.bold(line);
        if (line.match(/^\s*-\s\[x\]/)) return chalk.green(line);
        if (line.match(/^\s*-\s\[\s\]/)) return chalk.red(line);
        return line;
      }).join('\n');
      console.log(formatted);
      console.log('');
    } else {
      console.log(chalk.yellow('⚠ No phase report found.'));
      console.log(chalk.dim(`  Expected at: ${path.relative(projDir, path.join(dir, 'report.md'))}\n`));
    }
  }

  // ─── Diff stat ───────────────────────────────────────────────────────────
  if (!reportOnly && phase.commit_sha) {
    console.log(chalk.bold.cyan('── Files changed ──\n'));
    const stat = await runGit(['show', '--stat', '--format=', phase.commit_sha], { cwd: workspaceDir });
    if (stat != null) {
      console.log(chalk.dim(stat));
    } else {
      console.log(chalk.yellow('⚠ Could not show commit stat'));
    }
  }

  // ─── Full diff ───────────────────────────────────────────────────────────
  if (!reportOnly && !statOnly && phase.commit_sha) {
    if (fullDiff) {
      console.log(chalk.bold.cyan('── Full diff ──\n'));
      const diff = await runGit(['show', '--format=', phase.commit_sha], { cwd: workspaceDir });
      if (diff != null) {
        console.log(colorizeDiff(diff));
      } else {
        console.log(chalk.yellow('⚠ Could not show diff'));
      }
    } else {
      console.log(chalk.dim('\n(Pass --full-diff to see the actual code changes)'));
    }
  }
}
