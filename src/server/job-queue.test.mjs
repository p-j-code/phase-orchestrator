// Phase 19 (brief P2, auto-refresh half) — src/server/job-queue.test.mjs
//
// enqueueContextRefreshJob: the atomic dedupe-enqueue path phase-runner.js's
// loadContextFreshnessCheck calls when a project's narrative context has
// drifted past a threshold. Mirrors enqueueRoadmapJob's precedent (same
// check-then-insert transaction shape) but keyed on args_json.task since
// 'guide' is shared by every guide task, unlike roadmap's dedicated action.
//
// Run with: node --test src/server/job-queue.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
// Keep any claude-runner import (fair-share composition test) off ~/.claude.json.
process.env.ORCHESTRATOR_SKIP_TRUST = '1';

const {
  getDb, deleteProject, upsertProject, reserveProjectDeletion,
  releaseProjectDeletion, claimRunningJob, releaseRunningJob,
} = await import('../state.js');
const {
  enqueueContextRefreshJob, enqueueJob, getJob, markJobRunning, markJobCompleted, markJobFailed,
  enqueueUniqueActionJob, enqueueProjectIdleActionJob, cancelPendingJobsForProject,
  enqueueUniqueResumeJob, nextPendingJobForFreeProject, tryClaimJob, heartbeatJobLease,
  reconcileStaleRunningJobs, recoverJobAfterWorkerShutdown, requestJobCancellation,
  jobCostClass, JOB_COST_CLASS, windowGate, reorderPendingJob, retryTerminalJob,
  heartbeatWorker, listWorkerHeartbeats, removeWorkerHeartbeat,
} = await import('./job-queue.js');

// Phase 79 (P2) — window-aware picker fixtures. resetJobs() isolates each picker
// test from the shared :memory: DB (tests run in definition order; earlier
// suites leave pending rows the FIFO picker would otherwise return).
function resetJobs() {
  getDb().exec('DELETE FROM tg_jobs; DELETE FROM auto_runs;');
}

function setupRecoveryProject(name, status = 'in-progress') {
  getDb().prepare(`
    INSERT OR REPLACE INTO projects (name, created_at, status)
    VALUES (?, ?, ?)
  `).run(name, new Date().toISOString(), status);
}
const WARN = { state: 'warn', pauseThreshold: 100, callsInWindow: 90, oldestCallAt: '2026-07-12T00:00:00Z' };
const OK = { state: 'ok', pauseThreshold: 100, callsInWindow: 10, oldestCallAt: null };
const FUTURE_RESET = new Date(Date.now() + 5 * 3600 * 1000);
// SQLite 'YYYY-MM-DD HH:MM:SS' (UTC) → Date, matching how the picker/enqueueRetryJob write not_before.
const parseSqliteUtc = (s) => new Date(s.replace(' ', 'T') + 'Z');

test('enqueueContextRefreshJob: first call inserts a pending guide/project-context-gen job', () => {
  const id = enqueueContextRefreshJob({ project: 'demo-project-a' });
  assert.ok(id, 'expected a truthy row id');
  const job = getJob(id);
  assert.equal(job.project, 'demo-project-a');
  assert.equal(job.action, 'guide');
  assert.equal(job.status, 'pending');
  assert.deepEqual(JSON.parse(job.args_json), { task: 'project-context-gen' });
});

test('enqueueContextRefreshJob: a second call while the first is still pending enqueues nothing (dedupe)', () => {
  const first = enqueueContextRefreshJob({ project: 'demo-project-b' });
  assert.ok(first);
  const second = enqueueContextRefreshJob({ project: 'demo-project-b' });
  assert.equal(second, null, 'a pending refresh already exists — must not enqueue a duplicate');
});

test('enqueueContextRefreshJob: a second call while the first is RUNNING also enqueues nothing (dedupe covers pending + running)', () => {
  const first = enqueueContextRefreshJob({ project: 'demo-project-c' });
  assert.ok(first);
  // Simulate the worker claiming the job (pending -> running).
  getDb().prepare(`UPDATE tg_jobs SET status = 'running' WHERE id = ?`).run(first);
  const second = enqueueContextRefreshJob({ project: 'demo-project-c' });
  assert.equal(second, null);
});

test('enqueueContextRefreshJob: re-enqueues once the prior refresh has completed (dedupe only blocks pending/running)', () => {
  const first = enqueueContextRefreshJob({ project: 'demo-project-d' });
  assert.ok(first);
  markJobRunning(first);
  markJobCompleted(first, 'refreshed');
  const second = enqueueContextRefreshJob({ project: 'demo-project-d' });
  assert.ok(second, 'a completed prior refresh must not block a new one');
  assert.notEqual(second, first);
});

