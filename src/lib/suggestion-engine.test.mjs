import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSuggestions, resolveInjectionSlot, filterSuggestions, nextNonEmptyPass } from './suggestion-engine.js';

// CLI-only rule ids
const CLI_ONLY = ['cli-config-file', 'cli-plugin-system', 'cli-shell-completion', 'cli-progress-output', 'cli-dry-run'];
// Frontend-only rule ids
const FE_ONLY = ['fe-mobile-responsive', 'fe-loading-skeletons', 'fe-dark-mode', 'fe-empty-states',
  'fe-form-validation', 'fe-optimistic-updates', 'fe-pagination', 'fe-search-debounce'];
// API-only rule ids (sse-realtime is in api+fullstack only)
const API_ONLY = ['api-input-validation', 'api-rate-limiting', 'api-structured-logging',
  'api-health-endpoint', 'api-pagination-cursor', 'api-request-tracing'];

function makeSnapshot(overrides = {}) {
  return {
    projectType: 'cli',
    name: 'test-project',
    description: null,
    dependencies: [],
    scripts: [],
    hasBin: false,
    readmeExcerpt: null,
    srcStructure: { dirs: [], fileCount: 0 },
    completedPhases: 0,
    phaseTitles: [],
    handoffExcerpt: null,
    rawThoughtsExcerpt: null,
    scannedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// Test 1: CLI snapshot — only CLI + applicable all-type rules; NO frontend/api rules
test('cli snapshot returns only CLI + applicable all-type rules', () => {
  const snapshot = makeSnapshot({ projectType: 'cli' });
  const results = generateSuggestions(snapshot);
  const ids = results.map(r => r.id);

  // Should have CLI-only rules
  for (const id of CLI_ONLY) {
    assert.ok(ids.includes(id), `Expected CLI rule ${id} to be present`);
  }
  // Should NOT have frontend-only rules
  for (const id of FE_ONLY) {
    assert.ok(!ids.includes(id), `CLI snapshot should not include frontend rule ${id}`);
  }
  // Should NOT have api-only rules
  for (const id of API_ONLY) {
    assert.ok(!ids.includes(id), `CLI snapshot should not include api rule ${id}`);
  }
});

// Test 2: Frontend snapshot — only frontend + applicable all-type rules; NO cli/api rules
test('frontend snapshot returns only frontend + applicable all-type rules', () => {
  const snapshot = makeSnapshot({ projectType: 'frontend' });
  const results = generateSuggestions(snapshot);
  const ids = results.map(r => r.id);

  for (const id of FE_ONLY) {
    assert.ok(ids.includes(id), `Expected frontend rule ${id} to be present`);
  }
  for (const id of CLI_ONLY) {
    assert.ok(!ids.includes(id), `Frontend snapshot should not include CLI rule ${id}`);
  }
  for (const id of API_ONLY) {
    assert.ok(!ids.includes(id), `Frontend snapshot should not include api rule ${id}`);
  }
});

// Test 3: API snapshot — only api + applicable all-type rules; NO cli/frontend rules
test('api snapshot returns only api + applicable all-type rules', () => {
  const snapshot = makeSnapshot({ projectType: 'api' });
  const results = generateSuggestions(snapshot);
  const ids = results.map(r => r.id);

  for (const id of API_ONLY) {
    assert.ok(ids.includes(id), `Expected api rule ${id} to be present`);
  }
  for (const id of CLI_ONLY) {
    assert.ok(!ids.includes(id), `API snapshot should not include CLI rule ${id}`);
  }
  for (const id of FE_ONLY) {
    assert.ok(!ids.includes(id), `API snapshot should not include frontend rule ${id}`);
  }
});

// Test 4: Fullstack snapshot — gets BOTH frontend rules AND api rules
test('fullstack snapshot gets both frontend and api rules', () => {
  const snapshot = makeSnapshot({ projectType: 'fullstack' });
  const results = generateSuggestions(snapshot);
  const ids = results.map(r => r.id);

  assert.ok(ids.includes('fe-pagination'), 'fullstack should include fe-pagination');
  assert.ok(ids.includes('api-health-endpoint'), 'fullstack should include api-health-endpoint');
  // No CLI-only rules
  for (const id of CLI_ONLY) {
    assert.ok(!ids.includes(id), `Fullstack snapshot should not include CLI rule ${id}`);
  }
});

// Test 5: Unknown snapshot — only all-type rules (no cli/frontend/api-specific rules)
test('unknown snapshot returns only all-type rules', () => {
  const snapshot = makeSnapshot({ projectType: 'unknown' });
  const results = generateSuggestions(snapshot);
  const ids = results.map(r => r.id);

  for (const id of CLI_ONLY) {
    assert.ok(!ids.includes(id), `Unknown snapshot should not include CLI rule ${id}`);
  }
  for (const id of FE_ONLY) {
    assert.ok(!ids.includes(id), `Unknown snapshot should not include frontend rule ${id}`);
  }
  for (const id of API_ONLY) {
    assert.ok(!ids.includes(id), `Unknown snapshot should not include api rule ${id}`);
  }
  // sse-realtime is api+fullstack only, not unknown
  assert.ok(!ids.includes('sse-realtime'), 'Unknown snapshot should not include sse-realtime');
});

// Test 6: auth-oauth gate — snapshot with 'next-auth' in deps; assert auth-oauth is absent
test('auth-oauth absent when next-auth is in dependencies', () => {
  const snapshot = makeSnapshot({ projectType: 'frontend', dependencies: ['next-auth'] });
  const results = generateSuggestions(snapshot);
  const ids = results.map(r => r.id);
  assert.ok(!ids.includes('auth-oauth'), 'auth-oauth should be suppressed when next-auth is present');
});

// Test 7: test-coverage gate — snapshot with 'vitest' in deps; assert test-coverage is absent
test('test-coverage absent when vitest is in dependencies', () => {
  const snapshot = makeSnapshot({ projectType: 'cli', dependencies: ['vitest'] });
  const results = generateSuggestions(snapshot);
  const ids = results.map(r => r.id);
  assert.ok(!ids.includes('test-coverage'), 'test-coverage should be suppressed when vitest is present');
});

// Test 8: telegram-bot-integration gate — snapshot with 'grammy' in deps
test('telegram-bot-integration absent when grammy is in dependencies', () => {
  const snapshot = makeSnapshot({ projectType: 'cli', dependencies: ['grammy'] });
  const results = generateSuggestions(snapshot);
  const ids = results.map(r => r.id);
  assert.ok(!ids.includes('telegram-bot-integration'), 'telegram-bot-integration should be suppressed when grammy is present');
});

// Test 9: export-csv-pdf gate — completedPhases=2 absent; completedPhases=5 present
test('export-csv-pdf respects completedPhases gate', () => {
  const snapshotLow = makeSnapshot({ projectType: 'cli', completedPhases: 2 });
  const resultsLow = generateSuggestions(snapshotLow);
  assert.ok(!resultsLow.map(r => r.id).includes('export-csv-pdf'), 'export-csv-pdf absent when completedPhases=2');

  const snapshotHigh = makeSnapshot({ projectType: 'cli', completedPhases: 5 });
  const resultsHigh = generateSuggestions(snapshotHigh);
  assert.ok(resultsHigh.map(r => r.id).includes('export-csv-pdf'), 'export-csv-pdf present when completedPhases=5');
});

// Test 10: sse-realtime project-type gate — cli absent, api present
test('sse-realtime absent from cli, present in api', () => {
  const cliResults = generateSuggestions(makeSnapshot({ projectType: 'cli' }));
  assert.ok(!cliResults.map(r => r.id).includes('sse-realtime'), 'sse-realtime should be absent from cli snapshot');

  const apiResults = generateSuggestions(makeSnapshot({ projectType: 'api' }));
  assert.ok(apiResults.map(r => r.id).includes('sse-realtime'), 'sse-realtime should be present in api snapshot');
});

// Test 11: keyword de-dup — completedPhases=3, phaseTitles=['add dark mode toggle']; fe-dark-mode absent
test('keyword dedup suppresses fe-dark-mode when phase title matches', () => {
  const snapshot = makeSnapshot({
    projectType: 'frontend',
    completedPhases: 3,
    phaseTitles: ['add dark mode toggle'],
  });
  const results = generateSuggestions(snapshot);
  assert.ok(!results.map(r => r.id).includes('fe-dark-mode'), 'fe-dark-mode should be deduped when phase title contains "dark mode"');
});

// Test 12: de-dup not applied when completedPhases=0
test('keyword dedup does not fire when completedPhases=0', () => {
  const snapshot = makeSnapshot({
    projectType: 'frontend',
    completedPhases: 0,
    phaseTitles: ['add dark mode toggle'],
  });
  const results = generateSuggestions(snapshot);
  assert.ok(results.map(r => r.id).includes('fe-dark-mode'), 'fe-dark-mode should be present when completedPhases=0');
});

// Test 13: determinism — two calls produce identical arrays
test('generateSuggestions is deterministic', () => {
  const snapshot = makeSnapshot({ projectType: 'fullstack', completedPhases: 1, phaseTitles: ['initial setup'] });
  const results1 = generateSuggestions(snapshot);
  const results2 = generateSuggestions(snapshot);
  assert.deepEqual(results1.map(r => r.id), results2.map(r => r.id), 'Output ids must match on repeated calls');
  assert.deepEqual(results1, results2, 'Full output must match on repeated calls');
});

// Test 14: every returned Suggestion has all required fields with valid enum values
test('every returned Suggestion has all required fields with valid enum values', () => {
  const VALID_TYPES = new Set(['new-feature', 'enhancement', 'ui-improvement', 'perf', 'security', 'dx']);
  const VALID_CATEGORIES = new Set(['logic', 'frontend', 'infra', 'security', 'dx', 'both']);
  const VALID_EFFORTS = new Set(['small', 'medium', 'large']);
  const VALID_IMPACTS = new Set(['low', 'medium', 'high']);
  const VALID_SLOTS = new Set([1, 2, 3]);

  for (const projectType of ['cli', 'frontend', 'api', 'fullstack', 'unknown']) {
    const results = generateSuggestions(makeSnapshot({ projectType, completedPhases: 5 }));
    for (const s of results) {
      assert.ok(typeof s.id === 'string' && s.id.length > 0, `id must be non-empty string, got: ${s.id}`);
      assert.ok(VALID_TYPES.has(s.type), `type '${s.type}' invalid for ${s.id}`);
      assert.ok(VALID_CATEGORIES.has(s.category), `category '${s.category}' invalid for ${s.id}`);
      assert.ok(typeof s.title === 'string' && s.title.length <= 60, `title too long or missing for ${s.id}: "${s.title}"`);
      assert.ok(typeof s.description === 'string' && s.description.length > 0, `description missing for ${s.id}`);
      assert.ok(VALID_EFFORTS.has(s.effort), `effort '${s.effort}' invalid for ${s.id}`);
      assert.ok(VALID_IMPACTS.has(s.impact), `impact '${s.impact}' invalid for ${s.id}`);
      assert.ok(VALID_SLOTS.has(s.suggestedSlot), `suggestedSlot '${s.suggestedSlot}' invalid for ${s.id}`);
      assert.ok(Array.isArray(s.appliesTo) && s.appliesTo.length > 0, `appliesTo must be non-empty array for ${s.id}`);
    }
  }
});

// Test 15 (updated): ci-pipeline present when snapshot has no rootDirs (no .github assumed)
test('ci-pipeline present when snapshot has no rootDirs (no .github assumed)', () => {
  const snapshot = makeSnapshot({ scripts: ['build', 'test'] });  // no rootDirs → undefined
  const results = generateSuggestions(snapshot);
  assert.ok(
    results.map(r => r.id).includes('ci-pipeline'),
    'ci-pipeline should fire when rootDirs is absent (conservative default)',
  );
});

// Test 16 (replacement): ci-pipeline suppressed when .github/ present in rootDirs
test('ci-pipeline suppressed when rootDirs includes ".github"', () => {
  const snapshot = makeSnapshot({ rootDirs: ['.github'] });
  const results = generateSuggestions(snapshot);
  assert.ok(
    !results.map(r => r.id).includes('ci-pipeline'),
    'ci-pipeline should be suppressed when .github/ exists',
  );
});

// Test 17 (replacement): ci-pipeline fires when rootDirs is present but has no .github
test('ci-pipeline fires when rootDirs is non-empty but has no ".github"', () => {
  const snapshot = makeSnapshot({ rootDirs: ['src', 'docs'] });
  const results = generateSuggestions(snapshot);
  assert.ok(
    results.map(r => r.id).includes('ci-pipeline'),
    'ci-pipeline should fire when no .github/ directory exists',
  );
});

// ─── Bug r26-2: resolveInjectionSlot ─────────────────────────────────────────

test('resolveInjectionSlot — requested slot has items → returns it unchanged', () => {
  const plan = { '1': ['id-a'], '2': ['id-b'] };
  assert.equal(resolveInjectionSlot(plan, 1, 2), 1);
  assert.equal(resolveInjectionSlot(plan, 2, 2), 2);
});

test('resolveInjectionSlot — requested slot empty → returns lowest non-empty pass', () => {
  const plan = { '1': [], '2': ['id-b'] };
  assert.equal(resolveInjectionSlot(plan, 1, 2), 2);
});

test('resolveInjectionSlot — only pass 3 has items → returns 3', () => {
  const plan = { '1': [], '2': [], '3': ['id-c'] };
  assert.equal(resolveInjectionSlot(plan, 1, 3), 3);
});

test('resolveInjectionSlot — all passes empty → returns requestedSlot unchanged', () => {
  const plan = { '1': [], '2': [], '3': [] };
  assert.equal(resolveInjectionSlot(plan, 1, 3), 1);
});

test('resolveInjectionSlot — explicit slot 2 that has items stays at 2', () => {
  const plan = { '1': ['id-a'], '2': ['id-b'], '3': [] };
  assert.equal(resolveInjectionSlot(plan, 2, 3), 2);
});

// ─── Bug r26-3: filterSuggestions ────────────────────────────────────────────

test('filterSuggestions — matching category is kept', () => {
  const suggestions = [
    { id: 'a', category: 'security' },
    { id: 'b', category: 'dx' },
    { id: 'c', category: 'frontend' },
  ];
  const result = filterSuggestions(suggestions, ['security']);
  const ids = result.map(s => s.id);
  assert.ok(ids.includes('a'), 'security item should be kept');
  assert.ok(!ids.includes('b'), 'dx item should be excluded');
  assert.ok(!ids.includes('c'), 'frontend item should be excluded');
});

test('filterSuggestions — category "both" is always kept', () => {
  const suggestions = [
    { id: 'x', category: 'both' },
    { id: 'y', category: 'infra' },
  ];
  const result = filterSuggestions(suggestions, ['security']);
  const ids = result.map(s => s.id);
  assert.ok(ids.includes('x'), '"both" category should always be retained');
  assert.ok(!ids.includes('y'), 'infra item should be excluded');
});

test('filterSuggestions — empty categories returns all items', () => {
  const suggestions = [
    { id: 'p', category: 'logic' },
    { id: 'q', category: 'frontend' },
    { id: 'r', category: 'both' },
  ];
  const result = filterSuggestions(suggestions, []);
  assert.equal(result.length, suggestions.length, 'empty filter should return all items');
});

test('filterSuggestions — multiple categories: items from any selected category kept', () => {
  const suggestions = [
    { id: '1', category: 'security' },
    { id: '2', category: 'dx' },
    { id: '3', category: 'logic' },
    { id: '4', category: 'both' },
  ];
  const result = filterSuggestions(suggestions, ['security', 'dx']);
  const ids = result.map(s => s.id);
  assert.ok(ids.includes('1'), 'security kept');
  assert.ok(ids.includes('2'), 'dx kept');
  assert.ok(!ids.includes('3'), 'logic excluded');
  assert.ok(ids.includes('4'), '"both" kept');
});

// ─── Bug r27-1: nextNonEmptyPass ─────────────────────────────────────────────

test('nextNonEmptyPass — returns next non-empty pass', () => {
  const plan = { '1': ['a'], '2': ['b'] };
  assert.equal(nextNonEmptyPass(plan, 1, 2), 2);
});

test('nextNonEmptyPass — skips empty pass and returns next non-empty', () => {
  const plan = { '1': ['a'], '2': [], '3': ['c'] };
  assert.equal(nextNonEmptyPass(plan, 1, 3), 3);
});

test('nextNonEmptyPass — already at last pass returns null', () => {
  const plan = { '1': ['a'], '2': ['b'] };
  assert.equal(nextNonEmptyPass(plan, 2, 2), null);
});

test('nextNonEmptyPass — no items anywhere returns null', () => {
  const plan = { '1': [], '2': [] };
  assert.equal(nextNonEmptyPass(plan, 1, 2), null);
});
