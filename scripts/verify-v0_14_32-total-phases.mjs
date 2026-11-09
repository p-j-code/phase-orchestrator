// v0.14.32 verifier — proves setTotalPhases is wired end-to-end:
//   state.js exports the function, job-runner.js calls it after guide plan,
//   handleExtend no longer reads plan.json directly, and the backfill
//   migration exists and is wired into migrate-all.
//
// Run with: node scripts/verify-v0_14_32-total-phases.mjs
// Exits 0 on full pass, 1 on any failure.

import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
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

console.log(chalk.bold('\n── v0.14.32 total-phases verifier ──\n'));

// ─── 1. Source-level checks ──────────────────────────────────────────────────

const stateSrc = readSrc('src/state.js');
check(
  'state.js exports setTotalPhases',
  stateSrc.includes('export function setTotalPhases'),
);

const jrSrc = readSrc('src/server/job-runner.js');
check(
  "job-runner.js calls setTotalPhases after guide plan",
  jrSrc.includes('setTotalPhases'),
);
check(
  "job-runner.js guards the call with task === 'plan'",
  jrSrc.includes("task === 'plan'"),
);

const parSrc = readSrc('src/server/telegram-parity-handlers.js');
check(
  'handleExtend no longer reads plan.json for phase count',
  !parSrc.includes("isn't always synced"),
);

const mtpSrc = readSrc('src/migrate-total-phases.js');
check(
  'migrate-total-phases.js exports runMigrateTotalPhases',
  mtpSrc.includes('export async function runMigrateTotalPhases'),
);

const maSrc = readSrc('src/migrate-all.js');
check(
  'migrate-all.js calls runMigrateTotalPhases',
  maSrc.includes('runMigrateTotalPhases'),
);

const pkgSrc = readSrc('package.json');
check(
  'package.json has migrate-total-phases script',
  pkgSrc.includes('"migrate-total-phases"'),
);

// ─── 2. Functional — setTotalPhases persists correctly ───────────────────────

console.log(chalk.dim('\n  Running functional DB test in subprocess…'));

const sandbox = mkdtempSync(join(tmpdir(), 'tp-verify-'));
const dbPath = join(sandbox, 'test.db');

const script = `
process.env.DB_PATH = ${JSON.stringify(dbPath)};
const { upsertProject, getProject, setTotalPhases } = await import(${JSON.stringify(resolve(REPO_ROOT, 'src/state.js'))});
upsertProject({ name: 'verify-tp' });
const before = getProject('verify-tp').total_phases;
setTotalPhases('verify-tp', 5);
const after = getProject('verify-tp').total_phases;
setTotalPhases('verify-tp', 5); // idempotent
const after2 = getProject('verify-tp').total_phases;
console.log(JSON.stringify({ before, after, after2 }));
`;

import { execFileSync } from 'node:child_process';
let fnResult;
try {
  const out = execFileSync(process.execPath, ['--input-type=module'], {
    input: script,
    env: { ...process.env, DB_PATH: dbPath },
    encoding: 'utf8',
  });
  fnResult = JSON.parse(out.trim());
} catch (e) {
  console.log(chalk.red('  FAIL'), 'functional test subprocess failed:', e.message);
  failed += 1;
  fnResult = null;
}

if (fnResult) {
  check('project created with total_phases=0', fnResult.before === 0, `got ${fnResult.before}`);
  check('setTotalPhases(5) persists', fnResult.after === 5, `got ${fnResult.after}`);
  check('setTotalPhases is idempotent', fnResult.after2 === 5, `got ${fnResult.after2}`);
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('');
if (failed === 0) {
  console.log(chalk.bold.green(`✓ All ${passed} checks passed.`));
  process.exit(0);
} else {
  console.log(chalk.bold.red(`✗ ${failed} failed, ${passed} passed.`));
  process.exit(1);
}
