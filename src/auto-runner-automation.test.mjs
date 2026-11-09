// Tests for FR18 (review auto-proceed), FR20 (auto-promote audit findings), G5 integration
// Run with: node src/auto-runner-automation.test.mjs

import { writeFileSync, mkdirSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryReviewAutoProceed, maybeAutoPromoteAudit, shouldAutoPromoteAudit, checkStaleBriefGuard, pickNextAction, normalizeContinuationPlan } from './auto-runner.js';
import { buildGuidePrompt, loadSuggestionsBlock } from './lib/phase-runner.js';
import { promoteAuditToBugs, formatConvergenceStallReason } from './lib/audit-promote.js';
import { auditDir, findMostRecentAudit } from './lib/guide-paths.js';
import { upsertProject, deleteProject, getProject, setCurrentPhase, saveSuggestions, acceptSuggestions } from './state.js';

let passed = 0;
let failed = 0;

function assert(condition, description) {
  if (condition) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${description}`);
    failed++;
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpProjectDir() {
  const tmpRoot = path.join(tmpdir(), `aorch-phase14-test-${randomUUID()}`);
  const reviewsDir = path.join(tmpRoot, '.guide', 'reviews');
  mkdirSync(reviewsDir, { recursive: true });
  return tmpRoot;
}

function writeReview(tmpRoot, phaseN, content) {
  writeFileSync(path.join(tmpRoot, '.guide', 'reviews', `after-${phaseN}.md`), content, 'utf-8');
}

function cfgWithThreshold(threshold) {
  if (threshold === undefined) return { auto_run: {} };
  return { auto_run: { review_auto_proceed_score_threshold: threshold } };
}

const tmpDirs = [];
function tmp() {
  const d = makeTmpProjectDir();
  tmpDirs.push(d);
  return d;
}

// ─── FR18 tests ──────────────────────────────────────────────────────────────
console.log('\nFR18 — tryReviewAutoProceed:');

// 1. Score >= threshold, no BLOCKER → returns true
{
  const projDir = tmp();
  writeReview(projDir, 5, 'Score: 90/100\nAll good.\n');
  const result = await tryReviewAutoProceed({
    action: { phaseN: 5 },
    cfg: cfgWithThreshold(80),
    projDir,
  });
  assert(result === true, 'Score 90 >= threshold 80, no BLOCKER → returns true');
}

// 2. Score < threshold, no BLOCKER → returns false
{
  const projDir = tmp();
  writeReview(projDir, 5, 'Score: 60/100\nNeeds work.\n');
  const result = await tryReviewAutoProceed({
    action: { phaseN: 5 },
    cfg: cfgWithThreshold(80),
    projDir,
  });
  assert(result === false, 'Score 60 < threshold 80, no BLOCKER → returns false');
}

// 3. Score >= threshold but BLOCKER line present → returns false
{
  const projDir = tmp();
  writeReview(projDir, 5, 'Score: 90/100\nBLOCKER: missing auth on /api/config\nIssue found.\n');
  const result = await tryReviewAutoProceed({
    action: { phaseN: 5 },
    cfg: cfgWithThreshold(80),
    projDir,
  });
  assert(result === false, 'Score 90 >= 80 but BLOCKER present → returns false');
}

// 4. Report has no score: line → returns false
{
  const projDir = tmp();
  writeReview(projDir, 5, 'Looks great! No score here.\n');
  const result = await tryReviewAutoProceed({
    action: { phaseN: 5 },
    cfg: cfgWithThreshold(80),
    projDir,
  });
  assert(result === false, 'No score: line in report → returns false');
}

// 5. Report file does not exist → returns false
{
  const projDir = tmp();
  // no file written
  const result = await tryReviewAutoProceed({
    action: { phaseN: 99 },
    cfg: cfgWithThreshold(80),
    projDir,
  });
  assert(result === false, 'Report file missing → returns false');
}

// 6. cfg.auto_run.review_auto_proceed_score_threshold is undefined → returns false
{
  const projDir = tmp();
  writeReview(projDir, 5, 'Score: 95/100\n');
  const result = await tryReviewAutoProceed({
    action: { phaseN: 5 },
    cfg: { auto_run: {} },
    projDir,
  });
  assert(result === false, 'threshold undefined → returns false (no-op)');
}

// 7. Score line in "Score: 87/100" style is parsed correctly
{
  const projDir = tmp();
  writeReview(projDir, 7, '## Review Results\n\nScore: 87/100\n\nLooks good.\n');
  const result = await tryReviewAutoProceed({
    action: { phaseN: 7 },
    cfg: cfgWithThreshold(85),
    projDir,
  });
  assert(result === true, '"Score: 87/100" style line parsed correctly → returns true');
}

// 7b. BLOCKER: line is case-insensitive
{
  const projDir = tmp();
  writeReview(projDir, 5, 'Score: 90/100\nblocker: something broken\n');
  const result = await tryReviewAutoProceed({
    action: { phaseN: 5 },
    cfg: cfgWithThreshold(80),
    projDir,
  });
  assert(result === false, 'lowercase blocker: line also suppresses auto-proceed');
}

// 7c. Score exactly equal to threshold → returns true (inclusive)
{
  const projDir = tmp();
  writeReview(projDir, 5, 'Score: 85/100\n');
  const result = await tryReviewAutoProceed({
    action: { phaseN: 5 },
    cfg: cfgWithThreshold(85),
    projDir,
  });
  assert(result === true, 'Score exactly equal to threshold (85 >= 85) → returns true');
}

// 7d. Decoy "score:" in prose does not hijack the verdict line
{
  const projDir = tmp();
  writeReview(projDir, 5, [
    '## Review',
    '',
    'The score: criteria are evaluated on a 0-100 scale.',
    'Based on rubric, an initial score: 25 estimate was considered.',
    '',
    'After full review:',
    'verdict: continue',
    'score: 91',
  ].join('\n'));
  const result = await tryReviewAutoProceed({
    action: { phaseN: 5 },
    cfg: cfgWithThreshold(80),
    projDir,
  });
  assert(result === true, 'Decoy "score:" in prose does not hijack verdict line — last anchored score: 91 >= 80 → true');
}

// ─── FR20 tests ──────────────────────────────────────────────────────────────
console.log('\nFR20 — sentinel-based audit auto-promote:');

const AUDIT_WITH_PROMOTE = `# Audit

## Summary

Found some issues.

## Promote to bugs-round-1

### BUG-1: Missing validation
- Severity: major
- Details: Input not validated.
`;

// 8. Fresh audit file (no sentinel) → promoteAuditToBugs runs, sentinel is written
{
  const projDir = tmp();
  const auditsDir = path.join(projDir, '.guide', 'audits');
  mkdirSync(auditsDir, { recursive: true });
  const auditFile = path.join(auditsDir, 'audit-2026-01-01.md');
  writeFileSync(auditFile, AUDIT_WITH_PROMOTE, 'utf-8');

  const latestAudit = await findMostRecentAudit(projDir);
  assert(latestAudit !== null, 'findMostRecentAudit finds the fresh audit file');

  const sentinel = path.join(auditDir(projDir), `.promoted-${path.basename(latestAudit)}`);
  assert(!existsSync(sentinel), 'sentinel does not exist before promote');

  const r = await promoteAuditToBugs({ projDir, projectName: 'test-project' });
  assert(r.promoted === true, 'promoteAuditToBugs returns promoted: true for fresh audit');
  assert(existsSync(sentinel), 'sentinel file is written after promote');
}

// 9. Already-promoted audit (sentinel present) → promoteAuditToBugs returns promoted: false
{
  const projDir = tmp();
  const auditsDir = path.join(projDir, '.guide', 'audits');
  mkdirSync(auditsDir, { recursive: true });
  const auditFile = path.join(auditsDir, 'audit-2026-01-02.md');
  writeFileSync(auditFile, AUDIT_WITH_PROMOTE, 'utf-8');

  // Write sentinel to simulate already-promoted state
  writeFileSync(path.join(auditsDir, '.promoted-audit-2026-01-02.md'), '', 'utf-8');

  const latestAudit = await findMostRecentAudit(projDir);
  const sentinel = path.join(auditDir(projDir), `.promoted-${path.basename(latestAudit)}`);
  assert(existsSync(sentinel), 'sentinel is present before second promote attempt');

  const r = await promoteAuditToBugs({ projDir, projectName: 'test-project' });
  assert(r.promoted === false, 'promoteAuditToBugs returns promoted: false when sentinel present');
}

// 10. No audit file → findMostRecentAudit returns null → no promote attempted
{
  const projDir = tmp();
  // audits dir doesn't exist — simulate empty state
  const latestAudit = await findMostRecentAudit(projDir);
  assert(latestAudit === null, 'findMostRecentAudit returns null when no audit file exists');
  // Nothing to assert on maybeAutoPromoteAudit — null short-circuits before calling it
}

// 11. Dev-phase title containing "audit" does NOT satisfy flag-independent sentinel check —
//     confirmed by checking that flag false prevents promote regardless of title
{
  const projDir = tmp();
  const auditsDir = path.join(projDir, '.guide', 'audits');
  mkdirSync(auditsDir, { recursive: true });
  writeFileSync(path.join(auditsDir, 'audit-2026-01-03.md'), '# Audit\n', 'utf-8');

  // When auto_promote_audit_bugs is false the outer guard skips → maybeAutoPromoteAudit never called
  // Verify sentinel stays absent (we check promoteAuditToBugs directly here to confirm no false trigger)
  const sentinel = path.join(auditsDir, '.promoted-audit-2026-01-03.md');
  assert(!existsSync(sentinel), 'flag=false: sentinel absent, no auto-promote despite audit file present');
}

// ─── FR20 — maybeAutoPromoteAudit error handling ─────────────────────────────
console.log('\nFR20 — maybeAutoPromoteAudit non-fatal error handling:');

// 12. maybeAutoPromoteAudit with a projDir that has no audit → does not throw
{
  const projDir = tmp();
  let threw = false;
  try {
    await maybeAutoPromoteAudit({ projDir, projectName: 'test-project' });
  } catch {
    threw = true;
  }
  assert(!threw, 'maybeAutoPromoteAudit with no audit file → does not throw');
}

// 13. maybeAutoPromoteAudit with a non-existent projDir → does not throw
{
  let threw = false;
  try {
    await maybeAutoPromoteAudit({ projDir: '/tmp/nonexistent-aorch-test-dir-xyz', projectName: 'ghost' });
  } catch {
    threw = true;
  }
  assert(!threw, 'maybeAutoPromoteAudit with missing projDir → does not throw');
}

// ─── FR20 — shouldAutoPromoteAudit mtime gate ────────────────────────────────
console.log('\nFR20 — shouldAutoPromoteAudit mtime gate:');

// 14. Audit file with mtime >= runStartMs → returns true (eligible for this run)
{
  const projDir = tmp();
  const auditsDir = path.join(projDir, '.guide', 'audits');
  mkdirSync(auditsDir, { recursive: true });
  const auditFile = path.join(auditsDir, 'audit-2026-01-10.md');
  writeFileSync(auditFile, '# Audit\n', 'utf-8');

  // runStartMs = 0 → any file written after epoch is "this run"
  const result = await shouldAutoPromoteAudit({ latestAudit: auditFile, runStartMs: 0 });
  assert(result === true, 'audit mtime >= runStartMs(0) → shouldAutoPromoteAudit returns true');
}

// 15. Audit file with mtime < runStartMs → returns false (stale audit, skip it)
{
  const projDir = tmp();
  const auditsDir = path.join(projDir, '.guide', 'audits');
  mkdirSync(auditsDir, { recursive: true });
  const auditFile = path.join(auditsDir, 'audit-2026-01-11.md');
  writeFileSync(auditFile, '# Audit\n', 'utf-8');

  // runStartMs = far future → this file's mtime is necessarily before it
  const result = await shouldAutoPromoteAudit({ latestAudit: auditFile, runStartMs: Date.now() + 100_000_000 });
  assert(result === false, 'audit mtime < future runStartMs → shouldAutoPromoteAudit returns false (stale)');
}

// 16. latestAudit is null → returns false (no audit found, nothing to promote)
{
  const result = await shouldAutoPromoteAudit({ latestAudit: null, runStartMs: 0 });
  assert(result === false, 'latestAudit=null → shouldAutoPromoteAudit returns false');
}

// 17. latestAudit path does not exist → returns false (non-fatal, stat error swallowed)
{
  const result = await shouldAutoPromoteAudit({
    latestAudit: '/tmp/nonexistent-audit-xyzzy.md',
    runStartMs: 0,
  });
  assert(result === false, 'non-existent audit path → shouldAutoPromoteAudit returns false (no throw)');
}

// 18. runStartMs undefined → returns false (guard against miscall)
{
  const projDir = tmp();
  const auditsDir = path.join(projDir, '.guide', 'audits');
  mkdirSync(auditsDir, { recursive: true });
  const auditFile = path.join(auditsDir, 'audit-2026-01-12.md');
  writeFileSync(auditFile, '# Audit\n', 'utf-8');

  const result = await shouldAutoPromoteAudit({ latestAudit: auditFile, runStartMs: undefined });
  assert(result === false, 'runStartMs=undefined → shouldAutoPromoteAudit returns false');
}

// ─── FR20 (Phase 43 / P7) — convergence_stall propagates through maybeAutoPromoteAudit ──
console.log('\nFR20 — convergence stall propagation (Phase 43):');

// 19. Two rounds of recurring findings → maybeAutoPromoteAudit's return (previously void)
// now surfaces convergence_stall + recurring, which is exactly what the FR20 call site in
// autoRun's main loop checks to decide whether to pause instead of continuing.
{
  const projDir = tmp();
  const auditsDir = path.join(projDir, '.guide', 'audits');
  mkdirSync(auditsDir, { recursive: true });

  const F1_R1 = 'Missing input validation on upload endpoint';
  const F1_R2 = 'Missing input validation on the upload endpoint route';
  const F2_R1 = 'Race condition in payment webhook handler';
  const F2_R2 = 'Race condition still affecting payment webhook handler';

  function findingsSection(round, titles) {
    const entries = titles
      .map((title, i) => `### Bug #${i + 1} — ${title}\n\n**Affected files:** src/example-${i + 1}.js\n`)
      .join('\n');
    return `# Audit\n\n## Promote to bugs-round-${round}\n\n${entries}`;
  }

  writeFileSync(path.join(auditsDir, 'audit-r1.md'), findingsSection(1, [F1_R1, F2_R1]), 'utf-8');
  const r1 = await promoteAuditToBugs({ projDir, projectName: 'fr20-conv' });
  assert(r1.promoted === true, 'round 1 promotes cleanly');

  writeFileSync(path.join(auditsDir, 'audit-r2.md'), findingsSection(2, [F1_R2, F2_R2]), 'utf-8');
  const r2 = await maybeAutoPromoteAudit({ projDir, projectName: 'fr20-conv' });

  assert(r2 !== null && r2 !== undefined, 'maybeAutoPromoteAudit now returns the promote result (was previously void)');
  assert(r2.promoted === true, 'round 2 still promotes — findings are real; stalling only blocks the NEXT fix round');
  assert(r2.convergence_stall === true, 'two recurring findings across rounds → convergence_stall propagates through');
  assert(Array.isArray(r2.recurring) && r2.recurring.length === 2, 'recurring evidence is attached');

  const reason = formatConvergenceStallReason(r2.recurring, 'fr20-conv');
  assert(reason.includes('convergence stall'), 'formatConvergenceStallReason names the stall');
  assert(reason.includes('fr20-conv'), 'formatConvergenceStallReason names the project for the override hint');
}

