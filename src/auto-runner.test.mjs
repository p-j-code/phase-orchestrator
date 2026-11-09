// Regression tests for auto-runner:
//   1. resolveAutoRunSlot — verifies multi-pass cursor advancement
//   2. pickNextAction — verifies continuation-plan infinite-loop fix (Bug 2)
//
// Run: node src/auto-runner.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// Must be set before any module that calls getDb() is loaded.
process.env.DB_PATH = ':memory:';

const {
  resolveAutoRunSlot, pickNextAction, routeDevFailure, isTimeoutError, isTurnBudgetError,
  isCapabilityEscalationFailure,
  decideEscalationHop, isEscalationEligibleThrow, convertThrowToEscalatableResult,
  _acquireAutoRunMutex, _releaseAutoRunMutex, ensureValidPlan,
  checkStaleBriefGuard, buildPhaseCompletionNotifyText,
  notifyContextDriftIfAny, notifyGuideRegroundIfAny,
  applyReviewGatingOverrides, tryReviewAutoProceed,
  lessonFilesForAction, sweepStaleWorktrees,
  applyTelemetryRoutingFloors, shouldRunFailureAutopsy,
  scheduleProviderLimitResume,
  buildTurnPredictionConfig, effectiveTurnBudgetCeiling, popNextBriefFromQueue,
} = await import('./auto-runner.js');
const { formatVerifyOutcomeLine } = await import('./lib/phase-runner.js');
const { escalationMarkerPath } = await import('./lib/escalation.js');
const { reviewPath, planJsonPath, fixPlanJsonPath, bugRoundDir, briefConformancePath, worktreesRoot } = await import('./lib/guide-paths.js');
const { addDetachedWorktree, getHeadSha } = await import('./lib/git.js');
const {
  upsertProject, setProjectStatus, setCurrentPhase, getProject,
  upsertPhase, markPhaseCompleted,
  saveSuggestions, acceptSuggestions,
  getLatestSuggestions,
  claimRunningJob, releaseRunningJob, getRunningJob,
  recordHealingAttempt, updateHealingStatus, getDb,
  countRecentFailedHealingByKinds,
  recordCall, recentCallsForProjectTask,
} = await import('./state.js');
const { briefHash, checkBriefDrift } = await import('./lib/brief-manager.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

// ─── helpers ────────────────────────────────────────────────────────────────

function setupProject(name, opts = {}) {
  upsertProject({ name, tech_stack: 'node', total_phases: opts.totalPhases ?? 3 });
  if (opts.status) setProjectStatus(name, opts.status);
}

function saveAndAccept(projectName, pipelinePlan, passes) {
  const id = saveSuggestions(projectName, {
    projectType: 'cli',
    scanSnapshot: { projectType: 'cli' },
    suggestions: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }],
  });
  acceptSuggestions(id, {
    selected: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    pipelinePlan,
    pipelinePasses: passes,
  });
}

// ─── Test 1: explicit number returned verbatim, cursor not touched ────────────

test('explicit number (1) returned verbatim; cursor not touched on ready-for-qa 2-pass plan', async () => {
  const name = 'ras-explicit-1';
  setupProject(name, { status: 'ready-for-qa' });
  saveAndAccept(name, { '1': ['a', 'b'], '2': ['c'] }, 2);
  assert.equal(getLatestSuggestions(name).next_pass, 1, 'cursor starts at 1');

  const result = await resolveAutoRunSlot(name, 1);

  assert.equal(result, 1, 'should return 1 verbatim');
  assert.equal(getLatestSuggestions(name).next_pass, 1, 'cursor must not advance for explicit number');
});

test('buildTurnPredictionConfig is opt-in and preserves portfolio samples', () => {
  assert.equal(buildTurnPredictionConfig({ phases: {} }, [{ actual_turns: 50 }]), null);
  const samples = [{ actual_turns: 50, provider_error: 0 }];
  const policy = buildTurnPredictionConfig({
    phases: { turn_prediction: { enabled: true, max_predicted_turns: 44, min_samples: 10 } },
  }, samples);
  assert.equal(policy.max_predicted_turns, 44);
  assert.equal(policy.min_samples, 10);
  assert.equal(policy.enforce_heuristic, false);
  assert.equal(policy.samples, samples);
});

test('turn-prediction target tracks the project turn budget, never blocking a within-budget phase', () => {
  // Budget ceiling = MAX across per-complexity budgets + per-phase/tier caps.
  assert.equal(effectiveTurnBudgetCeiling({ phases: {
    turn_budget_by_complexity: { low: 45, medium: 60, high: 60, critical: 60 },
    max_turns_per_tier: { sonnet: 60, opus: 60, fable: 60 }, max_turns_per_opus_phase: 60,
  } }), 60, 'default-shaped budgets → 60');
  assert.equal(effectiveTurnBudgetCeiling({ phases: {
    turn_budget_by_complexity: { low: 90, medium: 140 }, max_turns_per_opus_phase: 120,
  } }), 140, 'acf-shaped raised budgets → 140');
  assert.equal(effectiveTurnBudgetCeiling({ phases: {} }), 0, 'no budget config → 0');

  const samples = [{ actual_turns: 50, provider_error: 0 }];
  // Raised-budget project (acf): the fixed 45 default target follows the 140 budget,
  // so its 90-140-turn phases are no longer false-positive-rejected by plan validation.
  const acf = buildTurnPredictionConfig({ phases: {
    turn_prediction: { enabled: true, max_predicted_turns: 45 },
    turn_budget_by_complexity: { low: 90, medium: 140 }, max_turns_per_opus_phase: 120,
  } }, samples);
  assert.equal(acf.max_predicted_turns, 140, 'raised-budget project: target follows the 140 budget');

  // Default project: target aligns with its own 60 budget (not the bare 45).
  const dflt = buildTurnPredictionConfig({ phases: {
    turn_prediction: { enabled: true, max_predicted_turns: 45 },
    turn_budget_by_complexity: { low: 45, medium: 60, high: 60, critical: 60 },
  } }, samples);
  assert.equal(dflt.max_predicted_turns, 60, 'default project: target aligns with its 60 budget');

  // An explicit target ABOVE the budget still wins (can raise, never forced down).
  const explicitHigh = buildTurnPredictionConfig({ phases: {
    turn_prediction: { enabled: true, max_predicted_turns: 200 },
    turn_budget_by_complexity: { low: 45, medium: 60 },
  } }, samples);
  assert.equal(explicitHigh.max_predicted_turns, 200, 'explicit target above budget is preserved');

  // No budget config at all → falls back to the configured/default 45.
  const bare = buildTurnPredictionConfig({ phases: {
    turn_prediction: { enabled: true, max_predicted_turns: 45 },
  } }, samples);
  assert.equal(bare.max_predicted_turns, 45, 'no budget config → stays at 45');
});

// ─── Test 2: null → cursor advances 1→2 for ready-for-qa 2-pass plan ─────────

test('null → cursor advances 1→2 for ready-for-qa project with 2-pass plan', async () => {
  const name = 'ras-advance-null';
  setupProject(name, { status: 'ready-for-qa' });
  saveAndAccept(name, { '1': ['a', 'b'], '2': ['c'] }, 2);
  assert.equal(getLatestSuggestions(name).next_pass, 1, 'cursor starts at 1');

  const result = await resolveAutoRunSlot(name, null);

  assert.equal(result, 2, 'should return 2 after cursor advancement');
  assert.equal(getLatestSuggestions(name).next_pass, 2, 'DB cursor must be advanced to 2');
});

// ─── Test 3: null → stays 1 for in-progress project (no advance mid-build) ──

test('null → stays 1 for in-progress project (no advance mid-build)', async () => {
  const name = 'ras-inprogress';
  setupProject(name, { status: 'in-progress' });
  saveAndAccept(name, { '1': ['a', 'b'], '2': ['c'] }, 2);
  assert.equal(getLatestSuggestions(name).next_pass, 1, 'cursor starts at 1');

  const result = await resolveAutoRunSlot(name, null);

  assert.equal(result, 1, 'should return 1 — no advance while in-progress');
  assert.equal(getLatestSuggestions(name).next_pass, 1, 'cursor should not advance mid-build');
});

// ─── Test 4: null → returns 1 when no accepted suggestions plan ──────────────

test('null → returns 1 when no accepted suggestions plan exists', async () => {
  const name = 'ras-no-plan';
  setupProject(name, { status: 'ready-for-qa' });
  // No saveAndAccept call — project has no suggestions rows

  const result = await resolveAutoRunSlot(name, null);

  assert.equal(result, 1, 'should return 1 when no plan exists');
});

// ─── Test 5: explicit number 2 returned verbatim, cursor not touched ──────────

test('explicit number (2) returned verbatim without touching DB cursor', async () => {
  const name = 'ras-explicit-2';
  setupProject(name, { status: 'ready-for-qa' });
  saveAndAccept(name, { '1': ['a', 'b'], '2': ['c'] }, 2);
  assert.equal(getLatestSuggestions(name).next_pass, 1, 'cursor starts at 1');

  const result = await resolveAutoRunSlot(name, 2);

  assert.equal(result, 2, 'should return 2 verbatim');
  assert.equal(getLatestSuggestions(name).next_pass, 1, 'cursor must not advance for explicit number');
});

// ─── Helpers for pickNextAction (Bug 2) tests ─────────────────────────────────

// Minimal cfg that satisfies all paths pickNextAction reads
// without triggering workspace-claude-md generation or skip-analyze.
const MINIMAL_CFG = {
  auto_run: {
    run_final_review_before_qa: false,
    audit_runs_after_completion: 0,
    warn_on_missing_phase_report: false,
    auto_pause_after_phase_1: false,
  },
  phases: {
    review_every_n_phases: 999, // disable mid-stream review
  },
  paths: {
    workspace_subdir: 'workspace',
  },
  workspace_claude_md: {
    auto_generate_during_autorun: false,
  },
  skip_analyze: {
    enabled: false, // disable periodic skip-analyze so it doesn't try to git-log
  },
  brief_conformance: {
    enabled: false, // disable the phase-47 gate so unrelated "all phases done" tests stay isolated
  },
};

// Same, but with the brief-chain enabled so the all-phases-done path pops the
// next queued brief instead of pausing. audit_before_chain:false so it skips the
// completion-audit gate and goes straight to the pop + notifier ping.
const CHAIN_CFG = {
  ...MINIMAL_CFG,
  auto_run: {
    ...MINIMAL_CFG.auto_run,
    auto_brief_chain: { enabled: true, brief_queue_dir: 'inputs/queue', audit_before_chain: false },
  },
};

/**
 * Write plan.json to the project's .guide directory.
 * Returns the projDir and guideDir paths.
 */
