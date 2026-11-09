// Tests for resolveSuggestionSlot — cursor/archive/slot-resolution logic.
// Uses in-memory SQLite (DB_PATH=:memory:) for real state operations,
// and injectable fs/chalk deps to avoid real filesystem side-effects.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

// Must be set before any module that calls getDb() is loaded.
process.env.DB_PATH = ':memory:';

const { resolveSuggestionSlot, commitAdvance } = await import('./suggestion-slot.js');
const {
  acceptSuggestions, saveSuggestions, getLatestSuggestions,
  setSuggestionNextPass, upsertProject, setProjectStatus, staleAllSuggestions,
} = await import('../state.js');

// ─── helpers ────────────────────────────────────────────────────────────────

function setupProject(name, opts = {}) {
  upsertProject({ name, tech_stack: 'node', total_phases: opts.totalPhases ?? 3 });
  if (opts.status) setProjectStatus(name, opts.status);
}

function saveAndAccept(projectName, pipelinePlan, passes) {
  const id = saveSuggestions(projectName, {
    projectType: 'cli',
    scanSnapshot: { projectType: 'cli' },
    suggestions: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }],
  });
  acceptSuggestions(id, {
    selected: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    pipelinePlan,
    pipelinePasses: passes,
  });
}

const noopChalk = { dim: (s) => s, yellow: (s) => s };

function makeMockFs() {
  const calls = { copyFile: [], unlink: [] };
  const fs = {
    copyFile: async (src, dst) => { calls.copyFile.push({ src, dst }); },
    unlink:   async (p)        => { calls.unlink.push(p); },
  };
  return { fs, calls };
}

function noCopyFs() {
  const calls = { copyFile: [], unlink: [] };
  const fs = {
    copyFile: async () => { throw new Error('copyFile should not be called'); },
    unlink:   async () => { throw new Error('unlink should not be called'); },
  };
  return { fs, calls };
}

// ─── Tests: no accepted plan ─────────────────────────────────────────────────

test('no accepted plan → { requestedSlot: 1, effectiveSlot: 1 }', async () => {
  const { requestedSlot, effectiveSlot } = await resolveSuggestionSlot(
    'slot-test-none', '/fake/dir',
    { slotExplicit: false, slotParsed: null },
    { chalk: noopChalk, fs: noCopyFs().fs }
  );
  assert.equal(requestedSlot, 1);
  assert.equal(effectiveSlot, 1);
});

// ─── Tests: 1x plan (single pass) ───────────────────────────────────────────

test('1x plan, status ready-for-qa → no archive, cursor stays at 1', async () => {
  setupProject('slot-1x', { status: 'ready-for-qa' });
  saveAndAccept('slot-1x', { '1': ['a', 'b', 'c'] }, 1);

  const { fs: mockFs, calls } = makeMockFs();
  const { requestedSlot, effectiveSlot } = await resolveSuggestionSlot(
    'slot-1x', '/fake/dir',
    { slotExplicit: false, slotParsed: null },
    { chalk: noopChalk, fs: mockFs }
  );

  assert.equal(requestedSlot, 1);
  assert.equal(effectiveSlot, 1);
  assert.equal(calls.copyFile.length, 0, 'should not archive plan files for 1x plan');
  assert.equal(calls.unlink.length, 0);
});

// ─── Tests: 2x plan, status in-progress → no advance ────────────────────────

test('2x plan, status in-progress → cursor stays, no archive, no cursor persist', async () => {
  setupProject('slot-inprog', { status: 'in-progress' });
  saveAndAccept('slot-inprog', { '1': ['a', 'b'], '2': ['c'] }, 2);

  const { fs: mockFs, calls } = makeMockFs();
  const { requestedSlot, effectiveSlot } = await resolveSuggestionSlot(
    'slot-inprog', '/fake/dir',
    { slotExplicit: false, slotParsed: null },
    { chalk: noopChalk, fs: mockFs }
  );

  assert.equal(requestedSlot, 1, 'should stay at cursor=1 while in-progress');
  assert.equal(effectiveSlot, 1);
  assert.equal(calls.copyFile.length, 0, 'should not archive while in-progress');
  const row = getLatestSuggestions('slot-inprog');
  assert.equal(row.next_pass, 1, 'cursor should not advance while in-progress');
});

// ─── Tests: 2x plan, status ready-for-qa → resolver defers; commitAdvance executes ──