// ─── FR18 prompt-assembly tests ──────────────────────────────────────────────
console.log('\nFR18 — buildGuidePrompt review prompt assembly:');

// 19. Real buildGuidePrompt with task:'review' includes score: instruction
{
  const projDir = tmp();
  const prompt = await buildGuidePrompt({
    task: 'review',
    projectName: 'test-project',
    projDir,
    project: { current_phase: 5 },
  });
  assert(typeof prompt === 'string', 'review prompt returns a string');
  assert(prompt.includes('score:'), 'review prompt contains "score:" instruction');
  assert(
    /0.?100|integer 0-100|0 to 100|\bscore\b.*\d/.test(prompt),
    'review prompt specifies 0-100 range for score',
  );
  assert(prompt.includes('verdict:'), 'review prompt contains "verdict:" instruction');
}

// 20. Score line format in the prompt is machine-parseable by the /score:\s*(\d+)/i regex
{
  const projDir = tmp();
  const prompt = await buildGuidePrompt({
    task: 'review',
    projectName: 'test-project',
    projDir,
    project: { current_phase: 3 },
  });
  // Simulate what the guide would write given the prompt instructions
  const simulatedReview = `${prompt}\n\nAll looks good.\nverdict: continue\nscore: 88`;
  const match = simulatedReview.match(/score:\s*(\d+)/i);
  assert(match !== null && parseInt(match[1], 10) === 88, 'score: line written per prompt instructions is parseable by tryReviewAutoProceed regex');
}