async function writePlanJson(projectName, plan) {
  const projDir = path.join(PROJECTS_DIR, projectName);
  const guideDir = path.join(projDir, '.guide');
  await fs.mkdir(guideDir, { recursive: true });
  await fs.writeFile(path.join(guideDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf-8');
  // Also create a brief.md to satisfy the brief guard
  const briefFile = path.join(guideDir, 'brief.md');
  try { await fs.access(briefFile); } catch {
    await fs.writeFile(briefFile, '# Test brief\n\nTest project.', 'utf-8');
  }
  // Also create project-context.md to skip the project-context-gen action
  const ctxFile = path.join(guideDir, 'project-context.md');
  try { await fs.access(ctxFile); } catch {
    await fs.writeFile(ctxFile, '# Context\n\nTest.', 'utf-8');
  }
  return { projDir, guideDir };
}

async function cleanupProject(projectName) {
  const projDir = path.join(PROJECTS_DIR, projectName);
  try { await fs.rm(projDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ─── Test 6: Bug 2 — all plan phases n ≤ completedPhase AND all are in DB as
//             completed → must return wait-for-human (NOT attempt renumbering) ──

test('pickNextAction: all plan phases done in DB → returns wait-for-human (no infinite-loop renumbering)', async () => {
  const name = 'pna-all-done';
  // Plan has phases 1, 2, 3 — all n <= completedPhase=3
  const plan = {
    phases: [
      { n: 1, title: 'Phase 1' },
      { n: 2, title: 'Phase 2' },
      { n: 3, title: 'Phase 3' },
    ],
  };

  try {
    await writePlanJson(name, plan);

    // Set up project with current_phase=3 (all done)
    upsertProject({ name, tech_stack: 'node', total_phases: 3, status: 'in-progress' });
    setCurrentPhase(name, 3);

    // Insert all three phases as completed in the DB
    for (const p of plan.phases) {
      upsertPhase({ project: name, n: p.n, title: p.title, status: 'pending' });
      markPhaseCompleted({ project: name, n: p.n, commit_sha: `sha${p.n}` });
    }

    const result = await pickNextAction(name, MINIMAL_CFG);

    // The continuation-numbering guard fires (all n <= completedPhase=3),
    // but must detect all phases already have completed DB rows and skip
    // renumbering, falling through to "all phases done" → wait-for-human.
    assert.equal(result.kind, 'wait-for-human',
      `expected wait-for-human but got: ${JSON.stringify(result)}`);
  } finally {
    await cleanupProject(name);
  }
});

// ─── Regression: brief-chain handoff must not throw `notifier is not defined` ──
// pickNextAction called `notifier?.(...)` at the pop site, but `notifier` was
// never in scope (optional chaining guards a null VALUE, not an undeclared
// identifier). It's now threaded in via rewindCtx.notifier. With a queued brief
// and the chain enabled, the all-phases-done path must pop the brief, return a
// plan action, and ping the notifier exactly once — not crash the run.
test('pickNextAction: all phases done + queued brief → pops next brief, returns plan action, pings notifier (regression: notifier ReferenceError)', async () => {
  const name = 'pna-brief-chain';
  const plan = {
    phases: [
      { n: 1, title: 'Phase 1' },
      { n: 2, title: 'Phase 2' },
      { n: 3, title: 'Phase 3' },
    ],
  };
  const sent = [];
  const notifier = (msg) => { sent.push(msg); };

  try {
    await writePlanJson(name, plan);

    // Stage a queued next brief that the chain should pop.
    const queueDir = path.join(PROJECTS_DIR, name, 'inputs', 'queue');
    await fs.mkdir(queueDir, { recursive: true });
    await fs.writeFile(path.join(queueDir, '01-next-brief.md'), '# Next brief\n\nThe next thing.', 'utf-8');

    upsertProject({ name, tech_stack: 'node', total_phases: 3, status: 'in-progress' });
    setCurrentPhase(name, 3);
    for (const p of plan.phases) {
      upsertPhase({ project: name, n: p.n, title: p.title, status: 'pending' });
      markPhaseCompleted({ project: name, n: p.n, commit_sha: `sha${p.n}` });
    }

    // Before the fix this threw `ReferenceError: notifier is not defined`.
    const result = await pickNextAction(name, CHAIN_CFG, { notifier });

    assert.equal(result.kind, 'guide', `expected guide plan action, got: ${JSON.stringify(result)}`);
    assert.equal(result.task, 'plan', `expected task=plan, got: ${JSON.stringify(result)}`);
    assert.equal(sent.length, 1, `expected exactly one notifier ping, got ${sent.length}: ${JSON.stringify(sent)}`);
    assert.ok(sent[0].includes('Brief chain'), `notifier text should mention the brief chain: ${sent[0]}`);

    // The queued brief was installed into inputs/brief.md.
    const installed = await fs.readFile(path.join(PROJECTS_DIR, name, 'inputs', 'brief.md'), 'utf-8');
    assert.ok(installed.includes('The next thing.'), 'queued brief installed into inputs/brief.md');
  } finally {
    await cleanupProject(name);
  }
});

// ─── Test 7: Bug 2 — all plan phases n ≤ completedPhase but plan phases have
//             NO completed DB rows → SHOULD renumber (legitimate continuation plan) ──
//
// Scenario: prior work (phases 4, 5) is done. Guide outputs a "continuation plan"
// re-numbered from 1 (plan phases n=1,2,3 — brand new tasks). The DB only has
// n=4 and n=5 as completed; n=1,2,3 are absent (no rows). completedPhase=5.
// The guard fires (all plan n=1,2,3 are <= 5), but allPlanPhasesCompleted=false
// because no DB row with n=1, 2, or 3 exists as completed → renumber proceeds.
// After renumbering the phases become n=6,7,8 → first available > completedPhase=5
// → should return a dev or guide action for phase 6.

test('pickNextAction: all plan phases n ≤ completedPhase but plan phases absent from DB → renumbers and returns dev/guide action', async () => {
  const name = 'pna-needs-renumber';
  // Plan has n=1,2,3 — the guide re-used low numbers for brand-new continuation work
  const plan = {
    phases: [
      { n: 1, title: 'New Phase A' },
      { n: 2, title: 'New Phase B' },
      { n: 3, title: 'New Phase C' },
    ],
  };

  try {
    await writePlanJson(name, plan);

    // current_phase=5; only phases 4 and 5 exist in DB (NOT 1,2,3)
    upsertProject({ name, tech_stack: 'node', total_phases: 3, status: 'in-progress' });
    setCurrentPhase(name, 5);
    upsertPhase({ project: name, n: 4, title: 'Old Phase 4', status: 'pending' });
    markPhaseCompleted({ project: name, n: 4, commit_sha: 'oldsha4' });
    upsertPhase({ project: name, n: 5, title: 'Old Phase 5', status: 'pending' });
    markPhaseCompleted({ project: name, n: 5, commit_sha: 'oldsha5' });

    const result = await pickNextAction(name, MINIMAL_CFG);

    // The guard fires (plan n=1,2,3 all <= completedPhase=5).
    // allPlanPhasesCompleted=false (n=1,2,3 absent from DB) → renumber to n=6,7,8.
    // First renumbered phase (n=6) > completedPhase=5 → should be a dev/guide action.
    assert.ok(
      result.kind === 'dev' || result.kind === 'guide',
      `expected kind to be 'dev' or 'guide' after legitimate renumbering; got: ${JSON.stringify(result)}`,
    );
    // The renumbered first phase should be n = 1 + completedPhase = 6
    if (result.phaseN !== undefined) {
      assert.equal(result.phaseN, 6,
        `expected phaseN=6 after renumbering (offset by completedPhase=5); got phaseN=${result.phaseN}`);
    }
  } finally {
    await cleanupProject(name);
  }
});

// ─── Phase 8 — timeout-vs-heal routing (isTimeoutError / routeDevFailure) ─────
//
// The core fix: a dev/fix TIMEOUT must route to one compact reprompt → pause and
// must NEVER reach healer.heal() (heal classifies a timeout as phase-stuck,
// resets the phase, and short-circuits the reprompt path). Operational failures
// still route to heal.

test('isTimeoutError matches all four runner kill signatures', () => {
  assert.ok(isTimeoutError('claude subprocess timed out after 30m (signal: SIGTERM).'));
  assert.ok(isTimeoutError('claude subprocess stalled — no output for 5m (signal: SIGTERM).'));
  assert.ok(isTimeoutError('tool call hung for 5m (tool: Bash, signal: SIGTERM).'));
  assert.ok(isTimeoutError('turn stalled — no completion for 20m (signal: SIGTERM).'));
});

test('isTimeoutError does NOT match operational failures', () => {
  assert.ok(!isTimeoutError('Phase 5 completed without committing any changes.'));
  assert.ok(!isTimeoutError('validators failed: tsc, eslint'));
  assert.ok(!isTimeoutError('Git pre-flight failed: dirty workspace'));
  assert.ok(!isTimeoutError(''));
  assert.ok(!isTimeoutError(null));
});

test('routeDevFailure: dev timeout with reprompt budget → reprompt (not heal)', () => {
  const r = routeDevFailure({
    errMsg: 'claude subprocess timed out after 30m', actionKind: 'dev',
    repromptsDone: 0, maxReprompts: 2,
  });
  assert.equal(r, 'reprompt');
});

test('routeDevFailure: dev timeout, reprompts exhausted → pause without model escalation', () => {
  const r = routeDevFailure({
    errMsg: 'stalled — no output for 5m', actionKind: 'dev',
    repromptsDone: 2, maxReprompts: 2,
  });
  assert.equal(r, 'pause');
});

test('routeDevFailure: dev timeout, reprompts + Opus retry both spent → pause', () => {
  const r = routeDevFailure({
    errMsg: 'timed out after 30m', actionKind: 'dev',
    repromptsDone: 2, maxReprompts: 2, escalateAlreadyTried: true,
  });
  assert.equal(r, 'pause');
});

test('routeDevFailure: dev timeout with reprompt DISABLED → pause immediately', () => {
  const r = routeDevFailure({
    errMsg: 'timed out after 30m', actionKind: 'dev', repromptEnabled: false,
  });
  assert.equal(r, 'pause');
});

test('routeDevFailure: fix-dev timeout → pause (fixes have no reprompt flow)', () => {
  const r = routeDevFailure({
    errMsg: 'tool call hung for 5m', actionKind: 'fix-dev',
  });
  assert.equal(r, 'pause');
});

test('routeDevFailure: max-turn exhaustion gets one same-tier reprompt and never Opus', () => {
  assert.equal(isTurnBudgetError('Ended with subtype: error_max_turns'), true);
  assert.equal(routeDevFailure({
    errMsg: 'Ended with subtype: error_max_turns', actionKind: 'dev',
    repromptsDone: 0, maxReprompts: 1,
  }), 'reprompt');
  assert.equal(routeDevFailure({
    errMsg: 'Ended with subtype: error_max_turns', actionKind: 'dev',
    repromptsDone: 1, maxReprompts: 1,
  }), 'pause');
  assert.equal(isCapabilityEscalationFailure('Ended with subtype: error_max_turns'), false);
});

test('routeDevFailure: operational dev failure → heal (not reprompt/escalate)', () => {
  const r = routeDevFailure({
    errMsg: 'Phase 5 completed without committing any changes', actionKind: 'dev',
  });
  assert.equal(r, 'heal');
});

test('routeDevFailure: operational fix failure → heal', () => {
  const r = routeDevFailure({
    errMsg: 'committed but failed the validator gate', actionKind: 'fix-dev',
  });
  assert.equal(r, 'heal');
});

test('routeDevFailure: operational failure with heal DISABLED → escalate', () => {
  const r = routeDevFailure({
    errMsg: 'no commit produced', actionKind: 'dev', healEnabled: false,
  });
  assert.equal(r, 'escalate');
});

test('routeDevFailure: transient operational failure with heal disabled → pause', () => {
  const r = routeDevFailure({
    errMsg: 'ECONNRESET socket', actionKind: 'dev', healEnabled: false, isTransient: true,
  });
  assert.equal(r, 'pause');
});

test('routeDevFailure: provider rate limit pauses immediately even when healing is enabled', () => {
  const r = routeDevFailure({
    errMsg: 'rate_limit_event: five_hour window exhausted', actionKind: 'dev', healEnabled: true,
  });
  assert.equal(r, 'pause');
});

test('scheduleProviderLimitResume: persists one exact reset-time unattended resume', () => {
  const enqueued = [];
  const db = { prepare: () => ({ get: () => undefined }) };
  const resetMs = Date.UTC(2026, 6, 16, 19, 10, 0);
  const out = scheduleProviderLimitResume({
    projectName: 'aoa',
    reason: "You've hit your session limit · resets 12:40am (Asia/Calcutta)",
  }, {
    db, nowMs: resetMs - 30 * 60_000,
    getRateLimitRetryAt: () => resetMs,
    enqueueRetryJob: (job) => { enqueued.push(job); return 77; },
  });
  assert.equal(out.scheduled, true);
  assert.equal(out.jobId, 77);
  assert.equal(out.notBefore.getTime(), resetMs);
  assert.equal(enqueued.length, 1);
  assert.deepEqual(enqueued[0].args, { unattended: true });
  assert.equal(enqueued[0].action, 'resume');
});

test('scheduleProviderLimitResume: existing pending resume makes scheduling idempotent', () => {
  let enqueues = 0;
  const out = scheduleProviderLimitResume({
    projectName: 'acf', reason: 'usage limit reached',
  }, {
    db: { prepare: () => ({ get: () => ({ id: 42 }) }) },
    enqueueRetryJob: () => { enqueues += 1; },
  });
  assert.deepEqual(out, { scheduled: false, reason: 'already-scheduled', jobId: 42 });
  assert.equal(enqueues, 0);
});

// ─── phase-23 — decideEscalationHop (bounded hops + fable billing gate) ────────

test('decideEscalationHop: max_escalation_hops:2 grants exactly two retries then pauses (hop Map, not Set)', () => {
  const hops = new Map();          // escKey → hopCount — the SAME shape the loop uses
  const escKey = 'phase-5';
  const decide = () => decideEscalationHop({
    targetTier: 'opus', hopCount: hops.get(escKey) || 0, maxHops: 2,
  });

  // 1st failure → grant, loop bumps the Map to 1
  let d = decide();
  assert.equal(d.action, 'grant');
  hops.set(escKey, (hops.get(escKey) || 0) + 1);

  // 2nd failure → grant, Map bumps to 2
  d = decide();
  assert.equal(d.action, 'grant');
  hops.set(escKey, (hops.get(escKey) || 0) + 1);
  assert.equal(hops.get(escKey), 2, 'the hop Map records exactly two granted retries');

  // 3rd failure → budget exhausted → pause
  d = decide();
  assert.equal(d.action, 'pause');
});

test('decideEscalationHop: a would-be fable hop is SKIPPED when the billing window is not ok (injected stub)', () => {
  const d = decideEscalationHop({
    targetTier: 'fable', hopCount: 0, maxHops: 2,
    cfg: {}, deps: { windowStatus: () => ({ state: 'warn' }) },
  });
  assert.equal(d.action, 'skip-billing');
  assert.equal(d.state, 'warn');
});

test('decideEscalationHop: a fable hop is granted when the billing window is ok', () => {
  const d = decideEscalationHop({
    targetTier: 'fable', hopCount: 0, maxHops: 2,
    cfg: {}, deps: { windowStatus: () => ({ state: 'ok' }) },
  });
  assert.equal(d.action, 'grant');
});

test('decideEscalationHop: a non-fable hop never consults the billing window', () => {
  let consulted = false;
  const d = decideEscalationHop({
    targetTier: 'opus', hopCount: 0, maxHops: 2,
    deps: { windowStatus: () => { consulted = true; return { state: 'pause' }; } },
  });
  assert.equal(d.action, 'grant');
  assert.equal(consulted, false, 'billing gate applies only to fable hops');
});

test('decideEscalationHop: null target (top-rung/fable failure) → pause, no marker to retry on', () => {
  assert.equal(decideEscalationHop({ targetTier: null, hopCount: 0, maxHops: 2 }).action, 'pause');
});

test('decideEscalationHop: escalation disabled → pause', () => {
  assert.equal(decideEscalationHop({ targetTier: 'opus', escalateEnabled: false }).action, 'pause');
});

// Source-level guard: every escalation-marker WRITE now goes through the single
// helper (which writes the new `*-escalate.marker` name). No `writeFile`/
// `appendFile` on the legacy `*-escalate-opus.marker` may remain anywhere in
// src/. Read-side legacy handling (readFile / unlink / path builders) may still
// reference the name — that's back-compat, not a write.
test('no escalate-opus.marker WRITE literal remains in src/ (read-side back-compat allowed)', async () => {
  const SRC = path.join(REPO_ROOT, 'src');
  const offenders = [];
  async function walk(dir) {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { await walk(p); continue; }
      if (!ent.name.endsWith('.js')) continue;              // skip .mjs tests
      const src = await fs.readFile(p, 'utf-8');
      src.split('\n').forEach((line, i) => {
        if (/escalate-opus\.marker/.test(line) && /\b(writeFile|appendFile)\b/.test(line)) {
          offenders.push(`${path.relative(REPO_ROOT, p)}:${i + 1}`);
        }
      });
    }
  }
  await walk(SRC);
  assert.deepEqual(offenders, [], `escalate-opus.marker write literal(s) still present at: ${offenders.join(', ')}`);
});

// ─── Phase 41 (CE-9) — lessonFilesForAction: reprompt/escalation lessons carry files ─
// The reprompt & escalation recordLesson sites used to record files:[], crippling
// lessons.js's x10 file-overlap signal. lessonFilesForAction resolves the phase's
// files_expected (phases) or the round-plan entry's files (fixes), best-effort.

async function makeLessonFilesProjDir(label) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), `aorch-lessonfiles-${label}-`));
  await fs.mkdir(path.join(d, '.guide'), { recursive: true });
  return d;
}

