// Chat engine — one function, sendChatMessage(), shared by the CLI REPL
// (src/commands/chat.js) and the web UI (POST /api/chat/...). Each message is
// one `claude -p` turn (via runClaude, per repo convention) with:
//   - prompts/chat-system.md as the system prompt (static → cache-friendly)
//   - a live <orchestrator_state> snapshot prefixed to the user message
//   - the aorch-control MCP server as its ONLY tools (allowedToolsOverride:[]
//     strips Read/Write/Bash — the chat agent acts through control tools, it
//     never touches this repo's files directly)
//   - --resume for thread continuity (session id persisted per chat_threads row)
//
// Cost/window accounting: runClaude records the call with project=null,
// task='chat', so chat turns count against the 5-hour window like everything
// else, and shouldPause() blocks new turns when the window is exhausted —
// surfaced to the user as a friendly message instead of a crash.

import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve as resolveConfig } from '../config-resolver.js';
import {
  runClaude, withJobKey, killCurrent, clearCancellation,
} from '../claude-runner.js';
import { buildContextSnapshot, buildSelfContextSnapshot, statChatUpload } from './control-actions.js';
import { isProviderRateLimitError, extractProviderResetAt } from '../lib/transient-errors.js';
import { providerCircuitStatus } from '../lib/provider-circuit-breaker.js';
import { CONTROL_SERVER_NAME, qualifiedControlToolNames } from '../mcp/control-tool-names.js';
import {
  createChatThread, getChatThread, listChatThreads, setChatThreadSession,
  setChatThreadProject, setChatThreadTitle, touchChatThread, deleteChatThread,
  addChatMessage, listChatMessages, getProject,
  acquireChatLock, releaseChatLock, isChatThreadLocked,
  setThreadAutopilot, setAutopilotStatus, resetAutopilotAttempts, getAutopilotThreads,
} from '../state.js';

export const SELF_PROJECT = '__self__';

const OPUS_KEYWORDS = ['run all', 'run dev', 'chain', 'all phases', 'audit', 'fix all', 'build', 'deploy', 'migrate', 'refactor', 'multi-agent', 'discuss', 'execute', 'implement', 'brief'];
const HAIKU_KEYWORDS = ["what's running", "what is running", 'status', 'list', 'show me', 'how many', 'is it', 'what is', 'which', 'are there'];

/** Replace raw {"resetsAt": <unix>} JSON in a pause message with human-readable time. */
function formatPauseMessage(msg) {
  if (!msg) return msg;
  return String(msg).replace(/\{"resetsAt":\s*(\d+)\}/, (_, ts) => {
    const ms = Number(ts) * 1000;
    const resetDate = new Date(ms);
    const now = Date.now();
    const diffMs = ms - now;
    let when;
    if (diffMs <= 0) {
      when = 'now';
    } else {
      const mins = Math.ceil(diffMs / 60000);
      when = mins < 60 ? `in ${mins} min` : `in ${Math.round(mins / 6) / 10}h`;
    }
    const timeStr = resetDate.toLocaleTimeString('en-IN', { timeZone: 'Asia/Calcutta', hour: '2-digit', minute: '2-digit', hour12: true });
    return `(resets at ${timeStr} IST — ${when})`;
  });
}

