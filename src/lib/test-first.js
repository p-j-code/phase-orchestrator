// Test-first harness (Phase 81 P4a plumbing + Phase 82 P4b orchestration,
// blueprint QL-3 weakened).
//
// The opt-in test-first harness authors a FAILING (red) test BEFORE the dev
// agent runs, so the phase's acceptance is anchored to an executable check
// rather than only the dev's own report. This module holds:
//
//   - isTestFirstActive() — the default-OFF gate (config.test_first.enabled +
//     the per-phase plan.test_first kill switch). Phases only; never fixes.
//   - isJsWorkspace()     — non-JS skip detection. A workspace with no
//     package.json and no JS/TS sources is NOT a JS stack; the harness skips it
//     with a dim log and NEVER fails a phase for lacking a JS test runner.
//   - redCheck()          — run an authored test file via resolveTestRunner and
//     report pass/fail from the exit code (exit 0 = green, non-zero = red). The
//     spawn is behind an injectable seam so tests make ZERO real spawns.
//   - runTestFirstPreDev()— the pre-dev seam phase-runner calls. P4b wires the
//     full flow: author spawn (roleless, Write but NO Bash) → manifest via P1's
//     reply contract → RED gate (a green-before-dev file is vacuous, deleted,
//     LLM-checked) → the orchestrator commits the red test itself (the author
//     has no Bash), returning the synthetic validator rule + covered list +
//     post-test SHA the phase-runner wires into the gate / checker / preSha
//     re-read. Every failure is fail-open: it degrades to LLM-checked, never
//     fails the phase on the harness's own limitation.
//
// Author spawn = a clone of the acceptance checker's spawn (role:null,
// sessionId:null, cwd=workspaceDir) so it never touches guide_session_id /
// last_dev_session_id — the ONLY difference is Write is allowed (the author
// writes exactly one test file) and Bash is not.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';

import { runClaude } from '../claude-runner.js';
import { runWithContract } from './llm-contract.js';
import { commitAll } from './git.js';
import { resolveTestRunner } from './test-runner.js';

const JS_TS_RE = /\.(mjs|cjs|jsx?|tsx?)$/;
const MAX_SCAN_DEPTH = 4;

// The authored test runs as a one-off synthetic validator injected in-code via
// runValidators' extraRules (never written to validators.json). Underscored so
// it can never collide with a real, operator-authored validator name.
export const TEST_FIRST_VALIDATOR_NAME = '__test_first_redcheck__';

// Tool sandbox for the acceptance-test author: read tools + Write (exactly one
// test file), NO Bash, NO Edit. Frozen so a caller's cfg clone can spread it
// without risk of mutation — same discipline as verify-loop's CHECKER_ALLOWED_TOOLS.
export const TEST_AUTHOR_ALLOWED_TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'Write']);

// Static system-prompt addendum for the author — byte-identical across every
// call by construction (no interpolation), satisfying the P1 cache-discipline
// rule for systemPromptExtra. All volatile per-phase context rides the user
// prompt (buildTestAuthorPrompt).
export const TEST_AUTHOR_SYSTEM_PROMPT =
  `You are the Ashmero Orchestrator's acceptance-test author. You run ONCE per phase, ` +
  `BEFORE the implementer writes any code, to author a FAILING (red) acceptance test that ` +
  `encodes the phase's acceptance criteria as executable checks. You may Read, Glob, and ` +
  `Grep the workspace and Write exactly one test file; you have no Bash and no Edit tool, ` +
  `so you cannot run commands, run the test, or commit. You do NOT implement the feature — ` +
  `a test that already passes is useless. Your final reply is a single JSON manifest object ` +
  `and nothing else.`;

// The author's reply contract (P1 reply seam): which criteria the test file
// actually covers. 1-based indices into the phase's acceptance_criteria list.
const MANIFEST_SCHEMA = {
  type: 'object',
  required: ['covered', 'uncovered'],
  properties: {
    covered: { type: 'array', items: { type: 'integer', minimum: 1 } },
    uncovered: { type: 'array', items: { type: 'integer', minimum: 1 } },
  },
};

