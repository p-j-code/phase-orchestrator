// Hybrid Context Compiler rollout policy.
//
// This module is deliberately pure: it reads no files, opens no database, and
// never changes project configuration.  A caller supplies recent manifest
// telemetry and receives either a hold recommendation or a deterministic,
// explicitly-applied staging record.  Keeping evaluation separate from
// application makes a bad or incomplete telemetry window fail safe.

import { createHash } from 'node:crypto';

const VALID_MODES = new Set(['shadow', 'assist', 'enforce']);
const SUCCESS_STATUSES = new Set(['compiled', 'completed', 'success']);

export const DEFAULT_CONTEXT_COMPILER_ROLLOUT_POLICY = Object.freeze({
  window_size: 20,
  max_sample_age_hours: 168,
  promotion: Object.freeze({
    min_samples: 12,
    min_outcome_samples: 10,
    min_outcome_coverage: 0.8,
    min_precision: 0.65,
    min_recall: 0.8,
    min_confidence: 0.65,
    max_failure_rate: 0.05,
  }),
  rollback: Object.freeze({
    min_samples: 5,
    min_outcome_samples: 3,
    min_outcome_coverage: 0.5,
    min_precision: 0.45,
    min_recall: 0.6,
    min_confidence: 0.45,
    max_failure_rate: 0.2,
  }),
});

