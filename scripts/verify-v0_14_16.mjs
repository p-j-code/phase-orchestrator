// v0.14.16 verifier — two fixes folded into one release.
//
// 1. `calls.session_id` FK violation when refining _inbox: v0.14.12's
//    cmdRefine fix passed project=null to runClaude (correct), but
//    claude-runner's recordCall still threaded the returnedSessionId
//    into calls.session_id — which FK-points at sessions(session_id),
//    and we never upserted a sessions row because project was null.
//    So the INSERT fired AFTER Sonnet succeeded and aborted the
//    refinement loop. v0.14.16 gates session_id on project at the
//    recordCall sites.
//
// 2. Worker pool's executeJob dispatcher had cases for go/resume/audit/
//    bugs/roadmap/ship but not brief/guide/next/review/handoff/qa —
//    yet TELEGRAM_BOT.md (v0.14.13) documents all of them as valid
//    actions. So /req_promote --plan (which queues brief + guide)
//    crashed both jobs with "Unknown action". v0.14.16 adds the
//    missing cases.
//
// Run with: node scripts/verify-v0_14_16.mjs
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
  else    { console.log(chalk.red('  FAIL'), label, details ? chalk.dim(`— ${details}`) : ''); failed += 1; }
}

function readSrc(rel) {
  const p = resolve(REPO_ROOT, rel);
  if (!existsSync(p)) throw new Error(`Missing file: ${rel}`);
  return readFileSync(p, 'utf8');
}

console.log(chalk.bold('\n── v0.14.16 verifier ──\n'));

// ─── Part 1: calls.session_id FK gating in claude-runner ─────────────────
console.log(chalk.bold('claude-runner — recordCall session_id gating:'));

const RUNNER = readSrc('src/claude-runner.js');

// The success-path recordCall must gate session_id on project. Two acceptable
// shapes:
//   const recordSessionId = project ? returnedSessionId : null;
//   session_id: recordSessionId
// OR inline:
//   session_id: project ? returnedSessionId : null
check(
  'success-path recordCall gates session_id on project',
  /project\s*\?\s*returnedSessionId\s*:\s*null/.test(RUNNER),
);

// The failure-path recordCall must also gate (defense in depth)
check(
  'failure-path recordCall gates session_id on project too',
  /project\s*\?\s*\(?sessionId\s*\|\|\s*null\)?\s*:\s*null/.test(RUNNER),
);

// Negative: no remaining `recordCall(...)` invocation with the unguarded
// `session_id: returnedSessionId` shape — that would mean the success-path
// bug is back. The other use site (`upsertSession({ session_id:
// returnedSessionId, ... })`) is correctly guarded by the surrounding
// `if (... && project)` block, so we tolerate that.
const recordCallBlocks = RUNNER.match(/recordCall\(\{[\s\S]+?\}\)/g) || [];
const unguardedInRecordCall = recordCallBlocks.some((b) =>
  /\bsession_id:\s*returnedSessionId\b/.test(b)
);
check('no unguarded `session_id: returnedSessionId` in recordCall', !unguardedInRecordCall);

// ─── Part 2: dispatcher cases for documented /run actions ────────────────
console.log(chalk.bold('\njob-runner — dispatcher case coverage:'));

const RUNNER_JOB = readSrc('src/server/job-runner.js');
const requiredCases = ['go', 'resume', 'audit', 'bugs', 'roadmap', 'ship',
                       'brief', 'guide', 'next', 'review', 'handoff', 'qa'];

for (const action of requiredCases) {
  const re = new RegExp(`case\\s+['"]${action}['"]\\s*:`);
  check(`dispatcher has case '${action}'`, re.test(RUNNER_JOB));
}

// Confirm the "Unknown action" default branch still exists — it's the
// safety net for actions we haven't added yet.
check(
  'dispatcher still throws on unknown action',
  /throw new Error\(`Unknown action: \$\{action\}`\)/.test(RUNNER_JOB),
);

// ─── Part 3: docs ↔ dispatcher consistency ───────────────────────────────
console.log(chalk.bold('\nTELEGRAM_BOT.md ↔ dispatcher consistency:'));

const TG_DOC = readSrc('docs/TELEGRAM_BOT.md');
// Find the "Actions for /run and /queue: …" line and parse the comma-list
const actionsLine = TG_DOC.match(/Actions for `\/run`[^:]*:\s*([^.\n]+)/);
if (!actionsLine) {
  check('TELEGRAM_BOT.md has an "Actions for /run" line', false);
} else {
  check('TELEGRAM_BOT.md has an "Actions for /run" line', true);
  const documentedActions = actionsLine[1]
    .split(',')
    .map((s) => s.trim().replace(/`/g, ''))
    .filter(Boolean);
  const undispatched = documentedActions.filter((a) => {
    const re = new RegExp(`case\\s+['"]${a}['"]\\s*:`);
    return !re.test(RUNNER_JOB);
  });
  check(
    'every documented action has a dispatcher case',
    undispatched.length === 0,
    undispatched.length ? `missing: ${undispatched.join(', ')}` : null,
  );
}

// ─── Summary ─────────────────────────────────────────────────────────────
console.log();
if (failed === 0) {
  console.log(chalk.bold.green(`✓ All ${passed} checks passed.`));
  process.exit(0);
} else {
  console.log(chalk.bold.red(`✗ ${failed} failed, ${passed} passed.`));
  process.exit(1);
}
