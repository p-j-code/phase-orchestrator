// Budget Guard — per-project cost ceiling. Separate from billing-guard
// (which handles window-based budgets). This enforces lifetime caps per project.
//
// Config sources (highest specificity wins):
//   1. project.json:  overrides.budget.max_total_calls
//   2. defaults.json: budget.max_total_calls_per_project_default
//   3. No cap (returns null)

// Reuse the shared state.js connection: a private hardcoded-path Database()
// here bypassed the DB_PATH override (tests wrote the production DB) and any
// future path change would silently fork this module onto a different file.
import { getDb } from '../state.js';

export function projectCallCount(projectName) {
  const row = getDb().prepare('SELECT COUNT(*) as n FROM calls WHERE project = ?').get(projectName);
  return row?.n || 0;
}

export function projectCallCost(projectName) {
  const row = getDb().prepare('SELECT SUM(cost_usd) as total FROM calls WHERE project = ?').get(projectName);
  return row?.total || 0;
}

/**
 * Get the configured max_total_calls cap for a project.
 * Returns null if no cap configured.
 */
export function getProjectCallCap(cfg, projectName) {
  // Check resolved cfg (which already merged project overrides)
  const fromCfg = cfg?.budget?.max_total_calls;
  if (typeof fromCfg === 'number' && fromCfg > 0) return fromCfg;
  const fromDefault = cfg?.budget?.max_total_calls_per_project_default;
  if (typeof fromDefault === 'number' && fromDefault > 0) return fromDefault;
  return null;
}

/**
 * Check if project would exceed its cap with one more call.
 * Returns: { allowed, reason, cap, current }
 */
export function checkProjectBudget(cfg, projectName, ignoreBudget = false) {
  if (ignoreBudget) return { allowed: true, reason: 'budget check bypassed (--ignore-budget)', cap: null, current: null };
  const cap = getProjectCallCap(cfg, projectName);
  if (cap === null) return { allowed: true, reason: 'no cap configured', cap: null, current: null };
  const current = projectCallCount(projectName);
  if (current >= cap) {
    return {
      allowed: false,
      reason: `project budget exhausted: ${current}/${cap} calls used`,
      cap,
      current,
    };
  }
  return {
    allowed: true,
    reason: `${current}/${cap} calls used`,
    cap,
    current,
  };
}
