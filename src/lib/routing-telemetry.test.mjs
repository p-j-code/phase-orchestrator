// Unit tests for the PURE telemetry-learned routing floor module.
//   computeRoutingAdjustment — raise / decay / cap / determinism.
//
// Run: node src/lib/routing-telemetry.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRoutingAdjustment, TELEMETRY_TASKS, isEnvironmentalFailure, demoteTasks } from './routing-telemetry.js';

const TIER_MODELS = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-4-8',
  fable: 'claude-fable-5',
};

// Default-ish cfg mirroring config/defaults.json's telemetry + tier turn caps.
function baseCfg(overrides = {}) {
  return {
    model_routing: {
      tier_models: TIER_MODELS,
      telemetry: {
        enabled: true,
        window_calls: 12,
        min_samples: 6,
        escalate_fail_rate: 0.33,
        decay_streak: 5,
        ...(overrides.telemetry || {}),
      },
    },
    phases: { max_turns_per_tier: { opus: 80, fable: 60 }, max_turns_per_phase: 150 },
  };
}

const sonnet = (is_error, num_turns = 30) => ({ model: 'claude-sonnet-5', is_error, num_turns });
const opus = (is_error, num_turns = 20) => ({ model: 'claude-opus-4-8', is_error, num_turns });
const haiku = (is_error, num_turns = 5, error_message) => ({ model: 'claude-haiku-4-5', is_error, num_turns, error_message });

// 2026-07-12 (window economy) — classified-failure rows. Environmental
// messages mirror the exact strings the calls table records in production.
const RATE_LIMIT_MSG = 'claude exited 1: {"type":"rate_limit_event","rate_limit_info":{"status":"exceeded"}}';
const MAX_TURNS_MSG = 'Ended with subtype: error_max_turns';
const CAPABILITY_MSG = 'Phase 12 failed acceptance verification after 2 gate attempts';
const sonnetEnv = (error_message) => ({ model: 'claude-sonnet-5', is_error: 1, num_turns: null, error_message });
const opusEnv = (error_message) => ({ model: 'claude-opus-4-8', is_error: 1, num_turns: null, error_message });
const sonnetCap = () => ({ model: 'claude-sonnet-5', is_error: 1, num_turns: 40, error_message: CAPABILITY_MSG });

// ─── RAISE ────────────────────────────────────────────────────────────────────

test('below min_samples → no floor learned', () => {
  // 5 sonnet calls, ALL failing — but 5 < min_samples (6), so the rate is not
  // yet trusted and nothing is learned.
  const calls = { 'dev-execution': [sonnet(1), sonnet(1), sonnet(1), sonnet(1), sonnet(1)] };
  const { task_floors, reasons } = computeRoutingAdjustment({ calls, currentFloors: {}, tierModels: TIER_MODELS, cfg: baseCfg() });
  assert.deepEqual(task_floors, {}, 'no floor below min_samples');
  assert.equal(reasons.length, 0, 'no reason emitted below min_samples');
});

test('4/9 sonnet failures → dev-execution opus floor with the exact reason shape', () => {
  // 9 sonnet calls, 4 errored → 4/9 ≈ 0.44 ≥ escalate_fail_rate (0.33).
  const calls = {
    'dev-execution': [
      sonnet(1), sonnet(0), sonnet(1), sonnet(0), sonnet(1),
      sonnet(0), sonnet(1), sonnet(0), sonnet(0),
    ],
  };
  const { task_floors, reasons } = computeRoutingAdjustment({ calls, currentFloors: {}, tierModels: TIER_MODELS, cfg: baseCfg() });
  assert.deepEqual(task_floors, { 'dev-execution': 'opus' }, 'dev-execution raised to opus');
  assert.ok(
    reasons.includes('learned floor dev-execution->opus (telemetry: 4/9 recent sonnet calls failed)'),
    `exact reason shape; got ${JSON.stringify(reasons)}`,
  );
});

test('at the exact escalate_fail_rate threshold the floor is learned (>= is inclusive)', () => {
  // 6 sonnet, 2 errored → 2/6 ≈ 0.333… ≥ 0.33.
  const calls = { 'dev-execution': [sonnet(1), sonnet(1), sonnet(0), sonnet(0), sonnet(0), sonnet(0)] };
  const { task_floors } = computeRoutingAdjustment({ calls, currentFloors: {}, tierModels: TIER_MODELS, cfg: baseCfg() });
  assert.equal(task_floors['dev-execution'], 'opus', 'threshold is inclusive');
});

