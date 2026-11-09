// Doc-drift lint (Phase 75, brief P7 part 3/3) — src/lib/parallel-execution-docs.test.mjs
//
// docs/PARALLEL_EXECUTION.md names config flags in dotted-path inline-code spans
// (e.g. `auto_run.max_parallel_phases`, or `overrides.bug_cycle.batch_minor_fixes`
// for a per-project override example). This test greps every such span out of the
// doc and resolves it against config/defaults.json so the doc can never drift out
// of sync with the actual config surface — a renamed/removed key breaks this test
// instead of silently going stale in the doc.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');
const DOC_PATH = path.join(repoRoot, 'docs', 'PARALLEL_EXECUTION.md');
const DEFAULTS_PATH = path.join(repoRoot, 'config', 'defaults.json');

// A dotted config-path candidate: word(.word)+, anchored to the WHOLE inline-code
// span so a code span like `src/lib/duo-executor.js` (contains slashes) or a plain
// prose word never matches.
const DOTTED_PATH_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)+$/;

// File-extension-looking last segments are code/doc references, not config keys
// (e.g. `config/defaults.json` has no slash issue but a bare `defaults.json` would
// otherwise parse as a two-segment dotted path).
const FILE_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'json', 'md', 'ts']);

/**
 * Extracts every inline-code span from markdown text that looks like a
 * dotted config path (as opposed to a file name or prose).
 */
export function extractDottedPathCandidates(markdown) {
  const spans = [...markdown.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const candidates = [];
  for (const span of spans) {
    if (!DOTTED_PATH_RE.test(span)) continue;
    const segments = span.split('.');
    if (FILE_EXTENSIONS.has(segments[segments.length - 1])) continue;
    candidates.push(span);
  }
  return candidates;
}

/**
 * Resolves a dotted path (optionally prefixed with the project.json
 * `overrides.` convention documented in docs/AUTO_RUN.md, e.g.
 * `overrides.auto_run.max_parallel_phases`) against a parsed config object.
 * Returns true if every segment resolves to a defined value.
 */
export function resolvesAgainstConfig(dottedPath, config) {
  const segments = dottedPath.split('.');
  if (segments[0] === 'overrides') segments.shift();
  let node = config;
  for (const segment of segments) {
    if (node === null || typeof node !== 'object' || !(segment in node)) return false;
    node = node[segment];
  }
  return true;
}

/**
 * Finds every dotted-path code span in `markdown` that does NOT resolve
 * against `config`. Pure — used by both the real doc check and the
 * self-check test below with a fabricated snippet.
 */
export function findConfigKeyDriftInDoc(markdown, config) {
  return extractDottedPathCandidates(markdown).filter((c) => !resolvesAgainstConfig(c, config));
}

test('every config-flag path cited in docs/PARALLEL_EXECUTION.md resolves to a real config/defaults.json key', async () => {
  const [doc, defaultsRaw] = await Promise.all([
    readFile(DOC_PATH, 'utf8'),
    readFile(DEFAULTS_PATH, 'utf8'),
  ]);
  const defaults = JSON.parse(defaultsRaw);

  const drift = findConfigKeyDriftInDoc(doc, defaults);

  assert.deepEqual(
    drift, [],
    `docs/PARALLEL_EXECUTION.md cites config path(s) that don't exist in config/defaults.json: ${drift.join(', ')}`,
  );
});

test('docs/PARALLEL_EXECUTION.md actually names the core enablement flags (sanity check on the extractor)', async () => {
  const doc = await readFile(DOC_PATH, 'utf8');
  const candidates = new Set(extractDottedPathCandidates(doc));

  for (const flag of [
    'auto_run.max_parallel_phases',
    'bug_cycle.max_parallel_fixes',
    'bug_cycle.batch_minor_fixes',
    'auto_run.speculative_duo_on_double_failure',
    'parallel_lanes.node_modules',
  ]) {
    assert.ok(candidates.has(flag), `expected docs/PARALLEL_EXECUTION.md to cite \`${flag}\` in an inline-code span`);
  }
});

test('self-check — a doc naming a non-existent config key is caught as drift', () => {
  const fakeDoc = 'Set `auto_run.max_parallel_phases` to 2, or the typo'
    + ' `bug_cycle.batch_min_fixes` (does not exist) to enable batching.';
  const fakeConfig = { auto_run: { max_parallel_phases: 1 }, bug_cycle: { batch_minor_fixes: false } };

  const drift = findConfigKeyDriftInDoc(fakeDoc, fakeConfig);

  assert.deepEqual(drift, ['bug_cycle.batch_min_fixes']);
});

test('self-check — file-name-looking code spans are never mistaken for config paths', () => {
  const fakeDoc = 'See `src/lib/duo-executor.js` and `config/defaults.json` and `defaults.json`.';
  const candidates = extractDottedPathCandidates(fakeDoc);

  assert.deepEqual(candidates, []);
});

test('self-check — an overrides.-prefixed path resolves against the same underlying key', () => {
  const fakeConfig = { auto_run: { max_parallel_phases: 1 } };

  assert.equal(resolvesAgainstConfig('auto_run.max_parallel_phases', fakeConfig), true);
  assert.equal(resolvesAgainstConfig('overrides.auto_run.max_parallel_phases', fakeConfig), true);
  assert.equal(resolvesAgainstConfig('overrides.auto_run.nonexistent_key', fakeConfig), false);
});
