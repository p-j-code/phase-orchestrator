// Phase 85 (P7a) — portfolio autopilot core.
//
// Covers plan() (pure packing/ordering/approval-flagging), execute() (enqueues
// via enqueueJob only), the expiring-approval security core (single-use reverts
// to a digest recommendation on night 2; a past expires_at is no approval), the
// `autopilot approve` CLI wiring, and migrate-autopilot idempotency + config
// defaults. Uses a real :memory: DB (real enqueueJob + autopilot_approvals) with
// deterministic `now`/`enqueueJob` injected via the deps seam — no real spawn.
//
// Run with: node --test src/lib/portfolio-autopilot.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DB_PATH = ':memory:';
process.env.ORCHESTRATOR_SKIP_TRUST = '1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const {
  plan, execute, grantApproval, findValidApproval,
} = await import('./portfolio-autopilot.js');
const { getDb } = await import('../state.js');
const { listPendingJobs } = await import('../server/job-queue.js');
const { runMigrateAutopilot } = await import('../migrate-autopilot.js');

// autopilot defaults, inlined so plan() tests don't depend on the resolver.
const CFG = {
  autopilot: {
    enabled: true,
    max_projects_per_night: 3,
    priority_order: ['resume', 'brief', 'bugs', 'audit', 'suggestions'],
    require_operator_approval_for: ['brief'],
  },
  billing: { window_headroom_min_calls: 4 },
};

// ─── plan() — pure ─────────────────────────────────────────────────────────────

test('plan(): empty portfolio → empty plan', () => {
  assert.deepEqual(plan({ projects: [], windowBudget: 100, cfg: CFG }), []);
  assert.deepEqual(plan({ projects: [], windowBudget: 0, cfg: CFG }), []);
});

test('plan(): priority order honored — a project with BOTH a paused run and queued briefs resumes (not briefs)', () => {
  const out = plan({
    projects: [{ name: 'p1', pausedRun: { id: 9 }, queuedBriefs: 2, predicted: 5 }],
    windowBudget: 100,
    cfg: CFG,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].action, 'resume');
  assert.equal(out[0].needs_approval, false, 'resume is not an approval-gated action');
});

test('plan(): deterministic ordering across projects follows priority_order then input order', () => {
  const projects = [
    { name: 'sug', approvedSuggestions: 1, predicted: 2 },   // suggestions (lowest)
    { name: 'res', pausedRun: { id: 1 }, predicted: 2 },      // resume (highest)
    { name: 'bug', bugInboxCount: 3, predicted: 2 },          // bugs
    { name: 'brf', queuedBriefs: 1, predicted: 2 },           // brief
  ];
  const out = plan({ projects, windowBudget: 100, cfg: CFG });
  assert.deepEqual(out.map((j) => j.project), ['res', 'brf', 'bug']);
  // max_projects_per_night = 3 caps out the 4th (suggestions).
  assert.equal(out.length, 3);
});

test("plan(): 'brief' is flagged needs_approval under defaults; other actions are not", () => {
  const out = plan({
    projects: [
      { name: 'brf', queuedBriefs: 1, predicted: 2 },
      { name: 'bug', bugInboxCount: 1, predicted: 2 },
    ],
    windowBudget: 100,
    cfg: CFG,
  });
  const brief = out.find((j) => j.project === 'brf');
  const bugs = out.find((j) => j.project === 'bug');
  assert.equal(brief.action, 'brief');
  assert.equal(brief.needs_approval, true);
  assert.equal(bugs.needs_approval, false);
});

test('plan(): greedy fill respects predicted_calls and leaves P2 headroom margin', () => {
  // windowBudget 20 − headroom 4 = 16 usable.
  // resume(10) fits → 6 left; bugs(10) does NOT fit (skipped); audit(3) fits → 3 left.
  const projects = [
    { name: 'a', pausedRun: { id: 1 }, predicted: 10 },
    { name: 'b', bugInboxCount: 2, predicted: 10 },
    { name: 'c', daysSinceLastAudit: 30, predicted: 3 },
  ];
  const out = plan({ projects, windowBudget: 20, cfg: CFG });
  assert.deepEqual(out.map((j) => j.project), ['a', 'c']);
  assert.equal(out.reduce((s, j) => s + j.predicted_calls, 0), 13);
  assert.ok(13 <= 16, 'total packed calls leave the 4-call headroom under the 20 budget');
});

test('plan(): max_projects_per_night cap is honored even when everything fits', () => {
  const cfg = { ...CFG, autopilot: { ...CFG.autopilot, max_projects_per_night: 2 } };
  const projects = [
    { name: 'a', pausedRun: { id: 1 }, predicted: 1 },
    { name: 'b', pausedRun: { id: 2 }, predicted: 1 },
    { name: 'c', pausedRun: { id: 3 }, predicted: 1 },
  ];
  const out = plan({ projects, windowBudget: 100, cfg });
  assert.equal(out.length, 2);
});

