import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('state replacement suspension closes the handle and prevents a lazy reopen race', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashmero-state-suspend-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  process.env.DB_PATH = path.join(dir, 'state.db');
  const { getDb, closeDb, suspendDbAccess, resumeDbAccess } = await import('./state.js');
  t.after(() => {
    resumeDbAccess();
    closeDb();
    delete process.env.DB_PATH;
  });

  assert.ok(getDb().prepare('SELECT 1 AS n').get().n);
  suspendDbAccess('test replacement');
  assert.throws(
    () => getDb(),
    (err) => err.code === 'STATE_DB_SUSPENDED' && /test replacement/.test(err.message),
  );
  resumeDbAccess();
  assert.equal(getDb().prepare('SELECT 1 AS n').get().n, 1);
});
