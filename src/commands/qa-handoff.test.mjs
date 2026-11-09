// Phase 47 (P4 brief conformance) — qa-handoff embeds the conformance matrix
// prominently when .guide/brief-conformance.md exists.
//
// Run with: node --test src/commands/qa-handoff.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// generateQaHandoff also queries validator_runs (src/lib/validators.js),
// which lives in a SEPARATE migration (migrate-validators.js) from state.js's
// own baseline DDL — unlike ':memory:' (a fresh, unshared DB per connection),
// a real temp file lets that migration's own `new Database(DB_PATH)` connection
// and state.js's getDb() connection see the same on-disk schema.
process.env.DB_PATH = path.join(os.tmpdir(), `aorch-qa-handoff-test-${Date.now()}.db`);
await import('../migrate-validators.js');

const { generateQaHandoff } = await import('./qa-handoff.js');
const { upsertProject } = await import('../state.js');
const { guideRoot, briefConformanceMdPath } = await import('../lib/guide-paths.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

async function cleanupProject(name) {
  await fs.rm(path.join(PROJECTS_DIR, name), { recursive: true, force: true }).catch(() => {});
}

test('generateQaHandoff: embeds .guide/brief-conformance.md prominently (right after the title) when it exists', async () => {
  const name = 'qah-bc-present';
  try {
    upsertProject({ name, tech_stack: 'node', total_phases: 1 });
    const projDir = path.join(PROJECTS_DIR, name);
    await fs.mkdir(guideRoot(projDir), { recursive: true });
    await fs.writeFile(
      briefConformanceMdPath(projDir),
      '# Brief conformance check\n\n- **Result:** BLOCKED ✗ (1 missing FR)\n\nunique-conformance-marker-42\n',
      'utf-8',
    );
    const outputPath = path.join(projDir, '.guide', 'qa-handoffs', 'test-out.md');

    const { outputPath: written } = await generateQaHandoff(name, { phaseStart: 1, phaseEnd: 1, outputPath });
    const markdown = await fs.readFile(written, 'utf-8');

    assert.match(markdown, /unique-conformance-marker-42/);
    // "Prominent" — appears before the Tester info section, not just tacked on at the end.
    const conformanceIdx = markdown.indexOf('unique-conformance-marker-42');
    const testerInfoIdx = markdown.indexOf('## Tester info');
    assert.ok(conformanceIdx >= 0 && testerInfoIdx >= 0 && conformanceIdx < testerInfoIdx,
      'brief-conformance content must appear before ## Tester info');
  } finally {
    await cleanupProject(name);
  }
});

test('generateQaHandoff: omits the brief-conformance section entirely when the file does not exist', async () => {
  const name = 'qah-bc-absent';
  try {
    upsertProject({ name, tech_stack: 'node', total_phases: 1 });
    const projDir = path.join(PROJECTS_DIR, name);
    const outputPath = path.join(projDir, '.guide', 'qa-handoffs', 'test-out.md');

    const { outputPath: written } = await generateQaHandoff(name, { phaseStart: 1, phaseEnd: 1, outputPath });
    const markdown = await fs.readFile(written, 'utf-8');

    assert.doesNotMatch(markdown, /Brief conformance check/);
  } finally {
    await cleanupProject(name);
  }
});
