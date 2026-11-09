// v0.14.36 verifier — proves batch 3 landed and behaves:
//
//   A. plan structure validation   — pure scenarios (8 functional)
//   B. plan regen wiring           — hint inject, post-plan gate, coverage budget (5)
//   C. two-stage audit             — prompt contracts, branching, stamp (9)
//   D. failure-driven escalation   — marker routing/cleanup, prefer_top retired (5)
//   E. version                     — 0.14.36 stamp (1)
//
// 29 checks total. Functional where reachable without a claude subprocess;
// source assertions for in-loop runner logic. Group B's hint-injection check
// and group C's incremental checks import phase-runner.js (→ better-sqlite3) —
// run on the live install.
//
// Run with: node scripts/verify-v0_14_36.mjs
// Exits 0 on full pass, 1 on any failure.

import { readFileSync, existsSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
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

console.log(chalk.bold('\n── v0.14.36 verifier ──\n'));

// ─── A. plan structure validation ────────────────────────────────────────────
console.log(chalk.bold('A. plan structure validation'));

const pv = await import(resolve(REPO_ROOT, 'src/lib/plan-validate.js'));
check('plan-validate.js exports validatePlanStructure / formatPlanProblems',
  typeof pv.validatePlanStructure === 'function' && typeof pv.formatPlanProblems === 'function');

const goodPlan = { phases: [
  { n: 1, title: 'A', goal: 'g', acceptance_criteria: ['x'] },
  { n: 2, title: 'B', goal: 'g', acceptance_criteria: ['y'], files_expected: ['a.js'] },
] };
check('well-formed plan validates clean', pv.validatePlanStructure(goodPlan).ok === true);

const badPlan = { phases: [
  { n: 1, title: 'A', goal: 'g', acceptance_criteria: ['x'] },
  { n: 1, title: '', goal: '', acceptance_criteria: [] },
  { n: 4, title: 'C', goal: 'g', acceptance_criteria: ['z'] },
  { n: 3, title: 'D', goal: 'g', acceptance_criteria: ['z'] },
] };
const badR = pv.validatePlanStructure(badPlan);
check('duplicate phase numbers detected', badR.problems.some((p) => /duplicate phase number n=1/.test(p)));
check('numbering gaps detected', badR.problems.some((p) => /gap in numbering \(n=4 after n=1\)/.test(p)));
check('non-increasing order detected', badR.problems.some((p) => /strictly increasing \(n=3 after n=4\)/.test(p)));
check('missing title/goal + empty acceptance_criteria detected',
  badR.problems.some((p) => /missing\/empty "title"/.test(p))
  && badR.problems.some((p) => /missing\/empty "goal"/.test(p))
  && badR.problems.some((p) => /acceptance_criteria/.test(p)));
check('continuation reachability: first n must be ahead of current_phase',
  pv.validatePlanStructure({ phases: [{ n: 3, title: 'x', goal: 'g', acceptance_criteria: ['a'] }] }, { currentPhase: 5 })
    .problems.some((p) => /not ahead of current_phase=5/.test(p)));
check('empty/missing plan fails fast; formatPlanProblems caps the list',
  /missing or empty/.test(pv.validatePlanStructure({}).problems[0])
  && /\(\+3 more\)/.test(pv.formatPlanProblems(Array.from({ length: 15 }, (_, i) => `p${i}`))));

// ─── B. plan regen wiring ────────────────────────────────────────────────────
console.log(chalk.bold('\nB. plan regen wiring'));

const arSrc = readSrc('src/auto-runner.js');
// v0.14.41 note: the inline post-plan block was extracted to ensureValidPlan;
// v0.14.48 note: assertion updated to the shared-helper form.
check('plan structure validation + ONE regen via plan-fix.hint (ensureValidPlan)',
  /export async function ensureValidPlan/.test(arSrc)
  && /validatePlanStructure\(plan, \{ currentPhase: getProject\(projectName\)/.test(arSrc)
  && /plan-fix\.hint/.test(arSrc)
  && /plan failed structural validation after 1 auto-regen/.test(arSrc));

const pr = await import(resolve(REPO_ROOT, 'src/lib/phase-runner.js'));
const projDir = mkdtempSync(join(tmpdir(), 'v36-proj-'));
mkdirSync(join(projDir, '.guide'), { recursive: true });
const fakeProject = { current_phase: 0, tech_stack: 'node' };
writeFileSync(join(projDir, '.guide', 'plan-fix.hint'), '- phases[1]: duplicate phase number n=1');
const planPromptHint = await pr.buildGuidePrompt({ task: 'plan', projectName: '__v36_verify__', projDir, project: fakeProject, plan: null, brief: 'b' });
check('plan prompt injects plan-fix.hint on regeneration',
  /PLAN REGENERATION — the previous plan FAILED validation/.test(planPromptHint)
  && /duplicate phase number n=1/.test(planPromptHint));
unlinkSync(join(projDir, '.guide', 'plan-fix.hint'));
const planPromptClean = await pr.buildGuidePrompt({ task: 'plan', projectName: '__v36_verify__', projDir, project: fakeProject, plan: null, brief: 'b' });
check('plan prompt is clean without a hint', !/PLAN REGENERATION/.test(planPromptClean));

check('coverage BLOCKER: one auto-regen with .coverage-regen-attempted as the budget',
  /\.coverage-regen-attempted/.test(arSrc)
  && /Regenerate plan \(coverage BLOCKER — one auto-retry\)/.test(arSrc)
  && /every brief FR is covered\. Do not drop existing phases/.test(arSrc));
check('coverage: second BLOCKER pauses; CLEAR releases the budget',
  /after one auto-regen — some brief requirements still have no corresponding phase/.test(arSrc)
  && /CLEAR — release the regen budget/.test(arSrc));

// ─── C. two-stage audit ──────────────────────────────────────────────────────
console.log(chalk.bold('\nC. two-stage audit'));

check('phase-runner exports AUDIT_PROMOTE_RULES / detectIncrementalAudit / both stage prompt builders',
  typeof pr.AUDIT_PROMOTE_RULES === 'string'
  && typeof pr.detectIncrementalAudit === 'function'
  && typeof pr.buildAuditScanPrompt === 'function'
  && typeof pr.buildAuditAdjudicatePrompt === 'function');

const scanOut = join(projDir, '.guide', 'audits', 'scan-x.md');
const scanP = pr.buildAuditScanPrompt({ projectName: 't', projDir, plan: null, scanOutPath: scanOut });
check('scan prompt: scanner-not-judge contract, CAND format, over-report, count footer',
  /SCANNER, not the judge/.test(scanP) && /### CAND-<n>/.test(scanP)
  && /OVER-report/.test(scanP) && /candidates: <count>/.test(scanP));
check('scan prompt forbids promote sections and Bug-N headings',
  /Do NOT use "Bug N"-style headings/.test(scanP)
  && /Do NOT write a final audit/.test(scanP));

const adjP = pr.buildAuditAdjudicatePrompt({ projectName: 't', projDir, plan: null, scanOutPath: scanOut, auditOutPath: join(projDir, '.guide', 'audits', 'audit-x.md') });
check('adjudicate prompt: candidate list is primary input, surgical file reads only',
  /ADJUDICATION stage/.test(adjP) && /scan-x\.md/.test(adjP) && /keep reads surgical/.test(adjP));
check('adjudicate prompt: killed-candidates section + v0.14.34 promote rules + clean line',
  /## Killed candidates/.test(adjP)
  && /ONLY CRITICAL and MAJOR/.test(adjP)
  && /nothing to promote — no CRITICAL or MAJOR findings/.test(adjP));

check('detectIncrementalAudit: null without a marker', (await pr.detectIncrementalAudit(projDir)) === null);
const ws = join(projDir, 'workspace');
mkdirSync(ws, { recursive: true });
execSync('git init -q && git config user.email v@v && git config user.name v', { cwd: ws });
writeFileSync(join(ws, 'a.js'), '1');
execSync('git add -A && git commit -qm one', { cwd: ws });
const sha1 = execSync('git rev-parse HEAD', { cwd: ws }).toString().trim();
writeFileSync(join(ws, 'b.js'), '2');
execSync('git add -A && git commit -qm two', { cwd: ws });
mkdirSync(join(projDir, '.guide', 'audits'), { recursive: true });
writeFileSync(join(projDir, '.guide', 'audits', 'audit-1.md'), '#');
writeFileSync(join(projDir, '.guide', 'audits', '.last-audit.json'), JSON.stringify({ sha: sha1 }));
const inc = await pr.detectIncrementalAudit(projDir);
check('detectIncrementalAudit: marker + prior audit + repo → diff scope',
  !!inc && inc.files.includes('b.js') && inc.sinceSha === sha1);

const prSrc = readSrc('src/lib/phase-runner.js');
// v0.14.48 note: branch refactored to compute auditWasIncremental once.
check('runGuide branches two-stage ONLY for full audits with two_stage enabled',
  /if \(task === 'audit'\) \{/.test(prSrc)
  && /auditWasIncremental = !!inc;/.test(prSrc)
  && /if \(!inc && cfg\.audit\?\.two_stage !== false\) \{\s*\n\s*return runTwoStageAudit/.test(prSrc));
check('two-stage: scan runs as its own task id, missing candidates file aborts, adjudicate stamps .last-audit.json',
  /task: 'audit-scan'/.test(prSrc)
  && /audit-scan produced no candidates file/.test(prSrc)
  && prSrc.indexOf('.last-audit.json', prSrc.indexOf('runTwoStageAudit')) > -1);

const defaults = JSON.parse(readSrc('config/defaults.json'));
check('defaults: audit.two_stage true; audit-scan + plan-validate model keys are sonnet',
  defaults.audit?.two_stage === true
  && defaults.models?.['audit-scan'] === 'claude-sonnet-4-6'
  && defaults.models?.['plan-validate'] === 'claude-sonnet-4-6');

// ─── D. failure-driven escalation ───────────────────────────────────────────
console.log(chalk.bold('\nD. failure-driven escalation'));

const routingCfg = JSON.parse(readSrc('config/model-routing.json'));
check('prefer_top_for_critical retired (false) in model-routing.json',
  routingCfg.user_preferences?.prefer_top_for_critical === false);

const { routeModel } = await import(resolve(REPO_ROOT, 'src/model-router.js'));
const liveCfg = { models: { 'dev-execution': 'claude-sonnet-4-6' }, model_routing: { enabled: true, tier_models: { sonnet: 'claude-sonnet-4-6', opus: 'claude-opus-4-8' } } };
const crit = await routeModel({ cfg: liveCfg, task: 'dev-execution', phaseMeta: { title: 'big refactor', max_turns: 120, acceptance_criteria: Array(15).fill('c'), files_expected: Array(20).fill('f') } });
check('critical complexity no longer escalates — stays sonnet',
  crit.tier === 'sonnet' && crit.complexity === 'critical', `tier=${crit.tier} complexity=${crit.complexity}`);
const reg = await routeModel({ cfg: liveCfg, task: 'dev-execution', phaseMeta: { title: 'FVU generator for 26Q', goal: 'NSDL FVU file' } });
check('narrow force_tier rules untouched — regulatory-core still opus', reg.tier === 'opus', `tier=${reg.tier}`);

check('runDev: escalation marker forces opus with a reasoning line; cleared on completion paths',
  // v0.14.38 note: was === 2 (both phase-completion paths); .38 added a third
  // cleanup at gate-pass (covers fixes). Invariant strengthened, pin relaxed.
  /escalate-opus\.marker/.test(prSrc)
  && /failure-driven escalation to opus \(marker present\)/.test(prSrc)
  && (prSrc.match(/fs\.unlink\(escalateMarkerPath\)\.catch/g) || []).length >= 2);
check('auto-runner writes the marker on dev failure',
  /escalate-opus\.marker/.test(arSrc)
  && /Escalation marker set: phase \$\{action\.phaseN\} re-runs on opus/.test(arSrc));

// ─── E. version ──────────────────────────────────────────────────────────────
console.log(chalk.bold('\nE. version'));
check('package.json version is 0.14.36', JSON.parse(readSrc('package.json')).version === '0.14.36');

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
