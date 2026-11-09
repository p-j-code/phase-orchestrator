// Config Migrator — read-side schema-shape normalization for resolved configs.
//
// config/defaults.json is read live on every resolve(), so new defaults keys
// reach every project automatically. What does NOT self-heal is a user/project
// override layer that replaced a whole subtree in an older shape — e.g. a
// project.json that clobbered `model_routing.tier_models` wholesale before the
// v0.17 'fable' rung existed. Because the cascade's deepMerge replaces the
// override's keys over defaults', such a config would resolve WITHOUT
// tier_models.fable, and a force_tier:'fable' routing decision would fall back
// to the literal string 'fable' as a model id (the same bogus-model-id class
// of bug the haiku tier hit in v0.14.35).
//
// Migrations here are deterministic, idempotent, and applied AFTER the cascade
// (config-resolver.js calls migrateResolvedConfig() on the merged object) —
// they never touch files on disk. Each migration is keyed by the defaults
// $schema_version that introduced it; bump CURRENT_SCHEMA_VERSION and append a
// step here whenever config/defaults.json's shape changes (per CLAUDE.md).

export const CURRENT_SCHEMA_VERSION = 22;

// Kept self-contained (mirrors model-router.js's TIER_ORDER / defaults.json's
// tier_models) so the migrator has zero imports and can never join a cycle
// with the resolver ↔ router graph.
const V6_TIER_ORDER = ['haiku', 'sonnet', 'opus', 'fable'];
const V6_FABLE_MODEL = 'claude-fable-5';
const V7_DEFAULT_MAX_ESCALATION_HOPS = 2;

/**
 * v5 → v6: the 4-rung ladder (MI-1). If the resolved config carries a
 * model_routing block whose tier_models/tier_order predate the fable rung
 * (an override layer clobbered them wholesale), backfill the fable entry so
 * routing decisions that target fable resolve to a real model id. A config
 * with no model_routing at all is left alone — routeModel has its own
 * fallbacks for that shape.
 */
function migrateV5toV6(cfg) {
  const routing = cfg.model_routing;
  if (!routing || typeof routing !== 'object') return cfg;
  let tierModels = routing.tier_models;
  let tierOrder = routing.tier_order;
  const needsModel = tierModels && typeof tierModels === 'object' && !tierModels.fable;
  const needsOrder = Array.isArray(tierOrder) && !tierOrder.includes('fable');
  if (!needsModel && !needsOrder) return cfg;
  if (needsModel) tierModels = { ...tierModels, fable: V6_FABLE_MODEL };
  if (needsOrder) {
    // Preserve the override's relative order and append fable at the top —
    // matching V6_TIER_ORDER when the override was the standard 3-tier list.
    tierOrder = [...tierOrder, 'fable'];
    if (tierOrder.length === V6_TIER_ORDER.length && V6_TIER_ORDER.every((t, i) => tierOrder[i] === t)) {
      tierOrder = [...V6_TIER_ORDER];
    }
  }
  return {
    ...cfg,
    model_routing: {
      ...routing,
      ...(needsModel ? { tier_models: tierModels } : {}),
      ...(needsOrder ? { tier_order: tierOrder } : {}),
    },
  };
}

/**
 * v6 → v7: the graduated escalation ladder (phase-23) adds
 * `auto_run.max_escalation_hops`. defaults.json carries it, so a config that
 * only partially overrides auto_run inherits it via the cascade. What does NOT
 * self-heal is an override layer that replaced the WHOLE auto_run subtree in the
 * pre-v7 shape — deepMerge would leave it without max_escalation_hops, and any
 * consumer reading the value off the resolved object (rather than defaulting
 * inline) would see undefined. Backfill the key so it always resolves. A config
 * with no auto_run block at all is left alone.
 */
function migrateV6toV7(cfg) {
  const ar = cfg.auto_run;
  if (!ar || typeof ar !== 'object') return cfg;
  if (typeof ar.max_escalation_hops === 'number') return cfg;
  return { ...cfg, auto_run: { ...ar, max_escalation_hops: V7_DEFAULT_MAX_ESCALATION_HOPS } };
}