/**
 * Is the opt-in test-first harness active for THIS run?
 *
 * Default OFF: false unless config.test_first.enabled === true. Phases only —
 * fixes and single-call fix batches never run test-first (they keep today's
 * inline behavior). A per-phase plan.json `test_first: false` is a kill switch
 * that opts a single phase out even when the global toggle is on.
 *
 * @param {{cfg?: object, phaseMeta?: object, fix?: any, isBatch?: boolean}} o
 * @returns {boolean}
 */
export function isTestFirstActive({ cfg, phaseMeta, fix, isBatch } = {}) {
  if (fix || isBatch) return false;
  if (cfg?.test_first?.enabled !== true) return false;
  if (phaseMeta && phaseMeta.test_first === false) return false;
  return true;
}

/**
 * Recursively probe for any JS/TS source file under `dir`, skipping node_modules,
 * .git and dot-dirs, bounded to MAX_SCAN_DEPTH so a huge tree can't stall the
 * check. Returns true on the first hit.
 */
async function hasJsTsFile(dir, depth = 0) {
  if (depth > MAX_SCAN_DEPTH) return false;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  const subdirs = [];
  for (const e of entries) {
    const name = e.name;
    if (name === 'node_modules' || name === '.git' || name.startsWith('.')) continue;
    if (e.isFile() && JS_TS_RE.test(name)) return true;
    if (e.isDirectory()) subdirs.push(path.join(dir, name));
  }
  for (const sd of subdirs) {
    if (await hasJsTsFile(sd, depth + 1)) return true;
  }
  return false;
}

/**
 * Does `workspaceDir` look like a JS/TS project? A package.json short-circuits
 * to true; otherwise scan (bounded) for any JS/TS source file. Used by the
 * harness to SKIP test-first on a non-JS stack rather than fail the phase.
 *
 * @param {string} workspaceDir
 * @returns {Promise<boolean>}
 */
export async function isJsWorkspace(workspaceDir) {
  if (!workspaceDir) return false;
  try {
    await fs.access(path.join(workspaceDir, 'package.json'));
    return true;
  } catch {
    // no package.json — fall through to a source scan
  }
  return hasJsTsFile(workspaceDir);
}

/**
 * Default file spawn: run `cmd args` in `cwd`, bounded by `timeoutMs`, resolving
 * { code, timedOut }. Mirrors git.js/validators.js's detached-process-group +
 * SIGTERM→SIGKILL pattern so a hung test is always reaped. Never throws.
 */
function spawnFileDefault({ cmd, args, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    let timed = false;
    let proc;
    try {
      proc = spawn(cmd, args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true, // process-group leader so we can kill descendants
      });
    } catch (err) {
      return resolve({ code: -1, timedOut: false, error: err.message });
    }
    const t = setTimeout(() => {
      timed = true;
      try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* setsid race — retry coming */ }
      setTimeout(() => {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* already dead */ }
      }, 3000).unref?.();
    }, timeoutMs);
    t.unref?.();
    // Drain the pipes so a chatty test can't fill the OS buffer and stall.
    proc.stdout?.on('data', () => {});
    proc.stderr?.on('data', () => {});
    proc.on('error', (err) => { clearTimeout(t); resolve({ code: -1, timedOut: timed, error: err.message }); });
    proc.on('exit', (code) => { clearTimeout(t); resolve({ code: timed ? -1 : code, timedOut: timed }); });
  });
}

/**
 * Run an authored test FILE and interpret its exit code as pass/fail.
 *
 * The runtime is chosen by resolveTestRunner (plain node / npx tsx /
 * --experimental-strip-types) — injectable via deps.resolveTestRunner. The spawn
 * itself is injectable via deps.spawnFile so the test-first tests make ZERO real
 * spawns. Exit 0 = pass (green); any non-zero exit OR a timeout = fail (red).
 *
 * @param {{filePath: string, workspaceDir?: string, projectDir?: string, timeoutMs?: number}} o
 * @param {{resolveTestRunner?: Function, spawnFile?: Function}} [deps]
 * @returns {Promise<{ran: boolean, pass: boolean, exitCode: number, timedOut: boolean}>}
 */
