// Lane manager (Phase 67 / brief 05 P2 — Execution DAG) — a reusable EXECUTION
// LANE: a git worktree + private branch + the untracked files a bare worktree
// lacks, plus its full lifecycle (provision → destroy → run-start orphan sweep).
//
// A lane lives at  projects/<p>/<parallel_lanes.dir>/<lane-name>  on branch
// `lane/<lane-name>`, branched off a base sha. Lane names: `phase-N`,
// `fix-rR-N`, `duo-<tier>`. It is the primitive the parallel-phase-wave
// scheduler (P3), the speculative duo (P4), and the orphan sweep (P3) build on.
//
// WHY re-provision untracked files (par-04 verdict correction #1): a fresh
// `git worktree add` checks out only TRACKED content, so a lane would be missing
// node_modules / .env / the materialized .claude/ skills — and every per-lane
// validator + acceptance check would then fail on a missing dependency or
// settings file rather than on the code under test. provisionLane restores them.
//
// node_modules CAVEAT: with parallel_lanes.node_modules:'symlink' (default) a
// lane's node_modules is a SYMLINK into the PRIMARY workspace's store. Validators
// are read-mostly, so gating against the shared store is safe — but `npm install`
// run INSIDE a lane mutates that shared store for every other lane and the
// primary workspace. A lane that must install fresh deps should be provisioned
// with node_modules:'none' (which sets gateInLane:false — see below).
//
// Conventions (brief 05): ALL git through src/lib/git.js (never a raw spawn);
// ALL paths via path.join/path.resolve; all fs is async fs/promises.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import {
  worktreeAdd, worktreeRemove, worktreePrune, deleteBranch,
} from './git.js';
import { materializeWorkspaceSkills } from './workspace-skills.js';
import { resolveEffectiveDependsOn } from './plan-validate.js';
import {
  createPhaseLane, updatePhaseLaneStatus, listPhaseLanesForProject,
} from '../state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROMPTS_DIR = path.join(REPO_ROOT, 'prompts');

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/**
 * Deterministic lane name for a { kind, n, round, tier } tuple.
 *   phase → `phase-N`   fix → `fix-rR-N`   duo → `duo-<tier>`
 */
export function laneName({ kind, n = null, round = null, tier = null }) {
  if (kind === 'phase') return `phase-${n}`;
  if (kind === 'fix') return `fix-r${round}-${n}`;
  if (kind === 'duo') return `duo-${tier}`;
  throw new Error(`lane-manager: unknown lane kind '${kind}' (expected phase|fix|duo)`);
}

/** Private branch name for a lane. */
export function laneBranchName(name) { return `lane/${name}`; }

/**
 * Stable per-spawn job key for a lane. The orchestrator (P3) runs each lane's
 * `runDev({ laneMode })` inside `withJobKey(jobKey, ...)` so every spawn the run
 * makes (initial + validator-fix retry + acceptance check) tracks under this
 * one key — cancelling the project job then fans a kill out across all lane keys
 * (claude-runner's per-job _procs Map), and teardown runs in `finally`.
 */
export function laneJobKey(projectName, name) { return `lane:${projectName}:${name}`; }

/**
 * Directory names that belong to a LANE (phase-N / fix-rR-N / duo-<tier>) — used
 * by sweepOrphanLanes to distinguish leftover lane dirs from phase-50's detached
 * read-only worktrees (verify-<sha8> / review-* / scout-*), which share the same
 * parent dir and must NOT be swept.
 */
function isLaneDirName(name) {
  return /^phase-\d+$/.test(name) || /^fix-r\d+-\d+$/.test(name) || /^duo-[A-Za-z0-9]+$/.test(name);
}

/** Parent directory all of a project's lanes live under. */
function laneParentDir(projDir, cfg) {
  return path.join(projDir, cfg?.parallel_lanes?.dir || '.worktrees');
}

