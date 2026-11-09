import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import chalk from 'chalk';
import ora from 'ora';

import { resolve as resolveConfig } from '../config-resolver.js';
import {
  getProject, saveSuggestions, acceptSuggestions,
  getLatestSuggestions, staleAllSuggestions, getEarlierSuggestionTitles,
} from '../state.js';
import { scanProject } from '../lib/project-scanner.js';
import { generateSuggestions, assignToPasses, filterSuggestions } from '../lib/suggestion-engine.js';
import { generateAISuggestions } from '../lib/ai-suggestion-scanner.js';
import { QUESTIONS } from '../lib/suggest-prompts.js';
import { guideRoot, suggestionsPath } from '../lib/guide-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

const TYPE_LABELS = {
  'new-feature':    'New features',
  'enhancement':    'Enhancements',
  'ui-improvement': 'UI improvements',
  'perf':           'Performance',
  'security':       'Security',
  'dx':             'DX / Tooling',
};

const PASS_LABELS = {
  1: 'core',
  2: 'extend',
  3: 'new category',
  4: 'pass 4',
  5: 'pass 5',
};

// Module-level rl — created once per suggestProject call, closed in finally.
let _rl = null;

async function _prompt(question) {
  return (await _rl.question(question)).trim();
}

async function _askText(question) {
  console.log('\n' + question.text);
  if (question.placeholder) {
    console.log(chalk.dim(`  (${question.placeholder})`));
  }
  return _prompt('  > ');
}

async function _askSingle(question) {
  console.log('\n' + question.text);
  for (let i = 0; i < question.options.length; i++) {
    console.log(`  ${i + 1}) ${question.options[i].label}`);
  }
  while (true) {
    const ans = await _prompt('  Enter number: ');
    const n = parseInt(ans, 10);
    if (n >= 1 && n <= question.options.length) return question.options[n - 1].value;
    console.log(chalk.yellow(`  Please enter a number between 1 and ${question.options.length}.`));
  }
}

async function _askMulti(question) {
  const defaults = question.default || [];
  console.log('\n' + question.text);
  for (let i = 0; i < question.options.length; i++) {
    const opt = question.options[i];
    const isDefault = defaults.includes(opt.value);
    console.log(`  ${i + 1}) ${opt.label}${isDefault ? chalk.dim(' (default)') : ''}`);
  }
  console.log(chalk.dim('  Press Enter to use defaults, or enter comma-separated numbers.'));
  while (true) {
    const ans = await _prompt('  Enter numbers: ');
    if (!ans) return defaults;
    const parts = ans.split(',').map(s => s.trim()).filter(Boolean);
    const values = [];
    let valid = true;
    for (const p of parts) {
      const n = parseInt(p, 10);
      if (n >= 1 && n <= question.options.length) {
        values.push(question.options[n - 1].value);
      } else {
        console.log(chalk.yellow(`  Invalid number: ${p}. Please try again.`));
        valid = false;
        break;
      }
    }
    if (valid) return values;
  }
}

const _HYPHEN_SAFE = new Set(['react', 'vue', 'svelte', 'nuxt', 'angular', 'astro', 'remix']);
function _depMatches(d, sig) {
  return d === sig ||
    d.startsWith(sig + '/') ||
    d.startsWith('@' + sig + '/') ||
    (_HYPHEN_SAFE.has(sig) && d.startsWith(sig + '-'));
}

