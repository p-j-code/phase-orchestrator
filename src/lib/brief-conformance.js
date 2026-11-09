// Brief Conformance Check (phase-47 / P4) — the back-of-pipeline FR->evidence
// complement to the front-of-pipeline plan-coverage gate (src/lib/plan-
// validate.js + the .guide/plan-coverage.md gate in auto-runner.js, left
// untouched). Where plan-coverage checks "does every brief FR map to a plan
// phase?" BEFORE phase 1, this checks "does the CODE actually satisfy every
// brief FR?" right before ready-for-qa.
//
// This module CLONES src/lib/verify-loop.js's roleless read-only checker
// pattern (frozen tool sandbox, static literal system prompt, deterministic
// prompt builder, ajv verdict schema, checker's final reply IS the verdict
// JSON, orchestrator persists it, role:null + sessionId:null so guide/dev
// session bookkeeping is never touched, one re-ask on invalid JSON) — it does
// NOT import verify-loop's internals and never modifies that file.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import chalk from 'chalk';
import { runClaude } from '../claude-runner.js';
import { getPhases, addDedupedBug } from '../state.js';
import {
  guideRoot, phaseReportPath, briefConformancePath, briefConformanceMdPath,
} from './guide-paths.js';
import { activeBriefPath, briefHash } from './brief-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ─── Verdict schema (ajv) ────────────────────────────────────────────────────

const SCHEMA_PATH = path.join(REPO_ROOT, 'config', 'schemas', 'brief-conformance.schema.json');
const SCHEMA = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));

const ajv = new Ajv({ allErrors: true, strict: false });
const _validate = ajv.compile(SCHEMA);

// ─── Tool sandbox ────────────────────────────────────────────────────────────
//
// Same shape as verify-loop.js's CHECKER_ALLOWED_TOOLS — a fresh literal, not
// an import, per the brief's "clone the pattern, do not import the internals"
// instruction. No Write, no Edit, no unrestricted Bash: the checker can never
// mutate the workspace.
export const BRIEF_CONFORMANCE_ALLOWED_TOOLS = Object.freeze([
  'Read', 'Glob', 'Grep', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)',
]);

// Fixed literal, no interpolation — same P1 cache-discipline guarantee as
// verify-loop.js's CHECKER_SYSTEM_PROMPT.
export const BRIEF_CONFORMANCE_SYSTEM_PROMPT =
  `You are the Ashmero Orchestrator's brief conformance checker. You are invoked once, ` +
  `at the end of a plan's phases, to grade the project's BRIEF (functional requirements ` +
  `and Definition of done) against the code as actually committed. You are a fresh ` +
  `reviewer — you did not write this code. Phase reports and prior claims of completion ` +
  `are claims, not evidence: evidence means files, tests, or commits you can point at. ` +
  `You are strictly read-only: you have no Write, Edit, or unrestricted Bash tool and ` +
  `cannot modify the workspace in any way. Your only output is a single JSON verdict ` +
  `object as your final reply — no other text.`;

// ─── Prompt builder ──────────────────────────────────────────────────────────

/**
 * Build the checker's task prompt. Pure function of its inputs — same inputs
 * always produce the same byte-identical output (no Date.now()/new Date(),
 * no randomness).
 *
 * @param {Object} args
 * @param {string} args.briefText - the active brief snapshot's full text
 * @param {string} args.planSummary - compact "phase n/title/status" listing
 * @param {string[]} args.reportPointers - workspace-relative phase report paths
 * @returns {string}
 */
