// v0.14.37 verifier — proves batch 4 landed and behaves:
//
//   A. escalation scoped to execution tasks  — live routeModel (7)
//   B. inline fix prompts                    — prompt contract + wiring (7)
//   C. version                               — 0.14.37 stamp (1)
//
// 15 checks total. Group A calls routeModel against the shipped
// model-routing.json — the checks ARE the behavior, not source grep.
// Imports model-router/phase-runner (→ better-sqlite3); run on the live install.
//
// Run with: node scripts/verify-v0_14_37.mjs
// Exits 0 on full pass, 1 on any failure.

import { readFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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

console.log(chalk.bold('\n── v0.14.37 verifier ──\n'));

// ─── A. escalation scoped to execution tasks ────────────────────────────────
console.log(chalk.bold('A. escalation scope'));

const routingFile = JSON.parse(readSrc('config/model-routing.json'));
check('model-routing.json declares escalation_tasks = [dev-execution, fix-execution]',
  Array.isArray(routingFile.escalation_tasks)
  && routingFile.escalation_tasks.join(',') === 'dev-execution,fix-execution');

const { routeModel } = await import(resolve(REPO_ROOT, 'src/model-router.js'));
const cfg = {
  models: {
    'dev-execution': 'claude-sonnet-4-6', 'fix-execution': 'claude-sonnet-4-6',
    '3-phase-review': 'claude-sonnet-4-6', 'phase-prompt-gen': 'claude-sonnet-4-6', 'bug-plan': 'claude-sonnet-4-6',
  },
  model_routing: { enabled: true, tier_models: { sonnet: 'claude-sonnet-4-6', opus: 'claude-opus-4-8' } },
};
// Heavy regulatory-core meta: pre-v0.14.37 this force_tier'd EVERY task to opus.
const regMeta = {
  title: 'FVU generator for 26Q', goal: 'NSDL FVU file generation',
  acceptance_criteria: Array(15).fill('c'), files_expected: Array(20).fill('f'), max_turns: 120,
};

for (const t of ['3-phase-review', 'phase-prompt-gen', 'bug-plan']) {
  const r = await routeModel({ cfg, task: t, phaseMeta: regMeta });
  check(`${t} + regulatory meta → stays sonnet, low complexity, skip-reasoning present`,
    r.tier === 'sonnet'
    && r.complexity === 'low'
    && r.reasoning.some((x) => /not in escalation_tasks/.test(x)),
    `tier=${r.tier} complexity=${r.complexity}`);
}

const dev = await routeModel({ cfg, task: 'dev-execution', phaseMeta: regMeta });
check('dev-execution + regulatory-core meta still forces opus', dev.tier === 'opus', `tier=${dev.tier}`);
const fx = await routeModel({ cfg, task: 'fix-execution', phaseMeta: { title: 'fix FVU generator field positions', goal: 'NSDL FVU file' } });
check('fix-execution + regulatory-core meta still forces opus',
  fx.tier === 'opus' && fx.reasoning.some((x) => /regulatory-core.*force_tier/.test(x)), `tier=${fx.tier}`);
const fxDomain = await routeModel({ cfg, task: 'fix-execution', phaseMeta: { title: 'fix auth bypass in session middleware', goal: 'JWT verification' } });
check('domain-tier rules unchanged on execution tasks (security-domain min sonnet, not opus)',
  fxDomain.tier === 'sonnet', `tier=${fxDomain.tier}`);

// ─── B. inline fix prompts ──────────────────────────────────────────────────
console.log(chalk.bold('\nB. inline fix prompts'));

const pr = await import(resolve(REPO_ROOT, 'src/lib/phase-runner.js'));
check('phase-runner exports buildInlineFixPrompt', typeof pr.buildInlineFixPrompt === 'function');

const projDir = mkdtempSync(join(tmpdir(), 'v37-'));
mkdirSync(join(projDir, 'workspace'), { recursive: true });
mkdirSync(join(projDir, '.guide'), { recursive: true });
const fixMeta = { n: 3, title: 'FK guard for _inbox', bugs: [2], files: ['src/state.js'], approach: 'guard project name before insert' };
const p = pr.buildInlineFixPrompt({
  projectName: 'aorch', fix: { round: 2, n: 3, title: 'FK guard for _inbox' },
  fixMeta, projDir, workspaceDir: join(projDir, 'workspace'), plan: null,
});
check('inline fix prompt: heading, entry JSON embedded verbatim, bugs.md + plan.json pointers',
  /# Fix r2-3 — FK guard for _inbox/.test(p)
  && /"approach": "guard project name before insert"/.test(p)
  && /round-2\/bugs\.md/.test(p) && /round-2\/plan\.json/.test(p));
check('inline fix prompt: Expected-as-acceptance, decisions.md, conventions, commit format',
  /"Expected" is your acceptance criterion/.test(p)
  && /\.\.\/\.guide\/decisions\.md/.test(p)
  && /Conventions to follow/.test(p)
  && /fix-r2-3: <one-line summary>/.test(p));
check('inline fix prompt: scope rules (no drive-by fixes, deviation documented)',
  /Fix ONLY what your entry covers/.test(p)
  && /No refactors, no drive-by fixes/.test(p)
  && /document the deviation in your report/.test(p));
const pNull = pr.buildInlineFixPrompt({
  projectName: 'a', fix: { round: 2, n: 3, title: 't' }, fixMeta: null,
  projDir, workspaceDir: join(projDir, 'workspace'), plan: null,
});
check('missing plan.json entry → explicit fallback pointing at the round plan as authoritative',
  /entry n=3 could not be read/.test(pNull) && /as authoritative/.test(pNull));

const prSrc = readSrc('src/lib/phase-runner.js');
check('runDev branch order: file-on-disk wins → phase inline → fix inline → throw',
  /if \(await fileExists\(promptFile\)\)/.test(prSrc)
  && /else if \(!fix && inlinePrompts && phaseMeta\)/.test(prSrc)
  && /else if \(fix && inlineFixPrompts\)/.test(prSrc)
  && /buildInlineFixPrompt\(\{ projectName, fix, fixMeta: fixEntry/.test(prSrc));

const arSrc = readSrc('src/auto-runner.js');
const defaults = JSON.parse(readSrc('config/defaults.json'));
check('pickBugAction gates the fix-prompt guide call behind inline_fix_prompts; defaults knob is true',
  /const inlineFix = cfg\.fixes\?\.inline_fix_prompts !== false;/.test(arSrc)
  && /if \(!inlineFix\) \{/.test(arSrc)
  && defaults.fixes?.inline_fix_prompts === true);

// ─── C. version ──────────────────────────────────────────────────────────────
console.log(chalk.bold('\nC. version'));
check('package.json version is 0.14.37', JSON.parse(readSrc('package.json')).version === '0.14.37');

rmSync(projDir, { recursive: true, force: true });
console.log('');
if (failed === 0) {
  console.log(chalk.green.bold(`✓ All ${passed} checks passed.`));
  process.exit(0);
} else {
  console.log(chalk.red.bold(`✗ ${failed} failed, ${passed} passed.`));
  process.exit(1);
}