function _typeLabel(projectType, dependencies) {
  const deps = dependencies || [];
  switch (projectType) {
    case 'cli': {
      if (deps.includes('commander')) return 'CLI (commander)';
      if (deps.includes('yargs')) return 'CLI (yargs)';
      if (deps.some(d => _depMatches(d, 'oclif'))) return 'CLI (oclif)';
      return 'CLI';
    }
    case 'frontend': {
      if (deps.some(d => _depMatches(d, 'next'))) return 'Frontend (Next.js)';
      if (deps.some(d => _depMatches(d, 'react'))) return 'Frontend (React)';
      if (deps.some(d => _depMatches(d, 'vue'))) return 'Frontend (Vue)';
      if (deps.some(d => _depMatches(d, 'angular'))) return 'Frontend (Angular)';
      if (deps.some(d => _depMatches(d, 'svelte'))) return 'Frontend (Svelte)';
      return 'Frontend';
    }
    case 'api': {
      if (deps.some(d => _depMatches(d, 'express'))) return 'API (Express)';
      if (deps.some(d => _depMatches(d, 'fastify'))) return 'API (Fastify)';
      if (deps.some(d => _depMatches(d, 'hono'))) return 'API (Hono)';
      if (deps.some(d => _depMatches(d, 'koa'))) return 'API (Koa)';
      return 'API';
    }
    case 'fullstack': {
      const fe = deps.some(d => _depMatches(d, 'next'))  ? 'Next.js'
               : deps.some(d => _depMatches(d, 'nuxt'))  ? 'Nuxt'
               : deps.some(d => _depMatches(d, 'react')) ? 'React'
               : deps.some(d => _depMatches(d, 'vue'))   ? 'Vue' : null;
      const be = deps.some(d => _depMatches(d, 'express'))  ? 'Express'
               : deps.some(d => _depMatches(d, 'fastify'))  ? 'Fastify'
               : deps.some(d => _depMatches(d, 'hono'))     ? 'Hono' : null;
      if (fe && be) return `Fullstack (${fe} + ${be})`;
      if (fe) return `Fullstack (${fe})`;
      if (be) return `Fullstack (${be})`;
      return 'Fullstack';
    }
    default:
      return 'Unknown';
  }
}

function _printPlanSummary(selected, pipelinePlan, passes) {
  for (let p = 1; p <= passes; p++) {
    const ids = pipelinePlan[String(p)] || [];
    if (ids.length === 0) continue;
    const label = PASS_LABELS[p] || `pass ${p}`;
    const titles = ids.map(id => selected.find(s => s.id === id)?.title || id).join(', ');
    console.log(chalk.dim(`  Pass ${p} (${label}): `) + titles);
  }
}

export function _reconcilePlan(selectedItems, pipelinePlan) {
  const assigned = new Set();
  for (const ids of Object.values(pipelinePlan)) {
    for (const id of ids) assigned.add(id);
  }

  const orphans = selectedItems.filter(s => !assigned.has(s.id));
  if (orphans.length === 0) return 0;

  const lowestPass = String(Math.min(...Object.keys(pipelinePlan).map(Number)));
  for (const s of orphans) pipelinePlan[lowestPass].push(s.id);
  return orphans.length;
}

function _printExistingPlan(existing) {
  const sel  = JSON.parse(existing.selected_json || '[]');
  const pp   = existing.pipeline_passes;
  const plan = JSON.parse(existing.pipeline_plan_json || '{}');
  const age  = Math.round((Date.now() - new Date(existing.generated_at).getTime()) / 60_000);

  console.log(
    chalk.bold(`\nExisting plan`) +
    chalk.dim(` — ${pp} pass${pp > 1 ? 'es' : ''}, ${sel.length} item${sel.length !== 1 ? 's' : ''}, ${age}m ago`),
  );

  const TYPE_ORDER = ['new-feature', 'enhancement', 'ui-improvement', 'perf', 'security', 'dx'];
  const groups = {};
  for (const s of sel) {
    const type = s.type || 'enhancement';
    if (!groups[type]) groups[type] = [];
    groups[type].push(s);
  }
  for (const type of TYPE_ORDER) {
    const items = groups[type];
    if (!items?.length) continue;
    console.log(chalk.dim(`  ${TYPE_LABELS[type] || type}`));
    for (const item of items) {
      const badge = item.effort ? chalk.dim(` [${item.effort}/${item.impact}]`) : '';
      console.log(`    • ${item.title || item.id}${badge}`);
    }
  }

  if (pp > 1) {
    console.log('');
    _printPlanSummary(sel, plan, pp);
  }
}

/**
 * Parse the optional [effort/impact] shorthand from the end of a manual-item description.
 * Returns { title, effort, impact }.
 * Exported for unit testing.
 */
