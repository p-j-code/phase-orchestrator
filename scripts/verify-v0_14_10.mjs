// v0.14.10 verifier — feeds the EXACT error payload from the v0.14.9 dogfood
// failure into the patched classifier and hint logic, and asserts:
//
//   1. TRANSIENT_PATTERNS now matches → the runner would retry next time.
//   2. inferHint() returns the network hint, NOT the permission hint —
//      proving the false-positive on "permission_denials" is dead.
//   3. inferHint() still fires correctly on a genuine permission error
//      (real EACCES, real "permission denied" string, non-empty array).
//
// Run with: node scripts/verify-v0_14_10.mjs
// Expected: every test prints "OK" and the process exits 0.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import chalk from 'chalk';

// We test the source directly via regex extraction rather than importing
// claude-runner.js (which would pull in better-sqlite3 etc.). The patterns
// live at the top of the file in stable shapes, easy to extract.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(resolve(__dirname, '..', 'src/claude-runner.js'), 'utf8');

function extractTransientPatterns() {
  const block = SOURCE.match(/const TRANSIENT_PATTERNS = \[([\s\S]*?)\];/);
  if (!block) throw new Error('TRANSIENT_PATTERNS not found');
  const lines = block[1].split('\n').map((l) => l.trim()).filter((l) => /^\/[^/]/.test(l));
  return lines.map((l) => {
    const m = l.match(/^\/(.+)\/([gimsuy]*)/);
    if (!m) throw new Error(`unparseable regex line: ${l}`);
    return new RegExp(m[1], m[2]);
  });
}

function isTransient(msg, patterns) {
  return patterns.some((p) => p.test(msg));
}

// Import the inferHint function indirectly by evaling its body. We pull
// it out of the source so we don't have to load the whole module graph.
function extractInferHint() {
  const m = SOURCE.match(/function inferHint\(msg\) \{([\s\S]*?)\n\}/);
  if (!m) throw new Error('inferHint not found');
  // eslint-disable-next-line no-new-func
  return new Function('msg', m[1]);
}

const TRANSIENT = extractTransientPatterns();
const inferHint = extractInferHint();

let passed = 0;
let failed = 0;
function check(label, ok, details) {
  if (ok) {
    console.log(chalk.green(`  OK  `), label);
    passed += 1;
  } else {
    console.log(chalk.red(`  FAIL`), label, details ? chalk.dim(`— ${details}`) : '');
    failed += 1;
  }
}

// ─── The exact failure payload reported by the user ───────────────────────
const REAL_FAILURE_MSG = `claude exited 1: {"type":"result","subtype":"success","is_error":true,`
  + `"api_error_status":null,"duration_ms":222595,"duration_api_ms":20653,"num_turns":6,`
  + `"result":"API Error: The socket connection was closed unexpectedly. For more information, `
  + `pass \`verbose: true\` in the second argument to fetch()","stop_reason":"stop_sequence",`
  + `"session_id":"b52ee4ef-3ba4-41b4-a22c-46607b89f440","total_cost_usd":0.33,`
  + `"permission_denials":[],"terminal_reason":"completed","fast_mode_state":"off"}`;

console.log(chalk.bold('\n── v0.14.10 patch verification ──\n'));
console.log(chalk.dim('Real failure payload (truncated):'));
console.log(chalk.dim(`  ${REAL_FAILURE_MSG.slice(0, 100)}…\n`));

// ─── Bug A: TRANSIENT_PATTERNS now catches the socket-closed wording ──
console.log(chalk.bold('Bug A — retry classification:'));
check(
  'real failure is classified as transient (retry will fire)',
  isTransient(REAL_FAILURE_MSG, TRANSIENT),
);
check(
  '"socket connection was closed unexpectedly" matches',
  isTransient('socket connection was closed unexpectedly', TRANSIENT),
);
check(
  'previously-covered "ECONNRESET" still matches',
  isTransient('Error: read ECONNRESET', TRANSIENT),
);
check(
  'previously-covered "socket hang up" still matches',
  isTransient('socket hang up', TRANSIENT),
);
check(
  '"connection closed" also matches (safety net)',
  isTransient('upstream connection closed', TRANSIENT),
);
check(
  'a clearly-permanent error (invalid request) does NOT match',
  !isTransient('Error: invalid request payload', TRANSIENT),
);
check(
  'a clearly-permanent error (401 Unauthorized) does NOT match',
  !isTransient('Error: 401 Unauthorized', TRANSIENT),
);

// ─── Bug B: inferHint no longer false-positives on permission_denials ──
console.log(chalk.bold('\nBug B — hint classification:'));
const hintForReal = inferHint(REAL_FAILURE_MSG);
check(
  'real failure does NOT get the permission-denied hint',
  !/Check \.claude\/settings\.json/.test(hintForReal || ''),
  `got: ${JSON.stringify(hintForReal)}`,
);
check(
  'real failure gets the transient-network hint instead',
  /Transient network error/.test(hintForReal || ''),
  `got: ${JSON.stringify(hintForReal)}`,
);

// Now verify the permission hint STILL fires when it should:
const realPermPayload = `claude exited 1: {"is_error":true,"result":"File operation failed",`
  + `"permission_denials":[{"tool":"Edit","path":"/src/state.js","reason":"path outside cwd"}]}`;
check(
  'non-empty permission_denials array still triggers permission hint',
  /Check \.claude\/settings\.json/.test(inferHint(realPermPayload) || ''),
);
check(
  'plain "permission denied" string still triggers permission hint',
  /Check \.claude\/settings\.json/.test(inferHint('EACCES: permission denied, open /foo') || ''),
);
check(
  'OS EACCES still triggers permission hint',
  /Check \.claude\/settings\.json/.test(inferHint('Error: EACCES on /tmp/x') || ''),
);

// Other hints unchanged
check(
  'ANTHROPIC_API_KEY conflict hint still fires',
  /unset ANTHROPIC_API_KEY/.test(inferHint('ANTHROPIC_API_KEY found in env') || ''),
);
check(
  'OAuth hint still fires',
  /logout && claude \/login/.test(inferHint('login required') || ''),
);
check(
  'rate-limit hint still fires (independent of transient classification)',
  /5-hour window/.test(inferHint('rate limit exceeded') || ''),
);
check(
  'no hint for an unrelated message',
  inferHint('random unrelated error') === null,
);

// ─── Summary ────────────────────────────────────────────────────────────
console.log();
if (failed === 0) {
  console.log(chalk.bold.green(`✓ All ${passed} checks passed.`));
  process.exit(0);
} else {
  console.log(chalk.bold.red(`✗ ${failed} failed, ${passed} passed.`));
  process.exit(1);
}
