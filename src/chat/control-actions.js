// Chat control plane — action layer. One place that implements every tool the
// chat agent can call: read state, capture bugs/requirements/briefs, and kick
// off orchestrator work. Consumed by two callers:
//   - src/mcp/control-server.mjs — the stdio MCP server the chat subprocess
//     talks to (tool handlers, TOOL_DETAILS_BY_NAME)
//   - src/chat/chat-engine.js — buildContextSnapshot(), injected into every
//     chat prompt so the agent starts grounded without a tool round-trip
//
// IMPORTANT: this module runs inside the MCP server process, whose stdout IS
// the MCP transport. Never console.log here — diagnostics go to console.error.
//
// Heavy work (runs, briefs, plans, audits) is NEVER executed inline: it spawns
// a detached `node src/orchestrator.js <cmd>` — the exact pattern web-ui.js
// uses — so a chat turn stays fast and the work survives the chat subprocess.
// Instant writes (inbox capture, brief files) go through state.js / fs
// directly, mirroring the web-ui endpoints for the same operations.

import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn, exec } from 'node:child_process';
import { promisify } from 'node:util';
const execAsync = promisify(exec);
import { fileURLToPath } from 'node:url';
import {
  listProjects, getProject, getPhases, getActiveAutoRun, getLastAutoRun, listRunEvents,
  addBug, addRequirement, listBugs, listRequirements, countBugs, countRequirements,
  listHealingLog, getLatestSuggestions, getSpendReport, getDb, setProjectStatus,
  listDiscussions, getDiscussion, getDiscConclusion, getDiscAgents,
  getFreshestSuggestions, getSuggestionsById, saveSuggestions, acceptSuggestions,
  staleDraftSuggestions, recordDetachedSpawn, recentDetachedSpawn,
  getRunningJob, pidAlive, sweepInterruptedAutoRuns,
  setThreadAutopilot, getChatThread,
  getLiveProgress,
  getQualityReport,
  getPhaseRoutingChain,
} from '../state.js';
import { formatProgressHeader } from '../lib/live-progress.js';
import {
  listPendingJobs, listRunningJobs, listRecentJobs,
  enqueueUniqueActionJob, enqueueUniqueResumeJob,
  getRunningJobsForProject, requestJobCancellation,
} from '../server/job-queue.js';
import { resolve as resolveConfig } from '../config-resolver.js';
import { windowStatus } from '../billing-guard.js';
import {
  guideRoot, assertInsideDir, briefPath, rawThoughtsPath, planJsonPath,
  detectHighestBugRound, phaseReportPath, findMostRecentRoadmap,
} from '../lib/guide-paths.js';
import { scanProject } from '../lib/project-scanner.js';
import { generateSuggestions, assignToPasses, filterSuggestions } from '../lib/suggestion-engine.js';
import { promoteAuditToBugs } from '../lib/audit-promote.js';
import { validateCheckpointPolicy } from '../checkpoint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');
const ORCHESTRATOR = path.join(REPO_ROOT, 'src', 'orchestrator.js');
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');

const MAX_ARTIFACT_CHARS = 20000;
const QUEUE_FILENAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*\.md$/;

// Chat uploads — a global pool under state/ (runtime-owned). Files are stored
// as <ts>-<sanitized-basename> by storeChatUpload(); messages reference stored
// names and the agent reads them via read_upload.
export const UPLOADS_DIR = path.join(REPO_ROOT, 'state', 'chat-uploads');
const SELF_DEV_DIR = path.join(REPO_ROOT, 'logs', 'self-dev');
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.jsonl', '.csv', '.js', '.mjs', '.ts', '.html', '.css', '.yaml', '.yml', '.xml', '.log', '.sh', '.py', '.env', '.toml', '.ini']);
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** Persist an uploaded file into the pool; returns { name, size }. Shared by the web upload endpoint and the CLI /attach command. */
export async function storeChatUpload(filename, buffer) {
  const base = path.basename(String(filename || '')).replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!base || base.startsWith('.')) throw new Error('Invalid filename');
  if (!buffer || !buffer.length) throw new Error('Empty file');
  if (buffer.length > 25 * 1024 * 1024) throw new Error('File too large (25 MB max)');
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  const name = `${Date.now()}-${base}`;
  await fs.writeFile(path.join(UPLOADS_DIR, name), buffer);
  return { name, size: buffer.length };
}

/** Stat an already-stored upload by name (basename-jailed); null if absent. */
export async function statChatUpload(name) {
  const base = path.basename(String(name || ''));
  if (!base || base !== name) return null;
  const st = await statSafe(path.join(UPLOADS_DIR, base));
  return st ? { name: base, size: st.size } : null;
}

/**
 * Remove an upload that has not been sent. Names are basename-jailed exactly
 * like statChatUpload/read_upload; a missing file is an idempotent no-op so a
 * repeated browser cleanup cannot turn into an operator-facing error.
 */
