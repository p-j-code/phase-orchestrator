// Tests for the Phase 60 (P4) quality dashboard — end to end across the four
// surfaces the acceptance criteria name:
//   1. state.js         — verify_results, bug_rounds.found_count, getQualityReport()
//   2. web-ui.js        — GET /api/projects/:name/quality (real HTTP round-trip)
//   3. format.js        — sparklineSvg() inline-SVG helper (no chart deps)
//   4. OverviewTab.js   — the Quality card's tiles/sparkline render logic from a fixture
//   5. control-actions  — get_quality_report chat tool parity
// Uses an in-memory SQLite database via DB_PATH=:memory: env override (same
// convention as src/lib/run-events.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';

const {
  getDb, upsertProject, recordCall, recordVerifyResult, setBugRoundFoundCount,
  startBugRound, getBugRound, getQualityReport,
} = await import('../state.js');

// The chat control tool wraps the same getQualityReport() read — imported
// here so "get_quality_report returns the same numbers" is asserted against
// the state layer, mirroring run-events.test.mjs's get_run_timeline parity check.
const { toolGetQualityReport } = await import('../chat/control-actions.js');

// The Express app (for the real HTTP endpoint round-trip) and the two
// frontend modules the Quality card is built from. sparklineSvg / OverviewTab
// are pure, DOM-free ES modules (the vendored Vue build is import-safe under
// Node), so they load and exercise without jsdom or any new dependency.
const { createWebUiApp } = await import('../web-ui.js');
const { sparklineSvg } = await import('../public/js/lib/format.js');
const OverviewTab = (await import('../public/js/components/tabs/OverviewTab.js')).default;

function setupProject(name) {
  upsertProject({ name, tech_stack: 'node', total_phases: 5 });
  return name;
}

// Directly backdates a calls row's started_at — recordCall always stamps
// "now", so precise date-window tests (7d vs 30d) poke the DB directly,
// same technique run-events.test.mjs uses for pruneOldRunEvents.
function backdateLastCall(daysAgo) {
  getDb().prepare(
    `UPDATE calls SET started_at = datetime('now', '-' || ? || ' days') WHERE id = (SELECT MAX(id) FROM calls)`,
  ).run(daysAgo);
}

test('getQualityReport: div-by-zero guards — no calls, no verify rows, no rounds all degrade to null/[] rather than NaN/Infinity', () => {
  const project = setupProject('quality-empty');
  const report = getQualityReport({ project });
  assert.equal(report.acceptance.n, 0);
  assert.equal(report.acceptance.pass_n, 0);
  assert.equal(report.acceptance.first_pass_pct, null);
  assert.deepEqual(report.tasks, []);
  assert.deepEqual(report.rounds, []);
  assert.deepEqual(report.cache_trend, []);
});

test('recordVerifyResult: inserts a row with counts matching the verdict object; run_id defaults to NULL', () => {
  const project = setupProject('quality-verify-insert');
  recordVerifyResult({
    project, phase: 1, verdict: 'pass', criteria_met: 3, criteria_unmet: 0, unverifiable: 1,
  });
  const row = getDb().prepare('SELECT * FROM verify_results WHERE project = ?').get(project);
  assert.ok(row, 'row was inserted');
  assert.equal(row.phase, 1);
  assert.equal(row.verdict, 'pass');
  assert.equal(row.criteria_met, 3);
  assert.equal(row.criteria_unmet, 0);
  assert.equal(row.unverifiable, 1);
  assert.equal(row.run_id, null);
});

test('recordVerifyResult: never throws on a DB-level failure (missing NOT NULL fields)', () => {
  assert.doesNotThrow(() => recordVerifyResult({ project: null, phase: null, verdict: null }));
});

test('getQualityReport: acceptance first-pass % counts only the FIRST verify_results row per phase', () => {
  const project = setupProject('quality-first-pass');
  // Phase 1: first attempt passes.
  recordVerifyResult({ project, phase: 1, verdict: 'pass', criteria_met: 2, criteria_unmet: 0, unverifiable: 0 });
  // Phase 2: first attempt fails, a LATER refine attempt passes — only the
  // first row should count toward first-pass rate.
  recordVerifyResult({ project, phase: 2, verdict: 'fail', criteria_met: 1, criteria_unmet: 1, unverifiable: 0 });
  recordVerifyResult({ project, phase: 2, verdict: 'pass', criteria_met: 2, criteria_unmet: 0, unverifiable: 0 });
  const report = getQualityReport({ project });
  assert.equal(report.acceptance.n, 2, 'two phases have verify_results rows');
  assert.equal(report.acceptance.pass_n, 1, 'only phase 1 passed on its first attempt');
  assert.equal(report.acceptance.first_pass_pct, 50);
});

