// Tests for FR19 (auto-brief from raw-thoughts) and FR21 (handoff injection into guide)
// Run with: node src/auto-brief-handoff.test.mjs

import { writeFileSync, mkdirSync, mkdtempSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { shouldRunAutoBrief } from './auto-runner.js';
import { loadMostRecentHandoffBlock } from './lib/phase-runner.js';

// DB_PATH: getDb() in state.js is lazily initialized, so setting this before
// any test function runs is sufficient. Our test functions don't touch the DB,
// but this keeps the pattern consistent with the rest of the test suite.
const testDbDir = mkdtempSync(path.join(tmpdir(), 'aorch-fr19-'));
process.env.DB_PATH = path.join(testDbDir, 'test.db');

let passed = 0;
let failed = 0;

function assert(condition, description) {
  if (condition) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${description}`);
    failed++;
  }
}

const tmpDirs = [];

function makeProjDir(label) {
  const d = path.join(tmpdir(), `aorch-fr19-${label}-${Date.now()}`);
  mkdirSync(path.join(d, '.guide'), { recursive: true });
  tmpDirs.push(d);
  return d;
}

// ─── FR19 — shouldRunAutoBrief ────────────────────────────────────────────────
console.log('\nFR19 — shouldRunAutoBrief:');

// Test 1: raw-thoughts.md with >80 bytes, brief.md missing → true
{
  const projDir = makeProjDir('t1');
  writeFileSync(path.join(projDir, '.guide', 'raw-thoughts.md'), 'x'.repeat(100));
  const result = await shouldRunAutoBrief(projDir);
  assert(result === true, 'raw-thoughts >80 bytes, brief.md missing → true');
}

// Test 2: raw-thoughts.md strictly newer than brief.md → true
{
  const projDir = makeProjDir('t2');
  const rtPath = path.join(projDir, '.guide', 'raw-thoughts.md');
  const bPath  = path.join(projDir, '.guide', 'brief.md');
  writeFileSync(rtPath, 'x'.repeat(100));
  writeFileSync(bPath,  'old brief content');
  const t1 = new Date(Date.now() - 2000);
  const t2 = new Date(Date.now() - 1000);
  utimesSync(bPath,  t1, t1); // brief is older
  utimesSync(rtPath, t2, t2); // raw-thoughts is newer
  const result = await shouldRunAutoBrief(projDir);
  assert(result === true, 'raw-thoughts strictly newer than brief.md → true');
}

// Test 3: brief.md newer than raw-thoughts.md → false
{
  const projDir = makeProjDir('t3');
  const rtPath = path.join(projDir, '.guide', 'raw-thoughts.md');
  const bPath  = path.join(projDir, '.guide', 'brief.md');
  writeFileSync(rtPath, 'x'.repeat(100));
  writeFileSync(bPath,  'brief content');
  const t1 = new Date(Date.now() - 2000);
  const t2 = new Date(Date.now() - 1000);
  utimesSync(rtPath, t1, t1); // raw-thoughts is older
  utimesSync(bPath,  t2, t2); // brief is newer
  const result = await shouldRunAutoBrief(projDir);
  assert(result === false, 'brief.md newer than raw-thoughts → false');
}

// Test 4: raw-thoughts.md with ≤80 bytes → false
{
  const projDir = makeProjDir('t4');
  writeFileSync(path.join(projDir, '.guide', 'raw-thoughts.md'), 'x'.repeat(80));
  const result = await shouldRunAutoBrief(projDir);
  assert(result === false, 'raw-thoughts.md with exactly 80 bytes → false (not strictly greater than 80)');
}

// Test 4b: raw-thoughts.md with <80 bytes → false
{
  const projDir = makeProjDir('t4b');
  writeFileSync(path.join(projDir, '.guide', 'raw-thoughts.md'), 'x'.repeat(40));
  const result = await shouldRunAutoBrief(projDir);
  assert(result === false, 'raw-thoughts.md with <80 bytes → false');
}

// Test 5: raw-thoughts.md missing entirely → false
{
  const projDir = makeProjDir('t5');
  // do not write raw-thoughts.md
  const result = await shouldRunAutoBrief(projDir);
  assert(result === false, 'raw-thoughts.md missing entirely → false');
}

// Test 6: Both files same mtime (not strictly newer) → false
{
  const projDir = makeProjDir('t6');
  const rtPath = path.join(projDir, '.guide', 'raw-thoughts.md');
  const bPath  = path.join(projDir, '.guide', 'brief.md');
  writeFileSync(rtPath, 'x'.repeat(100));
  writeFileSync(bPath,  'brief content');
  const sameTime = new Date(Date.now() - 1000);
  utimesSync(rtPath, sameTime, sameTime);
  utimesSync(bPath,  sameTime, sameTime);
  const result = await shouldRunAutoBrief(projDir);
  assert(result === false, 'raw-thoughts and brief.md have same mtime → false (not strictly newer)');
}

// ─── FR21 — loadMostRecentHandoffBlock ───────────────────────────────────────
console.log('\nFR21 — loadMostRecentHandoffBlock:');

function makeHandoffProjDir(label) {
  const d = path.join(tmpdir(), `aorch-fr21-${label}-${Date.now()}`);
  mkdirSync(path.join(d, '.guide', 'handoffs'), { recursive: true });
  tmpDirs.push(d);
  return d;
}

// Test 7: Empty handoffs dir → null
{
  const projDir = makeHandoffProjDir('t7');
  const result = await loadMostRecentHandoffBlock(projDir);
  assert(result === null, 'empty handoffs dir → null');
}

// Test 8: One handoff file → wrapped in <previous_handoff>
{
  const projDir = makeHandoffProjDir('t8');
  const handoffsDir = path.join(projDir, '.guide', 'handoffs');
  writeFileSync(path.join(handoffsDir, 'handoff-2026-06-01T10-00-00.md'), 'Phase 5 is done. Next is phase 6.');
  const result = await loadMostRecentHandoffBlock(projDir);
  assert(result !== null, 'one handoff file → non-null result');
  assert(result.startsWith('<previous_handoff>'), 'block starts with <previous_handoff>');
  assert(result.includes('Phase 5 is done.'), 'block contains handoff content');
  assert(result.includes('</previous_handoff>'), 'block ends with </previous_handoff>');
}

// Test 9: Multiple handoff files → most recent by mtime returned, not alphabetically latest
{
  const projDir = makeHandoffProjDir('t9');
  const handoffsDir = path.join(projDir, '.guide', 'handoffs');

  writeFileSync(path.join(handoffsDir, 'handoff-2026-01-01T00-00-00.md'), 'oldest content');
  writeFileSync(path.join(handoffsDir, 'handoff-2026-03-01T00-00-00.md'), 'middle content');
  writeFileSync(path.join(handoffsDir, 'handoff-2026-06-01T00-00-00.md'), 'newest content');

  utimesSync(path.join(handoffsDir, 'handoff-2026-01-01T00-00-00.md'), new Date(1000), new Date(1000));
  utimesSync(path.join(handoffsDir, 'handoff-2026-03-01T00-00-00.md'), new Date(2000), new Date(2000));
  utimesSync(path.join(handoffsDir, 'handoff-2026-06-01T00-00-00.md'), new Date(3000), new Date(3000));

  const result = await loadMostRecentHandoffBlock(projDir);
  assert(result !== null, 'multiple handoffs → non-null result');
  assert(result.includes('newest content'), 'most recent handoff by mtime is used, not name sort');
  assert(!result.includes('oldest content'), 'older handoffs not included');
  assert(result.startsWith('<previous_handoff>'), 'block wrapped in <previous_handoff>');
}

// Test 9b: mtime overrides filename ordering — oldest-named file is newest by mtime
{
  const projDir = makeHandoffProjDir('t9b');
  const handoffsDir = path.join(projDir, '.guide', 'handoffs');

  writeFileSync(path.join(handoffsDir, 'handoff-2026-01-01T00-00-00.md'), 'oldest-name content');
  writeFileSync(path.join(handoffsDir, 'handoff-2026-06-01T00-00-00.md'), 'newest-name content');

  // Give the oldest-named file the newest mtime
  utimesSync(path.join(handoffsDir, 'handoff-2026-01-01T00-00-00.md'), new Date(9999), new Date(9999));
  utimesSync(path.join(handoffsDir, 'handoff-2026-06-01T00-00-00.md'), new Date(1000), new Date(1000));

  const result = await loadMostRecentHandoffBlock(projDir);
  assert(result !== null, 'mtime-overrides-name: non-null result');
  assert(result.includes('oldest-name content'), 'oldest-named file selected because its mtime is newest');
  assert(!result.includes('newest-name content'), 'newest-named file not selected (older mtime)');
}

// Test 10: Handoff file exists but is empty/whitespace → null
{
  const projDir = makeHandoffProjDir('t10');
  const handoffsDir = path.join(projDir, '.guide', 'handoffs');
  writeFileSync(path.join(handoffsDir, 'handoff-2026-06-01T10-00-00.md'), '   \n  ');
  const result = await loadMostRecentHandoffBlock(projDir);
  assert(result === null, 'handoff file with only whitespace → null');
}

// Test 11: Handoffs dir doesn't exist → null
{
  const projDir = path.join(tmpdir(), `aorch-fr21-t11-${Date.now()}`);
  mkdirSync(path.join(projDir, '.guide'), { recursive: true });
  // do NOT create handoffs subdir
  tmpDirs.push(projDir);
  const result = await loadMostRecentHandoffBlock(projDir);
  assert(result === null, 'handoffs dir does not exist → null');
}

// Test 12: Block starts with <previous_handoff> and contains handoff content verbatim
{
  const projDir = makeHandoffProjDir('t12');
  const handoffsDir = path.join(projDir, '.guide', 'handoffs');
  const handoffContent = 'Phase 7 complete. Known issue: widget render flicker on iOS.';
  writeFileSync(path.join(handoffsDir, 'handoff-2026-06-01T12-00-00.md'), handoffContent);
  const result = await loadMostRecentHandoffBlock(projDir);
  assert(result !== null, 'block is non-null');
  assert(result.startsWith('<previous_handoff>'), 'block starts with <previous_handoff>');
  assert(result.includes(handoffContent), 'block contains handoff content verbatim');
  assert(result.trimEnd().endsWith('</previous_handoff>'), 'block ends with </previous_handoff>');
  assert(result.includes('The following is a handoff document'), 'block includes framing instruction');
}

// ─── cleanup ─────────────────────────────────────────────────────────────────
for (const d of tmpDirs) {
  try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
}
try { rmSync(testDbDir, { recursive: true, force: true }); } catch { /* ignore */ }

// ─── summary ─────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
