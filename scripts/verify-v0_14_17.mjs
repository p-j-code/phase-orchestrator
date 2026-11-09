// v0.14.17 verifier — enforces three-way sync of the /run actions list
// across:
//   1. VALID_ACTIONS array in src/server/telegram-handlers.js
//      (pre-enqueue allowlist used by handleRun / handleQueue)
//   2. executeJob switch cases in src/server/job-runner.js
//      (the actual dispatcher)
//   3. "Actions for /run and /queue" line in docs/TELEGRAM_BOT.md
//
// Drift between these is the bug class that hit on v0.14.16:
// - v0.14.13 added 6 actions to (3) (docs).
// - v0.14.16 added the same 6 cases to (2) (dispatcher).
// - v0.14.17 added them to (1) (handler allowlist).
//
// Pre-v0.14.17 the user ran `/run brief billflow-tds` and got back
// "Actions: go, resume, audit, bugs, roadmap, ship" because (1) was
// still v0.14.0's frozen list — even though (2) and (3) had moved on.
//
// Also enforces /start banner consistency and the high-value action
// coverage (brief, guide must be present everywhere).
//
// Run with: node scripts/verify-v0_14_17.mjs
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

console.log(chalk.bold('\n── v0.14.17 verifier ──\n'));

const HANDLERS = readSrc('src/server/telegram-handlers.js');
const RUNNER = readSrc('src/server/job-runner.js');
const TG_DOC = readSrc('docs/TELEGRAM_BOT.md');

// ─── Extract the three lists ─────────────────────────────────────────────

// 1. VALID_ACTIONS from telegram-handlers.js
const validActionsMatch = HANDLERS.match(/const VALID_ACTIONS\s*=\s*\[([\s\S]+?)\]/);
const validActions = validActionsMatch
  ? validActionsMatch[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)
  : [];

// 2. case 'X': blocks in src/server/job-runner.js executeJob
// [\w-] (not \w) so hyphenated action names like 'reset-brief' are captured.
const dispatcherCases = [...RUNNER.matchAll(/case\s+['"]([\w-]+)['"]\s*:/g)].map((m) => m[1]);
// De-dup (go/resume share a case)
const dispatcherActions = [...new Set(dispatcherCases)];

// 3. Docs "Actions for /run and /queue" line
const docsLine = TG_DOC.match(/Actions for `\/run`[^:]*:\s*([^.\n]+)/);
const docsActions = docsLine
  ? docsLine[1].split(',').map((s) => s.trim().replace(/`/g, '')).filter(Boolean)
  : [];

console.log(chalk.dim(`  handler VALID_ACTIONS:  [${validActions.join(', ')}]`));
console.log(chalk.dim(`  dispatcher cases:       [${dispatcherActions.join(', ')}]`));
console.log(chalk.dim(`  docs Actions line:      [${docsActions.join(', ')}]`));
console.log();

// ─── Each list non-empty + has minimum sanity ────────────────────────────
console.log(chalk.bold('Each list extracted:'));
check('VALID_ACTIONS extracted from handlers',     validActions.length > 0);
check('dispatcher cases extracted from job-runner', dispatcherActions.length > 0);
check('Actions line extracted from docs',          docsActions.length > 0);

// ─── Three-way sync ──────────────────────────────────────────────────────
console.log(chalk.bold('\nThree-way sync:'));

const validSet = new Set(validActions);
const dispatcherSet = new Set(dispatcherActions);
const docsSet = new Set(docsActions);

// Handler missing actions that docs/dispatcher have
const handlerMissing = [...docsSet].filter((a) => !validSet.has(a))
  .concat([...dispatcherSet].filter((a) => !validSet.has(a)));
check(
  'VALID_ACTIONS covers every documented and dispatched action',
  handlerMissing.length === 0,
  handlerMissing.length ? `missing from handler: ${[...new Set(handlerMissing)].join(', ')}` : null,
);

// Dispatcher missing actions that handler/docs have
const dispatcherMissing = [...validSet].filter((a) => !dispatcherSet.has(a))
  .concat([...docsSet].filter((a) => !dispatcherSet.has(a)));
check(
  'dispatcher cases cover every valid and documented action',
  dispatcherMissing.length === 0,
  dispatcherMissing.length ? `missing from dispatcher: ${[...new Set(dispatcherMissing)].join(', ')}` : null,
);

// Docs missing actions that handler/dispatcher have
const docsMissing = [...validSet].filter((a) => !docsSet.has(a))
  .concat([...dispatcherSet].filter((a) => !docsSet.has(a)));
check(
  'docs cover every valid and dispatched action',
  docsMissing.length === 0,
  docsMissing.length ? `missing from docs: ${[...new Set(docsMissing)].join(', ')}` : null,
);

// ─── /start banner has the same list ─────────────────────────────────────
console.log(chalk.bold('\n/start banner alignment:'));
const startBannerLine = HANDLERS.match(/Actions for \/run:\s*([^<\n]+?)<\/i>/);
if (!startBannerLine) {
  check('/start banner has an "Actions for /run" line', false);
} else {
  check('/start banner has an "Actions for /run" line', true);
  const bannerActions = startBannerLine[1].split(',').map((s) => s.trim()).filter(Boolean);
  const bannerSet = new Set(bannerActions);
  const bannerMissing = [...validSet].filter((a) => !bannerSet.has(a));
  check(
    '/start banner lists every action in VALID_ACTIONS',
    bannerMissing.length === 0,
    bannerMissing.length ? `missing from banner: ${bannerMissing.join(', ')}` : null,
  );
}

// ─── Sanity: the v0.14.x must-haves ──────────────────────────────────────
console.log(chalk.bold('\nKey actions present in handler allowlist:'));
for (const a of ['go', 'brief', 'guide', 'audit', 'bugs', 'ship']) {
  check(`/run ${a} accepted by handler`, validSet.has(a));
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