test('getQualityReport: per-task escalation % and avg num_turns vs cap from the calls foundations columns', () => {
  const project = setupProject('quality-tasks');
  recordCall({ project, task: 'dev', model: 'claude-sonnet-5', num_turns: 10, max_turns: 40, escalated: 0 });
  recordCall({ project, task: 'dev', model: 'claude-opus-4-8', num_turns: 20, max_turns: 40, escalated: 1 });
  recordCall({ project, task: 'dev', model: 'claude-sonnet-5', num_turns: 6, max_turns: 40, escalated: 0 });
  recordCall({ project, task: 'acceptance-check', model: 'claude-haiku-4-5' }); // legacy-shaped: no num_turns/max_turns/escalated
  const report = getQualityReport({ project });
  const dev = report.tasks.find((t) => t.task === 'dev');
  assert.ok(dev, 'dev task row present');
  assert.equal(dev.n, 3);
  assert.equal(dev.escalation_pct, 33.3); // 1 of 3 escalated
  assert.equal(dev.avg_num_turns, 12); // (10+20+6)/3
  assert.equal(dev.avg_max_turns, 40);
  const check = report.tasks.find((t) => t.task === 'acceptance-check');
  assert.ok(check, 'legacy-shaped task row present');
  assert.equal(check.escalation_pct, 0, 'no escalated calls -> 0%, not null (n>0)');
  assert.equal(check.avg_num_turns, null, 'AVG over all-NULL num_turns degrades to null');
  assert.equal(check.avg_max_turns, null);
});

test('bug_rounds.found_count: setBugRoundFoundCount is a no-op when the round row does not exist yet', () => {
  const project = setupProject('quality-found-count-noop');
  assert.doesNotThrow(() => setBugRoundFoundCount(project, 1, 5));
  assert.equal(getBugRound(project, 1), undefined);
});

test('bug_rounds.found_count: startBugRound sets it on insert; setBugRoundFoundCount updates it once the row exists', () => {
  const project = setupProject('quality-found-count');
  startBugRound({ project, round: 1, bugs_file: 'bug-rounds/round-1/bugs.md', total_fixes: 2, found_count: 4 });
  assert.equal(getBugRound(project, 1).found_count, 4);
  setBugRoundFoundCount(project, 1, 7);
  assert.equal(getBugRound(project, 1).found_count, 7);
  // A caller that doesn't know the count (found_count omitted -> null) on a
  // re-run must NOT clobber the value already recorded (COALESCE on UPDATE).
  startBugRound({ project, round: 1, bugs_file: 'bug-rounds/round-1/bugs.md', total_fixes: 3 });
  assert.equal(getBugRound(project, 1).found_count, 7, 'omitted found_count does not clobber the existing value');
});

test('getQualityReport: found_count series is ordered by round and renders legacy NULLs (bug-cycle.js path) as null, not 0', () => {
  const project = setupProject('quality-rounds-series');
  startBugRound({ project, round: 1, bugs_file: 'x', total_fixes: 1, found_count: 3 });
  startBugRound({ project, round: 2, bugs_file: 'x', total_fixes: 1 }); // legacy/manual path — no found_count
  startBugRound({ project, round: 3, bugs_file: 'x', total_fixes: 1, found_count: 1 });
  const report = getQualityReport({ project });
  assert.deepEqual(report.rounds.map((r) => r.round), [1, 2, 3]);
  assert.deepEqual(report.rounds.map((r) => r.found_count), [3, null, 1]);
});

test('getQualityReport: 7d vs 30d cache_hit_pct per task — a call older than 7d but within 30d only counts toward the 30d figure', () => {
  const project = setupProject('quality-cache-trend');
  // Recent call (within 7d): all-cache-read.
  recordCall({ project, task: 'dev', model: 'claude-sonnet-5', input_tokens: 0, cache_read_tokens: 100, cache_creation_tokens: 0 });
  // Older call (15 days ago — inside 30d, outside 7d): all-fresh-input (0% cache).
  recordCall({ project, task: 'dev', model: 'claude-sonnet-5', input_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0 });
  backdateLastCall(15);
  const report = getQualityReport({ project });
  const dev = report.cache_trend.find((t) => t.task === 'dev');
  assert.ok(dev, 'dev task present in cache trend');
  assert.equal(dev.cache_hit_pct_7d, 100, '7d window only sees the recent all-cache-read call');
  assert.equal(dev.cache_hit_pct_30d, 50, '30d window blends both calls: 100 cache-read of 200 total tokens');
});