/**
 * Create a lane worktree, provision the untracked files a bare worktree lacks,
 * insert a `running` phase_lanes row, and return the handle the orchestrator
 * needs to run + finalize it.
 *
 * @param {object} a
 * @param {string} a.projectName
 * @param {string} a.workspaceDir   primary workspace (the worktree's parent repo)
 * @param {string} a.projDir        projects/<p> (lane parent is under here)
 * @param {string} a.kind           'phase' | 'fix' | 'duo'
 * @param {number|null} [a.n]       phase number (phase/duo) or fix number (fix)
 * @param {number|null} [a.round]   bug round (fix)
 * @param {string|null} [a.tier]    tier label (duo)
 * @param {string} a.baseSha        commit to branch the lane off
 * @param {object} a.cfg            resolved config (parallel_lanes.*, security.deny_rules)
 * @param {object} [deps]           test seams (worktreeAdd / materialize / createPhaseLane / promptsDir / log)
 * @returns {Promise<{ laneDir, branch, gateInLane, laneId, name, jobKey }>}
 */
export async function provisionLane(
  { projectName, workspaceDir, projDir, kind, n = null, round = null, tier = null, baseSha, cfg = {} },
  deps = {},
) {
  const _worktreeAdd = deps.worktreeAdd || worktreeAdd;
  const _materialize = deps.materializeWorkspaceSkills || materializeWorkspaceSkills;
  const _createPhaseLane = deps.createPhaseLane || createPhaseLane;
  const promptsDir = deps.promptsDir || PROMPTS_DIR;
  const log = deps.log || ((m) => console.log(m));

  const name = laneName({ kind, n, round, tier });
  const branch = laneBranchName(name);
  const laneDir = path.join(laneParentDir(projDir, cfg), name);

  // 1. Worktree + private branch off baseSha.
  const add = await _worktreeAdd(workspaceDir, { path: laneDir, branch, startSha: baseSha });
  if (!add.ok) {
    throw new Error(`lane-manager: could not create worktree for ${name} (branch ${branch}) off ${baseSha}: ${add.error}`);
  }

  // 2a. Settings + skills (re-materialized verbatim — same lifecycle as a fresh
  //     workspace-claude-md task). Best-effort: a failure here degrades the
  //     dev spawn's report/skill context, it does not break the lane.
  const denyRules = cfg?.security?.deny_rules || [];
  try {
    await _materialize(laneDir, promptsDir, { denyRules });
  } catch (err) {
    log(chalk.yellow(`[lane ${name}] materializeWorkspaceSkills failed: ${err.message}`));
  }

  // 2b. .env — copied (not symlinked) if the primary workspace has one.
  const srcEnv = path.join(workspaceDir, '.env');
  if (await fileExists(srcEnv)) {
    try {
      await fs.cp(srcEnv, path.join(laneDir, '.env'));
    } catch (err) {
      log(chalk.yellow(`[lane ${name}] copy .env failed: ${err.message}`));
    }
  }

  // 2c. node_modules — symlink into the shared store, or skip (→ gateInLane:false).
  let gateInLane = true;
  const nmMode = cfg?.parallel_lanes?.node_modules || 'symlink';
  const srcNodeModules = path.join(workspaceDir, 'node_modules');
  const haveNodeModules = await fileExists(srcNodeModules);
  if (nmMode === 'symlink' && haveNodeModules) {
    try {
      await fs.symlink(srcNodeModules, path.join(laneDir, 'node_modules'), 'dir');
    } catch (err) {
      gateInLane = false;
      log(chalk.yellow(`[lane ${name}] node_modules symlink failed (${err.message}) — in-lane gate disabled; only the mandatory merged-HEAD gate (P3) will run`));
    }
  } else {
    gateInLane = false;
    const why = nmMode === 'none' ? "parallel_lanes.node_modules='none'" : 'primary workspace has no node_modules';
    log(chalk.yellow(`[lane ${name}] node_modules not provisioned (${why}) — in-lane gate disabled; only the mandatory merged-HEAD gate (P3) will run`));
  }

  // 3. phase_lanes row (running).
  const laneId = _createPhaseLane({
    project: projectName, kind, n, round, branch, worktree_path: laneDir, base_sha: baseSha,
  });

  return { laneDir, branch, gateInLane, laneId, name, jobKey: laneJobKey(projectName, name) };
}

