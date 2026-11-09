// Tests for the requireConfirmation gate (Phase 13):
//   - pending_confirmations nonce create / resolve / expire round-trip (state.js)
//   - requireConfirmation CLI readline fallback (notifier === null)
//   - requireConfirmation TTL expiry → default option
//   - requireConfirmation Telegram resolve-by-nonce path
//   - requireConfirmation undelivered (notifier reached nobody)
//   - decideBriefAppend Discard leaves the brief byte-identical
//   - decideBriefAppend expiry/undelivered defaults to Discard
//   - decideBriefAppend "Accept Brief Only" appends + sets discuss_brief_pending
//   - Telegram callback_data stays <= 64 bytes
//
// In-memory SQLite via DB_PATH=:memory: (state reads DB_PATH at first getDb()).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = ':memory:';

const {
  createPendingConfirmation,
  getPendingConfirmation,
  getPendingConfirmationByNonce,
  resolvePendingConfirmation,
  expirePendingConfirmation,
  expireStalePendingConfirmations,
  upsertProject,
  getDiscussBriefPending,
} = await import('../state.js');

const { requireConfirmation, buildConfirmCallbackData } = await import('./require-confirmation.js');
const { decideBriefAppend } = await import('./discussion-engine.js');

const TWO_OPTS = [
  { id: 'approve', label: '✅ Approve auto-fix' },
  { id: 'reject', label: '🛑 Reject' },
];
const BRIEF_OPTS = [
  { id: 'pipeline', label: '✅ Accept & Start Pipeline' },
  { id: 'brief', label: '📋 Accept Brief Only — review before running' },
  { id: 'discard', label: '🗑 Discard' },
];

async function makeTempProjDir(briefContent) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aorch-cf-'));
  const guideDir = path.join(dir, '.guide');
  await fs.mkdir(guideDir, { recursive: true });
  if (briefContent != null) {
    await fs.writeFile(path.join(guideDir, 'brief.md'), briefContent, 'utf-8');
  }
  return dir;
}

// ─── nonce create / resolve / expire round-trip ──────────────────────────────

test('createPendingConfirmation round-trips by id and by nonce', () => {
  const { id, nonce, expiresAt } = createPendingConfirmation({
    action: 'self-heal', summary: 's', options: TWO_OPTS, defaultOption: 'reject', ttlMs: null,
  });
  assert.ok(id > 0, 'id assigned');
  assert.match(nonce, /^[0-9a-f]{8}$/, 'nonce is 8 hex chars (randomBytes(4))');
  assert.equal(expiresAt, null, 'null ttl → no expiry (indefinite)');

  const byId = getPendingConfirmation(id);
  const byNonce = getPendingConfirmationByNonce(nonce);
  assert.equal(byId.id, byNonce.id);
  assert.equal(byId.status, 'pending');
  assert.equal(JSON.parse(byId.options_json).length, 2);
});

test('resolvePendingConfirmation settles a pending row, then is a no-op', () => {
  const { id, nonce } = createPendingConfirmation({
    action: 'self-heal', summary: 's', options: TWO_OPTS, defaultOption: 'reject',
  });
  const resolved = resolvePendingConfirmation(nonce, 'approve', 42);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.chosen_option, 'approve');
  assert.equal(resolved.resolved_by, 42);
  assert.ok(resolved.resolved_at, 'resolved_at stamped');

  // Double / late tap must not re-resolve.
  assert.equal(resolvePendingConfirmation(nonce, 'reject', 99), null, 'second resolve is a no-op');
  assert.equal(getPendingConfirmation(id).chosen_option, 'approve', 'choice unchanged by late tap');
});

test('expirePendingConfirmation expires a pending row once; resolve afterwards is a no-op', () => {
  const { id, nonce } = createPendingConfirmation({
    action: 'brief-append', summary: 's', options: BRIEF_OPTS, defaultOption: 'discard', ttlMs: 1000,
  });
  assert.equal(expirePendingConfirmation(id), true, 'first expire flips pending → expired');
  assert.equal(expirePendingConfirmation(id), false, 'second expire is a no-op');
  assert.equal(getPendingConfirmation(id).status, 'expired');
  assert.equal(resolvePendingConfirmation(nonce, 'pipeline'), null, 'cannot resolve an expired row');
});

