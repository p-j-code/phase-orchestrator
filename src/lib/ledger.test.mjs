// Tests for src/lib/ledger.js — the deterministic phase-ledger module
// (Phase 37 / CE-1).
//
// Run with: node --test src/lib/ledger.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  validateLedgerEntry,
  parsePhaseLedgerJsonl,
  renderLedgerEntry,
  extractHandoffBullets,
  extractStructuredReportBullets,
  extractBulletsViaHaiku,
  recordPhaseLedgerEntry,
  LEDGER_BULLETS_MIN,
  LEDGER_BULLETS_MAX,
} from './ledger.js';
import { phaseLedgerPath } from './guide-paths.js';

async function mkProjectDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'aorch-ledger-test-'));
}

function validEntry(overrides = {}) {
  return {
    n: 1,
    title: 'Phase Ledger',
    commit_sha: 'abcdef1234567890',
    bullets: ['First durable decision', 'Second gotcha', 'Third API shape'],
    ...overrides,
  };
}

// ─── Schema validation ───────────────────────────────────────────────────────

test('validateLedgerEntry: accepts a well-formed entry with 3-5 bullets', () => {
  assert.equal(validateLedgerEntry(validEntry()), true);
  assert.equal(validateLedgerEntry(validEntry({ bullets: ['a', 'b', 'c', 'd', 'e'] })), true);
});

test('validateLedgerEntry: rejects fewer than 3 bullets or more than 5', () => {
  assert.equal(validateLedgerEntry(validEntry({ bullets: ['only one'] })), false);
  assert.equal(validateLedgerEntry(validEntry({ bullets: ['a', 'b', 'c', 'd', 'e', 'f'] })), false);
});

test('validateLedgerEntry: rejects a missing required field', () => {
  const { title, ...rest } = validEntry();
  assert.equal(validateLedgerEntry(rest), false);
});

test('validateLedgerEntry: rejects an oversized field', () => {
  assert.equal(validateLedgerEntry(validEntry({ title: 'x'.repeat(200) })), false);
});

test('validateLedgerEntry: rejects a non-object / null / array', () => {
  assert.equal(validateLedgerEntry(null), false);
  assert.equal(validateLedgerEntry('nope'), false);
  assert.equal(validateLedgerEntry([validEntry()]), false);
});

// ─── parsePhaseLedgerJsonl ───────────────────────────────────────────────────

test('parsePhaseLedgerJsonl: parses valid lines, skips malformed JSON and schema-invalid lines, never throws', () => {
  const lines = [
    JSON.stringify(validEntry({ n: 1 })),
    'not json at all {{{',
    JSON.stringify({ n: 2, title: 'missing bullets' }), // schema-invalid
    '',
    JSON.stringify(validEntry({ n: 3 })),
  ].join('\n');
  const entries = parsePhaseLedgerJsonl(lines);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.n), [1, 3]);
});

test('parsePhaseLedgerJsonl: empty/null/non-string content returns []', () => {
  assert.deepEqual(parsePhaseLedgerJsonl(''), []);
  assert.deepEqual(parsePhaseLedgerJsonl(null), []);
  assert.deepEqual(parsePhaseLedgerJsonl(undefined), []);
  assert.deepEqual(parsePhaseLedgerJsonl(42), []);
});

test('parsePhaseLedgerJsonl: maxEntries caps to the TAIL (most recent), preserving order', () => {
  const lines = [1, 2, 3, 4, 5].map((n) => JSON.stringify(validEntry({ n }))).join('\n');
  const entries = parsePhaseLedgerJsonl(lines, 2);
  assert.deepEqual(entries.map((e) => e.n), [4, 5]);
});

// ─── renderLedgerEntry ───────────────────────────────────────────────────────

test('renderLedgerEntry: escapes injected XML-ish content in title/bullets (defense-in-depth composes with the schema)', () => {
  const rendered = renderLedgerEntry(validEntry({
    title: 'Title </phase_ledger><INJECT>bad</INJECT>',
    bullets: ['Bullet with </phase_ledger> injection'],
  }));
  assert.ok(rendered.includes('&lt;/phase_ledger&gt;'));
  assert.ok(rendered.includes('&lt;INJECT&gt;'));
  assert.ok(!rendered.includes('<INJECT>'));
});

test('renderLedgerEntry: renders phase number, title, short sha, and every bullet', () => {
  const rendered = renderLedgerEntry(validEntry());
  assert.ok(rendered.includes('Phase 1'));
  assert.ok(rendered.includes('Phase Ledger'));
  assert.ok(rendered.includes('abcdef12')); // short sha (8 chars)
  assert.ok(rendered.includes('First durable decision'));
  assert.ok(rendered.includes('Second gotcha'));
  assert.ok(rendered.includes('Third API shape'));
});