export function _parseManualMeta(desc) {
  const metaMatch = desc.match(/\[(\w+)\/(\w+)\]\s*$/);
  const title  = (metaMatch ? desc.slice(0, metaMatch.index) : desc).trim();
  const effort = metaMatch ? metaMatch[1] : 'medium';
  const impact  = metaMatch ? metaMatch[2] : 'high';
  return { title, effort, impact };
}

/**
 * Collect manual items from the user (up to 5, press Enter on empty to finish).
 * Returns an array of Suggestion-shaped objects with user-defined titles.
 */
async function _collectManualItems(existingIds) {
  const items = [];
  console.log(chalk.bold('\n  Add custom items:'));
  console.log(chalk.dim('  Describe each item you want to focus on. Press Enter on an empty line to finish.'));

  for (let i = 0; i < 5; i++) {
    const desc = await _prompt(`  Item ${i + 1} (or Enter to finish): `);
    if (!desc) break;

    // Parse optional effort/impact shorthand: "Add dark mode [small/high]"
    const { title, effort, impact } = _parseManualMeta(desc);

    if (!title) {
      console.log(chalk.yellow('  Item description cannot be empty.'));
      i--;
      continue;
    }

    // Sanitise into a stable ID, avoid collisions with existing
    const baseId = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 50);
    let id = `manual-${baseId}`;
    let suffix = 1;
    while (existingIds.has(id)) { id = `manual-${baseId}-${suffix++}`; }
    existingIds.add(id);

    items.push({
      id,
      type:          'new-feature',
      category:      'logic',
      title:         title.slice(0, 60),
      description:   title,
      effort:        ['small', 'medium', 'large'].includes(effort) ? effort : 'medium',
      impact:        ['low', 'medium', 'high'].includes(impact)   ? impact : 'high',
      suggestedSlot: 1,
      appliesTo:     ['cli', 'frontend', 'api', 'fullstack', 'unknown'],
      manual:        true,
    });
    console.log(chalk.green(`  ✓ Added: "${title}"`));
  }
  return items;
}

// ─── Core suggest wizard ──────────────────────────────────────────────────────

/**
 * Run the full interactive suggest wizard.
 * Flow:
 *   1. Upfront questions (goal + areas)
 *   2. Check existing plan → show + [U]se/[R]e-scan/[X]Cancel
 *   3. Scan workspace
 *   4. AI suggestion generation (fallback: hardcoded rules)
 *   5. Manual item addition
 *   6. Display + select
 *   7. Pipeline passes (1-5)
 *   8. Confirm + edit + persist
 *
 * @param {string} projectName
 * @param {{ rerun?: boolean, force?: boolean, noLm?: boolean, previousTitles?: string[], fromGate?: boolean }} opts
 *   fromGate — set when called from suggestGate to suppress the "Run: npm run go" tip
 *              and avoid double-staling (gate already staled before calling here).
 *   noLm     — skip the Claude call and use generateSuggestions() directly.
 */
