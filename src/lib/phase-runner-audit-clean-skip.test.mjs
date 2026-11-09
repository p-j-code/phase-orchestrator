// Phase 33 (QL-5) — a two-stage full audit whose Sonnet scan provably finds
// ZERO candidates skips the whole adjudication call: isCleanScan() (pure
// unit tests below) plus an end-to-end fixture harness mirroring
// phase-runner-audit-incremental.test.mjs's makeAuditFixture/deps.runClaude
// pattern, but exercising the TWO-STAGE path (audit.two_stage left at its
// true default, instead of forced false) since that is exactly the path
// this phase changes.
//
// Run with: node --test src/lib/phase-runner-audit-clean-skip.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DB_PATH = ':memory:';

const { runGuide, isCleanScan } = await import('./phase-runner.js');
const { upsertProject, deleteProject } = await import('../state.js');
const { auditDir, findMostRecentAudit } = await import('./guide-paths.js');
const { promoteAuditToBugs } = await import('./audit-promote.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

// ─── isCleanScan — pure unit tests ───────────────────────────────────────────

test('isCleanScan: trailer 0 + no CAND headings → true', () => {
  assert.equal(isCleanScan('# Scan\n\nNothing found.\n\ncandidates: 0\n'), true);
});

test('isCleanScan: trailer 0 + a "### CAND-1" heading present → false (trailer/heading mismatch)', () => {
  const text = '### CAND-1 — stray heading\n- Where: a.js:1\n\ncandidates: 0\n';
  assert.equal(isCleanScan(text), false);
});

test('isCleanScan: trailer missing → false', () => {
  assert.equal(isCleanScan('# Scan\n\nNo trailer line here.\n'), false);
});

test('isCleanScan: trailer 3 → false', () => {
  assert.equal(isCleanScan('### CAND-1 — x\n### CAND-2 — y\n### CAND-3 — z\n\ncandidates: 3\n'), false);
});

test('isCleanScan: empty/undefined/null → false', () => {
  assert.equal(isCleanScan(''), false);
  assert.equal(isCleanScan(undefined), false);
  assert.equal(isCleanScan(null), false);
  assert.equal(isCleanScan('   \n  '), false);
});

// ─── Fixture helpers ─────────────────────────────────────────────────────────

// Two-stage path fixture: a real git workspace (so isGitRepo/getHeadSha in
// the tail bookkeeping succeed), NO .last-audit.json marker (so
// detectIncrementalAudit returns null → not incremental), and repo_map
// disabled (avoids a real repomix spawn in the shared systemPromptExtra).
// audit.two_stage is left at its true default — this is the path phase 33
// changes, unlike phase 32's fixture which forces two_stage:false.
async function makeTwoStageFixture(label, auditOverrides = {}) {
  const name = `test-audit-clean-${label}-${randomUUID()}`;
  const projDir = path.join(PROJECTS_DIR, name);
  const workspaceDir = path.join(projDir, 'workspace');

  await fs.mkdir(path.join(projDir, '.guide'), { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });

  const git = (cmd) => execSync(cmd, { cwd: workspaceDir, stdio: 'pipe' });
  git('git init -q && git config user.email t@t && git config user.name t');
  await fs.writeFile(path.join(workspaceDir, 'a.js'), '1\n', 'utf-8');
  git('git add -A && git commit -qm one');

  await fs.writeFile(path.join(projDir, '.guide', 'plan.json'), JSON.stringify({ phases: [] }), 'utf-8');
  await fs.writeFile(path.join(projDir, '.guide', 'brief.md'), '# Brief\n\nTest brief.\n', 'utf-8');

  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
    $schema_version: 1, name, created_at: new Date(0).toISOString(),
    overrides: { repo_map: { enabled: false }, audit: auditOverrides },
  }), 'utf-8');

  upsertProject({ name, tech_stack: 'node', total_phases: 1 });

  return { name, projDir };
}

async function cleanup(projDir, name) {
  await fs.rm(projDir, { recursive: true, force: true }).catch(() => {});
  try { deleteProject(name); } catch { /* ignore */ }
}

