// Tests for config-migrator.js — read-side schema-shape normalization.
//
// Run with: node --test src/config-migrator.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_SCHEMA_VERSION, migrateResolvedConfig } from './config-migrator.js';

test('CURRENT_SCHEMA_VERSION is 22 (execution-efficiency controls)', () => {
  assert.equal(CURRENT_SCHEMA_VERSION, 22);
});

test('v21 snapshot: execution controls and account-wide heavy-call lease are backfilled', () => {
  const migrated = migrateResolvedConfig({
    $schema_version: 21,
    billing: { mode: 'max_pooled', heavy_call_lease: { wait_timeout_ms: 123456 } },
    phases: { turn_prediction: { min_samples: 20 }, task_max_turns: { chat: 30 } },
    models: { 'dev-execution': 'claude-sonnet-5' },
    ledger: { enabled: true, extract_fallback: true },
    auto_run: { max_phases_per_run: 9999 },
    auto_heal: { enabled: true },
  });
  assert.equal(migrated.phases.max_continuation_attempts_hard_cap, 1);
  assert.equal(migrated.phases.max_continuation_context_tokens, 180000);
  assert.equal(migrated.phases.fresh_recovery_after_max_turns, true);
  assert.equal(migrated.phases.turn_prediction.min_samples, 20, 'explicit nested override survives');
  assert.equal(migrated.phases.turn_prediction.max_predicted_turns, 45);
  assert.equal(migrated.phases.task_max_turns.chat, 30);
  assert.equal(migrated.phases.task_max_turns['self-heal'], 8);
  assert.equal(migrated.phases.task_timeout_ms['self-heal'], 300000);
  assert.equal(migrated.models['self-heal'], 'claude-sonnet-5');
  assert.equal(migrated.ledger.llm_extract_fallback, false);
  assert.equal(migrated.auto_run.max_auto_reprompt_attempts, 1);
  assert.equal(migrated.auto_heal.self_heal_confirmation_timeout_ms, 120000);
  assert.equal(migrated.billing.enforce_cost_thresholds, false);
  assert.equal(migrated.billing.heavy_call_lease.enabled, true);
  assert.equal(migrated.billing.heavy_call_lease.max_concurrent, 1);
  assert.equal(migrated.billing.heavy_call_lease.waiter_ttl_ms, 60000);
  assert.equal(migrated.billing.heavy_call_lease.wait_timeout_ms, 123456, 'explicit lease override survives');
  assert.deepEqual(migrated.billing.heavy_call_lease.cheap_tasks, ['ledger-extract', 'autopsy', 'autopilot-digest']);
  assert.equal(migrated.billing.heavy_call_lease.cheap_call_weight, 0.25);
});

test('v21 snapshot: explicit heavy-call lease rollback/cap/task overrides survive migration', () => {
  const migrated = migrateResolvedConfig({
    $schema_version: 21,
    billing: {
      mode: 'max_pooled',
      enforce_cost_thresholds: true,
      heavy_call_lease: {
        enabled: false,
        max_concurrent: 3,
        cheap_tasks: ['custom-helper'],
        cheap_call_weight: 0.5,
        heavy_tasks: ['autopsy'],
      },
    },
  });
  assert.equal(migrated.billing.heavy_call_lease.enabled, false);
  assert.equal(migrated.billing.enforce_cost_thresholds, true, 'explicit cost enforcement survives');
  assert.equal(migrated.billing.heavy_call_lease.max_concurrent, 3);
  assert.deepEqual(migrated.billing.heavy_call_lease.cheap_tasks, ['custom-helper']);
  assert.equal(migrated.billing.heavy_call_lease.cheap_call_weight, 0.5);
  assert.deepEqual(migrated.billing.heavy_call_lease.heavy_tasks, ['autopsy']);
  assert.equal(migrated.billing.heavy_call_lease.lease_ttl_ms, 180000);
});

test('v20 snapshot: provider breaker and opt-in issue auto-fix are backfilled without clobbering overrides', () => {
  const migrated = migrateResolvedConfig({
    $schema_version: 20,
    billing: { mode: 'max_pooled', provider_circuit_breaker: { fallback_cooldown_minutes: 90 } },
    chat: { autopilot: { enabled: false } },
  });
  assert.equal(migrated.billing.provider_circuit_breaker.enabled, true);
  assert.equal(migrated.billing.provider_circuit_breaker.fallback_cooldown_minutes, 90);
  assert.equal(migrated.chat.issue_bridge.auto_fix, false);
});

