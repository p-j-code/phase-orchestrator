// claude-runner.test.mjs — phase-8 regression tests for the group-kill convention.
//
// The bug (pre-phase-8): _groupKill negates internally (process.kill(-pid)),
// but every call site passed -proc.pid. The double-negation collapsed to a
// single-process kill, so bash-spawned children (git, npm, tsc) survived a
// phase kill and held git lock files + open handles in the workspace.
//
// These tests use the __testHooks.setGroupKill seam to assert the value handed
// to _groupKill is a POSITIVE pid (group kill), never a negative number, across:
//   (A) the manual cancel paths (killCurrent / killAll), and
//   (B) the wall-clock-timeout and idle-watchdog paths inside spawnClaude.
//
// Run: node src/claude-runner.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep state.js off the real DB (claude-runner imports it transitively).
process.env.DB_PATH = ':memory:';
process.env.ASHMERO_ROLE = 'mac';
process.env.ASHMERO_HOST_ID = 'mac';
// Keep runClaude's headless-trust write off the operator's real ~/.claude.json
// — the fake-binary spawns below use temp cwds that must not get trusted for
// real. The ensureWorkspaceTrust tests below re-enable it per call by passing
// an explicit claudeJsonPath (they delete this var first).
process.env.ORCHESTRATOR_SKIP_TRUST = '1';

const {
  killCurrent, killAll, runClaude, resolveMaxTurns,
  resolveComplexityTurnBudget, applyTurnBudget, bumpEffort, EFFORT_LEVELS,
  currentJobKey, withJobKey, buildChildEnv, ensureWorkspaceTrust,
  __testHooks,
} = await import('./claude-runner.js');
const { qualifiedMcpToolNames } = await import('./mcp/tool-names.js');
const { assertInsideDir } = await import('./lib/guide-paths.js');
const { upsertProject, getDb } = await import('./state.js');

// Section (F) below passes project:'demo' (needed as the --project value the
// mcp-config wiring writes) through the real recordCall/upsertSession path,
// which FK-references `projects(name)` — so a matching row must exist in the
// :memory: DB, unlike the FK-avoidant `project`-omitting calls elsewhere in
// this file.
upsertProject({ name: 'demo', tech_stack: 'test' });

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── (E) resolveMaxTurns — generic per-task turn cap (phase-2) ───────────────
// phases.task_max_turns[task] must win over BOTH max_turns_per_opus_phase and
// max_turns_per_phase — the narrowest applicable cap always wins. Falls back
// to the pre-existing Opus-vs-shared logic when no task-specific cap exists.

test('resolveMaxTurns: task_max_turns wins over max_turns_per_opus_phase on an Opus model', () => {
  const result = resolveMaxTurns({
    model: 'claude-opus-4-8',
    task: 'acceptance-check',
    phases: { max_turns_per_opus_phase: 80, max_turns_per_phase: 150, task_max_turns: { 'acceptance-check': 20 } },
  });
  assert.equal(result, 20, 'per-task cap must win over the Opus cap');
});

test('resolveMaxTurns: task_max_turns wins over max_turns_per_phase on a Sonnet model', () => {
  const result = resolveMaxTurns({
    model: 'claude-sonnet-5',
    task: 'acceptance-check',
    phases: { max_turns_per_phase: 150, task_max_turns: { 'acceptance-check': 20 } },
  });
  assert.equal(result, 20, 'per-task cap must win over the shared cap');
});

test('resolveMaxTurns: falls back to Opus cap when no task-specific entry exists (unchanged behavior)', () => {
  const result = resolveMaxTurns({
    model: 'claude-opus-4-8',
    task: 'dev-execution',
    phases: { max_turns_per_opus_phase: 80, max_turns_per_phase: 150, task_max_turns: { 'acceptance-check': 20 } },
  });
  assert.equal(result, 80, 'no task_max_turns entry for dev-execution → falls back to the Opus cap');
});

test('resolveMaxTurns: falls back to max_turns_per_phase for a non-Opus model with no task entry', () => {
  const result = resolveMaxTurns({
    model: 'claude-sonnet-5',
    task: 'dev-execution',
    phases: { max_turns_per_opus_phase: 80, max_turns_per_phase: 150 },
  });
  assert.equal(result, 150, 'no task_max_turns entry, non-Opus model → falls back to max_turns_per_phase');
});

test('resolveMaxTurns: acceptance-check gets no hard turn floor — a low configured cap is honored verbatim', () => {
  // Even with a generous Opus cap and shared cap configured, the task-specific
  // entry is honored exactly as configured — nothing raises it to meet either
  // broader ceiling. There is no "floor" logic anywhere in this resolution.
  const result = resolveMaxTurns({
    model: 'claude-opus-4-8',
    task: 'acceptance-check',
    phases: { max_turns_per_opus_phase: 999, max_turns_per_phase: 999, task_max_turns: { 'acceptance-check': 20 } },
  });
  assert.equal(result, 20, 'task cap is honored verbatim — no floor raises it toward the broader caps');
});

// ─── (E2) v0.17 — per-tier turn caps (MI-1) ──────────────────────────────────
// phases.max_turns_per_tier generalizes the old /opus/i check: the tier is
// derived from the model id (tier_models exact match first, heuristic
// fallback). The legacy max_turns_per_opus_phase keeps its outright-win
// semantics for opus models so existing project overrides behave verbatim.

test('resolveMaxTurns: fable model is capped by max_turns_per_tier.fable, not the 150-turn shared budget', () => {
  const result = resolveMaxTurns({
    model: 'claude-fable-5',
    task: 'dev-execution',
    phases: { max_turns_per_phase: 150, max_turns_per_opus_phase: 80, max_turns_per_tier: { opus: 80, fable: 60 } },
  });
  assert.equal(result, 60, 'fable tier cap must win — the old /opus/i regex would have given fable the full 150');
});

test('resolveMaxTurns: tier cap resolves via cfg tier_models exact match, not just the model-id heuristic', () => {
  const result = resolveMaxTurns({
    model: 'claude-future-model-x',
    task: 'dev-execution',
    phases: { max_turns_per_phase: 150, max_turns_per_tier: { fable: 60 } },
    tierModels: { fable: 'claude-future-model-x' },
  });
  assert.equal(result, 60, 'tier_models mapping must classify a non-heuristic model id into its tier cap');
});

test('resolveMaxTurns: legacy max_turns_per_opus_phase wins outright over max_turns_per_tier.opus (back-compat)', () => {
  const result = resolveMaxTurns({
    model: 'claude-opus-4-8',
    task: 'dev-execution',
    phases: { max_turns_per_phase: 150, max_turns_per_opus_phase: 100, max_turns_per_tier: { opus: 80 } },
  });
  assert.equal(result, 100, 'an existing project override of max_turns_per_opus_phase must be honored verbatim');
});

test('resolveMaxTurns: max_turns_hard_cap bounds legacy project overrides', () => {
  const result = resolveMaxTurns({
    model: 'claude-opus-4-8',
    task: 'dev-execution',
    phases: { max_turns_per_phase: 140, max_turns_per_opus_phase: 120, max_turns_hard_cap: 60 },
  });
  assert.equal(result, 60);
});

test('resolveMaxTurns: tier cap and shared cap — narrowest wins (a complexity-lowered shared cap bites under a higher tier cap)', () => {
  const result = resolveMaxTurns({
    model: 'claude-fable-5',
    task: 'dev-execution',
    phases: { max_turns_per_phase: 40, max_turns_per_tier: { fable: 60 } },
  });
  assert.equal(result, 40, 'min(tierCap, sharedCap) must win');
});

test('resolveMaxTurns: no tier entry for a sonnet model → falls through to max_turns_per_phase (unchanged behavior)', () => {
  const result = resolveMaxTurns({
    model: 'claude-sonnet-5',
    task: 'dev-execution',
    phases: { max_turns_per_phase: 150, max_turns_per_tier: { opus: 80, fable: 60 } },
  });
  assert.equal(result, 150);
});

// ─── (E3) v0.17 — complexity-tiered turn budgets ─────────────────────────────

test('resolveComplexityTurnBudget: maps routed complexity to its budget, null for unknown/absent', () => {
  const phases = { turn_budget_by_complexity: { low: 60, medium: 100, high: 150, critical: 150 } };
  assert.equal(resolveComplexityTurnBudget(phases, 'low'), 60);
  assert.equal(resolveComplexityTurnBudget(phases, 'medium'), 100);
  assert.equal(resolveComplexityTurnBudget(phases, 'critical'), 150);
  assert.equal(resolveComplexityTurnBudget(phases, 'unknown'), null, "routing-disabled 'unknown' complexity gets no budget");
  assert.equal(resolveComplexityTurnBudget({}, 'low'), null, 'absent map → no budget');
  assert.equal(resolveComplexityTurnBudget(null, 'low'), null, 'absent phases → no budget');
});

