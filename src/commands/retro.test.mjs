// Tests for retro.js (Phase 12) — pure-SQL aggregation over calls/healing_log/
// phases, plus the roleless guide call that turns the aggregate into a dated
// markdown report.
//
// Run with: node --test src/commands/retro.test.mjs
//
// Isolation: DB_PATH points at an in-memory sqlite DB (set before importing
// state.js, which lazily opens the DB on first use). config-resolver.js's
// loadProject() reads projects/<name>/project.json from the REAL repo path
// (not injectable), so this suite creates a real fixture project directory
// under projects/ — same approach as src/mcp/state-server.test.mjs's
// _mcp_test_fixture — and removes it (plus its docs/retro/ output) in an
// `after` hook.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DB_PATH = ':memory:';

const { getDb, upsertProject, getProject } = await import('../state.js');
const { buildRetroAggregate, buildRetroPrompt, runRetrospective, DEFAULT_WINDOW_DAYS } = await import('./retro.js');
const { lessonsPath } = await import('../lib/guide-paths.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');
const RETRO_DIR = path.join(REPO_ROOT, 'docs', 'retro');
const CONFIG_DIR = path.join(REPO_ROOT, 'config');

const FIXTURE = 'retro-test-fixture';
const FIXTURE_DIR = path.join(PROJECTS_DIR, FIXTURE);

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

async function makeFixtureProject() {
  await fs.rm(FIXTURE_DIR, { recursive: true, force: true });
  await fs.mkdir(path.join(FIXTURE_DIR, '.guide'), { recursive: true });
  await fs.writeFile(
    path.join(FIXTURE_DIR, 'project.json'),
    JSON.stringify({ $schema_version: 5, name: FIXTURE, created_at: daysAgo(30), current_phase: 2, total_phases: 5, status: 'in-progress' }),
  );
  upsertProject({ name: FIXTURE, tech_stack: 'node', profile: null, total_phases: 5, status: 'in-progress' });
}

function clearFixtureRows() {
  const db = getDb();
  db.prepare('DELETE FROM calls WHERE project = ?').run(FIXTURE);
  db.prepare('DELETE FROM healing_log WHERE project = ?').run(FIXTURE);
  db.prepare('DELETE FROM phases WHERE project = ?').run(FIXTURE);
}

function insertCall(row) {
  const db = getDb();
  db.prepare(`
    INSERT INTO calls (
      project, phase, task, model, started_at, duration_ms, cost_usd,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      is_error, error_message
    ) VALUES (@project, @phase, @task, @model, @started_at, @duration_ms, @cost_usd,
      @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens,
      @is_error, @error_message)
  `).run({
    project: FIXTURE, phase: null, duration_ms: 1000, cost_usd: 0, input_tokens: 0,
    output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, is_error: 0,
    error_message: null, ...row,
  });
}

