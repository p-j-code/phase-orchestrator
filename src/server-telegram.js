#!/usr/bin/env node
// Orchestrator Server — Telegram mode. Hosts the grammy bot and processes
// the job queue. Activated when config/defaults.json "bot.provider" = "telegram".
//
// Usage:  set bot.provider = "telegram" in config/defaults.json, then npm run server

import { Bot, webhookCallback } from 'grammy';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';

import { workerContext } from './lib/worker-context.js';
import { liveStatus } from './lib/live-status.js';
import { registerCommandMenu } from './lib/command-menu-telegram.js';

const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);

function workerPrefix(fn) {
  return (...args) => {
    const ctx = workerContext.getStore();
    if (ctx) {
      const tag = chalk.dim(`[w${ctx.workerId} ${ctx.project}]`);
      fn(tag, ...args);
    } else {
      fn(...args);
    }
  };
}
console.log = workerPrefix(_origLog);
console.warn = workerPrefix(_origWarn);
console.error = workerPrefix(_origError);

import {
  nextPendingJobForFreeProject, tryClaimJob,
  reconcileStaleRunningJobs, heartbeatJobLease, JOB_HEARTBEAT_MS, windowGate, getJob,
} from './server/job-queue.js';
import { executeJob } from './server/job-runner.js';
import { killAll } from './claude-runner.js';
import { TelegramNotifier } from './server/telegram-notifier.js';
import {
  handleStart, handleAuth, handleStatus, handleProjects, handleProject,
  handleQueue, handleRun, handleCancel, handleDequeue, handleUsers,
  handleHistory, handleDownload, handleCallback,
  handleReq, handleCapture, handleDone, handleInbox, handleReqPromote, handleMessage,
  handleTriage,
  handleHelp, handleDocs,
  handlePin, handleUnpin, handlePinned,
  handleBug, handleBugCapture, handleBugDone, handleBugsInbox, handleBugPromote,
  handleShip, handleGitStatus, handleSync, handleSyncAll, handleNewProject,
  handleSuggest, handleNewbrief, handleDiscuss, handleDiscussInspect,
  handleOperatorQuestion,
} from './server/telegram-handlers.js';
import {
  handlePreview, handleFiles, handleFile,
} from './server/preview-handlers.js';
import {
  handlePredict, handleBudget, handleInspect, handleRetryPhase, handlePromote,
  handleQaHandoff, handleValidate, handleValidators, handleDashboard, handlePackage,
  handleCoach, handleExtend, handleBriefQuestions,
  handleRemoveProject, handleSpend, handleAddBug,
} from './server/telegram-parity-handlers.js';
import { resolve as resolveConfig } from './config-resolver.js';
import { runCleanup } from './lib/log-cleanup.js';
import { preventSleep, allowSleep, configureWakeLock, wakeLockStatus } from './lib/wake-lock.js';
import { startWatchdog, stopWatchdog } from './lib/project-watchdog.js';
import { startOperatorQuestionsPoller, stopOperatorQuestionsPoller } from './lib/operator-questions.js';
import { startAutopilot, stopAutopilot } from './lib/portfolio-autopilot.js';
import { assertExecutionHost } from './lib/execution-host-policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TELEGRAM_CONFIG_PATH = path.join(REPO_ROOT, 'config', 'telegram.json');
const TELEGRAM_CONFIG_EXAMPLE_PATH = path.join(REPO_ROOT, 'config', 'telegram.json.example');
const USER_CONFIG_PATH = path.join(os.homedir(), '.ashmero-orchestrator', 'user.json');

async function loadTelegramConfig() {
  try {
    await fs.access(TELEGRAM_CONFIG_PATH);
  } catch {
    try {
      await fs.access(TELEGRAM_CONFIG_EXAMPLE_PATH);
      await fs.copyFile(TELEGRAM_CONFIG_EXAMPLE_PATH, TELEGRAM_CONFIG_PATH);
      console.warn(chalk.yellow(
        '⚠ First-run: copied config/telegram.json.example to config/telegram.json. ' +
        'Run npm run bot-setup -- --token <TOKEN> to wire up the bot.',
      ));
    } catch { /* .example also missing — fall through */ }
  }

  try {
    const cfg = JSON.parse(await fs.readFile(TELEGRAM_CONFIG_PATH, 'utf-8'));
    if (cfg.bot_token) return cfg;
  } catch {}
  try {
    const userCfg = JSON.parse(await fs.readFile(USER_CONFIG_PATH, 'utf-8'));
    if (userCfg.telegram?.bot_token) {
      return {
        bot_token: userCfg.telegram.bot_token,
        mode: userCfg.telegram.mode || 'polling',
        webhook_url: userCfg.telegram.webhook_url || null,
        webhook_port: userCfg.telegram.webhook_port || 3434,
      };
    }
  } catch {}
  return null;
}

