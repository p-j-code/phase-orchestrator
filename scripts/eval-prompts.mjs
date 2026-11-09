#!/usr/bin/env node
// Prompt eval harness — Phase 84 (brief 05 P6).
//
// Runs the REAL runGuide / phase-runner prompt assembly against FROZEN
// micro-fixtures (eval/fixtures/), grades each produced artifact against a
// checklist rubric (eval/rubrics/<task>.md) with ONE roleless prompt-eval-judge
// call, and compares the checklist score to a recorded baseline
// (eval/baselines.json). A score drop beyond eval.tolerance exits NON-ZERO.
//
// Design invariants (see eval/README.md):
//   • BILLING-GUARD-AWARE — refuses to start at windowStatus 'warn'/'pause',
//     naming billing.warn_at_calls as the source config layer. Each case makes
//     real haiku/sonnet calls, so it must not run when the window is under
//     pressure.
//   • ISOLATED — sets process.env.DB_PATH to a throwaway temp DB BEFORE any
//     state import (precedent: src/web-ui-routes.test.mjs:16) so fixture
//     projects/calls never touch the production DB. The billing guard reads the
//     PRODUCTION window through a SEPARATE read-only connection (it must see the
//     real call history) — it never binds the state singleton.
//   • TESTABLE WITHOUT REAL CALLS — every LLM/DB seam is injectable via `deps`.
//     `npm test` exercises runEval() with fake seams only; real evals NEVER run
//     under npm test. The CLI entry wires the real seams.
//
// The 'eval' job action (src/server/job-runner.js) runs this as a fresh child
// process so the P7 autopilot can schedule evals into leftover window headroom.

import { mkdtemp, mkdir, cp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');
export const EVAL_DIR = path.join(REPO_ROOT, 'eval');
export const FIXTURES_DIR = path.join(EVAL_DIR, 'fixtures');
export const RUBRICS_DIR = path.join(EVAL_DIR, 'rubrics');
export const BASELINES_PATH = path.join(EVAL_DIR, 'baselines.json');

// Captured ONCE at import, before the harness overrides process.env.DB_PATH —
// this is the production DB the billing guard reads for the real window status.
const PRODUCTION_DB_PATH = process.env.DB_PATH || path.join(REPO_ROOT, 'state', 'orchestrator.db');

export const DEFAULT_TOLERANCE = 0.1;

// Frozen fixture → guide-task cases. Each case copies the fixture into an
// isolated scratch project, runs the guide task, grades the artifact. A third
// Vue fixture is DEFERRED until this harness proves itself (see eval/README.md).
export const EVAL_CASES = [
  { name: 'cli-tool', fixture: 'cli-tool', task: 'plan' },
  { name: 'tiny-api', fixture: 'tiny-api', task: 'plan' },
];

export const KNOWN_TASKS = ['plan'];

// Default task selection derives from the git diff: a task is affected when the
// diff touches the prompt-assembly surface that shapes its output. With no diff
// (clean tree) the full suite runs so a manual invocation always does something.
const TASK_TRIGGERS = {
  plan: ['prompts/', 'src/model-router.js', 'src/lib/phase-runner.js'],
};

// ─── Exit codes ──────────────────────────────────────────────────────────────
export const EXIT = { OK: 0, REGRESSION: 1, ERROR: 2, BILLING_REFUSED: 3 };

// ─── Pure helpers ────────────────────────────────────────────────────────────

export function baselineKey(evalCase) {
  return `${evalCase.name}/${evalCase.task}`;
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text || '', 'utf8').digest('hex');
}

export function parseArgs(argv) {
  const out = { help: false, updateBaseline: false, task: null, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--update-baseline') out.updateBaseline = true;
    else if (a === '--task') { out.task = argv[++i] ?? null; }
    else if (a.startsWith('--task=')) { out.task = a.slice('--task='.length); }
    else out.unknown.push(a);
  }
  return out;
}