export async function redCheck({ filePath, workspaceDir, projectDir, timeoutMs = 60000 }, deps = {}) {
  const resolveRunner = deps.resolveTestRunner ?? resolveTestRunner;
  const spawnFile = deps.spawnFile ?? spawnFileDefault;
  const cwd = workspaceDir ?? projectDir;
  const { cmd, args } = await resolveRunner(filePath, projectDir ?? workspaceDir);
  const { code, timedOut, error } = await spawnFile({ cmd, args, cwd, timeoutMs });
  // A -1 exit that is NOT a timeout means the test RUNTIME couldn't execute at
  // all (spawn error, or `node --experimental-strip-types` on Node < 22.6) — an
  // infra failure, NOT a legitimate "the feature doesn't exist yet" red result.
  // The caller must not commit+gate on it (a broken runner would gate every phase).
  const infraFailed = code === -1 && !timedOut;
  return { ran: true, pass: code === 0 && !timedOut, exitCode: code, timedOut: Boolean(timedOut), infraFailed, error: error || null };
}

/** True if `p` exists on disk. Async, never throws. */
async function pathExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/**
 * Build the acceptance-test author's task prompt. Pure function of its inputs —
 * same inputs always produce byte-identical output (no Date/randomness). This
 * is the VOLATILE per-call user prompt (interpolates phase/criteria/testRel);
 * the byte-identical static block is TEST_AUTHOR_SYSTEM_PROMPT.
 *
 * @param {{phaseMeta: object, testRel: string}} args
 * @returns {string}
 */
export function buildTestAuthorPrompt({ phaseMeta, testRel }) {
  const n = phaseMeta?.n;
  const title = phaseMeta?.title || '(untitled)';
  const goal = phaseMeta?.goal || '(see acceptance criteria)';
  const criteriaList = Array.isArray(phaseMeta?.acceptance_criteria) ? phaseMeta.acceptance_criteria : [];
  const numbered = criteriaList.length
    ? criteriaList.map((c, i) => `${i + 1}. ${c}`).join('\n')
    : '(none listed — nothing to author)';
  const filesExpected = (phaseMeta?.files_expected || []).join(', ') || '(none listed)';

  return `You are authoring the acceptance test for a phase BEFORE its implementation exists. Write ONE test file that FAILS now and will PASS once the phase is correctly implemented.

Rules:
- Write the test to EXACTLY this path, relative to your working directory: ${testRel}
- Use Node's built-in test runner: import { test } (or describe/it) from 'node:test' and assertions from 'node:assert'. NO new dependencies, no framework installs.
- Author ONE test (or describe) block per acceptance criterion you can encode as a deterministic, code-level check. Name each block with the criterion number and text so a reviewer can map block -> criterion.
- The test MUST exercise the code the phase will produce (import the module/function and assert its real behavior). Because the feature does not exist yet, the file MUST fail when run now — that red result is REQUIRED. Do NOT stub, weaken, or make assertions vacuous to force a pass, and do NOT implement the feature.
- List a criterion as UNCOVERED when it cannot be a deterministic code-level check from a test file alone — e.g. it needs a live external service, a running server, a UI/visual outcome, real network, timing/nondeterminism, or human judgment.
- Do NOT edit or create any file other than ${testRel}.

Phase ${n}: ${title}
Goal: ${goal}

Acceptance criteria (verbatim from plan.json):
${numbered}

Files the plan expects this phase to touch: ${filesExpected}

After writing ${testRel}, reply with EXACTLY one JSON object and nothing else (no markdown fence, no prose):
{
  "covered": [<1-based criterion numbers your test file has a failing-now / passing-when-implemented block for>],
  "uncovered": [<1-based criterion numbers you could NOT encode as a deterministic code-level test>]
}
Every criterion number from 1 to ${criteriaList.length} must appear in exactly one of the two arrays.`;
}

/**
 * Spawn the acceptance-test author (roleless, fresh session, Write-but-no-Bash)
 * and validate its JSON manifest reply through P1's reply contract (exactly one
 * re-ask on invalid JSON). The author writes the test file itself via Write
 * during the spawn; this function only validates the reply — the caller checks
 * the file landed and runs the red check.
 *
 * `role:null, sessionId:null` are load-bearing (cloned from the acceptance
 * checker): they keep runClaude from touching guide_session_id /
 * last_dev_session_id. The ONLY tool difference from the checker is Write.
 *
 * @returns {Promise<{ok: true, covered: number[], uncovered: number[]} | {ok: false, errors: string[]}>}
 */