export async function suggestProject(projectName, opts = {}) {
  _rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    // ── Step A: Resolve project ─────────────────────────────────────────────
    const project = getProject(projectName);
    if (!project) {
      console.error(chalk.red(`suggest: project "${projectName}" not found. Run: ashmero list`));
      return { error: `suggest: project "${projectName}" not found. Run: ashmero list` };
    }
    const projDir = path.join(PROJECTS_DIR, projectName);

    // ── Step B: Stale on rerun/force (skip if called from gate — it already staled) ──
    if ((opts.rerun || opts.force) && !opts.fromGate) {
      staleAllSuggestions(projectName);
    }

    // ── Step C: Upfront questions ───────────────────────────────────────────
    console.log(chalk.bold(`\nashmero suggest — ${projectName}`));

    const goalQ  = QUESTIONS.find(q => q.id === 'goal');
    const areasQ = QUESTIONS.find(q => q.id === 'areas');

    const userGoal    = await _askText(goalQ);
    const areasAnswer = await _askMulti(areasQ);

    // ── Step D: Check existing suggestions ──────────────────────────────────
    if (!opts.force) {
      const existing = getLatestSuggestions(projectName);
      if (existing?.status === 'accepted') {
        _printExistingPlan(existing);

        const choice = await _prompt('\n  [U]se existing / [R]e-suggest / [X]Cancel: ');
        if (choice.toLowerCase() === 'x') { return { cancelled: true }; }
        if (choice.toLowerCase() === 'u') {
          const sel  = JSON.parse(existing.selected_json || '[]');
          const plan = JSON.parse(existing.pipeline_plan_json || '{}');
          await writeSuggestionsFile(projDir, projectName, sel, plan, existing.pipeline_passes, existing.generated_at);
          console.log(chalk.green('\n✓ Existing plan written to .guide/suggestions.md'));
          return;
        }
        // 'r' → re-suggest (stale current so AI avoids repeating it)
        staleAllSuggestions(projectName);
      }
    }

    // ── Step E: Scan workspace ──────────────────────────────────────────────
    const scanSpinner = ora('Scanning workspace…').start();
    let snapshot;
    try {
      snapshot = await scanProject(projDir);
      scanSpinner.succeed(chalk.dim('Scan complete.'));
    } catch (err) {
      scanSpinner.fail();
      console.error(chalk.red(`suggest: scan failed for "${projectName}": ${err.message}`));
      return { error: `suggest: scan failed for "${projectName}": ${err.message}` };
    }

    const lastPhase = snapshot.phaseTitles?.[0] ?? 'none';
    const typeLabel = _typeLabel(snapshot.projectType, snapshot.dependencies);
    console.log(
      chalk.bold(`\nDetected: ${typeLabel}`) +
      chalk.dim(`  •  ${snapshot.completedPhases} phases done`) +
      chalk.dim(`  •  last: "${lastPhase}"`),
    );

    // ── Step F: Unknown project type ────────────────────────────────────────
    if (snapshot.projectType === 'unknown') {
      console.log(chalk.yellow('\nProject type could not be determined from the workspace.'));
      console.log('  1) CLI\n  2) Frontend\n  3) API\n  4) Fullstack\n  5) Cancel');
      const choice = await _prompt('  Select type (1-5): ');
      const typeMap = { '1': 'cli', '2': 'frontend', '3': 'api', '4': 'fullstack' };
      if (!typeMap[choice]) { return { cancelled: true }; }
      snapshot = { ...snapshot, projectType: typeMap[choice] };
    }

    // ── Step G: Suggestion generation ──────────────────────────────────────
    // Merge opts.previousTitles with any earlier stale rows in DB
    const dbPrevTitles = getEarlierSuggestionTitles(projectName);
    const previousTitles = [...new Set([...(opts.previousTitles || []), ...dbPrevTitles])];

    let suggestions;
    if (opts.noLm) {
      // Rules-only path — caller explicitly opted out of the Claude call.
      // Areas are a HARD filter here: filterSuggestions drops items outside selected categories.
      const raw = generateSuggestions(snapshot);
      suggestions = areasAnswer.length > 0 ? filterSuggestions(raw, areasAnswer) : raw;
    } else {
      // AI path — areas are a SOFT prompt hint, not a hard filter.
      // Claude receives the selected focus areas as guidance but may return items from any
      // category. The selection UI (Step I) is the real gate. On AI failure we fall back to
      // the rules engine which DOES apply a hard area filter via filterSuggestions.
      const aiSpinner = ora('Asking Claude to analyse your project…').start();
      try {
        const cfg = await resolveConfig({ project: projectName, task: 'suggest-scan' });
        suggestions = await generateAISuggestions(snapshot, userGoal, areasAnswer, cfg, previousTitles, {}, projectName, projDir);
        aiSpinner.succeed(chalk.dim(`Claude generated ${suggestions.length} suggestions.`));
        if (areasAnswer.length > 0 && areasAnswer.length < 5) {
          console.log(chalk.dim('  Note: AI results may include items outside selected focus areas (areas are advisory for AI scan).'));
        }
      } catch (err) {
        aiSpinner.warn(chalk.yellow(`AI scan failed (${err.message}) — using built-in rules.`));
        const raw = generateSuggestions(snapshot);
        suggestions = areasAnswer.length > 0 ? filterSuggestions(raw, areasAnswer) : raw;
      }
    }

    // ── Step H: Manual item addition ────────────────────────────────────────
    const existingIds = new Set(suggestions.map(s => s.id));
    const addAns = await _prompt('\n  Add custom items to focus on specific areas? [y/N]: ');
    if (addAns.toLowerCase() === 'y') {
      const manual = await _collectManualItems(existingIds);
      if (manual.length) {
        // Manual items go to the top of the list so they're easy to spot
        suggestions = [...manual, ...suggestions];
        console.log(chalk.dim(`\n  Added ${manual.length} custom item${manual.length > 1 ? 's' : ''}.`));
      }
    }

    if (suggestions.length === 0) {
      console.log(chalk.yellow('\nNo suggestions available for this project. Try --rerun.'));
      return { cancelled: true };
    }

    // ── Step I: Display suggestions + collect selection ─────────────────────
    const TYPE_ORDER = ['new-feature', 'enhancement', 'ui-improvement', 'perf', 'security', 'dx'];
    const groups = {};
    for (const s of suggestions) {
      if (!groups[s.type]) groups[s.type] = [];
      groups[s.type].push(s);
    }

    // Manual items shown first in their own block
    const manualItems = suggestions.filter(s => s.manual);
    let counter = 1;
    const indexMap = {};
    console.log('');

    if (manualItems.length) {
      console.log(chalk.bold('  Your custom items'));
      console.log('  ' + '─'.repeat(38));
      for (const item of manualItems) {
        indexMap[counter] = item;
        const badge = chalk.dim(`[${item.effort} / ${item.impact}]`);
        console.log(`  ${String(counter).padStart(2)}. ${chalk.cyan(item.title)}  ${badge}`);
        counter++;
      }
      console.log('');
    }

    for (const type of TYPE_ORDER) {
      const items = (groups[type] || []).filter(s => !s.manual);
      if (!items.length) continue;
      console.log(chalk.bold(`  ${TYPE_LABELS[type] || type}`));
      console.log('  ' + '─'.repeat(38));
      for (const item of items) {
        indexMap[counter] = item;
        const badge = chalk.dim(`[${item.effort} / ${item.impact}]`);
        console.log(`  ${String(counter).padStart(2)}. ${item.title}  ${badge}`);
        counter++;
      }
      console.log('');
    }

    const totalItems = counter - 1;

    const _readSelection = async () => {
      const ans = await _prompt("  Enter numbers (comma-separated), 'a' for all, 'n' for none: ");
      if (ans.toLowerCase() === 'n') return { action: 'exit' };
      if (ans.toLowerCase() === 'a') return { action: 'select', items: suggestions.slice() };
      const parts = ans.split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length === 0) return { action: 'invalid', reason: 'no numbers entered' };
      const items = [];
      for (const p of parts) {
        const n = parseInt(p, 10);
        if (!indexMap[n]) return { action: 'invalid', reason: `${n} is not in range 1–${totalItems}` };
        items.push(indexMap[n]);
      }
      return { action: 'select', items };
    };

    let selResult = await _readSelection();
    if (selResult.action === 'exit') { return { cancelled: true }; }
    if (selResult.action === 'invalid') {
      console.log(chalk.yellow(`  Invalid: ${selResult.reason}. Please try again.`));
      selResult = await _readSelection();
      if (selResult.action === 'exit') { return { cancelled: true }; }
      if (selResult.action === 'invalid') {
        console.log(chalk.yellow('  Invalid input. Exiting.'));
        return { error: 'Invalid input twice. Exiting.' };
      }
    }
    const selectedItems = selResult.items;

    // ── Step J: Pipeline passes (1-5) ──────────────────────────────────────
    const passesAnswer = await _askSingle(QUESTIONS.find(q => q.id === 'passes'));
    const passes = parseInt(passesAnswer, 10);

    // ── Step K: Assign + confirm ────────────────────────────────────────────
    let pipelinePlan = assignToPasses(selectedItems, passes);

    console.log('');
    _printPlanSummary(selectedItems, pipelinePlan, passes);

    const confirmAns = await _prompt('\n  [C]onfirm / [E]dit / [X]Cancel: ');
    if (confirmAns.toLowerCase() === 'x') { return { cancelled: true }; }

    // ── Step L: Edit loop ───────────────────────────────────────────────────
    if (confirmAns.toLowerCase() === 'e') {
      for (let p = 1; p <= passes; p++) {
        console.log(chalk.bold(`\n  Editing Pass ${p} (${PASS_LABELS[p] || 'pass ' + p}):`));
        const currentIds = pipelinePlan[String(p)] || [];
        for (let i = 0; i < selectedItems.length; i++) {
          const s = selectedItems[i];
          const inPass = currentIds.includes(s.id);
          console.log(`  ${i + 1}. ${s.title}${inPass ? chalk.dim(' (currently assigned)') : ''}`);
        }
        const editAns = await _prompt(`  Enter numbers for pass ${p} (comma-separated, or Enter to keep): `);
        if (editAns.trim()) {
          const parts = editAns.split(',').map(s => s.trim()).filter(Boolean);
          const newIds = [];
          for (const pt of parts) {
            const n = parseInt(pt, 10);
            if (n >= 1 && n <= selectedItems.length) newIds.push(selectedItems[n - 1].id);
          }
          if (newIds.length > 0) pipelinePlan[String(p)] = newIds;
        }
      }
      const rescued = _reconcilePlan(selectedItems, pipelinePlan);
      if (rescued > 0) {
        console.log(chalk.yellow(
          `\n  Note: ${rescued} item${rescued > 1 ? 's' : ''} had no pass assigned and ` +
          `${rescued > 1 ? 'were' : 'was'} added to Pass 1.`,
        ));
      }

      console.log(chalk.bold('\n  Updated assignment:'));
      _printPlanSummary(selectedItems, pipelinePlan, passes);
      const finalAns = await _prompt('\n  [C]onfirm / [X]Cancel: ');
      if (finalAns.toLowerCase() === 'x') { return { cancelled: true }; }
    }

    // ── Step M: Persist ─────────────────────────────────────────────────────
    // staleAllSuggestions is NOT called here — acceptSuggestions stales all
    // sibling rows inside its own db.transaction, making insert+accept atomic.
    // A crash between saveSuggestions and acceptSuggestions leaves the previous
    // accepted row intact (still 'accepted'), so the gate never sees a plan-less state.
    const id = saveSuggestions(projectName, {
      projectType:  snapshot.projectType,
      scanSnapshot: snapshot,
      suggestions,
    });
    acceptSuggestions(id, { selected: selectedItems, pipelinePlan, pipelinePasses: passes });
    await writeSuggestionsFile(projDir, projectName, selectedItems, pipelinePlan, passes);

    // ── Step N: Success summary ─────────────────────────────────────────────
    const lowestPass = Object.keys(pipelinePlan).map(Number).sort((a, b) => a - b)
      .find(p => (pipelinePlan[String(p)] || []).length > 0) ?? 1;
    const assignedIds = new Set(Object.values(pipelinePlan).flat());
    const assignedCount = assignedIds.size;
    console.log('\n' + chalk.green('✓') + ` Suggestions plan saved (${passes} pass${passes > 1 ? 'es' : ''}, ${assignedCount} items).`);
    for (let p = 1; p <= passes; p++) {
      const ids = pipelinePlan[String(p)] || [];
      if (ids.length === 0) continue;
      const titles = ids.map(id2 => selectedItems.find(s => s.id === id2)?.title || id2).join(', ');
      console.log(chalk.dim(`  Pass ${p}: `) + titles);
    }
    console.log('');
    if (!opts.fromGate) {
      const runCmd = passes > 1
        ? `npm run go -- ${projectName} --slot ${lowestPass}`
        : `npm run go -- ${projectName}`;
      console.log(`Run: ${runCmd}`);
      console.log('');
    }
    return { ok: true };
  } finally {
    _rl?.close();
    _rl = null;
  }
}

