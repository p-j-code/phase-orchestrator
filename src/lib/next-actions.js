// Next-Actions Engine v0.11.3 — context-aware "what next" suggestions
// rendered as a list (CLI) or inline-keyboard buttons (Telegram).
//
// Usage:
//   import { getNextActions, renderNextActionsCli, renderNextActionsTelegram } from './next-actions.js';
//   const actions = getNextActions({ project: 'billflow-tds', lastAction: 'audit' });
//   console.log(renderNextActionsCli(actions));
//
// Or for Telegram:
//   const { text, keyboard } = renderNextActionsTelegram(actions, { compact: true });
//   ctx.reply(text, { reply_markup: keyboard, parse_mode: 'HTML' });

import chalk from 'chalk';
import { classifyPauseReason, PAUSE_KINDS } from './pause-classifier.js';

// Telegram inline-keyboard helper (lazy-imported to avoid bundling grammy in CLI paths)
async function getInlineKeyboard() {
  const { InlineKeyboard } = await import('grammy');
  return InlineKeyboard;
}

// Discord keyboard helper (lazy-imported to avoid bundling discord.js in CLI paths)
async function getDiscordKeyboard() {
  const { DiscordKeyboard } = await import('./discord-compat.js');
  return DiscordKeyboard;
}

/**
 * Returns ranked next-action suggestions.
 *
 * @param {object} ctx
 * @param {string} ctx.project - project name
 * @param {string} ctx.lastAction - e.g. 'plan', 'audit', 'roadmap', 'brief', 'go', 'phase',
 *                                  'review', 'bugs', 'qa-handoff', 'triage', 'req-added',
 *                                  'validator-failed', 'preview'
 * @param {object} [ctx.state] - optional additional state hints:
 *   - currentPhase, totalPhases (for phase progression)
 *   - bugRoundActive (number|null) - active bug round if any
 *   - hasInbox (boolean) - project has inbox items
 *   - hasPromotable (boolean) - has scope=now items waiting to be promoted
 *   - bugRoundComplete (number|null) - the round number just completed
 *   - pauseReason (string|null) - why a run paused
 *
 * @returns {Array<NextAction>}
 *
 * NextAction = { label, cmd, type: 'telegram'|'cli'|'info', priority, description?, emoji?, category? }
 */
