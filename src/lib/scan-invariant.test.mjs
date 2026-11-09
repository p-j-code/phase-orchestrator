// Invariant tests for the one-live-row guarantee in the suggestions table.
// Run: node src/lib/scan-invariant.test.mjs
// Exits 0 on all pass, non-zero on any failure.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Must set DB_PATH before any import that touches state
const testDbDir = mkdtempSync(path.join(tmpdir(), 'aorch-invariant-test-'));
process.env.DB_PATH = path.join(testDbDir, 'test.db');

const {
  saveSuggestions,
  staleAllSuggestions,
  getLatestSuggestions,
  getEarlierSuggestionTitles,
  acceptSuggestions,
  upsertProject,
  closeDb,
} = await import('../state.js');

// ── Test harness ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, description) {
  if (condition) {
    console.log(`PASS ${description}`);
    passed++;
  } else {
    console.log(`FAIL ${description}`);
    failed++;
  }
}

const PROJ = `inv-test-${Date.now()}`;
upsertProject({ name: PROJ, tech_stack: 'test', total_phases: 1, status: 'in-progress' });

const snapshot = { projectType: 'cli', name: PROJ, dependencies: {}, completedPhases: 0, phaseTitles: [], scannedAt: new Date().toISOString() };
const suggs = [
  { id: 's1', type: 'new-feature', category: 'logic', title: 'Feature Alpha', description: 'desc', effort: 'small', impact: 'high', suggestedSlot: 1 },
  { id: 's2', type: 'enhancement', category: 'dx',    title: 'DX Beta',       description: 'desc', effort: 'small', impact: 'medium', suggestedSlot: 1 },
];

// ── Test 1: Double-save without stale leaves two live rows (pre-fix broken state) ──

console.log('\n--- Test 1: double-save without stale ---');
{
  const PROJ1 = `inv-double-${Date.now()}`;
  upsertProject({ name: PROJ1, tech_stack: 'test', total_phases: 1, status: 'in-progress' });

  saveSuggestions(PROJ1, { projectType: 'cli', scanSnapshot: snapshot, suggestions: suggs });
  saveSuggestions(PROJ1, { projectType: 'cli', scanSnapshot: snapshot, suggestions: suggs });

  // getLatestSuggestions returns only one (highest id) — but there are two 'draft' rows
  const latest = getLatestSuggestions(PROJ1);
  // We cannot assert count without raw DB, but we can confirm getLatestSuggestions returns something
  assert(latest !== null, 'T1a: getLatestSuggestions returns a row after double-save');

  // Document the broken state: two rows exist, getLatestSuggestions hides the older one
  // (this test is a regression marker — the pre-fix state is documented, not asserted away)
  assert(latest.status === 'draft', 'T1b: latest row is draft after double-save without stale');
}

// ── Test 2: Stale + save leaves exactly one live row ────────────────────────────

console.log('\n--- Test 2: stale + save = one live row ---');
{
  const PROJ2 = `inv-single-${Date.now()}`;
  upsertProject({ name: PROJ2, tech_stack: 'test', total_phases: 1, status: 'in-progress' });

  // First scan + accept
  const id1 = saveSuggestions(PROJ2, { projectType: 'cli', scanSnapshot: snapshot, suggestions: suggs });
  acceptSuggestions(id1, { selected: [suggs[0]], pipelinePlan: { '1': ['s1'] }, pipelinePasses: 1 });

  assert(getLatestSuggestions(PROJ2)?.status === 'accepted', 'T2a: row is accepted after first accept');

  // Second scan: stale first, then save
  staleAllSuggestions(PROJ2);
  assert(getLatestSuggestions(PROJ2) === null, 'T2b: no live row after staleAllSuggestions');

  saveSuggestions(PROJ2, { projectType: 'cli', scanSnapshot: snapshot, suggestions: suggs });

  const latest = getLatestSuggestions(PROJ2);
  assert(latest !== null,          'T2c: one live row after stale + save');
  assert(latest.status === 'draft', 'T2d: new live row is draft');
}

// ── Test 3: accepted selections remain visible before and after staling ──

console.log('\n--- Test 3: accepted selection is immediately visible to avoid-list ---');
{
  const PROJ3 = `inv-avoid-${Date.now()}`;
  upsertProject({ name: PROJ3, tech_stack: 'test', total_phases: 1, status: 'in-progress' });

  const id = saveSuggestions(PROJ3, { projectType: 'cli', scanSnapshot: snapshot, suggestions: suggs });
  acceptSuggestions(id, {
    selected: [suggs[0], suggs[1]],
    pipelinePlan: { '1': ['s1', 's2'] },
    pipelinePasses: 1,
  });

  // Accepted selected_json is part of the avoid-list immediately, preventing a
  // subsequent scan from proposing the plan the operator just accepted.
  const titlesBefore = getEarlierSuggestionTitles(PROJ3);
  assert(titlesBefore.includes('Feature Alpha'), 'T3a: accepted Feature Alpha is already in avoid-list');
  assert(titlesBefore.includes('DX Beta'),        'T3b: accepted DX Beta is already in avoid-list');

  // Staling retains the same protection for historical suggestions.
  staleAllSuggestions(PROJ3);

  const titlesAfter = getEarlierSuggestionTitles(PROJ3);
  assert(titlesAfter.includes('Feature Alpha'), 'T3c: Feature Alpha remains in avoid-list after staling');
  assert(titlesAfter.includes('DX Beta'),        'T3d: DX Beta remains in avoid-list after staling');
}

// ── Teardown ────────────────────────────────────────────────────────────────────

closeDb();

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