export async function deleteChatUpload(name, { uploadsDir = UPLOADS_DIR } = {}) {
  const raw = String(name || '');
  const base = path.basename(raw);
  if (!base || base !== raw) throw new Error('Invalid upload name');
  try {
    await fs.unlink(path.join(uploadsDir, base));
    return { deleted: true, name: base };
  } catch (err) {
    if (err?.code === 'ENOENT') return { deleted: false, name: base };
    throw err;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Server-side enforcement of the autopilot authority envelope. On an
 * unattended loop tick the engine spawns the control server with
 * --autopilot-tick (→ AORCH_AUTOPILOT_TICK=1): the operator-only tools are
 * hard-rejected here, because the <autopilot> directive alone is prompt-side
 * policy that a single hallucinated tool call can walk straight past.
 */
function assertNotAutopilotTick(tool) {
  if (process.env.AORCH_AUTOPILOT_TICK === '1') {
    throw new Error(
      `${tool} is not available on an unattended autopilot tick — emit [[AUTOPILOT: BLOCKED — ${tool} needs the operator]] and wait for a human turn.`,
    );
  }
}

function ensureProject(name) {
  if (!name || typeof name !== 'string') throw new Error('"project" is required');
  const p = getProject(name);
  if (!p) {
    const known = listProjects().map((r) => r.name).join(', ') || '(none)';
    throw new Error(`Project not found: ${name}. Known projects: ${known}`);
  }
  return p;
}

function projectDirOf(name) {
  return path.join(PROJECTS_DIR, name);
}

async function readTextSafe(p) {
  try { return await fs.readFile(p, 'utf-8'); } catch { return null; }
}
async function statSafe(p) {
  try { return await fs.stat(p); } catch { return null; }
}
async function readJsonSafe(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf-8')); } catch { return null; }
}

/**
 * Spawns a detached orchestrator CLI command (same pattern as web-ui.js's
 * spawnOrchestrator, but stdio is 'ignore' — in the MCP server process stdout
 * is the protocol pipe and must never be inherited). The child keeps running
 * after the chat turn ends; progress lands in logs/ and the DB as usual.
 */
function spawnDetached(argv, { script = null, project = null, action = null } = {}) {
  const nodeArgs = script ? [script, ...argv] : [ORCHESTRATOR, ...argv];
  const child = spawn(process.execPath, nodeArgs, {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    cwd: REPO_ROOT,
  });
  child.unref();
  const label = action || (script ? path.basename(script) : argv[0]);
  console.error(`[control] spawned detached: ${script ? path.basename(script) : 'orchestrator'} ${argv.join(' ')} (pid ${child.pid})`);
  // R2 — detached-spawn ledger. stdio is 'ignore', so this is the only trace a
  // child that dies at startup leaves; the autopilot loop and the chat agent
  // read recentDetachedSpawn(project) to tell "still launching" from "died".
  try {
    recordDetachedSpawn({
      project: project ?? (script ? argv[0] : argv[1]) ?? null,
      action: label,
      pid: child.pid,
      source: 'chat',
    });
  } catch (e) { console.error(`[control] spawn-ledger write failed: ${e.message}`); }
  return child.pid;
}

function queueDurableAction(project, action, args = {}) {
  const queued = enqueueUniqueActionJob({ project, action, args, requestedBy: null });
  console.error(`[control] ${queued.scheduled ? 'queued' : 'reused'} durable ${action} ${project} (job #${queued.jobId})`);
  return queued;
}

function assertNoActiveRun(project) {
  const active = getActiveAutoRun(project);
  if (active) {
    throw new Error(`An auto-run is already active for ${project} (run #${active.id}, started ${active.started_at}). Abort it first or wait.`);
  }
}

function runStateOf(name) {
  const active = getActiveAutoRun(name);
  if (active) return { state: 'running', run: active };
  const last = getLastAutoRun(name);
  if (!last) return { state: 'idle', run: null };
  return { state: last.status, run: last };
}

// countBugs/countRequirements return GROUP BY (status, …) rows, not a number.
// "Awaiting" = inbox + refined (same set listProjectsWithBugs counts).
function inboxCount(groupedRows) {
  return (groupedRows || [])
    .filter((r) => r.status === 'inbox' || r.status === 'refined')
    .reduce((sum, r) => sum + (r.n || 0), 0);
}

// ─── Read tools ──────────────────────────────────────────────────────────────

export async function toolListProjects() {
  const projects = listProjects().map((p) => {
    const rs = runStateOf(p.name);
    return {
      name: p.name,
      status: p.status,
      phase: `${p.current_phase}/${p.total_phases}`,
      run_state: rs.state,
      pause_reason: rs.state === 'paused' ? (rs.run?.pause_reason || null) : null,
      inbox: { bugs: inboxCount(countBugs(p.name)), requirements: inboxCount(countRequirements(p.name)) },
      git_branch: p.git_branch || null,
    };
  });
  return { count: projects.length, projects };
}

export async function toolProjectOverview({ project } = {}) {
  const p = ensureProject(project);
  const projDir = projectDirOf(project);
  const phases = getPhases(project).map((ph) => ({ n: ph.n, title: ph.title, status: ph.status }));
  const rs = runStateOf(project);
  const plan = await readJsonSafe(planJsonPath(projDir));
  const briefStat = await statSafe(briefPath(projDir));
  const rawStat = await statSafe(rawThoughtsPath(projDir));
  let queueFiles = [];
  try {
    queueFiles = (await fs.readdir(path.join(projDir, 'inputs', 'queue')))
      .filter((f) => f.endsWith('.md')).sort();
  } catch { /* no queue dir */ }
  const suggestions = getLatestSuggestions(project);
  const cost = getDb().prepare(
    'SELECT COALESCE(SUM(cost_usd),0) AS total_cost, COUNT(*) AS total_calls FROM calls WHERE project = ?',
  ).get(project);
  return {
    project: {
      name: p.name, status: p.status, current_phase: p.current_phase,
      total_phases: p.total_phases, git_branch: p.git_branch || null,
      created_at: p.created_at,
    },
    run: { state: rs.state, pause_reason: rs.run?.pause_reason || null, started_at: rs.run?.started_at || null },
    phases,
    plan: plan ? { phases: plan.phases?.length || 0, brief_snapshot: plan.brief_snapshot || null } : null,
    brief: {
      exists: !!briefStat, modified: briefStat?.mtime?.toISOString() || null,
      raw_thoughts_exists: !!rawStat, raw_thoughts_modified: rawStat?.mtime?.toISOString() || null,
    },
    brief_queue: queueFiles,
    inbox: { bugs: inboxCount(countBugs(project)), requirements: inboxCount(countRequirements(project)) },
    suggestions: suggestions ? { id: suggestions.id, status: suggestions.status, next_pass: suggestions.next_pass } : null,
    recent_healing: listHealingLog(project, 5),
    cost: { total_usd: cost.total_cost, total_calls: cost.total_calls },
  };
}

export async function toolReadArtifact({ project, path: relPath } = {}) {
  ensureProject(project);
  if (!relPath || typeof relPath !== 'string') throw new Error('"path" is required (project-relative, under .guide/ or inputs/)');
  const projDir = projectDirOf(project);
  const abs = path.isAbsolute(relPath) ? relPath : path.join(projDir, relPath);
  // Jail to .guide/ or inputs/ — never workspace/ (owned by dev sessions, and
  // routinely too large to be useful in a chat turn anyway).
  let resolved;
  try {
    resolved = await assertInsideDir(guideRoot(projDir), abs);
  } catch {
    resolved = await assertInsideDir(path.join(projDir, 'inputs'), abs);
  }
  const content = await readTextSafe(resolved);
  if (content == null) return { found: false, path: relPath };
  return {
    found: true,
    path: relPath,
    content: content.slice(0, MAX_ARTIFACT_CHARS),
    truncated: content.length > MAX_ARTIFACT_CHARS,
  };
}

export async function toolWindowStatus() {
  const cfg = await resolveConfig({ project: null, task: 'dev-execution' });
  const s = windowStatus(cfg);
  return {
    state: s.state,
    admission_units_in_window: s.callsInWindow,
    calls_in_window: s.callsInWindow,
    raw_calls_in_window: s.rawCallsInWindow,
    window_hours: s.windowHours,
    pause_at_calls: s.pauseThreshold,
    cost_in_window_usd: s.totalCostInWindow,
    pause_at_cost_usd: s.pauseCostThreshold,
    cost_thresholds_enforced: s.costThresholdsEnforced,
  };
}

// predict — forecast the cost of a project's upcoming work with ZERO Claude
// calls (from historical per-phase telemetry). Lets the guarded autopilot loop
// self-gate: check the forecast against the remaining budget before firing an
// expensive run, instead of only learning it spent too much afterwards.
export async function toolPredict({ project } = {}) {
  ensureProject(project);
  const { predictUpcoming } = await import('../commands/predict.js');
  const p = await predictUpcoming(project);
  return {
    project,
    mode: p.mode,                         // 'phases' | 'bug-round' | 'idle'
    bug_round: p.bugRound,
    upcoming_units: p.totals?.calls ?? 0,
    forecast: {
      cost_usd: p.totals?.cost_usd ?? 0,
      duration_ms: p.totals?.duration_ms ?? 0,
      low_confidence_units: p.totals?.fallbackCount ?? 0,   // no telemetry → default estimate
    },
    budget: p.budget,                     // {cap, current, remaining, afterRun, pctAfter, wouldExceed}
    hint: p.mode === 'idle'
      ? 'No upcoming dev work to forecast (no pending phases or bug round).'
      : `Forecast: ~$${(p.totals?.cost_usd ?? 0).toFixed(2)} across ${p.totals?.calls ?? 0} calls${p.budget?.wouldExceed ? ' — WOULD EXCEED the call cap; consider pausing or splitting.' : '.'}`,
  };
}

export async function toolListJobs({ project } = {}) {
  const filt = (rows) => (project ? rows.filter((j) => j.project === project) : rows);
  return {
    running: filt(listRunningJobs()),
    pending: filt(listPendingJobs()),
    recent: filt(listRecentJobs(10)),
  };
}

// get_run_timeline (Phase 57 — P1 run_events) — the append-only per-run
// timeline: "what happened during run N?" in one call, instead of stitching
// together auto_runs status, .guide verdict files, escalation markers, and
// healing_log. run_id defaults to the project's most recent run. A legacy /
// pre-0.18 run (no rows ever recorded) returns events:[] with a hint — never
// an error — so the model reports "no timeline recorded" rather than failing.
export async function toolGetRunTimeline({ project, run_id = null } = {}) {
  ensureProject(project);
  let runId = run_id;
  if (runId == null) {
    const last = getLastAutoRun(project);
    if (!last) return { project, run_id: null, events: [], hint: 'No runs recorded for this project yet.' };
    runId = last.id;
  }
  const events = listRunEvents(runId);
  return {
    project,
    run_id: runId,
    events,
    hint: events.length
      ? `${events.length} event(s) — id-ordered timeline for run ${runId}.`
      : `No timeline recorded for run ${runId} (a legacy/pre-0.18 run, or none captured).`,
  };
}

// get_live_progress (Phase 59 — live run telemetry) — what a project's run is
// doing RIGHT NOW (turn count vs cap, current tool + elapsed, files touched,
// ETA), read from the single live_progress row the stream parser maintains.
// No row → a clean state:'idle' with progress:null (never an error), so the
// agent reports "not running" rather than failing. Zero Claude calls.
export async function toolGetLiveProgress({ project } = {}) {
  ensureProject(project);
  const row = getLiveProgress(project);
  if (!row) {
    return { project, state: 'idle', progress: null, hint: 'No live run for this project (idle).' };
  }
  let phaseTitle = null;
  if (row.phase != null) {
    const ph = getPhases(project).find((p) => p.n === row.phase);
    phaseTitle = ph ? ph.title : null;
  }
  return {
    project,
    state: 'running',
    phase_title: phaseTitle,
    header: formatProgressHeader(row),
    progress: row,
  };
}

// get_quality_report (Phase 60 — P4 quality dashboard) — acceptance
// first-pass %, per-task escalation % + avg turns vs cap, bug-round
// convergence (found_count series), 7d-vs-30d cache-hit trend per task, and
// zero-LLM Hybrid Context Compiler accuracy/failure/token-proxy telemetry.
// Thin wrapper over the SAME getQualityReport() helper the web-UI's
// OverviewTab Quality section reads, so chat and the browser can never
// report different numbers. Zero Claude calls.
export async function toolGetQualityReport({ project, days = 30 } = {}) {
  ensureProject(project);
  return getQualityReport({ project, days: Math.max(1, Math.min(365, Number(days) || 30)) });
}

// explain_routing (Phase 61 — P5 routing transparency) — "why did this model
// run, and did an escalation chain resolve the phase?" Thin wrapper over the
// SAME getPhaseRoutingChain() helper the web-UI's /phases/:n/routing endpoint
// reads, so chat and the browser can never disagree. Pure read layer over
// foundations telemetry (routing_tier/reason/attempt/escalated/num_turns/
// is_error) + Phase 60's verify_results — zero Claude calls, zero writes.
export async function toolExplainRouting({ project, phase } = {}) {
  ensureProject(project);
  const phaseN = Number(phase);
  if (!Number.isInteger(phaseN)) throw new Error('"phase" must be an integer phase number');
  const chain = getPhaseRoutingChain({ project, phase: phaseN });
  return {
    ...chain,
    hint: chain.calls.length
      ? `${chain.calls.length} call(s) — tier/reason/attempt/outcome per call, phase status "${chain.status || 'unknown'}".`
      : 'No calls recorded for this phase yet (or pre-foundations rows with no routing telemetry).',
  };
}

// forecast_run (Phase 63 — P7 pre-flight forecast) — "will this run fit the
// live 5h window, or pause mid-phase?". Deterministic, ZERO Claude calls. Thin
// wrapper over the SAME forecastRun() the GET /forecast endpoint returns, so
// chat and the browser can never disagree. Returns the forecast object plus a
// one-line hint; toolStartRun appends the same hint to its own reply.
export async function toolForecastRun({ project } = {}) {
  ensureProject(project);
  const { forecastRun, renderForecastLine } = await import('../commands/predict.js');
  const forecast = await forecastRun(project);
  return { ...forecast, hint: renderForecastLine(forecast) };
}

export async function toolListInbox({ project, kind = 'bugs' } = {}) {
  ensureProject(project);
  if (kind === 'bugs') return { kind, items: listBugs({ project, status: 'inbox' }) };
  if (kind === 'requirements') return { kind, items: listRequirements({ project, status: 'inbox' }) };
  throw new Error('"kind" must be bugs|requirements');
}

export async function toolSpendReport({ project = null, days = 30 } = {}) {
  if (project) ensureProject(project);
  const report = getSpendReport({ days: Math.max(1, Math.min(365, Number(days) || 30)), project });
  return { days, project: project || 'all', by_project: report.byProject, totals: report.totals };
}

// read_upload — returns text content for text files; for images returns raw
// MCP image content (the `_mcpContent` escape hatch the server passes through
// verbatim) so the model actually SEES the image.
export async function toolReadUpload({ name } = {}) {
  const base = path.basename(String(name || ''));
  if (!base || base !== name) throw new Error('"name" must be a stored upload name (no paths)');
  const abs = path.join(UPLOADS_DIR, base);
  const st = await statSafe(abs);
  if (!st) throw new Error(`Upload not found: ${base}`);
  const ext = path.extname(base).toLowerCase();

  if (IMAGE_MIME[ext]) {
    if (st.size > MAX_IMAGE_BYTES) throw new Error(`Image too large to view (${st.size} bytes; max ${MAX_IMAGE_BYTES}). Ask the user for a smaller version.`);
    const data = (await fs.readFile(abs)).toString('base64');
    return {
      _mcpContent: [
        { type: 'image', data, mimeType: IMAGE_MIME[ext] },
        { type: 'text', text: JSON.stringify({ name: base, size: st.size, note: 'image content above' }) },
      ],
    };
  }
  if (TEXT_EXT.has(ext) || ext === '') {
    const content = await fs.readFile(abs, 'utf-8');
    return { name: base, size: st.size, content: content.slice(0, MAX_ARTIFACT_CHARS), truncated: content.length > MAX_ARTIFACT_CHARS };
  }
  throw new Error(`Unsupported upload type "${ext}" — only text files and png/jpg/gif/webp images can be read. Tell the user which formats work.`);
}

// self_dev_log — list/read logs/self-dev/*.md so the chat can report on
// orchestrator_dev runs (they execute detached).
export async function toolSelfDevLog({ name = null } = {}) {
  if (name) {
    const base = path.basename(String(name));
    if (!base.endsWith('.md')) throw new Error('"name" must be a .md log name from the list');
    const content = await readTextSafe(path.join(SELF_DEV_DIR, base));
    if (content == null) throw new Error(`Log not found: ${base}`);
    return { name: base, content: content.slice(0, MAX_ARTIFACT_CHARS), truncated: content.length > MAX_ARTIFACT_CHARS };
  }
  let entries = [];
  try { entries = (await fs.readdir(SELF_DEV_DIR)).filter((f) => f.endsWith('.md')).sort().reverse(); } catch { /* none yet */ }
  const logs = [];
  for (const f of entries.slice(0, 10)) {
    const head = ((await readTextSafe(path.join(SELF_DEV_DIR, f))) || '').split('\n')[0];
    logs.push({ name: f, headline: head });
  }
  return { logs };
}

// ─── Capture tools (instant writes) ─────────────────────────────────────────

export async function toolAddBug({ project, text, severity = 'unassigned' } = {}) {
  ensureProject(project);
  if (!text || !String(text).trim()) throw new Error('"text" is required');
  if (!['critical', 'major', 'minor', 'unassigned'].includes(severity)) {
    throw new Error('severity must be critical|major|minor|unassigned');
  }
  const id = addBug({ project, raw_text: String(text).trim(), severity, source: 'chat' });
  return { ok: true, id, hint: `Bug #${id} captured in the inbox. Promote into a bug round with start_bug_round when ready.` };
}

export async function toolAddRequirement({ project, text } = {}) {
  ensureProject(project);
  if (!text || !String(text).trim()) throw new Error('"text" is required');
  const id = addRequirement({ project, raw_text: String(text).trim(), source: 'chat' });
  return { ok: true, id, hint: `Requirement #${id} captured in the inbox.` };
}

export async function toolWriteRawThoughts({ project, content, append = false } = {}) {
  ensureProject(project);
  if (typeof content !== 'string' || !content.trim()) throw new Error('"content" is required');
  const projDir = projectDirOf(project);
  await fs.mkdir(guideRoot(projDir), { recursive: true });
  const f = rawThoughtsPath(projDir);
  if (append) {
    const existing = (await readTextSafe(f)) || '';
    await fs.writeFile(f, existing ? `${existing.trimEnd()}\n\n${content}\n` : `${content}\n`, 'utf-8');
  } else {
    await fs.writeFile(f, content, 'utf-8');
  }
  return { ok: true, path: '.guide/raw-thoughts.md', hint: 'Run generate_brief to turn raw thoughts into a structured brief.' };
}

export async function toolSaveBrief({ project, content } = {}) {
  ensureProject(project);
  if (typeof content !== 'string' || !content.trim()) throw new Error('"content" is required');
  const projDir = projectDirOf(project);
  await fs.mkdir(guideRoot(projDir), { recursive: true });
  await fs.writeFile(briefPath(projDir), content, 'utf-8');
  return { ok: true, path: '.guide/brief.md' };
}

export async function toolQueueBrief({ project, filename, content } = {}) {
  ensureProject(project);
  const base = path.basename(String(filename || '').trim());
  if (!QUEUE_FILENAME_RE.test(base)) {
    throw new Error('filename must be alphanumeric (hyphens/underscores allowed) ending in .md, e.g. 01-auth-feature.md');
  }
  if (typeof content !== 'string' || !content.trim()) throw new Error('"content" is required');
  const queueDir = path.join(projectDirOf(project), 'inputs', 'queue');
  await fs.mkdir(queueDir, { recursive: true });
  await fs.writeFile(path.join(queueDir, base), content, 'utf-8');
  return { ok: true, filename: base, hint: 'Queued. brief_chain runs every queued brief end-to-end in filename order.' };
}

export async function toolRemoveQueuedBrief({ project, filename } = {}) {
  ensureProject(project);
  const base = path.basename(String(filename || '').trim());
  if (!QUEUE_FILENAME_RE.test(base)) throw new Error('Invalid filename');
  try {
    await fs.unlink(path.join(projectDirOf(project), 'inputs', 'queue', base));
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`Queue file not found: ${base}`);
    throw e;
  }
  return { ok: true, removed: base };
}

// ─── Action tools (detached orchestrator work) ──────────────────────────────

export async function toolCreateProject({ name, tech = '', profile = null } = {}) {
  if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
    throw new Error('"name" is required: alphanumeric with hyphens/underscores');
  }
  if (getProject(name)) throw new Error(`Project already exists: ${name}`);
  const { createProject } = await import('../commands/create-project.js');
  const result = await createProject({ name, tech, profile, onProgress: (m) => console.error(`[create] ${m}`) });
  return { ok: true, name, ...((result && typeof result === 'object') ? result : {}), hint: 'Next: write_raw_thoughts with the feature ideas, then generate_brief.' };
}

