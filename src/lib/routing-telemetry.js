// Telemetry-learned routing floors (Phase 56, MI-5).
//
// A PURE, deterministic, no-IO decision module. It reads recorded calls-table
// outcomes (queried and passed in by the caller — src/auto-runner.js's
// applyTelemetryRoutingFloors) and produces the per-task tier FLOOR the project
// should start on, so a project whose dev/fix phases have repeatedly failed on
// sonnet and paid the fail-then-escalate double bill starts the next phase on
// opus directly. Rules over recorded outcomes only — no LLM, no clock, no
// randomness (Date/Math.random would break determinism, and the caller stamps
// task_floors_meta.updated_at, not this module).
//
// The two learned tasks are dev-execution and fix-execution — the only tasks in
// config/model-routing.json's escalation_tasks, so the only ones whose failures
// drive an escalation. Everything else keeps its baseline + keyword/hard floors.
//
// 2026-07-12 (window economy): two additions, both still pure.
//   1. CLASSIFIED FAILURES — only CAPABILITY failures feed the escalation rate.
//      An is_error row whose error_message classifies as environmental
//      (rate_limit_event, error_max_turns, network, budget-pause, stall/timeout)
//      says nothing about the model and previously created a vicious cycle:
//      rate-limited sonnet calls counted as "sonnet failing" → learned opus
//      floor → opus drains the 5h window ~5× faster → more rate limits → the
//      floor never decays (aorch learned exactly this floor from a 2/6 sample
//      of max-turns/rate-limit noise). Environmental rows are now excluded from
//      BOTH the numerator and the denominator of the raise rate, and skipped
//      (not streak-breaking) by decay/demote streaks.
//   2. DEMOTION (learned task_caps) — the mirror of the floors: a task whose
//      recent calls all ran clean at one tier, well under budget, earns a cap
//      one tier BELOW the observed tier. routeModel applies a learned cap only
//      on the clean-baseline path at LOW complexity (never over a phase
//      override, keyword rule, hard floor, or learned floor), and ONE
//      capability failure at the capped tier removes the cap on the next
//      preflight — fail-fast undo. Default demote tasks = TELEMETRY_TASKS
//      only: dev/fix failures are externally observable (acceptance gate →
//      is_error), so a bad demotion is caught; judgment tasks like
//      3-phase-review "succeed" even when a weak model misses bugs, so they
//      are NEVER demoted by default (opt in via telemetry.demote_tasks).

import { TIER_ORDER, tierIndex, modelToTier } from '../model-router.js';
import { classifyError, ERROR_KINDS } from './error-classifier.js';

export const TELEMETRY_TASKS = ['dev-execution', 'fix-execution'];

// Error kinds that carry NO signal about model capability. VALIDATION (e.g.
// "failed acceptance verification"), ORCHESTRATOR_BUG, and UNKNOWN (including
// legacy rows with no error_message at all) still count as capability failures
// — UNKNOWN stays capability so an unexplained failure can still escalate, and
// so pre-existing tests/rows without error_message keep their old meaning.
const ENVIRONMENTAL_KINDS = new Set([
  ERROR_KINDS.PROVIDER_LIMIT, // account/window exhaustion; scheduler owns reset
  ERROR_KINDS.NETWORK,       // rate_limit_event, 5xx, socket errors
  ERROR_KINDS.BUDGET,        // billing-window pause
  ERROR_KINDS.PHASE_STUCK,   // error_max_turns, stalls, timeouts, `claude exited N`
  ERROR_KINDS.MONITOR_WAIT,
  ERROR_KINDS.GIT_DIVERGED,
  ERROR_KINDS.GIT_DIRTY,
  ERROR_KINDS.DEPENDENCY,
]);

/** An is_error row whose message classifies as environment/transient — not the model's fault. */
export function isEnvironmentalFailure(row) {
  if (!row?.is_error) return false;
  return ENVIRONMENTAL_KINDS.has(classifyError(row.error_message || '').kind);
}

/** The tasks demotion learning may cap. Config override: model_routing.telemetry.demote_tasks. */
export function demoteTasks(cfg) {
  const t = cfg?.model_routing?.telemetry || {};
  return Array.isArray(t.demote_tasks) ? t.demote_tasks.filter((x) => typeof x === 'string') : [...TELEMETRY_TASKS];
}

// CAP at 'opus' — telemetry NEVER learns fable (brief-01: fable is
// failure-terminal only, reachable solely via force_tier keyword rules). A
// carried-forward hand-authored floor above opus is pulled back to opus too, so
// "a learned floor never exceeds opus" holds for the on-disk state telemetry owns.
function capAtOpus(tier) {
  return tierIndex(tier) > tierIndex('opus') ? 'opus' : tier;
}

