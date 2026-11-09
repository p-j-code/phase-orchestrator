// Tests for the prompt-eval harness (scripts/eval-prompts.mjs).
// Run with: node --test src/eval-prompts.test.mjs
//
// EVERYTHING here uses FAKE seams — no real LLM call, no production DB is ever
// opened. This is the fake-runner seam the brief mandates: real-call evals never
// run under npm test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';

import {
  runEval, parseArgs, helpText, selectTasks, parseRubricItems, computeScore,
  baselineKey, EVAL_CASES, KNOWN_TASKS, EXIT, REPO_ROOT, RUBRICS_DIR,
} from '../scripts/eval-prompts.mjs';

const PRODUCTION_DB_PATH = path.join(REPO_ROOT, 'state', 'orchestrator.db');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');
const silent = () => {};

// A canned artifact + a fake judge whose pass-fraction we control.
function cannedArtifact(overrides = {}) {
  const plan = { phases: [{ n: 1, title: 't', goal: 'g', acceptance_criteria: ['c'], files_expected: ['f'] }] };
  return {
    artifactText: JSON.stringify(plan),
    plan,
    model: 'canned-model',
    structValid: true,
    structProblems: [],
    ...overrides,
  };
}

function fakeProduce(makeArtifact) {
  const calls = [];
  const fn = async ({ evalCase }) => { calls.push(evalCase.name); return makeArtifact(evalCase); };
  fn.calls = calls;
  return fn;
}

// Fake judge: mark the first `Math.round(total*passFraction)` rubric items pass.
function fakeJudge(passFraction) {
  const calls = [];
  const fn = async ({ evalCase, rubricItems }) => {
    calls.push(evalCase.name);
    const passCount = Math.round(rubricItems.length * passFraction);
    return rubricItems.map((it, i) => ({ id: it.id, pass: i < passCount, reason: 'x' }));
  };
  fn.calls = calls;
  return fn;
}

// Common deps that never touch the real world.
function baseDeps(extra = {}) {
  return {
    log: silent,
    windowGuard: async () => ({ state: 'ok', callsInWindow: 0, warnThreshold: 50, windowHours: 5 }),
    getChangedFiles: async () => null, // null → full suite
    ...extra,
  };
}

async function seedBaselines(entries) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aorch-eval-baselines-'));
  const p = path.join(dir, 'baselines.json');
  await writeFile(p, JSON.stringify({ _comment: 'seed', ...entries }, null, 2));
  return p;
}

// ── Criterion 1: helpText documents every flag ───────────────────────────────
test('helpText documents every flag', () => {
  const h = helpText();
  for (const flag of ['--task', '--update-baseline', '--help']) {
    assert.ok(h.includes(flag), `help must document ${flag}`);
  }
});

// ── Criterion 1: harness + fixtures + rubric + baselines + README all exist ──
test('all P6 artifacts exist on disk', () => {
  const required = [
    'scripts/eval-prompts.mjs',
    'eval/fixtures/cli-tool/inputs/brief.md',
    'eval/fixtures/tiny-api/inputs/brief.md',
    'eval/rubrics/plan.md',
    'eval/baselines.json',
    'eval/README.md',
  ];
  for (const rel of required) {
    assert.ok(existsSync(path.join(REPO_ROOT, rel)), `${rel} must exist`);
  }
});

// ── Pure helpers ─────────────────────────────────────────────────────────────
test('parseArgs handles flags', () => {
  assert.deepEqual(parseArgs(['--help']), { help: true, updateBaseline: false, task: null, unknown: [] });
  assert.deepEqual(parseArgs(['--task', 'plan', '--update-baseline']), { help: false, updateBaseline: true, task: 'plan', unknown: [] });
  assert.deepEqual(parseArgs(['--task=plan']).task, 'plan');
  assert.deepEqual(parseArgs(['--bogus']).unknown, ['--bogus']);
});

test('selectTasks derives from diff / explicit task', () => {
  assert.deepEqual(selectTasks({ explicitTask: 'plan' }), ['plan']);
  assert.deepEqual(selectTasks({ explicitTask: 'nope' }), []);
  assert.deepEqual(selectTasks({ changedFiles: null }), [...KNOWN_TASKS]); // clean tree → all
  assert.deepEqual(selectTasks({ changedFiles: ['README.md'] }), []); // no trigger → none
  assert.deepEqual(selectTasks({ changedFiles: ['src/lib/phase-runner.js'] }), ['plan']);
  assert.deepEqual(selectTasks({ changedFiles: ['prompts/guide-system.md'] }), ['plan']);
});