test('lessonFilesForAction: a dev/phase action resolves the phase entry\'s files_expected from plan.json', async () => {
  const projDir = await makeLessonFilesProjDir('phase');
  await fs.writeFile(planJsonPath(projDir), JSON.stringify({
    phases: [{ n: 5, title: 'X', files_expected: ['src/lib/phase-runner.js', 'src/auto-runner.js'] }],
  }), 'utf-8');
  const files = await lessonFilesForAction(projDir, { kind: 'dev', phaseN: 5 });
  assert.deepEqual(files, ['src/lib/phase-runner.js', 'src/auto-runner.js']);
});

test('lessonFilesForAction: a fix-dev action resolves the round-plan entry\'s files (raw field `files`)', async () => {
  const projDir = await makeLessonFilesProjDir('fix');
  await fs.mkdir(bugRoundDir(projDir, 2), { recursive: true });
  await fs.writeFile(fixPlanJsonPath(projDir, 2), JSON.stringify({
    fixes: [{ n: 3, title: 'Y', files: ['src/lib/audit-promote.js'] }],
  }), 'utf-8');
  const files = await lessonFilesForAction(projDir, { kind: 'fix-dev', fix: { round: 2, n: 3 } });
  assert.deepEqual(files, ['src/lib/audit-promote.js']);
});

test('lessonFilesForAction: a fix-dev action also tolerates the canonical `files_likely` field', async () => {
  const projDir = await makeLessonFilesProjDir('fixlikely');
  await fs.mkdir(bugRoundDir(projDir, 1), { recursive: true });
  await fs.writeFile(fixPlanJsonPath(projDir, 1), JSON.stringify({
    fixes: [{ n: 1, files_likely: ['src/lib/lessons.js'] }],
  }), 'utf-8');
  const files = await lessonFilesForAction(projDir, { kind: 'fix-dev', fix: { round: 1, n: 1 } });
  assert.deepEqual(files, ['src/lib/lessons.js']);
});

test('lessonFilesForAction: unreadable/absent plan → [] (best-effort, never throws)', async () => {
  const projDir = await makeLessonFilesProjDir('noplan');
  const phaseFiles = await lessonFilesForAction(projDir, { kind: 'dev', phaseN: 5 });
  assert.deepEqual(phaseFiles, []);
  const fixFiles = await lessonFilesForAction(projDir, { kind: 'fix-dev', fix: { round: 9, n: 9 } });
  assert.deepEqual(fixFiles, []);
  // A phase not present in a readable plan → also [].
  await fs.writeFile(planJsonPath(projDir), JSON.stringify({ phases: [{ n: 1, files_expected: ['a.js'] }] }), 'utf-8');
  assert.deepEqual(await lessonFilesForAction(projDir, { kind: 'dev', phaseN: 7 }), []);
});

// ─── Phase 10 — autoRun mutex (_acquireAutoRunMutex / _releaseAutoRunMutex) ───

test('mutex: _acquireAutoRunMutex rejects a live concurrent claim (live PID in DB)', async () => {
  const proj = 'mutex-live-' + randomUUID().slice(0, 8);
  // Insert a running_jobs row with the current process's PID — definitely alive.
  claimRunningJob(proj, process.pid);
  try {
    await assert.rejects(
      () => _acquireAutoRunMutex(proj),
      (err) => {
        assert.ok(
          /autoRun already running for .* \(PID \d+\)/.test(err.message),
          `expected 'already running' error, got: ${err.message}`,
        );
        return true;
      },
    );
  } finally {
    releaseRunningJob(proj);
  }
});

test('mutex: _acquireAutoRunMutex reclaims a stale dead-pid row (ESRCH)', async () => {
  const proj = 'mutex-dead-' + randomUUID().slice(0, 8);
  // Insert a row with a PID that can never exist on any POSIX platform.
  claimRunningJob(proj, 99999999);
  try {
    await _acquireAutoRunMutex(proj);
    const row = getRunningJob(proj);
    assert.ok(row != null, 'row should exist after reclaim');
    assert.equal(row.pid, process.pid, 'pid should be updated to current process pid');
  } finally {
    _releaseAutoRunMutex(proj);
  }
  assert.equal(getRunningJob(proj), undefined, 'row should be gone after _releaseAutoRunMutex');
});

test('mutex: _acquireAutoRunMutex + _releaseAutoRunMutex: re-acquire succeeds after release', async () => {
  const proj = 'mutex-reacquire-' + randomUUID().slice(0, 8);
  await _acquireAutoRunMutex(proj);
  assert.ok(getRunningJob(proj) != null, 'row should exist after first claim');
  _releaseAutoRunMutex(proj);
  assert.equal(getRunningJob(proj), undefined, 'row should be gone after release');
  // Re-acquire should succeed
  await _acquireAutoRunMutex(proj);
  assert.ok(getRunningJob(proj) != null, 'row should exist after re-acquire');
  _releaseAutoRunMutex(proj);
});

test('mutex: in-process Map rejects concurrent claim from the same process without touching DB', async () => {
  const proj = 'mutex-inproc-' + randomUUID().slice(0, 8);
  await _acquireAutoRunMutex(proj);
  try {
    await assert.rejects(
      () => _acquireAutoRunMutex(proj),
      (err) => {
        assert.ok(err.message.includes('autoRun already running'), `expected already-running error, got: ${err.message}`);
        return true;
      },
      'in-process second claim must throw without needing a DB check',
    );
  } finally {
    _releaseAutoRunMutex(proj);
  }
});

// ─── Phase 10 — ensureValidPlan struct-regen sentinel ────────────────────────

function makeTmpGuideDir() {
  const d = path.join(os.tmpdir(), 'aorch-p10-test-' + randomUUID());
  return d;
}

const VALID_PLAN = {
  phases: [{ n: 1, title: 'Init', goal: 'Get started', acceptance_criteria: ['repo exists'] }],
};

const INVALID_PLAN = { phases: [] }; // empty phases → structural validation failure