export function helpText() {
  return [
    'eval-prompts — prompt-eval harness with billing-guard gate (Phase 84 / P6)',
    '',
    'Usage: npm run eval:prompts -- [flags]',
    '',
    'Runs the real guide prompt assembly against the frozen micro-fixtures in',
    'eval/fixtures/, grades each produced artifact against its checklist rubric',
    'via one prompt-eval-judge call, and compares the score to eval/baselines.json.',
    '',
    'Flags:',
    '  --task <name>       Run only the named guide task (one of: ' + KNOWN_TASKS.join(', ') + ').',
    '                      Default: selection is derived from the git diff — a task',
    '                      runs when the diff touches its prompt-assembly surface',
    '                      (prompts/, src/model-router.js, the phase-runner prompt',
    '                      builders); a clean tree runs the full suite.',
    '  --update-baseline   Rewrite eval/baselines.json with the scores produced by',
    '                      this run (score + artifact hash + model + date). Explicit',
    '                      opt-in only — never happens implicitly.',
    '  --help, -h          Show this help and exit.',
    '',
    'Exit codes:',
    `  ${EXIT.OK} = all cases at/above baseline (or baseline unset / nothing selected)`,
    `  ${EXIT.REGRESSION} = a checklist score dropped more than eval.tolerance below baseline,`,
    '      or a produced artifact failed structural validation',
    `  ${EXIT.ERROR} = harness error`,
    `  ${EXIT.BILLING_REFUSED} = refused: the billing window is 'warn'/'pause'`,
    '',
    'Real-call evals NEVER run under `npm test` (fake-runner seam only).',
  ].join('\n');
}

// A task is selected when explicitly named, or (auto) when the diff touches its
// trigger surface. Empty/absent changedFiles → the full known set.
export function selectTasks({ explicitTask = null, changedFiles = null } = {}) {
  if (explicitTask) return KNOWN_TASKS.includes(explicitTask) ? [explicitTask] : [];
  if (!changedFiles || changedFiles.length === 0) return [...KNOWN_TASKS];
  const selected = [];
  for (const task of KNOWN_TASKS) {
    const triggers = TASK_TRIGGERS[task] || [];
    if (changedFiles.some((f) => triggers.some((t) => f === t || f.startsWith(t)))) selected.push(task);
  }
  return selected;
}

// Parse a rubric markdown checklist into { id, text } items. Any line shaped
// `- [ ] text` (or `- [x] text`) is one independently-scored checklist item.
export function parseRubricItems(markdown) {
  const items = [];
  const lines = (markdown || '').split('\n');
  let id = 0;
  for (const line of lines) {
    const m = line.match(/^\s*[-*]\s*\[[ xX]?\]\s+(.*\S)\s*$/);
    if (m) { id += 1; items.push({ id, text: m[1].trim() }); }
  }
  return items;
}

// Checklist score = fraction of items the judge marked pass. Empty → 0.
export function computeScore(judgeItems) {
  if (!Array.isArray(judgeItems) || judgeItems.length === 0) return 0;
  const passed = judgeItems.filter((it) => it && it.pass === true).length;
  return passed / judgeItems.length;
}

// ─── Judge prompt + schema (static block is cache-stable; volatile in user) ──

const JUDGE_SYSTEM_PROMPT = [
  'You are a strict, roleless evaluator for a software-planning prompt harness.',
  'You are given a CHECKLIST of independent pass/fail criteria and a produced',
  'ARTIFACT (JSON). Judge each checklist item independently against the artifact.',
  'An item is "pass" only if the artifact clearly satisfies it; when in doubt, fail it.',
  'Do not reward verbosity or intent — judge only what the artifact actually contains.',
  'Reply with ONLY a JSON object of the shape:',
  '{ "items": [ { "id": <number>, "pass": <true|false>, "reason": "<short>" }, ... ] }',
  'Include exactly one entry per checklist item, in order. No prose outside the JSON.',
].join('\n');

export const JUDGE_SCHEMA = {
  type: 'object',
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'pass'],
        properties: {
          id: { type: 'number' },
          pass: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
    },
  },
};

