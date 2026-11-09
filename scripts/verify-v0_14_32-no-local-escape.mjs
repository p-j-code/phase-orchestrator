// v0.14.32 verifier — proves that the local escapeHtml definitions in the
// three server handler files have been removed and that all non-<pre> sites
// now use sanitizeForTelegram from the canonical telegram-fmt.js.
//
// Run with: node scripts/verify-v0_14_32-no-local-escape.mjs
// Exits 0 on full pass, 1 on any failure.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import chalk from 'chalk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

let passed = 0;
let failed = 0;
function check(label, ok, details) {
  if (ok) { console.log(chalk.green('  OK  '), label); passed += 1; }
  else    { console.log(chalk.red('  FAIL'), label, details ? chalk.dim(`— ${details}`) : ''); failed += 1; }
}

const serverDir = join(REPO_ROOT, 'src', 'server');
const fmtFile = join(REPO_ROOT, 'src', 'lib', 'telegram-fmt.js');

console.log(chalk.bold('\n── v0.14.32 verifier: no local escapeHtml in server files ──\n'));

// ─── 1. No local escapeHtml definition in any src/server/*.js file ───────────

const LOCAL_ESCAPE_PATTERN = /(?:function|const|let|var)\s+escapeHtml\s*[=(]/;
const serverFiles = readdirSync(serverDir).filter((f) => f.endsWith('.js'));
for (const file of serverFiles) {
  const content = readFileSync(join(serverDir, file), 'utf8');
  check(
    `No local escapeHtml definition in src/server/${file}`,
    !LOCAL_ESCAPE_PATTERN.test(content),
    'Found a local escapeHtml — delete it and import from lib/telegram-fmt.js',
  );
}

// ─── 2. Canonical telegram-fmt.js still exports both functions ───────────────

const fmtContent = readFileSync(fmtFile, 'utf8');
check('src/lib/telegram-fmt.js still exports escapeHtml',
  fmtContent.includes('export function escapeHtml'));
check('src/lib/telegram-fmt.js still exports sanitizeForTelegram',
  fmtContent.includes('export function sanitizeForTelegram'));

// ─── 3. Each handler file imports from telegram-fmt.js ───────────────────────

console.log('');
for (const [file, required] of [
  ['telegram-parity-handlers.js', ['escapeHtml', 'sanitizeForTelegram']],
  ['telegram-handlers.js',        ['escapeHtml', 'sanitizeForTelegram']],
  ['preview-handlers.js',         ['escapeHtml', 'sanitizeForTelegram']],
]) {
  const content = readFileSync(join(serverDir, file), 'utf8');
  const hasFmtImport = content.includes('telegram-fmt.js');
  for (const name of required) {
    check(
      `src/server/${file} imports ${name} from telegram-fmt`,
      hasFmtImport && content.includes(name),
    );
  }
}

// ─── 4. No err.message site still uses plain escapeHtml ──────────────────────

console.log('');
const ERR_MSG_PLAIN = /escapeHtml\s*\(\s*err(?:\?\.|\.)message/;
for (const file of ['telegram-parity-handlers.js', 'telegram-handlers.js', 'preview-handlers.js']) {
  const content = readFileSync(join(serverDir, file), 'utf8');
  check(
    `No err.message site uses plain escapeHtml in ${file}`,
    !ERR_MSG_PLAIN.test(content),
    'escapeHtml(err.message) found — change to sanitizeForTelegram(err.message)',
  );
}

// ─── 5. <pre> content sites use escapeHtml, not sanitizeForTelegram ──────────

// We scan for sanitizeForTelegram that appears AFTER <pre> on the same line,
// which means it's inside the <pre>...</pre> block. sanitizeForTelegram that
// appears BEFORE <pre> on the same line is fine — it's outside the block.
console.log('');
const INSIDE_PRE = /<pre>.*sanitizeForTelegram/;
for (const file of ['telegram-parity-handlers.js', 'telegram-handlers.js', 'preview-handlers.js']) {
  const content = readFileSync(join(serverDir, file), 'utf8');
  const lines = content.split('\n');
  const badLines = lines.filter((l) => INSIDE_PRE.test(l));
  check(
    `No sanitizeForTelegram used inside <pre> in ${file}`,
    badLines.length === 0,
    badLines.length > 0
      ? `Found ${badLines.length} line(s) with sanitizeForTelegram inside <pre> — use plain escapeHtml for <pre> content`
      : undefined,
  );
}

// ─── 6. Functional smoke: sanitizeForTelegram wraps filenames ────────────────

console.log('');
const { sanitizeForTelegram, escapeHtml } = await import(join(REPO_ROOT, 'src/lib/telegram-fmt.js'));

check('sanitizeForTelegram wraps .md filename',
  sanitizeForTelegram('Cannot find raw-thoughts.md') === 'Cannot find <code>raw-thoughts.md</code>');
check('sanitizeForTelegram wraps .json filename',
  sanitizeForTelegram('Missing plan.json for project') === 'Missing <code>plan.json</code> for project');
check('sanitizeForTelegram escapes HTML first',
  sanitizeForTelegram('Error: foo<bar>').includes('&lt;bar&gt;'));
check('plain escapeHtml does NOT wrap filenames',
  escapeHtml('raw-thoughts.md') === 'raw-thoughts.md');

// ─── 7. Site count sanity checks ─────────────────────────────────────────────

console.log('');
const parityContent = readFileSync(join(serverDir, 'telegram-parity-handlers.js'), 'utf8');
const parityEscapeLines = parityContent.split('\n').filter((l) => l.includes('escapeHtml(')).length;
const paritySanitizeLines = parityContent.split('\n').filter((l) => l.includes('sanitizeForTelegram(')).length;
check(`telegram-parity-handlers.js has exactly 2 lines with escapeHtml( (the <pre> sites)`,
  parityEscapeLines === 2, `found ${parityEscapeLines}`);
check(`telegram-parity-handlers.js has sanitizeForTelegram( on all other lines`,
  paritySanitizeLines >= 70, `found ${paritySanitizeLines} (expected ≥70)`);

const handlersContent = readFileSync(join(serverDir, 'telegram-handlers.js'), 'utf8');
const handlersEscapeLines = handlersContent.split('\n').filter((l) => l.includes('escapeHtml(')).length;
check(`telegram-handlers.js has exactly 3 lines with escapeHtml( (the <pre> sites)`,
  handlersEscapeLines === 3, `found ${handlersEscapeLines}`);

const previewContent = readFileSync(join(serverDir, 'preview-handlers.js'), 'utf8');
const previewEscapeLines = previewContent.split('\n').filter((l) => l.includes('escapeHtml(')).length;
check(`preview-handlers.js has exactly 2 lines with escapeHtml( (the <pre> sites)`,
  previewEscapeLines === 2, `found ${previewEscapeLines}`);

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('');
if (failed === 0) {
  console.log(chalk.bold.green(`All ${passed} checks passed.`));
  process.exit(0);
} else {
  console.log(chalk.bold.red(`${failed} check(s) failed, ${passed} passed.`));
  process.exit(1);
}
