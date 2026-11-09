// Config Resolver — merges 4 layers into effective config at runtime.
//
// Layer order (lowest priority → highest):
//   1. config/defaults.json
//   2. ~/.ashmero-orchestrator/user.json
//   3. projects/<name>/project.json (and any referenced profile)
//   4. .guide/plan.json phase override (per phase)
//
// Usage:
//   import { resolve } from './config-resolver.js';
//   const cfg = await resolve({ project: 'reelchain', phase: 7, task: 'dev-execution' });
//   cfg.model        // e.g. 'claude-opus-4-8' (after applying phase override)
//   cfg.billing.mode // e.g. 'max_pooled'

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { validate, validateDenyRules, validateTaskProfiles } from './config-validator.js';
import { migrateResolvedConfig } from './config-migrator.js';
import chalk from 'chalk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const DEFAULTS_PATH = path.join(REPO_ROOT, 'config', 'defaults.json');
const PROFILES_DIR = path.join(REPO_ROOT, 'config', 'profiles');
const USER_CONFIG_DIR = path.join(os.homedir(), '.ashmero-orchestrator');
const USER_CONFIG_PATH = path.join(USER_CONFIG_DIR, 'user.json');

/**
 * Deep merge b into a. Arrays are replaced, not concatenated. Returns new object.
 */
function deepMerge(a, b) {
  // `undefined` means the override layer doesn't mention this key → keep the
  // lower layer. `null` is the documented "set to null to disable" convention
  // throughout config/defaults.json, so it must WIN over the lower layer (the
  // old `b === null → return a` silently dropped every explicit-null override).
  if (b === undefined) return a;
  if (b === null) return null;
  if (Array.isArray(b)) return b;
  if (typeof b !== 'object') return b;
  if (typeof a !== 'object' || a === null || Array.isArray(a)) return deepMerge({}, b);

  const result = { ...a };
  for (const key of Object.keys(b)) {
    result[key] = deepMerge(a[key], b[key]);
  }
  return result;
}

async function readJson(filepath) {
  try {
    const raw = await fs.readFile(filepath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`Failed to read ${filepath}: ${err.message}`);
  }
}

async function loadDefaults() {
  const cfg = await readJson(DEFAULTS_PATH);
  if (!cfg) throw new Error(`Missing required config: ${DEFAULTS_PATH}`);
  validate(cfg, 'defaults');
  validateDenyRules(cfg.security?.deny_rules, 'defaults (config/defaults.json)');
  validateTaskProfiles(cfg.tools?.task_profiles, 'defaults (config/defaults.json)');
  return cfg;
}

async function loadUser() {
  const cfg = await readJson(USER_CONFIG_PATH);
  if (!cfg) return {};
  validate(cfg, 'user');
  validateDenyRules(cfg.overrides?.security?.deny_rules, `user overrides (${USER_CONFIG_PATH})`);
  validateTaskProfiles(cfg.overrides?.tools?.task_profiles, `user overrides (${USER_CONFIG_PATH})`);
  return cfg;
}

async function loadProfile(profileName) {
  if (!profileName) return {};
  // Guard against path traversal: `profileName` comes from project.json's
  // `profile` field, which createProject / POST /api/projects set verbatim from
  // user input with no character validation (unlike `name`). Restrict to a safe
  // filename slug before path.join so it can't escape PROFILES_DIR.
  if (typeof profileName !== 'string' || !/^[A-Za-z0-9._-]+$/.test(profileName) || profileName.includes('..')) {
    throw new Error(`Invalid profile name: ${JSON.stringify(profileName)} (must match [A-Za-z0-9._-]+ with no "..")`);
  }
  const profilePath = path.join(PROFILES_DIR, `${profileName}.json`);
  const cfg = await readJson(profilePath);
  if (!cfg) throw new Error(`Profile not found: ${profileName} (expected at ${profilePath})`);
  validateDenyRules(cfg.overrides?.security?.deny_rules, `profile overrides (${profilePath})`);
  validateTaskProfiles(cfg.overrides?.tools?.task_profiles, `profile overrides (${profilePath})`);
  return cfg.overrides || {};
}