function pickModelAuto(message, cfg) {
  const m = message.toLowerCase();
  const tiers = cfg.model_routing?.tier_models || {};
  if (OPUS_KEYWORDS.some((kw) => m.includes(kw)) || message.length > 600) {
    return tiers.opus || 'claude-opus-4-8';
  }
  if (HAIKU_KEYWORDS.some((kw) => m.includes(kw)) && message.length < 250) {
    return tiers.haiku || 'claude-haiku-4-5';
  }
  return tiers.sonnet || 'claude-sonnet-5';
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CHAT_SYSTEM_PROMPT = path.join(REPO_ROOT, 'prompts', 'chat-system.md');
const MCP_CONFIG_PATH = path.join(REPO_ROOT, 'state', 'chat-mcp-config.json');

// threadId -> { jobKey, startedAt }. The SQLite chat lock remains the
// cross-process concurrency authority; this local registry exists only so the
// web process can target the exact runClaude subprocess owned by a live HTTP
// turn. A unique key per turn prevents a delayed escalation kill from ever
// targeting a later turn on the same thread.
const activeChatTurns = new Map();

function chatJobKey(threadId) {
  return `chat:${threadId}:${randomUUID()}`;
}

function isCancellationError(err) {
  return /\bcancel(?:led|ed)\b/i.test(String(err?.message || err || ''));
}

// One in-flight turn per thread, enforced CROSS-PROCESS via a SQLite lock
// (state.chat_locks). The old per-process Set could not stop the auto-healer's
// issue-bridge — which runs in a different process — from --resume-ing the same
// session the web-UI/CLI engine was mid-turn on, corrupting it. Autopilot makes
// the system self-trigger constantly, so this race had to close first.

// ─── Autopilot (guarded) ─────────────────────────────────────────────────────
// A thread with autopilot=1 is being driven to done by chat-autopilot.js. Every
// turn on such a thread (human OR loop tick) carries an <autopilot> directive:
// the authorization envelope + a control-token contract. The agent ends its
// reply with exactly one token; the engine parses it and the loop acts on it.
const AUTOPILOT_TOKEN_RE = /\[\[\s*AUTOPILOT\s*:\s*(WORKING|WAITING|BLOCKED|DONE)\b([^\]]*)\]\]/i;
const DEFAULT_AUTOPILOT_BUDGET_USD = 5;
const DEFAULT_AUTOPILOT_MAX_ATTEMPTS = 8;

function autopilotConfig(cfg) {
  const a = cfg.chat?.autopilot || {};
  // Enabled via config (cfg.chat.autopilot.enabled) OR the AORCH_CHAT_AUTOPILOT=1
  // env override — the latter lets it be flipped on where editing config isn't
  // convenient (e.g. a launcher .env), and keeps a kill switch (=0 forces off).
  const env = process.env.AORCH_CHAT_AUTOPILOT;
  const enabled = env === '0' || env === 'false' ? false
    : (a.enabled === true || env === '1' || env === 'true');
  return {
    enabled,                                                      // default OFF
    budgetUsd: Number.isFinite(a.budget_usd) ? a.budget_usd
      : (Number(process.env.AORCH_CHAT_AUTOPILOT_BUDGET) || DEFAULT_AUTOPILOT_BUDGET_USD),
    maxAttempts: Number.isFinite(a.max_attempts) ? a.max_attempts : DEFAULT_AUTOPILOT_MAX_ATTEMPTS,
    tickMs: Number.isFinite(a.tick_ms) ? a.tick_ms : 20000,
  };
}

/** The <autopilot> directive injected on autopilot-thread turns (guarded envelope). */
function buildAutopilotDirective({ goal, budgetUsd, spentUsd, attempts, maxAttempts, isTick }) {
  const remaining = Math.max(0, budgetUsd - (spentUsd || 0));
  return [
    '<autopilot>',
    'AUTOPILOT MODE (guarded) — you are driving this thread to completion unattended.',
    goal ? `GOAL: ${goal}` : 'GOAL: resolve the operator\'s latest request end-to-end.',
    '',
    'You are PRE-AUTHORIZED to take the expensive actions needed to reach the goal without asking:',
    'run/next-phase/resume, brief-chain, audit (incl. chain), start-bug-round, pipeline, promote_*, validators, workspace_shell.',
    `Spend budget for this thread: ~$${budgetUsd.toFixed(2)} (about $${remaining.toFixed(2)} left). Stay within it.`,
    '',
    'You are NOT authorized to act alone on these — emit BLOCKED and let the operator decide:',
    'ship_project (merge to main), orchestrator_dev (edit the orchestrator source), abort_run, start_discussion auto_start.',
    'Never set confirm:true on those in this mode.',
    '',
    'Ground every step in the live snapshot and recentDetachedSpawn/project_overview before acting or re-acting —',
    'a detached action you fired earlier may have completed, paused, or died; verify, do not assume.',
    'Take at most ONE new heavy action per turn, then report.',
    '',
    'END YOUR REPLY WITH EXACTLY ONE CONTROL TOKEN on its own line:',
    '  [[AUTOPILOT: WORKING]]        — you just fired/continued work; keep driving next tick',
    '  [[AUTOPILOT: WAITING]]        — work is running detached; nothing to do until its state changes',
    '  [[AUTOPILOT: BLOCKED <why>]]  — you need the operator (ship gate, ambiguity, budget, repeated failure)',
    '  [[AUTOPILOT: DONE]]           — the goal is fully achieved and verified',
    isTick
      ? `This is an automatic continuation tick (attempt ${attempts + 1}/${maxAttempts} since the last human message). If nothing has changed and nothing is running, prefer DONE or BLOCKED over spinning.`
      : 'The operator just messaged this autopilot thread — treat their words as the current directive.',
    '</autopilot>',
  ].join('\n');
}

