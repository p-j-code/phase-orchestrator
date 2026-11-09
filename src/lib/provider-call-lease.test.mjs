import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.DB_PATH = ':memory:';
process.env.ASHMERO_ROLE = 'mac';
process.env.ASHMERO_HOST_ID = 'mac';
process.env.ORCHESTRATOR_SKIP_TRUST = '1';

const {
  getDb,
  tryAcquireProviderCallLease,
  renewProviderCallLease,
  releaseProviderCallLease,
  listProviderCallLeases,
} = await import('../state.js');
const {
  admitHeavyClaudeCall,
  HeavyCallLeaseTimeoutError,
  isHeavyClaudeCall,
  resolveHeavyCallLeaseConfig,
} = await import('../claude-runner.js');

afterEach(() => {
  getDb().prepare('DELETE FROM provider_call_leases').run();
});

test('state lease is FIFO, owner-protected, renewable, and releases the next waiter', () => {
  const now = Date.UTC(2026, 6, 16, 12, 0);
  const common = {
    provider: 'anthropic', account: 'fifo', maxConcurrent: 1,
    ttlMs: 10_000, waitUntilMs: now + 60_000,
  };
  const first = tryAcquireProviderCallLease({ ...common, token: 'a', owner: 'owner-a', nowMs: now });
  assert.equal(first.acquired, true);
  const second = tryAcquireProviderCallLease({ ...common, token: 'b', owner: 'owner-b', nowMs: now + 1 });
  assert.equal(second.acquired, false);
  assert.equal(second.position, 1);
  assert.equal(releaseProviderCallLease({ token: 'a', owner: 'wrong-owner' }), false);
  assert.equal(renewProviderCallLease({ token: 'a', owner: 'owner-a', ttlMs: 20_000, nowMs: now + 2 }), true);
  assert.equal(releaseProviderCallLease({ token: 'a', owner: 'owner-a' }), true);
  const secondClaim = tryAcquireProviderCallLease({ ...common, token: 'b', owner: 'owner-b', nowMs: now + 3 });
  assert.equal(secondClaim.acquired, true);
  assert.equal(listProviderCallLeases('anthropic', 'fifo')[0].token, 'b');
});

test('expired active lease is reclaimed atomically and max_concurrent is configurable', () => {
  const now = Date.UTC(2026, 6, 16, 12, 0);
  const base = {
    provider: 'anthropic', account: 'stale', maxConcurrent: 2,
    ttlMs: 1_000, waitUntilMs: now + 60_000,
  };
  assert.equal(tryAcquireProviderCallLease({ ...base, token: 'a', owner: 'a', nowMs: now }).acquired, true);
  assert.equal(tryAcquireProviderCallLease({ ...base, token: 'b', owner: 'b', nowMs: now }).acquired, true);
  const queued = tryAcquireProviderCallLease({ ...base, token: 'c', owner: 'c', nowMs: now + 1 });
  assert.equal(queued.acquired, false);
  const reclaimed = tryAcquireProviderCallLease({ ...base, token: 'c', owner: 'c', nowMs: now + 1_001 });
  assert.equal(reclaimed.acquired, true);
  assert.equal(listProviderCallLeases('anthropic', 'stale').filter((row) => row.state === 'active').length, 1);
});

test('dead waiting ticket heartbeat expires without blocking the FIFO head', () => {
  const now = Date.UTC(2026, 6, 16, 12, 0);
  const base = {
    provider: 'anthropic', account: 'dead-waiter', maxConcurrent: 1,
    ttlMs: 10_000, waiterTtlMs: 500, waitUntilMs: now + 60_000,
  };
  assert.equal(tryAcquireProviderCallLease({ ...base, token: 'active', owner: 'active', nowMs: now }).acquired, true);
  assert.equal(tryAcquireProviderCallLease({ ...base, token: 'dead', owner: 'dead', nowMs: now + 1 }).position, 1);
  const live = tryAcquireProviderCallLease({ ...base, token: 'live', owner: 'live', nowMs: now + 700 });
  assert.equal(live.acquired, false);
  assert.equal(live.position, 1);
  assert.deepEqual(
    listProviderCallLeases('anthropic', 'dead-waiter').map((row) => row.token).sort(),
    ['active', 'live'],
  );
  assert.equal(releaseProviderCallLease({ token: 'active', owner: 'active' }), true);
  assert.equal(tryAcquireProviderCallLease({ ...base, token: 'live', owner: 'live', nowMs: now + 701 }).acquired, true);
});