test('2x plan, status ready-for-qa, Pass 2 non-empty → resolver returns pendingAdvance without side-effects; commitAdvance archives + advances cursor', async () => {
  setupProject('slot-advance', { status: 'ready-for-qa' });
  saveAndAccept('slot-advance', { '1': ['a', 'b'], '2': ['c'] }, 2);
  assert.equal(getLatestSuggestions('slot-advance').next_pass, 1);

  const projDir = path.join('/fake', 'slot-advance');

  const { requestedSlot, effectiveSlot, pendingAdvance } = await resolveSuggestionSlot(
    'slot-advance', projDir,
    { slotExplicit: false, slotParsed: null, advance: true },
    { chalk: noopChalk, fs: noCopyFs().fs }
  );

  // Resolver returns correct slots and pendingAdvance, but makes NO side-effects
  assert.equal(requestedSlot, 2, 'should report advance to Pass 2');
  assert.equal(effectiveSlot, 2);
  assert.ok(pendingAdvance !== null, 'pendingAdvance should be non-null');
  assert.equal(pendingAdvance.cursor, 1, 'cursor is 1');
  assert.equal(pendingAdvance.next, 2, 'next is 2');
  assert.equal(getLatestSuggestions('slot-advance').next_pass, 1, 'cursor must NOT advance yet');

  // Now commit — simulates operator clearing both gates
  const { fs: mockFs, calls } = makeMockFs();
  await commitAdvance('slot-advance', pendingAdvance, { chalk: noopChalk, fs: mockFs, setSuggestionNextPass });

  assert.equal(calls.copyFile.length, 2, 'should archive plan.json and plan.md');
  assert.equal(calls.unlink.length, 2, 'should unlink plan.json and plan.md');

  const archivedNames = calls.copyFile.map(({ dst }) => path.basename(dst));
  assert.ok(archivedNames.some(n => n.startsWith('plan-archived-') && n.endsWith('.json')), 'plan.json archived');
  assert.ok(archivedNames.some(n => n.startsWith('plan-archived-') && n.endsWith('.md')), 'plan.md archived');

  const row = getLatestSuggestions('slot-advance');
  assert.equal(row.next_pass, 2, 'DB cursor should be advanced to 2 after commitAdvance');
});

test('2x plan, status completed, Pass 2 non-empty → resolver defers; commitAdvance archives + advances', async () => {
  setupProject('slot-completed', { status: 'completed' });
  saveAndAccept('slot-completed', { '1': ['a'], '2': ['b', 'c'] }, 2);

  const { requestedSlot, pendingAdvance } = await resolveSuggestionSlot(
    'slot-completed', '/fake/slot-completed',
    { slotExplicit: false, slotParsed: null, advance: true },
    { chalk: noopChalk, fs: noCopyFs().fs }
  );

  assert.equal(requestedSlot, 2, 'requestedSlot is next pass');
  assert.ok(pendingAdvance !== null, 'pendingAdvance non-null');
  assert.equal(getLatestSuggestions('slot-completed').next_pass, 1, 'cursor unchanged before commitAdvance');

  const { fs: mockFs, calls } = makeMockFs();
  await commitAdvance('slot-completed', pendingAdvance, { chalk: noopChalk, fs: mockFs, setSuggestionNextPass });

  assert.equal(calls.copyFile.length, 2);
  assert.equal(getLatestSuggestions('slot-completed').next_pass, 2);
});

// ─── Tests: all remaining passes empty → no advance ──────────────────────────

test('2x plan, status ready-for-qa, Pass 2 is empty → no archive, cursor stays', async () => {
  setupProject('slot-nopass2', { status: 'ready-for-qa' });
  saveAndAccept('slot-nopass2', { '1': ['a', 'b', 'c'], '2': [] }, 2);
  // All items in Pass 1, Pass 2 is empty → nextNonEmptyPass returns null

  const { fs: mockFs, calls } = makeMockFs();
  const { requestedSlot, effectiveSlot } = await resolveSuggestionSlot(
    'slot-nopass2', '/fake/dir',
    { slotExplicit: false, slotParsed: null },
    { chalk: noopChalk, fs: mockFs }
  );

  assert.equal(requestedSlot, 1, 'cursor stays at 1 when no later non-empty pass');
  assert.equal(effectiveSlot, 1);
  assert.equal(calls.copyFile.length, 0, 'no archive when no next pass');
  // cursor not persisted beyond what was already there
  assert.equal(getLatestSuggestions('slot-nopass2').next_pass, 1);
});