test('expireStalePendingConfirmations sweeps past-due rows but never indefinite ones', () => {
  const stale = createPendingConfirmation({
    action: 'brief-append', summary: 's', options: BRIEF_OPTS, defaultOption: 'discard', ttlMs: -1000,
  });
  const indefinite = createPendingConfirmation({
    action: 'self-heal', summary: 's', options: TWO_OPTS, defaultOption: 'reject', ttlMs: null,
  });
  const swept = expireStalePendingConfirmations();
  assert.ok(swept >= 1, 'at least the past-due row is swept');
  assert.equal(getPendingConfirmation(stale.id).status, 'expired');
  assert.equal(getPendingConfirmation(indefinite.id).status, 'pending', 'indefinite row untouched');
});

// ─── CLI readline fallback ────────────────────────────────────────────────────

test('requireConfirmation CLI fallback resolves via the prompt (notifier null)', async () => {
  const res = await requireConfirmation({
    action: 'brief-append', summary: 's', options: BRIEF_OPTS, defaultOption: 'discard',
    ttlMs: 5000, notifier: null,
    promptFn: async () => 'pipeline',
  });
  assert.equal(res.reason, 'cli');
  assert.equal(res.option, 'pipeline');
  assert.equal(res.resolved, true);
  assert.equal(getPendingConfirmationByNonce(res.nonce).status, 'resolved', 'row resolved in DB');
});

test('requireConfirmation CLI fallback with no TTY falls back to the default option', async () => {
  const res = await requireConfirmation({
    action: 'self-heal', summary: 's', options: TWO_OPTS, defaultOption: 'reject',
    ttlMs: null, notifier: null,
    promptFn: async () => undefined, // simulates a non-interactive stdin
  });
  assert.equal(res.reason, 'no-tty');
  assert.equal(res.option, 'reject', 'falls back to safe default, never blocks');
  assert.equal(getPendingConfirmationByNonce(res.nonce).status, 'expired');
});

// ─── Notifier path: expiry, telegram resolve, undelivered ────────────────────

test('requireConfirmation expires to the default option when nobody answers', async () => {
  const notifier = { async notify() { return { delivered: 1 }; } };
  const res = await requireConfirmation({
    action: 'brief-append', summary: 's', options: BRIEF_OPTS, defaultOption: 'discard',
    ttlMs: 40, notifier, pollIntervalMs: 5,
  });
  assert.equal(res.reason, 'expired');
  assert.equal(res.option, 'discard', 'TTL expiry defaults to Discard');
  assert.equal(res.resolved, false);
});

test('requireConfirmation resolves by nonce from a simulated Telegram tap', async () => {
  // The notify stub plays the operator: it reads the nonce out of the keyboard
  // callback_data and resolves the row, exactly like the cf:* handler would.
  const notifier = {
    async notify({ replyMarkup }) {
      const btn = replyMarkup.inline_keyboard[0][0]; // first option's button
      const [, , nonce, optIdx] = btn.callback_data.split(':');
      const row = getPendingConfirmationByNonce(nonce);
      const opts = JSON.parse(row.options_json);
      resolvePendingConfirmation(nonce, opts[Number(optIdx)].id, 999);
      return { delivered: 1 };
    },
  };
  const res = await requireConfirmation({
    action: 'self-heal', summary: 's', options: TWO_OPTS, defaultOption: 'reject',
    ttlMs: null, notifier, pollIntervalMs: 5,
  });
  assert.equal(res.reason, 'telegram');
  assert.equal(res.option, 'approve', 'resolved to the tapped option');
  assert.equal(res.resolved, true);
});

