// Deterministic Repo Map (Phase 15, brief P1) — src/lib/repo-map.js
//
// Standalone, unit-testable module with NO phase-runner wiring (that lands in
// phase 16 — see docs/ARCHITECTURE.md "Deterministic repo map (Phase 15)").
// generateRepoMap() writes .guide/repo-map.md: static-analysis structural
// facts (file tree, compressed signatures) that cost zero LLM tokens to
// produce and are correct for HEAD by construction — regenerated only when
// HEAD moves (skip-if-fresh), so per-spawn invocation is free in the common
// case where the workspace hasn't changed since the last call.
//
// Generator: repomix's CLI (bin/repomix.cjs), invoked via array-args
// execFile — never a shell string, mirroring runGit's convention
// (src/claude-runner.js:32-39). repomix's programmatic `pack()` API exposes
// ~15 injectable internal dependency objects (core/packager.d.ts) that are
// clearly implementation plumbing, not a stable public surface — the CLI
// (documented flags, pinned version) is the stable contract, so this module
// takes the brief's explicit fallback path.
//
// Failure = absence: every public entrypoint here is wrapped so a broken
// repomix binary, a git error, or a malformed on-disk map degrades to
// "return null" with a console.warn — callers always treat null as
// "inject nothing," never a thrown error that could fail a spawn.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import chalk from 'chalk';
import { getHeadSha, changedFilesSince, listTrackedFiles } from './git.js';
import { repoMapPath, repoMapCachePath } from './guide-paths.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Resolved once at module load from repomix's own package.json `bin` field —
// survives a repomix version bump moving the binary, rather than hardcoding
// node_modules/repomix/bin/repomix.cjs. repomix's package.json doesn't expose
// a "./package.json" subpath in its `exports` map, so we resolve the main
// entry point and walk up to find the package root instead of
// require.resolve('repomix/package.json').
const REPOMIX_BIN = (() => {
  let dir = path.dirname(require.resolve('repomix'));
  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('could not locate repomix package root from its resolved entry point');
    dir = parent;
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
  const binField = pkg.bin;
  const binRelPath = typeof binField === 'string' ? binField : Object.values(binField)[0];
  return path.join(dir, binRelPath);
})();

const DEFAULT_MAX_TOKENS = 4000;
const DEFAULT_EXCLUDE = Object.freeze(['node_modules', 'dist', 'build', 'coverage']);
const REPOMIX_TIMEOUT_MS = 60_000;
const MAX_DEGRADATION_LEVEL = 3;
// Phase 39 (CE-4): above this many changed files, an incremental `--include`
// repomix run is no cheaper than a full repack (repomix's own startup/parse
// overhead dominates) — fall back to the full-repack path instead.
const DEFAULT_FULL_REPACK_THRESHOLD_FILES = 40;

// Files under these roots are "core" — kept in full at degradation level 1;
// everything else (docs, scripts, fixtures, etc.) is dropped first.
const CORE_ROOT_PREFIXES = Object.freeze(['src/', 'lib/', 'app/']);

// ─── Token estimation ────────────────────────────────────────────────────────

export function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

// ─── Front-matter (five known fields — not a generic YAML parser) ──────────

/**
 * @param {{generated_at_sha:string, generated_at:string, tool:string, approx_tokens:number, degradation_level:number}} attrs
 * @returns {string}
 */
export function renderFrontMatter(attrs) {
  return [
    '---',
    `generated_at_sha: ${attrs.generated_at_sha}`,
    `generated_at: ${attrs.generated_at}`,
    `tool: ${attrs.tool}`,
    `approx_tokens: ${attrs.approx_tokens}`,
    `degradation_level: ${attrs.degradation_level}`,
    '---',
  ].join('\n');
}

/**
 * Parses a file written as `renderFrontMatter(attrs) + '\n\n' + body` (the
 * blank line is load-bearing — it's how the body's own leading whitespace
 * stays byte-identical whether read fresh from generation or from disk).
 *
 * @param {string} raw
 * @returns {{attrs: object, body: string}|null} null if raw has no front matter block
 */