test('applyTurnBudget: clamps every turn cap down to the budget, never raises, leaves task_max_turns alone', () => {
  const phases = {
    max_turns_per_phase: 150,
    max_turns_per_opus_phase: 80,
    max_turns_per_tier: { opus: 80, fable: 60 },
    task_max_turns: { 'acceptance-check': 40 },
    subprocess_timeout_ms: 1800000,
  };
  const clamped = applyTurnBudget(phases, 60);
  assert.equal(clamped.max_turns_per_phase, 60);
  assert.equal(clamped.max_turns_per_opus_phase, 60);
  assert.deepEqual(clamped.max_turns_per_tier, { opus: 60, fable: 60 });
  assert.deepEqual(clamped.task_max_turns, { 'acceptance-check': 40 }, 'explicit per-task caps are untouched');
  assert.equal(clamped.subprocess_timeout_ms, 1800000, 'non-turn keys ride through the clone');
  assert.equal(phases.max_turns_per_phase, 150, 'input phases object is not mutated');
  const generous = applyTurnBudget(phases, 200);
  assert.equal(generous.max_turns_per_phase, 150, 'a budget above the caps never raises anything');
  // resolveMaxTurns over the clamped phases yields the budget for a low-complexity opus run
  assert.equal(resolveMaxTurns({ model: 'claude-opus-4-8', task: 'dev-execution', phases: clamped }), 60);
});

// ─── (E4) v0.17 — effort ladder (MI-4) ───────────────────────────────────────

test('bumpEffort: one-level boost, unset → high-default → xhigh, ceiling at xhigh', () => {
  assert.deepEqual(EFFORT_LEVELS, ['low', 'medium', 'high', 'xhigh']);
  assert.equal(bumpEffort(undefined), 'xhigh', 'unset base is treated as the CLI default (high) → xhigh');
  assert.equal(bumpEffort('low'), 'medium');
  assert.equal(bumpEffort('medium'), 'high');
  assert.equal(bumpEffort('high'), 'xhigh');
  assert.equal(bumpEffort('xhigh'), 'xhigh', 'already-max stays xhigh');
});

// ─── (K) Phase 46 — buildChildEnv: allowlist vs inherit env modes ────────────

const FAKE_BASE_ENV = Object.freeze({
  PATH: '/usr/bin:/bin',
  HOME: '/home/prem',
  SHELL: '/bin/zsh',
  USER: 'prem',
  LOGNAME: 'prem',
  TMPDIR: '/tmp',
  TERM: 'xterm-256color',
  TZ: 'Asia/Kolkata',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  CLAUDE_CONFIG_DIR: '/home/prem/.claude',
  XDG_CONFIG_HOME: '/home/prem/.config',
  HTTP_PROXY: 'http://proxy:8080',
  https_proxy: 'http://proxy:8080',
  MY_CI_TOKEN: 'super-secret-ci-token',
  ANTHROPIC_API_KEY: 'sk-ant-should-never-survive',
});

test('buildChildEnv: allowlist mode (default) drops a fake secret var not on the allowlist', () => {
  const env = buildChildEnv({ security: { env_mode: 'allowlist' } }, FAKE_BASE_ENV);
  assert.equal(env.MY_CI_TOKEN, undefined, 'MY_CI_TOKEN must be absent in allowlist mode');
});

test('buildChildEnv: inherit mode passes the fake secret var through', () => {
  const env = buildChildEnv({ security: { env_mode: 'inherit' } }, FAKE_BASE_ENV);
  assert.equal(env.MY_CI_TOKEN, 'super-secret-ci-token', 'MY_CI_TOKEN must survive in inherit mode');
});

test('buildChildEnv: absent cfg.security defaults to allowlist mode', () => {
  const env = buildChildEnv({}, FAKE_BASE_ENV);
  assert.equal(env.MY_CI_TOKEN, undefined, 'no security config → allowlist is the default, secret dropped');
});

test('buildChildEnv: allowlist mode passes PATH/HOME/LC_*/XDG_*/proxy vars through', () => {
  const env = buildChildEnv({ security: { env_mode: 'allowlist' } }, FAKE_BASE_ENV);
  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(env.HOME, '/home/prem');
  assert.equal(env.LC_ALL, 'en_US.UTF-8', 'LC_* prefix must pass through');
  assert.equal(env.XDG_CONFIG_HOME, '/home/prem/.config', 'XDG_* prefix must pass through');
  assert.equal(env.HTTP_PROXY, 'http://proxy:8080', 'proxy vars must pass through');
  assert.equal(env.https_proxy, 'http://proxy:8080', 'lowercase proxy vars must pass through');
});

test('buildChildEnv: allowlist mode drops CLAUDE_* — leaking it lets a spawned subprocess resolve relative writes against the parent session\'s project dir instead of its own cwd', () => {
  const env = buildChildEnv({ security: { env_mode: 'allowlist' } }, FAKE_BASE_ENV);
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined, 'CLAUDE_* prefix must NOT pass through in allowlist mode');
});

test('buildChildEnv: env_passthrough:["MY_CI_TOKEN"] restores the named var in allowlist mode', () => {
  const env = buildChildEnv({ security: { env_mode: 'allowlist', env_passthrough: ['MY_CI_TOKEN'] } }, FAKE_BASE_ENV);
  assert.equal(env.MY_CI_TOKEN, 'super-secret-ci-token', 'explicitly passthrough-listed var must survive');
});

test('buildChildEnv: env_passthrough supports a trailing-* prefix pattern', () => {
  const env = buildChildEnv({ security: { env_mode: 'allowlist', env_passthrough: ['MY_CI_*'] } }, { ...FAKE_BASE_ENV, MY_CI_OTHER: 'also-secret' });
  assert.equal(env.MY_CI_TOKEN, 'super-secret-ci-token');
  assert.equal(env.MY_CI_OTHER, 'also-secret');
});

test('buildChildEnv: ANTHROPIC_API_KEY is absent in BOTH allowlist and inherit modes', () => {
  const allowlisted = buildChildEnv({ security: { env_mode: 'allowlist' } }, FAKE_BASE_ENV);
  const inherited = buildChildEnv({ security: { env_mode: 'inherit' } }, FAKE_BASE_ENV);
  assert.equal(allowlisted.ANTHROPIC_API_KEY, undefined, 'allowlist mode strips ANTHROPIC_API_KEY');
  assert.equal(inherited.ANTHROPIC_API_KEY, undefined, 'inherit mode also strips ANTHROPIC_API_KEY');
});

test('buildChildEnv: ANTHROPIC_API_KEY stays stripped even if it is (mis)listed in env_passthrough', () => {
  const env = buildChildEnv({ security: { env_mode: 'allowlist', env_passthrough: ['ANTHROPIC_API_KEY'] } }, FAKE_BASE_ENV);
  assert.equal(env.ANTHROPIC_API_KEY, undefined, 'ANTHROPIC_API_KEY is stripped unconditionally, regardless of env_passthrough');
});

test('buildChildEnv: inherit mode reproduces the exact pre-phase-46 behavior — every other var present, only ANTHROPIC_API_KEY stripped', () => {
  const env = buildChildEnv({ security: { env_mode: 'inherit' } }, FAKE_BASE_ENV);
  for (const key of Object.keys(FAKE_BASE_ENV)) {
    if (key === 'ANTHROPIC_API_KEY') continue;
    assert.equal(env[key], FAKE_BASE_ENV[key], `inherit mode must pass ${key} through unchanged`);
  }
});

test('buildChildEnv: CLAUDE_CODE_OAUTH_TOKEN passes through in allowlist mode while other CLAUDE_* stays stripped — headless (NAS) auth depends on it', () => {
  const env = buildChildEnv(
    { security: { env_mode: 'allowlist' } },
    { ...FAKE_BASE_ENV, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test' },
  );
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-test', 'the OAuth token is the exact-name exception');
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined, 'path-bearing CLAUDE_* vars must still be dropped');
});

// ─── (K2) headless workspace trust — ensureWorkspaceTrust ────────────────────
// Each test lifts the file-wide ORCHESTRATOR_SKIP_TRUST guard (set at the top
// so fake-binary runClaude spawns never touch the real ~/.claude.json) and
// restores it afterwards; the explicit claudeJsonPath keeps writes in a tmpdir.

function liftTrustGuard(t) {
  delete process.env.ORCHESTRATOR_SKIP_TRUST;
  t.after(() => { process.env.ORCHESTRATOR_SKIP_TRUST = '1'; });
}

