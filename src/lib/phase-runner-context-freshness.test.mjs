// Phase 19 (brief P2, auto-refresh + notice half) —
// src/lib/phase-runner-context-freshness.test.mjs
//
// loadContextFreshnessCheck is the fail-open wrapper run at the same
// spawn-time check as loadContextDeltaBlock (phase 18): it decides whether to
// enqueue ONE project-context-gen refresh (shouldEnqueueContextRefresh,
// deduped by the REAL job-queue enqueue path) and whether to fire a one-time
// external-drift notice (shouldNotifyContextDrift, keyed off the persisted
// last-noticed sha). Never contributes to systemPromptExtra/devSystemPromptExtra
// — see phase-runner-cache-discipline.test.mjs for that byte-stability
// contract, which this file does not touch.
//
// Run with: node --test src/lib/phase-runner-context-freshness.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DB_PATH = ':memory:';

const { loadContextFreshnessCheck } = await import('./phase-runner.js');
const { enqueueContextRefreshJob, listPendingJobs } = await import('../server/job-queue.js');
const { readContextFreshnessState, writeContextFreshnessState, contextFreshnessStatePath } = await import('./guide-paths.js');

function makeProjDir(label) {
  const d = mkdtempSync(path.join(tmpdir(), `aorch-ctx-freshness-check-${label}-`));
  mkdirSync(path.join(d, '.guide'), { recursive: true });
  return d;
}

const CFG = { context_freshness: { enabled: true, regen_after_commits: 10, regen_after_external_files: 5, notify_on_external: true } };

function writeStamped(projDir, sha = 'abc12345', date = '2026-07-01T00:00:00.000Z') {
  writeFileSync(path.join(projDir, '.guide', 'project-context.md'), `---\ngenerated_at_sha: ${sha}\ngenerated_at: ${date}\n---\n\nBody.\n`);
}

function externalDelta(n, headSha = 'headsha1') {
  return {
    drift: 'some',
    headSha,
    overflowCount: 0,
    commits: Array.from({ length: n }, (_, i) => ({
      sha: `ext${i}`, subject: `external commit ${i}`, classification: 'external', files: [{ status: 'M', path: `f${i}.js` }],
    })),
  };
}

// ─── No artifact / below-threshold / drift-unknown ──────────────────────────

test('loadContextFreshnessCheck: no project-context.md at all → null, nothing enqueued', async () => {
  const projDir = makeProjDir('nofile');
  const workspaceDir = path.join(projDir, 'workspace');
  const enqueueCalls = [];
  const result = await loadContextFreshnessCheck(workspaceDir, projDir, 'demo', CFG, {
    enqueueContextRefreshJob: async (a) => { enqueueCalls.push(a); return 1; },
  });
  assert.equal(result, null);
  assert.equal(enqueueCalls.length, 0);
});

test('loadContextFreshnessCheck: below-threshold delta (no external commits) → nothing queued, nothing to notice, returns null', async () => {
  const projDir = makeProjDir('below');
  writeStamped(projDir);
  const workspaceDir = path.join(projDir, 'workspace');
  const enqueueCalls = [];
  const orchestratorOnlyDelta = {
    drift: 'some', headSha: 'headsha1', overflowCount: 0,
    commits: [{ sha: 'orc1', subject: 'phase-19: small change', classification: 'orchestrator', files: [{ status: 'M', path: 'a.js' }] }],
  };
  const result = await loadContextFreshnessCheck(workspaceDir, projDir, 'demo', CFG, {
    contextDelta: async () => orchestratorOnlyDelta,
    enqueueContextRefreshJob: async (a) => { enqueueCalls.push(a); return 1; },
  });
  assert.equal(enqueueCalls.length, 0, '1 commit total, 0 external files — below both thresholds');
  assert.equal(result, null, 'no refresh needed and no external commits to notice — nothing to attach');
});

