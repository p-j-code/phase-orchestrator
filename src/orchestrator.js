#!/usr/bin/env node
// Ashmero Orchestrator v0.3 — entry point.

import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from './lib/env-file.js';
import { resolve as resolveConfig } from './config-resolver.js';
import { runGuide, runDev } from './lib/phase-runner.js';
import { autoRun, detectNewBugRound } from './auto-runner.js';
import { startBugCycle, statusForProject as bugStatus } from './bug-cycle.js';
import { renderStatus } from './billing-guard.js';
import { analyzeProject } from './model-router.js';
import {
  briefPath, rawThoughtsPath, briefQuestionsPath,
  projectContextPath,
  planJsonPath, sessionIdsPath, reviewPath,
  auditPath, roadmapPath, findMostRecentAudit, findMostRecentRoadmap,
  bugRoundDir, bugsFilePath, detectHighestBugRound, archiveSupersededPhases,
} from './lib/guide-paths.js';
import { promoteAuditToBugs } from './lib/audit-promote.js';
import { hasUnreviewedFreshRoadmap } from './lib/coach.js';
import { resolveSuggestionSlot, commitAdvance } from './lib/suggestion-slot.js';
import {
  upsertProject, getProject, listProjects,
  getPhases, setGuideSessionId, setProjectStatus,
  getActiveAutoRun, getLastAutoRun, resetProjectForNewPlan,
  sweepInterruptedAutoRuns, getRunningJob, pidAlive,
} from './state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Load REPO_ROOT/.env before any command action resolves config — headless
// installs (the NAS) carry CLAUDE_BIN / CLAUDE_CODE_OAUTH_TOKEN there because
// pm2/systemd start this process with a bare environment. Real env vars are
// never overridden (see src/lib/env-file.js).
await loadDotEnv(path.join(REPO_ROOT, '.env'));

const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');
const USER_CONFIG_DIR = path.join(os.homedir(), '.ashmero-orchestrator');
const USER_CONFIG_PATH = path.join(USER_CONFIG_DIR, 'user.json');

const program = new Command();
program.name('orchestrator').description('Claude Code orchestrator for phase-based development').version('0.6.0');

// ─── init / migrate ────────────────────────────────────────────────────────

program.command('init').description('One-time setup')
  .option('--email <email>', 'Anthropic account email (the one with Max)')
  .option('--plan <plan>', 'Plan tier (e.g. "Max 20x", "Max 5x", "Pro")', 'Max 20x')
  .option('--no-migrate', 'Skip automatic SQLite migration (advanced setups only)')
  .action(async (opts) => {
    await fs.mkdir(USER_CONFIG_DIR, { recursive: true });
    if (await fileExists(USER_CONFIG_PATH)) {
      console.log(chalk.yellow(`Already exists: ${USER_CONFIG_PATH}`));
      console.log(chalk.dim('To update account info: npm run account -- --email <email> --plan <plan>'));
      return;
    }
    const claudeBin = await findClaudeBin();
    await fs.writeFile(USER_CONFIG_PATH, JSON.stringify({
      $schema_version: 1, claude_bin: claudeBin,
      claude_account: { email: opts.email || '', plan: opts.plan || 'Max 20x' },
      default_git_user: { name: '', email: '' },
      telegram: { enabled: false, bot_token: null, chat_id: null },
      notification_channels: ['terminal'],
    }, null, 2));
    console.log(chalk.green(`Created ${USER_CONFIG_PATH}`));
    if (opts.migrate !== false) {
      const { runMigrateAll } = await import('./migrate-all.js');
      await runMigrateAll();
    } else {
      console.log(chalk.dim('Run: npm run migrate-all  (to create all required SQLite tables)'));
    }
    if (!opts.email) {
      console.log(chalk.dim('\nTip: set your account email so it shows on every run:'));
      console.log(chalk.dim('  npm run account -- --email <you@example.com>'));
    }
  });

program.command('doctor').description('Verify auth, account, and model selection are working correctly')
  .option('--no-probe', 'Skip the live Claude probe call (saves ~$0.001)')
  .option('--json', 'Machine-readable output')
  .action(async (opts) => {
    const { runDoctor } = await import('./doctor.js');
    const r = await runDoctor({ noProbe: opts.probe === false, json: opts.json });
    process.exit(r.failures > 0 ? 1 : 0);
  });

// ─── Bot / Server (v0.5) ───────────────────────────────────────────────────

program.command('bot-setup').description('Configure Telegram bot token and webhook')
  .option('--token <token>', 'Bot token from @BotFather')
  .option('--mode <mode>', 'polling | webhook', 'polling')
  .option('--webhook-url <url>', 'Public HTTPS URL for webhook (mode=webhook only)')
  .option('--webhook-port <port>', 'Local port for webhook listener', parseInt, 3434)
  .action(async (opts) => {
    if (!opts.token) {
      console.error(chalk.red('--token required. Get one from @BotFather on Telegram.'));
      console.error(chalk.dim('See: docs/TELEGRAM_BOT.md'));
      process.exit(1);
    }
    const cfgPath = path.join(REPO_ROOT, 'config', 'telegram.json');
    const cfg = {
      $schema_version: 1,
      bot_token: opts.token,
      mode: opts.mode,
      webhook_url: opts.webhookUrl || null,
      webhook_port: opts.webhookPort,
    };
    await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2));
    console.log(chalk.green(`✓ Wrote ${path.relative(REPO_ROOT, cfgPath)}`));
    console.log(chalk.dim('\nNext: npm run migrate-all   (creates all required SQLite tables)'));
    console.log(chalk.dim('Then: npm run server         (start the daemon)'));
  });

program.command('migrate-bot').description('Apply v0.5 SQLite schema for bot tables')
  .action(async () => { await import('./migrate-bot.js'); });

program.command('migrate-requirements').description('Apply v0.7 SQLite schema for requirements inbox')
  .action(async () => { await import('./migrate-requirements.js'); });

program.command('migrate-validators').description('Apply v0.9 SQLite schema for validator runs')
  .action(async () => { await import('./migrate-validators.js'); });

program.command('migrate-bug-inbox').description('Apply v0.12 SQLite schema for bug inbox')
  .action(async () => { await import('./migrate-bug-inbox.js'); });

program.command('migrate-all').description('Apply all SQLite schema migrations in order (idempotent)')
  .action(async () => { const { runMigrateAll } = await import('./migrate-all.js'); await runMigrateAll(); });

program.command('bot-auth-code').description('Issue a one-time auth code for Telegram allowlist')
  .option('--label <label>', 'Friendly label for this user (e.g. "Prem main")')
  .action(async (opts) => {
    const { issueAuthCode } = await import('./server/job-queue.js');
    const code = issueAuthCode(opts.label);
    console.log(chalk.green(`\n  Auth code: ${chalk.bold(code)}\n`));
    console.log(chalk.dim('  In Telegram, send to your bot:'));
    console.log(chalk.dim(`    /auth ${code}\n`));
    console.log(chalk.yellow('  ⚠  Code expires in 15 minutes.'));
    console.log(chalk.yellow('  ⚠  Server must be running for /auth to be processed.\n'));
  });

program.command('bot-users').description('Manage Telegram allowlist')
  .option('--list', 'Show allowlisted users')
  .option('--remove <id>', 'Remove a user by telegram_user_id', parseInt)
  .action(async (opts) => {
    const { listUsers, removeUser } = await import('./server/job-queue.js');
    if (opts.remove) {
      const r = removeUser(opts.remove);
      console.log(r.changes > 0 ? chalk.green(`✓ Removed user ${opts.remove}`) : chalk.yellow(`User ${opts.remove} not found.`));
      return;
    }
    const users = listUsers();
    if (users.length === 0) { console.log(chalk.dim('No allowlisted users.')); return; }
    console.log(chalk.bold('Allowlisted users:'));
    for (const u of users) {
      console.log(`  ${u.telegram_handle || u.label || '(no label)'}`);
      console.log(chalk.dim(`    ID: ${u.telegram_user_id}   added: ${u.allowlisted_at}`));
    }
  });

program.command('server').description('Start the long-running orchestrator server (Telegram bot + job queue)')
  .action(async () => { await import('./server.js'); });

program.command('account').description('View or update Claude account info shown in auto-runner header')
  .option('--email <email>', 'Set account email')
  .option('--plan <plan>', 'Set plan tier (e.g. "Max 20x")')
  .action(async (opts) => {
    const userCfg = await readJson(USER_CONFIG_PATH);
    if (!userCfg) {
      console.error(chalk.red('No user config. Run: npm run init first.'));
      process.exit(1);
    }
    if (!userCfg.claude_account) userCfg.claude_account = { email: '', plan: 'Max 20x' };
    if (opts.email !== undefined) userCfg.claude_account.email = opts.email;
    if (opts.plan !== undefined) userCfg.claude_account.plan = opts.plan;
    if (opts.email !== undefined || opts.plan !== undefined) {
      await fs.writeFile(USER_CONFIG_PATH, JSON.stringify(userCfg, null, 2));
      console.log(chalk.green('Account updated.'));
    }
    console.log(chalk.bold('\nClaude Account'));
    console.log(`  Email: ${userCfg.claude_account.email || chalk.dim('(not set)')}`);
    console.log(`  Plan:  ${userCfg.claude_account.plan || chalk.dim('(not set)')}`);
    console.log(chalk.dim(`  File:  ${USER_CONFIG_PATH}`));
    console.log(chalk.dim('\n  Verify actual login: open `claude` then type `/status`'));
  });

program.command('migrate').description('Apply v0.2+ SQLite schema migrations').action(async () => {
  await import('./migrate.js');
});

program.command('migrate-layout').description('Migrate .guide/ folders from flat (v1) to nested (v2), or repair stray flat files on already-v2 projects')
  .option('--dry-run', 'show what would change without making changes')
  .option('--project <name>', 'migrate only one project')
  .option('--force', 'also process projects already marked v2 (catches stray flat files written by old prompt versions)')
  .option('--repair', 'alias for --force')
  .action(async (opts) => {
    const args = ['node', 'src/migrate-guide-layout.js'];
    if (opts.dryRun) args.push('--dry-run');
    if (opts.force || opts.repair) args.push('--force');
    if (opts.project) args.push(opts.project);
    process.argv = args;
    await import('./migrate-guide-layout.js');
  });

// ─── new ───────────────────────────────────────────────────────────────────

program.command('new <name>').description('Bootstrap a new project — from a git URL (clone if non-empty, init if empty) or local-only with --no-git')
  .option('-p, --profile <profile>', 'Profile name')
  .option('-t, --tech <stack>', 'Tech stack description')
  .option('-z, --zip <path>', 'Existing project zip (legacy — not used in v0.13+)')
  .option('--git-remote <url>', 'Git remote URL — auto-detects: clones if remote has commits, inits + pushes if empty')
  .option('--git-branch <branch>', 'Working branch (default: develop)', 'develop')
  .option('--no-git', 'Skip git setup (workspace not under orchestrator git management — discouraged)')
  .action(async (name, opts) => {
    if (opts.git !== false && !opts.gitRemote) {
      console.error(chalk.red(
        `--git-remote <url> is required (or pass --no-git to opt out).\n` +
        `  This ensures every change made by the orchestrator is also on GitHub,\n` +
        `  not just on the host running the orchestrator.`,
      ));
      process.exit(1);
    }

    const { createProject } = await import('./commands/create-project.js');
    let result;
    try {
      result = await createProject({
        name,
        url: opts.git === false ? null : opts.gitRemote,
        branch: opts.gitBranch,
        tech: opts.tech || '',
        profile: opts.profile || null,
        noGit: opts.git === false,
        onProgress: (line) => console.log(chalk.dim(`  ${line}`)),
      });
    } catch (e) {
      console.error(chalk.red(`✗ ${e.message}`));
      process.exit(1);
    }

    console.log(chalk.green(`\n✓ Created project: ${result.projDir}`));
    if (result.mode === 'imported') {
      console.log(chalk.dim(`  Mode:      imported from git (cloned)`));
      console.log(chalk.dim(`  Files:     ${result.fileCount ?? '(unknown)'}`));
    } else if (result.mode === 'greenfield') {
      console.log(chalk.dim(`  Mode:      greenfield (initialized + pushed)`));
    } else {
      console.log(chalk.dim(`  Mode:      no-git (local only)`));
    }
    if (result.branch) console.log(chalk.dim(`  Branch:    ${result.branch}`));
    if (result.remote) console.log(chalk.dim(`  Remote:    ${result.remote}`));
    if (result.mode !== 'no-git' && !result.pushed) {
      console.log(chalk.yellow(`  ⚠ Initial push did not complete — investigate and push manually`));
    }
    console.log(`\nNext: drop .guide/brief.md, then: npm run go -- ${name}`);
  });

