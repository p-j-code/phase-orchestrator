// Tests for the Phase 61 (P5) routing transparency feature — a pure READ
// layer over foundations telemetry (calls.routing_tier/routing_reason/
// attempt/escalated/num_turns/is_error) + Phase 60's verify_results. Covers
// the surfaces the acceptance criteria name:
//   1. state.js         — getPhaseRoutingChain() (the shared query helper)
//   2. web-ui.js        — GET /api/projects/:name/phases/:n/routing (real HTTP round-trip)
//   3. control-actions  — explain_routing chat tool parity
//   4. format.js        — routingStepLabel() pure per-call render helper
//   5. PhasesTab.js / PipelinePanel.js — decision-chain / "why this model" render logic
// Uses an in-memory SQLite database via DB_PATH=:memory: env override (same
// convention as src/lib/quality-report.test.mjs / run-events.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DB_PATH = ':memory:';

const {
  getDb, upsertProject, upsertPhase, recordCall, recordVerifyResult, getPhaseRoutingChain,
} = await import('../state.js');

const { toolExplainRouting } = await import('../chat/control-actions.js');
const { createWebUiApp } = await import('../web-ui.js');
const { routingStepLabel } = await import('../public/js/lib/format.js');
const PhasesTab = (await import('../public/js/components/tabs/PhasesTab.js')).default;
const PipelinePanel = (await import('../public/js/components/widgets/PipelinePanel.js')).default;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function setupProject(name) {
  upsertProject({ name, tech_stack: 'node', total_phases: 5 });
  return name;
}

test('getPhaseRoutingChain: a seeded two-call phase (baseline + escalated) returns the started_at-ordered chain with routing fields, phase status/title, and the latest verify_results verdict', () => {
  const project = setupProject('routing-two-call');
  upsertPhase({ project, n: 3, title: 'Migrate auth', status: 'completed' });
  recordCall({
    project, phase: 3, task: 'dev', model: 'claude-sonnet-5',
    num_turns: 150, max_turns: 150, routing_tier: 'sonnet',
    routing_reason: 'keyword [migration] min_tier', attempt: 1, escalated: 0,
    is_error: true, error_message: 'error_max_turns: hit the turn cap',
  });
  recordCall({
    project, phase: 3, task: 'dev', model: 'claude-opus-4-8',
    num_turns: 40, max_turns: 150, routing_tier: 'opus',
    routing_reason: 'escalated retry after error_max_turns', attempt: 2, escalated: 1,
    is_error: false,
  });
  recordVerifyResult({ project, phase: 3, verdict: 'pass', criteria_met: 4, criteria_unmet: 0, unverifiable: 0 });

  const chain = getPhaseRoutingChain({ project, phase: 3 });
  assert.equal(chain.project, project);
  assert.equal(chain.phase, 3);
  assert.equal(chain.status, 'completed');
  assert.equal(chain.title, 'Migrate auth');
  assert.equal(chain.calls.length, 2);

  const [baseline, escalated] = chain.calls;
  assert.equal(baseline.model, 'claude-sonnet-5');
  assert.equal(baseline.routing_tier, 'sonnet');
  assert.equal(baseline.routing_reason, 'keyword [migration] min_tier');
  assert.equal(baseline.attempt, 1);
  assert.equal(baseline.escalated, 0);
  assert.equal(baseline.is_error, 1);
  assert.equal(baseline.num_turns, 150);

  assert.equal(escalated.model, 'claude-opus-4-8');
  assert.equal(escalated.routing_tier, 'opus');
  assert.equal(escalated.attempt, 2);
  assert.equal(escalated.escalated, 1);
  assert.equal(escalated.is_error, 0);

  assert.ok(chain.verdict, 'latest verify_results verdict is joined in');
  assert.equal(chain.verdict.verdict, 'pass');
  assert.equal(chain.verdict.criteria_met, 4);
});

