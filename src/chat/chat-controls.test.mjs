import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = ':memory:';
process.env.ASHMERO_ROLE = 'mac';
process.env.ASHMERO_HOST_ID = 'mac';
process.env.ORCHESTRATOR_SKIP_TRUST = '1';

const state = await import('../state.js');
const runner = await import('../claude-runner.js');
const engine = await import('./chat-engine.js');
const { deleteChatUpload } = await import('./control-actions.js');

const {
  createChatThread, getChatThread, setChatThreadProject,
  acquireChatLock, releaseChatLock,
} = state;
const { __testHooks: runnerHooks } = runner;
const { cancelChatTurn, sendChatMessage, __chatTestHooks } = engine;

afterEach(() => {
  __chatTestHooks.resetTurns();
  runnerHooks.reset();
});

test('cancelChatTurn targets the exact active chat runner key', () => {
  const threadId = Number(createChatThread({ title: 'cancel me' }));
  const jobKey = `chat:${threadId}:unit`;
  const kills = [];
  runnerHooks.setGroupKill((pid, signal) => kills.push({ pid, signal }));
  runnerHooks.track(jobKey, { pid: 2147480000 }, { task: 'chat' });
  __chatTestHooks.trackTurn(threadId, jobKey);

  const result = cancelChatTurn(threadId);

  assert.deepEqual(result, {
    cancelled: true,
    threadId,
    killed: true,
    reason: 'stop_requested',
  });
  assert.deepEqual(kills[0], { pid: 2147480000, signal: 'SIGTERM' });
});

test('cancelChatTurn is idempotent and distinguishes a foreign-process lock', () => {
  const idleId = Number(createChatThread({ title: 'idle' }));
  assert.deepEqual(cancelChatTurn(idleId), {
    cancelled: false,
    threadId: idleId,
    reason: 'not_busy',
  });

  const lockedId = Number(createChatThread({ title: 'locked elsewhere' }));
  assert.equal(acquireChatLock(lockedId), true);
  try {
    assert.deepEqual(cancelChatTurn(lockedId), {
      cancelled: false,
      threadId: lockedId,
      reason: 'owned_by_another_process',
    });
  } finally {
    releaseChatLock(lockedId);
  }
});

test('cancelChatTurn rejects invalid or missing thread ids', () => {
  assert.throws(() => cancelChatTurn('nope'), /Chat thread not found/);
  assert.throws(() => cancelChatTurn(999999), /Chat thread not found/);
});

test('an explicit null project clears focus while an omitted project preserves it', async () => {
  const threadId = Number(createChatThread({ title: 'focus', project: '__self__' }));

  // Hold the lock so sendChatMessage stops after applying focus semantics and
  // before it can resolve config or start a provider turn.
  assert.equal(acquireChatLock(threadId), true);
  try {
    await assert.rejects(
      sendChatMessage({ threadId, message: 'clear focus', project: null }),
      /already processing/,
    );
    assert.equal(getChatThread(threadId).project, null);

    setChatThreadProject(threadId, '__self__');
    await assert.rejects(
      sendChatMessage({ threadId, message: 'preserve focus' }),
      /already processing/,
    );
    assert.equal(getChatThread(threadId).project, '__self__');
  } finally {
    releaseChatLock(threadId);
  }
});

test('deleteChatUpload basename-jails names and deletes idempotently', async () => {
  const uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aorch-chat-upload-'));
  const name = '123-example.txt';
  try {
    await fs.writeFile(path.join(uploadsDir, name), 'hello');
    assert.deepEqual(await deleteChatUpload(name, { uploadsDir }), { deleted: true, name });
    assert.deepEqual(await deleteChatUpload(name, { uploadsDir }), { deleted: false, name });
    await assert.rejects(
      deleteChatUpload('../outside.txt', { uploadsDir }),
      /Invalid upload name/,
    );
  } finally {
    await fs.rm(uploadsDir, { recursive: true, force: true });
  }
});
