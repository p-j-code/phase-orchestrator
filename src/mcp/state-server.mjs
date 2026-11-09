// MCP state server (Phase 11, promoted Phase 38) — a stdio MCP server exposing
// read/write tools over one project's `.guide/` state, so a dev agent can
// pull decisions/lessons/history/repo-map on demand via a tool call instead
// of having it all pre-injected into the system prompt on every turn. Phase
// 48 adds a non-blocking ask_operator write tool, gated on its own
// `operator_questions.enabled` config key (see `buildServer`). Hybrid-context
// tools additionally require an exact per-invocation manifest/workspace
// binding; the remaining tools are unconditional. Only spawned when
// `cfg.mcp.enabled` is true (see
// `src/claude-runner.js`) — default `true` as of Phase 38, per-project escape
// hatch via `overrides.mcp.enabled: false`. Never invoked directly by us —
// the `claude` CLI spawns it per `--mcp-config`.
//
// Every tool argument that becomes a filesystem path (the `--project` CLI
// arg, and any `file`/`files` tool argument) is validated with
// `assertInsideDir` (phase 7, `src/lib/guide-paths.js`) before use — a
// path-escape attempt throws a descriptive rejection rather than silently
// resolving outside the project directory.
//
// Reuses existing parsing/matching logic rather than reimplementing it:
// `parseDecisionsJsonl` (decisions-schema.js), `readLessons` /
// `selectRelevantLessons` / `recordLesson` (lessons.js) — the same functions
// `phase-runner.js` uses to build the injected context blocks.

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  guideRoot, assertInsideDir, findPhaseDir, bugsFilePath, fixPlanJsonPath, detectHighestBugRound,
  phaseLedgerPath, repoMapPath,
} from '../lib/guide-paths.js';
import { parseDecisionsJsonl, DECISION_LIMITS } from '../lib/decisions-schema.js';
import { readLessons, selectRelevantLessons, recordLesson } from '../lib/lessons.js';
import { parsePhaseLedgerJsonl } from '../lib/ledger.js';
import { parseFrontMatter, renderMapBody, readRepoMapCache } from '../lib/repo-map.js';
import {
  filterContextManifest, loadContextManifest, renderCompiledContextBlock,
} from '../lib/context-compiler.js';
import { addOperatorQuestion } from '../state.js';
import { MCP_SERVER_NAME, MCP_TOOL_NAMES, CONTEXT_MCP_TOOL_NAMES } from './tool-names.js';

export { MCP_SERVER_NAME, MCP_TOOL_NAMES, CONTEXT_MCP_TOOL_NAMES };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

const MAX_REPORT_CHARS = 20000;
const MAX_BUGS_EXCERPT_CHARS = 4000;
const MAX_BUG_ROUNDS_SCANNED = 20;
const GET_LESSONS_TOP_K = 5;

async function readTextSafe(p) {
  try { return await fs.readFile(p, 'utf-8'); } catch { return null; }
}
async function readJsonSafe(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf-8')); } catch { return null; }
}

/**
 * Resolves `--project <name>` to an absolute, validated project directory.
 * Rejects a name that escapes PROJECTS_DIR (e.g. "../../etc").
 */
export async function resolveProjectDir(projectName) {
  if (!projectName || typeof projectName !== 'string') {
    throw new Error('[state-server] --project <name> is required');
  }
  const candidate = path.join(PROJECTS_DIR, projectName);
  return assertInsideDir(PROJECTS_DIR, candidate);
}

/**
 * Every tool argument documented as a project-relative file path goes through
 * here. Absolute paths and `../` escapes both throw — never silently resolve
 * outside `projectDir`.
 */
async function assertProjectRelativePath(projectDir, candidate) {
  const abs = path.isAbsolute(candidate) ? candidate : path.join(projectDir, candidate);
  return assertInsideDir(projectDir, abs);
}

