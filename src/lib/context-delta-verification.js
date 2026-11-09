// Hybrid Context Compiler — safety decision for delta-only acceptance checks.

function key(value) {
  return String(value?.criterion ?? value?.text ?? value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function pathsForCriterion(criterion) {
  return new Set([
    ...(criterion?.production_files || []),
    ...(criterion?.tests || []),
    ...(criterion?.configuration || []),
  ]);
}

/**
 * Delta verification is allowed only when the baseline exactly represents the
 * authored criteria and every repair edit is covered by compiled evidence.
 * Any ambiguity returns a full-check plan.
 */
export function resolveDeltaAcceptancePlan({
  cfg,
  manifest,
  compiledUse,
  baselineVerdict,
  phaseMeta,
  changedFiles = [],
  changedFilesKnown = true,
} = {}) {
  const full = (reason) => ({ delta: false, reason, phaseMeta });
  const compiler = cfg?.context_compiler || {};
  if (compiler.enabled !== true || !['assist', 'enforce'].includes(compiler.mode)) return full('compiler is not active');
  if (compiler.delta_acceptance_recheck !== true) return full('delta acceptance rechecks are disabled');
  if (!manifest || compiledUse?.degraded || compiledUse?.force_full_verification) return full('compiled evidence is absent or degraded');
  const minConfidence = Number.isFinite(compiler.min_confidence) ? compiler.min_confidence : 0.65;
  if (!Number.isFinite(Number(manifest.confidence)) || Number(manifest.confidence) < minConfidence) {
    return full('compiled evidence confidence is below the configured threshold');
  }
  if (!changedFilesKnown) return full('repair changed-file set is unavailable');

  const authored = Array.isArray(phaseMeta?.acceptance_criteria) ? phaseMeta.acceptance_criteria : [];
  const baseline = Array.isArray(baselineVerdict?.criteria) ? baselineVerdict.criteria : [];
  const authoredKeys = authored.map(key);
  const baselineKeys = baseline.map(key);
  if (!authored.length || authoredKeys.length !== new Set(authoredKeys).size) return full('authored criteria are empty or ambiguous');
  if (baselineKeys.length !== authoredKeys.length
      || baselineKeys.length !== new Set(baselineKeys).size
      || baselineKeys.some((value) => !authoredKeys.includes(value))) {
    return full('baseline verdict does not exactly cover authored criteria');
  }

  const criterionMap = Array.isArray(manifest.criteria_map) ? manifest.criteria_map : [];
  const manifestKeys = criterionMap.map((criterion) => key(criterion.criterion));
  if (manifestKeys.length !== authoredKeys.length
      || manifestKeys.length !== new Set(manifestKeys).size
      || manifestKeys.some((value) => !authoredKeys.includes(value))
      || criterionMap.some((criterion) => pathsForCriterion(criterion).size === 0)) {
    return full('compiled criterion evidence does not exactly cover authored criteria');
  }

  const mappedFiles = new Set((manifest.ranked_files || []).map((file) => file.path));
  const changed = [...new Set((Array.isArray(changedFiles) ? changedFiles : []).map(String))];
  if (changed.some((file) => !mappedFiles.has(file))) return full('repair changed files outside compiled evidence');

  const impactedByFile = new Map();
  for (const criterion of criterionMap) {
    for (const file of pathsForCriterion(criterion)) {
      const impacted = impactedByFile.get(file) || new Set();
      impacted.add(key(criterion.criterion));
      impactedByFile.set(file, impacted);
    }
  }
  if (changed.some((file) => !impactedByFile.has(file))) {
    return full('repair changed files lack criterion-level evidence');
  }

  // Recheck everything that is not affirmatively 'met': 'unmet' obviously, but
  // also 'unverifiable' (the adversarial framing tells checkers to use it for
  // doubtful criteria — a delta pass must not launder doubt into a pass) and
  // any unknown status string a future checker vocabulary might introduce.
  const selected = new Set(baseline.filter((criterion) => criterion?.status !== 'met').map(key));
  for (const file of changed) for (const criterionKey of impactedByFile.get(file) || []) selected.add(criterionKey);
  const subset = authored.filter((criterion) => selected.has(key(criterion)));
  if (!subset.length) return full('no failed or repair-impacted criteria were mapped');
  return {
    delta: true,
    reason: `recheck ${subset.length}/${authored.length} failed or repair-impacted criteria`,
    phaseMeta: { ...phaseMeta, acceptance_criteria: subset },
    baselineVerdict,
  };
}
