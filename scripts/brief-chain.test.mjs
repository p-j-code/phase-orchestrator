import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { acquirePidLock, releasePidLock } = await import('./brief-chain.mjs');

test('brief-chain lock rejects a live owner and reclaims a stale PID', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brief-chain-lock-'));
  const pidPath = path.join(dir, 'brief-chain-demo.pid');
  try {
    await acquirePidLock(pidPath, process.pid);
    await assert.rejects(
      () => acquirePidLock(pidPath, process.pid),
      /already running/,
    );
    releasePidLock(pidPath, process.pid);

    await fs.writeFile(pidPath, '999999999', 'utf-8');
    await acquirePidLock(pidPath, process.pid);
    assert.equal((await fs.readFile(pidPath, 'utf-8')).trim(), String(process.pid));

    releasePidLock(pidPath, process.pid);
    await assert.rejects(() => fs.access(pidPath));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
