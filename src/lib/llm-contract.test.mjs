// Tests for llm-contract.js (brief 08 / P1) — the generalized output-contract
// module: reply seam + artifact seam, exactly-one re-ask, optional next-tier
// escalation, and tolerantJsonParse. No real `claude` subprocess is ever
// spawned — every call goes through the injected `runClaude` seam.
//
// Run with: node --test src/lib/llm-contract.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runWithContract, tolerantJsonParse,
  markdownContractValidator, runArtifactContractOnExistingCall,
} from './llm-contract.js';
import { TIER_ORDER } from '../model-router.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TIER_MODELS = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-4-8',
  fable: 'claude-fable-5',
};

function baseCall(model = 'claude-sonnet-5') {
  return {
    cfg: { model, model_routing: { tier_models: TIER_MODELS } },
    cwd: '/tmp/ws',
    role: null,
    project: 'demo',
    phase: 1,
    task: 'test-contract',
    systemPromptExtra: 'STATIC INSTRUCTION BLOCK — byte-identical across attempts',
  };
}

const SCHEMA = {
  type: 'object',
  required: ['name', 'value'],
  properties: { name: { type: 'string' }, value: { type: 'number' } },
  additionalProperties: true,
};

const VALID_JSON = JSON.stringify({ name: 'x', value: 1 });
const INVALID_JSON = JSON.stringify({ name: 'x' }); // missing required `value`

// A runClaude fake that returns scripted results per attempt and records the
// exact opts each call received (the seam the calls-table model assertion
// rides on: runClaude persists cfg.model into `calls`).
function scriptedRunClaude(results) {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    const r = results[Math.min(calls.length - 1, results.length - 1)];
    if (typeof r === 'function') return r(opts, calls.length - 1);
    if (r instanceof Error) throw r;
    return r;
  };
  return { fn, calls };
}

function reply(result, sessionId = 'sess-1') {
  return { result, session_id: sessionId, is_error: false };
}

// artifactReader that yields a scripted sequence, advancing one step per call.
function sequenceReader(outcomes) {
  let i = 0;
  const seen = [];
  const reader = async () => {
    const o = outcomes[Math.min(i, outcomes.length - 1)];
    i += 1;
    seen.push(o);
    return o;
  };
  reader.callCount = () => i;
  return reader;
}

// ─── tolerantJsonParse (moved here from verify-loop.js) ─────────────────────