export async function toolGenerateBrief({ project } = {}) {
  ensureProject(project);
  // R5 — the `brief` command drafts from raw-thoughts / an existing brief /
  // the requirements inbox. With none of those present it silently no-ops, and
  // an autonomous chain would then plan+build on a phantom brief. Refuse early.
  const projDir = projectDirOf(project);
  const hasRaw = !!(await statSafe(rawThoughtsPath(projDir)));
  const hasBrief = !!(await statSafe(briefPath(projDir)));
  const hasReqs = inboxCount(countRequirements(project)) > 0;
  if (!hasRaw && !hasBrief && !hasReqs) {
    throw new Error(`Nothing to brief from for ${project} — no raw-thoughts.md, no brief.md, and an empty requirements inbox. Capture ideas with write_raw_thoughts (or add_requirement) first.`);
  }
  const queued = queueDurableAction(project, 'brief');
  return { started: true, jobId: queued.jobId, scheduled: queued.scheduled, action: 'brief', hint: 'Drafting .guide/brief.md from raw-thoughts. Takes a few minutes — check project_overview for the new brief mtime, then review with read_artifact.' };
}

export async function toolPlanProject({ project } = {}) {
  ensureProject(project);
  assertNoActiveRun(project);
  // R5 — planning reads brief.md; without it the guide has no input and the
  // step no-ops, leaving the chain to "run" an empty plan.
  if (!(await statSafe(briefPath(projectDirOf(project))))) {
    throw new Error(`No brief.md for ${project} — generate_brief (or save_brief) before plan_project.`);
  }
  const queued = queueDurableAction(project, 'guide', { task: 'plan' });
  return { started: true, jobId: queued.jobId, scheduled: queued.scheduled, action: 'plan', hint: 'Guide is writing plan.json from brief.md. Check project_overview for the phase list, then start_run to execute.' };
}

export async function toolStartRun({ project, mode = 'standard' } = {}) {
  ensureProject(project);
  assertNoActiveRun(project);
  if (!['standard', 'unattended', 'launch'].includes(mode)) {
    throw new Error('"mode" must be standard|unattended|launch');
  }
  const queued = queueDurableAction(project, 'go', { unattended: mode !== 'standard' });
  // Phase 63 (P7): append the deterministic window forecast to the reply so the
  // operator sees "will pause at phase 9 / wait ~30m for full fit" at launch
  // time. Best-effort — a forecast hiccup must never fail starting the run.
  let forecastLine = '';
  try {
    const { forecastRun, renderForecastLine } = await import('../commands/predict.js');
    forecastLine = renderForecastLine(await forecastRun(project));
  } catch { /* advisory only */ }
  return {
    started: true, jobId: queued.jobId, scheduled: queued.scheduled, action: `go (${mode})`,
    forecast: forecastLine || null,
    hint: `Auto-run started. Track with list_projects / project_overview; abort with abort_run.${forecastLine ? ' ' + forecastLine : ''}`,
  };
}

export async function toolBriefChain({ project } = {}) {
  ensureProject(project);
  assertNoActiveRun(project);
  const queueDir = path.join(projectDirOf(project), 'inputs', 'queue');
  let files = [];
  try { files = (await fs.readdir(queueDir)).filter((f) => f.endsWith('.md')); } catch { /* none */ }
  if (files.length === 0) throw new Error('Brief queue is empty — add briefs with queue_brief first.');
  const queued = queueDurableAction(project, 'brief-chain', { unattended: true });
  return { started: true, jobId: queued.jobId, scheduled: queued.scheduled, action: 'brief-chain', queued: files.sort(), hint: `Running ${files.length} queued brief(s) end-to-end (brief → plan → build each).` };
}

export async function toolRunNextPhase({ project } = {}) {
  ensureProject(project);
  assertNoActiveRun(project);
  const queued = queueDurableAction(project, 'next');
  return { started: true, jobId: queued.jobId, scheduled: queued.scheduled, action: 'next', hint: 'Running the next dev phase only. project_overview shows phase status when done.' };
}

export async function toolResumeRun({ project } = {}) {
  ensureProject(project);
  const active = getActiveAutoRun(project);
  if (active) throw new Error(`Run #${active.id} is already active for ${project}.`);
  const last = getLastAutoRun(project);
  // 'failed' is a real terminal status now (endAutoRunTerminal) — such runs
  // are still resumable: phase state is intact and autoRun picks up from it.
  if (!last || !['paused', 'failed'].includes(last.status)) {
    throw new Error(`Nothing to resume for ${project} (last run: ${last ? last.status : 'none'}). Use start_run instead.`);
  }
  const queued = enqueueUniqueResumeJob({ project, args: { unattended: !!last.unattended }, requestedBy: null });
  return { started: true, jobId: queued.jobId, scheduled: queued.scheduled, action: 'resume' };
}

export async function toolAbortRun({ project } = {}) {
  assertNotAutopilotTick('abort_run');
  ensureProject(project);
  const active = getActiveAutoRun(project);
  if (!active) throw new Error(`No active auto-run for ${project}.`);
  // R3 — actually STOP the run. The old path only wrote auto_runs.status =
  // 'aborted', but the runner loop never polls that flag (its sole stop signal
  // is an in-process SIGINT), so the detached run kept executing the whole
  // phase chain, burning budget, "aborted" on paper only. Send SIGINT to the
  // real owner pid (from the running_jobs claim): the runner's SIGINT handler
  // SIGTERMs its child claude subprocesses and finalizes the run as 'cancelled'
  // — the same clean stop a Ctrl-C gives. Fall back to the ledger write only
  // when no live owner exists (already-dead run — just reconcile the row).
  const queueJobs = getRunningJobsForProject(project);
  if (queueJobs.length > 0) {
    const cancelling = queueJobs
      .filter((job) => requestJobCancellation(job.id, 'cancelled from chat control'))
      .map((job) => job.id);
    return {
      ok: true,
      aborted_run: active.id,
      cancellation_requested: cancelling,
      hint: 'The owning worker will terminate the exact Claude process group and finalize the run as cancelled.',
    };
  }

  const claim = getRunningJob(project);
  let signaled = false;
  if (claim && pidAlive(claim.pid)) {
    try { process.kill(claim.pid, 'SIGINT'); signaled = true; }
    catch (e) { console.error(`[control] abort SIGINT to pid ${claim.pid} failed: ${e.message}`); }
  }
  if (!signaled) {
    const db = getDb();
    db.prepare(`UPDATE auto_runs SET status='aborted', ended_at=? WHERE id=?`).run(new Date().toISOString(), active.id);
    db.prepare(`UPDATE projects SET status='cancelled' WHERE name=?`).run(project);
  }
  return {
    ok: true,
    aborted_run: active.id,
    signaled,
    pid: claim?.pid ?? null,
    hint: signaled
      ? 'SIGINT sent to the live run — it finalizes as cancelled at the current checkpoint and SIGTERMs its subprocesses. Confirm with project_overview in a few seconds.'
      : 'No live run process was found; reconciled the ledger to aborted directly.',
  };
}

// retry_phase — surgical single-phase recovery (audit capability gap #1). Resets
// one phase to pending and hard-reverts the workspace to its parent commit, so
// the autonomous loop can redo just that phase instead of aborting the whole run
// (previously its ONLY recovery). A git+DB op (no Claude cost); refuses under a
// live run; force:true skips the CLI's interactive confirm (there is no TTY here).
export async function toolRetryPhase({ project, phase, dry_run = false } = {}) {
  ensureProject(project);
  const n = Number(phase);
  if (!Number.isInteger(n) || n < 1) throw new Error('"phase" must be a positive integer (the phase number to retry).');
  assertNoActiveRun(project);
  const { retryPhase } = await import('../commands/retry-phase.js');
  const result = await retryPhase({ projectName: project, phaseN: n, force: true, dryRun: !!dry_run });
  return {
    ok: true,
    project,
    phase: n,
    dry_run: !!dry_run,
    ...(result && typeof result === 'object' ? result : {}),
    hint: dry_run
      ? 'Dry run — nothing changed. Call again without dry_run to reset the phase and revert the workspace.'
      : `Phase ${n} reset to pending and workspace hard-reverted to its parent commit. Redo just this phase with run_next_phase (or start_run to continue the chain).`,
  };
}

export async function toolStartBugRound({ project } = {}) {
  ensureProject(project);
  assertNoActiveRun(project);
  // R5 — `bugs` plans fixes for the newest bug ROUND (a bug-rounds/round-N/
  // bugs.md, created by promote_bugs). With no round on disk it no-ops; guide
  // the caller to the capture→promote step instead of a silent success.
  const round = await detectHighestBugRound(projectDirOf(project));
  if (!round) {
    const pending = inboxCount(countBugs(project));
    throw new Error(
      `No bug round to fix for ${project}${pending ? ` (${pending} bug(s) still in the inbox — promote_bugs to drop a round first)` : ' — capture bugs with add_bug, then promote_bugs to create a round'}.`,
    );
  }
  const queued = queueDurableAction(project, 'bugs');
  return { started: true, jobId: queued.jobId, scheduled: queued.scheduled, action: 'bugs', round, hint: `Planning fixes for bug round ${round}. When the plan is ready, start_run executes the fixes.` };
}

export async function toolRunAudit({ project, chain = false, rounds = null } = {}) {
  ensureProject(project);
  assertNoActiveRun(project);
  const safeRounds = chain && rounds ? Math.max(1, Math.min(10, Number(rounds) || 1)) : null;
  const queued = queueDurableAction(project, 'audit', {
    chain: !!chain,
    ...(safeRounds ? { rounds: safeRounds } : {}),
  });
  return { started: true, jobId: queued.jobId, scheduled: queued.scheduled, action: chain ? `audit --auto${safeRounds ? ` ×${safeRounds}` : ''}` : 'audit', hint: chain ? 'Audit → promote → fix loop running unattended until clean or a blocker.' : 'Audit only — findings land in .guide/audits/; promote + fix separately.' };
}

export async function toolRunPipeline({ project } = {}) {
  ensureProject(project);
  assertNoActiveRun(project);
  const queued = queueDurableAction(project, 'pipeline');
  return { started: true, jobId: queued.jobId, scheduled: queued.scheduled, action: 'pipeline', hint: 'Full autopilot: intake → brief → build → bug inbox → audit→fix → QA handoff. Stops at the ship gate.' };
}

