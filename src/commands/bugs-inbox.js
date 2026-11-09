// Bug Inbox CLI (v0.12.0)
//
// Subcommands:
//   add <project> <text...>         Append a bug to the inbox
//   add <project> --critical <text> Mark as critical
//   list <project>                  List pending bugs (sorted by severity)
//   show <id>                       Show one bug in detail
//   set <id> <field> <value>        Update field (severity, status, tags, refined_text)
//   drop <id>                       Mark dropped (soft delete)
//   refine <project>                AI-structure raw bug texts into title/repro/expected
//   promote <project>               Create new bug round from inbox + refined items
//     [--severity critical]         Only promote criticals
//     [--ids 1,3,5]                 Promote specific bug IDs
//     [--run]                       Auto-start the bug round after promoting
//   stats <project>                 Counts by status × severity

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';

import {
  addBug, getBug, listBugs, updateBug, deleteBug, countBugs,
  markBugsPromoted, getProject,
} from '../state.js';
import { runClaude } from '../claude-runner.js';
import { resolve as resolveConfig } from '../config-resolver.js';
import { detectHighestBugRound, bugRoundDir, bugsFilePath, projectContextPath } from '../lib/guide-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

const VALID_SEVERITIES = ['critical', 'major', 'minor', 'unassigned'];
const VALID_STATUSES = ['inbox', 'refined', 'promoted', 'dropped'];

function colorSeverity(s) {
  if (s === 'critical') return chalk.red.bold(s);
  if (s === 'major')    return chalk.yellow(s);
  if (s === 'minor')    return chalk.cyan(s);
  return chalk.dim(s);
}
function colorStatus(s) {
  if (s === 'inbox')    return chalk.green.bold(s);
  if (s === 'refined')  return chalk.cyan(s);
  if (s === 'promoted') return chalk.dim(s);
  if (s === 'dropped')  return chalk.dim.strikethrough(s);
  return s;
}

async function readJson(p) { try { return JSON.parse(await fs.readFile(p, 'utf-8')); } catch { return null; } }
async function fileExists(p) { try { await fs.access(p); return true; } catch { return false; } }

// ─── add ────────────────────────────────────────────────────────────────────

export async function addCmd(project, text, opts = {}) {
  if (project !== '_inbox' && !getProject(project)) {
    console.error(chalk.red(`Project not found: ${project}`));
    process.exit(1);
  }
  if (!text || !text.trim()) {
    console.error(chalk.red('Empty bug text.'));
    process.exit(1);
  }
  let severity = 'unassigned';
  if (opts.critical) severity = 'critical';
  else if (opts.major)    severity = 'major';
  else if (opts.minor)    severity = 'minor';
  else if (opts.severity) {
    if (!VALID_SEVERITIES.includes(opts.severity)) {
      console.error(chalk.red(`Invalid severity: ${opts.severity}. Use one of: ${VALID_SEVERITIES.join(', ')}`));
      process.exit(1);
    }
    severity = opts.severity;
  }
  // Inline "critical:", "major:", "minor:" prefix support
  const inlineMatch = text.match(/^(critical|major|minor)\s*[:|-]\s*(.+)$/i);
  let body = text;
  if (severity === 'unassigned' && inlineMatch) {
    severity = inlineMatch[1].toLowerCase();
    body = inlineMatch[2].trim();
  }

  const id = addBug({ project, raw_text: body, severity, source: 'cli' });
  console.log(chalk.green(`✓ Added bug #${id} (${colorSeverity(severity)}) to ${project}`));
  if (severity === 'critical') {
    console.log(chalk.red.bold('\n⚠ CRITICAL bug. Run immediately?'));
    console.log(chalk.dim(`   npm run bug -- ${project} promote --ids ${id} --run`));
  }
}

// ─── list ───────────────────────────────────────────────────────────────────

