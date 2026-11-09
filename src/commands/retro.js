// Retrospective (Phase 12 / brief P4 part B) — aggregates this project's own
// telemetry (calls, healing_log, phases) over a trailing window into a dated
// markdown report of findings + concrete config-tuning proposals.
//
// Pure SQL aggregation (no new tables/columns) + ONE roleless guide call that
// receives the aggregate JSON as its prompt content and replies with the
// report body verbatim — same `role: null` / `sessionId: null` contract as
// verify-loop.js's acceptance-check (docs/VERIFY_LOOP.md §13.2), so this call
// can never clobber `guide_session_id`/`last_dev_session_id`.
//
// Hard constraint (brief non-goal, restated so it's impossible to miss while
// editing this file): this command NEVER writes to any config file. It only
// ever produces docs/retro/<project>/YYYY-MM-DD.md. The operator reviews and
// edits config by hand.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDb, getProject, cacheHitPct } from '../state.js';
import { resolve as resolveConfig } from '../config-resolver.js';
import { runClaude } from '../claude-runner.js';
import { assertInsideDir } from '../lib/guide-paths.js';
import { readLessons } from '../lib/lessons.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');
const RETRO_DIR = path.join(REPO_ROOT, 'docs', 'retro');

export const DEFAULT_WINDOW_DAYS = 14;

// Only dev-execution/fix-execution ever legitimately compete for the opus
// tier via BOTH complexity routing (model-router.js) AND the failure-driven
// escalation marker (phase-runner.js `escalate-opus.marker`). Tasks like
// plan-creation/roadmap are opus by DEFAULT in config/defaults.json, so an
// opus-model call there is not a signal of anything — computing an
// "escalation rate" for them would be noise, not evidence.
const ESCALATION_APPLICABLE_TASKS = new Set(['dev-execution', 'fix-execution']);

// The retrospective call needs zero filesystem access — the entire aggregate
// is embedded in its prompt. An EMPTY allowed-tools list is not the same as
// "no tools": claude-runner.js only pushes `--allowedTools` when the joined
// string is truthy, so an empty array would silently fall through to
// whatever unrestricted default the CLI applies. Keep one harmless read-only
// tool so the flag is always emitted and enforced.
const RETRO_ALLOWED_TOOLS = Object.freeze(['Read']);

const RETRO_SYSTEM_PROMPT =
  `You are the Ashmero Orchestrator's retrospective analyst. You are invoked periodically ` +
  `to turn one project's own telemetry (already aggregated for you) into concrete, ` +
  `evidence-backed config tuning proposals. You have no need for tools — everything you ` +
  `need is embedded in the prompt. Your entire reply becomes the report file verbatim: no ` +
  `code fence, no preamble, no "Here is the report."`;

function pct(numerator, denominator) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/**
 * Pure-SQL aggregation over calls/healing_log/phases for one project, plus a
 * best-effort read of .guide/lessons.jsonl for reprompt/escalation counts
 * (the only place those events are actually persisted — the escalate-opus
 * marker file is deleted on success and can't be counted retroactively).
 *
 * @param {object} o
 * @param {string} o.projectName
 * @param {number} [o.days] - trailing window in days (clamped 1..365)
 * @param {object} [o.cfg] - pre-resolved config (task:'retrospective'); resolved internally if omitted
 * @returns {Promise<object>}
 */