test('3x plan, cursor=2, Pass 3 empty → no advance', async () => {
  setupProject('slot-3x-empty3', { status: 'ready-for-qa' });
  saveAndAccept('slot-3x-empty3', { '1': ['a'], '2': ['b'], '3': [] }, 3);
  setSuggestionNextPass('slot-3x-empty3', 2); // simulate cursor already at 2

  const { fs: mockFs, calls } = makeMockFs();
  const { requestedSlot } = await resolveSuggestionSlot(
    'slot-3x-empty3', '/fake/dir',
    { slotExplicit: false, slotParsed: null },
    { chalk: noopChalk, fs: mockFs }
  );

  assert.equal(requestedSlot, 2, 'stays at 2 since Pass 3 is empty');
  assert.equal(calls.copyFile.length, 0);
});

// ─── Tests: explicit --slot bypasses cursor logic ────────────────────────────

test('explicit --slot 1 bypasses cursor logic, no archive even if ready-for-qa', async () => {
  setupProject('slot-explicit', { status: 'ready-for-qa' });
  saveAndAccept('slot-explicit', { '1': ['a'], '2': ['b', 'c'] }, 2);
  setSuggestionNextPass('slot-explicit', 1); // cursor is 1

  const { fs: mockFs, calls } = makeMockFs();
  const { requestedSlot, effectiveSlot } = await resolveSuggestionSlot(
    'slot-explicit', '/fake/dir',
    { slotExplicit: true, slotParsed: 1 },
    { chalk: noopChalk, fs: mockFs }
  );

  assert.equal(requestedSlot, 1, '--slot 1 respected');
  assert.equal(effectiveSlot, 1);
  assert.equal(calls.copyFile.length, 0, 'no archive when --slot is explicit');
  // DB cursor unchanged
  assert.equal(getLatestSuggestions('slot-explicit').next_pass, 1);
});

test('explicit --slot 2 with 2x plan → returns slot 2, no archive', async () => {
  setupProject('slot-explicit2', { status: 'ready-for-qa' });
  saveAndAccept('slot-explicit2', { '1': ['a'], '2': ['b', 'c'] }, 2);

  const { fs: mockFs, calls } = makeMockFs();
  const { requestedSlot, effectiveSlot } = await resolveSuggestionSlot(
    'slot-explicit2', '/fake/dir',
    { slotExplicit: true, slotParsed: 2 },
    { chalk: noopChalk, fs: mockFs }
  );

  assert.equal(requestedSlot, 2);
  assert.equal(effectiveSlot, 2);
  assert.equal(calls.copyFile.length, 0);
});

test('explicit --slot out of range → warns, effectiveSlot equals requestedSlot', async () => {
  setupProject('slot-oor', { status: 'in-progress' });
  saveAndAccept('slot-oor', { '1': ['a'], '2': ['b'] }, 2);

  const warnings = [];
  const warnChalk = { dim: (s) => s, yellow: (s) => { warnings.push(s); return s; } };
  const { fs: mockFs } = makeMockFs();

  const { requestedSlot, effectiveSlot } = await resolveSuggestionSlot(
    'slot-oor', '/fake/dir',
    { slotExplicit: true, slotParsed: 5 },
    { chalk: warnChalk, fs: mockFs }
  );

  assert.equal(requestedSlot, 5);
  assert.equal(effectiveSlot, 5);
  assert.ok(warnings.length > 0, 'should warn about out-of-range slot');
  assert.ok(warnings[0].includes('out of range'), 'warning mentions out of range');
});

// ─── Tests: empty-pass slot fallback (effectiveSlot != requestedSlot) ─────────

test('requestedSlot has no items → effectiveSlot falls back to lowest non-empty pass', async () => {
  setupProject('slot-fallback', { status: 'in-progress' });
  saveAndAccept('slot-fallback', { '1': [], '2': ['b', 'c'] }, 2);
  // After accept, next_pass should be 2 (lowest non-empty)
  const row = getLatestSuggestions('slot-fallback');
  const cursor = row.next_pass; // should be 2 from acceptSuggestions

  const { fs: mockFs } = makeMockFs();
  const { requestedSlot, effectiveSlot } = await resolveSuggestionSlot(
    'slot-fallback', '/fake/dir',
    { slotExplicit: false, slotParsed: null },
    { chalk: noopChalk, fs: mockFs }
  );

  // cursor reads next_pass=2 since pass 1 is empty (acceptSuggestions sets it to lowest non-empty)
  assert.equal(requestedSlot, cursor);
  assert.equal(effectiveSlot, cursor);
});