// ─── git management (v0.13) ────────────────────────────────────────────────

program.command('migrate-git').description('Bring an existing project under orchestrator git management')
  .requiredOption('--project <name>', 'Project name')
  .option('--branch <branch>', 'Working branch (default: develop)', 'develop')
  .option('--remote <url>', 'Set origin remote URL (only used if not already set)')
  .option('--init', 'Run `git init` if the workspace is not a repo yet')
  .action(async (opts) => {
    const { migrateGit } = await import('./commands/migrate-git.js');
    try {
      await migrateGit({ projectName: opts.project, branch: opts.branch, remote: opts.remote, init: opts.init });
    } catch (e) {
      console.error(chalk.red(`✗ ${e.message}`));
      process.exit(1);
    }
  });

program.command('ship <project>').description('Promote develop → main (fast-forward only)')
  .option('--target <branch>', 'Target branch (default: main)', 'main')
  .option('--tag <tag>', 'Create + push an annotated tag at the new HEAD (e.g. v0.3.1)')
  .option('--skip-gate', 'Bypass the deterministic secret/dependency/license ship gate (loud warning)')
  .action(async (projectName, opts) => {
    const { shipProject } = await import('./commands/ship.js');
    const result = await shipProject({ projectName, target: opts.target, tag: opts.tag, skipGate: opts.skipGate === true });
    if (!result.ok) {
      console.error(chalk.red(`✗ ${result.error}`));
      process.exit(1);
    }
  });

program.command('git-status <project>').description('Show workspace git state for a project')
  .action(async (projectName) => {
    const { getGitStatus, renderGitStatusCli } = await import('./commands/git-status.js');
    const s = await getGitStatus(projectName);
    process.stdout.write(renderGitStatusCli(s));
    if (!s.ok) process.exit(1);
  });

program.command('sync <project>').description('Pull latest from origin into the workspace (fast-forward only)')
  .action(async (projectName) => {
    const proj = getProject(projectName);
    if (!proj) {
      console.error(chalk.red(`Project not found: ${projectName}`));
      process.exit(1);
    }
    if (!proj.git_branch) {
      console.error(chalk.red(`Project '${projectName}' is not under git management.`));
      console.error(chalk.yellow(`Run: npm run migrate-git -- --project ${projectName}`));
      process.exit(1);
    }
    const workspaceDir = path.join(PROJECTS_DIR, projectName, 'workspace');
    const { syncWithRemote } = await import('./lib/git.js');
    const result = await syncWithRemote(workspaceDir, { branch: proj.git_branch });
    if (!result.ok) {
      console.error(chalk.red(`✗ Sync failed (${result.action}):`));
      console.error(result.error);
      process.exit(1);
    }
    switch (result.action) {
      case 'noop':
        console.log(chalk.green(`✓ ${projectName} already in sync with origin/${proj.git_branch}`));
        break;
      case 'pulled':
        console.log(chalk.green(`✓ Pulled ${result.behind} commit(s) from origin/${proj.git_branch}`));
        break;
      case 'ahead-only':
        console.log(chalk.yellow(`ℹ ${projectName} has ${result.ahead} unpushed commit(s) on ${proj.git_branch} — push or run a phase to publish them`));
        break;
      case 'no-upstream':
        console.log(chalk.dim(`(no upstream tracking yet for ${proj.git_branch})`));
        break;
      default:
        console.log(chalk.dim(`(${result.action})`));
    }
  });

program.command('sync-all').description('Pull latest from origin for every git-managed project (fast-forward only)')
  .action(async () => {
    const projects = listProjects().filter(p => p.git_branch);
    if (projects.length === 0) {
      console.log(chalk.yellow('No git-managed projects found.'));
      return;
    }
    const { syncWithRemote } = await import('./lib/git.js');
    let pulled = 0, noop = 0, failed = 0;
    for (const proj of projects) {
      const workspaceDir = path.join(PROJECTS_DIR, proj.name, 'workspace');
      const result = await syncWithRemote(workspaceDir, { branch: proj.git_branch });
      const label = chalk.cyan(proj.name.padEnd(20));
      if (!result.ok) {
        console.log(`${label} ${chalk.red(`✗ ${result.action}: ${result.error}`)}`);
        failed++;
      } else {
        switch (result.action) {
          case 'noop':
            console.log(`${label} ${chalk.green('✓ up to date')}`);
            noop++;
            break;
          case 'pulled':
            console.log(`${label} ${chalk.green(`✓ pulled ${result.behind} commit(s)`)}`);
            pulled++;
            break;
          case 'ahead-only':
            console.log(`${label} ${chalk.yellow(`ℹ ${result.ahead} unpushed commit(s)`)}`);
            noop++;
            break;
          case 'no-upstream':
            console.log(`${label} ${chalk.dim('(no upstream yet)')}`);
            noop++;
            break;
          default:
            console.log(`${label} ${chalk.dim(result.action)}`);
            noop++;
        }
      }
    }
    const summary = [
      pulled > 0 ? chalk.green(`${pulled} pulled`) : null,
      noop > 0 ? chalk.dim(`${noop} already in sync`) : null,
      failed > 0 ? chalk.red(`${failed} failed`) : null,
    ].filter(Boolean).join(', ');
    console.log(chalk.bold(`\nSync complete — ${summary}`));
    if (failed > 0) process.exit(1);
  });

// ─── guide / next / review / handoff / qa ──────────────────────────────────

program.command('guide <project>').description('Invoke guide agent')
  .option('--task <type>', 'plan | next-prompt | review | handoff | bug-plan | fix-prompt | workspace-claude-md', 'next-prompt')
  .option('--brief <text>', 'Project brief')
  .option('--round <n>', 'Round number', parseInt)
  .option('--fix <n>', 'Fix number', parseInt)
  .action(async (projectName, opts) => {
    const fix = (opts.round && opts.fix) ? { round: opts.round, n: opts.fix } : null;
    const result = await runGuide({ projectName, task: opts.task, brief: opts.brief, round: opts.round, fix });
    if (opts.task === 'plan' && !result.is_error) {
      try {
        const projDir = path.join(PROJECTS_DIR, projectName);
        const plan = JSON.parse(await fs.readFile(planJsonPath(projDir), 'utf-8'));
        const n = plan?.phases?.length || 0;
        const maxN = n > 0 ? plan.phases[n - 1].n : 0;
        resetProjectForNewPlan(projectName, maxN);
        await archiveSupersededPhases(path.join(PROJECTS_DIR, projectName), plan);
        console.log(chalk.cyan(`  ↺ Reset to phase 0 for new plan (${n} phases). Run 'npm run go -- ${projectName}' to start.`));
      } catch { /* non-fatal */ }
    }
    console.log(chalk.green(`\nDone (session: ${result.session_id})`));
  });

program.command('repair').description('Sync DB state with plan.json for all projects (fixes total_phases drift, status stuck at ready-for-qa after plan extension)')
  .action(async () => {
    const { repairProjectStates } = await import('./lib/state-repair.js');
    const { repairs, warnings } = await repairProjectStates({ verbose: true });
    if (repairs.length === 0 && warnings.length === 0) {
      console.log(chalk.green('All projects consistent — nothing to repair.'));
    }
  });

program.command('next <project>').description('Run the next dev phase').action(async (projectName) => {
  const result = await runDev({ projectName });
  console.log(result.is_error
    ? chalk.red(`\nPhase reported errors: ${result.result?.slice(0, 200)}`)
    : chalk.green(`\nPhase complete (session: ${result.session_id})`));
});

program.command('review <project>').description('Force a guide review now').action(async (projectName) => {
  const result = await runGuide({ projectName, task: 'review' });
  console.log(chalk.green(`\nReview written (session: ${result.session_id})`));
});

program.command('handoff <project>').description('Force guide handoff').action(async (projectName) => {
  const hRes = await runGuide({ projectName, task: 'handoff' });
  if (hRes?.is_error) {
    console.error(chalk.red(`✗ Handoff failed: ${(hRes.error_message || hRes.result || 'guide error').toString().slice(0, 300)}`));
    process.exit(1);
  }
  setGuideSessionId(projectName, null);
  console.log(chalk.green('Guide session reset.'));
});

program.command('claude-md <project>').description('Generate workspace/CLAUDE.md for an existing project')
  .action(async (projectName) => {
    const wRes = await runGuide({ projectName, task: 'workspace-claude-md' });
    if (wRes?.is_error) console.warn(chalk.yellow(`⚠ workspace-claude-md generation failed (non-fatal): ${(wRes.error_message || wRes.result || '').toString().slice(0, 200)}`));
    console.log(chalk.green('workspace/CLAUDE.md generation complete (or skipped if existing).'));
  });

// ─── discuss ────────────────────────────────────────────────────────────────