/**
 * Tear a lane down: remove its worktree + branch and mark its row terminal.
 * Crash-safe — every step is best-effort (force removal, swallowed ENOENT) so
 * this is safe to call unconditionally from a `finally` regardless of how far
 * provisionLane got.
 *
 * @param {object} a
 * @param {string} a.workspaceDir
 * @param {string} [a.laneDir]
 * @param {string} [a.branch]
 * @param {number|null} [a.laneId]
 * @param {string} [a.status]      terminal status for the row (default 'done')
 * @param {string|null} [a.head_sha]
 * @param {object} [deps]
 */
export async function destroyLane(
  { workspaceDir, laneDir = null, branch = null, laneId = null, status = 'done', head_sha = null },
  deps = {},
) {
  const _worktreeRemove = deps.worktreeRemove || worktreeRemove;
  const _worktreePrune = deps.worktreePrune || worktreePrune;
  const _deleteBranch = deps.deleteBranch || deleteBranch;
  const _updatePhaseLaneStatus = deps.updatePhaseLaneStatus || updatePhaseLaneStatus;

  if (laneDir) {
    // git worktree remove handles a registered worktree; the fs.rm fallback
    // covers a dir whose registration was already pruned (leftover on disk).
    await _worktreeRemove(workspaceDir, laneDir).catch(() => {});
    await fs.rm(laneDir, { recursive: true, force: true }).catch(() => {});
  }
  if (branch) {
    await _deleteBranch(workspaceDir, branch).catch(() => {});
  }
  await _worktreePrune(workspaceDir).catch(() => {});
  if (laneId != null) {
    try { _updatePhaseLaneStatus(laneId, status, { head_sha }); } catch { /* best-effort — DB may be gone at shutdown */ }
  }
}

/**
 * Run-start orphan sweep: prune dangling worktree metadata, tear down every lane
 * left `running` by a crashed prior run (mark it `abandoned`), and delete any
 * leftover lane-named dir on disk. One log line per sweep. Idempotent (a project
 * with no lanes is a no-op beyond the prune + log).
 *
 * @param {object} a
 * @param {string} a.projectName
 * @param {string} a.workspaceDir
 * @param {string} a.projDir
 * @param {object} a.cfg
 * @param {object} [deps]
 * @returns {Promise<{ sweptRows: number, sweptDirs: number }>}
 */
export async function sweepOrphanLanes(
  { projectName, workspaceDir, projDir, cfg = {} },
  deps = {},
) {
  const _worktreeRemove = deps.worktreeRemove || worktreeRemove;
  const _worktreePrune = deps.worktreePrune || worktreePrune;
  const _deleteBranch = deps.deleteBranch || deleteBranch;
  const _listPhaseLanesForProject = deps.listPhaseLanesForProject || listPhaseLanesForProject;
  const _updatePhaseLaneStatus = deps.updatePhaseLaneStatus || updatePhaseLaneStatus;
  const log = deps.log || ((m) => console.log(m));

  // 1. Prune dangling worktree admin entries first (dirs deleted under git).
  await _worktreePrune(workspaceDir).catch(() => {});

  // 2. Reconcile stale 'running' rows: tear the lane down, mark it abandoned.
  const stale = _listPhaseLanesForProject(projectName, { status: 'running' });
  let sweptRows = 0;
  for (const row of stale) {
    if (row.worktree_path) {
      await _worktreeRemove(workspaceDir, row.worktree_path).catch(() => {});
      await fs.rm(row.worktree_path, { recursive: true, force: true }).catch(() => {});
    }
    if (row.branch) await _deleteBranch(workspaceDir, row.branch).catch(() => {});
    _updatePhaseLaneStatus(row.id, 'abandoned');
    sweptRows += 1;
  }

  // 3. Remove leftover lane dirs on disk (untracked by any row — e.g. the crash
  //    happened before the row was inserted). Only lane-named dirs, never the
  //    detached read-only worktrees (verify-*/review-*/scout-*) sharing this dir.
  const laneParent = laneParentDir(projDir, cfg);
  let entries = [];
  try { entries = await fs.readdir(laneParent, { withFileTypes: true }); } catch { entries = []; }
  let sweptDirs = 0;
  for (const e of entries) {
    if (!e.isDirectory() || !isLaneDirName(e.name)) continue;
    const dir = path.join(laneParent, e.name);
    await _worktreeRemove(workspaceDir, dir).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    sweptDirs += 1;
  }
  await _worktreePrune(workspaceDir).catch(() => {});

  log(chalk.dim(`[lane-sweep] ${projectName}: ${sweptRows} stale row(s) → abandoned, ${sweptDirs} leftover lane dir(s) removed`));
  return { sweptRows, sweptDirs };
}

