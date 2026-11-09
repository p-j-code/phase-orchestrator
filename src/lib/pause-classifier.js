// Pause reason classifier — single authoritative taxonomy for auto_runs pause states.
//
// Usage:
//   import { classifyPauseReason, PAUSE_KINDS } from './pause-classifier.js';
//   const kind = classifyPauseReason(lastRun.pause_reason);
//
// Path B note: new auto-runner pause sites should pass PAUSE_KINDS.<K> directly
// to finalize() via pauseKind param. This classifier handles NULL/legacy rows
// where pause_kind IS NULL (rows created before the migrate-pause-kind migration).
//
// Boundary with Fix 4 (cancelled): status='cancelled' (SIGINT/abort) is NOT a pause.
// The projects.status='cancelled' path is routed separately in coach.js rule 1.5.
// classifyPauseReason is never called for cancelled runs.

export const PAUSE_KINDS = {
  ALL_PHASES_COMPLETE: 'all-phases-complete',
  FIX_ROUND_COMPLETE:  'fix-round-complete',
  BUDGET:              'budget',
  VALIDATOR_FAILED:    'validator-failed',
  REVIEW_CHECKPOINT:   'review-checkpoint',
  MAX_ACTIONS:         'max-actions',
  MID_BUILD:           'mid-build',
  CONVERGENCE_STALL:   'convergence-stall',
  WINDOW_HEADROOM:     'window-headroom',
  // A phase burned its full cross-run reprompt budget and still fails the same
  // way — auto-resume would just replay the loop; an operator (or a plan/
  // criteria change) is needed. The watchdog refuses to resume this kind.
  REPROMPT_EXHAUSTED:  'reprompt-exhausted',
  OTHER:               'other',
};

/**
 * Classify a pause reason string into a PAUSE_KINDS constant.
 * @param {string|null|undefined} reason
 * @returns {string} one of PAUSE_KINDS values
 */
export function classifyPauseReason(reason) {
  if (!reason) return PAUSE_KINDS.OTHER;
  const r = reason.toLowerCase();

  // reprompt-exhausted: checked FIRST — the reason embeds the phase's raw
  // failure text (often "tool call hung…"/"timed out…"), which later patterns
  // would otherwise classify as a resumable mid-build error.
  if (r.includes('reprompt budget exhausted')) return PAUSE_KINDS.REPROMPT_EXHAUSTED;

  // all-phases-complete: from pickNextAction (auto-runner:200) and final-phase checkpoint
  if (
    (r.includes('all') && r.includes('phases') && (r.includes('complete') || r.includes('final review')))
    || r.includes('run manual qa') || r.includes('ready-for-qa')
  ) {
    return PAUSE_KINDS.ALL_PHASES_COMPLETE;
  }

  // fix-round-complete: from pickBugAction (auto-runner:246) and checkpoint.js:48
  // Matches: 'Fix round N complete (N fixes)...' AND 'fix round complete, ready for QA...'
  if (r.includes('fix round') && r.includes('complete')) return PAUSE_KINDS.FIX_ROUND_COMPLETE;

  // budget: from budget-guard (auto-runner:101, checkpoint.js)
  if (r.startsWith('budget:') || r.startsWith('budget pause:') || r.startsWith('budget warn:')) {
    return PAUSE_KINDS.BUDGET;
  }
  if (r.includes('session limit') || r.includes('usage limit') || r.includes('rate_limit_event')
      || r.includes('five_hour') || r.includes('billing window')
      || r.includes('provider circuit breaker open') || r.includes('provider circuit open')
      || (r.includes('weekly') && r.includes('limit'))) {
    return PAUSE_KINDS.BUDGET;
  }

  // validator-failed: from _validation_failed path
  if (r.includes('validator') || r.includes('validators failed')) return PAUSE_KINDS.VALIDATOR_FAILED;

  // review-checkpoint: from auto_pause_after_* config (checkpoint.js)
  if (r.startsWith('auto_pause_after') || r.includes('verify before continuing') || r.includes('verify foundation')) {
    return PAUSE_KINDS.REVIEW_CHECKPOINT;
  }

  // max-actions: from maxActions guard (auto-runner)
  if (r.startsWith('max_phases_per_run')) return PAUSE_KINDS.MAX_ACTIONS;

  // convergence-stall: Phase 43 (P7) FR20 pause — same-finding recurrence
  // across rounds detected by audit-promote.js's per-finding matcher
  if (r.startsWith('convergence stall')) return PAUSE_KINDS.CONVERGENCE_STALL;

  // window-headroom: Phase 79 (P2) — a heavy next action (dev/audit) would not
  // fit the remaining 'warn' billing window; the run pauses and a resume job is
  // scheduled for the projected reset.
  if (r === 'window-headroom' || r.startsWith('window-headroom')) return PAUSE_KINDS.WINDOW_HEADROOM;

  // phase errors → mid-build
  if (r.startsWith('phase-error') || r.includes('reported errors')) return PAUSE_KINDS.MID_BUILD;

  // catch-all: unrecognised reasons — Resume is safe
  return PAUSE_KINDS.MID_BUILD;
}
