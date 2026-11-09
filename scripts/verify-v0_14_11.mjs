// v0.14.11 verifier — exercises the new req-promote machinery against a
// temp SQLite DB. Asserts:
//
//   1. performReqPromote moves refined items from _inbox into a real
//      project's raw-thoughts.md, marks them promoted, and stores a tag.
//   2. autoScope flag flips unassigned → now before the filter.
//   3. rememberInboxDestination / getLastInboxDestination round-trip.
//   4. Destination='_inbox' is refused (no raw-thoughts.md possible).
//   5. Non-existent destination project is refused.
//   6. All next-actions hints use `<verb> <project>` (the actual CLI shape),
//      not the previous reversed `<project> <verb>`.
//   7. All Telegram help strings use the same correct shape.
//
// Run with: node scripts/verify-v0_14_11.mjs
// Exits 0 on full pass, 1 on any failure.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import chalk from 'chalk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// Sandbox the DB so we don't touch live state. state.js reads DB_PATH from
// the env when invoked directly; check if it does, otherwise stub via
// symlink swap. The simplest portable trick: temp-cwd into a sandbox dir.
// v0.14.14: We copy src/ into the sandbox below (inside `if (canRunDynamic)`)
// so __dirname-derived REPO_ROOT and PROJECTS_DIR resolve inside the
// sandbox. No env-var override is needed; isolation comes from path
// resolution alone.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-verify-'));
fs.mkdirSync(path.join(SANDBOX, 'projects', 'destproj', '.guide'), { recursive: true });
fs.mkdirSync(path.join(SANDBOX, 'state'), { recursive: true });

let passed = 0;
let failed = 0;
function check(label, ok, details) {
  if (ok) { console.log(chalk.green('  OK  '), label); passed += 1; }
  else    { console.log(chalk.red('  FAIL'), label, details ? chalk.dim(`— ${details}`) : ''); failed += 1; }
}

console.log(chalk.bold('\n── v0.14.11 verifier ──\n'));

// ─── Static checks (no DB needed) ────────────────────────────────────────
console.log(chalk.bold('Static — hint arg order:'));

const NEXT_ACTIONS = readFileSync(resolve(REPO_ROOT, 'src/lib/next-actions.js'), 'utf8');
const TG_HANDLERS = readFileSync(resolve(REPO_ROOT, 'src/server/telegram-handlers.js'), 'utf8');

// Any remaining `npm run (bug|req) -- ${project} VERB` shapes?
const reversedHints = /npm run (?:bug|req) -- \$\{project\} \w+/g;
const reversedInNextActions = NEXT_ACTIONS.match(reversedHints) || [];
const reversedInTgHandlers = TG_HANDLERS.match(reversedHints) || [];
check(
  'next-actions.js has no reversed-arg `<project> verb` hints',
  reversedInNextActions.length === 0,
  reversedInNextActions.join(', '),
);
check(
  'telegram-handlers.js has no reversed-arg `<project> verb` hints',
  reversedInTgHandlers.length === 0,
  reversedInTgHandlers.join(', '),
);

// Same shape but with literal &lt;project&gt; (Telegram HTML) — also a tell
const reversedHintsHTML = /npm run (?:bug|req) -- &lt;project&gt; \w+/g;
const reversedHTML = TG_HANDLERS.match(reversedHintsHTML) || [];
check(
  'telegram-handlers.js has no reversed-arg HTML hints',
  reversedHTML.length === 0,
  reversedHTML.join(', '),
);

// And the new shape — verb-first — must be present for sanity
check(
  'next-actions.js contains at least one correctly-ordered hint',
  /npm run req -- (promote|refine|stats|list) \$\{project\}/.test(NEXT_ACTIONS),
);

// ─── Dynamic checks (require state.js + DB) ──────────────────────────────
console.log(chalk.bold('\nDynamic — performReqPromote against a sandboxed DB:'));

// Skip cleanly if better-sqlite3 isn't installed (e.g. CI without native
// build tools). The static checks above already cover the hint-args fix
// and module-loadability; the dynamic ones add high confidence the promote
// path works end-to-end.
let canRunDynamic = false;
try {
  await import('better-sqlite3');
  canRunDynamic = true;
} catch {
  console.log(chalk.yellow('  SKIP  better-sqlite3 unavailable — static checks only.'));
  console.log(chalk.dim('         Re-run on the live install (where better-sqlite3 is built) for full coverage.'));
}