export async function toolShipProject({ project, confirm = false, tag = null } = {}) {
  assertNotAutopilotTick('ship_project');
  ensureProject(project);
  if (confirm !== true) {
    throw new Error('ship_project merges the working branch to main — call again with confirm:true ONLY after the user has explicitly confirmed in this conversation.');
  }
  const queued = queueDurableAction(project, 'ship', tag ? { tag: String(tag) } : {});
  return { started: true, jobId: queued.jobId, scheduled: queued.scheduled, action: 'ship' };
}

// orchestrator_dev — dev on the ORCHESTRATOR REPO ITSELF via scripts/self-dev.mjs
// (detached). The script refuses a dirty tree, gates config changes on
// test:config, stages everything except projects/state/logs, commits (never
// pushes), and journals to logs/self-dev/ (readable via self_dev_log).
export async function toolOrchestratorDev({ task, confirm = false, commit = true } = {}) {
  assertNotAutopilotTick('orchestrator_dev');
  if (!task || typeof task !== 'string' || task.trim().length < 20) {
    throw new Error('"task" must be a concrete description (≥20 chars): what to change/fix, where if known, and how to verify.');
  }
  if (confirm !== true) {
    throw new Error('orchestrator_dev edits the LIVE orchestrator source and commits — call again with confirm:true ONLY after the user has explicitly confirmed in this conversation.');
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.mkdir(SELF_DEV_DIR, { recursive: true });
  const taskFile = path.join(SELF_DEV_DIR, `${ts}-task.md`);
  await fs.writeFile(taskFile, task.trim() + '\n', 'utf-8');
  const argv = ['--task-file', taskFile];
  if (!commit) argv.push('--no-commit');
  const pid = spawnDetached(argv, { script: path.join(SCRIPTS_DIR, 'self-dev.mjs'), project: '__self__', action: 'orchestrator-dev' });
  return {
    started: true,
    pid,
    action: 'self-dev',
    task_log: path.basename(taskFile),
    hint: `Dev agent working on the orchestrator repo (takes minutes). Check progress/outcome with self_dev_log — the result file will be ${ts}-result.md. It commits on the current branch but never pushes.`,
  };
}

// orchestrator_pull — smart self-update: pull + auto npm-install + optional restart.
// Reports exactly what changed so the agent can decide whether to restart the
// web server (via self_restart_ui) or just report the change summary.
export async function toolOrchestratorPull({ restart_ui = false } = {}) {
  const { pull, applyPull, restartWebServer } = await import('../lib/self-updater.js');
  const result = await pull();

  if (!result.updated) {
    return { ok: true, updated: false, branch: result.branch, hint: 'Already up to date — nothing to apply.' };
  }

  const apply = await applyPull(result);
  const { diff } = result;

  let restarted = false;
  if (restart_ui && diff.needsWebRestart) {
    await restartWebServer();
    restarted = true;
  }

  const steps = [];
  if (apply.installedDeps)  steps.push('✓ npm install completed');
  if (apply.error)          steps.push(`⚠ npm install failed: ${apply.error}`);
  if (restarted)            steps.push('✓ web server restart queued (back in ~5 s)');

  const pending = [];
  if (diff.needsWebRestart && !restarted) pending.push('restart web UI (`self_restart_ui` or `npm run web`)');
  if (diff.needsMcpRestart) pending.push('restart MCP/bot servers if running');

  return {
    ok: true, updated: true,
    branch: result.branch,
    from: result.from, to: result.to,
    changedCategories: diff.changedCategories,
    changedFiles: result.changedFiles.slice(0, 40),
    steps,
    pendingManualSteps: pending,
    hint: pending.length
      ? `Pulled ${result.from}→${result.to}. ${pending.map((p) => `Action needed: ${p}`).join(' | ')}`
      : `Pulled ${result.from}→${result.to}. All changes applied.`,
  };
}

// self_status — detailed orchestrator health snapshot.
export async function toolSelfStatus() {
  const { selfHealth } = await import('../lib/self-updater.js');
  const h = await selfHealth();
  const lines = [
    `Branch: ${h.git.branch || '?'}  SHA: ${h.git.sha || '?'}`,
    `Tree: ${h.git.clean ? 'clean' : 'dirty (uncommitted changes)'}`,
    h.git.commit ? `Last commit: "${h.git.commit.subject}" by ${h.git.commit.author} (${h.git.commit.ago})` : 'Last commit: unknown',
    '',
    `Web server PID: ${h.webServer.pid || 'unknown'}  alive: ${h.webServer.alive ? 'yes' : 'NO'}`,
    h.webServer.alive && h.webServer.stale
      ? `⚠ STALE — server is running code from ${h.webServer.deployedSha}, HEAD is ${h.git.sha}. Restart needed.`
      : h.webServer.alive
        ? `✓ up to date (deployed sha matches HEAD)`
        : h.webServer.pid ? '✗ web server process is dead' : 'Web server not tracked (start with npm run web)',
  ];
  return { health: h, summary: lines.join('\n') };
}

// self_restart_ui — gracefully restart the web server.
// Spawns a new server process and kills the old PID after a short delay
// so the current chat response can be sent before the socket closes.
export async function toolSelfRestartUi({ port = 4242 } = {}) {
  const { restartWebServer, readDeployedPid, pidAlive } = await import('../lib/self-updater.js');
  const oldPid = await readDeployedPid();
  if (oldPid && !pidAlive(oldPid)) {
    // Dead already — just start fresh without waiting
    await restartWebServer({ port, delaySec: 0 });
    return { ok: true, action: 'started', hint: 'Web server was not running — started fresh on port ' + port };
  }
  await restartWebServer({ port, delaySec: 3 });
  return {
    ok: true, action: 'restart_queued', killedPid: oldPid,
    hint: `Web server (pid ${oldPid}) will be replaced in ~5 s on port ${port}. The UI will reconnect automatically.`,
  };
}

// ─── Discussions (multi-agent panel) ─────────────────────────────────────────

export async function toolStartDiscussion({ project, topic, mode = 'auto', auto_start = false, confirm = false } = {}) {
  ensureProject(project);
  if (!topic || String(topic).trim().length < 10) throw new Error('"topic" must be a real question/decision (≥10 chars), e.g. "Should we move caption timing to server-side rendering?"');
  if (!['auto', 'medium', 'max'].includes(mode)) throw new Error('"mode" must be auto (3-5 agents) | medium (5-7) | max (8-12)');
  if (auto_start) {
    assertNotAutopilotTick('start_discussion with auto_start');
    if (confirm !== true) throw new Error('auto_start:true appends the conclusions to the brief AND starts the unattended dev pipeline — call again with confirm:true ONLY after the user explicitly confirmed that.');
    assertNoActiveRun(project);
  }
  const queued = queueDurableAction(project, 'discuss', {
    topic: String(topic).trim(),
    mode,
    autoStart: !!auto_start,
  });
  return {
    started: true, jobId: queued.jobId, scheduled: queued.scheduled, action: `discussion (${mode}${auto_start ? ', auto-start' : ''})`,
    hint: auto_start
      ? 'Panel running; conclusions will be appended to the brief and dev starts automatically. Track with list_discussions / project_overview.'
      : 'Panel running (takes several minutes, multiple agents). Check list_discussions for status, then discussion_result for the conclusions; the brief stays unchanged until you act on them.',
  };
}

export async function toolListDiscussions({ project } = {}) {
  ensureProject(project);
  return {
    discussions: listDiscussions(project, 20).map((d) => ({
      id: d.id, status: d.status, mode: d.mode, topic: d.topic, created_at: d.created_at, completed_at: d.completed_at,
    })),
  };
}

export async function toolDiscussionResult({ id } = {}) {
  const discId = Number(id);
  const disc = getDiscussion(discId);
  if (!disc) throw new Error(`Discussion not found: ${id}`);
  const conclusionRow = getDiscConclusion(discId);
  let conclusion = null;
  if (conclusionRow?.synthesis) {
    try { conclusion = JSON.parse(conclusionRow.synthesis); } catch { conclusion = { raw: conclusionRow.synthesis.slice(0, 8000) }; }
  }
  return {
    discussion: { id: disc.id, project: disc.project, topic: disc.topic, mode: disc.mode, status: disc.status, created_at: disc.created_at },
    agents: getDiscAgents(discId).map((a) => ({ role: a.role, expertise: a.expertise })),
    conclusion,
    transcript: `read_artifact path ".guide/discussions/${discId}/discussion.md" on project ${disc.project}`,
  };
}

// ─── Suggestions ("what should we improve next?") ────────────────────────────

function trimSuggestionsRow(row) {
  if (!row) return null;
  let suggestions = [];
  try { suggestions = JSON.parse(row.suggestions_json || '[]'); } catch { /* keep [] */ }
  return {
    id: row.id,
    status: row.status,
    next_pass: row.next_pass,
    created_at: row.created_at,
    suggestions: suggestions.map((s) => ({ id: s.id, title: s.title, area: s.area, impact: s.impact, effort: s.effort, description: (s.description || '').slice(0, 200) })),
  };
}

export async function toolScanSuggestions({ project, areas = [] } = {}) {
  ensureProject(project);
  // Rules engine only (instant, no Claude call) — same path as the web UI's
  // non-AI scan (_runScan in web-ui.js). The AI-powered scan stays in the web UI.
  const snapshot = await scanProject(projectDirOf(project));
  const raw = generateSuggestions(snapshot);
  const suggestions = Array.isArray(areas) && areas.length > 0 ? filterSuggestions(raw, areas) : raw;
  staleDraftSuggestions(project);
  const newId = saveSuggestions(project, { projectType: snapshot.projectType, scanSnapshot: snapshot, suggestions });
  return {
    ...trimSuggestionsRow(getSuggestionsById(newId)),
    hint: 'Present the best items to the user; on approval call accept_suggestions with the chosen ids, then start_run executes the plan.',
  };
}

export async function toolGetSuggestions({ project } = {}) {
  ensureProject(project);
  const row = getFreshestSuggestions(project);
  if (!row) return { suggestions: null, hint: 'No suggestions yet — run scan_suggestions.' };
  return trimSuggestionsRow(row);
}

export async function toolAcceptSuggestions({ project, ids, passes = 1 } = {}) {
  ensureProject(project);
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('"ids" must be a non-empty array of suggestion ids from get_suggestions/scan_suggestions');
  const nPasses = Number(passes);
  if (!Number.isInteger(nPasses) || nPasses < 1 || nPasses > 5) throw new Error('"passes" must be an integer 1-5');
  const row = getFreshestSuggestions(project);
  if (!row) throw new Error('No suggestions row — run scan_suggestions first.');
  let stored = [];
  try { stored = JSON.parse(row.suggestions_json || '[]'); } catch { /* keep [] */ }
  const byId = new Map(stored.map((s) => [s.id, s]));
  const selected = ids.map((i) => byId.get(i)).filter(Boolean);
  if (!selected.length) throw new Error(`None of the given ids exist in suggestions row #${row.id} — re-check with get_suggestions.`);
  const pipelinePlan = assignToPasses(selected, nPasses);
  acceptSuggestions(row.id, { selected, pipelinePlan, pipelinePasses: nPasses });
  const { writeSuggestionsFile } = await import('../commands/suggest.js');
  await writeSuggestionsFile(projectDirOf(project), project, selected, pipelinePlan, nPasses);
  return { ok: true, accepted: selected.map((s) => s.title), passes: nPasses, hint: 'Plan written — start_run executes it (the guide plans from the accepted suggestions).' };
}

// ─── Quality & lifecycle (guide tasks, detached) ─────────────────────────────

export async function toolRunRoadmap({ project } = {}) {
  ensureProject(project);
  assertNoActiveRun(project);
  const queued = queueDurableAction(project, 'roadmap');
  return { started: true, jobId: queued.jobId, scheduled: queued.scheduled, action: 'roadmap', hint: 'Roadmap lands in .guide/roadmaps/ — read it with read_artifact when done.' };
}

export async function toolRunRetro({ project } = {}) {
  ensureProject(project);
  const queued = queueDurableAction(project, 'retro');
  return { started: true, jobId: queued.jobId, scheduled: queued.scheduled, action: 'retro', hint: 'Telemetry retrospective — config-tuning proposals land in docs/retro/ of the orchestrator repo.' };
}

export async function toolRunReview({ project } = {}) {
  ensureProject(project);
  assertNoActiveRun(project);
  const queued = queueDurableAction(project, 'review');
  return { started: true, jobId: queued.jobId, scheduled: queued.scheduled, action: 'review', hint: 'Guide review — lands in .guide/reviews/.' };
}

export async function toolRunValidators({ project } = {}) {
  ensureProject(project);
  assertNoActiveRun(project);
  const queued = queueDurableAction(project, 'validate');
  return { started: true, jobId: queued.jobId, scheduled: queued.scheduled, action: 'validate', hint: 'External validators (build/tests/lint) running against the workspace.' };
}

export async function toolGuideHandoff({ project } = {}) {
  ensureProject(project);
  assertNoActiveRun(project);
  const queued = queueDurableAction(project, 'handoff');
  return { started: true, jobId: queued.jobId, scheduled: queued.scheduled, action: 'handoff', hint: 'Guide handoff doc + fresh guide session.' };
}

export async function toolSyncProject({ project } = {}) {
  const p = ensureProject(project);
  assertNoActiveRun(project);
  if (!p.git_branch) throw new Error(`${project} has no git branch configured — nothing to sync.`);
  const queued = queueDurableAction(project, 'sync');
  return { started: true, jobId: queued.jobId, scheduled: queued.scheduled, action: 'sync' };
}

export async function toolRefreshContext({ project } = {}) {
  ensureProject(project);
  assertNoActiveRun(project);
  const queued = queueDurableAction(project, 'guide', { task: 'project-context-gen' });
  return { started: true, jobId: queued.jobId, scheduled: queued.scheduled, action: 'context', hint: 'Regenerating .guide/project-context.md.' };
}

// Phase 64 (intent-based checkpointing) — set a project's checkpoint policy by
// writing overrides.auto_run.checkpoint_policy into projects/<name>/project.json
// (mirrors the web-ui PATCH-config override write). VALIDATES before writing:
// a bad mode/intent throws naming the config layer (projects/<name>/project.json)
// via validateCheckpointPolicy, the same convention config-validator uses.
export async function toolSetCheckpointPolicy({ project, mode, pause_intents = null } = {}) {
  ensureProject(project);
  const configLayer = `projects/${project}/project.json`;
  if (mode == null) {
    throw new Error(`Invalid checkpoint_policy in ${configLayer}: "mode" is required (all | intent | errors-only)`);
  }
  const policy = { mode };
  if (pause_intents != null) policy.pause_intents = pause_intents;
  validateCheckpointPolicy(policy, configLayer); // throws on a bad mode/intent, naming the layer

  const pjPath = path.join(projectDirOf(project), 'project.json');
  const pj = (await readJsonSafe(pjPath)) || {};
  pj.overrides = pj.overrides || {};
  pj.overrides.auto_run = pj.overrides.auto_run || {};
  pj.overrides.auto_run.checkpoint_policy = policy;
  await fs.writeFile(pjPath, JSON.stringify(pj, null, 2), 'utf-8');
  return {
    ok: true,
    project,
    path: configLayer,
    checkpoint_policy: policy,
    hint: `Checkpoint policy set to '${mode}'${policy.pause_intents ? ` (pause before: ${policy.pause_intents.join(', ')})` : ''}. Takes effect on the next run.`,
  };
}

// ─── Instant lifecycle writes ────────────────────────────────────────────────

export async function toolMarkQa({ project, shipped = false } = {}) {
  ensureProject(project);
  setProjectStatus(project, shipped ? 'completed' : 'ready-for-qa');
  return { ok: true, status: shipped ? 'completed' : 'ready-for-qa' };
}

export async function toolPromoteAudit({ project } = {}) {
  ensureProject(project);
  const result = await promoteAuditToBugs({ projDir: projectDirOf(project), projectName: project });
  if (!result.promoted) throw new Error(result.reason || 'Nothing to promote (clean audit or already promoted).');
  return { ok: true, round: result.round, warning: result.warning || null, hint: `Findings are now bugs round ${result.round} — start_bug_round plans the fixes, then start_run executes them.` };
}

export async function toolPromoteBugs({ project, ids = null, severity = null } = {}) {
  ensureProject(project);
  const { performBugPromote } = await import('../commands/bugs-inbox.js');
  const idList = Array.isArray(ids) && ids.length ? ids.map(Number).filter(Boolean) : null;
  const result = await performBugPromote({ project, ids: idList, severity: severity || null });
  return { ok: true, round: result.round, promoted: result.promotedIds, hint: `bugs.md created for round ${result.round} — start_bug_round plans the fixes, then start_run executes them.` };
}

export async function toolPromoteRequirements({ project, scope = 'now' } = {}) {
  ensureProject(project);
  const { cmdPromote } = await import('../commands/requirements.js');
  await cmdPromote(project, { scope });
  return { ok: true, hint: 'Refined requirements appended to raw-thoughts.md — generate_brief folds them into the brief, then plan + run.' };
}

export async function toolWorkspaceShell({ project, command, timeout_ms = 60000 } = {}) {
  ensureProject(project);
  if (!command || typeof command !== 'string' || !command.trim()) {
    throw new Error('"command" is required');
  }
  // R7 — the old denylist blocked only `rm -rf /`, mkfs, dd-to-device and fork
  // bombs, so `rm -rf .`, `rm -rf *`, `git reset --hard` and `git push -f` all
  // sailed through and returned {ok:true}. An autonomous agent issuing a
  // well-intentioned-but-wrong command could nuke workspace state or rewrite
  // history irreversibly. Block the irreversible/destructive shapes; ordinary
  // dev commands (relative rm, npm, build, git commit/status/pull) still pass.
  // Leading git global options (`-C <dir>`, `-c a=b`, `--git-dir=…`) must be
  // tolerated before the dangerous subcommand — `git -C /repo push` bypassed the
  // old `\bgit\s+push\b` adjacency. Each option is `-flag` optionally followed by
  // one non-flag argument. Only `-flag` tokens are skipped, so `git commit -m
  // "…push…"` never matches (commit is not a flag → subcommand must follow git).
  const gitPre = String.raw`\bgit\s+(?:-\S+(?:\s+[^\s-]\S*)?\s+)*`;
  const DANGEROUS = [
    { re: /\brm\s+(-{1,2}[a-zA-Z][a-zA-Z-]*\s+)+(\/|~|\*|\.(\s|$)|\.\/(\s|$))/, why: 'flagged rm targeting an absolute path, ~, *, or the workspace root (. or ./)' },
    { re: /\bmkfs\b/, why: 'filesystem format' },
    { re: /\bdd\b[^\n]*\bof=\/dev\//, why: 'dd to a block device' },
    { re: /:\s*\(\s*\)\s*\{/, why: 'fork bomb' },
    { re: new RegExp(gitPre + String.raw`push\b`), why: 'git push — publishing from the workspace shell is not allowed; use ship_project (escalates to a human) for releases' },
    { re: new RegExp(gitPre + String.raw`reset\s+--hard\b`), why: 'git reset --hard destroys uncommitted work' },
    { re: new RegExp(gitPre + String.raw`clean\s+(?:-\S*f\S*|--force)`), why: 'git clean -f deletes untracked files' },
    { re: />\s*\/dev\/(sd|nvme|disk|hd)/, why: 'overwriting a block device' },
  ];
  const hit = DANGEROUS.find((d) => d.re.test(command));
  if (hit) {
    throw new Error(`Command rejected (${hit.why}). This guardrail is intentional in chat — if you truly need it, ask the operator to run it directly.`);
  }
  const workspaceDir = path.join(PROJECTS_DIR, project, 'workspace');
  try { await fs.access(workspaceDir); } catch {
    throw new Error(`Workspace not found: projects/${project}/workspace`);
  }
  const ms = Math.min(Math.max(Number(timeout_ms) || 60000, 5000), 120000);
  try {
    const { stdout, stderr } = await execAsync(command, { cwd: workspaceDir, timeout: ms, maxBuffer: 10 * 1024 * 1024 });
    return { ok: true, stdout: stdout.slice(0, 10000), stderr: stderr.slice(0, 2000), cwd: `projects/${project}/workspace` };
  } catch (err) {
    return {
      ok: false,
      exit_code: err.code ?? null,
      stdout: String(err.stdout || '').slice(0, 10000),
      stderr: String(err.stderr || err.message || '').slice(0, 2000),
      cwd: `projects/${project}/workspace`,
    };
  }
}

// ─── Phase C capability tools (audit-flagged gaps) ──────────────────────────

// repair — reconcile DB state with plan.json across ALL projects (fixes
// total_phases drift, status stuck at ready-for-qa after a plan extension).
// State drift is exactly what wedges an unattended loop; this lets it self-heal.
// A DB op (no Claude cost); returns the concrete repairs it made.
export async function toolRepair() {
  const { repairProjectStates } = await import('../lib/state-repair.js');
  const { repairs, warnings } = await repairProjectStates({ verbose: false });
  return {
    ok: true,
    repaired: repairs.length,
    warnings: warnings.length,
    repairs,
    warnings_list: warnings,
    hint: (repairs.length || warnings.length)
      ? `Reconciled ${repairs.length} drift(s), ${warnings.length} warning(s).`
      : 'All projects consistent — nothing to repair.',
  };
}

// inspect_phase — what a phase actually was and changed: metadata + its report +
// a commit diffstat. read_artifact is jailed out of workspace/, so without this
// the agent is blind to what code a phase touched when root-causing a regression.
// (Full diff: workspace_shell `git show <sha>`.)
export async function toolInspectPhase({ project, phase } = {}) {
  ensureProject(project);
  const n = Number(phase);
  if (!Number.isInteger(n) || n < 1) throw new Error('"phase" must be a positive integer.');
  const ph = getPhases(project).find((p) => p.n === n);
  if (!ph) throw new Error(`Phase ${n} not found for ${project}.`);
  const projDir = projectDirOf(project);
  const report = await readTextSafe(await phaseReportPath(projDir, n, ph.title));
  let diffstat = null;
  if (ph.commit_sha) {
    try {
      const { stdout } = await execAsync(`git show --stat --format="%h %s (%an, %ad)" ${ph.commit_sha}`,
        { cwd: path.join(projDir, 'workspace'), timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
      diffstat = stdout.slice(0, 6000);
    } catch (e) { diffstat = `(diff unavailable: ${e.message})`; }
  }
  return {
    project, phase: n, title: ph.title, status: ph.status,
    commit_sha: ph.commit_sha || null, model_used: ph.model_used || null,
    started_at: ph.started_at || null, completed_at: ph.completed_at || null,
    report: report ? report.slice(0, MAX_ARTIFACT_CHARS) : null,
    diffstat,
    hint: ph.commit_sha ? `Full diff: workspace_shell → git show ${ph.commit_sha}` : 'No commit recorded for this phase.',
  };
}

// refine_inbox — AI-structure raw bug/requirement inbox text into
// title/repro/expected before promoting, so a promoted round carries structured
// findings instead of raw notes. Detached (a Sonnet pass over the inbox).
export async function toolRefineInbox({ project, kind = 'bug' } = {}) {
  ensureProject(project);
  if (kind !== 'bug' && kind !== 'requirement') throw new Error('"kind" must be "bug" or "requirement".');
  const argv = kind === 'bug' ? ['bug', 'refine', project] : ['req', 'refine', project];
  const pid = spawnDetached(argv, { project, action: `${kind}-refine` });
  return {
    started: true, pid, action: `${kind} refine`,
    hint: `AI-structuring the raw ${kind} inbox (Sonnet). When it lands, ${kind === 'bug' ? 'promote_bugs' : 'promote_requirements'} carries the structured version into the dev flow.`,
  };
}

// qa_handoff — generate a tester-facing QA markdown from a bug round or phase
// range (mark_qa only flips a flag; this produces the actual deliverable a human
// QA needs). Deterministic unless with_steps (one Opus call for manual steps).
export async function toolQaHandoff({ project, round = null, phases = null, with_steps = false } = {}) {
  ensureProject(project);
  const { generateQaHandoff } = await import('../commands/qa-handoff.js');
  const args = { withSteps: !!with_steps, outputPath: null };
  if (round != null) args.round = Number(round);
  if (phases) { const [s, e] = String(phases).split(':').map(Number); args.phaseStart = s; args.phaseEnd = e; }
  const result = await generateQaHandoff(project, args);
  return {
    ok: true, project, with_steps: !!with_steps,
    ...(result && typeof result === 'object' ? result : { result }),
    hint: 'QA handoff markdown generated — read it with read_artifact (path is in this result), then hand to the tester or mark_qa.',
  };
}

// roadmap_accept — execute a generated roadmap: spawn a new project from selected
// items, or append them to a project's requirements inbox. Detached (the CLI
// path spawns work / creates a project and uses process.exit on bad input).
export async function toolRoadmapAccept({ project, mode, target = null, items = 'all', profile = null } = {}) {
  ensureProject(project);
  if (mode !== 'new-project' && mode !== 'to-inbox') throw new Error('"mode" must be "new-project" or "to-inbox".');
  if (!target || !String(target).trim()) {
    throw new Error(mode === 'new-project' ? '"target" is required (name for the new project).' : '"target" is required (project to append to, or "_inbox").');
  }
  if (!(await findMostRecentRoadmap(projectDirOf(project)))) {
    throw new Error(`No roadmap found for ${project} — run_roadmap first, then roadmap_accept.`);
  }
  const argv = ['roadmap-accept', project];
  if (items === 'all' || items == null) argv.push('--all');
  else argv.push('--items', String(items));
  if (mode === 'new-project') { argv.push('--new-project', String(target)); if (profile) argv.push('--profile', String(profile)); }
  else argv.push('--to-inbox', String(target));
  const pid = spawnDetached(argv, { project, action: 'roadmap-accept' });
  return {
    started: true, pid, action: 'roadmap-accept', mode, target, items,
    hint: mode === 'new-project'
      ? `Spawning new project "${target}" from roadmap items ${items}.`
      : `Appending roadmap items ${items} to ${target}'s requirements inbox.`,
  };
}

// set_autopilot — turn drive-to-done ON/OFF for THIS chat thread. Thread id
// comes from AORCH_CHAT_THREAD_ID (control-server sets it from --thread). When
// ON, chat-autopilot.js re-invokes this thread whenever there's a reason to act
// and drives the goal to completion, escalating ship/orchestrator_dev/abort.
export async function toolSetAutopilot({ enabled = true, goal = null } = {}) {
  const threadId = Number(process.env.AORCH_CHAT_THREAD_ID);
  if (!threadId) {
    throw new Error('set_autopilot is only available from inside a chat thread (no thread context found).');
  }
  const on = enabled !== false;
  // Self-arming is operator-only: a tick may turn autopilot OFF (reduces
  // autonomy) but never (re-)arm its own thread for unattended looping.
  if (on) assertNotAutopilotTick('set_autopilot enabled:true');
  if (on && (!goal || String(goal).trim().length < 8)) {
    throw new Error('When turning autopilot ON, pass a concrete `goal` (≥8 chars) — what "done" means, so the loop knows when to stop.');
  }
  const row = setThreadAutopilot(threadId, { enabled: on, goal: on ? String(goal).trim() : null });
  return {
    ok: true,
    thread_id: threadId,
    autopilot: !!row?.autopilot,
    goal: row?.autopilot_goal || null,
    hint: on
      ? 'Autopilot ON — I will keep driving this thread toward the goal on my own (running, auditing, fixing within budget), escalating ship / orchestrator_dev / abort to you. Needs the server-side autopilot flag enabled (config chat.autopilot.enabled or AORCH_CHAT_AUTOPILOT=1); until then this thread is armed but idle.'
      : 'Autopilot OFF for this thread — back to one turn per message.',
  };
}

// ─── Tool registry (shared by the MCP server) ────────────────────────────────

const str = (description) => ({ type: 'string', description });
const projectProp = { project: str('Project name (exact, from list_projects).') };

export const TOOL_DETAILS_BY_NAME = {
  list_projects: {
    description: 'List every project with status, phase progress, live run state, pause reason, and inbox counts. Cheap — call whenever unsure about names or states.',
    inputSchema: { type: 'object', properties: {} },
  },
  project_overview: {
    description: 'Deep status of one project: phases, active/last run, plan + brief state, brief queue, inbox counts, latest suggestions, recent healing, lifetime cost.',
    inputSchema: { type: 'object', properties: { ...projectProp }, required: ['project'] },
  },
  read_artifact: {
    description: 'Read a project file under .guide/ or inputs/ (brief.md, plan.md, plan.json, reviews, audits, phase reports, queued briefs). Max 20k chars.',
    inputSchema: { type: 'object', properties: { ...projectProp, path: str('Project-relative path, e.g. ".guide/brief.md" or "inputs/queue/01-auth.md".') }, required: ['project', 'path'] },
  },
  window_status: {
    description: 'Billing window status: calls + cost in the current 5-hour window vs pause thresholds. Check before starting expensive work.',
    inputSchema: { type: 'object', properties: {} },
  },
  list_jobs: {
    description: 'Job queue snapshot (running / pending / recent bot jobs), optionally filtered to one project.',
    inputSchema: { type: 'object', properties: { project: str('Optional project filter.') } },
  },
  list_inbox: {
    description: 'List inbox items awaiting triage for a project.',
    inputSchema: { type: 'object', properties: { ...projectProp, kind: { type: 'string', enum: ['bugs', 'requirements'], description: 'Which inbox.' } }, required: ['project'] },
  },
  spend_report: {
    description: 'Spend summary by project over the last N days.',
    inputSchema: { type: 'object', properties: { project: str('Optional project filter.'), days: { type: 'integer', minimum: 1, maximum: 365, description: 'Window in days (default 30).' } } },
  },
  predict: {
    description: 'Forecast the cost of a project\'s upcoming dev work (pending phases or bug round) from historical telemetry — ZERO Claude calls. Returns estimated cost/calls/duration and how it lands against the call-cap budget (wouldExceed). Use before an expensive start_run / run_pipeline to self-gate spend, especially in autopilot within a budget.',
    inputSchema: { type: 'object', properties: { ...projectProp }, required: ['project'] },
  },
  read_upload: {
    description: 'Read a file the user attached to the chat (stored name from the <attachments> block). Text files return content; png/jpg/gif/webp return the actual image for you to look at.',
    inputSchema: { type: 'object', properties: { name: str('Stored upload name, exactly as listed in the message attachments.') }, required: ['name'] },
  },
  self_dev_log: {
    description: 'List (no args) or read (name) the journals of orchestrator_dev runs — use this to report whether a self-dev task finished, committed, or failed.',
    inputSchema: { type: 'object', properties: { name: str('Optional log filename from the list, e.g. "2026-07-06T…-result.md".') } },
  },
  get_run_timeline: {
    description: 'Append-only per-run timeline — "what happened during run N?" in one call: run-started, plan-created, phase-started, dev-completed/failed, reprompt, escalated, heal-attempt, acceptance-pass/fail, review-verdict, fix events, audit-completed, bugs-promoted, and the closing pause/complete. Omit run_id for the project\'s most recent run. A legacy run with no recorded events returns events:[] (report "no timeline recorded").',
    inputSchema: { type: 'object', properties: { ...projectProp, run_id: { type: 'integer', description: 'Auto-run id (from list_jobs / project_overview). Omit for the most recent run.' } }, required: ['project'] },
  },
  get_live_progress: {
    description: 'What a project\'s run is doing RIGHT NOW — turn count vs the max-turns cap, the current tool (with elapsed), how many files it has touched, and a rough ETA — read from the live in-flight telemetry row (zero Claude calls). Returns state:"idle" with progress:null when nothing is running. Use to answer "what\'s it doing / how far along is it" without tailing logs.',
    inputSchema: { type: 'object', properties: { ...projectProp }, required: ['project'] },
  },
  get_quality_report: {
    description: 'Quality signal over the last N days: acceptance first-pass rate, per-task escalation and turns, bug-round convergence, cache-hit trend, plus Hybrid Context Compiler attempts/failures, edit-target precision/recall, rollout mode, and matched shadow-vs-assist context-work estimates. Zero Claude calls. Compiler token numbers are advisory proxies, not a causal A/B result or Claude Max quota conversion.',
    inputSchema: { type: 'object', properties: { ...projectProp, days: { type: 'integer', minimum: 1, maximum: 365, description: 'Window in days (default 30). The cache-hit trend section always compares a fixed 7d vs 30d window regardless of this value.' } }, required: ['project'] },
  },
  explain_routing: {
    description: 'Why did this phase run on the model it ran on, and did an escalation chain resolve it? Returns the phase\'s calls in order (model, task, routing tier + reason, attempt/escalated, num_turns, is_error), the phase status, and the latest acceptance verdict. Zero Claude calls. Use to answer "why opus?" / "did it need a retry?" / "what happened during phase N\'s routing decisions?".',
    inputSchema: { type: 'object', properties: { ...projectProp, phase: { type: 'integer', description: 'Phase number (from project_overview / list phases).' } }, required: ['project', 'phase'] },
  },
  forecast_run: {
    description: 'Will the next run FIT the live 5-hour window, or pause mid-phase? Deterministic pre-flight forecast (ZERO Claude calls): walks the upcoming units (dev + acceptance-check + reviews) against the window\'s reclaim schedule and the calls-OR-cost pause thresholds. Returns { fitsInWindow, pauseAtUnit, pauseAtPhase, etaMs, callsShort, costShort, waitForFullFitMs, recommendation (run-now | run-partial-then-pause-at-K | wait-Xm), lowConfidence }. Use BEFORE start_run to decide run-now vs wait, especially inside a budgeted autopilot loop; cold projects come back lowConfidence.',
    inputSchema: { type: 'object', properties: { ...projectProp }, required: ['project'] },
  },
  add_bug: {
    description: 'Capture a bug into the project inbox (instant, no run started).',
    inputSchema: { type: 'object', properties: { ...projectProp, text: str('The bug description, verbatim from the user plus any context.'), severity: { type: 'string', enum: ['critical', 'major', 'minor', 'unassigned'] } }, required: ['project', 'text'] },
  },
  add_requirement: {
    description: 'Capture a feature/requirement into the project inbox (instant, no run started).',
    inputSchema: { type: 'object', properties: { ...projectProp, text: str('The requirement text.') }, required: ['project', 'text'] },
  },
  write_raw_thoughts: {
    description: 'Write (or append to) .guide/raw-thoughts.md — the free-form intake that generate_brief turns into a structured brief. Use when the user describes features they want built.',
    inputSchema: { type: 'object', properties: { ...projectProp, content: str('Markdown content — organize the user\'s ideas faithfully; do not invent scope.'), append: { type: 'boolean', description: 'true appends instead of replacing.' } }, required: ['project', 'content'] },
  },
  save_brief: {
    description: 'Overwrite .guide/brief.md directly with provided content. Prefer generate_brief (the guide agent) unless the user hands you final brief text.',
    inputSchema: { type: 'object', properties: { ...projectProp, content: str('Full brief markdown.') }, required: ['project', 'content'] },
  },
  queue_brief: {
    description: 'Add a brief file to inputs/queue/ — the brief chain runs queued briefs in filename order. Prefix filenames with numbers to control order (01-, 02-…).',
    inputSchema: { type: 'object', properties: { ...projectProp, filename: str('e.g. "01-auth-feature.md"'), content: str('Brief markdown for this feature batch.') }, required: ['project', 'filename', 'content'] },
  },
  remove_queued_brief: {
    description: 'Remove a file from the brief queue.',
    inputSchema: { type: 'object', properties: { ...projectProp, filename: str('Queue filename to remove.') }, required: ['project', 'filename'] },
  },
  create_project: {
    description: 'Create a new project (registers it + scaffolds folders + git). Confirm the name with the user first.',
    inputSchema: { type: 'object', properties: { name: str('Project name: alphanumeric with hyphens/underscores.'), tech: str('Optional tech stack hint, e.g. "node+vue".'), profile: str('Optional config profile name.') }, required: ['name'] },
  },
  generate_brief: {
    description: 'Run the guide brief-author on .guide/raw-thoughts.md → .guide/brief.md (detached, takes minutes). Write raw thoughts first.',
    inputSchema: { type: 'object', properties: { ...projectProp }, required: ['project'] },
  },
  plan_project: {
    description: 'Run the guide planner on brief.md → plan.json (phase chain). Detached. Note: start_run auto-plans when no plan exists, so this is only needed to (re)plan explicitly.',
    inputSchema: { type: 'object', properties: { ...projectProp }, required: ['project'] },
  },
  start_run: {
    description: 'Start the auto-run: executes the phase chain (plans first if needed). EXPENSIVE — confirm with the user before calling unless they explicitly asked to run. mode: standard (pauses at checkpoints), unattended (skips checkpoints), launch (unattended + auto-retries through rate-limit/budget pauses).',
    inputSchema: { type: 'object', properties: { ...projectProp, mode: { type: 'string', enum: ['standard', 'unattended', 'launch'] } }, required: ['project'] },
  },
  brief_chain: {
    description: 'Run EVERY queued brief end-to-end (brief → plan → build, one after another, unattended). EXPENSIVE — confirm with the user first. Queue briefs with queue_brief before calling.',
    inputSchema: { type: 'object', properties: { ...projectProp }, required: ['project'] },
  },
  run_next_phase: {
    description: 'Run exactly one dev phase (the next pending one), then stop. Good for "just do the next phase" or immediate targeted dev work.',
    inputSchema: { type: 'object', properties: { ...projectProp }, required: ['project'] },
  },
  resume_run: {
    description: 'Resume a paused auto-run from where it stopped.',
    inputSchema: { type: 'object', properties: { ...projectProp }, required: ['project'] },
  },
  abort_run: {
    description: 'Abort the active auto-run (marks it aborted; the runner stops at its next checkpoint). Confirm with the user first.',
    inputSchema: { type: 'object', properties: { ...projectProp }, required: ['project'] },
  },
  start_bug_round: {
    description: 'Plan fixes for the newest dropped bug round (bugs.md). After planning completes, start_run executes the fixes.',
    inputSchema: { type: 'object', properties: { ...projectProp }, required: ['project'] },
  },
  run_audit: {
    description: 'Audit the implementation (Opus, heavy). chain:true auto-promotes findings and fixes them in a loop until clean. EXPENSIVE — confirm first.',
    inputSchema: { type: 'object', properties: { ...projectProp, chain: { type: 'boolean' }, rounds: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['project'] },
  },
  run_pipeline: {
    description: 'Full autopilot: intake → brief → build → drain bug inbox → audit→fix loop → QA handoff; stops at the ship gate. VERY EXPENSIVE — confirm first.',
    inputSchema: { type: 'object', properties: { ...projectProp }, required: ['project'] },
  },
  ship_project: {
    description: 'Ship: merge the working branch to main and mark completed. Irreversible-ish — requires confirm:true, which you may only set after the user explicitly confirms shipping in this conversation.',
    inputSchema: { type: 'object', properties: { ...projectProp, confirm: { type: 'boolean', description: 'Must be true; only after explicit user confirmation.' }, tag: str('Optional git tag.') }, required: ['project', 'confirm'] },
  },
  orchestrator_dev: {
    description: 'Run a dev task on the ORCHESTRATOR REPO ITSELF (fix a bug in it, add a feature to it) via a detached Claude dev agent that edits src/, verifies, and commits on the current branch (never pushes). Requires confirm:true after explicit user confirmation. Write the task like a good ticket: symptom/goal, suspected files if known, how to verify.',
    inputSchema: {
      type: 'object',
      properties: {
        task: str('Concrete task description (≥20 chars): what to change/fix, where if known, how to verify.'),
        confirm: { type: 'boolean', description: 'Must be true; only after explicit user confirmation in this conversation.' },
        commit: { type: 'boolean', description: 'Default true. false leaves the diff uncommitted for manual review.' },
      },
      required: ['task', 'confirm'],
    },
  },
  start_discussion: {
    description: 'Run a multi-agent discussion panel (3-12 AI experts debate a decision/direction over rounds, then synthesize recommendations). Use for architectural choices, "should we…", or shaping a fuzzy idea before committing to a brief. EXPENSIVE (multiple agents) — confirm with the user first. auto_start:true additionally appends conclusions to the brief and starts unattended dev (requires confirm:true).',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectProp,
        topic: str('The question or decision to debate — specific beats vague.'),
        mode: { type: 'string', enum: ['auto', 'medium', 'max'], description: 'Panel size: auto 3-5, medium 5-7, max 8-12 agents.' },
        auto_start: { type: 'boolean', description: 'true = append conclusions to brief + start dev automatically after the panel.' },
        confirm: { type: 'boolean', description: 'Required true when auto_start is true, after explicit user confirmation.' },
      },
      required: ['project', 'topic'],
    },
  },
  list_discussions: {
    description: 'List past/running multi-agent discussions for a project (id, status, topic).',
    inputSchema: { type: 'object', properties: { ...projectProp }, required: ['project'] },
  },
  discussion_result: {
    description: 'Get a discussion\'s synthesized conclusions: top recommendations, consensus areas, open questions, agent roster.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer', description: 'Discussion id from list_discussions.' } }, required: ['id'] },
  },
  scan_suggestions: {
    description: 'Scan the project and generate improvement suggestions (instant rules engine — no Claude call). Use when the user asks "what should we improve/do next?" without a specific idea.',
    inputSchema: { type: 'object', properties: { ...projectProp, areas: { type: 'array', items: { type: 'string' }, description: 'Optional focus areas to filter by (e.g. ["performance","ux"]).' } }, required: ['project'] },
  },
  get_suggestions: {
    description: 'Read the freshest suggestions row (draft or accepted) for a project.',
    inputSchema: { type: 'object', properties: { ...projectProp }, required: ['project'] },
  },
  accept_suggestions: {
    description: 'Accept chosen suggestions by id (from scan/get) into a pipeline plan of N passes. After this, start_run executes the plan.',
    inputSchema: { type: 'object', properties: { ...projectProp, ids: { type: 'array', items: { type: 'string' }, description: 'Suggestion ids the user approved.' }, passes: { type: 'integer', minimum: 1, maximum: 5, description: 'Number of pipeline passes to spread them over (default 1).' } }, required: ['project', 'ids'] },
  },
  run_roadmap: {
    description: 'Have the guide propose next implementations / follow-on work (lands in .guide/roadmaps/). Detached.',
    inputSchema: { type: 'object', properties: { ...projectProp }, required: ['project'] },
  },
  run_retro: {
    description: 'Aggregate run telemetry into a config-tuning retrospective (docs/retro/ in the orchestrator repo). Detached.',
    inputSchema: { type: 'object', properties: { ...projectProp }, required: ['project'] },
  },
  run_review: {
    description: 'Force a guide review of recent phases now (lands in .guide/reviews/). Detached.',
    inputSchema: { type: 'object', properties: { ...projectProp }, required: ['project'] },
  },
  run_validators: {
    description: 'Run the project\'s external validators (build/tests/lint) against the current workspace. Detached; cheaper than an audit.',
    inputSchema: { type: 'object', properties: { ...projectProp }, required: ['project'] },
  },
  guide_handoff: {
    description: 'Generate a guide handoff doc and reset the guide session (use when guide context is stale/bloated). Detached.',
    inputSchema: { type: 'object', properties: { ...projectProp }, required: ['project'] },
  },
  sync_project: {
    description: 'Git-sync the workspace with origin (fast-forward only). Detached.',
    inputSchema: { type: 'object', properties: { ...projectProp }, required: ['project'] },
  },
  refresh_context: {
    description: 'Regenerate .guide/project-context.md (the per-project context injected into every call). Detached.',
    inputSchema: { type: 'object', properties: { ...projectProp }, required: ['project'] },
  },
  set_checkpoint_policy: {
    description: 'Set the auto-run checkpoint policy for a project (writes overrides.auto_run.checkpoint_policy to project.json; instant, no Claude call). mode: "all" (pause at every configured checkpoint — the default), "intent" (pause ONLY before phases whose plan checkpoint tag is in pause_intents — so a small tweak stops less than a big build), or "errors-only" (pause on errors + budget only). pause_intents (mode "intent") is any of: architecture, schema, external-integration, destructive, routine. Rejects an invalid mode/intent naming the config layer. Takes effect on the next run.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectProp,
        mode: { type: 'string', enum: ['all', 'intent', 'errors-only'], description: 'Checkpoint policy mode.' },
        pause_intents: {
          type: 'array',
          items: { type: 'string', enum: ['architecture', 'schema', 'external-integration', 'destructive', 'routine'] },
          description: 'Intent tags that stop the run in mode "intent" (default architecture + destructive).',
        },
      },
      required: ['project', 'mode'],
    },
  },
  mark_qa: {
    description: 'Flip project status: ready-for-qa (default) or completed (shipped:true). Instant, no Claude call.',
    inputSchema: { type: 'object', properties: { ...projectProp, shipped: { type: 'boolean' } }, required: ['project'] },
  },
  promote_audit: {
    description: 'Promote the latest audit\'s findings into a new bugs round (bugs.md). Instant. Then start_bug_round → start_run to fix.',
    inputSchema: { type: 'object', properties: { ...projectProp }, required: ['project'] },
  },
  promote_bugs: {
    description: 'Promote inbox bugs into a new bugs round (bugs.md for round N+1). Instant. Optionally filter by ids or severity. Then start_bug_round → start_run.',
    inputSchema: { type: 'object', properties: { ...projectProp, ids: { type: 'array', items: { type: 'integer' }, description: 'Specific inbox bug ids (default: all inbox bugs).' }, severity: { type: 'string', enum: ['critical', 'major', 'minor'], description: 'Only promote this severity.' } }, required: ['project'] },
  },
  promote_requirements: {
    description: 'Append refined inbox requirements (scope=now by default) into raw-thoughts.md so the next brief includes them. Instant. Then generate_brief → run.',
    inputSchema: { type: 'object', properties: { ...projectProp, scope: str('Scope bucket to promote (default "now").') }, required: ['project'] },
  },
  orchestrator_pull: {
    description: 'Smart self-update: git pull the orchestrator repo, auto-runs npm install if deps changed, and optionally restarts the web server (restart_ui:true). Reports exactly what changed and what still needs manual action.',
    inputSchema: { type: 'object', properties: { restart_ui: { type: 'boolean', description: 'Set true to also restart the web server process automatically after a successful pull (recommended when web-ui.js or public/ changed).' } } },
  },
  self_status: {
    description: 'Show orchestrator health: git branch/sha/commit, working-tree cleanliness, web server PID + liveness, and whether the running server is stale vs HEAD.',
    inputSchema: { type: 'object', properties: {} },
  },
  self_restart_ui: {
    description: 'Gracefully restart the web server: spawns a fresh process, then kills the old PID after a short delay so the current chat response is delivered first.',
    inputSchema: { type: 'object', properties: { port: { type: 'integer', description: 'Port to bind (default 4242).' } } },
  },
  workspace_shell: {
    description: 'Run a shell command inside projects/<project>/workspace/. Use for git (commit, pull, status, diff, log), npm, build, or any workspace CLI task. Output capped at 10k chars. Blocked (irreversible/destructive): rm -rf on /, ~, *, or the workspace root; mkfs; dd to a block device; fork bombs; git push (use ship_project); git reset --hard; git clean -f.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectProp,
        command: str('Shell command to run, e.g. "git status" or "git add -A && git commit -m \\"wip\\""'),
        timeout_ms: { type: 'integer', minimum: 5000, maximum: 120000, description: 'Timeout in ms (default 60000).' },
      },
      required: ['project', 'command'],
    },
  },
  retry_phase: {
    description: 'Surgically recover ONE bad phase: reset it to pending and hard-revert the workspace to that phase\'s parent commit, so you can redo just that phase instead of aborting the entire run. No Claude cost (a git + DB operation). Refuses while a run is active — abort or wait for the pause first. Use dry_run:true to preview. Afterwards, run_next_phase (or start_run) redoes the phase.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectProp,
        phase: { type: 'integer', minimum: 1, description: 'The phase number to reset and revert.' },
        dry_run: { type: 'boolean', description: 'Preview what would change without doing it.' },
      },
      required: ['project', 'phase'],
    },
  },
  repair: {
    description: 'Reconcile DB state with plan.json across ALL projects — fixes total_phases drift and status stuck at ready-for-qa after a plan extension. No Claude cost. State drift is a common cause of a wedged run; call this when a project looks inconsistent (phase counts off, resume/start refusing for no clear reason). Returns the concrete repairs made.',
    inputSchema: { type: 'object', properties: {} },
  },
  inspect_phase: {
    description: 'Inspect ONE phase: its metadata (status, commit, model, timings), its dev report, and a commit diffstat — so you can see what a phase actually changed when root-causing a regression (read_artifact cannot reach workspace/). For the full line-level diff, use workspace_shell `git show <sha>`.',
    inputSchema: { type: 'object', properties: { ...projectProp, phase: { type: 'integer', minimum: 1, description: 'Phase number to inspect.' } }, required: ['project', 'phase'] },
  },
  refine_inbox: {
    description: 'AI-structure the raw bug OR requirement inbox (Sonnet) into title/repro/expected before promoting, so a promoted round carries clean structured findings instead of raw notes. Detached — runs a few minutes. Do this after capturing a batch with add_bug/add_requirement and before promote_bugs/promote_requirements.',
    inputSchema: { type: 'object', properties: { ...projectProp, kind: { type: 'string', enum: ['bug', 'requirement'], description: 'Which inbox to refine (default bug).' } }, required: ['project'] },
  },
  qa_handoff: {
    description: 'Generate a tester-facing QA handoff markdown from a bug round or a phase range (mark_qa only flips a status flag — this produces the actual document a human QA needs). Deterministic and fast unless with_steps:true (one Opus call to write plain-tester manual steps). Read the result with read_artifact.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectProp,
        round: { type: 'integer', minimum: 1, description: 'Bug round number (default: most recent).' },
        phases: str('Phase range "START:END" (e.g. "1:8") instead of a bug round.'),
        with_steps: { type: 'boolean', description: 'Use Opus to write manual test procedures (one call, slower).' },
      },
      required: ['project'],
    },
  },
  roadmap_accept: {
    description: 'Execute a generated roadmap (run_roadmap first): either spawn a NEW project from the selected items, or append them to a project\'s requirements inbox. Detached. Lets you act on a roadmap you produced instead of it being a dead end.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectProp,
        mode: { type: 'string', enum: ['new-project', 'to-inbox'], description: 'Spawn a new project, or append to an inbox.' },
        target: str('For new-project: the new project name. For to-inbox: the project to append to (or "_inbox" for unscoped).'),
        items: str('Which roadmap items: "all" (default), "1,3,5", or "1-5".'),
        profile: str('Profile for the new project (new-project mode only).'),
      },
      required: ['project', 'mode', 'target'],
    },
  },
  set_autopilot: {
    description: 'Turn AUTOPILOT on/off for THIS chat thread. When ON, you will be automatically re-invoked whenever there is a reason to act (a run pauses, a job finishes or dies, state moves) and expected to drive the `goal` to completion unattended — running, auditing, fixing within a budget — escalating ship / orchestrator_dev / abort back to the operator. Call this when the user asks you to do something autonomously / "keep going until done" / "get X to shipping-ready without asking me each step". Turn OFF (enabled:false) when the goal is met or the user wants manual control back. Requires the server-side autopilot flag; if it is off, the thread is armed but idle until enabled.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'true to start driving this thread to done (default), false to stop.' },
        goal: str('When enabling: a concrete definition of done (what the loop drives toward and stops at). Required to turn ON.'),
      },
    },
  },
};