test('getPhaseRoutingChain: a phase with only a NULL-legacy-routing call renders gracefully — no crash, nulls pass through', () => {
  const project = setupProject('routing-legacy-null');
  upsertPhase({ project, n: 1, title: 'Legacy phase', status: 'completed' });
  // Pre-foundations shaped call: no routing_tier/routing_reason/attempt/num_turns/max_turns.
  recordCall({ project, phase: 1, task: 'dev', model: 'claude-sonnet-5' });

  const chain = getPhaseRoutingChain({ project, phase: 1 });
  assert.equal(chain.calls.length, 1);
  const [call] = chain.calls;
  assert.equal(call.routing_tier, null);
  assert.equal(call.routing_reason, null);
  assert.equal(call.attempt, null);
  assert.equal(call.escalated, 0, 'escalated defaults to 0, not null');
  assert.equal(call.num_turns, null);
  assert.equal(call.max_turns, null);
  assert.equal(chain.verdict, null, 'no verify_results row -> null verdict, not a throw');
});

test('getPhaseRoutingChain: an unknown project/phase resolves to an empty chain with null status/title/verdict, never throws', () => {
  assert.doesNotThrow(() => getPhaseRoutingChain({ project: 'routing-does-not-exist', phase: 99 }));
  const chain = getPhaseRoutingChain({ project: 'routing-does-not-exist', phase: 99 });
  assert.deepEqual(chain.calls, []);
  assert.equal(chain.status, null);
  assert.equal(chain.title, null);
  assert.equal(chain.verdict, null);
});

// ─── explain_routing chat tool (Phase 61 — P5) ──────────────────────────────

test('explain_routing: returns the same tier/reason/attempt/outcome-bearing chain as getPhaseRoutingChain, plus a hint', async () => {
  const project = setupProject('routing-tool-parity');
  upsertPhase({ project, n: 2, title: 'Phase two', status: 'in-progress' });
  recordCall({
    project, phase: 2, task: 'dev', model: 'claude-sonnet-5',
    routing_tier: 'sonnet', routing_reason: 'default tier', attempt: 1, escalated: 0, is_error: false,
  });
  const direct = getPhaseRoutingChain({ project, phase: 2 });
  const viaTool = await toolExplainRouting({ project, phase: 2 });
  const { hint, ...rest } = viaTool;
  assert.deepEqual(rest, direct, 'tool payload is byte-identical to the direct helper read (minus the hint)');
  assert.match(hint, /1 call/);
});

test('explain_routing: unknown project throws (ensureProject contract)', async () => {
  await assert.rejects(() => toolExplainRouting({ project: 'routing-tool-no-such-project', phase: 1 }));
});

test('explain_routing: non-integer phase throws a clear error', async () => {
  const project = setupProject('routing-tool-bad-phase');
  await assert.rejects(() => toolExplainRouting({ project, phase: 'not-a-number' }), /integer/);
});

// ─── GET /api/projects/:name/phases/:n/routing — real HTTP round-trip ───────

