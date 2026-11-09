#!/usr/bin/env node
// Orchestrator Server — long-running daemon that hosts the Discord bot and
// processes the job queue.
//
// Usage:  npm run server
// Stops:  Ctrl-C (graceful drain) or kill <pid>

import { Client, GatewayIntentBits, Events, MessageFlags } from 'discord.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';

// ─── Per-worker log prefixing via AsyncLocalStorage ────────────────────────
import { workerContext } from './lib/worker-context.js';
import { liveStatus } from './lib/live-status.js';
import { registerCommandMenu } from './lib/command-menu.js';
import { makeCtx, makeMessageCtx } from './lib/discord-compat.js';

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
import { Notifier } from './server/notifier.js';
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
} from './server/discord-handlers.js';
import {
  handlePreview, handleFiles, handleFile,
} from './server/discord-preview-handlers.js';
import {
  handlePredict, handleBudget, handleInspect, handleRetryPhase, handlePromote,
  handleQaHandoff, handleValidate, handleValidators, handleDashboard, handlePackage,
  handleCoach, handleExtend, handleBriefQuestions,
  handleRemoveProject, handleSpend, handleAddBug,
} from './server/discord-parity-handlers.js';
import { resolve as resolveConfig } from './config-resolver.js';
import { runCleanup } from './lib/log-cleanup.js';
import { preventSleep, allowSleep, configureWakeLock, wakeLockStatus } from './lib/wake-lock.js';
import { startWatchdog, stopWatchdog } from './lib/project-watchdog.js';
import { startOperatorQuestionsPoller, stopOperatorQuestionsPoller } from './lib/operator-questions.js';
import { startNotifyOutboxDelivery, stopNotifyOutboxDelivery } from './lib/notify-outbox.js';
import { startAutopilot, stopAutopilot } from './lib/portfolio-autopilot.js';
import { assertExecutionHost } from './lib/execution-host-policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DISCORD_CONFIG_PATH = path.join(REPO_ROOT, 'config', 'discord.json');
const DISCORD_CONFIG_EXAMPLE_PATH = path.join(REPO_ROOT, 'config', 'discord.json.example');
const USER_CONFIG_PATH = path.join(os.homedir(), '.ashmero-orchestrator', 'user.json');

async function loadDiscordConfig() {
  // First-boot: copy example to live path if discord.json doesn't exist yet
  try {
    await fs.access(DISCORD_CONFIG_PATH);
  } catch {
    try {
      await fs.access(DISCORD_CONFIG_EXAMPLE_PATH);
      await fs.copyFile(DISCORD_CONFIG_EXAMPLE_PATH, DISCORD_CONFIG_PATH);
      console.warn(chalk.yellow(
        '⚠ First-run: copied config/discord.json.example to config/discord.json. ' +
        'Fill in your bot_token, client_id, guild_id, and channel_id.',
      ));
    } catch { /* .example missing — fall through */ }
  }

  // Prefer config/discord.json, fall back to user.json discord block
  try {
    const cfg = JSON.parse(await fs.readFile(DISCORD_CONFIG_PATH, 'utf-8'));
    if (cfg.bot_token && cfg.bot_token !== 'YOUR_DISCORD_BOT_TOKEN_HERE') return cfg;
  } catch {}
  try {
    const userCfg = JSON.parse(await fs.readFile(USER_CONFIG_PATH, 'utf-8'));
    if (userCfg.discord?.bot_token) return userCfg.discord;
  } catch {}
  return null;
}

