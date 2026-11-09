// Lessons — captures failure knowledge (heals, reprompts, escalations,
// validator/verify failures, stalls) to .guide/lessons.jsonl so it survives
// past the run that produced it, then surfaces the most relevant lessons back
// into future dev prompts.
//
// recordLesson() is best-effort by design (brief NFR): a bug here must never
// break the heal/reprompt/escalate/validator-gate/verify-gate flow that calls
// it, so the whole body is wrapped in try/catch and nothing here throws.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { lessonsPath, lessonsDistilledPath } from './guide-paths.js';
import { markdownContractValidator } from './llm-contract.js';
import { sanitiseContent } from './sanitise-content.js';

// 'agent' (Phase 11) — a dev agent's own self-reported lesson, via the
// state-server MCP tool `log_lesson`. Same shape and injection path as the
// other five kinds; distinguished only by kind/source for the audit trail.
// 'verify-refined' (Phase 41) — a phase/fix whose acceptance gate PASSED, but
// only after >=1 refine attempt. Recorded so the near-miss (its initially-unmet
// criteria + files) carries into future phases the same way terminal
// 'verify-fail' lessons do — not just failures teach.
// Phase 68 (brief 05 P3) — two lane-scheduler kinds: 'lane-conflict' (a
// parallel-wave lane's merge conflicted onto the ascending-merged HEAD — a
// files_expected disjointness estimate was wrong, and the phase re-runs
// serially) and 'lane-abandoned' (a later lane discarded to preserve in-order
// merge after an earlier lane failed/conflicted). recordLesson silently drops
// any kind NOT in this list, so both must be registered here to be captured.
// Phase 70 (brief 05 P5) — 'batch-fallback': a single-call minor-fix batch
// (bug_cycle.batch_minor_fixes) whose dev call errored or whose merged-HEAD
// gate failed, falling back to individual per-fix dispatch.
export const LESSON_KINDS = ['heal', 'reprompt', 'escalation', 'validator-fail', 'verify-fail', 'verify-refined', 'verify-unverified', 'stall', 'agent', 'lane-conflict', 'lane-abandoned', 'batch-fallback'];

const DEFAULT_MAX_LESSON_CHARS = 500;
const DEFAULT_INJECT_TOP_K = 5;
const DEFAULT_DISTILL_AFTER_ENTRIES = 50;
const DEFAULT_MAX_DISTILLED_LINES = 150;

// File-path overlap is a far stronger relevance signal than shared keywords —
// a lesson tied to the exact file a phase is about to touch matters much more
// than one that merely shares a word with the phase title/goal.
const FILE_OVERLAP_WEIGHT = 10;
const KEYWORD_OVERLAP_WEIGHT = 1;
// Phase 80 (brief 05 P3) — cross-project global lessons carry stack `tags`
// instead of `files`. Tag overlap is a MUCH weaker signal than a same-project
// file hit: it says "another project on a similar stack learned this", not
// "this exact file bit us". Kept STRICTLY below FILE_OVERLAP_WEIGHT so a local
// lesson with any file overlap always outranks a global lesson with equal
// keyword relevance — local knowledge always wins.
const TAG_OVERLAP_WEIGHT = 3;

const GLOBAL_LESSON_MAX_CHARS = 500;
const DEFAULT_GLOBAL_INJECT_TOP_K = 3;
const DEFAULT_GLOBAL_FIRST_PHASES = 3;
const DEFAULT_GLOBAL_MAX_LINES = 200;

// Cross-project global lessons live BESIDE user.json (~/.ashmero-orchestrator/),
// not under any single project's .guide/ — they are shared across every project.
// Env override is the test seam (mirrors the DB_PATH=':memory:' pattern the
// suite already uses), resolved lazily on every call so a test can set it after
// this module is imported. If a future refactor moves the home dir, follow the
// same os.homedir()-based resolution config-resolver.js uses for user.json.
export function globalLessonsPath() {
  return process.env.AORCH_GLOBAL_LESSONS_PATH
    || path.join(os.homedir(), '.ashmero-orchestrator', 'global-lessons.jsonl');
}

