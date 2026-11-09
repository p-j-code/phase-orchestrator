import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { withFileMutationLock } from './file-mutation-lock.js';

export function projectJsonVersion(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export async function readProjectJsonSnapshot(projectPath) {
  const raw = await fs.readFile(projectPath);
  return {
    raw,
    value: JSON.parse(raw.toString('utf-8')),
    version: projectJsonVersion(raw),
  };
}

async function atomicReplace(projectPath, raw, suffix = 'tmp') {
  const temp = `${projectPath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.${suffix}`;
  try {
    await fs.writeFile(temp, raw);
    await fs.rename(temp, projectPath);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

/**
 * Authoritative read-modify-write path for projects/<name>/project.json.
 * Reads happen under the same cross-process lock as the atomic rename, so web,
 * chat and future writers preserve one another's unrelated fields.
 */
export async function updateProjectJson(projectPath, {
  expectedVersion = null,
  transform,
  commit = null,
} = {}) {
  if (typeof transform !== 'function') throw new TypeError('updateProjectJson requires transform');
  const resolved = path.resolve(projectPath);
  const lockPath = `${resolved}.mutation.lock`;

  return withFileMutationLock(lockPath, async () => {
    const before = await readProjectJsonSnapshot(resolved);
    if (expectedVersion != null && expectedVersion !== before.version) {
      const err = new Error('project.json changed after this editor loaded; reload before saving');
      err.code = 'CONFIG_VERSION_CONFLICT';
      err.expectedVersion = expectedVersion;
      err.currentVersion = before.version;
      throw err;
    }

    const transformed = await transform(before.value, before);
    const value = transformed === undefined ? before.value : transformed;
    const raw = Buffer.from(JSON.stringify(value, null, 2), 'utf-8');
    const version = projectJsonVersion(raw);
    await atomicReplace(resolved, raw);

    try {
      if (typeof commit === 'function') await commit({ value, raw, version, before });
    } catch (commitError) {
      try {
        await atomicReplace(resolved, before.raw, 'rollback');
      } catch (rollbackError) {
        commitError.message += `; project.json rollback failed: ${rollbackError.message}`;
      }
      throw commitError;
    }
    return { value, raw, version, before };
  });
}