export const TOOL_HANDLERS = {
  list_projects: toolListProjects,
  project_overview: toolProjectOverview,
  read_artifact: toolReadArtifact,
  window_status: toolWindowStatus,
  list_jobs: toolListJobs,
  list_inbox: toolListInbox,
  spend_report: toolSpendReport,
  predict: toolPredict,
  read_upload: toolReadUpload,
  self_dev_log: toolSelfDevLog,
  get_run_timeline: toolGetRunTimeline,
  get_live_progress: toolGetLiveProgress,
  get_quality_report: toolGetQualityReport,
  explain_routing: toolExplainRouting,
  forecast_run: toolForecastRun,
  add_bug: toolAddBug,
  add_requirement: toolAddRequirement,
  write_raw_thoughts: toolWriteRawThoughts,
  save_brief: toolSaveBrief,
  queue_brief: toolQueueBrief,
  remove_queued_brief: toolRemoveQueuedBrief,
  create_project: toolCreateProject,
  generate_brief: toolGenerateBrief,
  plan_project: toolPlanProject,
  start_run: toolStartRun,
  brief_chain: toolBriefChain,
  run_next_phase: toolRunNextPhase,
  resume_run: toolResumeRun,
  abort_run: toolAbortRun,
  retry_phase: toolRetryPhase,
  start_bug_round: toolStartBugRound,
  run_audit: toolRunAudit,
  run_pipeline: toolRunPipeline,
  ship_project: toolShipProject,
  orchestrator_dev: toolOrchestratorDev,
  start_discussion: toolStartDiscussion,
  list_discussions: toolListDiscussions,
  discussion_result: toolDiscussionResult,
  scan_suggestions: toolScanSuggestions,
  get_suggestions: toolGetSuggestions,
  accept_suggestions: toolAcceptSuggestions,
  run_roadmap: toolRunRoadmap,
  run_retro: toolRunRetro,
  run_review: toolRunReview,
  run_validators: toolRunValidators,
  guide_handoff: toolGuideHandoff,
  sync_project: toolSyncProject,
  refresh_context: toolRefreshContext,
  set_checkpoint_policy: toolSetCheckpointPolicy,
  mark_qa: toolMarkQa,
  promote_audit: toolPromoteAudit,
  promote_bugs: toolPromoteBugs,
  promote_requirements: toolPromoteRequirements,
  orchestrator_pull: toolOrchestratorPull,
  self_status: toolSelfStatus,
  self_restart_ui: toolSelfRestartUi,
  workspace_shell: toolWorkspaceShell,
  repair: toolRepair,
  inspect_phase: toolInspectPhase,
  refine_inbox: toolRefineInbox,
  qa_handoff: toolQaHandoff,
  roadmap_accept: toolRoadmapAccept,
  set_autopilot: toolSetAutopilot,
};

