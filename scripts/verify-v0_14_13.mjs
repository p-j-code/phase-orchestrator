// v0.14.13 docs verifier — regex sweeps that catch the most common
// docs↔code drift patterns. Static only, runs anywhere.
//
// Run with: node scripts/verify-v0_14_13.mjs
// Exits 0 on full pass, 1 on any failure.
//
// Coverage:
//   1. Every command registered via bot.command(...) in src/server.js
//      appears in docs/TELEGRAM_BOT.md.
//   2. No leftover "v0.5" / "What's NOT supported in v0.5" stub in
//      docs/TELEGRAM_BOT.md.
//   3. docs/NEW_FEATURES.md has v0.14.9 / v0.14.10 / v0.14.11 / v0.14.12
//      section headings.
//   4. docs/RUNBOOK.md mentions the multi-row spinner + transient retry
//      behaviour (the two operational shifts since v0.14.8).
//   5. The in-Telegram /help req topic dive mentions /req_promote (no
//      longer says "CLI only, on Mac").

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

console.log(chalk.bold('\n── v0.14.13 docs verifier ──\n'));

// ─── 1. Command-coverage in TELEGRAM_BOT.md ──────────────────────────────
console.log(chalk.bold('Command coverage:'));

const SERVER = readSrc('src/server.js');
const TG_DOC = readSrc('docs/TELEGRAM_BOT.md');

// Pull every bot.command(...) registration. Two shapes: scalar and array.
const cmdRegex = /bot\.command\(\s*(?:'([^']+)'|\[([^\]]+)\])/g;
const registered = new Set();
let m;
while ((m = cmdRegex.exec(SERVER)) !== null) {
  if (m[1]) {
    registered.add(m[1]);
  } else {
    // array of aliases — only require ONE alias to be documented (the canonical one)
    const aliases = m[2].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
    if (aliases.length) registered.add(aliases[0]);
  }
}

const missing = [];
for (const cmd of registered) {
  // Look for /command in the doc — surrounded by word boundary or backtick.
  const escaped = cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`/${escaped}(?![\\w_])`);
  if (!re.test(TG_DOC)) missing.push(cmd);
}
check(
  `every registered Telegram command appears in TELEGRAM_BOT.md (${registered.size} commands)`,
  missing.length === 0,
  missing.length ? `missing: /${missing.join(', /')}` : null,
);

// ─── 2. Stale v0.5 stub gone ─────────────────────────────────────────────
console.log(chalk.bold('\nStale-doc cleanup:'));
check(
  'TELEGRAM_BOT.md no longer titled "v0.5"',
  !/^# Telegram Bot \(v0\.5\)/m.test(TG_DOC),
);
check(
  'TELEGRAM_BOT.md has no "What\'s NOT supported in v0.5" section',
  !/What's NOT supported in v0\.5/i.test(TG_DOC),
);
check(
  'TELEGRAM_BOT.md no longer claims "One job at a time" architecture',
  !/One job at a time, FIFO from the SQLite queue/i.test(TG_DOC),
);

// ─── 3. NEW_FEATURES.md headings for v0.14.9–v0.14.12 ────────────────────
console.log(chalk.bold('\nNEW_FEATURES.md version coverage:'));
const NF = readSrc('docs/NEW_FEATURES.md');
check('v0.14.9 section present',  /v0\.14\.9\b/i.test(NF) && /LiveStatus/i.test(NF));
check('v0.14.10 section present', /v0\.14\.10\b/i.test(NF) && /TRANSIENT_PATTERNS/i.test(NF));
check('v0.14.11 section present', /v0\.14\.11\b/i.test(NF) && /req_promote/i.test(NF));
check('v0.14.12 section present', /v0\.14\.12\b/i.test(NF) && /FK fix/i.test(NF));
// Pattern hint about --to-inbox <project> vs _inbox
check(
  'NEW_FEATURES.md describes the --to-inbox <project> pattern',
  /--to-inbox &lt;project&gt;|--to-inbox <project>|--to-inbox `?<project>`?/.test(NF)
    || /to-inbox <project>/i.test(NF),
);

// ─── 4. RUNBOOK.md operational coverage ──────────────────────────────────
console.log(chalk.bold('\nRUNBOOK.md operational coverage:'));
const RB = readSrc('docs/RUNBOOK.md');
check(
  'RUNBOOK mentions multi-row live region spinner',
  /multi-row.*spinner|live region|\[wN project\]/.test(RB),
);
check(
  'RUNBOOK mentions transient retry / network classification',
  /transient.*(?:retry|error|api)/i.test(RB),
);

// ─── 5. /help req topic dive updated ─────────────────────────────────────
console.log(chalk.bold('\nIn-Telegram /help req updated:'));
const TG_SRC = readSrc('src/server/telegram-handlers.js');
// Find the req topic body
const reqTopicMatch = TG_SRC.match(/req:\s*\{\s*title:\s*['"]Requirements inbox['"],[\s\S]+?body:\s*([\s\S]+?),\s*\}/);
check('req topic still present in /help', !!reqTopicMatch);
if (reqTopicMatch) {
  const body = reqTopicMatch[1];
  check('req topic mentions /req_promote',          /req_promote/.test(body));
  check('req topic mentions --plan flag',           /--plan/.test(body));
  check('req topic no longer says "CLI only"',      !/Promote \(CLI only/i.test(body));
  check('req topic mentions promote-to alias',      /promote-to/.test(body));
}

// Bonus: /start banner mentions /req_promote and bugs commands now
const startBannerMatch = TG_SRC.match(/Welcome back[\s\S]+?return ctx\.reply\(/);
if (startBannerMatch) {
  const banner = startBannerMatch[0];
  check('/start banner mentions /req_promote',      /req_promote/.test(banner));
  check('/start banner has a Bugs inbox section',   /Bugs inbox/.test(banner));
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