test('v19 snapshot: rollout defaults are conservative and nested overrides survive', () => {
  const migrated = migrateResolvedConfig({
    $schema_version: 19,
    context_compiler: { enabled: true, mode: 'shadow', rollout: { auto_promote: true, promotion: { min_samples: 30 } } },
  });
  assert.equal(migrated.context_compiler.rollout.auto_promote, true);
  assert.equal(migrated.context_compiler.rollout.auto_rollback, true);
  assert.equal(migrated.context_compiler.rollout.promotion.min_samples, 30);
  assert.equal(migrated.context_compiler.rollout.promotion.min_recall, 0.8);
});

test('v18 snapshot: partial context_compiler is normalized without overriding explicit values', () => {
  const migrated = migrateResolvedConfig({
    $schema_version: 18,
    context_compiler: { enabled: false, mode: 'assist', token_budget: { medium: 777 } },
  });
  assert.equal(migrated.context_compiler.enabled, false);
  assert.equal(migrated.context_compiler.mode, 'assist');
  assert.equal(migrated.context_compiler.token_budget.medium, 777);
  assert.equal(migrated.context_compiler.token_budget.repair, 1200);
  assert.equal(migrated.context_compiler.provider, 'hybrid-lexical');
});

test('v18 snapshot: absent context_compiler remains absent (old frozen snapshots stay inert)', () => {
  const migrated = migrateResolvedConfig({ $schema_version: 18, phases: {} });
  assert.equal(migrated.context_compiler, undefined);
});

// ─── v17 → v18: interrupted-phase recovery + verify cadence ────────────────

test('migrateV17toV18: backfills recovery controls and preserves explicit values', () => {
  const migrated = migrateResolvedConfig({
    $schema_version: 17,
    phases: { resume_interrupted_session: false },
  });
  assert.equal(migrated.phases.resume_interrupted_session, false);
  assert.equal(migrated.phases.reconcile_committed_phase_before_spawn, true);
  assert.equal(migrated.phases.max_turns_continuation, 25);
  assert.equal(migrated.phases.max_continuation_attempts, 1);
});

test('migrateV17toV18: defaults cadence to checkpoints and fills only missing cadence keys', () => {
  const added = migrateResolvedConfig({ $schema_version: 17, verify: { mode: 'gate' } });
  assert.equal(added.verify.cadence.mode, 'checkpoints');
  assert.equal(added.verify.cadence.every_n_phases, 3);

  const kept = migrateResolvedConfig({
    $schema_version: 17,
    verify: { cadence: { mode: 'checkpoints', every_n_phases: 5 } },
  });
  assert.equal(kept.verify.cadence.mode, 'checkpoints');
  assert.equal(kept.verify.cadence.every_n_phases, 5);
  assert.deepEqual(kept.verify.cadence.always_complexities, ['high', 'critical']);
});

// ─── v15 → v16: llm_contract whole-block backfill (phase-77) ─────────────────

test('migrateV15toV16: backfills the whole llm_contract block when absent', () => {
  const migrated = migrateResolvedConfig({ $schema_version: 15, verify: { mode: 'gate' } });
  assert.deepEqual(migrated.llm_contract, { enabled: true, max_reasks: 1, escalate_on_second_fail: false });
  assert.equal(migrated.verify.mode, 'gate', 'unrelated blocks preserved');
});

test('migrateV15toV16: never clobbers an existing llm_contract block (its values win, untouched)', () => {
  const kept = migrateResolvedConfig({ $schema_version: 15, llm_contract: { enabled: false, max_reasks: 3 } });
  assert.deepEqual(kept.llm_contract, { enabled: false, max_reasks: 3 }, 'no partial-key backfill — an explicit block is taken verbatim');
});

test('migrateV15toV16: is idempotent (a second pass leaves the backfilled block unchanged)', () => {
  const once = migrateResolvedConfig({ $schema_version: 15 });
  const twice = migrateResolvedConfig(once);
  assert.deepEqual(twice.llm_contract, { enabled: true, max_reasks: 1, escalate_on_second_fail: false });
});

// ─── v14 → v15: auto_run/bug_cycle new-key + parallel_lanes backfill (phase-65) ─

