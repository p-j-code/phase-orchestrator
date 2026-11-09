// Guide Paths v0.4 — single source of truth for .guide/ folder layout.
//
// Adds: rawThoughtsPath, briefQuestionsPath, auditDir, auditPath,
//       roadmapDir, roadmapPath helpers for v0.4 brief/audit/roadmap modes.

import fs from 'node:fs/promises';
import path from 'node:path';
import { slugify, pad2 } from './slug.js';

export function guideRoot(projectDir) { return path.join(projectDir, '.guide'); }
export function briefPath(projectDir) { return path.join(guideRoot(projectDir), 'brief.md'); }
export function briefVersionDir(projectDir) { return path.join(guideRoot(projectDir), 'briefs'); }
export function rawThoughtsPath(projectDir) { return path.join(guideRoot(projectDir), 'raw-thoughts.md'); }
export function briefQuestionsPath(projectDir) { return path.join(guideRoot(projectDir), 'brief-questions.md'); }
export function projectContextPath(projectDir) { return path.join(guideRoot(projectDir), 'project-context.md'); }
export function routingExtensionPath(projectDir) { return path.join(projectDir, 'routing-extension.json'); }
export function planJsonPath(projectDir) { return path.join(guideRoot(projectDir), 'plan.json'); }
export function planMdPath(projectDir) { return path.join(guideRoot(projectDir), 'plan.md'); }
export function planCoveragePath(projectDir) { return path.join(guideRoot(projectDir), 'plan-coverage.md'); }
export function sessionIdsPath(projectDir) { return path.join(guideRoot(projectDir), 'session-ids.json'); }
export function readmePath(projectDir) { return path.join(guideRoot(projectDir), 'README.md'); }
export function repoMapPath(projectDir) { return path.join(guideRoot(projectDir), 'repo-map.md'); }
// Phase 39 (CE-4): the PARSED structure ({ sha, tree, files }) backing
// repo-map.md — the .md body is already degraded and can't be re-rendered at
// a different focus/level, so the incremental + focus-rendering paths read
// this instead. Sibling file, same directory, same lifecycle.
export function repoMapCachePath(projectDir) { return path.join(guideRoot(projectDir), 'repo-map-cache.json'); }
export function contextFreshnessStatePath(projectDir) { return path.join(guideRoot(projectDir), 'context-freshness-state.json'); }

// Phase 50 — detached-worktree primitive: read-only concurrent work (verify
// P2 / review P3 / scout P6) pins to a fixed sha via `git worktree add
// --detach` so it never observes the live tree the next dev session is
// mutating. Lives directly under projDir (a sibling of .guide/ and
// workspace/) — NEVER under .guide/ (the guide agent's cwd) or inside
// workspace/ (the dev agent's cwd); either would corrupt a concurrent role's
// view of its own working tree. Naming convention for downstream consumers:
//   verify-<sha8>, review-<phaseN>-<sha8>, scout-<phaseN>-<sha8>
export function worktreesRoot(projectDir) { return path.join(projectDir, '.worktrees'); }

// Phase 55 (P8 speculative scout): the note a concurrent haiku scout call
// drafts for the phase AFTER the one currently in progress — orchestrator-
// persisted (the scout's read-only sandbox cannot Write) with a base_sha
// front-matter stamp, consumed exactly once by buildInlinePhasePrompt's
// caller then deleted. Sibling file directly under .guide/, same lifecycle
// class as repo-map.md/suggestions.md.
export function phaseScoutPath(projectDir, n) {
  return path.join(guideRoot(projectDir), `phase-${n}-scout.md`);
}

// Phase 62 — structured failure autopsy: one markdown file per auto_run that
// paused on an error/validator or failed outright, written by src/lib/autopsy.js
// after finalize persists status. Nested dir (mkdir recursive) directly under
// .guide/, same lifecycle class as audits/ and reviews/.
export function autopsyDir(projectDir) { return path.join(guideRoot(projectDir), 'autopsies'); }
export function autopsyPath(projectDir, runId) {
  return path.join(autopsyDir(projectDir), `run-${runId}.md`);
}