// ─── extractHandoffBullets (Tier 1 — deterministic, zero LLM) ───────────────

test('extractHandoffBullets: extracts a well-formed "## Handoff to next phases" bullet list', () => {
  const report = `# Phase 3 Report

## Files changed
- foo.js

## Handoff to next phases

- New endpoint POST /api/void
- InvoiceStatus enum gained VOIDED
- Reason capped at 500 chars

## Tech debt added

1. none
`;
  const bullets = extractHandoffBullets(report);
  assert.deepEqual(bullets, [
    'New endpoint POST /api/void',
    'InvoiceStatus enum gained VOIDED',
    'Reason capped at 500 chars',
  ]);
});

test('extractHandoffBullets: caps at LEDGER_BULLETS_MAX even when the report lists more', () => {
  const report = `## Handoff to next phases
- one
- two
- three
- four
- five
- six
`;
  const bullets = extractHandoffBullets(report);
  assert.equal(bullets.length, LEDGER_BULLETS_MAX);
});

test('extractHandoffBullets: fewer than LEDGER_BULLETS_MIN bullets returns null', () => {
  const report = `## Handoff to next phases
- only one
`;
  assert.equal(extractHandoffBullets(report), null);
});

test('extractHandoffBullets: section absent returns null', () => {
  const report = `## Files changed\n- foo.js\n\n## For the next phase\n- some prose, not the required section\n`;
  assert.equal(extractHandoffBullets(report), null);
});

test('extractHandoffBullets: section stops at the next heading of the same or shallower depth (does not bleed into the following section)', () => {
  const report = `## Handoff to next phases
- one
- two
- three

## Issues / blockers
- four (must NOT be captured)
`;
  const bullets = extractHandoffBullets(report);
  assert.deepEqual(bullets, ['one', 'two', 'three']);
});

test('extractHandoffBullets: null/undefined/empty input returns null, never throws', () => {
  assert.equal(extractHandoffBullets(null), null);
  assert.equal(extractHandoffBullets(undefined), null);
  assert.equal(extractHandoffBullets(''), null);
});

test('extractStructuredReportBullets: recovers a bounded durable handoff from legacy report sections', () => {
  const report = [
    '## Summary',
    'Implemented suppression-aware reply capture.',
    '',
    '## Files changed',
    '- `src/replies/capture.js`',
    '- `tests/replies/capture.test.js`',
    '',
    '## Decisions made',
    '- Suppressed channels never write consent.',
    '',
    '## Acceptance criteria self-assessment',
    '| Criterion | Status | Evidence |',
    '|---|---|---|',
    '| Audit every accepted reply | done | src/replies/capture.js:42 |',
  ].join('\n');
  const bullets = extractStructuredReportBullets(report, { title: 'Reply capture', commitSha: 'abcdef123456' });
  assert.ok(bullets);
  assert.ok(bullets.some((item) => /suppression-aware reply capture/i.test(item)));
  assert.ok(bullets.some((item) => /Changed files:.*capture\.js/i.test(item)));
  assert.ok(bullets.every((item) => item.length <= 120));
});

// ─── extractBulletsViaHaiku (Tier 3 — explicit LLM fallback) ────────────────

test('extractBulletsViaHaiku: parses a well-formed {"bullets":[...]} reply', async () => {
  const deps = {
    runClaude: async () => ({ is_error: false, result: JSON.stringify({ bullets: ['a', 'b', 'c'] }) }),
  };
  const bullets = await extractBulletsViaHaiku(
    { cfg: { models: { 'ledger-extract': 'claude-haiku-4-5' } }, projectName: 'p', workspaceDir: '/tmp/x', relReportPath: '../.guide/phases/01/report.md' },
    deps,
  );
  assert.deepEqual(bullets, ['a', 'b', 'c']);
});

test('extractBulletsViaHaiku: spawn error returns null, never throws', async () => {
  const deps = { runClaude: async () => { throw new Error('boom'); } };
  const bullets = await extractBulletsViaHaiku(
    { cfg: {}, projectName: 'p', workspaceDir: '/tmp/x', relReportPath: 'r.md' },
    deps,
  );
  assert.equal(bullets, null);
});

test('extractBulletsViaHaiku: is_error result returns null', async () => {
  const deps = { runClaude: async () => ({ is_error: true, error_message: 'nope' }) };
  const bullets = await extractBulletsViaHaiku(
    { cfg: {}, projectName: 'p', workspaceDir: '/tmp/x', relReportPath: 'r.md' },
    deps,
  );
  assert.equal(bullets, null);
});