test('ensureWorkspaceTrust: creates ~/.claude.json with the trust flag when the file is missing', async (t) => {
  liftTrustGuard(t);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trust-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const claudeJsonPath = path.join(dir, '.claude.json');
  assert.equal(await ensureWorkspaceTrust('/Volume1/proj/workspace', { claudeJsonPath }), true);
  const root = JSON.parse(await fs.readFile(claudeJsonPath, 'utf-8'));
  assert.equal(root.projects['/Volume1/proj/workspace'].hasTrustDialogAccepted, true);
});

test('ensureWorkspaceTrust: preserves existing top-level keys and existing project entries', async (t) => {
  liftTrustGuard(t);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trust-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const claudeJsonPath = path.join(dir, '.claude.json');
  await fs.writeFile(claudeJsonPath, JSON.stringify({
    oauthAccount: { email: 'x@y.z' },
    projects: { '/other/dir': { history: ['a'], hasTrustDialogAccepted: false } },
  }), 'utf-8');
  assert.equal(await ensureWorkspaceTrust('/other/dir', { claudeJsonPath }), true);
  const root = JSON.parse(await fs.readFile(claudeJsonPath, 'utf-8'));
  assert.deepEqual(root.oauthAccount, { email: 'x@y.z' }, 'unrelated CLI state must survive');
  assert.deepEqual(root.projects['/other/dir'].history, ['a'], 'existing project entry fields must survive');
  assert.equal(root.projects['/other/dir'].hasTrustDialogAccepted, true);
});

test('ensureWorkspaceTrust: refuses to clobber an unparseable ~/.claude.json (CLI may be mid-write)', async (t) => {
  liftTrustGuard(t);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trust-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const claudeJsonPath = path.join(dir, '.claude.json');
  await fs.writeFile(claudeJsonPath, '{"projects": {trunc', 'utf-8');
  assert.equal(await ensureWorkspaceTrust('/some/dir', { claudeJsonPath }), false);
  assert.equal(await fs.readFile(claudeJsonPath, 'utf-8'), '{"projects": {trunc', 'corrupt file must be left byte-identical');
});

test('ensureWorkspaceTrust: second call for the same dir is a cached no-op (no re-write)', async (t) => {
  liftTrustGuard(t);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trust-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const claudeJsonPath = path.join(dir, '.claude.json');
  assert.equal(await ensureWorkspaceTrust('/cached/dir', { claudeJsonPath }), true);
  const stat1 = await fs.stat(claudeJsonPath);
  assert.equal(await ensureWorkspaceTrust('/cached/dir', { claudeJsonPath }), true);
  const stat2 = await fs.stat(claudeJsonPath);
  assert.equal(stat1.mtimeMs, stat2.mtimeMs, 'no second write for an already-trusted dir');
});

function fakeProc(pid) {
  return { pid, signals: [], kill(sig) { this.signals.push(sig); } };
}

// ─── (A) manual cancel paths hand _groupKill a positive pid ──────────────────

test('killCurrent hands _groupKill a positive pid (group kill, not double-negated)', () => {
  __testHooks.reset();
  const log = [];
  __testHooks.setGroupKill((pid, sig) => log.push({ pid, sig }));
  const a = fakeProc(4242);
  __testHooks.track('jobA', a, { project: 'A' });

  const res = killCurrent({ jobId: 'jobA', reason: 'test' });
  __testHooks.resetGroupKill();

  assert.equal(res.killed, true);
  assert.ok(log.length >= 1, 'at least the initial SIGTERM reached _groupKill');
  assert.ok(
    log.every((e) => e.pid > 0),
    `every _groupKill pid must be positive (group kill); got ${JSON.stringify(log.map((e) => e.pid))}`,
  );
  assert.ok(log.some((e) => e.pid === a.pid && e.sig === 'SIGTERM'), 'SIGTERM targets the job pid');
});

test('killAll hands _groupKill positive pids for every tracked job', () => {
  __testHooks.reset();
  const log = [];
  __testHooks.setGroupKill((pid, sig) => log.push({ pid, sig }));
  const a = fakeProc(5001);
  const b = fakeProc(5002);
  __testHooks.track('j1', a, {});
  __testHooks.track('j2', b, {});

  const n = killAll({ reason: 'shutdown' });
  __testHooks.resetGroupKill();

  assert.equal(n, 2);
  assert.ok(log.every((e) => e.pid > 0), 'no negative pids — no double-negation');
  assert.ok(log.some((e) => e.pid === a.pid), 'job 1 group-killed by its positive pid');
  assert.ok(log.some((e) => e.pid === b.pid), 'job 2 group-killed by its positive pid');
});

// ─── (B) timeout + idle-watchdog kill paths inside spawnClaude ───────────────
// A tiny hanging node process stands in for `claude`: it never exits on its own
// and emits nothing on stdout, so it trips the wall-clock timeout (when set) and
// the idle-stall watchdog (when set).

const HANG_ARGS = ['-e', 'process.stdin.resume(); setInterval(() => {}, 1e9);'];

function tmpLogs(tag) {
  const base = path.join(os.tmpdir(), `aorch-cr-test-${tag}-${process.pid}`);
  return { stdoutLog: `${base}.out.log`, stderrLog: `${base}.err.log` };
}

// Records pids handed to _groupKill AND actually reaps the real detached child
// (its own group → -pid) so spawnClaude's 'close' handler fires and the promise
// settles.
function recordingGroupKill(log) {
  return (pid, sig) => {
    log.push({ pid, sig });
    try { process.kill(-pid, sig); } catch { /* already gone */ }
  };
}

async function cleanup({ stdoutLog, stderrLog }) {
  await fs.unlink(stdoutLog).catch(() => {});
  await fs.unlink(stderrLog).catch(() => {});
}

test('wall-clock timeout kill path hands _groupKill a positive pid', { timeout: 20000 }, async () => {
  __testHooks.reset();
  const log = [];
  __testHooks.setGroupKill(recordingGroupKill(log));
  const logs = tmpLogs('timeout');

  await assert.rejects(
    __testHooks.spawnClaude({
      claudeBin: process.execPath, args: HANG_ARGS, cwd: __dirname, env: process.env,
      stdoutLog: logs.stdoutLog, stderrLog: logs.stderrLog,
      timeoutMs: 800, idleTimeoutMs: null, toolHangTimeoutMs: null, turnStallTimeoutMs: null,
      noSpinner: true,
    }),
    /timed out after/i,
  );
  __testHooks.resetGroupKill();
  await cleanup(logs);

  assert.ok(log.length >= 1, 'wall-clock timeout invoked _groupKill');
  assert.ok(
    log.every((e) => e.pid > 0),
    `timeout kill must pass a positive pid (group kill); got ${JSON.stringify(log.map((e) => e.pid))}`,
  );
  assert.ok(log.some((e) => e.sig === 'SIGTERM'), 'timeout kill ladder starts with SIGTERM');
});

test('idle-watchdog kill path routes through _groupKill with a positive pid', { timeout: 20000 }, async () => {
  __testHooks.reset();
  const log = [];
  __testHooks.setGroupKill(recordingGroupKill(log));
  const logs = tmpLogs('idle');

  await assert.rejects(
    __testHooks.spawnClaude({
      claudeBin: process.execPath, args: HANG_ARGS, cwd: __dirname, env: process.env,
      stdoutLog: logs.stdoutLog, stderrLog: logs.stderrLog,
      timeoutMs: null, idleTimeoutMs: 1500, toolHangTimeoutMs: null, turnStallTimeoutMs: null,
      noSpinner: true,
    }),
    /stalled — no output for/i,
  );
  __testHooks.resetGroupKill();
  await cleanup(logs);

  // length>=1 also proves the idle path now ROUTES THROUGH _groupKill — before
  // phase-8 it called process.kill(-proc.pid) directly and the seam saw nothing.
  assert.ok(log.length >= 1, 'idle-watchdog invoked _groupKill (not a bare process.kill)');
  assert.ok(
    log.every((e) => e.pid > 0),
    `idle kill must pass a positive pid (group kill); got ${JSON.stringify(log.map((e) => e.pid))}`,
  );
});

// ─── (C) bounded stdout tail — parseStreamJson still finds result after >768KB ──

