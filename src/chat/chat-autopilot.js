// Chat Autopilot — the always-on loop that turns the chat control plane from a
// fire-and-forget operator into a drive-to-done agent.
//
// The chat engine is one `claude -p` turn per message: it fires a detached
// action (a run, an audit, a bug round) and stops. Nothing re-triggered it when
// that action paused, finished, or died — so an "autonomous" issue thread only
// ever got ONE shot. This daemon closes that gap: for every thread flagged
// autopilot=1 it watches the focus project's state and re-invokes the engine
// (isTick:true) whenever there is a reason to act — state moved, a run paused,
// or the thing it was waiting on ended — until the agent reports DONE or BLOCKED.
//
// It is deliberately DECOUPLED from web-ui.js's SSE tick (which only runs while
// a dashboard is open); this interval runs from server boot regardless, so the
// NAS drives work 24/7 with no browser attached.
//
// Guardrails (guarded-autopilot policy — see prompts/chat-system + the engine's
// <autopilot> directive):
//   - The agent is pre-authorized to SPEND within a per-thread budget, but must
//     escalate ship / orchestrator_dev / abort to a human (BLOCKED token).
//   - The billing window pauses the whole loop (shouldPause).
//   - A per-thread attempt cap stops a spin that makes no progress.
//   - A per-thread dollar budget stops runaway spend.
// Everything is behind cfg.chat.autopilot.enabled (default false).

import { resolve as resolveConfig } from '../config-resolver.js';
import { shouldPause } from '../billing-guard.js';
import {
  getProject, getActiveAutoRun, getLastAutoRun, countBugs, countRequirements,
  recentDetachedSpawn, sweepInterruptedAutoRuns, isChatThreadLocked,
  getAutopilotThreads, setAutopilotStatus, resetAutopilotAttempts,
  recordAutopilotTurn, addChatMessage, touchChatThread,
} from '../state.js';
import { sendChatMessage, autopilotConfig, SELF_PROJECT } from './chat-engine.js';
import { providerCircuitStatus } from '../lib/provider-circuit-breaker.js';

// Hard stop for a loop that keeps producing ERRORED turns (no control token,
// no progress): unlike the attempt cap, this cannot be reset by state-signature
// churn caused by the loop's own failing actions.
const MAX_CONSECUTIVE_ERRORED_TICKS = 5;

const TICK_MESSAGE = [
  '[autopilot] Continuation tick. First re-read the live <orchestrator_state> and check the outcome of your',
  'last action (project_overview / recentDetachedSpawn — did it complete, pause, or die?). Then take the single',
  'next step toward the goal, or report status with the control token. Never re-launch work that is already running.',
].join(' ');

let _timer = null;
let _ticking = false;
let _pausedLogged = false;

// inbox "awaiting" count — same set control-actions counts (inbox + refined).
function inboxCount(rows) {
  return (rows || []).filter((r) => r.status === 'inbox' || r.status === 'refined')
    .reduce((s, r) => s + (r.n || 0), 0);
}

// A compact fingerprint of the focus project's state. A change between ticks is
// the "something happened, act" signal; no change while work runs means "wait".
function signatureFor(project) {
  if (!project || project === SELF_PROJECT) return 'self';
  const p = getProject(project);
  if (!p) return 'gone';
  const active = getActiveAutoRun(project);
  const last = active || getLastAutoRun(project);
  const spawn = recentDetachedSpawn(project);
  return [
    p.status,
    `${p.current_phase}/${p.total_phases}`,
    last ? `${last.status}#${last.id}` : 'run:none',
    `b${inboxCount(countBugs(project))}`,
    `r${inboxCount(countRequirements(project))}`,
    spawn ? `s${spawn.id}${spawn.alive ? '+' : '-'}` : 's0',
  ].join('|');
}

// Is the focus project actively working (a live run or a fresh live spawn)?
function projectBusy(project) {
  if (!project || project === SELF_PROJECT) return false;
  if (getActiveAutoRun(project)) return true;
  const spawn = recentDetachedSpawn(project);
  return !!(spawn && spawn.alive && spawn.age_s < 600);
}