function renderJudgePrompt(evalCase, rubricItems, artifactText) {
  const checklist = rubricItems.map((it) => `${it.id}. ${it.text}`).join('\n');
  return [
    `Fixture: ${evalCase.name}  |  Guide task: ${evalCase.task}`,
    '',
    'CHECKLIST (score each item independently, one verdict per item, same ids):',
    checklist,
    '',
    'ARTIFACT (the produced plan.json):',
    '```json',
    (artifactText || '').slice(0, 60000),
    '```',
    '',
    `Return a JSON object with an "items" array of ${rubricItems.length} verdicts.`,
  ].join('\n');
}

// ─── Default (production) seams — all lazily import src/ so importing this
//     module for tests is side-effect-free and never opens the production DB ──

// Reads the PRODUCTION window through its OWN read-only connection so it never
// binds the state singleton (which the isolated fixture run needs pointed at the
// temp DB). Threshold logic mirrors src/billing-guard.js windowStatus().
async function defaultWindowGuard() {
  const { resolve: resolveConfig } = await import('../src/config-resolver.js');
  const cfg = await resolveConfig({ task: 'dev-execution' });
  const b = cfg?.billing || {};
  const hours = b.window_reset_hours || 5;
  const warnCalls = b.warn_at_calls || 50;
  const pauseCalls = b.pause_at_calls || 80;
  const warnCost = b.warn_at_cost_usd ?? 30;
  const pauseCost = b.pause_at_cost_usd ?? 60;

  let count = 0;
  let totalCost = 0;
  if (existsSync(PRODUCTION_DB_PATH)) {
    const Database = (await import('better-sqlite3')).default;
    let db = null;
    try {
      db = new Database(PRODUCTION_DB_PATH, { readonly: true, fileMustExist: true });
      const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      const rows = db.prepare('SELECT cost_usd FROM calls WHERE started_at >= ?').all(cutoff);
      count = rows.length;
      totalCost = rows.reduce((s, r) => s + (r.cost_usd || 0), 0);
    } catch { /* unreadable production DB → treat as no window pressure */ }
    finally { try { db?.close(); } catch { /* ignore */ } }
  }

  let state = 'ok';
  if (count >= pauseCalls || totalCost >= pauseCost) state = 'pause';
  else if (count >= warnCalls || totalCost >= warnCost) state = 'warn';
  return { state, callsInWindow: count, warnThreshold: warnCalls, pauseThreshold: pauseCalls, windowHours: hours, totalCostInWindow: totalCost };
}

async function defaultGetChangedFiles() {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const files = new Set();
    for (const args of [['diff', '--name-only', 'HEAD'], ['diff', '--name-only', '--cached']]) {
      try {
        const { stdout } = await run('git', args, { cwd: REPO_ROOT, timeout: 15000 });
        stdout.split('\n').map((l) => l.trim()).filter(Boolean).forEach((f) => files.add(f));
      } catch { /* ignore this diff variant */ }
    }
    return [...files];
  } catch {
    return null; // git unavailable → selectTasks treats null as "run all"
  }
}