/**
 * v7 → v8: skip-adjudication-when-clean (Phase 33, QL-5) adds
 * `audit.skip_adjudication_when_clean`. defaults.json carries it, and
 * deepMerge's per-key recursion means any override layer that only overrides
 * a SIBLING key (e.g. `audit.two_stage`) already inherits it — no backfill
 * needed there. What does NOT self-heal is an override layer that replaced
 * the whole `audit` subtree as a non-object (deepMerge's array/primitive
 * replace-wholesale path), or a pre-v8 snapshot of the audit shape captured
 * before this key existed. Backfill only when an `audit` block is present but
 * missing the boolean. A config with no audit block at all is left alone —
 * runTwoStageAudit's own `cfg.audit?.skip_adjudication_when_clean !== false`
 * check already fail-safes an absent block to true.
 */
function migrateV7toV8(cfg) {
  const audit = cfg.audit;
  if (!audit || typeof audit !== 'object') return cfg;
  if (typeof audit.skip_adjudication_when_clean === 'boolean') return cfg;
  return { ...cfg, audit: { ...audit, skip_adjudication_when_clean: true } };
}

// Phase 37 (CE-1) defaults for a `ledger` block missing individual keys —
// mirrors V6_TIER_ORDER/V7_DEFAULT_MAX_ESCALATION_HOPS's role as the single
// source of truth for a migration's backfill values.
const V9_LEDGER_DEFAULTS = Object.freeze({ enabled: true, inject_last_k: 8, extract_fallback: true });

/**
 * v8 → v9: the deterministic phase ledger (Phase 37 / CE-1) adds a brand-new
 * top-level `ledger` block. Since NO override layer predating this phase
 * could ever have set `ledger` at all, defaults.json's deepMerge cascade
 * already delivers the full block to every live project with zero migration
 * needed — this backfill exists purely for the same class of edge case every
 * other migration here guards: a captured/frozen RESOLVED config snapshot
 * (not a live cascade) that carries a `ledger` object predating one of these
 * three keys. A config with no `ledger` block at all is left alone — every
 * read site (loadPhaseLedgerBlock, ledger.js's recordPhaseLedgerEntry) already
 * inlines its own fail-safe default for an absent block, matching
 * migrateV7toV8's audit.skip_adjudication_when_clean precedent.
 */
function migrateV8toV9(cfg) {
  const ledger = cfg.ledger;
  if (!ledger || typeof ledger !== 'object') return cfg;
  const patch = {};
  for (const [key, value] of Object.entries(V9_LEDGER_DEFAULTS)) {
    if (!(key in ledger)) patch[key] = value;
  }
  if (!Object.keys(patch).length) return cfg;
  return { ...cfg, ledger: { ...ledger, ...patch } };
}

// Phase 43 (P7): bug-round convergence detection adds `auto_run.convergence`.
const V10_CONVERGENCE_DEFAULTS = Object.freeze({ enabled: true, stall_min_recurring: 2 });

/**
 * v9 → v10: convergence detection (Phase 43 / QL-4) adds `auto_run.convergence`.
 * Same shape of gap as migrateV6toV7's max_escalation_hops: a config that only
 * partially overrides auto_run inherits the new block via the cascade, but an
 * override layer that replaced the WHOLE auto_run subtree in the pre-v10 shape
 * (or a resolved-config snapshot captured before this phase) would resolve
 * without it. Backfill missing keys when a convergence block IS present but
 * incomplete; synthesize the whole block when auto_run exists but has none.
 * A config with no auto_run block at all is left alone — audit-promote.js's
 * own resolveConvergenceCfg already fails open to these same defaults.
 */