export function getNextActions({ project, lastAction, state = {} }) {
  const actions = [];
  const add = (a) => actions.push({ category: 'general', ...a });

  // ─── Generic always-available ────────────────────────────────────────────
  // (low priority, fall-back options)

  const alwaysOptions = () => {
    add({ label: '📊 Project status', cmd: `/project ${project}`, type: 'telegram', priority: 10, category: 'status' });
    add({ label: '📦 Download zip', cmd: `/download ${project}`, type: 'telegram', priority: 8, category: 'utility' });
    add({ label: '📚 More commands', cmd: '/help', type: 'telegram', priority: 5, category: 'help' });
  };

  // ─── Per-action rules ────────────────────────────────────────────────────

  switch (lastAction) {
    case 'plan': {
      add({ label: '📖 Read plan', cmd: `/preview ${project} plan`, type: 'telegram', priority: 100, category: 'review' });
      add({ label: '▶ Start auto-run', cmd: `/run ${project} go`, type: 'telegram', priority: 95, category: 'execute', description: 'Begin executing the planned phases' });
      add({ label: '📝 Refine brief', cmd: `npm run brief -- ${project}`, type: 'cli', priority: 80, category: 'refine' });
      add({ label: '🔍 Audit current state', cmd: `/run ${project} audit`, type: 'telegram', priority: 60, category: 'analyze' });
      break;
    }

    case 'audit': {
      add({ label: '📖 Read audit', cmd: `/preview ${project} audit`, type: 'telegram', priority: 100, category: 'review' });
      add({ label: '📥 Save findings to bug inbox', cmd: `/bugs_inbox ${project}`, type: 'telegram', priority: 95, category: 'plan', description: 'Capture findings as bugs to triage + promote when ready. Or use /bug to add individual ones.' });
      add({ label: '🗺 Generate roadmap', cmd: `/run ${project} roadmap`, type: 'telegram', priority: 90, category: 'plan', description: 'Convert audit findings into a phased roadmap' });
      add({ label: '🐛 Bug-fix plan', cmd: `npm run guide -- ${project} --task bug-plan`, type: 'cli', priority: 85, category: 'plan', description: 'Generate a fix plan from audit findings' });
      add({ label: '📝 Update brief', cmd: `npm run brief -- ${project}`, type: 'cli', priority: 70, category: 'refine' });
      add({ label: '📋 QA handoff', cmd: `npm run qa-handoff -- ${project} --with-steps`, type: 'cli', priority: 60, category: 'qa' });
      break;
    }

    case 'bug-added': {
      add({ label: '📋 Show bug inbox', cmd: `/bugs_inbox ${project}`, type: 'telegram', priority: 100, category: 'review' });
      add({ label: '➕ Add another', cmd: `/bug_capture ${project}`, type: 'telegram', priority: 90, category: 'capture' });
      add({ label: '🚀 Promote to bug round', cmd: `npm run bug -- promote ${project}`, type: 'cli', priority: 80, category: 'execute', description: 'Generate bugs.md for round-N+1 from inbox items' });
      add({ label: '🚨 Promote criticals + run now', cmd: `npm run bug -- promote --severity critical --run ${project}`, type: 'cli', priority: 70, category: 'execute' });
      add({ label: '🤖 AI refine bug inbox', cmd: `npm run bug -- refine ${project}`, type: 'cli', priority: 60, category: 'refine' });
      break;
    }

    case 'bug-promoted': {
      add({ label: '▶ Run bug round', cmd: `/run ${project} bugs`, type: 'telegram', priority: 100, category: 'execute', description: 'Execute fixes from the bugs.md just created' });
      add({ label: '📖 Read bugs.md', cmd: `/preview ${project} bugs:${state.bugRoundActive || ''}`, type: 'telegram', priority: 90, category: 'review' });
      add({ label: '📋 Show remaining inbox', cmd: `/bugs_inbox ${project}`, type: 'telegram', priority: 70, category: 'review' });
      break;
    }

    case 'roadmap': {
      add({ label: '📖 Read roadmap', cmd: `/preview ${project} roadmap`, type: 'telegram', priority: 100, category: 'review' });
      add({ label: '🚀 Spin off one item as new project', cmd: `npm run roadmap-accept -- ${project} --item <N> --new-project <name> --profile <profile>`, type: 'cli', priority: 95, category: 'dev', description: 'Single roadmap item → standalone new project' });
      add({ label: '🚀 Spin off multiple as one project', cmd: `npm run roadmap-accept -- ${project} --items 1,3,5 --new-project <name>`, type: 'cli', priority: 92, category: 'dev', description: 'Group several related items under one new project. Use 1-5 for ranges, --all for everything.' });
      add({ label: '📥 Dump all items to inbox', cmd: `npm run roadmap-accept -- ${project} --all --to-inbox _inbox`, type: 'cli', priority: 90, category: 'dev', description: 'Each item becomes a triagable requirement. Triage → promote → brief → plan → go.' });
      add({ label: '📝 Extend current project', cmd: `npm run brief -- ${project}`, type: 'cli', priority: 75, category: 'refine', description: 'Manually merge roadmap insights into raw-thoughts.md, then re-brief → re-plan → go' });
      add({ label: '🐛 Treat as deferred fixes', cmd: `npm run guide -- ${project} --task bug-plan`, type: 'cli', priority: 70, category: 'dev', description: 'If roadmap items are really deferred bugs/improvements rather than new features' });
      add({ label: '🔍 Audit current state', cmd: `/run ${project} audit`, type: 'telegram', priority: 60, category: 'analyze' });
      add({ label: '▶ Continue existing plan', cmd: `/run ${project} go`, type: 'telegram', priority: 50, category: 'execute', description: 'Note: this runs the EXISTING plan, not the roadmap' });
      break;
    }

    case 'roadmap-accepted': {
      // After spinning off a new project from a roadmap item
      const newProj = state.newProject || project;
      add({ label: `📝 Draft brief for ${newProj}`, cmd: `npm run brief -- ${newProj}`, type: 'cli', priority: 100, category: 'plan' });
      add({ label: '📋 Generate plan', cmd: `npm run guide -- ${newProj} --task plan`, type: 'cli', priority: 95, category: 'plan' });
      add({ label: '▶ Auto-run when planned', cmd: `/run ${newProj} go`, type: 'telegram', priority: 80, category: 'execute' });
      add({ label: '📊 Predict cost', cmd: `npm run predict -- ${newProj}`, type: 'cli', priority: 60, category: 'analyze' });
      break;
    }

    case 'brief': {
      add({ label: '📖 Read brief', cmd: `/preview ${project} brief`, type: 'telegram', priority: 100, category: 'review' });
      add({ label: '📋 Generate plan', cmd: `npm run guide -- ${project} --task plan`, type: 'cli', priority: 95, category: 'plan' });
      add({ label: '▶ Start auto-run', cmd: `/run ${project} go`, type: 'telegram', priority: 80, category: 'execute' });
      break;
    }

    case 'go':
    case 'auto-run-completed': {
      add({ label: '🔍 Audit shipped state', cmd: `/run ${project} audit`, type: 'telegram', priority: 100, category: 'analyze' });
      add({ label: '📋 QA handoff', cmd: `npm run qa-handoff -- ${project} --phases 1:${state.totalPhases || 8} --with-steps`, type: 'cli', priority: 90, category: 'qa' });
      add({ label: '📦 Package project', cmd: `npm run package -- ${project}`, type: 'cli', priority: 80, category: 'utility' });
      add({ label: '✓ Mark shipped', cmd: `/run ${project} ship`, type: 'telegram', priority: 70, category: 'execute' });
      break;
    }

    case 'auto-run-paused': {
      const reason = state.pauseReason || '';
      // Path B: use stored kind if available; fall back to classifier for legacy rows (pause_kind IS NULL)
      const kind = state.pauseKind ?? classifyPauseReason(reason);

      if (kind === PAUSE_KINDS.ALL_PHASES_COMPLETE || kind === PAUSE_KINDS.FIX_ROUND_COMPLETE) {
        const isFixRound = kind === PAUSE_KINDS.FIX_ROUND_COMPLETE;
        if (isFixRound) {
          add({ label: '📖 Read fix reports', cmd: `npm run inspect -- ${project}`, type: 'cli', priority: 100, category: 'review' });
          add({ label: '🐛 Capture next-round bugs', cmd: `/bug_capture ${project}`, type: 'telegram', priority: 90, category: 'capture' });
        } else {
          add({ label: '🐛 Capture a QA bug', cmd: `/bug_capture ${project}`, type: 'telegram', priority: 100, category: 'capture' });
          add({ label: '✓ Mark shipped', cmd: `/run ${project} ship`, type: 'telegram', priority: 60, category: 'execute' });
        }
        add({ label: '🔍 Final audit', cmd: `/run ${project} audit`, type: 'telegram', priority: 85, category: 'analyze' });
        add({ label: '📋 QA handoff', cmd: `npm run qa-handoff -- ${project}`, type: 'cli', priority: 75, category: 'qa' });
        break;
      }

      if (kind === PAUSE_KINDS.BUDGET) {
        add({ label: '💰 Inspect cost', cmd: `npm run inspect -- ${project}`, type: 'cli', priority: 100, category: 'analyze',
              description: 'Check call count and cost breakdown' });
        add({ label: '⚙ Bump budget in project.json', cmd: `npm run config -- ${project}`, type: 'cli', priority: 90, category: 'configure',
              description: 'Edit max_total_calls in project.json then resume' });
        // Every other recoverable pause kind surfaces Resume; budget pauses are
        // recovered by bump-then-resume, so the Resume affordance belongs here
        // too (the Bump button's own text instructs the user to "then resume").
        add({ label: '▶ Resume', cmd: `/run ${project} resume`, type: 'telegram', priority: 80, category: 'execute',
              description: 'Continue the run once the budget is bumped' });
        add({ label: '✗ Cancel & investigate', cmd: '/cancel', type: 'telegram', priority: 40, category: 'execute' });
        break;
      }

      if (kind === PAUSE_KINDS.VALIDATOR_FAILED) {
        add({ label: '▶ Resume', cmd: `/run ${project} resume`, type: 'telegram', priority: 100, category: 'execute',
              description: reason ? `Was paused: ${reason}` : null });
        add({ label: '🧪 Validator history', cmd: `npm run validators -- ${project}`, type: 'cli', priority: 95, category: 'analyze',
              description: 'See which validator failed and stderr tail' });
        add({ label: '🔍 Inspect last phase', cmd: `npm run inspect -- ${project}`, type: 'cli', priority: 80, category: 'analyze' });
        break;
      }

      // review-checkpoint, max-actions, mid-build, other — Resume is correct
      add({ label: '▶ Resume', cmd: `/run ${project} resume`, type: 'telegram', priority: 100, category: 'execute',
            description: reason ? `Was paused: ${reason}` : null });
      add({ label: '🔍 Inspect last phase', cmd: `npm run inspect -- ${project}`, type: 'cli', priority: 80, category: 'analyze' });
      add({ label: '📊 Project status', cmd: `/project ${project}`, type: 'telegram', priority: 60, category: 'status' });
      add({ label: '✗ Cancel & investigate', cmd: '/cancel', type: 'telegram', priority: 40, category: 'execute' });
      break;
    }

    case 'auto-run-cancelled': {
      add({ label: '🔍 Inspect last phase', cmd: `npm run inspect -- ${project}`, type: 'cli', priority: 100, category: 'analyze', description: 'Check git status and last committed state' });
      add({ label: '🔁 Restart from plan', cmd: `/run ${project} go`, type: 'telegram', priority: 90, category: 'execute', description: 'Re-run from phase 1 with fresh state' });
      add({ label: '▶ Resume from checkpoint', cmd: `/run ${project} resume`, type: 'telegram', priority: 40, category: 'execute', description: 'Only if workspace is in a safe state' });
      add({ label: '📊 Project status', cmd: `/project ${project}`, type: 'telegram', priority: 30, category: 'status' });
      break;
    }

    case 'auto-run-failed': {
      add({ label: '🔍 Inspect failure', cmd: `npm run inspect -- ${project}`, type: 'cli', priority: 100, category: 'analyze' });
      add({ label: '🔁 Retry from last phase', cmd: `npm run retry-phase -- ${project}`, type: 'cli', priority: 90, category: 'execute' });
      add({ label: '▶ Resume', cmd: `/run ${project} resume`, type: 'telegram', priority: 70, category: 'execute' });
      add({ label: '📊 Project status', cmd: `/project ${project}`, type: 'telegram', priority: 50, category: 'status' });
      break;
    }

    case 'phase-complete': {
      if (state.currentPhase < state.totalPhases) {
        add({ label: '▶ Continue to next phase', cmd: `/run ${project} resume`, type: 'telegram', priority: 100, category: 'execute' });
      }
      if (state.currentPhase) {
        add({ label: `📖 Read phase ${state.currentPhase} report`, cmd: `/preview ${project} phase:${state.currentPhase}`, type: 'telegram', priority: 95, category: 'review' });
      }
      add({ label: '🧪 Validator history', cmd: `npm run validators -- ${project}`, type: 'cli', priority: 60, category: 'analyze' });
      break;
    }

    case 'review-complete': {
      if (state.currentPhase && state.currentPhase < state.totalPhases) {
        add({ label: '▶ Continue', cmd: `/run ${project} resume`, type: 'telegram', priority: 100, category: 'execute' });
      } else {
        add({ label: '🔍 Audit final state', cmd: `/run ${project} audit`, type: 'telegram', priority: 100, category: 'analyze' });
      }
      add({ label: '📖 Read review', cmd: `/preview ${project} review:${state.afterPhase || state.currentPhase}`, type: 'telegram', priority: 80, category: 'review' });
      break;
    }

    case 'bugs':
    case 'bug-round-complete': {
      const r = state.bugRoundComplete || state.bugRoundActive;
      if (r) {
        add({ label: `📋 QA handoff (round ${r})`, cmd: `npm run qa-handoff -- ${project} --round ${r} --with-steps`, type: 'cli', priority: 100, category: 'qa' });
        add({ label: `📖 Read fix reports`, cmd: `/preview ${project} bugs:${r}`, type: 'telegram', priority: 90, category: 'review' });
        add({ label: '🧪 Re-run all validators', cmd: `npm run validate -- ${project} --all`, type: 'cli', priority: 80, category: 'verify' });
      }
      add({ label: '🔍 Fresh audit', cmd: `/run ${project} audit`, type: 'telegram', priority: 70, category: 'analyze' });
      add({ label: '📦 Package project', cmd: `npm run package -- ${project}`, type: 'cli', priority: 50, category: 'utility' });
      break;
    }

    case 'qa-handoff': {
      add({ label: '📖 Read handoff', cmd: `/preview ${project} qa${state.bugRoundComplete ? ':' + state.bugRoundComplete : ''}`, type: 'telegram', priority: 100, category: 'review' });
      add({ label: '📦 Download project zip', cmd: `/download ${project}`, type: 'telegram', priority: 80, category: 'utility', description: 'Includes the handoff under .guide/qa-handoffs/' });
      add({ label: '✓ Mark shipped', cmd: `/run ${project} ship`, type: 'telegram', priority: 70, category: 'execute' });
      break;
    }

    case 'triage':
    case 'triage-complete': {
      if (state.hasPromotable) {
        add({ label: '📝 Promote scope=now items', cmd: `npm run req -- promote --scope now ${project}`, type: 'cli', priority: 100, category: 'plan', description: 'Append to raw-thoughts.md for the next brief' });
        add({ label: '📝 Then draft brief', cmd: `npm run brief -- ${project}`, type: 'cli', priority: 95, category: 'plan' });
      }
      if (state.hasInbox) {
        add({ label: '🔁 More triage', cmd: `/triage ${project}`, type: 'telegram', priority: 80, category: 'review' });
        add({ label: '🤖 AI refine inbox first', cmd: `npm run req -- refine ${project}`, type: 'cli', priority: 70, category: 'refine' });
      }
      add({ label: '📋 Show inbox stats', cmd: `npm run req -- stats ${project}`, type: 'cli', priority: 60, category: 'status' });
      break;
    }

    case 'req-added': {
      add({ label: '📋 Show inbox', cmd: `/inbox ${project}`, type: 'telegram', priority: 100, category: 'review' });
      add({ label: '⚡ Fast triage', cmd: `/triage ${project}`, type: 'telegram', priority: 90, category: 'review' });
      add({ label: '🤖 AI refine', cmd: `npm run req -- refine ${project}`, type: 'cli', priority: 70, category: 'refine' });
      add({ label: '➕ Add another', cmd: `/capture ${project}`, type: 'telegram', priority: 50, category: 'capture' });
      break;
    }

    case 'validator-failed': {
      add({ label: '🔍 Validator history', cmd: `npm run validators -- ${project}`, type: 'cli', priority: 100, category: 'analyze' });
      add({ label: '🧪 Re-run failed validator', cmd: `npm run validate -- ${project} --all`, type: 'cli', priority: 90, category: 'verify' });
      add({ label: '▶ Resume (after fix)', cmd: `/run ${project} resume`, type: 'telegram', priority: 80, category: 'execute' });
      break;
    }

    case 'preview-shown': {
      add({ label: '📊 Project status', cmd: `/project ${project}`, type: 'telegram', priority: 100, category: 'status' });
      add({ label: '📚 More options', cmd: `/files ${project}`, type: 'telegram', priority: 90, category: 'help' });
      break;
    }

    default:
      // Unknown action — surface general options
      break;
  }

  // Always-available low-priority options
  alwaysOptions();

  // Sort descending by priority and de-dup by cmd
  const seen = new Set();
  return actions
    .sort((a, b) => b.priority - a.priority)
    .filter((a) => {
      if (seen.has(a.cmd)) return false;
      seen.add(a.cmd);
      return true;
    });
}