program.command('discuss <project> [topic]')
  .description('Run a multi-agent discussion panel, update brief, then auto-start dev')
  .option('--mode <mode>', 'Team size: auto (3-5 agents), medium (5-7), max (8-12)', 'auto')
  .option('--list', 'List previous discussions for this project')
  .option('--inspect <id>', 'Inspect a specific discussion: agents, rounds, conclusions')
  .action(async (project, topic, opts) => {
    const { runDiscussion } = await import('./lib/discussion-engine.js');
    const { getProject, listDiscussions, getDiscussion, getDiscAgents, getDiscMessages, getDiscConclusion } = await import('./state.js');
    const chalk = (await import('chalk')).default;

    const proj = getProject(project);
    if (!proj) {
      console.error(chalk.red(`Project not found: ${project}`));
      process.exit(1);
    }

    // ── list ──────────────────────────────────────────────────────────────────
    if (opts.list) {
      const discussions = listDiscussions(project, 20);
      if (!discussions.length) {
        console.log(chalk.dim(`No discussions yet for ${project}`));
        return;
      }
      console.log(chalk.bold(`\nDiscussions for ${project}:\n`));
      for (const d of discussions) {
        const statusColor = d.status === 'done' ? chalk.green : d.status === 'failed' ? chalk.red : chalk.yellow;
        console.log(`  #${d.id}  ${statusColor(d.status.padEnd(12))}  ${chalk.dim(d.created_at.slice(0, 16))}  [${d.mode}/${d.rounds_planned}r]  ${d.topic}`);
      }
      console.log(chalk.dim(`\n  Use --inspect <id> to see agents and conclusions for a discussion.`));
      return;
    }

    // ── inspect ───────────────────────────────────────────────────────────────
    if (opts.inspect) {
      const id = parseInt(opts.inspect, 10);
      const disc = getDiscussion(id);
      if (!disc || disc.project !== project) {
        console.error(chalk.red(`Discussion #${id} not found for project ${project}`));
        process.exit(1);
      }

      const statusColor = disc.status === 'done' ? chalk.green : disc.status === 'failed' ? chalk.red : chalk.yellow;

      console.log(chalk.bold.cyan(`\n╔══════════════════════════════════════╗`));
      console.log(chalk.bold.cyan(`║        Discussion #${String(id).padEnd(17)}║`));
      console.log(chalk.bold.cyan(`╚══════════════════════════════════════╝\n`));
      console.log(`  Project : ${chalk.bold(disc.project)}`);
      console.log(`  Topic   : ${chalk.bold(disc.topic)}`);
      console.log(`  Mode    : ${disc.mode}  (${disc.rounds_planned} rounds)`);
      console.log(`  Status  : ${statusColor(disc.status)}`);
      console.log(`  Created : ${chalk.dim(disc.created_at)}`);
      if (disc.completed_at) console.log(`  Done    : ${chalk.dim(disc.completed_at)}`);

      // Agents / roster
      const agents = getDiscAgents(id);
      if (agents.length) {
        console.log(chalk.bold(`\n  Agents (${agents.length}):\n`));
        for (const a of agents) {
          console.log(`  ${chalk.cyan('◆')} ${chalk.bold(a.role)}  ${chalk.dim(`[${a.agent_key}]`)}`);
          console.log(`      Expertise : ${a.expertise}`);
          console.log(`      Mission   : ${a.mission}`);
          console.log(`      Session   : ${a.session_id ? chalk.dim(a.session_id.slice(0, 12) + '…') : chalk.dim('(none)')}`);
          console.log('');
        }
      } else {
        console.log(chalk.dim('\n  No agents recorded yet.\n'));
      }

      // Round summary
      for (let r = 1; r <= disc.rounds_planned; r++) {
        const msgs = getDiscMessages(id, r);
        if (!msgs.length) continue;
        console.log(chalk.bold(`  Round ${r}  (${msgs.length}/${agents.length} agents responded):`));
        for (const m of msgs) {
          const agent = agents.find((a) => a.agent_key === m.agent_key);
          const preview = m.content.split('\n').find((l) => l.trim() && !l.startsWith('#')) || '';
          console.log(`    ${chalk.cyan('›')} ${chalk.bold(agent?.role || m.agent_key)}  ${chalk.dim(preview.slice(0, 80) + (preview.length > 80 ? '…' : ''))}`);
        }
        console.log('');
      }

      // Conclusion
      const conclusion = getDiscConclusion(id);
      if (conclusion) {
        let synth;
        try { synth = JSON.parse(conclusion.synthesis); } catch { synth = null; }
        if (synth?.top_recommendations?.length) {
          console.log(chalk.bold('  Top Recommendations:\n'));
          for (const rec of synth.top_recommendations.slice(0, 5)) {
            console.log(`  ${chalk.bold(`${rec.rank}.`)} ${chalk.green(rec.title)}`);
            console.log(`      ${chalk.dim(rec.description)}`);
            console.log(`      Cost: ${rec.cost}  ·  Effort: ${rec.effort}  ·  Confidence: ${Math.round((rec.confidence || 0) * 100)}%\n`);
          }
        }
        if (synth?.rejected?.length) {
          console.log(chalk.bold('  Rejected:\n'));
          for (const r of synth.rejected) {
            console.log(`    ${chalk.red('✗')} ${r.proposal}  ${chalk.dim('— ' + r.reason)}`);
          }
          console.log('');
        }
        if (synth?.open_questions?.length) {
          console.log(chalk.bold('  Open Questions:\n'));
          for (const q of synth.open_questions) console.log(`    ${chalk.yellow('?')} ${q}`);
          console.log('');
        }
      } else {
        console.log(chalk.dim('  No conclusion yet.\n'));
      }

      console.log(chalk.dim(`  Files: projects/${project}/.guide/discussions/${id}/`));
      return;
    }

    // ── run ───────────────────────────────────────────────────────────────────
    if (!topic) {
      console.error(chalk.red('Topic required. Usage: ashmero discuss <project> "<topic>" [--mode auto|medium|max]'));
      console.error(chalk.dim('  Or use --list to see past discussions, --inspect <id> to review one.'));
      process.exit(1);
    }

    const validModes = ['auto', 'medium', 'max'];
    if (!validModes.includes(opts.mode)) {
      console.error(chalk.red(`Invalid mode: ${opts.mode}. Choose: auto, medium, max`));
      process.exit(1);
    }

    console.log(chalk.bold.cyan('\n╔══════════════════════════════════════╗'));
    console.log(chalk.bold.cyan('║      Multi-Agent Discussion Panel     ║'));
    console.log(chalk.bold.cyan('╚══════════════════════════════════════╝\n'));
    console.log(`  Project : ${chalk.bold(project)}`);
    console.log(`  Topic   : ${chalk.bold(topic)}`);
    console.log(`  Mode    : ${chalk.bold(opts.mode)}`);
    console.log('');

    try {
      const { discId, conclusion } = await runDiscussion({ projectName: project, topic, mode: opts.mode });

      console.log(chalk.bold.green('\n╔══════════════════════════════════════╗'));
      console.log(chalk.bold.green('║           Discussion Complete         ║'));
      console.log(chalk.bold.green('╚══════════════════════════════════════╝\n'));

      for (const r of (conclusion.top_recommendations || []).slice(0, 3)) {
        console.log(`  ${chalk.bold(`${r.rank}.`)} ${chalk.cyan(r.title)}`);
        console.log(`     Cost: ${r.cost} · Effort: ${r.effort} · Confidence: ${Math.round((r.confidence || 0) * 100)}%`);
        console.log(`     ${chalk.dim(r.description)}\n`);
      }
      if (conclusion.open_questions?.length) {
        console.log(chalk.yellow('  Open questions:'));
        for (const q of conclusion.open_questions) console.log(`    • ${q}`);
        console.log('');
      }
      console.log(chalk.dim(`  Brief updated. Inspect: ashmero discuss ${project} --inspect ${discId}`));
    } catch (err) {
      console.error(chalk.red(`\n  Discussion failed: ${err.message}`));
      if (process.env.DEBUG) console.error(err);
      process.exit(1);
    }
  });

// ─── suggest ────────────────────────────────────────────────────────────────

program.command('suggest <project>')
  .description('Scan a project and generate an interactive suggestions plan')
  .option('--rerun', 'Re-scan even if an accepted plan already exists')
  .option('--force', 'Re-scan and skip the "use existing" prompt')
  .option('--no-lm', 'Use the built-in rules engine (skips Claude call, no billing, deterministic output)')
  .action(async (project, opts) => {
    const { suggestProject } = await import('./commands/suggest.js');
    const result = await suggestProject(project, {
      rerun: !!opts.rerun,
      force: !!opts.force,
      noLm:  !opts.lm,
    });
    if (result?.error)     process.exit(1);
    if (result?.cancelled) process.exit(0);
  });

program.command('suggest-status <project>')
  .description('Print the current accepted suggestions plan (non-interactive)')
  .action(async (project) => {
    const { getLatestSuggestions } = await import('./state.js');
    const row = getLatestSuggestions(project);
    if (!row || row.status !== 'accepted') {
      console.log(`No accepted suggestions plan for "${project}".`);
      return;
    }
    const selected  = JSON.parse(row.selected_json  || '[]');
    const plan      = JSON.parse(row.pipeline_plan_json || '{}');
    const passes    = row.pipeline_passes;
    console.log(`\nAccepted plan — ${project} (${passes} pass${passes > 1 ? 'es' : ''}, ${selected.length} items)`);
    console.log(`Generated: ${row.generated_at}\n`);
    for (let p = 1; p <= passes; p++) {
      const ids    = plan[String(p)] || [];
      const titles = ids.map(id => selected.find(s => s.id === id)?.title ?? id);
      console.log(`  Pass ${p}: ${titles.join(', ')}`);
    }
  });

program.command('qa <project>').description('Mark project ready-for-qa or shipped')
  .option('--shipped', 'Mark as completed').action(async (projectName, opts) => {
    setProjectStatus(projectName, opts.shipped ? 'completed' : 'ready-for-qa');
    console.log(chalk.green(`Project ${projectName} status updated.`));
  });

// ─── autopilot (Phase 85 — Portfolio autopilot P7a) ─────────────────────────
const autopilotCmd = program.command('autopilot').description('Portfolio autopilot controls');
autopilotCmd.command('approve <project> <action>')
  .description('Grant a standing, expiring approval for an autopilot action (default: one night)')
  .option('--nights <n>', 'Number of nights this approval stays valid (default 1)', (v) => parseInt(v, 10))
  .option('--until <ts>', 'ISO timestamp after which the approval expires')
  .action(async (project, action, opts) => {
    const { approveAutopilotAction } = await import('./commands/autopilot.js');
    await approveAutopilotAction({
      project,
      action,
      nights: opts.nights != null ? opts.nights : null,
      until: opts.until || null,
    });
  });

// ─── package / upgrade-project (v0.5.1) ────────────────────────────────────

program.command('package <project>').description('Zip a project for download/sharing (excludes node_modules, .env, etc.)')
  .option('--no-git', 'Strip .git directory from the zip')
  .option('--output-dir <dir>', 'Where to write the zip (default: outputs/)')
  .option('--skip-gate', 'Bypass the deterministic secret/dependency/license ship gate (loud warning)')
  .action(async (projectName, opts) => {
    const { packageProject } = await import('./commands/package-project.js');
    const result = await packageProject({
      projectName,
      includeGit: opts.git !== false,
      outputDir: opts.outputDir || null,
      skipGate: opts.skipGate === true,
    });
    console.log(chalk.dim(`\nShare: ${result.path}`));
  });

program.command('upgrade-project <project>').description('Bring an existing project up to current conventions (idempotent)')
  .option('--dry-run', 'Show what would change, do nothing')
  .option('--generate-claude-md', 'If workspace/CLAUDE.md is missing, generate it (spawns Sonnet call)')
  .action(async (projectName, opts) => {
    const { upgradeProject } = await import('./commands/upgrade-project.js');
    await upgradeProject({
      projectName,
      generateClaudeMd: !!opts.generateClaudeMd,
      dryRun: !!opts.dryRun,
    });
  });

// ─── v0.6 commands ────────────────────────────────────────────────────────

program.command('retry-phase <project> <phase>').description('Reset a phase to pending and revert workspace to its parent commit')
  .option('--force', 'Skip confirmation prompt')
  .option('--keep-prompt-report', 'Keep .guide/phases/NN-*/prompt.md and report.md (default: delete them)')
  .option('--dry-run', 'Show what would happen, do nothing')
  .action(async (projectName, phaseStr, opts) => {
    const { retryPhase } = await import('./commands/retry-phase.js');
    await retryPhase({
      projectName,
      phaseN: parseInt(phaseStr, 10),
      force: !!opts.force,
      keepPromptReport: !!opts.keepPromptReport,
      dryRun: !!opts.dryRun,
    });
  });

program.command('inspect <project> <phase>').description('Show phase report + commit diff side-by-side')
  .option('--diff-only', 'Skip the report, show only the diff')
  .option('--report-only', 'Skip the diff, show only the report')
  .option('--stat-only', 'Show only file change stats, no content')
  .option('--full-diff', 'Include full diff output (default: stats only, run with --full-diff for content)')
  .action(async (projectName, phaseStr, opts) => {
    const { inspectPhase } = await import('./commands/inspect-phase.js');
    await inspectPhase({
      projectName,
      phaseN: parseInt(phaseStr, 10),
      diffOnly: !!opts.diffOnly,
      reportOnly: !!opts.reportOnly,
      statOnly: !!opts.statOnly,
      fullDiff: !!opts.fullDiff,
    });
  });

program.command('dashboard').description('Generate a self-contained HTML dashboard of orchestrator telemetry')
  .option('--output <path>', 'Where to write the HTML (default: outputs/dashboard-<ts>.html)')
  .action(async (opts) => {
    const { generateDashboard } = await import('./commands/dashboard.js');
    await generateDashboard({ outputPath: opts.output });
  });

