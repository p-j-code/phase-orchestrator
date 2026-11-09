// Model Router — picks the right model for each Claude call based on:
//   1. Task-type baseline (from defaults.models)
//   2. Project / profile / phase overrides (already merged in cfg)
//   3. Keyword rules (config/model-routing.json)
//   4. Complexity thresholds (max_turns, criteria count, files count)
//   5. Hard floors and tier caps
//
// Returns { model, tier, complexity, reasoning: [...] } so the auto-runner
// can surface decisions to the user.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ROUTING_CONFIG_PATH = path.join(REPO_ROOT, 'config', 'model-routing.json');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

// v0.17 (MI-1): 4-rung ladder. 'fable' (claude-fable-5) sits above opus and is
// reserved for the calls where a single top-tier judgment replaces a human
// pause or a multi-round opus bug cycle (force_tier keyword rules for
// regulatory/security-core phases). Note: fable can return a refusal
// stop_reason on security-adjacent content — see docs/ARCHITECTURE.md for the
// fallback guidance.
export const TIER_ORDER = ['haiku', 'sonnet', 'opus', 'fable'];

let _rulesCache = null;
let _rulesCacheMtimeMs = null;
async function loadRules() {
  // mtime-checked cache: a one-shot CLI never re-reads, but the 24/7 pm2
  // worker/web-ui on the NAS used to hold the first parse forever — edits to
  // config/model-routing.json were invisible until a process restart.
  let mtimeMs = null;
  try { mtimeMs = (await fs.stat(ROUTING_CONFIG_PATH)).mtimeMs; } catch { /* absent file → defaults */ }
  if (_rulesCache && mtimeMs === _rulesCacheMtimeMs) return _rulesCache;
  try {
    _rulesCache = JSON.parse(await fs.readFile(ROUTING_CONFIG_PATH, 'utf-8'));
  } catch {
    _rulesCache = { keyword_rules: [], hard_floors: {}, complexity_thresholds: {}, tier_caps: {}, user_preferences: {} };
  }
  _rulesCacheMtimeMs = mtimeMs;
  return _rulesCache;
}

async function loadProjectRoutingExtension(projectName) {
  if (!projectName) return null;
  const extPath = path.join(PROJECTS_DIR, projectName, 'routing-extension.json');
  try {
    return JSON.parse(await fs.readFile(extPath, 'utf-8'));
  } catch {
    return null;
  }
}

export function tierIndex(t) { return TIER_ORDER.indexOf(t); }
export function maxTier(a, b) { return tierIndex(a) >= tierIndex(b) ? a : b; }
export function minTier(a, b) { return tierIndex(a) <= tierIndex(b) ? a : b; }

// Exported (v0.17): claude-runner.js's resolveMaxTurns derives the tier for
// its per-tier turn-cap map (phases.max_turns_per_tier) from the model id.
export function modelToTier(model, tierModels) {
  for (const [tier, m] of Object.entries(tierModels || {})) {
    if (model === m) return tier;
  }
  // Heuristic fallback
  if (/fable/i.test(model)) return 'fable';
  if (/opus/i.test(model)) return 'opus';
  if (/sonnet/i.test(model)) return 'sonnet';
  if (/haiku/i.test(model)) return 'haiku';
  return 'sonnet';
}

function tierToModel(tier, tierModels) {
  return tierModels[tier] || tier;
}

/**
 * Score complexity from phase/task metadata.
 * Returns: 'low' | 'medium' | 'high' | 'critical'
 */
