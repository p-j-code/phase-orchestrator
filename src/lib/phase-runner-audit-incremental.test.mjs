// Phase 32 (MI-10) — end-to-end fixture tests for runGuide()'s audit tier-decay:
// diff-scoped incremental re-audits route as the LITERAL task 'audit-incremental'
// (sonnet baseline, no opus hard floor) while a genuine full single-call audit
// stays task 'audit' (whose conditional opus floor fail-safes to applying when
// no candidate signals are supplied). Mirrors phase-runner-guide-compaction.test.mjs's
// harness (same fixture-project pattern + deps.runClaude seam) so the assertions
// read the REAL args passed to the mocked runClaude — the task string and the
// routed cfg.model — not just source text.
//
// Run with: node --test src/lib/phase-runner-audit-incremental.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DB_PATH = ':memory:';

const { runGuide } = await import('./phase-runner.js');
const { upsertProject, deleteProject } = await import('../state.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

// ─── Fixture helpers ─────────────────────────────────────────────────────────

// Builds a fixture project whose workspace IS a git repo with two commits (so
// detectIncrementalAudit's git probes work) but whose DB row carries NO
// git_branch — that keeps runGuide()'s git preflight/sync block skipped
// (expectedBranch falsy) while the workspace is still a real repo for the
// incremental diff scoping. `incremental:true` also drops the .last-audit.json
// marker (sha == first commit) + a prior audit file so detectIncrementalAudit
// returns a non-null diff scope; `incremental:false` omits the marker so it
// returns null (a full audit). Both fixtures disable repo_map (avoids a real
// repomix spawn in the guide systemPromptExtra) and set audit.two_stage:false
// so the no-marker case stays on the single-call path that reaches the mocked
// runClaude (a two-stage full audit uses the un-stubbed module-level runClaude).
async function makeAuditFixture(label, { incremental }) {
  const name = `test-audit-inc-${label}-${randomUUID()}`;
  const projDir = path.join(PROJECTS_DIR, name);
  const workspaceDir = path.join(projDir, 'workspace');
  const auditsDir = path.join(projDir, '.guide', 'audits');

  await fs.mkdir(path.join(projDir, '.guide'), { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });

  // Two-commit git workspace: first commit is the "last audited" SHA, second
  // moves HEAD so there IS a diff to scope an incremental audit to.
  const git = (cmd) => execSync(cmd, { cwd: workspaceDir, stdio: 'pipe' });
  git('git init -q && git config user.email t@t && git config user.name t');
  await fs.writeFile(path.join(workspaceDir, 'a.js'), '1\n', 'utf-8');
  git('git add -A && git commit -qm one');
  const firstSha = git('git rev-parse HEAD').toString().trim();
  await fs.writeFile(path.join(workspaceDir, 'b.js'), '2\n', 'utf-8');
  git('git add -A && git commit -qm two');

  await fs.writeFile(path.join(projDir, '.guide', 'plan.json'), JSON.stringify({ phases: [] }), 'utf-8');
  await fs.writeFile(path.join(projDir, '.guide', 'brief.md'), '# Brief\n\nTest brief.\n', 'utf-8');

  if (incremental) {
    await fs.mkdir(auditsDir, { recursive: true });
    await fs.writeFile(path.join(auditsDir, 'audit-1.md'), '# prior audit\n', 'utf-8');
    await fs.writeFile(path.join(auditsDir, '.last-audit.json'), JSON.stringify({ sha: firstSha, incremental_streak: 0 }), 'utf-8');
  }

  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
    $schema_version: 1, name, created_at: new Date(0).toISOString(),
    overrides: { repo_map: { enabled: false }, audit: { two_stage: false } },
  }), 'utf-8');

  upsertProject({ name, tech_stack: 'node', total_phases: 1 });

  return { name, projDir };
}

async function cleanup(projDir, name) {
  await fs.rm(projDir, { recursive: true, force: true }).catch(() => {});
  try { deleteProject(name); } catch { /* ignore */ }
}

// deps.runClaude stub: captures every call's opts (task + cfg.model + routing)
// and returns a benign guide result. No session bookkeeping is exercised — an
// audit is a fresh-session task, so it never resumes/records a session id.
function makeStub() {
  const calls = [];
  const runClaude = async (opts) => {
    calls.push(opts);
    return { result: 'ok', session_id: null, is_error: false, last_turn_context_tokens: null };
  };
  return { calls, runClaude };
}