async function readTextSafe(p) {
  try { return await fs.readFile(p, 'utf-8'); } catch { return null; }
}

/**
 * Append one lesson to .guide/lessons.jsonl. Never throws — wrap-and-log,
 * per the brief's "best-effort observation" rule. `lesson` is truncated to
 * cfg.lessons.max_lesson_chars (default 500), mirroring the
 * `.slice(0, 500)` excerpt pattern already used for error_message elsewhere
 * in this codebase (see auto-healer.js recordHealingAttempt calls).
 *
 * @param {string} projDir
 * @param {{kind: string, phase?: number|string|null, fix?: string|null, source?: string|null, lesson: string, files?: string[]}} data
 * @param {object|null} [cfg] - resolved config; only cfg.lessons.max_lesson_chars is read
 */
export async function recordLesson(projDir, data = {}, cfg = null) {
  try {
    const { kind, phase = null, fix = null, source = null, lesson, files = [] } = data;
    if (!projDir || !LESSON_KINDS.includes(kind)) return;
    const maxChars = cfg?.lessons?.max_lesson_chars ?? DEFAULT_MAX_LESSON_CHARS;
    const entry = {
      ts: new Date().toISOString(),
      kind,
      phase,
      fix,
      source,
      lesson: String(lesson ?? '').slice(0, maxChars),
      files: Array.isArray(files) ? files : [],
    };
    const p = lessonsPath(projDir);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.appendFile(p, JSON.stringify(entry) + '\n', 'utf-8');
  } catch { /* best-effort — never propagate to the caller */ }
}

/**
 * Parse .guide/lessons.jsonl into valid lesson entries. Malformed lines and
 * lines missing the required shape are skipped, never thrown on.
 *
 * @param {string} projDir
 * @returns {Promise<object[]>}
 */
export async function readLessons(projDir) {
  const content = await readTextSafe(lessonsPath(projDir));
  if (!content || !content.trim()) return [];
  const out = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (obj && typeof obj === 'object' && LESSON_KINDS.includes(obj.kind) && typeof obj.lesson === 'string') {
      out.push(obj);
    }
  }
  return out;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
}

/**
 * Pure relevance score for one lesson against a phase. Zero cost, no
 * embeddings (brief open question 1 defaults to keyword/file overlap):
 * file-path overlap with phaseMeta.files_expected, plus keyword overlap
 * between the lesson text and the phase's title/goal.
 *
 * Phase 80 (brief 05 P3): a global lesson carries stack `tags` (e.g. ['node',
 * 'vite']) instead of same-project `files`. When `stackTags` is supplied, its
 * overlap with the entry's tags contributes at TAG_OVERLAP_WEIGHT (3) — always
 * below a single file hit (10), so local lessons win. Local lessons have no
 * `tags`, and global lessons have no `files`, so the two terms never both fire
 * for one entry; the extra argument defaults to [] and is a no-op for every
 * pre-phase-80 caller.
 *
 * @param {object} entry - a parsed lesson (see readLessons) or a global row (tags[])
 * @param {object|null} phaseMeta - plan.json phase entry (title, goal, files_expected)
 * @param {string[]} [stackTags] - the current workspace's derived stack tags
 * @returns {number}
 */
export function scoreLesson(entry, phaseMeta, stackTags = []) {
  const files = Array.isArray(entry?.files) ? entry.files : [];
  const expectedFiles = Array.isArray(phaseMeta?.files_expected) ? phaseMeta.files_expected : [];
  const fileOverlap = files.filter((f) => expectedFiles.includes(f)).length;

  const tags = Array.isArray(entry?.tags) ? entry.tags : [];
  const stack = Array.isArray(stackTags) ? stackTags : [];
  const tagOverlap = tags.filter((t) => stack.includes(t)).length;

  const lessonTokens = new Set(tokenize(entry?.lesson));
  const phaseTokens = tokenize(`${phaseMeta?.title || ''} ${phaseMeta?.goal || ''}`);
  const keywordOverlap = phaseTokens.filter((t) => lessonTokens.has(t)).length;

  return fileOverlap * FILE_OVERLAP_WEIGHT
    + tagOverlap * TAG_OVERLAP_WEIGHT
    + keywordOverlap * KEYWORD_OVERLAP_WEIGHT;
}

