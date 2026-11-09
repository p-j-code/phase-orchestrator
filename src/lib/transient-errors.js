// Transient external-failure classification (v0.14.44).
//
// "Transient" = the code is fine; the WORLD was broken — API rate limits,
// overload shedding, server errors, network drops, billing windows. These
// must not strand a job or pause a night: the job layer reschedules the same
// job after a cooldown, recursively, until the world recovers.
//
// Deliberately NOT transient: authentication/key errors (need a human),
// validator-gate failures, no-commit, plan/coverage validation, runner
// timeouts and stalls (those have their own reprompt/escalation flows and
// usually indicate phase size, not weather).

const TRANSIENT_RE = new RegExp([
  'rate.?limit',
  'session.?limit',
  'usage.?limit',
  'you.?ve.{0,12}(hit|reached).{0,20}limit',
  'max.?plan.{0,20}limit',
  'weekly.{0,24}(usage|rate|token|message)?.{0,12}limit',
  '(usage|rate|token|message).{0,24}weekly.{0,12}limit',
  'provider circuit (breaker )?open',
  'heavy-call lease lost',
  'overloaded',
  '\\b429\\b',
  '\\b529\\b',
  // 5xx needs adjacent HTTP/status context: a bare \b5\d\d\b matches "line 543"
  // or "phase 512" in a pause reason and loops wait-and-resume on a hard failure.
  '(?:http|status|code|error)[ :]{0,3}5\\d\\d\\b',
  'internal.?server.?error',
  'server.?error',
  'service.?unavailable',
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
  'socket hang ?up',
  'fetch failed',
  'network error',
  'connection (error|closed|refused|reset)',
  'temporarily unavailable',
  'quota.{0,20}exceeded',
  'credit balance',
  'billing window',
].join('|'), 'i');

const NON_TRANSIENT_RE = new RegExp([
  'authentication', 'invalid.?api.?key', 'unauthorized', '\\b401\\b', '\\b403\\b',
  'validator', 'no git commit', 'structural validation', 'coverage',
].join('|'), 'i');

// A provider quota/rate-limit is distinct from a generic network failure: a
// second LLM call cannot repair it and merely consumes more queue capacity.
const PROVIDER_RATE_LIMIT_RE = new RegExp([
  'rate.?limit', 'rate_limit_event', 'too many requests', '\\b429\\b',
  'session.?limit', 'usage.?limit',
  'you.?ve.{0,12}(hit|reached).{0,20}limit', 'max.?plan.{0,20}limit',
  'weekly.{0,24}(usage|rate|token|message)?.{0,12}limit',
  '(usage|rate|token|message).{0,24}weekly.{0,12}limit',
  'quota.{0,20}exceeded', 'credit balance', 'five[_ -]?hour',
  'provider circuit (breaker )?open',
].join('|'), 'i');

export function isTransientError(text) {
  if (!text) return false;
  const t = String(text);
  if (NON_TRANSIENT_RE.test(t)) return false;
  return TRANSIENT_RE.test(t);
}

export function isProviderRateLimitError(text) {
  return text ? PROVIDER_RATE_LIMIT_RE.test(String(text)) : false;
}

/**
 * Extract the provider's advertised reset time as epoch milliseconds.
 * Claude currently emits either a JSON `resetsAt` Unix timestamp or prose such
 * as "resets 6:30pm (Asia/Calcutta)". Unknown formats deliberately return null
 * so the circuit breaker can apply its configured conservative cooldown.
 */
export function extractProviderResetAt(text, { nowMs = Date.now() } = {}) {
  if (!text) return null;
  const value = String(text);

  const jsonMatch = value.match(/["']?resetsAt["']?\s*[:=]\s*["']?(\d{10,13})/i);
  if (jsonMatch) {
    const raw = Number(jsonMatch[1]);
    const millis = raw < 10_000_000_000 ? raw * 1000 : raw;
    if (Number.isFinite(millis) && millis > nowMs) return millis;
  }

  const human = value.match(/\bresets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!human) return null;
  let hour = Number(human[1]) % 12;
  if (human[3].toLowerCase() === 'pm') hour += 12;
  const minute = Number(human[2] || 0);

  // Claude's Max-plan message currently names Asia/Calcutta. It is a fixed
  // UTC+05:30 zone, so this remains deterministic on NAS hosts in any TZ.
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Calcutta', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(nowMs))
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number(part.value)]));
  let candidate = Date.UTC(parts.year, parts.month - 1, parts.day, hour - 5, minute - 30);
  if (candidate <= nowMs) candidate += 24 * 60 * 60 * 1000;
  return candidate;
}