export async function listCmd(project, opts = {}) {
  if (project !== '_inbox' && !getProject(project)) {
    console.error(chalk.red(`Project not found: ${project}`));
    process.exit(1);
  }
  const showAll = opts.all;
  const items = listBugs({ project, status: showAll ? null : null });
  const filtered = showAll ? items : items.filter((b) => ['inbox', 'refined'].includes(b.status));
  if (!filtered.length) {
    console.log(chalk.dim('No bugs in inbox.' + (showAll ? '' : ' (Use --all to see promoted/dropped.)')));
    return;
  }
  console.log(chalk.bold.cyan(`\nBugs for ${project} (${filtered.length})\n`));
  for (const b of filtered) {
    const created = new Date(b.created_at).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' });
    const promotedTag = b.promoted_to_round ? chalk.dim(` → round ${b.promoted_to_round}`) : '';
    console.log(`  #${b.id}  ${colorSeverity(b.severity).padEnd(20)} ${colorStatus(b.status).padEnd(18)} ${chalk.dim(created)}${promotedTag}`);
    console.log(`        ${b.raw_text.slice(0, 120)}${b.raw_text.length > 120 ? '…' : ''}`);
    if (b.refined_text) console.log(chalk.dim(`        [refined] ${b.refined_text.slice(0, 100)}…`));
    console.log();
  }
}

// ─── show ───────────────────────────────────────────────────────────────────

export async function showCmd(id) {
  const b = getBug(Number(id));
  if (!b) { console.error(chalk.red(`Bug #${id} not found.`)); process.exit(1); }
  console.log(chalk.bold.cyan(`\nBug #${b.id}\n`));
  console.log(`Project:    ${b.project}`);
  console.log(`Severity:   ${colorSeverity(b.severity)}`);
  console.log(`Status:     ${colorStatus(b.status)}`);
  console.log(`Source:     ${b.source || '(none)'}`);
  console.log(`Created:    ${b.created_at}`);
  console.log(`Updated:    ${b.updated_at}`);
  if (b.promoted_to_round) console.log(`Promoted:   round-${b.promoted_to_round}`);
  if (b.tags) console.log(`Tags:       ${b.tags}`);
  console.log(`\nRaw text:\n${b.raw_text}`);
  if (b.refined_text) console.log(`\nRefined:\n${b.refined_text}`);
  if (b.notes) console.log(chalk.dim(`\nNotes:\n${b.notes}`));
  console.log();
}

// ─── set ────────────────────────────────────────────────────────────────────

export async function setCmd(id, field, value) {
  const allowed = ['severity', 'status', 'tags', 'refined_text', 'notes'];
  if (!allowed.includes(field)) {
    console.error(chalk.red(`Invalid field: ${field}. Allowed: ${allowed.join(', ')}`));
    process.exit(1);
  }
  if (field === 'severity' && !VALID_SEVERITIES.includes(value)) {
    console.error(chalk.red(`Invalid severity. Use one of: ${VALID_SEVERITIES.join(', ')}`));
    process.exit(1);
  }
  if (field === 'status' && !VALID_STATUSES.includes(value)) {
    console.error(chalk.red(`Invalid status. Use one of: ${VALID_STATUSES.join(', ')}`));
    process.exit(1);
  }
  const changed = updateBug(Number(id), { [field]: value });
  if (changed === 0) { console.error(chalk.red(`Bug #${id} not found or no change.`)); process.exit(1); }
  console.log(chalk.green(`✓ Updated #${id}: ${field} = ${value}`));
}

// ─── drop ───────────────────────────────────────────────────────────────────

export async function dropCmd(id) {
  const changed = updateBug(Number(id), { status: 'dropped' });
  if (changed === 0) { console.error(chalk.red(`Bug #${id} not found.`)); process.exit(1); }
  console.log(chalk.dim(`✗ Dropped #${id}`));
}

// ─── refine (AI structuring) ────────────────────────────────────────────────

