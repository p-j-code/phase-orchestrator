#!/usr/bin/env node
/**
 * launch-with-retry — run a single project's current pipeline (go --unattended)
 * to completion, transparently waiting out and resuming through rate-limit /
 * budget pauses. This is what the web UI's "Launch Pipeline" button spawns.
 *
 * Unlike scripts/brief-chain.mjs, this does NOT touch inputs/brief.md or the
 * queue dir, and never runs reset-brief — it just drives whatever plan/brief
 * the project already has to completion. For chaining multiple full briefs
 * in sequence, use brief-chain.mjs instead.
 *
 * Usage:
 *   node scripts/launch-with-retry.mjs <project>
 *
 * Exit codes:
 *   0 — run completed (status = ready-for-qa / completed)
 *   1 — unrecoverable failure or a pause that needs a human decision
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { createWriteStream, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runOrchestratorWithRetry } from '../src/lib/unattended-retry.js';
import { forecastRun, renderForecastLine } from '../src/commands/predict.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Cap the pre-flight wait so a bad estimate can never park a launch for hours;
// beyond a single window the run can't fully fit anyway (forecast returns null).
const MAX_PREFLIGHT_WAIT_MS = 6 * 60 * 60 * 1000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ORC       = path.join(REPO_ROOT, 'src', 'orchestrator.js');
const DB_PATH   = process.env.DB_PATH || path.join(REPO_ROOT, 'state', 'orchestrator.db');

const RETRY_WAIT_MINUTES = Number(process.env.RETRY_WAIT_MINUTES ?? 30);

let _logStream = null;

function _write(stream, msg) {
  try { stream.write(msg); } catch { /* ignore write errors on closed streams */ }
}

function log(msg) {
  const line = `[launch] ${msg}\n`;
  process.stdout.write(line);
  if (_logStream) _write(_logStream, line);
}
function err(msg) {
  const line = `[launch] ERROR: ${msg}\n`;
  process.stderr.write(line);
  if (_logStream) _write(_logStream, line);
}

async function main() {
  const [project] = process.argv.slice(2);
  if (!project) {
    err('Usage: node scripts/launch-with-retry.mjs <project>');
    process.exit(1);
  }

  // Persistent log file (survives detached runs) — same convention as brief-chain.mjs.
  const logsDir = path.join(REPO_ROOT, 'logs');
  const logPath = path.join(logsDir, `launch-${project}.log`);
  const pidPath = path.join(logsDir, `launch-${project}.pid`);
  await fs.mkdir(logsDir, { recursive: true });
  _logStream = createWriteStream(logPath, { flags: 'a' });
  await fs.writeFile(pidPath, String(process.pid), 'utf-8');
  process.on('exit', () => { try { unlinkSync(pidPath); } catch {} });
  log(`Started  pid=${process.pid}  log=${logPath}`);
  log(`Project  : ${project}`);
  log(`API retry: wait for rate-limit window reset, poll every 5min`);

  // Phase 63 (P7) — deterministic pre-flight window forecast. If the whole run
  // would fit after the 5h window sheds some calls, wait that long up front so
  // it runs clean instead of pausing mid-phase. Best-effort: any forecast error
  // just proceeds immediately, and runOrchestratorWithRetry's 5-min poll remains
  // the fallback for anything the forecast can't see.
  try {
    const forecast = await forecastRun(project);
    log(`Forecast : ${renderForecastLine(forecast)}`);
    const waitMs = forecast?.waitForFullFitMs;
    if (Number.isFinite(waitMs) && waitMs > 0) {
      const capped = Math.min(waitMs, MAX_PREFLIGHT_WAIT_MS);
      log(`Pre-wait : window won't fit the full run yet — sleeping ~${Math.round(capped / 60000)}m for reclaim before launch`);
      await sleep(capped);
    }
  } catch (e) {
    log(`Forecast : unavailable (${e.message}) — launching now`);
  }

  const ok = await runOrchestratorWithRetry(
    ORC, DB_PATH, project,
    ['go', '--unattended', project],
    ['resume', project, '--unattended'],
    { log, err, retryWaitMinutes: RETRY_WAIT_MINUTES },
  );

  if (!ok) {
    err(`Run did not complete — see reason above. Needs a human look before resuming.`);
    process.exit(1);
  }

  log(`"${project}" run complete ✓`);
}

main().catch(e => { err(e.message); process.exit(1); });
