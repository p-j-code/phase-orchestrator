// Validators v0.9 — runs external validator scripts after dev/fix executions.
//
// Per-project config at projects/<name>/validators.json:
// {
//   "validators": {
//     "<name>": { "script": "validators/foo.sh", "description": "...", "timeout_ms": 60000 }
//   },
//   "rules": [
//     { "match": { "phase": 5 }, "run": ["nsdl-fvu"] },
//     { "match": { "fix_title_regex": "FVU|NSDL" }, "run": ["nsdl-fvu"] },
//     { "match": { "always": true }, "run": ["lint", "tests"] }
//   ]
// }
//
// Each validator script:
// - Runs from the project directory (projects/<name>/)
// - Receives env vars: ORCHESTRATOR_PROJECT, ORCHESTRATOR_PHASE,
//   ORCHESTRATOR_FIX_ROUND, ORCHESTRATOR_FIX_N, ORCHESTRATOR_WORKSPACE_DIR
// - Exit 0 = pass, non-zero = fail
// - Stdout / stderr captured with a 1 MiB tail bound, then saved to logs/

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';

import { getDb } from '../state.js';
import { liveStatus } from './live-status.js';
import { getWorkerContext } from './worker-context.js';
import { resolveTestRunner } from './test-runner.js';
import { isTestPath, resolveTargetedTestCommand } from './context-test-cadence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');
const LOGS_DIR = path.join(REPO_ROOT, 'logs');

const EXCERPT_BYTES = 4096;
const VALIDATOR_OUTPUT_MAX_BYTES = 1024 * 1024;
const PROVIDER_CREDENTIAL_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
]);

function withoutProviderCredentials(baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const key of PROVIDER_CREDENTIAL_KEYS) delete env[key];
  return env;
}

/**
 * Validator commands are trusted project configuration, but they are not LLM
 * subprocesses. Do not hand them the parent orchestrator's provider billing
 * credentials by default. A project with an intentional live-provider
 * integration gate can opt in per validator via
 * `inherit_provider_credentials:true`.
 */
export function buildValidatorEnv({
  projectName,
  projDir,
  event = {},
  inheritProviderCredentials = false,
} = {}, baseEnv = process.env) {
  const env = inheritProviderCredentials ? { ...baseEnv } : withoutProviderCredentials(baseEnv);
  env.ORCHESTRATOR_PROJECT = projectName;
  env.ORCHESTRATOR_WORKSPACE_DIR = path.join(projDir, 'workspace');
  env.ORCHESTRATOR_PROJECT_DIR = projDir;
  if (event.phase != null) env.ORCHESTRATOR_PHASE = String(event.phase);
  if (event.fixRound != null) env.ORCHESTRATOR_FIX_ROUND = String(event.fixRound);
  if (event.fixN != null) env.ORCHESTRATOR_FIX_N = String(event.fixN);
  return env;
}

function appendBoundedOutput(current, chunk) {
  const next = current + chunk.toString();
  if (Buffer.byteLength(next) <= VALIDATOR_OUTPUT_MAX_BYTES) return next;
  const tail = Buffer.from(next).subarray(-VALIDATOR_OUTPUT_MAX_BYTES).toString();
  return `[runner] output truncated to last ${VALIDATOR_OUTPUT_MAX_BYTES} bytes\n${tail}`;
}

/** Load validators.json for a project. Returns null if absent. */
export async function loadValidatorsConfig(projectName) {
  const projDir = path.join(PROJECTS_DIR, projectName);
  const cfgPath = path.join(projDir, 'validators.json');
  try {
    const raw = await fs.readFile(cfgPath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`Failed to parse ${cfgPath}: ${err.message}`);
  }
}

/**
 * Decides which validators apply to a given event (phase completion or fix
 * completion), based on the project's validators.json rules.
 *
 * @param {object} cfg - validators.json content
 * @param {{phase?:number, phaseTitle?:string, fixRound?:number, fixN?:number, fixTitle?:string}} event
 * @returns {string[]} list of validator names (deduped) to run
 */
export function matchValidators(cfg, event) {
  if (!cfg || !cfg.rules || !cfg.validators) return [];
  const matched = new Set();
  for (const rule of cfg.rules) {
    if (!rule.match || !rule.run) continue;
    if (ruleMatches(rule.match, event)) {
      for (const n of rule.run) matched.add(n);
    }
  }
  // Filter to only validators that are actually defined
  return [...matched].filter((n) => cfg.validators[n]);
}

