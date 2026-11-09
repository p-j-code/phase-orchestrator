// v0.14.32 pause-routing verifier — proves classifyPauseReason + consumers are wired correctly.
//
// Run with: node scripts/verify-v0_14_32-pause-routing.mjs
// Exits 0 on full pass, 1 on any failure.

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
  else     { console.log(chalk.red('  FAIL'), label, details ? chalk.dim(`— ${details}`) : ''); failed += 1; }
}

function readSrc(rel) {
  const p = resolve(REPO_ROOT, rel);
  if (!existsSync(p)) throw new Error(`Missing file: ${rel}`);
  return readFileSync(p, 'utf8');
}

console.log(chalk.bold('\n── v0.14.32 pause-routing verifier ──\n'));

// ─── 1. pause-classifier.js exists and exports ──────────────────────────────
check(
  'src/lib/pause-classifier.js exists',
  existsSync(resolve(REPO_ROOT, 'src/lib/pause-classifier.js')),
);

const { classifyPauseReason, PAUSE_KINDS } = await import(resolve(REPO_ROOT, 'src/lib/pause-classifier.js'));
check('pause-classifier.js exports classifyPauseReason', typeof classifyPauseReason === 'function');
check('pause-classifier.js exports PAUSE_KINDS', typeof PAUSE_KINDS === 'object' && PAUSE_KINDS !== null);

// ─── 2. Classification matrix ───────────────────────────────────────────────
const matrix = [
  ['All 5 phases + final review complete. Run manual QA, then drop bugs-round-1.md', PAUSE_KINDS.ALL_PHASES_COMPLETE],
  ['All 3 phases + final review complete. Run manual QA, then drop bugs-round-1.md or run "qa --shipped".', PAUSE_KINDS.ALL_PHASES_COMPLETE],
  ['Fix round 1 complete (3 fixes). Re-test, then drop bugs-round-2.md...', PAUSE_KINDS.FIX_ROUND_COMPLETE],
  ['fix round complete, ready for QA re-verification', PAUSE_KINDS.FIX_ROUND_COMPLETE],
  ['budget: monthly_calls exceeded. Bump max_total_calls...', PAUSE_KINDS.BUDGET],
  ['budget pause: 85 calls in last 5h', PAUSE_KINDS.BUDGET],
  ['budget warn: 52 calls in last 5h (warn threshold)', PAUSE_KINDS.BUDGET],
  ['validators failed', PAUSE_KINDS.VALIDATOR_FAILED],
  ['validator: smoke-test.mjs exited with code 1', PAUSE_KINDS.VALIDATOR_FAILED],
  ['auto_pause_after_phase_1 (verify foundation before continuing)', PAUSE_KINDS.REVIEW_CHECKPOINT],
  ['auto_pause_after_review (review at phase 3 done, verify before continuing)', PAUSE_KINDS.REVIEW_CHECKPOINT],
  ['max_phases_per_run (5) hit', PAUSE_KINDS.MAX_ACTIONS],
  ['phase-3 reported errors: exit code 1', PAUSE_KINDS.MID_BUILD],
  ['phase-error', PAUSE_KINDS.MID_BUILD],
];

for (const [reason, expected] of matrix) {
  const got = classifyPauseReason(reason);
  const label = `classifyPauseReason("${reason.slice(0, 55)}...") → "${expected}"`;
  check(label, got === expected, got !== expected ? `got "${got}"` : undefined);
}

// ─── 3. coach.js imports pause-classifier ───────────────────────────────────
const coachSrc = readSrc('src/lib/coach.js');
check('coach.js imports pause-classifier', coachSrc.includes('pause-classifier'));
check('coach.js uses PAUSE_KINDS or classifyPauseReason',
  coachSrc.includes('PAUSE_KINDS') || coachSrc.includes('classifyPauseReason'));

// ─── 4. coach.js no longer uses the old isComplete substring detection ───────
check(
  "coach.js no longer has isComplete substring match for 'all'+'phases'",
  !coachSrc.includes("reasonLow.includes('all') && reasonLow.includes('phases')"),
);

// ─── 5. coach.js has a fix-round-complete branch ────────────────────────────
check(
  'coach.js has FIX_ROUND_COMPLETE case',
  coachSrc.includes('FIX_ROUND_COMPLETE') || coachSrc.includes("'fix-round-complete'"),
);

// ─── 6. next-actions.js imports pause-classifier ────────────────────────────
const naSrc = readSrc('src/lib/next-actions.js');
check('next-actions.js imports pause-classifier', naSrc.includes('pause-classifier'));
check('next-actions.js uses PAUSE_KINDS or classifyPauseReason',
  naSrc.includes('PAUSE_KINDS') || naSrc.includes('classifyPauseReason'));

// ─── 7. next-actions.js auto-run-paused case branches on pause kind ──────────
check(
  'next-actions.js auto-run-paused case branches on ALL_PHASES_COMPLETE',
  naSrc.includes('ALL_PHASES_COMPLETE') || naSrc.includes("'all-phases-complete'"),
);
check(
  'next-actions.js auto-run-paused case branches on FIX_ROUND_COMPLETE',
  naSrc.includes('FIX_ROUND_COMPLETE') || naSrc.includes("'fix-round-complete'"),
);

// ─── 8. migrate-pause-kind.js exists and mentions pause_kind ────────────────
const migSrc = readSrc('src/migrate-pause-kind.js');
check('migrate-pause-kind.js adds pause_kind column', migSrc.includes('pause_kind'));

// ─── 9. migrate-all.js wires in migrate-pause-kind ──────────────────────────
const migAllSrc = readSrc('src/migrate-all.js');
check('migrate-all.js imports migrate-pause-kind', migAllSrc.includes('migrate-pause-kind'));

// ─── 10. state.js pauseAutoRun accepts pauseKind param ──────────────────────
const stateSrc = readSrc('src/state.js');
check(
  'state.js pauseAutoRun accepts pauseKind param',
  stateSrc.includes('pauseKind') && stateSrc.includes('pause_kind'),
);

// ─── 11. auto-runner.js imports classifier and uses PAUSE_KINDS ─────────────
const arSrc = readSrc('src/auto-runner.js');
check('auto-runner.js imports pause-classifier', arSrc.includes('pause-classifier'));
check('auto-runner.js uses PAUSE_KINDS.MAX_ACTIONS', arSrc.includes('PAUSE_KINDS.MAX_ACTIONS'));
check('auto-runner.js uses PAUSE_KINDS.BUDGET', arSrc.includes('PAUSE_KINDS.BUDGET'));
check('auto-runner.js finalize returns pauseKind', arSrc.includes('pauseKind: status'));

// ─── 12. job-runner.js passes pauseKind through to baseState ────────────────
const jrSrc = readSrc('src/server/job-runner.js');
check('job-runner.js passes pauseKind to baseState', jrSrc.includes('pauseKind: result?.pauseKind'));

// ─── Summary ────────────────────────────────────────────────────────────────
console.log('');
if (failed === 0) {
  console.log(chalk.bold.green(`✓ All ${passed} checks passed.`));
  process.exit(0);
} else {
  console.log(chalk.bold.red(`✗ ${failed} failed, ${passed} passed.`));
  process.exit(1);
}
