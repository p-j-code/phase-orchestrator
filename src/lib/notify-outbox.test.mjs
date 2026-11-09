// Tests for Phase 58 (notify_outbox — pings independent of launch surface).
// Covers the state.js outbox helpers (queueNotify / markOutboxDelivered /
// recordOutboxFailure / listPendingOutbox / listOutboxSince / getMaxOutboxId)
// and notify-outbox.js's delivery-loop tick (the fallback deliverer that
// server-discord.js schedules every 10s).
//
// Run with: node --test src/lib/notify-outbox.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';

const {
  queueNotify, markOutboxDelivered, recordOutboxFailure,
  listPendingOutbox, listOutboxSince, getMaxOutboxId,
} = await import('../state.js');
const {
  notifyOutboxTick, startNotifyOutboxDelivery, stopNotifyOutboxDelivery,
  isNotifyOutboxDeliveryRunning,
} = await import('./notify-outbox.js');

// A notifier stub that always throws — drives the retry/fail path.
function throwingNotifier() {
  const calls = [];
  return {
    calls,
    async notify(payload) { calls.push(payload); throw new Error('discord down'); },
  };
}

// A notifier stub that always resolves — drives the delivered path.
function okNotifier() {
  const calls = [];
  return {
    calls,
    async notify(payload) { calls.push(payload); return { delivered: 1, total: 1 }; },
  };
}

// A notifier stub that resolves but reaches nobody (Notifier never throws;
// { total>0, delivered:0 } means recipients existed but all failed).
function unreachableNotifier() {
  return { async notify() { return { delivered: 0, total: 2 }; } };
}

// ─── queueNotify ────────────────────────────────────────────────────────────

test('queueNotify inserts a pending row and returns its id', () => {
  const id = queueNotify({ project: 'demo', text: 'hello' });
  assert.equal(typeof id, 'number');
  const rows = listPendingOutbox(50).filter((r) => r.id === id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].project, 'demo');
  assert.equal(rows[0].text, 'hello');
  assert.equal(rows[0].attempts, 0);
  assert.equal(rows[0].delivered_at, null);
});

test('queueNotify never throws — missing text returns null, no row written', () => {
  const before = getMaxOutboxId();
  let id;
  assert.doesNotThrow(() => { id = queueNotify({ project: 'demo' }); });
  assert.equal(id, null);
  assert.equal(getMaxOutboxId(), before);
});

test('queueNotify serialises replyMarkup as JSON', () => {
  const id = queueNotify({ project: 'demo', text: 'buttons', replyMarkup: { a: 1 } });
  const row = listPendingOutbox(50).find((r) => r.id === id);
  assert.equal(row.reply_markup, JSON.stringify({ a: 1 }));
});

// ─── fast path (live-notifier delivery) ─────────────────────────────────────

test('markOutboxDelivered flips a row to delivered and it drops out of the pending batch', () => {
  const id = queueNotify({ project: 'demo', text: 'fast-path' });
  assert.ok(listPendingOutbox(50).some((r) => r.id === id));
  markOutboxDelivered(id);
  const pendingIds = listPendingOutbox(50).map((r) => r.id);
  // The delivery loop selects status='pending' only, so a fast-path-delivered
  // row is never re-delivered by notifyOutboxTick.
  assert.ok(!pendingIds.includes(id));
});

test('delivery loop does NOT re-deliver a row already marked delivered by the fast path', async () => {
  const id = queueNotify({ project: 'demo', text: 'already-sent' });
  markOutboxDelivered(id);
  const notifier = okNotifier();
  await notifyOutboxTick({ notifier });
  // notifier.notify was never invoked for the already-delivered row.
  assert.ok(!notifier.calls.some((c) => c.text === 'already-sent'));
});

// ─── delivery-loop retry/fail path ──────────────────────────────────────────

test('a throwing notifier drives a pending row to attempts=5 then status=failed', async () => {
  const id = queueNotify({ project: 'demo', text: 'retry-me' });
  const notifier = throwingNotifier();

  for (let i = 1; i <= 4; i++) {
    const res = await notifyOutboxTick({ notifier });
    assert.equal(res.failed, 1);
    const row = allRowById(id);
    assert.equal(row.attempts, i);
    assert.equal(row.status, 'pending', `still pending after ${i} failure(s)`);
  }

  // 5th failure flips status to 'failed' and it stops being retried.
  const res = await notifyOutboxTick({ notifier });
  assert.equal(res.failed, 1);
  let row = allRowById(id);
  assert.equal(row.attempts, 5);
  assert.equal(row.status, 'failed');

  // Now it is out of the pending batch — a further tick is a no-op for it.
  const after = await notifyOutboxTick({ notifier });
  assert.equal(after.delivered, 0);
  row = allRowById(id);
  assert.equal(row.attempts, 5, 'attempts frozen once failed');
});