// ─── Path-traversal guard ───────────────────────────────────────────────────
// Phase/fix dir names derive from LLM-authored titles (plan.json / fix-plan
// titles). slugify() already restricts its output to [a-z0-9-], but this is a
// defense-in-depth backstop: it resolves the deepest existing ancestor of a
// candidate path (fs.realpath — the leaf itself may not exist yet) so a
// symlink planted somewhere in the chain can't smuggle the result outside
// baseDir, then rejects anything that still escapes.
async function realpathDeepestExisting(candidatePath) {
  let current = path.resolve(candidatePath);
  const suffix = [];
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return suffix.length ? path.join(real, ...suffix) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...suffix); // hit filesystem root
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

export async function assertInsideDir(baseDir, candidatePath) {
  const resolvedBase = await realpathDeepestExisting(baseDir);
  const resolvedCandidate = await realpathDeepestExisting(candidatePath);
  const relative = path.relative(resolvedBase, resolvedCandidate);
  const escapes = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (escapes) {
    throw new Error(
      `[guide-paths] assertInsideDir: rejected path "${candidatePath}" — resolves to "${resolvedCandidate}", which escapes base directory "${resolvedBase}"`,
    );
  }
  return resolvedCandidate;
}

export async function phaseDirFromTitle(projectDir, n, title) {
  const phasesDir = path.join(guideRoot(projectDir), 'phases');
  const candidate = path.join(phasesDir, `${pad2(n)}-${slugify(title)}`);
  await assertInsideDir(phasesDir, candidate);
  return candidate;
}

export async function findPhaseDir(projectDir, n) {
  const phasesDir = path.join(guideRoot(projectDir), 'phases');
  try {
    const entries = await fs.readdir(phasesDir);
    const prefix = `${pad2(n)}-`;
    const match = entries.find((e) => e.startsWith(prefix));
    if (match) return path.join(phasesDir, match);
  } catch { /* ignore */ }
  return null;
}

export async function phaseDir(projectDir, n, fallbackTitle) {
  const found = await findPhaseDir(projectDir, n);
  if (found) {
    // If the caller knows the expected title, verify the found folder belongs to
    // the current plan. findPhaseDir only matches the NN- prefix, so a superseded
    // plan's folder (e.g. 01-cost-rollup-...) would otherwise be returned when
    // the new plan's phase N has a different title — causing the dev agent to run
    // the wrong prompt.
    if (!fallbackTitle) return found;
    const expectedName = `${pad2(n)}-${slugify(fallbackTitle)}`;
    if (path.basename(found) === expectedName) return found;
    // Title mismatch — this folder belongs to a different plan; generate the
    // correct path for the new plan's title instead.
  }
  return await phaseDirFromTitle(projectDir, n, fallbackTitle || `phase-${n}`);
}

export async function phasePromptPath(projectDir, n, fallbackTitle) {
  return path.join(await phaseDir(projectDir, n, fallbackTitle), 'prompt.md');
}
export async function phaseReportPath(projectDir, n, fallbackTitle) {
  return path.join(await phaseDir(projectDir, n, fallbackTitle), 'report.md');
}
export async function phaseVerifyPath(projectDir, n, fallbackTitle) {
  return path.join(await phaseDir(projectDir, n, fallbackTitle), 'verify.json');
}

// phase-29 (adversarial dual checker): sibling to phaseVerifyPath — carries
// both raw panel checker verdicts + the adjudication (if any), separate from
// verify.json (which always holds the single MERGED/final verdict so every
// other consumer of verify.json is unaffected by the panel feature).
export async function phaseVerifyPanelPath(projectDir, n, fallbackTitle) {
  return path.join(await phaseDir(projectDir, n, fallbackTitle), 'verify-panel.json');
}

export function reviewPath(projectDir, afterPhase) {
  return path.join(guideRoot(projectDir), 'reviews', `after-${afterPhase}.md`);
}

// Phase 36 (panel review): sibling to reviewPath — one file per lens (lens 1
// is the guide's own resumed review, lenses 2/3 are fresh/roleless/scoped
// spawns). The deterministic merge of all three (mergeLensReviews,
// src/lib/review-weight.js) lands at the SAME reviewPath a full/light review
// would use.
export function reviewLensPath(projectDir, afterPhase, lens) {
  return path.join(guideRoot(projectDir), 'reviews', `after-${afterPhase}-lens-${lens}.md`);
}