test('loadContextFreshnessCheck: below-threshold delta WITH a lone external commit → no refresh queued, but the notice still fires (independent of the enqueue thresholds)', async () => {
  const projDir = makeProjDir('below-notice');
  writeStamped(projDir);
  const workspaceDir = path.join(projDir, 'workspace');
  const enqueueCalls = [];
  const result = await loadContextFreshnessCheck(workspaceDir, projDir, 'demo', CFG, {
    contextDelta: async () => externalDelta(1), // 1 commit, 1 file — below both enqueue thresholds
    enqueueContextRefreshJob: async (a) => { enqueueCalls.push(a); return 1; },
  });
  assert.equal(enqueueCalls.length, 0);
  assert.equal(result.refreshQueued, false);
  assert.ok(result.notifyText, 'shouldNotifyContextDrift fires on any external commit, independent of the refresh thresholds');
});

test('loadContextFreshnessCheck: legacy unstamped artifact (drift-unknown) → exactly one refresh queued, no notify', async () => {
  const projDir = makeProjDir('unknown');
  writeFileSync(path.join(projDir, '.guide', 'project-context.md'), '# Domain\nNo front-matter at all.\n');
  const workspaceDir = path.join(projDir, 'workspace');
  const enqueueCalls = [];
  const result = await loadContextFreshnessCheck(workspaceDir, projDir, 'demo', CFG, {
    enqueueContextRefreshJob: async (a) => { enqueueCalls.push(a); return 1; },
  });
  assert.equal(enqueueCalls.length, 1);
  assert.equal(result.refreshQueued, true);
  assert.equal(result.notifyText, null, 'drift-unknown has no sha/commit list to build a notice from');
});

// ─── Threshold-crossing → enqueue, with REAL job-queue dedupe ───────────────

test('loadContextFreshnessCheck: total-commits threshold crossed → exactly one enqueue call reaches the real job-queue', async () => {
  const projDir = makeProjDir('threshold-real');
  writeStamped(projDir);
  const workspaceDir = path.join(projDir, 'workspace');
  const delta = { ...externalDelta(0), overflowCount: 10, commits: [] }; // total = 10 = regen_after_commits

  const first = await loadContextFreshnessCheck(workspaceDir, projDir, 'demo-threshold-real', CFG, {
    contextDelta: async () => delta,
    enqueueContextRefreshJob,
  });
  assert.equal(first.refreshQueued, true);
  assert.equal(listPendingJobs().filter((j) => j.project === 'demo-threshold-real').length, 1);

  // A second spawn at the SAME drifted state calls the enqueue path again —
  // job-queue.js's own atomic dedupe (not loadContextFreshnessCheck's own
  // logic) must be what keeps this at exactly one row.
  const second = await loadContextFreshnessCheck(workspaceDir, projDir, 'demo-threshold-real', CFG, {
    contextDelta: async () => delta,
    enqueueContextRefreshJob,
  });
  assert.equal(second.refreshQueued, true);
  assert.equal(
    listPendingJobs().filter((j) => j.project === 'demo-threshold-real').length,
    1,
    'a second spawn while already queued must enqueue zero additional jobs',
  );
});

test('loadContextFreshnessCheck: cfg.enabled:false → null immediately, no enqueue/notify attempted', async () => {
  const projDir = makeProjDir('disabled');
  writeStamped(projDir);
  const workspaceDir = path.join(projDir, 'workspace');
  const enqueueCalls = [];
  const result = await loadContextFreshnessCheck(workspaceDir, projDir, 'demo', { context_freshness: { ...CFG.context_freshness, enabled: false } }, {
    contextDelta: async () => externalDelta(20),
    enqueueContextRefreshJob: async (a) => { enqueueCalls.push(a); return 1; },
  });
  assert.equal(result, null);
  assert.equal(enqueueCalls.length, 0);
});

// ─── Telegram drift notice: fires once per episode, persists last-noticed sha ─

test('loadContextFreshnessCheck: new external drift fires the notice once, persists last-noticed sha, and does not re-fire at the same HEAD', async () => {
  const projDir = makeProjDir('notice');
  writeStamped(projDir);
  const workspaceDir = path.join(projDir, 'workspace');
  const enqueueCalls = [];
  const deps = {
    contextDelta: async () => externalDelta(3, 'headsha-A'),
    enqueueContextRefreshJob: async (a) => { enqueueCalls.push(a); return 1; },
  };

  const first = await loadContextFreshnessCheck(workspaceDir, projDir, 'notice-proj', CFG, deps);
  assert.ok(first.notifyText.includes('3 external commit(s)'));
  const state = await readContextFreshnessState(projDir);
  assert.equal(state.last_noticed_external_sha, 'headsha-A');

  // Same HEAD, second spawn — must not re-fire (and, at only 3 commits/3
  // files, nothing crosses the refresh thresholds either, so the whole
  // check collapses to null — nothing left to attach to the caller's result).
  const second = await loadContextFreshnessCheck(workspaceDir, projDir, 'notice-proj', CFG, deps);
  assert.equal(second, null, 'repeat spawn at the same drifted HEAD must not re-fire the notice');
});

