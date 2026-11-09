// Deterministic Repo Map (Phase 15) — src/lib/repo-map.test.mjs
//
// Run with: node --test src/lib/repo-map.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  generateRepoMap,
  renderFrontMatter,
  parseFrontMatter,
  parseRepomixMarkdown,
  renderMapBody,
  extractExportedSymbols,
  estimateTokens,
  renderRepoMapBlock,
  updateRepoMapIncremental,
  renderTreeFromPaths,
  readRepoMapCache,
} from './repo-map.js';
import { repoMapPath, repoMapCachePath } from './guide-paths.js';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');

function makeFixture(label) {
  const projDir = mkdtempSync(path.join(tmpdir(), `aorch-repo-map-proj-${label}-`));
  mkdirSync(path.join(projDir, '.guide'), { recursive: true });

  const workspaceDir = mkdtempSync(path.join(tmpdir(), `aorch-repo-map-ws-${label}-`));
  execSync('git init -q', { cwd: workspaceDir });
  execSync('git config user.email t@example.com', { cwd: workspaceDir });
  execSync('git config user.name test', { cwd: workspaceDir });
  writeFileSync(path.join(workspaceDir, 'README.md'), '# fixture\n');
  execSync('git add -A && git commit -q -m init', { cwd: workspaceDir });

  return { projDir, workspaceDir };
}

const CANNED_SMALL_MARKDOWN = [
  '# Directory Structure',
  '```',
  'src/',
  '  foo.js',
  '```',
  '',
  '# Files',
  '',
  '## File: src/foo.js',
  '```javascript',
  'export function add(a, b)',
  '```',
  '',
].join('\n');

// ─── Skip-if-fresh / regeneration ────────────────────────────────────────────

test('generateRepoMap: unchanged HEAD invokes repomix once; HEAD change triggers regeneration', async () => {
  const { projDir, workspaceDir } = makeFixture('skip-fresh');
  let calls = 0;
  const fakeRunRepomix = async () => { calls += 1; return CANNED_SMALL_MARKDOWN; };
  const cfg = { repo_map: { enabled: true, max_tokens: 4000, exclude: [] } };

  const r1 = await generateRepoMap({ workspaceDir, projDir, cfg }, { runRepomix: fakeRunRepomix });
  assert.equal(calls, 1);
  assert.equal(r1.cached, false);
  assert.ok(r1.generated_at_sha);

  const r2 = await generateRepoMap({ workspaceDir, projDir, cfg }, { runRepomix: fakeRunRepomix });
  assert.equal(calls, 1, 'second call at same HEAD must not re-invoke repomix');
  assert.equal(r2.cached, true);
  assert.equal(r2.generated_at_sha, r1.generated_at_sha);
  assert.equal(r2.body, r1.body);

  writeFileSync(path.join(workspaceDir, 'new-file.txt'), 'x');
  execSync('git add -A && git commit -q -m second', { cwd: workspaceDir });

  const r3 = await generateRepoMap({ workspaceDir, projDir, cfg }, { runRepomix: fakeRunRepomix });
  assert.equal(calls, 2, 'HEAD move must trigger exactly one regeneration');
  assert.equal(r3.cached, false);
  assert.notEqual(r3.generated_at_sha, r1.generated_at_sha);
});

// ─── Front-matter round trip ─────────────────────────────────────────────────

test('front-matter round-trips generated_at_sha/generated_at/tool/approx_tokens/degradation_level', () => {
  const attrs = {
    generated_at_sha: 'deadbeef01cafe',
    generated_at: '2026-07-04T00:00:00.000Z',
    tool: 'repomix',
    approx_tokens: 1234,
    degradation_level: 2,
  };
  const rendered = renderFrontMatter(attrs) + '\n\nbody text\nmore body\n';
  const parsed = parseFrontMatter(rendered);
  assert.deepEqual(parsed.attrs, attrs);
  assert.equal(parsed.body.trim(), 'body text\nmore body');
});