// ─── get_decisions({ topic? }) ───────────────────────────────────────────────
// Same source + parser as loadDecisionsBlock (phase-runner.js): parses
// .guide/decisions.jsonl via parseDecisionsJsonl, which already skips
// malformed lines and schema-invalid entries. `rationale` is deliberately
// withheld from the returned shape — same invariant renderDecisionLine
// enforces for prompt injection (decisions-schema.js): only title/decision/
// phase/type are agent-facing.
export async function getDecisions(projectDir, { topic } = {}) {
  const content = await readTextSafe(path.join(guideRoot(projectDir), 'decisions.jsonl'));
  if (!content || !content.trim()) return { decisions: [] };
  let entries = parseDecisionsJsonl(content, 0); // maxEntries:0 → no cap, every valid entry
  if (topic && topic.trim()) {
    const needle = topic.trim().toLowerCase();
    entries = entries.filter((e) => e.title.toLowerCase().includes(needle) || e.decision.toLowerCase().includes(needle));
  }
  return { decisions: entries.map((e) => ({ phase: e.phase, title: e.title, decision: e.decision, type: e.type })) };
}

// ─── get_phase_report({ n }) ─────────────────────────────────────────────────
// Reuses findPhaseDir (guide-paths.js) — the same NN-prefix lookup phaseDir()
// uses — instead of hand-rolling a path join from a title.
export async function getPhaseReport(projectDir, { n } = {}) {
  const phaseN = Number(n);
  if (!Number.isInteger(phaseN) || phaseN < 1) {
    throw new Error(`[get_phase_report] "n" must be a positive integer phase number, got: ${JSON.stringify(n)}`);
  }
  const dir = await findPhaseDir(projectDir, phaseN);
  if (!dir) return { found: false, phase: phaseN, report: null };
  const content = await readTextSafe(path.join(dir, 'report.md'));
  if (content == null) return { found: false, phase: phaseN, report: null };
  const truncated = content.length > MAX_REPORT_CHARS;
  return {
    found: true,
    phase: phaseN,
    dir: path.basename(dir),
    report: truncated ? content.slice(0, MAX_REPORT_CHARS) : content,
    truncated,
  };
}

// ─── get_bug_history({ file? }) ──────────────────────────────────────────────
// Walks bug-rounds newest-first (detectHighestBugRound, guide-paths.js),
// reading each round's bugs.md + plan.json. `file`, when given, is validated
// as a project-relative path (defense-in-depth — it is only ever used as a
// substring filter, never opened directly) and narrows rounds to those whose
// bugs.md text or plan.json fix entries mention it.
export async function getBugHistory(projectDir, { file } = {}) {
  if (file != null) await assertProjectRelativePath(projectDir, file);
  const highest = await detectHighestBugRound(projectDir);
  if (!highest) return { rounds: [] };

  const needle = file ? file.trim().toLowerCase() : null;
  const firstRound = Math.max(1, highest - MAX_BUG_ROUNDS_SCANNED + 1);
  const rounds = [];

  for (let round = highest; round >= firstRound; round -= 1) {
    const bugsMd = await readTextSafe(bugsFilePath(projectDir, round));
    const fixPlan = await readJsonSafe(fixPlanJsonPath(projectDir, round));
    const fixes = Array.isArray(fixPlan?.fixes) ? fixPlan.fixes : [];
    const matchingFixes = fixes
      .filter((f) => {
        if (!needle) return true;
        const files = Array.isArray(f.files) ? f.files : [];
        return files.some((f2) => String(f2).toLowerCase().includes(needle));
      })
      .map((f) => ({ n: f.n, title: f.title || null, files: f.files || [] }));

    const bugsMatch = needle ? (bugsMd || '').toLowerCase().includes(needle) : !!bugsMd;
    if (!needle || bugsMatch || matchingFixes.length) {
      rounds.push({
        round,
        bugs_excerpt: bugsMd ? bugsMd.slice(0, MAX_BUGS_EXCERPT_CHARS) : null,
        matching_fixes: matchingFixes,
      });
    }
  }
  return { rounds };
}