test('low sonnet fail rate → no floor', () => {
  // 8 sonnet, 1 errored → 0.125 < 0.33.
  const calls = { 'dev-execution': [sonnet(1), sonnet(0), sonnet(0), sonnet(0), sonnet(0), sonnet(0), sonnet(0), sonnet(0)] };
  const { task_floors, reasons } = computeRoutingAdjustment({ calls, currentFloors: {}, tierModels: TIER_MODELS, cfg: baseCfg() });
  assert.deepEqual(task_floors, {}, 'healthy sonnet rate learns no floor');
  assert.equal(reasons.length, 0);
});

test('opus rows are NOT counted as sonnet samples for the raise signal', () => {
  // 5 sonnet (2 fail) + 4 opus rows: only 5 sonnet samples < min_samples → no floor.
  const calls = { 'dev-execution': [sonnet(1), sonnet(1), sonnet(0), sonnet(0), sonnet(0), opus(0), opus(0), opus(0), opus(0)] };
  const { task_floors } = computeRoutingAdjustment({ calls, currentFloors: {}, tierModels: TIER_MODELS, cfg: baseCfg() });
  assert.deepEqual(task_floors, {}, 'opus rows do not fill the sonnet sample count');
});

test('fix-execution learns its own floor independently', () => {
  const calls = { 'fix-execution': [sonnet(1), sonnet(1), sonnet(1), sonnet(0), sonnet(0), sonnet(0)] };
  const { task_floors, reasons } = computeRoutingAdjustment({ calls, currentFloors: {}, tierModels: TIER_MODELS, cfg: baseCfg() });
  assert.equal(task_floors['fix-execution'], 'opus');
  assert.ok(reasons.includes('learned floor fix-execution->opus (telemetry: 3/6 recent sonnet calls failed)'));
});

// ─── DECAY ──────────────────────────────────────────────────────────────────

test('a 5-clean-low-turn opus streak decays the floor', () => {
  // 5 newest opus rows, all clean, all ≤ 40 turns (50% of the opus cap 80).
  const calls = { 'dev-execution': [opus(0, 10), opus(0, 20), opus(0, 30), opus(0, 40), opus(0, 15)] };
  const { task_floors, reasons } = computeRoutingAdjustment({
    calls, currentFloors: { 'dev-execution': 'opus' }, tierModels: TIER_MODELS, cfg: baseCfg(),
  });
  assert.deepEqual(task_floors, {}, 'clean low-turn streak removes the floor');
  assert.ok(reasons.some((r) => /removed learned floor dev-execution/.test(r)), `decay reason; got ${JSON.stringify(reasons)}`);
});

test('a NULL num_turns row in the streak BLOCKS decay (floor persists)', () => {
  const calls = { 'dev-execution': [opus(0, 10), opus(0, 20), { model: 'claude-opus-4-8', is_error: 0, num_turns: null }, opus(0, 40), opus(0, 15)] };
  const { task_floors } = computeRoutingAdjustment({
    calls, currentFloors: { 'dev-execution': 'opus' }, tierModels: TIER_MODELS, cfg: baseCfg(),
  });
  assert.equal(task_floors['dev-execution'], 'opus', 'NULL num_turns keeps the floor');
});

test('a high-turn opus row (over 50% of the cap) BLOCKS decay', () => {
  // 41 > 40 (50% of opus cap 80).
  const calls = { 'dev-execution': [opus(0, 10), opus(0, 20), opus(0, 41), opus(0, 40), opus(0, 15)] };
  const { task_floors } = computeRoutingAdjustment({
    calls, currentFloors: { 'dev-execution': 'opus' }, tierModels: TIER_MODELS, cfg: baseCfg(),
  });
  assert.equal(task_floors['dev-execution'], 'opus', 'over-budget clean run does not decay');
});

test('an errored row in the streak BLOCKS decay', () => {
  const calls = { 'dev-execution': [opus(0, 10), opus(1, 20), opus(0, 30), opus(0, 40), opus(0, 15)] };
  const { task_floors } = computeRoutingAdjustment({
    calls, currentFloors: { 'dev-execution': 'opus' }, tierModels: TIER_MODELS, cfg: baseCfg(),
  });
  assert.equal(task_floors['dev-execution'], 'opus', 'a failure in the streak keeps the floor');
});