// ─── Context snapshot (injected into every chat prompt) ──────────────────────

/**
 * Compact markdown snapshot of the whole orchestrator, so the chat agent
 * starts grounded without burning a tool round-trip. ~1-4k chars for typical
 * installs; the focus project gets a deeper block.
 */
export async function buildContextSnapshot({ focusProject = null } = {}) {
  const lines = [];

  try {
    const cfg = await resolveConfig({ project: null, task: 'dev-execution' });
    const w = windowStatus(cfg);
    lines.push(`Billing window: ${w.state} — ${w.callsInWindow}/${w.pauseThreshold} heavy-eq units (${w.rawCallsInWindow} raw attempts), $${w.totalCostInWindow.toFixed(2)}/$${w.pauseCostThreshold} ${w.costThresholdsEnforced ? 'enforced' : 'monitor-only'} in last ${w.windowHours}h`);
  } catch (e) {
    lines.push(`Billing window: unavailable (${e.message})`);
  }

  const projects = listProjects();
  lines.push('', `Projects (${projects.length}):`);
  for (const p of projects.slice(0, 30)) {
    const rs = runStateOf(p.name);
    const bits = [
      p.status,
      `phase ${p.current_phase}/${p.total_phases}`,
      `run:${rs.state}`,
    ];
    const bugs = inboxCount(countBugs(p.name));
    const reqs = inboxCount(countRequirements(p.name));
    if (bugs) bits.push(`bugs-inbox:${bugs}`);
    if (reqs) bits.push(`reqs-inbox:${reqs}`);
    if (rs.state === 'paused' && rs.run?.pause_reason) bits.push(`paused: ${String(rs.run.pause_reason).slice(0, 80)}`);
    // Phase 59: for a running project, fold in the live header so the agent
    // knows what the run is doing right now without a get_live_progress call.
    if (rs.state === 'running') {
      const hdr = formatProgressHeader(getLiveProgress(p.name));
      if (hdr) bits.push(`live: ${hdr}`);
    }
    lines.push(`- ${p.name} — ${bits.join(' · ')}`);
  }

  const running = listRunningJobs();
  const pending = listPendingJobs();
  if (running.length || pending.length) {
    lines.push('', `Bot job queue: ${running.length} running, ${pending.length} pending` +
      (running.length ? ` — running: ${running.map((j) => `${j.action} ${j.project}`).join(', ')}` : ''));
  }

  if (focusProject && getProject(focusProject)) {
    try {
      const o = await toolProjectOverview({ project: focusProject });
      lines.push('', `Focus project: ${focusProject}`);
      lines.push(`- status ${o.project.status}, run ${o.run.state}${o.run.pause_reason ? ` (${String(o.run.pause_reason).slice(0, 100)})` : ''}`);
      lines.push(`- brief: ${o.brief.exists ? `yes (modified ${o.brief.modified})` : 'none'} · raw-thoughts: ${o.brief.raw_thoughts_exists ? 'yes' : 'none'} · plan: ${o.plan ? `${o.plan.phases} phases` : 'none'} · queue: ${o.brief_queue.length ? o.brief_queue.join(', ') : 'empty'}`);
      const byStatus = {};
      for (const ph of o.phases) byStatus[ph.status] = (byStatus[ph.status] || 0) + 1;
      lines.push(`- phases: ${Object.entries(byStatus).map(([s, n]) => `${n} ${s}`).join(', ') || 'none'}`);
      const current = o.phases.find((ph) => ph.status === 'in-progress') || o.phases.find((ph) => ph.status === 'pending');
      if (current) lines.push(`- next/current phase: ${current.n} — ${current.title} (${current.status})`);
      if (o.inbox.bugs || o.inbox.requirements) lines.push(`- inbox: ${o.inbox.bugs} bugs, ${o.inbox.requirements} requirements`);
      // Phase 59: live run header for the focused project, when a spawn is in flight.
      const liveHdr = formatProgressHeader(getLiveProgress(focusProject));
      if (liveHdr) lines.push(`- live: ${liveHdr}`);
    } catch (e) {
      lines.push('', `Focus project ${focusProject}: overview failed (${e.message})`);
    }
  }

  return lines.join('\n');
}

