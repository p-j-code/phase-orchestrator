// v0.14.35 verifier — proves batch 2 landed and behaves:
//
//   A. validator hard gate     — default chain + toggles (10 functional)
//   B. gate wiring in runDev   — order, retry, no-push-on-fail (5 source)
//   C. inline phase prompts    — prompt build, decisions log, routing (10)
//   D. qa-handoff + haiku      — routing fix, tier retirement (4)
//   E. version                 — 0.14.35 stamp (1)
//
// 32 checks total. Functional where the path is reachable without a claude
// subprocess or a live DB row; source assertions for the in-loop runner logic.
//
// NOTE: groups C/D import phase-runner.js / model-router.js, which
// transitively load better-sqlite3 — run on the live install.
//
// Run with: node scripts/verify-v0_14_35.mjs
// Exits 0 on full pass, 1 on any failure.

import { readFileSync, existsSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import chalk from 'chalk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

let passed = 0;
let failed = 0;
function check(label, ok, details) {
  if (ok) { console.log(chalk.green('  OK  '), label); passed += 1; }
  else    { console.log(chalk.red('  FAIL'), label, details ? chalk.dim(`— ${details}`) : ''); failed += 1; }
}
function readSrc(rel) {
  const p = resolve(REPO_ROOT, rel);
  if (!existsSync(p)) throw new Error(`Missing file: ${rel}`);
  return readFileSync(p, 'utf8');
}
function mkWorkspace(pkg, files = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'v35-ws-'));
  if (pkg) writeFileSync(join(ws, 'package.json'), JSON.stringify(pkg));
  for (const [f, c] of Object.entries(files)) writeFileSync(join(ws, f), c);
  return ws;
}
const PLACEHOLDER = 'echo "Error: no test specified" && exit 1';

console.log(chalk.bold('\n── v0.14.35 verifier ──\n'));

// ─── A. validator hard gate — default chain ─────────────────────────────────
console.log(chalk.bold('A. validator default gate'));

const v = await import(resolve(REPO_ROOT, 'src/lib/validators.js'));
check('validators.js exports runValidatorGate / runDefaultGate / gateFailureExcerpt / hasRealTestScript',
  ['runValidatorGate', 'runDefaultGate', 'gateFailureExcerpt', 'hasRealTestScript'].every((k) => typeof v[k] === 'function'));

check('hasRealTestScript: npm-init placeholder is NOT a real test script',
  (await v.hasRealTestScript(mkWorkspace({ scripts: { test: PLACEHOLDER } }))) === false);
check('hasRealTestScript: a real test script is detected',
  (await v.hasRealTestScript(mkWorkspace({ scripts: { test: 'vitest run' } }))) === true);

let ws = mkWorkspace({ scripts: { test: 'node -e "process.exit(0)"' } });
let g = await v.runDefaultGate({ workspaceDir: ws, changedFiles: [] });
check('default gate: passing npm test → allPassed, named default:npm-test',
  g.allPassed === true && g.results[0]?.validator_name === 'default:npm-test');

ws = mkWorkspace({ scripts: { test: 'node -e "console.error(String.fromCharCode(98,111,111,109)); process.exit(1)"' } });
g = await v.runDefaultGate({ workspaceDir: ws, changedFiles: [] });
check('default gate: failing npm test → hasFailures; gateFailureExcerpt carries the output',
  g.hasFailures === true && /default:npm-test/.test(v.gateFailureExcerpt(g)) && /boom/.test(v.gateFailureExcerpt(g)));

ws = mkWorkspace({ scripts: { test: PLACEHOLDER } }, { 'bad.js': 'function ( {', 'good.js': 'const a = 1;' });
g = await v.runDefaultGate({ workspaceDir: ws, changedFiles: ['bad.js', 'good.js', 'deleted.js', 'style.css'] });
check('default gate: node --check fails ONLY the broken file; deleted/non-JS filtered',
  g.hasFailures === true && g.results.length === 2
  && g.results.find((r) => /bad\.js/.test(r.validator_name))?.pass === false
  && g.results.find((r) => /good\.js/.test(r.validator_name))?.pass === true);

ws = mkWorkspace({ scripts: { test: PLACEHOLDER } }, { 'ok.js': 'export const x = 1;' });
g = await v.runDefaultGate({ workspaceDir: ws, changedFiles: ['ok.js'] });
check('default gate: clean changed JS → pass', g.allPassed === true);

g = await v.runDefaultGate({ workspaceDir: mkWorkspace(null, { 'readme.md': 'x' }), changedFiles: ['readme.md'] });
check('default gate: no test script + no changed JS → skipped pass (never blocks for lacking tests)',
  g.allPassed === true && /no test script/.test(g.skipped || ''));