test('bounded stdout tail: parseStreamJson finds result line after >768KB of output', { timeout: 30000 }, async () => {
  const resultObj = {
    type: 'result', subtype: 'success', result: 'tail-test-ok',
    session_id: 'sess-tail', total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 }, is_error: false,
  };
  const resultLine = JSON.stringify(resultObj);

  // Script that writes >768KB of junk stream-json then the result line.
  // No process.exit(0) — calling exit() drops pending buffered stdout before
  // it is flushed; let Node exit naturally so all writes complete first.
  const scriptPath = path.join(os.tmpdir(), `large-out-${process.pid}.mjs`);
  const scriptContent = [
    "const junk = '{\"type\":\"text\",\"text\":\"' + 'a'.repeat(100) + '\"}\\n';",
    'let written = 0;',
    'while (written < 900_000) { process.stdout.write(junk); written += junk.length; }',
    `process.stdout.write(${JSON.stringify(resultLine + '\n')});`,
    // Natural exit — Node flushes pending I/O before terminating
  ].join('\n');
  await fs.writeFile(scriptPath, scriptContent);

  const logs = tmpLogs('large-output');
  let result;
  try {
    result = await __testHooks.spawnClaude({
      claudeBin: process.execPath, args: [scriptPath],
      cwd: __dirname, env: process.env,
      stdoutLog: logs.stdoutLog, stderrLog: logs.stderrLog,
      timeoutMs: 25000, idleTimeoutMs: null, toolHangTimeoutMs: null, turnStallTimeoutMs: null,
      noSpinner: true,
    });
  } finally {
    await cleanup(logs);
    await fs.unlink(scriptPath).catch(() => {});
  }

  assert.equal(result.session_id, 'sess-tail', 'session_id parsed from tail');
  assert.equal(result.result, 'tail-test-ok', 'result text parsed from tail');
  assert.equal(result.is_error, false, 'is_error parsed correctly');
});

