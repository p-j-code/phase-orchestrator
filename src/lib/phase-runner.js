// Phase Runner v0.4 — adds brief-author, audit, roadmap guide tasks.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve as resolveConfig } from '../config-resolver.js';
import { runClaude, bumpEffort, resolveComplexityTurnBudget, applyTurnBudget } from '../claude-runner.js';
import { preflightCheck } from '../billing-guard.js';
import { routeModel, tierIndex, modelToTier } from '../model-router.js';
import {
  upsertPhase, markPhaseStarted, backfillPhaseSessionId, markPhaseCompleted, setCurrentPhase, getProject, getPhases,
  setProjectMetadataField, parseProjectMetadata, setGuideSessionId, setProjectGitConfig,
  recordContextManifest, recordContextOutcome, recordContextCompileEvent, getLatestSessionContext,
  recordPhaseExecutionFeature,
} from '../state.js';
import {
  preflightForDev, pushBranch, getHeadSha, getCommitParentSha, getCurrentBranch, syncWithRemote, fixCommitExists, phaseCommitSha,
  workspaceStatus, isGitRepo, changedFilesSince, diffStatDetailedSince, listTrackedFiles,
} from './git.js';
import chalk from 'chalk';
import {
  guideRoot, planJsonPath, briefPath, rawThoughtsPath, briefQuestionsPath,
  projectContextPath, suggestionsPath,
  phaseDir, phasePromptPath, phaseReportPath,
  reviewPath, reviewLensPath, handoffPath,
  bugRoundDir, bugsFilePath, fixPlanJsonPath, fixPlanMdPath,
  fixDir, fixPromptPath, fixReportPath,
  auditPath, roadmapPath, auditDir, findMostRecentAudit, detectHighestBugRound,
  lessonsDistilledPath, phaseLedgerPath, projectConventionsPath,
  recordGuideSession, recordDevSession,
  readContextFreshnessState, writeContextFreshnessState,
  phaseScoutPath,
} from './guide-paths.js';
import { mergeLensReviews, writeMergedLensReview } from './review-weight.js';
import { activeBriefPath, loadBriefConstraintsBlock } from './brief-manager.js';
import { escalationMarkerPath, legacyEscalationMarkerPath, resolveEscalation, nextTier } from './escalation.js';
import { runValidatorGate, gateFailureExcerpt } from './validators.js';
import { isTestFirstActive, runTestFirstPreDev } from './test-first.js';
import { sanitiseContent } from './sanitise-content.js';
import { parseDecisionsJsonl, renderDecisionLine } from './decisions-schema.js';
import { parsePhaseLedgerJsonl, renderLedgerEntry, recordPhaseLedgerEntry } from './ledger.js';
import { runAcceptanceCheck, runAcceptancePanel, decideVerdict, resolveFixPhaseMeta } from './verify-loop.js';
import { runBriefConformance } from './brief-conformance.js';
import {
  recordLesson, readLessons, selectRelevantLessons,
  computeDistillCutoff, finalizeDistillation, validateDistilledLessonsMarkdown,
  selectGlobalLessons, globalLessonsEligible, GENERAL_SECTION_INSTRUCTION,
} from './lessons.js';
import { runArtifactContractOnExistingCall, markdownContractValidator } from './llm-contract.js';
import { materializeWorkspaceSkills, materializeProjectConventions } from './workspace-skills.js';
import { generateRepoMap, renderRepoMapBlock, renderMapBody, readRepoMapCache, computeWorkspaceStackTags } from './repo-map.js';
import {
  stampArtifact, parseStampFrontMatter, contextDelta, renderContextDeltaBlock,
  shouldEnqueueContextRefresh, shouldNotifyContextDrift, buildContextDriftNotifyText,
  buildGuideRegroundReason, buildGuideRegroundNotifyText,
} from './context-freshness.js';
import { enqueueContextRefreshJob } from '../server/job-queue.js';
import {
  compileContextManifest, contextCompilerConfigFingerprint, contextCompilerInjects,
  renderCompiledContextBlock, resolveCompiledContextUse,
} from './context-compiler.js';
import { resolveContextTestPlan } from './context-test-cadence.js';
import { resolveDeltaAcceptancePlan } from './context-delta-verification.js';
import { resolveEffectiveContextCompilerMode } from './context-compiler-rollout.js';
import { extractPhaseSizeFeatures } from './phase-size-predictor.js';
import { isProviderRateLimitError } from './transient-errors.js';

export { sanitiseContent };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');
const PROMPTS_DIR = path.join(REPO_ROOT, 'prompts');

/**
 * Keep the durable project row's Git metadata in sync with the authoritative
 * project.json metadata read by config-resolver. Older projects can have a
 * perfectly valid project.json while their SQLite row predates git_branch /
 * git_remote columns; treating that row as "legacy" skips commit bookkeeping
 * and later makes skip-analyze rewind completed work forever.
 *
 * Existing state wins. This is deliberately a fill-only repair so an operator
 * can still migrate a project's DB target independently of project.json.
 */
export function reconcileProjectGitConfig({ projectName, project, configuredProject, setGitConfig = setProjectGitConfig }) {
  const configuredBranch = configuredProject?.git_branch || null;
  const configuredRemote = configuredProject?.git_remote || null;
  const git_branch = project?.git_branch || configuredBranch;
  const git_remote = project?.git_remote || configuredRemote;

  const missing = {};
  if (!project?.git_branch && configuredBranch) missing.git_branch = configuredBranch;
  if (!project?.git_remote && configuredRemote) missing.git_remote = configuredRemote;
  if (Object.keys(missing).length > 0) setGitConfig(projectName, missing);

  return { ...project, git_branch: git_branch || null, git_remote: git_remote || null };
}

const GUIDE_TASK_MAP = {
  'plan': 'plan-creation',
  'next-prompt': 'phase-prompt-gen',
  'review': '3-phase-review',
  'handoff': 'handoff-creation',
  'bug-plan': 'bug-plan',
  'fix-prompt': 'fix-prompt-gen',
  'workspace-claude-md': 'workspace-claude-md',
  'brief-author': 'brief-author',
  'audit': 'audit',
  'roadmap': 'roadmap',
  'project-context-gen': 'project-context-gen',
  'requirement-refine': 'requirement-refine',
  'plan-validate': 'plan-validate',
  'lessons-distill': 'lessons-distill',
};

async function readJson(p) { try { return JSON.parse(await fs.readFile(p, 'utf-8')); } catch { return null; } }
async function readText(p) { try { return await fs.readFile(p, 'utf-8'); } catch { return null; } }
async function fileExists(p) { try { await fs.access(p); return true; } catch { return false; } }

