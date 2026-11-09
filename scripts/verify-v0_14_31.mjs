// v0.14.31 verifier — proves the audit-promote fallback parser correctly
// handles audits that lack the explicit Promote heading but still have
// usable BUG-N entries in the body.
//
// Bug class addressed: audits whose drift from the template is more
// severe than v0.14.30's regex broadening could handle — some audits
// simply have no "## Promote to ..." heading at all but still contain
// perfectly valid ### BUG-N entries.
//
// Run with: node scripts/verify-v0_14_31.mjs
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

console.log(chalk.bold('\n── v0.14.31 verifier ──\n'));

const { extractPromoteSection } = await import(resolve(REPO_ROOT, 'src/lib/audit-promote.js'));

const sandbox = mkdtempSync(join(tmpdir(), 'v0_14_31-verify-'));

const BUG_BODY = `
### BUG-1: First example finding

- Severity: major
- Files: \`src/foo.ts:42\`
- Repro: Steps to reproduce
- Expected: It works
- Actual: It does not
- Fix sketch: Add the missing branch

### BUG-2: Second example finding

- Severity: minor
- Files: \`src/bar.ts:100\`
`;

// ─── 1. v0.14.30 cases still pass (no regression) ──────────────────────

{
  const f = join(sandbox, 'explicit-canonical.md');
  writeFileSync(f, `# Audit\n\n## Promote to bugs-round-1\n${BUG_BODY}`);
  const r = await extractPromoteSection(f);
  check(
    'v0.14.30 regression: canonical heading still works',
    r.found && r.source === 'explicit-heading',
    `source=${r.source}`,
  );
}

{
  const f = join(sandbox, 'explicit-path-form.md');
  writeFileSync(f, `# Audit\n\n## Promote to \`bug-rounds/round-1/bugs.md\`\n${BUG_BODY}`);
  const r = await extractPromoteSection(f);
  check(
    'v0.14.30 regression: path-form heading still works',
    r.found && r.source === 'explicit-heading',
    `source=${r.source}`,
  );
}

// ─── 2. v0.14.31 fallback: no Promote heading but BUG-N entries present ─

{
  const f = join(sandbox, 'no-heading-2-bugs.md');
  writeFileSync(f, `# Audit Report\n\n## Findings\n${BUG_BODY}\n\n## Recommendations\n\nFix the above.\n`);
  const r = await extractPromoteSection(f);
  check(
    'fallback: no Promote heading + 2 BUG entries → found=true via fallback',
    r.found && r.source === 'bug-entries-scan',
    `source=${r.source}`,
  );
  check(
    'fallback: extracted content contains both BUG entries',
    r.content && r.content.includes('BUG-1') && r.content.includes('BUG-2'),
  );
  check(
    'fallback: warning mentions BUG-N scan and entry count',
    r.warning && /BUG-N|2 BUG-N entries/i.test(r.warning),
    `warning=${r.warning}`,
  );
}

{
  const f = join(sandbox, 'no-heading-1-bug.md');
  writeFileSync(
    f,
    `# Audit\n\nSome preamble.\n\n### BUG-1: Single finding\n\n- Severity: critical\n- Files: \`src/x.ts\`\n`,
  );
  const r = await extractPromoteSection(f);
  check(
    'fallback: single BUG entry triggers the fallback (1+ threshold)',
    r.found && r.source === 'bug-entries-scan',
    `source=${r.source}`,
  );
}

// ─── 3. v0.14.31 fallback: BUG-N variant spellings ─────────────────────

const BUG_VARIANTS = [
  ['bug-with-space',         '### BUG 1: title with space\n\n- Severity: major'],
  ['bug-no-colon',           '### BUG-1 title with no colon\n\n- Severity: major'],
  ['lowercase-bug',          '### Bug-1: lowercase b\n\n- Severity: major'],
  ['template-literal-N',     '### BUG-N: template not filled\n\n- Severity: major'],
  ['deeper-heading-h4',      '#### BUG-1: title at h4\n\n- Severity: major'],
];

for (const [name, body] of BUG_VARIANTS) {
  const f = join(sandbox, `variant-${name}.md`);
  writeFileSync(f, `# Audit\n\n## Findings\n\n${body}\n`);
  const r = await extractPromoteSection(f);
  check(
    `fallback variant: ${name} → found=true`,
    r.found && r.source === 'bug-entries-scan',
    `source=${r.source} reason=${r.reason || ''}`,
  );
}

// ─── 4. Structured failure: no heading AND no BUG entries ──────────────

{
  const f = join(sandbox, 'nothing-recognisable.md');
  writeFileSync(
    f,
    `# Audit Report\n\n## Summary\n\nEverything looks fine.\n\n## Recommendations\n\nKeep doing what you're doing.\n`,
  );
  const r = await extractPromoteSection(f);
  check(
    'failure: no heading + no BUG entries → found=false',
    !r.found,
  );
  check(
    'failure: reason includes the audit headings (operator can see what IS there)',
    r.reason && r.reason.includes('## Summary') && r.reason.includes('## Recommendations'),
    `reason=${(r.reason || '').slice(0, 200)}`,
  );
  check(
    'failure: reason includes concrete fix suggestions',
    r.reason && /bugs-round-1|BUG-1/.test(r.reason),
  );
}

{
  const f = join(sandbox, 'empty-audit.md');
  writeFileSync(f, '');
  const r = await extractPromoteSection(f);
  check(
    'failure: empty audit → found=false with no-headings message',
    !r.found && /No markdown headings/.test(r.reason || ''),
    `reason=${r.reason}`,
  );
}

// ─── 5. False-positive guards (carried from v0.14.30) ──────────────────

{
  const f = join(sandbox, 'random-bug-mention.md');
  writeFileSync(f, `# Audit\n\nWe found a BUG-1 issue in passing, but no structured finding.\n\nPlain prose.\n`);
  const r = await extractPromoteSection(f);
  check(
    'false-positive guard: prose mention of "BUG-1" without heading → found=false',
    !r.found,
    'BUG_ENTRY_REGEX requires the BUG-N pattern to be at the start of a heading line, not mid-prose',
  );
}

// ─── 6. Source-level checks ─────────────────────────────────────────────

const PROMOTE_LIB = readSrc('src/lib/audit-promote.js');
check(
  'audit-promote.js exports BUG_ENTRY_REGEX-driven fallback path',
  /BUG_ENTRY_REGEX/.test(PROMOTE_LIB) && /bug-entries-scan/.test(PROMOTE_LIB),
);
check(
  'audit-promote.js includes summarizeAuditStructure helper',
  /summarizeAuditStructure/.test(PROMOTE_LIB),
);

const PARITY = readSrc('src/server/telegram-parity-handlers.js');
check(
  'telegram-parity-handlers.js surfaces fallback source in confirmation',
  /bug-entries-scan/.test(PARITY) && /fallback BUG-N scan/.test(PARITY),
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