test('a sonnet (below-floor) row in the streak BLOCKS decay', () => {
  // One sonnet run mixed in — below the opus floor tier → streak not satisfied.
  const calls = { 'dev-execution': [opus(0, 10), sonnet(0, 20), opus(0, 30), opus(0, 40), opus(0, 15)] };
  const { task_floors } = computeRoutingAdjustment({
    calls, currentFloors: { 'dev-execution': 'opus' }, tierModels: TIER_MODELS, cfg: baseCfg(),
  });
  assert.equal(task_floors['dev-execution'], 'opus', 'a below-floor run keeps the floor');
});

test('fewer than decay_streak rows cannot decay the floor', () => {
  const calls = { 'dev-execution': [opus(0, 10), opus(0, 20), opus(0, 30)] }; // only 3 < 5
  const { task_floors } = computeRoutingAdjustment({
    calls, currentFloors: { 'dev-execution': 'opus' }, tierModels: TIER_MODELS, cfg: baseCfg(),
  });
  assert.equal(task_floors['dev-execution'], 'opus', 'not enough rows to confirm a decay streak');
});

// ─── CAP + carry-forward ──────────────────────────────────────────────────────

test('a floor never exceeds opus — a carried-forward fable floor is capped to opus', () => {
  const calls = { 'dev-execution': [] };
  const { task_floors } = computeRoutingAdjustment({
    calls, currentFloors: { 'dev-execution': 'fable' }, tierModels: TIER_MODELS, cfg: baseCfg(),
  });
  assert.equal(task_floors['dev-execution'], 'opus', 'fable is capped to opus (never learn fable)');
});

test('the raise target is always opus — never fable, even with a very high fail rate', () => {
  const calls = { 'dev-execution': Array.from({ length: 10 }, () => sonnet(1)) };
  const { task_floors } = computeRoutingAdjustment({ calls, currentFloors: {}, tierModels: TIER_MODELS, cfg: baseCfg() });
  assert.equal(task_floors['dev-execution'], 'opus', '100% fail still learns opus, not fable');
});

test('an existing opus floor with no window activity is carried forward unchanged', () => {
  const calls = {};
  const { task_floors, reasons } = computeRoutingAdjustment({
    calls, currentFloors: { 'dev-execution': 'opus' }, tierModels: TIER_MODELS, cfg: baseCfg(),
  });
  assert.equal(task_floors['dev-execution'], 'opus', 'floor persists until it decays');
  assert.equal(reasons.length, 0, 'a carried-forward floor emits no reason');
});

// ─── Determinism ────────────────────────────────────────────────────────────

test('identical input → identical output (determinism)', () => {
  const calls = {
    'dev-execution': [sonnet(1), sonnet(0), sonnet(1), sonnet(0), sonnet(1), sonnet(0), sonnet(1)],
    'fix-execution': [opus(0, 10), opus(0, 20), opus(0, 30), opus(0, 40), opus(0, 15)],
  };
  const args = { calls, currentFloors: { 'fix-execution': 'opus' }, tierModels: TIER_MODELS, cfg: baseCfg() };
  const a = computeRoutingAdjustment(args);
  const b = computeRoutingAdjustment(args);
  assert.deepEqual(a, b, 'same input yields byte-identical structured output');
});

test('TELEMETRY_TASKS is exactly the dev/fix execution pair', () => {
  assert.deepEqual(TELEMETRY_TASKS, ['dev-execution', 'fix-execution']);
});

// ─── Classified failures (2026-07-12 window economy) ─────────────────────────
// Environmental errors (rate limits, max-turns, stalls) carry no capability
// signal: excluded from the raise rate, skipped by decay/demote streaks.

test('isEnvironmentalFailure: rate-limit and max-turns rows are environmental; capability failures and successes are not', () => {
  assert.equal(isEnvironmentalFailure(sonnetEnv(RATE_LIMIT_MSG)), true, 'rate_limit_event → environmental');
  assert.equal(isEnvironmentalFailure(sonnetEnv(MAX_TURNS_MSG)), true, 'error_max_turns → environmental');
  assert.equal(isEnvironmentalFailure(sonnetCap()), false, 'acceptance-gate failure → capability');
  assert.equal(isEnvironmentalFailure(sonnet(1)), false, 'is_error with NO message → UNKNOWN → still capability (legacy rows keep their meaning)');
  assert.equal(isEnvironmentalFailure(sonnet(0)), false, 'a clean row is never a failure');
});