g = await v.runValidatorGate({ projectName: '__no_such_project__', workspaceDir: ws, event: { phase: 1 }, changedFiles: [], cfg: { validators: { enabled: false } } });
check('runValidatorGate: validators.enabled:false → gate off, passes through',
  g.gate === 'off' && g.allPassed === true);

ws = mkWorkspace({ scripts: { test: 'node -e "process.exit(0)"' } });
g = await v.runValidatorGate({ projectName: '__no_such_project__', workspaceDir: ws, event: { phase: 1 }, changedFiles: [], cfg: {} });
check('runValidatorGate: no validators.json → falls back to default gate',
  g.gate === 'default' && g.allPassed === true);

g = await v.runValidatorGate({ projectName: '__no_such_project__', workspaceDir: ws, event: { phase: 1 }, changedFiles: [], cfg: { validators: { default_gate: false } } });
check('runValidatorGate: default_gate:false → configured-skip passthrough, no built-in fallback',
  g.gate === 'configured' && /no validators\.json/.test(g.skipped || ''));

// ─── B. gate wiring in runDev ────────────────────────────────────────────────
console.log(chalk.bold('\nB. gate wiring in runDev'));

const prSrc = readSrc('src/lib/phase-runner.js');
const gateIdx = prSrc.indexOf('v0.14.35 validator hard gate');
const completeIdx = prSrc.indexOf('markPhaseCompleted({ project: projectName, n: nextPhase, commit_sha });');
const pushIdx = prSrc.indexOf('const push = await pushBranch(workspaceDir, { branch });');
check('gate block sits BEFORE markPhaseCompleted and BEFORE pushBranch',
  gateIdx > -1 && completeIdx > -1 && pushIdx > -1 && gateIdx < completeIdx && gateIdx < pushIdx,
  `gate@${gateIdx} complete@${completeIdx} push@${pushIdx}`);
check('mechanical retry resumes the dev session with the failure excerpt injected',
  /sessionId: result\.session_id \|\| null/.test(prSrc)
  && /FAILED the post-commit validators/.test(prSrc)
  && /Fix EXACTLY what this output indicates/.test(prSrc));
check('failure path: phase marked failed, validation-failed git_result, returns before push',
  /error: 'validation-failed'/.test(prSrc)
  && /NOT marking complete, NOT pushing/.test(prSrc));
check('success path: validator_outcome attached + commit_sha recomputed after retry',
  /result\.validator_outcome = gate;/.test(prSrc)
  && /commit_sha = await getHeadSha\(workspaceDir\);[\s\S]{0,40}\}\n/.test(prSrc)
  && /let commit_sha = await getHeadSha/.test(prSrc));

const arSrc = readSrc('src/auto-runner.js');
const shortCircuits = (arSrc.match(/result\.validator_outcome\s*\?\s*summarizeOutcome\(result\.validator_outcome\)/g) || []).length;
check('auto-runner short-circuits the legacy post-hoc validator pass at BOTH dev sites',
  shortCircuits === 2, `found ${shortCircuits}`);

// ─── C. inline phase prompts + decisions log ────────────────────────────────
console.log(chalk.bold('\nC. inline phase prompts + decisions log'));

const pr = await import(resolve(REPO_ROOT, 'src/lib/phase-runner.js'));
check('phase-runner exports buildInlinePhasePrompt / loadDecisionsBlock',
  typeof pr.buildInlinePhasePrompt === 'function' && typeof pr.loadDecisionsBlock === 'function');

const projDir = mkdtempSync(join(tmpdir(), 'v35-proj-'));
mkdirSync(join(projDir, 'workspace'), { recursive: true });
mkdirSync(join(projDir, '.guide'), { recursive: true });
const phaseMeta = {
  n: 7, title: 'Export worker retries', goal: 'Add retry/backoff to export jobs',
  notes: 'use existing logger', acceptance_criteria: ['3 retries with exp backoff'], files_expected: ['worker/export.ts'],
};
const inline = pr.buildInlinePhasePrompt({ projectName: 'vtest', phaseMeta, plan: null, projDir, workspaceDir: join(projDir, 'workspace') });
check('inline prompt: phase heading, criteria, decisions pointer, brief sections, commit format',
  /# Phase 7 — Export worker retries/.test(inline)
  && /3 retries with exp backoff/.test(inline)
  && /\.\.\/\.guide\/decisions\.md/.test(inline)
  && /Conventions to follow/.test(inline)
  && /phase-7: <one-line summary>/.test(inline));

writeFileSync(join(projDir, '.guide', 'decisions.md'),
  Array.from({ length: 120 }, (_, i) => `- decision ${i + 1}`).join('\n'));
const block = await pr.loadDecisionsBlock(projDir);
check('decisions block: tail-80 cap with truncation note, wrapped in <decisions_log>',
  /decision 120/.test(block) && !/decision 40\b/.test(block)
  && /showing last 80 lines/.test(block) && /<decisions_log>/.test(block));