// The turn cap for a tier, resolved via phases.max_turns_per_tier (opus:80,
// fable:60 in defaults) then the flat phases.max_turns_per_phase, then a 150
// backstop. Used by the decay condition's "num_turns <= 50% of the tier's cap"
// test — a clean run that also finished well under budget is strong evidence the
// floor is no longer earning its cost.
function tierTurnCap(tier, cfg) {
  const phases = cfg?.phases || {};
  const perTier = phases.max_turns_per_tier || {};
  const c = perTier[tier];
  if (Number.isFinite(c) && c > 0) return c;
  const flat = phases.max_turns_per_phase;
  return (Number.isFinite(flat) && flat > 0) ? flat : 150;
}

/**
 * Compute the learned per-task routing floors from recorded call outcomes.
 *
 * Pure: identical input → identical output. No IO, no clock, no randomness.
 *
 * @param {Object} args
 * @param {Object.<string, Array>} args.calls - map of task → the newest
 *   `window_calls` calls-table rows for that project × task, ordered started_at
 *   DESC (newest first). The CALLER runs the query (recentCallsForProjectTask)
 *   and passes them in; this module never touches the DB. Each row needs at
 *   least { model, is_error, num_turns }.
 * @param {Object.<string,string>} args.currentFloors - the task_floors already
 *   on disk (from routing-extension.json). Carried forward unless decayed.
 * @param {Object.<string,string>} [args.currentCaps] - the task_caps already on
 *   disk. Carried forward unless undone by a capability failure or superseded
 *   by a floor.
 * @param {Object.<string,string>} args.tierModels - model_routing.tier_models,
 *   for deriving each row's tier via modelToTier(row.model, tierModels).
 * @param {Object} args.cfg - resolved config (reads model_routing.telemetry for
 *   the thresholds and phases.* for the tier turn caps).
 * @returns {{task_floors: Object.<string,string>, task_caps: Object.<string,string>, reasons: string[]}}
 */
