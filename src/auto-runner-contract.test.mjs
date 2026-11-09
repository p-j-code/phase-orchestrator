// Tests for the phase-77 (brief 08 / P1b) output-contract adoption in
// auto-runner.js: the bug-plan fix-plan.json contract (applyFixPlanContract) and
// the plan-creation re-ask now routed through runWithContract (ensureValidPlan).
// No real `claude` subprocess and no real DB write — every spawn goes through an
// injected deps.runClaude / deps.runGuide seam, and setBugRoundFixPlan is stubbed.
//
// Run with: node --test src/auto-runner-contract.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { applyFixPlanContract, ensureValidPlan } from './auto-runner.js';
import { fixPlanJsonPath, planJsonPath } from './lib/guide-paths.js';

async function makeTmpProj() {
  const projDir = path.join(os.tmpdir(), 'aorch-p77-' + randomUUID());
  await fs.mkdir(path.join(projDir, '.guide'), { recursive: true });
  return projDir;
}

function reply(result, sessionId = 'bug-sess') {
  return { result, session_id: sessionId, is_error: false };
}

// A runClaude fake that records opts and can run a side effect (e.g. rewrite the
// artifact the guide would have fixed) per call.
function fakeRunClaude(onCall) {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    if (onCall) await onCall(opts, calls.length - 1);
    return reply('rewrote artifact', opts.sessionId || 'bug-sess');
  };
  return { fn, calls };
}

const VALID_FIX_PLAN = { fixes: [{ n: 1, title: 'fix a', files_likely: ['src/a.js'] }, { n: 2, title: 'fix b' }] };
const MALFORMED_FIX_PLAN = { fixes: [{ title: 'missing n' }] }; // fix entry has no `n`

// ─── bug-plan: applyFixPlanContract ──────────────────────────────────────────

test('applyFixPlanContract: a VALID fix-plan triggers ZERO re-asks and records the plan', async () => {
  const projDir = await makeTmpProj();
  await fs.mkdir(path.dirname(fixPlanJsonPath(projDir, 1)), { recursive: true });
  await fs.writeFile(fixPlanJsonPath(projDir, 1), JSON.stringify(VALID_FIX_PLAN), 'utf-8');

  const { fn, calls } = fakeRunClaude();
  const recorded = [];
  const out = await applyFixPlanContract({
    result: reply('guide wrote the fix plan'), projectName: 'demo', round: 1,
    cfg: { llm_contract: { enabled: true, max_reasks: 1 } }, projDir,
    deps: { runClaude: fn, setBugRoundFixPlan: (r) => recorded.push(r) },
  });

  assert.equal(out.ok, true);
  assert.equal(out.reasks, 0);
  assert.equal(calls.length, 0, 'a valid plan is never re-asked — no spawn');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].total_fixes, 2, 'total_fixes = fixes.length');
  await fs.rm(projDir, { recursive: true, force: true });
});

test('applyFixPlanContract: a MALFORMED fix-plan triggers EXACTLY ONE session-resumed re-ask naming file + errors, then records', async () => {
  const projDir = await makeTmpProj();
  const fpPath = fixPlanJsonPath(projDir, 1);
  await fs.mkdir(path.dirname(fpPath), { recursive: true });
  await fs.writeFile(fpPath, JSON.stringify(MALFORMED_FIX_PLAN), 'utf-8');

  // The re-ask "guide" rewrites the plan to a valid one, as a real resumed
  // session would after being told the ajv errors.
  const { fn, calls } = fakeRunClaude(async () => {
    await fs.writeFile(fpPath, JSON.stringify(VALID_FIX_PLAN), 'utf-8');
  });
  const recorded = [];
  const out = await applyFixPlanContract({
    result: reply('guide wrote a bad fix plan', 'bug-sess-42'), projectName: 'demo', round: 1,
    cfg: { llm_contract: { enabled: true, max_reasks: 1 } }, projDir,
    deps: { runClaude: fn, setBugRoundFixPlan: (r) => recorded.push(r) },
  });

  assert.equal(out.ok, true);
  assert.equal(out.reasks, 1, 'exactly one re-ask');
  assert.equal(calls.length, 1, 'exactly one spawn (the initial attempt reused the existing guide result)');
  assert.equal(calls[0].sessionId, 'bug-sess-42', 're-ask resumes the guide session');
  assert.match(calls[0].prompt, /must have required property/i, 're-ask carries the ajv error');
  assert.match(calls[0].prompt, /round-1\/plan\.json|plan\.json/, 're-ask names the fix-plan file');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].total_fixes, 2);
  await fs.rm(projDir, { recursive: true, force: true });
});