function migrateV9toV10(cfg) {
  const ar = cfg.auto_run;
  if (!ar || typeof ar !== 'object') return cfg;
  const convergence = ar.convergence;
  if (!convergence || typeof convergence !== 'object') {
    return { ...cfg, auto_run: { ...ar, convergence: { ...V10_CONVERGENCE_DEFAULTS } } };
  }
  const patch = {};
  for (const [key, value] of Object.entries(V10_CONVERGENCE_DEFAULTS)) {
    if (!(key in convergence)) patch[key] = value;
  }
  if (!Object.keys(patch).length) return cfg;
  return { ...cfg, auto_run: { ...ar, convergence: { ...convergence, ...patch } } };
}

// Phase 44 (P1): the ship gate adds a brand-new top-level `ship_gate` block.
const V11_SHIP_GATE_DEFAULTS = Object.freeze({
  enabled: true,
  audit_level: 'high',
  license_allowlist: ['MIT', 'MIT-0', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'Unlicense', 'CC0-1.0', 'CC-BY-4.0', 'BlueOak-1.0.0', 'Python-2.0', 'WTFPL', 'Zlib'],
});

// Phase 45 (P3): the filesystem deny-rule sandbox adds `security.deny_rules`.
// Shares phase-44's already-bumped schema version 11 (no bump this cycle), so
// its backfill rides the same v10 → v11 step. Mirror of defaults.json's
// security.deny_rules — the single source of truth for the backfill value.
const V11_SECURITY_DENY_RULES = Object.freeze([
  'Read(../../../config/**)',
  'Read(~/.ssh/**)',
  'Read(~/.aws/**)',
  'Read(~/.gnupg/**)',
  'Read(~/.claude/.credentials.json)',
  'Bash(curl:*)',
  'Bash(wget:*)',
]);

/**
 * v10 → v11: the deterministic ship gate (phase-44 / P1) adds a top-level
 * `ship_gate` block, and the filesystem deny-rule sandbox (phase-45 / P3) adds
 * a top-level `security` block — both under schema version 11 (phase-44 owns
 * the single cycle bump; phase-45 adds security.* keys under it). Same edge-case
 * class every top-level-block migration here guards (migrateV8toV9's ledger
 * precedent): defaults.json's cascade already delivers both full blocks to every
 * live project, so these backfills exist only for a captured/frozen RESOLVED
 * config snapshot that carries a `ship_gate`/`security` object predating one of
 * their keys. Backfill missing keys when the block IS present but incomplete; a
 * config with no such block at all is left alone — runShipGate and
 * workspace-skills.js's mergeDenyRules both fail safe to the same defaults for
 * an absent block.
 */
function migrateV10toV11(cfg) {
  let out = cfg;

  const sg = out.ship_gate;
  if (sg && typeof sg === 'object') {
    const patch = {};
    for (const [key, value] of Object.entries(V11_SHIP_GATE_DEFAULTS)) {
      if (!(key in sg)) patch[key] = value;
    }
    if (Object.keys(patch).length) out = { ...out, ship_gate: { ...sg, ...patch } };
  }

  const sec = out.security;
  if (sec && typeof sec === 'object' && !Array.isArray(sec.deny_rules)) {
    out = { ...out, security: { ...sec, deny_rules: [...V11_SECURITY_DENY_RULES] } };
  }

  return out;
}

// Phase 51 (P1 async report-mode / par-02): verify.async_report is a brand-new
// key on the EXISTING top-level `verify` block. Same edge-case class as
// migrateV7toV8's audit.skip_adjudication_when_clean (a new key on an existing
// block): defaults.json's cascade already delivers it to every live project, so
// this backfill exists only for a captured/frozen RESOLVED config snapshot that
// carries a `verify` object predating this key. NOTE the default is `true`
// (advisory-only — a report-mode verdict never blocks), the one documented
// exception to the "new keys default to prior behavior" rule; a snapshot missing
// it is normalized to the same `true` defaults.json ships.
const V12_VERIFY_ASYNC_REPORT = true;

/**
 * v11 → v12: async report-mode acceptance check (phase-51 / par-02) adds
 * `verify.async_report`. Backfill it only when a `verify` block IS present but
 * lacks the key; a config with no `verify` block at all is left alone —
 * shouldDeferAcceptanceCheck (phase-runner.js) reads
 * `verifyCfg?.async_report !== true`, so an absent block/key simply never
 * defers (byte-identical to the pre-phase-51 inline path), and the live
 * defaults.json cascade delivers the `true` default anyway.
 */