test('enqueueContextRefreshJob: re-enqueues once the prior refresh has failed', () => {
  const first = enqueueContextRefreshJob({ project: 'demo-project-e' });
  assert.ok(first);
  markJobRunning(first);
  markJobFailed(first, 'boom');
  const second = enqueueContextRefreshJob({ project: 'demo-project-e' });
  assert.ok(second);
});

test('enqueueContextRefreshJob: dedupe is scoped per-project — another project can enqueue independently', () => {
  const a = enqueueContextRefreshJob({ project: 'demo-project-f1' });
  const b = enqueueContextRefreshJob({ project: 'demo-project-f2' });
  assert.ok(a);
  assert.ok(b);
});

test('enqueueContextRefreshJob: a pending job for a DIFFERENT guide task on the same project does not block the refresh', () => {
  enqueueJob({ project: 'demo-project-g', action: 'guide', args: { task: 'plan' }, requestedBy: null });
  const id = enqueueContextRefreshJob({ project: 'demo-project-g' });
  assert.ok(id, 'a pending plan job must not count against project-context-gen dedupe');
});

test('enqueueUniqueActionJob: web brief-chain submissions dedupe while pending/running', () => {
  resetJobs();
  const first = enqueueUniqueActionJob({ project: 'durable-chain', action: 'brief-chain', args: { unattended: true } });
  const second = enqueueUniqueActionJob({ project: 'durable-chain', action: 'brief-chain', args: { unattended: true } });
  assert.equal(first.scheduled, true);
  assert.equal(second.scheduled, false);
  assert.equal(second.jobId, first.jobId);
  assert.deepEqual(JSON.parse(getJob(first.jobId).args_json), { unattended: true });
  tryClaimJob(first.jobId);
  const third = enqueueUniqueActionJob({ project: 'durable-chain', action: 'brief-chain' });
  assert.equal(third.scheduled, false, 'running job also owns the unique action slot');
});

test('enqueueUniqueActionJob: a terminal action can be enqueued again', () => {
  resetJobs();
  const first = enqueueUniqueActionJob({ project: 'durable-chain-repeat', action: 'brief-chain' });
  tryClaimJob(first.jobId);
  markJobCompleted(first.jobId, 'done');
  const next = enqueueUniqueActionJob({ project: 'durable-chain-repeat', action: 'brief-chain' });
  assert.equal(next.scheduled, true);
  assert.notEqual(next.jobId, first.jobId);
});

test('enqueueUniqueActionJob: distinct guide tasks do not falsely deduplicate', () => {
  resetJobs();
  const plan = enqueueUniqueActionJob({ project: 'guide-task-scope', action: 'guide', args: { task: 'plan' } });
  const context = enqueueUniqueActionJob({ project: 'guide-task-scope', action: 'guide', args: { task: 'project-context-gen' } });
  const duplicateContext = enqueueUniqueActionJob({ project: 'guide-task-scope', action: 'guide', args: { task: 'project-context-gen' } });
  assert.equal(plan.scheduled, true);
  assert.equal(context.scheduled, true);
  assert.notEqual(context.jobId, plan.jobId);
  assert.equal(duplicateContext.scheduled, false);
  assert.equal(duplicateContext.jobId, context.jobId);
});

test('enqueueProjectIdleActionJob fails closed for any queued job or active auto-run', () => {
  resetJobs();
  setupRecoveryProject('idle-gate');
  const blocker = enqueueJob({ project: 'idle-gate', action: 'audit', requestedBy: null });
  const blockedByJob = enqueueProjectIdleActionJob({ project: 'idle-gate', action: 'resume' });
  assert.equal(blockedByJob.scheduled, false);
  assert.deepEqual(blockedByJob.blocker, {
    type: 'job', id: Number(blocker), action: 'audit', status: 'pending',
  });

  getDb().prepare('DELETE FROM tg_jobs WHERE id = ?').run(blocker);
  const runId = getDb().prepare(`
    INSERT INTO auto_runs (project, started_at, status) VALUES (?, ?, 'running')
  `).run('idle-gate', new Date().toISOString()).lastInsertRowid;
  const blockedByRun = enqueueProjectIdleActionJob({ project: 'idle-gate', action: 'resume' });
  assert.equal(blockedByRun.scheduled, false);
  assert.deepEqual(blockedByRun.blocker, {
    type: 'auto_run', id: Number(runId), status: 'running',
  });

  getDb().prepare(`UPDATE auto_runs SET status='paused' WHERE id=?`).run(runId);
  const queued = enqueueProjectIdleActionJob({ project: 'idle-gate', action: 'resume' });
  assert.equal(queued.scheduled, true);
  assert.equal(getJob(queued.jobId).action, 'resume');
});

