// Phase 53 (par-06) — sharded two-stage-audit scan. buildAuditShards() pure
// bin-packer tests, plus an end-to-end fixture harness mirroring
// phase-runner-audit-clean-skip.test.mjs's makeTwoStageFixture/deps.runClaude
// pattern, exercising runTwoStageAudit's sharded scan path: N concurrent
// role:null spawns over disjoint top-level directories, fail-open fallback to
// a single full scan on any shard problem, and read-side compat for
// buildAuditScanPrompt/buildAuditAdjudicatePrompt's new optional params.
//
// Run with: node --test src/lib/phase-runner-audit-shards.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DB_PATH = ':memory:';

const { runGuide, buildAuditShards } = await import('./phase-runner.js');
const { upsertProject, deleteProject } = await import('../state.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

// ─── buildAuditShards — pure unit tests ──────────────────────────────────────

test('buildAuditShards: deterministic for identical input', () => {
  const files = ['src/a.js', 'src/b.js', 'lib/c.js', 'lib/d.js', 'lib/e.js', 'root.js'];
  const a = buildAuditShards({ files, shardCount: 2 });
  const b = buildAuditShards({ files: [...files], shardCount: 2 });
  assert.deepEqual(a, b);
});

test('buildAuditShards: produces <= shardCount bins; every file lands in exactly one bin', () => {
  const files = ['src/a.js', 'src/b.js', 'src/c.js', 'lib/d.js', 'test/e.js', 'root.js'];
  const bins = buildAuditShards({ files, shardCount: 3 });
  assert.ok(bins.length <= 3, `expected <= 3 bins, got ${bins.length}`);
  const totalFiles = bins.reduce((sum, b) => sum + b.fileCount, 0);
  assert.equal(totalFiles, files.length, 'no file dropped or double-counted');
  const allDirs = bins.flatMap((b) => b.dirs);
  assert.deepEqual([...allDirs].sort(), ['.', 'lib', 'src', 'test'], 'every top-level group present exactly once across bins');
});

test('buildAuditShards: shardCount resolving to 1 yields a single bin containing every file (the single-scan path)', () => {
  const files = ['src/a.js', 'lib/b.js', 'root.js'];
  const bins = buildAuditShards({ files, shardCount: 1 });
  assert.equal(bins.length, 1);
  assert.equal(bins[0].fileCount, files.length);
});

test('buildAuditShards: fewer top-level dirs than shardCount never produces empty bins', () => {
  const files = ['src/a.js', 'src/b.js'];
  const bins = buildAuditShards({ files, shardCount: 5 });
  assert.equal(bins.length, 1, 'one top-level dir → one bin, regardless of a higher shardCount');
});

test('buildAuditShards: empty file list is handled without throwing', () => {
  const bins = buildAuditShards({ files: [], shardCount: 2 });
  assert.equal(bins.length, 1);
  assert.equal(bins[0].fileCount, 0);
});

// ─── Fixture helpers ─────────────────────────────────────────────────────────

async function makeShardFixture(label, { dirs = ['dirA', 'dirB'], auditOverrides = {} } = {}) {
  const name = `test-audit-shard-${label}-${randomUUID()}`;
  const projDir = path.join(PROJECTS_DIR, name);
  const workspaceDir = path.join(projDir, 'workspace');

  await fs.mkdir(path.join(projDir, '.guide'), { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });

  const git = (cmd) => execSync(cmd, { cwd: workspaceDir, stdio: 'pipe' });
  git('git init -q && git config user.email t@t && git config user.name t');
  for (const d of dirs) {
    await fs.mkdir(path.join(workspaceDir, d), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, d, 'a.js'), '1\n', 'utf-8');
    await fs.writeFile(path.join(workspaceDir, d, 'b.js'), '2\n', 'utf-8');
  }
  git('git add -A && git commit -qm one');

  await fs.writeFile(path.join(projDir, '.guide', 'plan.json'), JSON.stringify({ phases: [] }), 'utf-8');
  await fs.writeFile(path.join(projDir, '.guide', 'brief.md'), '# Brief\n\nTest brief.\n', 'utf-8');

  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
    $schema_version: 1, name, created_at: new Date(0).toISOString(),
    overrides: { repo_map: { enabled: false }, audit: { scan_shards: 2, shard_min_files: 2, ...auditOverrides } },
  }), 'utf-8');

  upsertProject({ name, tech_stack: 'node', total_phases: 1 });

  return { name, projDir, workspaceDir };
}