// ─── get_lessons({ query? }) ─────────────────────────────────────────────────
// Reuses selectRelevantLessons (lessons.js) unchanged — the exact matcher
// loadLessonsBlock uses for prompt injection (file/keyword overlap, no
// embeddings). `query` becomes a synthetic phaseMeta.title so keyword-overlap
// scoring applies unmodified. No query → most-recent K instead of a scored
// (and therefore all-zero) ranking.
export async function getLessons(projectDir, { query } = {}) {
  const entries = await readLessons(projectDir);
  let relevant;
  if (query && query.trim()) {
    relevant = selectRelevantLessons(entries, { title: query, goal: '', files_expected: [] }, GET_LESSONS_TOP_K);
  } else {
    relevant = [...entries]
      .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
      .slice(0, GET_LESSONS_TOP_K);
  }
  return {
    lessons: relevant.map((e) => ({
      kind: e.kind, phase: e.phase ?? null, fix: e.fix ?? null, lesson: e.lesson, files: e.files || [], ts: e.ts,
    })),
  };
}

// ─── log_lesson({ lesson, files? }) ──────────────────────────────────────────
// Calls recordLesson (lessons.js) directly with kind:'agent' — a dev agent's
// own self-reported lesson, picked up by loadLessonsBlock the same as the
// other five kinds. Every entry in `files` is validated before recording.
export async function logLesson(projectDir, { lesson, files } = {}) {
  if (!lesson || typeof lesson !== 'string' || !lesson.trim()) {
    throw new Error('[log_lesson] "lesson" is required and must be a non-empty string');
  }
  const fileList = Array.isArray(files) ? files.filter((f) => typeof f === 'string' && f.trim()) : [];
  for (const f of fileList) {
    await assertProjectRelativePath(projectDir, f);
  }
  await recordLesson(projectDir, { kind: 'agent', phase: null, fix: null, source: 'mcp:log_lesson', lesson, files: fileList });
  return { ok: true };
}

// ─── get_phase_ledger({ from_n?, to_n? }) ────────────────────────────────────
// Same source + parser as loadPhaseLedgerBlock (phase-runner.js, Phase 37 /
// CE-1): parses .guide/phase-ledger.jsonl via parsePhaseLedgerJsonl
// (ledger.js), which already skips malformed lines and schema-invalid
// entries. `from_n`/`to_n` narrow to an inclusive range on entry.n. A missing
// or empty ledger file (every pre-Phase-37 project, or one where the append
// itself best-effort-skipped) fails open to { entries: [] } — never throws.
export async function getPhaseLedger(projectDir, { from_n, to_n } = {}) {
  const content = await readTextSafe(phaseLedgerPath(projectDir));
  if (!content || !content.trim()) return { entries: [] };
  let entries = parsePhaseLedgerJsonl(content, 0); // maxEntries:0 → no cap, every valid entry
  if (from_n != null) entries = entries.filter((e) => e.n >= Number(from_n));
  if (to_n != null) entries = entries.filter((e) => e.n <= Number(to_n));
  return { entries: entries.map((e) => ({ n: e.n, title: e.title, commit_sha: e.commit_sha, bullets: e.bullets })) };
}