function migrateV11toV12(cfg) {
  const verify = cfg.verify;
  if (!verify || typeof verify !== 'object') return cfg;
  if ('async_report' in verify) return cfg;
  return { ...cfg, verify: { ...verify, async_report: V12_VERIFY_ASYNC_REPORT } };
}

// v0.18 chat autopilot defaults — mirror config/defaults.json's chat.autopilot
// block. The whole-block-backfill class (migrateV8toV9's ledger, migrateV10toV11):
// the live defaults.json cascade already delivers this to every project, so this
// exists only for a captured/frozen RESOLVED config snapshot that predates the
// block. enabled:false preserves prior behavior (no autopilot) exactly.
const V13_CHAT_AUTOPILOT = { enabled: false, budget_usd: 5, max_attempts: 8, tick_ms: 20000 };

/**
 * v12 → v13: adds the top-level `chat.autopilot` block. Backfilled only when
 * absent; an existing `chat` object is preserved and only its missing
 * `autopilot` sub-key is added (existing autopilot values win). autopilotConfig
 * (chat-engine.js) already reads every key with a fallback default, so a config
 * missing the block behaves identically (autopilot off) — this normalization is
 * purely so a frozen snapshot reads the same shape defaults.json ships.
 */
function migrateV12toV13(cfg) {
  const existingChat = (cfg.chat && typeof cfg.chat === 'object') ? cfg.chat : {};
  if (existingChat.autopilot && typeof existingChat.autopilot === 'object') return cfg;
  return { ...cfg, chat: { ...existingChat, autopilot: { ...V13_CHAT_AUTOPILOT } } };
}

// Phase 52 (par-03) deliberately adds NO migration step: auto_run.async_reviews
// defaults to `false`, which IS today's fully-synchronous behavior — unlike
// verify.async_report (migrateV11toV12, defaults to true), there is no gap for
// an old resolved-config snapshot to fall into. Every call site reads it with
// `=== true` (auto-runner.js), so a snapshot predating this key behaves
// identically to one that has it set to false. No CURRENT_SCHEMA_VERSION bump
// this cycle either — phase-51 owns the sole bump (11->12; a later, unrelated
// commit bumped 12->13 for chat.autopilot).

// Phase 57 (P1, run_events timeline) — this phase's ONE schema bump for the
// "Observability & Phone-First Legibility" cycle. Adds `cleanup.run_events_
// retention_days`, a new key on the EXISTING top-level `cleanup` block.
const V14_RUN_EVENTS_RETENTION_DAYS = 90;

/**
 * v13 → v14: the run_events append-only timeline (phase-57 / P1) adds
 * `cleanup.run_events_retention_days`. Same edge-case class as
 * migrateV11toV12's verify.async_report (a new key on an existing block):
 * the live defaults.json cascade already delivers it to every project, so
 * this backfill exists only for a captured/frozen RESOLVED config snapshot
 * that carries a `cleanup` object predating this key. A config with no
 * `cleanup` block at all is left alone — auto-runner.js's retention sweep
 * already falls back to the same 90-day default inline.
 */
function migrateV13toV14(cfg) {
  const cleanup = cfg.cleanup;
  if (!cleanup || typeof cleanup !== 'object') return cfg;
  if ('run_events_retention_days' in cleanup) return cfg;
  return { ...cfg, cleanup: { ...cleanup, run_events_retention_days: V14_RUN_EVENTS_RETENTION_DAYS } };
}

