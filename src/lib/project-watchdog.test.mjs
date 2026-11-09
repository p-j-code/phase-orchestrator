import { test } from 'node:test';
import assert from 'node:assert/strict';

const { rateLimitResumeAt, classifyWatchdogResume } = await import('./project-watchdog.js');

test('classifyWatchdogResume: a network blip resumes fast (network=true), a provider quota waits (providerLimit=true), and both are distinct', () => {
  // Pure network transient — NOT a provider quota: short cooldown path.
  const net = classifyWatchdogResume({ recoverable: false, kind: 'network', pauseReason: 'ECONNRESET while connecting' });
  assert.deepEqual(net, { skip: false, providerLimit: false, network: true });

  // Genuine provider quota: rate-limit reset path, never the network path.
  const quota = classifyWatchdogResume({ recoverable: false, kind: 'budget', pauseReason: "You've hit your session limit · resets 1pm" });
  assert.deepEqual(quota, { skip: false, providerLimit: true, network: false });

  // A non-recoverable, non-transient failure is skipped (nothing safe to resume).
  const skipped = classifyWatchdogResume({ recoverable: false, kind: 'capability', pauseReason: 'assertion failed: expected 2' });
  assert.equal(skipped.skip, true);

  // A recoverable kind in the resume set falls through to resume (not skipped).
  const gitDirty = classifyWatchdogResume({ recoverable: true, kind: 'git-dirty', pauseReason: 'workspace dirty' });
  assert.deepEqual(gitDirty, { skip: false, providerLimit: false, network: false });
});

test('rateLimitResumeAt honors the provider reset timestamp', () => {
  const retryAt = rateLimitResumeAt({
    ended_at: '2026-07-14T00:00:00.000Z',
    pause_reason: 'rate_limit_event: {"resetsAt": 1784000000}',
  }, 60);
  assert.equal(retryAt, 1784000000 * 1000);
});

test('rateLimitResumeAt derives a durable fallback from the pause time', () => {
  const pausedAt = '2026-07-14T00:00:00.000Z';
  const retryAt = rateLimitResumeAt({
    ended_at: pausedAt,
    pause_reason: 'rate_limit_event: reset pending',
  }, 60);
  assert.equal(retryAt, Date.parse(pausedAt) + (60 * 60 * 1000));
});
