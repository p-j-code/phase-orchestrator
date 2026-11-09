// Coach engine — looks at a project's current state and returns the single
// most useful "what to do next" suggestion as a sentence + 1-3 buttons.
//
// Designed for /coach in Telegram. Where next-actions.js answers
// "given that an X just finished, what's likely next?", coach.js answers
// "given the entire current state of this project, what's the next move?"
// They're complementary; next-actions runs after a job, coach runs on demand.
//
// Output shape (getCoachSuggestion / single fallback):
//   {
//     headline: string,              // one-sentence summary of current state
//     suggestion: string,            // one-sentence "do this next"
//     buttons: [{label, callback}],  // 1-3 inline buttons, primary first
//     why: string?,                  // optional explanation
//   }
//
// Output shape (getCoachView multi-stream):
//   { type: 'multi', sections: [...] }  — ≥1 unconsumed stream
//   { type: 'single', ...getCoachSuggestion() }  — all streams empty

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getProject, getPhases, getActiveAutoRun, getLastAutoRun,
  getCurrentBugRound, countRequirements, countBugs, listBugs, listRequirements,
} from '../state.js';
import { classifyPauseReason, PAUSE_KINDS } from './pause-classifier.js';
import {
  auditDir, roadmapDir, roadmapReviewedMarkerPath,
  findMostRecentAudit, findMostRecentRoadmap,
  detectHighestBugRound, bugRoundDir,
} from './guide-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function findMostRecentFile(dir, pattern) {
  try {
    const entries = await fs.readdir(dir);
    const matches = entries.filter((e) => pattern.test(e));
    if (matches.length === 0) return null;
    matches.sort().reverse(); // ISO-timestamp filenames sort lexicographically
    return path.join(dir, matches[0]);
  } catch { return null; }
}

// ─── Pure helper functions (no I/O, no DB) ───────────────────────────────────

function truncatePreview(text, maxLen = 80) {
  if (!text || text.length <= maxLen) return text || '';
  return text.slice(0, maxLen) + '…';
}

function sortVisibleSections(streams) {
  return streams
    .filter((s) => s.visible)
    .sort((a, b) => b.lastTouched - a.lastTouched);
}

// Returns true if the audit file has not yet been turned into a bug round.
// roundDirMtimeMs is null when no round dir exists at all.
function isAuditUnpromoted(auditMtimeMs, roundDirMtimeMs) {
  return roundDirMtimeMs === null || auditMtimeMs > roundDirMtimeMs;
}

// Returns true when the roadmap is the most-recent work artifact — i.e., no newer audit
// file or bug-round directory has been created since it was generated. A null argument
// means that artifact is absent, which imposes no freshness constraint.
// actedOn=true when the user has reviewed this exact roadmap (marker timestamp >= roadmap filename timestamp).
function isRoadmapFresh(roadmapMtimeMs, auditMtimeMs, roundDirMtimeMs, actedOn = false) {
  if (actedOn) return false;
  if (auditMtimeMs !== null && auditMtimeMs > roadmapMtimeMs) return false;
  if (roundDirMtimeMs !== null && roundDirMtimeMs > roadmapMtimeMs) return false;
  return true;
}

// Pure — no I/O. Blocks a roadmap enqueue when either an unreviewed fresh roadmap
// exists on disk OR a roadmap job is already pending/running in the queue.
export function roadmapStackBlocked({ unreviewedFresh, hasActiveRoadmapJob }) {
  return unreviewedFresh || hasActiveRoadmapJob;
}

// Extracts the creation timestamp from a roadmap filename produced by guide-paths.js:
// "roadmap-YYYY-MM-DDTHH-MM-SS.md" → ms via Date.parse. Returns null for non-matching names.
function parseRoadmapFilenameMs(filename) {
  const m = filename.match(/^roadmap-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.md$/);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
  return isNaN(ms) ? null : ms;
}

