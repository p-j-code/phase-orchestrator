// v0.14.39 verifier — chain audits fail honestly instead of masquerading as
// "duplicate audit". 7 checks. Source-asserted (the swallow was a control-flow
// bug in two job drivers); runs anywhere.
//
// Run with: node scripts/verify-v0_14_39.mjs
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import chalk from 'chalk';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0; let failed = 0;
function check(label, ok, details) {
  if (ok) { console.log(chalk.green('  OK  '), label); passed += 1; }
  else    { console.log(chalk.red('  FAIL'), label, details ? chalk.dim(`— ${details}`) : ''); failed += 1; }
}
const readSrc = (rel) => { const p = resolve(REPO_ROOT, rel); if (!existsSync(p)) throw new Error(`Missing: ${rel}`); return readFileSync(p, 'utf8'); };

console.log(chalk.bold('\n── v0.14.39 verifier ──\n'));
const jr = readSrc('src/server/job-runner.js');
const pl = readSrc('src/pipeline.js');

check('job-runner: initial chain audit result captured and checked',
  /const initialAudit = await runGuide\(\{ projectName: project, task: 'audit' \}\);/.test(jr)
  && /initialAudit\?\.is_error/.test(jr)
  && /throw new Error\(`audit failed: /.test(jr));
check('job-runner: NO remaining fire-and-forget audit calls in the chain',
  !/^\s*await runGuide\(\{ projectName: project, task: 'audit' \}\);$/m.test(jr));
check('job-runner: re-audit failure stops the chain with the REAL reason (not "duplicate")',
  /const reAudit = await runGuide\(\{ projectName: project, task: 'audit' \}\);/.test(jr)
  && /audit failed on round \$\{i \+ 1\}/.test(jr)
  && /reAudit\?\.is_error/.test(jr));
check('job-runner: stoppedReason path breaks BEFORE promoteAuditToBugs runs',
  jr.indexOf('audit failed on round') < jr.indexOf('const promo = await promoteAuditToBugs'));
check('pipeline: audit result captured; is_error returns a stoppedAt with the failure',
  /let auditRes;/.test(pl)
  && /auditRes\?\.is_error/.test(pl)
  && /audit failed \(round \$\{i \+ 1\}\)/.test(pl));
check('pipeline: preflight-throw handling preserved',
  /catch \(e\) \{ if \(e\?\.is_preflight_error\) return gitStop\(e\); throw e; \}/.test(pl));
check('package.json version is 0.14.39', JSON.parse(readSrc('package.json')).version === '0.14.39');

console.log('');
if (failed === 0) { console.log(chalk.green.bold(`✓ All ${passed} checks passed.`)); process.exit(0); }
console.log(chalk.red.bold(`✗ ${failed} failed, ${passed} passed.`)); process.exit(1);