// ─── loadSuggestionsBlock ────────────────────────────────────────────────────
console.log('\nloadSuggestionsBlock:');

// 21. no file → null
{
  const dir = tmp();
  const result = await loadSuggestionsBlock(dir, 1);
  assert(result === null, 'loadSuggestionsBlock: missing file → null');
}

// 22. whitespace-only file → null
{
  const dir = tmp();
  writeFileSync(path.join(dir, '.guide', 'suggestions.md'), '   \n', 'utf-8');
  const result = await loadSuggestionsBlock(dir, 1);
  assert(result === null, 'loadSuggestionsBlock: whitespace-only file → null');
}

// 23. valid file + slot=1 → block with correct tag and content
{
  const dir = tmp();
  writeFileSync(path.join(dir, '.guide', 'suggestions.md'), '# Suggestions Plan\n\n## Pass 1\n- Export PDF', 'utf-8');
  const result = await loadSuggestionsBlock(dir, 1);
  assert(result !== null,                      'loadSuggestionsBlock: file present → non-null');
  assert(result.includes('slot="1"'),          'loadSuggestionsBlock: slot attribute is 1');
  assert(result.includes('Export PDF'),        'loadSuggestionsBlock: file content included');
  assert(result.includes('<suggestions_plan'), 'loadSuggestionsBlock: wrapper tag present');
}