// Phase 65 (Execution DAG P1): three inert scaffolding additions under one
// schema bump — new keys on the EXISTING `auto_run` and `bug_cycle` blocks,
// plus a brand-new top-level `parallel_lanes` block. All three are dormant
// (kill-switch defaults) until a later phase in this cycle wires a scheduler
// up to read them.
const V15_AUTO_RUN_DEFAULTS = Object.freeze({ max_parallel_phases: 1, speculative_duo_on_double_failure: false });
const V15_BUG_CYCLE_DEFAULTS = Object.freeze({ max_parallel_fixes: 1, batch_minor_fixes: false, batch_max: 4 });
const V15_PARALLEL_LANES_DEFAULTS = Object.freeze({ dir: '.worktrees', node_modules: 'symlink' });

/**
 * v14 → v15: the Execution DAG cycle's scaffolding phase (phase-65) adds
 * `auto_run.max_parallel_phases` / `auto_run.speculative_duo_on_double_failure`
 * (new keys on the existing `auto_run` block), `bug_cycle.max_parallel_fixes` /
 * `bug_cycle.batch_minor_fixes` / `bug_cycle.batch_max` (new keys on the
 * existing `bug_cycle` block), and a brand-new top-level `parallel_lanes`
 * block. Same edge-case class every migration here guards: the live
 * defaults.json cascade already delivers all of these to every project, so
 * these backfills exist only for a captured/frozen RESOLVED config snapshot
 * predating this phase. Backfill missing keys only when the PARENT block is
 * already present (mirrors migrateV11toV12's verify.async_report /
 * migrateV13toV14's cleanup.run_events_retention_days); a config with no
 * `auto_run`/`bug_cycle`/`parallel_lanes` block at all is left alone — every
 * future read site must fail-safe to these same values for an absent block,
 * matching migrateV8toV9's ledger precedent.
 */
function migrateV14toV15(cfg) {
  let out = cfg;

  const ar = out.auto_run;
  if (ar && typeof ar === 'object') {
    const patch = {};
    for (const [key, value] of Object.entries(V15_AUTO_RUN_DEFAULTS)) {
      if (!(key in ar)) patch[key] = value;
    }
    if (Object.keys(patch).length) out = { ...out, auto_run: { ...ar, ...patch } };
  }

  const bc = out.bug_cycle;
  if (bc && typeof bc === 'object') {
    const patch = {};
    for (const [key, value] of Object.entries(V15_BUG_CYCLE_DEFAULTS)) {
      if (!(key in bc)) patch[key] = value;
    }
    if (Object.keys(patch).length) out = { ...out, bug_cycle: { ...bc, ...patch } };
  }

  const pl = out.parallel_lanes;
  if (pl && typeof pl === 'object') {
    const patch = {};
    for (const [key, value] of Object.entries(V15_PARALLEL_LANES_DEFAULTS)) {
      if (!(key in pl)) patch[key] = value;
    }
    if (Object.keys(patch).length) out = { ...out, parallel_lanes: { ...pl, ...patch } };
  }

  return out;
}

// Brief 08 / P1(b) — the "Close the Loop" cycle's ONE schema bump. Adds the
// brand-new top-level `llm_contract` block (the generalized output contract).
// Whole-block-backfill class (migrateV12toV13's chat.autopilot, migrateV8toV9's
// ledger): the live defaults.json cascade already delivers this to every
// project, so this exists only for a captured/frozen RESOLVED config snapshot
// predating the block. Every read site fails-safe to these same values for an
// absent block (llm-contract.js honors enabled !== false, max_reasks ?? 1), so
// a snapshot missing the block behaves identically — this normalization is
// purely so a frozen snapshot reads the same shape defaults.json ships.
const V16_LLM_CONTRACT = { enabled: true, max_reasks: 1, escalate_on_second_fail: false };

/**
 * v15 → v16: adds the top-level `llm_contract` block. Backfilled only when
 * absent; an existing block is preserved untouched (its values win).
 */
function migrateV15toV16(cfg) {
  if (cfg.llm_contract && typeof cfg.llm_contract === 'object') return cfg;
  return { ...cfg, llm_contract: { ...V16_LLM_CONTRACT } };
}