test('ensureValidPlan: pre-written struct-regen sentinel blocks second regen (returns manual-fix error)', async () => {
  const projDir = makeTmpGuideDir();
  const guideDir = path.join(projDir, '.guide');
  await fs.mkdir(guideDir, { recursive: true });
  await fs.writeFile(path.join(guideDir, 'plan.json'), JSON.stringify(INVALID_PLAN), 'utf-8');
  // Simulate a prior regen attempt by pre-writing the sentinel.
  await fs.writeFile(path.join(guideDir, '.plan-struct-regen-attempted'), new Date().toISOString(), 'utf-8');

  const result = await ensureValidPlan({ projectName: 'doesnotmatter', projDir });

  assert.equal(result.ok, false, 'must return ok:false when sentinel present');
  assert.ok(
    result.error?.includes('manual fix required'),
    `expected manual-fix error, got: ${result.error}`,
  );
  // Sentinel must still exist (we did NOT clear it — only a clean plan clears it).
  try {
    await fs.access(path.join(guideDir, '.plan-struct-regen-attempted'));
    assert.ok(true, 'sentinel still present after manual-fix return');
  } catch {
    assert.fail('sentinel was unexpectedly deleted');
  }
  await fs.rm(projDir, { recursive: true, force: true });
});

test('ensureValidPlan: valid plan clears both regen sentinels', async () => {
  const projDir = makeTmpGuideDir();
  const guideDir = path.join(projDir, '.guide');
  await fs.mkdir(guideDir, { recursive: true });
  await fs.writeFile(path.join(guideDir, 'plan.json'), JSON.stringify(VALID_PLAN), 'utf-8');
  // Write both sentinels as if a prior pair of regen attempts happened.
  await fs.writeFile(path.join(guideDir, '.plan-struct-regen-attempted'), 'old', 'utf-8');
  await fs.writeFile(path.join(guideDir, '.coverage-regen-attempted'), 'old', 'utf-8');

  const result = await ensureValidPlan({ projectName: 'doesnotmatter2', projDir });

  assert.equal(result.ok, true, 'must return ok:true for a valid plan');
  assert.ok(result.plan != null, 'must return the parsed plan');

  // Allow the fire-and-forget unlink to settle.
  await new Promise((r) => setTimeout(r, 50));

  for (const sentinel of ['.plan-struct-regen-attempted', '.coverage-regen-attempted']) {
    try {
      await fs.access(path.join(guideDir, sentinel));
      assert.fail(`sentinel ${sentinel} should have been deleted on valid plan`);
    } catch (e) {
      if (e.code !== 'ENOENT') assert.fail(`unexpected error checking ${sentinel}: ${e.code}`);
      // ENOENT = file deleted = correct
    }
  }
  await fs.rm(projDir, { recursive: true, force: true });
});

test('popNextBriefFromQueue: installing a chained brief clears stale regen sentinels + hint', async () => {
  const name = 'pnbfq-sentinels';
  setupProject(name);
  const projDir = makeTmpGuideDir();
  const guideDir = path.join(projDir, '.guide');
  const queueDir = path.join(projDir, 'inputs', 'queue');
  await fs.mkdir(guideDir, { recursive: true });
  await fs.mkdir(queueDir, { recursive: true });
  // Prior brief's plan + brief and its STALE one-shot regen budget markers/hint.
  await fs.writeFile(path.join(guideDir, 'plan.json'), JSON.stringify(VALID_PLAN), 'utf-8');
  await fs.writeFile(path.join(guideDir, 'brief.md'), '# old brief', 'utf-8');
  await fs.writeFile(path.join(guideDir, '.plan-struct-regen-attempted'), 'old', 'utf-8');
  await fs.writeFile(path.join(guideDir, '.coverage-regen-attempted'), 'old', 'utf-8');
  await fs.writeFile(path.join(guideDir, 'plan-fix.hint'), 'stale hint from prior brief', 'utf-8');
  // Next brief queued.
  await fs.writeFile(path.join(queueDir, '01-next.md'), '# next brief', 'utf-8');

  const cfg = { auto_run: { auto_brief_chain: { enabled: true, brief_queue_dir: 'inputs/queue' } } };
  const result = await popNextBriefFromQueue(projDir, name, cfg);

  assert.equal(result?.briefName, '01-next.md', 'returns the installed brief name');
  assert.equal(await fs.readFile(path.join(guideDir, 'brief.md'), 'utf-8'), '# next brief', 'guide brief installed');
  assert.equal(await fs.readFile(path.join(projDir, 'inputs', 'brief.md'), 'utf-8'), '# next brief', 'inputs brief installed');
  assert.equal(getProject(name).current_phase, 0, 'current_phase reset to 0');

  // The stale budget markers + hint MUST be gone so the new brief's plan gets its
  // full one-shot auto-regen budget (the acf-chain stall was a leftover sentinel).
  for (const f of ['.plan-struct-regen-attempted', '.coverage-regen-attempted', 'plan-fix.hint']) {
    try {
      await fs.access(path.join(guideDir, f));
      assert.fail(`${f} should have been cleared when the new brief was installed`);
    } catch (e) {
      if (e.code !== 'ENOENT') assert.fail(`unexpected error checking ${f}: ${e.code}`);
    }
  }
  // Queue file consumed.
  try {
    await fs.access(path.join(queueDir, '01-next.md'));
    assert.fail('queue file should have been removed');
  } catch (e) {
    if (e.code !== 'ENOENT') assert.fail(`unexpected error checking queue file: ${e.code}`);
  }
  await fs.rm(projDir, { recursive: true, force: true });
});

// ─── Phase 12 — content-hash brief staleness (briefHash / checkStaleBriefGuard) ─
//
// The guards now reason about file CONTENT (SHA-256), not mtime. mtime is
// unreliable: cp -p preserves it, atomic-rename saves mint a fresh one for
// identical bytes, and git stash/checkout flip it either way. These tests skew
// mtimes deliberately to prove the guards key on bytes, not timestamps.

test('briefHash: identical bytes → identical hash; different bytes → different; missing → null', async () => {
  const projDir = makeTmpGuideDir();
  await fs.mkdir(projDir, { recursive: true });
  const a = path.join(projDir, 'a.md');
  const b = path.join(projDir, 'b.md');
  const c = path.join(projDir, 'c.md');
  await fs.writeFile(a, 'hello world\n', 'utf-8');
  await fs.writeFile(b, 'hello world\n', 'utf-8');
  await fs.writeFile(c, 'different bytes\n', 'utf-8');

  const ha = await briefHash(a);
  const hb = await briefHash(b);
  const hc = await briefHash(c);

  assert.equal(ha, hb, 'identical content → identical hash');
  assert.notEqual(ha, hc, 'different content → different hash');
  assert.equal(ha.length, 64, 'SHA-256 hex digest is 64 chars');
  assert.equal(await briefHash(path.join(projDir, 'nope.md')), null, 'missing file → null (no throw)');
  await fs.rm(projDir, { recursive: true, force: true });
});

test('checkStaleBriefGuard: identical content with skewed mtimes → not stale (returns null)', async () => {
  const projDir = makeTmpGuideDir();
  const inputsDir = path.join(projDir, 'inputs');
  const guideDir = path.join(projDir, '.guide');
  await fs.mkdir(inputsDir, { recursive: true });
  await fs.mkdir(guideDir, { recursive: true });
  const bytes = '# Brief\n\nSame content on both sides.\n';
  await fs.writeFile(path.join(inputsDir, 'brief.md'), bytes, 'utf-8');
  await fs.writeFile(path.join(guideDir, 'brief.md'), bytes, 'utf-8');
  // Make inputs/brief.md look an hour "newer" — an mtime guard would (wrongly)
  // trip; the content hash must not.
  const old = new Date(Date.now() - 60 * 60 * 1000);
  const now = new Date();
  await fs.utimes(path.join(guideDir, 'brief.md'), old, old);
  await fs.utimes(path.join(inputsDir, 'brief.md'), now, now);

  const result = await checkStaleBriefGuard(projDir);
  assert.equal(result, null, 'identical bytes must not trip the guard despite skewed mtimes');
  await fs.rm(projDir, { recursive: true, force: true });
});

test('checkStaleBriefGuard: differing content trips the guard even when .guide/brief.md is newer', async () => {
  const projDir = makeTmpGuideDir();
  const inputsDir = path.join(projDir, 'inputs');
  const guideDir = path.join(projDir, '.guide');
  await fs.mkdir(inputsDir, { recursive: true });
  await fs.mkdir(guideDir, { recursive: true });
  await fs.writeFile(path.join(inputsDir, 'brief.md'), '# Brief\n\nNEW requirements.\n', 'utf-8');
  await fs.writeFile(path.join(guideDir, 'brief.md'), '# Brief\n\nold requirements.\n', 'utf-8');
  // Make the GUIDE copy the newer file — proves the guard keys on content, not
  // on "which file is newer".
  const old = new Date(Date.now() - 60 * 60 * 1000);
  const now = new Date();
  await fs.utimes(path.join(inputsDir, 'brief.md'), old, old);
  await fs.utimes(path.join(guideDir, 'brief.md'), now, now);

  const result = await checkStaleBriefGuard(projDir);
  assert.ok(result && result.kind === 'wait-for-human', `expected wait-for-human, got ${JSON.stringify(result)}`);
  assert.match(result.reason, /differs/);
  await fs.rm(projDir, { recursive: true, force: true });
});

test('checkStaleBriefGuard: missing inputs/brief.md → null (cannot compare, no throw)', async () => {
  const projDir = makeTmpGuideDir();
  const guideDir = path.join(projDir, '.guide');
  await fs.mkdir(guideDir, { recursive: true });
  await fs.writeFile(path.join(guideDir, 'brief.md'), '# Brief\n', 'utf-8');
  // inputs/brief.md intentionally absent → a null hash → cannot compare.
  const result = await checkStaleBriefGuard(projDir);
  assert.equal(result, null, 'missing file must yield null without throwing');
  await fs.rm(projDir, { recursive: true, force: true });
});

// ─── Phase 12 — content-hash brief drift (checkBriefDrift) ───────────────────

test('checkBriefDrift: identical snapshot + skewed mtime → updated:false', async () => {
  const projDir = makeTmpGuideDir();
  const guideDir = path.join(projDir, '.guide');
  const briefsDir = path.join(guideDir, 'briefs');
  await fs.mkdir(briefsDir, { recursive: true });
  const bytes = '# Brief\n\nFrozen at plan time.\n';
  await fs.writeFile(path.join(guideDir, 'brief.md'), bytes, 'utf-8');
  const snapRel = path.join('.guide', 'briefs', 'v3-2026-06-16T00-00-00.md');
  await fs.writeFile(path.join(projDir, snapRel), bytes, 'utf-8');
  // live brief.md much newer than the snapshot — an mtime drift check would fire.
  const old = new Date(Date.now() - 60 * 60 * 1000);
  const now = new Date();
  await fs.utimes(path.join(projDir, snapRel), old, old);
  await fs.utimes(path.join(guideDir, 'brief.md'), now, now);

  const drift = await checkBriefDrift(projDir, { brief_snapshot: snapRel });
  assert.equal(drift.updated, false, 'identical content → no drift despite skewed mtimes');
  assert.equal(drift.version, 'v3');
  await fs.rm(projDir, { recursive: true, force: true });
});

test('checkBriefDrift: differing content → updated:true even when snapshot is newer', async () => {
  const projDir = makeTmpGuideDir();
  const guideDir = path.join(projDir, '.guide');
  const briefsDir = path.join(guideDir, 'briefs');
  await fs.mkdir(briefsDir, { recursive: true });
  await fs.writeFile(path.join(guideDir, 'brief.md'), '# Brief\n\nEDITED after plan.\n', 'utf-8');
  const snapRel = path.join('.guide', 'briefs', 'v1-2026-01-01T00-00-00.md');
  await fs.writeFile(path.join(projDir, snapRel), '# Brief\n\noriginal.\n', 'utf-8');
  // Make the snapshot the newer file — content difference must still win.
  const old = new Date(Date.now() - 60 * 60 * 1000);
  const now = new Date();
  await fs.utimes(path.join(guideDir, 'brief.md'), old, old);
  await fs.utimes(path.join(projDir, snapRel), now, now);

  const drift = await checkBriefDrift(projDir, { brief_snapshot: snapRel });
  assert.equal(drift.updated, true, 'content difference → drift');
  assert.equal(drift.version, 'v1');
  await fs.rm(projDir, { recursive: true, force: true });
});