test('a caller only reaps its OWN (provider, account) scope — a foreign scope with a longer waiter TTL is not starved', () => {
  const t0 = Date.UTC(2026, 6, 18, 0, 0);
  // Scope B: capacity 1, an active holder plus a healthy waiter 'b1' whose
  // scope runs a long waiter TTL (it is NOT stale by its own scope's measure).
  const bScope = { provider: 'anthropic', account: 'scopeB', maxConcurrent: 1, ttlMs: 10_000, waiterTtlMs: 100_000, waitUntilMs: t0 + 300_000 };
  assert.equal(tryAcquireProviderCallLease({ ...bScope, token: 'b0', owner: 'ob0', nowMs: t0 }).acquired, true);
  assert.equal(tryAcquireProviderCallLease({ ...bScope, token: 'b1', owner: 'ob1', nowMs: t0 }).acquired, false, 'b1 waits behind b0');

  // Scope A: a DIFFERENT scope with a SHORT waiter TTL, polling 60s later. Its
  // stale cut (60s − 30s) is older than b1.updated_at, but b1 belongs to scope
  // B — a global reaper would evict it (FIFO starvation); a scoped one must not.
  tryAcquireProviderCallLease({ provider: 'anthropic', account: 'scopeA', maxConcurrent: 1, ttlMs: 10_000, waiterTtlMs: 30_000, waitUntilMs: t0 + 300_000, token: 'a0', owner: 'oa0', nowMs: t0 + 60_000 });

  assert.ok(
    listProviderCallLeases('anthropic', 'scopeB').some((row) => row.token === 'b1'),
    'foreign scope B waiter must survive a shorter-TTL caller in scope A',
  );
});

test('classification defaults unknown tasks to heavy and supports explicit exemptions/overrides', () => {
  assert.equal(isHeavyClaudeCall({ cfg: {}, task: 'future-project-task' }), true);
  assert.equal(isHeavyClaudeCall({ cfg: {}, task: 'ledger-extract' }), false);
  assert.equal(isHeavyClaudeCall({
    cfg: { billing: { heavy_call_lease: { cheap_tasks: ['dev-execution'] } } }, task: 'dev-execution',
  }), false);
  assert.equal(isHeavyClaudeCall({
    cfg: { billing: { heavy_call_lease: { cheap_tasks: ['x'], heavy_tasks: ['x'] } } }, task: 'x',
  }), true);
  assert.equal(isHeavyClaudeCall({
    cfg: { billing: { heavy_call_lease: { enabled: false } } }, task: 'dev-execution',
  }), false);
  assert.equal(resolveHeavyCallLeaseConfig({}).maxConcurrent, 1);
  assert.equal(resolveHeavyCallLeaseConfig({}).waiterTtlMs, 60_000);
  assert.equal(resolveHeavyCallLeaseConfig({ billing: { heavy_call_lease: {
    poll_ms: 1_000, waiter_ttl_ms: 1_500,
  } } }).waiterTtlMs, 3_000, 'waiter TTL is never shorter than three polling intervals');
});

test('bounded admission polls without tokens, honors provider breaker, and cleans its waiter on timeout', async () => {
  let nowMs = 1_000;
  let attempts = 0;
  let releases = 0;
  const cfg = { billing: { mode: 'max_pooled', heavy_call_lease: {
    wait_timeout_ms: 1_000, poll_ms: 400, lease_ttl_ms: 2_000, heartbeat_ms: 500,
  } } };
  await assert.rejects(admitHeavyClaudeCall({ cfg, project: 'aoa', task: 'dev-execution' }, {
    now: () => nowMs,
    sleep: async (ms) => { nowMs += ms; },
    isCancelled: () => false,
    assertCircuit: () => {},
    tryAcquire: () => { attempts += 1; return { acquired: false, active: 1, position: 1 }; },
    release: () => { releases += 1; return true; },
    log: () => {},
  }), HeavyCallLeaseTimeoutError);
  assert.ok(attempts >= 2);
  assert.equal(releases, 1);

  let acquireCalled = false;
  await assert.rejects(admitHeavyClaudeCall({ cfg, project: 'acf', task: 'dev-execution' }, {
    now: () => 1_000,
    sleep: async () => {},
    isCancelled: () => false,
    assertCircuit: () => { throw new Error('provider circuit breaker open'); },
    tryAcquire: () => { acquireCalled = true; },
    release: () => true,
    log: () => {},
  }), /provider circuit breaker open/);
  assert.equal(acquireCalled, false);
});