// ─── Tests: archive paths use projDir correctly ──────────────────────────────

test('archived filenames are inside .guide/ dir of projDir', async () => {
  setupProject('slot-path', { status: 'ready-for-qa' });
  saveAndAccept('slot-path', { '1': ['a'], '2': ['b'] }, 2);

  const projDir = path.join('/projects', 'slot-path');

  const { pendingAdvance } = await resolveSuggestionSlot(
    'slot-path', projDir,
    { slotExplicit: false, slotParsed: null, advance: true },
    { chalk: noopChalk, fs: noCopyFs().fs }
  );

  const { fs: mockFs, calls } = makeMockFs();
  await commitAdvance('slot-path', pendingAdvance, { chalk: noopChalk, fs: mockFs, setSuggestionNextPass });

  const guideDir = path.join(projDir, '.guide');
  for (const { src, dst } of calls.copyFile) {
    assert.ok(src.startsWith(guideDir), `src ${src} should be under .guide/`);
    assert.ok(dst.startsWith(guideDir), `dst ${dst} should be under .guide/`);
  }
});

// ─── Tests: advance gate ─────────────────────────────────────────────────────

test('2x plan, status ready-for-qa, no --advance flag → no archive, cursor unchanged', async () => {
  // Reproduces the bug: human re-runs `go` after pass 1 completes.
  setupProject('slot-no-advance', { status: 'ready-for-qa' });
  saveAndAccept('slot-no-advance', { '1': ['a', 'b'], '2': ['c'] }, 2);
  assert.equal(getLatestSuggestions('slot-no-advance').next_pass, 1);

  const { fs: mockFs, calls } = makeMockFs();
  const { requestedSlot, effectiveSlot } = await resolveSuggestionSlot(
    'slot-no-advance', '/fake/dir',
    { slotExplicit: false, slotParsed: null },        // advance defaults to false
    { chalk: noopChalk, fs: mockFs }
  );

  assert.equal(calls.copyFile.length, 0, 'plan.json must NOT be archived without --advance');
  assert.equal(calls.unlink.length,   0, 'plan.json must NOT be unlinked without --advance');
  assert.equal(getLatestSuggestions('slot-no-advance').next_pass, 1, 'cursor must not advance without --advance');
  assert.equal(requestedSlot, 1);
  assert.equal(effectiveSlot, 1);
});

test('2x plan, status ready-for-qa, advance: true → resolver defers all mutations; commitAdvance executes them', async () => {
  setupProject('slot-explicit-advance', { status: 'ready-for-qa' });
  saveAndAccept('slot-explicit-advance', { '1': ['a', 'b'], '2': ['c'] }, 2);

  const { requestedSlot, effectiveSlot, pendingAdvance } = await resolveSuggestionSlot(
    'slot-explicit-advance', '/fake/dir',
    { slotExplicit: false, slotParsed: null, advance: true },
    { chalk: noopChalk, fs: noCopyFs().fs }
  );

  assert.equal(requestedSlot, 2, 'should report advance to Pass 2');
  assert.equal(effectiveSlot, 2);
  assert.ok(pendingAdvance !== null, 'pendingAdvance set');
  assert.equal(getLatestSuggestions('slot-explicit-advance').next_pass, 1, 'cursor unchanged before commit');

  const { fs: mockFs, calls } = makeMockFs();
  await commitAdvance('slot-explicit-advance', pendingAdvance, { chalk: noopChalk, fs: mockFs, setSuggestionNextPass });

  assert.equal(calls.copyFile.length, 2, 'plan.json and plan.md should be archived');
  assert.equal(calls.unlink.length,   2, 'plan.json and plan.md should be unlinked');
  assert.equal(getLatestSuggestions('slot-explicit-advance').next_pass, 2, 'cursor persisted to 2');
});

