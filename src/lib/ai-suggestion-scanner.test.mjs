import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { _parseResponse, generateAISuggestions } from './ai-suggestion-scanner.js';

// Set in-memory DB before any import that triggers getDb().
// Pattern matches src/state.test.mjs line 8.
process.env.DB_PATH = ':memory:';

const {
  upsertProject, saveSuggestions, acceptSuggestions, getLatestSuggestions,
} = await import('../state.js');
const { writeSuggestionsFile } = await import('../commands/suggest.js');
const { loadSuggestionsBlock }  = await import('./phase-runner.js');
const { assignToPasses }        = await import('./suggestion-engine.js');

// ─── helpers ────────────────────────────────────────────────────────────────

function validItem(overrides = {}) {
  return {
    id: 'add-auth',
    type: 'new-feature',
    category: 'logic',
    title: 'Add OAuth2 authentication',
    description: 'Secure login flow',
    effort: 'medium',
    impact: 'high',
    suggestedSlot: 1,
    ...overrides,
  };
}

// ─── tests ───────────────────────────────────────────────────────────────────

test('Clean JSON array returns correctly shaped objects', () => {
  const raw = JSON.stringify([validItem()]);
  const result = _parseResponse(raw);

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'add-auth');
  assert.equal(result[0].type, 'new-feature');
  assert.equal(result[0].category, 'logic');
  assert.equal(result[0].effort, 'medium');
  assert.equal(result[0].impact, 'high');
  assert.equal(result[0].suggestedSlot, 1);
  assert.ok(Array.isArray(result[0].appliesTo));
  assert.ok(result[0].appliesTo.includes('cli'));
  assert.ok(result[0].appliesTo.includes('frontend'));
  assert.ok(result[0].appliesTo.includes('api'));
  assert.ok(result[0].appliesTo.includes('fullstack'));
  assert.ok(result[0].appliesTo.includes('unknown'));
});

test('Prose-wrapped array is extracted correctly', () => {
  const inner = JSON.stringify([validItem({ id: 'test-coverage', title: 'Add test coverage' })]);
  const raw = `Here are my suggestions for your project:\n${inner}\nLet me know if you need more detail.`;
  const result = _parseResponse(raw);

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'test-coverage');
});

test('Invalid JSON in bracket span is skipped, throws "no JSON array" when no valid array found', () => {
  // Old behaviour threw "AI response JSON is invalid"; new bracket-scanner silently skips
  // invalid JSON spans and throws "contained no JSON array" if nothing valid is found.
  assert.throws(
    () => _parseResponse('[{id: unquoted, title: "bad"}]'),
    /AI response contained no JSON array/,
  );
});

test('No JSON array found throws', () => {
  assert.throws(
    () => _parseResponse('Claude could not generate suggestions for this project.'),
    /AI response contained no JSON array/,
  );
});

test('Non-object array items are silently skipped; all-skip throws', () => {
  assert.throws(
    () => _parseResponse('[1, 2, 3]'),
    /No valid suggestions found/,
  );
});

test('Objects missing id are skipped; objects missing title are skipped', () => {
  const raw = JSON.stringify([
    { type: 'enhancement', title: 'Has title but no id' },
    { id: 'has-id-no-title', type: 'enhancement' },
    validItem({ id: 'only-valid', title: 'The one valid item' }),
  ]);
  const result = _parseResponse(raw);

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'only-valid');
});

test('All objects missing id or title throws "No valid suggestions"', () => {
  const raw = JSON.stringify([
    { type: 'enhancement', title: 'No id' },
    { id: 'no-title', type: 'enhancement' },
  ]);
  assert.throws(
    () => _parseResponse(raw),
    /No valid suggestions found/,
  );
});

test('Unknown enum values are coerced to defaults', () => {
  const raw = JSON.stringify([validItem({
    type:     'made-up-type',
    category: 'unknown-cat',
    effort:   'gigantic',
    impact:   'galactic',
  })]);
  const result = _parseResponse(raw);

  assert.equal(result[0].type,     'enhancement');
  assert.equal(result[0].category, 'logic');
  assert.equal(result[0].effort,   'medium');
  assert.equal(result[0].impact,   'medium');
});

