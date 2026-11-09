// Phase 64 (intent-based checkpointing) — unit + seam tests.
//
// Covers:
//   1. shouldPauseAfter — mode 'all' reproduces every current decision;
//      'intent' pauses only before tagged phases; 'errors-only' passes all but
//      error/budget; unattended + any mode == unattended today.
//   2. auto_pause_after_phase_1_min_total_phases (Layer 1).
//   3. evaluatePause + pickNextAction seam: totalPhases + nextPhaseCheckpoint
//      are threaded into shouldPauseAfter's ctx.
//   4. validatePlanStructure normalizes missing/invalid checkpoint -> 'routine'
//      (non-fatal; legacy plans validate clean).
//   5. validateCheckpointPolicy / describeCheckpoints / set_checkpoint_policy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Must be set before any module that calls getDb() is loaded (billing-guard,
// state, auto-runner, control-actions all reach it transitively).
process.env.DB_PATH = ':memory:';

const {
  shouldPauseAfter, describeCheckpoints, validateCheckpointPolicy,
  resolveCheckpointPolicy, CHECKPOINT_MODES,
} = await import('../checkpoint.js');
const { validatePlanStructure, CHECKPOINT_INTENTS } = await import('./plan-validate.js');
const { evaluatePause, pickNextAction, nextCheckpointAfter } = await import('../auto-runner.js');
const { toolSetCheckpointPolicy } = await import('../chat/control-actions.js');
const { upsertProject, setCurrentPhase, setProjectStatus } = await import('../state.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

// Billing block keeps windowStatus() at 'ok' with an empty in-memory DB (0
// calls < the default warn/pause thresholds), so checkBudget never pauses.
const OK_BILLING = { billing: { warn_at_calls: 50, pause_at_calls: 80 } };

// cfg with mode 'all' + all count-based checkpoints armed (today's default).
function cfgAll(extra = {}) {
  return {
    ...OK_BILLING,
    auto_run: {
      auto_pause_after_phase_1: true,
      auto_pause_after_review: true,
      auto_pause_after_final_phase: true,
      auto_pause_after_phases: [5],
      auto_pause_on_error: true,
      checkpoint_policy: { mode: 'all', pause_intents: ['architecture', 'destructive'] },
      ...extra,
    },
    bug_cycle: { review_after_round: true },
  };
}
function cfgMode(mode, pause_intents, extra = {}) {
  const c = cfgAll(extra);
  c.auto_run.checkpoint_policy = { mode, pause_intents: pause_intents ?? ['architecture', 'destructive'] };
  return c;
}

// ─── 1. mode 'all' reproduces every current decision (regression fixtures) ────

test("mode 'all': phase-error pauses", () => {
  assert.equal(shouldPauseAfter('phase-error', cfgAll(), { phaseN: 2, error: 'boom' }).pause, true);
});
test("mode 'all': phase 1 checkpoint pauses", () => {
  assert.equal(shouldPauseAfter('phase-completed', cfgAll(), { phaseN: 1, totalPhases: 10 }).pause, true);
});
test("mode 'all': final phase checkpoint pauses", () => {
  assert.equal(shouldPauseAfter('phase-completed', cfgAll(), { phaseN: 9, isFinal: true }).pause, true);
});
test("mode 'all': custom phase checkpoint pauses", () => {
  assert.equal(shouldPauseAfter('phase-completed', cfgAll(), { phaseN: 5 }).pause, true);
});
test("mode 'all': review checkpoint pauses", () => {
  assert.equal(shouldPauseAfter('review-completed', cfgAll(), { phaseN: 3 }).pause, true);
});
test("mode 'all': final fix-round pauses", () => {
  assert.equal(shouldPauseAfter('fix-completed', cfgAll(), { isFinalFix: true }).pause, true);
});
test("mode 'all': an ordinary mid-phase completion does not pause", () => {
  assert.equal(shouldPauseAfter('phase-completed', cfgAll(), { phaseN: 4, isFinal: false }).pause, false);
});
test("mode 'all': non-final fix does not pause", () => {
  assert.equal(shouldPauseAfter('fix-completed', cfgAll(), { isFinalFix: false }).pause, false);
});
test("legacy config (no checkpoint_policy) behaves as mode 'all'", () => {
  const cfg = cfgAll();
  delete cfg.auto_run.checkpoint_policy;
  assert.equal(resolveCheckpointPolicy(cfg.auto_run).mode, 'all');
  assert.equal(shouldPauseAfter('phase-completed', cfg, { phaseN: 1, totalPhases: 10 }).pause, true);
  assert.equal(shouldPauseAfter('review-completed', cfg, { phaseN: 3 }).pause, true);
});

// ─── 2. mode 'intent' pauses only before tagged phases ────────────────────────

test("mode 'intent': pauses before a phase whose tag is in pause_intents", () => {
  const cfg = cfgMode('intent', ['architecture', 'destructive']);
  assert.equal(shouldPauseAfter('phase-completed', cfg, { phaseN: 2, nextPhaseCheckpoint: 'architecture' }).pause, true);
  assert.equal(shouldPauseAfter('phase-completed', cfg, { phaseN: 2, nextPhaseCheckpoint: 'destructive' }).pause, true);
});
test("mode 'intent': does NOT pause before a routine / untagged / unlisted phase", () => {
  const cfg = cfgMode('intent', ['architecture']);
  assert.equal(shouldPauseAfter('phase-completed', cfg, { phaseN: 2, nextPhaseCheckpoint: 'routine' }).pause, false);
  assert.equal(shouldPauseAfter('phase-completed', cfg, { phaseN: 2, nextPhaseCheckpoint: 'schema' }).pause, false);
  assert.equal(shouldPauseAfter('phase-completed', cfg, { phaseN: 2, nextPhaseCheckpoint: null }).pause, false);
  assert.equal(shouldPauseAfter('phase-completed', cfg, { phaseN: 2 }).pause, false);
});
test("mode 'intent': count-based + review/fix checkpoints do NOT fire", () => {
  const cfg = cfgMode('intent', ['architecture']);
  // phase 1 armed, but next tag routine -> no pause
  assert.equal(shouldPauseAfter('phase-completed', cfg, { phaseN: 1, totalPhases: 10, nextPhaseCheckpoint: 'routine' }).pause, false);
  // final phase, review, custom, fix all inert in intent mode
  assert.equal(shouldPauseAfter('phase-completed', cfg, { phaseN: 9, isFinal: true }).pause, false);
  assert.equal(shouldPauseAfter('phase-completed', cfg, { phaseN: 5 }).pause, false);
  assert.equal(shouldPauseAfter('review-completed', cfg, { phaseN: 3 }).pause, false);
  assert.equal(shouldPauseAfter('fix-completed', cfg, { isFinalFix: true }).pause, false);
});
test("mode 'intent': error still pauses; reason classifies as a checkpoint", () => {
  const cfg = cfgMode('intent', ['architecture']);
  assert.equal(shouldPauseAfter('phase-error', cfg, { phaseN: 2, error: 'x' }).pause, true);
  const r = shouldPauseAfter('phase-completed', cfg, { phaseN: 2, nextPhaseCheckpoint: 'architecture' });
  assert.match(r.reason, /verify before continuing/); // classifyPauseReason -> review-checkpoint
});

// ─── 3. mode 'errors-only' passes all but error/budget ────────────────────────

test("mode 'errors-only': every completion checkpoint (incl. final) is skipped", () => {
  const cfg = cfgMode('errors-only');
  assert.equal(shouldPauseAfter('phase-completed', cfg, { phaseN: 1, totalPhases: 10 }).pause, false);
  assert.equal(shouldPauseAfter('phase-completed', cfg, { phaseN: 9, isFinal: true }).pause, false);
  assert.equal(shouldPauseAfter('phase-completed', cfg, { phaseN: 5 }).pause, false);
  assert.equal(shouldPauseAfter('phase-completed', cfg, { phaseN: 2, nextPhaseCheckpoint: 'architecture' }).pause, false);
  assert.equal(shouldPauseAfter('review-completed', cfg, { phaseN: 3 }).pause, false);
  assert.equal(shouldPauseAfter('fix-completed', cfg, { isFinalFix: true }).pause, false);
});
test("mode 'errors-only': error still pauses", () => {
  assert.equal(shouldPauseAfter('phase-error', cfgMode('errors-only'), { phaseN: 2, error: 'x' }).pause, true);
});

// ─── 4. unattended + any mode is identical to unattended today ────────────────

test('unattended: identical across every mode (no checkpoint pause, error pauses)', () => {
  for (const mode of CHECKPOINT_MODES) {
    const cfg = cfgMode(mode, ['architecture', 'destructive']);
    // No completion checkpoint pauses under unattended, regardless of mode.
    assert.equal(shouldPauseAfter('phase-completed', cfg, { phaseN: 1, totalPhases: 10, unattended: true }).pause, false, `phase1/${mode}`);
    assert.equal(shouldPauseAfter('phase-completed', cfg, { phaseN: 9, isFinal: true, unattended: true }).pause, false, `final/${mode}`);
    assert.equal(shouldPauseAfter('phase-completed', cfg, { phaseN: 2, nextPhaseCheckpoint: 'architecture', unattended: true }).pause, false, `intent/${mode}`);
    assert.equal(shouldPauseAfter('review-completed', cfg, { phaseN: 3, unattended: true }).pause, false, `review/${mode}`);
    // Error ALWAYS pauses under unattended.
    assert.equal(shouldPauseAfter('phase-error', cfg, { phaseN: 2, error: 'x', unattended: true }).pause, true, `error/${mode}`);
  }
});

// ─── 5. Layer 1: auto_pause_after_phase_1_min_total_phases ────────────────────

test('min_total_phases: a 3-phase plan with threshold 5 skips the phase-1 pause', () => {
  const cfg = cfgAll({ auto_pause_after_phase_1_min_total_phases: 5 });
  assert.equal(shouldPauseAfter('phase-completed', cfg, { phaseN: 1, totalPhases: 3 }).pause, false);
});
test('min_total_phases: a >=5-phase plan still pauses at phase 1', () => {
  const cfg = cfgAll({ auto_pause_after_phase_1_min_total_phases: 5 });
  assert.equal(shouldPauseAfter('phase-completed', cfg, { phaseN: 1, totalPhases: 5 }).pause, true);
  assert.equal(shouldPauseAfter('phase-completed', cfg, { phaseN: 1, totalPhases: 8 }).pause, true);
});
test('min_total_phases: default 0 changes nothing; absent totalPhases never skips', () => {
  assert.equal(shouldPauseAfter('phase-completed', cfgAll(), { phaseN: 1, totalPhases: 3 }).pause, true);
  assert.equal(shouldPauseAfter('phase-completed', cfgAll(), { phaseN: 1 }).pause, true); // undefined totalPhases
});

// ─── 6. seam: evaluatePause forwards totalPhases + nextPhaseCheckpoint ─────────

test('evaluatePause (dev): forwards nextPhaseCheckpoint into shouldPauseAfter (intent mode)', () => {
  const cfg = cfgMode('intent', ['architecture']);
  const pauseArch = evaluatePause({
    action: { kind: 'dev', phaseN: 2, isFinal: false, totalPhases: 5, nextPhaseCheckpoint: 'architecture' },
    result: {}, cfg, unattended: false,
  });
  const pauseRoutine = evaluatePause({
    action: { kind: 'dev', phaseN: 2, isFinal: false, totalPhases: 5, nextPhaseCheckpoint: 'routine' },
    result: {}, cfg, unattended: false,
  });
  assert.equal(pauseArch.pause, true);
  assert.equal(pauseRoutine.pause, false);
});
test('evaluatePause (dev): forwards totalPhases into shouldPauseAfter (min_total_phases)', () => {
  const cfg = cfgAll({ auto_pause_after_phase_1_min_total_phases: 5 });
  const small = evaluatePause({ action: { kind: 'dev', phaseN: 1, totalPhases: 3 }, result: {}, cfg, unattended: false });
  const big = evaluatePause({ action: { kind: 'dev', phaseN: 1, totalPhases: 5 }, result: {}, cfg, unattended: false });
  assert.equal(small.pause, false);
  assert.equal(big.pause, true);
});

test('nextCheckpointAfter: returns the tag of the phase after phaseN, else null', () => {
  const plan = { phases: [{ n: 1 }, { n: 2, checkpoint: 'schema' }, { n: 3, checkpoint: 'destructive' }] };
  assert.equal(nextCheckpointAfter(plan, 1), 'schema');
  assert.equal(nextCheckpointAfter(plan, 2), 'destructive');
  assert.equal(nextCheckpointAfter(plan, 3), null); // no next phase
  assert.equal(nextCheckpointAfter({ phases: [{ n: 1 }, { n: 2 }] }, 1), null); // untagged next
});

// ─── 7. seam: pickNextAction sets totalPhases + nextPhaseCheckpoint on the dev action

const MINIMAL_CFG = {
  auto_run: { run_final_review_before_qa: false, audit_runs_after_completion: 0, warn_on_missing_phase_report: false, auto_pause_after_phase_1: false },
  phases: { review_every_n_phases: 999 },
  paths: { workspace_subdir: 'workspace' },
  workspace_claude_md: { auto_generate_during_autorun: false },
  skip_analyze: { enabled: false },
  brief_conformance: { enabled: false },
};

async function seedPlan(name, plan) {
  const projDir = path.join(PROJECTS_DIR, name);
  const guideDir = path.join(projDir, '.guide');
  await fs.mkdir(guideDir, { recursive: true });
  await fs.writeFile(path.join(guideDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf-8');
  await fs.writeFile(path.join(guideDir, 'brief.md'), '# brief\n\ntest', 'utf-8');
  await fs.writeFile(path.join(guideDir, 'project-context.md'), '# ctx\n\ntest', 'utf-8');
  return projDir;
}

test('pickNextAction: the dev action carries totalPhases + nextPhaseCheckpoint (of the next phase)', async () => {
  const name = 'cp-seam-pna';
  const projDir = path.join(PROJECTS_DIR, name);
  try {
    await seedPlan(name, {
      phases: [
        { n: 1, title: 'A' },
        { n: 2, title: 'B' },
        { n: 3, title: 'C', checkpoint: 'destructive' },
      ],
    });
    upsertProject({ name, tech_stack: 'node', total_phases: 3 });
    setProjectStatus(name, 'in-progress');
    setCurrentPhase(name, 1); // phase 1 done -> next is phase 2

    const action = await pickNextAction(name, MINIMAL_CFG);
    assert.equal(action.kind, 'dev');
    assert.equal(action.phaseN, 2);
    assert.equal(action.totalPhases, 3);
    // The tag for phase 3 (the phase AFTER phase 2) is what gates a pause.
    assert.equal(action.nextPhaseCheckpoint, 'destructive');
  } finally {
    await fs.rm(projDir, { recursive: true, force: true });
  }
});

// ─── 8. validatePlanStructure normalizes the checkpoint tag ───────────────────

function validPhase(n, extra = {}) {
  return { n, title: `P${n}`, goal: 'g', acceptance_criteria: ['does x'], ...extra };
}

test('untagged legacy plan validates clean; each phase.checkpoint becomes routine', () => {
  const plan = { phases: [validPhase(1), validPhase(2)] };
  const { ok } = validatePlanStructure(plan);
  assert.equal(ok, true);
  assert.equal(plan.phases[0].checkpoint, 'routine');
  assert.equal(plan.phases[1].checkpoint, 'routine');
});
test('an invalid checkpoint tag normalizes to routine (non-fatal)', () => {
  const plan = { phases: [validPhase(1, { checkpoint: 'frobnicate' })] };
  const { ok } = validatePlanStructure(plan);
  assert.equal(ok, true);
  assert.equal(plan.phases[0].checkpoint, 'routine');
});
test('a valid checkpoint tag is preserved', () => {
  for (const tag of CHECKPOINT_INTENTS) {
    const plan = { phases: [validPhase(1, { checkpoint: tag })] };
    validatePlanStructure(plan);
    assert.equal(plan.phases[0].checkpoint, tag);
  }
});

// ─── 9. validateCheckpointPolicy names the config layer on bad input ──────────

test('validateCheckpointPolicy: accepts a valid policy and a null policy', () => {
  assert.doesNotThrow(() => validateCheckpointPolicy({ mode: 'intent', pause_intents: ['architecture'] }, 'layer'));
  assert.doesNotThrow(() => validateCheckpointPolicy(null, 'layer'));
  assert.doesNotThrow(() => validateCheckpointPolicy({ mode: 'all' }, 'layer'));
});
test('validateCheckpointPolicy: a bad mode throws naming the config layer', () => {
  assert.throws(() => validateCheckpointPolicy({ mode: 'bogus' }, 'projects/x/project.json'), (e) => {
    return /projects\/x\/project\.json/.test(e.message) && /mode/.test(e.message);
  });
});
test('validateCheckpointPolicy: a bad intent throws naming the config layer', () => {
  assert.throws(() => validateCheckpointPolicy({ mode: 'intent', pause_intents: ['nope'] }, 'projects/x/project.json'), (e) => {
    return /projects\/x\/project\.json/.test(e.message) && /pause_intents/.test(e.message);
  });
});

// ─── 10. describeCheckpoints renders the active policy ────────────────────────

test('describeCheckpoints: mode all shows the phase checkpoints', () => {
  const out = describeCheckpoints(cfgAll());
  assert.match(out, /policy: all/);
  assert.match(out, /after phase 1/);
  assert.match(out, /after final phase/);
});
test('describeCheckpoints: mode all with min_total_phases annotates the phase-1 line', () => {
  const out = describeCheckpoints(cfgAll({ auto_pause_after_phase_1_min_total_phases: 5 }));
  assert.match(out, /after phase 1 \(only when plan has ≥ 5 phases\)/);
});
test('describeCheckpoints: mode intent shows the intents', () => {
  const out = describeCheckpoints(cfgMode('intent', ['architecture', 'schema']));
  assert.match(out, /policy: intent/);
  assert.match(out, /architecture, schema/);
});
test('describeCheckpoints: mode errors-only says so', () => {
  const out = describeCheckpoints(cfgMode('errors-only'));
  assert.match(out, /errors-only/);
});

// ─── 11. set_checkpoint_policy writes a valid override, rejects a bad mode ─────

test('set_checkpoint_policy: writes overrides.auto_run.checkpoint_policy to project.json', async () => {
  const name = 'cp-tool-ok';
  const projDir = path.join(PROJECTS_DIR, name);
  try {
    await fs.mkdir(projDir, { recursive: true });
    upsertProject({ name, tech_stack: 'node', total_phases: 1 });
    const res = await toolSetCheckpointPolicy({ project: name, mode: 'intent', pause_intents: ['architecture', 'schema'] });
    assert.equal(res.ok, true);
    const pj = JSON.parse(await fs.readFile(path.join(projDir, 'project.json'), 'utf-8'));
    assert.deepEqual(pj.overrides.auto_run.checkpoint_policy, { mode: 'intent', pause_intents: ['architecture', 'schema'] });
  } finally {
    await fs.rm(projDir, { recursive: true, force: true });
  }
});
test('set_checkpoint_policy: rejects a bad mode with a config-layer-naming error', async () => {
  const name = 'cp-tool-bad';
  const projDir = path.join(PROJECTS_DIR, name);
  try {
    await fs.mkdir(projDir, { recursive: true });
    upsertProject({ name, tech_stack: 'node', total_phases: 1 });
    await assert.rejects(
      () => toolSetCheckpointPolicy({ project: name, mode: 'sometimes' }),
      (e) => /projects\/cp-tool-bad\/project\.json/.test(e.message) && /mode/.test(e.message),
    );
    // Nothing should have been written on the rejected path.
    let wrote = true;
    try { await fs.access(path.join(projDir, 'project.json')); } catch { wrote = false; }
    assert.equal(wrote, false);
  } finally {
    await fs.rm(projDir, { recursive: true, force: true });
  }
});