// v16 → v17: absolute turn ceiling. This lives beside the ordinary per-project
// caps but is applied after resolution, so a legacy project override cannot
// re-enable unbounded long-running dev calls.
const V17_MAX_TURNS_HARD_CAP = 60;
function migrateV16toV17(cfg) {
  const phases = cfg.phases;
  if (!phases || typeof phases !== 'object' || 'max_turns_hard_cap' in phases) return cfg;
  return { ...cfg, phases: { ...phases, max_turns_hard_cap: V17_MAX_TURNS_HARD_CAP } };
}

// v17 → v18: durable interrupted-phase recovery plus acceptance cadence.
// July 2026 workload calibration made checkpoints the orchestrator-wide
// default: deterministic validators still protect every commit, while the LLM
// checker runs periodically and at final/high-risk boundaries.
const V18_PHASE_RECOVERY = Object.freeze({
  resume_interrupted_session: true,
  reconcile_committed_phase_before_spawn: true,
  max_turns_continuation: 25,
  max_continuation_attempts: 1,
});
const V18_VERIFY_CADENCE = Object.freeze({
  mode: 'checkpoints',
  every_n_phases: 3,
  always_final: true,
  always_complexities: ['high', 'critical'],
  always_checkpoints: ['architecture', 'schema', 'external-integration', 'destructive'],
});

function migrateV17toV18(cfg) {
  let out = cfg;
  const phases = out.phases;
  if (phases && typeof phases === 'object') {
    const patch = {};
    for (const [key, value] of Object.entries(V18_PHASE_RECOVERY)) {
      if (!(key in phases)) patch[key] = value;
    }
    if (Object.keys(patch).length) out = { ...out, phases: { ...phases, ...patch } };
  }

  const verify = out.verify;
  if (verify && typeof verify === 'object') {
    const cadence = verify.cadence;
    if (!cadence || typeof cadence !== 'object') {
      out = { ...out, verify: { ...verify, cadence: { ...V18_VERIFY_CADENCE } } };
    } else {
      const patch = {};
      for (const [key, value] of Object.entries(V18_VERIFY_CADENCE)) {
        if (!(key in cadence)) patch[key] = value;
      }
      if (Object.keys(patch).length) {
        out = { ...out, verify: { ...verify, cadence: { ...cadence, ...patch } } };
      }
    }
  }
  return out;
}

// v18 → v19: deterministic Hybrid Context Compiler. Live cascaded configs
// receive the complete block from defaults.json. This migration normalizes a
// captured/frozen resolved config only when it already carries a partial
// context_compiler block; absence remains disabled at read sites, preserving
// pre-v19 behavior for snapshots that never passed through the live cascade.
const V19_CONTEXT_COMPILER = Object.freeze({
  enabled: true,
  mode: 'shadow',
  provider: 'hybrid-lexical',
  fallback: ['repo-map', 'lexical'],
  max_files: 12,
  max_symbols: 20,
  max_reference_depth: 1,
  min_confidence: 0.65,
  max_scan_files: 2000,
  max_file_bytes: 256000,
  timeout_ms: { warm: 10000, cold: 45000 },
  token_budget: { low: 1200, medium: 1800, high: 2500, critical: 2500, fix: 1000, repair: 1200, hard_max: 3000 },
  fresh_repair_session: true,
  delta_acceptance_recheck: true,
  targeted_tests: true,
  full_suite_every_checkpoints: 3,
});

function migrateV18toV19(cfg) {
  const compiler = cfg.context_compiler;
  if (!compiler || typeof compiler !== 'object') return cfg;
  const out = { ...compiler };
  for (const [key, value] of Object.entries(V19_CONTEXT_COMPILER)) {
    if (!(key in out)) out[key] = Array.isArray(value) ? [...value] : (value && typeof value === 'object' ? { ...value } : value);
  }
  out.timeout_ms = { ...V19_CONTEXT_COMPILER.timeout_ms, ...(compiler.timeout_ms || {}) };
  out.token_budget = { ...V19_CONTEXT_COMPILER.token_budget, ...(compiler.token_budget || {}) };
  return { ...cfg, context_compiler: out };
}