test('commitAdvance: log message emitted before copyFile is called', async () => {
  setupProject('slot-log-order', { status: 'ready-for-qa' });
  saveAndAccept('slot-log-order', { '1': ['a'], '2': ['b'] }, 2);

  const { pendingAdvance } = await resolveSuggestionSlot(
    'slot-log-order', '/fake/dir',
    { slotExplicit: false, slotParsed: null, advance: true },
    { chalk: noopChalk, fs: noCopyFs().fs }
  );

  assert.ok(pendingAdvance !== null, 'pendingAdvance should be non-null');

  const events = [];
  const logChalk = {
    dim:    (s) => { events.push({ type: 'log', msg: s }); return s; },
    yellow: (s) => s,
  };
  const orderedFs = {
    copyFile: async () => { events.push({ type: 'copyFile' }); },
    unlink:   async () => { events.push({ type: 'unlink'   }); },
  };

  await commitAdvance('slot-log-order', pendingAdvance, { chalk: logChalk, fs: orderedFs, setSuggestionNextPass });

  const logIdx  = events.findIndex(e => e.type === 'log');
  const copyIdx = events.findIndex(e => e.type === 'copyFile');
  assert.ok(logIdx  >= 0, 'log event should be emitted');
  assert.ok(copyIdx >= 0, 'copyFile event should be emitted');
  assert.ok(logIdx < copyIdx, `log (idx ${logIdx}) must come before copyFile (idx ${copyIdx})`);
});

// ─── Regression: abort-no-mutation (resolver pure, no side-effects) ──────────

test('regression: resolver with advance:true makes no filesystem mutations (abort-no-mutation)', async () => {
  setupProject('slot-regression-abort', { status: 'ready-for-qa' });
  saveAndAccept('slot-regression-abort', { '1': ['a', 'b'], '2': ['c'] }, 2);

  // noCopyFs throws on any copyFile/unlink call — resolver must not trigger it
  const { pendingAdvance } = await resolveSuggestionSlot(
    'slot-regression-abort', '/fake/slot-regression-abort',
    { slotExplicit: false, slotParsed: null, advance: true },
    { chalk: noopChalk, fs: noCopyFs().fs }
  );

  assert.ok(pendingAdvance !== null, 'pendingAdvance should be set');
  assert.deepEqual(Object.keys(pendingAdvance).sort(), ['cursor', 'guideDir', 'next']);
  assert.equal(getLatestSuggestions('slot-regression-abort').next_pass, 1, 'cursor unchanged by resolver');
});

test('regression: commitAdvance performs archive exactly twice and persists cursor once (commit-advances-once)', async () => {
  setupProject('slot-regression-commit', { status: 'ready-for-qa' });
  saveAndAccept('slot-regression-commit', { '1': ['a'], '2': ['b', 'c'] }, 2);

  const { pendingAdvance } = await resolveSuggestionSlot(
    'slot-regression-commit', '/fake/slot-regression-commit',
    { slotExplicit: false, slotParsed: null, advance: true },
    { chalk: noopChalk, fs: noCopyFs().fs }
  );

  const { fs: mockFs, calls } = makeMockFs();
  await commitAdvance('slot-regression-commit', pendingAdvance, { chalk: noopChalk, fs: mockFs, setSuggestionNextPass });

  assert.equal(calls.copyFile.length, 2, 'exactly 2 archive copies (plan.json + plan.md)');
  assert.equal(calls.unlink.length, 2, 'exactly 2 unlinks');
  assert.equal(getLatestSuggestions('slot-regression-commit').next_pass, 2, 'cursor advanced to 2');
});

// ─── Tests: NaN slot defence-in-depth ────────────────────────────────────────

// ─── Regression: --advance + gate-replaces-plan (planReplaced guard) ──────────