// Real artifact producer: stage the fixture into a UNIQUE temp project under the
// real projects/ dir (runGuide derives projDir from PROJECTS_DIR and has no dir
// seam), register it in the isolated DB, run the real guide task, read + validate
// the produced plan.json, then remove the temp project dir. The isolated DB
// (process.env.DB_PATH, set by runEval before the first state import) keeps the
// fixture project/calls out of production.
async function defaultProduceArtifact({ evalCase, log }) {
  const { resolve: resolveConfig } = await import('../src/config-resolver.js');
  const state = await import('../src/state.js');
  const { runGuide } = await import('../src/lib/phase-runner.js');
  const { validatePlanStructure, formatPlanProblems } = await import('../src/lib/plan-validate.js');

  const projectName = `_eval-${evalCase.name}-${process.pid}-${Date.now()}`;
  const projDir = path.join(REPO_ROOT, 'projects', projectName);
  try {
    await cp(path.join(FIXTURES_DIR, evalCase.fixture), projDir, { recursive: true });
    state.upsertProject({ name: projectName, tech_stack: 'eval-fixture', status: 'planning' });

    const guideRes = await runGuide({ projectName, task: evalCase.task });
    if (guideRes?.is_error) {
      throw new Error(`guide ${evalCase.task} errored: ${String(guideRes.error_message || guideRes.result || '').slice(0, 300)}`);
    }

    const planPath = path.join(projDir, '.guide', 'plan.json');
    const artifactText = await readFile(planPath, 'utf-8');
    const plan = JSON.parse(artifactText);

    // Structural validation: validatePlanStructure is the load-bearing validator
    // (also the P1 llm-contract validator for plan.json). The AJV plan.schema is
    // advisory (unwired to plan.json in production) — its misses are logged, not
    // gated on, so a dormant-schema drift never fails a real eval on its own.
    const struct = validatePlanStructure(plan, { currentPhase: 0 });
    const problems = [...(struct.problems || [])];
    try {
      const Ajv = (await import('ajv')).default;
      const ajv = new Ajv({ allErrors: true, strict: false });
      const schemaRaw = await readFile(path.join(REPO_ROOT, 'config', 'schemas', 'plan.schema.json'), 'utf-8');
      const validateAjv = ajv.compile(JSON.parse(schemaRaw));
      if (!validateAjv(plan)) {
        for (const e of validateAjv.errors || []) log?.(`  [ajv-advisory] ${evalCase.name}: ${e.instancePath || '/'} ${e.message}`);
      }
    } catch (e) { log?.(`  [ajv-advisory] ${evalCase.name}: schema check skipped (${e.message})`); }

    const cfg = await resolveConfig({ project: projectName, task: 'plan-creation' });
    return {
      artifactText,
      plan,
      model: cfg?.models?.['plan-creation'] || null,
      structValid: struct.ok,
      structProblems: struct.ok ? [] : [formatPlanProblems(problems)],
    };
  } finally {
    await rm(projDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Real judge: ONE roleless, tool-less prompt-eval-judge call per artifact,
// wrapped in the P1 llm-contract (tolerant JSON parse + AJV schema + one
// session-resumed re-ask). Fail-open: an unusable reply returns null (the case
// is reported inconclusive and never gates).
async function defaultJudgeArtifact({ evalCase, artifactText, rubricItems, log }) {
  const { resolve: resolveConfig } = await import('../src/config-resolver.js');
  const { runWithContract } = await import('../src/lib/llm-contract.js');

  const cfg = await resolveConfig({ task: 'prompt-eval-judge' });
  const judgeModel = cfg?.models?.['prompt-eval-judge'] || 'claude-sonnet-5';
  const judgeCfg = { ...cfg, model: judgeModel, tools: { ...(cfg.tools || {}), allowed_default: [] } };

  const baseCall = {
    cfg: judgeCfg,
    cwd: REPO_ROOT,
    systemPromptFile: null,
    systemPromptExtra: JUDGE_SYSTEM_PROMPT,
    sessionId: null,
    role: null,
    project: null,
    phase: null,
    task: 'prompt-eval-judge',
    allowedToolsOverride: [],
  };

  const res = await runWithContract({
    baseCall,
    prompt: renderJudgePrompt(evalCase, rubricItems, artifactText),
    schema: JUDGE_SCHEMA,
    maxReasks: 1,
  });
  if (!res?.ok) {
    log?.(`  [judge] ${evalCase.name}: inconclusive — ${(res?.errors || ['no verdict']).join('; ').slice(0, 200)}`);
    return null;
  }
  return res.value.items;
}

// ─── Baselines ───────────────────────────────────────────────────────────────

async function readBaselines(baselinesPath) {
  try { return JSON.parse(await readFile(baselinesPath, 'utf-8')); }
  catch { return {}; }
}

// ─── Core ────────────────────────────────────────────────────────────────────

/**
 * Run the prompt-eval harness. Every LLM/DB interaction is a `deps` seam so
 * `npm test` can drive it with fakes and never make a real call or open the
 * production DB.
 *
 * @param {Object} opts
 * @param {boolean} [opts.updateBaseline]
 * @param {string|null} [opts.task]           explicit --task filter
 * @param {number} [opts.tolerance]           score-drop gate (default 0.1)
 * @param {Object} [deps]                      injectable seams (see defaults above)
 * @returns {Promise<{exitCode:number, refused:boolean, refusedReason?:string,
 *   results:Array, scratchDir:string|null, dbPath:string|null}>}
 */
export async function runEval(opts = {}, deps = {}) {
  const {
    updateBaseline = false,
    task = null,
  } = opts;
  const tolerance = typeof opts.tolerance === 'number' ? opts.tolerance : DEFAULT_TOLERANCE;

  const {
    log = (...a) => console.log(...a),
    windowGuard = defaultWindowGuard,
    getChangedFiles = defaultGetChangedFiles,
    produceArtifact = defaultProduceArtifact,
    judgeArtifact = defaultJudgeArtifact,
    rubricsDir = RUBRICS_DIR,
    baselinesPath = BASELINES_PATH,
    scratchRoot = null,
    now = () => new Date(),
    keepScratch = false,
  } = deps;

  // 1. Billing guard — refuse before spending anything, naming the config layer.
  const win = await windowGuard();
  if (win && (win.state === 'warn' || win.state === 'pause')) {
    const reason = `[billing-guard] eval refused to start: billing window is '${win.state}' `
      + `(${win.callsInWindow}/${win.warnThreshold} calls in the last ${win.windowHours}h) — `
      + `source config layer: billing.warn_at_calls / billing.pause_at_calls. `
      + `Prompt evals make real haiku/sonnet calls; re-run once the window returns to 'ok'.`;
    log(reason);
    return { exitCode: EXIT.BILLING_REFUSED, refused: true, refusedReason: reason, results: [], scratchDir: null, dbPath: null };
  }

  // 2. Select cases from the diff (or --task).
  const changed = task ? null : await getChangedFiles();
  const selectedTasks = selectTasks({ explicitTask: task, changedFiles: changed });
  const cases = EVAL_CASES.filter((c) => selectedTasks.includes(c.task));
  if (!cases.length) {
    log(`[eval] no cases selected (task=${task ?? 'auto'}, changed=${changed ? changed.length + ' file(s)' : 'n/a'}). Nothing to do.`);
    return { exitCode: EXIT.OK, refused: false, results: [], scratchDir: null, dbPath: null };
  }

  // 3. Isolate the DB — set DB_PATH to a throwaway temp DB BEFORE any state
  //    import (the real produceArtifact seam imports state lazily). Also gives
  //    the scratch root for any staging.
  const scratchDir = await mkdtemp(path.join(scratchRoot || os.tmpdir(), 'aorch-eval-'));
  const dbPath = path.join(scratchDir, 'eval.db');
  process.env.DB_PATH = dbPath;

  const baselines = await readBaselines(baselinesPath);
  const results = [];
  let hadError = false;

  try {
    for (const evalCase of cases) {
      const key = baselineKey(evalCase);
      try {
        const rubricPath = path.join(rubricsDir, `${evalCase.task}.md`);
        const rubricItems = parseRubricItems(await readFile(rubricPath, 'utf-8'));
        if (!rubricItems.length) throw new Error(`rubric ${rubricPath} has no checklist items`);

        const produced = await produceArtifact({ evalCase, scratchDir, log });
        if (!produced) throw new Error('produceArtifact returned nothing');

        if (produced.structValid === false) {
          log(`  ✗ ${key}: artifact FAILED structural validation — ${(produced.structProblems || []).join(' | ').slice(0, 300)}`);
          results.push({ key, name: evalCase.name, task: evalCase.task, structValid: false, score: null, baseline: baselines[key]?.score ?? null, regression: true, model: produced.model || null, artifactHash: sha256(produced.artifactText || '') });
          continue;
        }

        const judgeItems = await judgeArtifact({ evalCase, artifactText: produced.artifactText, plan: produced.plan, rubricItems, log });
        if (!judgeItems) {
          log(`  ? ${key}: judge inconclusive — reported, not gated.`);
          results.push({ key, name: evalCase.name, task: evalCase.task, structValid: true, score: null, baseline: baselines[key]?.score ?? null, regression: false, inconclusive: true, model: produced.model || null, artifactHash: sha256(produced.artifactText || '') });
          continue;
        }

        const score = computeScore(judgeItems);
        const baseScore = baselines[key]?.score;
        const hasBaseline = typeof baseScore === 'number';
        const regression = hasBaseline && (baseScore - score) > tolerance;
        const symbol = regression ? '✗' : hasBaseline ? '✓' : '·';
        log(`  ${symbol} ${key}: score ${score.toFixed(3)}`
          + (hasBaseline ? ` (baseline ${baseScore.toFixed(3)}, tol ${tolerance})` : ' (no baseline — reporting only)')
          + (regression ? ' — REGRESSION' : ''));
        results.push({ key, name: evalCase.name, task: evalCase.task, structValid: true, score, baseline: hasBaseline ? baseScore : null, regression, model: produced.model || null, artifactHash: sha256(produced.artifactText || '') });
      } catch (err) {
        hadError = true;
        log(`  ! ${key}: harness error — ${err.message}`);
        results.push({ key, name: evalCase.name, task: evalCase.task, error: err.message });
      }
    }
  } finally {
    if (!keepScratch) await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }

  // 4. Update baselines (explicit opt-in) — never overwrite with an invalid /
  //    inconclusive / errored case; preserve any non-case keys (e.g. _comment).
  if (updateBaseline) {
    const today = now().toISOString().slice(0, 10);
    for (const r of results) {
      if (r.error || r.structValid === false || typeof r.score !== 'number') continue;
      baselines[r.key] = { score: r.score, artifact_hash: r.artifactHash, model: r.model, date: today };
    }
    await writeFile(baselinesPath, JSON.stringify(baselines, null, 2) + '\n');
    log(`[eval] baselines updated → ${path.relative(REPO_ROOT, baselinesPath)}`);
  }

  const anyRegression = results.some((r) => r.regression);
  const exitCode = hadError ? EXIT.ERROR : anyRegression ? EXIT.REGRESSION : EXIT.OK;
  return { exitCode, refused: false, results, scratchDir, dbPath };
}

// ─── CLI entry (real seams) ──────────────────────────────────────────────────

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) { console.log(helpText()); process.exit(EXIT.OK); }
  if (parsed.unknown.length) {
    console.error(`Unknown flag(s): ${parsed.unknown.join(', ')}\n`);
    console.error(helpText());
    process.exit(EXIT.ERROR);
  }
  if (parsed.task && !KNOWN_TASKS.includes(parsed.task)) {
    console.error(`Unknown --task '${parsed.task}'. Known tasks: ${KNOWN_TASKS.join(', ')}`);
    process.exit(EXIT.ERROR);
  }

  // Resolve tolerance from config (eval.tolerance), falling back to the default.
  let tolerance = DEFAULT_TOLERANCE;
  try {
    const { resolve: resolveConfig } = await import('../src/config-resolver.js');
    const cfg = await resolveConfig({ task: 'dev-execution' });
    if (typeof cfg?.eval?.tolerance === 'number') tolerance = cfg.eval.tolerance;
  } catch { /* keep default */ }

  const res = await runEval({ updateBaseline: parsed.updateBaseline, task: parsed.task, tolerance });
  if (res.refused) { process.exit(res.exitCode); }
  console.log(`[eval] done — ${res.results.length} case(s), exit ${res.exitCode}`);
  process.exit(res.exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => { console.error(`[eval] fatal: ${err.stack || err.message}`); process.exit(EXIT.ERROR); });
}