function normalizedCommand(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function tscCompileSignature(validator) {
  const command = normalizedCommand(validator?.command);
  if (!command || !/(?:^|\s)(?:npx\s+)?tsc(?:\s|$)/.test(command)) return null;
  return normalizedCommand(command.replace(/(?:^|\s)--noEmit(?=\s|$)/g, ' '));
}

/**
 * Remove only validators that are provably redundant in the same gate.
 * - byte-equivalent commands with equivalent execution semantics run once;
 * - an emitting `tsc` whose output is immediately deleted is dropped when the
 *   same gate already runs the equivalent `tsc --noEmit` check.
 *
 * `allow_duplicate:true` is an explicit escape hatch. This is intentionally
 * narrower than generic command "similarity" so build/smoke semantics are not
 * silently removed.
 */
export function dedupeValidatorNames(cfg, names) {
  const validators = cfg?.validators || {};
  const kept = [];
  const exact = new Set();

  for (const name of names || []) {
    const validator = validators[name] || {};
    if (validator.allow_duplicate === true) {
      kept.push(name);
      continue;
    }
    const command = normalizedCommand(validator.command);
    const exactKey = command ? JSON.stringify({
      command,
      cwd: validator.cwd || '.',
      expect_exit_code: validator.expect_exit_code ?? 0,
      blocking: validator.blocking !== false,
      fail_on_stderr: validator.fail_on_stderr === true,
      timeout_ms: validator.timeout_ms ?? null,
      cleanup_after: validator.cleanup_after || null,
      inherit_provider_credentials: validator.inherit_provider_credentials === true,
    }) : null;
    if (exactKey && exact.has(exactKey)) continue;

    // Note: an earlier revision also dropped an emitting `npx tsc` validator
    // when a same-signature `--noEmit` sibling existed. That equivalence is
    // false (`--noEmit` skips the declaration/emit pipeline, so emit-only
    // failures pass) and it silently deleted user-configured BLOCKING build
    // validators (projects/aoa). Never drop configured validators implicitly;
    // byte-identical duplicates above are the only safe dedupe.

    kept.push(name);
    if (exactKey) exact.add(exactKey);
  }
  return kept;
}

function ruleMatches(match, event) {
  if (match.always) return true;
  if (match.phase != null) {
    if (event.phase == null) return false;
    if (match.phase === 'any' && event.phase != null) return true;
    if (Number(match.phase) === Number(event.phase)) return true;
    return false;
  }
  if (match.phase_title_regex && event.phaseTitle) {
    if (new RegExp(match.phase_title_regex, 'i').test(event.phaseTitle)) return true;
  }
  if (match.fix_round != null) {
    if (event.fixRound == null) return false;
    if (match.fix_round !== 'any' && Number(match.fix_round) !== Number(event.fixRound)) return false;
    if (match.fix_n != null && Number(match.fix_n) !== Number(event.fixN)) return false;
    if (match.fix_title_regex && event.fixTitle) {
      if (!new RegExp(match.fix_title_regex, 'i').test(event.fixTitle)) return false;
    }
    return true;
  }
  if (match.fix_title_regex && event.fixTitle) {
    if (new RegExp(match.fix_title_regex, 'i').test(event.fixTitle)) return true;
  }
  return false;
}

// Legacy validator cleanup is trusted project configuration, like `command`
// itself. Run it from the project root (AOA paths are project-relative), with
// a short hard timeout, and never let cleanup failure change the validator's
// pass/fail result.
function runCleanupAfter(command, { cwd, env, timeoutMs = 30000 }) {
  if (typeof command !== 'string' || !command.trim()) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    let proc;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      resolve(error);
    };
    try {
      proc = spawn('/bin/sh', ['-c', command], { cwd, env, stdio: 'ignore', detached: true });
    } catch (err) {
      finish(err.message);
      return;
    }
    const timer = setTimeout(() => {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* already gone */ }
      finish(`cleanup timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    timer.unref?.();
    proc.on('error', (err) => { clearTimeout(timer); finish(err.message); });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      finish(code === 0 ? null : `cleanup exited ${code}`);
    });
  });
}

/** Runs a single validator script. Returns {pass, exit_code, stdout, stderr, duration_ms, validator_name}. */
async function runOne({ projectName, validatorName, validatorCfg, event, defaultTimeoutMs }) {
  const projDir = path.join(PROJECTS_DIR, projectName);
  const hasCommand = typeof validatorCfg.command === 'string' && validatorCfg.command.trim();
  const scriptPath = validatorCfg.script
    ? (path.isAbsolute(validatorCfg.script) ? validatorCfg.script : path.join(projDir, validatorCfg.script))
    : null;

  if (!hasCommand && (!scriptPath || !fsSync.existsSync(scriptPath))) {
    return {
      validator_name: validatorName,
      pass: false,
      exit_code: -1,
      stdout: '',
      stderr: `validator script not found: ${scriptPath || '(no script or command configured)'}`,
      duration_ms: 0,
      error: 'script_not_found',
      blocking: validatorCfg.blocking !== false,
    };
  }

  const timeoutMs = validatorCfg.timeout_ms || defaultTimeoutMs;
  const env = buildValidatorEnv({
    projectName,
    projDir,
    event,
    inheritProviderCredentials: validatorCfg.inherit_provider_credentials === true,
  });

  const start = Date.now();
  const requestedCwd = path.resolve(projDir, validatorCfg.cwd || '.');
  const commandCwd = requestedCwd === projDir || requestedCwd.startsWith(`${projDir}${path.sep}`) ? requestedCwd : projDir;
  const isJs = scriptPath && (scriptPath.endsWith('.js') || scriptPath.endsWith('.mjs'));
  const { cmd, args, cwd } = hasCommand
    ? { cmd: '/bin/sh', args: ['-c', validatorCfg.command], cwd: commandCwd }
    : isJs
      ? { ...(await resolveTestRunner(scriptPath, projDir)), cwd: projDir }
      : { cmd: scriptPath, args: [], cwd: projDir };

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;
    let settled = false;
    let finishing = false;
    const finishAfterCleanup = async (value) => {
      if (settled || finishing) return;
      finishing = true;
      const cleanupError = await runCleanupAfter(validatorCfg.cleanup_after, { cwd: projDir, env });
      if (cleanupError) {
        value.stderr = `${value.stderr || ''}${value.stderr ? '\n' : ''}[runner] cleanup_after warning: ${cleanupError}`;
      }
      settled = true;
      finishing = false;
      resolve(value);
    };
    let proc;
    try {
      proc = spawn(cmd, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true, // makes the validator the process group leader so we can kill descendants
      });
    } catch (err) {
      void finishAfterCleanup({
        validator_name: validatorName,
        pass: false,
        exit_code: -1,
        stdout: '',
        stderr: `failed to spawn: ${err.message}`,
        duration_ms: 0,
        error: 'spawn_failed',
        blocking: validatorCfg.blocking !== false,
      });
      return;
    }

    const timer = setTimeout(() => {
      killed = true;
      try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* setsid race — retry coming */ }
      setTimeout(() => {
        try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* already dead */ }
      }, 100).unref?.();
      setTimeout(() => {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* already dead */ }
      }, 3000).unref?.();
    }, timeoutMs);
    timer.unref?.();

    proc.stdout.on('data', (d) => { stdout = appendBoundedOutput(stdout, d); });
    proc.stderr.on('data', (d) => { stderr = appendBoundedOutput(stderr, d); });

    proc.on('error', (err) => {
      clearTimeout(timer);
      void finishAfterCleanup({
        validator_name: validatorName,
        pass: false,
        exit_code: -1,
        stdout,
        stderr: stderr + `\n[runner] spawn error: ${err.message}`,
        duration_ms: Date.now() - start,
        error: 'spawn_error',
        blocking: validatorCfg.blocking !== false,
      });
    });

    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (settled) return;
      const duration_ms = Date.now() - start;
      if (killed) {
        void finishAfterCleanup({
          validator_name: validatorName,
          pass: false,
          exit_code: -1,
          stdout,
          stderr: stderr + `\n[runner] killed after ${timeoutMs}ms timeout`,
          duration_ms,
          error: 'timeout',
          blocking: validatorCfg.blocking !== false,
        });
      } else {
        const expectedCode = Number.isInteger(validatorCfg.expect_exit_code) ? validatorCfg.expect_exit_code : 0;
        const pass = code === expectedCode && !(validatorCfg.fail_on_stderr === true && stderr.trim());
        void finishAfterCleanup({
          validator_name: validatorName,
          pass,
          exit_code: code,
          stdout,
          stderr,
          duration_ms,
          blocking: validatorCfg.blocking !== false,
        });
      }
    });
  });
}

/**
 * Merge in-code (programmatic) synthetic rules/validators onto a project's
 * loaded validators.json, WITHOUT touching that file on disk (Phase 81 / P4a).
 *
 * The test-first harness (P4b) uses this to run an AUTHORED test file as a
 * one-off validator: it passes `extraValidators` mapping a synthetic name → the
 * test file's script spec, and `extraRules` = a rule that runs that name. A rule
 * referencing an undefined validator is filtered out by matchValidators, so the
 * companion `extraValidators` is what lets the injected rule actually
 * participate. Returns the effective cfg, or null only when there is nothing to
 * run (no validators.json AND no injected rules).
 *
 * @param {object|null} loaded - validators.json content (or null when absent)
 * @param {{extraRules?: Array, extraValidators?: object}} injected
 * @returns {{validators: object, rules: Array}|null}
 */
export function buildEffectiveValidatorConfig(loaded, { extraRules = [], extraValidators = {} } = {}) {
  const rules = Array.isArray(extraRules) ? extraRules : [];
  if (!loaded && rules.length === 0) return null;
  const legacy = Array.isArray(loaded?.validators);
  const loadedValidators = legacy
    ? Object.fromEntries(loaded.validators.filter((validator) => validator?.id).map((validator) => [validator.id, validator]))
    : (loaded?.validators || {});
  const loadedRules = Array.isArray(loaded?.rules)
    ? loaded.rules
    : legacy && Object.keys(loadedValidators).length
      ? [{ match: { always: true }, run: Object.keys(loadedValidators) }]
      : [];
  return {
    ...(loaded || {}),
    _legacy_array: legacy,
    validators: { ...loadedValidators, ...(extraValidators || {}) },
    rules: [...loadedRules, ...rules],
  };
}

/**
 * Runs all matching validators for a given event. Stores each run in
 * validator_runs. Persists full output to logs/. Returns array of results.
 *
 * @param {object} opts
 * @param {string} opts.projectName
 * @param {{phase?, phaseTitle?, fixRound?, fixN?, fixTitle?}} opts.event
 * @param {boolean} [opts.silent] - suppress terminal output
 * @param {Array}  [opts.extraRules] - Phase 81 (P4a): synthetic {match, run} rules
 *   injected in-code (never written to validators.json). Merged onto the loaded
 *   rules before matching, so an injected rule participates in the gate exactly
 *   like a configured one.
 * @param {object} [opts.extraValidators] - companion synthetic validator defs
 *   (name → { script, timeout_ms }) the injected rules reference.
 * @returns {Promise<{results, allPassed, hasFailures}>}
 */
export async function runValidators({ projectName, event, silent = false, defaultTimeoutMs = 60000, extraRules = [], extraValidators = {} }) {
  const loaded = await loadValidatorsConfig(projectName);
  const cfg = buildEffectiveValidatorConfig(loaded, { extraRules, extraValidators });
  if (!cfg) return { results: [], allPassed: true, hasFailures: false, skipped: 'no validators.json' };

  const matchedNames = matchValidators(cfg, event);
  const names = dedupeValidatorNames(cfg, matchedNames);
  const optimizedOut = matchedNames.filter((name) => !names.includes(name));
  if (names.length === 0) return { results: [], allPassed: true, hasFailures: false, skipped: 'no matching rules' };

  fsSync.mkdirSync(LOGS_DIR, { recursive: true });

  if (!silent) {
    const eventLabel = event.phase != null
      ? `phase ${event.phase}`
      : event.fixRound != null ? `fix r${event.fixRound}.${event.fixN}` : '?';
    console.log(chalk.cyan(`\n▸ Running ${names.length} validator(s) for ${eventLabel}…`));
    if (optimizedOut.length) {
      console.log(chalk.dim(`  → Skipped redundant validator execution: ${optimizedOut.join(', ')}`));
    }
  }

  const results = await Promise.all(names.map(async (validatorName) => {
    const validatorCfg = cfg.validators[validatorName];

    // v0.14.9: live-status replaces per-validator ora. Same concurrency
    // bug as runClaude — under cross-project worker concurrency two ora
    // instances clobber each other's line. Key by worker + validator so
    // validators running in parallel still get distinct stable rows.
    const startedMs = Date.now();
    const ctx = getWorkerContext();
    const liveKey = `w${ctx?.workerId ?? 'cli'}:validator:${projectName}:${validatorName}:${startedMs}`;
    const noSpinner = silent || process.env.ORCHESTRATOR_NO_SPINNER === '1' || !process.stdout.isTTY;
    if (!noSpinner) {
      liveStatus.set(liveKey, {
        workerId: ctx?.workerId ?? '?',
        project: ctx?.project ?? projectName ?? '?',
        task: `validator:${validatorName}`,
        startedAt: startedMs,
        state: 'running',
      });
    } else if (!silent) {
      console.log(chalk.dim(`▸ ${validatorName} starting…`));
    }

    const startedAt = new Date().toISOString();
    const result = await runOne({ projectName, validatorName, validatorCfg, event, defaultTimeoutMs });
    const endedAt = new Date().toISOString();

    // Persist full output to logs. Sanitize the config-supplied name — an id
    // like 'lint/js' would resolve into a nonexistent subdirectory and lose
    // the full log exactly when a long failure needs it.
    const safeName = String(validatorName).replace(/[^\w.-]/g, '_');
    const logBase = path.join(LOGS_DIR, `validator-${projectName}-${safeName}-${Date.now()}`);
    try {
      await fs.writeFile(`${logBase}.stdout.log`, result.stdout || '');
      await fs.writeFile(`${logBase}.stderr.log`, result.stderr || '');
    } catch (err) {
      console.warn(`  [validator] best-effort log write failed for ${validatorName}: ${err.message}`);
    }

    // Persist truncated excerpts to DB
    const stdoutExcerpt = (result.stdout || '').slice(-EXCERPT_BYTES);
    const stderrExcerpt = (result.stderr || '').slice(-EXCERPT_BYTES);

    try {
      getDb().prepare(
        `INSERT INTO validator_runs
         (project, phase, fix_round, fix_n, validator_name, started_at, ended_at, duration_ms,
          exit_code, status, stdout_excerpt, stderr_excerpt, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        projectName,
        event.phase ?? null,
        event.fixRound ?? null,
        event.fixN ?? null,
        validatorName,
        startedAt,
        endedAt,
        result.duration_ms,
        result.exit_code,
        result.pass ? 'pass' : 'fail',
        stdoutExcerpt,
        stderrExcerpt,
        result.error || null,
      );
    } catch (err) {
      // DB issue shouldn't sink the validation; log and continue
      if (!silent) console.error(chalk.dim(`(could not record validator_runs row: ${err.message})`));
    }

    if (!silent) {
      liveStatus.delete(liveKey);
      const durStr = `${(result.duration_ms / 1000).toFixed(1)}s`;
      if (result.pass) {
        console.log(chalk.green(`✓ ${validatorName} pass (${durStr})`));
      } else {
        console.log(chalk.red(`✗ ${validatorName} FAIL (exit ${result.exit_code}, ${durStr})`));
        // Show last few lines of stderr inline
        const stderrTail = (result.stderr || '').trim().split('\n').slice(-8).join('\n');
        if (stderrTail) console.log(chalk.dim('  ' + stderrTail.split('\n').join('\n  ')));
        const stdoutTail = (result.stdout || '').trim().split('\n').slice(-4).join('\n');
        if (stdoutTail) console.log(chalk.dim('  [stdout] ' + stdoutTail.split('\n').join('\n  [stdout] ')));
      }
    }

    return result;
  }));

  const blockingResults = results.filter((r) => r.blocking !== false);
  const allPassed = blockingResults.every((r) => r.pass);
  const hasFailures = blockingResults.some((r) => !r.pass);
  return { results, allPassed, hasFailures, legacy_config: cfg._legacy_array === true, optimized_out: optimizedOut };
}