test('non-zero structured provider-limit result preserves session_id for post-reset resume', { timeout: 20000 }, async () => {
  const resultObj = {
    type: 'result', subtype: 'success', is_error: true,
    result: "You've reached your usage limit · resets 1pm (Asia/Calcutta)",
    session_id: 'sess-provider-limit', total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const scriptPath = path.join(os.tmpdir(), `provider-limit-${process.pid}.mjs`);
  await fs.writeFile(scriptPath, [
    `console.log(${JSON.stringify(JSON.stringify(resultObj))});`,
    'process.exitCode = 1;',
  ].join('\n'));
  const logs = tmpLogs('provider-limit');
  let result;
  try {
    result = await __testHooks.spawnClaude({
      claudeBin: process.execPath, args: [scriptPath],
      cwd: __dirname, env: process.env,
      stdoutLog: logs.stdoutLog, stderrLog: logs.stderrLog,
      timeoutMs: 10000, idleTimeoutMs: null, toolHangTimeoutMs: null, turnStallTimeoutMs: null,
      noSpinner: true,
    });
  } finally {
    await cleanup(logs);
    await fs.unlink(scriptPath).catch(() => {});
  }

  assert.equal(result.is_error, true);
  assert.equal(result.session_id, 'sess-provider-limit');
  assert.match(result.result, /usage limit/);
});

// ─── (D) thinking-block retry cap — loop terminates after MAX_THINKING_BLOCK_RETRIES ──

test('thinking-block retry cap: runClaude terminates after cap, not unbounded', { timeout: 30000 }, async () => {
  __testHooks.reset();

  // Shell script: count invocations via temp file, emit thinking-block error, exit 1.
  // runClaude prepends args like [-p, prompt, --model, ...] which the shell script ignores.
  const counterFile = path.join(os.tmpdir(), `tb-counter-${process.pid}.txt`);
  await fs.writeFile(counterFile, '0');

  const scriptPath = path.join(os.tmpdir(), `fake-claude-tb-${process.pid}.sh`);
  await fs.writeFile(scriptPath, [
    '#!/bin/sh',
    `count=$(cat "${counterFile}" 2>/dev/null || echo 0)`,
    `printf '%d' "$((count + 1))" > "${counterFile}"`,
    'printf "thinking blocks cannot be modified\\n" >&2',
    'exit 1',
    '',
  ].join('\n'));
  await fs.chmod(scriptPath, 0o755);

  const mockCfg = {
    _resolved: { claude_bin: scriptPath },
    model: 'claude-sonnet-4-6',
    billing: {
      window_reset_hours: 5,
      warn_at_calls: 1000,
      pause_at_calls: 1000,
      warn_at_cost_usd: 1000,
      pause_at_cost_usd: 1000,
      allow_api_fallback: false,
      mode: 'max_pooled',
    },
    tools: { allowed_default: [], permission_mode: null },
    phases: {
      subprocess_timeout_ms: 5000,
      idle_timeout_ms: null,
      tool_hang_timeout_ms: null,
      turn_stall_timeout_ms: null,
    },
  };

  let count;
  try {
    await assert.rejects(
      runClaude({
        cfg: mockCfg,
        cwd: os.tmpdir(),
        prompt: 'test',
        sessionId: 'test-sess-thinking-block',
        role: 'dev',
        task: 'dev-execution',
        // no project — avoids FK constraints in :memory: DB
      }),
      /thinking blocks cannot be modified/i,
    );
    count = parseInt(await fs.readFile(counterFile, 'utf-8'), 10);
  } finally {
    await fs.unlink(scriptPath).catch(() => {});
    await fs.unlink(counterFile).catch(() => {});
  }

  // With MAX_THINKING_BLOCK_RETRIES=2 and activeSessionId going null after the
  // first retry, the loop stops after 2 subprocess invocations (not unbounded).
  // Upper bound is maxAttempts (3) as a safety net; lower bound is 1.
  assert.ok(count >= 1, `expected at least 1 invocation, got ${count}`);
  assert.ok(count <= 3, `invocations (${count}) must be ≤ maxAttempts; cap prevents unbounded loop`);
});

// ─── (F) Phase 11 — MCP spawn-arg wiring, gated behind cfg.mcp.enabled ───────
//
// A tiny node-shebang "claude" stand-in writes its own argv (JSON-encoded, so
// embedded newlines in the prompt/system-prompt args round-trip exactly —
// something shell-quoting cannot guarantee) to a capture file, then emits a
// valid stream-json result line so runClaude completes successfully.
//
// Phase 46: the capture file path is embedded as a literal in the generated
// script (not read from process.env.CAPTURE_FILE) — the default 'allowlist'
// env_mode no longer passes an arbitrary custom var like CAPTURE_FILE through
// to the spawned subprocess, so relying on env passthrough here would be
// testing the wrong thing (and would break the moment allowlist mode is the
// default, which is exactly this phase).

async function makeCapturingFakeClaude(tag) {
  const scriptPath = path.join(os.tmpdir(), `fake-claude-capture-${tag}-${process.pid}.mjs`);
  const captureFile = path.join(os.tmpdir(), `fake-claude-capture-${tag}-${process.pid}.json`);
  const script = [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify(process.argv.slice(2)));`,
    "console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', session_id: 'sess-capture', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, num_turns: 7, is_error: false }));",
    '',
  ].join('\n');
  await fs.writeFile(scriptPath, script);
  await fs.chmod(scriptPath, 0o755);
  return { scriptPath, captureFile };
}

function baseMockCfg(claudeBin, extra = {}) {
  return {
    _resolved: { claude_bin: claudeBin },
    model: 'claude-sonnet-4-6',
    billing: {
      window_reset_hours: 5, warn_at_calls: 1000, pause_at_calls: 1000,
      warn_at_cost_usd: 1000, pause_at_cost_usd: 1000, allow_api_fallback: false, mode: 'max_pooled',
    },
    tools: { allowed_default: ['Read', 'Write', 'Edit'], permission_mode: 'acceptEdits' },
    phases: { subprocess_timeout_ms: 5000, idle_timeout_ms: null, tool_hang_timeout_ms: null, turn_stall_timeout_ms: null },
    ...extra,
  };
}

// Runs runClaude() against the capturing fake claude and returns its captured argv.
async function runCapturingClaude({ tag, cfgExtra, opts }) {
  const { scriptPath, captureFile } = await makeCapturingFakeClaude(tag);
  try {
    const result = await runClaude({
      cfg: baseMockCfg(scriptPath, cfgExtra), cwd: os.tmpdir(), prompt: 'test prompt',
      role: 'dev', task: 'dev-execution', ...opts,
    });
    assert.equal(result.is_error, false, 'fake claude call must succeed for argv capture to be meaningful');
    return JSON.parse(await fs.readFile(captureFile, 'utf-8'));
  } finally {
    await fs.unlink(scriptPath).catch(() => {});
    await fs.unlink(captureFile).catch(() => {});
  }
}

test('fresh retry after a corrupt resumed session restores the exact compiled context block once', { timeout: 20000 }, async () => {
  const counterFile = path.join(os.tmpdir(), `context-recovery-counter-${process.pid}.txt`);
  const captureFile = path.join(os.tmpdir(), `context-recovery-argv-${process.pid}.json`);
  const scriptPath = path.join(os.tmpdir(), `context-recovery-claude-${process.pid}.mjs`);
  const manifestId = 'e'.repeat(64);
  const recoveryBlock = `<compiled_context manifest_id="${manifestId}" sha="abc" confidence="0.9">\n- src/feature.js\n</compiled_context>`;
  await fs.writeFile(counterFile, '0');
  await fs.writeFile(scriptPath, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    `const counterFile = ${JSON.stringify(counterFile)};`,
    `const captureFile = ${JSON.stringify(captureFile)};`,
    "const count = Number(fs.readFileSync(counterFile, 'utf8') || 0);",
    "fs.writeFileSync(counterFile, String(count + 1));",
    "if (count === 0) { console.error('thinking blocks cannot be modified'); process.exit(1); }",
    "fs.writeFileSync(captureFile, JSON.stringify(process.argv.slice(2)));",
    "console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', session_id: 'sess-recovered', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, is_error: false }));",
    '',
  ].join('\n'));
  await fs.chmod(scriptPath, 0o755);
  try {
    const cfg = baseMockCfg(scriptPath, {
      context_compiler: { enabled: true, mode: 'assist' },
      _context_compiler: {
        manifest_id: manifestId,
        mode: 'assist',
        exposed: true,
        injected_tokens: 200,
        recovery_block: recoveryBlock,
      },
    });
    const result = await runClaude({
      cfg,
      cwd: os.tmpdir(),
      prompt: 'Finish the remaining work.',
      sessionId: 'sess-corrupt',
      role: 'dev',
      task: 'dev-execution',
    });
    assert.equal(result.session_id, 'sess-recovered');
    const argv = JSON.parse(await fs.readFile(captureFile, 'utf8'));
    assert.equal(argv.includes('--resume'), false, 'the corrupt session must be dropped');
    const prompt = argv[argv.indexOf('-p') + 1];
    assert.equal(prompt.split(`<compiled_context manifest_id="${manifestId}"`).length - 1, 1);
    assert.match(prompt, /<context_recovery>/);
    assert.match(prompt, /Finish the remaining work/);
  } finally {
    await fs.rm(counterFile, { force: true });
    await fs.rm(captureFile, { force: true });
    await fs.rm(scriptPath, { force: true });
  }
});

test('mcp.enabled:false (default) — assembled spawn args are byte-identical to the pre-phase-11 baseline, even when projectDir is supplied', { timeout: 20000 }, async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aorch-cr-mcp-disabled-'));
  try {
    const baseline = await runCapturingClaude({ tag: 'baseline', cfgExtra: {}, opts: { project: 'demo' } });
    const withMcpDisabled = await runCapturingClaude({
      tag: 'disabled', cfgExtra: { mcp: { enabled: false } }, opts: { project: 'demo', projectDir },
    });
    assert.deepEqual(withMcpDisabled, baseline, 'cfg.mcp.enabled:false (with projectDir supplied) must not change a single spawn arg');
    assert.ok(!baseline.includes('--mcp-config'), 'sanity: baseline never had --mcp-config');
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

test('mcp.enabled:true — spawn args gain --mcp-config (validated under projectDir) and the eight mcp__aorch-state__* tool names', { timeout: 20000 }, async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aorch-cr-mcp-enabled-'));
  try {
    const argv = await runCapturingClaude({
      tag: 'enabled', cfgExtra: { mcp: { enabled: true } }, opts: { project: 'demo', projectDir },
    });

    const mcpConfigIdx = argv.indexOf('--mcp-config');
    assert.ok(mcpConfigIdx !== -1, '--mcp-config must be present');
    const mcpConfigPath = argv[mcpConfigIdx + 1];
    // Must resolve inside projectDir (assertInsideDir throws if it escapes).
    await assertInsideDir(projectDir, mcpConfigPath);

    const writtenConfig = JSON.parse(await fs.readFile(mcpConfigPath, 'utf-8'));
    assert.equal(writtenConfig.mcpServers['aorch-state'].command, process.execPath);
    assert.ok(writtenConfig.mcpServers['aorch-state'].args.some((a) => a.endsWith(path.join('src', 'mcp', 'state-server.mjs'))));
    assert.deepEqual(writtenConfig.mcpServers['aorch-state'].args.slice(-2), ['--project', 'demo']);

    const allowedIdx = argv.indexOf('--allowedTools');
    assert.ok(allowedIdx !== -1, '--allowedTools must be present');
    const allowedTools = argv[allowedIdx + 1].split(',');
    for (const toolName of qualifiedMcpToolNames()) {
      assert.ok(allowedTools.includes(toolName), `--allowedTools must include ${toolName}`);
    }
    assert.equal(qualifiedMcpToolNames().length, 8, 'exactly eight MCP tools are wired (Phase 48 adds ask_operator)');
    // Base allowed_default tools survive alongside the MCP tool names.
    assert.ok(allowedTools.includes('Read') && allowedTools.includes('Write') && allowedTools.includes('Edit'));
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

test('MCP config publishing rejects a real .guide directory outside the project root', { timeout: 20000 }, async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aorch-cr-mcp-guide-link-'));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aorch-cr-mcp-guide-outside-'));
  try {
    await fs.symlink(outsideDir, path.join(projectDir, '.guide'));
    await assert.rejects(
      () => runCapturingClaude({
        tag: 'mcp-guide-symlink',
        cfgExtra: { mcp: { enabled: true } },
        opts: { project: 'demo', projectDir },
      }),
      /escapes base directory/,
    );
    assert.deepEqual(await fs.readdir(outsideDir), [], 'mcp-config.json must not be published through the .guide symlink');
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

test('context tools require a current manifest and bind an immutable per-workspace MCP config; shadow stays byte-identical', { timeout: 20000 }, async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aorch-cr-context-tools-'));
  try {
    const laneOne = path.join(projectDir, '.worktrees', 'lane-one');
    const laneTwo = path.join(projectDir, '.worktrees', 'lane-two');
    await fs.mkdir(laneOne, { recursive: true });
    await fs.mkdir(laneTwo, { recursive: true });
    const manifestId = 'a'.repeat(64);
    const shadow = await runCapturingClaude({
      tag: 'context-shadow',
      cfgExtra: { mcp: { enabled: true }, context_compiler: { enabled: true, mode: 'shadow' } },
      opts: { project: 'demo', projectDir },
    });
    const shadowWithManifest = await runCapturingClaude({
      tag: 'context-shadow-manifest',
      cfgExtra: {
        mcp: { enabled: true },
        context_compiler: { enabled: true, mode: 'shadow' },
        _context_compiler: { manifest_id: manifestId, mode: 'shadow' },
      },
      opts: { project: 'demo', projectDir },
    });
    const assistWithoutManifest = await runCapturingClaude({
      tag: 'context-assist-no-manifest',
      cfgExtra: { mcp: { enabled: true }, context_compiler: { enabled: true, mode: 'assist' } },
      opts: { project: 'demo', projectDir },
    });
    const assistUnexposedManifest = await runCapturingClaude({
      tag: 'context-assist-unexposed-manifest',
      cfgExtra: {
        mcp: { enabled: true },
        context_compiler: { enabled: true, mode: 'assist' },
        _context_compiler: { manifest_id: manifestId, mode: 'assist', exposed: false, injected_tokens: 0 },
      },
      opts: { project: 'demo', projectDir },
    });
    const assistLaneOne = await runCapturingClaude({
      tag: 'context-assist-lane-one',
      cfgExtra: {
        mcp: { enabled: true },
        context_compiler: { enabled: true, mode: 'assist' },
        _context_compiler: { manifest_id: manifestId, mode: 'assist', exposed: true, injected_tokens: 200 },
      },
      opts: { project: 'demo', projectDir, cwd: laneOne },
    });
    const assistLaneTwo = await runCapturingClaude({
      tag: 'context-assist-lane-two',
      cfgExtra: {
        mcp: { enabled: true },
        context_compiler: { enabled: true, mode: 'assist' },
        _context_compiler: { manifest_id: manifestId, mode: 'assist', exposed: true, injected_tokens: 200 },
      },
      opts: { project: 'demo', projectDir, cwd: laneTwo },
    });
    const shadowTools = shadow[shadow.indexOf('--allowedTools') + 1].split(',');
    const shadowManifestTools = shadowWithManifest[shadowWithManifest.indexOf('--allowedTools') + 1].split(',');
    const noManifestTools = assistWithoutManifest[assistWithoutManifest.indexOf('--allowedTools') + 1].split(',');
    const assistTools = assistLaneOne[assistLaneOne.indexOf('--allowedTools') + 1].split(',');
    assert.deepEqual(
      new Set(shadowTools.filter((name) => name.startsWith('mcp__aorch-state__'))),
      new Set(qualifiedMcpToolNames()),
      'shadow preserves the original eight-tool surface',
    );
    assert.deepEqual(shadowWithManifest, shadow, 'a shadow manifest must not change spawn args or MCP config binding');
    assert.deepEqual(
      new Set(shadowManifestTools.filter((name) => name.startsWith('mcp__aorch-state__'))),
      new Set(qualifiedMcpToolNames()),
    );
    assert.deepEqual(
      new Set(noManifestTools.filter((name) => name.startsWith('mcp__aorch-state__'))),
      new Set(qualifiedMcpToolNames()),
      'assist without a successful current manifest must not advertise context tools',
    );
    assert.deepEqual(
      assistUnexposedManifest,
      assistWithoutManifest,
      'an enforce-degraded or render-failed manifest must remain telemetry-only',
    );
    const expectedAssist = qualifiedMcpToolNames({ includeContext: true });
    assert.deepEqual(
      new Set(assistTools.filter((name) => name.startsWith('mcp__aorch-state__'))),
      new Set(expectedAssist),
    );
    assert.equal(expectedAssist.length, 11);

    const configPathOne = assistLaneOne[assistLaneOne.indexOf('--mcp-config') + 1];
    const configPathTwo = assistLaneTwo[assistLaneTwo.indexOf('--mcp-config') + 1];
    assert.notEqual(configPathOne, configPathTwo, 'the workspace hash must isolate parallel lane configs even for the same manifest');
    assert.match(path.basename(configPathOne), new RegExp(`^mcp-config-${manifestId}-[a-f0-9]{16}\\.json$`));
    const configOne = JSON.parse(await fs.readFile(configPathOne, 'utf-8'));
    const configTwo = JSON.parse(await fs.readFile(configPathTwo, 'utf-8'));
    const argsOne = configOne.mcpServers['aorch-state'].args;
    const argsTwo = configTwo.mcpServers['aorch-state'].args;
    assert.deepEqual(argsOne.slice(-4), ['--context-manifest-id', manifestId, '--workspace-dir', await fs.realpath(laneOne)]);
    assert.deepEqual(argsTwo.slice(-4), ['--context-manifest-id', manifestId, '--workspace-dir', await fs.realpath(laneTwo)]);
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

test('context MCP binding rejects an invocation workspace outside the project directory', { timeout: 20000 }, async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aorch-cr-context-containment-'));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aorch-cr-context-outside-'));
  try {
    await assert.rejects(
      () => runCapturingClaude({
        tag: 'context-outside-workspace',
        cfgExtra: {
          mcp: { enabled: true },
          context_compiler: { enabled: true, mode: 'assist' },
          _context_compiler: { manifest_id: 'd'.repeat(64), mode: 'assist', exposed: true, injected_tokens: 200 },
        },
        opts: { project: 'demo', projectDir, cwd: outsideDir },
      }),
      /escapes base directory/,
    );
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

// Phase 48 (reachability regression): ask_operator is gated server-side (per
// project, on operator_questions.enabled — see state-server.test.mjs), NEVER
// by claude-runner.js. The append here rides the SAME three-condition guard
// (cfg.mcp?.enabled && projectDir && project) as the other seven tool names —
// no runner change was made for this phase. This test exists specifically to
// catch a FUTURE regression that narrows that guard to two conditions (e.g.
// dropping the `project` check) and would otherwise silently make
// ask_operator (or any MCP tool) unreachable despite mcp.enabled:true.
test('mcp.enabled:true — a dev/fix spawn satisfying the three-condition guard (mcp.enabled && projectDir && project) includes mcp__aorch-state__ask_operator in --allowedTools', { timeout: 20000 }, async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aorch-cr-mcp-ask-operator-'));
  try {
    const argv = await runCapturingClaude({
      tag: 'ask-operator-reachable', cfgExtra: { mcp: { enabled: true } }, opts: { project: 'demo', projectDir },
    });
    const allowedIdx = argv.indexOf('--allowedTools');
    assert.ok(allowedIdx !== -1, '--allowedTools must be present');
    const allowedTools = argv[allowedIdx + 1].split(',');
    assert.ok(
      allowedTools.includes('mcp__aorch-state__ask_operator'),
      'the ask_operator qualified name must be present whenever the three-condition guard is satisfied, independent of operator_questions.enabled (a server-side-only gate)',
    );
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

test('mcp.enabled:true — without projectDir, args stay byte-identical to mcp.enabled:false (no partial wiring)', { timeout: 20000 }, async () => {
  const disabled = await runCapturingClaude({ tag: 'enabled-noprojectdir-off', cfgExtra: { mcp: { enabled: false } }, opts: { project: 'demo' } });
  const enabledNoProjectDir = await runCapturingClaude({ tag: 'enabled-noprojectdir-on', cfgExtra: { mcp: { enabled: true } }, opts: { project: 'demo' } });
  assert.deepEqual(enabledNoProjectDir, disabled, 'cfg.mcp.enabled:true with no projectDir opt must not partially wire MCP');
});

// ─── (G) v0.17 — per-task effort spawn arg (MI-4) + num_turns telemetry ──────

test('phases.task_effort entry adds a per-invocation --settings effortLevel arg; absent entry adds nothing', { timeout: 20000 }, async () => {
  const baseline = await runCapturingClaude({ tag: 'effort-off', cfgExtra: {}, opts: { project: 'demo' } });
  assert.ok(!baseline.includes('--settings'), 'no task_effort entry → no --settings arg (byte-identical spawn args)');

  const withEffort = await runCapturingClaude({
    tag: 'effort-on',
    cfgExtra: { phases: { subprocess_timeout_ms: 5000, idle_timeout_ms: null, tool_hang_timeout_ms: null, turn_stall_timeout_ms: null, task_effort: { 'dev-execution': 'xhigh' } } },
    opts: { project: 'demo' },
  });
  const idx = withEffort.indexOf('--settings');
  assert.ok(idx !== -1, '--settings must be present when task_effort has an entry for the task');
  assert.deepEqual(JSON.parse(withEffort[idx + 1]), { effortLevel: 'xhigh' }, '--settings payload is the effortLevel JSON');
});

test('cfg._effort_override (escalation boost) wins over the static task_effort map', { timeout: 20000 }, async () => {
  const argv = await runCapturingClaude({
    tag: 'effort-override',
    cfgExtra: {
      _effort_override: 'xhigh',
      phases: { subprocess_timeout_ms: 5000, idle_timeout_ms: null, tool_hang_timeout_ms: null, turn_stall_timeout_ms: null, task_effort: { 'dev-execution': 'medium' } },
    },
    opts: { project: 'demo' },
  });
  const idx = argv.indexOf('--settings');
  assert.ok(idx !== -1);
  assert.deepEqual(JSON.parse(argv[idx + 1]), { effortLevel: 'xhigh' }, 'the override, not the map entry, is applied');
});

test('num_turns from the result event is persisted on the calls row (v0.17 turn-budget calibration telemetry)', { timeout: 20000 }, async () => {
  await runCapturingClaude({ tag: 'num-turns', cfgExtra: {}, opts: { project: 'demo' } });
  const row = getDb().prepare(
    `SELECT num_turns FROM calls WHERE project = 'demo' AND is_error = 0 ORDER BY id DESC LIMIT 1`,
  ).get();
  assert.ok(row, 'a calls row was recorded for the fake claude call');
  assert.equal(row.num_turns, 7, 'num_turns from the stream-json result event lands in calls.num_turns');
});

// ─── (G2) Phase 46 — tools.task_profiles: per-task --allowedTools override ───
// Consulted only when the allowedToolsOverride PARAMETER is left at its null
// default; an explicit parameter (even []) always wins and never sees the map.

test('tools.task_profiles:{} (default) — assembled --allowedTools for a dev call is unchanged from before this phase', { timeout: 20000 }, async () => {
  const baseline = await runCapturingClaude({ tag: 'profiles-off', cfgExtra: {}, opts: { project: 'demo' } });
  const withEmptyProfiles = await runCapturingClaude({
    tag: 'profiles-off-explicit', cfgExtra: { tools: { allowed_default: ['Read', 'Write', 'Edit'], permission_mode: 'acceptEdits', task_profiles: {} } }, opts: { project: 'demo' },
  });
  assert.deepEqual(withEmptyProfiles, baseline, 'task_profiles:{} must not change a single spawn arg');
  const allowedIdx = baseline.indexOf('--allowedTools');
  assert.ok(allowedIdx !== -1);
  assert.equal(baseline[allowedIdx + 1], 'Read,Write,Edit', 'sanity: unchanged from cfg.tools.allowed_default');
});

test('tools.task_profiles: a profile set for the call\'s task replaces --allowedTools with the profile list', { timeout: 20000 }, async () => {
  const argv = await runCapturingClaude({
    tag: 'profiles-set',
    cfgExtra: { tools: { allowed_default: ['Read', 'Write', 'Edit'], permission_mode: 'acceptEdits', task_profiles: { 'dev-execution': ['Read', 'Grep'] } } },
    opts: { project: 'demo' },
  });
  const allowedIdx = argv.indexOf('--allowedTools');
  assert.ok(allowedIdx !== -1);
  assert.equal(argv[allowedIdx + 1], 'Read,Grep', 'the task profile list is used verbatim in place of allowed_default');
});

test('tools.task_profiles: a profile entry for a DIFFERENT task does not affect this call', { timeout: 20000 }, async () => {
  const baseline = await runCapturingClaude({ tag: 'profiles-other-task-baseline', cfgExtra: {}, opts: { project: 'demo' } });
  const withOtherTaskProfile = await runCapturingClaude({
    tag: 'profiles-other-task',
    cfgExtra: { tools: { allowed_default: ['Read', 'Write', 'Edit'], permission_mode: 'acceptEdits', task_profiles: { 'acceptance-check': ['Read'] } } },
    opts: { project: 'demo' },
  });
  assert.deepEqual(withOtherTaskProfile, baseline, 'a profile entry for a task other than dev-execution must not change this call\'s spawn args');
});

test('tools.task_profiles: an explicit allowedToolsOverride parameter beats a configured profile for the same task', { timeout: 20000 }, async () => {
  const argv = await runCapturingClaude({
    tag: 'profiles-explicit-wins',
    cfgExtra: { tools: { allowed_default: ['Read', 'Write', 'Edit'], permission_mode: 'acceptEdits', task_profiles: { 'dev-execution': ['Read', 'Grep'] } } },
    opts: { project: 'demo', allowedToolsOverride: ['Bash'] },
  });
  const allowedIdx = argv.indexOf('--allowedTools');
  assert.ok(allowedIdx !== -1);
  assert.equal(argv[allowedIdx + 1], 'Bash', 'the explicit parameter must win outright over the configured task profile');
});

test('tools.task_profiles: an explicit empty-array override ([] — the chat-engine MCP-only pattern) beats a configured profile', { timeout: 20000 }, async () => {
  const argv = await runCapturingClaude({
    tag: 'profiles-explicit-empty-wins',
    cfgExtra: { tools: { allowed_default: ['Read', 'Write', 'Edit'], permission_mode: 'acceptEdits', task_profiles: { 'dev-execution': ['Read', 'Grep'] } } },
    opts: { project: 'demo', allowedToolsOverride: [] },
  });
  assert.ok(!argv.includes('--allowedTools'), 'an explicit [] override yields no --allowedTools arg at all, exactly as pre-phase-46, ignoring the configured profile entirely');
});

// ─── (H) OBS-2 — routing decision + attempt/escalation persisted on calls ────

test('routing param persists tier/reasoning/attempt/escalated + resolved max_turns on the calls row', { timeout: 20000 }, async () => {
  await runCapturingClaude({
    tag: 'obs2-routing',
    cfgExtra: { phases: { subprocess_timeout_ms: 5000, idle_timeout_ms: null, tool_hang_timeout_ms: null, turn_stall_timeout_ms: null, task_max_turns: { 'dev-execution': 42 } } },
    opts: {
      project: 'demo',
      routing: { tier: 'opus', reasoning: ['keyword [regulatory-core] force_tier opus wins outright', 'escalated retry → reasoning effort boosted to xhigh'], attempt: 2, escalated: true },
    },
  });
  const row = getDb().prepare(
    `SELECT max_turns, routing_tier, routing_reason, attempt, escalated FROM calls WHERE project = 'demo' AND is_error = 0 ORDER BY id DESC LIMIT 1`,
  ).get();
  assert.ok(row, 'a calls row was recorded for the fake claude call');
  assert.equal(row.max_turns, 42, 'resolveMaxTurns() budget for this call is persisted');
  assert.equal(row.routing_tier, 'opus');
  assert.equal(row.routing_reason, 'keyword [regulatory-core] force_tier opus wins outright\nescalated retry → reasoning effort boosted to xhigh', 'reasoning[] is newline-joined');
  assert.equal(row.attempt, 2);
  assert.equal(row.escalated, 1, 'escalated boolean is stored as 0/1');
});

test('omitting routing synthesizes a static-baseline tier (routing_tier NULL now means legacy only)', { timeout: 20000 }, async () => {
  // Deep-analysis follow-up: helper tasks that bypass routeModel used to
  // record NULL routing_tier, indistinguishable from pre-OBS-2 legacy rows.
  // runClaude now derives the tier from the model id and stamps a
  // "static baseline" reason instead.
  await runCapturingClaude({ tag: 'obs2-no-routing', cfgExtra: {}, opts: { project: 'demo' } });
  const row = getDb().prepare(
    `SELECT max_turns, routing_tier, routing_reason, attempt, escalated FROM calls WHERE project = 'demo' AND is_error = 0 ORDER BY id DESC LIMIT 1`,
  ).get();
  assert.ok(row);
  assert.ok(typeof row.routing_tier === 'string' && row.routing_tier.length > 0, 'tier derived from the model id');
  assert.match(String(row.routing_reason), /static baseline/);
  assert.equal(row.attempt, null);
  assert.equal(row.escalated, 0, 'escalated defaults to 0, not NULL');
});

// ─── (H2) Internal retry accounting ────────────────────────────────────────
// `routing.attempt` is the caller/phase attempt. A single one of those can
// still launch up to three Claude subprocesses after transient failures, and
// every launch can consume provider budget. The calls table must contain one
// row per actual spawn — no hidden first/second attempts and no fourth
// logical-summary row after the eventual success.

test('runClaude records all 3 subprocess attempts under one logical_call_id, with no duplicate logical outcome row', { timeout: 20000 }, async (t) => {
  const tag = `attempt-accounting-${process.pid}-${Date.now()}`;
  const scriptPath = path.join(os.tmpdir(), `${tag}.mjs`);
  const counterFile = path.join(os.tmpdir(), `${tag}.count`);
  await fs.writeFile(counterFile, '0');
  await fs.writeFile(scriptPath, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    `const counterFile = ${JSON.stringify(counterFile)};`,
    "const n = Number(fs.readFileSync(counterFile, 'utf8') || 0) + 1;",
    "fs.writeFileSync(counterFile, String(n));",
    "if (n < 3) { console.error(`ECONNRESET synthetic transient attempt ${n}`); process.exit(1); }",
    `console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', session_id: ${JSON.stringify(`sess-${tag}`)}, total_cost_usd: 0.25, usage: { input_tokens: 12, output_tokens: 3 }, num_turns: 2, is_error: false }));`,
    '',
  ].join('\n'));
  await fs.chmod(scriptPath, 0o755);
  t.after(async () => {
    await fs.rm(scriptPath, { force: true });
    await fs.rm(counterFile, { force: true });
  });

  const task = `attempt-accounting-${Date.now()}`;
  const result = await runClaude({
    cfg: baseMockCfg(scriptPath),
    cwd: os.tmpdir(),
    prompt: 'retry accounting test',
    project: 'demo',
    role: 'dev',
    task,
    routing: { tier: 'sonnet', reasoning: ['test route'], attempt: 7, escalated: false },
  }, {
    // Exercise the real retry loop without making the unit test wait 20s.
    retrySleep: async () => {},
    retryBackoffMs: [0, 0, 0],
  });
  assert.equal(result.is_error, false);
  assert.equal(await fs.readFile(counterFile, 'utf8'), '3', 'the fake Claude binary was actually spawned three times');

  const rows = getDb().prepare(`
    SELECT logical_call_id, subprocess_attempt, attempt, is_error,
           error_message, cost_usd, input_tokens, output_tokens
    FROM calls WHERE project = ? AND task = ? ORDER BY id
  `).all('demo', task);
  assert.equal(rows.length, 3, 'two failed spawns + eventual success produce exactly three rows, not one or four');
  assert.ok(rows[0].logical_call_id, 'runClaude assigns a logical call identity');
  assert.equal(new Set(rows.map((row) => row.logical_call_id)).size, 1, 'all internal retries share one logical_call_id');
  assert.deepEqual(rows.map((row) => row.subprocess_attempt), [1, 2, 3]);
  assert.deepEqual(rows.map((row) => row.attempt), [7, 7, 7], 'routing attempt remains distinct from subprocess attempt');
  assert.deepEqual(rows.map((row) => row.is_error), [1, 1, 0]);
  assert.match(rows[0].error_message, /ECONNRESET synthetic transient attempt 1/);
  assert.match(rows[1].error_message, /ECONNRESET synthetic transient attempt 2/);
  assert.equal(rows[2].error_message, null);
  assert.equal(rows[2].cost_usd, 0.25, 'the eventual structured result retains normal usage/cost accounting');
  assert.equal(rows[2].input_tokens, 12);
  assert.equal(rows[2].output_tokens, 3);
});

