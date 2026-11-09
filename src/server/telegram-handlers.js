// Telegram handlers — all bot commands and callback queries.
//
// Auth model:
//   - Anyone can /start (sees instructions only)
//   - /auth <CODE> consumes a code printed by the local terminal
//   - All other commands require allowlist membership
//
// UX principles:
//   - Inline keyboards over free-text args wherever possible
//   - Destructive operations get confirmation buttons
//   - Errors are surfaced clearly, never silent

import { InlineKeyboard } from 'grammy';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isAllowlisted, addUser, consumeAuthCode, listUsers, removeUser,
  enqueueJob, enqueueRoadmapJob, listPendingJobs, getRunningJobsForProject, getCurrentRunningJob, dequeuePendingJob,
  requestJobCancellation, listRecentJobs,
  getPinnedProject, pinProject, unpinProject,
} from './job-queue.js';
import {
  listProjects, getProject, getPhases,
  addRequirement, getRequirement, listRequirements, updateRequirement,
  countRequirements, listProjectsWithRequirements,
  setCaptureMode, clearCaptureMode, getCaptureMode,
  listDiscussions, getDiscussion, getDiscAgents, getDiscMessages, getDiscConclusion,
} from '../state.js';
import { renderStatus } from '../billing-guard.js';
import { resolve as resolveConfig } from '../config-resolver.js';
import { escapeHtml, sanitizeForTelegram } from '../lib/telegram-fmt.js';
import { parseFlagValue, classifyGuideTask, QUEUE_SAFE_GUIDE_TASKS } from '../lib/guide-tasks.js';
import { scanProject } from '../lib/project-scanner.js';
import { QUESTIONS } from '../lib/suggest-prompts.js';
import {
  getOperatorQuestionById, resolveAnswerFromToken, resolveOperatorQuestion,
  renderOperatorQuestionResolvedText,
} from '../lib/operator-questions.js';

// v0.14.17: synced with src/server/job-runner.js executeJob dispatcher and
// with docs/TELEGRAM_BOT.md "Actions for /run" line. Adding an action means
// updating all THREE in lockstep — scripts/verify-v0_14_17.mjs enforces this.
const VALID_ACTIONS = [
  'go', 'resume', 'audit', 'bugs', 'roadmap', 'ship', 'pipeline',
  'brief', 'guide', 'next', 'review', 'handoff', 'qa',
  'reset-brief', 'discuss',
];

const TG_HANDLER_DIRNAME = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TG_HANDLER_DIRNAME, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

/**
 * @typedef {Object} SuggestSession
 * @property {string}      projectName
 * @property {string}      projDir
 * @property {object}      snapshot        - ScanSnapshot from scanProject
 * @property {string}      goal            - freetext goal from upfront question (may be '')
 * @property {object[]}    allSuggestions  - full Suggestion[] before filtering
 * @property {object[]}    filtered        - ≤10 Suggestions after AI scan + focus+category filter
 * @property {object[]}    manualItems     - custom items pending merge into filtered
 * @property {string|null} awaitingInput   - 'goal'|'manual'|null — next text message is captured
 * @property {number|undefined} userId     - Telegram userId of the operator who started the session
 * @property {string}      focus           - 'features'|'enhance'|'both'
 * @property {string[]}    categories      - selected category values
 * @property {Set<number>} selectedIdxs   - indices into filtered[]
 * @property {number}      passes          - 1|2|3
 * @property {object}      pipelinePlan    - {"1":[ids],"2":[ids],...} populated at step 5
 * @property {number}      step            - 0|1|2|3|4|5
 * @property {boolean|undefined} scanning  - true while an AI scan is in-flight (concurrency guard)
 */

/** @type {Map<number, SuggestSession>} */
export const suggestSessions = new Map();

/** @type {Map<number, { projectName: string }>} */
export const nbSessions = new Map();

/**
 * Single-source-of-truth enqueue helper (v0.14.8 / BUG-7). Wraps enqueueJob +
 * formatEnqueueReply so every Telegram-side enqueue surface tells the user the
 * SAME thing about per-project FIFO position. Use this for every enqueueJob
 * call site that has a ctx in scope.
 *
 * Why this exists: v0.14.2 added formatEnqueueReply but only wired it into 3
 * of the 7 enqueue paths. The 4 bug-promote paths still printed raw
 * "✓ Queued job #N" messages, so users promoting a critical bug while another
 * job ran on the same project saw "progress notifications incoming" framing
 * and then waited silently for 30+ minutes while the bug job sat queued
 * behind the running auto-run.
 *
 * @param {grammy.Context} ctx
 * @param {{project, action, args?, requestedBy, prelude?, mode?}} opts
 *   - prelude: optional text prepended above the formatEnqueueReply output
 *   - mode: 'reply' (default) | 'editMessageText' — pick based on call origin
 *     (callbacks that started from an inline-button tap on an existing
 *     message usually want editMessageText, fresh commands want reply).
 */
async function enqueueAndReply(ctx, { project, action, args = {}, requestedBy, prelude = null, mode = 'reply' }) {
  const id = enqueueJob({ project, action, args, requestedBy });
  const fifoText = await formatEnqueueReply({ action, project, id });
  const body = prelude ? `${prelude}\n\n${fifoText}` : fifoText;
  if (mode === 'editMessageText') {
    return ctx.editMessageText(body, { parse_mode: 'HTML' });
  }
  return ctx.reply(body, { parse_mode: 'HTML' });
}

// Returns true (and replies the warning) when generating a new roadmap would stack
// on an existing unreviewed one OR a roadmap job is already pending/running.
// Callers must return immediately when this returns true.
// Only meaningful for verb/action === 'roadmap'.
async function isRoadmapStackBlocked(ctx, project) {
  const projDir = path.join(PROJECTS_DIR, project);
  const { hasUnreviewedFreshRoadmap, roadmapStackBlocked } = await import('../lib/coach.js');

  const pendingJobs = listPendingJobs();
  const runningJobs = getRunningJobsForProject(project);
  const hasActiveRoadmapJob =
    pendingJobs.some((j) => j.project === project && j.action === 'roadmap') ||
    runningJobs.some((j) => j.action === 'roadmap');

  const unreviewedFresh = await hasUnreviewedFreshRoadmap(projDir);

  if (roadmapStackBlocked({ unreviewedFresh, hasActiveRoadmapJob })) {
    if (hasActiveRoadmapJob) {
      await ctx.reply('A roadmap is already queued or running for this project.');
    } else {
      await ctx.reply('Roadmap not yet reviewed — mark it reviewed first.');
    }
    if (ctx.callbackQuery) await ctx.answerCallbackQuery();
    return true;
  }
  return false;
}

// ─── Auth gate ──────────────────────────────────────────────────────────────

export function requireAuth(handler) {
  return async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    if (!isAllowlisted(userId)) {
      return ctx.reply(
        'You are not authorized. Run `npm run bot-auth-code` on the orchestrator host and reply with `/auth <code>`.',
      );
    }
    return handler(ctx);
  };
}

// ─── Public commands ────────────────────────────────────────────────────────

export async function handleStart(ctx) {
  const userId = ctx.from?.id;
  const allowed = userId && isAllowlisted(userId);

  if (allowed) {
    // v0.14.18: live status sentence + 4-button keyboard replaces the
    // wall-of-text command list. The text wall is still reachable via the
    // 📚 Help button (now a buttoned TOC instead of a single block).
    const { listRunningJobs } = await import('./job-queue.js');
    let workerCount = 4;
    try {
      const cfg = await resolveConfig();
      workerCount = cfg?.job_runner?.workers ?? cfg?.job_runner?.max_workers_cap ?? 4;
    } catch { /* config unavailable — use default */ }
    const running = listRunningJobs() || [];
    const active = running.length;
    const pinned = getPinnedProject(userId);

    const summary = active === 0
      ? `Idle (${workerCount} workers ready).`
      : `${active}/${workerCount} workers busy: ` +
        running.map((r) => `<code>${sanitizeForTelegram(r.action)} ${sanitizeForTelegram(r.project)}</code>`).join(', ');

    const pinnedLine = pinned
      ? `\n📌 Pinned: <code>${sanitizeForTelegram(pinned)}</code> <i>(argless commands use this)</i>`
      : `\n<i>No project pinned. Try /pin so commands like /inbox can be argless.</i>`;

    const kb = new InlineKeyboard()
      .text('🧭 What now?', 'home:c')
      .text('📊 Status', 'home:s')
      .row()
      .text('📋 Projects', 'home:p')
      .text('▶ Run', 'home:r')
      .row()
      .text('📚 Help', 'home:h');

    return ctx.reply(
      `Hi, ${sanitizeForTelegram(ctx.from.first_name || 'friend')}.\n\n${summary}${pinnedLine}\n\n` +
      // v0.14.17 invariant: this literal line is required by scripts/verify-v0_14_17.mjs.
      // It's also genuinely useful for power-typing /run <project> <action>. Tapping
      // the ▶ Run button surfaces the same set as a picker.
      `<i>Actions for /run: go, resume, audit, bugs, roadmap, brief, guide, next, review, handoff, qa, ship, pipeline, reset-brief</i>`,
      { parse_mode: 'HTML', reply_markup: kb },
    );
  }
  return ctx.reply(
    `Welcome.\n\nThis bot is locked to the orchestrator owner. To enable yourself:\n\n` +
      `1. On the orchestrator host (Mac), run:\n` +
      `   <code>npm run bot-auth-code</code>\n\n` +
      `2. It prints a 6-character code. Send it back here as:\n` +
      `   <code>/auth ABC123</code>\n\n` +
      `Code expires in 15 minutes.`,
    { parse_mode: 'HTML' },
  );
}

export async function handleAuth(ctx) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const code = (ctx.match || '').trim().toUpperCase();
  if (!code) return ctx.reply('Usage: /auth CODE');

  if (isAllowlisted(userId)) return ctx.reply('You are already authorized.');

  const entry = consumeAuthCode(code);
  if (!entry) return ctx.reply('Invalid or expired code. Generate a new one with `npm run bot-auth-code`.');

  addUser({
    telegramUserId: userId,
    handle: ctx.from.username || null,
    label: entry.label || `${ctx.from.first_name || 'user'} (${ctx.from.username || 'no-handle'})`,
  });
  return ctx.reply(`✓ Authorized.\n\nSend /start to see commands.`);
}

// ─── Authed: read-only ──────────────────────────────────────────────────────

function humanDuration(ms) {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m`;
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

/**
 * Build the "queued" reply with v0.14 per-project context: shows what (if
 * anything) this job is waiting behind on the same project. Workers are
 * project-FIFO bound, so this is the only ordering visible to the user.
 *
 * NOTE on the `j.id < id` filter: ids are AUTOINCREMENT, so our just-enqueued
 * job has the highest id in the table. Anything `j.id < id` is genuinely
 * earlier; `j.id >= id` is either us (filter out) or doesn't exist yet.
 *
 * The same filter on `running` matters because a worker can claim our job
 * BETWEEN the enqueueJob() call and this format() call — without `j.id < id`
 * on running, we'd report "waiting behind ourselves" (v0.14.2 bug).
 */
async function formatEnqueueReply({ action, project, id }) {
  const mod = await import('./job-queue.js');
  const running = (mod.listRunningJobs?.() || []).filter((j) => j.project === project && j.id < id);
  const earlierPending = mod.listPendingJobs().filter((j) => j.project === project && j.id < id);

  const lines = [`✓ Queued: <code>${sanitizeForTelegram(action)} ${sanitizeForTelegram(project)}</code> (job #${id})`];
  if (running.length === 0 && earlierPending.length === 0) {
    lines.push(`<i>Starts immediately on a free worker.</i>`);
  } else {
    const waitingBehind = [];
    for (const j of running) {
      const elapsed = j.started_at ? humanDuration(Date.now() - Date.parse(j.started_at)) : '?';
      waitingBehind.push(`#${j.id} (${sanitizeForTelegram(j.action)}, running ${elapsed})`);
    }
    for (const j of earlierPending) {
      waitingBehind.push(`#${j.id} (${sanitizeForTelegram(j.action)}, queued)`);
    }
    lines.push(`<i>Waiting behind: ${waitingBehind.join(', ')}</i>`);
    lines.push(`<i>Per-project FIFO: starts when prior ${sanitizeForTelegram(project)} jobs complete.</i>`);
  }
  return lines.join('\n');
}

export const handleStatus = requireAuth(async (ctx) => {
  const cfg = await resolveConfig({ task: 'dev-execution' });
  // v0.14+: multiple jobs can run concurrently (one per project max).
  // Try listRunningJobs first; fall back to single-job display if the export
  // isn't there (only possible if someone ran with a v0.13 job-queue.js).
  let running = [];
  try {
    const mod = await import('./job-queue.js');
    if (typeof mod.listRunningJobs === 'function') {
      running = mod.listRunningJobs();
    } else {
      const single = getCurrentRunningJob();
      running = single ? [single] : [];
    }
  } catch {
    const single = getCurrentRunningJob();
    running = single ? [single] : [];
  }
  const pending = listPendingJobs();
  const pinned = getPinnedProject(ctx.from?.id);

  const lines = [];
  if (pinned) {
    lines.push(`📌 <b>Pinned:</b> ${sanitizeForTelegram(pinned)}`);
    lines.push('');
  }
  lines.push('<b>Window</b>');
  const status = renderStatus(cfg);
  lines.push('<code>' + status.replace(/<[^>]+>/g, '') + '</code>');
  lines.push('');

  // v0.14.4: show worker count + utilization
  try {
    const { listProjects } = await import('../state.js');
    const projectCount = listProjects().length;
    const configured = cfg?.job_runner?.max_concurrent_projects;
    const cap = parseInt(cfg?.job_runner?.max_workers_cap, 10) || 8;
    let workerCount;
    let scaleNote;
    if (typeof configured === 'number' && configured >= 1) {
      workerCount = Math.floor(configured);
      scaleNote = 'fixed';
    } else {
      workerCount = Math.max(1, Math.min(projectCount, cap));
      scaleNote = `auto: ${projectCount} project${projectCount === 1 ? '' : 's'}, cap ${cap}`;
    }
    const active = running.length;
    const idle = Math.max(0, workerCount - active);
    lines.push(`<b>Workers</b>`);
    lines.push(`${active}/${workerCount} active <i>(${idle} idle, ${scaleNote})</i>`);
    lines.push('');
  } catch { /* skip the section if state import races */ }

  if (running.length > 0) {
    lines.push(`<b>Currently running (${running.length})</b>`);
    for (const r of running) {
      const elapsed = r.started_at
        ? ` <i>(running ${humanDuration(Date.now() - Date.parse(r.started_at))})</i>`
        : '';
      lines.push(`#${r.id} · ${sanitizeForTelegram(r.action)} ${sanitizeForTelegram(r.project)}${elapsed}`);
    }
    lines.push('');
  } else {
    lines.push('<i>No jobs currently running.</i>\n');
  }

  if (pending.length > 0) {
    // Group pending by project so the per-project queue is visible
    const byProject = new Map();
    for (const j of pending) {
      if (!byProject.has(j.project)) byProject.set(j.project, []);
      byProject.get(j.project).push(j);
    }
    lines.push(`<b>Queue (${pending.length}) — per project</b>`);
    for (const [project, jobs] of byProject.entries()) {
      lines.push(`<i>${sanitizeForTelegram(project)}</i> (${jobs.length}):`);
      for (const j of jobs.slice(0, 5)) {
        lines.push(`  #${j.id} · ${sanitizeForTelegram(j.action)}`);
      }
      if (jobs.length > 5) lines.push(`  … and ${jobs.length - 5} more`);
    }
  } else {
    lines.push('<i>Queue empty.</i>');
  }

  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
});

export const handleProjects = requireAuth(async (ctx) => {
  const projects = listProjects();
  if (projects.length === 0) {
    return ctx.reply('No projects yet. Use the CLI: <code>npm run new -- &lt;name&gt;</code>', { parse_mode: 'HTML' });
  }
  const lines = ['<b>Projects</b>', ''];
  const kb = new InlineKeyboard();
  for (const p of projects) {
    const icon = p.status === 'completed' ? '✓' : p.status === 'cancelled' ? '⊘' : p.status === 'paused' ? '⏸' : p.status === 'ready-for-qa' ? '✱' : '·';
    // Read total phases from plan.json when available (more accurate than DB total_phases)
    let total = p.total_phases;
    try {
      const { planJsonPath } = await import('../lib/guide-paths.js');
      const fsm = await import('node:fs/promises');
      const plan = JSON.parse(await fsm.readFile(planJsonPath(path.join(PROJECTS_DIR, p.name)), 'utf-8'));
      if (plan?.phases?.length > 0) total = plan.phases[plan.phases.length - 1].n;
    } catch { /* no plan or unreadable */ }
    lines.push(`${icon} <b>${p.name}</b>  ${p.current_phase}/${total}  [${p.status}]`);
    kb.text(p.name, `proj:${p.name}`).row();
  }
  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb });
});

async function showProjectDetail(ctx, projectName) {
  const p = getProject(projectName);
  if (!p) return ctx.reply(`Project not found: ${projectName}`);

  // Try to read plan.json for rich phase titles and plan name.
  let planPhases = null;
  let planTitle = null;
  try {
    const { planJsonPath } = await import('../lib/guide-paths.js');
    const fs = await import('node:fs/promises');
    const planRaw = await fs.readFile(planJsonPath(path.join(PROJECTS_DIR, projectName)), 'utf-8');
    const plan = JSON.parse(planRaw);
    planPhases = plan?.phases || null;
    planTitle = plan?.display_name || plan?.title || null;
  } catch { /* no plan yet */ }

  const dbPhases = getPhases(projectName);
  const dbByN = Object.fromEntries(dbPhases.map((ph) => [ph.n, ph]));
  const completedPhase = p.current_phase || 0;
  // Use the last phase's N value (not count) so plans starting at n>1 show
  // correctly: a 17-phase plan numbered 11-27 shows "17/27" not "17/17".
  const totalFromPlan = planPhases && planPhases.length > 0
    ? planPhases[planPhases.length - 1].n
    : (p.total_phases || 0);

  const statusIcon = { completed: '✓', 'ready-for-qa': '✱', paused: '⏸', cancelled: '⊘', 'in-progress': '▶', planning: '·' };
  const lines = [
    `<b>${p.name}</b>${planTitle ? ` — ${planTitle}` : ''}`,
    `${statusIcon[p.status] || '·'} ${p.status}  ·  phase ${completedPhase}/${totalFromPlan}`,
    '',
  ];

  if (planPhases && planPhases.length > 0) {
    lines.push('<b>Phases:</b>');
    const nextPhase = completedPhase + 1;
    for (const ph of planPhases) {
      const dbRow = dbByN[ph.n];
      const done = ph.n <= completedPhase || dbRow?.status === 'completed';
      const running = dbRow?.status === 'in-progress';
      const isNext = ph.n === nextPhase && !done;
      const icon = done ? '✓' : running ? '▶' : '·';
      const sha = dbRow?.commit_sha ? `  <code>${dbRow.commit_sha.slice(0, 7)}</code>` : '';
      const arrow = isNext ? '  ← next' : '';
      const slug = ph.title || ph.slug || `phase ${ph.n}`;
      lines.push(`${icon} ${ph.n}: ${slug}${sha}${arrow}`);
    }
  } else if (dbPhases.length > 0) {
    lines.push('<b>Phases:</b>');
    for (const ph of dbPhases.slice(0, 12)) {
      const icon = ph.status === 'completed' ? '✓' : ph.status === 'in-progress' ? '▶' : '·';
      lines.push(`${icon} ${ph.n}: ${ph.title || '(untitled)'}`);
    }
  } else {
    lines.push('<i>No plan yet — run guide to generate one.</i>');
  }

  // v0.14.2: state-aware buttons — only offer actions that are currently
  // applicable. Avoids the "Resume on a project with no auto-runs" confusion
  // Prem hit.
  const { getLastAutoRun, getCurrentBugRound } = await import('../state.js');
  const lastRun = getLastAutoRun(projectName);
  const round = getCurrentBugRound(projectName);

  // What's valid:
  //   go       — always (handles fresh, mid-plan, and post-completion)
  //   audit    — always (read-only)
  //   roadmap  — always (idempotent; writes a new file)
  //   resume   — only if there's a paused auto-run
  //   bugs     — only if there's an in-progress bug round needing planning
  //   ship     — only if project is git-managed AND working branch != main
  const showResume = ['paused', 'failed'].includes(lastRun?.status);
  const showBugs   = round?.status === 'in-progress';
  const showShip   = !!p.git_branch && p.git_branch !== 'main';

  // v0.14.45: detect a bugs round that exists ON DISK (bugs.md present) but
  // has no fix-plan yet — i.e. a manually dropped/created round waiting for
  // `go`. This is the safety net for the asp episode: even if such a round is
  // created out-of-band, the project card now flags it instead of leaving the
  // operator to wonder why audits keep coming back clean.
  let pendingDropNote = null;
  try {
    const { detectHighestBugRound, bugsFilePath, fixPlanJsonPath } = await import('../lib/guide-paths.js');
    const projDir = path.join(PROJECTS_DIR, p.name);
    const hr = (await detectHighestBugRound(projDir)) || 0;
    if (hr > 0 && !showBugs) {
      const fsp = await import('node:fs/promises');
      let hasBugs = false; let hasPlan = false;
      try { await fsp.access(bugsFilePath(projDir, hr)); hasBugs = true; } catch { /* none */ }
      try { await fsp.access(fixPlanJsonPath(projDir, hr)); hasPlan = true; } catch { /* none */ }
      if (hasBugs && !hasPlan) {
        pendingDropNote = `🐞 <b>bugs round ${hr}</b> is on disk but not yet run — tap ▶ Go (or <code>/run ${p.name} go</code>) to plan + fix it.`;
      }
    }
  } catch { /* non-fatal — card still renders */ }

  const kb = new InlineKeyboard();
  // Row 1: Go is the workhorse — always present. Resume next to it if applicable.
  kb.text('▶ Go', `act:${p.name}:go`);
  if (showResume) kb.text('⏯ Resume', `act:${p.name}:resume`);
  kb.row();
  // Row 2: Audit (opens an "only / auto ×N" menu) + (Bugs if applicable)
  kb.text('🔍 Audit', `auditmenu:${p.name}`);
  if (showBugs) kb.text(`🐞 Bugs (round ${round.round})`, `bugsmenu:${p.name}`);
  kb.row();
  // Row 3: Roadmap + (Ship if applicable)
  kb.text('🗺 Roadmap', `act:${p.name}:roadmap`);
  if (showShip) kb.text('🚢 Ship', `confirm-yes:${p.name}:ship`);
  kb.row();
  // Row 4: Full pipeline (intake → build → fixes → QA, stops at ship gate)
  kb.text('🚀 Full pipeline', `pipemenu:${p.name}`);
  kb.row();
  kb.text('« Back', 'back:projects');

  // Footnote explaining hidden buttons (so user knows why fewer than 6 appear)
  const hidden = [];
  if (!showResume) hidden.push('Resume (no paused run)');
  if (!showBugs)   hidden.push('Bugs (no active round)');
  if (!showShip)   hidden.push('Ship (no git-managed develop branch)');
  if (hidden.length > 0) {
    lines.push('');
    lines.push(`<i>Hidden: ${hidden.join(', ')}</i>`);
  }

  // v0.14.45: surface a dropped-but-unrun bugs round prominently.
  if (pendingDropNote) {
    lines.push('');
    lines.push(pendingDropNote);
  }

  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb });
}