export function bugRoundDir(projectDir, round) {
  return path.join(guideRoot(projectDir), 'bug-rounds', `round-${round}`);
}
export function bugsFilePath(projectDir, round) { return path.join(bugRoundDir(projectDir, round), 'bugs.md'); }
export function fixPlanJsonPath(projectDir, round) { return path.join(bugRoundDir(projectDir, round), 'plan.json'); }
export function fixPlanMdPath(projectDir, round) { return path.join(bugRoundDir(projectDir, round), 'plan.md'); }

export async function fixDirFromTitle(projectDir, round, n, title) {
  const fixesDir = path.join(bugRoundDir(projectDir, round), 'fixes');
  const candidate = path.join(fixesDir, `${pad2(n)}-${slugify(title)}`);
  await assertInsideDir(fixesDir, candidate);
  return candidate;
}

export async function findFixDir(projectDir, round, n) {
  const fixesDir = path.join(bugRoundDir(projectDir, round), 'fixes');
  try {
    const entries = await fs.readdir(fixesDir);
    const prefix = `${pad2(n)}-`;
    const match = entries.find((e) => e.startsWith(prefix));
    if (match) return path.join(fixesDir, match);
  } catch { /* ignore */ }
  return null;
}

export async function fixDir(projectDir, round, n, fallbackTitle) {
  const found = await findFixDir(projectDir, round, n);
  if (found) return found;
  return await fixDirFromTitle(projectDir, round, n, fallbackTitle || `fix-${n}`);
}

export async function fixPromptPath(projectDir, round, n, fallbackTitle) {
  return path.join(await fixDir(projectDir, round, n, fallbackTitle), 'prompt.md');
}
export async function fixReportPath(projectDir, round, n, fallbackTitle) {
  return path.join(await fixDir(projectDir, round, n, fallbackTitle), 'report.md');
}
// phase-30 (fix acceptance-checking): sibling to fixReportPath — verify.json
// for a fix, reusing fixDir exactly like fixReportPath does so both always
// resolve to the same NN-slug fix directory.
export async function fixVerifyPath(projectDir, round, n, fallbackTitle) {
  return path.join(await fixDir(projectDir, round, n, fallbackTitle), 'verify.json');
}

export function handoffPath(projectDir, timestamp = null) {
  const ts = timestamp || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(guideRoot(projectDir), 'handoffs', `handoff-${ts}.md`);
}

export function archiveDir(projectDir) { return path.join(guideRoot(projectDir), 'archive'); }

// When a new plan replaces a previous one, move phase folders that don't
// belong to the new plan into _archive-<timestamp>/ so findPhaseDir never
// accidentally picks them up for new-plan phases (fixes the "wrong prompt"
// bug where old 01-cost-rollup-... was used for a new plan's phase 1).
export async function archiveSupersededPhases(projectDir, newPlan) {
  const phasesDir = path.join(guideRoot(projectDir), 'phases');
  let entries;
  try { entries = await fs.readdir(phasesDir); } catch { return; }

  const expectedNames = new Set(
    (newPlan?.phases || []).map(
      (ph) => `${pad2(ph.n)}-${slugify(ph.title || ph.slug || `phase-${ph.n}`)}`,
    ),
  );

  const toArchive = entries.filter(
    (e) => !e.startsWith('_') && /^\d{2,}-/.test(e) && !expectedNames.has(e),
  );

  if (!toArchive.length) return;

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.join(phasesDir, `_archive-${ts}`);
  await fs.mkdir(dest, { recursive: true });
  for (const name of toArchive) {
    await fs.rename(path.join(phasesDir, name), path.join(dest, name));
  }
  console.log(`  Archived ${toArchive.length} superseded phase folder(s) → .guide/phases/_archive-${ts}/`);
}

// ─── v0.4: audit + roadmap paths ────────────────────────────────────────────

export function auditDir(projectDir) { return path.join(guideRoot(projectDir), 'audits'); }
export function auditPath(projectDir, timestamp = null) {
  const ts = timestamp || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(auditDir(projectDir), `audit-${ts}.md`);
}