// v19 → v20: measured context-compiler rollout. The live defaults cascade
// supplies this block; frozen resolved snapshots with a compiler block receive
// conservative rollout defaults (promotion off, rollback on).
const V20_CONTEXT_ROLLOUT = Object.freeze({
  enabled: true,
  auto_promote: false,
  auto_rollback: true,
  window_size: 20,
  max_sample_age_hours: 168,
  promotion: {
    min_samples: 12, min_outcome_samples: 10, min_outcome_coverage: 0.8,
    min_precision: 0.65, min_recall: 0.8, min_confidence: 0.65, max_failure_rate: 0.05,
  },
  rollback: {
    min_samples: 5, min_outcome_samples: 3, min_outcome_coverage: 0.5,
    min_precision: 0.45, min_recall: 0.6, min_confidence: 0.45, max_failure_rate: 0.2,
  },
});

function migrateV19toV20(cfg) {
  const compiler = cfg.context_compiler;
  if (!compiler || typeof compiler !== 'object') return cfg;
  const rollout = compiler.rollout && typeof compiler.rollout === 'object' ? compiler.rollout : {};
  return {
    ...cfg,
    context_compiler: {
      ...compiler,
      rollout: {
        ...V20_CONTEXT_ROLLOUT,
        ...rollout,
        promotion: { ...V20_CONTEXT_ROLLOUT.promotion, ...(rollout.promotion || {}) },
        rollback: { ...V20_CONTEXT_ROLLOUT.rollback, ...(rollout.rollback || {}) },
      },
    },
  };
}

// v20 → v21: shared provider/account circuit breaker plus opt-in issue auto-fix.
// Live cascaded configs inherit both complete blocks from defaults.json. This
// migration protects frozen resolved snapshots and whole-subtree overrides.
const V21_PROVIDER_BREAKER = Object.freeze({
  enabled: true,
  provider: 'anthropic',
  account: 'max_pooled',
  fallback_cooldown_minutes: 30,
  safety_buffer_seconds: 60,
});

function migrateV20toV21(cfg) {
  let out = cfg;
  const billing = out.billing;
  if (billing && typeof billing === 'object') {
    const breaker = billing.provider_circuit_breaker && typeof billing.provider_circuit_breaker === 'object'
      ? billing.provider_circuit_breaker
      : {};
    out = {
      ...out,
      billing: {
        ...billing,
        provider_circuit_breaker: { ...V21_PROVIDER_BREAKER, ...breaker },
      },
    };
  }
  const chat = out.chat;
  if (chat && typeof chat === 'object') {
    const issueBridge = chat.issue_bridge && typeof chat.issue_bridge === 'object'
      ? chat.issue_bridge
      : {};
    out = {
      ...out,
      chat: { ...chat, issue_bridge: { auto_fix: false, ...issueBridge } },
    };
  }
  return out;
}

// v21 → v22: bounded max-turn recovery, historical phase-size prediction,
// deterministic ledger extraction, and an instrumented self-heal task. The
// provider heavy-call lease is also part of this schema generation and may
// extend the billing portion below; keep one migration so old snapshots cross
// the complete efficiency boundary atomically.
const V22_PHASE_RECOVERY = Object.freeze({
  max_continuation_attempts_hard_cap: 1,
  max_continuation_context_tokens: 180000,
  fresh_recovery_after_max_turns: true,
  fresh_recovery_max_turns: 30,
});
const V22_TURN_PREDICTION = Object.freeze({
  enabled: true,
  max_predicted_turns: 45,
  min_samples: 12,
  min_confidence: 0.25,
  enforce_heuristic: false,
  history_limit: 200,
});
const V22_HEAVY_CALL_LEASE = Object.freeze({
  enabled: true,
  max_concurrent: 1,
  lease_ttl_ms: 180000,
  heartbeat_ms: 30000,
  poll_ms: 2000,
  waiter_ttl_ms: 60000,
  wait_timeout_ms: 2700000,
  cheap_tasks: ['ledger-extract', 'autopsy', 'autopilot-digest'],
  cheap_call_weight: 0.25,
  heavy_tasks: [],
});

