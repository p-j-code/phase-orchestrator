import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Set DB_PATH before any code calls getDb() — state.js is lazy-initialized
const testDbDir = mkdtempSync(path.join(tmpdir(), 'aorch-scanner-'));
process.env.DB_PATH = path.join(testDbDir, 'test.db');

import { scanProject, classifyProject } from './project-scanner.js';
import { getDb, upsertProject } from '../state.js';

const tmpDirs = [testDbDir];

after(async () => {
  for (const d of tmpDirs) {
    await rm(d, { recursive: true, force: true });
  }
});

async function makeTmpDir() {
  const d = await mkdtemp(path.join(tmpdir(), 'aorch-scanner-'));
  tmpDirs.push(d);
  return d;
}

// ─── Classification unit tests (no I/O) ─────────────────────────────────────

test('CLI classification — hasBin:true, no frontend deps', () => {
  const result = classifyProject({ hasBin: true, dependencies: [] });
  assert.equal(result, 'cli');
});

test('Frontend classification — react in deps, no backend', () => {
  const result = classifyProject({ hasBin: false, dependencies: ['react', 'react-dom'] });
  assert.equal(result, 'frontend');
});

test('API classification — express in deps, no frontend', () => {
  const result = classifyProject({ hasBin: false, dependencies: ['express', 'cors'] });
  assert.equal(result, 'api');
});

test('Fullstack classification — react and express both in deps', () => {
  const result = classifyProject({ hasBin: false, dependencies: ['react', 'express'] });
  assert.equal(result, 'fullstack');
});

test('Unknown classification — empty deps, hasBin false', () => {
  const result = classifyProject({ hasBin: false, dependencies: [] });
  assert.equal(result, 'unknown');
});

test('CLI via dep — hasBin:false but commander in deps, no frontend', () => {
  const result = classifyProject({ hasBin: false, dependencies: ['commander', 'chalk'] });
  assert.equal(result, 'cli');
});

// ─── Integration tests (real filesystem) ─────────────────────────────────────

test('Best-effort null behavior — empty dir, no throw', async () => {
  const dir = await makeTmpDir();
  const snapshot = await scanProject(dir);
  assert.equal(snapshot.projectType, 'unknown');
  assert.equal(snapshot.description, null);
  assert.deepEqual(snapshot.dependencies, []);
  assert.deepEqual(snapshot.scripts, []);
  assert.equal(snapshot.hasBin, false);
  assert.equal(snapshot.readmeExcerpt, null);
  assert.equal(snapshot.handoffExcerpt, null);
  assert.equal(snapshot.rawThoughtsExcerpt, null);
});

test('Missing package.json — name falls back to dirname, dependencies is []', async () => {
  const dir = await makeTmpDir();
  const snapshot = await scanProject(dir);
  assert.equal(snapshot.name, path.basename(dir));
  assert.deepEqual(snapshot.dependencies, []);
});

test('CLI project via package.json bin field', async () => {
  const dir = await makeTmpDir();
  await mkdir(path.join(dir, 'workspace'), { recursive: true });
  await writeFile(path.join(dir, 'workspace', 'package.json'), JSON.stringify({
    name: 'my-cli-tool',
    bin: { 'my-cli': './index.js' },
    dependencies: {},
  }));
  const snapshot = await scanProject(dir);
  assert.equal(snapshot.projectType, 'cli');
  assert.equal(snapshot.hasBin, true);
  assert.equal(snapshot.name, 'my-cli-tool');
});

test('Frontend project via package.json dependencies', async () => {
  const dir = await makeTmpDir();
  await mkdir(path.join(dir, 'workspace'), { recursive: true });
  await writeFile(path.join(dir, 'workspace', 'package.json'), JSON.stringify({
    name: 'my-app',
    dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
  }));
  const snapshot = await scanProject(dir);
  assert.equal(snapshot.projectType, 'frontend');
});

test('scanProject includes scannedAt ISO timestamp', async () => {
  const dir = await makeTmpDir();
  const snapshot = await scanProject(dir);
  assert.match(snapshot.scannedAt, /^\d{4}-\d{2}-\d{2}T/);
});

// ─── Real orchestrator layout tests ──────────────────────────────────────────