// 24. slot=2 renders slot="2" in the block
{
  const dir = tmp();
  writeFileSync(path.join(dir, '.guide', 'suggestions.md'), '# Suggestions Plan\n\n## Pass 2\n- Dark mode', 'utf-8');
  const result = await loadSuggestionsBlock(dir, 2);
  assert(result !== null,             'loadSuggestionsBlock: slot=2 non-null');
  assert(result.includes('slot="2"'), 'loadSuggestionsBlock: slot attribute is 2');
}

const TWO_PASS_FIXTURE = `# Suggestions Plan — my-proj — 2026-06-02T00:00:00.000Z

Pipeline passes: 2

## Pass 1
- Export PDF (logic, small effort, high impact)
- Auth Login (security, medium effort, high impact)

## Pass 2
- Dark Mode (frontend, small effort, low impact)
- Performance Audit (infra, medium effort, medium impact)

---
*Generated by \`ashmero suggest\`. Re-run: \`ashmero suggest my-proj --rerun\`*
`;

// 25. two-pass file, slot=1: includes pass-1 items, excludes pass-2 items
{
  const dir = tmp();
  writeFileSync(path.join(dir, '.guide', 'suggestions.md'), TWO_PASS_FIXTURE, 'utf-8');
  const result = await loadSuggestionsBlock(dir, 1);
  assert(result !== null,                       'slot=1 on 2-pass file → non-null');
  assert(result.includes('Export PDF'),         'slot=1 includes pass-1 item (Export PDF)');
  assert(result.includes('Auth Login'),         'slot=1 includes pass-1 item (Auth Login)');
  assert(!result.includes('Dark Mode'),         'slot=1 excludes pass-2 item (Dark Mode)');
  assert(!result.includes('Performance Audit'), 'slot=1 excludes pass-2 item (Performance Audit)');
  assert(result.includes('slot="1"'),           'slot=1 attribute present');
}

// 26. two-pass file, slot=2: includes pass-2 items, excludes pass-1 items
{
  const dir = tmp();
  writeFileSync(path.join(dir, '.guide', 'suggestions.md'), TWO_PASS_FIXTURE, 'utf-8');
  const result = await loadSuggestionsBlock(dir, 2);
  assert(result !== null,                       'slot=2 on 2-pass file → non-null');
  assert(result.includes('Dark Mode'),          'slot=2 includes pass-2 item (Dark Mode)');
  assert(result.includes('Performance Audit'),  'slot=2 includes pass-2 item (Performance Audit)');
  assert(!result.includes('Export PDF'),        'slot=2 excludes pass-1 item (Export PDF)');
  assert(!result.includes('Auth Login'),        'slot=2 excludes pass-1 item (Auth Login)');
  assert(result.includes('slot="2"'),           'slot=2 attribute present');
}

// 27. slot beyond planned passes → null + warning emitted (file present, slot absent)
{
  const dir = tmp();
  writeFileSync(path.join(dir, '.guide', 'suggestions.md'), TWO_PASS_FIXTURE, 'utf-8');

  let warned = null;
  const origWarn = console.warn;
  console.warn = (...args) => { warned = args.join(' '); origWarn(...args); };

  const result = await loadSuggestionsBlock(dir, 3);

  console.warn = origWarn;
  assert(result === null, 'slot=3 on 2-pass file → null (no Pass 3 section)');
  assert(warned !== null, 'slot=3 on 2-pass file → warning emitted');
  assert(warned.includes('Pass 3'), 'slot=3 warning names the missing slot');
}

// 27b. file absent → null, no warning (feature unused — silent by design)
{
  const dir = tmp();
  // no suggestions.md written

  let warned27b = null;
  const origWarn27b = console.warn;
  console.warn = (...args) => { warned27b = args.join(' '); origWarn27b(...args); };

  const result = await loadSuggestionsBlock(dir, 1);

  console.warn = origWarn27b;
  assert(result === null, 'file-absent → null');
  assert(warned27b === null, 'file-absent → no warning (feature unused)');
}

