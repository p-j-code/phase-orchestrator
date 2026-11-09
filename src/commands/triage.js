// Triage Autopilot v0.10 — fast keypress-driven triage for the requirements inbox.
//
// Usage:
//   npm run triage -- <project>           — start, default to first inbox item
//   npm run triage -- <project> --refined — only items already AI-refined
//   npm run triage -- <project> --resume  — resume where you left off (skip already-triaged in this session)
//
// Keys:
//   0/1/2/3   — set priority (does NOT advance)
//   n / x / l — set scope (now/next/later) and advance
//   !         — set scope=no (out of plan) and advance
//   s         — skip without saving, advance
//   d         — drop (status='dropped'), advance
//   r         — show refined view if present
//   a         — AI-suggest priority+scope for current item (one Sonnet call)
//   Enter     — confirm pending AI suggestion (when one is shown)
//   ?         — show keybindings
//   q         — quit
//
// Scope is the advance trigger because it's the most actionable axis (now/next/later
// drives sprint planning). Priority is secondary and optional.

import path from 'node:path';
import fs from 'node:fs/promises';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';

import {
  listRequirements, updateRequirement, getProject,
} from '../state.js';
import { runClaude } from '../claude-runner.js';
import { resolve as resolveConfig } from '../config-resolver.js';
import { projectContextPath } from '../lib/guide-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

const INBOX_PROJECT = '_inbox';

// ANSI helpers
const CLEAR_SCREEN = '\x1b[2J\x1b[H';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

function colorPriority(p) {
  if (p === 'p0') return chalk.red.bold(p);
  if (p === 'p1') return chalk.yellow(p);
  if (p === 'p2') return chalk.cyan(p);
  if (p === 'p3') return chalk.dim(p);
  return chalk.dim(p);
}
function colorScope(s) {
  if (s === 'now')   return chalk.green.bold(s);
  if (s === 'next')  return chalk.cyan(s);
  if (s === 'later') return chalk.dim(s);
  if (s === 'no')    return chalk.red.dim(s);
  return chalk.dim(s);
}

