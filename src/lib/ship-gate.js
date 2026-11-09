// Ship gate (phase-44) — a deterministic, zero-LLM promotion gate that scans
// what the agents actually wrote before any branch is fast-forwarded, before a
// project is zipped, and (read-only) inside qa-handoff.
//
// Three independent checks over the diff <baseline>..HEAD:
//   1. secret scan   — a regex bank over ADDED (+) diff lines (scanSecrets)
//   2. dependency diff — new DIRECT deps not named in the brief (warning) and
//                        disallowed licenses (blocker) via diffDependencies
//   3. npm audit     — known vulnerabilities at/above a level (auditDependencies)
//
// Design constraints (brief + project conventions):
//   - Pure Node. No LLM calls, ever.
//   - All git goes through src/lib/git.js (runGit). All non-git IO is async
//     fs/promises. The ONLY child_process here is `npm audit` — the same
//     git.js/package-project precedent for a non-claude binary.
//   - All paths via path.join.
//   - This is defense-in-depth, NOT a jail: every finding is a best-effort
//     heuristic, placeholders/env-refs are suppressed, and the whole gate has
//     an off switch (ship_gate.enabled:false) plus a per-invocation --skip-gate.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { runGit, branchExists } from './git.js';
import { guideRoot, shipGateReportPath, planJsonPath } from './guide-paths.js';
import { activeBriefPath } from './brief-manager.js';
import { addDedupedBug } from '../state.js';

// The canonical empty-tree object — `git diff <empty-tree>..HEAD` yields the
// full history as "added", the last-resort baseline when neither a target
// branch nor a phase-1 commit can anchor the diff.
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// npm audit severity ladder, ascending. `at or above <level>` = this slice
// from the level's index to the end.
export const AUDIT_LEVELS = Object.freeze(['info', 'low', 'moderate', 'high', 'critical']);

// Permissive SPDX allowlist — the same set most OSS-compliance tools ship as a
// default "green" list. Overridable via cfg.ship_gate.license_allowlist.
export const DEFAULT_LICENSE_ALLOWLIST = Object.freeze([
  'MIT', 'MIT-0', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause',
  'Apache-2.0', 'Unlicense', 'CC0-1.0', 'CC-BY-4.0', 'BlueOak-1.0.0',
  'Python-2.0', 'WTFPL', 'Zlib',
]);

// ─── Secret scan ─────────────────────────────────────────────────────────────

