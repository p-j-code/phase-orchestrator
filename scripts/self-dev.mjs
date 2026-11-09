#!/usr/bin/env node
/**
 * self-dev — run a dev task ON THE ORCHESTRATOR REPO ITSELF, then commit.
 *
 * Usage:
 *   node scripts/self-dev.mjs --task-file logs/self-dev/<ts>-task.md [--no-commit]
 *
 * Spawned detached by the chat control tool `orchestrator_dev` (the operator
 * confirms in-conversation before it fires); also runnable by hand. Unlike
 * self-heal-agent.js (stack-trace → minimal one-file patch), this takes a
 * free-form task ("fix X", "add flag Y to command Z") and gives the agent the
 * full default toolset (Read/Write/Edit/Bash/Glob/Grep) at repo root.
 *
 * Safety rails:
 *   - The agent is instructed to never touch projects/<name>/workspace|.guide
 *     (CLAUDE.md rules are in its cwd and repeated in the prompt), and the
 *     commit stages everything EXCEPT projects/, state/, logs/ — so even a
 *     misbehaving agent can't get workspace edits committed by this script.
 *   - If config/ or the config resolver changed, `npm run test:config` gates
 *     the commit: on failure NOTHING is committed and the diff is left in the
 *     working tree for review.
 *   - Commit only, never push — the operator reviews and pushes.
 *   - Everything is journaled to logs/self-dev/<ts>-result.md (readable from
 *     chat via the self_dev_log tool).
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve as resolveConfig } from '../src/config-resolver.js';
import { runClaude } from '../src/claude-runner.js';
import { runGit, getCurrentBranch, workspaceStatus, getHeadSha } from '../src/lib/git.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SELF_DEV_DIR = path.join(REPO_ROOT, 'logs', 'self-dev');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
}

async function main() {
  const taskFile = argValue('--task-file');
  const noCommit = process.argv.includes('--no-commit');
  if (!taskFile) throw new Error('--task-file <path> is required');
  const task = (await fs.readFile(path.resolve(REPO_ROOT, taskFile), 'utf-8')).trim();
  if (!task) throw new Error(`task file is empty: ${taskFile}`);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const resultPath = path.join(SELF_DEV_DIR, `${ts}-result.md`);
  await fs.mkdir(SELF_DEV_DIR, { recursive: true });
  const journal = [];
  const log = (line) => { journal.push(line); console.log(`[self-dev] ${line}`); };
  const writeResult = async (status) => {
    const body = [
      `# self-dev result — ${status}`,
      '',
      `- started: ${ts}`,
      `- finished: ${new Date().toISOString()}`,
      '',
      '## Task',
      '',
      task,
      '',
      '## Journal',
      '',
      ...journal.map((l) => `- ${l}`),
      '',
    ].join('\n');
    await fs.writeFile(resultPath, body, 'utf-8');
  };

  // Refuse to run on a dirty tree — the scoped `git add` below could otherwise
  // sweep unrelated in-progress operator work into the self-dev commit.
  const before = await workspaceStatus(REPO_ROOT);
  if (!before.clean) {
    log('working tree is dirty — refusing to run (commit or stash your changes first)');
    await writeResult('refused-dirty-tree');
    process.exit(1);
  }
  const shaBefore = await getHeadSha(REPO_ROOT);
  log(`HEAD before: ${shaBefore?.slice(0, 8) || 'unknown'}`);

  const prompt = [
    'You are doing a maintenance/dev task on the Ashmero Orchestrator repo itself (your cwd is the repo root).',
    'Read CLAUDE.md first and follow its rules. Non-negotiable constraints:',
    '- NEVER modify anything under projects/ (workspaces and .guide dirs are owned by other agents).',
    '- Follow existing conventions (ESM, path.join, async fs, error messages naming the config layer).',
    '- After changing code, verify it: `node --check` the touched files, run `npm run test:config` if you touched config/ or src/config-resolver.js, and run the targeted `node --test <file>` for any module that has a matching *.test.mjs.',
    '- Do NOT run git commit/push — the harness handles the commit after you finish.',
    '- Keep the change minimal and scoped to the task. Update docs/ARCHITECTURE.md only if you add a module or change the cascade order.',
    '',
    'When done, end your reply with a one-paragraph summary: what changed, which files, and how you verified it.',
    '',
    '## Task',
    '',
    task,
  ].join('\n');

  const cfg = await resolveConfig({ project: null, task: 'self-dev' });
  log(`running dev agent (model ${cfg.model})…`);
  let result;
  try {
    result = await runClaude({
      cfg,
      cwd: REPO_ROOT,
      prompt,
      sessionId: null,
      role: null,
      project: null,
      phase: null,
      task: 'self-dev',
    });
  } catch (err) {
    log(`agent failed: ${err.message}`);
    await writeResult('agent-failed');
    process.exit(1);
  }
  const summary = String(result.result || '').trim();
  log(`agent finished (cost $${result.total_cost_usd ?? '?'}, is_error=${!!result.is_error})`);
  journal.push('', '## Agent summary', '', summary.slice(0, 4000), '');

  const after = await workspaceStatus(REPO_ROOT);
  if (after.clean) {
    log('no file changes made — nothing to commit');
    await writeResult(result.is_error ? 'error-no-changes' : 'no-changes');
    process.exit(result.is_error ? 1 : 0);
  }

  // Config gate: broken config must never be committed.
  const diffNames = await runGit(REPO_ROOT, ['diff', '--name-only']);
  const touchedConfig = (diffNames.stdout || '').split('\n').some((f) => f.startsWith('config/') || f === 'src/config-resolver.js');
  if (touchedConfig) {
    log('config touched — running npm run test:config gate…');
    const { spawn } = await import('node:child_process');
    const gateOk = await new Promise((resolve) => {
      const p = spawn('npm', ['run', 'test:config'], { cwd: REPO_ROOT, stdio: 'ignore' });
      p.on('exit', (code) => resolve(code === 0));
      p.on('error', () => resolve(false));
    });
    if (!gateOk) {
      log('test:config FAILED — leaving changes uncommitted for review');
      await writeResult('gate-failed-uncommitted');
      process.exit(1);
    }
    log('test:config passed');
  }

  if (noCommit || result.is_error) {
    log(`changes left uncommitted (${noCommit ? '--no-commit' : 'agent ended with an error'})`);
    await writeResult(result.is_error ? 'error-uncommitted' : 'done-uncommitted');
    process.exit(result.is_error ? 1 : 0);
  }

  // Scoped stage: everything except agent-owned/runtime dirs.
  await runGit(REPO_ROOT, ['add', '-A', '--', '.', ':(exclude)projects', ':(exclude)state', ':(exclude)logs']);
  const firstLine = task.split('\n')[0].slice(0, 60);
  const commit = await runGit(REPO_ROOT, ['commit', '-m', `self-dev: ${firstLine}`]);
  if (!commit.ok) {
    log(`git commit failed: ${(commit.stderr || '').slice(0, 200)}`);
    await writeResult('commit-failed');
    process.exit(1);
  }
  const shaAfter = await getHeadSha(REPO_ROOT);
  const branch = await getCurrentBranch(REPO_ROOT);
  log(`committed ${shaAfter?.slice(0, 8)} on ${branch} (not pushed — review then push)`);
  await writeResult('committed');
  process.exit(0);
}

main().catch(async (err) => {
  console.error(`[self-dev] fatal: ${err.message}`);
  process.exit(1);
});