/**
 * Extract the autopilot control signal from a reply, or null. The LAST token
 * in the reply wins: a reply that quotes the token menu while explaining
 * itself must not be parsed into whichever token happened to appear first.
 */
export function parseAutopilotSignal(reply) {
  const matches = [...String(reply || '').matchAll(new RegExp(AUTOPILOT_TOKEN_RE.source, 'gi'))];
  if (!matches.length) return null;
  const m = matches[matches.length - 1];
  return { state: m[1].toUpperCase(), note: (m[2] || '').trim() || null };
}

async function ensureControlMcpConfig(threadId = null, { autopilotTick = false } = {}) {
  const dir = path.dirname(MCP_CONFIG_PATH);
  await fs.mkdir(dir, { recursive: true });
  const serverPath = path.join(REPO_ROOT, 'src', 'mcp', 'control-server.mjs');
  // Pass the thread id through the server's ARGV (not env — the server relies on
  // inheriting the parent env, e.g. DB_PATH, and MCP env-override semantics vary
  // by client). control-server.mjs parses --thread and exposes it so the
  // thread-scoped set_autopilot tool knows which thread it's acting on. Written
  // to a per-thread file so concurrent threads never race one shared config.
  // --autopilot-tick makes the server hard-reject the operator-only tools on
  // unattended loop turns — the <autopilot> directive alone is prompt policy,
  // not enforcement.
  const args = threadId != null ? [serverPath, '--thread', String(threadId)] : [serverPath];
  if (autopilotTick) args.push('--autopilot-tick');
  const config = {
    mcpServers: {
      [CONTROL_SERVER_NAME]: {
        command: process.execPath,
        args,
      },
    },
  };
  const outPath = threadId != null ? path.join(dir, `chat-mcp-config-${threadId}.json`) : MCP_CONFIG_PATH;
  await fs.writeFile(outPath, JSON.stringify(config, null, 2), 'utf-8');
  return outPath;
}

function titleFrom(message) {
  const firstLine = String(message).trim().split('\n')[0];
  return firstLine.length > 64 ? `${firstLine.slice(0, 61)}…` : firstLine;
}

/**
 * Send one chat message and get the reply.
 *
 * @param {Object} opts
 * @param {number|null} opts.threadId - existing thread, or null to start one
 * @param {string} opts.message - the user's message
 * @param {string|null} [opts.project] - focus project; null explicitly clears it
 * @param {string[]} [opts.attachments] - stored upload names (see storeChatUpload)
 * @param {string} [opts.modelTier] - 'auto'|'haiku'|'sonnet'|'opus'|'fable' (default 'auto')
 * @param {boolean} [opts.isTick] - true when fired by the autopilot loop (not a human/issue turn)
 * @returns {Promise<{threadId, reply, error?, cost_usd?, usage?, session_id?, model?, autopilot_signal?}>}
 */