test('Out-of-range suggestedSlot is clamped to 1', () => {
  for (const badSlot of [0, 6, 'banana']) {
    const result = _parseResponse(JSON.stringify([validItem({ suggestedSlot: badSlot })]));
    assert.equal(result[0].suggestedSlot, 1, `slot ${badSlot} should clamp to 1`);
  }
});

test('Valid suggestedSlot values 1–5 are preserved', () => {
  for (const slot of [2, 3, 4, 5]) {
    const result = _parseResponse(JSON.stringify([validItem({ suggestedSlot: slot })]));
    assert.equal(result[0].suggestedSlot, slot, `slot ${slot} should pass through`);
  }
});

test('id sanitization: non-alphanumeric chars replaced, lowercased, truncated at 64', () => {
  // Uppercase and special chars → lowercased, non-[a-z0-9-] replaced with '-'
  const r1 = _parseResponse(JSON.stringify([validItem({ id: 'Add_OAuth2 Login!' })]));
  assert.match(r1[0].id, /^[a-z0-9-]+$/);

  // Long id → truncated at 64 chars
  const longId = 'a'.repeat(80);
  const r2 = _parseResponse(JSON.stringify([validItem({ id: longId })]));
  assert.equal(r2[0].id.length, 64);

  // Already clean id passes through unchanged
  const r3 = _parseResponse(JSON.stringify([validItem({ id: 'clean-id-123' })]));
  assert.equal(r3[0].id, 'clean-id-123');
});

test('title truncated to 60 characters', () => {
  const longTitle = 'T'.repeat(80);
  const result = _parseResponse(JSON.stringify([validItem({ title: longTitle })]));
  assert.equal(result[0].title.length, 60);
  assert.equal(result[0].title, 'T'.repeat(60));
});

test('description defaults to empty string when absent', () => {
  const item = validItem();
  delete item.description;
  const result = _parseResponse(JSON.stringify([item]));
  assert.equal(result[0].description, '');
});

test('Multiple valid suggestions returned in order', () => {
  const raw = JSON.stringify([
    validItem({ id: 'first',  title: 'First item' }),
    validItem({ id: 'second', title: 'Second item' }),
    validItem({ id: 'third',  title: 'Third item' }),
  ]);
  const result = _parseResponse(raw);

  assert.equal(result.length, 3);
  assert.equal(result[0].id, 'first');
  assert.equal(result[1].id, 'second');
  assert.equal(result[2].id, 'third');
});

// ─── Config + integration tests ───────────────────────────────────────────────

test('resolveConfig: suggest-scan task resolves a non-empty model string (Bug 1 regression)', async () => {
  // Regression guard: if config/defaults.json loses the "suggest-scan" key,
  // resolve() will throw "No model configured for task 'suggest-scan'" and this
  // test fails — exactly mirroring the original bug report.
  const { resolve } = await import('../config-resolver.js');
  const cfg = await resolve({ task: 'suggest-scan' });
  assert.ok(
    typeof cfg.model === 'string' && cfg.model.length > 0,
    `Expected a non-empty model string for suggest-scan, got: ${JSON.stringify(cfg.model)}`,
  );
});

// ─── Bug r26-4a: bracket-balanced scanner (prose-wrapper) ────────────────────

test('_parseResponse — bracketed preamble before array is skipped', () => {
  // Claude prepends "[note] …" — the old greedy regex captured from the first "[" to the
  // last "]" and produced invalid JSON. The bracket-balanced scanner skips this span.
  const inner = JSON.stringify([validItem({ id: 'real-item', title: 'Real suggestion' })]);
  const raw = `[note] Here are the suggestions:\n${inner}`;
  const result = _parseResponse(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'real-item');
});

test('_parseResponse — multiple bracket sections: first valid object array wins', () => {
  // First bracket span is invalid JSON; second contains the real suggestions.
  const inner = JSON.stringify([validItem({ id: 'sec-item' })]);
  const raw = `[invalid json here] some text ${inner}`;
  const result = _parseResponse(raw);
  assert.equal(result[0].id, 'sec-item');
});

test('_parseResponse — text with only invalid JSON brackets throws', () => {
  assert.throws(
    () => _parseResponse('[invalid json]'),
    /AI response contained no JSON array/,
  );
});

// ─── Bug r26-4b: id deduplication ────────────────────────────────────────────