test('generateRepoMap: written file front-matter round-trips on disk and updates on regeneration', async () => {
  const { projDir, workspaceDir } = makeFixture('frontmatter');
  const fakeRunRepomix = async () => CANNED_SMALL_MARKDOWN;
  const cfg = { repo_map: { enabled: true, max_tokens: 4000, exclude: [] } };

  const r1 = await generateRepoMap({ workspaceDir, projDir, cfg }, { runRepomix: fakeRunRepomix });
  const onDisk1 = readFileSync(repoMapPath(projDir), 'utf-8');
  const parsed1 = parseFrontMatter(onDisk1);
  assert.equal(parsed1.attrs.generated_at_sha, r1.generated_at_sha);
  assert.equal(parsed1.attrs.tool, 'repomix');
  assert.equal(parsed1.attrs.approx_tokens, r1.approx_tokens);
  assert.equal(parsed1.attrs.degradation_level, 0);

  writeFileSync(path.join(workspaceDir, 'again.txt'), 'y');
  execSync('git add -A && git commit -q -m third', { cwd: workspaceDir });

  const r2 = await generateRepoMap({ workspaceDir, projDir, cfg }, { runRepomix: fakeRunRepomix });
  const onDisk2 = readFileSync(repoMapPath(projDir), 'utf-8');
  const parsed2 = parseFrontMatter(onDisk2);
  assert.notEqual(parsed2.attrs.generated_at_sha, parsed1.attrs.generated_at_sha);
  assert.equal(parsed2.attrs.generated_at_sha, r2.generated_at_sha);
});

// ─── Degradation levels ───────────────────────────────────────────────────────

function buildDegradationFixtureRaw() {
  const pad = (n) => 'x'.repeat(n);
  const coreFileA = `export function coreA(x) {\n${pad(400)}\n}`;
  const coreFileB = `export class CoreB {\n${pad(400)}\n}`;
  const nonCoreC = `export function nonCoreC(x) {\n${pad(400)}\n}`;
  const nonCoreD = `export const nonCoreD = 1;\n${pad(400)}`;

  const raw = [
    '# Directory Structure',
    '```',
    'src/',
    '  a.js',
    '  b.js',
    'docs/',
    '  c.js',
    '  d.js',
    '```',
    '',
    '# Files',
    '',
    '## File: src/a.js',
    '```javascript',
    coreFileA,
    '```',
    '',
    '## File: src/b.js',
    '```javascript',
    coreFileB,
    '```',
    '',
    '## File: docs/c.js',
    '```javascript',
    nonCoreC,
    '```',
    '',
    '## File: docs/d.js',
    '```javascript',
    nonCoreD,
    '```',
    '',
  ].join('\n');
  return raw;
}

test('degradation: level sizes are strictly decreasing (0 > 1 > 2 > 3) for the fixture', () => {
  const parsed = parseRepomixMarkdown(buildDegradationFixtureRaw());
  const sizes = [0, 1, 2, 3].map((level) => estimateTokens(renderMapBody(parsed, level)));
  assert.ok(sizes[0] > sizes[1], `level0 (${sizes[0]}) must exceed level1 (${sizes[1]})`);
  assert.ok(sizes[1] > sizes[2], `level1 (${sizes[1]}) must exceed level2 (${sizes[2]})`);
  assert.ok(sizes[2] > sizes[3], `level2 (${sizes[2]}) must exceed level3 (${sizes[3]})`);
});

test('degradation: generateRepoMap picks the documented level (0→1→2→3) matching the token budget', async () => {
  const raw = buildDegradationFixtureRaw();
  const parsed = parseRepomixMarkdown(raw);
  const sizes = [0, 1, 2, 3].map((level) => estimateTokens(renderMapBody(parsed, level)));

  for (const level of [0, 1, 2, 3]) {
    const { projDir, workspaceDir } = makeFixture(`degrade-${level}`);
    const cfg = { repo_map: { enabled: true, max_tokens: sizes[level], exclude: [] } };
    const result = await generateRepoMap(
      { workspaceDir, projDir, cfg },
      { runRepomix: async () => raw },
    );
    assert.equal(result.degradation_level, level, `expected degradation_level ${level} at max_tokens=${sizes[level]}`);
    assert.equal(result.approx_tokens, sizes[level]);
  }
});