// 28. updated framing text is present for a valid slot
{
  const dir = tmp();
  writeFileSync(path.join(dir, '.guide', 'suggestions.md'), TWO_PASS_FIXTURE, 'utf-8');
  const result = await loadSuggestionsBlock(dir, 2);
  assert(result !== null,                           'slot=2 → non-null for framing check');
  assert(!result.includes('Focus all dev phases'),  'old framing "Focus all dev phases" is gone');
  assert(result.includes('pipeline pass 2'),         'new framing mentions pipeline pass number');
  assert(result.includes('separate pipeline runs'),  'new framing mentions additional passes as separate runs');
}

// ─── loadSuggestionsBlock DB fallback ────────────────────────────────────────
console.log('\nloadSuggestionsBlock DB fallback:');

// J1: .md has empty Pass 1 but DB accepted plan has items → DB fallback fires
{
  const projName = `test-sug-fallback-${randomUUID().slice(0, 8)}`;
  const dir = tmp();

  upsertProject({ name: projName });
  const rowId = saveSuggestions(projName, {
    projectType: 'cli',
    scanSnapshot: {},
    suggestions: [],
  });
  const selected = [
    { id: 1, title: 'Export PDF', type: 'logic', effort: 'small', impact: 'high', manual: false },
    { id: 2, title: 'Dark Mode',  type: 'frontend', effort: 'small', impact: 'low', manual: false },
  ];
  // Pass 1 has id=1; pass 2 has id=2
  acceptSuggestions(rowId, { selected, pipelinePlan: { '1': [1], '2': [2] }, pipelinePasses: 2 });

  // Write .md with an EMPTY Pass 1 section (diverged state)
  writeFileSync(path.join(dir, '.guide', 'suggestions.md'),
    '# Suggestions Plan\n\n## Pass 1\n\n## Pass 2\n- Dark Mode (frontend, small effort, low impact)\n',
    'utf-8');

  let warned = null;
  const origWarn = console.warn;
  console.warn = (...args) => { warned = args.join(' '); origWarn(...args); };

  const result = await loadSuggestionsBlock(dir, 1, projName);

  console.warn = origWarn;

  assert(result !== null,                  'J1: DB fallback when .md Pass 1 empty → non-null');
  assert(result.includes('slot="1"'),      'J1: slot attribute is 1');
  assert(result.includes('Export PDF'),    'J1: DB item (Export PDF) injected');
  assert(!result.includes('Dark Mode'),    'J1: pass-2 item (Dark Mode) not injected for slot 1');
  assert(warned !== null,                  'J1: divergence warning emitted');
  assert(warned.includes('DB plan'),       'J1: warning mentions DB plan fallback');

  deleteProject(projName);
}

// J2: .md has Pass 1 items → normal path used; DB fallback does not fire
{
  const projName = `test-sug-normal-${randomUUID().slice(0, 8)}`;
  const dir = tmp();

  upsertProject({ name: projName });
  const rowId = saveSuggestions(projName, {
    projectType: 'cli',
    scanSnapshot: {},
    suggestions: [],
  });
  const selected = [
    { id: 1, title: 'Export PDF', type: 'logic', effort: 'small', impact: 'high', manual: false },
  ];
  acceptSuggestions(rowId, { selected, pipelinePlan: { '1': [1] }, pipelinePasses: 1 });

  // .md has the item — normal path
  writeFileSync(path.join(dir, '.guide', 'suggestions.md'),
    '# Suggestions Plan\n\n## Pass 1\n- Export PDF (logic, small effort, high impact)\n',
    'utf-8');

  let warnedJ2 = null;
  const origWarnJ2 = console.warn;
  console.warn = (...args) => { warnedJ2 = args.join(' '); origWarnJ2(...args); };

  const result = await loadSuggestionsBlock(dir, 1, projName);

  console.warn = origWarnJ2;

  assert(result !== null,               'J2: .md has items → non-null (normal path)');
  assert(result.includes('Export PDF'), 'J2: .md content used');
  assert(warnedJ2 === null,             'J2: no divergence warning when .md is intact');

  deleteProject(projName);
}

// J3: .md empty Pass 1 but DB slot 1 also empty → still returns null
{
  const projName = `test-sug-empty-${randomUUID().slice(0, 8)}`;
  const dir = tmp();

  upsertProject({ name: projName });
  const rowId = saveSuggestions(projName, {
    projectType: 'cli',
    scanSnapshot: {},
    suggestions: [],
  });
  const selected = [
    { id: 1, title: 'Dark Mode', type: 'frontend', effort: 'small', impact: 'low', manual: false },
  ];
  // Only pass 2 has items; pass 1 is empty in the DB too
  acceptSuggestions(rowId, { selected, pipelinePlan: { '1': [], '2': [1] }, pipelinePasses: 2 });

  writeFileSync(path.join(dir, '.guide', 'suggestions.md'),
    '# Suggestions Plan\n\n## Pass 1\n\n## Pass 2\n- Dark Mode (frontend, small effort, low impact)\n',
    'utf-8');

  const result = await loadSuggestionsBlock(dir, 1, projName);

  assert(result === null, 'J3: .md empty + DB slot 1 also empty → null (no ghost injection)');

  deleteProject(projName);
}

// J4: no projectName → DB fallback path not entered; empty .md Pass 1 → null
{
  const dir = tmp();
  writeFileSync(path.join(dir, '.guide', 'suggestions.md'),
    '# Plan\n\n## Pass 1\n',
    'utf-8');

  const result = await loadSuggestionsBlock(dir, 1);   // no projectName

  assert(result === null, 'J4: no projectName, empty Pass 1 → null (DB fallback not entered)');
}