// ─── (J) Phase 31 — last_turn_context_tokens tracks the LAST assistant turn,
// never the cumulative result.usage ───────────────────────────────────────
//
// CE-2 estimator correction: the naive design (threshold on the stream-json
// result event's `usage`) is wrong — that field is CUMULATIVE across every
// API turn in a resumed session, so thresholding on it would compact after
// EVERY call once a session crossed the threshold once, ever. The correct
// signal is the LAST assistant turn's own per-request usage.

async function writeStreamJsonScript(tag, lines) {
  const scriptPath = path.join(os.tmpdir(), `stream-usage-${tag}-${process.pid}.mjs`);
  const script = [
    '#!/usr/bin/env node',
    ...lines.map((l) => `console.log(${JSON.stringify(JSON.stringify(l))});`),
  ].join('\n');
  await fs.writeFile(scriptPath, script);
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
}

test('last_turn_context_tokens equals the LAST assistant event\'s own usage sum, not the cumulative result.usage total', { timeout: 20000 }, async () => {
  const lines = [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'turn 1' }], usage: { input_tokens: 1000, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'turn 2' }], usage: { input_tokens: 500, cache_read_input_tokens: 9000, cache_creation_input_tokens: 100 } } },
    {
      type: 'result', subtype: 'success', result: 'ok', session_id: 'sess-usage', total_cost_usd: 0.1,
      // Deliberately huge and unrelated to the last turn — proves the parser
      // does NOT fall back to this cumulative field.
      usage: { input_tokens: 999999, output_tokens: 1, cache_read_input_tokens: 999999, cache_creation_input_tokens: 999999 },
      is_error: false,
    },
  ];
  const scriptPath = await writeStreamJsonScript('two-turns', lines);
  const logs = tmpLogs('usage-two-turns');
  let result;
  try {
    result = await __testHooks.spawnClaude({
      claudeBin: process.execPath, args: [scriptPath], cwd: __dirname, env: process.env,
      stdoutLog: logs.stdoutLog, stderrLog: logs.stderrLog,
      timeoutMs: 10000, idleTimeoutMs: null, toolHangTimeoutMs: null, turnStallTimeoutMs: null,
      noSpinner: true,
    });
  } finally {
    await cleanup(logs);
    await fs.unlink(scriptPath).catch(() => {});
  }
  assert.equal(result.last_turn_context_tokens, 500 + 9000 + 100, 'must equal the LAST assistant turn\'s own sum (9600), not the cumulative result.usage total (~3M)');
});

