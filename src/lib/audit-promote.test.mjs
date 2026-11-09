// Phase 41 (CE-9) — promoteAuditToBugs drops a source-audit.txt pointer into
// the round dir alongside bugs.md, so the fix dev can read the ORIGINAL audit
// finding (file:line evidence, failure scenario, suggested approach) rather than
// only the promoted summary. The pointer stores the audit path RELATIVE to
// projDir; runDev re-bases it to the workspace CWD. Best-effort: a write failure
// is a warning, never a promote failure.
//
// Run with: node --test src/lib/audit-promote.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DB_PATH = ':memory:';

const { promoteAuditToBugs, parsePromotedFindings, fingerprintFinding, findingsMatch } = await import('./audit-promote.js');
const { auditDir, bugRoundDir, bugsFilePath, findingHistoryPath } = await import('./guide-paths.js');

const AUDIT_WITH_PROMOTE = `# Audit

## Summary

Found some issues.

## Promote to bugs-round-1

### BUG-1: Missing validation
- Severity: major
- Where: src/controllers/upload.js:42
- Details: Input not validated.
`;

async function makeProjWithAudit(label, auditName = 'audit-2026-07-08.md') {
  const projDir = mkdtempSync(path.join(tmpdir(), `aorch-audit-promote-${label}-`));
  const auditsDir = auditDir(projDir);
  await fs.mkdir(auditsDir, { recursive: true });
  const auditFile = path.join(auditsDir, auditName);
  await fs.writeFile(auditFile, AUDIT_WITH_PROMOTE, 'utf-8');
  return { projDir, auditFile };
}

test('promoteAuditToBugs: fresh write path writes source-audit.txt pointing (projDir-relative) at the promoted audit', async () => {
  const { projDir, auditFile } = await makeProjWithAudit('fresh');
  const r = await promoteAuditToBugs({ projDir, projectName: 'demo' });
  assert.equal(r.promoted, true);
  assert.equal(r.appended, false);

  const ptr = await fs.readFile(path.join(bugRoundDir(projDir, r.round), 'source-audit.txt'), 'utf-8');
  assert.equal(ptr.trim(), path.relative(projDir, auditFile));
  // The pointer must resolve back to the real audit file from projDir.
  assert.equal(path.resolve(projDir, ptr.trim()), auditFile);
});

test('promoteAuditToBugs: append path also writes source-audit.txt', async () => {
  const { projDir, auditFile } = await makeProjWithAudit('append');
  // Seed an existing bugs.md for round 1 so append:true is exercised.
  const round = 1;
  await fs.mkdir(bugRoundDir(projDir, round), { recursive: true });
  await fs.writeFile(bugsFilePath(projDir, round), '# Existing bugs\n', 'utf-8');

  const r = await promoteAuditToBugs({ projDir, projectName: 'demo', round, append: true });
  assert.equal(r.promoted, true);
  assert.equal(r.appended, true);

  const ptr = await fs.readFile(path.join(bugRoundDir(projDir, round), 'source-audit.txt'), 'utf-8');
  assert.equal(ptr.trim(), path.relative(projDir, auditFile));
});

test('promoteAuditToBugs: dryRun does NOT write source-audit.txt (no side effects)', async () => {
  const { projDir } = await makeProjWithAudit('dry');
  const r = await promoteAuditToBugs({ projDir, projectName: 'demo', dryRun: true });
  assert.equal(r.promoted, true);
  let existed = true;
  try { await fs.access(path.join(bugRoundDir(projDir, r.round), 'source-audit.txt')); }
  catch { existed = false; }
  assert.equal(existed, false, 'dryRun must not write the pointer');
});

test('promoteAuditToBugs: a pointer-write failure is a warning, not a promote failure (bugs.md still written, promoted:true)', async () => {
  const { projDir } = await makeProjWithAudit('warn');
  const round = 1;
  // Make the pointer write fail by pre-creating source-audit.txt AS A DIRECTORY
  // (writeFile → EISDIR). Use an explicit round so this pre-created round dir
  // doesn't bump detectHighestBugRound.
  await fs.mkdir(path.join(bugRoundDir(projDir, round), 'source-audit.txt'), { recursive: true });

  const r = await promoteAuditToBugs({ projDir, projectName: 'demo', round });
  assert.equal(r.promoted, true, 'promote still succeeds even though the pointer write failed');
  // bugs.md exists and carries the promoted content.
  const bugs = await fs.readFile(bugsFilePath(projDir, round), 'utf-8');
  assert.ok(bugs.includes('BUG-1'), 'bugs.md was written despite the pointer-write warning');
});

// ─── Phase 43 (P7): parsePromotedFindings ───────────────────────────────────

