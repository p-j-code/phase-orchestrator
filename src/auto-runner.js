// Auto-Runner v0.3 — walks plan → phases → reviews → completion → bug rounds.
//
// Changes from v0.2:
//   - Uses new .guide/ layout via guide-paths.js
//   - Runs final review BEFORE declaring ready-for-qa (fixes v0.2 bug)
//   - Warns on missing phase reports between phases
//   - Auto-generates workspace/CLAUDE.md after planning if config enabled

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import {
  runGuide, runDev, formatVerifyOutcomeLine, maybeRecordReportModeVerifyFailLesson,
  buildPhaseScoutPrompt, renderScoutNote, PHASE_SCOUT_SYSTEM_PROMPT, completeMergedPhase,
} from './lib/phase-runner.js';
import { runDetachedAcceptanceCheck, CHECKER_ALLOWED_TOOLS, decideVerdict } from './lib/verify-loop.js';
import { validatePlanStructure, formatPlanProblems } from './lib/plan-validate.js';
import { isTransientError, isProviderRateLimitError } from './lib/transient-errors.js';
import { getRateLimitRetryAt } from './lib/unattended-retry.js';
import { writeEscalationMarker, nextTier, failedTierFromResult, escalationMarkerPath, legacyEscalationMarkerPath } from './lib/escalation.js';
import { computeReviewWeight, shouldScheduleReview } from './lib/review-weight.js';
import { windowStatus } from './billing-guard.js';
import { forecastRun, formatForecastWindowLine, renderForecastLine, predictUpcoming } from './commands/predict.js';
import { enqueueRetryJob, enqueueUniqueResumeJob } from './server/job-queue.js';
import { shouldPauseAfter, describeCheckpoints } from './checkpoint.js';
import { resolve as resolveConfig } from './config-resolver.js';
import {
  getProject, setProjectStatus,
  startAutoRun, pauseAutoRun, completeAutoRun, endAutoRunTerminal, getActiveAutoRun,
  getCurrentBugRound, getBugRound, startBugRound, setBugRoundStatus, recordFixCompletion,
  setBugRoundFixPlan, getDb, resetProjectForNewPlan,
  setCurrentPhase, upsertPhase,
  getAuditRunsCompleted, incrementAuditRunsCompleted, getPhases,
  claimRunningJob, releaseRunningJob, getRunningJob,
  countRecentFailedHealingByKinds,
  getDiscussBriefPending, clearDiscussBriefPending,
  parseProjectMetadata, setProjectMetadataField,
  recentCallsForProjectTask,
  recentPhaseExecutionFeatures,
  countPhaseRepromptsSincePlan,
  recordRunEvent, pruneOldRunEvents, pruneOldContextCompilerTelemetry,
  expireStaleOutbox, pruneOldNotifyOutbox,
  queueNotify, markOutboxDelivered,
  setBugRoundFoundCount,
  markInProgressPhasesInterrupted,
} from './state.js';
import {
  guideRoot, planJsonPath, phasePromptPath, phaseReportPath, phaseVerifyPath, reviewPath,
  fixPlanJsonPath, fixPromptPath, fixReportPath, detectHighestBugRound, bugsFilePath,
  briefPath, rawThoughtsPath, briefQuestionsPath, projectContextPath, archiveSupersededPhases,
  findMostRecentAudit, auditDir, planCoveragePath, briefConformancePath, worktreesRoot,
  phaseScoutPath, routingExtensionPath,
} from './lib/guide-paths.js';
import { computeRoutingAdjustment, TELEMETRY_TASKS, demoteTasks, isEnvironmentalFailure } from './lib/routing-telemetry.js';
import { decideConformance } from './lib/brief-conformance.js';
import {
  fixCommitExists, changedFilesSince, removeWorktree, addDetachedWorktree, phaseCommitSha, getHeadSha,
  mergeNoFf, mergeAbort, resetHard, pushBranch, aheadBehind,
} from './lib/git.js';
import {
  provisionLane, destroyLane, sweepOrphanLanes, laneBranchName, selectPhaseWave, selectFixBatch,
} from './lib/lane-manager.js';
import { runSpeculativeDuo, isDuoEligible, routingMatchedForceTier } from './lib/duo-executor.js';
import { routeModel } from './model-router.js';
import { preventSleep as wakePreventSleep, allowSleep as wakeAllowSleep } from './lib/wake-lock.js';
import { runValidators, runValidatorGate, gateFailureExcerpt } from './lib/validators.js';
import { classifyPauseReason, PAUSE_KINDS } from './lib/pause-classifier.js';
import { runAutopsy } from './lib/autopsy.js';
import { killAll, runClaude, withJobKey } from './claude-runner.js';
import { getWorkerContext } from './lib/worker-context.js';
import { AutoHealer } from './lib/auto-healer.js';
import { promoteAuditToBugs, formatConvergenceStallReason, computeAuditYield, promoteRuntimeQaBlockers } from './lib/audit-promote.js';
import { runRuntimeQa, summarizeRuntimeQaVerdict } from './lib/runtime-qa.js';
import { analyzeSkippedPhases } from './lib/skip-analyzer.js';
import { snapshotBrief, checkBriefDrift, briefHash, activeBriefPath } from './lib/brief-manager.js';
import { ERROR_KINDS, classifyError } from './lib/error-classifier.js';
import { recordLesson, shouldDistillLessons } from './lib/lessons.js';
import { mergeWorkspaceDenyRules } from './lib/workspace-skills.js';
import Ajv from 'ajv';
import { runArtifactContractOnExistingCall, runWithContract } from './lib/llm-contract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');
const PROMPTS_DIR = path.join(REPO_ROOT, 'prompts');
const USER_CONFIG_PATH = path.join(os.homedir(), '.ashmero-orchestrator', 'user.json');

/** A rate-limit terminal state cannot benefit from an additional autopsy call. */
export function shouldRunFailureAutopsy({ status, pauseKind, pauseReason }) {
  const isFailureTerminal = status === 'failed'
    || pauseKind === PAUSE_KINDS.VALIDATOR_FAILED
    || pauseKind === PAUSE_KINDS.MID_BUILD;
  return isFailureTerminal && !isProviderRateLimitError(pauseReason);
}

// Brief 08 / P1(b) — the fix-plan structural contract, ajv-compiled ONCE at
// module load (mirrors verify-loop.js's VERDICT_SCHEMA). Its required fields
// are deliberately minimal — only what setBugRoundFixPlan and the fix loop
// actually read (`fixes` array; each fix's integer `n`) — so a valid plan the
// code can execute never false-positives (see the schema file's own comment).
const _fixPlanAjv = new Ajv({ allErrors: true, strict: false });
let FIX_PLAN_SCHEMA = null;
let validateFixPlanSchema;
try {
  FIX_PLAN_SCHEMA = JSON.parse(fsSync.readFileSync(path.join(REPO_ROOT, 'config', 'schemas', 'fix-plan.schema.json'), 'utf-8'));
  validateFixPlanSchema = _fixPlanAjv.compile(FIX_PLAN_SCHEMA);
} catch (err) {
  console.warn(`[auto-runner] fix-plan.schema.json missing or malformed — falling back to minimal structural check: ${err.message}`);
  // Fail-closed fallback: the schema file is unavailable, but downstream code
  // (applyFixPlanContract → outcome.value.fixes.length) assumes a `fixes` array.
  // Passing everything through (`() => true`) would let a malformed plan reach
  // `.fixes.length` and throw a TypeError instead of routing to the ONE re-ask.
  // So still enforce the single invariant the schema's required fields encode.
  validateFixPlanSchema = (plan) => {
    const ok = Array.isArray(plan?.fixes);
    validateFixPlanSchema.errors = ok ? null : [{ instancePath: '/fixes', message: 'must be an array (schema file unavailable; minimal fallback check)' }];
    return ok;
  };
  validateFixPlanSchema.errors = null;
}

// Read + structurally validate a round's fix-plan.json against the ajv contract.
// A missing/unparseable file or a schema miss is a validation failure (which
// drives the ONE contract re-ask); a clean parse returns the plan as the value.
async function readFixPlanForContract(fixPlanPath) {
  let raw;
  try { raw = await fs.readFile(fixPlanPath, 'utf-8'); }
  catch (err) { return { ok: false, errors: [`fix-plan not readable at ${fixPlanPath}: ${err.message}`] }; }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) { return { ok: false, errors: [`fix-plan is not valid JSON: ${err.message}`] }; }
  if (!validateFixPlanSchema(parsed)) {
    const errors = (validateFixPlanSchema.errors || []).map((e) => `${e.instancePath || '(root)'} ${e.message}`);
    return { ok: false, errors };
  }
  return { ok: true, value: parsed };
}

/**
 * Validate a just-written round fix-plan.json under the output contract (P1b).
 * The bug-plan guide call already produced `result`; runArtifactContractOnExistingCall
 * reuses it as the initial attempt (ZERO extra spawns on a valid plan) and, on a
 * schema miss, resumes that guide session for exactly ONE session-resumed re-ask
 * naming the file + ajv errors. On success it records the plan
 * (setBugRoundFixPlan); on post-re-ask failure it logs a WARNING and returns —
 * FAIL-OPEN, no bug-cycle control-flow change. cfg.llm_contract.enabled:false
 * restores the pre-phase-77 silent read.
 *
 * Exported + deps-seamed (runClaude / setBugRoundFixPlan) for unit testing with
 * no real spawn or DB — the auto-runner test convention (see project-conventions).
 *
 * @returns {Promise<{ok:boolean, reasks:number}>}
 */
export async function applyFixPlanContract({ result, projectName, round, cfg, projDir = null, deps = {} }) {
  const runClaudeFn = deps.runClaude ?? runClaude;
  const setFixPlanFn = deps.setBugRoundFixPlan ?? setBugRoundFixPlan;
  const dir = projDir ?? path.join(PROJECTS_DIR, projectName);
  const fixPlanPath = fixPlanJsonPath(dir, round);

  // enabled:false — restore the pre-phase-77 silent read (best-effort, no re-ask).
  if (cfg?.llm_contract?.enabled === false) {
    const fixPlan = await readJson(fixPlanPath);
    if (fixPlan && Array.isArray(fixPlan.fixes)) {
      setFixPlanFn({ project: projectName, round, fix_plan_file: fixPlanPath, total_fixes: fixPlan.fixes.length });
      return { ok: true, reasks: 0 };
    }
    return { ok: false, reasks: 0 };
  }

  const outcome = await runArtifactContractOnExistingCall({
    existingResult: result,
    baseCall: {
      cfg, cwd: dir, role: null, project: projectName, task: 'bug-plan',
      systemPromptFile: path.join(PROMPTS_DIR, 'guide-system.md'),
    },
    artifactReader: () => readFixPlanForContract(fixPlanPath),
    filePath: fixPlanPath,
    maxReasks: Number.isInteger(cfg?.llm_contract?.max_reasks) ? cfg.llm_contract.max_reasks : 1,
    runClaude: runClaudeFn,
  });

  if (outcome.ok) {
    setFixPlanFn({ project: projectName, round, fix_plan_file: fixPlanPath, total_fixes: outcome.value.fixes.length });
  } else if (!outcome.spawnError) {
    console.warn(chalk.yellow(`⚠ fix-plan contract failed for ${projectName} round ${round} after ${outcome.reasks} re-ask(s) (${fixPlanPath}): ${(outcome.errors || []).join('; ')} — proceeding (fail-open).`));
  }
  return { ok: outcome.ok, reasks: outcome.reasks };
}

const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(p) { try { return JSON.parse(await fs.readFile(p, 'utf-8')); } catch { return null; } }
async function fileExists(p) { try { await fs.access(p); return true; } catch { return false; } }

// Phase 41 (CE-9) — the files an auto-runner lesson (reprompt/escalation) should
// carry, so lessons.js's x10 file-overlap signal isn't crippled by the empty
// `files: []` these sites used to record. A phase draws from plan.json's
// `files_expected`; a fix from its round-plan entry (raw field `files`, or the
// canonical `files_likely`). Best-effort/fail-open: an unreadable/absent plan,
// or no matching entry, yields [] (never throws — recordLesson tolerates []).
export async function lessonFilesForAction(projDir, action) {
  try {
    if (action?.kind === 'fix-dev' && action.fix) {
      const roundPlan = await readJson(fixPlanJsonPath(projDir, action.fix.round));
      const entry = (roundPlan?.fixes || []).find((f) => f.n === action.fix.n);
      return entry?.files || entry?.files_likely || [];
    }
    const plan = await readJson(planJsonPath(projDir));
    const entry = (plan?.phases || []).find((p) => p.n === action?.phaseN);
    return entry?.files_expected || [];
  } catch {
    return [];
  }
}

// Phase 64 (intent-based checkpointing) — the checkpoint tag of the phase that
// runs AFTER `phaseN` (plan.phases[i+1] relative to the phase about to run),
// which shouldPauseAfter's mode:'intent' path compares against pause_intents.
// Returns null when there is no next phase or it carries no string tag (legacy
// untagged plans read from disk have no `checkpoint` — treated as no-pause,
// same as 'routine').
export function nextCheckpointAfter(plan, phaseN) {
  const meta = (plan?.phases || []).find((p) => p.n > phaseN) || null;
  return meta && typeof meta.checkpoint === 'string' ? meta.checkpoint : null;
}

// ── Concurrency mutex ─────────────────────────────────────────────────────────
// Two layers: in-process Map (worker-pool, same Node process) + SQLite
// running_jobs (cross-process, e.g. two Telegram /go workers).

const _inProcessLocks = new Map(); // project → pid

export async function _acquireAutoRunMutex(projectName) {
  if (_inProcessLocks.has(projectName)) {
    throw new Error(`autoRun already running for ${projectName} (PID ${_inProcessLocks.get(projectName)})`);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      claimRunningJob(projectName, process.pid);
      _inProcessLocks.set(projectName, process.pid);
      return;
    } catch (e) {
      if (!String(e.message).includes('UNIQUE constraint failed')) throw e;
      const holder = getRunningJob(projectName);
      if (!holder) continue; // row deleted between our INSERT fail and this read — retry
      let pidAlive = true;
      try {
        process.kill(holder.pid, 0);
      } catch (killErr) {
        if (killErr.code === 'ESRCH') {
          pidAlive = false;
        }
        // EPERM → process exists but we lack permission to signal it; treat as alive
      }
      if (!pidAlive) {
        releaseRunningJob(projectName);
        continue; // stale row cleared — retry INSERT
      }
      throw new Error(`autoRun already running for ${projectName} (PID ${holder.pid})`);
    }
  }
  throw new Error(`autoRun mutex claim failed for ${projectName} after retries`);
}

export function _releaseAutoRunMutex(projectName) {
  try { releaseRunningJob(projectName); } catch { /* best-effort */ }
  _inProcessLocks.delete(projectName);
}

// Phase 50 — stale-worktree sweep. A crash mid-task leaves behind a detached
// worktree (verify-<sha8>/, review-<phaseN>-<sha8>/, scout-<phaseN>-<sha8>/,
// added by P2/P3/P6) under worktreesRoot(projDir); every autoRun() preflight
// walks that dir and force-removes whatever it finds, once, before the main
// loop starts. Extracted as its own exported function so it's unit-testable
// independent of a live autoRun. No-op (no log lines) when nothing is stale.
export async function sweepStaleWorktrees(projDir, workspaceDir) {
  let entries;
  try {
    entries = await fs.readdir(worktreesRoot(projDir), { withFileTypes: true });
  } catch {
    return; // no .worktrees/ dir yet — nothing to sweep
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(worktreesRoot(projDir), entry.name);
    await removeWorktree(workspaceDir, dir);
    console.log(chalk.dim(`  → Swept stale worktree: ${entry.name}`));
  }
}

// Phase 56 (MI-5) — flat string-map equality for two task_floors objects, so
// the telemetry preflight can skip the write (and leave routing-extension.json
// byte-identical) when the learned floors haven't moved.
function floorsEqual(a, b) {
  const ak = Object.keys(a || {}).sort();
  const bk = Object.keys(b || {}).sort();
  if (ak.length !== bk.length) return false;
  return ak.every((k, i) => k === bk[i] && a[k] === b[k]);
}