test('environmental failures do NOT feed the raise rate — the aorch 2/6 noise regression', () => {
  // The exact shape that mis-learned aorch's opus floor on 2026-07-11: 6 sonnet
  // rows, 2 errored — but both errors were max-turns/rate-limit noise. The
  // meaningful sample is now 4 clean rows (< min_samples 6) → nothing learned.
  const calls = {
    'dev-execution': [sonnetEnv(MAX_TURNS_MSG), sonnetEnv(RATE_LIMIT_MSG), sonnet(0), sonnet(0), sonnet(0), sonnet(0)],
  };
  const { task_floors, reasons } = computeRoutingAdjustment({ calls, currentFloors: {}, tierModels: TIER_MODELS, cfg: baseCfg() });
  assert.deepEqual(task_floors, {}, 'environmental noise can no longer learn a floor');
  assert.equal(reasons.length, 0);
});

test('genuine capability failures at the same rate still raise the floor', () => {
  // 9 meaningful sonnet rows, 4 real capability failures → 4/9 ≥ 0.33 → opus.
  const calls = {
    'dev-execution': [
      sonnetCap(), sonnet(0), sonnetCap(), sonnet(0), sonnetCap(),
      sonnet(0), sonnetCap(), sonnet(0), sonnet(0),
    ],
  };
  const { task_floors } = computeRoutingAdjustment({ calls, currentFloors: {}, tierModels: TIER_MODELS, cfg: baseCfg() });
  assert.deepEqual(task_floors, { 'dev-execution': 'opus' });
});

test('decay SKIPS environmental rows instead of breaking the streak', () => {
  // Newest row is a rate-limited opus call; the 5 meaningful rows behind it are
  // clean, fast, at-floor → the floor decays despite the environmental error.
  const calls = {
    'dev-execution': [opusEnv(RATE_LIMIT_MSG), opus(0, 10), opus(0, 20), opus(0, 30), opus(0, 15), opus(0, 12)],
  };
  const { task_floors, reasons } = computeRoutingAdjustment({
    calls, currentFloors: { 'dev-execution': 'opus' }, tierModels: TIER_MODELS, cfg: baseCfg(),
  });
  assert.equal(task_floors['dev-execution'], undefined, 'floor decayed');
  assert.ok(reasons.some((r) => /removed learned floor dev-execution/.test(r)));
});

// ─── DEMOTE (learned task_caps, 2026-07-12) ──────────────────────────────────

test('demoteTasks defaults to TELEMETRY_TASKS and honors telemetry.demote_tasks', () => {
  assert.deepEqual(demoteTasks(baseCfg()), TELEMETRY_TASKS);
  assert.deepEqual(demoteTasks(baseCfg({ telemetry: { demote_tasks: ['plan-validate'] } })), ['plan-validate']);
});

test('a clean fast demote_streak learns a cap one tier below the observed tier', () => {
  // 8 clean sonnet calls, all under 50% of the flat 150-turn cap → haiku cap.
  const calls = { 'dev-execution': Array.from({ length: 8 }, () => sonnet(0, 30)) };
  const { task_floors, task_caps, reasons } = computeRoutingAdjustment({ calls, currentFloors: {}, tierModels: TIER_MODELS, cfg: baseCfg() });
  assert.deepEqual(task_floors, {});
  assert.deepEqual(task_caps, { 'dev-execution': 'haiku' });
  assert.ok(reasons.includes('learned cap dev-execution->haiku (telemetry: 8 recent sonnet calls clean & under 50% turn cap)'));
});

test('fewer than demote_streak meaningful rows learn nothing', () => {
  const calls = { 'dev-execution': Array.from({ length: 7 }, () => sonnet(0, 30)) };
  const { task_caps } = computeRoutingAdjustment({ calls, currentFloors: {}, tierModels: TIER_MODELS, cfg: baseCfg() });
  assert.deepEqual(task_caps, {});
});

test('a slow streak (over 50% of the tier turn cap) learns nothing', () => {
  const calls = { 'dev-execution': Array.from({ length: 8 }, () => sonnet(0, 80)) }; // 80 > 0.5*150
  const { task_caps } = computeRoutingAdjustment({ calls, currentFloors: {}, tierModels: TIER_MODELS, cfg: baseCfg() });
  assert.deepEqual(task_caps, {});
});

test('a capability failure inside the streak blocks learning', () => {
  const calls = { 'dev-execution': [sonnetCap(), ...Array.from({ length: 7 }, () => sonnet(0, 30))] };
  const { task_caps } = computeRoutingAdjustment({ calls, currentFloors: {}, tierModels: TIER_MODELS, cfg: baseCfg() });
  assert.deepEqual(task_caps, {});
});

test('mixed tiers in the streak block learning', () => {
  const calls = { 'dev-execution': [sonnet(0), sonnet(0), sonnet(0), sonnet(0), opus(0), opus(0), opus(0), opus(0)] };
  const { task_caps } = computeRoutingAdjustment({ calls, currentFloors: {}, tierModels: TIER_MODELS, cfg: baseCfg() });
  assert.deepEqual(task_caps, {});
});