test('requireConfirmation returns undelivered without waiting when nobody is reachable', async () => {
  const notifier = { async notify() { return { delivered: 0, total: 0 }; } };
  const res = await requireConfirmation({
    action: 'self-heal', summary: 's', options: TWO_OPTS, defaultOption: 'reject',
    ttlMs: null, notifier, pollIntervalMs: 5,
  });
  assert.equal(res.reason, 'undelivered');
  assert.equal(res.option, null, 'caller (self-heal) decides — writes a pending log + pauses');
  assert.equal(res.resolved, false);
});

// ─── decideBriefAppend (gate at the append decision) ─────────────────────────

test('decideBriefAppend Discard leaves brief.md byte-identical', async () => {
  const original = '# Brief\n\nExisting content that must not change.\n';
  const projDir = await makeTempProjDir(original);
  try {
    const result = await decideBriefAppend({
      projectName: 'cf-discard', discId: 7, topic: 'perf',
      conclusion: { brief_patch: '## Should NOT be written' },
      projDir,
      requireConfirmationFn: async () => ({ option: 'discard', reason: 'expired' }),
    });
    assert.equal(result.choice, 'discard');
    assert.equal(result.appended, false);
    const after = await fs.readFile(path.join(projDir, '.guide', 'brief.md'), 'utf-8');
    assert.equal(after, original, 'brief.md must be byte-identical after Discard');
  } finally {
    await fs.rm(projDir, { recursive: true, force: true });
  }
});

test('decideBriefAppend defaults to Discard on undelivered/expired (no option chosen)', async () => {
  const original = '# Brief\n\nUntouched.\n';
  const projDir = await makeTempProjDir(original);
  try {
    const result = await decideBriefAppend({
      projectName: 'cf-undeliv', discId: 8, topic: 'perf',
      conclusion: { brief_patch: '## Should NOT be written' },
      projDir,
      requireConfirmationFn: async () => ({ option: null, reason: 'undelivered' }),
    });
    assert.equal(result.choice, 'discard', 'null/undelivered collapses to Discard');
    assert.equal(result.appended, false);
    const after = await fs.readFile(path.join(projDir, '.guide', 'brief.md'), 'utf-8');
    assert.equal(after, original);
  } finally {
    await fs.rm(projDir, { recursive: true, force: true });
  }
});

test('decideBriefAppend "Accept Brief Only" appends and sets discuss_brief_pending', async () => {
  upsertProject({ name: 'cf-brief-only', tech_stack: 'node', total_phases: 1 });
  const original = '# Brief\n\nBefore.\n';
  const projDir = await makeTempProjDir(original);
  try {
    const result = await decideBriefAppend({
      projectName: 'cf-brief-only', discId: 13, topic: 'caching',
      conclusion: { brief_patch: '## Caching strategy\nUse an LRU.' },
      projDir,
      requireConfirmationFn: async () => ({ option: 'brief', reason: 'telegram' }),
    });
    assert.equal(result.choice, 'brief');
    assert.equal(result.appended, true);
    const after = await fs.readFile(path.join(projDir, '.guide', 'brief.md'), 'utf-8');
    assert.ok(after.startsWith(original), 'existing brief content preserved');
    assert.ok(after.includes('## Caching strategy'), 'patch appended');
    assert.equal(getDiscussBriefPending('cf-brief-only'), 13, 'next go will surface discussion #13');
  } finally {
    await fs.rm(projDir, { recursive: true, force: true });
  }
});

// ─── Telegram callback_data 64-byte limit ────────────────────────────────────

test('buildConfirmCallbackData stays well under the 64-byte Telegram limit', () => {
  // Worst realistic case: a large autoincrement id + full 8-hex nonce + index.
  const data = buildConfirmCallbackData(999999, 'deadbeef', 2);
  assert.ok(Buffer.byteLength(data, 'utf8') <= 64, `callback_data must be <= 64 bytes, got ${data}`);
  assert.match(data, /^cf:999999:deadbeef:2$/);
});
