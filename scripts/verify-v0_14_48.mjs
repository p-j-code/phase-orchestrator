// v0.14.48 verifier — incremental audits can't go blind: full re-scan on
// unchanged HEAD + every N consecutive incrementals. 8 checks (functional
// detection + streak), needs the functional better-sqlite3 shim OR real module.
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
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

console.log(chalk.bold('\n── v0.14.48 verifier ──\n'));
const pr = await import(resolve(REPO_ROOT, 'src/lib/phase-runner.js'));

function mkProj() {
  const projDir = mkdtempSync(join(tmpdir(), 'v48-'));
  const ws = join(projDir, 'workspace'); mkdirSync(ws, { recursive: true });
  execSync('git init -q && git config user.email a@b && git config user.name t', { cwd: ws });
  writeFileSync(join(ws, 'a.js'), '1'); execSync('git add -A && git commit -qm one', { cwd: ws });
  const sha = execSync('git rev-parse HEAD', { cwd: ws }).toString().trim();
  const ad = join(projDir, '.guide', 'audits'); mkdirSync(ad, { recursive: true });
  writeFileSync(join(ad, 'audit-1.md'), '#');
  return { projDir, ws, ad, sha };
}
const advance = (ws) => { writeFileSync(join(ws, `f${Math.random().toString(36).slice(2)}.js`), 'x'); execSync('git add -A && git commit -qm c', { cwd: ws }); };
const stamp = (ad, sha, streak) => writeFileSync(join(ad, '.last-audit.json'), JSON.stringify({ sha, incremental_streak: streak }));

let t = mkProj();
stamp(t.ad, t.sha, 0);
check('unchanged HEAD → forces full (null) regardless of streak', (await pr.detectIncrementalAudit(t.projDir, { audit: { force_full_every_n: 5 } })) === null);

t = mkProj(); advance(t.ws); stamp(t.ad, t.sha, 2);
const inc = await pr.detectIncrementalAudit(t.projDir, { audit: { force_full_every_n: 5 } });
check('changed HEAD + streak < N → incremental (diff scope)', !!inc && Array.isArray(inc.files));

t = mkProj(); advance(t.ws); stamp(t.ad, t.sha, 5);
check('streak >= N → forces full (periodic)', (await pr.detectIncrementalAudit(t.projDir, { audit: { force_full_every_n: 5 } })) === null);

t = mkProj(); advance(t.ws); stamp(t.ad, t.sha, 99);
check('force_full_every_n:0 disables periodic (still incremental on changed HEAD)',
  !!(await pr.detectIncrementalAudit(t.projDir, { audit: { force_full_every_n: 0 } })));

t = mkProj(); advance(t.ws); stamp(t.ad, t.sha, 3);
check('default threshold (no cfg) is 5 — streak 3 still incremental',
  !!(await pr.detectIncrementalAudit(t.projDir, null)));

const src = readSrc('src/lib/phase-runner.js');
check('stampLastAudit increments streak on incremental, resets on full',
  /async function stampLastAudit/.test(src)
  && /streak = \(Number\(prev\?\.incremental_streak\) \|\| 0\) \+ 1;/.test(src)
  && /stampLastAudit\(projDir, sha, \{ wasIncremental: false \}\)/.test(src));
check('detection threaded with cfg at both call sites',
  (src.match(/detectIncrementalAudit\(projDir, cfg\)/g) || []).length === 2);

const defaults = JSON.parse(readSrc('config/defaults.json'));
check('defaults: audit.force_full_every_n = 5; version 0.14.48',
  defaults.audit?.force_full_every_n === 5 && JSON.parse(readSrc('package.json')).version === '0.14.48');

console.log('');
if (failed === 0) { console.log(chalk.green.bold(`✓ All ${passed} checks passed.`)); process.exit(0); }
console.log(chalk.red.bold(`✗ ${failed} failed, ${passed} passed.`)); process.exit(1);