/**
 * Self-focused snapshot: orchestrator git state, web server health, and
 * recent self-dev activity. Injected instead of buildContextSnapshot when
 * project === '__self__'.
 */
export async function buildSelfContextSnapshot() {
  const lines = ['## Orchestrator self-maintenance context'];

  try {
    const { selfHealth } = await import('../lib/self-updater.js');
    const h = await selfHealth();
    lines.push('', `**Git** branch:${h.git.branch || '?'} sha:${h.git.sha || '?'} tree:${h.git.clean ? 'clean' : 'DIRTY'}`);
    if (h.git.commit) {
      lines.push(`Last commit: "${h.git.commit.subject}" by ${h.git.commit.author} (${h.git.commit.ago})`);
    }
    const webLine = h.webServer.alive
      ? h.webServer.stale
        ? `⚠ STALE pid:${h.webServer.pid} (deployed ${h.webServer.deployedSha}, HEAD ${h.git.sha}) — restart needed`
        : `✓ running pid:${h.webServer.pid} (up to date)`
      : h.webServer.pid
        ? `✗ dead pid:${h.webServer.pid} — start with npm run web`
        : 'web server: not tracked (start with npm run web)';
    lines.push(`**Web server** ${webLine}`);
  } catch (e) {
    lines.push('', `Git/health snapshot failed: ${e.message}`);
  }

  // Include project summary so agent can cross-reference if needed
  try {
    const projects = listProjects();
    lines.push('', `Projects tracked: ${projects.length}${projects.length ? ' — ' + projects.map((p) => p.name).join(', ') : ''}`);
  } catch { /* ignore */ }

  // Recent self-dev runs
  try {
    const devLines = await toolSelfDevLog({});
    if (devLines && devLines.logs && devLines.logs.length) {
      lines.push('', `**Recent self-dev runs** (${devLines.logs.length}):`);
      for (const l of devLines.logs.slice(0, 5)) lines.push(`- ${l}`);
    }
  } catch { /* ignore */ }

  return lines.join('\n');
}
