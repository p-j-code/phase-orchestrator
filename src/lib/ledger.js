// Phase ledger (Phase 37 / CE-1) — deterministic cross-phase memory.
//
// WHY: dev sessions are fresh per phase and get zero distilled record of what
// prior phases built — decisions.jsonl is only written by the every-3-phase
// review, so phases 2-3 of a batch see nothing from phase 1, even though
// their reports (on disk) already say what mattered. This module owns
// `.guide/phase-ledger.jsonl` — one schema-validated JSON object PER
// COMPLETED PHASE, appended deterministically by runDev() (src/lib/
// phase-runner.js) immediately after markPhaseCompleted, never by an LLM
// review pass. Mirrors decisions-schema.js's shape exactly: typed fields,
// length caps, AJV validation, skip-invalid-lines-never-throw parsing — the
// same defense-in-depth rationale applies (agent-authored content must never
// carry binding, unbounded-length instructions into a future prompt).
//
// Three tiers of authorship for the bullets:
//   Tier 1 (deterministic, zero LLM): the dev's own completion report is
//     REQUIRED to carry a "## Handoff to next phases" section (3-5 bullets —
//     see prompts/skills/phase-report/SKILL.md). extractHandoffBullets()
//     parses it with a regex extractor shaped like brief-manager.js's
//     loadBriefConstraintsBlock (depth-aware heading scope, no LLM call).
//   Tier 2 (deterministic, zero LLM): older/non-conforming reports are parsed
//     from their Summary, Files, Decisions, Verification, acceptance table,
//     and "For the next phase" sections.
//   Tier 3 (explicit opt-in only): when deterministic extraction fails AND
//     cfg.ledger.llm_extract_fallback is true, extractBulletsViaHaiku() spawns
//     a single roleless, tool-scoped ('Read' only), MCP-free
//     ('ledger-extract' task, no projectDir) call that reads the report and
//     emits { bullets: [...] } JSON. Either tier failing is best-effort: the
//     caller (recordPhaseLedgerEntry) warns and skips — it must NEVER fail an
//     already-completed phase.

import fs from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv';
import chalk from 'chalk';
import { runClaude } from '../claude-runner.js';
import { sanitiseContent } from './sanitise-content.js';
import { phaseLedgerPath } from './guide-paths.js';

// ─── Schema (mirrors decisions-schema.js) ───────────────────────────────────

export const LEDGER_LIMITS = Object.freeze({ title: 120, bullet: 120, commit_sha: 40 });
export const LEDGER_BULLETS_MIN = 3;
export const LEDGER_BULLETS_MAX = 5;

export const ledgerEntrySchema = {
  type: 'object',
  // additionalProperties left open, same rationale as decisionSchema — only
  // title/commit_sha/bullets are ever rendered, so a stray extra key is
  // harmless and dropping an otherwise-valid entry for one would cost
  // availability for no security gain.
  required: ['n', 'title', 'commit_sha', 'bullets'],
  properties: {
    n: { type: 'integer', minimum: 1 },
    title: { type: 'string', maxLength: LEDGER_LIMITS.title },
    commit_sha: { type: 'string', minLength: 1, maxLength: LEDGER_LIMITS.commit_sha },
    bullets: {
      type: 'array',
      minItems: LEDGER_BULLETS_MIN,
      maxItems: LEDGER_BULLETS_MAX,
      items: { type: 'string', minLength: 1, maxLength: LEDGER_LIMITS.bullet },
    },
  },
};

const ajv = new Ajv({ allErrors: false, strict: false });
const _validate = ajv.compile(ledgerEntrySchema);

/**
 * @param {unknown} obj
 * @returns {boolean} true iff `obj` matches the ledger entry schema. Never throws.
 */
export function validateLedgerEntry(obj) {
  return _validate(obj) === true;
}

/**
 * Parse `.guide/phase-ledger.jsonl` content into the last `maxEntries` VALID
 * entries. One JSON object per line. Blank lines, unparseable JSON, and
 * schema-invalid lines are SKIPPED — never thrown on. Insertion order is
 * preserved; the tail (last `maxEntries` valid entries) is what a dev prompt
 * actually needs.
 *
 * @param {string} content
 * @param {number} [maxEntries=0] - 0 or negative means "no cap"
 * @returns {object[]}
 */
export function parsePhaseLedgerJsonl(content, maxEntries = 0) {
  if (!content || typeof content !== 'string') return [];
  const valid = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; } // malformed JSON → skip
    if (validateLedgerEntry(obj)) valid.push(obj); // schema-invalid → skip
  }
  if (maxEntries > 0 && valid.length > maxEntries) return valid.slice(-maxEntries);
  return valid;
}