async function makeSmallRepoFixture(label) {
  const name = `test-audit-shard-small-${label}-${randomUUID()}`;
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

  // No audit overrides — exercises the SHIPPED defaults (scan_shards:2,
  // shard_min_files:150). This workspace has 1 tracked file, well under the
  // threshold, so it must stay on today's single-scan path unchanged.
  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
    $schema_version: 1, name, created_at: new Date(0).toISOString(),
    overrides: { repo_map: { enabled: false } },
  }), 'utf-8');

  upsertProject({ name, tech_stack: 'node', total_phases: 1 });

  return { name, projDir };
}

async function makeIncrementalFixture(label) {
  const name = `test-audit-shard-incr-${label}-${randomUUID()}`;
  const projDir = path.join(PROJECTS_DIR, name);
  const workspaceDir = path.join(projDir, 'workspace');
  const auditsDir = path.join(projDir, '.guide', 'audits');

  await fs.mkdir(path.join(projDir, '.guide'), { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });

  const git = (cmd) => execSync(cmd, { cwd: workspaceDir, stdio: 'pipe' });
  git('git init -q && git config user.email t@t && git config user.name t');
  await fs.writeFile(path.join(workspaceDir, 'a.js'), '1\n', 'utf-8');
  git('git add -A && git commit -qm one');
  const firstSha = git('git rev-parse HEAD').toString().trim();
  await fs.writeFile(path.join(workspaceDir, 'b.js'), '2\n', 'utf-8');
  git('git add -A && git commit -qm two');

  await fs.writeFile(path.join(projDir, '.guide', 'plan.json'), JSON.stringify({ phases: [] }), 'utf-8');
  await fs.writeFile(path.join(projDir, '.guide', 'brief.md'), '# Brief\n\nTest brief.\n', 'utf-8');

  await fs.mkdir(auditsDir, { recursive: true });
  await fs.writeFile(path.join(auditsDir, 'audit-1.md'), '# prior audit\n', 'utf-8');
  await fs.writeFile(path.join(auditsDir, '.last-audit.json'), JSON.stringify({ sha: firstSha, incremental_streak: 0 }), 'utf-8');

  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
    $schema_version: 1, name, created_at: new Date(0).toISOString(),
    // scan_shards>1 on purpose — an incremental re-audit must never reach
    // runTwoStageAudit (and therefore never shard) regardless of this config.
    overrides: { repo_map: { enabled: false }, audit: { scan_shards: 2, shard_min_files: 1 } },
  }), 'utf-8');

  upsertProject({ name, tech_stack: 'node', total_phases: 1 });

  return { name, projDir };
}

async function cleanup(projDir, name) {
  await fs.rm(projDir, { recursive: true, force: true }).catch(() => {});
  try { deleteProject(name); } catch { /* ignore */ }
}

// deps.runClaude stub: for every 'audit-scan' call, extracts the "Output to:
// X" path buildAuditScanPrompt embeds and writes a fixture scan file there.
// The adjudicate call ('audit' task) is a bare success stub.
function makeShardStub({ candidatesPerShard = 1 } = {}) {
  const calls = [];
  const runClaude = async (opts) => {
    calls.push(opts);
    if (opts.task === 'audit-scan') {
      const m = opts.prompt.match(/^Output to: (.+)$/m);
      const scanPath = path.join(opts.cwd, m[1]);
      const body = candidatesPerShard === 0
        ? '# Scan\n\nNo issues found.\n\ncandidates: 0\n'
        : `### CAND-1 — Sample issue\n- Where: a.js:1\n- Evidence: (fenced)\n- Suspicion: test fixture\n- Severity guess: MINOR\n\ncandidates: ${candidatesPerShard}\n`;
      await fs.writeFile(scanPath, body, 'utf-8');
    }
    return { result: 'ok', session_id: null, is_error: false, last_turn_context_tokens: null };
  };
  return { calls, runClaude };
}

// ─── Sharded scan — happy path (all shards succeed) ─────────────────────────

