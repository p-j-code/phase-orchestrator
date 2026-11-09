// Tests for brief-conformance.js (phase-47 / P4) — pure schema/decision
// logic, the deterministic prompt builder, and the runBriefConformance
// orchestration loop. No real `claude` subprocess is ever spawned — all
// runClaude interaction goes through the deps.runClaude seam, mirroring
// verify-loop.test.mjs's convention.
//
// Run with: node --test src/lib/brief-conformance.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Ajv from 'ajv';

process.env.DB_PATH = ':memory:';

const {
  buildBriefConformancePrompt, parseConformanceVerdict, decideConformance,
  renderConformanceMd, runBriefConformance, BRIEF_CONFORMANCE_ALLOWED_TOOLS,
  BRIEF_CONFORMANCE_SYSTEM_PROMPT,
} = await import('./brief-conformance.js');
const { briefConformancePath, briefConformanceMdPath, briefPath } = await import('./guide-paths.js');
const { getDb, upsertProject } = await import('../state.js');
const { briefHash } = await import('./brief-manager.js');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA = JSON.parse(readFileSync(path.join(REPO_ROOT, 'config', 'schemas', 'brief-conformance.schema.json'), 'utf-8'));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(SCHEMA);

async function makeProjectDir() {
  const projDir = mkdtempSync(path.join(tmpdir(), 'aorch-brief-conformance-'));
  await fs.mkdir(path.join(projDir, '.guide'), { recursive: true });
  await fs.mkdir(path.join(projDir, 'workspace'), { recursive: true });
  await fs.writeFile(briefPath(projDir), '# Brief\n\n## Functional requirements\n\nFR1: Do the thing.\nFR2: Do the other thing.\n', 'utf-8');
  return projDir;
}

const PLAN = { phases: [{ n: 1, title: 'Build the thing' }, { n: 2, title: 'Build the other thing' }] };

function baseRunArgs(projDir, overrides = {}) {
  return {
    cfg: {
      model: 'claude-sonnet-5',
      models: { 'brief-conformance': 'claude-sonnet-5', 'dev-execution': 'claude-sonnet-5' },
      tools: { allowed_default: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'], permission_mode: 'acceptEdits' },
      phases: { task_max_turns: { 'brief-conformance': 40 }, task_timeout_ms: { 'brief-conformance': 600000 } },
      brief_conformance: { enabled: true, block_on_missing: true, fail_open: true },
    },
    projectName: 'demo',
    projDir,
    workspaceDir: path.join(projDir, 'workspace'),
    plan: PLAN,
    ...overrides,
  };
}

const ALL_MET_JSON = JSON.stringify({
  frs: [
    { id: 'FR1', requirement: 'Do the thing.', status: 'met', evidence: ['src/thing.js:10'] },
    { id: 'FR2', requirement: 'Do the other thing.', status: 'met', evidence: ['src/other.js:5'] },
  ],
  summary: 'Both FRs are implemented.',
});

const MISSING_JSON = JSON.stringify({
  frs: [
    { id: 'FR1', requirement: 'Do the thing.', status: 'met', evidence: ['src/thing.js:10'] },
    { id: 'FR2', requirement: 'Do the other thing.', status: 'missing', notes: 'no matching code found' },
  ],
  summary: 'FR2 was not implemented.',
});

// ─── Schema fixtures ─────────────────────────────────────────────────────────

test('brief-conformance.schema.json: accepts a well-formed verdict', () => {
  const ok = validate({
    brief_hash: 'abc123',
    frs: [{ id: 'FR1', requirement: 'Do the thing.', status: 'met', evidence: ['src/thing.js:10'], notes: 'ok' }],
    summary: 'All good.',
  });
  assert.ok(ok, JSON.stringify(validate.errors));
});

test('brief-conformance.schema.json: rejects a missing "summary"', () => {
  const ok = validate({ frs: [] });
  assert.ok(!ok);
});

test('brief-conformance.schema.json: rejects an FR with an invalid status', () => {
  const ok = validate({ frs: [{ id: 'FR1', requirement: 'x', status: 'nope' }], summary: 's' });
  assert.ok(!ok);
});

test('brief-conformance.schema.json: rejects an FR missing a required field (requirement)', () => {
  const ok = validate({ frs: [{ id: 'FR1', status: 'met' }], summary: 's' });
  assert.ok(!ok);
});

test('brief-conformance.schema.json: an empty frs[] array is valid (inconclusive envelope shape)', () => {
  const ok = validate({ frs: [], summary: 'inconclusive' });
  assert.ok(ok, JSON.stringify(validate.errors));
});

// ─── parseConformanceVerdict ─────────────────────────────────────────────────

test('parseConformanceVerdict: valid JSON string parses and validates', () => {
  const parsed = parseConformanceVerdict(ALL_MET_JSON);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.verdict.frs.length, 2);
});