/** Lookup helper for the validate CLI / Telegram. */
export function getRecentValidatorRuns(projectName, limit = 20) {
  return getDb().prepare(
    `SELECT * FROM validator_runs WHERE project = ? ORDER BY started_at DESC LIMIT ?`,
  ).all(projectName, limit);
}

// ─── v0.14.35: default validator gate ────────────────────────────────────────
//
// Hard gate that runs INSIDE runDev — after the dev agent commits, BEFORE the
// phase is marked complete and pushed. Projects with a validators.json keep
// their configured chain; projects without one (or with no matching rules)
// fall back to a built-in default:
//
//   1. `npm test` in workspace/ — IF package.json has a real test script
//      (the npm-init placeholder `echo "Error: no test specified" && exit 1`
//      does not count).
//   2. otherwise `node --check` on every changed .js/.mjs/.cjs file — cheap,
//      deterministic, and never blocks a project for *lacking* tests; it only
//      blocks committed syntax errors.
//
// Opt-outs: validators.enabled:false (kills everything, pre-existing) or the
// new validators.default_gate:false (keeps configured validators.json chains
// but disables the built-in fallback).

const NPM_PLACEHOLDER_TEST_RE = /echo .{0,4}Error: no test specified/i;

/** Does workspace/package.json declare a real (non-placeholder) test script? */
export async function hasRealTestScript(workspaceDir) {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(workspaceDir, 'package.json'), 'utf-8'));
    const t = pkg?.scripts?.test;
    return Boolean(t && !NPM_PLACEHOLDER_TEST_RE.test(t));
  } catch {
    return false;
  }
}