test('cancelPendingJobsForProject terminalizes only selected continuation actions', () => {
  resetJobs();
  const resume = enqueueJob({ project: 'abort-pending', action: 'resume', requestedBy: null });
  const chain = enqueueJob({ project: 'abort-pending', action: 'brief-chain', requestedBy: null });
  const audit = enqueueJob({ project: 'abort-pending', action: 'audit', requestedBy: null });
  const cancelled = cancelPendingJobsForProject('abort-pending', {
    actions: ['resume', 'brief-chain'], reason: 'operator abort',
  });
  assert.deepEqual(cancelled, [Number(resume), Number(chain)]);
  assert.equal(getJob(resume).status, 'cancelled');
  assert.equal(getJob(chain).status, 'cancelled');
  assert.equal(getJob(audit).status, 'pending');
});

test('requestJobCancellation is idempotent and preserves the first request metadata', async () => {
  resetJobs();
  // 'audit' — 'qa' joined NON_CANCELLABLE_ACTIONS, so this queue-layer test
  // needs a cancellable action to exercise idempotency.
  const id = enqueueJob({ project: 'cancel-idempotent', action: 'audit', requestedBy: null });
  markJobRunning(id);
  assert.equal(requestJobCancellation(id, 'first reason'), true);
  const first = getJob(id);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(requestJobCancellation(id, 'second reason'), true);
  const second = getJob(id);
  assert.equal(second.cancel_requested_at, first.cancel_requested_at);
  assert.equal(second.error_message, 'first reason');
  assert.equal(markJobCompleted(id, 'must not complete'), false);
  assert.equal(getJob(id).status, 'running');
});