function scoreComplexity(ctx, thresholds) {
  const t = thresholds || {};
  let signals = 0;
  let critSignals = 0;

  if (ctx.max_turns) {
    if (ctx.max_turns >= (t.max_turns_critical || 90)) critSignals += 1;
    else if (ctx.max_turns >= (t.max_turns_high || 60)) signals += 1;
  }
  if (ctx.acceptance_criteria_count) {
    if (ctx.acceptance_criteria_count >= (t.acceptance_criteria_critical || 10)) critSignals += 1;
    else if (ctx.acceptance_criteria_count >= (t.acceptance_criteria_high || 6)) signals += 1;
  }
  if (ctx.files_count) {
    if (ctx.files_count >= (t.files_expected_critical || 15)) critSignals += 1;
    else if (ctx.files_count >= (t.files_expected_high || 8)) signals += 1;
  }
  if (ctx.keyword_hits_critical) critSignals += ctx.keyword_hits_critical;
  if (ctx.keyword_hits_high) signals += ctx.keyword_hits_high;

  if (critSignals >= 1) return 'critical';
  if (signals >= 2) return 'high';
  if (signals >= 1) return 'medium';
  return 'low';
}

/**
 * v0.17 (size-gated opus floors): resolve a hard_floors entry into a decision.
 * Two config shapes are accepted:
 *   - plain tier string ("opus") — legacy, applies unconditionally;
 *   - { tier, when: { min_brief_chars, min_brief_frs, min_planned_phases,
 *     min_candidates } } — the floor applies only when at least ONE condition
 *     is met by the caller-supplied size signals ("any-of": each signal is an
 *     independent reason the work is big enough to earn the floor tier).
 *
 * `when` keys map to sizeMeta keys by stripping the `min_` prefix
 * (min_brief_chars → sizeMeta.brief_chars). A condition whose signal is
 * absent from sizeMeta counts as unmet (size can't be demonstrated). When the
 * caller supplied NO sizeMeta at all, the floor applies unconditionally —
 * fail-safe to the pre-v0.17 behavior so call sites that don't thread size
 * signals (or older code paths) never silently demote quality.
 *
 * Returns null (no floor configured / malformed entry) or
 * { applies: boolean, tier, detail } where detail is a human-readable
 * explanation for the routing reasoning log.
 */
export function resolveHardFloor(floor, sizeMeta = null) {
  if (!floor) return null;
  if (typeof floor === 'string') return { applies: true, tier: floor, detail: null };
  if (typeof floor !== 'object' || typeof floor.tier !== 'string') return null;
  const conditions = (floor.when && typeof floor.when === 'object') ? Object.entries(floor.when) : [];
  if (!conditions.length) return { applies: true, tier: floor.tier, detail: null };
  if (!sizeMeta) {
    return { applies: true, tier: floor.tier, detail: 'no size signals available — conditional floor applied (fail-safe)' };
  }
  const checks = [];
  let met = false;
  for (const [key, threshold] of conditions) {
    const signal = key.replace(/^min_/, '');
    const value = sizeMeta[signal];
    if (typeof value === 'number' && Number.isFinite(threshold) && value >= threshold) {
      met = true;
      checks.push(`${signal} ${value} ≥ ${threshold}`);
    } else {
      checks.push(`${signal} ${typeof value === 'number' ? value : '?'} < ${threshold}`);
    }
  }
  return { applies: met, tier: floor.tier, detail: checks.join(', ') };
}

/**
 * Match keyword rules against searchable text. Returns rules that matched.
 * A rule matches via `match` (case-insensitive substrings) and/or `patterns`
 * (case-insensitive regex source strings). `patterns` support exists because
 * project routing extensions were authored with it (billflow-tds) and
 * silently never fired — every rule, including a regulatory force_tier, was
 * a no-op with no warning. Invalid regexes warn once and are skipped rather
 * than killing the whole rule set.
 */
function matchKeywordRules(text, rules) {
  if (!text || !rules) return [];
  const lc = text.toLowerCase();
  return rules.filter((r) => {
    if ((r.match || []).some((kw) => lc.includes(kw.toLowerCase()))) return true;
    return (r.patterns || []).some((src) => {
      try {
        return new RegExp(src, 'i').test(text);
      } catch (err) {
        console.warn(`[model-router] invalid regex in keyword rule '${r.label || '?'}': ${src} (${err.message}) — pattern skipped`);
        return false;
      }
    });
  });
}