export async function refineCmd(project) {
  if (project !== '_inbox' && !getProject(project)) {
    console.error(chalk.red(`Project not found: ${project}`));
    process.exit(1);
  }
  const items = listBugs({ project, status: 'inbox' });
  if (!items.length) {
    console.log(chalk.dim('Nothing to refine.'));
    return;
  }
  const projDir = project === '_inbox' ? null : path.join(PROJECTS_DIR, project);
  const projectContext = projDir ? await readContextSafely(projDir) : '';

  console.log(chalk.cyan(`Refining ${items.length} bug(s) for ${project}…`));
  const cfg = await resolveConfig({ task: 'triage', project });
  const prompt = `You are a senior engineer triaging a bug inbox. For each raw bug entry below, output a refined version with this exact structure:

# Bug NNN: <one-line title>

**Severity proposal:** critical | major | minor

**Repro:**
1. ...

**Expected:**
...

**Actual:**
...

**Likely files:**
- ...

**Notes:**
...

---

Where the bug obviously matches one severity, propose it. If unclear, propose 'unassigned'.
Project context follows, then the raw bugs. Output ONLY the refined sections separated by '---'. Maintain the same order. Do not add commentary.

Project context:
${projectContext || '(none)'}

Raw bugs (in order — DO NOT reorder):
${items.map((b, i) => `## Bug index ${i + 1}\nSeverity hint: ${b.severity}\n\n${b.raw_text}`).join('\n\n')}
`;

  const result = await runClaude({
    cfg, cwd: REPO_ROOT, prompt,
    role: 'triage', task: 'triage', project,
    systemPromptFile: null,
    systemPromptExtra: '',
  });
  if (result.is_error) {
    console.error(chalk.red(`Refinement failed: ${result.error || 'unknown'}`));
    process.exit(1);
  }
  // Split refined output and persist
  const sections = String(result.result || '').split(/^---\s*$/m).map((s) => s.trim()).filter(Boolean);
  let updated = 0;
  for (let i = 0; i < items.length && i < sections.length; i += 1) {
    const refined = sections[i];
    // Try to parse the severity proposal
    const m = refined.match(/\*\*Severity proposal:\*\*\s*(critical|major|minor|unassigned)/i);
    const sev = m ? m[1].toLowerCase() : items[i].severity;
    updateBug(items[i].id, { refined_text: refined, status: 'refined', severity: sev });
    updated += 1;
  }
  console.log(chalk.green(`✓ Refined ${updated}/${items.length} bug(s).`));
}

async function readContextSafely(projDir) {
  try { return await fs.readFile(projectContextPath(projDir), 'utf-8'); } catch { return ''; }
}

// ─── promote (pure function — used by CLI + Telegram) ─────────────────────

/**
 * Promotes selected inbox bugs into a new bugs.md for the next bug round.
 * Pure: returns a result object on success, throws Error on failure (no process.exit, no console).
 *
 * @param {object} args
 * @param {string} args.project
 * @param {number[]} [args.ids]        Specific bug IDs to promote
 * @param {string}   [args.severity]   Only bugs of this severity (if ids not given)
 * @returns {Promise<{ round: number, promotedIds: number[], bugsPath: string, totalFixes: number }>}
 */
export async function withBugPromotionLock(project, fn) {
  if (typeof project !== 'string' || !project) throw new Error('Bug promotion requires a project');
  if (typeof fn !== 'function') throw new Error('Bug promotion requires a callback');
  const projDir = path.join(PROJECTS_DIR, project);
  const guideDir = path.join(projDir, '.guide');
  await fs.mkdir(guideDir, { recursive: true });
  const lockPath = path.join(guideDir, 'bug-promote.lock');
  let handle = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      handle = await fs.open(lockPath, 'wx');
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const st = await fs.stat(lockPath);
        if (Date.now() - st.mtimeMs > 60_000) {
          await fs.unlink(lockPath);
          continue;
        }
      } catch { /* raced with the owner releasing the lock */ }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!handle) throw new Error('Bug promotion is busy; retry in a moment');
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await fs.unlink(lockPath).catch(() => {});
  }
}

export async function performBugPromote(args) {
  const project = args?.project;
  return withBugPromotionLock(project, () => performBugPromoteUnlocked(args));
}

async function performBugPromoteUnlocked({ project, ids = null, severity = null }) {
  if (project !== '_inbox' && !getProject(project)) {
    throw new Error(`Project not found: ${project}`);
  }

  // Select which bugs to promote
  let selected;
  if (ids && ids.length) {
    selected = ids.map((id) => getBug(id)).filter((b) => b && b.project === project && ['inbox', 'refined'].includes(b.status));
    if (selected.length === 0) {
      throw new Error('No matching bugs found for the given IDs (already promoted/dropped?).');
    }
  } else {
    selected = listBugs({ project, status: 'inbox' })
      .concat(listBugs({ project, status: 'refined' }));
    if (severity) selected = selected.filter((b) => b.severity === severity);
  }

  if (selected.length === 0) {
    throw new Error('No bugs to promote.');
  }

  const projDir = path.join(PROJECTS_DIR, project);
  const currentRound = await detectHighestBugRound(projDir);
  const nextRound = (currentRound || 0) + 1;

  // Build bugs.md
  const lines = [];
  lines.push(`# Bug Round ${nextRound}`);
  lines.push('');
  lines.push(`Generated from bug-inbox on ${new Date().toISOString()}.`);
  lines.push(`Promoted bug IDs: ${selected.map((b) => '#' + b.id).join(', ')}.`);
  lines.push('');

  const bySeverity = { critical: [], major: [], minor: [], unassigned: [] };
  for (const b of selected) (bySeverity[b.severity] || bySeverity.unassigned).push(b);

  let bugN = 1;
  for (const sev of ['critical', 'major', 'minor', 'unassigned']) {
    if (!bySeverity[sev].length) continue;
    lines.push(`## ${sev.toUpperCase()}`);
    lines.push('');
    for (const b of bySeverity[sev]) {
      lines.push(`### BUG-${bugN}: from bug-inbox #${b.id}`);
      lines.push('');
      lines.push(b.refined_text || b.raw_text);
      lines.push('');
      bugN += 1;
    }
  }

  await fs.mkdir(bugRoundDir(projDir, nextRound), { recursive: true });
  const targetPath = bugsFilePath(projDir, nextRound);
  if (await fileExists(targetPath)) {
    throw new Error(`bugs.md already exists for round ${nextRound}: ${path.relative(REPO_ROOT, targetPath)}. Delete it first.`);
  }
  await fs.writeFile(targetPath, lines.join('\n') + '\n');

  markBugsPromoted(selected.map((b) => b.id), nextRound);

  return {
    round: nextRound,
    promotedIds: selected.map((b) => b.id),
    bugsPath: targetPath,
    totalFixes: selected.length,
  };
}