/**
 * Render ONE ledger entry as a short block: a header line (phase number,
 * title, short commit sha) followed by its bullets, each capped then
 * XML-escaped via sanitiseContent — same defense-in-depth composition as
 * decisions-schema.js's renderDecisionLine.
 *
 * @param {object} entry
 * @returns {string}
 */
export function renderLedgerEntry(entry) {
  const title = sanitiseContent(entry?.title, LEDGER_LIMITS.title);
  const sha = sanitiseContent(String(entry?.commit_sha ?? '').slice(0, 8), 8);
  const bullets = (Array.isArray(entry?.bullets) ? entry.bullets : [])
    .map((b) => `  - ${sanitiseContent(b, LEDGER_LIMITS.bullet)}`)
    .join('\n');
  return `- Phase ${entry?.n} — ${title} (${sha})\n${bullets}`;
}

async function readText(p) {
  try { return await fs.readFile(p, 'utf-8'); } catch { return null; }
}

/**
 * Append ONE validated entry to `.guide/phase-ledger.jsonl`, creating the
 * `.guide/` directory if needed. Append-only — never rewrites or reorders
 * earlier lines.
 *
 * @param {string} ledgerFilePath
 * @param {object} entry - already validated by the caller
 */
async function appendLedgerLine(ledgerFilePath, entry) {
  await fs.mkdir(path.dirname(ledgerFilePath), { recursive: true });
  await fs.appendFile(ledgerFilePath, `${JSON.stringify(entry)}\n`, 'utf-8');
}

// ─── Tier 1: deterministic extraction from the dev's own report ────────────