test('project deletion cleans non-FK control rows and tombstones enqueue until explicit recreation', () => {
  resetJobs();
  const project = 'deleted-generation';
  upsertProject({ name: project, tech_stack: 'node', status: 'planning' });
  const terminal = enqueueJob({ project, action: 'qa', requestedBy: null });
  markJobRunning(terminal);
  markJobFailed(terminal, 'old generation');
  const db = getDb();
  db.prepare(`
    INSERT INTO operator_questions (project, question, assumption, created_at)
    VALUES (?, 'old question', 'old assumption', ?)
  `).run(project, new Date().toISOString());
  db.prepare(`
    INSERT INTO autopilot_approvals (project, action, remaining_nights, created_at)
    VALUES (?, 'brief', 1, ?)
  `).run(project, new Date().toISOString());
  db.prepare(`INSERT INTO running_jobs (project, pid, started_at) VALUES (?, ?, ?)`)
    .run(project, 2_147_483_646, new Date().toISOString());
  db.prepare(`INSERT INTO detached_spawns (project, action, pid, started_at) VALUES (?, 'old', ?, ?)`)
    .run(project, 2_147_483_646, new Date().toISOString());

  deleteProject(project);
  for (const table of ['tg_jobs', 'operator_questions', 'autopilot_approvals', 'running_jobs', 'detached_spawns']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project = ?`).get(project).n, 0, table);
  }
  assert.ok(db.prepare(`SELECT * FROM project_tombstones WHERE project = ?`).get(project));
  assert.throws(
    () => enqueueJob({ project, action: 'resume', requestedBy: null }),
    (err) => err?.code === 'PROJECT_DELETED',
  );

  upsertProject({ name: project, tech_stack: 'node', status: 'planning' });
  assert.equal(db.prepare(`SELECT * FROM project_tombstones WHERE project = ?`).get(project), undefined);
  assert.ok(enqueueJob({ project, action: 'resume', requestedBy: null }));
});

test('deletion reservation atomically fences queue enqueue and CLI running-job claims', () => {
  resetJobs();
  const project = 'delete-reservation';
  upsertProject({ name: project, tech_stack: 'node', status: 'planning' });
  assert.equal(reserveProjectDeletion(project).reserved, true);
  assert.throws(
    () => enqueueJob({ project, action: 'qa', requestedBy: null }),
    (err) => err?.code === 'PROJECT_DELETED',
  );
  assert.throws(
    () => claimRunningJob(project, process.pid),
    (err) => err?.code === 'PROJECT_DELETING',
  );
  assert.throws(
    () => upsertProject({ name: project, tech_stack: 'node', status: 'planning' }),
    (err) => err?.code === 'PROJECT_DELETING',
  );
  assert.equal(releaseProjectDeletion(project), true);
  claimRunningJob(project, process.pid);
  assert.equal(releaseRunningJob(project)?.changes ?? 1, 1);
  deleteProject(project);
});

test('reorderPendingJob changes FIFO order without mutating durable job ids', () => {
  resetJobs();
  const a = enqueueJob({ project: 'reorder-a', action: 'qa', requestedBy: null });
  const b = enqueueJob({ project: 'reorder-b', action: 'qa', requestedBy: null });
  const c = enqueueJob({ project: 'reorder-c', action: 'qa', requestedBy: null });
  const moved = reorderPendingJob(c, { beforeId: a });
  assert.equal(moved.reordered, true);
  assert.deepEqual(moved.order, [Number(c), Number(a), Number(b)]);
  assert.equal(getJob(c).id, c, 'durable id is unchanged');
  assert.equal(nextPendingJobForFreeProject().id, c, 'picker honors explicit queue position');
});

test('retryTerminalJob creates a fresh replay-safe row and refuses ship', () => {
  resetJobs();
  const failed = enqueueJob({ project: 'retry-safe', action: 'go', args: { unattended: true }, requestedBy: null });
  markJobRunning(failed);
  markJobFailed(failed, 'boom');
  const retried = retryTerminalJob(failed);
  assert.equal(retried.retried, true);
  assert.equal(retried.action, 'resume', 'go retries through the safe resume entrypoint');
  assert.notEqual(retried.jobId, failed);
  assert.equal(JSON.parse(getJob(retried.jobId).args_json).retryOfJobId, Number(failed));

  const suggestions = enqueueJob({ project: 'retry-suggestions', action: 'suggestions', args: { unattended: true }, requestedBy: null });
  markJobRunning(suggestions);
  markJobFailed(suggestions, 'worker lost');
  const suggestionsRetry = retryTerminalJob(suggestions);
  assert.equal(suggestionsRetry.retried, true);
  assert.equal(suggestionsRetry.action, 'resume', 'accepted-suggestions work resumes from persisted project state');

  const ship = enqueueJob({ project: 'retry-unsafe', action: 'ship', requestedBy: null });
  markJobRunning(ship);
  markJobFailed(ship, 'unknown outcome');
  assert.equal(retryTerminalJob(ship).reason, 'not_replay_safe');
});

test('worker heartbeat reports idle liveness and can be removed on shutdown', () => {
  heartbeatWorker({ pid: 424242, startedAt: '2026-01-01T00:00:00.000Z', capacity: 3, activeJobs: [] });
  const row = listWorkerHeartbeats().find((r) => r.pid === 424242);
  assert.ok(row);
  assert.equal(row.capacity, 3);
  assert.deepEqual(JSON.parse(row.active_jobs), []);
  assert.equal(removeWorkerHeartbeat(424242).changes, 1);
});

// ─── Phase 79 (P2) — cost-class classification ───────────────────────────────

test('enqueueUniqueResumeJob: concurrent recovery surfaces collapse to one pending resume', () => {
  resetJobs();
  const notBefore = new Date(Date.now() + 60_000);
  const first = enqueueUniqueResumeJob({ project: 'resume-dedupe', notBefore });
  const second = enqueueUniqueResumeJob({ project: 'resume-dedupe', notBefore });
  assert.equal(first.scheduled, true);
  assert.equal(second.scheduled, false);
  assert.equal(second.jobId, first.jobId);
  const rows = getDb().prepare(`
    SELECT * FROM tg_jobs WHERE project = ? AND action = 'resume'
      AND status IN ('pending', 'running')
  `).all('resume-dedupe');
  assert.equal(rows.length, 1);
});

test('enqueueUniqueResumeJob: a running resume may schedule its own future successor', () => {
  resetJobs();
  const current = enqueueUniqueResumeJob({ project: 'resume-successor' });
  tryClaimJob(current.jobId);
  const successor = enqueueUniqueResumeJob({
    project: 'resume-successor',
    notBefore: new Date(Date.now() + 60_000),
    excludeJobId: current.jobId,
  });
  assert.equal(successor.scheduled, true);
  assert.notEqual(successor.jobId, current.jobId);
  assert.equal(getJob(current.jobId).status, 'running');
  assert.equal(getJob(successor.jobId).status, 'pending');
});

test('tryClaimJob + heartbeatJobLease: claim records owner and heartbeat renews only that lease', () => {
  resetJobs();
  const id = enqueueJob({ project: 'lease-job', action: 'review', requestedBy: null });
  assert.equal(tryClaimJob(id, { workerPid: 4321, nowMs: 1_000, leaseMs: 60_000 }), true);
  const claimed = getJob(id);
  assert.equal(claimed.worker_pid, 4321);
  assert.equal(Date.parse(claimed.lease_expires_at), 61_000);
  assert.equal(heartbeatJobLease(id, { workerPid: 9999, nowMs: 2_000, leaseMs: 60_000 }), false,
    'a different worker cannot renew the lease');
  assert.equal(heartbeatJobLease(id, { workerPid: 4321, nowMs: 2_000, leaseMs: 60_000 }), true);
  assert.equal(Date.parse(getJob(id).lease_expires_at), 62_000);
});

test('tryClaimJob: a second job for a project that is already running cannot be claimed (atomic project-freeness closes the pick→claim race)', () => {
  resetJobs();
  const project = 'double-claim';
  const first = enqueueJob({ project, action: 'go', requestedBy: null });
  const second = enqueueJob({ project, action: 'go', requestedBy: null });

  assert.equal(tryClaimJob(first, { workerPid: 111 }), true, 'first claim wins');
  // Simulates the cross-process race: worker B picked `second` before worker A
  // claimed `first`, then tries to claim. The project is now running, so the
  // claim must fail — no double execution / doubled token spend for one project.
  assert.equal(tryClaimJob(second, { workerPid: 222 }), false, 'second job for a running project is refused');
  assert.equal(getJob(second).status, 'pending', 'the refused job stays pending for later');

  // A running auto_run for the project also blocks the claim.
  resetJobs();
  setupRecoveryProject('ar-busy');
  const solo = enqueueJob({ project: 'ar-busy', action: 'go', requestedBy: null });
  getDb().prepare("INSERT INTO auto_runs (project, status, started_at) VALUES (?, 'running', ?)").run('ar-busy', new Date().toISOString());
  assert.equal(tryClaimJob(solo), false, 'a running auto_run for the project blocks the claim');
});

test('reconcileStaleRunningJobs: preserves a live owner with a fresh lease', () => {
  resetJobs();
  const nowMs = Date.now();
  const id = enqueueJob({ project: 'lease-live', action: 'audit', requestedBy: null });
  tryClaimJob(id, { workerPid: process.pid, nowMs, leaseMs: 60_000 });
  const out = reconcileStaleRunningJobs({ nowMs, pidAliveFn: () => true });
  assert.deepEqual(out.preserved, [id]);
  assert.equal(getJob(id).status, 'running');
});

test('reconcileStaleRunningJobs: dead go owner becomes one pending resume and honest paused project', () => {
  resetJobs();
  const project = 'lease-dead-go';
  setupRecoveryProject(project);
  const run = getDb().prepare(`
    INSERT INTO auto_runs (project, started_at, status) VALUES (?, ?, 'running')
  `).run(project, new Date().toISOString()).lastInsertRowid;
  const id = enqueueJob({ project, action: 'go', requestedBy: null });
  getDb().prepare(`
    INSERT INTO phases (project, n, title, status, model_used, session_id)
    VALUES (?, 1, 'P1', 'in-progress', 'claude-sonnet-5', 'sess-process')
  `).run(project);
  // Build the crash artifact directly. In production a running go-job AND a
  // running auto_run for one project only coexist after a crash — tryClaimJob's
  // project-freeness now forbids CREATING that state via a claim — so the
  // fixture writes the stale running row with SQL rather than the claim guard.
  getDb().prepare(`
    UPDATE tg_jobs SET status='running', started_at=?, worker_pid=?, lease_token='fixture-token',
      lease_expires_at=?
    WHERE id=?
  `).run(new Date().toISOString(), 2147483646, new Date(Date.now() + 300_000).toISOString(), id);
  const out = reconcileStaleRunningJobs({ pidAliveFn: () => false });
  assert.deepEqual(out.recovered, [id]);
  const recovered = getJob(id);
  assert.equal(recovered.status, 'pending');
  assert.equal(recovered.action, 'resume');
  assert.equal(recovered.recovery_count, 1);
  assert.equal(recovered.worker_pid, null);
  assert.equal(getDb().prepare('SELECT status FROM projects WHERE name = ?').get(project).status, 'paused');
  assert.equal(getDb().prepare('SELECT status FROM auto_runs WHERE id = ?').get(run).status, 'interrupted');
  const phase = getDb().prepare('SELECT * FROM phases WHERE project = ? AND n = 1').get(project);
  assert.equal(phase.interruption_kind, 'process');
  assert.match(phase.interruption_reason, /server restarted/);
});

test('shutdown recovery requeues go as resume, but an explicit cancellation never replays', () => {
  resetJobs();
  const project = 'shutdown-recovery';
  setupRecoveryProject(project);
  const id = enqueueJob({ project, action: 'go', requestedBy: null });
  assert.equal(tryClaimJob(id), true);

  // Recovery is an ownership mutation: without the claim's lease token the
  // call must refuse rather than requeue a row it cannot prove it owns.
  const refused = recoverJobAfterWorkerShutdown(id, { delayMs: 1000, nowMs: Date.now() });
  assert.equal(refused.recovered, false);
  assert.equal(refused.missingLeaseToken, true);
  assert.equal(getJob(id).status, 'running');

  const recovered = recoverJobAfterWorkerShutdown(id, {
    delayMs: 1000, nowMs: Date.now(), leaseToken: getJob(id).lease_token,
  });
  assert.equal(recovered.recovered, true);
  assert.equal(getJob(id).status, 'pending');
  assert.equal(getJob(id).action, 'resume');

  assert.equal(tryClaimJob(id), false, 'not_before delay fences immediate reclaim');
  getDb().prepare(`UPDATE tg_jobs SET not_before = NULL WHERE id = ?`).run(id);
  assert.equal(tryClaimJob(id), true);
  assert.equal(requestJobCancellation(id, 'operator cancelled'), true);
  const cancelled = recoverJobAfterWorkerShutdown(id, { leaseToken: getJob(id).lease_token });
  assert.equal(cancelled.cancelled, true);
  assert.equal(getJob(id).status, 'cancelled');
});

test('lease token fences a stale worker from terminalizing a reclaimed job', () => {
  resetJobs();
  const id = enqueueJob({ project: 'lease-fence', action: 'qa', requestedBy: null });
  assert.equal(tryClaimJob(id, { workerPid: 111, leaseToken: 'old-token' }), true);
  getDb().prepare(`
    UPDATE tg_jobs SET status='pending', worker_pid=NULL, lease_token=NULL,
      lease_expires_at=NULL, started_at=NULL
    WHERE id=?
  `).run(id);
  assert.equal(tryClaimJob(id, { workerPid: 222, leaseToken: 'new-token' }), true);
  markJobCompleted(id, 'stale completion', { leaseToken: 'old-token' });
  assert.equal(getJob(id).status, 'running');
  markJobCompleted(id, 'current completion', { leaseToken: 'new-token' });
  assert.equal(getJob(id).status, 'completed');
  assert.equal(getJob(id).result_summary, 'current completion');
});

test('reconcileStaleRunningJobs: stale go is deduplicated when a durable resume already exists', () => {
  resetJobs();
  const project = 'lease-dedupe-go';
  setupRecoveryProject(project);
  const staleId = enqueueJob({ project, action: 'go', requestedBy: null });
  tryClaimJob(staleId, { workerPid: 2147483646 });
  const resume = enqueueUniqueResumeJob({ project, notBefore: new Date(Date.now() + 60_000) });
  const out = reconcileStaleRunningJobs({ pidAliveFn: () => false });
  assert.deepEqual(out.deduplicated, [staleId]);
  assert.equal(getJob(staleId).status, 'failed');
  assert.equal(getJob(resume.jobId).status, 'pending');
  assert.equal(getDb().prepare('SELECT status FROM projects WHERE name = ?').get(project).status, 'paused');
});

test('reconcileStaleRunningJobs: non-replay-safe ship fails closed instead of repeating side effects', () => {
  resetJobs();
  const id = enqueueJob({ project: 'lease-ship', action: 'ship', requestedBy: null });
  tryClaimJob(id, { workerPid: 2147483646 });
  const out = reconcileStaleRunningJobs({ pidAliveFn: () => false });
  assert.deepEqual(out.failed, [id]);
  assert.equal(getJob(id).status, 'failed');
  assert.match(getJob(id).error_message, /automatic replay is unsafe/);
});

test('reconcileStaleRunningJobs: non-replay-safe package fails closed instead of creating a second archive', () => {
  resetJobs();
  const id = enqueueJob({ project: 'lease-package', action: 'package', requestedBy: null });
  tryClaimJob(id, { workerPid: 2147483646 });
  const out = reconcileStaleRunningJobs({ pidAliveFn: () => false });
  assert.deepEqual(out.failed, [id]);
  assert.equal(getJob(id).status, 'failed');
  assert.match(getJob(id).error_message, /automatic replay is unsafe/);
});

test('jobCostClass: static map covers the phase-79 heavy + cheap actions', () => {
  for (const a of ['go', 'resume', 'audit', 'bugs', 'pipeline', 'roadmap', 'brief', 'brief-chain', 'next-brief', 'next', 'discuss', 'review', 'handoff', 'qa-handoff', 'guide', 'context-refresh', 'retro', 'eval']) {
    assert.equal(jobCostClass(a), 'heavy', `${a} must be heavy`);
    assert.equal(JOB_COST_CLASS[a], 'heavy');
  }
  for (const a of ['validate', 'qa', 'package', 'reset-brief', 'retry-phase', 'ship', 'sync']) {
    assert.equal(jobCostClass(a), 'cheap', `${a} must be cheap`);
    assert.equal(JOB_COST_CLASS[a], 'cheap');
  }
});

test('jobCostClass: billing.job_cost_class override is honored; unknown action defaults to heavy', () => {
  assert.equal(jobCostClass('discuss', { discuss: 'cheap' }), 'cheap', 'override flips heavy → cheap');
  assert.equal(jobCostClass('qa', { qa: 'heavy' }), 'heavy', 'override flips cheap → heavy');
  assert.equal(jobCostClass('discuss', { other: 'cheap' }), 'heavy', 'unrelated override leaves the default');
  assert.equal(jobCostClass('review', { review: 'bogus' }), 'heavy', 'a non-heavy/cheap override value is ignored');
  assert.equal(jobCostClass('totally-unknown-action'), 'heavy', 'unknown action defaults to heavy (billing-safe)');
});

// ─── Phase 79 (P2) — window-aware picker ─────────────────────────────────────

test('picker at warn: a heavy job is NOT claimed and receives a future not_before + deferred_count=1', () => {
  resetJobs();
  const id = enqueueJob({ project: 'win-heavy', action: 'go', requestedBy: null });
  const picked = nextPendingJobForFreeProject({ windowState: WARN, projectedReset: FUTURE_RESET });
  assert.equal(picked, undefined, 'the only pending job is heavy → nothing admissible at warn');
  const row = getJob(id);
  assert.equal(row.status, 'pending', 'the deferred job stays pending');
  assert.ok(row.not_before, 'the heavy job got a not_before stamp');
  assert.ok(parseSqliteUtc(row.not_before) > new Date(), 'not_before is in the future (projected reset)');
  assert.equal(row.deferred_count, 1, 'deferred_count bumped to 1');
});

test('picker at warn: a cheap job IS claimed (never deferred)', () => {
  resetJobs();
  const id = enqueueJob({ project: 'win-cheap', action: 'qa', requestedBy: null });
  const picked = nextPendingJobForFreeProject({ windowState: WARN, projectedReset: FUTURE_RESET });
  assert.ok(picked && picked.id === id, 'the cheap job is admitted at warn');
  const row = getJob(id);
  assert.equal(row.deferred_count, 0, 'a cheap job is never deferred');
  assert.equal(row.not_before, null, 'a cheap job keeps a null not_before');
});

test('picker at warn: a once-deferred heavy job (deferred_count>=1) IS claimed despite warn (starvation guard)', () => {
  resetJobs();
  const id = enqueueJob({ project: 'win-heavy2', action: 'go', requestedBy: null });
  getDb().prepare("UPDATE tg_jobs SET deferred_count = 1 WHERE id = ?").run(id); // already deferred once, now due
  const picked = nextPendingJobForFreeProject({ windowState: WARN, projectedReset: FUTURE_RESET });
  assert.ok(picked && picked.id === id, 'a heavy job deferred once runs regardless of warn');
  assert.equal(getJob(id).deferred_count, 1, 'it is NOT deferred a second time — bounded at one deferral');
});

test('picker at warn: cheap job admitted while the older heavy head is deferred (cross-project)', () => {
  resetJobs();
  const heavyId = enqueueJob({ project: 'win-A', action: 'audit', requestedBy: null }); // older, heavy
  const cheapId = enqueueJob({ project: 'win-B', action: 'sync', requestedBy: null }); // newer, cheap
  const picked = nextPendingJobForFreeProject({ windowState: WARN, projectedReset: FUTURE_RESET });
  assert.equal(picked.id, cheapId, 'the cheap job is admitted even though the heavy job is older');
  const heavy = getJob(heavyId);
  assert.equal(heavy.deferred_count, 1, 'the older heavy head was deferred in the same tick');
  assert.ok(heavy.not_before, 'and stamped with a future not_before');
});

test('picker at warn: model-backed next and guide/context jobs are deferred', () => {
  resetJobs();
  const nextId = enqueueJob({ project: 'win-next', action: 'next', requestedBy: null });
  const guideId = enqueueJob({ project: 'win-guide', action: 'guide', args: { task: 'project-context-gen' }, requestedBy: null });
  assert.equal(nextPendingJobForFreeProject({ windowState: WARN, projectedReset: FUTURE_RESET }), undefined);
  assert.equal(getJob(nextId).deferred_count, 1);
  assert.equal(getJob(guideId).deferred_count, 1);
});

test('picker at warn: job_cost_class override admits an otherwise-heavy action', () => {
  resetJobs();
  const id = enqueueJob({ project: 'win-ovr', action: 'discuss', args: { topic: 't' }, requestedBy: null });
  const picked = nextPendingJobForFreeProject({ windowState: WARN, projectedReset: FUTURE_RESET, costClass: { discuss: 'cheap' } });
  assert.ok(picked && picked.id === id, 'the override made discuss cheap → admitted at warn');
  assert.equal(getJob(id).deferred_count, 0, 'an override-cheap job is not deferred');
});

test('picker at ok / no-gate: claim behavior is UNCHANGED (regression) — identical FIFO candidate, no defer', () => {
  resetJobs();
  const id = enqueueJob({ project: 'win-reg', action: 'go', requestedBy: null }); // heavy
  const noGate = nextPendingJobForFreeProject();                                   // pre-phase-79 signature
  const okGate = nextPendingJobForFreeProject({ windowState: OK, projectedReset: FUTURE_RESET });
  assert.ok(noGate && okGate, 'both pick the pending job');
  assert.equal(noGate.id, id);
  assert.equal(okGate.id, noGate.id, "'ok' returns the identical FIFO candidate as the ungated picker");
  const row = getJob(id);
  assert.equal(row.deferred_count, 0, 'ok never defers a heavy job');
  assert.equal(row.not_before, null, 'ok never stamps not_before');
});

// ─── Phase 79 (P2) — composition with brief-05 fair-share (not duplication) ──

test('cost-class filter composes with — does not duplicate — brief-05 fair-share admission', async () => {
  resetJobs();
  const { admitFairShare } = await import('../claude-runner.js');
  const { fairShareStatus } = await import('../billing-guard.js');
  // Fair-share admission (par-07) is a SPAWN-time weighted-share yield in
  // claude-runner.js; this picker's cost-class filter is a QUEUE-time gate. They
  // are distinct layers — neither reimplements the other.
  assert.equal(typeof admitFairShare, 'function');
  assert.equal(typeof fairShareStatus, 'function');
  assert.ok(!nextPendingJobForFreeProject.toString().includes('fairShare'),
    'the picker does not duplicate fairShareStatus/admitFairShare admission logic');
  assert.ok(!jobCostClass.toString().includes('fairShare'),
    'cost-class classification does not duplicate fair-share admission logic');

  // ORDERING: the cost-class filter is applied to the SAME FIFO candidate the
  // ungated picker selects (the candidate fair-share admission gates at spawn).
  // A heavy job is deferred by cost-class ALONE — no running_jobs weighting, no
  // fairShareStatus consulted — proving composition, not duplication.
  const id = enqueueJob({ project: 'win-fs', action: 'go', requestedBy: null });
  const fifoCandidate = nextPendingJobForFreeProject(); // the fair-share-admitted candidate (no claim/mutation)
  assert.equal(fifoCandidate.id, id, 'the FIFO candidate the fair-share path would admit');
  const gated = nextPendingJobForFreeProject({ windowState: WARN, projectedReset: FUTURE_RESET });
  assert.equal(gated, undefined, 'the same candidate is deferred purely by cost-class at warn');
  assert.equal(getJob(id).deferred_count, 1, 'deferred with zero fair-share/running_jobs state present');
});

// ─── Phase 79 (P2) — windowGate helper ───────────────────────────────────────

test('windowGate: derives state + projectedReset + costClass override from cfg', () => {
  const cfg = {
    billing: {
      mode: 'max_pooled', window_reset_hours: 5, warn_at_calls: 1, pause_at_calls: 100,
      warn_at_cost_usd: 1e9, pause_at_cost_usd: 1e9,
      job_cost_class: { discuss: 'cheap' },
    },
  };
  const gate = windowGate(cfg);
  assert.ok(gate.windowState && typeof gate.windowState.state === 'string');
  assert.ok(gate.projectedReset instanceof Date);
  assert.deepEqual(gate.costClass, { discuss: 'cheap' }, 'billing.job_cost_class flows through as the override map');
});

// ─── Phase 79 (P2) — migrate-window-scheduling (deferred_count) ──────────────

test('migrate-window-scheduling: idempotent (runs twice), column present, old rows read 0', async () => {
  const { runMigrateWindowScheduling } = await import('../migrate-window-scheduling.js');
  runMigrateWindowScheduling();
  runMigrateWindowScheduling(); // twice — must not throw
  const cols = getDb().pragma('table_info(tg_jobs)').map((c) => c.name);
  assert.ok(cols.includes('deferred_count'), 'deferred_count column present');
  resetJobs();
  const id = enqueueJob({ project: 'win-mig', action: 'go', requestedBy: null });
  assert.equal(getJob(id).deferred_count, 0, 'a row enqueued without an explicit deferred_count reads as 0');
});

test('migrate-window-scheduling: backfills deferred_count on a DB that lacks the column, honors DB_PATH', async () => {
  const { runMigrateWindowScheduling } = await import('../migrate-window-scheduling.js');
  const db = getDb(); // same :memory: DB the migration targets (getDb honors DB_PATH set at file top)
  resetJobs();
  const legacyId = enqueueJob({ project: 'win-legacy', action: 'go', requestedBy: null });
  db.exec('ALTER TABLE tg_jobs DROP COLUMN deferred_count'); // simulate a pre-phase-79 DB
  assert.ok(!db.pragma('table_info(tg_jobs)').map((c) => c.name).includes('deferred_count'), 'precondition: column dropped');
  runMigrateWindowScheduling();
  assert.ok(db.pragma('table_info(tg_jobs)').map((c) => c.name).includes('deferred_count'), 'migration re-added the column');
  assert.equal(getJob(legacyId).deferred_count, 0, 'the pre-existing (legacy) row backfills to 0');
  runMigrateWindowScheduling(); // idempotent on the now-present column
});
