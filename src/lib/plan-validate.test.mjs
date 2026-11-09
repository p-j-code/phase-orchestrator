// Tests for plan-validate.js — structural plan checks, incl. phase-65's
// depends_on DAG checks (Execution DAG P1 scaffolding).
//
// Run with: node --test src/lib/plan-validate.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlanStructure, resolveEffectiveDependsOn, CHECKPOINT_INTENTS } from './plan-validate.js';

function basePhase(n, overrides = {}) {
  return {
    n,
    title: `Phase ${n}`,
    goal: `Do phase ${n} work`,
    acceptance_criteria: [`Phase ${n} works`],
    ...overrides,
  };
}

// ─── No depends_on anywhere: degenerate previous-entry chain, zero problems ──

test('validatePlanStructure: a plan with no depends_on anywhere validates with zero problems', () => {
  const plan = { phases: [basePhase(1), basePhase(2), basePhase(3)] };
  const { ok, problems } = validatePlanStructure(plan);
  assert.equal(ok, true);
  assert.deepEqual(problems, []);
});

test('resolveEffectiveDependsOn: absent depends_on defaults to the PREVIOUS ENTRY, not n-1 arithmetic', () => {
  // Continuation-style plan: phases numbered non-sequentially (50, 52, 55).
  const phases = [basePhase(50), basePhase(52), basePhase(55)];
  const deps = resolveEffectiveDependsOn(phases);
  assert.deepEqual(deps[0], [], 'first entry has no dependencies');
  assert.deepEqual(deps[1], [50], 'second entry depends on the previous ENTRY (n=50), not n=51');
  assert.deepEqual(deps[2], [52], 'third entry depends on the previous ENTRY (n=52), not n=54');
});

// ─── Cyclic depends_on ────────────────────────────────────────────────────

test('validatePlanStructure: a cyclic depends_on yields a named cycle problem', () => {
  const plan = {
    phases: [
      basePhase(1, { depends_on: [3] }),
      basePhase(2, { depends_on: [1] }),
      basePhase(3, { depends_on: [2] }),
    ],
  };
  const { ok, problems } = validatePlanStructure(plan);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /cycle/i.test(p)), `expected a cycle problem, got: ${JSON.stringify(problems)}`);
});

test('validatePlanStructure: a self-referencing depends_on is reported and never infinite-loops', () => {
  const plan = { phases: [basePhase(1), basePhase(2, { depends_on: [2] })] };
  const { ok, problems } = validatePlanStructure(plan);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /cannot reference itself/i.test(p)));
});

// ─── Unknown-ref depends_on ────────────────────────────────────────────────

test('validatePlanStructure: an unknown-ref depends_on yields a named problem', () => {
  const plan = { phases: [basePhase(1), basePhase(2, { depends_on: [99] })] };
  const { ok, problems } = validatePlanStructure(plan);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /unknown phase n=99/.test(p)), `expected unknown-ref problem, got: ${JSON.stringify(problems)}`);
});

test('validatePlanStructure: a non-array depends_on yields a named problem', () => {
  const plan = { phases: [basePhase(1, { depends_on: 'nope' })] };
  const { ok, problems } = validatePlanStructure(plan);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /must be an array/i.test(p)));
});

// ─── Valid explicit depends_on (file-disjoint independent phases) ─────────

test('validatePlanStructure: an explicit, acyclic depends_on graph — including an independent (empty) phase — validates clean', () => {
  const plan = {
    phases: [
      basePhase(1),
      basePhase(2, { depends_on: [] }), // genuinely independent — explicit empty override
      basePhase(3, { depends_on: [1, 2] }),
    ],
  };
  const { ok, problems } = validatePlanStructure(plan);
  assert.equal(ok, true);
  assert.deepEqual(problems, []);
});

// ─── DAG checks never throw and never block downstream checks ─────────────

test('validatePlanStructure: a broken DAG never throws and coexists with other structural problems', () => {
  const plan = {
    phases: [
      basePhase(1, { depends_on: [1] }), // self-ref
      { n: 2, depends_on: [77] }, // missing title/goal/acceptance_criteria + unknown ref
    ],
  };
  assert.doesNotThrow(() => validatePlanStructure(plan));
  const { ok, problems } = validatePlanStructure(plan);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /missing\/empty "title"/.test(p)));
  assert.ok(problems.some((p) => /cannot reference itself/i.test(p)));
  assert.ok(problems.some((p) => /unknown phase n=77/.test(p)));
});

