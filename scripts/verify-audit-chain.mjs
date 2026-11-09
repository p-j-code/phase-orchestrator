#!/usr/bin/env node
// verify-audit-chain.mjs — proves the v0.14.33 audit→bugs auto-chain primitive
// (promoteAuditToBugs) behaves correctly across its contract WITHOUT needing a
// live Claude call, the orchestrator DB, or the worker pool.
//
// What this covers:
//   1. happy path  — audit with a "## Promote to bugs-round-N" section writes
//                     a fresh bugs.md and reports { promoted:true, round:1 }.
//   2. idempotency — a second promote (bugs.md already there) refuses to clobber
//                     and reports { promoted:false, reason: '…already exists…' }.
//   3. append      — append:true adds a block to the existing bugs.md.
//   4. clean audit — an audit with NO promote section reports
//                     { promoted:false } (a clean audit must NOT fake a round).
//   5. no audit    — an empty project reports { promoted:false } gracefully.
//   6. round bump  — with round-1 present, the next promote auto-selects round 2.
//
// What this does NOT cover (needs the live server + a real audit):
//   - the runGuide('audit') call itself
//   - the autoRun() fix execution that the chain hands off to
// Those reuse the long-proven /run go path; this harness isolates the new glue.
//
// Run: node scripts/verify-audit-chain.mjs    (exit 0 = all pass, 1 = a failure)

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promoteAuditToBugs } from '../src/lib/audit-promote.js';
import { auditDir, bugsFilePath, detectHighestBugRound } from '../src/lib/guide-paths.js';
import { roundCleanlyDone, stageEnabled } from '../src/pipeline.js';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  \u2713 ${name}`); pass += 1; }
  else { console.log(`  \u2717 ${name}${detail ? `  — ${detail}` : ''}`); fail += 1; }
}

const PROMOTE_SECTION = `# Self-Audit — example

## Findings

Some narrative the extractor must NOT pull into bugs.md.

## Promote to bugs-round-1

### BUG-1
- **Severity:** CRITICAL
- **Files:** src/server/job-queue.js:120
- **Repro:** two workers claim the same row
- **Expected:** single claim
- **Actual:** double claim
- **Fix sketch:** guard the UPDATE with status='pending'

### BUG-2
- **Severity:** MAJOR
- **Files:** src/auto-runner.js:283
- **Repro:** round completes but status not flipped
- **Expected:** status='completed'
- **Actual:** stays in-progress
- **Fix sketch:** call setBugRoundStatus

## Out of scope

- perf work (must be stripped by the extractor)
`;

const NO_PROMOTE_AUDIT = `# Self-Audit — clean

## Findings

No actionable bugs found. Codebase looks healthy.

## Top 3 recommendations