// ─── get_repo_map({ focus_paths? }) ──────────────────────────────────────────
// Serves the on-disk deterministic repo map (.guide/repo-map.md) via the same
// front-matter parser repo-map.js's own read path uses (parseFrontMatter).
// Never regenerates it — runDev() (phase-runner.js) refreshes the map before
// every dev/fix spawn regardless of cfg.mcp.enabled, so by the time this tool
// is callable the on-disk map is already current for HEAD. A missing file or
// an artifact with no parseable front matter both fail open to { found: false }.
//
// Phase 39 (CE-4): `focus_paths`, when given, re-renders from
// .guide/repo-map-cache.json (the PARSED structure behind the already-
// degraded .md) via the SAME renderMapBody focus renderer loadRepoMapBlock
// (phase-runner.js) uses — matching files render in full detail, everything
// else degrades to symbols-only. A missing/stale cache (sha mismatch) or no
// focus_paths both fall back to serving the plain .md body unchanged (P2
// behavior).
export async function getRepoMap(projectDir, { focus_paths } = {}) {
  const raw = await readTextSafe(repoMapPath(projectDir));
  if (raw == null) return { found: false };
  const parsed = parseFrontMatter(raw);
  if (!parsed) return { found: false };

  const focusPaths = Array.isArray(focus_paths) ? focus_paths.filter((f) => typeof f === 'string' && f.trim()) : [];
  if (focusPaths.length) {
    for (const f of focusPaths) await assertProjectRelativePath(projectDir, f);
    const cache = await readRepoMapCache(projectDir);
    if (cache && cache.sha === parsed.attrs.generated_at_sha) {
      const level = Number.isFinite(parsed.attrs.degradation_level) ? parsed.attrs.degradation_level : 0;
      const body = renderMapBody({ tree: cache.tree, files: cache.files }, level, { focusPaths });
      return { found: true, generated_at_sha: parsed.attrs.generated_at_sha, body };
    }
  }
  return { found: true, generated_at_sha: parsed.attrs.generated_at_sha, body: parsed.body };
}

// ─── Hybrid Context Compiler tools (schema 19) ─────────────────────────────

function boundedMaxTokens(value, fallback = 1500) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(100, Math.min(4000, Math.floor(n))) : fallback;
}

const CONTEXT_MANIFEST_ID_RE = /^[a-f0-9]{64}$/;

async function contextManifestForTool(projectDir, manifestId, cfg = {}) {
  if (!CONTEXT_MANIFEST_ID_RE.test(String(manifestId || ''))) {
    throw new Error('[context-tools] "manifest_id" is required and must be the exact 64-character lowercase sha256 from the current compiled_context block');
  }
  const boundManifestId = cfg?._context_compiler?.manifest_id;
  if (boundManifestId && manifestId !== boundManifestId) {
    throw new Error('[context-tools] requested manifest_id does not match the manifest bound to this Claude invocation');
  }
  const manifest = await loadContextManifest(path.basename(projectDir), manifestId);
  if (manifest && manifest.manifest_id !== manifestId) {
    throw new Error('[context-tools] stored manifest does not match the requested manifest_id');
  }
  return manifest;
}

export async function getCompiledContext(projectDir, { manifest_id, criterion_id, max_tokens } = {}, cfg = {}) {
  const manifest = await contextManifestForTool(projectDir, manifest_id, cfg);
  if (!manifest) return { found: false };
  const filtered = filterContextManifest(manifest, { criterionId: criterion_id || null });
  return {
    found: true,
    manifest_id: manifest.manifest_id,
    base_sha: manifest.base_sha,
    confidence: manifest.confidence,
    context: renderCompiledContextBlock(filtered, { maxTokens: boundedMaxTokens(max_tokens, manifest.token_budget || 1500) }),
  };
}

function symbolMatches(symbol, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return true;
  return String(symbol.name || '').toLowerCase().includes(needle)
    || String(symbol.file || '').toLowerCase().includes(needle)
    || String(symbol.signature || '').toLowerCase().includes(needle);
}

function cropTextToTokens(text, maxTokens) {
  const maxChars = boundedMaxTokens(maxTokens) * 4;
  const source = String(text || '');
  return source.length > maxChars ? `${source.slice(0, maxChars)}\n[truncated]` : source;
}

