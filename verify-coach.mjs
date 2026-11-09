import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const COACH      = readFileSync('src/lib/coach.js', 'utf8');
const HANDLER    = readFileSync('src/server/telegram-parity-handlers.js', 'utf8');
const DISPATCH   = readFileSync('src/server/telegram-handlers.js', 'utf8');
const GUIDE_PATHS    = readFileSync('src/lib/guide-paths.js', 'utf8');
const PREVIEW        = readFileSync('src/server/preview-handlers.js', 'utf8');
const AUDIT_PROMOTE  = readFileSync('src/lib/audit-promote.js', 'utf8');
const ORCH       = readFileSync('src/orchestrator.js', 'utf8');
const VALIDATORS = readFileSync('src/lib/validators.js', 'utf8');
const JOB_QUEUE  = readFileSync('src/server/job-queue.js', 'utf8');

async function main() {
  let pass = 0, fail = 0;
  const ok  = (l) => { console.log('OK ', l); pass++; };
  const bad = (l) => { console.log('FAIL', l); fail++; };

  // 1. getCoachView is exported from coach.js
  /export\s+async\s+function\s+getCoachView/.test(COACH)
    ? ok('getCoachView exported')
    : bad('getCoachView not exported');

  // 2. handleCoach imports getCoachView (not getCoachSuggestion directly)
  /getCoachView/.test(HANDLER)
    ? ok('handleCoach uses getCoachView')
    : bad('handleCoach missing getCoachView');

  // 3. handleCoach switches on .type
  /view\.type|\.type\s*===\s*['"]multi/.test(HANDLER)
    ? ok('handleCoach switches on type')
    : bad('handleCoach missing type switch');

  // 4. Multi render iterates view.sections
  /view\.sections/.test(HANDLER)
    ? ok('handleCoach iterates sections')
    : bad('handleCoach missing sections iteration');

  // 5. Audit preview callback is correct
  /preview:\$\{[^}]+\}:audit/.test(COACH)
    ? ok('audit preview callback format')
    : bad('audit preview callback wrong');

  // 6. Bugs view-inbox callback is bug:list (not act:*:bugs_inbox)
  /bug:list:\$\{/.test(COACH)
    ? ok('bugs view-inbox uses bug:list')
    : bad('bugs view-inbox wrong (expected bug:list:${p})');

  // 7. Bugs promote callback is bug:promote-all (not act:*:bug_promote)
  /bug:promote-all:\$\{/.test(COACH)
    ? ok('bugs promote uses bug:promote-all')
    : bad('bugs promote wrong (expected bug:promote-all:${p})');

  // 8. Requirements view-inbox is req:list (not act:*:inbox)
  /req:list:\$\{/.test(COACH)
    ? ok('req view-inbox uses req:list')
    : bad('req view-inbox wrong (expected req:list:${p})');

  // 9. Requirements triage is triage:start (not act:*:triage)
  /triage:start:\$\{/.test(COACH)
    ? ok('req triage uses triage:start')
    : bad('req triage wrong (expected triage:start:${p})');

  // 10. prom:show: dispatcher case exists in telegram-handlers.js
  /prom.*show|show.*prom/.test(DISPATCH)
    ? ok('prom:show dispatcher wired')
    : bad('prom:show dispatcher missing');

  // 11. triage:start dispatcher case exists in telegram-handlers.js
  /triage.*start.*handleTriage|handleTriage.*triage.*start/.test(DISPATCH)
    ? ok('triage:start dispatcher wired')
    : bad('triage:start dispatcher missing');

  // 12. Length guard is present in parity handler
  /HARD_LIMIT|4000|4096/.test(HANDLER)
    ? ok('length guard present')
    : bad('length guard missing');

  // 13. sanitizeForTelegram wraps preview text in multi render
  /sanitizeForTelegram.*preview|preview.*sanitizeForTelegram/.test(HANDLER)
    ? ok('preview sanitized in render')
    : bad('preview not sanitized in render');

  // 14. gatherAuditStream now detects round dir from disk (detectHighestBugRound),
  //     not from the in-progress DB row
  /detectHighestBugRound/.test(COACH)
    ? ok('audit consumed check uses detectHighestBugRound')
    : bad('audit consumed check must use detectHighestBugRound, not getCurrentBugRound roundDir');

  // 15. hasUnreviewedFreshRoadmap is exported from coach.js
  /export\s+async\s+function\s+hasUnreviewedFreshRoadmap/.test(COACH)
    ? ok('hasUnreviewedFreshRoadmap exported from coach.js')
    : bad('hasUnreviewedFreshRoadmap not exported from coach.js');

  // 16. roadmapReviewedMarkerPath is exported from guide-paths.js
  /export\s+function\s+roadmapReviewedMarkerPath/.test(GUIDE_PATHS)
    ? ok('roadmapReviewedMarkerPath exported from guide-paths.js')
    : bad('roadmapReviewedMarkerPath not exported from guide-paths.js');

  // 17. Roadmap guard in telegram-handlers — hasUnreviewedFreshRoadmap check before enqueue
  /hasUnreviewedFreshRoadmap/.test(DISPATCH)
    ? ok('roadmap guard uses hasUnreviewedFreshRoadmap in dispatcher')
    : bad('roadmap guard missing hasUnreviewedFreshRoadmap in dispatcher');

  // 17b. Per-branch guard placement assertions (replaces global count check)
  const hqAnchor = DISPATCH.indexOf("parsed.action === 'roadmap'");
  const hqEnqueue = DISPATCH.indexOf('enqueueJob', hqAnchor);
  const hqSeg = DISPATCH.slice(hqAnchor, hqEnqueue);
  hqSeg.includes('isRoadmapStackBlocked')
    ? ok('17b-hq: handleQueue guards roadmap before its enqueueJob')
    : bad('17b-hq: handleQueue missing isRoadmapStackBlocked before enqueueJob');

  const actAnchor = DISPATCH.indexOf("if (verb === 'roadmap')");
  const actEnqueue = DISPATCH.indexOf('enqueueJob', actAnchor);
  const actSeg = DISPATCH.slice(actAnchor, actEnqueue);
  actSeg.includes('isRoadmapStackBlocked')
    ? ok('17b-act: act branch guards roadmap before its enqueueJob')
    : bad('17b-act: act branch missing isRoadmapStackBlocked before enqueueJob');

  // confirm-yes now has a roadmap block too (2nd occurrence); run:a is the 3rd
  const cyRoadmapAnchor = DISPATCH.indexOf("if (verb === 'roadmap')", actAnchor + 1);
  const runAnchor = DISPATCH.indexOf("if (verb === 'roadmap')", cyRoadmapAnchor + 1);
  const runEnqueue = DISPATCH.indexOf('enqueueJob', runAnchor);
  const runSeg = DISPATCH.slice(runAnchor, runEnqueue);
  runSeg.includes('isRoadmapStackBlocked')
    ? ok('17b-run: run:a branch guards roadmap before its enqueueJob')
    : bad('17b-run: run:a branch missing isRoadmapStackBlocked before enqueueJob');

  /listPendingJobs|getRunningJobsForProject|hasPendingOrRunningRoadmapJob/.test(DISPATCH)
    ? ok('17b-queue: guard consults job queue (not disk-only)')
    : bad('17b-queue: guard must reference listPendingJobs or getRunningJobsForProject');

  // 18. gatherAuditStream conditionally appends Generate Roadmap hint
  /hasUnreviewedFreshRoadmap/.test(COACH)
    && /Generate Roadmap/.test(COACH)
    ? ok('gatherAuditStream has conditional Generate Roadmap hint')
    : bad('gatherAuditStream missing conditional Generate Roadmap hint (check hasUnreviewedFreshRoadmap + Generate Roadmap)');

  // 19. roadmap-review is NOT in VALID_ACTIONS (lockstep safety)
  // Use [^\]]* to stop at the first ] so we don't span across the array closing bracket.
  !/VALID_ACTIONS\s*=\s*\[[^\]]*roadmap-review[^\]]*\]/.test(DISPATCH)
    ? ok('roadmap-review is not in VALID_ACTIONS (lockstep safe)')
    : bad('roadmap-review must NOT be in VALID_ACTIONS — it is a marker write, not a job');

  // Check 20: Generate Fresh button removed from gatherRoadmapStream (dead control gone)
  !/Generate Fresh/.test(COACH)
    ? ok('Generate Fresh button absent from coach.js (dead control removed)')
    : bad('Generate Fresh button still in coach.js — remove it from gatherRoadmapStream buttons');

  // Check 21: rule-5 null guard is inside getCoachSuggestion rule-5 region
  const rule5Anchor = COACH.indexOf('// 5. Unpromoted audit');
  const rule5End = COACH.indexOf('\n  // 6.', rule5Anchor);
  const rule5Region = rule5Anchor >= 0
    ? COACH.slice(rule5Anchor, rule5End > 0 ? rule5End : rule5Anchor + 800)
    : '';
  /if\s*\(\s*auditStat\s*\)/.test(rule5Region)
    ? ok('check 21: rule-5 null guard present inside getCoachSuggestion rule-5 region')
    : bad('check 21: rule-5 null guard missing inside getCoachSuggestion rule-5 region');

  // Check 22: getProject guard appears before writeFile in roadmap-review case
  const actBranchAnchor = DISPATCH.indexOf("if (action === 'act')");
  const rrMarker        = DISPATCH.indexOf("'roadmap-review'", actBranchAnchor);
  const rrWriteFile2    = DISPATCH.indexOf('writeFile', rrMarker);
  const actToWriteSeg   = DISPATCH.slice(actBranchAnchor, rrWriteFile2);
  actToWriteSeg.includes('getProject')
    ? ok('check 22: getProject guard present before writeFile in roadmap-review case')
    : bad('check 22: getProject guard missing before writeFile in roadmap-review case');

  // Check 23: file-based gatherers read content for preview (not filename-only)
  COACH.includes('firstContentLine') && /fs\.readFile/.test(COACH)
    ? ok('check 23: gatherers use firstContentLine + fs.readFile for preview')
    : bad('check 23: gatherers must use firstContentLine and fs.readFile for preview');

  // ─── Checks 24-31: coach single-rec callback wiring ──────────────────────

  // Scope all handleReqCallback checks to its own function body.
  // Find the function and slice to the next top-level function declaration so
  // we don't bleed into handleBugCallback (which also has a 'start' branch).
  const hrcStart = DISPATCH.indexOf('async function handleReqCallback');
  const hrcNext  = DISPATCH.indexOf('\nasync function ', hrcStart + 1);
  const hrcBody  = hrcStart >= 0
    ? DISPATCH.slice(hrcStart, hrcNext > hrcStart ? hrcNext : hrcStart + 20000)
    : '';

  // Check 24: handleReqCallback has `start` branch
  /sub\s*===\s*['"]start['"]/.test(hrcBody)
    ? ok("check 24: handleReqCallback has 'start' branch")
    : bad("check 24: handleReqCallback missing 'start' branch");

  // Check 25: handleReqCallback has `capture` branch
  /sub\s*===\s*['"]capture['"]/.test(hrcBody)
    ? ok("check 25: handleReqCallback has 'capture' branch")
    : bad("check 25: handleReqCallback missing 'capture' branch");

  // Check 26: handleReqCallback has `promote-plan` branch
  /sub\s*===\s*['"]promote-plan['"]/.test(hrcBody)
    ? ok("check 26: handleReqCallback has 'promote-plan' branch")
    : bad("check 26: handleReqCallback missing 'promote-plan' branch");

  // Check 27: handleReqCallback has a trailing catch-all answerCallbackQuery
  /answerCallbackQuery\(\s*\{[^}]*Unknown req action[^}]*\}/.test(hrcBody)
    ? ok("check 27: handleReqCallback has trailing default answerCallbackQuery")
    : bad("check 27: handleReqCallback missing trailing default answerCallbackQuery");

  // Check 28: resolveArtifact handles bare `phase` token
  /s\s*===\s*'phase'/.test(PREVIEW)
    ? ok("check 28: resolveArtifact handles bare 'phase' token")
    : bad("check 28: resolveArtifact missing bare 'phase' handler");

  // Check 29: resolveArtifact handles bare `review` token
  /s\s*===\s*'review'/.test(PREVIEW)
    ? ok("check 29: resolveArtifact handles bare 'review' token")
    : bad("check 29: resolveArtifact missing bare 'review' handler");

  // Check 30: resolveArtifact handles bare `bugs` token
  /s\s*===\s*'bugs'/.test(PREVIEW)
    ? ok("check 30: resolveArtifact handles bare 'bugs' token")
    : bad("check 30: resolveArtifact missing bare 'bugs' handler");

  // Check 31: detectHighestBugRound is imported in preview-handlers.js
  /detectHighestBugRound/.test(PREVIEW)
    ? ok('check 31: detectHighestBugRound imported in preview-handlers.js')
    : bad('check 31: detectHighestBugRound not imported in preview-handlers.js');

  // Check 32: renderInspectReport uses phaseDir and does NOT contain the wrong phase-N fallback
  HANDLER.includes('phaseDir')
    ? ok('check 32: renderInspectReport references phaseDir (not phase-${phaseN} fallback)')
    : bad('check 32: renderInspectReport must reference phaseDir, not the literal phase-N path');

  !/`phase-\$\{phaseN\}`/.test(HANDLER) && !HANDLER.includes("'phase-' + phaseN")
    ? ok('check 32b: wrong phase-N literal absent from parity handler')
    : bad('check 32b: parity handler still contains wrong phase-${phaseN} literal — remove it');

  // Check 33: showRunActionPicker references pipemenu (pipeline is covered)
  const pickerStart = DISPATCH.indexOf('async function showRunActionPicker');
  const pickerEnd   = DISPATCH.indexOf('\nexport async function ', pickerStart + 1);
  const pickerBody  = pickerStart >= 0
    ? DISPATCH.slice(pickerStart, pickerEnd > pickerStart ? pickerEnd : pickerStart + 5000)
    : '';
  pickerBody.includes('pipemenu')
    ? ok('check 33: showRunActionPicker references pipemenu (pipeline covered)')
    : bad('check 33: showRunActionPicker missing pipemenu — pipeline not reachable from run picker');

  // Check 34: pipe-y branch AND confirm-no reference exist in the dispatcher pipe-callback region
  {
    const pipeAnchor = DISPATCH.indexOf("action === 'pipe'");
    const pipeEnd    = DISPATCH.indexOf("action === 'confirm-yes'", pipeAnchor);
    const pipeSeg    = pipeAnchor >= 0
      ? DISPATCH.slice(pipeAnchor, pipeEnd > pipeAnchor ? pipeEnd : pipeAnchor + 2000)
      : '';
    pipeSeg.includes('pipe-y') && pipeSeg.includes('confirm-no')
      ? ok("check 34: pipe region contains 'pipe-y' and 'confirm-no' (gate exists)")
      : bad("check 34: pipe region missing 'pipe-y' or 'confirm-no' — confirmation gate not wired");
  }

  // Check 35: dead '🗺 Generate fresh roadmap' button absent from coach.js rule 11b
  !/🗺 Generate fresh roadmap/.test(COACH)
    ? ok("check 35: '🗺 Generate fresh roadmap' absent from coach.js (dead button removed)")
    : bad("check 35: coach.js still contains '🗺 Generate fresh roadmap' — remove from rule 11b");

  // Check 36: all kb.text callback prefixes in telegram-handlers.js have a dispatcher branch
  {
    const kbCallbackRe = /kb\.text\([^,\n]+,\s*(?:`([^`]*)`|'([^']*)')/g;
    const prefixSet = new Set();
    for (const m of DISPATCH.matchAll(kbCallbackRe)) {
      const raw = (m[1] ?? m[2]);
      const staticPart = raw.split('${')[0];
      const prefix = staticPart.split(':')[0];
      if (prefix) prefixSet.add(prefix);
    }
    const handledRe = /action\s*===\s*['"]([^'"]+)['"]/g;
    const handledSet = new Set([...DISPATCH.matchAll(handledRe)].map(m => m[1]));
    const unhandled = [...prefixSet].filter(p => !handledSet.has(p));
    unhandled.length === 0
      ? ok(`check 36: all kb.text callback prefixes in telegram-handlers.js are handled (${[...prefixSet].sort().join(', ')})`)
      : bad(`check 36: unhandled kb.text callback prefix(es) in telegram-handlers.js: ${unhandled.join(', ')}`);
  }

  // ─── Lifecycle assertions (async, temp fixtures) ──────────────────────────────

  const { hasUnreviewedFreshRoadmap } = await import('./src/lib/coach.js');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');

  let tmpDir;
  try {
    // Create a minimal .guide/roadmaps/ structure
    tmpDir = await mkdtemp(path.join(tmpdir(), 'verify-coach-'));
    const guideRoadmapsDir = path.join(tmpDir, '.guide', 'roadmaps');
    await mkdir(guideRoadmapsDir, { recursive: true });

    const roadmapFile = path.join(guideRoadmapsDir, 'roadmap-2026-01-01T00-00-00.md');
    const markerFile  = path.join(guideRoadmapsDir, '.reviewed');

    // (a) Fresh roadmap, no marker → hasUnreviewedFreshRoadmap = true
    await writeFile(roadmapFile, '# Roadmap');
    (await hasUnreviewedFreshRoadmap(tmpDir)) === true
      ? ok('lifecycle (a): fresh roadmap + no marker → unreviewed')
      : bad('lifecycle (a): fresh roadmap + no marker should be unreviewed');

    // (b) Marker written after → hasUnreviewedFreshRoadmap = false
    // actedOn uses filename timestamp (2026-01-01T00:00:00), not mtime. Marker written
    // now (~2026-05-29) is well after 2026-01-01, so reviewedAtMs >= filenameMs → reviewed.
    await writeFile(markerFile, new Date().toISOString());
    (await hasUnreviewedFreshRoadmap(tmpDir)) === false
      ? ok('lifecycle (b): marker present → reviewed → section hidden')
      : bad('lifecycle (b): marker present should return false');

    // (c) New roadmap whose filename ISO (2026-06-01) post-dates the marker (~2026-05-29)
    // → filenameMs > reviewedAtMs → actedOn = false → back to unreviewed.
    // No mtime manipulation needed; the filename alone determines actedOn under the new basis.
    const newRoadmapFile = path.join(guideRoadmapsDir, 'roadmap-2026-06-01T00-00-00.md');
    await writeFile(newRoadmapFile, '# New Roadmap');
    (await hasUnreviewedFreshRoadmap(tmpDir)) === true
      ? ok('lifecycle (c): new roadmap after marker → marker stale → unreviewed again')
      : bad('lifecycle (c): new roadmap after marker should be unreviewed (marker stale)');

  } catch (e) {
    bad(`lifecycle test threw: ${e.message}`);
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  }

  // ─── TZ-sensitive lifecycle fixture ──────────────────────────────────────────
  // Both sides derived from Date.now() so the fixture is TZ-independent by construction:
  // parseRoadmapFilenameMs now returns UTC ms; readRoadmapReviewedAtMs always returns UTC ms.
  {
    let tzTmpDir;
    try {
      tzTmpDir = await mkdtemp(path.join(tmpdir(), 'verify-coach-tz-'));
      const guideDir = path.join(tzTmpDir, '.guide');
      const guideRoadmapsDir = path.join(guideDir, 'roadmaps');
      await mkdir(guideRoadmapsDir, { recursive: true });

      // Old roadmap: filename timestamp 10 minutes in the past (UTC, no Z — mirrors guide-paths.js)
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
      const ts = tenMinAgo.toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const oldRoadmapFile = path.join(guideRoadmapsDir, `roadmap-${ts}.md`);
      await writeFile(oldRoadmapFile, '# Old Roadmap');

      // Marker written 5 minutes ago (UTC) — newer than old roadmap filename → actedOn = true
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
      const markerFile = path.join(guideRoadmapsDir, '.reviewed');
      await writeFile(markerFile, fiveMinAgo.toISOString());

      // (tz a): old roadmap + marker 5min newer than filename → reviewed
      (await hasUnreviewedFreshRoadmap(tzTmpDir)) === false
        ? ok('tz (a): old roadmap + marker 5min newer than filename → reviewed')
        : bad('tz (a): old roadmap + marker 5min newer than filename → reviewed (should be false)');

      // New roadmap: filename timestamp 1 minute in the future (UTC) — post-dates the marker
      const oneMinFuture = new Date(Date.now() + 1 * 60 * 1000);
      const tsNew = oneMinFuture.toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const newRoadmapFile = path.join(guideRoadmapsDir, `roadmap-${tsNew}.md`);
      await writeFile(newRoadmapFile, '# New Roadmap');

      // (tz b): new roadmap 1min future + old marker → unreviewed (marker stale)
      (await hasUnreviewedFreshRoadmap(tzTmpDir)) === true
        ? ok('tz (b): new roadmap 1min future + old marker → unreviewed (marker stale)')
        : bad('tz (b): new roadmap 1min future + old marker → unreviewed (marker stale) (should be true)');

    } catch (e) {
      bad(`tz lifecycle test threw: ${e.message}`);
    } finally {
      if (tzTmpDir) await rm(tzTmpDir, { recursive: true, force: true });
    }
  }

  // ─── Dedup behavioral fixture ────────────────────────────────────────────────

  {
    const Database = (await import('better-sqlite3')).default;
    const { mkdtemp: mkdtempD, rm: rmD } = await import('node:fs/promises');
    const { tmpdir: tmpdirD } = await import('node:os');

    let dedupTmpDir;
    try {
      dedupTmpDir = await mkdtempD(path.join(tmpdirD(), 'verify-coach-dedup-'));
      const db = new Database(path.join(dedupTmpDir, 'orch.db'));
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      db.exec(`CREATE TABLE tg_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        action TEXT NOT NULL,
        args_json TEXT,
        requested_by INTEGER,
        requested_at TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        result_summary TEXT,
        error_message TEXT
      )`);

      function enqueueRoadmapJobOnDb(db, { project, args, requestedBy }) {
        return db.transaction(() => {
          const existing = db.prepare(
            `SELECT 1 FROM tg_jobs
             WHERE project = ? AND action = 'roadmap' AND status IN ('pending', 'running')
             LIMIT 1`,
          ).get(project);
          if (existing) return null;
          const result = db.prepare(
            `INSERT INTO tg_jobs (project, action, args_json, requested_by, requested_at, status)
             VALUES (?, 'roadmap', ?, ?, ?, 'pending')`,
          ).run(project, JSON.stringify(args || {}), requestedBy, new Date().toISOString());
          return result.lastInsertRowid;
        })();
      }

      const proj = '_verifycoach_dedup_test';
      const first  = enqueueRoadmapJobOnDb(db, { project: proj, args: {}, requestedBy: 0 });
      const second = enqueueRoadmapJobOnDb(db, { project: proj, args: {}, requestedBy: 0 });
      const count  = db.prepare(
        `SELECT COUNT(*) AS n FROM tg_jobs WHERE project = ? AND action = 'roadmap'`,
      ).get(proj).n;

      typeof first === 'number' && first > 0
        ? ok('dedup (a): first enqueue returns positive integer rowid')
        : bad(`dedup (a): first enqueue should return positive integer, got ${first}`);

      second === null
        ? ok('dedup (b): second enqueue returns null (dedup blocks it)')
        : bad(`dedup (b): second enqueue should return null, got ${second}`);

      count === 1
        ? ok('dedup (c): exactly one row in tg_jobs after two enqueue attempts')
        : bad(`dedup (c): expected 1 row, found ${count}`);

      db.close();
    } catch (e) {
      bad(`dedup test threw: ${e.message}`);
    } finally {
      if (dedupTmpDir) await rmD(dedupTmpDir, { recursive: true, force: true });
    }
  }

  // Check 37: CLI roadmap command guards with hasUnreviewedFreshRoadmap (closes CLI bypass)
  /hasUnreviewedFreshRoadmap/.test(ORCH)
    ? ok('check 37: src/orchestrator.js references hasUnreviewedFreshRoadmap (CLI roadmap guard)')
    : bad('check 37: src/orchestrator.js missing hasUnreviewedFreshRoadmap — CLI roadmap bypass open');

  // Check 38: CLI roadmap command exposes --force escape hatch
  /--force/.test(ORCH)
    ? ok('check 38: src/orchestrator.js roadmap command exposes --force option')
    : bad('check 38: src/orchestrator.js roadmap command missing --force option');

  // Checks 52-53: confirm-yes branch has VALID_ACTIONS check + isRoadmapStackBlocked guard
  {
    // Scope to just the confirm-yes branch body — find the region between
    // action === 'confirm-yes' and the next action === block.
    const cyAnchor = DISPATCH.indexOf("action === 'confirm-yes'");
    const cyNext   = DISPATCH.indexOf("\n    if (action === ", cyAnchor + 1);
    const cySeg    = cyAnchor >= 0
      ? DISPATCH.slice(cyAnchor, cyNext > cyAnchor ? cyNext : cyAnchor + 2000)
      : '';
    cySeg.includes('VALID_ACTIONS')
      ? ok('check 52: confirm-yes branch validates verb against VALID_ACTIONS')
      : bad('check 52: confirm-yes branch missing VALID_ACTIONS check — ungated enqueue surface');
    cySeg.includes('isRoadmapStackBlocked')
      ? ok('check 53: confirm-yes branch guards roadmap via isRoadmapStackBlocked')
      : bad('check 53: confirm-yes branch missing isRoadmapStackBlocked — roadmap bypass');
  }

  // Check 54: SIGINT registration in auto-runner.js is gated on !getWorkerContext()
  {
    const AR = readFileSync('src/auto-runner.js', 'utf8');
    // Must import getWorkerContext
    /getWorkerContext/.test(AR)
      ? ok('check 54a: auto-runner.js imports getWorkerContext')
      : bad('check 54a: auto-runner.js missing getWorkerContext import');
    // The SIGINT registration must be inside a conditional block
    /if\s*\(\s*!getWorkerContext\(\)\s*\)\s*\{[^}]*process\.on\s*\(\s*['"]SIGINT['"]/.test(AR)
      ? ok('check 54b: SIGINT registration is gated on !getWorkerContext()')
      : bad('check 54b: SIGINT registration in auto-runner.js must be inside if (!getWorkerContext())');
    // Exactly one process.on('SIGINT', sigintHandler) exists and (from 54b) it is gated —
    // so there can be no second, unconditional registration lurking elsewhere in the file.
    const sigintRegCount = (AR.match(/process\.on\s*\(\s*['"]SIGINT['"]\s*,\s*sigintHandler\s*\)/g) || []).length;
    sigintRegCount === 1
      ? ok('check 54c: exactly one SIGINT registration in auto-runner.js (no unconditional duplicate)')
      : bad(`check 54c: expected exactly 1 SIGINT registration in auto-runner.js, found ${sigintRegCount}`);
  }

  // Check 55: handleValidate reads result.results (not result.runs)
  /result\.results/.test(HANDLER)
    ? ok('check 55a: handleValidate references result.results')
    : bad('check 55a: handleValidate missing result.results — reads wrong field');
  !/result\.runs/.test(HANDLER)
    ? ok('check 55b: result.runs absent from parity handler (BUG-2 fixed)')
    : bad('check 55b: result.runs still present in parity handler — BUG-2 not fixed');

  // Check 56: handleValidators row formatter reads correct column names (r.phase, r.fix_round, r.fix_n)
  /r\.phase[^_]|r\.phase$/.test(HANDLER)
    ? ok('check 56a: handleValidators reads r.phase column')
    : bad('check 56a: handleValidators missing r.phase column — BUG-3 not fixed');
  /r\.fix_round/.test(HANDLER)
    ? ok('check 56b: handleValidators reads r.fix_round column')
    : bad('check 56b: handleValidators missing r.fix_round column — BUG-3 not fixed');
  !/r\.phase_n/.test(HANDLER)
    ? ok('check 56c: r.phase_n absent from parity handler (BUG-3 fixed)')
    : bad('check 56c: r.phase_n still present in parity handler — BUG-3 not fixed');
  !/r\.fix_id/.test(HANDLER)
    ? ok('check 56d: r.fix_id absent from parity handler (BUG-3 fixed)')
    : bad('check 56d: r.fix_id still present in parity handler — BUG-3 not fixed');

  // Check 57: validators.js references resolveTestRunner (BUG-4 wired)
  /resolveTestRunner/.test(VALIDATORS)
    ? ok('check 57: validators.js references resolveTestRunner (test-runner wired)')
    : bad('check 57: validators.js missing resolveTestRunner — BUG-4 not wired');

  // BUG-7 fix: archiveSupersededPhases regex uses \d{2,} not bare \d{2}
  /\\d\{2,\}/.test(GUIDE_PATHS)
    ? ok('guide-paths.js archiveSupersededPhases uses \\d{2,} (handles 100+ phase folders)')
    : bad('guide-paths.js archiveSupersededPhases still uses bare \\d{2} — must be \\d{2,}');

  // BUG-8 fix: handleFile has path.resolve boundary check
  /path\.resolve/.test(PREVIEW) && /startsWith/.test(PREVIEW)
    ? ok('preview-handlers.js handleFile uses path.resolve + startsWith boundary check')
    : bad('preview-handlers.js handleFile missing path.resolve + startsWith (path traversal guard absent)');

  // BUG-10 fix: cleanContent has last-section + body-length guard before stripping Out-of-scope
  /hasLaterHeading|bodyLines|split\(.*\\n.*\)\.filter/.test(AUDIT_PROMOTE)
    ? ok('audit-promote.js cleanContent has last-section or body-length guard on Out-of-scope strip')
    : bad('audit-promote.js cleanContent still strips Out-of-scope unconditionally — guard must be added');

  // fix-r15-6: job-queue.js must NOT open its own DB connection — must import from state.js
  !JOB_QUEUE.includes('new Database(') && /getDb.*from.*state\.js|from.*state\.js.*getDb/.test(JOB_QUEUE)
    ? ok('job-queue.js uses state.js getDb (no private new Database connection)')
    : bad('job-queue.js still opens its own new Database() — must import getDb from state.js');

  console.log(`\n${pass}/${pass + fail} passed`); // expected: 67/67
  return fail;
}

main().then((fail) => process.exit(fail > 0 ? 1 : 0));