test('parseConformanceVerdict: invalid JSON returns errors, not a throw', () => {
  const parsed = parseConformanceVerdict('not json at all');
  assert.equal(parsed.ok, false);
  assert.ok(parsed.errors.length > 0);
});

test('parseConformanceVerdict: schema-invalid object returns errors', () => {
  const parsed = parseConformanceVerdict(JSON.stringify({ frs: [{ id: 'FR1' }] }));
  assert.equal(parsed.ok, false);
});

// ─── decideConformance (pure) ────────────────────────────────────────────────

test('decideConformance: any "missing" FR blocks', () => {
  const decision = decideConformance({ frs: [{ id: 'FR1', status: 'met' }, { id: 'FR2', status: 'missing' }], summary: 's' });
  assert.equal(decision.block, true);
  assert.equal(decision.missing.length, 1);
  assert.equal(decision.missing[0].id, 'FR2');
});

test('decideConformance: "partial" FRs never block on their own, but are surfaced', () => {
  const decision = decideConformance({ frs: [{ id: 'FR1', status: 'met' }, { id: 'FR2', status: 'partial' }], summary: 's' });
  assert.equal(decision.block, false);
  assert.equal(decision.partial.length, 1);
});

test('decideConformance: all "met" never blocks', () => {
  const decision = decideConformance({ frs: [{ id: 'FR1', status: 'met' }], summary: 's' });
  assert.equal(decision.block, false);
  assert.equal(decision.missing.length, 0);
  assert.equal(decision.partial.length, 0);
});

test('decideConformance: a null verdict (inconclusive) honors fail_open — default true does not block', () => {
  const decision = decideConformance(null);
  assert.equal(decision.inconclusive, true);
  assert.equal(decision.block, false);
});

test('decideConformance: a null verdict (inconclusive) blocks when fail_open is false', () => {
  const decision = decideConformance(null, { failOpen: false });
  assert.equal(decision.inconclusive, true);
  assert.equal(decision.block, true);
});

test('decideConformance: a persisted "_status: inconclusive" envelope behaves identically to a null verdict', () => {
  const decision = decideConformance({ _status: 'inconclusive', frs: [], summary: 'x' }, { failOpen: false });
  assert.equal(decision.inconclusive, true);
  assert.equal(decision.block, true);
});

// ─── Tool sandbox ────────────────────────────────────────────────────────────

test('BRIEF_CONFORMANCE_ALLOWED_TOOLS: no Write, no Edit, no unrestricted Bash', () => {
  assert.ok(!BRIEF_CONFORMANCE_ALLOWED_TOOLS.includes('Write'));
  assert.ok(!BRIEF_CONFORMANCE_ALLOWED_TOOLS.includes('Edit'));
  assert.ok(!BRIEF_CONFORMANCE_ALLOWED_TOOLS.includes('Bash'));
  assert.ok(BRIEF_CONFORMANCE_ALLOWED_TOOLS.includes('Read'));
  assert.ok(BRIEF_CONFORMANCE_ALLOWED_TOOLS.every((t) => t === 'Bash' ? false : true));
});

