// Context Freshness (Phase 17) — src/lib/context-freshness.test.mjs
//
// Run with: node --test src/lib/context-freshness.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  renderStampFrontMatter,
  parseStampFrontMatter,
  stampArtifact,
  classifyCommit,
  parseGitLogNameStatus,
  contextDelta,
  shouldEnqueueContextRefresh,
  shouldNotifyContextDrift,
  buildContextDriftNotifyText,
  buildGuideRegroundReason,
  buildGuideRegroundNotifyText,
} from './context-freshness.js';

function makeWorkspace(label) {
  const dir = mkdtempSync(path.join(tmpdir(), `aorch-ctx-freshness-${label}-`));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email t@example.com', { cwd: dir });
  execSync('git config user.name test', { cwd: dir });
  return dir;
}

function commit(dir, file, content, message) {
  writeFileSync(path.join(dir, file), content);
  execSync('git add -A', { cwd: dir });
  execSync(`git commit -q -m ${JSON.stringify(message)}`, { cwd: dir });
  return execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
}

// ─── Front-matter round-trip ─────────────────────────────────────────────────

test('front-matter round-trips generated_at_sha/generated_at', () => {
  const attrs = { generated_at_sha: 'deadbeef', generated_at: '2026-07-04T00:00:00.000Z' };
  const rendered = `${renderStampFrontMatter(attrs)}\n\nbody text\nmore body\n`;
  const parsed = parseStampFrontMatter(rendered);
  assert.deepEqual(parsed.attrs, attrs);
  assert.equal(parsed.body.trim(), 'body text\nmore body');
});

test('parseStampFrontMatter returns null for a file with no front-matter block', () => {
  assert.equal(parseStampFrontMatter('# just a heading\n\nsome content\n'), null);
});

// ─── stampArtifact ────────────────────────────────────────────────────────────

test('stampArtifact: no existing front-matter adds generated_at_sha/generated_at, preserves body', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aorch-ctx-freshness-stamp-'));
  const file = path.join(dir, 'project-context.md');
  writeFileSync(file, '# Project Context\n\nSome body text.\n');

  const result = await stampArtifact(file, 'sha1111', { now: '2026-07-04T10:00:00.000Z' });
  assert.equal(result.generated_at_sha, 'sha1111');
  assert.equal(result.generated_at, '2026-07-04T10:00:00.000Z');

  const onDisk = readFileSync(file, 'utf-8');
  const parsed = parseStampFrontMatter(onDisk);
  assert.equal(parsed.attrs.generated_at_sha, 'sha1111');
  assert.equal(parsed.attrs.generated_at, '2026-07-04T10:00:00.000Z');
  assert.equal(parsed.body, '# Project Context\n\nSome body text.\n');
});

test('stampArtifact: re-stamping updates both fields without duplicating the block', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aorch-ctx-freshness-restamp-'));
  const file = path.join(dir, 'project-context.md');
  writeFileSync(file, '# Project Context\n\nBody.\n');

  await stampArtifact(file, 'sha1111', { now: '2026-07-04T10:00:00.000Z' });
  await stampArtifact(file, 'sha2222', { now: '2026-07-05T10:00:00.000Z' });

  const onDisk = readFileSync(file, 'utf-8');
  assert.equal((onDisk.match(/^---$/gm) || []).length, 2, 'exactly one front-matter block (2 fence lines)');
  const parsed = parseStampFrontMatter(onDisk);
  assert.equal(parsed.attrs.generated_at_sha, 'sha2222');
  assert.equal(parsed.attrs.generated_at, '2026-07-05T10:00:00.000Z');
  assert.equal(parsed.body, '# Project Context\n\nBody.\n');
});

