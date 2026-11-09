// Hybrid Context Compiler — deterministic, fail-open task-scoped context.
//
// The compiler deliberately makes no LLM calls. It combines the existing
// Repomix cache, explicit phase/fix metadata, lexical symbol extraction,
// import relationships, and test-file associations into a small manifest.
// The provider surface is intentionally recorded in the manifest so a future
// Serena/SCIP adapter can replace candidate discovery without changing the
// phase-runner or MCP contracts.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { listTrackedFiles } from './git.js';
import { estimateTokens, readRepoMapCache } from './repo-map.js';
import { resolveContextCompilerRolloutPolicy } from './context-compiler-policy.js';
import { isTestPath } from './context-test-cadence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_STATE_ROOT = path.join(REPO_ROOT, 'state', 'context');

const DEFAULT_CFG = Object.freeze({
  enabled: false,
  mode: 'shadow',
  provider: 'hybrid-lexical',
  fallback: Object.freeze(['repo-map', 'lexical']),
  max_files: 12,
  max_symbols: 20,
  max_reference_depth: 1,
  min_confidence: 0.65,
  max_scan_files: 2000,
  max_file_bytes: 256000,
  timeout_ms: Object.freeze({ warm: 10000, cold: 45000 }),
  token_budget: Object.freeze({
    low: 1200,
    medium: 1800,
    high: 2500,
    critical: 2500,
    fix: 1000,
    repair: 1200,
    hard_max: 3000,
  }),
});

const SOURCE_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
  '.py', '.go', '.rs', '.java', '.kt', '.kts', '.rb', '.php',
  '.cs', '.swift', '.vue', '.svelte', '.json', '.yaml', '.yml',
  '.toml', '.sql', '.graphql', '.gql', '.md', '.sh', '.css', '.scss',
]);

const EXCLUDED_SEGMENTS = new Set([
  'node_modules', 'dist', 'build', 'coverage', '.git', '.next', '.nuxt',
  'vendor', 'target', 'out', 'tmp', 'logs', '__snapshots__',
]);

const STOP_WORDS = new Set([
  'about', 'acceptance', 'after', 'again', 'against', 'also', 'always',
  'before', 'between', 'build', 'change', 'check', 'complete', 'context',
  'criteria', 'development', 'does', 'each', 'ensure', 'every', 'expected',
  'files', 'from', 'have', 'implementation', 'into', 'make', 'must', 'only',
  'phase', 'project', 'should', 'that', 'their', 'then', 'these', 'this',
  'through', 'using', 'when', 'where', 'which', 'with', 'without', 'work',
]);

const CONFIG_PATH_RE = /(^|\/)(config|configs|schema|schemas|migrations?)(\/|$)|(^|\/)(package\.json|tsconfig[^/]*\.json)$/i;
const GENERATED_PATH_RE = /(^|\/)(generated|vendor|dist|build|coverage|out)(\/|$)|\.min\.[^.]+$/i;

function asPositiveInt(value, fallback, maximum = 10000) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, maximum) : fallback;
}

export function resolveContextCompilerConfig(raw = {}) {
  const tokenBudget = { ...DEFAULT_CFG.token_budget, ...(raw.token_budget || {}) };
  const mode = ['shadow', 'assist', 'enforce'].includes(raw.mode) ? raw.mode : DEFAULT_CFG.mode;
  return {
    ...DEFAULT_CFG,
    ...raw,
    enabled: raw.enabled === true,
    mode,
    provider: typeof raw.provider === 'string' && raw.provider.trim() ? raw.provider.trim() : DEFAULT_CFG.provider,
    fallback: Array.isArray(raw.fallback)
      ? [...new Set(raw.fallback.map((value) => String(value || '').trim()).filter(Boolean))]
      : [...DEFAULT_CFG.fallback],
    max_files: asPositiveInt(raw.max_files, DEFAULT_CFG.max_files, 50),
    max_symbols: asPositiveInt(raw.max_symbols, DEFAULT_CFG.max_symbols, 100),
    max_reference_depth: asPositiveInt(raw.max_reference_depth, DEFAULT_CFG.max_reference_depth, 3),
    max_scan_files: asPositiveInt(raw.max_scan_files, DEFAULT_CFG.max_scan_files, 10000),
    max_file_bytes: asPositiveInt(raw.max_file_bytes, DEFAULT_CFG.max_file_bytes, 2000000),
    timeout_ms: {
      warm: asPositiveInt(raw.timeout_ms?.warm, DEFAULT_CFG.timeout_ms.warm, 300000),
      cold: asPositiveInt(raw.timeout_ms?.cold, DEFAULT_CFG.timeout_ms.cold, 300000),
    },
    min_confidence: Number.isFinite(raw.min_confidence)
      ? Math.max(0, Math.min(1, raw.min_confidence))
      : DEFAULT_CFG.min_confidence,
    token_budget: {
      low: asPositiveInt(tokenBudget.low, DEFAULT_CFG.token_budget.low, 10000),
      medium: asPositiveInt(tokenBudget.medium, DEFAULT_CFG.token_budget.medium, 10000),
      high: asPositiveInt(tokenBudget.high, DEFAULT_CFG.token_budget.high, 10000),
      critical: asPositiveInt(tokenBudget.critical, tokenBudget.high || DEFAULT_CFG.token_budget.critical, 10000),
      fix: asPositiveInt(tokenBudget.fix, DEFAULT_CFG.token_budget.fix, 10000),
      repair: asPositiveInt(tokenBudget.repair, DEFAULT_CFG.token_budget.repair, 10000),
      hard_max: asPositiveInt(tokenBudget.hard_max, DEFAULT_CFG.token_budget.hard_max, 12000),
    },
  };
}