/**
 * Rank lessons by relevance to `phaseMeta`, ties broken by recency (newer
 * `ts` wins), and return the top K. Lessons that score zero (no file or
 * keyword overlap at all) are dropped regardless of recency.
 *
 * @param {object[]} entries
 * @param {object|null} phaseMeta
 * @param {number} [topK]
 * @param {string[]} [stackTags] - Phase 80: forwarded to scoreLesson for global rows
 * @returns {object[]}
 */
export function selectRelevantLessons(entries, phaseMeta, topK = DEFAULT_INJECT_TOP_K, stackTags = []) {
  return entries
    .map((entry) => ({ entry, score: scoreLesson(entry, phaseMeta, stackTags) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => (b.score - a.score) || String(b.entry.ts || '').localeCompare(String(a.entry.ts || '')))
    .slice(0, topK)
    .map(({ entry }) => entry);
}

// ─── Cross-project global lessons (Phase 80 / brief 05 P3) ──────────────────
//
// A shared ~/.ashmero-orchestrator/global-lessons.jsonl of generalizable
// lessons distilled from EVERY project, each row { ts, project, tags, lesson,
// last_matched }. It is written by finalizeDistillation() (parsing the
// lessons-distill artifact's ## GENERAL section) and injected — sanitised — at
// plan-creation and the first few dev phases so a brand-new project inherits
// hard-won cross-stack knowledge. Cross-project agent-authored content is a
// prompt-injection surface, so it is run through sanitiseContent on BOTH write
// (here) and inject (phase-runner's render): load-bearing, per the brief.
//
// Every entrypoint is best-effort/fail-open: a missing or malformed global file
// yields [] and never touches the per-project flow.

/**
 * Read every valid global-lessons row. Missing file / blank / malformed lines
 * are skipped (never thrown on). A valid row needs a string `lesson` and an
 * array `tags`; other fields are tolerated as-is for forward compatibility.
 *
 * @returns {Promise<Array<{ts?:string, project?:string, tags:string[], lesson:string, last_matched?:string|null}>>}
 */
export async function readGlobalLessons() {
  const content = await readTextSafe(globalLessonsPath());
  if (!content || !content.trim()) return [];
  const out = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (obj && typeof obj === 'object' && typeof obj.lesson === 'string' && Array.isArray(obj.tags)) {
      out.push(obj);
    }
  }
  return out;
}

// Identity key for a global row — dedupe/touch by (project, lesson). Two
// different projects can teach the same lesson; the same project never keeps
// two identical lessons after LRU rewrite.
function globalRowKey(row) {
  return `${row?.project ?? ''} ${row?.lesson ?? ''}`;
}

// LRU recency for eviction: most-recently-matched wins, falling back to the
// write timestamp for rows never yet injected. A missing value sorts oldest.
function globalRecencyKey(row) {
  return String(row?.last_matched || row?.ts || '');
}

async function writeGlobalLessons(rows) {
  const p = globalLessonsPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  const body = rows.map((r) => JSON.stringify(r)).join('\n');
  await fs.writeFile(p, body ? body + '\n' : '', 'utf-8');
}

/**
 * Append rows to the global store, then LRU-evict down to `maxLines` by
 * last_matched (oldest dropped first). Rewrites the whole file (needed for
 * eviction) — best-effort/single-funnel, matching the orchestrator's
 * one-spawn-at-a-time discipline. No-op for an empty `rows`.
 *
 * @param {Array<object>} rows
 * @param {{maxLines?: number}} [opts]
 */
export async function appendGlobalLessons(rows, { maxLines = DEFAULT_GLOBAL_MAX_LINES } = {}) {
  if (!Array.isArray(rows) || !rows.length) return;
  const existing = await readGlobalLessons();
  let all = existing.concat(rows);
  const cap = Number.isFinite(maxLines) && maxLines > 0 ? maxLines : DEFAULT_GLOBAL_MAX_LINES;
  if (all.length > cap) {
    // Sort newest-first by recency, keep the top `cap`, drop the oldest tail.
    all = all
      .map((r, i) => ({ r, i }))
      .sort((a, b) => globalRecencyKey(b.r).localeCompare(globalRecencyKey(a.r)) || (a.i - b.i))
      .slice(0, cap)
      .map(({ r }) => r);
  }
  await writeGlobalLessons(all);
}

/**
 * Rank global rows against a phase (tag overlap, weight 3, + keyword overlap)
 * and return the top K, capped at `topK`. Side-effect: stamps `last_matched`
 * (for LRU) on every selected row and rewrites the file — this NEVER changes
 * the injected prompt bytes (last_matched is not rendered), so cache discipline
 * holds. `touch:false` disables the write (used where determinism-under-test
 * matters more than LRU freshness).
 *
 * @param {{phaseMeta?: object|null, stackTags?: string[], topK?: number, now?: string, touch?: boolean}} args
 * @returns {Promise<Array<object>>} the selected rows (sanitise AGAIN at render)
 */
export async function selectGlobalLessons({ phaseMeta = null, stackTags = [], topK = DEFAULT_GLOBAL_INJECT_TOP_K, now = null, touch = true } = {}) {
  const all = await readGlobalLessons();
  if (!all.length) return [];
  const selected = selectRelevantLessons(all, phaseMeta, topK, stackTags);
  if (touch && selected.length) {
    const stamp = now || new Date().toISOString();
    const selectedKeys = new Set(selected.map(globalRowKey));
    let changed = false;
    for (const r of all) {
      if (selectedKeys.has(globalRowKey(r))) { r.last_matched = stamp; changed = true; }
    }
    if (changed) { try { await writeGlobalLessons(all); } catch { /* best-effort LRU touch */ } }
  }
  return selected;
}

// The STATIC, byte-identical instruction appended to the lessons-distill prompt
// (buildGuidePrompt) when global lessons are enabled. ZERO extra LLM calls: it
// rides on the existing distill call, asking for one extra section. It MUST NOT
// interpolate anything (P1 cache discipline / acceptance criterion: asserted
// byte-identical). finalizeDistillation() parses this section back out.
export const GENERAL_SECTION_INSTRUCTION = `

Finally, append a "## GENERAL" section listing only the lessons that GENERALIZE BEYOND this project — patterns any project on a similar tech stack would benefit from (drop anything project-specific). Write ONE lesson per line, each prefixed with bracketed, comma-separated, lowercase stack tags naming the stack it applies to, for example:
[node,vite] Prefer path.join over string concatenation so paths stay cross-platform.
[express] Await the async route handler or thrown errors escape the surrounding try/catch.
Rules for this section: one lesson per line; every line must start with the [tag,tag] prefix; do NOT include project names, secrets, absolute paths, credentials, or any identifier tied to this project (these lines are shared across ALL projects); omit the ## GENERAL section entirely if nothing here generalizes.`;

/**
 * Parse the "## GENERAL" section out of a lessons-distilled.md body. Returns
 * the well-formed generalizable entries plus the markdown with that section
 * removed (so the per-project distilled file no longer carries it).
 *
 * A well-formed line is `[tag,tag,...] lesson text` (an optional leading `-`/`*`
 * bullet is tolerated). Lines with no bracket prefix, empty tags, or empty
 * lesson text are skipped — never thrown on. Absent section → { entries: [],
 * stripped: <input unchanged> }.
 *
 * @param {string} markdown
 * @returns {{entries: Array<{tags:string[], lesson:string}>, stripped: string}}
 */
export function parseGeneralSection(markdown) {
  const raw = typeof markdown === 'string' ? markdown : '';
  const lines = raw.split('\n');
  // Find the "## GENERAL" heading (case-insensitive, tolerant of trailing text).
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s{0,3}#{1,6}\s+general\b/i.test(lines[i])) { start = i; break; }
  }
  if (start === -1) return { entries: [], stripped: raw };

  // The section runs until the next markdown heading (same or any level) or EOF.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s{0,3}#{1,6}\s+/.test(lines[i])) { end = i; break; }
  }

  const entries = [];
  const LINE_RE = /^\s*(?:[-*]\s*)?\[([^\]]+)\]\s*(.+?)\s*$/;
  for (let i = start + 1; i < end; i += 1) {
    const m = LINE_RE.exec(lines[i]);
    if (!m) continue;
    const tags = m[1].split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    const lesson = m[2].trim();
    if (!tags.length || !lesson) continue;
    entries.push({ tags, lesson });
  }

  // Strip the heading + body; also drop one trailing blank line left behind so
  // the remaining file doesn't accumulate a dangling gap.
  let stripEnd = end;
  if (stripEnd < lines.length && lines[stripEnd] === '') stripEnd += 1;
  const kept = lines.slice(0, start).concat(lines.slice(stripEnd));
  // Trim trailing whitespace-only lines the removal exposed at EOF.
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  const stripped = kept.join('\n') + (kept.length ? '\n' : '');

  return { entries, stripped };
}

