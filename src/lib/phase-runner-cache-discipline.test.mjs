// Prompt-cache discipline (P1): every prompt builder that feeds
// systemPromptExtra (or the per-phase/per-fix user prompt) must return
// byte-identical output across calls when its inputs are unchanged.
// systemPromptExtra is appended to the CLI's system prompt
// (claude -p --append-system-prompt) — if that string differs call to call
// for the same underlying project state, Anthropic's automatic prompt cache
// is silently invalidated on every run.
//
// Run with: node --test src/lib/phase-runner-cache-discipline.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DB_PATH = ':memory:';

const {
  loadProjectContextBlock,
  loadMostRecentHandoffBlock,
  loadDecisionsBlock,
  loadSuggestionsBlock,
  buildInlinePhasePrompt,
  buildInlineFixPrompt,
  MCP_DECISIONS_POINTER_BLOCK,
  shouldInjectRepoMap,
  loadRepoMapBlock,
  loadContextDeltaBlock,
  buildLightReviewPrompt,
  buildReviewLensPrompt,
  REVIEW_LENS_SECURITY_SYSTEM_PROMPT,
  REVIEW_LENS_CONSISTENCY_SYSTEM_PROMPT,
  REVIEW_LENS_ALLOWED_TOOLS,
  loadPhaseLedgerBlock,
  MCP_REPO_MAP_POINTER_BLOCK,
  resolveDevRepoMapContext,
  buildFixLessonMeta,
  loadLessonsBlock,
} = await import('./phase-runner.js');
const { loadBriefConstraintsBlock } = await import('./brief-manager.js');
const { recordLesson } = await import('./lessons.js');
const { projectConventionsPath } = await import('./guide-paths.js');

function makeProjDir(label) {
  const d = mkdtempSync(path.join(tmpdir(), `aorch-cache-discipline-${label}-`));
  mkdirSync(path.join(d, '.guide'), { recursive: true });
  return d;
}

// ── Byte-identical output for unchanged inputs ───────────────────────────────

test('loadProjectContextBlock: byte-identical across calls for unchanged inputs', async () => {
  const projDir = makeProjDir('ctx');
  writeFileSync(path.join(projDir, '.guide', 'project-context.md'), '# Domain\nB2B SaaS for jewellers.\n');
  const a = await loadProjectContextBlock(projDir);
  const b = await loadProjectContextBlock(projDir);
  assert.equal(a, b);
  assert.ok(a && a.length > 0);
});

// Phase 22 (brief P3, front-matter-leak fix): project-context.md carries
// phase-17's stamped `generated_at_sha`/`generated_at` front-matter after any
// project-context-gen call — that's orchestrator bookkeeping for
// contextDelta's sinceSha, never meant to reach the guide/dev prompt. Before
// this fix, loadProjectContextBlock injected the raw file including the
// front-matter block verbatim.
test('loadProjectContextBlock: strips phase-17 stamp front-matter — the injected block never contains generated_at_sha:/generated_at: lines', async () => {
  const projDir = makeProjDir('ctx-stamped');
  writeFileSync(
    path.join(projDir, '.guide', 'project-context.md'),
    '---\ngenerated_at_sha: deadbeef1234\ngenerated_at: 2026-07-01T00:00:00.000Z\n---\n\n# Domain\nB2B SaaS for jewellers.\n',
  );
  const block = await loadProjectContextBlock(projDir);
  assert.ok(block.includes('<project_context>'));
  assert.ok(block.includes('B2B SaaS for jewellers.'), 'the real body must still be injected');
  assert.ok(!block.includes('generated_at_sha:'), 'front-matter key must not leak into the prompt block');
  assert.ok(!block.includes('generated_at:'), 'front-matter key must not leak into the prompt block');
  assert.ok(!block.includes('deadbeef1234'), 'the stamped sha value itself must not leak either');
});

test('loadProjectContextBlock: a legacy artifact with no front-matter (never stamped) still injects its full body unchanged', async () => {
  const projDir = makeProjDir('ctx-legacy');
  writeFileSync(path.join(projDir, '.guide', 'project-context.md'), '# Domain\nB2B SaaS for jewellers.\n');
  const block = await loadProjectContextBlock(projDir);
  assert.ok(block.includes('# Domain\nB2B SaaS for jewellers.'));
});

test('loadBriefConstraintsBlock: byte-identical across calls for unchanged inputs', async () => {
  const projDir = makeProjDir('brief');
  writeFileSync(
    path.join(projDir, '.guide', 'brief.md'),
    '# Brief\n\n## Non-functional requirements\n- Must be fast\n\n## Conventions to follow\n- Use path.join\n',
  );
  // Two structurally-equal but distinct plan objects — simulates two separate
  // orchestrator invocations reading the same on-disk state, not the same
  // in-memory reference.
  const a = await loadBriefConstraintsBlock(projDir, { phases: [] });
  const b = await loadBriefConstraintsBlock(projDir, { phases: [] });
  assert.equal(a, b);
  assert.ok(a && a.includes('<brief_constraints>'));
});

test('loadDecisionsBlock: byte-identical across calls for unchanged inputs', async () => {
  const projDir = makeProjDir('dec');
  const entry = {
    phase: '1', title: 'error shape', decision: 'Use a JSON error envelope',
    rationale: 'stable clients branch on a fixed shape', type: 'convention',
  };
  writeFileSync(path.join(projDir, '.guide', 'decisions.jsonl'), JSON.stringify(entry) + '\n');
  const a = await loadDecisionsBlock(projDir);
  const b = await loadDecisionsBlock(projDir);
  assert.equal(a, b);
  assert.ok(a && a.includes('<decisions_log>'));
});

// ─── loadPhaseLedgerBlock (Phase 37 / CE-1) ─────────────────────────────────

test('loadPhaseLedgerBlock: returns null for a missing/empty ledger file', async () => {
  const projDir = makeProjDir('ledger-missing');
  assert.equal(await loadPhaseLedgerBlock(projDir), null);

  writeFileSync(path.join(projDir, '.guide', 'phase-ledger.jsonl'), '');
  assert.equal(await loadPhaseLedgerBlock(projDir), null);
});

test('loadPhaseLedgerBlock: byte-identical across calls for unchanged inputs', async () => {
  const projDir = makeProjDir('ledger');
  const entry = { n: 1, title: 'Phase Ledger', commit_sha: 'deadbeef1234', bullets: ['one', 'two', 'three'] };
  writeFileSync(path.join(projDir, '.guide', 'phase-ledger.jsonl'), JSON.stringify(entry) + '\n');
  const a = await loadPhaseLedgerBlock(projDir);
  const b = await loadPhaseLedgerBlock(projDir);
  assert.equal(a, b);
  assert.ok(a && a.includes('<phase_ledger>') && a.includes('Phase Ledger'));
});

test('loadPhaseLedgerBlock: renders only the last maxEntries entries', async () => {
  const projDir = makeProjDir('ledger-cap');
  const lines = [1, 2, 3].map((n) => JSON.stringify({ n, title: `Phase ${n}`, commit_sha: `sha${n}`, bullets: ['a', 'b', 'c'] }));
  writeFileSync(path.join(projDir, '.guide', 'phase-ledger.jsonl'), lines.join('\n') + '\n');
  const block = await loadPhaseLedgerBlock(projDir, 1);
  assert.ok(block.includes('Phase 3'));
  assert.ok(!block.includes('Phase 1'));
  assert.ok(!block.includes('Phase 2'));
});

