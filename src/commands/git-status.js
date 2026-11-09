// git-status — show workspace git state for one project, in a form usable
// from CLI or Telegram. The returned object is the source of truth; the
// CLI formatter and Telegram formatter both render from it.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { getProject } from '../state.js';
import {
  isGitRepo, hasRemote, getCurrentBranch, workspaceStatus,
  aheadBehind, lastCommitOneLine, branchExists, runGit,
} from '../lib/git.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

/**
 * @returns {Promise<{
 *   ok: boolean,
 *   error?: string,
 *   project: string,
 *   configured_branch: string|null,
 *   configured_remote: string|null,
 *   current_branch: string|null,
 *   remote_url: string|null,
 *   clean: boolean,
 *   dirty_count: number,
 *   dirty_sample: string[],
 *   last_commit: string|null,
 *   ahead_behind: {ahead: number, behind: number}|null,
 *   ship_lag: number|null,  // commits on develop not on main
 * }>}
 */
export async function getGitStatus(projectName) {
  const project = getProject(projectName);
  if (!project) return { ok: false, error: `Project not found: ${projectName}` };

  const workspaceDir = path.join(PROJECTS_DIR, projectName, 'workspace');

  if (!(await isGitRepo(workspaceDir))) {
    return {
      ok: false, project: projectName,
      error: `Workspace is not a git repo. Run: npm run migrate-git -- --project ${projectName}`,
    };
  }

  const remote = await hasRemote(workspaceDir);
  const current = await getCurrentBranch(workspaceDir);
  const status = await workspaceStatus(workspaceDir);
  const last = await lastCommitOneLine(workspaceDir);
  const ab = current ? await aheadBehind(workspaceDir, current) : null;

  // ship_lag: how far ahead is the configured develop branch over main?
  // Only computed when develop != main and both exist.
  let shipLag = null;
  const developBranch = project.git_branch;
  if (developBranch && developBranch !== 'main' && (await branchExists(workspaceDir, 'main'))) {
    const r = await runGit(workspaceDir, ['rev-list', '--count', `main..${developBranch}`]);
    if (r.ok) shipLag = parseInt(r.stdout, 10) || 0;
  }

  return {
    ok: true,
    project: projectName,
    configured_branch: project.git_branch || null,
    configured_remote: project.git_remote || remote || null,
    current_branch: current,
    remote_url: remote,
    clean: status.clean,
    dirty_count: status.dirty.length,
    dirty_sample: status.dirty.slice(0, 5),
    last_commit: last,
    ahead_behind: ab,
    ship_lag: shipLag,
  };
}

export function renderGitStatusCli(s) {
  if (!s.ok) return chalk.red(`✗ ${s.error}\n`);

  const lines = [];
  lines.push(chalk.bold.cyan(`Git status — ${s.project}`));
  lines.push('');

  const branchOk = s.configured_branch && s.current_branch === s.configured_branch;
  lines.push(`  Branch:        ${branchOk ? chalk.green(s.current_branch) : chalk.yellow(s.current_branch)} ${s.configured_branch ? chalk.dim(`(configured: ${s.configured_branch})`) : chalk.dim('(no configured branch)')}`);
  lines.push(`  Remote:        ${s.remote_url ? chalk.green(s.remote_url) : chalk.red('(none)')}`);

  if (s.ahead_behind) {
    const { ahead, behind } = s.ahead_behind;
    const sync = ahead === 0 && behind === 0 ? chalk.green('in sync') :
      `${ahead > 0 ? chalk.yellow(`↑${ahead}`) : ''} ${behind > 0 ? chalk.yellow(`↓${behind}`) : ''}`.trim();
    lines.push(`  vs origin:     ${sync}`);
  } else if (s.current_branch) {
    lines.push(`  vs origin:     ${chalk.dim('(no upstream)')}`);
  }

  lines.push(`  Working tree:  ${s.clean ? chalk.green('clean') : chalk.yellow(`${s.dirty_count} dirty file(s)`)}`);
  if (!s.clean && s.dirty_sample.length) {
    for (const d of s.dirty_sample) lines.push(chalk.dim(`                   ${d}`));
    if (s.dirty_count > s.dirty_sample.length) lines.push(chalk.dim(`                   ... and ${s.dirty_count - s.dirty_sample.length} more`));
  }

  if (s.last_commit) lines.push(`  Last commit:   ${s.last_commit}`);

  if (s.ship_lag !== null) {
    if (s.ship_lag === 0) lines.push(`  Ship status:   ${chalk.green('main == develop')} (nothing to ship)`);
    else lines.push(`  Ship status:   ${chalk.yellow(`develop is ${s.ship_lag} commit(s) ahead of main`)} — run \`npm run ship -- ${s.project}\``);
  }

  return lines.join('\n') + '\n';
}

export function renderGitStatusTelegram(s) {
  if (!s.ok) return `❌ ${s.error}`;

  const lines = [];
  lines.push(`*Git status — ${escMd(s.project)}*`);
  lines.push('');

  const branchOk = s.configured_branch && s.current_branch === s.configured_branch;
  lines.push(`• Branch: \`${escMd(s.current_branch || '(none)')}\` ${branchOk ? '✓' : '⚠'} ${s.configured_branch ? `_(configured: ${escMd(s.configured_branch)})_` : '_(not configured)_'}`);
  lines.push(`• Remote: ${s.remote_url ? '\`' + escMd(s.remote_url) + '\`' : '_(none)_'}`);

  if (s.ahead_behind) {
    const { ahead, behind } = s.ahead_behind;
    const sync = ahead === 0 && behind === 0 ? '✓ in sync' :
      [ahead > 0 ? `↑${ahead}` : '', behind > 0 ? `↓${behind}` : ''].filter(Boolean).join(' ');
    lines.push(`• vs origin: ${sync}`);
  }

  lines.push(`• Working tree: ${s.clean ? '✓ clean' : `⚠ ${s.dirty_count} dirty`}`);
  if (s.last_commit) lines.push(`• Last: \`${escMd(s.last_commit)}\``);

  if (s.ship_lag !== null) {
    if (s.ship_lag === 0) lines.push(`• Ship: ✓ main == develop`);
    else lines.push(`• Ship: ${s.ship_lag} commit(s) on develop not yet on main`);
  }

  return lines.join('\n');
}

function escMd(s) {
  // Telegram MarkdownV2 has many reserved chars; safer to escape minimal set
  // when content is path/branch-like (no _ or *)
  return String(s || '').replace(/([_*`\[\]()])/g, '\\$1');
}