export const handleProject = requireAuth(async (ctx) => {
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  const name = await resolveProject(ctx, args);
  if (!name) return; // picker shown
  return showProjectDetail(ctx, name);
});

// ─── Authed: write ──────────────────────────────────────────────────────────

function parseProjectAction(text) {
  // Expects "project action" or "project action --flag"
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const [project, action, ...rest] = parts;
  if (!VALID_ACTIONS.includes(action)) return null;
  return { project, action, args: rest };
}

export const handleQueue = requireAuth(async (ctx) => {
  const raw = (ctx.match || '').trim();
  let parsed = parseProjectAction(raw);

  // Fallback: if input is just an action like "go", use the pinned project
  if (!parsed && raw) {
    const tokens = raw.split(/\s+/);
    if (VALID_ACTIONS.includes(tokens[0])) {
      const pinned = getPinnedProject(ctx.from?.id);
      if (pinned) parsed = { project: pinned, action: tokens[0], args: tokens.slice(1) };
    }
  }

  if (!parsed) {
    // No usable parse. v0.14.18: prefer the run-picker (queues directly)
    // over the pin-picker (changes user state). If they want to pin, /pin
    // is one tap from /start home.
    const pinned = getPinnedProject(ctx.from?.id);
    if (!pinned) {
      await showRunPicker(ctx);
      return;
    }
    return ctx.reply(
      `Usage: /queue &lt;project&gt; &lt;action&gt;  or  /queue &lt;action&gt; (uses pinned: ${sanitizeForTelegram(pinned)})\n` +
      `Actions: ${VALID_ACTIONS.join(', ')}`,
      { parse_mode: 'HTML' },
    );
  }

  const proj = getProject(parsed.project);
  if (!proj) return ctx.reply(`Project not found: ${parsed.project}`);

  if (parsed.action === 'roadmap') {
    if (await isRoadmapStackBlocked(ctx, parsed.project)) return;
  }

  let id;
  if (parsed.action === 'roadmap') {
    id = enqueueRoadmapJob({ project: parsed.project, args: {}, requestedBy: ctx.from.id });
    if (id === null) {
      return ctx.reply('A roadmap is already queued or running for this project.');
    }
  } else {
    // Flags from the trailing tokens (same pattern as --unattended below).
    const jobArgs = { unattended: parsed.args.includes('--unattended') };

    // v0.14.33: --auto / --chain on an audit makes it flow straight through
    // audit → promote → bugs round → every fix, unattended (stops only on a
    // blocker or round completion). No-op on any other action.
    if (parsed.action === 'audit'
      && (parsed.args.includes('--auto') || parsed.args.includes('--chain'))) {
      jobArgs.chain = true;
      // Optional repeat count for the auto pipeline: --rounds N or --rounds=N.
      const ri = parsed.args.findIndex((a) => a === '--rounds' || a.startsWith('--rounds='));
      if (ri !== -1) {
        const tok = parsed.args[ri];
        const n = tok.includes('=')
          ? parseInt(tok.split('=')[1], 10)
          : parseInt(parsed.args[ri + 1], 10);
        if (Number.isFinite(n)) jobArgs.rounds = Math.max(1, Math.min(10, n));
      }
    }

    // --auto / --chain on bugs: plan + execute each pending round in order,
    // lowest first, until no more rounds or a blocker. --rounds N caps how many.
    if (parsed.action === 'bugs'
      && (parsed.args.includes('--auto') || parsed.args.includes('--chain'))) {
      jobArgs.auto = true;
      const ri = parsed.args.findIndex((a) => a === '--rounds' || a.startsWith('--rounds='));
      if (ri !== -1) {
        const tok = parsed.args[ri];
        const n = tok.includes('=')
          ? parseInt(tok.split('=')[1], 10)
          : parseInt(parsed.args[ri + 1], 10);
        if (Number.isFinite(n)) jobArgs.rounds = Math.max(1, Math.min(20, n));
      }
    }

    // v0.14.33: pipeline flags — --rounds N (audit→fix loop) and
    // --stop-after brief|build|fixes|qa (default qa = run to the ship gate).
    if (parsed.action === 'pipeline') {
      const ri = parsed.args.findIndex((a) => a === '--rounds' || a.startsWith('--rounds='));
      if (ri !== -1) {
        const tok = parsed.args[ri];
        const n = tok.includes('=')
          ? parseInt(tok.split('=')[1], 10)
          : parseInt(parsed.args[ri + 1], 10);
        if (Number.isFinite(n)) jobArgs.rounds = Math.max(1, Math.min(10, n));
      }
      const si = parsed.args.findIndex((a) => a === '--stop-after' || a.startsWith('--stop-after='));
      if (si !== -1) {
        const tok = parsed.args[si];
        const v = tok.includes('=') ? tok.split('=')[1] : parsed.args[si + 1];
        if (['brief', 'build', 'fixes', 'qa'].includes(v)) jobArgs.stopAfter = v;
      }
      if (parsed.args.includes('--auto-brief')) jobArgs.autoBrief = true;
    }

    // --task <type> / --task=<type>: run a non-default guide task through the
    // queue. Only tasks needing nothing but project state + on-disk files are
    // allowed; ones needing a round / fix id / requirement are rejected with a
    // CLI pointer rather than enqueued to fail later. (See src/lib/guide-tasks.js.)
    if (parsed.action === 'guide') {
      const requested = parseFlagValue(parsed.args, '--task');
      const verdict = classifyGuideTask(requested);
      if (!verdict.ok && verdict.reason === 'unsafe') {
        return ctx.reply(
          `Guide task <code>${sanitizeForTelegram(verdict.task)}</code> needs context ` +
          `(a bug round, fix id, or requirement) that can't be passed over the queue.\n` +
          `Run it from the CLI:\n` +
          `<code>npm run guide -- ${sanitizeForTelegram(parsed.project)} --task ${sanitizeForTelegram(verdict.task)}</code>`,
          { parse_mode: 'HTML' },
        );
      }
      if (!verdict.ok && verdict.reason === 'unknown') {
        return ctx.reply(
          `Unknown guide task: <code>${sanitizeForTelegram(verdict.task)}</code>\n` +
          `Queue-safe tasks: ${[...QUEUE_SAFE_GUIDE_TASKS].join(', ')}`,
          { parse_mode: 'HTML' },
        );
      }
      if (verdict.task) jobArgs.task = verdict.task;
    }

    id = enqueueJob({
      project: parsed.project,
      action: parsed.action,
      args: jobArgs,
      requestedBy: ctx.from.id,
    });
  }
  return ctx.reply(await formatEnqueueReply({ action: parsed.action, project: parsed.project, id }), { parse_mode: 'HTML' });
});

export const handleRun = requireAuth(async (ctx) => {
  // v0.14: with the worker pool + per-project FIFO, /run is functionally
  // identical to /queue. The runner will start this on a free worker
  // immediately if the project isn't already running, otherwise queue it
  // behind the current job on that project. No global "already running"
  // block — that was a v0.13 artifact.
  return handleQueue(ctx);
});

export const handleCancel = requireAuth(async (ctx) => {
  // v0.14.8 / BUG-5: project-aware cancel.
  //
  // Pre-v0.14.8 this used getCurrentRunningJob() — a single row picked by
  // `ORDER BY started_at DESC LIMIT 1`. With ≥ 2 concurrent jobs (v0.14
  // worker pool), this silently targeted the most-recently-started job,
  // possibly not the one the user meant. Flagged as a known limit in v0.14.2;
  // finally fixed here.
  //
  // New behaviour:
  //   /cancel <project>  → confirms cancellation of that project's running job
  //                        (or replies "No running job for X" if there isn't one)
  //   /cancel  with 0 running → "Nothing running." (unchanged)
  //   /cancel  with 1 running → confirmation prompt for that job (unchanged)
  //   /cancel  with ≥ 2 running → inline picker keyboard listing each job
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  const projectArg = args[0] || null;

  const { listRunningJobs, getRunningJobsForProject } = await import('./job-queue.js');

  // Project-scoped path: /cancel <project>
  if (projectArg) {
    const matches = getRunningJobsForProject(projectArg);
    if (matches.length === 0) {
      return ctx.reply(
        `No running job for <code>${sanitizeForTelegram(projectArg)}</code>.\n` +
        `Use <code>/status</code> to see what's actually running.`,
        { parse_mode: 'HTML' },
      );
    }
    return showCancelConfirmation(ctx, matches[0]);
  }

  // No-arg path: route on how many jobs are currently running.
  const running = listRunningJobs();
  if (running.length === 0) return ctx.reply('Nothing running.');
  if (running.length === 1) return showCancelConfirmation(ctx, running[0]);

  // Two or more running — show a picker keyboard.
  const kb = new InlineKeyboard();
  for (const j of running) {
    const elapsed = j.started_at
      ? humanDuration(Date.now() - Date.parse(j.started_at))
      : '?';
    kb.text(`Cancel #${j.id}: ${j.action} ${j.project} (${elapsed})`, `cancel-pick:${j.id}`).row();
  }
  kb.text('« Nothing', 'cancel-no');
  return ctx.reply(
    `<b>${running.length} jobs running.</b> Pick one to cancel, or send <code>/cancel &lt;project&gt;</code>.`,
    { parse_mode: 'HTML', reply_markup: kb },
  );
});

/**
 * Shared confirmation step for /cancel — invoked from /cancel <project>,
 * /cancel (1-running fast path), and the cancel-pick callback. Sends the
 * "Cancel job #N: action project?" prompt with Yes/No buttons that route
 * to the existing cancel-yes / cancel-no callback handlers.
 */
function showCancelConfirmation(ctx, job) {
  const kb = new InlineKeyboard()
    .text('Yes, cancel', `cancel-yes:${job.id}`)
    .text('No', 'cancel-no');
  return ctx.reply(
    `Cancel job #${job.id}: <code>${sanitizeForTelegram(job.action)} ${sanitizeForTelegram(job.project)}</code>?\n\n` +
    `⚠ Mid-phase cancellation may leave the workspace in a partial state. ` +
    `Git state will reflect whatever was committed before the cancel.`,
    { parse_mode: 'HTML', reply_markup: kb },
  );
}

export const handleDequeue = requireAuth(async (ctx) => {
  const idStr = (ctx.match || '').trim();
  const id = parseInt(idStr, 10);
  if (!id) return ctx.reply('Usage: /dequeue &lt;job-id&gt;', { parse_mode: 'HTML' });
  const r = dequeuePendingJob(id);
  if (r.changes === 0) return ctx.reply(`Job #${id} not found or not pending.`);
  return ctx.reply(`✓ Removed job #${id} from queue.`);
});

export const handleUsers = requireAuth(async (ctx) => {
  const users = listUsers();
  if (users.length === 0) return ctx.reply('No allowlisted users.');
  const lines = ['<b>Allowlisted users</b>', ''];
  for (const u of users) {
    lines.push(`• ${u.telegram_handle || u.label || u.telegram_user_id}`);
    lines.push(`  ID: <code>${u.telegram_user_id}</code>`);
    lines.push(`  Added: ${u.allowlisted_at}`);
  }
  lines.push('\nTo remove a user, use the CLI: <code>npm run bot-users -- --remove &lt;id&gt;</code>');
  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
});

export const handleHistory = requireAuth(async (ctx) => {
  const jobs = listRecentJobs(15);
  if (jobs.length === 0) return ctx.reply('No job history yet.');
  const lines = ['<b>Recent jobs</b>', ''];
  for (const j of jobs) {
    const icon = j.status === 'completed' ? '✓' : j.status === 'failed' ? '✗' : j.status === 'cancelled' ? '⊘' : j.status === 'running' ? '▶' : '·';
    lines.push(`${icon} #${j.id} ${j.action} ${j.project} <i>[${j.status}]</i>`);
    if (j.result_summary) lines.push(`   ${j.result_summary.slice(0, 80)}`);
  }
  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
});

export const handleDownload = requireAuth(async (ctx) => {
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  const name = await resolveProject(ctx, args);
  if (!name) return; // picker shown
  const project = getProject(name);
  if (!project) return ctx.reply(`Project not found: ${name}`);

  await ctx.reply(`📦 Packaging ${name}… this may take a few seconds.`);

  try {
    const { packageProject } = await import('../commands/package-project.js');
    const result = await packageProject({ projectName: name, quiet: true });

    const sizeMB = result.sizeBytes / 1024 / 1024;
    if (sizeMB > 50) {
      return ctx.reply(
        `⚠ Project zip is ${sizeMB.toFixed(1)} MB — exceeds Telegram bot's 50 MB upload limit.\n\n` +
        `File created locally at:\n<code>${result.path}</code>\n\n` +
        `Retrieve via SSH/SCP from the orchestrator host.`,
        { parse_mode: 'HTML' },
      );
    }

    const { InputFile } = await import('grammy');
    await ctx.replyWithDocument(new InputFile(result.path), {
      caption: `${result.filename} (${sizeMB.toFixed(2)} MB)`,
    });
  } catch (err) {
    return ctx.reply(`✗ Failed: ${err.message}`);
  }
});

// ─── /suggest <project> ─────────────────────────────────────────────────────
//
// Interactive inline-keyboard flow for generating a suggestions plan.
// Uses a Map-based session state machine (no grammy Conversations).

export function _sugTypeLabel(projectType) {
  const map = { cli: 'CLI', frontend: 'Frontend', api: 'API', fullstack: 'Fullstack', unknown: 'Unknown' };
  return map[projectType] ?? 'Unknown';
}

export function _buildGoalKb() {
  return new InlineKeyboard()
    .text('⏭ Skip', 'sug:goal:skip').row()
    .text('❌ Cancel', 'sug:cancel');
}

function _buildTypeKb() {
  return new InlineKeyboard()
    .text('🖥️ CLI tool',      'sug:type:cli').row()
    .text('🖼️ Frontend',      'sug:type:frontend').row()
    .text('🔌 API / Backend', 'sug:type:api').row()
    .text('🔀 Fullstack',     'sug:type:fullstack').row()
    .text('❌ Cancel',         'sug:cancel');
}

export const handleSuggest = requireAuth(async (ctx) => {
  const text = ctx.message?.text || '';
  const parts = text.trim().split(/\s+/);
  const projectName = parts[1];

  if (!projectName) {
    return ctx.reply('Usage: /suggest <project>');
  }

  const project = getProject(projectName);
  if (!project) {
    const all   = listProjects().map(p => p.name);
    const names = all.length ? all.join(', ') : '(none)';
    return ctx.reply(`❌ Project "${projectName}" not found.\nValid projects: ${names}`);
  }

  const chatId  = ctx.chat.id;
  const userId  = ctx.from?.id;
  const projDir = path.join(PROJECTS_DIR, projectName);

  suggestSessions.delete(chatId);

  const scanMsg = await ctx.reply('📊 Scanning workspace…');

  let snapshot;
  try {
    snapshot = await scanProject(projDir);
  } catch (err) {
    await ctx.api.deleteMessage(chatId, scanMsg.message_id).catch(() => {});
    return ctx.reply(`❌ Scan failed for "${projectName}": ${err.message}`);
  }

  await ctx.api.deleteMessage(chatId, scanMsg.message_id).catch(() => {});

  const lastPhase = snapshot.phaseTitles?.[0] ?? 'none';

  const _baseSession = {
    projectName, projDir, snapshot, goal: '', allSuggestions: [],
    filtered: [], manualItems: [], awaitingInput: null,
    userId,
    noLm: false,
    categories: ['logic', 'frontend', 'infra', 'security', 'dx'],
    selectedIdxs: new Set(),
    passes: 1, pipelinePlan: {},
  };

  // If type is unknown, ask operator to pick before generating suggestions (step 0)
  if (snapshot.projectType === 'unknown') {
    suggestSessions.set(chatId, { ..._baseSession, step: 0 });

    const scanLine = `📊 Project scan: ${projectName} (type unknown, ${snapshot.completedPhases} phases done)\nLast: "${lastPhase}"`;
    await ctx.reply(
      `${scanLine}\n\n⚠️ Project type could not be detected.\nPick the type to get relevant suggestions:`,
      { reply_markup: _buildTypeKb() },
    );
    return;
  }

  // Normal path — type is concrete; ask goal before focus
  suggestSessions.set(chatId, { ..._baseSession, step: 1, awaitingInput: 'goal' });

  const typeLabel = _sugTypeLabel(snapshot.projectType);
  const scanLine  = `📊 Project scan: ${projectName} (${typeLabel}, ${snapshot.completedPhases} phases done)\nLast: "${lastPhase}"`;

  const goalQ = QUESTIONS.find(q => q.id === 'goal');
  await ctx.reply(`${scanLine}\n\n${goalQ.text}`, { reply_markup: _buildGoalKb() });
});

// ─── /newbrief <project> ────────────────────────────────────────────────────
//
// Preview the staged inputs/brief.md and offer to reset .guide/brief.md from it
// (archive old plan, rewind to phase 0). Mirrors `ashmero reset-brief`.
// Callback prefixes: nb:go | nb:show | nb:cancel — dispatched to
// handleNewbriefCallback in telegram-parity-handlers.js.
export const handleNewbrief = requireAuth(async (ctx) => {
  const text = ctx.message?.text || '';
  const parts = text.trim().split(/\s+/);
  const projectName = parts[1];

  if (!projectName) {
    return ctx.reply('Usage: /newbrief <project>');
  }

  const project = getProject(projectName);
  if (!project) {
    const all   = listProjects().map(p => p.name);
    const names = all.length ? all.join(', ') : '(none)';
    return ctx.reply(`❌ Project "${projectName}" not found.\nValid projects: ${names}`);
  }

  const fs = await import('node:fs/promises');
  const inputsBriefPath = path.join(PROJECTS_DIR, projectName, 'inputs', 'brief.md');
  let content;
  try {
    content = await fs.readFile(inputsBriefPath, 'utf-8');
  } catch {
    return ctx.reply(`❌ No staged brief at inputs/brief.md for "${projectName}". Drop one there first.`);
  }
  if (!content.trim()) {
    return ctx.reply(`❌ inputs/brief.md is empty for "${projectName}".`);
  }

  const preview = content.slice(0, 400);
  const truncated = content.length > 400 ? '\n…(truncated)' : '';

  const chatId = ctx.chat?.id ?? ctx.from?.id;
  // Record userId so a callback tap from a DIFFERENT user in a shared chat can't
  // act on (or silently overwrite) this session — mirrors suggestSessions.
  nbSessions.set(chatId, { projectName, userId: ctx.from?.id });

  const kb = new InlineKeyboard()
    .text('✅ Reset & run',   'nb:go').row()
    .text('📄 Show full',     'nb:show').row()
    .text('❌ Cancel',         'nb:cancel');

  return ctx.reply(
    `📝 New brief staged for <b>${escapeHtml(projectName)}</b> (${content.length} chars):\n\n`
    + `<pre>${escapeHtml(preview)}${truncated}</pre>\n\n`
    + `Reset will archive the old brief + plan and rewind to phase 0.`,
    { parse_mode: 'HTML', reply_markup: kb },
  );
});

// ─── Callback queries (button taps) ─────────────────────────────────────────