async function main() {
  console.log(chalk.bold.cyan('═══ Orchestrator Server (Telegram) ═══\n'));

  const executionHost = await assertExecutionHost({ entrypoint: 'Telegram queue server startup' });
  console.log(chalk.dim(
    `[execution-host] ${executionHost.currentRole}/${executionHost.currentHostId} owns execution authority`,
  ));

  liveStatus.enable();

  const cfg = await loadTelegramConfig();
  if (!cfg || !cfg.bot_token) {
    console.error(chalk.red('No Telegram bot token configured.'));
    console.error(chalk.dim('Set bot_token in config/telegram.json.'));
    process.exit(1);
  }

  const recovery = reconcileStaleRunningJobs({ reason: 'server restarted before this job finished' });
  if (recovery.recovered.length > 0) {
    console.log(chalk.yellow(`Recovered ${recovery.recovered.length} stale running job(s) back into the queue.`));
  }
  if (recovery.failed.length > 0) {
    console.log(chalk.yellow(`Left ${recovery.failed.length} non-replay-safe stale job(s) failed for operator review.`));
  }
  if (recovery.deduplicated.length > 0) {
    console.log(chalk.dim(`Deduplicated ${recovery.deduplicated.length} stale resume job(s).`));
  }

  const { repairProjectStates } = await import('./lib/state-repair.js');
  await repairProjectStates().catch((err) => {
    console.warn(chalk.yellow(`[state-repair] Failed: ${err.message} (continuing)`));
  });

  const resolvedCfg = await resolveConfig({ task: 'dev-execution' });
  if (resolvedCfg?.cleanup?.run_on_server_start !== false) {
    await runCleanup(resolvedCfg, { verbose: true }).catch((err) => {
      console.error(chalk.yellow('[cleanup at boot failed]'), err.message);
    });
  }
  const cleanupHours = resolvedCfg?.cleanup?.run_interval_hours ?? 6;
  if (cleanupHours > 0 && resolvedCfg?.cleanup?.enabled !== false) {
    setInterval(() => {
      runCleanup(resolvedCfg, { verbose: false }).catch(() => {});
    }, cleanupHours * 3600 * 1000).unref();
  }

  configureWakeLock({ enabled: resolvedCfg?.wake_lock?.enabled !== false });
  preventSleep();
  const wls = wakeLockStatus();
  if (wls.supported && wls.enabled) {
    console.log(chalk.dim('✓ Wake lock active (caffeinate) — system will not sleep while server is running.'));
  }

  const bot = new Bot(cfg.bot_token);
  const notifier = new TelegramNotifier(bot);

  const watchdogIntervalMs = resolvedCfg?.auto_heal?.watchdog_interval_ms ?? 60_000;
  if (resolvedCfg?.auto_heal?.enabled !== false && resolvedCfg?.auto_heal?.watchdog_enabled !== false) {
    startWatchdog({ intervalMs: watchdogIntervalMs, cfg: resolvedCfg, notifier });
  }

  const oqPollIntervalMs = resolvedCfg?.operator_questions?.poll_interval_ms ?? 30_000;
  startOperatorQuestionsPoller({ intervalMs: oqPollIntervalMs, cfg: resolvedCfg, notifier, includeButtons: true });

  // Nightly portfolio autopilot (Phase 86 — P7b). Self-gates: no-ops when
  // autopilot.enabled is false (default), and FAILS CLOSED (registers no timer)
  // when brief 04's deny-rule sandbox is unresolvable — unattended overnight
  // jobs must never run under unrestricted Bash.
  startAutopilot({ cfg: resolvedCfg, notifier });

  // ─── Wire up commands ────────────────────────────────────────────────────
  bot.command('start', handleStart);
  bot.command('auth', handleAuth);
  bot.command('status', handleStatus);
  bot.command('projects', handleProjects);
  bot.command('project', handleProject);
  bot.command('queue', handleQueue);
  bot.command('run', handleRun);
  bot.command('cancel', handleCancel);
  bot.command('dequeue', handleDequeue);
  bot.command('users', handleUsers);
  bot.command('history', handleHistory);
  bot.command('download', handleDownload);
  bot.command('req', handleReq);
  bot.command('capture', handleCapture);
  bot.command('done', handleDone);
  bot.command('inbox', handleInbox);
  bot.command(['req_promote', 'reqpromote'], handleReqPromote);
  bot.command('triage', handleTriage);
  bot.command('help', handleHelp);
  bot.command('docs', handleDocs);
  bot.command('preview', handlePreview);
  bot.command('files', handleFiles);
  bot.command('file', handleFile);
  bot.command('pin', handlePin);
  bot.command('unpin', handleUnpin);
  bot.command('pinned', handlePinned);
  bot.command('bug', handleBug);
  bot.command(['bug_capture', 'bugcapture'], handleBugCapture);
  bot.command(['bug_done', 'bugdone'], handleBugDone);
  bot.command(['bugs_inbox', 'bugsinbox', 'buginbox'], handleBugsInbox);
  bot.command(['bug_promote', 'bugpromote'], handleBugPromote);
  bot.command(['ship', 'shipproject'], handleShip);
  bot.command(['git_status', 'gitstatus', 'git'], handleGitStatus);
  bot.command(['sync', 'gitpull', 'pull'], handleSync);
  bot.command(['syncall', 'sync_all', 'pullall', 'pull_all'], handleSyncAll);
  bot.command(['new_project', 'newproject', 'import', 'addproject'], handleNewProject);
  bot.command('suggest', handleSuggest);
  bot.command(['newbrief', 'new_brief', 'reset_brief'], handleNewbrief);
  bot.command('discuss', handleDiscuss);
  bot.command(['discuss_inspect', 'discussinspect'], handleDiscussInspect);

  bot.command(['predict', 'cost'], handlePredict);
  bot.command(['spend', 'spent', 'costs'], handleSpend);
  bot.command(['addbug', 'add_bug', 'newbug'], handleAddBug);
  bot.command(['budget'], handleBudget);
  bot.command(['inspect'], handleInspect);
  bot.command(['retry', 'retry_phase', 'retryphase'], handleRetryPhase);
  bot.command(['promote'], handlePromote);
  bot.command(['qa_handoff', 'qahandoff', 'handoff_qa'], handleQaHandoff);
  bot.command(['validate'], handleValidate);
  bot.command(['validators'], handleValidators);
  bot.command(['dashboard'], handleDashboard);
  bot.command(['package'], handlePackage);
  bot.command(['coach', 'next', 'whatsnext', 'whats_next'], handleCoach);
  bot.command(['extend', 'add_work', 'add', 'more'], handleExtend);
  bot.command(['brief_questions', 'briefquestions', 'bq'], handleBriefQuestions);
  bot.command(['remove_project', 'removeproject', 'delete_project', 'deleteproject'], handleRemoveProject);
  bot.command('oq', handleOperatorQuestion);

  bot.on('callback_query:data', handleCallback);
  bot.on('message:text', handleMessage);

  bot.catch((err) => {
    console.error(chalk.red('[bot error]'), err);
  });

  await registerCommandMenu(bot);

  // ─── Start bot ───────────────────────────────────────────────────────────
  const mode = cfg.mode || 'polling';
  if (mode === 'webhook') {
    const app = express();
    app.use(express.json());
    app.use('/telegram', webhookCallback(bot, 'express'));
    app.get('/health', (_, res) => res.json({ ok: true, uptime: process.uptime() }));
    const port = cfg.webhook_port || 3434;
    app.listen(port, () => console.log(chalk.green(`✓ Webhook listening on :${port}/telegram`)));
    if (cfg.webhook_url) {
      try {
        await bot.api.setWebhook(cfg.webhook_url + '/telegram');
        console.log(chalk.green(`✓ Webhook set: ${cfg.webhook_url}/telegram`));
      } catch (err) {
        console.error(chalk.red('Failed to register webhook URL:'), err.message);
      }
    }
  } else {
    console.log(chalk.green('✓ Bot starting (polling mode)'));
    bot.start({
      onStart: (info) => {
        console.log(chalk.green(`✓ Bot online: @${info.username}`));
        notifier.notify({ text: '🟢 Orchestrator server online.\nUse /status to see queue.' });
      },
    });
  }

  // ─── Job processor ───────────────────────────────────────────────────────
  const cfgRunner = resolvedCfg?.job_runner || {};
  const configured = cfgRunner.max_concurrent_projects;
  const cap = Math.max(1, parseInt(cfgRunner.max_workers_cap, 10) || 8);
  let maxWorkers;
  let scaleReason;
  if (typeof configured === 'number' && configured >= 1) {
    maxWorkers = Math.floor(configured);
    scaleReason = `fixed (max_concurrent_projects=${maxWorkers})`;
  } else {
    maxWorkers = cap;
    scaleReason = `auto: ${cap} workers (cap), picks up new projects without restart`;
  }
  console.log(chalk.dim(`\nJob processor running with ${maxWorkers} worker(s) [${scaleReason}]. Press Ctrl-C to stop.\n`));

  let stopping = false;
  const activeJobIds = new Set();
  let pickerBusy = false;

  process.on('SIGINT', async () => {
    if (stopping) {
      console.log(chalk.red('\nForced shutdown.'));
      const killed = killAll({ reason: 'forced shutdown (second Ctrl-C)' });
      if (killed > 0) console.log(chalk.dim(`  SIGTERM sent to ${killed} in-flight subprocess(es).`));
      liveStatus.disable();
      allowSleep();
      process.exit(1);
    }
    stopping = true;
    stopWatchdog();
    stopOperatorQuestionsPoller();
    stopAutopilot();
    console.log(chalk.yellow('\nGraceful shutdown initiated. Waiting on current jobs to finish…'));
    if (activeJobIds.size > 0) {
      console.log(chalk.dim(`  Active jobs: ${[...activeJobIds].map((id) => '#' + id).join(', ')}`));
    }
    await notifier.notify({ text: '🔴 Orchestrator server shutting down.' }).catch(() => {});
    liveStatus.disable();
    allowSleep();
  });

  async function pickAndClaim() {
    while (pickerBusy) await sleep(25);
    pickerBusy = true;
    try {
      // Phase 79 (P2) — compute the billing window gate ONCE per tick so the
      // picker admits only cheap jobs (and defers heavy ones) while the shared
      // window is 'warn'. resolvedCfg carries the static billing thresholds;
      // windowStatus reads the live call count fresh each tick. A gate failure
      // degrades to the pre-phase-79 unconditional pick (fail-open).
      let gate = {};
      try { gate = windowGate(resolvedCfg); } catch { /* fail-open: unconditional pick */ }
      const job = nextPendingJobForFreeProject(gate);
      if (!job) return null;
      const won = tryClaimJob(job.id);
      return won ? getJob(job.id) : null;
    } finally {
      pickerBusy = false;
    }
  }

  async function worker(workerId) {
    while (!stopping) {
      let job;
      try {
        job = await pickAndClaim();
      } catch (err) {
        // A transient SQLite/config picker failure must not permanently remove
        // one worker from the overnight pool. Back off and keep serving.
        console.error(chalk.red(`[w${workerId}] Queue picker failed (worker remains alive):`), err.message);
        await sleep(2000);
        continue;
      }
      if (!job) {
        await sleep(2000);
        continue;
      }
      activeJobIds.add(job.id);
      const leaseHeartbeat = setInterval(() => {
        try { heartbeatJobLease(job.id, { leaseToken: job.lease_token }); }
        catch (err) { console.warn(chalk.yellow(`[w${workerId}] Job #${job.id} lease heartbeat failed: ${err.message}`)); }
      }, JOB_HEARTBEAT_MS);
      leaseHeartbeat.unref();
      console.log(chalk.cyan(`[w${workerId}] ▶ Picking up job #${job.id}: ${job.action} ${job.project}`));
      try {
        await workerContext.run(
          { workerId, project: job.project, jobId: job.id, action: job.action, leaseToken: job.lease_token },
          async () => { await executeJob(job, notifier); },
        );
      } catch (err) {
        console.error(chalk.red(`[w${workerId}] Job #${job.id} failed:`), err.message);
        try {
          const { getJob, markJobFailed } = await import('./server/job-queue.js');
          const j = getJob(job.id);
          if (j && j.status === 'running') {
            markJobFailed(job.id, `worker caught uncaught: ${err.message || String(err)}`, { leaseToken: job.lease_token });
          }
        } catch (sweepErr) {
          console.error(chalk.red(`[w${workerId}] Could not sweep stuck job:`), sweepErr.message);
        }
      } finally {
        clearInterval(leaseHeartbeat);
        activeJobIds.delete(job.id);
      }
      await sleep(250);
    }
  }

  const workers = [];
  for (let i = 1; i <= maxWorkers; i++) {
    workers.push(worker(i));
  }
  const drainTimeout = new Promise((resolve) => {
    const poll = setInterval(() => {
      if (!stopping) return;
      clearInterval(poll);
      setTimeout(() => {
        console.log(chalk.yellow('\n[server] Drain timeout reached (60s) — forcing exit.'));
        const killed = killAll({ reason: 'drain timeout — preventing orphaned subprocesses' });
        if (killed > 0) console.log(chalk.dim(`  SIGTERM sent to ${killed} in-flight subprocess(es).`));
        resolve();
      }, 60_000);
    }, 100);
  });
  await Promise.race([Promise.all(workers), drainTimeout]);

  console.log(chalk.green('\nServer stopped.'));
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

main().catch((err) => {
  console.error(chalk.red('Fatal:'), err);
  process.exit(1);
});