export async function queryCodeSymbols(projectDir, { operation = 'search', query, manifest_id, max_tokens, lines = 80 } = {}, cfg = {}) {
  const allowedOperations = new Set(['search', 'definition', 'body', 'references', 'implementations', 'callers']);
  if (!allowedOperations.has(operation)) throw new Error(`[query_code_symbols] unsupported operation: ${operation}`);
  if (!query || typeof query !== 'string') throw new Error('[query_code_symbols] "query" is required');
  const manifest = await contextManifestForTool(projectDir, manifest_id, cfg);
  if (!manifest) return { found: false, results: [] };
  const symbols = (manifest.ranked_symbols || []).filter((symbol) => symbolMatches(symbol, query)).slice(0, 20);

  if (operation === 'references' || operation === 'callers') {
    const needle = query.toLowerCase();
    const relations = (manifest.relations || []).filter((relation) => {
      if (operation === 'callers') return String(relation.to).toLowerCase().includes(needle);
      return String(relation.from).toLowerCase().includes(needle) || String(relation.to).toLowerCase().includes(needle);
    });
    return { found: relations.length > 0, provider: manifest.provider, operation, relations: relations.slice(0, 40) };
  }

  if (operation === 'body') {
    const symbol = symbols[0];
    if (!symbol) return { found: false, results: [] };
    const workspaceDir = cfg?._context_compiler?.workspace_dir
      ? await assertInsideDir(projectDir, cfg._context_compiler.workspace_dir)
      : path.join(projectDir, cfg.paths?.workspace_subdir || 'workspace');
    const absolute = await assertInsideDir(workspaceDir, path.join(workspaceDir, symbol.file));
    const content = await readTextSafe(absolute);
    if (content == null) return { found: false, results: [] };
    const sourceLines = content.split('\n');
    const lineCount = Math.max(10, Math.min(200, Number(lines) || 80));
    const start = Math.max(0, (symbol.line || 1) - 6);
    const body = sourceLines.slice(start, start + lineCount)
      .map((line, index) => `${start + index + 1}: ${line}`).join('\n');
    return {
      found: true,
      provider: manifest.provider,
      symbol: { name: symbol.name, file: symbol.file, line: symbol.line, signature: symbol.signature },
      body: cropTextToTokens(body, max_tokens),
      approximate: true,
    };
  }

  return {
    found: symbols.length > 0,
    provider: manifest.provider,
    operation,
    results: symbols,
    approximate: operation === 'implementations',
  };
}

export async function getTestImpact(projectDir, { manifest_id, criterion_id } = {}, cfg = {}) {
  const manifest = await contextManifestForTool(projectDir, manifest_id, cfg);
  if (!manifest) return { found: false };
  const filtered = filterContextManifest(manifest, { criterionId: criterion_id || null });
  return {
    found: true,
    manifest_id: manifest.manifest_id,
    targeted_files: filtered.test_plan?.targeted_files || [],
    requires_full_suite: !!filtered.test_plan?.requires_full_suite,
    reason: filtered.test_plan?.reason || null,
    criteria: (filtered.criteria_map || []).map((criterion) => ({
      criterion_id: criterion.criterion_id,
      production_files: criterion.production_files || [],
      tests: criterion.tests || [],
    })),
  };
}

// ─── ask_operator({ question, assumption, options?, phase?, blocking? }) ────
// Phase 48: a NON-BLOCKING channel for a mid-phase dev/fix agent to record a
// question + the assumption it is proceeding on. Inserts an
// operator_questions row (status 'open', src/state.js) and appends ONE
// provisional decision to .guide/decisions.jsonl, riding the EXISTING
// decisions-injection into future prompts (loadDecisionsBlock /
// get_decisions) with zero prompt-assembly changes. `blocking` is accepted
// and stored but NEVER gates control flow in v1 — the returned text is
// identical regardless of its value. Never blocks, sleeps, or polls.
export async function askOperator(projectDir, { question, assumption, options, phase, blocking } = {}) {
  if (!question || typeof question !== 'string' || !question.trim()) {
    throw new Error('[ask_operator] "question" is required and must be a non-empty string');
  }
  if (!assumption || typeof assumption !== 'string' || !assumption.trim()) {
    throw new Error('[ask_operator] "assumption" is required and must be a non-empty string');
  }
  const optionList = Array.isArray(options)
    ? options.filter((o) => typeof o === 'string' && o.trim()).slice(0, 5)
    : null;
  const phaseN = phase != null && Number.isInteger(Number(phase)) ? Number(phase) : null;
  const project = path.basename(projectDir);

  const id = addOperatorQuestion({
    project, phase: phaseN, question, options: optionList, assumption, blocking: !!blocking,
  });

  const decisionsPath = await assertInsideDir(guideRoot(projectDir), path.join(guideRoot(projectDir), 'decisions.jsonl'));
  const entry = {
    phase: phaseN != null ? String(phaseN) : 'ask_operator',
    title: `Operator question #${id}`.slice(0, DECISION_LIMITS.title),
    decision: `PROVISIONAL (operator question #${id}): ${assumption}`.slice(0, DECISION_LIMITS.decision),
    rationale: question.slice(0, DECISION_LIMITS.rationale),
    type: 'deferral',
  };
  await fs.appendFile(decisionsPath, `${JSON.stringify(entry)}\n`, 'utf-8');

  return {
    id,
    text: `Recorded question #${id}. The operator has been asked asynchronously. Proceed now using your stated assumption: ${assumption}`,
  };
}

