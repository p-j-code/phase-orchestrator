// v0.14.15 verifier — keeps the Telegram /-autocomplete menu, the
// bot.command(...) registrations, and the docs from drifting apart.
//
// Run with: node scripts/verify-v0_14_15.mjs
// Exits 0 on full pass, 1 on any failure.
//
// Coverage:
//   1. command-menu.js loads + exports COMMAND_MENU + registerCommandMenu.
//   2. Every menu entry has a corresponding bot.command(...) registration
//      in src/server.js (no menu entries point at non-existent commands).
//   3. server.js actually calls registerCommandMenu(bot) at boot.
//   4. Menu doesn't contain duplicates.
//   5. Every menu entry has both a `command` (lowercase, no /) and a
//      `description` (1–256 chars per Telegram's limit).
//   6. The high-value v0.14.x commands the previous BotFather menu was
//      missing — /req_promote, /bug_promote, /triage, /preview, /sync,
//      /ship — are all in the new menu.

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

console.log(chalk.bold('\n── v0.14.15 verifier ──\n'));

// ─── 1. command-menu.js loads and exports the expected symbols ───────────
console.log(chalk.bold('Module surface:'));

let menuModule;
try {
  menuModule = await import(resolve(REPO_ROOT, 'src/lib/command-menu.js'));
} catch (err) {
  check('command-menu.js loads cleanly', false, err.message);
  process.exit(1);
}
check('command-menu.js loads cleanly', true);
check('exports COMMAND_MENU array',     Array.isArray(menuModule.COMMAND_MENU));
check('exports registerCommandMenu fn', typeof menuModule.registerCommandMenu === 'function');
check('exports menuCommandNames fn',    typeof menuModule.menuCommandNames === 'function');

const menu = menuModule.COMMAND_MENU || [];
check('menu has at least 10 entries (real menu, not empty stub)', menu.length >= 10);
check('menu has at most 26 entries (mobile usability)',           menu.length <= 26);

// ─── 2. Every menu entry maps to a real bot.command(...) ─────────────────
console.log(chalk.bold('\nMenu ↔ bot.command coverage:'));

const SERVER = readSrc('src/server.js');
// Capture both scalar and array registration forms.
const cmdRegex = /bot\.command\(\s*(?:'([^']+)'|\[([^\]]+)\])/g;
const registeredCommands = new Set();
let m;
while ((m = cmdRegex.exec(SERVER)) !== null) {
  if (m[1]) {
    registeredCommands.add(m[1]);
  } else {
    const aliases = m[2].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
    for (const a of aliases) registeredCommands.add(a);
  }
}

const menuMissing = menu
  .map((e) => e.command)
  .filter((c) => !registeredCommands.has(c));
check(
  'every menu command has a bot.command(...) registration',
  menuMissing.length === 0,
  menuMissing.length ? `orphan menu entries: /${menuMissing.join(', /')}` : null,
);

// ─── 3. server.js actually calls registerCommandMenu ─────────────────────
console.log(chalk.bold('\nWired into boot:'));
check(
  'server.js imports registerCommandMenu',
  /from\s+['"]\.\/lib\/command-menu\.js['"]/.test(SERVER) && /registerCommandMenu/.test(SERVER),
);
check(
  'server.js calls registerCommandMenu(bot)',
  /await\s+registerCommandMenu\s*\(\s*bot\s*\)/.test(SERVER),
);

// ─── 4. Menu hygiene ─────────────────────────────────────────────────────
console.log(chalk.bold('\nMenu hygiene:'));

const seen = new Set();
const dupes = [];
for (const e of menu) {
  if (seen.has(e.command)) dupes.push(e.command);
  seen.add(e.command);
}
check('no duplicate command names in menu', dupes.length === 0, dupes.join(', '));

const malformed = menu.filter((e) =>
  typeof e.command !== 'string' || !/^[a-z][a-z0-9_]*$/.test(e.command)
  || typeof e.description !== 'string' || e.description.length < 1 || e.description.length > 256,
);
check('every entry is well-formed { command, description }', malformed.length === 0,
  malformed.length ? `malformed: ${JSON.stringify(malformed[0])}` : null);

// Telegram limits: command 1-32 chars, lowercase, [a-z0-9_]
const tgInvalid = menu.filter((e) => e.command.length < 1 || e.command.length > 32);
check('every command name within Telegram length limits (1-32)', tgInvalid.length === 0);

// ─── 5. Coverage of high-value v0.14.x commands ──────────────────────────
console.log(chalk.bold('\nv0.14.x command coverage:'));

const mustHave = ['req_promote', 'bug_promote', 'triage', 'preview', 'sync', 'ship', 'inbox', 'cancel'];
const menuSet = new Set(menu.map((e) => e.command));
for (const cmd of mustHave) {
  check(`menu includes /${cmd}`, menuSet.has(cmd));
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
