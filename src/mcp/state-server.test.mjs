// State-server (Phase 11) unit + integration tests.
//
// Two layers:
//   (A) Unit tests against the exported tool functions directly (getDecisions,
//       getPhaseReport, getBugHistory, getLessons, logLesson) using a throwaway
//       tmpdir fixture — fast, granular shape/filter/escape assertions.
//   (B) A real-subprocess integration test: spawns state-server.mjs exactly as
//       `claude` would (via the MCP SDK's StdioClientTransport), lists its
//       tools, calls each of the five once, and confirms a path-escape
//       argument is rejected end-to-end — not just at the unit level.
//
// (B) requires the fixture project to live under the real `projects/` dir
// (gitignored — see .gitignore) because state-server.mjs resolves
// `--project <name>` against its own hardcoded PROJECTS_DIR, the same
// convention every other project-path helper in this repo follows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DB_PATH = ':memory:';
process.env.AORCH_CONTEXT_STATE_DIR = mkdtempSync(path.join(tmpdir(), 'aorch-mcp-context-state-'));

const {
  getDecisions, getPhaseReport, getBugHistory, getLessons, logLesson,
  getPhaseLedger, getRepoMap, getCompiledContext, queryCodeSymbols, getTestImpact,
  askOperator, buildServer, activeToolNamesForConfig,
  resolveProjectDir, MCP_SERVER_NAME, MCP_TOOL_NAMES, CONTEXT_MCP_TOOL_NAMES,
} = await import('./state-server.mjs');
const { guideRoot, lessonsPath, phaseLedgerPath, repoMapPath, repoMapCachePath } = await import('../lib/guide-paths.js');
const { renderFrontMatter } = await import('../lib/repo-map.js');
const { persistContextManifest } = await import('../lib/context-compiler.js');
const { validateDecision } = await import('../lib/decisions-schema.js');
const { listOperatorQuestions } = await import('../state.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STATE_SERVER_PATH = path.join(__dirname, 'state-server.mjs');

function makeProjDir(label) {
  const d = mkdtempSync(path.join(tmpdir(), `aorch-mcp-${label}-`));
  mkdirSync(path.join(d, '.guide'), { recursive: true });
  return d;
}

// ── (A) get_decisions ────────────────────────────────────────────────────────

test('getDecisions: returns parsed entries, excludes rationale, filters by topic', async () => {
  const projDir = makeProjDir('dec');
  const entries = [
    { phase: '5', title: 'error shape', decision: 'Use a JSON error envelope', rationale: 'stable clients', type: 'convention' },
    { phase: '7', title: 'gate TTL', decision: 'Brief-append confirm TTL is 5 minutes', rationale: 'expiry default', type: 'constraint' },
  ];
  const jsonl = entries.map((e) => JSON.stringify(e)).join('\n') + '\n' + 'not valid json\n';
  writeFileSync(path.join(projDir, '.guide', 'decisions.jsonl'), jsonl);

  const all = await getDecisions(projDir, {});
  assert.equal(all.decisions.length, 2);
  assert.ok(!('rationale' in all.decisions[0]), 'rationale must never be returned');

  const filtered = await getDecisions(projDir, { topic: 'gate' });
  assert.equal(filtered.decisions.length, 1);
  assert.equal(filtered.decisions[0].title, 'gate TTL');
});

test('getDecisions: no decisions.jsonl on disk returns empty array, never throws', async () => {
  const projDir = makeProjDir('dec-empty');
  const result = await getDecisions(projDir, {});
  assert.deepEqual(result, { decisions: [] });
});

// ── (A) get_phase_report ─────────────────────────────────────────────────────

test('getPhaseReport: reads report.md via the NN- prefix lookup', async () => {
  const projDir = makeProjDir('report');
  mkdirSync(path.join(projDir, '.guide', 'phases', '05-fvu-file-builder'), { recursive: true });
  writeFileSync(path.join(projDir, '.guide', 'phases', '05-fvu-file-builder', 'report.md'), '# Phase 5 report\nDone.');

  const found = await getPhaseReport(projDir, { n: 5 });
  assert.equal(found.found, true);
  assert.equal(found.dir, '05-fvu-file-builder');
  assert.match(found.report, /Phase 5 report/);
  assert.equal(found.truncated, false);
});

test('getPhaseReport: unknown phase number returns found:false, not an error', async () => {
  const projDir = makeProjDir('report-missing');
  const result = await getPhaseReport(projDir, { n: 99 });
  assert.equal(result.found, false);
  assert.equal(result.report, null);
});

test('getPhaseReport: rejects a non-integer n', async () => {
  const projDir = makeProjDir('report-badarg');
  await assert.rejects(() => getPhaseReport(projDir, { n: 'DROP TABLE' }), /positive integer/);
});

test('getPhaseReport: truncates an oversized report', async () => {
  const projDir = makeProjDir('report-big');
  mkdirSync(path.join(projDir, '.guide', 'phases', '02-big'), { recursive: true });
  writeFileSync(path.join(projDir, '.guide', 'phases', '02-big', 'report.md'), 'x'.repeat(25000));
  const result = await getPhaseReport(projDir, { n: 2 });
  assert.equal(result.truncated, true);
  assert.equal(result.report.length, 20000);
});

// ── (A) get_bug_history ──────────────────────────────────────────────────────

async function writeFixPlan(projDir, round, fixes) {
  mkdirSync(path.join(projDir, '.guide', 'bug-rounds', `round-${round}`), { recursive: true });
  await fs.writeFile(
    path.join(projDir, '.guide', 'bug-rounds', `round-${round}`, 'plan.json'),
    JSON.stringify({ fixes }),
  );
  await fs.writeFile(
    path.join(projDir, '.guide', 'bug-rounds', `round-${round}`, 'bugs.md'),
    `# Round ${round} bugs\nSome bug text for round ${round}.`,
  );
}

test('getBugHistory: no file filter returns every round, newest first', async () => {
  const projDir = makeProjDir('bugs-all');
  await writeFixPlan(projDir, 1, [{ n: 1, title: 'fix a', files: ['a.js'] }]);
  await writeFixPlan(projDir, 2, [{ n: 1, title: 'fix b', files: ['b.js'] }]);

  const result = await getBugHistory(projDir, {});
  assert.equal(result.rounds.length, 2);
  assert.equal(result.rounds[0].round, 2, 'newest round first');
  assert.equal(result.rounds[1].round, 1);
});

test('getBugHistory: file filter narrows to rounds whose fixes touch that file', async () => {
  const projDir = makeProjDir('bugs-filter');
  await writeFixPlan(projDir, 1, [{ n: 1, title: 'fix uploads', files: ['backend/controllers/uploadController.js'] }]);
  await writeFixPlan(projDir, 2, [{ n: 1, title: 'fix unrelated', files: ['backend/other.js'] }]);

  const result = await getBugHistory(projDir, { file: 'uploadController.js' });
  assert.equal(result.rounds.length, 1);
  assert.equal(result.rounds[0].round, 1);
  assert.equal(result.rounds[0].matching_fixes[0].title, 'fix uploads');
});

test('getBugHistory: no bug rounds on disk returns empty array', async () => {
  const projDir = makeProjDir('bugs-none');
  const result = await getBugHistory(projDir, {});
  assert.deepEqual(result, { rounds: [] });
});

test('getBugHistory: path-escape file argument rejects via assertInsideDir', async () => {
  const projDir = makeProjDir('bugs-escape');
  await writeFixPlan(projDir, 1, [{ n: 1, title: 'fix a', files: ['a.js'] }]);
  await assert.rejects(() => getBugHistory(projDir, { file: '/etc/passwd' }), /escapes base directory/);
  await assert.rejects(() => getBugHistory(projDir, { file: '../../../../../../etc/passwd' }), /escapes base directory/);
});

// ── (A) get_lessons ───────────────────────────────────────────────────────────

test('getLessons: query ranks by keyword overlap (same matcher as loadLessonsBlock)', async () => {
  const projDir = makeProjDir('lessons-query');
  const jsonl = [
    { ts: '2026-01-01T00:00:00Z', kind: 'validator-fail', lesson: 'npm test timeout on integration suite', files: [] },
    { ts: '2026-01-02T00:00:00Z', kind: 'heal', lesson: 'git divergence required manual rebase', files: [] },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(lessonsPath(projDir), jsonl);

  const result = await getLessons(projDir, { query: 'timeout integration' });
  assert.equal(result.lessons.length, 1);
  assert.match(result.lessons[0].lesson, /timeout/);
});

test('getLessons: no query falls back to most-recent-first (never all-zero-scored)', async () => {
  const projDir = makeProjDir('lessons-recency');
  const jsonl = [
    { ts: '2026-01-01T00:00:00Z', kind: 'stall', lesson: 'older entry', files: [] },
    { ts: '2026-01-05T00:00:00Z', kind: 'stall', lesson: 'newer entry', files: [] },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(lessonsPath(projDir), jsonl);

  const result = await getLessons(projDir, {});
  assert.equal(result.lessons.length, 2);
  assert.equal(result.lessons[0].lesson, 'newer entry');
});

// ── (A) log_lesson ────────────────────────────────────────────────────────────

test('logLesson: round-trips into lessons.jsonl with kind:agent', async () => {
  const projDir = makeProjDir('log-lesson');
  const result = await logLesson(projDir, { lesson: 'MCP tool wiring needs cfg.mcp.enabled', files: ['src/claude-runner.js'] });
  assert.deepEqual(result, { ok: true });

  const raw = await fs.readFile(lessonsPath(projDir), 'utf-8');
  const entry = JSON.parse(raw.trim());
  assert.equal(entry.kind, 'agent');
  assert.equal(entry.source, 'mcp:log_lesson');
  assert.equal(entry.lesson, 'MCP tool wiring needs cfg.mcp.enabled');
  assert.deepEqual(entry.files, ['src/claude-runner.js']);
});

test('logLesson: rejects a missing/empty lesson', async () => {
  const projDir = makeProjDir('log-lesson-badarg');
  await assert.rejects(() => logLesson(projDir, { lesson: '' }), /non-empty string/);
  await assert.rejects(() => logLesson(projDir, {}), /non-empty string/);
});

test('logLesson: path-escape file argument rejects via assertInsideDir, nothing recorded', async () => {
  const projDir = makeProjDir('log-lesson-escape');
  await assert.rejects(
    () => logLesson(projDir, { lesson: 'should not be recorded', files: ['../../etc/passwd'] }),
    /escapes base directory/,
  );
  await assert.rejects(() => fs.access(lessonsPath(projDir)), /ENOENT/, 'nothing should have been written');
});

// ── (A) get_phase_ledger (Phase 38) ──────────────────────────────────────────

async function writeLedger(projDir, entries) {
  const jsonl = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await fs.writeFile(phaseLedgerPath(projDir), jsonl);
}

test('getPhaseLedger: no phase-ledger.jsonl on disk returns empty array, never throws', async () => {
  const projDir = makeProjDir('ledger-empty');
  const result = await getPhaseLedger(projDir, {});
  assert.deepEqual(result, { entries: [] });
});

test('getPhaseLedger: returns every valid entry when no range is given', async () => {
  const projDir = makeProjDir('ledger-all');
  await writeLedger(projDir, [
    { n: 1, title: 'Phase One', commit_sha: 'sha0001', bullets: ['a', 'b', 'c'] },
    { n: 2, title: 'Phase Two', commit_sha: 'sha0002', bullets: ['d', 'e', 'f'] },
  ]);
  const result = await getPhaseLedger(projDir, {});
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].n, 1);
  assert.equal(result.entries[1].n, 2);
});

test('getPhaseLedger: from_n/to_n narrow to an inclusive range', async () => {
  const projDir = makeProjDir('ledger-range');
  await writeLedger(projDir, [
    { n: 1, title: 'Phase One', commit_sha: 'sha0001', bullets: ['a', 'b', 'c'] },
    { n: 2, title: 'Phase Two', commit_sha: 'sha0002', bullets: ['d', 'e', 'f'] },
    { n: 3, title: 'Phase Three', commit_sha: 'sha0003', bullets: ['g', 'h', 'i'] },
  ]);
  const result = await getPhaseLedger(projDir, { from_n: 2, to_n: 3 });
  assert.deepEqual(result.entries.map((e) => e.n), [2, 3]);

  const onlyTwo = await getPhaseLedger(projDir, { from_n: 2, to_n: 2 });
  assert.deepEqual(onlyTwo.entries.map((e) => e.n), [2]);
});

test('getPhaseLedger: skips malformed/schema-invalid lines, same fail-open parser as loadPhaseLedgerBlock', async () => {
  const projDir = makeProjDir('ledger-invalid');
  const valid = JSON.stringify({ n: 1, title: 'Phase One', commit_sha: 'sha0001', bullets: ['a', 'b', 'c'] });
  await fs.writeFile(phaseLedgerPath(projDir), `${valid}\nnot valid json\n{"n": 2}\n`);
  const result = await getPhaseLedger(projDir, {});
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].title, 'Phase One');
});

