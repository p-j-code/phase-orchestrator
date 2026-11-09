import { test } from 'node:test';
import assert from 'node:assert/strict';

const { isProviderRateLimitError, isTransientError, extractProviderResetAt } = await import('./transient-errors.js');

// Regression for P2-4: a lost heavy-call lease must classify as TRANSIENT (so
// the job retries for a fresh lease) but NOT as a provider rate limit (which
// would make it wait for a provider reset instead of retrying promptly).
test('lost heavy-call lease is transient but not a provider rate limit', () => {
  const msg = 'provider heavy-call lease lost — slot reclaimed mid-call (signal: SIGTERM); retrying for a fresh lease';
  assert.equal(isTransientError(msg), true);
  assert.equal(isProviderRateLimitError(msg), false);
});

test('isProviderRateLimitError recognizes provider quota events but not ordinary network failures', () => {
  assert.equal(isProviderRateLimitError('rate_limit_event: resetsAt 1780000000'), true);
  assert.equal(isProviderRateLimitError('HTTP 429 too many requests'), true);
  assert.equal(isProviderRateLimitError('five_hour usage window reached'), true);
  assert.equal(isProviderRateLimitError("You've hit your session limit · resets 12:40am (Asia/Calcutta)"), true);
  assert.equal(isProviderRateLimitError('usage limit reached · resets 1pm'), true);
  assert.equal(isProviderRateLimitError("You've hit your limit · resets 1pm"), true);
  assert.equal(isProviderRateLimitError("You've reached your weekly limit"), true);
  assert.equal(isProviderRateLimitError('Provider circuit breaker open for anthropic/max_pooled'), true);
  assert.equal(isProviderRateLimitError('Paused: billing window exhausted'), false);
  assert.equal(isProviderRateLimitError('HTTP 529 overloaded'), false);
  assert.equal(isProviderRateLimitError('ETIMEDOUT while connecting to provider'), false);
});

test('extractProviderResetAt parses Unix and Asia/Calcutta human reset times', () => {
  const nowMs = Date.UTC(2026, 6, 16, 12, 0); // 17:30 India
  assert.equal(
    extractProviderResetAt('{"resetsAt": 1784217600}', { nowMs }),
    1784217600 * 1000,
  );
  assert.equal(
    extractProviderResetAt('usage limit · resets 6:30pm (Asia/Calcutta)', { nowMs }),
    Date.UTC(2026, 6, 16, 13, 0),
  );
  assert.equal(extractProviderResetAt('usage limit with no timestamp', { nowMs }), null);
});
