// v0.14.38 verifier — proves the self-healing batch landed:
//
//   A. in-run opus auto-retry      — failures retry in-run, pause is the 2nd stop (3)
//   B. fix-scoped escalation       — markers cover fixes, cleared on gate pass (3)
//   C. validation-failed guards    — failing commits can't reconcile as done (5)
//   D. honest notifications        — labels, error_message, clean-audit = success (4)
//   E. version                     — 0.14.38 stamp (1)
//
// 16 checks total. checkpoint.js checks are functional; runner-loop logic is
// source-asserted. Imports checkpoint.js only — runs anywhere.
//
// Run with: node scripts/verify-v0_14_38.mjs

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
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

console.log(chalk.bold('\n── v0.14.38 verifier ──\n'));

const arSrc = readSrc('src/auto-runner.js');
const prSrc = readSrc('src/lib/phase-runner.js');
const defaults = JSON.parse(readSrc('config/defaults.json'));

// ─── A. in-run opus auto-retry ───────────────────────────────────────────────
console.log(chalk.bold('A. in-run opus auto-retry'));

check('first non-timeout dev/fix failure retries in-run (continue, no evaluatePause)',
  /const escalateRetryDone = new Set\(\);/.test(arSrc)
  && /in-run auto-retry on opus \(no pause/.test(arSrc)
  && /escalateRetryDone\.add\(escKey\);[\s\S]{0,400}continue; \/\/ skip evaluatePause/.test(arSrc));
check('timeouts excluded (stay with the reprompt flow); knob is auto_escalate_on_failure',
  /escIsTimeout = \/timed out after/.test(arSrc)
  && /ar\.auto_escalate_on_failure !== false/.test(arSrc)
  && /!escIsTimeout && !escalateRetryDone\.has\(escKey\)/.test(arSrc));
check('defaults: auto_run.auto_escalate_on_failure = true',
  defaults.auto_run?.auto_escalate_on_failure === true);

// ─── B. fix-scoped escalation markers ───────────────────────────────────────
console.log(chalk.bold('\nB. fix-scoped escalation markers'));

check('fix-dev failure writes a fix-scoped escalation marker',
  /fix-r\$\{action\.fix\.round\}-\$\{action\.fix\.n\}-escalate-opus\.marker/.test(arSrc)
  && /Escalation marker set: fix r/.test(arSrc));
check('runDev marker paths cover fixes AND phases (no more fix ? null)',
  /fix-r\$\{fix\.round\}-\$\{fix\.n\}-escalate-opus\.marker/.test(prSrc)
  && /phase-\$\{nextPhase\}-escalate-opus\.marker/.test(prSrc)
  && !/escalateMarkerPath = fix \? null/.test(prSrc));
check('gate pass clears BOTH markers (the cleanup point that covers fixes)',
  /result\.validator_outcome = gate;[\s\S]{0,500}fs\.unlink\(validationMarkerPath\)\.catch[\s\S]{0,100}fs\.unlink\(escalateMarkerPath\)\.catch/.test(prSrc));

// ─── C. validation-failed reconcile guards ──────────────────────────────────
console.log(chalk.bold('\nC. validation-failed reconcile guards'));

check('gate failure persists the excerpt to the validation-failed marker',
  /validation-failed\.marker/.test(prSrc)
  && /writeFile\(validationMarkerPath, gateFailureExcerpt\(gate\)/.test(prSrc));
check('next attempt gets the failure as forward-fix prompt context',
  /PREVIOUS ATTEMPT FAILED VALIDATORS/.test(prSrc)
  && /readText\(validationMarkerPath\)/.test(prSrc)
  && /fix FORWARD, do not revert unrelated work/.test(prSrc));
check('phase commit-reconcile blocked when the commit failed validation',
  /existingSha && await fileExists\(validationMarkerPath\)/.test(prSrc)
  && /not reconciling; re-running/.test(prSrc));
check('fix idempotency reconcile blocked when the commit failed validation',
  /wsStatus\.clean && !\(await fileExists\(validationMarkerPath\)\)/.test(prSrc));
check('pickBugAction self-heal skips fixes whose commit failed validation',
  /validation-failed\.marker/.test(arSrc)
  && /!vFailed && await fixCommitExists/.test(arSrc));

// ─── D. honest notifications ────────────────────────────────────────────────
console.log(chalk.bold('\nD. honest notifications'));

const { shouldPauseAfter } = await import(resolve(REPO_ROOT, 'src/checkpoint.js'));
const cfg = { auto_run: {} };
const rFix = shouldPauseAfter('phase-error', cfg, {
  phaseN: undefined, label: 'fix r2-3',
  error: 'fix r2-3 committed but failed the validator gate: validators failed: default:npm-test',
});
check('fix failures render with their label and the ORCHESTRATOR reason (no phase-undefined)',
  /^fix r2-3 reported errors: fix r2-3 committed but failed the validator gate/.test(rFix.reason)
  && !/undefined/.test(rFix.reason), rFix.reason);
const rUnatt = shouldPauseAfter('phase-error', cfg, { label: 'fix r1-1', error: 'boom', unattended: true });
check('unattended pause reason carries label + error (was a bare "phase-error")',
  /fix r1-1: boom/.test(rUnatt.reason), rUnatt.reason);
check('evaluatePause: error_message wins over the agent\'s "Done…" text; fix label built',
  /result\.error_message \|\| result\.result/.test(arSrc)
  && /`fix r\$\{action\.fix\.round\}-\$\{action\.fix\.n\}`/.test(arSrc));
check('clean-audit pipeline end reads as SUCCESS, not "chain stopped"',
  /✅ pipeline complete — audit came back clean, nothing to fix/.test(readSrc('src/server/job-runner.js')));

// ─── E. version ──────────────────────────────────────────────────────────────
console.log(chalk.bold('\nE. version'));
check('package.json version is 0.14.38', JSON.parse(readSrc('package.json')).version === '0.14.38');

console.log('');
if (failed === 0) {
  console.log(chalk.green.bold(`✓ All ${passed} checks passed.`));
  process.exit(0);
} else {
  console.log(chalk.red.bold(`✗ ${failed} failed, ${passed} passed.`));
  process.exit(1);
}