/**
 * Main entry point. Resolve the model for a given call.
 *
 * @param {Object} args
 * @param {Object} args.cfg - resolved config (includes models map, model_routing)
 * @param {string} args.task - task id (e.g. 'dev-execution', 'plan-creation')
 * @param {Object} [args.phaseMeta] - phase data from plan.json (title, goal, notes, acceptance_criteria, files_expected, max_turns_override)
 * @param {Object} [args.sizeMeta] - size signals for conditional hard floors
 *   (v0.17, size-gated opus floors): { brief_chars, brief_frs,
 *   planned_phases, candidates }. Callers that don't compute them pass
 *   nothing — conditional floors then apply unconditionally (fail-safe).
 * @returns {Promise<{model:string,tier:string,complexity:string,reasoning:string[]}>}
 */
export async function routeModel({ cfg, task, phaseMeta = null, projectName = null, sizeMeta = null }) {
  const routing = cfg.model_routing || {};
  if (routing.enabled === false) {
    // Routing disabled — just return the static model from cfg.models
    let model = cfg.models?.[task];
    const reasoning = [];
    // Fallback: task key absent from cfg.models. This fires when routeModel is
    // called with a cfg built without resolve(), or (rarely) as a second-line
    // defense after resolve()'s own fallback. resolve() now also degrades
    // gracefully for missing keys, so this path is mostly a belt-and-suspenders guard.
    if (!model) {
      model = cfg.models?.['dev-execution'] ?? 'claude-sonnet-4-6';
      console.warn(chalk.yellow(`  ⚠ No model configured for task '${task}' — falling back to ${model}`));
      reasoning.push(`no models.${task} — fell back to ${model}`);
    }
    reasoning.push(`model_routing disabled — using static models.${task} = ${model}`);
    return {
      model,
      tier: modelToTier(model, routing.tier_models || {}),
      complexity: 'unknown',
      reasoning,
    };
  }

  const rules = await loadRules();
  const extension = await loadProjectRoutingExtension(projectName);
  const effectiveKeywordRules = [
    ...(rules.keyword_rules || []),
    ...((extension && extension.keyword_rules) || []),
  ];
  const tierModels = routing.tier_models || { sonnet: 'claude-sonnet-4-6', opus: 'claude-opus-4-8' };

  const reasoning = [];

  // Step 1: baseline from defaults.models (already merged via cfg).
  // resolve() degrades gracefully for unknown tasks; this fallback is a
  // belt-and-suspenders guard for callers that bypass resolve().
  let baselineModel = cfg.models?.[task];
  if (!baselineModel) {
    // Task key entirely absent from cfg.models — fall back gracefully
    baselineModel = cfg.models?.['dev-execution'] ?? 'claude-sonnet-4-6';
    console.warn(chalk.yellow(`  ⚠ No model configured for task '${task}' — falling back to ${baselineModel}`));
    reasoning.push(`no models.${task} — fell back to ${baselineModel}`);
  }
  let tier = modelToTier(baselineModel, tierModels);
  reasoning.push(`baseline (defaults.models.${task}) → ${tier}`);

  // Step 6.6 (learned caps) may only lower a tier that NOTHING pinned: a phase
  // model_override, a keyword force/floor, prefer_top_for_critical, a hard
  // floor, or a learned floor each set this flag, and a set flag makes the
  // learned cap a no-op — a demotion must never undercut an explicit or
  // learned escalation (e.g. clamp an escalation-retry override back down).
  let tierPinned = false;

  // Step 2: phase model_override already merged via cfg.model — respect it as starting point
  if (cfg.model && cfg.model !== baselineModel) {
    const overrideTier = modelToTier(cfg.model, tierModels);
    tier = overrideTier;
    tierPinned = true;
    reasoning.push(`phase model_override → ${tier}`);
  }

  // Step 3+4 gate (v0.14.37): keyword and complexity escalation apply ONLY to
  // tasks that EXECUTE the phase. runGuide passes the project's NEXT phase
  // meta into routing for every guide task, so before this gate a project
  // sitting in front of an "FVU generator" phase had its prompt-gens, reviews,
  // and bug-plans force_tier'd to opus by the phase's TITLE — $280/mo of
  // misrouting per the 30d /spend report (phase-prompt-gen·opus 73×,
  // 3-phase-review·opus 43×, bug-plan·opus 111×). Overhead tasks now route on
  // baselines + floors alone. Override the allowlist via
  // model_routing.escalation_tasks.
  const escalationTasks = rules.escalation_tasks || ['dev-execution', 'fix-execution'];
  const escalationApplies = escalationTasks.includes(task);

  // Step 3: keyword rules (execution tasks only)
  const searchText = (escalationApplies && phaseMeta)
    ? [phaseMeta.title, phaseMeta.goal, phaseMeta.notes, ...(phaseMeta.acceptance_criteria || [])].filter(Boolean).join(' ')
    : '';
  if (!escalationApplies && phaseMeta) {
    reasoning.push(`task '${task}' not in escalation_tasks → keyword/complexity escalation skipped (phase meta ignored)`);
  }
  const matchedRules = matchKeywordRules(searchText, effectiveKeywordRules);
  let keywordHitsHigh = 0;
  let keywordHitsCritical = 0;

  // Explicit precedence pass — rules no longer apply in raw array order.
  // Array position must never decide the outcome: whichever rule happened to
  // sit last in config/model-routing.json's keyword_rules used to win by
  // default (e.g. low-stakes-ui's max_tier cap beat a min_tier domain floor
  // purely because it was declared later), with no way to reason about which
  // rule "should" win when a phase matches more than one. The documented
  // precedence is now: force_tier > max_tier cap > min_tier floor >
  // complexity escalation (Step 4/5 below, unchanged).
  const forceMatches = matchedRules.filter((r) => r.force_tier);
  const maxMatches = matchedRules.filter((r) => r.max_tier);
  const minMatches = matchedRules.filter((r) => r.min_tier);

  if (forceMatches.length) {
    // (1) force_tier always wins outright, full stop — highest tier among
    // force matches — and max_tier/min_tier are not consulted at all.
    let winner = forceMatches[0];
    for (const r of forceMatches) {
      if (tierIndex(r.force_tier) > tierIndex(winner.force_tier)) winner = r;
    }
    const before = tier;
    tier = winner.force_tier;
    tierPinned = true;
    const others = forceMatches.length > 1 ? ` (beat ${forceMatches.length - 1} other force_tier match(es))` : '';
    reasoning.push(`keyword [${winner.label}] force_tier ${winner.force_tier} wins outright${others} → ${tier}${before !== tier ? '' : ' (no change)'}`);
    for (const r of forceMatches) {
      // opus-or-above force rules (fable included) count as critical signals.
      if (tierIndex(r.force_tier) >= tierIndex('opus')) keywordHitsCritical += 1;
      else keywordHitsHigh += 1;
    }
  } else {
    // (2) max_tier caps: take the most restrictive (lowest) cap among matches.
    let capRule = null;
    for (const r of maxMatches) {
      if (!capRule || tierIndex(r.max_tier) < tierIndex(capRule.max_tier)) capRule = r;
    }

    // (3) min_tier floors: take the highest floor among matches.
    let floorRule = null;
    for (const r of minMatches) {
      if (!floorRule || tierIndex(r.min_tier) > tierIndex(floorRule.min_tier)) floorRule = r;
      keywordHitsHigh += 1;
    }

    if (floorRule) {
      // A matched domain floor pins the tier even when "already met" — the
      // phase demonstrably touches the floor's domain, so a learned cap must
      // not undercut it later.
      tierPinned = true;
      const raised = maxTier(tier, floorRule.min_tier);
      if (raised !== tier) {
        tier = raised;
        reasoning.push(`keyword [${floorRule.label}] min_tier ${floorRule.min_tier} → raised to ${tier}`);
      } else {
        reasoning.push(`keyword [${floorRule.label}] min_tier ${floorRule.min_tier} (already met)`);
      }
    }

    // Cap always wins over floor when both match — re-apply the cap AFTER
    // the floor so a floor can never leave the tier above the cap.
    if (capRule) {
      const before = tier;
      const capped = minTier(tier, capRule.max_tier);
      if (capped !== tier) {
        tier = capped;
        reasoning.push(`keyword [${capRule.label}] max_tier ${capRule.max_tier} caps over any min_tier floor → ${tier} (deciding factor)`);
      } else {
        reasoning.push(`keyword [${capRule.label}] max_tier ${capRule.max_tier} (cap enforced, already at or below ${before})`);
      }
    }
  }

  // Step 4: complexity scoring (phase-derived signals only for execution tasks)
  const complexityCtx = {
    max_turns: escalationApplies ? (phaseMeta?.max_turns_override || phaseMeta?.max_turns) : undefined,
    acceptance_criteria_count: escalationApplies ? (phaseMeta?.acceptance_criteria || []).length : 0,
    files_count: escalationApplies ? (phaseMeta?.files_expected || []).length : 0,
    keyword_hits_high: keywordHitsHigh,
    keyword_hits_critical: keywordHitsCritical,
  };
  const complexity = scoreComplexity(complexityCtx, rules.complexity_thresholds);
  reasoning.push(`complexity = ${complexity} (signals: turns=${complexityCtx.max_turns || '-'}, criteria=${complexityCtx.acceptance_criteria_count}, files=${complexityCtx.files_count}, kw-hi=${keywordHitsHigh}, kw-crit=${keywordHitsCritical})`);

  // Step 5: prefer_top_for_critical
  if (complexity === 'critical' && rules.user_preferences?.prefer_top_for_critical) {
    tierPinned = true;
    if (tier !== 'opus') {
      tier = 'opus';
      reasoning.push(`critical complexity + prefer_top_for_critical → opus`);
    }
  }

  // Step 6: hard floors. v0.17 (size-gated opus floors): entries may be
  // conditional {tier, when} objects — see resolveHardFloor above. Plain
  // string floors keep the pre-v0.17 unconditional behavior.
  const floorDecision = resolveHardFloor(rules.hard_floors?.[task], sizeMeta);
  if (floorDecision?.applies) {
    tierPinned = true;
    const raised = maxTier(tier, floorDecision.tier);
    const detail = floorDecision.detail ? ` (${floorDecision.detail})` : '';
    if (raised !== tier) {
      tier = raised;
      reasoning.push(`hard floor for ${task}: ${floorDecision.tier}${detail} → raised to ${tier}`);
    } else if (floorDecision.detail) {
      reasoning.push(`hard floor for ${task}: ${floorDecision.tier}${detail} (already met)`);
    }
  } else if (floorDecision) {
    reasoning.push(`hard floor for ${task}: ${floorDecision.tier} SKIPPED — size gate unmet (${floorDecision.detail})`);
  }

  // Step 6.5 (phase-56, MI-5): telemetry-learned floors from the project's
  // routing-extension.json (auto-runner's preflight rewrites task_floors from
  // recorded calls-table outcomes — see src/lib/routing-telemetry.js). Applied
  // as a floor via maxTier, alongside the hard floors above, for the ROUTED
  // task ONLY — a floor recorded for a DIFFERENT task is never consulted here
  // (we key on `task`). The escalation_tasks gate and keyword rules are
  // untouched. An unknown/invalid tier is ignored with a reasoning note naming
  // the source file so a hand-corrupted extension degrades loudly, not silently.
  const learnedFloor = extension?.task_floors?.[task];
  if (learnedFloor != null) {
    const source = `projects/${projectName}/routing-extension.json`;
    if (typeof learnedFloor === 'string' && TIER_ORDER.includes(learnedFloor)) {
      tierPinned = true;
      const raised = maxTier(tier, learnedFloor);
      if (raised !== tier) {
        tier = raised;
        reasoning.push(`learned floor for ${task}: ${learnedFloor} (telemetry, ${source}) → raised to ${tier}`);
      } else {
        reasoning.push(`learned floor for ${task}: ${learnedFloor} (telemetry, ${source}) (already met)`);
      }
    } else {
      reasoning.push(`learned floor for ${task}: '${learnedFloor}' is not a known tier — ignored (source: ${source})`);
    }
  }

  // Step 6.6 (2026-07-12, window economy): telemetry-learned CAPS — the
  // demotion mirror of Step 6.5. Written by the same auto-runner preflight
  // (src/lib/routing-telemetry.js's demote pass) into routing-extension.json's
  // task_caps. Deliberately the weakest signal in the pipeline: it applies
  // ONLY when nothing pinned the tier (no phase override, keyword match, hard
  // floor, or learned floor — see tierPinned) AND, for escalation tasks, only
  // at LOW complexity. One capability failure at the capped tier removes the
  // cap on the next preflight (fail-fast undo in routing-telemetry.js), so a
  // bad demotion costs at most one phase attempt, never a project.
  const learnedCap = extension?.task_caps?.[task];
  if (learnedCap != null) {
    const source = `projects/${projectName}/routing-extension.json`;
    if (typeof learnedCap !== 'string' || !TIER_ORDER.includes(learnedCap)) {
      reasoning.push(`learned cap for ${task}: '${learnedCap}' is not a known tier — ignored (source: ${source})`);
    } else if (tierPinned) {
      reasoning.push(`learned cap for ${task}: ${learnedCap} SKIPPED — tier pinned by override/keyword/floor`);
    } else if (escalationApplies && complexity !== 'low') {
      reasoning.push(`learned cap for ${task}: ${learnedCap} SKIPPED — complexity ${complexity} (caps apply at low only)`);
    } else {
      const capped = minTier(tier, learnedCap);
      if (capped !== tier) {
        tier = capped;
        reasoning.push(`learned cap for ${task}: ${learnedCap} (telemetry, ${source}) → lowered to ${tier}`);
      } else {
        reasoning.push(`learned cap for ${task}: ${learnedCap} (telemetry, ${source}) (already at or below)`);
      }
    }
  }

  // Step 7 (v0.14.35 → v0.15 reinstated): haiku was previously unreachable
  // because tier_models had no 'haiku' entry, so tierToModel() fell through
  // to its `tierModels[tier] || tier` fallback and returned the literal
  // string 'haiku' as a bogus model id. config/defaults.json now wires
  // tier_models.haiku → claude-haiku-4-5, so haiku is a real, resolvable
  // tier for the mechanical overhead tasks (triage, suggest-scan, etc). Only
  // clamp to sonnet if a caller's tierModels genuinely lacks a haiku entry
  // (a stripped-down test cfg, a legacy project routing-extension) — that
  // guards the same bogus-model-id bug without re-blocking haiku globally.
  if (tier === 'haiku' && !tierModels.haiku) {
    tier = 'sonnet';
    reasoning.push(`haiku tier requested but tier_models.haiku not configured → clamped to sonnet`);
  }

  // Same bogus-model-id guard for the v0.17 fable rung: a caller whose
  // tierModels predates the 4-tier ladder (stripped test cfg, legacy project
  // routing-extension, a project override that clobbered tier_models
  // wholesale) must not leak the literal string 'fable' as a model id —
  // clamp to opus, the previous top tier.
  if (tier === 'fable' && !tierModels.fable) {
    tier = 'opus';
    reasoning.push(`fable tier requested but tier_models.fable not configured → clamped to opus`);
  }

  const model = tierToModel(tier, tierModels);
  return { model, tier, complexity, reasoning };
}

/**
 * For the `analyze` command — produce routing decisions for every phase in
 * the plan, without making any Claude calls.
 */
export async function analyzeProject({ cfg, plan }) {
  const rows = [];
  for (const phase of plan.phases || []) {
    const phaseCfg = { ...cfg };
    // Apply phase model_override to cfg.model just like phase-runner would
    if (phase.model_override) phaseCfg.model = phase.model_override;
    const routing = await routeModel({ cfg: phaseCfg, task: 'dev-execution', phaseMeta: phase });
    rows.push({
      n: phase.n,
      title: phase.title,
      complexity: routing.complexity,
      tier: routing.tier,
      model: routing.model,
      reasoning: routing.reasoning,
      override: !!phase.model_override,
    });
  }
  return rows;
}