test('parseRubricItems + computeScore', () => {
  const items = parseRubricItems('intro\n- [ ] one\n- [x] two\nprose\n* [ ] three\n');
  assert.equal(items.length, 3);
  assert.equal(items[0].id, 1);
  assert.equal(computeScore([{ pass: true }, { pass: false }, { pass: true }]), 2 / 3);
  assert.equal(computeScore([]), 0);
});

test('the real rubric has checklist items', async () => {
  const items = parseRubricItems(await readFile(path.join(RUBRICS_DIR, 'plan.md'), 'utf-8'));
  assert.ok(items.length >= 5, 'plan rubric should have several checklist items');
});

// ── Criterion 3: billing-guard 'warn' → non-zero + billing-guard-named msg ──
test("stubbed windowStatus 'warn' refuses with a billing-guard-named message", async () => {
  const produce = fakeProduce(() => cannedArtifact());
  const judge = fakeJudge(1);
  const res = await runEval({ task: 'plan' }, baseDeps({
    windowGuard: async () => ({ state: 'warn', callsInWindow: 55, warnThreshold: 50, windowHours: 5 }),
    produceArtifact: produce,
    judgeArtifact: judge,
  }));

  assert.equal(res.exitCode, EXIT.BILLING_REFUSED);
  assert.notEqual(res.exitCode, 0);
  assert.equal(res.refused, true);
  assert.match(res.refusedReason, /\[billing-guard\]/);
  assert.match(res.refusedReason, /billing\.warn_at_calls/);
  // No spend — neither seam ran.
  assert.equal(produce.calls.length, 0);
  assert.equal(judge.calls.length, 0);
});

test("windowStatus 'pause' also refuses", async () => {
  const res = await runEval({ task: 'plan' }, baseDeps({
    windowGuard: async () => ({ state: 'pause', callsInWindow: 200, warnThreshold: 50, windowHours: 5 }),
    produceArtifact: fakeProduce(() => cannedArtifact()),
    judgeArtifact: fakeJudge(1),
  }));
  assert.equal(res.exitCode, EXIT.BILLING_REFUSED);
  assert.equal(res.refused, true);
});

// ── Criterion 2: isolation — never opens production DB, never writes outside
//    the scratch dir (+ baselines.json) ──────────────────────────────────────
test('isolation: never opens the production DB, never writes outside scratch', async () => {
  const prodBefore = existsSync(PRODUCTION_DB_PATH) ? statSync(PRODUCTION_DB_PATH).mtimeMs : null;
  const projectsBefore = existsSync(PROJECTS_DIR) ? (await readdir(PROJECTS_DIR)).sort() : [];
  const baselinesPath = await seedBaselines({
    'cli-tool/plan': { score: null }, 'tiny-api/plan': { score: null },
  });
  const baselineMtimeBefore = statSync(baselinesPath).mtimeMs;

  const produce = fakeProduce(() => cannedArtifact()); // writes NOTHING to projects/
  const judge = fakeJudge(1);
  const res = await runEval({ task: 'plan' }, baseDeps({ produceArtifact: produce, judgeArtifact: judge, baselinesPath }));

  // DB path is a throwaway under tmp — never the production/repo DB.
  assert.ok(res.dbPath, 'runEval should report a dbPath');
  assert.ok(res.dbPath.startsWith(os.tmpdir()), `dbPath ${res.dbPath} must be under tmpdir`);
  assert.ok(!res.dbPath.startsWith(REPO_ROOT), 'dbPath must not be inside the repo');
  assert.notEqual(res.dbPath, PRODUCTION_DB_PATH);
  assert.equal(process.env.DB_PATH, res.dbPath, 'harness must set DB_PATH to the isolated temp DB');

  // Production DB untouched.
  const prodAfter = existsSync(PRODUCTION_DB_PATH) ? statSync(PRODUCTION_DB_PATH).mtimeMs : null;
  assert.equal(prodAfter, prodBefore, 'production DB must not be created/modified');

  // No fixture project leaked into projects/.
  const projectsAfter = existsSync(PROJECTS_DIR) ? (await readdir(PROJECTS_DIR)).sort() : [];
  assert.deepEqual(projectsAfter, projectsBefore, 'no _eval-* project may appear under projects/');
  assert.ok(!projectsAfter.some((p) => p.startsWith('_eval-')));

  // baselines.json NOT touched without --update-baseline.
  assert.equal(statSync(baselinesPath).mtimeMs, baselineMtimeBefore, 'baselines.json must not be written without --update-baseline');

  // Scratch dir was cleaned up.
  assert.ok(res.scratchDir && res.scratchDir.startsWith(os.tmpdir()));
  assert.ok(!existsSync(res.scratchDir), 'scratch dir should be removed after the run');
  assert.equal(res.exitCode, EXIT.OK);
});