export async function sendChatMessage({ threadId = null, message, project = undefined, attachments = [], modelTier = 'auto', onEvent = null, isTick = false }) {
  if (typeof message !== 'string' || !message.trim()) {
    throw new Error('message must be a non-empty string');
  }
  // Validate attachments up front — a stored name the agent can't read back
  // via read_upload would just waste the turn.
  const attached = [];
  for (const name of Array.isArray(attachments) ? attachments : []) {
    const st = await statChatUpload(name);
    if (!st) throw new Error(`Attachment not found in upload store: ${name}`);
    attached.push(st);
  }
  if (project != null && project !== SELF_PROJECT && !getProject(project)) {
    throw new Error(`Project not found: ${project}`);
  }

  let thread = threadId ? getChatThread(threadId) : null;
  if (threadId && !thread) throw new Error(`Chat thread not found: ${threadId}`);
  if (!thread) {
    threadId = createChatThread({ title: titleFrom(message), project: project ?? null });
    thread = getChatThread(threadId);
  } else if (project !== undefined && project !== thread.project) {
    setChatThreadProject(thread.id, project);
    thread = { ...thread, project };
  }
  threadId = thread.id;

  // Cross-process turn lock. A tick that can't get the lock (a human turn is
  // mid-flight, or a prior tick hasn't returned) simply yields — the loop will
  // retry next tick — rather than throwing a scary error into the transcript.
  if (!acquireChatLock(threadId)) {
    if (isTick) return { threadId, reply: '', skipped: 'busy' };
    throw new Error('This thread is already processing a message — wait for the reply.');
  }

  const jobKey = chatJobKey(threadId);
  activeChatTurns.set(threadId, { jobKey, startedAt: Date.now() });

  try {
    const cfg = await resolveConfig({ project: null, task: 'chat' });
    const tiers = cfg.model_routing?.tier_models || {};
    if (!modelTier || modelTier === 'auto') {
      cfg.model = pickModelAuto(message, cfg);
    } else if (tiers[modelTier]) {
      cfg.model = tiers[modelTier];
    }
    const resolvedModel = cfg.model;
    const ap = autopilotConfig(cfg);
    const autopilotOn = thread.autopilot === 1 && ap.enabled;

    // Pre-flight: when the shared provider breaker is already open, don't burn
    // a spawn that the provider will reject. Ticks silently skip (the loop
    // re-fires after reset); a human turn still records the message — it is
    // replayed via <missed_messages> on the next successful turn — and gets a
    // friendly note instead of the raw provider text.
    const circuit = providerCircuitStatus(cfg);
    if (circuit?.open) {
      const blockedUntilMs = circuit.row?.blocked_until_ms || null;
      if (isTick) return { threadId, reply: '', skipped: 'rate-limited', rate_limited: true, resets_at: blockedUntilMs };
      addChatMessage({ thread_id: threadId, role: 'user', content: message });
      const until = blockedUntilMs
        ? `${new Date(blockedUntilMs).toLocaleTimeString('en-IN', { timeZone: 'Asia/Calcutta', hour: '2-digit', minute: '2-digit', hour12: true })} IST`
        : 'the window resets';
      const text = `⚠ Provider usage limit — chat is paused until ${until}. Your message is saved and will be included in the next turn.`;
      addChatMessage({ thread_id: threadId, role: 'system', content: text });
      touchChatThread(threadId);
      return { threadId, reply: text, error: true, rate_limited: true, resets_at: blockedUntilMs };
    }
    const mcpConfigPath = await ensureControlMcpConfig(threadId, { autopilotTick: autopilotOn && isTick });
    const isSelf = thread.project === SELF_PROJECT;
    const snapshot = isSelf
      ? await buildSelfContextSnapshot()
      : await buildContextSnapshot({ focusProject: thread.project || null });

    // Issue-bridge context: system messages the agent hasn't seen yet (seeded
    // by openIssueThread, or this engine's own error notes) — everything after
    // the last assistant reply. The claude session only knows what we send, so
    // these must ride along in the prompt once.
    const prior = listChatMessages(threadId, 50);
    let lastAssistant = -1;
    prior.forEach((m, i) => { if (m.role === 'assistant') lastAssistant = i; });
    const unseenSystem = prior
      .filter((m, i) => i > lastAssistant && m.role === 'system')
      .slice(-3)
      .map((m) => m.content.slice(0, 2000));
    // Operator messages whose turn never reached the model (provider limit /
    // spawn failure left a user row with no assistant reply). The session only
    // knows what we send — replay them once, alongside the current message.
    const missedUser = prior
      .filter((m, i) => i > lastAssistant && m.role === 'user')
      .slice(-5)
      .map((m) => m.content.slice(0, 2000));

    addChatMessage({
      thread_id: threadId, role: 'user', content: message,
      meta: attached.length ? { attachments: attached.map((a) => a.name) } : null,
    });

    const promptParts = [
      '<orchestrator_state>',
      snapshot,
      '</orchestrator_state>',
    ];
    if (unseenSystem.length) {
      promptParts.push('', '<issue_context>', ...unseenSystem, '</issue_context>');
    }
    if (missedUser.length) {
      promptParts.push(
        '',
        '<missed_messages>',
        'These earlier operator messages were never delivered to you (their turn failed, e.g. on a provider limit). Honor them together with the current message:',
        ...missedUser.map((c) => `- ${c}`),
        '</missed_messages>',
      );
    }
    if (attached.length) {
      promptParts.push(
        '',
        '<attachments>',
        'The user attached these files — read each relevant one with the read_upload tool (images are shown to you directly):',
        ...attached.map((a) => `- ${a.name} (${a.size} bytes)`),
        '</attachments>',
      );
    }
    if (autopilotOn) {
      promptParts.push('', buildAutopilotDirective({
        goal: thread.autopilot_goal || null,
        budgetUsd: ap.budgetUsd,
        spentUsd: thread.autopilot_spend_usd || 0,
        attempts: thread.autopilot_attempts || 0,
        maxAttempts: ap.maxAttempts,
        isTick,
      }));
    }
    promptParts.push('', message);
    const prompt = promptParts.join('\n');

    let result;
    try {
      result = await withJobKey(jobKey, () => runClaude({
        cfg,
        cwd: REPO_ROOT,
        prompt,
        systemPromptFile: CHAT_SYSTEM_PROMPT,
        sessionId: thread.session_id || null,
        role: null,
        project: null,
        phase: null,
        task: 'chat',
        allowedToolsOverride: [],
        mcpConfigOverride: { path: mcpConfigPath, toolNames: qualifiedControlToolNames() },
        onStreamEvent: onEvent,
      }));
    } catch (err) {
      if (isCancellationError(err)) {
        const text = 'Turn stopped by operator.';
        addChatMessage({
          thread_id: threadId, role: 'system', content: text,
          meta: { cancelled: true },
        });
        touchChatThread(threadId);
        return { threadId, reply: text, cancelled: true, error: false, model: resolvedModel };
      }
      // Billing-window pause or exhausted retries — keep the thread usable.
      const text = `⚠ ${formatPauseMessage(err.message)}`;
      addChatMessage({ thread_id: threadId, role: 'system', content: text });
      touchChatThread(threadId);
      return { threadId, reply: text, error: true };
    }

    if (result.session_id) setChatThreadSession(threadId, result.session_id);
    touchChatThread(threadId);

    // A provider rate/session rejection is NOT an assistant reply: storing the
    // raw provider text as role:assistant made the agent appear to say "You've
    // hit your session limit" and burned the turn (47 of 72 recorded chat
    // errors). Surface it as a system note with the reset time; the operator's
    // message replays via <missed_messages> on the next successful turn.
    const providerErrText = result.is_error ? String(result.error_message || result.result || '') : '';
    if (result.is_error && isProviderRateLimitError(providerErrText)) {
      const resetMs = extractProviderResetAt(providerErrText);
      const until = resetMs
        ? `${new Date(resetMs).toLocaleTimeString('en-IN', { timeZone: 'Asia/Calcutta', hour: '2-digit', minute: '2-digit', hour12: true })} IST`
        : 'the window resets';
      const text = `⚠ Provider usage limit — this turn was rejected; chat resumes after ${until}. Your message is saved and will be included in the next turn.`;
      addChatMessage({ thread_id: threadId, role: 'system', content: text, meta: { rate_limited: true, resets_at: resetMs || null } });
      return { threadId, reply: text, error: true, rate_limited: true, resets_at: resetMs || null, model: resolvedModel };
    }

    const reply = String(result.result || '').trim() || '(no reply)';

    // Autopilot bookkeeping: parse the control token and reflect terminal states
    // onto the thread immediately (so DONE/BLOCKED stops the loop no matter who
    // fired this turn). A human turn on an autopilot thread resets the spin
    // counter — their message is a fresh directive. The loop owns attempt/spend
    // accounting for its own ticks.
    let autopilot_signal = null;
    if (autopilotOn) {
      autopilot_signal = parseAutopilotSignal(reply);
      if (!isTick) resetAutopilotAttempts(threadId);
      if (autopilot_signal?.state === 'DONE') setAutopilotStatus(threadId, 'done');
      else if (autopilot_signal?.state === 'BLOCKED') setAutopilotStatus(threadId, 'escalated');
      else if (autopilot_signal?.state === 'WAITING') setAutopilotStatus(threadId, 'waiting');
      // A token-less reply only re-arms the loop when the turn actually
      // SUCCEEDED. An errored turn (max-turns, spawn failure…) has no token by
      // definition; treating it as a fresh 'active' directive made the loop
      // spin on its own failures every tick.
      else if (!result.is_error) setAutopilotStatus(threadId, 'active');
    }

    addChatMessage({
      thread_id: threadId,
      role: 'assistant',
      content: reply,
      meta: {
        cost_usd: result.total_cost_usd ?? null,
        is_error: !!result.is_error,
        session_id: result.session_id || null,
        autopilot_signal: autopilot_signal || undefined,
      },
    });

    return {
      threadId,
      reply,
      error: !!result.is_error,
      cost_usd: result.total_cost_usd ?? null,
      usage: result.usage || null,
      session_id: result.session_id || null,
      model: resolvedModel,
      autopilot_signal,
    };
  } finally {
    const active = activeChatTurns.get(threadId);
    if (active?.jobKey === jobKey) activeChatTurns.delete(threadId);
    clearCancellation(jobKey);
    releaseChatLock(threadId);
  }
}

