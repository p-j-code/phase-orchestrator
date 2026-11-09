import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { assertPackageTreeSafe } from './package-project.js';

test('package preflight accepts an ordinary project tree', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aorch-package-safe-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'workspace', 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'workspace', 'src', 'index.js'), 'export default 1;\n');

  const result = await assertPackageTreeSafe(root);
  assert.equal(result.safe, true);
});

test('package preflight rejects a symlink whose target is outside the project', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'aorch-package-link-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'project');
  await fs.mkdir(path.join(root, 'workspace'), { recursive: true });
  const secret = path.join(parent, 'outside-secret.txt');
  await fs.writeFile(secret, 'must not enter an archive\n');
  await fs.symlink(secret, path.join(root, 'workspace', 'leak.txt'));

  await assert.rejects(
    () => assertPackageTreeSafe(root),
    (err) => err?.code === 'PACKAGE_UNSAFE_SYMLINK' && err?.path === 'workspace/leak.txt',
  );
});

test('excluded dependency trees are not traversed', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'aorch-package-excluded-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'project');
  await fs.mkdir(path.join(root, 'workspace', 'node_modules'), { recursive: true });
  await fs.symlink(path.join(parent, 'outside'), path.join(root, 'workspace', 'node_modules', 'ignored-link'));

  const result = await assertPackageTreeSafe(root);
  assert.equal(result.safe, true);
});
