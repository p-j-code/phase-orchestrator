// Checkpoint — decides whether the auto-runner should pause after a given event.
//
// Events: 'phase-completed', 'review-completed', 'fix-completed', 'phase-error'
//
// Returns { pause: bool, reason: string }
//
// Phase 64 (intent-based checkpointing) — auto_run.checkpoint_policy.mode
// governs WHICH completion checkpoints fire:
//   'all'         — every configured auto_pause_after_* checkpoint (today's
//                   behavior, byte-for-byte — the shipped default).
//   'intent'      — pause a phase completion ONLY when the NEXT phase's plan
//                   `checkpoint` tag is in pause_intents; count-based +
//                   review/fix checkpoints don't fire.
//   'errors-only' — pause on phase error + budget ONLY; every completion
//                   checkpoint (incl. final) is skipped.
// Error + budget pauses are IDENTICAL across every mode, and UNATTENDED mode
// WINS over any mode (its behavior is unchanged). Layer 1 (deterministic):
// auto_pause_after_phase_1_min_total_phases skips the phase-1 checkpoint when
// the plan is smaller than the threshold — independent of the policy mode.

import { windowStatus } from './billing-guard.js';
import { CHECKPOINT_INTENTS } from './lib/plan-validate.js';

// The three checkpoint_policy modes. Re-used by validateCheckpointPolicy and
// the chat set_checkpoint_policy tool.
export const CHECKPOINT_MODES = ['all', 'intent', 'errors-only'];

// Intents a mode:'intent' policy pauses before when the policy omits
// pause_intents. Mirrors config/defaults.json's auto_run.checkpoint_policy.
const DEFAULT_PAUSE_INTENTS = ['architecture', 'destructive'];

/**
 * Resolve the effective checkpoint policy from an auto_run config block. A
 * missing/malformed checkpoint_policy (legacy config) resolves to mode 'all'
 * with the default pause_intents — reproducing today's behavior exactly.
 *
 * @param {object} [ar] cfg.auto_run
 * @returns {{ mode: string, pause_intents: string[] }}
 */
export function resolveCheckpointPolicy(ar = {}) {
  const cp = (ar.checkpoint_policy && typeof ar.checkpoint_policy === 'object' && !Array.isArray(ar.checkpoint_policy))
    ? ar.checkpoint_policy
    : {};
  const mode = CHECKPOINT_MODES.includes(cp.mode) ? cp.mode : 'all';
  const pause_intents = Array.isArray(cp.pause_intents) ? cp.pause_intents : DEFAULT_PAUSE_INTENTS;
  return { mode, pause_intents };
}

/**
 * Validate a checkpoint_policy override BEFORE it is written to project.json.
 * Throws naming `configLayer` on a bad mode/intent — mirrors config-validator's
 * validateDenyRules / validateTaskProfiles convention. A null policy is a no-op.
 *
 * @param {unknown} policy      the layer's auto_run.checkpoint_policy value
 * @param {string}  configLayer human label of the layer being validated
 */
export function validateCheckpointPolicy(policy, configLayer) {
  if (policy == null) return;
  if (typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error(`Invalid checkpoint_policy in ${configLayer}: auto_run.checkpoint_policy must be an object { mode, pause_intents? }`);
  }
  if (policy.mode != null && !CHECKPOINT_MODES.includes(policy.mode)) {
    throw new Error(`Invalid checkpoint_policy.mode in ${configLayer}: ${JSON.stringify(policy.mode)} — must be one of ${CHECKPOINT_MODES.join(' | ')}`);
  }
  if (policy.pause_intents != null) {
    if (!Array.isArray(policy.pause_intents) || !policy.pause_intents.every((i) => CHECKPOINT_INTENTS.includes(i))) {
      throw new Error(`Invalid checkpoint_policy.pause_intents in ${configLayer}: must be an array of intent tags (${CHECKPOINT_INTENTS.join(' | ')})`);
    }
  }
}

