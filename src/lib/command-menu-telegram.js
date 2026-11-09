// Telegram bot command menu — registered via setMyCommands at server boot.
// Capped at 25 entries for mobile usability. Admin/power-user commands
// (/auth, /users, /budget, /spend) are registered in server-telegram.js
// but excluded here — discoverable via /help when needed.

import chalk from 'chalk';

export const COMMAND_MENU = [
  // ─── Core ─────────────────────────────────────────────────────────────
  { command: 'status',          description: 'Current run + queue + budget' },
  { command: 'coach',           description: 'What should I do next? (state-aware guide)' },
  { command: 'projects',        description: 'List projects with status' },
  { command: 'run',             description: 'Run an action on a project' },
  { command: 'cancel',          description: 'Stop a running job' },
  { command: 'help',            description: 'Command overview; /help <topic> for deep dive' },

  // ─── Requirements & brief ─────────────────────────────────────────────
  { command: 'req',             description: 'Capture one requirement' },
  { command: 'inbox',           description: 'Browse requirement inbox' },
  { command: 'triage',          description: 'Fast triage (priority + scope per item)' },
  { command: 'req_promote',     description: 'Promote inbox → raw-thoughts.md' },
  { command: 'brief_questions', description: 'View brief-questions.md + open-items count' },

  // ─── Bugs ─────────────────────────────────────────────────────────────
  { command: 'bug',             description: 'Capture a bug (with severity)' },
  { command: 'bugs_inbox',      description: 'Browse pending bugs' },
  { command: 'bug_promote',     description: 'Promote bugs → new bug round + run' },

  // ─── Reading artifacts ────────────────────────────────────────────────
  { command: 'preview',         description: 'Stream a generated doc into chat' },
  { command: 'files',           description: 'List files in a project workspace' },
  { command: 'download',        description: 'DM job logs as files' },

  // ─── Planning & cost ──────────────────────────────────────────────────
  { command: 'predict',         description: 'Predict cost of upcoming work' },
  { command: 'suggest',         description: 'AI-powered next-feature suggestions' },
  { command: 'promote',         description: 'Promote audit findings → bug round' },
  { command: 'inspect',         description: 'View phase report + diff' },
  { command: 'qa_handoff',      description: 'Generate QA handoff doc' },

  // ─── Git + project lifecycle ──────────────────────────────────────────
  { command: 'sync',            description: 'git fetch + ff-only pull' },
  { command: 'ship',            description: 'Fast-forward main to develop' },
  { command: 'pin',             description: 'Pin a default project for argless commands' },
];

export async function registerCommandMenu(bot) {
  try {
    await bot.api.setMyCommands(COMMAND_MENU);
    console.log(chalk.dim(`✓ Telegram command menu registered (${COMMAND_MENU.length} commands).`));
    return { ok: true, count: COMMAND_MENU.length };
  } catch (err) {
    console.error(chalk.yellow(`[command menu] setMyCommands failed (non-fatal): ${err.message}`));
    return { ok: false, error: err.message };
  }
}