// Phase 56 (MI-5, telemetry-learned routing floors) — the autoRun() preflight
// step that turns recorded calls-table outcomes into a deterministic per-task
// tier floor, so a project whose dev/fix phases keep failing on sonnet and
// paying the fail-then-escalate double bill starts the next phase on opus
// directly (rules over telemetry, no LLM). Read-only over the calls table (the
// state.js query is SELECT-only; the pure module is no-IO), and the ONLY write
// is an ATOMIC, NON-DESTRUCTIVE rewrite of routing-extension.json: every
// existing key (keyword_rules, hand-authored floors/caps for other tasks) is
// preserved; only task_floors (the dev/fix entries telemetry owns), task_caps
// (the demote-task entries — 2026-07-12 demotion learning), and their _meta
// blocks are replaced. Skips the write entirely when neither learned floors
// nor caps changed, so an already-correct file stays byte- and mtime-identical
// (never dirties the git tree the dev/heal preflight checks).
//
// Gated on model_routing.telemetry.enabled === true — disabling it stops the
// rewrites (but routeModel still honors whatever task_floors are on disk). A
// legacy config whose model_routing override predates this block simply has no
// telemetry key, reads enabled !== true, and is left untouched (read-side
// back-compat). loadProjectRoutingExtension is per-call/uncached, so the very
// next routeModel picks up the rewrite with no cache-bust.
//
// `deps` is a test-only seam (recentCalls / readFile / writeFile / rename / now
// / log); production callers pass nothing.
export async function applyTelemetryRoutingFloors({ cfg, projectName, projDir }, deps = {}) {
  const tele = cfg?.model_routing?.telemetry || {};
  if (tele.enabled !== true) return { applied: false, reason: 'telemetry disabled' };

  const recentCalls = deps.recentCalls ?? recentCallsForProjectTask;
  const readFileFn = deps.readFile ?? fs.readFile;
  const writeFileFn = deps.writeFile ?? fs.writeFile;
  const renameFn = deps.rename ?? fs.rename;
  const now = deps.now ?? (() => new Date().toISOString());
  const log = deps.log ?? ((m) => console.log(m));

  const tierModels = cfg?.model_routing?.tier_models || {};
  const windowCalls = Number.isFinite(tele.window_calls) ? tele.window_calls : 12;

  // Read the existing extension NON-DESTRUCTIVELY (absent/corrupt → start from {}).
  const extPath = routingExtensionPath(projDir);
  let existing = {};
  try {
    const parsed = JSON.parse(await readFileFn(extPath, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
  } catch {
    existing = {};
  }
  const currentFloors = (existing.task_floors && typeof existing.task_floors === 'object' && !Array.isArray(existing.task_floors))
    ? existing.task_floors
    : {};
  const currentCaps = (existing.task_caps && typeof existing.task_caps === 'object' && !Array.isArray(existing.task_caps))
    ? existing.task_caps
    : {};

  // Caller-side telemetry query (read-only). The pure module never touches IO.
  // Union of the floor tasks and the (config-extendable) demote tasks — one
  // query per task either way.
  const demoteList = demoteTasks(cfg);
  const calls = {};
  for (const task of new Set([...TELEMETRY_TASKS, ...demoteList])) {
    calls[task] = recentCalls(projectName, task, windowCalls) || [];
  }

  const { task_floors, task_caps, reasons } = computeRoutingAdjustment({ calls, currentFloors, currentCaps, tierModels, cfg });

  // Preserve any hand-authored floor for a NON-telemetry task (telemetry only
  // owns the dev/fix entries) so the rewrite never silently drops it. Same for
  // caps: telemetry only owns the demote-task entries.
  const preservedFloors = {};
  for (const [k, v] of Object.entries(currentFloors)) {
    if (!TELEMETRY_TASKS.includes(k)) preservedFloors[k] = v;
  }
  const nextFloors = { ...preservedFloors, ...task_floors };
  const preservedCaps = {};
  for (const [k, v] of Object.entries(currentCaps)) {
    if (!demoteList.includes(k)) preservedCaps[k] = v;
  }
  const nextCaps = { ...preservedCaps, ...task_caps };

  // No-op when nothing moved — leave the file exactly as-is.
  if (floorsEqual(currentFloors, nextFloors) && floorsEqual(currentCaps, nextCaps)) {
    return { applied: false, reason: 'no change', task_floors: nextFloors, task_caps: nextCaps };
  }

  const next = {
    ...existing,
    task_floors: nextFloors,
    task_floors_meta: { updated_at: now(), reasons },
    task_caps: nextCaps,
    task_caps_meta: { updated_at: now(), reasons },
  };
  const tmpPath = `${extPath}.tmp`;
  await writeFileFn(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  await renameFn(tmpPath, extPath);

  for (const r of reasons) log(chalk.dim(`  → Routing telemetry: ${r}`));
  return { applied: true, task_floors: nextFloors, task_caps: nextCaps, reasons };
}

// Phase 51 (P1 async report-mode) — kicks off ONE detached background
// acceptance check for a phase whose runDev() call returned
// result.deferred_verify (report mode + verify.async_report + deferVerify).
// Returns { promise, phaseN, label } for the caller's pendingVerify slot.
// The returned promise NEVER rejects — a checker/worktree failure already
// degrades to an 'inconclusive' outcome inside runDetachedAcceptanceCheck,
// and any other failure (e.g. the settle handling itself) is caught here —
// so the cap-1-outstanding barriers (autoRun's main loop, before any guide
// dispatch, and finalize()) can safely `await pendingVerify.promise` with no
// try/catch of their own. Settle handling mirrors the inline report-mode
// path exactly: the same formatVerifyOutcomeLine log line, the same
// maybeRecordReportModeVerifyFailLesson call (so a background fail produces
// the identical lesson an inline fail would have), then a follow-up notify —
// distinct from the phase-completion ping already sent when the phase itself
// finished, since the verdict genuinely arrives later.
// `deps` is a test-only seam (defaults to the real verify-loop.js export);
// production callers in autoRun never pass it.

// Phase 58 (par-09, notify_outbox) — every run-lifecycle notify site funnels
// through here: queueNotify() durably logs the message UNCONDITIONALLY (this
// is what makes a bare detached CLI launch, e.g. web-ui.js's
// spawnOrchestrator or chat/control-actions.js's spawnDetached — both run
// autoRun() with notifier:null — no longer silent), and a live notifier, when
// present, is only a FAST PATH: a successful notify marks the row delivered
// in the same tick so server-discord.js's 10s delivery loop never re-sends
// it. Never throws — mirrors every existing `.catch(() => {})` notify site
// it replaces.
async function queueAndNotify({ notifier, project, text, replyMarkup = null }) {
  const id = queueNotify({ project, text, replyMarkup });
  if (!notifier) return;
  try {
    const res = await notifier.notify({ text, replyMarkup });
    // notify() never throws — it folds every per-recipient DM/channel failure
    // into {delivered,total}. Only mark the outbox row delivered if it actually
    // reached someone (or there were no recipients to reach); a genuine 0-of-N
    // delivery failure must stay pending so the delivery loop retries it.
    // (A notifier that returns nothing keeps the historical fast-path.)
    if (id != null && (!res || res.delivered > 0 || res.total === 0)) markOutboxDelivered(id);
  } catch { /* best-effort — row stays pending, the delivery loop retries it */ }
}

// pickNextAction is also called directly by older CLI/test consumers that pass
// a simple `(text) => {}` callback instead of the server notifier object. Keep
// that compatibility at the three brief-chain transition sites while making
// notification failure non-fatal to the state transition itself.
async function notifyBriefChain(notifier, text) {
  if (!notifier) return;
  try {
    if (typeof notifier === 'function') await notifier(text);
    else await notifier.notify?.({ text });
  } catch { /* best-effort */ }
}

// ─── Runtime-QA ready-for-qa gate (phase 89 / P5b) ────────────────────────────
//
// Single source of truth for "is runtime-qa in BLOCKING gate mode". report mode
// (default, shipped ON) and disabled/absent config both return false — only the
// explicit gate mode blocks. Shared by pickNextAction (which defers the status
// flip in gate mode) and runReadyForQaRuntimeGate (which enforces the block), so
// the two never disagree about the mode.
export function isRuntimeQaGateMode(cfg) {
  const rq = cfg?.runtime_qa || {};
  return rq.enabled === true && rq.mode === 'gate';
}

/**
 * Runtime-QA gate at the MAIN-FLOW ready-for-qa transition. Runs runRuntimeQa
 * exactly ONCE (one sonnet call per RUN — NOT per phase), logs the verdict,
 * emits exactly ONE notifier line, and decides whether the transition proceeds:
 *
 *   - report mode (default, shipped ON): returns { blocked:false } ALWAYS —
 *     fail-open. A blocker-carrying or inconclusive verdict NEVER blocks; the
 *     caller transitions to ready-for-qa exactly as before.
 *   - gate mode (default-off): a verdict with >=1 blocker promotes every blocker
 *     to the bug inbox (audit-promote precedent) and returns { blocked:true } so
 *     the caller BLOCKS the transition and pauses.
 *
 * A skipped result (no entrypoint, or the module's fail-closed refusal when the
 * deny-rule sandbox is unresolvable) emits a dim log and returns { blocked:false }
 * — the transition proceeds unchanged in BOTH modes.
 *
 * Backward-compat: no runtime_qa config, or runtime_qa.enabled !== true, is a
 * no-op ({ ran:false, blocked:false }) — an old run with no config still
 * completes and NO spawn happens.
 *
 * role:null invariant: runRuntimeQa is roleless/sessionless, so this seam never
 * touches guide_session_id / last_dev_session_id.
 *
 * @param {Object} args
 * @param {string} args.projectName
 * @param {string} args.workspaceDir - absolute path to the project's workspace/
 * @param {Object} args.cfg - resolved config (reads runtime_qa.*, models['runtime-qa'])
 * @param {Object|null} [args.notifier]
 * @param {{runRuntimeQa?:Function, promoteRuntimeQaBlockers?:Function, log?:Function}} [deps]
 * @returns {Promise<{ran:boolean, blocked:boolean, reason:string|null, verdict:object|null, status:string|null, promoted?:object}>}
 */
export async function runReadyForQaRuntimeGate({ projectName, workspaceDir, cfg, notifier = null }, deps = {}) {
  const {
    runRuntimeQa: runRuntimeQaFn = runRuntimeQa,
    promoteRuntimeQaBlockers: promoteFn = promoteRuntimeQaBlockers,
    log = (m) => console.log(chalk.dim(m)),
  } = deps;

  const rq = cfg?.runtime_qa || {};
  // Backward-compat + master kill switch: absent config or enabled:false → no-op,
  // no spawn. An old run with no runtime_qa block still completes unchanged.
  if (rq.enabled !== true) {
    return { ran: false, blocked: false, reason: null, verdict: null, status: null };
  }

  // ONE spawn per run — the module is self-contained and roleless. runRuntimeQa
  // runs its OWN orphan-pid backstop in a finally (success OR error), so if the
  // spawn throws it has ALREADY cleaned up — we never add a second cleanup path
  // here. Fail-open on an unexpected throw: an agent crash is inconclusive, NOT a
  // confirmed blocker, so it never blocks the transition (report-class default;
  // gate mode's only hard stop is a verdict that actually CARRIES blockers, and
  // an infra-level throw carries none). The run still pauses at ready-for-qa, so
  // the operator does manual QA regardless.
  let result;
  try {
    result = await runRuntimeQaFn({ projectName, workspaceDir, cfg });
  } catch (err) {
    log(`[runtime-qa] agent errored (${err?.message || err}) — proceeding fail-open, transition unchanged`);
    return { ran: false, blocked: false, reason: null, verdict: null, status: 'error' };
  }

  // Skipped (no entrypoint / fail-closed on absent deny-rule mechanism): a dim
  // log, and the ready-for-qa transition proceeds unchanged in BOTH modes.
  if (!result || result.status === 'skipped') {
    log(`[runtime-qa] skipped${result?.reason ? ` (${result.reason})` : ''} — ready-for-qa transition proceeds unchanged`);
    return { ran: false, blocked: false, reason: result?.reason || null, verdict: null, status: 'skipped' };
  }

  const verdict = result.verdict || {};
  const blockers = Array.isArray(verdict.blockers) ? verdict.blockers : [];

  // The single per-run signal: one dim log line + exactly one notifier line.
  const summary = summarizeRuntimeQaVerdict(result);
  log(`[runtime-qa] ${summary}`);
  await queueAndNotify({ notifier, project: projectName, text: `🧪 ${summary}` });

  if (isRuntimeQaGateMode(cfg) && blockers.length > 0) {
    // Gate mode + blockers → promote to the bug inbox and BLOCK the transition.
    const promoted = promoteFn({ projectName, blockers });
    const reason = `runtime-qa-blockers: ${blockers.length} runtime blocker(s) promoted to the bug inbox — ready-for-qa BLOCKED. See .guide/runtime-qa.json.`;
    log(`[runtime-qa] ${reason}`);
    return { ran: true, blocked: true, reason, verdict, status: result.status, promoted };
  }

  // report mode (fail-open) OR gate mode with no blockers → transition proceeds.
  return { ran: true, blocked: false, reason: null, verdict, status: result.status };
}

export function spawnDetachedVerify({ cfg, projectName, projDir, workspaceDir, job, notifier = null, runId = null }, deps = {}) {
  const runDetachedAcceptanceCheckFn = deps.runDetachedAcceptanceCheck ?? runDetachedAcceptanceCheck;
  // Label matches runPhaseAcceptanceCheck's inline label BYTE-FOR-BYTE (`Phase
  // N`, no title) so formatVerifyOutcomeLine emits the IDENTICAL '... FAILED
  // (report-only)' outcome line a synchronous report-mode check would have —
  // the only observable difference is WHEN the line prints, never its text.
  const label = `Phase ${job.phaseN}`;
  const promise = runDetachedAcceptanceCheckFn({ cfg, projectName, projDir, workspaceDir, job })
    .then(async (outcome) => {
      const line = formatVerifyOutcomeLine(label, outcome);
      if (line.level === 'warn') console.warn(chalk.yellow(line.text));
      else console.log(chalk.green(line.text));
      await maybeRecordReportModeVerifyFailLesson({
        cfg, projDir, phaseMeta: job.phaseMeta, fix: null, nextPhase: job.phaseN, verifyOutcome: outcome,
      }).catch(() => {});
      await queueAndNotify({ notifier, project: projectName, text: `🔍 ${line.text}` });
      // Phase 57 (P1, run_events timeline) — the deferred/report-mode verdict
      // genuinely arrives on this later tick, not at the phase's own
      // dev-completed event (see executeAction's 'dev' branch for the
      // synchronous/gate-mode equivalent).
      if (outcome?.verdict == null) {
        // Null/undefined verdict = inconclusive check — must NOT be recorded as a pass.
        recordRunEvent(runId, 'acceptance-inconclusive', { project: projectName, phase: job.phaseN, unmet: 0 });
      } else {
        const { effective_fail, unmet } = decideVerdict(outcome.verdict);
        recordRunEvent(runId, effective_fail ? 'acceptance-fail' : 'acceptance-pass', { project: projectName, phase: job.phaseN, unmet: unmet.length });
      }
      return outcome;
    })
    .catch((err) => {
      console.warn(chalk.yellow(`[verify-async] background acceptance check for phase ${job.phaseN} failed: ${err.message} — degrading (advisory-only)`));
      return null;
    });
  return { promise, phaseN: job.phaseN, label };
}

// Phase 52 (par-03, async mid-stream reviews) — kicks off ONE detached review
// for `action.phaseN` WITHOUT awaiting it, so pickNextAction can return the
// dev action for phase N+1 on the very next iteration instead of blocking on
// this review's verdict. Pins a worktree to phase N's OWN commit
// (phaseCommitSha, falling back to the live HEAD if the commit-message grep
// ever misses) BEFORE calling runGuide, so the review reads phase N's tree
// even after later phases have moved the live workspace on — the same
// primitive P1/P2 already established (addDetachedWorktree/removeWorktree),
// removed in a `finally` regardless of outcome. The returned promise NEVER
// rejects — a throw from runGuide (or the worktree setup itself) is folded
// into an is_error result, so a background review failure routes through the
// SAME guide-failure handling a synchronous one gets (see settleReviewOutcome)
// instead of crashing the run. `state.settled` flips the instant the promise
// resolves, so the main loop's top-of-iteration check can peek without
// blocking — awaiting an unsettled promise here would defeat the entire
// point of not blocking phase N+1's dispatch.
export function spawnDetachedReview({ cfg, projectName, projDir, workspaceDir, action, notifier = null }, deps = {}) {
  const runGuideFn = deps.runGuide ?? runGuide;
  const phaseN = action.phaseN;
  const state = { settled: false };
  const promise = (async () => {
    const sha = (await phaseCommitSha(workspaceDir, phaseN)) || (await getHeadSha(workspaceDir));
    let pinnedWorktree = null;
    let wtDir = null;
    if (sha) {
      wtDir = path.join(worktreesRoot(projDir), `review-${phaseN}-${sha.slice(0, 8)}`);
      const added = await addDetachedWorktree(workspaceDir, { sha, dir: wtDir });
      if (added.ok) {
        pinnedWorktree = added.dir;
      } else {
        console.warn(chalk.yellow(`[review-async] could not pin worktree for phase ${phaseN} review (${added.error}) — reading the live workspace instead (best-effort)`));
      }
    } else {
      console.warn(chalk.yellow(`[review-async] could not resolve phase ${phaseN}'s commit sha — reading the live workspace instead (best-effort)`));
    }
    try {
      const result = await runGuideFn({
        projectName, task: 'review', phaseN, reviewMode: action.reviewMode,
        reviewBatch: action.reviewBatch, reviewChangedFiles: action.reviewChangedFiles,
        pinnedWorktree,
      });
      await notifyContextDriftIfAny(result, notifier, projectName);
      await notifyGuideRegroundIfAny(result, notifier, projectName);
      return result;
    } finally {
      if (pinnedWorktree) await removeWorktree(workspaceDir, wtDir);
    }
  })()
    .catch((err) => ({ is_error: true, error_message: err.message, result: err.message }))
    .then((result) => { state.settled = true; return result; });
  return { promise, phaseN, action, state };
}

// Phase 52 (par-03) — replays the SAME post-review handling a synchronous
// review action gets inline in autoRun's main loop (guide-failure healing,
// the consecutive-light-review persist, FR18 auto-proceed, evaluatePause)
// against a review that settled in the background. Deliberately narrower
// than the full inline guide-action block: only a mid-stream, non-final
// review is ever deferred (isFinalReview stays fully synchronous), so this
// never needs to replicate plan/audit/bug-plan bookkeeping. Exported so the
// BLOCKER-pause / auto-proceed / heal-retry branches are directly unit
// testable without driving the whole autoRun loop.
export async function settleReviewOutcome({ result, action, cfg, unattended, projectName, workspaceDir, healer, project, runId = null }) {
  if (result.is_error && cfg.auto_heal?.enabled !== false) {
    const guideErr = new Error(result.result || 'guide execution failed');
    guideErr._phase = action.phaseN;
    const heal = await healer.heal(guideErr, { action, projectName, workspaceDir, branch: project.git_branch });
    recordRunEvent(runId, 'heal-attempt', { project: projectName, phase: action.phaseN ?? null, healed: heal.healed });
    if (heal.healed) return { mode: 'healed-retry' };
  }
  if (!result.is_error && typeof action.reviewNextConsecutiveLight === 'number') {
    setProjectMetadataField(projectName, 'consecutive_light_reviews', action.reviewNextConsecutiveLight);
  }
  if (!result.is_error) {
    const projDir = path.join(PROJECTS_DIR, projectName);
    if (await tryReviewAutoProceed({ action, cfg, projDir, projectName, runId })) {
      return { mode: 'proceed' };
    }
  }
  const pause = evaluatePause({ action, result, cfg, unattended });
  if (pause.pause) {
    return { mode: 'pause', reason: pause.reason, pauseKind: classifyPauseReason(pause.reason) };
  }
  return { mode: 'proceed' };
}

// Phase 55 (P8, speculative scout / par-08) — eligibility gate for firing a
// concurrent scout alongside a 'dev' action. Scouting must be enabled, the
// plan must have a phase AFTER the one about to run, and that phase must not
// already have a scout note sitting on disk (a note from a prior run, or one
// this same check already covered, must never re-fire the spawn). Resolves
// baseSha (the PRE-DEV HEAD) here too — it must be captured BEFORE
// executeAction's own dev call moves the workspace forward. Returns null
// (ineligible) on every gate; never throws (a plan/HEAD read failure just
// means no scout fires this round).
export async function resolveScoutEligibility({ cfg, projDir, workspaceDir, action }) {
  if (cfg.phases?.scout?.enabled !== true) return null;
  const plan = await readJson(planJsonPath(projDir));
  const nextPhaseMeta = (plan?.phases || []).find((p) => p.n > action.phaseN) || null;
  if (!nextPhaseMeta) return null;
  if (await fileExists(phaseScoutPath(projDir, nextPhaseMeta.n))) return null;
  const baseSha = await getHeadSha(workspaceDir);
  if (!baseSha) return null;
  return { phaseN: action.phaseN, nextPhaseMeta, baseSha };
}

// Phase 55 (P8, speculative scout) — spawn ONE detached haiku call that
// drafts nextPhaseMeta's file map while `phaseN`'s dev agent is still
// running. Pinned to a worktree at `baseSha` (the PRE-DEV HEAD, resolved by
// the caller BEFORE executeAction runs) so the scout reads a CONSISTENT tree,
// never the live workspace the dev agent is mid-editing. role:null,
// sessionId:null (never touches guide_session_id/last_dev_session_id — the
// same invariant every other checker/review call in this file holds), and a
// read-only CHECKER_ALLOWED_TOOLS sandbox: the scout cannot Write, so THIS
// function (the orchestrator) persists its reply to phaseScoutPath with
// base_sha front-matter (mirrors verify-loop.js's persistVerdict). NEVER
// throws — every failure mode (worktree-add, spawn, empty reply) degrades to
// a dim log and no note written; the worktree is always removed (finally).
export async function spawnPhaseScout({ cfg, projectName, projDir, workspaceDir, phaseN, baseSha, nextPhaseMeta }, deps = {}) {
  const runClaudeFn = deps.runClaude ?? runClaude;
  const nextN = nextPhaseMeta.n;
  const sha8 = baseSha.slice(0, 8);
  const wtDir = path.join(worktreesRoot(projDir), `scout-${nextN}-${sha8}`);

  const added = await addDetachedWorktree(workspaceDir, { sha: baseSha, dir: wtDir });
  if (!added.ok) {
    console.log(chalk.dim(`[phase-scout] worktree pin failed for phase ${nextN} (scouted alongside phase ${phaseN}'s dev call — ${added.error}) — skipping scout`));
    return;
  }

  try {
    const scoutCfg = {
      ...cfg,
      model: cfg.models?.['phase-scout'],
      tools: { ...cfg.tools, allowed_default: [...CHECKER_ALLOWED_TOOLS] },
    };
    delete scoutCfg._effort_override;

    const result = await runClaudeFn({
      cfg: scoutCfg,
      cwd: added.dir,
      systemPromptFile: null,
      systemPromptExtra: PHASE_SCOUT_SYSTEM_PROMPT,
      role: null,
      sessionId: null,
      project: projectName,
      phase: nextN,
      task: 'phase-scout',
      prompt: buildPhaseScoutPrompt({ phaseMeta: nextPhaseMeta }),
    });

    const noteBody = (result?.result || '').trim();
    if (!noteBody) {
      console.log(chalk.dim(`[phase-scout] empty reply for phase ${nextN} — no note written`));
      return;
    }
    const notePath = phaseScoutPath(projDir, nextN);
    await fs.mkdir(path.dirname(notePath), { recursive: true });
    await fs.writeFile(notePath, renderScoutNote(baseSha, noteBody), 'utf-8');
    console.log(chalk.dim(`[phase-scout] note written for phase ${nextN} (base ${sha8}, drafted alongside phase ${phaseN}'s dev call)`));
  } catch (err) {
    console.log(chalk.dim(`[phase-scout] spawn failed for phase ${nextN} (alongside phase ${phaseN}): ${err.message} — no note written`));
  } finally {
    await removeWorktree(workspaceDir, wtDir);
  }
}

// Phase 68 (brief 05 P3) — the ONE mandatory validator gate on a wave's merged
// HEAD, run after the ascending merge and BEFORE the single push (never push a
// red HEAD). Mirrors runDev's own post-commit validator gate (same
// runValidatorGate entrypoint), scoped to every file changed across the whole
// wave (baseSha..HEAD). Returns the gate object (`.hasFailures`). A no-op
// pass when validators are disabled. Exposed as a runPhaseWave deps seam.
async function gateMergedHead({ projectName, workspaceDir, cfg, baseSha, mergedPhases }) {
  if (cfg?.validators?.enabled === false) return { hasFailures: false, skipped: 'validators disabled', results: [] };
  const changed = baseSha ? await changedFilesSince(workspaceDir, baseSha) : { ok: false };
  const lastN = mergedPhases[mergedPhases.length - 1];
  return runValidatorGate({
    projectName, workspaceDir,
    event: { phase: lastN, phaseTitle: `parallel wave [${mergedPhases.join(', ')}]` },
    changedFiles: changed.ok ? changed.files : [], cfg,
  });
}

// Phase 69 (brief 05 P4) — the ONE mandatory validator gate on a fix batch's
// merged HEAD, run after the ascending merge and BEFORE the single push (never
// push a red HEAD). The fix analog of gateMergedHead (P3): same runValidatorGate
// entrypoint, scoped to every file changed across the whole batch (baseSha..HEAD),
// labeled by round + the merged fix numbers. Exposed as a runFixBatch deps seam.
// `kindLabel` distinguishes the event's fixTitle between P4's lane-merged
// batch (default, unchanged) and P5's single-call batch (runFixSingleCallBatch
// passes 'single-call fix batch') — cosmetic only, same runValidatorGate entrypoint.
async function gateMergedFixHead({ projectName, workspaceDir, cfg, baseSha, round, mergedFixNs, kindLabel = 'parallel fix batch', testPlan = null }) {
  if (cfg?.validators?.enabled === false) return { hasFailures: false, skipped: 'validators disabled', results: [] };
  const changed = baseSha ? await changedFilesSince(workspaceDir, baseSha) : { ok: false };
  const lastN = mergedFixNs[mergedFixNs.length - 1];
  return runValidatorGate({
    projectName, workspaceDir,
    event: { fixRound: round, fixN: lastN, fixTitle: `${kindLabel} [${mergedFixNs.join(', ')}]` },
    changedFiles: changed.ok ? changed.files : [], cfg, testPlan,
  });
}

/**
 * Phase 68 (brief 05 P3, crown-jewel) — run a wave of independent phases
 * concurrently in git-worktree lanes, then merge STRICTLY ASCENDING, degrading
 * to serial on the first failure/conflict. The guide has ALREADY run any
 * next-prompt serially (the guide session is singular — never parallelized);
 * this only fans out the DEV work.
 *
 * Flow:
 *   1. provisionLane(baseSha = workspace HEAD) for every wave phase.
 *   2. Launch each lane's runDev({laneMode}) under its own withJobKey via
 *      Promise.allSettled — the per-spawn job key is the only concurrency
 *      primitive (the project-level running_jobs claim already serializes runs;
 *      lanes live inside that one claim).
 *   3. Walk the settled results ASCENDING. For the CONTIGUOUS SUCCESSFUL PREFIX:
 *      mergeNoFf('lane/phase-N') → re-resolve via phaseCommitSha →
 *      completeMergedPhase (the SAME helper runDev's serial path calls, so
 *      current_phase stays "max contiguous completed n" for free).
 *   4. The FIRST failed/conflicted lane stops the walk and is handled like a
 *      serial failure (dev fail → escalation marker + reset pending; merge
 *      conflict → discard lane, reset pending, lane-conflict lesson) so it
 *      re-runs serially next iteration. ALL later lanes — even successful ones —
 *      are abandoned (reset pending + lane-abandoned lesson) so in-order merge
 *      is never violated.
 *   5. ONE mandatory validator gate on the merged HEAD + ONE push per wave. A
 *      merged-HEAD gate failure is today's validator-gate failure on the LOWEST
 *      merged phase: reset HEAD to baseSha (never push a red HEAD), reset every
 *      wave phase pending, escalate the lowest, re-run serially.
 *   6. Every lane is torn down in `finally` (merged → done, else abandoned).
 *
 * @returns {Promise<{ran:boolean, actions:number, mergedPhases:number[], pushed:boolean, serialFallback:number[], failure:{phaseN:number,kind:string}|null}>}
 */
export async function runPhaseWave(
  { projectName, cfg, projDir, workspaceDir, wave, runId = null, notifier = null },
  deps = {},
) {
  const _provisionLane = deps.provisionLane ?? provisionLane;
  const _destroyLane = deps.destroyLane ?? destroyLane;
  const _runDev = deps.runDev ?? runDev;
  const _mergeNoFf = deps.mergeNoFf ?? mergeNoFf;
  const _mergeAbort = deps.mergeAbort ?? mergeAbort;
  const _resetHard = deps.resetHard ?? resetHard;
  const _phaseCommitSha = deps.phaseCommitSha ?? phaseCommitSha;
  const _getHeadSha = deps.getHeadSha ?? getHeadSha;
  const _pushBranch = deps.pushBranch ?? pushBranch;
  const _completeMergedPhase = deps.completeMergedPhase ?? completeMergedPhase;
  const _writeEscalationMarker = deps.writeEscalationMarker ?? writeEscalationMarker;
  const _recordLesson = deps.recordLesson ?? recordLesson;
  const _gateMergedHead = deps.gateMergedHead ?? gateMergedHead;
  const _withJobKey = deps.withJobKey ?? withJobKey;
  const log = deps.log ?? ((m) => console.log(m));

  const project = getProject(projectName);
  const pushTargetBranch = project?.git_branch || null;
  const baseSha = await _getHeadSha(workspaceDir);
  const baseCompletedPhase = project?.current_phase || 0;
  const serialFallback = [];
  const mergedPhaseNs = new Set();

  // 1. Provision one lane per wave phase, all branched off the SAME pre-wave HEAD.
  const lanes = [];
  try {
    for (const p of wave) {
      recordRunEvent(runId, 'phase-started', { project: projectName, phase: p.n });
      // eslint-disable-next-line no-await-in-loop
      const lane = await _provisionLane({
        projectName, workspaceDir, projDir, kind: 'phase', n: p.n, baseSha, cfg,
      });
      lanes.push({ phase: p, lane });
    }
    log(chalk.cyan(`  ⇉ Parallel wave: phases ${wave.map((p) => p.n).join(', ')} in ${lanes.length} lane(s) (base ${baseSha ? baseSha.slice(0, 8) : '?'})`));

    // 2. Launch every dev lane concurrently, each under its own job key.
    const settled = await Promise.allSettled(lanes.map(({ phase, lane }) =>
      _withJobKey(lane.jobKey, () => _runDev({
        projectName, laneMode: true, laneDir: lane.laneDir, laneBranch: lane.branch, lanePhaseN: phase.n,
      })),
    ));

    // 3. Ascending merge of the contiguous successful prefix.
    let failure = null;
    for (let i = 0; i < lanes.length; i += 1) {
      const { phase, lane } = lanes[i];
      const s = settled[i];
      const laneOk = s.status === 'fulfilled' && s.value && !s.value.is_error;
      if (!laneOk) {
        const laneResult = s.status === 'fulfilled'
          ? s.value
          : { is_error: true, error_message: s.reason?.message || 'lane threw', result: s.reason?.message || 'lane threw' };
        failure = { index: i, phaseN: phase.n, kind: 'dev', result: laneResult };
        break;
      }
      // Merge the lane branch. NB the merge message must NOT start with
      // "phase-N:" or phaseCommitSha would resolve the merge commit instead of
      // the lane's actual dev commit.
      // eslint-disable-next-line no-await-in-loop
      const merge = await _mergeNoFf(workspaceDir, { branch: lane.branch, message: `Merge ${lane.branch} (parallel phase wave)` });
      if (!merge.ok) {
        // eslint-disable-next-line no-await-in-loop
        await _mergeAbort(workspaceDir).catch(() => {});
        failure = { index: i, phaseN: phase.n, kind: 'conflict' };
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      const commit_sha = (await _phaseCommitSha(workspaceDir, phase.n)) || (await _getHeadSha(workspaceDir));
      _completeMergedPhase({ projectName, n: phase.n, commit_sha, projDir });
      mergedPhaseNs.add(phase.n);
      recordRunEvent(runId, 'dev-completed', { project: projectName, phase: phase.n });
    }

    // 4. ONE mandatory merged-HEAD validator gate + ONE push per wave.
    let pushed = false;
    let gateFailedRollback = false;
    if (mergedPhaseNs.size > 0) {
      const mergedList = [...mergedPhaseNs].sort((a, b) => a - b);
      const gate = await _gateMergedHead({ projectName, workspaceDir, cfg, baseSha, mergedPhases: mergedList });
      if (gate?.hasFailures) {
        // Merged-HEAD gate failure == validator-gate failure on the LOWEST merged
        // phase. Never push a red HEAD: roll the merges back to baseSha, reset
        // every wave phase to pending, escalate the lowest, re-run serially.
        const lowest = mergedList[0];
        try {
          await _resetHard(workspaceDir, baseSha);
        } catch (resetErr) {
          log(chalk.red(`✗ _resetHard failed — workspace may still have merged commits; skipping DB update to avoid state mismatch: ${resetErr.message}`));
          throw resetErr;
        }
        setCurrentPhase(projectName, baseCompletedPhase);
        for (const n of mergedList) upsertPhase({ project: projectName, n, status: 'pending' });
        const excerpt = (gateFailureExcerpt(gate) || 'merged-HEAD validators failed').slice(0, 300);
        await _writeEscalationMarker({
          projDir, phaseN: lowest, failedTier: failedTierFromResult({ is_error: true }, cfg),
          reason: `merged-HEAD validator gate failed across wave [${mergedList.join(', ')}]: ${excerpt}`,
          at: new Date().toISOString(),
        }).catch(() => {});
        _recordLesson(projDir, { kind: 'validator-fail', phase: lowest, source: 'auto-runner:wave-merged-gate', lesson: excerpt, files: [] }, cfg);
        recordRunEvent(runId, 'validator-failed', { project: projectName, phase: lowest, summary: 'merged-HEAD gate failed' });
        log(chalk.red(`✗ Wave merged-HEAD validators failed — rolled back to ${baseSha ? baseSha.slice(0, 8) : '?'}; phase ${lowest} re-runs serially (escalated).`));
        serialFallback.push(lowest);
        mergedPhaseNs.clear();
        gateFailedRollback = true;
      } else if (pushTargetBranch) {
        const push = await _pushBranch(workspaceDir, { branch: pushTargetBranch });
        pushed = !!push.ok;
        if (push.ok) {
          log(chalk.green(`✓ Wave merged phases ${mergedList.join(', ')} → pushed ${pushTargetBranch} (${(await _getHeadSha(workspaceDir))?.slice(0, 8) || '?'})`));
        } else {
          log(chalk.yellow(`⚠ Wave push failed (${pushTargetBranch}): ${push.error} — merged commits are local only.`));
        }
      } else {
        log(chalk.dim('  (no git_branch — wave merged locally, not pushed)'));
      }
    }

    // 5. Handle the first failure (dev fail / conflict) like a serial failure so
    //    it re-runs serially through the existing reprompt/escalate/pause ladder.
    if (failure && failure.kind === 'dev') {
      const failedTier = failedTierFromResult(failure.result, cfg);
      const { written, targetTier } = await _writeEscalationMarker({
        projDir, phaseN: failure.phaseN, failedTier,
        reason: `lane dev failed: ${(failure.result?.error_message || failure.result?.result || 'dev error').toString().slice(0, 300)}`,
        at: new Date().toISOString(),
      }).catch(() => ({ written: false, targetTier: null }));
      upsertPhase({ project: projectName, n: failure.phaseN, status: 'pending' });
      _recordLesson(projDir, { kind: 'escalation', phase: failure.phaseN, source: 'auto-runner:wave-dev-fail', lesson: (failure.result?.error_message || failure.result?.result || 'lane dev failed').toString(), files: [] }, cfg);
      recordRunEvent(runId, 'dev-failed', { project: projectName, phase: failure.phaseN });
      if (written) log(chalk.yellow(`  → Wave lane phase ${failure.phaseN} failed — re-runs serially on ${targetTier} (escalation marker set)`));
      else log(chalk.yellow(`  → Wave lane phase ${failure.phaseN} failed on top tier — re-runs serially (no escalation marker)`));
      serialFallback.push(failure.phaseN);
    } else if (failure && failure.kind === 'conflict') {
      upsertPhase({ project: projectName, n: failure.phaseN, status: 'pending' });
      _recordLesson(projDir, {
        kind: 'lane-conflict', phase: failure.phaseN, source: 'auto-runner:wave-merge-conflict',
        lesson: `lane/phase-${failure.phaseN} conflicted merging onto the wave-merged HEAD — a files_expected disjointness estimate was wrong; re-running serially.`,
        files: [],
      }, cfg);
      recordRunEvent(runId, 'dev-failed', { project: projectName, phase: failure.phaseN });
      log(chalk.yellow(`  → Wave lane phase ${failure.phaseN} merge CONFLICT — lane discarded, phase re-runs serially (lane-conflict lesson recorded)`));
      serialFallback.push(failure.phaseN);
    }

    // 6. Abandon every later lane (even successful ones) to preserve in-order merge.
    if (failure) {
      for (let j = failure.index + 1; j < lanes.length; j += 1) {
        const abandonedN = lanes[j].phase.n;
        upsertPhase({ project: projectName, n: abandonedN, status: 'pending' });
        _recordLesson(projDir, {
          kind: 'lane-abandoned', phase: abandonedN, source: 'auto-runner:wave-abandon',
          lesson: `phase-${abandonedN} lane abandoned to preserve in-order merge after phase ${failure.phaseN} ${failure.kind}.`,
          files: [],
        }, cfg);
      }
      if (lanes.length - failure.index - 1 > 0) {
        log(chalk.yellow(`  → Abandoned ${lanes.length - failure.index - 1} later lane(s) so the in-order merge is never violated`));
      }
    }

    return {
      ran: true,
      actions: wave.length,
      mergedPhases: [...mergedPhaseNs].sort((a, b) => a - b),
      pushed,
      serialFallback,
      failure: failure ? { phaseN: failure.phaseN, kind: gateFailedRollback ? 'gate' : failure.kind } : (gateFailedRollback ? { phaseN: serialFallback[0], kind: 'gate' } : null),
    };
  } finally {
    // Every lane torn down here, bounded + crash-safe: merged → done, else abandoned.
    for (const { phase, lane } of lanes) {
      const status = mergedPhaseNs.has(phase.n) ? 'done' : 'abandoned';
      // eslint-disable-next-line no-await-in-loop
      await _destroyLane({
        workspaceDir, laneDir: lane.laneDir, branch: lane.branch, laneId: lane.laneId, status,
      }).catch(() => {});
    }
  }
}

/**
 * Phase 68 (brief 05 P3) — resolve the wave to run for a 'dev' action. Reads
 * the plan + DB phases snapshot, computes DAG cleanliness via
 * validatePlanStructure, and delegates to selectPhaseWave (which applies every
 * brief-05 guard). Fails safe to serial (a size-≤1 wave) on any error or when
 * the selected wave's head isn't the phase pickNextAction chose — the serial
 * pointer (current_phase) is never reordered.
 *
 * @returns {Promise<{ wave: Array<object>, reason: string }>}
 */
export async function computeDevWave({ projectName, cfg, projDir, action }) {
  try {
    const plan = await readJson(planJsonPath(projDir));
    if (!plan?.phases?.length) return { wave: [], reason: 'no plan' };
    const project = getProject(projectName);
    const sv = validatePlanStructure(plan, { currentPhase: project?.current_phase || 0 });
    const phasesTable = getPhases(projectName);
    const { wave, reason } = selectPhaseWave({ plan, phasesTable, cfg, dagClean: sv.ok });
    // Defensive: a multi-phase wave must START at the exact phase pickNextAction
    // chose to run next; otherwise fall back to serial (never reorder the serial
    // pointer). A DAG whose first ready phase differs from the serial next phase
    // degrades cleanly here.
    if (wave.length > 1 && wave[0]?.n !== action.phaseN) {
      return { wave: wave.slice(0, 1), reason: 'wave head != next serial phase — serial fallback' };
    }
    return { wave, reason };
  } catch (err) {
    console.warn(chalk.yellow(`[phase-wave] planning failed (${err.message}) — serial fallback`));
    return { wave: [], reason: 'error' };
  }
}

/**
 * Phase 69 (brief 05 P4) — run a batch of independent, file-disjoint pending
 * fixes concurrently in git-worktree lanes, then merge STRICTLY ASCENDING (fix
 * order), degrading to serial on the first failure/conflict. The fix analog of
 * runPhaseWave (P3), applied to fixes with the ONE correctness-critical
 * difference: `bug_rounds.fixes_completed` is a bare +1 COUNTER used as an ARRAY
 * INDEX — recording out of order (or ahead of the committed fixes) silently
 * corrupts fix dispatch.
 *
 * Counter discipline:
 *   - `recordFixCompletion` is called per merged lane IN ASCENDING fix order.
 *   - Only the CONTIGUOUS SUCCESSFUL PREFIX is recorded; at the first failed lane
 *     the walk STOPS and every later lane — even a successful one — is ABANDONED
 *     (destroyLane + lesson), never recorded, so `fixes_completed` stays
 *     contiguous. The failed fix re-runs serially through the existing single-fix
 *     ladder (escalation marker → reprompt/escalate/park in the main loop).
 *   - recordFixCompletion is DEFERRED until AFTER the merged-HEAD validator gate
 *     passes: the counter has no decrement accessor, so recording during the walk
 *     then rolling the merge back on a gate failure would strand it AHEAD of the
 *     committed fixes. Deferring keeps `fixes_completed === committed` under every
 *     outcome permutation. Order (ascending) + contiguity (prefix only) preserved.
 *
 * Per-lane validator gate runs inside each lane (gateInLane); the ONE mandatory
 * merged-HEAD gate + ONE push happen once per batch. Reconciliation is free —
 * `fixCommitExists` greps `^fix-rR-N:` subjects, which survive `--no-ff` merges —
 * so pickBugAction's self-heal walk needs no changes.
 *
 * @returns {Promise<{ran:boolean, actions:number, mergedFixes:number[], pushed:boolean, serialFallback:string[], failure:{fixN:number,kind:string}|null}>}
 */
export async function runFixBatch(
  { projectName, cfg, projDir, workspaceDir, round, fixes, runId = null, notifier = null },
  deps = {},
) {
  const _provisionLane = deps.provisionLane ?? provisionLane;
  const _destroyLane = deps.destroyLane ?? destroyLane;
  const _runDev = deps.runDev ?? runDev;
  const _mergeNoFf = deps.mergeNoFf ?? mergeNoFf;
  const _mergeAbort = deps.mergeAbort ?? mergeAbort;
  const _resetHard = deps.resetHard ?? resetHard;
  const _getHeadSha = deps.getHeadSha ?? getHeadSha;
  const _pushBranch = deps.pushBranch ?? pushBranch;
  const _recordFixCompletion = deps.recordFixCompletion ?? recordFixCompletion;
  const _writeEscalationMarker = deps.writeEscalationMarker ?? writeEscalationMarker;
  const _recordLesson = deps.recordLesson ?? recordLesson;
  const _gateMergedFixHead = deps.gateMergedFixHead ?? gateMergedFixHead;
  const _withJobKey = deps.withJobKey ?? withJobKey;
  const log = deps.log ?? ((m) => console.log(m));

  const project = getProject(projectName);
  const pushTargetBranch = project?.git_branch || null;
  const baseSha = await _getHeadSha(workspaceDir);
  const serialFallback = [];      // fix KEYS (`r{round}-{n}`) → run serially next pick
  const mergedFixNs = [];         // fix .n merged onto HEAD (contiguous prefix), ascending
  const fixKey = (n) => `r${round}-${n}`;

  // 1. Provision one lane per batch fix, all branched off the SAME pre-batch HEAD.
  const lanes = [];
  try {
    for (const f of fixes) {
      recordRunEvent(runId, 'fix-started', { project: projectName, phase: f.n, round });
      // eslint-disable-next-line no-await-in-loop
      const lane = await _provisionLane({
        projectName, workspaceDir, projDir, kind: 'fix', n: f.n, round, baseSha, cfg,
      });
      lanes.push({ fix: f, lane });
    }
    log(chalk.cyan(`  ⇉ Parallel fix batch: round ${round} fixes ${fixes.map((f) => f.n).join(', ')} in ${lanes.length} lane(s) (base ${baseSha ? baseSha.slice(0, 8) : '?'})`));

    // 2. Launch every fix lane concurrently, each under its own job key.
    const settled = await Promise.allSettled(lanes.map(({ fix, lane }) =>
      _withJobKey(lane.jobKey, () => _runDev({
        projectName, fix: { round, n: fix.n, title: fix.title },
        laneMode: true, laneDir: lane.laneDir, laneBranch: lane.branch,
      })),
    ));

    // 3. Ascending merge of the contiguous successful prefix (recordFixCompletion
    //    deferred to step 4, after the merged-HEAD gate — see the counter note above).
    let failure = null;
    for (let i = 0; i < lanes.length; i += 1) {
      const { fix, lane } = lanes[i];
      const s = settled[i];
      const laneOk = s.status === 'fulfilled' && s.value && !s.value.is_error;
      if (!laneOk) {
        const laneResult = s.status === 'fulfilled'
          ? s.value
          : { is_error: true, error_message: s.reason?.message || 'lane threw', result: s.reason?.message || 'lane threw' };
        failure = { index: i, fixN: fix.n, kind: 'dev', result: laneResult };
        break;
      }
      // The merge message must NOT start with "fix-rR-N:" or fixCommitExists would
      // match the merge commit instead of the lane's actual fix commit.
      // eslint-disable-next-line no-await-in-loop
      const merge = await _mergeNoFf(workspaceDir, { branch: lane.branch, message: `Merge ${lane.branch} (parallel fix batch)` });
      if (!merge.ok) {
        // eslint-disable-next-line no-await-in-loop
        await _mergeAbort(workspaceDir).catch(() => {});
        failure = { index: i, fixN: fix.n, kind: 'conflict' };
        break;
      }
      mergedFixNs.push(fix.n);
    }

    // 4. ONE mandatory merged-HEAD validator gate + ONE push per batch. On PASS,
    //    recordFixCompletion ascending (deferred to here). On FAIL, roll the merges
    //    back to baseSha, record NOTHING, escalate the LOWEST merged fix, re-run it
    //    serially — the fix analog of P3's merged-HEAD rollback.
    let pushed = false;
    const recorded = [];
    let gateLowest = null;
    if (mergedFixNs.length > 0) {
      const gate = await _gateMergedFixHead({ projectName, workspaceDir, cfg, baseSha, round, mergedFixNs });
      if (gate?.hasFailures) {
        gateLowest = mergedFixNs[0];
        await _resetHard(workspaceDir, baseSha).catch(() => {});
        const excerpt = (gateFailureExcerpt(gate) || 'merged-HEAD validators failed').slice(0, 300);
        const { written, targetTier } = await _writeEscalationMarker({
          projDir, fix: { round, n: gateLowest }, failedTier: failedTierFromResult({ is_error: true }, cfg),
          reason: `merged-HEAD validator gate failed across fix batch [${mergedFixNs.join(', ')}]: ${excerpt}`,
          at: new Date().toISOString(),
        }).catch(() => ({ written: false, targetTier: null }));
        _recordLesson(projDir, { kind: 'validator-fail', fix: fixKey(gateLowest), source: 'auto-runner:fix-batch-merged-gate', lesson: excerpt, files: [] }, cfg);
        recordRunEvent(runId, 'validator-failed', { project: projectName, phase: gateLowest, round, summary: 'merged-HEAD gate failed' });
        log(chalk.red(`✗ Fix batch merged-HEAD validators failed — rolled back to ${baseSha ? baseSha.slice(0, 8) : '?'}; fix r${round}-${gateLowest} re-runs serially${written ? ` (escalated → ${targetTier})` : ''}.`));
        serialFallback.push(fixKey(gateLowest));
        mergedFixNs.length = 0;   // nothing stuck → every lane torn down as abandoned
      } else {
        // Gate passed → record the merged prefix IN ORDER, then ONE push.
        for (const n of mergedFixNs) {
          _recordFixCompletion({ project: projectName, round, fixN: n });
          recorded.push(n);
          recordRunEvent(runId, 'fix-completed', { project: projectName, phase: n, round });
        }
        if (pushTargetBranch) {
          const push = await _pushBranch(workspaceDir, { branch: pushTargetBranch });
          pushed = !!push.ok;
          if (push.ok) log(chalk.green(`✓ Fix batch merged fixes ${recorded.join(', ')} → pushed ${pushTargetBranch} (${(await _getHeadSha(workspaceDir))?.slice(0, 8) || '?'})`));
          else log(chalk.yellow(`⚠ Fix batch push failed (${pushTargetBranch}): ${push.error} — merged commits are local only.`));
        } else {
          log(chalk.dim('  (no git_branch — fix batch merged locally, not pushed)'));
        }
      }
    }

    // 5. Handle the first failure (dev fail / conflict) like a serial fix failure
    //    so it re-runs through the existing single-fix ladder (escalate / park).
    if (failure && failure.kind === 'dev') {
      const failedTier = failedTierFromResult(failure.result, cfg);
      const { written, targetTier } = await _writeEscalationMarker({
        projDir, fix: { round, n: failure.fixN }, failedTier,
        reason: `lane fix failed: ${(failure.result?.error_message || failure.result?.result || 'fix error').toString().slice(0, 300)}`,
        at: new Date().toISOString(),
      }).catch(() => ({ written: false, targetTier: null }));
      _recordLesson(projDir, { kind: 'escalation', fix: fixKey(failure.fixN), source: 'auto-runner:fix-batch-dev-fail', lesson: (failure.result?.error_message || failure.result?.result || 'lane fix failed').toString(), files: [] }, cfg);
      recordRunEvent(runId, 'dev-failed', { project: projectName, phase: failure.fixN, round });
      if (written) log(chalk.yellow(`  → Fix batch lane fix r${round}-${failure.fixN} failed — re-runs serially on ${targetTier} (escalation marker set)`));
      else log(chalk.yellow(`  → Fix batch lane fix r${round}-${failure.fixN} failed on top tier — re-runs serially (no escalation marker)`));
      serialFallback.push(fixKey(failure.fixN));
    } else if (failure && failure.kind === 'conflict') {
      _recordLesson(projDir, {
        kind: 'lane-conflict', fix: fixKey(failure.fixN), source: 'auto-runner:fix-batch-merge-conflict',
        lesson: `lane/fix-r${round}-${failure.fixN} conflicted merging onto the batch-merged HEAD — a files_likely disjointness estimate was wrong; re-running serially.`,
        files: [],
      }, cfg);
      recordRunEvent(runId, 'dev-failed', { project: projectName, phase: failure.fixN, round });
      log(chalk.yellow(`  → Fix batch lane fix r${round}-${failure.fixN} merge CONFLICT — lane discarded, fix re-runs serially (lane-conflict lesson recorded)`));
      serialFallback.push(fixKey(failure.fixN));
    }

    // 6. Abandon every later lane (even successful ones) to keep fixes_completed
    //    contiguous. They are NOT recorded and NOT flagged for serial fallback —
    //    they re-batch once the failed fix ahead of them resolves.
    if (failure) {
      const laterCount = lanes.length - failure.index - 1;
      for (let j = failure.index + 1; j < lanes.length; j += 1) {
        _recordLesson(projDir, {
          kind: 'lane-abandoned', fix: fixKey(lanes[j].fix.n), source: 'auto-runner:fix-batch-abandon',
          lesson: `fix-r${round}-${lanes[j].fix.n} lane abandoned to keep fixes_completed contiguous after fix ${failure.fixN} ${failure.kind}.`,
          files: [],
        }, cfg);
      }
      if (laterCount > 0) {
        log(chalk.yellow(`  → Abandoned ${laterCount} later fix lane(s) so fixes_completed stays contiguous`));
      }
    }

    return {
      ran: true,
      actions: fixes.length,
      mergedFixes: recorded,
      pushed,
      serialFallback,
      failure: failure
        ? { fixN: failure.fixN, kind: failure.kind }
        : (gateLowest != null ? { fixN: gateLowest, kind: 'gate' } : null),
    };
  } finally {
    // Every lane torn down here, bounded + crash-safe: recorded → done, else abandoned.
    for (const { fix, lane } of lanes) {
      const status = mergedFixNs.includes(fix.n) ? 'done' : 'abandoned';
      // eslint-disable-next-line no-await-in-loop
      await _destroyLane({
        workspaceDir, laneDir: lane.laneDir, branch: lane.branch, laneId: lane.laneId, status,
      }).catch(() => {});
    }
  }
}

// Phase 70 (brief 05 P5) — pure selector for a single-call minor-fix batch.
// Unlike P4's selectFixBatch (worktree lanes, any severity), this selects a
// consecutive run starting at fixes[completed] that is:
//   - MINOR severity ONLY (missing/major/critical severity ends the run
//     immediately, including at the head — majors/criticals are NEVER
//     batched, matching the brief exactly);
//   - pairwise-disjoint files_likely, same in-code intersection rule as P4's
//     selectFixBatch (never trust a guide "independent" flag);
//   - capped at bug_cycle.batch_max.
// A candidate with missing/empty files_likely is simply never added to the
// batch (whether it's the head or a later member) — unlike P4, where a
// disjointness-unknown HEAD still "runs alone" via the lane machinery, a
// single-call batch only has value at size > 1, so there is no equivalent
// "run alone" case to preserve; excluding it outright keeps the intersection
// check unambiguous for every batch member. bug_cycle.batch_minor_fixes:false
// or bug_cycle.batch_max<=0 disables outright (returns an empty batch, which
// pickBugAction's `batch.length > 1` check collapses to the classic
// single-fix action).
function selectMinorFixBatch({ fixes, completed = 0, cfg }) {
  const bc = cfg?.bug_cycle || {};
  if (bc.batch_minor_fixes === false) return { batch: [], reason: 'bug_cycle.batch_minor_fixes disabled' };
  const cap = Number.isInteger(bc.batch_max) ? bc.batch_max : 4;
  if (cap <= 0) return { batch: [], reason: 'bug_cycle.batch_max<=0 (disabled)' };

  const all = Array.isArray(fixes) ? fixes : [];
  const pending = all.slice(completed);
  const batch = [];
  const usedFiles = new Set();
  for (const f of pending) {
    if (batch.length >= cap) break;
    if (String(f?.severity || '').toLowerCase() !== 'minor') break;
    const files = Array.isArray(f?.files_likely) ? f.files_likely.filter((x) => typeof x === 'string' && x.trim()) : [];
    if (files.length === 0) break;
    if (files.some((x) => usedFiles.has(x))) break;
    batch.push(f);
    for (const x of files) usedFiles.add(x);
  }
  return {
    batch,
    reason: batch.length > 1 ? `single-call minor-fix batch of ${batch.length}` : 'serial (non-minor head / disjointness / no estimate / cap)',
  };
}

// Phase 70 (brief 05 P5) — write a per-round note (markdown, operator-visible
// — mirrors the existing parked.md convention) plus a recordLesson entry
// whenever a single-call batch falls back to individual dispatch. Both are
// best-effort; a failure here must never affect the caller's own outcome.
async function noteBatchFallback({ projDir, round, fixes, reason, recordLessonFn, cfg }) {
  try {
    const notePath = path.join(projDir, '.guide', 'bug-rounds', `round-${round}`, 'batch-fallback.md');
    await fs.mkdir(path.dirname(notePath), { recursive: true });
    await fs.appendFile(
      notePath,
      `- single-call batch [${fixes.map((f) => f.n).join(', ')}] fell back to individual dispatch at ${new Date().toISOString()}: ${reason}\n`,
      'utf-8',
    );
  } catch { /* non-fatal — operator note only */ }
  recordLessonFn(projDir, {
    kind: 'batch-fallback', fix: `r${round}-${fixes[0].n}`,
    source: 'auto-runner:fix-single-call-batch', lesson: reason, files: [],
  }, cfg);
}

/**
 * Phase 70 (brief 05 P5) — run a batch of consecutive, file-disjoint MINOR
 * fixes as ONE dev spawn (one fix-execution call, one commit per fix, in the
 * REAL workspace — never a lane; see selectMinorFixBatch's header for why
 * lanes and this feature are mutually exclusive in v1). The single-call
 * counterpart to P4's runFixBatch: same "counter is a committed-prefix index"
 * discipline (recordFixCompletion only for the contiguous fixCommitExists
 * prefix, ascending), but ONE spawn instead of N lanes, and a from-scratch
 * failure story since there is no per-lane merge/abandon machinery to lean on:
 *
 *   - preBatchSha is captured FIRST, before the spawn.
 *   - On a call error OR a failed merged-HEAD validator gate (run ONCE,
 *     scoped to the whole batch's diff via the SAME gateMergedFixHead P4
 *     uses), the batch's commits must be rolled back so every fix can be
 *     re-dispatched individually — but ONLY if they are still unpushed.
 *     aheadBehind is the MANDATORY safety check before any reset: ahead>0 &&
 *     behind===0 means the commits are local-only and safe to `git reset
 *     --hard preBatchSha`; a null result (no upstream) or behind>0 (diverged
 *     — another host pushed concurrently) is treated as AMBIGUOUS/PUSHED and
 *     the reset is skipped — the commits stay in place, no batch-level
 *     escalation/validation marker is written either way, and every fix in
 *     the batch falls through to today's per-fix failure path.
 *   - On success (full or partial), reconcile the CONTIGUOUS committed
 *     prefix via fixCommitExists, recordFixCompletion ascending, ONE push. A
 *     green-but-partial batch (the agent stopped partway, or committed out of
 *     order) records only the contiguous prefix and re-queues the rest
 *     individually — graceful degradation, never a stall.
 *   - Either way, every fix left un-recorded is noted (recordLesson +
 *     round-scoped batch-fallback.md) and returned in `batchFallback` so the
 *     caller can force individual (never re-batched) dispatch next pick.
 *
 * @returns {Promise<{ran:boolean, actions:number, mergedFixes:number[], pushed:boolean, batchFallback:string[], failure:{kind:string,reset:boolean}|null}>}
 */
export async function runFixSingleCallBatch(
  { projectName, cfg, projDir, workspaceDir, round, fixes, runId = null, notifier = null },
  deps = {},
) {
  const _runDev = deps.runDev ?? runDev;
  const _getHeadSha = deps.getHeadSha ?? getHeadSha;
  const _resetHard = deps.resetHard ?? resetHard;
  const _aheadBehind = deps.aheadBehind ?? aheadBehind;
  const _pushBranch = deps.pushBranch ?? pushBranch;
  const _recordFixCompletion = deps.recordFixCompletion ?? recordFixCompletion;
  const _gateMergedFixHead = deps.gateMergedFixHead ?? gateMergedFixHead;
  const _fixCommitExists = deps.fixCommitExists ?? fixCommitExists;
  const _recordLesson = deps.recordLesson ?? recordLesson;
  const log = deps.log ?? ((m) => console.log(m));

  const project = getProject(projectName);
  const pushTargetBranch = project?.git_branch || null;
  const fixKey = (n) => `r${round}-${n}`;
  const allKeys = fixes.map((f) => fixKey(f.n));

  const preBatchSha = await _getHeadSha(workspaceDir);
  log(chalk.cyan(`  ⇉ Single-call fix batch: round ${round} fixes ${fixes.map((f) => f.n).join(', ')} (base ${preBatchSha ? preBatchSha.slice(0, 8) : '?'})`));
  for (const f of fixes) recordRunEvent(runId, 'fix-started', { project: projectName, phase: f.n, round });

  // Verify the batch's commits are still unpushed before ANY reset — a pushed
  // or ambiguous (no upstream / diverged) state must NEVER be reset.
  const resetIfUnpushed = async (label) => {
    if (!pushTargetBranch) {
      log(chalk.yellow(`⚠ Fix batch ${label} — no git_branch on record, cannot verify push state; leaving commits in place (no reset).`));
      return false;
    }
    const ab = await _aheadBehind(workspaceDir, pushTargetBranch);
    if (!ab || ab.behind > 0 || ab.ahead === 0) {
      log(chalk.yellow(`⚠ Fix batch ${label} — aheadBehind ${ab ? `ahead=${ab.ahead} behind=${ab.behind}` : 'unavailable'} is ambiguous/pushed; NOT resetting — falls through to today's failure path.`));
      return false;
    }
    await _resetHard(workspaceDir, preBatchSha).catch(() => {});
    log(chalk.red(`✗ Fix batch ${label} — commits were unpushed (ahead ${ab.ahead}, behind 0); rolled back to ${preBatchSha ? preBatchSha.slice(0, 8) : '?'}.`));
    return true;
  };

  let devResult;
  try {
    devResult = await _runDev({ projectName, batchFixes: fixes });
  } catch (err) {
    devResult = { is_error: true, error_message: err.message, result: err.message };
  }

  if (devResult.is_error) {
    const reset = await resetIfUnpushed('dev call failed');
    await noteBatchFallback({
      projDir, round, fixes,
      reason: `dev call failed: ${(devResult.error_message || devResult.result || 'fix error').toString().slice(0, 300)}`,
      recordLessonFn: _recordLesson, cfg,
    });
    recordRunEvent(runId, 'dev-failed', { project: projectName, phase: fixes[0].n, round });
    log(chalk.yellow(`  → Single-call batch fell back — fixes ${fixes.map((f) => f.n).join(', ')} re-dispatch individually.`));
    return { ran: true, actions: 1, mergedFixes: [], pushed: false, batchFallback: allKeys, failure: { kind: 'dev', reset } };
  }

  const gate = await _gateMergedFixHead({
    projectName, workspaceDir, cfg, baseSha: preBatchSha, round, mergedFixNs: fixes.map((f) => f.n),
    kindLabel: 'single-call fix batch', testPlan: devResult.context_test_plan || null,
  });
  if (gate?.hasFailures) {
    const reset = await resetIfUnpushed('merged-HEAD validator gate failed');
    const excerpt = (gateFailureExcerpt(gate) || 'merged-HEAD validators failed').slice(0, 300);
    await noteBatchFallback({ projDir, round, fixes, reason: `validator gate failed: ${excerpt}`, recordLessonFn: _recordLesson, cfg });
    recordRunEvent(runId, 'validator-failed', { project: projectName, phase: fixes[0].n, round, summary: 'single-call batch gate failed' });
    log(chalk.yellow(`  → Single-call batch fell back — fixes ${fixes.map((f) => f.n).join(', ')} re-dispatch individually.`));
    return { ran: true, actions: 1, mergedFixes: [], pushed: false, batchFallback: allKeys, failure: { kind: 'gate', reset } };
  }

  // Success — reconcile the CONTIGUOUS committed prefix, record ascending, ONE push.
  const recorded = [];
  for (const f of fixes) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await _fixCommitExists(workspaceDir, round, f.n))) break;
    recorded.push(f.n);
  }
  for (const n of recorded) {
    _recordFixCompletion({ project: projectName, round, fixN: n });
    recordRunEvent(runId, 'fix-completed', { project: projectName, phase: n, round });
  }
  const individualFallback = fixes.filter((f) => !recorded.includes(f.n)).map((f) => fixKey(f.n));

  let pushed = false;
  if (recorded.length > 0 && pushTargetBranch) {
    const push = await _pushBranch(workspaceDir, { branch: pushTargetBranch });
    pushed = !!push.ok;
    if (push.ok) log(chalk.green(`✓ Single-call fix batch committed ${recorded.join(', ')} → pushed ${pushTargetBranch} (${(await _getHeadSha(workspaceDir))?.slice(0, 8) || '?'})`));
    else log(chalk.yellow(`⚠ Single-call fix batch push failed (${pushTargetBranch}): ${push.error} — commits are local only.`));
  } else if (recorded.length > 0) {
    log(chalk.dim('  (no git_branch — fix batch committed locally, not pushed)'));
  }

  if (individualFallback.length) {
    log(chalk.yellow(`  → Fixes ${individualFallback.join(', ')} not reconciled from this batch — re-dispatch individually (contiguous-prefix rule).`));
  }

  return {
    ran: true, actions: fixes.length, mergedFixes: recorded, pushed,
    batchFallback: individualFallback, failure: null,
  };
}

// A dev/fix failure is a TIMEOUT when its message matches any of the four
// runner kill signatures (wall-clock, idle-stall, tool-hang, turn-stall). These
// are the messages claude-runner throws after exhausting its own retries; the
// regex must stay in sync with TRANSIENT_PATTERNS in claude-runner.js and the
// PHASE_STUCK rules in error-classifier.js.
const TIMEOUT_ERR_RE = /timed out after \d+m|tool call hung for \d+m|turn stalled — no completion|stalled — no output for/i;
export function isTimeoutError(msg) { return TIMEOUT_ERR_RE.test(String(msg ?? '')); }
const TURN_BUDGET_ERR_RE = /error_max_turns|reached maximum number of turns|max(?:imum)?[-_ ]turns?(?: budget)?(?: exceeded| exhausted)/i;
export function isTurnBudgetError(msg) { return TURN_BUDGET_ERR_RE.test(String(msg ?? '')); }

export function isCapabilityEscalationFailure(msg) {
  if (isProviderRateLimitError(msg)) return false;
  return !isEnvironmentalFailure({ is_error: 1, error_message: String(msg ?? '') });
}

/**
 * A thrown (non-timeout) dev/fix error is eligible for phase-23 escalation-
 * ladder conversion UNLESS it's on this explicit allowlist of genuinely
 * retry-pointless infrastructure errors — retrying on a higher model tier
 * can't fix a git pre-flight failure or a budget/billing-window exhaustion,
 * so both stay on today's heal → (if not healed) rethrow-to-finalize path
 * instead of being converted into an escalatable is_error result.
 *
 * @returns {boolean}
 */
export function isEscalationEligibleThrow(execErr) {
  if (execErr?.is_preflight_error) return false;
  if (classifyError(execErr).kind === ERROR_KINDS.BUDGET) return false;
  if (!isCapabilityEscalationFailure(execErr?.message)) return false;
  return true;
}

/**
 * Convert a thrown, unhealed, non-timeout dev/fix error into an is_error
 * RESULT so it can flow through the same escalation-ladder routing
 * (routeDevFailure / decideEscalationHop) that an is_error RESULT from
 * executeAction already gets. Without this, the catch block's rethrow killed
 * the run before the ladder ever saw the failure.
 *
 * Writes the phase-23 marker itself (via the single writeEscalationMarker
 * helper) because the downstream marker write in the caller's routing block
 * is gated on `failIsTimeout`, and executeAction's own is_error marker
 * writers (dev/fix-dev branches) never ran — the call threw before
 * executeAction could return. `_heal_already_tried` on the returned result
 * tells the caller to pass `healEnabled:false` into the next routeDevFailure
 * call so the converted failure doesn't route back to 'heal' a second time.
 *
 * @returns {Promise<{result:object, written:boolean, targetTier:string|null, failedTier:string}>}
 */
export async function convertThrowToEscalatableResult({ execErr, action, projectName, cfg, deps = {} }) {
  const writeMarkerFn = deps.writeEscalationMarker ?? writeEscalationMarker;
  const nowFn = deps.now ?? (() => new Date().toISOString());
  const result = {
    is_error: true,
    error_message: execErr.message,
    result: execErr.message,
    _heal_already_tried: true,
  };
  const failedTier = failedTierFromResult(result, cfg);
  const projDir = path.join(PROJECTS_DIR, projectName);
  const { written, targetTier } = await writeMarkerFn({
    projDir,
    phaseN: action.kind === 'fix-dev' ? null : action.phaseN,
    fix: action.kind === 'fix-dev' ? action.fix : null,
    failedTier,
    reason: `${action.kind === 'fix-dev' ? 'fix' : 'dev'} threw (heal failed): ${String(execErr.message || '').slice(0, 300)}`,
    at: nowFn(),
  }).catch(() => ({ written: false, targetTier: null }));
  return { result, written, targetTier, failedTier };
}

/**
 * Decide how to route a failed dev/fix-dev execution. Pure — no I/O — so the
 * auto-runner and its tests share one source of truth for the timeout-vs-heal
 * boundary.
 *
 * A TIMEOUT must NEVER be healed: error-classifier maps it to `phase-stuck`,
 * whose healer resets the phase and returns healed:true — which `continue`s the
 * run loop BEFORE auto-reprompt-on-timeout can fire, making the reprompt path
 * structurally unreachable. So timeouts route to reprompt (scoped retry on the
 * normal model, phases only) while attempts remain, then to Opus escalation
 * once exhausted. Operational (non-timeout) failures route to heal as before.
 *
 * @returns {'reprompt'|'escalate'|'heal'|'pause'}
 */
export function routeDevFailure({
  errMsg,
  actionKind,                  // 'dev' | 'fix-dev'
  repromptsDone = 0,
  maxReprompts = 2,
  repromptEnabled = true,
  escalateEnabled = true,
  escalateAlreadyTried = false,
  isTransient = false,
  healEnabled = true,
}) {
  // A provider window is not a recoverable network fault. Retrying or
  // escalating inside the same window adds failed calls without making
  // progress; unattended-retry will wait for resetsAt before resuming.
  if (isProviderRateLimitError(errMsg)) return 'pause';
  if (isTimeoutError(errMsg) || isTurnBudgetError(errMsg)) {
    // Phases get scoped reprompts (tighter prompt, same model) while budget
    // remains. Fixes have no reprompt flow → straight to escalation.
    if (actionKind === 'dev' && repromptEnabled && repromptsDone < maxReprompts) {
      return 'reprompt';
    }
    // A larger model cannot create wall-clock/turn headroom. Once a compact
    // same-tier reprompt is spent, pause for the durable recovery path rather
    // than burning Opus/Fable on the same environmental ceiling.
    return 'pause';
  }
  // Operational failure → heal first.
  if (healEnabled) return 'heal';
  // Heal disabled: transient external errors just pause (waiting won't help);
  // otherwise escalate up the ladder, then pause.
  if (!isTransient && escalateEnabled && !escalateAlreadyTried) return 'escalate';
  return 'pause';
}

/**
 * Decide whether to grant an in-run escalated retry for a failed dev/fix. Pure
 * — the caller owns the hop Map and passes the current `hopCount`; this fn
 * never mutates it. Governs three gates:
 *   1. escalation must be enabled,
 *   2. a target tier must exist (a top-rung/fable failure has none → pause),
 *   3. the per-escKey hop budget must remain (`hopCount < maxHops`),
 *   4. a hop to the fable tier is billing-gated — skipped unless the window
 *      state is 'ok', because fable is the priciest rung.
 *
 * @returns {{action:'grant'|'skip-billing'|'pause', hopCount?:number, state?:string, reason?:string}}
 */
export function decideEscalationHop({
  targetTier,
  hopCount = 0,
  maxHops = 2,
  escalateEnabled = true,
  cfg = {},
  deps = {},
}) {
  if (!escalateEnabled) return { action: 'pause', reason: 'escalation disabled' };
  if (targetTier == null) return { action: 'pause', reason: 'no target tier (top rung failed)' };
  if (hopCount >= maxHops) return { action: 'pause', reason: 'max escalation hops reached' };
  if (targetTier === 'fable') {
    const windowStatusFn = deps.windowStatus ?? windowStatus;
    const state = windowStatusFn(cfg)?.state;
    if (state !== 'ok') return { action: 'skip-billing', state };
  }
  return { action: 'grant', hopCount };
}

/**
 * Resolve the suggestions pass slot for an autoRun invocation.
 *
 * When slot is an explicit number (the CLI go/resume path already ran
 * resolveSuggestionSlot for the suggestGate preview), return it verbatim —
 * the cursor was already advanced; do NOT advance it again.
 *
 * When slot is null/undefined (job-runner, pipeline, nb:go — any unattended
 * surface), call resolveSuggestionSlot so the cursor is read, potentially
 * advanced, and the correct effectiveSlot is returned. This is what makes
 * multi-pass progression work on every surface, not just the CLI.
 */
export async function resolveAutoRunSlot(projectName, slotArg) {
  if (typeof slotArg === 'number') return slotArg;
  const projDir = path.join(PROJECTS_DIR, projectName);
  const { resolveSuggestionSlot, commitAdvance } = await import('./lib/suggestion-slot.js');
  const { effectiveSlot, pendingAdvance } = await resolveSuggestionSlot(
    projectName, projDir,
    { slotExplicit: false, slotParsed: null, advance: true },
  );
  if (pendingAdvance) await commitAdvance(projectName, pendingAdvance);
  return effectiveSlot;
}

export async function autoRun({ projectName, unattended = false, dryRun = false, brief = null, notifier = null, slot = null }) {
  const project = getProject(projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);

  // `paused` is an honest waiting state for recoverable provider/network/window
  // stops. Once a queued/manual resume actually starts, flip it back before any
  // phase work so dashboards and brief-chain never mistake a live run for idle.
  if (!dryRun && project.status === 'paused') setProjectStatus(projectName, 'in-progress');

  const resolvedSlot = await resolveAutoRunSlot(projectName, slot);

  const cfg = await resolveConfig({ project: projectName, task: 'dev-execution' });
  const ar = cfg.auto_run || {};
  const bc = cfg.bug_cycle || {};  // Phase 69 (brief 05 P4) — parallel fix-batch gates

  const workspaceDir = path.join(PROJECTS_DIR, projectName, cfg.paths?.workspace_subdir || 'workspace');
  const projDir = path.join(PROJECTS_DIR, projectName);
  const healer = new AutoHealer({ projectName, workspaceDir, cfg, notifier });

  await _acquireAutoRunMutex(projectName);

  printHeader({ projectName, unattended, dryRun, cfg });

  const runId = startAutoRun({ project: projectName, unattended: unattended ? 1 : 0 });
  recordRunEvent(runId, 'run-started', { project: projectName, unattended: !!unattended });

  // Phase 57 (P1, run_events timeline) — best-effort retention sweep, once per
  // run (auto-run preflight) — mirrors pruneOldCalls's shape but scoped to
  // this brand-new table, not the server-wide log-cleanup.js sweep. 0 disables.
  try {
    const retentionDays = cfg.cleanup?.run_events_retention_days ?? 90;
    if (retentionDays > 0) pruneOldRunEvents(retentionDays);
  } catch (err) {
    console.warn(chalk.yellow(`[run-events] retention sweep failed (non-fatal): ${err.message}`));
  }

  // notify_outbox had NO retention anywhere (only calls/run_events did): on a
  // host with no delivery transport it grew forever, and a later server start
  // would flood-deliver the stale backlog. Expire >24h pending, prune terminal.
  try {
    expireStaleOutbox(24);
    pruneOldNotifyOutbox(cfg.cleanup?.notify_outbox_retention_days ?? 30);
  } catch (err) {
    console.warn(chalk.yellow(`[notify-outbox] retention sweep failed (non-fatal): ${err.message}`));
  }

  // Compiler manifests and attempt/rollout telemetry follow the existing call
  // retention horizon. Artifact deletion is evidence-aware and best-effort;
  // it cannot block an unattended run.
  try {
    const retentionDays = cfg.cleanup?.calls_retention_days ?? 90;
    if (cfg.cleanup?.enabled !== false && retentionDays > 0) pruneOldContextCompilerTelemetry(retentionDays);
  } catch (err) {
    console.warn(chalk.yellow(`[context-compiler] retention sweep failed (non-fatal): ${err.message}`));
  }

  // Phase 63 (P7) — one best-effort pre-flight forecast line so the operator
  // sees "will pause at phase 9 / wait ~30m for full fit" BEFORE the run burns
  // half the 5h window. Deterministic, zero LLM; a hiccup just skips the line
  // (never blocks a run).
  try {
    console.log(chalk.dim(`  → ${renderForecastLine(await forecastRun(projectName))}`));
  } catch { /* advisory only */ }

  // Phase 50 — sweep worktrees a crashed verify/review/scout task left behind
  // before this run's loop starts. removeWorktree never throws, so this can't
  // block a run; a project with no .worktrees/ dir yet is a silent no-op.
  await sweepStaleWorktrees(projDir, workspaceDir);

  // Phase 68 (brief 05 P3) — orphan-lane sweep: a crashed parallel-wave run
  // leaves 'running' phase_lanes rows + lane worktrees/branches behind; reconcile
  // them to 'abandoned' and tear them down so a wave never inherits stale lanes.
  // GATED on max_parallel_phases>1 (P3 phase lanes) OR max_parallel_fixes>1
  // (Phase 69 / P4 fix lanes) so a serial (default) project makes ZERO
  // lane-manager calls — mode isolation. Best-effort — never blocks a run.
  if (ar.max_parallel_phases > 1 || bc.max_parallel_fixes > 1) {
    try {
      await sweepOrphanLanes({ projectName, workspaceDir, projDir, cfg });
    } catch (err) {
      console.warn(chalk.yellow(`[lane-sweep] orphan-lane sweep failed (non-fatal): ${err.message}`));
    }
  }

  // Phase 45 — per-run filesystem deny-rule sandbox re-merge. Every LIVE
  // project picks up the config-driven security.deny_rules on its NEXT run with
  // no regeneration/guide task needed: read-compare-maybe-write into
  // workspace/.claude/settings.json, writing only when the ruleset actually
  // changed so an already-sandboxed workspace stays byte- and mtime-identical
  // (never dirties the git tree the dev/heal preflight then checks). Best-effort
  // — a failure here must never block the run.
  try {
    const denyRules = Array.isArray(cfg.security?.deny_rules) ? cfg.security.deny_rules : [];
    const { settingsChanged } = await mergeWorkspaceDenyRules(workspaceDir, denyRules);
    if (settingsChanged) console.log(chalk.dim('  → Filesystem deny-rule sandbox: workspace/.claude/settings.json updated'));
  } catch (err) {
    console.warn(chalk.yellow(`[deny-sandbox] could not merge filesystem deny rules (non-fatal): ${err.message}`));
  }

  // Phase 56 (MI-5) — telemetry-learned routing floors. Read-only over the
  // calls table; rewrites routing-extension.json only when the learned floors
  // actually move. Best-effort — advisory work must never block a run.
  try {
    await applyTelemetryRoutingFloors({ cfg, projectName, projDir });
  } catch (err) {
    console.warn(chalk.yellow(`[routing-telemetry] could not apply learned floors (non-fatal): ${err.message}`));
  }

  // Surface a discussion brief that was accepted via the "Accept Brief Only"
  // gate (Phase 13). The conclusions are already in the brief; this go is what
  // the operator deferred to. Announce it once, then clear the flag.
  const pendingDiscId = getDiscussBriefPending(projectName);
  if (pendingDiscId) {
    console.log(chalk.cyan(`  [discuss] Picking up brief conclusions from discussion #${pendingDiscId} (deferred via "Accept Brief Only").`));
    void queueAndNotify({
      notifier, project: projectName,
      text: `📋 Picking up discussion #${pendingDiscId} conclusions — appended to the brief earlier and deferred for review. They are now in this run.`,
    });
    clearDiscussBriefPending(projectName);
  }

  // Circuit breaker for skip-analyze rewinds. Tracks how many times each phase
  // has been rewound in this run. Prevents the idempotency loop:
  //   rewind → phase runs → idempotency (same commit) → skip-analyze → rewind → …
  // Initialized here so both on_go_start and the periodic check share the same counter.
  const phaseRewindCount = new Map();
  const MAX_REWINDS_PER_PHASE = cfg.skip_analyze?.max_rewinds_per_phase ?? 2;

  // ── Pre-flight skip analysis (on_go_start) ───────────────────────────────
  // Runs once before the main loop on every go/resume. Catches gaps left by
  // prior interrupted runs — phases recorded as completed but missing commits
  // or expected files. Rewinds current_phase to the first gap so the loop
  // re-executes it before moving forward.
  const skipCfg = cfg.skip_analyze || {};
  if (skipCfg.enabled !== false && skipCfg.on_go_start !== false) {
    const freshProject = getProject(projectName);
    const completedPhaseNow = freshProject?.current_phase || 0;
    if (completedPhaseNow > 0) {
      const projDirPf = path.join(PROJECTS_DIR, projectName);
      const planPf    = await readJson(planJsonPath(projDirPf));
      if (planPf?.phases?.length) {
        const { hasGaps, gaps, firstMissing, checkedCount } = await analyzeSkippedPhases({
          projectName,
          plan:         planPf,
          workspaceDir,
          projDir:      projDirPf,
          completedPhase: completedPhaseNow,
          checks:       skipCfg.checks || {},
        });
        if (hasGaps) {
          const oldPipelineGaps = gaps.filter((g) => g.isOldPipeline);
          const fileOnlyGaps    = gaps.filter((g) => !g.isOldPipeline && g.onlyFileGap);
          const stateOnlyGaps   = gaps.filter((g) => !g.isOldPipeline && g.onlyStateGap);
          const rewindableGaps  = gaps.filter((g) => !g.isOldPipeline && !g.onlyFileGap && !g.onlyStateGap);

          if (oldPipelineGaps.length) {
            console.log(chalk.dim(`  ℹ Skip-analyze: ${oldPipelineGaps.length} old-pipeline phase(s) in gap (already in git, pre-date current plan):`));
            oldPipelineGaps.forEach((g) => console.log(chalk.dim(`    phase ${g.n}: ${g.issues[0]}`)));
          }
          // File-only gaps: commit is verified, files may have moved — warn, never rewind.
          if (fileOnlyGaps.length) {
            console.log(chalk.dim(`  ℹ Skip-analyze: ${fileOnlyGaps.length} file-check warning(s) — commit verified, not rewinding:`));
            fileOnlyGaps.forEach((g) => console.log(chalk.dim(`    phase ${g.n}: ${g.fileIssues?.join('; ') || g.issues.join('; ')}`)));
          }
          if (stateOnlyGaps.length) {
            console.log(chalk.dim(`  ℹ Skip-analyze: ${stateOnlyGaps.length} state-tracking warning(s) — completed work has no recorded SHA, not rewinding:`));
            stateOnlyGaps.forEach((g) => console.log(chalk.dim(`    phase ${g.n}: ${g.commitIssues?.join('; ') || g.issues.join('; ')}`)));
          }
          if (rewindableGaps.length && firstMissing !== null) {
            const priorRewinds = phaseRewindCount.get(firstMissing) || 0;
            if (priorRewinds >= MAX_REWINDS_PER_PHASE) {
              console.log(chalk.yellow(
                `  ⚠ Skip-analyze (go-start): phase ${firstMissing} has been rewound ${priorRewinds}× already — skipping rewind (needs manual review)`,
              ));
            } else {
              phaseRewindCount.set(firstMissing, priorRewinds + 1);
              console.log(chalk.yellow(`\n⚠ Skip-analyze (go-start): ${rewindableGaps.length} commit-level gap(s) in ${checkedCount} phases:`));
              rewindableGaps.forEach((g) =>
                console.log(chalk.yellow(`  • Phase ${g.n} (${g.title}): ${g.commitIssues?.join('; ') || g.issues.join('; ')}`)),
              );
              console.log(chalk.yellow(`  → Rewinding to phase ${firstMissing} — will re-run before continuing.\n`));
              setCurrentPhase(projectName, firstMissing - 1);
              upsertPhase({
                project: projectName,
                n:       firstMissing,
                title:   planPf.phases.find((p) => p.n === firstMissing)?.title || null,
                status:  'pending',
              });
            }
          } else if (!rewindableGaps.length) {
            console.log(chalk.green(`  ✓ Skip-analyze: ${checkedCount} phase(s) checked — no rewindable gaps\n`));
          }
        } else {
          console.log(chalk.green(`  ✓ Skip-analyze: ${checkedCount} completed phase(s) verified — no gaps\n`));
        }
      }
    }
  }

  // Brief drift notice — if live brief.md was updated after the plan's frozen
  // snapshot, tell the operator. Never blocks: current phases always use the
  // snapshot; the updated brief.md becomes the brief for the next plan.
  {
    const freshProjForDrift = getProject(projectName);
    if ((freshProjForDrift?.current_phase || 0) > 0) {
      const projDirDrift = path.join(PROJECTS_DIR, projectName);
      const planDrift = await readJson(planJsonPath(projDirDrift));
      if (planDrift?.brief_snapshot) {
        const drift = await checkBriefDrift(projDirDrift, planDrift);
        if (drift.updated) {
          console.log(chalk.cyan(
            `ℹ brief.md was updated after the plan was created.\n` +
            `  Current phases use the frozen snapshot (${drift.version}).\n` +
            `  Updated brief.md will be used for the next plan.`,
          ));
        }
      }
    }
  }

  let actionsThisRun = 0;
  const maxActions = ar.max_phases_per_run || 50;
  const runStartTime = Date.now();
  // Per-phase reprompt counter — tracks how many times we've auto-regenerated
  // a phase prompt after timeouts. Seeded lazily from run_events so the budget
  // survives run restarts: it used to be purely in-memory, and with the
  // watchdog auto-resuming phase-stuck pauses every restart granted a fresh
  // budget — a phase whose failure survives reprompting (unsatisfiable
  // criterion, always-hanging command) looped across runs forever.
  const phaseRepromptCount = new Map();
  const repromptsDoneFor = (phaseN) => {
    if (!phaseRepromptCount.has(phaseN)) {
      let persisted = 0;
      try { persisted = countPhaseRepromptsSincePlan(projectName, phaseN); } catch { /* fresh budget on read failure */ }
      phaseRepromptCount.set(phaseN, persisted);
    }
    return phaseRepromptCount.get(phaseN);
  };
  // v0.14.38 → phase-23: per-run escalation budget. Was a Set (one opus hop per
  // phase/fix); now a Map escKey → hopCount so the graduated ladder can grant up
  // to auto_run.max_escalation_hops tier-relative retries before pausing.
  const escalateHops = new Map();
  const maxEscalationHops = ar.max_escalation_hops ?? 2;

  // Phase 72 (brief P6, MI-8) — phases that already ran a speculative duo this
  // run: the duo consumes the phase's TERMINAL retry, so it fires AT MOST ONCE
  // per phase per run (no duo-of-duos). A win completes the phase; a loss pauses
  // the run — this Set is belt-and-suspenders against a re-pick either way.
  const duoAttempted = new Set();

  // Phase 68 (brief 05 P3) — phases a parallel wave already tried and that
  // failed/conflicted/gate-failed once: they run SERIALLY on their next pick
  // (through the existing reprompt/escalate/pause ladder) instead of being
  // re-waved. A phase completes at most once, so a completed phase left in this
  // set is harmless; abandoned later-lane phases are NOT added (they re-wave
  // once the problem phase resolves).
  const laneFallbackPhases = new Set();

  // Phase 69 (brief 05 P4) — fixes a parallel fix batch already tried and that
  // failed/conflicted/gate-failed once (keyed `r{round}-{n}`): they run SERIALLY
  // on their next pick (through the existing single-fix reprompt/escalate/park
  // ladder) instead of being re-batched. pickBugAction consults this set so the
  // failed fix collapses back to a classic fix-dev; a fix completes at most once,
  // so a stale key for an already-recorded fix is harmless.
  const laneFallbackFixes = new Set();

  // Phase 70 (brief 05 P5) — fixes a single-call minor-fix batch already tried
  // that errored/gate-failed/partially-reconciled once (keyed `r{round}-{n}`):
  // they run INDIVIDUALLY on their next pick instead of being re-batched.
  // pickBugAction consults this set the same way P4's laneFallbackFixes gates
  // fix-dev-batch; a fix completes at most once, so a stale key is harmless.
  const batchFallbackFixes = new Set();

  // Phase 51 (P1 async report-mode) — cap-1 outstanding background verify
  // slot: { promise, phaseN, label } | null. A successful dev action carrying
  // result.deferred_verify awaits the PREVIOUS slot (if any) before spawning
  // its own detached check, so at most one runs concurrently. Every guide
  // action (review/audit/bug-plan — they read verify.json + lessons) awaits
  // this barrier before dispatch, and finalize() awaits it on every terminal
  // path so a run never exits with an orphaned spawn.
  let pendingVerify = null;

  // Phase 52 (par-03, async mid-stream reviews) — cap-1 outstanding background
  // review slot: { promise, phaseN, action, state } | null. Only a mid-stream
  // review (never isFinalReview, and only when auto_run.async_reviews is on)
  // ever occupies this slot — the final review always stays fully
  // synchronous. `state.settled` lets the top of the loop peek without
  // blocking; `action` is the ORIGINAL review action (batch/reviewMode/
  // reviewNextConsecutiveLight) so settlement can replay the same
  // heal/auto-proceed/pause handling a synchronous review gets. finalize()
  // awaits it on every terminal path, same discipline as pendingVerify.
  let pendingReview = null;

  // Phase 52 (par-03) — the ONE consumption path for a settled/outstanding
  // pendingReview, shared by all three call sites that need it (top-of-loop
  // peek, the barrier before a non-review guide action, and the cap-1 await
  // before firing a second due review). Awaits the review's promise (never
  // rejects — see spawnDetachedReview), routes the result through the SAME
  // heal/consecutive-light/auto-proceed/pause handling a synchronous review
  // gets (settleReviewOutcome), and clears the slot. A 'healed-retry' verdict
  // undoes the actionsThisRun charge taken when the review was fired, mirroring
  // every other healed-transient-failure path in this file.
  const consumePendingReview = async () => {
    if (!pendingReview) return { pause: false };
    const settledReview = pendingReview;
    pendingReview = null;
    const settledResult = await settledReview.promise;
    const outcome = await settleReviewOutcome({
      result: settledResult, action: settledReview.action, cfg, unattended, projectName, workspaceDir, healer, project, runId,
    });
    if (outcome.mode === 'healed-retry') actionsThisRun -= 1;
    if (outcome.mode === 'pause') return { pause: true, reason: outcome.reason, pauseKind: outcome.pauseKind };
    return { pause: false };
  };

  // Session-level wake lock — keeps macOS awake for the entire auto-run.
  // No-op on Linux/NAS. Individual claude-runner calls also acquire; refcount
  // means the lock stays held throughout.
  wakePreventSleep();

  // SIGINT handler — Ctrl-C during a run finalizes as 'cancelled' and prints summary.
  let cancelled = false;
  const sigintHandler = () => {
    if (cancelled) {
      // Second Ctrl-C → forceful exit. Signal any subprocess that survived the first path.
      console.log(chalk.red('\nForce-quit.'));
      const killed = killAll({ reason: 'CLI Ctrl-C (force)' });
      if (killed > 0) console.log(chalk.dim(`  SIGTERM sent to ${killed} subprocess(es).`));
      process.exit(130);
    }
    cancelled = true;
    console.log(chalk.yellow('\n⏹  Cancelling… (Ctrl-C again to force-quit immediately)'));
    // Signal the in-flight claude subprocess immediately. detached:true means the
    // shell can no longer deliver SIGINT to it directly; we must do it explicitly.
    const killed = killAll({ reason: 'CLI Ctrl-C' });
    if (killed > 0) console.log(chalk.dim(`  SIGTERM sent to ${killed} subprocess(es).`));
    // The loop continues and calls finalize() once the subprocess exits.
  };
  if (!getWorkerContext()) {
    process.on('SIGINT', sigintHandler);
  }

  try {
    while (true) {
      if (cancelled) {
        return finalize({ runId, pendingVerify, pendingReview, notifier, status: 'cancelled', reason: 'user cancelled (SIGINT)', projectName, runStartTime });
      }

      // Phase 52 (par-03) — consume a settled background review at the TOP of
      // every iteration, before picking the next action. Replays the SAME
      // heal/auto-proceed/pause handling a synchronous review gets (see
      // settleReviewOutcome) against a review that finished while later
      // phases were dispatching. A still-pending review is left alone —
      // pickNextAction's pendingReviewPhaseN treats its phase as already
      // covered, so it returns the NEXT action instead of re-firing it.
      if (pendingReview && pendingReview.state.settled) {
        const consumed = await consumePendingReview();
        if (consumed.pause) {
          return finalize({ runId, pendingVerify, pendingReview, notifier, status: 'paused', reason: consumed.reason, pauseKind: consumed.pauseKind, projectName, runStartTime });
        }
        continue; // 'proceed' or 'healed-retry' — re-pick from the top
      }

      // FR19 — Auto-brief from raw-thoughts
      if (ar.raw_thoughts_auto_brief === true) {
        const projDir = path.join(PROJECTS_DIR, projectName);
        if (await shouldRunAutoBrief(projDir)) {
          console.log(chalk.cyan('▶ Auto-brief from raw-thoughts (step 0)'));
          actionsThisRun += 1;
          try {
            await runGuide({ projectName, task: 'brief-author' });
          } catch (err) {
            console.log(chalk.yellow(`⚠ Auto-brief failed: ${err.message} — continuing`));
          }
        }
      }

      if (actionsThisRun >= maxActions) {
        return finalize({ runId, pendingVerify, pendingReview, notifier, status: 'paused', reason: `max_phases_per_run (${maxActions}) hit`, pauseKind: PAUSE_KINDS.MAX_ACTIONS, projectName, runStartTime });
      }

      const action = await pickNextAction(projectName, cfg, {
        phaseRewindCount, maxRewindsPerPhase: MAX_REWINDS_PER_PHASE, pendingReviewPhaseN: pendingReview?.phaseN ?? null,
        laneFallbackFixes, batchFallbackFixes, notifier,
      });

      if (action.kind === 'done') {
        return finalize({ runId, pendingVerify, pendingReview, notifier, status: 'completed', reason: 'all work complete', projectName, runStartTime });
      }
      if (action.kind === 'wait-for-human') {
        // Runtime-QA gate (phase 89 / P5b) — the main-flow ready-for-qa transition
        // runs runtime-qa ONCE here, between the final review and the pause, for
        // every readyForQaTransition action (both pickNextAction all-phases-complete
        // sites AND the pickBugAction fix-round-complete site). The pick*Action site
        // DEFERS the flip in BOTH modes, so runtime-qa runs (and .guide/runtime-qa.json
        // lands) BEFORE the project ever reads ready-for-qa. Report mode (default) is
        // fail-open (gate never blocks) → we flip below. Gate mode (default-off) BLOCKS
        // on blockers (already promoted to the bug inbox) → we skip the flip and pause.
        if (action.readyForQaTransition) {
          const gate = await runReadyForQaRuntimeGate({ projectName, workspaceDir, cfg, notifier });
          if (gate.blocked) {
            return finalize({ runId, pendingVerify, pendingReview, notifier, status: 'paused', reason: gate.reason, pauseKind: PAUSE_KINDS.OTHER, projectName, runStartTime });
          }
          if (action.deferredReadyForQa) setProjectStatus(projectName, 'ready-for-qa');
        }
        const pauseKind = classifyPauseReason(action.reason);
        return finalize({ runId, pendingVerify, pendingReview, notifier, status: 'paused', reason: action.reason, pauseKind, projectName, runStartTime });
      }

      // Phase 51 (P1 async report-mode) — a guide action (review/audit/
      // bug-plan) reads verify.json + lessons, both of which the background
      // checker may still be writing. Settle-await the barrier before ANY
      // guide dispatch; dev/fix-dev actions never wait (they don't read
      // those artifacts).
      if (action.kind === 'guide' && pendingVerify) {
        await pendingVerify.promise;
        pendingVerify = null;
      }

      // Phase 52 (par-03) — a NON-review guide action (audit/bug-plan/plan/
      // lessons-distill/etc.) must not dispatch while a phase's review is
      // still in flight: it may read decisions.jsonl or the review file the
      // background review is still writing. A review action itself is
      // exempt from this barrier — pickNextAction's pendingReviewPhaseN
      // already treats the covered phase's review as satisfied, so the SAME
      // phase's review action is never returned here; a DIFFERENT phase's
      // review firing goes through its own cap-1 barrier at the fire site
      // below instead.
      if (action.kind === 'guide' && action.task !== 'review' && pendingReview) {
        const consumed = await consumePendingReview();
        if (consumed.pause) {
          return finalize({ runId, pendingVerify, pendingReview, notifier, status: 'paused', reason: consumed.reason, pauseKind: consumed.pauseKind, projectName, runStartTime });
        }
        continue; // re-pick — either retry the review or dispatch fresh with review state settled
      }

      const cumulative = formatRunElapsed(Date.now() - runStartTime);
      console.log(chalk.cyan(`\n▶ ${action.label}`) + chalk.dim(`   [run: ${cumulative}]`));
      if (action.warning) console.log(chalk.yellow(`   ⚠  ${action.warning}`));

      // v0.6: per-project budget check
      const { checkProjectBudget } = await import('./commands/budget-guard.js');
      const budgetCheck = checkProjectBudget(cfg, projectName);
      if (!budgetCheck.allowed) {
        return finalize({ runId, pendingVerify, pendingReview, notifier, status: 'paused', reason: `budget: ${budgetCheck.reason}. Bump max_total_calls in project.json or run with --ignore-budget.`, pauseKind: PAUSE_KINDS.BUDGET, projectName, runStartTime });
      }
      if (budgetCheck.cap !== null) {
        const pct = ((budgetCheck.current / budgetCheck.cap) * 100).toFixed(0);
        console.log(chalk.dim(`   Budget: ${budgetCheck.reason} (${pct}%)`));
      }

      if (dryRun) {
        console.log(chalk.dim('  (dry run — skipping execution)'));
        actionsThisRun += 1;
        if (actionsThisRun > 30) break;
        continue;
      }

      // Phase 79 (P2) — window-aware pause before a HEAVY next action. At 'warn'
      // with insufficient projected headroom for the next dev/audit call, pause
      // cleanly (pause_reason='window-headroom') and enqueue a resume job for the
      // projected window reset, instead of racing the pause threshold and dying
      // mid-phase. Cheap actions and 'ok'/'pause' windows are no-ops here (the
      // hard pause_at_calls stop still lives at spawn in claude-runner.js).
      const headroom = await maybePauseForWindowHeadroom({ cfg, projectName, action, runId });
      if (headroom.paused) {
        return finalize({ runId, pendingVerify, pendingReview, notifier, status: 'paused', reason: headroom.reason, pauseKind: headroom.pauseKind, projectName, runStartTime });
      }

      // Phase 52 (par-03) — mid-stream review, async_reviews opted in: fire
      // WITHOUT awaiting so phase N+1's dev can dispatch immediately instead
      // of blocking on this review's ~5-minute verdict. isFinalReview always
      // stays synchronous (falls through to the normal executeAction path
      // below) — it's the operator's one guaranteed full look before QA, and
      // must never overlap the phase it's reviewing with anything after it.
      if (action.kind === 'guide' && action.task === 'review' && !action.isFinalReview && ar.async_reviews === true) {
        if (pendingReview) {
          // Cap 1 outstanding — a second due review awaits (and settles) the
          // first before this one fires.
          const consumed = await consumePendingReview();
          if (consumed.pause) {
            return finalize({ runId, pendingVerify, pendingReview, notifier, status: 'paused', reason: consumed.reason, pauseKind: consumed.pauseKind, projectName, runStartTime });
          }
        }
        pendingReview = spawnDetachedReview({ cfg, projectName, projDir, workspaceDir, action, notifier });
        actionsThisRun += 1;
        if (ar.delay_between_calls_ms) await SLEEP(ar.delay_between_calls_ms);
        continue; // re-pick — pendingReviewPhaseN now covers this phase, so the next pick is phase N+1's dev
      }

      // Phase 68 (brief 05 P3) — parallel phase wave. A plain 'dev' action with
      // parallelism enabled MAY fan out into a wave of independent ready phases
      // (the guide next-prompt above already ran serially — the guide session is
      // singular, never parallelized). Mode isolation: max_parallel_phases:1
      // (default) short-circuits here so selectPhaseWave / the lane manager are
      // never touched and the serial path below runs unchanged. A phase that
      // already fell back from a lane failure/conflict runs serially this time
      // (laneFallbackPhases) so it goes through the existing reprompt/escalate/
      // pause ladder, not another wave.
      if (action.kind === 'dev' && ar.max_parallel_phases > 1 && !laneFallbackPhases.has(action.phaseN)) {
        const wavePlan = await computeDevWave({ projectName, cfg, projDir, action });
        if (wavePlan.wave.length > 1) {
          const outcome = await runPhaseWave({
            projectName, cfg, projDir, workspaceDir, wave: wavePlan.wave, runId, notifier,
          });
          actionsThisRun += outcome.actions;
          for (const n of outcome.serialFallback) laneFallbackPhases.add(n);
          // Evaluate operator checkpoints for the wave's highest merged phase —
          // the serial evaluatePause below is bypassed by this branch's continue.
          const wp = await evaluateParallelPause({ kind: 'dev', cfg, unattended, projDir, mergedPhases: outcome.mergedPhases });
          if (wp.pause) {
            return finalize({ runId, pendingVerify, pendingReview, notifier, status: 'paused', reason: wp.reason, pauseKind: classifyPauseReason(wp.reason), projectName, runStartTime });
          }
          if (ar.delay_between_calls_ms) await SLEEP(ar.delay_between_calls_ms);
          continue; // re-pick — merged phases advanced current_phase; failures re-run serially
        }
      }

      // Phase 69 (brief 05 P4) — parallel independent fix batch. pickBugAction
      // returned a fix-dev-batch (bug_cycle.max_parallel_fixes>1, a consecutive
      // file-disjoint prefix of pending fixes). Run each fix in its own lane, merge
      // ascending, recordFixCompletion per merged lane IN ORDER, stop+abandon at
      // the first failure. The head fix of any batch pickBugAction emits is NEVER
      // one that already fell back to serial (pickBugAction collapses those to a
      // classic fix-dev via laneFallbackFixes), so this branch only ever sees
      // genuine batches. Mode isolation: with the default max_parallel_fixes of 1
      // pickBugAction never emits this kind, so runFixBatch is unreachable.
      if (action.kind === 'fix-dev-batch') {
        const outcome = await runFixBatch({
          projectName, cfg, projDir, workspaceDir, round: action.round, fixes: action.fixes, runId, notifier,
        });
        actionsThisRun += outcome.actions;
        for (const key of outcome.serialFallback) laneFallbackFixes.add(key);
        // Evaluate 'fix-completed' checkpoints — this branch's continue bypasses
        // the serial evaluatePause below.
        const fbp = await evaluateParallelPause({ kind: 'fix', cfg, unattended, projDir, projectName, round: action.round });
        if (fbp.pause) {
          return finalize({ runId, pendingVerify, pendingReview, notifier, status: 'paused', reason: fbp.reason, pauseKind: classifyPauseReason(fbp.reason), projectName, runStartTime });
        }
        if (ar.delay_between_calls_ms) await SLEEP(ar.delay_between_calls_ms);
        continue; // re-pick — recorded fixes advanced fixes_completed; failures re-run serially
      }

      // Phase 70 (brief 05 P5) — single-call batch of consecutive MINOR fixes.
      // pickBugAction returned fix-dev-single-call-batch (bug_cycle.
      // max_parallel_fixes===1, bug_cycle.batch_minor_fixes on, a consecutive
      // minor-severity, file-disjoint prefix). ONE dev spawn commits every fix
      // in the batch; runFixSingleCallBatch owns the merged-HEAD gate,
      // reconciliation, and the aheadBehind-guarded rollback-or-fall-through
      // failure story. Mode isolation: with the shipped defaults
      // (max_parallel_fixes:1, batch_minor_fixes:false) this kind is never
      // emitted, so runFixSingleCallBatch is unreachable.
      if (action.kind === 'fix-dev-single-call-batch') {
        const outcome = await runFixSingleCallBatch({
          projectName, cfg, projDir, workspaceDir, round: action.round, fixes: action.fixes, runId, notifier,
        });
        actionsThisRun += outcome.actions;
        for (const key of outcome.batchFallback) batchFallbackFixes.add(key);
        // Evaluate 'fix-completed' checkpoints — this branch's continue bypasses
        // the serial evaluatePause below.
        const scbp = await evaluateParallelPause({ kind: 'fix', cfg, unattended, projDir, projectName, round: action.round });
        if (scbp.pause) {
          return finalize({ runId, pendingVerify, pendingReview, notifier, status: 'paused', reason: scbp.reason, pauseKind: classifyPauseReason(scbp.reason), projectName, runStartTime });
        }
        if (ar.delay_between_calls_ms) await SLEEP(ar.delay_between_calls_ms);
        continue; // re-pick — recorded fixes advanced fixes_completed; failures re-run individually
      }

      // Inner try-catch so healing can `continue` the loop for errors thrown
      // from executeAction (e.g. git pre-flight failures, network throws).
      // Phase 55 (P8, speculative scout / par-08): a scout-eligible 'dev'
      // action fires spawnPhaseScout CONCURRENTLY with executeAction
      // (Promise.allSettled) — the scout's own settlement is only ever
      // logged, never allowed to affect `result` or the catch block below.
      let result;
      let scoutSettled = null;
      const scoutEligibility = action.kind === 'dev'
        ? await resolveScoutEligibility({ cfg, projDir, workspaceDir, action })
        : null;
      try {
        if (scoutEligibility) {
          const [devSettled, scoutSettledResult] = await Promise.allSettled([
            executeAction(action, { projectName, brief, cfg, notifier, slot: resolvedSlot, runId }),
            spawnPhaseScout({ cfg, projectName, projDir, workspaceDir, ...scoutEligibility }),
          ]);
          scoutSettled = scoutSettledResult;
          if (devSettled.status === 'rejected') throw devSettled.reason;
          result = devSettled.value;
        } else {
          result = await executeAction(action, { projectName, brief, cfg, notifier, slot: resolvedSlot, runId });
        }
      } catch (execErr) {
        if (cancelled) {
          return finalize({ runId, pendingVerify, pendingReview, notifier, status: 'cancelled', reason: 'user cancelled (SIGINT)', projectName, runStartTime });
        }
        // The local rolling-window guard is an intentional, timed pause — not
        // a failed phase. Its runner error carries resetsAt, allowing the
        // brief-chain / launch wrapper / watchdog to resume without a human
        // once capacity returns. Never send this to an auto-healer or an
        // escalation ladder: neither can create Max-plan headroom.
        if (classifyError(execErr).kind === ERROR_KINDS.BUDGET) {
          return finalize({
            runId, pendingVerify, pendingReview, notifier,
            status: 'paused', reason: execErr.message,
            pauseKind: PAUSE_KINDS.BUDGET, projectName, runStartTime,
          });
        }
        // A dev/fix TIMEOUT that exhausted runClaude's own retries throws here.
        // It must NOT be healed — error-classifier maps it to phase-stuck, whose
        // healer resets the phase and returns healed:true, short-circuiting the
        // loop before auto-reprompt-on-timeout can run. Surface it as an
        // is_error result instead so the timeout routing below (reprompt → Opus
        // escalation) handles it. Non-timeout throws (git pre-flight, network)
        // still go to the healer exactly as before.
        const isDevFail = action.kind === 'dev' || action.kind === 'fix-dev';
        const providerRateLimited = isProviderRateLimitError(execErr.message);
        if ((isDevFail && isTimeoutError(execErr.message)) || providerRateLimited) {
          result = { is_error: true, error_message: execErr.message, result: execErr.message };
        } else {
          const heal = await healer.heal(execErr, { action, projectName, workspaceDir, branch: project.git_branch });
          recordRunEvent(runId, 'heal-attempt', { project: projectName, phase: action.phaseN ?? null, healed: heal.healed });
          if (heal.healed) { actionsThisRun += 1; continue; }
          // phase-24: a thrown (non-timeout) dev/fix operational failure that
          // heal couldn't resolve used to rethrow here and kill the run — the
          // is_error ladder below only ever saw RESULTS, never THROWS. Convert
          // it into an is_error result (marker written by the helper itself)
          // so it flows into the same routeDevFailure/decideEscalationHop
          // ladder as any other dev/fix failure. Retry-pointless infra throws
          // (git pre-flight, budget exhaustion) are excluded and still rethrow
          // to finalize exactly as before.
          if (isDevFail && isEscalationEligibleThrow(execErr)) {
            const converted = await convertThrowToEscalatableResult({ execErr, action, projectName, cfg });
            result = converted.result;
            const key = action.kind === 'fix-dev' ? `fix r${action.fix.round}-${action.fix.n}` : `phase ${action.phaseN}`;
            if (converted.written) console.log(chalk.dim(`  → Escalation marker set: ${key} re-runs on ${converted.targetTier} (threw, heal failed)`));
            else console.log(chalk.dim(`  → ${key} threw on top tier (${converted.failedTier}) — no escalation marker (will pause)`));
          } else {
            throw execErr; // escalate to outer catch → finalize(failed)
          }
        }
      }
      actionsThisRun += 1;

      // Phase 55 (P8, speculative scout): spawnPhaseScout never rejects by
      // construction, but tolerate one defensively — advisory work must never
      // affect the dev result already captured above.
      if (scoutSettled?.status === 'rejected') {
        console.log(chalk.dim(`[phase-scout] unexpected rejection: ${scoutSettled.reason?.message || scoutSettled.reason}`));
      }

      // Phase 51 (P1 async report-mode) — a successful dev action carrying
      // result.deferred_verify (runDev's shouldDeferAcceptanceCheck decided
      // to defer) hands off to a detached background check here. Cap-1
      // outstanding: await whatever is already in flight before firing the
      // next one — never spawn a second concurrent background check.
      if (!result.is_error && result.deferred_verify) {
        if (pendingVerify) await pendingVerify.promise;
        pendingVerify = spawnDetachedVerify({
          cfg, projectName, projDir, workspaceDir, job: result.deferred_verify, notifier, runId,
        });
      }

      // Auto-heal transient GUIDE failures (network, git, orchestrator-bug)
      // before pausing. Dev/fix failures are routed separately below so a
      // TIMEOUT is never sent to the healer (see routeDevFailure).
      if (result.is_error && action.kind !== 'dev' && action.kind !== 'fix-dev'
          && cfg.auto_heal?.enabled !== false) {
        const guideErr = new Error(result.result || 'guide execution failed');
        guideErr._phase = action.phaseN;
        if (isProviderRateLimitError(guideErr.message)) {
          console.log(chalk.yellow('⚠ Provider rate limit — pausing without an in-window heal retry.'));
        } else {
          const heal = await healer.heal(guideErr, { action, projectName, workspaceDir, branch: project.git_branch });
          recordRunEvent(runId, 'heal-attempt', { project: projectName, phase: action.phaseN ?? null, healed: heal.healed });
          if (heal.healed) { actionsThisRun -= 1; continue; } // retry
        }
      }

      // ── Unified dev/fix failure routing (phase-8) ───────────────────────────
      // ONE decision point (routeDevFailure) governs the whole chain so a
      // TIMEOUT can never slip into the healer. The flow it produces:
      //   timeout/turn exhaustion → scoped same-tier reprompt once → durable
      //   pause/recovery (never model escalation for an environmental ceiling).
      //   operational failure → heal → (if not healed) Opus escalation → pause
      //   → fixes may park on a double failure (on_double_failure: 'skip').
      if (result.is_error && (action.kind === 'dev' || action.kind === 'fix-dev')) {
        const projDir = path.join(PROJECTS_DIR, projectName);
        const failMsg = typeof result.result === 'string' ? result.result : (result.error_message || '');
        const escKey = action.kind === 'dev' ? `phase-${action.phaseN}` : `fix-r${action.fix.round}-${action.fix.n}`;
        const failIsTimeout = isTimeoutError(failMsg);
        const failIsTurnBudget = isTurnBudgetError(failMsg);
        const failIsTransient = isTransientError(failMsg);
        const failIsCapability = isCapabilityEscalationFailure(failMsg);
        const maxReprompts = ar.max_auto_reprompt_attempts ?? 1;
        // Graduated-ladder state (phase-23). The failed tier drives the next
        // rung; the per-escKey hop count bounds how many escalated retries this
        // run grants. routeDevFailure stays pure — escalateAlreadyTried is the
        // hop budget computed here at the call site.
        const escFailedTier = failedTierFromResult(result, cfg);
        const escTargetTier = nextTier(escFailedTier);
        const escHopCount = escalateHops.get(escKey) || 0;
        const route = routeDevFailure({
          errMsg: failMsg,
          actionKind: action.kind,
          repromptsDone: repromptsDoneFor(action.phaseN),
          maxReprompts,
          repromptEnabled: ar.auto_reprompt_on_timeout !== false,
          escalateEnabled: ar.auto_escalate_on_failure !== false,
          escalateAlreadyTried: escHopCount >= maxEscalationHops,
          isTransient: failIsTransient,
          // phase-24: a converted throw already ran the healer once (in the
          // catch block above) and failed — never send it to routeDevFailure's
          // 'heal' route a second time. With healEnabled forced false here, a
          // non-transient converted failure routes 'escalate' and a transient
          // one routes 'pause' — both correct, neither re-heals.
          healEnabled: cfg.auto_heal?.enabled !== false && !result._heal_already_tried,
        });

        // Shared by the capability-double-failure park (3) and the
        // turn-budget/timeout park (3b): record the fix as handled, note it in
        // parked.md, and let the round advance.
        const parkFailedFix = async (f, why) => {
          try {
            const parkedPath = path.join(projDir, '.guide', 'bug-rounds', `round-${f.round}`, 'parked.md');
            await fs.appendFile(parkedPath,
              `- fix r${f.round}-${f.n} (${f.title || 'untitled'}) parked after ${why} at ${new Date().toISOString()}: ${failMsg.toString().slice(0, 200)}\n`,
              'utf-8');
          } catch { /* non-fatal */ }
          recordFixCompletion({ project: projectName, round: f.round, fixN: f.n });
          recordRunEvent(runId, 'fix-parked', { project: projectName, phase: f.n, round: f.round });
          console.log(chalk.yellow(`⏭ fix r${f.round}-${f.n} PARKED after ${why} (on_double_failure: skip) — continuing round`));
          await queueAndNotify({
            notifier, project: projectName,
            text: `⏭ fix r${f.round}-${f.n} parked after ${why} — round continues (see parked.md)`,
          });
        };

        // (0) Reprompt budget exhausted across runs and the phase STILL fails
        //     on a timeout/turn ceiling: pause terminally (kind
        //     reprompt-exhausted — the watchdog refuses to resume it). Without
        //     this, the pause reason classified phase-stuck, the watchdog
        //     resumed it, the fresh run granted a fresh in-memory budget, and
        //     the same phase looped for hours (aoa 134: 8 attempts, ~5h).
        if (route === 'pause' && action.kind === 'dev' && (failIsTimeout || failIsTurnBudget)
            && repromptsDoneFor(action.phaseN) >= maxReprompts) {
          const reason = `phase ${action.phaseN} reprompt budget exhausted (${repromptsDoneFor(action.phaseN)}/${maxReprompts} across runs) and it still fails: ${failMsg.split('\n')[0].slice(0, 200)} — operator action needed (fix the underlying blocker, amend the phase's criteria, or reset the phase).`;
          await queueAndNotify({
            notifier, project: projectName,
            text: `🔴 ${projectName} phase ${action.phaseN} paused for the operator — reprompt budget exhausted and it still fails the same way. See run pause reason.`,
          });
          return finalize({ runId, pendingVerify, pendingReview, notifier, status: 'paused', reason, pauseKind: PAUSE_KINDS.REPROMPT_EXHAUSTED, projectName, runStartTime });
        }

        // (1) Operational failure → heal. On success, retry the same phase/fix;
        //     on failure fall through to the Opus escalation below (its marker
        //     was already written by executeAction for an is_error result, or
        //     by convertThrowToEscalatableResult for a converted throw).
        if (route === 'heal') {
          const phaseErr = new Error(result.result || 'phase execution failed');
          phaseErr._phase = action.phaseN;
          const heal = await healer.heal(phaseErr, { action, projectName, workspaceDir, branch: project.git_branch });
          recordRunEvent(runId, 'heal-attempt', { project: projectName, phase: action.phaseN ?? null, healed: heal.healed });
          if (heal.healed) { actionsThisRun -= 1; continue; }
        }

        // (2) Timeout/turn exhaustion with reprompt budget left → delete the prompt and let the
        //     guide regenerate a tighter one (normal model — NO Opus marker
        //     yet). A hint file tells the guide why it's regenerating.
        if (route === 'reprompt') {
          const repromptsDone = repromptsDoneFor(action.phaseN);
          phaseRepromptCount.set(action.phaseN, repromptsDone + 1);
          const promptFile = await phasePromptPath(projDir, action.phaseN, action.phaseTitle);
          const hintFile = path.join(projDir, '.guide', `phase-${action.phaseN}-reprompt.hint`);
          const hintText = [
            `## Reprompt context (auto-generated — attempt ${repromptsDone + 1}/${maxReprompts})`,
            ``,
            `The previous execution of phase ${action.phaseN} ${failIsTurnBudget ? 'exhausted its turn/context budget' : 'timed out'}.`,
            `Error: ${failMsg.split('\n')[0]}`,
            ``,
            `When regenerating this phase prompt, please:`,
            `- Break the work into smaller, concrete steps`,
            `- Avoid asking the agent to read many files upfront — focus on the minimum needed`,
            `- Prefer targeted edits over large rewrites`,
            ...(failIsTimeout ? [`- Add explicit bash timeouts to any long-running commands (e.g. \`timeout 60s ...\`)`] : []),
          ].join('\n');
          try {
            await fs.mkdir(path.dirname(hintFile), { recursive: true });
            await fs.writeFile(hintFile, hintText, 'utf-8');
          } catch { /* non-fatal */ }
          recordLesson(projDir, { kind: 'reprompt', phase: action.phaseN, source: 'auto-runner:reprompt', lesson: failMsg, files: await lessonFilesForAction(projDir, action) }, cfg);
          recordRunEvent(runId, 'reprompt', { project: projectName, phase: action.phaseN, attempt: repromptsDone + 1 });
          try { await fs.unlink(promptFile); } catch { /* might not exist */ }
          // Reset phase to pending so pickNextAction goes through guide → dev.
          upsertPhase({ project: projectName, n: action.phaseN, title: action.phaseTitle || null, status: 'pending' });
          console.log(chalk.yellow(
            `⟳ Phase ${action.phaseN} ${failIsTurnBudget ? 'exhausted turns/context' : 'timed out'} — auto-reprompt ${repromptsDone + 1}/${maxReprompts} (prompt deleted, guide will regenerate)`,
          ));
          if (ar.delay_between_calls_ms) await SLEEP(ar.delay_between_calls_ms);
          continue; // skip evaluatePause — loop back to pickNextAction
        }

        // (3) Ladder escalation: only a capability failure, or an operational
        //     failure that healing proved was not environmental. Up to
        //     max_escalation_hops tier-relative retries per phase/fix per run;
        //     then pause (or park a fix). A hop to fable is billing-gated.
        if (route === 'escalate' || (route === 'heal' && failIsCapability)) {
          // A timeout threw, so executeAction never wrote the escalate marker
          // (and its reprompts ran on the normal model). Write it now — through
          // the single helper — so the re-run routes to the next rung.
          // Operational failures already have the marker (written by executeAction
          // for an is_error result, or by convertThrowToEscalatableResult above
          // for a converted throw).
          const hopDecision = decideEscalationHop({
            targetTier: escTargetTier,
            hopCount: escHopCount,
            maxHops: maxEscalationHops,
            escalateEnabled: ar.auto_escalate_on_failure !== false,
            cfg,
          });
          if (hopDecision.action === 'grant') {
            escalateHops.set(escKey, escHopCount + 1);
            recordRunEvent(runId, 'escalated', { project: projectName, phase: action.kind === 'fix-dev' ? (action.fix?.n ?? null) : action.phaseN, targetTier: escTargetTier, hop: escHopCount + 1 });
            console.log(chalk.yellow(
              `⟳ ${escKey} failed capability verification — in-run auto-retry on ${escTargetTier} (hop ${escHopCount + 1}/${maxEscalationHops}; marker set)`,
            ));
            if (ar.delay_between_calls_ms) await SLEEP(ar.delay_between_calls_ms);
            continue; // skip evaluatePause — loop re-picks the same phase/fix
          }
          if (hopDecision.action === 'skip-billing') {
            console.log(chalk.yellow(`⚠ escalation to fable skipped — billing window state '${hopDecision.state}'`));
          }
          // Hops exhausted / escalation disabled / fable billing-gated. For
          // FIXES with on_double_failure:'skip', park the fix and keep the round
          // moving; phases are NEVER skipped (phase N+1 builds on N). Transient
          // external errors and timeouts are not parked — they fall to pause.
          if (failIsCapability && !failIsTransient && action.kind === 'fix-dev' && ar.on_double_failure === 'skip') {
            await parkFailedFix(action.fix, 'double failure');
            if (ar.delay_between_calls_ms) await SLEEP(ar.delay_between_calls_ms);
            continue; // skip evaluatePause — round advances to the next fix
          }
        }

        // (3b) A fix that exhausted its wall clock or turn budget has no
        //     reprompt flow (reprompts are phase-only) and a bigger model
        //     can't buy turn headroom — routeDevFailure sends it to 'pause',
        //     which used to strand the entire night on one over-budget fix.
        //     With on_double_failure:'skip' it parks like a capability double
        //     failure and the round keeps moving.
        if (route === 'pause' && (failIsTimeout || failIsTurnBudget) && !failIsTransient
            && action.kind === 'fix-dev' && ar.on_double_failure === 'skip') {
          await parkFailedFix(action.fix, failIsTurnBudget ? 'turn-budget exhaustion' : 'timeout');
          if (ar.delay_between_calls_ms) await SLEEP(ar.delay_between_calls_ms);
          continue; // skip evaluatePause — round advances to the next fix
        }

        // Phase 72 (brief P6, MI-8) — speculative opus+fable duo: the LAST
        // resort before pausing a force_tier-critical PHASE that has burned its
        // attempt AND its escalation ladder. Reaching here (no reprompt / grant
        // / park `continue` fired) means a dev is_error is about to pause. Gated,
        // in order, on: opt-in flag (so with it OFF zero duo code — not even the
        // plan read / routeModel below — runs) → a PHASE, never a fix → routing
        // matched a force_tier keyword rule → window headroom for the 4 calls
        // (2 legs + 2 judges). A transient external failure is excluded (a rate
        // limit / network blip won't be fixed by re-running the model). Any miss
        // falls through to the normal pause below.
        if (action.kind === 'dev' && failIsCapability && !failIsTransient && !duoAttempted.has(action.phaseN)
            && ar.speculative_duo_on_double_failure === true) {
          const duoPlan = await readJson(planJsonPath(projDir));
          const duoPhaseMeta = (duoPlan?.phases || []).find((p) => p.n === action.phaseN) || null;
          const duoRouting = await routeModel({ cfg, task: 'dev-execution', phaseMeta: duoPhaseMeta, projectName });
          const elig = isDuoEligible({
            cfg, action, isForceTier: routingMatchedForceTier(duoRouting), windowStatus: windowStatus(cfg),
          });
          if (elig.eligible) {
            duoAttempted.add(action.phaseN); // consumes the phase's terminal retry — once per run
            const duo = await runSpeculativeDuo({
              projectName, cfg, projDir, workspaceDir, phaseN: action.phaseN,
              phaseTitle: action.phaseTitle, phaseMeta: duoPhaseMeta, runId, notifier,
            });
            if (duo.outcome === 'merged') {
              await queueAndNotify({
                notifier, project: projectName,
                text: `🏁 phase ${action.phaseN} recovered by speculative duo — ${duo.winner.tier} won (${duo.reason})`,
              });
              actionsThisRun += duo.actions;
              if (ar.delay_between_calls_ms) await SLEEP(ar.delay_between_calls_ms);
              continue; // phase complete via duo winner — skip evaluatePause, loop on
            }
            // both-fail / gate-fail / aborted → fall through to the normal pause.
            await queueAndNotify({
              notifier, project: projectName,
              text: `⏸ speculative duo for phase ${action.phaseN} did not win (${duo.outcome}: ${duo.reason}) — pausing for human`,
            });
          } else {
            console.log(chalk.dim(`  → Speculative duo not eligible for phase ${action.phaseN}: ${elig.reason}`));
          }
        }
      }

      // Phase 35 — persist the consecutive-light-review streak counter AFTER a
      // successful review call, never at pickNextAction decision time (which
      // may be probed without executing, e.g. predict/dashboard polling — a
      // dry read must never bump persisted state). force_full_every_n's
      // load-bearing guard depends on this being accurate.
      if (action.kind === 'guide' && action.task === 'review' && !result.is_error
          && typeof action.reviewNextConsecutiveLight === 'number') {
        setProjectMetadataField(projectName, 'consecutive_light_reviews', action.reviewNextConsecutiveLight);
      }

      // FR18 — Review auto-proceed
      if (action.kind === 'guide' && action.task === 'review' && !result.is_error) {
        const projDir = path.join(PROJECTS_DIR, projectName);
        if (await tryReviewAutoProceed({ action, cfg, projDir, projectName, runId })) {
          if (ar.delay_between_calls_ms) await SLEEP(ar.delay_between_calls_ms);
          continue; // skip evaluatePause — no pause for this review
        }
      }

      // Post-completion audit bookkeeping — increment counter and auto-proceed
      // so consecutive audit passes run without a manual checkpoint between them.
      if (action.isCompletionAudit && !result.is_error) {
        incrementAuditRunsCompleted(projectName);
        recordRunEvent(runId, 'audit-completed', { project: projectName });
        if (ar.delay_between_calls_ms) await SLEEP(ar.delay_between_calls_ms);
        continue; // skip evaluatePause between audit passes
      }

      // FR20 — Auto-promote unpromoted audit findings (file-based; runs after any action)
      // Only promotes audits produced during this run (mtime >= runStartTime) to prevent
      // sweeping in deliberately-untriaged audits from previous sessions.
      if (!result.is_error && ar.auto_promote_audit_bugs === true) {
        const projDir = path.join(PROJECTS_DIR, projectName);
        const latestAudit = await findMostRecentAudit(projDir);
        if (latestAudit && await shouldAutoPromoteAudit({ latestAudit, runStartMs: runStartTime })) {
          const sentinel = path.join(auditDir(projDir), `.promoted-${path.basename(latestAudit)}`);
          if (!(await fileExists(sentinel))) {
            const promoteResult = await maybeAutoPromoteAudit({ projDir, projectName });
            if (promoteResult?.promoted) {
              recordRunEvent(runId, 'bugs-promoted', { project: projectName, round: promoteResult.round, count: promoteResult.findings_count ?? null });
              // Phase 60 (P4): best-effort — the bug_rounds row for this round
              // usually doesn't exist yet (created later by the bridging
              // startBugRound call below, once the fix plan lands); a no-op
              // here in that case is expected, not a bug — that later call
              // re-derives and sets the same found_count independently.
              setBugRoundFoundCount(projectName, promoteResult.round, promoteResult.findings_count ?? null);
            }
            // Phase 43 (P7): a convergence stall means this round's bugs.md was
            // written (findings are real) but the SAME finding(s) already ran a
            // full fix round unchanged — pause here rather than let the next
            // pickNextAction spin fixes against an approach that isn't landing.
            if (promoteResult?.convergence_stall) {
              const reason = formatConvergenceStallReason(promoteResult.recurring, projectName);
              return finalize({ runId, pendingVerify, pendingReview, notifier, status: 'paused', reason, pauseKind: PAUSE_KINDS.CONVERGENCE_STALL, projectName, runStartTime });
            }
          }
        }
      }

      const pause = evaluatePause({ action, result, cfg, unattended });
      if (pause.pause) {
        const pauseKind = classifyPauseReason(pause.reason);
        return finalize({ runId, pendingVerify, pendingReview, notifier, status: 'paused', reason: pause.reason, pauseKind, projectName, runStartTime });
      }

      if (ar.delay_between_calls_ms) await SLEEP(ar.delay_between_calls_ms);
    }
  } catch (err) {
    if (cancelled) {
      return finalize({ runId, pendingVerify, pendingReview, notifier, status: 'cancelled', reason: 'user cancelled (SIGINT)', projectName, runStartTime });
    }
    // Provider rate/session limits that escape the inner handlers are not
    // failures: finalize as paused so the 'paused' branch below persists a
    // durable resume job at the parsed reset time. Ending them 'failed' (and
    // burning a doomed heal attempt first) strands the run until a human
    // notices — 40 runs died this way Jul 2–13.
    if (isProviderRateLimitError(err.message)) {
      return finalize({
        runId, pendingVerify, pendingReview, notifier, status: 'paused',
        reason: err.message, pauseKind: classifyPauseReason(err.message),
        projectName, runStartTime,
      });
    }
    // Outer catch — covers errors that escaped the inner try or the loop setup.
    // For orchestrator bugs, self-heal-agent patches the src/ file on disk,
    // commits, and pushes. We then persist a fresh `resume` queue job so the
    // fixed code is loaded by a supervised worker — the current process had
    // the bug in memory and must not continue inline.
    if (cfg?.auto_heal?.enabled !== false) {
      const heal = await healer.heal(err, { projectName }).catch(() => ({ healed: false }));
      // Self-heal gate could not reach an operator (no notifier reachable / no
      // TTY): it wrote a pending log and asked us to pause for human review
      // rather than fail. The reason names the log file.
      if (heal.paused) {
        return finalize({ runId, pendingVerify, pendingReview, notifier, status: 'paused', reason: heal.reason, pauseKind: PAUSE_KINDS.OTHER, projectName, runStartTime });
      }
      if (heal.healed) {
        console.log(chalk.green(`  ✓ auto-heal: ${heal.reason}`));
        const queued = enqueueUniqueResumeJob({
          project: projectName,
          args: { unattended: true },
          requestedBy: null,
          // The running_jobs mutex is released as this autoRun unwinds; a small
          // durable delay also prevents another worker from racing finalize().
          notBefore: new Date(Date.now() + 5_000),
        });
        console.log(chalk.dim(
          `  ${queued.scheduled ? `Queued fresh resume job #${queued.jobId}` : `Resume already queued as job #${queued.jobId}`} — continuing development.`,
        ));
        return finalize({
          runId, pendingVerify, pendingReview, notifier, status: 'paused',
          reason: `auto-healed: ${heal.reason}; resume job #${queued.jobId} scheduled`,
          projectName, runStartTime,
        });
      }
    }
    return finalize({ runId, pendingVerify, pendingReview, notifier, status: 'failed', reason: err.message, projectName, runStartTime });
  } finally {
    wakeAllowSleep();
    process.removeListener('SIGINT', sigintHandler);
  }
}

/**
 * Pure helper: offset all phase n values by completedPhase when the plan was
 * mis-numbered (guide restarted from 1 on a continuation pass).
 *
 * Returns { normalized: true, plan: newPlan } when an offset was applied, or
 * { normalized: false, plan: originalPlan } when the plan is already correct.
 * Never mutates the input plan object.
 */
export function normalizeContinuationPlan(plan, completedPhase) {
  const totalPhases = plan.phases?.length || 0;
  if (totalPhases === 0 || completedPhase === 0) {
    return { normalized: false, plan };
  }
  // Only normalize when NO plan phase has n > completedPhase — i.e., the guide
  // renumbered a new plan from 1 when prior phases are already done. If any
  // phase still has n > completedPhase the plan is correctly sequenced and
  // offsetting would cascade-renumber phases that haven't run yet.
  const hasNextPhase = plan.phases.some((p) => p.n > completedPhase);
  if (hasNextPhase) {
    return { normalized: false, plan };
  }
  const updatedPlan = {
    ...plan,
    phases: plan.phases.map((p) => ({ ...p, n: p.n + completedPhase })),
  };
  return { normalized: true, plan: updatedPlan };
}

/**
 * Phase 35 (batch-weight review gating) — applies the two HARD rules on top of
 * computeReviewWeight's raw classification, both explicitly load-bearing:
 *   1. The final review (isFinalReview) is ALWAYS 'full', regardless of batch
 *      evidence — it's the operator's one guaranteed full look before QA.
 *   2. A run of `forceEvery` (default 3) CONSECUTIVE light-eligible batches
 *      forces the next one to 'full' and resets the streak — the light path
 *      skips the guide session's own memory/decisions update, so an unchecked
 *      run of light reviews would let the guide's understanding drift
 *      indefinitely.
 *
 * Pure — the counter itself lives in metadata_json (read by the caller before
 * this call, persisted by the caller AFTER a successful review call, never at
 * decision time — pickNextAction can be probed without executing, e.g.
 * predict/dashboard polling, and a dry read must never bump persisted state).
 *
 * @returns {{ mode: 'light'|'full'|'panel', signals: string[], nextConsecutiveLight: number }}
 */
export function applyReviewGatingOverrides({ weight, isFinalReview, consecutiveLight = 0, forceEvery = 3 }) {
  if (isFinalReview) {
    return {
      mode: 'full',
      signals: [...weight.signals, 'final review — always full regardless of batch evidence'],
      nextConsecutiveLight: 0,
    };
  }
  if (weight.mode !== 'light') {
    return { mode: weight.mode, signals: weight.signals, nextConsecutiveLight: 0 };
  }
  const wouldBe = consecutiveLight + 1;
  if (forceEvery > 0 && wouldBe >= forceEvery) {
    return {
      mode: 'full',
      signals: [...weight.signals, `force_full_every_n (${forceEvery}) reached after ${wouldBe} consecutive light-eligible batches — forcing full`],
      nextConsecutiveLight: 0,
    };
  }
  return { mode: 'light', signals: weight.signals, nextConsecutiveLight: wouldBe };
}

/**
 * Phase 35 — gathers the review batch (one entry per plan phase since the
 * previous review's last-covered phase, through `completedPhase`) from data
 * already persisted: verify.json verdicts, escalation/validation/reprompt
 * marker files, and the DB phases table. Read-only I/O, no side effects.
 *
 * The baseline for changedFilesSince is the commit_sha of the LAST phase of
 * the PREVIOUS batch (the highest phase n < completedPhase that already has a
 * review file) — a missing boundary (this is the very first review) or a
 * missing commit_sha both fail-safe to changedFiles:null, which
 * computeReviewWeight then fails-safe to 'full'.
 */
async function computeReviewBatchContext({ projectName, projDir, cfg, plan, completedPhase }) {
  const planPhases = (plan?.phases || []).filter((p) => p.n <= completedPhase).sort((a, b) => a.n - b.n);
  if (!planPhases.length) return { batch: [], changedFiles: null };

  let boundaryN = 0;
  for (const p of planPhases) {
    if (p.n >= completedPhase) continue;
    if (await fileExists(reviewPath(projDir, p.n))) boundaryN = Math.max(boundaryN, p.n);
  }

  const batchPhases = planPhases.filter((p) => p.n > boundaryN);
  const dbByN = new Map(getPhases(projectName).map((row) => [row.n, row]));

  const batch = [];
  for (const p of batchPhases) {
    let verifyVerdict = 'missing';
    try {
      const vJson = await readJson(await phaseVerifyPath(projDir, p.n, p.title));
      if (vJson?.verdict === 'pass' || vJson?.verdict === 'fail') verifyVerdict = vJson.verdict;
    } catch { /* stays missing */ }

    const escalated = (await fileExists(escalationMarkerPath(projDir, { phaseN: p.n })))
      || (await fileExists(legacyEscalationMarkerPath(projDir, { phaseN: p.n })));
    const validationFailed = await fileExists(path.join(projDir, '.guide', `phase-${p.n}-validation-failed.marker`));
    const reprompted = await fileExists(path.join(projDir, '.guide', `phase-${p.n}-reprompt.hint`));

    batch.push({
      n: p.n,
      title: p.title,
      complexity: p.complexity || null,
      checkpoint: p.checkpoint || null,
      verifyVerdict,
      escalated,
      validationFailed,
      reprompted,
      criteriaCount: Array.isArray(p.acceptance_criteria) ? p.acceptance_criteria.length : 0,
    });
  }

  const boundaryRow = boundaryN > 0 ? dbByN.get(boundaryN) : null;
  const baselineSha = boundaryRow?.commit_sha || null;
  let changedFiles = null;
  if (baselineSha) {
    const workspaceDir = path.join(projDir, cfg.paths?.workspace_subdir || 'workspace');
    const res = await changedFilesSince(workspaceDir, baselineSha);
    changedFiles = res.ok ? res.files : null;
  }

  return { batch, changedFiles };
}

/**
 * Phase 35 — builds a review action, attaching the batch-weight classification
 * (reviewMode/reviewBatch/reviewChangedFiles/reviewNextConsecutiveLight) on
 * top of the base { kind:'guide', task:'review', ... } shape every review
 * action has always carried. Any error computing the batch/weight fails safe
 * to 'full' — classification is a right-sizing optimization, never a
 * precondition for a review to happen at all.
 */
async function buildReviewAction({ projectName, projDir, project, plan, cfg, completedPhase, isFinalReview, label }) {
  const action = { kind: 'guide', task: 'review', label, phaseN: completedPhase };
  if (isFinalReview) action.isFinalReview = true;

  try {
    const { batch, changedFiles } = await computeReviewBatchContext({ projectName, projDir, cfg, plan, completedPhase });
    const weight = computeReviewWeight({ batch, changedFiles, cfg });
    const consecutiveLight = parseProjectMetadata(project.metadata_json).consecutive_light_reviews || 0;
    const forceEvery = cfg.review_gating?.force_full_every_n ?? 3;
    const decision = applyReviewGatingOverrides({ weight, isFinalReview: !!isFinalReview, consecutiveLight, forceEvery });
    action.reviewMode = decision.mode;
    action.reviewBatch = batch;
    action.reviewChangedFiles = changedFiles;
    action.reviewGatingSignals = decision.signals;
    action.reviewNextConsecutiveLight = decision.nextConsecutiveLight;
  } catch (err) {
    console.warn(chalk.yellow(`[review-gating] could not classify review batch, defaulting to full: ${err.message}`));
    action.reviewMode = 'full';
  }
  return action;
}

export async function pickNextAction(projectName, cfg, rewindCtx = {}) {
  const project = getProject(projectName);
  const projDir = path.join(PROJECTS_DIR, projectName);
  const ar = cfg.auto_run || {};  // local alias, parallel to autoRun's `ar`
  // Threaded in via rewindCtx (autoRun's push fn) so the brief-chain handoff
  // pings resolve; absent in tests/other callers → null, and notifier?.() is
  // then a safe no-op. Declaring it here is what fixes `notifier is not defined`:
  // optional chaining guards a null VALUE, not an undeclared identifier.
  const notifier = rewindCtx.notifier ?? null;
  // Phase 69 (brief 05 P4) — fixes that already fell back to serial from a lane
  // failure (the main loop's laneFallbackFixes); pickBugAction collapses a batch
  // whose head is in here to a classic single fix-dev. Default empty Set for the
  // predict/dashboard/test callers that probe pickNextAction without the loop ctx.
  const laneFallbackFixes = rewindCtx.laneFallbackFixes instanceof Set ? rewindCtx.laneFallbackFixes : new Set();
  // Phase 70 (brief 05 P5) — fixes that already fell back to individual dispatch
  // from a single-call-batch failure/partial-reconcile; pickBugAction collapses
  // a batch whose head is in here to a classic single fix-dev (never re-batched).
  const batchFallbackFixes = rewindCtx.batchFallbackFixes instanceof Set ? rewindCtx.batchFallbackFixes : new Set();

  // Bug round in progress takes precedence
  const bugRound = getCurrentBugRound(projectName);
  if (bugRound && bugRound.status === 'in-progress') {
    return pickBugAction({ projectName, project, projDir, bugRound, cfg, laneFallbackFixes, batchFallbackFixes, notifier });
  }

  // ── Proactive network-failure pause (Rec 10) ────────────────────────────────
  // A sustained connectivity outage burns ~5 heal attempts × ~15s of dead time
  // before the per-kind rate-limiter fires — with no operator signal. Read the
  // healing_log up front (ONE indexed query): if ≥3 network-kind heals have
  // FAILED in the last 30 min, stop and surface it instead of dispatching
  // another doomed action that will just fail on the same dead connection.
  // 'network' is the EXACT error_kind classifyError emits for every network
  // signature (ECONNRESET/ETIMEDOUT/502-504/rate-limit/…) — sourced verbatim
  // from src/lib/error-classifier.js → ERROR_KINDS.NETWORK. A wrong string here
  // would make the guard silently never fire, so it is imported, not hardcoded.
  const NETWORK_FAILURE_KINDS = [ERROR_KINDS.NETWORK];
  const netHealFails = countRecentFailedHealingByKinds(projectName, NETWORK_FAILURE_KINDS, 30);
  if (netHealFails >= 3) {
    return {
      kind: 'wait-for-human',
      reason: `${netHealFails} failed network-heal attempts in last 30 min -- check connectivity then re-run.`,
    };
  }

  // New bug round trigger
  const newRound = await detectNewBugRound(projDir, projectName);
  if (newRound) {
    if (newRound.needsPlan) {
      return { kind: 'guide', task: 'bug-plan', label: `Plan fix round ${newRound.round} (bugs detected)`, round: newRound.round };
    }
    if (newRound.autoStart) {
      // bugs.md + plan.json exist but no in-progress SQL row. Bridge it into SQL.
      const plan = await readJson(fixPlanJsonPath(projDir, newRound.round));
      const totalFixes = Array.isArray(plan?.fixes) ? plan.fixes.length : 0;
      const bugsRelPath = path.relative(REPO_ROOT, bugsFilePath(projDir, newRound.round));
      // Phase 60 (P4): re-derive found_count from bugs.md — this bridging
      // step runs on a LATER tick than promote (after the guide's bug-plan
      // task wrote plan.json), so promoteResult.findings_count is out of
      // scope here. Same BUG_ENTRY_REGEX-based counter promote itself uses
      // (computeAuditYield), applied to the round's full bugs.md instead of
      // just the extracted promote-section content. Best-effort: an
      // unreadable/legacy bugs.md leaves found_count null, never throws.
      let foundCount = null;
      try {
        const bugsContent = await fs.readFile(bugsFilePath(projDir, newRound.round), 'utf-8');
        foundCount = computeAuditYield(bugsContent).findings_count;
      } catch { /* best-effort — legacy/unreadable bugs.md leaves found_count null */ }
      startBugRound({
        project: projectName,
        round: newRound.round,
        bugs_file: bugsRelPath,
        total_fixes: totalFixes,
        found_count: foundCount,
      });
      console.log(chalk.cyan(`Picked up existing plan for round ${newRound.round} (${totalFixes} fix(es)). Starting in-progress.`));
      // Now there's an in-progress row — recurse via getCurrentBugRound
      const fresh = getCurrentBugRound(projectName);
      if (fresh) return pickBugAction({ projectName, project, projDir, bugRound: fresh, cfg, laneFallbackFixes, batchFallbackFixes, notifier });
    }
  }

  // Plan generation — with pre-flight brief quality checks (G1, G4, G5, G3)
  let plan = await readJson(planJsonPath(projDir));
  if (!plan) {
    // G1: brief.md must exist and have content before we let the guide plan
    let briefText = null;
    try { briefText = await fs.readFile(briefPath(projDir), 'utf-8'); } catch { /* missing */ }
    if (!briefText || !briefText.trim()) {
      return {
        kind: 'wait-for-human',
        reason: 'brief.md is missing or empty. Populate .guide/brief.md or run: npm run brief -- <project> (from raw-thoughts.md)',
      };
    }
    // G4: no unresolved [NEEDS USER INPUT] markers left in the brief
    const unresolved = (briefText.match(/\[NEEDS USER INPUT[^\]]*\]/g) || []).length;
    if (unresolved > 0) {
      return {
        kind: 'wait-for-human',
        reason: `brief.md has ${unresolved} unresolved [NEEDS USER INPUT] section(s). Answer the questions in .guide/brief-questions.md, update raw-thoughts.md, then re-run: npm run brief -- <project>`,
      };
    }
    // G4.5: brief-questions.md open-questions gate.
    // If brief-author generated questions that the user hasn't reviewed yet —
    // detected by brief-questions.md being newer than brief.md by >60s (the gap
    // brief-author takes to write both files in the same session) — pause so the
    // operator can answer the questions before the guide plans against an incomplete spec.
    {
      const bqPath = briefQuestionsPath(projDir);
      let bqText = null;
      try { bqText = await fs.readFile(bqPath, 'utf-8'); } catch { /* no file — skip */ }
      const hasSubstantialQs = bqText && bqText.trim().split('\n').filter((l) => l.trim()).length > 5;
      if (hasSubstantialQs) {
        try {
          const [bStat, bqStat] = await Promise.all([
            fs.stat(briefPath(projDir)),
            fs.stat(bqPath),
          ]);
          if (bStat.mtimeMs < bqStat.mtimeMs - 60 * 1000) {
            return {
              kind: 'wait-for-human',
              reason: 'brief-questions.md has open questions that need to be answered before planning. ' +
                      'Review .guide/brief-questions.md, update .guide/brief.md with your answers, ' +
                      'then re-run go   (or /run <project> go on Telegram).',
            };
          }
        } catch { /* can\'t stat — skip */ }
      }
    }
    // G5: stale-brief check — only runs pre-planning (no plan yet) so a freshly
    // dropped inputs/brief.md is caught before the guide plans against a stale copy.
    const staleBriefAction = await checkStaleBriefGuard(projDir);
    if (staleBriefAction) return staleBriefAction;
    // G3: generate project-context before planning if it doesn't exist yet
    if (!(await fileExists(projectContextPath(projDir)))) {
      return { kind: 'guide', task: 'project-context-gen', label: 'Generate project context (before planning)' };
    }
    return { kind: 'guide', task: 'plan', label: 'Generate initial phase plan' };
  }

  // Plan coverage gate — before phase 1, verify every brief FR maps to a plan phase.
  // Fires once (current_phase === 0, no coverage file). On BLOCKER in the coverage
  // file, pauses so the operator can fix the plan rather than discovering missing FRs
  // in QA. Skipped for continuation plans (current_phase > 0 already when gate fires).
  if (project.current_phase === 0) {
    const coveragePath = planCoveragePath(projDir);
    if (!(await fileExists(coveragePath))) {
      return { kind: 'guide', task: 'plan-validate', label: 'Validate plan FR coverage against brief (before phase 1)' };
    }
    try {
      const coverageText = await fs.readFile(coveragePath, 'utf-8');
      // Accept markdown-bold blocker prefixes too (**BLOCKER:** …): the prompt
      // warns against them but nothing enforces it, and a bolded blocker used
      // to fail open. Also fail CLOSED on a coverage file that contains
      // neither CLEAR nor any blocker — an empty/garbled verdict is not a pass.
      const blockerLines = coverageText.split('\n')
        .filter((l) => /^(\*{1,2}|_{1,2})?\s*BLOCKER\s*(\*{1,2}|_{1,2})?\s*:/i.test(l.trim()));
      const hasClear = /\bCLEAR\b/.test(coverageText);
      if (blockerLines.length === 0 && !hasClear && coverageText.trim().length > 0) {
        console.warn(chalk.yellow('⚠ plan-coverage.md contains neither CLEAR nor BLOCKER — regenerating the coverage check (garbled verdict is not a pass)'));
        await fs.unlink(coveragePath).catch(() => {});
        return { kind: 'guide', task: 'plan-validate', label: 'Re-validate plan FR coverage (garbled verdict)' };
      }
      if (blockerLines.length > 0) {
        // v0.14.36: one auto-regen before pausing. First BLOCKER → inject the
        // blocker lines via plan-fix.hint and regenerate the plan (the
        // post-plan block deletes plan-coverage.md, so the gate re-validates
        // the new plan from scratch). The .coverage-regen-attempted marker is
        // the budget: a second BLOCKER pauses with the original message.
        const regenMarker = path.join(projDir, '.guide', '.coverage-regen-attempted');
        if (!(await fileExists(regenMarker))) {
          const hintPath = path.join(projDir, '.guide', 'plan-fix.hint');
          const hint = `FR-coverage validation found BLOCKERs — some brief requirements have NO covering phase:\n${blockerLines.map((l) => `- ${l.trim()}`).join('\n')}\nAdd phases (or extend existing ones) so every brief FR is covered. Do not drop existing phases.`;
          await fs.writeFile(hintPath, hint, 'utf-8').catch(() => {});
          await fs.writeFile(regenMarker, new Date().toISOString(), 'utf-8').catch(() => {});
          console.warn(chalk.yellow(`⚠ Plan coverage BLOCKER — one auto-regen with the blockers injected:\n  ${blockerLines.map((l) => l.trim()).join('\n  ')}`));
          return { kind: 'guide', task: 'plan', label: 'Regenerate plan (coverage BLOCKER — one auto-retry)' };
        }
        return {
          kind: 'wait-for-human',
          reason: 'plan-coverage.md has a BLOCKER after one auto-regen — some brief requirements still have no corresponding phase. ' +
                  'Review .guide/plan-coverage.md, fix the plan or brief, delete plan-coverage.md and .guide/.coverage-regen-attempted, then re-run.',
        };
      }
      // CLEAR — release the regen budget for the next plan generation.
      fs.unlink(path.join(projDir, '.guide', '.coverage-regen-attempted')).catch(() => {});
    } catch (err) {
      // Unreadable coverage file: proceed (matching historic fail-open) but
      // say so — a silent bare catch here hid every I/O failure as a pass.
      console.warn(chalk.yellow(`⚠ plan-coverage.md unreadable (${err.message}) — proceeding without the FR-coverage gate`));
    }
  }

  // Auto-generate workspace/CLAUDE.md after plan, before phase 1
  const wcfg = cfg.workspace_claude_md || {};
  const workspaceClaudeMd = path.join(projDir, cfg.paths.workspace_subdir, 'CLAUDE.md');
  const wskipped = path.join(guideRoot(projDir), 'workspace-claude-md-skipped.md');
  if (
    wcfg.auto_generate_during_autorun
    && project.current_phase === 0
    && !(await fileExists(workspaceClaudeMd))
    && !(await fileExists(wskipped))
  ) {
    return { kind: 'guide', task: 'workspace-claude-md', label: 'Generate workspace/CLAUDE.md' };
  }

  const totalPhases = plan.phases?.length || 0;
  // Plans can start at a phase number > 1 (e.g. a continuation plan numbered
  // 11-27). Compare against the LAST phase's n value, not the count, so that
  // current_phase=17 on a 17-phase plan starting at n=11 (last n=27) is not
  // mistakenly treated as "all done".
  let lastPhaseN = totalPhases > 0 ? plan.phases[totalPhases - 1].n : 0;
  const completedPhase = project.current_phase || 0;

  // Continuation-numbering guard: only fires when ALL plan phases have n ≤ completedPhase,
  // meaning the guide restarted numbering from 1 on a pass where prior phases are done.
  // normalizeContinuationPlan itself now guards against triggering when any phase
  // already has n > completedPhase, preventing the cascade-renumbering bug.
  if (totalPhases > 0 && completedPhase > 0 && !plan.phases.some((p) => p.n > completedPhase)) {
    // Sentinel check — if plan already has a _normalization_base matching the current
    // completedPhase, normalization already ran for this base. Skip to prevent the
    // cascade loop (50→110→…) that occurs when allPlanPhasesCompleted returns false
    // (e.g. after resetProjectForNewPlan cleared DB phases mid-run or a concurrent
    // guide:plan job wrote a fresh plan.json without resetting current_phase).
    const alreadyNormalized = plan._normalization_base === completedPhase;

    if (!alreadyNormalized) {
      // Before renumbering, check if ALL plan phases are already completed in the DB.
      // If yes, the plan phases are genuinely done — skip renumbering and fall through
      // to the "all phases done" check below.
      const dbPhases = getPhases(projectName);
      const allPlanPhasesCompleted = plan.phases.every((p) =>
        dbPhases.some((db) => db.n === p.n && db.status === 'completed'),
      );
      if (!allPlanPhasesCompleted) {
        const { plan: correctedPlan } = normalizeContinuationPlan(plan, completedPhase);
        // Stamp the base so re-reading the same plan.json never re-normalizes.
        correctedPlan._normalization_base = completedPhase;
        plan = correctedPlan;
        lastPhaseN = correctedPlan.phases[totalPhases - 1].n;
        console.log(chalk.dim(`  → Continuation plan renumbered: phases offset by ${completedPhase} (now ${correctedPlan.phases[0].n}..${lastPhaseN})`));
        try {
          await fs.writeFile(planJsonPath(projDir), JSON.stringify(plan, null, 2), 'utf-8');
        } catch (err) {
          // Write failed — plan stays on disk without the sentinel. Log clearly so
          // the operator knows; do NOT silently run phantom phases on next resume.
          console.error(chalk.red(`✗ Could not persist renumbered plan.json: ${err.message}`));
          console.error(chalk.red(`  Fix: check write permissions on ${planJsonPath(projDir)} and re-run.`));
          throw new Error(`plan.json write failed after continuation renumber: ${err.message}`);
        }
      }
    }
  }

  // All phases done — but run final review FIRST if not done yet (fixes v0.2 bug)
  if (completedPhase >= lastPhaseN) {
    if (ar.run_final_review_before_qa && totalPhases > 0) {
      const reviewFile = reviewPath(projDir, completedPhase);
      if (!(await fileExists(reviewFile))) {
        return buildReviewAction({
          projectName, projDir, project, plan, cfg, completedPhase, isFinalReview: true,
          label: `Run final review (after phase ${completedPhase})`,
        });
      }
    }
    // Post-completion audit runs — N passes before handing off to QA.
    const auditRunsTarget = ar.audit_runs_after_completion || 0;
    if (auditRunsTarget > 0) {
      const auditsDone = getAuditRunsCompleted(projectName);
      if (auditsDone < auditRunsTarget) {
        return {
          kind: 'guide',
          task: 'audit',
          label: `Post-completion audit ${auditsDone + 1}/${auditRunsTarget}`,
          isCompletionAudit: true,
        };
      }
    }
    if (project.status === 'completed') return { kind: 'done' };

    // Brief conformance gate (phase-47 / P4) — back-of-pipeline FR->evidence
    // check, mirrors the plan-coverage gate's file-existence pattern above.
    // Skipped entirely when cfg.brief_conformance.enabled is false; otherwise
    // re-fires the checker only when the active brief's content hash has
    // moved since the last persisted verdict (delete brief-conformance.json
    // to force a re-check manually). A pure read + decide — the checker spawn
    // (and any bug_inbox insertion for missing FRs) lives entirely inside
    // runBriefConformance, so this branch never mutates state on its own.
    if (cfg.brief_conformance?.enabled !== false) {
      const bcCfg = cfg.brief_conformance || {};
      const currentHash = await briefHash(activeBriefPath(projDir, plan));
      const existingVerdict = await readJson(briefConformancePath(projDir));
      // briefHash() returns null when the brief file is unreadable (e.g. plan.brief_snapshot
      // points to a non-existent path). Per briefHash's contract, null means "cannot compare —
      // treat as not-stale". Without this guard the currentHash && short-circuit made
      // verdictFresh=false even when both sides are null, causing an infinite re-run loop.
      const verdictFresh = !!(existingVerdict && existingVerdict.brief_hash === currentHash);
      if (!verdictFresh) {
        return { kind: 'guide', task: 'brief-conformance', label: 'Check brief conformance against built code (before ready-for-qa)' };
      }
      const decision = decideConformance(existingVerdict, { failOpen: bcCfg.fail_open !== false });
      if (decision.block && bcCfg.block_on_missing !== false) {
        return {
          kind: 'wait-for-human',
          reason: `Brief conformance check found ${decision.missing.length} missing FR(s): ${decision.missing.map((f) => f.id).join(', ')}. See .guide/brief-conformance.md.`,
        };
      }
    }

    // Auto-brief-chain: run one audit (if requested), promote findings, pop next brief
    if (cfg.auto_run?.auto_brief_chain?.enabled) {
      const abcCfg = cfg.auto_run.auto_brief_chain;
      if (abcCfg.audit_before_chain !== false && getAuditRunsCompleted(projectName) === 0) {
        return { kind: 'guide', task: 'audit', label: 'Auto-chain: audit before next brief', isCompletionAudit: true };
      }
      if (abcCfg.audit_before_chain !== false && getAuditRunsCompleted(projectName) > 0) {
        const promoted = await promoteAuditToBugs({ projDir, projectName });
        if (promoted?.written) {
          const nr = await detectNewBugRound(projDir, projectName);
          if (nr?.needsPlan) {
            return { kind: 'guide', task: 'bug-plan', label: `Auto-chain: plan fix round ${nr.round}`, round: nr.round };
          }
        }
      }
      const next = await popNextBriefFromQueue(projDir, projectName, cfg);
      if (next) {
        console.log(chalk.cyan(`\n📋 Brief chain: installed "${next.briefName}" — starting planning`));
        await notifyBriefChain(notifier, `📋 Brief chain: installed "${next.briefName}" — starting planning`);
        return { kind: 'guide', task: 'plan', label: `Auto-chain: plan "${next.briefName}"` };
      }
    }
    // Main-flow ready-for-qa transition (phase 89 / P5b). In BOTH modes the status
    // flip is DEFERRED to autoRun, which runs runReadyForQaRuntimeGate FIRST and
    // only flips once the gate confirms non-blocked — so runtime-qa runs (and
    // .guide/runtime-qa.json lands) BEFORE the project status ever reads
    // ready-for-qa, and gate mode can still block on a blocker verdict.
    // readyForQaTransition tells autoRun to run the runtime-qa gate ONCE, between
    // the final review and this pause; deferredReadyForQa tells it to do the flip
    // itself when the gate clears. (The pickBugAction fix-round-complete site is
    // the third gated ready-for-qa site and gets the identical treatment.)
    return {
      kind: 'wait-for-human',
      reason: `All ${totalPhases} phases + final review complete. Run manual QA, then drop bugs-round-1.md or run "qa --shipped".`,
      readyForQaTransition: true,
      deferredReadyForQa: true,
    };
  }

  // Mid-stream review check
  // Phase 52 (par-03) — a review already in flight in the background for
  // THIS exact phase (pendingReviewPhaseN, set by autoRun when
  // auto_run.async_reviews fired it without awaiting) is treated as already
  // satisfied here: the review file genuinely doesn't exist yet, but
  // re-returning the same review action would just fire a second, redundant
  // one. Falling through past this gate lets the NEXT phase's dev action be
  // returned instead, which is exactly what lets phase N+1 dispatch while
  // phase N's review is still running.
  const reviewEveryN = cfg.phases?.review_every_n_phases || 6;
  const completedPhaseMeta = (plan?.phases || []).find((phase) => phase.n === completedPhase) || null;
  const reviewSchedule = shouldScheduleReview({ completedPhase, phaseMeta: completedPhaseMeta, reviewEveryN, cfg });
  const reviewAlreadyPending = completedPhase > 0 && completedPhase === rewindCtx.pendingReviewPhaseN;
  const needsReview = !reviewAlreadyPending && reviewSchedule.run
    && !(await fileExists(reviewPath(projDir, completedPhase)));
  if (needsReview) {
    return buildReviewAction({
      projectName, projDir, project, plan, cfg, completedPhase, isFinalReview: false,
      label: `Run review after phase ${completedPhase} (${reviewSchedule.reason})`,
    });
  }

  // ── Periodic skip-analyze check ───────────────────────────────────────────
  // After every N completed plan phases, verify that earlier phases actually
  // landed — correct commit SHA. File-only gaps warn but do NOT rewind.
  const skipCfgPa = cfg.skip_analyze || {};
  const skipEveryN = skipCfgPa.every_n_phases;
  if (skipCfgPa.enabled !== false && skipEveryN && completedPhase > 0
      && completedPhase % skipEveryN === 0) {
    const { hasGaps, gaps, firstMissing, checkedCount } = await analyzeSkippedPhases({
      projectName,
      plan,
      workspaceDir: path.join(projDir, cfg.paths?.workspace_subdir || 'workspace'),
      projDir,
      completedPhase,
      checks: skipCfgPa.checks || {},
    });
    if (hasGaps) {
      const oldPipelineGPa  = gaps.filter((g) => g.isOldPipeline);
      const fileOnlyGapsPa  = gaps.filter((g) => !g.isOldPipeline && g.onlyFileGap);
      const stateOnlyGapsPa = gaps.filter((g) => !g.isOldPipeline && g.onlyStateGap);
      const rewindableGapsPa = gaps.filter((g) => !g.isOldPipeline && !g.onlyFileGap && !g.onlyStateGap);

      if (oldPipelineGPa.length) {
        console.log(chalk.dim(`  ℹ Skip-analyze: ${oldPipelineGPa.length} old-pipeline phase(s) in gap (already in git):`));
        oldPipelineGPa.forEach((g) => console.log(chalk.dim(`    phase ${g.n}: ${g.issues[0]}`)));
      }
      if (fileOnlyGapsPa.length) {
        console.log(chalk.dim(`  ℹ Skip-analyze: ${fileOnlyGapsPa.length} file-check warning(s) — commit verified, not rewinding:`));
        fileOnlyGapsPa.forEach((g) => console.log(chalk.dim(`    phase ${g.n}: ${g.fileIssues?.join('; ') || g.issues.join('; ')}`)));
      }
      if (stateOnlyGapsPa.length) {
        console.log(chalk.dim(`  ℹ Skip-analyze: ${stateOnlyGapsPa.length} state-tracking warning(s) — completed work has no recorded SHA, not rewinding:`));
        stateOnlyGapsPa.forEach((g) => console.log(chalk.dim(`    phase ${g.n}: ${g.commitIssues?.join('; ') || g.issues.join('; ')}`)));
      }
      if (rewindableGapsPa.length && firstMissing !== null) {
        // Circuit breaker: stop rewinding the same phase endlessly.
        const { phaseRewindCount: rwMap, maxRewindsPerPhase: rwMax } = rewindCtx;
        const priorRw = rwMap ? (rwMap.get(firstMissing) || 0) : 0;
        const maxRw   = rwMax ?? 2;
        if (priorRw >= maxRw) {
          console.log(chalk.yellow(
            `  ⚠ Skip-analyze: phase ${firstMissing} has been rewound ${priorRw}× this run — stopping rewind loop (needs manual review)`,
          ));
        } else {
          if (rwMap) rwMap.set(firstMissing, priorRw + 1);
          console.log(chalk.yellow(`\n⚠ Skip-analyze (periodic, after phase ${completedPhase}): ${rewindableGapsPa.length} commit-level gap(s) in ${checkedCount} phases:`));
          rewindableGapsPa.forEach((g) =>
            console.log(chalk.yellow(`  • Phase ${g.n} (${g.title}): ${g.commitIssues?.join('; ') || g.issues.join('; ')}`)),
          );
          console.log(chalk.yellow(`  → Rewinding to phase ${firstMissing} — will re-run before continuing.\n`));
          setCurrentPhase(projectName, firstMissing - 1);
          upsertPhase({
            project: projectName,
            n:       firstMissing,
            title:   plan.phases.find((p) => p.n === firstMissing)?.title || null,
            status:  'pending',
          });
          const repairMeta = plan.phases.find((p) => p.n === firstMissing);
          if (repairMeta) {
            const repairPrompt = await phasePromptPath(projDir, repairMeta.n, repairMeta.title);
            const hasRepairPrompt = await fileExists(repairPrompt);
            // v0.14.35: inline prompts cover the repair path too — no prompt.md
            // needed for runDev to re-execute the phase from its plan spec.
            const inlineRepair = cfg.phases?.inline_phase_prompts !== false;
            const goDev = hasRepairPrompt || inlineRepair;
            return {
              kind:       goDev ? 'dev' : 'guide',
              task:       goDev ? undefined : 'next-prompt',
              label:      `[skip-repair] ${goDev ? 'Re-run' : 'Generate prompt for'} phase ${repairMeta.n}: ${repairMeta.title || ''}`,
              phaseN:     repairMeta.n,
              phaseTitle: repairMeta.title || '',
              // Phase 64 — same checkpoint ctx as the normal dev action.
              totalPhases,
              nextPhaseCheckpoint: nextCheckpointAfter(plan, repairMeta.n),
              warning:    `Skip-analyze: ${rewindableGapsPa.length} gap(s) detected — rewound to phase ${firstMissing}`,
            };
          }
        }
      }
    } else {
      console.log(chalk.green(`  ✓ Skip-analyze (after phase ${completedPhase}): ${checkedCount} completed phase(s) verified — no gaps`));
    }
  }

  // ── Lessons distillation (phase 8) ────────────────────────────────────────
  // .guide/lessons.jsonl accumulates one line per heal/reprompt/escalation/
  // validator-fail/verify-fail event. Once it crosses
  // lessons.distill_after_entries, compress it before the backlog grows
  // unbounded. shouldDistillLessons re-checks the on-disk count every call —
  // once distillation truncates the file it returns false again until the
  // threshold is re-crossed, so this fires at most once per backlog.
  if (await shouldDistillLessons(projDir, cfg)) {
    return { kind: 'guide', task: 'lessons-distill', label: 'Distill accumulated lessons (.guide/lessons.jsonl)' };
  }

  // Next phase — use the first plan phase whose N > completedPhase rather
  // than assuming completedPhase+1 exists. Plans can have non-sequential
  // numbering (e.g. a continuation plan starting at n=11).
  const nextPhaseMeta = plan.phases.find((p) => p.n > completedPhase);
  if (!nextPhaseMeta) {
    // current_phase is at or past the last phase — treat as done.
    if (project.status === 'completed') return { kind: 'done' };
    if (cfg.auto_run?.auto_brief_chain?.enabled) {
      const abcCfg = cfg.auto_run.auto_brief_chain;
      if (abcCfg.audit_before_chain !== false && getAuditRunsCompleted(projectName) === 0) {
        return { kind: 'guide', task: 'audit', label: 'Auto-chain: audit before next brief', isCompletionAudit: true };
      }
      if (abcCfg.audit_before_chain !== false && getAuditRunsCompleted(projectName) > 0) {
        const promoted = await promoteAuditToBugs({ projDir, projectName });
        if (promoted?.written) {
          const nr = await detectNewBugRound(projDir, projectName);
          if (nr?.needsPlan) {
            return { kind: 'guide', task: 'bug-plan', label: `Auto-chain: plan fix round ${nr.round}`, round: nr.round };
          }
        }
      }
      const next = await popNextBriefFromQueue(projDir, projectName, cfg);
      if (next) {
        console.log(chalk.cyan(`\n📋 Brief chain: installed "${next.briefName}" — starting planning`));
        await notifyBriefChain(notifier, `📋 Brief chain: installed "${next.briefName}" — starting planning`);
        return { kind: 'guide', task: 'plan', label: `Auto-chain: plan "${next.briefName}"` };
      }
    }
    // Main-flow ready-for-qa transition (phase 89 / P5b). In BOTH modes the status
    // flip is DEFERRED to autoRun, which runs runReadyForQaRuntimeGate FIRST and
    // only flips once the gate confirms non-blocked — so runtime-qa runs (and
    // .guide/runtime-qa.json lands) BEFORE the project status ever reads
    // ready-for-qa, and gate mode can still block on a blocker verdict.
    // readyForQaTransition tells autoRun to run the runtime-qa gate ONCE, between
    // the final review and this pause; deferredReadyForQa tells it to do the flip
    // itself when the gate clears. (The pickBugAction fix-round-complete site is
    // the third gated ready-for-qa site and gets the identical treatment.)
    return {
      kind: 'wait-for-human',
      reason: `All ${totalPhases} phases + final review complete. Run manual QA, then drop bugs-round-1.md or run "qa --shipped".`,
      readyForQaTransition: true,
      deferredReadyForQa: true,
    };
  }
  const nextPhase = nextPhaseMeta.n;
  const phaseMeta = nextPhaseMeta;
  const promptFile = await phasePromptPath(projDir, nextPhase, phaseMeta?.title);
  const hasPrompt = await fileExists(promptFile);

  // Missing report check (only warn, don't block)
  let warning = null;
  if (completedPhase > 0 && cfg.auto_run?.warn_on_missing_phase_report) {
    const lastReport = await phaseReportPath(projDir, completedPhase, plan.phases.find((p) => p.n === completedPhase)?.title);
    if (!(await fileExists(lastReport))) {
      warning = `Phase ${completedPhase} report missing at ${path.relative(projDir, lastReport)} — dev shipped code without report.`;
    }
  }

  if (!hasPrompt) {
    // v0.14.35: inline phase prompts. With inline_phase_prompts on (default),
    // a missing prompt.md no longer costs a next-prompt guide call — runDev
    // builds the prompt from the plan's phase spec + decisions.jsonl + brief.
    // EXCEPTION: a reprompt hint file means auto-reprompt-on-timeout deleted
    // the prompt deliberately so the guide can regenerate a tighter one — that
    // path keeps its guide call (the hint is the whole point).
    const inlinePrompts = cfg.phases?.inline_phase_prompts !== false;
    const hintFile = path.join(projDir, '.guide', `phase-${nextPhase}-reprompt.hint`);
    const hasHint = await fileExists(hintFile);
    if (!inlinePrompts || hasHint) {
      return { kind: 'guide', task: 'next-prompt', label: `Generate phase ${nextPhase} prompt${hasHint ? ' (reprompt)' : ''}`, phaseN: nextPhase, warning };
    }
  }
  // Phase 64 — carry the checkpoint ctx so evaluatePause → shouldPauseAfter can
  // apply the intent-mode (next phase's tag) and min_total_phases (Layer 1)
  // decisions. totalPhases is the plan's phase count; nextPhaseCheckpoint is the
  // tag of the phase AFTER this one.
  return {
    kind: 'dev', label: `Execute phase ${nextPhase}: ${phaseMeta?.title || ''}`,
    phaseN: nextPhase, isFinal: nextPhase === lastPhaseN, phaseTitle: phaseMeta?.title || '',
    totalPhases, nextPhaseCheckpoint: nextCheckpointAfter(plan, nextPhase), warning,
  };
}