async function authorAcceptanceTests({ cfg, projectName, workspaceDir, phaseMeta, testRel }, deps = {}) {
  const runClaudeFn = deps.runClaude ?? runClaude;
  const runWithContractFn = deps.runWithContract ?? runWithContract;

  const authorCfg = {
    ...cfg,
    model: cfg?.models?.['acceptance-test-author'],
    tools: { ...cfg?.tools, allowed_default: [...TEST_AUTHOR_ALLOWED_TOOLS] },
  };
  // Never inherit a dev escalation's reasoning-effort boost — authoring is its
  // own bounded task (mirrors verify-loop's checkerCfg).
  delete authorCfg._effort_override;

  const baseCall = {
    cfg: authorCfg,
    cwd: workspaceDir,
    systemPromptFile: null,
    systemPromptExtra: TEST_AUTHOR_SYSTEM_PROMPT,
    role: null,
    project: projectName,
    phase: phaseMeta?.n,
    task: 'acceptance-test-author',
  };

  const res = await runWithContractFn({
    baseCall,
    prompt: buildTestAuthorPrompt({ phaseMeta, testRel }),
    sessionId: null,
    schema: MANIFEST_SCHEMA,
    maxReasks: 1,
    escalateOnSecondFail: false,
    runClaude: runClaudeFn,
  });

  if (!res.ok) return { ok: false, errors: res.errors || ['manifest contract failed'] };
  const covered = Array.isArray(res.value?.covered) ? res.value.covered : [];
  const uncovered = Array.isArray(res.value?.uncovered) ? res.value.uncovered : [];
  return { ok: true, covered, uncovered };
}

/**
 * Pre-dev seam invoked by phase-runner's runDev BEFORE the dev spawn, only when
 * isTestFirstActive() is true.
 *
 * Flow (all fail-open — any failure degrades to LLM-checked, never fails the
 * phase on the harness's own limitation):
 *   1. Non-JS workspace / no acceptance criteria → skip (dim log).
 *   2. Author the red test + manifest (roleless spawn, P1 reply contract).
 *   3. The author must actually have written tests/acceptance/phase-N.test.mjs.
 *   4. RED CHECK: it must FAIL pre-dev. A green-before-dev file asserts nothing
 *      the code doesn't already satisfy — DELETE it and fall back.
 *   5. Red confirmed → the ORCHESTRATOR commits the test (the author has no
 *      Bash) as 'phase-N-tests: <title>'. runDev re-reads preSha off the
 *      returned committed:true so the dev's no-commit guard + changedFilesSince
 *      measure only the DEV's work.
 *
 * On success returns the synthetic validator rule (extraRules/extraValidators)
 * the phase-runner injects into runValidatorGate, the covered-criteria list the
 * checker marks met-by-test, and postTestsSha for the dev-commit tamper guard.
 *
 * @param {{cfg?: object, projectName?: string, projDir?: string, workspaceDir: string, phaseMeta?: object, preSha?: string}} ctx
 * @param {{log?: Function, isJsWorkspace?: Function, runClaude?: Function, runWithContract?: Function, redCheck?: Function, commitAll?: Function, resolveTestRunner?: Function, spawnFile?: Function}} [deps]
 * @returns {Promise<{skipped: boolean, reason?: string, committed: boolean, covered?: number[], uncovered?: number[], testRel?: string, testAbs?: string, postTestsSha?: string, extraRules?: Array, extraValidators?: object}>}
 */