// ── (A) get_repo_map (Phase 38) ──────────────────────────────────────────────

test('getRepoMap: no repo-map.md on disk returns found:false, never throws', async () => {
  const projDir = makeProjDir('map-empty');
  const result = await getRepoMap(projDir);
  assert.deepEqual(result, { found: false });
});

test('getRepoMap: returns found/generated_at_sha/body for a present map', async () => {
  const projDir = makeProjDir('map-present');
  const attrs = { generated_at_sha: 'deadbeef1234', generated_at: '2026-07-01T00:00:00.000Z', tool: 'repomix', approx_tokens: 10, degradation_level: 0 };
  await fs.writeFile(repoMapPath(projDir), `${renderFrontMatter(attrs)}\n\n# Directory Structure\n\`\`\`\nsrc/\n\`\`\`\n`);
  const result = await getRepoMap(projDir);
  assert.equal(result.found, true);
  assert.equal(result.generated_at_sha, 'deadbeef1234');
  assert.match(result.body, /Directory Structure/);
});

test('getRepoMap: a file with no parseable front matter returns found:false rather than throwing', async () => {
  const projDir = makeProjDir('map-nofm');
  await fs.writeFile(repoMapPath(projDir), 'not a front-matter document\n');
  const result = await getRepoMap(projDir);
  assert.deepEqual(result, { found: false });
});