function runPaused(project) {
  if (!project || project === SELF_PROJECT) return false;
  if (getActiveAutoRun(project)) return false;      // still running, not paused
  return getLastAutoRun(project)?.status === 'paused';
}

// Post an operator-visible note into the thread (in-band escalation / status).
function note(threadId, text) {
  try {
    addChatMessage({ thread_id: threadId, role: 'system', content: text, meta: { autopilot: true } });
    touchChatThread(threadId);
  } catch { /* never let a note failure break the loop */ }
}

function backoffMs(signalState, tickMs) {
  if (signalState === 'WAITING') return tickMs * 3;   // work in flight — check less often
  if (signalState === 'WORKING') return tickMs;       // keep driving
  return tickMs;
}

/**
 * Decide whether to fire a tick for this thread now.
 * @returns {{fire:boolean, escalate?:string, progressed?:boolean, sig:string}}
 */
function decide(thread, ap) {
  const project = thread.project;
  const sig = signatureFor(project);
  const progressed = thread.autopilot_sig != null && sig !== thread.autopilot_sig;

  // Hard stops — escalate to the operator, stop looping this thread.
  if ((thread.autopilot_spend_usd || 0) >= ap.budgetUsd) {
    return { fire: false, escalate: `budget reached ($${(thread.autopilot_spend_usd || 0).toFixed(2)} / $${ap.budgetUsd.toFixed(2)})`, sig };
  }
  if (!progressed && (thread.autopilot_attempts || 0) >= ap.maxAttempts) {
    return { fire: false, escalate: `no progress after ${ap.maxAttempts} attempts`, sig };
  }

  const status = thread.autopilot_status || 'active';
  // Fire when there's a reason to act:
  if (status === 'active') return { fire: true, progressed, sig };       // fresh / just reset by progress or human
  if (progressed) return { fire: true, progressed, sig };                 // state moved — verify / continue
  if (runPaused(project)) return { fire: true, progressed, sig };         // a run paused — decision point
  if (status === 'waiting' && !projectBusy(project)) return { fire: true, progressed, sig }; // waited-on work ended
  return { fire: false, progressed, sig };                                // still working — wait
}

async function tickThread(thread, ap) {
  if (isChatThreadLocked(thread.id)) return;                 // a turn is already in flight
  if (thread.autopilot_next_at && new Date(thread.autopilot_next_at).getTime() > Date.now()) return; // backoff

  const { fire, escalate, progressed, sig } = decide(thread, ap);

  if (escalate) {
    setAutopilotStatus(thread.id, 'escalated');
    note(thread.id, `🔴 Autopilot paused — ${escalate}. Reply with direction to resume (or turn autopilot off).`);
    return;
  }
  if (!fire) return;

  // Genuine state movement resets the spin counter, so the attempt cap only
  // trips on real spinning (N ticks with nothing changing).
  if (progressed) resetAutopilotAttempts(thread.id, { sig });

  let res;
  try {
    res = await sendChatMessage({ threadId: thread.id, message: TICK_MESSAGE, isTick: true });
  } catch (e) {
    // Engine threw despite the tick contract (should be rare — it returns
    // {skipped} for busy/pause). Record it in-band and back off a full cycle.
    note(thread.id, `⚠ Autopilot tick error: ${e.message}`);
    recordAutopilotTurn(thread.id, { nextAt: new Date(Date.now() + ap.tickMs * 3).toISOString(), sig });
    return;
  }
  if (res?.skipped) {
    // Pre-flight rate-limit skip: park the thread until the advertised reset
    // instead of drumming against the closed window every tick.
    if (res.rate_limited) {
      const until = res.resets_at && res.resets_at > Date.now()
        ? res.resets_at + 60_000
        : Date.now() + ap.tickMs * 10;
      recordAutopilotTurn(thread.id, { nextAt: new Date(until).toISOString(), errored: true });
    }
    return;                                                  // busy — retry next tick, no accounting
  }

  // An errored turn is NOT progress. It has no control token, and treating it
  // as WORKING made the loop refire on the base cadence forever — appending a
  // tick row + an error row every ~20s while the provider was rejecting calls.
  // Rate-limited turns park until reset; other errors back off hard and count
  // toward a consecutive-error cap (the attempt cap can't catch this: the
  // loop's own failures churn the state signature and keep resetting it).
  if (res?.error) {
    const streak = (thread.autopilot_error_streak || 0) + 1;
    if (res.rate_limited) {
      const until = res.resets_at && res.resets_at > Date.now()
        ? res.resets_at + 60_000
        : Date.now() + ap.tickMs * 10;
      recordAutopilotTurn(thread.id, { nextAt: new Date(until).toISOString(), errored: true });
      return;
    }
    if (streak >= MAX_CONSECUTIVE_ERRORED_TICKS) {
      recordAutopilotTurn(thread.id, { errored: true, status: 'escalated' });
      note(thread.id, `🔴 Autopilot paused — ${streak} consecutive errored ticks. Reply with direction to resume (or turn autopilot off).`);
      return;
    }
    recordAutopilotTurn(thread.id, { nextAt: new Date(Date.now() + ap.tickMs * 10).toISOString(), errored: true });
    return;
  }

  const state = res.autopilot_signal?.state || 'WORKING';
  recordAutopilotTurn(thread.id, {
    spendDelta: res.cost_usd || 0,
    nextAt: new Date(Date.now() + backoffMs(state, ap.tickMs)).toISOString(),
    sig,
  });

  if (state === 'DONE') note(thread.id, '✅ Autopilot: goal reported complete. Loop stopped for this thread.');
  else if (state === 'BLOCKED') note(thread.id, `🔴 Autopilot needs you${res.autopilot_signal?.note ? `: ${res.autopilot_signal.note}` : '.'} Reply to unblock.`);
}

