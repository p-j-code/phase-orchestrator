import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = ':memory:';
process.env.ORCHESTRATOR_SKIP_TRUST = '1';
process.env.ASHMERO_ROLE = 'mac';
process.env.ASHMERO_HOST_ID = 'mac';

const {
  assertProviderCircuitClosed,
  providerCircuitStatus,
  resetProviderCircuit,
  tripProviderCircuitFromError,
  tripProviderCircuitFromStreamEvent,
  ProviderCircuitOpenError,
} = await import('./provider-circuit-breaker.js');
const { runClaude } = await import('../claude-runner.js');
const { classifyError, ERROR_KINDS } = await import('./error-classifier.js');
const { shouldAutoFixIssue } = await import('../chat/issue-bridge.js');
const { AutoHealer } = await import('./auto-healer.js');

const cfg = {
  _resolved: { claude_bin: process.execPath },
  model: 'claude-sonnet-5',
  billing: {
    mode: 'max_pooled', window_reset_hours: 5,
    warn_at_calls: 1000, pause_at_calls: 1000,
    warn_at_cost_usd: 1000, pause_at_cost_usd: 1000,
    allow_api_fallback: false,
    provider_circuit_breaker: {
      enabled: true, provider: 'anthropic', account: 'test-account',
      fallback_cooldown_minutes: 30, safety_buffer_seconds: 0,
    },
  },
  tools: { allowed_default: [], permission_mode: null },
  phases: {
    subprocess_timeout_ms: 5000, idle_timeout_ms: null,
    tool_hang_timeout_ms: null, turn_stall_timeout_ms: null,
  },
};

afterEach(() => resetProviderCircuit(cfg));

test('provider limit classification wins over a synthetic orchestrator stack', () => {
  const err = new Error("You've hit your session limit · resets 6pm (Asia/Calcutta)");
  err.stack += '\n    at runClaude (/tmp/orchestrator/src/claude-runner.js:900:1)';
  const classified = classifyError(err);
  assert.equal(classified.kind, ERROR_KINDS.PROVIDER_LIMIT);
  assert.equal(classified.recoverable, false);
});

test('network exhaustion is not retried again by AutoHealer', async () => {
  const classified = classifyError(new Error('ECONNRESET socket closed'));
  assert.equal(classified.kind, ERROR_KINDS.NETWORK);
  assert.equal(classified.recoverable, false);
  assert.equal(classified.maxAttempts, 0);

  const healer = new AutoHealer({ projectName: 'aoa', cfg: { auto_heal: { enabled: true } } });
  healer._openIssue = async () => {};
  healer._dispatch = async () => { throw new Error('network must go to durable scheduler'); };
  const result = await healer.heal(new Error('ECONNRESET socket closed'));
  assert.equal(result.healed, false);
  assert.match(result.reason, /not auto-recoverable/);
});

test('shared breaker opens, never shortens, and expires without deleting history', () => {
  const nowMs = Date.UTC(2026, 6, 16, 12, 0);
  const first = tripProviderCircuitFromError(cfg, 'usage limit reached', { project: 'aoa', task: 'dev-execution', nowMs });
  assert.equal(first.open, true);
  assert.equal(first.blocked_until_ms, nowMs + 30 * 60 * 1000);

  const shorter = tripProviderCircuitFromError(cfg, 'usage limit reached', {
    project: 'acf', task: 'acceptance-check', nowMs: nowMs + 20 * 60 * 1000,
  });
  assert.equal(shorter.blocked_until_ms, nowMs + 50 * 60 * 1000, 'later observation extends the conservative fallback');
  assert.throws(() => assertProviderCircuitClosed(cfg, { nowMs }), ProviderCircuitOpenError);

  const expired = providerCircuitStatus(cfg, { nowMs: shorter.blocked_until_ms + 1 });
  assert.equal(expired.open, false);
  assert.ok(expired.row, 'expired history remains queryable');
});