// ─── promote (CLI wrapper around performBugPromote) ────────────────────────

export async function promoteCmd(project, opts = {}) {
  let ids = null;
  if (opts.ids) {
    ids = String(opts.ids).split(',').map((x) => Number(x.trim())).filter(Boolean);
  }
  let result;
  try {
    result = await performBugPromote({ project, ids, severity: opts.severity || null });
  } catch (err) {
    console.error(chalk.red(err.message));
    process.exit(1);
  }
  console.log(chalk.green(`✓ Created bugs.md for round ${result.round}: ${path.relative(REPO_ROOT, result.bugsPath)}`));
  console.log(chalk.green(`✓ Promoted ${result.promotedIds.length} bug(s): #${result.promotedIds.join(', #')}`));

  // Optionally auto-run via startBugCycle (CLI-only convenience; from Telegram this happens via job-queue)
  if (opts.run) {
    console.log(chalk.cyan('\nStarting bug round…'));
    const { startBugCycle } = await import('../bug-cycle.js');
    await startBugCycle({ projectName: project });
    // startBugCycle only PLANS; for execution, fall through to autoRun
    const { autoRun } = await import('../auto-runner.js');
    await autoRun({ projectName: project });
  } else {
    const { getNextActions, renderNextActionsCli } = await import('../lib/next-actions.js');
    const actions = getNextActions({
      project,
      lastAction: 'bug-promoted',
      state: { bugRoundActive: result.round },
    });
    process.stdout.write(renderNextActionsCli(actions));
  }
}

// ─── stats ──────────────────────────────────────────────────────────────────

export async function statsCmd(project) {
  if (project !== '_inbox' && !getProject(project)) {
    console.error(chalk.red(`Project not found: ${project}`));
    process.exit(1);
  }
  const rows = countBugs(project);
  if (!rows.length) {
    console.log(chalk.dim(`No bugs captured for ${project}.`));
    return;
  }
  console.log(chalk.bold.cyan(`\nBug-inbox stats for ${project}\n`));
  const totals = { critical: 0, major: 0, minor: 0, unassigned: 0 };
  for (const r of rows) {
    if (r.status !== 'dropped') totals[r.severity] = (totals[r.severity] || 0) + r.n;
    console.log(`  ${colorStatus(r.status).padEnd(20)} ${colorSeverity(r.severity).padEnd(20)} ${r.n}`);
  }
  console.log();
  console.log(`  Active by severity (excludes dropped):`);
  for (const k of ['critical', 'major', 'minor', 'unassigned']) {
    if (totals[k]) console.log(`    ${colorSeverity(k).padEnd(20)} ${totals[k]}`);
  }
  console.log();
}
