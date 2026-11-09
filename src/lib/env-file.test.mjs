// env-file.test.mjs — loadDotEnv: the NAS .env loader.
//
// The stakes: setup-nas.sh stores CLAUDE_BIN and CLAUDE_CODE_OAUTH_TOKEN in
// REPO_ROOT/.env; orchestrator.js loads it at startup. A silent parse bug
// here means "Not logged in" on every spawned session on the NAS.
//
// Run: node src/lib/env-file.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { loadDotEnv } = await import('./env-file.js');

async function withEnvFile(t, content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'envfile-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const envPath = path.join(dir, '.env');
  await fs.writeFile(envPath, content, 'utf-8');
  return envPath;
}

test('loadDotEnv: parses KEY=VALUE, skips comments/blanks, strips quotes and export prefix', async (t) => {
  const envPath = await withEnvFile(t, [
    '# comment',
    '',
    'ENVFILE_TEST_PLAIN=hello',
    'ENVFILE_TEST_DQ="with spaces"',
    "ENVFILE_TEST_SQ='single'",
    'export ENVFILE_TEST_EXPORTED=yes',
    'ENVFILE_TEST_EQ=a=b=c',
    'not a valid line',
    '=novalue',
  ].join('\n'));
  t.after(() => {
    for (const k of ['ENVFILE_TEST_PLAIN', 'ENVFILE_TEST_DQ', 'ENVFILE_TEST_SQ', 'ENVFILE_TEST_EXPORTED', 'ENVFILE_TEST_EQ']) delete process.env[k];
  });
  const loaded = await loadDotEnv(envPath);
  assert.equal(process.env.ENVFILE_TEST_PLAIN, 'hello');
  assert.equal(process.env.ENVFILE_TEST_DQ, 'with spaces');
  assert.equal(process.env.ENVFILE_TEST_SQ, 'single');
  assert.equal(process.env.ENVFILE_TEST_EXPORTED, 'yes');
  assert.equal(process.env.ENVFILE_TEST_EQ, 'a=b=c', 'only the FIRST = splits key from value');
  assert.equal(Object.keys(loaded).length, 5);
});

test('loadDotEnv: never overrides a var already set in the real environment', async (t) => {
  const envPath = await withEnvFile(t, 'ENVFILE_TEST_PRESET=from-file\n');
  process.env.ENVFILE_TEST_PRESET = 'from-shell';
  t.after(() => { delete process.env.ENVFILE_TEST_PRESET; });
  const loaded = await loadDotEnv(envPath);
  assert.equal(process.env.ENVFILE_TEST_PRESET, 'from-shell', 'real env wins over .env');
  assert.equal(loaded.ENVFILE_TEST_PRESET, undefined);
});

test('loadDotEnv: missing file is a silent no-op', async () => {
  const loaded = await loadDotEnv(path.join(os.tmpdir(), 'definitely-missing', '.env'));
  assert.deepEqual(loaded, {});
});