test('migrateV14toV15: backfills auto_run.max_parallel_phases/speculative_duo_on_double_failure when auto_run is present but missing them', () => {
  const migrated = migrateResolvedConfig({ $schema_version: 14, auto_run: { max_phases_per_run: 9999 } });
  assert.equal(migrated.auto_run.max_parallel_phases, 1);
  assert.equal(migrated.auto_run.speculative_duo_on_double_failure, false);
  assert.equal(migrated.auto_run.max_phases_per_run, 9999, 'existing auto_run keys preserved');
});

test('migrateV14toV15: never clobbers explicit auto_run overrides, and a config with no auto_run block at all is left alone', () => {
  const kept = migrateResolvedConfig({ $schema_version: 14, auto_run: { max_parallel_phases: 4, speculative_duo_on_double_failure: true } });
  assert.equal(kept.auto_run.max_parallel_phases, 4);
  assert.equal(kept.auto_run.speculative_duo_on_double_failure, true);
  const noAutoRun = migrateResolvedConfig({ $schema_version: 14, verify: { mode: 'gate' } });
  assert.equal(noAutoRun.auto_run, undefined);
});

test('migrateV14toV15: backfills bug_cycle.max_parallel_fixes/batch_minor_fixes/batch_max when bug_cycle is present but missing them', () => {
  const migrated = migrateResolvedConfig({ $schema_version: 14, bug_cycle: { max_fixes_per_round: 30 } });
  assert.equal(migrated.bug_cycle.max_parallel_fixes, 1);
  assert.equal(migrated.bug_cycle.batch_minor_fixes, false);
  assert.equal(migrated.bug_cycle.batch_max, 4);
  assert.equal(migrated.bug_cycle.max_fixes_per_round, 30, 'existing bug_cycle keys preserved');
});

test('migrateV14toV15: never clobbers explicit bug_cycle overrides, and a config with no bug_cycle block at all is left alone', () => {
  const kept = migrateResolvedConfig({ $schema_version: 14, bug_cycle: { max_parallel_fixes: 3, batch_minor_fixes: true, batch_max: 8 } });
  assert.equal(kept.bug_cycle.max_parallel_fixes, 3);
  assert.equal(kept.bug_cycle.batch_minor_fixes, true);
  assert.equal(kept.bug_cycle.batch_max, 8);
  const noBugCycle = migrateResolvedConfig({ $schema_version: 14, verify: { mode: 'gate' } });
  assert.equal(noBugCycle.bug_cycle, undefined);
});

test('migrateV14toV15: backfills parallel_lanes keys when the block is present but incomplete; a config with none at all is left alone', () => {
  const migrated = migrateResolvedConfig({ $schema_version: 14, parallel_lanes: { dir: '.custom-worktrees' } });
  assert.equal(migrated.parallel_lanes.dir, '.custom-worktrees', 'existing key never clobbered');
  assert.equal(migrated.parallel_lanes.node_modules, 'symlink', 'missing key backfilled from V15_PARALLEL_LANES_DEFAULTS');
  const noLanes = migrateResolvedConfig({ $schema_version: 14, verify: { mode: 'gate' } });
  assert.equal(noLanes.parallel_lanes, undefined);
});

test('migrateV14toV15: is idempotent across all three surfaces', () => {
  const once = migrateResolvedConfig({
    $schema_version: 14,
    auto_run: { max_parallel_phases: 2 },
    bug_cycle: { batch_max: 9 },
    parallel_lanes: { node_modules: 'none' },
  });
  const twice = migrateResolvedConfig(once);
  assert.equal(twice.auto_run.max_parallel_phases, 2);
  assert.equal(twice.bug_cycle.batch_max, 9);
  assert.equal(twice.parallel_lanes.node_modules, 'none');
});

// ─── v13 → v14: cleanup.run_events_retention_days backfill (phase-57) ───────

test('migrateV13toV14: backfills cleanup.run_events_retention_days when a cleanup block is present but missing it', () => {
  const migrated = migrateResolvedConfig({ $schema_version: 13, cleanup: { enabled: true, logs_retention_days: 30 } });
  assert.equal(migrated.cleanup.run_events_retention_days, 90, 'backfilled to the documented default');
  assert.equal(migrated.cleanup.logs_retention_days, 30, 'existing cleanup keys preserved');
});

