// Web UI server — serves a live dashboard + REST API for the orchestrator.
// Usage:  npm run ui [-- --port 4242]
//
// Endpoints:
//   GET  /api/stats                    Global summary
//   GET  /api/projects                 All projects with phases + auto-run
//   GET  /api/projects/:name           Single project detail
//   GET  /api/projects/:name/calls     Last 50 calls (optional ?limit=N)
//   POST /api/projects/:name/abort     Abort active auto-run
//   POST /api/projects/:name/go        Enqueue durable auto-run
//   POST /api/projects/:name/resume    Enqueue durable resume
//   POST /api/projects/:name/next      Enqueue one durable phase
//   POST /api/projects/:name/sync      Git sync workspace with origin (fast-forward)
//   GET  /api/activity                 Last 40 calls across all projects
//   GET  /api/projects/:name/brief-queue          List inputs/queue/*.md in order
//   POST /api/projects/:name/brief-queue          Add a brief file to the queue
//   DELETE /api/projects/:name/brief-queue/:file  Remove a queued brief file
//   POST /api/projects/:name/brief-chain          Enqueue a durable unattended brief chain
//   GET  /api/window                   Billing window status (windowStatus + weeklyUsage + global config)
//   POST /api/stop-all-running         SIGINT all live runners; returns {stopped:[names]}
//   POST /api/restart-previous         Start go on a list of names; body {names:[…]}
//   POST /api/restart-ui               Exit this process (PM2 auto-restarts it); returns {ok}
//   GET  /api/projects/:name/runs      auto_runs history (?limit=N, default 20, cap 100)
//   GET  /api/projects/:name/log-tail  Parsed tail of the newest stdout stream-json log
//   GET  /api/projects/:name/next-actions   Ranked "what next" suggestions
//   GET  /api/projects/:name/artifacts       List .md/.json/.jsonl files under .guide/
//   GET  /api/projects/:name/artifacts/file  Read one artifact (?path=<rel>, .guide-jailed)
//   GET  /api/jobs                     Job queue snapshot {pending, running, recent}
//   DELETE /api/jobs/:id               Dequeue a PENDING job (409 otherwise)
//   POST /api/projects/:name/bugs           Capture a bug into the inbox
//   POST /api/projects/:name/requirements   Capture a requirement into the inbox
//   GET  /api/spend                    Spend by task×model w/ cache-hit % (?project=&days=, default 30)

