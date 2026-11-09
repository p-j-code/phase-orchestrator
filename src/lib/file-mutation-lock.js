import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Small cross-process advisory lock for short atomic file mutations.
 *
 * The token check on release matters: if a crashed owner's stale file is
 * recovered, that old owner must never unlink the replacement owner's lock.
 */
export async function withFileMutationLock(lockPath, fn, {
  timeoutMs = 5_000,
  staleMs = 5 * 60_000,
  pollMs = 25,
} = {}) {
  if (typeof fn !== 'function') throw new TypeError('withFileMutationLock requires a callback');
  const resolved = path.resolve(lockPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const token = crypto.randomUUID();
  const descriptor = JSON.stringify({ token, pid: process.pid, host: os.hostname(), createdAt: new Date().toISOString() });
  const deadline = Date.now() + Math.max(1, timeoutMs);
  let handle = null;

  while (!handle) {
    try {
      handle = await fs.open(resolved, 'wx', 0o600);
      await handle.writeFile(descriptor, 'utf-8');
    } catch (err) {
      if (handle) {
        await handle.close().catch(() => {});
        await fs.unlink(resolved).catch(() => {});
        handle = null;
      }
      if (err.code !== 'EEXIST') throw err;
      try {
        const st = await fs.stat(resolved);
        if (Date.now() - st.mtimeMs > staleMs) {
          await fs.unlink(resolved);
          continue;
        }
      } catch (statErr) {
        if (statErr.code === 'ENOENT') continue;
        throw statErr;
      }
      if (Date.now() >= deadline) {
        const busy = new Error(`File mutation is busy: ${path.basename(resolved)}`);
        busy.code = 'FILE_MUTATION_BUSY';
        throw busy;
      }
      await sleep(pollMs);
    }
  }

  try {
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    try {
      const current = JSON.parse(await fs.readFile(resolved, 'utf-8'));
      if (current?.token === token) await fs.unlink(resolved);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // A malformed/replaced lock is not ours to remove.
      }
    }
  }
}