test('shards > 1: N concurrent audit-scan spawns, each role:null with disjoint scopeDirs and a distinct output path; adjudicate prompt names every shard file', async () => {
  const { name, projDir } = await makeShardFixture('happy');
  try {
    const { calls, runClaude } = makeShardStub({ candidatesPerShard: 1 });
    const result = await runGuide({ projectName: name, task: 'audit' }, { runClaude });

    assert.equal(result.is_error, false);

    const scanCalls = calls.filter((c) => c.task === 'audit-scan');
    assert.equal(scanCalls.length, 2, 'exactly one spawn per shard');
    for (const c of scanCalls) {
      assert.equal(c.role, null, 'shard spawns must never touch guide_session_id');
      assert.equal(c.sessionId, null);
    }

    const scopes = scanCalls.map((c) => c.prompt.match(/ONLY examine these paths \(other shards cover the rest\): (.+)/)[1]);
    assert.notEqual(scopes[0], scopes[1], 'each shard scoped to a disjoint set of directories');

    const outPaths = scanCalls.map((c) => c.prompt.match(/^Output to: (.+)$/m)[1]);
    assert.notEqual(outPaths[0], outPaths[1], 'each shard writes to its own output file');

    const adjCall = calls.find((c) => c.task === 'audit');
    assert.ok(adjCall, 'adjudication call happened');
    for (const p of outPaths) {
      assert.ok(adjCall.prompt.includes(p), `adjudicate prompt names shard file ${p}`);
    }

    assert.equal(result.two_stage.shard_count, 2);
    assert.equal(result.two_stage.scan_files.length, 2);
  } finally {
    await cleanup(projDir, name);
  }
});

// ─── Fail-open: any shard problem falls back to ONE full single scan ───────

test('one shard failure → exactly one fallback full scan, then adjudication over that single file (no partial-shard adjudication)', async () => {
  const { name, projDir } = await makeShardFixture('fail');
  try {
    const calls = [];
    let failedOnce = false;
    const runClaude = async (opts) => {
      calls.push(opts);
      if (opts.task === 'audit-scan') {
        if (opts.role === null && !failedOnce) {
          failedOnce = true;
          return { result: 'boom', session_id: null, is_error: true, error_message: 'stub shard failure' };
        }
        const m = opts.prompt.match(/^Output to: (.+)$/m);
        const scanPath = path.join(opts.cwd, m[1]);
        await fs.writeFile(scanPath, '### CAND-1 — x\n- Where: a.js:1\n- Evidence: (fenced)\n- Suspicion: t\n- Severity guess: MINOR\n\ncandidates: 1\n', 'utf-8');
      }
      return { result: 'ok', session_id: null, is_error: false };
    };

    const result = await runGuide({ projectName: name, task: 'audit' }, { runClaude });
    assert.equal(result.is_error, false);

    const scanCalls = calls.filter((c) => c.task === 'audit-scan');
    // 2 shard spawns (one fails) + 1 fallback single scan = 3
    assert.equal(scanCalls.length, 3, '2 shard attempts + exactly 1 fallback full scan');
    const fallback = scanCalls[scanCalls.length - 1];
    assert.equal(fallback.role, 'guide', 'the fallback scan takes the unsharded single-call path (role:guide)');

    assert.equal(result.two_stage.shard_count, undefined, 'a fallen-back run carries no shard metadata');
    assert.equal(result.two_stage.scan_files, undefined);
  } finally {
    await cleanup(projDir, name);
  }
});

// ─── Small repo (under shard_min_files) — today's single-scan path, byte-for-byte ───

test('a repo under shard_min_files (shipped defaults) takes today\'s single-scan path: one audit-scan spawn, role:"guide", no scope block in the prompt', async () => {
  const { name, projDir } = await makeSmallRepoFixture('below-threshold');
  try {
    const { calls, runClaude } = makeShardStub({ candidatesPerShard: 1 });
    const result = await runGuide({ projectName: name, task: 'audit' }, { runClaude });

    assert.equal(result.is_error, false);
    const scanCalls = calls.filter((c) => c.task === 'audit-scan');
    assert.equal(scanCalls.length, 1, 'no sharding below shard_min_files');
    assert.equal(scanCalls[0].role, 'guide');
    assert.ok(!scanCalls[0].prompt.includes('ONLY examine these paths'), 'no scope block appended — byte-identical prompt shape to pre-Phase-53');
    assert.equal(result.two_stage.shard_count, undefined);
  } finally {
    await cleanup(projDir, name);
  }
});

// ─── Incremental audits are untouched ───────────────────────────────────────

test('an incremental re-audit never reaches the sharded scan path, even with scan_shards>1 configured', async () => {
  const { name, projDir } = await makeIncrementalFixture('untouched');
  try {
    const calls = [];
    const runClaude = async (opts) => {
      calls.push(opts);
      return { result: 'ok', session_id: null, is_error: false };
    };
    const result = await runGuide({ projectName: name, task: 'audit' }, { runClaude });

    assert.equal(result.is_error, false);
    assert.equal(result.audit_scope, 'incremental');
    assert.equal(calls.length, 1, 'incremental re-audits are single-call — no scan/adjudicate split, no shards');
    assert.equal(calls[0].task, 'audit-incremental');
  } finally {
    await cleanup(projDir, name);
  }
});
