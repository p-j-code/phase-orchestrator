// Tests for phaseVerifyPath (phase-2 of the L2 verification loop — see
// docs/VERIFY_LOOP.md §4). It must resolve to verify.json inside the same
// NN-slug phase directory that phaseReportPath resolves report.md into,
// reusing findPhaseDir exactly like phaseReportPath does.
//
// Run with: node --test src/lib/guide-paths.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  phaseVerifyPath, phaseReportPath, phaseDirFromTitle, fixDirFromTitle,
  assertInsideDir, fixVerifyPath, fixReportPath, phaseLedgerPath, guideRoot,
  projectConventionsPath, projectConventionsStampPath,
} from './guide-paths.js';
import { slugify } from './slug.js';

async function mkProjectDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'aorch-guide-paths-test-'));
}

test('phaseVerifyPath resolves verify.json inside an EXISTING NN-slug phase dir found via findPhaseDir', async () => {
  const projectDir = await mkProjectDir();
  try {
    const phasesDir = path.join(projectDir, '.guide', 'phases');
    const existingDir = path.join(phasesDir, '03-fvu-file-builder');
    await fs.mkdir(existingDir, { recursive: true });

    // No fallbackTitle passed — findPhaseDir's NN- prefix match must be used
    // as-is, exactly like phaseReportPath does.
    const verifyPath = await phaseVerifyPath(projectDir, 3);
    const reportPath = await phaseReportPath(projectDir, 3);

    assert.equal(verifyPath, path.join(existingDir, 'verify.json'));
    assert.equal(path.dirname(verifyPath), path.dirname(reportPath), 'verify.json and report.md share the same phase dir');
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

test('phaseVerifyPath matches phaseReportPath when a title mismatch reroutes both to the title-derived dir', async () => {
  const projectDir = await mkProjectDir();
  try {
    const phasesDir = path.join(projectDir, '.guide', 'phases');
    // Existing dir belongs to a superseded plan (different title for phase 3).
    await fs.mkdir(path.join(phasesDir, '03-old-superseded-title'), { recursive: true });

    const verifyPath = await phaseVerifyPath(projectDir, 3, 'fvu file builder');
    const reportPath = await phaseReportPath(projectDir, 3, 'fvu file builder');
    const expectedDir = await phaseDirFromTitle(projectDir, 3, 'fvu file builder');

    assert.equal(verifyPath, path.join(expectedDir, 'verify.json'));
    assert.equal(path.dirname(verifyPath), path.dirname(reportPath), 'both reroute to the same new-plan dir on title mismatch');
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

// ─── phaseLedgerPath (Phase 37 / CE-1) ──────────────────────────────────────

test('phaseLedgerPath resolves to a flat .guide/phase-ledger.jsonl file (sibling to decisions.jsonl, not nested per-phase)', async () => {
  const projectDir = await mkProjectDir();
  try {
    assert.equal(phaseLedgerPath(projectDir), path.join(guideRoot(projectDir), 'phase-ledger.jsonl'));
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

// ─── projectConventionsPath / projectConventionsStampPath (Phase 42) ────────

test('projectConventionsPath / projectConventionsStampPath resolve to flat .guide/ files, sibling to phase-ledger.jsonl (not nested per-phase)', async () => {
  const projectDir = await mkProjectDir();
  try {
    assert.equal(projectConventionsPath(projectDir), path.join(guideRoot(projectDir), 'project-conventions.md'));
    assert.equal(projectConventionsStampPath(projectDir), path.join(guideRoot(projectDir), 'project-conventions.stamp.json'));
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

test('phaseVerifyPath falls back to the title-derived dir when no NN- folder exists yet, matching phaseReportPath', async () => {
  const projectDir = await mkProjectDir();
  try {
    const verifyPath = await phaseVerifyPath(projectDir, 7, 'Build the FVU File Builder');
    const reportPath = await phaseReportPath(projectDir, 7, 'Build the FVU File Builder');
    const expectedDir = await phaseDirFromTitle(projectDir, 7, 'Build the FVU File Builder');

    assert.equal(verifyPath, path.join(expectedDir, 'verify.json'));
    assert.equal(path.dirname(verifyPath), path.dirname(reportPath));
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

// ─── fixVerifyPath (phase-30) — sibling to fixReportPath ────────────────────

test('fixVerifyPath resolves verify.json inside an EXISTING NN-slug fix dir found via findFixDir, matching fixReportPath', async () => {
  const projectDir = await mkProjectDir();
  try {
    const fixesDir = path.join(projectDir, '.guide', 'bug-rounds', 'round-2', 'fixes');
    const existingDir = path.join(fixesDir, '03-upload-security-hardening');
    await fs.mkdir(existingDir, { recursive: true });

    const verifyPath = await fixVerifyPath(projectDir, 2, 3);
    const reportPath = await fixReportPath(projectDir, 2, 3);

    assert.equal(verifyPath, path.join(existingDir, 'verify.json'));
    assert.equal(path.dirname(verifyPath), path.dirname(reportPath), 'verify.json and report.md share the same fix dir');
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

test('fixVerifyPath falls back to the title-derived dir when no NN- folder exists yet, matching fixReportPath', async () => {
  const projectDir = await mkProjectDir();
  try {
    const verifyPath = await fixVerifyPath(projectDir, 2, 3, 'Upload security hardening');
    const reportPath = await fixReportPath(projectDir, 2, 3, 'Upload security hardening');
    const expectedDir = await fixDirFromTitle(projectDir, 2, 3, 'Upload security hardening');

    assert.equal(verifyPath, path.join(expectedDir, 'verify.json'));
    assert.equal(path.dirname(verifyPath), path.dirname(reportPath));
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

// ─── assertInsideDir + phaseDirFromTitle/fixDirFromTitle traversal guards ───

test('phaseDirFromTitle produces the same slug/path as before this phase for a normal title (no regression)', async () => {
  const projectDir = await mkProjectDir();
  try {
    const result = await phaseDirFromTitle(projectDir, 1, 'Verify config foundation');
    assert.equal(result, path.join(projectDir, '.guide', 'phases', '01-verify-config-foundation'));
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

test('fixDirFromTitle produces the same slug/path as before this phase for a normal title (no regression)', async () => {
  const projectDir = await mkProjectDir();
  try {
    const result = await fixDirFromTitle(projectDir, 2, 3, 'Upload security hardening');
    assert.equal(result, path.join(projectDir, '.guide', 'bug-rounds', 'round-2', 'fixes', '03-upload-security-hardening'));
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

test('assertInsideDir does not throw for a normal path nested under baseDir', async () => {
  const projectDir = await mkProjectDir();
  try {
    const phasesDir = path.join(projectDir, '.guide', 'phases');
    const candidate = path.join(phasesDir, '01-normal-phase');
    await assert.doesNotReject(() => assertInsideDir(phasesDir, candidate));
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

test('assertInsideDir rejects a traversal candidate that resolves outside baseDir', async () => {
  const projectDir = await mkProjectDir();
  try {
    const phasesDir = path.join(projectDir, '.guide', 'phases');
    await fs.mkdir(phasesDir, { recursive: true });
    // Two levels up from phasesDir is projectDir — well outside phasesDir itself.
    const escaped = path.join(phasesDir, '..', '..', 'escaped-outside');
    await assert.rejects(
      () => assertInsideDir(phasesDir, escaped),
      (err) => {
        assert.match(err.message, /assertInsideDir/);
        assert.match(err.message, /escaped-outside/);
        return true;
      },
    );
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

test('assertInsideDir rejects an absolute-path candidate that resolves outside baseDir', async () => {
  const projectDir = await mkProjectDir();
  try {
    const phasesDir = path.join(projectDir, '.guide', 'phases');
    await fs.mkdir(phasesDir, { recursive: true });
    await assert.rejects(
      () => assertInsideDir(phasesDir, '/etc/passwd'),
      /assertInsideDir/,
    );
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

test('assertInsideDir rejects a symlinked phase dir that resolves outside baseDir', async () => {
  const projectDir = await mkProjectDir();
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aorch-guide-paths-outside-'));
  try {
    const phasesDir = path.join(projectDir, '.guide', 'phases');
    await fs.mkdir(phasesDir, { recursive: true });
    const symlinkPath = path.join(phasesDir, '01-evil-link');
    await fs.symlink(outsideDir, symlinkPath, 'dir');
    const candidate = path.join(symlinkPath, 'nested');
    await assert.rejects(
      () => assertInsideDir(phasesDir, candidate),
      /assertInsideDir/,
    );
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

// ─── slugify: output charset guarantee (assertInsideDir's backstop relies on it) ───

test('slugify output is always restricted to [a-z0-9-], even for traversal/unicode/shell-special input', () => {
  const inputs = [
    '../../etc/passwd',
    '/etc/passwd; rm -rf /',
    '  $(whoami) `id` ; echo hacked  ',
    'Iñtërnâtiônàlizætiøn 日本語 émoji 🎉',
    '<script>alert(1)</script>',
    '',
  ];
  for (const input of inputs) {
    const slug = slugify(input);
    assert.match(
      slug, /^[a-z0-9-]*$/,
      `slugify(${JSON.stringify(input)}) produced "${slug}", which contains characters outside [a-z0-9-]`,
    );
  }
});