async function pickBugAction({ projectName, project, projDir, bugRound, cfg, laneFallbackFixes = new Set(), batchFallbackFixes = new Set(), notifier = null }) {
  const fixPlan = await readJson(fixPlanJsonPath(projDir, bugRound.round));
  if (!fixPlan || !Array.isArray(fixPlan.fixes)) {
    // Plan was never written (guide crashed mid-run). Re-dispatch guide to generate it.
    return { kind: 'guide', task: 'bug-plan', label: `Generate fix plan for round ${bugRound.round} (plan missing)`, round: bugRound.round };
  }

  // ── Self-heal: reconcile fixes_completed against committed fix commits ──
  // A prior run may have applied AND committed a fix but crashed / timed out
  // before recordFixCompletion fired, leaving fixes_completed stale. Without
  // this, the orchestrator re-dispatches an already-committed fix forever —
  // re-running its verification (which can hang), getting killed, never
  // advancing. Walk pending fixes in order; for each whose `fix-r{round}-{n}:`
  // commit already exists in git, record it complete so we move past it.
  const expectedBranch = project.git_branch || null;
  if (expectedBranch && cfg?.paths?.workspace_subdir) {
    const workspaceDir = path.join(projDir, cfg.paths.workspace_subdir);
    let done = bugRound.fixes_completed || 0;
    while (done < fixPlan.fixes.length) {
      const f = fixPlan.fixes[done];
      // v0.14.38: a fix commit that FAILED the validator gate must not be
      // reconciled as complete — the marker blocks it and the fix re-runs.
      // eslint-disable-next-line no-await-in-loop
      const vFailed = await fileExists(path.join(projDir, '.guide', `fix-r${bugRound.round}-${f.n}-validation-failed.marker`));
      // eslint-disable-next-line no-await-in-loop
      if (!vFailed && await fixCommitExists(workspaceDir, bugRound.round, f.n)) {
        recordFixCompletion({ project: projectName, round: bugRound.round, fixN: f.n });
        console.log(chalk.yellow(
          `↺ Reconciled: fix r${bugRound.round}-${f.n} already committed in workspace` +
          ` — recording complete (was not recorded by its run).`,
        ));
        done += 1;
      } else {
        break;
      }
    }
    // Re-read the round row so the counts below reflect any reconciliation.
    bugRound = getCurrentBugRound(projectName) || bugRound;
  }

  const completed = bugRound.fixes_completed || 0;
  const total = fixPlan.fixes.length;

  if (completed >= total) {
    setBugRoundStatus(projectName, bugRound.round, 'completed');
    if (cfg.auto_run?.auto_brief_chain?.enabled) {
      const next = await popNextBriefFromQueue(projDir, projectName, cfg);
      if (next) {
        console.log(chalk.cyan(`\n📋 Brief chain: fix round ${bugRound.round} complete — installed "${next.briefName}"`));
        await notifyBriefChain(notifier, `📋 Brief chain: fix round ${bugRound.round} complete — starting "${next.briefName}"`);
        return { kind: 'guide', task: 'plan', label: `Auto-chain: plan "${next.briefName}"` };
      }
    }
    // Main-flow ready-for-qa transition (phase 89 / P5b) — the fix-round-complete
    // variant (the third gated setProjectStatus('ready-for-qa') site). Identical
    // runtime-qa treatment to the two all-phases-complete sites in pickNextAction:
    // in BOTH modes the flip is DEFERRED to autoRun, which runs the runtime-qa gate
    // FIRST and only flips once it confirms non-blocked. readyForQaTransition tells
    // autoRun to run the gate ONCE before the pause; deferredReadyForQa tells it to
    // do the flip when the gate clears.
    return {
      kind: 'wait-for-human',
      reason: `Fix round ${bugRound.round} complete (${total} fixes). Re-test, then drop bugs-round-${bugRound.round + 1}.md (or .guide/bug-rounds/round-${bugRound.round + 1}/bugs.md) for another round, or run qa --shipped.`,
      readyForQaTransition: true,
      deferredReadyForQa: true,
    };
  }

  const nextFix = fixPlan.fixes[completed];

  // Phase 69 (brief 05 P4) — parallel independent fix batch. Only when fix lanes
  // are enabled (bug_cycle.max_parallel_fixes>1), inline fix prompts are on (a
  // batched fix runs via runDev's inline prompt — no per-fix guide fix-prompt
  // call), and the head fix has NOT already fallen back to serial from a prior
  // lane failure. The pure selectFixBatch enforces the consecutive-prefix +
  // pairwise-disjoint-files_likely + cap rules; a batch of 1 (the common case —
  // fixes in a round usually share a subsystem, so intersection frequently
  // serializes) falls through to the classic single-fix action below. Mode
  // isolation: max_parallel_fixes:1 (default) never enters this block.
  const bc = cfg.bug_cycle || {};
  const maxParallelFixes = Number.isInteger(bc.max_parallel_fixes) ? bc.max_parallel_fixes : 1;
  if (maxParallelFixes > 1
      && cfg.fixes?.inline_fix_prompts !== false
      && !laneFallbackFixes.has(`r${bugRound.round}-${nextFix.n}`)) {
    const { batch } = selectFixBatch({ fixes: fixPlan.fixes, completed, cfg });
    if (batch.length > 1) {
      return {
        kind: 'fix-dev-batch',
        label: `Execute fix batch: round ${bugRound.round} fixes ${batch.map((f) => f.n).join(', ')}`,
        round: bugRound.round,
        fixes: batch.map((f) => ({ round: bugRound.round, n: f.n, title: f.title })),
      };
    }
  }

  // Phase 70 (brief 05 P5) — single-call batch for a consecutive run of MINOR
  // fixes when fix LANES are disabled (bug_cycle.max_parallel_fixes===1 — the
  // shipped default). v1 keeps P4's lanes and P5's single-call batching
  // MUTUALLY EXCLUSIVE to bound the failure surface: if lanes are enabled
  // (max_parallel_fixes>1), single-call batching is skipped outright — even
  // if THIS pick's P4 batch selection above collapsed to size 1 — with a dim
  // log naming the deciding config key. Mode isolation: with both
  // bug_cycle.max_parallel_fixes and batch_minor_fixes at their shipped
  // defaults (1, false), this whole block is unreachable.
  if (maxParallelFixes > 1) {
    if (bc.batch_minor_fixes !== false && (Number.isInteger(bc.batch_max) ? bc.batch_max : 4) > 0) {
      console.log(chalk.dim(`  (bug_cycle.max_parallel_fixes>1 [config/defaults.json bug_cycle layer] — fix lanes win; skipping single-call minor-fix batching this pick)`));
    }
  } else if (cfg.fixes?.inline_fix_prompts !== false
      && !batchFallbackFixes.has(`r${bugRound.round}-${nextFix.n}`)) {
    const { batch } = selectMinorFixBatch({ fixes: fixPlan.fixes, completed, cfg });
    if (batch.length > 1) {
      return {
        kind: 'fix-dev-single-call-batch',
        label: `Execute single-call fix batch: round ${bugRound.round} fixes ${batch.map((f) => f.n).join(', ')}`,
        round: bugRound.round,
        fixes: batch.map((f) => ({ round: bugRound.round, n: f.n, title: f.title })),
      };
    }
  }

  const promptFile = await fixPromptPath(projDir, bugRound.round, nextFix.n, nextFix.title);
  const hasPrompt = await fileExists(promptFile);

  if (!hasPrompt) {
    // v0.14.37: inline fix prompts — runDev builds the prompt from the round's
    // plan.json entry + bugs.md pointers, no fix-prompt guide call. A prompt.md
    // on disk (hand-written, or generated with inline_fix_prompts:false) wins
    // via the hasPrompt branch above.
    const inlineFix = cfg.fixes?.inline_fix_prompts !== false;
    if (!inlineFix) {
      return { kind: 'guide', task: 'fix-prompt', label: `Generate fix prompt: round ${bugRound.round} fix ${nextFix.n} (${nextFix.title})`, fix: { round: bugRound.round, n: nextFix.n, title: nextFix.title } };
    }
  }
  return {
    kind: 'fix-dev',
    label: `Execute fix: round ${bugRound.round} fix ${nextFix.n} (${nextFix.title})`,
    fix: { round: bugRound.round, n: nextFix.n, title: nextFix.title },
    isFinalFix: completed + 1 === total,
  };
}

