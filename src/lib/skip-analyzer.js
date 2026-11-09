// Skip Analyzer — detects phases that were marked complete but have gaps:
// missing commit SHAs, unreachable git commits, expected files absent, or
// missing phase reports. Called periodically by the auto-runner (every N phases)
// and once at go-start before the main loop begins.

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getDb } from '../state.js';
import { phaseReportPath } from './guide-paths.js';

/**
 * Analyze ALL completed phases (n <= completedPhase) for gaps.
 *
 * Two tiers of checks:
 *
 * Tier A — ALL DB phases (including pre-plan phases not in plan.json):
 *   db_integrity    — row has status=completed and commit_sha is not null
 *   phase_commits   — commit_sha is reachable in the workspace git repo
 *
 * Tier B — plan phases only (phases that exist in plan.json AND n <= completedPhase):
 *   files_expected  — every path in plan phase.files_expected exists on disk
 *   phase_reports   — .guide/phases/NN-.../report.md exists
 *
 * The rewind-to-repair logic only applies to plan phases (the auto-runner can only
 * re-dispatch phases that have a plan entry + prompt). Pre-plan gaps are reported
 * as warnings only — they indicate manually-run work that may need human review.
 *
 * Returns:
 *   { hasGaps, gaps, firstMissing, checkedCount }
 *   firstMissing — lowest-n plan phase gap (null if all plan phases are clean)
 *
 * GapInfo: { n, title, issues: string[], isPlanPhase: boolean }
 */