async function readPackageWithRealTest(workspaceDir) {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(workspaceDir, 'package.json'), 'utf-8'));
    const script = pkg?.scripts?.test;
    return script && !NPM_PLACEHOLDER_TEST_RE.test(script) ? pkg : null;
  } catch {
    return null;
  }
}

async function safeExistingTestFiles(workspaceDir, candidates) {
  let realWorkspace;
  try { realWorkspace = await fs.realpath(workspaceDir); } catch { return []; }
  const prefix = `${realWorkspace}${path.sep}`;
  const safe = [];
  // The cap bounds the RESULT, not the candidate list: relatedTestCandidates
  // generates ~48-60 sorted stems and the tests/-mirror layouts sort past
  // index 25, so a pre-existence slice made mirror discovery permanently
  // unreachable. Existence checks are cheap lstat calls — examine them all.
  for (const relative of (Array.isArray(candidates) ? candidates : [])) {
    if (safe.length >= 25) break;
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) continue;
    const absolute = path.resolve(workspaceDir, relative);
    if (absolute !== workspaceDir && !absolute.startsWith(`${path.resolve(workspaceDir)}${path.sep}`)) continue;
    try {
      const real = await fs.realpath(absolute);
      const stat = await fs.stat(real);
      if (stat.isFile() && real.startsWith(prefix)) safe.push(relative.replaceAll('\\', '/'));
    } catch { /* stale compiler prediction — ignore and fall back below */ }
  }
  return [...new Set(safe)].sort();
}

