import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const {
  classifyLastRun,
  extractHumanResetAt,
  runOrchestratorWithRetry,
  waitForRateLimitReset,
  getRateLimitRetryAt,
  markProjectWaitingForResume,
  markProjectResuming,
  isTransientError: isUnattendedTransientError,
} = await import('./unattended-retry.js');
const { isTransientError } = await import('./transient-errors.js');
const { classifyPauseReason, PAUSE_KINDS } = await import('./pause-classifier.js');

test('missing resetsAt waits the configured fallback cooldown instead of retrying immediately', async () => {
  let nowMs = 0;
  const sleeps = [];

  await waitForRateLimitReset('rate_limit_event: reset pending', {
    retryWaitMinutes: 10,
    now: () => nowMs,
    sleepFn: async (ms) => { sleeps.push(ms); nowMs += ms; },
    pollIntervalMs: 5 * 60 * 1000,
  });

  assert.deepEqual(sleeps, [5 * 60 * 1000, 5 * 60 * 1000]);
  assert.equal(nowMs, 10 * 60 * 1000);
});

test('provider resetsAt overrides the fallback cooldown', () => {
  assert.equal(
    getRateLimitRetryAt('rate_limit_event: {"resetsAt": 12345}', { retryWaitMinutes: 60, nowMs: 0 }),
    12345 * 1000,
  );
});

test('plain-text provider reset time is interpreted in Asia/Calcutta', () => {
  const nowMs = Date.parse('2026-07-14T11:50:00.000Z'); // 17:20 IST
  const expected = Date.parse('2026-07-14T12:30:00.000Z'); // 18:00 IST
  assert.equal(
    extractHumanResetAt("You've hit your session limit · resets 6pm (Asia/Calcutta)", { nowMs }),
    expected,
  );
  assert.equal(
    getRateLimitRetryAt("You've hit your session limit · resets 6pm (Asia/Calcutta)", { nowMs }),
    expected,
  );
});

test('a local billing-window pause is treated as a timed transient, not a terminal failure', () => {
  const reason = 'Paused: billing window exhausted — 40 calls in last 5h exceeds pause threshold (40). {"resetsAt": 12345}';
  assert.equal(
    isTransientError(reason),
    true,
  );
  assert.equal(isUnattendedTransientError(reason), true);
});

test('weekly usage limits and the shared provider breaker remain automatic-retry pauses', () => {
  for (const reason of [
    'weekly usage limit reached',
    'message weekly limit reached',
    'Provider circuit breaker open for anthropic/max_pooled. {"resetsAt": 1784230000}',
  ]) {
    assert.equal(isUnattendedTransientError(reason), true, reason);
    assert.equal(classifyPauseReason(reason), PAUSE_KINDS.BUDGET, reason);
  }
});

test('latest provider-limit pause wins over stale ready-for-qa project status', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unattended-retry-'));
  const dbPath = path.join(dir, 'state.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE projects (name TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE auto_runs (
      id INTEGER PRIMARY KEY,
      project TEXT,
      started_at TEXT,
      status TEXT,
      pause_kind TEXT,
      pause_reason TEXT
    );
  `);
  db.pragma('journal_mode = WAL');
  db.prepare('INSERT INTO projects (name, status) VALUES (?, ?)').run('demo', 'ready-for-qa');
  db.prepare(`
    INSERT INTO auto_runs (project, started_at, status, pause_kind, pause_reason)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    'demo',
    new Date().toISOString(),
    'paused',
    'mid-build',
    "phase-error: You've hit your session limit · resets 6pm",
  );
  db.close();

  try {
    assert.equal(classifyLastRun('demo', dbPath), 'transient');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('window-headroom optimization pause is transient and carries an exact reset', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unattended-headroom-'));
  const dbPath = path.join(dir, 'state.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE projects (name TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE auto_runs (
      id INTEGER PRIMARY KEY, project TEXT, started_at TEXT, status TEXT,
      pause_kind TEXT, pause_reason TEXT
    );
  `);
  db.pragma('journal_mode = WAL');
  const resetSec = 1784230000;
  db.prepare('INSERT INTO projects (name, status) VALUES (?, ?)').run('future-project', 'in-progress');
  db.prepare(`INSERT INTO auto_runs (project, started_at, status, pause_kind, pause_reason)
    VALUES (?, ?, ?, ?, ?)`).run(
    'future-project', new Date().toISOString(), 'paused', 'window-headroom',
    `window-headroom {"resetsAt": ${resetSec}}`,
  );
  db.close();
  try {
    assert.equal(classifyLastRun('future-project', dbPath), 'transient');
    assert.equal(getRateLimitRetryAt(`window-headroom {"resetsAt": ${resetSec}}`), resetSec * 1000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recoverable wait uses paused, never ready-for-qa, then flips back only when resuming', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unattended-status-'));
  const dbPath = path.join(dir, 'state.db');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE projects (name TEXT PRIMARY KEY, status TEXT)');
  db.prepare('INSERT INTO projects (name, status) VALUES (?, ?)').run('demo', 'in-progress');
  db.close();
  try {
    assert.equal(markProjectWaitingForResume('demo', dbPath), true);
    let check = new Database(dbPath, { readonly: true });
    assert.equal(check.prepare('SELECT status FROM projects WHERE name = ?').get('demo').status, 'paused');
    check.close();
    assert.equal(markProjectResuming('demo', dbPath), true);
    check = new Database(dbPath, { readonly: true });
    assert.equal(check.prepare('SELECT status FROM projects WHERE name = ?').get('demo').status, 'in-progress');
    check.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('retry after a failed resume never re-runs reset-brief', async () => {
  const calls = [];
  const resets = [];
  const resumptions = [];
  const waits = [];
  const initialArgs = ['reset-brief', 'demo', '--go'];
  const resumeArgs = ['resume', 'demo', '--unattended'];
  const exitCodes = [0, 1, 0];
  const classifications = ['transient', 'success'];

  const ok = await runOrchestratorWithRetry('/fake/orchestrator.js', '/fake/state.db', 'demo', initialArgs, resumeArgs, {
    runOrchestrator: (_path, args) => {
      calls.push([...args]);
      return exitCodes.shift();
    },
    classifyLastRun: () => classifications.shift(),
    getLastRun: () => ({ pause_reason: 'rate_limit_event: reset pending' }),
    waitForRateLimitReset: async (reason) => { waits.push(reason); },
    resetProjectStatus: (...args) => { resets.push(args); },
    markProjectResuming: (...args) => { resumptions.push(args); },
  });

  assert.equal(ok, true);
  assert.deepEqual(calls, [initialArgs, resumeArgs, resumeArgs]);
  assert.equal(waits.length, 2, 'both transient pauses wait for a reset');
  assert.equal(resets.length, 2, 'every transient stop is represented as waiting before sleep');
  assert.equal(resumptions.length, 2, 'each retry flips back only immediately before resume');
});
