// Single-writer execution-host policy.
//
// Mac and NAS installations use separate SQLite databases, so their provider
// circuit breakers and heavy-call leases cannot coordinate with each other.
// A small checked-in policy, deployed identically to both hosts, designates
// the only role allowed to execute work. ASHMERO_ROLE identifies the current
// installation; the explicit multi-host env override is intentionally noisy.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const EXECUTION_HOST_POLICY_PATH = path.join(REPO_ROOT, 'config', 'execution-host.json');

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

function normalizedRole(value, fallback = '') {
  return String(value ?? fallback).trim().toLowerCase();
}

export function isExplicitMultiHostOptIn(env = process.env) {
  return TRUE_VALUES.has(String(env.ASHMERO_ALLOW_MULTI_HOST_EXECUTION || '').trim().toLowerCase());
}

/**
 * Pure policy evaluation used by startup and runner guards.
 */
export function evaluateExecutionHostPolicy({ policy, role = 'mac', hostId = null, allowMultiHost = false } = {}) {
  const currentRole = normalizedRole(role, 'mac');
  const currentHostId = normalizedRole(hostId, currentRole === 'mac' ? 'mac' : '');
  const activeRole = normalizedRole(policy?.active_role);
  const activeHostId = normalizedRole(policy?.active_host_id);
  if (!activeRole) {
    return {
      allowed: false,
      currentRole,
      currentHostId,
      activeRole: null,
      activeHostId: null,
      override: false,
      reason: 'config/execution-host.json must define a non-empty active_role',
    };
  }
  if (!activeHostId) {
    return {
      allowed: false,
      currentRole,
      currentHostId,
      activeRole,
      activeHostId: null,
      override: false,
      reason: 'config/execution-host.json must define a non-empty active_host_id',
    };
  }

  const policyAllowsMulti = policy?.allow_multi_host === true;
  if (allowMultiHost || policyAllowsMulti) {
    return {
      allowed: true,
      currentRole,
      currentHostId,
      activeRole,
      activeHostId,
      override: true,
      reason: 'multi-host execution explicitly enabled; provider admission is not shared across host databases',
    };
  }

  if (currentRole !== activeRole) {
    return {
      allowed: false,
      currentRole,
      currentHostId,
      activeRole,
      activeHostId,
      override: false,
      reason: `this install is role "${currentRole}" but execution authority is "${activeRole}"`,
    };
  }

  if (!currentHostId || currentHostId !== activeHostId) {
    return {
      allowed: false,
      currentRole,
      currentHostId: currentHostId || null,
      activeRole,
      activeHostId,
      override: false,
      reason: `this install host id is "${currentHostId || 'missing'}" but execution authority is "${activeHostId}"`,
    };
  }

  return {
    allowed: true,
    currentRole,
    currentHostId,
    activeRole,
    activeHostId,
    override: false,
    reason: 'role and host id own execution authority',
  };
}

export async function readExecutionHostPolicy({ policyPath = EXECUTION_HOST_POLICY_PATH } = {}) {
  let raw;
  try {
    raw = await fs.readFile(policyPath, 'utf8');
  } catch (err) {
    const wrapped = new Error(
      `Execution-host policy is unavailable at ${policyPath}: ${err.message}. ` +
      'Failing closed because separate host databases cannot coordinate provider usage.',
    );
    wrapped.code = 'EXECUTION_HOST_POLICY_INVALID';
    throw wrapped;
  }

  try {
    const policy = JSON.parse(raw);
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('root must be an object');
    return policy;
  } catch (err) {
    const wrapped = new Error(`Invalid execution-host policy at ${policyPath}: ${err.message}`);
    wrapped.code = 'EXECUTION_HOST_POLICY_INVALID';
    throw wrapped;
  }
}

/**
 * Fail closed before a worker/server/Claude execution surface starts work.
 * Returns the evaluation so callers can render the active role in status.
 */
export async function assertExecutionHost({
  entrypoint = 'execution',
  env = process.env,
  policyPath = EXECUTION_HOST_POLICY_PATH,
  warn = (message) => console.warn(message),
} = {}) {
  const policy = await readExecutionHostPolicy({ policyPath });
  const evaluation = evaluateExecutionHostPolicy({
    policy,
    role: env.ASHMERO_ROLE || 'mac',
    hostId: env.ASHMERO_HOST_ID || null,
    allowMultiHost: isExplicitMultiHostOptIn(env),
  });

  if (!evaluation.allowed) {
    const err = new Error(
      `[execution-host] Refusing ${entrypoint}: ${evaluation.reason}. ` +
      `Only one execution host may use this provider account. To move execution, update ` +
      `config/execution-host.json active_role/active_host_id and deploy that same file to every host. ` +
      `ASHMERO_ALLOW_MULTI_HOST_EXECUTION=true is the explicit unsafe-concurrency opt-in.`,
    );
    err.code = 'INACTIVE_EXECUTION_HOST';
    err.executionHost = evaluation;
    throw err;
  }

  if (evaluation.override) {
    warn(
      `[execution-host] WARNING: ${entrypoint} is using explicit multi-host execution. ` +
      'Mac and NAS have separate SQLite admission state, so account usage can race.',
    );
  }
  return evaluation;
}

/**
 * A state pull is safe only on an observer. Pulling over the active execution
 * host would replace the database beneath worker processes.
 */
export async function assertObserverForStatePull({
  env = process.env,
  policyPath = EXECUTION_HOST_POLICY_PATH,
} = {}) {
  const policy = await readExecutionHostPolicy({ policyPath });
  const evaluation = evaluateExecutionHostPolicy({
    policy,
    role: env.ASHMERO_ROLE || 'mac',
    hostId: env.ASHMERO_HOST_ID || null,
    allowMultiHost: isExplicitMultiHostOptIn(env),
  });
  if (!evaluation.activeRole || !evaluation.activeHostId) {
    const err = new Error(`[nas-sync] Refusing pull-state because the execution-host policy is invalid: ${evaluation.reason}`);
    err.code = 'EXECUTION_HOST_POLICY_INVALID';
    throw err;
  }
  if (evaluation.override || evaluation.currentRole === evaluation.activeRole) {
    const err = new Error(
      `[nas-sync] Refusing pull-state on execution role "${evaluation.currentRole}". ` +
      'Pull state only into an observer install after all local execution has been disabled; ' +
      'otherwise an open SQLite handle can continue duplicate work against the replaced file.',
    );
    err.code = 'NAS_PULL_ACTIVE_EXECUTION_HOST';
    throw err;
  }
  return evaluation;
}
