// Requirements Inbox — capture, refine, triage, promote (v0.7)
//
// Subcommands:
//   add <project> <text...>     Append a raw requirement to the inbox
//   list <project>              List requirements for a project
//   show <id>                   Show one requirement
//   triage <id>                 Set priority + scope on a single item
//   set <id> <field> <value>    Set any one field (priority/scope/status/tags/refined_text)
//   refine <project>            Run AI refinement over all inbox items
//   promote <project>           Append "scope=now" refined reqs into raw-thoughts.md
//   drop <id>                   Mark dropped (soft delete)
//   stats <project>             Show counts by status/scope/priority

import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';

import {
  addRequirement, getRequirement, listRequirements, updateRequirement,
  deleteRequirement, countRequirements, listProjectsWithRequirements,
  getProject,
} from '../state.js';
import { runClaude } from '../claude-runner.js';
import { resolve as resolveConfig } from '../config-resolver.js';
import { rawThoughtsPath, projectContextPath } from '../lib/guide-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');
const PROMPTS_DIR = path.join(REPO_ROOT, 'prompts');

const VALID_PRIORITIES = ['p0', 'p1', 'p2', 'p3', 'unassigned'];
const VALID_SCOPES = ['now', 'next', 'later', 'no', 'unassigned'];
const VALID_STATUSES = ['inbox', 'refined', 'promoted', 'dropped'];

const INBOX_PROJECT = '_inbox'; // virtual project for unscoped capture

function colorPriority(p) {
  if (p === 'p0') return chalk.red.bold(p);
  if (p === 'p1') return chalk.yellow(p);
  if (p === 'p2') return chalk.cyan(p);
  if (p === 'p3') return chalk.dim(p);
  return chalk.dim(p);
}
function colorScope(s) {
  if (s === 'now') return chalk.green.bold(s);
  if (s === 'next') return chalk.cyan(s);
  if (s === 'later') return chalk.dim(s);
  if (s === 'no') return chalk.red.dim(s);
  return chalk.dim(s);
}
function colorStatus(s) {
  if (s === 'inbox') return chalk.yellow(s);
  if (s === 'refined') return chalk.blue(s);
  if (s === 'promoted') return chalk.green(s);
  if (s === 'dropped') return chalk.dim.strikethrough(s);
  return s;
}

export async function cmdAdd(project, text, { source = 'cli', createdBy = null } = {}) {
  if (!text || !text.trim()) throw new Error('Cannot add empty requirement.');
  // Only enforce project-exists if not the magic _inbox name
  if (project !== INBOX_PROJECT && !getProject(project)) {
    throw new Error(`Project not found: ${project}. Use "${INBOX_PROJECT}" for unscoped capture.`);
  }
  const id = addRequirement({ project, raw_text: text.trim(), source, created_by: createdBy });
  return id;
}

export async function cmdList(project, { status, priority, scope, all = false } = {}) {
  const filter = { project };
  if (status) filter.status = status;
  if (priority) filter.priority = priority;
  if (scope) filter.scope = scope;
  if (!status && !all) filter.status = 'inbox'; // default to inbox

  const items = listRequirements(filter);

  console.log(chalk.bold(`\nRequirements — ${project}`));
  const filterDesc = [];
  if (filter.status) filterDesc.push(`status=${filter.status}`);
  if (filter.priority) filterDesc.push(`priority=${filter.priority}`);
  if (filter.scope) filterDesc.push(`scope=${filter.scope}`);
  if (filterDesc.length) console.log(chalk.dim(`Filter: ${filterDesc.join(', ')}`));
  console.log();

  if (!items.length) {
    console.log(chalk.dim('(no requirements)'));
    return;
  }
  for (const r of items) {
    const title = r.refined_text
      ? (extractRefinedTitle(r.refined_text) || r.raw_text.split('\n')[0])
      : r.raw_text.split('\n')[0];
    const truncated = title.length > 80 ? title.slice(0, 77) + '…' : title;
    console.log(
      `  ${chalk.bold('#' + String(r.id).padEnd(4))}`
      + `[${colorPriority(r.priority)}/${colorScope(r.scope)}/${colorStatus(r.status)}]  `
      + truncated,
    );
  }
  console.log();
}