/**
 * Pure eligibility gate for injecting global lessons (Phase 80). Among guide
 * tasks ONLY plan-creation qualifies; dev phases qualify only for phase numbers
 * within cfg.lessons.global.first_phases (default 3). Disabled by either
 * lessons.enabled:false or lessons.global.enabled:false.
 *
 * @param {{scope: 'plan-creation'|'dev-phase'|string, phaseN?: number, cfg?: object|null}} args
 * @returns {boolean}
 */
export function globalLessonsEligible({ scope, phaseN = null, cfg = null } = {}) {
  if (cfg?.lessons?.enabled === false) return false;
  if (cfg?.lessons?.global?.enabled === false) return false;
  if (scope === 'plan-creation') return true;
  if (scope === 'dev-phase') {
    const firstPhases = cfg?.lessons?.global?.first_phases ?? DEFAULT_GLOBAL_FIRST_PHASES;
    return typeof phaseN === 'number' && Number.isFinite(phaseN) && phaseN >= 1 && phaseN <= firstPhases;
  }
  return false;
}

/**
 * Is .guide/lessons.jsonl due for distillation? True once the valid-entry
 * count exceeds cfg.lessons.distill_after_entries (default 50).
 *
 * @param {string} projDir
 * @param {object|null} [cfg]
 * @returns {Promise<boolean>}
 */