const SOURCE_FILE_RE = /\.(?:[cm]?js|jsx|ts|tsx)$/i;
const DOC_ONLY_RE = /(?:^|\/)(?:docs?|documentation)(?:\/|$)|\.(?:md|mdx|txt|rst)$/i;

function safeRelativePath(value) {
  const file = String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
  return file && !file.startsWith('/') && !file.startsWith('-') && !file.split('/').includes('..') ? file : null;
}

/** Pure candidate generator; existence/symlink safety is checked separately. */
export function relatedTestCandidates(sourceFile) {
  const source = safeRelativePath(sourceFile);
  if (!source || !SOURCE_FILE_RE.test(source) || isTestPath(source)) return [];
  const parsed = path.posix.parse(source);
  const extensions = [...new Set([parsed.ext, '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])];
  const stems = new Set();
  for (const ext of extensions) {
    stems.add(path.posix.join(parsed.dir, `${parsed.name}.test${ext}`));
    stems.add(path.posix.join(parsed.dir, `${parsed.name}.spec${ext}`));
    stems.add(path.posix.join(parsed.dir, '__tests__', `${parsed.name}.test${ext}`));
    stems.add(path.posix.join('tests', `${parsed.name}.test${ext}`));
    stems.add(path.posix.join('test', `${parsed.name}.test${ext}`));
    stems.add(path.posix.join('tests', parsed.dir, `${parsed.name}.test${ext}`));

    const segments = parsed.dir.split('/');
    const srcIndex = segments.lastIndexOf('src');
    if (srcIndex >= 0) {
      for (const testDir of ['test', 'tests']) {
        const mirrored = [...segments];
        mirrored[srcIndex] = testDir;
        stems.add(path.posix.join(...mirrored, `${parsed.name}.test${ext}`));
        stems.add(path.posix.join(...mirrored, `${parsed.name}.spec${ext}`));
      }
    }
  }
  return [...stems].filter(Boolean).sort();
}

/**
 * Conservative no-LLM mapping for routine phases. Every changed production
 * source must have at least one existing counterpart; any config/schema/other
 * non-doc path forces the full suite. This makes a wrong narrow guess degrade
 * to historical behavior instead of omitting coverage.
 */
export async function discoverRelatedTestFiles({ workspaceDir, changedFiles, seedTestFiles = [] }) {
  const changed = [...new Set((changedFiles || []).map(safeRelativePath).filter(Boolean))].sort();
  // Classification precedence matters: a test path or source-extension file is
  // NEVER doc-only, even under a docs/ directory or with a fixture .txt sibling
  // pattern — DOC_ONLY_RE alone would classify docs/build.js and
  // test/fixtures/expected.txt as documentation and skip the entire gate.
  const isDocOnly = (file) => DOC_ONLY_RE.test(file) && !isTestPath(file) && !SOURCE_FILE_RE.test(file);
  const docs = changed.filter(isDocOnly);
  const tests = changed.filter(isTestPath);
  const sources = changed.filter((file) => SOURCE_FILE_RE.test(file) && !isTestPath(file));
  const unsupported = changed.filter((file) => !isDocOnly(file) && !isTestPath(file) && !SOURCE_FILE_RE.test(file));

  if (changed.length > 0 && docs.length === changed.length) {
    return { scope: 'skip', test_files: [], reason: 'documentation-only phase' };
  }
  if (unsupported.length > 0) {
    return { scope: 'full', test_files: [], reason: `non-source/config paths require full suite: ${unsupported.slice(0, 5).join(', ')}` };
  }

  const selected = new Set(await safeExistingTestFiles(workspaceDir, [...seedTestFiles, ...tests]));
  for (const source of sources) {
    const matches = await safeExistingTestFiles(workspaceDir, relatedTestCandidates(source));
    if (matches.length === 0) {
      return { scope: 'full', test_files: [], reason: `no safe direct test mapping for ${source}` };
    }
    for (const match of matches) selected.add(match);
  }
  if (!selected.size) {
    return { scope: 'full', test_files: [], reason: 'no safe directly related test files found' };
  }
  return { scope: 'targeted', test_files: [...selected].sort().slice(0, 25), reason: 'all changed source files mapped to existing direct tests' };
}

function scriptContainsDirectNodeTarget(scripts, file) {
  if (!/\.(?:mjs|cjs|js)$/i.test(file)) return false;
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|&&|;)\\s*node(?:\\s+--[^\\s]+)*\\s+["']?${escaped}["']?(?:\\s|&&|;|$)`);
  return Object.entries(scripts || {})
    .filter(([name]) => name.startsWith('test'))
    .some(([, script]) => re.test(String(script || '')));
}

function targetedCommandsForPackage(pkg, testFiles) {
  const direct = resolveTargetedTestCommand(pkg?.scripts?.test, testFiles);
  if (direct) return [direct];
  if (!testFiles.length || !testFiles.every((file) => scriptContainsDirectNodeTarget(pkg?.scripts, file))) return [];
  const commands = [];
  if (pkg.scripts?.build) commands.push({ cmd: 'npm', args: ['run', 'build', '--silent'], kind: 'targeted-prebuild' });
  else if (pkg.scripts?.typecheck) commands.push({ cmd: 'npm', args: ['run', 'typecheck', '--silent'], kind: 'targeted-typecheck' });
  for (const file of testFiles) commands.push({ cmd: process.execPath, args: [file], kind: 'direct-node-test' });
  return commands;
}

/** Spawn one default-gate command. Same result shape as runOne. */
function runGateCommand({ name, cmd, args, cwd, timeoutMs }) {
  const start = Date.now();
  return new Promise((resolveP) => {
    let stdout = '';
    let stderr = '';
    let killed = false;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolveP(value);
    };
    let proc;
    try {
      // The built-in npm/node gate is project code just like a configured
      // validator. Do not let an ordinary test suite accidentally consume
      // provider credits inherited from the orchestrator process.
      proc = spawn(cmd, args, { cwd, env: withoutProviderCredentials(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (err) {
      return finish({ validator_name: name, pass: false, exit_code: -1, stdout: '', stderr: `failed to spawn: ${err.message}`, duration_ms: 0, error: 'spawn_failed' });
    }
    const timer = setTimeout(() => {
      killed = true;
      try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* setsid race */ }
      setTimeout(() => { try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* dead */ } }, 3000).unref?.();
    }, timeoutMs);
    timer.unref?.();
    proc.stdout.on('data', (d) => { stdout = appendBoundedOutput(stdout, d); });
    proc.stderr.on('data', (d) => { stderr = appendBoundedOutput(stderr, d); });
    proc.on('error', (err) => {
      clearTimeout(timer);
      finish({ validator_name: name, pass: false, exit_code: -1, stdout, stderr: stderr + `\n[gate] spawn error: ${err.message}`, duration_ms: Date.now() - start, error: 'spawn_error' });
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (settled) return;
      const duration_ms = Date.now() - start;
      if (killed) {
        return finish({ validator_name: name, pass: false, exit_code: -1, stdout, stderr: stderr + `\n[gate] killed after ${timeoutMs}ms timeout`, duration_ms, error: 'timeout' });
      }
      finish({ validator_name: name, pass: code === 0, exit_code: code, stdout, stderr, duration_ms });
    });
  });
}

/**
 * Run the built-in default gate. Returns the runValidators outcome shape:
 * { results, allPassed, hasFailures, skipped? } plus gate:'default'.
 *
 * @param {object} o
 * @param {string}   o.workspaceDir   absolute path to workspace/
 * @param {string[]} o.changedFiles   workspace-relative paths changed by the phase/fix
 * @param {number}  [o.testTimeoutMs=180000]   timeout for npm test
 * @param {number}  [o.checkTimeoutMs=30000]   timeout per node --check
 */
export async function runDefaultGate({ workspaceDir, changedFiles = [], testTimeoutMs = 180000, checkTimeoutMs = 30000, testPlan = null }) {
  const pkg = await readPackageWithRealTest(workspaceDir);
  if (pkg) {
    let effectivePlan = testPlan;
    if (testPlan?.scope === 'candidate') {
      const discovery = await discoverRelatedTestFiles({
        workspaceDir,
        changedFiles: Array.isArray(testPlan.changed_files) ? testPlan.changed_files : changedFiles,
        seedTestFiles: testPlan.test_files,
      });
      if (discovery.scope === 'skip') {
        console.log(chalk.dim('▸ Default gate: documentation-only phase — test suite skipped; next checkpoint still runs full.'));
        return {
          results: [], allPassed: true, hasFailures: false, gate: 'default',
          skipped: discovery.reason, test_scope: 'skipped', test_files: [], test_scope_reason: discovery.reason,
        };
      }
      effectivePlan = discovery.scope === 'targeted'
        ? { ...testPlan, scope: 'targeted', test_files: discovery.test_files, reason: `${testPlan.reason}; ${discovery.reason}` }
        : { ...testPlan, scope: 'full', test_files: [], reason: `${testPlan.reason}; ${discovery.reason}` };
    }
    const requested = effectivePlan?.scope === 'targeted' && Array.isArray(effectivePlan.test_files)
      ? [...new Set(effectivePlan.test_files)]
      : [];
    const predicted = requested.length ? await safeExistingTestFiles(workspaceDir, requested) : [];
    const allTargetsSafe = requested.length > 0 && predicted.length === requested.length;
    const targetedCommands = allTargetsSafe ? targetedCommandsForPackage(pkg, predicted) : [];
    const targeted = targetedCommands.length > 0;
    const useFullScript = !targeted && effectivePlan?.compiler_managed === true && pkg.scripts?.['test:full'];
    const commands = targeted
      ? targetedCommands
      : [{ cmd: 'npm', args: useFullScript ? ['run', 'test:full', '--silent'] : ['test', '--silent'], kind: useFullScript ? 'full-script' : 'historical-test' }];
    console.log(chalk.cyan(targeted
      ? `▸ Default gate: targeted tests (${predicted.length} safely mapped file(s), ${commands.length} command(s))…`
      : `▸ Default gate: ${useFullScript ? 'npm run test:full' : 'npm test'} (full suite${effectivePlan?.reason ? ` — ${effectivePlan.reason}` : ''})…`));
    const results = [];
    for (let index = 0; index < commands.length; index += 1) {
      const command = commands[index];
      const r = await runGateCommand({
        name: targeted ? `default:targeted:${command.kind}:${index + 1}` : useFullScript ? 'default:npm-test-full' : 'default:npm-test',
        cmd: command.cmd, args: command.args, cwd: workspaceDir, timeoutMs: testTimeoutMs,
      });
      results.push(r);
      if (!r.pass) break;
    }
    const hasFailures = results.some((result) => !result.pass);
    const duration = results.reduce((sum, result) => sum + result.duration_ms, 0);
    if (!hasFailures) console.log(chalk.green(`✓ default:${targeted ? 'targeted-tests' : 'npm-test'} pass (${(duration / 1000).toFixed(1)}s)`));
    else console.log(chalk.red(`✗ default:${targeted ? 'targeted-tests' : 'npm-test'} FAIL`));
    return {
      results, allPassed: !hasFailures, hasFailures, gate: 'default',
      test_scope: targeted ? 'targeted' : 'full', test_files: targeted ? predicted : [],
      test_scope_reason: targeted ? effectivePlan?.reason || null : effectivePlan?.reason
        || (!allTargetsSafe && requested.length ? 'one or more targeted test paths were missing or unsafe' : null)
        || (predicted.length ? 'test script does not support safe targeted execution' : null),
    };
  }

  const jsFiles = changedFiles.filter((f) => /\.(mjs|cjs|js)$/.test(f))
    .filter((f) => fsSync.existsSync(path.join(workspaceDir, f))); // skip deleted
  if (jsFiles.length === 0) {
    return { results: [], allPassed: true, hasFailures: false, skipped: 'no test script, no changed JS files', gate: 'default' };
  }
  console.log(chalk.cyan(`▸ Default gate: node --check on ${jsFiles.length} changed JS file(s)…`));
  const results = [];
  for (const f of jsFiles) {
    results.push(await runGateCommand({
      name: `default:node-check:${f}`,
      cmd: process.execPath,
      args: ['--check', path.join(workspaceDir, f)],
      cwd: workspaceDir,
      timeoutMs: checkTimeoutMs,
    }));
  }
  const hasFailures = results.some((r) => !r.pass);
  const failedNames = results.filter((r) => !r.pass).map((r) => r.validator_name.replace('default:node-check:', ''));
  if (hasFailures) console.log(chalk.red(`✗ default:node-check FAIL: ${failedNames.join(', ')}`));
  else console.log(chalk.green(`✓ default:node-check pass (${jsFiles.length} file(s))`));
  return { results, allPassed: !hasFailures, hasFailures, gate: 'default' };
}

/**
 * The full hard-gate: configured validators first; if they were SKIPPED
 * (no validators.json / no matching rules) and the default gate is enabled,
 * run the built-in fallback. Configured-chain results are authoritative when
 * they ran — the default never stacks on top of them.
 *
 * Phase 82 (test-first P4b): `extraRules`/`extraValidators` inject a synthetic
 * rule + validator in-code (never written to validators.json) — the test-first
 * harness passes the authored acceptance test here so the dev is gated on it
 * exactly like a configured validator. When they are present, the effective
 * config is never "skipped" (buildEffectiveValidatorConfig always returns a
 * cfg), so the built-in default gate does not also run — the authored test IS
 * the gate for a test-first phase.
 */
export async function runValidatorGate({ projectName, workspaceDir, event, changedFiles = [], cfg = {}, extraRules = [], extraValidators = {}, testPlan = null }) {
  const vcfg = cfg.validators || {};
  if (vcfg.enabled === false) return { results: [], allPassed: true, hasFailures: false, skipped: 'validators disabled', gate: 'off' };

  const configured = await runValidators({
    projectName,
    event,
    defaultTimeoutMs: vcfg.default_timeout_ms ?? 60000,
    extraRules,
    extraValidators,
  });
  if (!configured.skipped && !configured.legacy_config) return { ...configured, gate: 'configured' };

  // Legacy array/command configs historically fell through to the built-in
  // npm gate because the old runner could not match them. After normalizing
  // and executing those safety checks, keep the test gate as well so fixing
  // the compatibility bug never removes the project's existing test coverage.
  if (!configured.skipped && configured.legacy_config) {
    // Do not immediately repeat a known blocking failure through npm test.
    // The mechanical repair needs the first, precise validator output; a
    // redundant full gate here only delays it and burns more CI/agent time.
    if (configured.hasFailures) return { ...configured, gate: 'configured' };
    // The documented opt-out applies to legacy configs too — without this
    // check the flag below is unreachable for them and the extra full npm
    // test runs on every phase/fix regardless of configuration.
    if (vcfg.default_gate === false) return { ...configured, gate: 'configured' };
    const fallback = await runDefaultGate({
      workspaceDir, changedFiles,
      testTimeoutMs: vcfg.default_test_timeout_ms ?? 180000,
      checkTimeoutMs: vcfg.default_check_timeout_ms ?? 30000,
      testPlan,
    });
    const results = [...(configured.results || []), ...(fallback.results || [])];
    const hasFailures = configured.hasFailures || fallback.hasFailures;
    return {
      results, allPassed: !hasFailures, hasFailures, gate: 'configured+default',
      test_scope: fallback.test_scope, test_files: fallback.test_files,
      test_scope_reason: fallback.test_scope_reason, legacy_config: true,
    };
  }

  if (vcfg.default_gate === false) return { ...configured, gate: 'configured' };
  return runDefaultGate({
    workspaceDir,
    changedFiles,
    testTimeoutMs: vcfg.default_test_timeout_ms ?? 180000,
    checkTimeoutMs: vcfg.default_check_timeout_ms ?? 30000,
    testPlan,
  });
}

/** Concatenated failure output for the mechanical-retry prompt, truncated. */
export function gateFailureExcerpt(outcome, maxChars = 4000) {
  const parts = [];
  for (const r of (outcome?.results || [])) {
    if (r.pass) continue;
    // Advisory (non-blocking) failures don't gate the phase — including them
    // steers the single mechanical retry ("fix EXACTLY what this output
    // indicates") at output that cannot unblock anything.
    if (r.blocking === false) continue;
    parts.push(`── ${r.validator_name} (exit ${r.exit_code}) ──`);
    const body = [(r.stderr || '').trim(), (r.stdout || '').trim()].filter(Boolean).join('\n');
    parts.push(body || '(no output)');
  }
  const joined = parts.join('\n');
  return joined.length > maxChars ? joined.slice(-maxChars) : joined;
}