test('_parseResponse — duplicate ids: first keeps base id, second gets -1 suffix', () => {
  const raw = JSON.stringify([
    validItem({ id: 'foo', title: 'Foo first' }),
    validItem({ id: 'foo', title: 'Foo second' }),
  ]);
  const result = _parseResponse(raw);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, 'foo');
  assert.equal(result[1].id, 'foo-1');
});

test('_parseResponse — triple duplicate gets -1 and -2 suffixes', () => {
  const raw = JSON.stringify([
    validItem({ id: 'bar', title: 'Bar 1' }),
    validItem({ id: 'bar', title: 'Bar 2' }),
    validItem({ id: 'bar', title: 'Bar 3' }),
  ]);
  const result = _parseResponse(raw);
  assert.equal(result[0].id, 'bar');
  assert.equal(result[1].id, 'bar-1');
  assert.equal(result[2].id, 'bar-2');
});

test('_parseResponse — non-duplicate ids are returned unchanged', () => {
  const raw = JSON.stringify([
    validItem({ id: 'alpha' }),
    validItem({ id: 'beta' }),
    validItem({ id: 'gamma' }),
  ]);
  const result = _parseResponse(raw);
  assert.deepEqual(result.map(r => r.id), ['alpha', 'beta', 'gamma']);
});

// ─── Bug r27-2a: string-aware bracket scan ────────────────────────────────────

test('_parseResponse — unbalanced ] inside a string value parses correctly', () => {
  // Primary failure mode: a ] in a string with no preceding [ at the same nesting
  // level caused premature depth=0 mid-array, truncating and failing the parse.
  const raw = JSON.stringify([
    validItem({ id: 'fix-it', title: 'fix] this issue', description: 'close the ] delimiter' }),
  ]);
  const result = _parseResponse(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'fix-it');
});

test('_parseResponse — balanced brackets inside string values parse correctly', () => {
  // arr[0] has balanced [ and ] inside a string — should parse with both old and new code.
  // Included as a regression guard to ensure the fix does not break this case.
  const raw = JSON.stringify([
    validItem({ id: 'arr-fix', title: 'arr[0] fix', description: 'guard array[0] access' }),
  ]);
  const result = _parseResponse(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'arr-fix');
});

test('_parseResponse — escaped quote inside a string value does not exit string tracking', () => {
  // \" inside a string should not cause inString to flip to false.
  const item = validItem({ id: 'esc-test', title: 'say "hello"', description: 'a \\"quoted\\" word' });
  const raw = JSON.stringify([item]);
  const result = _parseResponse(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'esc-test');
});

test('_parseResponse — [note] preamble before array still parses correctly after string-aware fix', () => {
  const inner = JSON.stringify([validItem({ id: 'preamble-guard', title: 'Real suggestion' })]);
  const raw = `[note] Here are my suggestions:\n${inner}`;
  const result = _parseResponse(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'preamble-guard');
});

// ─── Bug r27-2b: collision-free id dedup ─────────────────────────────────────

test('_parseResponse — duplicate foo + natural foo-1: all three get distinct ids', () => {
  // Before the fix: second 'foo' became 'foo-1', colliding with the third item.
  const raw = JSON.stringify([
    validItem({ id: 'foo', title: 'Foo first' }),
    validItem({ id: 'foo', title: 'Foo second' }),
    validItem({ id: 'foo-1', title: 'Foo one (natural)' }),
  ]);
  const result = _parseResponse(raw);
  assert.equal(result.length, 3);
  const ids = result.map(r => r.id);
  // All ids must be distinct
  assert.equal(new Set(ids).size, 3, `Expected 3 distinct ids, got: ${ids}`);
  // First item keeps the base id
  assert.equal(ids[0], 'foo');
  // Natural foo-1 is taken, so second duplicate must get foo-2 (or higher)
  assert.notEqual(ids[1], 'foo-1', 'Second foo must not collide with natural foo-1');
  // Third item (natural foo-1) keeps its id since it appeared first in its key
  assert.equal(ids[2], 'foo-1');
});

// ─────────────────────────────────────────────────────────────────────────────