export async function handleCallback(ctx) {
  const data = ctx.callbackQuery?.data || '';
  const userId = ctx.from?.id;
  if (!userId || !isAllowlisted(userId)) {
    return ctx.answerCallbackQuery({ text: 'Not authorized', show_alert: true });
  }

  // Format: action:rest
  const [action, ...rest] = data.split(':');

  try {
    if (action === 'proj') {
      const project = rest.join(':');
      await ctx.answerCallbackQuery();
      return showProjectDetail(ctx, project);
    }

    if (action === 'act') {
      const project = rest[0];
      const verb = rest[1];

      if (!getProject(project)) {
        await ctx.answerCallbackQuery({ text: 'Project not found', show_alert: true });
        return;
      }

      // Roadmap-review is a marker write, not a job — intercept before VALID_ACTIONS check.
      if (verb === 'roadmap-review') {
        const { roadmapReviewedMarkerPath, findMostRecentRoadmap } = await import('../lib/guide-paths.js');
        const projDir = path.join(PROJECTS_DIR, project);
        if (!(await findMostRecentRoadmap(projDir))) {
          return ctx.answerCallbackQuery({ text: 'No roadmap to review', show_alert: true });
        }
        const { mkdir, writeFile } = await import('node:fs/promises');
        const markerPath = roadmapReviewedMarkerPath(projDir);
        await mkdir(path.dirname(markerPath), { recursive: true });
        await writeFile(markerPath, new Date().toISOString());
        await ctx.answerCallbackQuery();
        return ctx.reply('✅ Roadmap marked as reviewed. Section will clear on next /coach.');
      }

      if (!VALID_ACTIONS.includes(verb)) {
        return ctx.answerCallbackQuery({ text: 'Unknown action', show_alert: true });
      }

      // Roadmap lifecycle guard + atomic enqueue — keep as one block so the
      // verifier's single if (verb === 'roadmap') anchor finds both together.
      if (verb === 'roadmap') {
        if (await isRoadmapStackBlocked(ctx, project)) return;
        const id = enqueueRoadmapJob({ project, args: {}, requestedBy: userId });
        if (id === null) {
          await ctx.answerCallbackQuery({ text: 'A roadmap is already queued or running for this project.', show_alert: true });
          return;
        }
        await ctx.answerCallbackQuery({ text: `Queued #${id}` });
        return ctx.reply(await formatEnqueueReply({ action: verb, project, id }), { parse_mode: 'HTML' });
      }

      // ship gets confirmation
      if (verb === 'ship') {
        const kb = new InlineKeyboard()
          .text('Yes, ship', `confirm-yes:${project}:ship`)
          .text('No', 'confirm-no');
        await ctx.answerCallbackQuery();
        return ctx.reply(`Mark ${project} as shipped?`, { reply_markup: kb });
      }
      const id = enqueueJob({ project, action: verb, args: {}, requestedBy: userId });
      await ctx.answerCallbackQuery({ text: `Queued #${id}` });
      return ctx.reply(await formatEnqueueReply({ action: verb, project, id }), { parse_mode: 'HTML' });
    }

    // Bugs menu — tapping 🐞 Bugs asks "plan only / auto ×N" so the operator
    // can choose whether to chain through all pending rounds automatically.
    if (action === 'bugsmenu') {
      const project = rest.join(':');
      if (!getProject(project)) {
        await ctx.answerCallbackQuery({ text: 'Project not found', show_alert: true });
        return;
      }
      const kb = new InlineKeyboard()
        .text('🐞 Plan only', `act:${project}:bugs`).row()
        .text('🔁 Auto ×1', `bugsauto:${project}:1`)
        .text('×3', `bugsauto:${project}:3`)
        .text('×5', `bugsauto:${project}:5`)
        .text('All', `bugsauto:${project}:20`).row()
        .text('« Back', `proj:${project}`);
      await ctx.answerCallbackQuery();
      return ctx.reply(
        `<b>Bugs — ${sanitizeForTelegram(project)}</b>\n\n` +
        `<b>Plan only</b>: generate the fix plan for the next pending round, then stop. ` +
        `You run <code>go</code> manually to execute fixes.\n` +
        `<b>Auto ×N</b>: plan + execute fixes for each pending round in order (lowest first), ` +
        `up to N rounds. Stops early on any blocker. No input needed between rounds.\n\n` +
        `<i>Rounds are processed lowest-first (e.g. round 10 → 11 → 12 → 13).</i>`,
        { parse_mode: 'HTML', reply_markup: kb },
      );
    }

    // Launch the bugs auto-chain with a chosen round cap.
    if (action === 'bugsauto') {
      const project = rest[0];
      const rounds = Math.max(1, Math.min(20, parseInt(rest[1], 10) || 20));
      if (!getProject(project)) {
        await ctx.answerCallbackQuery({ text: 'Project not found', show_alert: true });
        return;
      }
      const id = enqueueJob({ project, action: 'bugs', args: { auto: true, rounds }, requestedBy: userId });
      const label = rounds >= 20 ? 'bugs (auto — all rounds)' : `bugs (auto ×${rounds})`;
      await ctx.answerCallbackQuery({ text: `Queued #${id}` });
      return ctx.reply(await formatEnqueueReply({ action: label, project, id }), { parse_mode: 'HTML' });
    }

    // Audit mode menu — tapping 🔍 Audit asks "only / auto ×N" instead of
    // running immediately, so the operator can opt into the auto pipeline and
    // pick how many full audit→fix rounds to run, all from buttons (no --auto).
    if (action === 'auditmenu') {
      const project = rest.join(':');
      if (!getProject(project)) {
        await ctx.answerCallbackQuery({ text: 'Project not found', show_alert: true });
        return;
      }
      const kb = new InlineKeyboard()
        .text('🔍 Audit only', `act:${project}:audit`).row()
        .text('🔁 Auto ×1', `autopipe:${project}:1`)
        .text('×2', `autopipe:${project}:2`)
        .text('×3', `autopipe:${project}:3`)
        .text('×5', `autopipe:${project}:5`)
        .text('♾ Until clean', `autopipe:${project}:inf`).row()
        .text('« Back', `proj:${project}`);
      await ctx.answerCallbackQuery();
      return ctx.reply(
        `<b>Audit — ${sanitizeForTelegram(project)}</b>\n\n` +
        `<b>Audit only</b>: produce the audit document, then stop (you promote manually).\n` +
        `<b>Auto ×N</b>: audit → promote findings → run every fix, repeated up to N times, ` +
        `re-auditing between rounds. Stops early when an audit comes back clean, or on a blocker.\n` +
        `<b>♾ Until clean</b>: same loop with no fixed count — runs until the audit comes back clean ` +
        `(safety ceiling: auto_run.max_chain_rounds, default 25).\n\n` +
        `⚠ Each round is a full audit + fix cycle — ×3/×5 burn real budget.`,
        { parse_mode: 'HTML', reply_markup: kb },
      );
    }

    // Launch the auto pipeline with a chosen round count (enqueues an audit job
    // carrying chain:true + rounds:N; the loop lives in job-runner's audit case).
    if (action === 'autopipe') {
      const project = rest[0];
      // v0.14.43: 'inf' = until-clean mode (loop until a clean audit, hard
      // ceiling auto_run.max_chain_rounds, default 25).
      const rounds = rest[1] === 'inf' ? 'inf' : Math.max(1, Math.min(10, parseInt(rest[1], 10) || 1));
      if (!getProject(project)) {
        await ctx.answerCallbackQuery({ text: 'Project not found', show_alert: true });
        return;
      }
      const id = enqueueJob({ project, action: 'audit', args: { chain: true, rounds }, requestedBy: userId });
      await ctx.answerCallbackQuery({ text: rounds === 'inf' ? `Queued #${id} — auto until clean` : `Queued #${id} — auto ×${rounds}` });
      return ctx.reply(
        await formatEnqueueReply({ action: rounds === 'inf' ? 'audit (auto ♾ until clean)' : `audit (auto ×${rounds})`, project, id }),
        { parse_mode: 'HTML' },
      );
    }

    // Full-pipeline menu — choose how far to run and how many audit→fix rounds.
    if (action === 'pipemenu') {
      const project = rest.join(':');
      if (!getProject(project)) {
        await ctx.answerCallbackQuery({ text: 'Project not found', show_alert: true });
        return;
      }
      const kb = new InlineKeyboard()
        .text('🚀 Full ×1', `pipe:${project}:1:qa`)
        .text('×2', `pipe:${project}:2:qa`)
        .text('×3', `pipe:${project}:3:qa`).row()
        .text('🛠 Build only', `pipe:${project}:1:build`)
        .text('📝 Brief only', `pipe:${project}:1:brief`).row()
        .text('« Back', `proj:${project}`);
      await ctx.answerCallbackQuery();
      return ctx.reply(
        `<b>Full pipeline — ${sanitizeForTelegram(project)}</b>\n\n` +
        `Chains <b>intake → brief → build → bug inbox → audit→fix (×N) → QA handoff</b>, ` +
        `then stops at the ship gate for your review. Stops early on any blocker.\n\n` +
        `<b>Full ×N</b>: run everything; N = audit→fix loop rounds.\n` +
        `<b>Build only</b>: brief + plan + phases, then stop.\n` +
        `<b>Brief only</b>: draft the brief, then stop for review.\n\n` +
        `⚠ "Full" can run for a long time and burns real budget. It never ships and ` +
        `never creates new projects — you stay in control of both.`,
        { parse_mode: 'HTML', reply_markup: kb },
      );
    }

    // Launch the pipeline with a chosen round count + stop point.
    // Gate: ask for Yes/Cancel before committing — pipeline is multi-hour and burns real budget.
    if (action === 'pipe') {
      const project = rest[0];
      const rounds = Math.max(1, Math.min(10, parseInt(rest[1], 10) || 1));
      const stopAfter = ['brief', 'build', 'fixes', 'qa'].includes(rest[2]) ? rest[2] : 'qa';
      if (!getProject(project)) {
        await ctx.answerCallbackQuery({ text: 'Project not found', show_alert: true });
        return;
      }
      const kb = new InlineKeyboard()
        .text(`Yes — pipeline ×${rounds} (${stopAfter})`, `pipe-y:${project}:${rounds}:${stopAfter}`)
        .text('Cancel', 'confirm-no');
      await ctx.answerCallbackQuery();
      return ctx.reply(
        `<b>Run pipeline ×${rounds} stopping after ${stopAfter}?</b>\n\n` +
        `This can take hours and uses real budget. It never ships automatically — ` +
        `you stay in control at the ship gate.`,
        { parse_mode: 'HTML', reply_markup: kb },
      );
    }

    if (action === 'pipe-y') {
      const project = rest[0];
      const rounds = Math.max(1, Math.min(10, parseInt(rest[1], 10) || 1));
      const stopAfter = ['brief', 'build', 'fixes', 'qa'].includes(rest[2]) ? rest[2] : 'qa';
      if (!getProject(project)) {
        await ctx.answerCallbackQuery({ text: 'Project not found', show_alert: true });
        return;
      }
      const id = enqueueJob({ project, action: 'pipeline', args: { rounds, stopAfter }, requestedBy: userId });
      const label = stopAfter === 'qa' ? `pipeline (full ×${rounds})` : `pipeline (stop after ${stopAfter})`;
      await ctx.answerCallbackQuery({ text: `Queued #${id}` });
      return ctx.reply(await formatEnqueueReply({ action: label, project, id }), { parse_mode: 'HTML' });
    }

    if (action === 'confirm-yes') {
      const project = rest[0];
      const verb = rest[1];
      if (!VALID_ACTIONS.includes(verb)) {
        return ctx.answerCallbackQuery({ text: 'Unknown action', show_alert: true });
      }
      if (verb === 'roadmap') {
        if (await isRoadmapStackBlocked(ctx, project)) return;
        const id = enqueueRoadmapJob({ project, args: {}, requestedBy: userId });
        if (id === null) {
          await ctx.answerCallbackQuery({ text: 'A roadmap is already queued or running for this project.', show_alert: true });
          return;
        }
        await ctx.answerCallbackQuery({ text: `Queued #${id}` });
        return ctx.reply(await formatEnqueueReply({ action: verb, project, id }), { parse_mode: 'HTML' });
      }
      const id = enqueueJob({ project, action: verb, args: {}, requestedBy: userId });
      await ctx.answerCallbackQuery({ text: 'Confirmed' });
      return ctx.reply(await formatEnqueueReply({ action: verb, project, id }), { parse_mode: 'HTML' });
    }

    if (action === 'confirm-no' || action === 'cancel-no') {
      await ctx.answerCallbackQuery({ text: 'Cancelled' });
      return ctx.reply('Cancelled.');
    }

    // v0.14.8 / BUG-5: cancel-pick callback — user tapped a job in the
    // multi-job /cancel picker keyboard. Route to the standard confirmation
    // flow so the user still gets the Yes/No prompt before anything is
    // actually killed.
    if (action === 'cancel-pick') {
      const jobId = parseInt(rest[0], 10);
      const { getJob } = await import('./job-queue.js');
      const job = getJob(jobId);
      if (!job) {
        await ctx.answerCallbackQuery({ text: 'Job not found', show_alert: true });
        return;
      }
      if (job.status !== 'running') {
        await ctx.answerCallbackQuery({ text: `Job is ${job.status}, not running`, show_alert: true });
        return;
      }
      await ctx.answerCallbackQuery();
      return showCancelConfirmation(ctx, job);
    }

    if (action === 'cancel-yes') {
      const jobId = parseInt(rest[0], 10);

      // Persist the request first so cancellation works even when a separate
      // headless worker owns the subprocess. The lease-owning worker observes
      // this flag, kills its process group, and performs the fenced terminal
      // update. killCurrent remains a same-process fast path only.
      const requested = requestJobCancellation(jobId, 'cancelled via Telegram');
      const { killCurrent } = await import('../claude-runner.js');
      const killResult = killCurrent({ jobId, reason: `telegram cancel of job #${jobId}` });

      await ctx.answerCallbackQuery({ text: requested ? 'Cancelling…' : 'Job is no longer running' });
      if (!requested) {
        return ctx.reply(`Job #${jobId} is no longer running, so no cancellation was recorded.`);
      }
      if (killResult.killed) {
        return ctx.reply(
          `⊘ Cancellation requested for job #${jobId}.\n\n` +
          `Subprocess kill signal sent (PID ${killResult.pid}). SIGTERM first, ` +
          `SIGKILL after 5s if needed.\n\n` +
          `⚠ Workspace state will reflect the last completed commit before cancel. ` +
          `Any in-flight file writes from claude may have partially landed — check git status.`,
        );
      } else {
        return ctx.reply(
          `⊘ Cancellation requested for job #${jobId}.\n\n` +
          `This bot process does not own the subprocess (${killResult.reason}); ` +
          `the durable worker will stop it and finalize the job shortly.`,
        );
      }
    }

    if (action === 'req') {
      return handleReqCallback(ctx, rest, userId);
    }

    if (action === 'triage' && rest[0] === 'start') { // triage:start:<project> → handleTriage
      const project = rest.slice(1).join(':');
      await ctx.answerCallbackQuery();
      ctx.match = project;
      return handleTriage(ctx);
    }

    if (action === 'triage') {
      return handleTriageCallback(ctx, rest, userId);
    }

    if (action === 'na') {
      return handleNextActionsCallback(ctx, rest, userId);
    }

    if (action === 'pin') {
      return handlePinCallback(ctx, rest, userId);
    }

    if (action === 'bug') {
      return handleBugCallback(ctx, rest, userId);
    }

    if (action === 'back') {
      const where = rest[0];
      await ctx.answerCallbackQuery();
      if (where === 'projects') return handleProjects(ctx);
    }

    // ─── v0.14.18: /start home buttons ────────────────────────────────────
    if (action === 'home') {
      await ctx.answerCallbackQuery();
      if (rest[0] === 's') return handleStatus(ctx);
      if (rest[0] === 'p') return handleProjects(ctx);
      if (rest[0] === 'r') return showRunPicker(ctx);
      if (rest[0] === 'c') {
        // 🧭 What now? — dispatch to /coach. Requires a pinned project;
        // if there isn't one, prompt for pick.
        const pinned = getPinnedProject(userId);
        if (!pinned) {
          await showProjectPicker(ctx, 'Pick a project to pin, then I can suggest what to do next:');
          return;
        }
        // Synthesise a fake ctx.match='' since coach reads it; pinned will resolve.
        ctx.match = '';
        const { handleCoach } = await import('./telegram-parity-handlers.js');
        return handleCoach(ctx);
      }
      if (rest[0] === 'h') {
        // Reuse handleHelp's no-arg path by faking the match string.
        // Cheaper than duplicating the keyboard build here.
        ctx.match = '';
        return handleHelp(ctx);
      }
      return;
    }

    // ─── v0.14.18: /help button TOC ───────────────────────────────────────
    if (action === 'help') {
      if (rest[0] === 't') {
        const topic = rest[1];
        await ctx.answerCallbackQuery();
        const t = HELP_TOPICS[topic];
        if (!t) return ctx.reply(`Unknown help topic: <code>${sanitizeForTelegram(topic)}</code>`, { parse_mode: 'HTML' });
        return ctx.reply(`<b>📖 ${t.title}</b>\n\n${t.body}`, { parse_mode: 'HTML' });
      }
      return ctx.answerCallbackQuery({ text: 'Unknown help sub-action', show_alert: true });
    }

    // ─── v0.14.18: /run no-args picker ────────────────────────────────────
    if (action === 'run') {
      await ctx.answerCallbackQuery();
      if (rest[0] === 'p') {
        // User picked a project; show the action picker
        return showRunActionPicker(ctx, rest[1]);
      }
      if (rest[0] === 'a') {
        // User picked project + action; enqueue immediately
        const project = rest[1];
        const verb = rest[2];
        if (!getProject(project)) {
          return ctx.reply(
            `Project not found: <code>${sanitizeForTelegram(project)}</code>`,
            { parse_mode: 'HTML' },
          );
        }
        if (!VALID_ACTIONS.includes(verb)) {
          return ctx.reply(`Unknown action: <code>${sanitizeForTelegram(verb)}</code>`, { parse_mode: 'HTML' });
        }
        if (verb === 'ship') {
          // Mirror /act:*:ship behaviour: require confirmation
          const kb = new InlineKeyboard()
            .text('Yes, ship', `confirm-yes:${project}:ship`)
            .text('No', 'confirm-no');
          return ctx.reply(`Mark ${sanitizeForTelegram(project)} as shipped?`, { parse_mode: 'HTML', reply_markup: kb });
        }
        if (verb === 'roadmap') {
          if (await isRoadmapStackBlocked(ctx, project)) return;
          const id = enqueueRoadmapJob({ project, args: {}, requestedBy: userId });
          if (id === null) {
            return ctx.reply('A roadmap is already queued or running for this project.');
          }
          return ctx.reply(await formatEnqueueReply({ action: verb, project, id }), { parse_mode: 'HTML' });
        }
        const id = enqueueJob({ project, action: verb, args: {}, requestedBy: userId });
        return ctx.reply(await formatEnqueueReply({ action: verb, project, id }), { parse_mode: 'HTML' });
      }
      return;
    }

    // ─── v0.14.18: /inspect, /retry, /promote callbacks dispatch to parity module ─
    if (action === 'insp') {
      const { handleInspectCallback } = await import('./telegram-parity-handlers.js');
      return handleInspectCallback(ctx, rest);
    }
    if (action === 'retry') {
      const { handleRetryCallback } = await import('./telegram-parity-handlers.js');
      return handleRetryCallback(ctx, rest);
    }
    if (action === 'prom' && rest[0] === 'show') {
      // prom:show:<project>  →  /promote <project>
      const project = rest.slice(1).join(':');
      await ctx.answerCallbackQuery();
      ctx.match = project;
      const { handlePromote } = await import('./telegram-parity-handlers.js');
      return handlePromote(ctx);
    }

    if (action === 'prom') {
      const { handlePromoteCallback } = await import('./telegram-parity-handlers.js');
      return handlePromoteCallback(ctx, rest);
    }

    // v0.14.27: four callback prefixes used by /coach buttons that were
    // never wired into the dispatcher. The buttons rendered fine but
    // tapping them returned "Unknown action". All four target handlers
    // already exist as /command handlers — they just expect their args
    // in ctx.match. We synthesise ctx.match and re-invoke.

    if (action === 'qa') {
      // qa:<project>  →  /qa_handoff <project>
      const project = rest.join(':');
      await ctx.answerCallbackQuery();
      ctx.match = project;
      const { handleQaHandoff } = await import('./telegram-parity-handlers.js');
      return handleQaHandoff(ctx);
    }

    if (action === 'predict') {
      // predict:<project>  →  /predict <project>
      const project = rest.join(':');
      await ctx.answerCallbackQuery();
      ctx.match = project;
      const { handlePredict } = await import('./telegram-parity-handlers.js');
      return handlePredict(ctx);
    }

    if (action === 'preview') {
      // preview:<project>:<artifact>  →  /preview <project> <artifact>
      // rest[0] is the project; rest[1..] is the artifact shortcut.
      const project = rest[0];
      const artifact = rest.slice(1).join(':');
      await ctx.answerCallbackQuery();
      ctx.match = artifact ? `${project} ${artifact}` : project;
      const { handlePreview } = await import('./preview-handlers.js');
      return handlePreview(ctx);
    }

    if (action === 'git') {
      // git:<project>  →  /git_status <project>
      const project = rest.join(':');
      await ctx.answerCallbackQuery();
      ctx.match = project;
      return handleGitStatus(ctx);
    }

    if (action === 'extend') {
      // extend:<sub>:<project> — delegated to telegram-parity-handlers
      const { handleExtendCallback } = await import('./telegram-parity-handlers.js');
      return handleExtendCallback(ctx, rest);
    }

    if (action === 'rmproj') {
      const { handleRemoveProjectCallback } = await import('./telegram-parity-handlers.js');
      return handleRemoveProjectCallback(ctx, rest);
    }

    // requireConfirmation gate (Phase 13): cf:<id>:<nonce>:<optIdx> resolves the
    // pending row by nonce, unblocking a gated self-heal / brief-append.
    if (action === 'cf') {
      const { handleConfirmCallback } = await import('./telegram-parity-handlers.js');
      return handleConfirmCallback(ctx, rest);
    }

    if (action === 'sug') {
      const { handleSuggestCallback } = await import('./telegram-parity-handlers.js');
      return handleSuggestCallback(ctx, rest);
    }

    if (action === 'nb') {
      const { handleNewbriefCallback } = await import('./telegram-parity-handlers.js');
      return handleNewbriefCallback(ctx, rest);
    }

    // oq:<id>:<index> — answer with option <index>; oq:<id>:assume — confirm
    // the recorded assumption (Phase 49). rest[0] is the numeric id, rest[1]
    // is the index or the literal token 'assume'.
    if (action === 'oq') {
      const id = Number.parseInt(rest[0], 10);
      const token = rest[1];
      if (!Number.isInteger(id) || !token) {
        return ctx.answerCallbackQuery({ text: 'Bad operator-question callback', show_alert: true });
      }
      const row = getOperatorQuestionById(id);
      if (!row) {
        return ctx.answerCallbackQuery({ text: `Question #${id} not found`, show_alert: true });
      }
      if (row.status !== 'open') {
        await ctx.answerCallbackQuery({ text: 'Already answered.' });
        try { await ctx.editMessageText(renderOperatorQuestionResolvedText(row), { parse_mode: 'HTML' }); } catch { /* not editable */ }
        return;
      }
      const answerText = resolveAnswerFromToken(row, token);
      if (answerText == null) {
        return ctx.answerCallbackQuery({ text: 'Unknown option', show_alert: true });
      }
      const result = await resolveOperatorQuestion({ id, answer: answerText, answeredBy: ctx.from?.id ?? null });
      await ctx.answerCallbackQuery({ text: result.applied ? '✓ Recorded' : 'Already answered.' });
      try { await ctx.editMessageText(renderOperatorQuestionResolvedText(result.row), { parse_mode: 'HTML' }); } catch { /* not editable */ }
      if (result.applied && result.contradiction) {
        await ctx.reply(result.followupText, { parse_mode: 'HTML' }).catch(() => {});
      }
      return;
    }

    return ctx.answerCallbackQuery({ text: `Unknown action: ${action}` });
  } catch (err) {
    console.error('[callback]', err);
    return ctx.answerCallbackQuery({ text: 'Error: ' + (err.message || 'unknown'), show_alert: true });
  }
}