import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { statSync, readFileSync, readdirSync, watch as fsWatch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { EventEmitter } from 'node:events';
import chalk from 'chalk';

export const uiEvents = new EventEmitter();
import {
  getDb,
  listProjects,
  getProject,
  getPhases,
  skipPhase,
  getActiveAutoRun,
  getLastAutoRun,
  getSpendReport,
  listHealingLog,
  listBugRounds,
  countBugs,
  countRequirements,
  getBug, listBugs, addBug,
  getRequirement, listRequirements, addRequirement,
  getRunningJob,
  pidAlive,
  sweepInterruptedAutoRuns,
  sweepStaleChatLocks,
  sweepStaleLiveProgress,
  listAutoRuns,
  listRunEvents,
  setProjectGitConfig,
  deleteProject,
  saveSuggestions, acceptSuggestions, getLatestSuggestions, getFreshestSuggestions,
  staleDraftSuggestions,
  getSuggestionsProject, getSuggestionsById, getEarlierSuggestionTitles,
  getMaxOutboxId, listOutboxSince,
  getLiveProgress,
  getQualityReport,
  getPhaseRoutingChain,
  listOperatorQuestions,
  getAutopilotState,
} from './state.js';
import { promoteAuditToBugs } from './lib/audit-promote.js';
import {
  detectHighestBugRound, bugRoundDir, bugsFilePath, fixPlanJsonPath,
} from './lib/guide-paths.js';
import { resolve as resolveConfig } from './config-resolver.js';
import { windowStatus, weeklyUsage } from './billing-guard.js';
import { startWatchdog } from './lib/project-watchdog.js';
import { getNextActions } from './lib/next-actions.js';
import { mapStreamJsonLine } from './lib/stream-log.js';
import {
  listPendingJobs, listRunningJobs, listRecentJobs, dequeuePendingJob, getJob,
  enqueueProjectIdleActionJob,
  getRunningJobsForProject, requestJobCancellation, cancelPendingJobsForProject,
  getPendingJobsForProject,
  reorderPendingJob, retryTerminalJob, listWorkerHeartbeats,
  QUEUE_ACTIONS, QUEUE_ACTION_SET, NON_RETRYABLE_ACTIONS,
  NON_CANCELLABLE_ACTIONS, jobCancellationCapability,
} from './server/job-queue.js';
import { scanProject }          from './lib/project-scanner.js';
import { generateSuggestions, assignToPasses, filterSuggestions } from './lib/suggestion-engine.js';
import { generateAISuggestions } from './lib/ai-suggestion-scanner.js';
import { writeSuggestionsFile } from './commands/suggest.js';
import { forecastRun } from './commands/predict.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = path.resolve(__dirname, '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');
const PROFILES_DIR = path.join(REPO_ROOT, 'config', 'profiles');
const LOGS_DIR     = path.join(REPO_ROOT, 'logs'); // written by claude-runner.js
const OUTPUTS_DIR  = path.join(REPO_ROOT, 'outputs');
const AUTH_TOKEN_PATH = path.join(REPO_ROOT, 'config', 'web-auth-token.txt');
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const WEB_STARTED_AT = new Date().toISOString();
const AUTOPILOT_APPROVAL_ACTIONS = new Set(['resume', 'brief', 'bugs', 'audit', 'suggestions']);
const CONTINUATION_ACTIONS = Object.freeze([
  'go', 'resume', 'next', 'brief-chain', 'next-brief', 'pipeline',
]);

const UI_ACTION_META = Object.freeze({
  pipeline: { label: 'Full pipeline', destructive: false, requiresArgs: [] },
  audit: { label: 'Audit', destructive: false, requiresArgs: [] },
  bugs: { label: 'Plan bug fixes', destructive: false, requiresArgs: [] },
  roadmap: { label: 'Roadmap', destructive: false, requiresArgs: [] },
  retro: { label: 'Retrospective', destructive: false, requiresArgs: [] },
  brief: { label: 'Draft brief', destructive: false, requiresArgs: [] },
  'next-brief': { label: 'Launch next brief', destructive: false, requiresArgs: [] },
  review: { label: 'Review', destructive: false, requiresArgs: [] },
  handoff: { label: 'Handoff', destructive: false, requiresArgs: [] },
  qa: { label: 'Mark ready for QA', destructive: false, requiresArgs: [] },
  'qa-handoff': { label: 'Generate QA handoff', destructive: false, requiresArgs: [] },
  package: { label: 'Package release', destructive: false, requiresArgs: [] },
  validate: { label: 'Run validators', destructive: false, requiresArgs: [] },
  'reset-brief': { label: 'Reset brief', destructive: true, requiresArgs: [] },
  'retry-phase': { label: 'Retry phase', destructive: true, requiresArgs: ['phase'] },
  sync: { label: 'Git sync', destructive: false, requiresArgs: [] },
  ship: { label: 'Ship', destructive: true, requiresArgs: [] },
  discuss: { label: 'Discussion', destructive: false, requiresArgs: ['topic'] },
  eval: { label: 'Prompt evaluation', destructive: false, requiresArgs: [] },
  guide: { label: 'Guide task', destructive: false, requiresArgs: ['task'] },
});

// Footgun-guard for POST /api/terminal/exec — blocks catastrophic *system*
// destruction while allowing legitimate workspace cleanup (e.g. rm -rf node_modules).
// NOT a security boundary; that is the Bearer-token auth on /api. Catches the
// flag-order/long-form variants the old single `rm -rf /` regex missed.
export function isCatastrophicCommand(command) {
  const cmd = String(command || '');
  if (/:\s*\(\s*\)\s*\{/.test(cmd)) return true;                // fork bomb  :(){ :|:& };:
  if (/\bmkfs\b/.test(cmd)) return true;                         // format a filesystem
  if (/\bdd\b[^\n]*\bof=\/dev\//.test(cmd)) return true;         // raw write to a device
  if (/>\s*\/dev\/(sd|nvme|hd|disk)/.test(cmd)) return true;     // redirect over a block device
  if (/\brm\b/.test(cmd)) {
    const recursive = /(^|\s)-{1,2}[a-z]*r[a-z]*(\s|$)/i.test(cmd) || /--recursive/i.test(cmd);
    const force     = /(^|\s)-{1,2}[a-z]*f[a-z]*(\s|$)/i.test(cmd) || /--force/i.test(cmd);
    if (recursive && force) {
      if (/\s(~|\/)([\/\*\s]|$)/.test(cmd)) return true;         // filesystem root or home dir
      if (/\s\/(etc|usr|bin|boot|lib|lib64|var|sys|dev|proc|root|opt|sbin|home)(\/|\s|\*|$)/.test(cmd)) return true; // top-level system dirs
    }
  }
  return false;
}

// ─── Auth token bootstrap ────────────────────────────────────────────────────
// Read the single Bearer token from config/web-auth-token.txt, generating it
// (32 hex chars) on first run. File IO is async per CLAUDE.md convention.
export async function ensureAuthToken() {
  try {
    const existing = (await fs.readFile(AUTH_TOKEN_PATH, 'utf-8')).trim();
    if (existing) {
      await fs.chmod(AUTH_TOKEN_PATH, 0o600).catch(() => {});
      return { token: existing, generated: false };
    }
  } catch { /* missing — fall through to generate */ }
  const token = crypto.randomBytes(16).toString('hex'); // 32 hex chars
  await fs.writeFile(AUTH_TOKEN_PATH, token, { encoding: 'utf-8', mode: 0o600 });
  await fs.chmod(AUTH_TOKEN_PATH, 0o600).catch(() => {});
  return { token, generated: true };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function projectCost(projectName) {
  return getDb().prepare(
    `SELECT COALESCE(SUM(cost_usd),0) AS total_cost,
            COALESCE(SUM(input_tokens),0) AS total_input,
            COALESCE(SUM(output_tokens),0) AS total_output,
            COUNT(*) AS total_calls
     FROM calls WHERE project = ?`,
  ).get(projectName);
}

function recentCalls(projectName, limit = 50, phase = null) {
  if (phase != null) {
    return getDb().prepare(
      `SELECT id, phase, task, model, started_at, duration_ms, cost_usd,
              input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
              is_error, error_message
       FROM calls WHERE project = ? AND phase = ?
       ORDER BY started_at DESC LIMIT ?`,
    ).all(projectName, phase, limit);
  }
  return getDb().prepare(
    `SELECT id, phase, task, model, started_at, duration_ms, cost_usd,
            input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
            is_error, error_message
     FROM calls WHERE project = ?
     ORDER BY started_at DESC LIMIT ?`,
  ).all(projectName, limit);
}

function globalActivity(limit = 40) {
  return getDb().prepare(
    `SELECT id, project, phase, task, model, started_at, duration_ms,
            cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
            is_error, error_message
     FROM calls ORDER BY started_at DESC LIMIT ?`,
  ).all(limit);
}

function globalStats() {
  const db = getDb();
  const totals = db.prepare(
    `SELECT COALESCE(SUM(cost_usd),0) AS total_cost,
            COALESCE(SUM(COALESCE(input_tokens,0)),0) AS total_input,
            COALESCE(SUM(COALESCE(output_tokens,0)),0) AS total_output,
            COALESCE(SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)),0) AS total_tokens,
            COUNT(*) AS total_calls
     FROM calls`,
  ).get();
  const projectCount = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
  const activeRuns   = db.prepare(`SELECT COUNT(*) AS n FROM auto_runs WHERE status='running'`).get().n;
  const pausedRuns   = db.prepare(`SELECT COUNT(*) AS n FROM auto_runs WHERE status='paused'`).get().n;
  const bugCount     = db.prepare(`SELECT COUNT(*) AS n FROM bug_inbox WHERE status NOT IN ('dropped')`).get().n;
  const reqCount     = db.prepare(`SELECT COUNT(*) AS n FROM requirements WHERE status NOT IN ('dropped','promoted')`).get().n;
  const healResolved = db.prepare(`SELECT COUNT(*) AS n FROM healing_log WHERE status='resolved' AND created_at > datetime('now','-24 hours')`).get().n;
  const healFailed   = db.prepare(`SELECT COUNT(*) AS n FROM healing_log WHERE status='failed' AND created_at > datetime('now','-1 hour')`).get().n;
  return { ...totals, projectCount, activeRuns, pausedRuns, bugCount, reqCount, healResolved, healFailed };
}

export function parseBoundedQueryInt(raw, {
  fallback,
  min = 1,
  max,
  label = 'value',
} = {}) {
  if (raw == null || raw === '') return { ok: true, value: fallback };
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    return { ok: false, error: `${label} must be an integer from ${min} to ${max}` };
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return { ok: false, error: `${label} must be an integer from ${min} to ${max}` };
  }
  return { ok: true, value };
}

function enrichProject(p) {
  const phases    = getPhases(p.name);
  const autoRun   = getLastAutoRun(p.name);
  // running_jobs row = {project, pid, started_at} — present only while an
  // orchestrator process actually holds the cross-process mutex for this project.
  // Verify the pid is alive so a crashed run doesn't report processAlive forever.
  const rawRunningJob = getRunningJob(p.name) || null;
  const runningJob = rawRunningJob && pidAlive(rawRunningJob.pid) ? rawRunningJob : null;
  const cost      = projectCost(p.name);
  const bugRounds = listBugRounds(p.name);
  const bugRows   = countBugs(p.name);
  const bugInbox  = bugRows.filter(r => r.status === 'inbox').reduce((s, r) => s + r.n, 0);
  const bugTotal  = bugRows.reduce((s, r) => s + r.n, 0);
  const reqRows   = countRequirements(p.name);
  const reqInbox  = reqRows.filter(r => r.status === 'inbox').reduce((s, r) => s + r.n, 0);
  const reqTotal  = reqRows.reduce((s, r) => s + r.n, 0);
  // hasNextBrief: raw-thoughts.md has content AND is newer than brief.md
  // (mirrors the alreadyGenerated check in GET /api/projects/:name/brief)
  const rawPath   = path.join(PROJECTS_DIR, p.name, '.guide', 'raw-thoughts.md');
  const briefPath = path.join(PROJECTS_DIR, p.name, '.guide', 'brief.md');
  let hasNextBrief = false;
  try {
    const rawStat = statSync(rawPath);
    if (rawStat.size > 80) {
      try {
        const briefStat = statSync(briefPath);
        // Only pending when raw-thoughts is strictly newer than the generated brief
        hasNextBrief = rawStat.mtimeMs > briefStat.mtimeMs;
      } catch {
        // brief.md doesn't exist yet — raw-thoughts hasn't been processed
        hasNextBrief = true;
      }
    }
  } catch {}
  let billingConfig    = {};
  let projectOverrides = {};
  let configVersion    = null;
  try {
    // Hash the exact on-disk bytes, not a parsed/re-serialized object. The UI
    // sends this opaque version back on PATCH so whitespace-only and external
    // edits are detected just as reliably as semantic changes.
    const projectRaw = readFileSync(path.join(PROJECTS_DIR, p.name, 'project.json'));
    configVersion = crypto.createHash('sha256').update(projectRaw).digest('hex');
    const pj = JSON.parse(projectRaw.toString('utf-8'));
    projectOverrides = pj?.overrides || {};
    billingConfig    = projectOverrides.billing || {};
  } catch { /* no project.json or parse error — both stay {} */ }
  // Phase 61 (P5): the live in-flight telemetry row (Phase 59), so
  // PipelinePanel's "why this model" chip can fall back to the model of a
  // call that's still running (no `calls` row exists for it yet — recordCall
  // only fires when a spawn finishes). null when idle; never throws.
  const liveProgress = getLiveProgress(p.name) || null;
  // Oldest queued-but-not-yet-claimable job for this project (see
  // FREE_PROJECT_FIFO_FROM_WHERE in job-queue.js) — lets the UI show "queued"
  // instead of a Resume/Go click silently appearing to do nothing.
  const pendingJob = getPendingJobsForProject(p.name)[0] || null;
  return { ...p, phases, autoRun: autoRun || null, processAlive: !!runningJob, runningJob, cost, bugRounds, bugInbox, bugTotal, reqInbox, reqTotal, hasNextBrief, billingConfig, projectOverrides, configVersion, liveProgress, pendingJob };
}

async function resolveEffectiveBilling(projectName) {
  try {
    const cfg = await resolveConfig({ project: projectName });
    return cfg.billing || {};
  } catch {
    return {};
  }
}

// ─── Dev live-reload ─────────────────────────────────────────────────────────
// When started with { dev: true }, watch src/public/ for file changes and push
// a reload event over SSE so the browser refreshes automatically.

const _devReloadClients = new Set();

// ── Shared SSE state (Bug 5: one poll loop per endpoint type, not per client) ──
const _globalSseClients   = new Set();
let   _globalSseTimer     = null;
let   _globalSseLastCallId = -1;
let   _globalSseLastOutboxId = -1;  // Phase 58: cursor for notify_outbox → { type:'notify' } SSE fan-out
const _globalSseSnapshot  = {};

const _projectSseClients   = new Map();
const _projectSseTimers    = new Map();
const _projectSseLastCallIds = new Map();
const _projectSseSnapshots  = new Map();
// Phase 59: per-project last-emitted live_progress.updated_at, so { type:'progress' }
// fires only when the throttled writer actually advanced the row.
const _projectSseLastProgress = new Map();

// ── Global SSE window-status broadcast (every 10th tick ≈ 5s) ──
let _globalSseTick        = 0;
let _windowSseSnapshot    = null;  // { callsInWindow, totalCostInWindow }
let _windowSseInFlight    = false; // resolveConfig is async — never overlap checks

// ── Log-tail parse cache: filename → { mtimeMs, size, task, entries } ──
const _logTailCache = new Map();

// ── SSE ticket store (Bug 8: short-lived single-use tickets) ──
const _sseTickets = new Map();
const SSE_TICKET_TTL_MS = 15_000;

function startDevWatcher() {
  const publicDir = path.join(__dirname, 'public');
  fsWatch(publicDir, { recursive: true }, () => {
    for (const res of _devReloadClients) {
      try { res.write('data: reload\n\n'); } catch { _devReloadClients.delete(res); }
    }
  });
  console.log(chalk.bold.cyan('[web-ui]') + chalk.dim(' dev watcher active — browser reloads on file change'));
}

// ─── SSE helpers ─────────────────────────────────────────────────────────────

function buildCallEvent(row) {
  return {
    type: 'call',
    project: row.project,
    phase: row.phase,
    task: row.task,
    model: row.model,
    tokens: (row.input_tokens || 0) + (row.output_tokens || 0),
    cost_usd: row.cost_usd,
    is_error: !!row.is_error,
  };
}

function startSseResponse(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  return { write: (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`) };
}

// Fingerprint of the browser-facing assets (JS/CSS/HTML under public/). Sent to
// every SSE client on connect as a `hello`; when the value a client first saw
// changes on a later (re)connect, the server has shipped new client code and the
// tab reloads itself. Prevents the "blank screen after deploy" failure where an
// open tab keeps running a stale/mixed native-ESM graph (mismatched module loads
// leave Vue patching component vnodes whose instance is null). Computed once,
// lazily, and cached for the process lifetime — a restart with new files gets a
// fresh process and therefore recomputes.
let _assetVersionCache = null;
function assetVersion() {
  if (_assetVersionCache) return _assetVersionCache;
  const root = path.join(__dirname, 'public');
  const hash = crypto.createHash('sha256');
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(js|css|html)$/i.test(name)) {
        hash.update(path.relative(root, p));
        hash.update(readFileSync(p));
      }
    }
  };
  try { walk(root); _assetVersionCache = hash.digest('hex').slice(0, 16); }
  catch { _assetVersionCache = 'unknown'; }
  return _assetVersionCache;
}

// The global config almost never changes mid-session, but resolveConfig re-reads
// and re-merges defaults + profile files every call. Cache it for a few seconds so
// the ~5s window broadcast and GET /api/window don't re-run the cascade constantly.
let _globalCfgCache = null;
let _globalCfgCacheAt = 0;
const GLOBAL_CFG_TTL_MS = 5_000;
async function resolveGlobalConfig() {
  const now = Date.now();
  if (_globalCfgCache && now - _globalCfgCacheAt < GLOBAL_CFG_TTL_MS) return _globalCfgCache;
  const cfg = await resolveConfig({});
  _globalCfgCache = cfg;
  _globalCfgCacheAt = now;
  return cfg;
}

// Compute windowStatus off the global config and push `{type:'window', ...}`
// to all global SSE clients when callsInWindow or cost moved. Cheap (one DB
// query + cached config every ~5s) and fully guarded — a config error must
// never kill the poll loop.
async function broadcastWindowStatus() {
  if (_windowSseInFlight || _globalSseClients.size === 0) return;
  _windowSseInFlight = true;
  try {
    const cfg = await resolveGlobalConfig();
    const status = windowStatus(cfg);
    const weekly = weeklyUsage(cfg);
    const changed = !_windowSseSnapshot
      || _windowSseSnapshot.callsInWindow !== status.callsInWindow
      || _windowSseSnapshot.totalCostInWindow !== status.totalCostInWindow;
    if (changed) {
      _windowSseSnapshot = { callsInWindow: status.callsInWindow, totalCostInWindow: status.totalCostInWindow };
      const evt = { type: 'window', ...status, weekly };
      for (const c of _globalSseClients) { try { c.write(evt); } catch { _globalSseClients.delete(c); } }
    }
  } catch { /* config/DB hiccup — skip this tick */ }
  finally { _windowSseInFlight = false; }
}

// ─── Log-tail helpers ────────────────────────────────────────────────────────
// Logs are written by claude-runner.js as `${project}-${task}-${timestamp}.stdout.log`
// where each line is one claude stream-json event. The parser itself
// (mapStreamJsonLine + its two helpers) lives in src/lib/stream-log.js so the
// autopsy (src/lib/autopsy.js) can reuse it without duplicating the parser.

const LOG_TAIL_MAX_BYTES = 256 * 1024;

// ─── Artifact helpers ────────────────────────────────────────────────────────

const ARTIFACT_EXTS = new Set(['.md', '.json', '.jsonl']);
const ARTIFACT_GROUP_ORDER = ['plan', 'brief', 'reviews', 'audits', 'reports', 'bug-rounds', 'handoffs', 'decisions', 'other'];

// Group rules, checked in contract order. `rel` uses posix separators.
function artifactGroup(rel) {
  const name = path.posix.basename(rel);
  const top  = rel.split('/')[0];
  if (rel === 'plan.md' || rel === 'plan.json') return 'plan';
  if (top === 'briefs' || (name.startsWith('brief') && name.endsWith('.md'))) return 'brief';
  if (top === 'reviews') return 'reviews';
  if (top === 'audits' || name.includes('audit')) return 'audits';
  if (top === 'phases' && name === 'report.md') return 'reports';
  if (top === 'bug-rounds') return 'bug-rounds';
  if (top === 'handoffs' || top === 'qa-handoffs') return 'handoffs';
  if (name === 'decisions.jsonl') return 'decisions';
  return 'other';
}

// Recursive walk of the .guide dir (depth ≤ 3 subdirectory levels).
// Hidden dirs and node_modules are skipped; the .guide root itself is allowed.
async function walkArtifacts(dir, baseDir, depth, out) {
  if (depth > 3) return;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      await walkArtifacts(full, baseDir, depth + 1, out);
    } else if (ent.isFile() && ARTIFACT_EXTS.has(path.extname(ent.name).toLowerCase())) {
      try {
        const st = await fs.stat(full);
        const rel = path.relative(baseDir, full).split(path.sep).join('/');
        out.push({ path: rel, name: ent.name, group: artifactGroup(rel), size: st.size, mtime: st.mtime.toISOString() });
      } catch { /* raced deletion — skip */ }
    }
  }
}

async function fileSnapshot(filePath) {
  try {
    const [content, st] = await Promise.all([fs.readFile(filePath, 'utf-8'), fs.stat(filePath)]);
    return {
      content,
      mtime: st.mtime.toISOString(),
      version: crypto.createHash('sha256').update(content).digest('hex'),
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { content: '', mtime: null, version: crypto.createHash('sha256').update('').digest('hex') };
    }
    throw err;
  }
}

function releaseFilenameMatchesProject(project, filename) {
  if (typeof filename !== 'string' || path.basename(filename) !== filename) return false;
  const escapedProject = project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // packageProject owns this exact timestamped filename contract. Requiring
  // the timestamp after the project prefix prevents project "foo" from
  // listing or downloading an archive owned by project "foo-bar".
  return new RegExp(`^${escapedProject}-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.zip$`).test(filename);
}

async function resolveReleaseArchive(project, filename) {
  if (!releaseFilenameMatchesProject(project, filename)) return null;
  const candidate = path.resolve(OUTPUTS_DIR, filename);
  if (!candidate.startsWith(`${path.resolve(OUTPUTS_DIR)}${path.sep}`)) return null;
  try {
    const lst = await fs.lstat(candidate);
    if (!lst.isFile() || lst.isSymbolicLink()) return null;
    const [realRoot, realFile] = await Promise.all([
      fs.realpath(OUTPUTS_DIR),
      fs.realpath(candidate),
    ]);
    if (!realFile.startsWith(`${realRoot}${path.sep}`)) return null;
    const st = await fs.stat(realFile);
    if (!st.isFile()) return null;
    return {
      filename,
      path: realFile,
      size: st.size,
      mtime: st.mtime.toISOString(),
    };
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

async function listReleaseArchives(project) {
  let entries;
  try { entries = await fs.readdir(OUTPUTS_DIR, { withFileTypes: true }); }
  catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const releases = [];
  for (const entry of entries) {
    // Dirent.isFile() excludes symlinks before the stronger lstat/realpath
    // checks in resolveReleaseArchive.
    if (!entry.isFile() || !releaseFilenameMatchesProject(project, entry.name)) continue;
    const release = await resolveReleaseArchive(project, entry.name);
    if (release) releases.push({ filename: release.filename, size: release.size, mtime: release.mtime });
  }
  releases.sort((a, b) => b.mtime.localeCompare(a.mtime) || b.filename.localeCompare(a.filename));
  return releases;
}

function projectMutationBlockers(project) {
  const blockers = [];
  const active = getActiveAutoRun(project);
  if (active) blockers.push({ type: 'auto_run', id: active.id });
  for (const job of getRunningJobsForProject(project)) {
    blockers.push({ type: 'job', id: job.id, action: job.action });
  }
  const owner = getRunningJob(project);
  if (owner?.pid && pidAlive(owner.pid)) blockers.push({ type: 'process', pid: owner.pid });
  for (const job of getPendingJobsForProject(project)) {
    // A queued action may read or write project files by the time it is
    // claimed. Treat every pending job as a mutation boundary; maintaining a
    // partial allowlist here made newly-added actions silently unsafe.
    blockers.push({ type: 'queued_job', id: job.id, action: job.action });
  }
  return blockers;
}

function rejectProjectMutation(res, project, operation) {
  const blockers = projectMutationBlockers(project);
  if (!blockers.length) return false;
  res.status(409).json({
    error: `Cannot ${operation} while project work is active or queued`,
    code: 'PROJECT_MUTATION_BLOCKED',
    blockers,
  });
  return true;
}

function sendProjectQueueResult(res, queued, action) {
  if (!queued.scheduled) {
    return res.status(409).json({
      error: 'Project already has pending or running work',
      code: 'PROJECT_BUSY',
      action,
      ...queued,
    });
  }
  return res.status(202).json({ ok: true, action, ...queued });
}

function annotateRetryability(job) {
  if (!job || !['failed', 'cancelled'].includes(job.status)) {
    return { ...job, retryable: false, retry_block_reason: 'Only failed or cancelled jobs can be retried' };
  }
  if (NON_RETRYABLE_ACTIONS.has(job.action)) {
    return { ...job, retryable: false, retry_block_reason: `Action '${job.action}' may have completed a non-replay-safe side effect` };
  }
  if (!getProject(job.project)) {
    return { ...job, retryable: false, retry_block_reason: 'Project no longer exists' };
  }
  return { ...job, retryable: true, retry_block_reason: null };
}

function annotateJobControls(job) {
  const capability = job?.status === 'running'
    ? jobCancellationCapability(job)
    : { cancellable: false, reason: 'Only running jobs can be cancelled' };
  return {
    ...job,
    cancellable: capability.cancellable,
    cancel_block_reason: capability.reason,
  };
}

function mtimeMatches(expected, actual) {
  if (expected === null) return actual === null;
  return typeof expected === 'string' && expected === actual;
}

export function execForHttpRequest(command, options, req, res = null) {
  return new Promise((resolve, reject) => {
    const { timeout = 60_000, ...execOptions } = options || {};
    let settled = false;
    let cancelCode = null;
    let cancelMessage = null;
    let timeoutTimer = null;
    let hardKillTimer = null;
    let child = null;

    const signalGroup = (signal) => {
      try {
        if (process.platform !== 'win32' && child?.pid) process.kill(-child.pid, signal);
        else child?.kill(signal);
      } catch {
        try { child?.kill(signal); } catch { /* already exited */ }
      }
    };
    const detachListeners = () => {
      req?.off?.('aborted', abortRequest);
      res?.off?.('close', disconnect);
    };
    const terminate = (code, message) => {
      if (settled || cancelCode) return;
      cancelCode = code;
      cancelMessage = message;
      signalGroup('SIGTERM');
      // Kill the whole detached process group after grace. Do this even if
      // the shell callback settles first: a grandchild may have ignored TERM.
      hardKillTimer = setTimeout(() => signalGroup('SIGKILL'), 2_000);
      hardKillTimer.unref?.();
    };
    const abortRequest = () => terminate('REQUEST_ABORTED', 'Terminal command cancelled because the request was aborted');
    const disconnect = () => terminate('REQUEST_ABORTED', 'Terminal command cancelled because the client disconnected');

    child = exec(command, {
      ...execOptions,
      detached: process.platform !== 'win32',
    }, (err, stdout, stderr) => {
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      detachListeners();
      if (!cancelCode && hardKillTimer) clearTimeout(hardKillTimer);
      if (err || cancelCode) {
        const finalError = err || new Error(cancelMessage || 'Terminal command cancelled');
        if (cancelCode) {
          finalError.code = cancelCode;
          finalError.message = cancelMessage || finalError.message;
        }
        finalError.stdout = stdout;
        finalError.stderr = stderr;
        reject(finalError);
      } else {
        resolve({ stdout, stderr });
      }
    });
    req?.once?.('aborted', abortRequest);
    res?.once?.('close', disconnect);
    timeoutTimer = setTimeout(
      () => terminate('ETIMEDOUT', `Terminal command exceeded ${timeout}ms timeout`),
      Math.max(1, Number(timeout) || 60_000),
    );
    timeoutTimer.unref?.();
  });
}

// ─── Express app ─────────────────────────────────────────────────────────────

export function createWebUiApp({ authToken, terminalEnabled = false } = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
      // The SPA shell (index.html) must never be bfcached or stale-served: a tab
      // restored from Chrome's back/forward cache with a pre-deploy module graph
      // renders a broken, blank app (the native-ESM imports don't hot-swap). A
      // page served `no-store` is ineligible for bfcache, so every load re-fetches
      // the shell and picks up the current modules. JS/CSS keep the default
      // revalidating cache (max-age=0 + ETag) — a 304 there is safe (same bytes).
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
    },
  }));

  // Per-project concurrency guard for /scan and /scan-ai.
  // Module-level state would persist across test app instances; closure keeps it scoped.
  const scanInProgress = new Set();
  const fileMutations = new Set();
  const configMutations = new Set();

  // ── Dev live-reload SSE endpoint (always registered, no auth needed) ──
  // In dev mode the watcher populates _devReloadClients and sends reload events.
  // In prod the client connects but stays silent — no console errors.
  app.get('/api/dev-reload', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    _devReloadClients.add(res);
    const hb = setInterval(() => res.write(': ping\n\n'), 30000);
    req.on('close', () => { clearInterval(hb); _devReloadClients.delete(res); });
  });

  // ── Auth ── single Bearer token over all /api/* routes.
  // GET / + static assets are public (login UI). SSE routes self-authenticate
  // via ?token= because EventSource cannot set an Authorization header.
  // When no token is configured, auth is left off (verify scripts / dev).
  if (authToken) {
    const validToken = (candidate) => {
      if (typeof candidate !== 'string' || candidate.length !== authToken.length) return false;
      return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(authToken));
    };
    app.use('/api', (req, res, next) => {
      // req.path is relative to the '/api' mount → '/stream', '/projects/foo/stream'
      if (req.path === '/stream' || req.path.endsWith('/stream')) {
        const ticket = req.query.ticket;
        if (ticket) {
          const expiry = _sseTickets.get(ticket);
          if (expiry && Date.now() < expiry) {
            _sseTickets.delete(ticket);
            return next();
          }
          return res.status(401).json({ error: 'Unauthorized' });
        }
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const m = (req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
      if (m && validToken(m[1])) return next();
      return res.status(401).json({ error: 'Unauthorized' });
    });
  }

  // ── SSE ticket endpoint ──
  app.post('/api/sse-ticket', (req, res) => {
    const ticket = crypto.randomBytes(16).toString('hex');
    _sseTickets.set(ticket, Date.now() + SSE_TICKET_TTL_MS);
    res.json({ ticket });
  });

  // ── Stats ──
  app.get('/api/stats', (_req, res) => {
    try { res.json(globalStats()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── System health / capabilities ──
  app.get('/api/system/health', async (_req, res) => {
    try {
      const now = Date.now();
      const currentRole = process.env.ASHMERO_ROLE || 'mac';
      const currentHostId = process.env.ASHMERO_HOST_ID || (currentRole === 'mac' ? 'mac' : null);
      const heartbeats = listWorkerHeartbeats().map((row) => {
        let activeJobs = [];
        try { activeJobs = JSON.parse(row.active_jobs || '[]'); } catch { /* corrupt telemetry only */ }
        if (!Array.isArray(activeJobs)) activeJobs = [];
        const seenMs = Date.parse(row.last_seen_at);
        const ageMs = Number.isFinite(seenMs) ? Math.max(0, now - seenMs) : null;
        // A PID is meaningful only on the host that emitted it. Calling
        // process.kill(pid, 0) for a copied/remote heartbeat can collide with
        // an unrelated local process that happens to have the same PID.
        const isLocal = !!currentHostId && row.host_id === currentHostId;
        const processAlive = isLocal ? pidAlive(row.pid) : null;
        const fresh = ageMs != null && ageMs <= 15_000;
        return {
          ...row,
          activeJobs,
          ageMs,
          fresh,
          isLocal,
          processAlive,
          healthy: isLocal && fresh && processAlive === true,
        };
      });
      const localHeartbeats = heartbeats.filter((row) => row.isLocal);
      const healthyHeartbeats = localHeartbeats.filter((row) => row.healthy);
      const primary = healthyHeartbeats[0] || localHeartbeats[0] || null;
      const healthyPids = new Set(healthyHeartbeats.map((row) => Number(row.pid)));
      const running = listRunningJobs();
      const leaseHealthy = running.every((job) => {
        const expiry = Date.parse(job.lease_expires_at || '');
        return healthyPids.has(Number(job.worker_pid)) && Number.isFinite(expiry) && expiry > now;
      });
      let staleReason = null;
      if (!primary) staleReason = `no worker heartbeat has been recorded for host ${currentHostId || '(unidentified)'}`;
      else if (!primary.fresh) staleReason = `last heartbeat was ${Math.round((primary.ageMs || 0) / 1000)}s ago`;
      else if (!primary.processAlive) staleReason = `worker pid ${primary.pid} is not alive`;
      else if (!leaseHealthy) staleReason = 'one or more running job leases is stale';

      let executionHost = null;
      try {
        const {
          readExecutionHostPolicy, evaluateExecutionHostPolicy, isExplicitMultiHostOptIn,
        } = await import('./lib/execution-host-policy.js');
        const policy = await readExecutionHostPolicy();
        executionHost = evaluateExecutionHostPolicy({
          policy,
          role: currentRole,
          hostId: currentHostId,
          allowMultiHost: isExplicitMultiHostOptIn(process.env),
        });
      } catch (err) {
        executionHost = { allowed: false, reason: err.message };
      }

      const pm2Managed = process.env.pm_id !== undefined;
      res.json({
        web: {
          pid: process.pid,
          startedAt: WEB_STARTED_AT,
          pm2Managed,
          role: currentRole,
          hostId: currentHostId,
        },
        worker: {
          alive: healthyHeartbeats.length > 0 && leaseHealthy,
          pid: primary?.pid ?? null,
          lastSeenAt: primary?.last_seen_at ?? null,
          startedAt: primary?.started_at ?? null,
          capacity: healthyHeartbeats.reduce((sum, row) => sum + Math.max(0, Number(row.capacity) || 0), 0),
          activeJobs: healthyHeartbeats.flatMap((row) => row.activeJobs),
          leaseHealthy,
          staleReason,
          instances: heartbeats,
        },
        executionHost,
        capabilities: {
          restartUi: pm2Managed,
          terminal: terminalEnabled,
          terminalCancellation: terminalEnabled ? 'abort-http-request' : null,
          // Remote-host sync is not part of the public release.
          nas: false,
          nasRole: currentRole,
          nasCancellation: false,
          nasProgress: 'buffered',
          queueActions: QUEUE_ACTIONS,
          nonCancellableActions: [...NON_CANCELLABLE_ACTIONS],
          actions: UI_ACTION_META,
        },
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Durable attention center: questions, notices, autopilot approvals ──
  app.get('/api/attention', (req, res) => {
    try {
      const project = typeof req.query.project === 'string' && req.query.project ? req.query.project : null;
      const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '50', 10) || 50, 1), 200);
      const questions = listOperatorQuestions({ project, status: 'open' }).map((row) => {
        let options = [];
        try { options = JSON.parse(row.options || '[]'); } catch { /* corrupt legacy row */ }
        return { ...row, options: Array.isArray(options) ? options : [] };
      });
      const notifications = project
        ? getDb().prepare(`SELECT * FROM notify_outbox WHERE project = ? ORDER BY id DESC LIMIT ?`).all(project, limit)
        : getDb().prepare(`SELECT * FROM notify_outbox ORDER BY id DESC LIMIT ?`).all(limit);
      const approvals = project
        ? getDb().prepare(`SELECT * FROM autopilot_approvals WHERE project = ? ORDER BY id DESC`).all(project)
        : getDb().prepare(`SELECT * FROM autopilot_approvals ORDER BY id DESC LIMIT ?`).all(limit);
      const now = Date.now();
      const annotatedApprovals = approvals.map((row) => ({
        ...row,
        valid: (row.remaining_nights == null || row.remaining_nights > 0)
          && (row.expires_at == null || new Date(row.expires_at).getTime() > now)
          && !(row.remaining_nights == null && row.expires_at == null),
      }));
      const autopilot = getAutopilotState();
      let lastPlan = null;
      try { lastPlan = JSON.parse(autopilot.last_plan_json || 'null'); } catch { /* telemetry only */ }
      res.json({ questions, notifications, approvals: annotatedApprovals, autopilot: { ...autopilot, lastPlan } });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/attention/questions/:id/answer', async (req, res) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      const answer = req.body?.answer;
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid question id' });
      if (typeof answer !== 'string' || !answer.trim()) return res.status(400).json({ error: 'answer must be a non-empty string' });
      const { resolveOperatorQuestion, OPERATOR_ANSWER_MAX_CHARS } = await import('./lib/operator-questions.js');
      if (answer.trim().length > OPERATOR_ANSWER_MAX_CHARS) {
        return res.status(400).json({ error: `answer must be ${OPERATOR_ANSWER_MAX_CHARS} characters or fewer` });
      }
      const result = await resolveOperatorQuestion({ id, answer: answer.trim(), answeredBy: null });
      if (!result.found) return res.status(404).json({ error: 'Operator question not found' });
      res.status(result.applied === false ? 200 : 201).json({ ok: true, ...result });
    } catch (e) {
      const status = e.code === 'OPERATOR_ANSWER_TOO_LONG' ? 400 : 500;
      res.status(status).json({ error: e.message, code: e.code || null, compensated: e.compensated ?? undefined });
    }
  });

  app.post('/api/attention/approvals', async (req, res) => {
    try {
      const { project, action, until = null, scope = 'all' } = req.body || {};
      const nights = req.body?.nights == null ? null : Number.parseInt(req.body.nights, 10);
      if (!getProject(project)) return res.status(404).json({ error: 'Project not found' });
      if (!AUTOPILOT_APPROVAL_ACTIONS.has(action)) return res.status(400).json({ error: 'Unsupported approval action' });
      if (until == null && (!Number.isInteger(nights) || nights < 1 || nights > 30)) {
        return res.status(400).json({ error: 'nights must be a whole number from 1 to 30' });
      }
      if (typeof scope !== 'string' || scope.length > 100) return res.status(400).json({ error: 'scope must be at most 100 characters' });
      const { grantApproval } = await import('./lib/portfolio-autopilot.js');
      const approval = grantApproval({ project, action, nights, until, scope });
      res.status(201).json({ ok: true, approval });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.delete('/api/attention/approvals/:id', (req, res) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid approval id' });
      const result = getDb().prepare(`DELETE FROM autopilot_approvals WHERE id = ?`).run(id);
      if (!result.changes) return res.status(404).json({ error: 'Approval not found' });
      res.json({ ok: true, id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Billing window status (global scope — no project overrides) ──
  // Returns billing-guard's windowStatus() verbatim; it already includes
  // windowHours alongside state/calls/cost/thresholds.
  app.get('/api/window', async (_req, res) => {
    try {
      const cfg = await resolveGlobalConfig();
      res.json({ ...windowStatus(cfg), weekly: weeklyUsage(cfg) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── All projects ──
  app.get('/api/projects', async (_req, res) => {
    try {
      const projects = listProjects();
      const enriched = await Promise.all(projects.map(async (p) => {
        const base = enrichProject(p);
        const billingConfig = await resolveEffectiveBilling(p.name);
        return { ...base, billingConfig };
      }));
      res.json(enriched);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Single project ──
  app.get('/api/projects/:name', async (req, res) => {
    try {
      const p = getProject(req.params.name);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      const base = enrichProject(p);
      const [billingConfig, effectiveConfig] = await Promise.all([
        resolveEffectiveBilling(p.name),
        resolveConfig({ project: p.name, task: 'dev-execution' }),
      ]);
      res.json({ ...base, billingConfig, effectiveConfig });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Recent calls (optional ?phase=N filter) ──
  app.get('/api/projects/:name/calls', (req, res) => {
    try {
      const parsedLimit = parseBoundedQueryInt(req.query.limit, {
        fallback: 50, min: 1, max: 200, label: '?limit',
      });
      if (!parsedLimit.ok) return res.status(400).json({ error: parsedLimit.error });
      const limit = parsedLimit.value;
      let phase = null;
      if (req.query.phase != null) {
        const parsed = Number.parseInt(req.query.phase, 10);
        if (!Number.isInteger(parsed) || parsed < 0) {
          return res.status(400).json({ error: '?phase must be a non-negative integer' });
        }
        phase = parsed;
      }
      res.json(recentCalls(req.params.name, limit, phase));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Global activity ──
  app.get('/api/activity', (_req, res) => {
    try { res.json(globalActivity()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Spend report (task×model cost + cache-hit %, optional ?project=&days=) ──
  // Same getSpendReport() helper (src/state.js) as the CLI/Telegram/Discord
  // /spend command — one aggregation query shared across both surfaces.
  app.get('/api/spend', (req, res) => {
    try {
      const parsedDays = parseInt(req.query.days || '30', 10);
      const days = Math.min(Math.max(Number.isFinite(parsedDays) ? parsedDays : 30, 1), 365);
      const project = req.query.project || null;
      if (project && !getProject(project)) {
        return res.status(404).json({ error: 'Project not found' });
      }
      res.json(getSpendReport({ days, project }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Auto-run history ──
  app.get('/api/projects/:name/runs', (req, res) => {
    try {
      const p = getProject(req.params.name);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      const parsed = parseInt(req.query.limit || '20', 10);
      const limit = Math.min(Math.max(Number.isFinite(parsed) ? parsed : 20, 1), 100);
      res.json(listAutoRuns(req.params.name, limit));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Run timeline (Phase 57 — P1 run_events) — id-ordered rows for one run.
  // [] for an unknown/legacy run (no rows ever recorded) — never 404s on that,
  // only on an unknown PROJECT.
  app.get('/api/projects/:name/runs/:id/events', (req, res) => {
    try {
      const p = getProject(req.params.name);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      const runId = parseInt(req.params.id, 10);
      if (!Number.isInteger(runId)) return res.status(400).json({ error: 'Invalid run id' });
      res.json(listRunEvents(runId));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Quality report (Phase 60 — P4) — acceptance first-pass %, per-task
  // escalation/turns, bug-round convergence, 7d-vs-30d cache trend. One
  // shared getQualityReport() helper (src/state.js) — the get_quality_report
  // chat tool reuses it, so both surfaces can never disagree on the numbers.
  app.get('/api/projects/:name/quality', (req, res) => {
    try {
      const p = getProject(req.params.name);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      const parsedDays = parseInt(req.query.days || '30', 10);
      const days = Math.min(Math.max(Number.isFinite(parsedDays) ? parsedDays : 30, 1), 365);
      res.json(getQualityReport({ project: req.params.name, days }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Routing transparency (Phase 61 — P5) — one phase's calls chain
  // (started_at order) with model/task/routing tier+reason/attempt/escalated/
  // num_turns/is_error, joined with the phase's status and its latest
  // verify_results verdict. Pure read layer over foundations columns + P4;
  // NULL legacy routing columns pass through as-is (no crash) — the client
  // renders those as "no routing recorded". Same shared query helper
  // (getPhaseRoutingChain) the explain_routing chat tool uses, so the two
  // surfaces can never disagree.
  app.get('/api/projects/:name/phases/:n/routing', (req, res) => {
    try {
      const p = getProject(req.params.name);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      const phaseN = parseInt(req.params.n, 10);
      if (!Number.isInteger(phaseN)) return res.status(400).json({ error: 'Invalid phase number' });
      res.json(getPhaseRoutingChain({ project: req.params.name, phase: phaseN }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Pre-flight run forecast (Phase 63 — P7) — predict × live 5h window.
  // Deterministic, ZERO Claude calls: walks predictUpcoming's units against the
  // window's reclaim schedule and calls-OR-cost thresholds. Returns the SAME
  // object the forecast_run chat tool surfaces, so the web Go/Resume confirm
  // line and chat can never disagree. Cold projects mark low-confidence.
  app.get('/api/projects/:name/forecast', async (req, res) => {
    try {
      const p = getProject(req.params.name);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      res.json(await forecastRun(req.params.name));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Log tail — parsed tail of the newest stdout stream-json log ──
  // Never 500s on fs trouble: a missing/racing log degrades to {file:null}.
  app.get('/api/projects/:name/log-tail', async (req, res) => {
    const empty = { file: null, task: null, mtimeMs: null, active: false, entries: [] };
    try {
      const p = getProject(req.params.name);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      const parsedLines = parseInt(req.query.lines || '80', 10);
      const lines = Math.min(Math.max(Number.isFinite(parsedLines) ? parsedLines : 80, 1), 300);
      const name = req.params.name;
      const prefix = `${name}-`;

      // Log files are `${project}-${task}-${ts}.stdout.log`. Project names may
      // contain dashes, so "api-" also prefixes "api-v2-…". Assign each file to
      // the LONGEST known project name it prefixes, and keep it only if that
      // owner is the requested project — otherwise "api" would tail "api-v2".
      const projectNames = listProjects().map(x => x.name).sort((a, b) => b.length - a.length);
      const ownerOf = (f) => projectNames.find(pn => f.startsWith(pn + '-')) || null;

      let names = [];
      try { names = await fs.readdir(LOGS_DIR); } catch { return res.json(empty); }
      let newest = null;
      for (const f of names) {
        if (!f.startsWith(prefix) || !f.endsWith('.stdout.log')) continue;
        if (ownerOf(f) !== name) continue; // a longer project name owns this file
        try {
          const st = await fs.stat(path.join(LOGS_DIR, f));
          if (!newest || st.mtimeMs > newest.mtimeMs) newest = { file: f, mtimeMs: st.mtimeMs, size: st.size };
        } catch { /* raced deletion — skip */ }
      }
      if (!newest) return res.json(empty);

      // Parse cache: LiveLog polls every 3s per client. When the file hasn't
      // grown (same mtime+size), reuse the parsed entries instead of re-reading
      // and re-parsing up to 256KB of stream-json on every tick.
      let parsed = _logTailCache.get(newest.file);
      if (!parsed || parsed.mtimeMs !== newest.mtimeMs || parsed.size !== newest.size) {
        // Read only the LAST ~256KB — logs can run to many MB during a phase.
        let text;
        let truncated = false;
        let fh = null;
        try {
          fh = await fs.open(path.join(LOGS_DIR, newest.file), 'r');
          const start = Math.max(0, newest.size - LOG_TAIL_MAX_BYTES);
          truncated = start > 0;
          const len = newest.size - start;
          const buf = Buffer.alloc(len);
          await fh.read(buf, 0, len, start);
          text = buf.toString('utf-8');
        } catch { return res.json(empty); }
        finally { try { await fh?.close(); } catch { /* already closed */ } }

        let rawLines = text.split('\n');
        if (truncated) rawLines = rawLines.slice(1); // drop the partial first line
        const entries = [];
        for (const line of rawLines) {
          if (!line.trim()) continue;
          entries.push(...mapStreamJsonLine(line));
        }
        // Filename shape: `${project}-${task}-${timestamp}.stdout.log`
        const rest = newest.file.slice(prefix.length).replace(/\.stdout\.log$/, '');
        const m = rest.match(/^(.+)-(\d+)$/);
        parsed = { mtimeMs: newest.mtimeMs, size: newest.size, task: m ? m[1] : rest, entries };
        if (_logTailCache.size > 32) _logTailCache.clear(); // bound memory across many projects
        _logTailCache.set(newest.file, parsed);
      }

      res.json({
        file: newest.file,
        task: parsed.task,
        mtimeMs: newest.mtimeMs,
        active: Date.now() - newest.mtimeMs < 15_000,
        entries: parsed.entries.slice(-lines),
      });
    } catch { res.json(empty); }
  });

  // ── Next actions — ranked "what next" suggestions from lib/next-actions ──
  app.get('/api/projects/:name/next-actions', (req, res) => {
    try {
      const p = getProject(req.params.name);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      const autoRun = getLastAutoRun(req.params.name);
      // Same lastAction mapping job-runner.js uses post-run; 'aborted' rows are
      // written by the abort paths and correspond to 'auto-run-cancelled'.
      const lastAction =
        autoRun?.status === 'failed'      ? 'auto-run-failed' :
        autoRun?.status === 'aborted'     ? 'auto-run-cancelled' :
        autoRun?.status === 'interrupted' ? 'auto-run-interrupted' :
        autoRun?.status === 'paused'      ? 'auto-run-paused' :
        autoRun?.status === 'completed'   ? 'auto-run-completed' :
        autoRun?.status === 'running'     ? null : // mid-run — generic options only
        p.total_phases > 0 ? 'plan' : 'brief';
      // Same state assembly as auto-runner.js / job-runner.js callers.
      const state = {
        currentPhase: p.current_phase,
        totalPhases:  p.total_phases,
        pauseReason:  autoRun?.pause_reason || null,
        pauseKind:    autoRun?.pause_kind ?? null,
      };
      const actions = getNextActions({ project: req.params.name, lastAction, state });
      // Lossless mapping: kind ← type ('telegram'|'cli'|'info'); cmd/category/
      // priority kept so the UI can render copy-paste commands and ordering.
      res.json(actions.map((a, i) => ({
        id: i,
        label: a.label,
        description: a.description || null,
        kind: a.type,
        cmd: a.cmd,
        category: a.category || null,
        priority: a.priority,
      })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Artifacts — list .md/.json/.jsonl files under .guide/ ──
  app.get('/api/projects/:name/artifacts', async (req, res) => {
    try {
      const p = getProject(req.params.name);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      const guideDir = path.join(PROJECTS_DIR, req.params.name, '.guide');
      const out = [];
      await walkArtifacts(guideDir, guideDir, 0, out); // missing .guide → []
      const order = new Map(ARTIFACT_GROUP_ORDER.map((g, i) => [g, i]));
      out.sort((a, b) => {
        const ga = order.get(a.group) ?? ARTIFACT_GROUP_ORDER.length;
        const gb = order.get(b.group) ?? ARTIFACT_GROUP_ORDER.length;
        if (ga !== gb) return ga - gb;
        return b.mtime.localeCompare(a.mtime); // ISO strings — lexical = chronological
      });
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Artifact file read — jailed to .guide/, allowlisted extensions only ──
  app.get('/api/projects/:name/artifacts/file', async (req, res) => {
    try {
      const p = getProject(req.params.name);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      const rel = String(req.query.path || '');
      if (!rel) return res.status(400).json({ error: '?path is required' });
      const guideDir = path.resolve(PROJECTS_DIR, req.params.name, '.guide');
      const resolved = path.resolve(guideDir, rel);
      if (!resolved.startsWith(guideDir + path.sep)) {
        return res.status(400).json({ error: 'path escapes the .guide directory' });
      }
      if (!ARTIFACT_EXTS.has(path.extname(resolved).toLowerCase())) {
        return res.status(400).json({ error: 'extension not allowed — .md/.json/.jsonl only' });
      }
      // The lexical prefix check above is defeated by a symlink planted inside
      // .guide/ (agents write there). Resolve symlinks and re-check the real path
      // is still inside the real .guide dir before reading.
      let realFile, realGuide;
      try {
        realGuide = await fs.realpath(guideDir);
        realFile = await fs.realpath(resolved);
      } catch (e) {
        if (e.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
        throw e;
      }
      if (realFile !== realGuide && !realFile.startsWith(realGuide + path.sep)) {
        return res.status(400).json({ error: 'path escapes the .guide directory' });
      }
      let content, st;
      try {
        [content, st] = await Promise.all([fs.readFile(realFile, 'utf-8'), fs.stat(realFile)]);
      } catch (e) {
        if (e.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
        throw e;
      }
      res.json({
        path: path.relative(guideDir, resolved).split(path.sep).join('/'),
        content,
        mtime: st.mtime.toISOString(),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Job queue snapshot ──
  app.get('/api/jobs', (_req, res) => {
    try {
      res.json({
        pending: listPendingJobs().map(annotateJobControls),
        running: listRunningJobs().map(annotateJobControls),
        recent: listRecentJobs(15).map((job) => annotateJobControls(annotateRetryability(job))),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Dequeue a pending job ──
  app.delete('/api/jobs/:id', (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid job id' });
      const job = getJob(id);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      if (job.status !== 'pending') return res.status(409).json({ error: 'Job is not pending' });
      dequeuePendingJob(id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Cancel a running job (durable request; worker kills its process group) ──
  app.post('/api/jobs/:id/cancel', (req, res) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid job id' });
      const job = getJob(id);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      if (job.status === 'cancelled') return res.json({ ok: true, requested: false, job });
      if (job.status !== 'running') return res.status(409).json({ error: `Job is ${job.status}, not running`, job });
      const capability = jobCancellationCapability(job);
      if (!capability.cancellable) {
        return res.status(409).json({
          error: capability.reason,
          code: 'JOB_NOT_CANCELLABLE',
          job: annotateJobControls(job),
        });
      }
      const requested = requestJobCancellation(id, 'cancelled via web UI job control');
      res.status(requested ? 202 : 409).json({ ok: requested, requested, jobId: id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Retry a failed/cancelled replay-safe job as a fresh queue row ──
  app.post('/api/jobs/:id/retry', (req, res) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid job id' });
      const original = getJob(id);
      if (!original) return res.status(404).json({ error: 'Job not found' });
      if (!getProject(original.project)) return res.status(409).json({ error: 'Project no longer exists' });
      if (rejectProjectMutation(res, original.project, 'retry this job')) return;
      const result = retryTerminalJob(id, { requestedBy: null });
      if (!result.retried) {
        const message = result.reason === 'not_replay_safe'
          ? `Action '${original.action}' is not safe to retry automatically`
          : `Job cannot be retried: ${result.reason}`;
        return res.status(409).json({ error: message, ...result });
      }
      res.status(202).json({ ok: true, ...result });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Reorder pending jobs without changing durable ids ──
  app.patch('/api/jobs/:id/reorder', (req, res) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid job id' });
      const direction = req.body?.direction ?? null;
      if (direction != null && !['up', 'down'].includes(direction)) {
        return res.status(400).json({ error: 'direction must be up or down' });
      }
      const hasBefore = Object.prototype.hasOwnProperty.call(req.body || {}, 'beforeId');
      const beforeId = hasBefore && req.body.beforeId !== null ? Number.parseInt(req.body.beforeId, 10) : (hasBefore ? null : undefined);
      if (hasBefore && req.body.beforeId !== null && !Number.isInteger(beforeId)) {
        return res.status(400).json({ error: 'beforeId must be a job id or null' });
      }
      const result = reorderPendingJob(id, { direction, beforeId });
      if (!result.reordered) return res.status(409).json({ error: `Job was not reordered: ${result.reason}`, ...result });
      res.json({ ok: true, ...result });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Chat control plane (v0.16) ──
  // POST message is a long-poll: the reply returns when the chat turn ends
  // (typically well under Node's 5-min default requestTimeout — heavy actions
  // are spawned detached by the control tools, never awaited in the turn).
  app.get('/api/chat/threads', async (_req, res) => {
    try {
      const { listChatThreads } = await import('./chat/chat-engine.js');
      res.json(listChatThreads(30));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/chat/threads', async (req, res) => {
    try {
      const { createChatThread, getChatThread } = await import('./chat/chat-engine.js');
      const project = req.body?.project || null;
      if (project && project !== '__self__' && !getProject(project)) return res.status(404).json({ error: `Project not found: ${project}` });
      const id = createChatThread({ project, title: req.body?.title || null });
      res.json(getChatThread(id));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/chat/threads/:id', async (req, res) => {
    try {
      const { getChatThread, listChatMessages, isThreadBusy } = await import('./chat/chat-engine.js');
      const id = parseInt(req.params.id, 10);
      const thread = getChatThread(id);
      if (!thread) return res.status(404).json({ error: 'Thread not found' });
      res.json({ thread, busy: isThreadBusy(id), messages: listChatMessages(id, 200) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/chat/threads/:id', async (req, res) => {
    try {
      const { deleteChatThread, isThreadBusy } = await import('./chat/chat-engine.js');
      const id = parseInt(req.params.id, 10);
      if (isThreadBusy(id)) return res.status(409).json({ error: 'Thread is processing a message' });
      deleteChatThread(id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/chat/threads/:id', async (req, res) => {
    try {
      const { getChatThread, setChatThreadTitle } = await import('./chat/chat-engine.js');
      const id = parseInt(req.params.id, 10);
      if (!getChatThread(id)) return res.status(404).json({ error: 'Thread not found' });
      const title = req.body?.title;
      if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'title must be a non-empty string' });
      setChatThreadTitle(id, title.slice(0, 100));
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/chat/threads/:id/messages', async (req, res) => {
    try {
      const { sendChatMessage } = await import('./chat/chat-engine.js');
      const idRaw = req.params.id;
      const threadId = idRaw === 'new' ? null : parseInt(idRaw, 10);
      if (idRaw !== 'new' && isNaN(threadId)) return res.status(400).json({ error: 'Invalid thread id' });
      const message = req.body?.message;
      if (typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'message must be a non-empty string' });
      }
      console.log(chalk.bold.cyan('[web-ui]') + chalk.dim(` chat #${idRaw}: ${message.slice(0, 60)}`));
      const rawProject = req.body?.project || null;
      const project = rawProject === '__self__' ? '__self__' : rawProject;
      const VALID_TIERS = new Set(['auto', 'haiku', 'sonnet', 'opus', 'fable']);
      const modelTier = VALID_TIERS.has(req.body?.modelTier) ? req.body.modelTier : 'auto';
      const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];

      const wantsSSE = req.headers['accept']?.includes('text/event-stream');
      if (wantsSSE) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        const send = (data) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`); };
        const onEvent = (ev) => {
          try {
            if (ev.type === 'assistant') {
              for (const b of (ev.message?.content || [])) {
                if (b.type === 'tool_use') send({ type: 'tool_use', name: b.name });
              }
            }
          } catch { /* never crash the runner */ }
        };
        try {
          const result = await sendChatMessage({ threadId, message, project, attachments, modelTier, onEvent });
          send({ type: 'done', ...result });
        } catch (e) {
          const text = `⚠ ${e.message}`;
          send({ type: 'error', error: e.message, reply: text, threadId: threadId ?? null });
        }
        res.end();
        return;
      }

      const result = await sendChatMessage({ threadId, message, project, attachments, modelTier });
      res.json(result);
    } catch (e) {
      const status = /already processing/.test(e.message) ? 409
        : /not found/i.test(e.message) ? 404 : 500;
      res.status(status).json({ error: e.message });
    }
  });

  app.post('/api/chat/threads/:id/cancel', async (req, res) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid thread id' });
      const { cancelChatTurn } = await import('./chat/chat-engine.js');
      const result = cancelChatTurn(id);
      res.status(result.cancelled ? 202 : 200).json({ ok: true, ...result });
    } catch (e) {
      const status = /not found/i.test(e.message) ? 404 : 500;
      res.status(status).json({ error: e.message });
    }
  });

  // ── Chat uploads ──
  // Raw-body route (application/octet-stream) so it bypasses the global JSON
  // parser and its 100kb limit; filename travels as a query param. Files land
  // in state/chat-uploads/ and messages reference them by stored name.
  app.post('/api/chat/uploads', express.raw({ type: 'application/octet-stream', limit: '25mb' }), async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Send the file bytes as application/octet-stream' });
      }
      const { storeChatUpload } = await import('./chat/control-actions.js');
      const stored = await storeChatUpload(String(req.query.filename || ''), req.body);
      console.log(chalk.bold.cyan('[web-ui]') + chalk.dim(` chat upload: ${stored.name} (${stored.size} bytes)`));
      res.json(stored);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.delete('/api/chat/uploads/:name', async (req, res) => {
    try {
      const { deleteChatUpload } = await import('./chat/control-actions.js');
      const result = await deleteChatUpload(req.params.name);
      res.json({ ok: true, ...result });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ── Bug capture (inbox) ──
  app.post('/api/projects/:name/bugs', (req, res) => {
    try {
      const p = getProject(req.params.name);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      const rawText = req.body?.raw_text;
      if (typeof rawText !== 'string' || rawText.trim().length === 0) {
        return res.status(400).json({ error: 'raw_text must be a non-empty string' });
      }
      if (rawText.trim().length > 20_000) return res.status(400).json({ error: 'raw_text must be 20000 characters or fewer' });
      let severity = req.body?.severity ?? 'unassigned';
      if (!['critical', 'major', 'minor', 'unassigned'].includes(severity)) {
        return res.status(400).json({ error: 'severity must be one of critical|major|minor|unassigned' });
      }
      let text = rawText.trim();
      const inline = text.match(/^(critical|major|minor)\s*[:|-]\s*(.+)$/is);
      if (severity === 'unassigned' && inline) {
        severity = inline[1].toLowerCase();
        text = inline[2].trim();
      }
      const id = addBug({ project: req.params.name, raw_text: text, severity, source: 'web' });
      res.json({ ok: true, id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Requirement capture (inbox) ──
  app.post('/api/projects/:name/requirements', (req, res) => {
    try {
      const p = getProject(req.params.name);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      const rawText = req.body?.raw_text;
      if (typeof rawText !== 'string' || rawText.trim().length === 0) {
        return res.status(400).json({ error: 'raw_text must be a non-empty string' });
      }
      if (rawText.trim().length > 20_000) return res.status(400).json({ error: 'raw_text must be 20000 characters or fewer' });
      const id = addRequirement({ project: req.params.name, raw_text: rawText.trim(), source: 'web' });
      res.json({ ok: true, id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Abort ── Durable cross-process cancellation. The owning Claude runner
  // polls the job flag and kills its exact process group within one second.
  app.post('/api/projects/:name/abort', (req, res) => {
    try {
      const project = req.params.name;
      if (!getProject(project)) return res.status(404).json({ error: 'Project not found' });
      const active = getActiveAutoRun(project);
      const last = active || getLastAutoRun(project);
      const abortableRun = active || (last?.status === 'paused' ? last : null);
      const cancelledPending = cancelPendingJobsForProject(project, {
        actions: CONTINUATION_ACTIONS,
        reason: 'continuation cancelled via web UI abort',
      });

      const queueJobs = getRunningJobsForProject(project);
      if (queueJobs.length > 0) {
        const notCancellable = queueJobs
          .filter((job) => !jobCancellationCapability(job).cancellable)
          .map(annotateJobControls);
        const cancelling = queueJobs
          .filter((job) => jobCancellationCapability(job).cancellable)
          .filter((job) => requestJobCancellation(job.id, 'cancelled via web UI'))
          .map((job) => Number(job.id));
        if (cancelling.length === 0 && notCancellable.length > 0) {
          return res.status(409).json({
            error: notCancellable[0].cancel_block_reason,
            code: 'JOB_NOT_CANCELLABLE',
            jobs: notCancellable,
            cancelledPending,
          });
        }
        console.log(chalk.bold.cyan('[web-ui]') + chalk.dim(
          ` abort ${project}: cancellation requested for job(s) ${cancelling.join(', ')}`,
        ));
        return res.status(202).json({
          ok: true,
          cancelling,
          notCancellable,
          cancelledPending,
          autoRun: abortableRun?.id ?? null,
        });
      }

      // A CLI-owned run has a dedicated process, so SIGINT uses its normal
      // cancellation/finalization path without killing a shared queue worker.
      const owner = getRunningJob(project);
      if (owner?.pid && pidAlive(owner.pid)) {
        process.kill(owner.pid, 'SIGINT');
        return res.status(202).json({
          ok: true,
          cancellingPid: owner.pid,
          cancelledPending,
          autoRun: abortableRun?.id ?? null,
        });
      }

      if (!abortableRun && cancelledPending.length === 0) {
        return res.status(409).json({ error: 'No running/paused run or pending continuation to abort' });
      }

      // Paused runs and dead-owner running rows have no process left to burn
      // tokens, so terminalize them locally and remove queued continuations.
      const db = getDb();
      if (abortableRun) {
        db.prepare(`UPDATE auto_runs SET status='aborted', ended_at=? WHERE id=? AND status IN ('running','paused')`)
          .run(new Date().toISOString(), abortableRun.id);
      }
      db.prepare(`UPDATE projects SET status='cancelled' WHERE name=?`)
        .run(project);
      const p = getProject(project);
      uiEvents.emit('status', { type: 'status', project, status: 'cancelled', current_phase: p?.current_phase ?? null });
      console.log(chalk.bold.cyan('[web-ui]') + chalk.dim(` abort ${project}`) + '  ' + chalk.yellow(
        abortableRun ? `aborted auto-run #${abortableRun.id}` : `cancelled ${cancelledPending.length} continuation(s)`,
      ));
      res.json({ ok: true, aborted: abortableRun?.id ?? null, cancelledPending });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Stop all live runners and return the list of stopped project names ──
  // Queue jobs receive a durable cancellation flag; CLI-owned runs get SIGINT.
  app.post('/api/stop-all-running', (req, res) => {
    try {
      const stopped = new Set();
      const cancellingJobs = [];
      const notCancellable = [];
      const signalledPids = [];

      // Queue actions such as QA, sync, validate, or package may run without
      // creating an auto_run row. Cancel the authoritative queue snapshot
      // first so stop-all truly includes every running durable job.
      const runningQueue = listRunningJobs();
      const queueProjects = new Set();
      for (const job of runningQueue) {
        queueProjects.add(job.project);
        const capability = jobCancellationCapability(job);
        if (!capability.cancellable) {
          notCancellable.push(annotateJobControls(job));
          continue;
        }
        if (requestJobCancellation(job.id, 'stop-all via web UI')) {
          stopped.add(job.project);
          cancellingJobs.push(Number(job.id));
        }
      }

      for (const p of listProjects()) {
        // Never SIGINT a shared queue worker; its exact job is cancelled by
        // the durable flag above and the worker remains available afterward.
        if (queueProjects.has(p.name)) continue;
        const job = getRunningJob(p.name);
        if (!job?.pid || !pidAlive(job.pid)) continue;
        stopped.add(p.name);
        signalledPids.push(job.pid);
        try { process.kill(job.pid, 'SIGINT'); } catch { /* already gone */ }
      }
      const stoppedProjects = [...stopped];
      console.log(chalk.bold.cyan('[web-ui]') + chalk.dim(` stop-all-running: ${stoppedProjects.join(', ') || '(none)'}`));
      const responseStatus = stoppedProjects.length ? 202 : notCancellable.length ? 409 : 200;
      res.status(responseStatus).json({
        stopped: stoppedProjects,
        cancellingJobs,
        signalledPids,
        notCancellable,
        complete: stoppedProjects.length === 0 && notCancellable.length === 0,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Restart a list of previously stopped projects ──
  // Accepts { names: ['proj-a', 'proj-b'] } and durably queues `resume` for
  // each. Fail closed when any other queued/running work owns the project;
  // restart must not silently stack a different lifecycle behind it.
  app.post('/api/restart-previous', (req, res) => {
    try {
      const names = Array.isArray(req.body?.names) ? req.body.names : [];
      const restarted = [];
      const skipped = [];
      for (const name of new Set(names.filter((value) => typeof value === 'string' && value))) {
        if (!getProject(name)) {
          skipped.push({ name, reason: 'not_found' });
          continue;
        }
        const queued = enqueueProjectIdleActionJob({
          project: name, action: 'resume', args: { unattended: true, restartPrevious: true }, requestedBy: null,
        });
        if (!queued.scheduled) {
          skipped.push({ name, reason: 'project_busy', blocker: queued.blocker });
          continue;
        }
        restarted.push({ name, jobId: queued.jobId, scheduled: true });
      }
      console.log(chalk.bold.cyan('[web-ui]') + chalk.dim(` restart-previous: ${restarted.map((r) => r.name).join(', ') || '(none)'}`));
      res.status(restarted.some((r) => r.scheduled) ? 202 : 200).json({ restarted, skipped });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Restart UI process ──
  // Responds immediately, then exits after a short delay so PM2 (on NAS) can
  // auto-restart the web process with the latest code.  On a bare (non-PM2)
  // host this will simply stop the server — restart it manually with npm run ui.
  app.post('/api/restart-ui', (_req, res) => {
    if (process.env.pm_id === undefined) {
      return res.status(409).json({
        error: 'UI restart is unavailable because this process is not supervised by PM2',
        capability: { restartUi: false, supervisor: null },
      });
    }
    console.log(chalk.bold.cyan('[web-ui]') + chalk.yellow(' restart-ui: exiting process for PM2 restart'));
    res.status(202).json({ ok: true, message: 'Restarting UI process…', supervisor: 'pm2' });
    setTimeout(() => process.exit(0), 500);
  });

  // ── Go (durable auto-run) ──
  app.post('/api/projects/:name/go', (req, res) => {
    try {
      const p = getProject(req.params.name);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      const active = getActiveAutoRun(req.params.name);
      if (active) return res.status(409).json({ error: 'Auto-run already running' });
      const queued = enqueueProjectIdleActionJob({
        project: req.params.name, action: 'go', args: { unattended: true }, requestedBy: null,
      });
      return sendProjectQueueResult(res, queued, 'go');
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Resume (durable + deduplicated) ──
  app.post('/api/projects/:name/resume', (req, res) => {
    try {
      const p = getProject(req.params.name);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      const queued = enqueueProjectIdleActionJob({
        project: req.params.name, action: 'resume', args: { unattended: true }, requestedBy: null,
      });
      return sendProjectQueueResult(res, queued, 'resume');
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Next phase (durable) ──
  app.post('/api/projects/:name/next', (req, res) => {
    try {
      const p = getProject(req.params.name);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      const queued = enqueueProjectIdleActionJob({
        project: req.params.name, action: 'next', args: {}, requestedBy: null,
      });
      return sendProjectQueueResult(res, queued, 'next');
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Atomic stale-run recovery ──
  app.post('/api/projects/:name/recover-stale', (req, res) => {
    try {
      const project = req.params.name;
      if (!getProject(project)) return res.status(404).json({ error: 'Project not found' });
      const db = getDb();
      const result = db.transaction(() => {
        const active = db.prepare(`SELECT * FROM auto_runs WHERE project = ? AND status = 'running' ORDER BY id DESC LIMIT 1`).get(project);
        if (!active) return { recovered: false, reason: 'no_stale_run' };
        const owner = db.prepare(`SELECT * FROM running_jobs WHERE project = ?`).get(project);
        if (owner?.pid && pidAlive(owner.pid)) return { recovered: false, reason: 'owner_alive', pid: owner.pid };
        const queueRunning = db.prepare(`SELECT * FROM tg_jobs WHERE project = ? AND status = 'running' ORDER BY id`).all(project);
        if (queueRunning.length) return { recovered: false, reason: 'queue_job_running', jobs: queueRunning.map((j) => j.id) };

        const now = new Date().toISOString();
        db.prepare(`DELETE FROM running_jobs WHERE project = ?`).run(project);
        db.prepare(`UPDATE auto_runs SET status='interrupted', pause_reason=?, ended_at=? WHERE id=? AND status='running'`)
          .run('stale run recovered by operator via web UI', now, active.id);
        let pending = db.prepare(`SELECT id FROM tg_jobs WHERE project = ? AND action = 'resume' AND status = 'pending' ORDER BY id LIMIT 1`).get(project);
        let scheduled = false;
        if (!pending) {
          const inserted = db.prepare(`
            INSERT INTO tg_jobs (project, action, args_json, requested_by, requested_at, status)
            VALUES (?, 'resume', ?, NULL, ?, 'pending')
          `).run(project, JSON.stringify({ unattended: true, recoveredAutoRunId: Number(active.id) }), now);
          pending = { id: inserted.lastInsertRowid };
          scheduled = true;
        }
        return { recovered: true, autoRunId: Number(active.id), jobId: Number(pending.id), scheduled };
      }).immediate();
      if (!result.recovered) {
        const message = result.reason === 'owner_alive'
          ? `Run owner pid ${result.pid} is still alive`
          : result.reason === 'queue_job_running'
            ? 'A queue worker still owns this run'
            : 'No stale running auto-run was found';
        return res.status(409).json({ error: message, ...result });
      }
      uiEvents.emit('status', { type: 'status', project, status: 'recovering' });
      res.status(202).json({ ok: true, ...result });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Generic allowlisted lifecycle action ──
  app.post('/api/projects/:name/actions/:action', async (req, res) => {
    try {
      const project = req.params.name;
      const action = req.params.action;
      if (!getProject(project)) return res.status(404).json({ error: 'Project not found' });
      if (!Object.prototype.hasOwnProperty.call(UI_ACTION_META, action) || !QUEUE_ACTION_SET.has(action)) {
        return res.status(400).json({ error: `Unsupported UI action: ${action}`, supported: Object.keys(UI_ACTION_META) });
      }
      const args = req.body?.args && typeof req.body.args === 'object' && !Array.isArray(req.body.args)
        ? { ...req.body.args }
        : { ...(req.body || {}) };
      delete args.confirmed;
      if (action === 'discuss' && !args.topic && typeof args.prompt === 'string') args.topic = args.prompt;
      if (action === 'guide') {
        const { classifyGuideTask } = await import('./lib/guide-tasks.js');
        const verdict = classifyGuideTask(args.task);
        if (!verdict.ok || !verdict.task) {
          return res.status(400).json({ error: verdict.task ? `Guide task '${verdict.task}' is not queue-safe` : 'guide requires args.task' });
        }
      }
      if (action === 'discuss' && (typeof args.topic !== 'string' || !args.topic.trim())) {
        return res.status(400).json({ error: 'discuss requires a non-empty args.topic' });
      }
      if (action === 'retry-phase' && (!Number.isInteger(Number(args.phase)) || Number(args.phase) < 1)) {
        return res.status(400).json({ error: 'retry-phase requires args.phase as a positive integer' });
      }
      if (UI_ACTION_META[action].destructive && req.body?.confirmed !== true && req.body?.args?.confirmed !== true) {
        return res.status(400).json({ error: `${action} requires confirmed:true` });
      }
      const queued = enqueueProjectIdleActionJob({ project, action, args, requestedBy: null });
      return sendProjectQueueResult(res, queued, action);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Git sync — durable fast-forward-only pull ──
  app.post('/api/projects/:name/sync', (req, res) => {
    try {
      const p = getProject(req.params.name);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      if (!p.git_branch) return res.status(409).json({ error: 'Project has no git branch configured' });
      const queued = enqueueProjectIdleActionJob({
        project: req.params.name, action: 'sync', args: {}, requestedBy: null,
      });
      return sendProjectQueueResult(res, queued, 'sync');
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/projects/:name/git-status', async (req, res) => {
    try {
      if (!getProject(req.params.name)) return res.status(404).json({ error: 'Project not found' });
      const { getGitStatus } = await import('./commands/git-status.js');
      const result = await getGitStatus(req.params.name);
      if (!result.ok) return res.status(409).json(result);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Release archives ── authenticated by the global /api Bearer guard.
  // Only packageProject's timestamped ZIP names are visible, and both listing
  // and download reject symlinks plus lexical/realpath escapes from outputs/.
  app.get('/api/projects/:name/releases', async (req, res) => {
    try {
      if (!getProject(req.params.name)) return res.status(404).json({ error: 'Project not found' });
      const releases = await listReleaseArchives(req.params.name);
      res.json({ releases });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/projects/:name/releases/:file', async (req, res) => {
    try {
      if (!getProject(req.params.name)) return res.status(404).json({ error: 'Project not found' });
      const release = await resolveReleaseArchive(req.params.name, req.params.file);
      if (!release) return res.status(404).json({ error: 'Release archive not found' });
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.download(release.path, release.filename, (err) => {
        if (!err) return;
        if (!res.headersSent) res.status(err.statusCode || 500).json({ error: 'Release download failed' });
        else res.destroy(err);
      });
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });

  // ── Remove project ──
  app.delete('/api/projects/:name', async (req, res) => {
    try {
      const p = getProject(req.params.name);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      const keepFiles = req.query.keepFiles === '1';
      const { removeProject } = await import('./commands/remove-project.js');
      const result = await removeProject({ name: req.params.name, keepFiles });
      uiEvents.emit('status', { type: 'removed', project: req.params.name });
      if (!result.ok) {
        console.error(chalk.bold.cyan('[web-ui]') + chalk.dim(` remove ${req.params.name}`) + '  ' + chalk.red('partial deletion'));
        return res.status(500).json({ error: result.filesError || 'Project database row deleted but file cleanup failed', ...result });
      }
      console.log(chalk.bold.cyan('[web-ui]') + chalk.dim(` remove ${req.params.name}`) + '  ' + chalk.green('deleted'));
      res.json(result);
    } catch (e) {
      const status = e.code === 'PROJECT_BUSY' ? 409 : e.code === 'PROJECT_REMOVE_PARTIAL' ? 500 : 500;
      res.status(status).json({ error: e.message, code: e.code || null, details: e.details || null });
    }
  });

  // ── Per-project healing log ──
  app.get('/api/projects/:name/healing', (req, res) => {
    try { res.json(listHealingLog(req.params.name, 20)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Global healing log ──
  app.get('/api/healing', (req, res) => {
    try {
      const parsedLimit = parseBoundedQueryInt(req.query.limit, {
        fallback: 40, min: 1, max: 200, label: '?limit',
      });
      if (!parsedLimit.ok) return res.status(400).json({ error: parsedLimit.error });
      res.json(listHealingLog(null, parsedLimit.value));
    }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Available profiles ──
  app.get('/api/profiles', async (_req, res) => {
    try {
      const files = await fs.readdir(PROFILES_DIR).catch(() => []);
      const names = files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
      res.json(names);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Create project ── (runs in-process, same as Telegram bot)
  app.post('/api/projects', async (req, res) => {
    const { name, gitRemote, gitBranch = 'develop', tech = '', profile = null, noGit = false } = req.body || {};
    if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      return res.status(400).json({ error: 'Invalid project name — use lowercase letters, numbers, hyphens' });
    }
    if (!noGit && !gitRemote) {
      return res.status(400).json({ error: 'git-remote is required (or set no-git)' });
    }
    try {
      const { createProject } = await import('./commands/create-project.js');
      const progress = [];
      const result = await createProject({
        name,
        url: noGit ? null : gitRemote,
        branch: gitBranch,
        tech,
        profile: profile || null,
        noGit: !!noGit,
        onProgress: (line) => {
          console.log(chalk.bold.cyan('[web-ui create]') + chalk.dim(' ' + line));
          progress.push(line);
        },
      });
      console.log(chalk.green(`[web-ui] created project: ${name}`));
      res.json({ ok: true, ...result, progress });
    } catch (e) {
      console.error(chalk.red(`[web-ui] create failed: ${e.message}`));
      res.status(500).json({ error: e.message });
    }
  });

  // ── Get raw-thoughts (next brief queue) ──
  app.get('/api/projects/:name/raw-thoughts', async (req, res) => {
    try {
      if (!getProject(req.params.name)) return res.status(404).json({ error: 'Project not found' });
      const f = path.join(PROJECTS_DIR, req.params.name, '.guide', 'raw-thoughts.md');
      res.json(await fileSnapshot(f));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Save raw-thoughts ──
  app.post('/api/projects/:name/raw-thoughts', async (req, res) => {
    const { content = '', expectedMtime } = req.body || {};
    if (typeof content !== 'string') return res.status(400).json({ error: 'content must be a string' });
    if (!getProject(req.params.name)) return res.status(404).json({ error: 'Project not found' });
    const mutationKey = `${req.params.name}:raw-thoughts`;
    if (fileMutations.has(mutationKey)) return res.status(409).json({ error: 'raw-thoughts is already being saved' });
    const blockers = projectMutationBlockers(req.params.name);
    if (blockers.length) return res.status(409).json({ error: 'Cannot edit raw-thoughts while project work is active or queued', blockers });
    fileMutations.add(mutationKey);
    try {
      const guideDir = path.join(PROJECTS_DIR, req.params.name, '.guide');
      const target = path.join(guideDir, 'raw-thoughts.md');
      const before = await fileSnapshot(target);
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'expectedMtime') && !mtimeMatches(expectedMtime, before.mtime)) {
        return res.status(409).json({
          error: 'raw-thoughts changed since it was loaded',
          currentMtime: before.mtime,
          currentVersion: before.version,
        });
      }
      await fs.mkdir(guideDir, { recursive: true });
      const tmp = path.join(guideDir, `.raw-thoughts.${process.pid}.${Date.now()}.tmp`);
      await fs.writeFile(tmp, content, 'utf-8');
      await fs.rename(tmp, target);
      console.log(chalk.bold.cyan('[web-ui]') + chalk.dim(` raw-thoughts saved: ${req.params.name}`));
      const after = await fileSnapshot(target);
      res.json({ ok: true, mtime: after.mtime, version: after.version });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { fileMutations.delete(mutationKey); }
  });

  // ── Launch next brief: durable brief-author → unattended go ──
  app.post('/api/projects/:name/next-brief/launch', (req, res) => {
    try {
      const p = getProject(req.params.name);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      if (rejectProjectMutation(res, req.params.name, 'launch the next brief')) return;
      const queued = enqueueProjectIdleActionJob({
        project: req.params.name,
        action: 'next-brief',
        args: { unattended: true },
        requestedBy: null,
      });
      return sendProjectQueueResult(res, queued, 'next-brief');
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Get brief ──
  app.get('/api/projects/:name/brief', async (req, res) => {
    try {
      if (!getProject(req.params.name)) return res.status(404).json({ error: 'Project not found' });
      const guideDir  = path.join(PROJECTS_DIR, req.params.name, '.guide');
      const briefFile = path.join(guideDir, 'brief.md');
      const rawFile   = path.join(guideDir, 'raw-thoughts.md');
      const [brief, rawStat] = await Promise.all([fileSnapshot(briefFile), fs.stat(rawFile).catch(() => null)]);
      // alreadyGenerated: brief.md exists and is newer-or-equal to raw-thoughts.md
      const briefMtime = brief.mtime ? new Date(brief.mtime).getTime() : 0;
      const rawMtime   = rawStat?.mtime?.getTime()   || 0;
      const alreadyGenerated = briefMtime > 0 && briefMtime >= rawMtime;
      res.json({ content: brief.content, version: brief.version, briefMtime: brief.mtime, rawMtime: rawStat?.mtime?.toISOString() || null, alreadyGenerated });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Save brief ──
  app.post('/api/projects/:name/brief', async (req, res) => {
    const { content = '', expectedMtime } = req.body || {};
    if (typeof content !== 'string') return res.status(400).json({ error: 'content must be a string' });
    if (!getProject(req.params.name)) return res.status(404).json({ error: 'Project not found' });
    const mutationKey = `${req.params.name}:brief`;
    if (fileMutations.has(mutationKey)) return res.status(409).json({ error: 'brief is already being saved' });
    const blockers = projectMutationBlockers(req.params.name);
    if (blockers.length) return res.status(409).json({ error: 'Cannot edit brief while project work is active or queued', blockers });
    fileMutations.add(mutationKey);
    try {
      const guideDir = path.join(PROJECTS_DIR, req.params.name, '.guide');
      const target = path.join(guideDir, 'brief.md');
      const before = await fileSnapshot(target);
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'expectedMtime') && !mtimeMatches(expectedMtime, before.mtime)) {
        return res.status(409).json({
          error: 'brief changed since it was loaded',
          currentMtime: before.mtime,
          currentVersion: before.version,
        });
      }
      await fs.mkdir(guideDir, { recursive: true });
      const tmp = path.join(guideDir, `.brief.${process.pid}.${Date.now()}.tmp`);
      await fs.writeFile(tmp, content, 'utf-8');
      await fs.rename(tmp, target);
      console.log(chalk.bold.cyan('[web-ui]') + chalk.dim(` brief saved: ${req.params.name}`));
      const after = await fileSnapshot(target);
      res.json({ ok: true, briefMtime: after.mtime, version: after.version });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { fileMutations.delete(mutationKey); }
  });

  // ── Run brief agent as a durable queue job ──
  app.post('/api/projects/:name/brief/run', (req, res) => {
    try {
      const p = getProject(req.params.name);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      if (rejectProjectMutation(res, req.params.name, 'run the brief agent')) return;
      const queued = enqueueProjectIdleActionJob({
        project: req.params.name, action: 'brief', args: {}, requestedBy: null,
      });
      return sendProjectQueueResult(res, queued, 'brief');
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Skip a pending phase (queue management) ──
  app.post('/api/projects/:name/phases/:n/skip', (req, res) => {
    try {
      const p = getProject(req.params.name);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      if (rejectProjectMutation(res, req.params.name, 'skip a phase')) return;
      const n = parseInt(req.params.n, 10);
      if (isNaN(n) || n < 1) return res.status(400).json({ error: 'Invalid phase number' });
      const result = skipPhase(req.params.name, n);
      if (result.changes === 0) return res.status(409).json({ error: 'Phase not found or not in pending state' });
      console.log(chalk.bold.cyan('[web-ui]') + chalk.dim(` phase ${n} skipped: ${req.params.name}`));
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Clear queued next-brief (delete raw-thoughts.md) ──
  app.delete('/api/projects/:name/brief/next', async (req, res) => {
    try {
      const p = getProject(req.params.name);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      if (rejectProjectMutation(res, req.params.name, 'clear the next brief')) return;
      const rawPath = path.join(PROJECTS_DIR, req.params.name, '.guide', 'raw-thoughts.md');
      await fs.writeFile(rawPath, '', 'utf-8');
      console.log(chalk.bold.cyan('[web-ui]') + chalk.dim(` next-brief cleared: ${req.params.name}`));
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Brief queue: list inputs/queue/*.md in alphabetical order ──
  app.get('/api/projects/:name/brief-queue', async (req, res) => {
    try {
      if (!getProject(req.params.name)) return res.status(404).json({ error: 'Project not found' });
      const queueDir = path.join(PROJECTS_DIR, req.params.name, 'inputs', 'queue');
      let entries = [];
      try { entries = await fs.readdir(queueDir); } catch { /* no queue dir yet */ }
      const files = entries.filter(f => f.endsWith('.md')).sort();
      const items = await Promise.all(files.map(async (f) => {
        const fp = path.join(queueDir, f);
        const [ct, st] = await Promise.allSettled([fs.readFile(fp, 'utf-8'), fs.stat(fp)]);
        const raw = ct.status === 'fulfilled' ? ct.value : '';
        const preview = raw.split('\n').map(l => l.trim()).find(l => l.length > 0) || f;
        return { filename: f, size: st.status === 'fulfilled' ? st.value.size : 0, preview };
      }));
      res.json(items);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Brief queue: add ──
  app.post('/api/projects/:name/brief-queue', async (req, res) => {
    if (!getProject(req.params.name)) return res.status(404).json({ error: 'Project not found' });
    if (rejectProjectMutation(res, req.params.name, 'change the brief queue')) return;
    const raw = String(req.body?.filename || '').trim();
    const filename = path.basename(raw);
    if (!filename || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*\.md$/.test(filename)) {
      return res.status(400).json({ error: 'filename must be alphanumeric (hyphens/underscores allowed) ending in .md' });
    }
    const content = String(req.body?.content || '');
    const queueDir = path.join(PROJECTS_DIR, req.params.name, 'inputs', 'queue');
    try {
      await fs.mkdir(queueDir, { recursive: true });
      await fs.writeFile(path.join(queueDir, filename), content, 'utf-8');
      console.log(chalk.bold.cyan('[web-ui]') + chalk.dim(` brief-queue add: ${req.params.name}/${filename}`));
      res.json({ ok: true, filename });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Brief queue: remove ──
  app.delete('/api/projects/:name/brief-queue/:filename', async (req, res) => {
    if (!getProject(req.params.name)) return res.status(404).json({ error: 'Project not found' });
    if (rejectProjectMutation(res, req.params.name, 'change the brief queue')) return;
    const filename = path.basename(req.params.filename);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*\.md$/.test(filename)) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const fp = path.join(PROJECTS_DIR, req.params.name, 'inputs', 'queue', filename);
    try {
      await fs.unlink(fp);
      console.log(chalk.bold.cyan('[web-ui]') + chalk.dim(` brief-queue remove: ${req.params.name}/${filename}`));
      res.json({ ok: true });
    } catch (e) {
      if (e.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
      res.status(500).json({ error: e.message });
    }
  });

  // ── Brief chain: durable queue job, executed by the PM2 headless worker ──
  app.post('/api/projects/:name/brief-chain', (req, res) => {
    try {
      const p = getProject(req.params.name);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      if (rejectProjectMutation(res, req.params.name, 'start the brief chain')) return;
      const queued = enqueueProjectIdleActionJob({
        project: req.params.name,
        action: 'brief-chain',
        args: { unattended: true },
        requestedBy: null,
      });
      if (queued.scheduled) {
        console.log(chalk.bold.cyan('[web-ui]') + chalk.dim(` brief-chain: ${req.params.name} queued as job #${queued.jobId}`));
      }
      return sendProjectQueueResult(res, queued, 'brief-chain');
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Launch full pipeline as a durable queue job. Provider/budget pauses
  //    schedule a deduplicated resume; PM2 restarts the headless worker. ──
  app.post('/api/projects/:name/launch', (req, res) => {
    try {
      const p = getProject(req.params.name);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      if (rejectProjectMutation(res, req.params.name, 'launch the pipeline')) return;
      const queued = enqueueProjectIdleActionJob({
        project: req.params.name,
        action: 'pipeline',
        args: {
          unattended: true,
          rounds: req.body?.rounds ?? 2,
          stopAfter: req.body?.stopAfter ?? null,
        },
        requestedBy: null,
      });
      if (queued.scheduled) {
        console.log(chalk.bold.cyan('[web-ui]') + chalk.dim(` launch: ${req.params.name} queued as job #${queued.jobId}`));
      }
      return sendProjectQueueResult(res, queued, 'pipeline');
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Global SSE stream ──
  app.get('/api/stream', (req, res) => {
    const client = startSseResponse(res);
    _globalSseClients.add(client);

    // First frame on every (re)connect: the client compares this to the value
    // it first saw and reloads itself if the server has shipped new assets.
    try { client.write({ type: 'hello', assetVersion: assetVersion() }); }
    catch { _globalSseClients.delete(client); }

    if (!_globalSseTimer) {
      _globalSseLastCallId = getDb().prepare('SELECT COALESCE(MAX(id),0) AS m FROM calls').get().m;
      // Phase 58: start at the current high-water mark so a fresh connection
      // mirrors only notices queued from now on — not the entire backlog.
      _globalSseLastOutboxId = getMaxOutboxId();
      getDb().prepare('SELECT name, status, current_phase FROM projects').all()
        .forEach(p => { _globalSseSnapshot[p.name] = { status: p.status, current_phase: p.current_phase }; });

      _globalSseTimer = setInterval(() => {
        if (_globalSseClients.size === 0) return;
        const newCalls = getDb()
          .prepare('SELECT id, project, phase, task, model, cost_usd, input_tokens, output_tokens, is_error FROM calls WHERE id > ? ORDER BY id ASC')
          .all(_globalSseLastCallId);
        for (const row of newCalls) {
          const evt = buildCallEvent(row);
          for (const c of _globalSseClients) { try { c.write(evt); } catch { _globalSseClients.delete(c); } }
          _globalSseLastCallId = row.id;
        }
        const projects = getDb().prepare('SELECT name, status, current_phase FROM projects').all();
        for (const p of projects) {
          const prev = _globalSseSnapshot[p.name];
          if (!prev || prev.status !== p.status || prev.current_phase !== p.current_phase) {
            const evt = { type: 'status', project: p.name, status: p.status, current_phase: p.current_phase };
            for (const c of _globalSseClients) { try { c.write(evt); } catch { _globalSseClients.delete(c); } }
            _globalSseSnapshot[p.name] = { status: p.status, current_phase: p.current_phase };
          }
        }
        // Phase 58 (notify_outbox): mirror new outbox rows as { type:'notify' }
        // to the browser exactly once each. The cursor advances past every row
        // read so no row is emitted twice across ticks. Read-only mirror — the
        // web UI NEVER marks a row delivered (that's server-discord.js's job);
        // it only surfaces the notice as a toast.
        const newNotices = listOutboxSince(_globalSseLastOutboxId);
        for (const row of newNotices) {
          const evt = { type: 'notify', project: row.project, text: row.text };
          for (const c of _globalSseClients) { try { c.write(evt); } catch { _globalSseClients.delete(c); } }
          _globalSseLastOutboxId = row.id;
        }
        // Every 10th tick (~5s): push window status if calls/cost moved.
        // Fire-and-forget — broadcastWindowStatus never throws.
        _globalSseTick += 1;
        if (_globalSseTick % 10 === 0) void broadcastWindowStatus();
      }, 500);
    }

    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
    const onUiEvent = (evt) => { try { client.write(evt); } catch { _globalSseClients.delete(client); } };
    uiEvents.on('status', onUiEvent);
    uiEvents.on('call', onUiEvent);

    res.on('close', () => {
      _globalSseClients.delete(client);
      clearInterval(heartbeat);
      uiEvents.off('status', onUiEvent);
      uiEvents.off('call', onUiEvent);
      if (_globalSseClients.size === 0) {
        clearInterval(_globalSseTimer);
        _globalSseTimer = null;
      }
    });
  });

  // ── Per-project SSE stream ──
  app.get('/api/projects/:name/stream', (req, res) => {
    const p = getProject(req.params.name);
    if (!p) return res.status(404).json({ error: 'Project not found' });

    const client = startSseResponse(res);
    const projectName = req.params.name;

    if (!_projectSseClients.has(projectName)) _projectSseClients.set(projectName, new Set());
    _projectSseClients.get(projectName).add(client);

    if (!_projectSseTimers.has(projectName)) {
      _projectSseLastCallIds.set(projectName, getDb().prepare('SELECT COALESCE(MAX(id),0) AS m FROM calls').get().m);
      const row = getDb().prepare('SELECT name, status, current_phase FROM projects WHERE name = ?').get(projectName);
      _projectSseSnapshots.set(projectName, row ? { [row.name]: { status: row.status, current_phase: row.current_phase } } : {});

      const timer = setInterval(() => {
        const clients = _projectSseClients.get(projectName);
        if (!clients || clients.size === 0) return;
        const lastId = _projectSseLastCallIds.get(projectName);
        const newCalls = getDb()
          .prepare('SELECT id, project, phase, task, model, cost_usd, input_tokens, output_tokens, is_error FROM calls WHERE id > ? AND project = ? ORDER BY id ASC')
          .all(lastId, projectName);
        for (const row of newCalls) {
          const evt = buildCallEvent(row);
          for (const c of clients) { try { c.write(evt); } catch { clients.delete(c); } }
          _projectSseLastCallIds.set(projectName, row.id);
        }
        const cur = getDb().prepare('SELECT name, status, current_phase FROM projects WHERE name = ?').get(projectName);
        if (cur) {
          const snapshot = _projectSseSnapshots.get(projectName) || {};
          const prev = snapshot[cur.name];
          if (!prev || prev.status !== cur.status || prev.current_phase !== cur.current_phase) {
            const evt = { type: 'status', project: cur.name, status: cur.status, current_phase: cur.current_phase };
            for (const c of clients) { try { c.write(evt); } catch { clients.delete(c); } }
            snapshot[cur.name] = { status: cur.status, current_phase: cur.current_phase };
            _projectSseSnapshots.set(projectName, snapshot);
          }
        }
        // Phase 59 (live_progress): emit { type:'progress', ...row } only when
        // the row's updated_at advances (the stream parser rewrites it at most
        // every ~3s). When the row disappears (run ended → deleteLiveProgress),
        // emit one { type:'progress', cleared:true } so the client drops the
        // header. Best-effort — a read failure never breaks the tick.
        try {
          const prog = getLiveProgress(projectName);
          const prevTs = _projectSseLastProgress.get(projectName);
          if (prog && prog.updated_at !== prevTs) {
            const evt = { type: 'progress', project: projectName, ...prog };
            for (const c of clients) { try { c.write(evt); } catch { clients.delete(c); } }
            _projectSseLastProgress.set(projectName, prog.updated_at);
          } else if (!prog && prevTs !== undefined) {
            const evt = { type: 'progress', project: projectName, cleared: true };
            for (const c of clients) { try { c.write(evt); } catch { clients.delete(c); } }
            _projectSseLastProgress.delete(projectName);
          }
        } catch { /* live progress is best-effort */ }
      }, 500);
      _projectSseTimers.set(projectName, timer);
    }

    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
    const onUiEvent = (evt) => {
      if (evt.project === projectName) { try { client.write(evt); } catch { _projectSseClients.get(projectName)?.delete(client); } }
    };
    uiEvents.on('status', onUiEvent);
    uiEvents.on('call', onUiEvent);

    res.on('close', () => {
      _projectSseClients.get(projectName)?.delete(client);
      clearInterval(heartbeat);
      uiEvents.off('status', onUiEvent);
      uiEvents.off('call', onUiEvent);
      if ((_projectSseClients.get(projectName)?.size ?? 0) === 0) {
        clearInterval(_projectSseTimers.get(projectName));
        _projectSseTimers.delete(projectName);
        _projectSseLastProgress.delete(projectName); // Phase 59: reset the cursor with the timer
      }
    });
  });

  // ── Bug inbox list ──
  app.get('/api/projects/:name/bugs', (req, res) => {
    try {
      const p = getProject(req.params.name);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      const status = req.query.status || null;
      const bugs = listBugs({ project: req.params.name, status });
      res.json(bugs);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Bug promote ──
  app.post('/api/projects/:name/bugs/:id/promote', async (req, res) => {
    const project = req.params.name;
    if (!getProject(project)) return res.status(404).json({ error: 'Project not found' });
    if (rejectProjectMutation(res, project, 'promote a bug')) return;
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid bug id' });
      const { withBugPromotionLock } = await import('./commands/bugs-inbox.js');
      const result = await withBugPromotionLock(project, async () => {
        if (rejectProjectMutation(res, project, 'promote a bug')) return null;
        const bug = getBug(id);
        if (!bug || bug.project !== project) return { httpStatus: 404, error: 'Bug not found' };
        if (!['inbox', 'refined'].includes(bug.status)) {
          return { httpStatus: 409, error: `Bug already ${bug.status}` };
        }

        const projDir = path.join(PROJECTS_DIR, project);
        const highestDisk = await detectHighestBugRound(projDir);
        let targetRound = highestDisk || 1;
        if (highestDisk) {
          const planned = await fs.access(fixPlanJsonPath(projDir, highestDisk))
            .then(() => true).catch(() => false);
          if (planned) targetRound += 1;
        }

        const roundDir = bugRoundDir(projDir, targetRound);
        const bugsMd = bugsFilePath(projDir, targetRound);
        await fs.mkdir(roundDir, { recursive: true });
        const existing = await fs.readFile(bugsMd, 'utf-8').catch((err) => {
          if (err.code === 'ENOENT') return '';
          throw err;
        });
        const marker = `<!-- bug-inbox-id:${id} -->`;
        if (!existing.includes(marker)) {
          const text = bug.refined_text || bug.raw_text || '';
          const firstLine = text.split('\n')[0].trim();
          const title = (firstLine || `Inbox bug #${id}`).slice(0, 80);
          const severity = bug.severity || 'unassigned';
          const nextN = (existing.match(/^### Bug \d+/gm) || []).length + 1;
          const header = existing ? '' : [
            `# Bug Report — ${project} — Round ${targetRound}`,
            '',
            `> Promoted from bug inbox on ${new Date().toISOString().slice(0, 10)}`,
            '> Review each finding below. Remove false positives. Adjust severity if needed.',
            `> When ready: \`npm run bugs -- ${project}\``,
            '',
          ].join('\n');
          const block = [
            existing || header,
            ...(existing || header ? ['', '---', ''] : []),
            marker,
            `### Bug ${nextN} — ${title}`,
            `Severity: ${severity}`,
            text,
            '',
          ].join('\n');
          const tmp = path.join(roundDir, `.bugs.${process.pid}.${Date.now()}.tmp`);
          try {
            await fs.writeFile(tmp, block, 'utf-8');
            await fs.rename(tmp, bugsMd);
          } finally {
            await fs.unlink(tmp).catch(() => {});
          }
        }

        const changed = getDb().prepare(`
          UPDATE bug_inbox SET status = 'promoted', promoted_to_round = ?, updated_at = ?
          WHERE id = ? AND project = ? AND status IN ('inbox', 'refined')
        `).run(targetRound, new Date().toISOString(), id, project).changes;
        if (!changed && getBug(id)?.status !== 'promoted') {
          throw new Error('Bug state changed while it was being promoted; inspect the bug round before retrying');
        }
        return { ok: true, id, status: 'promoted', promoted_to_round: targetRound };
      });
      if (res.headersSent || !result) return;
      if (result.error) return res.status(result.httpStatus || 409).json({ error: result.error });
      res.json(result);
    } catch (e) {
      const status = /promotion is busy/i.test(e.message) ? 409 : 500;
      res.status(status).json({ error: e.message });
    }
  });

  // ── Bug drop ──
  app.post('/api/projects/:name/bugs/:id/drop', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid bug id' });
      if (!getProject(req.params.name)) return res.status(404).json({ error: 'Project not found' });
      if (rejectProjectMutation(res, req.params.name, 'drop a bug')) return;
      const { withBugPromotionLock } = await import('./commands/bugs-inbox.js');
      const result = await withBugPromotionLock(req.params.name, async () => {
        const bug = getBug(id);
        if (!bug || bug.project !== req.params.name) return { status: 404, error: 'Bug not found' };
        if (!['inbox', 'refined'].includes(bug.status)) return { status: 409, error: `Bug already ${bug.status}` };
        const changes = getDb().prepare(`
          UPDATE bug_inbox SET status = 'dropped', updated_at = ?
          WHERE id = ? AND project = ? AND status IN ('inbox', 'refined')
        `).run(new Date().toISOString(), id, req.params.name).changes;
        return changes ? null : { status: 409, error: 'Bug state changed; reload and retry' };
      });
      if (result) return res.status(result.status).json({ error: result.error });
      res.json({ ok: true, id, status: 'dropped' });
    } catch (e) {
      res.status(/promotion is busy/i.test(e.message) ? 409 : 500).json({ error: e.message });
    }
  });

  // ── Requirements list ──
  app.get('/api/projects/:name/requirements', (req, res) => {
    try {
      const p = getProject(req.params.name);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      const status = req.query.status || null;
      const reqs = listRequirements({ project: req.params.name, status });
      res.json(reqs);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Requirement promote ──
  app.post('/api/projects/:name/requirements/:id/promote', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid requirement id' });
      if (!getProject(req.params.name)) return res.status(404).json({ error: 'Project not found' });
      if (rejectProjectMutation(res, req.params.name, 'promote a requirement')) return;
      const req_ = getRequirement(id);
      if (!req_ || req_.project !== req.params.name) return res.status(404).json({ error: 'Requirement not found' });
      if (req_.status === 'promoted' || req_.status === 'dropped') {
        return res.status(409).json({ error: `Requirement already ${req_.status}` });
      }
      // Actually promote: cmdPromote appends the requirement text to
      // raw-thoughts.md AND marks the row promoted (with a real tag). The
      // previous handler only flipped the status and wrote the text nowhere.
      const { cmdPromote } = await import('./commands/requirements.js');
      const result = await cmdPromote(req.params.name, {
        ids: [id],
        assertCanWrite: () => {
          const blockers = projectMutationBlockers(req.params.name);
          if (!blockers.length) return;
          const err = new Error('Cannot promote a requirement while project work is active or queued');
          err.code = 'PROJECT_MUTATION_BLOCKED';
          err.blockers = blockers;
          throw err;
        },
      });
      res.json({ ok: true, id, status: 'promoted', promotion: result });
    } catch (e) {
      const status = /promotion is busy/i.test(e.message) || e.code === 'PROJECT_MUTATION_BLOCKED' ? 409 : 500;
      res.status(status).json({ error: e.message, code: e.code || null, blockers: e.blockers || undefined });
    }
  });

  // ── Requirement drop ──
  app.post('/api/projects/:name/requirements/:id/drop', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid requirement id' });
      if (!getProject(req.params.name)) return res.status(404).json({ error: 'Project not found' });
      if (rejectProjectMutation(res, req.params.name, 'drop a requirement')) return;
      const destination = path.join(PROJECTS_DIR, req.params.name, '.guide', 'raw-thoughts.md');
      const { withRequirementPromotionLock } = await import('./commands/requirements.js');
      const result = await withRequirementPromotionLock(destination, async () => {
        const req_ = getRequirement(id);
        if (!req_ || req_.project !== req.params.name) return { status: 404, error: 'Requirement not found' };
        if (!['inbox', 'refined'].includes(req_.status)) return { status: 409, error: `Requirement already ${req_.status}` };
        const changes = getDb().prepare(`
          UPDATE requirements SET status = 'dropped', updated_at = ?
          WHERE id = ? AND project = ? AND status IN ('inbox', 'refined')
        `).run(new Date().toISOString(), id, req.params.name).changes;
        return changes ? null : { status: 409, error: 'Requirement state changed; reload and retry' };
      });
      if (result) return res.status(result.status).json({ error: result.error });
      res.json({ ok: true, id, status: 'dropped' });
    } catch (e) {
      res.status(/promotion is busy/i.test(e.message) ? 409 : 500).json({ error: e.message });
    }
  });

  // ── Audit promote (FR15) ──
  app.post('/api/projects/:name/promote-audit', async (req, res) => {
    try {
      const p = getProject(req.params.name);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      if (rejectProjectMutation(res, req.params.name, 'promote audit findings')) return;
      const projDir = path.join(PROJECTS_DIR, req.params.name);
      const rawAuditFile = req.body?.auditFile;
      if (typeof rawAuditFile !== 'string' || !rawAuditFile.trim()) {
        return res.status(409).json({
          error: 'auditFile is required so promotion cannot target a different, newer audit',
        });
      }
      const auditsDir = path.resolve(projDir, '.guide', 'audits');
      const normalized = rawAuditFile.trim().replace(/^\.guide\//, '').replace(/^audits\//, '');
      if (path.basename(normalized) !== normalized || !/^audit-[a-zA-Z0-9_.-]+\.md$/.test(normalized)) {
        return res.status(400).json({ error: 'auditFile must name one audit-*.md artifact' });
      }
      const auditFile = path.resolve(auditsDir, normalized);
      if (!auditFile.startsWith(`${auditsDir}${path.sep}`)) {
        return res.status(400).json({ error: 'auditFile escapes the audits directory' });
      }
      let realAudit, realAuditsDir;
      try {
        [realAudit, realAuditsDir] = await Promise.all([fs.realpath(auditFile), fs.realpath(auditsDir)]);
      } catch (e) {
        if (e.code === 'ENOENT') return res.status(404).json({ error: 'Audit artifact not found' });
        throw e;
      }
      if (!realAudit.startsWith(`${realAuditsDir}${path.sep}`)) {
        return res.status(400).json({ error: 'auditFile resolves outside the audits directory' });
      }
      const { withBugPromotionLock } = await import('./commands/bugs-inbox.js');
      const result = await withBugPromotionLock(req.params.name, () => {
        const blockers = projectMutationBlockers(req.params.name);
        if (blockers.length) {
          const err = new Error('Cannot promote audit findings while project work is active or queued');
          err.code = 'PROJECT_MUTATION_BLOCKED';
          err.blockers = blockers;
          throw err;
        }
        return promoteAuditToBugs({ projDir, projectName: req.params.name, auditFile: realAudit });
      });
      if (!result.promoted) {
        return res.status(409).json({ error: result.reason || 'Promote failed', details: result });
      }
      res.json({
        ok: true,
        round: result.round,
        bugsPath: result.bugsPath,
        auditFile: result.auditFile,
        appended: result.appended || false,
        warning: result.warning || null,
      });
    } catch (e) {
      const status = e.code === 'PROJECT_MUTATION_BLOCKED' || /promotion is busy/i.test(e.message) ? 409 : 500;
      res.status(status).json({ error: e.message, code: e.code || null, blockers: e.blockers || undefined });
    }
  });

  // ── Config PATCH (FR16) ──
  app.patch('/api/projects/:name/config', async (req, res) => {
    const project = req.params.name;
    const mutationKey = `config:${project}`;
    let tmpPath = null;
    try {
      const p = getProject(project);
      if (!p) return res.status(404).json({ error: 'Project not found' });

      const body = req.body || {};
      if (!Object.prototype.hasOwnProperty.call(body, 'expectedVersion')) {
        return res.status(428).json({
          error: 'expectedVersion is required; reload the project before saving config',
          code: 'CONFIG_VERSION_REQUIRED',
        });
      }
      if (typeof body.expectedVersion !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedVersion)) {
        return res.status(400).json({ error: 'expectedVersion must be a SHA-256 version returned by the project API' });
      }
      if (configMutations.has(mutationKey)) {
        return res.status(409).json({
          error: 'A config write is already in progress for this project',
          code: 'CONFIG_WRITE_IN_PROGRESS',
        });
      }
      configMutations.add(mutationKey);

      // Config changes alter the inputs used by every queued action. Fail
      // closed while any pending/running job or live runner owns the project;
      // otherwise a job could execute against a half-observed configuration.
      const blockers = projectMutationBlockers(project);
      const blockedJobIds = new Set(blockers.filter((b) => b.id != null).map((b) => Number(b.id)));
      for (const job of getPendingJobsForProject(project)) {
        if (!blockedJobIds.has(Number(job.id))) {
          blockers.push({ type: 'queued_job', id: job.id, action: job.action });
        }
      }
      if (blockers.length) {
        return res.status(409).json({
          error: 'Project config cannot change while project work is active or queued',
          code: 'PROJECT_BUSY',
          blockers,
        });
      }

      const projectPath = path.join(PROJECTS_DIR, project, 'project.json');

      let projectJson, originalRaw;
      try {
        originalRaw = await fs.readFile(projectPath);
        projectJson = JSON.parse(originalRaw.toString('utf-8'));
      } catch (e) {
        return res.status(500).json({ error: 'Cannot read project.json: ' + e.message });
      }
      const currentVersion = crypto.createHash('sha256').update(originalRaw).digest('hex');
      if (body.expectedVersion !== currentVersion) {
        return res.status(409).json({
          error: 'project.json changed after this editor loaded; reload before saving',
          code: 'CONFIG_VERSION_CONFLICT',
          expectedVersion: body.expectedVersion,
          currentVersion,
        });
      }

      const editable = {
        pause_at_calls: ['billing', 'pause_at_calls', 1, null],
        max_phases_per_run: ['auto_run', 'max_phases_per_run', 1, null],
        review_every_n_phases: ['phases', 'review_every_n_phases', 1, null],
        review_score_threshold: ['auto_run', 'review_auto_proceed_score_threshold', 0, 100],
      };
      const boolKeys = [
        'auto_pause_after_phase_1', 'auto_pause_after_review',
        'chain_audit_to_bugs', 'auto_promote_audit_bugs',
      ];
      const input = body.reset === true
        ? {
            ...body,
            ...Object.fromEntries(Object.keys(editable).map((key) => [key, null])),
            ...Object.fromEntries(boolKeys.map((key) => [key, null])),
            git_branch: null,
            git_remote: null,
          }
        : body;
      const ensureGroup = (group) => {
        projectJson.overrides = projectJson.overrides || {};
        projectJson.overrides[group] = projectJson.overrides[group] || {};
        return projectJson.overrides[group];
      };
      for (const [field, [group, key, min, max]] of Object.entries(editable)) {
        if (input[field] === undefined) continue;
        if (input[field] === null) {
          if (projectJson.overrides?.[group]) delete projectJson.overrides[group][key];
          continue;
        }
        const v = Number(input[field]);
        if (!Number.isInteger(v) || v < min || (max != null && v > max)) {
          const range = max == null ? `at least ${min}` : `${min}–${max}`;
          return res.status(400).json({ error: `${field} must be an integer (${range})` });
        }
        ensureGroup(group)[key] = v;
      }
      for (const key of boolKeys) {
        if (input[key] === undefined) continue;
        if (input[key] === null) {
          if (projectJson.overrides?.auto_run) delete projectJson.overrides.auto_run[key];
        } else if (typeof input[key] !== 'boolean') {
          return res.status(400).json({ error: `${key} must be true, false, or null` });
        } else {
          ensureGroup('auto_run')[key] = input[key];
        }
      }

      const gitChanges = {};
      for (const key of ['git_branch', 'git_remote']) {
        if (input[key] === undefined) continue;
        if (input[key] !== null && typeof input[key] !== 'string') {
          return res.status(400).json({ error: `${key} must be a string or null` });
        }
        const value = input[key] === null ? null : input[key].trim() || null;
        gitChanges[key] = value;
        if (value === null) delete projectJson[key];
        else projectJson[key] = value;
      }

      for (const group of ['billing', 'auto_run', 'phases']) {
        if (projectJson.overrides?.[group] && Object.keys(projectJson.overrides[group]).length === 0) {
          delete projectJson.overrides[group];
        }
      }
      if (projectJson.overrides && Object.keys(projectJson.overrides).length === 0) delete projectJson.overrides;

      const nextRaw = Buffer.from(JSON.stringify(projectJson, null, 2), 'utf-8');
      const nextVersion = crypto.createHash('sha256').update(nextRaw).digest('hex');
      tmpPath = `${projectPath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      await fs.writeFile(tmpPath, nextRaw);

      // Re-read immediately before the atomic rename. This catches an
      // external editor that changed project.json while this request was
      // validating its payload, in addition to serializing web requests.
      const preCommitRaw = await fs.readFile(projectPath);
      const preCommitVersion = crypto.createHash('sha256').update(preCommitRaw).digest('hex');
      if (preCommitVersion !== currentVersion) {
        return res.status(409).json({
          error: 'project.json changed while this save was being prepared; reload before saving',
          code: 'CONFIG_VERSION_CONFLICT',
          expectedVersion: body.expectedVersion,
          currentVersion: preCommitVersion,
        });
      }

      await fs.rename(tmpPath, projectPath);
      tmpPath = null;
      try {
        if (Object.keys(gitChanges).length) setProjectGitConfig(project, gitChanges);
        const effectiveConfig = await resolveConfig({ project, task: 'dev-execution' });
        return res.json({ ok: true, config: projectJson, effectiveConfig, configVersion: nextVersion });
      } catch (commitError) {
        // Keep the JSON file and denormalized git columns consistent. Restore
        // with another atomic rename, and report if either rollback surface
        // itself fails rather than silently leaving a partial commit behind.
        const rollbackErrors = [];
        const rollbackPath = `${projectPath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.rollback`;
        try {
          await fs.writeFile(rollbackPath, originalRaw);
          await fs.rename(rollbackPath, projectPath);
        } catch (rollbackError) {
          rollbackErrors.push(`file rollback failed: ${rollbackError.message}`);
          await fs.rm(rollbackPath, { force: true }).catch(() => {});
        }
        try {
          if (Object.keys(gitChanges).length) {
            setProjectGitConfig(project, {
              git_branch: p.git_branch ?? null,
              git_remote: p.git_remote ?? null,
            });
          }
        } catch (rollbackError) {
          rollbackErrors.push(`database rollback failed: ${rollbackError.message}`);
        }
        throw new Error(`${commitError.message}${rollbackErrors.length ? `; ${rollbackErrors.join('; ')}` : ''}`);
      }
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: e.message });
    } finally {
      if (tmpPath) await fs.rm(tmpPath, { force: true }).catch(() => {});
      configMutations.delete(mutationKey);
    }
  });

  // ── Phase report viewer ──
  app.get('/api/projects/:name/phases/:n/report', async (req, res) => {
    try {
      const p = getProject(req.params.name);
      if (!p) return res.status(404).json({ error: 'Project not found' });
      const n = parseInt(req.params.n, 10);
      if (isNaN(n)) return res.status(400).json({ error: 'Invalid phase number' });
      const projectDir = path.join(PROJECTS_DIR, req.params.name);
      const phasesDir = path.join(projectDir, '.guide', 'phases');
      const pad = String(n).padStart(2, '0');
      let phaseFolder = null;
      try {
        const entries = await fs.readdir(phasesDir);
        const match = entries.find(e => e.startsWith(pad + '-'));
        if (match) phaseFolder = path.join(phasesDir, match);
      } catch { /* no phases dir yet */ }
      if (!phaseFolder) return res.status(404).json({ error: 'Phase directory not found' });
      const reportFile = path.join(phaseFolder, 'report.md');
      const content = await fs.readFile(reportFile, 'utf-8').catch(() => null);
      if (content === null) return res.status(404).json({ error: 'Report not written yet for this phase' });
      res.json({ content, folder: path.basename(phaseFolder) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Suggestions ──

  /**
   * Shared scan helper used by /scan and /scan-ai.
   * Order: staleDraftSuggestions → scan → getEarlierTitles → generate → save.
   * Draft rows are staled before each new insert; accepted rows are staled only
   * inside the acceptSuggestions transaction.
   */
  async function _runScan(project, projDir, {
    ai           = false,
    userGoal     = '',
    areas        = [],
    typeOverride = null,
    cfg          = null,
  } = {}) {
    if (fileMutations.has(`${project}:suggestions`)) {
      const err = new Error('Suggestions are already being accepted for this project');
      err.code = 'SUGGESTIONS_BUSY';
      throw err;
    }
    const startedBlockers = projectMutationBlockers(project);
    if (startedBlockers.length) {
      const err = new Error(`Cannot scan suggestions while project work is active or queued`);
      err.code = 'PROJECT_MUTATION_BLOCKED';
      err.blockers = startedBlockers;
      throw err;
    }
    const snapshot = await scanProject(projDir);
    const VALID_TYPES = ['cli', 'frontend', 'api', 'fullstack'];
    if (typeOverride && VALID_TYPES.includes(typeOverride) && snapshot.projectType === 'unknown') {
      snapshot.projectType = typeOverride;
    }

    let suggestions;
    let aiUsed = false;
    if (ai && cfg) {
      try {
        const previousTitles = getEarlierSuggestionTitles(project);
        // AI path: areas are a SOFT prompt hint, not a hard filter.
        // Claude may return items outside the selected focus areas; the client selection UI is the gate.
        suggestions = await generateAISuggestions(snapshot, userGoal, areas, cfg, previousTitles, {}, project, projDir);
        aiUsed = true;
      } catch (err) {
        console.error(`[suggest-scan] AI failed for "${project}": ${err.message}`);
        // Rules fallback: areas ARE a hard filter — filterSuggestions drops out-of-area items.
        const raw = generateSuggestions(snapshot);
        suggestions = areas.length > 0 ? filterSuggestions(raw, areas) : raw;
      }
    } else {
      // Rules-only path: areas ARE a hard filter.
      const raw = generateSuggestions(snapshot);
      suggestions = areas.length > 0 ? filterSuggestions(raw, areas) : raw;
    }

    const commitBlockers = projectMutationBlockers(project);
    if (commitBlockers.length) {
      const err = new Error('Project work started while suggestions were being scanned; the snapshot was not saved');
      err.code = 'PROJECT_MUTATION_BLOCKED';
      err.blockers = commitBlockers;
      throw err;
    }
    staleDraftSuggestions(project);
    const newId = saveSuggestions(project, {
      projectType:  snapshot.projectType,
      scanSnapshot: snapshot,
      suggestions,
    });
    return { row: getSuggestionsById(newId), aiUsed };
  }

  app.get('/api/projects/:name/suggestions', async (req, res) => {
    try {
      const p = getProject(req.params.name);
      if (!p) return res.status(404).json({ error: `Project "${req.params.name}" not found` });
      const row = getFreshestSuggestions(req.params.name);
      return res.json(row ?? null);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/projects/:name/suggestions/scan', async (req, res) => {
    const project = req.params.name;
    const p = getProject(project);
    if (!p) return res.status(404).json({ error: `Project "${project}" not found` });
    if (rejectProjectMutation(res, project, 'scan suggestions')) return;
    if (scanInProgress.has(project)) {
      return res.status(409).json({ error: `suggestions/scan already in progress for "${project}"` });
    }
    scanInProgress.add(project);
    const projDir = path.join(PROJECTS_DIR, project);
    try {
      const { row } = await _runScan(project, projDir, {
        ai: false,
        typeOverride: req.body?.typeOverride ?? null,
      });
      return res.json(row);
    } catch (err) {
      const status = ['PROJECT_MUTATION_BLOCKED', 'SUGGESTIONS_BUSY'].includes(err.code) ? 409 : 500;
      return res.status(status).json({ error: `suggestions/scan failed for "${project}": ${err.message}`, code: err.code || null, blockers: err.blockers || undefined });
    } finally {
      scanInProgress.delete(project);
    }
  });

  // AI-powered scan: accepts { goal, areas, typeOverride, noLm } from the client.
  // noLm: true forces the deterministic rules engine (skips Claude).
  // Falls back to the hardcoded engine if Claude is unavailable.
  app.post('/api/projects/:name/suggestions/scan-ai', async (req, res) => {
    const project  = req.params.name;
    const p        = getProject(project);
    if (!p) return res.status(404).json({ error: `Project "${project}" not found` });
    if (rejectProjectMutation(res, project, 'scan suggestions')) return;
    if (scanInProgress.has(project)) {
      return res.status(409).json({ error: `suggestions/scan-ai already in progress for "${project}"` });
    }
    scanInProgress.add(project);
    const projDir  = path.join(PROJECTS_DIR, project);
    const userGoal = String(req.body?.goal   || '').slice(0, 500);
    const areas    = Array.isArray(req.body?.areas) ? req.body.areas : [];
    const noLm     = req.body?.noLm === true;
    try {
      const cfg = noLm ? null : await resolveConfig({ project, task: 'suggest-scan' });
      const { row, aiUsed } = await _runScan(project, projDir, {
        ai: !noLm,
        userGoal,
        areas,
        typeOverride: req.body?.typeOverride ?? null,
        cfg,
      });
      return res.json({ ...row, aiUsed });
    } catch (err) {
      const status = ['PROJECT_MUTATION_BLOCKED', 'SUGGESTIONS_BUSY'].includes(err.code) ? 409 : 500;
      return res.status(status).json({ error: `suggestions/scan-ai failed for "${project}": ${err.message}`, code: err.code || null, blockers: err.blockers || undefined });
    } finally {
      scanInProgress.delete(project);
    }
  });

  app.post('/api/projects/:name/suggestions/accept', async (req, res) => {
    const project = req.params.name;
    const p = getProject(project);
    if (!p) return res.status(404).json({ error: `Project "${project}" not found` });
    if (rejectProjectMutation(res, project, 'accept suggestions')) return;
    if (scanInProgress.has(project)) return res.status(409).json({ error: 'Suggestions are currently being scanned for this project' });
    const mutationKey = `${project}:suggestions`;
    if (fileMutations.has(mutationKey)) {
      return res.status(409).json({ error: 'Suggestions are already being changed for this project' });
    }

    const { id, selected, pipelinePasses } = req.body;
    // pipelinePlan is not accepted from the client and is not sent — it is recomputed server-side.
    if (!id || !Array.isArray(selected) || !pipelinePasses) {
      return res.status(400).json({
        error: 'Missing or invalid fields: id, selected, pipelinePasses',
      });
    }
    if (selected.length === 0) {
      return res.status(400).json({
        error: 'suggestions/accept: selected items cannot be empty',
        project,
        op: 'accept',
      });
    }

    const rowProject = getSuggestionsProject(id);
    if (!rowProject || rowProject !== project) {
      return res.status(404).json({
        error: `suggestions row ${id} not found for project "${project}"`,
        project,
        op: 'accept',
      });
    }

    // Fetch stored suggestions to validate incoming ids.
    const row = getSuggestionsById(id);
    const storedSuggestions = JSON.parse(row.suggestions_json || '[]');
    const storedById = new Map(storedSuggestions.map(s => [s.id, s]));

    // Intersect: keep only ids that exist in the stored suggestion set.
    // Use the stored objects (not client objects) to prevent field mutation.
    const reconciledSelected = selected
      .map(s => storedById.get(s.id))
      .filter(Boolean);

    if (reconciledSelected.length === 0) {
      return res.status(400).json({
        error: 'suggestions/accept: no valid selections after reconciling with stored suggestions',
        project,
        op: 'accept',
      });
    }

    // Recompute plan server-side — the client-sent pipelinePlan is not used.
    const passes = parseInt(pipelinePasses, 10);
    if (!Number.isInteger(passes) || passes < 1 || passes > 5) {
      return res.status(400).json({
        error: 'pipelinePasses must be an integer between 1 and 5',
        project,
        op: 'accept',
      });
    }
    const pipelinePlan = assignToPasses(reconciledSelected, passes);

    const projDir = path.join(PROJECTS_DIR, project);
    const suggestionsFile = path.join(projDir, '.guide', 'suggestions.md');
    fileMutations.add(mutationKey);
    try {
      const blockers = projectMutationBlockers(project);
      if (blockers.length) {
        return res.status(409).json({ error: 'Project work started before suggestions could be accepted', code: 'PROJECT_MUTATION_BLOCKED', blockers });
      }
      const previous = await fs.readFile(suggestionsFile).catch((err) => {
        if (err.code === 'ENOENT') return null;
        throw err;
      });
      await writeSuggestionsFile(projDir, project, reconciledSelected, pipelinePlan, passes);
      try {
        acceptSuggestions(id, {
          selected:       reconciledSelected,
          pipelinePlan,
          pipelinePasses: passes,
        });
      } catch (dbError) {
        try {
          if (previous === null) await fs.unlink(suggestionsFile).catch((err) => { if (err.code !== 'ENOENT') throw err; });
          else {
            const restore = path.join(path.dirname(suggestionsFile), `.suggestions.restore.${process.pid}.${Date.now()}.tmp`);
            await fs.writeFile(restore, previous);
            await fs.rename(restore, suggestionsFile);
          }
        } catch (restoreError) {
          dbError.message += `; suggestions file rollback also failed: ${restoreError.message}`;
        }
        throw dbError;
      }
      return res.json(getLatestSuggestions(project));
    } catch (err) {
      return res.status(500).json({
        error: `suggestions/accept failed for "${project}": ${err.message}`,
      });
    } finally {
      fileMutations.delete(mutationKey);
    }
  });

  // Re-plan: stales the accepted row (not just drafts) then re-scans.
  // Used by the Web UI "Re-plan" button when an accepted plan exists.
  app.post('/api/projects/:name/suggestions/rerun', async (req, res) => {
    const project  = req.params.name;
    const p        = getProject(project);
    if (!p) return res.status(404).json({ error: `Project "${project}" not found` });
    if (rejectProjectMutation(res, project, 're-plan suggestions')) return;
    if (scanInProgress.has(project)) {
      return res.status(409).json({ error: `suggestions/rerun already in progress for "${project}"` });
    }
    scanInProgress.add(project);
    const projDir  = path.join(PROJECTS_DIR, project);
    const userGoal = String(req.body?.goal   || '').slice(0, 500);
    const areas    = Array.isArray(req.body?.areas) ? req.body.areas : [];
    const noLm     = req.body?.noLm === true;
    try {
      const cfg = noLm ? null : await resolveConfig({ project, task: 'suggest-scan' });
      const { row, aiUsed } = await _runScan(project, projDir, {
        ai: !noLm,
        userGoal,
        areas,
        typeOverride: req.body?.typeOverride ?? null,
        cfg,
      });
      // Preserve the last accepted plan until a replacement scan has fully
      // succeeded. Only then retire accepted rows; _runScan already retired
      // older drafts while keeping this new draft alive.
      getDb().prepare(`UPDATE suggestions SET status = 'stale' WHERE project = ? AND status = 'accepted'`)
        .run(project);
      return res.json({ ...row, aiUsed });
    } catch (err) {
      const status = ['PROJECT_MUTATION_BLOCKED', 'SUGGESTIONS_BUSY'].includes(err.code) ? 409 : 500;
      return res.status(status).json({ error: `suggestions/rerun failed for "${project}": ${err.message}`, code: err.code || null, blockers: err.blockers || undefined });
    } finally {
      scanInProgress.delete(project);
    }
  });

  // ── Terminal exec — run a shell command in the orchestrator root or a project workspace ──
  // POST /api/terminal/exec  { cwd: '__root__' | projectName, command, timeout_ms? }
  // Returns { ok, stdout, stderr, exit_code, cwd_label }
  // Blocked: same destructive pattern list as toolWorkspaceShell in control-actions.js.
  app.post('/api/terminal/exec', async (req, res) => {
    try {
      if (!terminalEnabled) {
        return res.status(403).json({
          error: 'Terminal execution is disabled on this network binding',
          hint: 'Use a loopback-bound UI or explicitly set AORCH_ENABLE_REMOTE_TERMINAL=1',
        });
      }
      const { cwd: cwdArg = '__root__', command, timeout_ms } = req.body || {};
      if (typeof command !== 'string' || !command.trim()) {
        return res.status(400).json({ error: '"command" is required' });
      }
      // This endpoint runs arbitrary shell commands by design; the real security
      // boundary is the Bearer-token auth on /api (see startWebUi + the /api guard).
      // This denylist is only a footgun-guard against catastrophic *system*
      // destruction — it deliberately allows workspace cleanup like
      // `rm -rf node_modules`. The old single `rm -rf /` regex was trivially
      // bypassed (rm -fr /, rm --recursive --force /, rm -rf /home, ~/*, …).
      if (isCatastrophicCommand(command)) {
        return res.status(400).json({ error: 'Command rejected: matches destructive pattern' });
      }
      let workDir, cwdLabel;
      if (cwdArg === '__root__') {
        workDir  = REPO_ROOT;
        cwdLabel = 'orchestrator (root)';
      } else {
        const p = getProject(cwdArg);
        if (!p) return res.status(404).json({ error: `Project not found: ${cwdArg}` });
        workDir  = path.join(PROJECTS_DIR, cwdArg, 'workspace');
        cwdLabel = `projects/${cwdArg}/workspace`;
        try { await fs.access(workDir); } catch {
          return res.status(409).json({ error: `Workspace not found: ${cwdLabel}` });
        }
      }
      const ms = Math.min(Math.max(Number(timeout_ms) || 60000, 5000), 300000);
      try {
        const { stdout, stderr } = await execForHttpRequest(
          command,
          { cwd: workDir, timeout: ms, maxBuffer: 10 * 1024 * 1024 },
          req,
          res,
        );
        console.log(chalk.bold.cyan('[terminal]') + chalk.dim(
          ` actor=${req.ip || 'unknown'} cwd=${cwdLabel} command_length=${command.length} outcome=completed`,
        ));
        return res.json({ ok: true, exit_code: 0, stdout: stdout.slice(0, 50000), stderr: stderr.slice(0, 5000), cwd_label: cwdLabel });
      } catch (err) {
        if (err.code === 'REQUEST_ABORTED') {
          if (!res.headersSent && !res.writableEnded) res.status(499).json({ error: 'Terminal command cancelled' });
          return;
        }
        console.log(chalk.bold.cyan('[terminal]') + chalk.dim(
          ` actor=${req.ip || 'unknown'} cwd=${cwdLabel} command_length=${command.length}`,
        ) + chalk.red(` outcome=failed code=${err.code ?? 'unknown'}`));
        return res.json({
          ok: false,
          exit_code: typeof err.code === 'number' ? err.code : 1,
          stdout: String(err.stdout || '').slice(0, 50000),
          stderr: String(err.stderr || err.message || '').slice(0, 5000),
          cwd_label: cwdLabel,
        });
      }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return app;
}

export async function startWebUi({ port = 4242, host = '127.0.0.1', dev = false } = {}) {
  // Record PID + HEAD sha so self-updater can detect stale deployments and restart.
  try {
    const { writeDeploymentState } = await import('./lib/self-updater.js');
    await writeDeploymentState();
  } catch (e) {
    console.error('[web-ui] deployment-state write failed (non-fatal):', e.message);
  }

  const { token, generated } = await ensureAuthToken();
  if (!LOOPBACK_HOSTS.has(host) && !token) {
    throw new Error(
      `[web-ui] Refusing to bind to non-loopback host "${host}" without an auth token. ` +
      `Set config/web-auth-token.txt first.`
    );
  }
  if (generated) {
    console.log('[web-ui] Auth token: ' + token);
  } else {
    console.log('[web-ui] Auth enabled (token in config/web-auth-token.txt)');
  }
  const swept = sweepInterruptedAutoRuns();
  for (const row of swept) {
    console.log(chalk.dim(`[web-ui] auto_run ${row.id} (${row.project}) marked interrupted — orchestrator crashed or was killed mid-run`));
  }
  // Chat locks left by a holder this restart just killed (or a prior crash):
  // without this, a stale row survives until the SAME thread's next acquire,
  // and after enough days pid reuse can brick the thread outright.
  try {
    const staleLocks = sweepStaleChatLocks();
    if (staleLocks) console.log(chalk.dim(`[web-ui] removed ${staleLocks} stale chat lock(s)`));
  } catch (e) {
    console.error('[web-ui] chat-lock sweep failed (non-fatal):', e.message);
  }
  // Zombie 'running' queue jobs + dead-pid live_progress ghosts. The worker
  // and the chat servers already reconcile these at their own boot, but a
  // web-ui-only host (this Mac) never did: two jobs stranded 'running' since
  // Jul 12 blocked the rs/aorch queues, greyed the lifecycle buttons, and
  // pinned /api/system/health leaseHealthy=false permanently.
  try {
    const { reconcileStaleRunningJobs } = await import('./server/job-queue.js');
    const r = reconcileStaleRunningJobs({ reason: 'web-ui boot reconcile' });
    const n = (r?.recovered?.length || 0) + (r?.failed?.length || 0) + (r?.deduplicated?.length || 0);
    if (n) console.log(chalk.dim(`[web-ui] reconciled ${n} stale running job(s) (recovered ${r.recovered.length}, failed ${r.failed.length}, deduped ${r.deduplicated.length})`));
  } catch (e) {
    console.error('[web-ui] job reconcile failed (non-fatal):', e.message);
  }
  try {
    const ghosts = sweepStaleLiveProgress();
    if (ghosts) console.log(chalk.dim(`[web-ui] removed ${ghosts} stale live-progress row(s)`));
  } catch (e) {
    console.error('[web-ui] live-progress sweep failed (non-fatal):', e.message);
  }
  // Outbox hygiene on a host with no delivery transport: expire stale pending
  // pings (>24h) so a future server-discord start can't flood-deliver them,
  // and prune terminal rows past retention.
  try {
    const { expireStaleOutbox, pruneOldNotifyOutbox } = await import('./state.js');
    const expired = expireStaleOutbox(24);
    const pruned = pruneOldNotifyOutbox(30);
    if (expired || pruned) console.log(chalk.dim(`[web-ui] outbox: expired ${expired} stale pending, pruned ${pruned} old row(s)`));
  } catch (e) {
    console.error('[web-ui] outbox sweep failed (non-fatal):', e.message);
  }
  // Per-thread chat MCP config files accumulate one 283-byte file per thread
  // forever; drop the ones whose thread no longer exists (chat-engine rewrites
  // a live thread's file on its next turn anyway).
  try {
    const { listChatThreads } = await import('./state.js');
    const live = new Set(listChatThreads().map((t) => String(t.id)));
    const stateDir = path.join(REPO_ROOT, 'state');
    const files = (await fs.readdir(stateDir)).filter((f) => /^chat-mcp-config-(\d+)\.json$/.test(f));
    let removed = 0;
    for (const f of files) {
      const id = f.match(/^chat-mcp-config-(\d+)\.json$/)[1];
      if (!live.has(id)) {
        await fs.unlink(path.join(stateDir, f)).catch(() => {});
        removed += 1;
      }
    }
    if (removed) console.log(chalk.dim(`[web-ui] removed ${removed} orphaned chat MCP config file(s)`));
  } catch (e) {
    console.error('[web-ui] chat-mcp-config sweep failed (non-fatal):', e.message);
  }

  // Chat autopilot — the always-on drive-to-done loop. Started here (not in the
  // SSE tick, which only runs while a dashboard is open) so autopilot threads
  // are driven 24/7 with no browser attached. No-ops each tick unless
  // cfg.chat.autopilot.enabled is true, so this is safe to start unconditionally.
  try {
    const { startAutopilot } = await import('./chat/chat-autopilot.js');
    startAutopilot();
  } catch (e) {
    console.error('[web-ui] autopilot start failed (non-fatal):', e.message);
  }

  // Project watchdog — auto-resume projects paused by rate-limit / transient errors.
  // Polls every 60 s; waits for the exact resetsAt timestamp before resuming.
  try {
    const wdCfg = await resolveConfig({});
    const watchdogIntervalMs = wdCfg?.auto_heal?.watchdog_interval_ms ?? 60_000;
    if (wdCfg?.auto_heal?.enabled !== false && wdCfg?.auto_heal?.watchdog_enabled !== false) {
      startWatchdog({ intervalMs: watchdogIntervalMs, cfg: wdCfg, notifier: null });
    }
  } catch (e) {
    console.error('[web-ui] watchdog start failed (non-fatal):', e.message);
  }

  const remoteTerminalOptIn = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.AORCH_ENABLE_REMOTE_TERMINAL || '').trim().toLowerCase(),
  );
  const terminalEnabled = LOOPBACK_HOSTS.has(host) || remoteTerminalOptIn;
  if (!terminalEnabled) {
    console.log('[web-ui] Remote terminal disabled (set AORCH_ENABLE_REMOTE_TERMINAL=1 to opt in)');
  }
  const app = createWebUiApp({ authToken: token, terminalEnabled });
  if (dev) startDevWatcher();
  return new Promise((resolve) => {
    const server = app.listen(port, host, () => {
      resolve({ server, port });
    });
  });
}