function extractRefinedTitle(refined) {
  // Expect either JSON with title field, or markdown starting with `# Title` or `## Title`
  try {
    const obj = JSON.parse(refined);
    if (obj.title) return obj.title;
  } catch { /* not JSON */ }
  const m = refined.match(/^#+\s+(.+)$/m);
  if (m) return m[1].trim();
  return null;
}

export async function cmdShow(id) {
  const r = getRequirement(id);
  if (!r) { console.error(chalk.red(`Requirement #${id} not found.`)); process.exitCode = 1; return; }
  console.log(chalk.bold(`\n#${r.id} — ${r.project}`));
  console.log(`  ${chalk.dim('Status:')}   ${colorStatus(r.status)}`);
  console.log(`  ${chalk.dim('Priority:')} ${colorPriority(r.priority)}`);
  console.log(`  ${chalk.dim('Scope:')}    ${colorScope(r.scope)}`);
  console.log(`  ${chalk.dim('Source:')}   ${r.source}`);
  console.log(`  ${chalk.dim('Created:')}  ${r.created_at}`);
  if (r.tags) console.log(`  ${chalk.dim('Tags:')}     ${r.tags}`);
  if (r.promoted_to) console.log(`  ${chalk.dim('Promoted:')} ${r.promoted_to}`);
  console.log();
  console.log(chalk.bold('Raw:'));
  console.log('  ' + r.raw_text.split('\n').join('\n  '));
  console.log();
  if (r.refined_text) {
    console.log(chalk.bold('Refined:'));
    console.log('  ' + r.refined_text.split('\n').join('\n  '));
    console.log();
  }
}

export async function cmdSet(id, field, value) {
  const r = getRequirement(id);
  if (!r) { console.error(chalk.red(`Requirement #${id} not found.`)); process.exitCode = 1; return; }
  if (field === 'priority' && !VALID_PRIORITIES.includes(value)) {
    throw new Error(`priority must be one of: ${VALID_PRIORITIES.join(', ')}`);
  }
  if (field === 'scope' && !VALID_SCOPES.includes(value)) {
    throw new Error(`scope must be one of: ${VALID_SCOPES.join(', ')}`);
  }
  if (field === 'status' && !VALID_STATUSES.includes(value)) {
    throw new Error(`status must be one of: ${VALID_STATUSES.join(', ')}`);
  }
  updateRequirement(id, { [field]: value });
  console.log(chalk.green(`✓ #${id}.${field} = ${value}`));
}

export async function cmdTriage(id) {
  const r = getRequirement(id);
  if (!r) { console.error(chalk.red(`Requirement #${id} not found.`)); process.exitCode = 1; return; }
  await cmdShow(id);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));

  const pri = (await ask(`Priority [${VALID_PRIORITIES.join('/')}] (current: ${r.priority}): `)).trim();
  const scope = (await ask(`Scope [${VALID_SCOPES.join('/')}] (current: ${r.scope}): `)).trim();
  rl.close();

  const fields = {};
  if (pri && VALID_PRIORITIES.includes(pri)) fields.priority = pri;
  if (scope && VALID_SCOPES.includes(scope)) fields.scope = scope;
  if (Object.keys(fields).length === 0) {
    console.log(chalk.dim('No changes.'));
    return;
  }
  updateRequirement(id, fields);
  console.log(chalk.green(`✓ Updated #${id}: ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(', ')}`));
}

export async function cmdDrop(id) {
  const r = getRequirement(id);
  if (!r) { console.error(chalk.red(`Requirement #${id} not found.`)); process.exitCode = 1; return; }
  updateRequirement(id, { status: 'dropped' });
  console.log(chalk.green(`✓ #${id} marked dropped.`));
}

export async function cmdStats(project) {
  const counts = countRequirements(project);
  console.log(chalk.bold(`\n${project} — requirements summary\n`));
  if (!counts.length) {
    console.log(chalk.dim('(none)'));
    return;
  }
  for (const c of counts) {
    console.log(`  ${colorStatus(c.status).padEnd(20)} ${colorScope(c.scope).padEnd(20)} ${chalk.bold(c.n)}`);
  }
  console.log();
}

