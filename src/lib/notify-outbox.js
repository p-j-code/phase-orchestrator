// Notify-outbox delivery loop (Phase 58 — pings independent of launch
// surface). auto-runner.js's queueNotify() call sites durably log every
// run-lifecycle notice to notify_outbox regardless of whether a live
// notifier was in scope at spawn time (a bare CLI launch from web-ui.js's
// spawnOrchestrator or chat/control-actions.js's spawnDetached runs
// autoRun() with notifier:null). This module is the FALLBACK deliverer:
// whatever the live notifier's fast path (mark-delivered-in-the-same-tick)
// didn't already handle, this 10s poll picks up and sends.
//
// Pure/testable: notifyOutboxTick takes a plain `{ notify({text, replyMarkup}) }`
// notifier (project-conventions.md's "render/load split" precedent —
// src/lib/operator-questions.js's operatorQuestionsTick is the sibling this
// mirrors) — no timers, no bot/transport types.

import { listPendingOutbox, markOutboxDelivered, recordOutboxFailure, expireStaleOutbox } from '../state.js';

const DEFAULT_BATCH_LIMIT = 20;

/**
 * One delivery-loop tick: send every currently-`pending` row (oldest first,
 * capped at `limit`) via `notifier.notify`. Success marks the row
 * `delivered`; failure increments `attempts` (and flips to `status:'failed'`
 * at the 5th failure — see state.js's recordOutboxFailure). A row already
 * marked `delivered` by a live-notifier fast path elsewhere never appears
 * here (the SELECT is `status = 'pending'` only) — this loop never
 * re-delivers it.
 *
 * @param {{notifier?: {notify: Function}, limit?: number}} opts
 * @returns {Promise<{delivered: number, failed: number}>}
 */
export async function notifyOutboxTick({ notifier = null, limit = DEFAULT_BATCH_LIMIT } = {}) {
  if (!notifier) return { delivered: 0, failed: 0 };
  // A backlog accumulated while no transport was running (web-ui-only host)
  // must not flood the phone on the first real server start: expire >24h rows
  // before selecting the batch.
  expireStaleOutbox(24);
  const rows = listPendingOutbox(limit);
  let delivered = 0;
  let failed = 0;
  for (const row of rows) {
    let replyMarkup;
    try {
      replyMarkup = row.reply_markup ? JSON.parse(row.reply_markup) : undefined;
    } catch {
      replyMarkup = undefined; // malformed JSON never blocks delivery of the text
    }
    try {
      const res = await notifier.notify({ text: row.text, replyMarkup });
      // The real Notifier never throws — it returns { delivered, total }. Treat
      // "there were recipients but none were reached" as a failure so a
      // transiently-unreachable phone retries rather than silently marking the
      // ping delivered-and-lost. A resolved call with no such shape (undefined,
      // total===0 "no allowlisted users", or delivered>0) counts as delivered.
      if (res && typeof res.total === 'number' && res.total > 0 && res.delivered === 0) {
        recordOutboxFailure(row.id);
        failed++;
        continue;
      }
      markOutboxDelivered(row.id);
      delivered++;
    } catch (err) {
      recordOutboxFailure(row.id);
      failed++;
      console.warn(`[notify-outbox] delivery failed for #${row.id} (attempt logged, non-fatal): ${err.message}`);
    }
  }
  return { delivered, failed };
}

let _timer = null;
let _running = false;

/**
 * Start the unref'd delivery loop (project-watchdog.js / operator-questions.js
 * precedent). Calling twice while already running is a no-op.
 * @returns {() => void} stop function
 */
export function startNotifyOutboxDelivery({ intervalMs = 10_000, notifier = null, limit = DEFAULT_BATCH_LIMIT } = {}) {
  if (_timer) return () => stopNotifyOutboxDelivery();

  const tick = async () => {
    if (_running) return; // skip if the previous tick is still in flight
    _running = true;
    try {
      await notifyOutboxTick({ notifier, limit });
    } catch (e) {
      console.warn(`[notify-outbox] tick error: ${e.message}`);
    } finally {
      _running = false;
    }
  };

  _timer = setInterval(tick, intervalMs);
  if (_timer.unref) _timer.unref(); // don't block process exit
  return () => stopNotifyOutboxDelivery();
}

export function stopNotifyOutboxDelivery() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    _running = false;
  }
}

/** Test/introspection seam only — true while the delivery loop interval is registered. */
export function isNotifyOutboxDeliveryRunning() {
  return _timer !== null;
}
