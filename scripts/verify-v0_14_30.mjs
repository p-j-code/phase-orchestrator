// v0.14.30 verifier — proves the audit-promote regex tolerates the heading
// variants Opus actually produces, AND that the /promote error path now
// sanitizes bugs.md mentions for Telegram.
//
// Bug class addressed: audit-template drift between LLM output and parser
// expectations. See CHANGELOG.md [0.14.30] for the full story.
//
// Run with: node scripts/verify-v0_14_30.mjs
// Exits 0 on full pass, 1 on any failure.

import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

console.log(chalk.bold('\n── v0.14.30 verifier ──\n'));

// ─── 1. Audit-promote regex against real heading variants ───────────────

const { extractPromoteSection } = await import(resolve(REPO_ROOT, 'src/lib/audit-promote.js'));

// Build a sandbox with fake audit files containing each heading variant.
const sandbox = mkdtempSync(join(tmpdir(), 'v0_14_30-verify-'));

const BUG_BODY = `
### BUG-1: Example finding

- Severity: major
- Files: \`src/foo.ts:42\`
- Repro: Steps to reproduce
- Expected: It works
- Actual: It does not
- Fix sketch: Add the missing branch
`;

const POSITIVE_CASES = [
  ['canonical',          '## Promote to bugs-round-1'],
  ['decorated-backticks','## Promote to `bugs-round-7`'],
  ['decorated-bold',     '## Promote to **bugs-round-7**'],
  ['decorated-italic',   '## Promote to _bugs-round-7_'],
  ['spaces',             '## Promote to bugs round 7'],
  ['full-path-Opus',     '## Promote to `bug-rounds/round-1/bugs.md`'],
  ['full-path-bare',     '## Promote to bug-rounds/round-1/bugs.md'],
  ['path-no-filename',   '## Promote to bug-rounds/round-1'],
  ['compact',            '## Promote to round 1'],
  ['compact-hyphen',     '## Promote to round-1'],
  ['multi-digit',        '## Promote to bugs-round-12'],
  ['deeper-heading',     '### Promote to bugs-round-12'],
  ['template-literal-N', '## Promote to bugs-round-N'],
];

for (const [name, heading] of POSITIVE_CASES) {
  const f = join(sandbox, `audit-${name}.md`);
  writeFileSync(f, `# Audit\n\nSome preamble.\n\n${heading}\n${BUG_BODY}`);
  const result = await extractPromoteSection(f);
  check(`positive: ${name}  →  found=true`, result.found, result.reason);
}

// ─── 2. False-positive guards ───────────────────────────────────────────

const NEGATIVE_CASES = [
  ['no-heading',         '# Audit\n\nNo promote section here.\n'],
  ['random-mention',     '# Audit\n\nPromote yourself by reading the round-1 docs.\n'],
  ['wrong-keyword',      '## Demote to bugs-round-1\n'],
  ['promote-no-round',   '## Promote to fix-list\n'],
];

for (const [name, body] of NEGATIVE_CASES) {
  const f = join(sandbox, `audit-neg-${name}.md`);
  writeFileSync(f, body);
  const result = await extractPromoteSection(f);
  check(`negative: ${name}  →  found=false`, !result.found);
}

// ─── 3. The actual reelchain audit (if present in test fixtures) ────────
// We don't have the user's audit on disk, but we can simulate the exact
// failing heading they hit:
const reelchainStyle = `# Audit\n\n## Promote to \`bug-rounds/round-1/bugs.md\`\n${BUG_BODY}`;
const reelchainFile = join(sandbox, 'audit-reelchain-style.md');
writeFileSync(reelchainFile, reelchainStyle);
const reelchainResult = await extractPromoteSection(reelchainFile);
check(
  'reelchain-style heading (the actual failing case from 2026-05-27) → found=true',
  reelchainResult.found,
  reelchainResult.reason,
);

// ─── 4. Source checks on handlePromote sanitization ─────────────────────

const PARITY = readSrc('src/server/telegram-parity-handlers.js');
check(
  'handlePromote error path imports sanitizeForTelegram',
  /sanitizeForTelegram\s*\}\s*=\s*await\s+import\(['"]\.\.\/lib\/telegram-fmt\.js['"]\)/.test(PARITY)
  || /from\s+['"]\.\.\/lib\/telegram-fmt\.js['"]/.test(PARITY),
);
check(
  'handlePromote no longer emits bare bugs.md outside <code> tags',
  !(/copy findings into bugs\.md by hand['"`,]/.test(PARITY) && !/sanitizeForTelegram\([^)]*bugs\.md[^)]*\)/.test(PARITY)),
);

// ─── 5. Source check on guide-system.md audit task ──────────────────────

const GUIDE = readSrc('prompts/guide-system.md');
check(
  'prompts/guide-system.md audit task specifies canonical Promote heading',
  /Promote section heading format/i.test(GUIDE) && /bugs-round-N/.test(GUIDE),
);

// ─── Teardown ───────────────────────────────────────────────────────────
try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }

// ─── Summary ────────────────────────────────────────────────────────────
console.log('');
if (failed === 0) {
  console.log(chalk.bold.green(`✓ All ${passed} checks passed.`));
  process.exit(0);
} else {
  console.log(chalk.bold.red(`✗ ${failed} failed, ${passed} passed.`));
  process.exit(1);
}