test('plan(): config-constant fallback used when a project carries no predicted history', () => {
  const out = plan({
    projects: [{ name: 'a', queuedBriefs: 1 }], // no `predicted`
    windowBudget: 100,
    cfg: CFG,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].predicted_calls, 4, 'brief fallback constant');
});

// ─── execute() — enqueue via enqueueJob ONLY ───────────────────────────────────

test('portfolio-autopilot.js source does NOT import claude-runner', async () => {
  const src = await readFile(path.join(SRC_DIR, 'lib', 'portfolio-autopilot.js'), 'utf8');
  // Assert there is no static import / dynamic import() / require() of any
  // claude-runner path. (A prose comment naming the rule is allowed.)
  const importRe = /(?:import[^;'"]*from\s*|import\s*\(\s*|require\s*\(\s*)['"][^'"]*claude-runner[^'"]*['"]/;
  assert.ok(!importRe.test(src), 'must not import src/claude-runner.js');
});

test('execute(): non-approval jobs enqueue via enqueueJob (real queue)', () => {
  const nightPlan = [
    { project: 'exec-bugs', action: 'bugs', args: { unattended: true }, needs_approval: false },
    { project: 'exec-res', action: 'resume', args: { unattended: true }, needs_approval: false },
  ];
  const res = execute(nightPlan, { now: () => new Date('2026-07-12T20:00:00Z') });
  assert.equal(res.enqueued.length, 2);
  assert.equal(res.recommendations.length, 0);
  const pending = listPendingJobs();
  assert.ok(pending.some((j) => j.project === 'exec-bugs' && j.action === 'bugs'));
  assert.ok(pending.some((j) => j.project === 'exec-res' && j.action === 'resume'));
});

test('execute(): uses the injected enqueueJob seam and nothing else to enqueue', () => {
  const calls = [];
  const spy = (arg) => { calls.push(arg); return 4242; };
  const res = execute(
    [{ project: 'seam', action: 'bugs', needs_approval: false }],
    { enqueueJob: spy, now: () => new Date('2026-07-12T20:00:00Z') },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].project, 'seam');
  assert.equal(res.enqueued[0].jobId, 4242);
});

// ─── Expiring approvals — the security core ────────────────────────────────────

test('execute(): a SINGLE-USE approval enqueues a brief on night 1 and reverts to a digest recommendation on night 2', () => {
  const project = 'appr-single';
  grantApproval({ project, action: 'brief' }); // neither flag → default 1 night
  const nightPlan = [{ project, action: 'brief', args: { unattended: true }, reason: '1 queued brief', needs_approval: true }];

  // Night 1 — valid approval → enqueued.
  const n1 = execute(nightPlan, { now: () => new Date('2026-07-12T20:00:00Z') });
  assert.equal(n1.enqueued.length, 1, 'brief enqueued on night 1');
  assert.equal(n1.recommendations.length, 0);
  assert.ok(listPendingJobs().some((j) => j.project === project && j.action === 'brief'));

  // Night 2 — single-use exhausted → digest recommendation, NOT enqueued.
  const n2 = execute(nightPlan, { now: () => new Date('2026-07-14T20:00:00Z') });
  assert.equal(n2.enqueued.length, 0, 'nothing enqueued on night 2');
  assert.equal(n2.recommendations.length, 1);
  assert.equal(n2.recommendations[0].action, 'brief');
  // Exactly one brief job total for this project across both nights.
  assert.equal(listPendingJobs().filter((j) => j.project === project && j.action === 'brief').length, 1);
});

test('execute(): an expires_at in the PAST is treated as no approval', () => {
  const project = 'appr-expired';
  grantApproval({ project, action: 'brief', until: '2000-01-01T00:00:00Z' });
  const res = execute(
    [{ project, action: 'brief', reason: '1 queued brief', needs_approval: true }],
    { now: () => new Date('2026-07-12T20:00:00Z') },
  );
  assert.equal(res.enqueued.length, 0);
  assert.equal(res.recommendations.length, 1);
  assert.ok(!listPendingJobs().some((j) => j.project === project && j.action === 'brief'));
});

test('execute(): a multi-night approval is consumed at most once per calendar night (idempotent)', () => {
  const project = 'appr-multi';
  grantApproval({ project, action: 'brief', nights: 3 });
  const nightPlan = [{ project, action: 'brief', reason: '1 queued brief', needs_approval: true }];
  const now = () => new Date('2026-07-12T20:00:00Z');

  const first = execute(nightPlan, { now });
  assert.equal(first.enqueued.length, 1);
  const second = execute(nightPlan, { now }); // same calendar night
  assert.equal(second.enqueued.length, 0, 'no double-enqueue in the same night');
  assert.equal(second.skipped.length, 1);

  const row = getDb().prepare('SELECT * FROM autopilot_approvals WHERE project = ? AND action = ?').get(project, 'brief');
  assert.equal(row.remaining_nights, 2, 'exactly one night consumed');
  assert.equal(row.consumed_nights, 1);
});

test('findValidApproval(): an approval with NO expiry bound is treated as invalid (never a permanent bypass)', () => {
  const project = 'appr-unbounded';
  // Bypass grantApproval to force the pathological both-null row.
  getDb().prepare(`
    INSERT INTO autopilot_approvals (project, action, scope, remaining_nights, expires_at, consumed_nights, last_consumed_night, created_at)
    VALUES (?, 'brief', 'all', NULL, NULL, 0, NULL, ?)
  `).run(project, new Date('2026-07-01T00:00:00Z').toISOString());
  const found = findValidApproval({ project, action: 'brief' }, new Date('2026-07-12T20:00:00Z'), getDb());
  assert.equal(found, null);
});

// ─── CLI approve + migration + config ──────────────────────────────────────────

test('approveAutopilotAction writes an autopilot_approvals row with the default one-night expiry', async () => {
  const { approveAutopilotAction } = await import('../commands/autopilot.js');
  const project = 'cli-approve';
  const row = await approveAutopilotAction({ project, action: 'brief' }); // no flags → 1 night
  assert.equal(row.remaining_nights, 1);
  assert.equal(row.expires_at, null);
  const stored = getDb().prepare('SELECT * FROM autopilot_approvals WHERE id = ?').get(row.id);
  assert.equal(stored.project, project);
  assert.equal(stored.action, 'brief');
  assert.equal(stored.remaining_nights, 1);
  assert.equal(stored.consumed_nights, 0);
});

test('approveAutopilotAction: --until sets a timestamp expiry, --nights sets a count; both together is rejected', async () => {
  const { approveAutopilotAction } = await import('../commands/autopilot.js');
  const until = await approveAutopilotAction({ project: 'cli-until', action: 'brief', until: '2030-01-01T00:00:00Z' });
  assert.equal(until.remaining_nights, null);
  assert.ok(until.expires_at.startsWith('2030-01-01'));

  const nights = await approveAutopilotAction({ project: 'cli-nights', action: 'brief', nights: 5 });
  assert.equal(nights.remaining_nights, 5);

  await assert.rejects(
    () => approveAutopilotAction({ project: 'cli-both', action: 'brief', nights: 2, until: '2030-01-01T00:00:00Z' }),
    /only one of --nights or --until/,
  );
});

test('the autopilot approve command is registered in orchestrator.js and lives in commands/autopilot.js', async () => {
  const orch = await readFile(path.join(SRC_DIR, 'orchestrator.js'), 'utf8');
  assert.ok(/\.command\(\s*['"]approve <project> <action>['"]/.test(orch), 'approve subcommand registered');
  assert.ok(orch.includes("'./commands/autopilot.js'") || orch.includes('"./commands/autopilot.js"'),
    'orchestrator imports the command from src/commands/autopilot.js (not inlined)');
  // The command file exists and exports the action.
  const mod = await import('../commands/autopilot.js');
  assert.equal(typeof mod.approveAutopilotAction, 'function');
});

test('migrate-autopilot is idempotent (runs twice safely) and honors DB_PATH (the :memory: DB)', () => {
  // DB_PATH=':memory:' is set at the top of this file; getDb() opened it, so
  // running the migration here proves it honors DB_PATH.
  assert.doesNotThrow(() => { runMigrateAutopilot(); runMigrateAutopilot(); });
  const cols = getDb().pragma('table_info(autopilot_approvals)').map((c) => c.name);
  assert.ok(cols.includes('remaining_nights'));
  assert.ok(cols.includes('expires_at'));
  assert.ok(cols.includes('consumed_nights'));
});

test('config.autopilot defaults are present, disabled, with the documented shape', async () => {
  const defaults = JSON.parse(await readFile(path.join(REPO_ROOT, 'config', 'defaults.json'), 'utf8'));
  const ap = defaults.autopilot;
  assert.ok(ap, 'autopilot block present');
  assert.equal(ap.enabled, false);
  assert.equal(ap.max_projects_per_night, 3);
  assert.deepEqual(ap.priority_order, ['resume', 'brief', 'bugs', 'audit', 'suggestions']);
  assert.deepEqual(ap.require_operator_approval_for, ['brief']);
  assert.ok(ap._comment, '_comment sibling present');
  // $schema_version was NOT bumped by this phase.
  assert.equal(defaults.$schema_version, 22);
});
