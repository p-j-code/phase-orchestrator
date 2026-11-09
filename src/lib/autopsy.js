// Structured failure autopsy (phase 62).
//
// When an auto-run pauses on an error/validator or fails outright — the
// highest-friction moment, usually seen on a phone — a single line of
// pause_reason is not enough to decide what to do next. This module turns the
// run's DETERMINISTIC context (pause reason, run_events timeline, errored
// calls in the run window, healing_log attempts, latest verify verdict counts,
// and the last ~30 parsed log-tail entries) into a structured autopsy:
//   { what_ran, what_failed, what_was_tried, root_cause_hypothesis,
//     recommended_action, confidence }
// where recommended_action MUST be one of the command strings getNextActions
// produces for this state.
//
// The single haiku LLM call (the cycle's ONLY new LLM call) is best-effort and
// heavily guarded:
//   - Budget guard: if the billing window is 'pause' (or the call fails, or the
//     reply is still invalid JSON after one re-ask) it emits the deterministic
//     context as a PLAIN-TEXT autopsy WITHOUT the LLM.
//   - Cache rule: the static instruction block is byte-identical across calls;
//     all volatile context rides the user prompt.
//   - Never-throws: every path is wrapped; a telemetry/autopsy failure must
//     never fail (or block) a run. Invoked AFTER finalize persists status.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import chalk from 'chalk';
import {
  getAutoRunById, listRunEvents, listHealingLog,
  erroredCallsInWindow, getLatestVerifyResult, setAutopsy, queueNotify,
} from '../state.js';
import { windowStatus } from '../billing-guard.js';
import { runClaude } from '../claude-runner.js';
import { getNextActions } from './next-actions.js';
import { classifyPauseReason } from './pause-classifier.js';
import { autopsyDir, autopsyPath } from './guide-paths.js';
import { readRecentLogEntries } from './stream-log.js';
import { isProviderRateLimitError } from './transient-errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');
const LOGS_DIR = path.join(REPO_ROOT, 'logs');

// ─── Static instruction block (byte-identical across calls — cache rule) ─────
// NOTHING volatile goes here: the allowed recommended_action list, the run
// context, and the project name all ride the user prompt so this block is a
// stable cache prefix.
const AUTOPSY_SYSTEM_PROMPT =
  `You are the failure-autopsy analyst for a phase-based dev orchestrator. An auto-run ` +
  `has just FAILED or paused on an error, and the operator is deciding what to do next — ` +
  `often on a phone. You are given the run's already-assembled deterministic context (the ` +
  `pause reason, an event timeline, errored subprocess calls, auto-heal attempts, the latest ` +
  `acceptance-check verdict counts, and a tail of the run's log). You have NO tools and cannot ` +
  `inspect the repository — reason ONLY from the context in the user message.\n\n` +
  `Reply with a SINGLE JSON object and nothing else (no markdown fence, no prose) with EXACTLY ` +
  `these keys:\n` +
  `  "what_ran": one sentence on what the run was doing when it stopped.\n` +
  `  "what_failed": one-to-two sentences naming the concrete failure.\n` +
  `  "what_was_tried": what the orchestrator already attempted (heals/retries), or "nothing" if none.\n` +
  `  "root_cause_hypothesis": your best single hypothesis for the underlying cause.\n` +
  `  "recommended_action": the ONE next command to run. It MUST be copied VERBATIM from the ` +
  `"Allowed recommended actions" list in the user message — do not invent or paraphrase a command.\n` +
  `  "confidence": one of "low", "medium", "high".\n\n` +
  `Be terse and technical. Do not repeat the raw context back; synthesize it.`;

// ─── JSON schema + validation (recommended_action enum is per-call) ──────────

/**
 * Build the AJV schema for one autopsy reply. recommended_action is constrained
 * to the exact command strings getNextActions produced for this run's state
 * (an out-of-set value fails validation). When no actions could be enumerated
 * (never in practice — getNextActions always returns the always-available
 * options) it degrades to a non-empty string so the autopsy still validates.
 */
export function buildAutopsySchema(allowedActions) {
  const recommended = Array.isArray(allowedActions) && allowedActions.length
    ? { type: 'string', enum: allowedActions }
    : { type: 'string', minLength: 1 };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['what_ran', 'what_failed', 'what_was_tried', 'root_cause_hypothesis', 'recommended_action', 'confidence'],
    properties: {
      what_ran: { type: 'string' },
      what_failed: { type: 'string' },
      what_was_tried: { type: 'string' },
      root_cause_hypothesis: { type: 'string' },
      recommended_action: recommended,
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    },
  };
}