test('a succeeding notifier marks a pending row delivered', async () => {
  const id = queueNotify({ project: 'demo', text: 'deliver-me' });
  const notifier = okNotifier();
  const res = await notifyOutboxTick({ notifier });
  assert.ok(res.delivered >= 1);
  const row = allRowById(id);
  assert.equal(row.status, 'delivered');
  assert.notEqual(row.delivered_at, null);
  assert.ok(notifier.calls.some((c) => c.text === 'deliver-me'));
});

test('an unreachable notifier (resolves with delivered:0,total>0) counts as a failure, not a delivery', async () => {
  const id = queueNotify({ project: 'demo', text: 'nobody-home' });
  const res = await notifyOutboxTick({ notifier: unreachableNotifier() });
  assert.equal(res.delivered, 0);
  assert.equal(res.failed, 1);
  const row = allRowById(id);
  assert.equal(row.attempts, 1);
  assert.equal(row.status, 'pending');
});

test('notifyOutboxTick with no notifier is a no-op', async () => {
  const res = await notifyOutboxTick({ notifier: null });
  assert.deepEqual(res, { delivered: 0, failed: 0 });
});

test('notifyOutboxTick delivers oldest-first and honours the batch cap', async () => {
  // Drain anything still pending from earlier tests first.
  await notifyOutboxTick({ notifier: okNotifier(), limit: 1000 });
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(queueNotify({ project: 'demo', text: `batch-${i}` }));
  const notifier = okNotifier();
  const res = await notifyOutboxTick({ notifier, limit: 3 });
  assert.equal(res.delivered, 3);
  // Oldest three (lowest ids) went first.
  assert.deepEqual(notifier.calls.map((c) => c.text), ['batch-0', 'batch-1', 'batch-2']);
});

// ─── SSE cursor helpers (listOutboxSince / getMaxOutboxId) ───────────────────

test('listOutboxSince returns only rows newer than the cursor — emit exactly once', () => {
  const cursor = getMaxOutboxId();
  const id1 = queueNotify({ project: 'demo', text: 'sse-1' });
  const id2 = queueNotify({ project: 'demo', text: 'sse-2' });

  const firstPoll = listOutboxSince(cursor);
  const seen = firstPoll.filter((r) => r.id === id1 || r.id === id2);
  assert.equal(seen.length, 2);

  // Advance the cursor past everything seen (what the SSE tick does).
  const advanced = firstPoll[firstPoll.length - 1].id;
  // A second poll with the advanced cursor yields no duplicates.
  assert.equal(listOutboxSince(advanced).length, 0);

  // A brand-new row shows up exactly once on the next poll.
  const id3 = queueNotify({ project: 'demo', text: 'sse-3' });
  const secondPoll = listOutboxSince(advanced);
  assert.equal(secondPoll.length, 1);
  assert.equal(secondPoll[0].id, id3);
});

// ─── delivery-loop lifecycle (setInterval registration) ─────────────────────

test('start/stopNotifyOutboxDelivery registers and clears the interval', () => {
  assert.equal(isNotifyOutboxDeliveryRunning(), false);
  const stop = startNotifyOutboxDelivery({ intervalMs: 10_000, notifier: okNotifier() });
  assert.equal(isNotifyOutboxDeliveryRunning(), true);
  // Double-start is a no-op (still running, no throw).
  startNotifyOutboxDelivery({ intervalMs: 10_000, notifier: okNotifier() });
  assert.equal(isNotifyOutboxDeliveryRunning(), true);
  stop();
  assert.equal(isNotifyOutboxDeliveryRunning(), false);
  stopNotifyOutboxDelivery(); // idempotent
  assert.equal(isNotifyOutboxDeliveryRunning(), false);
});

// Helper: fetch any row (any status) by id via the "since" reader.
function allRowById(id) {
  return listOutboxSince(id - 1).find((r) => r.id === id);
}