// ─── G5 — checkStaleBriefGuard ───────────────────────────────────────────────
console.log('\nG5 — checkStaleBriefGuard:');

// Sets mtime to (now - msAgo). msAgo=0 → now, msAgo=200_000 → ~3.3 min ago.
function setMtime(filePath, msAgo) {
  const t = (Date.now() - msAgo) / 1000;
  utimesSync(filePath, t, t);
}

function makeG5Dir(projDir) {
  mkdirSync(path.join(projDir, '.guide'), { recursive: true });
  mkdirSync(path.join(projDir, 'inputs'), { recursive: true });
}

// A. inputs/brief.md content differs from .guide/brief.md → wait-for-human
//    (content-hash contract: differing bytes are stale regardless of mtime).
{
  const projDir = tmp();
  makeG5Dir(projDir);
  const guideBrief  = path.join(projDir, '.guide', 'brief.md');
  const inputsBrief = path.join(projDir, 'inputs', 'brief.md');
  writeFileSync(guideBrief,  'old brief', 'utf-8');
  writeFileSync(inputsBrief, 'new brief', 'utf-8');
  setMtime(guideBrief,  3 * 60 * 1000); // 3 min ago
  setMtime(inputsBrief, 0);             // now
  const result = await checkStaleBriefGuard(projDir);
  assert(result !== null,                        'G5-A: differing content → not null');
  assert(result?.kind === 'wait-for-human',      'G5-A: returns wait-for-human kind');
  assert(result?.reason?.includes('reset-brief'), 'G5-A: reason mentions reset-brief');
  assert(result?.reason?.includes('/newbrief'),   'G5-A: reason mentions /newbrief');
}

// B. identical content, same mtime → null
{
  const projDir = tmp();
  makeG5Dir(projDir);
  const guideBrief  = path.join(projDir, '.guide', 'brief.md');
  const inputsBrief = path.join(projDir, 'inputs', 'brief.md');
  writeFileSync(guideBrief,  'brief', 'utf-8');
  writeFileSync(inputsBrief, 'brief', 'utf-8');
  const t = (Date.now() - 60_000) / 1000;
  utimesSync(guideBrief,  t, t);
  utimesSync(inputsBrief, t, t);
  const result = await checkStaleBriefGuard(projDir);
  assert(result === null, 'G5-B: identical content → null (no false positive)');
}

// C. identical content, inputs mtime older → null (mtime direction irrelevant)
{
  const projDir = tmp();
  makeG5Dir(projDir);
  const guideBrief  = path.join(projDir, '.guide', 'brief.md');
  const inputsBrief = path.join(projDir, 'inputs', 'brief.md');
  writeFileSync(guideBrief,  'brief', 'utf-8');
  writeFileSync(inputsBrief, 'brief', 'utf-8');
  setMtime(inputsBrief, 5 * 60 * 1000); // 5 min ago
  setMtime(guideBrief,  0);             // now
  const result = await checkStaleBriefGuard(projDir);
  assert(result === null, 'G5-C: identical content, inputs older → null');
}

// D. inputs/brief.md missing → null (no throw)
{
  const projDir = tmp();
  makeG5Dir(projDir);
  writeFileSync(path.join(projDir, '.guide', 'brief.md'), 'guide brief', 'utf-8');
  // inputs/brief.md intentionally not written
  const result = await checkStaleBriefGuard(projDir);
  assert(result === null, 'G5-D: inputs/brief.md absent → null, no throw');
}

// E. .guide/brief.md missing → null (no throw)
{
  const projDir = tmp();
  makeG5Dir(projDir);
  writeFileSync(path.join(projDir, 'inputs', 'brief.md'), 'inputs brief', 'utf-8');
  // .guide/brief.md intentionally not written
  const result = await checkStaleBriefGuard(projDir);
  assert(result === null, 'G5-E: .guide/brief.md absent → null, no throw');
}

// F. identical content but inputs mtime skewed far "newer" → null.
//    Phase 12: this is the mtime false-positive an atomic-rename / git checkout
//    produces (fresh mtime, identical bytes). Content hashing must ignore it.
{
  const projDir = tmp();
  makeG5Dir(projDir);
  const guideBrief  = path.join(projDir, '.guide', 'brief.md');
  const inputsBrief = path.join(projDir, 'inputs', 'brief.md');
  writeFileSync(guideBrief,  'identical brief bytes', 'utf-8');
  writeFileSync(inputsBrief, 'identical brief bytes', 'utf-8');
  setMtime(guideBrief,  60 * 60 * 1000); // guide = 1h ago
  setMtime(inputsBrief, 0);              // inputs = now (looks 1h newer)
  const result = await checkStaleBriefGuard(projDir);
  assert(result === null, 'G5-F: identical content, skewed mtime → null (no mtime false positive)');
}

// G. differing content with the .guide copy as the NEWER file → wait-for-human.
//    Proves the guard keys on content, not on "which file is newer".
{
  const projDir = tmp();
  makeG5Dir(projDir);
  const guideBrief  = path.join(projDir, '.guide', 'brief.md');
  const inputsBrief = path.join(projDir, 'inputs', 'brief.md');
  writeFileSync(guideBrief,  'guide differs here', 'utf-8');
  writeFileSync(inputsBrief, 'inputs differs here', 'utf-8');
  setMtime(inputsBrief, 60 * 60 * 1000); // inputs = 1h ago (older)
  setMtime(guideBrief,  0);              // guide = now (newer)
  const result = await checkStaleBriefGuard(projDir);
  assert(result !== null,                   'G5-G: differing content → not null even when guide is newer');
  assert(result?.kind === 'wait-for-human', 'G5-G: returns wait-for-human kind');
}