test('checkBriefDrift: missing snapshot file → updated:false (cannot compare), version preserved', async () => {
  const projDir = makeTmpGuideDir();
  const guideDir = path.join(projDir, '.guide');
  await fs.mkdir(guideDir, { recursive: true });
  await fs.writeFile(path.join(guideDir, 'brief.md'), '# Brief\n', 'utf-8');
  const snapRel = path.join('.guide', 'briefs', 'v2-missing.md'); // file never created
  const drift = await checkBriefDrift(projDir, { brief_snapshot: snapRel });
  assert.equal(drift.updated, false, 'missing snapshot → cannot compare → no drift');
  assert.equal(drift.version, 'v2');
  await fs.rm(projDir, { recursive: true, force: true });
});

test('checkBriefDrift: no brief_snapshot in plan → updated:false, version:null', async () => {
  const drift = await checkBriefDrift(makeTmpGuideDir(), {});
  assert.equal(drift.updated, false);
  assert.equal(drift.version, null);
});

// ─── Phase 12 — proactive network-failure pause (healing_log threshold) ──────
//
// pickNextAction reads healing_log up front: ≥3 FAILED network-kind heals in
// the last 30 min → wait-for-human, so a sustained outage surfaces instead of
// silently burning heal attempts. 'network' is the exact error_kind string
// classifyError emits (src/lib/error-classifier.js → ERROR_KINDS.NETWORK).

test('countRecentFailedHealingByKinds: respects 30-min window + status/kind filters', () => {
  const name = 'crfh-' + randomUUID().slice(0, 8);
  const db = getDb();
  const old    = new Date(Date.now() - 45 * 60 * 1000).toISOString(); // outside 30-min window
  const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const ins = db.prepare(
    'INSERT INTO healing_log (project, error_kind, error_message, status, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  ins.run(name, 'network',   'old',      'failed',   old);    // too old → excluded
  ins.run(name, 'network',   'r1',       'failed',   recent); // counts
  ins.run(name, 'network',   'r2',       'failed',   recent); // counts
  ins.run(name, 'network',   'resolved', 'resolved', recent); // wrong status → excluded
  ins.run(name, 'git-dirty', 'x',        'failed',   recent); // wrong kind → excluded

  assert.equal(countRecentFailedHealingByKinds(name, ['network'], 30), 2);
  assert.equal(countRecentFailedHealingByKinds(name, [], 30), 0, 'empty kind set → 0');
  assert.equal(countRecentFailedHealingByKinds('no-such-project', ['network'], 30), 0);
});

test('pickNextAction: ≥3 failed network heals in last 30 min → wait-for-human (proactive pause)', async () => {
  const name = 'pna-net-pause';
  upsertProject({ name, tech_stack: 'node', total_phases: 3, status: 'in-progress' });
  for (let i = 0; i < 3; i++) {
    const id = recordHealingAttempt({ project: name, error_kind: 'network', error_message: 'ECONNRESET' });
    updateHealingStatus(id, 'failed');
  }
  const result = await pickNextAction(name, MINIMAL_CFG);
  assert.equal(result.kind, 'wait-for-human', `expected wait-for-human, got ${JSON.stringify(result)}`);
  assert.match(result.reason, /network-heal attempts/);
});

test('pickNextAction: <3 network failures → no network pause (normal planning action)', async () => {
  const name = 'pna-net-below';
  const plan = { phases: [{ n: 1, title: 'P1', goal: 'g', acceptance_criteria: ['x'] }] };
  try {
    await writePlanJson(name, plan);
    upsertProject({ name, tech_stack: 'node', total_phases: 1, status: 'in-progress' });
    setCurrentPhase(name, 0);
    for (let i = 0; i < 2; i++) { // below threshold of 3
      const id = recordHealingAttempt({ project: name, error_kind: 'network', error_message: 'ETIMEDOUT' });
      updateHealingStatus(id, 'failed');
    }
    const result = await pickNextAction(name, MINIMAL_CFG);
    assert.ok(
      !(result.kind === 'wait-for-human' && /network-heal/.test(result.reason || '')),
      `must not network-pause below threshold; got ${JSON.stringify(result)}`,
    );
    assert.equal(result.task, 'plan-validate', `expected normal plan-validate action, got ${JSON.stringify(result)}`);
  } finally {
    await cleanupProject(name);
  }
});

test('pickNextAction: ≥3 failed NON-network heals → no network pause', async () => {
  const name = 'pna-net-wrongkind';
  const plan = { phases: [{ n: 1, title: 'P1', goal: 'g', acceptance_criteria: ['x'] }] };
  try {
    await writePlanJson(name, plan);
    upsertProject({ name, tech_stack: 'node', total_phases: 1, status: 'in-progress' });
    setCurrentPhase(name, 0);
    for (let i = 0; i < 3; i++) { // wrong kind → must not trip the network guard
      const id = recordHealingAttempt({ project: name, error_kind: 'git-dirty', error_message: 'dirty tree' });
      updateHealingStatus(id, 'failed');
    }
    const result = await pickNextAction(name, MINIMAL_CFG);
    assert.ok(
      !(result.kind === 'wait-for-human' && /network-heal/.test(result.reason || '')),
      `non-network failures must not network-pause; got ${JSON.stringify(result)}`,
    );
    assert.equal(result.task, 'plan-validate');
  } finally {
    await cleanupProject(name);
  }
});

// ─── Phase 5 — buildPhaseCompletionNotifyText (brief P2 part 3/3 notifier) ───
//
// executeAction's per-phase Telegram ping reads result.verify_outcome and
// appends formatVerifyOutcomeLine(...).text when the acceptance-check
// verdict isn't a plain pass. executeAction itself isn't exported (and
// mocking runDev/notifier through it would need module-mocking machinery
// this repo doesn't use), so the notify-text logic is exercised directly via
// buildPhaseCompletionNotifyText — the same pure-function extraction pattern
// phase-runner.js uses for formatVerifyOutcomeLine.

const NOTIFY_ARGS_BASE = {
  projectName: 'demo', phaseN: 5, lastN: 8, title: 'FVU file builder',
  sha8: 'abc12345', branch: 'develop', isLast: false,
};

test('buildPhaseCompletionNotifyText: verify_outcome absent → today\'s unchanged format, no verify line', () => {
  const text = buildPhaseCompletionNotifyText({ ...NOTIFY_ARGS_BASE, verifyOutcome: undefined });
  assert.equal(
    text,
    '✓ Phase 5/8 — FVU file builder\n📦 <b>demo</b> · <code>abc12345</code> · develop',
  );
});

test('buildPhaseCompletionNotifyText: verify_outcome status "pass" → unchanged format, no verify line appended', () => {
  const outcome = { status: 'pass', verdict: { verdict: 'pass', criteria: [{ criterion: 'a', status: 'met' }] } };
  const text = buildPhaseCompletionNotifyText({ ...NOTIFY_ARGS_BASE, verifyOutcome: outcome });
  assert.equal(
    text,
    '✓ Phase 5/8 — FVU file builder\n📦 <b>demo</b> · <code>abc12345</code> · develop',
  );
});

test('buildPhaseCompletionNotifyText: verify_outcome status "fail" → appends formatVerifyOutcomeLine(...).text', () => {
  const outcome = {
    status: 'fail',
    verdict: {
      verdict: 'fail',
      criteria: [
        { criterion: 'a', status: 'unmet' },
        { criterion: 'b', status: 'met' },
      ],
      must_fix: ['fix a'],
    },
  };
  const text = buildPhaseCompletionNotifyText({ ...NOTIFY_ARGS_BASE, verifyOutcome: outcome });
  const expectedLine = formatVerifyOutcomeLine('Phase 5', outcome).text;
  assert.ok(text.includes(expectedLine), `expected notify text to include verify line, got: ${text}`);
  assert.equal(
    text,
    `✓ Phase 5/8 — FVU file builder\n📦 <b>demo</b> · <code>abc12345</code> · develop\n${expectedLine}`,
  );
});

test('buildPhaseCompletionNotifyText: verify_outcome status "inconclusive" → appends formatVerifyOutcomeLine(...).text', () => {
  const outcome = { status: 'inconclusive', verdict: null, errors: ['spawn timed out'] };
  const text = buildPhaseCompletionNotifyText({ ...NOTIFY_ARGS_BASE, verifyOutcome: outcome });
  const expectedLine = formatVerifyOutcomeLine('Phase 5', outcome).text;
  assert.ok(text.includes(expectedLine), `expected notify text to include verify line, got: ${text}`);
  assert.match(text, /inconclusive/);
});

test('buildPhaseCompletionNotifyText: isLast + fail verdict → both the verify line AND the "all phases complete" footer appear', () => {
  const outcome = { status: 'fail', verdict: { verdict: 'fail', criteria: [{ criterion: 'a', status: 'unmet' }] } };
  const text = buildPhaseCompletionNotifyText({ ...NOTIFY_ARGS_BASE, isLast: true, phaseN: 8, verifyOutcome: outcome });
  const expectedLine = formatVerifyOutcomeLine('Phase 8', outcome).text;
  assert.ok(text.includes(expectedLine));
  assert.match(text, /All phases complete — awaiting final review \/ QA\./);
});

// ─── Phase 22 — notifyGuideRegroundIfAny (brief P3 notify-wiring half) ───────
//
// Sibling to notifyContextDriftIfAny (phase 19) — same shape, reads
// result._guide_reground.notifyText instead of result._context_freshness.notifyText.
// Both are exercised directly (not through executeAction, which isn't
// exported) with a bare fake notifier — the same convention this file already
// uses for buildPhaseCompletionNotifyText above.

function makeFakeNotifier() {
  const sent = [];
  return { notifier: { notify: async (msg) => { sent.push(msg); } }, sent };
}

test('notifyGuideRegroundIfAny: result._guide_reground.notifyText present → notifier.notify called exactly once with that text', async () => {
  const { notifier, sent } = makeFakeNotifier();
  const result = { _guide_reground: { reason: '16 commit(s)...', notifyText: '↺ demo: guide re-grounded — 16 commit(s)...' } };
  await notifyGuideRegroundIfAny(result, notifier);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, '↺ demo: guide re-grounded — 16 commit(s)...');
});

test('notifyGuideRegroundIfAny: notifyText null (no reground this call) → notifier never invoked', async () => {
  const { notifier, sent } = makeFakeNotifier();
  await notifyGuideRegroundIfAny({ _guide_reground: { reason: null, notifyText: null } }, notifier);
  assert.equal(sent.length, 0);
});

test('notifyGuideRegroundIfAny: _guide_reground absent entirely (e.g. a runDev/runTwoStageAudit result, which never carries this field) → no throw, no notify', async () => {
  const { notifier, sent } = makeFakeNotifier();
  await notifyGuideRegroundIfAny({}, notifier);
  assert.equal(sent.length, 0);
});

test('notifyGuideRegroundIfAny: no notifier → no-op, no throw', async () => {
  await notifyGuideRegroundIfAny({ _guide_reground: { reason: 'x', notifyText: '↺ demo: x' } }, null);
});

test('notifyGuideRegroundIfAny: notifier.notify throwing → swallowed (best-effort, the reground action already happened regardless of delivery)', async () => {
  const notifier = { notify: async () => { throw new Error('telegram down'); } };
  await assert.doesNotReject(notifyGuideRegroundIfAny({ _guide_reground: { reason: 'x', notifyText: '↺ demo: x' } }, notifier));
});