test('get_quality_report chat tool returns the same numbers as getQualityReport for the same project/days', async () => {
  const project = setupProject('quality-tool-parity');
  recordVerifyResult({ project, phase: 1, verdict: 'pass', criteria_met: 1, criteria_unmet: 0, unverifiable: 0 });
  recordCall({ project, task: 'dev', model: 'claude-sonnet-5', num_turns: 5, max_turns: 20, escalated: 0 });
  startBugRound({ project, round: 1, bugs_file: 'x', total_fixes: 1, found_count: 2 });
  const direct = getQualityReport({ project, days: 30 });
  const viaTool = await toolGetQualityReport({ project, days: 30 });
  assert.deepEqual(viaTool, direct);
});

test('get_quality_report chat tool: unknown project throws (ensureProject contract)', async () => {
  await assert.rejects(() => toolGetQualityReport({ project: 'quality-does-not-exist' }));
});

// ── GET /api/projects/:name/quality — real HTTP round-trip (Criterion 3) ─────
// Exercises the actual Express route (not just getQualityReport directly) so
// the four sections, the div-by-zero guards, the days clamp, and the 404 path
// are all verified over the wire, on seeded fixtures.
test('GET /api/projects/:name/quality returns all four sections with correct math, div-by-zero guards, days clamp, and 404', async () => {
  const app = createWebUiApp({ authToken: null });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://localhost:${server.address().port}`;
  try {
    // — Empty project: every section div-by-zero-guards to null/[] (no NaN) —
    const empty = setupProject('quality-http-empty');
    const r0 = await fetch(`${base}/api/projects/${empty}/quality`);
    const b0 = await r0.json();
    assert.equal(r0.status, 200, 'empty project → 200');
    assert.ok(b0.acceptance && Array.isArray(b0.tasks) && Array.isArray(b0.rounds) && Array.isArray(b0.cache_trend),
      'all four sections present even on an empty project');
    assert.equal(b0.acceptance.first_pass_pct, null, 'no verify rows → first_pass_pct null, not NaN');
    assert.deepEqual(b0.tasks, [], 'no calls → tasks []');
    assert.deepEqual(b0.rounds, [], 'no rounds → rounds []');
    assert.deepEqual(b0.cache_trend, [], 'no calls → cache_trend []');

    // — Seeded project: four sections with real math —
    const seeded = setupProject('quality-http-seeded');
    recordVerifyResult({ project: seeded, phase: 1, verdict: 'pass', criteria_met: 2, criteria_unmet: 0, unverifiable: 0 });
    recordVerifyResult({ project: seeded, phase: 2, verdict: 'fail', criteria_met: 1, criteria_unmet: 1, unverifiable: 0 });
    recordCall({ project: seeded, task: 'dev', model: 'claude-sonnet-5', num_turns: 8, max_turns: 40, escalated: 0, input_tokens: 0, cache_read_tokens: 100, cache_creation_tokens: 0 });
    startBugRound({ project: seeded, round: 1, bugs_file: 'x', total_fixes: 1, found_count: 4 });
    startBugRound({ project: seeded, round: 2, bugs_file: 'x', total_fixes: 1 }); // legacy/manual path — no found_count

    const r1 = await fetch(`${base}/api/projects/${seeded}/quality`);
    const b1 = await r1.json();
    assert.equal(r1.status, 200, 'seeded project → 200');
    // acceptance
    assert.equal(b1.acceptance.n, 2);
    assert.equal(b1.acceptance.pass_n, 1);
    assert.equal(b1.acceptance.first_pass_pct, 50);
    // per-task escalation + turns vs cap
    const dev = b1.tasks.find((t) => t.task === 'dev');
    assert.ok(dev, 'dev task row present');
    assert.equal(dev.escalation_pct, 0);
    assert.equal(dev.avg_num_turns, 8);
    assert.equal(dev.avg_max_turns, 40);
    // found_count series — legacy NULL round (round 2) rides through the
    // endpoint as null (does not break it), ordered by round.
    assert.deepEqual(b1.rounds.map((r) => r.round), [1, 2]);
    assert.deepEqual(b1.rounds.map((r) => r.found_count), [4, null]);
    // 7d/30d cache trend
    const devCache = b1.cache_trend.find((t) => t.task === 'dev');
    assert.equal(devCache.cache_hit_pct_7d, 100);
    assert.equal(devCache.cache_hit_pct_30d, 100);
    // the endpoint payload is byte-identical to the direct helper read
    assert.deepEqual(b1, getQualityReport({ project: seeded, days: 30 }));

    // — days is clamped like getSpendReport (1..365) and reflected in the payload —
    const rClamp = await fetch(`${base}/api/projects/${seeded}/quality?days=9999`);
    const bClamp = await rClamp.json();
    assert.equal(bClamp.days, 365, 'days=9999 clamps to 365');

    // — unknown project → 404 —
    const r404 = await fetch(`${base}/api/projects/no-such-quality-proj/quality`);
    assert.equal(r404.status, 404, 'unknown project → 404');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ── sparklineSvg() inline-SVG helper (Criterion 4 — no chart deps) ───────────
test('sparklineSvg: empty / all-null series render a valid empty SVG (no polyline, no throw)', () => {
  for (const input of [[], [null, null], undefined, null]) {
    const svg = sparklineSvg(input);
    assert.match(svg, /^<svg\b/, 'returns an <svg> element');
    assert.ok(!svg.includes('<polyline'), 'empty/all-null series draws no polyline');
    assert.ok(!/NaN|Infinity/.test(svg), 'no NaN/Infinity leaks into the markup');
  }
});

test('sparklineSvg: single value renders a flat 2-point polyline without dividing by zero', () => {
  const svg = sparklineSvg([5]);
  assert.ok(svg.includes('<polyline'), 'single value still draws a polyline');
  const points = svg.match(/points="([^"]+)"/)[1].trim().split(/\s+/);
  assert.equal(points.length, 2, 'a single value is drawn as a flat 2-point line');
  assert.ok(!/NaN|Infinity/.test(svg));
});

test('sparklineSvg: multi-value series plots one point per numeric value and skips nulls (gaps)', () => {
  const svg = sparklineSvg([3, null, 1, 4], { width: 100, height: 24 });
  assert.ok(svg.includes('<polyline'));
  assert.match(svg, /width="100"/);
  assert.match(svg, /height="24"/);
  const points = svg.match(/points="([^"]+)"/)[1].trim().split(/\s+/);
  assert.equal(points.length, 3, 'the null entry is dropped — 3 numeric values → 3 points');
  assert.ok(!/NaN|Infinity/.test(svg));
});

test('sparklineSvg: a flat series (all values equal) renders without dividing by zero', () => {
  const svg = sparklineSvg([7, 7, 7]);
  assert.ok(svg.includes('<polyline'));
  assert.ok(!/NaN|Infinity/.test(svg), 'range=0 is guarded — no NaN in coordinates');
});

// ── OverviewTab Quality card render logic from a fixture (Criterion 4) ────────
// OverviewTab is a plain component-definition object; its computed/methods are
// pure over `this`. We render the Quality card's dynamic pieces from a fixture
// payload (the exact shape getQualityReport returns) without a DOM, then assert
// the template statically wires the tiles + sparkline + per-task table.
test('OverviewTab: the Quality card renders the sparkline tile + per-task table from a fixture', () => {
  const quality = {
    project: 'fixture', days: 30,
    acceptance: { n: 2, pass_n: 1, first_pass_pct: 50 },
    tasks: [{ task: 'dev', n: 3, escalation_pct: 33.3, avg_num_turns: 12, avg_max_turns: 40 }],
    rounds: [
      { round: 1, found_count: 3 },
      { round: 2, found_count: null },  // legacy NULL — must not break the sparkline
      { round: 3, found_count: 1 },
    ],
    cache_trend: [{ task: 'dev', cache_hit_pct_7d: 80, cache_hit_pct_30d: 60 }],
  };
  const ctx = { quality };

  // roundsSparkline computed — the bug-round convergence tile — builds a real
  // inline-SVG from the fixture's found_count series (legacy NULL skipped).
  const spark = OverviewTab.computed.roundsSparkline.call(ctx);
  assert.match(spark, /^<svg\b/, 'roundsSparkline returns an inline SVG');
  assert.ok(spark.includes('<polyline'), 'the convergence tile draws a polyline');
  const points = spark.match(/points="([^"]+)"/)[1].trim().split(/\s+/);
  assert.equal(points.length, 2, 'found_count [3, null, 1] → 2 plotted points (null skipped)');

  // cacheTrendFor method — feeds the per-task 7d/30d cache columns.
  assert.deepEqual(OverviewTab.methods.cacheTrendFor.call(ctx, 'dev'), quality.cache_trend[0]);
  assert.equal(OverviewTab.methods.cacheTrendFor.call(ctx, 'missing-task'), null);

  // Empty/absent quality degrades to no sparkline (card hides its tile), not a throw.
  assert.equal(OverviewTab.computed.roundsSparkline.call({ quality: { rounds: [] } }), null);
  assert.equal(OverviewTab.computed.roundsSparkline.call({ quality: null }), null);

  // The template statically wires all the tiles + table this fixture feeds.
  const tpl = OverviewTab.template;
  assert.ok(tpl.includes('quality.acceptance.first_pass_pct'), 'first-pass % tile is wired');
  assert.ok(tpl.includes('roundsSparkline'), 'bug-round convergence sparkline tile is wired');
  assert.ok(tpl.includes('t.escalation_pct'), 'per-task escalation column is wired');
  assert.ok(tpl.includes('cache_hit_pct_7d') && tpl.includes('cache_hit_pct_30d'), '7d/30d cache columns are wired');
});