// ─── CLI renderer ──────────────────────────────────────────────────────────

/**
 * Renders next-action suggestions as a terminal block. Returns a string.
 */
export function renderNextActionsCli(actions, { max = 5 } = {}) {
  if (!actions || actions.length === 0) return '';
  const top = actions.slice(0, max);
  const lines = [];
  lines.push('');
  lines.push(chalk.bold.cyan('▸ What next:'));
  for (const a of top) {
    const cmdStyled = a.type === 'cli'
      ? chalk.bold(a.cmd)
      : chalk.bold.magenta(a.cmd) + chalk.dim(' (Telegram)');
    lines.push(`  ${cmdStyled}`);
    lines.push(chalk.dim(`    ${a.label}` + (a.description ? ` — ${a.description}` : '')));
  }
  if (actions.length > max) {
    lines.push(chalk.dim(`  (${actions.length - max} more — see docs/NEW_FEATURES.md or /help in Telegram)`));
  }
  lines.push('');
  return lines.join('\n');
}

// ─── Telegram renderer ─────────────────────────────────────────────────────

/**
 * Builds a Telegram inline keyboard from suggestions. Returns { text, keyboard }.
 *
 * Top 4 actions become primary buttons. If there are more, adds a "📚 More options"
 * button that triggers a callback to expand the list (handled by handleNextActionsCallback).
 *
 * @param {object} opts
 * @param {string} opts.headerText - text shown above the buttons
 * @param {boolean} opts.compact - if true, shows 4 buttons + more; if false, all up to 8
 */