program.command('cleanup').description('Prune old logs, dashboards, and call rows per config.cleanup')
  .option('--dry-run', 'Show what would be deleted without deleting')
  .option('--verbose', 'Print stats even when nothing was deleted')
  .action(async (opts) => {
    const { runCleanup } = await import('./lib/log-cleanup.js');
    const cfg = await resolveConfig({ task: 'dev-execution' });
    const stats = await runCleanup(cfg, { dryRun: !!opts.dryRun, verbose: true });
    if (stats.skipped) {
      console.log(chalk.dim(stats.reason));
    } else if (!stats.logs_deleted && !stats.outputs_deleted && !stats.calls_pruned) {
      console.log(chalk.green('Nothing to clean.'));
    }
  });

program.command('budget <project>').description('Show project lifetime budget usage')
  .action(async (projectName) => {
    const { projectCallCount, projectCallCost, getProjectCallCap } = await import('./commands/budget-guard.js');
    const cfg = await resolveConfig({ project: projectName, task: 'dev-execution' });
    const calls = projectCallCount(projectName);
    const cost = projectCallCost(projectName);
    const cap = getProjectCallCap(cfg, projectName);
    console.log(chalk.bold(`\nBudget for ${projectName}`));
    console.log(`  Lifetime calls: ${chalk.bold(calls)}${cap ? ` / ${cap} cap` : ' (no cap)'}`);
    console.log(`  Equiv cost:     $${cost.toFixed(2)}`);
    if (cap) {
      const pct = ((calls / cap) * 100).toFixed(1);
      const color = pct >= 90 ? chalk.red : pct >= 75 ? chalk.yellow : chalk.green;
      console.log(`  Used:           ${color(pct + '%')}`);
    }
    if (!cap) {
      console.log(chalk.dim('\n  To set a cap, edit projects/' + projectName + '/project.json:'));
      console.log(chalk.dim('    "overrides": { "budget": { "max_total_calls": 100 } }'));
    }
  });

program.command('retro <project>').description('Aggregate telemetry into a dated config-tuning proposals report (docs/retro/)')
  .option('--days <n>', 'Trailing window in days (default: 14)')
  .action(async (projectName, opts) => {
    const { runRetrospective, DEFAULT_WINDOW_DAYS } = await import('./commands/retro.js');
    const days = opts.days ? Number(opts.days) : DEFAULT_WINDOW_DAYS;
    const { reportPath, aggregate, skippedGuideCall } = await runRetrospective({ projectName, days });
    console.log(chalk.green(`✓ Retrospective written: ${path.relative(REPO_ROOT, reportPath)}`));
    if (skippedGuideCall) {
      console.log(chalk.dim(`  (no calls/heals/phase activity in the trailing ${aggregate.window_days}d window — guide call skipped)`));
    }
  });


// ─── go / resume / abort ───────────────────────────────────────────────────

program.command('predict <project>').description('Predict cost of upcoming work without making any calls')
  .option('--compact', 'Summary only — no per-unit breakdown')
  .action(async (projectName, opts) => {
    const { predictUpcoming, renderPrediction } = await import('./commands/predict.js');
    const prediction = await predictUpcoming(projectName);
    console.log(renderPrediction(prediction, { compact: !!opts.compact }));
    console.log();
    const { getNextActions, renderNextActionsCli } = await import('./lib/next-actions.js');
    const actions = getNextActions({
      project: projectName,
      lastAction: prediction.mode === 'bug-round' ? 'bug-round-complete' : 'plan',
      state: { bugRoundComplete: prediction.bugRound },
    });
    process.stdout.write(renderNextActionsCli(actions));
  });

program.command('validate <project>').description('Run external validators against current workspace state')
  .option('--phase <n>', 'Run validators as if phase <n> just completed')
  .option('--fix <round.n>', 'Run validators as if a fix completed (format: "4.2")')
  .option('--all', 'Run all validators regardless of rules (matches rule {always:true})')
  .action(async (projectName, opts) => {
    const { runValidators } = await import('./lib/validators.js');
    const event = {};
    if (opts.phase) event.phase = Number(opts.phase);
    if (opts.fix) {
      const [round, n] = opts.fix.split('.').map(Number);
      event.fixRound = round; event.fixN = n;
    }
    if (opts.all) event.phase = 'any'; // forces match against {always:true} rules anyway
    const outcome = await runValidators({ projectName, event });
    if (outcome.skipped) console.log(chalk.dim(`Skipped: ${outcome.skipped}`));
    if (outcome.hasFailures) process.exitCode = 1;
  });

program.command('validators <project>').description('Show recent validator runs for a project')
  .option('--limit <n>', 'Max rows to show', '20')
  .action(async (projectName, opts) => {
    const { getRecentValidatorRuns } = await import('./lib/validators.js');
    const rows = getRecentValidatorRuns(projectName, Number(opts.limit));
    if (!rows.length) { console.log(chalk.dim('No validator runs recorded.')); return; }
    console.log(chalk.bold(`\nRecent validator runs — ${projectName}\n`));
    for (const r of rows) {
      const sym = r.status === 'pass' ? chalk.green('✓') : chalk.red('✗');
      const where = r.phase != null ? `phase ${r.phase}`
        : r.fix_round != null ? `fix r${r.fix_round}.${r.fix_n}`
        : '?';
      const dur = r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : '?';
      console.log(`  ${sym} ${chalk.bold(r.validator_name.padEnd(20))} ${chalk.dim(where.padEnd(14))} ${chalk.dim(dur.padStart(6))}  ${chalk.dim(r.started_at)}`);
      if (r.status === 'fail' && r.stderr_excerpt) {
        const tail = r.stderr_excerpt.split('\n').slice(-3).join('\n').trim();
        if (tail) console.log(chalk.dim('    ' + tail.split('\n').join('\n    ')));
      }
    }
    console.log();
  });

program.command('qa-handoff <project>').description('Generate a tester-friendly QA handoff markdown from a bug round or phase range')
  .option('--round <n>', 'Bug round number (default: most recent)')
  .option('--phases <range>', 'Phase range as "START:END" (e.g., "1:8")')
  .option('--with-steps', 'Use Opus to generate plain-tester manual test procedures (one batched API call)')
  .option('--output <path>', 'Override output path')
  .action(async (projectName, opts) => {
    const { generateQaHandoff } = await import('./commands/qa-handoff.js');
    const args = {
      withSteps: !!opts.withSteps,
      outputPath: opts.output || null,
    };
    if (opts.round) args.round = Number(opts.round);
    if (opts.phases) {
      const [start, end] = String(opts.phases).split(':').map(Number);
      args.phaseStart = start;
      args.phaseEnd = end;
    }
    const result = await generateQaHandoff(projectName, args);
    const { getNextActions, renderNextActionsCli } = await import('./lib/next-actions.js');
    const actions = getNextActions({
      project: projectName,
      lastAction: 'qa-handoff',
      state: { bugRoundComplete: args.round },
    });
    process.stdout.write(renderNextActionsCli(actions));
  });

program.command('go <project>').description('Auto-run plan → phases → reviews → completion')
  .option('--unattended', 'Skip checkpoints')
  .option('--dry-run', 'Print plan, do nothing')
  .option('--brief <text>', 'Brief override')
  .option('--no-predict', 'Skip the pre-flight cost prediction')
  .option('--yes', 'Skip the y/n confirmation if prediction exceeds threshold')
  .option('--slot <n>', 'Suggestions plan slot to inject into the guide prompt (default: cursor)')
  .option('--skip-suggest', 'Skip the suggestions gate and run immediately')
  .option('--advance', 'Advance to the next multi-pass suggestions slot (archives plan.json and starts a fresh plan task)')
  .action(async (projectName, opts) => {
    const projDir = path.join(PROJECTS_DIR, projectName);

    for (const row of sweepInterruptedAutoRuns()) {
      console.log(chalk.dim(`[crash-recovery] auto_run ${row.id} (${row.project}) marked interrupted — orchestrator crashed or was killed mid-run`));
    }

    if (opts.slot !== undefined) {
      const parsed = parseInt(opts.slot, 10);
      if (!Number.isInteger(parsed) || parsed < 1) {
        console.error(chalk.red(`Error: --slot must be a positive integer (got: ${JSON.stringify(opts.slot)})`));
        return;
      }
    }

    const { requestedSlot, effectiveSlot, pendingAdvance } = await resolveSuggestionSlot(projectName, projDir, {
      slotExplicit: opts.slot !== undefined,
      slotParsed:   opts.slot !== undefined ? parseInt(opts.slot, 10) : null,
      advance:      !!opts.advance,
    });

    // ── Suggest gate — runs before prediction so user has full control ────────
    let planReplaced = false;
    if (!opts.skipSuggest && !opts.unattended) {
      const { suggestGate } = await import('./commands/suggest.js');
      const gateResult = await suggestGate(projectName, projDir, requestedSlot);
      const proceed = gateResult.proceed;
      planReplaced = gateResult.planReplaced;
      if (!proceed) return; // pendingAdvance NOT committed — cursor + plan files untouched
    }

    let brief = opts.brief;
    if (!brief) {
      const bp = briefPath(projDir);
      if (await fileExists(bp)) brief = await fs.readFile(bp, 'utf-8');
    }

    // Pre-flight cost prediction (v0.9)
    if (opts.predict !== false) {
      try {
        const { predictUpcoming, renderPrediction, confirmPrediction } = await import('./commands/predict.js');
        const prediction = await predictUpcoming(projectName);
        if (prediction.mode !== 'idle') {
          console.log(renderPrediction(prediction));
          const ok = await confirmPrediction(prediction, { autoYes: !!opts.yes || !!opts.unattended });
          if (!ok) { console.log(chalk.yellow('Aborted by user.')); return; } // pendingAdvance NOT committed
        }
      } catch (err) {
        console.log(chalk.dim(`(prediction skipped: ${err.message})`));
      }
    }

    // Both gates cleared — commit the advance now so decideNextAction dispatches
    // a fresh plan task on this run rather than re-running the completed pass.
    // Skip if the gate replaced the accepted plan: the fresh plan's own cursor wins.
    if (pendingAdvance && !planReplaced) await commitAdvance(projectName, pendingAdvance);

    await autoRun({
      projectName,
      unattended: !!opts.unattended,
      dryRun:     !!opts.dryRun,
      brief,
      slot: effectiveSlot,
    });
  });

program.command('resume <project>').description('Resume auto-runner')
  .option('--unattended', 'Skip checkpoints')
  .option('--no-predict', 'Skip the pre-flight cost prediction')
  .option('--yes', 'Skip the y/n confirmation')
  .option('--slot <n>', 'Suggestions plan slot to inject into the guide prompt (default: cursor)')
  .option('--skip-suggest', 'Skip the suggestions gate and resume immediately')
  .option('--advance', 'Advance to the next multi-pass suggestions slot (archives plan.json and starts a fresh plan task)')
  .action(async (projectName, opts) => {
    const projDir = path.join(PROJECTS_DIR, projectName);

    for (const row of sweepInterruptedAutoRuns()) {
      console.log(chalk.dim(`[crash-recovery] auto_run ${row.id} (${row.project}) marked interrupted — orchestrator crashed or was killed mid-run`));
    }

    const last = getLastAutoRun(projectName);
    if (last) console.log(chalk.dim(`Last run: ${last.status} — ${last.pause_reason || '(no reason)'}`));

    if (opts.slot !== undefined) {
      const parsed = parseInt(opts.slot, 10);
      if (!Number.isInteger(parsed) || parsed < 1) {
        console.error(chalk.red(`Error: --slot must be a positive integer (got: ${JSON.stringify(opts.slot)})`));
        return;
      }
    }

    const { requestedSlot, effectiveSlot, pendingAdvance } = await resolveSuggestionSlot(projectName, projDir, {
      slotExplicit: opts.slot !== undefined,
      slotParsed:   opts.slot !== undefined ? parseInt(opts.slot, 10) : null,
      advance:      !!opts.advance,
    });

    // ── Suggest gate ─────────────────────────────────────────────────────────
    let planReplaced = false;
    if (!opts.skipSuggest && !opts.unattended) {
      const { suggestGate } = await import('./commands/suggest.js');
      const gateResult = await suggestGate(projectName, projDir, requestedSlot);
      const proceed = gateResult.proceed;
      planReplaced = gateResult.planReplaced;
      if (!proceed) return; // pendingAdvance NOT committed — cursor + plan files untouched
    }

    if (opts.predict !== false) {
      try {
        const { predictUpcoming, renderPrediction, confirmPrediction } = await import('./commands/predict.js');
        const prediction = await predictUpcoming(projectName);
        if (prediction.mode !== 'idle') {
          console.log(renderPrediction(prediction));
          const ok = await confirmPrediction(prediction, { autoYes: !!opts.yes || !!opts.unattended });
          if (!ok) { console.log(chalk.yellow('Aborted by user.')); return; } // pendingAdvance NOT committed
        }
      } catch (err) {
        console.log(chalk.dim(`(prediction skipped: ${err.message})`));
      }
    }

    // Both gates cleared — commit the advance now.
    // Skip if the gate replaced the accepted plan: the fresh plan's own cursor wins.
    if (pendingAdvance && !planReplaced) await commitAdvance(projectName, pendingAdvance);

    await autoRun({ projectName, unattended: !!opts.unattended, slot: effectiveSlot });
  });

