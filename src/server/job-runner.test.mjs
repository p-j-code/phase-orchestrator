// Seamed tests for job-runner.js's runAuditChain.
//
// Phase 43 (P7): a convergence-stalled promote (audit-promote.js's per-finding
// matcher against .guide/audits/finding-history.jsonl) must stop the chain
// with a distinct stoppedReason and run NO fix round — mirrors Phase 34's
// runAuditChain extraction, which added the same fixture-testable deps seam
// (deps.promoteAuditToBugs, deps.autoRun, ...) specifically so this kind of
// stop condition never needs a real Claude subprocess to verify.
//
// Run with: node --test src/server/job-runner.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';

const { runAuditChain, executeJob } = await import('./job-runner.js');
const { upsertProject, setProjectMetadataField, getDb, getProject } = await import('../state.js');
const { enqueueJob, tryClaimJob, getJob, requestJobCancellation } = await import('./job-queue.js');

function fakeNotifier() {
  const calls = [];
  return { calls, notify: async (payload) => { calls.push(payload); } };
}

test('completed durable resume re-enqueues an active brief chain', async () => {
  getDb().exec('DELETE FROM tg_jobs; DELETE FROM auto_runs;');
  upsertProject({ name: 'chain-resume', tech_stack: 'node', total_phases: 1, status: 'paused' });
  setProjectMetadataField('chain-resume', 'brief_chain', { active: true, state: 'running', file: '01.md' });
  const id = enqueueJob({ project: 'chain-resume', action: 'resume', args: { unattended: true }, requestedBy: null });
  assert.equal(tryClaimJob(id), true);
  await executeJob(getJob(id), fakeNotifier(), {
    autoRun: async () => ({ status: 'completed', reason: 'done' }),
  });
  const chain = getDb().prepare(`
    SELECT * FROM tg_jobs WHERE project = ? AND action = 'brief-chain' AND status = 'pending'
  `).get('chain-resume');
  assert.ok(chain, 'chain continuation persists after resume completion');
  assert.equal(getJob(id).status, 'completed');
});

test('deterministic jobs refuse cancellation and run to completion (qa in NON_CANCELLABLE_ACTIONS)', async () => {
  // Policy change: deterministic synchronous handlers (qa, package, ship…)
  // cannot be stopped safely after they start, so requestJobCancellation now
  // refuses them outright — the old pre-dispatch fence flow is unreachable
  // for them by design (the fence remains for cancellable spawn-based jobs).
  getDb().exec('DELETE FROM tg_jobs; DELETE FROM auto_runs;');
  upsertProject({ name: 'cancel-before-dispatch', tech_stack: 'node', status: 'planning' });
  const id = enqueueJob({ project: 'cancel-before-dispatch', action: 'qa', requestedBy: null });
  assert.equal(tryClaimJob(id), true);
  assert.equal(requestJobCancellation(id, 'cancel before execute'), false, 'qa is non-cancellable');

  await executeJob(getJob(id), fakeNotifier());

  assert.equal(getJob(id).status, 'completed');
  assert.equal(getProject('cancel-before-dispatch').status, 'ready-for-qa', 'the qa handler ran normally');
});

test('a mid-dispatch cancellation attempt on a deterministic job is refused and completion is reported', async () => {
  // Companion to the policy test above: even a cancellation racing the
  // dispatch window is refused for NON_CANCELLABLE_ACTIONS, so the job
  // completes and reports normally (no cancelled-but-side-effects-ran limbo).
  getDb().exec('DELETE FROM tg_jobs; DELETE FROM auto_runs;');
  upsertProject({ name: 'cancel-after-dispatch', tech_stack: 'node', status: 'planning' });
  const id = enqueueJob({ project: 'cancel-after-dispatch', action: 'qa', requestedBy: null });
  assert.equal(tryClaimJob(id), true);
  const notifier = fakeNotifier();
  notifier.notify = async (payload) => {
    notifier.calls.push(payload);
    if (String(payload.text || '').startsWith('▶ Starting:')) {
      assert.equal(requestJobCancellation(id, 'cancel during deterministic dispatch'), false);
    }
  };

  await executeJob(getJob(id), notifier);

  assert.equal(getProject('cancel-after-dispatch').status, 'ready-for-qa', 'the synchronous handler ran');
  assert.equal(getJob(id).status, 'completed');
  assert.equal(notifier.calls.some((payload) => String(payload.text || '').startsWith('✓ Completed:')), true);
});

