import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  evaluateExecutionHostPolicy,
  assertExecutionHost,
  assertObserverForStatePull,
} from './execution-host-policy.js';

test('single-writer policy permits only the configured deployment role and host id', () => {
  const policy = { active_role: 'nas', active_host_id: 'headless-1', allow_multi_host: false };
  assert.equal(evaluateExecutionHostPolicy({ policy, role: 'nas', hostId: 'headless-1' }).allowed, true);
  const mac = evaluateExecutionHostPolicy({ policy, role: 'mac', hostId: 'prem-mac' });
  assert.equal(mac.allowed, false);
  assert.match(mac.reason, /execution authority is "nas"/);
  const impersonatedRole = evaluateExecutionHostPolicy({ policy, role: 'nas', hostId: 'prem-mac' });
  assert.equal(impersonatedRole.allowed, false);
  assert.match(impersonatedRole.reason, /host id.*execution authority is "headless-1"/);
});

test('multi-host execution requires an explicit policy or environment opt-in', () => {
  const policy = { active_role: 'nas', active_host_id: 'headless-1', allow_multi_host: false };
  const result = evaluateExecutionHostPolicy({ policy, role: 'mac', allowMultiHost: true });
  assert.equal(result.allowed, true);
  assert.equal(result.override, true);
});

test('startup guard fails closed on inactive role and loudly marks unsafe override', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashmero-host-policy-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const policyPath = path.join(dir, 'policy.json');
  await fs.writeFile(policyPath, JSON.stringify({ active_role: 'nas', active_host_id: 'headless-1', allow_multi_host: false }));

  await assert.rejects(
    assertExecutionHost({ policyPath, env: { ASHMERO_ROLE: 'mac' }, entrypoint: 'test worker' }),
    (err) => err.code === 'INACTIVE_EXECUTION_HOST' && /Refusing test worker/.test(err.message),
  );

  const warnings = [];
  const result = await assertExecutionHost({
    policyPath,
    env: { ASHMERO_ROLE: 'mac', ASHMERO_ALLOW_MULTI_HOST_EXECUTION: 'true' },
    entrypoint: 'test worker',
    warn: (message) => warnings.push(message),
  });
  assert.equal(result.override, true);
  assert.match(warnings[0], /separate SQLite admission state/);
});

test('state pull is observer-only, including when multi-host override is set', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashmero-host-pull-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const policyPath = path.join(dir, 'policy.json');
  await fs.writeFile(policyPath, JSON.stringify({ active_role: 'nas', active_host_id: 'headless-1', allow_multi_host: false }));

  const observer = await assertObserverForStatePull({ policyPath, env: { ASHMERO_ROLE: 'mac' } });
  assert.equal(observer.currentRole, 'mac');

  await assert.rejects(
    assertObserverForStatePull({ policyPath, env: { ASHMERO_ROLE: 'nas', ASHMERO_HOST_ID: 'headless-1' } }),
    (err) => err.code === 'NAS_PULL_ACTIVE_EXECUTION_HOST',
  );
  await assert.rejects(
    assertObserverForStatePull({
      policyPath,
      env: { ASHMERO_ROLE: 'mac', ASHMERO_ALLOW_MULTI_HOST_EXECUTION: '1' },
    }),
    (err) => err.code === 'NAS_PULL_ACTIVE_EXECUTION_HOST',
  );
  await fs.writeFile(policyPath, JSON.stringify({ active_role: 'nas' }));
  await assert.rejects(
    assertObserverForStatePull({ policyPath, env: { ASHMERO_ROLE: 'mac' } }),
    (err) => err.code === 'EXECUTION_HOST_POLICY_INVALID',
  );
});