test('migrateV13toV14: never clobbers an explicit override, and a config with no cleanup block at all is left alone', () => {
  const kept = migrateResolvedConfig({ $schema_version: 13, cleanup: { run_events_retention_days: 0 } });
  assert.equal(kept.cleanup.run_events_retention_days, 0);
  const noCleanup = migrateResolvedConfig({ $schema_version: 13, verify: { mode: 'gate' } });
  assert.equal(noCleanup.cleanup, undefined);
});

test('migrateV12toV13: backfills chat.autopilot (off) when absent, preserves an existing chat block', () => {
  const migrated = migrateResolvedConfig({ $schema_version: 12, chat: { history_limit: 50 } });
  assert.equal(migrated.chat.autopilot.enabled, false, 'autopilot backfilled off');
  assert.equal(migrated.chat.history_limit, 50, 'existing chat keys preserved');
  // Existing autopilot values must win over the backfill default.
  const kept = migrateResolvedConfig({ $schema_version: 12, chat: { autopilot: { enabled: true, budget_usd: 20 } } });
  assert.equal(kept.chat.autopilot.enabled, true);
  assert.equal(kept.chat.autopilot.budget_usd, 20);
});

// ─── v11 → v12: verify.async_report backfill (phase-51) ─────────────────────

test('migrateResolvedConfig: backfills verify.async_report:true into a pre-v12 verify override missing it', () => {
  const cfg = migrateResolvedConfig({ verify: { mode: 'report', fail_open: false } });
  assert.equal(cfg.verify.async_report, true, 'the new key is backfilled to the advisory-only default (true)');
  // Sibling keys survive the backfill untouched.
  assert.equal(cfg.verify.mode, 'report');
  assert.equal(cfg.verify.fail_open, false);
});

test('migrateResolvedConfig: async_report backfill is idempotent + never clobbers an explicit false', () => {
  const once = migrateResolvedConfig({ verify: { async_report: false } });
  const twice = migrateResolvedConfig(once);
  assert.equal(once.verify.async_report, false);
  assert.equal(twice.verify.async_report, false);
});

test('migrateResolvedConfig: a config with no verify block at all is left alone (shouldDeferAcceptanceCheck fails open to never-defer)', () => {
  const cfg = migrateResolvedConfig({ auto_run: { max_phases_per_run: 9999 } });
  assert.equal(cfg.verify, undefined);
});

test('migrateResolvedConfig: a non-object verify value is left alone (never throws)', () => {
  const cfg = migrateResolvedConfig({ verify: null });
  assert.equal(cfg.verify, null);
});

// ─── v10 → v11: ship_gate backfill ──────────────────────────────────────────

test('migrateResolvedConfig: backfills ship_gate keys into a pre-v11 ship_gate override missing them', () => {
  const cfg = migrateResolvedConfig({ ship_gate: { audit_level: 'critical' } });
  assert.equal(cfg.ship_gate.enabled, true);
  assert.equal(Array.isArray(cfg.ship_gate.license_allowlist), true);
  // An explicit sibling value survives the backfill untouched.
  assert.equal(cfg.ship_gate.audit_level, 'critical');
});

test('migrateResolvedConfig: ship_gate backfill is idempotent — an explicit enabled:false is never clobbered', () => {
  const once = migrateResolvedConfig({ ship_gate: { enabled: false } });
  const twice = migrateResolvedConfig(once);
  assert.equal(once.ship_gate.enabled, false);
  assert.equal(twice.ship_gate.enabled, false);
});

test('migrateResolvedConfig: a config with no ship_gate block at all is left alone', () => {
  const cfg = migrateResolvedConfig({ auto_run: { max_phases_per_run: 9999 } });
  assert.equal(cfg.ship_gate, undefined);
});

// ─── v10 → v11 (phase-45, same version): security.deny_rules backfill ────────

test('migrateResolvedConfig: backfills security.deny_rules into a pre-phase-45 security override missing them', () => {
  const cfg = migrateResolvedConfig({ security: { env_mode: 'inherit' } });
  assert.ok(Array.isArray(cfg.security.deny_rules));
  assert.ok(cfg.security.deny_rules.includes('Read(../../../config/**)'));
  // Sibling key survives untouched.
  assert.equal(cfg.security.env_mode, 'inherit');
});

test('migrateResolvedConfig: security backfill is idempotent + never clobbers an explicit deny_rules list', () => {
  const explicit = { security: { deny_rules: ['Read(~/.ssh/**)'] } };
  const once = migrateResolvedConfig(explicit);
  const twice = migrateResolvedConfig(once);
  assert.deepEqual(once.security.deny_rules, ['Read(~/.ssh/**)']);
  assert.deepEqual(twice.security.deny_rules, ['Read(~/.ssh/**)']);
});