test('tolerantJsonParse: parses plain JSON, a markdown-fenced object, and trailing prose', () => {
  assert.deepEqual(tolerantJsonParse('{"a":1}'), { a: 1 });
  assert.deepEqual(tolerantJsonParse('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(tolerantJsonParse('here you go: {"a":{"b":2}} done'), { a: { b: 2 } });
});

test('tolerantJsonParse: throws when there is no JSON object at all', () => {
  assert.throws(() => tolerantJsonParse('not json at all'), /no JSON object found/);
});

test('tolerantJsonParse: throws on an unterminated object', () => {
  assert.throws(() => tolerantJsonParse('{"a": {'), /unterminated JSON/);
});

// ─── Reply seam ──────────────────────────────────────────────────────────────

test('reply seam: valid on the first try → zero re-asks, one call, parsed value returned', async () => {
  const { fn, calls } = scriptedRunClaude([reply(VALID_JSON)]);
  const out = await runWithContract({ baseCall: baseCall(), prompt: 'do the thing', schema: SCHEMA, runClaude: fn });

  assert.equal(out.ok, true);
  assert.equal(out.reasks, 0);
  assert.equal(out.escalated, false);
  assert.deepEqual(out.value, { name: 'x', value: 1 });
  assert.equal(out.usedModel, 'claude-sonnet-5');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, null, 'initial call is a fresh session');
  assert.equal(calls[0].prompt, 'do the thing');
});

test('reply seam: invalid then valid → exactly one re-ask, resuming the SAME session and carrying the errors', async () => {
  const { fn, calls } = scriptedRunClaude([
    reply(INVALID_JSON, 'sess-A'),
    reply(VALID_JSON, 'sess-A'),
  ]);
  const out = await runWithContract({ baseCall: baseCall(), prompt: 'do the thing', schema: SCHEMA, runClaude: fn });

  assert.equal(out.ok, true);
  assert.equal(out.reasks, 1);
  assert.equal(calls.length, 2, 'exactly one re-ask (two total calls)');
  assert.equal(calls[0].sessionId, null);
  assert.equal(calls[1].sessionId, 'sess-A', 're-ask resumes the SAME session the first call returned');
  assert.notEqual(calls[1].prompt, calls[0].prompt, 're-ask prompt differs from the original');
  assert.match(calls[1].prompt, /value/, 're-ask prompt carries the ajv validation error text');
  assert.equal(calls[1].systemPromptExtra, calls[0].systemPromptExtra, 'the static instruction block is byte-identical across attempts (cache discipline)');
});

test('reply seam: invalid twice (no escalation) → failure, reasks capped at max_reasks', async () => {
  const { fn, calls } = scriptedRunClaude([reply(INVALID_JSON)]); // every call invalid
  const out = await runWithContract({ baseCall: baseCall(), prompt: 'p', schema: SCHEMA, runClaude: fn });

  assert.equal(out.ok, false);
  assert.equal(out.reasks, 1, 'default max_reasks is 1');
  assert.equal(out.escalated, false);
  assert.equal(calls.length, 2, 'initial + one re-ask, then give up — never a third call');
  assert.ok(Array.isArray(out.errors) && out.errors.length > 0);
});

test('reply seam: re-asks never exceed max_reasks (maxReasks:2 → at most 3 calls)', async () => {
  const { fn, calls } = scriptedRunClaude([reply(INVALID_JSON)]);
  const out = await runWithContract({ baseCall: baseCall(), prompt: 'p', schema: SCHEMA, maxReasks: 2, runClaude: fn });

  assert.equal(out.ok, false);
  assert.equal(out.reasks, 2, 'exactly two re-asks with maxReasks:2');
  assert.equal(calls.length, 3, 'initial + two re-asks — no more');
});

test('reply seam: a `validate` fn (not a schema) is applied to the PARSED object and wins the seam', async () => {
  const { fn, calls } = scriptedRunClaude([
    reply(JSON.stringify({ n: 1 }), 'sess-V'),
    reply(JSON.stringify({ n: 5 }), 'sess-V'),
  ]);
  const validate = (parsed) => (parsed.n >= 3
    ? { ok: true, value: parsed }
    : { ok: false, errors: [`n must be >= 3, got ${parsed.n}`] });
  const out = await runWithContract({ baseCall: baseCall(), prompt: 'p', validate, runClaude: fn });

  assert.equal(out.ok, true);
  assert.deepEqual(out.value, { n: 5 });
  assert.equal(calls.length, 2);
  assert.match(calls[1].prompt, /n must be >= 3/, 'the validate fn error text is threaded into the re-ask');
});

test('reply seam: unparseable JSON is a validation failure (triggers a re-ask), not a spawn error', async () => {
  const { fn, calls } = scriptedRunClaude([
    reply('this is not json', 'sess-J'),
    reply(VALID_JSON, 'sess-J'),
  ]);
  const out = await runWithContract({ baseCall: baseCall(), prompt: 'p', schema: SCHEMA, runClaude: fn });
  assert.equal(out.ok, true);
  assert.equal(calls.length, 2);
  assert.match(calls[1].prompt, /invalid JSON/);
});

// ─── Artifact seam ───────────────────────────────────────────────────────────

test('artifact seam: valid on the first read → zero re-asks, artifact value returned', async () => {
  const { fn, calls } = scriptedRunClaude([reply('done')]);
  const artifactReader = sequenceReader([{ ok: true, value: { plan: 'ok' } }]);
  const out = await runWithContract({
    baseCall: baseCall(), prompt: 'write plan.json', artifactReader,
    filePath: '.guide/plan.json', runClaude: fn,
  });

  assert.equal(out.ok, true);
  assert.equal(out.reasks, 0);
  assert.deepEqual(out.value, { plan: 'ok' });
  assert.equal(calls.length, 1);
  assert.equal(artifactReader.callCount(), 1, 'artifactReader runs once, after the call');
});

test('artifact seam: invalid read then valid read → exactly one session-resumed re-ask naming the file path + errors', async () => {
  const { fn, calls } = scriptedRunClaude([
    reply('wrote it', 'sess-ART'),
    reply('fixed it', 'sess-ART'),
  ]);
  const artifactReader = sequenceReader([
    { ok: false, errors: ['missing required field: fixes'] },
    { ok: true, value: { fixes: [] } },
  ]);
  const out = await runWithContract({
    baseCall: baseCall(), prompt: 'write fix-plan.json', artifactReader,
    filePath: '.guide/bug-rounds/round-1/fix-plan.json', runClaude: fn,
  });

  assert.equal(out.ok, true);
  assert.equal(out.reasks, 1);
  assert.deepEqual(out.value, { fixes: [] });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].sessionId, 'sess-ART', 're-ask resumes the SAME session');
  assert.match(calls[1].prompt, /missing required field: fixes/, 're-ask carries the artifact validation errors');
  assert.match(calls[1].prompt, /fix-plan\.json/, 're-ask names the file path');
});