export async function runTestFirstPreDev(ctx, deps = {}) {
  const { cfg, projectName, projDir, workspaceDir, phaseMeta } = ctx || {};
  const log = deps.log ?? console.log;

  const jsStack = await (deps.isJsWorkspace ?? isJsWorkspace)(workspaceDir);
  if (!jsStack) {
    log(chalk.dim('▸ test-first: non-JS workspace (no package.json / JS-TS sources) — skipping test-first for this phase.'));
    return { skipped: true, reason: 'non-js-stack', committed: false };
  }

  const criteria = Array.isArray(phaseMeta?.acceptance_criteria) ? phaseMeta.acceptance_criteria : [];
  if (!criteria.length) {
    log(chalk.dim('▸ test-first: phase has no acceptance criteria — nothing to author; proceeding LLM-checked.'));
    return { skipped: true, reason: 'no-criteria', committed: false };
  }

  const phaseN = phaseMeta?.n;
  const testRel = path.join('tests', 'acceptance', `phase-${phaseN}.test.mjs`);
  const testAbs = path.join(workspaceDir, testRel);

  // 1. Author the (red) acceptance test + its manifest via P1's reply contract.
  const authored = await authorAcceptanceTests({ cfg, projectName, workspaceDir, phaseMeta, testRel }, deps);
  if (!authored.ok) {
    log(chalk.yellow(`▸ test-first: acceptance-test author returned no valid manifest (${(authored.errors || []).join('; ')}) — proceeding LLM-checked.`));
    await fs.unlink(testAbs).catch(() => {});
    return { skipped: true, reason: 'author-failed', committed: false };
  }

  // 2. The author must have written the test file.
  if (!(await pathExists(testAbs))) {
    log(chalk.yellow(`▸ test-first: author returned a manifest but wrote no ${testRel} — proceeding LLM-checked.`));
    return { skipped: true, reason: 'no-test-file', committed: false };
  }

  // 3. RED CHECK: the authored test MUST fail before the dev runs. A green
  //    (exit 0) file is vacuous — it asserts nothing the code doesn't already
  //    satisfy — so DELETE it and fall back to LLM-checked (never gate on it).
  const redCheckFn = deps.redCheck ?? redCheck;
  const red = await redCheckFn({ filePath: testAbs, workspaceDir, projectDir: projDir }, deps);
  if (red.infraFailed) {
    log(chalk.yellow(`▸ test-first: could not RUN authored ${testRel} (${red.error || 'runner failed to execute'}) — cannot confirm red, deleting it and proceeding LLM-checked.`));
    await fs.unlink(testAbs).catch(() => {});
    return { skipped: true, reason: 'red-check-infra-failed', committed: false };
  }
  if (red.pass) {
    log(chalk.dim(`▸ test-first: authored ${testRel} PASSED before the dev ran (vacuous / non-failing) — deleting it and proceeding LLM-checked.`));
    await fs.unlink(testAbs).catch(() => {});
    return { skipped: true, reason: 'green-before-dev', committed: false };
  }

  // 4. Red confirmed. The author has no Bash, so the ORCHESTRATOR commits the
  //    test scaffold as its own 'phase-N-tests:' commit — runDev re-reads preSha
  //    off committed:true so the dev's no-commit guard measures the DEV's work.
  const commitFn = deps.commitAll ?? commitAll;
  const commit = await commitFn(workspaceDir, `phase-${phaseN}-tests: ${phaseMeta?.title || 'acceptance tests'}`.trim());
  if (!commit.ok || !commit.committed || !commit.sha) {
    log(chalk.yellow(`▸ test-first: could not commit the authored test (${commit.error || 'nothing staged'}) — proceeding LLM-checked.`));
    return { skipped: true, reason: 'commit-failed', committed: false };
  }

  log(chalk.cyan(`▸ test-first: authored + committed ${testRel} (red) covering ${authored.covered.length}/${criteria.length} criteria — the dev must make it pass without editing it.`));

  // Synthetic validator that runs the authored test as the dev's hard gate,
  // injected in-code via runValidators' extraRules (never written to
  // validators.json). Absolute path so validators' runOne resolves it
  // regardless of its projDir-relative cwd.
  const extraValidators = { [TEST_FIRST_VALIDATOR_NAME]: { script: testAbs, timeout_ms: 120000 } };
  const extraRules = [{ match: { always: true }, run: [TEST_FIRST_VALIDATOR_NAME] }];

  return {
    skipped: false,
    committed: true,
    covered: authored.covered,
    uncovered: authored.uncovered,
    testRel,
    testAbs,
    postTestsSha: commit.sha,
    extraRules,
    extraValidators,
  };
}