export async function shouldDistillLessons(projDir, cfg = null) {
  if (cfg?.lessons?.enabled === false) return false;
  const threshold = cfg?.lessons?.distill_after_entries ?? DEFAULT_DISTILL_AFTER_ENTRIES;
  const entries = await readLessons(projDir);
  return entries.length > threshold;
}

/**
 * The distillation cutoff: the newest `ts` among entries currently in
 * lessons.jsonl. Everything at or before this timestamp is folded into the
 * distillation; anything appended after survives finalizeDistillation().
 * Returns null when there is nothing to distill.
 *
 * @param {string} projDir
 * @returns {Promise<string|null>}
 */
export async function computeDistillCutoff(projDir) {
  const entries = await readLessons(projDir);
  if (!entries.length) return null;
  return entries.reduce((max, e) => (typeof e.ts === 'string' && e.ts > max ? e.ts : max), entries[0].ts || '');
}

// Brief 08 / P1(b) — the output contract's deterministic validator for the
// lessons-distill artifact (.guide/lessons-distilled.md). The distilled file is
// "grouped under headings per kind" (buildGuidePrompt's lessons-distill case),
// so the required structure is: AT LEAST ONE markdown heading + non-trivial
// content. The max-lines bound is generous — finalizeDistillation() below caps
// the file to cfg.lessons.max_distilled_lines (150) AFTER the contract runs, so
// this ceiling only catches a runaway artifact, never fights the real cap.
export const validateDistilledLessonsMarkdown = markdownContractValidator({
  requiredHeadings: [],
  minNonEmptyLines: 2,
  maxLines: 400,
});