export async function cmdRefine(project) {
  const items = listRequirements({ project, status: 'inbox' });
  if (!items.length) {
    console.log(chalk.dim(`No inbox items for ${project}.`));
    return;
  }
  console.log(chalk.dim(`Refining ${items.length} item(s) via Sonnet…`));

  const cfg = await resolveConfig({ project: project === INBOX_PROJECT ? null : project, task: 'brief-author' });
  cfg.model = cfg.models?.['brief-author'] || cfg.model || 'claude-sonnet-4-6';

  // Optional project-context injection
  let contextExtra = null;
  if (project !== INBOX_PROJECT) {
    const projDir = path.join(PROJECTS_DIR, project);
    try {
      const ctx = await fs.readFile(projectContextPath(projDir), 'utf-8');
      if (ctx.trim()) {
        contextExtra = `<project_context>\n${ctx.trim()}\n</project_context>`;
      }
    } catch { /* no context file yet, fine */ }
  }

  const itemsBlock = items.map((r) => `${r.id}. ${r.raw_text.replace(/\n/g, ' ')}`).join('\n');
  const prompt = `You are refining a batch of raw requirements captured by a founder during the day, in their own words. Your job: for each, produce a structured refinement that preserves their intent and voice — do NOT invent features they didn't ask for.

For each input requirement, output a JSON object with these fields:
- id: (number, matches input id)
- title: (string, one concrete line — what to build)
- what: (string, 2-3 sentences on what the system should do)
- why: (string, 1-2 sentences on user value)
- touches: (string, likely affected files/modules; "unknown" if you can't tell)
- open_questions: (array of 2-3 specific questions that must be answered before implementation)

Respond ONLY with a JSON array of these objects, no preamble, no markdown fences. Preserve input order.

Raw requirements:
${itemsBlock}`;

  const result = await runClaude({
    cfg, cwd: REPO_ROOT, prompt,
    systemPromptFile: null,
    systemPromptExtra: contextExtra,
    // v0.14.12: project=null for _inbox refines so the post-call session
    // bookkeeping (upsertSession, setGuideSessionId) doesn't FK-fail against
    // the projects table. _inbox is a virtual project that doesn't exist as
    // a projects.name row, so the FK constraint would otherwise abort AFTER
    // Claude was already called — silently losing the refinement work AND
    // the API spend. Passing null is safe: claude-runner.js wraps all
    // project-bound writes in `if (project) { … }`.
    role: 'guide',
    project: project === INBOX_PROJECT ? null : project,
    task: 'requirement-refine',
  });
  if (result.is_error) {
    console.error(chalk.red('Refinement failed:'), result.error_message || 'see logs');
    return;
  }

  // Parse response
  const text = result.result || result.text || '';
  let refined;
  try {
    const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    refined = JSON.parse(cleaned);
  } catch (err) {
    console.error(chalk.red('Could not parse AI response as JSON:'), err.message);
    console.error(chalk.dim('Raw response (first 500 chars):'));
    console.error(text.slice(0, 500));
    return;
  }
  if (!Array.isArray(refined)) {
    console.error(chalk.red('AI response was not a JSON array.'));
    return;
  }

  let updated = 0;
  for (const r of refined) {
    if (!r || !r.id) continue;
    const refinedText = JSON.stringify({
      title: r.title || '',
      what: r.what || '',
      why: r.why || '',
      touches: r.touches || '',
      open_questions: r.open_questions || [],
    }, null, 2);
    updateRequirement(r.id, { refined_text: refinedText, status: 'refined' });
    updated += 1;
  }
  console.log(chalk.green(`\n✓ Refined ${updated}/${items.length} requirements for ${project}.`));
  console.log(chalk.dim(`Next: npm run req -- list ${project} --status refined`));
}

export async function withRequirementPromotionLock(destination, fn) {
  const lockPath = `${destination}.promote.lock`;
  let handle = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      handle = await fs.open(lockPath, 'wx');
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // A crashed promoter must not strand the inbox forever.
      try {
        const st = await fs.stat(lockPath);
        if (Date.now() - st.mtimeMs > 60_000) {
          await fs.unlink(lockPath);
          continue;
        }
      } catch { /* raced with the lock owner releasing it */ }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!handle) throw new Error('Requirement promotion is busy; retry in a moment');
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await fs.unlink(lockPath).catch(() => {});
  }
}