test('stampArtifact: a file WITH existing (foreign) front-matter gets it replaced, not duplicated', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aorch-ctx-freshness-foreign-'));
  const file = path.join(dir, 'CLAUDE.md');
  writeFileSync(file, '---\ngenerated_at_sha: old\ngenerated_at: 2020-01-01T00:00:00.000Z\n---\n\n# CLAUDE.md\n\nConventions.\n');

  await stampArtifact(file, 'newsha', { now: '2026-07-04T10:00:00.000Z' });

  const onDisk = readFileSync(file, 'utf-8');
  assert.equal((onDisk.match(/^---$/gm) || []).length, 2);
  const parsed = parseStampFrontMatter(onDisk);
  assert.equal(parsed.attrs.generated_at_sha, 'newsha');
  assert.equal(parsed.body, '# CLAUDE.md\n\nConventions.\n');
});

// ─── classifyCommit ───────────────────────────────────────────────────────────

test('classifyCommit: phase-{n}: prefix is orchestrator', () => {
  assert.equal(classifyCommit('phase-17: sha-stamp narrative context artifacts'), 'orchestrator');
});

test('classifyCommit: fix-r{R}-{N}: prefix (round-fix format) is orchestrator', () => {
  assert.equal(classifyCommit('fix-r2-3: correct off-by-one in pagination'), 'orchestrator');
});

test('classifyCommit: "(validator fix)" suffix is orchestrator', () => {
  assert.equal(classifyCommit('phase-9: add invoice export (validator fix)'), 'orchestrator');
});

test('classifyCommit: "(acceptance fix)" suffix is orchestrator', () => {
  assert.equal(classifyCommit('fix-r1-4: tighten validation (acceptance fix)'), 'orchestrator');
});

test('classifyCommit: a plain message is external', () => {
  assert.equal(classifyCommit('Update README typo'), 'external');
});

// ─── parseGitLogNameStatus ────────────────────────────────────────────────────

test('parseGitLogNameStatus: parses header + file-status lines with no blank separators', () => {
  const raw = [
    'abc1234 phase-5: add feature',
    'M\tsrc/foo.js',
    'A\tsrc/bar.js',
    'def5678 Update README typo',
    'M\tREADME.md',
  ].join('\n');
  const commits = parseGitLogNameStatus(raw);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].sha, 'abc1234');
  assert.equal(commits[0].subject, 'phase-5: add feature');
  assert.deepEqual(commits[0].files, [{ status: 'M', path: 'src/foo.js' }, { status: 'A', path: 'src/bar.js' }]);
  assert.equal(commits[1].subject, 'Update README typo');
});

// ─── contextDelta ─────────────────────────────────────────────────────────────

test('contextDelta: classifies 3 external + 2 orchestrator commits since a marked sha', async () => {
  const ws = makeWorkspace('classify');
  const initSha = commit(ws, 'a.txt', 'a', 'init');
  commit(ws, 'b.txt', 'b', 'phase-1: initial scaffold');
  commit(ws, 'c.txt', 'c', 'Manual hotfix for prod');
  commit(ws, 'd.txt', 'd', 'fix-r1-2: patch validation (acceptance fix)');
  commit(ws, 'e.txt', 'e', 'Bump dependency version');
  commit(ws, 'f.txt', 'f', 'Update docs typo');

  const delta = await contextDelta({ workspaceDir: ws, sinceSha: initSha });
  assert.equal(delta.drift, 'some');
  assert.equal(delta.commits.length, 5);
  const byClass = delta.commits.reduce((acc, c) => {
    acc[c.classification] = (acc[c.classification] || 0) + 1;
    return acc;
  }, {});
  assert.equal(byClass.orchestrator, 2);
  assert.equal(byClass.external, 3);
  assert.equal(delta.overflowCount, 0);
  assert.equal(delta.overflowLine, null);
});

test('contextDelta: maxCommits overflow caps entries and produces the "…and N more" line', async () => {
  const ws = makeWorkspace('overflow');
  const initSha = commit(ws, 'a.txt', 'a', 'init');
  for (let i = 0; i < 5; i += 1) commit(ws, `f${i}.txt`, String(i), `external commit ${i}`);

  const delta = await contextDelta({ workspaceDir: ws, sinceSha: initSha, maxCommits: 2 });
  assert.equal(delta.commits.length, 2);
  assert.equal(delta.overflowCount, 3);
  assert.equal(delta.overflowLine, '…and 3 more');
});

