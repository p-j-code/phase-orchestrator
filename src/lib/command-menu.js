// Discord slash command definitions — registered with the bot at server boot
// via the Discord REST API (PUT /applications/:id/guilds/:id/commands).
//
// Guild-scoped commands (guild_id set in config) propagate instantly.
// Global commands (no guild_id) take up to 1 hour to propagate — use
// guild commands during development.

import { REST, Routes } from 'discord.js';
import chalk from 'chalk';

// All commands that accept free-form arguments use a single "args" string
// option so handlers can read (interaction.options.getString('args') || '')
// exactly like grammy's ctx.match.
const OPT_ARGS = { type: 3, name: 'args', description: 'Arguments (project, action, etc.)', required: false };

export const COMMAND_DEFS = [
  // ─── Core ────────────────────────────────────────────────────────────────
  { name: 'start',    description: 'Welcome message and setup instructions' },
  { name: 'auth',     description: 'Authenticate with a one-time code', options: [OPT_ARGS] },
  { name: 'status',   description: 'Current run + queue + budget' },
  { name: 'coach',    description: 'What should I do next? (state-aware guide)', options: [OPT_ARGS] },
  { name: 'projects', description: 'List all projects with status' },
  { name: 'project',  description: 'Show project detail', options: [OPT_ARGS] },
  { name: 'run',      description: 'Run an action on a project', options: [OPT_ARGS] },
  { name: 'cancel',   description: 'Stop a running job', options: [OPT_ARGS] },
  { name: 'queue',    description: 'Show pending jobs' },
  { name: 'dequeue',  description: 'Remove a pending job', options: [OPT_ARGS] },
  { name: 'history',  description: 'Recent completed jobs', options: [OPT_ARGS] },
  { name: 'help',     description: 'Command overview; /help <topic> for deep dive', options: [OPT_ARGS] },
  { name: 'docs',     description: 'Link to documentation', options: [OPT_ARGS] },

  // ─── Users ────────────────────────────────────────────────────────────────
  { name: 'users',    description: 'List allowlisted users' },

  // ─── Requirements & brief ─────────────────────────────────────────────────
  { name: 'req',           description: 'Capture a requirement', options: [OPT_ARGS] },
  { name: 'capture',       description: 'Enter multi-message capture mode', options: [OPT_ARGS] },
  { name: 'done',          description: 'Exit capture mode' },
  { name: 'inbox',         description: 'Browse requirement inbox', options: [OPT_ARGS] },
  { name: 'triage',        description: 'Fast tap-to-triage requirements', options: [OPT_ARGS] },
  { name: 'req_promote',   description: 'Promote inbox → raw-thoughts.md', options: [OPT_ARGS] },
  { name: 'brief_questions', description: 'View brief-questions.md + open-items count', options: [OPT_ARGS] },
  { name: 'newbrief',      description: 'Reset brief and optionally restart', options: [OPT_ARGS] },
  { name: 'discuss',       description: 'Start or view a multi-agent discussion', options: [OPT_ARGS] },
  { name: 'discuss_inspect', description: 'Inspect a discussion', options: [OPT_ARGS] },

  // ─── Bugs ─────────────────────────────────────────────────────────────────
  { name: 'bug',         description: 'Capture a bug', options: [OPT_ARGS] },
  { name: 'bug_capture', description: 'Enter multi-message bug capture mode', options: [OPT_ARGS] },
  { name: 'bug_done',    description: 'Exit bug capture mode' },
  { name: 'bugs_inbox',  description: 'Browse pending bugs', options: [OPT_ARGS] },
  { name: 'bug_promote', description: 'Promote bugs → new bug round + run', options: [OPT_ARGS] },
  { name: 'add_bug',     description: 'Add a bug directly to a round', options: [OPT_ARGS] },

  // ─── Reading artifacts ────────────────────────────────────────────────────
  { name: 'preview',  description: 'Stream a generated doc into chat', options: [OPT_ARGS] },
  { name: 'files',    description: 'List all readable artifacts for a project', options: [OPT_ARGS] },
  { name: 'file',     description: 'Download an artifact as a file', options: [OPT_ARGS] },
  { name: 'download', description: 'DM job logs as files', options: [OPT_ARGS] },

  // ─── Planning & cost ──────────────────────────────────────────────────────
  { name: 'predict',  description: 'Predict cost of upcoming work', options: [OPT_ARGS] },
  { name: 'budget',   description: 'Lifetime spend and cap for a project', options: [OPT_ARGS] },
  { name: 'spend',    description: 'Actual spend by task + model', options: [OPT_ARGS] },
  { name: 'suggest',  description: 'AI-powered next-feature suggestions', options: [OPT_ARGS] },
  { name: 'extend',   description: 'Extend a project with more work', options: [OPT_ARGS] },

  // ─── Phase management ────────────────────────────────────────────────────
  { name: 'inspect',    description: 'View phase report + diff', options: [OPT_ARGS] },
  { name: 'retry',      description: 'Retry a failed phase', options: [OPT_ARGS] },
  { name: 'promote',    description: 'Promote audit findings → bug round', options: [OPT_ARGS] },
  { name: 'validate',   description: 'Run registered validators', options: [OPT_ARGS] },
  { name: 'validators', description: 'Show validator run history', options: [OPT_ARGS] },
  { name: 'dashboard',  description: 'Generate telemetry dashboard', options: [OPT_ARGS] },
  { name: 'package',    description: 'Zip project workspace for download', options: [OPT_ARGS] },

  // ─── QA ───────────────────────────────────────────────────────────────────
  { name: 'qa_handoff', description: 'Generate tester-facing QA handoff doc', options: [OPT_ARGS] },

  // ─── Git + project lifecycle ──────────────────────────────────────────────
  { name: 'ship',           description: 'Fast-forward main to develop', options: [OPT_ARGS] },
  { name: 'git_status',     description: 'Show git status for a project', options: [OPT_ARGS] },
  { name: 'sync',           description: 'git fetch + ff-only pull', options: [OPT_ARGS] },
  { name: 'syncall',        description: 'Pull latest for all git-managed projects' },
  { name: 'new_project',    description: 'Register a new project', options: [OPT_ARGS] },
  { name: 'remove_project', description: 'Remove a project from the orchestrator', options: [OPT_ARGS] },
  { name: 'pin',            description: 'Pin a default project for argless commands', options: [OPT_ARGS] },
  { name: 'unpin',          description: 'Unpin the current default project' },
  { name: 'pinned',         description: 'Show your pinned project' },
  { name: 'message',        description: 'Send a free-form message in capture mode', options: [OPT_ARGS] },
];