test('Real layout — workspace/package.json react deps → frontend; handoffExcerpt populated', async () => {
  const dir = await makeTmpDir();
  await mkdir(path.join(dir, 'workspace'), { recursive: true });
  await mkdir(path.join(dir, '.guide', 'handoffs'), { recursive: true });

  await writeFile(path.join(dir, 'workspace', 'package.json'), JSON.stringify({
    name: 'ashmero-frontend',
    dependencies: { react: '^18.0.0', vite: '^5.0.0' },
  }));

  const handoffContent = 'Phase 3 complete. All API routes wired up. Next: add auth middleware.';
  await writeFile(
    path.join(dir, '.guide', 'handoffs', 'handoff-2026-06-01T00-00-00.md'),
    handoffContent,
  );

  const snapshot = await scanProject(dir);

  assert.equal(snapshot.projectType, 'frontend');
  assert.ok(snapshot.dependencies.includes('react'), 'react in deps');
  assert.ok(snapshot.dependencies.includes('vite'), 'vite in deps');
  assert.equal(snapshot.completedPhases, 0);
  assert.notEqual(snapshot.handoffExcerpt, null, 'handoffExcerpt should be populated');
  assert.ok(snapshot.handoffExcerpt.includes('Phase 3 complete'), 'handoffExcerpt has expected content');
});

test('Real layout — workspace/package.json express-only → api', async () => {
  const dir = await makeTmpDir();
  await mkdir(path.join(dir, 'workspace'), { recursive: true });

  await writeFile(path.join(dir, 'workspace', 'package.json'), JSON.stringify({
    name: 'my-api-server',
    dependencies: { express: '^4.18.0', cors: '^2.8.5' },
  }));

  const snapshot = await scanProject(dir);

  assert.equal(snapshot.projectType, 'api');
  assert.ok(snapshot.dependencies.includes('express'), 'express in deps');
});

test('Real layout — DB key uses basename not pkg.name', async () => {
  // Folder name = 'aorch', pkg.name = 'ashmero-orchestrator' — they differ.
  // completedPhases should query by 'aorch' (basename), returning 0 from the empty test DB.
  const dir = await makeTmpDir();
  await mkdir(path.join(dir, 'workspace'), { recursive: true });

  await writeFile(path.join(dir, 'workspace', 'package.json'), JSON.stringify({
    name: 'ashmero-orchestrator',
    dependencies: { commander: '^11.0.0' },
  }));

  const snapshot = await scanProject(dir);

  // snapshot.name is set from pkg.name for display
  assert.equal(snapshot.name, 'ashmero-orchestrator');
  // But DB phases query used basename(dir) — no rows → completedPhases stays 0
  assert.equal(snapshot.completedPhases, 0);
  // Classification still works correctly from workspace/package.json
  assert.equal(snapshot.projectType, 'cli');
});

test('handoffExcerpt is null when .guide/handoffs/ is empty or absent', async () => {
  const dir = await makeTmpDir();
  // No .guide/handoffs/ created at all
  const snapshotNoDir = await scanProject(dir);
  assert.equal(snapshotNoDir.handoffExcerpt, null);

  // Create empty .guide/handoffs/ with no handoff files
  const dir2 = await makeTmpDir();
  await mkdir(path.join(dir2, '.guide', 'handoffs'), { recursive: true });
  const snapshotEmptyDir = await scanProject(dir2);
  assert.equal(snapshotEmptyDir.handoffExcerpt, null);
});

test('rootDirs captures directory names including .github', async () => {
  const dir = await makeTmpDir();
  await mkdir(path.join(dir, 'workspace'), { recursive: true });
  await mkdir(path.join(dir, 'workspace', '.github'), { recursive: true });
  await writeFile(path.join(dir, 'workspace', 'README.md'), '# Test');

  const snapshot = await scanProject(dir);

  assert.ok(snapshot.rootDirs.includes('.github'), 'rootDirs should include .github');
  assert.ok(!snapshot.rootFiles.includes('.github'), 'rootFiles must not include directories');
  assert.ok(snapshot.rootFiles.includes('README.md'), 'rootFiles should include README.md');
});

test('rootDirs is empty when workspace has no directories', async () => {
  const dir = await makeTmpDir();
  await mkdir(path.join(dir, 'workspace'), { recursive: true });
  await writeFile(path.join(dir, 'workspace', 'index.js'), '// entry');

  const snapshot = await scanProject(dir);

  assert.deepEqual(snapshot.rootDirs, [], 'rootDirs should be empty when no directories exist');
  assert.ok(snapshot.rootFiles.includes('index.js'), 'rootFiles should list files');
});

