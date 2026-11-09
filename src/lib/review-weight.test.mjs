// Phase 35 (review-cadence-yield-gating / QL-6) — unit tests for the pure
// batch-weight classifier. See src/lib/review-weight.js for the contract:
// never used to skip a review, only to pick which prompt/model writes it.
//
// Run with: node --test src/lib/review-weight.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { computeReviewWeight, mergeLensReviews, shouldScheduleReview, writeMergedLensReview } from './review-weight.js';

const lensBody = (verdict, score, extra = '') =>
  `Some review prose about the batch.${extra}\n\nverdict: ${verdict}\nscore: ${score}\n`;

const passPhase = (n, overrides = {}) => ({
  n,
  verifyVerdict: 'pass',
  escalated: false,
  validationFailed: false,
  reprompted: false,
  criteriaCount: 3,
  ...overrides,
});

const cfg = () => ({ review_gating: { enabled: true, light_max_changed_files: 25, panel_min_changed_files: 40, force_full_every_n: 3 } });

test('all-green small batch -> light', () => {
  const batch = [passPhase(1), passPhase(2), passPhase(3)];
  const { mode } = computeReviewWeight({ batch, changedFiles: ['a.js', 'b.js'], cfg: cfg() });
  assert.equal(mode, 'light');
});

test('one verifyVerdict:fail -> one full review, not an automatic three-call panel', () => {
  const batch = [passPhase(1), passPhase(2, { verifyVerdict: 'fail' }), passPhase(3)];
  const { mode, signals } = computeReviewWeight({ batch, changedFiles: ['a.js'], cfg: cfg() });
  assert.equal(mode, 'full');
  assert.ok(signals.some((s) => /verifyVerdict !== pass/.test(s)));
});

test('changedFiles.length >= panel_min_changed_files -> panel (even all-pass, zero markers)', () => {
  const batch = [passPhase(1), passPhase(2)];
  const changedFiles = Array.from({ length: 40 }, (_, i) => `file-${i}.js`);
  const { mode, signals } = computeReviewWeight({ batch, changedFiles, cfg: cfg() });
  assert.equal(mode, 'panel');
  assert.ok(signals.some((s) => />= panel_min_changed_files/.test(s)));
});

test('a phase with verifyVerdict: missing -> full (not panel)', () => {
  const batch = [passPhase(1), passPhase(2, { verifyVerdict: 'missing' })];
  const { mode, signals } = computeReviewWeight({ batch, changedFiles: ['a.js'], cfg: cfg() });
  assert.equal(mode, 'full');
  assert.ok(signals.some((s) => /verifyVerdict: missing/.test(s)));
});

test('changedFiles === null -> full', () => {
  const batch = [passPhase(1), passPhase(2)];
  const { mode, signals } = computeReviewWeight({ batch, changedFiles: null, cfg: cfg() });
  assert.equal(mode, 'full');
  assert.ok(signals.some((s) => /changedFiles unavailable/.test(s)));
});

test('cfg.review_gating.enabled === false -> full', () => {
  const batch = [passPhase(1), passPhase(2)];
  const { mode, signals } = computeReviewWeight({
    batch, changedFiles: ['a.js'], cfg: { review_gating: { enabled: false } },
  });
  assert.equal(mode, 'full');
  assert.ok(signals.some((s) => /enabled === false/.test(s)));
});

// ── Additional edge coverage ────────────────────────────────────────────────

test('batch === null -> full (fail-safe, not just changedFiles)', () => {
  const { mode, signals } = computeReviewWeight({ batch: null, changedFiles: ['a.js'], cfg: cfg() });
  assert.equal(mode, 'full');
  assert.ok(signals.some((s) => /batch missing/.test(s)));
});

test('escalated/validationFailed/reprompted marker (no fail verdict) -> full', () => {
  for (const key of ['escalated', 'validationFailed', 'reprompted']) {
    const batch = [passPhase(1, { [key]: true }), passPhase(2)];
    const { mode, signals } = computeReviewWeight({ batch, changedFiles: ['a.js'], cfg: cfg() });
    assert.equal(mode, 'full', `marker ${key} should force a full review`);
    assert.ok(signals.some((s) => /marker/.test(s)));
  }
});