program.command('abort <project>').description('Mark current auto-run as aborted').action(async (projectName) => {
  const active = getActiveAutoRun(projectName);
  if (!active) { console.log(chalk.yellow('No active auto-run.')); return; }

  // Mirror the web-UI abort route: actually STOP the owning process rather than
  // only flipping a DB flag. The auto-run loop never re-reads project.status
  // mid-run — it only reacts to SIGINT on its own process — so a bare status
  // flip left the run burning tokens until it finished on its own.
  const { getRunningJobsForProject, requestJobCancellation } = await import('./server/job-queue.js');
  const queueJobs = getRunningJobsForProject(projectName);
  if (queueJobs.length > 0) {
    const cancelling = queueJobs
      .filter((job) => requestJobCancellation(job.id, 'cancelled via CLI abort'))
      .map((job) => job.id);
    console.log(chalk.yellow(`Requested cancellation for queue job(s) ${cancelling.join(', ')} (auto-run ${active.id}).`));
    return;
  }
  const owner = getRunningJob(projectName);
  if (owner?.pid && pidAlive(owner.pid)) {
    process.kill(owner.pid, 'SIGINT');
    console.log(chalk.yellow(`Sent SIGINT to auto-run owner PID ${owner.pid} (auto-run ${active.id}) — it will finalize gracefully.`));
    return;
  }
  // No live owner remains to signal — flip the DB flag directly.
  setProjectStatus(projectName, 'cancelled');
  console.log(chalk.yellow(`No live owner process; auto-run ${active.id} marked cancelled.`));
});

program.command('reset-brief <project>')
  .description('Copy inputs/brief.md → .guide/brief.md, archive old plan, reset phase counter')
  .option('--go',        'Start the full pipeline immediately after reset (unattended)')
  .option('--no-archive','Skip archiving the old brief and plan (destructive)')
  .action(async (project, opts) => {
    const { resetBrief } = await import('./commands/reset-brief.js');
    try {
      await resetBrief(project, { go: !!opts.go, noArchive: !opts.archive });
    } catch (err) {
      console.error(chalk.red(`reset-brief: ${err.message}`));
      process.exit(1);
    }
  });

// ─── analyze (NEW) ─────────────────────────────────────────────────────────

program.command('analyze <project>').description('Show complexity + model routing for every phase (no calls made)')
  .action(async (projectName) => {
    const projDir = path.join(PROJECTS_DIR, projectName);
    const plan = await readJson(planJsonPath(projDir));
    if (!plan) { console.error(chalk.red('No plan.json found. Run guide --task plan first.')); process.exit(1); }
    const cfg = await resolveConfig({ project: projectName, task: 'dev-execution' });
    const rows = await analyzeProject({ cfg, plan });

    console.log(chalk.bold.cyan(`\nRouting Analysis: ${projectName}`));
    console.log(chalk.dim(`Phases: ${rows.length}\n`));

    const widths = { n: 5, title: 38, comp: 10, tier: 8, model: 24 };
    const header = `${pad('Phase', widths.n)} ${pad('Title', widths.title)} ${pad('Complexity', widths.comp)} ${pad('Tier', widths.tier)} ${pad('Model', widths.model)}`;
    console.log(chalk.bold(header));
    console.log(chalk.dim('─'.repeat(header.length)));
    for (const r of rows) {
      const complexityColor = r.complexity === 'critical' ? chalk.red : r.complexity === 'high' ? chalk.yellow : r.complexity === 'medium' ? chalk.cyan : chalk.dim;
      const tierColor = r.tier === 'opus' ? chalk.magenta : r.tier === 'sonnet' ? chalk.cyan : chalk.dim;
      console.log(`${pad(String(r.n), widths.n)} ${pad(r.title, widths.title)} ${complexityColor(pad(r.complexity, widths.comp))} ${tierColor(pad(r.tier, widths.tier))} ${pad(r.model, widths.model)}${r.override ? chalk.dim(' (override)') : ''}`);
    }

    // Summary
    const opus = rows.filter((r) => r.tier === 'opus').length;
    const sonnet = rows.filter((r) => r.tier === 'sonnet').length;
    const haiku = rows.filter((r) => r.tier === 'haiku').length;
    console.log(chalk.dim(`\nTier distribution: opus ${opus}, sonnet ${sonnet}, haiku ${haiku}`));
    console.log(chalk.dim(`(Plus: ~1 plan call (opus), ~${rows.length} prompt-gen calls (sonnet), ~${Math.floor(rows.length / 3)} review calls (opus))`));
  });

// ─── brief / audit / roadmap (v0.4) ────────────────────────────────────────

program.command('context <project>').description('Generate or refresh .guide/project-context.md (injected as system-prompt prefix on every call for this project)')
  .option('--force', 'Overwrite existing project-context.md without prompting')
  .action(async (projectName, opts) => {
    const project = getProject(projectName);
    if (!project) { console.error(chalk.red(`Project not found: ${projectName}`)); process.exit(1); }
    const projDir = path.join(PROJECTS_DIR, projectName);
    const ctxPath = projectContextPath(projDir);
    if (await fileExists(ctxPath) && !opts.force) {
      console.log(chalk.yellow(`project-context.md already exists at:\n  ${ctxPath}`));
      console.log(chalk.dim('Re-run with --force to overwrite, or edit the file directly.'));
      process.exit(0);
    }
    console.log(chalk.dim('Generating project context (read brief, workspace, raw-thoughts)…'));
    const result = await runGuide({ projectName, task: 'project-context-gen' });
    if (result.is_error) {
      console.error(chalk.red('Generation failed:'), result.error_message || 'see logs');
      process.exit(1);
    }
    console.log(chalk.green(`\n✓ Wrote ${ctxPath}`));
    console.log(chalk.dim('Review and edit. The "Prompting Guidance" section is the highest leverage — make sure it captures project-specific gotchas the agent should know on every call.'));
  });

program.command('brief <project>').description('Author or refine .guide/brief.md from .guide/raw-thoughts.md')
  .action(async (projectName) => {
    const projDir = path.join(PROJECTS_DIR, projectName);
    const project = getProject(projectName);
    if (!project) { console.error(chalk.red(`Project not found: ${projectName}`)); process.exit(1); }
    const raw = await readJson(rawThoughtsPath(projDir)) || await fileExists(rawThoughtsPath(projDir));
    if (!raw) {
      console.log(chalk.yellow(`Drop your rough thoughts at:\n  ${rawThoughtsPath(projDir)}\nThen re-run.`));
      await fs.mkdir(path.dirname(rawThoughtsPath(projDir)), { recursive: true });
      if (!(await fileExists(rawThoughtsPath(projDir)))) {
        await fs.writeFile(rawThoughtsPath(projDir),
          '# Raw thoughts for ' + projectName + '\n\n' +
          '<!-- Drop bullet points, half-formed ideas, requirements as you think of them.\n' +
          '     The brief author will structure these into .guide/brief.md.\n' +
          '     Re-run `npm run brief -- ' + projectName + '` after each edit. -->\n\n' +
          '- \n');
      }
      process.exit(0);
    }
    const result = await runGuide({ projectName, task: 'brief-author' });
    console.log(chalk.green(`\n✓ Brief drafted at .guide/brief.md`));
    console.log(chalk.green(`✓ Questions at .guide/brief-questions.md`));
    console.log(chalk.dim('Review both. Edit raw-thoughts.md to refine. Re-run to iterate.'));
    console.log(chalk.dim('When happy: npm run go -- ' + projectName));
  });

program.command('audit <project>').description('Audit complete implementation for bugs, security, correctness')
  .option('--auto', 'After the audit, auto-promote findings to a bug round and run every fix unattended (stops only on a blocker)')
  .option('--chain', 'Alias for --auto')
  .option('--rounds <n>', 'Repeat the auto pipeline up to N times, re-auditing between rounds (default 1; max 10)', (v) => parseInt(v, 10))
  .action(async (projectName, opts) => {
    const project = getProject(projectName);
    if (!project) { console.error(chalk.red(`Project not found: ${projectName}`)); process.exit(1); }
    const projDir = path.join(PROJECTS_DIR, projectName);
    const plan = await readJson(planJsonPath(projDir));
    if (!plan) { console.error(chalk.red('No plan.json. Audit needs a completed project.')); process.exit(1); }

    console.log(chalk.cyan('Running comprehensive audit (Opus, heavy context)…'));
    // v0.14.40: same fix as the server chain (.39) — a failed audit must not
    // fall through to promote and die on the sentinel as "duplicate".
    const cliAudit = await runGuide({ projectName, task: 'audit' });
    if (cliAudit?.is_error) {
      console.error(chalk.red(`✗ Audit failed: ${(cliAudit.error_message || cliAudit.result || 'guide error').toString().slice(0, 300)}`));
      process.exit(1);
    }
    const auditFile = await findMostRecentAudit(projDir);
    console.log(chalk.green(`\n✓ Audit complete: ${auditFile ? path.relative(REPO_ROOT, auditFile) : '(see .guide/audits/)'}`));

    // --auto / --chain: promote findings → bugs round → run all fixes unattended,
    // repeatable up to --rounds N (re-auditing between rounds). Mirrors the
    // server-side pipeline in job-runner.js. Nothing is shipped to main.
    if (opts.auto || opts.chain) {
      const { promoteAuditToBugs } = await import('./lib/audit-promote.js');
      const { PAUSE_KINDS } = await import('./lib/pause-classifier.js');
      const CLEAN = new Set([PAUSE_KINDS.FIX_ROUND_COMPLETE, PAUSE_KINDS.ALL_PHASES_COMPLETE]);
      const maxRounds = Math.max(1, Math.min(10, Number(opts.rounds) || 1));
      let completed = 0;

      for (let i = 0; i < maxRounds; i++) {
        if (i > 0) {
          console.log(chalk.cyan(`\n🔁 Auto pipeline ${i + 1}/${maxRounds} — re-auditing…`));
          const cliReAudit = await runGuide({ projectName, task: 'audit' });
          if (cliReAudit?.is_error) {
            console.error(chalk.red(`⏹  Pipeline stopped — audit failed on round ${i + 1}: ${(cliReAudit.error_message || cliReAudit.result || 'guide error').toString().slice(0, 300)}`));
            break;
          }
        }
        const promo = await promoteAuditToBugs({ projDir, projectName });
        if (!promo.promoted) {
          // v0.14.42: CLI parity — drain a manually dropped round before
          // declaring the chain done (mirrors the server chain).
          const pending = await detectNewBugRound(projDir, projectName);
          if (pending) {
            console.log(chalk.cyan(`\n🐞 Audit clean, but pending manual bugs round ${pending.round} detected — running fixes…`));
            const drain = await autoRun({ projectName, unattended: true, dryRun: false });
            completed += 1;
            const drainedCleanly = drain.status === 'completed' || (drain.status === 'paused' && CLEAN.has(drain.pauseKind));
            if (!drainedCleanly) { console.log(chalk.yellow(`⏹  Pipeline stopped on blocker: ${drain.reason || drain.status}`)); break; }
            continue;
          }
          console.log(chalk.yellow(`\n⏹  Pipeline stopped (audit is fine): ${promo.reason}`));
          if (completed === 0) {
            const { getNextActions, renderNextActionsCli } = await import('./lib/next-actions.js');
            process.stdout.write(renderNextActionsCli(getNextActions({ project: projectName, lastAction: 'audit' })));
          }
          return;
        }
        if (promo.warning) console.log(chalk.yellow(`  ⚠  ${promo.warning}`));
        console.log(chalk.cyan(`\n🔍→🐞 Round ${i + 1}/${maxRounds}: promoted to bugs round ${promo.round} (${path.relative(REPO_ROOT, promo.bugsPath)}). Running unattended fixes…`));
        const r = await autoRun({ projectName, unattended: true });
        completed += 1;
        const cleanlyDone = r?.status === 'completed' || (r?.status === 'paused' && CLEAN.has(r.pauseKind));
        if (!cleanlyDone) {
          console.log(chalk.yellow(`\n⏸  Pipeline paused after ${completed} round(s): ${r?.reason || r?.status}`));
          return;
        }
      }
      console.log(chalk.green(`\n✓ Auto pipeline complete — ${completed} round(s).`));
      return;
    }

    const { getNextActions, renderNextActionsCli } = await import('./lib/next-actions.js');
    const actions = getNextActions({ project: projectName, lastAction: 'audit' });
    process.stdout.write(renderNextActionsCli(actions));
  });

