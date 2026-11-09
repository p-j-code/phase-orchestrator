// src/lib/ai-suggestion-scanner.js
//
// Generates AI-powered project suggestions via claude-runner.js (tracked by
// billing guard, recorded in calls table, routed through model router).
// Falls back gracefully — callers should catch and use the rules engine on error.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { runClaude } from '../claude-runner.js';
import { generateRepoMap, renderRepoMapBlock } from './repo-map.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = path.resolve(__dirname, '..', '..');

const VALID_TYPES     = new Set(['new-feature', 'enhancement', 'ui-improvement', 'perf', 'security', 'dx']);
const VALID_CATS      = new Set(['logic', 'frontend', 'infra', 'security', 'dx']);
const VALID_EFFORTS   = new Set(['small', 'medium', 'large']);
const VALID_IMPACTS   = new Set(['low', 'medium', 'high']);

/**
 * Call Claude to generate suggestions for a project.
 * @param {import('./project-scanner.js').ScanSnapshot} snapshot
 * @param {string}   userGoal        — freetext from the upfront question
 * @param {string[]} areas           — selected area values, e.g. ['logic', 'frontend']
 * @param {object}   cfg             — resolved config (from config-resolver.js)
 * @param {string[]} [previousTitles] — titles already generated in prior sessions (will be excluded)
 * @param {{ callClaude?: (prompt: string, projectName: string, cfg: object) => Promise<string>, generateRepoMap?: Function }} [deps]
 * @param {string|null} [projectName] — canonical project name for billing attribution; falls back to snapshot.name
 * @param {string|null} [projDir] — absolute project directory (parent of workspace/); required for the
 *   repo-map injection below — without it the map is skipped, never derived from process cwd.
 * @returns {Promise<import('../lib/suggestion-engine.js').Suggestion[]>}
 */
export async function generateAISuggestions(snapshot, userGoal, areas, cfg, previousTitles = [], deps = {}, projectName = null, projDir = null) {
  const callClaude = deps.callClaude ?? _callClaude;
  const mapBlock = await _maybeLoadRepoMapBlock(cfg, projDir, deps);
  const prompt = _buildPrompt(snapshot, userGoal, areas, previousTitles, mapBlock);
  const raw = await callClaude(prompt, projectName ?? snapshot.name, cfg);
  return _parseResponse(raw);
}