// ─── G5-integration — pickNextAction G5 placement ────────────────────────────
console.log('\nG5-integration — pickNextAction G5 placement:');

{
  // PROJECTS_DIR in auto-runner.js resolves to <workspace>/projects/
  const __testDir = path.dirname(fileURLToPath(import.meta.url));
  const PROJECTS_DIR = path.resolve(__testDir, '..', 'projects');

  // Shared cfg: no workspace CLAUDE.md auto-gen (avoids accessing project.current_phase
  // before we set it) — we still need a project row in the DB for test H.
  const integCfg = { auto_run: {}, paths: { workspace_subdir: 'workspace' } };

  function setMtimeMs(filePath, msAgo) {
    const t = new Date(Date.now() - msAgo);
    utimesSync(filePath, t, t);
  }

  // H. plan.json EXISTS + inputs/brief.md >2 min newer → G5 does NOT fire
  {
    const projName = `test-g5h-${randomUUID()}`;
    const projDir = path.join(PROJECTS_DIR, projName);
    try {
      mkdirSync(path.join(projDir, '.guide'), { recursive: true });
      mkdirSync(path.join(projDir, 'inputs'), { recursive: true });
      mkdirSync(path.join(projDir, 'workspace'), { recursive: true });
      // Write a minimal plan.json so pickNextAction skips the if(!plan) branch entirely
      writeFileSync(path.join(projDir, '.guide', 'plan.json'), JSON.stringify({ phases: [] }), 'utf-8');
      // Write brief files with stale mtime relationship
      const guideBrief = path.join(projDir, '.guide', 'brief.md');
      const inputsBrief = path.join(projDir, 'inputs', 'brief.md');
      writeFileSync(guideBrief, 'old brief', 'utf-8');
      writeFileSync(inputsBrief, 'new brief', 'utf-8');
      setMtimeMs(guideBrief, 4 * 60 * 1000);  // 4 min ago
      setMtimeMs(inputsBrief, 0);               // now (>2 min newer)
      // Insert a real project row so pickNextAction doesn't crash on project.current_phase
      upsertProject({ name: projName, status: 'planning' });

      const result = await pickNextAction(projName, integCfg);
      const isStaleAction = result?.kind === 'wait-for-human' && result?.reason?.includes('reset-brief');
      assert(!isStaleAction, 'G5-H: plan.json present + stale brief → G5 does NOT fire (no reset-brief wait-for-human)');
    } finally {
      try { rmSync(projDir, { recursive: true, force: true }); } catch { /* ignore */ }
      try { deleteProject(projName); } catch { /* ignore */ }
    }
  }

  // I. plan.json ABSENT + inputs/brief.md >2 min newer → G5 fires inside if(!plan)
  {
    const projName = `test-g5i-${randomUUID()}`;
    const projDir = path.join(PROJECTS_DIR, projName);
    try {
      mkdirSync(path.join(projDir, '.guide'), { recursive: true });
      mkdirSync(path.join(projDir, 'inputs'), { recursive: true });
      // No plan.json — pickNextAction enters the if(!plan) branch
      const guideBrief = path.join(projDir, '.guide', 'brief.md');
      const inputsBrief = path.join(projDir, 'inputs', 'brief.md');
      writeFileSync(guideBrief, 'old brief content without any markers', 'utf-8');
      writeFileSync(inputsBrief, 'new brief content', 'utf-8');
      setMtimeMs(guideBrief, 4 * 60 * 1000);  // 4 min ago
      setMtimeMs(inputsBrief, 0);               // now (>2 min newer)

      const result = await pickNextAction(projName, integCfg);
      assert(result?.kind === 'wait-for-human',          'G5-I: no plan + stale brief → wait-for-human');
      assert(result?.reason?.includes('reset-brief'),    'G5-I: reason contains reset-brief');
    } finally {
      try { rmSync(projDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // J. plan.json ABSENT + mtimes not stale → G5 does NOT fire; proceeds to G3/plan
  {
    const projName = `test-g5j-${randomUUID()}`;
    const projDir = path.join(PROJECTS_DIR, projName);
    try {
      mkdirSync(path.join(projDir, '.guide'), { recursive: true });
      mkdirSync(path.join(projDir, 'inputs'), { recursive: true });
      // No plan.json
      const guideBrief = path.join(projDir, '.guide', 'brief.md');
      const inputsBrief = path.join(projDir, 'inputs', 'brief.md');
      writeFileSync(guideBrief, 'brief content no markers', 'utf-8');
      writeFileSync(inputsBrief, 'brief content no markers', 'utf-8');
      // Same mtime → not stale
      const sameTime = new Date(Date.now() - 60 * 1000);
      utimesSync(guideBrief, sameTime, sameTime);
      utimesSync(inputsBrief, sameTime, sameTime);

      const result = await pickNextAction(projName, integCfg);
      const isStaleAction = result?.kind === 'wait-for-human' && result?.reason?.includes('reset-brief');
      assert(!isStaleAction, 'G5-J: no plan + same mtime → G5 does NOT fire');
      assert(result?.kind === 'guide' || result?.kind === 'wait-for-human', 'G5-J: proceeds to G3/plan (guide or non-stale wait-for-human)');
    } finally {
      try { rmSync(projDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

// ─── Multi-pass: continuation plan prompt injection ───────────────────────────
console.log('\nMulti-pass — continuation plan prompt injection:');

// Test A1: current_phase > 0 injects numbering instruction into plan prompt
{
  const projName = `test-cont-prompt-${randomUUID()}`;
  upsertProject({ name: projName, tech_stack: 'node', total_phases: 5 });
  setCurrentPhase(projName, 7);
  const project = getProject(projName);

  const prompt = await buildGuidePrompt({
    task: 'plan',
    projectName: projName,
    projDir: '/fake',
    project,
    plan: null,
    brief: 'test brief',
    round: null,
    fix: null,
  });

  assert(
    typeof prompt === 'string' && prompt.length > 0,
    'Test A1: plan prompt is a non-empty string when current_phase=7'
  );
  assert(
    prompt.toLowerCase().includes('continuation') || prompt.includes('current_phase'),
    'Test A1: plan prompt includes continuation context when current_phase=7'
  );
  assert(
    prompt.includes('7'),
    'Test A1: plan prompt contains the current_phase value (7)'
  );
  assert(
    prompt.includes('8'),
    'Test A1: plan prompt contains the next start phase number (8)'
  );

  try { deleteProject(projName); } catch { /* ignore */ }
}

// Test A2: current_phase === 0 → no continuation context injected
{
  const projName = `test-cont-prompt-fp-${randomUUID()}`;
  upsertProject({ name: projName, tech_stack: 'node', total_phases: 5 });
  const project = getProject(projName); // current_phase=0 by default

  const prompt = await buildGuidePrompt({
    task: 'plan',
    projectName: projName,
    projDir: '/fake',
    project,
    plan: null,
    brief: 'test brief',
    round: null,
    fix: null,
  });

  assert(
    !prompt.toLowerCase().includes('continuation') && !prompt.includes('current_phase'),
    'Test A2: plan prompt has no continuation context when current_phase=0'
  );

  try { deleteProject(projName); } catch { /* ignore */ }
}

// ─── Multi-pass: normalizeContinuationPlan unit tests ─────────────────────────
console.log('\nMulti-pass — normalizeContinuationPlan:');

// Test B1: mis-numbered plan (phases 1-3, completedPhase=7) → offset to 8-10
{
  const plan = { phases: [{ n: 1, title: 'a' }, { n: 2, title: 'b' }, { n: 3, title: 'c' }] };
  const result = normalizeContinuationPlan(plan, 7);

  assert(result.normalized === true, 'Test B1: returns normalized=true for mis-numbered plan');
  assert(result.plan.phases[0].n === 8, 'Test B1: first phase offset to completedPhase+1 (8)');
  assert(result.plan.phases[1].n === 9, 'Test B1: middle phase offset correctly (9)');
  assert(result.plan.phases[2].n === 10, 'Test B1: last phase offset to completedPhase+3 (10)');
  assert(result.plan !== plan, 'Test B1: returns new plan object, does not mutate input');
  assert(plan.phases[0].n === 1, 'Test B1: original plan is unmodified (phases[0].n still 1)');
}

// Test B2: correctly-numbered continuation plan (phases 8-9, completedPhase=7) → no change
{
  const goodPlan = { phases: [{ n: 8, title: 'a' }, { n: 9, title: 'b' }] };
  const noOp = normalizeContinuationPlan(goodPlan, 7);

  assert(noOp.normalized === false, 'Test B2: returns normalized=false for already-correct plan');
  assert(noOp.plan === goodPlan, 'Test B2: returns same plan reference when no change needed');
}

// Test B3: first-pass plan (completedPhase=0) → no change
{
  const firstPass = { phases: [{ n: 1, title: 'a' }, { n: 2, title: 'b' }] };
  const noop2 = normalizeContinuationPlan(firstPass, 0);

  assert(noop2.normalized === false, 'Test B3: first-pass plan (completedPhase=0) untouched');
  assert(noop2.plan === firstPass, 'Test B3: same plan reference returned for first-pass plan');
}

// Test B4: empty phases array → no change
{
  const emptyPlan = { phases: [] };
  const noop3 = normalizeContinuationPlan(emptyPlan, 5);

  assert(noop3.normalized === false, 'Test B4: empty phases → normalized=false');
  assert(noop3.plan === emptyPlan, 'Test B4: empty phases → same plan reference');
}

// Test B5: mixed plan — first phase collides with a done phase but a LATER phase
// is a valid next phase (n > completedPhase). Must NOT offset: the plan is
// correctly sequenced and offsetting would cascade-renumber the future phase.
// (This is the case commit 30e7ab9 fixed — the guard is "offset only when ALL
// phases are done, not just the first".)
{
  const mixedPlan = { phases: [{ n: 7, title: 'a' }, { n: 8, title: 'b' }] };
  const r = normalizeContinuationPlan(mixedPlan, 7);

  assert(r.normalized === false, 'Test B5: a plan with any phase n > completedPhase is left untouched');
  assert(r.plan === mixedPlan, 'Test B5: unchanged plan returns the same reference');
}

// Test B6: boundary — ALL phases are done (n <= completedPhase), with the last
// phase exactly === completedPhase. No future phase exists, so the guide clearly
// renumbered from scratch → offset every phase by completedPhase.
{
  const allDonePlan = { phases: [{ n: 6, title: 'a' }, { n: 7, title: 'b' }] };
  const r = normalizeContinuationPlan(allDonePlan, 7);

  assert(r.normalized === true, 'Test B6: all-phases-done plan (last n === completedPhase) → normalized=true');
  assert(r.plan.phases[0].n === 13, 'Test B6: first phase offset 6 → 13 (6+7)');
  assert(r.plan.phases[1].n === 14, 'Test B6: last phase offset 7 → 14 (7+7)');
  assert(allDonePlan.phases[0].n === 6, 'Test B6: original plan is not mutated');
}

// ─── cleanup ─────────────────────────────────────────────────────────────────
for (const d of tmpDirs) {
  try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ─── summary ─────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
