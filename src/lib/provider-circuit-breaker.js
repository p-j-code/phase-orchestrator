// Shared Claude provider/account circuit breaker.
//
// The billing guard predicts local Max-window pressure. This breaker reacts to
// the provider's authoritative rejection. Its row lives in SQLite, so separate
// brief chains and server workers stop admitting calls as soon as any one of
// them observes a provider session/usage/weekly limit.

import {
  clearProviderCircuitBreaker,
  getProviderCircuitBreaker,
  tripProviderCircuitBreaker,
  recordProviderWindowObservation,
} from '../state.js';
import { extractProviderResetAt, isProviderRateLimitError } from './transient-errors.js';

const DEFAULT_COOLDOWN_MINUTES = 30;
const DEFAULT_SAFETY_BUFFER_SECONDS = 60;

export function providerCircuitScope(cfg = {}) {
  const configured = cfg.billing?.provider_circuit_breaker || {};
  const configuredCooldown = Number(configured.fallback_cooldown_minutes);
  const configuredBuffer = Number(configured.safety_buffer_seconds);
  return {
    enabled: configured.enabled !== false,
    provider: String(configured.provider || 'anthropic'),
    account: String(configured.account || cfg.billing?.mode || 'default'),
    fallbackCooldownMinutes: Math.max(
      1,
      Number.isFinite(configuredCooldown) ? configuredCooldown : DEFAULT_COOLDOWN_MINUTES,
    ),
    safetyBufferSeconds: Math.max(
      0,
      Number.isFinite(configuredBuffer) ? configuredBuffer : DEFAULT_SAFETY_BUFFER_SECONDS,
    ),
  };
}

export function providerCircuitStatus(cfg, { nowMs = Date.now() } = {}) {
  const scope = providerCircuitScope(cfg);
  if (!scope.enabled) return { ...scope, open: false, row: null };
  const row = getProviderCircuitBreaker(scope.provider, scope.account, { nowMs });
  return { ...scope, open: row?.open === true, row };
}

export class ProviderCircuitOpenError extends Error {
  constructor(status) {
    const resetSeconds = status.row?.blocked_until_ms
      ? Math.ceil(status.row.blocked_until_ms / 1000)
      : null;
    super(
      `Provider circuit breaker open for ${status.provider}/${status.account}`
      + `${status.row?.reason ? ` — ${status.row.reason}` : ''}`
      + `${resetSeconds ? `. {"resetsAt": ${resetSeconds}}` : ''}`,
    );
    this.name = 'ProviderCircuitOpenError';
    this.code = 'PROVIDER_CIRCUIT_OPEN';
    this.providerLimit = true;
    this.resetsAt = resetSeconds;
  }
}

/** Throw before spawn when another process has already observed exhaustion. */
export function assertProviderCircuitClosed(cfg, { nowMs = Date.now() } = {}) {
  const status = providerCircuitStatus(cfg, { nowMs });
  if (status.open) throw new ProviderCircuitOpenError(status);
  return status;
}

/**
 * Persist an authoritative provider rejection. Returns null for ordinary
 * failures or when the breaker is explicitly disabled.
 */
export function tripProviderCircuitFromError(cfg, errorText, {
  project = null, task = null, nowMs = Date.now(),
} = {}) {
  if (!isProviderRateLimitError(errorText)) return null;
  const scope = providerCircuitScope(cfg);
  if (!scope.enabled) return null;

  const advertisedReset = extractProviderResetAt(errorText, { nowMs });
  const blockedUntilMs = advertisedReset
    ? advertisedReset + scope.safetyBufferSeconds * 1000
    : nowMs + scope.fallbackCooldownMinutes * 60 * 1000;
  return tripProviderCircuitBreaker({
    provider: scope.provider,
    account: scope.account,
    blockedUntilMs,
    reason: String(errorText || 'provider usage limit').slice(0, 1000),
    project,
    task,
    nowMs,
  });
}