1. Keep doing what you're doing.
`;

async function makeProj(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return dir;
}

async function writeAudit(projDir, body, name = `audit-${Date.now()}.md`) {
  const d = auditDir(projDir);
  await fs.mkdir(d, { recursive: true });
  const p = path.join(d, name);
  await fs.writeFile(p, body);
  return p;
}

async function fileHas(p, needle) {
  try { return (await fs.readFile(p, 'utf-8')).includes(needle); } catch { return false; }
}

async function main() {
  console.log('verify-audit-chain — promoteAuditToBugs contract\n');

  check('export is a function', typeof promoteAuditToBugs === 'function');

  // 1. happy path
  {
    const projDir = await makeProj('ac-happy-');
    await writeAudit(projDir, PROMOTE_SECTION);
    const r = await promoteAuditToBugs({ projDir, projectName: 'demo' });
    check('1a happy: promoted true', r.promoted === true, JSON.stringify(r));
    check('1b happy: round 1', r.round === 1, `round=${r.round}`);
    check('1c happy: bugsPath is the round-1 bugs.md',
      r.bugsPath === bugsFilePath(projDir, 1), r.bugsPath);
    check('1d happy: bugs.md exists on disk', await fileHas(r.bugsPath, 'BUG-1'));
    check('1e happy: contains BUG-2 too', await fileHas(r.bugsPath, 'BUG-2'));
    check('1f happy: header mentions Round 1', await fileHas(r.bugsPath, 'Round 1'));
    check('1g happy: out-of-scope stripped', !(await fileHas(r.bugsPath, 'perf work')));

    // 2. explicit-round collision — re-promoting the SAME round must refuse.
    //    (Back-to-back promotes with no round auto-advance instead — see 4.)
    const r2 = await promoteAuditToBugs({ projDir, projectName: 'demo', round: 1 });
    check('2a collision: promoted false', r2.promoted === false, JSON.stringify(r2));
    check('2b collision: reason mentions exists',
      /already exists/i.test(r2.reason || ''), r2.reason);

    // 3. explicit-round append — append:true on the populated round adds a block
    const r3 = await promoteAuditToBugs({ projDir, projectName: 'demo', round: 1, append: true });
    check('3a append: promoted true', r3.promoted === true, JSON.stringify(r3));
    check('3b append: appended flag', r3.appended === true);
    check('3c append: append block present',
      await fileHas(r3.bugsPath, 'Additional findings'));

    // 4. auto-advance — a fresh audit (new filename, no sentinel) with round-1 present picks round 2.
    //    In real usage every new audit run produces a new timestamped filename; the sentinel is
    //    per-basename, so a fresh audit bypasses the guard and auto-advances.
    const auditPath2 = await writeAudit(projDir, PROMOTE_SECTION, `audit-fresh-${Date.now()}.md`);
    const r4 = await promoteAuditToBugs({ projDir, projectName: 'demo', auditFile: auditPath2 });
    check('4a advance: promoted true', r4.promoted === true, JSON.stringify(r4));
    check('4b advance: auto-selected round 2', r4.round === 2, `round=${r4.round}`);
  }

  // 5. clean audit — nothing to promote
  {
    const projDir = await makeProj('ac-clean-');
    await writeAudit(projDir, NO_PROMOTE_AUDIT);
    const r = await promoteAuditToBugs({ projDir, projectName: 'demo' });
    check('5a clean: promoted false', r.promoted === false, JSON.stringify(r));
    check('5b clean: no bugs.md written',
      !(await fileHas(bugsFilePath(projDir, 1), 'BUG')), 'a clean audit must not create a round');
  }

  // 6. no audit at all
  {
    const projDir = await makeProj('ac-noaudit-');
    const r = await promoteAuditToBugs({ projDir, projectName: 'demo' });
    check('6a no-audit: promoted false', r.promoted === false, JSON.stringify(r));
    check('6b no-audit: reason mentions no audit', /no audit/i.test(r.reason || ''), r.reason);
  }

  // 8. per-audit sentinel — same audit cannot auto-advance twice without force:true
  {
    const projDir = await makeProj('ac-sentinel-');
    const auditPath = await writeAudit(projDir, PROMOTE_SECTION);

    const r1 = await promoteAuditToBugs({ projDir, projectName: 'demo' });
    check('8a sentinel: first promote succeeds', r1.promoted === true, JSON.stringify(r1));

    check('8b sentinel: sentinel file created',
      await fileHas(path.join(auditDir(projDir), `.promoted-${path.basename(auditPath)}`), String(r1.round)));

    const r2 = await promoteAuditToBugs({ projDir, projectName: 'demo' });
    check('8c sentinel: second auto-promote is blocked', r2.promoted === false, JSON.stringify(r2));

    check('8d sentinel: reason cites the prior round',
      (r2.reason || '').includes(String(r1.round)), r2.reason);

    check('8e sentinel: no new round created',
      (await detectHighestBugRound(projDir)) === r1.round);

    const r3 = await promoteAuditToBugs({ projDir, projectName: 'demo', force: true });
    check('8f sentinel: force:true bypasses sentinel and auto-advances round',
      r3.promoted === true && r3.round === r1.round + 1, JSON.stringify(r3));
  }

  // 9. static call-site check — both bypasser files must now route through the primitive
  {
    const parity = await fs.readFile(
      new URL('../src/server/telegram-parity-handlers.js', import.meta.url),
      'utf-8'
    );
    const orch = await fs.readFile(
      new URL('../src/orchestrator.js', import.meta.url),
      'utf-8'
    );

    check(
      '9a static: telegram-parity-handlers imports promoteAuditToBugs',
      parity.includes('promoteAuditToBugs'),
    );
    check(
      '9b static: orchestrator.js imports promoteAuditToBugs',
      orch.includes('promoteAuditToBugs'),
    );
  }

  // 10. dryRun mode — verifies no files are written, correct shape returned
  {
    // 10a: dryRun on sentinel-blocked audit returns {promoted:false} and does NOT write bugs.md
    const projDir = await makeProj('ac-dryrun-blocked-');
    const auditPath = await writeAudit(projDir, PROMOTE_SECTION);
    const real = await promoteAuditToBugs({ projDir, projectName: 'demo' });
    const dr1 = await promoteAuditToBugs({ projDir, projectName: 'demo', dryRun: true });
    const highestAfter = await detectHighestBugRound(projDir);
    check(
      '10a dryRun: sentinel-blocked → promoted:false, no new round written',
      dr1.promoted === false &&
      (dr1.reason || '').includes('already promoted') &&
      highestAfter === real.round,
      JSON.stringify(dr1),
    );

    // 10b: dryRun on fresh project (no sentinel, no prior round) returns {promoted:true, round:1}
    //      and does NOT write bugs.md
    const projDir2 = await makeProj('ac-dryrun-fresh-');
    await writeAudit(projDir2, PROMOTE_SECTION);
    const dr2 = await promoteAuditToBugs({ projDir: projDir2, projectName: 'demo', dryRun: true });
    const freshHighest = await detectHighestBugRound(projDir2);
    check(
      '10b dryRun: fresh project → promoted:true, round:1, no bugs.md written',
      dr2.promoted === true &&
      dr2.round === 1 &&
      freshHighest === null,
      JSON.stringify(dr2),
    );
  }

  // 11. atomic sentinel + I/O failure contract
  {
    // 11a. wx-open EEXIST → promoted:false with Concurrent reason
    const projDir = await makeProj('ac-atomic-');
    const auditPath = await writeAudit(projDir, PROMOTE_SECTION);
    // Pre-create the sentinel to simulate another promoter winning the race
    await fs.mkdir(auditDir(projDir), { recursive: true });
    const sentinelPath = path.join(auditDir(projDir), `.promoted-${path.basename(auditPath)}`);
    await fs.writeFile(sentinelPath, '1\n2026-01-01T00:00:00.000Z\n');
    const r = await promoteAuditToBugs({ projDir, projectName: 'demo' });
    // The fast-path sentinel read (lines 256-270) catches a pre-existing sentinel and
    // returns "Audit already promoted". The "Concurrent" reason fires only when the
    // sentinel is created after the fast-path read but before the wx-open (true race).
    // Both are valid sentinel-blocked returns for this test's purpose.
    check('11a atomic: pre-existing sentinel → promoted:false (sentinel blocked)',
      r.promoted === false && ((r.reason || '').includes('Concurrent') || (r.reason || '').includes('already promoted')),
      JSON.stringify(r));

    // 11b/11c. success path → both sentinel and bugs.md exist on disk
    const projDir2 = await makeProj('ac-atomic2-');
    const auditPath2 = await writeAudit(projDir2, PROMOTE_SECTION);
    const r2 = await promoteAuditToBugs({ projDir: projDir2, projectName: 'demo' });
    const sentinelPath2 = path.join(auditDir(projDir2), `.promoted-${path.basename(auditPath2)}`);
    let sentinelExists = false;
    try { await fs.access(sentinelPath2); sentinelExists = true; } catch {}
    check('11b atomic: success path → bugs.md exists on disk',
      r2.promoted === true && await fileHas(r2.bugsPath, 'BUG-1'),
      JSON.stringify(r2));
    check('11c atomic: success path → sentinel exists on disk',
      sentinelExists, `sentinelPath=${sentinelPath2}`);
  }

  // 7. pipeline pure helpers — the stop logic the full autopilot relies on.
  {
    // roundCleanlyDone: only a blocker should return false.
    check('7a clean: null is clean (nothing ran)', roundCleanlyDone(null) === true);
    check('7b clean: completed is clean', roundCleanlyDone({ status: 'completed' }) === true);
    check('7c clean: fix-round-complete pause is clean',
      roundCleanlyDone({ status: 'paused', pauseKind: 'fix-round-complete' }) === true);
    check('7d clean: all-phases-complete pause is clean',
      roundCleanlyDone({ status: 'paused', pauseKind: 'all-phases-complete' }) === true);
    check('7e blocker: budget pause is NOT clean',
      roundCleanlyDone({ status: 'paused', pauseKind: 'budget' }) === false);
    check('7f blocker: mid-build pause is NOT clean',
      roundCleanlyDone({ status: 'paused', pauseKind: 'mid-build' }) === false);
    check('7g blocker: failed is NOT clean', roundCleanlyDone({ status: 'failed' }) === false);
    check('7h blocker: cancelled is NOT clean', roundCleanlyDone({ status: 'cancelled' }) === false);

    // stageEnabled: stop point gates later stages, never earlier ones.
    check('7i stage: brief runs when stopAfter=brief', stageEnabled('brief', 'brief') === true);
    check('7j stage: build skipped when stopAfter=brief', stageEnabled('build', 'brief') === false);
    check('7k stage: fixes skipped when stopAfter=build', stageEnabled('fixes', 'build') === false);
    check('7l stage: all run when stopAfter=qa', ['brief', 'build', 'fixes', 'qa'].every((s) => stageEnabled(s, 'qa')));
    check('7m stage: unknown stopAfter defaults to full', stageEnabled('qa', 'bogus') === true);
  }

  console.log(`\n${fail === 0 ? '\u2713 ALL PASS' : '\u2717 FAILURES'} — ${pass} passed, ${fail} failed (expected 45)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('harness error:', e); process.exit(1); });
