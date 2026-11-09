import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

process.env.DB_PATH = ':memory:';

const { execForHttpRequest, parseBoundedQueryInt } = await import('./web-ui.js');

function events() {
  return { req: new EventEmitter(), res: new EventEmitter() };
}

function longRunningCommand() {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify('setInterval(() => {}, 1000)')}`;
}

test('parseBoundedQueryInt rejects partial, negative, zero, and over-cap limits', () => {
  assert.deepEqual(parseBoundedQueryInt(undefined, { fallback: 50, min: 1, max: 200, label: '?limit' }), { ok: true, value: 50 });
  for (const raw of ['1x', '-1', '0', '201', '1.5']) {
    assert.equal(parseBoundedQueryInt(raw, { fallback: 50, min: 1, max: 200, label: '?limit' }).ok, false, raw);
  }
  assert.deepEqual(parseBoundedQueryInt('200', { fallback: 50, min: 1, max: 200, label: '?limit' }), { ok: true, value: 200 });
});

test('terminal execution timeout rejects and terminates the detached process group', async () => {
  const { req, res } = events();
  const started = Date.now();
  await assert.rejects(
    execForHttpRequest(longRunningCommand(), { timeout: 50, maxBuffer: 1024 }, req, res),
    (err) => err?.code === 'ETIMEDOUT',
  );
  assert.ok(Date.now() - started < 2_000, 'timeout should not wait for the command itself');
});

test('terminal execution is cancelled when the HTTP response disconnects', async () => {
  const { req, res } = events();
  const pending = execForHttpRequest(longRunningCommand(), { timeout: 5_000, maxBuffer: 1024 }, req, res);
  setTimeout(() => res.emit('close'), 30);
  await assert.rejects(pending, (err) => err?.code === 'REQUEST_ABORTED');
});
