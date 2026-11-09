// Tests for the chat-autopilot foundation: the cross-process chat lock, the
// detached-spawn ledger, autopilot thread state, the control-token parser, and
// the fire/wait/escalate decision. In-memory DB via DB_PATH=:memory:.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';

const state = await import('../state.js');
const {
  acquireChatLock, releaseChatLock, isChatThreadLocked,
  recordDetachedSpawn, recentDetachedSpawn,
  createChatThread, getChatThread, setThreadAutopilot, getAutopilotThreads,
  setAutopilotStatus, recordAutopilotTurn, resetAutopilotAttempts,
  upsertProject, startAutoRun,
} = state;

const { parseAutopilotSignal } = await import('./chat-engine.js');
const { _decide, _signatureFor, _tickOnce, startAutopilot, stopAutopilot } = await import('./chat-autopilot.js');

const AP = { enabled: true, budgetUsd: 5, maxAttempts: 8, tickMs: 20000 };

// ── Cross-process chat lock (R1) ──────────────────────────────────────────────

test('chat lock: acquire is exclusive while the holder pid is alive', () => {
  const t = createChatThread({ title: 'lock' });
  assert.equal(acquireChatLock(t), true, 'first acquire succeeds');
  assert.equal(acquireChatLock(t), false, 'second acquire blocked (this pid is alive)');
  assert.equal(isChatThreadLocked(t), true);
  releaseChatLock(t);
  assert.equal(isChatThreadLocked(t), false);
  assert.equal(acquireChatLock(t), true, 're-acquire after release');
  releaseChatLock(t);
});

test('chat lock: a lock held by a dead pid is reclaimed', () => {
  const t = createChatThread({ title: 'stale-lock' });
  assert.equal(acquireChatLock(t, 2147480000), true, 'seed a lock owned by a (dead) pid');
  assert.equal(isChatThreadLocked(t), false, 'dead-pid lock does not count as locked');
  assert.equal(acquireChatLock(t), true, 'reclaimed by a live acquirer');
  releaseChatLock(t);
});

// ── Detached-spawn ledger (R2) ────────────────────────────────────────────────

test('detached-spawn ledger: records and reports latest with liveness', () => {
  upsertProject({ name: 'led', tech_stack: 'node', total_phases: 3 });
  assert.equal(recentDetachedSpawn('led'), null, 'no spawns yet');
  recordDetachedSpawn({ project: 'led', action: 'go', pid: process.pid, source: 'chat' });
  recordDetachedSpawn({ project: 'led', action: 'audit', pid: 2147480001, source: 'chat' });
  const latest = recentDetachedSpawn('led');
  assert.equal(latest.action, 'audit', 'returns the most recent');
  assert.equal(latest.alive, false, 'dead pid → not alive');
  assert.ok(typeof latest.age_s === 'number');
});

// ── Autopilot thread state (Phase A) ──────────────────────────────────────────

test('autopilot state: enable/list/turn/reset/terminal lifecycle', () => {
  const t = createChatThread({ title: 'ap', project: null });
  setThreadAutopilot(t, { enabled: true, goal: 'ship it' });
  let row = getChatThread(t);
  assert.equal(row.autopilot, 1);
  assert.equal(row.autopilot_goal, 'ship it');
  assert.equal(row.autopilot_status, 'active');
  assert.ok(getAutopilotThreads().some((x) => x.id === t), 'active thread is listed');

  recordAutopilotTurn(t, { spendDelta: 1.25, nextAt: '2999-01-01T00:00:00Z', sig: 'A', status: 'waiting' });
  row = getChatThread(t);
  assert.equal(row.autopilot_attempts, 1);
  assert.equal(Math.round(row.autopilot_spend_usd * 100), 125);
  assert.equal(row.autopilot_sig, 'A');
  assert.equal(row.autopilot_status, 'waiting');
  assert.ok(getAutopilotThreads().some((x) => x.id === t), 'waiting thread still listed');

  resetAutopilotAttempts(t, { sig: 'B' });
  row = getChatThread(t);
  assert.equal(row.autopilot_attempts, 0, 'reset zeroes the spin counter');
  assert.equal(row.autopilot_status, 'active');
  assert.equal(row.autopilot_sig, 'B');

  setAutopilotStatus(t, 'done');
  assert.ok(!getAutopilotThreads().some((x) => x.id === t), 'done thread drops out of the loop');

  setThreadAutopilot(t, { enabled: false });
  assert.equal(getChatThread(t).autopilot, 0);
});