export async function buildRetroAggregate({ projectName, days = DEFAULT_WINDOW_DAYS, cfg = null } = {}) {
  const project = getProject(projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);

  const resolvedCfg = cfg ?? await resolveConfig({ project: projectName, task: 'retrospective' });

  const db = getDb();
  const windowDays = Math.max(1, Math.min(365, Number(days) || DEFAULT_WINDOW_DAYS));
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const generatedAt = new Date().toISOString();

  const callRows = db.prepare(`
    SELECT task,
           COUNT(*)                               AS n,
           COALESCE(SUM(is_error),0)              AS errors,
           ROUND(COALESCE(SUM(cost_usd),0), 4)    AS usd,
           COALESCE(SUM(input_tokens),0)          AS input_tokens,
           COALESCE(SUM(output_tokens),0)         AS output_tokens,
           COALESCE(SUM(cache_read_tokens),0)     AS cache_read_tokens,
           COALESCE(SUM(cache_creation_tokens),0) AS cache_creation_tokens,
           COALESCE(SUM(CASE WHEN model LIKE '%opus%' THEN 1 ELSE 0 END),0) AS opus_calls
    FROM calls
    WHERE project = ? AND started_at >= ?
    GROUP BY task
    ORDER BY usd DESC, n DESC
  `).all(projectName, since);

  const timeoutRows = db.prepare(`
    SELECT task, COUNT(*) AS n
    FROM calls
    WHERE project = ? AND started_at >= ? AND is_error = 1
      AND error_message LIKE 'claude subprocess timed out after%'
    GROUP BY task
  `).all(projectName, since);
  const timeoutByTask = new Map(timeoutRows.map((r) => [r.task, r.n]));

  const healRows = db.prepare(`
    SELECT error_kind, COUNT(*) AS n
    FROM healing_log
    WHERE project = ? AND created_at >= ?
    GROUP BY error_kind
    ORDER BY n DESC
  `).all(projectName, since);

  const phasesSummary = db.prepare(`
    SELECT COUNT(*)                                                    AS touched,
           COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END),0) AS completed,
           COALESCE(SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END),0) AS failed
    FROM phases
    WHERE project = ?
      AND ((started_at IS NOT NULL AND started_at >= ?) OR (completed_at IS NOT NULL AND completed_at >= ?))
  `).get(projectName, since, since);

  // Best-effort — lessons.jsonl may not exist yet, or may have been
  // distilled/truncated past entries within this window (finalizeDistillation
  // drops raw entries once folded into lessons-distilled.md); this undercounts
  // in that case but never throws.
  let lessons = [];
  try { lessons = await readLessons(path.join(PROJECTS_DIR, projectName)); } catch { lessons = []; }
  const windowLessons = lessons.filter((l) => typeof l.ts === 'string' && l.ts >= since);
  const repromptCount = windowLessons.filter((l) => l.kind === 'reprompt').length;
  const escalationCountFromLessons = windowLessons.filter((l) => l.kind === 'escalation').length;

  const perTask = callRows.map((r) => {
    const timeoutTrips = timeoutByTask.get(r.task) || 0;
    const taskTimeoutConfigured = resolvedCfg.phases?.task_timeout_ms?.[r.task] != null;
    const escalationApplicable = ESCALATION_APPLICABLE_TASKS.has(r.task);
    return {
      task: r.task,
      calls: r.n,
      errors: r.errors,
      error_rate_pct: pct(r.errors, r.n),
      cost_usd: r.usd,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cache_read_tokens: r.cache_read_tokens,
      cache_creation_tokens: r.cache_creation_tokens,
      cache_hit_pct: cacheHitPct(r),
      escalation: escalationApplicable
        ? { opus_calls: r.opus_calls, escalation_rate_pct: pct(r.opus_calls, r.n) }
        : null,
      timeout_trips: {
        count: timeoutTrips,
        source: timeoutTrips > 0
          ? (taskTimeoutConfigured ? `task_timeout_ms['${r.task}']` : 'subprocess_timeout_ms (fallback)')
          : null,
      },
    };
  });

  return {
    project: projectName,
    window_days: windowDays,
    since,
    generated_at: generatedAt,
    has_data: callRows.length > 0 || healRows.length > 0 || phasesSummary.touched > 0,
    per_task: perTask,
    reprompt_count: repromptCount,
    escalation_count_from_lessons: escalationCountFromLessons,
    _escalation_count_from_lessons_note:
      'Only counts timeout-exhausted-reprompt escalations (auto-runner.js records these to lessons.jsonl); ' +
      'the operational-failure-then-escalate path has no persisted event, only a transient marker file ' +
      'deleted on success. See per_task[].escalation for the fuller (but noisier) opus-share proxy.',
    heal_counts_by_kind: healRows.map((h) => ({ error_kind: h.error_kind, count: h.n })),
    phases: {
      touched: phasesSummary.touched,
      completed: phasesSummary.completed,
      failed: phasesSummary.failed,
    },
    config_snapshot: {
      models: resolvedCfg.models,
      task_timeout_ms: resolvedCfg.phases?.task_timeout_ms || {},
      task_max_turns: resolvedCfg.phases?.task_max_turns || {},
      subprocess_timeout_ms: resolvedCfg.phases?.subprocess_timeout_ms ?? null,
      idle_timeout_ms: resolvedCfg.phases?.idle_timeout_ms ?? null,
      tool_hang_timeout_ms: resolvedCfg.phases?.tool_hang_timeout_ms ?? null,
      turn_stall_timeout_ms: resolvedCfg.phases?.turn_stall_timeout_ms ?? null,
    },
  };
}

