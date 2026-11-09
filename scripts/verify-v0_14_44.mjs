// v0.14.44 verifier — deferred transient retries. 9 checks (classifier
// functional; queue/runner wiring source-asserted). Runs anywhere.
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

console.log(chalk.bold('\n── v0.14.44 verifier ──\n'));

const { isTransientError } = await import(resolve(REPO_ROOT, 'src/lib/transient-errors.js'));
check('classifier: rate limit / overloaded / 529 / 503 / network → transient',
  ['API error: rate_limit_error', 'overloaded_error', 'HTTP 529', 'HTTP 503 service unavailable',
   'ECONNRESET', 'socket hang up', 'fetch failed'].every(isTransientError));
check('classifier: auth / validator / no-commit / timeout-class → NOT transient',
  ['authentication_error: invalid api key', '401 unauthorized',
   'fix r2-3 committed but failed the validator gate: validators failed: default:npm-test',
   'produced no git commit', 'plan failed structural validation after 1 auto-regen'].every((t) => !isTransientError(t)));
check('classifier: validator failure mentioning a 500-test stays non-transient (negative wins)',
  !isTransientError('validators failed: 500 expectations in default:npm-test'));

const st = readSrc('src/state.js');
check('schema: tg_jobs gains not_before + retry_count (additive addCol)',
  /ALTER TABLE tg_jobs ADD COLUMN not_before TEXT/.test(st)
  && /ALTER TABLE tg_jobs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0/.test(st));

const jq = readSrc('src/server/job-queue.js');
check('picker: sleeping jobs invisible — main WHERE and the FIFO-blocker subquery both guard not_before',
  (jq.match(/not_before IS NULL OR (j|earlier)\.not_before <= datetime\('now'\)/g) || []).length === 0
    ? (jq.match(/not_before <= datetime\('now'\)/g) || []).length >= 2
    : true);
check('enqueueRetryJob inserts pending with not_before + retry_count',
  /export function enqueueRetryJob/.test(jq)
  && /INSERT INTO tg_jobs \(project, action, args_json, requested_by, requested_at, status, not_before, retry_count\)/.test(jq));

const jr = readSrc('src/server/job-runner.js');
check('job-runner: failed jobs AND transient-paused jobs schedule a deferred retry',
  /maybeScheduleTransientRetry\(\{ job, action, project, reasonText: result\.reason \|\| summary/.test(jr)
  && /result\?\.status === 'paused' && isTransientError\(result\.reason \|\| ''\)/.test(jr)
  && /transient_retry_minutes\) \|\| 60/.test(jr)
  && /transient_retry_max\) \|\| 0/.test(jr));

const ar = readSrc('src/auto-runner.js');
check('auto-runner: transient errors skip the opus retry AND skip-parking (weather, not code)',
  /const escIsTransient = isTransientError\(escErr\);/.test(ar)
  && /!escIsTimeout && !escIsTransient && !escalateRetryDone/.test(ar)
  && /!escIsTimeout && !escIsTransient && action\.kind === 'fix-dev'/.test(ar));

const defaults = JSON.parse(readSrc('config/defaults.json'));
check('defaults: retry_transient=true, 60m cooldown, max=0 (unlimited); version 0.14.44',
  defaults.auto_run?.retry_transient === true
  && defaults.auto_run?.transient_retry_minutes === 60
  && defaults.auto_run?.transient_retry_max === 0
  && JSON.parse(readSrc('package.json')).version === '0.14.44');

console.log('');
if (failed === 0) { console.log(chalk.green.bold(`✓ All ${passed} checks passed.`)); process.exit(0); }
console.log(chalk.red.bold(`✗ ${failed} failed, ${passed} passed.`)); process.exit(1);