test('parsePromotedFindings: canonical "### Bug #N — <title>" headings with inline Affected files', () => {
  const section = `### Bug #1 — Missing input validation on upload endpoint

**Steps to reproduce:** ...
**Expected:** ...
**Actual:** ...
**Affected files:** src/controllers/upload.js, src/routes/upload.js

### Bug #2 — Race condition in payment webhook handler

**Steps to reproduce:** ...
**Affected files:** src/webhooks/payment.js
`;
  const findings = parsePromotedFindings(section);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].n, 1);
  assert.equal(findings[0].title, 'Missing input validation on upload endpoint');
  assert.deepEqual(findings[0].files, ['src/controllers/upload.js', 'src/routes/upload.js']);
  assert.equal(findings[1].n, 2);
  assert.equal(findings[1].title, 'Race condition in payment webhook handler');
  assert.deepEqual(findings[1].files, ['src/webhooks/payment.js']);
});

test('parsePromotedFindings: drift variants (bold-wrapped, backtick-wrapped, "Bug N" without #) all parse', () => {
  const section = `### **Bug #1** — Race condition in webhook handler

**Affected files:** src/webhooks/payment.js

#### \`Bug #2\`: Null pointer in export job

**Affected files:** src/jobs/export.js

### Bug 3 - Missing auth check on admin route

**Affected files:** src/routes/admin.js
`;
  const findings = parsePromotedFindings(section);
  assert.equal(findings.length, 3);
  assert.equal(findings[0].title, 'Race condition in webhook handler');
  assert.equal(findings[1].title, 'Null pointer in export job');
  assert.equal(findings[2].title, 'Missing auth check on admin route');
});

test('parsePromotedFindings: missing Affected-files line → files: []', () => {
  const section = '### Bug #1 — Some finding with no files line\n\n**Steps to reproduce:** ...\n';
  const findings = parsePromotedFindings(section);
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].files, []);
});

test('parsePromotedFindings: garbage/unstructured input → []', () => {
  assert.deepEqual(parsePromotedFindings('Just some prose about code quality, nothing structured here.'), []);
  assert.deepEqual(parsePromotedFindings(''), []);
  assert.deepEqual(parsePromotedFindings(null), []);
});

// ─── Phase 43 (P7): fingerprintFinding + findingsMatch ──────────────────────

test('fingerprintFinding: tokens sorted/unique/lowercase/>2 chars; files normalized+sorted', () => {
  const fp = fingerprintFinding('Missing Input Validation on the Upload Endpoint', ['b.js', 'a.js', 'a.js']);
  assert.deepEqual(fp.tokens, [...fp.tokens].sort());
  assert.ok(fp.tokens.includes('missing'));
  assert.ok(fp.tokens.includes('the')); // 3 chars — kept
  assert.ok(!fp.tokens.includes('on')); // 2 chars — dropped
  assert.deepEqual(fp.files, ['a.js', 'b.js']); // deduped + sorted
});

test('findingsMatch: paraphrased title (Jaccard >= 0.6) matches regardless of files', () => {
  const a = fingerprintFinding('Missing input validation on the upload endpoint', []);
  const b = fingerprintFinding('Missing input validation for upload endpoint route', []);
  assert.equal(findingsMatch(a, b), true);
});

test('findingsMatch: shared file + moderate title overlap (Jaccard >= 0.4) matches', () => {
  const a = fingerprintFinding(
    'Race condition causes duplicate charge in payment webhook handler',
    ['src/webhooks/payment.js'],
  );
  const b = fingerprintFinding(
    'Webhook handler for payment still allows duplicate charge sometimes',
    ['src/webhooks/payment.js'],
  );
  assert.equal(findingsMatch(a, b), true);
});

test('findingsMatch: unrelated findings (different titles, different files) do not match', () => {
  const a = fingerprintFinding('Missing input validation on upload endpoint', ['src/controllers/upload.js']);
  const b = fingerprintFinding('Unhandled promise rejection in export scheduler', ['src/jobs/export.js']);
  assert.equal(findingsMatch(a, b), false);
});

// ─── Phase 43 (P7): promoteAuditToBugs convergence integration ─────────────

const F1_R1 = 'Missing input validation on upload endpoint';
const F1_R2 = 'Missing input validation on the upload endpoint route'; // Jaccard 5/7 vs F1_R1
const F2_R1 = 'Race condition in payment webhook handler';
const F2_R2 = 'Race condition still affecting payment webhook handler'; // Jaccard 5/7 vs F2_R1

function auditWithFindings(round, findingTitles) {
  const entries = findingTitles.map((title, i) => `### Bug #${i + 1} — ${title}

**Steps to reproduce:** ...
**Expected:** ...
**Actual:** ...
**Affected files:** src/example-${i + 1}.js
`).join('\n');
  return `# Audit\n\n## Promote to bugs-round-${round}\n\n${entries}`;
}

async function writeAudit(projDir, name, content) {
  const auditsDir = auditDir(projDir);
  await fs.mkdir(auditsDir, { recursive: true });
  const p = path.join(auditsDir, name);
  await fs.writeFile(p, content, 'utf-8');
  return p;
}

