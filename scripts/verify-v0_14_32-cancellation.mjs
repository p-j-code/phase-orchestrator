// v0.14.32 cancellation verifier — proves abort and SIGINT correctly write
// 'cancelled' to projects.status, and all downstream surfaces distinguish
// cancelled from paused.
//
// Run with: node scripts/verify-v0_14_32-cancellation.mjs
// Exits 0 on full pass, 1 on any failure.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

console.log(chalk.bold('\n── v0.14.32 cancellation verifier ──\n'));

// ─── 1. orchestrator.js abort writes 'cancelled' ────────────────────────
const orchSrc = readSrc('src/orchestrator.js');
check(
  "orchestrator.js abort writes 'cancelled'",
  orchSrc.includes("setProjectStatus(projectName, 'cancelled')"),
);

// ─── 2. orchestrator.js list renders cancelled as chalk.red ─────────────
check(
  "orchestrator.js CLI list uses chalk.red for cancelled",
  orchSrc.includes("'cancelled' ? chalk.red"),
);

// ─── 3. auto-runner.js finalize propagates cancelled to projects ─────────
const arSrc = readSrc('src/auto-runner.js');
check(
  "auto-runner.js finalize calls setProjectStatus for cancelled",
  arSrc.includes("status === 'cancelled'") && arSrc.includes("setProjectStatus(projectName, 'cancelled')"),
);

// ─── 4. auto-runner.js cancelled next-actions key is 'auto-run-cancelled' ─
check(
  "auto-runner.js printRunSummary uses 'auto-run-cancelled' key",
  arSrc.includes("'auto-run-cancelled'") && !arSrc.includes("'auto-run-paused'; // same suggestions as paused"),
);

// ─── 5. auto-runner.js resume hint only for paused, not cancelled ────────
check(
  "auto-runner.js resume hint only for paused, not cancelled",
  !arSrc.includes("status === 'paused' || status === 'cancelled'"),
);

// ─── 6. job-runner.js maps cancelled to 'auto-run-cancelled' ────────────
const jrSrc = readSrc('src/server/job-runner.js');
check(
  "job-runner.js maps cancelled status to 'auto-run-cancelled'",
  jrSrc.includes("'cancelled' ? 'auto-run-cancelled'"),
);

// ─── 7. next-actions.js has 'auto-run-cancelled' case ───────────────────
const naSrc = readSrc('src/lib/next-actions.js');
check(
  "next-actions.js has auto-run-cancelled case",
  naSrc.includes("'auto-run-cancelled'"),
);

// ─── 8. coach.js has cancelled project rule ──────────────────────────────
const coachSrc = readSrc('src/lib/coach.js');
check(
  "coach.js has project.status === 'cancelled' rule",
  coachSrc.includes("project.status === 'cancelled'"),
);

// ─── 9. /list glyph handles cancelled ───────────────────────────────────
const thSrc = readSrc('src/server/telegram-handlers.js');
check(
  "telegram-handlers.js /list has cancelled glyph (⊘)",
  thSrc.includes("'cancelled' ? '⊘'") || thSrc.includes('"cancelled" ? "⊘"'),
);

// ─── 10. state.js setProjectStatus has VALID_STATUSES guard ─────────────
const stateSrc = readSrc('src/state.js');
check(
  "state.js setProjectStatus has VALID_STATUSES guard",
  stateSrc.includes('VALID_STATUSES'),
);
check(
  "state.js VALID_STATUSES does not include review-pending",
  !stateSrc.includes("'review-pending'"),
);

// ─── 11. project.schema.json does not contain review-pending ────────────
const schema = readSrc('config/schemas/project.schema.json');
check(
  "project.schema.json does not contain review-pending",
  !schema.includes('review-pending'),
);

// ─── 12. Functional: setProjectStatus writes 'cancelled' to DB ──────────
{
  const sandbox = mkdtempSync(join(tmpdir(), 'v0_14_32-cancel-verify-'));
  const dbPath = join(sandbox, 'test.db');
  // Write a temp script file so import.meta.url resolves correctly
  const { writeFileSync } = await import('node:fs');
  const tmpScript = join(sandbox, 'run.mjs');
  const scriptContent = `
import { resolve } from 'node:path';
const REPO_ROOT = ${JSON.stringify(REPO_ROOT)};

process.env.DB_PATH = ${JSON.stringify(dbPath)};

const { getDb, upsertProject, setProjectStatus, getProject } = await import(resolve(REPO_ROOT, 'src/state.js'));

getDb();

upsertProject({ name: 'cancel-test', status: 'in-progress', current_phase: 1, total_phases: 5 });
setProjectStatus('cancel-test', 'cancelled');
const p = getProject('cancel-test');
if (p.status !== 'cancelled') throw new Error('Expected cancelled, got: ' + p.status);
console.log('OK');
`;
  writeFileSync(tmpScript, scriptContent);

  let funcOk = false;
  let funcDetails = '';
  try {
    const out = execSync(`node ${JSON.stringify(tmpScript)}`, {
      cwd: REPO_ROOT,
      env: { ...process.env, DB_PATH: dbPath },
      encoding: 'utf8',
      timeout: 15000,
    });
    funcOk = out.trim() === 'OK';
    funcDetails = out.trim();
  } catch (err) {
    funcOk = false;
    funcDetails = (err.stderr || err.message || String(err)).slice(0, 300);
  } finally {
    try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  check(
    "functional: setProjectStatus writes 'cancelled' to DB and reads back correctly",
    funcOk,
    funcDetails,
  );
}

// ─── Summary ────────────────────────────────────────────────────────────
console.log('');
if (failed === 0) {
  console.log(chalk.bold.green(`✓ All ${passed} checks passed.`));
  process.exit(0);
} else {
  console.log(chalk.bold.red(`✗ ${failed} failed, ${passed} passed.`));
  process.exit(1);
}