// One entry per secret KIND. `group` (when set) names the capture group that
// holds the secret value to redact; otherwise the whole match is the secret.
const SECRET_RULES = Object.freeze([
  { kind: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/ },
  { kind: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { kind: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: 'telegram-bot-token', re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  { kind: 'private-key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_=-]{10,}\.eyJ[A-Za-z0-9_=-]{10,}\.[A-Za-z0-9_=-]{10,}/ },
  {
    kind: 'generic-secret',
    // key-ish identifier, then `=`/`:`, then a quoted-or-bare value ≥8 chars.
    re: /\b(?:api[_-]?key|secret|token|password|passwd|access[_-]?key|client[_-]?secret)\b\s*[:=]\s*['"]?([A-Za-z0-9\/+_.=-]{8,})['"]?/i,
    group: 1,
  },
]);

// Content that marks a match as an obvious placeholder rather than a live
// secret. Checked against the matched secret AND its surrounding line.
const PLACEHOLDER_RE = /YOUR_|example|changeme|x{3,}|<[^>]*>|\$\{|placeholder|dummy|sample|fixture|redacted|\bfake\b|\btest[_-]?(?:key|token|secret|value)\b/i;

// Paths whose ADDED lines we never scan — lockfiles (huge integrity hashes look
// like secrets), minified bundles, and binary assets.
function isSkippablePath(file) {
  if (!file) return false;
  const base = path.basename(file);
  if (/^(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock|go\.sum)$/.test(base)) return true;
  if (/\.min\.(?:js|css)$/.test(base)) return true;
  if (/\.(?:png|jpe?g|gif|bmp|ico|webp|pdf|zip|gz|tgz|tar|bz2|7z|woff2?|ttf|eot|otf|mp4|mp3|mov|wav|wasm|so|dylib|dll|exe|bin|class|jar)$/i.test(base)) return true;
  return false;
}

// Redact a secret to its first 6 chars + a single-character ellipsis. Never
// echoes the full value into a report or a bug row.
function redact(secret) {
  return `${String(secret).slice(0, 6)}…`;
}

function looksLikePlaceholder(secret, line) {
  if (/process\.env/i.test(line)) return true;
  return PLACEHOLDER_RE.test(`${secret}\n${line}`);
}

/**
 * Scan a `git diff` text for hardcoded secrets. Only ADDED (`+`, not `+++`)
 * lines of non-skippable files are examined. Returns
 *   [{ kind, file, excerpt }]
 * where `excerpt` is REDACTED (first 6 chars + ellipsis) — the raw secret is
 * never retained. Placeholder values (YOUR_, example, changeme, xxx, <…>, ${…},
 * process.env, fixtures) are suppressed.
 */
export function scanSecrets(diffText) {
  const findings = [];
  const seen = new Set();
  if (!diffText) return findings;

  let currentFile = null;
  let skipFile = false;

  for (const rawLine of diffText.split('\n')) {
    // Track the current file from the diff's `+++ b/<path>` header.
    if (rawLine.startsWith('+++ ')) {
      const m = rawLine.match(/^\+\+\+ (?:b\/)?(.+)$/);
      currentFile = m ? m[1].trim() : null;
      if (currentFile === '/dev/null') currentFile = null;
      skipFile = isSkippablePath(currentFile);
      continue;
    }
    if (rawLine.startsWith('--- ') || rawLine.startsWith('diff --git') ||
        rawLine.startsWith('index ') || rawLine.startsWith('@@')) {
      continue;
    }
    // Only added lines (a single leading '+', not the '+++' header).
    if (!rawLine.startsWith('+') || rawLine.startsWith('+++')) continue;
    if (skipFile) continue;

    const line = rawLine.slice(1);
    for (const rule of SECRET_RULES) {
      const m = line.match(rule.re);
      if (!m) continue;
      const secret = rule.group != null ? m[rule.group] : m[0];
      if (!secret) continue;
      if (looksLikePlaceholder(secret, line)) continue;
      const excerpt = redact(secret);
      const key = `${currentFile || ''}|${rule.kind}|${excerpt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ kind: rule.kind, file: currentFile || null, excerpt });
    }
  }
  return findings;
}

// ─── Baseline derivation ─────────────────────────────────────────────────────

/**
 * Derive the diff baseline for the gate, with a 3-step fallback:
 *   1. `git merge-base <target> <source>` when the target branch exists —
 *      the commit develop diverged from main, so the diff is exactly what this
 *      release adds.
 *   2. the earliest `phase-1:` convention commit (git log --reverse), when
 *      there is no target branch to anchor against.
 *   3. the empty-tree hash — scan the entire history as "added".
 *
 * @returns {Promise<string>} a commit-ish usable as `<baseline>..HEAD`.
 */
export async function deriveBaseline({ workspaceDir, source = 'HEAD', target = null }) {
  const src = source || 'HEAD';
  // Step 1 — merge-base against an existing target branch.
  if (target && (await branchExists(workspaceDir, target))) {
    const mb = await runGit(workspaceDir, ['merge-base', target, src]);
    if (mb.ok && mb.stdout.trim()) return mb.stdout.trim();
  }
  // Step 2 — earliest phase-1 commit. `-E` + `^phase-1:` anchors so it never
  // matches phase-10:/phase-11: (the trailing colon guards the boundary).
  const log = await runGit(workspaceDir, ['log', '--reverse', '-E', '--grep=^phase-1:', '--format=%H']);
  if (log.ok && log.stdout.trim()) {
    return log.stdout.trim().split('\n')[0].trim();
  }
  // Step 3 — empty tree.
  return EMPTY_TREE_SHA;
}

// ─── npm audit ───────────────────────────────────────────────────────────────

/**
 * Pure classifier for `npm audit --json` output. Extracted so the
 * network/registry-failure path is unit-testable without a live registry.
 *   - unparseable stdout or an `error` field  → WARNING (never a blocker)
 *   - counts at/above `level`                 → one BLOCKER
 */
export function classifyAuditOutput({ stdout = '', stderr = '', level = 'high' }) {
  const blockers = [];
  const warnings = [];
  const idx = AUDIT_LEVELS.indexOf(level);
  const useLevel = idx === -1 ? 'high' : level;
  const useIdx = idx === -1 ? AUDIT_LEVELS.indexOf('high') : idx;

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    warnings.push({
      kind: 'audit',
      message: `npm audit returned no parseable JSON (registry/network failure?)${stderr ? `: ${stderr.slice(0, 160)}` : ''}`,
    });
    return { blockers, warnings };
  }
  if (parsed && parsed.error) {
    const e = parsed.error;
    warnings.push({
      kind: 'audit',
      message: `npm audit could not complete (${e.code || e.summary || 'error'}) — treated as a warning, not a blocker`,
    });
    return { blockers, warnings };
  }

  const vulns = (parsed && parsed.metadata && parsed.metadata.vulnerabilities) || {};
  const atOrAbove = AUDIT_LEVELS.slice(useIdx);
  let count = 0;
  for (const l of atOrAbove) count += Number(vulns[l] || 0);
  if (count > 0) {
    blockers.push({
      kind: 'audit',
      severity: 'major',
      message: `npm audit: ${count} dependency vulnerabilit${count === 1 ? 'y' : 'ies'} at or above '${useLevel}' (${atOrAbove.map((l) => `${l}=${vulns[l] || 0}`).join(', ')})`,
    });
  }
  return { blockers, warnings };
}

function runNpm(workspaceDir, args, { timeout = 120_000 } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    let proc;
    try {
      proc = spawn('npm', args, {
        cwd: workspaceDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, npm_config_audit_level: undefined },
      });
    } catch (err) {
      return resolve({ ok: false, code: -1, stdout: '', stderr: err.message });
    }
    const t = setTimeout(() => {
      done = true;
      try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      resolve({ ok: false, code: -1, stdout, stderr: `${stderr}\n[npm audit timed out]` });
    }, timeout);
    t.unref?.();
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve({ ok: false, code: -1, stdout, stderr: err.message });
    });
    proc.on('exit', (code) => {
      if (done) return;
      clearTimeout(t);
      // npm audit exits non-zero when it FINDS vulnerabilities — that's a
      // successful run, not a failure. We parse stdout regardless of code.
      resolve({ ok: true, code, stdout, stderr });
    });
  });
}

/**
 * Run `npm audit --omit=dev --json` — but only when both a package.json and a
 * lockfile exist (npm audit needs the lockfile). A registry/network failure is
 * a warning, never a blocker.
 */
export async function auditDependencies({ workspaceDir, level = 'high' }) {
  const empty = { blockers: [], warnings: [] };
  if (!(await pathExists(path.join(workspaceDir, 'package.json')))) return empty;
  const hasLock = await anyExists(workspaceDir, [
    'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  ]);
  if (!hasLock) return empty;

  const res = await runNpm(workspaceDir, ['audit', '--omit=dev', '--json']);
  if (!res.ok) {
    return {
      blockers: [],
      warnings: [{ kind: 'audit', message: `npm audit did not run (${res.stderr ? res.stderr.slice(0, 160) : `exit ${res.code}`}) — treated as a warning` }],
    };
  }
  return classifyAuditOutput({ stdout: res.stdout, stderr: res.stderr, level });
}

// ─── Dependency diff (new deps + licenses) ───────────────────────────────────

function normalizeLicense(lic) {
  return String(lic || '').trim().toUpperCase();
}

// A package.json's license may be a string, an SPDX-ish `{ type }` object, or
// the legacy `licenses: [{ type }]` array.
function extractLicense(pkg) {
  if (!pkg) return null;
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license === 'object' && pkg.license.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses) && pkg.licenses.length) {
    const first = pkg.licenses[0];
    if (typeof first === 'string') return first;
    if (first && first.type) return first.type;
  }
  return null;
}

/**
 * Diff the workspace's DIRECT dependencies against the baseline commit's
 * package.json. For each newly-added direct dep:
 *   - not named in the active brief snapshot            → WARNING (undeclared)
 *   - license (node_modules/<pkg>/package.json) not in
 *     the allowlist                                     → BLOCKER
 *   - node_modules/<pkg> missing (can't read license)   → WARNING ('unknown')
 *
 * `allowlist` defaults to DEFAULT_LICENSE_ALLOWLIST; runShipGate passes
 * cfg.ship_gate.license_allowlist.
 */
export async function diffDependencies({ workspaceDir, baseline, briefText = '', allowlist = DEFAULT_LICENSE_ALLOWLIST }) {
  const blockers = [];
  const warnings = [];

  const curPkg = await readJson(path.join(workspaceDir, 'package.json'));
  if (!curPkg) return { blockers, warnings };
  const curDeps = curPkg.dependencies && typeof curPkg.dependencies === 'object' ? curPkg.dependencies : {};

  // Baseline package.json via `git show <baseline>:package.json`. A failure
  // (baseline is empty-tree, or package.json didn't exist then) means "no prior
  // deps" — every current dep is treated as new.
  let baseDeps = {};
  if (baseline) {
    const show = await runGit(workspaceDir, ['show', `${baseline}:package.json`]);
    if (show.ok && show.stdout.trim()) {
      try {
        const basePkg = JSON.parse(show.stdout);
        if (basePkg.dependencies && typeof basePkg.dependencies === 'object') baseDeps = basePkg.dependencies;
      } catch { /* unparseable baseline package.json — treat as no prior deps */ }
    }
  }

  const newDeps = Object.keys(curDeps).filter((d) => !(d in baseDeps));
  if (!newDeps.length) return { blockers, warnings };

  const allowSet = new Set((allowlist || DEFAULT_LICENSE_ALLOWLIST).map(normalizeLicense));
  const brief = (briefText || '').toLowerCase();

  for (const dep of newDeps) {
    if (!brief.includes(dep.toLowerCase())) {
      warnings.push({ kind: 'dependency', message: `New direct dependency '${dep}' is not named in the active brief snapshot` });
    }
    const depPkg = await readJson(path.join(workspaceDir, 'node_modules', dep, 'package.json'));
    if (!depPkg) {
      warnings.push({ kind: 'license', message: `License for new dependency '${dep}' is unknown (node_modules/${dep} not installed)` });
      continue;
    }
    const lic = extractLicense(depPkg);
    if (!lic) {
      warnings.push({ kind: 'license', message: `License for new dependency '${dep}' is unknown (no license field in its package.json)` });
      continue;
    }
    if (!allowSet.has(normalizeLicense(lic))) {
      blockers.push({ kind: 'license', severity: 'major', message: `New dependency '${dep}' has disallowed license '${lic}' (not in ship_gate.license_allowlist)` });
    }
  }
  return { blockers, warnings };
}

// ─── Orchestration ───────────────────────────────────────────────────────────

async function loadBriefText(projDir) {
  let plan = null;
  const planText = await readText(planJsonPath(projDir));
  if (planText) {
    try { plan = JSON.parse(planText); } catch { /* malformed plan.json */ }
  }
  const bPath = activeBriefPath(projDir, plan);
  return (await readText(bPath)) || '';
}

function renderReport({ baseline, blockers, warnings }) {
  const lines = [];
  lines.push('# Ship gate report');
  lines.push('');
  lines.push('> Deterministic secret / dependency / license scan (phase-44). Zero-LLM.');
  lines.push('> Defense-in-depth — heuristic, not a guarantee. Placeholders and');
  lines.push('> `process.env` references are suppressed; review blockers before overriding.');
  lines.push('');
  lines.push(`- **Baseline:** \`${baseline}\``);
  lines.push(`- **Result:** ${blockers.length === 0 ? 'PASS ✓' : `BLOCKED ✗ (${blockers.length} blocker${blockers.length === 1 ? '' : 's'})`}`);
  lines.push(`- **Warnings:** ${warnings.length}`);
  lines.push('');

  lines.push('## Blockers');
  lines.push('');
  if (!blockers.length) {
    lines.push('_None._');
  } else {
    for (const b of blockers) lines.push(`- \`[${b.kind}]\` ${b.message}`);
  }
  lines.push('');

  lines.push('## Warnings');
  lines.push('');
  if (!warnings.length) {
    lines.push('_None._');
  } else {
    for (const w of warnings) lines.push(`- \`[${w.kind}]\` ${w.message}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Run the whole gate. Writes the rendered report to
 * .guide/ship-gate-report.md and inserts one deduped bug per blocker (source
 * 'ship-gate', severity critical for secrets / major for audit+license).
 *
 * @returns {Promise<{ ok, blockers, warnings, reportMd, reportPath, baseline }>}
 */
export async function runShipGate({ workspaceDir, projDir, cfg, source = 'HEAD', target = null }) {
  const sg = (cfg && cfg.ship_gate) || {};
  const level = sg.audit_level ?? 'high';
  if (!AUDIT_LEVELS.includes(level)) {
    // Name the config layer that produced the bad value (repo convention).
    throw new Error(
      `[config: ship_gate.audit_level] invalid npm audit level '${level}' — must be one of ${AUDIT_LEVELS.join(', ')}`,
    );
  }

  const baseline = await deriveBaseline({ workspaceDir, source, target });

  // Secret scan over the added lines of the whole diff.
  const diff = await runGit(workspaceDir, ['diff', `${baseline}..HEAD`]);
  const secretFindings = scanSecrets(diff.ok ? diff.stdout : '');

  const briefText = await loadBriefText(projDir);
  const depResult = await diffDependencies({
    workspaceDir, baseline, briefText,
    allowlist: Array.isArray(sg.license_allowlist) ? sg.license_allowlist : DEFAULT_LICENSE_ALLOWLIST,
  });
  const auditResult = await auditDependencies({ workspaceDir, level });

  const blockers = [];
  const warnings = [];
  for (const f of secretFindings) {
    blockers.push({ kind: 'secret', severity: 'critical', message: `Hardcoded secret (${f.kind}) in ${f.file || 'diff'}: ${f.excerpt}` });
  }
  blockers.push(...depResult.blockers, ...auditResult.blockers);
  warnings.push(...depResult.warnings, ...auditResult.warnings);

  const reportMd = renderReport({ baseline, blockers, warnings });
  await fs.mkdir(guideRoot(projDir), { recursive: true });
  const reportPath = shipGateReportPath(projDir);
  await fs.writeFile(reportPath, reportMd, 'utf-8');

  // One deduped bug per blocker, keyed against open ship-gate rows.
  const projectName = path.basename(projDir);
  for (const b of blockers) {
    try {
      addDedupedBug({ project: projectName, raw_text: b.message, severity: b.severity || 'major', source: 'ship-gate' });
    } catch { /* DB write is best-effort; the gate verdict already stands */ }
  }

  return { ok: blockers.length === 0, blockers, warnings, reportMd, reportPath, baseline };
}

// ─── Small IO helpers ────────────────────────────────────────────────────────

async function pathExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function anyExists(dir, names) {
  for (const n of names) {
    if (await pathExists(path.join(dir, n))) return true;
  }
  return false;
}

async function readText(p) {
  try { return await fs.readFile(p, 'utf-8'); } catch { return null; }
}

async function readJson(p) {
  const t = await readText(p);
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}