export async function detectNewBugRound(projDir, projectName) {
  const round = await detectHighestBugRound(projDir);
  if (!round) return null;

  // Is the highest disk round already completed (per SQL)? If so, nothing to do here.
  const matchingRow = getBugRound(projectName, round);
  if (matchingRow && matchingRow.status === 'completed') return null;

  // Is it the same one we're already running? Handled by getCurrentBugRound earlier.
  if (matchingRow && matchingRow.status === 'in-progress') return null;

  const fixPlanExists = await fileExists(fixPlanJsonPath(projDir, round));
  if (!fixPlanExists) {
    // bugs.md exists but no plan → need guide to generate the plan
    return { round, needsPlan: true };
  }
  // bugs.md + plan.json exist but no in-progress SQL row → auto-start the round
  // from the existing plan (bridges disk state into SQL).
  return { round, needsPlan: false, autoStart: true };
}

// Pure builder for the per-phase completion Telegram ping (brief P2 part
// 3/3 — report mode). Extracted so the verify_outcome branch is
// unit-testable without mocking runDev/notifier — mirrors phase-runner.js's
// own split between formatVerifyOutcomeLine (pure) and its thin call site.
export function buildPhaseCompletionNotifyText({ projectName, phaseN, lastN, title, sha8, branch, isLast, verifyOutcome, forecast = null }) {
  // v0.15.0/P2: surface a noteworthy (non-pass) acceptance-check verdict on
  // the same ping — report mode already logged it server-side and never
  // blocks completion; this just carries it to Telegram.
  const verifyLine = (verifyOutcome && verifyOutcome.status !== 'pass')
    ? `\n${formatVerifyOutcomeLine(`Phase ${phaseN}`, verifyOutcome).text}`
    : '';
  // Phase 63 (P7): when the pre-flight forecast says the rest of the run won't
  // fit the current 5h window, append the one-liner so the operator learns
  // "will pause at phase 9" from the phone WITHOUT log spelunking. Empty string
  // (and thus no extra line) whenever the run fits or no forecast was passed.
  const forecastLine = formatForecastWindowLine(forecast);
  return `✓ Phase ${phaseN}/${lastN} — ${title}\n` +
         `📦 <b>${projectName}</b> · <code>${sha8}</code> · ${branch}` +
         verifyLine +
         (forecastLine ? `\n${forecastLine}` : '') +
         (isLast ? '\n\n🏁 All phases complete — awaiting final review / QA.' : '');
}