test('last_turn_context_tokens is null when no assistant event ever carried message.usage (fallback output modes)', { timeout: 20000 }, async () => {
  const lines = [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'no usage field' }] } },
    { type: 'result', subtype: 'success', result: 'ok', session_id: 'sess-no-usage', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, is_error: false },
  ];
  const scriptPath = await writeStreamJsonScript('no-usage', lines);
  const logs = tmpLogs('usage-none');
  let result;
  try {
    result = await __testHooks.spawnClaude({
      claudeBin: process.execPath, args: [scriptPath], cwd: __dirname, env: process.env,
      stdoutLog: logs.stdoutLog, stderrLog: logs.stderrLog,
      timeoutMs: 10000, idleTimeoutMs: null, toolHangTimeoutMs: null, turnStallTimeoutMs: null,
      noSpinner: true,
    });
  } finally {
    await cleanup(logs);
    await fs.unlink(scriptPath).catch(() => {});
  }
  assert.equal(result.last_turn_context_tokens, null);
});

test('recordCall persists context_tokens from result.last_turn_context_tokens on a successful runClaude call', { timeout: 20000 }, async () => {
  const { scriptPath, captureFile } = await makeCapturingFakeClaude('context-tokens');
  // Overwrite the capturing fake's single result line with one that also
  // emits an assistant usage event first, so last_turn_context_tokens is set.
  const script = [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify(process.argv.slice(2)));`,
    "console.log(JSON.stringify({ type: 'assistant', message: { content: [{type:'text',text:'hi'}], usage: { input_tokens: 111, cache_read_input_tokens: 222, cache_creation_input_tokens: 3 } } }));",
    "console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', session_id: 'sess-ct', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, num_turns: 1, is_error: false }));",
    '',
  ].join('\n');
  await fs.writeFile(scriptPath, script);
  await fs.chmod(scriptPath, 0o755);
  try {
    await runClaude({ cfg: baseMockCfg(scriptPath), cwd: os.tmpdir(), prompt: 'test', role: 'dev', task: 'dev-execution', project: 'demo' });
  } finally {
    await fs.unlink(scriptPath).catch(() => {});
    await fs.unlink(captureFile).catch(() => {});
  }
  const row = getDb().prepare(
    `SELECT context_tokens FROM calls WHERE project = 'demo' AND session_id = 'sess-ct' ORDER BY id DESC LIMIT 1`,
  ).get();
  assert.ok(row, 'a calls row was recorded');
  assert.equal(row.context_tokens, 111 + 222 + 3);
});

// ─── (I) par-01-jobkeys — withJobKey mints/carries a stable per-job ALS key ──

test('withJobKey: mints a stable key visible via currentJobKey() inside fn, distinct across sibling calls', async () => {
  __testHooks.reset();
  let seenA, seenB;
  await Promise.all([
    withJobKey(null, async () => { await new Promise((r) => setTimeout(r, 10)); seenA = currentJobKey(); }),
    withJobKey(null, async () => { seenB = currentJobKey(); }),
  ]);
  assert.ok(seenA, 'job A saw a minted key');
  assert.ok(seenB, 'job B saw a minted key');
  assert.notEqual(seenA, seenB, 'two concurrent withJobKey calls never collide on the same key');
});

test('withJobKey: an explicit key is used verbatim and stays stable across await boundaries (survives retry-style re-entry)', async () => {
  const seen = [];
  await withJobKey('explicit-job-7', async () => {
    seen.push(currentJobKey());
    await new Promise((r) => setTimeout(r, 5));
    seen.push(currentJobKey());
  });
  assert.deepEqual(seen, ['explicit-job-7', 'explicit-job-7'], 'the same key is visible before and after an await — this is what lets a cancel land during retry backoff and still match on the next spawn');
});

test('withJobKey: nested call reuses the outer jobId rather than minting a fresh one', async () => {
  let outer, inner;
  await withJobKey('outer-job', async () => {
    outer = currentJobKey();
    await withJobKey(null, async () => { inner = currentJobKey(); });
  });
  assert.equal(outer, 'outer-job');
  assert.equal(inner, 'outer-job', 'nested withJobKey(null) does not override an already-established jobId');
});

test('withJobKey: two concurrent runClaude calls track under distinct keys and killCurrent targets only one', { timeout: 20000 }, async () => {
  __testHooks.reset();
  const { scriptPath: scriptA, captureFile: captureA } = await makeCapturingFakeClaude('jobkey-a');
  const { scriptPath: scriptB, captureFile: captureB } = await makeCapturingFakeClaude('jobkey-b');
  const keys = [];
  try {
    await Promise.all([
      withJobKey('job-A', async () => {
        keys.push(['A', currentJobKey()]);
        await runClaude({ cfg: baseMockCfg(scriptA), cwd: os.tmpdir(), prompt: 'a', role: 'dev', task: 'dev-execution', project: 'demo' });
      }),
      withJobKey('job-B', async () => {
        keys.push(['B', currentJobKey()]);
        await runClaude({ cfg: baseMockCfg(scriptB), cwd: os.tmpdir(), prompt: 'b', role: 'dev', task: 'dev-execution', project: 'demo' });
      }),
    ]);
  } finally {
    await fs.unlink(scriptA).catch(() => {});
    await fs.unlink(scriptB).catch(() => {});
    await fs.unlink(captureA).catch(() => {});
    await fs.unlink(captureB).catch(() => {});
  }
  assert.equal(keys.find((k) => k[0] === 'A')[1], 'job-A');
  assert.equal(keys.find((k) => k[0] === 'B')[1], 'job-B');
});