// ─── Incremental re-audit → task 'audit-incremental', sonnet, scope metadata ──

test("incremental re-audit routes as literal task 'audit-incremental' on the sonnet baseline (no opus floor) and tags audit_scope:'incremental'", async () => {
  const { name, projDir } = await makeAuditFixture('inc', { incremental: true });
  try {
    const { calls, runClaude } = makeStub();
    const result = await runGuide({ projectName: name, task: 'audit' }, { runClaude });

    assert.equal(result.is_error, false);
    assert.equal(calls.length, 1, 'exactly one guide spawn — no two-stage, no reground/compaction handoff');
    assert.equal(calls[0].task, 'audit-incremental', 'the runClaude spawn carries the split task id, not audit');
    assert.equal(calls[0].cfg.model, 'claude-sonnet-5', 'no hard floor for audit-incremental → sonnet baseline');
    assert.equal(calls[0].routing.tier, 'sonnet');
    assert.equal(result.audit_scope, 'incremental', 'result metadata (read by phase 34)');
  } finally {
    await cleanup(projDir, name);
  }
});

// ─── No marker (full single-call audit) → task stays 'audit', opus fail-safe ──

test("a full single-call audit (no .last-audit.json) stays on task 'audit' — its conditional opus floor still fail-safes to applying — and tags audit_scope:'full'", async () => {
  const { name, projDir } = await makeAuditFixture('full', { incremental: false });
  try {
    const { calls, runClaude } = makeStub();
    const result = await runGuide({ projectName: name, task: 'audit' }, { runClaude });

    assert.equal(result.is_error, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].task, 'audit', 'no incremental detected → task unchanged');
    assert.equal(calls[0].cfg.model, 'claude-opus-4-8', "audit floor applies fail-safe when no candidate signals are supplied");
    assert.equal(calls[0].routing.tier, 'opus');
    assert.equal(result.audit_scope, 'full');
  } finally {
    await cleanup(projDir, name);
  }
});

// ─── Single-detection invariant + threaded-param consumption (source seam) ────
//
// detectIncrementalAudit must run exactly ONCE per audit runGuide call: hoisted
// above resolveConfig/routeModel so the FINAL config/route/spawn all see the
// split task id, and threaded into buildGuidePrompt instead of re-detected
// there (the pre-phase-32 double call was a latent TOCTOU). Asserted at the
// source level because the second (eliminated) call lived inside buildGuidePrompt,
// which has no injectable seam of its own.

test('detectIncrementalAudit is called exactly once in runGuide; buildGuidePrompt consumes the threaded auditIncremental (no re-detection)', async () => {
  const src = await fs.readFile(path.join(REPO_ROOT, 'src', 'lib', 'phase-runner.js'), 'utf-8');

  const callSites = src.match(/await detectIncrementalAudit\(/g) || [];
  assert.equal(callSites.length, 1, 'exactly one invocation — the hoisted call in runGuide');

  assert.match(src, /task === 'audit' \? await detectIncrementalAudit\(projDir, cfg\) : null/,
    'the single call is hoisted above resolveConfig/routeModel, gated on task audit');
  assert.match(src, /cfgTask = 'audit-incremental';/,
    'a detected incremental re-points cfgTask to the literal split task id');
  assert.match(src, /const incremental = auditIncremental;/,
    "buildGuidePrompt's audit case consumes the threaded parameter, it does not re-detect");
});

// ─── audit_scope metadata is emitted by BOTH audit producers ──────────────────

test("both audit result producers tag audit_scope: single-call path branches incremental|full, runTwoStageAudit is always 'full'", async () => {
  const src = await fs.readFile(path.join(REPO_ROOT, 'src', 'lib', 'phase-runner.js'), 'utf-8');
  assert.match(src, /audit_scope: auditWasIncremental \? 'incremental' : 'full'/,
    "runGuide's single-call return branches the scope on whether detection fired");
  assert.match(src, /audit_scope: 'full'/,
    "runTwoStageAudit's return hard-codes 'full' (a two-stage audit is always a whole-codebase scan)");
});