// Tolerate a reply wrapped in a markdown fence or with trailing prose, the same
// way verify-loop's checker parser does.
function tolerantJsonParse(text) {
  const trimmed = String(text ?? '').trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const start = trimmed.indexOf('{');
  if (start < 0) throw new Error('no JSON object found in autopsy reply');
  let depth = 0;
  for (let i = start; i < trimmed.length; i += 1) {
    if (trimmed[i] === '{') depth += 1;
    else if (trimmed[i] === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(trimmed.slice(start, i + 1));
    }
  }
  throw new Error('unterminated JSON in autopsy reply');
}

/**
 * Parse + AJV-validate one autopsy reply against buildAutopsySchema.
 * @param {unknown} raw - the reply text (or an already-parsed object)
 * @param {string[]} allowedActions - the enumerated recommended_action set
 * @returns {{ok: true, value: object} | {ok: false, errors: string[]}}
 */
export function validateAutopsy(raw, allowedActions) {
  let obj;
  try {
    obj = typeof raw === 'string' ? tolerantJsonParse(raw) : raw;
  } catch (err) {
    return { ok: false, errors: [`invalid JSON: ${err.message}`] };
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['autopsy is not a JSON object'] };
  }
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(buildAutopsySchema(allowedActions));
  if (!validate(obj)) {
    const errors = (validate.errors || []).map((e) => `${e.instancePath || '(root)'} ${e.message}`);
    return { ok: false, errors };
  }
  return { ok: true, value: obj };
}

// ─── Deterministic context assembly (no LLM) ─────────────────────────────────

function safe(fn, fallback) {
  try { const v = fn(); return v == null ? fallback : v; } catch { return fallback; }
}
async function safeAsync(fn, fallback) {
  try { const v = await fn(); return v == null ? fallback : v; } catch { return fallback; }
}
function trunc(s, n) { const str = String(s ?? ''); return str.length > n ? `${str.slice(0, n)}…` : str; }
function firstLine(s) { return String(s ?? '').split('\n')[0].trim(); }

/**
 * Gather every deterministic signal about one finalized run. DETERMINISTIC — no
 * LLM, never throws (each read degrades to an empty default). `terminalStatus`
 * recovers the true outcome: finalize() persists failed/cancelled runs as
 * status='paused' with a 'failed: '/'cancelled: ' pause_reason prefix.
 *
 * @param {{projectName: string, runId: number}} args
 * @param {object} [deps] - injectable readers/logsDir for tests
 */
export async function assembleAutopsyContext({ projectName, runId }, deps = {}) {
  const logsDir = deps.logsDir ?? LOGS_DIR;
  const run = safe(() => (deps.getAutoRunById ?? getAutoRunById)(runId), null);

  const pauseReason = run?.pause_reason ?? null;
  const pauseKind = run?.pause_kind ?? classifyPauseReason(pauseReason);
  const status = run?.status ?? 'unknown';
  let terminalStatus = status;
  if (typeof pauseReason === 'string') {
    if (pauseReason.startsWith('failed:')) terminalStatus = 'failed';
    else if (pauseReason.startsWith('cancelled:')) terminalStatus = 'cancelled';
  }

  const since = run?.started_at ?? null;
  const until = run?.ended_at ?? null;
  const events = safe(() => (deps.listRunEvents ?? listRunEvents)(runId), []);
  const erroredCalls = safe(
    () => (deps.erroredCallsInWindow ?? erroredCallsInWindow)({ project: projectName, since, until, limit: 15 }),
    [],
  );
  const allHealing = safe(() => (deps.listHealingLog ?? listHealingLog)(projectName, 30), []);
  const healing = since ? allHealing.filter((h) => h.created_at && h.created_at >= since) : allHealing;
  const verify = safe(() => (deps.getLatestVerifyResult ?? getLatestVerifyResult)(projectName), null);
  const logTail = await safeAsync(
    () => (deps.readRecentLogEntries ?? readRecentLogEntries)(logsDir, projectName, { maxEntries: 30 }),
    [],
  );

  return {
    projectName, runId, status, terminalStatus, pauseReason, pauseKind,
    run, events, erroredCalls, healing, verify, logTail,
  };
}