program.command('pipeline <project>').description('Full autopilot: intake → brief → build → bug inbox → audit→fix (×N) → QA handoff, then stop at the ship gate')
  .option('--rounds <n>', 'audit→fix loop iterations (default 1; max 10)', (v) => parseInt(v, 10))
  .option('--stop-after <stage>', 'stop early after: brief | build | fixes | qa (default qa = ship-ready)')
  .option('--auto-brief', 'build on a freshly-authored brief without stopping for review (default: stop so you can review a from-scratch brief)')
  .action(async (projectName, opts) => {
    const project = getProject(projectName);
    if (!project) { console.error(chalk.red(`Project not found: ${projectName}`)); process.exit(1); }
    const { runPipeline } = await import('./pipeline.js');
    const stopAfter = ['brief', 'build', 'fixes', 'qa'].includes(opts.stopAfter) ? opts.stopAfter : 'qa';
    console.log(chalk.cyan(`🚀 Pipeline for ${projectName} (rounds=${Math.max(1, Math.min(10, Number(opts.rounds) || 1))}, stop-after=${stopAfter})`));
    console.log(chalk.dim('   Chains intake → brief → build → inbox → audit→fix → QA. Never ships; stops on a blocker.'));
    const pipe = await runPipeline({ projectName, projectsDir: PROJECTS_DIR, rounds: opts.rounds, stopAfter, autoBrief: !!opts.autoBrief });
    const glyph = pipe.stoppedAt === 'ship-gate' ? chalk.green('✓') : chalk.yellow('⏸');
    console.log(`\n${glyph} Pipeline ${pipe.stoppedAt}: ${pipe.reason}`);
    if (pipe.ranStages.length) console.log(chalk.dim(`   Ran: ${pipe.ranStages.join(' → ')}`));
    if (pipe.stoppedAt === 'ship-gate') {
      console.log(chalk.dim(`   Review on GitHub / locally, then: npm run ship -- ${projectName}`));
    }
  });

program.command('promote <project>').description('Promote audit findings into bug-rounds/round-N/bugs.md (you review before running bugs)')
  .option('--from-audit', 'Source from the most recent audit (currently the only source)')
  .option('--audit-file <path>', 'Specific audit file path (defaults to most recent)')
  .option('--round <n>', 'Target bug round number (defaults to next available)', parseInt)
  .option('--append', 'Append to existing bugs.md instead of erroring (default: error if file exists)')
  .option('--force', 'Re-promote even if this audit was already promoted (operator escape hatch)')
  .action(async (projectName, opts) => {
    if (!opts.fromAudit && !opts.auditFile) {
      console.error(chalk.red('Specify --from-audit (or --audit-file <path>)'));
      process.exit(1);
    }
    const project = getProject(projectName);
    if (!project) { console.error(chalk.red(`Project not found: ${projectName}`)); process.exit(1); }
    const projDir = path.join(PROJECTS_DIR, projectName);

    const promo = await promoteAuditToBugs({
      projDir,
      projectName,
      auditFile: opts.auditFile || null,
      round: opts.round ?? null,
      append: !!opts.append,
      force: !!opts.force,
    });

    if (!promo.promoted) {
      console.error(chalk.red('\n✗ ' + promo.reason));
      if (/already exists/i.test(promo.reason || '')) {
        console.error(chalk.dim('Options:'));
        console.error(chalk.dim('  • Use --append to add to existing file'));
        console.error(chalk.dim('  • Use --round <n> to choose a different round'));
        console.error(chalk.dim('  • Delete the existing file first if you want to replace it'));
      }
      process.exit(1);
    }

    if (promo.warning) console.log(chalk.yellow(`  ⚠  ${promo.warning}`));

    if (promo.appended) {
      console.log(chalk.green(`\n✓ Appended to: ${path.relative(REPO_ROOT, promo.bugsPath)}`));
    } else {
      console.log(chalk.green(`\n✓ Created: ${path.relative(REPO_ROOT, promo.bugsPath)}`));
    }

    console.log(chalk.dim('\nNext steps:'));
    console.log(chalk.dim(`  1. Open the file: code ${path.relative(REPO_ROOT, promo.bugsPath)}`));
    console.log(chalk.dim('  2. Review each finding. Remove false positives. Adjust severity.'));
    console.log(chalk.dim('  3. Add any manual bugs you noticed that the audit missed.'));
    console.log(chalk.dim(`  4. Run: npm run bugs -- ${projectName}`));
    console.log(chalk.yellow('\n  ⚠  Triage matters — audits average ~20-30% false positives.'));
    console.log(chalk.yellow('     The 10-15 minutes you spend editing this file saves wasted fix-cycle budget.'));
  });

program.command('backlog <project>').description('Show minor/deferred audit findings stored in .guide/audit-backlog.md')
  .option('--edit', 'Open the file in $EDITOR instead of printing')
  .action(async (projectName, opts) => {
    const project = getProject(projectName);
    if (!project) { console.error(chalk.red(`Project not found: ${projectName}`)); process.exit(1); }
    const projDir = path.join(PROJECTS_DIR, projectName);
    const backlogFile = path.join(projDir, '.guide', 'audit-backlog.md');
    let content;
    try {
      content = await fs.readFile(backlogFile, 'utf-8');
    } catch {
      console.log(chalk.dim(`No audit-backlog.md yet for ${projectName}.`));
      console.log(chalk.dim('Minor/deferred findings are written here automatically when you run an audit.'));
      return;
    }
    if (opts.edit) {
      const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
      const { spawn: sp } = await import('node:child_process');
      sp(editor, [backlogFile], { stdio: 'inherit' }).on('exit', () => {});
      return;
    }
    console.log(chalk.bold.cyan(`\n═══ Audit Backlog — ${projectName} ═══\n`));
    console.log(chalk.dim(`File: ${path.relative(REPO_ROOT, backlogFile)}`));
    console.log(chalk.dim('─'.repeat(60)));
    console.log(content.trimEnd());
    console.log(chalk.dim('\n─'.repeat(60)));
    console.log(chalk.dim(`\nTo promote a backlog item to bugs.md: add it to .guide/bug-rounds/round-N/bugs.md manually, then run: npm run bugs -- ${projectName}`));
    console.log(chalk.dim(`To open in editor: npm run backlog -- ${projectName} --edit`));
  });

program.command('roadmap <project>').description('Suggest next implementations after current project')
  .option('--force', 'Bypass the unreviewed-roadmap guard (use after Mark Reviewed, or for explicit override)')
  .action(async (projectName, opts) => {
    const project = getProject(projectName);
    if (!project) { console.error(chalk.red(`Project not found: ${projectName}`)); process.exit(1); }
    const projDir = path.join(PROJECTS_DIR, projectName);
    const plan = await readJson(planJsonPath(projDir));
    if (!plan) { console.error(chalk.red('No plan.json. Roadmap needs a project with completed work to extrapolate from.')); process.exit(1); }

    if (await hasUnreviewedFreshRoadmap(projDir) && !opts.force) {
      console.error(chalk.yellow('Roadmap not yet reviewed — mark it reviewed first.'));
      console.error(chalk.dim('  Use --force to override, or tap [✅ Mark Reviewed] from /coach in Telegram.'));
      process.exit(1);
    }
    if (opts.force) {
      console.warn(chalk.yellow('⚠  --force: bypassing unreviewed-roadmap guard.'));
    }

    console.log(chalk.cyan('Generating roadmap suggestions (Opus)…'));
    const result = await runGuide({ projectName, task: 'roadmap' });
    const roadmapFile = await findMostRecentRoadmap(projDir);
    console.log(chalk.green(`\n✓ Roadmap drafted: ${roadmapFile ? path.relative(REPO_ROOT, roadmapFile) : '(see .guide/roadmaps/)'}`));
    console.log(chalk.dim('\nTo accept a suggestion:'));
    console.log(chalk.dim('  npm run roadmap-accept -- ' + projectName + ' --item <N> --new-project <name>'));
  });

