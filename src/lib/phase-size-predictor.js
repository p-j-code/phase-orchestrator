// Historical phase-turn predictor.
//
// The static plan ceilings catch obviously oversized phases, but criteria/file
// counts alone missed many 60-turn failures. This module learns from completed
// execution features while retaining a conservative deterministic fallback.
// Provider-limit rows are excluded by the state query/caller because they say
// nothing about phase complexity.

const HIGH_RISK_CHECKPOINTS = new Set(['architecture', 'schema', 'external-integration', 'destructive']);

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function extractPhaseSizeFeatures(phase = {}) {
  const criteria = Array.isArray(phase.acceptance_criteria) ? phase.acceptance_criteria.filter(Boolean) : [];
  const files = Array.isArray(phase.files_expected) ? phase.files_expected.filter(Boolean) : [];
  const checkpoint = typeof phase.checkpoint === 'string' ? phase.checkpoint : 'routine';
  const text = `${phase.title || ''} ${phase.goal || ''} ${criteria.join(' ')}`;
  return {
    criteria_count: criteria.length,
    files_count: files.length,
    high_risk: HIGH_RISK_CHECKPOINTS.has(checkpoint) ? 1 : 0,
    dependency_count: Array.isArray(phase.depends_on) ? phase.depends_on.length : 0,
    text_chars: Math.min(text.length, 12000),
  };
}

export function heuristicPhaseTurns(phase = {}) {
  const f = extractPhaseSizeFeatures(phase);
  // Deliberately less aggressive than the old 10-criteria/15-file hard
  // ceiling: it predicts effort but does not block without learned evidence.
  return Math.round(Math.min(120,
    10
    + f.criteria_count * 3
    + f.files_count * 1.1
    + f.high_risk * 7
    + Math.min(8, f.text_chars / 750)
    + Math.min(4, f.dependency_count * 1.5)
  ));
}

function normalizedSample(sample) {
  if (!sample || sample.provider_error === true || Number(sample.provider_error) > 0) return null;
  const maxTurnError = sample.max_turn_error === true || Number(sample.max_turn_error) > 0;
  const successKnown = sample.success != null;
  const successful = sample.success === true || Number(sample.success) > 0;
  const completedKnown = sample.completed != null;
  const completed = sample.completed === true || Number(sample.completed) > 0;
  const status = String(sample.status || '').trim().toLowerCase();
  const explicitlyIncomplete = (successKnown && !successful)
    || (completedKnown && !completed)
    || sample.is_error === true
    || Number(sample.is_error) > 0
    || ['aborted', 'cancelled', 'canceled', 'error', 'failed', 'incomplete', 'timeout', 'timed-out'].includes(status);
  // Ordinary failures are partial-work measurements, not phase-size labels.
  // Max-turn failures are the exception: they are useful lower-bound evidence.
  if (explicitlyIncomplete && !maxTurnError) return null;
  const actual = finiteNumber(sample.actual_turns ?? sample.num_turns, NaN);
  if (!Number.isFinite(actual) || actual <= 0) return null;
  return {
    criteria_count: Math.max(0, finiteNumber(sample.criteria_count)),
    files_count: Math.max(0, finiteNumber(sample.files_count)),
    high_risk: finiteNumber(sample.high_risk) > 0 ? 1 : 0,
    dependency_count: Math.max(0, finiteNumber(sample.dependency_count)),
    text_chars: Math.max(0, finiteNumber(sample.text_chars)),
    actual_turns: Math.min(180, actual),
    // Max-turn outcomes are right-censored: the true completion cost is above
    // the observed cutoff. Keep them out of the ordinary regression label and
    // retain a conservative local lower bound instead.
    right_censored: maxTurnError,
    censored_floor: maxTurnError ? Math.min(180, actual + 12) : null,
  };
}

function featureDistance(left, right) {
  return Math.abs(left.criteria_count - right.criteria_count) / 6
    + Math.abs(left.files_count - right.files_count) / 10
    + Math.abs(left.high_risk - right.high_risk) * 1.5
    + Math.abs(left.dependency_count - right.dependency_count) / 4
    + Math.abs(left.text_chars - right.text_chars) / 4000;
}

export function predictPhaseTurns(phase, samples = [], { minSamples = 12, targetTurns = 45 } = {}) {
  const features = extractPhaseSizeFeatures(phase);
  const heuristic = heuristicPhaseTurns(phase);
  const valid = (Array.isArray(samples) ? samples : []).map(normalizedSample).filter(Boolean);
  if (valid.length < minSamples) {
    return {
      predicted_turns: heuristic,
      source: 'heuristic',
      confidence: 0,
      sample_count: valid.length,
      target_turns: targetTurns,
      recommended_splits: Math.max(1, Math.ceil(heuristic / targetTurns)),
      features,
    };
  }

  const nearest = valid
    .map((sample) => ({ sample, distance: featureDistance(features, sample) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, Math.min(10, valid.length));
  let weightedTurns = 0;
  let totalWeight = 0;
  for (const row of nearest) {
    if (row.sample.right_censored) continue;
    const weight = 1 / (0.25 + row.distance);
    weightedTurns += row.sample.actual_turns * weight;
    totalWeight += weight;
  }
  const learned = totalWeight ? weightedTurns / totalWeight : heuristic;
  // A nearby exhausted execution says this phase needs more than its observed
  // cutoff. Do not average that one-sided evidence down as though it completed
  // at the cutoff. Distance 1 is deliberately local (roughly six criteria or
  // ten files in this feature scale), so unrelated censored rows cannot impose
  // a portfolio-wide floor.
  const censoredFloor = nearest
    .filter((row) => row.sample.right_censored && row.distance <= 1)
    .reduce((floor, row) => Math.max(floor, row.sample.censored_floor), 0);
  const predicted = Math.round(Math.min(180, Math.max(
    censoredFloor,
    heuristic * 0.2 + learned * 0.8,
  )));
  const meanDistance = nearest.reduce((sum, row) => sum + row.distance, 0) / nearest.length;
  const confidence = Math.max(0, Math.min(1,
    Math.min(1, valid.length / Math.max(minSamples * 2, 1)) * (1 / (1 + meanDistance)),
  ));
  return {
    predicted_turns: predicted,
    source: 'historical-knn',
    confidence: Math.round(confidence * 1000) / 1000,
    sample_count: valid.length,
    target_turns: targetTurns,
    recommended_splits: Math.max(1, Math.ceil(predicted / targetTurns)),
    features,
  };
}