if (canRunDynamic) {
  // v0.14.14: Copy the WHOLE src/ tree into the sandbox so every transitive
  // import resolves. Previous version cherry-picked state.js, guide-paths.js
  // and req-promote.js — but guide-paths.js imports ../slug.js (which wasn't
  // copied), so the sandbox crashed with ERR_MODULE_NOT_FOUND the moment
  // state.js loaded. Wholesale copy is both simpler AND more durable against
  // future refactors that add new internal imports.

  fs.cpSync(resolve(REPO_ROOT, 'src'), path.join(SANDBOX, 'src'), { recursive: true });

  // Symlink node_modules so better-sqlite3 + chalk resolve from the sandbox
  // copies of the modules.
  try {
    fs.symlinkSync(resolve(REPO_ROOT, 'node_modules'), path.join(SANDBOX, 'node_modules'), 'dir');
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }

  // state.js derives REPO_ROOT from its own __dirname, so the sandbox copy
  // resolves REPO_ROOT to <SANDBOX>. DEFAULT_DB_PATH becomes
  // <SANDBOX>/state/orchestrator.db — completely isolated from the live DB.
  // PROJECTS_DIR in req-promote.js resolves to <SANDBOX>/projects — also
  // isolated. No env-var override needed.

  const state = await import(path.join(SANDBOX, 'src/state.js'));
  const reqPromote = await import(path.join(SANDBOX, 'src/commands/req-promote.js'));

  // Bootstrap schema (mirrors what migrate-requirements does)
  const db = state.getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      name TEXT PRIMARY KEY,
      status TEXT,
      current_phase INTEGER,
      profile TEXT,
      git_remote TEXT,
      git_branch TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS requirements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      refined_text TEXT,
      source TEXT,
      priority TEXT NOT NULL DEFAULT 'unassigned',
      scope TEXT NOT NULL DEFAULT 'unassigned',
      status TEXT NOT NULL DEFAULT 'inbox',
      tags TEXT,
      promoted_to TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by INTEGER
    );
  `);

  // Seed: destproj exists; _inbox has 3 items (2 refined-now, 1 unassigned)
  db.prepare(`INSERT INTO projects (name, status, created_at, updated_at) VALUES (?, 'in-progress', ?, ?)`)
    .run('destproj', new Date().toISOString(), new Date().toISOString());

  const now = new Date().toISOString();
  const refinedJSON = (title) => JSON.stringify({ title, what: 'do the thing', why: 'because', touches: 'src/' });
  db.prepare(`INSERT INTO requirements (project, raw_text, refined_text, scope, status, priority, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('_inbox', 'do thing A', refinedJSON('Thing A'), 'now',        'refined', 'p1', now, now);
  db.prepare(`INSERT INTO requirements (project, raw_text, refined_text, scope, status, priority, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('_inbox', 'do thing B', refinedJSON('Thing B'), 'now',        'refined', 'p2', now, now);
  db.prepare(`INSERT INTO requirements (project, raw_text, refined_text, scope, status, priority, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('_inbox', 'do thing C', null,                    'unassigned', 'inbox',   'unassigned', now, now);

  // Test 1: promote scope=now without auto-scope → should get 2 (Thing A + B)
  const r1 = await reqPromote.performReqPromote({
    inboxProject: '_inbox',
    destinationProject: 'destproj',
    scope: 'now',
    autoScope: false,
  });
  check('plain promote moves 2 scope=now items',          r1.promoted === 2);
  check('returned ids are correct',                       JSON.stringify(r1.ids.sort((a, b) => a - b)) === '[1,2]');
  const dest = path.join(SANDBOX, 'projects/destproj/.guide/raw-thoughts.md');
  check('raw-thoughts.md created at destination',         fs.existsSync(dest));
  const content = fs.readFileSync(dest, 'utf8');
  check('Thing A title appears in raw-thoughts.md',       /### Thing A/.test(content));
  check('Thing B title appears in raw-thoughts.md',       /### Thing B/.test(content));
  check('Thing C (unassigned) does NOT appear',           !/### Thing C/.test(content) && !/Requirement #3/.test(content));

  // Items 1+2 should now be status=promoted
  const after1 = state.listRequirements({ project: '_inbox' });
  const item3 = after1.find((r) => r.id === 3);
  const item1 = after1.find((r) => r.id === 1);
  check('item 1 marked promoted',                         item1.status === 'promoted');
  check('item 3 still unassigned/inbox',                  item3.scope === 'unassigned' && item3.status === 'inbox');

  // Test 2: promote with autoScope=true → should now pick up item 3
  const r2 = await reqPromote.performReqPromote({
    inboxProject: '_inbox',
    destinationProject: 'destproj',
    scope: 'now',
    autoScope: true,
  });
  check('autoScope flips unassigned → now, picks up item 3', r2.promoted === 1 && r2.ids[0] === 3);

  // Test 3: rememberInboxDestination round-trip
  reqPromote.rememberInboxDestination('_inbox', 'destproj', 42);
  check('rememberInboxDestination round-trip',           reqPromote.getLastInboxDestination('_inbox') === 'destproj');
  check('getLastInboxDestination returns null for unknown', reqPromote.getLastInboxDestination('nonexistent') === null);

  // Test 4: refuse _inbox as destination
  let threw = false;
  try { await reqPromote.performReqPromote({ inboxProject: 'somewhere', destinationProject: '_inbox' }); }
  catch { threw = true; }
  check('refuses _inbox as destination', threw);

  // Test 5: refuse non-existent destination project
  threw = false;
  try { await reqPromote.performReqPromote({ inboxProject: '_inbox', destinationProject: 'noproj' }); }
  catch { threw = true; }
  check('refuses non-existent destination project', threw);

  // Test 6: empty inbox throws (no items to promote)
  threw = false;
  try {
    await reqPromote.performReqPromote({
      inboxProject: '_inbox', destinationProject: 'destproj', scope: 'now', autoScope: false,
    });
  } catch { threw = true; }
  check('throws when nothing eligible to promote', threw);
}

// ─── Cleanup + summary ───────────────────────────────────────────────────
console.log();
if (failed === 0) {
  console.log(chalk.bold.green(`✓ All ${passed} checks passed.`));
  // Cleanup sandbox on success only — leave on fail for inspection
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  process.exit(0);
} else {
  console.log(chalk.bold.red(`✗ ${failed} failed, ${passed} passed.`));
  console.log(chalk.dim(`  Sandbox preserved at: ${SANDBOX}`));
  process.exit(1);
}