// ─── checkpoint normalization untouched by this phase ──────────────────────

test('validatePlanStructure: still normalizes an untagged checkpoint to routine (phase-64, unaffected by depends_on)', () => {
  const plan = { phases: [basePhase(1)] };
  validatePlanStructure(plan);
  assert.equal(plan.phases[0].checkpoint, 'routine');
  assert.ok(CHECKPOINT_INTENTS.includes('routine'));
});

// ─── Phase-size guard (2026-07-12, window economy) ──────────────────────────
// Oversized phases blow their turn budget at runtime (error_max_turns) — the
// guard rejects them at plan time so the auto-regen loop replans smaller.

test('validatePlanStructure: a phase at the size ceilings (10 criteria, 15 files) still validates clean', () => {
  const plan = {
    phases: [basePhase(1, {
      acceptance_criteria: Array.from({ length: 10 }, (_, i) => `criterion ${i + 1}`),
      files_expected: Array.from({ length: 15 }, (_, i) => `src/f${i + 1}.js`),
    })],
  };
  const { ok, problems } = validatePlanStructure(plan);
  assert.equal(ok, true, `at-ceiling phase must pass: ${problems.join('; ')}`);
});

test('validatePlanStructure: 11 acceptance criteria exceeds the ceiling with a split-this-phase problem', () => {
  const plan = {
    phases: [basePhase(1, { acceptance_criteria: Array.from({ length: 11 }, (_, i) => `criterion ${i + 1}`) })],
  };
  const { ok, problems } = validatePlanStructure(plan);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /11 acceptance criteria exceeds the 10-criterion phase-size ceiling.*split this phase/.test(p)));
});

test('validatePlanStructure: 16 files_expected exceeds the ceiling with a split-this-phase problem', () => {
  const plan = {
    phases: [basePhase(1, { files_expected: Array.from({ length: 16 }, (_, i) => `src/f${i + 1}.js`) })],
  };
  const { ok, problems } = validatePlanStructure(plan);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /16 files_expected exceeds the 15-file phase-size ceiling.*split this phase/.test(p)));
});

test('validatePlanStructure: o.sizeLimits overrides the default ceilings', () => {
  const plan = {
    phases: [basePhase(1, { acceptance_criteria: ['a', 'b', 'c', 'd', 'e'] })],
  };
  const strict = validatePlanStructure(plan, { sizeLimits: { max_acceptance_criteria: 4 } });
  assert.equal(strict.ok, false, '5 criteria fails a max of 4');
  const loose = validatePlanStructure(plan, { sizeLimits: { max_acceptance_criteria: 20 } });
  assert.equal(loose.ok, true, '5 criteria passes a max of 20');
});

test('validatePlanStructure: learned turn history rejects a phase predicted above the development target', () => {
  const risky = basePhase(1, {
    checkpoint: 'external-integration',
    acceptance_criteria: ['a', 'b', 'c'],
    files_expected: ['a.js', 'b.js', 'c.js'],
  });
  const samples = Array.from({ length: 20 }, () => ({
    criteria_count: 3, files_count: 3, high_risk: 1,
    dependency_count: 0, text_chars: 60, actual_turns: 62,
  }));
  const result = validatePlanStructure({ phases: [risky] }, {
    turnPrediction: {
      enabled: true, samples, min_samples: 12,
      max_predicted_turns: 45, min_confidence: 0,
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.predictions[0].source, 'historical-knn');
  assert.ok(result.problems.some((problem) => /predicted .* turns.*split into approximately/.test(problem)));
});

test('validatePlanStructure: heuristic prediction is advisory until history is sufficient', () => {
  const result = validatePlanStructure({ phases: [basePhase(1)] }, {
    turnPrediction: { enabled: true, samples: [], max_predicted_turns: 1 },
  });
  assert.equal(result.ok, true);
  assert.equal(result.predictions[0].source, 'heuristic');
});