// Phase 43 (P7): cross-round finding history for convergence detection — one
// JSON line per parsed Bug-N finding, appended after every successful
// promote. Sibling to auditPath: same auditDir(), flat jsonl file (mirrors
// phaseLedgerPath's shape, not nested per-round like bug-rounds/).
export function findingHistoryPath(projectDir) {
  return path.join(auditDir(projectDir), 'finding-history.jsonl');
}

export function qaHandoffsDir(projectDir) { return path.join(guideRoot(projectDir), 'qa-handoffs'); }
export function qaHandoffPath(projectDir, scope, timestamp = null) {
  const ts = timestamp || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(qaHandoffsDir(projectDir), `qa-handoff-${scope}-${ts}.md`);
}

export function roadmapDir(projectDir) { return path.join(guideRoot(projectDir), 'roadmaps'); }
export function roadmapPath(projectDir, timestamp = null) {
  const ts = timestamp || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(roadmapDir(projectDir), `roadmap-${ts}.md`);
}
export function roadmapReviewedMarkerPath(projectDir) {
  return path.join(roadmapDir(projectDir), '.reviewed');
}

export function suggestionsPath(projectDir) {
  return path.join(guideRoot(projectDir), 'suggestions.md');
}

// Phase 44 (P1 ship gate): the deterministic secret/dependency/license scan
// report written by src/lib/ship-gate.js's runShipGate before any promotion.
// Sibling file directly under .guide/ (same lifecycle as suggestions.md /
// repo-map.md) — read back into the qa-handoff as a "Ship gate" section.
export function shipGateReportPath(projectDir) {
  return path.join(guideRoot(projectDir), 'ship-gate-report.md');
}

// Phase 47 (P4 brief conformance): back-of-pipeline FR->evidence check —
// sibling files to shipGateReportPath, same .guide/ lifecycle. The checker
// itself cannot write (read-only sandbox); the orchestrator persists its
// reply here after ajv validation.
export function briefConformancePath(projectDir) {
  return path.join(guideRoot(projectDir), 'brief-conformance.json');
}
export function briefConformanceMdPath(projectDir) {
  return path.join(guideRoot(projectDir), 'brief-conformance.md');
}

// Phase 87 (brief 05 P5a — runtime QA): the DoD-derived journey list the
// handoff-creation guide task ALSO writes ([{ name, steps }]) and the verbatim
// verdict the roleless runtime-qa agent replies with. Sibling files directly
// under .guide/, same lifecycle class as brief-conformance.json / suggestions.md
// — read back by the (phase-89) ready-for-qa gate; their ABSENCE must never
// break a run (backward-compat NFR: runtime-qa falls back to the brief's
// Definition-of-done section when qa-journeys.json is missing).
export function qaJourneysPath(projectDir) {
  return path.join(guideRoot(projectDir), 'qa-journeys.json');
}
export function runtimeQaPath(projectDir) {
  return path.join(guideRoot(projectDir), 'runtime-qa.json');
}

export function lessonsPath(projectDir) {
  return path.join(guideRoot(projectDir), 'lessons.jsonl');
}
export function lessonsDistilledPath(projectDir) {
  return path.join(guideRoot(projectDir), 'lessons-distilled.md');
}

// Phase 42 — materialized project-conventions file: durable decisions
// (grouped by type) + distilled lessons, regenerated from runDev()'s
// pre-spawn path so dev/fix prompts can point at one file instead of the
// full distilled-lessons block riding every spawn. Sibling files, same
// directory/lifecycle as lessonsDistilledPath/phaseLedgerPath — NEVER under
// workspace/ (see src/lib/workspace-skills.js's materializeWorkspaceSkills,
// which is a different lifecycle: hand-editable, workspace-owned files).
export function projectConventionsPath(projectDir) {
  return path.join(guideRoot(projectDir), 'project-conventions.md');
}
export function projectConventionsStampPath(projectDir) {
  return path.join(guideRoot(projectDir), 'project-conventions.stamp.json');
}