test('degradation: within-budget fixture stays at level 0', async () => {
  const { projDir, workspaceDir } = makeFixture('within-budget');
  const cfg = { repo_map: { enabled: true, max_tokens: 100_000, exclude: [] } };
  const result = await generateRepoMap(
    { workspaceDir, projDir, cfg },
    { runRepomix: async () => CANNED_SMALL_MARKDOWN },
  );
  assert.equal(result.degradation_level, 0);
});

test('extractExportedSymbols: finds function/class/const/CJS export forms', () => {
  const content = [
    'export function add(a, b)',
    'export class Widget',
    'export const PI = 3.14',
    'exports.helper = function()',
  ].join('\n');
  const symbols = extractExportedSymbols(content);
  assert.deepEqual(new Set(symbols), new Set(['add', 'Widget', 'PI', 'helper']));
});

// ─── Fail-open ────────────────────────────────────────────────────────────────

test('generateRepoMap: repomix invocation failure returns null and logs a warning (fail-open)', async () => {
  const { projDir, workspaceDir } = makeFixture('fail-open');
  const cfg = { repo_map: { enabled: true, max_tokens: 4000, exclude: [] } };

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (msg) => { warnings.push(String(msg)); };
  let result;
  try {
    result = await generateRepoMap(
      { workspaceDir, projDir, cfg },
      { runRepomix: async () => { throw new Error('spawn ENOENT: broken repomix binary path'); } },
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(result, null);
  assert.ok(warnings.some((w) => w.includes('repo-map')), 'expected a [repo-map]-tagged warning');
});

test('generateRepoMap: unresolvable HEAD (non-git workspace) returns null and logs a warning (fail-open)', async () => {
  const projDir = mkdtempSync(path.join(tmpdir(), 'aorch-repo-map-proj-nogit-'));
  mkdirSync(path.join(projDir, '.guide'), { recursive: true });
  const workspaceDir = mkdtempSync(path.join(tmpdir(), 'aorch-repo-map-ws-nogit-'));
  const cfg = { repo_map: { enabled: true, max_tokens: 4000, exclude: [] } };

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (msg) => { warnings.push(String(msg)); };
  let result;
  try {
    result = await generateRepoMap({ workspaceDir, projDir, cfg });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(result, null);
  assert.ok(warnings.some((w) => w.includes('repo-map')));
});

test('generateRepoMap: repo_map.enabled false is a no-op (no repomix invocation)', async () => {
  const { projDir, workspaceDir } = makeFixture('disabled');
  let calls = 0;
  const cfg = { repo_map: { enabled: false } };
  const result = await generateRepoMap(
    { workspaceDir, projDir, cfg },
    { runRepomix: async () => { calls += 1; return CANNED_SMALL_MARKDOWN; } },
  );
  assert.equal(result, null);
  assert.equal(calls, 0);
});

// ─── Real repomix integration (no injected deps) ─────────────────────────────

test('generateRepoMap: real repomix binary produces a valid map on a tiny fixture repo', async (t) => {
  const { projDir, workspaceDir } = makeFixture('real-repomix');
  const cfg = { repo_map: { enabled: true, max_tokens: 4000, exclude: [] } };

  let result;
  try {
    result = await generateRepoMap({ workspaceDir, projDir, cfg });
  } catch (err) {
    t.skip(`real repomix invocation unavailable in this environment: ${err.message}`);
    return;
  }
  if (result == null) {
    t.skip('real repomix invocation failed in this environment (fail-open returned null) — see warnings above');
    return;
  }
  assert.ok(result.body.includes('Directory Structure'));
  assert.ok(result.body.includes('README.md'));
  assert.equal(result.tool, 'repomix');
});

// ─── No-shell-string regression (grep test) ──────────────────────────────────

test('repo-map.js invokes repomix via array-args execFile — no shell string', () => {
  const src = readFileSync(path.join(repoRoot, 'src', 'lib', 'repo-map.js'), 'utf-8');

  // The only named import from node:child_process must be execFile — not
  // exec (which interprets its argument as a shell command string).
  const importMatch = /import\s*\{([^}]*)\}\s*from\s*['"]node:child_process['"]/.exec(src);
  assert.ok(importMatch, 'expected a named import from node:child_process');
  const importedNames = importMatch[1].split(',').map((s) => s.trim());
  assert.deepEqual(importedNames, ['execFile']);

  assert.ok(!/shell\s*:\s*true/.test(src), 'must not spawn/execFile with shell:true');
  assert.ok(!/execFile\([^,]*\$\{/.test(src), 'execFile command arg must not be template-interpolated');
});

// ─── Config ──────────────────────────────────────────────────────────────────

test('config/defaults.json has a repo_map block with enabled/max_tokens/guide_tasks/exclude', async () => {
  const raw = await fsp.readFile(path.join(repoRoot, 'config', 'defaults.json'), 'utf-8');
  const defaults = JSON.parse(raw);
  assert.ok(defaults.repo_map);
  assert.equal(typeof defaults.repo_map.enabled, 'boolean');
  assert.equal(typeof defaults.repo_map.max_tokens, 'number');
  assert.ok(Array.isArray(defaults.repo_map.guide_tasks));
  assert.ok(Array.isArray(defaults.repo_map.exclude));
});

// Phase 16: guide_tasks is reconciled to the resolveConfig TASK-ID namespace
// (defaults.models keys / billing attribution) — NOT GUIDE_TASK_MAP's
// runGuide()-facing dispatch keys. Regression guard against the list drifting
// back to a mixed/placeholder scheme (see docs/ARCHITECTURE.md "Injection sites").
test('config/defaults.json repo_map.guide_tasks uses the reconciled resolveConfig task-id scheme', async () => {
  const raw = await fsp.readFile(path.join(repoRoot, 'config', 'defaults.json'), 'utf-8');
  const defaults = JSON.parse(raw);
  const modelTaskIds = new Set(Object.keys(defaults.models));
  for (const taskId of defaults.repo_map.guide_tasks) {
    assert.ok(modelTaskIds.has(taskId), `guide_tasks entry "${taskId}" must be a real defaults.models task id`);
  }
  // The two-stage full audit's shared block and the single-call audit path
  // both need coverage — either name works (see runTwoStageAudit), but both
  // being present is the intended default so incremental AND full audits inject.
  assert.ok(defaults.repo_map.guide_tasks.includes('audit'));
  assert.ok(defaults.repo_map.guide_tasks.includes('audit-scan'));
  assert.ok(defaults.repo_map.guide_tasks.includes('plan-creation'));
  assert.ok(defaults.repo_map.guide_tasks.includes('project-context-gen'));
  assert.ok(defaults.repo_map.guide_tasks.includes('suggest-scan'));
});

// ─── renderRepoMapBlock ───────────────────────────────────────────────────────

test('renderRepoMapBlock: null map returns null', () => {
  assert.equal(renderRepoMapBlock(null), null);
});

test('renderRepoMapBlock: wraps body in <repo_map>, prefixed with the brief P1 precedence sentence verbatim (includes the sha)', () => {
  const block = renderRepoMapBlock({ generated_at_sha: 'abc1234', body: '# Directory Structure\n```\nsrc/\n```\n' });
  assert.ok(block.startsWith('<repo_map>'));
  assert.ok(block.endsWith('</repo_map>'));
  assert.ok(
    block.includes('This map is generated from static analysis at commit abc1234. It orients you; it is not exhaustive. The code itself is authoritative — verify before relying on it.'),
    'precedence sentence must appear verbatim with the sha interpolated',
  );
  assert.ok(block.includes('# Directory Structure'), 'map body is included');
});

test('repoMapPath: resolves to <projectDir>/.guide/repo-map.md', () => {
  assert.equal(repoMapPath('/tmp/proj'), path.join('/tmp/proj', '.guide', 'repo-map.md'));
});

test('repoMapCachePath: resolves to <projectDir>/.guide/repo-map-cache.json', () => {
  assert.equal(repoMapCachePath('/tmp/proj'), path.join('/tmp/proj', '.guide', 'repo-map-cache.json'));
});

// ─── Phase 39 (CE-4): renderTreeFromPaths ────────────────────────────────────

test('renderTreeFromPaths: directories before files, both alphabetical, 2-space indent per depth, trailing slash on directories', () => {
  const tree = renderTreeFromPaths(['src/b.js', 'src/a.js', 'README.md', 'src/nested/deep.js']);
  assert.equal(tree, [
    'src/',
    '  nested/',
    '    deep.js',
    '  a.js',
    '  b.js',
    'README.md',
  ].join('\n'));
});

test('renderTreeFromPaths: empty input renders an empty string', () => {
  assert.equal(renderTreeFromPaths([]), '');
});

// ─── Phase 39 (CE-4): readRepoMapCache — fail-open ───────────────────────────

test('readRepoMapCache: missing file, invalid JSON, and a malformed shape all fail open to null', async () => {
  const { projDir } = makeFixture('cache-failopen');
  assert.equal(await readRepoMapCache(projDir), null);

  await fsp.writeFile(repoMapCachePath(projDir), 'not json');
  assert.equal(await readRepoMapCache(projDir), null);

  await fsp.writeFile(repoMapCachePath(projDir), JSON.stringify({ sha: 'x' }));
  assert.equal(await readRepoMapCache(projDir), null);
});

test('readRepoMapCache: a well-formed cache round-trips', async () => {
  const { projDir } = makeFixture('cache-roundtrip');
  const cache = { sha: 'abc123', tree: 'a.js\n', files: [{ path: 'a.js', lang: 'javascript', content: 'x' }] };
  await fsp.writeFile(repoMapCachePath(projDir), JSON.stringify(cache));
  assert.deepEqual(await readRepoMapCache(projDir), cache);
});

// ─── Phase 39 (CE-4): updateRepoMapIncremental ───────────────────────────────

test('updateRepoMapIncremental: a 2-file change invokes repomix with --include of exactly those paths and merges correctly', async () => {
  const cache = {
    sha: 'sha1',
    tree: 'a.js\nb.js\nc.js\n',
    files: [
      { path: 'a.js', lang: 'javascript', content: 'old a' },
      { path: 'b.js', lang: 'javascript', content: 'old b' },
      { path: 'c.js', lang: 'javascript', content: 'old c' },
    ],
  };
  let capturedArgs = null;
  const deps = {
    changedFilesSince: async () => ({ ok: true, files: ['a.js', 'b.js'] }),
    runRepomix: async (args) => {
      capturedArgs = args;
      return [
        '# Directory Structure', '```', 'a.js\nb.js\nc.js', '```', '',
        '# Files', '',
        '## File: a.js', '```javascript', 'new a', '```', '',
        '## File: b.js', '```javascript', 'new b', '```', '',
      ].join('\n');
    },
    listTrackedFiles: async () => ({ ok: true, files: ['a.js', 'b.js', 'c.js'] }),
  };
  const result = await updateRepoMapIncremental({ workspaceDir: '/tmp/unused', cfg: { repo_map: {} }, cache }, deps);

  assert.deepEqual(capturedArgs.extraArgs, ['--include', 'a.js,b.js']);
  const byPath = Object.fromEntries(result.files.map((f) => [f.path, f.content]));
  assert.equal(byPath['a.js'], 'new a', 'changed file gets fresh content');
  assert.equal(byPath['b.js'], 'new b', 'changed file gets fresh content');
  assert.equal(byPath['c.js'], 'old c', 'unchanged file keeps its cached content');
  assert.equal(result.tree, renderTreeFromPaths(['a.js', 'b.js', 'c.js']));
});

test('updateRepoMapIncremental: a changed path with no fresh content that no longer exists on disk is dropped from the cache (delete/rename)', async () => {
  const workspaceDir = mkdtempSync(path.join(tmpdir(), 'aorch-repo-map-incr-del-'));
  writeFileSync(path.join(workspaceDir, 'b.js'), 'kept');
  const cache = {
    sha: 'sha1',
    tree: 'a.js\nb.js\n',
    files: [
      { path: 'a.js', lang: 'javascript', content: 'old a' },
      { path: 'b.js', lang: 'javascript', content: 'old b' },
    ],
  };
  const deps = {
    changedFilesSince: async () => ({ ok: true, files: ['a.js'] }),
    runRepomix: async () => ['# Directory Structure', '```', 'b.js', '```', '', '# Files', '', ''].join('\n'),
    listTrackedFiles: async () => ({ ok: true, files: ['b.js'] }),
  };
  const result = await updateRepoMapIncremental({ workspaceDir, cfg: { repo_map: {} }, cache }, deps);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].path, 'b.js');
  assert.ok(!result.files.some((f) => f.path === 'a.js'), 'deleted file dropped from the merged cache');
});

test('updateRepoMapIncremental: a changed path that repomix skipped but still exists on disk is left untouched (not silently dropped)', async () => {
  const workspaceDir = mkdtempSync(path.join(tmpdir(), 'aorch-repo-map-incr-keep-'));
  writeFileSync(path.join(workspaceDir, 'a.js'), 'still here');
  const cache = {
    sha: 'sha1',
    tree: 'a.js\n',
    files: [{ path: 'a.js', lang: 'javascript', content: 'old a' }],
  };
  const deps = {
    changedFilesSince: async () => ({ ok: true, files: ['a.js'] }),
    runRepomix: async () => ['# Directory Structure', '```', 'a.js', '```', '', '# Files', '', ''].join('\n'),
    listTrackedFiles: async () => ({ ok: true, files: ['a.js'] }),
  };
  const result = await updateRepoMapIncremental({ workspaceDir, cfg: { repo_map: {} }, cache }, deps);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].content, 'old a', 'still-on-disk entry keeps its last-known cached content');
});

test('updateRepoMapIncremental: no cache, a changedFilesSince failure, and a diff over the threshold each fall back to a full repack (no --include)', async () => {
  const calls = [];
  const runRepomix = async (args) => { calls.push(args); return CANNED_SMALL_MARKDOWN; };

  await updateRepoMapIncremental({ workspaceDir: '/tmp/x', cfg: { repo_map: {} }, cache: null }, { runRepomix });
  await updateRepoMapIncremental(
    { workspaceDir: '/tmp/x', cfg: { repo_map: {} }, cache: { sha: 's', tree: '', files: [] } },
    { runRepomix, changedFilesSince: async () => ({ ok: false, error: 'boom' }) },
  );
  await updateRepoMapIncremental(
    { workspaceDir: '/tmp/x', cfg: { repo_map: { full_repack_threshold_files: 2 } }, cache: { sha: 's', tree: '', files: [] } },
    { runRepomix, changedFilesSince: async () => ({ ok: true, files: ['a.js', 'b.js', 'c.js'] }) },
  );

  assert.equal(calls.length, 3, 'all three scenarios invoked the full-repack runRepomix call');
  for (const c of calls) assert.equal(c.extraArgs, undefined, 'full repack never scopes with --include');
});

test('updateRepoMapIncremental: a listTrackedFiles failure after a successful incremental content merge also falls back to a full repack', async () => {
  const cache = { sha: 'sha1', tree: 'a.js\n', files: [{ path: 'a.js', lang: 'javascript', content: 'old a' }] };
  const calls = [];
  const deps = {
    changedFilesSince: async () => ({ ok: true, files: ['a.js'] }),
    runRepomix: async (args) => { calls.push(args); return CANNED_SMALL_MARKDOWN; },
    listTrackedFiles: async () => ({ ok: false, error: 'git ls-files failed' }),
  };
  await updateRepoMapIncremental({ workspaceDir: '/tmp/x', cfg: { repo_map: {} }, cache }, deps);
  assert.equal(calls.length, 2, 'the incremental --include call, then a full-repack fallback call');
  assert.deepEqual(calls[0].extraArgs, ['--include', 'a.js']);
  assert.equal(calls[1].extraArgs, undefined, 'the fallback call is a plain full repack');
});

// ─── Phase 39 (CE-4): generateRepoMap incremental wiring (real git fixture) ──

test('generateRepoMap: incremental path scopes repomix to only the files changed since the cached sha, and writes the cache json', async () => {
  const { projDir, workspaceDir } = makeFixture('incremental-real');
  const cfg = { repo_map: { enabled: true, max_tokens: 4000, exclude: [] } };
  let lastArgs = null;
  const fakeRunRepomix = async (args) => { lastArgs = args; return CANNED_SMALL_MARKDOWN; };

  const r1 = await generateRepoMap({ workspaceDir, projDir, cfg }, { runRepomix: fakeRunRepomix });
  assert.equal(lastArgs.extraArgs, undefined, 'first (full) repack has no --include scoping');
  const cacheAfterFirst = JSON.parse(readFileSync(repoMapCachePath(projDir), 'utf-8'));
  assert.equal(cacheAfterFirst.sha, r1.generated_at_sha);

  writeFileSync(path.join(workspaceDir, 'second.js'), 'export function two() {}\n');
  execSync('git add -A && git commit -q -m second', { cwd: workspaceDir });

  const r2 = await generateRepoMap({ workspaceDir, projDir, cfg }, { runRepomix: fakeRunRepomix });
  assert.deepEqual(lastArgs.extraArgs, ['--include', 'second.js']);
  assert.notEqual(r2.generated_at_sha, r1.generated_at_sha);
  const cacheAfterSecond = JSON.parse(readFileSync(repoMapCachePath(projDir), 'utf-8'));
  assert.equal(cacheAfterSecond.sha, r2.generated_at_sha);
});

test('generateRepoMap: repo_map.incremental:false always full-repacks — no --include scoping and no cache file written', async () => {
  const { projDir, workspaceDir } = makeFixture('incremental-off');
  const cfg = { repo_map: { enabled: true, max_tokens: 4000, exclude: [], incremental: false } };
  const calls = [];
  const fakeRunRepomix = async (args) => { calls.push(args); return CANNED_SMALL_MARKDOWN; };

  await generateRepoMap({ workspaceDir, projDir, cfg }, { runRepomix: fakeRunRepomix });
  writeFileSync(path.join(workspaceDir, 'second.js'), 'x');
  execSync('git add -A && git commit -q -m second', { cwd: workspaceDir });
  await generateRepoMap({ workspaceDir, projDir, cfg }, { runRepomix: fakeRunRepomix });

  assert.equal(calls.length, 2);
  for (const c of calls) assert.equal(c.extraArgs, undefined);
  await assert.rejects(() => fsp.readFile(repoMapCachePath(projDir), 'utf-8'), 'incremental:false never writes the cache file');
});

// ─── Phase 39 (CE-4): renderMapBody focus rendering ──────────────────────────

test('renderMapBody: empty/absent focusPaths reproduces the unfocused output byte-for-byte (regression)', () => {
  const parsed = parseRepomixMarkdown(buildDegradationFixtureRaw());
  for (const level of [0, 1, 2, 3]) {
    const base = renderMapBody(parsed, level);
    assert.equal(renderMapBody(parsed, level, {}), base);
    assert.equal(renderMapBody(parsed, level, { focusPaths: [] }), base);
    assert.equal(renderMapBody(parsed, level, { focusPaths: undefined }), base);
  }
});

test('renderMapBody: focusPaths hitting one file renders that file\'s content in full while the others degrade to symbols-only', () => {
  const parsed = parseRepomixMarkdown(buildDegradationFixtureRaw());
  const body = renderMapBody(parsed, 0, { focusPaths: ['src/a.js'] });
  assert.match(body, /## File: src\/a\.js/);
  assert.doesNotMatch(body, /## File: src\/b\.js/);
  assert.doesNotMatch(body, /## File: docs\/c\.js/);
  assert.match(body, /# Exported symbols/);
  assert.match(body, /- src\/b\.js/);
  assert.match(body, /- docs\/c\.js/);
});

test('renderMapBody: a directory-prefix focusPath focuses every file under it', () => {
  const parsed = parseRepomixMarkdown(buildDegradationFixtureRaw());
  const body = renderMapBody(parsed, 0, { focusPaths: ['src'] });
  assert.match(body, /## File: src\/a\.js/);
  assert.match(body, /## File: src\/b\.js/);
  assert.doesNotMatch(body, /## File: docs\/c\.js/);
  assert.doesNotMatch(body, /## File: docs\/d\.js/);
});

test('renderMapBody: focus mode stays deterministic (byte-identical) across repeated calls with the same inputs', () => {
  const parsed = parseRepomixMarkdown(buildDegradationFixtureRaw());
  const a = renderMapBody(parsed, 1, { focusPaths: ['src/a.js'] });
  const b = renderMapBody(parsed, 1, { focusPaths: ['src/a.js'] });
  assert.equal(a, b);
});
