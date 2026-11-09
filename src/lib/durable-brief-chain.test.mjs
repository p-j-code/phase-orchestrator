import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runDurableBriefChain } from './durable-brief-chain.js';

function fakeState(project = 'demo') {
  const row = { name: project, status: 'ready-for-qa', metadata_json: '{}' };
  // lastRun mirrors the auto_runs row the real getLastAutoRun returns. Tests
  // mutate it inside their autoRun mock to model the persisted verdict.
  const store = { row, lastRun: null };
  return {
    row: store.row,
    get lastRun() { return store.lastRun; },
    set lastRun(v) { store.lastRun = v; },
    getProject: () => ({ ...store.row }),
    getLastAutoRun: () => (store.lastRun ? { ...store.lastRun } : null),
    setProjectMetadataField: (_project, key, value) => {
      const metadata = JSON.parse(store.row.metadata_json || '{}');
      metadata[key] = value;
      store.row.metadata_json = JSON.stringify(metadata);
    },
  };
}

// A later-than-any-prior ISO timestamp, monotone per call.
let clockMs = Date.parse('2026-07-18T00:00:00.000Z');
function laterIso() { clockMs += 1000; return new Date(clockMs).toISOString(); }

async function makeQueue(names) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aorch-durable-chain-'));
  const queue = path.join(root, 'demo', 'inputs', 'queue');
  await fs.mkdir(queue, { recursive: true });
  for (const name of names) await fs.writeFile(path.join(queue, name), `# ${name}\n`, 'utf-8');
  return root;
}

test('durable brief chain stages, runs, archives, and advances every queue item', async () => {
  const projectsDir = await makeQueue(['01-first.md', '02-second.md']);
  const state = fakeState();
  const resets = [];
  const runs = [];
  try {
    const result = await runDurableBriefChain({ project: 'demo' }, {
      projectsDir,
      ...state,
      resetBrief: async (project) => { resets.push(project); state.row.status = 'planning'; },
      autoRun: async () => {
        runs.push('run'); state.row.status = 'ready-for-qa';
        state.lastRun = { status: 'completed', started_at: laterIso() };
        return { status: 'completed' };
      },
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.completed, 2);
    assert.equal(resets.length, 2);
    assert.equal(runs.length, 2);
    assert.deepEqual(await fs.readdir(path.join(projectsDir, 'demo', 'inputs', 'queue')), []);
    assert.deepEqual((await fs.readdir(path.join(projectsDir, 'demo', 'inputs', 'queue-archive'))).sort(), ['01-first.md', '02-second.md']);
    assert.equal(JSON.parse(state.row.metadata_json).brief_chain.active, false);
  } finally {
    await fs.rm(projectsDir, { recursive: true, force: true });
  }
});

test('recoverable pause checkpoints the current brief; restart archives completed work without reset or rerun', async () => {
  const projectsDir = await makeQueue(['01-paused.md']);
  const state = fakeState();
  let resets = 0;
  let runs = 0;
  const deps = {
    projectsDir,
    ...state,
    resetBrief: async () => { resets += 1; state.row.status = 'planning'; },
    autoRun: async () => {
      runs += 1;
      state.row.status = 'paused';
      state.lastRun = { status: 'paused', pause_kind: 'budget', started_at: laterIso() };
      return { status: 'paused', pauseKind: 'budget', reason: 'provider circuit open' };
    },
  };
  try {
    const paused = await runDurableBriefChain({ project: 'demo' }, deps);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.recoverable, true);
    assert.equal(JSON.parse(state.row.metadata_json).brief_chain.file, '01-paused.md');

    // A durable resume job finished the current brief while the chain driver
    // was not running. The persisted run verdict (started at/after this brief's
    // dispatch) is authoritative: re-entry must archive/advance, not reset or
    // call a model. started_at is anchored to the checkpoint's real dispatched_at
    // (written by the driver) so the completedSinceDispatch gate is deterministic.
    state.row.status = 'ready-for-qa';
    const dispatchedAt = JSON.parse(state.row.metadata_json).brief_chain.dispatched_at;
    state.lastRun = { status: 'completed', started_at: dispatchedAt };
    deps.autoRun = async () => { throw new Error('must not rerun completed brief'); };
    const completed = await runDurableBriefChain({ project: 'demo' }, deps);
    assert.equal(completed.status, 'completed');
    assert.equal(resets, 1);
    assert.equal(runs, 1);
    assert.deepEqual(await fs.readdir(path.join(projectsDir, 'demo', 'inputs', 'queue')), []);
  } finally {
    await fs.rm(projectsDir, { recursive: true, force: true });
  }
});

// Regression for P2-1: a queued brief must NOT be archived unrun after a crash
// when project.status is a STALE terminal value inherited from the previous
// brief and no run has started since this brief was dispatched.
test('restart does not archive a queued brief unrun on a stale previous-brief status', async () => {
  const projectsDir = await makeQueue(['01-fresh.md']);
  const state = fakeState();
  try {
    // Simulate the crash window: the chain staged the brief (checkpoint
    // file+running, dispatched_at set) but the process died before autoRun.
    // The last run on record is the PREVIOUS brief's completion, started
    // BEFORE this brief's dispatch — its 'ready-for-qa' status is stale.
    const dispatchedAt = laterIso();
    state.lastRun = { status: 'completed', started_at: '2026-07-17T00:00:00.000Z' }; // before dispatch
    state.setProjectMetadataField('demo', 'brief_chain', {
      active: true, state: 'running', file: '01-fresh.md', dispatched_at: dispatchedAt,
    });

    let ran = 0;
    const completed = await runDurableBriefChain({ project: 'demo' }, {
      projectsDir,
      ...state,
      resetBrief: async () => { state.row.status = 'planning'; },
      autoRun: async () => {
        ran += 1; state.row.status = 'ready-for-qa';
        state.lastRun = { status: 'completed', started_at: laterIso() };
        return { status: 'completed' };
      },
    });
    // The brief must have actually RUN (not been archived unrun), then archived.
    assert.equal(ran, 1, 'the queued brief must run, not be skipped as already-complete');
    assert.equal(completed.completed, 1);
    assert.deepEqual(await fs.readdir(path.join(projectsDir, 'demo', 'inputs', 'queue')), []);
    assert.deepEqual(
      await fs.readdir(path.join(projectsDir, 'demo', 'inputs', 'queue-archive')),
      ['01-fresh.md'],
    );
  } finally {
    await fs.rm(projectsDir, { recursive: true, force: true });
  }
});