// Phase 16 (brief P1 injection) — 'suggest-scan' is not a runGuide() task, so
// it can't share phase-runner.js's loadRepoMapBlock wiring: this call runs
// with cwd:REPO_ROOT (the orchestrator's own repo, see _callClaude below), so
// the map MUST be generated against the target project's workspaceDir
// explicitly, never derived from cwd. Fail-open: any error here just skips
// the block, same contract as every other repo-map call site.
async function _maybeLoadRepoMapBlock(cfg, projDir, deps = {}) {
  const guideTasks = cfg?.repo_map?.guide_tasks;
  if (!projDir || !Array.isArray(guideTasks) || !guideTasks.includes('suggest-scan')) return null;
  const generateRepoMapFn = deps.generateRepoMap ?? generateRepoMap;
  try {
    const workspaceDir = path.join(projDir, cfg.paths?.workspace_subdir || 'workspace');
    const map = await generateRepoMapFn({ workspaceDir, projDir, cfg });
    return map ? renderRepoMapBlock(map) : null;
  } catch (err) {
    console.warn(chalk.yellow(`[repo-map] suggest-scan injection skipped: ${err.message}`));
    return null;
  }
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function _buildPrompt(snapshot, userGoal, areas, previousTitles, mapBlock = null) {
  const areaStr     = areas.length ? areas.join(', ') : 'all areas';
  const depsStr     = snapshot.dependencies.slice(0, 40).join(', ') || 'none detected';
  const scriptsStr  = snapshot.scripts.join(', ') || 'none';
  const dirsStr     = snapshot.srcStructure.dirs.join(', ') || 'none';
  const phasesStr   = snapshot.phaseTitles.join(', ') || 'none';

  const sections = [
    // ── Identity ──────────────────────────────────────────────────────────────
    `PROJECT: ${snapshot.name} (${snapshot.projectType})`,
    snapshot.description ? `DESCRIPTION: ${snapshot.description}` : null,

    // ── Dependencies + scripts ────────────────────────────────────────────────
    `DEPENDENCIES: ${depsStr}`,
    `NPM SCRIPTS: ${scriptsStr}`,

    // ── Config signals ─────────────────────────────────────────────────────────
    snapshot.detectedConfigs?.length
      ? `CONFIG FILES PRESENT: ${snapshot.detectedConfigs.join(', ')}`
      : null,

    // ── Codebase structure ────────────────────────────────────────────────────
    `SRC DIRS: ${dirsStr}  |  SRC FILE COUNT: ${snapshot.srcStructure.fileCount}`,
    snapshot.rootFiles?.length
      ? `ROOT FILES: ${snapshot.rootFiles.slice(0, 25).join(', ')}`
      : null,

    // ── Test setup ────────────────────────────────────────────────────────────
    `HAS TESTS: ${snapshot.hasTests ? 'yes' : 'no'}${snapshot.testFramework ? ' (' + snapshot.testFramework + ')' : ''}`,

    // ── Entry point peek ──────────────────────────────────────────────────────
    snapshot.entryExcerpt
      ? `ENTRY FILE (${snapshot.entryFile}, first 500 chars):\n${snapshot.entryExcerpt}`
      : null,

    // ── Environment shape ─────────────────────────────────────────────────────
    snapshot.envExampleExcerpt
      ? `ENV EXAMPLE (.env.example, first 300 chars):\n${snapshot.envExampleExcerpt}`
      : null,

    // ── Database schema ───────────────────────────────────────────────────────
    snapshot.schemaExcerpt
      ? `DB SCHEMA (first 400 chars):\n${snapshot.schemaExcerpt}`
      : null,

    // ── Git history ───────────────────────────────────────────────────────────
    snapshot.gitLogExcerpt
      ? `RECENT GIT COMMITS (last 12):\n${snapshot.gitLogExcerpt}`
      : null,

    // ── Phase history ─────────────────────────────────────────────────────────
    `COMPLETED PHASES: ${snapshot.completedPhases}`,
    `RECENT PHASE TITLES (newest first): ${phasesStr}`,

    // ── Open bugs ─────────────────────────────────────────────────────────────
    snapshot.openBugCount > 0
      ? `OPEN BUGS: ${snapshot.openBugCount} (consider bug-fix or stability suggestions)`
      : null,

    // ── Guide context ─────────────────────────────────────────────────────────
    snapshot.readmeExcerpt
      ? `README (first 600 chars):\n${snapshot.readmeExcerpt}`
      : null,
    snapshot.handoffExcerpt
      ? `LATEST HANDOFF (first 400 chars):\n${snapshot.handoffExcerpt}`
      : null,
    snapshot.rawThoughtsExcerpt
      ? `RAW THOUGHTS (first 400 chars):\n${snapshot.rawThoughtsExcerpt}`
      : null,
  ].filter(Boolean).join('\n\n');

  const avoidBlock = previousTitles.length
    ? `\nALREADY SUGGESTED (do NOT repeat or paraphrase these):\n${previousTitles.map(t => `- ${t}`).join('\n')}\n`
    : '';

  const mapPrefix = mapBlock ? `${mapBlock}\n\n` : '';

  return `${mapPrefix}You are a senior software engineer reviewing a real project. Based on all the context below, generate 8–15 specific, actionable suggestions for the next pipeline run.

USER GOAL: ${userGoal || 'General improvements and new features'}
FOCUS AREAS: ${areaStr}
${avoidBlock}
${sections}

Return ONLY a valid JSON array — no markdown fences, no prose, no explanation. Start with [ and end with ].

Each suggestion object must follow this exact schema:
{
  "id": "unique-kebab-case-id",
  "type": "new-feature|enhancement|ui-improvement|perf|security|dx",
  "category": "logic|frontend|infra|security|dx",
  "title": "concise title, max 60 chars",
  "description": "1–2 sentences explaining what and why",
  "effort": "small|medium|large",
  "impact": "low|medium|high",
  "suggestedSlot": 1
}

Guidelines:
- Be VERY SPECIFIC — reference actual file names, dep names, script names, or git commit context
- suggestedSlot 1 = high-priority / core, 2 = polish/extend, 3 = nice-to-have, 4–5 = future
- Only include categories that match FOCUS AREAS: ${areaStr}
- Do NOT suggest anything already done (check RECENT PHASE TITLES and RECENT GIT COMMITS)${previousTitles.length ? '\n- Do NOT repeat or paraphrase items listed under ALREADY SUGGESTED' : ''}
- If OPEN BUGS > 0, include at least one stability/reliability suggestion
- Aim for a mix of effort levels; prefer small/medium wins early (slot 1)
- Output ONLY the JSON array`;
}

// ─── Claude invocation ────────────────────────────────────────────────────────

async function _callClaude(prompt, projectName, cfg) {
  const model = process.env.ASHMERO_SUGGEST_MODEL || cfg.model;
  const modelCfg = model !== cfg.model ? { ...cfg, model } : cfg;

  const result = await runClaude({
    cfg:     modelCfg,
    cwd:     REPO_ROOT,
    prompt,
    task:    'suggest-scan',
    project: projectName,
    role:    'suggest',
  });

  if (result.is_error) {
    throw new Error(`AI suggest failed: ${String(result.result || '').slice(0, 200)}`);
  }
  return result.result;
}

// ─── Response parser ──────────────────────────────────────────────────────────

export function _parseResponse(raw) {
  // Walk string-aware: track whether inside a JSON double-quoted string so
  // brackets in string values are never mistaken for structural delimiters.
  let depth = 0;
  let start = -1;
  let inString = false;
  let parsed = null;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    if (inString) {
      if (ch === '\\') {
        i++; // skip the escaped character (\" or \\ or any other \X)
      } else if (ch === '"') {
        inString = false;
      }
      continue; // never count brackets inside a string
    }

    // Outside a string:
    if (ch === '"') {
      inString = true;
    } else if (ch === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === ']' && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          const candidate = JSON.parse(raw.slice(start, i + 1));
          if (Array.isArray(candidate)) { parsed = candidate; break; }
        } catch {}
        start = -1;
      }
    }
  }

  if (!parsed) throw new Error('AI response contained no JSON array');

  // Coerce each item, filtering out primitives and items missing id/title.
  const valid = [];
  for (const s of parsed) {
    if (!s || typeof s !== 'object') continue;
    if (!s.id || !s.title) continue;

    valid.push({
      id:            String(s.id).replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 64),
      type:          VALID_TYPES.has(s.type) ? s.type : 'enhancement',
      category:      VALID_CATS.has(s.category) ? s.category : 'logic',
      title:         String(s.title).slice(0, 60),
      description:   String(s.description || ''),
      effort:        VALID_EFFORTS.has(s.effort) ? s.effort : 'medium',
      impact:        VALID_IMPACTS.has(s.impact) ? s.impact : 'medium',
      suggestedSlot: [1, 2, 3, 4, 5].includes(Number(s.suggestedSlot)) ? Number(s.suggestedSlot) : 1,
      appliesTo:     ['cli', 'frontend', 'api', 'fullstack', 'unknown'],
    });
  }

  // Dedup ids: pre-seed with all original ids so that suffix candidates never shadow
  // a naturally-keyed item that appears later in the array. Loop the suffix until the
  // candidate is free in both the emitted set and the full original-id set.
  const allOriginalIds = new Set(valid.map(s => s.id));
  const seenIds = new Set();
  const deduped = valid.map(s => {
    if (!seenIds.has(s.id)) {
      seenIds.add(s.id);
      return s;
    }
    let n = 1;
    let candidate;
    do {
      candidate = `${s.id}-${n}`;
      n++;
    } while (seenIds.has(candidate) || allOriginalIds.has(candidate));
    seenIds.add(candidate);
    return { ...s, id: candidate };
  });

  if (deduped.length === 0) throw new Error('No valid suggestions found in AI response');
  return deduped;
}