export async function renderNextActionsTelegram(actions, { headerText = '', compact = true, contextId = '' } = {}) {
  if (!actions || actions.length === 0) return { text: headerText, keyboard: null };
  const InlineKeyboard = await getInlineKeyboard();
  const kb = new InlineKeyboard();

  const max = compact ? 4 : 8;
  const top = actions.slice(0, max);

  // Layout: 2 buttons per row
  for (let i = 0; i < top.length; i += 2) {
    const a = top[i];
    const b = top[i + 1];
    kb.text(a.label, `na:exec:${i}:${contextId}`);
    if (b) kb.text(b.label, `na:exec:${i + 1}:${contextId}`);
    kb.row();
  }

  // "More options" button if there are more
  if (actions.length > max) {
    kb.text(`📚 More options (${actions.length - max})`, `na:more:${contextId}`);
  }

  return {
    text: headerText,
    keyboard: kb,
    actions: top.concat(actions.length > max ? actions.slice(max) : []),
  };
}

/**
 * Builds a Discord component array from suggestions. Returns { text, keyboard }.
 * keyboard is an ActionRow array ready for interaction.reply({ components }).
 * Drop-in replacement for renderNextActionsTelegram in Discord contexts.
 */
export async function renderNextActionsDiscord(actions, { headerText = '', compact = true, contextId = '' } = {}) {
  if (!actions || actions.length === 0) return { text: headerText, keyboard: null };
  const DiscordKeyboard = await getDiscordKeyboard();
  const kb = new DiscordKeyboard();

  const max = compact ? 4 : 8;
  const top = actions.slice(0, max);

  for (let i = 0; i < top.length; i += 2) {
    const a = top[i];
    const b = top[i + 1];
    kb.text(a.label, `na:exec:${i}:${contextId}`);
    if (b) kb.text(b.label, `na:exec:${i + 1}:${contextId}`);
    kb.row();
  }

  if (actions.length > max) {
    kb.text(`📚 More options (${actions.length - max})`, `na:more:${contextId}`);
  }

  return {
    text: headerText,
    keyboard: kb.toComponents(), // ActionRow array — pass directly to components:
    actions: top.concat(actions.length > max ? actions.slice(max) : []),
  };
}

/**
 * Returns just the text representation (for environments where buttons aren't suitable).
 */
export function renderNextActionsTelegramText(actions, { max = 5 } = {}) {
  if (!actions || actions.length === 0) return '';
  const top = actions.slice(0, max);
  const lines = ['', '<b>What next:</b>'];
  for (const a of top) {
    const cmdEscaped = a.cmd.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    lines.push(`  ${a.label}`);
    lines.push(`    <code>${cmdEscaped}</code>`);
  }
  return lines.join('\n');
}