// ─── MCP wiring ───────────────────────────────────────────────────────────

// Description/inputSchema for each tool, keyed by name. TOOL_DEFS below is
// built by mapping MCP_TOOL_NAMES (the shared, zero-dependency source of
// truth in tool-names.js) over this table, so the tool list this server
// advertises can never drift from what claude-runner.js allowlists.
const TOOL_DETAILS_BY_NAME = {
  get_decisions: {
    description: 'Read the rolling decisions log (.guide/decisions.jsonl) for this project, optionally filtered by a keyword topic.',
    inputSchema: {
      type: 'object',
      properties: { topic: { type: 'string', description: 'Optional keyword filter matched against decision title/text.' } },
    },
  },
  get_phase_report: {
    description: "Read a prior phase's completion report (.guide/phases/NN-.../report.md).",
    inputSchema: {
      type: 'object',
      properties: { n: { type: 'integer', minimum: 1, description: 'Phase number.' } },
      required: ['n'],
    },
  },
  get_bug_history: {
    description: 'Read bug-round history (bugs.md / plan.json fixes), newest round first, optionally filtered to entries touching a given file.',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string', description: 'Optional project-relative file path to filter by.' } },
    },
  },
  get_lessons: {
    description: 'Read lessons captured from prior failures (validator/verify/heal/stall/agent), ranked by relevance to an optional query.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Optional free-text query (matched by keyword overlap against the lesson text).' } },
    },
  },
  log_lesson: {
    description: 'Record a lesson learned during this session so future phases/fixes see it.',
    inputSchema: {
      type: 'object',
      properties: {
        lesson: { type: 'string', description: 'The lesson text (truncated to the configured max length).' },
        files: { type: 'array', items: { type: 'string' }, description: 'Project-relative file paths this lesson relates to.' },
      },
      required: ['lesson'],
    },
  },
  get_phase_ledger: {
    description: 'Read the deterministic cross-phase memory ledger (.guide/phase-ledger.jsonl) — durable decisions/gotchas from prior completed phases, optionally scoped to an inclusive phase-number range.',
    inputSchema: {
      type: 'object',
      properties: {
        from_n: { type: 'integer', minimum: 1, description: 'Optional inclusive lower bound on phase number.' },
        to_n: { type: 'integer', minimum: 1, description: 'Optional inclusive upper bound on phase number.' },
      },
    },
  },
  get_repo_map: {
    description: 'Read the deterministic, statically-generated repo map (.guide/repo-map.md) — a file tree plus compressed signatures for the current HEAD. Pass focus_paths to render specific files/directories in full detail while everything else degrades to symbols-only.',
    inputSchema: {
      type: 'object',
      properties: {
        focus_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional project-relative file or directory paths to render in full detail; every other file renders as symbols-only.',
        },
      },
    },
  },
  get_compiled_context: {
    description: 'Read the bounded Hybrid Context Compiler manifest bound to this task. The exact manifest_id from the prompt is required.',
    inputSchema: {
      type: 'object',
      properties: {
        manifest_id: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Exact manifest id from the current compiled_context block.' },
        criterion_id: { type: 'string', description: 'Optional acceptance criterion id to return only its mapped files/symbols/tests.' },
        max_tokens: { type: 'integer', minimum: 100, maximum: 4000 },
      },
      required: ['manifest_id'],
    },
  },
  query_code_symbols: {
    description: 'Search task-ranked code symbols, retrieve an approximate source body, or inspect import/reference relationships without loading the whole repo map.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { enum: ['search', 'definition', 'body', 'references', 'implementations', 'callers'] },
        query: { type: 'string' },
        manifest_id: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        max_tokens: { type: 'integer', minimum: 100, maximum: 4000 },
        lines: { type: 'integer', minimum: 10, maximum: 200 },
      },
      required: ['query', 'manifest_id'],
    },
  },
  get_test_impact: {
    description: 'Return tests associated with the compiled task or one criterion and whether the compiler recommends the wider suite.',
    inputSchema: {
      type: 'object',
      properties: {
        manifest_id: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        criterion_id: { type: 'string' },
      },
      required: ['manifest_id'],
    },
  },
  ask_operator: {
    description: 'Record a question for the operator plus the assumption you are proceeding on RIGHT NOW. Non-blocking — this never waits for an answer; use it and keep working on your stated assumption.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question for the operator.' },
        assumption: { type: 'string', description: 'The assumption you will proceed on while the question is pending.' },
        options: { type: 'array', items: { type: 'string' }, maxItems: 5, description: 'Optional list of up to 5 candidate answers.' },
        phase: { type: 'integer', minimum: 1, description: 'Optional phase number this question relates to.' },
        blocking: { type: 'boolean', description: 'Recorded for future use; v1 ALWAYS treats this call as non-blocking regardless of this value.' },
      },
      required: ['question', 'assumption'],
    },
  },
};