test('regression (old bug): --advance + [R]e-suggest with stale commitAdvance corrupts next_pass', async () => {
  setupProject('slot-reg-resuggest-old', { status: 'ready-for-qa' });
  saveAndAccept('slot-reg-resuggest-old', { '1': ['a', 'b'], '2': ['c'] }, 2);
  assert.equal(getLatestSuggestions('slot-reg-resuggest-old').next_pass, 1);

  const projDir = path.join('/fake', 'slot-reg-resuggest-old');

  // Step 1: resolver returns pendingAdvance with next=2
  const { pendingAdvance } = await resolveSuggestionSlot(
    'slot-reg-resuggest-old', projDir,
    { slotExplicit: false, slotParsed: null, advance: true },
    { chalk: noopChalk, fs: noCopyFs().fs },
  );
  assert.ok(pendingAdvance !== null, 'pendingAdvance should be non-null');
  assert.equal(pendingAdvance.next, 2, 'stale descriptor points to Pass 2');

  // Step 2: simulate [R]e-suggest — stale old plan, accept a fresh 2-pass plan (no nextPass → starts at 1)
  staleAllSuggestions('slot-reg-resuggest-old');
  const freshId = saveSuggestions('slot-reg-resuggest-old', {
    projectType:  'cli',
    scanSnapshot: { projectType: 'cli' },
    suggestions:  [{ id: 'x', title: 'X' }, { id: 'y', title: 'Y' }],
  });
  acceptSuggestions(freshId, {
    selected:       [{ id: 'x' }, { id: 'y' }],
    pipelinePlan:   { '1': ['x'], '2': ['y'] },
    pipelinePasses: 2,
    // no nextPass → new row gets next_pass = lowestPass = 1
  });
  assert.equal(getLatestSuggestions('slot-reg-resuggest-old').next_pass, 1, 'new plan starts at Pass 1');

  // Step 3: calling commitAdvance with the stale descriptor overwrites cursor to 2 (demonstrates old bug)
  const { fs: mockFs } = makeMockFs();
  await commitAdvance('slot-reg-resuggest-old', pendingAdvance, { chalk: noopChalk, fs: mockFs, setSuggestionNextPass });
  assert.equal(
    getLatestSuggestions('slot-reg-resuggest-old').next_pass, 2,
    'old bug confirmed: stale commitAdvance overwrites new plan cursor to 2, skipping Pass 1',
  );
});

test('regression (fix): --advance + [R]e-suggest with planReplaced=true skips commitAdvance, cursor stays at 1', async () => {
  setupProject('slot-reg-resuggest-fix', { status: 'ready-for-qa' });
  saveAndAccept('slot-reg-resuggest-fix', { '1': ['a', 'b'], '2': ['c'] }, 2);

  const projDir = path.join('/fake', 'slot-reg-resuggest-fix');

  // Step 1: resolver returns pendingAdvance with next=2
  const { pendingAdvance } = await resolveSuggestionSlot(
    'slot-reg-resuggest-fix', projDir,
    { slotExplicit: false, slotParsed: null, advance: true },
    { chalk: noopChalk, fs: noCopyFs().fs },
  );
  assert.ok(pendingAdvance !== null, 'pendingAdvance set');
  assert.equal(pendingAdvance.next, 2);

  // Step 2: simulate [R]e-suggest → fresh 2-pass plan, cursor=1
  staleAllSuggestions('slot-reg-resuggest-fix');
  const freshId = saveSuggestions('slot-reg-resuggest-fix', {
    projectType:  'cli',
    scanSnapshot: { projectType: 'cli' },
    suggestions:  [{ id: 'p', title: 'P' }, { id: 'q', title: 'Q' }],
  });
  acceptSuggestions(freshId, {
    selected:       [{ id: 'p' }, { id: 'q' }],
    pipelinePlan:   { '1': ['p'], '2': ['q'] },
    pipelinePasses: 2,
  });
  assert.equal(getLatestSuggestions('slot-reg-resuggest-fix').next_pass, 1, 'new plan starts at Pass 1');

  // Step 3: with fix, planReplaced=true means the caller skips commitAdvance entirely
  // (no commitAdvance call — simulates `if (pendingAdvance && !planReplaced)` guard)
  assert.equal(
    getLatestSuggestions('slot-reg-resuggest-fix').next_pass, 1,
    'fix: cursor remains at 1 because commitAdvance is skipped when planReplaced=true',
  );
});

test('NaN requestedSlot (slotExplicit: true, slotParsed: NaN) → warns out-of-range, effectiveSlot is NaN, no archive', async () => {
  setupProject('slot-nan', { status: 'in-progress' });
  saveAndAccept('slot-nan', { '1': ['a', 'b'], '2': ['c'] }, 2);

  const warnings = [];
  const warnChalk = { dim: (s) => s, yellow: (s) => { warnings.push(s); return s; } };
  const { fs: mockFs } = noCopyFs();

  const { requestedSlot, effectiveSlot } = await resolveSuggestionSlot(
    'slot-nan', '/fake/dir',
    { slotExplicit: true, slotParsed: NaN },
    { chalk: warnChalk, fs: mockFs }
  );

  assert.ok(Number.isNaN(requestedSlot), 'requestedSlot should be NaN');
  assert.ok(Number.isNaN(effectiveSlot), 'effectiveSlot should be NaN (not overridden to a different pass)');
  assert.ok(warnings.length > 0, 'should emit a warning');
  assert.ok(warnings.some(w => w.includes('out of range')), 'warning should mention out of range');
});