// ─── Pre-pipeline gate ────────────────────────────────────────────────────────

/**
 * Interactive gate called at the start of `go` / `resume`.
 * - No plan → runs full suggest wizard inline.
 * - Plan exists → shows it, offers [C]ontinue / [R]e-suggest / [A]dd items / [X]Cancel.
 *
 * Returns true to proceed with the pipeline, false to abort.
 *
 * @param {string} projectName
 * @param {string} projDir       — absolute project directory
 * @param {number} slot          — which pipeline pass is being run (1-5)
 */
export async function suggestGate(projectName, projDir, slot = 1) {
  const existing = getLatestSuggestions(projectName);

  // ── No plan at all → run full wizard ───────────────────────────────────────
  if (!existing || existing.status !== 'accepted') {
    console.log(chalk.yellow(`\nNo suggestions plan found for "${projectName}".`));
    console.log(chalk.dim('Running suggest wizard now — you can set your goal, pick areas, and control the plan.\n'));
    const result = await suggestProject(projectName, { fromGate: true });
    // suggestProject returns { cancelled: true } or { error } on abort; { ok } on success.
    if (result?.cancelled || result?.error) return { proceed: false, planReplaced: false };
    return { proceed: true, planReplaced: false };
  }

  // ── Plan exists → show it for the relevant slot ─────────────────────────────
  const sel    = JSON.parse(existing.selected_json || '[]');
  const pp     = existing.pipeline_passes;
  const plan   = JSON.parse(existing.pipeline_plan_json || '{}');
  const slotIds = plan[String(slot)] || [];
  const age    = Math.round((Date.now() - new Date(existing.generated_at).getTime()) / 60_000);

  console.log(
    chalk.bold(`\nSuggestions plan — ${projectName}`) +
    chalk.dim(` (${pp} pass${pp > 1 ? 'es' : ''}, created ${age}m ago)`),
  );

  if (slotIds.length === 0) {
    console.log(chalk.dim(`  Pass ${slot} is empty. All items may already be assigned to other passes.`));
  } else {
    console.log(chalk.dim(`  Pass ${slot} (${PASS_LABELS[slot] || 'pass ' + slot}):`));
    for (const id of slotIds) {
      const s = sel.find(x => x.id === id);
      if (s) {
        const badge = s.effort ? chalk.dim(` [${s.effort}/${s.impact}]`) : '';
        const tag   = s.manual ? chalk.cyan(' ✎') : '';
        console.log(`    • ${s.title}${badge}${tag}`);
      }
    }
  }

  // Show full plan summary if multi-pass
  if (pp > 1) {
    console.log('');
    for (let p = 1; p <= pp; p++) {
      const ids = plan[String(p)] || [];
      if (ids.length === 0) continue;
      const label = PASS_LABELS[p] || `pass ${p}`;
      const active = p === slot ? chalk.bold : (x => x);
      const titles = ids.map(id => sel.find(s => s.id === id)?.title || id).join(', ');
      console.log(active(chalk.dim(`  Pass ${p} (${label}): `) + titles));
    }
    console.log('');
    console.log(chalk.dim(`  After this run: npm run go -- ${projectName} --slot <next-pass>`));
  }

  // ── Offer control menu ─────────────────────────────────────────────────────
  _rl = createInterface({ input: process.stdin, output: process.stdout });
  let planReplaced = false;
  try {
    while (true) {
      const choice = (await _rl.question(
        '\n  [C]ontinue  [R]e-suggest  [A]dd items  [X]Cancel\n  > ',
      )).trim().toLowerCase();

      if (choice === 'x') {
        console.log(chalk.yellow('Aborted.'));
        return { proceed: false, planReplaced };
      }

      if (choice === 'c') {
        return { proceed: true, planReplaced };
      }

      if (choice === 'r') {
        // Stale current plan, collect all previously-seen titles, then run wizard.
        staleAllSuggestions(projectName);
        const previousTitles = getEarlierSuggestionTitles(projectName);
        _rl.close(); _rl = null;
        // fromGate: true — suppresses "Run: go" tip and skips double-stale inside wizard
        const result = await suggestProject(projectName, { force: true, previousTitles, fromGate: true });
        if (result?.cancelled || result?.error) return { proceed: false, planReplaced: false };
        planReplaced = true;
        return { proceed: true, planReplaced: true };
      }

      if (choice === 'a') {
        // Add manual items to the existing accepted plan
        const existingIds = new Set(sel.map(s => s.id));
        const manual = await _collectManualItems(existingIds);
        if (manual.length) {
          const newSel = [...sel, ...manual];
          const newPlan = { ...plan };
          for (const m of manual) {
            const targetSlot = String(Math.min(m.suggestedSlot, pp));
            newPlan[targetSlot] = [...(newPlan[targetSlot] || []), m.id];
          }
          const newId = saveSuggestions(projectName, {
            projectType:  existing.project_type,
            scanSnapshot: JSON.parse(existing.scan_snapshot_json || '{}'),
            suggestions:  newSel,
          });
          acceptSuggestions(newId, {
            selected:       newSel,
            pipelinePlan:   newPlan,
            pipelinePasses: pp,
            nextPass:       existing.next_pass,   // preserve cursor position mid-pipeline
          });
          planReplaced = true;
          await writeSuggestionsFile(projDir, projectName, newSel, newPlan, pp);
          console.log(chalk.green(`\n✓ Added ${manual.length} item${manual.length > 1 ? 's' : ''}. Updated plan:`));
          // Re-display the slot so user can see what's now queued
          const updatedSlotIds = newPlan[String(slot)] || [];
          console.log(chalk.dim(`  Pass ${slot} (${PASS_LABELS[slot] || 'pass ' + slot}):`));
          for (const id of updatedSlotIds) {
            const s = newSel.find(x => x.id === id);
            if (s) {
              const badge = s.effort ? chalk.dim(` [${s.effort}/${s.impact}]`) : '';
              const tag   = s.manual ? chalk.cyan(' ✎') : '';
              console.log(`    • ${s.title}${badge}${tag}`);
            }
          }
          // Update local references so the loop uses fresh data
          sel.length = 0; sel.push(...newSel);
          Object.assign(plan, newPlan);
        }
        // loop back to show the menu again
        continue;
      }

      console.log(chalk.yellow('  Please enter C, R, A, or X.'));
    }
  } finally {
    _rl?.close();
    _rl = null;
  }
}