// ─── Parallel phase-wave selection (Phase 68 — brief 05 P3) ──────────────────
// Pure, dependency-light selectors the auto-runner uses to decide WHICH phases
// may run concurrently in lanes this iteration. All git/DB/spawn orchestration
// lives in auto-runner.js's runPhaseWave; these functions only READ the plan +
// the DB phases snapshot + config and return phase metas.

/** Normalized, non-empty file list for a phase's `files_expected` (an estimate). */
function phaseFilesExpected(p) {
  return Array.isArray(p?.files_expected)
    ? p.files_expected.filter((f) => typeof f === 'string' && f.trim())
    : [];
}

/**
 * The ready set: every PENDING phase (not yet completed in the phases TABLE)
 * whose EFFECTIVE dependencies are ALL completed in the table. "Effective"
 * reuses resolveEffectiveDependsOn (plan-validate.js) as the single source of
 * truth for the previous-entry compat rule — an explicit depends_on wins, else
 * the previous array entry, else none (first entry). Returned in plan order
 * (ascending n for a well-formed plan).
 *
 * @param {object} plan          parsed plan.json
 * @param {Array<object>} phasesTable  DB phase rows ({ n, status, ... })
 * @returns {Array<object>} phase metas from plan.phases that are ready to run
 */
export function pickReadyPhases(plan, phasesTable) {
  const phases = Array.isArray(plan?.phases) ? plan.phases : [];
  if (!phases.length) return [];
  const completed = new Set(
    (Array.isArray(phasesTable) ? phasesTable : [])
      .filter((r) => r && r.status === 'completed' && Number.isInteger(r.n))
      .map((r) => r.n),
  );
  const effectiveDeps = resolveEffectiveDependsOn(phases);
  const ready = [];
  phases.forEach((p, i) => {
    if (!Number.isInteger(p?.n)) return;
    if (completed.has(p.n)) return;                       // already done
    const deps = effectiveDeps[i] || [];
    if (deps.every((d) => completed.has(d))) ready.push(p);
  });
  return ready;
}

/**
 * The set of phase numbers a wave must NOT extend PAST — a phase whose
 * completion requires a serial step before the next phase (so it may be a
 * wave's LAST member, but nothing after it joins the same wave). Covers:
 *   - review cadence: n % review_every_n_phases === 0 (a review runs next);
 *   - the final phase (final review / audit / conformance run serially);
 *   - custom pause list (auto_run.auto_pause_after_phases);
 *   - the phase-1 checkpoint under checkpoint_policy mode 'all';
 *   - intent-mode checkpoints: pause BEFORE a phase whose `checkpoint` tag is in
 *     pause_intents ⇒ stop AFTER the previous entry (matches nextCheckpointAfter).
 * Conservative by design — an extra stop phase only shrinks a wave (safe); a
 * missed one would let a wave silently swallow a checkpoint/review boundary.
 *
 * @returns {Set<number>}
 */