test('changedFiles.length between light_max and panel_min (all-pass, zero markers) -> full', () => {
  const batch = [passPhase(1), passPhase(2)];
  const changedFiles = Array.from({ length: 30 }, (_, i) => `file-${i}.js`);
  const { mode, signals } = computeReviewWeight({ batch, changedFiles, cfg: cfg() });
  assert.equal(mode, 'full');
  assert.ok(signals.some((s) => /between light_max_changed_files/.test(s)));
});

test('changedFiles.length exactly at light_max_changed_files -> light (boundary inclusive)', () => {
  const batch = [passPhase(1)];
  const changedFiles = Array.from({ length: 25 }, (_, i) => `file-${i}.js`);
  const { mode } = computeReviewWeight({ batch, changedFiles, cfg: cfg() });
  assert.equal(mode, 'light');
});

test('changedFiles.length exactly at panel_min_changed_files -> panel (boundary inclusive)', () => {
  const batch = [passPhase(1)];
  const changedFiles = Array.from({ length: 40 }, (_, i) => `file-${i}.js`);
  const { mode } = computeReviewWeight({ batch, changedFiles, cfg: cfg() });
  assert.equal(mode, 'panel');
});

test('missing cfg.review_gating entirely -> defaults apply (25/40), still classifies light for a small batch', () => {
  const batch = [passPhase(1)];
  const { mode } = computeReviewWeight({ batch, changedFiles: ['a.js'], cfg: {} });
  assert.equal(mode, 'light');
});

test('cfg === null -> defaults apply, no throw', () => {
  const batch = [passPhase(1)];
  const { mode } = computeReviewWeight({ batch, changedFiles: ['a.js'], cfg: null });
  assert.equal(mode, 'light');
});

test('review scheduler runs periodically and immediately at configured risk boundaries', () => {
  const riskCfg = { verify: { cadence: { always_complexities: ['high', 'critical'], always_checkpoints: ['schema'] } } };
  assert.equal(shouldScheduleReview({ completedPhase: 5, phaseMeta: { complexity: 'low' }, reviewEveryN: 6, cfg: riskCfg }).run, false);
  assert.equal(shouldScheduleReview({ completedPhase: 6, phaseMeta: { complexity: 'low' }, reviewEveryN: 6, cfg: riskCfg }).run, true);
  assert.equal(shouldScheduleReview({ completedPhase: 4, phaseMeta: { complexity: 'high' }, reviewEveryN: 6, cfg: riskCfg }).run, true);
  assert.equal(shouldScheduleReview({ completedPhase: 2, phaseMeta: { checkpoint: 'schema' }, reviewEveryN: 6, cfg: riskCfg }).run, true);
});

test('risk boundary in a review batch forces full even when the diff is small and green', () => {
  const batch = [passPhase(2, { complexity: 'high' })];
  const { mode, signals } = computeReviewWeight({ batch, changedFiles: ['a.js'], cfg: cfg() });
  assert.equal(mode, 'full');
  assert.ok(signals.some((signal) => /high-risk boundary/.test(signal)));
});

// ─── Phase 36 — mergeLensReviews (panel review, deterministic merge) ───────

test('mergeLensReviews: (continue/90, pause-and-fix/70, continue/85) -> merged pause-and-fix/70', () => {
  const lensResults = [
    { name: 'guide review', content: lensBody('continue', 90) },
    { name: 'security', content: lensBody('pause-and-fix', 70) },
    { name: 'consistency', content: lensBody('continue', 85) },
  ];
  const merged = mergeLensReviews(lensResults);
  assert.equal(merged.verdict, 'pause-and-fix');
  assert.equal(merged.score, 70);
  assert.deepEqual(merged.warnings, []);
});

test('mergeLensReviews: all continue -> continue/min-score', () => {
  const lensResults = [
    { name: 'guide review', content: lensBody('continue', 95) },
    { name: 'security', content: lensBody('continue', 80) },
    { name: 'consistency', content: lensBody('continue', 88) },
  ];
  const merged = mergeLensReviews(lensResults);
  assert.equal(merged.verdict, 'continue');
  assert.equal(merged.score, 80);
});

