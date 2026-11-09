import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPhaseSizeFeatures,
  heuristicPhaseTurns,
  predictPhaseTurns,
} from './phase-size-predictor.js';

const phase = {
  title: 'Consent capture', goal: 'Capture replies and write an audit trail',
  checkpoint: 'external-integration', depends_on: [1],
  acceptance_criteria: ['Capture reply', 'Enforce suppression', 'Write audit'],
  files_expected: ['src/a.js', 'src/b.js', 'tests/a.test.js'],
};

test('phase feature extraction recognizes high-risk boundaries', () => {
  const features = extractPhaseSizeFeatures(phase);
  assert.equal(features.criteria_count, 3);
  assert.equal(features.files_count, 3);
  assert.equal(features.high_risk, 1);
  assert.equal(features.dependency_count, 1);
});

test('predictor remains heuristic until enough clean historical samples exist', () => {
  const result = predictPhaseTurns(phase, [{ actual_turns: 20 }], { minSamples: 12 });
  assert.equal(result.source, 'heuristic');
  assert.equal(result.predicted_turns, heuristicPhaseTurns(phase));
});

test('historical predictor learns that similarly-sized phases are expensive and recommends splitting', () => {
  const features = extractPhaseSizeFeatures(phase);
  const samples = Array.from({ length: 16 }, (_, index) => ({
    ...features,
    actual_turns: 58 + (index % 4),
    max_turn_error: index % 3 === 0,
  }));
  const result = predictPhaseTurns(phase, samples, { minSamples: 12, targetTurns: 45 });
  assert.equal(result.source, 'historical-knn');
  assert.ok(result.predicted_turns > 45);
  assert.equal(result.recommended_splits, 2);
});

test('provider-limit samples are excluded from learning, including SQLite integer booleans', () => {
  const samples = Array.from({ length: 20 }, (_, index) => ({ actual_turns: 1, provider_error: index % 2 ? true : 1 }));
  assert.equal(predictPhaseTurns(phase, samples, { minSamples: 12 }).source, 'heuristic');
});

test('failed and explicitly incomplete executions are excluded instead of becoming cheap labels', () => {
  const features = extractPhaseSizeFeatures(phase);
  const samples = [
    ...Array.from({ length: 8 }, () => ({ ...features, actual_turns: 3, success: 0 })),
    ...Array.from({ length: 8 }, () => ({ ...features, actual_turns: 4, status: 'cancelled' })),
  ];
  const result = predictPhaseTurns(phase, samples, { minSamples: 12 });
  assert.equal(result.source, 'heuristic');
  assert.equal(result.sample_count, 0);
});

test('max-turn failures remain right-censored evidence and cannot be averaged below their cutoff', () => {
  const features = extractPhaseSizeFeatures(phase);
  const samples = Array.from({ length: 12 }, () => ({
    ...features,
    actual_turns: 60,
    success: 0,
    max_turn_error: 1,
  }));
  const result = predictPhaseTurns(phase, samples, { minSamples: 12, targetTurns: 45 });
  assert.equal(result.source, 'historical-knn');
  assert.equal(result.sample_count, 12);
  assert.ok(result.predicted_turns >= 72, 'right-censored history retains headroom above the observed cutoff');
  assert.equal(result.recommended_splits, 2);
});
