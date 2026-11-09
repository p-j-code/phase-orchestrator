// Discussion Engine — multi-agent discussion orchestration.
//
// Flow:
//   generateRoster  → run N parallel research agents (Round 1)
//   → each subsequent round: agents read full history + respond
//   → synthesis agent writes conclusion + brief patch
//   → brief.md updated → auto-dev triggered

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { resolve as resolveConfig } from '../config-resolver.js';
import { runClaude } from '../claude-runner.js';
import {
  getProject,
  createDiscussion, updateDiscussionStatus,
  saveDiscAgent, updateDiscAgentSession, getDiscAgents,
  saveDiscMessage, getDiscMessages,
  saveDiscConclusion, getDiscConclusion,
  getDiscussion,
  getActiveAutoRun,
  setDiscussBriefPending,
} from '../state.js';
import { guideRoot, briefPath, planJsonPath, projectContextPath } from './guide-paths.js';
import { autoRun } from '../auto-runner.js';
import { requireConfirmation } from './require-confirmation.js';
import { escapeHtml } from './telegram-fmt.js';

// Brief-append gate (Phase 13). A 5-minute TTL defaulting to Discard: a stale
// 4-hour-old brief confirmation is worse than none. appendToBrief and autoRun
// are a single atomic risk — gating only autoRun while leaving the append
// unconditional still leaves AI-synthesised content on disk for the next go, so
// the gate sits at the append decision. ONE three-option choice (NOT a
// confirm-the-confirm two-step).
const BRIEF_APPEND_TTL_MS = 5 * 60 * 1000;
const BRIEF_GATE_OPTIONS = [
  { id: 'pipeline', label: '✅ Accept & Start Pipeline' },
  { id: 'brief',    label: '📋 Accept Brief Only — review before running' },
  { id: 'discard',  label: '🗑 Discard' },
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

// Rounds per mode
const MODE_ROUNDS = { auto: 2, medium: 3, max: 4 };
// Agent count range per mode [min, max]
const MODE_AGENTS = { auto: [3, 5], medium: [5, 7], max: [8, 12] };

async function readFileSafe(p) {
  try { return await fs.readFile(p, 'utf-8'); } catch { return null; }
}

async function readJsonSafe(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf-8')); } catch { return null; }
}

// ─── JSON extraction from LLM output ─────────────────────────────────────────
//
// Try clean JSON.parse first (the prompts ask for JSON-only output).
// Fall back to a brace-depth walk that finds the outermost {...} block.
// This avoids the greedy-regex failure where Claude adds trailing prose
// and the match extends to a wrong closing brace.

function extractJsonBlock(text) {
  const trimmed = text.trim();

  // Happy path: model returned pure JSON
  try { return JSON.parse(trimmed); } catch { /* fall through */ }

  // Strip leading/trailing markdown fences
  const stripped = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(stripped); } catch { /* fall through */ }

  // Walk to find balanced outermost { ... }
  const start = trimmed.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(trimmed.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

// ─── Project context loader ──────────────────────────────────────────────────

async function loadProjectContext(projectName) {
  const proj = getProject(projectName);
  if (!proj) throw new Error(`Project not found: ${projectName}`);
  const projDir = path.join(PROJECTS_DIR, projectName);
  const [brief, plan, context] = await Promise.all([
    readFileSafe(briefPath(projDir)),
    readJsonSafe(planJsonPath(projDir)),
    readFileSafe(projectContextPath(projDir)),
  ]);
  return {
    name: projectName,
    tech_stack: proj.tech_stack || 'unknown',
    profile: proj.profile || '',
    status: proj.status,
    brief: brief || '(no brief yet)',
    planSummary: plan ? `${plan.phases?.length || 0} phases, current phase ${proj.current_phase}` : '(no plan yet)',
    context: context || '',
  };
}

// ─── Roster generation ───────────────────────────────────────────────────────

function rosterPrompt(topic, ctx, mode) {
  const [minA, maxA] = MODE_AGENTS[mode] || MODE_AGENTS.auto;
  return `You are a senior engineering team lead assembling a specialist review panel.

PROJECT: ${ctx.name}
TECH STACK: ${ctx.tech_stack}
PROJECT BRIEF:
${ctx.brief}

TOPIC FOR DISCUSSION:
${topic}

MODE: ${mode} (create ${minA}–${maxA} specialist agents)

Create a JSON roster of specialist agents for this discussion. Each agent must cover a distinct angle. Always include:
- At least one technical implementer (frontend/backend/infra based on topic)
- At least one user/product perspective agent
- At least one cost/feasibility enforcer
- One skeptic/devil's advocate (for max/medium mode)
- Domain specialists relevant to the specific topic

For the ACF video attention example you'd include: Content Strategist, Frontend Engineer (CSS/animations), Media API Researcher, Cost Analyst, UX/Conversion Expert.

Output ONLY valid JSON (no markdown, no explanation):
{
  "agents": [
    {
      "key": "kebab-case-unique-key",
      "role": "Short Role Title",
      "expertise": "One sentence on what they know",
      "mission": "Specific research mission for this topic",
      "system_prompt": "You are a [role]. Your expertise is [expertise]. In this discussion, your job is to [mission]. Be specific, cite real tools/APIs/techniques, give cost estimates where relevant. Structure every response with: ## Findings, ## Proposals, ## Concerns, ## Top Recommendation."
    }
  ]
}`;
}

async function generateRoster(topic, ctx, mode, cfg) {
  console.log(chalk.cyan('  [discuss] Generating agent roster…'));
  // role: undefined — skips upsertSession in claude-runner (sessions table only
  // allows 'guide'/'dev'; discussion sessions are tracked in disc_agents instead)
  const result = await runClaude({
    cfg,
    prompt: rosterPrompt(topic, ctx, mode),
    task: 'disc-roster',
    project: ctx.name,
  });
  if (result.is_error) throw new Error(`Roster generation failed: ${result.result}`);

  const text = result.result || '';
  const parsed = extractJsonBlock(text);
  if (!parsed) throw new Error(`Roster response was not valid JSON. Got: ${text.slice(0, 300)}`);
  if (!Array.isArray(parsed.agents) || parsed.agents.length === 0) {
    throw new Error('Roster has no agents');
  }
  return parsed.agents;
}

// ─── Round execution ─────────────────────────────────────────────────────────

function round1Prompt(agent, topic, ctx) {
  return `DISCUSSION TOPIC: ${topic}

PROJECT: ${ctx.name} (${ctx.tech_stack})
PROJECT BRIEF:
${ctx.brief}
${ctx.context ? `\nPROJECT CONTEXT:\n${ctx.context}` : ''}

YOUR ROLE: ${agent.role}
YOUR MISSION: ${agent.mission}

This is Round 1 — independent research. Research and analyze this topic from your specific angle only. Do not wait for others' input.

Structure your response exactly as:

## Findings
[Specific, detailed findings. Cite real APIs, tools, libraries, metrics, benchmarks where applicable.]

## Proposals
[Concrete actionable proposals. For each: what it is, how to implement it, estimated cost (free/low/$X/mo/high), estimated dev effort (hours/days).]

## Concerns
[What risks, limitations, or pitfalls exist for this topic area?]

## Top Recommendation
[Your single strongest recommendation with a one-paragraph justification.]`;
}

// Only carry the most recent N prior rounds into each round prompt to prevent
// O(agents²×rounds) token growth — agents in round R already incorporated
// all earlier discussion into their round R-1 responses.
const MAX_PRIOR_ROUNDS_IN_PROMPT = 2;
// Cap each round's content to prevent a single verbose round from bloating context.
const MAX_HISTORY_CHARS_PER_ROUND = 20_000;

function roundNPrompt(agent, round, topic, history) {
  // Only send the most recent MAX_PRIOR_ROUNDS_IN_PROMPT rounds — earlier rounds
  // are already distilled into those agents' most recent responses.
  const recentHistory = history.slice(-MAX_PRIOR_ROUNDS_IN_PROMPT);
  const historyText = recentHistory.map((r) => {
    const roundText = r.messages.map((m) => `--- ${m.role} ---\n${m.content}`).join('\n\n');
    const capped = roundText.length > MAX_HISTORY_CHARS_PER_ROUND
      ? roundText.slice(0, MAX_HISTORY_CHARS_PER_ROUND) + '\n[... truncated for context efficiency ...]'
      : roundText;
    return `=== ROUND ${r.round} ===\n${capped}`;
  }).join('\n\n');

  return `DISCUSSION TOPIC: ${topic}

PREVIOUS DISCUSSION:
${historyText}

YOUR ROLE: ${agent.role}

This is Round ${round}. You have read what your teammates said. Now respond, challenge, and refine.

Structure your response exactly as:

## Response to Others
[React to at least 2 other agents' proposals specifically. Name them by role. Agree with what's solid, push back on what's weak or too expensive, add nuance.]

## Refined Proposals
[Update or sharpen your Round 1 proposals based on the discussion. Drop weak ones. Strengthen the winners.]

## Critical Points
[2–3 points that MUST be resolved before any implementation begins.]

## Updated Recommendation
[Your sharpened single recommendation after hearing the team.]`;
}

async function runRound({ discId, agents, round, history, ctx, topic, cfg }) {
  console.log(chalk.cyan(`  [discuss] Running round ${round} (${agents.length} agents in parallel)…`));

  const results = await Promise.allSettled(
    agents.map(async (agent) => {
      const prompt = round === 1
        ? round1Prompt(agent, topic, ctx)
        : roundNPrompt(agent, round, topic, history);

      // role: undefined — bypass sessions table (discussion sessions tracked in disc_agents)
      const result = await runClaude({
        cfg,
        prompt,
        systemPromptExtra: agent.system_prompt,
        sessionId: agent.session_id || null,
        task: `disc-round-${round}`,
        project: ctx.name,
      });

      if (result.is_error) {
        // Throw so Promise.allSettled marks this as rejected — error text never
        // enters the discussion history as fake analysis.
        throw new Error(`Agent ${agent.role} failed in round ${round}: ${String(result.result).slice(0, 200)}`);
      }

      return { agent, content: result.result || '', session_id: result.session_id };
    }),
  );

  const messages = [];
  for (const settled of results) {
    if (settled.status === 'rejected') {
      console.warn(chalk.yellow(`  [discuss] ${settled.reason?.message}`));
      continue;
    }
    const { agent, content, session_id } = settled.value;
    saveDiscMessage({ disc_id: discId, agent_key: agent.agent_key, round, content });
    // Update session_id on the agent object and in DB for next-round --resume
    if (session_id) {
      agent.session_id = session_id;
      if (agent.db_id) updateDiscAgentSession(agent.db_id, session_id);
    }
    messages.push({ agent_key: agent.agent_key, role: agent.role, content });
  }
  return messages;
}

// ─── Synthesis ───────────────────────────────────────────────────────────────

// Cap transcript per round to avoid blowing Claude's context on max-mode runs
const MAX_CHARS_PER_ROUND = 40_000;

function synthesisPrompt(topic, agents, history, ctx) {
  const transcript = history.map((r) => {
    const roundText = r.messages.map((m) => {
      const agentMeta = agents.find((a) => a.agent_key === m.agent_key);
      return `--- ${agentMeta?.role || m.agent_key} ---\n${m.content}`;
    }).join('\n\n');
    // Truncate each round if very large (context guard for max-mode)
    const truncated = roundText.length > MAX_CHARS_PER_ROUND
      ? roundText.slice(0, MAX_CHARS_PER_ROUND) + '\n[... truncated for context ...]'
      : roundText;
    return `=== ROUND ${r.round} ===\n${truncated}`;
  }).join('\n\n');

  return `You are a Technical Synthesis Agent. You observed a structured multi-expert discussion and must now produce the final conclusions.

PROJECT: ${ctx.name} (${ctx.tech_stack})
TOPIC: ${topic}

FULL DISCUSSION TRANSCRIPT:
${transcript}

Synthesize everything into a structured JSON output. Be decisive — pick winners, explain rejections, estimate costs honestly.

Output ONLY valid JSON (no markdown wrapper):
{
  "top_recommendations": [
    {
      "rank": 1,
      "title": "Short title",
      "description": "What to do and how",
      "rationale": "Why this won the discussion",
      "cost": "free | low | medium | high",
      "effort": "hours | days | week | weeks",
      "confidence": 0.85
    }
  ],
  "rejected": [
    { "proposal": "What was proposed", "reason": "Why it lost" }
  ],
  "consensus_areas": ["Things all agents agreed on"],
  "open_questions": ["Unresolved questions that need more info"],
  "brief_patch": "## Discussion: ${topic.replace(/"/g, '\\"')}\\n\\n### Approved Recommendations\\n\\n[numbered list]\\n\\n### Rationale\\n\\n[paragraph]\\n\\n### Rejected Approaches\\n\\n[bullet list with reasons]\\n\\n### Open Questions\\n\\n[bullet list]"
}`;
}

async function synthesize({ discId, topic, agents, history, ctx, cfg }) {
  console.log(chalk.cyan('  [discuss] Running synthesis…'));
  // role: undefined — bypass sessions table
  const result = await runClaude({
    cfg,
    prompt: synthesisPrompt(topic, agents, history, ctx),
    task: 'disc-synthesis',
    project: ctx.name,
  });
  if (result.is_error) throw new Error(`Synthesis failed: ${result.result}`);

  const text = result.result || '';
  const parsed = extractJsonBlock(text);
  if (!parsed || !Array.isArray(parsed.top_recommendations)) {
    throw new Error(`Synthesis response was not valid JSON. Got: ${text.slice(0, 300)}`);
  }

  saveDiscConclusion({
    disc_id: discId,
    synthesis: parsed,
    brief_patch: parsed.brief_patch || '',
  });
  return parsed;
}

// ─── Brief update ─────────────────────────────────────────────────────────────

// projDir is injectable so the byte-level append/discard behaviour is testable
// against a temp dir without writing into the real projects/ tree.
export async function appendToBrief(projectName, topic, conclusion, projDir = path.join(PROJECTS_DIR, projectName)) {
  const bPath = briefPath(projDir);

  const patch = conclusion.brief_patch ||
    buildFallbackPatch(topic, conclusion);

  let existing = '';
  try { existing = await fs.readFile(bPath, 'utf-8'); } catch { /* new brief */ }

  const separator = existing.trim() ? '\n\n---\n\n' : '';
  await fs.writeFile(bPath, `${existing}${separator}${patch}\n`, 'utf-8');
  console.log(chalk.green(`  [discuss] Brief updated: ${bPath}`));
}

/** HTML-safe summary of the synthesis for the brief-append gate. */
function buildBriefGateSummary(topic, conclusion) {
  const recs = (conclusion.top_recommendations || []).slice(0, 3);
  const lines = [
    '🧠 <b>Discussion synthesis ready</b> — append to the brief?',
    `Topic: ${escapeHtml(String(topic))}`,
    '',
  ];
  for (const r of recs) {
    lines.push(`${r.rank}. <b>${escapeHtml(String(r.title ?? ''))}</b> (cost: ${escapeHtml(String(r.cost ?? '?'))}, effort: ${escapeHtml(String(r.effort ?? '?'))})`);
  }
  lines.push('');
  lines.push('<i>Auto-discards in 5 min if you don\'t choose — a stale brief confirmation is worse than none.</i>');
  return lines.join('\n');
}

/**
 * Gate the brief append behind ONE three-option operator choice and apply it.
 * Returns { choice, appended } where choice ∈ 'pipeline' | 'brief' | 'discard'.
 *
 *   discard  → brief left byte-identical (also the 5-min-expiry / undelivered default)
 *   brief    → append + set discuss_brief_pending so the next go surfaces it
 *   pipeline → append (caller triggers the unattended run)
 *
 * autoRun is intentionally NOT triggered here so this stays unit-testable; the
 * caller (runDiscussion) starts the pipeline on a 'pipeline' choice.
 */
export async function decideBriefAppend({
  projectName, discId, topic, conclusion, notifier = null,
  projDir = null, requireConfirmationFn = requireConfirmation, ttlMs = BRIEF_APPEND_TTL_MS,
}) {
  const gate = await requireConfirmationFn({
    action: 'brief-append',
    project: projectName,
    summary: buildBriefGateSummary(topic, conclusion),
    options: BRIEF_GATE_OPTIONS,
    defaultOption: 'discard',
    ttlMs,
    notifier,
  });

  // undelivered / no-tty / expired / explicit discard all collapse to discard.
  const choice = gate.option === 'pipeline' || gate.option === 'brief' ? gate.option : 'discard';

  if (choice === 'discard') {
    console.log(chalk.yellow(`  [discuss] Brief append discarded (${gate.reason}) — brief left unchanged.`));
    return { choice, appended: false };
  }

  await appendToBrief(projectName, topic, conclusion, projDir || path.join(PROJECTS_DIR, projectName));

  if (choice === 'brief') {
    setDiscussBriefPending(projectName, discId);
    console.log(chalk.green('  [discuss] Brief updated; deferred for review (will surface on next go).'));
  }
  return { choice, appended: true };
}

function buildFallbackPatch(topic, conclusion) {
  const recs = (conclusion.top_recommendations || [])
    .map((r, i) => `${i + 1}. **${r.title}** (cost: ${r.cost}, effort: ${r.effort})\n   ${r.description}`)
    .join('\n');
  const rejected = (conclusion.rejected || [])
    .map((r) => `- ${r.proposal}: ${r.reason}`)
    .join('\n');
  return `## Discussion: ${topic}\n\n### Approved Recommendations\n\n${recs || '(none)'}\n\n### Rejected Approaches\n\n${rejected || '(none)'}`;
}

// ─── Save discussion files ────────────────────────────────────────────────────

async function saveDiscussionFiles(projectName, discId, { agents, history, conclusion }) {
  const projDir = path.join(PROJECTS_DIR, projectName);
  const discDir = path.join(guideRoot(projDir), 'discussions', String(discId));
  await fs.mkdir(discDir, { recursive: true });

  await Promise.all([
    fs.writeFile(path.join(discDir, 'roster.json'), JSON.stringify(agents, null, 2)),
    ...history.map((r) =>
      fs.writeFile(path.join(discDir, `round-${r.round}.json`), JSON.stringify(r.messages, null, 2)),
    ),
    fs.writeFile(path.join(discDir, 'synthesis.json'), JSON.stringify(conclusion, null, 2)),
    fs.writeFile(path.join(discDir, 'discussion.md'), buildMarkdownTranscript(agents, history, conclusion)),
  ]);
  console.log(chalk.dim(`  [discuss] Files saved to ${discDir}`));
}

function buildMarkdownTranscript(agents, history, conclusion) {
  const agentMap = Object.fromEntries(agents.map((a) => [a.agent_key, a.role]));
  const rounds = history.map((r) =>
    `## Round ${r.round}\n\n` +
    r.messages.map((m) => `### ${agentMap[m.agent_key] || m.agent_key}\n\n${m.content}`).join('\n\n---\n\n'),
  ).join('\n\n');

  const recs = (conclusion.top_recommendations || [])
    .map((r) => `${r.rank}. **${r.title}** — cost: ${r.cost}, effort: ${r.effort}, confidence: ${Math.round((r.confidence || 0) * 100)}%\n   ${r.description}`)
    .join('\n');

  return `# Discussion Transcript\n\n${rounds}\n\n---\n\n## Synthesis\n\n### Top Recommendations\n\n${recs}\n\n### Consensus Areas\n\n${(conclusion.consensus_areas || []).map((c) => `- ${c}`).join('\n')}\n\n### Open Questions\n\n${(conclusion.open_questions || []).map((q) => `- ${q}`).join('\n')}\n`;
}

// ─── Public entry point ───────────────────────────────────────────────────────

// Shared post-synthesis handler: brief append + optional auto-dev start.
// autoStart=true skips the operator gate and always appends + starts pipeline.
async function handlePostSynthesis({ projectName, discId, topic, conclusion, notifier, autoStart }) {
  let choice;
  if (autoStart) {
    await appendToBrief(projectName, topic, conclusion);
    choice = 'pipeline';
    console.log(chalk.green(`  [discuss] autoStart — brief updated, starting dev`));
  } else {
    ({ choice } = await decideBriefAppend({ projectName, discId, topic, conclusion, notifier }));
  }

  if (choice === 'discard') {
    if (notifier) notifier.notify({ text: `[discuss #${discId}] Synthesis complete — brief unchanged (discarded).` }).catch(() => {});
  } else if (choice === 'brief') {
    if (!autoStart) setDiscussBriefPending(projectName, discId);
    if (notifier) notifier.notify({ text: `[discuss #${discId}] ✓ Brief updated. Deferred — review, then run /go when ready.` }).catch(() => {});
  } else if (choice === 'pipeline') {
    const activeRun = getActiveAutoRun(projectName);
    if (!activeRun) {
      console.log(chalk.bold.cyan(`\n[discuss] Triggering auto-dev for ${projectName}…`));
      const topRec = conclusion.top_recommendations?.[0];
      const topLine = topRec ? `Top rec: ${topRec.title}` : 'Discussion complete';
      if (notifier) notifier.notify({ text: `[discuss #${discId}] ✓ Brief updated — ${topLine}\n\nStarting auto-dev…` }).catch(() => {});
      const devResult = await autoRun({ projectName, unattended: true, notifier });
      if (devResult?.status === 'failed') {
        console.warn(chalk.yellow(`  [discuss] Auto-dev run failed: ${devResult.reason}`));
        if (notifier) notifier.notify({ text: `[discuss #${discId}] ⚠ Auto-dev failed: ${devResult.reason?.slice(0, 200)}` }).catch(() => {});
      }
    } else {
      console.log(chalk.yellow(`  [discuss] Active auto-run exists — brief updated, dev will pick it up on next cycle`));
      if (notifier) notifier.notify({ text: `[discuss #${discId}] ✓ Done — brief updated. Dev will pick up on next cycle.` }).catch(() => {});
    }
  }
  return choice;
}

export async function runDiscussion({ projectName, topic, mode = 'auto', notifier = null, autoStart = false }) {
  const proj = getProject(projectName);
  if (!proj) throw new Error(`Project not found: ${projectName}`);

  // Normalize mode before any DB writes so the stored value is always valid
  mode = mode in MODE_ROUNDS ? mode : 'auto';
  const roundsPlanned = MODE_ROUNDS[mode];

  console.log(chalk.bold.cyan(`\n[discuss] Starting ${mode} discussion for ${projectName}`));
  console.log(chalk.dim(`  Topic: ${topic}`));
  console.log(chalk.dim(`  Mode: ${mode} (${roundsPlanned} rounds)`));

  // Resolve config and project context BEFORE creating the DB record so a
  // config error doesn't leave an orphaned 'pending' discussion row.
  const cfg = await resolveConfig({ project: projectName, task: 'disc-research' });
  const ctx = await loadProjectContext(projectName);

  const discId = createDiscussion({ project: projectName, topic, mode, rounds_planned: roundsPlanned });

  try {
    // Phase 0: generate roster
    updateDiscussionStatus(discId, 'roster');
    if (notifier) notifier.notify({ text: `[discuss #${discId}] Generating agent roster for: ${topic}` }).catch(() => {});
    const rawAgents = await generateRoster(topic, ctx, mode, cfg);

    // Save agents to DB and build in-memory agent objects
    const agents = [];
    for (const a of rawAgents) {
      const dbId = saveDiscAgent({
        disc_id: discId,
        agent_key: a.key,
        role: a.role,
        expertise: a.expertise,
        mission: a.mission,
        system_prompt: a.system_prompt,
      });
      // session_id starts null; updated in-place by runRound after each call
      agents.push({ ...a, agent_key: a.key, db_id: dbId, session_id: null });
    }
    console.log(chalk.green(`  [discuss] Roster: ${agents.map((a) => a.role).join(', ')}`));

    // Phases 1–N: discussion rounds
    // runRound mutates agent.session_id in-place for cross-round --resume
    const history = [];
    for (let round = 1; round <= roundsPlanned; round++) {
      updateDiscussionStatus(discId, `round_${round}`);
      if (notifier) notifier.notify({ text: `[discuss #${discId}] Round ${round}/${roundsPlanned} — ${agents.length} agents thinking…` }).catch(() => {});

      const messages = await runRound({ discId, agents, round, history, ctx, topic, cfg });
      history.push({ round, messages });
    }

    // Synthesis
    updateDiscussionStatus(discId, 'synthesis');
    if (notifier) notifier.notify({ text: `[discuss #${discId}] Running synthesis…` }).catch(() => {});
    const conclusion = await synthesize({ discId, topic, agents, history, ctx, cfg });

    await handlePostSynthesis({ projectName, discId, topic, conclusion, notifier, autoStart });

    // Mark done BEFORE writing discussion files (file write failure is non-fatal).
    updateDiscussionStatus(discId, 'done');

    // Write discussion files last — failure here is non-fatal (data is in DB)
    saveDiscussionFiles(projectName, discId, { agents, history, conclusion }).catch((err) => {
      console.warn(chalk.yellow(`  [discuss] File save failed (non-fatal, data is in DB): ${err.message}`));
    });

    return { discId, conclusion };
  } catch (err) {
    updateDiscussionStatus(discId, 'failed');
    throw err;
  }
}

// ─── Resume a failed / interrupted discussion ─────────────────────────────────
//
// Reloads roster + completed-round messages from DB and continues from the
// first round that has no messages. If synthesis is already saved it skips
// straight to the brief-append gate.

export async function resumeDiscussion({ discId, notifier = null, autoStart = false }) {
  const disc = getDiscussion(discId);
  if (!disc) throw new Error(`Discussion #${discId} not found`);
  if (disc.status === 'done') throw new Error(`Discussion #${discId} is already complete`);

  const proj = getProject(disc.project);
  if (!proj) throw new Error(`Project not found: ${disc.project}`);

  console.log(chalk.bold.cyan(`\n[discuss] Resuming discussion #${discId} for ${disc.project}`));
  console.log(chalk.dim(`  Topic: ${disc.topic}`));

  const cfg = await resolveConfig({ project: disc.project, task: 'disc-research' });
  const ctx = await loadProjectContext(disc.project);

  // Rebuild in-memory agents from DB (session_ids preserved from last completed round)
  const dbAgents = getDiscAgents(discId);
  if (!dbAgents.length) throw new Error(`Discussion #${discId} has no agent roster — cannot resume (roster was never saved)`);
  const agents = dbAgents.map((a) => ({
    key: a.agent_key,
    agent_key: a.agent_key,
    role: a.role,
    expertise: a.expertise,
    mission: a.mission,
    system_prompt: a.system_prompt,
    db_id: a.id,
    session_id: a.session_id || null,
  }));

  // Rebuild history from saved messages
  const allMessages = getDiscMessages(discId);
  const history = [];
  for (let r = 1; r <= disc.rounds_planned; r++) {
    const msgs = allMessages.filter((m) => m.round === r);
    if (msgs.length) {
      history.push({
        round: r,
        messages: msgs.map((m) => ({
          agent_key: m.agent_key,
          role: agents.find((a) => a.agent_key === m.agent_key)?.role || m.agent_key,
          content: m.content,
        })),
      });
    }
  }

  const lastCompletedRound = history.length;
  console.log(chalk.dim(`  Completed rounds: ${lastCompletedRound}/${disc.rounds_planned}`));
  if (notifier) notifier.notify({ text: `[discuss #${discId}] Resuming from round ${lastCompletedRound + 1}/${disc.rounds_planned}` }).catch(() => {});

  try {
    // Run remaining rounds
    for (let round = lastCompletedRound + 1; round <= disc.rounds_planned; round++) {
      updateDiscussionStatus(discId, `round_${round}`);
      if (notifier) notifier.notify({ text: `[discuss #${discId}] Round ${round}/${disc.rounds_planned} — ${agents.length} agents thinking…` }).catch(() => {});
      const messages = await runRound({ discId, agents, round, history, ctx, topic: disc.topic, cfg });
      history.push({ round, messages });
    }

    // Synthesis — skip if already saved (crashed after synthesis but before brief gate)
    let conclusion = null;
    const savedConclusion = getDiscConclusion(discId);
    if (savedConclusion) {
      console.log(chalk.dim('  [discuss] Synthesis already saved — skipping to brief gate'));
      try { conclusion = JSON.parse(savedConclusion.synthesis); } catch { conclusion = savedConclusion.synthesis; }
    } else {
      updateDiscussionStatus(discId, 'synthesis');
      if (notifier) notifier.notify({ text: `[discuss #${discId}] Running synthesis…` }).catch(() => {});
      conclusion = await synthesize({ discId, topic: disc.topic, agents, history, ctx, cfg });
    }

    await handlePostSynthesis({ projectName: disc.project, discId, topic: disc.topic, conclusion, notifier, autoStart });
    updateDiscussionStatus(discId, 'done');

    saveDiscussionFiles(disc.project, discId, { agents, history, conclusion }).catch((err) => {
      console.warn(chalk.yellow(`  [discuss] File save failed (non-fatal): ${err.message}`));
    });

    return { discId, conclusion };
  } catch (err) {
    updateDiscussionStatus(discId, 'failed');
    throw err;
  }
}

// ─── Formatting helpers for Telegram / CLI ───────────────────────────────────

export function formatConclusionSummary(conclusion, discId) {
  const recs = (conclusion.top_recommendations || []).slice(0, 3);
  const lines = [`<b>Discussion #${discId} — Top Recommendations</b>`];
  for (const r of recs) {
    lines.push(`\n${r.rank}. <b>${r.title}</b>`);
    lines.push(`   Cost: ${r.cost} · Effort: ${r.effort} · Confidence: ${Math.round((r.confidence || 0) * 100)}%`);
    lines.push(`   ${r.description}`);
  }
  if (conclusion.open_questions?.length) {
    lines.push(`\n<i>Open questions: ${conclusion.open_questions.slice(0, 2).join('; ')}</i>`);
  }
  return lines.join('\n');
}