async function loadProject(projectName) {
  if (!projectName) return { project: null, profileOverrides: {} };
  const projectPath = path.join(REPO_ROOT, 'projects', projectName, 'project.json');
  const project = await readJson(projectPath);
  if (!project) {
    throw new Error(`Project not found: ${projectName} (expected at ${projectPath})`);
  }
  validate(project, 'project');
  validateDenyRules(project.overrides?.security?.deny_rules, `project overrides (${projectPath})`);
  validateTaskProfiles(project.overrides?.tools?.task_profiles, `project overrides (${projectPath})`);

  const profileOverrides = await loadProfile(project.profile);

  return { project, profileOverrides };
}

async function loadPlanPhaseOverride(projectName, phaseNumber) {
  if (!projectName || phaseNumber == null) return {};
  const planPath = path.join(REPO_ROOT, 'projects', projectName, '.guide', 'plan.json');
  const plan = await readJson(planPath);
  if (!plan) return {};

  const phase = (plan.phases || []).find((p) => p.n === phaseNumber);
  if (!phase) return {};

  const override = {};
  if (phase.model_override) {
    override.models = { 'dev-execution': phase.model_override };
  }
  if (phase.max_turns_override != null) {
    override.phases = { max_turns_per_phase: phase.max_turns_override };
  }
  return override;
}

/**
 * Resolve effective config for a (project, phase, task) tuple.
 *
 * @param {Object} opts
 * @param {string} [opts.project] - project name (folder under projects/)
 * @param {number} [opts.phase] - 1-based phase number
 * @param {string} [opts.task] - one of: plan-creation, phase-prompt-gen,
 *                                dev-execution, 3-phase-review, handoff-creation
 * @returns {Promise<Object>} effective config
 */
export async function resolve({ project = null, phase = null, task = 'dev-execution' } = {}) {
  const defaults = await loadDefaults();
  const user = await loadUser();
  const { project: proj, profileOverrides } = project
    ? await loadProject(project)
    : { project: null, profileOverrides: {} };
  const phaseOverride = await loadPlanPhaseOverride(project, phase);

  // Cascade: defaults → user.overrides → profile → project.overrides → phase
  let merged = deepMerge({}, defaults);
  if (user.overrides) merged = deepMerge(merged, user.overrides);
  merged = deepMerge(merged, profileOverrides);
  if (proj?.overrides) merged = deepMerge(merged, proj.overrides);
  merged = deepMerge(merged, phaseOverride);

  // Read-side shape migration (v0.17): an override layer that clobbered a
  // whole subtree in an older schema shape (e.g. a project.json replacing
  // model_routing.tier_models wholesale, pre-fable) is normalized to the
  // current shape here — deterministic and idempotent, never touches disk.
  merged = migrateResolvedConfig(merged);

  // Derived fields
  // Fall back gracefully if the task has no entry in any config layer.
  // Every known task is listed in config/defaults.json; this path fires only
  // when a future task is added to guide-tasks.js without a defaults entry.
  let model = merged.models?.[task];
  if (!model) {
    model = merged.models?.['dev-execution'] ?? 'claude-sonnet-4-6';
    console.warn(chalk.yellow(`  ⚠ No model configured for task '${task}' — falling back to ${model}. Add an entry to config/defaults.json.`));
  }

  return {
    ...merged,
    // Convenience: resolved model for the requested task
    model,
    // Echo back metadata about what was resolved
    _resolved: {
      project: project || null,
      phase: phase || null,
      task,
      claude_bin:
        process.env.CLAUDE_BIN || user.claude_bin || 'claude',
      project_data: proj || null,
    },
  };
}

/**
 * Sanity self-test — run with: node src/config-resolver.js --selftest
 */