function runChild(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}: ${stderr}`)));
  });
}

test('two independent orchestrator processes serialize heavy Claude calls through one SQLite account lease', { timeout: 20_000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-call-lease-xproc-'));
  const dbPath = path.join(dir, 'state.db');
  const eventsPath = path.join(dir, 'events.jsonl');
  const fakeClaude = path.join(dir, 'fake-claude.mjs');
  const worker = path.join(dir, 'worker.mjs');
  const runnerUrl = pathToFileURL(path.resolve('src/claude-runner.js')).href;

  await fs.writeFile(fakeClaude, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    `const events = ${JSON.stringify(eventsPath)};`,
    "fs.appendFileSync(events, JSON.stringify({kind:'start', pid:process.pid, at:Date.now()}) + '\\n');",
    "setTimeout(() => {",
    "  fs.appendFileSync(events, JSON.stringify({kind:'end', pid:process.pid, at:Date.now()}) + '\\n');",
    "  console.log(JSON.stringify({type:'result', subtype:'success', is_error:false, result:'ok', session_id:'s-' + process.pid, total_cost_usd:0, usage:{input_tokens:1,output_tokens:1}}));",
    "}, 300);",
  ].join('\n'));
  await fs.chmod(fakeClaude, 0o755);

  await fs.writeFile(worker, [
    `import { runClaude } from ${JSON.stringify(runnerUrl)};`,
    `const cfg = {`,
    `  _resolved:{claude_bin:${JSON.stringify(fakeClaude)}}, model:'claude-sonnet-5',`,
    `  billing:{mode:'max_pooled',warn_at_calls:1000,pause_at_calls:1000,warn_at_cost_usd:1000,pause_at_cost_usd:1000,allow_api_fallback:false,`,
    `    provider_circuit_breaker:{enabled:true,provider:'anthropic',account:'xproc'},`,
    `    heavy_call_lease:{enabled:true,max_concurrent:1,lease_ttl_ms:2000,heartbeat_ms:250,poll_ms:20,wait_timeout_ms:5000}},`,
    `  tools:{allowed_default:[],permission_mode:null}, phases:{subprocess_timeout_ms:5000,idle_timeout_ms:null,tool_hang_timeout_ms:null,turn_stall_timeout_ms:null}`,
    `};`,
    `await runClaude({cfg,cwd:${JSON.stringify(dir)},prompt:'test',task:'dev-execution'});`,
  ].join('\n'));

  try {
    await Promise.all([
      runChild(worker, { DB_PATH: dbPath, ORCHESTRATOR_SKIP_TRUST: '1', ORCHESTRATOR_NO_SPINNER: '1' }),
      runChild(worker, { DB_PATH: dbPath, ORCHESTRATOR_SKIP_TRUST: '1', ORCHESTRATOR_NO_SPINNER: '1' }),
    ]);
    const events = (await fs.readFile(eventsPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(events.length, 4);
    const starts = events.filter((event) => event.kind === 'start').sort((a, b) => a.at - b.at);
    const ends = events.filter((event) => event.kind === 'end').sort((a, b) => a.at - b.at);
    assert.equal(starts.length, 2);
    assert.ok(starts[1].at >= ends[0].at, `calls overlapped: ${JSON.stringify(events)}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('structured provider rejection opens the breaker before the heavy slot admits a queued process', { timeout: 20_000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-call-lease-breaker-'));
  const dbPath = path.join(dir, 'state.db');
  const eventsPath = path.join(dir, 'events.jsonl');
  const fakeClaude = path.join(dir, 'fake-limit.mjs');
  const worker = path.join(dir, 'worker.mjs');
  const runnerUrl = pathToFileURL(path.resolve('src/claude-runner.js')).href;

  await fs.writeFile(fakeClaude, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    `fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({kind:'spawn',pid:process.pid,at:Date.now()}) + '\\n');`,
    "setTimeout(() => console.log(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,result:'usage limit reached',session_id:'limited',total_cost_usd:0,usage:{input_tokens:1,output_tokens:1}})), 150);",
  ].join('\n'));
  await fs.chmod(fakeClaude, 0o755);

  await fs.writeFile(worker, [
    `import { runClaude } from ${JSON.stringify(runnerUrl)};`,
    `const cfg = {`,
    `  _resolved:{claude_bin:${JSON.stringify(fakeClaude)}}, model:'claude-sonnet-5',`,
    `  billing:{mode:'max_pooled',warn_at_calls:1000,pause_at_calls:1000,warn_at_cost_usd:1000,pause_at_cost_usd:1000,allow_api_fallback:false,`,
    `    provider_circuit_breaker:{enabled:true,provider:'anthropic',account:'breaker-before-release',fallback_cooldown_minutes:30,safety_buffer_seconds:0},`,
    `    heavy_call_lease:{enabled:true,max_concurrent:1,lease_ttl_ms:2000,heartbeat_ms:250,poll_ms:20,wait_timeout_ms:5000}},`,
    `  tools:{allowed_default:[],permission_mode:null}, phases:{subprocess_timeout_ms:5000,idle_timeout_ms:null,tool_hang_timeout_ms:null,turn_stall_timeout_ms:null}`,
    `};`,
    `try { await runClaude({cfg,cwd:${JSON.stringify(dir)},prompt:'test',task:'dev-execution'}); }`,
    `catch (err) { if (err?.code !== 'PROVIDER_CIRCUIT_OPEN') throw err; }`,
  ].join('\n'));

  try {
    await Promise.all([
      runChild(worker, { DB_PATH: dbPath, ORCHESTRATOR_SKIP_TRUST: '1', ORCHESTRATOR_NO_SPINNER: '1' }),
      runChild(worker, { DB_PATH: dbPath, ORCHESTRATOR_SKIP_TRUST: '1', ORCHESTRATOR_NO_SPINNER: '1' }),
    ]);
    const events = (await fs.readFile(eventsPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(events.length, 1, `queued sibling spawned after provider rejection: ${JSON.stringify(events)}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