// ── Criterion 4: a checklist-score drop beyond tolerance → non-zero exit ────
test('score drop beyond tolerance exits non-zero', async () => {
  const baselinesPath = await seedBaselines({
    'cli-tool/plan': { score: 1.0 }, 'tiny-api/plan': { score: 1.0 },
  });
  const res = await runEval({ task: 'plan', tolerance: 0.1 }, baseDeps({
    produceArtifact: fakeProduce(() => cannedArtifact()),
    judgeArtifact: fakeJudge(0.5), // 50% → drop 0.5 > 0.1
    baselinesPath,
  }));
  assert.equal(res.exitCode, EXIT.REGRESSION);
  assert.ok(res.results.every((r) => r.regression === true), 'both cases should regress');
});

test('a small drop within tolerance does NOT gate', async () => {
  const baselinesPath = await seedBaselines({
    'cli-tool/plan': { score: 1.0 }, 'tiny-api/plan': { score: 1.0 },
  });
  const res = await runEval({ task: 'plan', tolerance: 0.2 }, baseDeps({
    produceArtifact: fakeProduce(() => cannedArtifact()),
    judgeArtifact: fakeJudge(0.9), // 90% → drop 0.1 <= 0.2
    baselinesPath,
  }));
  assert.equal(res.exitCode, EXIT.OK);
  assert.ok(res.results.every((r) => r.regression === false));
});

test('an unset (null) baseline reports but never gates', async () => {
  const baselinesPath = await seedBaselines({
    'cli-tool/plan': { score: null }, 'tiny-api/plan': { score: null },
  });
  const res = await runEval({ task: 'plan', tolerance: 0.1 }, baseDeps({
    produceArtifact: fakeProduce(() => cannedArtifact()),
    judgeArtifact: fakeJudge(0), // 0% — but no baseline to compare against
    baselinesPath,
  }));
  assert.equal(res.exitCode, EXIT.OK);
});

// ── Criterion 4: --update-baseline rewrites baselines.json ───────────────────
test('--update-baseline rewrites baselines.json and preserves non-case keys', async () => {
  const baselinesPath = await seedBaselines({
    'cli-tool/plan': { score: null }, 'tiny-api/plan': { score: null },
  });
  const res = await runEval({ task: 'plan', updateBaseline: true }, baseDeps({
    produceArtifact: fakeProduce(() => cannedArtifact()),
    judgeArtifact: fakeJudge(1), // all pass → score 1.0
    baselinesPath,
  }));
  assert.equal(res.exitCode, EXIT.OK);

  const written = JSON.parse(await readFile(baselinesPath, 'utf-8'));
  assert.equal(written._comment, 'seed', 'non-case keys must survive');
  for (const key of ['cli-tool/plan', 'tiny-api/plan']) {
    assert.equal(written[key].score, 1.0);
    assert.ok(typeof written[key].artifact_hash === 'string' && written[key].artifact_hash.length === 64);
    assert.equal(written[key].model, 'canned-model');
    assert.match(written[key].date, /^\d{4}-\d{2}-\d{2}$/);
  }
});

// ── Validation gate: a structurally-invalid artifact fails the case ─────────
test('structurally-invalid artifact fails the case (validation gate) and skips the judge', async () => {
  const baselinesPath = await seedBaselines({ 'cli-tool/plan': { score: 1.0 }, 'tiny-api/plan': { score: 1.0 } });
  const judge = fakeJudge(1);
  const res = await runEval({ task: 'plan' }, baseDeps({
    produceArtifact: fakeProduce(() => cannedArtifact({ structValid: false, structProblems: ['phase 1 missing acceptance_criteria'] })),
    judgeArtifact: judge,
    baselinesPath,
  }));
  assert.equal(res.exitCode, EXIT.REGRESSION);
  assert.ok(res.results.every((r) => r.structValid === false && r.regression === true));
  assert.equal(judge.calls.length, 0, 'judge must not run on an invalid artifact');
});

// ── Nothing-selected path ────────────────────────────────────────────────────
test('no cases selected → exit 0, no spend', async () => {
  const produce = fakeProduce(() => cannedArtifact());
  const res = await runEval({}, baseDeps({
    getChangedFiles: async () => ['README.md'], // touches no trigger surface
    produceArtifact: produce,
    judgeArtifact: fakeJudge(1),
  }));
  assert.equal(res.exitCode, EXIT.OK);
  assert.equal(produce.calls.length, 0);
});

// ── EVAL_CASES / baselineKey sanity ─────────────────────────────────────────
test('EVAL_CASES cover both frozen fixtures with the plan task', () => {
  assert.deepEqual(EVAL_CASES.map((c) => c.name).sort(), ['cli-tool', 'tiny-api']);
  assert.ok(EVAL_CASES.every((c) => c.task === 'plan'));
  assert.equal(baselineKey({ name: 'cli-tool', task: 'plan' }), 'cli-tool/plan');
});