test('applyFixPlanContract: still-malformed after the re-ask → FAIL-OPEN (no throw, no record), re-ask capped at 1', async () => {
  const projDir = await makeTmpProj();
  const fpPath = fixPlanJsonPath(projDir, 3);
  await fs.mkdir(path.dirname(fpPath), { recursive: true });
  await fs.writeFile(fpPath, JSON.stringify(MALFORMED_FIX_PLAN), 'utf-8');

  const { fn, calls } = fakeRunClaude(); // re-ask leaves the bad plan in place
  const recorded = [];
  const out = await applyFixPlanContract({
    result: reply('bad plan'), projectName: 'demo', round: 3,
    cfg: { llm_contract: { enabled: true, max_reasks: 1 } }, projDir,
    deps: { runClaude: fn, setBugRoundFixPlan: (r) => recorded.push(r) },
  });

  assert.equal(out.ok, false, 'contract failed but did not throw — fail-open');
  assert.equal(out.reasks, 1, 're-ask never exceeds max_reasks');
  assert.equal(calls.length, 1);
  assert.equal(recorded.length, 0, 'a still-invalid plan is NOT recorded — the bug cycle re-dispatches as before');
  await fs.rm(projDir, { recursive: true, force: true });
});

test('applyFixPlanContract: enabled:false restores the pre-phase-77 silent read (no spawn) for a valid plan', async () => {
  const projDir = await makeTmpProj();
  const fpPath = fixPlanJsonPath(projDir, 1);
  await fs.mkdir(path.dirname(fpPath), { recursive: true });
  await fs.writeFile(fpPath, JSON.stringify(VALID_FIX_PLAN), 'utf-8');

  const { fn, calls } = fakeRunClaude();
  const recorded = [];
  const out = await applyFixPlanContract({
    result: reply('x'), projectName: 'demo', round: 1,
    cfg: { llm_contract: { enabled: false } }, projDir,
    deps: { runClaude: fn, setBugRoundFixPlan: (r) => recorded.push(r) },
  });

  assert.equal(out.ok, true);
  assert.equal(calls.length, 0, 'enabled:false never spawns a contract re-ask');
  assert.equal(recorded.length, 1);
  await fs.rm(projDir, { recursive: true, force: true });
});

// ─── plan-creation: ensureValidPlan re-ask routed through runWithContract ─────

const VALID_PLAN = { phases: [{ n: 1, title: 'Init', goal: 'Get started', acceptance_criteria: ['repo exists'] }] };
const INVALID_PLAN = { phases: [] }; // empty phases → structural validation failure

test('ensureValidPlan: an invalid plan drives exactly ONE regen (the contract re-ask); the regen writes a valid plan → ok', async () => {
  const projDir = await makeTmpProj();
  await fs.writeFile(planJsonPath(projDir), JSON.stringify(INVALID_PLAN), 'utf-8');

  let regenCalls = 0;
  const runGuide = async ({ task }) => {
    assert.equal(task, 'plan', 'the regen is a fresh `plan` guide call');
    regenCalls += 1;
    await fs.writeFile(planJsonPath(projDir), JSON.stringify(VALID_PLAN), 'utf-8');
    return { is_error: false, session_id: 'plan-sess' };
  };

  const out = await ensureValidPlan({
    projectName: 'demo-p77-plan', projDir, cfg: { llm_contract: { enabled: true, max_reasks: 1 } },
    deps: { runGuide },
  });

  assert.equal(out.ok, true, 'a regenerated valid plan passes');
  assert.equal(regenCalls, 1, 'exactly one auto-regen (the single contract re-ask)');
  assert.equal(out.plan.phases.length, 1);
  // The hint file the re-ask wrote must name the structural problem.
  const hint = await fs.readFile(path.join(projDir, '.guide', 'plan-fix.hint'), 'utf-8');
  assert.match(hint, /phases/, 'the plan-fix hint carries the structural problem list');
  await fs.rm(projDir, { recursive: true, force: true });
});

test('ensureValidPlan: still-invalid after the regen → ok:false carrying the regen result (control flow unchanged)', async () => {
  const projDir = await makeTmpProj();
  await fs.writeFile(planJsonPath(projDir), JSON.stringify(INVALID_PLAN), 'utf-8');

  let regenCalls = 0;
  const runGuide = async () => { regenCalls += 1; return { is_error: false, session_id: 's' }; }; // never fixes it

  const out = await ensureValidPlan({
    projectName: 'demo-p77-plan2', projDir, cfg: { llm_contract: { enabled: true } },
    deps: { runGuide },
  });

  assert.equal(out.ok, false);
  assert.equal(regenCalls, 1, 'still exactly one regen — the structRegenMarker budget is unchanged');
  assert.ok(out.regen, 'the regen result is surfaced to the caller as before');
  assert.match(out.error, /after 1 auto-regen/);
  await fs.rm(projDir, { recursive: true, force: true });
});

test('ensureValidPlan: a valid plan on first read → ok with ZERO regens (no contract spawn)', async () => {
  const projDir = await makeTmpProj();
  await fs.writeFile(planJsonPath(projDir), JSON.stringify(VALID_PLAN), 'utf-8');
  let regenCalls = 0;
  const out = await ensureValidPlan({
    projectName: 'demo-p77-plan3', projDir, cfg: {},
    deps: { runGuide: async () => { regenCalls += 1; return { is_error: false }; } },
  });
  assert.equal(out.ok, true);
  assert.equal(regenCalls, 0, 'a valid plan never triggers the contract re-ask');
  await fs.rm(projDir, { recursive: true, force: true });
});