export async function cmdPromote(project, {
  scope = 'now', destination, ids = null, assertCanWrite = null,
} = {}) {
  if (project === INBOX_PROJECT) {
    throw new Error(`Cannot promote from ${INBOX_PROJECT}. Assign reqs to a real project first via: req-set <id> project <name>.`);
  }
  if (!getProject(project)) throw new Error(`Project not found: ${project}`);

  const projDir = path.join(PROJECTS_DIR, project);
  const dest = destination || rawThoughtsPath(projDir);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  return withRequirementPromotionLock(dest, async () => {
    if (typeof assertCanWrite === 'function') await assertCanWrite();
    // Refetch under the filesystem lock. Explicit ids are strict: silently
    // ignoring an unknown/cross-project id would let the UI report a false
    // success while writing nothing.
    let items;
    if (Array.isArray(ids) && ids.length) {
      items = ids.map((rawId) => {
        const r = getRequirement(Number(rawId));
        if (!r || r.project !== project) throw new Error(`Requirement not found in ${project}: ${rawId}`);
        return r;
      });
    } else {
      items = listRequirements({ project, scope });
    }
    const promotable = items.filter((r) => r.status !== 'promoted' && r.status !== 'dropped');
    if (!promotable.length) {
      console.log(chalk.dim(`No requirements with scope=${scope} to promote.`));
      return { promoted: 0, ids: [], destination: dest, alreadyPromoted: true };
    }

    const existing = await fs.readFile(dest, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return '';
      throw err;
    });
    const timestamp = new Date().toISOString();
    const tag = `req-promote-${timestamp.replace(/[:.]/g, '-')}`;
    const toAppend = promotable.filter((r) => !existing.includes(`<!-- requirement-id:${r.id} -->`));
    const lines = toAppend.length ? [
      '',
      `<!-- promoted from requirements inbox at ${timestamp} (scope=${scope}, ${toAppend.length} items) -->`,
      `## Promoted requirements (${scope}) — ${timestamp.slice(0, 10)}`,
      '',
    ] : [];
    for (const r of toAppend) {
      let block;
      if (r.refined_text) {
        try {
          const obj = JSON.parse(r.refined_text);
          block = [
            `<!-- requirement-id:${r.id} -->`,
            `### ${obj.title || '(no title)'}`,
            obj.what || '',
            obj.why ? `_Why: ${obj.why}_` : '',
            obj.touches ? `**Touches:** ${obj.touches}` : '',
            (obj.open_questions && obj.open_questions.length)
              ? '\n**Open questions:**\n' + obj.open_questions.map((q) => `- ${q}`).join('\n')
              : '',
            `_Raw: ${r.raw_text.replace(/\n/g, ' ')}_`,
            `_(req #${r.id}, priority ${r.priority})_`,
          ].filter((l) => l !== '').join('\n\n');
        } catch {
          block = `<!-- requirement-id:${r.id} -->\n### Requirement #${r.id}\n${r.raw_text}\n_(priority ${r.priority})_`;
        }
      } else {
        block = `<!-- requirement-id:${r.id} -->\n### Requirement #${r.id}\n${r.raw_text}\n_(priority ${r.priority}, not yet refined)_`;
      }
      lines.push(block, '');
    }
    if (lines.length) await fs.appendFile(dest, lines.join('\n'), 'utf-8');

    // If a prior process appended successfully but crashed before the DB
    // update, the marker path above repairs the row without duplicating text.
    for (const r of promotable) updateRequirement(r.id, { status: 'promoted', promoted_to: tag });

    console.log(chalk.green(`\n✓ Promoted ${promotable.length} requirement(s) for ${project}.`));
    console.log(chalk.dim(`  Appended to: ${dest}`));
    console.log(chalk.dim(`  Tag: ${tag}`));
    console.log(chalk.dim(`\nNext: review the file, then run: npm run brief -- ${project}`));
    return {
      promoted: promotable.length,
      appended: toAppend.length,
      ids: promotable.map((r) => Number(r.id)),
      destination: dest,
      tag,
    };
  });
}

export async function cmdProjects() {
  const rows = listProjectsWithRequirements();
  if (!rows.length) {
    console.log(chalk.dim('No requirements anywhere yet.'));
    return;
  }
  console.log(chalk.bold('\nProjects with requirements\n'));
  for (const row of rows) {
    console.log(`  ${chalk.bold(row.project.padEnd(30))} ${row.n} total`);
  }
  console.log();
}