test('artifact seam: invalid twice → failure with the last errors, reasks capped', async () => {
  const { fn, calls } = scriptedRunClaude([reply('x')]);
  const artifactReader = sequenceReader([{ ok: false, errors: ['still broken'] }]);
  const out = await runWithContract({
    baseCall: baseCall(), prompt: 'p', artifactReader, filePath: 'f.json', runClaude: fn,
  });

  assert.equal(out.ok, false);
  assert.equal(out.reasks, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(out.errors, ['still broken']);
});

test('artifact seam: a throwing artifactReader is a validation failure (re-ask), never propagated', async () => {
  const { fn, calls } = scriptedRunClaude([reply('x', 'sess-T'), reply('y', 'sess-T')]);
  let firstRead = true;
  const artifactReader = async () => {
    if (firstRead) { firstRead = false; throw new Error('ENOENT: no such file'); }
    return { ok: true, value: { ok: 1 } };
  };
  const out = await runWithContract({ baseCall: baseCall(), prompt: 'p', artifactReader, filePath: 'f.json', runClaude: fn });
  assert.equal(out.ok, true);
  assert.equal(calls.length, 2);
  assert.match(calls[1].prompt, /artifact read failed: ENOENT/);
});

// ─── escalateOnSecondFail — one tier up via model-router's TIER_ORDER ────────

test('escalateOnSecondFail: after the re-ask budget is spent, one fresh call on the NEXT tier up; the escalated cfg.model is what the calls table records', async () => {
  const { fn, calls } = scriptedRunClaude([
    reply(INVALID_JSON, 'sess-1'), // initial
    reply(INVALID_JSON, 'sess-1'), // re-ask
    reply(VALID_JSON, 'sess-esc'), // escalation succeeds
  ]);
  const out = await runWithContract({
    baseCall: baseCall('claude-sonnet-5'), prompt: 'ORIGINAL PROMPT',
    schema: SCHEMA, escalateOnSecondFail: true, runClaude: fn,
  });

  assert.equal(out.ok, true);
  assert.equal(out.escalated, true);
  assert.equal(out.reasks, 1, 'escalation is a fresh call, NOT counted as a re-ask');
  assert.equal(calls.length, 3, 'initial + one re-ask + one escalation attempt');
  assert.equal(calls[2].sessionId, null, 'escalation is a FRESH session, not resumed');
  assert.equal(calls[2].prompt, 'ORIGINAL PROMPT', 'escalation re-runs the ORIGINAL prompt, not the re-ask prompt');
  assert.equal(calls[2].cfg.model, 'claude-opus-4-8', 'sonnet escalates one tier up to opus — recorded via cfg.model into calls');
  assert.equal(out.usedModel, 'claude-opus-4-8', 'usedModel reflects the model that actually produced the verdict');
});

test('escalateOnSecondFail: escalation walks TIER_ORDER, not a hardcoded opus — opus escalates to fable', async () => {
  const { fn, calls } = scriptedRunClaude([reply(INVALID_JSON), reply(INVALID_JSON), reply(VALID_JSON)]);
  const out = await runWithContract({
    baseCall: baseCall('claude-opus-4-8'), prompt: 'p',
    schema: SCHEMA, escalateOnSecondFail: true, runClaude: fn,
  });
  assert.equal(out.ok, true);
  assert.equal(calls[2].cfg.model, 'claude-fable-5', 'opus → fable, proving the next-tier resolution reads the ladder');
  assert.equal(TIER_ORDER[TIER_ORDER.indexOf('opus') + 1], 'fable', 'sanity: fable is the rung above opus in the landed ladder');
});

test('escalateOnSecondFail: at the top rung (fable) there is no next tier → no escalation call, failure returned', async () => {
  const { fn, calls } = scriptedRunClaude([reply(INVALID_JSON)]);
  const out = await runWithContract({
    baseCall: baseCall('claude-fable-5'), prompt: 'p',
    schema: SCHEMA, escalateOnSecondFail: true, runClaude: fn,
  });
  assert.equal(out.ok, false);
  assert.equal(out.escalated, false);
  assert.equal(calls.length, 2, 'initial + re-ask only — no escalation attempt above the top rung');
});

test('escalateOnSecondFail: next tier has no configured model (stripped tier_models) → no escalation, no undefined model id', async () => {
  const { fn, calls } = scriptedRunClaude([reply(INVALID_JSON)]);
  const strippedBase = { cfg: { model: 'claude-sonnet-5', model_routing: { tier_models: { sonnet: 'claude-sonnet-5' } } }, role: null, task: 't' };
  const out = await runWithContract({ baseCall: strippedBase, prompt: 'p', schema: SCHEMA, escalateOnSecondFail: true, runClaude: fn });
  assert.equal(out.ok, false);
  assert.equal(out.escalated, false);
  assert.equal(calls.length, 2, 'no opus model configured → escalation is skipped rather than spawning an undefined model');
});

test('escalateOnSecondFail:false (default) — invalid twice never escalates', async () => {
  const { fn, calls } = scriptedRunClaude([reply(INVALID_JSON)]);
  const out = await runWithContract({ baseCall: baseCall(), prompt: 'p', schema: SCHEMA, runClaude: fn });
  assert.equal(out.ok, false);
  assert.equal(out.escalated, false);
  assert.equal(calls.length, 2, 'no escalation without escalateOnSecondFail');
});

test('escalateOnSecondFail: escalation also applies to the artifact seam (re-reads after the stronger-tier call)', async () => {
  const { fn, calls } = scriptedRunClaude([reply('a'), reply('b'), reply('c')]);
  const artifactReader = sequenceReader([
    { ok: false, errors: ['bad'] }, // initial
    { ok: false, errors: ['still bad'] }, // re-ask
    { ok: true, value: { good: true } }, // after escalation
  ]);
  const out = await runWithContract({
    baseCall: baseCall('claude-sonnet-5'), prompt: 'write it', artifactReader,
    filePath: 'plan.json', escalateOnSecondFail: true, runClaude: fn,
  });
  assert.equal(out.ok, true);
  assert.equal(out.escalated, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].cfg.model, 'claude-opus-4-8');
  assert.deepEqual(out.value, { good: true });
});