// ─── Slash command → handler map ─────────────────────────────────────────────
function buildHandlerMap() {
  return {
    start:            handleStart,
    auth:             handleAuth,
    status:           handleStatus,
    projects:         handleProjects,
    project:          handleProject,
    queue:            handleQueue,
    run:              handleRun,
    cancel:           handleCancel,
    dequeue:          handleDequeue,
    users:            handleUsers,
    history:          handleHistory,
    download:         handleDownload,
    req:              handleReq,
    capture:          handleCapture,
    done:             handleDone,
    inbox:            handleInbox,
    req_promote:      handleReqPromote,
    triage:           handleTriage,
    help:             handleHelp,
    docs:             handleDocs,
    pin:              handlePin,
    unpin:            handleUnpin,
    pinned:           handlePinned,
    bug:              handleBug,
    bug_capture:      handleBugCapture,
    bug_done:         handleBugDone,
    bugs_inbox:       handleBugsInbox,
    bug_promote:      handleBugPromote,
    ship:             handleShip,
    git_status:       handleGitStatus,
    sync:             handleSync,
    syncall:          handleSyncAll,
    new_project:      handleNewProject,
    suggest:          handleSuggest,
    newbrief:         handleNewbrief,
    discuss:          handleDiscuss,
    discuss_inspect:  handleDiscussInspect,
    preview:          handlePreview,
    files:            handleFiles,
    file:             handleFile,
    predict:          handlePredict,
    budget:           handleBudget,
    inspect:          handleInspect,
    retry:            handleRetryPhase,
    promote:          handlePromote,
    qa_handoff:       handleQaHandoff,
    validate:         handleValidate,
    validators:       handleValidators,
    dashboard:        handleDashboard,
    package:          handlePackage,
    coach:            handleCoach,
    extend:           handleExtend,
    brief_questions:  handleBriefQuestions,
    remove_project:   handleRemoveProject,
    spend:            handleSpend,
    add_bug:          handleAddBug,
  };
}