test('notifyGuideRegroundIfAny text is visibly distinct from notifyContextDriftIfAny text (↺ vs ⚠ lead glyph) — proves the two notice types read as different episodes', async () => {
  const { notifier: driftNotifier, sent: driftSent } = makeFakeNotifier();
  const { notifier: regroundNotifier, sent: regroundSent } = makeFakeNotifier();

  await notifyContextDriftIfAny({ _context_freshness: { notifyText: '⚠ demo: 2 external commit(s) detected since context was generated — refresh queued' } }, driftNotifier);
  await notifyGuideRegroundIfAny({ _guide_reground: { reason: 'x', notifyText: '↺ demo: guide re-grounded — 16 commit(s) landed since the guide last looked (threshold 15)' } }, regroundNotifier);

  assert.equal(driftSent.length, 1);
  assert.equal(regroundSent.length, 1);
  assert.ok(driftSent[0].text.startsWith('⚠'));
  assert.ok(regroundSent[0].text.startsWith('↺'));
  assert.notEqual(driftSent[0].text, regroundSent[0].text);
});

test('pickNextAction: network heals that RESOLVED (not failed) do not trip the pause', async () => {
  const name = 'pna-net-resolved';
  const plan = { phases: [{ n: 1, title: 'P1', goal: 'g', acceptance_criteria: ['x'] }] };
  try {
    await writePlanJson(name, plan);
    upsertProject({ name, tech_stack: 'node', total_phases: 1, status: 'in-progress' });
    setCurrentPhase(name, 0);
    for (let i = 0; i < 3; i++) { // resolved, not failed → excluded by status filter
      const id = recordHealingAttempt({ project: name, error_kind: 'network', error_message: 'fetch failed' });
      updateHealingStatus(id, 'resolved', new Date().toISOString());
    }
    const result = await pickNextAction(name, MINIMAL_CFG);
    assert.ok(
      !(result.kind === 'wait-for-human' && /network-heal/.test(result.reason || '')),
      `resolved network heals must not pause; got ${JSON.stringify(result)}`,
    );
  } finally {
    await cleanupProject(name);
  }
});

// ─── Phase 24 — thrown operational dev failures enter the escalation ladder ──
//
// Before this phase, a thrown (non-timeout) dev/fix error whose heal failed
// rethrew straight to finalize(failed) — the routeDevFailure/decideEscalationHop
// ladder only ever saw is_error RESULTS, never THROWS. isEscalationEligibleThrow
// + convertThrowToEscalatableResult close that gap for genuine operational
// throws while keeping retry-pointless infra throws (git pre-flight, budget
// exhaustion) on the original rethrow-to-finalize path.

test('isEscalationEligibleThrow: is_preflight_error is excluded (stays on rethrow-to-finalize path)', () => {
  const err = new Error('Git pre-flight failed: workspace on wrong branch');
  err.is_preflight_error = true;
  assert.equal(isEscalationEligibleThrow(err), false);
});

test('isEscalationEligibleThrow: budget/billing-window-shaped errors are excluded', () => {
  assert.equal(isEscalationEligibleThrow(new Error('budget: max_total_calls exceeded')), false);
  assert.equal(isEscalationEligibleThrow(new Error('paused — 5-hour billing window exhausted')), false);
});

test('isEscalationEligibleThrow: dependency/environment throws are excluded; unknown orchestrator bugs remain eligible', () => {
  assert.equal(isEscalationEligibleThrow(new Error('Cannot find module xyz')), false);
  assert.equal(isEscalationEligibleThrow(new Error('unexpected orchestrator error')), true);
});

test('convertThrowToEscalatableResult: dev throw writes a phase-N-escalate.marker JSON with the correct tiers and returns an is_error result flagged _heal_already_tried', async () => {
  const name = 'p24-dev-throw';
  try {
    const err = new Error('ENOENT: something broke');
    const action = { kind: 'dev', phaseN: 7, phaseTitle: 'Widgets' };
    const cfg = { model: 'claude-sonnet-4-6' }; // heuristic → tier 'sonnet' → next tier 'opus'

    const converted = await convertThrowToEscalatableResult({ execErr: err, action, projectName: name, cfg });

    assert.equal(converted.result.is_error, true);
    assert.equal(converted.result._heal_already_tried, true);
    assert.equal(converted.result.error_message, err.message);
    assert.equal(converted.written, true);
    assert.equal(converted.failedTier, 'sonnet');
    assert.equal(converted.targetTier, 'opus');

    const markerPath = escalationMarkerPath(path.join(PROJECTS_DIR, name), { phaseN: 7 });
    const body = JSON.parse(await fs.readFile(markerPath, 'utf-8'));
    assert.equal(body.target_tier, 'opus');
    assert.equal(body.failed_tier, 'sonnet');
  } finally {
    await cleanupProject(name);
  }
});

test('convertThrowToEscalatableResult: fix-dev throw is handled symmetrically — writes the fix-shaped marker via the same helper', async () => {
  const name = 'p24-fix-throw';
  try {
    const err = new Error('spawn ENOENT');
    const action = { kind: 'fix-dev', fix: { round: 2, n: 3, title: 'Fix X' } };
    const cfg = { model: 'claude-opus-4-8' }; // heuristic → tier 'opus' → next tier 'fable'

    const converted = await convertThrowToEscalatableResult({ execErr: err, action, projectName: name, cfg });

    assert.equal(converted.written, true);
    assert.equal(converted.failedTier, 'opus');
    assert.equal(converted.targetTier, 'fable');

    const markerPath = escalationMarkerPath(path.join(PROJECTS_DIR, name), { fix: action.fix });
    const body = JSON.parse(await fs.readFile(markerPath, 'utf-8'));
    assert.equal(body.target_tier, 'fable');
    assert.equal(body.failed_tier, 'opus');
  } finally {
    await cleanupProject(name);
  }
});

test('convertThrowToEscalatableResult: a top-rung (fable) failure writes NO marker — targetTier null, so routing falls through to pause', async () => {
  const name = 'p24-top-rung-throw';
  try {
    const err = new Error('some operational failure');
    const action = { kind: 'dev', phaseN: 1 };
    const cfg = { model: 'claude-fable' }; // heuristic → tier 'fable' → no rung above

    const converted = await convertThrowToEscalatableResult({ execErr: err, action, projectName: name, cfg });

    assert.equal(converted.written, false);
    assert.equal(converted.targetTier, null);
    assert.equal(converted.failedTier, 'fable');
  } finally {
    await cleanupProject(name);
  }
});

test('converted throw: routeDevFailure with healEnabled forced false (via _heal_already_tried) routes escalate for a non-transient failure, and the healer is never invoked a second time', async () => {
  const name = 'p24-route-escalate';
  try {
    const err = new Error('Cannot find module xyz'); // non-transient, non-timeout
    const action = { kind: 'dev', phaseN: 3 };
    const cfg = { model: 'claude-sonnet-4-6' };

    // Simulate the catch block: the healer is attempted exactly once, before
    // conversion, exactly as auto-runner.js's catch block does.
    let healCallCount = 0;
    const fakeHealer = { heal: async () => { healCallCount += 1; return { healed: false, reason: 'not auto-recoverable' }; } };
    const heal = await fakeHealer.heal();
    assert.equal(heal.healed, false);
    assert.equal(healCallCount, 1);

    const converted = await convertThrowToEscalatableResult({ execErr: err, action, projectName: name, cfg });
    assert.equal(converted.result._heal_already_tried, true);

    // Mirrors the call site: `healEnabled: cfg.auto_heal?.enabled !== false && !result._heal_already_tried`.
    const route = routeDevFailure({
      errMsg: converted.result.error_message,
      actionKind: 'dev',
      isTransient: false,
      healEnabled: !converted.result._heal_already_tried,
    });
    assert.equal(route, 'escalate', 'non-transient converted failure routes to the escalation ladder, not back to heal');

    // routeDevFailure never returned 'heal', so the caller's `if (route === 'heal')`
    // block (the only place that calls healer.heal for a dev/fix RESULT) never
    // runs — the healer is not invoked a second time for this error.
    assert.equal(healCallCount, 1, 'the healer ran exactly once for this thrown error');
  } finally {
    await cleanupProject(name);
  }
});

test('converted throw: a TRANSIENT operational failure routes pause (not escalate, not heal) once healEnabled is forced false', () => {
  const route = routeDevFailure({
    errMsg: 'ECONNRESET',
    actionKind: 'dev',
    isTransient: true,
    healEnabled: false, // _heal_already_tried
    escalateEnabled: true,
    escalateAlreadyTried: false,
  });
  assert.equal(route, 'pause');
});

// ─── Regression: retry-pointless infra throws are unaffected ─────────────────

test('regression: is_preflight_error is excluded from conversion — no marker is written and the throw still rethrows to finalize', async () => {
  const name = 'p24-preflight-regression';
  try {
    const err = new Error('Git pre-flight failed: workspace on wrong branch');
    err.is_preflight_error = true;
    assert.equal(isEscalationEligibleThrow(err), false, 'is_preflight_error must never be converted');
    // The real catch block gates convertThrowToEscalatableResult behind
    // isEscalationEligibleThrow — since that's false here, the converter is
    // never called, so no marker exists on disk.
    const markerPath = escalationMarkerPath(path.join(PROJECTS_DIR, name), { phaseN: 1 });
    await assert.rejects(() => fs.readFile(markerPath, 'utf-8'));
  } finally {
    await cleanupProject(name);
  }
});

test('regression: timeout-shaped errors are ineligible for model escalation even if branch ordering changes', () => {
  // The catch block checks `isDevFail && isTimeoutError(execErr.message)` FIRST
  // and builds its own is_error result there — isEscalationEligibleThrow is
  // only reached in the `else` branch, so a timeout throw never reaches it.
  const timeoutErr = new Error('timed out after 30m');
  assert.equal(isTimeoutError(timeoutErr.message), true);
  assert.equal(isEscalationEligibleThrow(timeoutErr), false);
});

// ─── Phase 35 — batch-weight review gating ───────────────────────────────────

test('applyReviewGatingOverrides: isFinalReview forces full even for a trivially-green (light) batch', () => {
  const decision = applyReviewGatingOverrides({
    weight: { mode: 'light', signals: ['all pass'] },
    isFinalReview: true,
    consecutiveLight: 0,
    forceEvery: 3,
  });
  assert.equal(decision.mode, 'full');
  assert.equal(decision.nextConsecutiveLight, 0);
  assert.ok(decision.signals.some((s) => /final review/.test(s)));
});

test('applyReviewGatingOverrides: a non-light weight passes through unchanged and resets the streak to 0', () => {
  const decision = applyReviewGatingOverrides({
    weight: { mode: 'panel', signals: ['one phase failed'] },
    isFinalReview: false,
    consecutiveLight: 2,
    forceEvery: 3,
  });
  assert.equal(decision.mode, 'panel');
  assert.equal(decision.nextConsecutiveLight, 0);
  assert.deepEqual(decision.signals, ['one phase failed']);
});

test('applyReviewGatingOverrides: force_full_every_n (default 3) — the 3rd consecutive light-eligible batch computes full and resets the counter', () => {
  // 1st light-eligible batch: counter 0 -> 1, stays light.
  const d1 = applyReviewGatingOverrides({ weight: { mode: 'light', signals: [] }, isFinalReview: false, consecutiveLight: 0, forceEvery: 3 });
  assert.equal(d1.mode, 'light');
  assert.equal(d1.nextConsecutiveLight, 1);

  // 2nd consecutive: counter 1 -> 2, stays light.
  const d2 = applyReviewGatingOverrides({ weight: { mode: 'light', signals: [] }, isFinalReview: false, consecutiveLight: d1.nextConsecutiveLight, forceEvery: 3 });
  assert.equal(d2.mode, 'light');
  assert.equal(d2.nextConsecutiveLight, 2);

  // 3rd consecutive: would-be counter reaches forceEvery (3) -> forced full, counter resets to 0.
  const d3 = applyReviewGatingOverrides({ weight: { mode: 'light', signals: [] }, isFinalReview: false, consecutiveLight: d2.nextConsecutiveLight, forceEvery: 3 });
  assert.equal(d3.mode, 'full');
  assert.equal(d3.nextConsecutiveLight, 0);
  assert.ok(d3.signals.some((s) => /force_full_every_n \(3\) reached/.test(s)));
});