// Phase 19 (brief P2, auto-refresh + notice half): pick up the one-time
// external-drift notice phase-runner.js's loadContextFreshnessCheck already
// decided AND console.warn'd/persisted (result._context_freshness.notifyText,
// attached by runGuide/runTwoStageAudit/runDev regardless of caller) and push
// it to Telegram — mirrors buildPhaseCompletionNotifyText's call site below
// (auto-runner.js is the one caller in this codebase that reliably has a live
// notifier for both guide and dev spawns). Best-effort: the notice was already
// decided/persisted/logged by phase-runner.js, so a delivery failure here
// never re-fires it and never fails the caller.
// `project` (Phase 58) is an optional 3rd arg — auto-runner.js's own call
// sites pass their in-scope `projectName` so the outbox row this now queues
// unconditionally carries it; job-runner.js's pre-existing call sites (2-arg,
// unchanged) leave it null, which is fine — that path already has a live
// notifier and gets the fast-path delivery either way.
export async function notifyContextDriftIfAny(result, notifier, project = null) {
  const text = result?._context_freshness?.notifyText;
  if (!text) return;
  await queueAndNotify({ notifier, project, text });
}

// Phase 22 (brief P3, notify-wiring half): sibling to notifyContextDriftIfAny
// above — same shape, different source field (result._guide_reground.notifyText,
// attached by runGuide only; runTwoStageAudit/runDev never re-ground so their
// results never carry this field). Best-effort for the same reason: the
// reground ACTION (handoff generation, session clear, metadata stamp) already
// happened inside runGuide() regardless of whether this notice is delivered.
export async function notifyGuideRegroundIfAny(result, notifier, project = null) {
  const text = result?._guide_reground?.notifyText;
  if (!text) return;
  await queueAndNotify({ notifier, project, text });
}