export function buildBriefConformancePrompt({ briefText, planSummary, reportPointers }) {
  const brief = (briefText || '').trim() || '(brief unavailable)';
  const summary = (planSummary || '').trim() || '(no phases)';
  const pointers = (reportPointers || []).length
    ? reportPointers.map((p) => `- ${p}`).join('\n')
    : '(no phase reports found)';

  return `You are grading this project's BRIEF against the code as committed. You did not write this code. Your job is to verify — strictly and with evidence — whether every functional requirement (FR) and Definition-of-done item is actually satisfied by the code as committed.

Rules:
- Extract every functional requirement from the brief below. Briefs commonly number them "FR1"/"FR-12" style — reuse those ids verbatim; if the brief has no explicit ids, assign sequential ones ("FR1", "FR2", ...) in the order they appear.
- Also grade the brief's "Definition of done" section (if present) the same way — fold each item into the frs[] list with its own id (e.g. "DoD1").
- For each item, find concrete evidence in the CODE (file:line, a test file, or a commit) that it is implemented. The phase reports listed below are a claim, not evidence — read them for pointers, then verify against the actual code with Read/Glob/Grep and the three scoped git inspection commands (git diff, git log, git show).
- status "met": clear evidence the item is implemented. "partial": some evidence but incomplete. "missing": no evidence found despite a real search.
- You have no Write, Edit, or unrestricted Bash tool — you cannot modify the workspace or write a file yourself. Your final reply must contain EXACTLY one JSON object matching the schema below and nothing else (no markdown fence, no prose, no "done").

Verdict JSON schema:
{
  "frs": [
    { "id": "<e.g. FR1>", "requirement": "<verbatim/summary from brief>", "status": "met" | "partial" | "missing", "evidence": ["<file:line, test file, or commit sha>"], "notes": "<optional>" }
  ],
  "summary": "<one paragraph overall assessment>"
}

Plan phases (n: title [status]):
${summary}

Phase report pointers (workspace-relative — read for context, then verify against the code):
${pointers}

Brief (grade every FR and Definition-of-done item against the code):
${brief}`;
}

function buildReaskPrompt(errors) {
  const errList = (errors || []).map((e) => `- ${e}`).join('\n') || '- (validation failed)';
  return `Your previous reply was not a valid verdict JSON. Validation errors:
${errList}

Reply again with EXACTLY one JSON object matching the schema — no markdown fence, no extra prose, no "done".`;
}

// ─── Verdict parsing ─────────────────────────────────────────────────────────

// Tolerates a reply wrapped in a markdown fence or trailing prose, mirroring
// verify-loop.js's tolerantJsonParse (a fresh clone, not an import).
function tolerantJsonParse(text) {
  const trimmed = String(text ?? '').trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }

  const start = trimmed.indexOf('{');
  if (start < 0) throw new Error('no JSON object found in checker reply');
  let depth = 0;
  for (let i = start; i < trimmed.length; i += 1) {
    if (trimmed[i] === '{') depth += 1;
    else if (trimmed[i] === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(trimmed.slice(start, i + 1));
    }
  }
  throw new Error('unterminated JSON in checker reply');
}

/**
 * Parse + ajv-validate a checker reply against brief-conformance.schema.json.
 * @param {unknown} raw - the checker's final reply text (or an already-parsed object)
 * @returns {{ok: true, verdict: object} | {ok: false, errors: string[]}}
 */
export function parseConformanceVerdict(raw) {
  let obj;
  try {
    obj = typeof raw === 'string' ? tolerantJsonParse(raw) : raw;
  } catch (err) {
    return { ok: false, errors: [`invalid JSON: ${err.message}`] };
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['verdict is not a JSON object'] };
  }
  if (!_validate(obj)) {
    const errors = (_validate.errors || []).map((e) => `${e.instancePath || '(root)'} ${e.message}`);
    return { ok: false, errors };
  }
  return { ok: true, verdict: obj };
}

// ─── Decision logic ──────────────────────────────────────────────────────────

/**
 * Deterministic, pure gate decision over a persisted verdict envelope.
 *   - `verdict` missing, or stamped `_status: 'inconclusive'` (the checker
 *     never produced a valid verdict, even after the one re-ask) → blocks
 *     only when `failOpen` is false (mirrors verify.fail_open's semantics).
 *   - any FR/DoD item with status 'missing' → blocks.
 *   - 'partial' items never block on their own — they are surfaced in the
 *     rendered matrix for the tester, nothing more.
 *
 * @param {object|null} verdict - a schema-valid verdict object (see
 *   parseConformanceVerdict), optionally carrying an internal `_status`
 *   field ('checked' | 'inconclusive') as persisted by runBriefConformance.
 * @param {{failOpen?: boolean}} [opts]
 * @returns {{block: boolean, inconclusive: boolean, missing: object[], partial: object[]}}
 */