const ALL_TOOL_NAMES = [...MCP_TOOL_NAMES, ...CONTEXT_MCP_TOOL_NAMES];
const TOOL_DEFS = ALL_TOOL_NAMES.map((name) => ({ name, ...TOOL_DETAILS_BY_NAME[name] }));

const TOOL_HANDLERS = {
  get_decisions: getDecisions,
  get_phase_report: getPhaseReport,
  get_bug_history: getBugHistory,
  get_lessons: getLessons,
  log_lesson: logLesson,
  get_phase_ledger: getPhaseLedger,
  get_repo_map: getRepoMap,
  get_compiled_context: getCompiledContext,
  query_code_symbols: queryCodeSymbols,
  get_test_impact: getTestImpact,
  ask_operator: askOperator,
};

// Exported for unit tests: the same operator_questions and exact current-
// context gates buildServer's ListTools/CallTool handlers apply, extracted so
// they are testable without spinning up a transport. Core state tools remain
// unaffected by the context gate.
export function activeToolNamesForConfig(cfg = {}) {
  const operatorQuestionsEnabled = cfg?.operator_questions?.enabled !== false;
  const coreNames = operatorQuestionsEnabled ? MCP_TOOL_NAMES : MCP_TOOL_NAMES.filter((n) => n !== 'ask_operator');
  const contextMode = cfg?._context_compiler?.mode || cfg?.context_compiler?.mode;
  const currentManifestId = cfg?._context_compiler?.manifest_id;
  const currentWorkspaceDir = cfg?._context_compiler?.workspace_dir;
  const contextEnabled = cfg?.context_compiler?.enabled === true
    && (contextMode === 'assist' || contextMode === 'enforce')
    && CONTEXT_MANIFEST_ID_RE.test(String(currentManifestId || ''))
    && typeof currentWorkspaceDir === 'string'
    && path.isAbsolute(currentWorkspaceDir)
    && cfg?._context_compiler?.exposed === true;
  return contextEnabled ? [...coreNames, ...CONTEXT_MCP_TOOL_NAMES] : coreNames;
}

/**
 * Builds the MCP Server instance for `projectDir`, wired to the tools above.
 * Uses the low-level `Server` (not `McpServer`) so tool schemas stay plain
 * JSON Schema — no zod dependency needed in our own code beyond the one
 * `@modelcontextprotocol/sdk` package this phase is allowed to add.
 *
 * `cfg` (Phase 48): the project's resolved config. When
 * `cfg.operator_questions.enabled` is explicitly `false`, ask_operator is
 * dropped from both the advertised tool list and the callable handler set.
 * Context tools separately require the immutable current manifest/workspace
 * binding. Omitting `cfg` matches the core-tools-only safe default.
 */
