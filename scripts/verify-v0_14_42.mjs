// v0.14.42 verifier — audit ×N chains drain pending manual bugs rounds on
// clean audits instead of ending past them. 6 checks.
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

console.log(chalk.bold('\n── v0.14.42 verifier ──\n'));
const jr = readSrc('src/server/job-runner.js');
const oc = readSrc('src/orchestrator.js');

check('detectNewBugRound is exported from auto-runner',
  /export async function detectNewBugRound/.test(readSrc('src/auto-runner.js')));
check('server chain: clean audit checks for a pending manual round BEFORE declaring done',
  /const pending = await detectNewBugRound\(projDir, project\);/.test(jr)
  && jr.indexOf('const pending = await detectNewBugRound') < jr.indexOf('✅ pipeline complete — audit came back clean'));
check('server chain: pending round drains via unattended autoRun, then loop re-audits (continue)',
  /pending manual <b>bugs round \$\{pending\.round\}<\/b> detected — running fixes/.test(jr)
  && /if \(!drainedCleanly\) break;[\s\S]{0,120}continue; \/\/ re-audit next iteration/.test(jr));
check('CLI chain parity: same drain before "audit is fine"',
  /detectNewBugRound\(projDir, projectName\);/.test(oc)
  && oc.indexOf('pending manual bugs round') < oc.indexOf('Pipeline stopped (audit is fine)'));

// Functional: detectNewBugRound sees a dropped bugs.md (needsPlan) — the
// exact state the operator creates by hand.
const am = await import(resolve(REPO_ROOT, 'src/auto-runner.js'));
const projDir = mkdtempSync(join(tmpdir(), 'v42-'));
mkdirSync(join(projDir, '.guide', 'bug-rounds', 'round-4'), { recursive: true });
writeFileSync(join(projDir, '.guide', 'bug-rounds', 'round-4', 'bugs.md'), '### Bug #1 — x\n**Steps to reproduce:** s\n');
const det = await am.detectNewBugRound(projDir, '__v42__');
check('dropped bugs.md (no plan, no SQL row) → { round, needsPlan: true }',
  det?.round === 4 && det?.needsPlan === true, JSON.stringify(det));

check('package.json version is 0.14.42', JSON.parse(readSrc('package.json')).version === '0.14.42');
console.log('');
if (failed === 0) { console.log(chalk.green.bold(`✓ All ${passed} checks passed.`)); process.exit(0); }
console.log(chalk.red.bold(`✗ ${failed} failed, ${passed} passed.`)); process.exit(1);