test('contextDelta: garbage sinceSha yields drift:"unknown" without throwing', async () => {
  const ws = makeWorkspace('garbage-sha');
  commit(ws, 'a.txt', 'a', 'init');

  const delta = await contextDelta({ workspaceDir: ws, sinceSha: 'not-a-real-sha-at-all' });
  assert.equal(delta.drift, 'unknown');
});

test('contextDelta: missing sinceSha yields drift:"unknown" without throwing', async () => {
  const ws = makeWorkspace('missing-sha');
  commit(ws, 'a.txt', 'a', 'init');

  const delta = await contextDelta({ workspaceDir: ws, sinceSha: null });
  assert.equal(delta.drift, 'unknown');
});

test('contextDelta: a well-formed but nonexistent sha yields drift:"unknown"', async () => {
  const ws = makeWorkspace('nonexistent-sha');
  commit(ws, 'a.txt', 'a', 'init');

  const delta = await contextDelta({ workspaceDir: ws, sinceSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
  assert.equal(delta.drift, 'unknown');
});

test('contextDelta: a runGit failure yields drift:"unknown" rather than throwing', async () => {
  const failingRunGit = async () => null;
  const delta = await contextDelta(
    { workspaceDir: '/does/not/matter', sinceSha: 'deadbeef' },
    { runGit: failingRunGit },
  );
  assert.equal(delta.drift, 'unknown');
});

test('contextDelta: sinceSha === HEAD yields an empty delta with no error', async () => {
  const ws = makeWorkspace('same-head');
  const headSha = commit(ws, 'a.txt', 'a', 'init');

  const delta = await contextDelta({ workspaceDir: ws, sinceSha: headSha });
  assert.equal(delta.drift, 'none');
  assert.deepEqual(delta.commits, []);
  assert.equal(delta.overflowCount, 0);
});

// ─── shouldEnqueueContextRefresh (Phase 19) ──────────────────────────────────

const FRESHNESS_CFG = { enabled: true, regen_after_commits: 10, regen_after_external_files: 5 };

function makeCommit(classification, files) {
  return { sha: 'abcd1234', subject: 'x', classification, files: files.map((p) => ({ status: 'M', path: p })) };
}

test('shouldEnqueueContextRefresh: null delta -> false', () => {
  assert.equal(shouldEnqueueContextRefresh({ delta: null, cfg: FRESHNESS_CFG }), false);
});

test('shouldEnqueueContextRefresh: cfg.enabled:false short-circuits even when drift:"unknown"', () => {
  assert.equal(shouldEnqueueContextRefresh({ delta: { drift: 'unknown', commits: [] }, cfg: { ...FRESHNESS_CFG, enabled: false } }), false);
});

test('shouldEnqueueContextRefresh: drift:"none" -> false', () => {
  assert.equal(shouldEnqueueContextRefresh({ delta: { drift: 'none', commits: [] }, cfg: FRESHNESS_CFG }), false);
});

test('shouldEnqueueContextRefresh: drift:"unknown" -> always true (unstamped/corrupted artifact)', () => {
  assert.equal(shouldEnqueueContextRefresh({ delta: { drift: 'unknown', commits: [] }, cfg: FRESHNESS_CFG }), true);
});

test('shouldEnqueueContextRefresh: drift:"some" below both thresholds -> false', () => {
  const delta = { drift: 'some', overflowCount: 0, commits: [makeCommit('external', ['a.js'])] };
  assert.equal(shouldEnqueueContextRefresh({ delta, cfg: FRESHNESS_CFG }), false);
});

test('shouldEnqueueContextRefresh: total commits (incl. overflow) crossing regen_after_commits -> true', () => {
  const commits = Array.from({ length: 9 }, () => makeCommit('orchestrator', ['x.js']));
  const delta = { drift: 'some', overflowCount: 1, commits }; // 9 + 1 overflow = 10 = threshold
  assert.equal(shouldEnqueueContextRefresh({ delta, cfg: FRESHNESS_CFG }), true);
});

test('shouldEnqueueContextRefresh: below total-commits threshold but external files crossing regen_after_external_files -> true', () => {
  const commits = [
    makeCommit('external', ['a.js', 'b.js', 'c.js']),
    makeCommit('external', ['d.js', 'e.js']),
    makeCommit('orchestrator', ['z.js']),
  ]; // 3 commits total (well below 10), 5 distinct external files (== threshold)
  const delta = { drift: 'some', overflowCount: 0, commits };
  assert.equal(shouldEnqueueContextRefresh({ delta, cfg: FRESHNESS_CFG }), true);
});

test('shouldEnqueueContextRefresh: external files from orchestrator-classified commits do not count', () => {
  const commits = [makeCommit('orchestrator', ['a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js'])];
  const delta = { drift: 'some', overflowCount: 0, commits };
  assert.equal(shouldEnqueueContextRefresh({ delta, cfg: FRESHNESS_CFG }), false);
});

// ─── shouldNotifyContextDrift (Phase 19) ─────────────────────────────────────

test('shouldNotifyContextDrift: null delta -> false', () => {
  assert.equal(shouldNotifyContextDrift({ delta: null, lastNoticedSha: null }), false);
});

test('shouldNotifyContextDrift: drift:"unknown" -> false (no sha/commits to key the notice on)', () => {
  assert.equal(shouldNotifyContextDrift({ delta: { drift: 'unknown', commits: [], headSha: null }, lastNoticedSha: null }), false);
});

test('shouldNotifyContextDrift: drift:"some" with zero external commits -> false', () => {
  const delta = { drift: 'some', headSha: 'sha1', commits: [makeCommit('orchestrator', ['a.js'])] };
  assert.equal(shouldNotifyContextDrift({ delta, lastNoticedSha: null }), false);
});

test('shouldNotifyContextDrift: new external drift, never noticed before -> true', () => {
  const delta = { drift: 'some', headSha: 'sha1', commits: [makeCommit('external', ['a.js'])] };
  assert.equal(shouldNotifyContextDrift({ delta, lastNoticedSha: null }), true);
});

test('shouldNotifyContextDrift: same headSha as last notice -> false (no re-fire at the same drifted state)', () => {
  const delta = { drift: 'some', headSha: 'sha1', commits: [makeCommit('external', ['a.js'])] };
  assert.equal(shouldNotifyContextDrift({ delta, lastNoticedSha: 'sha1' }), false);
});

test('shouldNotifyContextDrift: a NEW headSha past the previously-noticed one -> true (new episode)', () => {
  const delta = { drift: 'some', headSha: 'sha2', commits: [makeCommit('external', ['a.js'])] };
  assert.equal(shouldNotifyContextDrift({ delta, lastNoticedSha: 'sha1' }), true);
});

// ─── buildContextDriftNotifyText (Phase 19) ──────────────────────────────────

test('buildContextDriftNotifyText: zero external commits -> null', () => {
  const delta = { commits: [makeCommit('orchestrator', ['a.js'])] };
  assert.equal(buildContextDriftNotifyText({ projectName: 'demo', delta, refreshQueued: true }), null);
});

test('buildContextDriftNotifyText: counts only external commits, "queued" wording when a refresh was queued', () => {
  const delta = { commits: [makeCommit('external', ['a.js']), makeCommit('external', ['b.js']), makeCommit('orchestrator', ['c.js'])] };
  const text = buildContextDriftNotifyText({ projectName: 'demo', delta, refreshQueued: true });
  assert.equal(text, '⚠ demo: 2 external commit(s) detected since context was generated — refresh queued');
});

test('buildContextDriftNotifyText: "not needed" wording when no refresh was queued', () => {
  const delta = { commits: [makeCommit('external', ['a.js'])] };
  const text = buildContextDriftNotifyText({ projectName: 'demo', delta, refreshQueued: false });
  assert.equal(text, '⚠ demo: 1 external commit(s) detected since context was generated — refresh not needed');
});

// ─── buildGuideRegroundReason (Phase 22) ─────────────────────────────────────

const REGROUND_CFG = { enabled: true, after_commits: 15, after_external_files: 10 };

test('buildGuideRegroundReason: null delta -> null', () => {
  assert.equal(buildGuideRegroundReason({ delta: null, cfg: REGROUND_CFG }), null);
});

test('buildGuideRegroundReason: cfg.enabled:false short-circuits even when drift:"unknown"', () => {
  assert.equal(buildGuideRegroundReason({ delta: { drift: 'unknown', commits: [] }, cfg: { ...REGROUND_CFG, enabled: false } }), null);
});

test('buildGuideRegroundReason: drift:"none" -> null', () => {
  assert.equal(buildGuideRegroundReason({ delta: { drift: 'none', commits: [] }, cfg: REGROUND_CFG }), null);
});

test('buildGuideRegroundReason: drift:"unknown" -> a reason string (unresolvable last-seen commit)', () => {
  const reason = buildGuideRegroundReason({ delta: { drift: 'unknown', commits: [] }, cfg: REGROUND_CFG });
  assert.ok(reason && reason.includes('could not be resolved'));
});

test('buildGuideRegroundReason: drift:"some" below both thresholds -> null', () => {
  const delta = { drift: 'some', overflowCount: 0, commits: [makeCommit('external', ['a.js'])] };
  assert.equal(buildGuideRegroundReason({ delta, cfg: REGROUND_CFG }), null);
});

test('buildGuideRegroundReason: total commits (incl. overflow) crossing after_commits -> reason names the count and threshold', () => {
  const commits = Array.from({ length: 14 }, () => makeCommit('orchestrator', ['x.js']));
  const delta = { drift: 'some', overflowCount: 1, commits }; // 14 + 1 overflow = 15 = threshold
  const reason = buildGuideRegroundReason({ delta, cfg: REGROUND_CFG });
  assert.equal(reason, '15 commit(s) landed since the guide last looked (threshold 15)');
});

test('buildGuideRegroundReason: below total-commits threshold but external files crossing after_external_files -> reason names the file count', () => {
  const commits = [
    makeCommit('external', ['a.js', 'b.js', 'c.js', 'd.js', 'e.js']),
    makeCommit('external', ['f.js', 'g.js', 'h.js', 'i.js', 'j.js']),
  ]; // 2 commits total (well below 15), 10 distinct external files (== threshold)
  const delta = { drift: 'some', overflowCount: 0, commits };
  const reason = buildGuideRegroundReason({ delta, cfg: REGROUND_CFG });
  assert.equal(reason, '10 file(s) touched by external commits since the guide last looked (threshold 10)');
});

test('buildGuideRegroundReason: external files from orchestrator-classified commits do not count toward after_external_files', () => {
  const commits = [makeCommit('orchestrator', ['a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js', 'g.js', 'h.js', 'i.js', 'j.js'])];
  const delta = { drift: 'some', overflowCount: 0, commits };
  assert.equal(buildGuideRegroundReason({ delta, cfg: REGROUND_CFG }), null);
});

test('buildGuideRegroundReason: default thresholds (15/10) apply when cfg is omitted entirely', () => {
  const commits = Array.from({ length: 15 }, () => makeCommit('orchestrator', ['x.js']));
  const delta = { drift: 'some', overflowCount: 0, commits };
  const reason = buildGuideRegroundReason({ delta });
  assert.ok(reason && reason.includes('threshold 15'));
});

// ─── buildGuideRegroundNotifyText (Phase 22) ─────────────────────────────────

test('buildGuideRegroundNotifyText: null reason -> null', () => {
  assert.equal(buildGuideRegroundNotifyText({ projectName: 'demo', reason: null }), null);
});

test('buildGuideRegroundNotifyText: renders the ↺ lead glyph and interpolates project/reason, distinct from the ⚠ drift notice', () => {
  const text = buildGuideRegroundNotifyText({ projectName: 'demo', reason: '16 commit(s) landed since the guide last looked (threshold 15)' });
  assert.equal(text, '↺ demo: guide re-grounded — 16 commit(s) landed since the guide last looked (threshold 15)');
  assert.ok(text.startsWith('↺'));
  assert.ok(!text.startsWith('⚠'));
});
