import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.DB_PATH = ':memory:';

const {
  resolveInterruptedPhaseSessionId,
  shouldReconcileInterruptedPhaseCommit,
} = await import('./phase-runner.js');

test('resolveInterruptedPhaseSessionId resumes only an in-progress numbered phase', () => {
  const base = {
    cfg: { model: 'claude-sonnet-5', phases: {} },
    priorPhaseState: {
      status: 'in-progress', session_id: 'sess-interrupted',
      model_used: 'claude-sonnet-5', interruption_kind: 'provider-limit',
    },
    fix: null, isBatch: false, laneMode: false,
  };
  assert.equal(resolveInterruptedPhaseSessionId(base), 'sess-interrupted');
  assert.equal(resolveInterruptedPhaseSessionId({ ...base, priorPhaseState: { ...base.priorPhaseState, status: 'failed' } }), null);
  assert.equal(resolveInterruptedPhaseSessionId({ ...base, priorPhaseState: { ...base.priorPhaseState, interruption_kind: null } }), null);
  assert.equal(resolveInterruptedPhaseSessionId({ ...base, priorPhaseState: { ...base.priorPhaseState, interruption_kind: 'validation' } }), null);
  assert.equal(resolveInterruptedPhaseSessionId({ ...base, cfg: { ...base.cfg, model: 'claude-opus-4-8' } }), null);
  assert.equal(resolveInterruptedPhaseSessionId({ ...base, fix: { round: 1, n: 1 } }), null);
  assert.equal(resolveInterruptedPhaseSessionId({ ...base, laneMode: true }), null);
  assert.equal(resolveInterruptedPhaseSessionId({ ...base, cfg: { phases: { resume_interrupted_session: false } } }), null);
});

test('shouldReconcileInterruptedPhaseCommit requires matching HEAD, report, and no validation failure', () => {
  const sha = 'a'.repeat(40);
  const base = {
    cfg: { phases: {} },
    priorPhaseState: { status: 'in-progress', session_id: 'sess-interrupted', interruption_kind: 'process' },
    fix: null, isBatch: false, laneMode: false,
    headSha: sha, phaseCommit: sha, reportExists: true, hasValidationFailure: false,
  };
  assert.equal(shouldReconcileInterruptedPhaseCommit(base), true);
  assert.equal(shouldReconcileInterruptedPhaseCommit({ ...base, phaseCommit: 'b'.repeat(40) }), false);
  assert.equal(shouldReconcileInterruptedPhaseCommit({ ...base, reportExists: false }), false);
  assert.equal(shouldReconcileInterruptedPhaseCommit({ ...base, hasValidationFailure: true }), false);
  assert.equal(shouldReconcileInterruptedPhaseCommit({ ...base, cfg: { phases: { reconcile_committed_phase_before_spawn: false } } }), false);
});

test('runDev wires the persisted session into markPhaseStarted and the resumed dev call', () => {
  const src = readFileSync(fileURLToPath(new URL('./phase-runner.js', import.meta.url)), 'utf-8');
  assert.match(src, /markPhaseStarted\(\{ project: projectName, n: nextPhase, model_used: modelForRecord, session_id: interruptedSessionId \}\)/);
  assert.match(src, /systemPromptExtra: devSystemPromptExtra,\s*\n\s*sessionId: interruptedSessionId,/);
  assert.match(src, /re-running the normal validators\/acceptance gate/);
});