export function parseFrontMatter(raw) {
  if (typeof raw !== 'string') return null;
  const m = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(raw);
  if (!m) return null;
  const [, fmBlock, body] = m;
  const rawAttrs = {};
  for (const line of fmBlock.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    rawAttrs[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return {
    attrs: {
      generated_at_sha: rawAttrs.generated_at_sha ?? null,
      generated_at: rawAttrs.generated_at ?? null,
      tool: rawAttrs.tool ?? null,
      approx_tokens: rawAttrs.approx_tokens != null ? Number(rawAttrs.approx_tokens) : null,
      degradation_level: rawAttrs.degradation_level != null ? Number(rawAttrs.degradation_level) : null,
    },
    body,
  };
}

// ─── repomix invocation ──────────────────────────────────────────────────────

/**
 * Invoke repomix's CLI against workspaceDir and return its markdown output.
 * Array-args execFile only — no shell string. Never called with an execFile
 * `shell` option enabled, and never with a template-interpolated command.
 *
 * @param {{workspaceDir: string, exclude: string[], timeoutMs: number, extraArgs?: string[]}} args
 *   `extraArgs` (Phase 39 / CE-4) — additional array-args appended verbatim
 *   after the base flags, e.g. `['--include', 'src/a.js,src/b.js']` for the
 *   incremental path's scoped re-scan. Never a shell string.
 * @returns {Promise<string>}
 */
export async function runRepomix({ workspaceDir, exclude, timeoutMs, extraArgs }) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aorch-repo-map-'));
  const tmpOut = path.join(tmpDir, 'repomix-output.md');
  try {
    const args = [
      REPOMIX_BIN,
      '.',
      '--output', tmpOut,
      '--style', 'markdown',
      '--compress',
      '--no-file-summary',
      '--quiet',
    ];
    const ignorePatterns = Array.from(new Set(exclude || [])).join(',');
    if (ignorePatterns) args.push('--ignore', ignorePatterns);
    if (Array.isArray(extraArgs) && extraArgs.length) args.push(...extraArgs);

    await execFileAsync(process.execPath, args, {
      cwd: workspaceDir,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    return await fsp.readFile(tmpOut, 'utf-8');
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ─── repomix markdown parsing ────────────────────────────────────────────────

/**
 * Parse repomix's `--style markdown --no-file-summary` output into a
 * directory tree string plus a list of { path, lang, content } file blocks.
 *
 * @param {string} raw
 * @returns {{tree: string, files: Array<{path: string, lang: string, content: string}>}}
 */
export function parseRepomixMarkdown(raw) {
  const treeMatch = /# Directory Structure\n```\n([\s\S]*?)\n```/.exec(raw || '');
  const tree = treeMatch ? treeMatch[1] : '';

  const filesSectionMatch = /# Files\n\n([\s\S]*)$/.exec(raw || '');
  const filesSection = filesSectionMatch ? filesSectionMatch[1] : '';
  const blocks = filesSection.split(/\n(?=## File: )/).map((b) => b.trim()).filter(Boolean);

  const FILE_BLOCK_RE = /^## File: (.+)\n```([^\n]*)\n([\s\S]*)\n```\s*$/;
  const files = [];
  for (const block of blocks) {
    const m = FILE_BLOCK_RE.exec(block);
    if (!m) continue;
    files.push({ path: m[1].trim(), lang: m[2].trim(), content: m[3] });
  }
  return { tree, files };
}

function isCoreFile(filePath) {
  return CORE_ROOT_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

// ─── Tracked-file tree renderer (Phase 39 / CE-4 incremental path) ──────────
//
// The incremental path doesn't re-invoke repomix's own file walker (that
// would defeat the point of a scoped `--include` re-scan), so it rebuilds
// the "# Directory Structure" tree from `git ls-files` instead. Same visual
// convention as repomix's own tree (2-space indent per depth, directories
// before files, both alphabetical, trailing slash on directories) but this
// is an independent renderer — not required to be byte-identical to a real
// repomix repack, only correct and deterministic for a given file list.

function buildPathTree(paths) {
  const root = { dirs: new Map(), files: new Set() };
  for (const p of paths) {
    const parts = String(p).split('/').filter(Boolean);
    if (!parts.length) continue;
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const seg = parts[i];
      if (!node.dirs.has(seg)) node.dirs.set(seg, { dirs: new Map(), files: new Set() });
      node = node.dirs.get(seg);
    }
    node.files.add(parts[parts.length - 1]);
  }
  return root;
}

function renderPathTreeLines(node, depth) {
  const indent = '  '.repeat(depth);
  const lines = [];
  for (const name of [...node.dirs.keys()].sort()) {
    lines.push(`${indent}${name}/`);
    lines.push(...renderPathTreeLines(node.dirs.get(name), depth + 1));
  }
  for (const name of [...node.files].sort()) {
    lines.push(`${indent}${name}`);
  }
  return lines;
}

/**
 * @param {string[]} paths - forward-slash-relative file paths (e.g. from `git ls-files`)
 * @returns {string} a repomix-style indented tree body (no fences — callers wrap via renderTreeBlock)
 */
export function renderTreeFromPaths(paths) {
  return renderPathTreeLines(buildPathTree(paths || []), 0).join('\n');
}

// Heuristic (regex, not AST) exported-symbol-name extraction — good enough
// for "tree + exported symbol names only" (degradation level 2). Covers ESM
// export forms and the CommonJS exports.foo = / module.exports.foo = forms.
const EXPORT_LINE_PATTERNS = Object.freeze([
  /^export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/,
  /^export\s+(?:default\s+)?class\s+([A-Za-z0-9_$]+)/,
  /^export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/,
  /^(?:module\.)?exports\.([A-Za-z0-9_$]+)\s*=/,
]);

export function extractExportedSymbols(content) {
  const names = new Set();
  for (const rawLine of (content || '').split('\n')) {
    const line = rawLine.trim();
    let matched = false;
    for (const re of EXPORT_LINE_PATTERNS) {
      const m = re.exec(line);
      if (m && m[1]) { names.add(m[1]); matched = true; break; }
    }
    if (matched) continue;

    const braceMatch = /^export\s*\{([^}]*)\}/.exec(line);
    if (braceMatch) {
      for (const part of braceMatch[1].split(',')) {
        const piece = part.trim();
        if (!piece) continue;
        const asMatch = /\bas\s+([A-Za-z0-9_$]+)$/.exec(piece);
        names.add(asMatch ? asMatch[1] : piece.split(/\s+/)[0]);
      }
      continue;
    }

    if (/^export\s+default\b/.test(line)) names.add('default');
  }
  return [...names];
}

// ─── Degradation levels ──────────────────────────────────────────────────────
//
// 0: tree + full compressed content for every file (repomix's own output).
// 1: tree + full compressed content for CORE_ROOT_PREFIXES files only.
// 2: tree + exported symbol names only (all files).
// 3: tree only.

function renderTreeBlock(tree) {
  return `# Directory Structure\n\`\`\`\n${tree}\n\`\`\`\n`;
}

function renderFilesBlock(files) {
  if (!files.length) return '';
  const blocks = files
    .map((f) => `## File: ${f.path}\n\`\`\`${f.lang}\n${f.content}\n\`\`\``)
    .join('\n\n');
  return `\n# Files\n\n${blocks}\n`;
}

function renderSymbolsBlock(files) {
  if (!files.length) return '';
  const lines = files.map((f) => {
    const symbols = extractExportedSymbols(f.content);
    return symbols.length ? `- ${f.path}: ${symbols.join(', ')}` : `- ${f.path}`;
  });
  return `\n# Exported symbols\n\n${lines.join('\n')}\n`;
}

// Phase 39 (CE-4) — focus rendering. `fp` matches either the exact file path
// or a directory prefix (`fp` or `fp/` matches everything under `fp/`).
function isPathFocused(filePath, focusPaths) {
  return focusPaths.some((fp) => {
    if (!fp) return false;
    const normalized = fp.endsWith('/') ? fp.slice(0, -1) : fp;
    return filePath === normalized || filePath.startsWith(`${normalized}/`);
  });
}

// A per-subset render: level 0/1 → full content, level 2 → symbols-only,
// level 3 → nothing (tree only). Used for BOTH the focused and non-focused
// subsets in focus mode — the CORE_ROOT_PREFIXES filter that distinguishes
// level 0 from level 1 in the unfocused path doesn't apply once the subset is
// already scoped by focus/not-focus.
function renderFilesBlockAtLevel(files, level) {
  if (level >= 3) return '';
  if (level === 2) return renderSymbolsBlock(files);
  return renderFilesBlock(files);
}

/**
 * @param {{tree: string, files: Array}} parsed
 * @param {0|1|2|3} level
 * @param {{focusPaths?: string[]}} [opts] - Phase 39 (CE-4): when focusPaths
 *   is non-empty, files matching it (exact path or directory prefix) render
 *   at min(level,1) (effectively always full content) while every other file
 *   renders at max(level,2) (symbols-only, degrading to nothing at level 3).
 *   Absent/empty focusPaths takes the original unfocused branch unchanged —
 *   byte-identical to the pre-phase-39 output for the same (parsed, level).
 * @returns {string}
 */
export function renderMapBody(parsed, level, { focusPaths } = {}) {
  const { tree, files } = parsed;
  if (!Array.isArray(focusPaths) || focusPaths.length === 0) {
    if (level >= 3) return renderTreeBlock(tree);
    if (level === 2) return renderTreeBlock(tree) + renderSymbolsBlock(files);
    if (level === 1) return renderTreeBlock(tree) + renderFilesBlock(files.filter((f) => isCoreFile(f.path)));
    return renderTreeBlock(tree) + renderFilesBlock(files);
  }

  const focusFiles = files.filter((f) => isPathFocused(f.path, focusPaths));
  const restFiles = files.filter((f) => !isPathFocused(f.path, focusPaths));
  const focusLevel = Math.min(level, 1);
  const restLevel = Math.max(level, 2);

  return renderTreeBlock(tree)
    + renderFilesBlockAtLevel(focusFiles, focusLevel)
    + renderFilesBlockAtLevel(restFiles, restLevel);
}

// ─── Incremental cache (Phase 39 / CE-4) ────────────────────────────────────
//
// .guide/repo-map-cache.json persists the PARSED structure ({ sha, tree,
// files }) generateRepoMap works with internally — the .md body is already
// degraded (level 1-3 drop/compress file content) and can't be re-rendered
// at a different level or focus. Both halves below fail open to the
// pre-phase-39 full-repack path: a missing cache, a changedFilesSince
// failure, or a diff bigger than the threshold all take the exact same
// runRepomixFn call (no extraArgs) a pre-phase-39 regeneration took.

/**
 * Reads .guide/repo-map-cache.json. Fail-open: a missing file, invalid JSON,
 * or a shape that doesn't match { sha, tree, files } all resolve to null —
 * every caller treats null as "no cache, fall back."
 *
 * @param {string} projDir
 * @returns {Promise<{sha: string, tree: string, files: Array}|null>}
 */
export async function readRepoMapCache(projDir) {
  try {
    const raw = await fsp.readFile(repoMapCachePath(projDir), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.sha !== 'string' || typeof parsed.tree !== 'string' || !Array.isArray(parsed.files)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function pathExistsOnDisk(workspaceDir, relPath) {
  try {
    await fsp.access(path.join(workspaceDir, relPath));
    return true;
  } catch {
    return false;
  }
}

/**
 * Decides full-repack vs incremental merge for a HEAD that has moved past
 * `cache.sha`, and returns the fresh { tree, files } parsed structure
 * (repo-map.js's shared shape — same as parseRepomixMarkdown's return).
 * Never writes to disk — generateRepoMap owns persistence; this stays pure
 * generation logic so it's independently unit-testable.
 *
 * @param {{workspaceDir: string, cfg: Object, cache: {sha: string, tree: string, files: Array}|null}} args
 * @param {{runRepomix?: Function, changedFilesSince?: Function, listTrackedFiles?: Function}} [deps]
 * @returns {Promise<{tree: string, files: Array}>}
 */
export async function updateRepoMapIncremental({ workspaceDir, cfg, cache }, deps = {}) {
  const runRepomixFn = deps.runRepomix ?? runRepomix;
  const changedFilesSinceFn = deps.changedFilesSince ?? changedFilesSince;
  const listTrackedFilesFn = deps.listTrackedFiles ?? listTrackedFiles;

  const repoMapCfg = cfg?.repo_map || {};
  const exclude = Array.isArray(repoMapCfg.exclude) ? repoMapCfg.exclude : DEFAULT_EXCLUDE;
  const threshold = Number.isFinite(repoMapCfg.full_repack_threshold_files)
    ? repoMapCfg.full_repack_threshold_files
    : DEFAULT_FULL_REPACK_THRESHOLD_FILES;

  const fullRepack = async () => {
    const raw = await runRepomixFn({ workspaceDir, exclude, timeoutMs: REPOMIX_TIMEOUT_MS });
    return parseRepomixMarkdown(raw);
  };

  if (!cache) return fullRepack();

  const diff = await changedFilesSinceFn(workspaceDir, cache.sha);
  if (!diff.ok || diff.files.length > threshold) return fullRepack();

  const changed = diff.files;
  const raw = await runRepomixFn({
    workspaceDir, exclude, timeoutMs: REPOMIX_TIMEOUT_MS, extraArgs: ['--include', changed.join(',')],
  });
  const parsedChanged = parseRepomixMarkdown(raw);

  // Merge: replace/add every path repomix returned fresh content for; a
  // changed path repomix did NOT return (deleted, or renamed away) is
  // dropped from the cache only once confirmed gone from disk too — so
  // renames/deletes drop out of the name-only diff instead of leaving a
  // stale entry behind.
  const byPath = new Map((cache.files || []).map((f) => [f.path, f]));
  for (const f of parsedChanged.files) byPath.set(f.path, f);
  const refreshedPaths = new Set(parsedChanged.files.map((f) => f.path));
  for (const p of changed) {
    if (refreshedPaths.has(p)) continue;
    if (!(await pathExistsOnDisk(workspaceDir, p))) byPath.delete(p);
  }
  const files = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));

  const treeRes = await listTrackedFilesFn(workspaceDir);
  if (!treeRes.ok) return fullRepack();
  const tree = renderTreeFromPaths(treeRes.files);

  return { tree, files };
}

// ─── Orchestration ───────────────────────────────────────────────────────────

async function readExistingMap(outPath) {
  let raw;
  try {
    raw = await fsp.readFile(outPath, 'utf-8');
  } catch {
    return null;
  }
  return parseFrontMatter(raw);
}

/**
 * Generate (or return the cached) deterministic repo map for a project's
 * workspace. Fail-open: any error (repomix missing/crashing, git error,
 * fs error) logs a console.warn and resolves to null — never throws.
 *
 * @param {Object} args
 * @param {string} args.workspaceDir - absolute path to the project's workspace/ (git repo root)
 * @param {string} args.projDir - absolute path to the project dir (.guide/ lives under here)
 * @param {Object} args.cfg - resolved config; reads cfg.repo_map
 * @param {{runRepomix?: Function, getHeadSha?: Function, updateRepoMapIncremental?: Function}} [deps] - injectable seam for tests
 * @returns {Promise<{path: string, generated_at_sha: string, generated_at: string, tool: string, approx_tokens: number, degradation_level: number, body: string, cached: boolean}|null>}
 */
export async function generateRepoMap({ workspaceDir, projDir, cfg }, deps = {}) {
  const runRepomixFn = deps.runRepomix ?? runRepomix;
  const getHeadShaFn = deps.getHeadSha ?? getHeadSha;
  const updateRepoMapIncrementalFn = deps.updateRepoMapIncremental ?? updateRepoMapIncremental;

  const repoMapCfg = cfg?.repo_map || {};
  if (repoMapCfg.enabled === false) return null;

  const outPath = repoMapPath(projDir);
  const cachePath = repoMapCachePath(projDir);

  try {
    const headSha = await getHeadShaFn(workspaceDir);
    if (!headSha) {
      console.warn(chalk.yellow(`[repo-map] could not resolve HEAD sha for ${workspaceDir} — skipping`));
      return null;
    }

    const existing = await readExistingMap(outPath);
    if (existing && existing.attrs.generated_at_sha === headSha) {
      return { ...existing.attrs, body: existing.body, path: outPath, cached: true };
    }

    const maxTokens = Number.isFinite(repoMapCfg.max_tokens) ? repoMapCfg.max_tokens : DEFAULT_MAX_TOKENS;
    const exclude = Array.isArray(repoMapCfg.exclude) ? repoMapCfg.exclude : DEFAULT_EXCLUDE;
    // Phase 39 (CE-4): repo_map.incremental:false always takes the exact
    // pre-phase-39 full-repack call (no cache read, no cache write) — the
    // escape hatch reproduces old behavior byte-for-byte, same contract as
    // repo_map.enabled:false above.
    const incrementalEnabled = repoMapCfg.incremental !== false;

    let parsed;
    if (incrementalEnabled) {
      const cache = await readRepoMapCache(projDir);
      parsed = await updateRepoMapIncrementalFn({ workspaceDir, cfg, cache }, deps);
    } else {
      const raw = await runRepomixFn({ workspaceDir, exclude, timeoutMs: REPOMIX_TIMEOUT_MS });
      parsed = parseRepomixMarkdown(raw);
    }

    let level = 0;
    let body = renderMapBody(parsed, level);
    let approxTokens = estimateTokens(body);
    while (approxTokens > maxTokens && level < MAX_DEGRADATION_LEVEL) {
      level += 1;
      body = renderMapBody(parsed, level);
      approxTokens = estimateTokens(body);
    }

    const attrs = {
      generated_at_sha: headSha,
      generated_at: new Date().toISOString(),
      tool: 'repomix',
      approx_tokens: approxTokens,
      degradation_level: level,
    };

    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    await fsp.writeFile(outPath, renderFrontMatter(attrs) + '\n\n' + body, 'utf-8');
    if (incrementalEnabled) {
      await fsp.writeFile(cachePath, JSON.stringify({ sha: headSha, tree: parsed.tree, files: parsed.files }), 'utf-8');
    }

    return { ...attrs, body, path: outPath, cached: false };
  } catch (err) {
    console.warn(chalk.yellow(`[repo-map] generation failed for ${workspaceDir}: ${err.message}`));
    return null;
  }
}

// ─── Injection rendering (Phase 16) ──────────────────────────────────────────

/**
 * Wraps a generateRepoMap() result into the injectable prompt block, prefixed
 * with the brief P1 precedence sentence (verbatim — the exact wording is
 * load-bearing, callers must not paraphrase it). null in, null out, so every
 * call site can chain `renderRepoMapBlock(await generateRepoMap(...))`
 * without its own null check.
 *
 * @param {{generated_at_sha: string, body: string}|null} map
 * @returns {string|null}
 */
export function renderRepoMapBlock(map) {
  if (!map) return null;
  return `<repo_map>
This map is generated from static analysis at commit ${map.generated_at_sha}. It orients you; it is not exhaustive. The code itself is authoritative — verify before relying on it.

${map.body}
</repo_map>`;
}

// ─── Deterministic stack tags (Phase 80 / brief 05 P3) ──────────────────────
//
// Derive a small, stable set of tech-stack tags from a project's package.json
// dependencies + its workspace file extensions — NO LLM call. Used to match a
// project against cross-project global lessons (src/lib/lessons.js) by stack
// overlap. Kept a pure, data-driven, self-contained pair (deriveStackTags is
// pure; computeWorkspaceStackTags does the fail-open I/O) so it stays cleanly
// reusable — brief 09's skill fabric is built directly on this helper.

// Dependency name → stack tag. Multiple deps can map to the same tag (e.g.
// grammy / telegraf → telegram-bot). Extend freely; unknown deps are ignored.
const DEP_TAG_MAP = Object.freeze({
  react: 'react',
  'react-dom': 'react',
  next: 'react',
  vue: 'vue',
  nuxt: 'vue',
  svelte: 'svelte',
  express: 'express',
  fastify: 'fastify',
  koa: 'koa',
  grammy: 'telegram-bot',
  telegraf: 'telegram-bot',
  'node-telegram-bot-api': 'telegram-bot',
  'discord.js': 'discord-bot',
  'better-sqlite3': 'sqlite',
  sqlite3: 'sqlite',
  sqlite: 'sqlite',
  pg: 'postgres',
  mysql: 'mysql',
  mysql2: 'mysql',
  mongoose: 'mongodb',
  mongodb: 'mongodb',
  redis: 'redis',
  ioredis: 'redis',
  vite: 'vite',
  webpack: 'webpack',
  esbuild: 'esbuild',
  commander: 'cli',
  yargs: 'cli',
  typescript: 'typescript',
  'react-native': 'react-native',
});

// File extension → stack tag. Framework detection stays in DEP_TAG_MAP (more
// reliable); extensions cover language/runtime signals.
const EXT_TAG_MAP = Object.freeze({
  '.js': 'node',
  '.mjs': 'node',
  '.cjs': 'node',
  '.jsx': 'react',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.java': 'java',
  '.sql': 'sql',
});

/**
 * Pure derivation of sorted stack tags from a parsed package.json + a list of
 * workspace file paths. Deterministic (sorted output), no I/O, no LLM.
 *
 * @param {{packageJson?: object|null, files?: string[]}} args
 * @returns {string[]} sorted unique stack tags (e.g. ['cli','express','node','sqlite'])
 */
export function deriveStackTags({ packageJson = null, files = [] } = {}) {
  const tags = new Set();
  const pkg = packageJson && typeof packageJson === 'object' ? packageJson : null;
  if (pkg) {
    // A package.json IS a node project.
    tags.add('node');
    const deps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
      ...(pkg.peerDependencies || {}),
      ...(pkg.optionalDependencies || {}),
    };
    for (const name of Object.keys(deps)) {
      const tag = DEP_TAG_MAP[name];
      if (tag) tags.add(tag);
    }
    // A `bin` field (string or map) means this package ships a CLI.
    if (pkg.bin) tags.add('cli');
  }
  for (const f of Array.isArray(files) ? files : []) {
    const ext = path.extname(String(f)).toLowerCase();
    const tag = EXT_TAG_MAP[ext];
    if (tag) tags.add(tag);
  }
  return [...tags].sort();
}

/**
 * Fail-open wrapper: read the workspace's package.json (if any) + list its
 * tracked files (if a git repo), then deriveStackTags. A missing package.json
 * or a non-git workspace simply yields fewer tags — never throws.
 *
 * @param {string} workspaceDir
 * @param {{listTrackedFiles?: Function}} [deps]
 * @returns {Promise<string[]>}
 */
export async function computeWorkspaceStackTags(workspaceDir, deps = {}) {
  const listTrackedFilesFn = deps.listTrackedFiles ?? listTrackedFiles;
  let packageJson = null;
  try {
    const raw = await fsp.readFile(path.join(workspaceDir, 'package.json'), 'utf-8');
    packageJson = JSON.parse(raw);
  } catch { /* no/unreadable package.json — derive from extensions alone */ }
  let files = [];
  try {
    const res = await listTrackedFilesFn(workspaceDir);
    if (res && res.ok && Array.isArray(res.files)) files = res.files;
  } catch { /* not a git repo / git error — derive from package.json alone */ }
  return deriveStackTags({ packageJson, files });
}
