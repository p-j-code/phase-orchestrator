#!/usr/bin/env node
// verify-cli-cancellation.mjs
//
// Proves the fix-r13-1 changes:
//   1 — src/auto-runner.js imports killAll from claude-runner.js
//   2 — SIGINT handler in auto-runner.js calls killAll()
//   3 — killCurrent in claude-runner.js sends at least two SIGTERM group-kill
//       calls (the initial + the 100ms setsid-race retry)
//   4 — the retry-backoff cancel block (near _cancelRequested.has(jobKey))
//       sends at least two SIGTERM group-kill calls in its surrounding context
//
// Run:  node scripts/verify-cli-cancellation.mjs
// Exits non-zero on any failure.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else       { fail++; console.log(`  ✗ ${name}`); }
};

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const autoRunner = read('src/auto-runner.js');
const claudeRunner = read('src/claude-runner.js');

// Group-kill pattern (phase-8): call sites now pass the POSITIVE proc.pid —
// _groupKill negates internally (process.kill(-pid)) to target the whole group.
// The old -proc.pid spelling double-negated to a single-process kill, the bug.
const GROUP_KILL_SIGTERM = /_groupKill\(proc\.pid,\s*'SIGTERM'\)/g;

console.log('\nCheck 1 — auto-runner.js imports killAll from claude-runner.js');
{
  ok(
    'imports killAll from claude-runner.js (direct or destructured)',
    /import[^;]*\bkillAll\b[^;]*claude-runner/.test(autoRunner),
  );
}

console.log('\nCheck 2 — SIGINT handler in auto-runner.js calls killAll()');
{
  // Extract a window around the sigintHandler to confirm killAll is called inside it.
  const sigintIdx = autoRunner.indexOf('sigintHandler');
  const handlerBlock = sigintIdx >= 0
    ? autoRunner.slice(sigintIdx, sigintIdx + 1500)
    : '';
  ok(
    'sigintHandler body references killAll(',
    handlerBlock.includes('killAll('),
  );
}

console.log('\nCheck 3 — killCurrent sends at least two SIGTERM group-kill calls');
{
  // Extract the killCurrent function body.
  const startIdx = claudeRunner.indexOf('export function killCurrent(');
  const endIdx   = claudeRunner.indexOf('\nexport function killAll(', startIdx);
  const killCurrentBody = startIdx >= 0 && endIdx > startIdx
    ? claudeRunner.slice(startIdx, endIdx)
    : '';
  const sigtermCount = (killCurrentBody.match(GROUP_KILL_SIGTERM) || []).length;
  ok(
    `killCurrent contains >=2 SIGTERM group-kill calls (found ${sigtermCount})`,
    sigtermCount >= 2,
  );
}

console.log('\nCheck 4 — retry-backoff cancel block sends at least two SIGTERM group-kill calls');
{
  // Find the _cancelRequested.has(jobKey) check that guards the post-spawn cancel.
  const cancelIdx = claudeRunner.indexOf('_cancelRequested.has(jobKey)');
  if (cancelIdx < 0) {
    ok('_cancelRequested.has(jobKey) block exists in claude-runner.js', false);
  } else {
    // Take up to 800 chars after the match to capture the whole if-block.
    const blockContext = claudeRunner.slice(cancelIdx, cancelIdx + 800);
    const sigtermCount = (blockContext.match(GROUP_KILL_SIGTERM) || []).length;
    ok(
      `cancel block near _cancelRequested.has(jobKey) has >=2 SIGTERM calls (found ${sigtermCount})`,
      sigtermCount >= 2,
    );
  }
}

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — verify-cli-cancellation: ${pass}/4\n`);
process.exit(fail === 0 ? 0 : 1);