export function computeWaveStopPhases({ plan, cfg }) {
  const stop = new Set();
  const phases = Array.isArray(plan?.phases) ? plan.phases : [];
  if (!phases.length) return stop;
  const ar = cfg?.auto_run || {};
  const reviewEveryN = cfg?.phases?.review_every_n_phases || 3;
  const lastPhaseN = phases[phases.length - 1]?.n;
  const firstPhaseN = phases[0]?.n;
  const policyMode = ar.checkpoint_policy?.mode || 'all';
  const pauseIntents = Array.isArray(ar.checkpoint_policy?.pause_intents) ? ar.checkpoint_policy.pause_intents : [];
  const customPauses = Array.isArray(ar.auto_pause_after_phases) ? ar.auto_pause_after_phases : [];

  phases.forEach((p, i) => {
    if (!Number.isInteger(p?.n)) return;
    // Review cadence always applies (a review is a guide action, not a pause —
    // it runs regardless of checkpoint_policy mode).
    if (reviewEveryN > 0 && p.n % reviewEveryN === 0) stop.add(p.n);
    if (p.n === lastPhaseN) stop.add(p.n);
    if (customPauses.includes(p.n)) stop.add(p.n);
    if (policyMode === 'all' && p.n === firstPhaseN && ar.auto_pause_after_phase_1 !== false) stop.add(p.n);
    // Intent mode: pause fires when the NEXT phase's tag is in pause_intents, so
    // stop after THIS phase (matches auto-runner's nextCheckpointAfter / shouldPauseAfter).
    if (policyMode === 'intent') {
      const next = phases[i + 1];
      if (next && pauseIntents.includes(next.checkpoint)) stop.add(p.n);
    }
  });
  return stop;
}

/**
 * Select the wave to run this iteration. Applies every guard from brief 05 P3;
 * ANY guard miss collapses the wave to size 1 (the single next phase = today's
 * serial path). Returns { wave, reason }:
 *   - max_parallel_phases <= 1                     → [first ready] (serial)
 *   - DAG problems (dagClean false)                → [first ready] (serial)
 *   - a phase with missing/empty files_expected    → runs alone (wave of 1)
 *   - intersecting files_expected (in-code, never  → stop the wave before the
 *     trusting a guide 'independent' annotation)     colliding phase
 *   - a review/checkpoint boundary phase           → that phase is the wave's last
 *
 * files_expected is treated as a NON-authoritative LLM estimate: it is only
 * ever used to SHRINK a wave. When it is wrong (two phases that look disjoint
 * collide on disk), the ascending-merge conflict fallback in runPhaseWave is
 * the real backstop.
 *
 * @param {object} a
 * @param {object} a.plan
 * @param {Array<object>} a.phasesTable
 * @param {object} a.cfg
 * @param {boolean} a.dagClean   validatePlanStructure reported zero problems
 * @returns {{ wave: Array<object>, reason: string }}
 */
export function selectPhaseWave({ plan, phasesTable, cfg, dagClean }) {
  const ar = cfg?.auto_run || {};
  const maxParallel = Number.isInteger(ar.max_parallel_phases) ? ar.max_parallel_phases : 1;
  const ready = pickReadyPhases(plan, phasesTable);
  if (!ready.length) return { wave: [], reason: 'no ready phases' };
  const first = ready[0];

  if (maxParallel <= 1) return { wave: [first], reason: 'max_parallel_phases<=1 (serial)' };
  if (!dagClean) return { wave: [first], reason: 'plan DAG has problems — serial fallback' };

  const stopPhases = computeWaveStopPhases({ plan, cfg });
  const wave = [];
  const usedFiles = new Set();
  for (const p of ready) {
    if (wave.length >= maxParallel) break;
    const files = phaseFilesExpected(p);
    if (wave.length > 0) {
      // A second+ member must have a non-empty file list disjoint from every
      // phase already in the wave. Empty ⇒ intersects-with-everything.
      if (files.length === 0) break;
      if (files.some((f) => usedFiles.has(f))) break;
    }
    wave.push(p);
    for (const f of files) usedFiles.add(f);
    if (files.length === 0) break;         // first member has no estimate → wave of 1
    if (stopPhases.has(p.n)) break;        // review/checkpoint boundary → p is the last member
  }
  return {
    wave,
    reason: wave.length > 1 ? `parallel wave of ${wave.length}` : 'serial (single ready / boundary / disjointness)',
  };
}

