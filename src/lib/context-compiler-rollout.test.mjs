import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveEffectiveContextCompilerMode } from './context-compiler-rollout.js';
import { contextCompilerConfigFingerprint } from './context-compiler.js';

let TEST_FINGERPRINT;

function row(index, mode = 'shadow', overrides = {}) {
  return {
    manifest_id: `event-${index}`,
    generated_at: new Date(Date.now() - index * 1000).toISOString(),
    status: 'compiled', mode, provider: 'hybrid-lexical',
    compiler_fingerprint: TEST_FINGERPRINT, artifact_found: 1,
    precision: 0.9, recall: 0.95, confidence: 0.9,
    ...overrides,
  };
}

function baseCfg(overrides = {}) {
  return {
    context_compiler: {
      enabled: true, mode: 'shadow', provider: 'hybrid-lexical',
      rollout: {
        enabled: true, auto_promote: true, auto_rollback: true, window_size: 12,
        promotion: { min_samples: 12, min_outcome_samples: 10, min_outcome_coverage: 0.8, min_precision: 0.65, min_recall: 0.8, min_confidence: 0.65, max_failure_rate: 0.05 },
      },
      ...overrides,
    },
  };
}

TEST_FINGERPRINT = contextCompilerConfigFingerprint(baseCfg().context_compiler);

test('explicit auto_promote applies a healthy shadow recommendation to assist and audits it', () => {
  const saved = [];
  const result = resolveEffectiveContextCompilerMode({ projectName: 'demo', cfg: baseCfg() }, {
    getState: () => null,
    getWindow: () => Array.from({ length: 12 }, (_, index) => row(index)),
    saveState: (state) => saved.push(state),
  });
  assert.equal(result.effective_mode, 'assist');
  assert.equal(result.cfg.context_compiler.mode, 'assist');
  assert.equal(result.stage.to_mode, 'assist');
  assert.equal(saved[0].effective_mode, 'assist');
});

test('auto promotion holds for too little data and never enters enforce', () => {
  const result = resolveEffectiveContextCompilerMode({ projectName: 'demo', cfg: baseCfg() }, {
    getState: () => null, getWindow: () => [row(1)], saveState: () => {},
  });
  assert.equal(result.effective_mode, 'shadow');
  assert.equal(result.recommendation, 'hold');
});

test('bad assisted telemetry rolls back to shadow when auto_rollback is enabled', () => {
  const cfg = baseCfg({ mode: 'assist' });
  const result = resolveEffectiveContextCompilerMode({ projectName: 'demo', cfg }, {
    getState: () => ({ configured_mode: 'assist', effective_mode: 'assist' }),
    getWindow: () => Array.from({ length: 6 }, (_, index) => row(index, 'assist', { recall: 0.2 })),
    saveState: () => {},
  });
  assert.equal(result.effective_mode, 'shadow');
  assert.equal(result.recommendation, 'rollback-to-shadow');
});

test('incomplete failure evidence rolls an auto-promoted overlay back to shadow', () => {
  const result = resolveEffectiveContextCompilerMode({ projectName: 'demo', cfg: baseCfg() }, {
    getState: () => ({
      configured_mode: 'shadow',
      effective_mode: 'assist',
      evidence_json: JSON.stringify({ compiler_fingerprint: TEST_FINGERPRINT }),
    }),
    getWindow: () => [
      ...Array.from({ length: 3 }, (_, index) => row(index, 'assist')),
      row(20, 'assist', {
        status: 'untracked-artifact',
        compiler_fingerprint: null,
        artifact_found: 0,
      }),
    ],
    saveState: () => {},
  });

  assert.equal(result.effective_mode, 'shadow');
  assert.equal(result.recommendation, 'rollback-to-shadow');
  assert.deepEqual(result.decision.blockers.map((item) => item.code), ['incomplete-failure-telemetry']);
});