export function shouldPauseAfter(event, cfg, ctx = {}) {
  const ar = cfg.auto_run || {};
  const { phaseN, totalPhases, isFinal, nextPhaseCheckpoint, error, unattended, label } = ctx;
  // v0.14.38: callers can pass a display label ("fix r2-3" / "phase 4");
  // fixes previously rendered as "phase-undefined".
  const what = label || `phase-${phaseN}`;

  // Unattended mode skips most checkpoints but NEVER skips errors or budget.
  // PRECEDENCE (phase 64): unattended WINS over any checkpoint_policy mode —
  // its behavior is unchanged regardless of the policy.
  if (unattended) {
    if (event === 'phase-error' && ar.auto_pause_on_error !== false) {
      return { pause: true, reason: `phase-error — ${what}: ${error || 'see report'}` };
    }
    return checkBudget(cfg, ar);
  }

  // Error pauses — always-on by default, IDENTICAL across every policy mode.
  if (event === 'phase-error' && ar.auto_pause_on_error !== false) {
    return { pause: true, reason: `${what} reported errors: ${error || 'see report'}` };
  }

  const { mode, pause_intents } = resolveCheckpointPolicy(ar);

  // 'errors-only' — no completion checkpoint pauses at all (phase-1, final,
  // custom, review, fix are ALL skipped); only error (above) + budget (below).
  if (mode === 'errors-only') {
    return checkBudget(cfg, ar);
  }

  // 'intent' — pause a phase completion ONLY when the NEXT phase's checkpoint
  // tag is in pause_intents (so the operator reviews BEFORE a tagged phase
  // runs). Count-based checkpoints (phase-1/final/custom) and review/fix
  // checkpoints don't fire in this mode; error + budget still do.
  if (mode === 'intent') {
    if (event === 'phase-completed'
        && typeof nextPhaseCheckpoint === 'string'
        && pause_intents.includes(nextPhaseCheckpoint)) {
      // 'verify before continuing' keeps classifyPauseReason → review-checkpoint.
      return { pause: true, reason: `checkpoint '${nextPhaseCheckpoint}' intent — verify before continuing to the next phase (policy: intent)` };
    }
    return checkBudget(cfg, ar);
  }

  // mode 'all' (default) — every current checkpoint decision, byte-for-byte.

  // Phase 1 checkpoint. Layer 1 (deterministic, phase 64): skip it when the
  // plan is SMALLER than auto_pause_after_phase_1_min_total_phases — so a short
  // tweak doesn't pause as often as a big build. Default 0 never skips
  // (totalPhases < 0 is impossible), and an absent/non-integer totalPhases also
  // never skips — both reproduce today's behavior exactly.
  if (event === 'phase-completed' && phaseN === 1 && ar.auto_pause_after_phase_1) {
    const minTotal = ar.auto_pause_after_phase_1_min_total_phases ?? 0;
    if (!(Number.isInteger(totalPhases) && totalPhases < minTotal)) {
      return { pause: true, reason: 'auto_pause_after_phase_1 (verify foundation before continuing)' };
    }
  }

  // Final phase checkpoint
  if (event === 'phase-completed' && isFinal && ar.auto_pause_after_final_phase) {
    return { pause: true, reason: 'auto_pause_after_final_phase (all phases done, ready for QA)' };
  }

  // Custom phase checkpoint
  if (event === 'phase-completed' && Array.isArray(ar.auto_pause_after_phases) && ar.auto_pause_after_phases.includes(phaseN)) {
    return { pause: true, reason: `auto_pause_after_phases (custom checkpoint at phase ${phaseN})` };
  }

  // Review checkpoint
  if (event === 'review-completed' && ar.auto_pause_after_review) {
    return { pause: true, reason: `auto_pause_after_review (review at phase ${phaseN} done, verify before continuing)` };
  }

  // Fix-round end checkpoint
  if (event === 'fix-completed' && ctx.isFinalFix && (cfg.bug_cycle?.review_after_round ?? true)) {
    return { pause: true, reason: 'fix round complete, ready for QA re-verification' };
  }

  // Budget guard
  return checkBudget(cfg, ar);
}

function checkBudget(cfg, ar) {
  const ws = windowStatus(cfg);
  if (ws.state === 'pause') {
    return { pause: true, reason: `budget pause: ${ws.callsInWindow} heavy-equivalent units (${ws.rawCallsInWindow} raw attempts) in last ${ws.windowHours}h` };
  }
  if (ws.state === 'warn' && ar.auto_pause_on_budget_warn) {
    return { pause: true, reason: `budget warn: ${ws.callsInWindow} heavy-equivalent units (${ws.rawCallsInWindow} raw attempts) in last ${ws.windowHours}h (warn threshold)` };
  }
  return { pause: false };
}

export function describeCheckpoints(cfg) {
  const ar = cfg.auto_run || {};
  const { mode, pause_intents } = resolveCheckpointPolicy(ar);
  const lines = [];

  const budgetLines = () => {
    if (ar.auto_pause_on_error !== false) lines.push('• on any phase error');
    if (ar.auto_pause_on_budget_warn) lines.push('• on budget warn (' + (cfg.billing?.warn_at_calls ?? 50) + ' calls)');
    lines.push('• on budget pause (' + (cfg.billing?.pause_at_calls ?? 80) + ' calls)');
  };

  // Policy header — the active mode governs which of the checkpoints below fire.
  if (mode === 'intent') {
    lines.push(`• policy: intent — pause before phases tagged: ${pause_intents.join(', ') || '(none)'}`);
    budgetLines();
    return lines.join('\n');
  }
  if (mode === 'errors-only') {
    lines.push('• policy: errors-only — phase/review/fix checkpoints skipped');
    budgetLines();
    return lines.join('\n');
  }

  // mode 'all' — every configured checkpoint.
  lines.push('• policy: all');
  if (ar.auto_pause_after_phase_1) {
    const minTotal = ar.auto_pause_after_phase_1_min_total_phases ?? 0;
    lines.push(minTotal > 0 ? `• after phase 1 (only when plan has ≥ ${minTotal} phases)` : '• after phase 1');
  }
  if (ar.auto_pause_after_review) lines.push('• after every review');
  if (ar.auto_pause_after_final_phase) lines.push('• after final phase');
  if (Array.isArray(ar.auto_pause_after_phases) && ar.auto_pause_after_phases.length) {
    lines.push(`• after phases: ${ar.auto_pause_after_phases.join(', ')}`);
  }
  budgetLines();
  return lines.join('\n');
}