// ─── runGit null propagation ─────────────────────────────────────────────────

test('gitLogExcerpt is null for a non-git workspace dir (runGit returns null)', async () => {
  // A fresh temp dir is never a git repo, so runGit returns null without throwing.
  // This test verifies the null propagates cleanly and the rest of the snapshot is intact.
  const dir = await makeTmpDir();
  await mkdir(path.join(dir, 'workspace'), { recursive: true });
  await writeFile(path.join(dir, 'workspace', 'package.json'), JSON.stringify({
    name: 'test-non-git',
    dependencies: { express: '^4.0.0' },
  }));

  const snapshot = await scanProject(dir);

  assert.equal(snapshot.gitLogExcerpt, null, 'gitLogExcerpt must be null for a non-git dir');
  assert.equal(snapshot.projectType, 'api', 'rest of snapshot still classifies correctly');
  assert.ok(snapshot.dependencies.includes('express'), 'dependencies still populated');
  assert.match(snapshot.scannedAt, /^\d{4}-\d{2}-\d{2}T/, 'scannedAt still set');
});

// ─── Bug r26-1: substring false-positives ────────────────────────────────────

test('vitest dep does NOT trigger frontend signal — stays api', () => {
  const result = classifyProject({ hasBin: false, dependencies: ['vitest', 'express'] });
  assert.equal(result, 'api');
});

test('vitepress dep does NOT trigger frontend signal — stays cli', () => {
  const result = classifyProject({ hasBin: false, dependencies: ['commander', 'vitepress'] });
  assert.equal(result, 'cli');
});

test('@testing-library/react does NOT trigger frontend signal — stays api', () => {
  const result = classifyProject({
    hasBin: false,
    dependencies: ['@testing-library/react', 'express'],
  });
  assert.equal(result, 'api');
});

test('next-auth does NOT trigger frontend signal — stays api', () => {
  const result = classifyProject({ hasBin: false, dependencies: ['next-auth', 'express'] });
  assert.equal(result, 'api');
});

// ─── Regression: correct positives still work ────────────────────────────────

test('real vite dep still triggers frontend signal', () => {
  const result = classifyProject({ hasBin: false, dependencies: ['vite', 'react'] });
  assert.equal(result, 'frontend');
});

test('react-dom still triggers frontend signal', () => {
  const result = classifyProject({ hasBin: false, dependencies: ['react-dom', 'express'] });
  assert.equal(result, 'fullstack');
});

test('real next dep still triggers frontend signal', () => {
  const result = classifyProject({ hasBin: false, dependencies: ['next', 'react'] });
  assert.equal(result, 'frontend');
});

// ─── Bug r37-1: openBugCount uses bug_inbox not bugs ─────────────────────────

test('openBugCount returns non-zero for inbox/refined bug_inbox rows', async () => {
  const dir = await makeTmpDir();
  const projectKey = path.basename(dir);

  // Ensure the project row exists (bug_inbox has FK on projects.name)
  upsertProject({ name: projectKey, tech_stack: 'node', profile: '{}' });

  const db = getDb();
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO bug_inbox (project, raw_text, severity, status, created_at, updated_at)
     VALUES (?, ?, 'low', ?, ?, ?)`,
  );
  insert.run(projectKey, 'bug one', 'inbox', now, now);
  insert.run(projectKey, 'bug two', 'refined', now, now);
  insert.run(projectKey, 'bug three (promoted)', 'promoted', now, now);

  const snapshot = await scanProject(dir);
  assert.equal(snapshot.openBugCount, 2, 'openBugCount must count only inbox+refined rows');
});

test('openBugCount returns 0 when all bug_inbox rows are promoted or dropped', async () => {
  const dir = await makeTmpDir();
  const projectKey = path.basename(dir);

  upsertProject({ name: projectKey, tech_stack: 'node', profile: '{}' });

  const db = getDb();
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO bug_inbox (project, raw_text, severity, status, created_at, updated_at)
     VALUES (?, ?, 'low', ?, ?, ?)`,
  );
  insert.run(projectKey, 'bug promoted', 'promoted', now, now);
  insert.run(projectKey, 'bug dropped', 'dropped', now, now);

  const snapshot = await scanProject(dir);
  assert.equal(snapshot.openBugCount, 0, 'openBugCount must be 0 when no inbox/refined rows exist');
});
