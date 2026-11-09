import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CONTEXT_COMPILER_ROLLOUT_POLICY,
  createContextCompilerRolloutStage,
  evaluateContextCompilerRollout,
  resolveContextCompilerRolloutPolicy,
  summarizeContextCompilerTelemetry,
} from './context-compiler-policy.js';

const NOW = Date.parse('2026-07-15T12:00:00.000Z');

function manifest(index, overrides = {}) {
  return {
    manifest_id: `manifest-${index}`,
    generated_at: new Date(NOW - index * 60_000).toISOString(),
    provider: 'hybrid-lexical',
    mode: 'shadow',
    status: 'compiled',
    precision: 0.8,
    recall: 0.9,
    confidence: 0.8,
    ...overrides,
  };
}

function testPolicy(overrides = {}) {
  return {
    window_size: 4,
    max_sample_age_hours: 24,
    promotion: {
      min_samples: 4,
      min_outcome_samples: 4,
      min_outcome_coverage: 1,
      min_precision: 0.7,
      min_recall: 0.8,
      min_confidence: 0.65,
      max_failure_rate: 0,
      ...(overrides.promotion || {}),
    },
    rollback: {
      min_samples: 3,
      min_outcome_samples: 2,
      min_outcome_coverage: 0.5,
      min_precision: 0.5,
      min_recall: 0.6,
      min_confidence: 0.5,
      max_failure_rate: 0.2,
      ...(overrides.rollback || {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !['promotion', 'rollback'].includes(key))),
  };
}

function codes(decision) {
  return decision.blockers.map((item) => item.code);
}

test('policy defaults are conservative and resolver discards unsafe invalid values', () => {
  const resolved = resolveContextCompilerRolloutPolicy({
    window_size: 4,
    max_sample_age_hours: null,
    promotion: {
      min_samples: true,
      min_outcome_samples: -1,
      min_precision: null,
      min_recall: 5,
      max_failure_rate: false,
    },
  });

  assert.equal(resolved.window_size, 4);
  assert.equal(resolved.promotion.min_samples, 12, 'an undersized window must not silently weaken the default minimum');
  assert.equal(resolved.promotion.min_outcome_samples, 10);
  assert.equal(resolved.promotion.min_precision, DEFAULT_CONTEXT_COMPILER_ROLLOUT_POLICY.promotion.min_precision);
  assert.equal(resolved.promotion.min_recall, DEFAULT_CONTEXT_COMPILER_ROLLOUT_POLICY.promotion.min_recall);
  assert.equal(resolved.promotion.max_failure_rate, DEFAULT_CONTEXT_COMPILER_ROLLOUT_POLICY.promotion.max_failure_rate);
  assert.equal(resolved.max_sample_age_hours, DEFAULT_CONTEXT_COMPILER_ROLLOUT_POLICY.max_sample_age_hours);
});

test('shadow promotion is recommended only when every configured threshold passes', () => {
  const decision = evaluateContextCompilerRollout({
    manifests: [manifest(1), manifest(2), manifest(3), manifest(4)],
    currentMode: 'shadow',
    policy: testPolicy(),
    failureTelemetryComplete: true,
    now: NOW,
  });

  assert.equal(decision.recommendation, 'promote-to-assist');
  assert.equal(decision.recommended_mode, 'assist');
  assert.equal(decision.actionable, true);
  assert.deepEqual(decision.blockers, []);
  assert.equal(decision.metrics.total_considered, 4);
  assert.equal(decision.metrics.outcome_coverage, 1);
  assert.equal(decision.metrics.mean_precision, 0.8);
  assert.equal(decision.metrics.mean_recall, 0.9);
});

test('large monorepo evidence without a package boundary blocks promotion even when precision metrics pass', () => {
  const decision = evaluateContextCompilerRollout({
    manifests: [1, 2, 3, 4].map((index) => manifest(index, {
      candidate_files: 1900,
      package_scopes: index === 4 ? [] : ['packages/consent/'],
    })),
    currentMode: 'shadow',
    policy: testPolicy(),
    failureTelemetryComplete: true,
    now: NOW,
  });
  assert.equal(decision.recommendation, 'hold');
  assert.ok(codes(decision).includes('unscoped-large-repository'));
  assert.equal(decision.metrics.large_repo_scope_coverage, 0.75);
});

test('shadow promotion fails closed until failure-attempt telemetry is explicitly complete', () => {
  const decision = evaluateContextCompilerRollout({
    manifests: [manifest(1), manifest(2), manifest(3), manifest(4)],
    currentMode: 'shadow',
    policy: testPolicy(),
    now: NOW,
  });

  assert.equal(decision.recommendation, 'hold');
  assert.equal(decision.actionable, false);
  assert.equal(decision.metrics.failure_telemetry_complete, false);
  assert.deepEqual(codes(decision), ['incomplete-failure-telemetry']);
});

test('shadow evaluation reports all failed gates and remains non-actionable', () => {
  const rows = [
    manifest(1, { precision: 0.4, recall: 0.5, confidence: 0.4 }),
    manifest(2, { precision: 0.4, recall: 0.5, confidence: 0.4 }),
    manifest(3, { precision: null, recall: null, confidence: 0.4 }),
    manifest(4, { status: 'timeout', precision: null, recall: null, confidence: null }),
  ];
  const decision = evaluateContextCompilerRollout({
    manifests: rows, policy: testPolicy(), failureTelemetryComplete: true, now: NOW,
  });

  assert.equal(decision.recommendation, 'hold');
  assert.equal(decision.recommended_mode, 'shadow');
  assert.equal(decision.actionable, false);
  assert.deepEqual(codes(decision), [
    'insufficient-outcomes',
    'insufficient-confidence-samples',
    'low-outcome-coverage',
    'low-precision',
    'low-recall',
    'low-confidence',
    'high-failure-rate',
  ]);
  assert.equal(decision.metrics.outcome_samples, 2, 'null outcomes must not be coerced to zero-valued measurements');
  assert.equal(decision.metrics.failure_rate, 0.25);
});

test('minimum samples cannot be bypassed by a perfect but tiny telemetry window', () => {
  const decision = evaluateContextCompilerRollout({
    manifests: [manifest(1)],
    policy: testPolicy(),
    failureTelemetryComplete: true,
    now: NOW,
  });
  assert.equal(decision.recommendation, 'hold');
  assert.ok(codes(decision).includes('insufficient-samples'));
});

test('summary deduplicates IDs and excludes malformed, stale, future, wrong-mode, and wrong-provider rows', () => {
  const rows = [
    manifest(1),
    manifest(1, { generated_at: new Date(NOW - 2 * 60_000).toISOString() }),
    manifest(2, { mode: 'assist' }),
    manifest(3, { provider: 'semantic' }),
    manifest(4, { generated_at: new Date(NOW - 48 * 60 * 60_000).toISOString() }),
    manifest(5, { generated_at: new Date(NOW + 60_000).toISOString() }),
    { generated_at: new Date(NOW).toISOString() },
  ];
  const summary = summarizeContextCompilerTelemetry(rows, {
    currentMode: 'shadow', provider: 'hybrid-lexical', policy: testPolicy(), now: NOW,
  });

  assert.equal(summary.total_considered, 1);
  assert.deepEqual(summary.manifest_ids, ['manifest-1']);
  assert.deepEqual(summary.exclusions, {
    malformed: 1,
    duplicate: 1,
    wrong_mode: 1,
    wrong_provider: 1,
    outside_age_window: 2,
  });
});

test('provider is selected from the newest matching-mode row and implementations are never mixed', () => {
  const summary = summarizeContextCompilerTelemetry([
    manifest(1, { provider: 'semantic' }),
    manifest(2, { provider: 'semantic' }),
    manifest(3, { provider: 'hybrid-lexical' }),
  ], { currentMode: 'shadow', policy: testPolicy(), now: NOW });

  assert.equal(summary.provider, 'semantic');
  assert.deepEqual(summary.manifest_ids, ['manifest-1', 'manifest-2']);
  assert.equal(summary.exclusions.wrong_provider, 1);
});

test('only the newest configured window affects a promotion decision', () => {
  const rows = [
    manifest(1), manifest(2), manifest(3), manifest(4),
    manifest(5, { status: 'failed', precision: 0, recall: 0, confidence: 0 }),
    manifest(6, { status: 'failed', precision: 0, recall: 0, confidence: 0 }),
  ];
  const decision = evaluateContextCompilerRollout({
    manifests: rows, policy: testPolicy(), failureTelemetryComplete: true, now: NOW,
  });
  assert.equal(decision.recommendation, 'promote-to-assist');
  assert.deepEqual(decision.metrics.manifest_ids, ['manifest-1', 'manifest-2', 'manifest-3', 'manifest-4']);
});

test('compiled rows carrying an error are counted as failures', () => {
  const summary = summarizeContextCompilerTelemetry([
    manifest(1, { error_message: 'provider fallback failed' }),
    manifest(2),
  ], { policy: testPolicy(), now: NOW });
  assert.equal(summary.successful_samples, 1);
  assert.equal(summary.failure_samples, 1);
  assert.equal(summary.failure_rate, 0.5);
});

test('assist mode recommends rollback when the failure threshold is crossed', () => {
  const rows = [
    manifest(1, { mode: 'assist' }),
    manifest(2, { mode: 'assist' }),
    manifest(3, { mode: 'assist' }),
    manifest(4, { mode: 'assist', status: 'timeout', precision: null, recall: null }),
  ];
  const decision = evaluateContextCompilerRollout({
    manifests: rows, currentMode: 'assist', policy: testPolicy(), now: NOW,
  });
  assert.equal(decision.recommendation, 'rollback-to-shadow');
  assert.equal(decision.recommended_mode, 'shadow');
  assert.equal(decision.actionable, true);
  assert.ok(codes(decision).includes('high-failure-rate'));
});

test('assist mode recommends rollback when measured precision or recall degrades', () => {
  const rows = [1, 2, 3].map((index) => manifest(index, {
    mode: 'assist', precision: 0.4, recall: 0.5,
  }));
  const decision = evaluateContextCompilerRollout({
    manifests: rows, currentMode: 'assist', policy: testPolicy(), now: NOW,
  });
  assert.equal(decision.recommendation, 'rollback-to-shadow');
  assert.deepEqual(codes(decision), ['low-precision', 'low-recall']);
});

test('assist mode does not roll back from inadequate sample count alone', () => {
  const decision = evaluateContextCompilerRollout({
    manifests: [manifest(1, { mode: 'assist', status: 'failed' })],
    currentMode: 'assist',
    policy: testPolicy(),
    now: NOW,
  });
  assert.equal(decision.recommendation, 'hold');
  assert.equal(decision.recommended_mode, 'assist');
  assert.equal(decision.actionable, false);
  assert.deepEqual(decision.blockers, []);
});

test('auto-promoted assist rolls back on incomplete failure evidence even before the sample minimum', () => {
  const decision = evaluateContextCompilerRollout({
    manifests: [manifest(1, { mode: 'assist' })],
    currentMode: 'assist',
    policy: testPolicy(),
    failureTelemetryComplete: false,
    autoPromoted: true,
    now: NOW,
  });

  assert.equal(decision.recommendation, 'rollback-to-shadow');
  assert.equal(decision.recommended_mode, 'shadow');
  assert.equal(decision.actionable, true);
  assert.deepEqual(codes(decision), ['incomplete-failure-telemetry']);
});

test('healthy assist telemetry holds its mode and does not auto-promote to enforce', () => {
  const rows = [1, 2, 3, 4].map((index) => manifest(index, { mode: 'assist' }));
  const decision = evaluateContextCompilerRollout({
    manifests: rows, currentMode: 'assist', policy: testPolicy(), now: NOW,
  });
  assert.equal(decision.recommendation, 'hold');
  assert.equal(decision.recommended_mode, 'assist');
  assert.equal(decision.actionable, false);
});

test('enforce mode can fail safe back to shadow but is never entered automatically', () => {
  const rows = [1, 2, 3].map((index) => manifest(index, {
    mode: 'enforce', precision: 0.1, recall: 0.1,
  }));
  const decision = evaluateContextCompilerRollout({
    manifests: rows, currentMode: 'enforce', policy: testPolicy(), now: NOW,
  });
  assert.equal(decision.recommendation, 'rollback-to-shadow');
  assert.equal(decision.recommended_mode, 'shadow');
});

test('an unsupported current mode always holds even with otherwise excellent telemetry', () => {
  const decision = evaluateContextCompilerRollout({
    manifests: [manifest(1)], currentMode: 'automatic', policy: testPolicy(), now: NOW,
  });
  assert.equal(decision.recommendation, 'hold');
  assert.equal(decision.actionable, false);
  assert.deepEqual(codes(decision), ['unsupported-current-mode']);
});

test('actionable recommendations create deterministic audit stages without applying configuration', () => {
  const decision = evaluateContextCompilerRollout({
    manifests: [manifest(1), manifest(2), manifest(3), manifest(4)],
    policy: testPolicy(),
    failureTelemetryComplete: true,
    now: NOW,
  });
  const first = createContextCompilerRolloutStage(decision, { project: 'aoa' });
  const second = createContextCompilerRolloutStage(decision, { project: 'aoa' });

  assert.deepEqual(first, second);
  assert.match(first.stage_id, /^[a-f0-9]{64}$/);
  assert.equal(first.requires_explicit_apply, true);
  assert.deepEqual(first.config_patch, { context_compiler: { mode: 'assist' } });
  assert.equal(first.evidence.metrics.failure_telemetry_complete, true);
  assert.equal(first.evidence.thresholds.min_samples, 4);
  assert.deepEqual(first.evidence.manifest_ids, [
    'manifest-1', 'manifest-2', 'manifest-3', 'manifest-4',
  ]);
});

test('hold and forged inconsistent decisions cannot create a rollout stage', () => {
  const hold = evaluateContextCompilerRollout({ manifests: [], policy: testPolicy(), now: NOW });
  assert.equal(createContextCompilerRolloutStage(hold, { project: 'aoa' }), null);
  assert.equal(createContextCompilerRolloutStage({
    actionable: true,
    recommendation: 'promote-to-assist',
    current_mode: 'assist',
    recommended_mode: 'assist',
  }), null);
  assert.equal(createContextCompilerRolloutStage({
    actionable: true,
    recommendation: 'promote-to-assist',
    current_mode: 'shadow',
    recommended_mode: 'assist',
    metrics: { failure_telemetry_complete: false },
  }), null);
});
