// Regression tests for skip-analyzer glob support
//
// Bug fixed: files_expected entries containing `*` (e.g. `src/library/aiAnimation/*`)
// were previously passed to fs.access(), which looks for a literal file named `*` —
// always failing. After the fix, glob patterns strip to the parent dir and use
// fs.readdir() to verify the dir exists and is non-empty.
//
// Run: node src/lib/skip-analyzer.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Must be set before any module that calls getDb() is loaded.
process.env.DB_PATH = ':memory:';

const { analyzeSkippedPhases } = await import('./skip-analyzer.js');
const { upsertProject, upsertPhase, markPhaseCompleted, setCurrentPhase, getDb } = await import('../state.js');

// ─── helpers ────────────────────────────────────────────────────────────────

let tmpCounter = 0;

async function makeTmpWorkspace() {
  const dir = path.join(os.tmpdir(), `skip-analyzer-test-${process.pid}-${++tmpCounter}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function rmrf(p) {
  try { await fs.rm(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Set up a minimal project + completed phase so analyzeSkippedPhases can query
 * the DB for phase rows. Returns { projectName }.
 *
 * The phase is inserted with status=completed and a dummy commit_sha so that
 * db_integrity checks pass (we set checks.db_integrity = false anyway, but
 * this keeps things clean for future tests that may enable it).
 */
function setupProjectAndPhase(suffix, phaseN = 1) {
  const projectName = `skip-test-${suffix}`;
  upsertProject({ name: projectName, tech_stack: 'node', total_phases: 1 });
  setCurrentPhase(projectName, phaseN);
  upsertPhase({ project: projectName, n: phaseN, title: `Phase ${phaseN}`, status: 'pending' });
  markPhaseCompleted({ project: projectName, n: phaseN, commit_sha: 'abc1234' });
  return { projectName };
}

// Minimal plan object matching the shape analyzeSkippedPhases expects.
function makePlan(phases) {
  return { phases };
}

// Checks arg: disable everything except files_expected to keep tests focused.
const FILES_ONLY_CHECKS = {
  db_integrity: false,
  phase_commits: false,
  files_expected: true,
  phase_reports: false,
};

// ─── Test 1: glob path — directory EXISTS with files → no gap ────────────────

test('glob path: directory exists and is non-empty → no gap reported', async () => {
  const workspaceDir = await makeTmpWorkspace();
  try {
    // Create the directory with a file in it
    const targetDir = path.join(workspaceDir, 'src', 'library', 'aiAnimation');
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, 'index.js'), '// placeholder');

    const { projectName } = setupProjectAndPhase('glob-exists');
    const plan = makePlan([
      { n: 1, title: 'Phase 1', files_expected: ['src/library/aiAnimation/*'] },
    ]);

    const result = await analyzeSkippedPhases({
      projectName,
      plan,
      workspaceDir,
      projDir: workspaceDir,
      completedPhase: 1,
      checks: FILES_ONLY_CHECKS,
    });

    assert.equal(result.hasGaps, false, 'should have no gaps when glob dir exists and is non-empty');
    const fileGaps = result.gaps.filter((g) => g.issues.some((i) => i.includes('expected file missing')));
    assert.equal(fileGaps.length, 0, 'no "expected file missing" issues expected');
  } finally {
    await rmrf(workspaceDir);
  }
});

// ─── Test 2: glob path — directory MISSING → gap reported ────────────────────

test('glob path: directory is missing → gap reported with "expected file missing"', async () => {
  const workspaceDir = await makeTmpWorkspace();
  try {
    // Do NOT create the directory
    const { projectName } = setupProjectAndPhase('glob-missing');
    const plan = makePlan([
      { n: 1, title: 'Phase 1', files_expected: ['src/library/aiAnimation/*'] },
    ]);

    const result = await analyzeSkippedPhases({
      projectName,
      plan,
      workspaceDir,
      projDir: workspaceDir,
      completedPhase: 1,
      checks: FILES_ONLY_CHECKS,
    });

    assert.equal(result.hasGaps, true, 'should have a gap when glob dir is missing');
    const phase1Gap = result.gaps.find((g) => g.n === 1);
    assert.ok(phase1Gap, 'gap should be for phase 1');
    assert.ok(
      phase1Gap.issues.some((i) => i.includes('expected file missing')),
      `gap issues should mention "expected file missing"; got: ${JSON.stringify(phase1Gap.issues)}`,
    );
    assert.ok(
      phase1Gap.issues.some((i) => i.includes('src/library/aiAnimation/*')),
      `gap issue should mention the glob path; got: ${JSON.stringify(phase1Gap.issues)}`,
    );
  } finally {
    await rmrf(workspaceDir);
  }
});

// ─── Test 3: glob path — directory EXISTS but is EMPTY → gap reported ────────

test('glob path: directory exists but is empty → gap reported', async () => {
  const workspaceDir = await makeTmpWorkspace();
  try {
    // Create the directory but leave it empty
    const targetDir = path.join(workspaceDir, 'src', 'library', 'aiAnimation');
    await fs.mkdir(targetDir, { recursive: true });

    const { projectName } = setupProjectAndPhase('glob-empty');
    const plan = makePlan([
      { n: 1, title: 'Phase 1', files_expected: ['src/library/aiAnimation/*'] },
    ]);

    const result = await analyzeSkippedPhases({
      projectName,
      plan,
      workspaceDir,
      projDir: workspaceDir,
      completedPhase: 1,
      checks: FILES_ONLY_CHECKS,
    });

    assert.equal(result.hasGaps, true, 'should have a gap when glob dir is empty');
    const phase1Gap = result.gaps.find((g) => g.n === 1);
    assert.ok(phase1Gap, 'gap should be for phase 1');
    assert.ok(
      phase1Gap.issues.some((i) => i.includes('expected file missing')),
      `gap issues should mention "expected file missing"; got: ${JSON.stringify(phase1Gap.issues)}`,
    );
  } finally {
    await rmrf(workspaceDir);
  }
});

// ─── Test 4: plain path — file EXISTS → no gap ───────────────────────────────

test('plain path: file exists → no gap reported', async () => {
  const workspaceDir = await makeTmpWorkspace();
  try {
    // Create the exact file
    await fs.mkdir(path.join(workspaceDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, 'src', 'index.js'), '// ok');

    const { projectName } = setupProjectAndPhase('plain-exists');
    const plan = makePlan([
      { n: 1, title: 'Phase 1', files_expected: ['src/index.js'] },
    ]);

    const result = await analyzeSkippedPhases({
      projectName,
      plan,
      workspaceDir,
      projDir: workspaceDir,
      completedPhase: 1,
      checks: FILES_ONLY_CHECKS,
    });

    assert.equal(result.hasGaps, false, 'should have no gaps when plain file exists');
    const fileGaps = result.gaps.filter((g) => g.issues.some((i) => i.includes('expected file missing')));
    assert.equal(fileGaps.length, 0, 'no "expected file missing" issues expected');
  } finally {
    await rmrf(workspaceDir);
  }
});

// ─── Test 5: plain path — file DOES NOT exist → gap reported ─────────────────
// NOTE: commit checking is disabled in FILES_ONLY_CHECKS so commitVerified=false,
// meaning the gap is NOT onlyFileGap — file-missing gaps still rewind when
// commit verification hasn't been run.

test('plain path: file does not exist → gap reported', async () => {
  const workspaceDir = await makeTmpWorkspace();
  try {
    // Do NOT create any files

    const { projectName } = setupProjectAndPhase('plain-missing');
    const plan = makePlan([
      { n: 1, title: 'Phase 1', files_expected: ['src/index.js'] },
    ]);

    const result = await analyzeSkippedPhases({
      projectName,
      plan,
      workspaceDir,
      projDir: workspaceDir,
      completedPhase: 1,
      checks: FILES_ONLY_CHECKS,
    });

    assert.equal(result.hasGaps, true, 'should have a gap when plain file is missing');
    const phase1Gap = result.gaps.find((g) => g.n === 1);
    assert.ok(phase1Gap, 'gap should be for phase 1');
    assert.ok(
      phase1Gap.issues.some((i) => i.includes('expected file missing')),
      `gap issues should mention "expected file missing"; got: ${JSON.stringify(phase1Gap.issues)}`,
    );
    assert.ok(
      phase1Gap.issues.some((i) => i.includes('src/index.js')),
      `gap issue should mention the file path; got: ${JSON.stringify(phase1Gap.issues)}`,
    );
  } finally {
    await rmrf(workspaceDir);
  }
});

// ─── Test 6: multi-file spec "foo.ts + bar.ts" — both exist → no gap ─────────
// Regression for the acf loop: guide writes "file1.ts + file2.ts" as one spec.
// Old parser treated it as a single filename, always "missing".

test('multi-file + spec: both files exist → no gap', async () => {
  const workspaceDir = await makeTmpWorkspace();
  try {
    const dir = path.join(workspaceDir, 'src', 'lib');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'capacity.test.ts'), '');
    await fs.writeFile(path.join(dir, 'generate.test.ts'), '');

    const { projectName } = setupProjectAndPhase('multi-plus-exists');
    const plan = makePlan([{ n: 1, title: 'P1', files_expected: [
      'workspace/src/lib/capacity.test.ts + generate.test.ts (modified/new)',
    ]}]);

    const result = await analyzeSkippedPhases({
      projectName, plan, workspaceDir, projDir: workspaceDir,
      completedPhase: 1, checks: FILES_ONLY_CHECKS,
    });

    assert.equal(result.hasGaps, false,
      `expected no gaps; got: ${JSON.stringify(result.gaps.map(g => g.issues))}`);
  } finally { await rmrf(workspaceDir); }
});

// ─── Test 7: multi-file + spec — first exists, second missing → gap ──────────

test('multi-file + spec: one file missing → gap names only the missing file', async () => {
  const workspaceDir = await makeTmpWorkspace();
  try {
    const dir = path.join(workspaceDir, 'src', 'lib');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'capacity.test.ts'), '');
    // generate.test.ts intentionally absent

    const { projectName } = setupProjectAndPhase('multi-plus-missing');
    const plan = makePlan([{ n: 1, title: 'P1', files_expected: [
      'workspace/src/lib/capacity.test.ts + generate.test.ts (modified/new)',
    ]}]);

    const result = await analyzeSkippedPhases({
      projectName, plan, workspaceDir, projDir: workspaceDir,
      completedPhase: 1, checks: FILES_ONLY_CHECKS,
    });

    assert.equal(result.hasGaps, true);
    const g = result.gaps.find(g => g.n === 1);
    assert.ok(g?.issues.some(i => i.includes('generate.test.ts')), 'missing file named');
    assert.ok(!g?.issues.some(i => i.includes('capacity.test.ts')), 'present file not named');
  } finally { await rmrf(workspaceDir); }
});

// ─── Test 8: two full workspace/ paths with + separator, both exist ───────────
// Exact spec from acf phase 117: "workspace/src/lib/README.md + workspace/THEME.md"

test('multi-file + spec: two workspace/ paths both exist → no gap', async () => {
  const workspaceDir = await makeTmpWorkspace();
  try {
    const libDir = path.join(workspaceDir, 'src', 'lib');
    await fs.mkdir(libDir, { recursive: true });
    await fs.writeFile(path.join(libDir, 'README.md'), '');
    await fs.writeFile(path.join(workspaceDir, 'THEME_ENGINE.md'), '');

    const { projectName } = setupProjectAndPhase('multi-two-workspace');
    const plan = makePlan([{ n: 1, title: 'P1', files_expected: [
      'workspace/src/lib/README.md + workspace/THEME_ENGINE.md (status badges)',
    ]}]);

    const result = await analyzeSkippedPhases({
      projectName, plan, workspaceDir, projDir: workspaceDir,
      completedPhase: 1, checks: FILES_ONLY_CHECKS,
    });

    assert.equal(result.hasGaps, false,
      `expected no gaps; got: ${JSON.stringify(result.gaps.map(g => g.issues))}`);
  } finally { await rmrf(workspaceDir); }
});

// ─── Test 9: comma-separated multi-file spec ─────────────────────────────────

test('multi-file comma spec: both files exist → no gap', async () => {
  const workspaceDir = await makeTmpWorkspace();
  try {
    const dir = path.join(workspaceDir, 'src');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'foo.ts'), '');
    await fs.writeFile(path.join(dir, 'bar.ts'), '');

    const { projectName } = setupProjectAndPhase('multi-comma');
    const plan = makePlan([{ n: 1, title: 'P1', files_expected: [
      'workspace/src/foo.ts, bar.ts (modified)',
    ]}]);

    const result = await analyzeSkippedPhases({
      projectName, plan, workspaceDir, projDir: workspaceDir,
      completedPhase: 1, checks: FILES_ONLY_CHECKS,
    });

    assert.equal(result.hasGaps, false,
      `expected no gaps; got: ${JSON.stringify(result.gaps.map(g => g.issues))}`);
  } finally { await rmrf(workspaceDir); }
});

// ─── Test 10: onlyFileGap=false when commit checks disabled ───────────────────
// When commit verification hasn't run (checks disabled), commitVerified=false.
// File-missing gaps must NOT be classified as onlyFileGap — they should still
// trigger a rewind via firstMissing.

test('onlyFileGap=false when commit checks disabled: file gap still triggers rewind', async () => {
  const workspaceDir = await makeTmpWorkspace();
  try {
    const { projectName } = setupProjectAndPhase('only-file-no-commit-check');
    const plan = makePlan([{ n: 1, title: 'P1', files_expected: ['src/missing.ts'] }]);

    const result = await analyzeSkippedPhases({
      projectName, plan, workspaceDir, projDir: workspaceDir,
      completedPhase: 1,
      checks: { db_integrity: false, phase_commits: false, files_expected: true, phase_reports: false },
    });

    const g = result.gaps[0];
    assert.equal(g.commitVerified, false, 'commitVerified should be false when checks disabled');
    assert.equal(g.onlyFileGap, false,
      'onlyFileGap must be false when commitVerified=false — file gaps must still trigger rewind');
    assert.notEqual(result.firstMissing, null,
      'firstMissing must not be null — gap should be rewind-worthy');
  } finally { await rmrf(workspaceDir); }
});

// ─── Test 11: completed row without SHA is warning-only ─────────────────────
// A legacy run can commit successfully but miss the DB completion SHA. That is
// metadata debt, not evidence that the phase did not run; auto-rewinding it
// duplicates work indefinitely.

test('completed row with NULL commit_sha is reported but never selected for rewind', async () => {
  const workspaceDir = await makeTmpWorkspace();
  try {
    const projectName = 'skip-test-null-sha';
    upsertProject({ name: projectName, tech_stack: 'node', total_phases: 1 });
    setCurrentPhase(projectName, 1);
    upsertPhase({ project: projectName, n: 1, title: 'Phase 1', status: 'pending' });
    markPhaseCompleted({ project: projectName, n: 1 });

    const result = await analyzeSkippedPhases({
      projectName,
      plan: makePlan([{ n: 1, title: 'Phase 1' }]),
      workspaceDir,
      projDir: workspaceDir,
      completedPhase: 1,
      checks: { phase_commits: false, files_expected: false, phase_reports: false },
    });

    assert.equal(result.hasGaps, true, 'the metadata defect remains visible');
    assert.equal(result.gaps[0]?.onlyStateGap, true, 'NULL SHA is classified as a state-only gap');
    assert.equal(result.firstMissing, null, 'state-only gaps must never trigger automatic rewind');
  } finally { await rmrf(workspaceDir); }
});