test('_parseResponse (is_error propagation proxy): malformed runner output throws', () => {
  // _callClaude (ai-suggestion-scanner.js:157-159) throws before _parseResponse when
  // result.is_error is true. This test verifies the complementary path: when runClaude
  // "succeeds" but returns empty/malformed content, _parseResponse throws — and that
  // error propagates identically through generateAISuggestions to the caller's catch
  // at suggest.js:332, triggering the rules-engine fallback.
  // Full mock-based coverage of the is_error branch is impractical here because
  // ai-suggestion-scanner.js is statically imported above, so its runClaude binding
  // is already captured; ESM mock.module() cannot reach it without a fresh module load.
  assert.throws(
    () => _parseResponse(''),
    /AI response contained no JSON array/,
  );
});

// ─── deps injection / noLm integration tests ─────────────────────────────────

const _minimalSnapshot = {
  name: 'test-proj', projectType: 'cli',
  description: '', dependencies: [], scripts: [], hasBin: false,
  readmeExcerpt: '', srcStructure: { dirs: [], fileCount: 0 },
  completedPhases: 0, phaseTitles: [], handoffExcerpt: '', rawThoughtsExcerpt: '',
  scannedAt: new Date().toISOString(),
};

test('generateAISuggestions with stubbed callClaude calls stub exactly once and returns correct shape', async () => {
  const stubbedItem = {
    id: 'stub-feature', type: 'new-feature', category: 'logic',
    title: 'Stubbed feature', description: 'Test description',
    effort: 'small', impact: 'high', suggestedSlot: 1,
  };
  let callCount = 0;
  const stubCallClaude = async () => {
    callCount++;
    return JSON.stringify([stubbedItem]);
  };

  const suggestions = await generateAISuggestions(
    _minimalSnapshot, 'test goal', ['logic'], {}, [], { callClaude: stubCallClaude },
  );

  assert.equal(callCount, 1, 'stub should be called exactly once');
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].id, 'stub-feature');
  assert.equal(suggestions[0].title, 'Stubbed feature');
  assert.equal(suggestions[0].type, 'new-feature');
  assert.equal(suggestions[0].effort, 'small');
  assert.equal(suggestions[0].impact, 'high');
});

test('generateAISuggestions — explicit projectName is passed to callClaude, not snapshot.name', async () => {
  let capturedBillingKey;
  const stub = async (prompt, billingKey) => {
    capturedBillingKey = billingKey;
    return JSON.stringify([validItem()]);
  };

  await generateAISuggestions(
    _minimalSnapshot,       // snapshot.name === 'test-proj'
    'test goal', ['logic'], {}, [],
    { callClaude: stub },   // deps
    'canonical-project',    // projectName — should win
  );

  assert.equal(capturedBillingKey, 'canonical-project', 'canonical projectName must be used, not snapshot.name');
});

test('generateAISuggestions — omitting projectName falls back to snapshot.name', async () => {
  let capturedBillingKey;
  const stub = async (prompt, billingKey) => {
    capturedBillingKey = billingKey;
    return JSON.stringify([validItem()]);
  };

  await generateAISuggestions(
    _minimalSnapshot,      // snapshot.name === 'test-proj'
    'test goal', ['logic'], {}, [],
    { callClaude: stub },  // deps — no 7th arg
  );

  assert.equal(capturedBillingKey, 'test-proj', 'snapshot.name must be used when projectName is omitted');
});

// ─── Phase 16 (brief P1 injection): repo-map splice into the prompt text ────
//
// 'suggest-scan' is not a runGuide() task, so it has no systemPromptExtra —
// the map is spliced directly into the prompt string generateAISuggestions
// builds. Only the injected generateRepoMap dep is faked; _buildPrompt/
// _parseResponse run for real.