// ─── Parallel independent fix-batch selection (Phase 69 — brief 05 P4) ────────
// The fix analog of selectPhaseWave: from a bug round's fix plan, pick the
// longest CONSECUTIVE prefix (starting at fixes_completed, capped by
// bug_cycle.max_parallel_fixes) of pending fixes whose `files_likely` are
// pairwise disjoint. Pure — no DB/git/IO — so pickBugAction and the tests share
// one source of truth.
//
// `files_likely` is a NON-authoritative LLM heuristic (par-05 verdict
// correction #1): intersect IN CODE — never trust a guide "independent" flag —
// and a missing/empty `files_likely` is treated as intersects-with-everything
// (ends the batch; that fix runs alone). Fixes in a round frequently share a
// subsystem, so this intersection frequently serializes the batch to size 1 —
// that is CORRECT, not a bug; the disjointness check must not be weakened.

/** Normalized, non-empty `files_likely` for a fix-plan entry (an estimate). */
function fixFilesLikely(f) {
  return Array.isArray(f?.files_likely)
    ? f.files_likely.filter((x) => typeof x === 'string' && x.trim())
    : [];
}

/**
 * Select the consecutive, file-disjoint batch of pending fixes to run this
 * iteration. Returns { batch, reason }:
 *   - max_parallel_fixes <= 1                     → [head] (today's serial fix)
 *   - head with missing/empty files_likely        → runs alone (batch of 1)
 *   - a later fix with missing/empty files_likely  → ends the batch (runs next time)
 *   - a later fix intersecting a batched fix       → ends the batch
 *   - cap reached                                  → ends the batch
 *
 * @param {object} a
 * @param {Array<object>} a.fixes    the round's fix-plan `fixes` array (order = index)
 * @param {number} a.completed       fixes_completed (the batch starts at this index)
 * @param {object} a.cfg             resolved config (bug_cycle.max_parallel_fixes)
 * @returns {{ batch: Array<object>, reason: string }}
 */
export function selectFixBatch({ fixes, completed = 0, cfg }) {
  const bc = cfg?.bug_cycle || {};
  const maxParallel = Number.isInteger(bc.max_parallel_fixes) ? bc.max_parallel_fixes : 1;
  const all = Array.isArray(fixes) ? fixes : [];
  const pending = all.slice(completed);
  if (!pending.length) return { batch: [], reason: 'no pending fixes' };
  const head = pending[0];

  if (maxParallel <= 1) return { batch: [head], reason: 'max_parallel_fixes<=1 (serial)' };

  const batch = [];
  const usedFiles = new Set();
  for (const f of pending) {
    if (batch.length >= maxParallel) break;
    const files = fixFilesLikely(f);
    if (batch.length > 0) {
      // A second+ member needs a non-empty files_likely disjoint from every fix
      // already in the batch. Empty ⇒ intersects-with-everything ⇒ ends the batch.
      if (files.length === 0) break;
      if (files.some((x) => usedFiles.has(x))) break;
    }
    batch.push(f);
    for (const x of files) usedFiles.add(x);
    if (files.length === 0) break;   // head has no estimate → runs alone (batch of 1)
  }
  return {
    batch,
    reason: batch.length > 1 ? `parallel fix batch of ${batch.length}` : 'serial (single pending / disjointness / no estimate)',
  };
}
