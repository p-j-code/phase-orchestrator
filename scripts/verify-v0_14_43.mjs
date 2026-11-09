// v0.14.43 verifier — hardcore mode: ♾ until-clean chains + park-on-double-
// failure for fixes. 8 checks, source + config asserted, runs anywhere.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import chalk from 'chalk';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0; let failed = 0;
function check(label, ok, details) {
  if (ok) { console.log(chalk.green('  OK  '), label); passed += 1; }
  else { console.log(chalk.red('  FAIL'), label, details ? chalk.dim(`— ${details}`) : ''); failed += 1; }
}
const readSrc = (rel) => { const p = resolve(REPO_ROOT, rel); if (!existsSync(p)) throw new Error(`Missing: ${rel}`); return readFileSync(p, 'utf8'); };

console.log(chalk.bold('\n── v0.14.43 verifier ──\n'));
const jr = readSrc('src/server/job-runner.js');
const th = readSrc('src/server/telegram-handlers.js');
const ar = readSrc('src/auto-runner.js');
const defaults = JSON.parse(readSrc('config/defaults.json'));

check('job-runner: rounds:"inf" → until-clean with max_chain_rounds ceiling',
  /const untilClean = args\.rounds === 'inf';/.test(jr)
  && /auto_run\?\.max_chain_rounds\) \|\| 25/.test(jr)
  && /untilClean \? chainCeiling :/.test(jr));
check('job-runner: progress + summary render ∞ instead of the ceiling',
  /const roundsLabel = untilClean \? '∞' : String\(maxRounds\);/.test(jr)
  && /\$\{i \+ 1\}\/\$\{roundsLabel\}/.test(jr)
  && /\(\$\{completedRounds\}\/\$\{roundsLabel\}\)/.test(jr));
check('audit menu: ♾ Until clean button wired to autopipe:inf',
  /\.text\('♾ Until clean', `autopipe:\$\{project\}:inf`\)/.test(th)
  && /rest\[1\] === 'inf' \? 'inf' :/.test(th)
  && /audit \(auto ♾ until clean\)/.test(th));
check('fix double-failure skip: parks to parked.md, advances the round, continues',
  /ar\.on_double_failure === 'skip'/.test(ar)
  && /parked\.md/.test(ar)
  && /recordFixCompletion\(\{ project: projectName, round: f\.round, fixN: f\.n \}\);/.test(ar)
  && /PARKED after double failure/.test(ar));
check('skip mode is fix-only — gated on action.kind === fix-dev (phases always pause)',
  /action\.kind === 'fix-dev' && ar\.on_double_failure === 'skip'/.test(ar));
check('park notification uses the notifier.notify() convention',
  /notifier\.notify\(\{ text: `⏭ fix r\$\{f\.round\}-\$\{f\.n\} parked/.test(ar));
check('defaults: on_double_failure="pause" (skip is opt-in), max_chain_rounds=25',
  defaults.auto_run?.on_double_failure === 'pause'
  && defaults.auto_run?.max_chain_rounds === 25);
check('package.json version is 0.14.43', JSON.parse(readSrc('package.json')).version === '0.14.43');

console.log('');
if (failed === 0) { console.log(chalk.green.bold(`✓ All ${passed} checks passed.`)); process.exit(0); }
console.log(chalk.red.bold(`✗ ${failed} failed, ${passed} passed.`)); process.exit(1);