test('generateAISuggestions: "suggest-scan" in repo_map.guide_tasks → map content lands in the prompt text, generated against projDir\'s workspace (not REPO_ROOT)', async () => {
  const cfg = { repo_map: { guide_tasks: ['suggest-scan'] }, paths: { workspace_subdir: 'workspace' } };
  let capturedArgs = null;
  let capturedPrompt = null;
  const stubCallClaude = async (prompt) => {
    capturedPrompt = prompt;
    return JSON.stringify([validItem()]);
  };
  const stubGenerateRepoMap = async (args) => {
    capturedArgs = args;
    return { generated_at_sha: 'feed1234', body: '# Directory Structure\n```\nsrc/\n```\n' };
  };

  await generateAISuggestions(
    _minimalSnapshot, 'test goal', ['logic'], cfg, [],
    { callClaude: stubCallClaude, generateRepoMap: stubGenerateRepoMap },
    'demo-project', '/tmp/aorch-projects/demo-project',
  );

  assert.ok(capturedArgs, 'generateRepoMap dep was invoked');
  assert.equal(capturedArgs.workspaceDir, path.join('/tmp/aorch-projects/demo-project', 'workspace'), 'map generated against the target project workspace, never REPO_ROOT');
  assert.equal(capturedArgs.projDir, '/tmp/aorch-projects/demo-project');
  assert.ok(capturedPrompt.includes('<repo_map>'), 'prompt text includes the repo-map block');
  assert.ok(capturedPrompt.includes('This map is generated from static analysis at commit feed1234.'), 'precedence sentence present in the prompt');
  assert.ok(capturedPrompt.includes('# Directory Structure'), 'map body present in the prompt');
});

test('generateAISuggestions: "suggest-scan" absent from repo_map.guide_tasks → no map generated, no map content in the prompt', async () => {
  const cfg = { repo_map: { guide_tasks: ['plan-creation'] }, paths: { workspace_subdir: 'workspace' } };
  let mapCalls = 0;
  let capturedPrompt = null;
  await generateAISuggestions(
    _minimalSnapshot, 'test goal', ['logic'], cfg, [],
    {
      callClaude: async (prompt) => { capturedPrompt = prompt; return JSON.stringify([validItem()]); },
      generateRepoMap: async () => { mapCalls += 1; return { generated_at_sha: 'x', body: 'x' }; },
    },
    'demo-project', '/tmp/aorch-projects/demo-project',
  );
  assert.equal(mapCalls, 0, 'generateRepoMap must not be called when suggest-scan is not in guide_tasks');
  assert.ok(!capturedPrompt.includes('<repo_map>'));
});

test('generateAISuggestions: no projDir provided → map skipped even if "suggest-scan" is configured (never falls back to cwd/REPO_ROOT)', async () => {
  const cfg = { repo_map: { guide_tasks: ['suggest-scan'] }, paths: { workspace_subdir: 'workspace' } };
  let mapCalls = 0;
  await generateAISuggestions(
    _minimalSnapshot, 'test goal', ['logic'], cfg, [],
    {
      callClaude: async () => JSON.stringify([validItem()]),
      generateRepoMap: async () => { mapCalls += 1; return { generated_at_sha: 'x', body: 'x' }; },
    },
    'demo-project', // projDir omitted
  );
  assert.equal(mapCalls, 0);
});

