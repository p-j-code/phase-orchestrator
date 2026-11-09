#!/usr/bin/env node
// Headless durable queue worker.
//
// The Telegram/Discord servers already host worker pools, but the NAS web UI
// is intentionally independent of bot credentials. Running this small worker
// under PM2 guarantees that jobs submitted by the web UI survive a web-server
// restart, host reboot, or provider-window pause. SQLite claims/leases keep it
// safe to run alongside a bot server: only one process can claim a row.

import chalk from 'chalk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from './lib/env-file.js';

// PM2/systemd starts the worker with a bare environment on the NAS. Load the
// deployment file before dynamically importing config/state modules so both
// Claude auth/bin settings and an optional DB_PATH are visible at module init.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
await loadDotEnv(path.join(REPO_ROOT, '.env'));

const { resolve: resolveConfig } = await import('./config-resolver.js');
const {
  nextPendingJobForFreeProject,
  tryClaimJob,
  createJobLeaseGuard,
  reconcileStaleRunningJobs,
  expireStalePendingJobs,
  recoverJobAfterWorkerShutdown,
  getJob,
  markJobFailed,
  windowGate,
  JOB_HEARTBEAT_MS,
  heartbeatWorker,
  removeWorkerHeartbeat,
} = await import('./server/job-queue.js');
const { executeJob } = await import('./server/job-runner.js');
const { workerContext } = await import('./lib/worker-context.js');
const { killAll, killCurrent } = await import('./claude-runner.js');
const { assertExecutionHost } = await import('./lib/execution-host-policy.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RECONCILE_INTERVAL_MS = 60_000;
const WORKER_STATUS_HEARTBEAT_MS = 5_000;

export function resolveWorkerCount(cfg = {}) {
  const configured = cfg?.job_runner?.max_concurrent_projects;
  const cap = Math.max(1, Number.parseInt(cfg?.job_runner?.max_workers_cap, 10) || 8);
  return configured === 'auto'
    ? cap
    : Math.max(1, Math.min(cap, Number.parseInt(configured, 10) || 1));
}

export function createHeadlessNotifier() {
  return {
    platform: 'headless',
    notify: async ({ text } = {}) => {
      if (text) console.log(chalk.dim(`[worker-notify] ${String(text).replace(/<[^>]+>/g, '')}`));
    },
  };
}

export async function runHeadlessWorker({
  pollMs = 2000,
  notifier = createHeadlessNotifier(),
  shouldStop = () => false,
  onActiveJobChange = () => {},
  workerId = 1,
  cfgOverride = null,
  manageReconciliation = true,
  executeJobFn = executeJob,
} = {}) {
  const cfg = cfgOverride ?? await resolveConfig({ task: 'dev-execution' });
  const reconcile = (reason, label) => {
    const recovery = reconcileStaleRunningJobs({ reason });
    const changed = recovery.recovered.length + recovery.failed.length + recovery.deduplicated.length;
    if (changed) {
      console.log(chalk.yellow(
        `[worker] ${label}: ${recovery.recovered.length} requeued, ` +
        `${recovery.deduplicated.length} deduplicated, ${recovery.failed.length} failed closed`,
      ));
    }
    return recovery;
  };
  // Startup recovery must not kill the process: under multi-process contention
  // the reconcile transaction can throw SQLITE_BUSY, and an unguarded throw
  // here propagates to main().catch → process.exit(1) → PM2 restart loop.
  if (manageReconciliation) {
    try { reconcile('headless worker restarted before this job finished', 'startup recovery'); }
    catch (err) { console.warn(chalk.yellow(`[worker] startup recovery failed (will retry periodically): ${err.message}`)); }
    // Don't fire heavy Claude jobs queued days ago on a host that had no
    // worker: expire them with an outbox notice; the operator re-queues.
    try {
      const expired = expireStalePendingJobs({ maxAgeHours: cfg.queue?.pending_job_max_age_hours ?? 48 });
      if (expired.length) {
        console.log(chalk.yellow(`[worker] expired ${expired.length} stale pending job(s): ${expired.map((j) => `#${j.id} ${j.project}/${j.action}`).join(', ')}`));
      }
    } catch (err) {
      console.warn(chalk.yellow(`[worker] stale-pending expiry failed (non-fatal): ${err.message}`));
    }
  }

  while (!shouldStop()) {
    let job = null;
    try {
      let gate = {};
      try { gate = windowGate(cfg); } catch { /* fail open; runner still has the hard guard */ }
      const candidate = nextPendingJobForFreeProject(gate);
      if (candidate && tryClaimJob(candidate.id)) job = getJob(candidate.id);
    } catch (err) {
      console.error(chalk.red(`[worker w${workerId}] queue picker failed (will retry): ${err.message}`));
      await sleep(pollMs);
      continue;
    }

    if (!job) {
      await sleep(pollMs);
      continue;
    }

    console.log(chalk.cyan(`[worker w${workerId}] ▶ job #${job.id}: ${job.action} ${job.project}`));
    onActiveJobChange(job, workerId);
    // A false lease renewal proves another process reclaimed this job (host
    // sleep, event-loop stall past the lease TTL). Kill our subprocess so two
    // Claude runs can never write the same workspace concurrently.
    const leaseGuard = createJobLeaseGuard({
      id: job.id,
      leaseToken: job.lease_token,
      onLeaseLost: () => {
        console.warn(chalk.yellow(`[worker w${workerId}] job #${job.id} lease lost — cancelling subprocess`));
        killCurrent({ jobId: job.id, reason: 'job lease lost to another worker' });
      },
      onHeartbeatError: (err) => console.warn(chalk.yellow(`[worker w${workerId}] job #${job.id} heartbeat failed: ${err.message}`)),
    });
    const heartbeat = setInterval(() => leaseGuard.heartbeat(), JOB_HEARTBEAT_MS);
    heartbeat.unref();
    try {
      await workerContext.run(
        {
          workerId: `headless-${workerId}`, project: job.project, jobId: job.id,
          action: job.action, leaseToken: job.lease_token,
        },
        async () => executeJobFn(job, notifier, { isShuttingDown: shouldStop }),
      );
    } catch (err) {
      console.error(chalk.red(`[worker w${workerId}] job #${job.id} failed: ${err.message}`));
      try {
        const current = getJob(job.id);
        if (current?.status === 'running' && !shouldStop()) {
          markJobFailed(job.id, `headless worker caught uncaught: ${err.message}`, { leaseToken: job.lease_token });
        }
      } catch (sweepErr) {
        console.error(chalk.red(`[worker w${workerId}] could not terminalize job #${job.id}: ${sweepErr.message}`));
      }
    } finally {
      clearInterval(heartbeat);
      // Remove from activeJobs BEFORE calling recoverJobAfterWorkerShutdown so
      // that the forced-exit timer in stop() cannot iterate the map and call
      // recoverJobAfterWorkerShutdown a second time for the same job while this
      // finally block is still executing. Without this ordering the timer fires
      // after 8 s, sees the job still in activeJobs, and produces a duplicate
      // pending row that causes the job to run twice.
      onActiveJobChange(null, workerId);
      if (shouldStop() && !leaseGuard.leaseLost) {
        const recovered = recoverJobAfterWorkerShutdown(job.id, {
          reason: 'PM2/host shutdown interrupted the headless worker',
          leaseToken: job.lease_token,
        });
        if (recovered.recovered) {
          console.log(chalk.yellow(`[worker w${workerId}] job #${job.id} requeued as ${recovered.action}`));
        }
      }
    }
    await sleep(250);
  }
}

async function main() {
  const executionHost = await assertExecutionHost({ entrypoint: 'durable queue worker startup' });
  console.log(chalk.dim(
    `[execution-host] ${executionHost.currentRole}/${executionHost.currentHostId} owns execution authority`,
  ));
  const cfg = await resolveConfig({ task: 'dev-execution' });
  const maxWorkers = resolveWorkerCount(cfg);
  let stopping = false;
  const activeJobs = new Map();
  const workerStartedAt = new Date().toISOString();
  const publishHeartbeat = () => {
    if (stopping) return;
    try {
      heartbeatWorker({
        startedAt: workerStartedAt,
        capacity: maxWorkers,
        activeJobs: [...activeJobs.values()].map((job) => ({
          id: Number(job.id), project: job.project, action: job.action,
        })),
      });
    } catch (err) {
      console.warn(chalk.yellow(`[worker] status heartbeat failed: ${err.message}`));
    }
  };
  publishHeartbeat();
  const statusHeartbeat = setInterval(publishHeartbeat, WORKER_STATUS_HEARTBEAT_MS);
  statusHeartbeat.unref();
  let forcedExit = null;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    clearInterval(statusHeartbeat);
    try { removeWorkerHeartbeat(); } catch { /* best-effort shutdown signal */ }
    console.log(chalk.yellow(`[worker] ${signal}: stopping in-flight subprocesses and checkpointing the job`));
    const killed = killAll({ reason: `${signal}: supervised worker restart` });
    if (killed) console.log(chalk.dim(`[worker] SIGTERM sent to ${killed} Claude process group(s)`));
    forcedExit = setTimeout(() => {
      for (const activeJob of activeJobs.values()) {
        try {
          recoverJobAfterWorkerShutdown(activeJob.id, {
            reason: `${signal}: forced worker exit after child termination`,
            leaseToken: activeJob.lease_token,
          });
        } catch (err) {
          console.error(chalk.red(`[worker] forced recovery failed for job #${activeJob.id}: ${err.message}`));
        }
      }
      process.exit(0);
    }, 8_000);
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
  // Periodic lease reconciliation runs on its own timer, not inside a worker's
  // job loop — a loop-embedded reconcile starves for the entire duration of a
  // multi-hour go/resume job, which is exactly when orphaned siblings need it.
  const reconcileTimer = setInterval(() => {
    if (stopping) return;
    try {
      const recovery = reconcileStaleRunningJobs({ reason: 'queue lease expired while the worker remained online' });
      const changed = recovery.recovered.length + recovery.failed.length + recovery.deduplicated.length;
      if (changed) {
        console.log(chalk.yellow(
          `[worker] periodic recovery: ${recovery.recovered.length} requeued, ` +
          `${recovery.deduplicated.length} deduplicated, ${recovery.failed.length} failed closed`,
        ));
      }
    } catch (err) {
      console.warn(chalk.yellow(`[worker] periodic recovery failed (will retry): ${err.message}`));
    }
  }, RECONCILE_INTERVAL_MS);
  reconcileTimer.unref();
  console.log(chalk.green(
    `[worker] durable headless queue worker online (${maxWorkers} project slot${maxWorkers === 1 ? '' : 's'}; provider calls remain lease-serialized)`,
  ));
  await Promise.all(Array.from({ length: maxWorkers }, (_, index) => runHeadlessWorker({
    shouldStop: () => stopping,
    cfgOverride: cfg,
    workerId: index + 1,
    manageReconciliation: index === 0,
    onActiveJobChange: (job, id) => {
      if (job) activeJobs.set(id, job);
      else activeJobs.delete(id);
      publishHeartbeat();
    },
  })));
  clearInterval(reconcileTimer);
  clearInterval(statusHeartbeat);
  try { removeWorkerHeartbeat(); } catch { /* best-effort */ }
  if (forcedExit) clearTimeout(forcedExit);
}

// PM2 fork mode launches ESM through a wrapper process, so process.argv[1] is
// pm2's ProcessContainer — not this file — even though `ps`/`pm2 list` show
// "worker.js" (pm2 rewrites the process title). The direct-entry check is then
// false and main() never runs: the worker shows "online" but sits idle,
// consuming no jobs and writing no logs. Also start when pm2 owns this process
// (pm_id is set in the child env). Tests import this module with no pm_id, so
// they still skip main().
const launchedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (launchedDirectly || process.env.pm_id !== undefined) {
  main().then(() => process.exit(0)).catch((err) => {
    console.error(chalk.red(`[worker] fatal: ${err.stack || err.message}`));
    process.exit(1);
  });
}