async function executeAction(action, { projectName, brief, cfg, notifier = null, slot = 1, runId = null }) {
  if (action.kind === 'guide') {
    const result = await runGuide({
      projectName, task: action.task, brief, round: action.round, fix: action.fix, slot,
      reviewMode: action.reviewMode, reviewBatch: action.reviewBatch, reviewChangedFiles: action.reviewChangedFiles,
      // Phase 52 (par-03, verdict correction 2): pass the review action's OWN
      // phaseN so runGuide names reviewPath/the prompt by it rather than
      // re-deriving from project.current_phase. In the synchronous path this
      // is a verified no-op — action.phaseN === completedPhase === current_phase
      // when the review dispatches, nothing having advanced between
      // pickNextAction and here — but it hardens the labeling against any future
      // drift and keeps the sync/async review calls symmetric. Non-review guide
      // actions carry no phaseN, so runGuide falls back to current_phase exactly
      // as before.
      phaseN: action.phaseN,
    });
    await notifyContextDriftIfAny(result, notifier, projectName);
    await notifyGuideRegroundIfAny(result, notifier, projectName);
    // When guide generates a new plan, reset current_phase so the auto-runner
    // starts from phase 1 of the NEW plan rather than carrying over stale state.
    if (action.task === 'plan' && !result.is_error) {
      try {
        const projDir = path.join(PROJECTS_DIR, projectName);

        // v0.14.36/41: mechanical structure validation BEFORE anything trusts
        // the plan — extracted to ensureValidPlan so the pipeline's pre-plan
        // path (which bypasses executeAction) gets the identical gate.
        const ev = await ensureValidPlan({ projectName, projDir, brief, slot, cfg });
        if (!ev.ok) {
          return { ...(ev.regen || result), is_error: true, error_message: ev.error };
        }
        const plan = ev.plan;
        fs.unlink(path.join(projDir, '.guide', 'plan-fix.hint')).catch(() => {});

        const n = plan?.phases?.length || 0;
        const maxN = n > 0 ? plan.phases[n - 1].n : 0;
        resetProjectForNewPlan(projectName, maxN);
        recordRunEvent(runId, 'plan-created', { project: projectName, phases: n });

        // Snapshot brief.md → .guide/briefs/vN-ts.md so ongoing phases always
        // read the brief the plan was built from. Updating brief.md mid-dev
        // (for the next sprint) won't affect the current plan's guide/dev calls.
        try {
          const snap = await snapshotBrief(projDir);
          plan.brief_snapshot = snap.relPath;
          await fs.writeFile(planJsonPath(projDir), JSON.stringify(plan, null, 2), 'utf-8');
          console.log(chalk.dim(`  Brief snapshot → ${snap.relPath} (v${snap.version})`));
        } catch (snapErr) {
          console.log(chalk.dim(`  Brief snapshot skipped: ${snapErr.message}`));
          // Clear any bad brief_snapshot the guide may have written into the plan
          // (e.g. a bare brief name instead of a proper .guide/briefs/vN-ts.md path).
          // Without this, activeBriefPath resolves a non-existent file → briefHash
          // returns null → the conformance gate loops forever re-running the check.
          if (plan.brief_snapshot) {
            delete plan.brief_snapshot;
            await fs.writeFile(planJsonPath(projDir), JSON.stringify(plan, null, 2), 'utf-8').catch(() => {});
            console.log(chalk.dim(`  Cleared invalid brief_snapshot from plan.json`));
          }
        }

        // Reset plan-coverage.md so the coverage gate re-validates for this new plan.
        fs.unlink(planCoveragePath(projDir)).catch(() => {});

        // Strip any stale normalization sentinel from the new plan so the
        // continuation guard treats it as fresh and can normalize correctly.
        if (plan._normalization_base != null) {
          delete plan._normalization_base;
          await fs.writeFile(planJsonPath(projDir), JSON.stringify(plan, null, 2), 'utf-8').catch(() => {});
        }
        await archiveSupersededPhases(projDir, plan);
        if (n > 0) {
          const planTitle = plan.display_name || plan.title || projectName;
          void queueAndNotify({
            notifier, project: projectName,
            text: `📋 <b>New plan ready</b> — ${planTitle}\n` +
                  `<b>${projectName}</b> · ${n} phase${n !== 1 ? 's' : ''} to execute\n\n` +
                  `Run <code>/run ${projectName} go</code> to start.`,
          });
        }
      } catch { /* non-fatal — plan write is guide's job */ }
    }
    // When guide writes a fix plan, validate it under the output contract (P1b)
    // and update the DB row with the file path + fix count. This REPLACES the
    // pre-phase-77 silent try/catch: a malformed fix-plan.json now drives exactly
    // ONE session-resumed re-ask naming the file + ajv errors (the guide rewrites
    // it in-session), then — still failing — logs a WARNING and proceeds
    // FAIL-OPEN. The bug-cycle control flow is UNCHANGED either way: pickBugAction
    // already re-dispatches bug-plan when fixes is absent/non-array, so a bad plan
    // that survives the contract degrades exactly as it did before.
    if (action.task === 'bug-plan' && !result.is_error) {
      await applyFixPlanContract({ result, projectName, round: action.round, cfg });
    }
    return result;
  }
  if (action.kind === 'dev') {
    recordRunEvent(runId, 'phase-started', { project: projectName, phase: action.phaseN });
    // Phase 51 (P1 async report-mode): defer the inline acceptance check when
    // the resolved config opts in (verify.mode:'report' + verify.async_report)
    // — runDev's own shouldDeferAcceptanceCheck decides whether this actually
    // takes effect; every other combination (gate mode, async_report:false)
    // is unaffected by passing this flag.
    const result = await runDev({ projectName, deferVerify: true });
    await notifyContextDriftIfAny(result, notifier, projectName);
    recordRunEvent(runId, result.is_error ? 'dev-failed' : 'dev-completed', { project: projectName, phase: action.phaseN });
    if (result.is_error) {
      // v0.14.36 → phase-23: failure-driven escalation. Any dev failure (agent
      // error, no-commit, validator-gate failure) marks the phase so its NEXT
      // attempt runs one rung higher. The single writeEscalationMarker helper
      // computes the tier-relative target (a top-tier failure writes NOTHING →
      // pause). The marker is cleared by runDev on completion.
      try {
        const projDir = path.join(PROJECTS_DIR, projectName);
        const failureText = result.error_message || result.result || 'dev error';
        if (!isCapabilityEscalationFailure(failureText)) {
          await Promise.all([
            fs.unlink(escalationMarkerPath(projDir, { phaseN: action.phaseN })).catch(() => {}),
            fs.unlink(legacyEscalationMarkerPath(projDir, { phaseN: action.phaseN })).catch(() => {}),
          ]);
          console.log(chalk.dim(`  → No model escalation marker: environmental failure (${String(failureText).slice(0, 100)})`));
        } else {
        const failedTier = failedTierFromResult(result, cfg);
        const { written, targetTier } = await writeEscalationMarker({
          projDir, phaseN: action.phaseN, failedTier,
          reason: `dev failed: ${String(failureText).slice(0, 300)}`,
          at: new Date().toISOString(),
        });
        if (written) console.log(chalk.dim(`  → Escalation marker set: phase ${action.phaseN} re-runs on ${targetTier}`));
        else console.log(chalk.dim(`  → Phase ${action.phaseN} failed on top tier (${failedTier}) — no escalation marker (will pause)`));
        }
      } catch { /* non-fatal */ }
    }
    if (!result.is_error) {
      // v0.14.35: the hard gate inside runDev already validated (and attached
      // its outcome). Only fall back to the legacy post-hoc run when the gate
      // didn't run (e.g. project without git_branch).
      const validatorOutcome = result.validator_outcome
        ? summarizeOutcome(result.validator_outcome)
        : await runValidatorsForPhase({ projectName, phaseN: action.phaseN, cfg });
      if (validatorOutcome && validatorOutcome.hasFailures) {
        result._validation_failed = true;
        result._validator_summary = validatorOutcome.summary;
        recordRunEvent(runId, 'validator-failed', { project: projectName, phase: action.phaseN, summary: validatorOutcome.summary });
      }
      // Phase 57 (P1, run_events timeline) — the gate-mode (synchronous)
      // acceptance verdict; the deferred/report-mode equivalent is recorded
      // later, on its own tick, inside spawnDetachedVerify.
      if (result.verify_outcome) {
        const { effective_fail, unmet } = decideVerdict(result.verify_outcome.verdict || {});
        recordRunEvent(runId, effective_fail ? 'acceptance-fail' : 'acceptance-pass', { project: projectName, phase: action.phaseN, unmet: unmet.length });
      }
      // Per-phase ping so Prem can track progress during a long `go` run.
      // Phase 58 (notify_outbox): queued UNCONDITIONALLY — the `notifier &&`
      // guard is gone so a bare detached CLI launch (web spawnOrchestrator /
      // chat spawnDetached, both notifier:null) is no longer silent; the live
      // notifier, when present, is only the fast path inside queueAndNotify.
      // `!result._validation_failed` is a business gate (don't announce a phase
      // that failed validation), not a notifier guard.
      if (!result._validation_failed) {
        try {
          const projDir = path.join(PROJECTS_DIR, projectName);
          const plan = JSON.parse(await fs.readFile(planJsonPath(projDir), 'utf-8'));
          const phases = plan?.phases || [];
          // Use the last phase's actual n value, not the count. A continuation plan
          // with 11 phases numbered 52-62 should show "Phase 52/62", not "52/11".
          // Using .length caused every phase past n=11 to show "🏁 All phases complete".
          const lastN = phases.length > 0 ? phases[phases.length - 1].n : phases.length;
          const phaseMeta = phases.find((p) => p.n === action.phaseN);
          const title = phaseMeta?.title || `phase ${action.phaseN}`;
          const sha8 = result.git_result?.commit_sha?.slice(0, 8) || '?';
          const branch = result.git_result?.branch || '?';
          const isLast = action.phaseN >= lastN;
          // Phase 63 (P7): best-effort window forecast of the REMAINING run from
          // here, so the ping can warn "will pause at phase 9" when it won't
          // fit. Deterministic, zero LLM; a hiccup just drops the extra line.
          let forecast = null;
          if (!isLast) {
            try { forecast = await forecastRun(projectName); } catch { /* advisory only */ }
          }
          await queueAndNotify({
            notifier, project: projectName,
            text: buildPhaseCompletionNotifyText({
              projectName, phaseN: action.phaseN, lastN, title, sha8, branch, isLast,
              verifyOutcome: result.verify_outcome, forecast,
            }),
          });
        } catch { /* non-fatal — plan read / text build */ }
      }
    }
    return result;
  }
  if (action.kind === 'fix-dev') {
    recordRunEvent(runId, 'fix-started', { project: projectName, phase: action.fix?.n ?? null, round: action.fix?.round ?? null });
    const result = await runDev({ projectName, fix: action.fix });
    await notifyContextDriftIfAny(result, notifier, projectName);
    // No distinct 'fix-failed' kind in the documented vocabulary — a failed
    // fix shares 'dev-failed' with a failed phase; success gets its own
    // 'fix-completed' below (fixes have their own bookkeeping, recordFixCompletion).
    if (result.is_error) {
      recordRunEvent(runId, 'dev-failed', { project: projectName, phase: action.fix?.n ?? null, round: action.fix?.round ?? null });
      // v0.14.38 → phase-23: fixes get failure-driven escalation too — the
      // marker routes the re-run (in-run auto-retry or a later /resume) one rung
      // higher, through the single writeEscalationMarker helper.
      try {
        const projDir = path.join(PROJECTS_DIR, projectName);
        const failureText = result.error_message || result.result || 'fix error';
        if (!isCapabilityEscalationFailure(failureText)) {
          await Promise.all([
            fs.unlink(escalationMarkerPath(projDir, { fix: action.fix })).catch(() => {}),
            fs.unlink(legacyEscalationMarkerPath(projDir, { fix: action.fix })).catch(() => {}),
          ]);
          console.log(chalk.dim(`  → No model escalation marker: environmental fix failure (${String(failureText).slice(0, 100)})`));
        } else {
        const failedTier = failedTierFromResult(result, cfg);
        const { written, targetTier } = await writeEscalationMarker({
          projDir, fix: action.fix, failedTier,
          reason: `fix failed: ${String(failureText).slice(0, 300)}`,
          at: new Date().toISOString(),
        });
        if (written) console.log(chalk.dim(`  → Escalation marker set: fix r${action.fix.round}-${action.fix.n} re-runs on ${targetTier}`));
        else console.log(chalk.dim(`  → fix r${action.fix.round}-${action.fix.n} failed on top tier (${failedTier}) — no escalation marker (will pause)`));
        }
      } catch { /* non-fatal */ }
    }
    if (!result.is_error) {
      recordFixCompletion({ project: projectName, round: action.fix.round, fixN: action.fix.n });
      recordRunEvent(runId, 'fix-completed', { project: projectName, phase: action.fix.n, round: action.fix.round });
      const validatorOutcome = result.validator_outcome
        ? summarizeOutcome(result.validator_outcome)
        : await runValidatorsForFix({ projectName, fix: action.fix, cfg });
      if (validatorOutcome && validatorOutcome.hasFailures) {
        result._validation_failed = true;
        result._validator_summary = validatorOutcome.summary;
        recordRunEvent(runId, 'validator-failed', { project: projectName, phase: action.fix.n, round: action.fix.round, summary: validatorOutcome.summary });
      }
    }
    return result;
  }
  throw new Error(`Unknown action kind: ${action.kind}`);
}