test('applyReviewGatingOverrides: forceEvery:0 disables the force-full guard entirely (light stays light indefinitely)', () => {
  let consecutiveLight = 0;
  for (let i = 0; i < 10; i += 1) {
    const d = applyReviewGatingOverrides({ weight: { mode: 'light', signals: [] }, isFinalReview: false, consecutiveLight, forceEvery: 0 });
    assert.equal(d.mode, 'light');
    consecutiveLight = d.nextConsecutiveLight;
  }
  assert.equal(consecutiveLight, 10);
});

// ─── tryReviewAutoProceed: a light review's written fixture is parsed exactly
//     like a full review's — the shared verdict/score trailer is what matters,
//     not which mode produced the file ───────────────────────────────────────

test('tryReviewAutoProceed: a light-review-style fixture with a passing score and no BLOCKER returns true', async () => {
  const name = 'p35-tryreview-pass';
  const projDir = path.join(PROJECTS_DIR, name);
  try {
    const reviewFile = reviewPath(projDir, 3);
    await fs.mkdir(path.dirname(reviewFile), { recursive: true });
    await fs.writeFile(reviewFile, [
      'Reviewed phase reports 1, 2, 3 and the changed-file list — nothing looks off.',
      '',
      'verdict: continue',
      'score: 92',
    ].join('\n'), 'utf-8');

    const result = await tryReviewAutoProceed({
      action: { phaseN: 3 },
      cfg: { auto_run: { review_auto_proceed_score_threshold: 85 } },
      projDir,
    });
    assert.equal(result, true);
  } finally {
    await cleanupProject(name);
  }
});

test('tryReviewAutoProceed: a fixture with a score below threshold returns false', async () => {
  const name = 'p35-tryreview-lowscore';
  const projDir = path.join(PROJECTS_DIR, name);
  try {
    const reviewFile = reviewPath(projDir, 3);
    await fs.mkdir(path.dirname(reviewFile), { recursive: true });
    await fs.writeFile(reviewFile, [
      'verdict: continue',
      'score: 60',
    ].join('\n'), 'utf-8');

    const result = await tryReviewAutoProceed({
      action: { phaseN: 3 },
      cfg: { auto_run: { review_auto_proceed_score_threshold: 85 } },
      projDir,
    });
    assert.equal(result, false);
  } finally {
    await cleanupProject(name);
  }
});

test('tryReviewAutoProceed: a fixture with a BLOCKER line returns false even with a passing score', async () => {
  const name = 'p35-tryreview-blocker';
  const projDir = path.join(PROJECTS_DIR, name);
  try {
    const reviewFile = reviewPath(projDir, 3);
    await fs.mkdir(path.dirname(reviewFile), { recursive: true });
    await fs.writeFile(reviewFile, [
      'BLOCKER: phase 2 report is missing a migration rollback step.',
      '',
      'verdict: pause-and-fix',
      'score: 95',
    ].join('\n'), 'utf-8');

    const result = await tryReviewAutoProceed({
      action: { phaseN: 3 },
      cfg: { auto_run: { review_auto_proceed_score_threshold: 85 } },
      projDir,
    });
    assert.equal(result, false);
  } finally {
    await cleanupProject(name);
  }
});

// ─── pickNextAction wiring: a review action always carries a reviewMode
//     (fail-safe 'full' for the very first review — no prior review file, so
//     no baseline commit sha, so changedFiles is null) ───────────────────────

test("pickNextAction: a triggered review action carries reviewMode:'full' (fail-safe — first review has no baseline sha) plus reviewBatch/reviewChangedFiles", async () => {
  const name = 'p35-pna-review-wiring';
  // 4-phase plan, only the first 3 completed — leaves a 4th phase so the
  // mid-stream (not the all-done) branch of pickNextAction fires the review.
  const plan = {
    phases: [
      { n: 1, title: 'Phase 1', acceptance_criteria: ['a'] },
      { n: 2, title: 'Phase 2', acceptance_criteria: ['a'] },
      { n: 3, title: 'Phase 3', acceptance_criteria: ['a'] },
      { n: 4, title: 'Phase 4', acceptance_criteria: ['a'] },
    ],
  };
  try {
    await writePlanJson(name, plan);
    upsertProject({ name, tech_stack: 'node', total_phases: 4, status: 'in-progress' });
    setCurrentPhase(name, 3);
    for (const p of plan.phases.slice(0, 3)) {
      upsertPhase({ project: name, n: p.n, title: p.title, status: 'pending' });
      markPhaseCompleted({ project: name, n: p.n, commit_sha: `sha${p.n}` });
    }

    const cfg = { ...MINIMAL_CFG, phases: { ...MINIMAL_CFG.phases, review_every_n_phases: 3 } };
    const result = await pickNextAction(name, cfg);

    assert.equal(result.kind, 'guide');
    assert.equal(result.task, 'review');
    assert.equal(result.reviewMode, 'full', 'no prior review file -> no baseline sha -> changedFiles null -> full');
    assert.ok(Array.isArray(result.reviewBatch), 'batch is attached to the action');
    assert.equal(result.reviewBatch.length, 3, 'batch spans every phase since the (nonexistent) previous review');
    assert.equal(result.reviewChangedFiles, null);
    assert.equal(result.reviewNextConsecutiveLight, 0);
  } finally {
    await cleanupProject(name);
  }
});

test('pickNextAction: a high-risk boundary schedules an immediate full review before the six-phase interval', async () => {
  const name = 'p35-pna-risk-review';
  const plan = {
    phases: [
      { n: 1, title: 'Phase 1', acceptance_criteria: ['a'], complexity: 'low' },
      { n: 2, title: 'Phase 2', acceptance_criteria: ['a'], complexity: 'low' },
      { n: 3, title: 'Phase 3', acceptance_criteria: ['a'], complexity: 'low' },
      { n: 4, title: 'Security boundary', acceptance_criteria: ['a'], complexity: 'high' },
      { n: 5, title: 'Phase 5', acceptance_criteria: ['a'], complexity: 'low' },
    ],
  };
  try {
    await writePlanJson(name, plan);
    upsertProject({ name, tech_stack: 'node', total_phases: 5, status: 'in-progress' });
    setCurrentPhase(name, 4);
    for (const p of plan.phases.slice(0, 4)) {
      upsertPhase({ project: name, n: p.n, title: p.title, status: 'pending' });
      markPhaseCompleted({ project: name, n: p.n, commit_sha: `sha${p.n}` });
    }
    const cfg = {
      ...MINIMAL_CFG,
      phases: { ...MINIMAL_CFG.phases, review_every_n_phases: 6 },
      verify: { cadence: { always_complexities: ['high', 'critical'], always_checkpoints: ['schema'] } },
    };
    const result = await pickNextAction(name, cfg);
    assert.equal(result.task, 'review');
    assert.equal(result.reviewMode, 'full');
    assert.match(result.label, /high complexity boundary/);
    assert.equal(result.reviewBatch.at(-1).complexity, 'high');
  } finally {
    await cleanupProject(name);
  }
});

// ─── Phase 47 (P4) — brief conformance gate, wired immediately before
//     setProjectStatus(project, 'ready-for-qa') in the phases-done block ────

function bcCfg(extra = {}) {
  return { ...MINIMAL_CFG, brief_conformance: { enabled: true, block_on_missing: true, fail_open: true, ...extra } };
}

async function allDonePlanFixture(name) {
  const plan = { phases: [{ n: 1, title: 'Only phase', acceptance_criteria: ['a'] }] };
  const { guideDir } = await writePlanJson(name, plan);
  upsertProject({ name, tech_stack: 'node', total_phases: 1, status: 'in-progress' });
  setCurrentPhase(name, 1);
  upsertPhase({ project: name, n: 1, title: 'Only phase', status: 'pending' });
  markPhaseCompleted({ project: name, n: 1, commit_sha: 'sha1' });
  const currentHash = await briefHash(path.join(guideDir, 'brief.md'));
  return { guideDir, currentHash };
}

test('pickNextAction: brief-conformance gate dispatches the checker task when no verdict file exists yet', async () => {
  const name = 'bc-missing-verdict';
  try {
    await allDonePlanFixture(name);
    const result = await pickNextAction(name, bcCfg());
    assert.equal(result.kind, 'guide');
    assert.equal(result.task, 'brief-conformance');
    assert.notEqual(getProject(name).status, 'ready-for-qa');
  } finally {
    await cleanupProject(name);
  }
});

test('pickNextAction: brief-conformance gate re-dispatches when the persisted verdict\'s brief_hash is stale', async () => {
  const name = 'bc-stale-hash';
  try {
    await allDonePlanFixture(name);
    await fs.writeFile(briefConformancePath(path.join(PROJECTS_DIR, name)), JSON.stringify({
      brief_hash: 'not-the-current-hash', frs: [], summary: 's', _status: 'checked',
    }), 'utf-8');
    const result = await pickNextAction(name, bcCfg());
    assert.equal(result.kind, 'guide');
    assert.equal(result.task, 'brief-conformance');
  } finally {
    await cleanupProject(name);
  }
});

test('pickNextAction: brief-conformance gate skips the checker (no respawn) and reaches ready-for-qa when the verdict is fresh and all-met', async () => {
  const name = 'bc-fresh-all-met';
  try {
    const { currentHash } = await allDonePlanFixture(name);
    await fs.writeFile(briefConformancePath(path.join(PROJECTS_DIR, name)), JSON.stringify({
      brief_hash: currentHash,
      frs: [{ id: 'FR1', requirement: 'x', status: 'met', evidence: [] }],
      summary: 's',
      _status: 'checked',
    }), 'utf-8');

    const result = await pickNextAction(name, bcCfg());
    assert.equal(result.kind, 'wait-for-human');
    assert.notEqual(result.task, 'brief-conformance');
    assert.equal(result.readyForQaTransition, true, 'reaches the ready-for-qa transition — the flip is deferred to autoRun after the runtime-qa gate');
    assert.notEqual(getProject(name).status, 'ready-for-qa', 'not flipped inline — pickNextAction defers the transition');
  } finally {
    await cleanupProject(name);
  }
});

test('pickNextAction: brief-conformance gate blocks ready-for-qa and lists missing FR ids when the fresh verdict has a missing FR', async () => {
  const name = 'bc-fresh-missing';
  try {
    const { currentHash } = await allDonePlanFixture(name);
    await fs.writeFile(briefConformancePath(path.join(PROJECTS_DIR, name)), JSON.stringify({
      brief_hash: currentHash,
      frs: [{ id: 'FR1', requirement: 'x', status: 'met', evidence: [] }, { id: 'FR2', requirement: 'y', status: 'missing', notes: 'nope' }],
      summary: 's',
      _status: 'checked',
    }), 'utf-8');

    const result = await pickNextAction(name, bcCfg());
    assert.equal(result.kind, 'wait-for-human');
    assert.match(result.reason, /FR2/);
    assert.match(result.reason, /brief-conformance\.md/);
    assert.notEqual(getProject(name).status, 'ready-for-qa');
  } finally {
    await cleanupProject(name);
  }
});

