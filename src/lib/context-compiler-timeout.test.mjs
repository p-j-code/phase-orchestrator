import test from 'node:test';
import assert from 'node:assert/strict';

import { compileContextWithinTimeout } from './phase-runner.js';
import { contextCompilerConfigFingerprint } from './context-compiler.js';

const args = {
  projectName: 'demo',
  task: { task_kind: 'phase', phase: 2 },
  cfg: { context_compiler: { mode: 'shadow', provider: 'hybrid-lexical', timeout_ms: { warm: 5, cold: 5 } } },
};

test('compileContextWithinTimeout records exactly one successful attempt', async () => {
  const events = [];
  const manifest = await compileContextWithinTimeout(args, async () => ({ manifest_id: 'a'.repeat(64), provider: 'hybrid-lexical' }), (event) => events.push(event));
  assert.equal(manifest.manifest_id, 'a'.repeat(64));
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'compiled');
  assert.equal(events[0].manifest_id, manifest.manifest_id);
});

test('compileContextWithinTimeout records null and thrown compilers as failed', async () => {
  const events = [];
  assert.equal(await compileContextWithinTimeout(args, async () => null, (event) => events.push(event)), null);
  assert.equal(await compileContextWithinTimeout(args, async () => { throw new Error('boom'); }, (event) => events.push(event)), null);
  assert.deepEqual(events.map((event) => event.status), ['failed', 'failed']);
  assert.match(events[1].error_message, /boom/);
});

test('compileContextWithinTimeout records timeout once and fails open', async () => {
  const events = [];
  const manifest = await compileContextWithinTimeout(
    args,
    () => new Promise((resolve) => setTimeout(() => resolve({ manifest_id: 'late' }), 30)),
    (event) => events.push(event),
  );
  assert.equal(manifest, null);
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'timeout');
});

test('compileContextWithinTimeout aborts timed-out compiler work and fingerprints the exact config', async () => {
  const events = [];
  let observedSignal = null;
  let observedThrowOnError = null;
  const manifest = await compileContextWithinTimeout(
    args,
    ({ signal, throwOnError }) => new Promise((resolve) => {
      observedSignal = signal;
      observedThrowOnError = throwOnError;
      signal.addEventListener('abort', () => resolve(null), { once: true });
    }),
    (event) => events.push(event),
  );

  assert.equal(manifest, null);
  assert.equal(observedThrowOnError, true, 'the wrapper requests actionable compiler failures');
  assert.equal(observedSignal?.aborted, true, 'timeout cancellation reaches provider/file-scan work');
  assert.match(String(observedSignal?.reason?.message), /exceeded 5ms/);
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'timeout');
  assert.equal(events[0].compiler_fingerprint,
    contextCompilerConfigFingerprint(args.cfg.context_compiler));
});