/** Stable identity for compiler evidence and the thresholds that compare it. */
export function contextCompilerConfigFingerprint(raw = {}) {
  const config = resolveContextCompilerConfig(raw);
  const rolloutPolicy = resolveContextCompilerRolloutPolicy(config.rollout || {});
  const material = {
    compiler_contract_version: 4,
    provider: config.provider,
    fallback: config.fallback,
    max_files: config.max_files,
    max_symbols: config.max_symbols,
    max_reference_depth: config.max_reference_depth,
    min_confidence: config.min_confidence,
    max_scan_files: config.max_scan_files,
    max_file_bytes: config.max_file_bytes,
    timeout_ms: config.timeout_ms,
    token_budget: config.token_budget,
    targeted_tests: config.targeted_tests === true,
    delta_acceptance_recheck: config.delta_acceptance_recheck === true,
    fresh_repair_session: config.fresh_repair_session !== false,
    full_suite_every_checkpoints: config.full_suite_every_checkpoints ?? null,
    // Runtime enable/mode/automation switches are deliberate control-plane
    // boundaries handled by context-compiler-rollout.js. The normalized
    // measurement policy belongs here: changing its window or thresholds must
    // collect a fresh, comparable evidence cohort rather than reinterpreting
    // an old cohort under a newly relaxed rule.
    rollout_policy: rolloutPolicy,
  };
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

export function contextCompilerInjects(cfg) {
  const resolved = resolveContextCompilerConfig(cfg?.context_compiler || cfg || {});
  return resolved.enabled && (resolved.mode === 'assist' || resolved.mode === 'enforce');
}

/**
 * Resolve how a compiled manifest may be used. Enforce mode is deliberately
 * stricter than assist: incomplete/low-confidence evidence falls back to the
 * normal repository exploration and requires full verification. It never
 * stops overnight execution for compiler quality or infrastructure failures.
 */
export function resolveCompiledContextUse(cfg, manifest) {
  const config = resolveContextCompilerConfig(cfg?.context_compiler || cfg || {});
  if (!config.enabled || !manifest || config.mode === 'shadow') {
    return { inject: false, degraded: false, force_full_verification: false, reason: 'disabled-or-shadow' };
  }
  if (config.mode === 'assist') {
    return { inject: true, degraded: false, force_full_verification: !!manifest.test_plan?.requires_full_suite, reason: 'assist' };
  }

  const criteria = Array.isArray(manifest.criteria_map) ? manifest.criteria_map : [];
  const mapped = criteria.filter((criterion) =>
    (criterion.production_symbols?.length || 0) > 0 || (criterion.production_files?.length || 0) > 0);
  const coverage = criteria.length > 0 ? mapped.length / criteria.length : 1;
  const confidenceOk = Number(manifest.confidence) >= config.min_confidence;
  const evidenceOk = coverage === 1;
  if (confidenceOk && evidenceOk) {
    return {
      inject: true,
      degraded: false,
      force_full_verification: !!manifest.test_plan?.requires_full_suite,
      reason: 'enforce-evidence-complete',
      criterion_coverage: coverage,
    };
  }
  return {
    inject: false,
    degraded: true,
    force_full_verification: true,
    reason: !confidenceOk ? 'enforce-low-confidence' : 'enforce-incomplete-criterion-evidence',
    criterion_coverage: coverage,
  };
}

function normalizePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function isScannablePath(filePath) {
  const raw = String(filePath || '').replaceAll('\\', '/');
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) return false;
  const normalized = normalizePath(raw);
  const segments = normalized.split('/');
  if (!normalized || normalized === '..' || normalized.startsWith('../') || segments.includes('..')) return false;
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return false;
  return SOURCE_EXTENSIONS.has(path.extname(normalized).toLowerCase()) || path.basename(normalized) === 'Dockerfile';
}

function normalizeCriteria(criteria) {
  if (!Array.isArray(criteria)) return [];
  return criteria
    .map((criterion, index) => {
      if (typeof criterion === 'string') return { id: `AC-${index + 1}`, text: criterion, risk: null };
      if (!criterion || typeof criterion !== 'object') return null;
      return {
        id: String(criterion.id || criterion.key || `AC-${index + 1}`),
        text: String(criterion.text || criterion.criterion || criterion.description || criterion.title || ''),
        risk: criterion.risk ? String(criterion.risk) : null,
      };
    })
    .filter((criterion) => criterion?.text.trim());
}

function extractPaths(text) {
  const paths = new Set();
  const source = String(text || '');
  const re = /(?:^|[\s`'"(])((?:\.?\.?\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.@-]+)(?=$|[\s`'"),:])/g;
  for (const match of source.matchAll(re)) {
    const candidate = normalizePath(match[1]);
    if (candidate && !candidate.includes('://')) paths.add(candidate);
  }
  return [...paths];
}

function splitIdentifier(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9_$]+/g, ' ')
    .split(/\s+/)
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
}