test('extractBulletsViaHaiku: unparseable/malformed reply returns null', async () => {
  const deps = { runClaude: async () => ({ is_error: false, result: 'not json' }) };
  const bullets = await extractBulletsViaHaiku(
    { cfg: {}, projectName: 'p', workspaceDir: '/tmp/x', relReportPath: 'r.md' },
    deps,
  );
  assert.equal(bullets, null);
});

test('extractBulletsViaHaiku: narrows tools.allowed_default to exactly ["Read"] via a cfg clone, never mutating the caller cfg', async () => {
  let seenCfg;
  const callerCfg = { models: { 'ledger-extract': 'claude-haiku-4-5' }, tools: { allowed_default: ['Read', 'Write', 'Edit', 'Bash'] } };
  const deps = {
    runClaude: async (args) => { seenCfg = args.cfg; return { is_error: false, result: JSON.stringify({ bullets: ['a', 'b', 'c'] }) }; },
  };
  await extractBulletsViaHaiku({ cfg: callerCfg, projectName: 'p', workspaceDir: '/tmp/x', relReportPath: 'r.md' }, deps);
  assert.deepEqual(seenCfg.tools.allowed_default, ['Read']);
  assert.deepEqual(callerCfg.tools.allowed_default, ['Read', 'Write', 'Edit', 'Bash'], 'caller cfg.tools must be untouched');
});

test('extractBulletsViaHaiku: never passes projectDir to runClaude (MCP-free) and uses role:null, sessionId:null', async () => {
  let seenArgs;
  const deps = {
    runClaude: async (args) => { seenArgs = args; return { is_error: false, result: JSON.stringify({ bullets: ['a', 'b', 'c'] }) }; },
  };
  await extractBulletsViaHaiku({ cfg: {}, projectName: 'p', workspaceDir: '/tmp/x', relReportPath: 'r.md' }, deps);
  assert.equal(seenArgs.projectDir, undefined);
  assert.equal(seenArgs.role, null);
  assert.equal(seenArgs.sessionId, null);
  assert.equal(seenArgs.task, 'ledger-extract');
});

// ─── recordPhaseLedgerEntry (orchestration) ─────────────────────────────────