// ─── File writer ──────────────────────────────────────────────────────────────

/**
 * Write the .guide/suggestions.md file in the canonical format.
 * Pure async function — no readline, no ora, no interactive side effects.
 */
export async function writeSuggestionsFile(projDir, projectName, selected, pipelinePlan, passes, generatedAt = null) {
  const filePath = suggestionsPath(projDir);
  const lines = [];
  const isoDate = generatedAt ?? new Date().toISOString();

  lines.push(`# Suggestions Plan — ${projectName} — ${isoDate}`);
  lines.push('');
  lines.push(`Pipeline passes: ${passes}`);
  lines.push('');

  for (let p = 1; p <= passes; p++) {
    const ids = pipelinePlan[String(p)] || [];
    if (ids.length === 0) continue;
    lines.push(`## Pass ${p}`);
    for (const id of ids) {
      const s = selected.find(item => item.id === id);
      if (s) {
        const tag = s.manual ? ' ✎' : '';
        lines.push(`- ${s.title}${tag} (${s.type}, ${s.effort} effort, ${s.impact} impact)`);
      }
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(`*Generated by \`ashmero suggest\`. Re-run: \`ashmero suggest ${projectName} --rerun\`*`);
  lines.push('');

  await fs.mkdir(guideRoot(projDir), { recursive: true });
  const tmp = path.join(
    path.dirname(filePath),
    `.suggestions.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await fs.writeFile(tmp, lines.join('\n'), 'utf-8');
    await fs.rename(tmp, filePath);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}