/**
 * Pure prompt builder — the aggregate JSON IS the retrospective's raw data;
 * the guide call queries nothing itself. Instructs an exact two-section
 * markdown shape so `runRetrospective` can persist the reply verbatim.
 */
export function buildRetroPrompt(aggregate) {
  return `Project "${aggregate.project}" — trailing ${aggregate.window_days}-day window (${aggregate.since} → ${aggregate.generated_at}).

Aggregate telemetry, computed via SQL over this project's calls/healing_log/phases tables:

\`\`\`json
${JSON.stringify(aggregate, null, 2)}
\`\`\`

Write a markdown report with EXACTLY these two top-level sections, in this order:

## Findings
Bullet-point observations grounded in the numbers above: call volume, cost, cache-hit rate, error rate, escalation rate (per_task[].escalation is the opus-share proxy; escalation_count_from_lessons is the narrower timeout-driven count), reprompt count, heal counts by kind, and timeout trips by source. Call out anything that looks off (a task with a high error/timeout rate, a low cache-hit rate suggesting prompt churn, a heal kind recurring often, etc). If has_data is false, say plainly that there was nothing to analyze this cycle and stop there — do not invent findings.

## Config change proposals
Zero or more concrete proposals, each its own line formatted EXACTLY as:
- \`<config.key.path>\` currently \`<current value from config_snapshot>\`; <one-sentence evidence citing specific numbers above> → propose \`<proposed value>\`.
Only propose a change you have direct numeric evidence for in the JSON above — never guess at a config key's current value; read it from config_snapshot. If there is nothing worth changing, write exactly one line: "(no config changes proposed this cycle)".

Output ONLY the markdown for these two sections — no code fence, no extra prose before or after.`;
}

function noDataReportBody(aggregate, projectName) {
  return `# Retrospective — ${projectName}

No calls, heals, or phase activity recorded in the trailing ${aggregate.window_days}-day window (${aggregate.since} → ${aggregate.generated_at}).

Nothing to analyze this cycle — re-run \`npm run retro -- ${projectName}\` once more activity accumulates.
`;
}

/**
 * Build + persist the dated retrospective report for one project. Skips the
 * guide call entirely (zero spend) when the window's aggregate is empty —
 * writes a deterministic "nothing to analyze" report instead of crashing or
 * producing a malformed file.
 *
 * `role: null` / `sessionId: null` on the guide call are load-bearing — same
 * contract as verify-loop.js's acceptance-check: this call must never touch
 * `guide_session_id`/`last_dev_session_id` for the project.
 *
 * @param {{projectName: string, days?: number}} args
 * @param {{runClaude?: Function}} [deps] - injectable seam for tests
 * @returns {Promise<{reportPath: string, aggregate: object, skippedGuideCall: boolean, result?: object}>}
 */
export async function runRetrospective({ projectName, days = DEFAULT_WINDOW_DAYS } = {}, deps = {}) {
  const runClaudeFn = deps.runClaude ?? runClaude;

  const cfg = await resolveConfig({ project: projectName, task: 'retrospective' });
  const aggregate = await buildRetroAggregate({ projectName, days, cfg });

  const dateStr = aggregate.generated_at.slice(0, 10);
  const reportPath = path.join(RETRO_DIR, projectName, `${dateStr}.md`);
  await assertInsideDir(RETRO_DIR, reportPath);

  if (!aggregate.has_data) {
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, noDataReportBody(aggregate, projectName), 'utf-8');
    return { reportPath, aggregate, skippedGuideCall: true };
  }

  const retroCfg = { ...cfg, tools: { ...cfg.tools, allowed_default: [...RETRO_ALLOWED_TOOLS] } };
  const prompt = buildRetroPrompt(aggregate);

  const result = await runClaudeFn({
    cfg: retroCfg,
    cwd: REPO_ROOT,
    prompt,
    systemPromptFile: null,
    systemPromptExtra: RETRO_SYSTEM_PROMPT,
    sessionId: null,
    role: null,
    project: projectName,
    task: 'retrospective',
  });

  if (result.is_error) {
    throw new Error(`retrospective guide call failed: ${result.result || result.error_message || 'unknown error'}`);
  }

  const body = String(result.result || '').trim();
  if (!body) {
    throw new Error('retrospective guide call returned an empty reply — refusing to write an empty report');
  }

  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${body}\n`, 'utf-8');

  return { reportPath, aggregate, skippedGuideCall: false, result };
}