test('GET /api/projects/:name/phases/:n/routing returns the chain over the wire; unknown project 404s; invalid phase 400s', async () => {
  const app = createWebUiApp({ authToken: null });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://localhost:${server.address().port}`;
  try {
    const project = setupProject('routing-http-seeded');
    upsertPhase({ project, n: 5, title: 'HTTP phase', status: 'completed' });
    recordCall({
      project, phase: 5, task: 'dev', model: 'claude-sonnet-5',
      routing_tier: 'sonnet', routing_reason: 'min_tier', attempt: 1, escalated: 0, is_error: false,
    });
    recordVerifyResult({ project, phase: 5, verdict: 'fail', criteria_met: 1, criteria_unmet: 1, unverifiable: 0 });

    const r1 = await fetch(`${base}/api/projects/${project}/phases/5/routing`);
    const b1 = await r1.json();
    assert.equal(r1.status, 200);
    assert.equal(b1.calls.length, 1);
    assert.equal(b1.status, 'completed');
    assert.equal(b1.verdict.verdict, 'fail');
    assert.deepEqual(b1, getPhaseRoutingChain({ project, phase: 5 }), 'endpoint payload byte-identical to the direct helper read');

    const r404 = await fetch(`${base}/api/projects/no-such-routing-proj/phases/1/routing`);
    assert.equal(r404.status, 404, 'unknown project -> 404');

    const r400 = await fetch(`${base}/api/projects/${project}/phases/not-a-number/routing`);
    assert.equal(r400.status, 400, 'non-integer phase -> 400');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ─── routingStepLabel() pure helper (format.js) ─────────────────────────────

test('routingStepLabel: null call -> null (chainable without a length check)', () => {
  assert.equal(routingStepLabel(null), null);
  assert.equal(routingStepLabel(undefined), null);
});

test('routingStepLabel: a NULL-legacy-routing call reports hasRouting:false ("no routing recorded")', () => {
  const step = routingStepLabel({ id: 1, model: 'claude-sonnet-5', routing_tier: null, routing_reason: null, attempt: null, escalated: 0, is_error: 0 });
  assert.equal(step.hasRouting, false);
  assert.equal(step.model, 'claude-sonnet-5');
  assert.equal(step.outcome, 'completed');
});

test('routingStepLabel: an errored call whose error_message mentions max_turns reports outcome "error_max_turns"', () => {
  const step = routingStepLabel({ id: 1, model: 'claude-sonnet-5', routing_tier: 'sonnet', is_error: 1, error_message: 'error_max_turns: hit the cap' });
  assert.equal(step.outcome, 'error_max_turns');
  assert.equal(step.isError, true);
});

test('routingStepLabel: an errored call with an unrelated error_message reports the generic "error" outcome', () => {
  const step = routingStepLabel({ id: 1, model: 'claude-sonnet-5', is_error: 1, error_message: 'ECONNRESET' });
  assert.equal(step.outcome, 'error');
});

test('routingStepLabel: a successful escalated call carries attempt/escalated/reason through', () => {
  const step = routingStepLabel({ id: 2, model: 'claude-opus-4-8', routing_tier: 'opus', routing_reason: 'escalated retry', attempt: 2, escalated: 1, is_error: 0 });
  assert.equal(step.hasRouting, true);
  assert.equal(step.tier, 'opus');
  assert.equal(step.reason, 'escalated retry');
  assert.equal(step.attempt, 2);
  assert.equal(step.escalated, true);
  assert.equal(step.outcome, 'completed');
});

// ─── PhasesTab.js decision-chain render logic from a fixture ───────────────

test('PhasesTab: routingSteps/routingVerdictText build the decision chain from a fixture, and degrade to "no routing recorded" / no verdict without a throw', () => {
  const chainCalls = [
    { id: 1, model: 'claude-sonnet-5', routing_tier: 'sonnet', routing_reason: 'keyword [migration] min_tier', attempt: 1, escalated: 0, is_error: 1, error_message: 'error_max_turns' },
    { id: 2, model: 'claude-opus-4-8', routing_tier: 'opus', routing_reason: 'escalated retry', attempt: 2, escalated: 1, is_error: 0 },
  ];
  const ctx = {
    routing: {
      7: { loading: false, error: '', data: { status: 'completed', calls: chainCalls, verdict: { verdict: 'pass' } } },
      8: { loading: false, error: '', data: { status: 'completed', calls: [], verdict: null } },
    },
  };
  const steps = PhasesTab.methods.routingSteps.call(ctx, 7);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].outcome, 'error_max_turns');
  assert.equal(steps[1].escalated, true);
  assert.equal(PhasesTab.methods.routingVerdictText.call(ctx, 7), 'acceptance pass');
  assert.equal(PhasesTab.methods.routingVerdictColor.call(ctx, 7), 'var(--ok)');

  // No calls at all (empty chain) -> empty steps array, no throw; the phase
  // still completed, just with no acceptance check ever recorded for it.
  assert.deepEqual(PhasesTab.methods.routingSteps.call(ctx, 8), []);
  assert.equal(PhasesTab.methods.routingVerdictText.call(ctx, 8), 'completed, no acceptance check recorded');

  // A phase with no fetched routing data yet -> empty steps, no throw.
  assert.deepEqual(PhasesTab.methods.routingSteps.call(ctx, 999), []);
  assert.equal(PhasesTab.methods.routingVerdictText.call(ctx, 999), '');

  // The template statically wires the decision-chain rendering.
  const tpl = PhasesTab.template;
  assert.ok(tpl.includes('routingSteps'), 'decision chain steps are wired');
  assert.ok(tpl.includes('no routing recorded'), 'the legacy-NULL fallback copy is present');
  assert.ok(tpl.includes('routingVerdictText'), 'the trailing verdict chip is wired');
});

// ─── PipelinePanel.js "why this model" chip render logic from a fixture ────

test('PipelinePanel: whyChip prefers the latest call row, falls back to live_progress.model, and is null when neither applies', () => {
  const callCtx = {
    activePhase: { n: 4 },
    routingPhaseN: 4,
    routing: { calls: [
      { id: 1, model: 'claude-sonnet-5', routing_tier: 'sonnet', routing_reason: 'keyword [migration] min_tier', attempt: 1, escalated: 0, is_error: 0 },
      { id: 2, model: 'claude-opus-4-8', routing_tier: 'opus', routing_reason: 'escalated retry', attempt: 2, escalated: 1, is_error: 0 },
    ] },
    d: { liveProgress: null },
  };
  const chip = PipelinePanel.computed.whyChip.call(callCtx);
  assert.equal(chip.tier, 'opus', 'the LATEST call in the chain wins over the baseline');
  assert.equal(chip.reason, 'escalated retry');

  // No call row yet for this phase (still in flight) -> falls back to live_progress.model.
  const liveCtx = {
    activePhase: { n: 9 },
    routingPhaseN: 9,
    routing: { calls: [] },
    d: { liveProgress: { model: 'claude-sonnet-5', phase: 9 } },
  };
  const liveChip = PipelinePanel.computed.whyChip.call(liveCtx);
  assert.equal(liveChip.model, 'claude-sonnet-5');
  assert.equal(liveChip.hasRouting, false, 'live_progress fallback carries no reason');
  assert.equal(liveChip.reason, null);

  // Neither a call row nor a matching live_progress row -> null (chip hides).
  const idleCtx = { activePhase: { n: 9 }, routingPhaseN: null, routing: null, d: { liveProgress: null } };
  assert.equal(PipelinePanel.computed.whyChip.call(idleCtx), null);

  // No active phase at all -> null.
  assert.equal(PipelinePanel.computed.whyChip.call({ activePhase: null, routingPhaseN: null, routing: null, d: null }), null);

  const tpl = PipelinePanel.template;
  assert.ok(tpl.includes('whyChip'), 'the "why this model" chip is wired into the active-phase row');
});

// ─── Grep proof: the new routing-transparency code adds no writes ──────────
// P5 is a pure read layer over foundations columns + P4 (brief 06's explicit
// "no new routing logic and no writes" constraint). Extract the exact source
// slices this phase added and assert none of them contain an INSERT/UPDATE/
// DELETE statement — a cheap regression guard against a future edit
// accidentally turning this read endpoint into a writer.
test('grep proof: getPhaseRoutingChain (and its endpoint/tool callers) contain no INSERT/UPDATE/DELETE', () => {
  const stateSrc = fs.readFileSync(path.join(__dirname, '..', 'state.js'), 'utf-8');
  const fnMatch = stateSrc.match(/export function getPhaseRoutingChain\([\s\S]*?\n\}\n/);
  assert.ok(fnMatch, 'getPhaseRoutingChain function body found in state.js');
  assert.ok(!/\b(INSERT|UPDATE|DELETE)\b/i.test(fnMatch[0]), 'getPhaseRoutingChain issues no writes');

  const webUiSrc = fs.readFileSync(path.join(__dirname, '..', 'web-ui.js'), 'utf-8');
  const routeMatch = webUiSrc.match(/\/phases\/:n\/routing'[\s\S]*?\n {2}\}\);\n/);
  assert.ok(routeMatch, 'the /phases/:n/routing route handler found in web-ui.js');
  assert.ok(!/\b(INSERT|UPDATE|DELETE)\b/i.test(routeMatch[0]), 'the routing endpoint issues no writes');

  const controlSrc = fs.readFileSync(path.join(__dirname, '..', 'chat', 'control-actions.js'), 'utf-8');
  const toolMatch = controlSrc.match(/export async function toolExplainRouting\([\s\S]*?\n\}\n/);
  assert.ok(toolMatch, 'toolExplainRouting function body found in control-actions.js');
  assert.ok(!/\b(INSERT|UPDATE|DELETE)\b/i.test(toolMatch[0]), 'explain_routing issues no writes');
});