// ─── (A) get_repo_map focus_paths (Phase 39 / CE-4) ─────────────────────────

test('getRepoMap: focus_paths + a matching-sha cache uses the SAME focused renderer as loadRepoMapBlock — the focused file renders in full, others degrade', async () => {
  const projDir = makeProjDir('map-focus');
  const attrs = { generated_at_sha: 'focussha1', generated_at: '2026-07-01T00:00:00.000Z', tool: 'repomix', approx_tokens: 10, degradation_level: 0 };
  await fs.writeFile(repoMapPath(projDir), `${renderFrontMatter(attrs)}\n\n# Directory Structure\n\`\`\`\nsrc/\n\`\`\`\n`);
  await fs.writeFile(repoMapCachePath(projDir), JSON.stringify({
    sha: 'focussha1',
    tree: 'src/\n  a.js\n  b.js\n',
    files: [
      { path: 'src/a.js', lang: 'javascript', content: 'export function a() {}' },
      { path: 'src/b.js', lang: 'javascript', content: 'export function b() {}' },
    ],
  }));

  const result = await getRepoMap(projDir, { focus_paths: ['src/a.js'] });
  assert.equal(result.found, true);
  assert.match(result.body, /export function a\(\) \{\}/);
  assert.doesNotMatch(result.body, /export function b\(\) \{\}/);
  assert.match(result.body, /# Exported symbols/, 'the non-focused file degrades to symbols-only');
});

test('getRepoMap: focus_paths with a stale (sha-mismatched) or missing cache falls back to the plain body — same behavior as no focus_paths (P2)', async () => {
  const projDir = makeProjDir('map-focus-stale');
  const attrs = { generated_at_sha: 'currentsha1', generated_at: '2026-07-01T00:00:00.000Z', tool: 'repomix', approx_tokens: 10, degradation_level: 0 };
  await fs.writeFile(repoMapPath(projDir), `${renderFrontMatter(attrs)}\n\n# Directory Structure\n\`\`\`\nsrc/\n\`\`\`\n`);
  await fs.writeFile(repoMapCachePath(projDir), JSON.stringify({ sha: 'stalesha0', tree: '', files: [] }));

  const withStaleCache = await getRepoMap(projDir, { focus_paths: ['src/a.js'] });
  const withoutFocus = await getRepoMap(projDir, {});
  assert.equal(withStaleCache.body, withoutFocus.body, 'stale cache falls back to the same plain body as no focus_paths at all');

  const noCacheProjDir = makeProjDir('map-focus-nocache');
  await fs.writeFile(repoMapPath(noCacheProjDir), `${renderFrontMatter(attrs)}\n\n# Directory Structure\n\`\`\`\nsrc/\n\`\`\`\n`);
  const withoutCache = await getRepoMap(noCacheProjDir, { focus_paths: ['src/a.js'] });
  assert.match(withoutCache.body, /Directory Structure/);
});

test('getRepoMap: an empty focus_paths array behaves identically to omitting it entirely', async () => {
  const projDir = makeProjDir('map-focus-empty');
  const attrs = { generated_at_sha: 'emptysha1', generated_at: '2026-07-01T00:00:00.000Z', tool: 'repomix', approx_tokens: 10, degradation_level: 0 };
  await fs.writeFile(repoMapPath(projDir), `${renderFrontMatter(attrs)}\n\n# Directory Structure\n\`\`\`\nsrc/\n\`\`\`\n`);
  const withEmpty = await getRepoMap(projDir, { focus_paths: [] });
  const withNone = await getRepoMap(projDir, {});
  assert.deepEqual(withEmpty, withNone);
});

// ── (A) ask_operator (Phase 48) ──────────────────────────────────────────────

test('askOperator: inserts an open-status row and appends a valid provisional decision to decisions.jsonl', async () => {
  const projDir = makeProjDir('ask-op-basic');
  const result = await askOperator(projDir, {
    question: 'Should the new endpoint be GET or POST?',
    assumption: 'Using POST since the call has side effects.',
    phase: 12,
  });
  assert.equal(typeof result.id, 'number');
  assert.match(result.text, /^Recorded question #\d+\. The operator has been asked asynchronously\. Proceed now using your stated assumption: Using POST since the call has side effects\.$/);

  const rows = listOperatorQuestions({ project: path.basename(projDir) });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'open');
  assert.equal(rows[0].question, 'Should the new endpoint be GET or POST?');
  assert.equal(rows[0].assumption, 'Using POST since the call has side effects.');
  assert.equal(rows[0].phase, 12);
  assert.equal(rows[0].blocking, 0);

  const jsonl = await fs.readFile(path.join(guideRoot(projDir), 'decisions.jsonl'), 'utf-8');
  const lines = jsonl.trim().split('\n');
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(validateDecision(entry), true, 'appended decision must pass validateDecision');
  assert.equal(entry.type, 'deferral');
  assert.match(entry.decision, new RegExp(`^PROVISIONAL \\(operator question #${result.id}\\): Using POST`));
});

test('askOperator: two calls produce two distinct rows and two appended decision lines', async () => {
  const projDir = makeProjDir('ask-op-two');
  const first = await askOperator(projDir, { question: 'q1', assumption: 'a1' });
  const second = await askOperator(projDir, { question: 'q2', assumption: 'a2' });
  assert.notEqual(first.id, second.id);

  const rows = listOperatorQuestions({ project: path.basename(projDir) });
  assert.equal(rows.length, 2);

  const jsonl = await fs.readFile(path.join(guideRoot(projDir), 'decisions.jsonl'), 'utf-8');
  assert.equal(jsonl.trim().split('\n').length, 2);
});

test('askOperator: blocking:true is stored on the row but the returned text is byte-identical to blocking omitted (non-blocking invariant)', async () => {
  const projDir = makeProjDir('ask-op-blocking');
  const nonBlocking = await askOperator(projDir, { question: 'q', assumption: 'proceed anyway' });
  const blocking = await askOperator(projDir, { question: 'q', assumption: 'proceed anyway', blocking: true });

  const rows = listOperatorQuestions({ project: path.basename(projDir) });
  assert.equal(rows.find((r) => r.id === nonBlocking.id).blocking, 0);
  assert.equal(rows.find((r) => r.id === blocking.id).blocking, 1);

  const nonBlockingSuffix = nonBlocking.text.replace(String(nonBlocking.id), '<id>');
  const blockingSuffix = blocking.text.replace(String(blocking.id), '<id>');
  assert.equal(nonBlockingSuffix, blockingSuffix, 'blocking:true must not change the returned text shape');
});

test('askOperator: options array is capped to 5 entries and non-string entries are dropped', async () => {
  const projDir = makeProjDir('ask-op-options');
  const result = await askOperator(projDir, {
    question: 'q', assumption: 'a', options: ['a', 'b', 'c', 'd', 'e', 'f', 42, null],
  });
  const rows = listOperatorQuestions({ project: path.basename(projDir) });
  const row = rows.find((r) => r.id === result.id);
  assert.deepEqual(JSON.parse(row.options), ['a', 'b', 'c', 'd', 'e']);
});

test('askOperator: rejects a missing/empty question or assumption', async () => {
  const projDir = makeProjDir('ask-op-badarg');
  await assert.rejects(() => askOperator(projDir, { assumption: 'a' }), /"question" is required/);
  await assert.rejects(() => askOperator(projDir, { question: 'q' }), /"assumption" is required/);
  await assert.rejects(() => askOperator(projDir, { question: '', assumption: 'a' }), /"question" is required/);
});

// ── (A) buildServer / activeToolNamesForConfig — operator_questions gating ──

test('activeToolNamesForConfig: defaults (no cfg / enabled omitted) include ask_operator; enabled:false excludes only ask_operator', () => {
  assert.ok(activeToolNamesForConfig().includes('ask_operator'));
  assert.ok(activeToolNamesForConfig({}).includes('ask_operator'));
  assert.ok(activeToolNamesForConfig({ operator_questions: { enabled: true } }).includes('ask_operator'));

  const disabled = activeToolNamesForConfig({ operator_questions: { enabled: false } });
  assert.ok(!disabled.includes('ask_operator'));
  assert.deepEqual(disabled, MCP_TOOL_NAMES.filter((n) => n !== 'ask_operator'), 'every other tool name is unaffected');
});

test('activeToolNamesForConfig: context tools require assist/enforce plus a successful current manifest/workspace binding', () => {
  const manifestId = 'a'.repeat(64);
  const workspaceDir = path.join(tmpdir(), 'bound-workspace');
  const shadow = activeToolNamesForConfig({
    context_compiler: { enabled: true, mode: 'shadow' },
    _context_compiler: { manifest_id: manifestId, mode: 'shadow', workspace_dir: workspaceDir },
  });
  assert.ok(CONTEXT_MCP_TOOL_NAMES.every((name) => !shadow.includes(name)));
  const assistWithoutManifest = activeToolNamesForConfig({ context_compiler: { enabled: true, mode: 'assist' } });
  assert.ok(CONTEXT_MCP_TOOL_NAMES.every((name) => !assistWithoutManifest.includes(name)));
  const assistWithInvalidManifest = activeToolNamesForConfig({
    context_compiler: { enabled: true, mode: 'assist' },
    _context_compiler: { manifest_id: 'latest', mode: 'assist', workspace_dir: workspaceDir, exposed: true },
  });
  assert.ok(CONTEXT_MCP_TOOL_NAMES.every((name) => !assistWithInvalidManifest.includes(name)));
  const assistUnexposed = activeToolNamesForConfig({
    context_compiler: { enabled: true, mode: 'assist' },
    _context_compiler: { manifest_id: manifestId, mode: 'assist', workspace_dir: workspaceDir, exposed: false },
  });
  assert.ok(CONTEXT_MCP_TOOL_NAMES.every((name) => !assistUnexposed.includes(name)));
  const assist = activeToolNamesForConfig({
    context_compiler: { enabled: true, mode: 'assist' },
    _context_compiler: { manifest_id: manifestId, mode: 'assist', workspace_dir: workspaceDir, exposed: true },
  });
  assert.ok(CONTEXT_MCP_TOOL_NAMES.every((name) => assist.includes(name)));
  const enforce = activeToolNamesForConfig({
    context_compiler: { enabled: true, mode: 'enforce' },
    _context_compiler: { manifest_id: manifestId, mode: 'enforce', workspace_dir: workspaceDir, exposed: true },
  });
  assert.ok(CONTEXT_MCP_TOOL_NAMES.every((name) => enforce.includes(name)));
});

test('Hybrid Context MCP handlers return bounded context, source excerpts, and test impact from an exact manifest', async () => {
  const projDir = makeProjDir('compiled-context');
  await fs.mkdir(path.join(projDir, 'workspace', 'src'), { recursive: true });
  await fs.writeFile(path.join(projDir, 'workspace', 'src', 'capture.js'), 'export function captureConsent(reply) {\n  return reply.ok;\n}\n');
  const manifest = {
    schema_version: 1,
    manifest_id: 'b'.repeat(64),
    project: path.basename(projDir),
    task_kind: 'phase', phase: 1, title: 'capture consent', base_sha: 'sha1', repo_map_sha: 'sha1',
    generated_at: new Date().toISOString(), duration_ms: 2, provider: 'hybrid-lexical', mode: 'assist', confidence: 0.9,
    token_budget: 500, injected_token_estimate: 100, warnings: [], terms: ['capture', 'consent'], explicit_paths: ['src/capture.js'],
    criteria_map: [
      { criterion_id: 'AC-1', criterion: 'Capture consent', production_symbols: [{ name: 'captureConsent', file: 'src/capture.js', line: 1 }], production_files: ['src/capture.js'], tests: ['tests/capture.test.js'], configuration: [] },
      { criterion_id: 'AC-2', criterion: 'Audit consent', production_symbols: [], production_files: ['src/audit.js'], tests: ['tests/audit.test.js'], configuration: [] },
    ],
    ranked_symbols: [{ name: 'captureConsent', file: 'src/capture.js', line: 1, signature: 'export function captureConsent(reply) {', score: 190, reasons: ['exact task symbol'] }],
    ranked_files: [{ path: 'src/capture.js', kind: 'production', score: 100, reasons: ['explicit task path'], related_tests: ['tests/capture.test.js'] }],
    relations: [{ type: 'imports', from: 'tests/capture.test.js', to: 'src/capture.js' }],
    test_plan: { targeted_files: ['tests/capture.test.js', 'tests/audit.test.js'], requires_full_suite: false, reason: 'targeted' },
    candidate_counts: { files: 2, ranked_files: 2, symbols: 1 },
  };
  await persistContextManifest(manifest);

  await assert.rejects(() => getCompiledContext(projDir, {}), /"manifest_id" is required/);
  await assert.rejects(() => queryCodeSymbols(projDir, { query: 'captureConsent' }), /"manifest_id" is required/);
  await assert.rejects(() => getTestImpact(projDir, {}), /"manifest_id" is required/);

  const compiled = await getCompiledContext(projDir, { manifest_id: manifest.manifest_id, criterion_id: 'AC-1', max_tokens: 300 });
  assert.equal(compiled.found, true);
  assert.match(compiled.context, /captureConsent/);
  const body = await queryCodeSymbols(projDir, { operation: 'body', query: 'captureConsent', manifest_id: manifest.manifest_id, max_tokens: 300 }, { paths: { workspace_subdir: 'workspace' } });
  assert.equal(body.found, true);
  assert.match(body.body, /return reply\.ok/);
  const impact = await getTestImpact(projDir, { manifest_id: manifest.manifest_id, criterion_id: 'AC-1' });
  assert.deepEqual(impact.targeted_files, ['tests/capture.test.js']);
  assert.equal(impact.requires_full_suite, false);
  assert.match(impact.reason, /criterion AC-1/);

  const laneDir = path.join(projDir, '.worktrees', 'phase-1');
  await fs.mkdir(path.join(laneDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(laneDir, 'src', 'capture.js'), 'export function captureConsent(reply) {\n  return "lane-version";\n}\n');
  const boundCfg = {
    paths: { workspace_subdir: 'workspace' },
    _context_compiler: { manifest_id: manifest.manifest_id, mode: 'assist', workspace_dir: laneDir, exposed: true },
  };
  const laneBody = await queryCodeSymbols(
    projDir,
    { operation: 'body', query: 'captureConsent', manifest_id: manifest.manifest_id, max_tokens: 300 },
    boundCfg,
  );
  assert.match(laneBody.body, /lane-version/, 'body reads must use the invocation-bound lane, not the canonical workspace');
  assert.doesNotMatch(laneBody.body, /reply\.ok/);

  const otherManifestId = 'c'.repeat(64);
  await assert.rejects(
    () => getCompiledContext(projDir, { manifest_id: otherManifestId }, boundCfg),
    /does not match the manifest bound/,
  );
  await assert.rejects(
    () => queryCodeSymbols(
      projDir,
      { operation: 'body', query: 'captureConsent', manifest_id: manifest.manifest_id },
      { ...boundCfg, _context_compiler: { ...boundCfg._context_compiler, workspace_dir: path.join(tmpdir(), 'outside-project') } },
    ),
    /escapes base directory/,
  );
});

async function connectedClient(projDir, cfg) {
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const server = buildServer(projDir, cfg);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'state-server-gating-test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test('buildServer: context schemas require manifest_id and handlers reject a different id than the invocation binding', async () => {
  const projDir = makeProjDir('context-server-binding');
  const workspaceDir = path.join(projDir, 'workspace');
  await fs.mkdir(workspaceDir, { recursive: true });
  const manifestId = 'e'.repeat(64);
  const cfg = {
    context_compiler: { enabled: true, mode: 'assist' },
    _context_compiler: { manifest_id: manifestId, mode: 'assist', workspace_dir: workspaceDir, exposed: true },
  };
  const { client } = await connectedClient(projDir, cfg);
  try {
    const { tools } = await client.listTools();
    for (const name of CONTEXT_MCP_TOOL_NAMES) {
      const def = tools.find((tool) => tool.name === name);
      assert.ok(def, `${name} must be advertised with a current binding`);
      assert.ok(def.inputSchema.required.includes('manifest_id'), `${name} must require manifest_id`);
    }

    const missing = await client.callTool({ name: 'get_compiled_context', arguments: {} });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /"manifest_id" is required/);

    const wrong = await client.callTool({
      name: 'get_test_impact',
      arguments: { manifest_id: 'f'.repeat(64) },
    });
    assert.equal(wrong.isError, true);
    assert.match(wrong.content[0].text, /does not match the manifest bound/);
  } finally {
    await client.close().catch(() => {});
  }
});