// Phase 11: runDev() composes devSystemPromptExtra as
// `[briefCtx, ctxExtra, decisionsCtx, lessonsCtx].filter(Boolean).join('\n\n')`,
// where `decisionsCtx = cfg.mcp?.enabled ? MCP_DECISIONS_POINTER_BLOCK :
// await loadDecisionsBlock(projDir)`. Mirrored here (same "shadow
// reimplementation" pattern the phase-8 devSystemPromptExtra composition test
// in lessons.test.mjs uses) since exercising the real runDev() needs a full
// git/DB/workspace fixture.
test('devSystemPromptExtra composition: cfg.mcp.enabled swaps the decisions log for a 3-line MCP pointer; the brief block is unchanged and still present either way', async () => {
  const projDir = makeProjDir('mcp-pointer');
  writeFileSync(
    path.join(projDir, '.guide', 'brief.md'),
    '# Brief\n\n## Non-functional requirements\n- Must be fast\n',
  );
  const entry = {
    phase: '3', title: 'gate TTL', decision: 'Brief-append confirm TTL is 5 minutes',
    rationale: 'expiry default', type: 'constraint',
  };
  writeFileSync(path.join(projDir, '.guide', 'decisions.jsonl'), JSON.stringify(entry) + '\n');

  const briefCtx = await loadBriefConstraintsBlock(projDir, { phases: [] });
  const composeDevPromptExtra = async (cfg) => {
    const decisionsCtx = cfg.mcp?.enabled ? MCP_DECISIONS_POINTER_BLOCK : await loadDecisionsBlock(projDir);
    return [briefCtx, decisionsCtx].filter(Boolean).join('\n\n');
  };

  const disabled = await composeDevPromptExtra({});
  assert.ok(disabled.includes('<brief_constraints>') && disabled.includes('Must be fast'), 'brief block present when mcp disabled');
  assert.ok(disabled.includes('gate TTL'), 'mcp disabled (default) — full decisions log renders as before');

  const enabled = await composeDevPromptExtra({ mcp: { enabled: true } });
  assert.ok(enabled.includes('<brief_constraints>') && enabled.includes('Must be fast'), 'brief block unchanged and still present when mcp enabled');
  assert.ok(!enabled.includes('gate TTL'), 'mcp enabled — the decision text itself must not appear inline');
  assert.ok(enabled.includes('get_decisions'), 'mcp enabled — pointer names the tool to call instead');
  assert.equal(MCP_DECISIONS_POINTER_BLOCK.split('\n').length, 3, 'the pointer block itself is exactly 3 lines');
});

test('loadMostRecentHandoffBlock: byte-identical across calls for unchanged inputs', async () => {
  const projDir = makeProjDir('handoff');
  mkdirSync(path.join(projDir, '.guide', 'handoffs'), { recursive: true });
  writeFileSync(path.join(projDir, '.guide', 'handoffs', 'h1.md'), 'State: phase 3 complete.');
  const a = await loadMostRecentHandoffBlock(projDir);
  const b = await loadMostRecentHandoffBlock(projDir);
  assert.equal(a, b);
  assert.ok(a && a.includes('<previous_handoff>'));
});

test('loadSuggestionsBlock: byte-identical across calls for unchanged inputs', async () => {
  const projDir = makeProjDir('sug');
  writeFileSync(path.join(projDir, '.guide', 'suggestions.md'), '## Pass 1\n- Add rate limiting\n- Add retry backoff\n');
  // projectName=null bypasses the DB accepted-plan gate (matches the pattern
  // already used in phase-runner-injection.test.mjs).
  const a = await loadSuggestionsBlock(projDir, 1, null);
  const b = await loadSuggestionsBlock(projDir, 1, null);
  assert.equal(a, b);
  assert.ok(a && a.includes('<suggestions_plan'));
});

test('buildInlinePhasePrompt: byte-identical across calls for unchanged inputs', () => {
  const projDir = makeProjDir('phase');
  const workspaceDir = path.join(projDir, 'workspace');
  const phaseMeta = {
    n: 5, title: 'FVU file builder', goal: 'Build the NSDL FVU export.',
    acceptance_criteria: ['Generates a valid FVU file', 'Rejects malformed challans'],
    files_expected: ['backend/services/fvuBuilder.js'],
    notes: 'Reuse the existing challan parser.',
  };
  const a = buildInlinePhasePrompt({
    projectName: 'demo', phaseMeta, plan: { phases: [phaseMeta] }, projDir, workspaceDir,
  });
  // Fresh object literals with the same values — not the same references.
  const b = buildInlinePhasePrompt({
    projectName: 'demo',
    phaseMeta: { ...phaseMeta, acceptance_criteria: [...phaseMeta.acceptance_criteria], files_expected: [...phaseMeta.files_expected] },
    plan: { phases: [{ ...phaseMeta }] },
    projDir, workspaceDir,
  });
  assert.equal(a, b);
  assert.ok(a.includes('# Phase 5'));
});