// ─── Requirements inbox handlers ────────────────────────────────────────────
//
// Commands:
//   /req <project> <text>      One-shot capture into a specific project.
//   /req <text>                One-shot capture into _inbox (unscoped).
//   /capture <project>         Enter capture mode — next non-command messages go to that project.
//   /done                      Exit capture mode.
//   /inbox [project]           Browse + triage inbox items with inline buttons.

const INBOX_PROJECT = '_inbox';
const VALID_PRIORITIES = ['p0', 'p1', 'p2', 'p3'];
const VALID_SCOPES = ['now', 'next', 'later', 'no'];

export const handleReq = requireAuth(async (ctx) => {
  const userId = ctx.from?.id;
  const text = ctx.message?.text || '';
  // Strip leading "/req" and one space
  const argText = text.replace(/^\/req(@\w+)?\s*/i, '').trim();
  if (!argText) {
    const pinned = getPinnedProject(userId);
    return ctx.reply(
      'Usage:\n'
      + '  /req <project> <text>      — save into a specific project\n'
      + '  /req <text>                — save into ' + (pinned ? `pinned project (${pinned})` : '_inbox (triage later)') + '\n\n'
      + 'Or /capture <project> for multi-message capture mode.',
    );
  }
  // Resolution order:
  //   1. If first token is a known project → use it
  //   2. Else if user has a pinned project → use it
  //   3. Else → _inbox
  const firstSpace = argText.indexOf(' ');
  const pinned = getPinnedProject(userId);
  let project = pinned || INBOX_PROJECT;
  let body = argText;
  if (firstSpace > 0) {
    const candidate = argText.slice(0, firstSpace);
    if (candidate === INBOX_PROJECT || getProject(candidate)) {
      project = candidate;
      body = argText.slice(firstSpace + 1).trim();
    }
  }
  if (!body) return ctx.reply('Empty requirement text.');
  const id = addRequirement({ project, raw_text: body, source: 'telegram', created_by: userId });
  return ctx.reply(`✓ Saved as req #${id} in ${project} inbox.`);
});

export const handleCapture = requireAuth(async (ctx) => {
  const userId = ctx.from?.id;
  const text = ctx.message?.text || '';
  const arg = text.replace(/^\/capture(@\w+)?\s*/i, '').trim();
  const args = arg ? arg.split(/\s+/) : [];
  const project = await resolveProject(ctx, args);
  if (!project) return; // picker shown
  if (project !== INBOX_PROJECT && !getProject(project)) {
    return ctx.reply(`Project not found: ${project}`);
  }
  setCaptureMode(userId, project);
  return ctx.reply(
    `🟢 Capture mode ON for *${project}*.\n\n`
    + `Send messages and I'll save each as a requirement. `
    + `Send /done to exit.`,
    { parse_mode: 'Markdown' },
  );
});

export const handleDone = requireAuth(async (ctx) => {
  const userId = ctx.from?.id;
  const mode = getCaptureMode(userId);
  if (!mode) return ctx.reply('You are not in capture mode.');
  clearCaptureMode(userId);
  return ctx.reply(`🔴 Capture mode OFF (was: ${mode.project}).`);
});

// /oq <id> <answer text…> — free-text answer to an ask_operator question
// (Phase 49), the non-button counterpart to the oq:<id>:<index>/assume
// inline-keyboard callback above. Shares resolveOperatorQuestion so both
// paths are equally idempotent and equally feed decisions.jsonl.
export const handleOperatorQuestion = requireAuth(async (ctx) => {
  const text = ctx.message?.text || '';
  const argText = text.replace(/^\/oq(@\w+)?\s*/i, '').trim();
  const firstSpace = argText.indexOf(' ');
  if (!argText || firstSpace < 0) {
    return ctx.reply('Usage: /oq <id> <answer text>');
  }
  const id = Number.parseInt(argText.slice(0, firstSpace), 10);
  const answerText = argText.slice(firstSpace + 1).trim();
  if (!Number.isInteger(id) || !answerText) {
    return ctx.reply('Usage: /oq <id> <answer text>');
  }
  const row = getOperatorQuestionById(id);
  if (!row) return ctx.reply(`Question #${id} not found.`);
  if (row.status !== 'open') return ctx.reply(`Question #${id} was already answered.`);

  const result = await resolveOperatorQuestion({ id, answer: answerText, answeredBy: ctx.from?.id ?? null });
  if (!result.applied) return ctx.reply(`Question #${id} was already answered.`);
  await ctx.reply(`✓ Recorded answer to question #${id}.`);
  if (result.contradiction) {
    await ctx.reply(result.followupText, { parse_mode: 'HTML' }).catch(() => {});
  }
});

export const handleInbox = requireAuth(async (ctx) => {
  const text = ctx.message?.text || '';
  const arg = text.replace(/^\/inbox(@\w+)?\s*/i, '').trim();

  if (!arg) {
    // No arg — prefer pinned project, else show all-projects picker
    const pinned = getPinnedProject(ctx.from?.id);
    if (pinned) return showReqList(ctx, pinned);
    const rows = listProjectsWithRequirements();
    if (!rows.length) return ctx.reply('No requirements captured yet.\n\nUse /req or /capture to start.');
    const kb = new InlineKeyboard();
    for (const r of rows) kb.text(`${r.project} (${r.n})`, `req:list:${r.project}`).row();
    return ctx.reply('Inbox — pick a project:', { reply_markup: kb });
  }
  return showReqList(ctx, arg);
});

// v0.14.11: /req_promote — batch promote command, parallel to /bug_promote.
//   /req_promote <inbox> <destination>           Promote scope=now items (or
//                                                auto-scope unassigned first).
//   /req_promote <inbox>                         Use last-used destination,
//                                                or show picker if none.
//   /req_promote <inbox> <destination> --plan    Also queue brief + guide
//                                                after promote.
//
// "Promote-only" is the default and the safer choice; the --plan flag opts
// into the auto-pipeline. The expensive 'go' step is always manual — user
// must /run go <destination> after reviewing the plan.
export const handleReqPromote = requireAuth(async (ctx) => {
  const userId = ctx.from?.id;
  const text = ctx.message?.text || '';
  const arg = text.replace(/^\/req_promote(@\w+)?\s*|^\/reqpromote(@\w+)?\s*/i, '').trim();
  const tokens = arg.split(/\s+/).filter(Boolean);
  const flags = tokens.filter((t) => t.startsWith('--'));
  const positional = tokens.filter((t) => !t.startsWith('--'));
  const planMode = flags.includes('--plan');

  const inboxProject = positional[0];
  if (!inboxProject) {
    return ctx.reply(
      `Usage: <code>/req_promote &lt;inbox&gt; [destination] [--plan]</code>\n\n`
      + `Examples:\n`
      + `  <code>/req_promote reelchain --plan</code> (within same project, common case)\n`
      + `  <code>/req_promote _inbox billflow-tds</code> (route generic ideas to a project)\n`
      + `  <code>/req_promote _inbox</code> (uses last destination)`,
      { parse_mode: 'HTML' },
    );
  }

  const { getLastInboxDestination, performReqPromote, rememberInboxDestination } =
    await import('../commands/req-promote.js');
  let destProject = positional[1];
  if (!destProject) {
    destProject = getLastInboxDestination(inboxProject);
    if (!destProject) {
      // v0.14.20: if the inbox IS a real project (not _inbox), default the
      // destination to the same. Most users capture directly into the
      // project they want to work on (`/req reelchain "…"`), so typing
      // the name twice for promote is pure friction. Only `_inbox` (the
      // generic virtual project) requires an explicit destination —
      // route those to the picker.
      if (inboxProject !== INBOX_PROJECT && getProject(inboxProject)) {
        destProject = inboxProject;
      } else {
        return handleReqCallback(ctx, ['promote-pick', inboxProject], userId);
      }
    }
  }

  let result;
  try {
    result = await performReqPromote({
      inboxProject,
      destinationProject: destProject,
      scope: 'now',
      autoScope: true,
    });
  } catch (err) {
    return ctx.reply(`✗ Promote failed: ${sanitizeForTelegram(err.message)}`, { parse_mode: 'HTML' });
  }
  rememberInboxDestination(inboxProject, destProject, userId);

  const relPath = path.relative(REPO_ROOT, result.destinationPath);
  const samePath = inboxProject === destProject;

  // v0.14.20: cleaner message. When src==dst (common case), don't show
  // confusing "from X into X". Wrap raw-thoughts.md path properly in
  // <code> so Telegram doesn't autolink the .md "TLD".
  const headerLines = [
    `📝 <b>Promoted ${result.promoted} requirement(s)</b>`,
  ];
  if (samePath) {
    headerLines.push(`   project: <code>${sanitizeForTelegram(destProject)}</code>`);
  } else {
    headerLines.push(`   from: <code>${sanitizeForTelegram(inboxProject)}</code>`);
    headerLines.push(`   into: <code>${sanitizeForTelegram(destProject)}</code>`);
  }
  headerLines.push(`   file: <code>${sanitizeForTelegram(relPath)}</code>`);
  headerLines.push('');
  headerLines.push(`IDs: #${result.ids.join(', #')}`);

  await ctx.reply(headerLines.join('\n'), { parse_mode: 'HTML' });

  if (!planMode) {
    // Fixed: was `/run brief <project>` which the parser rejects (parser
    // expects project FIRST, action second). Correct syntax shown.
    const kb = new InlineKeyboard()
      .text('📝 Generate brief', `act:${destProject}:brief`)
      .text('📖 Open raw-thoughts', `preview:${destProject}:raw-thoughts`);
    return ctx.reply(
      `<b>What next?</b>\n\n`
      + `Review the items, then I'll write a brief from them.\n\n`
      + `Or run: <code>/run ${sanitizeForTelegram(destProject)} brief</code>`,
      { parse_mode: 'HTML', reply_markup: kb },
    );
  }

  // --plan flow: queue brief, then guide. After guide completes, the
  // notifier's next-actions buttons (Start auto-run / Read plan / etc.)
  // take over. This explanation tells the user what they're about to see.
  await ctx.reply(
    `<b>▶ Plan mode active.</b>\n\n`
    + `Here's exactly what happens next:\n`
    + `  1️⃣  <b>brief</b> job runs (~30s) — polishes raw-thoughts.md into brief.md\n`
    + `  2️⃣  <b>guide</b> job runs (~2-5 min) — generates plan.json + phase prompts\n`
    + `  3️⃣  I DM you when guide finishes, with buttons to:\n`
    + `       • <b>▶ Start auto-run</b> — runs every phase\n`
    + `       • <b>📖 Read plan</b> — review first\n`
    + `       • <b>💰 Predict cost</b> — sanity-check before kicking off\n\n`
    + `<i>No code is written until you tap ▶ Start auto-run.</i>\n\n`
    + `<b>Want only some requirements next time?</b> Run <code>/triage ${sanitizeForTelegram(inboxProject)}</code> before promoting — only items marked <code>scope=now</code> get included.`,
    { parse_mode: 'HTML' },
  );

  await enqueueAndReply(ctx, {
    project: destProject,
    action: 'brief',
    args: { unattended: true },
    requestedBy: userId,
    prelude: 'Step 1/2 — brief',
  });
  return enqueueAndReply(ctx, {
    project: destProject,
    action: 'guide',
    args: { unattended: true },
    requestedBy: userId,
    prelude: 'Step 2/2 — guide (will queue behind brief)',
  });
});

async function showReqList(ctx, project) {
  const items = listRequirements({ project, status: 'inbox' });
  const refined = listRequirements({ project, status: 'refined' });
  // v0.14.11: include refined items so the Promote button can act on them.
  // The list rendering itself still keys off the inbox-status items (the
  // original behaviour); refined items are surfaced via the Promote button
  // count and via the /triage flow.
  const promotable = [...items, ...refined].filter(
    (r) => r.status !== 'promoted' && r.status !== 'dropped',
  );
  if (!items.length) {
    const refinedNote = refined.length ? `\n${refined.length} refined items waiting.` : '';
    if (!promotable.length) {
      return ctx.reply(`No inbox items for *${project}*.${refinedNote}`, { parse_mode: 'Markdown' });
    }
    // Refined-only — still let the user promote
    const kb = new InlineKeyboard();
    kb.text(`📋 Promote refined (${promotable.length}) →`, `req:promote-pick:${project}`).row();
    return ctx.reply(`*${project}* — ${promotable.length} refined items ready to promote.${refinedNote}`, {
      parse_mode: 'Markdown',
      reply_markup: kb,
    });
  }
  const kb = new InlineKeyboard();
  const lines = [`*${project}* inbox — ${items.length} item${items.length === 1 ? '' : 's'}:`, ''];
  for (const r of items.slice(0, 20)) { // cap at 20 buttons; Telegram has a limit
    const title = (r.refined_text ? extractTitleFromRefined(r.refined_text) : r.raw_text.split('\n')[0]) || r.raw_text;
    const short = title.length > 40 ? title.slice(0, 37) + '…' : title;
    lines.push(`#${r.id} [${r.priority}/${r.scope}] ${short}`);
    kb.text(`#${r.id}`, `req:show:${r.id}`);
    if (kb.inline_keyboard[kb.inline_keyboard.length - 1].length >= 4) kb.row();
  }
  if (items.length > 20) lines.push(`\n…and ${items.length - 20} more (use CLI: npm run req -- list ${project})`);

  // v0.14.11: batch promote shortcut. Only shown when there's something to
  // promote. Tapping it routes through the destination picker callback.
  if (promotable.length) {
    kb.row();
    kb.text(`📋 Promote all (${promotable.length}) →`, `req:promote-pick:${project}`);
  }

  return ctx.reply(lines.join('\n'), { parse_mode: 'Markdown', reply_markup: kb });
}