program.command('roadmap-accept <project>').description('Spawn new project(s) or inbox entries from a roadmap')
  .option('--item <n>', 'Single item number (shorthand for --items <n>)', parseInt)
  .option('--items <list>', 'Multiple items: "1,3,5" or "1-5" or "1,3-5,7"')
  .option('--all', 'All items from the roadmap')
  .option('--new-project <name>', 'Spawn one new project containing all selected items')
  .option('--to-inbox <target>', 'Append each item as a requirement to target project (use "_inbox" for unscoped)')
  .option('--profile <p>', 'Profile for new project (only with --new-project)')
  .action(async (projectName, opts) => {
    const projDir = path.join(PROJECTS_DIR, projectName);
    const roadmapFile = await findMostRecentRoadmap(projDir);
    if (!roadmapFile) { console.error(chalk.red('No roadmap found. Run: npm run roadmap -- ' + projectName)); process.exit(1); }
    const roadmapContent = await fs.readFile(roadmapFile, 'utf-8');

    // Validate mode flags
    if (opts.newProject && opts.toInbox) {
      console.error(chalk.red('Pick one: --new-project OR --to-inbox, not both.'));
      process.exit(1);
    }
    if (!opts.newProject && !opts.toInbox) {
      console.error(chalk.red('Must specify one of: --new-project <name>, --to-inbox <project>'));
      process.exit(1);
    }

    // Parse roadmap into structured items
    let items = parseRoadmapItems(roadmapContent);
    if (!items || items.length === 0) {
      console.error(chalk.yellow('Could not parse roadmap into discrete items. Common formats: "## 1. Title", "## Item 1: Title", "## Suggestion 1".'));
      if (opts.all || opts.items) {
        console.error(chalk.red('Cannot use --all or --items if the roadmap has no parseable items. Edit the roadmap to use numbered headings, or use --item with --new-project to embed the whole roadmap.'));
        process.exit(1);
      }
      // Single --item with unparseable roadmap: legacy behavior — embed entire roadmap content
      items = null;
    }

    // Resolve which items to use
    let selectedNumbers = [];
    if (opts.all) {
      selectedNumbers = items.map((it) => it.n);
    } else if (opts.items) {
      selectedNumbers = parseItemRange(opts.items);
    } else if (opts.item != null) {
      selectedNumbers = [opts.item];
    } else {
      console.error(chalk.red('Must specify items: --item <n>, --items <list>, or --all'));
      process.exit(1);
    }
    if (selectedNumbers.length === 0) {
      console.error(chalk.red('No items selected.'));
      process.exit(1);
    }

    // If we have parsed items, validate selections
    let selectedItems = null;
    if (items) {
      selectedItems = selectedNumbers.map((n) => items.find((it) => it.n === n)).filter(Boolean);
      const missing = selectedNumbers.filter((n) => !items.find((it) => it.n === n));
      if (missing.length > 0) {
        console.error(chalk.red(`Items not found in roadmap: ${missing.join(', ')}. Available: ${items.map((it) => it.n).join(', ')}`));
        process.exit(1);
      }
    }

    // ─── Mode: --to-inbox ─────────────────────────────────────────────────
    if (opts.toInbox) {
      const targetProject = opts.toInbox;
      if (targetProject !== '_inbox' && !getProject(targetProject)) {
        console.error(chalk.red(`Target project not found: ${targetProject}. Use "_inbox" for unscoped capture.`));
        process.exit(1);
      }
      const { addRequirement } = await import('./state.js');
      let added = 0;
      const parentRef = `Roadmap of ${projectName} (${path.relative(REPO_ROOT, roadmapFile)})`;
      for (const it of selectedItems || [{ n: opts.item, title: '(see roadmap)', body: roadmapContent.slice(0, 4000) }]) {
        const reqText = `${it.title}\n\n${it.body}\n\n[Source: ${parentRef}]`;
        const id = addRequirement({
          project: targetProject,
          raw_text: reqText,
          source: 'roadmap',
          created_by: 0,
        });
        added += 1;
        console.log(chalk.dim(`  + req #${id} from item ${it.n}: ${it.title.slice(0, 60)}`));
      }
      console.log(chalk.green(`\n✓ Added ${added} requirement(s) to ${targetProject}.`));
      const { getNextActions, renderNextActionsCli } = await import('./lib/next-actions.js');
      const nextActions = getNextActions({
        project: targetProject,
        lastAction: 'req-added',
        state: { hasInbox: true },
      });
      process.stdout.write(renderNextActionsCli(nextActions));
      return;
    }

    // ─── Mode: --new-project ──────────────────────────────────────────────
    if (!/^[a-z0-9-]+$/.test(opts.newProject)) {
      console.error(chalk.red('New project name must be lowercase alphanumeric + dashes.'));
      process.exit(1);
    }
    const newDir = path.join(PROJECTS_DIR, opts.newProject);
    if (await fileExists(newDir)) { console.error(chalk.red(`Already exists: ${newDir}`)); process.exit(1); }

    await fs.mkdir(path.join(newDir, '.guide'), { recursive: true });
    await fs.mkdir(path.join(newDir, 'workspace'), { recursive: true });
    await fs.mkdir(path.join(newDir, 'inputs'), { recursive: true });
    await fs.mkdir(path.join(newDir, 'outputs'), { recursive: true });

    // Build raw-thoughts.md from selected items
    let rawThoughts;
    if (selectedItems) {
      const itemSection = selectedItems.map((it) =>
        `## Item ${it.n}: ${it.title}\n\n${it.body.replace(/^##+\s+(?:Item\s+)?\d+[.:]?\s+.*$/m, '').trim()}\n`,
      ).join('\n');
      rawThoughts = `# Raw thoughts for ${opts.newProject}\n\n` +
        `Sourced from: ${path.relative(REPO_ROOT, roadmapFile)} — Items ${selectedNumbers.join(', ')}\n` +
        `Parent project: ${projectName}\n\n` +
        `<!-- Edit this file to refine the requirements, then run:\n` +
        `       npm run brief -- ${opts.newProject}\n` +
        `     to author the structured brief. -->\n\n` +
        `${itemSection}\n`;
    } else {
      // Roadmap not parseable — embed whole thing (legacy fallback for single --item)
      rawThoughts = `# Raw thoughts for ${opts.newProject}\n\n` +
        `Sourced from: ${path.relative(REPO_ROOT, roadmapFile)} — Item ${selectedNumbers[0]}\n` +
        `Parent project: ${projectName}\n\n` +
        `<!-- Edit this file to refine the requirements, then run:\n` +
        `       npm run brief -- ${opts.newProject}\n` +
        `     to author the structured brief. -->\n\n` +
        `## Roadmap context\n\n` +
        `\`\`\`\n${roadmapContent}\n\`\`\`\n\n` +
        `## Item ${selectedNumbers[0]} — pulled from above\n\n` +
        `<!-- Copy the specific suggestion text here, then edit -->\n`;
    }
    await fs.writeFile(path.join(newDir, '.guide', 'raw-thoughts.md'), rawThoughts);

    await fs.writeFile(path.join(newDir, 'project.json'), JSON.stringify({
      $schema_version: 1, name: opts.newProject,
      tech_stack: '', profile: opts.profile || null,
      created_at: new Date().toISOString(),
      current_phase: 0, total_phases: 0,
      guide_session_id: null, last_dev_session_id: null,
      status: 'planning', guide_layout_version: 2,
      overrides: {}, metadata: { spawned_from: projectName, roadmap_items: selectedNumbers },
    }, null, 2));
    upsertProject({ name: opts.newProject, profile: opts.profile });

    console.log(chalk.green(`\n✓ Created project ${opts.newProject} with ${selectedNumbers.length} item(s): ${selectedNumbers.join(', ')}`));
    const { getNextActions, renderNextActionsCli } = await import('./lib/next-actions.js');
    const actions = getNextActions({
      project: opts.newProject,
      lastAction: 'roadmap-accepted',
      state: { newProject: opts.newProject },
    });
    process.stdout.write(renderNextActionsCli(actions));
  });

// ─── Roadmap-parsing helpers ───────────────────────────────────────────────

/**
 * Parses item ranges like "1,3,5" or "1-5" or "1,3-5,7" → [1,3,5] or [1,2,3,4,5] or [1,3,4,5,7].
 * Returns sorted unique numbers.
 */
function parseItemRange(spec) {
  const result = new Set();
  for (const part of String(spec).split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const range = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      for (let i = Math.min(start, end); i <= Math.max(start, end); i += 1) result.add(i);
    } else if (/^\d+$/.test(trimmed)) {
      result.add(Number(trimmed));
    } else {
      throw new Error(`Invalid item spec segment: "${trimmed}". Use "1,3,5" or "1-5".`);
    }
  }
  return [...result].sort((a, b) => a - b);
}

/**
 * Parses a roadmap markdown into an array of { n, title, body }.
 * Tries multiple common formats. Returns null if no parseable items found.
 */
function parseRoadmapItems(content) {
  if (!content) return null;
  const patterns = [
    // ## 1. Title  or  ## 1: Title
    /^##\s+(\d+)\s*[.:]\s+(.+?)$/gm,
    // ## Item 1: Title  or  ## Item 1. Title
    /^##\s+Item\s+(\d+)\s*[.:]?\s+(.+?)$/gim,
    // ### 1. Title  (one level deeper)
    /^###\s+(\d+)\s*[.:]\s+(.+?)$/gm,
    // ## Suggestion 1
    /^##\s+Suggestion\s+(\d+)\s*[.:]?\s*(.*?)$/gim,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    const matches = [...content.matchAll(re)];
    if (matches.length >= 1) {
      const items = [];
      for (let i = 0; i < matches.length; i += 1) {
        const n = Number(matches[i][1]);
        const title = matches[i][2]?.trim() || `Item ${n}`;
        const startIdx = matches[i].index;
        const endIdx = i + 1 < matches.length ? matches[i + 1].index : content.length;
        const body = content.slice(startIdx, endIdx).trim();
        items.push({ n, title, body });
      }
      // Dedup by item number, prefer first occurrence
      const seen = new Set();
      return items.filter((it) => {
        if (seen.has(it.n)) return false;
        seen.add(it.n);
        return true;
      });
    }
  }
  return null;
}


// ─── bugs ──────────────────────────────────────────────────────────────────

program.command('bugs <project>').description('Start a bug-fix round').action(async (projectName) => {
  const r = await startBugCycle({ projectName });
  console.log(chalk.green(`\nBug round ${r.round}: ${r.fixCount} fix(es) planned.`));
});

// ─── status ────────────────────────────────────────────────────────────────

program.command('status [project]').description('Show window budget and project state').action(async (projectName) => {
  const cfg = await resolveConfig({ project: projectName || null, task: 'dev-execution' });
  console.log(renderStatus(cfg));
  console.log();
  const projects = projectName ? [getProject(projectName)].filter(Boolean) : listProjects();
  if (projects.length === 0) { console.log(chalk.dim('No projects.')); return; }
  console.log(chalk.bold('Projects'));
  for (const p of projects) {
    const sc = p.status === 'completed' ? chalk.green : p.status === 'cancelled' ? chalk.red
      : p.status === 'paused' ? chalk.yellow
      : p.status === 'ready-for-qa' ? chalk.magenta : chalk.cyan;
    console.log(`  ${chalk.bold(p.name)}  phase ${p.current_phase}/${p.total_phases}  [${sc(p.status)}]`);
    if (projectName) {
      const phases = getPhases(p.name);
      for (const ph of phases) {
        const icon = ph.status === 'completed' ? chalk.green('✓') : ph.status === 'in-progress' ? chalk.yellow('→') : chalk.dim('·');
        console.log(`    ${icon} phase ${ph.n}: ${ph.title || '(no title)'}`);
      }
      const rounds = bugStatus(p.name);
      if (rounds.length) {
        console.log(chalk.bold('  Bug rounds'));
        for (const r of rounds) console.log(`    round ${r.round}: ${r.fixes} fixes  [${r.status}]`);
      }
      const lastRun = getLastAutoRun(p.name);
      if (lastRun) {
        const runColor = lastRun.status === 'interrupted' ? chalk.red.dim
          : lastRun.status === 'paused'    ? chalk.yellow
          : lastRun.status === 'failed'    ? chalk.red
          : lastRun.status === 'completed' ? chalk.green
          : chalk.dim;
        console.log(chalk.bold('  Last auto-run'), `\n    id=${lastRun.id}  status=${runColor(lastRun.status)}  ${lastRun.pause_reason || ''}`);
      }
    }
  }
});

program.command('logs <project>')
  .description('List the newest log files for a project (tail the printed path)')
  .option('-n, --count <n>', 'how many recent files to list', '10')
  .action(async (projectName, opts) => {
    const logsDir = path.join(REPO_ROOT, 'logs');
    let entries = [];
    try {
      entries = (await fs.readdir(logsDir))
        .filter((f) => f.startsWith(`${projectName}-`) && f.endsWith('.log'));
    } catch { /* no logs dir yet */ }
    if (!entries.length) {
      console.log(chalk.dim(`No log files for '${projectName}' in logs/ yet.`));
      return;
    }
    const stats = await Promise.all(entries.map(async (f) => {
      const p = path.join(logsDir, f);
      const st = await fs.stat(p).catch(() => null);
      return st ? { p, mtimeMs: st.mtimeMs, size: st.size } : null;
    }));
    const newest = stats.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, Math.max(1, parseInt(opts.count, 10) || 10));
    for (const { p, mtimeMs, size } of newest) {
      console.log(`${new Date(mtimeMs).toISOString()}  ${String(size).padStart(9)}B  ${p}`);
    }
    console.log(chalk.dim(`\ntail -f '${newest[0].p}'`));
  });

// ─── req: Requirements inbox ───────────────────────────────────────────────

const reqCmd = program.command('req').description('Requirements inbox — capture, refine, triage, promote');

