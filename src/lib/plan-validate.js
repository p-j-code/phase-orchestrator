// Plan structure validation (v0.14.36) — pure, dependency-free, mechanical.
//
// The Opus-generated plan.json drives everything downstream; a structurally
// broken one (duplicate phase numbers, gaps, missing acceptance criteria)
// wastes whole phase runs before anyone notices. Most of those failures are
// mechanically checkable — no model call needed. This module is that check.
// The model-judgment half (FR coverage vs the brief) stays with the existing
// plan-validate guide task; this runs BEFORE it, for free.
//
// Used by auto-runner's post-plan block: problems → ONE auto-regen with the
// problem list injected via .guide/plan-fix.hint → re-validate → still broken
// → pause. Kept dependency-free so verifiers can import it anywhere.

import { predictPhaseTurns } from './phase-size-predictor.js';

// Phase 64 (intent-based checkpointing) — the vocabulary for a phase's
// `checkpoint` intent tag. Defined HERE, not in checkpoint.js, so this module
// stays dependency-free: checkpoint.js pulls in billing-guard/state, which a
// standalone verifier importing plan-validate must never transitively load.
// checkpoint.js re-imports this list so the two can never drift.
export const CHECKPOINT_INTENTS = ['architecture', 'schema', 'external-integration', 'destructive', 'routine'];

// Phase-size guard (2026-07-12, window economy) — an oversized phase is the
// #1 recorded cause of dev-execution failure (error_max_turns: the phase blows
// its turn budget, fails, and pays the escalated retry on top). These ceilings
// mirror config/model-routing.json's complexity_thresholds CRITICAL values
// (acceptance_criteria_critical=10, files_expected_critical=15): a phase big
// enough to force critical-complexity routing is big enough that the planner
// should have split it. Mechanically checkable at plan time — no model call —
// so it rides the existing problems → auto-regen (with hint) → re-validate
// loop. Override per call via validatePlanStructure's o.sizeLimits.
export const PHASE_SIZE_LIMITS = { max_acceptance_criteria: 10, max_files_expected: 15 };

/**
 * Resolve each phase's effective dependencies for the (future) parallel
 * scheduler. Read-side compat rule (phase-65): an explicit `depends_on` wins;
 * absent means "depends on the PREVIOUS ENTRY in the `phases` array" — NOT
 * n-1 arithmetic, since continuation plans renumber non-sequentially (mirrors
 * pickNextAction's own `phases.find(p => p.n > current_phase)` index lookup,
 * never a n-1 guess). The first entry always defaults to no dependencies.
 * Never throws; an unresolvable explicit ref is passed through unchanged —
 * validatePlanStructure reports those as named problems separately.
 *
 * @param {Array<object>} phases
 * @returns {number[][]} one depends_on array per phase, same order as `phases`
 */
export function resolveEffectiveDependsOn(phases) {
  if (!Array.isArray(phases)) return [];
  return phases.map((p, i) => {
    if (Array.isArray(p?.depends_on)) return p.depends_on;
    if (i === 0) return [];
    const prevN = phases[i - 1]?.n;
    return Number.isInteger(prevN) ? [prevN] : [];
  });
}