/**
 * The command strings the LLM may pick from — exactly what getNextActions
 * produces for this run's state (failed → 'auto-run-failed'; every error/
 * validator pause → 'auto-run-paused'). Order preserved (priority-sorted),
 * de-duped by cmd.
 */
export function enumerateRecommendedActions(ctx) {
  const project = ctx.projectName;
  const actions = ctx.terminalStatus === 'failed'
    ? getNextActions({ project, lastAction: 'auto-run-failed' })
    : getNextActions({ project, lastAction: 'auto-run-paused', state: { pauseReason: ctx.pauseReason, pauseKind: ctx.pauseKind } });
  const seen = new Set();
  const cmds = [];
  for (const a of actions) {
    if (a?.cmd && !seen.has(a.cmd)) { seen.add(a.cmd); cmds.push(a.cmd); }
  }
  return cmds;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderContextSection(ctx) {
  const lines = [];
  lines.push(`Project: ${ctx.projectName}`);
  lines.push(`Run: #${ctx.runId} (status ${ctx.terminalStatus})`);
  lines.push(`Pause reason: ${ctx.pauseReason || '(none recorded)'}`);
  lines.push(`Pause kind: ${ctx.pauseKind || '(none)'}`);

  if (ctx.events.length) {
    lines.push('', 'Timeline (run_events):');
    for (const e of ctx.events.slice(-15)) {
      const ph = e.phase != null ? ` phase ${e.phase}` : '';
      lines.push(`  - ${e.ts} ${e.kind}${ph}${e.detail ? ` — ${trunc(e.detail, 160)}` : ''}`);
    }
  }
  if (ctx.erroredCalls.length) {
    lines.push('', 'Errored calls in this run window:');
    for (const c of ctx.erroredCalls.slice(0, 10)) {
      const ph = c.phase != null ? ` phase ${c.phase}` : '';
      lines.push(`  - ${c.task} (${c.model})${ph}: ${trunc(c.error_message || '(no message)', 200)}`);
    }
  }
  if (ctx.healing.length) {
    lines.push('', 'Auto-heal attempts:');
    for (const h of ctx.healing.slice(0, 10)) {
      lines.push(`  - ${h.error_kind} → ${h.status}${h.strategy ? ` (${trunc(h.strategy, 80)})` : ''}: ${trunc(h.error_message || '', 160)}`);
    }
  }
  if (ctx.verify) {
    lines.push('', `Latest acceptance verdict (phase ${ctx.verify.phase}): ${ctx.verify.verdict} — met ${ctx.verify.criteria_met ?? '?'} / unmet ${ctx.verify.criteria_unmet ?? '?'} / unverifiable ${ctx.verify.unverifiable ?? '?'}`);
  }
  if (ctx.logTail.length) {
    lines.push('', 'Log tail (most recent subprocess output):');
    for (const e of ctx.logTail.slice(-30)) {
      const name = e.name ? ` ${e.name}` : '';
      lines.push(`  - [${e.t}]${name} ${trunc(e.detail || '', 160)}`);
    }
  }
  return lines.join('\n');
}

/** The volatile user prompt: context + the allowed action list + JSON reminder. */
export function renderContextForPrompt(ctx, allowedActions) {
  return [
    `Analyze this ${ctx.terminalStatus} auto-run and produce the autopsy JSON.`,
    '',
    '=== DETERMINISTIC CONTEXT ===',
    renderContextSection(ctx),
    '',
    '=== Allowed recommended actions (pick recommended_action VERBATIM from this list) ===',
    ...allowedActions.map((c) => `  ${c}`),
    '',
    'Reply with ONLY the JSON object described in the system instructions.',
  ].join('\n');
}

function reaskPrompt(errors, allowedActions) {
  return [
    'Your previous reply was not a valid autopsy JSON object. Problems:',
    ...(errors || []).map((e) => `  - ${e}`),
    '',
    'Reply again with ONLY the JSON object. recommended_action MUST be copied verbatim from:',
    ...allowedActions.map((c) => `  ${c}`),
  ].join('\n');
}

/** Full markdown for the .md artifact and the issue-thread detail. */
export function renderAutopsyMarkdown(structured, ctx, { deterministic = false } = {}) {
  return [
    `# Failure autopsy — ${ctx.projectName} run #${ctx.runId}`,
    '',
    `- **Status:** ${ctx.terminalStatus}`,
    `- **Source:** ${deterministic ? 'deterministic (no LLM)' : 'haiku'}`,
    `- **Confidence:** ${structured.confidence}`,
    '',
    `## → Recommended action`,
    '',
    '```',
    structured.recommended_action,
    '```',
    '',
    `## What ran`,
    '',
    structured.what_ran,
    '',
    `## What failed`,
    '',
    structured.what_failed,
    '',
    `## What was tried`,
    '',
    structured.what_was_tried,
    '',
    `## Root-cause hypothesis`,
    '',
    structured.root_cause_hypothesis,
    '',
    `## Context`,
    '',
    '```',
    renderContextSection(ctx),
    '```',
    '',
  ].join('\n');
}

/**
 * Deterministic autopsy — the plain-text fallback used when the billing window
 * is paused or the LLM call is unavailable/invalid. Same 6-field shape as the
 * LLM path so downstream consumers (auto_runs.autopsy) are uniform.
 */
export function renderDeterministicAutopsy(ctx, recommendedAction) {
  const structured = {
    what_ran: `Auto-run #${ctx.runId} for "${ctx.projectName}" ended as ${ctx.terminalStatus}.`,
    what_failed: firstLine(ctx.pauseReason)
      || (ctx.erroredCalls[0]?.error_message ? `errored call: ${trunc(ctx.erroredCalls[0].error_message, 200)}` : 'no explicit failure reason was recorded'),
    what_was_tried: ctx.healing.length
      ? `${ctx.healing.length} auto-heal attempt(s): ${ctx.healing.slice(0, 3).map((h) => `${h.error_kind}→${h.status}`).join(', ')}`
      : 'no auto-heal attempts recorded',
    root_cause_hypothesis: 'Deterministic autopsy — no LLM analysis was run (billing window paused, or the autopsy call was unavailable/invalid). See the Context section for the raw signals.',
    recommended_action: recommendedAction,
    confidence: 'low',
  };
  return { structured, markdown: renderAutopsyMarkdown(structured, ctx, { deterministic: true }) };
}

// ≤6-line notify summary that LEADS with the recommended action.
function renderNotifySummary(structured, ctx) {
  return [
    structured.recommended_action,
    `🩺 Autopsy — ${ctx.projectName} run #${ctx.runId} ${ctx.terminalStatus}`,
    `cause: ${trunc(structured.root_cause_hypothesis, 160)}`,
    `failed: ${trunc(structured.what_failed, 160)}`,
    `confidence: ${structured.confidence}`,
  ].join('\n');
}

// ─── The one LLM call ────────────────────────────────────────────────────────

async function runAutopsyLLM({ cfg, model, projectName, cwd, ctx, allowedActions, runClaudeFn }) {
  const autopsyCfg = { ...cfg, model, tools: { ...cfg.tools, allowed_default: [] } };
  delete autopsyCfg._effort_override;

  const baseCall = {
    cfg: autopsyCfg,
    cwd,
    systemPromptFile: null,
    systemPromptExtra: AUTOPSY_SYSTEM_PROMPT,
    sessionId: null,
    role: null,
    project: projectName,
    phase: null,
    task: 'autopsy',
  };
  const prompt = renderContextForPrompt(ctx, allowedActions);

  let result;
  try {
    result = await runClaudeFn({ ...baseCall, prompt });
  } catch (err) {
    console.warn(chalk.yellow(`[autopsy] LLM call failed: ${err.message}`));
    return null;
  }
  if (result?.is_error) {
    console.warn(chalk.yellow(`[autopsy] LLM call errored: ${trunc(result.error_message || result.result || '', 200)}`));
    return null;
  }

  let parsed = validateAutopsy(result?.result, allowedActions);
  if (!parsed.ok) {
    // Exactly one re-ask on invalid JSON, then give up (caller falls back).
    let result2;
    try {
      result2 = await runClaudeFn({ ...baseCall, prompt: reaskPrompt(parsed.errors, allowedActions), sessionId: result?.session_id || null });
    } catch (err) {
      console.warn(chalk.yellow(`[autopsy] re-ask failed: ${err.message}`));
      return null;
    }
    if (result2?.is_error) return null;
    parsed = validateAutopsy(result2?.result, allowedActions);
    if (!parsed.ok) {
      console.warn(chalk.yellow(`[autopsy] reply still invalid after re-ask: ${parsed.errors.join('; ')}`));
      return null;
    }
  }
  return parsed.value;
}

// ─── Orchestration ───────────────────────────────────────────────────────────

/**
 * Assemble + persist + broadcast one failure autopsy. NEVER throws and never
 * blocks finalization: call it best-effort AFTER finalize persists status.
 *
 * Outputs (all best-effort): auto_runs.autopsy (the JSON), the
 * .guide/autopsies/run-<id>.md artifact, one queueNotify ping (≤6 lines,
 * leading with the recommended action), and one openIssueThread (kind
 * 'autopsy', 6h dedupe built in).
 *
 * @param {{cfg: object, projectName: string, runId: number}} args
 * @param {object} [deps] - injectable seams for tests: runClaude, windowStatus,
 *   openIssueThread, queueNotify, projDir, logsDir, and the state readers.
 */
export async function runAutopsy({ cfg, projectName, runId }, deps = {}) {
  const runClaudeFn = deps.runClaude ?? runClaude;
  const windowStatusFn = deps.windowStatus ?? windowStatus;
  const queueNotifyFn = deps.queueNotify ?? queueNotify;
  const setAutopsyFn = deps.setAutopsy ?? setAutopsy;
  const openIssueThreadFn = deps.openIssueThread ?? (async (a) => {
    // Lazy import mirrors auto-healer.js — keeps the chat/issue-bridge import
    // chain off the autopsy module load path.
    const { openIssueThread } = await import('../chat/issue-bridge.js');
    return openIssueThread(a);
  });
  const projDir = deps.projDir ?? path.join(PROJECTS_DIR, projectName);

  try {
    const ctx = await assembleAutopsyContext({ projectName, runId }, deps);
    const allowedActions = enumerateRecommendedActions(ctx);
    const fallbackAction = allowedActions[0] || `/run ${projectName} resume`;

    // Budget guard: a paused window (or a missing autopsy model) means NO LLM
    // call — emit the deterministic context instead.
    const windowState = safe(() => windowStatusFn(cfg)?.state, 'ok');
    const model = cfg?.models?.autopsy;
    const providerLimited = isProviderRateLimitError(ctx.pauseReason)
      || ctx.erroredCalls.some((call) => isProviderRateLimitError(call.error_message));

    let structured = null;
    let deterministic = true;
    if (!providerLimited && windowState !== 'pause' && model) {
      const workspaceDir = path.join(projDir, cfg?.paths?.workspace_subdir || 'workspace');
      structured = await runAutopsyLLM({ cfg, model, projectName, cwd: workspaceDir, ctx, allowedActions, runClaudeFn });
      deterministic = !structured;
    }
    let markdown;
    if (structured) {
      markdown = renderAutopsyMarkdown(structured, ctx, { deterministic: false });
    } else {
      ({ structured, markdown } = renderDeterministicAutopsy(ctx, fallbackAction));
      deterministic = true;
    }

    // Persist the JSON on the run row.
    setAutopsyFn(runId, JSON.stringify(structured));

    // Write the markdown artifact.
    try {
      await fs.mkdir(autopsyDir(projDir), { recursive: true });
      await fs.writeFile(autopsyPath(projDir, runId), markdown, 'utf-8');
    } catch (err) {
      console.warn(chalk.yellow(`[autopsy] could not write artifact: ${err.message}`));
    }

    // Ping — leads with the recommended action.
    queueNotifyFn({ project: projectName, text: renderNotifySummary(structured, ctx) });

    // Open (or reuse, 6h dedupe) the issue thread.
    try {
      await openIssueThreadFn({
        project: projectName,
        kind: 'autopsy',
        error: `${ctx.terminalStatus} — ${trunc(structured.root_cause_hypothesis, 160)}`,
        detail: markdown,
        suppressAutoFix: providerLimited,
      });
    } catch (err) {
      console.warn(chalk.yellow(`[autopsy] issue thread failed: ${err.message}`));
    }

    return { structured, deterministic, recommendedAction: structured.recommended_action };
  } catch (err) {
    console.warn(chalk.yellow(`[autopsy] failed (non-fatal): ${err.message}`));
    return null;
  }
}