function migrateV21toV22(cfg) {
  let out = cfg;
  const phases = out.phases;
  if (phases && typeof phases === 'object') {
    const recoveryPatch = {};
    for (const [key, value] of Object.entries(V22_PHASE_RECOVERY)) {
      if (!(key in phases)) recoveryPatch[key] = value;
    }
    const prediction = phases.turn_prediction && typeof phases.turn_prediction === 'object'
      ? phases.turn_prediction
      : {};
    const taskTimeout = phases.task_timeout_ms && typeof phases.task_timeout_ms === 'object'
      ? phases.task_timeout_ms
      : {};
    const taskTurns = phases.task_max_turns && typeof phases.task_max_turns === 'object'
      ? phases.task_max_turns
      : {};
    out = {
      ...out,
      phases: {
        ...phases,
        ...recoveryPatch,
        turn_prediction: { ...V22_TURN_PREDICTION, ...prediction },
        task_timeout_ms: { 'self-heal': 300000, ...taskTimeout },
        task_max_turns: { 'self-heal': 8, ...taskTurns },
      },
    };
  }

  if (out.models && typeof out.models === 'object' && !('self-heal' in out.models)) {
    out = { ...out, models: { ...out.models, 'self-heal': 'claude-sonnet-5' } };
  }
  if (out.ledger && typeof out.ledger === 'object' && !('llm_extract_fallback' in out.ledger)) {
    out = { ...out, ledger: { ...out.ledger, llm_extract_fallback: false } };
  }
  if (out.auto_run && typeof out.auto_run === 'object' && !('max_auto_reprompt_attempts' in out.auto_run)) {
    out = { ...out, auto_run: { ...out.auto_run, max_auto_reprompt_attempts: 1 } };
  }
  if (out.auto_heal && typeof out.auto_heal === 'object' && !('self_heal_confirmation_timeout_ms' in out.auto_heal)) {
    out = { ...out, auto_heal: { ...out.auto_heal, self_heal_confirmation_timeout_ms: 120000 } };
  }
  if (out.billing && typeof out.billing === 'object') {
    const lease = out.billing.heavy_call_lease && typeof out.billing.heavy_call_lease === 'object'
      ? out.billing.heavy_call_lease
      : {};
    out = {
      ...out,
      billing: {
        ...out.billing,
        enforce_cost_thresholds: out.billing.enforce_cost_thresholds ?? false,
        heavy_call_lease: { ...V22_HEAVY_CALL_LEASE, ...lease },
      },
    };
  }
  return out;
}

const MIGRATIONS = [
  { to: 6, apply: migrateV5toV6 },
  { to: 7, apply: migrateV6toV7 },
  { to: 8, apply: migrateV7toV8 },
  { to: 9, apply: migrateV8toV9 },
  { to: 10, apply: migrateV9toV10 },
  { to: 11, apply: migrateV10toV11 },
  { to: 12, apply: migrateV11toV12 },
  { to: 13, apply: migrateV12toV13 },
  { to: 14, apply: migrateV13toV14 },
  { to: 15, apply: migrateV14toV15 },
  { to: 16, apply: migrateV15toV16 },
  { to: 17, apply: migrateV16toV17 },
  { to: 18, apply: migrateV17toV18 },
  { to: 19, apply: migrateV18toV19 },
  { to: 20, apply: migrateV19toV20 },
  { to: 21, apply: migrateV20toV21 },
  { to: 22, apply: migrateV21toV22 },
];

/**
 * Normalize a fully-cascaded config object to the current schema shape.
 * Idempotent — safe to call on every resolve(). Returns a (possibly new)
 * config object; never mutates the input's nested objects in place.
 *
 * @param {Object} merged - the post-cascade config from config-resolver.js
 * @returns {Object}
 */
export function migrateResolvedConfig(merged) {
  if (!merged || typeof merged !== 'object') return merged;
  let cfg = merged;
  for (const { apply } of MIGRATIONS) {
    cfg = apply(cfg);
  }
  return cfg;
}
