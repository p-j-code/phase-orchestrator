// v0.14.46 verifier — clean-audit message surfaces a completed-but-unshipped
// round (QA-pending). 4 checks, source-asserted. Runs anywhere.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import chalk from 'chalk';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0; let failed = 0;
function check(label, ok, details) {
  if (ok) { console.log(chalk.green('  OK  '), label); passed += 1; }
  else { console.log(chalk.red('  FAIL'), label, details ? chalk.dim(`— ${details}`) : ''); failed += 1; }
}
const readSrc = (rel) => { const p = resolve(REPO_ROOT, rel); if (!existsSync(p)) throw new Error(`Missing: ${rel}`); return readFileSync(p, 'utf8'); };

console.log(chalk.bold('\n── v0.14.46 verifier ──\n'));
const jr = readSrc('src/server/job-runner.js');

check('clean-audit branch checks the most recent round status + unshipped branch',
  /const lastRound = hr > 0 \? getBugRound\(project, hr\) : null;/.test(jr)
  && /const unshipped = !!proj\?\.git_branch && proj\.git_branch !== 'main';/.test(jr));
check('QA note only when the last round is completed AND unshipped',
  /lastRound\?\.status === 'completed' && unshipped/.test(jr)
  && /is fixed and awaiting your re-test/.test(jr));
check('note is appended to the existing ✅ terminal message, best-effort (try/catch)',
  /\+ qaNote;/.test(jr)
  && /\/\* note is best-effort \*\//.test(jr)
  && jr.indexOf('let qaNote') < jr.indexOf('+ qaNote;'));
check('package.json version is 0.14.46', JSON.parse(readSrc('package.json')).version === '0.14.46');

console.log('');
if (failed === 0) { console.log(chalk.green.bold(`✓ All ${passed} checks passed.`)); process.exit(0); }
console.log(chalk.red.bold(`✗ ${failed} failed, ${passed} passed.`)); process.exit(1);