/**
 * Post-processing after a successful lessons-distill guide run:
 *   1. Phase 80 (brief 05 P3): externalize the ## GENERAL section — parse it
 *      out of lessons-distilled.md, sanitise each generalizable line, append it
 *      (tagged, per-project) to the shared global-lessons.jsonl, and strip the
 *      section from the per-project file. Done BEFORE capping, because the
 *      section lives at the END of the file where a naive line-cap would
 *      truncate it. Best-effort: a global-write failure never blocks the cap /
 *      truncate below. Skipped when lessons.global.enabled is false.
 *   2. Cap .guide/lessons-distilled.md to cfg.lessons.max_distilled_lines
 *      (default 150) — a hard backstop, independent of what the LLM wrote.
 *   3. Drop every raw jsonl entry at or before `cutoffTs` (already folded
 *      into the distilled file) so the next injection reads the compressed
 *      summary instead of the raw backlog. Entries appended after the
 *      cutoff (e.g. by a concurrent session) survive untouched.
 * No-op when cutoffTs is null (nothing was distilled).
 *
 * @param {string} projDir
 * @param {string|null} cutoffTs
 * @param {object|null} [cfg]
 * @param {{projectName?: string}} [opts] - Phase 80: project label for global rows (defaults to basename(projDir))
 * @returns {Promise<{truncated: number, capped: boolean, globalized: number}>}
 */
export async function finalizeDistillation(projDir, cutoffTs, cfg = null, opts = {}) {
  if (!cutoffTs) return { truncated: 0, capped: false, globalized: 0 };

  const maxLines = cfg?.lessons?.max_distilled_lines ?? DEFAULT_MAX_DISTILLED_LINES;
  const distilledFile = lessonsDistilledPath(projDir);
  let capped = false;
  let globalized = 0;
  let distilledContent = await readTextSafe(distilledFile);

  // 1. Externalize the ## GENERAL section into the cross-project global store.
  if (distilledContent != null && cfg?.lessons?.global?.enabled !== false) {
    try {
      const { entries: generalEntries, stripped } = parseGeneralSection(distilledContent);
      if (generalEntries.length) {
        const projectName = opts.projectName || path.basename(projDir);
        const now = new Date().toISOString();
        const rows = generalEntries.map((e) => ({
          ts: now,
          project: sanitiseContent(projectName, 120),
          tags: e.tags.map((t) => sanitiseContent(t, 40)),
          // MANDATORY sanitise-on-write — cross-project agent-authored content.
          lesson: sanitiseContent(e.lesson, GLOBAL_LESSON_MAX_CHARS),
          last_matched: null,
        }));
        await appendGlobalLessons(rows, { maxLines: cfg?.lessons?.global?.max_lines ?? DEFAULT_GLOBAL_MAX_LINES });
        globalized = rows.length;
      }
      if (stripped !== distilledContent) {
        await fs.writeFile(distilledFile, stripped, 'utf-8');
        distilledContent = stripped;
      }
    } catch { /* best-effort — never block the cap/truncate below */ }
  }

  // 2. Hard line-cap backstop.
  if (distilledContent != null) {
    const lines = distilledContent.split('\n');
    if (lines.length > maxLines) {
      await fs.writeFile(distilledFile, lines.slice(0, maxLines).join('\n'), 'utf-8');
      capped = true;
    }
  }

  const entries = await readLessons(projDir);
  const kept = entries.filter((e) => typeof e.ts !== 'string' || e.ts > cutoffTs);
  const truncated = entries.length - kept.length;
  const body = kept.map((e) => JSON.stringify(e)).join('\n');
  await fs.writeFile(lessonsPath(projDir), body ? body + '\n' : '', 'utf-8');

  return { truncated, capped, globalized };
}