// deps.runClaude stub: for the audit-scan call, extracts the "Output to: X"
// path buildAuditScanPrompt embeds in its prompt and writes a scan fixture
// there (0 or 1 candidates) — simulating what the real scan model would have
// written to disk. The adjudicate call ('audit' task), when reached, is a
// bare success stub — no file write needed for these assertions.
function makeStub({ scanCandidates = 0 } = {}) {
  const calls = [];
  const runClaude = async (opts) => {
    calls.push(opts);
    if (opts.task === 'audit-scan') {
      const m = opts.prompt.match(/^Output to: (.+)$/m);
      const scanPath = path.join(opts.cwd, m[1]);
      const body = scanCandidates === 0
        ? '# Scan\n\nNo issues found.\n\ncandidates: 0\n'
        : '### CAND-1 — Sample issue\n- Where: a.js:1\n- Evidence: (fenced)\n- Suspicion: test fixture\n- Severity guess: MINOR\n\ncandidates: 1\n';
      await fs.writeFile(scanPath, body, 'utf-8');
    }
    return { result: 'ok', session_id: null, is_error: false, last_turn_context_tokens: null };
  };
  return { calls, runClaude };
}

// ─── Clean scan (default gate on) → adjudication skipped ────────────────────

test('clean scan (0 candidates) skips adjudication: exactly ONE spawn, audit file written, promoteAuditToBugs returns { promoted:false, clean:true }, .last-audit.json streak reset to 0', async () => {
  const { name, projDir } = await makeTwoStageFixture('clean');
  try {
    const { calls, runClaude } = makeStub({ scanCandidates: 0 });
    const result = await runGuide({ projectName: name, task: 'audit' }, { runClaude });

    assert.equal(result.is_error, false);
    assert.equal(calls.length, 1, 'exactly one spawn — the scan; no adjudication call');
    assert.equal(calls[0].task, 'audit-scan');
    assert.equal(result.audit_scope, 'full-clean-skip');
    assert.equal(result.two_stage?.adjudication_skipped, true);

    const writtenAuditFile = await findMostRecentAudit(projDir);
    assert.ok(writtenAuditFile, 'a final audit file was written by the orchestrator (no second LLM call)');
    assert.ok(path.basename(writtenAuditFile).startsWith('audit-'), 'uses the same audit-<ts>.md naming as auditPath()');

    const promo = await promoteAuditToBugs({ projDir, projectName: name });
    assert.deepEqual({ promoted: promo.promoted, clean: promo.clean }, { promoted: false, clean: true });

    const marker = JSON.parse(await fs.readFile(path.join(auditDir(projDir), '.last-audit.json'), 'utf-8'));
    assert.equal(marker.incremental_streak, 0, 'a full audit (adjudicated or clean-skipped) resets the streak');
  } finally {
    await cleanup(projDir, name);
  }
});

// ─── Kill-switch: audit.skip_adjudication_when_clean:false ──────────────────

test('audit.skip_adjudication_when_clean:false — a clean scan still spawns the adjudicator', async () => {
  const { name, projDir } = await makeTwoStageFixture('killswitch', { skip_adjudication_when_clean: false });
  try {
    const { calls, runClaude } = makeStub({ scanCandidates: 0 });
    const result = await runGuide({ projectName: name, task: 'audit' }, { runClaude });

    assert.equal(result.is_error, false);
    assert.equal(calls.length, 2, 'kill-switch off → both scan and adjudicate spawn');
    assert.equal(calls[0].task, 'audit-scan');
    assert.equal(calls[1].task, 'audit', 'stage 2 still runs even though the scan was clean');
    assert.equal(result.audit_scope, 'full', 'not the clean-skip scope — adjudication actually ran');
  } finally {
    await cleanup(projDir, name);
  }
});

// ─── Regression: a 1-candidate scan is untouched by this phase ──────────────

test('a 1-candidate scan is untouched by this phase — adjudicates on sonnet via the existing foundations re-route', async () => {
  const { name, projDir } = await makeTwoStageFixture('onecand');
  try {
    const { calls, runClaude } = makeStub({ scanCandidates: 1 });
    const result = await runGuide({ projectName: name, task: 'audit' }, { runClaude });

    assert.equal(result.is_error, false);
    assert.equal(calls.length, 2, 'not clean → adjudication still spawns');
    assert.equal(calls[1].task, 'audit');
    assert.equal(calls[1].cfg.model, 'claude-sonnet-5', 'min_candidates:3 hard floor not met at 1 candidate — sonnet baseline');
    assert.equal(calls[1].routing.tier, 'sonnet');
    assert.equal(result.audit_scope, 'full');
  } finally {
    await cleanup(projDir, name);
  }
});