async function main() {
  console.log(chalk.bold.cyan('═══ Orchestrator Server ═══\n'));

  const executionHost = await assertExecutionHost({ entrypoint: 'Discord queue server startup' });
  console.log(chalk.dim(
    `[execution-host] ${executionHost.currentRole}/${executionHost.currentHostId} owns execution authority`,
  ));

  liveStatus.enable();

  const cfg = await loadDiscordConfig();
  if (!cfg || !cfg.bot_token) {
    console.error(chalk.red('No Discord bot token configured.'));
    console.error(chalk.dim('Copy config/discord.json.example → config/discord.json and fill in your values.'));
    process.exit(1);
  }

  // Recover replay-safe work from a crashed server while preserving live jobs
  // owned by another process. Destructive/non-idempotent jobs fail closed.
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

  // Sync DB state with plan.json on every boot
  const { repairProjectStates } = await import('./lib/state-repair.js');
  await repairProjectStates().catch((err) => {
    console.warn(chalk.yellow(`[state-repair] Failed: ${err.message} (continuing)`));
  });

  // Cleanup: once at boot, then periodically
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

  // Wake lock: keep macOS awake for the entire server lifetime
  configureWakeLock({ enabled: resolvedCfg?.wake_lock?.enabled !== false });
  preventSleep();
  const wls = wakeLockStatus();
  if (wls.supported && wls.enabled) {
    console.log(chalk.dim('✓ Wake lock active (caffeinate) — system will not sleep while server is running.'));
  }

  // ─── Discord client setup ────────────────────────────────────────────────
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  const notifier = new Notifier(client, cfg.channel_id);

  // Project watchdog — periodically resumes projects paused by recoverable errors
  const watchdogIntervalMs = resolvedCfg?.auto_heal?.watchdog_interval_ms ?? 60_000;
  if (resolvedCfg?.auto_heal?.enabled !== false && resolvedCfg?.auto_heal?.watchdog_enabled !== false) {
    startWatchdog({ intervalMs: watchdogIntervalMs, cfg: resolvedCfg, notifier });
  }

  // Operator-questions poller (Phase 49): Discord is TEXT-ONLY notification —
  // no inline buttons (out of scope this cycle; parity later). Answering an
  // operator question is Telegram-only (/oq or its inline keyboard) for now.
  const oqPollIntervalMs = resolvedCfg?.operator_questions?.poll_interval_ms ?? 30_000;
  startOperatorQuestionsPoller({ intervalMs: oqPollIntervalMs, cfg: resolvedCfg, notifier, includeButtons: false });

  // Notify-outbox delivery loop (Phase 58 — pings independent of launch
  // surface): every run-lifecycle notice queued by auto-runner.js's
  // queueNotify() lands here as the fallback deliverer. A bare detached CLI
  // launch (web spawnOrchestrator / chat spawnDetached) runs autoRun() with
  // notifier:null, so its pings are ONLY durable in notify_outbox — this 10s
  // loop is what actually gets them onto the phone. Rows a live-notifier fast
  // path already marked delivered are filtered out (status = 'pending' only).
  startNotifyOutboxDelivery({ intervalMs: 10_000, notifier });

  // Nightly portfolio autopilot (Phase 86 — P7b). Self-gates: no-ops when
  // autopilot.enabled is false (default), and FAILS CLOSED (registers no timer)
  // when brief 04's deny-rule sandbox is unresolvable — unattended overnight
  // jobs must never run under unrestricted Bash.
  startAutopilot({ cfg: resolvedCfg, notifier });

  // ─── Event: ready ────────────────────────────────────────────────────────
  client.once(Events.ClientReady, async (c) => {
    console.log(chalk.green(`✓ Bot online: ${c.user.tag}`));
    // Register slash commands after client is ready (need application.id)
    await registerCommandMenu(client, cfg.guild_id || null);
    notifier.notify({ text: '🟢 Orchestrator server online.\nUse /status to see queue.' }).catch(() => {});
  });

  // ─── Event: slash commands and button presses ─────────────────────────────
  const handlerMap = buildHandlerMap();

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        const handler = handlerMap[interaction.commandName];
        if (!handler) {
          await interaction.reply({ content: `Unknown command: \`${interaction.commandName}\``, flags: MessageFlags.Ephemeral });
          return;
        }
        // Defer immediately — gives 15 minutes instead of 3 seconds.
        // The compat layer's ctx.reply() uses editReply() when deferred.
        await interaction.deferReply();
        const ctx = makeCtx(interaction);
        await handler(ctx);
      } else if (interaction.isButton()) {
        // deferUpdate acknowledges the click without changing the message yet.
        // The compat layer then uses editReply() to show the actual response.
        await interaction.deferUpdate();
        const ctx = makeCtx(interaction);
        await handleCallback(ctx);
      } else if (interaction.isStringSelectMenu()) {
        await interaction.deferUpdate();
        const ctx = makeCtx(interaction);
        // Route select menus by customId prefix
        if (interaction.customId === 'proj_pick') {
          await handleProject(ctx); // ctx.match = interaction.values[0] (project name)
        }
      }
    } catch (err) {
      // Suppress "Unknown interaction" noise (expired or double-acknowledged interactions)
      if (err.code === 10062) return;
      console.error(chalk.red('[interaction error]'), err.message);
      try {
        const msg = { content: `⚠ An error occurred: ${err.message}`, flags: MessageFlags.Ephemeral };
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp(msg);
        } else {
          await interaction.reply(msg);
        }
      } catch { /* swallow secondary error */ }
    }
  });

  // ─── Event: plain messages (capture mode) ────────────────────────────────
  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    try {
      const ctx = makeMessageCtx(message);
      await handleMessage(ctx);
    } catch (err) {
      console.error(chalk.red('[message error]'), err.message);
    }
  });

  // ─── Login ───────────────────────────────────────────────────────────────
  console.log(chalk.green('✓ Bot connecting (Discord gateway)...'));
  await client.login(cfg.bot_token);

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
    stopNotifyOutboxDelivery();
    stopAutopilot();
    console.log(chalk.yellow('\nGraceful shutdown initiated. Waiting on current jobs to finish…'));
    if (activeJobIds.size > 0) {
      console.log(chalk.dim(`  Active jobs: ${[...activeJobIds].map((id) => '#' + id).join(', ')}`));
    }
    await notifier.notify({ text: '🔴 Orchestrator server shutting down.' }).catch(() => {});
    liveStatus.disable();
    allowSleep();
    await client.destroy().catch(() => {});
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
        // Do not let one transient picker/SQLite error permanently shrink the
        // overnight worker pool. Back off, then continue the same worker.
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