test('BRIEF_CONFORMANCE_SYSTEM_PROMPT: static literal, byte-identical across reads (no interpolation)', () => {
  assert.equal(BRIEF_CONFORMANCE_SYSTEM_PROMPT, BRIEF_CONFORMANCE_SYSTEM_PROMPT);
  assert.ok(BRIEF_CONFORMANCE_SYSTEM_PROMPT.includes('fresh'));
  assert.ok(!BRIEF_CONFORMANCE_SYSTEM_PROMPT.includes('${'));
});

// ─── buildBriefConformancePrompt: purity / byte-identity ────────────────────

test('buildBriefConformancePrompt: byte-identical across calls for unchanged inputs', () => {
  const args = { briefText: '# Brief\n\nFR1: thing.', planSummary: '- Phase 1: x [completed]', reportPointers: ['phases/01-x/report.md'] };
  const a = buildBriefConformancePrompt(args);
  const b = buildBriefConformancePrompt({ ...args });
  assert.equal(a, b);
});

test('buildBriefConformancePrompt: includes the brief text and plan summary verbatim', () => {
  const prompt = buildBriefConformancePrompt({ briefText: 'FR1: unique-marker-xyz.', planSummary: '- Phase 1: unique-phase-title', reportPointers: [] });
  assert.ok(prompt.includes('unique-marker-xyz'));
  assert.ok(prompt.includes('unique-phase-title'));
});

// ─── runBriefConformance ─────────────────────────────────────────────────────

test('runBriefConformance: first call carries sessionId:null, role:null, systemPromptFile:null, task "brief-conformance", restricted tools, and the configured model', async () => {
  const projDir = await makeProjectDir();
  const calls = [];
  const deps = { runClaude: async (opts) => { calls.push(opts); return { result: ALL_MET_JSON, session_id: 'sess-1', is_error: false }; } };

  const outcome = await runBriefConformance(baseRunArgs(projDir), deps);

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.sessionId, null);
  assert.equal(call.role, null);
  assert.equal(call.systemPromptFile, null);
  assert.equal(call.task, 'brief-conformance');
  assert.equal(call.cfg.model, 'claude-sonnet-5');

  const tools = call.cfg.tools.allowed_default;
  assert.deepEqual([...tools], [...BRIEF_CONFORMANCE_ALLOWED_TOOLS]);
  assert.ok(!tools.includes('Write'));
  assert.ok(!tools.includes('Edit'));

  assert.equal(outcome.status, 'checked');
  assert.equal(outcome.decision.block, false);
});

test('runBriefConformance: persists .guide/brief-conformance.json + .md with the brief_hash stamped', async () => {
  const projDir = await makeProjectDir();
  const deps = { runClaude: async () => ({ result: ALL_MET_JSON, session_id: 'sess-1', is_error: false }) };

  await runBriefConformance(baseRunArgs(projDir), deps);

  const jsonRaw = await fs.readFile(briefConformancePath(projDir), 'utf-8');
  const persisted = JSON.parse(jsonRaw);
  const expectedHash = await briefHash(briefPath(projDir));
  assert.equal(persisted.brief_hash, expectedHash);
  assert.equal(persisted._status, 'checked');

  const md = await fs.readFile(briefConformanceMdPath(projDir), 'utf-8');
  assert.match(md, /Brief conformance check/);
  assert.match(md, /PASS/);
});