test('promoteAuditToBugs convergence: round 1 promote writes history, no recurrence', async () => {
  const projDir = mkdtempSync(path.join(tmpdir(), 'aorch-convergence-r1-'));
  const audit1 = await writeAudit(projDir, 'audit-r1.md', auditWithFindings(1, [F1_R1, F2_R1]));

  const r = await promoteAuditToBugs({ projDir, projectName: 'convdemo', auditFile: audit1 });
  assert.equal(r.promoted, true);
  assert.deepEqual(r.recurring, []);
  assert.equal(r.convergence_stall, false);

  const history = (await fs.readFile(findingHistoryPath(projDir), 'utf-8')).trim().split('\n');
  assert.equal(history.length, 2, 'one history line per parsed finding');
  const entry = JSON.parse(history[0]);
  assert.equal(entry.round, r.round);
  assert.ok(Array.isArray(entry.tokens));
});

test('promoteAuditToBugs convergence: round 2 with ONE recurring finding → recurring returned + bugs.md annotated, no stall', async () => {
  const projDir = mkdtempSync(path.join(tmpdir(), 'aorch-convergence-r2-'));
  const audit1 = await writeAudit(projDir, 'audit-r1.md', auditWithFindings(1, [F1_R1, F2_R1]));
  const r1 = await promoteAuditToBugs({ projDir, projectName: 'convdemo', auditFile: audit1 });
  assert.equal(r1.promoted, true);

  const audit2 = await writeAudit(projDir, 'audit-r2.md', auditWithFindings(2, [F1_R2]));
  const r2 = await promoteAuditToBugs({ projDir, projectName: 'convdemo', auditFile: audit2 });
  assert.equal(r2.promoted, true);
  assert.equal(r2.recurring.length, 1);
  assert.equal(r2.recurring[0].matched_round, r1.round);
  assert.equal(r2.convergence_stall, false, 'a single recurring finding stays below stall_min_recurring (2)');

  const bugs = await fs.readFile(bugsFilePath(projDir, r2.round), 'utf-8');
  assert.ok(bugs.includes('Recurring findings (convergence warning)'), 'bugs.md annotated with the warning section');
});

test('promoteAuditToBugs convergence: round with TWO recurring findings → convergence_stall:true', async () => {
  const projDir = mkdtempSync(path.join(tmpdir(), 'aorch-convergence-stall-'));
  const audit1 = await writeAudit(projDir, 'audit-r1.md', auditWithFindings(1, [F1_R1, F2_R1]));
  await promoteAuditToBugs({ projDir, projectName: 'convdemo', auditFile: audit1 });

  const audit2 = await writeAudit(projDir, 'audit-r2.md', auditWithFindings(2, [F1_R2, F2_R2]));
  const r2 = await promoteAuditToBugs({ projDir, projectName: 'convdemo', auditFile: audit2 });
  assert.equal(r2.recurring.length, 2);
  assert.equal(r2.convergence_stall, true, 'two recurring findings meets default stall_min_recurring (2)');
});

test('promoteAuditToBugs convergence: force:true suppresses the stall flag but keeps recurring evidence', async () => {
  const projDir = mkdtempSync(path.join(tmpdir(), 'aorch-convergence-force-'));
  const audit1 = await writeAudit(projDir, 'audit-r1.md', auditWithFindings(1, [F1_R1, F2_R1]));
  await promoteAuditToBugs({ projDir, projectName: 'convdemo', auditFile: audit1 });

  const audit2 = await writeAudit(projDir, 'audit-r2.md', auditWithFindings(2, [F1_R2, F2_R2]));
  const r2 = await promoteAuditToBugs({ projDir, projectName: 'convdemo', auditFile: audit2, force: true });
  assert.equal(r2.recurring.length, 2, 'recurring evidence still reported');
  assert.equal(r2.convergence_stall, false, 'force:true is the operator override');
});

test('promoteAuditToBugs convergence: convergence.enabled:false → return + bugs.md byte-identical to pre-P7 (no history writes)', async () => {
  const projDir = mkdtempSync(path.join(tmpdir(), 'aorch-convergence-disabled-'));
  const audit1 = await writeAudit(projDir, 'audit-r1.md', auditWithFindings(1, [F1_R1]));

  const r = await promoteAuditToBugs({
    projDir, projectName: 'convdemo', auditFile: audit1, cfg: { auto_run: { convergence: { enabled: false } } },
  });
  assert.equal(r.promoted, true);
  assert.equal('recurring' in r, false, 'no recurring key when convergence is disabled');
  assert.equal('convergence_stall' in r, false, 'no convergence_stall key when convergence is disabled');

  const bugs = await fs.readFile(bugsFilePath(projDir, r.round), 'utf-8');
  assert.ok(!bugs.includes('Recurring findings'), 'no warning section appended when disabled');

  let historyExists = true;
  try { await fs.access(findingHistoryPath(projDir)); } catch { historyExists = false; }
  assert.equal(historyExists, false, 'no finding-history.jsonl written when convergence is disabled');
});