test('environmental rows are skipped, not streak-breaking, for demote learning', () => {
  const calls = { 'dev-execution': [sonnetEnv(RATE_LIMIT_MSG), ...Array.from({ length: 8 }, () => sonnet(0, 30))] };
  const { task_caps } = computeRoutingAdjustment({ calls, currentFloors: {}, tierModels: TIER_MODELS, cfg: baseCfg() });
  assert.deepEqual(task_caps, { 'dev-execution': 'haiku' });
});

test('an existing cap is carried forward while the capped tier stays clean', () => {
  const calls = { 'dev-execution': [haiku(0), haiku(0), haiku(0)] };
  const { task_caps, reasons } = computeRoutingAdjustment({
    calls, currentFloors: {}, currentCaps: { 'dev-execution': 'haiku' }, tierModels: TIER_MODELS, cfg: baseCfg(),
  });
  assert.deepEqual(task_caps, { 'dev-execution': 'haiku' });
  assert.equal(reasons.length, 0, 'a carried-forward cap emits no reason');
});

test('ONE capability failure at the capped tier removes the cap (fail-fast undo)', () => {
  const calls = { 'dev-execution': [haiku(1, 8, CAPABILITY_MSG), haiku(0), haiku(0)] };
  const { task_caps, reasons } = computeRoutingAdjustment({
    calls, currentFloors: {}, currentCaps: { 'dev-execution': 'haiku' }, tierModels: TIER_MODELS, cfg: baseCfg(),
  });
  assert.deepEqual(task_caps, {});
  assert.ok(reasons.some((r) => /removed learned cap dev-execution.*capability failure/.test(r)));
});

test('an environmental failure at the capped tier does NOT remove the cap', () => {
  const calls = { 'dev-execution': [haiku(1, null, RATE_LIMIT_MSG), haiku(0), haiku(0)] };
  const { task_caps } = computeRoutingAdjustment({
    calls, currentFloors: {}, currentCaps: { 'dev-execution': 'haiku' }, tierModels: TIER_MODELS, cfg: baseCfg(),
  });
  assert.deepEqual(task_caps, { 'dev-execution': 'haiku' });
});

test('a learned floor supersedes an existing cap', () => {
  const calls = { 'dev-execution': [] };
  const { task_floors, task_caps, reasons } = computeRoutingAdjustment({
    calls, currentFloors: { 'dev-execution': 'opus' }, currentCaps: { 'dev-execution': 'haiku' }, tierModels: TIER_MODELS, cfg: baseCfg(),
  });
  assert.equal(task_floors['dev-execution'], 'opus', 'the carried floor survives');
  assert.deepEqual(task_caps, {}, 'the conflicting cap is dropped');
  assert.ok(reasons.some((r) => /removed learned cap dev-execution.*conflicts with floor opus/.test(r)));
});

test('demote_tasks config scopes which tasks may learn caps', () => {
  const cfg = baseCfg({ telemetry: { demote_tasks: ['plan-validate'] } });
  const calls = {
    'plan-validate': Array.from({ length: 8 }, () => sonnet(0, 9)),
    'dev-execution': Array.from({ length: 8 }, () => sonnet(0, 30)),
  };
  const { task_caps } = computeRoutingAdjustment({ calls, currentFloors: {}, tierModels: TIER_MODELS, cfg });
  assert.deepEqual(task_caps, { 'plan-validate': 'haiku' }, 'only the configured task is capped');
});

test('a hand-authored floor for a non-telemetry demote task blocks its cap', () => {
  const cfg = baseCfg({ telemetry: { demote_tasks: ['plan-validate'] } });
  const calls = { 'plan-validate': Array.from({ length: 8 }, () => sonnet(0, 9)) };
  const { task_caps } = computeRoutingAdjustment({
    calls, currentFloors: { 'plan-validate': 'sonnet' }, tierModels: TIER_MODELS, cfg,
  });
  assert.deepEqual(task_caps, {}, 'the hand-authored floor wins over cap learning');
});

test('a haiku-tier streak never learns a cap (no tier below haiku)', () => {
  const calls = { 'dev-execution': Array.from({ length: 8 }, () => haiku(0, 5)) };
  const { task_caps } = computeRoutingAdjustment({ calls, currentFloors: {}, tierModels: TIER_MODELS, cfg: baseCfg() });
  assert.deepEqual(task_caps, {});
});