// Phase 37 (CE-1): deterministic cross-phase memory — one schema-validated
// JSON object per completed phase, appended by src/lib/ledger.js and injected
// into dev prompts via loadPhaseLedgerBlock (phase-runner.js). Sibling to
// lessonsPath/decisions.jsonl: a flat jsonl file directly under .guide/, not
// nested per-phase.
export function phaseLedgerPath(projectDir) {
  return path.join(guideRoot(projectDir), 'phase-ledger.jsonl');
}

// Find most recent audit / roadmap (for display in status, etc.)
async function findMostRecent(dir, prefix) {
  try {
    const entries = await fs.readdir(dir);
    const sorted = entries.filter((e) => e.startsWith(prefix)).sort().reverse();
    return sorted[0] ? path.join(dir, sorted[0]) : null;
  } catch { return null; }
}

export async function findMostRecentAudit(projectDir) {
  return findMostRecent(auditDir(projectDir), 'audit-');
}
export async function findMostRecentRoadmap(projectDir) {
  return findMostRecent(roadmapDir(projectDir), 'roadmap-');
}

// ─── Detection helpers ──────────────────────────────────────────────────────

export async function detectHighestBugRound(projectDir) {
  let highest = 0;
  const bugRoundsDir = path.join(guideRoot(projectDir), 'bug-rounds');
  try {
    const entries = await fs.readdir(bugRoundsDir);
    for (const e of entries) {
      const m = e.match(/^round-(\d+)$/);
      if (m) highest = Math.max(highest, parseInt(m[1], 10));
    }
  } catch { /* ignore */ }
  const guideDir = guideRoot(projectDir);
  try {
    const entries = await fs.readdir(guideDir);
    for (const e of entries) {
      const m = e.match(/^bugs-round-(\d+)\.md$/);
      if (m) highest = Math.max(highest, parseInt(m[1], 10));
    }
  } catch { /* ignore */ }
  return highest || null;
}

// ─── Session IDs (JSON-backed mirror of SQLite) ─────────────────────────────

export async function readSessionIds(projectDir) {
  try { return JSON.parse(await fs.readFile(sessionIdsPath(projectDir), 'utf-8')); }
  catch { return { guide: { current: null, history: [] }, dev_sessions: [] }; }
}

export async function writeSessionIds(projectDir, data) {
  await fs.mkdir(guideRoot(projectDir), { recursive: true });
  await fs.writeFile(sessionIdsPath(projectDir), JSON.stringify(data, null, 2));
}

export async function recordGuideSession(projectDir, sessionId) {
  const data = await readSessionIds(projectDir);
  if (data.guide.current !== sessionId) {
    if (data.guide.current) {
      const last = data.guide.history.find((h) => h.session_id === data.guide.current && !h.ended_at);
      if (last) last.ended_at = new Date().toISOString();
    }
    data.guide.current = sessionId;
    data.guide.history.push({ session_id: sessionId, started_at: new Date().toISOString(), ended_at: null });
    await writeSessionIds(projectDir, data);
  }
}

// ─── Context freshness notice state (Phase 19) ─────────────────────────────
//
// Tracks the sha of the last external-drift Telegram notice so a repeat spawn
// at the same drifted HEAD doesn't re-fire (see shouldNotifyContextDrift in
// context-freshness.js). Sibling json to session-ids.json rather than a new
// field on it — this is drift-notice bookkeeping, not session bookkeeping,
// and keeps session-ids.json's documented shape untouched.

export async function readContextFreshnessState(projectDir) {
  try { return JSON.parse(await fs.readFile(contextFreshnessStatePath(projectDir), 'utf-8')); }
  catch { return { last_noticed_external_sha: null }; }
}

export async function writeContextFreshnessState(projectDir, data) {
  await fs.mkdir(guideRoot(projectDir), { recursive: true });
  await fs.writeFile(contextFreshnessStatePath(projectDir), JSON.stringify(data, null, 2));
}

export async function recordDevSession(projectDir, sessionId) {
  const data = await readSessionIds(projectDir);
  if (!data.dev_sessions.includes(sessionId)) {
    data.dev_sessions.push(sessionId);
    await writeSessionIds(projectDir, data);
  }
}
