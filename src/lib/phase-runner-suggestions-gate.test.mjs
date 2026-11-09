// Tests for loadSuggestionsBlock's DB-gate logic (the accepted-status guard added in fix-r29-2).
//
// Run with: node --test src/lib/phase-runner-suggestions-gate.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DB_PATH = ':memory:';

const { loadSuggestionsBlock } = await import('./phase-runner.js');
const {
  upsertProject, saveSuggestions, acceptSuggestions, staleAllSuggestions,
} = await import('../state.js');

function makeProjectDir(label) {
  const projDir = mkdtempSync(path.join(tmpdir(), `aorch-prsuggest-${label}-`));
  const guideDir = path.join(projDir, '.guide');
  mkdirSync(guideDir, { recursive: true });
  writeFileSync(
    path.join(guideDir, 'suggestions.md'),
    '## Pass 1\n- Suggestion A\n- Suggestion B\n',
  );
  return projDir;
}

test('null projectName skips the gate and returns content from file (backward compat)', async () => {
  // No DB setup — projectName is null so gate is skipped entirely.
  // File exists → file-driven path should return content.
  const projDir = makeProjectDir('fallback');
  const result = await loadSuggestionsBlock(projDir, 1, null);
  assert.ok(result !== null, 'null projectName → no gate → content returned from file');
  assert.ok(result.includes('<suggestions_plan'), 'has suggestions_plan tag');
});

test('returns null when projectName given but no suggestions row exists', async () => {
  upsertProject({ name: 'sg-no-row', tech_stack: 'node', total_phases: 1 });
  const projDir = makeProjectDir('no-row');
  // No suggestions row at all → getLatestSuggestions returns null → gate blocks
  const result = await loadSuggestionsBlock(projDir, 1, 'sg-no-row');
  assert.equal(result, null, 'no row → null');
});

test('returns null when the suggestions row is stale (file still present on disk)', async () => {
  const name = 'sg-stale';
  upsertProject({ name, tech_stack: 'node', total_phases: 1 });
  const id = saveSuggestions(name, {
    projectType: 'cli',
    scanSnapshot: {},
    suggestions: [{ id: 'a', title: 'A' }],
  });
  acceptSuggestions(id, {
    selected: [{ id: 'a' }],
    pipelinePlan: { '1': ['a'] },
    pipelinePasses: 1,
  });
  staleAllSuggestions(name); // simulates reset-brief DB side
  const projDir = makeProjectDir('stale');

  // File is still on disk (the bug scenario) — gate must block it
  const result = await loadSuggestionsBlock(projDir, 1, name);
  assert.equal(result, null, 'stale row → null even when file is present');
});

test('returns content when the suggestions row is accepted', async () => {
  const name = 'sg-accepted';
  upsertProject({ name, tech_stack: 'node', total_phases: 1 });
  const id = saveSuggestions(name, {
    projectType: 'cli',
    scanSnapshot: {},
    suggestions: [{ id: 'a', title: 'A' }],
  });
  acceptSuggestions(id, {
    selected: [{ id: 'a' }],
    pipelinePlan: { '1': ['a'] },
    pipelinePasses: 1,
  });
  const projDir = makeProjectDir('accepted');

  const result = await loadSuggestionsBlock(projDir, 1, name);
  assert.ok(result !== null, 'accepted row → content injected');
  assert.ok(result.includes('<suggestions_plan slot="1">'), 'correct slot tag');
});

test('stale row blocks injection regardless of slot number', async () => {
  const name = 'sg-stale2';
  upsertProject({ name, tech_stack: 'node', total_phases: 2 });
  const id = saveSuggestions(name, {
    projectType: 'fullstack',
    scanSnapshot: {},
    suggestions: [{ id: 'x', title: 'X' }, { id: 'y', title: 'Y' }],
  });
  acceptSuggestions(id, {
    selected: [{ id: 'x' }, { id: 'y' }],
    pipelinePlan: { '1': ['x'], '2': ['y'] },
    pipelinePasses: 2,
  });
  staleAllSuggestions(name);

  const projDir = makeProjectDir('stale2');
  const result = await loadSuggestionsBlock(projDir, 1, name);
  assert.equal(result, null, 'stale 2-pass plan → null on any slot');
});