async function tick() {
  if (_ticking) return;
  _ticking = true;
  try {
    const cfg = await resolveConfig({ project: null, task: 'chat' });
    const ap = autopilotConfig(cfg);
    if (!ap.enabled) return;                                 // globally off — nothing to do

    // R4 — reconcile crashed 'running' rows so getActiveAutoRun/projectBusy are
    // honest before we make any fire/wait decision on them.
    try { sweepInterruptedAutoRuns(); } catch { /* best effort */ }

    if (shouldPause(cfg)) {
      if (!_pausedLogged) { console.error('[autopilot] billing window exhausted — holding all threads until it clears'); _pausedLogged = true; }
      return;
    }
    // Shared provider breaker open (another process observed a rejection or a
    // near-exhaustion warning): hold every thread — a tick spawned now is a
    // guaranteed rejection.
    if (providerCircuitStatus(cfg)?.open) {
      if (!_pausedLogged) { console.error('[autopilot] provider circuit open — holding all threads until reset'); _pausedLogged = true; }
      return;
    }
    _pausedLogged = false;

    const threads = getAutopilotThreads();
    // Sequential: one turn at a time across all autopilot threads bounds spend
    // and avoids parallel `claude -p` turns racing the window.
    for (const thread of threads) {
      try { await tickThread(thread, ap); }
      catch (e) { console.error(`[autopilot] thread ${thread.id} tick failed: ${e.message}`); }
    }
  } catch (e) {
    console.error(`[autopilot] tick failed: ${e.message}`);
  } finally {
    _ticking = false;
  }
}

/**
 * Start the autopilot daemon. Idempotent. Safe to call even when autopilot is
 * disabled in config — it just finds nothing to do each tick (and honors the
 * flag being flipped on later without a restart). `intervalMs` is the poll
 * cadence; the per-thread backoff (autopilot_next_at) does the real pacing.
 */
export function startAutopilot({ intervalMs = 15000 } = {}) {
  if (_timer) return _timer;
  console.error(`[autopilot] daemon started (poll every ${Math.round(intervalMs / 1000)}s)`);
  _timer = setInterval(() => { void tick(); }, intervalMs);
  _timer.unref?.();                                          // don't keep the process alive just for this
  return _timer;
}

export function stopAutopilot() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

// Exposed for tests and one-shot ticks.
export { tick as _tickOnce, decide as _decide, signatureFor as _signatureFor };