const HANDOFF_HEADING_RE = /^(#{1,6})\s+(.+)/;
const BULLET_LINE_RE = /^\s*[-*]\s+(.+)/;

/**
 * Extract the "## Handoff to next phases" section's bullet list from a
 * completion report — depth-aware heading scope, shaped like
 * brief-manager.js's loadBriefConstraintsBlock extractor (find the heading,
 * capture everything until a heading at the same or shallower depth).
 * Pure, no I/O, never throws.
 *
 * @param {string|null|undefined} reportText
 * @returns {string[]|null} 3-5 bullet strings, or null when the section is
 *   absent, has no bullet lines, or has fewer than LEDGER_BULLETS_MIN.
 */
export function extractHandoffBullets(reportText) {
  if (!reportText || typeof reportText !== 'string') return null;

  const lines = reportText.split('\n');
  const captured = [];
  let inTarget = false;
  let targetDepth = 0;

  for (const line of lines) {
    const m = line.match(HANDOFF_HEADING_RE);
    if (m) {
      const depth = m[1].length;
      const title = m[2].trim().toLowerCase();
      if (title.includes('handoff to next phase')) {
        inTarget = true;
        targetDepth = depth;
        continue; // heading line itself is not a bullet
      }
      if (inTarget && depth <= targetDepth) {
        inTarget = false;
      }
      continue;
    }
    if (inTarget) captured.push(line);
  }

  const bullets = captured
    .map((l) => l.match(BULLET_LINE_RE))
    .filter(Boolean)
    .map((m) => m[1].trim())
    .filter(Boolean);

  if (bullets.length < LEDGER_BULLETS_MIN) return null;
  return bullets.slice(0, LEDGER_BULLETS_MAX);
}

function normalizeFallbackBullet(value) {
  let text = String(value || '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || /^[-:|\s]+$/.test(text)) return null;
  if (text.length > LEDGER_LIMITS.bullet) text = `${text.slice(0, LEDGER_LIMITS.bullet - 1).trimEnd()}…`;
  return text;
}

/**
 * Deterministically recover durable bullets from completion reports that
 * predate (or accidentally omit) the mandatory handoff section. This parser
 * deliberately favors explicit markdown structure over prose inference; its
 * output is bounded, deduplicated, and never executes a provider call.
 */
export function extractStructuredReportBullets(reportText, { title = null, commitSha = null } = {}) {
  if (!reportText || typeof reportText !== 'string') return null;
  const lines = reportText.split('\n');
  const candidates = [];
  const changedFiles = [];
  const acceptance = [];
  let section = '';

  const add = (value, prefix = '') => {
    const normalized = normalizeFallbackBullet(value);
    if (normalized) candidates.push(normalizeFallbackBullet(`${prefix}${normalized}`));
  };

  for (const rawLine of lines) {
    const heading = rawLine.match(HANDOFF_HEADING_RE);
    if (heading) {
      section = heading[2].trim().toLowerCase();
      continue;
    }
    const line = rawLine.trim();
    if (!line) continue;

    if (/files? (changed|created|modified|deleted)|exact edits/.test(section)) {
      const bullet = line.match(BULLET_LINE_RE)?.[1];
      const codePaths = [...line.matchAll(/`([^`]+(?:\.[A-Za-z0-9]+|\/[^`]+))`/g)].map((match) => match[1]);
      if (bullet && /[/.]/.test(bullet)) changedFiles.push(normalizeFallbackBullet(bullet));
      for (const filePath of codePaths) changedFiles.push(normalizeFallbackBullet(filePath));
      continue;
    }

    if (/acceptance criteria/.test(section) && line.startsWith('|')) {
      const cells = line.split('|').map((cell) => cell.trim()).filter(Boolean);
      if (cells.length >= 2 && !/^criterion$/i.test(cells[0]) && !/^[-:]+$/.test(cells[0])) {
        const status = cells[1].toLowerCase();
        if (/partial|uncertain|unmet|fail|blocked/.test(status)) {
          acceptance.push(`Unresolved: ${cells[0]} (${cells[1]})`);
        } else if (/done|pass|met/.test(status)) {
          acceptance.push(`Verified: ${cells[0]}`);
        }
      }
      continue;
    }

    const durableSection = /summary|decision|handoff|next phase|guide should know|gotcha|deviation|tech debt|known issue/.test(section);
    const verificationSection = /verification|test results?/.test(section);
    const bullet = line.match(BULLET_LINE_RE)?.[1];
    if (durableSection && bullet) add(bullet);
    else if (durableSection && !line.startsWith('|') && line.length >= 12) add(line);
    else if (verificationSection && bullet) add(bullet, 'Verification: ');
  }

  if (changedFiles.length) {
    const files = [...new Set(changedFiles.filter(Boolean))].slice(0, 3);
    if (files.length) add(files.join(', '), 'Changed files: ');
  }
  for (const item of acceptance.slice(0, 2)) add(item);

  // A report with useful but sparse structure should still produce a durable
  // ledger row without paying for an LLM. These metadata fallbacks are factual
  // and bounded; they are used only until the 3-bullet schema minimum is met.
  if (candidates.length < LEDGER_BULLETS_MIN && title) add(`Completed phase scope: ${title}`);
  if (candidates.length < LEDGER_BULLETS_MIN && commitSha) add(`Implementation commit: ${String(commitSha).slice(0, 12)}`);

  const deduped = [];
  const seen = new Set();
  for (const candidate of candidates.filter(Boolean)) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped.length >= LEDGER_BULLETS_MIN ? deduped.slice(0, LEDGER_BULLETS_MAX) : null;
}

// ─── Tier 2: haiku fallback extraction ──────────────────────────────────────

// Fixed literal, no interpolation — same P1 cache-discipline guarantee as
// verify-loop.js's CHECKER_SYSTEM_PROMPT.
export const LEDGER_EXTRACT_SYSTEM_PROMPT =
  `You extract a short handoff summary from a phase completion report for a durable cross-phase ` +
  `memory ledger. You are strictly read-only: you have a Read tool only, no Write, Edit, or Bash, ` +
  `and cannot modify anything. Your only output is a single JSON object as your final reply — no ` +
  `other text.`;

function buildLedgerExtractPrompt(relReportPath) {
  return `Read ${relReportPath} and extract 3 to 5 short bullet points (each under ~120 characters) capturing durable decisions made, API/schema shapes introduced, and gotchas future phases must know. Skip phase-specific trivia — only things a LATER phase would need.

Reply with EXACTLY one JSON object and nothing else (no markdown fence, no prose):
{"bullets": ["<bullet 1>", "<bullet 2>", "..."]}`;
}

function parseLedgerExtractReply(raw) {
  let obj;
  try { obj = JSON.parse(String(raw ?? '').trim()); } catch { return null; }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.bullets)) return null;
  const bullets = obj.bullets
    .filter((b) => typeof b === 'string' && b.trim())
    .map((b) => b.trim());
  if (bullets.length < LEDGER_BULLETS_MIN) return null;
  return bullets.slice(0, LEDGER_BULLETS_MAX);
}

/**
 * Tier-2 fallback: one bounded haiku call ('ledger-extract' task) that reads
 * the report and emits bullets as JSON. Roleless (role:null), sessionless
 * (sessionId:null) — same session-safety class as acceptance-check/
 * lessons-distill — and deliberately omits `projectDir` so it never wires MCP
 * regardless of cfg.mcp.enabled. A cfg CLONE narrows tools.allowed_default to
 * ['Read'] only; the caller's own cfg.tools is never mutated.
 *
 * @param {Object} args
 * @param {Object} args.cfg
 * @param {string} args.projectName
 * @param {string} args.workspaceDir
 * @param {string} args.relReportPath
 * @param {number} [args.nextPhase]
 * @param {{runClaude?: Function}} [deps]
 * @returns {Promise<string[]|null>}
 */
export async function extractBulletsViaHaiku({ cfg, projectName, workspaceDir, relReportPath, nextPhase }, deps = {}) {
  const runClaudeFn = deps.runClaude ?? runClaude;
  const extractCfg = {
    ...cfg,
    model: cfg?.models?.['ledger-extract'],
    tools: { ...cfg?.tools, allowed_default: ['Read'] },
  };
  delete extractCfg._effort_override;

  let result;
  try {
    result = await runClaudeFn({
      cfg: extractCfg,
      cwd: workspaceDir,
      prompt: buildLedgerExtractPrompt(relReportPath),
      systemPromptFile: null,
      systemPromptExtra: LEDGER_EXTRACT_SYSTEM_PROMPT,
      sessionId: null,
      role: null,
      project: projectName,
      phase: nextPhase,
      task: 'ledger-extract',
    });
  } catch (err) {
    console.warn(chalk.yellow(`[phase-ledger] extract-fallback spawn failed: ${err.message}`));
    return null;
  }
  if (result?.is_error) {
    console.warn(chalk.yellow(`[phase-ledger] extract-fallback call errored: ${(result.error_message || result.result || '').toString().slice(0, 200)}`));
    return null;
  }
  return parseLedgerExtractReply(result?.result);
}

// ─── Orchestration: build + append one entry for a completed phase ─────────

/**
 * Deterministic-first, best-effort append of one ledger entry for a
 * just-completed phase. Called from runDev() (phases only) immediately after
 * markPhaseCompleted. NEVER throws — every failure mode (disabled, missing
 * report, unparseable section with fallback off, fallback spawn/parse
 * failure, schema-invalid entry) warns and returns null, so ledger trouble
 * can never fail an already-completed phase.
 *
 * @param {Object} args
 * @param {string} args.projDir
 * @param {string} args.workspaceDir
 * @param {string} args.projectName
 * @param {number} args.n
 * @param {string|null} args.title
 * @param {string|null} args.commitSha
 * @param {string} args.reportPath - absolute path to the phase's report.md
 * @param {Object} args.cfg
 * @param {number} [args.nextPhase] - passed through to the haiku fallback's telemetry only
 * @param {{runClaude?: Function}} [deps]
 * @returns {Promise<object|null>} the appended entry, or null if nothing was appended
 */
export async function recordPhaseLedgerEntry(
  { projDir, workspaceDir, projectName, n, title, commitSha, reportPath, cfg, nextPhase },
  deps = {},
) {
  if (cfg?.ledger?.enabled === false) return null;

  const reportText = await readText(reportPath);
  let bullets = extractHandoffBullets(reportText);

  if (!bullets && cfg?.ledger?.extract_fallback !== false) {
    bullets = extractStructuredReportBullets(reportText, { title, commitSha });
  }

  if (!bullets) {
    if (cfg?.ledger?.extract_fallback === false) {
      const why = reportText === null ? 'report file unreadable' : 'no "## Handoff to next phases" section found';
      console.warn(chalk.yellow(`[phase-ledger] phase ${n}: ${why} and extract_fallback is disabled — skipping ledger entry`));
      return null;
    }
    if (cfg?.ledger?.llm_extract_fallback !== true) {
      console.warn(chalk.yellow(`[phase-ledger] phase ${n}: deterministic extraction produced no durable handoff; LLM fallback is disabled — skipping ledger entry`));
      return null;
    }
    const relReportPath = path.relative(workspaceDir, reportPath);
    bullets = await extractBulletsViaHaiku({ cfg, projectName, workspaceDir, relReportPath, nextPhase }, deps);
    if (!bullets) {
      console.warn(chalk.yellow(`[phase-ledger] phase ${n}: could not extract handoff bullets (section missing and fallback produced nothing) — skipping ledger entry`));
      return null;
    }
  }

  // Cap title/bullets to the schema limits BEFORE validation — an over-long
  // title (or bullet) would otherwise fail validateLedgerEntry and silently drop
  // the entire cross-phase handoff entry. Plain slice (not sanitiseContent) so we
  // don't XML-escape stored content that renderLedgerForPrompt escapes at render.
  const entry = {
    n,
    title: String(title || `phase-${n}`).slice(0, LEDGER_LIMITS.title),
    commit_sha: commitSha || '(unknown)',
    bullets: Array.isArray(bullets) ? bullets.map((b) => String(b).slice(0, LEDGER_LIMITS.bullet)) : bullets,
  };
  if (!validateLedgerEntry(entry)) {
    console.warn(chalk.yellow(`[phase-ledger] phase ${n}: assembled entry failed schema validation — skipping ledger entry`));
    return null;
  }

  await appendLedgerLine(phaseLedgerPath(projDir), entry);
  return entry;
}