// Returns the first non-empty, trimmed line of content with any leading '#' markers
// and surrounding whitespace stripped. Returns '' for empty/whitespace-only input.
function firstContentLine(content) {
  if (!content) return '';
  for (const line of content.split('\n')) {
    const trimmed = line.replace(/^#+\s*/, '').trim();
    if (trimmed) return trimmed;
  }
  return '';
}

// Reads the .reviewed marker file and returns its timestamp as ms, or null.
async function readRoadmapReviewedAtMs(projDir) {
  const markerPath = roadmapReviewedMarkerPath(projDir);
  try {
    const content = await fs.readFile(markerPath, 'utf8');
    const ms = Date.parse(content.trim());
    return isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

/**
 * Returns true iff a roadmap exists AND isRoadmapFresh() returns true for it.
 * This is the single source of truth for whether the roadmap section is visible.
 */
export async function hasUnreviewedFreshRoadmap(projDir) {
  const latestRoadmap = await findMostRecentRoadmap(projDir);
  if (!latestRoadmap) return false;

  const roadmapStat = await fs.stat(latestRoadmap).catch(() => null);
  if (!roadmapStat) return false;

  const latestAudit = await findMostRecentAudit(projDir);
  const auditStat = latestAudit ? await fs.stat(latestAudit).catch(() => null) : null;

  const highestRound = await detectHighestBugRound(projDir);
  const roundDir = highestRound ? bugRoundDir(projDir, highestRound) : null;
  const roundStat = roundDir ? await fs.stat(roundDir).catch(() => null) : null;

  const reviewedAtMs = await readRoadmapReviewedAtMs(projDir);
  // Compare against filename ISO (UTC, stable across clone/extract), not mtime.
  const filenameMs = parseRoadmapFilenameMs(path.basename(latestRoadmap));
  const actedOn = reviewedAtMs !== null && reviewedAtMs >= (filenameMs ?? roadmapStat.mtimeMs);

  return isRoadmapFresh(
    roadmapStat.mtimeMs,
    auditStat ? auditStat.mtimeMs : null,
    roundStat ? roundStat.mtimeMs : null,
    actedOn,
  );
}

// ─── Async stream gatherers ───────────────────────────────────────────────────

async function gatherAuditStream(projDir, projectName) {
  const latestAudit = await findMostRecentAudit(projDir);
  if (!latestAudit) return { visible: false, key: 'audit' };

  const auditStat = await fs.stat(latestAudit).catch(() => null);
  if (!auditStat) return { visible: false, key: 'audit' };

  const highestRound = await detectHighestBugRound(projDir);
  const roundDir = highestRound ? bugRoundDir(projDir, highestRound) : null;
  const roundStat = roundDir ? await fs.stat(roundDir).catch(() => null) : null;

  const visible = isAuditUnpromoted(auditStat.mtimeMs, roundStat ? roundStat.mtimeMs : null);
  if (!visible) return { visible: false, key: 'audit' };

  const hasUnreviewed = await hasUnreviewedFreshRoadmap(projDir);

  // Read file body for content preview; fall back to basename on failure.
  let auditContent;
  try { auditContent = await fs.readFile(latestAudit, 'utf8'); } catch { auditContent = ''; }

  return {
    key: 'audit',
    emoji: '🔍',
    name: 'Audit',
    count: 1,
    preview: truncatePreview(firstContentLine(auditContent) || path.basename(latestAudit)),
    lastTouched: auditStat.mtimeMs,
    visible: true,
    buttons: [
      { label: '📖 Preview Audit', callback: `preview:${projectName}:audit` },
      { label: '📤 Promote',       callback: `prom:show:${projectName}` },
      ...(!hasUnreviewed
        ? [{ label: '🗺 Generate Roadmap', callback: `act:${projectName}:roadmap` }]
        : []),
    ],
  };
}

async function gatherRoadmapStream(projDir, projectName) {
  const latestRoadmap = await findMostRecentRoadmap(projDir);
  if (!latestRoadmap) return { visible: false, key: 'roadmap' };

  const roadmapStat = await fs.stat(latestRoadmap).catch(() => null);
  if (!roadmapStat) return { visible: false, key: 'roadmap' };

  // Hide the roadmap when a newer audit or newer bug-round dir exists —
  // the user has moved on to later work. Per Q1=A, we never track per-item
  // acceptance; this "superseded by newer artifact" heuristic is the proxy.
  const latestAudit = await findMostRecentAudit(projDir);
  const auditStat = latestAudit ? await fs.stat(latestAudit).catch(() => null) : null;

  const highestRound = await detectHighestBugRound(projDir);
  const roundDir = highestRound ? bugRoundDir(projDir, highestRound) : null;
  const roundStat = roundDir ? await fs.stat(roundDir).catch(() => null) : null;

  const reviewedAtMs = await readRoadmapReviewedAtMs(projDir);
  // Compare against filename ISO (UTC, stable across clone/extract), not mtime.
  const filenameMs = parseRoadmapFilenameMs(path.basename(latestRoadmap));
  const actedOn = reviewedAtMs !== null && reviewedAtMs >= (filenameMs ?? roadmapStat.mtimeMs);

  if (!isRoadmapFresh(
    roadmapStat.mtimeMs,
    auditStat ? auditStat.mtimeMs : null,
    roundStat ? roundStat.mtimeMs : null,
    actedOn,
  )) return { visible: false, key: 'roadmap' };

  // Read file body for content preview; fall back to basename on failure.
  let roadmapContent;
  try { roadmapContent = await fs.readFile(latestRoadmap, 'utf8'); } catch { roadmapContent = ''; }

  return {
    key: 'roadmap',
    emoji: '🗺',
    name: 'Roadmap',
    count: 1,
    preview: truncatePreview(firstContentLine(roadmapContent) || path.basename(latestRoadmap)),
    lastTouched: roadmapStat.mtimeMs,
    visible: true,
    buttons: [
      { label: '📖 Preview Roadmap', callback: `preview:${projectName}:roadmap` },
      { label: '✅ Mark Reviewed',   callback: `act:${projectName}:roadmap-review` },
    ],
  };
}

async function gatherBugsStream(projectName) {
  const unconsumedBugs = [
    ...(listBugs({ project: projectName, status: 'inbox' }) || []),
    ...(listBugs({ project: projectName, status: 'refined' }) || []),
  ];

  if (unconsumedBugs.length === 0) return { visible: false, key: 'bugs' };

  const sorted = [...unconsumedBugs].sort((a, b) => {
    const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
    const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
    return tb - ta;
  });

  const mostRecent = sorted[0];
  const lastTouched = mostRecent.created_at ? Date.parse(mostRecent.created_at) : Date.now();

  return {
    key: 'bugs',
    emoji: '🐛',
    name: 'Bugs Inbox',
    count: unconsumedBugs.length,
    preview: truncatePreview(mostRecent.raw_text || ''),
    lastTouched,
    visible: true,
    buttons: [
      { label: '📋 View Inbox',           callback: `bug:list:${projectName}` },
      { label: '📤 Promote to Fix Round', callback: `bug:promote-all:${projectName}` },
    ],
  };
}

async function gatherRequirementsStream(projectName) {
  const unconsumedReqs = [
    ...(listRequirements({ project: projectName, status: 'inbox' }) || []),
    ...(listRequirements({ project: projectName, status: 'refined' }) || []),
  ];

  if (unconsumedReqs.length === 0) return { visible: false, key: 'requirements' };

  const sorted = [...unconsumedReqs].sort((a, b) => {
    const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
    const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
    return tb - ta;
  });

  const mostRecent = sorted[0];
  const lastTouched = mostRecent.created_at ? Date.parse(mostRecent.created_at) : Date.now();

  return {
    key: 'requirements',
    emoji: '📥',
    name: 'Requirements Inbox',
    count: unconsumedReqs.length,
    preview: truncatePreview(mostRecent.raw_text || ''),
    lastTouched,
    visible: true,
    buttons: [
      { label: '📋 View Inbox', callback: `req:list:${projectName}` },
      { label: '⚡ Triage',     callback: `triage:start:${projectName}` },
    ],
  };
}

// ─── getCoachSuggestion — single-rec fallback (used by getCoachView) ──────────

/**
 * Get the coach's recommendation for a project.
 * Returns { headline, suggestion, buttons, why } — all strings except buttons.
 * This is now the single-recommendation fallback for getCoachView when all
 * multi-stream sections are empty/consumed.
 */
export async function getCoachSuggestion(projectName) {
  const project = getProject(projectName);
  if (!project) {
    return {
      headline: `Project ${projectName} not registered.`,
      suggestion: `Register it first with /new_project ${projectName} <git-remote>.`,
      buttons: [],
    };
  }

  const projDir = path.join(PROJECTS_DIR, projectName);
  const guideDir = path.join(projDir, '.guide');

  // Gather state signals
  const phases = getPhases(projectName) || [];
  const activeRun = getActiveAutoRun(projectName);
  const lastRun = getLastAutoRun(projectName);
  const bugRound = getCurrentBugRound(projectName);
  const reqCount = (countRequirements(projectName) || []).reduce((n, r) => n + r.n, 0);
  const bugCount = (countBugs(projectName) || []).reduce((n, r) => n + r.n, 0);
  const inboxReqs = listRequirements({ project: projectName, status: 'inbox' }) || [];
  const refinedReqs = listRequirements({ project: projectName, status: 'refined' }) || [];
  const pendingBugs = [
    ...(listBugs({ project: projectName, status: 'inbox' }) || []),
    ...(listBugs({ project: projectName, status: 'refined' }) || []),
  ];
  const criticalBugs = pendingBugs.filter((b) => b.severity === 'critical');

  const hasBrief    = await fileExists(path.join(guideDir, 'brief.md'));
  const hasPlan     = await fileExists(path.join(guideDir, 'plan.json'));
  const hasRawThoughts = await fileExists(path.join(guideDir, 'raw-thoughts.md'));
  const latestAudit = await findMostRecentFile(path.join(guideDir, 'audits'), /^audit-.*\.md$/);
  const latestRoadmap = await findMostRecentFile(path.join(guideDir, 'roadmaps'), /^roadmap-.*\.md$/);

  // ─── Ranked rules: first match wins ────────────────────────────────────
  // Ordered by urgency × user-action-required.

  // 1. Active auto-run currently running → tell them to wait or watch
  if (activeRun) {
    return {
      headline: `${projectName} has a job running right now.`,
      suggestion: `Wait for it. Tap Status to see progress.`,
      buttons: [
        { label: '📊 Status', callback: 'home:s' },
        { label: '✗ Cancel', callback: `cancel-pick:${activeRun.id}` },
      ],
      why: `Job #${activeRun.id} is in flight. Cancelling it kills the subprocess; check git status afterwards.`,
    };
  }

  // 1.5. Explicitly cancelled project — distinct from paused, no Resume as primary action
  if (project.status === 'cancelled') {
    return {
      headline: `⊘ ${projectName} was cancelled.`,
      suggestion: `The project was explicitly cancelled (abort or Ctrl-C). Inspect the last committed state, restart from the plan, or abandon.`,
      buttons: [
        { label: '🔍 Audit last state', callback: `act:${projectName}:audit` },
        { label: '🔁 Restart from plan', callback: `act:${projectName}:go` },
        { label: '📖 Read last phase report', callback: `preview:${projectName}:phase` },
      ],
      why: `projects.status is 'cancelled'. This is a terminal state set by the abort command or SIGINT propagation. Resume would start from the last checkpoint, which may be appropriate after inspection — but it is not the primary action.`,
    };
  }

  // 2. Paused auto-run → branch on pause kind. Uses classifyPauseReason (shared
  // classifier) via the stored pause_kind column (Path B), falling back to string
  // matching for NULL rows predating the migrate-pause-kind migration.
  //
  // Terminal kinds (all-phases-complete, fix-round-complete): Resume would loop — surface
  // QA/audit/ship actions instead. Mid-build kinds: Resume is the correct primary action.
  if (lastRun?.status === 'paused') {
    const reason = lastRun.pause_reason || '';
    const kind = lastRun.pause_kind ?? classifyPauseReason(reason);

    if (kind === PAUSE_KINDS.ALL_PHASES_COMPLETE) {
      const buttons = [];
      if (criticalBugs.length > 0) {
        buttons.push({ label: `🚨 Promote ${criticalBugs.length} critical bugs`, callback: `bug:promote-critical:${projectName}` });
      }
      buttons.push({ label: '🐛 Capture a QA bug', callback: `bug:start:${projectName}` });
      if (bugCount > 0 && criticalBugs.length === 0) {
        buttons.push({ label: `📥 See ${bugCount} pending bugs`, callback: `bug:list:${projectName}` });
      }
      buttons.push({ label: '📋 QA handoff', callback: `qa:${projectName}` });
      buttons.push({ label: '🔍 Final audit', callback: `act:${projectName}:audit` });
      buttons.push({ label: '🔧 Add new work (extend)', callback: `extend:help:${projectName}` });
      if (project.git_branch && project.git_branch !== 'main') {
        buttons.push({ label: '🚢 Ship to main', callback: `act:${projectName}:ship` });
      }
      return {
        headline: `${projectName} is built and waiting on you.`,
        suggestion: `All phases done. Capture any QA issues as bugs, run a final audit, generate QA handoff, or ship.`,
        buttons,
        why: `Tapping Resume would loop — there are no phases left to run. Reason from the run: "${reason.slice(0, 120)}".`,
      };
    }

    if (kind === PAUSE_KINDS.FIX_ROUND_COMPLETE) {
      const buttons = [];
      if (criticalBugs.length > 0) {
        buttons.push({ label: `🚨 Promote ${criticalBugs.length} critical bugs`, callback: `bug:promote-critical:${projectName}` });
      }
      buttons.push({ label: '📖 Read fix reports', callback: `preview:${projectName}:phase` });
      buttons.push({ label: '🐛 Capture next-round bugs', callback: `bug:start:${projectName}` });
      buttons.push({ label: '🔍 Fresh audit', callback: `act:${projectName}:audit` });
      if (project.git_branch && project.git_branch !== 'main') {
        buttons.push({ label: '🚢 Mark shipped', callback: `act:${projectName}:ship` });
      }
      return {
        headline: `${projectName} bug round complete — ready for re-test.`,
        suggestion: `Read fix reports, capture any remaining QA issues as bugs, or run a fresh audit.`,
        buttons,
        why: `All fixes in this round are done. Resuming would re-detect completion and loop. Reason: "${reason.slice(0, 120)}".`,
      };
    }

    if (kind === PAUSE_KINDS.BUDGET) {
      return {
        headline: `${projectName} is paused on budget.`,
        suggestion: `Inspect the call count, bump the budget in project.json, or cancel.`,
        buttons: [
          { label: '🔍 Audit last state', callback: `act:${projectName}:audit` },
          { label: '✗ Cancel project', callback: `cancel-pick:cancel` },
        ],
        why: `Budget guard paused the run. Bump max_total_calls in project.json and resume, or cancel to investigate. Reason: "${reason.slice(0, 120)}".`,
      };
    }

    // validator-failed, review-checkpoint, max-actions, mid-build, other — Resume is correct
    return {
      headline: `${projectName} is paused (${reason.slice(0, 80) || 'review checkpoint'}).`,
      suggestion: `Resume when you're ready, or read the review first.`,
      buttons: [
        { label: '⏯ Resume', callback: `act:${projectName}:resume` },
        { label: '📖 Read review', callback: `preview:${projectName}:review` },
      ],
      why: `Auto-pauses happen at phase boundaries, budget limits, or after validator failures. Resume picks up where it left off.`,
    };
  }

  // 3. Critical bugs in inbox → fix them now
  if (criticalBugs.length > 0) {
    return {
      headline: `${projectName} has ${criticalBugs.length} critical bug(s) waiting.`,
      suggestion: `Promote them to a fix round and let the orchestrator handle them.`,
      buttons: [
        { label: `🚨 Promote criticals (${criticalBugs.length})`, callback: `bug:promote-critical:${projectName}` },
        { label: '📋 See all bugs', callback: `bug:list:${projectName}` },
      ],
      why: `Critical bugs are bugs you flagged urgent. /bug_promote --critical creates round-N+1 just with those.`,
    };
  }

  // 4. In-progress bug round → continue or check status
  if (bugRound?.status === 'in-progress') {
    return {
      headline: `${projectName} has bug round-${bugRound.round} in progress.`,
      suggestion: `Run the round to fix the bugs.`,
      buttons: [
        { label: `🐞 Run bugs (round ${bugRound.round})`, callback: `act:${projectName}:bugs` },
        { label: '📖 Read bugs.md', callback: `preview:${projectName}:bugs` },
      ],
      why: `bug-rounds/round-${bugRound.round}/bugs.md exists but hasn't been executed. /run bugs reads it and applies fixes.`,
    };
  }

  // 5. Unpromoted audit → review + promote
  if (latestAudit) {
    const auditStat = await fs.stat(latestAudit).catch(() => null);
    if (auditStat) {
      // Detect promotion from disk — the in-progress DB row isn't reliable post-completion.
      const highestRound = await detectHighestBugRound(projDir);
      const roundDir = highestRound ? bugRoundDir(projDir, highestRound) : null;
      const roundStat = roundDir ? await fs.stat(roundDir).catch(() => null) : null;
      const unpromoted = isAuditUnpromoted(auditStat.mtimeMs, roundStat ? roundStat.mtimeMs : null);
      if (unpromoted) {
        return {
          headline: `${projectName} has a recent audit that hasn't been turned into fixes.`,
          suggestion: `Read it first, then promote the real findings to a bug round.`,
          buttons: [
            { label: '📖 Read audit', callback: `preview:${projectName}:audit` },
            { label: '📤 Promote audit', callback: `prom:show:${projectName}` },
          ],
          why: `Audits average ~25% false positives. Read first, then /promote (or tap the button) to create bug-rounds/round-N/bugs.md.`,
        };
      }
    }
  }

  // 6. Refined inbox items waiting to be promoted
  if (refinedReqs.length > 0 || inboxReqs.length >= 5) {
    return {
      headline: `${projectName} has ${reqCount} inbox items waiting.`,
      suggestion: refinedReqs.length > 0
        ? `Promote them to a brief and start planning.`
        : `Triage them first so you know which are urgent.`,
      buttons: refinedReqs.length > 0
        ? [
            { label: '📤 Promote + plan', callback: `req:promote-plan:${projectName}` },
            { label: '📋 Browse inbox', callback: `req:list:${projectName}` },
          ]
        : [
            { label: '⚡ Triage', callback: `triage:start:${projectName}` },
            { label: '📋 Browse inbox', callback: `req:list:${projectName}` },
          ],
      why: refinedReqs.length > 0
        ? `${refinedReqs.length} item(s) triaged + ready. /req_promote --plan queues brief+guide automatically.`
        : `Triage assigns priority + scope (now/next/later). Refined items are eligible for promotion.`,
    };
  }

  // 7. Has plan, hasn't run yet → /run go
  if (hasPlan && phases.every((p) => p.status === 'pending')) {
    return {
      headline: `${projectName} has a plan but hasn't been executed.`,
      suggestion: `Start the auto-run. It'll pause at phase 1 for a checkpoint, then keep going.`,
      buttons: [
        { label: '▶ Start auto-run', callback: `act:${projectName}:go` },
        { label: '💰 Predict cost first', callback: `predict:${projectName}` },
        { label: '📖 Read plan', callback: `preview:${projectName}:plan` },
      ],
      why: `/run go executes phases in order with auto-pauses for review. Predicting cost first is a one-call sanity check.`,
    };
  }

  // 8. Has plan, partially run → continue
  if (hasPlan && phases.some((p) => p.status === 'completed') && phases.some((p) => p.status === 'pending')) {
    const completed = phases.filter((p) => p.status === 'completed').length;
    return {
      headline: `${projectName} is partway through (${completed}/${phases.length} phases done).`,
      suggestion: `Resume the auto-run from where it left off.`,
      buttons: [
        { label: '▶ Continue auto-run', callback: `act:${projectName}:go` },
        { label: '➡ Just next phase', callback: `act:${projectName}:next` },
      ],
      why: `/run go is idempotent — it picks up at the next pending phase.`,
    };
  }

  // 9. Has brief but no plan → /run guide
  if (hasBrief && !hasPlan) {
    return {
      headline: `${projectName} has a brief but no plan yet.`,
      suggestion: `Generate the phase plan.`,
      buttons: [
        { label: '📚 Generate plan', callback: `act:${projectName}:guide` },
        { label: '📖 Read brief', callback: `preview:${projectName}:brief` },
      ],
      why: `/run guide reads brief.md and produces plan.json + per-phase prompts.`,
    };
  }

  // 10. Has raw-thoughts but no brief → /run brief
  if (hasRawThoughts && !hasBrief) {
    return {
      headline: `${projectName} has raw thoughts but no polished brief.`,
      suggestion: `Generate the brief, then the plan.`,
      buttons: [
        { label: '📝 Generate brief', callback: `act:${projectName}:brief` },
      ],
      why: `/run brief polishes raw-thoughts.md into a structured brief.md the guide agent can plan from.`,
    };
  }

  // 11. All phases complete, no audit → suggest audit before ship
  if (phases.length > 0 && phases.every((p) => p.status === 'completed') && !latestAudit) {
    return {
      headline: `${projectName} is fully built (${phases.length} phases done).`,
      suggestion: `Audit it before shipping. Or skip straight to ship if you're confident.`,
      buttons: [
        { label: '🔍 Audit before ship', callback: `act:${projectName}:audit` },
        { label: '🚢 Ship to main', callback: `act:${projectName}:ship` },
        { label: '📋 QA handoff', callback: `qa:${projectName}` },
      ],
      why: `An audit catches issues the per-phase reviews missed. Cheap insurance before /ship.`,
    };
  }

  // 11b. Recent roadmap exists and is unreviewed + project isn't mid-build →
  // suggest reading + acting on it. Guard on hasUnreviewedFreshRoadmap so
  // the suggestion disappears after the user taps "✅ Mark Reviewed".
  if (latestRoadmap && await hasUnreviewedFreshRoadmap(projDir)) {
    const isQuiescent = !activeRun
      && (phases.length === 0 || phases.every((p) => p.status === 'completed'))
      && !(bugRound?.status === 'in-progress');
    if (isQuiescent) {
      return {
        headline: `${projectName} has a recent roadmap with unacted-on suggestions.`,
        suggestion: `Read it and decide which items to actually build.`,
        buttons: [
          { label: '📖 Read roadmap', callback: `preview:${projectName}:roadmap` },
          { label: '📥 Capture an item', callback: `req:start:${projectName}` },
          { label: '✅ Mark Reviewed', callback: `act:${projectName}:roadmap-review` },
        ],
        why: `Roadmap items become either new projects (CLI: roadmap-accept --new-project) or requirements in an existing project (CLI: roadmap-accept --to-inbox). On mobile, the practical path is /req to capture items, then tap Mark Reviewed once you've captured what you need.`,
      };
    }
  }

  // 12. Has commits on develop ahead of main → ship
  if (project.git_branch && project.git_branch !== 'main') {
    return {
      headline: `${projectName} has commits on ${project.git_branch} not yet on main.`,
      suggestion: `Ship them when you're ready.`,
      buttons: [
        { label: '🚢 Ship', callback: `act:${projectName}:ship` },
        { label: '📊 Git status', callback: `git:${projectName}` },
      ],
      why: `/ship fast-forwards main to ${project.git_branch}. Refuses non-FF.`,
    };
  }

  // 13. Fresh project, nothing to do yet → capture requirements
  return {
    headline: `${projectName} is a fresh project with nothing to do yet.`,
    suggestion: `Capture some ideas to get started.`,
    buttons: [
      { label: '💬 Add a requirement', callback: `req:start:${projectName}` },
      { label: '📥 Multi-message capture', callback: `req:capture:${projectName}` },
      { label: '🔍 Audit current code', callback: `act:${projectName}:audit` },
    ],
    why: `Use /req to add ideas one at a time, or /capture for a brain-dump. When you have a few items, /triage and /req_promote --plan to get rolling.`,
  };
}

// ─── getCoachView — multi-stream dashboard data layer ─────────────────────────

/**
 * Returns a discriminated-union view of the project's pending work streams.
 * Phase 2 (Telegram render) consumes this directly.
 *
 * { type: 'multi', sections: [...] }  — when ≥1 stream is unconsumed
 * { type: 'single', ...getCoachSuggestion() }  — when all streams are empty
 */
export async function getCoachView(projectName) {
  const project = getProject(projectName);
  if (!project) {
    return {
      type: 'single',
      headline: `Project ${projectName} not registered.`,
      suggestion: `Register it first with /new_project ${projectName} <git-remote>.`,
      buttons: [],
    };
  }

  const projDir = path.join(PROJECTS_DIR, projectName);

  const [auditStream, roadmapStream, bugsStream, reqStream] = await Promise.all([
    gatherAuditStream(projDir, projectName),
    gatherRoadmapStream(projDir, projectName),
    gatherBugsStream(projectName),
    gatherRequirementsStream(projectName),
  ]);

  const sections = sortVisibleSections([auditStream, roadmapStream, bugsStream, reqStream]);

  if (sections.length === 0) {
    const s = await getCoachSuggestion(projectName);
    return { type: 'single', ...s };
  }

  return { type: 'multi', sections };
}

// ─── Self-test (matches src/config-resolver.js convention) ───────────────────

if (process.argv.includes('--selftest')) {
  let pass = 0, fail = 0;
  const ok  = (label) => { console.log('OK ', label); pass++; };
  const bad = (label) => { console.log('FAIL', label); fail++; };

  // 1. truncatePreview — short string unchanged
  const short = 'hello';
  truncatePreview(short) === short ? ok('truncate: short') : bad('truncate: short');

  // 2. truncatePreview — long string cut to 80 + '…'
  const long = 'a'.repeat(100);
  const cut = truncatePreview(long);
  (cut.length === 81 && cut.endsWith('…')) ? ok('truncate: long') : bad('truncate: long');

  // 3. isAuditUnpromoted — no round dir → always true
  isAuditUnpromoted(1000, null) === true ? ok('audit: no round dir → unpromoted') : bad('audit: no round dir → unpromoted');

  // 4. isAuditUnpromoted — audit older than round → consumed
  isAuditUnpromoted(1000, 2000) === false ? ok('audit: older than round → promoted') : bad('audit: older than round → promoted');

  // 5. isAuditUnpromoted — audit newer than round → unpromoted
  isAuditUnpromoted(3000, 2000) === true ? ok('audit: newer than round → unpromoted') : bad('audit: newer than round → unpromoted');

  // 6. sortVisibleSections — correct descending order
  const streams = [
    { visible: true, lastTouched: 100, key: 'audit' },
    { visible: true, lastTouched: 300, key: 'bugs' },
    { visible: false, lastTouched: 999, key: 'roadmap' }, // invisible → excluded
    { visible: true, lastTouched: 200, key: 'requirements' },
  ];
  const sorted = sortVisibleSections(streams);
  const keys = sorted.map((s) => s.key);
  (sorted.length === 3 && keys[0] === 'bugs' && keys[1] === 'requirements' && keys[2] === 'audit')
    ? ok('sort: recency order + invisible filtered')
    : bad('sort: recency order + invisible filtered');

  // 7. sortVisibleSections — all invisible → empty result
  const allHidden = [{ visible: false, lastTouched: 500, key: 'audit' }];
  sortVisibleSections(allHidden).length === 0 ? ok('sort: all hidden → empty') : bad('sort: all hidden → empty');

  // 8. isRoadmapFresh — no audit, no round → fresh (roadmap is newest by default)
  isRoadmapFresh(1000, null, null) === true
    ? ok('roadmap: no audit, no round → fresh')
    : bad('roadmap: no audit, no round → fresh');

  // 9. isRoadmapFresh — roadmap newest of all three → fresh
  isRoadmapFresh(3000, 1000, 2000) === true
    ? ok('roadmap: newer than audit and round → fresh')
    : bad('roadmap: newer than audit and round → fresh');

  // 10. isRoadmapFresh — audit newer than roadmap → superseded
  isRoadmapFresh(1000, 2000, null) === false
    ? ok('roadmap: audit newer → superseded')
    : bad('roadmap: audit newer → superseded');

  // 11. isRoadmapFresh — round dir newer than roadmap → superseded
  isRoadmapFresh(1000, null, 2000) === false
    ? ok('roadmap: round dir newer → superseded')
    : bad('roadmap: round dir newer → superseded');

  // 12. isRoadmapFresh — roadmap mtime equal to audit mtime → still fresh
  isRoadmapFresh(1000, 1000, null) === true
    ? ok('roadmap: equal to audit mtime → fresh (not strictly newer required)')
    : bad('roadmap: equal to audit mtime → fresh');

  // 13. isRoadmapFresh — actedOn=true always returns false (reviewed)
  isRoadmapFresh(1000, null, null, true) === false
    ? ok('roadmap: actedOn=true → section hidden regardless of supersede state')
    : bad('roadmap: actedOn=true → section should be hidden when acted on');

  // 14. isRoadmapFresh — actedOn=false + fresh → still fresh
  isRoadmapFresh(1000, null, null, false) === true
    ? ok('roadmap: actedOn=false + no audit/round → fresh (staleness not triggered)')
    : bad('roadmap: actedOn=false + no audit/round → fresh');

  // 15. roadmapStackBlocked — both false → allowed
  roadmapStackBlocked({ unreviewedFresh: false, hasActiveRoadmapJob: false }) === false
    ? ok('roadmapStackBlocked: both false → allowed')
    : bad('roadmapStackBlocked: both false → allowed');

  // 16. roadmapStackBlocked — unreviewedFresh → blocked
  roadmapStackBlocked({ unreviewedFresh: true, hasActiveRoadmapJob: false }) === true
    ? ok('roadmapStackBlocked: unreviewedFresh → blocked')
    : bad('roadmapStackBlocked: unreviewedFresh → blocked');

  // 17. roadmapStackBlocked — activeJob → blocked
  roadmapStackBlocked({ unreviewedFresh: false, hasActiveRoadmapJob: true }) === true
    ? ok('roadmapStackBlocked: activeJob → blocked')
    : bad('roadmapStackBlocked: activeJob → blocked');

  // 18. firstContentLine — heading stripped
  firstContentLine('# Fix Plan — Round 5') === 'Fix Plan — Round 5'
    ? ok('firstContentLine: heading line stripped')
    : bad('firstContentLine: heading line stripped');

  // 19. firstContentLine — plain prose unchanged
  firstContentLine('This is the first line.') === 'This is the first line.'
    ? ok('firstContentLine: plain prose unchanged')
    : bad('firstContentLine: plain prose unchanged');

  // 20. firstContentLine — leading blank lines skipped
  firstContentLine('\n\n## Real heading') === 'Real heading'
    ? ok('firstContentLine: leading blanks skipped')
    : bad('firstContentLine: leading blanks skipped');

  // 21. firstContentLine — empty/whitespace input → ''
  firstContentLine('   \n  \n  ') === ''
    ? ok('firstContentLine: empty/whitespace → empty string')
    : bad('firstContentLine: empty/whitespace → empty string');

  // 22. parseRoadmapFilenameMs — canonical filename → correct ms
  parseRoadmapFilenameMs('roadmap-2026-01-01T00-00-00.md') === Date.parse('2026-01-01T00:00:00Z')
    ? ok('parseRoadmapFilenameMs: canonical filename → correct ms')
    : bad('parseRoadmapFilenameMs: canonical filename → correct ms');

  // 23. parseRoadmapFilenameMs — non-matching name → null
  parseRoadmapFilenameMs('not-a-roadmap.md') === null
    ? ok('parseRoadmapFilenameMs: non-matching name → null')
    : bad('parseRoadmapFilenameMs: non-matching name → null');

  // 24. parseRoadmapFilenameMs — malformed roadmap name → null
  parseRoadmapFilenameMs('roadmap-malformed.md') === null
    ? ok('parseRoadmapFilenameMs: malformed roadmap name → null')
    : bad('parseRoadmapFilenameMs: malformed roadmap name → null');

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail > 0 ? 1 : 0);
}