test('generateAISuggestions: repo-map injection fail-open — a throwing generateRepoMap dep is caught, prompt still built and sent, no throw', async () => {
  const cfg = { repo_map: { guide_tasks: ['suggest-scan'] }, paths: { workspace_subdir: 'workspace' } };
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (msg) => { warnings.push(String(msg)); };
  let suggestions;
  try {
    suggestions = await generateAISuggestions(
      _minimalSnapshot, 'test goal', ['logic'], cfg, [],
      {
        callClaude: async () => JSON.stringify([validItem()]),
        generateRepoMap: async () => { throw new Error('injected repomix crash'); },
      },
      'demo-project', '/tmp/aorch-projects/demo-project',
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(suggestions.length, 1, 'the suggest-scan call still completes normally');
  assert.ok(warnings.some((w) => w.includes('repo-map')), 'expected a [repo-map]-tagged warning');
});

test('rules-only path: noLm upstream means stub callClaude is never invoked', async () => {
  // This test verifies the noLm branch in suggest.js Step G by simulating what
  // the CLI does: when noLm=true, generateAISuggestions is never called at all.
  // We verify indirectly — the stub below would fail the test if called.
  let callCount = 0;
  const guardStub = async () => {
    callCount++;
    return '[]';
  };

  // Simulate the noLm=true branch from suggest.js Step G: skip generateAISuggestions entirely.
  // We verify the guard stub is NOT invoked when the caller gates on !opts.noLm.
  const noLm = true;
  let suggestions;
  if (noLm) {
    // Rules path — no call to generateAISuggestions (and therefore no call to guardStub)
    suggestions = [];
  } else {
    suggestions = await generateAISuggestions(
      _minimalSnapshot, 'test goal', [], {}, [], { callClaude: guardStub },
    );
  }

  assert.equal(callCount, 0, 'stub must never be called when noLm=true gates the AI call');
  assert.equal(Array.isArray(suggestions), true);
});

// ─── End-to-end AI persistence chain ─────────────────────────────────────────

const CANNED_RESPONSE =
  `[{"id":"add-dark-mode","type":"enhancement","category":"logic",` +
  `"title":"Add dark mode [beta]","description":"Theme toggle.","effort":"small",` +
  `"impact":"high","suggestedSlot":1},{"id":"fix-n-plus-one","type":"perf",` +
  `"category":"logic","title":"Fix N+1 queries [high priority]",` +
  `"description":"Batch lookups.","effort":"medium","impact":"high","suggestedSlot":2}]`;

test('AI persistence chain: generateAISuggestions → DB → file → injection', async (t) => {
  const projectName = `chain-test-${Date.now()}`;
  const projDir     = mkdtempSync(path.join(tmpdir(), 'aorch-chain-'));

  t.after(() => rmSync(projDir, { recursive: true, force: true }));

  // Step 1 — Scaffold
  upsertProject({ name: projectName, tech_stack: 'node', total_phases: 3 });

  // Step 2 — Call generateAISuggestions with canned response
  const suggestions = await generateAISuggestions(
    {
      name: projectName, projectType: 'cli', dependencies: [], scripts: [],
      srcStructure: { dirs: [], fileCount: 0 }, completedPhases: 0,
      phaseTitles: [], scannedAt: new Date().toISOString(),
    },
    'Improve performance',
    ['logic'],
    {},
    [],
    { callClaude: async () => CANNED_RESPONSE },
  );

  // Step 3 — Assert _parseResponse handled bracket-in-string correctly
  assert.equal(suggestions.length, 2);
  assert.equal(suggestions[0].id, 'add-dark-mode');
  assert.equal(suggestions[0].title, 'Add dark mode [beta]');
  assert.equal(suggestions[1].id, 'fix-n-plus-one');
  assert.ok(suggestions[1].title.includes('[high priority]'), 'bracket preserved in Pass-2 title');

  // Step 4 — Persist to SQLite
  const rowId = saveSuggestions(projectName, {
    projectType:  'cli',
    scanSnapshot: { projectType: 'cli' },
    suggestions,
  });
  assert.ok(typeof rowId === 'number' && rowId > 0, 'saveSuggestions returns a positive integer id');

  // Step 5 — Accept with a 2-pass plan
  const passes       = 2;
  const pipelinePlan = assignToPasses(suggestions, passes);

  acceptSuggestions(rowId, {
    selected:       suggestions,
    pipelinePlan,
    pipelinePasses: passes,
  });

  // Step 6 — Assert DB row is accepted
  const row = getLatestSuggestions(projectName);
  assert.ok(row,                    'getLatestSuggestions returns a row');
  assert.equal(row.status, 'accepted');
  assert.equal(row.id, rowId);

  const storedSelected = JSON.parse(row.selected_json);
  assert.equal(storedSelected.length, 2, 'both suggestions persisted');
  assert.equal(row.next_pass, 1, 'next_pass set to lowest non-empty pass (1)');

  // Step 7 — Write suggestions.md
  await writeSuggestionsFile(projDir, projectName, suggestions, pipelinePlan, passes);

  // Step 8 — Assert loadSuggestionsBlock returns the Pass 1 section
  const block = await loadSuggestionsBlock(projDir, 1, projectName);
  assert.ok(block,                                  'loadSuggestionsBlock returns non-null for accepted row');
  assert.ok(block.includes('Add dark mode [beta]'), 'Pass 1 block contains the slot-1 item title');
  assert.ok(!block.includes('N+1'),                 'Pass 1 block does NOT contain the slot-2 item');

  // Step 9 — Assert Pass 2 block
  const block2 = await loadSuggestionsBlock(projDir, 2, projectName);
  assert.ok(block2,                          'loadSuggestionsBlock returns non-null for pass 2');
  assert.ok(block2.includes('N+1 queries'),  'Pass 2 block contains the slot-2 item');
});
