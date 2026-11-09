// v0.14.45 verifier — /addbug creates rounds in the right path + project card
// flags a dropped-but-unrun round. 7 checks (functional addbug logic + source).
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, accessSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import chalk from 'chalk';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0; let failed = 0;
function check(label, ok, details) {
  if (ok) { console.log(chalk.green('  OK  '), label); passed += 1; }
  else { console.log(chalk.red('  FAIL'), label, details ? chalk.dim(`— ${details}`) : ''); failed += 1; }
}
const readSrc = (rel) => { const p = resolve(REPO_ROOT, rel); if (!existsSync(p)) throw new Error(`Missing: ${rel}`); return readFileSync(p, 'utf8'); };

console.log(chalk.bold('\n── v0.14.45 verifier ──\n'));
const ph = readSrc('src/server/telegram-parity-handlers.js');
const sv = readSrc('src/server.js');
const th = readSrc('src/server/telegram-handlers.js');

check('handleAddBug exported and computes next round via detectHighestBugRound',
  /export const handleAddBug = requireAuth/.test(ph)
  && /detectHighestBugRound\(projDir\)\) \|\| 0/.test(ph)
  && /const round = highest \+ 1;/.test(ph));
check('handleAddBug writes a canonical Bug #1 stub and refuses to clobber an existing round',
  /### Bug #1 — /.test(ph)
  && /this is the fix's acceptance criterion/.test(ph)
  && /already has a bugs\.md/.test(ph));
check('handleAddBug attaches a "Run fixes" button wired to go',
  /InlineKeyboard\(\)\.text\(`▶ Run fixes \(round \$\{round\}\)`, `act:\$\{project\}:go`\)/.test(ph));
check('/addbug registered with aliases',
  /handleRemoveProject, handleSpend, handleAddBug,/.test(sv)
  && /bot\.command\(\['addbug', 'add_bug', 'newbug'\], handleAddBug\)/.test(sv));

// functional: path computation lands under .guide/bug-rounds/round-N
const { detectHighestBugRound, bugRoundDir, bugsFilePath } = await import(resolve(REPO_ROOT, 'src/lib/guide-paths.js'));
const projDir = mkdtempSync(join(tmpdir(), 'v45-'));
mkdirSync(join(projDir, '.guide', 'bug-rounds', 'round-3'), { recursive: true });
writeFileSync(bugsFilePath(projDir, 3), '### Bug #1 — x\n');
const hr = (await detectHighestBugRound(projDir)) || 0;
check('detectHighestBugRound sees existing rounds → next round is N+1',
  hr === 3 && bugRoundDir(projDir, hr + 1).endsWith('round-4'), `hr=${hr}`);

check('project card detects bugs.md-without-plan as a pending dropped round',
  /pendingDropNote/.test(th)
  && /hasBugs && !hasPlan/.test(th)
  && /is on disk but not yet run/.test(th));
check('package.json version is 0.14.45', JSON.parse(readSrc('package.json')).version === '0.14.45');

console.log('');
if (failed === 0) { console.log(chalk.green.bold(`✓ All ${passed} checks passed.`)); process.exit(0); }
console.log(chalk.red.bold(`✗ ${failed} failed, ${passed} passed.`)); process.exit(1);