export function computeRoutingAdjustment({ calls, currentFloors, currentCaps = {}, tierModels, cfg }) {
  const tele = cfg?.model_routing?.telemetry || {};
  const windowCalls = Number.isFinite(tele.window_calls) ? tele.window_calls : 12;
  const minSamples = Number.isFinite(tele.min_samples) ? tele.min_samples : 6;
  const escalateFailRate = Number.isFinite(tele.escalate_fail_rate) ? tele.escalate_fail_rate : 0.33;
  const decayStreak = Number.isFinite(tele.decay_streak) ? tele.decay_streak : 5;
  const demoteStreak = Number.isFinite(tele.demote_streak) ? tele.demote_streak : 8;

  const task_floors = {};
  const reasons = [];

  for (const task of TELEMETRY_TASKS) {
    const rows = Array.isArray(calls?.[task]) ? calls[task].slice(0, windowCalls) : [];

    // Carry any existing (valid) floor forward, capped at opus.
    let floor = null;
    const existing = currentFloors?.[task];
    if (typeof existing === 'string' && TIER_ORDER.includes(existing)) {
      floor = capAtOpus(existing);
    }

    // Environmental rows (rate limits, max-turns, stalls) carry no capability
    // signal — they are invisible to every rule below: excluded from the raise
    // rate entirely, and SKIPPED (not streak-breaking) by the decay streak.
    const meaningful = rows.filter((row) => !isEnvironmentalFailure(row));

    if (floor) {
      // DECAY — remove the floor once the newest `decay_streak` meaningful rows
      // for the task ALL ran at >= the floor tier, with is_error == 0, AND
      // finished within 50% of that tier's turn cap. A NULL num_turns row (pre-
      // foundations history, or an errored call) never satisfies the streak, so
      // an old project with no per-call turn data can never spuriously decay.
      const streak = meaningful.slice(0, decayStreak);
      const decayed = streak.length >= decayStreak && streak.every((row) => {
        const tier = modelToTier(row.model, tierModels);
        if (tierIndex(tier) < tierIndex(floor)) return false;
        if (row.is_error) return false;
        const nt = row.num_turns;
        if (nt == null || !Number.isFinite(nt)) return false;
        return nt <= 0.5 * tierTurnCap(tier, cfg);
      });
      if (decayed) {
        reasons.push(`removed learned floor ${task} (telemetry: ${decayStreak} recent ${floor}+ calls clean & under 50% turn cap)`);
        floor = null;
      }
    } else {
      // RAISE — escalate to opus when sonnet is failing often enough ON
      // CAPABILITY. The signal is the capability-failure RATE over meaningful
      // sonnet-tier rows (verdict correction: NOT lessons.jsonl
      // kind='escalation', which is only written on the timeout path and
      // undercounts; every is_error dev result writes the escalate marker).
      // Needs at least min_samples meaningful sonnet calls to trust the rate.
      const sonnetRows = meaningful.filter((row) => modelToTier(row.model, tierModels) === 'sonnet');
      const sonnetSamples = sonnetRows.length;
      if (sonnetSamples >= minSamples) {
        const failCount = sonnetRows.filter((row) => !!row.is_error).length;
        const failRate = failCount / sonnetSamples;
        if (failRate >= escalateFailRate) {
          floor = 'opus'; // CAP at opus — never learn fable.
          reasons.push(`learned floor ${task}->opus (telemetry: ${failCount}/${sonnetSamples} recent sonnet calls failed)`);
        }
      }
    }

    if (floor) task_floors[task] = floor;
  }

  // ── DEMOTE (learned task_caps) ─────────────────────────────────────────────
  const task_caps = {};
  for (const task of demoteTasks(cfg)) {
    const rows = Array.isArray(calls?.[task]) ? calls[task].slice(0, windowCalls) : [];
    const meaningful = rows.filter((row) => !isEnvironmentalFailure(row));

    // A floor (learned above, or hand-authored on disk for a non-telemetry
    // task) contradicts a cap — the floor wins, the cap is dropped/never learned.
    const activeFloor = task_floors[task]
      ?? ((typeof currentFloors?.[task] === 'string' && TIER_ORDER.includes(currentFloors[task]) && !TELEMETRY_TASKS.includes(task))
        ? currentFloors[task] : null);

    let cap = null;
    const existingCap = currentCaps?.[task];
    if (typeof existingCap === 'string' && TIER_ORDER.includes(existingCap)) cap = existingCap;

    if (activeFloor) {
      if (cap) reasons.push(`removed learned cap ${task} (conflicts with floor ${activeFloor})`);
      continue;
    }

    if (cap) {
      // UNDO — fail-fast: ONE capability failure at (or below) the capped tier
      // in the meaningful window removes the cap on the next preflight. The
      // failed call itself already escalated via the normal retry ladder; this
      // just stops the NEXT phase from starting on the demoted tier.
      //
      // PHASE_STUCK is additionally cap-removing here (from ALL rows, not just
      // meaningful): the environmental exclusion is correct for the RAISE
      // direction (a bigger model can't buy turn headroom on a well-sized
      // phase), but max-turns exhaustion / stalls AT A DEMOTED TIER are
      // exactly what an underpowered model produces — the cap likely caused
      // them, so they must be able to undo it (acf sat on a stale haiku
      // dev-execution cap for a week paying the fail-then-escalate double
      // bill because its haiku max-turns failures all filtered out).
      const failedAtCap = meaningful.some((row) =>
        row.is_error && tierIndex(modelToTier(row.model, tierModels)) <= tierIndex(cap))
        || rows.some((row) => row.is_error
          && tierIndex(modelToTier(row.model, tierModels)) <= tierIndex(cap)
          && classifyError(row.error_message || '').kind === ERROR_KINDS.PHASE_STUCK);
      if (failedAtCap) {
        reasons.push(`removed learned cap ${task} (telemetry: capability failure at ${cap} tier)`);
        cap = null;
      }
    } else {
      // LEARN — the newest `demote_streak` meaningful rows all ran at the SAME
      // tier (above haiku), clean, and under 50% of that tier's turn cap →
      // strong evidence the tier below can handle this task's typical load.
      // routeModel additionally restricts application to LOW-complexity,
      // unpinned calls, so the cap never touches keyword/floor-raised phases.
      const streak = meaningful.slice(0, demoteStreak);
      if (streak.length >= demoteStreak) {
        const observedTier = modelToTier(streak[0].model, tierModels);
        const eligible = tierIndex(observedTier) > tierIndex('haiku') && streak.every((row) => {
          if (modelToTier(row.model, tierModels) !== observedTier) return false;
          if (row.is_error) return false;
          const nt = row.num_turns;
          if (nt == null || !Number.isFinite(nt)) return false;
          return nt <= 0.5 * tierTurnCap(observedTier, cfg);
        });
        if (eligible) {
          cap = TIER_ORDER[tierIndex(observedTier) - 1];
          reasons.push(`learned cap ${task}->${cap} (telemetry: ${demoteStreak} recent ${observedTier} calls clean & under 50% turn cap)`);
        }
      }
    }

    if (cap) task_caps[task] = cap;
  }

  return { task_floors, task_caps, reasons };
}