test('pickNextAction: brief_conformance.enabled:false skips the gate entirely, reaching ready-for-qa with no verdict file', async () => {
  const name = 'bc-disabled';
  try {
    await allDonePlanFixture(name);
    const result = await pickNextAction(name, bcCfg({ enabled: false }));
    assert.equal(result.kind, 'wait-for-human');
    assert.notEqual(result.task, 'brief-conformance');
    assert.equal(result.readyForQaTransition, true, 'reaches the ready-for-qa transition — the flip is deferred to autoRun after the runtime-qa gate');
    assert.notEqual(getProject(name).status, 'ready-for-qa', 'not flipped inline — pickNextAction defers the transition');
  } finally {
    await cleanupProject(name);
  }
});

// ─── sweepStaleWorktrees (Phase 50) ─────────────────────────────────────────

function makeWorktreeFixture(label) {
  const projDir = mkdtempSync(path.join(os.tmpdir(), `aorch-sweep-proj-${label}-`));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), `aorch-sweep-ws-${label}-`));
  execSync('git init -q', { cwd: workspaceDir });
  execSync('git config user.email t@example.com', { cwd: workspaceDir });
  execSync('git config user.name test', { cwd: workspaceDir });
  execSync('git commit -q --allow-empty -m init', { cwd: workspaceDir });
  return { projDir, workspaceDir };
}

test('sweepStaleWorktrees removes a planted stale worktree subdir and logs one dim line per removal', async () => {
  const { projDir, workspaceDir } = makeWorktreeFixture('planted');
  try {
    const sha = await getHeadSha(workspaceDir);
    const staleDir = path.join(worktreesRoot(projDir), `verify-${sha.slice(0, 8)}`);
    const added = await addDetachedWorktree(workspaceDir, { sha, dir: staleDir });
    assert.equal(added.ok, true, added.error);

    const logs = [];
    const origLog = console.log;
    console.log = (...args) => { logs.push(args.join(' ')); };
    try {
      await sweepStaleWorktrees(projDir, workspaceDir);
    } finally {
      console.log = origLog;
    }

    await assert.rejects(() => fs.access(staleDir), 'stale worktree dir must be removed');
    const sweepLines = logs.filter((l) => l.includes('Swept stale worktree'));
    assert.equal(sweepLines.length, 1, 'exactly one dim log line per removed worktree');
  } finally {
    await fs.rm(projDir, { recursive: true, force: true });
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test('sweepStaleWorktrees is a no-op (no logs, no throw) when there are no leftover dirs', async () => {
  const { projDir, workspaceDir } = makeWorktreeFixture('noop');
  try {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => { logs.push(args.join(' ')); };
    try {
      await sweepStaleWorktrees(projDir, workspaceDir); // no .worktrees/ dir created at all
    } finally {
      console.log = origLog;
    }
    assert.equal(logs.length, 0);
  } finally {
    await fs.rm(projDir, { recursive: true, force: true });
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

// ─── Phase 56 (MI-5) — telemetry-learned routing floor preflight ─────────────

function telemetryCfg(enabled) {
  return {
    model_routing: {
      tier_models: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-4-8', fable: 'claude-fable-5' },
      telemetry: { enabled, window_calls: 12, min_samples: 6, escalate_fail_rate: 0.33, decay_streak: 5 },
    },
    phases: { max_turns_per_tier: { opus: 80, fable: 60 }, max_turns_per_phase: 150 },
  };
}

// 9 sonnet dev rows, 4 errored → 4/9 ≥ 0.33 → a learned opus floor.
function failingDevCalls(project, task, limit) {
  if (task !== 'dev-execution') return [];
  return Array.from({ length: 9 }, (_, i) => ({ model: 'claude-sonnet-5', is_error: i < 4 ? 1 : 0, num_turns: 30 }));
}

test('applyTelemetryRoutingFloors: writes learned floors while preserving keyword_rules byte-for-byte', async () => {
  const projDir = mkdtempSync(path.join(os.tmpdir(), 'aorch-tel-'));
  try {
    const extPath = path.join(projDir, 'routing-extension.json');
    const keywordRules = [{ label: 'custom', match: ['foo'], min_tier: 'opus' }];
    await fs.writeFile(extPath, JSON.stringify({ keyword_rules: keywordRules }, null, 2), 'utf-8');

    const res = await applyTelemetryRoutingFloors(
      { cfg: telemetryCfg(true), projectName: 'p', projDir },
      { recentCalls: failingDevCalls, now: () => 'FIXED_TS', log: () => {} },
    );
    assert.equal(res.applied, true);
    assert.deepEqual(res.task_floors, { 'dev-execution': 'opus' });

    const written = JSON.parse(await fs.readFile(extPath, 'utf-8'));
    assert.equal(JSON.stringify(written.keyword_rules), JSON.stringify(keywordRules), 'keyword_rules preserved byte-for-byte');
    assert.deepEqual(written.task_floors, { 'dev-execution': 'opus' });
    assert.equal(written.task_floors_meta.updated_at, 'FIXED_TS');
    assert.ok(written.task_floors_meta.reasons.some((r) => /learned floor dev-execution->opus/.test(r)));
  } finally {
    await fs.rm(projDir, { recursive: true, force: true });
  }
});

test('applyTelemetryRoutingFloors: writes atomically — tmp file then rename (observable via the seam)', async () => {
  const projDir = path.join(os.tmpdir(), 'aorch-tel-virtual'); // no real fs — all IO seams injected
  const writes = [];
  const renames = [];
  const res = await applyTelemetryRoutingFloors(
    { cfg: telemetryCfg(true), projectName: 'p', projDir },
    {
      recentCalls: failingDevCalls,
      readFile: async () => { throw new Error('ENOENT'); }, // absent extension
      writeFile: async (p, data) => { writes.push({ p, data }); },
      rename: async (from, to) => { renames.push({ from, to }); },
      now: () => 'T',
      log: () => {},
    },
  );
  assert.equal(res.applied, true);
  assert.equal(writes.length, 1, 'exactly one write');
  assert.ok(writes[0].p.endsWith('.tmp'), 'write targets a .tmp path');
  assert.equal(renames.length, 1, 'exactly one rename');
  assert.equal(renames[0].from, writes[0].p, 'rename source is the tmp file just written');
  assert.ok(renames[0].to.endsWith('routing-extension.json'), 'rename target is the final path');
  const parsed = JSON.parse(writes[0].data);
  assert.deepEqual(parsed.task_floors, { 'dev-execution': 'opus' }, 'tmp payload carries the learned floor');
});

test('applyTelemetryRoutingFloors: telemetry disabled leaves the file untouched (no query, no write)', async () => {
  const projDir = mkdtempSync(path.join(os.tmpdir(), 'aorch-tel-'));
  try {
    const extPath = path.join(projDir, 'routing-extension.json');
    const original = JSON.stringify({ keyword_rules: [{ label: 'x', match: ['y'], min_tier: 'opus' }] }, null, 2);
    await fs.writeFile(extPath, original, 'utf-8');

    let queried = false;
    const res = await applyTelemetryRoutingFloors(
      { cfg: telemetryCfg(false), projectName: 'p', projDir },
      { recentCalls: () => { queried = true; return []; }, log: () => {} },
    );
    assert.equal(res.applied, false);
    assert.equal(queried, false, 'disabled → the calls table is never queried');
    assert.equal(await fs.readFile(extPath, 'utf-8'), original, 'file is byte-identical when telemetry disabled');
  } finally {
    await fs.rm(projDir, { recursive: true, force: true });
  }
});

test('applyTelemetryRoutingFloors: same telemetry fixture → byte-identical file twice (second run is a no-op)', async () => {
  const projDir = mkdtempSync(path.join(os.tmpdir(), 'aorch-tel-'));
  try {
    const extPath = path.join(projDir, 'routing-extension.json');
    await fs.writeFile(extPath, JSON.stringify({ keyword_rules: [] }, null, 2), 'utf-8');
    const deps = { recentCalls: failingDevCalls, now: () => 'FIXED_TS', log: () => {} };

    const r1 = await applyTelemetryRoutingFloors({ cfg: telemetryCfg(true), projectName: 'p', projDir }, deps);
    assert.equal(r1.applied, true, 'first run writes the learned floor');
    const bytes1 = await fs.readFile(extPath, 'utf-8');

    const r2 = await applyTelemetryRoutingFloors({ cfg: telemetryCfg(true), projectName: 'p', projDir }, deps);
    assert.equal(r2.applied, false, 'second run is a no-op — floors unchanged');
    const bytes2 = await fs.readFile(extPath, 'utf-8');

    assert.equal(bytes2, bytes1, 'same DB fixture → byte-identical routing-extension.json twice');
  } finally {
    await fs.rm(projDir, { recursive: true, force: true });
  }
});

test('applyTelemetryRoutingFloors: a clean low-turn opus streak decays a floor already on disk', async () => {
  const projDir = mkdtempSync(path.join(os.tmpdir(), 'aorch-tel-'));
  try {
    const extPath = path.join(projDir, 'routing-extension.json');
    await fs.writeFile(extPath, JSON.stringify({ keyword_rules: [], task_floors: { 'dev-execution': 'opus' } }, null, 2), 'utf-8');
    const cleanStreak = (project, task) => task === 'dev-execution'
      ? Array.from({ length: 5 }, () => ({ model: 'claude-opus-4-8', is_error: 0, num_turns: 20 }))
      : [];
    const res = await applyTelemetryRoutingFloors(
      { cfg: telemetryCfg(true), projectName: 'p', projDir },
      { recentCalls: cleanStreak, now: () => 'T', log: () => {} },
    );
    assert.equal(res.applied, true);
    assert.deepEqual(res.task_floors, {}, 'the floor is removed');
    const written = JSON.parse(await fs.readFile(extPath, 'utf-8'));
    assert.deepEqual(written.task_floors, {}, 'on-disk floor removed');
    assert.deepEqual(written.keyword_rules, [], 'keyword_rules preserved through the decay rewrite');
  } finally {
    await fs.rm(projDir, { recursive: true, force: true });
  }
});

test('recentCallsForProjectTask: filters by project × task and caps at the limit (read-only)', () => {
  const project = `tel-read-${randomUUID().slice(0, 8)}`;
  const other = `${project}-other`;
  upsertProject({ name: project, tech_stack: 'node', total_phases: 1 });
  upsertProject({ name: other, tech_stack: 'node', total_phases: 1 });
  for (let i = 0; i < 15; i++) recordCall({ project, task: 'dev-execution', model: 'claude-sonnet-5', is_error: 0, num_turns: 10 });
  for (let i = 0; i < 4; i++) recordCall({ project, task: 'fix-execution', model: 'claude-sonnet-5', is_error: 0, num_turns: 10 });
  recordCall({ project: other, task: 'dev-execution', model: 'claude-sonnet-5', is_error: 0, num_turns: 10 });

  const dev = recentCallsForProjectTask(project, 'dev-execution', 12);
  assert.equal(dev.length, 12, 'LIMIT caps the window');
  assert.ok(dev.every((r) => r.task === 'dev-execution' && r.project === project), 'filtered to the right project × task');

  const fix = recentCallsForProjectTask(project, 'fix-execution', 12);
  assert.equal(fix.length, 4, 'returns all matching rows when under the limit');
});

test('shouldRunFailureAutopsy: provider rate limits suppress a follow-up LLM call', () => {
  assert.equal(
    shouldRunFailureAutopsy({ status: 'failed', pauseKind: 'mid-build', pauseReason: 'rate_limit_event: five_hour quota reached' }),
    false,
  );
  assert.equal(
    shouldRunFailureAutopsy({ status: 'failed', pauseKind: 'mid-build', pauseReason: 'validator failed after test run' }),
    true,
  );
});