test('migrateResolvedConfig: a config with no security block at all is left alone', () => {
  const cfg = migrateResolvedConfig({ auto_run: { max_phases_per_run: 9999 } });
  assert.equal(cfg.security, undefined);
});

// ─── v7 → v8: audit.skip_adjudication_when_clean backfill ───────────────────

test('migrateResolvedConfig: backfills audit.skip_adjudication_when_clean:true into a pre-v8 audit override missing the key', () => {
  const cfg = migrateResolvedConfig({ audit: { two_stage: false, force_full_every_n: 5 } });
  assert.equal(cfg.audit.skip_adjudication_when_clean, true);
  // Sibling keys survive the backfill untouched.
  assert.equal(cfg.audit.two_stage, false);
  assert.equal(cfg.audit.force_full_every_n, 5);
});

test('migrateResolvedConfig: idempotent — an explicit false is never clobbered by a second pass', () => {
  const once = migrateResolvedConfig({ audit: { skip_adjudication_when_clean: false } });
  const twice = migrateResolvedConfig(once);
  assert.equal(once.audit.skip_adjudication_when_clean, false);
  assert.equal(twice.audit.skip_adjudication_when_clean, false);
});

test('migrateResolvedConfig: a config with no audit block at all is left alone', () => {
  const cfg = migrateResolvedConfig({ auto_run: { max_escalation_hops: 2 } });
  assert.equal(cfg.audit, undefined);
});

test('migrateResolvedConfig: a non-object audit value is left alone (never throws)', () => {
  const cfg = migrateResolvedConfig({ audit: null });
  assert.equal(cfg.audit, null);
});

test('migrateResolvedConfig: null/undefined input passes through unchanged', () => {
  assert.equal(migrateResolvedConfig(null), null);
  assert.equal(migrateResolvedConfig(undefined), undefined);
});

// ─── v8 → v9: ledger block backfill ──────────────────────────────────────────

test('migrateResolvedConfig: backfills missing ledger keys into a pre-v9 ledger override missing them', () => {
  const cfg = migrateResolvedConfig({ ledger: { enabled: false } });
  assert.equal(cfg.ledger.enabled, false, 'existing key is never clobbered');
  assert.equal(cfg.ledger.inject_last_k, 8, 'missing key backfilled from V9_LEDGER_DEFAULTS');
  assert.equal(cfg.ledger.extract_fallback, true, 'missing key backfilled from V9_LEDGER_DEFAULTS');
});

test('migrateResolvedConfig: a fully-shaped ledger block is left byte-identical (no-op)', () => {
  const ledger = { enabled: true, inject_last_k: 3, extract_fallback: false, llm_extract_fallback: true };
  const cfg = migrateResolvedConfig({ ledger: { ...ledger } });
  assert.deepEqual(cfg.ledger, ledger);
});

test('migrateResolvedConfig: a config with no ledger block at all is left alone', () => {
  const cfg = migrateResolvedConfig({ auto_run: { max_escalation_hops: 2 } });
  assert.equal(cfg.ledger, undefined);
});

test('migrateResolvedConfig: a non-object ledger value is left alone (never throws)', () => {
  const cfg = migrateResolvedConfig({ ledger: null });
  assert.equal(cfg.ledger, null);
});

// ─── v9 → v10: auto_run.convergence block backfill (phase-43) ────────────────

test('migrateResolvedConfig: backfills missing convergence keys into a pre-v10 auto_run override missing them', () => {
  const cfg = migrateResolvedConfig({ auto_run: { convergence: { enabled: false } } });
  assert.equal(cfg.auto_run.convergence.enabled, false, 'existing key is never clobbered');
  assert.equal(cfg.auto_run.convergence.stall_min_recurring, 2, 'missing key backfilled from V10_CONVERGENCE_DEFAULTS');
});

test('migrateResolvedConfig: synthesizes the whole convergence block when auto_run exists but has none', () => {
  const cfg = migrateResolvedConfig({ auto_run: { max_phases_per_run: 9999 } });
  assert.equal(cfg.auto_run.convergence.enabled, true);
  assert.equal(cfg.auto_run.convergence.stall_min_recurring, 2);
});