test('runBriefConformance: a missing-FR verdict inserts one deduped bug_inbox row per missing FR, across two runs', async () => {
  const projDir = await makeProjectDir();
  upsertProject({ name: 'demo-dedup', tech_stack: 'node' });
  const deps = { runClaude: async () => ({ result: MISSING_JSON, session_id: 'sess-1', is_error: false }) };

  const args = baseRunArgs(projDir, { projectName: 'demo-dedup' });
  const outcome1 = await runBriefConformance(args, deps);
  assert.equal(outcome1.decision.block, true);
  assert.equal(outcome1.decision.missing.length, 1);

  const countBugs = () => getDb().prepare(
    `SELECT COUNT(*) AS n FROM bug_inbox WHERE project = 'demo-dedup' AND source = 'brief-conformance'`,
  ).get().n;
  assert.equal(countBugs(), 1);

  // Second run over the SAME (unchanged) verdict content — must not duplicate.
  await runBriefConformance(args, deps);
  assert.equal(countBugs(), 1, 'still exactly one brief-conformance bug after the second run (deduped)');
});

test('runBriefConformance: block_on_missing:false suppresses the bug_inbox insertion', async () => {
  const projDir = await makeProjectDir();
  upsertProject({ name: 'demo-no-block', tech_stack: 'node' });
  const deps = { runClaude: async () => ({ result: MISSING_JSON, session_id: 'sess-1', is_error: false }) };

  const args = baseRunArgs(projDir, {
    projectName: 'demo-no-block',
    cfg: { ...baseRunArgs(projDir).cfg, brief_conformance: { enabled: true, block_on_missing: false, fail_open: true } },
  });
  await runBriefConformance(args, deps);

  const n = getDb().prepare(`SELECT COUNT(*) AS n FROM bug_inbox WHERE project = 'demo-no-block' AND source = 'brief-conformance'`).get().n;
  assert.equal(n, 0);
});

test('runBriefConformance: invalid verdict JSON triggers exactly one re-ask resuming the checker session; recovering on the re-ask succeeds', async () => {
  const projDir = await makeProjectDir();
  const calls = [];
  const deps = {
    runClaude: async (opts) => {
      calls.push(opts);
      if (calls.length === 1) return { result: 'this is not json', session_id: 'sess-checker-1', is_error: false };
      return { result: ALL_MET_JSON, session_id: 'sess-checker-1', is_error: false };
    },
  };

  const outcome = await runBriefConformance(baseRunArgs(projDir), deps);

  assert.equal(calls.length, 2, 'exactly one re-ask (two total calls)');
  assert.equal(calls[0].sessionId, null);
  assert.equal(calls[1].sessionId, 'sess-checker-1', 're-ask resumes the SAME checker session');
  assert.equal(calls[1].role, null);
  assert.equal(outcome.status, 'checked');
});

test('runBriefConformance: a runClaude spawn failure persists an "inconclusive" verdict rather than throwing', async () => {
  const projDir = await makeProjectDir();
  const deps = { runClaude: async () => { throw new Error('claude subprocess stalled — no output for 5m'); } };

  const outcome = await runBriefConformance(baseRunArgs(projDir), deps);
  assert.equal(outcome.status, 'inconclusive');
  assert.equal(outcome.decision.inconclusive, true);
  assert.equal(outcome.decision.block, false, 'fail_open:true (default) does not block on inconclusive');

  const persisted = JSON.parse(await fs.readFile(briefConformancePath(projDir), 'utf-8'));
  assert.equal(persisted._status, 'inconclusive');
});

test('runBriefConformance: double-invalid JSON (re-ask also fails) persists "inconclusive", honoring fail_open:false', async () => {
  const projDir = await makeProjectDir();
  const deps = { runClaude: async () => ({ result: 'still not json', session_id: 'sess-1', is_error: false }) };

  const args = baseRunArgs(projDir, {
    cfg: { ...baseRunArgs(projDir).cfg, brief_conformance: { enabled: true, block_on_missing: true, fail_open: false } },
  });
  const outcome = await runBriefConformance(args, deps);
  assert.equal(outcome.status, 'inconclusive');
  assert.equal(outcome.decision.block, true, 'fail_open:false blocks on inconclusive');
});
