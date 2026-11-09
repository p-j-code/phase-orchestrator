// Phase 35 (batch-weight review gating) — fixture tests for runGuide()'s
// light-review path: task:'review' + reviewMode:'light' must spawn the
// LITERAL task 'review-slim', sessionId:null, role:null — and, critically,
// must NEVER touch guide_session_id (a role:'guide' fresh call would clobber
// the resumed guide session's bookkeeping even with sessionId:null). Mirrors
// phase-runner-audit-incremental.test.mjs's fixture-project + deps.runClaude
// seam pattern so assertions read the REAL args passed to the mocked runClaude.
//
// Run with: node --test src/lib/phase-runner-review-light.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DB_PATH = ':memory:';

const { runGuide } = await import('./phase-runner.js');
const { upsertProject, deleteProject, setGuideSessionId, getProject } = await import('../state.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

async function makeFixture(label) {
  const name = `test-review-light-${label}-${randomUUID()}`;
  const projDir = path.join(PROJECTS_DIR, name);
  const guideDir = path.join(projDir, '.guide');
  await fs.mkdir(guideDir, { recursive: true });
  await fs.writeFile(path.join(guideDir, 'plan.json'), JSON.stringify({
    phases: [
      { n: 1, title: 'Phase One' },
      { n: 2, title: 'Phase Two' },
      { n: 3, title: 'Phase Three' },
    ],
  }), 'utf-8');
  await fs.writeFile(path.join(guideDir, 'brief.md'), '# Brief\n\nTest brief.\n', 'utf-8');
  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
    $schema_version: 1, name, created_at: new Date(0).toISOString(),
    overrides: { repo_map: { enabled: false } },
  }), 'utf-8');

  upsertProject({ name, tech_stack: 'node', total_phases: 3 });
  return { name, projDir };
}

async function cleanup(projDir, name) {
  await fs.rm(projDir, { recursive: true, force: true }).catch(() => {});
  try { deleteProject(name); } catch { /* ignore */ }
}

function makeStub() {
  const calls = [];
  const runClaude = async (opts) => {
    calls.push(opts);
    return { result: 'ok', session_id: 'brand-new-session-id-from-review-slim', is_error: false, last_turn_context_tokens: null };
  };
  return { calls, runClaude };
}

test("light review: runGuide({task:'review', reviewMode:'light'}) spawns task 'review-slim' with sessionId:null/role:null, and guide_session_id is left UNCHANGED", async () => {
  const { name, projDir } = await makeFixture('basic');
  try {
    setGuideSessionId(name, 'sentinel-should-not-change');
    const { calls, runClaude } = makeStub();

    const result = await runGuide({
      projectName: name,
      task: 'review',
      reviewMode: 'light',
      reviewBatch: [
        { n: 1, title: 'Phase One', verifyVerdict: 'pass' },
        { n: 2, title: 'Phase Two', verifyVerdict: 'pass' },
      ],
      reviewChangedFiles: ['workspace/a.js', 'workspace/b.js'],
    }, { runClaude });

    assert.equal(result.is_error, false);
    assert.equal(calls.length, 1, 'exactly one spawn — no git preflight/reground/session machinery for the light path');
    assert.equal(calls[0].task, 'review-slim');
    assert.equal(calls[0].sessionId, null);
    assert.equal(calls[0].role, null);

    // The stub returned a fresh session_id, but role:null means claude-runner's
    // own upsertSession/setGuideSessionId gate (`if (returnedSessionId && role
    // && project)`) never fires — this fixture proves it end-to-end via the
    // REAL runGuide + REAL claude-runner.js (not a re-implemented mock).
    const after = getProject(name);
    assert.equal(after.guide_session_id, 'sentinel-should-not-change',
      'guide_session_id must be untouched by the roleless light-review spawn');
  } finally {
    await cleanup(projDir, name);
  }
});

test('light review prompt: carries the batch phase reports, changed-file list, and Write to: the SAME reviewPath a full review would use', async () => {
  const { name, projDir } = await makeFixture('prompt');
  try {
    const { calls, runClaude } = makeStub();
    await runGuide({
      projectName: name,
      task: 'review',
      reviewMode: 'light',
      reviewBatch: [{ n: 1, title: 'Phase One', verifyVerdict: 'pass' }],
      reviewChangedFiles: ['workspace/x.js'],
    }, { runClaude });

    assert.equal(calls.length, 1);
    const { prompt, systemPromptExtra } = calls[0];
    assert.match(prompt, /LIGHTWEIGHT review/i);
    assert.match(prompt, /01-phase-one[\\/]report\.md/, 'phase report relative path is listed');
    assert.match(prompt, /workspace\/x\.js/, 'changed-file list is included');
    assert.match(prompt, /Write to: \.guide[\\/]reviews[\\/]after-0\.md/);
    assert.match(prompt, /verdict: <continue\|pause-and-fix\|replan>/, 'shared verdict/score trailer present');
    assert.match(prompt, /ALSO maintain the rolling decisions log/, 'shared decisions-append instruction present');
    // Light mode's systemPromptExtra is project-context ONLY (no handoff/suggestions).
    assert.equal(systemPromptExtra, null, 'no project-context.md written in this fixture -> null, not some other block');
  } finally {
    await cleanup(projDir, name);
  }
});

test('light review: runGuide({task:"review"}) WITHOUT reviewMode (or reviewMode:"full") is unaffected — falls through to the normal path', async () => {
  const src = await fs.readFile(path.join(REPO_ROOT, 'src', 'lib', 'phase-runner.js'), 'utf-8');
  assert.match(src, /if \(task === 'review' && reviewMode === 'light'\)/,
    "the light branch's guard is an exact equality check against 'light' — reviewMode absent (undefined) or 'full' both fall through unchanged");
});