test('auto_promote false restores configured shadow after a previous dynamic promotion', () => {
  const cfg = baseCfg();
  cfg.context_compiler.rollout.auto_promote = false;
  const saved = [];
  const result = resolveEffectiveContextCompilerMode({ projectName: 'demo', cfg }, {
    getState: () => ({
      configured_mode: 'shadow', effective_mode: 'assist',
      evidence_json: JSON.stringify({ compiler_fingerprint: TEST_FINGERPRINT }),
    }),
    saveState: (next) => saved.push(next),
  });
  assert.equal(result.effective_mode, 'shadow');
  assert.equal(result.recommendation, 'automation-disabled');
  assert.match(saved[0].stage_id, /^[a-f0-9]{64}$/);
  assert.equal(saved[0].evidence.transition.from_mode, 'assist');
  assert.equal(saved[0].evidence.transition.to_mode, 'shadow');
});

test('re-enabling automation cannot immediately promote from evidence collected before it was disabled', () => {
  const oldHealthyShadow = Array.from({ length: 12 }, (_, index) => row(index + 20, 'shadow'));
  let state = {
    configured_mode: 'shadow', effective_mode: 'assist', recommendation: 'promote-to-assist',
    evidence_json: JSON.stringify({ compiler_fingerprint: TEST_FINGERPRINT }),
  };
  const deps = {
    getState: () => state,
    getWindow: () => oldHealthyShadow,
    saveState: (next) => { state = { ...next, evidence_json: JSON.stringify(next.evidence) }; },
  };
  const disabledCfg = baseCfg();
  disabledCfg.context_compiler.rollout.auto_promote = false;
  resolveEffectiveContextCompilerMode({ projectName: 'demo', cfg: disabledCfg }, deps);

  const reenabled = resolveEffectiveContextCompilerMode({ projectName: 'demo', cfg: baseCfg() }, deps);
  assert.equal(reenabled.effective_mode, 'shadow');
  assert.equal(reenabled.recommendation, 'hold');
  assert.equal(reenabled.decision.metrics.total_considered, 0);
});

test('disable then re-enable resets a stale dynamic overlay and rejects pre-disable evidence', () => {
  let state = {
    configured_mode: 'shadow', effective_mode: 'assist',
    evidence_json: JSON.stringify({ compiler_fingerprint: TEST_FINGERPRINT }),
  };
  const oldHealthyShadow = Array.from({ length: 12 }, (_, index) => row(index + 20, 'shadow'));
  const deps = {
    getState: () => state,
    getWindow: () => oldHealthyShadow,
    saveState: (next) => { state = { ...next, evidence_json: JSON.stringify(next.evidence) }; },
  };

  const disabledCfg = baseCfg({ enabled: false });
  const disabled = resolveEffectiveContextCompilerMode({ projectName: 'demo', cfg: disabledCfg }, deps);
  assert.equal(disabled.effective_mode, 'shadow');
  assert.equal(disabled.recommendation, 'disabled');
  assert.equal(state.effective_mode, 'shadow');
  const disabledAt = JSON.parse(state.evidence_json).transition.at;
  assert.ok(Date.parse(disabledAt));

  const reenabled = resolveEffectiveContextCompilerMode({ projectName: 'demo', cfg: baseCfg() }, deps);
  assert.equal(reenabled.effective_mode, 'shadow');
  assert.equal(reenabled.recommendation, 'hold');
  assert.equal(reenabled.decision.metrics.total_considered, 0);
});

test('rollout.enabled false also clears a dynamic overlay without relying on telemetry reads', () => {
  const saved = [];
  const cfg = baseCfg();
  cfg.context_compiler.rollout.enabled = false;
  const result = resolveEffectiveContextCompilerMode({ projectName: 'demo', cfg }, {
    getState: () => { throw new Error('read unavailable'); },
    saveState: (next) => saved.push(next),
  });
  assert.equal(result.effective_mode, 'shadow');
  assert.equal(result.recommendation, 'disabled');
  assert.equal(saved[0].effective_mode, 'shadow');
});