test('five-hour allowed_warning proactively opens until advertised reset', () => {
  const nowMs = Date.UTC(2026, 6, 16, 12, 0);
  const resetMs = nowMs + 42 * 60_000;
  const row = tripProviderCircuitFromStreamEvent(cfg, {
    type: 'rate_limit_event',
    rate_limit_info: {
      rateLimitType: 'five_hour', status: 'allowed_warning', utilization: 0.98,
      resetsAt: Math.floor(resetMs / 1000),
    },
  }, { project: 'aoa', task: 'dev-execution', nowMs });
  assert.equal(row.open, true);
  assert.equal(row.blocked_until_ms, resetMs);
  assert.match(row.reason, /five_hour provider warning/);

  assert.equal(tripProviderCircuitFromStreamEvent(cfg, {
    type: 'rate_limit_event',
    rate_limit_info: { rateLimitType: 'seven_day', status: 'allowed_warning', utilization: 0.99 },
  }, { nowMs }), null, 'weekly warning does not replace the immediate five-hour gate');
});

test('runClaude trips on first structured provider rejection and blocks the next spawn', { timeout: 15000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-breaker-runner-'));
  const counter = path.join(dir, 'counter.txt');
  const fakeClaude = path.join(dir, 'fake-claude.mjs');
  await fs.writeFile(counter, '0');
  await fs.writeFile(fakeClaude, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    `const p = ${JSON.stringify(counter)};`,
    "const n = Number(fs.readFileSync(p, 'utf8')); fs.writeFileSync(p, String(n + 1));",
    "console.log(JSON.stringify({ type:'result', subtype:'error_during_execution', is_error:true, result:'usage limit reached · resets 11:59pm (Asia/Calcutta)', session_id:'provider-session', total_cost_usd:0, usage:{input_tokens:1,output_tokens:1} }));",
    'process.exitCode = 1;',
  ].join('\n'));
  await fs.chmod(fakeClaude, 0o755);

  const runCfg = { ...cfg, _resolved: { claude_bin: fakeClaude } };
  try {
    const first = await runClaude({ cfg: runCfg, cwd: dir, prompt: 'test', task: 'dev-execution' });
    assert.equal(first.is_error, true);
    assert.equal(first.session_id, 'provider-session');
    await assert.rejects(
      runClaude({ cfg: runCfg, cwd: dir, prompt: 'must not spawn', task: 'acceptance-check' }),
      (err) => err?.code === 'PROVIDER_CIRCUIT_OPEN',
    );
    assert.equal(await fs.readFile(counter, 'utf8'), '1', 'second call was rejected before process spawn');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('issue auto-fix is opt-in and provider suppression always wins', () => {
  assert.equal(shouldAutoFixIssue({ cfg: {}, env: {} }), false);
  assert.equal(shouldAutoFixIssue({ cfg: { chat: { issue_bridge: { auto_fix: true } } }, env: {} }), true);
  assert.equal(shouldAutoFixIssue({
    cfg: { chat: { issue_bridge: { auto_fix: true } } }, suppressAutoFix: true, env: {},
  }), false);
  assert.equal(shouldAutoFixIssue({
    cfg: { chat: { issue_bridge: { auto_fix: true } } }, env: { ASHMERO_DISABLE_ISSUE_AUTOFIX: '1' },
  }), false);
});

test('AutoHealer never dispatches a healing or self-heal strategy for provider exhaustion', async () => {
  const healer = new AutoHealer({ projectName: 'aoa', cfg: { auto_heal: { enabled: true } } });
  let opened = null;
  healer._openIssue = async (_err, kind, detail) => { opened = { kind, detail }; };
  healer._dispatch = async () => { throw new Error('provider errors must not dispatch a strategy'); };
  const result = await healer.heal(new Error("You've reached your weekly usage limit"));
  assert.equal(result.healed, false);
  assert.equal(result.reason, 'provider-limit: waiting for provider reset');
  assert.equal(opened.kind, ERROR_KINDS.PROVIDER_LIMIT);
});