export async function compileContextWithinTimeout(args, compileFn, recordEventFn = recordContextCompileEvent) {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const timeoutCfg = args.cfg?.context_compiler?.timeout_ms || {};
  const warm = Number(timeoutCfg.warm) > 0 ? Number(timeoutCfg.warm) : 10000;
  const cold = Number(timeoutCfg.cold) > 0 ? Number(timeoutCfg.cold) : 45000;
  let hasWarmRepoMap = args.hasWarmRepoMap === true;
  if (!hasWarmRepoMap && args.projDir) {
    try { hasWarmRepoMap = Boolean(await readRepoMapCache(args.projDir)); } catch { /* cold scan */ }
  }
  const timeoutMs = hasWarmRepoMap ? warm : cold;
  const timeoutMarker = Symbol('context-compiler-timeout');
  const abortController = new AbortController();
  let timer;
  let manifest = null;
  let status = 'failed';
  let errorMessage = null;
  try {
    const result = await Promise.race([
      compileFn({ ...args, signal: abortController.signal, throwOnError: true }),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          // Settle the timeout side of the race before notifying the compiler;
          // an AbortSignal-aware provider may reject synchronously on abort.
          resolve(timeoutMarker);
          abortController.abort(new Error(`compiler exceeded ${timeoutMs}ms`));
          console.warn(chalk.yellow(`[context-compiler] exceeded ${timeoutMs}ms — using the existing repo-map flow`));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (result === timeoutMarker) {
      status = 'timeout';
      errorMessage = `compiler exceeded ${timeoutMs}ms`;
    } else if (result) {
      manifest = result;
      status = 'compiled';
    } else {
      errorMessage = 'compiler returned no manifest';
    }
  } catch (err) {
    errorMessage = err.message;
    console.warn(chalk.yellow(`[context-compiler] failed open: ${err.message}`));
  } finally {
    if (timer) clearTimeout(timer);
    try {
      recordEventFn?.({
        project: args.projectName,
        phase: Number.isInteger(args.task?.phase) ? args.task.phase : null,
        task_kind: args.task?.task_kind || 'phase',
        requested_mode: args.cfg?.context_compiler?.mode || 'shadow',
        provider: manifest?.provider || args.cfg?.context_compiler?.provider || 'unknown',
        started_at: startedAt,
        duration_ms: Date.now() - startedMs,
        status,
        manifest_id: manifest?.manifest_id || null,
        compiler_fingerprint: contextCompilerConfigFingerprint(args.cfg?.context_compiler || {}),
        error_message: errorMessage,
      });
    } catch (err) {
      console.warn(chalk.yellow(`[context-compiler] attempt telemetry write failed: ${err.message}`));
    }
  }
  return manifest;
}

/**
 * Avoid sending two repository maps to the dev call. A compiler result owns
 * repository context only when policy marked it injectable and either its
 * rendered block is in this prompt or the same resumed session already holds
 * that block and the caller can restore it if that session must be discarded.
 * Shadow/degraded/no-manifest paths retain the broad repo-map as their fail-open
 * fallback, as does a fresh call whose block failed to render.
 */
export function resolveDevRepoMapContext({
  mapCtx,
  compiledContextUse,
  compiledContextBlock = null,
  sessionOwnsCompiledContext = false,
} = {}) {
  const compilerOwnsContext = compiledContextUse?.inject === true
    && (Boolean(compiledContextBlock) || sessionOwnsCompiledContext === true);
  return compilerOwnsContext ? null : mapCtx;
}

// Brief 08 / P1(b) — deterministic validator for the project-context-gen
// artifact (project-context.md). buildGuidePrompt's project-context-gen case
// authors it from prompts/templates/project-context-template.md, whose stable
// sections include Domain / Audience / Prompting Guidance (the guide is told the
// Prompting-Guidance section is the highest-leverage one and must always be
// filled). Requiring those three headings + a modest length floor catches a
// stub or a wrong-format reply without false-positiving on a terse-but-valid
// doc. Runs BEFORE stampArtifact prepends the generated_at front-matter.
const validateProjectContextMarkdown = markdownContractValidator({
  requiredHeadings: ['Domain', 'Audience', 'Prompting Guidance'],
  minNonEmptyLines: 5,
  maxLines: 200,
});

// Read a markdown artifact from disk and run it through a deterministic
// validator — the artifactReader half of the P1(b) contract for the two
// guide-authored narrative files. A missing/unreadable file is itself a
// validation failure (triggers the one re-ask), never a throw.
async function readMarkdownArtifactForContract(filePath, validate) {
  let content;
  try { content = await fs.readFile(filePath, 'utf-8'); }
  catch (err) { return { ok: false, errors: [`artifact not readable at ${filePath}: ${err.message}`] }; }
  return validate(content);
}

// Resolve the P1(b) artifact contract for a guide task, or null when the task
// authors no contract-checked artifact. Only project-context-gen and
// lessons-distill route through the deterministic markdown seam here; bug-plan
// (fix-plan.json, AJV) and plan-creation (validatePlanStructure) are contracted
// at their own downstream read sites in auto-runner.js.
function resolveGuideArtifactContract({ task, projDir }) {
  if (task === 'project-context-gen') {
    const filePath = projectContextPath(projDir);
    return { filePath, artifactReader: () => readMarkdownArtifactForContract(filePath, validateProjectContextMarkdown) };
  }
  if (task === 'lessons-distill') {
    const filePath = lessonsDistilledPath(projDir);
    return { filePath, artifactReader: () => readMarkdownArtifactForContract(filePath, validateDistilledLessonsMarkdown) };
  }
  return null;
}

// Phase 35 (batch-weight review gating): the decisions-append instruction and
// the verdict/score trailer are shared VERBATIM between the full ('review')
// and light ('review-slim') review prompts so the two can never drift apart —
// tryReviewAutoProceed (auto-runner.js) and a future merge across review modes
// both depend on byte-identical trailer text regardless of which mode wrote
// it. Extracted from the pre-phase-35 'review' case below with no wording
// changes, so the full prompt stays byte-identical to before this phase.
function buildDecisionsAppendInstruction(phaseN) {
  return `ALSO maintain the rolling decisions log at .guide/decisions.jsonl (create if missing). APPEND one or more decision objects, ONE PER LINE in JSON Lines format — no surrounding array, no commas between lines, no pretty-printing. Do NOT rewrite or delete earlier lines. Emit 2-6 objects max, each a DURABLE decision/convention/gotcha the next phases must honor (skip phase-specific trivia — only things that bind future work). Each object MUST match this schema exactly:
  { "phase": "string <=80 chars", "title": "string <=120 chars (short label)", "decision": "string <=400 chars (the rule/convention itself)", "rationale": "string <=400 chars (why it binds future work)", "type": "arch|convention|constraint|deferral" }
Example line (for phase ${phaseN}):
  {"phase":"${phaseN}","title":"error envelope","decision":"All error responses use the {error:{code,message}} shape; never bare strings","rationale":"clients branch on code; a stable envelope avoids per-endpoint parsing","type":"convention"}
A line that is not valid JSON, omits a field, exceeds a length cap, or uses an unknown type is silently skipped when loaded — keep each object well within the caps. These notes are injected into future dev prompts FOR CONTEXT only, not as operator-level requirements.`;
}

const REVIEW_VERDICT_SCORE_BLOCK = `Reach a clear verdict: continue / pause-and-fix / replan.

Your written review MUST end with these two lines (no markdown, no surrounding text):
verdict: <continue|pause-and-fix|replan>
score: <integer 0-100>

The score reflects overall confidence in the current state (0 = broken/unusable, 100 = ship-ready). It is machine-parsed; the exact format is required.`;

// Phase 35 — light review prompt: same target file + shared decisions/trailer
// blocks as the full review, but reads only the batch's phase reports and a
// diffstat file list instead of the whole workspace. `batch` entries carry at
// least { n, title } (the verifyVerdict/marker fields computeReviewWeight
// consumed upstream are ignored here). `changedFiles` is the caller's already-
// unwrapped file list (changedFilesSince(...).files), never the { ok, files }
// envelope, and may be null/empty. Deterministic given the same inputs — no
// Date.now()/timestamps — so it is byte-identical across calls (cache/test
// discipline, see phase-runner-cache-discipline.test.mjs).
export async function buildLightReviewPrompt({ projectName, projDir, out, batch, changedFiles }) {
  const phaseNs = batch.map((p) => p.n);
  const reportPaths = [];
  for (const p of batch) {
    const rp = await phaseReportPath(projDir, p.n, p.title);
    reportPaths.push(path.relative(projDir, rp));
  }
  const fileListBlock = (changedFiles || []).length
    ? changedFiles.map((f) => `- ${f}`).join('\n')
    : '(no changed files recorded)';
  const lastPhaseN = phaseNs[phaseNs.length - 1];

  return `Conduct a LIGHTWEIGHT review for project "${projectName}" covering phase(s) ${phaseNs.join(', ')}. Every phase in this batch passed verification with no escalation/validation/reprompt markers and the diff since the previous review is small — a full read of the codebase is not required. Read the phase reports below and skim the changed-file list to confirm nothing looks off, then write your verdict.

Phase reports:
${reportPaths.map((p) => `- ${p}`).join('\n')}

Changed files since the previous review:
${fileListBlock}

Write to: ${path.relative(projDir, out)}

${buildDecisionsAppendInstruction(lastPhaseN)}

${REVIEW_VERDICT_SCORE_BLOCK}`;
}

// Phase 35 — light review call: a haiku one-shot ('review-slim' task),
// deliberately roleless (role:null) and sessionless (sessionId:null) so it
// never touches guide_session_id bookkeeping the resumed guide session
// depends on — mirrors the roleless/session-safety class of acceptance-check,
// lessons-distill, etc. Writes to the SAME reviewPath a full review would, so
// tryReviewAutoProceed reads it identically regardless of which mode wrote it.
async function runLightReview({ projectName, project, reviewBatch, reviewChangedFiles, reviewPhaseN = null }, { runClaudeFn }) {
  const projDir = path.join(PROJECTS_DIR, projectName);
  const phaseN = reviewPhaseN ?? project.current_phase;
  const cfg = await resolveConfig({ project: projectName, phase: phaseN, task: 'review-slim' });
  preflightOrThrow(cfg);
  const routing = await routeModel({ cfg, task: 'review-slim', projectName });
  cfg.model = routing.model;

  const out = reviewPath(projDir, phaseN);
  const batch = Array.isArray(reviewBatch) ? reviewBatch : [];
  const prompt = await buildLightReviewPrompt({ projectName, projDir, out, batch, changedFiles: reviewChangedFiles });
  const systemPromptExtra = await loadProjectContextBlock(projDir);

  return runClaudeFn({
    cfg, cwd: projDir, prompt,
    systemPromptFile: path.join(PROMPTS_DIR, 'guide-system.md'),
    systemPromptExtra,
    sessionId: null,
    role: null,
    project: projectName,
    task: 'review-slim',
    routing: { tier: routing.tier, reasoning: routing.reasoning },
  });
}

// ─── Phase 36 — panel review: lenses 2/3 ────────────────────────────────────
//
// A 'panel' classification (computeReviewWeight) fans a heavy batch out to
// THREE scoped review lenses instead of one generic pass. Lens 1 is the
// EXISTING full review call — resumed guide session, role:'guide', the only
// change in panel mode is its `Write to:` target (buildGuidePrompt's 'review'
// case, below) — and stays the ONLY writer of .guide/decisions.jsonl. Lenses
// 2/3 (this section) are fresh, roleless, tool-scoped spawns mirroring
// verify-loop.js's acceptance-check shape: role:null, sessionId:null,
// systemPromptFile:null + a short static systemPromptExtra, and a read-mostly
// + Write tools allowlist (no unrestricted Bash, no Edit) via a cfg clone —
// each lens writes its OWN reviews/after-N-lens-<k>.md, then
// runReviewPanel() below reads all three off disk and merges them
// (mergeLensReviews, pure/no-LLM — src/lib/review-weight.js) into the SAME
// reviewPath a full/light review would write.

// Fixed literals, no interpolation — same P1 cache-discipline guarantee as
// verify-loop.js's CHECKER_SYSTEM_PROMPT/PRESCAN_SYSTEM_PROMPT/
// ADJUDICATOR_SYSTEM_PROMPT. Only lens 3's preamble mentions decisions.jsonl
// (and explicitly disclaims appending to it) — lens 2 has no decisions
// contract to disclaim.
export const REVIEW_LENS_SECURITY_SYSTEM_PROMPT =
  `You are lens 2 of a 3-lens panel review of a batch of already-committed phases. Your ` +
  `ONLY job is a SECURITY / FAILURE-MODES pass over the diff: injection vulnerabilities, ` +
  `authorization gaps, race conditions, resource leaks, and error-path behavior. Do not ` +
  `comment on style, architecture, or brief-conformance — other lenses cover those. You may ` +
  `use Read/Glob/Grep/Write and the three scoped git inspection commands only.`;

export const REVIEW_LENS_CONSISTENCY_SYSTEM_PROMPT =
  `You are lens 3 of a 3-lens panel review of a batch of already-committed phases. Your ` +
  `ONLY job is a CONSISTENCY pass: read .guide/decisions.jsonl and the active brief's ` +
  `conventions, then flag any change in the diff that violates a documented convention, ` +
  `constraint, or prior decision. Do not comment on security or general code quality — other ` +
  `lenses cover those. Do NOT append to .guide/decisions.jsonl — that file has exactly one ` +
  `writer (the lens-1 review); you are reviewing consistency with it, not authoring entries. ` +
  `You may use Read/Glob/Grep/Write and the three scoped git inspection commands only.`;

export const REVIEW_LENS_ALLOWED_TOOLS = Object.freeze([
  'Read', 'Glob', 'Grep', 'Write', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)',
]);

// Phase 36 — lens 2/3's per-call prompt: batch scope + changed-file list +
// Write-to target + the SAME shared verdict/score trailer every review mode
// uses. Pure function of its inputs — byte-identical across calls for
// unchanged inputs (phase-runner-cache-discipline.test.mjs).
// `includeDecisionsNote` renders the explicit "do NOT append" line for lens
// 3; lens 2 never mentions decisions.jsonl at all.
export function buildReviewLensPrompt({ lensLabel, projectName, projDir, out, phaseNs, changedFiles, includeDecisionsNote }) {
  const fileListBlock = (changedFiles || []).length
    ? changedFiles.map((f) => `- ${f}`).join('\n')
    : '(no changed files recorded)';
  const decisionsNote = includeDecisionsNote
    ? '\n\nRead .guide/decisions.jsonl for context. Do NOT append to decisions.jsonl — that file has exactly one writer (the lens-1 review); a second writer would duplicate entries.\n'
    : '';
  return `Conduct the ${lensLabel} lens of a panel review for project "${projectName}" covering phase(s) ${phaseNs.join(', ')}.

Changed files since the previous review:
${fileListBlock}
${decisionsNote}
Write to: ${path.relative(projDir, out)}

${REVIEW_VERDICT_SCORE_BLOCK}`;
}

// Spawns exactly one lens (2 or 3): fresh/roleless/scoped, read-mostly +
// Write tools allowlist via a cfg clone (never the caller's own cfg.tools —
// this must never inherit lens 1's Edit/unrestricted-Bash access). A spawn
// error is caught and logged here, not rethrown — the caller treats a null
// return (no file on disk) as a missing lens, which mergeLensReviews already
// fails safe on (pause-and-fix/0 + a warning line).
async function spawnReviewLens({ cfg, projDir, projectName, phaseN, lensNum, lensLabel, systemPromptExtra, phaseNs, changedFiles, includeDecisionsNote, runClaudeFn }) {
  const out = reviewLensPath(projDir, phaseN, lensNum);
  const lensCfg = {
    ...cfg,
    model: cfg.models?.['review-lens'],
    tools: { ...cfg.tools, allowed_default: [...REVIEW_LENS_ALLOWED_TOOLS] },
  };
  delete lensCfg._effort_override;

  const prompt = buildReviewLensPrompt({ lensLabel, projectName, projDir, out, phaseNs, changedFiles, includeDecisionsNote });

  try {
    await runClaudeFn({
      cfg: lensCfg, cwd: projDir, prompt,
      systemPromptFile: null,
      systemPromptExtra,
      sessionId: null,
      role: null,
      project: projectName,
      task: 'review-lens',
    });
  } catch (err) {
    console.warn(chalk.yellow(`[review-panel] lens ${lensNum} (${lensLabel}) spawn failed: ${err.message} — merging as pause-and-fix/0`));
  }

  return readText(out);
}

// Runs after lens 1 (the resumed full review, targeting after-N-lens-1.md in
// panel mode — see buildGuidePrompt's 'review' case) has already completed
// successfully. Spawns lenses 2/3 SEQUENTIALLY — NEVER parallel, single-funnel
// discipline, matching this project's one-spawn-at-a-time convention — reads
// all three lens files off disk, merges them (mergeLensReviews, pure/no-LLM),
// and writes the merged result to the SAME reviewPath a full/light review
// would use, so tryReviewAutoProceed reads it identically regardless of mode.
// A lens 2/3 failure never throws past this point — the panel never fails the
// review action for anything but a lens-1 error (handled by the caller via
// result.is_error, before this function is ever reached).
async function runReviewPanel({ projectName, projDir, phaseN, cfg, reviewBatch, reviewChangedFiles }, { runClaudeFn }) {
  const batch = Array.isArray(reviewBatch) ? reviewBatch : [];
  const phaseNs = batch.length ? batch.map((p) => p.n) : [phaseN];
  const changedFiles = reviewChangedFiles;

  const lens1Content = await readText(reviewLensPath(projDir, phaseN, 1));

  const lens2Content = await spawnReviewLens({
    cfg, projDir, projectName, phaseN, lensNum: 2, lensLabel: 'security / failure-modes',
    systemPromptExtra: REVIEW_LENS_SECURITY_SYSTEM_PROMPT, phaseNs, changedFiles,
    includeDecisionsNote: false, runClaudeFn,
  });
  const lens3Content = await spawnReviewLens({
    cfg, projDir, projectName, phaseN, lensNum: 3, lensLabel: 'consistency with brief conventions and decisions.jsonl',
    systemPromptExtra: REVIEW_LENS_CONSISTENCY_SYSTEM_PROMPT, phaseNs, changedFiles,
    includeDecisionsNote: true, runClaudeFn,
  });

  const merged = mergeLensReviews([
    { name: 'guide review (memory + decisions)', content: lens1Content },
    { name: 'security / failure-modes', content: lens2Content },
    { name: 'consistency with brief conventions and decisions.jsonl', content: lens3Content },
  ]);
  for (const w of merged.warnings) console.warn(chalk.yellow(`[review-panel] ${w}`));

  await writeMergedLensReview(reviewPath(projDir, phaseN), merged);
  return merged;
}

// Phase 16 (brief P1 injection) — pure decision: is this guide call's resolved
// config-task id in the configured injection list? Mirrors the
// shouldRunAcceptanceCheck/shouldRunGateRefine pure-decision-function pattern
// below. `guideTasks`/`cfgTask` both live in the resolveConfig task-id
// namespace — the SAME ids `defaults.models` and billing attribution use
// ('plan-creation', 'audit', 'audit-scan', 'project-context-gen',
// 'suggest-scan') — NOT GUIDE_TASK_MAP's runGuide()-facing task keys ('plan',
// 'audit' the dispatch param). See docs/ARCHITECTURE.md "Deterministic repo
// map" → "Injection sites" for why the two namespaces don't line up 1:1.
export function shouldInjectRepoMap({ guideTasks, cfgTask }) {
  return Array.isArray(guideTasks) && guideTasks.includes(cfgTask);
}

// Phase 31 — wires the previously-dead phases.handoff_when_context_tokens_exceed
// config (see docs/ARCHITECTURE.md "Guide re-grounding on large external drift
// (Phase 22)" → "Known gap" for the prior confirmation that nothing read it).
// Pure decision: is `rawThreshold` a usable positive-finite trigger value?
// undefined/null/0/false are all treated as an intentional off-switch — every
// existing config (no override of this key at all) and any project that
// explicitly disables the feature must both stay silent (no warning): this
// mirrors guide_reground's `enabled:false` escape hatch. Anything else that
// fails to resolve to a positive finite number (a typo'd string, a negative
// number, NaN/Infinity) is a genuinely bad value — disabled the same way, but
// with a warning naming the config key so a misconfigured override is
// diagnosable instead of silently no-op'ing forever.
export function resolveCompactionThreshold(rawThreshold) {
  if (rawThreshold === false || rawThreshold === 0 || rawThreshold == null) {
    return { threshold: null, warning: null };
  }
  if (typeof rawThreshold === 'number' && Number.isFinite(rawThreshold) && rawThreshold > 0) {
    return { threshold: rawThreshold, warning: null };
  }
  return {
    threshold: null,
    warning: `phases.handoff_when_context_tokens_exceed resolved to an invalid value (${JSON.stringify(rawThreshold)}) — compaction trigger disabled. Check config/defaults.json and any user/profile/project override of this key.`,
  };
}

// Phase 31 — pure decision: should THIS runGuide() call trigger a
// distill-and-reground compaction? Distinct trigger from guide_reground
// (Phase 22, git-drift-based, further up this file): this fires purely off
// the LAST assistant turn's per-request token usage (see claude-runner.js's
// lastTurnContextTokens — NOT the cumulative result.usage the naive design
// would have used), independent of how much the workspace has moved.
// Gated to resumed-session calls only (`!freshSessionTasks.includes(task)`)
// — a fresh-session task carries no bloated resumed context to compact in the
// first place — and explicitly excludes 'handoff' itself (already covered by
// freshSessionTasks today, but kept as its own check per the brief: a handoff
// must never trigger another handoff). `lastCompactSessionId` is the
// idempotency guard — at most one compaction per session-id crossing.
export function shouldCompactGuideSession({ result, role, task, freshSessionTasks, threshold, lastCompactSessionId }) {
  if (!result || result.is_error) return false;
  if (role !== 'guide') return false;
  if (task === 'handoff' || (Array.isArray(freshSessionTasks) && freshSessionTasks.includes(task))) return false;
  if (threshold == null) return false;
  if (!result.session_id) return false;
  if (lastCompactSessionId === result.session_id) return false;
  const tokens = result.last_turn_context_tokens;
  return Number.isFinite(tokens) && tokens > threshold;
}

// Phase 16: fail-open wrapper shared by every injection call site (dev/fix,
// guide single-call, two-stage audit). generateRepoMap() already never throws
// internally (see repo-map.js header) — this extra try/catch means an
// injected test double (or a future change to repo-map.js) that DOES throw
// still can't fail a spawn, matching the belt-and-braces pattern the
// audit-sha-stamping try/catches use elsewhere in this file.
// Phase 39 (CE-4): `deps.focusPaths`, when non-empty, re-renders the block
// from .guide/repo-map-cache.json (the PARSED structure — the .md body
// generateRepoMap already produced is phase-agnostic and already degraded,
// so it can't be re-rendered at a different focus) via the SAME renderMapBody
// the MCP get_repo_map tool's focus_paths uses (state-server.mjs). A missing
// or stale (sha mismatch) cache — repo_map.incremental:false, or a map that
// predates this phase — falls back to the phase-agnostic body unchanged.
// Deterministic per (sha, focusPaths): both the cache read and
// generateRepoMap's own skip-if-fresh path are pure disk reads for an
// unchanged HEAD, so two calls with the same inputs stay byte-identical.
export async function loadRepoMapBlock(workspaceDir, projDir, cfg, deps = {}) {
  const generateRepoMapFn = deps.generateRepoMap ?? generateRepoMap;
  const readRepoMapCacheFn = deps.readRepoMapCache ?? readRepoMapCache;
  const focusPaths = Array.isArray(deps.focusPaths) && deps.focusPaths.length ? deps.focusPaths : null;
  try {
    const map = await generateRepoMapFn({ workspaceDir, projDir, cfg });
    if (!map) return null;
    if (!focusPaths) return renderRepoMapBlock(map);

    const cache = await readRepoMapCacheFn(projDir);
    if (!cache || cache.sha !== map.generated_at_sha) return renderRepoMapBlock(map);

    const body = renderMapBody({ tree: cache.tree, files: cache.files }, map.degradation_level, { focusPaths });
    return renderRepoMapBlock({ ...map, body });
  } catch (err) {
    console.warn(chalk.yellow(`[repo-map] injection skipped: ${err.message}`));
    return null;
  }
}

// Phase 18 (brief P2, delta-injection half) — fail-open wrapper, mirrors
// loadRepoMapBlock's shape: reads project-context.md's phase-17 front-matter
// stamp, diffs it against workspaceDir's current HEAD via contextDelta, and
// renders the result. A legacy/unstamped artifact (no front-matter, or a
// front-matter block missing generated_at_sha) is drift-unknown, matching
// brief.md P2's framing exactly — distinct from an empty delta (drift:'none'),
// which renders nothing. Every call site only invokes this when ctxExtra
// itself is non-null — nothing to flag as stale if there's no context block
// above it to annotate.
export async function loadContextDeltaBlock(workspaceDir, projDir, deps = {}) {
  const contextDeltaFn = deps.contextDelta ?? contextDelta;
  try {
    const raw = await readText(projectContextPath(projDir));
    if (!raw) return null;
    const parsed = parseStampFrontMatter(raw);
    if (!parsed || !parsed.attrs.generated_at_sha) {
      return renderContextDeltaBlock({ drift: 'unknown' });
    }
    const delta = await contextDeltaFn({ workspaceDir, sinceSha: parsed.attrs.generated_at_sha });
    return renderContextDeltaBlock(delta, { sha: parsed.attrs.generated_at_sha, date: parsed.attrs.generated_at });
  } catch (err) {
    console.warn(chalk.yellow(`[context-delta] injection skipped: ${err.message}`));
    return null;
  }
}

// Phase 20 (brief P3, tracking half) — fail-open wrapper analogous to
// loadContextDeltaBlock above, but diffs from the GUIDE's own last-seen HEAD
// (metadata_json.last_guide_head_sha, updated after every successful
// guide-role call — see the tail of runGuide()/runTwoStageAudit() below, via
// setProjectMetadataField) rather than project-context.md's stamp. These are
// two distinct signals: the P2 block says "the narrative doc you're reading
// might be stale"; this one says "the code has moved since YOU (this guide
// session) last looked at it" — independent of whether project-context.md
// exists at all.
//
// `lastGuideHeadSha` absent (no prior guide call ever tracked for this
// project — a brand-new project, or an existing one on its first call since
// this phase shipped) → nothing to diff against yet, render nothing. This
// mirrors loadContextDeltaBlock's ctxExtra gate: an artifact/tracker that
// never existed renders nothing; only one that exists but can't be resolved
// (bad sha, git failure) renders the 'unknown' caution via contextDelta's own
// fail-open branch.
//
// Phase 21 (brief P3, large-drift reground half) split this into two: the
// RAW delta fetch (computeGuideHeadDelta, below) and the pure render
// (renderGuideHeadDeltaBlock, below) — runGuide() needs the raw delta object
// itself to decide whether to re-ground (commits/external-files thresholds),
// not just its rendered prose, and must not fetch it twice. This function is
// now a thin compose of both; its own signature/behavior is unchanged (see
// phase-runner-guide-head-delta.test.mjs, none of which needed updating).
export async function computeGuideHeadDelta(workspaceDir, lastGuideHeadSha, deps = {}) {
  const contextDeltaFn = deps.contextDelta ?? contextDelta;
  try {
    if (!lastGuideHeadSha) return null;
    return await contextDeltaFn({ workspaceDir, sinceSha: lastGuideHeadSha });
  } catch (err) {
    console.warn(chalk.yellow(`[guide-head-delta] injection skipped: ${err.message}`));
    return null;
  }
}

export function renderGuideHeadDeltaBlock(delta) {
  return delta ? renderContextDeltaBlock(delta) : null;
}

export async function loadGuideHeadDeltaBlock(workspaceDir, lastGuideHeadSha, deps = {}) {
  return renderGuideHeadDeltaBlock(await computeGuideHeadDelta(workspaceDir, lastGuideHeadSha, deps));
}

// Phase 20 (brief P3, handoff-anchor half) — deterministic, orchestrator-side
// (never LLM-authored) anchor line appended to the handoff file the guide
// just wrote, so a future re-ground (phase 21) can delta from the handoff
// too. Mirrors stampArtifact's precedent (context-freshness.js header): the
// orchestrator, not the model, owns correctness-critical bookkeeping — a
// prompt instruction asking the LLM to write "Generated at commit: {sha}"
// verbatim is one paraphrase away from breaking that future delta. Idempotent
// via a plain substring check, so a retried/resumed handoff call never
// duplicates the line.
export async function appendHandoffAnchor(handoffOutPath, sha, deps = {}) {
  const readTextFn = deps.readText ?? readText;
  const appendFileFn = deps.appendFile ?? fs.appendFile;
  if (!handoffOutPath || !sha) return false;
  const existing = await readTextFn(handoffOutPath);
  if (existing === null) return false;
  const anchorLine = `Generated at commit: ${sha}`;
  if (existing.includes(anchorLine)) return false;
  await appendFileFn(handoffOutPath, `\n\n${anchorLine}\n`, 'utf-8');
  return true;
}

// Phase 19 (brief P2, auto-refresh + notice half) — fail-open wrapper, run at
// the SAME spawn-time check as loadContextDeltaBlock above (an independent
// contextDelta() call — cheap, zero-LLM-cost, keeps render vs decide
// decoupled, same shape as loadRepoMapBlock/loadContextDeltaBlock each doing
// their own I/O). Decides (a) whether to enqueue ONE project-context-gen
// refresh — shouldEnqueueContextRefresh(), deduped atomically by
// enqueueContextRefreshJob itself (job-queue.js) so a second spawn while one
// is already pending/running enqueues nothing — and (b) whether to fire a
// one-time external-drift notice — shouldNotifyContextDrift(), keyed off the
// persisted last-noticed sha (guide-paths.js's read/writeContextFreshnessState).
// The persisted sha is updated as soon as the notice is DECIDED (not once a
// live Telegram send succeeds) and the text is also console.warn'd here as a
// fail-open fallback, because phase-runner.js has no notifier of its own to
// call (see docs/ARCHITECTURE.md) — the caller-attached `result._context_freshness`
// lets whichever call site DOES have a live notifier (auto-runner.js) push it
// to Telegram too, without risking a silently-lost notice if nobody does.
export async function loadContextFreshnessCheck(workspaceDir, projDir, projectName, cfg, deps = {}) {
  const cfgFreshness = cfg?.context_freshness;
  if (!cfgFreshness || cfgFreshness.enabled === false) return null;
  const contextDeltaFn = deps.contextDelta ?? contextDelta;
  const enqueueFn = deps.enqueueContextRefreshJob ?? enqueueContextRefreshJob;
  const readStateFn = deps.readContextFreshnessState ?? readContextFreshnessState;
  const writeStateFn = deps.writeContextFreshnessState ?? writeContextFreshnessState;

  try {
    const raw = await readText(projectContextPath(projDir));
    if (!raw) return null;
    const parsed = parseStampFrontMatter(raw);
    const sinceSha = parsed?.attrs?.generated_at_sha;
    const delta = sinceSha
      ? await contextDeltaFn({ workspaceDir, sinceSha })
      : { drift: 'unknown', sinceSha: null, headSha: null, commits: [], overflowCount: 0, overflowLine: null };

    const refreshQueued = shouldEnqueueContextRefresh({ delta, cfg: cfgFreshness });
    if (refreshQueued) await enqueueFn({ project: projectName });

    let notifyText = null;
    if (cfgFreshness.notify_on_external !== false) {
      const state = await readStateFn(projDir);
      if (shouldNotifyContextDrift({ delta, lastNoticedSha: state.last_noticed_external_sha })) {
        const text = buildContextDriftNotifyText({ projectName, delta, refreshQueued });
        if (text) {
          await writeStateFn(projDir, { ...state, last_noticed_external_sha: delta.headSha });
          console.warn(chalk.yellow(`[context-freshness] ${text}`));
          notifyText = text;
        }
      }
    }

    return (refreshQueued || notifyText) ? { refreshQueued, notifyText } : null;
  } catch (err) {
    console.warn(chalk.yellow(`[context-freshness] check skipped: ${err.message}`));
    return null;
  }
}

// v0.17 (size-gated opus floors) — size signals for routeModel's conditional
// hard floors. Only plan/roadmap gate on brief size, so every other guide
// task returns null (→ conditional floors fail-safe to applying, i.e. the
// pre-v0.17 behavior). brief_frs counts distinct numbered functional
// requirements ("FR1"/"FR-12" style, the plan-validate coverage-table id
// format); brief_chars is the raw active-brief length. A missing/empty brief
// also returns null — with no brief there is no size to gate on, and the
// floor must not be silently skipped.
export async function computeGuideSizeMeta({ task, projDir, plan }) {
  if (task !== 'plan' && task !== 'roadmap') return null;
  const briefText = await readText(activeBriefPath(projDir, plan));
  if (!briefText || !briefText.trim()) return null;
  const frMatches = briefText.match(/\bFR-?\d+\b/gi) || [];
  const distinctFrs = new Set(frMatches.map((m) => m.toUpperCase().replace('-', '')));
  return {
    brief_chars: briefText.length,
    brief_frs: distinctFrs.size,
    planned_phases: Array.isArray(plan?.phases) ? plan.phases.length : undefined,
  };
}

// v0.17 (size-gated opus floors) — candidate count from a two-stage audit's
// scan output, for the audit floor's min_candidates gate. Prefers the
// machine-parsed trailer the scan prompt mandates ("candidates: <count>");
// falls back to counting "### CAND-<n>" headings when the trailer is missing
// or malformed. Returns null only when neither signal exists (unreadable/
// empty scan) — the caller then passes no sizeMeta and the floor fail-safes
// to applying.
export function countScanCandidates(scanText) {
  if (!scanText || !scanText.trim()) return null;
  const trailer = scanText.match(/^candidates:\s*(\d+)\s*$/im);
  if (trailer) return Number(trailer[1]);
  const headings = scanText.match(/^###\s+CAND-\d+/gim);
  return headings ? headings.length : null;
}

// Phase 33 (QL-5) — deterministic "provably zero candidates" signal for
// skipping the adjudication stage entirely. Deliberately stricter than
// countScanCandidates===0: requires BOTH the machine-parsed trailer AND the
// absence of any CAND-<n> heading to agree. A missing/malformed trailer, a
// non-zero trailer, or a trailer/heading mismatch (model drift) all fail safe
// to false — the caller adjudicates exactly as before.
export function isCleanScan(scanText) {
  if (!scanText || !scanText.trim()) return false;
  if (!/^candidates:\s*0\s*$/mi.test(scanText)) return false;
  return !/^###\s+CAND-\d+/mi.test(scanText);
}

// Phase 53 (par-06) — candidateCount across one or more shard scan files.
// A single-text array reduces to exactly countScanCandidates(texts[0]) (the
// unsharded case is byte-for-byte unaffected); multiple texts sum each
// shard's own count. Fail-safe like countScanCandidates: any unreadable/
// malformed shard (null count) poisons the whole sum to null, so the
// adjudication floor applies exactly as it would for a single bad scan.
export function sumScanCandidates(scanTexts) {
  let total = 0;
  for (const text of scanTexts) {
    const c = countScanCandidates(text);
    if (c == null) return null;
    total += c;
  }
  return total;
}

// Phase 22 (brief P3, fixture-testability half): `deps.runClaude` mirrors
// verify-loop.js's runAcceptanceCheck seam — the real runClaude spawns a
// `claude` subprocess and is otherwise unreachable from a test without one.
// Threaded through to the recursive `runGuide({ task: 'handoff' }, deps)` call
// below so a test's stub sees BOTH the handoff-generation call and the main
// call. Every existing caller (auto-runner.js, job-runner.js, etc.) omits the
// second argument and gets the real runClaude, unchanged.
export async function runGuide({
  projectName, task, brief, round, fix, slot = 1, reviewMode = null, reviewBatch = null, reviewChangedFiles = null,
  phaseN: explicitReviewPhaseN = null, pinnedWorktree = null,
}, deps = {}) {
  const runClaudeFn = deps.runClaude ?? runClaude;
  const project = getProject(projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);

  // Phase 52 (par-03, verdict correction 2): callers that already know the
  // EXACT phase a review targets (the async auto-runner pipeline, which fires
  // a review for phase N without awaiting it — current_phase may have already
  // advanced past N by the time this call actually runs) pass it explicitly so
  // reviewPath/the review prompt/buildReviewContextBlock all name phase N, not
  // whatever current_phase has drifted to. Every existing caller (CLI,
  // job-runner, the synchronous auto-runner path) omits phaseN and gets
  // exactly today's behavior — derived from project.current_phase.
  const reviewPhaseN = explicitReviewPhaseN ?? project.current_phase;

  // Phase 35 (batch-weight review gating): a 'light' classification takes a
  // completely SEPARATE, roleless/sessionless path — see runLightReview below.
  // Bypassing the rest of this function (git preflight/sync, freshSessionTasks,
  // reground checks, systemPromptExtra composition) is deliberate: a
  // trivially-green batch needs none of it, and role:null/sessionId:null must
  // never touch guide_session_id bookkeeping the resumed guide session relies
  // on. reviewMode absent or 'full' falls through unchanged — today's behavior,
  // byte-identical.
  if (task === 'review' && reviewMode === 'light') {
    return runLightReview({ projectName, project, reviewBatch, reviewChangedFiles, reviewPhaseN }, { runClaudeFn });
  }

  // Phase 47 (P4 brief conformance): a completely SEPARATE, roleless/
  // sessionless spawn living in its own module (src/lib/brief-conformance.js,
  // cloned from verify-loop.js's checker pattern) — bypasses git preflight,
  // systemPromptExtra assembly, buildGuidePrompt, and every session-resume
  // decision below. The checker's static system prompt + read-only sandbox
  // are the whole point; role:null/sessionId:null must never touch
  // guide_session_id/last_dev_session_id (same invariant runLightReview
  // above already guards for 'review'/'light').
  if (task === 'brief-conformance') {
    const projDirBc = path.join(PROJECTS_DIR, projectName);
    const planBc = await readJson(planJsonPath(projDirBc));
    const cfgBc = await resolveConfig({ project: projectName, task: 'brief-conformance' });
    preflightOrThrow(cfgBc);
    const workspaceDirBc = path.join(projDirBc, cfgBc.paths.workspace_subdir);
    return runBriefConformance(
      { cfg: cfgBc, projectName, projDir: projDirBc, workspaceDir: workspaceDirBc, plan: planBc },
      { runClaude: runClaudeFn },
    );
  }

  let cfgTask = GUIDE_TASK_MAP[task];
  if (!cfgTask) throw new Error(`Unknown guide task: ${task}`);

  const projDir = path.join(PROJECTS_DIR, projectName);
  const plan = await readJson(planJsonPath(projDir));
  // Use the same next-phase logic as pickNextAction: find the first plan phase
  // whose n > current_phase. Plain +1 breaks when the plan uses non-sequential
  // numbering (e.g. a continuation plan renumbered from 1..N to 4..N+3).
  const phaseMeta = plan?.phases?.find((p) => p.n > project.current_phase) || null;
  const phaseN = phaseMeta?.n ?? (project.current_phase + 1);

  let cfg = await resolveConfig({ project: projectName, phase: phaseN, task: cfgTask });
  preflightOrThrow(cfg);
  const gitProject = reconcileProjectGitConfig({
    projectName,
    project,
    configuredProject: cfg._resolved?.project_data,
  });

  // Phase 16: lifted out of the `if (expectedBranch)` block below (mirrors
  // runDev()'s placement) so the repo-map injection further down can use it
  // regardless of whether this project has git-management configured.
  // Phase 52 (par-03, verdict correction 1): a pinned worktree (set by the
  // async review pipeline) stands in for the live workspace for EVERY read
  // below — repo map, guide-head-delta, context-freshness, last_review_sha —
  // so a review pinned to phase N's commit sees phase N's tree even after
  // dev N+1/N+2 has moved the live workspace on. The live path is still used
  // to compute the pin itself (auto-runner.js) and for every non-pinned call.
  const workspaceDir = pinnedWorktree || path.join(projDir, cfg.paths.workspace_subdir);

  // Git pre-flight + sync (v0.14.33) — pull anything pushed to the project's
  // branch (develop) since the last run BEFORE a guide task touches the
  // workspace. Without this, audit/roadmap/plan/bug-plan analyze or edit a
  // STALE clone, and the next push collides — which is where conflicts come
  // from. Same machinery as runDev()'s dev/phase pre-flight: it fast-forwards
  // when behind, is a no-op when already in sync, and HALTS on divergence
  // (no auto-rebase — data integrity over convenience). Skipped for projects
  // with no git_branch (legacy / git-management opted out), and for a pinned
  // worktree call (Phase 52): the pin is a read-only, detached, point-in-time
  // view — it must never be synced/rebased, and preflighting the LIVE
  // workspace on behalf of a call that never touches it would race the dev
  // session that may be mid-commit against that same live tree.
  const expectedBranch = gitProject.git_branch;
  if (pinnedWorktree) {
    console.log(chalk.dim(`  → ${task} pinned to worktree ${path.relative(projDir, pinnedWorktree)} (read-only) — skipping git preflight/sync`));
  } else if (expectedBranch) {
    const pf = await preflightForDev(workspaceDir, { expectedBranch });
    if (!pf.ok) {
      const err = new Error(`Git pre-flight failed: ${pf.error}`);
      err.is_preflight_error = true;
      throw err;
    }
    const sync = await syncWithRemote(workspaceDir, { branch: expectedBranch });
    if (!sync.ok) {
      const err = new Error(`Git sync failed before ${task}: ${sync.error}`);
      err.is_preflight_error = true;
      throw err;
    }
    if (sync.action === 'pulled') {
      console.log(chalk.green(`✓ Pulled ${sync.behind} commit(s) from origin/${expectedBranch} before ${task}`));
    } else if (sync.action === 'ahead-only') {
      console.log(chalk.yellow(`⚠ Local ${expectedBranch} has ${sync.ahead} unpushed commit(s) — included in the next push`));
    }
  }

  // Phase 32 (MI-10, verdict correction): detect an incremental re-audit
  // BEFORE resolveConfig/routeModel run for real — hoisted above both so the
  // FINAL resolveConfig, routeModel, and runClaude invocations below all use
  // the literal task 'audit-incremental', never 'audit'. Root cause: 'audit's
  // conditional opus floor (config/model-routing.json hard_floors.audit) is
  // gated on >=3 scan candidates but applies fail-safe (unconditionally) when
  // the caller supplies no size signals — and the single-call incremental
  // path never supplies any — so every diff-scoped re-audit up to
  // max_chain_rounds was paying opus regardless of size. Detected exactly
  // ONCE here (needs cfg.audit.force_full_every_n, present on either task's
  // resolved cfg since `audit` is a plain top-level config section, not
  // per-task) and threaded into buildGuidePrompt's 'audit' case below instead
  // of re-detected there — the old double detectIncrementalAudit call was a
  // latent TOCTOU.
  const auditIncremental = task === 'audit' ? await detectIncrementalAudit(projDir, cfg) : null;
  if (auditIncremental) {
    cfgTask = 'audit-incremental';
    cfg = await resolveConfig({ project: projectName, phase: phaseN, task: 'audit-incremental' });
    preflightOrThrow(cfg);
  }

  // v0.17 (size-gated opus floors): plan/roadmap floors are conditional on
  // brief size — thread the signals so a small brief drafts on the sonnet
  // baseline (plan-validate + coverage-BLOCKER regen is the quality backstop).
  const sizeMeta = await computeGuideSizeMeta({ task, projDir, plan });
  const routing = await routeModel({ cfg, task: cfgTask, phaseMeta, projectName, sizeMeta });
  cfg.model = routing.model;
  if (cfg.model_routing?.show_reasoning_in_log) {
    console.log('   Task:       ' + cfgTask);
    console.log('   Complexity: ' + routing.complexity);
    for (const r of routing.reasoning) console.log('     • ' + r);
    console.log('   Model:      ' + routing.model);
  }

  // v0.14.36: full audits split into Sonnet scan → Opus adjudicate. Incremental
  // re-audits (already O(diff) input) and audit.two_stage:false stay on the
  // single-call path below.
  const auditWasIncremental = !!auditIncremental;
  if (task === 'audit' && !auditIncremental && cfg.audit?.two_stage !== false) {
    return runTwoStageAudit({ projectName, projDir, project, plan, cfg, routing, phaseN, phaseMeta }, deps);
  }

  // lessons-distill (phase 8): the cutoff must be captured from the raw jsonl
  // BEFORE the guide call runs, so finalizeDistillation() below knows exactly
  // which entries this distillation covered (anything appended concurrently
  // after the cutoff survives truncation untouched).
  const distillCutoff = task === 'lessons-distill' ? await computeDistillCutoff(projDir) : null;

  // workspace-claude-md (phase 10): materialize the fixed skill templates +
  // git-push deny rule deterministically, BEFORE the LLM call that authors the
  // bespoke workspace/CLAUDE.md. Byte-for-byte template fidelity and JSON-key
  // preservation are not safe to delegate to a prompt (see workspace-skills.js
  // header comment) — this is plain Node fs, immune to paraphrase. Gated by a
  // config kill-switch and best-effort: a failure here must never block
  // CLAUDE.md generation itself.
  if (task === 'workspace-claude-md' && cfg.workspace_claude_md?.generate_skills !== false) {
    try {
      const workspaceDir = path.join(projDir, cfg.paths.workspace_subdir);
      const preserveExisting = cfg.workspace_claude_md?.preserve_existing !== false;
      const denyRules = Array.isArray(cfg.security?.deny_rules) ? cfg.security.deny_rules : [];
      const materialized = await materializeWorkspaceSkills(workspaceDir, PROMPTS_DIR, { preserveExisting, denyRules });
      if (materialized.written.length || materialized.settingsChanged) {
        console.log(chalk.dim(
          `  → Workspace skills: wrote [${materialized.written.join(', ') || 'none'}]`
          + (materialized.skipped.length ? `, skipped [${materialized.skipped.join(', ')}] (already present)` : '')
          + `, settings.json ${materialized.settingsChanged ? 'updated' : 'unchanged'}`,
        ));
      }
    } catch (err) {
      console.warn(chalk.yellow(`[workspace-claude-md] could not materialize workspace skills/settings (non-fatal, CLAUDE.md generation continues): ${err.message}`));
    }
  }

  // Phase 20 (brief P3, handoff-anchor half): computed ONCE so the prompt's
  // "Write to:" instruction (buildGuidePrompt's 'handoff' case, below) and
  // the post-call anchor-append (near the end of this function) target the
  // EXACT same file. handoffPath(projDir) mints a fresh timestamp on every
  // bare call — calling it again after the guide call returns would silently
  // point at a file that was never written.
  const handoffOutPath = task === 'handoff' ? handoffPath(projDir) : null;

  // Phase 20 (brief P3, tracking half) — the guide's OWN last-seen HEAD is
  // diffed here, before the freshSessionTasks/sessionId decision below, so
  // Phase 21's large-drift reground check (immediately below) can reuse this
  // SAME raw delta for its threshold decision instead of computing it a
  // second time. (The two-stage full-audit path returns above before
  // reaching here — it never resumes a session either way, so it has no use
  // for this.)
  const lastGuideHeadSha = parseProjectMetadata(project.metadata_json).last_guide_head_sha || null;
  const guideHeadDelta = await computeGuideHeadDelta(workspaceDir, lastGuideHeadSha);
  const guideDeltaCtx = renderGuideHeadDeltaBlock(guideHeadDelta);

  // Phase 40 (CE-5): 'review' and 'bug-plan' run in FRESH, task-scoped sessions
  // when guide_context.fresh_task_sessions is on (default) — their durable
  // continuity artifacts (decisions.jsonl, reviews, handoffs, the phase ledger)
  // are already externalized and re-injected as assembled per-call context, so
  // resuming the lifetime guide session only dragged 100k+ of history for no
  // gain. Gated so fresh_task_sessions:false restores the resumed (role:'guide',
  // --resume) behaviour byte-for-byte. CRITICAL: these two tasks ALSO run
  // role:null (see `role` below) — role:'guide' would make runClaude clobber
  // guide_session_id with the fresh session id on its success path, corrupting
  // continuity for the still-resumed next-prompt/fix-prompt/handoff calls.
  const freshTaskSessionsOn = cfg.guide_context?.fresh_task_sessions !== false;
  const freshTaskScopedTasks = freshTaskSessionsOn ? ['review', 'bug-plan'] : [];

  // Sessions: plan/handoff/workspace-claude-md/brief-author/audit/roadmap all start fresh
  const freshSessionTasks = [
    'plan', 'handoff', 'workspace-claude-md', 'brief-author', 'audit', 'roadmap',
    'project-context-gen', 'requirement-refine', 'plan-validate', 'lessons-distill',
    ...freshTaskScopedTasks,
  ];

  // Phase 21 (brief P3, large-drift reground half) — only a task that would
  // otherwise RESUME a session (not in freshSessionTasks) is eligible: a
  // fresh-session task carries no stale beliefs to reground in the first
  // place (the single-call 'audit' path is itself a freshSessionTask; the
  // two-stage full-audit path never reaches this code at all — see above).
  // Idempotent per HEAD via metadata_json.last_reground_sha — a key distinct
  // from last_guide_head_sha because last_guide_head_sha only advances on a
  // SUCCESSFUL call: a failed retry at the same drifted HEAD must not
  // re-generate a handoff or re-clear the session a second time, so
  // last_reground_sha is set unconditionally as soon as the reground ACTION
  // is taken, before this call's own outcome is known.
  const lastRegroundSha = parseProjectMetadata(project.metadata_json).last_reground_sha || null;
  const regroundReason = freshSessionTasks.includes(task)
    ? null
    : buildGuideRegroundReason({ delta: guideHeadDelta, cfg: cfg.guide_reground });
  const shouldReground = !!regroundReason && !!guideHeadDelta?.headSha && guideHeadDelta.headSha !== lastRegroundSha;
  let regroundNotifyText = null;

  if (shouldReground) {
    // Best-effort: reuses the same two primitives the manual `npm run
    // handoff` flow already exercises (job-runner.js's 'handoff' case) —
    // generate a handoff for the CURRENT (about-to-be-discarded) session
    // state, then clear guide_session_id. A handoff-generation failure must
    // never block the reground itself: a stale resumed session is worse than
    // a slightly-stale handoff.
    try {
      const handoffResult = await runGuide({ projectName, task: 'handoff', slot }, deps);
      if (handoffResult?.is_error) {
        console.warn(chalk.yellow(`[guide-reground] handoff generation returned an error, re-grounding anyway: ${(handoffResult.error_message || handoffResult.result || '').toString().slice(0, 200)}`));
      }
    } catch (err) {
      console.warn(chalk.yellow(`[guide-reground] handoff generation failed, re-grounding anyway: ${err.message}`));
    }
    setGuideSessionId(projectName, null);
    await setProjectMetadataField(projectName, 'last_reground_sha', guideHeadDelta.headSha);
    console.log(chalk.cyan(`↺ Guide re-grounded for ${projectName}: ${regroundReason}`));
    regroundNotifyText = buildGuideRegroundNotifyText({ projectName, reason: regroundReason });
  }

  const prompt = await buildGuidePrompt({
    task, projectName, projDir, project, plan, brief, round, fix, cfg, handoffOutPath, auditIncremental,
    reviewMode, reviewBatch, reviewPhaseN, pinnedWorktree,
  });

  // Phase 21: a reground forces a fresh session for THIS call regardless of
  // what project.guide_session_id says — that in-memory `project` snapshot
  // was fetched at the top of this function and does NOT reflect the
  // setGuideSessionId(null) above (or the handoff call's own DB writes);
  // assigning null directly here is deliberate, not a stale read.
  const sessionId = shouldReground ? null : (freshSessionTasks.includes(task) ? null : project.guide_session_id);
  // lessons-distill is a roleless call (same session-safety class as
  // acceptance-check/retrospective, per the brief): role 'guide' would make
  // runClaude clobber guide_session_id even though sessionId is already null
  // above — this task must never touch that bookkeeping. Phase 40 extends this
  // to 'review'/'bug-plan' when fresh_task_sessions is on (freshTaskScopedTasks)
  // for the SAME reason: role:'guide' + a fresh session id would overwrite the
  // guide_session_id the resumed next-prompt/fix-prompt/handoff calls depend on.
  const role = (task === 'lessons-distill' || freshTaskScopedTasks.includes(task)) ? null : 'guide';

  const ctxExtra      = await loadProjectContextBlock(projDir);
  // Phase 18 (brief P2): delta block used to sit in systemPromptExtra
  // immediately after ctxExtra — nothing to flag as stale when there's no
  // context block above it (ctxExtra null → deltaCtx null, unconditionally).
  // CE-3 / cache-stable-system-prefix: deltaCtx changes on every call by
  // construction (it's a git diff since the guide's last-seen HEAD), so it
  // now rides in `prompt` instead — see the volatileCtx compose below.
  const deltaCtx      = ctxExtra ? await loadContextDeltaBlock(workspaceDir, projDir) : null;
  // Phase 19 (brief P2, auto-refresh + notice half): same ctxExtra gate as
  // deltaCtx above — nothing to refresh/notice if there's no stamped artifact
  // yet. Never contributes to a prompt block (side-effecting check only) —
  // attached to the returned result below instead.
  const freshnessCheck = ctxExtra ? await loadContextFreshnessCheck(workspaceDir, projDir, projectName, cfg) : null;
  // CE-3 (verdict correction): --append-system-prompt is reconstructed from
  // scratch on EVERY invocation — it is never part of the CLI's own session
  // history, so a resumed call does NOT "already have" handoffCtx from a
  // prior turn the way it has its own prior messages. Gating handoffCtx to
  // fresh sessions only is therefore a deliberate information-loss tradeoff
  // (a resumed session relies on its own conversation history instead), not a
  // redundancy removal — accepted here because it's what keeps this call's
  // systemPromptExtra byte-stable across the far more common resumed-session
  // path, which is where the cache win actually lives.
  const handoffCtx    = sessionId === null ? await loadMostRecentHandoffBlock(projDir) : null;
  const suggestCtx    = (task === 'plan' || task === 'next-prompt')
    ? await loadSuggestionsBlock(projDir, slot, projectName)
    : null;
  // Reprompt hint: written by auto-runner when a phase times out and the prompt
  // is being regenerated. Injected here so the guide knows to generate a tighter,
  // more focused prompt. Cleared after successful phase completion. Volatile
  // (per-timeout, one-shot) — moved into `prompt` below, same as deltaCtx.
  let repromptCtx = null;
  if (task === 'next-prompt') {
    const hintFile = path.join(projDir, '.guide', `phase-${phaseN}-reprompt.hint`);
    try { repromptCtx = await fs.readFile(hintFile, 'utf-8'); } catch { /* no hint file */ }
  }
  // Phase 16 (brief P1): repo map only for codebase-reading guide tasks
  // (cfg.repo_map.guide_tasks, in resolveConfig task-id namespace — see
  // shouldInjectRepoMap above). Volatile (changes with HEAD every phase) —
  // moved into `prompt` below, same cache-discipline rule as devSystemPromptExtra.
  // Phase 40: 'bug-plan' is listed in repo_map.guide_tasks so the map injects
  // for a fresh, task-scoped bug-plan session — but ONLY when fresh_task_sessions
  // is on. Flag off keeps bug-plan resuming with today's exact, map-free prompt
  // (mode isolation), so it is excluded from injection in that case even though
  // it stays in the config list.
  const mapCtx = (shouldInjectRepoMap({ guideTasks: cfg.repo_map?.guide_tasks, cfgTask })
    && !(task === 'bug-plan' && !freshTaskSessionsOn))
    ? await loadRepoMapBlock(workspaceDir, projDir, cfg)
    : null;
  // CE-3 / cache-stable-system-prefix (merged): systemPromptExtra keeps ONLY
  // blocks that are byte-stable across resumed calls (handoffCtx is gated to
  // fresh sessions above, so it qualifies too — a resumed call never sees it
  // change mid-session because it never contributes to a resumed call at
  // all). deltaCtx/guideDeltaCtx/repromptCtx/mapCtx are volatile per-call —
  // they now prepend to `prompt` instead (see promptWithVolatileCtx below),
  // so a byte-change in any of them never busts the cached system prefix that
  // the REST of a resumed guide conversation depends on.
  // P1 cache-discipline rule still applies to every block that DOES feed
  // systemPromptExtra: byte-identical across calls for unchanged inputs (see
  // phase-runner-cache-discipline.test.mjs).
  const systemPromptExtra = [handoffCtx, ctxExtra, suggestCtx].filter(Boolean).join('\n\n') || null;

  // Phase 80 (brief 05 P3): cross-project global lessons — injected into
  // plan-creation ONLY among guide tasks (globalLessonsEligible). Volatile
  // (accumulates across projects/runs), so it rides in the user prompt like
  // deltaCtx/mapCtx, never the cached system prefix. Fail-open: any error →
  // no block, plan-creation proceeds unchanged.
  let globalLessonsCtx = null;
  if (globalLessonsEligible({ scope: 'plan-creation', cfg }) && cfgTask === 'plan-creation') {
    try {
      const stackTags = await computeWorkspaceStackTags(workspaceDir);
      const selected = await selectGlobalLessons({
        phaseMeta: null,
        stackTags,
        topK: cfg?.lessons?.global?.inject_top_k ?? 3,
        now: new Date().toISOString(),
      });
      globalLessonsCtx = renderGlobalLessonsBlock(selected);
    } catch { /* fail-open — global-store hiccup never blocks plan creation */ }
  }

  // Volatile per-call context, in the same relative order the old
  // systemPromptExtra used (deltaCtx immediately after where ctxExtra was,
  // guideDeltaCtx right after deltaCtx, then repromptCtx, then mapCtx last —
  // it changes with HEAD, the most volatile signal of the set). Prepended to
  // the user prompt so it can vary freely without touching the system prefix.
  const volatileCtx = [deltaCtx, guideDeltaCtx, repromptCtx, mapCtx, globalLessonsCtx].filter(Boolean).join('\n\n');
  let promptWithVolatileCtx = volatileCtx ? `${volatileCtx}\n\n${prompt}` : prompt;

  // Guard against Linux MAX_ARG_STRLEN (~131072 bytes): a single CLI arg string
  // cannot exceed the kernel's per-argument limit. The repo-map (mapCtx) is the
  // largest component and it grows with the workspace. If the assembled prompt
  // would exceed 110KB (conservative margin below the 128KB kernel limit), drop
  // mapCtx so the spawn succeeds — the guide can still use Read/Glob/Grep tools.
  const MAX_PROMPT_ARG_BYTES = 110000;
  if (promptWithVolatileCtx.length > MAX_PROMPT_ARG_BYTES && mapCtx) {
    console.warn(chalk.yellow(`[runner] ${projectName}:${task} prompt arg too large (${promptWithVolatileCtx.length} bytes > ${MAX_PROMPT_ARG_BYTES}), dropping mapCtx to avoid E2BIG`));
    const reducedVolatile = [deltaCtx, guideDeltaCtx, repromptCtx, globalLessonsCtx].filter(Boolean).join('\n\n');
    promptWithVolatileCtx = reducedVolatile ? `${reducedVolatile}\n\n${prompt}` : prompt;
  }

  const result = await runClaudeFn({
    cfg, cwd: projDir, prompt: promptWithVolatileCtx,
    systemPromptFile: path.join(PROMPTS_DIR, 'guide-system.md'),
    systemPromptExtra,
    sessionId,
    role, project: projectName, task: cfgTask,
    // v0.17 (OBS-2): thread the routeModel() decision computed above into
    // recordCall — guide tasks have no attempt/escalation ladder today, so
    // those fields are left undefined (recordCall persists NULL/0 for them).
    routing: { tier: routing.tier, reasoning: routing.reasoning },
  });

  if (result.session_id && role === 'guide') await recordGuideSession(projDir, result.session_id);

  // Phase 77 (brief 08 / P1b) — output contract on the narrative artifacts these
  // guide tasks author (project-context.md, lessons-distilled.md). The guide
  // already wrote the file during the call above; runArtifactContractOnExistingCall
  // reuses THAT result (no extra spawn when the artifact is valid) and, on a
  // structural miss (missing heading / out-of-bounds length), resumes the SAME
  // session for exactly ONE re-ask naming the file + errors, then re-reads. Runs
  // BEFORE the compaction / finalizeDistillation / stampArtifact steps below so
  // those operate on the corrected file. Fail-open: a still-invalid artifact only
  // logs a warning and proceeds — control flow is unchanged, matching the brief's
  // fail-open-by-default rule. enabled:false is byte-identical to pre-phase-77.
  const guideArtifactContract = (!result.is_error && cfg.llm_contract?.enabled !== false)
    ? resolveGuideArtifactContract({ task, projDir })
    : null;
  if (guideArtifactContract) {
    const contractOutcome = await runArtifactContractOnExistingCall({
      existingResult: result,
      baseCall: {
        cfg, cwd: projDir, role: null, project: projectName, task: cfgTask,
        systemPromptFile: path.join(PROMPTS_DIR, 'guide-system.md'), systemPromptExtra,
      },
      artifactReader: guideArtifactContract.artifactReader,
      filePath: guideArtifactContract.filePath,
      maxReasks: Number.isInteger(cfg.llm_contract?.max_reasks) ? cfg.llm_contract.max_reasks : 1,
      runClaude: runClaudeFn,
    });
    if (!contractOutcome.ok && !contractOutcome.spawnError) {
      console.warn(chalk.yellow(`⚠ ${task} output contract failed after ${contractOutcome.reasks} re-ask(s) (${guideArtifactContract.filePath}): ${(contractOutcome.errors || []).join('; ')} — proceeding (fail-open).`));
    }
  }

  // Phase 20 (brief P3, tracking half) — record the workspace HEAD this
  // guide call saw, for the NEXT guide call's drift computation above
  // (loadGuideHeadDeltaBlock). role==='guide' excludes the roleless
  // lessons-distill call (see `role` above, which never touches session
  // bookkeeping either). Best-effort, matching every other post-call stamp
  // in this function — a failure here only means the next call sees
  // drift:'unknown' instead of a precise delta; it never fails the spawn.
  if (!result.is_error && role === 'guide') {
    try {
      if (await isGitRepo(workspaceDir)) {
        const sha = await getHeadSha(workspaceDir);
        if (sha) await setProjectMetadataField(projectName, 'last_guide_head_sha', sha);
      }
    } catch (err) {
      console.warn(chalk.yellow(`[guide-head-delta] could not record last-seen HEAD: ${err.message}`));
    }
  }

  // Phase 31 — usage-based compaction trigger for the (previously dead)
  // phases.handoff_when_context_tokens_exceed config. Best-effort and
  // strictly POST-call (result is already final) so it never blocks the task
  // that just ran. Reuses the exact two primitives Phase 22's drift-reground
  // already exercises (generate a handoff, clear guide_session_id) — this is
  // a SECOND independent trigger on the same primitives, never a parallel
  // mechanism.
  const { threshold: compactionThreshold, warning: compactionWarning } =
    resolveCompactionThreshold(cfg.phases?.handoff_when_context_tokens_exceed);
  if (compactionWarning) console.warn(chalk.yellow(`[context-compaction] ${compactionWarning}`));

  let compactionReason = null;
  let compactionNotifyText = null;
  const lastCompactSessionId = parseProjectMetadata(project.metadata_json).last_compact_session_id || null;
  if (shouldCompactGuideSession({
    result, role, task, freshSessionTasks, threshold: compactionThreshold, lastCompactSessionId,
  })) {
    compactionReason = `guide context ${result.last_turn_context_tokens} tokens > ${compactionThreshold} tokens — session compacted`;
    // Stamped FIRST, unconditionally — mirrors the reground's stamp-before-
    // outcome rationale (Phase 22, `last_reground_sha`): a retry that lands
    // after this point must never re-trigger on the same session_id, even if
    // the recursive handoff call below fails.
    await setProjectMetadataField(projectName, 'last_compact_session_id', result.session_id);
    try {
      const handoffResult = await runGuide({ projectName, task: 'handoff', slot }, deps);
      if (handoffResult?.is_error) {
        console.warn(chalk.yellow(`[context-compaction] handoff generation returned an error, compacting anyway: ${(handoffResult.error_message || handoffResult.result || '').toString().slice(0, 200)}`));
      }
    } catch (err) {
      console.warn(chalk.yellow(`[context-compaction] handoff generation failed, compacting anyway: ${err.message}`));
    }
    setGuideSessionId(projectName, null);
    console.log(chalk.cyan(`⇲ Guide session compacted for ${projectName}: ${compactionReason}`));
    // Same builder family as the drift-reground notice (Phase 22) — reusing
    // buildGuideRegroundNotifyText's `↺ {project}: guide re-grounded — {reason}`
    // wording lets notifyGuideRegroundIfAny (auto-runner.js) deliver this with
    // ZERO auto-runner changes, since it only reads result._guide_reground.
    compactionNotifyText = buildGuideRegroundNotifyText({ projectName, reason: compactionReason });
  }

  // Phase 20 (brief P3, handoff-anchor half) — append the deterministic
  // commit anchor to the handoff file the guide just wrote (handoffOutPath
  // was captured before the call, above, so this targets the exact same
  // file the prompt pointed the guide at).
  if (task === 'handoff' && !result.is_error && handoffOutPath) {
    try {
      if (await isGitRepo(workspaceDir)) {
        const sha = await getHeadSha(workspaceDir);
        if (sha) await appendHandoffAnchor(handoffOutPath, sha);
      }
    } catch (err) {
      console.warn(chalk.yellow(`[handoff] could not append commit anchor: ${err.message}`));
    }
  }

  // lessons-distill: cap the distilled markdown to max_distilled_lines and
  // drop every raw jsonl entry the distillation covered (best-effort — a
  // failure here just means the backlog gets re-attempted on the next check).
  if (task === 'lessons-distill' && !result.is_error) {
    await finalizeDistillation(projDir, distillCutoff, cfg, { projectName }).catch(() => {});
  }

  // A review agent may `cd workspace` while investigating and then resolve a
  // relative `.guide/reviews/...` Write against that directory. Older prompts
  // allowed that ambiguity, which made pickNextAction see the canonical file
  // as missing and dispatch the entire review again. New prompts use an
  // absolute path; this recovery also makes the boundary robust if an agent
  // still writes the legacy location. Move only when canonical is absent.
  if (task === 'review' && !result.is_error) {
    const expectedReview = reviewMode === 'panel'
      ? reviewLensPath(projDir, reviewPhaseN, 1)
      : reviewPath(projDir, reviewPhaseN);
    const misplacedReview = path.join(workspaceDir, '.guide', 'reviews', path.basename(expectedReview));
    try {
      await fs.access(expectedReview);
    } catch {
      try {
        await fs.access(misplacedReview);
        await fs.mkdir(path.dirname(expectedReview), { recursive: true });
        await fs.rename(misplacedReview, expectedReview);
        console.warn(chalk.yellow(`[review] recovered misplaced artifact ${misplacedReview} → ${expectedReview}`));
      } catch { /* no misplaced artifact — normal downstream missing-file handling */ }
    }
  }

  // v0.14.34: stamp the workspace HEAD this audit covered so the NEXT audit
  // can scope itself to the diff (incremental re-audit). Best-effort — a
  // failure here just means the next audit runs full-scope. Delete
  // .guide/audits/.last-audit.json to force full scope manually.
  if (task === 'audit' && !result.is_error) {
    try {
      const ws = path.join(projDir, 'workspace');
      if (await isGitRepo(ws)) {
        const sha = await getHeadSha(ws);
        if (sha) {
          // v0.14.48: the single-call path only runs for incremental audits
          // (full audits go through runTwoStageAudit when two_stage != false).
          // Stamp with wasIncremental:true so the consecutive-streak counter
          // advances toward force_full_every_n. (When two_stage IS false, a
          // full single-call audit lands here too; detectIncrementalAudit
          // returned non-null only for a real diff, so treating it as
          // incremental is correct — and the unchanged-HEAD guard still forces
          // a full pass next time regardless.)
          await stampLastAudit(projDir, sha, { wasIncremental: auditWasIncremental });
        }
      }
    } catch (err) {
      console.warn(chalk.yellow(`[audit] could not stamp last-audit sha: ${err.message} (next audit will be full-scope)`));
    }
  }

  // Phase 36 — panel review: lens 1 (the call just made, targeting
  // after-N-lens-1.md — see buildGuidePrompt's 'review' case) succeeded;
  // spawn lenses 2/3 and merge. Lens 1 erroring is NOT handled here — a
  // failed result already fails the review action exactly like a full-review
  // error does today, same as before this phase. A failure anywhere INSIDE
  // runReviewPanel (a lens 2/3 spawn error) never surfaces as this call's own
  // error — mergeLensReviews' fail-safe (pause-and-fix/0 + warning) already
  // covers a missing/failed lens.
  if (task === 'review' && reviewMode === 'panel' && !result.is_error) {
    await runReviewPanel({ projectName, projDir, phaseN: reviewPhaseN, cfg, reviewBatch, reviewChangedFiles }, { runClaudeFn });
  }

  // Phase 40 (CE-5) — stamp the workspace HEAD a SUCCESSFUL review covered so
  // the NEXT review's assembled context can diff --stat from it (see
  // buildReviewContextBlock). Mirrors the last_guide_head_sha stamp above:
  // best-effort and success-ONLY — a failed review must never advance the
  // baseline, or the next review would silently miss everything the failed one
  // was supposed to cover. Stamped regardless of the fresh_task_sessions flag so
  // toggling it on later always has a baseline to diff from; nothing reads the
  // value unless the flag is on, so this is invisible to the flag-off prompt.
  if (task === 'review' && !result.is_error) {
    try {
      if (await isGitRepo(workspaceDir)) {
        const sha = await getHeadSha(workspaceDir);
        if (sha) await setProjectMetadataField(projectName, 'last_review_sha', sha);
      }
    } catch (err) {
      console.warn(chalk.yellow(`[review] could not record last_review_sha: ${err.message}`));
    }
  }

  // Phase 17 (brief P2, stamping half) — the ORCHESTRATOR (never the LLM)
  // prepends/updates `{ generated_at_sha, generated_at }` front-matter on the
  // narrative context artifact these two tasks author, right after a
  // successful call. No spawn injection of the delta this enables yet — that
  // is phase 18. Best-effort: a failure here just means this artifact stays
  // drift-unknown (contextDelta's caller treats no/stale front-matter as
  // drift-unknown, never as a reason to fail the guide call).
  if ((task === 'project-context-gen' || task === 'workspace-claude-md') && !result.is_error) {
    try {
      if (await isGitRepo(workspaceDir)) {
        const sha = await getHeadSha(workspaceDir);
        const artifactPath = task === 'project-context-gen'
          ? projectContextPath(projDir)
          : path.join(workspaceDir, 'CLAUDE.md');
        if (sha && await fileExists(artifactPath)) {
          await stampArtifact(artifactPath, sha);
        }
      }
    } catch (err) {
      console.warn(chalk.yellow(`[${task}] could not stamp artifact with HEAD sha: ${err.message}`));
    }
  }

  return {
    ...result, routing, _context_freshness: freshnessCheck,
    // Phase 22 (brief P3, notify-wiring half): mirrors _context_freshness
    // above — the DECISION (regroundReason/regroundNotifyText) was already
    // made and acted on further up this function; attaching it here is what
    // lets auto-runner.js's notifyGuideRegroundIfAny actually deliver the
    // Telegram line (mirrors notifyContextDriftIfAny reading
    // result._context_freshness.notifyText). null on every call that didn't
    // re-ground — never dead code again.
    // Phase 31: a token-based compaction only fills this field when the
    // drift-based reground above didn't already fire this call — drift
    // takes priority, compaction is the fallback signal, never a second
    // simultaneous notice.
    _guide_reground: {
      reason: regroundReason || compactionReason,
      notifyText: regroundNotifyText || compactionNotifyText,
    },
    // Phase 32/34 (attach scope for the P4 skip-adjudication-when-clean
    // feature): pure metadata, no DB write here — 'incremental' for a real
    // diff-scoped re-audit, 'full' for the single-call path taken when
    // audit.two_stage:false and detection found no diff to scope to.
    ...(task === 'audit' ? { audit_scope: auditWasIncremental ? 'incremental' : 'full' } : {}),
  };
}

// v0.14.36: the two-stage full audit. Mirrors runGuide's tail exactly for the
// adjudicate result (guide-session bookkeeping + .last-audit.json stamp) so
// callers can't tell the difference except by the extra 'audit-scan' row in
// the calls table and the scan file on disk.
async function runTwoStageAudit({ projectName, projDir, project, plan, cfg, routing, phaseN, phaseMeta }, deps = {}) {
  const runClaudeFn = deps.runClaude ?? runClaude;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.mkdir(auditDir(projDir), { recursive: true });
  const scanOutPath = path.join(auditDir(projDir), `scan-${ts}.md`);
  const auditOutPath = auditPath(projDir);

  const ctxExtra = await loadProjectContextBlock(projDir);
  const handoffCtx = await loadMostRecentHandoffBlock(projDir);
  // Phase 16: this systemPromptExtra is shared by BOTH stages below (scan
  // task id 'audit-scan', adjudicate task id 'audit') — the map is generated
  // and injected ONCE here, not once per stage. Either task id present in
  // repo_map.guide_tasks is enough to trigger it for the shared block.
  const workspaceDir = path.join(projDir, cfg.paths.workspace_subdir);
  const mapCtx = (
    shouldInjectRepoMap({ guideTasks: cfg.repo_map?.guide_tasks, cfgTask: 'audit-scan' })
    || shouldInjectRepoMap({ guideTasks: cfg.repo_map?.guide_tasks, cfgTask: 'audit' })
  ) ? await loadRepoMapBlock(workspaceDir, projDir, cfg) : null;
  // Phase 18 (brief P2): delta block sits immediately after ctxExtra below.
  const deltaCtx = ctxExtra ? await loadContextDeltaBlock(workspaceDir, projDir) : null;
  // Phase 19: same ctxExtra gate, same "never touches systemPromptExtra" rule
  // as runGuide's freshnessCheck above.
  const freshnessCheck = ctxExtra ? await loadContextFreshnessCheck(workspaceDir, projDir, projectName, cfg) : null;
  const systemPromptExtra = [handoffCtx, ctxExtra, deltaCtx, mapCtx].filter(Boolean).join('\n\n') || null;

  // Stage 1 — Sonnet scan. Own task id ('audit-scan') so it routes to its own
  // baseline (sonnet, no opus floor) and shows up separately in /spend.
  const scanCfg = await resolveConfig({ project: projectName, phase: phaseN, task: 'audit-scan' });
  const scanRouting = await routeModel({ cfg: scanCfg, task: 'audit-scan', phaseMeta, projectName });
  scanCfg.model = scanRouting.model;

  // Phase 53 (par-06): shard the scan stage across up to audit.scan_shards
  // concurrent role:null spawns once the workspace has grown past
  // audit.shard_min_files tracked files — the scan stage is the long pole of
  // a full audit (it reads the whole tree), so N Sonnet calls reading
  // disjoint top-level directories concurrently beats one call reading
  // everything serially. Below the threshold, or scan_shards<=1, `shards`
  // stays null and the single-call path a few lines down runs EXACTLY as
  // before (buildAuditScanPrompt with no scopeDirs is byte-identical).
  let shards = null;
  const configuredShards = Number.isInteger(cfg.audit?.scan_shards) ? cfg.audit.scan_shards : 1;
  if (configuredShards > 1) {
    const shardMinFiles = Number.isInteger(cfg.audit?.shard_min_files) ? cfg.audit.shard_min_files : Infinity;
    const tracked = await listTrackedFiles(workspaceDir);
    if (tracked.ok && tracked.files.length >= shardMinFiles) {
      const bins = buildAuditShards({ files: tracked.files, shardCount: configuredShards });
      if (bins.length > 1) {
        shards = bins.map((bin, i) => ({
          dirs: bin.dirs,
          fileCount: bin.fileCount,
          outPath: path.join(auditDir(projDir), `scan-${ts}-shard-${i + 1}.md`),
        }));
      }
    }
  }

  let scanOutPaths = [scanOutPath];
  let scanResult;

  if (shards) {
    console.log(chalk.cyan(`▸ Two-stage audit — stage 1/2: scan on ${scanCfg.model} (${shards.length} shards)`));
    // role:null on every shard spawn (unlike the single-call path's
    // role:'guide' below) — concurrent successes racing setGuideSessionId
    // would corrupt guide continuity for whichever call's session id lands
    // last. Each spawn still records its own 'audit-scan' calls row
    // (recordCall persists task/project/model regardless of role).
    const settled = await Promise.allSettled(shards.map((shard) => runClaudeFn({
      cfg: scanCfg, cwd: projDir,
      prompt: buildAuditScanPrompt({ projectName, projDir, plan, scanOutPath: shard.outPath, scopeDirs: shard.dirs }),
      systemPromptFile: path.join(PROMPTS_DIR, 'guide-system.md'),
      systemPromptExtra,
      sessionId: null,
      role: null, project: projectName, task: 'audit-scan',
      routing: { tier: scanRouting.tier, reasoning: scanRouting.reasoning },
    })));

    const failures = [];
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      const label = `shard ${i + 1} (${shards[i].dirs.join(', ')})`;
      if (s.status === 'rejected') { failures.push(`${label}: ${s.reason?.message || s.reason}`); continue; }
      if (s.value.is_error) { failures.push(`${label}: ${s.value.error_message || s.value.result || 'is_error'}`); continue; }
      if (!(await fileExists(shards[i].outPath))) {
        failures.push(`${label}: no output file at ${path.relative(projDir, shards[i].outPath)}`);
      }
    }

    // Fail-open: ANY shard problem discards the whole sharded attempt and
    // falls back to ONE full single scan below — this is the one retry; a
    // failing fallback aborts exactly like today (no partial-shard
    // adjudication, ever).
    if (failures.length === 0) {
      scanOutPaths = shards.map((s) => s.outPath);
      scanResult = settled[0].value;
    } else {
      console.warn(chalk.yellow(`⚠ Audit scan shard(s) failed — falling back to a single full scan:\n  ${failures.join('\n  ')}`));
      shards = null;
    }
  }

  if (!shards) {
    console.log(chalk.cyan(`▸ Two-stage audit — stage 1/2: scan on ${scanCfg.model}`));
    const scanPrompt = buildAuditScanPrompt({ projectName, projDir, plan, scanOutPath });
    scanResult = await runClaudeFn({
      cfg: scanCfg, cwd: projDir, prompt: scanPrompt,
      systemPromptFile: path.join(PROMPTS_DIR, 'guide-system.md'),
      systemPromptExtra,
      sessionId: null,
      role: 'guide', project: projectName, task: 'audit-scan',
      routing: { tier: scanRouting.tier, reasoning: scanRouting.reasoning },
    });
    scanOutPaths = [scanOutPath];
  }

  if (scanResult.is_error) {
    console.error(chalk.red(`✗ Audit scan stage failed — aborting before adjudication.`));
    return { ...scanResult, routing: scanRouting, two_stage: { failed_stage: 'scan' } };
  }
  for (const p of scanOutPaths) {
    if (!(await fileExists(p))) {
      console.error(chalk.red(`✗ Audit scan completed but wrote no candidates file (${path.relative(projDir, p)}).`));
      return {
        ...scanResult, is_error: true,
        error_message: `audit-scan produced no candidates file at ${path.relative(projDir, p)}`,
        routing: scanRouting, two_stage: { failed_stage: 'scan' },
      };
    }
  }

  const isSharded = scanOutPaths.length > 1;
  const scanTexts = await Promise.all(scanOutPaths.map((p) => readText(p)));

  // Phase 33 (QL-5) — a scan that provably found ZERO candidates still paid a
  // whole adjudication call just to write "clean". Skip stage 2 entirely when
  // isCleanScan() agrees (fail-safe: anything not provably clean falls
  // through to adjudication exactly as before). Gated behind
  // audit.skip_adjudication_when_clean (default true). Phase 53: the
  // trailer/heading heuristic isCleanScan() parses assumes ONE scan file —
  // aggregating "candidates: N" trailers across shard files is unsafe (the
  // no-`g`-flag regex would silently read only the first shard's trailer), so
  // a sharded scan always proceeds to adjudication; a genuinely clean sharded
  // scan just costs one cheap confirming adjudication call instead of zero.
  const skipAdjudicationWhenClean = cfg.audit?.skip_adjudication_when_clean !== false;
  if (!isSharded && skipAdjudicationWhenClean && isCleanScan(scanTexts[0])) {
    console.log(chalk.cyan('▸ Two-stage audit — scan found zero candidates, skipping adjudication (audit.skip_adjudication_when_clean)'));
    await writeCleanScanAuditFile({ projectName, projDir, scanOutPath: scanOutPaths[0], auditOutPath, scanModel: scanCfg.model });
    await stampFullAuditTail(projectName, projDir, workspaceDir);
    return {
      is_error: false,
      result: `Clean scan (0 candidates) — adjudication skipped, wrote ${path.relative(projDir, auditOutPath)}`,
      session_id: scanResult.session_id,
      routing: scanRouting,
      two_stage: { scan_file: scanOutPaths[0], scan_model: scanCfg.model, adjudication_skipped: true },
      _context_freshness: freshnessCheck,
      audit_scope: 'full-clean-skip',
    };
  }

  // Stage 2 — adjudication over the candidate list. v0.17 (size-gated opus
  // floors): the 'audit' hard floor is conditional on min_candidates, but
  // runGuide's routing happened BEFORE the scan existed (no signals → floor
  // applied fail-safe). Now that the candidate count is known, re-route: a
  // 0-2 candidate list needs no opus judge and adjudicates on the sonnet
  // baseline. An unreadable/malformed scan yields candidates:null → no
  // sizeMeta → the floor applies, exactly as before.
  let adjRouting = routing;
  const candidateCount = sumScanCandidates(scanTexts);
  if (candidateCount != null) {
    // Phase 33 fix: `cfg.model` already carries the fail-safe opus decision
    // routeModel() made at the top of runGuide (no sizeMeta known before the
    // scan ran) — reusing `cfg` as-is here makes routeModel's step 2 ("phase
    // model_override already merged via cfg.model") mistake that carried-over
    // value for an intentional per-phase override and re-apply opus
    // unconditionally, silently defeating this whole re-route (the
    // 0-2-candidate → sonnet path was unreachable). A phase-level
    // model_override never targets the 'audit' task (loadPlanPhaseOverride
    // only sets models['dev-execution']), so resetting `.model` here for this
    // one lookup discards nothing legitimate.
    adjRouting = await routeModel({ cfg: { ...cfg, model: undefined }, task: 'audit', phaseMeta, projectName, sizeMeta: { candidates: candidateCount } });
    cfg.model = adjRouting.model;
    if (cfg.model_routing?.show_reasoning_in_log) {
      console.log(chalk.dim(`   Adjudication re-routed on scan yield (${candidateCount} candidate(s)):`));
      for (const r of adjRouting.reasoning) console.log('     • ' + r);
    }
  }
  console.log(chalk.cyan(`▸ Two-stage audit — stage 2/2: adjudicate on ${cfg.model}`));
  const adjPrompt = buildAuditAdjudicatePrompt({
    projectName, projDir, plan, scanOutPath: scanOutPaths[0], scanOutPaths: isSharded ? scanOutPaths : null, auditOutPath,
  });
  const result = await runClaudeFn({
    cfg, cwd: projDir, prompt: adjPrompt,
    systemPromptFile: path.join(PROMPTS_DIR, 'guide-system.md'),
    systemPromptExtra,
    sessionId: null,
    role: 'guide', project: projectName, task: 'audit',
    routing: { tier: adjRouting.tier, reasoning: adjRouting.reasoning },
  });

  if (result.session_id) await recordGuideSession(projDir, result.session_id);

  // Phase 20 (brief P3, tracking half) — same tracking as runGuide()'s tail;
  // a two-stage full audit is still a successful guide-role call and must
  // update the guide's last-seen HEAD, or every guide call following a full
  // audit would see an inflated (or simply wrong) drift count. Same
  // .last-audit.json stamp as the single-call path (Phase 33: shared with the
  // clean-scan skip path above via stampFullAuditTail).
  if (!result.is_error) await stampFullAuditTail(projectName, projDir, workspaceDir);

  return {
    ...result,
    routing: adjRouting,
    two_stage: {
      scan_file: scanOutPaths[0], scan_model: scanCfg.model,
      // Phase 53 (par-06): only present when the scan stage actually sharded —
      // an unsharded (or fallen-back) run keeps today's exact two-field shape.
      ...(isSharded ? { shard_count: scanOutPaths.length, scan_files: scanOutPaths.map((p) => path.relative(projDir, p)) } : {}),
    },
    _context_freshness: freshnessCheck,
    // Phase 32/34: pure metadata (see runGuide's matching field) — a two-stage
    // audit is always a full-codebase scan, never diff-scoped.
    audit_scope: 'full',
  };
}

// Shared tail bookkeeping for a successful FULL audit — taken by both the
// normal adjudicated path and the Phase 33 clean-scan skip path, since both
// cover the whole codebase as of the current HEAD. Best-effort (matches the
// pre-Phase-33 inline blocks this replaces): a failure here just means the
// next guide call sees an inflated drift count, or the next audit runs
// full-scope instead of incremental.
async function stampFullAuditTail(projectName, projDir, workspaceDir) {
  try {
    if (await isGitRepo(workspaceDir)) {
      const sha = await getHeadSha(workspaceDir);
      if (sha) await setProjectMetadataField(projectName, 'last_guide_head_sha', sha);
    }
  } catch (err) {
    console.warn(chalk.yellow(`[guide-head-delta] could not record last-seen HEAD: ${err.message}`));
  }
  try {
    const ws = path.join(projDir, 'workspace');
    if (await isGitRepo(ws)) {
      const sha = await getHeadSha(ws);
      // Always a FULL audit here (adjudicated or clean-skipped) — wasIncremental:false
      // resets the consecutive-incremental streak (v0.14.48).
      if (sha) await stampLastAudit(projDir, sha, { wasIncremental: false });
    }
  } catch (err) {
    console.warn(chalk.yellow(`[audit] could not stamp last-audit sha: ${err.message} (next audit will be full-scope)`));
  }
}

// Phase 33 (QL-5) — deterministic final-audit content for a scan that
// isCleanScan() confirmed found zero candidates. Written directly by the
// orchestrator (no second LLM call). The "## Promote to bugs-round-N" heading
// + single-line body reuse AUDIT_PROMOTE_RULES' own clean-audit wording
// verbatim, so audit-promote.js's NOTHING_TO_PROMOTE_RE match (and downstream
// promoteAuditToBugs()'s { promoted:false, clean:true }) is exactly the same
// as a real adjudicated clean audit. round is cosmetic only — the promote
// parser's SECTION_HEADER_RE does not capture N; promoteAuditToBugs computes
// its own target round independently.
function buildCleanScanAuditContent({ projectName, relScanPath, scanModel, isoDate, round }) {
  return `# Audit — ${projectName}

Generated: ${isoDate}
Scan file: ${relScanPath}
Scan model: ${scanModel}

The scan stage found zero candidates. Adjudication was skipped (audit.skip_adjudication_when_clean) — there is nothing for a second-stage judge to review.

## Killed candidates
(none — scan reported zero candidates)

## Top-3 recommendations
(none — no candidates found)

## Promote to bugs-round-${round}
(nothing to promote — no CRITICAL or MAJOR findings)
`;
}

async function writeCleanScanAuditFile({ projectName, projDir, scanOutPath, auditOutPath, scanModel }) {
  const isoDate = new Date().toISOString();
  const round = ((await detectHighestBugRound(projDir)) || 0) + 1;
  const content = buildCleanScanAuditContent({
    projectName,
    relScanPath: path.relative(projDir, scanOutPath),
    scanModel,
    isoDate,
    round,
  });
  await fs.mkdir(auditDir(projDir), { recursive: true });
  await fs.writeFile(auditOutPath, content, 'utf-8');
}

/**
 * Phase 68 (brief 05 P3 — parallel phase waves): the SHARED completion
 * bookkeeping for ONE finished phase, extracted verbatim from runDev's serial
 * completion block so the ascending-merge step (auto-runner.js's runPhaseWave)
 * and runDev's own serial path invoke ONE implementation — never two copies
 * that can drift. It marks the phase complete at `commit_sha`, advances the
 * scalar `current_phase`, and clears the phase's reprompt hint + both
 * failure-escalation markers.
 *
 * current_phase keeps its documented meaning ("max contiguous completed n")
 * FOR FREE: the merge step calls this once per merged phase in STRICT ASCENDING
 * order, so each setCurrentPhase advances the scalar one contiguous step. This
 * helper is pure DB + marker bookkeeping — it does NOT push, run git, or append
 * the phase ledger (the serial path owns the ledger append, which needs the
 * report/workspace context this deliberately does not take).
 *
 * @param {object} a
 * @param {string} a.projectName
 * @param {number} a.n            completed phase number
 * @param {string} a.commit_sha   the merged/committed HEAD sha for this phase
 * @param {string} a.projDir      projects/<p> (hint + marker files live under .guide)
 * @param {object} [deps]         test seams (markPhaseCompleted / setCurrentPhase)
 */
export function completeMergedPhase({ projectName, n, commit_sha, projDir }, deps = {}) {
  const markPhaseCompletedFn = deps.markPhaseCompleted ?? markPhaseCompleted;
  const setCurrentPhaseFn = deps.setCurrentPhase ?? setCurrentPhase;
  markPhaseCompletedFn({ project: projectName, n, commit_sha });
  setCurrentPhaseFn(projectName, n);
  // Clean up any reprompt hint left by auto-reprompt-on-timeout so it doesn't
  // get injected into future guide calls for this phase.
  const hintFile = path.join(projDir, '.guide', `phase-${n}-reprompt.hint`);
  fs.unlink(hintFile).catch(() => { /* file may not exist — ignore */ });
  // A completed phase clears its failure-escalation markers — both the
  // new-format name and any legacy one still on disk.
  fs.unlink(escalationMarkerPath(projDir, { phaseN: n })).catch(() => {});
  fs.unlink(legacyEscalationMarkerPath(projDir, { phaseN: n })).catch(() => {});
}

// Phase 51 (P1 async report-mode): `deferVerify` (default false) — when the
// caller opts in AND cfg.verify.mode is 'report' AND cfg.verify.async_report
// is true AND the phase would have run the checker at all, the inline
// acceptance-check hook below is skipped entirely (no spawn) and
// result.deferred_verify carries what a detached background worker
// (verify-loop.js's runDetachedAcceptanceCheck, spawned by auto-runner.js)
// needs to run the SAME checker later against a pinned worktree. Every other
// combination — gate mode, async_report:false, fixes, or a caller that omits
// deferVerify — is byte-for-byte identical to pre-phase-51 behavior; gate
// mode in particular never defers (it must stay fully synchronous).
// `deps.runClaude` mirrors runGuide's own test seam (phase-22) — the real
// runClaude spawns a `claude` subprocess and is otherwise unreachable from a
// test without one. Threaded into runPhaseAcceptanceCheck/runAcceptanceGateLoop
// too so a test can stub the checker's own runClaude in the same call.
export function resolveInterruptedPhaseSessionId({ cfg, priorPhaseState, fix, isBatch, laneMode }) {
  if (fix || isBatch || laneMode) return null;
  if (cfg?.phases?.resume_interrupted_session === false) return null;
  if (priorPhaseState?.status !== 'in-progress') return null;
  const externalKinds = new Set(['provider-limit', 'network', 'process', 'window-headroom']);
  if (!externalKinds.has(priorPhaseState?.interruption_kind)) return null;
  // Never replay a failed lower-tier context into an escalated model. Exact
  // model equality is intentionally stricter than tier equality because two
  // model revisions can have different context/continuation semantics.
  if (!priorPhaseState?.model_used || !cfg?.model || priorPhaseState.model_used !== cfg.model) return null;
  return priorPhaseState.session_id || null;
}

export function shouldReconcileInterruptedPhaseCommit({
  cfg, priorPhaseState, fix, isBatch, laneMode,
  headSha, phaseCommit, reportExists, hasValidationFailure,
}) {
  if (fix || isBatch || laneMode) return false;
  if (cfg?.phases?.reconcile_committed_phase_before_spawn === false) return false;
  if (priorPhaseState?.status !== 'in-progress') return false;
  if (!headSha || phaseCommit !== headSha) return false;
  if (!reportExists || hasValidationFailure) return false;
  return true;
}

export async function runDev({ projectName, fix, batchFixes = null, deferVerify = false, laneMode = false, laneDir = null, laneBranch = null, lanePhaseN = null, modelOverride = null }, deps = {}) {
  const runClaudeFn = deps.runClaude ?? runClaude;
  const compileContextManifestFn = deps.compileContextManifest ?? compileContextManifest;
  const recordContextManifestFn = deps.recordContextManifest ?? recordContextManifest;
  const recordContextOutcomeFn = deps.recordContextOutcome ?? recordContextOutcome;
  const recordContextCompileEventFn = deps.recordContextCompileEvent
    ?? (deps.compileContextManifest ? (() => {}) : recordContextCompileEvent);
  const getLatestSessionContextFn = deps.getLatestSessionContext ?? getLatestSessionContext;
  // Phase 70 (brief 05 P5) — a single-call minor-fix batch: ONE spawn commits
  // several fixes (one commit each). Treated like `fix` for task/routing/git
  // purposes, but with NO single fix identity — no escalation/validation
  // marker resolution, no per-fix idempotency shortcut, no push/gate/record
  // bookkeeping here (the auto-runner's runFixSingleCallBatch owns all of
  // that, once, across the whole batch). See the early-return below.
  const isBatch = Array.isArray(batchFixes) && batchFixes.length > 0;
  // Phase 67 (brief 05 P2 — lane mode): the completion-bookkeeping calls a lane
  // run must NEVER make are routed through injectable seams, so a lane-mode test
  // can spy them and assert zero calls. Non-lane runs default to the real
  // imports — behavior is byte-identical (deps.* is only set in tests).
  const markPhaseCompletedFn = deps.markPhaseCompleted ?? markPhaseCompleted;
  const setCurrentPhaseFn = deps.setCurrentPhase ?? setCurrentPhase;
  const pushBranchFn = deps.pushBranch ?? pushBranch;
  const project = getProject(projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);

  const projDir = path.join(PROJECTS_DIR, projectName);
  const plan = await readJson(planJsonPath(projDir));
  // Same plan-based next-phase logic as pickNextAction and runGuide — plain +1
  // breaks when the plan uses non-sequential numbering (continuation plans).
  // Phase 68 (brief 05 P3 — parallel waves): a lane runs a SPECIFIC phase, not
  // "the next one after current_phase". Every lane in a wave reads the same
  // pre-wave current_phase, so without this override each would derive the SAME
  // lowest-uncompleted n and the lanes would collide. lanePhaseN pins the lane
  // to its own phase; the non-lane path is byte-identical (lanePhaseN null).
  const nextPhase = (fix || isBatch)
    ? null
    : (laneMode && Number.isInteger(lanePhaseN))
      ? lanePhaseN
      : (plan?.phases?.find((p) => p.n > (project.current_phase || 0))?.n ?? (project.current_phase || 0) + 1);
  const phaseMeta = !fix && !isBatch && plan?.phases?.find((p) => p.n === nextPhase);
  const phaseIndex = !fix && !isBatch && Array.isArray(plan?.phases)
    ? plan.phases.findIndex((p) => p.n === nextPhase)
    : -1;
  const phaseOrdinal = phaseIndex >= 0 ? phaseIndex + 1 : null;
  const isFinalPhase = phaseIndex >= 0 && phaseIndex === plan.phases.length - 1;
  // Capture this BEFORE markPhaseStarted: an account-limit interruption leaves
  // the row in-progress with its Claude session id, while markPhaseStarted is
  // allowed to refresh timestamps/model metadata for the resumed attempt.
  const priorPhaseState = !fix && !isBatch
    ? getPhases(projectName).find((p) => p.n === nextPhase) || null
    : null;

  let cfg = await resolveConfig({ project: projectName, phase: nextPhase, task: (fix || isBatch) ? 'fix-execution' : 'dev-execution' });
  const rolloutResolution = resolveEffectiveContextCompilerMode({ projectName, cfg });
  cfg = rolloutResolution.cfg;
  if (rolloutResolution.changed) {
    console.log(chalk.cyan(
      `  → Context compiler rollout ${rolloutResolution.configured_mode}→${rolloutResolution.effective_mode} (${rolloutResolution.recommendation})`,
    ));
  }
  preflightOrThrow(cfg);
  const gitProject = reconcileProjectGitConfig({
    projectName,
    project,
    configuredProject: cfg._resolved?.project_data,
  });

  const routing = await routeModel({ cfg, task: (fix || isBatch) ? 'fix-execution' : 'dev-execution', phaseMeta: phaseMeta || null, projectName });
  cfg.model = routing.model;

  // Phase 72 (speculative duo leg — the "model-override seam" MI-8 mandates):
  // force this run's model, overriding whatever routeModel picked. A force_tier
  // phase routes BOTH duo legs to the same tier, so this is the ONLY way the
  // opus leg and the fable leg get DIFFERENT models off the SAME phase. Inert
  // when unset (null): every non-duo caller is byte-for-byte identical. Only
  // ever set by src/lib/duo-executor.js's runSpeculativeDuo (laneMode always
  // true alongside it — a duo leg is a lane).
  if (modelOverride) {
    cfg.model = modelOverride;
    routing.model = modelOverride;
    routing.tier = modelToTier(modelOverride, cfg.model_routing?.tier_models);
    routing.reasoning.push(`duo leg model override → ${modelOverride} (tier ${routing.tier})`);
  }

  // v0.14.36/38 → phase-23: failure-driven escalation. A phase OR fix that
  // previously failed (dev error, no-commit, validator-gate failure) leaves an
  // escalation marker; its re-run is pinned UPWARD to the marker's target tier
  // regardless of routing. The tier is tier-relative (sonnet→opus, opus→fable);
  // a legacy `*-escalate-opus.marker` still on disk resolves to opus. Cleared
  // on completion / gate pass. Both marker names are cleaned up (a mid-run
  // legacy marker may coexist with a freshly-written new-format one).
  // Phase 70 (brief 05 P5): a single-call batch has no single fix identity, so
  // it never consults or writes an escalation/validation marker — a failed
  // batch falls back to INDIVIDUAL fix-dev dispatch, which resolves its own
  // markers per fix as usual. escalateMarkerPath/legacyEscalateMarkerPath/
  // validationMarkerPath stay null and escalated stays false for a batch call.
  const escalateMarkerPath = isBatch ? null : escalationMarkerPath(projDir, { fix, phaseN: nextPhase });
  const legacyEscalateMarkerPath = isBatch ? null : legacyEscalationMarkerPath(projDir, { fix, phaseN: nextPhase });
  // v0.14.38: validation-failed marker. Written when the validator gate fails
  // after the mechanical retry. Content = the gate's failure excerpt. Its
  // presence (a) blocks the commit-reconcile shortcuts from resurrecting the
  // failing commit as "complete", and (b) injects the failure output into the
  // retry's prompt so the agent fixes FORWARD instead of guessing.
  const validationMarkerPath = isBatch
    ? null
    : fix
      ? path.join(projDir, '.guide', `fix-r${fix.round}-${fix.n}-validation-failed.marker`)
      : path.join(projDir, '.guide', `phase-${nextPhase}-validation-failed.marker`);
  const escResolution = isBatch ? { targetTier: null } : await resolveEscalation({ projDir, phaseN: nextPhase, fix });
  // Phase 72: a duo leg (modelOverride set) never consults the escalation marker
  // — its model is pinned by the override, and the marker would otherwise pull
  // the opus leg UP to fable, defeating the whole point of racing two tiers.
  const escalated = !modelOverride && escResolution.targetTier != null;
  if (escalated) {
    const targetTier = escResolution.targetTier;
    const targetModel = cfg.model_routing?.tier_models?.[targetTier]
      || (targetTier === 'opus' ? 'claude-opus-4-8' : null);
    // Only escalate UPWARD — a phase whose routing already sits at or above the
    // target tier (v0.17: force_tier'd fable phases; a lower-than-routed marker)
    // must never be pulled DOWN by the marker; it keeps its routed model and
    // still gets the effort boost below.
    if (targetModel && cfg.model !== targetModel && tierIndex(routing.tier) < tierIndex(targetTier)) {
      cfg.model = targetModel;
      routing.model = targetModel;
      routing.tier = targetTier;
      routing.reasoning.push(`${fix ? 'fix' : 'phase'} previously failed → failure-driven escalation to ${targetTier} (marker present)`);
    }
    // v0.17 (MI-4): the escalated re-run also gets a one-level reasoning-
    // effort boost over the task's configured effort (unset → CLI-default
    // 'high' → 'xhigh'). Applied via cfg._effort_override, which runClaude
    // turns into a per-invocation --settings effortLevel arg.
    cfg._effort_override = bumpEffort(cfg.phases?.task_effort?.[fix ? 'fix-execution' : 'dev-execution']);
    routing.reasoning.push(`escalated retry → reasoning effort boosted to ${cfg._effort_override}`);
  } else {
    // v0.17 (complexity-tiered turn budgets): cap this call's turn budget by
    // the routed complexity — a flailing low-complexity phase dies at the
    // budget, not at 150 turns of superlinearly-growing context. Clamps only
    // (never raises), and escalated re-runs above skip it entirely (a retry
    // that already failed once deserves the full budget). Calibration data:
    // calls.num_turns.
    const turnBudget = resolveComplexityTurnBudget(cfg.phases, routing.complexity);
    if (turnBudget != null) {
      cfg.phases = applyTurnBudget(cfg.phases, turnBudget);
      routing.reasoning.push(`complexity '${routing.complexity}' → turn budget ≤${turnBudget} (phases.turn_budget_by_complexity)`);
    }
  }

  if (cfg.model_routing?.show_reasoning_in_log) {
    console.log('   Task:       ' + ((fix || isBatch) ? 'fix-execution' : 'dev-execution'));
    console.log('   Complexity: ' + routing.complexity);
    for (const r of routing.reasoning) console.log('     • ' + r);
    console.log('   Model:      ' + routing.model);
  }

  // Phase 67 (brief 05 P2 — lane mode): a lane run operates entirely inside its
  // private worktree (laneDir). Everything downstream — spawn cwd, pre-flight,
  // validator gate, acceptance check — keys off workspaceDir, so pointing it at
  // laneDir is the single thread that puts the whole run in the lane. A non-lane
  // run is byte-identical (laneMode false → the original expression).
  const workspaceDir = (laneMode && laneDir)
    ? laneDir
    : path.join(projDir, cfg.paths.workspace_subdir);

  // Git pre-flight — gate dispatch on a valid, on-branch, remoted workspace.
  // The expected branch comes from project.git_branch (set via migrate-git
  // or `npm run new`). Projects with no git_branch yet are treated as
  // legacy/opted-out — we don't enforce, but we won't push either.
  const expectedBranch = gitProject.git_branch;
  if (laneMode) {
    // Relaxed lane pre-flight (brief 05 P2): the lane branch is LOCAL-ONLY (never
    // pushed, no upstream), so we skip the remote requirement AND syncWithRemote
    // entirely. We KEEP a clean-tree check — restricted to TRACKED-file
    // modifications, since the provisioned lane carries expected untracked files
    // (node_modules symlink, copied .env, materialized .claude/skills) — so a
    // corrupt provisioning can't silently feed the dev spawn a dirty base.
    const pf = await preflightForDev(workspaceDir, { expectedBranch: laneBranch, requireRemote: false });
    if (!pf.ok) {
      const err = new Error(`Lane git pre-flight failed: ${pf.error}`);
      err.is_preflight_error = true;
      throw err;
    }
    const st = await workspaceStatus(workspaceDir, { includeUntracked: false });
    if (!st.clean) {
      const err = new Error(`Lane git pre-flight failed: worktree ${workspaceDir} has ${st.dirty.length} uncommitted change(s) to tracked files before the dev spawn`);
      err.is_preflight_error = true;
      throw err;
    }
  } else if (expectedBranch) {
    const pf = await preflightForDev(workspaceDir, { expectedBranch });
    if (!pf.ok) {
      const err = new Error(`Git pre-flight failed: ${pf.error}`);
      err.is_preflight_error = true;
      throw err;
    }

    // Sync with remote — pull anything pushed from another host since the
    // last dev call. This is what prevents the NAS from running claude
    // against a stale workspace when you've pushed from your Mac. Halts on
    // divergence (data integrity — no auto-rebase).
    const sync = await syncWithRemote(workspaceDir, { branch: expectedBranch });
    if (!sync.ok) {
      const err = new Error(`Git sync failed: ${sync.error}`);
      err.is_preflight_error = true;
      throw err;
    }
    if (sync.action === 'pulled') {
      console.log(chalk.green(`✓ Pulled ${sync.behind} commit(s) from origin/${expectedBranch}`));
    } else if (sync.action === 'ahead-only') {
      console.log(chalk.yellow(`⚠ Local ${expectedBranch} has ${sync.ahead} unpushed commit(s) — they will be included in the next push`));
    } else if (sync.action === 'no-upstream') {
      console.log(chalk.dim(`  (no upstream tracking yet for ${expectedBranch} — will be set on first push)`));
    }
  }

  // Phase 16 (brief P1): generate/refresh the repo map for the workspace HEAD
  // exactly as it stands right after the sync above (never before it — the
  // pre-sync HEAD could be stale). Dev/fix spawns get it unconditionally (no
  // guide_tasks gating — that list scopes GUIDE codebase-reading tasks only);
  // repo_map.enabled:false still short-circuits inside generateRepoMap itself.
  // Phase 38 (CE-6): loadRepoMapBlock (and the generateRepoMap it wraps) runs
  // HERE unconditionally so the on-disk map stays fresh for the get_repo_map
  // MCP tool even when cfg.mcp.enabled swaps the rendered block for the
  // pointer below — only the INJECTED mapCtx changes, the refresh never skips.
  // Phase 39 (CE-4): focus the injected map on the files this phase/fix
  // actually expects to touch — phaseMeta.files_expected for a phase, the
  // round plan's files_likely (resolveFixPhaseMeta, verify-loop.js) for a
  // fix. A resolve failure or an empty list both fall back to the unfocused
  // block (loadRepoMapBlock treats a null/empty focusPaths as "no focus").
  const focusMeta = fix ? await resolveFixPhaseMeta(projDir, fix) : phaseMeta;
  const focusPaths = focusMeta?.files_expected?.length ? focusMeta.files_expected : null;
  const repoMapBlock = await loadRepoMapBlock(workspaceDir, projDir, cfg, { focusPaths });
  let mapCtx = cfg.mcp?.enabled ? MCP_REPO_MAP_POINTER_BLOCK : repoMapBlock;

  // Phase 41 (QL-8/CE-9): fix-execution context parity. phaseMeta is falsy for a
  // fix, so everything keyed off it (lessons relevance scoring, the gate-fail
  // lesson's files) went context-starved on the work MOST likely to repeat a
  // prior failure. Read the round-plan fix entry ONCE here — hoisted OUT of the
  // inline-prompt branch below so it runs regardless of which prompt path is
  // taken — and derive a SEPARATE fixLessonMeta (never the real phaseMeta, which
  // routing/phase bookkeeping consume). Also resolve the SOURCE-audit pointer
  // (written by promoteAuditToBugs) so the inline fix prompt can point the dev at
  // the original finding's file:line evidence. Every read is best-effort/fail-open.
  let fixEntry = null;
  let fixLessonMeta = null;
  let sourceAuditRel = null;
  if (fix) {
    const roundPlan = await readJson(fixPlanJsonPath(projDir, fix.round));
    fixEntry = (roundPlan?.fixes || []).find((f) => f.n === fix.n) || null;
    fixLessonMeta = buildFixLessonMeta(fix, fixEntry);
    const auditPtr = await readText(path.join(bugRoundDir(projDir, fix.round), 'source-audit.txt'));
    const ptrTrim = auditPtr && auditPtr.trim();
    // The pointer stores a projDir-relative path; the dev's CWD is workspaceDir.
    if (ptrTrim) sourceAuditRel = path.relative(workspaceDir, path.resolve(projDir, ptrTrim));
  }

  // Phase 42: materialize .guide/project-conventions.md (durable decisions
  // grouped by type + distilled anti-patterns) from current sources, guarded
  // by a content-hash stamp so an unchanged decisions.jsonl/lessons-distilled.md
  // pair is a no-op write. Runs from this pre-spawn path, before either prompt
  // builder — best-effort (fail-open NFR): a write failure never blocks the
  // phase/fix, it just leaves hasConventions at whatever was already on disk.
  const conventionsEnabled = cfg.conventions_file?.enabled !== false;
  if (conventionsEnabled) {
    try {
      await materializeProjectConventions(projDir);
    } catch (err) {
      console.warn(chalk.yellow(`[project-conventions] materialize failed: ${err.message}`));
    }
  }
  const hasConventions = conventionsEnabled && await fileExists(projectConventionsPath(projDir));

  const promptFile = isBatch
    ? null
    : fix
      ? await fixPromptPath(projDir, fix.round, fix.n, fix.title)
      : await phasePromptPath(projDir, nextPhase, phaseMeta?.title);

  // v0.14.35: inline phase prompts. The per-phase next-prompt guide call mostly
  // restated plan.json's phase spec — so when no prompt.md exists, the dev
  // prompt is now built directly from the plan phase + decisions.jsonl + brief
  // (one fewer serial Sonnet call per phase). A prompt.md on disk always wins
  // (manually authored, or regenerated by the reprompt-on-timeout path, which
  // still routes through the guide). Fixes keep their per-fix prompt-gen —
  // bug-specific synthesis earns its call. Disable via
  // phases.inline_phase_prompts:false to restore the guide call for every phase.
  let phasePrompt;
  let batchCompilerMeta = null;
  const inlinePrompts = cfg.phases?.inline_phase_prompts !== false;
  const inlineFixPrompts = cfg.fixes?.inline_fix_prompts !== false;
  if (isBatch) {
    // Phase 70 (brief 05 P5) — always inline, always fresh: pickBugAction only
    // ever emits fix-dev-single-call-batch when cfg.fixes.inline_fix_prompts is
    // on, so there is no promptFile/guide-call fallback path to consider here,
    // unlike the single-fix branch below. One round-plan read for the whole
    // batch (batchFixes are always the same round — selectMinorFixBatch never
    // spans rounds).
    const roundPlanForBatch = await readJson(fixPlanJsonPath(projDir, batchFixes[0].round));
    const fixesWithMeta = batchFixes.map((bf) => ({
      ...bf,
      fixMeta: (roundPlanForBatch?.fixes || []).find((e) => e.n === bf.n) || null,
    }));
    batchCompilerMeta = {
      title: `Fix batch r${batchFixes[0].round} [${batchFixes.map((entry) => entry.n).join(', ')}]`,
      goal: fixesWithMeta.map((entry) => entry.fixMeta?.goal || entry.fixMeta?.description || entry.title || '').filter(Boolean).join('\n'),
      acceptance_criteria: fixesWithMeta.flatMap((entry) => entry.fixMeta?.acceptance_criteria || []),
      files_likely: [...new Set(fixesWithMeta.flatMap((entry) => entry.fixMeta?.files_likely || entry.fixMeta?.files_expected || []))],
    };
    phasePrompt = await buildInlineFixBatchPrompt({
      projectName, round: batchFixes[0].round, fixes: fixesWithMeta, projDir, workspaceDir, plan, hasConventions,
    });
    console.log(chalk.dim(`  → Inline fix batch prompt for round ${batchFixes[0].round} fixes ${batchFixes.map((f) => f.n).join(', ')} (single call; no per-fix guide calls)`));
  } else if (await fileExists(promptFile)) {
    phasePrompt = await fs.readFile(promptFile, 'utf-8');
  } else if (!fix && inlinePrompts && phaseMeta) {
    // Phase 55 (P8, speculative scout): a note drafted for THIS phase (by a
    // scout that ran concurrently with the PREVIOUS phase's dev call) is
    // read, staleness-checked, and consumed here — the only call site that
    // needs it. cfg.phases.scout.enabled:false (the default) short-circuits
    // loadPhaseScoutBlock to null with no fs read, so this line is a no-op
    // for every project that hasn't opted in.
    const scoutNote = await loadPhaseScoutBlock(projDir, workspaceDir, nextPhase, cfg);
    phasePrompt = buildInlinePhasePrompt({ projectName, phaseMeta, plan, projDir, workspaceDir, hasConventions, scoutNote });
    console.log(chalk.dim(`  → Inline phase prompt for phase ${nextPhase} (plan spec + decisions.jsonl + brief; no guide call)`));
  } else if (fix && inlineFixPrompts) {
    // v0.14.37: same treatment for fixes — bugs.md + the round's plan.json
    // already carry the spec in canonical format; the fix-prompt-gen call was
    // restating them at ~1:1 output volume with the fixes themselves. Phase 41:
    // fixEntry is the hoisted read above (shared with fixLessonMeta); sourceAuditRel
    // adds one read-list line pointing the dev at the source audit finding.
    phasePrompt = buildInlineFixPrompt({ projectName, fix, fixMeta: fixEntry, projDir, workspaceDir, plan, sourceAuditRel, hasConventions });
    console.log(chalk.dim(`  → Inline fix prompt for r${fix.round}-${fix.n} (plan.json entry + bugs.md pointers; no guide call)`));
  } else {
    throw new Error(`Prompt file not found: ${promptFile}`);
  }

  // v0.14.38: forward-fix context. If the previous attempt committed but
  // failed the validator gate, its failure output rides into this attempt's
  // prompt — the agent fixes what the validators flagged instead of guessing
  // why it's being re-run (the failing commit is still in the workspace).
  const priorValidationFailure = await readText(validationMarkerPath);
  if (priorValidationFailure && priorValidationFailure.trim()) {
    phasePrompt += _buildValidationFailureBlock(priorValidationFailure, !!fix);
  }
  // Resolve the interrupted session FIRST so the escalation note can be
  // suppressed when we are resuming that session. An interrupted-but-escalated
  // phase is already running on the higher-tier model; injecting both blocks
  // would tell the agent to "plan from scratch" and "continue where you left
  // off" simultaneously, which produces contradictory behaviour.
  const interruptedSessionId = resolveInterruptedPhaseSessionId({ cfg, priorPhaseState, fix, isBatch, laneMode });
  let priorInterruptedContext = null;
  if (interruptedSessionId) {
    try { priorInterruptedContext = getLatestSessionContextFn(interruptedSessionId); } catch { /* conservative reinjection below */ }
  }

  // Schema 19: compile a deterministic, task-scoped context manifest after
  // prompt construction (so inline/manual prompt references participate) and
  // after Git sync/repo-map refresh (so the cache is current). Shadow mode is
  // deliberately behavior-free: it persists/attributes the manifest but
  // injects zero tokens. Assist/enforce inject once per exact manifest/session
  // pair: an interrupted resume skips the block only when persisted call
  // attribution proves that the session already received this manifest.
  // Every failure returns null and the existing repo-map path wins.
  let compiledContextBlock = null;
  let contextManifest = null;
  let compiledContextUse = { inject: false, degraded: false, force_full_verification: false, reason: 'no-manifest' };
  if (cfg.context_compiler?.enabled === true) {
    const compilerMeta = isBatch ? (batchCompilerMeta || {}) : fix ? (focusMeta || fixEntry || {}) : (phaseMeta || {});
    const compilerBaseSha = await getHeadSha(workspaceDir).catch(() => null);
    const manifest = await compileContextWithinTimeout({
      workspaceDir,
      projDir,
      projectName,
      baseSha: compilerBaseSha,
      cfg,
      task: {
        task_kind: priorValidationFailure?.trim() ? 'validator-repair' : isBatch ? 'batch-fix' : fix ? 'fix' : 'phase',
        phase: fix ? null : nextPhase,
        title: compilerMeta.title || fix?.title || phaseMeta?.title || null,
        goal: compilerMeta.goal || compilerMeta.description || null,
        criteria: compilerMeta.acceptance_criteria || [],
        explicit_paths: compilerMeta.files_expected || compilerMeta.files_likely || focusPaths || [],
        failed_criteria: priorValidationFailure?.trim() ? [priorValidationFailure.slice(0, 8000)] : [],
        prompt_text: phasePrompt.slice(0, 30000),
        complexity: routing.complexity,
        checkpoint: compilerMeta.checkpoint || null,
        execution_variant: modelOverride || (laneMode ? laneBranch : null),
      },
    }, compileContextManifestFn, recordContextCompileEventFn);
    if (manifest) {
      contextManifest = manifest;
      try { recordContextManifestFn(manifest); } catch (err) {
        console.warn(chalk.yellow(`[context-compiler] telemetry write failed: ${err.message}`));
      }
      compiledContextUse = resolveCompiledContextUse(cfg, manifest);
      // A persisted session id alone is not proof that this exact manifest is
      // already in its conversation. The task/config/base SHA can change while
      // a usage-limited run is paused. Reuse only when the newest attributed
      // call proves the same manifest was exposed; otherwise inject the new
      // bounded block once so resumed work cannot continue from stale context.
      const sessionOwnsCompiledContext = Boolean(interruptedSessionId)
        && priorInterruptedContext?.manifest_id === manifest.manifest_id
        && Number(priorInterruptedContext?.injected_tokens || 0) > 0;
      const inject = compiledContextUse.inject && !sessionOwnsCompiledContext;
      let contextRecoveryBlock = null;
      if (compiledContextUse.inject) {
        try {
          contextRecoveryBlock = renderCompiledContextBlock(manifest, { maxTokens: manifest.token_budget });
          if (inject) compiledContextBlock = contextRecoveryBlock;
        } catch (err) {
          console.warn(chalk.yellow(`[context-compiler] render failed open: ${err.message}`));
        }
      }
      const contextExposed = compiledContextUse.inject
        && (Boolean(compiledContextBlock) || sessionOwnsCompiledContext);
      // Suppress the broad map for an interrupted resume only when a bounded
      // recovery block was rendered too. If claude-runner later has to discard
      // that session, it can restore the compiled block. On render failure we
      // deliberately keep the map in the prompt so a forced fresh retry is not
      // launched without either source of repository context.
      const sessionOwnsRecoverableCompiledContext = sessionOwnsCompiledContext
        && Boolean(contextRecoveryBlock);
      mapCtx = resolveDevRepoMapContext({
        mapCtx,
        compiledContextUse,
        compiledContextBlock,
        sessionOwnsCompiledContext: sessionOwnsRecoverableCompiledContext,
      });
      cfg._context_compiler = {
        manifest_id: manifest.manifest_id,
        provider: manifest.provider,
        mode: manifest.mode,
        // A resumed session does not receive a duplicate literal block, but it
        // still exposes/replays the original manifest context on this call.
        injected_tokens: contextExposed ? manifest.injected_token_estimate : 0,
        exposed: contextExposed,
        // Kept only in this in-memory resolved config. If claude-runner must
        // discard a corrupt/stalled resumed session and retry fresh, it can
        // restore the exact bounded block instead of launching context-free.
        recovery_block: contextRecoveryBlock,
      };
      console.log(chalk.dim(
        `  → Context compiler ${manifest.mode}: ${manifest.ranked_files.length} files, ` +
        `${manifest.ranked_symbols.length} symbols, confidence ${manifest.confidence}` +
        (compiledContextBlock
          ? `, ~${manifest.injected_token_estimate} tokens injected`
          : contextExposed
            ? `, ~${manifest.injected_token_estimate} tokens retained in resumed session`
            : ', zero tokens injected') +
        (compiledContextUse.degraded ? ` (${compiledContextUse.reason}; full verification)` : ''),
      ));
    }
  }
  // v0.17 (MI-4): prompt-level nudge for escalated retries — a reinforcement
  // of the effort boost above, not a thinking-budget trigger (the keyword→
  // budget mapping is legacy on adaptive-thinking models). Lives in the
  // volatile prompt, never the cached system prompt (P1 cache discipline).
  // Suppressed when resuming an interrupted session: we are continuing the
  // already-escalated attempt, not starting a new one.
  if (escalated && !interruptedSessionId) {
    phasePrompt += `\n\n<escalation_note>\nThis is an escalated retry after a prior failed attempt. Think hard before acting: plan your approach against the acceptance criteria first, then execute.\n</escalation_note>`;
  }
  if (interruptedSessionId) {
    phasePrompt += `\n\n<interrupted_session_resume>\nThis phase was interrupted by an external condition (${priorPhaseState.interruption_kind}). You are resuming the SAME Claude session on the SAME model, so your earlier context and work are preserved. Inspect the current git/workspace state first and continue only from the unfinished point. Do not repeat exploration, implementation, tests, or verification already completed. Ensure the required commit and completion report exist, then finish.\n</interrupted_session_resume>`;
  }
  if (!fix && !isBatch) {
    upsertPhase({ project: projectName, n: nextPhase, title: phaseMeta?.title || null, status: 'in-progress' });
    // When resuming an interrupted session preserve the model the prior attempt
    // actually used (stored in the phase row) so telemetry and /spend reflect
    // reality. A fresh start (no interrupted session) uses the resolved model.
    const modelForRecord = interruptedSessionId ? (priorPhaseState?.model_used || cfg.model) : cfg.model;
    markPhaseStarted({ project: projectName, n: nextPhase, model_used: modelForRecord, session_id: interruptedSessionId });
  }

  const ctxExtra = await loadProjectContextBlock(projDir);
  // Phase 18 (brief P2): delta block — a git diff since project-context.md's
  // last stamp, so it changes on every phase by construction. CE-3 /
  // cache-stable-system-prefix: moved OUT of devSystemPromptExtra (below) and
  // into the volatile user-prompt header instead — nothing to flag as stale
  // when there's no context block above it (ctxExtra null → deltaCtx null,
  // unconditionally).
  const deltaCtx = ctxExtra ? await loadContextDeltaBlock(workspaceDir, projDir) : null;
  // Phase 19: same ctxExtra gate, same "never touches devSystemPromptExtra"
  // rule as runGuide's freshnessCheck.
  const freshnessCheck = ctxExtra ? await loadContextFreshnessCheck(workspaceDir, projDir, projectName, cfg) : null;
  const briefCtx = await loadBriefConstraintsBlock(projDir, plan);
  // Phase 11: with the MCP state server wired (cfg.mcp.enabled), the full
  // decisions log is dropped in favor of a fixed pointer to the get_decisions
  // tool — the brief constraints block above is NOT MCP-gated; it stays
  // inline always (load-bearing, per the brief). decisionsCtx only changes
  // when a review appends to decisions.jsonl (roughly once per 3-phase
  // batch) — stable enough within a batch to stay in the cached system
  // prefix, unlike deltaCtx/lessonsCtx/mapCtx below.
  const decisionsCtx = cfg.mcp?.enabled ? MCP_DECISIONS_POINTER_BLOCK : await loadDecisionsBlock(projDir);
  // Phase 37 (CE-1): the deterministic phase ledger — appended by the
  // orchestrator once per completed phase (never per-phase-volatile the way
  // deltaCtx/lessonsCtx/mapCtx are; it only changes when a phase COMPLETES,
  // same cadence class as decisionsCtx) — so it joins decisionsCtx in the
  // cache-stable system prefix, immediately after it. cfg.ledger.enabled:false
  // is the escape hatch (mirrors every other feature's kill-switch pattern).
  const ledgerCtx = cfg.ledger?.enabled === false ? null : await loadPhaseLedgerBlock(projDir, cfg.ledger?.inject_last_k ?? 8);
  // lessonsCtx is re-ranked per phase (selectRelevantLessons scores against
  // THIS phase's files/keywords) — volatile by construction, same class as
  // deltaCtx/mapCtx. CE-3 / cache-stable-system-prefix: moved out of
  // devSystemPromptExtra into the volatile user-prompt header below.
  // Phase 41 (QL-8): fixes score against the fix pseudo-meta (files from the
  // round-plan entry) instead of null — otherwise selectRelevantLessons scores
  // every lesson 0 and injects nothing for the exact work most likely to repeat.
  // Phase 80 (brief 05 P3): the first few dev phases of a project also inherit
  // stack-matched cross-project global lessons (fixes never do — not a numbered
  // dev phase). Eligibility + stack tags are computed here; loadLessonsBlock
  // ranks/renders them at lowest priority. Ineligible → globalOpts null → the
  // block is byte-identical to pre-phase-80.
  let globalOpts = null;
  if (!fix && globalLessonsEligible({ scope: 'dev-phase', phaseN: nextPhase, cfg })) {
    const stackTags = await computeWorkspaceStackTags(workspaceDir).catch(() => []);
    globalOpts = { stackTags, now: new Date().toISOString() };
  }
  const lessonsCtx = await loadLessonsBlock(projDir, fix ? fixLessonMeta : (phaseMeta || null), cfg, globalOpts);
  // P1 cache-discipline rule: everything feeding devSystemPromptExtra must be
  // byte-identical across calls for unchanged inputs (see
  // phase-runner-cache-discipline.test.mjs). CE-3 / cache-stable-system-prefix
  // (merged): only brief/context/decisions/ledger stay here — all per-phase-
  // volatile blocks (deltaCtx, lessonsCtx, mapCtx) now ride in the user prompt
  // instead (see volatileDevCtx below), so a resumed dev session (validator
  // retry, acceptance-gate refine — both reuse this SAME variable, unchanged)
  // keeps an untouched system prefix regardless of what changed since the
  // initial call in this phase.
  const devSystemPromptExtra = [briefCtx, ctxExtra, decisionsCtx, ledgerCtx].filter(Boolean).join('\n\n') || null;
  // Volatile per-phase context, same relative order the old
  // devSystemPromptExtra used (deltaCtx right after where ctxExtra sat,
  // lessonsCtx next, mapCtx last — the most volatile signal, changes with
  // HEAD). Prepended to the report-header prompt below instead of the system
  // prefix.
  const volatileDevCtx = [compiledContextBlock, deltaCtx, lessonsCtx, mapCtx].filter(Boolean).join('\n\n');

  // Compute the exact report path (nested v2) and inject it into the dev prompt.
  // This is defense-in-depth — the system prompt also points to nested paths, but
  // the LLM occasionally constructs a wrong path from a template. Spelling it out
  // explicitly in the prompt removes ambiguity.
  // Phase 70 (brief 05 P5): a batch has NO single report path — every fix's own
  // report path is already spelled out inline by buildInlineFixBatchPrompt, so
  // the generic single-path header this block injects for phase/fix would be
  // both meaningless and wrong here. Skip it entirely for a batch call.
  const reportPath = isBatch
    ? null
    : fix
      ? await fixReportPath(projDir, fix.round, fix.n, fix.title)
      : await phaseReportPath(projDir, nextPhase, phaseMeta?.title);
  // Path relative to workspaceDir (the dev's CWD) so the agent gets an unambiguous
  // "../.guide/..." path. Relative-to-projDir was causing the agent to sometimes
  // resolve ".guide/" against the orchestrator git root instead of going up one level.
  const relReportPath = reportPath ? path.relative(workspaceDir, reportPath) : null;
  // `let` (phase-82): the test-first harness appends a "make the authored test
  // pass, don't edit it" instruction below, after the pre-dev seam commits the
  // red test. Byte-identical to the const form for every non-test-first run.
  let promptWithReportHeader = isBatch
    ? (volatileDevCtx ? `${volatileDevCtx}\n\n${phasePrompt}` : phasePrompt)
    : (volatileDevCtx ? `${volatileDevCtx}\n\n` : '') +
      `<!-- Orchestrator: write your completion report to EXACTLY this path (relative to your working directory): -->\n` +
      `**Report path:** \`${relReportPath}\`\n\n` +
      `<!-- Do NOT use legacy flat paths like .guide/phase-N-report.md — those are obsolete. -->\n\n` +
      phasePrompt;

  // Capture HEAD before the dev agent runs so we can detect a no-commit phase.
  // A lane run always has git (laneDir IS a worktree), so it computes preSha
  // regardless of project.git_branch. A batch call does too — its no-commit
  // guard below is the ONE safety net runDev offers a batch (everything past
  // it is the auto-runner orchestrator's job).
  let preSha = (laneMode || isBatch || gitProject.git_branch) ? await getHeadSha(workspaceDir) : null;

  // Phase 81 (brief 05 P4a — test-first harness, default OFF): the opt-in
  // test-first harness authors a FAILING test and commits it BEFORE the dev
  // spawn. That test commit advances HEAD, so preSha MUST be re-read afterward —
  // otherwise the no-commit guard (commit_sha === preSha, below) would compare
  // the dev's HEAD to the PRE-test HEAD and pass even when the dev committed
  // nothing, and changedFilesSince(preSha..HEAD) would wrongly attribute the
  // authored test file to the dev. The author spawn + red gate land in P4b;
  // P4b (phase-82) wires the full flow: runTestFirstPreDev authors a FAILING
  // acceptance test (roleless spawn, Write but no Bash), validates its manifest
  // through P1's reply contract, red-checks it, and — since the author has no
  // Bash — the ORCHESTRATOR commits the red test as 'phase-N-tests: <title>'.
  // On committed:true we re-read preSha (so the dev's no-commit guard measures
  // the DEV's work, not this scaffold) and hold onto `testFirstInfo` to wire
  // the authored test into the validator gate (extraRules/extraValidators), the
  // acceptance checker (covered criteria → met-by-test), and the tamper guard
  // (the dev must not edit the committed tests). isTestFirstActive is false
  // whenever test_first.enabled is off (the default) or the phase opts out via
  // plan.test_first === false, so the whole block is inert and the runDev path
  // is byte-identical for every existing run.
  let testFirstInfo = null;
  let reconciledCommitSha = null;
  if (!fix && !isBatch && !laneMode && priorPhaseState?.status === 'in-progress' && preSha != null) {
    const reportExists = await fileExists(reportPath);
    const hasValidationFailure = await fileExists(validationMarkerPath);
    const existingSha = await phaseCommitSha(workspaceDir, nextPhase);
    if (shouldReconcileInterruptedPhaseCommit({
      cfg, priorPhaseState, fix, isBatch, laneMode,
      headSha: preSha, phaseCommit: existingSha, reportExists, hasValidationFailure,
    })) {
      const parentSha = await getCommitParentSha(workspaceDir, existingSha);
      if (parentSha) {
        reconciledCommitSha = existingSha;
        preSha = parentSha;
        console.log(chalk.yellow(
          `↺ Phase ${nextPhase}: commit ${existingSha.slice(0, 8)} and completion report already exist from the interrupted run` +
          ' — skipping a duplicate dev call and re-running the normal validators/acceptance gate.',
        ));
      }
    }
  }

  if (!reconciledCommitSha) {
    if (preSha != null && isTestFirstActive({ cfg, phaseMeta, fix, isBatch })) {
      const preDevFn = deps.runTestFirstPreDev ?? runTestFirstPreDev;
      const tf = await preDevFn(
        { cfg, projectName, projDir, workspaceDir, phaseMeta: phaseMeta || null, preSha },
        { runClaude: runClaudeFn },
      );
      if (tf?.committed) { preSha = await getHeadSha(workspaceDir); testFirstInfo = tf; }
    }
  }
  // The dev must make the committed red test pass WITHOUT editing it (the
  // tamper guard enforces the "without editing" half after the dev commit).
  if (testFirstInfo?.committed) {
    promptWithReportHeader += `\n\n<test_first>\nThis phase runs test-first. A failing acceptance test has ALREADY been authored and committed at \`${testFirstInfo.testRel}\`. Your job: make that test pass by implementing the phase — and it is a HARD GATE (the orchestrator runs it after your commit).\n\nDo NOT edit, delete, weaken, or move \`${testFirstInfo.testRel}\` (or anything else under tests/acceptance/). It is immutable; changing it fails the phase automatically. If a test looks wrong, implement the behavior it demands rather than changing the test.\n</test_first>`;
  }

  // Snapshot whether the report file was already on disk before this spawn.
  // Used by the idempotency gate below to distinguish "claude wrote the report
  // during this run" from "report is a stale artifact from a prior run that
  // the operator did not clear before retrying." Never applies to a batch (no
  // single report path, and batch skips that idempotency shortcut entirely).
  const reportExistedBefore = (fix && !isBatch) ? await fileExists(reportPath) : false;

  const executionStartedAt = reconciledCommitSha ? null : new Date().toISOString();
  let result = reconciledCommitSha
    ? {
        type: 'result', subtype: 'success', is_error: false,
        result: `Reconciled interrupted phase commit ${reconciledCommitSha}`,
        session_id: interruptedSessionId,
      }
    : await runClaudeFn({
        cfg, cwd: workspaceDir, prompt: promptWithReportHeader,
        systemPromptFile: path.join(PROMPTS_DIR, 'dev-system.md'),
        systemPromptExtra: devSystemPromptExtra,
        sessionId: interruptedSessionId,
        role: 'dev', project: projectName, phase: nextPhase, projectDir: projDir,
        task: (fix || isBatch) ? 'fix-execution' : 'dev-execution',
        // v0.17 (OBS-2): `escalated` (computed above from the escalate-opus.marker)
        // is the only attempt/escalation signal known at this call site — a
        // failure-driven re-run is attempt 2 (escalateRetryDone in auto-runner.js
        // allows exactly one such retry per phase/fix per run); everything else
        // is attempt 1.
        routing: { tier: routing.tier, reasoning: routing.reasoning, attempt: escalated ? 2 : 1, escalated },
      });

  if (result.session_id) {
    await recordDevSession(projDir, result.session_id);
    // Backfill only session_id — do NOT call markPhaseStarted again as that
    // would reset started_at to post-subprocess time, hiding queue-wait latency.
    if (!fix && !isBatch) {
      backfillPhaseSessionId({ project: projectName, n: nextPhase, session_id: result.session_id });
    }
  }

  // v0.18 turn-budget continuation: a max_turns exhaustion resumes the SAME
  // session with a small targeted budget before the phase is allowed to fail
  // into fresh-session escalation (see runTurnContinuationLoop above). Any
  // continuation outcome flows through the unchanged downstream pipeline —
  // no-commit guard, validator gate, acceptance check — exactly as if the
  // initial call had produced it.
  if (result.is_error && result.subtype === 'error_max_turns') {
    result = await runTurnContinuationLoop({
      cfg, projectName, projDir, workspaceDir, nextPhase, fix, isBatch,
      devSystemPromptExtra, initialResult: result, routing, escalated,
      taskMeta: isBatch ? batchCompilerMeta : fix ? (fixEntry || fixLessonMeta) : phaseMeta,
      relReportPath,
    }, { runClaude: runClaudeFn });
  }

  // Close the plan-size learning loop with the turns consumed by the initial
  // dev call plus any same-session continuation/fresh compact recovery. Call
  // rows are already durable, so state derives the total from this attempt's
  // start timestamp; telemetry failure must never fail development.
  if (executionStartedAt) {
    try {
      const rawMeta = isBatch ? (batchCompilerMeta || {}) : fix ? (fixEntry || fixLessonMeta || {}) : (phaseMeta || {});
      const predictionMeta = fix && !rawMeta.files_expected && Array.isArray(rawMeta.files)
        ? { ...rawMeta, files_expected: rawMeta.files }
        : rawMeta;
      const features = extractPhaseSizeFeatures(predictionMeta);
      const errorText = String(result?.error_message || result?.result || '');
      recordPhaseExecutionFeature({
        project: projectName,
        phase: Number.isInteger(nextPhase) ? nextPhase : null,
        task_kind: (fix || isBatch) ? 'fix-execution' : 'dev-execution',
        execution_started_at: executionStartedAt,
        ...features,
        max_turn_error: result?.subtype === 'error_max_turns',
        provider_error: isProviderRateLimitError(errorText),
        success: !result?.is_error,
      });
    } catch (telemetryErr) {
      console.warn(chalk.yellow(`[phase-size] could not persist execution sample (non-fatal): ${telemetryErr.message}`));
    }
  }

  // Post-success git work: capture SHA, push to remote. Push failure is a
  // warning, not a phase failure — caller and notifier surface it. We attach
  // git_result to the return so the auto-runner / job-runner can broadcast.
  let git_result = null;
  if (!result.is_error) {
    const expectedBranch2 = gitProject.git_branch;
    // A lane run always enters the git block (laneDir IS a worktree) regardless
    // of project.git_branch; the lane's own branch is authoritative. A batch
    // call does too — its commits are always local git operations regardless
    // of whether a push target is configured (push, if any, is the auto-runner
    // orchestrator's job, not this call's).
    if (expectedBranch2 || laneMode || isBatch) {
      let commit_sha = await getHeadSha(workspaceDir);
      const branch = await getCurrentBranch(workspaceDir);

      // Guard: if HEAD didn't advance, the agent ran but never committed.
      // Treat this as a phase/fix failure so it can be retried rather than
      // silently recorded as complete with a stale SHA.
      if (commit_sha === preSha) {
        const label = fix ? `Fix r${fix.round}-${fix.n}` : isBatch ? `Fix batch round ${batchFixes[0].round} [${batchFixes.map((f) => f.n).join(', ')}]` : `Phase ${nextPhase}`;

        // Idempotency check for fixes: a previous run may have applied the fix,
        // written the report, and committed — but crashed before recordFixCompletion
        // fired. If the report exists and the workspace is clean (nothing uncommitted),
        // the fix is genuinely done. Mark it complete rather than looping forever.
        // Skipped in lane mode: a lane is a fresh worktree (no prior report/commit
        // to reconcile), and the orchestrator-side merge (P3) owns finalization.
        if (fix && !laneMode) {
          const reportFile = await fixReportPath(projDir, fix.round, fix.n);
          const reportExists = await fileExists(reportFile);
          if (!reportExistedBefore && reportExists) {
            // When the report file exists from a prior run AND the workspace was hand-reset
            // to preSha, claude sees the report and exits without applying changes. That looks
            // idempotent but the work is gone. Refuse to mark complete; route to the no-commit
            // failure path so the operator notices and either restores from reflog or deletes
            // the stale report.
            // v0.14.38: same refusal when the prior commit FAILED the validator
            // gate — "already applied" is not "applied correctly".
            const wsStatus = await workspaceStatus(workspaceDir);
            if (wsStatus.clean && !(await fileExists(validationMarkerPath))) {
              console.log(chalk.yellow(
                `⚠ ${label}: no new commit, but report exists and workspace is clean` +
                ` — fix was already applied in a prior run. Recording as complete.`,
              ));
              return { ...result, routing, git_result: { ok: true, branch, commit_sha } };
            }
          }
        }

        // Phase idempotency: a previous run may have committed the phase work
        // but crashed before the DB was updated. If a "phase-N:" commit already
        // exists in git, use it — the dev agent correctly identified the work
        // was done and produced no new commit. Skipped in lane mode (a fresh lane
        // worktree has no prior phase commit to reconcile, and it must NOT
        // markPhaseCompleted/setCurrentPhase — that is P3's merge step).
        if (!fix && !laneMode && !isBatch) {
          const existingSha = await phaseCommitSha(workspaceDir, nextPhase);
          // v0.14.38: a commit that FAILED the validator gate must not be
          // resurrected as "complete" by this shortcut — the marker blocks it
          // and the phase re-runs (with the failure excerpt in its prompt).
          if (existingSha && await fileExists(validationMarkerPath)) {
            console.log(chalk.yellow(`↺ Phase ${nextPhase} commit ${existingSha.slice(0, 8)} exists but FAILED validators previously — not reconciling; re-running.`));
          } else if (existingSha) {
            console.log(chalk.yellow(
              `↺ Reconciled: phase ${nextPhase} commit ${existingSha.slice(0, 8)} already in git` +
              ` — recording complete (was not recorded by its run).`,
            ));
            markPhaseCompletedFn({ project: projectName, n: nextPhase, commit_sha: existingSha });
            setCurrentPhaseFn(projectName, nextPhase);
            const hintFile = path.join(projDir, '.guide', `phase-${nextPhase}-reprompt.hint`);
            fs.unlink(hintFile).catch(() => {});
            fs.unlink(escalateMarkerPath).catch(() => {});
            fs.unlink(legacyEscalateMarkerPath).catch(() => {});
            return { ...result, is_error: false, routing, git_result: { ok: true, branch: await getCurrentBranch(workspaceDir), commit_sha: existingSha } };
          }
        }

        console.error(chalk.red(`✗ ${label} produced no git commit (HEAD still ${commit_sha?.slice(0, 8)}). Marking failed.`));
        // Only phases have rows in the phases table. Fixes (and a batch, which
        // has no single fix identity either) don't — calling upsertPhase with
        // n=null violates the NOT NULL constraint.
        if (!fix && !isBatch) {
          upsertPhase({ project: projectName, n: nextPhase, status: 'failed' });
        }
        return {
          ...result,
          is_error: true,
          error_message: `${label} completed without committing any changes. The agent ran but HEAD did not advance (still at ${commit_sha?.slice(0, 8)}). Retry the fix.`,
          routing,
          git_result: { ok: false, branch, commit_sha, error: 'no-commit' },
        };
      }

      // Phase 70 (brief 05 P5): a single-call batch stops HERE — after the dev
      // spawn and the no-commit guard (the one safety net a batch gets from
      // runDev itself), but BEFORE the validator gate / acceptance-check /
      // push / completion bookkeeping below, all of which assume ONE fix's
      // identity (a single report path, a single escalation/validation
      // marker, a single push). The auto-runner's runFixSingleCallBatch owns
      // the ONE merged-HEAD validator gate (scoped to the whole batch's diff,
      // same runValidatorGate entrypoint as the block below), reconciliation
      // via fixCommitExists, recordFixCompletion per fix, and the single push
      // — mirroring how laneMode stops before ITS OWN completion bookkeeping,
      // just earlier (a batch's gate must run exactly once at the
      // orchestrator level, not once per spawn — there IS only one spawn, but
      // the gate belongs to the orchestrator so a rolled-back batch never
      // leaves a stray validation-failed marker or lesson behind).
      if (isBatch) {
        // Batch finalization lives in auto-runner, but the compiler prediction
        // was made for this exact dev call. Capture its committed edit surface
        // here before returning so batch work does not create an unexplained
        // hole in rollout outcome coverage.
        const batchChanged = preSha ? await changedFilesSince(workspaceDir, preSha) : { ok: false };
        if (batchChanged.ok && cfg._context_compiler?.manifest_id) {
          try { recordContextOutcomeFn({ manifest_id: cfg._context_compiler.manifest_id, actual_files: batchChanged.files }); } catch { /* telemetry never gates */ }
        }
        const batchTestPlan = resolveContextTestPlan({
          cfg, manifest: contextManifest, phaseOrdinal: batchFixes?.at(-1)?.n || null, fix: true,
          complexity: routing.complexity, checkpoint: null,
          enforceDegraded: compiledContextUse.degraded || compiledContextUse.force_full_verification,
          changedFiles: batchChanged.ok ? batchChanged.files : [], changedFilesKnown: batchChanged.ok,
        });
        return {
          ...result,
          is_error: false,
          batch: true,
          routing,
          commit_sha,
          branch,
          git_result: { ok: true, branch, commit_sha, batch: true },
          _context_freshness: freshnessCheck,
          context_test_plan: batchTestPlan,
        };
      }

      // ── v0.14.35 validator hard gate ──────────────────────────────────────
      // Runs AFTER the agent committed, BEFORE the phase/fix is marked
      // complete and pushed — a failing phase never reaches review and never
      // lands on origin. Configured validators.json chains run first; projects
      // without one fall back to the built-in default (npm test if a real test
      // script exists, else node --check on the changed JS files — never
      // blocks a project for lacking tests). On failure: ONE mechanical retry
      // that resumes the dev session with the validator output injected, then
      // re-gate. Still failing → phase marked failed, commit stays local
      // (origin clean; /retry can delete it), operator sees the summary.
      // `gate` is declared at runDev-body scope (NOT block-local) because the
      // acceptance-check step further down reads `validatorOutcome: gate`
      // outside this block. A block-scoped `let gate` here threw
      // `ReferenceError: gate is not defined` on every non-deferred phase.
      let gate;
      {
        const gateLabel = fix ? `Fix r${fix.round}-${fix.n}` : `Phase ${nextPhase}`;
        const gateEvent = fix
          ? { fixRound: fix.round, fixN: fix.n, fixTitle: fix.title || '' }
          : { phase: nextPhase, phaseTitle: phaseMeta?.title || '' };
        const changed = preSha ? await changedFilesSince(workspaceDir, preSha) : { ok: false };
        if (changed.ok && cfg._context_compiler?.manifest_id) {
          try { recordContextOutcomeFn({ manifest_id: cfg._context_compiler.manifest_id, actual_files: changed.files }); } catch { /* telemetry never gates */ }
        }
        // Phase 82 (test-first P4b): when the harness authored + committed a red
        // acceptance test, inject it as a synthetic validator (in-code, never
        // written to validators.json) so the dev is gated on making it pass —
        // exactly like a configured validator. Empty for every non-test-first run.
        const tfGate = testFirstInfo?.committed
          ? { extraRules: testFirstInfo.extraRules, extraValidators: testFirstInfo.extraValidators }
          : { extraRules: [], extraValidators: {} };
        let contextTestPlan = resolveContextTestPlan({
          cfg, manifest: contextManifest, phaseOrdinal: fix ? fix.n : phaseOrdinal, isFinalPhase, fix: !!fix,
          complexity: routing.complexity, checkpoint: phaseMeta?.checkpoint,
          enforceDegraded: compiledContextUse.degraded || compiledContextUse.force_full_verification,
          changedFiles: changed.ok ? changed.files : [],
          changedFilesKnown: changed.ok,
        });
        gate = await runValidatorGate({
          projectName, workspaceDir, event: gateEvent,
          changedFiles: changed.ok ? changed.files : [], cfg,
          extraRules: tfGate.extraRules, extraValidators: tfGate.extraValidators,
          testPlan: contextTestPlan,
        });

        if (gate.hasFailures) {
          const excerpt = gateFailureExcerpt(gate);
          console.warn(chalk.yellow(`⚠ ${gateLabel}: validators failed post-commit — one mechanical retry with the failure output injected`));
          const retryPrompt = `Your last commit for ${gateLabel.toLowerCase()} FAILED the post-commit validators. Output:

\`\`\`
${excerpt}
\`\`\`

Fix EXACTLY what this output indicates — nothing else. No refactors, no scope creep. When fixed, make one commit (same message format as before, suffixed "(validator fix)").`;
          const retrySessionId = result.session_id || null;
          // A resumed session still exposes the compiled block through its
          // conversation history, so attribute the manifest tokens to this
          // call as replay exposure. Only the defensive no-session fallback
          // starts fresh without the block and therefore records zero.
          const retryCfg = contextCompilerFollowupCfg(cfg, { sessionId: retrySessionId });
          const retryRes = await runClaudeFn({
            cfg: retryCfg, cwd: workspaceDir, prompt: retryPrompt,
            systemPromptFile: path.join(PROMPTS_DIR, 'dev-system.md'),
            systemPromptExtra: devSystemPromptExtra,
            sessionId: retrySessionId,
            role: 'dev', project: projectName, phase: nextPhase, projectDir: projDir,
            task: fix ? 'fix-execution' : 'dev-execution',
            // v0.17 (OBS-2): same tier/escalation state as the initial call —
            // this is the ONE mechanical validator-fix retry, resumed on the
            // same session/model, not a tier escalation of its own.
            routing: { tier: routing.tier, reasoning: [...routing.reasoning, 'mechanical validator-fix retry (post-commit gate failed)'], attempt: escalated ? 2 : 1, escalated },
          });
          if (retryRes.session_id) await recordDevSession(projDir, retryRes.session_id);

          if (!retryRes.is_error) {
            const changed2 = preSha ? await changedFilesSince(workspaceDir, preSha) : { ok: false };
            if (changed2.ok && cfg._context_compiler?.manifest_id) {
              try { recordContextOutcomeFn({ manifest_id: cfg._context_compiler.manifest_id, actual_files: changed2.files }); } catch { /* telemetry never gates */ }
            }
            // The retry may touch a new production or test file. Re-resolve the
            // scope from the final diff so an initially-safe targeted plan
            // cannot omit that file or bypass the full-suite fallback.
            contextTestPlan = resolveContextTestPlan({
              cfg, manifest: contextManifest, phaseOrdinal: fix ? fix.n : phaseOrdinal, isFinalPhase, fix: !!fix,
              complexity: routing.complexity, checkpoint: phaseMeta?.checkpoint,
              enforceDegraded: compiledContextUse.degraded || compiledContextUse.force_full_verification,
              changedFiles: changed2.ok ? changed2.files : [],
              changedFilesKnown: changed2.ok,
            });
            gate = await runValidatorGate({
              projectName, workspaceDir, event: gateEvent,
              changedFiles: changed2.ok ? changed2.files : (changed.ok ? changed.files : []), cfg,
              extraRules: tfGate.extraRules, extraValidators: tfGate.extraValidators,
              testPlan: contextTestPlan,
            });
          }

          if (retryRes.is_error || gate.hasFailures) {
            const failedNames = (gate.results || []).filter((r) => !r.pass).map((r) => r.validator_name);
            const summary = failedNames.length ? `validators failed: ${failedNames.join(', ')}` : 'validator retry errored';
            // v0.14.38: persist the failure excerpt — blocks commit-reconcile
            // and rides into the next attempt's prompt as forward-fix context.
            await fs.writeFile(validationMarkerPath, gateFailureExcerpt(gate) || summary, 'utf-8').catch?.(() => {});
            recordLesson(projDir, { kind: 'validator-fail', phase: fix ? null : nextPhase, fix: fix ? `r${fix.round}-${fix.n}` : null, source: 'phase-runner:validator-gate', lesson: gateFailureExcerpt(gate) || summary, files: phaseMeta?.files_expected || [] }, cfg);
            console.error(chalk.red(`✗ ${gateLabel}: ${summary} — NOT marking complete, NOT pushing (commit stays local).`));
            if (!fix) {
              upsertPhase({ project: projectName, n: nextPhase, status: 'failed' });
            }
            return {
              ...result,
              is_error: true,
              error_message: `${gateLabel} committed but failed the validator gate` +
                (retryRes.is_error ? ' (mechanical retry errored)' : ' (after 1 mechanical retry)') +
                `: ${summary}\n\n${excerpt.slice(0, 1500)}`,
              routing,
              validator_outcome: gate,
              git_result: { ok: false, branch, commit_sha: await getHeadSha(workspaceDir), error: 'validation-failed' },
            };
          }
          console.log(chalk.green(`✓ ${gateLabel}: validators pass after mechanical retry`));
        }

        result.validator_outcome = gate;
        // v0.14.38 → phase-23: gate passed — clear the failure markers for this
        // phase/fix (this is the cleanup point that covers fixes, which don't
        // hit the phase-completion unlinks below). Clear both marker names so a
        // legacy `*-escalate-opus.marker` can't re-escalate a passing re-run.
        // Phase 67 (P2): a lane run SKIPS marker cleanup — the markers live in
        // the shared projDir/.guide, and the orchestrator-side merge (P3) owns
        // finalization (including whether the phase's failure markers clear).
        if (!laneMode) {
          fs.unlink(validationMarkerPath).catch(() => {});
          fs.unlink(escalateMarkerPath).catch(() => {});
          fs.unlink(legacyEscalateMarkerPath).catch(() => {});
        }
        // The retry may have advanced HEAD — record the SHA that actually passed.
        commit_sha = await getHeadSha(workspaceDir);
      }

      // Phase 51 (P1 async report-mode): the deferral decision. `!fix` is
      // load-bearing — fixes never defer, they keep today's inline behavior
      // regardless of deferVerify/async_report (see runDev's own header
      // comment). hasCriteriaForDefer mirrors runPhaseAcceptanceCheck's own
      // phase-side hasCriteria computation so the deferral decision and the
      // inline decision it substitutes for can never disagree about whether
      // this phase would have run the checker at all.
      const hasCriteriaForDefer = !fix && Array.isArray(phaseMeta?.acceptance_criteria) && phaseMeta.acceptance_criteria.length > 0;
      const deferCheckDecision = !fix
        ? shouldRunAcceptanceCheck({
            verifyCfg: cfg.verify || {}, fix: null, hasCriteria: hasCriteriaForDefer, severity: null,
            phaseOrdinal, isFinalPhase, complexity: routing.complexity, checkpoint: phaseMeta?.checkpoint,
          })
        : { run: false };
      // Phase 67 (P2): a lane run NEVER defers — the acceptance check runs
      // in-lane (against laneDir) so the lane's own gate result is known before
      // the orchestrator-side merge (P3) fast-forwards it in.
      const willDeferVerify = !laneMode && shouldDeferAcceptanceCheck({ verifyCfg: cfg.verify, fix, deferVerify, checkDecision: deferCheckDecision });

      if (willDeferVerify) {
        // NO spawn here — the checker runs later, out-of-band, against a
        // worktree pinned to commit_sha (verify-loop.js's
        // runDetachedAcceptanceCheck, invoked by auto-runner.js after this
        // call returns). phaseN/phaseMeta/preSha/commitSha are exactly what
        // that call needs to reconstruct the SAME checker invocation
        // runPhaseAcceptanceCheck would have made inline.
        result.deferred_verify = { phaseN: nextPhase, phaseMeta: phaseMeta || null, preSha, commitSha: commit_sha };
      } else if (modelOverride) {
        // Phase 72: a duo leg (modelOverride set — always a lane) skips the
        // in-lane acceptance check entirely. The duo judge (auto-runner's
        // runSpeculativeDuo) runs its OWN runAcceptanceCheck against this lane's
        // committed HEAD once the leg returns — running it here too would be a
        // redundant checker call against the same tree, AND a gate-mode fail
        // here would return is_error and turn a legitimately-committed leg into
        // a "lost" one, stealing the judge's pass/fail decision. Mirrors how
        // laneMode defers COMPLETION to the merge step: a duo leg additionally
        // defers its VERDICT to the judge. No-op branch — falls through with no
        // verify_outcome (the lane return records verify_outcome: null).
      } else {
      // ── Acceptance-check hook (brief P2 part 3/3 report mode; P3 gate mode) ─
      // Runs after the validator gate passes, before markPhaseCompleted/pushBranch
      // — same guarantee as the gate: a failing verdict must never reach origin
      // when verify.mode is "gate". Report mode just records the verdict below.
      const verifyOutcome = await runPhaseAcceptanceCheck({
        cfg, projectName, projDir, workspaceDir, phaseMeta: phaseMeta || null, fix, preSha, commitSha: commit_sha, nextPhase,
        complexity: routing.complexity, phaseOrdinal, isFinalPhase, validatorOutcome: gate,
        // Phase 82 (test-first P4b): covered criteria → met-by-test in the
        // checker prompt; postTestsSha → the dev-commit tamper guard. Null for
        // every non-test-first run.
        testFirst: testFirstInfo?.committed ? { covered: testFirstInfo.covered, postTestsSha: testFirstInfo.postTestsSha } : null,
      }, deps);
      if (verifyOutcome) result.verify_outcome = verifyOutcome;

      // A provider usage window ending is neither a pass nor an inconclusive
      // checker verdict. Preserve the local commit and return an error carrying
      // the provider's reset text; auto-runner pauses and schedules an exact
      // resume instead of fail-opening, refining, or escalating models.
      if (verifyOutcome?.status === 'usage-limit') {
        const reason = (verifyOutcome.errors || []).join('; ') || 'provider usage limit reached';
        return {
          ...result,
          is_error: true,
          error_message: reason,
          result: reason,
          routing,
          verify_outcome: verifyOutcome,
          git_result: { ok: false, branch, commit_sha, error: 'provider-usage-limit' },
        };
      }
      maybeRecordReportModeVerifyFailLesson({ cfg, projDir, phaseMeta: phaseMeta || null, fix, nextPhase, verifyOutcome });

      // ── phase-26: honor verify.fail_open on an inconclusive checker outcome ─
      // Independent of verify.mode (report/gate) — fail_open is about the
      // CHECKER's OWN reliability (spawn error, or a still-unparseable verdict
      // even after the re-ask AND the opus fallback in verify-loop.js), not
      // the refine/escalate ladder below (shouldRunGateRefine only ever acts
      // on status:'fail', so 'inconclusive' already skips it structurally).
      if (shouldFailClosedOnInconclusive({ verifyCfg: cfg.verify, outcomeStatus: verifyOutcome?.status })) {
        const acceptLabel = fix ? `Fix r${fix.round}-${fix.n}` : `Phase ${nextPhase}`;
        const reason = (verifyOutcome.errors || []).join('; ') || 'no verdict produced';
        console.error(chalk.red(`✗ ${acceptLabel}: acceptance check inconclusive and verify.fail_open=false — NOT marking complete, NOT pushing (commit stays local).`));
        if (!fix) {
          upsertPhase({ project: projectName, n: nextPhase, status: 'failed' });
        }
        return {
          ...result,
          is_error: true,
          error_message: `${acceptLabel} committed but failed acceptance verification (inconclusive, fail_closed): ${reason}`,
          routing,
          verify_outcome: verifyOutcome,
          git_result: { ok: false, branch, commit_sha, error: 'acceptance-verification-inconclusive' },
        };
      }
      maybeRecordInconclusiveLesson({ cfg, projDir, phaseMeta: phaseMeta || null, fix, nextPhase, verifyOutcome });

      // ── v0.15.0 gate-mode refine → re-check → escalate (brief P3) ──────────
      // Only activates when verify.mode === 'gate' AND the checker already
      // resolved an effective fail (mode isolation — report mode never reaches
      // this block; a passing/inconclusive outcome never reaches it either).
      // Budget-exhausted failure reuses the SAME validationMarkerPath the
      // validator gate uses (append, don't replace) so the next attempt's
      // forward-fix context (_buildValidationFailureBlock, above) and the
      // commit-reconcile refusal (below, and in the fix-idempotency check)
      // cover this failure mode for free. The returned is_error result then
      // flows into routeDevFailure() (auto-runner.js) exactly like any other
      // non-transient dev failure — zero changes to its routing logic.
      if (shouldRunGateRefine({ verifyCfg: cfg.verify, outcomeStatus: verifyOutcome?.status })) {
        const acceptLabel = fix ? `Fix r${fix.round}-${fix.n}` : `Phase ${nextPhase}`;
        const acceptGateEvent = fix
          ? { fixRound: fix.round, fixN: fix.n, fixTitle: fix.title || '' }
          : { phase: nextPhase, phaseTitle: phaseMeta?.title || '' };

        const gateLoop = await runAcceptanceGateLoop({
          cfg, projectName, projDir, workspaceDir, phaseMeta: phaseMeta || null, fix,
          preSha, commitSha: commit_sha, nextPhase, sessionId: result.session_id || null,
          gateEvent: acceptGateEvent, gateLabel: acceptLabel, devSystemPromptExtra,
          initialOutcome: verifyOutcome, complexity: routing.complexity,
        }, deps);
        result.verify_outcome = gateLoop.outcome;
        commit_sha = gateLoop.commitSha || commit_sha;

        if (gateLoop.failed) {
          const failMustFix = gateLoop.outcome?.verdict?.must_fix?.length
            ? gateLoop.outcome.verdict.must_fix
            : decideVerdict(gateLoop.outcome?.verdict || {}).unmet.map((c) => c.criterion);
          const bullets = (failMustFix.length ? failMustFix : ['(see verify.json for details)']).map((m) => `- ${m}`).join('\n');
          await fs.appendFile(validationMarkerPath, `\n\n## Acceptance verification failed\n${bullets}\n`, 'utf-8').catch(() => {});
          recordLesson(projDir, { kind: 'verify-fail', phase: fix ? null : nextPhase, fix: fix ? `r${fix.round}-${fix.n}` : null, source: 'phase-runner:acceptance-gate', lesson: bullets, files: phaseMeta?.files_expected || fixLessonMeta?.files_expected || [] }, cfg);
          console.error(chalk.red(`✗ ${acceptLabel}: committed but FAILED acceptance verification after ${gateLoop.attempts} refine attempt(s) — NOT marking complete, NOT pushing (commit stays local).`));
          if (!fix) {
            upsertPhase({ project: projectName, n: nextPhase, status: 'failed' });
          }
          return {
            ...result,
            is_error: true,
            error_message: `${acceptLabel} committed but failed acceptance verification (after ${gateLoop.attempts} refine attempt(s)): ${(failMustFix.length ? failMustFix : ['see verify.json for details']).slice(0, 3).join('; ')}`,
            routing,
            verify_outcome: gateLoop.outcome,
            git_result: { ok: false, branch, commit_sha, error: 'acceptance-verification-failed' },
          };
        }
        if (gateLoop.usageLimited) {
          // Mirror the initial-check chokepoint at the top of this branch: the
          // provider window closing mid-gate-loop is a pause, never a pass.
          const reason = (gateLoop.outcome?.errors || []).join('; ') || 'provider usage limit reached';
          console.warn(chalk.yellow(
            `⏸ ${acceptLabel}: acceptance recheck hit the provider usage limit — pausing; commit stays local, phase NOT marked complete.`,
          ));
          return {
            ...result,
            is_error: true,
            error_message: reason,
            result: reason,
            routing,
            verify_outcome: gateLoop.outcome,
            git_result: { ok: false, branch, commit_sha, error: 'provider-usage-limit' },
          };
        }
        if (gateLoop.inconclusive) {
          const reason = (gateLoop.outcome?.errors || []).join('; ') || 'no valid verdict';
          console.warn(chalk.yellow(
            `⚠ ${acceptLabel}: acceptance recheck remained inconclusive after ${gateLoop.attempts} refine attempt(s); ` +
            `verify.fail_open=true allows the queue to continue, but this is NOT a verified pass (${reason}).`,
          ));
          await maybeRecordInconclusiveLesson({
            cfg, projDir, phaseMeta: phaseMeta || fixLessonMeta || null, fix, nextPhase,
            verifyOutcome: gateLoop.outcome,
          });
        } else {
          console.log(chalk.green(`✓ ${acceptLabel}: acceptance verify passed after ${gateLoop.attempts} refine attempt(s)`));
        }
        // Phase 41 (CE-9): a gate that PASSED only after >=1 refine is a durable
        // pattern too — record it (kind 'verify-refined') with the INITIALLY-unmet
        // criteria + the phase/fix files, so a future phase touching those files
        // inherits the pattern that a refine had to fix, not just terminal
        // failures. A clean first-pass gate never enters this block, so it records
        // nothing new. Best-effort (recordLesson never throws).
        if (gateLoop.verified) {
          await maybeRecordGateRefinedLesson({
            cfg, projDir, phaseMeta: phaseMeta || null, fixLessonMeta, fix, nextPhase,
            initialOutcome: verifyOutcome, gateLoop,
          });
        }
      }
      }

      // Phase 67 (brief 05 P2): a lane run stops HERE — after the dev spawn,
      // no-commit guard, validator gate, and acceptance check, but BEFORE any
      // completion bookkeeping. It does NOT markPhaseCompleted/setCurrentPhase,
      // does NOT pushBranch (the lane branch is local-only), and does NOT clear
      // failure markers. The orchestrator-side merge (P3) fast-forwards the lane
      // branch into the primary workspace and finalizes; return exactly what
      // that merge needs.
      if (laneMode) {
        return {
          ...result,
          is_error: false,
          lane: true,
          routing,
          commit_sha,
          branch,
          validator_outcome: result.validator_outcome || null,
          verify_outcome: result.verify_outcome || null,
          git_result: { ok: true, branch, commit_sha, lane: true },
          _context_freshness: freshnessCheck,
        };
      }

      if (!fix) {
        // Phase 68 (brief 05 P3): completion bookkeeping (markPhaseCompleted +
        // setCurrentPhase + reprompt-hint/escalation-marker cleanup) is the
        // ONE shared completeMergedPhase the parallel-wave merge step also
        // calls — extracted so serial and parallel paths can never drift.
        // Threads runDev's own seams through so a test that stubs
        // deps.markPhaseCompleted still intercepts the serial completion.
        completeMergedPhase(
          { projectName, n: nextPhase, commit_sha, projDir },
          { markPhaseCompleted: markPhaseCompletedFn, setCurrentPhase: setCurrentPhaseFn },
        );
        // Phase 37 (CE-1): append one deterministic ledger entry for this
        // completed phase — the idempotent commit-reconcile shortcut above
        // (existingSha path) and the fix path never reach here, which is
        // correct (only a genuinely-just-completed phase gets an entry).
        // Kept inline (NOT in completeMergedPhase) because it needs the
        // report/workspace context; best-effort: any failure (missing report,
        // invalid entry, haiku fallback spawn error) warns and skips — it must
        // never fail a phase that has already committed, gated, and pushed.
        await recordPhaseLedgerEntry({
          projDir, workspaceDir, projectName, n: nextPhase, title: phaseMeta?.title || null,
          commitSha: commit_sha, reportPath, cfg, nextPhase,
        }).catch((err) => {
          console.warn(chalk.yellow(`[phase-ledger] could not append entry for phase ${nextPhase}: ${err.message}`));
        });
      }

      const push = await pushBranchFn(workspaceDir, { branch });
      if (push.ok) {
        console.log(chalk.green(`✓ Pushed ${branch} → origin (${commit_sha ? commit_sha.slice(0, 8) : '?'})`));
        git_result = { ok: true, branch, commit_sha };
      } else {
        console.warn(chalk.yellow(`⚠ Push failed (${branch}): ${push.error}`));
        console.warn(chalk.yellow(`  Local commit ${commit_sha?.slice(0, 8)} landed but is not on origin.`));
        console.warn(chalk.yellow(`  Run manually: cd ${workspaceDir} && git push origin ${branch}`));
        git_result = { ok: false, branch, commit_sha, error: push.error };
      }
    } else if (!fix && !isBatch) {
      // git_branch not set → legacy / opted-out; preserve old behavior.
      // (Unreachable in lane mode / batch mode — both always enter the git block above.)
      markPhaseCompletedFn({ project: projectName, n: nextPhase });
      setCurrentPhaseFn(projectName, nextPhase);
      // Phase 37 (CE-1): same best-effort ledger append as the git-managed
      // path above — commitSha is unknown here (no git tracking), so the
      // entry records '(unknown)' for it (recordPhaseLedgerEntry's fallback).
      await recordPhaseLedgerEntry({
        projDir, workspaceDir, projectName, n: nextPhase, title: phaseMeta?.title || null,
        commitSha: null, reportPath, cfg, nextPhase,
      }).catch((err) => {
        console.warn(chalk.yellow(`[phase-ledger] could not append entry for phase ${nextPhase}: ${err.message}`));
      });
    }
  }
  return { ...result, routing, git_result, _context_freshness: freshnessCheck };
}

// ─── QL-7: dev self-assessment contract ─────────────────────────────────────
//
// Parses the "Acceptance criteria self-assessment" markdown table the dev's
// completion report is now required to include (see prompts/dev-system.md's
// work protocol + phase-report-template.md), so runPhaseAcceptanceCheck can
// hand the checker a shortlist of criteria the implementer itself flagged as
// shaky. Tolerant by design (brief FR — fail-open, not fail-closed):
// unparseable/missing table → empty array, never a thrown error, so a dev
// agent that forgets the table (or an old report predating this feature)
// costs nothing beyond the checker doing its normal blind traversal.

// Matches one markdown table row: | criterion | status | evidence | confidence |
// Tolerant of extra/missing whitespace and of the header/separator rows,
// which are filtered out afterward (separator cells are all dashes/colons;
// the header row's own cells match literal column names case-insensitively).
const SELF_ASSESSMENT_ROW_RE = /^\s*\|(.+)\|\s*$/;
const SEPARATOR_CELL_RE = /^:?-+:?$/;
const HEADER_CELL_RE = /^(criterion|status|evidence(\s*\(file:line\))?|confidence)$/i;

/**
 * Parse the dev report's "Acceptance criteria self-assessment" table into
 * rows. Pure function of its input string — no I/O, no throw.
 *
 * @param {string} reportText - the full completion-report markdown
 * @returns {Array<{criterion: string, status: string, evidence: string, confidence: string}>}
 *   Empty array when the section/table is absent or unparseable.
 */
export function parseCriteriaSelfAssessment(reportText) {
  if (!reportText || typeof reportText !== 'string') return [];

  // Scope the search to the section itself (case-insensitive heading match)
  // so a criterion/status/evidence/confidence-shaped table ELSEWHERE in the
  // report (unlikely, but not this function's problem to guess about) is
  // never picked up by accident.
  const headingMatch = reportText.match(/^#+\s*acceptance criteria self-assessment\s*$/im);
  if (!headingMatch) return [];
  const sectionStart = headingMatch.index + headingMatch[0].length;
  const rest = reportText.slice(sectionStart);
  // Stop at the next heading (## or #), so a table isn't accidentally read
  // past the end of its own section.
  const nextHeadingMatch = rest.match(/^#+\s+\S/m);
  const section = nextHeadingMatch ? rest.slice(0, nextHeadingMatch.index) : rest;

  const rows = [];
  for (const line of section.split('\n')) {
    const m = line.match(SELF_ASSESSMENT_ROW_RE);
    if (!m) continue;
    const cells = m[1].split('|').map((c) => c.trim());
    if (cells.length < 4) continue;
    const [criterion, status, evidence, confidence] = cells;
    if (!criterion) continue;
    // Skip the header row and the markdown separator row (---|---|---|---).
    if (HEADER_CELL_RE.test(criterion)) continue;
    if (SEPARATOR_CELL_RE.test(criterion)) continue;
    rows.push({
      criterion,
      status: status ? status.toLowerCase() : '',
      evidence: evidence || '',
      confidence: confidence ? confidence.toLowerCase() : '',
    });
  }
  return rows;
}

// Pure filter: which self-assessment rows earn a spot on the checker's
// priority list? Anything the dev itself didn't mark "done", OR marked done
// but with low confidence — "done" + "high" confidence rows are exactly the
// ones the checker can verify normally without a nudge.
export function selectPriorityCriteria(rows) {
  return (rows || []).filter((r) => {
    if (!r || !r.criterion) return false;
    if (r.status && r.status !== 'done') return true;
    if (r.confidence === 'low') return true;
    return false;
  });
}

// ─── Acceptance-check hook (brief P2 part 3/3; P3 gate mode) ────────────────
//
// Wires verify-loop.js's runAcceptanceCheck into runDev(). Report mode
// (docs/VERIFY_LOOP.md §9) records the verdict and never blocks. Gate mode
// (§8, below via runAcceptanceGateLoop) refines a failing verdict, bounded by
// verify.max_refine_attempts, then fails the phase/fix through the existing
// validator-gate failure machinery. Split into pieces so the skip decision,
// the log-line wording, and the refine loop are unit-testable without a live
// cfg or a runClaude fixture.

// Pure decision: should the checker run at all for this phase/fix?
//
// phase-30: `verify.include_fixes` is now three-valued — false | true |
// 'major+' (default 'major+', matching config/defaults.json — this function
// mirrors that default so a caller testing the pure decision in isolation,
// without going through config-resolver, still gets the documented
// behavior). 'major+' verifies critical/major fixes and skips minor ones; a
// missing/unrecognized severity counts as major (verify it, don't skip). The
// criteria check is now enforced for fixes too (previously unreachable,
// since fixes were always hasCriteria:false and excluded earlier by the old
// unconditional include_fixes:false default) — independent of the
// include_fixes value, a fix with no acceptance_criteria always skips.
export function shouldRunAcceptanceCheck({
  verifyCfg, fix, hasCriteria, severity,
  phaseOrdinal = null, isFinalPhase = false, complexity = null, checkpoint = null,
}) {
  const mode = verifyCfg?.mode ?? 'report';
  if (mode === 'off') return { run: false, skipReason: null };

  if (fix) {
    const includeFixes = verifyCfg?.include_fixes ?? 'major+';
    if (includeFixes === false) {
      return { run: false, skipReason: 'fixes are excluded from acceptance verification (verify.include_fixes=false)' };
    }
    if (includeFixes === 'major+') {
      const sev = severity || 'major';
      if (sev === 'minor') {
        return { run: false, skipReason: `fix severity 'minor' is below the verify.include_fixes threshold ('major+' verifies critical/major only)` };
      }
    }
    if (!hasCriteria) {
      return { run: false, skipReason: 'fix has no acceptance_criteria — skipping acceptance verification' };
    }
    return { run: true, skipReason: null };
  }

  if (!hasCriteria && verifyCfg?.skip_when_no_criteria !== false) {
    return { run: false, skipReason: 'no acceptance_criteria listed in plan.json for this phase' };
  }

  // Development-focused cadence is opt-in. Deterministic validator gates still
  // run for every phase; this only right-sizes the additional LLM acceptance
  // checker. Final, high-risk, and explicitly tagged checkpoint phases always
  // keep the checker, with every_n_phases providing a periodic backstop.
  const cadence = verifyCfg?.cadence || {};
  if ((cadence.mode ?? 'checkpoints') === 'checkpoints') {
    if (isFinalPhase && cadence.always_final !== false) {
      return { run: true, skipReason: null };
    }
    const alwaysComplexities = Array.isArray(cadence.always_complexities)
      ? cadence.always_complexities
      : ['high', 'critical'];
    if (complexity && alwaysComplexities.includes(complexity)) {
      return { run: true, skipReason: null };
    }
    const alwaysCheckpoints = Array.isArray(cadence.always_checkpoints)
      ? cadence.always_checkpoints
      : ['architecture', 'schema', 'external-integration', 'destructive'];
    if (checkpoint && alwaysCheckpoints.includes(checkpoint)) {
      return { run: true, skipReason: null };
    }
    const everyN = Number.isInteger(cadence.every_n_phases) && cadence.every_n_phases > 0
      ? cadence.every_n_phases
      : 3;
    // Missing phase position is an integrity ambiguity, so fail safe to the
    // checker rather than silently treating the phase as routine.
    if (!Number.isInteger(phaseOrdinal) || phaseOrdinal < 1 || phaseOrdinal % everyN === 0) {
      return { run: true, skipReason: null };
    }
    return {
      run: false,
      skipReason: `development-focused cadence: routine phase ${phaseOrdinal} is checked by deterministic validators now; LLM acceptance runs every ${everyN} phases and on final/high-risk/checkpoint phases`,
    };
  }
  return { run: true, skipReason: null };
}

// Phase 51 (P1 async report-mode): pure decision — should THIS runDev() call
// skip the inline acceptance check entirely and let a detached background
// worker run it later instead? Deliberately narrow: `fix` always returns
// false (fixes keep today's inline behavior byte-for-byte, regardless of
// deferVerify/async_report — their report/lesson wiring stays synchronous),
// gate mode always returns false (it must stay fully synchronous — a failing
// gate-mode verdict blocks completion, which a deferred check structurally
// cannot do), and async_report must be explicitly `true` (no implicit
// opt-in). `checkDecision` is shouldRunAcceptanceCheck's own output for this
// call — deferring is a WHEN change, never a WHETHER change: a phase that
// shouldRunAcceptanceCheck would have skipped anyway (no criteria, etc.)
// is never deferred either, it just skips exactly as before.
export function shouldDeferAcceptanceCheck({ verifyCfg, fix, deferVerify, checkDecision }) {
  if (fix) return false;
  if (!deferVerify) return false;
  if ((verifyCfg?.mode ?? 'report') !== 'report') return false;
  if (verifyCfg?.async_report !== true) return false;
  return !!checkDecision?.run;
}

// Pure formatter for the post-check log line — the exact wording is
// machine-referenced in docs/VERIFY_LOOP.md §9.
export function formatVerifyOutcomeLine(label, outcome) {
  if (outcome.status === 'fail') {
    const { unmet } = decideVerdict(outcome.verdict);
    const total = (outcome.verdict?.criteria || []).length;
    return { level: 'warn', text: `⚠ ${label}: acceptance verify FAILED (report-only) — ${unmet.length}/${total} criteria unmet` };
  }
  if (outcome.status === 'inconclusive') {
    const reason = (outcome.errors || []).join('; ') || 'no verdict produced';
    return { level: 'warn', text: `⚠ ${label}: acceptance check inconclusive (${reason}) — not blocking completion (fail_open)` };
  }
  if (outcome.status === 'usage-limit') {
    const reason = (outcome.errors || []).join('; ') || 'provider usage limit reached';
    return { level: 'warn', text: `⏸ ${label}: acceptance check hit the provider usage limit (${reason}) — pausing, NOT a verified pass` };
  }
  if (outcome.status !== 'pass' && outcome.status !== 'skipped-trivial') {
    // Exhaustive-by-default: an unrecognized status must never read as a pass.
    return { level: 'warn', text: `⚠ ${label}: acceptance check returned unrecognized status '${outcome.status}' — treating as NOT verified` };
  }
  return { level: 'info', text: `✓ ${label}: acceptance verify passed` };
}

// phase-29 (adversarial dual checker): pure decision — the panel is
// phases-only (fixes always use the single checker; phase 30 relies on this
// invariant) and only fires when cfg.verify.panel.enabled is explicitly true
// AND the phase's routed complexity equals panel.trigger (default 'critical').
export function shouldRunAcceptancePanel({ verifyCfg, fix, complexity }) {
  if (fix) return false;
  const panelCfg = verifyCfg?.panel || {};
  if (panelCfg.enabled !== true) return false;
  const trigger = panelCfg.trigger || 'critical';
  return complexity === trigger;
}

/**
 * Orchestrates the skip decision + the checker call + the log line. Returns
 * the verdict outcome ({status: 'pass'|'fail', verdict} | {status:
 * 'inconclusive', errors}) or null when skipped. `deps.runAcceptanceCheck` is
 * a test seam (defaults to the real verify-loop.js export) — production
 * callers never pass it. This call site never overrides role/sessionId, so
 * the role:null invariant (guide_session_id / last_dev_session_id untouched)
 * comes straight from verify-loop.js unmodified.
 *
 * QL-7: also reads the dev's own completion report, parses its "Acceptance
 * criteria self-assessment" table, and passes any partial/uncertain/
 * low-confidence rows to the checker as priorityCriteria — a shortlist the
 * checker verifies first and most strictly (verify-loop.js's
 * buildAcceptanceCheckPrompt renders it as a deterministic prompt block).
 * Fail-open by construction: an unparseable or missing table yields an empty
 * list (parseCriteriaSelfAssessment never throws), so this is a pure
 * enhancement — a dev report predating this feature costs nothing.
 *
 * phase-29: `complexity` (the phase's routed complexity — routing.complexity
 * from routeModel(), threaded through runDev()) decides whether this phase
 * gets the adversarial dual-checker panel (verify-loop.js's
 * runAcceptancePanel) instead of the single checker — see
 * shouldRunAcceptancePanel, above. Fixes never see this parameter matter
 * (shouldRunAcceptancePanel returns false unconditionally for fix != null).
 * `deps.runAcceptancePanel` is a separate test seam (defaults to the real
 * verify-loop.js export); the non-panel path is completely untouched by it.
 */
export async function runPhaseAcceptanceCheck(
  { cfg, projectName, projDir, workspaceDir, phaseMeta, fix, preSha, commitSha, nextPhase, complexity, phaseOrdinal, isFinalPhase, testFirst, validatorOutcome },
  deps = {},
) {
  const runAcceptanceCheckFn = deps.runAcceptanceCheck ?? runAcceptanceCheck;
  const runAcceptancePanelFn = deps.runAcceptancePanel ?? runAcceptancePanel;
  const resolveFixPhaseMetaFn = deps.resolveFixPhaseMeta ?? resolveFixPhaseMeta;
  const verifyCfg = cfg.verify || {};
  const label = fix ? `Fix r${fix.round}-${fix.n}` : `Phase ${nextPhase}`;

  // Phase 82 (test-first P4b) — TAMPER GUARD. The authored acceptance tests are
  // immutable: a dev could otherwise edit the test file to make the validator
  // gate pass trivially. If the dev commit touched anything under
  // tests/acceptance/ since the orchestrator's own test commit (postTestsSha),
  // the harness is void — force an UNMET verdict + must_fix REGARDLESS of the
  // checker, and short-circuit BEFORE spawning it (a tampered phase spends no
  // checker call). `deps.changedFilesSince` is an injectable seam for tests.
  if (testFirst?.postTestsSha) {
    const changedSinceTestsFn = deps.changedFilesSince ?? changedFilesSince;
    const sinceTests = await changedSinceTestsFn(workspaceDir, testFirst.postTestsSha);
    const tampered = sinceTests?.ok ? sinceTests.files.filter((f) => f.startsWith('tests/acceptance/')) : [];
    if (tampered.length) {
      const forced = buildTestTamperOutcome({ nextPhase, postTestsSha: testFirst.postTestsSha, tampered });
      const tline = formatVerifyOutcomeLine(label, forced);
      console.warn(chalk.yellow(tline.text));
      return forced;
    }
  }

  // phase-30: a fix's phaseMeta arrives null from runDev() (fixes have no
  // plan.json phase entry) — resolve the round plan's own entry into the
  // {n, title, goal, acceptance_criteria, files_expected, severity} shape
  // (verify-loop.js's resolveFixPhaseMeta), so the checker prompt, the
  // criteria-presence check, and the severity gate below all see the real
  // fix spec instead of null. A resolve failure (missing round plan / no
  // matching entry — distinct from an entry with a genuinely empty
  // acceptance_criteria) fails OPEN: hasCriteria defaults to true so an
  // infra hiccup never silently skips verification.
  const resolvedFixMeta = fix ? await resolveFixPhaseMetaFn(projDir, fix) : null;
  const effectivePhaseMeta = fix ? (resolvedFixMeta || phaseMeta || null) : phaseMeta;
  const hasCriteria = fix
    ? (resolvedFixMeta ? Array.isArray(resolvedFixMeta.acceptance_criteria) && resolvedFixMeta.acceptance_criteria.length > 0 : true)
    : Array.isArray(phaseMeta?.acceptance_criteria) && phaseMeta.acceptance_criteria.length > 0;
  const severity = resolvedFixMeta?.severity ?? null;

  const decision = shouldRunAcceptanceCheck({
    verifyCfg, fix, hasCriteria, severity, phaseOrdinal, isFinalPhase, complexity,
    checkpoint: effectivePhaseMeta?.checkpoint,
  });
  if (!decision.run) {
    if (decision.skipReason) console.log(chalk.dim(`  → Acceptance check skipped: ${decision.skipReason}`));
    return null;
  }

  // QL-7: best-effort read of the report the dev just wrote — same path
  // helper verify-loop.js's runAcceptanceCheck itself uses internally, so
  // this always looks at the identical file. A missing/unreadable report (or
  // one predating this feature, with no self-assessment table) degrades to
  // an empty priority list — never blocks or fails the check itself.
  let priorityCriteria = [];
  try {
    const reportPath = fix
      ? await fixReportPath(projDir, fix.round, fix.n, fix.title)
      : await phaseReportPath(projDir, nextPhase, phaseMeta?.title);
    const reportText = await readText(reportPath);
    const rows = parseCriteriaSelfAssessment(reportText);
    priorityCriteria = selectPriorityCriteria(rows);
    if (reportText && reportText.trim() && !rows.length) {
      // Report exists but the table didn't parse — record it as a lesson
      // (agent-authored-report class) so a persistently malformed table
      // becomes visible in .guide/lessons.jsonl instead of silently costing
      // the checker its priority shortlist every time.
      await recordLesson(projDir, {
        kind: 'agent',
        phase: fix ? null : nextPhase,
        fix: fix ? `r${fix.round}-${fix.n}` : null,
        source: 'phase-runner:self-assessment-parse',
        lesson: 'Completion report had no parseable "Acceptance criteria self-assessment" table — checker ran without a priority shortlist.',
        files: effectivePhaseMeta?.files_expected || [],
      }, cfg);
    }
  } catch (err) {
    console.warn(chalk.yellow(`[self-assessment] priority-criteria parse skipped: ${err.message}`));
  }

  // Phase 82 (test-first P4b): criteria the authored (and gate-passed) test
  // already verifies — the checker marks them met-by-test and spends its
  // scrutiny on the rest. Undefined for every non-test-first run (byte-identical
  // checker prompt). Untampered by construction (tamper short-circuits above).
  const coveredByTest = testFirst?.covered;
  const runPanel = shouldRunAcceptancePanel({ verifyCfg, fix, complexity });
  const outcome = runPanel
    ? await runAcceptancePanelFn({ cfg, projectName, projDir, workspaceDir, phaseMeta: effectivePhaseMeta, preSha, commitSha, nextPhase, priorityCriteria, coveredByTest, validatorOutcome })
    : await runAcceptanceCheckFn({ cfg, projectName, projDir, workspaceDir, phaseMeta: effectivePhaseMeta, fix, preSha, commitSha, nextPhase, priorityCriteria, coveredByTest, validatorOutcome });
  const line = formatVerifyOutcomeLine(label, outcome);
  if (line.level === 'warn') console.warn(chalk.yellow(line.text));
  else console.log(chalk.green(line.text));
  return outcome;
}

// Phase 82 (test-first P4b) — pure builder for the tamper-guard verdict. When
// the dev commit modified the immutable authored acceptance tests, the phase
// fails automatically: an UNMET synthetic criterion + a must_fix telling the
// dev to revert tests/acceptance/. Shaped exactly like a checker outcome
// ({status, verdict}) so it flows through the report-mode lesson capture and
// the gate-mode refine ladder unchanged (decideVerdict reads verdict.verdict +
// criteria; both mark this an effective fail).
export function buildTestTamperOutcome({ nextPhase, postTestsSha, tampered }) {
  const files = (tampered || []).join(', ');
  const mustFix = `The authored acceptance tests are immutable, but the dev commit modified ${files} (git diff ${postTestsSha}..HEAD -- tests/acceptance/ is non-empty). Revert every change under tests/acceptance/ and make the code satisfy the tests as originally written.`;
  return {
    status: 'fail',
    verdict: {
      $schema_version: 1,
      phase: nextPhase,
      verdict: 'fail',
      criteria: [{
        criterion: 'Authored acceptance tests unmodified by the dev commit',
        status: 'unmet',
        evidence: `git diff ${postTestsSha}..HEAD -- tests/acceptance/ shows modified file(s): ${files}`,
      }],
      must_fix: [mustFix],
      notes: 'test-first tamper guard: the dev edited the immutable authored acceptance tests.',
    },
    tamper: { tampered: true, files: [...(tampered || [])] },
  };
}

// Pure decision: has the checker's outcome earned a gate-mode refine attempt?
// mode isolation lives here — report/off modes (or any non-'fail' outcome,
// including 'inconclusive') never trigger the refine loop below.
export function shouldRunGateRefine({ verifyCfg, outcomeStatus }) {
  return (verifyCfg?.mode ?? 'report') === 'gate' && outcomeStatus === 'fail';
}

// Brief FR1 gap-fix (phase 13) — records a 'verify-fail' lesson for an
// effective-fail outcome that shouldRunGateRefine will NOT act on: report
// mode always (mode isn't 'gate'), or a gate-mode fail that isn't headed
// into the refine loop below. A gate-mode fail that DOES enter the refine
// loop is recorded separately (if at all), only once the loop's own
// terminal outcome is known — see the `if (gateLoop.failed)` recordLesson
// call further down — never here, so a since-corrected gate-mode failure
// never produces a premature/duplicate lesson. Mirrors the bullet-extraction
// the gate-mode call site already does. `deps.recordLesson` is a test seam
// (defaults to the real lessons.js export); production callers never pass it.
export async function maybeRecordReportModeVerifyFailLesson(
  { cfg, projDir, phaseMeta, fix, nextPhase, verifyOutcome },
  deps = {},
) {
  const recordLessonFn = deps.recordLesson ?? recordLesson;
  if (verifyOutcome?.status !== 'fail') return false;
  if (shouldRunGateRefine({ verifyCfg: cfg.verify, outcomeStatus: verifyOutcome.status })) return false;
  const { unmet } = decideVerdict(verifyOutcome.verdict || {});
  const mustFix = verifyOutcome.verdict?.must_fix?.length ? verifyOutcome.verdict.must_fix : unmet.map((c) => c.criterion);
  const bullets = (mustFix.length ? mustFix : ['(see verify.json for details)']).map((m) => `- ${m}`).join('\n');
  await recordLessonFn(projDir, {
    kind: 'verify-fail',
    phase: fix ? null : nextPhase,
    fix: fix ? `r${fix.round}-${fix.n}` : null,
    source: 'phase-runner:acceptance-check-report-mode',
    lesson: bullets,
    files: phaseMeta?.files_expected || [],
  }, cfg);
  return true;
}

// phase-26 — honor verify.fail_open on an 'inconclusive' checker outcome.
// Pure decision: independent of verify.mode (report/gate) — fail_open is
// about the CHECKER's OWN reliability (spawn error, or a still-unparseable
// verdict even after verify-loop.js's re-ask AND opus fallback), a different
// axis from shouldRunGateRefine (which only ever acts on status:'fail', so an
// 'inconclusive' outcome already skips the refine ladder structurally).
// fail_open defaults to true (config/defaults.json verify.fail_open) — only
// an EXPLICIT false fails the phase/fix closed.
export function shouldFailClosedOnInconclusive({ verifyCfg, outcomeStatus }) {
  return outcomeStatus === 'inconclusive' && verifyCfg?.fail_open === false;
}

// phase-26 — fail_open:true (the default) no longer silently passes an
// inconclusive checker outcome: it now records a 'verify-unverified' lesson
// so the gap is visible in .guide/lessons.jsonl instead of only a console
// warning. No-op when the outcome isn't inconclusive, or when it IS but
// fail_open:false (that case fails the phase/fix outright instead — see
// shouldFailClosedOnInconclusive, above, and the call site in runDev()).
// `deps.recordLesson` is a test seam (defaults to the real lessons.js export);
// production callers never pass it.
export async function maybeRecordInconclusiveLesson(
  { cfg, projDir, phaseMeta, fix, nextPhase, verifyOutcome },
  deps = {},
) {
  const recordLessonFn = deps.recordLesson ?? recordLesson;
  if (verifyOutcome?.status !== 'inconclusive') return false;
  if (shouldFailClosedOnInconclusive({ verifyCfg: cfg.verify, outcomeStatus: verifyOutcome.status })) return false;
  const reason = (verifyOutcome.errors || []).join('; ') || 'no verdict produced';
  await recordLessonFn(projDir, {
    kind: 'verify-unverified',
    phase: fix ? null : nextPhase,
    fix: fix ? `r${fix.round}-${fix.n}` : null,
    source: 'phase-runner:acceptance-check-inconclusive',
    lesson: `Acceptance check inconclusive (fail_open) — ${reason}`,
    files: phaseMeta?.files_expected || [],
  }, cfg);
  return true;
}

// Phase 41 (CE-9) — records a 'verify-refined' lesson when the acceptance gate
// PASSED but only after >=1 refine attempt. Symmetric to the deferred
// verify-fail path (the `if (gateLoop.failed)` recordLesson in runDev): that
// captures terminal failures, this captures the near-misses a refine had to
// rescue, so the file-overlap signal carries BOTH into future phases. Records
// nothing when the gate failed, or when it passed on the first pass (a clean
// first-pass gate never enters runDev's shouldRunGateRefine block at all, and a
// gate loop entered from there always runs >=1 attempt). The bullets are the
// INITIALLY-unmet criteria (from the pre-refine outcome), mirroring the
// bullet-extraction the sibling helpers use. `deps.recordLesson` is a test seam.
export async function maybeRecordGateRefinedLesson(
  { cfg, projDir, phaseMeta, fixLessonMeta, fix, nextPhase, initialOutcome, gateLoop },
  deps = {},
) {
  const recordLessonFn = deps.recordLesson ?? recordLesson;
  if (!gateLoop || gateLoop.failed) return false;
  if (!(gateLoop.attempts >= 1)) return false;
  const { unmet } = decideVerdict(initialOutcome?.verdict || {});
  const mustFix = initialOutcome?.verdict?.must_fix?.length ? initialOutcome.verdict.must_fix : unmet.map((c) => c.criterion);
  const bullets = (mustFix.length ? mustFix : ['(see verify.json for details)']).map((m) => `- ${m}`).join('\n');
  await recordLessonFn(projDir, {
    kind: 'verify-refined',
    phase: fix ? null : nextPhase,
    fix: fix ? `r${fix.round}-${fix.n}` : null,
    source: 'phase-runner:acceptance-gate-refined',
    lesson: bullets,
    files: phaseMeta?.files_expected || fixLessonMeta?.files_expected || [],
  }, cfg);
  return true;
}

// v0.15.0 / brief P3 — gate-mode refine → re-check loop (docs/VERIFY_LOOP.md §8).
// Called from runDev() ONLY when verify.mode === 'gate' and the initial checker
// outcome is an effective fail (outcome.status === 'fail' — decideVerdict already
// folded "verdict:pass but a criterion unmet" into that status inside
// runAcceptanceCheck, so the gate boundary inherits that decision for free).
//
// Mirrors the validator gate's mechanical-retry shape exactly: resume the DEV
// session (never the checker's) with the must_fix bullets injected, re-run the
// validator gate on the new diff, then re-check with a FRESH checker session
// (runAcceptanceCheckFn always spawns sessionId:null internally — never resumed).
// Bounded by cfg.verify.max_refine_attempts (default 2). A validator-gate
// failure mid-refine is treated as a terminal fail for this attempt (a broken
// commit is worse than an unmet criterion) rather than spending a checker call
// on it. All five collaborators are dependency-injected so this is testable
// with zero real `claude` subprocess spawns.
//
// phase-25 tier-escalating rung: attempt 1 resumes the dev session on the
// current dev model (unchanged from today); attempt 2+ resumes the SAME session
// — the loaded context is the asset, so we keep it and only add horsepower — but
// bumps the model ONE tier above the dev model (sonnet→opus→fable; an already-
// fable dev model has no rung above it → no bump). The bumped cfg is passed only
// to the refine dev call (runClaudeFn); the validator gate and the read-only
// checker keep the original cfg. The tiers actually tried are returned as
// outcome.refine_tiers so the caller's is_error result carries them and the
// phase-23 escalation marker (written once, by executeAction) targets a rung
// above everything already burned — see failedTierFromResult in escalation.js.
export async function runAcceptanceGateLoop(
  {
    cfg, projectName, projDir, workspaceDir, phaseMeta, fix, preSha, commitSha, nextPhase,
    sessionId, gateEvent, gateLabel, devSystemPromptExtra, initialOutcome, complexity = null,
  },
  deps = {},
) {
  const runClaudeFn = deps.runClaude ?? runClaude;
  const runValidatorGateFn = deps.runValidatorGate ?? runValidatorGate;
  const runAcceptanceCheckFn = deps.runAcceptanceCheck ?? runAcceptanceCheck;
  const changedFilesSinceFn = deps.changedFilesSince ?? changedFilesSince;
  const getHeadShaFn = deps.getHeadSha ?? getHeadSha;
  const compileContextManifestFn = deps.compileContextManifest ?? compileContextManifest;
  const recordContextManifestFn = deps.recordContextManifest ?? recordContextManifest;
  const recordContextOutcomeFn = deps.recordContextOutcome ?? recordContextOutcome;
  const recordContextCompileEventFn = deps.recordContextCompileEvent
    ?? (deps.compileContextManifest ? (() => {}) : recordContextCompileEvent);
  const resolveFixPhaseMetaFn = deps.resolveFixPhaseMeta ?? resolveFixPhaseMeta;

  const maxAttempts = Number.isFinite(cfg.verify?.max_refine_attempts) ? cfg.verify.max_refine_attempts : 1;

  // phase-25 tier-escalating rung. Attempt 1 stays on the current dev model;
  // attempt 2+ bumps the model ONE tier above the dev model (sonnet→opus→fable).
  // An already-fable dev model has no rung above it (nextTier → null) → no bump.
  // The bumped model id is resolved from cfg.model_routing.tier_models; when that
  // map lacks the rung we fail-open to the dev model (no bump) rather than throw.
  const tierModels = cfg.model_routing?.tier_models;
  const devTier = modelToTier(cfg.model, tierModels);
  const bumpTier = nextTier(devTier);
  const bumpModel = bumpTier ? (tierModels?.[bumpTier] ?? null) : null;

  let outcome = initialOutcome;
  let currentCommitSha = commitSha;
  // A normal acceptance failure is a new, tightly-scoped repair problem. In
  // assist/enforce mode start its first attempt in a fresh compact session so
  // it does not drag the original dev session's accumulated cache through
  // every repair. Subsequent repair attempts keep that new session. Shadow,
  // disabled, and legacy configs preserve the historical resumed-session path.
  const freshRepairSession = contextCompilerInjects(cfg) && cfg.context_compiler?.fresh_repair_session !== false;
  let currentSessionId = sessionId || null;
  let attempts = 0;
  const refineTiers = [];
  let compilerPhaseMeta = phaseMeta || null;
  if (fix && !compilerPhaseMeta) {
    try { compilerPhaseMeta = await resolveFixPhaseMetaFn(projDir, fix); } catch { /* fail open */ }
  }

  while (outcome?.status === 'fail' && attempts < maxAttempts) {
    attempts += 1;
    const attemptBaseSha = currentCommitSha;
    // attempt 1 → dev model/tier unchanged; attempt 2+ → one-tier-up bump when a
    // rung above the dev model exists AND its model id resolves.
    const bumped = attempts >= 2 && bumpModel != null;
    const attemptModel = bumped ? bumpModel : cfg.model;
    const attemptTier = bumped ? bumpTier : devTier;
    let attemptCfg = bumped ? { ...cfg, model: attemptModel } : cfg;
    refineTiers.push(attemptTier);

    const { unmet } = decideVerdict(outcome.verdict || {});
    const mustFixSource = outcome.verdict?.must_fix?.length ? outcome.verdict.must_fix : unmet.map((c) => c.criterion);
    const bullets = (mustFixSource.length ? mustFixSource : ['(see verify.json for details)']).map((m) => `- ${m}`).join('\n');

    let refinePrompt = `Your commit for ${gateLabel.toLowerCase()} passed the validators but FAILED acceptance verification by an independent reviewer. Unmet criteria:

${bullets}

Fix EXACTLY these items — nothing else. No refactors, no scope creep. When fixed, make one commit (same message format as before, suffixed "(acceptance fix)").`;

    // Compile and persist an exact repair-specific manifest from the failed
    // criteria and current diff. The runtime MCP binding uses this manifest id
    // directly (latest.json is only a convenience pointer). In assist/enforce,
    // prepend its bounded map whenever this repair session has not seen it.
    let repairManifestId = null;
    let repairManifest = null;
    let repairContextUse = { inject: false, degraded: false, force_full_verification: false, reason: 'no-manifest' };
    if (cfg.context_compiler?.enabled === true) {
      attemptCfg = { ...attemptCfg, _context_compiler: undefined };
      const repairChanged = preSha ? await changedFilesSinceFn(workspaceDir, preSha) : { ok: false, files: [] };
      let repairBaseSha = currentCommitSha;
      try { repairBaseSha = (await getHeadShaFn(workspaceDir)) || currentCommitSha; } catch { /* fail open */ }
      repairManifest = await compileContextWithinTimeout({
        workspaceDir,
        projDir,
        projectName,
        baseSha: repairBaseSha || currentCommitSha,
        cfg,
        task: {
          task_kind: 'acceptance-repair',
          phase: fix ? null : nextPhase,
          title: compilerPhaseMeta?.title || gateLabel,
          goal: compilerPhaseMeta?.goal || compilerPhaseMeta?.description || null,
          criteria: compilerPhaseMeta?.acceptance_criteria || [],
          explicit_paths: compilerPhaseMeta?.files_expected || compilerPhaseMeta?.files_likely || [],
          changed_files: repairChanged?.ok ? repairChanged.files : [],
          failed_criteria: unmet.map((criterion) => criterion.criterion).filter(Boolean),
          must_fix: mustFixSource,
          // Keep the phase's routed risk. Hard-coding every repair to "high"
          // makes the compiler require a full suite and renders both targeted
          // repair tests and delta acceptance rechecks unreachable.
          complexity: complexity || compilerPhaseMeta?.complexity || 'medium',
          checkpoint: compilerPhaseMeta?.checkpoint || null,
        },
      }, compileContextManifestFn, recordContextCompileEventFn);
      if (repairManifest) {
        repairManifestId = repairManifest.manifest_id;
        try { recordContextManifestFn(repairManifest); } catch (err) {
          console.warn(chalk.yellow(`[context-compiler] repair telemetry write failed: ${err.message}`));
        }
        repairContextUse = resolveCompiledContextUse(cfg, repairManifest);
        const inject = repairContextUse.inject;
        let repairBlock = null;
        if (inject) {
          try {
            repairBlock = renderCompiledContextBlock(repairManifest, { maxTokens: repairManifest.token_budget });
          } catch (err) {
            console.warn(chalk.yellow(`[context-compiler] repair render failed open: ${err.message}`));
          }
        }
        if (repairBlock && freshRepairSession && attempts === 1) currentSessionId = null;
        if (repairBlock) refinePrompt = `${repairBlock}\n\n${refinePrompt}`;
        attemptCfg = {
          ...attemptCfg,
          _context_compiler: {
            manifest_id: repairManifest.manifest_id,
            provider: repairManifest.provider,
            mode: repairManifest.mode,
            injected_tokens: repairBlock ? repairManifest.injected_token_estimate : 0,
            exposed: Boolean(repairBlock),
            recovery_block: repairBlock,
          },
        };
      }
    }

    const refineRes = await runClaudeFn({
      cfg: attemptCfg, cwd: workspaceDir, prompt: refinePrompt,
      systemPromptFile: path.join(PROMPTS_DIR, 'dev-system.md'),
      systemPromptExtra: devSystemPromptExtra,
      sessionId: currentSessionId,
      role: 'dev', project: projectName, phase: nextPhase, projectDir: projDir,
      task: fix ? 'fix-execution' : 'dev-execution',
      // v0.17 (OBS-2) / phase-25: this is an acceptance-gate refine, not a
      // routeModel() call — the tier is the one THIS attempt actually runs on
      // (attemptTier: the dev tier on attempt 1, one rung up on attempt 2+) and
      // it's marked escalated (it only runs after an initial acceptance-check
      // failure). `attempt` counts refine attempts, 1-based (1 = first refine,
      // matching the loop's own `attempts` counter).
      routing: {
        tier: attemptTier,
        reasoning: [`acceptance-gate refine attempt ${attempts}/${maxAttempts}${bumped ? ` — tier-bumped ${devTier}→${attemptTier}` : ''}`],
        attempt: attempts,
        escalated: true,
      },
    });
    if (refineRes.session_id) {
      await recordDevSession(projDir, refineRes.session_id);
      currentSessionId = refineRes.session_id;
    }

    if (refineRes.is_error) {
      outcome = {
        status: 'fail',
        verdict: { verdict: 'fail', criteria: [], must_fix: [`Refine attempt errored: ${refineRes.error_message || refineRes.result || 'unknown error'}`] },
      };
      break;
    }

    const changed = attemptBaseSha ? await changedFilesSinceFn(workspaceDir, attemptBaseSha) : { ok: false };
    if (changed.ok && repairManifestId) {
      try { recordContextOutcomeFn({ manifest_id: repairManifestId, actual_files: changed.files }); } catch { /* telemetry never gates */ }
    }
    const repairTestPlan = resolveContextTestPlan({
      cfg, manifest: repairManifest, repair: true,
      complexity: complexity || compilerPhaseMeta?.complexity || 'medium',
      checkpoint: compilerPhaseMeta?.checkpoint || null,
      enforceDegraded: repairContextUse.degraded || repairContextUse.force_full_verification,
      changedFiles: changed.ok ? changed.files : [], changedFilesKnown: changed.ok,
    });
    const gate = await runValidatorGateFn({
      projectName, workspaceDir, event: gateEvent,
      changedFiles: changed.ok ? changed.files : [], cfg,
      testPlan: repairTestPlan,
    });

    currentCommitSha = await getHeadShaFn(workspaceDir);

    if (gate.hasFailures) {
      const excerpt = gateFailureExcerpt(gate);
      outcome = {
        status: 'fail',
        verdict: { verdict: 'fail', criteria: [], must_fix: [`Validator gate failed after the acceptance-fix commit: ${excerpt || 'see validator output'}`] },
      };
      break;
    }

    const deltaPlan = resolveDeltaAcceptancePlan({
      cfg, manifest: repairManifest, compiledUse: repairContextUse,
      baselineVerdict: outcome.verdict, phaseMeta: compilerPhaseMeta || phaseMeta,
      changedFiles: changed.ok ? changed.files : [], changedFilesKnown: changed.ok,
    });
    outcome = await runAcceptanceCheckFn({
      cfg, projectName, projDir, workspaceDir,
      phaseMeta: deltaPlan.delta ? deltaPlan.phaseMeta : phaseMeta,
      fix,
      preSha: deltaPlan.delta ? attemptBaseSha : preSha,
      commitSha: currentCommitSha,
      nextPhase,
      validatorOutcome: gate,
      baselineVerdict: deltaPlan.delta ? deltaPlan.baselineVerdict : null,
    });
  }

  if (outcome?.status === 'skipped-trivial') {
    outcome = {
      status: 'inconclusive', verdict: null,
      errors: ['acceptance recheck was skipped as trivial after an earlier failing verdict'],
    };
  }
  // Provider window exhaustion is control flow, not a verdict: surface it
  // unchanged (usageLimited flag below) so runDev can pause exactly like the
  // initial-check path at its usage-limit chokepoint.
  const usageLimited = outcome?.status === 'usage-limit';
  // Exhaustive-by-default: any status this loop does not recognize must land
  // as inconclusive, never fall through to a silent "verified pass".
  if (outcome && !['pass', 'fail', 'inconclusive', 'usage-limit'].includes(outcome.status)) {
    outcome = {
      status: 'inconclusive', verdict: null,
      errors: [`acceptance recheck returned unrecognized status '${outcome.status}'`],
    };
  }
  if (outcome?.status === 'inconclusive' && cfg.verify?.fail_open === false) {
    outcome = {
      status: 'fail',
      verdict: {
        verdict: 'fail', criteria: [],
        must_fix: [`Acceptance recheck was inconclusive and verify.fail_open=false: ${(outcome.errors || []).join('; ') || 'no valid verdict'}`],
      },
      errors: outcome.errors || [],
    };
  }

  return {
    // phase-25: refine_tiers rides on the outcome so the caller's is_error
    // result carries it straight through as verify_outcome.refine_tiers (read
    // by failedTierFromResult); also surfaced top-level for direct callers.
    failed: outcome?.status === 'fail',
    verified: outcome?.status === 'pass',
    inconclusive: outcome?.status === 'inconclusive',
    usageLimited,
    outcome: outcome ? { ...outcome, refine_tiers: refineTiers } : outcome,
    attempts,
    commitSha: currentCommitSha,
    sessionId: currentSessionId,
    refine_tiers: refineTiers,
  };
}

// ─── v0.18 turn-budget continuation (same-session finish before escalation) ──
//
// A dev/fix call ending with subtype 'error_max_turns' is not a logic failure —
// the model simply ran out of budget mid-work. The session state (and the warm
// prompt cache behind it) is intact, so resuming the SAME session with a small
// targeted budget is 5-10x cheaper than the alternative: letting the phase fail
// into failure-driven escalation, which starts a FRESH session on a HIGHER tier
// and re-pays the full cache_creation cost before writing a line (observed on
// aorch: $10-14 per fresh opus re-run vs $1-2 per same-session continuation;
// phases 51/52 cost $25/$38 through the old path). Only a continuation that
// ALSO exhausts its budget falls through to the normal escalation ladder — the
// ladder is unchanged, it just stops being the FIRST response to a turn-budget
// exhaustion. Never blocks/pauses anything: a thrown continuation (billing
// pause, spawn failure) falls back to the original result and the phase fails
// into normal routing exactly as it would have without this feature.

export function buildTurnContinuationPrompt({ fix, isBatch = false }) {
  const kind = (fix || isBatch) ? 'fix' : 'phase';
  return `You hit the turn budget for this ${kind} before finishing. This session is resumed — all your work and context so far are preserved.

Finish the remaining work, economically:
1. Complete ONLY what is still missing — do NOT redo, re-verify, or refactor work you already finished.
2. If the code changes are complete but uncommitted, commit now (same message format as instructed earlier).
3. Write your completion report to the exact report path given at the start of this session, if you have not already.

No exploration, no re-reading files you already know. Finish and commit.`;
}

function boundedRecoveryText(value, maxChars = 6000) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[truncated by orchestrator]`;
}

/**
 * Build the deliberately-small prompt used when a max-turns session has grown
 * too expensive to resume. The workspace is the source of truth: the fresh
 * agent inspects the current diff/HEAD and completes only the missing work.
 * This avoids replaying a 180k+ conversation while preserving the phase's
 * acceptance contract and exact report path.
 */
export function buildFreshTurnRecoveryPrompt({
  fix, isBatch = false, taskMeta = null, relReportPath = null,
  priorSessionId = null, compiledContextBlock = null,
} = {}) {
  const kind = fix ? `fix r${fix.round}-${fix.n}` : isBatch ? 'fix batch' : `phase ${taskMeta?.n ?? ''}`.trim();
  const criteria = Array.isArray(taskMeta?.acceptance_criteria)
    ? taskMeta.acceptance_criteria.filter(Boolean).slice(0, 12)
    : [];
  const files = Array.isArray(taskMeta?.files_expected)
    ? taskMeta.files_expected.filter(Boolean).slice(0, 20)
    : Array.isArray(taskMeta?.files_likely)
      ? taskMeta.files_likely.filter(Boolean).slice(0, 20)
      : [];
  const context = boundedRecoveryText(compiledContextBlock, 8000);
  const report = relReportPath
    ? `Write the completion report to exactly \`${relReportPath}\`.`
    : 'Write every completion report required by the original task.';

  return [
    context,
    `<fresh_compact_recovery prior_session="${priorSessionId || 'unknown'}">`,
    `The previous ${kind} session exhausted its turn budget and had become too large to resume economically.`,
    'The existing workspace, git history, and uncommitted diff contain its work. Do not restart the task.',
    '',
    `Title: ${boundedRecoveryText(taskMeta?.title, 500) || '(not recorded)'}`,
    `Goal: ${boundedRecoveryText(taskMeta?.goal || taskMeta?.description, 2000) || '(recover from the workspace and original report contract)'}`,
    criteria.length ? `Acceptance criteria:\n${criteria.map((item) => `- ${boundedRecoveryText(String(item), 1000)}`).join('\n')}` : '',
    files.length ? `Likely files:\n${files.map((item) => `- ${boundedRecoveryText(String(item), 500)}`).join('\n')}` : '',
    '',
    'Recovery protocol:',
    '1. Inspect `git status --short`, `git diff`, and the latest commit/report first.',
    '2. Identify only unfinished acceptance criteria; preserve correct existing work.',
    '3. Implement the smallest remaining change and run only relevant checks.',
    '4. Commit the finished implementation if it is not already committed.',
    `5. ${report}`,
    '',
    'Do not perform broad repository exploration, repeat completed tests, or refactor unrelated code.',
    '</fresh_compact_recovery>',
  ].filter(Boolean).join('\n');
}

/**
 * Preserve compiler-token attribution whenever a follow-up call can still see
 * the compiled block: either it resumes the same session, or the caller
 * explicitly places that block into a fresh prompt. A fresh session whose
 * prompt omits the block has no compiler exposure and must record zero.
 *
 * The returned object is the original cfg when no adjustment is needed. The
 * zeroing path clones both levels so callers never mutate shared config.
 */
export function contextCompilerFollowupCfg(cfg, { sessionId = null, contextBlockIncluded = false } = {}) {
  if (!cfg?._context_compiler || sessionId || contextBlockIncluded) return cfg;
  return {
    ...cfg,
    _context_compiler: {
      ...cfg._context_compiler,
      injected_tokens: 0,
      exposed: false,
      recovery_block: null,
    },
  };
}

/**
 * Resume the same dev session with a small task-capped turn budget after an
 * error_max_turns result. Returns the final result: the (possibly successful)
 * continuation result, or `initialResult` untouched when the trigger
 * conditions don't hold. Bounded by phases.max_continuation_attempts; a
 * continuation that itself ends error_max_turns is retried up to that bound,
 * any other outcome (success OR a different error) ends the loop immediately.
 *
 * cfg keys (phases.*, read with code fallbacks so configs predating this
 * feature behave identically): max_turns_continuation (25; 0 disables),
 * max_continuation_attempts (1).
 */
export async function runTurnContinuationLoop({
  cfg, projectName, projDir, workspaceDir, nextPhase, fix, isBatch = false,
  devSystemPromptExtra, initialResult, routing, escalated,
  taskMeta = null, relReportPath = null,
}, deps = {}) {
  const runClaudeFn = deps.runClaude ?? runClaude;
  const recordDevSessionFn = deps.recordDevSession ?? recordDevSession;
  const backfillPhaseSessionIdFn = deps.backfillPhaseSessionId ?? backfillPhaseSessionId;

  const contTurns = cfg.phases?.max_turns_continuation ?? 25;
  const configuredAttempts = Math.max(0, Number(cfg.phases?.max_continuation_attempts ?? 1) || 0);
  // The hard cap is a separate inherited key, so stale project overrides such
  // as max_continuation_attempts:3 cannot silently defeat the global safety
  // policy. Legacy/frozen configs without the key retain their old behavior.
  const attemptsHardCap = Number(cfg.phases?.max_continuation_attempts_hard_cap);
  const maxAttempts = Number.isFinite(attemptsHardCap) && attemptsHardCap >= 0
    ? Math.min(configuredAttempts, attemptsHardCap)
    : configuredAttempts;
  const maxResumeContext = Number(cfg.phases?.max_continuation_context_tokens);
  const freshRecoveryEnabled = cfg.phases?.fresh_recovery_after_max_turns === true;
  const freshRecoveryTurns = Math.max(1, Number(cfg.phases?.fresh_recovery_max_turns ?? 30) || 30);
  const task = (fix || isBatch) ? 'fix-execution' : 'dev-execution';
  const label = fix ? `Fix r${fix.round}-${fix.n}` : isBatch ? 'Fix batch' : `Phase ${nextPhase}`;

  let result = initialResult;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (!(result?.is_error && result?.subtype === 'error_max_turns')) break;
    if (!result.session_id || !(contTurns > 0)) {
      if (!result.session_id) {
        console.log(chalk.yellow(
          `↻ ${label}: turn budget exhausted but the result carries no session_id — ` +
          `cannot resume; skipping continuation${freshRecoveryEnabled ? ', trying fresh recovery' : ''}.`,
        ));
      }
      break;
    }
    if (Number.isFinite(maxResumeContext)
        && maxResumeContext > 0
        && Number.isFinite(result.last_turn_context_tokens)
        && result.last_turn_context_tokens >= maxResumeContext) {
      console.log(chalk.yellow(
        `↻ ${label}: context ${result.last_turn_context_tokens.toLocaleString()} tokens reached the ` +
        `${maxResumeContext.toLocaleString()}-token resume ceiling — switching to one fresh compact recovery.`,
      ));
      break;
    }

    console.log(chalk.yellow(
      `↻ ${label}: turn budget exhausted — resuming the same session with +${contTurns} turns ` +
      `(continuation ${attempt}/${maxAttempts}) before failing into fresh-session escalation…`,
    ));

    // task_max_turns wins outright in resolveMaxTurns, so a shallow cfg clone
    // with the task's entry set to the continuation budget caps ONLY this
    // call — the caller's cfg (and every later spawn) is untouched.
    // Resuming the same conversation replays/exposes the manifest context even
    // though the compact continuation prompt does not repeat the literal
    // block. Keep the original per-manifest injection estimate for call-level
    // attribution; this is not a second cache-creation charge.
    const followupCfg = contextCompilerFollowupCfg(cfg, { sessionId: result.session_id });
    const contCfg = {
      ...followupCfg,
      phases: {
        ...cfg.phases,
        task_max_turns: { ...(cfg.phases?.task_max_turns || {}), [task]: contTurns },
      },
    };

    let contResult;
    try {
      contResult = await runClaudeFn({
        cfg: contCfg, cwd: workspaceDir, prompt: buildTurnContinuationPrompt({ fix, isBatch }),
        systemPromptFile: path.join(PROMPTS_DIR, 'dev-system.md'),
        systemPromptExtra: devSystemPromptExtra,
        sessionId: result.session_id,
        role: 'dev', project: projectName, phase: nextPhase, projectDir: projDir,
        task,
        routing: {
          tier: routing?.tier,
          reasoning: [`turn-budget continuation ${attempt}/${maxAttempts} — same session, +${contTurns} turns (phases.max_turns_continuation)`],
          attempt: escalated ? 2 : 1,
          escalated: Boolean(escalated),
        },
      });
    } catch (err) {
      console.warn(chalk.yellow(
        `↻ ${label}: continuation attempt errored (${err.message}) — falling through to normal failure routing.`,
      ));
      break;
    }

    if (contResult.session_id) {
      await recordDevSessionFn(projDir, contResult.session_id);
      if (!fix && !isBatch) backfillPhaseSessionIdFn({ project: projectName, n: nextPhase, session_id: contResult.session_id });
    }
    result = contResult;
  }

  // If one bounded continuation still exhausted its turn budget—or the
  // initial session was already above the context ceiling—recover once in a
  // fresh session. This is not an automatic full retry: the compact prompt is
  // built only from the phase contract plus current workspace state.
  if (freshRecoveryEnabled && result?.is_error && result?.subtype === 'error_max_turns') {
    const recoveryBlock = cfg._context_compiler?.recovery_block || null;
    const recoveryPrompt = buildFreshTurnRecoveryPrompt({
      fix, isBatch, taskMeta, relReportPath,
      priorSessionId: result.session_id || initialResult?.session_id,
      compiledContextBlock: recoveryBlock,
    });
    const recoveryCfgBase = contextCompilerFollowupCfg(cfg, { contextBlockIncluded: Boolean(recoveryBlock) });
    const recoveryCfg = {
      ...recoveryCfgBase,
      phases: {
        ...recoveryCfgBase.phases,
        task_max_turns: {
          ...(recoveryCfgBase.phases?.task_max_turns || {}),
          [task]: freshRecoveryTurns,
        },
      },
    };
    console.log(chalk.yellow(
      `↻ ${label}: launching one fresh compact recovery with ${freshRecoveryTurns} turns instead of replaying the exhausted session.`,
    ));
    try {
      const freshResult = await runClaudeFn({
        cfg: recoveryCfg, cwd: workspaceDir, prompt: recoveryPrompt,
        systemPromptFile: path.join(PROMPTS_DIR, 'dev-system.md'),
        systemPromptExtra: devSystemPromptExtra,
        sessionId: null,
        role: 'dev', project: projectName, phase: nextPhase, projectDir: projDir,
        task,
        routing: {
          tier: routing?.tier,
          reasoning: ['fresh compact recovery after max-turn/context exhaustion — current workspace state, no conversation replay'],
          attempt: (escalated ? 2 : 1) + 1,
          escalated: Boolean(escalated),
        },
      });
      if (freshResult.session_id) {
        await recordDevSessionFn(projDir, freshResult.session_id);
        if (!fix && !isBatch) {
          backfillPhaseSessionIdFn({ project: projectName, n: nextPhase, session_id: freshResult.session_id });
        }
      }
      result = freshResult;
    } catch (err) {
      console.warn(chalk.yellow(
        `↻ ${label}: fresh compact recovery errored (${err.message}) — falling through to normal failure routing.`,
      ));
    }
  }
  return result;
}

// MI-3 / QL-7 (merged): shared "Definition of done" block for both inline
// prompt builders below. Pure function of the criteria list — same input
// always produces the same byte-identical output, so it's safe to splice
// into either prompt unconditionally. Names the exact table shape
// parseCriteriaSelfAssessment (below) expects, so the dev agent's own report
// format and the orchestrator's parser stay in lockstep by construction
// rather than by convention alone.
function buildDefinitionOfDoneBlock(criteriaList) {
  const criteria = (criteriaList || []).filter(Boolean);
  const exampleCriterion = criteria[0] || '<criterion text>';
  return `## Definition of done

Before you commit, follow the work protocol's self-verify step: run \`git diff\`, re-read every acceptance criterion above as a hostile reviewer would, and fill in the report's "Acceptance criteria self-assessment" table — one row per criterion, evidence as a real \`file:line\`, filled in from the diff, not from memory. Example row:

| Criterion | Status | Evidence (file:line) | Confidence |
|---|---|---|---|
| ${exampleCriterion} | done | \`path/to/file.js:42\` | high |

Any criterion you can't point at concrete evidence for is not done yet — fix it now, before committing, or mark it \`partial\`/\`uncertain\` honestly. This table is parsed by the orchestrator to focus its own acceptance check on whatever you flagged as uncertain, so an honest table saves you a retry round; an inflated one does not.`;
}

// v0.14.35: dev prompt built directly from the plan's phase spec — used when
// no prompt.md exists and inline_phase_prompts is on. Paths are relative to
// the dev's CWD (workspaceDir), hence the ../ prefixes.
// Phase 42: hasConventions is an INPUT (runDev checks file existence once,
// after materializing it) rather than an fs read here — keeps this builder
// pure/sync, and a false/omitted value reproduces the pre-phase output
// byte-for-byte (no line added).
export function buildInlinePhasePrompt({ projectName, phaseMeta, plan, projDir, workspaceDir, hasConventions = false, scoutNote = null }) {
  const n = phaseMeta.n;
  const criteriaArr = phaseMeta.acceptance_criteria || [];
  const criteria = criteriaArr.map((c) => `- ${c}`).join('\n') || '- (none listed in plan — satisfy the Goal)';
  const files = (phaseMeta.files_expected || []).map((f) => `- ${f}`).join('\n');
  const relBrief = path.relative(workspaceDir, activeBriefPath(projDir, plan));
  const conventionsLine = hasConventions
    ? `\n- ../.guide/project-conventions.md — durable decisions/conventions grouped by type, plus distilled anti-patterns from prior failures.`
    : '';
  // Phase 55 (P8, speculative scout): riding the VOLATILE per-call user prompt
  // (not systemPromptExtra) is deliberate — a scout note is per-phase, one-shot
  // content, never repeated across calls, so it carries no cache-discipline
  // constraint. Absent (the default-off case, or no note yet) renders nothing —
  // byte-identical to the pre-phase-55 prompt.
  const scoutBlock = scoutNote ? `\n\n${scoutNote}` : '';
  return `# Phase ${n} — ${phaseMeta.title || '(untitled)'}
Project: ${projectName}

## Goal
${phaseMeta.goal || '(see acceptance criteria)'}
${phaseMeta.notes ? `\n## Notes from the plan\n${phaseMeta.notes}\n` : ''}
## Acceptance criteria (ALL must be met)
${criteria}
${files ? `\n## Files expected to change\n${files}\n` : ''}
## Before writing code, read
- ../.guide/decisions.jsonl — rolling decisions/conventions from prior reviews, for context (one JSON object per line; may not exist yet on early phases)
- ${relBrief} — the brief's "Conventions to follow", "Non-functional requirements", and "Gotchas" sections apply to this phase
- The existing code you are about to touch — match its patterns${conventionsLine}

${buildDefinitionOfDoneBlock(criteriaArr)}

## Commit
One commit when done. Message format: phase-${n}: <one-line summary>${scoutBlock}`;
}

// ─── Phase 55 (P8, speculative Haiku scout) ─────────────────────────────────
//
// A concurrent, read-only haiku call that drafts the NEXT phase's file map
// while the CURRENT phase's dev agent is still running — pure idle-time
// capture (a dev call runs 10-30 min; the scout is a <=15-turn haiku call
// capped at 4 min). Ships OFF by default (phases.scout.enabled) since dev
// spawns already receive the full repo map — the scout's only incremental
// value is why-relevant annotation, unproven until measured. Prompt-building
// + staleness/injection logic lives here (mirrors buildInlinePhasePrompt's
// own home); the spawn/worktree-pin/persistence orchestration lives in
// auto-runner.js (mirrors spawnDetachedReview's split — the scout's read-only
// sandbox has no Write tool, so the ORCHESTRATOR persists its reply, exactly
// like verify-loop.js's persistVerdict).

export const PHASE_SCOUT_SYSTEM_PROMPT =
  `You are the Ashmero Orchestrator's phase scout. You run concurrently with the ` +
  `dev agent working on the CURRENT phase, speculatively mapping the NEXT phase's ` +
  `likely files before that phase starts. You are strictly read-only: you have no ` +
  `Write, Edit, or unrestricted Bash tool and cannot modify the workspace in any ` +
  `way. Do not write code, run tests, or propose fixes — only point at files, ` +
  `patterns, and integration points. Your only output is the three markdown ` +
  `sections requested in the task prompt, as your final reply — no other text.`;

/**
 * Build the scout's task prompt. Pure function of its input — same phaseMeta
 * always produces the same byte-identical output (no Date.now()/randomness).
 *
 * @param {Object} args
 * @param {Object} args.phaseMeta - plan.json's entry for the phase AFTER the one currently in progress
 * @returns {string}
 */
export function buildPhaseScoutPrompt({ phaseMeta }) {
  const n = phaseMeta?.n;
  const criteriaArr = phaseMeta?.acceptance_criteria || [];
  const criteria = criteriaArr.length
    ? criteriaArr.map((c, i) => `${i + 1}. ${c}`).join('\n')
    : '(none listed in plan — see Goal)';
  const files = (phaseMeta?.files_expected || []).join(', ') || '(none listed)';

  return `You are scouting AHEAD of the dev agent — Phase ${n} below has not started yet (the dev agent is still working on the phase before it). Your job is to point at the likely files and patterns for Phase ${n}, not to implement anything.

Phase ${n}: ${phaseMeta?.title || '(untitled)'}
Goal: ${phaseMeta?.goal || '(see acceptance criteria)'}

Acceptance criteria:
${criteria}

Files the plan expects to change: ${files}

Do NOT write code, run tests, or propose fixes. Reply with EXACTLY these three sections and nothing else (no other prose, no markdown fence):

## Files
(5-15 repo-relative paths, one per line, each followed by " — " and a one-line reason it's relevant, e.g. "src/lib/foo.js — defines the X this phase extends")

## Patterns to follow
(existing conventions in the touched files/areas the dev agent should match)

## Integration points
(where this phase's code will be called from / must plug into)`;
}

// Fixed header — byte-identical across every call by construction (only sha8
// and the note body are interpolated, never the wording itself).
export function renderScoutNoteBlock({ sha8, noteBody }) {
  return `Advance scout notes (computed at ${sha8}, one phase ago -- verify before relying on them; files may have moved):\n\n${noteBody}`;
}

// ─── scout note front-matter (base_sha) ─────────────────────────────────────
//
// A distinct, narrower schema from context-freshness.js's stampArtifact
// (generated_at_sha/generated_at) — this note carries exactly ONE field,
// base_sha. Unlike stampArtifact (which updates an already-written file), the
// scout note doesn't exist until the orchestrator (auto-runner.js) writes it
// for the first time — the scout's own sandbox has no Write tool — so it
// can't reuse stampArtifact's "update in place" contract.

/**
 * @param {string} baseSha
 * @param {string} noteBody - the scout's raw reply text
 * @returns {string}
 */
export function renderScoutNote(baseSha, noteBody) {
  return `---\nbase_sha: ${baseSha}\n---\n\n${noteBody}`;
}

function parseScoutNote(raw) {
  const m = /^---\nbase_sha:\s*(\S+)\n---\n\n([\s\S]*)$/.exec(String(raw ?? ''));
  if (!m) return null;
  return { baseSha: m[1], body: m[2] };
}

/**
 * Pure parse of the note body's `## Files` section into a bare path list —
 * strips bullet/number markers and any trailing " — reason" annotation.
 * Tolerant of a missing section (returns []) since a malformed scout reply
 * must never throw.
 *
 * @param {string} noteBody
 * @returns {string[]}
 */
export function parseScoutNoteFiles(noteBody) {
  const body = String(noteBody ?? '');
  const m = /##\s*Files\s*\n([\s\S]*?)(?=\n##\s|$)/i.exec(body);
  if (!m) return [];
  const files = [];
  for (const raw of m[1].split('\n')) {
    const line = raw.replace(/^[-*]\s*/, '').replace(/^\d+[.)]\s*/, '').trim();
    if (!line) continue;
    const delim = line.search(/\s+[—–-]\s+/);
    const filePart = (delim === -1 ? line : line.slice(0, delim)).trim().replace(/^`|`$/g, '');
    if (filePart) files.push(filePart);
  }
  return files;
}

/**
 * Pure staleness decision — no fs/git access, just set arithmetic over
 * already-computed inputs. `changed.ok:false` (unresolvable base_sha, or any
 * git failure) is ALWAYS stale — same fail-safe-drop convention as an absent/
 * unparsable base_sha itself (see loadPhaseScoutBlock).
 *
 * @param {Object} args
 * @param {string[]} args.noteFiles - parseScoutNoteFiles's result
 * @param {{ok: boolean, files?: string[]}} args.changed - changedFilesSince's result
 * @param {number} [args.maxStalenessPct] - cfg.phases.scout.max_staleness_pct (default 30)
 * @returns {boolean}
 */
export function isScoutNoteStale({ noteFiles, changed, maxStalenessPct }) {
  if (!changed?.ok) return true;
  if (!noteFiles.length) return false;
  const changedSet = new Set(changed.files || []);
  const staleCount = noteFiles.filter((f) => changedSet.has(f)).length;
  const pct = (staleCount / noteFiles.length) * 100;
  const threshold = Number.isFinite(maxStalenessPct) ? maxStalenessPct : 30;
  return pct > threshold;
}

/**
 * Fail-open load/consume wrapper for the scout note at phaseScoutPath(projDir,
 * nextPhase) — the ONE call site runDev needs before invoking
 * buildInlinePhasePrompt. Returns null (nothing to inject) when: scouting is
 * off, no note exists yet, the note has no parsable base_sha front-matter, or
 * the note is stale per isScoutNoteStale. The note is DELETED on every path
 * that finds one (consume-once, including both drop paths) so a stale/
 * malformed note never resurfaces on a later call for the same phase number.
 *
 * @param {string} projDir
 * @param {string} workspaceDir
 * @param {number} nextPhase
 * @param {Object} cfg
 * @param {{changedFilesSince?: Function}} [deps] - injectable seam for tests
 * @returns {Promise<string|null>}
 */
export async function loadPhaseScoutBlock(projDir, workspaceDir, nextPhase, cfg, deps = {}) {
  if (cfg?.phases?.scout?.enabled !== true) return null;
  const changedFilesSinceFn = deps.changedFilesSince ?? changedFilesSince;
  const notePath = phaseScoutPath(projDir, nextPhase);
  const raw = await readText(notePath);
  if (!raw) return null;

  const drop = async (reason) => {
    console.log(chalk.dim(`[phase-scout] note for phase ${nextPhase} ${reason} — dropping`));
    await fs.unlink(notePath).catch(() => {});
  };

  const parsed = parseScoutNote(raw);
  if (!parsed || !parsed.baseSha) {
    await drop('has no parsable base_sha front-matter');
    return null;
  }

  const noteFiles = parseScoutNoteFiles(parsed.body);
  const changed = await changedFilesSinceFn(workspaceDir, parsed.baseSha);
  if (isScoutNoteStale({ noteFiles, changed, maxStalenessPct: cfg?.phases?.scout?.max_staleness_pct })) {
    await drop(`is stale (base ${parsed.baseSha.slice(0, 8)})`);
    return null;
  }

  await fs.unlink(notePath).catch(() => {}); // consume-once — a fresh note is used exactly once
  return renderScoutNoteBlock({ sha8: parsed.baseSha.slice(0, 8), noteBody: parsed.body.trim() });
}

// v0.14.36: hoisted from the buildGuidePrompt audit case so the two-stage
// audit path shares them verbatim. Semantics unchanged from v0.14.34.
export const AUDIT_PROMOTE_RULES = `
Promote-section rules (machine-parsed — follow exactly):
- The "## Promote to bugs-round-N" section must contain ONLY CRITICAL and MAJOR findings, as "### Bug #1 — <title>" entries (Steps to reproduce / Expected / Actual / Affected files).
- MINOR and DEFERRED-OK findings stay OUT of the promote section. Append them to .guide/audit-backlog.md instead (create it if missing; add a "## From audit <this-audit-filename> — <date>" heading). Backlog entry headings must use "### M1 — <title>" / "### D1 — <title>" style — NEVER "Bug N" style, because the promote parser scans for Bug-N headings anywhere in the file.
- If there are zero CRITICAL and zero MAJOR findings, still write the "## Promote to bugs-round-N" heading, containing exactly this single line:
  (nothing to promote — no CRITICAL or MAJOR findings)
  The orchestrator detects that line and stops the audit→fix auto-chain cleanly.`;

// v0.14.34 incremental re-audit detection, extracted (v0.14.36) so runGuide
// can branch on it BEFORE prompt building. If a prior audit stamped the
// workspace HEAD it covered (.guide/audits/.last-audit.json), the next audit
// scopes to the diff since that SHA. Returns { files, sinceSha, prevAuditFile }
// or null (→ full audit) when: no marker, no prior audit, not a git repo, the
// SHA is gone (force-push/rebase), or the diff exceeds 150 files. Deleting the
// marker forces full scope.
export async function detectIncrementalAudit(projDir, cfg = null) {
  const FULL_AUDIT_FILE_THRESHOLD = 150;
  const auditMarker = await readJson(path.join(auditDir(projDir), '.last-audit.json'));
  const prevAuditFile = await findMostRecentAudit(projDir);
  if (!auditMarker?.sha || !prevAuditFile) return null;
  const ws = path.join(projDir, 'workspace');
  if (!(await isGitRepo(ws))) return null;

  // v0.14.48: force a full re-scan when incremental would otherwise go blind.
  // Incremental scopes to the git diff since the last audit's SHA — but if HEAD
  // hasn't moved, the diff is EMPTY and the audit looks at nothing, so a latent
  // bug in untouched code stays invisible forever (observed on asp: six audits
  // against the same HEAD, each finding nothing). Two triggers force full:
  //   (a) HEAD == last audited SHA (empty diff — incremental is pointless), and
  //   (b) audit.force_full_every_n consecutive incrementals (default 5), so even
  //       a steadily-advancing project gets a periodic whole-tree pass.
  // Either way we return null → caller runs a full audit, which resets the
  // consecutive counter when it stamps.
  const headSha = await getHeadSha(ws);
  if (headSha && auditMarker.sha === headSha) {
    return null; // unchanged HEAD → full re-scan
  }
  const everyN = Number(cfg?.audit?.force_full_every_n);
  // Default 5; explicit 0 disables the periodic full (the unchanged-HEAD full
  // above still always applies). Negative/NaN → default.
  const threshold = Number.isFinite(everyN) && everyN >= 0 ? everyN : 5;
  const consecutive = Number(auditMarker.incremental_streak) || 0;
  if (threshold > 0 && consecutive >= threshold) {
    return null; // periodic full re-scan
  }

  const diff = await changedFilesSince(ws, auditMarker.sha);
  if (!diff.ok || diff.files.length > FULL_AUDIT_FILE_THRESHOLD) return null;
  return { files: diff.files, sinceSha: auditMarker.sha, prevAuditFile };
}

// v0.14.48: shared stamp writer. Records the audited HEAD + an
// incremental_streak counter: incremented after an incremental audit, RESET to
// 0 after a full audit, so force_full_every_n counts consecutive incrementals.
async function stampLastAudit(projDir, sha, { wasIncremental }) {
  let streak = 0;
  if (wasIncremental) {
    const prev = await readJson(path.join(auditDir(projDir), '.last-audit.json'));
    streak = (Number(prev?.incremental_streak) || 0) + 1;
  }
  await fs.mkdir(auditDir(projDir), { recursive: true });
  await fs.writeFile(
    path.join(auditDir(projDir), '.last-audit.json'),
    JSON.stringify({ sha, at: new Date().toISOString(), incremental_streak: streak }, null, 2),
    'utf-8',
  );
}

// ─── v0.14.36: two-stage full audit (Sonnet scan → Opus adjudicate) ─────────
//
// Full audits were one Opus call reading the entire codebase. Split: a Sonnet
// scan reads the codebase and emits CANDIDATE findings with file:line evidence
// to .guide/audits/scan-<ts>.md; one Opus call then adjudicates ONLY that
// candidate list (+ brief + plan) into the final audit — severity, dedupe,
// false-positive kill, promote section. Opus input drops from O(codebase) to
// O(findings), and Opus capacity goes to judgment instead of file traversal.
// Incremental re-audits stay single-call (their input is already small).
// Disable via audit.two_stage:false to restore the single Opus full audit.

// Phase 53 (par-06) — pure greedy bin-packer for the sharded scan stage.
// `files` is the plain `git ls-files` list (cheap, deterministic, gitignore-
// aware — deliberately NOT the repo-map, which may be stale or disabled).
// Files are grouped by top-level directory (a bare filename with no `/`
// lands in the pseudo-group '.'); groups are then greedy-packed (largest
// group first, ties broken by dir name ascending, for a fully deterministic
// assignment) into the smallest-total-so-far bin, capped at `shardCount`
// bins. A group is atomic — never split across shards — so the actual
// returned bin count can be LESS than shardCount (fewer top-level dirs than
// shards, or shardCount<=1) but never more. Pure: no I/O, no Date/Math.random.
export function buildAuditShards({ files, shardCount }) {
  const groups = new Map();
  for (const raw of files || []) {
    const f = String(raw).replace(/\\/g, '/');
    if (!f) continue;
    const slash = f.indexOf('/');
    const dir = slash === -1 ? '.' : f.slice(0, slash);
    if (!groups.has(dir)) groups.set(dir, 0);
    groups.set(dir, groups.get(dir) + 1);
  }
  const entries = [...groups.entries()].map(([dir, fileCount]) => ({ dir, fileCount }));
  entries.sort((a, b) => b.fileCount - a.fileCount || (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));

  const binCount = Math.max(1, Math.min(Number(shardCount) || 1, entries.length || 1));
  const bins = Array.from({ length: binCount }, () => ({ dirs: [], fileCount: 0 }));
  for (const entry of entries) {
    let target = 0;
    for (let i = 1; i < bins.length; i++) {
      if (bins[i].fileCount < bins[target].fileCount) target = i;
    }
    bins[target].dirs.push(entry.dir);
    bins[target].fileCount += entry.fileCount;
  }
  for (const bin of bins) bin.dirs.sort();
  return bins;
}

export function buildAuditScanPrompt({ projectName, projDir, plan, scanOutPath, scopeDirs = null }) {
  const relBrief = path.relative(projDir, activeBriefPath(projDir, plan));
  const relScan = path.relative(projDir, scanOutPath);
  // Phase 53: present only for a shard spawn — absent reproduces today's
  // prompt byte-for-byte (cache discipline for the common, unsharded case).
  const scopeLine = scopeDirs
    ? `\nONLY examine these paths (other shards cover the rest): ${[...scopeDirs].sort().join(', ')}\n`
    : '';
  return `SCAN stage of a two-stage code audit for project "${projectName}". You are the SCANNER, not the judge.

Read:
- workspace/ — every file under backend/ and frontend/
- .guide/plan.json — what was supposed to be built
- .guide/phases/*/report.md — what dev claims it built ("Deviations", "Tech debt added")
- .guide/reviews/after-*.md — what reviewers flagged ("carried tech debt")
- ${relBrief} — requirements, NFRs, definition of done

Emit CANDIDATE findings — anything that might be a real problem. A second-stage adjudicator (stronger model) will judge severity, kill false positives, and write the final audit. Your job is recall: OVER-report borderline items rather than self-censor; do NOT spend effort ranking or polishing.

For each candidate write:

### CAND-<n> — <one-line title>
- Where: <file:line or file:line-range>
- Evidence: (≤6 verbatim lines from the code, fenced)
- Suspicion: <one or two sentences — what failure scenario this enables>
- Severity guess: CRITICAL | MAJOR | MINOR | DEFERRED-OK (a guess, not a verdict)

Rules:
- Evidence must be REAL quoted code with a real path — the adjudicator verifies; fabricated evidence wastes the whole audit.
- Verify report/review claims against actual files; a claim that doesn't match the code IS a candidate.
- Do NOT write a final audit, severity rankings, recommendations, or any "Promote to bugs" section — that is the adjudicator's job, and a promote section here would be machine-parsed by mistake.
- Do NOT use "Bug N"-style headings anywhere (the promote parser scans for them). CAND-<n> only.
${scopeLine}
Output to: ${relScan}
End the file with a line: "candidates: <count>".`;
}

export function buildAuditAdjudicatePrompt({ projectName, projDir, plan, scanOutPath, scanOutPaths = null, auditOutPath }) {
  const relBrief = path.relative(projDir, activeBriefPath(projDir, plan));
  const relOut = path.relative(projDir, auditOutPath);
  // Phase 53: scanOutPaths (plural) lists every shard file for a sharded
  // scan; absent/single-element falls back to today's scanOutPath-only shape
  // byte-for-byte (single-scan callers are unaffected — read-side compat).
  const relScanList = (Array.isArray(scanOutPaths) && scanOutPaths.length ? scanOutPaths : [scanOutPath])
    .map((p) => path.relative(projDir, p));
  const scanIntro = relScanList.length > 1
    ? `A scanner pass has already read the whole codebase across ${relScanList.length} parallel shards and produced candidate findings with quoted evidence at:\n${relScanList.map((p) => `- ${p}`).join('\n')}`
    : `A scanner pass has already read the whole codebase and produced candidate findings with quoted evidence at: ${relScanList[0]}`;
  const scanReadLines = relScanList.length > 1
    ? relScanList.map((p) => `- ${p} — a shard of the candidate list (your primary input)`).join('\n')
    : `- ${relScanList[0]} — the candidate list (your primary input)`;
  return `ADJUDICATION stage of a two-stage code audit for project "${projectName}".

${scanIntro}

Read:
${scanReadLines}
- ${relBrief} — requirements, NFRs, definition of done
- .guide/plan.json — what was supposed to be built

You MAY open individual workspace files, but ONLY to confirm or refute a specific candidate's evidence — keep reads surgical; do not re-scan the codebase.

Produce the FINAL audit:
- Judge each candidate: confirm (assign final severity CRITICAL/MAJOR/MINOR/DEFERRED-OK) or kill as a false positive.
- Merge duplicates (same root cause) into one finding.
- For each confirmed finding include: one-line title, severity, file:line range, what's wrong, why it's wrong (specific failure scenario or attack), suggested fix approach (one paragraph max).
- Include a "## Killed candidates" section: each killed CAND-id with a one-line reason — this is how the scanner gets calibrated.
- If the evidence for a candidate looks fabricated or the file:line doesn't exist, kill it and say so.

Output to: ${relOut}

End with:
1. Top-3 recommendations (most important things to fix)
2. The promote section, per the rules below.

Be honest about what you couldn't verify from the candidates alone.
${AUDIT_PROMOTE_RULES}`;
}

// v0.14.37: fix prompt built directly from the round's plan.json entry +
// pointers to bugs.md — used when no prompt.md exists and inline_fix_prompts
// is on. The /spend data showed fix-prompt-gen writing 5.3M output tokens
// across 505 calls (≈1:1 with fix-execution itself) to mostly restate what
// bugs.md and plan.json already say in canonical format. Paths relative to
// the dev's CWD (workspaceDir).
// Phase 41 (QL-8) — a fix's phaseMeta-shaped pseudo-meta for lessons relevance.
// phaseMeta is falsy for fixes, so loadLessonsBlock/scoreLesson would otherwise
// score every lesson 0 and inject nothing. Kept SEPARATE from the real phaseMeta
// (routing/bookkeeping consume that). Tolerates both the raw fix-plan field name
// `files` (test fixtures) and `files_likely` (guide-system.md canonical) —
// distinct from verify-loop.js's mapFixEntryToPhaseMeta, which is scoped to the
// acceptance-checker shape and maps files_likely only. Pure; no I/O.
export function buildFixLessonMeta(fix, fixEntry) {
  return {
    title: fixEntry?.title || fix?.title || '',
    goal: fixEntry?.goal || '',
    files_expected: fixEntry?.files || fixEntry?.files_likely || [],
  };
}

// Phase 42: hasConventions is an INPUT (see buildInlinePhasePrompt) — a
// false/omitted value reproduces the pre-phase output byte-for-byte.
export function buildInlineFixPrompt({ projectName, fix, fixMeta, projDir, workspaceDir, plan, sourceAuditRel = null, hasConventions = false }) {
  const relBrief = path.relative(workspaceDir, activeBriefPath(projDir, plan));
  const r = fix.round;
  const n = fix.n;
  const entryBlock = fixMeta
    ? `Your fix entry from plan.json (n=${n}):\n\`\`\`json\n${JSON.stringify(fixMeta, null, 2)}\n\`\`\`\n`
    : `(plan.json entry n=${n} could not be read — treat ../.guide/bug-rounds/round-${r}/plan.json as authoritative)\n`;
  const fixCriterion = `Bug(s) covered by fix r${r}-${n} reproduce as fixed per bugs.md's "Expected" behavior`;
  // Phase 41 (CE-9): when a source-audit pointer exists, point the dev at the
  // ORIGINAL audit finding (file:line evidence, failure scenario, suggested
  // approach) BEFORE it diagnoses — the promoted bugs.md summary loses that
  // detail. Exactly ONE read-list line; absent pointer → '' → byte-identical prompt.
  const sourceAuditLine = sourceAuditRel
    ? `\n- ${sourceAuditRel} — the SOURCE audit finding(s) behind this bug: file:line evidence, failure scenario, and suggested approach. Read the finding(s) covering your entry before diagnosing.`
    : '';
  const conventionsLine = hasConventions
    ? `\n- ../.guide/project-conventions.md — durable decisions/conventions grouped by type, plus distilled anti-patterns from prior failures.`
    : '';
  return `# Fix r${r}-${n} — ${fixMeta?.title || fix.title || '(untitled)'}
Project: ${projectName} · bug round ${r}, fix ${n}.

${entryBlock}
## Read before writing code
- ../.guide/bug-rounds/round-${r}/plan.json — the entry with n=${n} is YOUR scope: the bug(s) it covers, affected files, fix approach. Everything else in the round belongs to other fixes.
- ../.guide/bug-rounds/round-${r}/bugs.md — the verbatim bug description(s) your entry covers. Each bug's "Expected" is your acceptance criterion; reproduce per "Steps to reproduce", verify the Expected behavior before committing.
- ${relBrief} — the brief's "Conventions to follow" and "Non-functional requirements" still apply to this fix.
- ../.guide/decisions.jsonl — rolling decisions/conventions from reviews, for context (one JSON object per line; may not exist).
- The existing code you are about to touch — match its patterns.${sourceAuditLine}${conventionsLine}

## Rules
- Fix ONLY what your entry covers. No refactors, no drive-by fixes, no scope creep into other fixes' bugs.
- If the fix approach in plan.json conflicts with what you find in the code, fix the bug correctly and document the deviation in your report.

${buildDefinitionOfDoneBlock([fixCriterion])}

## Commit
One commit when done. Message format: fix-r${r}-${n}: <one-line summary>`;
}

// Phase 70 (brief 05 P5) — the numbered multi-fix prompt for a single-call
// minor-fix batch (bug_cycle.batch_minor_fixes): ONE dev spawn executes
// several consecutive, file-disjoint MINOR fixes and must commit each
// SEPARATELY, in order. Reuses buildInlineFixPrompt's per-fix building blocks
// (entry block, report path, criterion) but wraps N of them under a numbered
// heading, followed by a "Rules"/"Commit contract" block that is pure
// boilerplate (no per-fix interpolation, only `round` — constant for the
// whole batch) so it stays byte-identical regardless of which/how-many fixes
// are in the batch (cache-discipline convention — see
// phase-runner-cache-discipline.test.mjs; this builder is a pure function of
// its inputs, same "byte-identical across calls" contract as
// buildInlineFixPrompt). `fixes` is [{round, n, title, fixMeta}] — fixMeta is
// the round-plan entry for that fix (or null if unreadable).
export async function buildInlineFixBatchPrompt({ projectName, round, fixes, projDir, workspaceDir, plan, hasConventions = false }) {
  const relBrief = path.relative(workspaceDir, activeBriefPath(projDir, plan));
  const conventionsLine = hasConventions
    ? `\n- ../.guide/project-conventions.md — durable decisions/conventions grouped by type, plus distilled anti-patterns from prior failures.`
    : '';

  const sections = [];
  const criteria = [];
  for (let i = 0; i < fixes.length; i += 1) {
    const f = fixes[i];
    const n = f.n;
    const fixMeta = f.fixMeta;
    const entryBlock = fixMeta
      ? `Fix entry from plan.json (n=${n}):\n\`\`\`json\n${JSON.stringify(fixMeta, null, 2)}\n\`\`\`\n`
      : `(plan.json entry n=${n} could not be read — treat ../.guide/bug-rounds/round-${round}/plan.json as authoritative)\n`;
    // eslint-disable-next-line no-await-in-loop
    const reportPath = await fixReportPath(projDir, round, n, fixMeta?.title || f.title);
    const relReport = path.relative(workspaceDir, reportPath);
    const criterion = `Bug(s) covered by fix r${round}-${n} reproduce as fixed per bugs.md's "Expected" behavior`;
    criteria.push(criterion);
    sections.push(
`### Fix ${i + 1}/${fixes.length}: r${round}-${n} — ${fixMeta?.title || f.title || '(untitled)'}
${entryBlock}
- Report path for THIS fix: \`${relReport}\`
- Acceptance criterion: ${criterion}`,
    );
  }

  return `# Single-call fix batch — round ${round}, fixes ${fixes.map((f) => f.n).join(', ')}
Project: ${projectName} · bug round ${round} · ${fixes.length} minor fixes in ONE call.

## Read before writing code
- ../.guide/bug-rounds/round-${round}/plan.json — each entry n=N below is that fix's scope: the bug(s) it covers, affected files, fix approach. Everything else in the round belongs to a different fix.
- ../.guide/bug-rounds/round-${round}/bugs.md — the verbatim bug description(s) each entry covers. Each bug's "Expected" is that fix's acceptance criterion; reproduce per "Steps to reproduce", verify the Expected behavior before committing that fix.
- ${relBrief} — the brief's "Conventions to follow" and "Non-functional requirements" still apply to every fix below.
- ../.guide/decisions.jsonl — rolling decisions/conventions from reviews, for context (one JSON object per line; may not exist).
- The existing code you are about to touch — match its patterns.${conventionsLine}

${sections.join('\n\n')}

## Rules (apply to EVERY fix above)
- Fix ONLY what each entry covers. No refactors, no drive-by fixes, no scope creep into another fix's bugs or files.
- If a fix's approach in plan.json conflicts with what you find in the code, fix the bug correctly and document the deviation in THAT fix's report.
- Work through the fixes strictly IN THE GIVEN ORDER above (1, 2, 3, …). Fully finish, verify, and commit one fix before starting the next.

## Commit contract — hard requirement, no exceptions
- Make exactly ONE commit per fix, in the given order. NEVER combine two or more fixes into a single commit, and never leave a fix uncommitted while starting the next.
- Each commit's subject line MUST be exactly: fix-r${round}-N: <one-line summary> — where N is that fix's own number from its heading above.
- Write EACH fix's completion report to ITS OWN report path (listed under that fix's heading above) before moving on to the next fix.

${buildDefinitionOfDoneBlock(criteria)}`;
}

// Phase 40 (CE-5) — parse the most recent PRIOR review file (the highest
// after-N.md with N < currentPhase) for its verdict/score/blocker outcome,
// reusing tryReviewAutoProceed's exact line-parsing shape (anchored,
// case-insensitive, last-match-wins). Returns a short rendered summary, or
// null when there is no prior review or it carries no parseable outcome.
// Fail-open: an unreadable reviews dir or file yields null, never throws.
async function readPreviousReviewOutcome(projDir, currentPhase) {
  const reviewsDir = path.join(guideRoot(projDir), 'reviews');
  let names;
  try { names = await fs.readdir(reviewsDir); } catch { return null; }
  let bestN = -1;
  for (const nm of names) {
    const m = nm.match(/^after-(\d+)\.md$/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (Number.isFinite(currentPhase) && n >= currentPhase) continue;
    if (n > bestN) bestN = n;
  }
  if (bestN < 0) return null;
  const text = await readText(reviewPath(projDir, bestN));
  if (!text) return null;
  const verdictMatch = [...text.matchAll(/^\s*verdict:\s*(continue|pause-and-fix|replan)\b/gim)].pop();
  const scoreMatch = [...text.matchAll(/^\s*score:\s*(\d+)\b/gim)].pop();
  const hasBlocker = text.split('\n').some((l) => /^BLOCKER:/i.test(l.trim()));
  if (!verdictMatch && !scoreMatch && !hasBlocker) return null;
  const parts = [`Prior review (after phase ${bestN}):`];
  if (verdictMatch) parts.push(`verdict: ${verdictMatch[1]}`);
  if (scoreMatch) parts.push(`score: ${scoreMatch[1]}`);
  if (hasBlocker) parts.push('(contained a BLOCKER line)');
  return parts.join('\n');
}

// Phase 40 (CE-5) — assembles the VOLATILE, per-call review context a fresh,
// task-scoped review session needs in place of the conversation history a
// resumed session would carry: a capped `git diff --stat` since the last
// review, the batch's phase-ledger entries, the decisions tail, the prior
// review's verdict/score, and per-phase report excerpts. Returned as a plain
// string that rides in the per-call `prompt` (NEVER systemPromptExtra — it is
// volatile by construction). Deterministic given the same inputs (no
// Date.now()), every rendered field passing through sanitiseContent or a
// pre-sanitising renderer, wrapped in a single <review_context> tag.
// Fail-open throughout: any missing/unreadable source drops only its own
// sub-block; no last_review_sha yields the documented "first review" note.
// Returns '' when nothing could be assembled (so the caller's template stays
// byte-identical to the flag-off path).
export async function buildReviewContextBlock({ projDir, project, plan, cfg, reviewBatch, reviewPhaseN = null, pinnedWorktree = null }, deps = {}) {
  const diffStatFn = deps.diffStatDetailedSince ?? diffStatDetailedSince;
  // Phase 52 — a pinned worktree (async review pipeline) stands in for the
  // live workspace so the diff-stat below ends exactly at the reviewed
  // phase's commit, never at whatever the live tree has advanced to.
  const workspaceDir = pinnedWorktree || path.join(projDir, cfg?.paths?.workspace_subdir || 'workspace');
  const batch = Array.isArray(reviewBatch) ? reviewBatch : [];
  const parts = [];

  // 1 — diff-stat since the last review (or the documented first-review note).
  const lastReviewSha = parseProjectMetadata(project?.metadata_json).last_review_sha || null;
  if (lastReviewSha) {
    try {
      const res = await diffStatFn(workspaceDir, lastReviewSha);
      if (res?.ok && res.text.trim()) {
        const capped = res.text.split('\n').slice(0, 80).join('\n');
        parts.push(`Changed since the last review (\`git diff --stat ${lastReviewSha.slice(0, 8)}..HEAD\`, capped 80 lines):\n${sanitiseContent(capped, 8000)}`);
      }
    } catch { /* fail-open — drop only this sub-block */ }
  } else {
    parts.push('First review — no prior review recorded for this project. There is no diff to scope from; read the workspace directly.');
  }

  // 2 — the batch's phase-ledger entries (what these phases built).
  const batchNs = new Set(batch.map((p) => p.n));
  const ledgerContent = await readText(phaseLedgerPath(projDir));
  if (ledgerContent) {
    const entries = parsePhaseLedgerJsonl(ledgerContent)
      .filter((e) => batchNs.size === 0 || batchNs.has(e.n));
    if (entries.length) {
      parts.push(`What the phases in this batch built (phase ledger):\n${entries.map(renderLedgerEntry).join('\n')}`);
    }
  }

  // 3 — decisions tail (last ~10, same renderer the dev prompt uses).
  const decisionsContent = await readText(path.join(guideRoot(projDir), 'decisions.jsonl'));
  if (decisionsContent) {
    const decisions = parseDecisionsJsonl(decisionsContent, 10);
    if (decisions.length) {
      parts.push(`Recent durable decisions (tail):\n${decisions.map(renderDecisionLine).join('\n')}`);
    }
  }

  // 4 — the previous review's verdict/score outcome.
  const prevOutcome = await readPreviousReviewOutcome(projDir, reviewPhaseN ?? project?.current_phase);
  if (prevOutcome) parts.push(prevOutcome);

  // 5 — per-phase report excerpts (first 60 lines each, sanitised).
  for (const p of batch) {
    const rp = await phaseReportPath(projDir, p.n, p.title);
    const rt = await readText(rp);
    if (rt && rt.trim()) {
      const excerpt = rt.split('\n').slice(0, 60).join('\n');
      parts.push(`Report excerpt — phase ${p.n} (${sanitiseContent(String(p.title ?? ''), 120)}), first 60 lines:\n${sanitiseContent(excerpt, 6000)}`);
    }
  }

  if (!parts.length) return '';
  return `
<review_context>
The context below is assembled from durable on-disk artifacts (git diff, phase ledger, decisions, prior review, phase reports) — read full files only where the diff or reports raise questions.

${parts.join('\n\n')}
</review_context>`;
}

// Phase 40 (CE-5) — assembled, VOLATILE per-call context for a fresh,
// task-scoped bug-plan session: the bug report inlined verbatim (capped ~12k
// chars, sanitised) plus the plan's phase list (n, title, files_expected) for
// cross-referencing fixes. Rides in the per-call `prompt`, same rationale as
// buildReviewContextBlock. Fail-open; returns '' when nothing could be
// assembled so the flag-off template stays byte-identical.
export async function buildBugPlanContextBlock({ projDir, plan, round }) {
  const parts = [];
  const bugsText = await readText(bugsFilePath(projDir, round));
  if (bugsText && bugsText.trim()) {
    parts.push(`Bug report (bugs.md, verbatim, capped ~12k chars):\n${sanitiseContent(bugsText, 12000)}`);
  }
  const phases = Array.isArray(plan?.phases) ? plan.phases : [];
  if (phases.length) {
    const list = phases.map((p) => {
      const files = Array.isArray(p.files_expected) && p.files_expected.length
        ? ` — files: ${sanitiseContent(p.files_expected.join(', '), 400)}`
        : '';
      return `- Phase ${p.n}: ${sanitiseContent(String(p.title ?? ''), 120)}${files}`;
    }).join('\n');
    parts.push(`Plan phases (for cross-referencing fixes to the phases that introduced them):\n${list}`);
  }
  if (!parts.length) return '';
  return `

<bug_plan_context>
The context below is assembled from durable on-disk artifacts (bug report, plan) — read full files only where the bug report or plan raise questions.

${parts.join('\n\n')}
</bug_plan_context>`;
}

export async function buildGuidePrompt({
  task, projectName, projDir, project, plan, brief, round, fix, cfg = null, handoffOutPath = null, auditIncremental = null,
  reviewMode = null, reviewBatch = null, reviewPhaseN = null, pinnedWorktree = null,
}) {
  // Mirror the next-phase logic from pickNextAction so non-sequential plan
  // numbering (continuation plans) gets the correct phase directory.
  const _nextPhaseMeta = plan?.phases?.find((p) => p.n > project.current_phase) || null;
  const phaseN = _nextPhaseMeta?.n ?? (project.current_phase + 1);

  // NOTE: the set of cases below is mirrored in src/lib/guide-tasks.js
  // (KNOWN_GUIDE_TASKS / QUEUE_SAFE_GUIDE_TASKS). If you add or rename a task
  // here, update that registry too — the Telegram /run --task validator uses it.
  switch (task) {
    case 'plan': {
      // Use the true highest completed phase number so continuation plans number
      // correctly even when current_phase lags (e.g. old pipeline phases in DB
      // or a reset that didn't clear all rows). This prevents the guide from
      // skipping numbers — if DB has phases 1-4 completed and current_phase=0,
      // the guide still knows to start at 5, not 1.
      const allPhases        = getPhases(projectName);
      const highestDbPhase   = allPhases.reduce((max, p) => Math.max(max, p.n), 0);
      const highestPlanPhase = (plan?.phases || []).reduce((max, p) => Math.max(max, p.n), 0);
      const trueLastPhase    = Math.max(project.current_phase || 0, highestDbPhase, highestPlanPhase);
      const continuationCtx  = trueLastPhase > 0
        ? `\nContinuation context: this is a CONTINUATION PLAN (Pass 2+). The highest phase number already used across DB + plan is ${trueLastPhase}. Number the new plan's phases starting at ${trueLastPhase + 1} — do NOT restart at 1 and do NOT skip numbers. The orchestrator finds the next phase via plan.phases.find(p => p.n > current_phase); restarting at 1 or leaving gaps would cause phases to appear already done or unreachable.\n`
        : '';
      // v0.14.36: regeneration hint — written by the post-plan structural
      // validator or the coverage gate when the previous plan failed. Cleared
      // after a plan passes validation.
      let planFixCtx = '';
      try { planFixCtx = await fs.readFile(path.join(projDir, '.guide', 'plan-fix.hint'), 'utf-8'); } catch { /* no hint */ }
      const planFixBlock = planFixCtx.trim()
        ? `\nPLAN REGENERATION — the previous plan FAILED validation. You MUST fix these specific problems in the regenerated plan:\n${planFixCtx.trim()}\n`
        : '';
      const relPlanJson = path.relative(projDir, path.join(projDir, '.guide', 'plan.json'));
      const relPlanMd = path.relative(projDir, path.join(projDir, '.guide', 'plan.md'));
      return `Create a phase-by-phase development plan for project "${projectName}".
${continuationCtx}${planFixBlock}
Tech stack: ${project.tech_stack || '(not specified)'}

Brief:
${brief || '(read .guide/brief.md if present, otherwise read inputs/)'}

Output paths (relative to your cwd, which MUST be the project directory):
- ${relPlanJson} (machine-readable)
- ${relPlanMd} (human-readable)`;
    }

    case 'next-prompt': {
      const meta = plan?.phases?.find((p) => p.n === phaseN);
      const dir = await phaseDir(projDir, phaseN, meta?.title);
      const promptOut = path.join(dir, 'prompt.md');
      const reportOut = path.join(dir, 'report.md');
      const relBrief = path.relative(projDir, activeBriefPath(projDir, plan));
      return `Generate the phase-${phaseN} prompt for project "${projectName}".

Read:
- .guide/plan.json (phase ${phaseN})
- ${relBrief} — re-read the brief, especially "Non-functional requirements", "Conventions to follow", and "Gotchas" — surface any constraints relevant to this phase explicitly in the prompt you write
- .guide/decisions.jsonl — rolling decisions from reviews, for context (one JSON object per line; may not exist on early phases)
- workspace/ current state
- recent .guide/phases/*/report.md files for decisions made so far

Write the prompt to: ${path.relative(projDir, promptOut)}
The dev will write its report to: ${path.relative(projDir, reportOut)}
Commit message format: phase-${phaseN}: <one-line summary>`;
    }

    case 'review': {
      // Phase 36 (panel review): lens 1 IS this exact call (resumed guide
      // session, role:'guide', the decisions.jsonl append below unchanged) —
      // the ONLY difference in panel mode is where it writes. runReviewPanel
      // (phase-runner.js) reads this same lens-1 file back off disk after
      // this call returns, so the two paths must always agree.
      // Phase 52 (par-03, verdict correction 2): prefer the EXPLICIT target
      // over current_phase — an overlapped dev that finishes phase N+1 (or
      // beyond) while this review is still in flight for phase N must never
      // shift where the review reads/writes.
      const targetPhaseN = reviewPhaseN ?? project.current_phase;
      const out = reviewMode === 'panel'
        ? reviewLensPath(projDir, targetPhaseN, 1)
        : reviewPath(projDir, targetPhaseN);
      const relBriefReview = path.relative(projDir, activeBriefPath(projDir, plan));
      // Phase 40 (CE-5): a fresh, task-scoped review session has no
      // conversation history to lean on, so it gets the assembled context
      // instead (volatile — rides in this per-call prompt, NEVER
      // systemPromptExtra). Gated on the SAME flag runGuide uses to make the
      // session fresh/roleless, so a resumed (flag-off) review's prompt stays
      // byte-identical to today's.
      const reviewCtx = (cfg?.guide_context?.fresh_task_sessions !== false)
        ? await buildReviewContextBlock({ projDir, project, plan, cfg, reviewBatch, reviewPhaseN: targetPhaseN, pinnedWorktree })
        : '';
      // Phase 52 — pinnedWorktree (set only by the async review pipeline)
      // stands in for workspace/ in the read instructions below: the guide's
      // cwd is projDir, and .worktrees/ is a sibling of workspace/ under it,
      // so this path is reachable the same way workspace/ always was. A
      // non-pinned call (every caller before this phase, and every
      // synchronous review today) keeps the literal 'workspace/' text —
      // byte-identical prompt.
      const codeRoot = pinnedWorktree ? `${path.relative(projDir, pinnedWorktree)}/` : 'workspace/';
      const pinnedNote = pinnedWorktree
        ? `\nThis review's code root is pinned to phase ${targetPhaseN}'s commit (read code under ${codeRoot}, NOT workspace/ — a later phase may already be in flight there).\n`
        : '';
      return `Conduct a review for project "${projectName}" at phase ${targetPhaseN}.
${pinnedNote}
Read .guide/plan.json, ${relBriefReview} (original requirements + definition of done), ${codeRoot}, recent .guide/phases/*/report.md files.
Write to: ${out}
The path above is absolute and exact; do not shorten or reinterpret it.
Do not write the review beneath ${codeRoot}. The review is orchestrator state, not workspace code.
${reviewCtx}
${buildDecisionsAppendInstruction(targetPhaseN)}

${REVIEW_VERDICT_SCORE_BLOCK}`;
    }

    case 'handoff': {
      // Phase 20 (brief P3): prefer the path the caller already committed to
      // (runGuide computes it once and reuses it post-call to append the
      // commit anchor) — a bare handoffPath(projDir) here would mint a
      // second, different timestamp than the one runGuide captured.
      const out = handoffOutPath || handoffPath(projDir);
      // Phase 87 (brief 05 P5a): ONE extra STATIC prompt section — the handoff
      // task ALSO writes .guide/qa-journeys.json, the DoD-derived journey list the
      // runtime-qa agent walks. Static (no interpolation beyond the already-volatile
      // handoff path/phase), and writing under .guide/ is the guide's own job.
      return `Write a handoff document for project "${projectName}" at phase ${project.current_phase}.

Write to: ${path.relative(projDir, out)}
Follow prompts/handoff-template.md structure. The next guide reads only this file.

ALSO write .guide/qa-journeys.json — a JSON array of the end-to-end QA journeys derived from the brief's "Definition of done": [{ "name": "<short journey name>", "steps": ["<step>", "..."] }]. Each journey is a concrete user-facing path a runtime-QA agent can walk by launching the app and probing it (curl for a server/API, direct invocation for a CLI). Base them on the Definition-of-done items in the active brief; keep steps observable (a command to run, an endpoint to hit, an output to check). Write valid JSON only (no comments, no trailing commas). If the brief has no Definition-of-done section, write [].`;
    }

    case 'bug-plan': {
      const relBriefBug = path.relative(projDir, activeBriefPath(projDir, plan));
      // Phase 40 (CE-5): a fresh, task-scoped bug-plan session gets the bug
      // report + plan phase list inlined (volatile — this per-call prompt,
      // never systemPromptExtra). Gated on the same flag runGuide uses to make
      // the session fresh/roleless, so a resumed (flag-off) bug-plan's prompt
      // stays byte-identical to today's.
      const bugCtx = (cfg?.guide_context?.fresh_task_sessions !== false)
        ? await buildBugPlanContextBlock({ projDir, plan, round })
        : '';
      return `Plan a bug-fix round for project "${projectName}", round ${round}.

Read ${path.relative(projDir, bugsFilePath(projDir, round))} — the bug report.
Read ${relBriefBug} — all fixes must still satisfy the NFRs, Conventions, and Gotchas from the original brief.
Read workspace/ and .guide/plan.json for context.

Write:
- ${path.relative(projDir, fixPlanJsonPath(projDir, round))} — structured fix plan
- ${path.relative(projDir, fixPlanMdPath(projDir, round))} — human-readable summary

Group related bugs (same root cause). Order by severity. Mark out-of-scope explicitly.${bugCtx}`;
    }

    case 'fix-prompt': {
      const fixPlan = await readJson(fixPlanJsonPath(projDir, fix.round));
      const fixMeta = (fixPlan?.fixes || []).find((f) => f.n === fix.n);
      const dir = await fixDir(projDir, fix.round, fix.n, fixMeta?.title);
      const promptOut = path.join(dir, 'prompt.md');
      const reportOut = path.join(dir, 'report.md');
      const relBriefFix = path.relative(projDir, activeBriefPath(projDir, plan));
      return `Generate the fix prompt for round ${fix.round}, fix ${fix.n} of project "${projectName}".

Read .guide/bug-rounds/round-${fix.round}/plan.json (the fix with n=${fix.n}).
Read .guide/bug-rounds/round-${fix.round}/bugs.md for verbatim bug descriptions.
Read ${relBriefFix} — the brief's Conventions and Non-functional requirements must still be met by this fix.
Read workspace/.

Write to: ${path.relative(projDir, promptOut)}
The dev will write its report to: ${path.relative(projDir, reportOut)}
Commit format: fix-r${fix.round}-${fix.n}: <one-line summary>`;
    }

    case 'workspace-claude-md':
      return `Generate workspace/CLAUDE.md for project "${projectName}".

Read .guide/brief.md, .guide/plan.json, workspace/. Write to workspace/CLAUDE.md.
Include: tech stack conventions, key files/patterns to reuse, anti-patterns, intro paragraph. Under 100 lines. Skip basics.
If workspace/CLAUDE.md exists, leave it and write a summary to .guide/workspace-claude-md-skipped.md.

Note: workspace/.claude/skills/{phase-report,commit-conventions,orchestrator-context}/SKILL.md and workspace/.claude/settings.json's git-push deny rule are materialized separately by the orchestrator (deterministic, not part of this call) — do not create, edit, or duplicate them.`;

    case 'lessons-distill': {
      const out = lessonsDistilledPath(projDir);
      // Phase 80 (brief 05 P3): the ## GENERAL section rides on this SAME distill
      // call (zero extra LLM calls). GENERAL_SECTION_INSTRUCTION is a STATIC,
      // byte-identical block — appended only when global lessons are enabled, so
      // a disabled project's prompt stays byte-identical to pre-phase-80.
      const generalSection = cfg?.lessons?.global?.enabled !== false ? GENERAL_SECTION_INSTRUCTION : '';
      return `Distill accumulated failure lessons for project "${projectName}".

Read .guide/lessons.jsonl — one JSON object per line, each a captured lesson from a prior heal/reprompt/escalation/validator-fail/verify-fail/stall event: { ts, kind, phase, fix, source, lesson, files }.

Group entries by kind and by recurring root cause ("gotcha") — e.g. "validator-fail: missing test script keeps tripping the default gate" rather than one bullet per occurrence. For each group, write a compressed summary: what kept failing, the pattern behind it, and how to avoid it going forward. Drop one-off noise; keep only patterns useful to a future dev/guide session.

Write to: ${path.relative(projDir, out)} — capped at 150 lines total, grouped under headings per kind.

Do NOT modify .guide/lessons.jsonl — the orchestrator truncates the entries this distillation covered after this task completes.${generalSection}`;
    }

    case 'brief-author': {
      // Brief author reads raw-thoughts and produces structured brief
      const raw = await readText(rawThoughtsPath(projDir));
      const tplPath = path.join(PROMPTS_DIR, 'templates', 'brief-template.md');
      const tpl = await readText(tplPath);
      return `Author a structured brief for project "${projectName}".

The user has written rough thoughts at: .guide/raw-thoughts.md

Raw thoughts content:
\`\`\`
${raw || '(file empty or missing — ask user to populate raw-thoughts.md)'}
\`\`\`

Project context:
- Name: ${projectName}
- Tech stack: ${project.tech_stack || '(not specified)'}
- Workspace state: ${(await fileExists(path.join(projDir, 'workspace')))
        ? 'existing code present — read workspace/ to understand current state and conventions'
        : 'greenfield — no existing code'}

Template structure to follow:
\`\`\`
${tpl || '(template not found at prompts/templates/brief-template.md — use standard brief sections)'}
\`\`\`

Output two files:
1. .guide/brief.md — the structured brief, ready for "go" to consume. Fill in everything you can infer from raw-thoughts + workspace.
2. .guide/brief-questions.md — your clarifying questions. List the things the user must answer before this brief is plan-ready. Be specific. Each question should reference where it would change the brief (e.g., "Section 'Functional Requirements': do you want the ability to schedule recurring invoices?").

Style:
- Stay technical and concise. The user is a senior engineer; skip intro/explanatory text.
- If raw thoughts are vague, do NOT invent requirements. Mark sections you couldn't fill with "[NEEDS USER INPUT — see brief-questions.md]" pointers.
- Reference existing files in workspace/ where relevant ("extends backend/controllers/invoiceController.js").
- Include "Out of scope" explicitly even if user didn't mention it — guesses are OK if marked as guesses.`;
    }

    case 'audit': {
      const out = auditPath(projDir);
      const relBriefAudit = path.relative(projDir, activeBriefPath(projDir, plan));
      const relOut = path.relative(projDir, out);

      // v0.14.36: incremental detection + promote rules hoisted to module level
      // (AUDIT_PROMOTE_RULES / detectIncrementalAudit) so the two-stage audit
      // path in runGuide shares them. Behavior here is unchanged from v0.14.34.
      // Phase 32: detection now runs exactly ONCE in runGuide, hoisted above
      // resolveConfig/routeModel — threaded in here as `auditIncremental`
      // instead of re-detected (the prior second call here was a latent
      // TOCTOU: the workspace could theoretically change between the two
      // detectIncrementalAudit calls in the same runGuide invocation).
      const incremental = auditIncremental;

      if (incremental) {
        const relPrev = path.relative(projDir, incremental.prevAuditFile);
        const shortSha = incremental.sinceSha.slice(0, 8);
        const fileList = incremental.files.length
          ? incremental.files.map((f) => `- workspace/${f}`).join('\n')
          : '(no files changed since the last audit — verification-only pass)';
        console.log(chalk.dim(`  → Incremental audit: ${incremental.files.length} file(s) changed since ${shortSha} (prior audit: ${path.basename(incremental.prevAuditFile)})`));
        return `Conduct an INCREMENTAL re-audit of project "${projectName}".

A full audit was completed previously (${relPrev}) at workspace commit ${shortSha}. Fix rounds and/or new phases have changed the files listed below since then. Your job is FIX VERIFICATION + REGRESSION DETECTION in the changed surface — not a full re-scan. Do not re-report findings on unchanged code that the previous audit already classified.

Scope:
1. Read the previous audit: ${relPrev}. For EVERY CRITICAL and MAJOR finding in it, verify against the current code whether it is actually fixed. Verdict per finding: fixed / still open / partially fixed — each with file:line evidence from the current code, not from fix reports.
2. Audit these changed files (and only these) for NEW issues introduced since ${shortSha}:
${fileList}
3. For a changed file, also check its direct callers/callees IF the change altered a function signature, return shape, schema, or error contract — otherwise stay inside the changed set.

Read for context (do not re-audit):
- .guide/plan.json
- ${relBriefAudit} — NFRs and definition of done still apply to every fix
- .guide/bug-rounds/round-*/fixes/*/report.md — the newest round's fix reports (what the fixes CLAIM; verify, don't trust)

Categorize findings into:
- CRITICAL: security holes, data loss risks, regulatory violations, runtime crashes on common paths
- MAJOR: incorrect business logic, missing auth checks, race conditions, broken acceptance criteria
- MINOR: code smells, dead code, test gaps, accessibility issues
- DEFERRED-OK: tech debt that's documented and acceptable to ship

For each finding include: one-line title, severity, file:line range, what's wrong, why it's wrong (specific failure scenario), suggested fix approach (one paragraph max).

A prior finding that is STILL OPEN or only PARTIALLY FIXED keeps its original severity and goes back into the promote section.

Output to: ${relOut}

End with:
1. A "Prior findings verification" section — every prior CRITICAL/MAJOR with its verdict and evidence.
2. Top-3 recommendations.
3. The promote section, per the rules below.
${AUDIT_PROMOTE_RULES}`;
      }

      return `Conduct a comprehensive code audit of project "${projectName}".

This is not a phase-fidelity review — it's a correctness audit. Look for bugs the user might have missed during manual QA.

Read:
- workspace/ — every file under backend/ and frontend/
- .guide/plan.json — what was supposed to be built
- .guide/phases/*/report.md — what dev claims it built (look for "Deviations" and "Tech debt added" sections)
- .guide/reviews/after-*.md — what reviewers flagged (especially "carried tech debt" notes)
- ${relBriefAudit} — original requirements, non-functional requirements, and definition of done

Categorize findings into:
- CRITICAL: security holes, data loss risks, regulatory violations, runtime crashes on common paths
- MAJOR: incorrect business logic, missing auth checks, race conditions, broken acceptance criteria
- MINOR: code smells, dead code, test gaps, accessibility issues
- DEFERRED-OK: tech debt that's documented and acceptable to ship

For each finding include:
- One-line title
- Severity
- File:line range (or "Multiple" if scattered)
- What's wrong
- Why it's wrong (specific failure scenario or attack)
- Suggested fix approach (one paragraph max)

Be skeptical. Read code, not just reports. Verify claims in reports against actual files. Especially check:
- Items reviewers flagged as "carried tech debt" that may still be open
- "Deviations from prompt" sections — were the deviations justified?
- Acceptance criteria marked as met — actually met?
- Tests that exist — do they actually test what they claim?
- Error handling — what happens on the unhappy paths?
- Auth/business-id scoping — every controller actually scoped correctly?

Output to: ${relOut}

End with:
1. Top-3 recommendations (most important things to fix)
2. The promote section, per the rules below.

Be honest about what you couldn't verify (e.g., "External NSDL FVU validator not run; field positions may still drift").
${AUDIT_PROMOTE_RULES}`;
    }

    case 'roadmap': {
      const out = roadmapPath(projDir);
      return `Generate a roadmap of next implementations for project "${projectName}".

This is forward-looking: given what's been built, what should come next?

Read:
- workspace/ — current state
- .guide/plan.json — original plan
- .guide/brief.md — original scope and explicit out-of-scope items
- .guide/phases/*/report.md — "For the next phase" sections often contain followup ideas
- .guide/reviews/after-*.md — "Tech debt" sections often suggest future work
- .guide/bug-rounds/round-*/plan.md if any — what bugs surfaced may suggest preventive features

Consider also:
- Natural extensions of the current module (related features the user mentioned would be "out of scope for now")
- Tech debt items significant enough to deserve their own project
- Integration opportunities with the operator's other projects, if the brief or project context names them
- User-facing gaps in current functionality

For each suggestion include:
- Title
- One-paragraph description
- Scope estimate: S (1-2 phases) / M (3-5 phases) / L (6-9 phases) / XL (multiple modules)
- Priority: high / medium / low — with one-line rationale (why now or why later)
- Dependencies: what must ship first (current module's bug rounds, other modules, external APIs)
- Risks: anything that makes this harder than it looks

Order suggestions: high priority first, then medium, then low. Within priority level, order by least-dependency-first (so user can start something immediately).

Output to: ${path.relative(projDir, out)}

End with:
- A "How to accept a suggestion" footer pointing user to: npm run roadmap-accept -- ${projectName} --item N --new-project <name>

Suggestions should fit the project's stack and domain as described in the brief and project context. Avoid generic "add monitoring" type suggestions — be specific.`;
    }

    case 'project-context-gen': {
      const out = projectContextPath(projDir);
      const briefText = await readText(briefPath(projDir));
      const rawText = await readText(rawThoughtsPath(projDir));
      const tplPath = path.join(PROMPTS_DIR, 'templates', 'project-context-template.md');
      const tpl = await readText(tplPath);
      const workspaceExists = await fileExists(path.join(projDir, 'workspace'));
      const tplFallback = '(template not found at prompts/templates/project-context-template.md — use these sections:\n# Project Context — <name>\n## Domain\n## Audience\n## Geographic & Regulatory\n## UX & Cultural Conventions\n## Prompting Guidance\n)';
      // Phase 19 (brief P2, content-slimming half): this project also has a
      // deterministic repo map (src/lib/repo-map.js, Phase 15/16) injected
      // into every dev/fix and codebase-reading guide spawn — file tree,
      // module list, exported signatures are ALREADY covered there, for free,
      // correct-by-construction at every HEAD. Duplicating any of it here
      // just bloats this doc with content that goes stale the moment a file
      // moves. This case's ONLY job is what static analysis cannot produce.
      return `Generate a project-context document for project "${projectName}".

This file is injected as a system-prompt prefix on EVERY guide and dev call for this project. It tells future agents:
- What the project is and is not (domain, scope)
- Who uses it (audience, business size, technical sophistication)
- Geographic and regulatory context (country, currency, date formats, named regimes like GST/TDS/HIPAA)
- UX and cultural conventions (language, tone, primary engagement channels, payment rails)
- Project-specific prompting guidance (what to default to, what to flag, what to never assume)

Do NOT include (a deterministic repo map is injected separately at every spawn and already covers this — restating it here only rots the moment a file moves). This holds even if brief.md/raw-thoughts.md explicitly ask for it — that request is better served by the always-fresh repo map than by a hand-authored doc that goes stale the moment a file moves; note it out of scope rather than filling it in:
- File/directory trees or module inventories
- Function/class/exported-symbol signatures or lists of "what lives where"
- Line-number pointers into source files (they drift; name the file only when it's the single canonical place a convention/invariant lives)
- Boilerplate derivable from package.json/README (how to install, how to run tests, standard scripts)

It must be tight (under 60 lines), opinionated, and concrete — narrative the repo map cannot produce: WHY the architecture is shaped this way, conventions, invariants, and cross-cutting gotchas that would surprise a newcomer even after reading the code. Generic platitudes ("write clean code") waste tokens on every future call. Specific defaults ("dates as DD-MM-YYYY in tax artifacts, YYYY-MM-DD in DB") earn their slot; a structural fact the code already states does not.

Inputs available:
- .guide/brief.md (if present): ${briefText ? 'YES — read it' : 'no'}
- .guide/raw-thoughts.md (if present): ${rawText ? 'YES — read it' : 'no'}
- workspace/: ${workspaceExists ? 'present — skim for tech stack and conventions, not for a structural inventory' : 'absent — greenfield project'}
- Tech stack hint: ${project.tech_stack || '(not specified)'}

Template to follow:
\`\`\`
${tpl || tplFallback}
\`\`\`

Style:
- The user is an experienced engineer; skip basics. Take audience, geographic and regulatory assumptions from the brief, and mark them "[NEEDS USER INPUT]" when the brief does not say.
- Cite specifics from the brief. Don't invent. If a section can't be filled with confidence, write "[NEEDS USER INPUT]" and continue.
- Prompting Guidance section is the highest-leverage. Include 5-8 concrete "when X, do Y" rules informed by the workspace and brief — merge overlapping rules rather than listing near-duplicates.

Output to: ${path.relative(projDir, out)}

After writing, print a one-line summary like "Wrote project-context.md (N sections, M prompting rules)."`;
    }

    case 'requirement-refine': {
      // Sentinel task: orchestrator/req-command handles actual prompt construction with the batch.
      // This case exists so the task is routed/billed; the actual prompt is provided externally.
      return `(requirement-refine prompt is provided directly by the orchestrator at call time)`;
    }

    case 'plan-validate': {
      const coverageOut = path.join(guideRoot(projDir), 'plan-coverage.md');
      const relBriefPV = path.relative(projDir, activeBriefPath(projDir, plan));
      return `Validate plan coverage for project "${projectName}".

Read ${relBriefPV} and .guide/plan.json.

For every numbered functional requirement in the brief, find which plan phase(s) address it.
If the brief has no numbered FRs, validate that the phases collectively deliver the Goal and Definition of Done.

Write to: ${path.relative(projDir, coverageOut)}

Use this exact format:

## FR Coverage

| FR | Requirement (short) | Phase(s) | Status |
|----|---------------------|----------|--------|
| FR1 | ... | Phase 5 | ✅ Covered |
| FR2 | ... | Phase 5, 6 | ⚠️ Partial — note what's missing |
| FR3 | ... | — | ❌ Not covered |

## Verdict

End the file with EXACTLY one of:
- CLEAR — all requirements are covered or partially covered. Proceed to phase execution.
- BLOCKER: FR{N}, FR{N} have no covering phase — replan before executing.

The verdict line is machine-parsed. It must start the line with "CLEAR" or "BLOCKER:".
Do NOT add markdown formatting (bold, code) around it.`;
    }

    default:
      throw new Error(`Unknown task: ${task}`);
  }
}

// v0.14.51: exported so test suites can verify the <validation_failure> wrapper
// and sanitisation logic without invoking the full runDev() machinery.
export function _buildValidationFailureBlock(raw, isfix) {
  return `\n\n<validation_failure>\nA prior run of this ${isfix ? 'fix' : 'phase'} committed, but the post-commit validators failed (the commit is still in the workspace — fix FORWARD, do not revert unrelated work):\n\n\`\`\`\n${sanitiseContent(raw.trim(), 4000)}\n\`\`\`\n\nMake the validators pass, then commit.\n</validation_failure>`;
}

export async function loadProjectContextBlock(projDir) {
  const content = await readText(projectContextPath(projDir));
  if (!content || !content.trim()) return null;
  // Phase 22 (brief P3, front-matter-leak fix): project-context.md may carry
  // phase-17's stamped `{ generated_at_sha, generated_at }` front-matter
  // (stampArtifact runs on it after every project-context-gen call) — that's
  // orchestrator bookkeeping for contextDelta's sinceSha, never meant to be
  // read by the guide/dev agent. Same parseStampFrontMatter pattern
  // loadContextDeltaBlock already uses above: a legacy/unstamped artifact has
  // no front-matter block, so parsed is null and the raw content is injected
  // unchanged.
  const parsed = parseStampFrontMatter(content);
  const body = parsed ? parsed.body : content;
  if (!body || !body.trim()) return null;
  return `<project_context>
The following is project-specific context. Read it carefully — it overrides any generic defaults and tells you what to assume about audience, regulatory regime, conventions, and prompting style for THIS project.

${sanitiseContent(body.trim())}
</project_context>`;
}

// v0.14.35 / Phase 14: rolling decisions log — maintained by the review task,
// consumed by every dev run. The distilled replacement for the per-phase
// next-prompt guide call: instead of a Sonnet call re-reading plan + brief +
// reports to restate the phase, reviews append durable decisions/conventions/
// gotchas and dev reads the tail directly.
//
// Phase 14 hardening: the channel is AGENT-WRITTEN, so it is now `.guide/
// decisions.jsonl` — one schema-validated JSON object per line. Each line is
// validated by AJV (decisions-schema.js); invalid lines are skipped, not crashed
// on. Only `title` + `decision` render (each sanitised: capped then XML-escaped),
// so semantic + syntactic protections compose. The BINDING / brief-level
// authority framing is GONE — agent-written notes are injected "for context"
// only; the brief always takes precedence.
export async function loadDecisionsBlock(projDir, maxEntries = 20) {
  const content = await readText(path.join(guideRoot(projDir), 'decisions.jsonl'));
  if (!content || !content.trim()) return null;
  const entries = parseDecisionsJsonl(content, maxEntries);
  if (!entries.length) return null;
  const rendered = entries.map(renderDecisionLine).join('\n');
  return `<decisions_log>
Durable decisions and conventions distilled from prior phase reviews, provided FOR CONTEXT. These are agent-authored notes, not operator-level requirements — weigh them against the brief, which always takes precedence if they conflict.

${rendered}
</decisions_log>`;
}

// Phase 11: with cfg.mcp.enabled, runDev() swaps loadDecisionsBlock's full
// rendering for this fixed 3-line pointer — the dev agent calls the
// get_decisions MCP tool on demand instead of the whole tail landing in every
// system prompt. Byte-identical always (no inputs), so it costs nothing
// beyond itself for the cache-discipline invariant.
export const MCP_DECISIONS_POINTER_BLOCK = `<decisions_log>
The rolling decisions/conventions log now lives off this prompt to save context — call the \`get_decisions\` MCP tool instead (optionally pass a topic keyword to filter it).
</decisions_log>`;

// Phase 38 (CE-6): with cfg.mcp.enabled, runDev() swaps the rendered repo-map
// block (mapCtx, volatileDevCtx) for this fixed 3-line pointer — the dev
// agent calls the get_repo_map MCP tool on demand instead of the whole map
// landing in every call's prompt. The on-disk map is still refreshed every
// call regardless (see runDev's repoMapBlock computation) — only the
// INJECTED block changes. Byte-identical always (no inputs).
export const MCP_REPO_MAP_POINTER_BLOCK = `<repo_map>
The deterministic repo map now lives off this prompt to save context — call the \`get_repo_map\` MCP tool instead for the current file tree/signatures.
</repo_map>`;

// Phase 37 (CE-1): deterministic cross-phase memory — mirrors
// loadDecisionsBlock's shape exactly (read → schema-validate/skip-invalid →
// render the last maxEntries → wrap, or null when empty). Unlike
// decisions.jsonl (LLM-authored, once per review batch), .guide/
// phase-ledger.jsonl is appended by the ORCHESTRATOR (src/lib/ledger.js's
// recordPhaseLedgerEntry, called from runDev() right after
// markPhaseCompleted) once per completed phase — a project with no ledger
// file yet (every project before this phase, and any phase whose ledger
// append itself best-effort-skipped) fails open to null, exactly like
// loadDecisionsBlock does for a missing decisions.jsonl.
export async function loadPhaseLedgerBlock(projDir, maxEntries = 8) {
  const content = await readText(phaseLedgerPath(projDir));
  if (!content || !content.trim()) return null;
  const entries = parsePhaseLedgerJsonl(content, maxEntries);
  if (!entries.length) return null;
  const rendered = entries.map(renderLedgerEntry).join('\n');
  return `<phase_ledger>
What prior phases built — agent-authored, brief takes precedence if they conflict.

${rendered}
</phase_ledger>`;
}

// Phase 80 (brief 05 P3) — the sanitised render of selected cross-project
// global lessons. Sanitise runs AGAIN here (the write side already sanitised in
// finalizeDistillation) — cross-project agent-authored content is a
// prompt-injection surface and the brief mandates both passes. Deterministic
// for a given selection (order + sanitise are pure), so it never busts the
// prompt cache. Returns '' for an empty selection.
function renderGlobalLessonLines(selected) {
  return (Array.isArray(selected) ? selected : [])
    .map((e) => `- [${sanitiseContent((e.tags || []).join(','), 80)}] ${sanitiseContent(e.lesson, 300)}`)
    .join('\n');
}

// Standalone global-lessons block for the plan-creation guide prompt (dev
// phases fold the same lines into loadLessonsBlock's block instead). null in →
// null out, so the call site can filter it out of volatileCtx with no guard.
export function renderGlobalLessonsBlock(selected) {
  if (!Array.isArray(selected) || !selected.length) return null;
  return `<global_lessons>
Generalizable lessons distilled from OTHER projects on a similar stack. Lower priority than this project's own brief, decisions, and code — treat them as hints and verify before relying on them.

${renderGlobalLessonLines(selected)}
</global_lessons>`;
}

// Phase 8 learning loop: surfaces failure knowledge captured by recordLesson()
// (heal/reprompt/escalation/validator-fail/verify-fail/stall) back into the
// dev prompt. Two sources, both optional and independently gated:
//   - .guide/lessons-distilled.md — a compressed, human/LLM-authored summary
//     produced by the lessons-distill guide task once the raw backlog grows
//     past cfg.lessons.distill_after_entries. Included in full (already
//     capped at cfg.lessons.max_distilled_lines by finalizeDistillation).
//     Phase 42: omitted here whenever .guide/project-conventions.md exists
//     (materializeProjectConventions folds the same distilled text into its
//     own "Anti-patterns" section) — a project with the file materialized
//     reads the durable copy instead of getting it re-sent on every spawn.
//     cfg.conventions_file.enabled:false always reverts to the pre-phase-42
//     behavior (full distilled section inline), regardless of whether the
//     file happens to exist on disk.
//   - .guide/lessons.jsonl — raw entries not yet folded into a distillation.
//     Ranked by selectRelevantLessons() (file/keyword overlap, recency
//     tie-break — no embeddings, per the brief's open-question default) and
//     capped to cfg.lessons.inject_top_k. NEVER gated by the conventions
//     file — failure-critical and small, stays inline regardless.
// Returns null (not an empty tag) when neither source has anything to show,
// so an empty/missing lessons.jsonl costs zero tokens — the cache-discipline
// invariant this phase must not regress.
// Phase 80: `globalOpts` (null for every pre-phase-80 caller and every
// ineligible call) carries { stackTags, topK, now } when this dev phase is
// eligible for cross-project global-lesson injection (see globalLessonsEligible
// + the runDev wiring). When present, the top-K stack-matched global lessons
// are ranked (tag overlap, weight 3, always below a local file hit) and
// rendered as an extra, lowest-priority part inside the SAME block. Absent →
// byte-identical to the pre-phase-80 output, so the per-project flow is
// unchanged when no global file exists or the phase is ineligible.
export async function loadLessonsBlock(projDir, phaseMeta, cfg, globalOpts = null) {
  if (cfg?.lessons?.enabled === false) return null;

  const topK = cfg?.lessons?.inject_top_k ?? 5;
  const conventionsActive = cfg?.conventions_file?.enabled !== false && await fileExists(projectConventionsPath(projDir));
  const distilledContent = await readText(lessonsDistilledPath(projDir));
  const hasDistilled = !conventionsActive && !!(distilledContent && distilledContent.trim());

  const entries = await readLessons(projDir);
  const relevant = selectRelevantLessons(entries, phaseMeta, topK);

  let globalSelected = [];
  if (globalOpts && cfg?.lessons?.global?.enabled !== false) {
    try {
      globalSelected = await selectGlobalLessons({
        phaseMeta,
        stackTags: globalOpts.stackTags,
        topK: cfg?.lessons?.global?.inject_top_k ?? 3,
        now: globalOpts.now,
      });
    } catch { /* fail-open — a global-store hiccup never blocks local injection */ }
  }

  if (!hasDistilled && !relevant.length && !globalSelected.length) return null;

  const parts = [];
  if (hasDistilled) {
    parts.push(`Distilled patterns from earlier rounds:\n${sanitiseContent(distilledContent.trim(), 6000)}`);
  }
  if (relevant.length) {
    const lines = relevant
      .map((e) => `- [${sanitiseContent(e.kind, 40)}] ${sanitiseContent(e.lesson, 300)}`)
      .join('\n');
    parts.push(`Relevant lessons from recent failures:\n${lines}`);
  }
  if (globalSelected.length) {
    parts.push(`Generalizable lessons from other projects (lowest priority — hints, verify first):\n${renderGlobalLessonLines(globalSelected)}`);
  }

  return `<lessons_from_prior_failures>
${parts.join('\n\n')}
</lessons_from_prior_failures>`;
}

export async function loadMostRecentHandoffBlock(projDir) {
  const handoffsDir = path.join(guideRoot(projDir), 'handoffs');
  let entries;
  try { entries = await fs.readdir(handoffsDir); } catch { return null; }

  const mds = entries.filter(e => e.endsWith('.md'));
  if (!mds.length) return null;

  let mostRecentName = null;
  let mostRecentMs   = 0;
  for (const name of mds) {
    try {
      const stat = await fs.stat(path.join(handoffsDir, name));
      if (stat.mtimeMs > mostRecentMs) {
        mostRecentMs   = stat.mtimeMs;
        mostRecentName = name;
      }
    } catch { /* skip unreadable entries */ }
  }
  if (!mostRecentName) return null;

  let content;
  try { content = await fs.readFile(path.join(handoffsDir, mostRecentName), 'utf-8'); }
  catch { return null; }

  if (!content.trim()) return null;

  return `<previous_handoff>
The following is a handoff document from the previous guide session for this project. Read it carefully to understand the current state, prior decisions, and remaining work before proceeding.

${sanitiseContent(content.trim(), 8000)}
</previous_handoff>`;
}

export async function loadSuggestionsBlock(projDir, slot = 1, projectName = null) {
  // DB gate: only inject when the accepted plan row still exists.
  // Closes the file/DB divergence that occurs after reset-brief:
  // staleAllSuggestions() marks rows stale but never removes suggestions.md.
  // Keep the row in dbRow for the fallback below instead of discarding it.
  let dbRow = null;
  if (projectName) {
    const { getLatestSuggestions } = await import('../state.js');
    const latest = getLatestSuggestions(projectName);
    if (!latest || latest.status !== 'accepted') return null;
    dbRow = latest;
  }

  const filePath = suggestionsPath(projDir);
  let content;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
  if (!content?.trim()) return null;

  const targetHeader = `## Pass ${slot}`;
  const lines = content.split('\n');
  let inSection = false;
  const sectionLines = [];

  for (const line of lines) {
    if (line.startsWith('## Pass ')) {
      if (inSection) break; // reached next pass section
      if (line.trim() === targetHeader) { inSection = true; continue; }
      continue;
    }
    if (line.startsWith('---')) break; // trailing footer boundary
    if (inSection) sectionLines.push(line);
  }

  // Strip leading/trailing blank lines within the section
  while (sectionLines.length && !sectionLines[0].trim()) sectionLines.shift();
  while (sectionLines.length && !sectionLines[sectionLines.length - 1].trim()) sectionLines.pop();

  if (!sectionLines.length) {
    // ── DB fallback ───────────────────────────────────────────────────────────
    // .md section is empty but the accepted DB row may have items for this slot.
    // Build the injection block from pipeline_plan_json + selected_json so the DB
    // plan remains the single source of truth when the file and DB diverge.
    if (dbRow) {
      try {
        const plan     = JSON.parse(dbRow.pipeline_plan_json || '{}');
        const selected = JSON.parse(dbRow.selected_json     || '[]');
        const ids      = plan[String(slot)] || [];
        const items    = ids.map(id => selected.find(s => s.id === id)).filter(Boolean);
        if (items.length > 0) {
          const fallbackLines = items.map(s => {
            const tag = s.manual ? ' ✎' : '';
            return `- ${s.title}${tag} (${s.type}, ${s.effort} effort, ${s.impact} impact)`;
          });
          console.warn(chalk.yellow(
            `  ⚠ suggestions.md has no items for Pass ${slot} — using DB plan (${items.length} item${items.length !== 1 ? 's' : ''}).`
          ));
          return `<suggestions_plan slot="${slot}">
The following improvements were pre-selected for pipeline pass ${slot}.
Focus dev phases in this run on delivering these items only. Additional passes are planned as separate pipeline runs — do not pull in items from other passes.

${sanitiseContent(fallbackLines.join('\n'))}
</suggestions_plan>`;
        }
      } catch {
        // Malformed JSON in DB row — fall through to the warn+null path below.
      }
    }

    // No DB fallback available or DB also has no items for this slot.
    const definedPasses = (content.match(/^## Pass \d+/gm) || []).length;
    console.warn(chalk.yellow(
      `  ⚠ suggestions.md has no items for Pass ${slot}` +
      (definedPasses > 0 ? ` (file defines ${definedPasses} pass${definedPasses !== 1 ? 'es' : ''})` : '') +
      ` — suggestions block not injected.`
    ));
    return null;
  }

  return `<suggestions_plan slot="${slot}">
The following improvements were pre-selected for pipeline pass ${slot}.
Focus dev phases in this run on delivering these items only. Additional passes are planned as separate pipeline runs — do not pull in items from other passes.

${sanitiseContent(sectionLines.join('\n'))}
</suggestions_plan>`;
}

function preflightOrThrow(cfg) {
  const { errors } = preflightCheck(cfg);
  if (errors.length) throw new Error('Preflight failed:\n' + errors.join('\n'));
}