export async function analyzeSkippedPhases({
  projectName,
  plan,
  workspaceDir,
  projDir,
  completedPhase,
  checks = {},
}) {
  const doDb      = checks.db_integrity   !== false;
  const doCommits = checks.phase_commits  !== false;
  const doFiles   = checks.files_expected !== false;
  const doReports = checks.phase_reports  !== false;

  const db = getDb();

  // ── Tier A: ALL completed DB phases (covers pre-plan phases too) ──────────
  const dbRows = db
    .prepare('SELECT n, title, status, commit_sha FROM phases WHERE project = ? AND n <= ? ORDER BY n')
    .all(projectName, completedPhase);

  // Build a lookup of plan phases for tier-B checks
  const planPhaseMap = new Map((plan?.phases || [])
    .filter((p) => p.n <= completedPhase)
    .map((p) => [p.n, p]));

  const gaps = [];

  for (const row of dbRows) {
    // commitIssues  → DB status missing / commit sha absent / commit unreachable.
    //                 A missing status or unreachable SHA is rewind-worthy. A
    //                 NULL SHA alone is a state-tracking failure, not proof
    //                 that committed work is absent (older legacy runs did
    //                 exactly that), so it is reported but never auto-rewound.
    // fileIssues    → expected files or phase report absent while commit is verified.
    //                 Files can be renamed/deleted after a phase runs. WARN-ONLY.
    const commitIssues = [];
    const fileIssues   = [];
    const planPhase    = planPhaseMap.get(row.n) || null;

    // ── Check 1: DB integrity (all phases) ──────────────────────────────────
    let commitSha     = null;
    let commitVerified = false;
    if (doDb) {
      if (row.status !== 'completed') {
        commitIssues.push(`DB status is '${row.status}' (expected 'completed')`);
      } else if (!row.commit_sha) {
        commitIssues.push('completed in DB but commit_sha is NULL');
      } else {
        commitSha = row.commit_sha;
      }
    }

    // ── Check 2: commit reachable in git (all phases) ───────────────────────
    if (doCommits && commitSha) {
      try {
        execFileSync('git', ['-C', workspaceDir, 'cat-file', '-e', commitSha], { stdio: 'ignore' });
        commitVerified = true;
      } catch {
        commitIssues.push(`commit ${commitSha.slice(0, 8)} not found in workspace git history`);
      }
    }

    // ── Check 3: expected files (plan phases only) ───────────────────────────
    // Results go into fileIssues, not commitIssues — a verified commit proves
    // the work ran; missing files just mean they were renamed/moved later.
    if (doFiles && planPhase && Array.isArray(planPhase.files_expected)) {
      for (const spec of planPhase.files_expected) {
        // Strip trailing description: "foo.ts (modified — …)" → "foo.ts"
        const pathPart = spec.split(' (')[0].trim();

        // Guides write multi-file specs with various separators:
        //   "foo.ts + bar.ts"   "foo.ts, bar.ts"   "foo.ts and bar.ts"
        // Split on all of them and resolve each segment individually.
        const segments = pathPart
          .split(/\s+\+\s+|\s*,\s+|\s+and\s+/i)
          .map((s) => s.trim())
          .filter(Boolean);
        let baseDir = null;

        for (const seg of segments) {
          const hasPrefix = seg.startsWith('workspace/');
          const relWs = seg.replace(/^workspace\//, '').trim();
          if (!relWs) continue;

          // Bare filename → inherit directory from the previous fully-qualified path
          let resolved = relWs;
          if (!hasPrefix && baseDir && !relWs.includes('/')) {
            resolved = path.join(baseDir, relWs);
          }
          if (relWs.includes('/')) baseDir = path.dirname(relWs);

          try {
            if (resolved.includes('*')) {
              const dirPart = resolved.replace(/\/\*.*$/, '');
              const entries = await fs.readdir(path.join(workspaceDir, dirPart)).catch(() => null);
              if (!entries || entries.length === 0) fileIssues.push(`expected file missing: ${resolved}`);
            } else {
              await fs.access(path.join(workspaceDir, resolved));
            }
          } catch {
            fileIssues.push(`expected file missing: ${resolved}`);
          }
        }
      }
    }

    // ── Check 4: phase report (plan phases only) ─────────────────────────────
    if (doReports && planPhase) {
      const reportFile = await phaseReportPath(projDir, row.n, row.title);
      try {
        await fs.access(reportFile);
      } catch {
        fileIssues.push('phase report (.guide/phases/.../report.md) missing');
      }
    }

    const allIssues = [...commitIssues, ...fileIssues];
    if (allIssues.length > 0) {
      gaps.push({
        n:             row.n,
        title:         row.title || `phase ${row.n}`,
        issues:        allIssues,
        commitIssues,
        fileIssues,
        commitVerified,
        // True ONLY when the commit was positively verified AND the only issues
        // are file/report checks. Requires commitVerified=true — if commit checking
        // is disabled or the commit check failed, file gaps still trigger a rewind.
        // Rationale: a verified commit proves the work ran; missing files may have
        // been renamed/moved/deleted after the phase completed, not before.
        onlyFileGap:   commitVerified && commitIssues.length === 0 && fileIssues.length > 0,
        // A completed row without its SHA is actionable metadata debt, but
        // re-running it can duplicate already committed work. There is no safe
        // automatic SHA backfill: HEAD may belong to a later phase.
        onlyStateGap:  row.status === 'completed' && !row.commit_sha,
        isPlanPhase:   planPhase !== null,
      });
    }
  }

  // ── Tier B: plan phases that have NO DB row at all ───────────────────────
  // A plan phase could be missing from the DB entirely if the agent ran but
  // upsertPhase was never called (very rare but possible with forced kills).
  for (const planPhase of planPhaseMap.values()) {
    const alreadyChecked = dbRows.some((r) => r.n === planPhase.n);
    if (!alreadyChecked) {
      gaps.push({
        n:          planPhase.n,
        title:      planPhase.title || `phase ${planPhase.n}`,
        issues:     ['no DB row — plan phase never registered'],
        isPlanPhase: true,
      });
    }
  }

  // ── Tier C: numbered gaps between DB phases and plan start ──────────────
  // Detect phases that exist in neither the DB nor the plan but fall in the
  // numeric range [1 .. completedPhase]. For each gap number check git:
  //   - commit found  → old pipeline phase already done; info only, no rewind
  //   - no commit     → truly unaccounted; surface as a warning
  const dbNums   = new Set(dbRows.map((r) => r.n));
  const planNums = new Set(planPhaseMap.keys());
  const maxN     = completedPhase;

  // Build a set of all phase numbers covered in the range
  const coveredNums = new Set([...dbNums, ...planNums]);

  // Find the numeric range to scan: min covered to max covered
  const minCovered = coveredNums.size > 0 ? Math.min(...coveredNums) : 1;

  for (let n = minCovered; n <= maxN; n++) {
    if (coveredNums.has(n)) continue; // already checked above

    // Not in DB and not in plan — check git log for a phase-N: commit
    let gitCommit = null;
    try {
      const out = execFileSync(
        'git',
        ['-C', workspaceDir, 'log', '--oneline', '--all', `--grep=^phase-${n}:`],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      if (out) gitCommit = out.split('\n')[0]; // first matching commit line
    } catch { /* git unavailable — skip */ }

    if (gitCommit) {
      // Old pipeline commit exists — done work, just not in current DB/plan.
      // This is info-only; do NOT trigger a rewind for these.
      gaps.push({
        n,
        title:       `phase ${n} (not in plan)`,
        issues:      [`not in DB or plan — old pipeline commit exists: ${gitCommit.trim()}`],
        isPlanPhase: false,
        isOldPipeline: true,
      });
    } else {
      // No git commit and no DB/plan entry — truly unaccounted.
      gaps.push({
        n,
        title:       `phase ${n} (not in plan)`,
        issues:      ['not in DB, plan, or git — phase is completely unaccounted for'],
        isPlanPhase: false,
        isOldPipeline: false,
      });
    }
  }

  gaps.sort((a, b) => a.n - b.n);

  // firstMissing = lowest-n gap that is a plan phase AND has a repairable
  // commit-level issue. NULL SHA rows are state-tracking warnings: they do not
  // prove work is absent, and rewinding them creates duplicate-work loops.
  // File-only gaps (onlyFileGap=true) are warn-only — the commit proves the work ran;
  // missing files may simply have been renamed or deleted after the phase completed.
  // Rewinding for a file-only gap causes an infinite loop: idempotency finds the
  // existing commit, records it complete, skip-analyze fires again, rewinds again.
  const firstRewindableGap = gaps.find((g) => g.isPlanPhase && !g.onlyFileGap && !g.onlyStateGap);
  const firstMissing = firstRewindableGap ? firstRewindableGap.n : null;
  const checkedCount = coveredNums.size + gaps.filter((g) => !coveredNums.has(g.n)).length;

  return {
    hasGaps:      gaps.length > 0,
    gaps,
    firstMissing,   // only commit-level plan-phase gaps trigger a rewind
    checkedCount,
  };
}