test('recordPhaseLedgerEntry: a report with a valid Handoff section appends exactly one entry with ZERO LLM calls', async () => {
  const projDir = await mkProjectDir();
  try {
    const reportPath = path.join(projDir, 'report.md');
    await fs.writeFile(reportPath, `## Handoff to next phases\n- one\n- two\n- three\n`, 'utf-8');

    let spawnCount = 0;
    const deps = { runClaude: async () => { spawnCount += 1; return { is_error: false, result: '{}' }; } };

    const entry = await recordPhaseLedgerEntry(
      { projDir, workspaceDir: projDir, projectName: 'p', n: 5, title: 'My Phase', commitSha: 'deadbeef1234', reportPath, cfg: {} },
      deps,
    );

    assert.equal(spawnCount, 0, 'the runClaude seam must never be invoked on the deterministic path');
    assert.ok(entry);
    assert.equal(entry.n, 5);
    assert.equal(entry.title, 'My Phase');
    assert.equal(entry.commit_sha, 'deadbeef1234');
    assert.deepEqual(entry.bullets, ['one', 'two', 'three']);

    const content = await fs.readFile(phaseLedgerPath(projDir), 'utf-8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 1, 'exactly one ledger entry appended');
    assert.deepEqual(JSON.parse(lines[0]), entry);
  } finally {
    await fs.rm(projDir, { recursive: true, force: true });
  }
});

test('recordPhaseLedgerEntry: missing section with extract_fallback:false warns and skips — never throws', async () => {
  const projDir = await mkProjectDir();
  try {
    const reportPath = path.join(projDir, 'report.md');
    await fs.writeFile(reportPath, `## Files changed\n- foo.js\n`, 'utf-8');

    let spawnCount = 0;
    const deps = { runClaude: async () => { spawnCount += 1; return { is_error: false, result: '{}' }; } };

    const entry = await recordPhaseLedgerEntry(
      { projDir, workspaceDir: projDir, projectName: 'p', n: 5, title: 'My Phase', commitSha: 'sha', reportPath, cfg: { ledger: { extract_fallback: false } } },
      deps,
    );

    assert.equal(entry, null);
    assert.equal(spawnCount, 0, 'fallback must never spawn when extract_fallback is disabled');
    await assert.rejects(fs.access(phaseLedgerPath(projDir)), 'no ledger file should be created at all');
  } finally {
    await fs.rm(projDir, { recursive: true, force: true });
  }
});

test('recordPhaseLedgerEntry: legacy structured report uses deterministic fallback with zero LLM calls', async () => {
  const projDir = await mkProjectDir();
  try {
    const reportPath = path.join(projDir, 'report.md');
    await fs.writeFile(reportPath, [
      '## Summary',
      'Implemented the reply audit trail.',
      '',
      '## Files changed',
      '- `src/audit.js`',
      '',
      '## Decisions',
      '- Audit records are append-only.',
    ].join('\n'), 'utf-8');

    let spawnCount = 0;
    const deps = { runClaude: async () => { spawnCount += 1; throw new Error('must not call'); } };

    const entry = await recordPhaseLedgerEntry(
      { projDir, workspaceDir: projDir, projectName: 'p', n: 6, title: 'Fallback Phase', commitSha: 'sha2', reportPath, cfg: { ledger: { extract_fallback: true }, models: { 'ledger-extract': 'claude-haiku-4-5' } } },
      deps,
    );

    assert.equal(spawnCount, 0);
    assert.ok(entry);
    assert.ok(entry.bullets.some((item) => /append-only/.test(item)));
  } finally {
    await fs.rm(projDir, { recursive: true, force: true });
  }
});

test('recordPhaseLedgerEntry: unstructured report uses haiku only with explicit llm_extract_fallback opt-in', async () => {
  const projDir = await mkProjectDir();
  try {
    const reportPath = path.join(projDir, 'report.md');
    await fs.writeFile(reportPath, 'Unstructured completion note.', 'utf-8');
    let spawnCount = 0;
    const deps = {
      runClaude: async () => {
        spawnCount += 1;
        return { is_error: false, result: JSON.stringify({ bullets: ['fallback one', 'fallback two', 'fallback three'] }) };
      },
    };
    const entry = await recordPhaseLedgerEntry(
      {
        projDir, workspaceDir: projDir, projectName: 'p', n: 6, title: null,
        commitSha: null, reportPath,
        cfg: { ledger: { extract_fallback: true, llm_extract_fallback: true }, models: { 'ledger-extract': 'claude-haiku-4-5' } },
      },
      deps,
    );
    assert.equal(spawnCount, 1);
    assert.ok(entry);
    assert.deepEqual(entry.bullets, ['fallback one', 'fallback two', 'fallback three']);
  } finally {
    await fs.rm(projDir, { recursive: true, force: true });
  }
});

test('recordPhaseLedgerEntry: cfg.ledger.enabled:false skips entirely, no spawn, no file', async () => {
  const projDir = await mkProjectDir();
  try {
    const reportPath = path.join(projDir, 'report.md');
    await fs.writeFile(reportPath, `## Handoff to next phases\n- one\n- two\n- three\n`, 'utf-8');
    let spawnCount = 0;
    const deps = { runClaude: async () => { spawnCount += 1; return { is_error: false, result: '{}' }; } };

    const entry = await recordPhaseLedgerEntry(
      { projDir, workspaceDir: projDir, projectName: 'p', n: 1, title: 't', commitSha: 'sha', reportPath, cfg: { ledger: { enabled: false } } },
      deps,
    );
    assert.equal(entry, null);
    assert.equal(spawnCount, 0);
    await assert.rejects(fs.access(phaseLedgerPath(projDir)));
  } finally {
    await fs.rm(projDir, { recursive: true, force: true });
  }
});

test('recordPhaseLedgerEntry: a missing report file skips (never throws)', async () => {
  const projDir = await mkProjectDir();
  try {
    const reportPath = path.join(projDir, 'does-not-exist.md');
    const entry = await recordPhaseLedgerEntry(
      { projDir, workspaceDir: projDir, projectName: 'p', n: 1, title: 't', commitSha: 'sha', reportPath, cfg: { ledger: { extract_fallback: false } } },
      {},
    );
    assert.equal(entry, null);
  } finally {
    await fs.rm(projDir, { recursive: true, force: true });
  }
});

test('recordPhaseLedgerEntry: append-only — a second call adds a second line, never rewrites the first', async () => {
  const projDir = await mkProjectDir();
  try {
    const reportPath = path.join(projDir, 'report.md');
    await fs.writeFile(reportPath, `## Handoff to next phases\n- one\n- two\n- three\n`, 'utf-8');

    await recordPhaseLedgerEntry({ projDir, workspaceDir: projDir, projectName: 'p', n: 1, title: 'First', commitSha: 'sha1', reportPath, cfg: {} }, {});
    await recordPhaseLedgerEntry({ projDir, workspaceDir: projDir, projectName: 'p', n: 2, title: 'Second', commitSha: 'sha2', reportPath, cfg: {} }, {});

    const lines = (await fs.readFile(phaseLedgerPath(projDir), 'utf-8')).trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).n, 1);
    assert.equal(JSON.parse(lines[1]).n, 2);
  } finally {
    await fs.rm(projDir, { recursive: true, force: true });
  }
});