// ─── Spawn errors abort immediately (never retried / escalated) ──────────────

test('spawn error on the initial call → immediate failure, no re-ask attempted', async () => {
  const { fn, calls } = scriptedRunClaude([new Error('claude subprocess stalled — no output for 5m')]);
  const out = await runWithContract({ baseCall: baseCall(), prompt: 'p', schema: SCHEMA, escalateOnSecondFail: true, runClaude: fn });
  assert.equal(out.ok, false);
  assert.equal(out.spawnError, true);
  assert.equal(out.reasks, 0);
  assert.equal(calls.length, 1, 'a spawn error is never retried or escalated');
});

test('spawn error on the re-ask → immediate failure, no escalation follows', async () => {
  const { fn, calls } = scriptedRunClaude([
    reply(INVALID_JSON, 'sess-1'),
    new Error('spawn crashed on re-ask'),
  ]);
  const out = await runWithContract({ baseCall: baseCall(), prompt: 'p', schema: SCHEMA, escalateOnSecondFail: true, runClaude: fn });
  assert.equal(out.ok, false);
  assert.equal(out.spawnError, true);
  assert.equal(calls.length, 2, 'only validation failures escalate — a spawn error stops the ladder');
});

// ─── markdownContractValidator (P1b — deterministic, no AJV) ─────────────────

test('markdownContractValidator: passes a doc with every required heading and within bounds', () => {
  const v = markdownContractValidator({ requiredHeadings: ['Domain', 'Prompting Guidance'], minNonEmptyLines: 2, maxLines: 100 });
  const out = v('# Project Context — demo\n\n## Domain\nB2B SaaS.\n\n## Prompting Guidance\n- when X do Y\n');
  assert.equal(out.ok, true);
  assert.equal(out.value.includes('## Domain'), true);
});

