// v0.14.41 verifier — brief-flow audit fixes. 6 checks (1 functional).
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import chalk from 'chalk';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0; let failed = 0;
function check(label, ok, details) {
  if (ok) { console.log(chalk.green('  OK  '), label); passed += 1; }
  else { console.log(chalk.red('  FAIL'), label, details ? chalk.dim(`— ${details}`) : ''); failed += 1; }
}
const readSrc = (rel) => { const p = resolve(REPO_ROOT, rel); if (!existsSync(p)) throw new Error(`Missing: ${rel}`); return readFileSync(p, 'utf8'); };

console.log(chalk.bold('\n── v0.14.41 verifier ──\n'));
const pl = readSrc('src/pipeline.js');
const ar = readSrc('src/auto-runner.js');

check('pipeline: brief-author result checked — failure stops at the brief stage with the real reason',
  /briefRes = await runGuide\(\{ projectName, task: 'brief-author' \}\)/.test(pl)
  && /brief-author failed:/.test(pl));
check('pipeline: plan result checked AND routed through the shared structural gate',
  /planRes = await runGuide\(\{ projectName, task: 'plan' \}\)/.test(pl)
  && /plan failed:/.test(pl)
  && /ensureValidPlan\(\{ projectName, projDir \}\)/.test(pl));
check('auto-runner exports ensureValidPlan; executeAction uses it (single source for the gate)',
  /export async function ensureValidPlan/.test(ar)
  && /const ev = await ensureValidPlan\(\{ projectName, projDir, brief, slot \}\);/.test(ar));

const am = await import(resolve(REPO_ROOT, 'src/auto-runner.js'));
const projDir = mkdtempSync(join(tmpdir(), 'v41-'));
mkdirSync(join(projDir, '.guide'), { recursive: true });
const miss = await am.ensureValidPlan({ projectName: '__v41__', projDir });
writeFileSync(join(projDir, '.guide', 'plan.json'), JSON.stringify({ phases: [{ n: 1, title: 'a', goal: 'g', acceptance_criteria: ['c'] }] }));
const good = await am.ensureValidPlan({ projectName: '__v41__', projDir });
check('ensureValidPlan: missing plan → honest error; valid plan → ok with parsed plan',
  miss.ok === false && /missing or unparseable/.test(miss.error)
  && good.ok === true && good.plan?.phases?.length === 1);

check('no fire-and-forget runGuide remains anywhere in the three drivers (hardened pattern)',
  ![readSrc('src/server/job-runner.js'), readSrc('src/orchestrator.js'), pl].some((src) =>
    /(?:^\s*|\{\s*)await runGuide\(/m.test(src)));
check('package.json version is 0.14.41', JSON.parse(readSrc('package.json')).version === '0.14.41');

console.log('');
if (failed === 0) { console.log(chalk.green.bold(`✓ All ${passed} checks passed.`)); process.exit(0); }
console.log(chalk.red.bold(`✗ ${failed} failed, ${passed} passed.`)); process.exit(1);