test('buildServer: with operator_questions.enabled:false, ask_operator is absent from the tool list and unreachable', async () => {
  const projDir = makeProjDir('ask-op-server-disabled');
  const { client } = await connectedClient(projDir, { operator_questions: { enabled: false } });
  try {
    const { tools } = await client.listTools();
    assert.ok(!tools.some((t) => t.name === 'ask_operator'), 'ask_operator must not be listed');
    assert.equal(tools.length, MCP_TOOL_NAMES.length - 1);

    const res = await client.callTool({ name: 'ask_operator', arguments: { question: 'q', assumption: 'a' } });
    assert.equal(res.isError, true, 'a disabled tool must reject even if called by name directly');
  } finally {
    await client.close().catch(() => {});
  }
});

test('buildServer: default cfg (operator_questions.enabled unset) lists ask_operator and serves it', async () => {
  const projDir = makeProjDir('ask-op-server-enabled');
  const { client } = await connectedClient(projDir, {});
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === 'ask_operator'));
    assert.equal(tools.length, MCP_TOOL_NAMES.length);

    const res = await client.callTool({ name: 'ask_operator', arguments: { question: 'q', assumption: 'a' } });
    const body = JSON.parse(res.content[0].text);
    assert.equal(typeof body.id, 'number');
  } finally {
    await client.close().catch(() => {});
  }
});