test('markdownContractValidator: a missing required heading is an error that names the heading', () => {
  const v = markdownContractValidator({ requiredHeadings: ['Domain', 'Prompting Guidance'] });
  const out = v('## Domain\nonly this section is here\n');
  assert.equal(out.ok, false);
  assert.match(out.errors.join(' '), /Prompting Guidance/);
});

test('markdownContractValidator: with no required headings, a heading-LESS doc fails but a headed one passes', () => {
  const v = markdownContractValidator({ minNonEmptyLines: 1 });
  assert.equal(v('just prose, no headings at all').ok, false, 'no markdown structure → fail');
  assert.equal(v('## Some Kind\n- a distilled bullet').ok, true);
});

test('markdownContractValidator: length bounds catch a stub (too short) and a runaway (too long)', () => {
  const short = markdownContractValidator({ minNonEmptyLines: 5 });
  assert.equal(short('## H\none line only').ok, false);
  const long = markdownContractValidator({ maxLines: 3 });
  assert.equal(long('## H\na\nb\nc\nd\ne').ok, false);
});

// ─── runArtifactContractOnExistingCall (P1b adoption adapter) ────────────────

test('runArtifactContractOnExistingCall: a valid artifact reuses the existing call — ZERO spawns, zero re-asks', async () => {
  const { fn, calls } = scriptedRunClaude([reply('MUST NOT BE CALLED')]);
  const artifactReader = sequenceReader([{ ok: true, value: { fixes: [{ n: 1 }] } }]);
  const out = await runArtifactContractOnExistingCall({
    existingResult: reply('guide already wrote it', 'sess-X'),
    baseCall: baseCall(), artifactReader, filePath: 'fix-plan.json', runClaude: fn,
  });
  assert.equal(out.ok, true);
  assert.equal(out.reasks, 0);
  assert.equal(calls.length, 0, 'the pre-made result is the initial attempt — no spawn on a valid artifact');
  assert.equal(artifactReader.callCount(), 1, 'the artifact is validated exactly once');
});

test('runArtifactContractOnExistingCall: invalid then valid → EXACTLY ONE re-ask resuming the existing session, naming file + errors', async () => {
  const { fn, calls } = scriptedRunClaude([reply('rewrote it', 'sess-X')]);
  const artifactReader = sequenceReader([
    { ok: false, errors: ['/fixes/0 must have required property \'n\''] },
    { ok: true, value: { fixes: [{ n: 1 }] } },
  ]);
  const out = await runArtifactContractOnExistingCall({
    existingResult: reply('guide already wrote it', 'sess-X'),
    baseCall: baseCall(), artifactReader,
    filePath: '.guide/bug-rounds/round-1/fix-plan.json', runClaude: fn,
  });
  assert.equal(out.ok, true);
  assert.equal(out.reasks, 1);
  assert.equal(calls.length, 1, 'initial attempt reused the existing result; exactly one re-ask spawn');
  assert.equal(calls[0].sessionId, 'sess-X', 're-ask resumes the SAME session the original call produced');
  assert.match(calls[0].prompt, /must have required property/, 're-ask carries the validation errors');
  assert.match(calls[0].prompt, /fix-plan\.json/, 're-ask names the file path');
});

test('runArtifactContractOnExistingCall: invalid twice → fail-open outcome, re-ask capped at maxReasks, never escalates', async () => {
  const { fn, calls } = scriptedRunClaude([reply('still bad', 'sess-X')]);
  const artifactReader = sequenceReader([{ ok: false, errors: ['still broken'] }]);
  const out = await runArtifactContractOnExistingCall({
    existingResult: reply('guide already wrote it', 'sess-X'),
    baseCall: baseCall(), artifactReader, filePath: 'f.json', runClaude: fn,
  });
  assert.equal(out.ok, false);
  assert.equal(out.reasks, 1);
  assert.equal(out.escalated, false, 'the existing-call adapter never escalates (no original prompt to re-run)');
  assert.equal(calls.length, 1);
  assert.deepEqual(out.errors, ['still broken']);
});

// ─── Misconfiguration is a loud programming error ────────────────────────────

test('runWithContract: no seam provided (no schema, validate, or artifactReader) throws a clear TypeError', async () => {
  await assert.rejects(
    () => runWithContract({ baseCall: baseCall(), prompt: 'p', runClaude: async () => reply(VALID_JSON) }),
    /reply seam \(schema \| validate\) or an artifact seam/,
  );
});