// ── Control-token parser (Phase B) ────────────────────────────────────────────

test('parseAutopilotSignal: recognizes all tokens and extracts BLOCKED note', () => {
  assert.equal(parseAutopilotSignal('all good\n[[AUTOPILOT: WORKING]]').state, 'WORKING');
  assert.equal(parseAutopilotSignal('waiting on the run [[AUTOPILOT: WAITING]]').state, 'WAITING');
  assert.equal(parseAutopilotSignal('done here\n[[AUTOPILOT: DONE]]').state, 'DONE');
  const b = parseAutopilotSignal('[[AUTOPILOT: BLOCKED needs ship approval]]');
  assert.equal(b.state, 'BLOCKED');
  assert.equal(b.note, 'needs ship approval');
  assert.equal(parseAutopilotSignal('no token here'), null);
  assert.equal(parseAutopilotSignal('[[autopilot: done]]').state, 'DONE', 'case-insensitive');
});

// ── Decision logic (Phase A) ──────────────────────────────────────────────────

function thread(over = {}) {
  return {
    id: 1, project: '__no_such_project__',
    autopilot_status: 'active', autopilot_sig: null,
    autopilot_spend_usd: 0, autopilot_attempts: 0,
    ...over,
  };
}

test('decide: active thread fires', () => {
  const d = _decide(thread({ autopilot_status: 'active' }), AP);
  assert.equal(d.fire, true);
});

test('decide: over-budget escalates before firing', () => {
  const d = _decide(thread({ autopilot_status: 'active', autopilot_spend_usd: 9 }), AP);
  assert.equal(d.fire, false);
  assert.match(d.escalate, /budget/);
});

test('decide: spinning past the attempt cap (no progress) escalates', () => {
  // sig for a nonexistent project is 'gone'; matching autopilot_sig => no progress.
  const d = _decide(thread({ autopilot_status: 'waiting', autopilot_sig: 'gone', autopilot_attempts: 8 }), AP);
  assert.equal(d.fire, false);
  assert.match(d.escalate, /no progress/);
});

test('decide: real progress resets the cap and fires (not escalate)', () => {
  const d = _decide(thread({ autopilot_status: 'waiting', autopilot_sig: 'OLD', autopilot_attempts: 8 }), AP);
  assert.equal(d.fire, true, 'signature changed → progressed → fire despite high attempts');
  assert.equal(d.progressed, true);
});

test('decide: waiting with nothing running fires (waited-on work ended)', () => {
  const d = _decide(thread({ autopilot_status: 'waiting', autopilot_sig: 'gone' }), AP);
  assert.equal(d.fire, true);
});

// ── Signature change detection (Phase A) ──────────────────────────────────────

test('signatureFor: changes when the run state changes', () => {
  upsertProject({ name: 'sig', tech_stack: 'node', total_phases: 3 });
  const s1 = _signatureFor('sig');
  startAutoRun({ project: 'sig', unattended: 1 });
  const s2 = _signatureFor('sig');
  assert.notEqual(s1, s2, 'starting a run moves the signature');
});

// ── Daemon safety (no Claude turn fires when disabled) ────────────────────────

test('tick: disabled autopilot leaves an armed thread untouched (never invokes Claude)', async () => {
  delete process.env.AORCH_CHAT_AUTOPILOT;   // rely on config default (off, no chat.autopilot key)
  const t = createChatThread({ title: 'armed-but-off' });
  setThreadAutopilot(t, { enabled: true, goal: 'do the thing' });
  await _tickOnce();                          // ap.enabled === false → early return, no engine call
  const row = getChatThread(t);
  assert.equal(row.autopilot_attempts, 0, 'no tick fired');
  assert.equal(row.autopilot_status, 'active');
});

test('startAutopilot is idempotent and stoppable', () => {
  const a = startAutopilot({ intervalMs: 3_600_000 });
  const b = startAutopilot({ intervalMs: 3_600_000 });
  assert.equal(a, b, 'second start returns the same timer (no duplicate loop)');
  stopAutopilot();
});