async function selftest() {
  console.log('Config resolver self-test...');
  const cfg = await resolve({ task: 'dev-execution' });
  console.log('Defaults-only dev-execution model:', cfg.model);
  console.log('Billing mode:', cfg.billing.mode);
  console.log('Allow API fallback:', cfg.billing.allow_api_fallback);
  if (cfg.billing.allow_api_fallback !== false) {
    console.error('FAIL: allow_api_fallback must be false in defaults');
    process.exit(1);
  }

  // New flag defaults
  if (cfg.auto_run.review_auto_proceed_score_threshold !== 85) {
    console.error('FAIL: review_auto_proceed_score_threshold must be 85 in defaults');
    process.exit(1);
  }
  if (cfg.auto_run.raw_thoughts_auto_brief !== true) {
    console.error('FAIL: raw_thoughts_auto_brief must be true in defaults');
    process.exit(1);
  }
  if (cfg.auto_run.auto_promote_audit_bugs !== true) {
    console.error('FAIL: auto_promote_audit_bugs must be true in defaults');
    process.exit(1);
  }

  // Project override test (deep-merge, no disk I/O)
  const overridden = deepMerge(cfg, { auto_run: { auto_promote_audit_bugs: false } });
  if (overridden.auto_run.auto_promote_audit_bugs !== false) {
    console.error('FAIL: project override for auto_promote_audit_bugs must resolve to false');
    process.exit(1);
  }
  // Sibling key preserved after override
  if (overridden.auto_run.auto_promote_audit_bugs === false &&
      overridden.auto_run.review_auto_proceed_score_threshold !== 85) {
    console.error('FAIL: sibling auto_run keys must survive a partial override');
    process.exit(1);
  }
  console.log('auto_run new flags: OK');

  // phase-52 (par-03): async_reviews defaults to false (fully-synchronous,
  // today's behavior); no migrator entry exists for it (see config-migrator.js),
  // so a legacy/frozen snapshot simply reads undefined here — auto-runner.js
  // reads it with `=== true`, so both resolve to the same off behavior.
  if (cfg.auto_run.async_reviews !== false) {
    console.error('FAIL: auto_run.async_reviews must default to false');
    process.exit(1);
  }
  console.log('phase-52 auto_run.async_reviews default: OK');

  // v0.17 (schema 6) — 4-rung ladder present in defaults
  if (cfg.model_routing?.tier_models?.fable !== 'claude-fable-5') {
    console.error('FAIL: model_routing.tier_models.fable must be claude-fable-5 in defaults');
    process.exit(1);
  }
  if (!Array.isArray(cfg.model_routing?.tier_order) || !cfg.model_routing.tier_order.includes('fable')) {
    console.error('FAIL: model_routing.tier_order must include fable in defaults');
    process.exit(1);
  }
  // v0.17 migrator — an override layer that clobbered tier_models/tier_order
  // wholesale in the pre-fable shape is backfilled on resolve (read-side
  // compat; the offending layer here is a simulated project override).
  const legacyShape = migrateResolvedConfig({
    model_routing: {
      tier_order: ['haiku', 'sonnet', 'opus'],
      tier_models: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-4-8' },
    },
  });
  if (legacyShape.model_routing.tier_models.fable !== 'claude-fable-5'
      || !legacyShape.model_routing.tier_order.includes('fable')) {
    console.error('FAIL: config-migrator must backfill the fable tier into a pre-v6 model_routing override (project layer)');
    process.exit(1);
  }
  // Turn guardrails: tier limits plus the final post-resolution hard ceiling.
  if (cfg.phases.max_turns_per_tier?.sonnet !== 60
      || cfg.phases.max_turns_per_tier?.opus !== 60
      || cfg.phases.max_turns_per_tier?.fable !== 60) {
    console.error('FAIL: phases.max_turns_per_tier must cap sonnet/opus/fable at 60');
    process.exit(1);
  }
  if (cfg.phases.turn_budget_by_complexity?.low !== 45
      || cfg.phases.turn_budget_by_complexity?.critical !== 60
      || cfg.phases.max_turns_hard_cap !== 60) {
    console.error('FAIL: phases turn budgets and max_turns_hard_cap must use the conservative defaults');
    process.exit(1);
  }
  if (cfg.phases.task_effort?.['plan-creation'] !== 'xhigh') {
    console.error('FAIL: phases.task_effort["plan-creation"] must default to xhigh');
    process.exit(1);
  }
  console.log('tier/turn/effort defaults + migrator: OK');

  // phase-56 (MI-5) — telemetry-learned routing floors defaults (no schema bump)
  {
    const tele = cfg.model_routing?.telemetry;
    if (!tele || tele.enabled !== true || tele.window_calls !== 12 || tele.min_samples !== 6
        || tele.escalate_fail_rate !== 0.33 || tele.decay_streak !== 5) {
      console.error('FAIL: model_routing.telemetry must default to { enabled:true, window_calls:12, min_samples:6, escalate_fail_rate:0.33, decay_streak:5 }');
      process.exit(1);
    }
    // A partial model_routing override must not drop the telemetry defaults.
    const overriddenMR = deepMerge(cfg, { model_routing: { show_reasoning_in_log: false } });
    if (overriddenMR.model_routing.telemetry?.enabled !== true) {
      console.error('FAIL: a partial model_routing override must preserve model_routing.telemetry');
      process.exit(1);
    }
  }
  console.log('phase-56 model_routing.telemetry defaults: OK');

  // phase-23 (schema 7) — graduated escalation ladder hop budget in defaults
  // phase-37 (schema 9): the phase-ledger `ledger` block bump (schema was
  // already at 8 from phase-33's audit.skip_adjudication_when_clean bump).
  // phase-43 (schema 10): auto_run.convergence bump (bug-round convergence detection).
  // phase-44 (schema 11): ship_gate bump (deterministic secret/dep/license gate).
  // phase-51 (schema 12): verify.async_report bump (async report-mode acceptance check).
  // v0.18 (schema 13): chat.autopilot bump (drive-to-done loop config).
  // phase-57 (schema 14): cleanup.run_events_retention_days bump (run_events timeline retention).
  // phase-65 (schema 15): auto_run.max_parallel_phases/speculative_duo_on_double_failure,
  // bug_cycle.max_parallel_fixes/batch_minor_fixes/batch_max, and the new parallel_lanes block.
  // phase-77 (schema 16): llm_contract; schema 17: max_turns_hard_cap;
  // schema 18: interrupted-session recovery + acceptance-check cadence;
  // schema 19: Hybrid Context Compiler.
  if (cfg.$schema_version !== 22) {
    console.error(`FAIL: defaults $schema_version must be 22, got ${cfg.$schema_version}`);
    process.exit(1);
  }
  if (cfg.llm_contract?.enabled !== true || cfg.llm_contract?.max_reasks !== 1 || cfg.llm_contract?.escalate_on_second_fail !== false) {
    console.error('FAIL: llm_contract must default to { enabled:true, max_reasks:1, escalate_on_second_fail:false }');
    process.exit(1);
  }
  // Migrator backfills the whole llm_contract block into a snapshot predating it
  // (idempotent — an explicit block is preserved untouched).
  const legacyContract = migrateResolvedConfig({ $schema_version: 15 });
  if (legacyContract.llm_contract?.enabled !== true) {
    console.error('FAIL: config-migrator v15→v16 must backfill the llm_contract block');
    process.exit(1);
  }
  const contractTwice = migrateResolvedConfig(migrateResolvedConfig({ llm_contract: { enabled: false } }));
  if (contractTwice.llm_contract?.enabled !== false) {
    console.error('FAIL: config-migrator v15→v16 must be idempotent (must not clobber an explicit llm_contract)');
    process.exit(1);
  }
  const legacyTurnCeiling = migrateResolvedConfig({ $schema_version: 16, phases: {} });
  if (legacyTurnCeiling.phases?.max_turns_hard_cap !== 60) {
    console.error('FAIL: config-migrator v16→v17 must backfill max_turns_hard_cap');
    process.exit(1);
  }
  const legacyRecovery = migrateResolvedConfig({ $schema_version: 17, phases: {}, verify: {} });
  if (legacyRecovery.phases?.resume_interrupted_session !== true
      || legacyRecovery.phases?.reconcile_committed_phase_before_spawn !== true
      || legacyRecovery.verify?.cadence?.mode !== 'checkpoints') {
    console.error('FAIL: config-migrator v17→v18 must backfill phase recovery and the checkpoints cadence');
    process.exit(1);
  }

  if (cfg.context_compiler?.enabled !== true || cfg.context_compiler?.mode !== 'shadow') {
    console.error('FAIL: context_compiler must default to enabled shadow mode');
    process.exit(1);
  }
  const partialCompiler = migrateResolvedConfig({ $schema_version: 18, context_compiler: { enabled: false, token_budget: { medium: 900 } } });
  if (partialCompiler.context_compiler.enabled !== false || partialCompiler.context_compiler.mode !== 'shadow' || partialCompiler.context_compiler.token_budget.medium !== 900 || partialCompiler.context_compiler.token_budget.repair !== 1200 || partialCompiler.context_compiler.rollout.auto_promote !== false) {
    console.error('FAIL: schema-19/20 context_compiler migration must preserve overrides and backfill nested defaults');
    process.exit(1);
  }
  if (cfg.chat?.autopilot?.enabled !== false) {
    console.error('FAIL: chat.autopilot.enabled must default to false');
    process.exit(1);
  }
  if (cfg.chat?.issue_bridge?.auto_fix !== false
      || cfg.billing?.provider_circuit_breaker?.enabled !== true) {
    console.error('FAIL: provider circuit breaker must default on and issue auto-fix must default off');
    process.exit(1);
  }
  if (cfg.billing?.heavy_call_lease?.enabled !== true
      || cfg.billing?.heavy_call_lease?.max_concurrent !== 1
      || cfg.billing?.heavy_call_lease?.cheap_call_weight !== 0.25
      || !cfg.billing?.heavy_call_lease?.cheap_tasks?.includes('ledger-extract')
      || cfg.billing?.enforce_cost_thresholds !== false) {
    console.error('FAIL: account-wide heavy-call lease must default on with concurrency 1');
    process.exit(1);
  }
  if (cfg.phases?.max_continuation_attempts_hard_cap !== 1
      || cfg.phases?.fresh_recovery_after_max_turns !== true
      || cfg.phases?.turn_prediction?.enabled !== true
      || cfg.ledger?.llm_extract_fallback !== false
      || cfg.phases?.task_max_turns?.['self-heal'] !== 8) {
    console.error('FAIL: schema-22 execution-efficiency defaults are incomplete');
    process.exit(1);
  }
  if (cfg.auto_run.max_escalation_hops !== 2) {
    console.error('FAIL: auto_run.max_escalation_hops must default to 2');
    process.exit(1);
  }
  // Migrator backfills the hop budget into a wholesale auto_run override that
  // predates v7 (idempotent — a second pass over an already-backfilled config
  // leaves it unchanged).
  const legacyAutoRun = migrateResolvedConfig({ auto_run: { max_phases_per_run: 9999 } });
  if (legacyAutoRun.auto_run.max_escalation_hops !== 2) {
    console.error('FAIL: config-migrator must backfill max_escalation_hops into a pre-v7 auto_run override');
    process.exit(1);
  }
  const twice = migrateResolvedConfig(migrateResolvedConfig({ auto_run: { max_escalation_hops: 5 } }));
  if (twice.auto_run.max_escalation_hops !== 5) {
    console.error('FAIL: config-migrator v6→v7 must be idempotent (must not clobber an explicit value)');
    process.exit(1);
  }
  console.log('phase-23 escalation-ladder defaults + migrator: OK');

  // phase-57 (schema 14) — run_events append-only timeline retention default
  if (cfg.cleanup?.run_events_retention_days !== 90) {
    console.error(`FAIL: cleanup.run_events_retention_days must default to 90, got ${JSON.stringify(cfg.cleanup?.run_events_retention_days)}`);
    process.exit(1);
  }
  // Migrator backfills the key into a cleanup override that predates v14
  // (idempotent — a second pass over an already-backfilled config leaves an
  // explicit override unchanged).
  const legacyCleanup = migrateResolvedConfig({ cleanup: { enabled: true } });
  if (legacyCleanup.cleanup.run_events_retention_days !== 90) {
    console.error('FAIL: config-migrator must backfill cleanup.run_events_retention_days into a pre-v14 cleanup override');
    process.exit(1);
  }
  const twiceCleanup = migrateResolvedConfig(migrateResolvedConfig({ cleanup: { run_events_retention_days: 0 } }));
  if (twiceCleanup.cleanup.run_events_retention_days !== 0) {
    console.error('FAIL: config-migrator v13→v14 must be idempotent (must not clobber an explicit 0)');
    process.exit(1);
  }
  console.log('phase-57 cleanup.run_events_retention_days default + migrator: OK');

  // phase-65 (schema 15) — Execution DAG P1 inert scaffolding defaults
  if (cfg.auto_run?.max_parallel_phases !== 1 || cfg.auto_run?.speculative_duo_on_double_failure !== false) {
    console.error(`FAIL: auto_run.max_parallel_phases/speculative_duo_on_double_failure must default to 1/false, got ${JSON.stringify({ max_parallel_phases: cfg.auto_run?.max_parallel_phases, speculative_duo_on_double_failure: cfg.auto_run?.speculative_duo_on_double_failure })}`);
    process.exit(1);
  }
  if (cfg.bug_cycle?.max_parallel_fixes !== 1 || cfg.bug_cycle?.batch_minor_fixes !== false || cfg.bug_cycle?.batch_max !== 4) {
    console.error(`FAIL: bug_cycle.max_parallel_fixes/batch_minor_fixes/batch_max must default to 1/false/4, got ${JSON.stringify(cfg.bug_cycle)}`);
    process.exit(1);
  }
  if (cfg.parallel_lanes?.dir !== '.worktrees' || cfg.parallel_lanes?.node_modules !== 'symlink') {
    console.error(`FAIL: parallel_lanes must default to {dir:'.worktrees', node_modules:'symlink'}, got ${JSON.stringify(cfg.parallel_lanes)}`);
    process.exit(1);
  }
  // Migrator backfills all three surfaces into wholesale overrides that predate
  // v15 (idempotent — a second pass over an already-backfilled config leaves an
  // explicit override unchanged).
  const legacyLanes = migrateResolvedConfig({ auto_run: { max_phases_per_run: 9999 }, bug_cycle: { max_fixes_per_round: 30 }, parallel_lanes: { dir: '.custom' } });
  if (legacyLanes.auto_run.max_parallel_phases !== 1 || legacyLanes.bug_cycle.max_parallel_fixes !== 1 || legacyLanes.parallel_lanes.node_modules !== 'symlink') {
    console.error('FAIL: config-migrator must backfill phase-65 keys into pre-v15 auto_run/bug_cycle/parallel_lanes overrides');
    process.exit(1);
  }
  if (legacyLanes.parallel_lanes.dir !== '.custom') {
    console.error('FAIL: config-migrator v14→v15 must not clobber an explicit parallel_lanes.dir');
    process.exit(1);
  }
  const twiceLanes = migrateResolvedConfig(migrateResolvedConfig({ auto_run: { max_parallel_phases: 4 } }));
  if (twiceLanes.auto_run.max_parallel_phases !== 4) {
    console.error('FAIL: config-migrator v14→v15 must be idempotent (must not clobber an explicit max_parallel_phases)');
    process.exit(1);
  }
  console.log('phase-65 auto_run/bug_cycle/parallel_lanes defaults + migrator: OK');

  // phase-30 — verify.include_fixes is three-valued, default 'major+'
  if (cfg.verify?.include_fixes !== 'major+') {
    console.error(`FAIL: verify.include_fixes must default to 'major+', got ${JSON.stringify(cfg.verify?.include_fixes)}`);
    process.exit(1);
  }
  // Legacy boolean overrides (a project/user layer still carrying the old
  // true/false shape) must resolve with their old semantics exactly — plain
  // deepMerge overwrite, no migration needed.
  const legacyFalseOverride = deepMerge(cfg, { verify: { include_fixes: false } });
  if (legacyFalseOverride.verify.include_fixes !== false) {
    console.error('FAIL: a legacy `include_fixes: false` override must resolve to false (old semantics), not be coerced');
    process.exit(1);
  }
  const legacyTrueOverride = deepMerge(cfg, { verify: { include_fixes: true } });
  if (legacyTrueOverride.verify.include_fixes !== true) {
    console.error('FAIL: a legacy `include_fixes: true` override must resolve to true (old semantics), not be coerced');
    process.exit(1);
  }
  console.log('phase-30 verify.include_fixes three-value default + legacy boolean overrides: OK');

  // phase-33 (schema 8) — zero-candidate scans skip adjudication, default on
  if (cfg.audit?.skip_adjudication_when_clean !== true) {
    console.error(`FAIL: audit.skip_adjudication_when_clean must default to true, got ${JSON.stringify(cfg.audit?.skip_adjudication_when_clean)}`);
    process.exit(1);
  }
  // Migrator backfills the flag into a wholesale audit override that predates
  // v8 (idempotent — a second pass over an already-backfilled config leaves
  // an explicit false unchanged).
  const legacyAudit = migrateResolvedConfig({ audit: { two_stage: false } });
  if (legacyAudit.audit.skip_adjudication_when_clean !== true) {
    console.error('FAIL: config-migrator must backfill audit.skip_adjudication_when_clean into a pre-v8 audit override');
    process.exit(1);
  }
  const twiceAudit = migrateResolvedConfig(migrateResolvedConfig({ audit: { skip_adjudication_when_clean: false } }));
  if (twiceAudit.audit.skip_adjudication_when_clean !== false) {
    console.error('FAIL: config-migrator v7→v8 must be idempotent (must not clobber an explicit false)');
    process.exit(1);
  }
  console.log('phase-33 audit.skip_adjudication_when_clean default + migrator: OK');

  // phase-43 (schema 10) — bug-round convergence detection defaults
  if (cfg.auto_run.convergence?.enabled !== true || cfg.auto_run.convergence?.stall_min_recurring !== 2) {
    console.error(`FAIL: auto_run.convergence must default to {enabled:true, stall_min_recurring:2}, got ${JSON.stringify(cfg.auto_run.convergence)}`);
    process.exit(1);
  }
  // Migrator backfills the whole block into a wholesale auto_run override that
  // predates v10 (idempotent — a second pass over an already-backfilled config
  // leaves an explicit override unchanged).
  const legacyConvergence = migrateResolvedConfig({ auto_run: { max_phases_per_run: 9999 } });
  if (legacyConvergence.auto_run.convergence?.enabled !== true) {
    console.error('FAIL: config-migrator must backfill auto_run.convergence into a pre-v10 auto_run override');
    process.exit(1);
  }
  const twiceConvergence = migrateResolvedConfig(migrateResolvedConfig({ auto_run: { convergence: { enabled: false, stall_min_recurring: 5 } } }));
  if (twiceConvergence.auto_run.convergence.enabled !== false || twiceConvergence.auto_run.convergence.stall_min_recurring !== 5) {
    console.error('FAIL: config-migrator v9→v10 must be idempotent (must not clobber an explicit convergence override)');
    process.exit(1);
  }
  console.log('phase-43 auto_run.convergence default + migrator: OK');

  // phase-44 (schema 11) — ship gate defaults present
  if (cfg.ship_gate?.enabled !== true || cfg.ship_gate?.audit_level !== 'high') {
    console.error(`FAIL: ship_gate must default to {enabled:true, audit_level:'high'}, got ${JSON.stringify(cfg.ship_gate)}`);
    process.exit(1);
  }
  if (!Array.isArray(cfg.ship_gate?.license_allowlist) || !cfg.ship_gate.license_allowlist.includes('MIT')) {
    console.error('FAIL: ship_gate.license_allowlist must be an array including MIT in defaults');
    process.exit(1);
  }
  // Migrator backfills the whole block into a wholesale override that predates
  // v11 (idempotent — a second pass over an already-backfilled config leaves an
  // explicit override unchanged).
  const legacyShipGate = migrateResolvedConfig({ ship_gate: { audit_level: 'critical' } });
  if (legacyShipGate.ship_gate.enabled !== true || !Array.isArray(legacyShipGate.ship_gate.license_allowlist)) {
    console.error('FAIL: config-migrator must backfill ship_gate.enabled/license_allowlist into a pre-v11 ship_gate override');
    process.exit(1);
  }
  if (legacyShipGate.ship_gate.audit_level !== 'critical') {
    console.error('FAIL: config-migrator v10→v11 must not clobber an explicit ship_gate.audit_level');
    process.exit(1);
  }
  const twiceShipGate = migrateResolvedConfig(migrateResolvedConfig({ ship_gate: { enabled: false } }));
  if (twiceShipGate.ship_gate.enabled !== false) {
    console.error('FAIL: config-migrator v10→v11 must be idempotent (must not clobber an explicit enabled:false)');
    process.exit(1);
  }
  console.log('phase-44 ship_gate default + migrator: OK');

  // phase-51 (schema 12) — verify.async_report defaults to true (advisory-only:
  // the one documented exception to "new keys default to prior behavior").
  if (cfg.verify?.async_report !== true) {
    console.error(`FAIL: verify.async_report must default to true, got ${JSON.stringify(cfg.verify?.async_report)}`);
    process.exit(1);
  }
  // Migrator backfills the key into a wholesale verify override that predates
  // v12 (idempotent — a second pass, and an explicit false, are both preserved).
  const legacyVerify = migrateResolvedConfig({ verify: { mode: 'report' } });
  if (legacyVerify.verify.async_report !== true) {
    console.error('FAIL: config-migrator must backfill verify.async_report:true into a pre-v12 verify override');
    process.exit(1);
  }
  if (legacyVerify.verify.mode !== 'report') {
    console.error('FAIL: config-migrator v11→v12 must not clobber a sibling verify key');
    process.exit(1);
  }
  const twiceVerify = migrateResolvedConfig(migrateResolvedConfig({ verify: { async_report: false } }));
  if (twiceVerify.verify.async_report !== false) {
    console.error('FAIL: config-migrator v11→v12 must be idempotent (must not clobber an explicit async_report:false)');
    process.exit(1);
  }
  console.log('phase-51 verify.async_report default + migrator: OK');

  // phase-81 (P4a) — test-first harness default OFF (no schema bump). The whole
  // hook is gated on this flag, so its default IS the back-compat guarantee.
  if (cfg.test_first?.enabled !== false) {
    console.error(`FAIL: test_first.enabled must default to false, got ${JSON.stringify(cfg.test_first?.enabled)}`);
    process.exit(1);
  }
  const testFirstOn = deepMerge(cfg, { test_first: { enabled: true } });
  if (testFirstOn.test_first.enabled !== true) {
    console.error('FAIL: a project override for test_first.enabled must resolve to true');
    process.exit(1);
  }
  console.log('phase-81 test_first default OFF + override: OK');

  // phase-85 (P7a) — portfolio autopilot core defaults (no schema bump). The
  // whole feature is gated on autopilot.enabled, so its default OFF IS the
  // back-compat guarantee; all keys are read in code with these exact fallbacks.
  if (cfg.autopilot?.enabled !== false) {
    console.error(`FAIL: autopilot.enabled must default to false, got ${JSON.stringify(cfg.autopilot?.enabled)}`);
    process.exit(1);
  }
  if (cfg.autopilot?.max_projects_per_night !== 3 || cfg.autopilot?.start_hour !== 1 || cfg.autopilot?.digest_hour !== 8) {
    console.error(`FAIL: autopilot must default to {start_hour:1, digest_hour:8, max_projects_per_night:3}, got ${JSON.stringify(cfg.autopilot)}`);
    process.exit(1);
  }
  if (!Array.isArray(cfg.autopilot?.priority_order)
      || cfg.autopilot.priority_order.join(',') !== 'resume,brief,bugs,audit,suggestions') {
    console.error(`FAIL: autopilot.priority_order must default to [resume,brief,bugs,audit,suggestions], got ${JSON.stringify(cfg.autopilot?.priority_order)}`);
    process.exit(1);
  }
  if (!Array.isArray(cfg.autopilot?.require_operator_approval_for)
      || cfg.autopilot.require_operator_approval_for.join(',') !== 'brief') {
    console.error(`FAIL: autopilot.require_operator_approval_for must default to ['brief'], got ${JSON.stringify(cfg.autopilot?.require_operator_approval_for)}`);
    process.exit(1);
  }
  const autopilotOn = deepMerge(cfg, { autopilot: { enabled: true } });
  if (autopilotOn.autopilot.enabled !== true || autopilotOn.autopilot.max_projects_per_night !== 3) {
    console.error('FAIL: a project override for autopilot.enabled must resolve to true and preserve sibling keys');
    process.exit(1);
  }
  console.log('phase-85 autopilot default OFF + defaults + override: OK');
  console.log('OK');
}

if (process.argv[1] && process.argv[1].endsWith('config-resolver.js') && process.argv.includes('--selftest')) {
  selftest().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