async function runValidatorsForPhase({ projectName, phaseN, cfg }) {
  if (cfg?.validators?.enabled === false) return null;
  const projDir = path.join(PROJECTS_DIR, projectName);
  let phaseTitle = '';
  try {
    const plan = JSON.parse(await fs.readFile(planJsonPath(projDir), 'utf-8'));
    phaseTitle = plan?.phases?.find((p) => p.n === phaseN)?.title || '';
  } catch { /* ignore */ }
  const outcome = await runValidators({
    projectName,
    event: { phase: phaseN, phaseTitle },
    defaultTimeoutMs: cfg?.validators?.default_timeout_ms ?? 60000,
  });
  return summarizeOutcome(outcome);
}

async function runValidatorsForFix({ projectName, fix, cfg }) {
  if (cfg?.validators?.enabled === false) return null;
  const outcome = await runValidators({
    projectName,
    event: { fixRound: fix.round, fixN: fix.n, fixTitle: fix.title || '' },
    defaultTimeoutMs: cfg?.validators?.default_timeout_ms ?? 60000,
  });
  return summarizeOutcome(outcome);
}

function summarizeOutcome(outcome) {
  if (!outcome) return null;
  const failed = outcome.results.filter((r) => !r.pass).map((r) => r.validator_name);
  return {
    ...outcome,
    summary: failed.length
      ? `validators failed: ${failed.join(', ')}`
      : outcome.skipped ? `skipped: ${outcome.skipped}` : 'all validators passed',
  };
}

// Phase 77 (brief 08 / P1b) — adapt validatePlanStructure to the output
// contract's {ok,value}|{ok:false,errors} shape. This is the SOLE plan-
// validation code path: the contract re-ask in ensureValidPlan and its initial
// + sentinel-guard checks all delegate here, which delegates to the single
// validatePlanStructure in plan-validate.js. No second plan validator exists.

// The largest per-phase turn budget THIS project is actually configured to
// spend, across the per-complexity budgets and the explicit per-phase/tier
// caps. Used as the floor for the plan-validation turn target below.
export function effectiveTurnBudgetCeiling(cfg) {
  const p = cfg?.phases || {};
  const nums = [];
  const collect = (obj) => {
    if (obj && typeof obj === 'object') {
      for (const v of Object.values(obj)) { const n = Number(v); if (Number.isFinite(n) && n > 0) nums.push(n); }
    }
  };
  collect(p.turn_budget_by_complexity);
  collect(p.max_turns_per_tier);
  const opus = Number(p.max_turns_per_opus_phase); if (Number.isFinite(opus) && opus > 0) nums.push(opus);
  return nums.length ? Math.max(...nums) : 0;
}

export function buildTurnPredictionConfig(cfg, samples = []) {
  const policy = cfg?.phases?.turn_prediction;
  if (!policy || policy.enabled !== true) return null;
  // The plan-validation turn target must track the project's OWN turn budget,
  // not a fixed 45. A phase predicted at N turns is only a *structural* problem
  // if N exceeds what THIS project can actually run — a project that raises
  // turn_budget_by_complexity / max_turns_per_opus_phase (e.g. acf at 90-140
  // with warm-session continuation) intends large phases, and rejecting its
  // well-scoped plan against a global 45-turn target decoupled from that budget
  // is a false positive that stalls the whole run/brief-chain. Take the MAX of
  // the configured target and the budget ceiling so raised-budget projects get
  // a correspondingly higher target while an explicit target can still raise it
  // further; the guard never blocks a phase the project is budgeted to run.
  const configuredTarget = Number(policy.max_predicted_turns);
  const target = Math.max(
    Number.isFinite(configuredTarget) && configuredTarget > 0 ? configuredTarget : 45,
    effectiveTurnBudgetCeiling(cfg),
  );
  return {
    enabled: true,
    samples: Array.isArray(samples) ? samples : [],
    max_predicted_turns: target,
    min_samples: policy.min_samples ?? 12,
    min_confidence: policy.min_confidence ?? 0.25,
    enforce_heuristic: policy.enforce_heuristic === true,
  };
}

function planStructureContractValidator({ currentPhase = 0, turnPrediction = null } = {}) {
  return (plan) => {
    const sv = validatePlanStructure(plan, { currentPhase, turnPrediction });
    return sv.ok ? { ok: true, value: plan } : { ok: false, errors: sv.problems };
  };
}

// v0.14.41: shared plan structural gate (extracted from executeAction's
// post-plan block) — numbering, required fields, acceptance criteria,
// reachability. Problems → ONE auto-regen with the problem list injected via
// .guide/plan-fix.hint → re-validate. Used by executeAction AND pipeline.js
// (whose pre-plan path bypassed the gate entirely pre-.41).
// Returns { ok:true, plan } or { ok:false, error, regen? }.
//
// Phase 77 (brief 08 / P1b): the one auto-regen is now expressed as the output
// contract's single re-ask (runWithContract artifact seam on plan.json), whose
// validator is `planStructureContractValidator` — a thin wrapper over the SAME
// validatePlanStructure the initial check and the manual-fix sentinel guard use.
// So the contract and the BLOCKER auto-regen share ONE plan-validation code path
// (no second validator). The re-ask MECHANISM is unchanged from pre-77: write
// the problem list to .guide/plan-fix.hint, set the structRegenMarker sentinel,
// dispatch a fresh `plan` guide call, re-read + re-validate. Every prior return
// shape is preserved for pipeline.js. cfg/deps are optional and additive.
export async function ensureValidPlan({ projectName, projDir, brief = null, slot = 1, cfg = null, deps = {} }) {
  const runGuideFn = deps.runGuide ?? runGuide;
  const runWithContractFn = deps.runWithContract ?? runWithContract;
  const hintPath = path.join(projDir, '.guide', 'plan-fix.hint');
  const structRegenMarker = path.join(projDir, '.guide', '.plan-struct-regen-attempted');
  const currentPhase = getProject(projectName)?.current_phase || 0;
  const recentFeaturesFn = deps.recentPhaseExecutionFeatures ?? recentPhaseExecutionFeatures;
  const predictionPolicy = cfg?.phases?.turn_prediction;
  const predictionSamples = predictionPolicy?.enabled === true
    ? recentFeaturesFn({
      taskKind: 'dev-execution',
      limit: Math.max(1, Number(predictionPolicy.history_limit ?? 200) || 200),
    })
    : [];
  const turnPrediction = buildTurnPredictionConfig(cfg, predictionSamples);

  // The single plan-validation code path (P1b) — validatePlanStructure adapted
  // to the {ok,value}|{ok,errors} contract shape. Reused by the initial check
  // below AND passed as the contract validator for the re-ask.
  const planValidate = planStructureContractValidator({ currentPhase, turnPrediction });

  // The artifact seam: (re-)read plan.json from disk and structurally validate.
  const readAndValidatePlan = async () => {
    let plan;
    try { plan = JSON.parse(await fs.readFile(planJsonPath(projDir), 'utf-8')); }
    catch (e) { return { ok: false, errors: [`regenerated plan.json unparseable: ${e.message}`] }; }
    return planValidate(plan);
  };

  // Initial read + structural check (unparseable here is a hard error — no regen).
  let firstPlan;
  try { firstPlan = JSON.parse(await fs.readFile(planJsonPath(projDir), 'utf-8')); }
  catch (e) { return { ok: false, error: `plan.json missing or unparseable after plan generation: ${e.message}` }; }

  const first = planValidate(firstPlan);
  if (first.ok) {
    // Clear both regen sentinels — a clean plan resets both budgets.
    fs.unlink(structRegenMarker).catch(() => {});
    fs.unlink(path.join(projDir, '.guide', '.coverage-regen-attempted')).catch(() => {});
    return { ok: true, plan: firstPlan };
  }

  // Structural-regen sentinel — mirrors .coverage-regen-attempted budget pattern.
  // A second structurally-invalid plan returns a manual-fix error instead of
  // dispatching an unbounded second regen.
  if (await fileExists(structRegenMarker)) {
    console.error(chalk.red(`✗ Plan still fails structural validation after 1 auto-regen — manual fix required.`));
    return { ok: false, error: 'plan failed structural validation after 1 auto-regen -- manual fix required' };
  }

  // One auto-regen == the output contract's single re-ask. The re-ask body IS
  // the pre-77 regen (hint file + sentinel + fresh `plan` call); the contract
  // supplies the bounded ladder + the shared re-validate. maxReasks is pinned at
  // 1 (the historical one-regen budget) regardless of cfg.llm_contract.max_reasks
  // — the structRegenMarker is the cross-invocation guard, and a >1 in-call regen
  // loop was never part of the plan gate's contract.
  const problemText = formatPlanProblems(first.errors);
  let regenResult = null;
  let firstAttempt = true;
  const planCallSeam = async () => {
    if (firstAttempt) {
      firstAttempt = false; // initial "attempt" reuses the plan the guide already wrote — no spawn
      return { result: '(existing plan.json)', session_id: null, is_error: false };
    }
    console.warn(chalk.yellow(`⚠ Plan failed structural validation (${first.errors.length} problem(s)) — one auto-regen:\n${problemText}`));
    await fs.mkdir(path.dirname(hintPath), { recursive: true });
    await fs.writeFile(hintPath, problemText, 'utf-8');
    await fs.writeFile(structRegenMarker, new Date().toISOString(), 'utf-8').catch(() => {});
    regenResult = await runGuideFn({ projectName, task: 'plan', brief, slot });
    if (regenResult.is_error) {
      const err = new Error(`plan regen after structural validation failed: ${regenResult.error_message || regenResult.result || 'guide error'}`);
      err.__regen = regenResult;
      throw err;
    }
    return { result: '(regenerated plan.json)', session_id: null, is_error: false };
  };

  const outcome = await runWithContractFn({
    baseCall: { cfg: cfg || {}, cwd: projDir, role: 'guide', project: projectName, task: 'plan-creation' },
    prompt: '(plan already generated)',
    artifactReader: readAndValidatePlan,
    filePath: planJsonPath(projDir),
    maxReasks: 1,
    escalateOnSecondFail: false,
    runClaude: planCallSeam,
  }).catch((err) => ({ ok: false, errors: [err.message], __regen: err.__regen }));

  if (outcome.ok) {
    console.log(chalk.green(`✓ Regenerated plan passes structural validation.`));
    return { ok: true, plan: outcome.value };
  }
  if (outcome.__regen) {
    return { ok: false, regen: outcome.__regen, error: `plan regen after structural validation failed: ${outcome.__regen.error_message || outcome.__regen.result || 'guide error'}` };
  }
  console.error(chalk.red(`✗ Regenerated plan STILL fails structural validation — stopping.`));
  return { ok: false, regen: regenResult, error: `plan failed structural validation after 1 auto-regen:\n${formatPlanProblems(outcome.errors || [])}` };
}

// ─── Phase 79 (P2) — window-aware heavy-action pause ─────────────────────────

// The action kinds that spawn a HEAVY window-consuming run: a dev/phase
// execution, or an audit guide call. Everything else (reviews, plan, bug-plan,
// handoff, etc.) is cheap enough to let through even at 'warn'.
function isHeavyNextAction(action) {
  if (!action) return false;
  if (action.kind === 'dev') return true;
  if (action.kind === 'guide' && action.task === 'audit') return true;
  return false;
}

// Deterministic (no-LLM) estimate of how many heavy-equivalent window units the IMMEDIATE next
// heavy action will burn, from predictUpcoming's per-unit stream. For a 'dev'
// action count the units tagged with the phase about to run (dev-execution +
// any inline acceptance-check / prompt-gen for that phase). Anything not pinned
// to a single phase (audit, bug-round dev) returns null → caller uses the config
// constant instead.
function estimateNextHeavyCalls(prediction, action) {
  if (!prediction || !Array.isArray(prediction.units)) return null;
  if (action.kind === 'dev' && action.phaseN != null) {
    const n = prediction.units.filter((u) => u.phase === action.phaseN).length;
    return n > 0 ? n : null;
  }
  return null;
}