reqCmd.command('add <project> <text...>').description('Add a raw requirement (text can be multi-word or "-" to read from stdin)')
  .action(async (project, textParts) => {
    const { cmdAdd } = await import('./commands/requirements.js');
    let text = textParts.join(' ');
    if (text === '-' || !text) {
      // stdin
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      text = Buffer.concat(chunks).toString('utf-8').trim();
    }
    if (!text) { console.error(chalk.red('No text provided.')); process.exit(1); }
    const id = await cmdAdd(project, text, { source: 'cli' });
    console.log(chalk.green(`✓ Saved as req #${id} in ${project} inbox.`));
  });

reqCmd.command('list <project>').description('List requirements (default: status=inbox)')
  .option('--status <status>', 'inbox | refined | promoted | dropped')
  .option('--priority <pri>', 'p0 | p1 | p2 | p3 | unassigned')
  .option('--scope <scope>', 'now | next | later | no | unassigned')
  .option('--all', 'Show all statuses')
  .action(async (project, opts) => {
    const { cmdList } = await import('./commands/requirements.js');
    await cmdList(project, opts);
  });

reqCmd.command('show <id>').description('Show details for one requirement')
  .action(async (id) => {
    const { cmdShow } = await import('./commands/requirements.js');
    await cmdShow(Number(id));
  });

reqCmd.command('triage <id>').description('Interactively set priority + scope')
  .action(async (id) => {
    const { cmdTriage } = await import('./commands/requirements.js');
    await cmdTriage(Number(id));
  });

reqCmd.command('set <id> <field> <value>').description('Set one field (priority / scope / status / tags / refined_text)')
  .action(async (id, field, value) => {
    const { cmdSet } = await import('./commands/requirements.js');
    await cmdSet(Number(id), field, value);
  });

reqCmd.command('drop <id>').description('Mark a requirement dropped (soft delete)')
  .action(async (id) => {
    const { cmdDrop } = await import('./commands/requirements.js');
    await cmdDrop(Number(id));
  });

reqCmd.command('refine <project>').description('Run AI refinement (Sonnet) over inbox items')
  .action(async (project) => {
    const { cmdRefine } = await import('./commands/requirements.js');
    await cmdRefine(project);
  });

reqCmd.command('promote <project>').description('Append refined reqs (scope=now by default) into raw-thoughts.md')
  .option('--scope <scope>', 'Which scope bucket to promote', 'now')
  .option('--destination <path>', 'Override destination file (default: raw-thoughts.md)')
  .action(async (project, opts) => {
    const { cmdPromote } = await import('./commands/requirements.js');
    await cmdPromote(project, opts);
  });

// v0.14.11: promote-to — convenience wrapper for the most common "ship items
// from _inbox to a real project" path. Auto-derives the destination raw-thoughts
// path from a project name, auto-scopes unassigned items to scope=now, and
// remembers the destination for future Telegram one-tap promotes.
reqCmd.command('promote-to <inbox> <destination>')
  .description('Promote scope=now (or autoscope) items from <inbox> into <destination>/raw-thoughts.md')
  .option('--scope <scope>', 'Which scope bucket to promote (after autoscope)', 'now')
  .option('--no-autoscope', 'Do NOT auto-flip unassigned items to scope=<scope> first')
  .action(async (inbox, destination, opts) => {
    const { performReqPromote, rememberInboxDestination } = await import('./commands/req-promote.js');
    try {
      const result = await performReqPromote({
        inboxProject: inbox,
        destinationProject: destination,
        scope: opts.scope,
        autoScope: opts.autoscope !== false, // --no-autoscope flips this off
      });
      rememberInboxDestination(inbox, destination, null);
      console.log(chalk.green(`✓ Promoted ${result.promoted} requirement(s) from ${inbox} → ${destination}.`));
      console.log(chalk.dim(`  IDs: #${result.ids.join(', #')}`));
      console.log(chalk.dim(`  File: ${path.relative(REPO_ROOT, result.destinationPath)}`));
      console.log(chalk.dim(`\nNext: review the file, then run: npm run brief -- ${destination}`));
    } catch (err) {
      console.error(chalk.red(`✗ ${err.message}`));
      process.exit(1);
    }
  });

reqCmd.command('stats <project>').description('Show counts by status/scope')
  .action(async (project) => {
    const { cmdStats } = await import('./commands/requirements.js');
    await cmdStats(project);
  });

reqCmd.command('projects').description('List all projects that have requirements')
  .action(async () => {
    const { cmdProjects } = await import('./commands/requirements.js');
    await cmdProjects();
  });

// ─── triage: Fast keypress-driven inbox triage ─────────────────────────────

program.command('triage <project>').description('Interactive fast-triage for the requirements inbox (single-key actions)')
  .option('--refined', 'Only triage items already AI-refined')
  .action(async (projectName, opts) => {
    const { startTriage } = await import('./commands/triage.js');
    await startTriage(projectName, { refinedOnly: !!opts.refined });
  });

// ─── bug: Bug inbox (v0.12.0) ──────────────────────────────────────────────

const bugCmd = program.command('bug').description('Bug inbox — capture, refine, promote into a new bug round');

bugCmd.command('add <project> <text...>').description('Add a raw bug to the inbox (severity defaults to unassigned; use --critical/--major/--minor)')
  .option('--critical', 'Mark as critical')
  .option('--major', 'Mark as major')
  .option('--minor', 'Mark as minor')
  .option('--severity <s>', 'critical | major | minor | unassigned')
  .action(async (project, textParts, opts) => {
    const { addCmd } = await import('./commands/bugs-inbox.js');
    await addCmd(project, textParts.join(' '), opts);
  });

bugCmd.command('list <project>').description('List pending bugs (use --all to see promoted/dropped)')
  .option('--all', 'Show all statuses')
  .action(async (project, opts) => {
    const { listCmd } = await import('./commands/bugs-inbox.js');
    await listCmd(project, opts);
  });

bugCmd.command('show <id>').description('Show one bug')
  .action(async (id) => {
    const { showCmd } = await import('./commands/bugs-inbox.js');
    await showCmd(id);
  });

bugCmd.command('set <id> <field> <value>').description('Update field (severity / status / tags / refined_text / notes)')
  .action(async (id, field, value) => {
    const { setCmd } = await import('./commands/bugs-inbox.js');
    await setCmd(id, field, value);
  });

bugCmd.command('drop <id>').description('Soft-delete a bug')
  .action(async (id) => {
    const { dropCmd } = await import('./commands/bugs-inbox.js');
    await dropCmd(id);
  });

bugCmd.command('refine <project>').description('AI-structure raw bug texts into title/repro/expected/files')
  .action(async (project) => {
    const { refineCmd } = await import('./commands/bugs-inbox.js');
    await refineCmd(project);
  });

bugCmd.command('promote <project>').description('Create new bug round from inbox items (becomes bugs.md for round-N+1)')
  .option('--severity <s>', 'Only promote bugs of this severity')
  .option('--ids <list>', 'Specific bug IDs comma-separated (e.g. "3,5,8")')
  .option('--run', 'After creating bugs.md, auto-start the bug round')
  .action(async (project, opts) => {
    const { promoteCmd } = await import('./commands/bugs-inbox.js');
    await promoteCmd(project, opts);
  });

bugCmd.command('stats <project>').description('Show counts by status × severity')
  .action(async (project) => {
    const { statsCmd } = await import('./commands/bugs-inbox.js');
    await statsCmd(project);
  });

// ─── web UI ────────────────────────────────────────────────────────────────

program.command('web').description('Start the live web dashboard (default port 4242)')
  .option('--port <n>', 'HTTP port', '4242')
  .option('--host <h>', 'Bind host (use 0.0.0.0 to expose on LAN/NAS)', '127.0.0.1')
  .option('--dev', 'Enable dev mode: browser auto-reloads when src/public/ files change')
  .action(async (opts) => {
    process.env.ASHMERO_UI_MODE = '1';
    const { startWebUi } = await import('./web-ui.js');
    const port = parseInt(opts.port, 10) || 4242;
    const host = opts.host || '127.0.0.1';
    const { server } = await startWebUi({ port, host, dev: !!opts.dev });
    console.log(chalk.green(`\n  ⬡  Ashmero Web UI`));
    console.log(chalk.cyan(`     http://${host === '0.0.0.0' ? 'localhost' : host}:${port}\n`));
    if (opts.dev) console.log(chalk.dim('     dev mode: browser auto-reloads on file change\n'));
    const { killAll } = await import('./claude-runner.js');
    let shuttingDown = false;
    const shutdown = (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(chalk.yellow(`[web] ${signal}: closing HTTP and terminating in-flight Claude process groups`));
      killAll({ reason: `${signal}: web process shutdown` });
      server.close(() => process.exit(0));
      // killAll sends SIGTERM then SIGKILL after 5s. Keep this process alive
      // long enough to deliver both signals instead of orphaning a paid call.
      setTimeout(() => process.exit(0), 6_500);
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  });

// ─── chat (control-plane REPL) ───────────────────────────────────────────────

program.command('chat [project]')
  .description('Interactive control-plane chat — ask anything, capture bugs/requirements, queue briefs, start runs')
  .option('--new', 'Start a fresh thread instead of resuming the latest one')
  .action(async (projectName, opts) => {
    const { chatRepl } = await import('./commands/chat.js');
    await chatRepl({ project: projectName || null, fresh: !!opts.new });
  });

// ─── remove-project ────────────────────────────────────────────────────────

program.command('remove-project <name>')
  .description('Remove a project: delete all DB rows and (by default) projects/<name>/ from disk')
  .option('--force', 'Skip confirmation prompt')
  .option('--keep-files', 'Delete DB records but leave projects/<name>/ on disk')
  .action(async (name, opts) => {
    const { getProject } = await import('./state.js');
    const proj = getProject(name);
    if (!proj) {
      console.error(chalk.red(`✗ Project not found: ${name}`));
      process.exit(1);
    }
    if (!opts.force) {
      const readline = await import('node:readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const filesNote = opts.keepFiles ? '' : ` and projects/${name}/ from disk`;
      const answer = await new Promise((resolve) => {
        rl.question(
          chalk.yellow(`Remove project "${name}"? This will delete all DB rows${filesNote}. [y/N] `),
          resolve,
        );
      });
      rl.close();
      if (!/^y(es)?$/i.test(answer.trim())) {
        console.log(chalk.dim('Cancelled.'));
        process.exit(0);
      }
    }
    const { removeProject } = await import('./commands/remove-project.js');
    const result = await removeProject({ name, keepFiles: !!opts.keepFiles });
    if (result.ok) {
      const note = result.filesDeleted
        ? chalk.dim(` projects/${name}/ deleted.`)
        : result.filesError
          ? chalk.yellow(` (files not deleted: ${result.filesError})`)
          : chalk.dim(' (files kept)');
      console.log(chalk.green(`✓ Project "${name}" removed.`) + note);
    }
  });

// ─── helpers ───────────────────────────────────────────────────────────────

async function fileExists(p) { try { await fs.access(p); return true; } catch { return false; } }
async function readJson(p) { try { return JSON.parse(await fs.readFile(p, 'utf-8')); } catch { return null; } }
function pad(s, w) { s = String(s); return s.length >= w ? s.slice(0, w - 1) + '…' : s + ' '.repeat(w - s.length); }
async function findClaudeBin() {
  for (const c of [`${os.homedir()}/.nvm/versions/node/v22.16.0/bin/claude`, `${os.homedir()}/.npm-global/bin/claude`, '/usr/local/bin/claude', '/opt/homebrew/bin/claude']) {
    if (await fileExists(c)) return c;
  }
  return 'claude';
}

program.parseAsync().catch((err) => {
  console.error(chalk.red(`\nError: ${err.message}`));
  if (process.env.LOG_LEVEL === 'debug') console.error(err.stack);
  process.exit(1);
});