test('a rollback requires fresh post-transition shadow evidence before it can promote again', () => {
  const cfg = baseCfg();
  let state = {
    configured_mode: 'shadow', effective_mode: 'assist',
    evidence_json: JSON.stringify({ compiler_fingerprint: TEST_FINGERPRINT }),
  };
  const oldHealthyShadow = Array.from({ length: 12 }, (_, index) => row(index + 20, 'shadow'));
  const badAssist = Array.from({ length: 6 }, (_, index) => row(index, 'assist', { recall: 0.2 }));
  const deps = {
    getState: () => state,
    getWindow: () => [...badAssist, ...oldHealthyShadow],
    saveState: (next) => { state = { ...next, evidence_json: JSON.stringify(next.evidence) }; },
  };

  const rolledBack = resolveEffectiveContextCompilerMode({ projectName: 'demo', cfg }, deps);
  assert.equal(rolledBack.effective_mode, 'shadow');
  assert.equal(rolledBack.recommendation, 'rollback-to-shadow');

  const held = resolveEffectiveContextCompilerMode({ projectName: 'demo', cfg }, deps);
  assert.equal(held.effective_mode, 'shadow');
  assert.equal(held.recommendation, 'hold');
});

test('compiler setting changes invalidate a previously promoted overlay and its telemetry', () => {
  const cfg = baseCfg({ max_files: 13 });
  const result = resolveEffectiveContextCompilerMode({ projectName: 'demo', cfg }, {
    getState: () => ({
      configured_mode: 'shadow', effective_mode: 'assist',
      evidence_json: JSON.stringify({ compiler_fingerprint: TEST_FINGERPRINT }),
    }),
    getWindow: () => Array.from({ length: 12 }, (_, index) => row(index)),
    saveState: () => {},
  });
  assert.equal(result.effective_mode, 'shadow');
  assert.equal(result.recommendation, 'hold');
});

test('rollout telemetry failures never stop phase execution or apply an unaudited promotion', () => {
  const cfg = baseCfg();
  const readFailure = resolveEffectiveContextCompilerMode({ projectName: 'demo', cfg }, {
    getState: () => null, getWindow: () => { throw new Error('sqlite unavailable'); }, saveState: () => {},
  });
  assert.equal(readFailure.effective_mode, 'shadow');
  assert.equal(readFailure.recommendation, 'telemetry-unavailable');

  const writeFailure = resolveEffectiveContextCompilerMode({ projectName: 'demo', cfg }, {
    getState: () => null,
    getWindow: () => Array.from({ length: 12 }, (_, index) => row(index)),
    saveState: () => { throw new Error('disk full'); },
  });
  assert.equal(writeFailure.effective_mode, 'shadow');
  assert.equal(writeFailure.recommendation, 'telemetry-write-failed');
});

test('telemetry-window failure preserves a latched rollback beneath assist or enforce config', () => {
  for (const configuredMode of ['assist', 'enforce']) {
    const cfg = baseCfg({ mode: configuredMode });
    const fingerprint = contextCompilerConfigFingerprint(cfg.context_compiler);
    const result = resolveEffectiveContextCompilerMode({ projectName: 'demo', cfg }, {
      getState: () => ({
        configured_mode: configuredMode,
        effective_mode: 'shadow',
        evidence_json: JSON.stringify({ compiler_fingerprint: fingerprint }),
      }),
      getWindow: () => { throw new Error('sqlite unavailable'); },
      saveState: () => {},
    });

    assert.equal(result.configured_mode, configuredMode);
    assert.equal(result.effective_mode, 'shadow');
    assert.equal(result.cfg.context_compiler.mode, 'shadow');
    assert.equal(result.cfg.context_compiler._configured_mode, configuredMode);
    assert.equal(result.recommendation, 'telemetry-unavailable');
    assert.equal(result.changed, false);
  }
});