// ── integration: log_lesson (phase 11) → loadLessonsBlock (phase 8) ──────────

test('log_lesson integration: an MCP-recorded lesson is picked up by loadLessonsBlock on the next relevant phase injection', async () => {
  const { loadLessonsBlock } = await import('../lib/phase-runner.js');
  const projDir = makeProjDir('log-lesson-injection');

  await logLesson(projDir, {
    lesson: 'Remember to run npm run test:config after touching defaults.json',
    files: ['config/defaults.json'],
  });

  const phaseMeta = { title: 'Update defaults.json', goal: 'Adjust config', files_expected: ['config/defaults.json'] };
  const block = await loadLessonsBlock(projDir, phaseMeta, {});
  assert.ok(block, 'loadLessonsBlock must return a non-null block once the agent-logged lesson exists');
  assert.match(block, /<lessons_from_prior_failures>/);
  assert.match(block, /\[agent\]/, 'the MCP-recorded kind must render, same as the other five kinds');
  assert.match(block, /test:config/);
});

test('log_lesson integration: an unrelated phase (no file/keyword overlap) does not surface the lesson', async () => {
  const { loadLessonsBlock } = await import('../lib/phase-runner.js');
  const projDir = makeProjDir('log-lesson-norelevance');

  await logLesson(projDir, { lesson: 'Remember to run npm run test:config after touching defaults.json', files: ['config/defaults.json'] });

  const unrelatedPhaseMeta = { title: 'Unrelated telegram bot tweak', goal: 'Adjust bot copy', files_expected: ['src/server-telegram.js'] };
  const block = await loadLessonsBlock(projDir, unrelatedPhaseMeta, {});
  assert.equal(block, null, 'zero file/keyword overlap → selectRelevantLessons drops it, same scoring rule as the other five kinds');
});