test('migrateResolvedConfig: a config with no auto_run block at all gets no convergence block (audit-promote fails open)', () => {
  const cfg = migrateResolvedConfig({ ledger: { enabled: true } });
  assert.equal(cfg.auto_run, undefined);
});

test('migrateResolvedConfig: convergence backfill is idempotent — an explicit override is never clobbered by a second pass', () => {
  const once = migrateResolvedConfig({ auto_run: { convergence: { enabled: false, stall_min_recurring: 5 } } });
  const twice = migrateResolvedConfig(once);
  assert.equal(twice.auto_run.convergence.enabled, false);
  assert.equal(twice.auto_run.convergence.stall_min_recurring, 5);
});

// ─── Prior migrations (v5→v6, v6→v7, v7→v8) still run in sequence, unaffected ─

test('migrateResolvedConfig: a config predating v6, v8, v9, AND v10 gets every applicable backfill in one pass', () => {
  const cfg = migrateResolvedConfig({
    model_routing: {
      tier_order: ['haiku', 'sonnet', 'opus'],
      tier_models: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-4-8' },
    },
    auto_run: { max_phases_per_run: 9999 },
    audit: { two_stage: true },
    ledger: { enabled: true },
  });
  assert.ok(cfg.model_routing.tier_order.includes('fable'), 'v5→v6 fable backfill still runs');
  assert.equal(cfg.auto_run.max_escalation_hops, 2, 'v6→v7 escalation-hop backfill still runs');
  assert.equal(cfg.audit.skip_adjudication_when_clean, true, 'v7→v8 audit backfill runs alongside the earlier migrations');
  assert.equal(cfg.ledger.inject_last_k, 8, 'v8→v9 ledger backfill runs alongside the earlier migrations');
  assert.equal(cfg.auto_run.convergence.stall_min_recurring, 2, 'v9→v10 convergence backfill runs alongside the earlier migrations');
});

// ─── Migrating a real resolved config resolves clean ────────────────────────

test('migrateResolvedConfig: a full resolved config resolves cleanly at the current schema with the v9+v10 keys backfilled', async () => {
  const { resolve } = await import('./config-resolver.js');
  const cfg = await resolve({ task: 'dev-execution' });
  // resolve() already runs migrateResolvedConfig() internally — this exercises
  // the real cascade, not a hand-built fixture.
  assert.equal(cfg.$schema_version, 22);
  assert.equal(cfg.llm_contract.enabled, true);
  assert.equal(cfg.llm_contract.max_reasks, 1);
  assert.equal(cfg.chat.autopilot.enabled, false);
  assert.equal(cfg.audit.skip_adjudication_when_clean, true);
  assert.equal(cfg.ledger.inject_last_k, 8);
  assert.equal(cfg.auto_run.convergence.enabled, true);
  assert.equal(cfg.ship_gate.enabled, true);
  assert.equal(cfg.verify.async_report, true);
  assert.equal(cfg.cleanup.run_events_retention_days, 90);
  assert.equal(cfg.auto_run.max_parallel_phases, 1);
  assert.equal(cfg.auto_run.speculative_duo_on_double_failure, false);
  assert.equal(cfg.bug_cycle.max_parallel_fixes, 1);
  assert.equal(cfg.bug_cycle.batch_minor_fixes, false);
  assert.equal(cfg.bug_cycle.batch_max, 4);
  assert.equal(cfg.parallel_lanes.dir, '.worktrees');
  assert.equal(cfg.parallel_lanes.node_modules, 'symlink');
  assert.equal(cfg.phases.resume_interrupted_session, true);
  assert.equal(cfg.phases.reconcile_committed_phase_before_spawn, true);
  assert.equal(cfg.verify.cadence.mode, 'checkpoints');

  // Simulate a v8 snapshot (pre-bump defaults shape) being migrated directly —
  // both the v8→v9 ledger backfill and the v9→v10 convergence backfill run.
  const v8Snapshot = { ...cfg, $schema_version: 8, ledger: { enabled: true }, auto_run: { max_phases_per_run: 9999 } };
  const migrated = migrateResolvedConfig(v8Snapshot);
  assert.equal(migrated.ledger.inject_last_k, 8, 'a v8 snapshot missing the key gets it backfilled');
  assert.equal(migrated.ledger.extract_fallback, true, 'a v8 snapshot missing the key gets it backfilled');
  assert.equal(migrated.auto_run.convergence.stall_min_recurring, 2, 'a v8 snapshot also gets the v10 convergence block');
});