/**
 * React to Claude's proactive Max-plan window telemetry before it becomes a
 * hard rejection. The CLI emits an allowed_warning near full five-hour-window
 * utilization, including the authoritative reset timestamp. Let the current
 * call finish, but stop every subsequent project/helper spawn until that reset
 * so useful work ends at a checkpoint instead of failing mid-call.
 *
 * Proactive warnings are five-hour-only: the five-hour warning is the
 * immediate overnight liveness boundary and carries the reset used by the
 * durable scheduler, while a seven_day allowed_warning can arrive days before
 * the weekly limit actually bites. A `status:"rejected"` event, however, trips
 * for EVERY window type (five_hour, seven_day, session…) — the provider has
 * already refused the call, so letting the spawn die and re-parsing the reset
 * out of the exit-1 text (the pre-Jul-20 behavior) just burned one real call
 * per breaker-cooldown lapse.
 */
export function tripProviderCircuitFromStreamEvent(cfg, event, {
  project = null, task = null, nowMs = Date.now(), warningUtilization = 0.97,
} = {}) {
  if (event?.type !== 'rate_limit_event') return null;
  const info = event.rate_limit_info || {};
  const type = String(info.rateLimitType || info.rate_limit_type || '').toLowerCase().replace(/[- ]/g, '_');
  const status = String(info.status || '').toLowerCase();
  if (status !== 'rejected' && type !== 'five_hour') return null;

  const utilization = Number(info.utilization);
  // When the event reports a utilization figure, believe it: an allowed_warning
  // at 0.80 still leaves ~an hour of usable window, and tripping the shared
  // breaker on it discards that capacity in EVERY five-hour window. Only when
  // no utilization is reported does allowed_warning alone open the breaker.
  // A hard rejection skips the utilization check entirely.
  if (status !== 'rejected') {
    if (Number.isFinite(utilization)) {
      if (utilization < warningUtilization) return null;
    } else if (status !== 'allowed_warning') {
      return null;
    }
  }

  const scope = providerCircuitScope(cfg);
  if (!scope.enabled) return null;
  const rawReset = Number(info.resetsAt ?? info.resets_at);
  const resetMs = Number.isFinite(rawReset) && rawReset > 0
    ? (rawReset < 10_000_000_000 ? rawReset * 1000 : rawReset)
    : null;
  const blockedUntilMs = resetMs && resetMs > nowMs
    ? resetMs + scope.safetyBufferSeconds * 1000
    : nowMs + scope.fallbackCooldownMinutes * 60 * 1000;
  const reason = status === 'rejected'
    ? `${type || 'provider'} limit rejected the call`
    : `five_hour provider warning (${status || 'high-utilization'}, utilization ${Number.isFinite(utilization) ? utilization : 'unknown'})`;
  return tripProviderCircuitBreaker({
    provider: scope.provider,
    account: scope.account,
    blockedUntilMs,
    reason,
    project,
    task,
    nowMs,
  });
}

/**
 * Persist EVERY rate_limit_event's telemetry (not just trip-worthy ones):
 * billing-guard's windowStatus prefers a fresh provider utilization figure
 * over its local heavy-call-unit proxy, because the Max plan meters tokens
 * account-wide across all hosts while the local proxy counts this DB's calls.
 * Never throws.
 */
export function recordWindowObservationFromStreamEvent(cfg, event, { nowMs = Date.now() } = {}) {
  if (event?.type !== 'rate_limit_event') return;
  const info = event.rate_limit_info || {};
  const type = String(info.rateLimitType || info.rate_limit_type || 'unknown').toLowerCase().replace(/[- ]/g, '_');
  const rawReset = Number(info.resetsAt ?? info.resets_at);
  const resetsAtMs = Number.isFinite(rawReset) && rawReset > 0
    ? (rawReset < 10_000_000_000 ? rawReset * 1000 : rawReset)
    : null;
  const scope = providerCircuitScope(cfg);
  recordProviderWindowObservation({
    provider: scope.provider,
    account: scope.account,
    rateLimitType: type,
    status: String(info.status || '') || null,
    utilization: Number(info.utilization),
    resetsAtMs,
    observedAtMs: nowMs,
  });
}

/** Convenience reset used by operator paths and focused tests. */
export function resetProviderCircuit(cfg) {
  const scope = providerCircuitScope(cfg);
  return clearProviderCircuitBreaker(scope.provider, scope.account);
}
