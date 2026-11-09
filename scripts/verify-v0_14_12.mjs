// v0.14.12 verifier — confirms the cmdRefine FK fix is present.
//
// Run with: node scripts/verify-v0_14_12.mjs
// Exits 0 on pass, 1 on fail.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import chalk from 'chalk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SOURCE = readFileSync(resolve(REPO_ROOT, 'src/commands/requirements.js'), 'utf8');

let passed = 0;
let failed = 0;
function check(label, ok, details) {
  if (ok) { console.log(chalk.green('  OK  '), label); passed += 1; }
  else    { console.log(chalk.red('  FAIL'), label, details ? chalk.dim(`— ${details}`) : ''); failed += 1; }
}

console.log(chalk.bold('\n── v0.14.12 verifier ──\n'));

// Confirm cmdRefine threads project=null for _inbox into runClaude.
// We look for the specific guard expression near a runClaude call.
const cmdRefineBlock = SOURCE.match(/export async function cmdRefine[\s\S]+?(?=\nexport |\Z)/m);
check('cmdRefine function found in source', !!cmdRefineBlock);

if (cmdRefineBlock) {
  const block = cmdRefineBlock[0];
  // Look for the guarded project value in the runClaude call args.
  const guarded = /project:\s*project\s*===\s*INBOX_PROJECT\s*\?\s*null\s*:\s*project/.test(block);
  check('cmdRefine passes project=null to runClaude when project === INBOX_PROJECT', guarded);

  // Negative: confirm the old broken shape `role: 'guide', project,` no longer
  // appears in cmdRefine. We allow the guarded shorthand-property-name form to
  // exist anywhere else in the file.
  const oldBroken = /role:\s*['"]guide['"],\s*project,\s*task:\s*['"]requirement-refine['"]/.test(block);
  check('old broken shape `role: guide, project, task: requirement-refine` is gone', !oldBroken);
}

// Confirm the reversed-args Next: hint at end of cmdRefine is fixed.
const reversedHint = /Next:\s*npm run req -- \$\{project\} list --status refined/.test(SOURCE);
check('`Next:` hint in cmdRefine uses verb-first form', !reversedHint);
const correctHint = /Next:\s*npm run req -- list \$\{project\} --status refined/.test(SOURCE);
check('`Next:` hint in cmdRefine matches expected verb-first shape', correctHint);

console.log();
if (failed === 0) {
  console.log(chalk.bold.green(`✓ All ${passed} checks passed.`));
  process.exit(0);
} else {
  console.log(chalk.bold.red(`✗ ${failed} failed, ${passed} passed.`));
  process.exit(1);
}