test('mergeLensReviews: any replan present -> replan (worst-verdict wins over pause-and-fix too)', () => {
  const lensResults = [
    { name: 'guide review', content: lensBody('continue', 90) },
    { name: 'security', content: lensBody('replan', 50) },
    { name: 'consistency', content: lensBody('pause-and-fix', 70) },
  ];
  const merged = mergeLensReviews(lensResults);
  assert.equal(merged.verdict, 'replan');
  assert.equal(merged.score, 50);
});

test('mergeLensReviews: a missing lens (content: null) -> pause-and-fix/0 AND a warning line is present', () => {
  const lensResults = [
    { name: 'guide review', content: lensBody('continue', 90) },
    { name: 'security', content: null },
    { name: 'consistency', content: lensBody('continue', 85) },
  ];
  const merged = mergeLensReviews(lensResults);
  assert.equal(merged.verdict, 'pause-and-fix');
  assert.equal(merged.score, 0);
  assert.equal(merged.warnings.length, 1);
  assert.match(merged.warnings[0], /security/);
  assert.ok(merged.body.includes('WARNING'), 'the rendered body includes the warning line');
});

test('mergeLensReviews: an unparseable trailer (garbled content) -> pause-and-fix/0 AND a warning line, same as a missing lens', () => {
  const lensResults = [
    { name: 'guide review', content: lensBody('continue', 90) },
    { name: 'security', content: 'No trailer at all here, just prose.' },
    { name: 'consistency', content: lensBody('continue', 85) },
  ];
  const merged = mergeLensReviews(lensResults);
  assert.equal(merged.verdict, 'pause-and-fix');
  assert.equal(merged.score, 0);
  assert.equal(merged.warnings.length, 1);
});

test('mergeLensReviews: rendered body has exactly TWO trailer lines total (the merged verdict/score), even though every lens carried its own', () => {
  const lensResults = [
    { name: 'guide review', content: lensBody('continue', 90) },
    { name: 'security', content: lensBody('continue', 80) },
    { name: 'consistency', content: lensBody('continue', 85) },
  ];
  const merged = mergeLensReviews(lensResults);
  const verdictLines = merged.body.split('\n').filter((l) => /^verdict:/i.test(l.trim()));
  const scoreLines = merged.body.split('\n').filter((l) => /^\s*score:\s*\d+/i.test(l));
  assert.equal(verdictLines.length, 1, 'exactly one verdict: line in the merged body');
  assert.equal(scoreLines.length, 1, 'exactly one score: line in the merged body');
  assert.ok(merged.body.trim().endsWith(`verdict: continue\nscore: 80`), 'merged body ends with the two trailer lines');
});

test('mergeLensReviews: a BLOCKER: line inside a lens body survives concatenation into the merged file', () => {
  const lensResults = [
    { name: 'guide review', content: lensBody('continue', 90) },
    { name: 'security', content: `Found a serious issue.\nBLOCKER: SQL injection in the search endpoint.\n\nverdict: pause-and-fix\nscore: 40\n` },
    { name: 'consistency', content: lensBody('continue', 85) },
  ];
  const merged = mergeLensReviews(lensResults);
  assert.ok(merged.body.includes('BLOCKER: SQL injection in the search endpoint.'));
});

test('mergeLensReviews: section headers use "## Lens k — <name>" for each lens, in order', () => {
  const lensResults = [
    { name: 'guide review (memory + decisions)', content: lensBody('continue', 90) },
    { name: 'security / failure-modes', content: lensBody('continue', 80) },
    { name: 'consistency', content: lensBody('continue', 85) },
  ];
  const merged = mergeLensReviews(lensResults);
  assert.match(merged.body, /## Lens 1 — guide review \(memory \+ decisions\)/);
  assert.match(merged.body, /## Lens 2 — security \/ failure-modes/);
  assert.match(merged.body, /## Lens 3 — consistency/);
});

test('writeMergedLensReview: persists merged.body verbatim to the given path, creating parent dirs', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aorch-lens-merge-'));
  const out = path.join(dir, '.guide', 'reviews', 'after-5.md');
  const merged = mergeLensReviews([
    { name: 'guide review', content: lensBody('continue', 90) },
    { name: 'security', content: lensBody('continue', 80) },
    { name: 'consistency', content: lensBody('continue', 85) },
  ]);
  await writeMergedLensReview(out, merged);
  const written = await fs.readFile(out, 'utf-8');
  assert.equal(written, merged.body);
});