function boundedInteger(value, fallback, min, max) {
  if (value == null || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min ? Math.min(parsed, max) : fallback;
}

function boundedNumber(value, fallback, min, max) {
  if (value == null || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function resolveThresholds(raw, defaults) {
  const source = raw && typeof raw === 'object' ? raw : {};
  // A threshold larger than the window intentionally makes promotion
  // impossible. Silently clamping it down would weaken the sample guard.
  const minSamples = boundedInteger(source.min_samples, defaults.min_samples, 1, 200);
  return {
    min_samples: minSamples,
    min_outcome_samples: boundedInteger(
      source.min_outcome_samples,
      Math.min(defaults.min_outcome_samples, minSamples),
      1,
      200,
    ),
    min_outcome_coverage: boundedNumber(
      source.min_outcome_coverage,
      defaults.min_outcome_coverage,
      0,
      1,
    ),
    min_precision: boundedNumber(source.min_precision, defaults.min_precision, 0, 1),
    min_recall: boundedNumber(source.min_recall, defaults.min_recall, 0, 1),
    min_confidence: boundedNumber(source.min_confidence, defaults.min_confidence, 0, 1),
    max_failure_rate: boundedNumber(source.max_failure_rate, defaults.max_failure_rate, 0, 1),
  };
}

/**
 * Normalize caller-supplied policy without accepting values that could bypass
 * the minimum-sample guard. Unknown fields are intentionally discarded.
 */
export function resolveContextCompilerRolloutPolicy(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const windowSize = boundedInteger(
    source.window_size,
    DEFAULT_CONTEXT_COMPILER_ROLLOUT_POLICY.window_size,
    1,
    200,
  );
  return {
    window_size: windowSize,
    max_sample_age_hours: boundedNumber(
      source.max_sample_age_hours,
      DEFAULT_CONTEXT_COMPILER_ROLLOUT_POLICY.max_sample_age_hours,
      1,
      24 * 365,
    ),
    promotion: resolveThresholds(
      source.promotion,
      DEFAULT_CONTEXT_COMPILER_ROLLOUT_POLICY.promotion,
    ),
    rollback: resolveThresholds(
      source.rollback,
      DEFAULT_CONTEXT_COMPILER_ROLLOUT_POLICY.rollback,
    ),
  };
}

function finiteRate(value) {
  if (value == null || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function rounded(value) {
  return value == null ? null : Math.round(value * 10000) / 10000;
}

function timestampOf(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function emptyExclusions() {
  return {
    malformed: 0,
    duplicate: 0,
    wrong_mode: 0,
    wrong_provider: 0,
    outside_age_window: 0,
  };
}

function hasPackageScope(row) {
  if (Array.isArray(row?.package_scopes)) return row.package_scopes.length > 0;
  if (typeof row?.package_scopes === 'string') {
    try {
      const parsed = JSON.parse(row.package_scopes);
      return Array.isArray(parsed) && parsed.length > 0;
    } catch { return row.package_scopes.trim().length > 2; }
  }
  return false;
}

/**
 * Produce the metrics consumed by rollout evaluation.
 *
 * Rows must have a stable manifest_id, valid generated_at, matching effective
 * mode, and matching provider. Callers with call-attributed mode data should
 * put that value in `mode`, because it proves whether context was injected more
 * reliably than a manifest's compile-time mode. If provider is omitted, the
 * newest valid row selects it so two implementations are never silently mixed.
 */
export function summarizeContextCompilerTelemetry(
  manifests,
  {
    currentMode = 'shadow',
    provider = null,
    policy: rawPolicy = {},
    failureTelemetryComplete = false,
    now = Date.now(),
  } = {},
) {
  const policy = resolveContextCompilerRolloutPolicy(rawPolicy);
  const rows = Array.isArray(manifests) ? manifests : [];
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const cutoff = safeNow - policy.max_sample_age_hours * 60 * 60 * 1000;
  const exclusions = emptyExclusions();
  const normalized = [];
  const seen = new Set();

  for (const row of rows) {
    if (!row || typeof row !== 'object' || typeof row.manifest_id !== 'string' || !row.manifest_id.trim()) {
      exclusions.malformed += 1;
      continue;
    }
    const generatedAt = timestampOf(row.generated_at);
    if (generatedAt == null || generatedAt < cutoff || generatedAt > safeNow) {
      exclusions.outside_age_window += 1;
      continue;
    }
    normalized.push({ ...row, manifest_id: row.manifest_id.trim(), _generated_at_ms: generatedAt });
  }

  normalized.sort((left, right) => (
    right._generated_at_ms - left._generated_at_ms
    || left.manifest_id.localeCompare(right.manifest_id)
  ));

  const matchingMode = [];
  for (const row of normalized) {
    if (seen.has(row.manifest_id)) {
      exclusions.duplicate += 1;
      continue;
    }
    seen.add(row.manifest_id);
    if (row.mode !== currentMode) {
      exclusions.wrong_mode += 1;
      continue;
    }
    matchingMode.push(row);
  }

  const selectedProvider = typeof provider === 'string' && provider.trim()
    ? provider.trim()
    : matchingMode.find((row) => typeof row.provider === 'string' && row.provider.trim())?.provider || null;
  const sameProvider = matchingMode.filter((row) => {
    if (selectedProvider && row.provider === selectedProvider) return true;
    exclusions.wrong_provider += 1;
    return false;
  });
  const considered = sameProvider.slice(0, policy.window_size);
  const isSuccessful = (row) => (
    SUCCESS_STATUSES.has(String(row.status || '').toLowerCase())
    && !(typeof row.error_message === 'string' && row.error_message.trim())
  );
  const successful = considered.filter(isSuccessful);
  const failures = considered.filter((row) => !isSuccessful(row));
  const outcomes = successful.filter((row) => finiteRate(row.precision) != null && finiteRate(row.recall) != null);
  const confidences = successful.map((row) => finiteRate(row.confidence)).filter((value) => value != null);
  const largeRepoSamples = successful.filter((row) => Number(row.candidate_files) >= 500);
  const unscopedLargeRepoSamples = largeRepoSamples.filter((row) => !hasPackageScope(row));
  const total = considered.length;

  return {
    provider: selectedProvider,
    current_mode: currentMode,
    failure_telemetry_complete: failureTelemetryComplete === true,
    total_supplied: rows.length,
    total_considered: total,
    successful_samples: successful.length,
    failure_samples: failures.length,
    outcome_samples: outcomes.length,
    confidence_samples: confidences.length,
    failure_rate: rounded(total ? failures.length / total : null),
    outcome_coverage: rounded(total ? outcomes.length / total : null),
    mean_precision: rounded(mean(outcomes.map((row) => finiteRate(row.precision)))),
    mean_recall: rounded(mean(outcomes.map((row) => finiteRate(row.recall)))),
    mean_confidence: rounded(mean(confidences)),
    large_repo_samples: largeRepoSamples.length,
    unscoped_large_repo_samples: unscopedLargeRepoSamples.length,
    large_repo_scope_coverage: rounded(
      largeRepoSamples.length ? 1 - (unscopedLargeRepoSamples.length / largeRepoSamples.length) : 1,
    ),
    manifest_ids: considered.map((row) => row.manifest_id),
    exclusions,
  };
}

function blocker(code, message, actual, required) {
  return { code, message, actual, required };
}

function promotionBlockers(metrics, thresholds) {
  const blockers = [];
  if (metrics.total_considered < thresholds.min_samples) {
    blockers.push(blocker('insufficient-samples', 'Not enough recent shadow manifests.', metrics.total_considered, thresholds.min_samples));
  }
  if (metrics.outcome_samples < thresholds.min_outcome_samples) {
    blockers.push(blocker('insufficient-outcomes', 'Not enough manifests have measured precision and recall.', metrics.outcome_samples, thresholds.min_outcome_samples));
  }
  if (metrics.confidence_samples < thresholds.min_outcome_samples) {
    blockers.push(blocker('insufficient-confidence-samples', 'Not enough manifests have measured compiler confidence.', metrics.confidence_samples, thresholds.min_outcome_samples));
  }
  if (metrics.outcome_coverage == null || metrics.outcome_coverage < thresholds.min_outcome_coverage) {
    blockers.push(blocker('low-outcome-coverage', 'Too little of the telemetry window has measured outcomes.', metrics.outcome_coverage, thresholds.min_outcome_coverage));
  }
  if (metrics.mean_precision == null || metrics.mean_precision < thresholds.min_precision) {
    blockers.push(blocker('low-precision', 'Mean edit-target precision is below the promotion threshold.', metrics.mean_precision, thresholds.min_precision));
  }
  if (metrics.mean_recall == null || metrics.mean_recall < thresholds.min_recall) {
    blockers.push(blocker('low-recall', 'Mean changed-file recall is below the promotion threshold.', metrics.mean_recall, thresholds.min_recall));
  }
  if (metrics.mean_confidence == null || metrics.mean_confidence < thresholds.min_confidence) {
    blockers.push(blocker('low-confidence', 'Mean compiler confidence is below the promotion threshold.', metrics.mean_confidence, thresholds.min_confidence));
  }
  if (metrics.unscoped_large_repo_samples > 0) {
    blockers.push(blocker(
      'unscoped-large-repository',
      'At least one large-repository sample had no inferred package boundary; automatic context injection could select a sibling package.',
      metrics.unscoped_large_repo_samples,
      0,
    ));
  }
  if (!metrics.failure_telemetry_complete) {
    blockers.push(blocker(
      'incomplete-failure-telemetry',
      'Failed compiler attempts are not known to be fully represented; automatic promotion is unsafe.',
      false,
      true,
    ));
  }
  if (metrics.failure_rate == null || metrics.failure_rate > thresholds.max_failure_rate) {
    blockers.push(blocker('high-failure-rate', 'Compiler failure rate is above the promotion threshold.', metrics.failure_rate, thresholds.max_failure_rate));
  }
  return blockers;
}

function rollbackSignals(metrics, thresholds, { autoPromoted = false } = {}) {
  const signals = [];
  // Insufficient samples alone are not a degradation signal. In contrast, a
  // dynamically promoted overlay depends on complete failure-attempt evidence;
  // once that evidence has a gap, shadow is the only auditable safe mode.
  if (autoPromoted && !metrics.failure_telemetry_complete) {
    signals.push(blocker(
      'incomplete-failure-telemetry',
      'Failure-attempt telemetry for the auto-promoted mode is incomplete; retaining it is unsafe.',
      false,
      true,
    ));
  }
  if (metrics.total_considered < thresholds.min_samples) return signals;
  if (metrics.unscoped_large_repo_samples > 0) {
    signals.push(blocker(
      'unscoped-large-repository',
      'Large-repository compiler evidence lost its package boundary.',
      metrics.unscoped_large_repo_samples,
      0,
    ));
  }
  if (metrics.failure_rate != null && metrics.failure_rate > thresholds.max_failure_rate) {
    signals.push(blocker('high-failure-rate', 'Compiler failure rate crossed the rollback threshold.', metrics.failure_rate, thresholds.max_failure_rate));
  }
  if (metrics.outcome_coverage == null || metrics.outcome_coverage < thresholds.min_outcome_coverage) {
    signals.push(blocker('low-outcome-coverage', 'Measured outcome coverage crossed the rollback threshold.', metrics.outcome_coverage, thresholds.min_outcome_coverage));
  }
  if (metrics.confidence_samples < thresholds.min_outcome_samples) {
    signals.push(blocker('insufficient-confidence-samples', 'Compiler confidence telemetry is incomplete.', metrics.confidence_samples, thresholds.min_outcome_samples));
  }
  if (metrics.outcome_samples >= thresholds.min_outcome_samples) {
    if (metrics.mean_precision == null || metrics.mean_precision < thresholds.min_precision) {
      signals.push(blocker('low-precision', 'Mean edit-target precision crossed the rollback threshold.', metrics.mean_precision, thresholds.min_precision));
    }
    if (metrics.mean_recall == null || metrics.mean_recall < thresholds.min_recall) {
      signals.push(blocker('low-recall', 'Mean changed-file recall crossed the rollback threshold.', metrics.mean_recall, thresholds.min_recall));
    }
  }
  if (metrics.confidence_samples >= thresholds.min_outcome_samples
      && (metrics.mean_confidence == null || metrics.mean_confidence < thresholds.min_confidence)) {
    signals.push(blocker('low-confidence', 'Mean compiler confidence crossed the rollback threshold.', metrics.mean_confidence, thresholds.min_confidence));
  }
  return signals;
}

function decisionBase({ currentMode, recommendedMode, recommendation, metrics, thresholds, blockers }) {
  return {
    schema_version: 1,
    current_mode: currentMode,
    recommended_mode: recommendedMode,
    recommendation,
    actionable: recommendation === 'promote-to-assist' || recommendation === 'rollback-to-shadow',
    metrics,
    thresholds,
    blockers,
  };
}

/**
 * Evaluate a rollout window. This function never promotes or rolls back by
 * itself; actionable results must be explicitly applied by the caller.
 */
export function evaluateContextCompilerRollout({
  manifests = [],
  currentMode = 'shadow',
  provider = null,
  policy: rawPolicy = {},
  failureTelemetryComplete = false,
  autoPromoted = false,
  now = Date.now(),
} = {}) {
  const policy = resolveContextCompilerRolloutPolicy(rawPolicy);
  if (!VALID_MODES.has(currentMode)) {
    return decisionBase({
      currentMode,
      recommendedMode: currentMode,
      recommendation: 'hold',
      metrics: summarizeContextCompilerTelemetry([], {
        currentMode, provider, policy, failureTelemetryComplete, now,
      }),
      thresholds: null,
      blockers: [blocker('unsupported-current-mode', 'Current compiler mode is not recognized.', currentMode, [...VALID_MODES])],
    });
  }

  const metrics = summarizeContextCompilerTelemetry(manifests, {
    currentMode, provider, policy, failureTelemetryComplete, now,
  });
  if (currentMode === 'shadow') {
    const blockers = promotionBlockers(metrics, policy.promotion);
    return decisionBase({
      currentMode,
      recommendedMode: blockers.length ? 'shadow' : 'assist',
      recommendation: blockers.length ? 'hold' : 'promote-to-assist',
      metrics,
      thresholds: policy.promotion,
      blockers,
    });
  }

  const signals = rollbackSignals(metrics, policy.rollback, { autoPromoted: autoPromoted === true });
  return decisionBase({
    currentMode,
    recommendedMode: signals.length ? 'shadow' : currentMode,
    recommendation: signals.length ? 'rollback-to-shadow' : 'hold',
    metrics,
    thresholds: policy.rollback,
    blockers: signals,
  });
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Convert an actionable recommendation into a serializable staging record.
 * The record is intentionally only a config patch proposal. It never writes
 * the patch and requires the caller to check `requires_explicit_apply`.
 */
export function createContextCompilerRolloutStage(decision, { project = null } = {}) {
  const validPromotion = decision?.recommendation === 'promote-to-assist'
    && decision.current_mode === 'shadow'
    && decision.recommended_mode === 'assist'
    && decision.metrics?.failure_telemetry_complete === true;
  const validRollback = decision?.recommendation === 'rollback-to-shadow'
    && ['assist', 'enforce'].includes(decision.current_mode)
    && decision.recommended_mode === 'shadow';
  if (!decision?.actionable || (!validPromotion && !validRollback)) return null;
  const safeProject = typeof project === 'string' && project.trim() ? project.trim() : null;
  const evidence = {
    current_mode: decision.current_mode,
    recommended_mode: decision.recommended_mode,
    provider: decision.metrics?.provider || null,
    manifest_ids: [...(decision.metrics?.manifest_ids || [])],
    metrics: {
      total_considered: decision.metrics?.total_considered ?? 0,
      outcome_samples: decision.metrics?.outcome_samples ?? 0,
      failure_telemetry_complete: decision.metrics?.failure_telemetry_complete === true,
      failure_rate: decision.metrics?.failure_rate ?? null,
      mean_precision: decision.metrics?.mean_precision ?? null,
      mean_recall: decision.metrics?.mean_recall ?? null,
      mean_confidence: decision.metrics?.mean_confidence ?? null,
    },
    thresholds: { ...(decision.thresholds || {}) },
    signal_codes: (decision.blockers || []).map((item) => item.code),
  };
  const stageId = digest({ project: safeProject, recommendation: decision.recommendation, evidence });
  return {
    schema_version: 1,
    stage_id: stageId,
    kind: 'context-compiler-rollout',
    project: safeProject,
    recommendation: decision.recommendation,
    from_mode: decision.current_mode,
    to_mode: decision.recommended_mode,
    config_patch: { context_compiler: { mode: decision.recommended_mode } },
    evidence,
    requires_explicit_apply: true,
  };
}