// MI-3 / QL-7: both inline prompt builders append a "Definition of done"
// block naming the exact self-assessment table shape
// parseCriteriaSelfAssessment expects — checked here alongside the existing
// byte-identity assertions so the two features can never silently drift out
// of the same prompt.
test('buildInlinePhasePrompt: includes a "Definition of done" block naming the criteria self-assessment table format', () => {
  const projDir = makeProjDir('phase-dod');
  const workspaceDir = path.join(projDir, 'workspace');
  const phaseMeta = {
    n: 5, title: 'FVU file builder', goal: 'Build the NSDL FVU export.',
    acceptance_criteria: ['Generates a valid FVU file', 'Rejects malformed challans'],
    files_expected: ['backend/services/fvuBuilder.js'],
  };
  const prompt = buildInlinePhasePrompt({ projectName: 'demo', phaseMeta, plan: { phases: [phaseMeta] }, projDir, workspaceDir });
  assert.match(prompt, /## Definition of done/);
  assert.match(prompt, /Acceptance criteria self-assessment/);
  assert.match(prompt, /\| Criterion \| Status \| Evidence \(file:line\) \| Confidence \|/);
  assert.ok(prompt.includes('Generates a valid FVU file'), 'the example row uses the phase\'s own first criterion');
});

test('buildInlineFixPrompt: byte-identical across calls for unchanged inputs', () => {
  const projDir = makeProjDir('fix');
  const workspaceDir = path.join(projDir, 'workspace');
  const fix = { round: 2, n: 3, title: 'Upload security' };
  const fixMeta = { n: 3, title: 'Upload security', bug_ids: [7, 8], files: ['backend/controllers/uploadController.js'] };
  const a = buildInlineFixPrompt({ projectName: 'demo', fix, fixMeta, projDir, workspaceDir, plan: { phases: [] } });
  const b = buildInlineFixPrompt({
    projectName: 'demo', fix: { ...fix }, fixMeta: JSON.parse(JSON.stringify(fixMeta)),
    projDir, workspaceDir, plan: { phases: [] },
  });
  assert.equal(a, b);
  assert.ok(a.includes('# Fix r2-3'));
});

test('buildInlineFixPrompt: also includes the "Definition of done" block (fixes get the same self-assessment contract as phases)', () => {
  const projDir = makeProjDir('fix-dod');
  const workspaceDir = path.join(projDir, 'workspace');
  const fix = { round: 2, n: 3, title: 'Upload security' };
  const fixMeta = { n: 3, title: 'Upload security', bug_ids: [7, 8], files: ['backend/controllers/uploadController.js'] };
  const prompt = buildInlineFixPrompt({ projectName: 'demo', fix, fixMeta, projDir, workspaceDir, plan: { phases: [] } });
  assert.match(prompt, /## Definition of done/);
  assert.match(prompt, /Acceptance criteria self-assessment/);
});

// ── Phase 41 (CE-9): source-audit pointer line in the inline fix prompt ───────

test('buildInlineFixPrompt: WITHOUT sourceAuditRel is byte-identical to the pre-phase output (fail-open — absent pointer changes nothing)', () => {
  const projDir = makeProjDir('fix-noaudit');
  const workspaceDir = path.join(projDir, 'workspace');
  const fix = { round: 2, n: 3, title: 'Upload security' };
  const fixMeta = { n: 3, title: 'Upload security', bug_ids: [7, 8], files: ['backend/controllers/uploadController.js'] };
  // Passing sourceAuditRel:null (or omitting it) must yield the same string, and
  // that string must not contain the source-audit read-list line at all.
  const omitted = buildInlineFixPrompt({ projectName: 'demo', fix, fixMeta, projDir, workspaceDir, plan: { phases: [] } });
  const nulled = buildInlineFixPrompt({ projectName: 'demo', fix, fixMeta, projDir, workspaceDir, plan: { phases: [] }, sourceAuditRel: null });
  assert.equal(omitted, nulled);
  assert.ok(!omitted.includes('SOURCE audit finding'), 'no source-audit line when the pointer is absent');
});

test('buildInlineFixPrompt: WITH sourceAuditRel adds exactly ONE read-list line, and is byte-identical across calls for the same pointer', () => {
  const projDir = makeProjDir('fix-audit');
  const workspaceDir = path.join(projDir, 'workspace');
  const fix = { round: 2, n: 3, title: 'Upload security' };
  const fixMeta = { n: 3, title: 'Upload security', bug_ids: [7, 8], files: ['backend/controllers/uploadController.js'] };
  const rel = '../.guide/audits/audit-2026-07-08.md';
  const a = buildInlineFixPrompt({ projectName: 'demo', fix, fixMeta, projDir, workspaceDir, plan: { phases: [] }, sourceAuditRel: rel });
  const b = buildInlineFixPrompt({ projectName: 'demo', fix: { ...fix }, fixMeta: JSON.parse(JSON.stringify(fixMeta)), projDir, workspaceDir, plan: { phases: [] }, sourceAuditRel: rel });
  assert.equal(a, b, 'byte-identical for the same pointer');
  // Exactly one added line, and it names the pointer path.
  const withoutPtr = buildInlineFixPrompt({ projectName: 'demo', fix, fixMeta, projDir, workspaceDir, plan: { phases: [] } });
  assert.equal(a.split('\n').length, withoutPtr.split('\n').length + 1, 'exactly one extra line');
  assert.ok(a.includes(`- ${rel} — the SOURCE audit finding(s)`), 'the added line points at the source audit');
});

// ── Phase 42: hasConventions read-list line (both inline prompt builders) ─────
// runDev checks .guide/project-conventions.md's existence ONCE and passes it as
// an input — existence is an input, not an internal fs read, so both builders
// stay pure/sync and byte-stable is testable both ways (present vs absent).

test('buildInlinePhasePrompt: hasConventions omitted/false is byte-identical to the pre-phase output (no line added)', () => {
  const projDir = makeProjDir('phase-noconv');
  const workspaceDir = path.join(projDir, 'workspace');
  const phaseMeta = {
    n: 5, title: 'FVU file builder', goal: 'Build the NSDL FVU export.',
    acceptance_criteria: ['Generates a valid FVU file'],
    files_expected: ['backend/services/fvuBuilder.js'],
  };
  const omitted = buildInlinePhasePrompt({ projectName: 'demo', phaseMeta, plan: { phases: [phaseMeta] }, projDir, workspaceDir });
  const falsed = buildInlinePhasePrompt({ projectName: 'demo', phaseMeta, plan: { phases: [phaseMeta] }, projDir, workspaceDir, hasConventions: false });
  assert.equal(omitted, falsed);
  assert.ok(!omitted.includes('project-conventions.md'), 'no conventions line when hasConventions is false/omitted');
});

test('buildInlinePhasePrompt: hasConventions:true adds exactly ONE read-list line, byte-identical across calls for the same input', () => {
  const projDir = makeProjDir('phase-conv');
  const workspaceDir = path.join(projDir, 'workspace');
  const phaseMeta = {
    n: 5, title: 'FVU file builder', goal: 'Build the NSDL FVU export.',
    acceptance_criteria: ['Generates a valid FVU file'],
    files_expected: ['backend/services/fvuBuilder.js'],
  };
  const a = buildInlinePhasePrompt({ projectName: 'demo', phaseMeta, plan: { phases: [phaseMeta] }, projDir, workspaceDir, hasConventions: true });
  const b = buildInlinePhasePrompt({ projectName: 'demo', phaseMeta: { ...phaseMeta }, plan: { phases: [phaseMeta] }, projDir, workspaceDir, hasConventions: true });
  assert.equal(a, b);
  const withoutConv = buildInlinePhasePrompt({ projectName: 'demo', phaseMeta, plan: { phases: [phaseMeta] }, projDir, workspaceDir });
  assert.equal(a.split('\n').length, withoutConv.split('\n').length + 1, 'exactly one extra line');
  assert.ok(a.includes('- ../.guide/project-conventions.md — durable decisions/conventions'), 'the added line points at the conventions file');
});

test('buildInlineFixPrompt: hasConventions omitted/false is byte-identical to the pre-phase output (no line added)', () => {
  const projDir = makeProjDir('fix-noconv');
  const workspaceDir = path.join(projDir, 'workspace');
  const fix = { round: 2, n: 3, title: 'Upload security' };
  const fixMeta = { n: 3, title: 'Upload security', bug_ids: [7, 8], files: ['backend/controllers/uploadController.js'] };
  const omitted = buildInlineFixPrompt({ projectName: 'demo', fix, fixMeta, projDir, workspaceDir, plan: { phases: [] } });
  const falsed = buildInlineFixPrompt({ projectName: 'demo', fix, fixMeta, projDir, workspaceDir, plan: { phases: [] }, hasConventions: false });
  assert.equal(omitted, falsed);
  assert.ok(!omitted.includes('project-conventions.md'));
});

test('buildInlineFixPrompt: hasConventions:true adds exactly ONE read-list line, byte-identical across calls, composes with sourceAuditRel', () => {
  const projDir = makeProjDir('fix-conv');
  const workspaceDir = path.join(projDir, 'workspace');
  const fix = { round: 2, n: 3, title: 'Upload security' };
  const fixMeta = { n: 3, title: 'Upload security', bug_ids: [7, 8], files: ['backend/controllers/uploadController.js'] };
  const a = buildInlineFixPrompt({ projectName: 'demo', fix, fixMeta, projDir, workspaceDir, plan: { phases: [] }, hasConventions: true });
  const b = buildInlineFixPrompt({ projectName: 'demo', fix: { ...fix }, fixMeta: JSON.parse(JSON.stringify(fixMeta)), projDir, workspaceDir, plan: { phases: [] }, hasConventions: true });
  assert.equal(a, b);
  const withoutConv = buildInlineFixPrompt({ projectName: 'demo', fix, fixMeta, projDir, workspaceDir, plan: { phases: [] } });
  assert.equal(a.split('\n').length, withoutConv.split('\n').length + 1, 'exactly one extra line');
  assert.ok(a.includes('- ../.guide/project-conventions.md — durable decisions/conventions'));

  // Composes with the source-audit pointer — both optional lines together.
  const rel = '../.guide/audits/audit-2026-07-08.md';
  const both = buildInlineFixPrompt({ projectName: 'demo', fix, fixMeta, projDir, workspaceDir, plan: { phases: [] }, hasConventions: true, sourceAuditRel: rel });
  assert.equal(both.split('\n').length, withoutConv.split('\n').length + 2, 'both optional lines present adds exactly two lines');
  assert.ok(both.includes('project-conventions.md') && both.includes('SOURCE audit finding'));
});

// ── Phase 42: loadLessonsBlock omits the DISTILLED section when the ───────────
// conventions file exists (relevant RAW lessons stay inline regardless), and
// conventions_file.enabled:false always reverts to pre-phase-42 behavior.

test('loadLessonsBlock: project-conventions.md present → distilled section omitted, relevant raw lessons still injected', async () => {
  const projDir = makeProjDir('lessons-conv-present');
  writeFileSync(path.join(projDir, '.guide', 'lessons-distilled.md'), '- Old pattern: never trust unsanitised agent input.\n');
  mkdirSync(path.dirname(projectConventionsPath(projDir)), { recursive: true });
  writeFileSync(projectConventionsPath(projDir), '# Project Conventions\n');
  await recordLesson(projDir, { kind: 'heal', phase: 5, source: 'test', lesson: 'Guard the FVU builder against malformed challans', files: ['backend/services/fvuBuilder.js'] });

  const phaseMeta = { title: 'FVU builder', goal: '', files_expected: ['backend/services/fvuBuilder.js'] };
  const block = await loadLessonsBlock(projDir, phaseMeta, { lessons: { enabled: true } });
  assert.ok(block, 'raw lesson still triggers a block');
  assert.ok(!block.includes('Distilled patterns from earlier rounds'), 'distilled section omitted when the conventions file exists');
  assert.ok(block.includes('Guard the FVU builder'), 'relevant raw lesson stays inline regardless');
});

test('loadLessonsBlock: conventions_file.enabled:false reverts to pre-phase-42 behavior byte-for-byte, even if the file exists on disk', async () => {
  const projDir = makeProjDir('lessons-conv-disabled');
  writeFileSync(path.join(projDir, '.guide', 'lessons-distilled.md'), '- Old pattern: never trust unsanitised agent input.\n');
  mkdirSync(path.dirname(projectConventionsPath(projDir)), { recursive: true });
  writeFileSync(projectConventionsPath(projDir), '# Project Conventions\n');

  const withFlagOff = await loadLessonsBlock(projDir, null, { lessons: { enabled: true }, conventions_file: { enabled: false } });
  assert.ok(withFlagOff.includes('Distilled patterns from earlier rounds'), 'flag off — distilled section renders regardless of the file on disk');

  // Sanity: with the flag on (default) and no raw lessons.jsonl entries, the
  // distilled section is genuinely gone (not just hidden) — the whole block
  // collapses to null, exactly like a project with neither source at all.
  const withFlagOn = await loadLessonsBlock(projDir, null, { lessons: { enabled: true } });
  assert.equal(withFlagOn, null);
});

// ── Phase 41 (QL-8): fix-path lessons injection via buildFixLessonMeta ─────────
// The core of the fix-context-parity fix: runDev now feeds loadLessonsBlock a
// fix pseudo-meta (files from the round-plan entry) instead of null. With a
// matching-file lesson on disk, the fix meta injects it; null (today's fix
// behaviour) injects nothing.

test('buildFixLessonMeta: derives files_expected from the raw fix-plan field (both `files` and `files_likely`)', () => {
  assert.deepEqual(
    buildFixLessonMeta({ n: 3, title: 't' }, { title: 'Entry', goal: 'g', files: ['src/a.js'] }),
    { title: 'Entry', goal: 'g', files_expected: ['src/a.js'] },
  );
  assert.deepEqual(
    buildFixLessonMeta({ n: 3, title: 't' }, { files_likely: ['src/b.js'] }).files_expected,
    ['src/b.js'],
  );
  // No entry → falls back to the fix's own title, empty files (never throws).
  assert.deepEqual(buildFixLessonMeta({ n: 3, title: 'FixTitle' }, null), { title: 'FixTitle', goal: '', files_expected: [] });
});

test('loadLessonsBlock: a fix pseudo-meta sharing a file with a lesson injects it, where null (today\'s fix path) injects nothing', async () => {
  const projDir = makeProjDir('fix-lessons');
  await recordLesson(projDir, { kind: 'escalation', phase: null, fix: 'r2-3', source: 'test', lesson: 'Guard the upload controller against oversized files', files: ['backend/controllers/uploadController.js'] });
  const cfg = { lessons: { enabled: true } };
  // Today's behaviour for a fix: phaseMeta is falsy → null → scores 0 → nothing.
  const withNull = await loadLessonsBlock(projDir, null, cfg);
  assert.equal(withNull, null, 'baseline: a fix used to inject zero lessons');
  // Phase 41: the fix pseudo-meta shares the file → the lesson is injected.
  const fixMeta = buildFixLessonMeta({ n: 3, title: 'Upload security' }, { files: ['backend/controllers/uploadController.js'] });
  const withMeta = await loadLessonsBlock(projDir, fixMeta, cfg);
  assert.ok(withMeta && withMeta.includes('Guard the upload controller'), 'the file-overlapping lesson is now injected for the fix');
});

// ── Lint-style check: no Date.now()/new Date() spliced into a template literal ──
//
// Volatile values (attempt counters, elapsed times, timestamps) belong in the
// per-call user prompt, computed OUTSIDE the returned template literal —
// never interpolated directly via ${...} inside one, which would make a
// builder's output differ on every call even when nothing else changed.

test('phase-runner.js: no Date.now()/new Date() literal inside any template literal', () => {
  const filePath = fileURLToPath(new URL('./phase-runner.js', import.meta.url));
  const src = readFileSync(filePath, 'utf-8');

  // Split on UNESCAPED backticks only. This file embeds literal ``` markdown
  // fences inside prompt text, escaped as \` so they don't terminate the
  // enclosing template literal early — those must stay inside their segment.
  const segments = [];
  let current = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '`' && src[i - 1] !== '\\') {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);

  assert.equal(segments.length % 2, 1, 'backtick count must be even (well-formed template literals)');

  const offenders = [];
  for (let i = 1; i < segments.length; i += 2) {
    const templateBody = segments[i];
    if (/Date\.now\(|new Date\(/.test(templateBody)) {
      offenders.push(`template literal #${(i + 1) / 2}: ...${templateBody.slice(0, 80)}...`);
    }
  }
  assert.deepEqual(offenders, [], `found Date.now()/new Date() inside a template literal:\n${offenders.join('\n')}`);
});

// ── Phase 16: repo map injection ─────────────────────────────────────────────

// ─── shouldInjectRepoMap — pure decision (resolveConfig task-id namespace) ───

test('shouldInjectRepoMap: cfgTask present in guide_tasks → true', () => {
  assert.equal(shouldInjectRepoMap({ guideTasks: ['plan-creation', 'audit'], cfgTask: 'plan-creation' }), true);
});

test('shouldInjectRepoMap: cfgTask absent from guide_tasks → false (e.g. "handoff-creation" not in the reconciled default list)', () => {
  assert.equal(shouldInjectRepoMap({ guideTasks: ['plan-creation', 'audit', 'audit-scan', 'project-context-gen', 'suggest-scan'], cfgTask: 'handoff-creation' }), false);
});

test('shouldInjectRepoMap: non-array/missing guideTasks → false (never throws on a malformed config)', () => {
  assert.equal(shouldInjectRepoMap({ guideTasks: undefined, cfgTask: 'plan-creation' }), false);
  assert.equal(shouldInjectRepoMap({ guideTasks: null, cfgTask: 'plan-creation' }), false);
  assert.equal(shouldInjectRepoMap({ guideTasks: 'plan-creation', cfgTask: 'plan-creation' }), false);
});

// ─── loadRepoMapBlock — fail-open wrapper ────────────────────────────────────

test('loadRepoMapBlock: normal path renders the precedence-sentence block from an injected generateRepoMap', async () => {
  const projDir = makeProjDir('map-ok');
  const workspaceDir = path.join(projDir, 'workspace');
  const block = await loadRepoMapBlock(workspaceDir, projDir, {}, {
    generateRepoMap: async (args) => {
      assert.equal(args.workspaceDir, workspaceDir);
      assert.equal(args.projDir, projDir);
      return { generated_at_sha: 'deadbeef', body: '# Directory Structure\n```\nsrc/\n```\n' };
    },
  });
  assert.ok(block.includes('<repo_map>'));
  assert.ok(block.includes('This map is generated from static analysis at commit deadbeef.'));
});

test('loadRepoMapBlock: generateRepoMap returning null (disabled/fail-open internally) → null, no throw', async () => {
  const projDir = makeProjDir('map-null');
  const workspaceDir = path.join(projDir, 'workspace');
  const block = await loadRepoMapBlock(workspaceDir, projDir, {}, { generateRepoMap: async () => null });
  assert.equal(block, null);
});

test('loadRepoMapBlock: fail-open — a throwing generateRepoMap dep is caught, returns null, logs a [repo-map]-tagged warning, never throws', async () => {
  const projDir = makeProjDir('map-throw');
  const workspaceDir = path.join(projDir, 'workspace');
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (msg) => { warnings.push(String(msg)); };
  let block;
  try {
    block = await loadRepoMapBlock(workspaceDir, projDir, {}, {
      generateRepoMap: async () => { throw new Error('injected repomix crash'); },
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(block, null);
  assert.ok(warnings.some((w) => w.includes('repo-map')), 'expected a [repo-map]-tagged warning');
});

test('loadRepoMapBlock: byte-identical across calls for unchanged inputs (mirrors this file\'s other cache-discipline assertions)', async () => {
  const projDir = makeProjDir('map-stable');
  const workspaceDir = path.join(projDir, 'workspace');
  const deps = { generateRepoMap: async () => ({ generated_at_sha: 'cafefeed', body: 'tree only\n' }) };
  const a = await loadRepoMapBlock(workspaceDir, projDir, {}, deps);
  const b = await loadRepoMapBlock(workspaceDir, projDir, {}, deps);
  assert.equal(a, b);
});

// ─── Phase 39 (CE-4): loadRepoMapBlock focus rendering ──────────────────────

test('loadRepoMapBlock: focusPaths + a matching-sha cache re-renders from the cache (focused file in full, the rest degraded) instead of the phase-agnostic body', async () => {
  const projDir = makeProjDir('map-focus');
  const workspaceDir = path.join(projDir, 'workspace');
  const cache = {
    sha: 'sha-focus-1',
    tree: 'src/\n  a.js\n  b.js\n',
    files: [
      { path: 'src/a.js', lang: 'javascript', content: 'export function a() {}' },
      { path: 'src/b.js', lang: 'javascript', content: 'export function b() {}' },
    ],
  };
  const deps = {
    generateRepoMap: async () => ({ generated_at_sha: 'sha-focus-1', body: 'PHASE-AGNOSTIC BODY', degradation_level: 0 }),
    readRepoMapCache: async () => cache,
    focusPaths: ['src/a.js'],
  };
  const block = await loadRepoMapBlock(workspaceDir, projDir, {}, deps);
  assert.ok(!block.includes('PHASE-AGNOSTIC BODY'), 'focus mode re-renders from the cache, not the phase-agnostic body');
  assert.ok(block.includes('export function a() {}'), 'the focused file renders full content');
  assert.ok(!block.includes('export function b() {}'), 'the non-focused file does not render full content');
  assert.match(block, /# Exported symbols/, 'the non-focused file degrades to symbols-only');
});

test('loadRepoMapBlock: focusPaths with a stale (sha-mismatched) or missing cache falls back to the phase-agnostic body', async () => {
  const projDir = makeProjDir('map-focus-stale');
  const workspaceDir = path.join(projDir, 'workspace');
  const staleDeps = {
    generateRepoMap: async () => ({ generated_at_sha: 'sha-current', body: 'PHASE-AGNOSTIC BODY', degradation_level: 0 }),
    readRepoMapCache: async () => ({ sha: 'sha-stale', tree: '', files: [] }),
    focusPaths: ['src/a.js'],
  };
  const staleBlock = await loadRepoMapBlock(workspaceDir, projDir, {}, staleDeps);
  assert.ok(staleBlock.includes('PHASE-AGNOSTIC BODY'));

  const missingDeps = {
    generateRepoMap: async () => ({ generated_at_sha: 'sha-current', body: 'PHASE-AGNOSTIC BODY', degradation_level: 0 }),
    readRepoMapCache: async () => null,
    focusPaths: ['src/a.js'],
  };
  const missingBlock = await loadRepoMapBlock(workspaceDir, projDir, {}, missingDeps);
  assert.ok(missingBlock.includes('PHASE-AGNOSTIC BODY'));
});

test('loadRepoMapBlock: two calls with unchanged sha + focusPaths are byte-identical (cache-discipline extension)', async () => {
  const projDir = makeProjDir('map-focus-stable');
  const workspaceDir = path.join(projDir, 'workspace');
  const cache = {
    sha: 'sha-focus-stable',
    tree: 'src/\n  a.js\n',
    files: [{ path: 'src/a.js', lang: 'javascript', content: 'export function a() {}' }],
  };
  const deps = {
    generateRepoMap: async () => ({ generated_at_sha: 'sha-focus-stable', body: 'unused', degradation_level: 0 }),
    readRepoMapCache: async () => cache,
    focusPaths: ['src/a.js'],
  };
  const a = await loadRepoMapBlock(workspaceDir, projDir, {}, deps);
  const b = await loadRepoMapBlock(workspaceDir, projDir, {}, deps);
  assert.equal(a, b);
});

// ─── Phase 18: context delta injection ──────────────────────────────────────
//
// loadContextDeltaBlock is the fail-open wrapper (mirrors loadRepoMapBlock)
// that reads project-context.md's phase-17 front-matter stamp and renders the
// phase-18 delta block. Every call site only invokes it when ctxExtra itself
// is non-null, so a missing project-context.md is exercised here for
// completeness but composition-array-level coverage lives in the tests below.

test('loadContextDeltaBlock: no project-context.md at all → null (nothing to diff)', async () => {
  const projDir = makeProjDir('delta-nofile');
  const workspaceDir = path.join(projDir, 'workspace');
  const block = await loadContextDeltaBlock(workspaceDir, projDir);
  assert.equal(block, null);
});

test('loadContextDeltaBlock: legacy artifact with no front-matter stamp → drift-unknown caution, not the full classified block', async () => {
  const projDir = makeProjDir('delta-legacy');
  const workspaceDir = path.join(projDir, 'workspace');
  writeFileSync(path.join(projDir, '.guide', 'project-context.md'), '# Domain\nB2B SaaS for jewellers.\n');
  const block = await loadContextDeltaBlock(workspaceDir, projDir);
  assert.ok(block.includes('<context_delta>'));
  assert.ok(block.includes('could not be verified'));
  assert.ok(!block.includes('EXTERNAL = pushed outside this pipeline'), 'drift-unknown must not render the classified-list wording');
});

test('loadContextDeltaBlock: stamped artifact + non-empty delta → classified block with sha/date interpolated, via injected contextDelta', async () => {
  const projDir = makeProjDir('delta-some');
  const workspaceDir = path.join(projDir, 'workspace');
  writeFileSync(
    path.join(projDir, '.guide', 'project-context.md'),
    '---\ngenerated_at_sha: abc12345\ngenerated_at: 2026-07-01T00:00:00.000Z\n---\n\n# Domain\nB2B SaaS for jewellers.\n',
  );
  const block = await loadContextDeltaBlock(workspaceDir, projDir, {
    contextDelta: async ({ workspaceDir: ws, sinceSha }) => {
      assert.equal(ws, workspaceDir);
      assert.equal(sinceSha, 'abc12345');
      return {
        drift: 'some',
        commits: [
          { sha: 'deadbeef01', subject: 'Manual hotfix for prod', classification: 'external' },
          { sha: 'cafefeed02', subject: 'phase-18: wire delta injection', classification: 'orchestrator' },
        ],
        overflowLine: null,
      };
    },
  });
  assert.ok(block.includes('<context_delta>'));
  assert.ok(block.includes('generated at abc12345 (2026-07-01T00:00:00.000Z)'));
  assert.ok(block.includes('EXTERNAL = pushed outside this pipeline'));
  assert.ok(block.includes('[EXTERNAL] Manual hotfix for prod'));
  assert.ok(block.includes('[orchestrator] phase-18: wire delta injection'));
});

test('loadContextDeltaBlock: drift:"none" → null (empty delta renders nothing)', async () => {
  const projDir = makeProjDir('delta-none');
  const workspaceDir = path.join(projDir, 'workspace');
  writeFileSync(
    path.join(projDir, '.guide', 'project-context.md'),
    '---\ngenerated_at_sha: abc12345\ngenerated_at: 2026-07-01T00:00:00.000Z\n---\n\nBody.\n',
  );
  const block = await loadContextDeltaBlock(workspaceDir, projDir, {
    contextDelta: async () => ({ drift: 'none', commits: [], overflowLine: null }),
  });
  assert.equal(block, null);
});

test('loadContextDeltaBlock: fail-open — a throwing injected contextDelta is caught, returns null, logs a [context-delta]-tagged warning', async () => {
  const projDir = makeProjDir('delta-throw');
  const workspaceDir = path.join(projDir, 'workspace');
  writeFileSync(
    path.join(projDir, '.guide', 'project-context.md'),
    '---\ngenerated_at_sha: abc12345\ngenerated_at: 2026-07-01T00:00:00.000Z\n---\n\nBody.\n',
  );
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (msg) => { warnings.push(String(msg)); };
  let block;
  try {
    block = await loadContextDeltaBlock(workspaceDir, projDir, {
      contextDelta: async () => { throw new Error('injected git failure'); },
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(block, null);
  assert.ok(warnings.some((w) => w.includes('context-delta')));
});

test('loadContextDeltaBlock: byte-identical across calls for unchanged inputs', async () => {
  const projDir = makeProjDir('delta-stable');
  const workspaceDir = path.join(projDir, 'workspace');
  writeFileSync(
    path.join(projDir, '.guide', 'project-context.md'),
    '---\ngenerated_at_sha: abc12345\ngenerated_at: 2026-07-01T00:00:00.000Z\n---\n\nBody.\n',
  );
  const deps = {
    contextDelta: async () => ({
      drift: 'some',
      commits: [{ sha: 'deadbeef01', subject: 'Manual hotfix', classification: 'external' }],
      overflowLine: null,
    }),
  };
  const a = await loadContextDeltaBlock(workspaceDir, projDir, deps);
  const b = await loadContextDeltaBlock(workspaceDir, projDir, deps);
  assert.equal(a, b);
});

// ─── devSystemPromptExtra composition (runDev) — ordering + byte-identity ───
//
// CE-3 / cache-stable-system-prefix (merged, landed): devSystemPromptExtra is
// now `[briefCtx, ctxExtra, decisionsCtx, ledgerCtx]` — the per-phase-volatile
// blocks (deltaCtx, lessonsCtx, mapCtx) moved into the volatile user-prompt
// header (volatileDevCtx) instead, so they can change every phase without
// invalidating the cached system prefix a resumed dev session (validator
// retry, acceptance-gate refine) depends on. Phase 37 (CE-1) appended
// ledgerCtx AFTER decisionsCtx — it joins the same cache-stable class
// (changes only when a phase completes, not per-phase-volatile). Shadow-
// composes the same arrays runDev() builds — a full runDev() call needs a
// live git/DB/billing fixture, so the composable pieces are exercised
// directly instead (see verify-report-mode.test.mjs for the same convention
// applied to the acceptance-check hook).

test('devSystemPromptExtra composition: byte-identical regardless of deltaCtx/lessonsCtx/mapCtx — those blocks no longer feed the system prefix at all', async () => {
  const projDir = makeProjDir('compose-stable-only');
  writeFileSync(path.join(projDir, '.guide', 'brief.md'), '# Brief\n\n## Non-functional requirements\n- Must be fast\n');
  const briefCtx = await loadBriefConstraintsBlock(projDir, { phases: [] });
  const ctxExtra = null;
  const decisionsCtx = null;
  const ledgerCtx = null;

  const stableOnly = [briefCtx, ctxExtra, decisionsCtx, ledgerCtx].filter(Boolean).join('\n\n') || null;

  // Simulate three "calls" with wildly different volatile inputs — none of
  // them may appear in, or change, devSystemPromptExtra.
  const composeDevSystemPromptExtra = (volatileInputsIgnored) =>
    [briefCtx, ctxExtra, decisionsCtx, ledgerCtx].filter(Boolean).join('\n\n') || null;

  const callA = composeDevSystemPromptExtra({ deltaCtx: null, lessonsCtx: null, mapCtx: null });
  const callB = composeDevSystemPromptExtra({ deltaCtx: '<context_delta>changed every phase</context_delta>', lessonsCtx: '<lessons_from_prior_failures>x</lessons_from_prior_failures>', mapCtx: '<repo_map>tree</repo_map>' });

  assert.equal(callA, stableOnly);
  assert.equal(callB, stableOnly, 'devSystemPromptExtra must be byte-identical no matter what deltaCtx/lessonsCtx/mapCtx are — they no longer feed it');
});

test('devSystemPromptExtra composition: ledgerCtx joins decisionsCtx\'s cache-stable class — present it in the array and it renders, immediately after decisionsCtx, never in volatileDevCtx', async () => {
  const briefCtx = null;
  const ctxExtra = null;
  const decisionsCtx = '<decisions_log>some decision</decisions_log>';
  const ledgerCtx = '<phase_ledger>some ledger entry</phase_ledger>';

  const devSystemPromptExtra = [briefCtx, ctxExtra, decisionsCtx, ledgerCtx].filter(Boolean).join('\n\n') || null;
  assert.equal(devSystemPromptExtra, `${decisionsCtx}\n\n${ledgerCtx}`);
  assert.ok(devSystemPromptExtra.indexOf(decisionsCtx) < devSystemPromptExtra.indexOf(ledgerCtx), 'ledgerCtx renders AFTER decisionsCtx');

  const deltaCtx = null, lessonsCtx = null, mapCtx = null;
  const volatileDevCtx = [deltaCtx, lessonsCtx, mapCtx].filter(Boolean).join('\n\n');
  assert.ok(!volatileDevCtx.includes('phase_ledger'), 'ledgerCtx never rides in volatileDevCtx');
});

test('volatileDevCtx composition: compiled context, delta, lessons, then repo-map pointer; joined only when present', async () => {
  const projDir = makeProjDir('compose-volatile');
  writeFileSync(path.join(projDir, '.guide', 'project-context.md'), '# Domain\nB2B SaaS for jewellers.\n');
  const ctxExtra = await loadProjectContextBlock(projDir);
  const deltaCtx = await loadContextDeltaBlock(path.join(projDir, 'workspace'), projDir, {
    contextDelta: async () => ({
      drift: 'some',
      commits: [{ sha: 'deadbeef01', subject: 'Manual hotfix', classification: 'external' }],
      overflowLine: null,
    }),
  });
  const lessonsCtx = null;
  const mapCtx = await loadRepoMapBlock(path.join(projDir, 'workspace'), projDir, {}, {
    generateRepoMap: async () => ({ generated_at_sha: 'sha1234', body: 'tree\n' }),
  });

  const compiledContextBlock = null;
  const volatileDevCtx = [compiledContextBlock, deltaCtx, lessonsCtx, mapCtx].filter(Boolean).join('\n\n');
  assert.ok(volatileDevCtx.startsWith(deltaCtx), 'a shadow/disabled compiler contributes no block');
  assert.ok(volatileDevCtx.endsWith(mapCtx), 'mapCtx (most volatile — changes with HEAD) is the last entry');
  assert.ok(ctxExtra, 'sanity: ctxExtra itself never appears in volatileDevCtx — only gates whether deltaCtx is computed');
});

// ─── Source assertions — placement/ordering in phase-runner.js ─────────────
//
// Same convention as verify-report-mode.test.mjs's Section E: a full runDev()/
// runGuide() call needs a live git+DB+billing fixture to exercise end-to-end,
// so ordering/placement is asserted directly against the source instead.

const _phaseRunnerSrc = readFileSync(fileURLToPath(new URL('./phase-runner.js', import.meta.url)), 'utf-8');

test('runDev(): repo-map generation (repoMapBlock) is computed AFTER the git sync block and BEFORE volatileDevCtx is assembled', () => {
  const syncIdx = _phaseRunnerSrc.indexOf('(no upstream tracking yet for ${expectedBranch} — will be set on first push)');
  const mapGenIdx = _phaseRunnerSrc.indexOf('const repoMapBlock = await loadRepoMapBlock(workspaceDir, projDir, cfg, { focusPaths });');
  const composeIdx = _phaseRunnerSrc.indexOf('const volatileDevCtx = [compiledContextBlock, deltaCtx, lessonsCtx, mapCtx]');
  assert.ok(syncIdx > -1 && mapGenIdx > -1 && composeIdx > -1, 'all three anchors found in source');
  assert.ok(syncIdx < mapGenIdx, 'map is generated after the sync block completes');
  assert.ok(mapGenIdx < composeIdx, 'map is generated before volatileDevCtx is assembled');
});

// Phase 38 (CE-6): mapCtx is derived from repoMapBlock — cfg.mcp.enabled swaps
// the injected block for MCP_REPO_MAP_POINTER_BLOCK, but the loadRepoMapBlock
// (generateRepoMap) call that refreshes the on-disk map for get_repo_map runs
// unconditionally either way.
test('runDev(): mapCtx starts as the MCP pointer or repo-map block — the refresh call itself is never gated', () => {
  assert.match(
    _phaseRunnerSrc,
    /const repoMapBlock = await loadRepoMapBlock\(workspaceDir, projDir, cfg, \{ focusPaths \}\);\s*\n\s*let mapCtx = cfg\.mcp\?\.enabled \? MCP_REPO_MAP_POINTER_BLOCK : repoMapBlock;/,
  );
});

test('compiled context suppresses the redundant broad repo map only when it really owns repository context', () => {
  const mapCtx = '<repo_map>broad tree</repo_map>';
  const usable = { inject: true, degraded: false };

  assert.equal(resolveDevRepoMapContext({
    mapCtx, compiledContextUse: usable, compiledContextBlock: '<compiled_context>focused</compiled_context>',
  }), null, 'fresh assist/enforce prompt uses only its focused compiled context');
  assert.equal(resolveDevRepoMapContext({
    mapCtx, compiledContextUse: usable, sessionOwnsCompiledContext: true,
  }), null, 'an interrupted same-session resume already owns the compiled block');

  for (const compiledContextUse of [
    { inject: false, degraded: false },
    { inject: false, degraded: true },
    null,
  ]) {
    assert.equal(resolveDevRepoMapContext({ mapCtx, compiledContextUse }), mapCtx,
      'shadow/degraded/no-manifest paths keep the historical repo-map fallback');
  }
  assert.equal(resolveDevRepoMapContext({ mapCtx, compiledContextUse: usable }), mapCtx,
    'a fresh call whose compiled block did not render keeps the fail-open map');
});

test('runDev filters mapCtx after compiler policy resolution and before volatile prompt composition', () => {
  const useIdx = _phaseRunnerSrc.indexOf('compiledContextUse = resolveCompiledContextUse(cfg, manifest);');
  const filterIdx = _phaseRunnerSrc.indexOf('const sessionOwnsRecoverableCompiledContext =', useIdx);
  const composeIdx = _phaseRunnerSrc.indexOf('const volatileDevCtx = [compiledContextBlock, deltaCtx, lessonsCtx, mapCtx]');
  assert.ok(useIdx !== -1 && filterIdx > useIdx && composeIdx > filterIdx,
    'only a policy-usable compiled manifest may suppress the repo-map/pointer');
  const filterBlock = _phaseRunnerSrc.slice(filterIdx, composeIdx);
  assert.match(filterBlock, /sessionOwnsRecoverableCompiledContext = sessionOwnsCompiledContext\s*&& Boolean\(contextRecoveryBlock\)/,
    'same-session ownership suppresses the map only when fresh-retry recovery is available');
  assert.match(filterBlock, /sessionOwnsCompiledContext: sessionOwnsRecoverableCompiledContext/,
    'the map filter receives only recoverable same-session ownership');
  assert.match(_phaseRunnerSrc, /priorInterruptedContext\?\.manifest_id === manifest\.manifest_id/,
    'a persisted session id cannot suppress reinjection unless it owns this exact manifest');
  assert.match(_phaseRunnerSrc, /priorInterruptedContext\?\.injected_tokens \|\| 0/,
    'a prior shadow/unexposed attribution is not mistaken for prompt ownership');
});

// Phase 39 (CE-4): focusPaths is resolved BEFORE the loadRepoMapBlock call —
// phaseMeta.files_expected for a phase, resolveFixPhaseMeta(projDir, fix)'s
// files_expected for a fix (fix-plan entries have no plan.json phase entry).
test('runDev(): focusPaths resolves from resolveFixPhaseMeta for a fix, phaseMeta for a phase — computed before repoMapBlock', () => {
  const focusIdx = _phaseRunnerSrc.indexOf('const focusMeta = fix ? await resolveFixPhaseMeta(projDir, fix) : phaseMeta;');
  const mapGenIdx = _phaseRunnerSrc.indexOf('const repoMapBlock = await loadRepoMapBlock(workspaceDir, projDir, cfg, { focusPaths });');
  assert.ok(focusIdx > -1 && mapGenIdx > -1, 'both anchors found in source');
  assert.ok(focusIdx < mapGenIdx, 'focusPaths is resolved before loadRepoMapBlock is called');
});

test('mapCtx composition: cfg.mcp.enabled swaps the rendered repo-map block for the 3-line MCP pointer, but the underlying generateRepoMap refresh seam still runs either way', async () => {
  const projDir = makeProjDir('mcp-map-pointer');
  const workspaceDir = path.join(projDir, 'workspace');
  let generateCalls = 0;
  const deps = {
    generateRepoMap: async () => { generateCalls += 1; return { generated_at_sha: 'sha1234', body: 'tree\n' }; },
  };
  const composeMapCtx = async (cfg) => {
    const repoMapBlock = await loadRepoMapBlock(workspaceDir, projDir, cfg, deps);
    return cfg.mcp?.enabled ? MCP_REPO_MAP_POINTER_BLOCK : repoMapBlock;
  };

  const disabled = await composeMapCtx({});
  assert.ok(disabled.includes('<repo_map>') && disabled.includes('sha1234'), 'mcp disabled (default) — full repo map block renders as before');

  const enabled = await composeMapCtx({ mcp: { enabled: true } });
  assert.ok(enabled.includes('get_repo_map'), 'mcp enabled — pointer names the tool to call instead');
  assert.ok(!enabled.includes('sha1234'), 'mcp enabled — the map body itself must not appear inline');
  assert.equal(MCP_REPO_MAP_POINTER_BLOCK.split('\n').length, 3, 'the pointer block itself is exactly 3 lines');

  assert.equal(generateCalls, 2, 'generateRepoMap (the on-disk refresh seam) runs on EVERY call regardless of cfg.mcp.enabled');
});

test('runDev(): devSystemPromptExtra array literal is [briefCtx, ctxExtra, decisionsCtx, ledgerCtx] — deltaCtx/lessonsCtx/mapCtx moved to volatileDevCtx, ledgerCtx appended after decisionsCtx (Phase 37)', () => {
  assert.match(_phaseRunnerSrc, /const devSystemPromptExtra = \[briefCtx, ctxExtra, decisionsCtx, ledgerCtx\]\.filter\(Boolean\)\.join\('\\n\\n'\) \|\| null;/);
});

test('runDev(): ledgerCtx is computed via loadPhaseLedgerBlock, gated by cfg.ledger.enabled, BEFORE devSystemPromptExtra is assembled (Phase 37)', () => {
  const ledgerIdx = _phaseRunnerSrc.indexOf("const ledgerCtx = cfg.ledger?.enabled === false ? null : await loadPhaseLedgerBlock(projDir, cfg.ledger?.inject_last_k ?? 8);");
  const composeIdx = _phaseRunnerSrc.indexOf('const devSystemPromptExtra = [briefCtx, ctxExtra, decisionsCtx, ledgerCtx]');
  assert.ok(ledgerIdx > -1, 'ledgerCtx computation found in source');
  assert.ok(composeIdx > -1 && ledgerIdx < composeIdx, 'ledgerCtx computed before devSystemPromptExtra is assembled');
});

test('runDev(): volatileDevCtx puts compiled context before delta/lessons/map and keeps the no-`|| null` contract', () => {
  assert.match(_phaseRunnerSrc, /const volatileDevCtx = \[compiledContextBlock, deltaCtx, lessonsCtx, mapCtx\]\.filter\(Boolean\)\.join\('\\n\\n'\);/);
});

test('runDev(): promptWithReportHeader prepends volatileDevCtx (when non-empty) ahead of the report-path header', () => {
  const composeIdx = _phaseRunnerSrc.indexOf('const volatileDevCtx = [compiledContextBlock, deltaCtx, lessonsCtx, mapCtx]');
  // Phase 82 (test-first P4b): promptWithReportHeader is now a reassignable
  // `let` (the test-first harness appends its "make the authored test pass,
  // don't edit it" note after the pre-dev seam commits the red test).
  const headerIdx = _phaseRunnerSrc.indexOf('let promptWithReportHeader =');
  assert.ok(composeIdx > -1 && headerIdx > composeIdx, 'volatileDevCtx is computed before promptWithReportHeader');
  // Phase 70 (brief 05 P5): a single-call batch has no single report path, so
  // promptWithReportHeader branches on isBatch — the non-batch `else` arm below
  // is byte-identical to the pre-phase-70 unconditional expression.
  assert.match(_phaseRunnerSrc, /let promptWithReportHeader = isBatch\s*\n\s*\? .*\n\s*: \(volatileDevCtx \? `\$\{volatileDevCtx\}\\n\\n` : ''\) \+/);
});

test('deltaCtx is only computed when ctxExtra is non-null, at all three call sites (runGuide, runTwoStageAudit, runDev)', () => {
  const matches = _phaseRunnerSrc.match(/const deltaCtx\s*=\s*ctxExtra \? await loadContextDeltaBlock\(workspaceDir, projDir\) : null;/g) || [];
  assert.equal(matches.length, 3, `expected exactly 3 deltaCtx computations (found ${matches.length})`);
});

test('runDev(): fix and phase spawns share the SAME devSystemPromptExtra — exactly one composition site, reused unconditionally by both the initial call and the validator/refine retries', () => {
  const compositions = _phaseRunnerSrc.match(/const devSystemPromptExtra = \[/g) || [];
  assert.equal(compositions.length, 1, 'devSystemPromptExtra must be composed exactly once in runDev() — no fix-only/phase-only branch');
  const reuses = _phaseRunnerSrc.match(/systemPromptExtra: devSystemPromptExtra/g) || [];
  assert.ok(reuses.length >= 3, `expected devSystemPromptExtra reused by the initial call + validator retry + acceptance refine (found ${reuses.length})`);
});

test('runGuide(): systemPromptExtra array literal is ONLY [handoffCtx, ctxExtra, suggestCtx] — deltaCtx/guideDeltaCtx/repromptCtx/mapCtx moved to volatileCtx (CE-3 / cache-stable-system-prefix)', () => {
  assert.match(_phaseRunnerSrc, /const systemPromptExtra = \[handoffCtx, ctxExtra, suggestCtx\]\.filter\(Boolean\)\.join\('\\n\\n'\) \|\| null;/);
});

test('runGuide(): handoffCtx is gated to fresh sessions only (sessionId === null) — a resumed call never has it re-sent, so it never busts a resumed session\'s cached system prefix', () => {
  assert.match(_phaseRunnerSrc, /const handoffCtx\s*=\s*sessionId === null \? await loadMostRecentHandoffBlock\(projDir\) : null;/);
});

test('runGuide(): volatileCtx array literal is [deltaCtx, guideDeltaCtx, repromptCtx, mapCtx, globalLessonsCtx], prepended to `prompt` — never appended to systemPromptExtra', () => {
  // Phase 80 (brief 05 P3): globalLessonsCtx (plan-creation-only cross-project
  // global lessons) is volatile — it rides here in the user prompt, never the
  // cached system prefix.
  assert.match(_phaseRunnerSrc, /const volatileCtx = \[deltaCtx, guideDeltaCtx, repromptCtx, mapCtx, globalLessonsCtx\]\.filter\(Boolean\)\.join\('\\n\\n'\);/);
  assert.match(_phaseRunnerSrc, /let promptWithVolatileCtx = volatileCtx \? `\$\{volatileCtx\}\\n\\n\$\{prompt\}` : prompt;/);
});

test('runGuide(): mapCtx gating uses shouldInjectRepoMap against cfg.repo_map.guide_tasks and cfgTask (the resolveConfig task-id, not the runGuide task param)', () => {
  assert.match(_phaseRunnerSrc, /shouldInjectRepoMap\(\{ guideTasks: cfg\.repo_map\?\.guide_tasks, cfgTask \}\)/);
});

test('runTwoStageAudit(): builds the shared systemPromptExtra (map included) exactly ONCE, before either stage\'s runClaude call — not duplicated per stage', () => {
  const fnStart = _phaseRunnerSrc.indexOf('async function runTwoStageAudit(');
  const fnEnd = _phaseRunnerSrc.indexOf('\nexport async function runDev(', fnStart);
  assert.ok(fnStart > -1 && fnEnd > fnStart, 'runTwoStageAudit function body located');
  const body = _phaseRunnerSrc.slice(fnStart, fnEnd);

  const compositions = body.match(/const systemPromptExtra = \[handoffCtx, ctxExtra, deltaCtx, mapCtx\]/g) || [];
  assert.equal(compositions.length, 1, 'systemPromptExtra (with deltaCtx + mapCtx) must be built exactly once, shared by both stages');

  const scanCallIdx = body.indexOf("role: 'guide', project: projectName, task: 'audit-scan',");
  const adjudicateCallIdx = body.indexOf("role: 'guide', project: projectName, task: 'audit',");
  const composeIdx = body.indexOf('const systemPromptExtra = [handoffCtx, ctxExtra, deltaCtx, mapCtx]');
  assert.ok(composeIdx > -1 && scanCallIdx > -1 && adjudicateCallIdx > -1);
  assert.ok(composeIdx < scanCallIdx, 'shared block built before stage 1 (scan)');
  assert.ok(composeIdx < adjudicateCallIdx, 'shared block built before stage 2 (adjudicate)');

  // Phase 53 (par-06): a third call site (the sharded scan spawn, alongside
  // the single/fallback scan call and the adjudicate call) now references the
  // same variable — still ONE composition, reused by every runClaude call in
  // the function including the concurrent shard spawns.
  const reuses = body.match(/systemPromptExtra,/g) || [];
  assert.equal(reuses.length, 3, 'every runClaude call site (fallback scan, sharded scan spawn, adjudicate) references the same systemPromptExtra variable — not separately-built blocks');
});

test('runTwoStageAudit(): map injection triggers if EITHER "audit-scan" or "audit" is in guide_tasks (matches either resolveConfig task id used by its two stages)', () => {
  const fnStart = _phaseRunnerSrc.indexOf('async function runTwoStageAudit(');
  const fnEnd = _phaseRunnerSrc.indexOf('\nexport async function runDev(', fnStart);
  const body = _phaseRunnerSrc.slice(fnStart, fnEnd);
  assert.match(body, /shouldInjectRepoMap\(\{ guideTasks: cfg\.repo_map\?\.guide_tasks, cfgTask: 'audit-scan' \}\)/);
  assert.match(body, /shouldInjectRepoMap\(\{ guideTasks: cfg\.repo_map\?\.guide_tasks, cfgTask: 'audit' \}\)/);
});

// ─── Phase 35 — buildLightReviewPrompt (review-slim) ────────────────────────

test('buildLightReviewPrompt: byte-identical across calls for unchanged inputs', async () => {
  const projDir = makeProjDir('review-light');
  const batch = [
    { n: 1, title: 'Phase One' },
    { n: 2, title: 'Phase Two' },
  ];
  const changedFiles = ['workspace/a.js', 'workspace/b.js'];
  const out = path.join(projDir, '.guide', 'reviews', 'after-2.md');
  const a = await buildLightReviewPrompt({ projectName: 'p', projDir, out, batch, changedFiles });
  const b = await buildLightReviewPrompt({ projectName: 'p', projDir, out, batch: [...batch], changedFiles: [...changedFiles] });
  assert.equal(a, b);
  assert.ok(a.length > 0);
});

test('runGuide(): light-review branch bypasses the rest of the function BEFORE cfgTask/GUIDE_TASK_MAP is resolved — an early return, not a flag threaded through the whole function', () => {
  const guardIdx = _phaseRunnerSrc.indexOf("if (task === 'review' && reviewMode === 'light')");
  const cfgTaskIdx = _phaseRunnerSrc.indexOf('let cfgTask = GUIDE_TASK_MAP[task];');
  assert.ok(guardIdx > -1 && cfgTaskIdx > -1, 'both anchors found in source');
  assert.ok(guardIdx < cfgTaskIdx, 'the light-review guard runs before cfgTask is resolved');
});

test("runLightReview(): spawns with sessionId:null, role:null, task:'review-slim' — never the guide role/session bookkeeping path", () => {
  assert.match(_phaseRunnerSrc, /sessionId: null,\s*\n\s*role: null,\s*\n\s*project: projectName,\s*\n\s*task: 'review-slim',/);
});

// ─── Phase 36 — panel review: lens 2/3 systemPromptExtra + prompt builder ───

test('REVIEW_LENS_SECURITY_SYSTEM_PROMPT / REVIEW_LENS_CONSISTENCY_SYSTEM_PROMPT: fixed literals, byte-identical across reads (no interpolation) — same cache-discipline guarantee as verify-loop.js CHECKER_SYSTEM_PROMPT', () => {
  assert.equal(typeof REVIEW_LENS_SECURITY_SYSTEM_PROMPT, 'string');
  assert.equal(typeof REVIEW_LENS_CONSISTENCY_SYSTEM_PROMPT, 'string');
  assert.match(REVIEW_LENS_SECURITY_SYSTEM_PROMPT, /SECURITY/);
  assert.match(REVIEW_LENS_CONSISTENCY_SYSTEM_PROMPT, /CONSISTENCY/);
  assert.match(REVIEW_LENS_CONSISTENCY_SYSTEM_PROMPT, /do NOT append to \.guide\/decisions\.jsonl/i,
    'lens 3s system prompt explicitly disclaims appending to decisions.jsonl');
  assert.doesNotMatch(REVIEW_LENS_SECURITY_SYSTEM_PROMPT, /decisions\.jsonl/,
    'lens 2 never mentions decisions.jsonl at all');
});

test('REVIEW_LENS_ALLOWED_TOOLS: read-mostly + Write, no Edit, no unrestricted Bash', () => {
  assert.deepEqual([...REVIEW_LENS_ALLOWED_TOOLS].sort(), [
    'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Glob', 'Grep', 'Read', 'Write',
  ].sort());
});

test('buildReviewLensPrompt: byte-identical across calls for unchanged inputs', () => {
  const projDir = '/tmp/aorch-cache-discipline-lens-fixture';
  const out = path.join(projDir, '.guide', 'reviews', 'after-5-lens-2.md');
  const args = {
    lensLabel: 'security / failure-modes', projectName: 'p', projDir, out,
    phaseNs: [4, 5], changedFiles: ['workspace/a.js', 'workspace/b.js'], includeDecisionsNote: false,
  };
  const a = buildReviewLensPrompt(args);
  const b = buildReviewLensPrompt({ ...args, phaseNs: [...args.phaseNs], changedFiles: [...args.changedFiles] });
  assert.equal(a, b);
  assert.match(a, /Write to: /);
  assert.match(a, /verdict: <continue\|pause-and-fix\|replan>/, 'shared verdict/score trailer present');
});

test('buildReviewLensPrompt: includeDecisionsNote renders the explicit "do NOT append" line only when set', () => {
  const projDir = '/tmp/aorch-cache-discipline-lens-fixture';
  const out = path.join(projDir, '.guide', 'reviews', 'after-5-lens-3.md');
  const withNote = buildReviewLensPrompt({
    lensLabel: 'consistency', projectName: 'p', projDir, out, phaseNs: [5], changedFiles: [], includeDecisionsNote: true,
  });
  const withoutNote = buildReviewLensPrompt({
    lensLabel: 'security', projectName: 'p', projDir, out, phaseNs: [5], changedFiles: [], includeDecisionsNote: false,
  });
  assert.match(withNote, /do NOT append to decisions\.jsonl/i);
  assert.doesNotMatch(withoutNote, /decisions\.jsonl/i);
});

test("runGuide(): panel-mode review targets after-N-lens-1.md via buildGuidePrompt's 'review' case — the ONLY change from the pre-phase-36 full-review call", () => {
  // Phase 52 (par-03): targetPhaseN replaced the direct project.current_phase
  // reads so an explicit reviewPhaseN (async review pipeline) can override it —
  // targetPhaseN itself still falls back to project.current_phase unchanged.
  assert.match(_phaseRunnerSrc, /const out = reviewMode === 'panel'\s*\n\s*\? reviewLensPath\(projDir, targetPhaseN, 1\)\s*\n\s*: reviewPath\(projDir, targetPhaseN\);/);
});

test("runGuide(): the panel post-processing block spawns lenses 2\\/3 and merges only when task==='review' && reviewMode==='panel' && !result.is_error", () => {
  assert.match(_phaseRunnerSrc, /if \(task === 'review' && reviewMode === 'panel' && !result\.is_error\) \{\s*\n\s*await runReviewPanel\(/);
});