// ── (B) resolveProjectDir ────────────────────────────────────────────────────

test('resolveProjectDir: resolves a real project name under PROJECTS_DIR', async () => {
  const dir = await resolveProjectDir('aorch');
  assert.equal(dir, path.join(REPO_ROOT, 'projects', 'aorch'));
});

test('resolveProjectDir: rejects a project name that escapes PROJECTS_DIR', async () => {
  await assert.rejects(() => resolveProjectDir('../../etc'), /escapes base directory/);
});

test('resolveProjectDir: rejects a missing/non-string project name', async () => {
  await assert.rejects(() => resolveProjectDir(null), /--project <name> is required/);
  await assert.rejects(() => resolveProjectDir(''), /--project <name> is required/);
});

// ── (B) real-subprocess integration test ─────────────────────────────────────

test('state-server: real subprocess — list tools, call each tool, reject a path-escape argument', async (t) => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

  const fixtureName = '_mcp_test_fixture';
  const fixtureDir = path.join(REPO_ROOT, 'projects', fixtureName);
  await fs.rm(fixtureDir, { recursive: true, force: true });
  await fs.mkdir(path.join(fixtureDir, '.guide', 'phases', '01-foo'), { recursive: true });
  await fs.writeFile(path.join(fixtureDir, '.guide', 'phases', '01-foo', 'report.md'), '# Phase 1 report\nAll good.');
  await fs.writeFile(
    path.join(fixtureDir, '.guide', 'decisions.jsonl'),
    JSON.stringify({ phase: '1', title: 'fixture decision', decision: 'use fixtures', rationale: 'test isolation', type: 'convention' }) + '\n',
  );
  await writeFixPlan(fixtureDir, 1, [{ n: 1, title: 'fixture fix', files: ['fixture.js'] }]);
  await fs.writeFile(
    lessonsPath(fixtureDir),
    JSON.stringify({ ts: '2026-01-01T00:00:00Z', kind: 'stall', lesson: 'fixture lesson about timeouts', files: [] }) + '\n',
  );
  await fs.writeFile(
    phaseLedgerPath(fixtureDir),
    JSON.stringify({ n: 1, title: 'fixture ledger phase', commit_sha: 'sha0001', bullets: ['fixture bullet one', 'fixture bullet two', 'fixture bullet three'] }) + '\n',
  );
  await fs.writeFile(
    repoMapPath(fixtureDir),
    `${renderFrontMatter({ generated_at_sha: 'fixturesha01', generated_at: '2026-01-01T00:00:00.000Z', tool: 'repomix', approx_tokens: 5, degradation_level: 0 })}\n\n# Directory Structure\n\`\`\`\nfixture/\n\`\`\`\n`,
  );
  await fs.writeFile(
    repoMapCachePath(fixtureDir),
    JSON.stringify({
      sha: 'fixturesha01',
      tree: 'fixture/\n  a.js\n  b.js\n',
      files: [
        { path: 'fixture/a.js', lang: 'javascript', content: 'export function a() {}' },
        { path: 'fixture/b.js', lang: 'javascript', content: 'export function b() {}' },
      ],
    }),
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [STATE_SERVER_PATH, '--project', fixtureName],
    cwd: REPO_ROOT,
    // Phase 48: ask_operator is the first tool in this server that touches
    // the SQLite state DB (via src/state.js) — without an explicit DB_PATH
    // the subprocess would fall through to the real state/orchestrator.db.
    // StdioClientTransport does NOT inherit the parent's full env by default.
    env: { ...process.env, DB_PATH: ':memory:' },
  });
  const client = new Client({ name: 'state-server-test-client', version: '1.0.0' });

  try {
    await client.connect(transport);

    await t.test('lists exactly the eight expected tools (operator_questions.enabled defaults to true)', async () => {
      const { tools } = await client.listTools();
      assert.deepEqual(new Set(tools.map((tl) => tl.name)), new Set(MCP_TOOL_NAMES));
      assert.equal(MCP_TOOL_NAMES.length, 8);
    });

    await t.test('get_decisions returns the fixture decision', async () => {
      const res = await client.callTool({ name: 'get_decisions', arguments: {} });
      const body = JSON.parse(res.content[0].text);
      assert.equal(body.decisions.length, 1);
      assert.equal(body.decisions[0].title, 'fixture decision');
    });

    await t.test('get_phase_report returns the fixture report', async () => {
      const res = await client.callTool({ name: 'get_phase_report', arguments: { n: 1 } });
      const body = JSON.parse(res.content[0].text);
      assert.equal(body.found, true);
      assert.match(body.report, /All good/);
    });

    await t.test('get_bug_history returns the fixture round', async () => {
      const res = await client.callTool({ name: 'get_bug_history', arguments: {} });
      const body = JSON.parse(res.content[0].text);
      assert.equal(body.rounds.length, 1);
      assert.equal(body.rounds[0].round, 1);
    });

    await t.test('get_lessons returns the fixture lesson', async () => {
      const res = await client.callTool({ name: 'get_lessons', arguments: { query: 'timeouts' } });
      const body = JSON.parse(res.content[0].text);
      assert.equal(body.lessons.length, 1);
      assert.match(body.lessons[0].lesson, /timeouts/);
    });

    await t.test('log_lesson round-trips and is visible to a follow-up get_lessons', async () => {
      const logRes = await client.callTool({ name: 'log_lesson', arguments: { lesson: 'agent-reported lesson for topic gizmo', files: [] } });
      const logBody = JSON.parse(logRes.content[0].text);
      assert.deepEqual(logBody, { ok: true });

      const getRes = await client.callTool({ name: 'get_lessons', arguments: { query: 'gizmo' } });
      const getBody = JSON.parse(getRes.content[0].text);
      assert.ok(getBody.lessons.some((l) => l.kind === 'agent' && /gizmo/.test(l.lesson)));
    });

    await t.test('get_phase_ledger returns the fixture ledger entry', async () => {
      const res = await client.callTool({ name: 'get_phase_ledger', arguments: {} });
      const body = JSON.parse(res.content[0].text);
      assert.equal(body.entries.length, 1);
      assert.equal(body.entries[0].title, 'fixture ledger phase');
    });

    await t.test('get_repo_map returns the fixture map', async () => {
      const res = await client.callTool({ name: 'get_repo_map', arguments: {} });
      const body = JSON.parse(res.content[0].text);
      assert.equal(body.found, true);
      assert.equal(body.generated_at_sha, 'fixturesha01');
      assert.match(body.body, /Directory Structure/);
    });

    await t.test('get_repo_map with focus_paths returns the focused rendering (fixture/a.js in full, fixture/b.js degraded)', async () => {
      const res = await client.callTool({ name: 'get_repo_map', arguments: { focus_paths: ['fixture/a.js'] } });
      const body = JSON.parse(res.content[0].text);
      assert.equal(body.found, true);
      assert.match(body.body, /export function a\(\) \{\}/);
      assert.doesNotMatch(body.body, /export function b\(\) \{\}/);
    });

    await t.test('ask_operator records a question over the real subprocess (operator_questions.enabled defaults to true)', async () => {
      const res = await client.callTool({ name: 'ask_operator', arguments: { question: 'fixture question?', assumption: 'fixture assumption' } });
      const body = JSON.parse(res.content[0].text);
      assert.equal(typeof body.id, 'number');
      assert.match(body.text, /fixture assumption/);
    });

    await t.test('a path-escape argument rejects via assertInsideDir, not a silent out-of-project read', async () => {
      const res = await client.callTool({ name: 'get_bug_history', arguments: { file: '/etc/passwd' } });
      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /escapes base directory/);
    });
  } finally {
    await client.close().catch(() => {});
    await fs.rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
  }
});