function getTitleFromRefined(refined) {
  if (!refined) return null;
  try {
    const obj = JSON.parse(refined);
    return obj.title || null;
  } catch { /* not JSON */ }
  const m = refined.match(/^#+\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function renderItem(req, idx, total, suggestion, message) {
  const lines = [];
  lines.push(CLEAR_SCREEN);
  lines.push(chalk.bold(`Triage — item ${idx + 1} of ${total}`));
  lines.push(chalk.dim(`#${req.id}  •  ${req.project}  •  ${req.source}  •  created ${req.created_at.slice(0, 10)}`));
  lines.push('');

  const title = getTitleFromRefined(req.refined_text);
  if (title) {
    lines.push(chalk.bold(title));
    lines.push('');
  }

  // Raw text (always)
  lines.push(chalk.dim('Raw:'));
  for (const line of req.raw_text.split('\n')) {
    lines.push('  ' + line);
  }

  // Refined details (compact view)
  if (req.refined_text) {
    try {
      const obj = JSON.parse(req.refined_text);
      lines.push('');
      if (obj.what)  lines.push(chalk.dim('What:  ') + obj.what);
      if (obj.why)   lines.push(chalk.dim('Why:   ') + obj.why);
      if (obj.touches) lines.push(chalk.dim('Touches: ') + obj.touches);
      if (obj.open_questions?.length) {
        lines.push(chalk.dim('Open questions:'));
        for (const q of obj.open_questions) lines.push('  · ' + q);
      }
    } catch { /* not JSON */ }
  }

  lines.push('');
  lines.push(chalk.dim('─'.repeat(70)));
  lines.push(
    chalk.bold('Current: ') +
    'priority=' + colorPriority(req.priority) + '  ' +
    'scope=' + colorScope(req.scope),
  );

  if (suggestion) {
    lines.push(
      chalk.yellow.bold('AI suggestion: ') +
      'priority=' + colorPriority(suggestion.priority) + '  ' +
      'scope=' + colorScope(suggestion.scope) +
      chalk.dim(`  — ${suggestion.rationale || ''}`),
    );
    lines.push(chalk.dim('Press Enter to accept, or any key to override.'));
  }

  lines.push('');
  lines.push(chalk.dim('Keys: ') +
    chalk.bold('0/1/2/3') + ' priority • ' +
    chalk.bold('n/x/l') + ' scope (advances) • ' +
    chalk.bold('!') + ' scope=no • ' +
    chalk.bold('s') + ' skip • ' +
    chalk.bold('d') + ' drop • ' +
    chalk.bold('a') + ' AI suggest • ' +
    chalk.bold('q') + ' quit',
  );

  if (message) {
    lines.push('');
    lines.push(chalk.cyan('• ') + message);
  }

  return lines.join('\n');
}

async function aiSuggest(req, projectName) {
  const cfg = await resolveConfig({
    project: projectName === INBOX_PROJECT ? null : projectName,
    task: 'brief-author',
  });
  cfg.model = cfg.models?.['brief-author'] || cfg.model || 'claude-sonnet-4-6';

  // Load project context if available
  let contextExtra = null;
  if (projectName !== INBOX_PROJECT) {
    const projDir = path.join(PROJECTS_DIR, projectName);
    try {
      const ctx = await fs.readFile(projectContextPath(projDir), 'utf-8');
      if (ctx.trim()) {
        contextExtra = `<project_context>\n${ctx.trim()}\n</project_context>`;
      }
    } catch { /* no context file */ }
  }

  // Pull last 5 triaged items from this project as reference
  const refs = listRequirements({ project: projectName })
    .filter((r) => r.priority !== 'unassigned' && r.scope !== 'unassigned' && r.id !== req.id)
    .slice(-5);
  const refsBlock = refs.length
    ? '\n\nRecent triaged items from this project (reference, not to copy):\n'
      + refs.map((r) => `- "${r.raw_text.slice(0, 100).replace(/\n/g, ' ')}" → priority=${r.priority} scope=${r.scope}`).join('\n')
    : '';

  const prompt = `Suggest a priority and scope for this requirement.

Priority scale:
- p0: critical, ship before anything else (security, broken-in-prod, regulatory)
- p1: high, ship this cycle
- p2: medium, ship when convenient
- p3: low, fine to defer indefinitely

Scope scale:
- now: include in the next brief/dev cycle
- next: include in the cycle after this one
- later: keep, but no commitment
- no: out of plan — keep as record but won't be built

Raw text: ${req.raw_text}${refsBlock}

Respond with ONLY a JSON object (no markdown fences, no preamble):
{"priority":"p0"|"p1"|"p2"|"p3","scope":"now"|"next"|"later"|"no","rationale":"one sentence under 20 words"}`;

  const result = await runClaude({
    cfg, cwd: REPO_ROOT, prompt,
    systemPromptFile: null,
    systemPromptExtra: contextExtra,
    role: 'guide', project: projectName, task: 'requirement-refine',
  });
  if (result.is_error) throw new Error(result.error_message || 'AI suggest call failed');
  const text = (result.result || '').replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const obj = JSON.parse(text);
  if (!obj.priority || !obj.scope) throw new Error('AI returned incomplete suggestion');
  return obj;
}

export async function startTriage(projectName, { refinedOnly = false } = {}) {
  if (projectName !== INBOX_PROJECT && !getProject(projectName)) {
    console.error(chalk.red(`Project not found: ${projectName}`));
    process.exit(1);
  }

  // Load inbox items (and optionally refined)
  const statuses = refinedOnly ? ['refined'] : ['inbox', 'refined'];
  const allItems = statuses.flatMap((s) => listRequirements({ project: projectName, status: s }));
  if (!allItems.length) {
    console.log(chalk.dim(`No items to triage in ${projectName}${refinedOnly ? ' (--refined filter)' : ''}.`));
    return;
  }

  // Stats tracked across session
  const stats = { processed: 0, priorityChanged: 0, scopeChanged: 0, dropped: 0, skipped: 0, aiSuggested: 0 };

  // Set up raw mode for single-keypress input
  if (!process.stdin.isTTY) {
    console.error(chalk.red('Triage TUI requires a TTY. Use `npm run req -- <project> set <id> ...` for headless updates.'));
    process.exit(1);
  }

  process.stdout.write(HIDE_CURSOR);
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const restore = () => {
    try { process.stdin.setRawMode(false); } catch { /* ignore */ }
    process.stdin.pause();
    process.stdout.write(SHOW_CURSOR + '\n');
  };

  let exitRequested = false;
  let idx = 0;
  let suggestion = null;
  let message = null;

  const refreshScreen = () => {
    process.stdout.write(renderItem(allItems[idx], idx, allItems.length, suggestion, message));
    message = null; // one-shot
  };

  const advance = () => {
    suggestion = null;
    idx += 1;
    if (idx >= allItems.length) {
      exitRequested = true;
      return;
    }
    refreshScreen();
  };

  refreshScreen();

  return new Promise((resolve) => {
    const cleanup = () => {
      restore();
      process.stdin.removeListener('keypress', onKey);
      // Final summary
      console.log(chalk.bold('\nTriage summary'));
      console.log(`  Items reviewed:      ${stats.processed}`);
      console.log(`  Priority set/changed: ${stats.priorityChanged}`);
      console.log(`  Scope set/changed:    ${stats.scopeChanged}`);
      console.log(`  Dropped:              ${stats.dropped}`);
      console.log(`  Skipped:              ${stats.skipped}`);
      console.log(`  AI suggestions:       ${stats.aiSuggested}`);
      console.log();

      // Next-actions hint
      try {
        import('../lib/next-actions.js').then(({ getNextActions, renderNextActionsCli }) => {
          const hasPromotable = allItems.some((r) => r.scope === 'now' && r.status !== 'promoted');
          const hasInbox = allItems.some((r) => r.status === 'inbox' || r.status === 'refined');
          const actions = getNextActions({
            project: projectName,
            lastAction: 'triage-complete',
            state: { hasPromotable, hasInbox },
          });
          process.stdout.write(renderNextActionsCli(actions));
        }).catch(() => { /* silent */ });
      } catch { /* ignore */ }

      resolve();
    };

    const onKey = async (str, key) => {
      if (!key) return;
      if (exitRequested) return cleanup();

      const current = allItems[idx];

      // Ctrl-C or q → quit
      if ((key.ctrl && key.name === 'c') || key.name === 'q') {
        return cleanup();
      }

      // Enter → accept AI suggestion if present
      if (key.name === 'return') {
        if (suggestion) {
          updateRequirement(current.id, { priority: suggestion.priority, scope: suggestion.scope });
          stats.priorityChanged += 1;
          stats.scopeChanged += 1;
          stats.processed += 1;
          advance();
        }
        return;
      }

      // Skip
      if (key.name === 's') {
        stats.skipped += 1;
        advance();
        return;
      }

      // Drop
      if (key.name === 'd') {
        updateRequirement(current.id, { status: 'dropped' });
        stats.dropped += 1;
        stats.processed += 1;
        advance();
        return;
      }

      // AI suggest
      if (key.name === 'a') {
        message = chalk.dim('Asking Sonnet for a suggestion…');
        refreshScreen();
        try {
          suggestion = await aiSuggest(current, projectName);
          stats.aiSuggested += 1;
          refreshScreen();
        } catch (err) {
          suggestion = null;
          message = chalk.red('AI suggest failed: ' + err.message.split('\n')[0]);
          refreshScreen();
        }
        return;
      }

      // Priority (no advance)
      if (['0', '1', '2', '3'].includes(str)) {
        const newPri = 'p' + str;
        if (current.priority !== newPri) {
          updateRequirement(current.id, { priority: newPri });
          current.priority = newPri;
          stats.priorityChanged += 1;
        }
        message = `priority → ${newPri}`;
        refreshScreen();
        return;
      }

      // Scope (advances)
      const scopeMap = { n: 'now', x: 'next', l: 'later', '!': 'no' };
      if (scopeMap[str] || scopeMap[key.name]) {
        const newScope = scopeMap[str] || scopeMap[key.name];
        const updates = { scope: newScope };
        if (current.status === 'dropped') updates.status = 'inbox'; // un-drop if user is actively triaging
        updateRequirement(current.id, updates);
        if (current.scope !== newScope) stats.scopeChanged += 1;
        stats.processed += 1;
        advance();
        return;
      }

      // Help
      if (key.name === '?' || str === '?') {
        message = 'Keys: 0/1/2/3 priority • n/x/l scope (advances) • ! scope=no • s skip • d drop • a AI suggest • r refined view • q quit';
        refreshScreen();
        return;
      }

      // Unknown — silently ignore
    };

    process.stdin.on('keypress', onKey);
    process.on('SIGINT', () => {
      if (!exitRequested) {
        exitRequested = true;
        cleanup();
      }
    });
  });
}
