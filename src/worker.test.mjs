import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.ORCHESTRATOR_SKIP_TRUST = '1';

const { resolveWorkerCount, runHeadlessWorker } = await import('./worker.js');
const { getDb } = await import('./state.js');
const { enqueueJob, getJob } = await import('./server/job-queue.js');

test('headless worker honors project-slot auto scaling while provider lease remains separate', () => {
  assert.equal(resolveWorkerCount({ job_runner: { max_concurrent_projects: 'auto', max_workers_cap: 8 } }), 8);
  assert.equal(resolveWorkerCount({ job_runner: { max_concurrent_projects: 3, max_workers_cap: 8 } }), 3);
  assert.equal(resolveWorkerCount({ job_runner: { max_concurrent_projects: 20, max_workers_cap: 8 } }), 8);
  assert.equal(resolveWorkerCount({ job_runner: { max_concurrent_projects: 0, max_workers_cap: 8 } }), 1);
});

test('shutdown mid-job requeues the claimed row as a fenced resume instead of dropping it', async () => {
  getDb().exec('DELETE FROM tg_jobs; DELETE FROM auto_runs;');
  getDb().prepare(`
    INSERT OR REPLACE INTO projects (name, created_at, status)
    VALUES (?, ?, 'in-progress')
  `).run('worker-shutdown-seam', new Date().toISOString());
  const id = enqueueJob({ project: 'worker-shutdown-seam', action: 'go', requestedBy: null });

  // Simulate the PM2 SIGTERM drain: the stop flag flips while executeJob is in
  // flight, and the killed subprocess surfaces as a cancellation-shaped throw.
  // The shutdown-aware executeJob leaves the row 'running'; here the stub
  // throws without terminalizing, which models exactly that contract.
  let stopping = false;
  await runHeadlessWorker({
    pollMs: 5,
    workerId: 99,
    manageReconciliation: false,
    cfgOverride: {},
    shouldStop: () => stopping,
    executeJobFn: async () => {
      stopping = true;
      throw new Error('claude subprocess cancelled (signal: SIGTERM)');
    },
  });

  const row = getJob(id);
  assert.equal(row.status, 'pending', 'row requeued, not cancelled/failed');
  assert.equal(row.action, 'resume', 'go continues from state as resume');
  assert.equal(row.recovery_count, 1);
  assert.equal(row.worker_pid, null);
});