/**
 * Phase 79 (P2) — pause a run cleanly BEFORE dispatching a heavy next action
 * (dev-execution / audit) when the shared billing window is 'warn' and the
 * projected headroom (pause_at_calls − heavy-equivalent callsInWindow) can't
 * fit that action.
 * Rather than racing the pause threshold and dying mid-phase, it stamps the run
 * paused (pause_reason='window-headroom') and enqueues a 'resume' job whose
 * not_before is the projected window reset (oldestCallAt + window_reset_hours),
 * so the run resumes automatically once the window frees up.
 *
 * Only 'warn' gates: 'ok' has room (proceed) and 'pause' has already hard-stopped
 * at spawn (claude-runner.js) — this never front-runs that backstop. The headroom
 * estimate is predictUpcoming's per-phase unit count when available, else the
 * config constant billing.window_headroom_min_calls (default 4). predictUpcoming
 * is deterministic (no LLM/window call) but heavy + can throw — a throw degrades
 * to the constant. billing.window_headroom_pause:false opts the whole gate out.
 * NEVER throws: enqueue/pause failures are swallowed so a hiccup can't crash a
 * run (it simply proceeds; the hard pause_at_calls stop remains the backstop).
 *
 * Exported + deps-seamed (windowStatus / predictUpcoming / enqueueRetryJob /
 * pauseAutoRun) for unit testing with a stubbed window and no real spawn.
 *
 * @returns {Promise<{paused:boolean, reason?:string, pauseKind?:string, notBefore?:Date, resumeJobId?:number}>}
 */
export async function maybePauseForWindowHeadroom({ cfg, projectName, action, runId, requestedBy = null }, deps = {}) {
  const _windowStatus = deps.windowStatus ?? windowStatus;
  const _predictUpcoming = deps.predictUpcoming ?? predictUpcoming;
  const _enqueueUniqueResumeJob = deps.enqueueUniqueResumeJob
    ?? (deps.enqueueRetryJob
      ? (job) => ({ scheduled: true, jobId: deps.enqueueRetryJob({ ...job, action: 'resume' }) })
      : enqueueUniqueResumeJob);
  const _pauseAutoRun = deps.pauseAutoRun ?? pauseAutoRun;

  if (cfg?.billing?.window_headroom_pause === false) return { paused: false }; // explicit opt-out
  if (!isHeavyNextAction(action)) return { paused: false };

  const ws = _windowStatus(cfg);
  if (ws.state !== 'warn') return { paused: false }; // ok=room; pause=hard-stopped upstream

  const constMin = Number.isInteger(cfg?.billing?.window_headroom_min_calls)
    ? cfg.billing.window_headroom_min_calls : 4;
  let needed = constMin;
  try {
    const est = estimateNextHeavyCalls(await _predictUpcoming(projectName), action);
    if (Number.isFinite(est) && est > 0) needed = est;
  } catch { /* predictUpcoming is best-effort — fall back to the constant */ }

  const remaining = Math.max(0, (ws.pauseThreshold ?? 0) - (ws.callsInWindow ?? 0));
  if (remaining >= needed) return { paused: false }; // enough headroom — proceed

  // Insufficient headroom → pause + schedule a resume for the projected reset.
  // Use ws.pauseClearAt (the exact time units drop below threshold) rather
  // than oldestCallAt+hours — cheap calls expiring first don't always clear
  // the window, causing a premature retry and wasting a full retry interval.
  //
  // Schedule the FIRST retry ~60 min BEFORE clearMs so the transient-retry
  // cadence in job-runner lands at clearMs+5min (the actual unblock). This
  // gives: pre-check 60min early → transient-retry reschedules at resetsAt+5min
  // → succeeds. If clearMs is <65min away, fall back to clearMs directly.
  const hours = cfg?.billing?.window_reset_hours || 5;
  // In warn state units < pauseCalls is always true, so ws.pauseClearAt is null.
  // Use ws.warnClearAt (targets warnThreshold) to get the actual resume time.
  const clearMs = (ws.warnClearAt ?? ws.pauseClearAt) ?? (ws.oldestCallAt
    ? new Date(ws.oldestCallAt).getTime() + hours * 3600 * 1000
    : Date.now() + hours * 3600 * 1000);
  const PRE_CHECK_LEAD_MS = 60 * 60 * 1000; // 60 min before clearMs
  const MIN_DELAY_MS = 5 * 60 * 1000;       // never fire in <5 min
  const earlyMs = clearMs - Date.now() < PRE_CHECK_LEAD_MS
    ? clearMs  // clearMs is close; wait for it directly instead of a tight retry loop
    : Math.max(clearMs - PRE_CHECK_LEAD_MS, Date.now() + MIN_DELAY_MS);
  const notBefore = new Date(earlyMs);
  // resetsAt baked into the reason still reflects the TRUE clear time so that
  // the transient-retry cadence can target it precisely on the follow-up.
  const reason = `${PAUSE_KINDS.WINDOW_HEADROOM} {"resetsAt": ${Math.ceil(clearMs / 1000)}}`;
  let resumeJobId = null;
  try {
    const queued = _enqueueUniqueResumeJob({
      project: projectName, args: { unattended: true },
      requestedBy, notBefore, retryCount: 0,
      excludeJobId: getWorkerContext()?.jobId ?? null,
    });
    resumeJobId = queued.jobId;
  } catch (err) {
    console.warn(chalk.yellow(`[window-headroom] could not schedule resume job for ${projectName} (non-fatal): ${err.message}`));
  }
  // finalize() re-stamps this identically while doing pending-verify/mutex
  // cleanup; recording it here makes the seam self-contained + directly testable.
  try { _pauseAutoRun(runId, reason, PAUSE_KINDS.WINDOW_HEADROOM); } catch { /* finalize re-stamps */ }
  console.log(chalk.yellow(`  ⏸ Window headroom low (${ws.callsInWindow}/${ws.pauseThreshold} heavy-eq units, next heavy action needs ~${needed}) — pausing; resume scheduled for ${notBefore.toISOString()}`));
  return { paused: true, reason, pauseKind: PAUSE_KINDS.WINDOW_HEADROOM, notBefore, resumeJobId };
}

export function evaluatePause({ action, result, cfg, unattended }) {
  if (result.is_error) {
    // v0.14.38: honest pause messages. Fixes used to render as
    // "phase-undefined", and the reason showed the AGENT's final text (often a
    // cheerful "Done. Here's a summary…") instead of the orchestrator's actual
    // failure reason (validator gate, no-commit, …). error_message wins.
    const label = action.kind === 'fix-dev' && action.fix
      ? `fix r${action.fix.round}-${action.fix.n}`
      : `phase ${action.phaseN}`;
    const error = (result.error_message || result.result || 'see report')?.toString().slice(0, 300);
    return shouldPauseAfter('phase-error', cfg, { phaseN: action.phaseN, label, error, unattended });
  }
  if (result._validation_failed) {
    return { pause: true, reason: result._validator_summary || 'validators failed' };
  }
  if (action.kind === 'dev') {
    // Phase 64 — forward totalPhases (Layer 1 min_total_phases) and
    // nextPhaseCheckpoint (mode:'intent' next-phase tag) from the action ctx.
    return shouldPauseAfter('phase-completed', cfg, {
      phaseN: action.phaseN, isFinal: action.isFinal,
      totalPhases: action.totalPhases, nextPhaseCheckpoint: action.nextPhaseCheckpoint,
      unattended,
    });
  }
  if (action.kind === 'guide' && action.task === 'review') {
    return shouldPauseAfter('review-completed', cfg, { phaseN: action.phaseN, unattended });
  }
  if (action.kind === 'fix-dev') {
    return shouldPauseAfter('fix-completed', cfg, { isFinalFix: action.isFinalFix, unattended });
  }
  return { pause: false };
}

// Phase 68-70 parallel paths (wave / fix-batch / single-call-batch) complete via
// `continue` and never reach the serial evaluatePause below, so without this every
// completion-based checkpoint (auto_pause_after_phase_1/final_phase/phases,
// checkpoint_policy intent mode, budget-warn soft pause) was silently skipped for
// parallelized work — the very boundary lane-manager stops the wave at. This
// reconstructs the completed-action ctx for the HIGHEST merged phase (or the
// round's fix-completion state) and evaluates the identical pause the serial path
// would. Returns { pause, reason }.
export async function evaluateParallelPause({ kind, cfg, unattended, projDir, projectName, mergedPhases, round }) {
  if (kind === 'dev') {
    if (!mergedPhases?.length) return { pause: false };
    const plan = await readJson(planJsonPath(projDir));
    if (!plan?.phases?.length) return { pause: false };
    const lastN = mergedPhases[mergedPhases.length - 1];
    const totalPhases = plan.phases.length;
    const lastPhaseN = plan.phases[totalPhases - 1].n;
    return evaluatePause({
      action: {
        kind: 'dev', phaseN: lastN,
        isFinal: lastN === lastPhaseN,
        totalPhases, nextPhaseCheckpoint: nextCheckpointAfter(plan, lastN),
      },
      result: { is_error: false }, cfg, unattended,
    });
  }
  if (kind === 'fix') {
    const fresh = getCurrentBugRound(projectName);
    const fixPlan = await readJson(fixPlanJsonPath(projDir, round));
    if (!fresh || !fixPlan?.fixes?.length) return { pause: false };
    const isFinalFix = (fresh.fixes_completed || 0) >= fixPlan.fixes.length;
    return evaluatePause({
      action: { kind: 'fix-dev', isFinalFix }, result: { is_error: false }, cfg, unattended,
    });
  }
  return { pause: false };
}

async function tryReviewAutoProceed({ action, cfg, projDir, projectName = null, runId = null }) {
  const threshold = cfg.auto_run?.review_auto_proceed_score_threshold;
  if (typeof threshold !== 'number') return false;

  const rPath = reviewPath(projDir, action.phaseN);
  let text;
  try { text = await fs.readFile(rPath, 'utf-8'); }
  catch { return false; } // report not found

  // A line that STARTS with 'BLOCKER:' (trimmed, case-insensitive) blocks auto-proceed.
  const lines = text.split('\n');
  // Markdown-bold variants (**BLOCKER:** …) count too — the prompt asks for a
  // bare prefix but doesn't enforce it, and a bolded blocker used to sail
  // straight past this gate.
  const hasBlocker = lines.some(l => /^(\*{1,2}|_{1,2})?\s*BLOCKER\s*(\*{1,2}|_{1,2})?\s*:/i.test(l.trim()));
  if (hasBlocker) {
    console.log(chalk.yellow(`  Review: BLOCKER line found — auto-proceed suppressed (threshold ${threshold})`));
    return false;
  }

  // The review's own mandatory trailer (`verdict: continue|pause-and-fix|replan`)
  // previously had NO machine consumer: a review concluding pause-and-fix with a
  // score over the threshold auto-proceeded anyway. The last verdict line wins;
  // a missing trailer falls through to the score gate as before.
  const verdictMatches = [...text.matchAll(/^\s*verdict:\s*(continue|pause-and-fix|replan)\b/gim)];
  if (verdictMatches.length) {
    const verdict = verdictMatches[verdictMatches.length - 1][1].toLowerCase();
    if (verdict !== 'continue') {
      console.log(chalk.yellow(`  Review verdict '${verdict}' — auto-proceed suppressed regardless of score`));
      recordRunEvent(runId, 'review-verdict', { project: projectName, phase: action.phaseN, verdict });
      return false;
    }
  }

  // Extract the score from a dedicated "score: N" line (anchored; last match wins
  // in case the guide writes multiple score lines — the final one is authoritative).
  const scoreMatches = [...text.matchAll(/^\s*score:\s*(\d+)\b/gim)];
  if (!scoreMatches.length) return false; // no scoreline — can't auto-proceed

  const score = parseInt(scoreMatches[scoreMatches.length - 1][1], 10);
  recordRunEvent(runId, 'review-verdict', { project: projectName, phase: action.phaseN, score });
  if (score >= threshold) {
    console.log(chalk.green(`  Review score ${score}/100 >= ${threshold} — auto-proceeding`));
    return true;
  }
  console.log(chalk.yellow(`  Review score ${score}/100 < ${threshold} — pausing for manual review`));
  return false;
}

// G5 stale-brief guard. Returns a wait-for-human action when inputs/brief.md and
// .guide/brief.md have DIFFERENT content. Compares SHA-256 content hashes, not
// mtime: cp -p preserves the source mtime (an mtime guard would never fire),
// atomic editor saves rename in a fresh mtime for identical bytes (false
// positive), and git stash/checkout flip mtimes either way — only the bytes are
// authoritative. Returns null when the content matches or either file is
// absent/unreadable (a null hash = cannot compare). Exported for unit-testing.
export async function checkStaleBriefGuard(projDir) {
  const inputsBriefPath = path.join(projDir, 'inputs', 'brief.md');
  const guideBriefPath  = briefPath(projDir);
  const [inputsHash, guideHash] = await Promise.all([
    briefHash(inputsBriefPath),
    briefHash(guideBriefPath),
  ]);
  // null hash = file missing/unreadable → cannot compare → skip cleanly.
  if (inputsHash === null || guideHash === null) return null;
  if (inputsHash !== guideHash) {
    return {
      kind:   'wait-for-human',
      reason: 'inputs/brief.md differs from .guide/brief.md — the active brief may be stale. '
            + 'Run: ashmero reset-brief <project> --go   (or /newbrief <project> on Telegram)',
    };
  }
  return null;
}

// Returns true only when the audit file's mtime falls within the current run.
// Exported for unit-testing; not intended to be called from outside auto-runner.
export async function shouldAutoPromoteAudit({ latestAudit, runStartMs }) {
  if (!latestAudit || typeof runStartMs !== 'number') return false;
  try {
    const { mtimeMs } = await fs.stat(latestAudit);
    return mtimeMs >= runStartMs;
  } catch {
    return false;
  }
}

async function maybeAutoPromoteAudit({ projDir, projectName }) {
  try {
    const r = await promoteAuditToBugs({ projDir, projectName });
    if (r.promoted) {
      console.log(chalk.green(`  Auto-promoted audit findings → bug round ${r.round}`));
      // Phase 43 (P7): surfaced so the caller can pause instead of silently
      // continuing into more fixes against a finding set that isn't landing.
      if (r.convergence_stall) {
        console.log(chalk.yellow(`  ⚠ convergence stall — ${(r.recurring || []).length} finding(s) recurring across rounds`));
      }
    } else {
      console.log(chalk.dim(`  Auto-promote: skipped — ${r.reason || 'no findings'}`));
    }
    return r;
  } catch (err) {
    console.log(chalk.yellow(`  Auto-promote audit: non-fatal error — ${err.message}`));
    return null;
  }
}

export async function shouldRunAutoBrief(projDir) {
  const rtPath = rawThoughtsPath(projDir);
  const bPath  = briefPath(projDir);
  try {
    const rtStat = await fs.stat(rtPath);
    if (rtStat.size <= 80) return false;
    let bMtime = 0;
    try { bMtime = (await fs.stat(bPath)).mtimeMs; } catch { /* brief.md doesn't exist */ }
    return rtStat.mtimeMs > bMtime;
  } catch {
    return false;
  }
}

/** Persist exactly one reset-time resume for a provider-limited project. */
export function scheduleProviderLimitResume({ projectName, reason }, deps = {}) {
  if (!projectName || !isProviderRateLimitError(reason)) {
    return { scheduled: false, reason: 'not-provider-limit' };
  }
  const nowMs = deps.nowMs ?? Date.now();
  const retryAt = deps.getRateLimitRetryAt ?? getRateLimitRetryAt;
  const retryAtMs = retryAt(reason, { retryWaitMinutes: 60, nowMs });
  const notBefore = new Date(Math.max(nowMs + 60_000, retryAtMs));

  // Preserve the dependency seam used by focused tests, but production goes
  // through the queue's single transactional check+insert. That closes the
  // race between auto-run finalize, job-runner, watchdog, and brief-chain.
  if (deps.enqueueRetryJob || deps.db) {
    const db = deps.db ?? getDb();
    const existing = db.prepare(`
      SELECT id FROM tg_jobs
      WHERE project = ? AND action = 'resume' AND status IN ('pending', 'running')
      LIMIT 1
    `).get(projectName);
    if (existing) return { scheduled: false, reason: 'already-scheduled', jobId: existing.id };
    const enqueue = deps.enqueueRetryJob ?? enqueueRetryJob;
    const jobId = enqueue({
      project: projectName, action: 'resume', args: { unattended: true },
      requestedBy: null, notBefore, retryCount: 0,
    });
    return { scheduled: true, jobId, notBefore };
  }

  const queued = (deps.enqueueUniqueResumeJob ?? enqueueUniqueResumeJob)({
    project: projectName, args: { unattended: true },
    requestedBy: null, notBefore, retryCount: 0,
    excludeJobId: getWorkerContext()?.jobId ?? null,
  });
  return queued.scheduled
    ? { scheduled: true, jobId: queued.jobId, notBefore }
    : { scheduled: false, reason: 'already-scheduled', jobId: queued.jobId };
}

async function finalize({ runId, status, reason, pauseKind = null, projectName, runStartTime, pendingVerify = null, pendingReview = null, notifier = null }) {
  // Phase 51 (P1 async report-mode) — the bounded-concurrency NFR: every
  // background verify promise is awaited here so an auto-run never exits
  // with an orphaned spawn. The promise itself never rejects (its own
  // .then/.catch chain in spawnDetachedVerify degrades on failure), so this
  // await can never throw — the try/catch is belt-and-braces only.
  if (pendingVerify?.promise) {
    try { await pendingVerify.promise; } catch { /* advisory-only, already logged */ }
  }
  // Phase 52 (par-03) — same NFR, same reasoning, for a still-outstanding
  // background review: the run is already ending on this path (paused/
  // completed/failed/cancelled), so its heal/auto-proceed/pause verdict is
  // moot — only the worktree cleanup + settle matter here.
  if (pendingReview?.promise) {
    try { await pendingReview.promise; } catch { /* advisory-only, already logged */ }
  }
  // Persist why an unfinished phase is safe to continue in the same session.
  // status='in-progress' alone is ambiguous: capability/validator failures
  // leave the same status but must start fresh (especially after a tier bump).
  // Only true external interruptions receive this provenance marker.
  let interruptionKind = null;
  if (isProviderRateLimitError(reason)) interruptionKind = 'provider-limit';
  else if (pauseKind === PAUSE_KINDS.WINDOW_HEADROOM || pauseKind === PAUSE_KINDS.BUDGET) interruptionKind = 'window-headroom';
  else if ((status === 'paused' || status === 'failed') && isTransientError(reason)) interruptionKind = 'network';
  if (projectName && interruptionKind) {
    try {
      markInProgressPhasesInterrupted(projectName, { kind: interruptionKind, reason });
    } catch (err) {
      console.warn(chalk.yellow(`[resume] could not persist phase interruption provenance: ${err.message}`));
    }
  }
  // Release the cross-process mutex on every terminal path.
  if (projectName) _releaseAutoRunMutex(projectName);

  if (status === 'paused') {
    // Provider limits must survive process/server restarts. The watchdog and
    // brief-chain are useful live-process conveniences, but neither is a
    // durable scheduler. Atomically avoid stacking a second pending resume for
    // the same project and persist one at the provider's parsed reset time.
    if (projectName && isProviderRateLimitError(reason)) {
      try {
        const scheduled = scheduleProviderLimitResume({ projectName, reason });
        if (scheduled.scheduled) console.log(chalk.yellow(`  ⏰ Provider-limit resume scheduled for ${scheduled.notBefore.toISOString()}`));
      } catch (err) {
        console.warn(chalk.yellow(`[provider-limit] could not persist resume job: ${err.message}`));
      }
    }
    const waitingForAutomaticResume = projectName
      && (isTransientError(reason) || pauseKind === PAUSE_KINDS.WINDOW_HEADROOM);
    if (waitingForAutomaticResume) setProjectStatus(projectName, 'paused');
    pauseAutoRun(runId, reason, pauseKind ?? null);
    // Phase 57 (P1, run_events timeline) — a specific kind for the two
    // pause reasons the vocabulary calls out by name; every other pause
    // kind (mid-build, max-actions, convergence-stall, etc.) is the generic
    // 'run-paused'.
    const pauseEventKind = pauseKind === PAUSE_KINDS.BUDGET ? 'budget-pause'
      : pauseKind === PAUSE_KINDS.REVIEW_CHECKPOINT ? 'checkpoint-pause'
      : 'run-paused';
    recordRunEvent(runId, pauseEventKind, { project: projectName, reason: (reason || '').toString().slice(0, 200) });
    // Phase 58 (notify_outbox) — a pause alert must reach the phone even for a
    // bare detached CLI launch (web spawnOrchestrator / chat spawnDetached,
    // both notifier:null): those never pass through job-runner.js, which is the
    // ONLY other pause-ping source. Queue the pause ONLY when there is no live
    // notifier — when there IS one (job-queue run), job-runner.js already sends
    // a richer pause ping with a next-actions keyboard, so queueing here too
    // would double-ping. queueNotify is sync + never-throws.
    if (!notifier) {
      queueNotify({
        project: projectName,
        text: `⏸ Paused: ${projectName || '<project>'}\n${(reason || '').toString().slice(0, 500)}`,
      });
    }
  } else if (status === 'completed') {
    completeAutoRun(runId);
    recordRunEvent(runId, 'run-completed', { project: projectName });
  } else {
    // failed, cancelled — real terminal statuses (the old pauseAutoRun path
    // recorded them as 'paused' rows that resetProjectForNewPlan later flipped
    // to 'aborted', so failures were invisible to any status query).
    endAutoRunTerminal(runId, status, reason);
    if (status === 'cancelled' && projectName) {
      setProjectStatus(projectName, 'cancelled');
    }
    // 'failed' does NOT update projects.status — job-runner marks the job failed
    // separately via markJobFailed; projects.status intentionally stays 'in-progress'
    // for failed runs (user should inspect, not automatically see "failed" project).
    // Design decision: failed auto-run ≠ failed project; cancelled auto-run = cancelled project.
  }

  // Print summary block (only if we have enough context — older code paths that
  // call finalize without runStartTime fall back to the legacy short message)
  if (projectName && runStartTime) {
    printRunSummary({ runId, status, reason, pauseKind, projectName, runStartTime });
  } else {
    if (status === 'paused')      console.log(chalk.yellow(`\n⏸  Paused: ${reason}`));
    else if (status === 'completed') console.log(chalk.green(`\n✓ ${reason}`));
    else                           console.log(chalk.red(`\n✗ ${status}: ${reason}`));
  }

  if (status === 'paused') {
    console.log(chalk.dim('Resume with: npm run resume -- ' + (projectName || '<project>')));
  }

  // Phase 62 — structured failure autopsy. Fired ONLY at the highest-friction
  // terminal states: an outright failure, or a pause on an error (mid-build) /
  // failed validator. Best-effort + never-throws + never-blocks: status is
  // already persisted above, so a slow/failed autopsy only delays this
  // function's return by at most phases.task_timeout_ms.autopsy and can never
  // change the run's outcome. Budget-guarded inside runAutopsy (a paused window
  // makes no LLM call).
  const wantAutopsy = shouldRunFailureAutopsy({ status, pauseKind, pauseReason: reason });
  if (wantAutopsy && projectName && runId != null) {
    try {
      const autopsyCfg = await resolveConfig({ project: projectName, task: 'autopsy' });
      await runAutopsy({ cfg: autopsyCfg, projectName, runId });
    } catch (err) {
      console.warn(chalk.yellow(`[autopsy] skipped (non-fatal): ${err.message}`));
    }
  }

  return { runId, status, reason, pauseKind: status === 'paused' ? (pauseKind ?? null) : null };
}

function printRunSummary({ runId, status, reason, pauseKind, projectName, runStartTime }) {
  const runEndTime = Date.now();
  const wallMs = runEndTime - runStartTime;
  const startedAt = new Date(runStartTime);
  const endedAt = new Date(runEndTime);

  // Query the calls table for this run's window
  const db = getDb();
  const calls = db.prepare(
    `SELECT task, model, cost_usd, input_tokens, output_tokens, is_error, duration_ms
     FROM calls
     WHERE project = ? AND started_at >= ?`,
  ).all(projectName, startedAt.toISOString());

  // Aggregate
  const byTask = {};
  let totalCost = 0;
  let totalIn = 0;
  let totalOut = 0;
  let errors = 0;
  let totalDur = 0;
  for (const c of calls) {
    byTask[c.task] = (byTask[c.task] || 0) + 1;
    if (c.cost_usd) totalCost += c.cost_usd;
    if (c.input_tokens) totalIn += c.input_tokens;
    if (c.output_tokens) totalOut += c.output_tokens;
    if (c.is_error) errors += 1;
    if (c.duration_ms) totalDur += c.duration_ms;
  }

  const banner = '─'.repeat(56);
  const symbol = status === 'completed' ? chalk.green('✓')
    : status === 'cancelled' ? chalk.yellow('⏹')
    : status === 'failed' ? chalk.red('✗')
    : chalk.yellow('⏸');
  const statusLabel = chalk.bold(
    status === 'completed' ? chalk.green('COMPLETED')
    : status === 'cancelled' ? chalk.yellow('CANCELLED')
    : status === 'failed' ? chalk.red('FAILED')
    : chalk.yellow('PAUSED'),
  );

  console.log('');
  console.log(chalk.dim(banner));
  console.log(`  ${symbol} ${statusLabel} — ${projectName}`);
  console.log(chalk.dim(banner));
  console.log(`  Started:        ${chalk.dim(formatTs(startedAt))}`);
  console.log(`  Ended:          ${chalk.dim(formatTs(endedAt))}`);
  console.log(`  Wall time:      ${chalk.bold(formatRunElapsed(wallMs))}`);
  console.log(`  Reason:         ${reason}`);
  console.log('');
  if (calls.length > 0) {
    console.log(chalk.bold(`  Calls in this run: ${calls.length}`)
      + (errors > 0 ? chalk.red(`  (${errors} error${errors === 1 ? '' : 's'})`) : ''));
    const taskRows = Object.entries(byTask).sort((a, b) => b[1] - a[1]);
    for (const [task, n] of taskRows) {
      console.log(`    ${task.padEnd(24)} ${chalk.bold(String(n).padStart(3))}`);
    }
    console.log('');
    const inK = (totalIn / 1000).toFixed(0);
    const outK = (totalOut / 1000).toFixed(0);
    console.log(`  Cost (Max-equiv): ${chalk.bold('$' + totalCost.toFixed(2))}`);
    console.log(`  Tokens:           in ${inK}K  out ${outK}K`);
    console.log(`  Time in calls:    ${formatRunElapsed(totalDur)}` + chalk.dim(`  (of ${formatRunElapsed(wallMs)} wall — rest is guide/dev I/O + thinking)`));
  } else {
    console.log(chalk.dim('  (no calls executed)'));
  }
  console.log(chalk.dim(banner));
  console.log('');

  // Next-actions hint
  try {
    let lastAction;
    if (status === 'completed') lastAction = 'auto-run-completed';
    else if (status === 'paused') lastAction = 'auto-run-paused';
    else if (status === 'failed') lastAction = 'auto-run-failed';
    else if (status === 'cancelled') lastAction = 'auto-run-cancelled';
    const proj = getProject(projectName);
    const state = {
      currentPhase: proj?.current_phase,
      totalPhases: proj?.total_phases,
      pauseReason: reason,
      pauseKind: pauseKind ?? null,
    };
    // Lazy import to keep dependency cycle clean
    import('./lib/next-actions.js').then(({ getNextActions, renderNextActionsCli }) => {
      const actions = getNextActions({ project: projectName, lastAction, state });
      const block = renderNextActionsCli(actions);
      if (block) process.stdout.write(block);
    }).catch(() => { /* silent */ });
  } catch { /* ignore */ }
}

function formatRunElapsed(ms) {
  if (!ms || ms < 1000) return '<1s';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function formatTs(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function printHeader({ projectName, unattended, dryRun, cfg }) {
  console.log(chalk.bold.cyan('\n═══ Auto-Runner ═══'));
  console.log(`Project: ${projectName}`);

  // Account display — read user.json synchronously
  const userCfg = readUserConfigSync();
  const email = userCfg?.claude_account?.email;
  const plan = userCfg?.claude_account?.plan || 'Max';
  if (email) {
    console.log(`Account: ${chalk.green(email)} (${plan})`);
  } else {
    console.log(`Account: ${chalk.yellow('not configured')} — run: npm run account -- --email <you@example.com>`);
  }

  console.log(`Mode: ${unattended ? chalk.yellow('UNATTENDED') : chalk.green('SUPERVISED')}${dryRun ? chalk.magenta(' (DRY RUN)') : ''}`);
  if (cfg.model_routing?.enabled) console.log(chalk.dim(`Model routing: ${chalk.green('ON')} (rules: config/model-routing.json)`));
  console.log(chalk.dim('\nCheckpoints:'));
  console.log(chalk.dim(describeCheckpoints(cfg)));
  console.log();
}

function readUserConfigSync() {
  try {
    return JSON.parse(fsSync.readFileSync(USER_CONFIG_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

// Brief-chain queue helper — pops the next brief from inputs/brief-queue/ into
// inputs/brief.md and .guide/brief.md, archives the old brief + plan.json, and
// resets current_phase to 0 so the guide re-plans from scratch. Returns
// { briefName } when a queued brief was found and installed, null otherwise.
// Called from the phases-complete and bug-round-complete auto-chain gates.
async function popNextBriefFromQueue(projDir, projectName, cfg) {
  const queueRelDir = cfg.auto_run?.auto_brief_chain?.brief_queue_dir || 'inputs/brief-queue';
  const queueDir = path.join(projDir, queueRelDir);
  let files;
  try { files = await fs.readdir(queueDir); } catch { return null; }
  const briefs = files.filter((f) => f.endsWith('.md')).sort();
  if (!briefs.length) return null;

  const nextFile = briefs[0];
  const nextPath = path.join(queueDir, nextFile);
  const newContent = await fs.readFile(nextPath, 'utf-8');

  const isoStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const guideDir = path.join(projDir, '.guide');
  await fs.mkdir(guideDir, { recursive: true });

  // Archive old brief + plan so the guide replans from scratch
  for (const [src, dst] of [
    [briefPath(projDir), path.join(guideDir, `brief-archived-${isoStamp}.md`)],
    [planJsonPath(projDir), path.join(guideDir, `plan-archived-${isoStamp}.json`)],
  ]) {
    try { await fs.copyFile(src, dst); } catch { /* absent — skip */ }
  }
  try { await fs.unlink(planJsonPath(projDir)); } catch { /* already gone */ }

  // A new brief is a NEW plan-generation cycle, so its one-shot auto-regen
  // budgets must start fresh. The .plan-struct-regen-attempted / .coverage-
  // regen-attempted markers are cleared only on a clean plan; a PRIOR brief
  // that ended in manual-fix leaves them behind, and ensureValidPlan (line
  // ~3922) / the coverage gate would then skip THIS brief's single auto-regen
  // and pause on the first validation miss — exactly the stale-sentinel stall
  // that broke the acf chain. plan-fix.hint is the prior brief's regen hint and
  // would misdirect the new brief's regen, so drop it too.
  for (const marker of ['.plan-struct-regen-attempted', '.coverage-regen-attempted', 'plan-fix.hint']) {
    await fs.unlink(path.join(guideDir, marker)).catch(() => {});
  }

  // Install the new brief into both operator-side and guide-side paths
  await fs.mkdir(path.join(projDir, 'inputs'), { recursive: true });
  await fs.writeFile(path.join(projDir, 'inputs', 'brief.md'), newContent, 'utf-8');
  await fs.writeFile(briefPath(projDir), newContent, 'utf-8');

  await fs.unlink(nextPath);
  setCurrentPhase(projectName, 0);

  return { briefName: nextFile };
}

// Exported for testing
export { tryReviewAutoProceed, maybeAutoPromoteAudit, popNextBriefFromQueue }; // checkStaleBriefGuard, shouldRunAutoBrief, shouldAutoPromoteAudit are already exported above