export function extractTaskTerms(task = {}) {
  const criteria = normalizeCriteria(task.criteria || task.acceptance_criteria);
  const textParts = [
    task.title, task.goal, task.prompt_text, task.checkpoint,
    ...(criteria.map((criterion) => criterion.text)),
    ...(task.failed_criteria || []), ...(task.must_fix || []),
    ...(task.explicit_symbols || []),
  ].filter(Boolean).map(String);

  const exactIdentifiers = new Set();
  for (const text of textParts) {
    for (const match of text.matchAll(/`([^`]{2,120})`/g)) {
      if (!match[1].includes('/') && /^[A-Za-z_$][A-Za-z0-9_$.-]*$/.test(match[1])) {
        exactIdentifiers.add(match[1].toLowerCase());
      }
    }
    for (const match of text.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]*(?:[A-Z_][A-Za-z0-9_$]*)+\b/g)) {
      exactIdentifiers.add(match[0].toLowerCase());
    }
  }

  const terms = new Set();
  for (const text of textParts) {
    for (const term of splitIdentifier(text)) {
      if (term.length < 3 || STOP_WORDS.has(term) || /^\d+$/.test(term)) continue;
      terms.add(term);
    }
  }
  for (const identifier of exactIdentifiers) terms.add(identifier);

  const explicitPaths = new Set([
    ...(task.explicit_paths || task.files_expected || []),
    ...(task.changed_files || []),
    ...textParts.flatMap(extractPaths),
  ].map(normalizePath).filter(Boolean));

  return {
    criteria,
    terms: [...terms].slice(0, 80),
    exactIdentifiers: [...exactIdentifiers].slice(0, 40),
    explicitPaths: [...explicitPaths],
  };
}

const MONOREPO_CONTAINER_DIRS = new Set(['apps', 'packages', 'services', 'libs', 'modules', 'workspaces']);
const MONOREPO_TOP_LEVEL_SCOPES = new Set(['backend', 'frontend', 'server', 'client', 'api', 'web', 'mobile', 'desktop']);
const NON_SCOPE_ROOTS = new Set(['src', 'test', 'tests', '__tests__', 'config', 'configs', 'docs', 'scripts', 'public']);

/**
 * Infer high-confidence package boundaries from explicit phase paths. This is
 * intentionally path-only and deterministic: it works for npm/pnpm/yarn
 * monorepos without reading package-manager metadata and fails open for a
 * conventional single-package `src/` tree.
 */
export function inferTaskPackageScopes(explicitPaths = []) {
  const scopes = new Set();
  for (const raw of explicitPaths || []) {
    const normalized = normalizePath(raw).replace(/\/$/, '');
    const parts = normalized.split('/').filter(Boolean);
    if (!parts.length) continue;
    if (MONOREPO_CONTAINER_DIRS.has(parts[0]) && parts[1]) {
      scopes.add(`${parts[0]}/${parts[1]}/`);
    } else if (MONOREPO_TOP_LEVEL_SCOPES.has(parts[0])) {
      scopes.add(`${parts[0]}/`);
    } else if (parts.length >= 3 && !NON_SCOPE_ROOTS.has(parts[0])) {
      // Custom monorepos commonly use product/domain roots rather than a
      // standard packages/ container. Require depth >= 3 to avoid treating a
      // root-level file's parent as a package on ordinary repositories.
      scopes.add(`${parts[0]}/`);
    }
  }
  return [...scopes].sort();
}

function candidatePathPriority(filePath, { explicitPaths = [], terms = [], packageScopes = [] } = {}) {
  const normalized = normalizePath(filePath);
  const lower = normalized.toLowerCase();
  let score = 0;
  if (explicitPaths.some((raw) => {
    const explicit = normalizePath(raw).replace(/\/$/, '');
    return normalized === explicit || normalized.startsWith(`${explicit}/`) || explicit.startsWith(`${normalized}/`);
  })) score += 10000;
  if (packageScopes.some((scope) => normalized.startsWith(scope))) score += 2000;
  for (const term of terms.slice(0, 40)) {
    if (lower.includes(String(term).toLowerCase())) score += 40;
  }
  if (isTestPath(normalized)) score += 5;
  if (GENERATED_PATH_RE.test(normalized)) score -= 1000;
  return score;
}

/** Prioritize likely package-local files before applying max_scan_files. */
export function prioritizeContextCandidatePaths(paths, hints = {}) {
  return (paths || [])
    .map((value, index) => {
      const filePath = typeof value === 'string' ? value : value?.path;
      return { value, index, score: candidatePathPriority(filePath, hints) };
    })
    .sort((left, right) => (right.score - left.score) || left.index - right.index)
    .map((entry) => entry.value);
}

function countOccurrences(haystack, needle) {
  if (!needle || !haystack) return 0;
  let count = 0;
  let cursor = 0;
  while (count < 5) {
    const index = haystack.indexOf(needle, cursor);
    if (index === -1) break;
    count += 1;
    cursor = index + needle.length;
  }
  return count;
}

function declarationMatches(content) {
  const declarations = [];
  const patterns = [
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
    /^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /^(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
    /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?:=|:)/,
    /^(?:def|class)\s+([A-Za-z_][\w]*)/,
    /^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/,
    /^(?:func)\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/,
  ];
  const lines = String(content || '').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    for (const pattern of patterns) {
      const match = pattern.exec(trimmed);
      if (match) {
        declarations.push({ name: match[1], line: index + 1, signature: trimmed.slice(0, 220) });
        break;
      }
    }
  }
  return declarations;
}

function importSpecifiers(content) {
  const imports = new Set();
  const source = String(content || '');
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) imports.add(match[1]);
  }
  return [...imports];
}

function resolveImport(sourcePath, specifier, knownPaths) {
  if (!specifier.startsWith('.')) return null;
  const base = normalizePath(path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), specifier)));
  const candidates = [
    base, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`,
    `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.cts`,
    `${base}/index.js`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.jsx`,
  ];
  return candidates.find((candidate) => knownPaths.has(candidate)) || null;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('context compilation aborted');
}

async function containedExistingPath(workspaceReal, workspaceDir, relativePath) {
  const candidate = path.resolve(workspaceDir, relativePath);
  const lexicalRelative = path.relative(path.resolve(workspaceDir), candidate);
  if (lexicalRelative === '..' || lexicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelative)) return null;
  const real = await fs.realpath(candidate);
  const realRelative = path.relative(workspaceReal, real);
  if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) return null;
  return { absolute: real, relative: lexicalRelative };
}

async function readCandidates({ workspaceDir, projDir, config, explicitPaths, terms = [], signal }, deps = {}) {
  const readRepoMapCacheFn = deps.readRepoMapCache ?? readRepoMapCache;
  const listTrackedFilesFn = deps.listTrackedFiles ?? listTrackedFiles;
  const readFileFn = deps.readFile ?? fs.readFile;
  throwIfAborted(signal);
  const workspaceReal = await fs.realpath(workspaceDir);
  const cache = await readRepoMapCacheFn(projDir).catch(() => null);
  const byPath = new Map();
  const packageScopes = inferTaskPackageScopes(explicitPaths);
  const candidateHints = { explicitPaths, terms, packageScopes };

  for (const file of prioritizeContextCandidatePaths(cache?.files || [], candidateHints).slice(0, config.max_scan_files)) {
    const filePath = normalizePath(file.path);
    if (!isScannablePath(file.path)) continue;
    const content = String(file.content || '');
    if (Buffer.byteLength(content) > config.max_file_bytes) continue;
    byPath.set(filePath, { path: filePath, lang: file.lang || '', content });
  }

  const lexicalAllowed = config.provider === DEFAULT_CFG.provider
    || config.fallback.includes('lexical') || config.fallback.includes('hybrid-lexical');
  if (!byPath.size && lexicalAllowed) {
    const tracked = await listTrackedFilesFn(workspaceDir);
    if (tracked?.ok) {
      const paths = prioritizeContextCandidatePaths(
        tracked.files.filter(isScannablePath),
        candidateHints,
      ).slice(0, config.max_scan_files);
      let cursor = 0;
      const workers = Array.from({ length: Math.min(24, paths.length) }, async () => {
        while (cursor < paths.length) {
          const filePath = paths[cursor++];
          try {
            throwIfAborted(signal);
            const contained = await containedExistingPath(workspaceReal, workspaceDir, filePath);
            if (!contained) continue;
            const stat = await fs.stat(contained.absolute);
            if (!stat.isFile() || stat.size > config.max_file_bytes) continue;
            const content = await readFileFn(contained.absolute, 'utf-8');
            byPath.set(normalizePath(filePath), { path: normalizePath(filePath), lang: path.extname(filePath).slice(1), content });
          } catch { throwIfAborted(signal); /* binary, deleted, or unreadable — skip */ }
        }
      });
      await Promise.all(workers);
      throwIfAborted(signal);
    }
  }

  // Explicit and changed paths must use their current on-disk content even
  // when the pre-dev Repomix cache is older than a repair commit.
  for (const filePath of explicitPaths) {
    throwIfAborted(signal);
    if (!isScannablePath(filePath)) continue;
    try {
      const contained = await containedExistingPath(workspaceReal, workspaceDir, filePath);
      if (!contained) continue;
      const stat = await fs.stat(contained.absolute);
      if (!stat.isFile() || stat.size > config.max_file_bytes) continue;
      const content = await readFileFn(contained.absolute, 'utf-8');
      byPath.set(normalizePath(contained.relative), { path: normalizePath(contained.relative), lang: path.extname(contained.relative).slice(1), content });
    } catch { /* missing explicit path is recorded as a warning later */ }
  }

  return { files: [...byPath.values()], cacheSha: cache?.sha || null, packageScopes };
}

function scoreFile(file, extracted, task, packageScopes = []) {
  const lowerPath = file.path.toLowerCase();
  const lowerContent = file.content.toLowerCase();
  const reasons = [];
  let score = 0;

  const explicit = extracted.explicitPaths.some((candidate) => {
    const p = candidate.toLowerCase().replace(/\/$/, '');
    return lowerPath === p || lowerPath.startsWith(`${p}/`) || p.endsWith(`/${lowerPath}`);
  });
  if (explicit) { score += 100; reasons.push('explicit task path'); }

  const packageLocal = packageScopes.some((scope) => file.path.startsWith(scope));
  if (packageLocal) {
    score += 30;
    reasons.push(`same package scope: ${packageScopes.find((scope) => file.path.startsWith(scope))}`);
  }

  for (const identifier of extracted.exactIdentifiers) {
    if (lowerPath.includes(identifier)) { score += 45; reasons.push(`identifier in path: ${identifier}`); }
    const occurrences = countOccurrences(lowerContent, identifier);
    if (occurrences) { score += Math.min(90, 55 + occurrences * 7); reasons.push(`exact identifier: ${identifier}`); }
  }

  let lexicalHits = 0;
  for (const term of extracted.terms) {
    const pathHit = lowerPath.includes(term);
    const occurrences = countOccurrences(lowerContent, term);
    if (pathHit) { score += 14; lexicalHits += 1; }
    if (occurrences) { score += Math.min(12, 3 + occurrences * 2); lexicalHits += 1; }
  }
  if (lexicalHits) reasons.push(`${lexicalHits} task-term match${lexicalHits === 1 ? '' : 'es'}`);

  if (isTestPath(file.path) && lexicalHits) { score += 20; reasons.push('matching test'); }
  if (CONFIG_PATH_RE.test(file.path) && /config|schema|migration|setting|default/i.test(String(task.title || '') + ' ' + String(task.goal || ''))) {
    score += 45;
    reasons.push('configuration/schema task');
  }
  if (GENERATED_PATH_RE.test(file.path)) { score -= 100; reasons.push('generated/vendor penalty'); }
  if (packageScopes.length && !packageLocal && !explicit && lexicalHits < 2) {
    score -= 15;
    reasons.push('cross-package weak-match penalty');
  }
  if (file.content.length > 150000 && !explicit) { score -= 10; reasons.push('large-file penalty'); }

  return { score, reasons, explicit, lexicalHits };
}

const TEST_ASSOCIATION_ROOTS = new Set(['test', 'tests', 'spec', 'specs']);
const SOURCE_ASSOCIATION_ROOTS = new Set(['src', 'lib']);
const GENERIC_ASSOCIATION_STEMS = new Set([
  'app', 'common', 'config', 'constants', 'default', 'entry', 'helpers',
  'index', 'init', 'main', 'mod', 'module', 'root', 'types', 'utils',
]);

function associationStem(filePath, { test = false } = {}) {
  const parsed = path.posix.parse(normalizePath(filePath));
  let name = parsed.name;
  if (test) {
    name = name
      .replace(/\.(?:test|spec)$/i, '')
      .replace(/^test[-_]/i, '')
      .replace(/[-_]test$/i, '');
  }
  return path.posix.join(parsed.dir, name).toLowerCase();
}

function withoutTestMarkerDirectories(value) {
  return value.split('/').filter((segment) => segment && segment !== '__tests__').join('/');
}

function withoutLeadingAssociationRoot(value, roots) {
  const segments = value.split('/').filter(Boolean);
  if (roots.has(segments[0])) segments.shift();
  return segments.join('/');
}

function associationPackageScope(filePath) {
  return (inferTaskPackageScopes([filePath])[0] || '').replace(/\/$/, '').toLowerCase() || null;
}

function withinAssociationScope(value, scope) {
  if (!scope) return value;
  if (value === scope) return '';
  return value.startsWith(`${scope}/`) ? value.slice(scope.length + 1) : value;
}

/**
 * Basename overlap is only a candidate signal. Require a colocated/mirrored
 * path, or a real monorepo package boundary for a descriptive filename. A
 * resolved import relation is handled separately and remains authoritative.
 */
function testPathHasProductionAffinity(productionPath, testPath) {
  const productionStem = associationStem(productionPath);
  const testStem = withoutTestMarkerDirectories(associationStem(testPath, { test: true }));

  // Colocated tests and __tests__ siblings preserve the complete source path.
  if (testStem === productionStem) return true;
  // Root test trees sometimes mirror the full repository path (tests/src/...).
  if (withoutLeadingAssociationRoot(testStem, TEST_ASSOCIATION_ROOTS) === productionStem) return true;

  const productionScope = associationPackageScope(productionPath);
  const testScope = associationPackageScope(testPath);
  if ((productionScope || testScope) && productionScope !== testScope) return false;

  const productionLocal = withinAssociationScope(productionStem, productionScope);
  const testLocal = withinAssociationScope(testStem, testScope);
  const productionLogical = withoutLeadingAssociationRoot(productionLocal, SOURCE_ASSOCIATION_ROOTS);
  const testLogical = withoutLeadingAssociationRoot(testLocal, TEST_ASSOCIATION_ROOTS);

  // src/a/b.ts <-> tests/a/b.test.ts, including descriptive test suffixes in
  // the same logical directory once the caller has established stem overlap.
  if (productionLogical === testLogical) return true;
  const productionDir = path.posix.dirname(productionLogical) === '.' ? '' : path.posix.dirname(productionLogical);
  const testDir = path.posix.dirname(testLogical) === '.' ? '' : path.posix.dirname(testLogical);
  if (productionDir === testDir) return true;

  // A same-package basename is useful in monorepos that flatten test folders,
  // but generic entrypoint names still need path or import evidence.
  const productionName = path.posix.basename(productionLogical);
  return Boolean(productionScope
    && productionScope === testScope
    && !GENERIC_ASSOCIATION_STEMS.has(productionName));
}

function buildTestAssociations(files, relations) {
  const tests = files.filter((file) => isTestPath(file.path));
  const production = files.filter((file) => !isTestPath(file.path));
  const importsBySource = new Map();
  for (const relation of relations) {
    if (!['import', 'imports', 'require', 'requires'].includes(String(relation.type || '').toLowerCase())) continue;
    if (!importsBySource.has(relation.from)) importsBySource.set(relation.from, new Set());
    importsBySource.get(relation.from).add(relation.to);
  }
  const byProduction = new Map();
  for (const prod of production) {
    const stem = path.posix.basename(prod.path).replace(/\.[^.]+$/, '').toLowerCase();
    const stemParts = splitIdentifier(stem).filter((part) => part.length >= 3);
    const related = tests.filter((test) => {
      if (importsBySource.get(test.path)?.has(prod.path)) return true;
      const testName = path.posix.basename(associationStem(test.path, { test: true }));
      return stemParts.length > 0
        && stemParts.every((part) => testName.includes(part))
        && testPathHasProductionAffinity(prod.path, test.path);
    }).map((test) => test.path);
    if (related.length) byProduction.set(prod.path, related);
  }
  return byProduction;
}

function criterionTerms(criterion) {
  return splitIdentifier(criterion.text).filter((term) => term.length >= 3 && !STOP_WORDS.has(term));
}

function criterionScore(file, criterion) {
  const terms = criterionTerms(criterion);
  const haystack = `${file.path}\n${file.content}`.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function round(value, places = 3) {
  const power = 10 ** places;
  return Math.round(value * power) / power;
}

function taskFingerprint(task, baseSha, config = {}) {
  const promptText = String(task.prompt_text || '');
  const stable = JSON.stringify({
    config_version: 4,
    compiler_fingerprint: contextCompilerConfigFingerprint(config),
    compiler: {
      mode: config.mode || null,
      provider: config.provider || null,
      max_files: config.max_files || null,
      max_symbols: config.max_symbols || null,
      max_reference_depth: config.max_reference_depth || null,
      min_confidence: config.min_confidence ?? null,
      token_budget: config.token_budget || null,
    },
    project: task.project || null,
    task_kind: task.task_kind || 'phase',
    phase: task.phase ?? null,
    title: task.title || '',
    goal: task.goal || '',
    complexity: task.complexity || null,
    checkpoint: task.checkpoint || null,
    criteria: normalizeCriteria(task.criteria || task.acceptance_criteria),
    failed_criteria: task.failed_criteria || [],
    must_fix: task.must_fix || [],
    explicit_paths: (task.explicit_paths || task.files_expected || []).map(normalizePath).sort(),
    changed_files: (task.changed_files || []).map(normalizePath).sort(),
    explicit_symbols: (task.explicit_symbols || []).map(String).sort(),
    execution_variant: task.execution_variant || null,
    prompt_text_sha256: promptText ? createHash('sha256').update(promptText).digest('hex') : null,
    base_sha: baseSha || null,
  });
  return createHash('sha256').update(stable).digest('hex');
}

export function resolveContextTokenBudget(config, task = {}) {
  let desired;
  if (task.task_kind === 'acceptance-repair' || task.task_kind === 'validator-repair') desired = config.token_budget.repair;
  else if (task.task_kind === 'fix' || task.task_kind === 'batch-fix') desired = config.token_budget.fix;
  else desired = config.token_budget[task.complexity] || config.token_budget.medium;
  return Math.min(desired, config.token_budget.hard_max);
}

function publicRankedFile(file, testAssociations) {
  return {
    path: file.path,
    score: round(file.score, 1),
    reasons: [...new Set(file.reasons)].slice(0, 6),
    kind: isTestPath(file.path) ? 'test' : CONFIG_PATH_RE.test(file.path) ? 'config' : 'production',
    related_tests: testAssociations.get(file.path) || [],
  };
}

function buildCriteriaMap(criteria, ranked, symbols, testAssociations) {
  return criteria.map((criterion) => {
    const candidates = ranked
      .map((file) => ({ file, criterionScore: criterionScore(file, criterion) }))
      .filter((entry) => entry.criterionScore > 0 && !isTestPath(entry.file.path))
      .sort((a, b) => b.criterionScore - a.criterionScore || b.file.score - a.file.score)
      .slice(0, 3);
    const paths = candidates.map((entry) => entry.file.path);
    const productionSymbols = symbols
      .filter((symbol) => paths.includes(symbol.file))
      .slice(0, 4)
      .map((symbol) => ({ name: symbol.name, file: symbol.file, line: symbol.line }));
    const tests = [...new Set(paths.flatMap((filePath) => testAssociations.get(filePath) || []))].slice(0, 4);
    return {
      criterion_id: criterion.id,
      criterion: criterion.text,
      risk: criterion.risk,
      production_symbols: productionSymbols,
      production_files: paths,
      tests,
      configuration: paths.filter((filePath) => CONFIG_PATH_RE.test(filePath)),
    };
  });
}

function computeConfidence({ extracted, criteriaMap, rankedFiles, cacheSha, baseSha }) {
  const explicitCoverage = extracted.explicitPaths.length
    ? extracted.explicitPaths.filter((explicit) => rankedFiles.some((file) => file.path === explicit || file.path.startsWith(`${explicit}/`))).length / extracted.explicitPaths.length
    : 1;
  const criterionCoverage = criteriaMap.length
    ? criteriaMap.filter((criterion) => criterion.production_files.length > 0).length / criteriaMap.length
    : (rankedFiles.length ? 1 : 0);
  const hasStrongCandidate = rankedFiles.some((file) => file.score >= 80) ? 1 : rankedFiles.some((file) => file.score >= 30) ? 0.6 : 0;
  const freshness = !cacheSha || !baseSha || cacheSha === baseSha ? 1 : 0.75;
  return round((explicitCoverage * 0.3) + (criterionCoverage * 0.35) + (hasStrongCandidate * 0.25) + (freshness * 0.1));
}

export function contextStateRoot() {
  return path.resolve(process.env.AORCH_CONTEXT_STATE_DIR || DEFAULT_STATE_ROOT);
}

function safeProjectSegment(projectName) {
  const value = String(projectName || '').trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(value) || value === '.' || value === '..') {
    throw new Error(`[context-compiler] invalid project name: ${JSON.stringify(projectName)}`);
  }
  return value;
}

export function contextProjectStateDir(projectName) {
  return path.join(contextStateRoot(), safeProjectSegment(projectName));
}

function contextStatePathError(filePath, reason) {
  return new Error(`[context-compiler] unsafe context state path "${filePath}": ${reason}`);
}

async function lstatIfPresent(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

async function prepareContextPersistence(projectName) {
  const projectSegment = safeProjectSegment(projectName);
  const root = contextStateRoot();
  await fs.mkdir(root, { recursive: true });
  const realRoot = await fs.realpath(root);
  const dir = path.join(root, projectSegment);

  let stat = await lstatIfPresent(dir);
  if (stat?.isSymbolicLink()) {
    throw contextStatePathError(dir, 'project directory must not be a symbolic link');
  }
  if (stat && !stat.isDirectory()) {
    throw contextStatePathError(dir, 'project state path is not a directory');
  }
  if (!stat) {
    try {
      await fs.mkdir(dir);
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
    stat = await fs.lstat(dir);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw contextStatePathError(dir, 'project directory changed during creation');
  }

  const realDir = await fs.realpath(dir);
  const expectedRealDir = path.join(realRoot, projectSegment);
  if (realDir !== expectedRealDir) {
    throw contextStatePathError(dir, `resolves to "${realDir}", outside its context-state slot "${expectedRealDir}"`);
  }
  return { root: realRoot, dir, realDir };
}

async function prepareContextRead(projectName) {
  const projectSegment = safeProjectSegment(projectName);
  const root = contextStateRoot();
  const rootStat = await lstatIfPresent(root);
  if (!rootStat) return null;
  const realRoot = await fs.realpath(root);
  const realRootStat = await fs.stat(realRoot);
  if (!realRootStat.isDirectory()) {
    throw contextStatePathError(root, 'context-state root is not a directory');
  }
  const dir = path.join(root, projectSegment);
  const projectStat = await lstatIfPresent(dir);
  if (!projectStat) return null;
  if (projectStat.isSymbolicLink()) {
    throw contextStatePathError(dir, 'project directory must not be a symbolic link');
  }
  if (!projectStat.isDirectory()) {
    throw contextStatePathError(dir, 'project state path is not a directory');
  }
  const realDir = await fs.realpath(dir);
  const expectedRealDir = path.join(realRoot, projectSegment);
  if (realDir !== expectedRealDir) {
    throw contextStatePathError(dir, `resolves to "${realDir}", outside its context-state slot "${expectedRealDir}"`);
  }
  return { root: realRoot, dir, realDir };
}

async function assertSafeContextDestination(filePath, containment) {
  const resolved = path.resolve(filePath);
  if (path.dirname(resolved) !== path.resolve(containment.dir)) {
    throw contextStatePathError(filePath, 'destination is not a direct child of the project state directory');
  }
  const projectStat = await fs.lstat(containment.dir);
  if (projectStat.isSymbolicLink() || !projectStat.isDirectory()) {
    throw contextStatePathError(containment.dir, 'project directory was replaced before persistence');
  }
  const realParent = await fs.realpath(path.dirname(resolved));
  if (realParent !== containment.realDir || !realParent.startsWith(`${containment.root}${path.sep}`)) {
    throw contextStatePathError(filePath, `real parent "${realParent}" escapes context-state root "${containment.root}"`);
  }
  const leafStat = await lstatIfPresent(resolved);
  if (leafStat?.isSymbolicLink()) {
    throw contextStatePathError(filePath, 'destination must not be a symbolic link');
  }
  if (leafStat?.isDirectory()) {
    throw contextStatePathError(filePath, 'destination is a directory');
  }
}

async function writeJsonAtomic(filePath, value, { signal, containment } = {}) {
  throwIfAborted(signal);
  await assertSafeContextDestination(filePath, containment);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    throwIfAborted(signal);
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf-8', flag: 'wx' });
    throwIfAborted(signal);
    // Recheck after the temp write so a project/leaf symlink swap cannot turn
    // atomic publication into a write outside the configured state root.
    await assertSafeContextDestination(filePath, containment);
    await fs.rename(tempPath, filePath);
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }
}

export async function persistContextManifest(manifest, { signal } = {}) {
  if (!/^[a-f0-9]{64}$/.test(String(manifest?.manifest_id || ''))) {
    throw new Error('[context-compiler] manifest_id must be a 64-character lowercase sha256');
  }
  const containment = await prepareContextPersistence(manifest?.project);
  const dir = containment.dir;
  const manifestPath = path.join(dir, `${manifest.manifest_id}.json`);
  const latestPath = path.join(dir, 'latest.json');
  // Validate both leaves before the first write. A malicious latest.json link
  // therefore cannot leave a partially-published manifest artifact behind.
  await assertSafeContextDestination(manifestPath, containment);
  await assertSafeContextDestination(latestPath, containment);
  await writeJsonAtomic(manifestPath, manifest, { signal, containment });
  await writeJsonAtomic(latestPath, manifest, { signal, containment });
  return manifestPath;
}

export async function loadContextManifest(projectName, manifestId = null) {
  if (manifestId != null && !/^[a-f0-9]{64}$/.test(String(manifestId))) {
    throw new Error('[get_compiled_context] manifest_id must be a 64-character lowercase sha256');
  }
  const containment = await prepareContextRead(projectName);
  if (!containment) return null;
  const dir = containment.dir;
  const filePath = path.join(dir, manifestId ? `${manifestId}.json` : 'latest.json');
  try {
    const leafStat = await lstatIfPresent(filePath);
    if (!leafStat) return null;
    await assertSafeContextDestination(filePath, containment);
    if (!leafStat.isFile()) {
      throw contextStatePathError(filePath, 'manifest source is not a regular file');
    }
    const contents = await fs.readFile(filePath, 'utf-8');
    // Revalidate the parent and leaf after the read as a best-effort guard
    // against path replacement during access. Node has no portable dirfd-based
    // openat primitive, so callers still treat any read error as fail-closed.
    await assertSafeContextDestination(filePath, containment);
    return JSON.parse(contents);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Compile and persist a task-scoped context manifest. Returns null on any
 * infrastructure failure so the caller can keep the existing repo-map flow.
 */
export async function compileContextManifest({ workspaceDir, projDir, projectName, task, cfg, baseSha, signal, throwOnError = false }, deps = {}) {
  const startedAt = Date.now();
  const config = resolveContextCompilerConfig(cfg?.context_compiler || cfg || {});
  if (!config.enabled) return null;

  try {
    throwIfAborted(signal);
    const normalizedTask = { ...task, project: projectName };
    const extracted = extractTaskTerms(normalizedTask);
    // Provider contract: { name, collectCandidates(args) } ->
    // { files:[{path,lang,content}], relations?:[{type,from,to}], cacheSha? }.
    // v1 ships the local lexical/Repomix provider below; Serena/SCIP adapters
    // can be injected through this seam without changing ranking/packing.
    const contextProvider = deps.contextProvider;
    const providerWarnings = [];
    let actualProvider = contextProvider?.name || DEFAULT_CFG.provider;
    let providerResult;
    if (contextProvider?.collectCandidates) {
      try {
        providerResult = await contextProvider.collectCandidates({ workspaceDir, projDir, task: normalizedTask, extracted, config, baseSha, signal });
      } catch (err) {
        const canFallback = config.fallback.some((value) => ['repo-map', 'lexical', 'hybrid-lexical'].includes(value));
        if (!canFallback) throw err;
        actualProvider = DEFAULT_CFG.provider;
        providerWarnings.push(`provider ${contextProvider.name || config.provider} failed (${err.message}); used ${actualProvider}`);
        providerResult = await readCandidates({ workspaceDir, projDir, config, explicitPaths: extracted.explicitPaths, terms: extracted.terms, signal }, deps);
      }
    } else {
      const requestedBuiltIn = config.provider === DEFAULT_CFG.provider;
      const canFallback = config.fallback.some((value) => ['repo-map', 'lexical', 'hybrid-lexical'].includes(value));
      if (!requestedBuiltIn && !canFallback) throw new Error(`requested provider ${config.provider} is unavailable and no local fallback is configured`);
      providerResult = await readCandidates({ workspaceDir, projDir, config, explicitPaths: extracted.explicitPaths, terms: extracted.terms, signal }, deps);
    }
    throwIfAborted(signal);
    const files = Array.isArray(providerResult?.files) ? providerResult.files
      .slice(0, config.max_scan_files)
      .map((file) => ({
        path: normalizePath(file.path),
        source_path: String(file.path || ''),
        lang: file.lang || '',
        content: String(file.content || ''),
      }))
      .filter((file) => file.path
        && isScannablePath(file.source_path)
        && Buffer.byteLength(file.content) <= config.max_file_bytes)
      .map(({ source_path, ...file }) => file) : [];
    const cacheSha = providerResult?.cacheSha || null;
    const knownPaths = new Set(files.map((file) => file.path));
    const relations = Array.isArray(providerResult?.relations)
      ? providerResult.relations
        .map((relation) => ({
          ...relation,
          from: normalizePath(relation?.from),
          to: normalizePath(relation?.to),
        }))
        .filter((relation) => knownPaths.has(relation.from) && knownPaths.has(relation.to))
      : [];
    const packageScopes = Array.isArray(providerResult?.packageScopes)
      ? providerResult.packageScopes
      : inferTaskPackageScopes(extracted.explicitPaths);
    // Scoring + declaration/import extraction over up to max_scan_files files
    // is CPU-bound and, run as one synchronous pass, blocks the event loop long
    // enough to freeze billing-guard timers, lease heartbeats (→ spurious lease
    // loss) and the phase-runner abort timer. Batch it: identical computation
    // and order, but yield to the loop every SCORING_YIELD_BATCH files and
    // honour the abort signal so the compile timeout can actually fire.
    const SCORING_YIELD_BATCH = 200;
    const working = [];
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      const scored = scoreFile(file, extracted, normalizedTask, packageScopes);
      const declarations = declarationMatches(file.content);
      const imports = importSpecifiers(file.content);
      for (const specifier of imports) {
        const target = resolveImport(file.path, specifier, knownPaths);
        if (target) relations.push({ type: 'imports', from: file.path, to: target });
      }
      working.push({ ...file, ...scored, declarations });
      if ((i + 1) % SCORING_YIELD_BATCH === 0) {
        throwIfAborted(signal);
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    throwIfAborted(signal);

    // Bounded relationship expansion: callers and dependencies of a strong
    // task match receive a decreasing boost for at most max_reference_depth
    // hops. This is the provider-agnostic seam a semantic provider can replace
    // with precise reference/call edges.
    const byPath = new Map(working.map((file) => [file.path, file]));
    let frontier = new Set(working.filter((file) => file.score >= 40).map((file) => file.path));
    const visited = new Set(frontier);
    const sortedRelations = [...relations].sort((a, b) => `${a.from}\0${a.to}`.localeCompare(`${b.from}\0${b.to}`));
    for (let depth = 1; depth <= config.max_reference_depth && frontier.size; depth += 1) {
      throwIfAborted(signal);
      await new Promise((resolve) => setImmediate(resolve));
      const next = new Map();
      for (const relation of sortedRelations) {
        const source = byPath.get(relation.from);
        const target = byPath.get(relation.to);
        if (!source || !target) continue;
        if (frontier.has(target.path) && !visited.has(source.path)) {
          const boost = Math.max(5, Math.round(20 / depth));
          const prior = next.get(source.path);
          next.set(source.path, prior
            ? { boost: prior.boost + boost, reason: `${prior.reason}; imports relevant file: ${target.path}` }
            : { boost, reason: `imports relevant file: ${target.path}` });
        }
        if (frontier.has(source.path) && !visited.has(target.path)) {
          const boost = Math.max(5, Math.round(15 / depth));
          const prior = next.get(target.path);
          next.set(target.path, prior
            ? { boost: prior.boost + boost, reason: `${prior.reason}; dependency of relevant file: ${source.path}` }
            : { boost, reason: `dependency of relevant file: ${source.path}` });
        }
      }
      frontier = new Set();
      for (const [filePath, effect] of next) {
        const file = byPath.get(filePath);
        file.score += effect.boost;
        file.reasons.push(effect.reason);
        visited.add(filePath);
        frontier.add(filePath);
      }
    }

    const testAssociations = buildTestAssociations(working, relations);
    for (const [productionPath, tests] of testAssociations) {
      const productionFile = byPath.get(productionPath);
      if (productionFile?.score >= 30) {
        for (const testPath of tests) {
          const testFile = byPath.get(testPath);
          if (testFile) { testFile.score += 60; testFile.reasons.push(`test for ${productionPath}`); }
        }
      }
    }

    const ranked = working
      .filter((file) => file.score > 0 || file.explicit)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    const selected = ranked.slice(0, config.max_files);

    const symbols = ranked.flatMap((file) => file.declarations.map((declaration) => {
      const lowerName = declaration.name.toLowerCase();
      let symbolScore = file.score;
      const reasons = [`file score ${round(file.score, 1)}`];
      if (extracted.exactIdentifiers.includes(lowerName)) { symbolScore += 90; reasons.push('exact task symbol'); }
      const matchingTerms = extracted.terms.filter((term) => lowerName.includes(term));
      if (matchingTerms.length) { symbolScore += matchingTerms.length * 20; reasons.push(`symbol term: ${matchingTerms.slice(0, 3).join(', ')}`); }
      return {
        name: declaration.name,
        file: file.path,
        line: declaration.line,
        signature: declaration.signature,
        score: round(symbolScore, 1),
        reasons,
      };
    })).sort((a, b) => b.score - a.score || a.file.localeCompare(b.file)).slice(0, config.max_symbols);

    const criteriaMap = buildCriteriaMap(extracted.criteria, ranked, symbols, testAssociations);
    const rankedFiles = selected.map((file) => publicRankedFile(file, testAssociations));
    const confidence = computeConfidence({ extracted, criteriaMap, rankedFiles, cacheSha, baseSha });
    const highRisk = /high|critical/i.test(String(normalizedTask.complexity || ''))
      || extracted.criteria.some((criterion) => /high|critical/i.test(String(criterion.risk || '')))
      || /security|auth|consent|billing|migration|schema|destructive/i.test(`${normalizedTask.title || ''} ${normalizedTask.goal || ''}`);
    const targetedTests = [...new Set([
      ...rankedFiles.flatMap((file) => file.related_tests || []),
      ...rankedFiles.filter((file) => file.kind === 'test').map((file) => file.path),
    ])].slice(0, 10);
    const tokenBudget = resolveContextTokenBudget(config, normalizedTask);
    const manifestId = taskFingerprint(normalizedTask, baseSha, config);
    const warnings = [...providerWarnings];
    if (config.provider !== actualProvider) warnings.push(`requested provider ${config.provider} unavailable; fell back to ${actualProvider}`);
    if (cacheSha && baseSha && cacheSha !== baseSha) warnings.push(`repo-map cache sha ${cacheSha.slice(0, 12)} differs from task sha ${baseSha.slice(0, 12)}`);
    const missingExplicit = extracted.explicitPaths.filter((explicit) => !working.some((file) => file.path === explicit || file.path.startsWith(`${explicit}/`)));
    if (missingExplicit.length) warnings.push(`explicit paths not found: ${missingExplicit.slice(0, 5).join(', ')}`);
    if (confidence < config.min_confidence) warnings.push(`confidence ${confidence} is below configured minimum ${config.min_confidence}; use normal repository exploration`);

    const manifest = {
      schema_version: 1,
      manifest_id: manifestId,
      project: projectName,
      task_kind: normalizedTask.task_kind || 'phase',
      phase: normalizedTask.phase ?? null,
      title: normalizedTask.title || null,
      base_sha: baseSha || null,
      repo_map_sha: cacheSha,
      generated_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      provider: actualProvider,
      provider_requested: config.provider,
      mode: config.mode,
      confidence,
      token_budget: tokenBudget,
      terms: extracted.terms,
      explicit_paths: extracted.explicitPaths,
      package_scopes: packageScopes,
      candidate_file_count: files.length,
      ranked_candidate_count: ranked.length,
      criteria_map: criteriaMap,
      ranked_symbols: symbols,
      ranked_files: rankedFiles,
      relations: relations.filter((relation) => selected.some((file) => file.path === relation.from || file.path === relation.to)).slice(0, 80),
      test_plan: {
        targeted_files: targetedTests,
        requires_full_suite: highRisk || ranked.length > config.max_files || ranked.length >= 15 || confidence < config.min_confidence,
        reason: highRisk
          ? 'critical/high-risk task signal'
          : confidence < config.min_confidence
            ? 'context confidence below threshold'
            : ranked.length > config.max_files || ranked.length >= 15
              ? 'wide predicted change surface'
              : 'targeted verification is appropriate before the configured wider-suite checkpoint',
      },
      candidate_counts: { files: files.length, ranked_files: ranked.length, symbols: working.reduce((sum, file) => sum + file.declarations.length, 0) },
      warnings,
    };
    const promptBlock = renderCompiledContextBlock(manifest, { maxTokens: tokenBudget });
    manifest.injected_token_estimate = estimateTokens(promptBlock);
    const persistFn = deps.persistContextManifest ?? persistContextManifest;
    throwIfAborted(signal);
    manifest.manifest_path = await persistFn(manifest, { signal });
    return manifest;
  } catch (err) {
    const warn = deps.warn ?? ((message) => console.warn(message));
    warn(`[context-compiler] compile failed for ${projectName}: ${err.message}`);
    if (throwOnError) throw err;
    return null;
  }
}

function renderManifestLines(manifest, { maxFiles, maxSymbols }) {
  const lines = [
    `<compiled_context manifest_id="${manifest.manifest_id}" sha="${manifest.base_sha || 'unknown'}" confidence="${manifest.confidence}">`,
    'This is a deterministic task-scoped map, not proof of completeness. Start here; expand only when evidence requires it.',
  ];
  if (manifest.warnings?.length) lines.push(`Warnings: ${manifest.warnings.join(' | ')}`);
  if (manifest.criteria_map?.length) {
    lines.push('Acceptance mapping:');
    for (const criterion of manifest.criteria_map) {
      const production = criterion.production_symbols?.length
        ? criterion.production_symbols.map((symbol) => `${symbol.name} (${symbol.file}:${symbol.line})`).join(', ')
        : criterion.production_files?.join(', ') || '(no confident match)';
      const tests = criterion.tests?.length ? `; tests: ${criterion.tests.join(', ')}` : '';
      lines.push(`- ${criterion.criterion_id}: ${criterion.criterion} -> ${production}${tests}`);
    }
  }
  if (manifest.ranked_files?.length) {
    lines.push('Ranked files:');
    for (const file of manifest.ranked_files.slice(0, maxFiles)) {
      lines.push(`- ${file.path} [${file.kind}, score ${file.score}] — ${file.reasons.slice(0, 2).join('; ')}`);
    }
  }
  if (manifest.ranked_symbols?.length && maxSymbols > 0) {
    lines.push('Ranked symbols:');
    for (const symbol of manifest.ranked_symbols.slice(0, maxSymbols)) {
      lines.push(`- ${symbol.name} — ${symbol.file}:${symbol.line} — ${symbol.signature}`);
    }
  }
  if (manifest.test_plan?.targeted_files?.length) lines.push(`Targeted tests: ${manifest.test_plan.targeted_files.join(', ')}`);
  if (manifest.test_plan?.requires_full_suite) lines.push(`Wider suite required: ${manifest.test_plan.reason}.`);
  lines.push('For more detail call get_compiled_context with this manifest_id, query_code_symbols, or get_test_impact.');
  lines.push('</compiled_context>');
  return lines;
}

export function renderCompiledContextBlock(manifest, { maxTokens } = {}) {
  if (!manifest) return null;
  const budget = Math.max(100, Number(maxTokens) || Number(manifest.token_budget) || DEFAULT_CFG.token_budget.medium);
  let maxFiles = manifest.ranked_files?.length || 0;
  let maxSymbols = manifest.ranked_symbols?.length || 0;
  let rendered = renderManifestLines(manifest, { maxFiles, maxSymbols }).join('\n');
  while (estimateTokens(rendered) > budget && (maxSymbols > 0 || maxFiles > 3)) {
    if (maxSymbols > 0) maxSymbols -= 1;
    else maxFiles -= 1;
    rendered = renderManifestLines(manifest, { maxFiles, maxSymbols }).join('\n');
  }
  if (estimateTokens(rendered) <= budget) return rendered;
  const maxChars = budget * 4;
  const closing = '\n</compiled_context>';
  return `${rendered.slice(0, Math.max(0, maxChars - closing.length - 30))}\n[context truncated]${closing}`;
}

export function filterContextManifest(manifest, { criterionId } = {}) {
  if (!manifest) return null;
  if (!criterionId) return manifest;
  const criteria = (manifest.criteria_map || []).filter((criterion) => criterion.criterion_id === criterionId);
  const paths = new Set(criteria.flatMap((criterion) => [
    ...(criterion.production_files || []), ...(criterion.tests || []), ...(criterion.configuration || []),
  ]));
  const targetedTests = [...new Set(criteria.flatMap((criterion) => criterion.tests || []))].sort();
  return {
    ...manifest,
    criteria_map: criteria,
    ranked_files: (manifest.ranked_files || []).filter((file) => paths.has(file.path)),
    ranked_symbols: (manifest.ranked_symbols || []).filter((symbol) => paths.has(symbol.file)),
    relations: (manifest.relations || []).filter((relation) => paths.has(relation.from) || paths.has(relation.to)),
    test_plan: {
      ...(manifest.test_plan || {}),
      targeted_files: targetedTests,
      reason: targetedTests.length > 0
        ? `criterion ${criterionId}: targeted tests from compiled evidence`
        : `criterion ${criterionId}: no targeted tests identified`,
    },
  };
}