function insertHeal({ error_kind, created_at }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO healing_log (project, error_kind, error_message, status, created_at)
    VALUES (?, ?, 'fixture', 'resolved', ?)
  `).run(FIXTURE, error_kind, created_at);
}

function insertPhase({ n, status, completed_at }) {
  const db = getDb();
  db.prepare(`INSERT INTO phases (project, n, title, status, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(FIXTURE, n, `phase ${n}`, status, completed_at, completed_at);
}

async function seedFullFixture() {
  clearFixtureRows();
  const recent = daysAgo(2);
  const old = daysAgo(20); // outside a 14-day window

  // dev-execution: 3 sonnet calls (1 erroring) + 1 opus call (escalation proxy), all recent.
  insertCall({ task: 'dev-execution', model: 'claude-sonnet-5', started_at: recent, cost_usd: 0.10, input_tokens: 100, cache_read_tokens: 300, cache_creation_tokens: 100, is_error: 0 });
  insertCall({ task: 'dev-execution', model: 'claude-sonnet-5', started_at: recent, cost_usd: 0.12, input_tokens: 100, cache_read_tokens: 300, cache_creation_tokens: 100, is_error: 1, error_message: 'boom' });
  insertCall({ task: 'dev-execution', model: 'claude-sonnet-5', started_at: recent, cost_usd: 0.08, input_tokens: 100, cache_read_tokens: 300, cache_creation_tokens: 100, is_error: 0 });
  insertCall({ task: 'dev-execution', model: 'claude-opus-4-8', started_at: recent, cost_usd: 0.15, input_tokens: 100, cache_read_tokens: 300, cache_creation_tokens: 100, is_error: 0 });
  // dev-execution call OUTSIDE the window — must be excluded.
  insertCall({ task: 'dev-execution', model: 'claude-sonnet-5', started_at: old, cost_usd: 99, input_tokens: 999, is_error: 0 });

  // fix-execution: one normal call + one that timed out (task_timeout_ms['fix-execution'] = 600000 in defaults).
  insertCall({ task: 'fix-execution', model: 'claude-sonnet-5', started_at: recent, cost_usd: 0.05, is_error: 0 });
  insertCall({
    task: 'fix-execution', model: 'claude-sonnet-5', started_at: recent, cost_usd: 0.05, is_error: 1,
    error_message: 'claude subprocess timed out after 10m (signal: unknown). Subprocess killed. Check for hanging tests or infinite loops in the dev agent.',
  });

  // 3-phase-review: one call that timed out — this task has NO task_timeout_ms
  // entry in defaults, so it must classify as the subprocess_timeout_ms fallback.
  insertCall({
    task: '3-phase-review', model: 'claude-sonnet-5', started_at: recent, cost_usd: 0.20, is_error: 1,
    error_message: 'claude subprocess timed out after 30m (signal: unknown). Subprocess killed. Check for hanging tests or infinite loops in the dev agent.',
  });

  // healing_log: 2 recent (network, git-dirty) + 1 old network (must be excluded).
  insertHeal({ error_kind: 'network', created_at: recent });
  insertHeal({ error_kind: 'git-dirty', created_at: recent });
  insertHeal({ error_kind: 'network', created_at: old });

  // phases: 1 completed + 1 failed, both recent.
  insertPhase({ n: 1, status: 'completed', completed_at: recent });
  insertPhase({ n: 2, status: 'failed', completed_at: recent });

  // lessons.jsonl: 1 recent reprompt + 1 old reprompt (excluded) + 1 recent escalation.
  const lines = [
    { ts: recent, kind: 'reprompt', phase: 2, source: 'auto-runner:reprompt', lesson: 'timed out', files: [] },
    { ts: old, kind: 'reprompt', phase: 1, source: 'auto-runner:reprompt', lesson: 'old timeout', files: [] },
    { ts: recent, kind: 'escalation', phase: 2, source: 'auto-runner:escalate', lesson: 'reprompts exhausted', files: [] },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n';
  await fs.writeFile(lessonsPath(FIXTURE_DIR), lines, 'utf-8');
}

after(async () => {
  await fs.rm(FIXTURE_DIR, { recursive: true, force: true }).catch(() => {});
  await fs.rm(path.join(RETRO_DIR, FIXTURE), { recursive: true, force: true }).catch(() => {});
});

test('DEFAULT_WINDOW_DAYS is 14, per the brief default', () => {
  assert.equal(DEFAULT_WINDOW_DAYS, 14);
});

// ─── buildRetroAggregate ─────────────────────────────────────────────────────

test('buildRetroAggregate: zero activity in window → has_data:false', async () => {
  await makeFixtureProject();
  clearFixtureRows();
  const aggregate = await buildRetroAggregate({ projectName: FIXTURE, days: 14 });
  assert.equal(aggregate.has_data, false);
  assert.deepEqual(aggregate.per_task, []);
});

test('buildRetroAggregate: unknown project throws', async () => {
  await assert.rejects(() => buildRetroAggregate({ projectName: 'no-such-project-xyz' }), /Project not found/);
});

test('buildRetroAggregate: per-task numbers, cache-hit %, error rate, escalation, timeout source, heals, phases, lessons', async () => {
  await makeFixtureProject();
  await seedFullFixture();

  const aggregate = await buildRetroAggregate({ projectName: FIXTURE, days: 14 });
  assert.equal(aggregate.has_data, true);
  assert.equal(aggregate.window_days, 14);

  const dev = aggregate.per_task.find((t) => t.task === 'dev-execution');
  assert.ok(dev, 'dev-execution row present');
  assert.equal(dev.calls, 4, 'the 20-day-old call must be excluded from the 14-day window');
  assert.equal(dev.errors, 1);
  assert.equal(dev.error_rate_pct, 25);
  assert.equal(dev.cache_hit_pct, 60); // 1200 cache_read / 2000 total = 60%
  assert.ok(Math.abs(dev.cost_usd - 0.45) < 0.001);
  assert.ok(dev.escalation, 'dev-execution is escalation-applicable');
  assert.equal(dev.escalation.opus_calls, 1);
  assert.equal(dev.escalation.escalation_rate_pct, 25);
  assert.equal(dev.timeout_trips.count, 0);

  const fix = aggregate.per_task.find((t) => t.task === 'fix-execution');
  assert.equal(fix.calls, 2);
  assert.equal(fix.timeout_trips.count, 1);
  assert.equal(fix.timeout_trips.source, "task_timeout_ms['fix-execution']");

  const review = aggregate.per_task.find((t) => t.task === '3-phase-review');
  assert.equal(review.timeout_trips.count, 1);
  assert.equal(review.timeout_trips.source, 'subprocess_timeout_ms (fallback)');
  assert.equal(review.escalation, null, 'escalation rate is not computed for non dev/fix tasks');

  const healByKind = Object.fromEntries(aggregate.heal_counts_by_kind.map((h) => [h.error_kind, h.count]));
  assert.equal(healByKind.network, 1, 'the 20-day-old network heal must be excluded');
  assert.equal(healByKind['git-dirty'], 1);

  assert.equal(aggregate.phases.touched, 2);
  assert.equal(aggregate.phases.completed, 1);
  assert.equal(aggregate.phases.failed, 1);

  assert.equal(aggregate.reprompt_count, 1, 'the 20-day-old reprompt lesson must be excluded');
  assert.equal(aggregate.escalation_count_from_lessons, 1);

  assert.ok(aggregate.config_snapshot.models['dev-execution']);
  assert.equal(aggregate.config_snapshot.task_timeout_ms['fix-execution'], 600000);
});

test('buildRetroAggregate: window is configurable — a 1-day window excludes 2-day-old data', async () => {
  await makeFixtureProject();
  await seedFullFixture();
  const aggregate = await buildRetroAggregate({ projectName: FIXTURE, days: 1 });
  assert.equal(aggregate.has_data, false, 'all fixture rows are >= 2 days old');
});

// ─── buildRetroPrompt ────────────────────────────────────────────────────────

test('buildRetroPrompt: embeds the aggregate JSON and both required section headers', async () => {
  await makeFixtureProject();
  await seedFullFixture();
  const aggregate = await buildRetroAggregate({ projectName: FIXTURE, days: 14 });
  const prompt = buildRetroPrompt(aggregate);
  assert.match(prompt, /## Findings/);
  assert.match(prompt, /## Config change proposals/);
  assert.match(prompt, /"project": "retro-test-fixture"/);
});

// ─── runRetrospective ────────────────────────────────────────────────────────

test('runRetrospective: zero activity writes a deterministic "nothing to analyze" report, no guide call made', async () => {
  await makeFixtureProject();
  clearFixtureRows();

  let called = false;
  const result = await runRetrospective({ projectName: FIXTURE, days: 14 }, { runClaude: async () => { called = true; return {}; } });

  assert.equal(called, false, 'the guide call must be skipped when there is nothing to analyze');
  assert.equal(result.skippedGuideCall, true);
  const body = await fs.readFile(result.reportPath, 'utf-8');
  assert.match(body, /Nothing to analyze this cycle/);
  assert.match(result.reportPath, /docs[/\\]retro[/\\]retro-test-fixture[/\\]\d{4}-\d{2}-\d{2}\.md$/);
});

test('runRetrospective: with activity, calls the guide with role:null/sessionId:null and a restricted read-only tool list, persists the reply verbatim', async () => {
  await makeFixtureProject();
  await seedFullFixture();

  let capturedOpts = null;
  const fakeReply = '## Findings\n- fixture finding\n\n## Config change proposals\n(no config changes proposed this cycle)';
  const result = await runRetrospective({ projectName: FIXTURE, days: 14 }, {
    runClaude: async (opts) => {
      capturedOpts = opts;
      return { result: fakeReply, is_error: false, session_id: 'fake-session-should-be-ignored' };
    },
  });

  assert.equal(capturedOpts.role, null);
  assert.equal(capturedOpts.sessionId, null);
  assert.equal(capturedOpts.task, 'retrospective');
  assert.deepEqual(capturedOpts.cfg.tools.allowed_default, ['Read']);

  assert.equal(result.skippedGuideCall, false);
  const body = await fs.readFile(result.reportPath, 'utf-8');
  assert.equal(body, `${fakeReply}\n`);
});

test('runRetrospective: is_error guide result throws instead of writing a malformed report', async () => {
  await makeFixtureProject();
  await seedFullFixture();
  await assert.rejects(
    () => runRetrospective({ projectName: FIXTURE, days: 14 }, {
      runClaude: async () => ({ is_error: true, result: 'spawn failed' }),
    }),
    /retrospective guide call failed/,
  );
});

test('runRetrospective: never modifies guide_session_id / last_dev_session_id (role:null session-safety)', async () => {
  await makeFixtureProject();
  await seedFullFixture();

  const before = getProject(FIXTURE);
  await runRetrospective({ projectName: FIXTURE, days: 14 }, {
    runClaude: async () => ({ result: '## Findings\n- x\n\n## Config change proposals\n(no config changes proposed this cycle)', is_error: false, session_id: 'fake-session' }),
  });
  const after = getProject(FIXTURE);

  assert.equal(after.guide_session_id, before.guide_session_id);
  assert.equal(after.last_dev_session_id, before.last_dev_session_id);
});

test('runRetrospective: never modifies any file under config/', async () => {
  await makeFixtureProject();
  await seedFullFixture();

  async function snapshot(dir) {
    const out = {};
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) Object.assign(out, await snapshot(full));
      else out[full] = (await fs.stat(full)).mtimeMs;
    }
    return out;
  }

  const before = await snapshot(CONFIG_DIR);
  await runRetrospective({ projectName: FIXTURE, days: 14 }, {
    runClaude: async () => ({ result: '## Findings\n- x\n\n## Config change proposals\n(no config changes proposed this cycle)', is_error: false }),
  });
  const after = await snapshot(CONFIG_DIR);

  assert.deepEqual(after, before, 'no file under config/ may change mtime as a side effect of npm run retro');
});