/**
 * Request cancellation of the active turn for this thread. Idempotent when no
 * local turn is active. `cancelled:true` means the runner cancellation flag was
 * set for this process, even when the turn is still waiting to spawn.
 */
export function cancelChatTurn(threadId) {
  const id = Number(threadId);
  if (!Number.isInteger(id) || id <= 0 || !getChatThread(id)) {
    throw new Error(`Chat thread not found: ${threadId}`);
  }
  const active = activeChatTurns.get(id);
  if (!active) {
    return {
      cancelled: false,
      threadId: id,
      reason: isThreadBusy(id) ? 'owned_by_another_process' : 'not_busy',
    };
  }
  const result = killCurrent({ jobId: active.jobKey, reason: 'chat stop requested by operator' });
  return {
    cancelled: true,
    threadId: id,
    killed: result.killed,
    reason: result.killed ? 'stop_requested' : 'cancellation_requested',
  };
}

// Test-only seam for cancellation targeting without starting a paid provider
// turn. Production callers must use sendChatMessage/cancelChatTurn.
export const __chatTestHooks = {
  trackTurn(threadId, jobKey) {
    activeChatTurns.set(Number(threadId), { jobKey, startedAt: Date.now() });
  },
  resetTurns() { activeChatTurns.clear(); },
};

export function isThreadBusy(threadId) {
  return isChatThreadLocked(Number(threadId));
}

// Thin re-exports so callers (web-ui, CLI, chat-autopilot) get the whole chat
// surface from one module instead of reaching into state.js for chat specifics.
export {
  createChatThread, getChatThread, listChatThreads, listChatMessages,
  deleteChatThread, setChatThreadTitle,
  setThreadAutopilot, setAutopilotStatus, getAutopilotThreads,
};
export { autopilotConfig };
