// Tests for model-router routing-disabled fallback path and regression guard
// Run with: node src/model-router.test.mjs

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeModel, tierIndex, maxTier, minTier, TIER_ORDER, modelToTier, resolveHardFloor } from './model-router.js';
import {
  nextTier, parseEscalationTarget, writeEscalationMarker, resolveEscalation,
  escalationMarkerPath, legacyEscalationMarkerPath,
} from './lib/escalation.js';
import { resolve } from './config-resolver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;

function assert(condition, description) {
  if (condition) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${description}`);
    failed++;
  }
}

// ─── Disabled-path — routing.enabled === false ────────────────────────────────
console.log('\nDisabled-path — routing.enabled === false:');

// A. Known task key present in cfg.models → returns that exact model (unchanged behaviour)
{
  const cfg = {
    model_routing: { enabled: false },
    models: { 'dev-execution': 'claude-sonnet-4-6', 'plan-creation': 'claude-opus-4-7' },
  };
  const result = await routeModel({ cfg, task: 'plan-creation' });
  assert(result.model === 'claude-opus-4-7', 'A: known task key → returns exact model from cfg.models');
  assert(result.complexity === 'unknown', 'A: complexity is unknown');
  assert(typeof result.tier === 'string' && result.tier.length > 0, 'A: tier is a non-empty string');
  assert(Array.isArray(result.reasoning) && result.reasoning.length >= 1, 'A: reasoning is array with at least one entry');
}

// B. Task key absent, cfg.models['dev-execution'] present → returns dev-execution model
{
  const cfg = {
    model_routing: { enabled: false },
    models: { 'dev-execution': 'claude-sonnet-4-6' },
  };
  const origWarn = console.warn;
  console.warn = () => {};
  const result = await routeModel({ cfg, task: 'unknown-task-xyz' });
  console.warn = origWarn;
  assert(result.model === 'claude-sonnet-4-6', 'B: absent task key → falls back to dev-execution model');
  assert(typeof result.model === 'string' && result.model.length > 0, 'B: model is a non-empty string (not undefined/null)');
  assert(result.reasoning.some(r => /fell back to/.test(r)), 'B: reasoning contains fallback note');
}

// C. Task key absent, cfg.models['dev-execution'] also absent → returns 'claude-sonnet-4-6'
{
  const cfg = {
    model_routing: { enabled: false },
    models: {},
  };
  const origWarn = console.warn;
  console.warn = () => {};
  const result = await routeModel({ cfg, task: 'unknown-task-xyz' });
  console.warn = origWarn;
  assert(result.model === 'claude-sonnet-4-6', 'C: absent task + absent dev-execution → returns claude-sonnet-4-6');
  assert(result.reasoning.some(r => /fell back to/.test(r)), 'C: reasoning contains fallback note');
}

// ─── Enabled-path regression guard ───────────────────────────────────────────
console.log('\nEnabled-path — routing.enabled unset (default):');

// D. Task key absent in cfg.models (enabled path) → still returns a non-undefined model
{
  const cfg = {
    model_routing: { enabled: true },
    models: { 'dev-execution': 'claude-sonnet-4-6' },
  };
  const origWarn = console.warn;
  console.warn = () => {};
  const result = await routeModel({ cfg, task: 'unknown-task-xyz' });
  console.warn = origWarn;
  assert(typeof result.model === 'string' && result.model.length > 0, 'D: enabled-path absent task → non-empty model string (regression guard)');
}

// ─── E — resolve() absent-task fallback ──────────────────────────────────────
console.log('\nresolve() absent-task fallback:');

// E1 — resolve() with an absent task key does NOT throw
{
  const origWarn = console.warn;
  console.warn = () => {};
  let cfg;
  try {
    cfg = await resolve({ task: 'a-task-that-does-not-exist-xyz' });
  } finally {
    console.warn = origWarn;
  }
  assert(cfg !== undefined && cfg !== null, 'E1: resolve() returns without throwing for absent task');
}

// E2 — the fallback model is the dev-execution model from defaults
{
  const origWarn = console.warn;
  console.warn = () => {};
  let cfg, cfgDev;
  try {
    cfg    = await resolve({ task: 'a-task-that-does-not-exist-xyz' });
    cfgDev = await resolve({ task: 'dev-execution' });
  } finally {
    console.warn = origWarn;
  }
  assert(typeof cfg.model === 'string' && cfg.model.length > 0, 'E2a: absent-task fallback returns a non-empty model string');
  assert(cfg.model === cfgDev.model, 'E2b: absent-task fallback model equals dev-execution model');
}

// E3 — resolve() with a PRESENT task key returns the exact configured model (regression guard)
{
  const cfg = await resolve({ task: 'dev-execution' });
  assert(typeof cfg.model === 'string' && cfg.model.length > 0, 'E3a: present key (dev-execution) → non-empty model string');
  const cfg2 = await resolve({ task: 'plan-creation' });
  assert(typeof cfg2.model === 'string' && cfg2.model.length > 0, 'E3b: present key (plan-creation) → non-empty model string');
}

// E4 — resolve() emits a warning (not silence) for an absent task
{
  let warnCalled = false;
  let warnMsg = '';
  const origWarn = console.warn;
  console.warn = (...args) => { warnCalled = true; warnMsg = args.join(' '); };
  try {
    await resolve({ task: 'a-task-that-does-not-exist-xyz' });
  } finally {
    console.warn = origWarn;
  }
  assert(warnCalled, 'E4a: resolve() calls console.warn for absent task');
  assert(warnMsg.includes('a-task-that-does-not-exist-xyz'), 'E4b: warning message includes the missing task name');
}

// ─── F — acceptance-check routing independence (phase-2) ─────────────────────
// docs/VERIFY_LOOP.md §4.2: acceptance-check is NOT in escalation_tasks and has
// no hard floor — it never inherits the phase's Opus escalation, even when the
// phase itself is complex/keyword-flagged and running on Opus.
console.log('\nacceptance-check routing independence:');

// F1 — config/model-routing.json itself must not list acceptance-check under
// escalation_tasks or hard_floors. A regression guard: if someone adds either
// entry, the checker would silently start escalating with the phase.
{
  const routingPath = path.join(__dirname, '..', 'config', 'model-routing.json');
  const routing = JSON.parse(await fs.readFile(routingPath, 'utf-8'));
  assert(!(routing.escalation_tasks || []).includes('acceptance-check'), 'F1a: acceptance-check absent from escalation_tasks');
  assert(!Object.prototype.hasOwnProperty.call(routing.hard_floors || {}, 'acceptance-check'), 'F1b: acceptance-check absent from hard_floors');
}

// F2 — routeModel(task: 'acceptance-check') ignores keyword/complexity escalation
// even when phaseMeta looks like a regulatory-core / high-complexity phase that
// would force dev-execution to opus.
{
  const cfg = {
    model_routing: { enabled: true, tier_models: { sonnet: 'claude-sonnet-5', opus: 'claude-opus-4-8' } },
    models: { 'acceptance-check': 'claude-sonnet-5', 'dev-execution': 'claude-sonnet-5' },
  };
  const escalatingPhaseMeta = {
    title: 'FVU file generator', // matches the regulatory-core force_tier:opus rule
    goal: 'NSDL FVU file generator for 26Q file format',
    acceptance_criteria: new Array(15).fill('criterion'), // complexity-critical by count
    files_expected: new Array(20).fill('file.js'),
    max_turns: 120,
  };
  const devResult = await routeModel({ cfg, task: 'dev-execution', phaseMeta: escalatingPhaseMeta });
  assert(devResult.tier === 'opus', 'F2 sanity: the same phaseMeta DOES escalate dev-execution to opus');

  const checkResult = await routeModel({ cfg, task: 'acceptance-check', phaseMeta: escalatingPhaseMeta });
  assert(checkResult.tier === 'sonnet', 'F2: acceptance-check stays on the sonnet baseline despite an opus-escalating phase');
  assert(checkResult.reasoning.some(r => /not in escalation_tasks/.test(r)), 'F2: reasoning records that escalation was skipped for acceptance-check');
}

// ─── G — Haiku overhead tier + keyword-rule precedence (phase 9) ─────────────
console.log('\nHaiku overhead tier + keyword-rule precedence:');

// G1 — tierIndex/maxTier/minTier resolve the 4-tier TIER_ORDER (v0.17 adds
// 'fable' above opus) without error for every pairwise combination.
{
  assert(TIER_ORDER.length === 4 && TIER_ORDER[0] === 'haiku' && TIER_ORDER[2] === 'opus' && TIER_ORDER[3] === 'fable',
    'G1: TIER_ORDER is the 4-tier [haiku, sonnet, opus, fable]');
  assert(tierIndex('haiku') === 0 && tierIndex('sonnet') === 1 && tierIndex('opus') === 2 && tierIndex('fable') === 3,
    'G1: tierIndex resolves all four tiers to their array position');
  assert(maxTier('opus', 'fable') === 'fable', 'G1: maxTier(opus, fable) → fable');
  assert(maxTier('fable', 'opus') === 'fable', 'G1: maxTier(fable, opus) → fable (order-independent)');
  assert(minTier('opus', 'fable') === 'opus', 'G1: minTier(opus, fable) → opus');
  assert(minTier('fable', 'haiku') === 'haiku', 'G1: minTier(fable, haiku) → haiku');
  assert(maxTier('haiku', 'sonnet') === 'sonnet', 'G1: maxTier(haiku, sonnet) → sonnet');
  assert(maxTier('sonnet', 'haiku') === 'sonnet', 'G1: maxTier(sonnet, haiku) → sonnet (order-independent)');
  assert(maxTier('sonnet', 'opus') === 'opus', 'G1: maxTier(sonnet, opus) → opus');
  assert(maxTier('opus', 'sonnet') === 'opus', 'G1: maxTier(opus, sonnet) → opus (order-independent)');
  assert(maxTier('haiku', 'opus') === 'opus', 'G1: maxTier(haiku, opus) → opus');
  assert(maxTier('opus', 'haiku') === 'opus', 'G1: maxTier(opus, haiku) → opus (order-independent)');
  assert(minTier('haiku', 'sonnet') === 'haiku', 'G1: minTier(haiku, sonnet) → haiku');
  assert(minTier('sonnet', 'opus') === 'sonnet', 'G1: minTier(sonnet, opus) → sonnet');
  assert(minTier('haiku', 'opus') === 'haiku', 'G1: minTier(haiku, opus) → haiku');
  assert(minTier('opus', 'haiku') === 'haiku', 'G1: minTier(opus, haiku) → haiku (order-independent)');
}

// G2 — with tier_models.haiku present, a task baselined on claude-haiku-4-5
// (e.g. triage) round-trips through modelToTier/tierToModel and resolves on
// claude-haiku-4-5, not a silent promotion to sonnet.
{
  const cfg = {
    model_routing: {
      enabled: true,
      tier_models: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-4-8' },
    },
    models: { triage: 'claude-haiku-4-5', 'dev-execution': 'claude-sonnet-5' },
  };
  const result = await routeModel({ cfg, task: 'triage' });
  assert(result.tier === 'haiku', 'G2: triage baseline resolves to haiku tier');
  assert(result.model === 'claude-haiku-4-5', 'G2: triage resolves to claude-haiku-4-5, not promoted to sonnet');
}

// G2b — regression guard: when a caller's tierModels genuinely lacks a haiku
// entry (legacy project routing-extension, stripped-down cfg), haiku still
// clamps to sonnet instead of leaking the literal string 'haiku' as a model id.
{
  const cfg = {
    model_routing: {
      enabled: true,
      tier_models: { sonnet: 'claude-sonnet-5', opus: 'claude-opus-4-8' }, // no haiku entry
    },
    models: { triage: 'claude-haiku-4-5', 'dev-execution': 'claude-sonnet-5' },
  };
  const result = await routeModel({ cfg, task: 'triage' });
  assert(result.tier === 'sonnet', 'G2b: no tier_models.haiku configured → clamped to sonnet');
  assert(result.model === 'claude-sonnet-5', 'G2b: clamped result resolves to a real model id, not the literal "haiku"');
  assert(result.reasoning.some((r) => /tier_models\.haiku not configured/.test(r)), 'G2b: reasoning explains the clamp');
}

// G3 — force_tier wins outright over a simultaneously-matched max_tier cap.
// Title matches regulatory-core (force_tier: opus) AND low-stakes-ui (max_tier: sonnet).
{
  const cfg = {
    model_routing: {
      enabled: true,
      tier_models: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-4-8' },
    },
    models: { 'dev-execution': 'claude-sonnet-5' },
  };
  const phaseMeta = {
    title: 'NSDL FVU generator with tooltip wording tweak',
    goal: 'Generate the FVU file and clean up a tooltip wording nit',
    acceptance_criteria: ['produces a valid FVU file'],
  };
  const result = await routeModel({ cfg, task: 'dev-execution', phaseMeta });
  assert(result.tier === 'opus', 'G3: force_tier (regulatory-core) wins over a simultaneously-matched max_tier cap (low-stakes-ui)');
  assert(result.model === 'claude-opus-4-8', 'G3: resolves to claude-opus-4-8');
  assert(result.reasoning.some((r) => /regulatory-core/.test(r) && /force_tier/.test(r)), 'G3: reasoning credits regulatory-core force_tier as the deciding rule');
}

// G4 — max_tier cap wins over a simultaneously-matched min_tier floor, even
// when the tier arriving into keyword matching is already opus (e.g. via a
// phase model_override) — the cap must pull it back down, not just fail to
// raise it. Title matches low-stakes-ui (max_tier: sonnet) AND
// regulatory-domain (min_tier: sonnet) via 'GST' + 'label copy'.
{
  const cfg = {
    model: 'claude-opus-4-8', // simulates an inbound phase model_override / prior escalation
    model_routing: {
      enabled: true,
      tier_models: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-4-8' },
    },
    models: { 'dev-execution': 'claude-sonnet-5' },
  };
  const phaseMeta = {
    title: 'Update GST label copy across the settings screen',
    goal: 'Tidy up label copy for GST-related fields',
    acceptance_criteria: ['label copy matches the new GST terminology'],
  };
  const result = await routeModel({ cfg, task: 'dev-execution', phaseMeta });
  assert(result.tier === 'sonnet', 'G4: max_tier cap (low-stakes-ui) wins over min_tier floor (regulatory-domain), not opus');
  assert(result.model === 'claude-sonnet-5', 'G4: resolves to claude-sonnet-5');
  assert(result.reasoning.some((r) => /low-stakes-ui/.test(r) && /deciding factor/.test(r)), 'G4: reasoning shows the cap rule as the deciding factor');
}

// G5 — resolveConfig-level: the five newly-retiered overhead tasks resolve to
// claude-haiku-4-5 via the plain config cascade (config/defaults.json), independent
// of model-router.js routing logic.
{
  const haikuTasks = ['triage', 'suggest-scan', 'requirement-refine', 'workspace-claude-md', 'project-context-gen'];
  for (const task of haikuTasks) {
    const cfg = await resolve({ task });
    assert(cfg.model === 'claude-haiku-4-5', `G5: resolve({ task: '${task}' }).model === claude-haiku-4-5`);
  }
  // lessons-distill was already Haiku as of phase 8 — confirm it's untouched.
  const lessonsCfg = await resolve({ task: 'lessons-distill' });
  assert(lessonsCfg.model === 'claude-haiku-4-5', 'G5: lessons-distill (phase 8) remains claude-haiku-4-5');
  // Spot-check tasks explicitly required to stay off Haiku.
  const devCfg = await resolve({ task: 'dev-execution' });
  assert(devCfg.model !== 'claude-haiku-4-5', 'G5: dev-execution is NOT moved to haiku');
  const acceptCfg = await resolve({ task: 'acceptance-check' });
  assert(acceptCfg.model !== 'claude-haiku-4-5', 'G5: acceptance-check is NOT moved to haiku');
}

// ─── H — fable tier reachability + clamp (v0.17, MI-1) ───────────────────────
console.log('\nFable tier reachability + clamp:');

// H1 — modelToTier: heuristic + exact tier_models mapping both resolve fable.
{
  assert(modelToTier('claude-fable-5', {}) === 'fable', 'H1: /fable/i heuristic maps claude-fable-5 → fable');
  assert(modelToTier('claude-fable-5', { fable: 'claude-fable-5' }) === 'fable', 'H1: exact tier_models entry maps to fable');
  assert(modelToTier('claude-opus-4-8', { fable: 'claude-fable-5' }) === 'opus', 'H1: opus id still resolves to opus with fable configured');
}

// H2 — a regulatory-core force_tier phase resolves to claude-fable-5 when the
// 4-tier tier_models is configured (the retuned config/model-routing.json rule).
{
  const cfg = {
    model_routing: {
      enabled: true,
      tier_models: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-4-8', fable: 'claude-fable-5' },
    },
    models: { 'dev-execution': 'claude-sonnet-5' },
  };
  const phaseMeta = {
    title: 'NSDL FVU generator',
    goal: 'Generate the FVU file for 26Q file format',
    acceptance_criteria: ['produces a valid FVU file'],
  };
  const result = await routeModel({ cfg, task: 'dev-execution', phaseMeta });
  assert(result.tier === 'fable', 'H2: regulatory-core force_tier resolves to the fable tier');
  assert(result.model === 'claude-fable-5', 'H2: resolves to claude-fable-5');
  assert(result.reasoning.some((r) => /regulatory-core/.test(r) && /force_tier fable/.test(r)), 'H2: reasoning credits the fable force_tier rule');
}

// H3 — bogus-model-id guard: tierModels lacking a fable entry (legacy project
// routing-extension / stripped cfg) clamps fable → opus instead of leaking the
// literal string 'fable' as a model id. (F2/G3 above also exercise this
// implicitly — their 3-tier cfgs hit the retuned fable force rules.)
{
  const cfg = {
    model_routing: {
      enabled: true,
      tier_models: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-4-8' }, // no fable entry
    },
    models: { 'dev-execution': 'claude-sonnet-5' },
  };
  const phaseMeta = {
    title: 'JWT signing key derivation', // security-core force_tier: fable
    goal: 'Implement key derivation for JWT signing',
    acceptance_criteria: ['keys derived correctly'],
  };
  const result = await routeModel({ cfg, task: 'dev-execution', phaseMeta });
  assert(result.tier === 'opus', 'H3: no tier_models.fable configured → clamped to opus');
  assert(result.model === 'claude-opus-4-8', 'H3: clamped result resolves to a real model id, not the literal "fable"');
  assert(result.reasoning.some((r) => /tier_models\.fable not configured/.test(r)), 'H3: reasoning explains the clamp');
}

// ─── I — size-gated conditional hard floors (v0.17) ──────────────────────────
console.log('\nSize-gated conditional hard floors:');

// I1 — resolveHardFloor pure-function contract.
{
  assert(resolveHardFloor(null) === null, 'I1: no floor configured → null');
  assert(resolveHardFloor('opus').applies === true && resolveHardFloor('opus').tier === 'opus',
    'I1: plain string floor applies unconditionally (legacy shape)');
  const gated = { tier: 'opus', when: { min_brief_chars: 12000, min_brief_frs: 8 } };
  const noMeta = resolveHardFloor(gated, null);
  assert(noMeta.applies === true && /fail-safe/.test(noMeta.detail), 'I1: conditional floor with NO sizeMeta applies (fail-safe)');
  const small = resolveHardFloor(gated, { brief_chars: 3000, brief_frs: 4 });
  assert(small.applies === false, 'I1: all size signals below thresholds → floor skipped');
  const oneMet = resolveHardFloor(gated, { brief_chars: 3000, brief_frs: 9 });
  assert(oneMet.applies === true, 'I1: any-of semantics — ONE met condition applies the floor');
  const missingSignal = resolveHardFloor(gated, { brief_chars: 3000 });
  assert(missingSignal.applies === false, 'I1: a signal absent from sizeMeta counts as unmet, not as met');
  assert(resolveHardFloor({ tier: 'opus' }).applies === true, 'I1: object floor without `when` applies unconditionally');
}

// I2 — routeModel integration against the REAL config/model-routing.json
// floors: plan-creation drafts on the sonnet baseline for small briefs, is
// raised to opus for large briefs, and fail-safes to opus with no signals.
{
  const cfg = {
    model_routing: {
      enabled: true,
      tier_models: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-4-8', fable: 'claude-fable-5' },
    },
    models: { 'plan-creation': 'claude-sonnet-5', 'dev-execution': 'claude-sonnet-5' },
  };
  const small = await routeModel({ cfg, task: 'plan-creation', sizeMeta: { brief_chars: 3000, brief_frs: 3 } });
  assert(small.tier === 'sonnet', 'I2: small brief → plan-creation stays on sonnet (floor size-gate unmet)');
  assert(small.reasoning.some((r) => /SKIPPED/.test(r) && /size gate unmet/.test(r)), 'I2: reasoning records the skipped floor');

  const large = await routeModel({ cfg, task: 'plan-creation', sizeMeta: { brief_chars: 20000, brief_frs: 3 } });
  assert(large.tier === 'opus', 'I2: large brief (chars threshold) → plan-creation raised to opus');

  const manyFrs = await routeModel({ cfg, task: 'plan-creation', sizeMeta: { brief_chars: 3000, brief_frs: 12 } });
  assert(manyFrs.tier === 'opus', 'I2: FR-heavy brief → plan-creation raised to opus (any-of)');

  const noSignals = await routeModel({ cfg, task: 'plan-creation' });
  assert(noSignals.tier === 'opus', 'I2: no sizeMeta → floor applies (fail-safe, pre-v0.17 behavior)');
}

// I3 — audit adjudication floor gates on scan candidate count.
{
  const cfg = {
    model_routing: {
      enabled: true,
      tier_models: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-4-8', fable: 'claude-fable-5' },
    },
    models: { audit: 'claude-sonnet-5', 'dev-execution': 'claude-sonnet-5' },
  };
  const fewCands = await routeModel({ cfg, task: 'audit', sizeMeta: { candidates: 2 } });
  assert(fewCands.tier === 'sonnet', 'I3: 2 scan candidates → adjudication stays on sonnet');
  const manyCands = await routeModel({ cfg, task: 'audit', sizeMeta: { candidates: 5 } });
  assert(manyCands.tier === 'opus', 'I3: 5 scan candidates → adjudication raised to opus');
  const noMeta = await routeModel({ cfg, task: 'audit' });
  assert(noMeta.tier === 'opus', 'I3: single-call audit path (no sizeMeta) keeps the opus floor (fail-safe)');
}

// ─── J — telemetry-learned floors (routeModel Step 6.5, phase-56) ────────────
// routeModel honors extension.task_floors[task] (written by the auto-runner's
// telemetry preflight) as a floor via maxTier, for the routed task only. Uses a
// real on-disk fixture under projects/ so the disk-load path in
// loadProjectRoutingExtension is exercised end-to-end.
console.log('\nphase-56 telemetry-learned floors (routeModel Step 6.5):');
{
  const PROJECTS_DIR = path.join(__dirname, '..', 'projects');
  const projName = '_tel-fixture-router';
  const projDir = path.join(PROJECTS_DIR, projName);
  const extPath = path.join(projDir, 'routing-extension.json');
  await fs.mkdir(projDir, { recursive: true });
  try {
    const cfg = {
      model_routing: {
        enabled: true,
        tier_models: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-4-8', fable: 'claude-fable-5' },
      },
      models: { 'dev-execution': 'claude-sonnet-5', 'fix-execution': 'claude-sonnet-5' },
    };

    // J1 — a learned opus floor for dev-execution raises the sonnet baseline to
    // opus, with a learned-floor reasoning line that names the source file.
    await fs.writeFile(extPath, JSON.stringify({
      keyword_rules: [],
      task_floors: { 'dev-execution': 'opus' },
      task_floors_meta: { updated_at: 'T', reasons: ['learned floor dev-execution->opus (telemetry: 4/9 recent sonnet calls failed)'] },
    }, null, 2), 'utf-8');

    const dev = await routeModel({ cfg, task: 'dev-execution', projectName: projName });
    assert(dev.tier === 'opus', 'J1: learned floor raises dev-execution from the sonnet baseline to opus');
    assert(dev.model === 'claude-opus-4-8', 'J1: resolves to claude-opus-4-8');
    assert(dev.reasoning.some((r) => /learned floor for dev-execution/.test(r) && /routing-extension\.json/.test(r)),
      'J1: reasoning carries the learned-floor line naming the source');

    // J2 — the floor is scoped to dev-execution; routing fix-execution ignores it.
    const fix = await routeModel({ cfg, task: 'fix-execution', projectName: projName });
    assert(fix.tier === 'sonnet', 'J2: a floor for a DIFFERENT task (dev-execution) is ignored when routing fix-execution');
    assert(!fix.reasoning.some((r) => /learned floor for fix-execution/.test(r)), 'J2: no learned-floor line for the un-floored task');

    // J3 — an invalid tier is ignored, and the reasoning names the config source.
    await fs.writeFile(extPath, JSON.stringify({ task_floors: { 'dev-execution': 'ultra' } }, null, 2), 'utf-8');
    const invalid = await routeModel({ cfg, task: 'dev-execution', projectName: projName });
    assert(invalid.tier === 'sonnet', 'J3: an invalid learned tier does not change the routed tier');
    assert(invalid.reasoning.some((r) => /not a known tier/.test(r) && new RegExp(`projects/${projName}/routing-extension\\.json`).test(r)),
      'J3: reasoning names the config source for the ignored invalid tier');
  } finally {
    await fs.rm(projDir, { recursive: true, force: true });
  }
}

// ─── K — telemetry-learned caps (routeModel Step 6.6, 2026-07-12) ─────────────
// The demotion mirror of the J block: extension.task_caps[task] lowers the
// tier via minTier, but ONLY on the clean-baseline path (nothing pinned the
// tier) and, for escalation tasks, only at LOW complexity.
console.log('\nwindow-economy telemetry-learned caps (routeModel Step 6.6):');
{
  const PROJECTS_DIR = path.join(__dirname, '..', 'projects');
  const projName = '_cap-fixture-router';
  const projDir = path.join(PROJECTS_DIR, projName);
  const extPath = path.join(projDir, 'routing-extension.json');
  await fs.mkdir(projDir, { recursive: true });
  try {
    const cfg = {
      model_routing: {
        enabled: true,
        tier_models: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-4-8', fable: 'claude-fable-5' },
      },
      models: { 'dev-execution': 'claude-sonnet-5', 'fix-execution': 'claude-sonnet-5', 'plan-validate': 'claude-sonnet-5' },
    };

    // K1 — a learned haiku cap lowers an unpinned, low-complexity dev call.
    await fs.writeFile(extPath, JSON.stringify({
      task_caps: { 'dev-execution': 'haiku' },
      task_caps_meta: { updated_at: 'T', reasons: ['learned cap dev-execution->haiku (telemetry: 8 recent sonnet calls clean & under 50% turn cap)'] },
    }, null, 2), 'utf-8');
    const k1 = await routeModel({ cfg, task: 'dev-execution', projectName: projName });
    assert(k1.tier === 'haiku', 'K1: learned cap lowers the sonnet baseline to haiku on the clean low-complexity path');
    assert(k1.model === 'claude-haiku-4-5', 'K1: resolves to claude-haiku-4-5');
    assert(k1.reasoning.some((r) => /learned cap for dev-execution/.test(r) && /lowered to haiku/.test(r)),
      'K1: reasoning carries the learned-cap line');

    // K2 — a phase model_override PINS the tier; the cap is skipped.
    const k2 = await routeModel({ cfg: { ...cfg, model: 'claude-opus-4-8' }, task: 'dev-execution', projectName: projName });
    assert(k2.tier === 'opus', 'K2: an explicit override is never undercut by a learned cap');
    assert(k2.reasoning.some((r) => /learned cap for dev-execution/.test(r) && /SKIPPED — tier pinned/.test(r)),
      'K2: reasoning explains the pin-skip');

    // K3 — an extension keyword min_tier floor pins the tier; cap skipped even
    // though the floor and the routed tier are both sonnet ("already met").
    await fs.writeFile(extPath, JSON.stringify({
      keyword_rules: [{ label: 'zebra-domain', match: ['zebrafish'], min_tier: 'sonnet' }],
      task_caps: { 'dev-execution': 'haiku' },
    }, null, 2), 'utf-8');
    const k3 = await routeModel({
      cfg, task: 'dev-execution', projectName: projName,
      phaseMeta: { title: 'zebrafish quokka shuffle', goal: 'shuffle the zebrafish quokka widget', acceptance_criteria: ['a'] },
    });
    assert(k3.tier === 'sonnet', 'K3: a matched domain floor pins sonnet even when already met — the cap must not undercut it');
    assert(k3.reasoning.some((r) => /SKIPPED — tier pinned/.test(r)), 'K3: pin-skip reasoning present');

    // K4 — medium+ complexity skips the cap for escalation tasks.
    await fs.writeFile(extPath, JSON.stringify({ task_caps: { 'dev-execution': 'haiku' } }, null, 2), 'utf-8');
    const k4 = await routeModel({
      cfg, task: 'dev-execution', projectName: projName,
      phaseMeta: { title: 'quokka widget shuffle', goal: 'shuffle the quokka widget', acceptance_criteria: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
    });
    assert(k4.tier === 'sonnet', 'K4: a medium-complexity phase keeps its sonnet baseline despite the cap');
    assert(k4.reasoning.some((r) => /learned cap for dev-execution/.test(r) && /complexity/.test(r)),
      'K4: reasoning explains the complexity skip');

    // K5 — a cap on a NON-escalation task applies (its complexity is always
    // low: overhead tasks never route on phase meta).
    await fs.writeFile(extPath, JSON.stringify({ task_caps: { 'plan-validate': 'haiku' } }, null, 2), 'utf-8');
    const k5 = await routeModel({ cfg, task: 'plan-validate', projectName: projName });
    assert(k5.tier === 'haiku', 'K5: an overhead task with a learned cap routes to haiku');

    // K6 — an invalid cap tier is ignored, reasoning names the source.
    await fs.writeFile(extPath, JSON.stringify({ task_caps: { 'dev-execution': 'nano' } }, null, 2), 'utf-8');
    const k6 = await routeModel({ cfg, task: 'dev-execution', projectName: projName });
    assert(k6.tier === 'sonnet', 'K6: an invalid learned cap does not change the routed tier');
    assert(k6.reasoning.some((r) => /learned cap for dev-execution/.test(r) && /not a known tier/.test(r)),
      'K6: reasoning names the ignored invalid cap');
  } finally {
    await fs.rm(projDir, { recursive: true, force: true });
  }
}

// ─── phase-23 — graduated escalation ladder (src/lib/escalation.js) ───────────
console.log('\nphase-23 escalation ladder:');

// E1 — nextTier steps one rung; the top rung (fable) and unknowns have none.
{
  assert(nextTier('sonnet') === 'opus', 'E1: failed sonnet → target opus');
  assert(nextTier('opus') === 'fable', 'E1: failed opus → target fable');
  assert(nextTier('haiku') === 'sonnet', 'E1: failed haiku → target sonnet');
  assert(nextTier('fable') === null, 'E1: failed fable → no target (top rung)');
  assert(nextTier('bogus-tier') === null, 'E1: unrecognized tier → no target');
}

// E2 — parseEscalationTarget: JSON target_tier honored; anything else → opus.
{
  assert(parseEscalationTarget('{"target_tier":"fable"}') === 'fable', 'E2: JSON target_tier honored');
  assert(parseEscalationTarget('failed at 2026-01-01 → escalate to opus') === 'opus', 'E2: legacy plain-text body → opus');
  assert(parseEscalationTarget('{"reason":"x"}') === 'opus', 'E2: JSON without target_tier → opus');
  assert(parseEscalationTarget('') === 'opus', 'E2: empty body → opus');
}

// E3 — write→resolve round-trip: sonnet failure targets opus, opus targets
// fable, and a fable failure writes NOTHING (resolve returns null).
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aorch-esc-'));
  const wSonnet = await writeEscalationMarker({ projDir: dir, phaseN: 5, failedTier: 'sonnet', reason: 'x', at: 'T' });
  assert(wSonnet.written === true && wSonnet.targetTier === 'opus', 'E3: sonnet failure writes an opus-targeting marker');
  const rSonnet = await resolveEscalation({ projDir: dir, phaseN: 5 });
  assert(rSonnet.targetTier === 'opus' && rSonnet.legacy === false, 'E3: resolveEscalation reads the new-format opus target');
  // Marker body is valid JSON with all four fields.
  const body = JSON.parse(await fs.readFile(escalationMarkerPath(dir, { phaseN: 5 }), 'utf-8'));
  assert(body.target_tier === 'opus' && body.failed_tier === 'sonnet'
    && typeof body.reason === 'string' && typeof body.at === 'string',
    'E3: marker JSON carries target_tier, failed_tier, reason, at');

  const wOpus = await writeEscalationMarker({ projDir: dir, phaseN: 6, failedTier: 'opus', reason: 'x', at: 'T' });
  assert(wOpus.written === true && wOpus.targetTier === 'fable', 'E3: opus failure writes a fable-targeting marker');

  const wFable = await writeEscalationMarker({ projDir: dir, phaseN: 7, failedTier: 'fable', reason: 'x', at: 'T' });
  assert(wFable.written === false && wFable.targetTier === null, 'E3: fable failure writes NO marker');
  const rFable = await resolveEscalation({ projDir: dir, phaseN: 7 });
  assert(rFable.targetTier === null, 'E3: no marker on disk → resolveEscalation returns null target (routing falls through to pause)');
}

// E4 — back-compat: a legacy `*-escalate-opus.marker` still escalates to opus,
// and the NEW marker name takes precedence when both are on disk.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aorch-esc-legacy-'));
  await fs.mkdir(path.join(dir, '.guide'), { recursive: true });
  await fs.writeFile(legacyEscalationMarkerPath(dir, { phaseN: 3 }), 'failed at 2026-01-01: dev error\n', 'utf-8');
  const rLegacy = await resolveEscalation({ projDir: dir, phaseN: 3 });
  assert(rLegacy.targetTier === 'opus' && rLegacy.legacy === true, 'E4: legacy marker alone → target opus (legacy flag set)');

  // Now drop a new-format marker targeting fable — it must win over the legacy one.
  await writeEscalationMarker({ projDir: dir, phaseN: 3, failedTier: 'opus', reason: 'x', at: 'T' });
  const rBoth = await resolveEscalation({ projDir: dir, phaseN: 3 });
  assert(rBoth.targetTier === 'fable' && rBoth.legacy === false, 'E4: new-format marker takes precedence over a coexisting legacy marker');
}

// E5 — fix markers use the fix-scoped file name and round-trip identically.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aorch-esc-fix-'));
  const w = await writeEscalationMarker({ projDir: dir, fix: { round: 2, n: 4 }, failedTier: 'sonnet', reason: 'x', at: 'T' });
  assert(w.written === true && w.targetTier === 'opus', 'E5: fix sonnet failure → opus-targeting marker');
  assert(w.path === escalationMarkerPath(dir, { fix: { round: 2, n: 4 } }), 'E5: fix marker uses the fix-scoped path');
  const r = await resolveEscalation({ projDir: dir, fix: { round: 2, n: 4 } });
  assert(r.targetTier === 'opus', 'E5: fix marker resolves back to opus');
}

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