export function buildServer(projectDir, cfg = {}) {
  const activeNames = activeToolNamesForConfig(cfg);
  const activeToolDefs = TOOL_DEFS.filter((t) => activeNames.includes(t.name));
  const activeHandlers = Object.fromEntries(
    Object.entries(TOOL_HANDLERS).filter(([name]) => activeNames.includes(name)),
  );

  const server = new Server({ name: MCP_SERVER_NAME, version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: activeToolDefs }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = activeHandlers[name];
    if (!handler) {
      return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
    try {
      const result = await handler(projectDir, args || {}, cfg);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err.message }] };
    }
  });

  return server;
}

export async function main() {
  const projectArgIdx = process.argv.indexOf('--project');
  const projectName = projectArgIdx !== -1 ? process.argv[projectArgIdx + 1] : null;
  const projectDir = await resolveProjectDir(projectName);
  // Phase 48: resolve the project's config once at server startup so
  // buildServer can gate ask_operator on operator_questions.enabled. Fails
  // open to {} (== operator_questions.enabled:true, the config default) on
  // any resolve error (e.g. a project.json-less fixture/edge case) — a
  // config-resolution failure must never take down the other seven tools.
  let cfg = {};
  try {
    const { resolve } = await import('../config-resolver.js');
    cfg = await resolve({ project: projectName });
  } catch (err) {
    console.error(`[state-server] config resolve failed, falling back to defaults: ${err.message}`);
  }
  const contextManifestArgIdx = process.argv.indexOf('--context-manifest-id');
  const contextManifestId = contextManifestArgIdx !== -1 ? process.argv[contextManifestArgIdx + 1] : null;
  if (contextManifestId != null) {
    if (!CONTEXT_MANIFEST_ID_RE.test(contextManifestId)) {
      throw new Error('[state-server] --context-manifest-id must be a 64-character lowercase sha256');
    }
    // The per-invocation MCP config carries the exact successfully compiled
    // manifest. Resolve it once at startup both to prove it still exists and
    // to carry its effective rollout mode (which can differ from the static
    // project config) into the server-side advertisement gate.
    const boundManifest = await loadContextManifest(projectName, contextManifestId);
    if (!boundManifest || boundManifest.manifest_id !== contextManifestId) {
      throw new Error(`[state-server] bound context manifest not found: ${contextManifestId}`);
    }
    const workspaceArgIdx = process.argv.indexOf('--workspace-dir');
    const workspaceArg = workspaceArgIdx !== -1 ? process.argv[workspaceArgIdx + 1] : null;
    if (!workspaceArg) {
      throw new Error('[state-server] --workspace-dir is required with --context-manifest-id');
    }
    const boundWorkspaceDir = await assertInsideDir(projectDir, workspaceArg);
    cfg = {
      ...cfg,
      // The immutable CLI binding was emitted only after the runner compiled
      // this exact manifest in assist/enforce mode. Keep that invocation
      // decision authoritative even if project config changes (or fails to
      // resolve) between config publication and MCP server startup.
      context_compiler: { ...cfg.context_compiler, enabled: true },
      _context_compiler: {
        manifest_id: contextManifestId,
        mode: boundManifest.mode,
        provider: boundManifest.provider,
        workspace_dir: boundWorkspaceDir,
        // The runner emits this immutable CLI binding only after the exact
        // manifest was exposed; keep that decision explicit server-side too.
        exposed: true,
      },
    };
  }
  const server = buildServer(projectDir, cfg);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only run the stdio server when invoked directly (`node state-server.mjs
// --project X`) — never when imported for MCP_SERVER_NAME/MCP_TOOL_NAMES
// (claude-runner.js) or for the exported tool functions (unit tests).
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((err) => {
    console.error(`[state-server] fatal: ${err.message}`);
    process.exit(1);
  });
}