function extractTitleFromRefined(refined) {
  try {
    const obj = JSON.parse(refined);
    if (obj.title) return obj.title;
  } catch { /* not JSON */ }
  const m = refined.match(/^#+\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

async function handleReqCallback(ctx, rest, userId) {
  const sub = rest[0];

  if (sub === 'list') {
    const project = rest.slice(1).join(':');
    await ctx.answerCallbackQuery();
    return showReqList(ctx, project);
  }

  if (sub === 'show') {
    const id = Number(rest[1]);
    const r = getRequirement(id);
    if (!r) { return ctx.answerCallbackQuery({ text: `Req #${id} not found`, show_alert: true }); }
    await ctx.answerCallbackQuery();

    let body;
    if (r.refined_text) {
      try {
        const obj = JSON.parse(r.refined_text);
        body = [
          `*${obj.title || '(no title)'}*`,
          '',
          obj.what || '',
          obj.why ? `\n_Why:_ ${obj.why}` : '',
          obj.touches ? `\n_Touches:_ ${obj.touches}` : '',
          obj.open_questions?.length
            ? '\n_Open questions:_\n' + obj.open_questions.map((q) => `• ${q}`).join('\n')
            : '',
        ].filter(Boolean).join('\n');
      } catch {
        body = r.refined_text;
      }
    } else {
      body = r.raw_text;
    }

    const header = `#${r.id} — ${r.project}\n`
      + `Status: ${r.status}  Priority: ${r.priority}  Scope: ${r.scope}`;

    const kb = new InlineKeyboard()
      .text('p0', `req:pri:${id}:p0`).text('p1', `req:pri:${id}:p1`)
      .text('p2', `req:pri:${id}:p2`).text('p3', `req:pri:${id}:p3`).row()
      .text('now', `req:scope:${id}:now`).text('next', `req:scope:${id}:next`)
      .text('later', `req:scope:${id}:later`).text('drop', `req:drop:${id}`).row()
      .text('« back', `req:list:${r.project}`);

    // Escape Markdown chars that might appear in body
    const safe = body.replace(/([*_`[\]])/g, '\\$1');
    return ctx.reply(`${header}\n\n${safe}`, { parse_mode: 'Markdown', reply_markup: kb });
  }

  if (sub === 'pri') {
    const id = Number(rest[1]);
    const value = rest[2];
    if (!VALID_PRIORITIES.includes(value)) {
      return ctx.answerCallbackQuery({ text: 'Bad priority', show_alert: true });
    }
    updateRequirement(id, { priority: value });
    return ctx.answerCallbackQuery({ text: `#${id} priority → ${value}` });
  }

  if (sub === 'scope') {
    const id = Number(rest[1]);
    const value = rest[2];
    if (!VALID_SCOPES.includes(value)) {
      return ctx.answerCallbackQuery({ text: 'Bad scope', show_alert: true });
    }
    updateRequirement(id, { scope: value });
    return ctx.answerCallbackQuery({ text: `#${id} scope → ${value}` });
  }

  if (sub === 'drop') {
    const id = Number(rest[1]);
    updateRequirement(id, { status: 'dropped' });
    return ctx.answerCallbackQuery({ text: `#${id} dropped` });
  }

  // ─── v0.14.11: promote workflow ─────────────────────────────────────────
  if (sub === 'promote-pick') {
    // User tapped "📋 Promote all (N) → " on the inbox list.
    // Show a picker of destination projects (real projects only — _inbox
    // can't receive promotions). Pre-select the last-used destination for
    // this inbox if we have one.
    const inboxProject = rest.slice(1).join(':');
    await ctx.answerCallbackQuery();

    const { listProjects } = await import('../../state.js').catch(() => import('../state.js'));
    const all = listProjects().filter((p) => p.name !== inboxProject);
    if (!all.length) {
      return ctx.reply(`No destination projects available. Register one with /new_project first.`);
    }
    const { getLastInboxDestination } = await import('../commands/req-promote.js');
    const last = getLastInboxDestination(inboxProject);
    const kb = new InlineKeyboard();
    // Last-used first, then others
    const ordered = last
      ? [all.find((p) => p.name === last), ...all.filter((p) => p.name !== last)].filter(Boolean)
      : all;
    for (const p of ordered) {
      const marker = (last && p.name === last) ? '★ ' : '  ';
      kb.text(`${marker}${p.name}`, `req:promote-confirm:${inboxProject}:${p.name}`).row();
    }
    return ctx.reply(
      `Promote refined items from <b>${sanitizeForTelegram(inboxProject)}</b> → which project?\n\n`
      + (last ? `<i>★ = last used (${sanitizeForTelegram(last)})</i>` : ''),
      { parse_mode: 'HTML', reply_markup: kb },
    );
  }

  if (sub === 'promote-confirm') {
    // User picked a destination. Show a two-option confirm: promote only,
    // OR promote and queue an auto-pipeline (brief + guide). The expensive
    // 'go' step stays manual — user must explicitly /run go after reviewing
    // the plan. This intentionally differs from the bug side (which goes
    // straight to a fix run) because reqs touch architecture.
    const inboxProject = rest[1];
    const destProject = rest.slice(2).join(':');
    await ctx.answerCallbackQuery();

    const { listRequirements: list } = await import('../state.js');
    const promotable = [...list({ project: inboxProject, status: 'inbox' }),
                        ...list({ project: inboxProject, status: 'refined' })]
      .filter((r) => r.status !== 'promoted' && r.status !== 'dropped');
    // Of those, how many would actually be promoted (scope=now after auto-scope)?
    const nowItems = promotable.filter((r) => r.scope === 'now');
    const wouldAutoScope = promotable.filter((r) => r.scope === 'unassigned');

    const kb = new InlineKeyboard();
    kb.text(`📝 Promote only (${promotable.length})`, `req:promote-run:${inboxProject}:${destProject}:promote`).row();
    kb.text(`🧭 Promote + brief + guide`, `req:promote-run:${inboxProject}:${destProject}:plan`).row();
    kb.text('✗ Cancel', `req:list:${inboxProject}`);

    const scopeSummary = wouldAutoScope.length
      ? `\n\n<i>${wouldAutoScope.length} item(s) currently scope=unassigned will be set to scope=now before promote (matches /bug_promote behaviour).</i>`
      : '';
    return ctx.reply(
      `<b>Promote ${promotable.length} item(s)</b>\n`
      + `  from: <code>${sanitizeForTelegram(inboxProject)}</code>\n`
      + `  into: <code>${sanitizeForTelegram(destProject)}</code>'s raw-thoughts.md`
      + scopeSummary
      + `\n\n<i>📝 Promote only</i> — just writes the markdown, doesn't queue any jobs.\n`
      + `<i>🧭 Promote + brief + guide</i> — also queues a brief job and a guide job. Stops before 'go'; you review the plan and run <code>/run go ${sanitizeForTelegram(destProject)}</code> manually.`,
      { parse_mode: 'HTML', reply_markup: kb },
    );
  }

  if (sub === 'promote-run') {
    const inboxProject = rest[1];
    const destProject = rest[2];
    const mode = rest[3]; // 'promote' | 'plan'
    await ctx.answerCallbackQuery();

    const { performReqPromote, rememberInboxDestination } = await import('../commands/req-promote.js');
    let result;
    try {
      result = await performReqPromote({
        inboxProject,
        destinationProject: destProject,
        scope: 'now',
        autoScope: true,
      });
    } catch (err) {
      return ctx.reply(`✗ Promote failed: ${sanitizeForTelegram(err.message)}`, { parse_mode: 'HTML' });
    }

    rememberInboxDestination(inboxProject, destProject, userId);

    const relPath = path.relative(REPO_ROOT, result.destinationPath);
    await ctx.reply(
      `📝 <b>Promoted ${result.promoted} requirement(s)</b>\n`
      + `   from: <code>${sanitizeForTelegram(inboxProject)}</code>\n`
      + `   into: <code>${sanitizeForTelegram(destProject)}</code>'s raw-thoughts.md\n\n`
      + `IDs: #${result.ids.join(', #')}\n`
      + `File: <code>${sanitizeForTelegram(relPath)}</code>\n`
      + (mode === 'plan' ? `\n▶ Queueing brief + guide jobs…` : ''),
      { parse_mode: 'HTML' },
    );

    if (mode === 'promote') {
      return ctx.reply(
        `Next: review <code>${sanitizeForTelegram(relPath)}</code>, then run\n`
        + `<code>/run brief ${sanitizeForTelegram(destProject)}</code>`,
        { parse_mode: 'HTML' },
      );
    }

    // mode === 'plan' — enqueue brief, then guide. Both go through the same
    // worker pool as /run, so per-project FIFO applies. enqueueAndReply
    // surfaces the queue context to the user automatically.
    await enqueueAndReply(ctx, {
      project: destProject,
      action: 'brief',
      args: { unattended: true },
      requestedBy: userId,
      prelude: 'Step 1/2 — brief',
    });
    return enqueueAndReply(ctx, {
      project: destProject,
      action: 'guide',
      args: { unattended: true },
      requestedBy: userId,
      prelude: 'Step 2/2 — guide (will queue behind brief)',
    });
  }

  // ─── v0.14.26: coach single-rec callbacks ────────────────────────────────

  if (sub === 'start') {
    const project = rest.slice(1).join(':');
    if (!project || (!getProject(project) && project !== '_inbox')) {
      return ctx.answerCallbackQuery({ text: 'Project not found', show_alert: true });
    }
    setCaptureMode(userId, project);
    await ctx.answerCallbackQuery();
    return ctx.reply(
      `🟢 Capture mode ON for *${project}*.\n\n`
      + `Send your requirements one at a time. Send /done when finished.`,
      { parse_mode: 'Markdown' },
    );
  }

  if (sub === 'capture') {
    const project = rest.slice(1).join(':');
    if (!project || (!getProject(project) && project !== '_inbox')) {
      return ctx.answerCallbackQuery({ text: 'Project not found', show_alert: true });
    }
    setCaptureMode(userId, project);
    await ctx.answerCallbackQuery();
    return ctx.reply(
      `🟢 Capture mode ON for *${project}*.\n\n`
      + `Send your requirements one at a time. Send /done when finished.`,
      { parse_mode: 'Markdown' },
    );
  }

  if (sub === 'promote-plan') {
    const project = rest.slice(1).join(':');
    if (!project || !getProject(project)) {
      return ctx.answerCallbackQuery({ text: 'Project not found', show_alert: true });
    }
    await ctx.answerCallbackQuery();
    const { performReqPromote } = await import('../commands/req-promote.js');
    let result;
    try {
      result = await performReqPromote({
        inboxProject: project,
        destinationProject: project,
        scope: 'now',
        autoScope: true,
      });
    } catch (err) {
      return ctx.reply(`✗ Promote failed: ${sanitizeForTelegram(err.message)}`, { parse_mode: 'HTML' });
    }
    const relPath = path.relative(REPO_ROOT, result.destinationPath);
    await ctx.reply(
      `📝 <b>Promoted ${result.promoted} requirement(s)</b>\n`
      + `   into: <code>${sanitizeForTelegram(project)}</code>'s raw-thoughts.md\n\n`
      + `IDs: #${result.ids.join(', #')}\n`
      + `File: <code>${sanitizeForTelegram(relPath)}</code>\n\n`
      + `▶ Queueing brief + guide jobs…`,
      { parse_mode: 'HTML' },
    );
    await enqueueAndReply(ctx, {
      project,
      action: 'brief',
      args: { unattended: true },
      requestedBy: userId,
      prelude: 'Step 1/2 — brief',
    });
    return enqueueAndReply(ctx, {
      project,
      action: 'guide',
      args: { unattended: true },
      requestedBy: userId,
      prelude: 'Step 2/2 — guide (will queue behind brief)',
    });
  }

  return ctx.answerCallbackQuery({ text: 'Unknown req action' });
}

// ─── Generic text-message handler (capture mode router) ─────────────────────

export async function handleMessage(ctx) {
  const userId = ctx.from?.id;
  if (!userId || !isAllowlisted(userId)) return;
  const text = ctx.message?.text;
  if (!text || text.startsWith('/')) return; // commands handled by their own handlers

  // Route to active suggest session if it's awaiting freetext input
  const chatId = ctx.chat?.id;
  if (chatId) {
    const session = suggestSessions.get(chatId);
    // Only route to the session owner. In a group chat (chatId ≠ userId), another member's
    // message must not satisfy a pending capture for a different user's session.
    const isOwner = !session?.userId || session.userId === userId;
    if (isOwner && session?.awaitingInput === 'goal') {
      const { handleSuggestGoalInput } = await import('./telegram-parity-handlers.js');
      return handleSuggestGoalInput(ctx, text.trim(), session);
    }
    if (isOwner && session?.awaitingInput === 'manual') {
      const { handleSuggestManualInput } = await import('./telegram-parity-handlers.js');
      return handleSuggestManualInput(ctx, text.trim(), session);
    }
  }

  const mode = getCaptureMode(userId);
  if (!mode) return; // no capture mode active, ignore (don't reply)

  const trimmed = text.trim();
  if (mode.kind === 'bug') {
    // Guard: reject obvious non-bug content that ends up in capture mode
    // accidentally (shell commands typed without /done, emoji-only messages,
    // very short gibberish). These pollute the bug inbox with unactionable rows.
    const isShellCommand = /^(npm|node|npx|git|bash|sh|cd|ls|cat|echo|curl|wget)\s/i.test(trimmed);
    const isEmojiOnly    = /^[\p{Emoji}\s]+$/u.test(trimmed) && trimmed.replace(/\s/g, '').length <= 4;
    const isTooShort     = trimmed.length < 8;
    if (isShellCommand || isEmojiOnly || isTooShort) {
      return ctx.reply(
        `⚠ That doesn't look like a bug report.\n\n` +
        `Send /done to exit bug capture mode, or describe the bug in plain text:\n` +
        `<i>e.g. "Login fails when email has uppercase letters"</i>`,
        { parse_mode: 'HTML' },
      );
    }

    // Bug capture — support inline severity prefix ("critical: ...", "major: ...")
    const m = trimmed.match(/^(critical|major|minor)\s*[:|-]\s*(.+)$/i);
    const severity = m ? m[1].toLowerCase() : 'unassigned';
    const body = m ? m[2].trim() : trimmed;
    const { addBug } = await import('../state.js');
    const id = addBug({
      project: mode.project,
      raw_text: body,
      severity,
      source: 'telegram',
      reported_by: userId,
    });
    const sevEmoji = severity === 'critical' ? '🔴' : severity === 'major' ? '🟠' : severity === 'minor' ? '🟡' : '⚪';
    if (severity === 'critical') {
      // Offer fast-path immediate run
      const kb = new InlineKeyboard()
        .text('🚨 Run bug-fix now', `bug:promote:${mode.project}:${id}:run`).row()
        .text('📋 Add to next round', `bug:promote:${mode.project}:${id}:queue`).row()
        .text('Just save', `bug:promote:${mode.project}:${id}:save`);
      return ctx.reply(
        `${sevEmoji} <b>Critical bug #${id} saved to ${mode.project}</b>\n\n` +
        `<i>${sanitizeForTelegram(body.slice(0, 200))}</i>\n\n` +
        `Run bug-fix immediately?`,
        { parse_mode: 'HTML', reply_markup: kb },
      );
    }
    return ctx.reply(`${sevEmoji} Bug #${id} (${severity}) saved to ${mode.project}.`);
  }

  // Default: requirement capture
  const id = addRequirement({
    project: mode.project,
    raw_text: trimmed,
    source: 'telegram',
    created_by: userId,
  });
  return ctx.reply(`✓ #${id} saved to ${mode.project}.`);
}

// ─── Triage autopilot (Telegram) ────────────────────────────────────────────
//
// /triage <project>  → show first inbox item with inline priority + scope buttons
// Tapping scope auto-advances. Tapping priority just sets it.
// Stateless: callback data encodes (id, action, value, project).

export const handleTriage = requireAuth(async (ctx) => {
  const matchArg = (ctx.match || '').trim();
  const text = ctx.message?.text || '';
  const arg = matchArg || text.replace(/^\/triage(@\w+)?\s*/i, '').trim();
  const args = arg ? arg.split(/\s+/) : [];
  const project = await resolveProject(ctx, args);
  if (!project) return; // picker shown
  if (project !== '_inbox' && !getProject(project)) {
    return ctx.reply(`Project not found: ${project}`);
  }
  return showNextTriageItem(ctx, project, null);
});

async function showNextTriageItem(ctx, project, afterId) {
  const all = listRequirements({ project, status: 'inbox' });
  const refined = listRequirements({ project, status: 'refined' });
  const items = [...all, ...refined];
  // Pick the next item after afterId, or the first one
  let next;
  if (afterId != null) {
    const idx = items.findIndex((r) => r.id === afterId);
    next = idx >= 0 ? items[idx + 1] : items[0];
  } else {
    next = items[0];
  }
  if (!next) {
    return ctx.reply(`✓ Inbox empty for *${project}*. ${all.length === 0 && refined.length === 0 ? 'Nothing to triage.' : 'All items processed in this session.'}`, { parse_mode: 'Markdown' });
  }
  return renderTriageItem(ctx, next, items.length, items.findIndex((r) => r.id === next.id));
}

async function renderTriageItem(ctx, req, total, idx) {
  const title = req.refined_text ? (extractTitleFromRefined(req.refined_text) || '') : '';
  const titleLine = title ? `*${escapeMd(title)}*\n` : '';

  let body = req.raw_text;
  if (req.refined_text) {
    try {
      const obj = JSON.parse(req.refined_text);
      const parts = [];
      if (obj.what) parts.push(obj.what);
      if (obj.why) parts.push(`_Why:_ ${obj.why}`);
      if (obj.touches) parts.push(`_Touches:_ ${obj.touches}`);
      body = parts.join('\n');
    } catch { /* not JSON */ }
  }

  const header = `Triage — *${escapeMd(req.project)}*  •  item ${idx + 1} of ${total}\n`
    + `\\#${req.id}  •  priority \\= ${req.priority}  •  scope \\= ${req.scope}`;

  const text = `${header}\n\n${titleLine}${escapeMd(body)}`;

  const project = req.project;
  const kb = new InlineKeyboard()
    .text(req.priority === 'p0' ? '✓ p0' : 'p0', `triage:pri:${req.id}:p0:${project}`)
    .text(req.priority === 'p1' ? '✓ p1' : 'p1', `triage:pri:${req.id}:p1:${project}`)
    .text(req.priority === 'p2' ? '✓ p2' : 'p2', `triage:pri:${req.id}:p2:${project}`)
    .text(req.priority === 'p3' ? '✓ p3' : 'p3', `triage:pri:${req.id}:p3:${project}`).row()
    .text('▶ now', `triage:scope:${req.id}:now:${project}`)
    .text('next', `triage:scope:${req.id}:next:${project}`)
    .text('later', `triage:scope:${req.id}:later:${project}`)
    .text('no', `triage:scope:${req.id}:no:${project}`).row()
    .text('skip ⇢', `triage:skip:${req.id}:${project}`)
    .text('drop ✗', `triage:drop:${req.id}:${project}`)
    .text('done', `triage:done:${project}`);

  return ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup: kb });
}

function escapeMd(s) {
  // MarkdownV2 special-char escape
  return String(s).replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

async function handleTriageCallback(ctx, rest, userId) {
  const sub = rest[0];

  if (sub === 'pri') {
    const id = Number(rest[1]);
    const value = rest[2];
    const project = rest.slice(3).join(':');
    if (!['p0', 'p1', 'p2', 'p3'].includes(value)) {
      return ctx.answerCallbackQuery({ text: 'Bad priority', show_alert: true });
    }
    updateRequirement(id, { priority: value });
    await ctx.answerCallbackQuery({ text: `#${id} priority → ${value}` });
    // Re-render same item with updated highlight (don't advance — priority alone doesn't advance)
    const updated = getRequirement(id);
    if (updated) {
      // Edit the original message to reflect the new priority
      try {
        await editTriageMessage(ctx, updated, project);
      } catch { /* if edit fails, just leave it; the callback toast already confirmed */ }
    }
    return;
  }

  if (sub === 'scope') {
    const id = Number(rest[1]);
    const value = rest[2];
    const project = rest.slice(3).join(':');
    if (!['now', 'next', 'later', 'no'].includes(value)) {
      return ctx.answerCallbackQuery({ text: 'Bad scope', show_alert: true });
    }
    updateRequirement(id, { scope: value });
    await ctx.answerCallbackQuery({ text: `#${id} → ${value}` });
    return showNextTriageItem(ctx, project, id);
  }

  if (sub === 'skip') {
    const id = Number(rest[1]);
    const project = rest.slice(2).join(':');
    await ctx.answerCallbackQuery({ text: `#${id} skipped` });
    return showNextTriageItem(ctx, project, id);
  }

  if (sub === 'drop') {
    const id = Number(rest[1]);
    const project = rest.slice(2).join(':');
    updateRequirement(id, { status: 'dropped' });
    await ctx.answerCallbackQuery({ text: `#${id} dropped` });
    return showNextTriageItem(ctx, project, id);
  }

  if (sub === 'done') {
    await ctx.answerCallbackQuery({ text: 'Triage ended' });
    return ctx.reply('✓ Triage ended.');
  }

  return ctx.answerCallbackQuery({ text: `Unknown triage action: ${sub}` });
}

async function editTriageMessage(ctx, req, project) {
  // Rebuild keyboard with new highlight on priority row
  const kb = new InlineKeyboard()
    .text(req.priority === 'p0' ? '✓ p0' : 'p0', `triage:pri:${req.id}:p0:${project}`)
    .text(req.priority === 'p1' ? '✓ p1' : 'p1', `triage:pri:${req.id}:p1:${project}`)
    .text(req.priority === 'p2' ? '✓ p2' : 'p2', `triage:pri:${req.id}:p2:${project}`)
    .text(req.priority === 'p3' ? '✓ p3' : 'p3', `triage:pri:${req.id}:p3:${project}`).row()
    .text('▶ now', `triage:scope:${req.id}:now:${project}`)
    .text('next', `triage:scope:${req.id}:next:${project}`)
    .text('later', `triage:scope:${req.id}:later:${project}`)
    .text('no', `triage:scope:${req.id}:no:${project}`).row()
    .text('skip ⇢', `triage:skip:${req.id}:${project}`)
    .text('drop ✗', `triage:drop:${req.id}:${project}`)
    .text('done', `triage:done:${project}`);
  await ctx.editMessageReplyMarkup({ reply_markup: kb });
}

// ─── Help system ────────────────────────────────────────────────────────────
//
// /help            → categorized command overview
// /help <topic>    → deep dive for a feature area
//
// Topics: status, run, req, capture, triage, inbox, validators, predict,
//         qa, docs, auth, users, all

const HELP_TOPICS = {
  overview: {
    title: 'Overview',
    body:
      `<b>Most useful day-to-day:</b>\n` +
      `  /status — current run + queue\n` +
      `  /projects — list projects\n` +
      `  /project &lt;name&gt; — project detail\n` +
      `  /run &lt;project&gt; &lt;action&gt; — start work\n` +
      `  /cancel — stop current job\n` +
      `  /queue — show pending jobs\n` +
      `  /history — recent jobs\n` +
      `\n` +
      `<b>Reading artifacts away from PC:</b>\n` +
      `  /files &lt;project&gt; — index of all readable artifacts\n` +
      `  /preview &lt;project&gt; &lt;artifact&gt; — read inline\n` +
      `  /file &lt;project&gt; &lt;artifact&gt; — DM as .md file\n` +
      `\n` +
      `<b>Requirements inbox:</b>\n` +
      `  /req — capture / list\n` +
      `  /capture &lt;project&gt; — multi-message capture\n` +
      `  /done — exit capture mode\n` +
      `  /inbox [&lt;project&gt;] — browse + triage\n` +
      `  /triage &lt;project&gt; — fast tap-to-triage\n` +
      `\n` +
      `<b>Bug inbox:</b>\n` +
      `  /bug &lt;project&gt; &lt;text&gt; — capture bug\n` +
      `  /bug &lt;project&gt; critical: &lt;text&gt; — fast-path critical\n` +
      `  /bug_capture &lt;project&gt; — multi-message bug capture\n` +
      `  /bug_done — exit capture\n` +
      `  /bugs_inbox [&lt;project&gt;] — review pending bugs\n` +
      `  /bug_promote &lt;project&gt; — create new bug round\n` +
      `\n` +
      `<b>Files &amp; docs:</b>\n` +
      `  /download &lt;project&gt; — DM project zip\n` +
      `  /docs — DM the orchestrator docs zip\n` +
      `\n` +
      `<b>Git:</b>\n` +
      `  /sync &lt;project&gt; — pull latest from origin (ff-only)\n` +
      `  /syncall — pull latest for <i>all</i> git-managed projects\n` +
      `  /git_status &lt;project&gt; — show branch + sync status\n` +
      `  /ship &lt;project&gt; — fast-forward main to develop\n` +
      `\n` +
      `<b>Admin:</b>\n` +
      `  /users — show allowlist\n` +
      `  /auth &lt;code&gt; — authorize a new user\n` +
      `\n` +
      `<b>For deep dives:</b>\n` +
      `  /help req — requirements inbox\n` +
      `  /help triage — fast triage\n` +
      `  /help run — run actions\n` +
      `  /help preview — reading artifacts\n` +
      `  /help validators — auto-validation\n` +
      `  /help predict — cost prediction\n` +
      `  /help qa — QA handoff\n` +
      `  /help docs — pulling docs offline\n`,
  },

  preview: {
    title: 'Reading artifacts from anywhere',
    body:
      `Three commands for inspecting generated files without sshing into the Mac:\n` +
      `\n` +
      `<b>/files &lt;project&gt;</b>\n` +
      `Lists everything readable — briefs, plans, audits, roadmaps, phase reports, ` +
      `bug rounds, fix reports, reviews, QA handoffs — with shortcut names.\n` +
      `\n` +
      `<b>/preview &lt;project&gt; &lt;artifact&gt;</b>\n` +
      `Reads the file inline. Long files split into multiple messages.\n` +
      `\n` +
      `<b>/file &lt;project&gt; &lt;artifact&gt;</b>\n` +
      `DMs the .md file as a Document. Phone's markdown preview opens it cleanly.\n` +
      `\n` +
      `<b>Shortcut grammar:</b>\n` +
      `  <code>brief</code>, <code>plan</code>, <code>raw-thoughts</code>, <code>project-context</code>\n` +
      `  <code>audit</code> — latest audit\n` +
      `  <code>roadmap</code> — latest roadmap\n` +
      `  <code>phase:&lt;n&gt;</code> — phase n report\n` +
      `  <code>bugs:&lt;n&gt;</code> — bugs.md for round n\n` +
      `  <code>plan:&lt;n&gt;</code> — fix plan for round n\n` +
      `  <code>fix:&lt;n&gt;:&lt;m&gt;</code> — fix m in round n report\n` +
      `  <code>review:&lt;n&gt;</code> — review after phase n\n` +
      `  <code>qa</code> — latest QA handoff\n` +
      `  <code>qa:&lt;n&gt;</code> — latest QA handoff for round n\n` +
      `\n` +
      `<b>Examples:</b>\n` +
      `  <code>/preview billflow-tds roadmap</code>\n` +
      `  <code>/preview billflow-tds fix:4:13</code>\n` +
      `  <code>/file billflow-tds qa:3</code>\n`,
  },

  'bugs-inbox': {
    title: 'Bug inbox',
    body:
      `Capture bugs as you find them and promote them into a bug round when ready. Parallel to the requirements inbox but with severity-based urgency.\n` +
      `\n` +
      `<b>One-off capture:</b>\n` +
      `  <code>/bug &lt;project&gt; &lt;text&gt;</code>\n` +
      `  <code>/bug &lt;text&gt;</code>                    — uses pinned project\n` +
      `  <code>/bug &lt;project&gt; critical: &lt;text&gt;</code>  — inline severity\n` +
      `  <code>/bug &lt;project&gt; major: &lt;text&gt;</code>\n` +
      `  <code>/bug &lt;project&gt; minor: &lt;text&gt;</code>\n` +
      `\n` +
      `Critical bugs prompt for immediate run with [🚨 Run now / 📋 Queue / Just save].\n` +
      `\n` +
      `<b>Multi-message capture:</b>\n` +
      `  <code>/bug_capture &lt;project&gt;</code> — every message becomes a bug; use severity prefixes\n` +
      `  <code>/bug_done</code> — exit\n` +
      `\n` +
      `<b>Review &amp; promote:</b>\n` +
      `  <code>/bugs_inbox [&lt;project&gt;]</code> — list pending, grouped by severity\n` +
      `  <code>/bug_promote &lt;project&gt;</code> — create new bug round from all pending\n` +
      `  <code>/bug_promote &lt;project&gt; --critical</code> — only criticals, auto-run\n` +
      `\n` +
      `<b>CLI:</b>\n` +
      `  <code>npm run bug -- list &lt;project&gt;</code>\n` +
      `  <code>npm run bug -- refine &lt;project&gt;</code> — AI-structure raw texts into repro/expected/files\n` +
      `  <code>npm run bug -- promote --ids 3,5,8 --run &lt;project&gt;</code>\n` +
      `  <code>npm run bug -- stats &lt;project&gt;</code>\n` +
      `\n` +
      `<b>The full chain:</b>\n` +
      `  audit → bug inbox → refine → promote → bug round → fix → QA handoff → ship\n`,
  },

  status: {
    title: 'Status & queue',
    body:
      `<b>/status</b>\n` +
      `Shows current 5h call window, project budgets, and queue state.\n` +
      `\n` +
      `<b>/projects</b>\n` +
      `Lists every project with status and current_phase / total_phases.\n` +
      `\n` +
      `<b>/project &lt;name&gt;</b>\n` +
      `Detail for one project: phase counter, last auto-run status, pause reason if any, recent calls.\n` +
      `\n` +
      `<b>/queue</b>\n` +
      `Shows pending jobs (FIFO order) and the currently-running job if any.\n` +
      `\n` +
      `<b>/history</b>\n` +
      `Last 20 jobs: who ran what, when, status, duration.\n` +
      `\n` +
      `<b>/cancel</b>\n` +
      `Hard-cancels the currently-running job. SIGTERM to the claude subprocess. ` +
      `Any in-progress dev work is dropped at that point but workspace git history stays intact.\n`,
  },

  run: {
    title: 'Running actions',
    body:
      `<b>/run &lt;project&gt; &lt;action&gt;</b>\n` +
      `Enqueue an action. If queue is idle, it starts immediately.\n` +
      `\n` +
      `<b>Actions:</b>\n` +
      `  <code>go</code> — auto-run plan → phases → reviews → completion\n` +
      `  <code>resume</code> — pick up where the last run left off\n` +
      `  <code>audit</code> — full-stack audit (LLM reads workspace, lists findings)\n` +
      `  <code>audit --auto</code> — audit, then auto-promote findings → bug round → run every fix unattended; repeat with <code>--rounds N</code> (re-audits between rounds). Or just tap 🔍 Audit and pick "Auto ×N".\n` +
      `  <code>bugs</code> — bug-fix cycle: bug-plan → fix-prompts → fix-executions\n` +
      `  <code>pipeline</code> — full autopilot: intake → brief → build → fixes → QA, stops at the ship gate. <code>--rounds N</code>, <code>--stop-after brief|build|fixes|qa</code>. Or tap 🚀 Full pipeline.\n` +
      `  <code>roadmap</code> — generate a roadmap document\n` +
      `  <code>ship</code> — final checks + package\n` +
      `  <code>reset-brief</code> — refresh .guide/brief.md from inputs/, archive old plan, rewind to phase 0 (or /newbrief)\n` +
      `\n` +
      `<b>Examples:</b>\n` +
      `  <code>/run billflow-tds go</code>\n` +
      `  <code>/run billflow-tds resume</code>\n` +
      `  <code>/run reelchain audit</code>\n` +
      `  <code>/run orchestrator audit --auto</code>\n` +
      `  <code>/run orchestrator audit --auto --rounds 3</code>\n` +
      `  <code>/run orchestrator pipeline --rounds 2</code>\n` +
      `\n` +
      `<b>Notifications:</b>\n` +
      `The bot DMs you at every checkpoint and on completion. You don't need to keep polling /status.\n`,
  },

  req: {
    title: 'Requirements inbox',
    body:
      `Capture raw thoughts now, triage later, promote to a project's brief when ready.\n` +
      `\n` +
      `<b>Capture:</b>\n` +
      `  <code>/req &lt;project&gt; &lt;text&gt;</code> — one-shot capture into a project\n` +
      `  <code>/req &lt;text&gt;</code> — capture into the _inbox virtual project\n` +
      `  <code>/capture &lt;project&gt;</code> — enter multi-message mode. Every subsequent message becomes a requirement.\n` +
      `  <code>/done</code> — exit capture mode\n` +
      `\n` +
      `<b>Browse &amp; triage:</b>\n` +
      `  <code>/inbox</code> — list projects that have requirements\n` +
      `  <code>/inbox &lt;project&gt;</code> — browse a project's inbox, tap to triage one at a time. Includes a <b>📋 Promote all (N) →</b> button for batch flow.\n` +
      `  <code>/triage &lt;project&gt;</code> — fast triage with auto-advance (see /help triage)\n` +
      `\n` +
      `<b>States:</b> inbox → refined → promoted (or dropped)\n` +
      `<b>Priority:</b> p0 / p1 / p2 / p3\n` +
      `<b>Scope:</b> now / next / later / no\n` +
      `\n` +
      `<b>Promote (Telegram, v0.14.11+):</b>\n` +
      `  <code>/req_promote &lt;inbox&gt; &lt;destination&gt;</code> — auto-flips unassigned items to scope=now, promotes into &lt;destination&gt;'s raw-thoughts.md, remembers the destination for next time.\n` +
      `  <code>/req_promote &lt;inbox&gt;</code> — uses last-used destination (or shows picker on first run).\n` +
      `  <code>/req_promote &lt;inbox&gt; &lt;destination&gt; --plan</code> — also queues brief + guide jobs. Stops before 'go'; run <code>/run go &lt;destination&gt;</code> manually after reviewing the plan.\n` +
      `\n` +
      `<b>Promote (CLI on Mac):</b>\n` +
      `  <code>npm run req -- promote-to &lt;inbox&gt; &lt;destination&gt;</code> — same behavior as the Telegram fast lane.\n` +
      `  <code>npm run req -- promote --scope now &lt;project&gt;</code> — original promote (requires &lt;project&gt; to be a real project, not _inbox).\n` +
      `\n` +
      `<b>Refine:</b>\n` +
      `  <code>npm run req -- refine &lt;project&gt;</code> — Sonnet structures raw text into {title, what, why, touches, open_questions}. Works on _inbox (v0.14.12+) and real projects.\n` +
      `\n` +
      `<b>Pattern hint:</b> for roadmap items that already belong to a known project, use <code>--to-inbox &lt;project&gt;</code> (the project itself, not <code>_inbox</code>) when accepting a roadmap. Items land directly under that project where refine/promote work without an extra hop.\n`,
  },

  capture: {
    title: 'Capture mode',
    body:
      `<code>/capture &lt;project&gt;</code> puts you in capture mode for that project.\n` +
      `\n` +
      `In capture mode, <b>every regular message</b> you send the bot becomes a requirement attached to that project. No need to prefix with /req each time.\n` +
      `\n` +
      `Useful for braindumps when ideas are flowing — just type them in.\n` +
      `\n` +
      `<b>To exit:</b> <code>/done</code>  (or restart capture for a different project: <code>/capture &lt;other&gt;</code>)\n` +
      `\n` +
      `<b>To bypass capture for one message:</b> use a / command — they always route to their handler, not the inbox.\n`,
  },

  triage: {
    title: 'Fast triage',
    body:
      `<code>/triage &lt;project&gt;</code> shows one inbox item at a time with inline-keyboard buttons.\n` +
      `\n` +
      `<b>Per item:</b>\n` +
      `  [ p0 ] [ p1 ] [ p2 ] [ p3 ]    ← priority buttons\n` +
      `  [▶now] [next] [later] [no]     ← scope buttons (auto-advance)\n` +
      `  [skip⇢] [drop✗] [done]\n` +
      `\n` +
      `<b>Tap economics:</b>\n` +
      `  • Tap a <b>scope</b> button → saves and auto-advances. 1 tap per item.\n` +
      `  • Tap a <b>priority</b> first (optional) → highlighted with ✓, no advance. Then tap scope. 2 taps.\n` +
      `  • <b>skip</b> → advance without saving\n` +
      `  • <b>drop</b> → status=dropped, advance\n` +
      `  • <b>done</b> → exit triage\n` +
      `\n` +
      `When the inbox is empty, the bot replies <i>"✓ Inbox empty for &lt;project&gt;"</i>.\n`,
  },

  inbox: {
    title: 'Inbox browsing',
    body:
      `<code>/inbox</code> — lists every project that has requirements + counts by status\n` +
      `<code>/inbox &lt;project&gt;</code> — browse one project's inbox, item-by-item\n` +
      `\n` +
      `This is the slower one-at-a-time view. For speed, use <code>/triage &lt;project&gt;</code>.\n` +
      `\n` +
      `Tap an item to expand it. Buttons let you set priority, set scope, drop, or jump back.\n`,
  },

  validators: {
    title: 'Validators',
    body:
      `External validator scripts run automatically after every dev/fix execution. Failure pauses the auto-run.\n` +
      `\n` +
      `<b>From Telegram — read-only:</b>\n` +
      `Validators don't have direct bot commands. See the results via:\n` +
      `  <code>/project &lt;name&gt;</code> — shows recent validator runs\n` +
      `  Auto-run pause messages include the validator that failed\n` +
      `\n` +
      `<b>CLI (on Mac):</b>\n` +
      `<code>npm run validate -- &lt;project&gt; --all</code>\n` +
      `<code>npm run validate -- &lt;project&gt; --fix 4.2</code>\n` +
      `<code>npm run validators -- &lt;project&gt;</code> — history\n` +
      `\n` +
      `<b>Configuration:</b> <code>projects/&lt;name&gt;/validators.json</code> + <code>validators/*.sh</code>\n` +
      `\n` +
      `See <code>docs/NEW_FEATURES.md</code> §Validators for full details.\n`,
  },

  predict: {
    title: 'Cost prediction',
    body:
      `Predicts cost of upcoming work from historical averages in the calls table.\n` +
      `\n` +
      `<b>Auto-integrated into /run go and /run resume:</b>\n` +
      `Before kickoff, you'll see a prediction table + budget impact. The bot proceeds automatically when predicted cost is low; for ≥ $1 or budget-exceeding runs you get a confirmation prompt.\n` +
      `\n` +
      `<b>CLI (on Mac):</b>\n` +
      `<code>npm run predict -- &lt;project&gt;</code> — standalone\n` +
      `<code>npm run go -- &lt;project&gt; --no-predict</code> — skip\n` +
      `<code>npm run go -- &lt;project&gt; --yes</code> — auto-confirm\n` +
      `\n` +
      `Accuracy improves as call history grows. First few runs use hardcoded fallback estimates marked with ~ in the output.\n`,
  },

  qa: {
    title: 'QA handoff',
    body:
      `Generates a tester-friendly markdown checklist from bugs.md + fix reports + validator runs.\n` +
      `\n` +
      `<b>CLI (on Mac — not yet a bot command):</b>\n` +
      `<code>npm run qa-handoff -- &lt;project&gt;</code> — most recent bug round\n` +
      `<code>npm run qa-handoff -- &lt;project&gt; --round 4</code>\n` +
      `<code>npm run qa-handoff -- &lt;project&gt; --phases 1:8</code>\n` +
      `<code>npm run qa-handoff -- &lt;project&gt; --with-steps</code> — adds LLM-generated manual test procedures (~$1-2)\n` +
      `\n` +
      `Output lands at <code>.guide/qa-handoffs/qa-handoff-&lt;scope&gt;-&lt;ts&gt;.md</code>.\n` +
      `\n` +
      `<b>From Telegram:</b>\n` +
      `Generate on Mac, then <code>/download &lt;project&gt;</code> to get the zip (handoff is included under .guide/qa-handoffs/).\n`,
  },

  docs: {
    title: 'Pulling docs offline',
    body:
      `<b>/docs</b> — DMs you the full orchestrator docs zip. Includes:\n` +
      `  • <code>docs/RUNBOOK.md</code> — day-to-day usage\n` +
      `  • <code>docs/NEW_FEATURES.md</code> — every feature shipped v0.7-v0.11\n` +
      `  • <code>docs/ARCHITECTURE.md</code>\n` +
      `  • <code>docs/MODEL_ROUTING.md</code>\n` +
      `  • <code>docs/TELEGRAM_BOT.md</code>\n` +
      `  • <code>docs/AUTO_RUN.md</code>, <code>GUIDE_LAYOUT.md</code>, <code>PROMPT_DESIGN.md</code>, <code>AUDIT_BRIEF_ROADMAP.md</code>\n` +
      `  • <code>CHANGELOG.md</code>\n` +
      `\n` +
      `Open the zip on your phone, extract, read the .md files in any markdown viewer (or just use Files / Telegram's preview).\n` +
      `\n` +
      `Docs are point-in-time — they reflect the orchestrator version currently installed on the host. Re-run /docs after upgrades.\n`,
  },

  auth: {
    title: 'Authorization',
    body:
      `<b>/auth &lt;code&gt;</b> — authorize yourself with a one-time code\n` +
      `\n` +
      `<b>Flow (for adding a new user):</b>\n` +
      `1. On the orchestrator host: <code>npm run bot-auth-code -- --label "Alice"</code>\n` +
      `2. It prints a 6-character code (exits immediately — codes persist in SQLite as of v0.11.1)\n` +
      `3. The new user sends <code>/auth ABC123</code> to this bot\n` +
      `4. Bot replies "✓ You are now authorized"\n` +
      `\n` +
      `Codes expire in 15 minutes. Single-use. Server must be running when /auth is sent.\n`,
  },

  users: {
    title: 'Allowlist',
    body:
      `<b>/users</b> — shows everyone currently allowlisted\n` +
      `\n` +
      `<b>Add a user:</b> see /help auth\n` +
      `<b>Remove a user (CLI only):</b> <code>npm run bot-users -- --remove &lt;telegram_user_id&gt;</code>\n` +
      `\n` +
      `The allowlist is enforced on every command. Unauthorized users see the /start welcome.\n`,
  },
};

export const handleHelp = requireAuth(async (ctx) => {
  const topic = (ctx.match || '').trim().toLowerCase();
  if (!topic) {
    // v0.14.18: button TOC instead of a single overview dump. Mobile-friendly
    // navigation through the existing HELP_TOPICS map. The overview body is
    // still reachable via the "Overview" button.
    const kb = new InlineKeyboard();
    const keys = Object.keys(HELP_TOPICS);
    // Always lead with overview; layout the rest two-per-row.
    kb.text('📖 Overview', 'help:t:overview').row();
    const rest = keys.filter((k) => k !== 'overview');
    for (let i = 0; i < rest.length; i += 2) {
      kb.text(rest[i], `help:t:${rest[i]}`);
      if (rest[i + 1]) kb.text(rest[i + 1], `help:t:${rest[i + 1]}`);
      kb.row();
    }
    return ctx.reply(
      `<b>📖 Help</b>\n\nPick a topic, or send <code>/help &lt;topic&gt;</code> directly:`,
      { parse_mode: 'HTML', reply_markup: kb },
    );
  }
  const t = HELP_TOPICS[topic];
  if (!t) {
    const available = Object.keys(HELP_TOPICS).filter((k) => k !== 'overview').join(', ');
    return ctx.reply(
      `Unknown help topic: <code>${topic}</code>\n\n` +
      `Available: ${available}\n\n` +
      `Or send <code>/help</code> with no argument for the button TOC.`,
      { parse_mode: 'HTML' },
    );
  }
  return ctx.reply(`<b>📖 ${t.title}</b>\n\n${t.body}`, { parse_mode: 'HTML' });
});

// ─── /docs — DM the orchestrator docs zip ───────────────────────────────────

export const handleDocs = requireAuth(async (ctx) => {
  await ctx.reply('📦 Packaging docs… one moment.');
  try {
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const { execSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const REPO_ROOT = path.resolve(__dirname, '..', '..');
    const OUT_DIR = path.join(REPO_ROOT, 'outputs');
    await fs.mkdir(OUT_DIR, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const zipName = `orchestrator-docs-${ts}.zip`;
    const zipPath = path.join(OUT_DIR, zipName);

    // Build zip from docs/ + top-level CHANGELOG.md + README.md (if present)
    // Using system `zip` for consistency with package-project.js
    const parts = ['docs', 'CHANGELOG.md'];
    try { await fs.access(path.join(REPO_ROOT, 'README.md')); parts.push('README.md'); } catch { /* skip */ }
    try { await fs.access(path.join(REPO_ROOT, 'CLAUDE.md')); parts.push('CLAUDE.md'); } catch { /* skip */ }

    execSync(`zip -rq "${zipPath}" ${parts.map((p) => `"${p}"`).join(' ')}`, {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stat = await fs.stat(zipPath);
    const sizeMB = stat.size / 1024 / 1024;

    const { InputFile } = await import('grammy');
    await ctx.replyWithDocument(new InputFile(zipPath), {
      caption: `${zipName} (${sizeMB.toFixed(2)} MB)\n` +
        `Includes: docs/, CHANGELOG.md${parts.includes('README.md') ? ', README.md' : ''}${parts.includes('CLAUDE.md') ? ', CLAUDE.md' : ''}\n` +
        `Generated: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
    });
  } catch (err) {
    return ctx.reply(`✗ Failed to package docs: ${err.message}`);
  }
});

// ─── Next-actions inline keyboard callbacks ─────────────────────────────────
//
// Callback data shape:
//   na:exec:<idx>:<project>|<lastAction>
//   na:more:<project>|<lastAction>
//
// On exec tap: we regenerate the action list for that context, look up the
// indexed action, and either fire it (if it's a Telegram-routable command like
// /preview, /run) or show the CLI command for copy-paste.
//
// On more tap: we send the FULL list as a follow-up message.

async function handleNextActionsCallback(ctx, rest, userId) {
  const sub = rest[0];
  if (sub === 'exec') {
    const idx = Number(rest[1]);
    const contextId = rest.slice(2).join(':');
    const [project, lastAction] = contextId.split('|');
    const { getNextActions } = await import('../lib/next-actions.js');
    // Reconstruct state minimally
    const { getProject } = await import('../state.js');
    const proj = getProject(project);
    const state = {
      currentPhase: proj?.current_phase,
      totalPhases: proj?.total_phases,
    };
    const actions = getNextActions({ project, lastAction, state });
    const action = actions[idx];
    if (!action) {
      return ctx.answerCallbackQuery({ text: 'Action no longer available', show_alert: true });
    }
    if (action.type === 'telegram') {
      // Fire the command by simulating the user sending it as a message.
      // We can't truly /simulate a command (grammy doesn't expose that),
      // so instead we DM the command back so the user can tap it (Telegram
      // turns /commands into tappable links) — OR we route directly when
      // it's a well-known command we control.
      await ctx.answerCallbackQuery({ text: `${action.label}` });
      // Tappable command suggestion. Telegram renders /commands as tap-to-send links.
      return ctx.reply(
        `Send this command to fire:\n\n<code>${action.cmd}</code>\n\n` +
        `<i>Or tap-and-hold to copy.</i>`,
        { parse_mode: 'HTML' },
      );
    } else if (action.type === 'cli') {
      await ctx.answerCallbackQuery({ text: 'CLI command' });
      return ctx.reply(
        `Run on your Mac:\n\n<code>${action.cmd}</code>\n\n` +
        (action.description ? `<i>${action.description}</i>\n\n` : '') +
        `<i>Tap-and-hold to copy.</i>`,
        { parse_mode: 'HTML' },
      );
    }
    return ctx.answerCallbackQuery({ text: 'Unknown action type' });
  }

  if (sub === 'more') {
    const contextId = rest.slice(1).join(':');
    const [project, lastAction] = contextId.split('|');
    const { getNextActions } = await import('../lib/next-actions.js');
    const { getProject } = await import('../state.js');
    const proj = getProject(project);
    const state = {
      currentPhase: proj?.current_phase,
      totalPhases: proj?.total_phases,
    };
    const actions = getNextActions({ project, lastAction, state });
    await ctx.answerCallbackQuery({ text: `Showing all ${actions.length} options` });
    const lines = ['<b>📚 All next-action options</b>', ''];
    for (const a of actions) {
      lines.push(`  ${a.label}`);
      lines.push(`    <code>${a.cmd.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code>`);
      if (a.description) lines.push(`    <i>${a.description}</i>`);
    }
    return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  }

  return ctx.answerCallbackQuery({ text: `Unknown na action: ${sub}` });
}

// ─── Pinned project ─────────────────────────────────────────────────────────
//
// Lets the user "pin" a project so subsequent project-taking commands work
// without needing to retype the project name on a phone keyboard.
//
// Commands:
//   /pin            — show picker if no arg; pin if arg given
//   /pin <project>  — pin directly
//   /unpin          — clear pin
//   /pinned         — show current pin
//
// Resolution helper: every project-taking handler calls resolveProject(ctx, args)
// at the top. If the first arg is missing, the helper falls back to the pinned
// project. If no pin, it shows the picker and returns null (handler exits).

export async function showProjectPicker(ctx, hint = 'Pick a project to pin:') {
  const projects = listProjects();
  if (!projects || projects.length === 0) {
    return ctx.reply(
      'No projects yet. Create one on the Mac:\n' +
      '  <code>npm run new -- &lt;name&gt; --profile &lt;profile&gt;</code>',
      { parse_mode: 'HTML' },
    );
  }
  const kb = new InlineKeyboard();
  for (const p of projects) {
    kb.text(`📌 ${p.name}`, `pin:set:${p.name}`).row();
  }
  // Also offer the _inbox virtual project
  kb.text('📌 _inbox', `pin:set:_inbox`).row();
  kb.text('✗ Cancel', `pin:cancel`);
  return ctx.reply(
    `📌 <b>${hint}</b>\n\n` +
    `Once pinned, any project-taking command run <i>without</i> a project argument will use it automatically. Use /unpin to clear.`,
    { parse_mode: 'HTML', reply_markup: kb },
  );
}

// ─── v0.14.18: /run no-args flow ─────────────────────────────────────────
//
// Showed when the /run home button is tapped or when /run is sent with no
// args AND no pin. Distinct from showProjectPicker (which pins) — these
// callbacks queue a job directly without changing the user's pin.

export async function showRunPicker(ctx) {
  const projects = listProjects();
  if (!projects || projects.length === 0) {
    return ctx.reply('No projects yet.');
  }
  const kb = new InlineKeyboard();
  for (const p of projects) {
    kb.text(`▶ ${p.name}`, `run:p:${p.name}`).row();
  }
  return ctx.reply('<b>Run on which project?</b>', { parse_mode: 'HTML', reply_markup: kb });
}

export async function showRunActionPicker(ctx, projectName) {
  const proj = getProject(projectName);
  if (!proj) {
    return ctx.reply(`Project not found: <code>${sanitizeForTelegram(projectName)}</code>`, { parse_mode: 'HTML' });
  }
  // v0.14.2 pattern: state-aware. Hide actions that don't apply right now to
  // avoid the "Resume with no paused run" foot-gun. Mirrors showProjectDetail.
  const { getLastAutoRun, getCurrentBugRound } = await import('../state.js');
  const lastRun = getLastAutoRun(projectName);
  const round = getCurrentBugRound(projectName);
  const showResume = ['paused', 'failed'].includes(lastRun?.status);
  const showBugs   = round?.status === 'in-progress';
  const showShip   = !!proj.git_branch && proj.git_branch !== 'main';

  // Layout: always-on actions in two-column grid + Pipeline row + conditional
  // row at the bottom for Resume/Bugs/Ship. Covers all 13 entries in
  // VALID_ACTIONS (pipeline opens its own menu via pipemenu).
  const kb = new InlineKeyboard();
  kb.text('▶ Go', `run:a:${projectName}:go`)
    .text('🔍 Audit', `run:a:${projectName}:audit`).row();
  kb.text('🗺 Roadmap', `run:a:${projectName}:roadmap`)
    .text('📝 Brief', `run:a:${projectName}:brief`).row();
  kb.text('📚 Guide', `run:a:${projectName}:guide`)
    .text('➡ Next', `run:a:${projectName}:next`).row();
  kb.text('🔁 Review', `run:a:${projectName}:review`)
    .text('🤝 Handoff', `run:a:${projectName}:handoff`).row();
  kb.text('✅ QA', `run:a:${projectName}:qa`);
  if (showResume) kb.text('⏯ Resume', `run:a:${projectName}:resume`);
  kb.row();
  kb.text('🚀 Pipeline', `pipemenu:${projectName}`).row();
  if (showBugs) kb.text(`🐞 Bugs (round ${round?.round || ''})`, `run:a:${projectName}:bugs`);
  if (showShip) kb.text('🚢 Ship', `run:a:${projectName}:ship`);
  if (showBugs || showShip) kb.row();
  kb.text('✗ Cancel', 'confirm-no');

  const hidden = [];
  if (!showResume) hidden.push('Resume (no paused run)');
  if (!showBugs)   hidden.push('Bugs (no active round)');
  if (!showShip)   hidden.push('Ship (no develop branch ahead of main)');
  const hint = hidden.length ? `\n\n<i>Hidden: ${hidden.join(', ')}</i>` : '';

  return ctx.reply(
    `<b>Run what on ${sanitizeForTelegram(projectName)}?</b>${hint}`,
    { parse_mode: 'HTML', reply_markup: kb },
  );
}

/**
 * Resolves the project for the current command. Returns project name string
 * or null if a picker was shown (handler should return immediately).
 *
 * @param {object} ctx - grammy context
 * @param {string[]} args - already-split command arguments
 * @param {object} [opts]
 * @param {boolean} [opts.allowInbox] - if true, fall through to _inbox when no pin (used by /req)
 */
export async function resolveProject(ctx, args, opts = {}) {
  if (args[0]) return args[0];
  const userId = ctx.from?.id;
  const pinned = userId ? getPinnedProject(userId) : null;
  if (pinned) return pinned;
  if (opts.allowInbox) return '_inbox';
  await showProjectPicker(ctx, 'No project specified. Pick one to pin (then resend your command):');
  return null;
}

export const handlePin = requireAuth(async (ctx) => {
  const arg = (ctx.match || '').trim();
  if (!arg) {
    return showProjectPicker(ctx);
  }
  const project = getProject(arg);
  if (!project && arg !== '_inbox') {
    return ctx.reply(`Project not found: <code>${sanitizeForTelegram(arg)}</code>`, { parse_mode: 'HTML' });
  }
  pinProject(ctx.from.id, arg);
  return ctx.reply(
    `📌 Pinned <b>${sanitizeForTelegram(arg)}</b>.\n\n` +
    `Now any command without a project argument uses this. Use /unpin to clear, or /pin again to switch.`,
    { parse_mode: 'HTML' },
  );
});

export const handleUnpin = requireAuth(async (ctx) => {
  const userId = ctx.from?.id;
  const current = getPinnedProject(userId);
  if (!current) return ctx.reply('No pinned project.');
  unpinProject(userId);
  return ctx.reply(
    `✗ Unpinned <b>${sanitizeForTelegram(current)}</b>. Commands now require an explicit project argument.`,
    { parse_mode: 'HTML' },
  );
});

export const handlePinned = requireAuth(async (ctx) => {
  const current = getPinnedProject(ctx.from?.id);
  if (!current) return ctx.reply('No pinned project. Use /pin to set one.');
  return ctx.reply(
    `📌 Pinned: <b>${sanitizeForTelegram(current)}</b>\n\n` +
    `/unpin to clear · /pin to switch`,
    { parse_mode: 'HTML' },
  );
});

async function handlePinCallback(ctx, rest, userId) {
  const sub = rest[0];
  if (sub === 'cancel') {
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    return ctx.editMessageText('No pin set. Send the command again with an explicit project.');
  }
  if (sub === 'set') {
    const project = rest.slice(1).join(':');
    if (project !== '_inbox' && !getProject(project)) {
      return ctx.answerCallbackQuery({ text: `Project not found: ${project}`, show_alert: true });
    }
    pinProject(userId, project);
    await ctx.answerCallbackQuery({ text: `📌 Pinned ${project}` });
    return ctx.editMessageText(
      `📌 Pinned <b>${sanitizeForTelegram(project)}</b>.\n\n` +
      `Now resend your command — it'll use this project automatically. Examples:\n` +
      `  <code>/run go</code>\n` +
      `  <code>/preview roadmap</code>\n` +
      `  <code>/triage</code>\n\n` +
      `/unpin to clear · /pin to switch`,
      { parse_mode: 'HTML' },
    );
  }
  return ctx.answerCallbackQuery({ text: `Unknown pin action: ${sub}` });
}


// ─── Bug inbox (v0.12.0) ────────────────────────────────────────────────────
//
// /bug [project] <text>             — save a bug; "critical: ..." prefix marks critical
// /bug_capture [project]            — multi-message bug capture mode
// /bug_done                          — alias for /done (works for both modes)
// /bugs_inbox [project]              — browse pending bugs (sorted by severity)
// /bug_promote [project] [--critical] — create new bug round from inbox items

const BUG_VALID_SEVERITIES = ['critical', 'major', 'minor', 'unassigned'];

function parseInlineSeverity(text) {
  // Match "critical: ..." or "major - ..." etc at start of text
  const m = text.match(/^(critical|major|minor)\s*[:|-]\s*(.+)$/i);
  if (!m) return { severity: 'unassigned', body: text };
  return { severity: m[1].toLowerCase(), body: m[2].trim() };
}

function bugSeverityEmoji(s) {
  if (s === 'critical') return '🔴';
  if (s === 'major')    return '🟠';
  if (s === 'minor')    return '🟡';
  return '⚪';
}

export const handleBug = requireAuth(async (ctx) => {
  const userId = ctx.from?.id;
  const text = ctx.message?.text || '';
  const argText = text.replace(/^\/bug(@\w+)?\s*/i, '').trim();
  if (!argText) {
    const pinned = getPinnedProject(userId);
    return ctx.reply(
      'Usage:\n'
      + '  /bug &lt;project&gt; &lt;text&gt;\n'
      + '  /bug &lt;text&gt;                — save to ' + (pinned ? `pinned (${pinned})` : '_inbox') + '\n'
      + '  /bug &lt;project&gt; critical: &lt;text&gt; — marks critical\n'
      + '  /bug_capture &lt;project&gt;     — multi-message bug capture\n',
      { parse_mode: 'HTML' },
    );
  }

  // Resolution: first token may be project; else use pinned; else _inbox
  const { addBug } = await import('../state.js');
  const firstSpace = argText.indexOf(' ');
  const pinned = getPinnedProject(userId);
  let project = pinned || INBOX_PROJECT;
  let body = argText;
  if (firstSpace > 0) {
    const candidate = argText.slice(0, firstSpace);
    if (candidate === INBOX_PROJECT || getProject(candidate)) {
      project = candidate;
      body = argText.slice(firstSpace + 1).trim();
    }
  }
  const { severity, body: cleanBody } = parseInlineSeverity(body);
  if (!cleanBody) return ctx.reply('Empty bug text.');

  const id = addBug({ project, raw_text: cleanBody, severity, source: 'telegram', reported_by: userId });
  const emoji = bugSeverityEmoji(severity);

  if (severity === 'critical') {
    const kb = new InlineKeyboard()
      .text('🚨 Run bug-fix now', `bug:promote:${project}:${id}:run`).row()
      .text('📋 Add to next round', `bug:promote:${project}:${id}:queue`).row()
      .text('Just save', `bug:promote:${project}:${id}:save`);
    return ctx.reply(
      `${emoji} <b>Critical bug #${id} saved to ${sanitizeForTelegram(project)}</b>\n\n` +
      `<i>${sanitizeForTelegram(cleanBody.slice(0, 200))}</i>\n\n` +
      `Run bug-fix immediately?`,
      { parse_mode: 'HTML', reply_markup: kb },
    );
  }

  return ctx.reply(`${emoji} Bug #${id} (${severity}) saved to ${project}.\n\nUse /bugs_inbox to review, or /bug_promote ${project} when ready to fix.`);
});

export const handleBugCapture = requireAuth(async (ctx) => {
  const userId = ctx.from?.id;
  const text = ctx.message?.text || '';
  const arg = text.replace(/^\/bug_capture(@\w+)?\s*/i, '').trim();
  const args = arg ? arg.split(/\s+/) : [];
  const project = await resolveProject(ctx, args);
  if (!project) return; // picker shown
  if (project !== INBOX_PROJECT && !getProject(project)) {
    return ctx.reply(`Project not found: ${project}`);
  }
  setCaptureMode(userId, project, 'bug');
  return ctx.reply(
    `🔴 <b>Bug capture mode ON</b> for <b>${sanitizeForTelegram(project)}</b>.\n\n` +
    `Send messages and I'll save each as a bug.\n` +
    `Prefix any message with <code>critical:</code>, <code>major:</code>, or <code>minor:</code> to set severity.\n\n` +
    `Send /done (or /bug_done) to exit.`,
    { parse_mode: 'HTML' },
  );
});

export const handleBugDone = handleDone; // alias — clearCaptureMode works for both kinds

export const handleBugsInbox = requireAuth(async (ctx) => {
  const text = ctx.message?.text || '';
  const arg = text.replace(/^\/bugs_inbox(@\w+)?\s*/i, '').trim();
  const args = arg ? arg.split(/\s+/) : [];
  const { listBugs, listProjectsWithBugs } = await import('../state.js');

  let project;
  if (args[0]) {
    project = args[0];
  } else {
    const pinned = getPinnedProject(ctx.from?.id);
    if (pinned) {
      project = pinned;
    } else {
      const rows = listProjectsWithBugs();
      if (!rows.length) return ctx.reply('No bugs captured yet.\n\nUse /bug or /bug_capture to start.');
      const kb = new InlineKeyboard();
      for (const r of rows) kb.text(`${r.project} (${r.n})`, `bug:list:${r.project}`).row();
      return ctx.reply('Bug inbox — pick a project:', { reply_markup: kb });
    }
  }

  return showBugList(ctx, project);
});

async function showBugList(ctx, project) {
  const { listBugs } = await import('../state.js');
  const items = listBugs({ project }).filter((b) => ['inbox', 'refined'].includes(b.status));
  if (!items.length) return ctx.reply(`No pending bugs for <b>${sanitizeForTelegram(project)}</b>.`, { parse_mode: 'HTML' });

  const counts = { critical: 0, major: 0, minor: 0, unassigned: 0 };
  for (const b of items) counts[b.severity] = (counts[b.severity] || 0) + 1;

  const lines = [
    `🐛 <b>Bug inbox for ${sanitizeForTelegram(project)}</b> — ${items.length} pending`,
    `   ${counts.critical ? '🔴 ' + counts.critical + ' critical · ' : ''}${counts.major ? '🟠 ' + counts.major + ' major · ' : ''}${counts.minor ? '🟡 ' + counts.minor + ' minor · ' : ''}${counts.unassigned ? '⚪ ' + counts.unassigned + ' unassigned' : ''}`.trim(),
    '',
  ];
  const limit = 15;
  for (const b of items.slice(0, limit)) {
    lines.push(`${bugSeverityEmoji(b.severity)} <b>#${b.id}</b> <i>${b.severity}</i> ${b.refined_text ? '· refined' : ''}`);
    lines.push(`   ${sanitizeForTelegram(b.raw_text.slice(0, 100))}${b.raw_text.length > 100 ? '…' : ''}`);
  }
  if (items.length > limit) lines.push(`<i>… and ${items.length - limit} more</i>`);
  lines.push('');
  lines.push(`<i>Promote into a bug round:</i> <code>/bug_promote ${sanitizeForTelegram(project)}</code>`);
  lines.push(`<i>Or just criticals:</i> <code>/bug_promote ${sanitizeForTelegram(project)} --critical</code>`);

  const kb = new InlineKeyboard();
  if (counts.critical) kb.text(`🚨 Promote ${counts.critical} critical → run now`, `bug:promote-sev:${project}:critical:run`).row();
  kb.text(`📋 Promote all (${items.length}) → new round`, `bug:promote-all:${project}`).row();
  kb.text('📊 Stats', `bug:stats:${project}`);

  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb });
}

export const handleBugPromote = requireAuth(async (ctx) => {
  const userId = ctx.from?.id;
  const text = ctx.message?.text || '';
  const arg = text.replace(/^\/bug_promote(@\w+)?\s*|^\/bugpromote(@\w+)?\s*/i, '').trim();
  // Parse args + flags
  const tokens = arg.split(/\s+/).filter(Boolean);
  const flags = tokens.filter((t) => t.startsWith('--'));
  const positional = tokens.filter((t) => !t.startsWith('--'));
  const project = await resolveProject(ctx, positional);
  if (!project) return;
  const onlyCritical = flags.includes('--critical');

  // Run promote inline (fast — SQL + file write only)
  const { performBugPromote } = await import('../commands/bugs-inbox.js');
  let result;
  try {
    result = await performBugPromote({
      project,
      severity: onlyCritical ? 'critical' : null,
    });
  } catch (err) {
    return ctx.reply(`✗ Promote failed: ${sanitizeForTelegram(err.message)}`, { parse_mode: 'HTML' });
  }

  await ctx.reply(
    `🐛 <b>Promoted ${result.totalFixes} bug(s) → round ${result.round}</b> for ${sanitizeForTelegram(project)}\n\n` +
    `IDs: #${result.promotedIds.join(', #')}\n` +
    `bugs.md: <code>${sanitizeForTelegram(path.relative(REPO_ROOT, result.bugsPath))}</code>\n\n` +
    `▶ Enqueueing fix run…`,
    { parse_mode: 'HTML' },
  );

  // Enqueue 'go' job to actually execute. autoRun's pickNextAction picks up the
  // new round via detectNewBugRound, generates the fix plan, then executes fixes.
  // v0.14.8 / BUG-7: routes through enqueueAndReply so the user sees the same
  // per-project FIFO "Waiting behind: #N (..., running Xs)" context as /queue
  // and /run do, instead of a context-free "✓ Queued job #N" message that
  // implied immediate start even when a same-project job was already running.
  return enqueueAndReply(ctx, {
    project,
    action: 'go',
    args: { unattended: false },
    requestedBy: userId,
  });
});

// ─── Bug-inbox callback dispatcher ──────────────────────────────────────────
//
// Callback data shapes:
//   bug:promote:<project>:<bugId>:<mode>      mode ∈ run | queue | save
//   bug:promote-all:<project>                 promote all pending → queue bugs run
//   bug:promote-sev:<project>:<severity>:run  promote that severity → run now
//   bug:list:<project>                         re-render inbox list
//   bug:stats:<project>                        show stats

async function handleBugCallback(ctx, rest, userId) {
  const sub = rest[0];

  if (sub === 'list') {
    const project = rest.slice(1).join(':');
    await ctx.answerCallbackQuery();
    return showBugList(ctx, project);
  }

  if (sub === 'start') {
    // v0.14.25: from /coach's "Capture a QA bug" button. Enter bug-capture
    // mode for the project so the next non-slash message becomes a bug.
    const project = rest.slice(1).join(':');
    if (!project || (!getProject(project) && project !== '_inbox')) {
      return ctx.answerCallbackQuery({ text: 'Project not found', show_alert: true });
    }
    setCaptureMode(userId, project, 'bug');
    await ctx.answerCallbackQuery({ text: 'Bug capture ON' });
    return ctx.reply(
      `🔴 <b>Bug capture mode ON for ${sanitizeForTelegram(project)}.</b>\n\n` +
      `Send each QA finding as a separate message. Optional severity prefix:\n` +
      `  <code>critical: login redirects in loop</code>\n` +
      `  <code>major: settings page slow to save</code>\n` +
      `  <code>minor: tooltip off-by-1px on mobile</code>\n\n` +
      `When done capturing, send <code>/bug_done</code>, then <code>/bug_promote ${sanitizeForTelegram(project)}</code> to run the fix round.`,
      { parse_mode: 'HTML' },
    );
  }

  if (sub === 'promote-critical') {
    // v0.14.25: from /coach. Shortcut to /bug_promote <project> --critical
    // without making the user type. Delegates to handleBugPromote by
    // synthesising the message text.
    const project = rest.slice(1).join(':');
    await ctx.answerCallbackQuery({ text: 'Promoting criticals…' });
    // Build a fake message so handleBugPromote sees the right ctx.message.text
    if (!ctx.message) ctx.message = {};
    ctx.message.text = `/bug_promote ${project} --critical`;
    return handleBugPromote(ctx);
  }

  if (sub === 'stats') {
    const project = rest.slice(1).join(':');
    const { countBugs } = await import('../state.js');
    const rows = countBugs(project);
    await ctx.answerCallbackQuery();
    if (!rows.length) return ctx.reply(`No bugs for ${project}.`);
    const lines = [`📊 <b>Bug stats for ${sanitizeForTelegram(project)}</b>`, ''];
    for (const r of rows) {
      lines.push(`  ${r.status.padEnd(10)} ${bugSeverityEmoji(r.severity)} ${r.severity.padEnd(10)} ${r.n}`);
    }
    return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  }

  if (sub === 'promote') {
    // Single critical-bug fast path: rest = [project, bugId, mode]
    const project = rest[1];
    const bugId = Number(rest[2]);
    const mode = rest[3]; // run | queue | save
    if (mode === 'save') {
      await ctx.answerCallbackQuery({ text: 'Saved.' });
      return ctx.editMessageText(
        `✓ Bug #${bugId} saved. Promote later with <code>/bug_promote ${sanitizeForTelegram(project)}</code>.`,
        { parse_mode: 'HTML' },
      );
    }
    if (mode === 'queue') {
      await ctx.answerCallbackQuery({ text: 'Added to next round (not run yet)' });
      return ctx.editMessageText(
        `📋 Bug #${bugId} added to next bug round (not promoted yet).\n\n` +
        `When ready: <code>/bug_promote ${sanitizeForTelegram(project)}</code>`,
        { parse_mode: 'HTML' },
      );
    }
    // mode === 'run': do the promote inline + enqueue 'go'
    const { performBugPromote } = await import('../commands/bugs-inbox.js');
    let result;
    try {
      result = await performBugPromote({ project, ids: [bugId] });
    } catch (err) {
      await ctx.answerCallbackQuery({ text: 'Promote failed', show_alert: true });
      return ctx.editMessageText(`✗ Promote failed: ${sanitizeForTelegram(err.message)}`, { parse_mode: 'HTML' });
    }
    await ctx.answerCallbackQuery({ text: '🚨 Promoted + queued' });
    // v0.14.8 / BUG-7: editMessageText path → pass mode + prelude through
    // enqueueAndReply so the user sees the same FIFO-aware queued message
    // here as on /queue.
    return enqueueAndReply(ctx, {
      project,
      action: 'go',
      args: { unattended: false },
      requestedBy: userId,
      mode: 'editMessageText',
      prelude: `🚨 <b>Bug #${bugId} promoted to round ${result.round} + queued for run</b>`,
    });
  }

  if (sub === 'promote-all') {
    const project = rest.slice(1).join(':');
    const { performBugPromote } = await import('../commands/bugs-inbox.js');
    let result;
    try {
      result = await performBugPromote({ project });
    } catch (err) {
      await ctx.answerCallbackQuery({ text: 'Promote failed', show_alert: true });
      return ctx.reply(`✗ Promote failed: ${sanitizeForTelegram(err.message)}`, { parse_mode: 'HTML' });
    }
    await ctx.answerCallbackQuery({ text: `Promoted ${result.totalFixes} + queued` });
    // v0.14.8 / BUG-7: FIFO-aware queued reply via enqueueAndReply.
    return enqueueAndReply(ctx, {
      project,
      action: 'go',
      args: { unattended: false },
      requestedBy: userId,
      prelude:
        `📋 <b>Promoted ${result.totalFixes} bug(s) → round ${result.round}</b> for ${sanitizeForTelegram(project)}\n` +
        `IDs: #${result.promotedIds.join(', #')}`,
    });
  }

  if (sub === 'promote-sev') {
    const project = rest[1];
    const severity = rest[2];
    // mode == 'run' implied by caller
    const { performBugPromote } = await import('../commands/bugs-inbox.js');
    let result;
    try {
      result = await performBugPromote({ project, severity });
    } catch (err) {
      await ctx.answerCallbackQuery({ text: 'Promote failed', show_alert: true });
      return ctx.reply(`✗ Promote failed: ${sanitizeForTelegram(err.message)}`, { parse_mode: 'HTML' });
    }
    await ctx.answerCallbackQuery({ text: `Promoted ${result.totalFixes} ${severity}` });
    // v0.14.8 / BUG-7: FIFO-aware queued reply via enqueueAndReply.
    return enqueueAndReply(ctx, {
      project,
      action: 'go',
      args: { unattended: false },
      requestedBy: userId,
      prelude:
        `🚨 <b>Promoted ${result.totalFixes} ${severity} bug(s) → round ${result.round}</b> for ${sanitizeForTelegram(project)}\n` +
        `IDs: #${result.promotedIds.join(', #')}`,
    });
  }

  return ctx.answerCallbackQuery({ text: `Unknown bug action: ${sub}` });
}

// ─── /ship and /git_status (v0.13.0) ──────────────────────────────────────

export const handleShip = requireAuth(async (ctx) => {
  const raw = (ctx.match || '').trim();
  // Parse: project [--tag vX.Y.Z] [--target main]
  const args = raw.split(/\s+/).filter(Boolean);
  // Extract --tag / --target flags
  let tag = null;
  let target = 'main';
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tag' && args[i + 1]) { tag = args[++i]; }
    else if (args[i] === '--target' && args[i + 1]) { target = args[++i]; }
    else positional.push(args[i]);
  }
  const project = await resolveProject(ctx, positional);
  if (!project) return;

  await ctx.reply(`🚢 Shipping <b>${sanitizeForTelegram(project)}</b>: develop → ${sanitizeForTelegram(target)}${tag ? ` (tag: <code>${sanitizeForTelegram(tag)}</code>)` : ''}…`, { parse_mode: 'HTML' });

  const { shipProject } = await import('../commands/ship.js');
  let result;
  try {
    result = await shipProject({ projectName: project, target, tag });
  } catch (err) {
    return ctx.reply(`✗ Ship crashed: ${sanitizeForTelegram(err.message)}`, { parse_mode: 'HTML' });
  }

  if (!result.ok) {
    return ctx.reply(`✗ Ship failed:\n<pre>${escapeHtml(result.error)}</pre>`, { parse_mode: 'HTML' });
  }
  if (result.noop) {
    return ctx.reply(`ℹ️ <b>${sanitizeForTelegram(project)}</b>: ${sanitizeForTelegram(target)} is already at ${sanitizeForTelegram(result.source)}. Nothing to ship.`, { parse_mode: 'HTML' });
  }

  const lines = [
    `✅ <b>Shipped ${sanitizeForTelegram(project)}</b>`,
    `  ${sanitizeForTelegram(result.source)} → ${sanitizeForTelegram(result.target)}`,
    `  <code>${sanitizeForTelegram((result.fromSha || '').slice(0, 8))}</code> → <code>${sanitizeForTelegram((result.toSha || '').slice(0, 8))}</code>`,
  ];
  if (result.tag) lines.push(`  Tagged: <code>${sanitizeForTelegram(result.tag)}</code>`);
  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
});

export const handleGitStatus = requireAuth(async (ctx) => {
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  const project = await resolveProject(ctx, args);
  if (!project) return;

  const { getGitStatus } = await import('../commands/git-status.js');
  const s = await getGitStatus(project);

  if (!s.ok) {
    return ctx.reply(`✗ ${sanitizeForTelegram(s.error)}`, { parse_mode: 'HTML' });
  }

  const branchOk = s.configured_branch && s.current_branch === s.configured_branch;
  const lines = [];
  lines.push(`<b>Git — ${sanitizeForTelegram(s.project)}</b>`);
  lines.push('');
  lines.push(`• Branch: <code>${sanitizeForTelegram(s.current_branch || '(none)')}</code> ${branchOk ? '✓' : '⚠'}${s.configured_branch ? ` <i>(configured: ${sanitizeForTelegram(s.configured_branch)})</i>` : ' <i>(not configured)</i>'}`);
  if (s.remote_url) {
    const short = s.remote_url.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
    lines.push(`• Remote: <code>${sanitizeForTelegram(short)}</code>`);
  } else {
    lines.push(`• Remote: <i>(none)</i>`);
  }
  if (s.ahead_behind) {
    const { ahead, behind } = s.ahead_behind;
    const sync = ahead === 0 && behind === 0 ? '✓ in sync' :
      [ahead > 0 ? `↑${ahead}` : '', behind > 0 ? `↓${behind}` : ''].filter(Boolean).join(' ');
    lines.push(`• vs origin: ${sync}`);
  }
  lines.push(`• Working tree: ${s.clean ? '✓ clean' : `⚠ ${s.dirty_count} dirty`}`);
  if (s.last_commit) lines.push(`• Last: <code>${sanitizeForTelegram(s.last_commit)}</code>`);
  if (s.ship_lag !== null) {
    if (s.ship_lag === 0) lines.push(`• Ship: ✓ main == develop`);
    else lines.push(`• Ship: <b>${s.ship_lag}</b> commit(s) on develop not yet on main\n  Run: <code>/ship ${sanitizeForTelegram(s.project)}</code>`);
  }

  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
});

export const handleSync = requireAuth(async (ctx) => {
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  const project = await resolveProject(ctx, args);
  if (!project) return;

  const proj = (await import('../state.js')).getProject(project);
  if (!proj || !proj.git_branch) {
    return ctx.reply(
      `✗ <b>${sanitizeForTelegram(project)}</b> is not under git management.\n` +
      `Run on the host:  <code>npm run migrate-git -- --project ${sanitizeForTelegram(project)}</code>`,
      { parse_mode: 'HTML' },
    );
  }

  await ctx.reply(`🔄 Syncing <b>${sanitizeForTelegram(project)}</b> with origin/${sanitizeForTelegram(proj.git_branch)}…`, { parse_mode: 'HTML' });

  const { syncWithRemote } = await import('../lib/git.js');
  const { default: path } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const __dn = path.dirname(fileURLToPath(import.meta.url));
  const REPO_ROOT_LOCAL = path.resolve(__dn, '..', '..');
  const workspaceDir = path.join(REPO_ROOT_LOCAL, 'projects', project, 'workspace');

  const result = await syncWithRemote(workspaceDir, { branch: proj.git_branch });
  if (!result.ok) {
    return ctx.reply(
      `✗ Sync failed (${sanitizeForTelegram(result.action)}):\n<pre>${escapeHtml(result.error)}</pre>`,
      { parse_mode: 'HTML' },
    );
  }

  let msg;
  switch (result.action) {
    case 'noop':
      msg = `✓ <b>${sanitizeForTelegram(project)}</b> already in sync with origin/${sanitizeForTelegram(proj.git_branch)}`;
      break;
    case 'pulled':
      msg = `✓ Pulled <b>${result.behind}</b> commit(s) from origin/${sanitizeForTelegram(proj.git_branch)}`;
      break;
    case 'ahead-only':
      msg = `ℹ️ <b>${sanitizeForTelegram(project)}</b> has <b>${result.ahead}</b> unpushed commit(s). Trigger any phase/fix to publish them, or push manually.`;
      break;
    case 'no-upstream':
      msg = `ℹ️ No upstream tracking yet for ${sanitizeForTelegram(proj.git_branch)} — first push will set it up.`;
      break;
    default:
      msg = `✓ ${sanitizeForTelegram(result.action)}`;
  }
  return ctx.reply(msg, { parse_mode: 'HTML' });
});

export const handleSyncAll = requireAuth(async (ctx) => {
  const { listProjects } = await import('../state.js');
  const { syncWithRemote } = await import('../lib/git.js');
  const { default: path } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const __dn = path.dirname(fileURLToPath(import.meta.url));
  const REPO_ROOT_LOCAL = path.resolve(__dn, '..', '..');

  const projects = listProjects().filter(p => p.git_branch);
  if (projects.length === 0) {
    return ctx.reply('No git-managed projects found.', { parse_mode: 'HTML' });
  }

  await ctx.reply(`🔄 Syncing <b>${projects.length}</b> project(s)…`, { parse_mode: 'HTML' });

  const lines = [];
  let pulled = 0, failed = 0;

  for (const proj of projects) {
    const workspaceDir = path.join(REPO_ROOT_LOCAL, 'projects', proj.name, 'workspace');
    const result = await syncWithRemote(workspaceDir, { branch: proj.git_branch });
    const name = sanitizeForTelegram(proj.name);
    const branch = sanitizeForTelegram(proj.git_branch);
    if (!result.ok) {
      lines.push(`✗ <b>${name}</b> — ${sanitizeForTelegram(result.action)}`);
      failed++;
    } else {
      switch (result.action) {
        case 'noop':
          lines.push(`✓ <b>${name}</b> — up to date on ${branch}`);
          break;
        case 'pulled':
          lines.push(`✓ <b>${name}</b> — pulled <b>${result.behind}</b> commit(s) from ${branch}`);
          pulled++;
          break;
        case 'ahead-only':
          lines.push(`ℹ️ <b>${name}</b> — ${result.ahead} unpushed commit(s) on ${branch}`);
          break;
        case 'no-upstream':
          lines.push(`ℹ️ <b>${name}</b> — no upstream yet for ${branch}`);
          break;
        default:
          lines.push(`✓ <b>${name}</b> — ${sanitizeForTelegram(result.action)}`);
      }
    }
  }

  const summary = failed > 0
    ? `⚠️ ${failed} failed, ${pulled} pulled`
    : pulled > 0
      ? `✅ ${pulled} pulled, ${projects.length - pulled} already in sync`
      : `✅ All ${projects.length} projects in sync`;

  return ctx.reply(`${summary}\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
});

// ─── /discuss <project> <topic> [--mode auto|medium|max] ────────────────────
//
// Queues a multi-agent discussion job. The discussion engine runs in the
// job worker, updates the brief on completion, and auto-starts dev.
//
// Usage:
//   /discuss acf Video content isn't attention-seeking. Cost constraint: low.
//   /discuss acf --mode max What architecture should we use for real-time sync?

/** Renders a discussion inspect reply (shared by CLI-style --inspect and /discuss_inspect). */
async function replyDiscussInspect(ctx, projectName, id) {
  const disc = getDiscussion(id);
  if (!disc || disc.project !== projectName) {
    return ctx.reply(`❌ Discussion #${id} not found for project <code>${sanitizeForTelegram(projectName)}</code>`, { parse_mode: 'HTML' });
  }

  const statusEmoji = { done: '✅', failed: '❌', pending: '⏳', roster: '🧩', synthesis: '🔬' };
  const emoji = statusEmoji[disc.status] || '🔄';
  const agents = getDiscAgents(id);
  const conclusion = getDiscConclusion(id);

  let msg = `<b>Discussion #${id}</b> ${emoji} ${disc.status}\n`;
  msg += `<b>Project:</b> ${sanitizeForTelegram(disc.project)}\n`;
  msg += `<b>Topic:</b> <i>${sanitizeForTelegram(disc.topic)}</i>\n`;
  msg += `<b>Mode:</b> ${disc.mode} (${disc.rounds_planned} rounds)\n`;
  msg += `<b>Created:</b> ${disc.created_at?.slice(0, 16) || '—'}\n`;
  if (disc.completed_at) msg += `<b>Completed:</b> ${disc.completed_at.slice(0, 16)}\n`;

  if (agents.length) {
    msg += `\n<b>Agents (${agents.length}):</b>\n`;
    for (const a of agents) {
      msg += `\n◆ <b>${sanitizeForTelegram(a.role)}</b>\n`;
      msg += `   Expertise: ${sanitizeForTelegram(a.expertise)}\n`;
      msg += `   Mission: ${sanitizeForTelegram(a.mission)}\n`;
      msg += `   Session: ${a.session_id ? `<code>${a.session_id.slice(0, 10)}…</code>` : '—'}\n`;
    }
  }

  for (let r = 1; r <= disc.rounds_planned; r++) {
    const msgs = getDiscMessages(id, r);
    if (!msgs.length) continue;
    msg += `\n<b>Round ${r}</b> (${msgs.length}/${agents.length} responded):\n`;
    for (const m of msgs) {
      const agent = agents.find((a) => a.agent_key === m.agent_key);
      const preview = m.content.split('\n').find((l) => l.trim() && !l.startsWith('#')) || '';
      const truncated = preview.length > 60 ? preview.slice(0, 60) + '…' : preview;
      msg += `  › <b>${sanitizeForTelegram(agent?.role || m.agent_key)}</b>: <i>${sanitizeForTelegram(truncated)}</i>\n`;
    }
  }

  if (conclusion) {
    let synth;
    try { synth = JSON.parse(conclusion.synthesis); } catch { synth = null; }
    if (synth?.top_recommendations?.length) {
      msg += `\n<b>Top Recommendations:</b>\n`;
      for (const rec of synth.top_recommendations.slice(0, 3)) {
        msg += `\n${rec.rank}. <b>${sanitizeForTelegram(rec.title)}</b>\n`;
        const desc = rec.description?.length > 80 ? rec.description.slice(0, 80) + '…' : rec.description || '';
        msg += `   ${sanitizeForTelegram(desc)}\n`;
        msg += `   Cost: ${rec.cost} · Effort: ${rec.effort} · Confidence: ${Math.round((rec.confidence || 0) * 100)}%\n`;
      }
    }
    if (synth?.open_questions?.length) {
      msg += `\n<b>Open Questions:</b>\n`;
      for (const q of synth.open_questions.slice(0, 3)) msg += `  ? ${sanitizeForTelegram(q)}\n`;
    }
  }

  // Telegram 4096-char cap — trim gracefully
  if (msg.length > 4000) msg = msg.slice(0, 3990) + '\n<i>…truncated</i>';
  return ctx.reply(msg, { parse_mode: 'HTML' });
}

export const handleDiscuss = requireAuth(async (ctx) => {
  const text = (ctx.message?.text || '').trim();
  // Strip leading /discuss command token
  const raw = text.replace(/^\/discuss(@\w+)?\s*/i, '').trim();

  if (!raw) {
    return ctx.reply(
      '<b>Usage</b>\n' +
      '  <code>/discuss &lt;project&gt; &lt;topic&gt;</code>\n' +
      '  <code>/discuss &lt;project&gt; --mode max &lt;topic&gt;</code>\n' +
      '  <code>/discuss &lt;project&gt; --list</code>\n' +
      '  <code>/discuss &lt;project&gt; --inspect &lt;id&gt;</code>\n\n' +
      '<b>Modes</b>\n' +
      '  <code>auto</code>   — 3–5 agents, 2 rounds (default)\n' +
      '  <code>medium</code> — 5–7 agents, 3 rounds\n' +
      '  <code>max</code>    — 8–12 agents, 4 rounds\n\n' +
      '<b>Examples</b>\n' +
      '  <code>/discuss acf Video content isn\'t attention-seeking. Cost: low.</code>\n' +
      '  <code>/discuss acf --mode max Migrate to microservices?</code>\n' +
      '  <code>/discuss acf --list</code>\n' +
      '  <code>/discuss acf --inspect 3</code>\n\n' +
      'The discussion panel will research, debate, update the brief, then auto-start dev.',
      { parse_mode: 'HTML' },
    );
  }

  const tokens = raw.split(/\s+/);
  const projectName = tokens[0];

  const proj = getProject(projectName);
  if (!proj) {
    const all = listProjects().map((p) => p.name);
    return ctx.reply(
      `❌ Project "${sanitizeForTelegram(projectName)}" not found.\nProjects: ${sanitizeForTelegram(all.join(', '))}`,
      { parse_mode: 'HTML' },
    );
  }

  // ── --list ────────────────────────────────────────────────────────────────
  if (tokens[1] === '--list') {
    const discussions = listDiscussions(projectName, 10);
    if (!discussions.length) {
      return ctx.reply(`No discussions yet for <b>${sanitizeForTelegram(projectName)}</b>.`, { parse_mode: 'HTML' });
    }
    const statusEmoji = { done: '✅', failed: '❌', pending: '⏳', synthesis: '🔬' };
    let msg = `<b>Discussions — ${sanitizeForTelegram(projectName)}</b>\n\n`;
    for (const d of discussions) {
      const emoji = statusEmoji[d.status] || '🔄';
      msg += `${emoji} <b>#${d.id}</b> [${d.mode}/${d.rounds_planned}r] ${d.created_at?.slice(0, 10) || ''}\n`;
      msg += `   <i>${sanitizeForTelegram(d.topic.length > 60 ? d.topic.slice(0, 60) + '…' : d.topic)}</i>\n`;
      msg += `   Use: <code>/discuss ${sanitizeForTelegram(projectName)} --inspect ${d.id}</code>\n\n`;
    }
    return ctx.reply(msg, { parse_mode: 'HTML' });
  }

  // ── --inspect <id> ────────────────────────────────────────────────────────
  if (tokens[1] === '--inspect' && tokens[2]) {
    const id = parseInt(tokens[2], 10);
    return replyDiscussInspect(ctx, projectName, id);
  }

  // ── run discussion ────────────────────────────────────────────────────────
  let mode = 'auto';
  let topicStart = 1;

  if (tokens[1] === '--mode' && tokens[2]) {
    mode = tokens[2];
    topicStart = 3;
  }

  const topic = tokens.slice(topicStart).join(' ').trim();

  if (!topic) {
    return ctx.reply(`❌ Topic required.\nUsage: <code>/discuss ${sanitizeForTelegram(projectName)} &lt;topic&gt;</code>`, { parse_mode: 'HTML' });
  }

  const validModes = ['auto', 'medium', 'max'];
  if (!validModes.includes(mode)) {
    return ctx.reply(`❌ Invalid mode <code>${sanitizeForTelegram(mode)}</code>. Choose: auto, medium, max`, { parse_mode: 'HTML' });
  }

  const modeLabels = { auto: '3–5 agents, 2 rounds', medium: '5–7 agents, 3 rounds', max: '8–12 agents, 4 rounds' };
  await enqueueAndReply(ctx, {
    project: projectName,
    action: 'discuss',
    args: { topic, mode },
    requestedBy: ctx.from?.id,
    prelude: `🧠 <b>Discussion queued</b> [${mode}: ${modeLabels[mode]}]\n<i>${sanitizeForTelegram(topic)}</i>`,
  });
});

// ─── /discuss_inspect <project> <id> ──────────────────────────────────────
//
// Shorthand for inspecting a specific discussion by ID.
// Usage: /discuss_inspect aorch 5

export const handleDiscussInspect = requireAuth(async (ctx) => {
  const raw = (ctx.message?.text || '').replace(/^\/discuss_inspect(@\w+)?\s*/i, '').trim();
  const tokens = raw.split(/\s+/);
  const projectName = tokens[0];
  const id = parseInt(tokens[1], 10);

  if (!projectName || isNaN(id)) {
    return ctx.reply(
      '<b>Usage:</b> <code>/discuss_inspect &lt;project&gt; &lt;id&gt;</code>\n' +
      '<b>Example:</b> <code>/discuss_inspect aorch 3</code>',
      { parse_mode: 'HTML' },
    );
  }

  const proj = getProject(projectName);
  if (!proj) {
    return ctx.reply(`❌ Project "${sanitizeForTelegram(projectName)}" not found.`, { parse_mode: 'HTML' });
  }

  return replyDiscussInspect(ctx, projectName, id);
});

export const handleNewProject = requireAuth(async (ctx) => {
  const raw = (ctx.match || '').trim();
  if (!raw) {
    return ctx.reply(
      '<b>Usage</b>\n' +
      '  <code>/new_project &lt;name&gt; &lt;git-url&gt;</code>\n' +
      '  <code>/new_project &lt;git-url&gt;</code>   <i>(name inferred from URL)</i>\n\n' +
      '<b>Examples</b>\n' +
      '  <code>/new_project reelchain https://github.com/p-j-code/reelchain.git</code>\n' +
      '  <code>/new_project https://github.com/p-j-code/reelchain.git</code>\n\n' +
      '<b>What it does</b>\n' +
      '• If the remote has commits → clones into <code>projects/&lt;name&gt;/workspace/</code>\n' +
      '• If the remote is empty → inits a fresh repo + pushes\n' +
      '• Sets up the <code>develop</code> branch, records the project in SQLite\n' +
      '• Does NOT run any LLM calls — pure file/git work, sub-30s for most repos',
      { parse_mode: 'HTML' },
    );
  }

  const { inferNameFromGitUrl, looksLikeGitUrl, createProject } = await import('../commands/create-project.js');

  // Parse: "name url" | "url"
  const tokens = raw.split(/\s+/).filter(Boolean);
  let name = null;
  let url = null;
  if (tokens.length === 1) {
    url = tokens[0];
    name = inferNameFromGitUrl(url);
    if (!name) {
      return ctx.reply(
        `✗ Could not infer a project name from that URL.\n` +
        `Try:  <code>/new_project &lt;name&gt; ${sanitizeForTelegram(url)}</code>`,
        { parse_mode: 'HTML' },
      );
    }
  } else if (tokens.length >= 2) {
    name = tokens[0];
    url = tokens[1];
  }

  if (!/^[a-z0-9-]+$/.test(name)) {
    return ctx.reply(
      `✗ Project name must be lowercase alphanumeric + dashes only.\n` +
      `Got: <code>${sanitizeForTelegram(name)}</code>`,
      { parse_mode: 'HTML' },
    );
  }
  if (!looksLikeGitUrl(url)) {
    return ctx.reply(
      `✗ That doesn't look like a git URL:\n<code>${sanitizeForTelegram(url)}</code>`,
      { parse_mode: 'HTML' },
    );
  }

  const startedAt = Date.now();
  await ctx.reply(
    `🌱 Importing <b>${sanitizeForTelegram(name)}</b>\n` +
    `  from <code>${sanitizeForTelegram(url)}</code>\n\n` +
    `<i>Probing remote, then clone or init… I'll reply when done.</i>`,
    { parse_mode: 'HTML' },
  );

  try {
    const result = await createProject({
      name,
      url,
      branch: 'develop',
      tech: '',
      profile: null,
      onProgress: (line) => {
        // Stream progress to console; Telegram doesn't easily support
        // live-updating messages without callback complexity. Keep it simple.
        console.log(`[/new_project ${name}] ${line}`);
      },
    });

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const lines = [
      `✅ <b>${sanitizeForTelegram(name)} imported</b>  <i>(${elapsed}s)</i>`,
      '',
      `Mode:    ${result.mode === 'imported' ? '<b>cloned</b> from git' : result.mode === 'greenfield' ? '<b>greenfield</b> (init + pushed)' : 'no-git (local)'}`,
    ];
    if (result.fileCount !== null) lines.push(`Files:   ${result.fileCount}`);
    if (result.branch) lines.push(`Branch:  <code>${sanitizeForTelegram(result.branch)}</code>`);
    if (result.remote) lines.push(`Remote:  <code>${sanitizeForTelegram(result.remote)}</code>`);
    if (result.mode !== 'no-git' && !result.pushed) {
      lines.push('');
      lines.push(`⚠ Initial push didn't complete cleanly — check on the host.`);
    }
    lines.push('');
    lines.push(`Next:`);
    lines.push(`  <code>/git_status ${sanitizeForTelegram(name)}</code> — verify`);
    lines.push(`  <code>/pin ${sanitizeForTelegram(name)}</code> — set as default for other commands`);
    lines.push(`  Drop a brief into <code>.guide/brief.md</code> when you want to plan phases.`);

    return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  } catch (err) {
    const msg = (err.message || String(err)).slice(0, 900);
    return ctx.reply(
      `✗ <b>Import failed</b>\n<pre>${escapeHtml(msg)}</pre>`,
      { parse_mode: 'HTML' },
    );
  }
});