test('loadContextFreshnessCheck: a NEW drift episode (new external commits, new HEAD) fires again and updates the persisted sha', async () => {
  const projDir = makeProjDir('notice-2');
  writeStamped(projDir);
  const workspaceDir = path.join(projDir, 'workspace');
  const enqueueCalls = [];
  const noop = { enqueueContextRefreshJob: async (a) => { enqueueCalls.push(a); return 1; } };

  await loadContextFreshnessCheck(workspaceDir, projDir, 'notice-proj-2', CFG, { ...noop, contextDelta: async () => externalDelta(1, 'headsha-B') });
  let state = await readContextFreshnessState(projDir);
  assert.equal(state.last_noticed_external_sha, 'headsha-B');

  const again = await loadContextFreshnessCheck(workspaceDir, projDir, 'notice-proj-2', CFG, { ...noop, contextDelta: async () => externalDelta(1, 'headsha-C') });
  assert.ok(again.notifyText, 'a new HEAD past the previously-noticed one is a new episode');
  state = await readContextFreshnessState(projDir);
  assert.equal(state.last_noticed_external_sha, 'headsha-C');
});

test('loadContextFreshnessCheck: notify_on_external:false suppresses the notice but not the refresh enqueue', async () => {
  const projDir = makeProjDir('notify-off');
  writeStamped(projDir);
  const workspaceDir = path.join(projDir, 'workspace');
  const enqueueCalls = [];
  const cfg = { context_freshness: { ...CFG.context_freshness, notify_on_external: false } };
  const result = await loadContextFreshnessCheck(workspaceDir, projDir, 'demo', cfg, {
    // 1 external commit (would otherwise fire a notice) + overflowCount 10 so
    // total commits crosses regen_after_commits — isolates "enqueue still
    // fires" from "notice is suppressed by config".
    contextDelta: async () => ({ ...externalDelta(1), overflowCount: 10 }),
    enqueueContextRefreshJob: async (a) => { enqueueCalls.push(a); return 1; },
  });
  assert.equal(result.refreshQueued, true);
  assert.equal(result.notifyText, null);
});

// ─── Fail-open ───────────────────────────────────────────────────────────────

test('loadContextFreshnessCheck: fail-open — a throwing injected contextDelta is caught, returns null, logs a [context-freshness]-tagged warning', async () => {
  const projDir = makeProjDir('throw');
  writeStamped(projDir);
  const workspaceDir = path.join(projDir, 'workspace');
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (msg) => { warnings.push(String(msg)); };
  let result;
  try {
    result = await loadContextFreshnessCheck(workspaceDir, projDir, 'demo', CFG, {
      contextDelta: async () => { throw new Error('injected git failure'); },
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(result, null);
  assert.ok(warnings.some((w) => w.includes('context-freshness')));
});

// ─── guide-paths.js state helpers (round-trip) ──────────────────────────────

test('readContextFreshnessState: missing file → default shape, no throw', async () => {
  const projDir = makeProjDir('state-missing');
  const state = await readContextFreshnessState(projDir);
  assert.deepEqual(state, { last_noticed_external_sha: null });
});

test('writeContextFreshnessState / readContextFreshnessState round-trip at contextFreshnessStatePath', async () => {
  const projDir = makeProjDir('state-roundtrip');
  await writeContextFreshnessState(projDir, { last_noticed_external_sha: 'deadbeef' });
  const state = await readContextFreshnessState(projDir);
  assert.equal(state.last_noticed_external_sha, 'deadbeef');
  assert.equal(contextFreshnessStatePath(projDir), path.join(projDir, '.guide', 'context-freshness-state.json'));
});