export function decideConformance(verdict, { failOpen = true } = {}) {
  const inconclusive = !verdict || verdict._status === 'inconclusive';
  if (inconclusive) {
    return { block: !failOpen, inconclusive: true, missing: [], partial: [] };
  }
  const frs = Array.isArray(verdict.frs) ? verdict.frs : [];
  const missing = frs.filter((f) => f?.status === 'missing');
  const partial = frs.filter((f) => f?.status === 'partial');
  return { block: missing.length > 0, inconclusive: false, missing, partial };
}

// ─── Human-readable matrix ───────────────────────────────────────────────────

function escapeCell(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function renderConformanceMd({ verdict, decision }) {
  const lines = [];
  lines.push('# Brief conformance check');
  lines.push('');
  lines.push('> Read-only checker (phase-47) grading the brief\'s functional requirements and');
  lines.push('> Definition of done against the code as committed. Reports are claims, not evidence.');
  lines.push('');
  lines.push(`- **Brief hash:** \`${verdict?.brief_hash || '(unknown)'}\``);

  if (verdict?._status === 'inconclusive') {
    lines.push(`- **Result:** INCONCLUSIVE — ${decision.block ? 'blocking ready-for-qa (fail_open: false)' : 'not blocking ready-for-qa (fail_open: true)'}`);
    lines.push('');
    lines.push(verdict.summary || '_the checker never produced a valid verdict._');
    lines.push('');
    return lines.join('\n');
  }

  lines.push(`- **Result:** ${decision.block ? `BLOCKED ✗ (${decision.missing.length} missing FR${decision.missing.length === 1 ? '' : 's'})` : 'PASS ✓'}`);
  if (decision.partial.length) {
    lines.push(`- **Partial:** ${decision.partial.length} FR${decision.partial.length === 1 ? '' : 's'} — worth tester attention`);
  }
  lines.push('');
  lines.push('## FRs');
  lines.push('');
  lines.push('| id | status | requirement | evidence | notes |');
  lines.push('|---|---|---|---|---|');
  for (const fr of verdict?.frs || []) {
    const evidence = (fr.evidence || []).join('; ');
    lines.push(`| ${escapeCell(fr.id)} | ${escapeCell(fr.status)} | ${escapeCell(fr.requirement)} | ${escapeCell(evidence)} | ${escapeCell(fr.notes)} |`);
  }
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(verdict?.summary || '_none provided_');
  lines.push('');
  return lines.join('\n');
}

// ─── Prompt inputs (I/O helpers) ─────────────────────────────────────────────

async function readText(p) { try { return await fsp.readFile(p, 'utf-8'); } catch { return null; } }

function buildPlanSummary(plan, phaseRows) {
  const phases = Array.isArray(plan?.phases) ? plan.phases : [];
  if (!phases.length) return '(no phases in plan)';
  const byN = new Map((phaseRows || []).map((r) => [r.n, r]));
  return phases
    .map((p) => `- Phase ${p.n}: ${p.title || '(untitled)'} [${byN.get(p.n)?.status || 'unknown'}]`)
    .join('\n');
}

async function buildReportPointers(projDir, workspaceDir, plan) {
  const phases = Array.isArray(plan?.phases) ? plan.phases : [];
  const pointers = [];
  for (const p of phases) {
    const rp = await phaseReportPath(projDir, p.n, p.title);
    pointers.push(path.relative(workspaceDir, rp));
  }
  return pointers;
}

// ─── Orchestration ───────────────────────────────────────────────────────────

/**
 * Spawn the brief conformance checker (fresh session, read-only sandbox),
 * persist the resulting verdict to .guide/brief-conformance.json + a rendered
 * human matrix at .guide/brief-conformance.md, and — when the verdict has
 * missing FRs and cfg.brief_conformance.block_on_missing is not false — insert
 * one deduped bug_inbox row per missing FR (source: 'brief-conformance',
 * severity: 'major'), mirroring ship-gate.js's addDedupedBug pattern so a
 * re-run on an unchanged brief never accumulates duplicate rows.
 *
 * `sessionId: null, role: null` are load-bearing: role 'guide'/'dev' would
 * make runClaude overwrite guide_session_id/last_dev_session_id — this call
 * must never touch that bookkeeping.
 *
 * Never throws — a spawn error or an unparseable reply (even after the one
 * re-ask) persists an `_status: 'inconclusive'` verdict instead, so the
 * caller's gate can make a deterministic (fail_open-honoring) decision either
 * way rather than being left with no artifact at all.
 *
 * @param {Object} args
 * @param {Object} args.cfg - resolved config (cfg.models['brief-conformance'] wins for this call)
 * @param {string} args.projectName
 * @param {string} args.projDir
 * @param {string} args.workspaceDir
 * @param {Object} args.plan - parsed plan.json
 * @param {{runClaude?: Function, getPhases?: Function}} [deps] - injectable seam for tests
 * @returns {Promise<{is_error: boolean, result: string, status: string, verdict: object, decision: object, jsonPath: string, mdPath: string}>}
 */
export async function runBriefConformance({ cfg, projectName, projDir, workspaceDir, plan }, deps = {}) {
  const runClaudeFn = deps.runClaude ?? runClaude;
  const getPhasesFn = deps.getPhases ?? getPhases;

  const briefFilePath = activeBriefPath(projDir, plan);
  const briefText = (await readText(briefFilePath)) || '';
  const hash = await briefHash(briefFilePath);

  const phaseRows = projectName ? getPhasesFn(projectName) : [];
  const planSummary = buildPlanSummary(plan, phaseRows);
  const reportPointers = await buildReportPointers(projDir, workspaceDir, plan);

  const checkerCfg = {
    ...cfg,
    model: cfg.models?.['brief-conformance'],
    tools: { ...cfg.tools, allowed_default: [...BRIEF_CONFORMANCE_ALLOWED_TOOLS] },
  };
  delete checkerCfg._effort_override;

  const prompt = buildBriefConformancePrompt({ briefText, planSummary, reportPointers });
  const baseCall = {
    cfg: checkerCfg,
    cwd: workspaceDir,
    systemPromptFile: null,
    systemPromptExtra: BRIEF_CONFORMANCE_SYSTEM_PROMPT,
    role: null,
    project: projectName,
    task: 'brief-conformance',
  };

  let parsed = { ok: false, errors: ['no attempt made'] };
  try {
    const result = await runClaudeFn({ ...baseCall, prompt, sessionId: null });
    parsed = parseConformanceVerdict(result?.result);
    if (!parsed.ok) {
      const result2 = await runClaudeFn({
        ...baseCall,
        prompt: buildReaskPrompt(parsed.errors),
        sessionId: result?.session_id || null,
      });
      parsed = parseConformanceVerdict(result2?.result);
    }
  } catch (err) {
    parsed = { ok: false, errors: [err.message] };
  }

  const persisted = parsed.ok
    ? { ...parsed.verdict, brief_hash: hash, _status: 'checked' }
    : {
      brief_hash: hash,
      frs: [],
      summary: `Checker did not produce a valid verdict after one re-ask: ${(parsed.errors || []).join('; ')}`,
      _status: 'inconclusive',
    };

  const bcCfg = cfg.brief_conformance || {};
  const failOpen = bcCfg.fail_open !== false;
  const decision = decideConformance(persisted, { failOpen });

  if (decision.missing.length && bcCfg.block_on_missing !== false) {
    for (const fr of decision.missing) {
      try {
        addDedupedBug({
          project: projectName,
          raw_text: `FR ${fr.id} not implemented: ${fr.requirement}${fr.notes ? ` -- ${fr.notes}` : ''}`,
          severity: 'major',
          source: 'brief-conformance',
        });
      } catch { /* DB write is best-effort; the persisted verdict already stands */ }
    }
  }

  const md = renderConformanceMd({ verdict: persisted, decision });
  const jsonPath = briefConformancePath(projDir);
  const mdPath = briefConformanceMdPath(projDir);
  try {
    await fsp.mkdir(guideRoot(projDir), { recursive: true });
    await fsp.writeFile(jsonPath, JSON.stringify(persisted, null, 2), 'utf-8');
    await fsp.writeFile(mdPath, md, 'utf-8');
  } catch (err) {
    console.warn(chalk.yellow(`[brief-conformance] failed to persist verdict: ${err.message}`));
  }

  return {
    is_error: false,
    result: `brief-conformance: ${persisted._status}${decision.block ? ` — BLOCKED (${decision.missing.length} missing FR)` : ''}`,
    status: persisted._status,
    verdict: persisted,
    decision,
    jsonPath,
    mdPath,
  };
}