/**
 * Validate a parsed plan.json structurally.
 *
 * @param {object} plan                       parsed plan.json
 * @param {object} [o]
 * @param {number} [o.currentPhase=0]         project's current_phase — a new
 *                                            plan's first phase must be ahead
 *                                            of it or every phase is unreachable
 *                                            (pickNextAction finds via n > current_phase)
 * @param {object} [o.sizeLimits]             phase-size guard thresholds (2026-07-12
 *                                            window economy) — see PHASE_SIZE_LIMITS
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function validatePlanStructure(plan, { currentPhase = 0, sizeLimits = {}, turnPrediction = null } = {}) {
  const problems = [];
  const predictions = [];

  if (!plan || typeof plan !== 'object') {
    return { ok: false, problems: ['plan.json missing or not an object'], predictions };
  }
  const phases = plan.phases;
  if (!Array.isArray(phases) || phases.length === 0) {
    return { ok: false, problems: ['plan.phases is missing or empty — nothing to execute'], predictions };
  }

  const seen = new Set();
  let prevN = null;
  for (let i = 0; i < phases.length; i += 1) {
    const p = phases[i] || {};
    const at = `phases[${i}]`;

    if (!Number.isInteger(p.n) || p.n < 1) {
      problems.push(`${at}: "n" must be a positive integer (got ${JSON.stringify(p.n)})`);
    } else {
      if (seen.has(p.n)) problems.push(`${at}: duplicate phase number n=${p.n}`);
      seen.add(p.n);
      if (prevN !== null && p.n <= prevN) {
        problems.push(`${at}: phase numbers must be strictly increasing (n=${p.n} after n=${prevN})`);
      } else if (prevN !== null && p.n !== prevN + 1) {
        problems.push(`${at}: gap in numbering (n=${p.n} after n=${prevN}) — the orchestrator runs phases in sequence; gaps stall pickNextAction's expectations`);
      }
      prevN = Number.isInteger(p.n) ? p.n : prevN;
    }

    if (!p.title || typeof p.title !== 'string' || !p.title.trim()) {
      problems.push(`${at}: missing/empty "title"`);
    }
    if (!p.goal || typeof p.goal !== 'string' || !p.goal.trim()) {
      problems.push(`${at}${p.title ? ` ("${p.title}")` : ''}: missing/empty "goal"`);
    }
    const ac = p.acceptance_criteria;
    if (!Array.isArray(ac) || ac.length === 0 || !ac.some((c) => typeof c === 'string' && c.trim())) {
      problems.push(`${at}${p.title ? ` ("${p.title}")` : ''}: "acceptance_criteria" must be a non-empty array of strings — phases without testable criteria can't be reviewed or audited meaningfully`);
    }
    if (p.files_expected != null && !Array.isArray(p.files_expected)) {
      problems.push(`${at}: "files_expected" must be an array when present`);
    }

    // Phase-size guard — see PHASE_SIZE_LIMITS. Reported as a real problem so
    // the auto-regen loop replans with smaller phases instead of the phase
    // failing at runtime on error_max_turns and paying the escalated retry.
    const limits = { ...PHASE_SIZE_LIMITS, ...sizeLimits };
    const label = `${at}${p.title ? ` ("${p.title}")` : ''}`;
    if (Array.isArray(ac) && ac.length > limits.max_acceptance_criteria) {
      problems.push(`${label}: ${ac.length} acceptance criteria exceeds the ${limits.max_acceptance_criteria}-criterion phase-size ceiling — split this phase; oversized phases blow their turn budget (error_max_turns) and pay a failed call plus an escalated retry`);
    }
    if (Array.isArray(p.files_expected) && p.files_expected.length > limits.max_files_expected) {
      problems.push(`${label}: ${p.files_expected.length} files_expected exceeds the ${limits.max_files_expected}-file phase-size ceiling — split this phase; oversized phases blow their turn budget (error_max_turns) and pay a failed call plus an escalated retry`);
    }

    // Historical turn predictor. Heuristic-only output is advisory by default;
    // once enough clean execution samples exist, an over-target prediction is
    // a structural plan problem and rides the existing one-time auto-regen
    // path. This prevents repeatedly learning the same 60-turn failure at run
    // time while avoiding speculative plan fragmentation on a new project.
    if (turnPrediction?.enabled === true) {
      const maxPredictedTurns = Number(turnPrediction.max_predicted_turns ?? 45);
      const minConfidence = Number(turnPrediction.min_confidence ?? 0.25);
      const prediction = predictPhaseTurns(p, turnPrediction.samples || [], {
        minSamples: Number(turnPrediction.min_samples ?? 12),
        targetTurns: Number.isFinite(maxPredictedTurns) && maxPredictedTurns > 0 ? maxPredictedTurns : 45,
      });
      predictions.push({ phase: p.n ?? i + 1, title: p.title || null, ...prediction });
      const evidenceIsActionable = prediction.source === 'historical-knn'
        ? prediction.confidence >= minConfidence
        : turnPrediction.enforce_heuristic === true;
      if (evidenceIsActionable
          && Number.isFinite(maxPredictedTurns)
          && prediction.predicted_turns > maxPredictedTurns) {
        problems.push(
          `${label}: predicted ${prediction.predicted_turns} turns (${prediction.source}, confidence ${prediction.confidence}) exceeds the ${maxPredictedTurns}-turn development target — split into approximately ${prediction.recommended_splits} smaller phases; learned history predicts a max-turn/context failure`,
        );
      }
    }

    // Phase 64 — normalize the intent-based `checkpoint` tag IN PLACE.
    // Missing (legacy/untagged plans) or unrecognized values coerce to the
    // neutral 'routine' — NON-FATAL, so legacy plans still validate clean and
    // run under checkpoint_policy mode 'all' unchanged; an invalid tag simply
    // becomes 'routine' rather than reaching shouldPauseAfter's intent match.
    if (!CHECKPOINT_INTENTS.includes(p.checkpoint)) {
      p.checkpoint = 'routine';
    }
  }

  // Phase 65 (Execution DAG P1) — depends_on structural checks. These
  // append to `problems` but NEVER throw and NEVER block on their own: a
  // broken DAG is a signal for the future scheduler to fall back to serial
  // execution, not a validation failure. A plan with no depends_on anywhere
  // forms the degenerate previous-entry chain and reports zero problems here.
  const nToIndex = new Map();
  phases.forEach((p, i) => { if (Number.isInteger(p?.n)) nToIndex.set(p.n, i); });

  phases.forEach((p, i) => {
    const at = `phases[${i}]`;
    if (p?.depends_on == null) return;
    if (!Array.isArray(p.depends_on)) {
      problems.push(`${at}: "depends_on" must be an array of phase numbers when present`);
      return;
    }
    for (const dep of p.depends_on) {
      if (!Number.isInteger(dep)) {
        problems.push(`${at}: "depends_on" entry ${JSON.stringify(dep)} is not an integer`);
        continue;
      }
      if (Number.isInteger(p.n) && dep === p.n) {
        problems.push(`${at}: "depends_on" cannot reference itself (n=${p.n})`);
        continue;
      }
      if (!nToIndex.has(dep)) {
        problems.push(`${at}: "depends_on" references unknown phase n=${dep}`);
      }
    }
  });

  // Cycle detection via DFS over the EFFECTIVE graph (explicit depends_on
  // where present, else the previous-entry default) — the graph a future
  // scheduler actually walks. The implicit-only chain is always linear, so a
  // cycle can only appear via an explicit depends_on; self-refs above also
  // surface here since they close a 1-node loop. Unknown refs are skipped
  // (already reported above) so a bad ref never crashes the walk.
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Array(phases.length).fill(WHITE);
  const cycleNs = new Set();
  const effectiveDeps = resolveEffectiveDependsOn(phases);
  const visit = (i, stack) => {
    color[i] = GRAY;
    stack.push(i);
    for (const dep of effectiveDeps[i]) {
      const j = nToIndex.get(dep);
      if (j == null) continue;
      if (color[j] === GRAY) {
        const cycleStart = stack.indexOf(j);
        for (const k of stack.slice(cycleStart)) cycleNs.add(phases[k].n);
        continue;
      }
      if (color[j] === WHITE) visit(j, stack);
    }
    stack.pop();
    color[i] = BLACK;
  };
  for (let i = 0; i < phases.length; i += 1) {
    if (color[i] === WHITE) visit(i, []);
  }
  if (cycleNs.size > 0) {
    problems.push(`depends_on graph has a cycle involving phase(s) n=${[...cycleNs].sort((a, b) => a - b).join(', ')}`);
  }

  // Reachability: pickNextAction picks via plan.phases.find(p => p.n > current_phase).
  // A (continuation) plan whose first phase isn't ahead of current_phase is dead on arrival.
  const firstN = phases[0]?.n;
  if (Number.isInteger(firstN) && firstN <= currentPhase) {
    problems.push(`first phase n=${firstN} is not ahead of current_phase=${currentPhase} — every phase would appear already done (continuation plans must start at ${currentPhase + 1}+)`);
  }

  return { ok: problems.length === 0, problems, predictions };
}

/** Render problems for the plan-fix hint / pause reason. */
export function formatPlanProblems(problems, maxItems = 12) {
  const shown = problems.slice(0, maxItems).map((p) => `- ${p}`);
  if (problems.length > maxItems) shown.push(`- (+${problems.length - maxItems} more)`);
  return shown.join('\n');
}