check('decisions block: null when the file is absent',
  (await pr.loadDecisionsBlock(mkdtempSync(join(tmpdir(), 'v35-empty-')))) === null);

check('runDev injects decisions block into dev system-prompt extra',
  /const decisionsCtx = await loadDecisionsBlock\(projDir\);/.test(prSrc)
  && /\[briefCtx, ctxExtra, decisionsCtx\]/.test(prSrc));
check('runDev: prompt.md on disk wins; inline only for phases (not fixes); throw retained otherwise',
  /if \(await fileExists\(promptFile\)\)/.test(prSrc)
  && /else if \(!fix && inlinePrompts && phaseMeta\)/.test(prSrc)
  && /throw new Error\(`Prompt file not found: \$\{promptFile\}`\)/.test(prSrc));

check('pickNextAction: reprompt hint keeps the guide call; inline otherwise goes straight to dev',
  /reprompt\.hint/.test(arSrc)
  && /if \(!inlinePrompts \|\| hasHint\)/.test(arSrc)
  && /\(reprompt\)/.test(arSrc));
check('skip-repair rewind honors inline prompts',
  /const inlineRepair = cfg\.phases\?\.inline_phase_prompts !== false;/.test(arSrc)
  && /const goDev = hasRepairPrompt \|\| inlineRepair;/.test(arSrc));

check('review prompt maintains the rolling decisions log (append-only, durable entries)',
  /\.guide\/decisions\.md \(create if missing\): APPEND/.test(prSrc)
  && /Do not rewrite or delete earlier entries/.test(prSrc));
check('next-prompt (reprompt path) reads decisions.md',
  /- \.guide\/decisions\.md — rolling decisions from reviews/.test(prSrc));

const defaults = JSON.parse(readSrc('config/defaults.json'));
check('defaults.json: inline_phase_prompts true; default_gate true with timeouts',
  defaults.phases?.inline_phase_prompts === true
  && defaults.validators?.default_gate === true
  && defaults.validators?.default_test_timeout_ms === 180000
  && defaults.validators?.default_check_timeout_ms === 30000);

// ─── D. qa-handoff routing + haiku retirement ───────────────────────────────
console.log(chalk.bold('\nD. qa-handoff routing + haiku retirement'));

const qaSrc = readSrc('src/commands/qa-handoff.js');
check('qa-handoff routes through routeModel (direct models.audit read removed)',
  /import \{ routeModel \} from '\.\.\/model-router\.js';/.test(qaSrc)
  && /const routing = await routeModel\(\{ cfg, task: 'audit', projectName \}\);/.test(qaSrc)
  && !/cfg\.model = cfg\.models\?\.audit \|\|/.test(qaSrc));

check('haiku gone from defaults tier_order/tier_models; tier_caps gone from model-routing.json',
  !JSON.stringify(defaults.model_routing?.tier_order || []).includes('haiku')
  && !(defaults.model_routing?.tier_models || {}).haiku
  && !('tier_caps' in JSON.parse(readSrc('config/model-routing.json'))));

const { routeModel } = await import(resolve(REPO_ROOT, 'src/model-router.js'));
const strayCfg = {
  models: { 'dev-execution': 'claude-haiku-4-5-20251001' },
  model_routing: {
    enabled: true,
    tier_models: { haiku: 'claude-haiku-4-5-20251001', sonnet: 'claude-sonnet-4-6', opus: 'claude-opus-4-8' },
  },
};
const stray = await routeModel({ cfg: strayCfg, task: 'dev-execution', phaseMeta: { title: 'tiny tweak' } });
check('stray haiku tier clamps to sonnet with an explicit reasoning line',
  stray.tier === 'sonnet'
  && stray.reasoning.some((r) => /haiku tier retired/.test(r)),
  `tier=${stray.tier}`);

const crSrc = readSrc('src/model-router.js');
check('dead Step-7 tier_caps logic removed from the router',
  !/never_use_haiku_for_dev/.test(crSrc) && !/never_use_haiku_for_reviews/.test(crSrc));

// ─── E. version ──────────────────────────────────────────────────────────────
console.log(chalk.bold('\nE. version'));
const pkg = JSON.parse(readSrc('package.json'));
check('package.json version is 0.14.35', pkg.version === '0.14.35', pkg.version);

// ─── summary ─────────────────────────────────────────────────────────────────
rmSync(projDir, { recursive: true, force: true });
console.log('');
if (failed === 0) {
  console.log(chalk.green.bold(`✓ All ${passed} checks passed.`));
  process.exit(0);
} else {
  console.log(chalk.red.bold(`✗ ${failed} failed, ${passed} passed.`));
  process.exit(1);
}