test('suggestions queue action executes accepted work through autoRun', async () => {
  getDb().exec('DELETE FROM tg_jobs; DELETE FROM auto_runs;');
  upsertProject({ name: 'suggestions-dispatch', tech_stack: 'node', status: 'planning' });
  const id = enqueueJob({ project: 'suggestions-dispatch', action: 'suggestions', args: { unattended: true }, requestedBy: null });
  assert.equal(tryClaimJob(id), true);
  let calls = 0;
  await executeJob(getJob(id), fakeNotifier(), {
    autoRun: async ({ projectName, unattended }) => {
      calls += 1;
      assert.equal(projectName, 'suggestions-dispatch');
      assert.equal(unattended, true);
      return { status: 'completed', reason: 'accepted suggestion pass complete' };
    },
  });
  assert.equal(calls, 1);
  assert.equal(getJob(id).status, 'completed');
});

test('package durable action defaults includeGit off and honors an explicit opt-in', async () => {
  getDb().exec('DELETE FROM tg_jobs; DELETE FROM auto_runs;');
  upsertProject({ name: 'package-job', tech_stack: 'node', total_phases: 1, status: 'paused' });
  const seen = [];
  const packageProject = async (options) => {
    seen.push(options);
    return { filename: `package-job-${seen.length}.zip`, sizeBytes: 42 };
  };

  for (const args of [{}, { includeGit: true }]) {
    const id = enqueueJob({ project: 'package-job', action: 'package', args, requestedBy: null });
    assert.equal(tryClaimJob(id), true);
    await executeJob(getJob(id), fakeNotifier(), { packageProject });
    assert.equal(getJob(id).status, 'completed');
    assert.match(getJob(id).result_summary, /Release package created/);
  }

  assert.equal(seen[0].includeGit, false, 'missing durable arg does not inherit the CLI includeGit default');
  assert.equal(seen[1].includeGit, true, 'includeGit:true is passed through explicitly');
  assert.ok(seen.every((options) => options.projectName === 'package-job' && options.quiet === true));
});

test('runAuditChain: convergence_stall on the promote stops the chain and runs no fix round', async () => {
  let autoRunCalls = 0;
  const promo = {
    promoted: true,
    round: 2,
    bugsPath: '/tmp/does-not-matter/.guide/bug-rounds/round-2/bugs.md',
    auditFile: '/tmp/does-not-matter/.guide/audits/audit-r2.md',
    convergence_stall: true,
    recurring: [
      { title: 'Missing input validation', matched_round: 1, matched_title: 'Missing input validation' },
      { title: 'Race condition in webhook handler', matched_round: 1, matched_title: 'Race condition in webhook handler' },
    ],
  };

  const result = await runAuditChain({
    job: { id: 1 },
    notifier: fakeNotifier(),
    project: 'demo',
    projDir: '/tmp/does-not-matter',
    args: { chain: true, rounds: 3 },
    initialAuditResult: { routing: { model: 'sonnet' }, audit_scope: 'full' },
  }, {
    promoteAuditToBugs: async () => promo,
    autoRun: async () => { autoRunCalls += 1; return { status: 'completed' }; },
    recordAuditYield: () => {},
    getBugRound: () => null,
    resolveConfig: async () => ({ auto_run: { max_chain_rounds: 25 }, audit: {} }),
  });

  assert.equal(autoRunCalls, 0, 'no fix round runs when the promote is convergence-stalled');
  assert.equal(result.result, null, 'completedRounds stays 0 — no fix round to inherit a status from');
  assert.match(result.summary, /convergence stall/);
  assert.match(result.summary, /2 finding\(s\) recurring across rounds/);
  assert.match(result.summary, /Missing input validation/);
});

test('runAuditChain: convergence_stall does NOT fire when the promote reports no stall (baseline)', async () => {
  let autoRunCalls = 0;
  const promo = {
    promoted: true,
    round: 2,
    bugsPath: '/tmp/does-not-matter/.guide/bug-rounds/round-2/bugs.md',
    auditFile: '/tmp/does-not-matter/.guide/audits/audit-r2.md',
    convergence_stall: false,
    recurring: [],
  };

  const result = await runAuditChain({
    job: { id: 1 },
    notifier: fakeNotifier(),
    project: 'demo',
    projDir: '/tmp/does-not-matter',
    args: { chain: true, rounds: 1 },
    initialAuditResult: { routing: { model: 'sonnet' }, audit_scope: 'full' },
  }, {
    promoteAuditToBugs: async () => promo,
    autoRun: async () => { autoRunCalls += 1; return { status: 'completed' }; },
    recordAuditYield: () => {},
    getBugRound: () => null,
    resolveConfig: async () => ({ auto_run: { max_chain_rounds: 25 }, audit: {} }),
  });

  assert.equal(autoRunCalls, 1, 'the fix round DOES run when there is no convergence stall');
  assert.doesNotMatch(result.summary, /convergence stall/);
});