/**
 * Register slash commands with Discord via REST.
 * Guild-scoped when guild_id is provided (instant); global otherwise (up to 1h).
 * Non-fatal — logs and returns { ok: false } on failure.
 */
export async function registerCommandMenu(client, guildId) {
  const rest = new REST().setToken(client.token);
  const clientId = client.application?.id;
  if (!clientId) {
    console.error(chalk.yellow('[command menu] client.application.id not available — skip registration'));
    return { ok: false, error: 'client not ready' };
  }

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('registerCommands timed out after 10s (Discord unreachable?)')), 10_000),
  );
  try {
    const route = guildId
      ? Routes.applicationGuildCommands(clientId, guildId)
      : Routes.applicationCommands(clientId);
    await Promise.race([
      rest.put(route, { body: COMMAND_DEFS }),
      timeout,
    ]);
    const scope = guildId ? `guild ${guildId}` : 'global';
    console.log(chalk.dim(`✓ Discord slash commands registered (${COMMAND_DEFS.length} commands, ${scope}).`));
    return { ok: true, count: COMMAND_DEFS.length };
  } catch (err) {
    console.error(chalk.yellow(`[command menu] command registration failed (non-fatal): ${err.message}`));
    return { ok: false, error: err.message };
  }
}

export function menuCommandNames() {
  return new Set(COMMAND_DEFS.map((c) => c.name));
}
