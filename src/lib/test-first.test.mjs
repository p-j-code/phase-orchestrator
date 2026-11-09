// Test-first harness (Phase 81 P4a plumbing + Phase 82 P4b orchestration) —
// src/lib/test-first.test.mjs
//
// Covers:
//   - isTestFirstActive() default-OFF gate + per-phase kill switch
//   - isJsWorkspace() non-JS skip detection against REAL temp fixtures
//   - redCheck() exit-code → pass/fail, driven through an INJECTED fake runner
//     + fake spawn so the suite makes ZERO real spawns
//   - runTestFirstPreDev() full P4b flow: non-JS / no-criteria skips, author
//     spawn args (Write, NO Bash, role/sessionId null), manifest via the P1
//     reply contract with exactly one re-ask, red-check gate, green-before-dev
//     delete + fallback, orchestrator commit ('phase-N-tests:'), and the gate
//     wiring returned for phase-runner.
//
// The temp-fixture-workspace + fake-runner seam is the load-bearing test
// infrastructure. Every spawn (author + red check + commit) is faked here.
//
// Run with: node --test src/lib/test-first.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  isTestFirstActive, isJsWorkspace, redCheck, runTestFirstPreDev,
  TEST_FIRST_VALIDATOR_NAME, TEST_AUTHOR_ALLOWED_TOOLS,
} from './test-first.js';

function tmpWorkspace(label) {
  return mkdtempSync(path.join(tmpdir(), `aorch-tf-${label}-`));
}

// A spawnFile seam that records its calls and returns a scripted result — NEVER
// touches the OS. Its presence is what keeps the suite at zero real spawns.
function fakeSpawn(result = { code: 0, timedOut: false }) {
  const calls = [];
  const fn = async (opts) => { calls.push(opts); return result; };
  return { fn, calls };
}

// A fake runClaude for the acceptance-test author: records its call args,
// simulates the Write tool creating the test file on the first call, and
// replies with a manifest (or a scripted sequence of raw replies, for testing
// the one re-ask on invalid JSON). ZERO real spawns.
function fakeAuthorRunClaude({ testAbs, manifest, replies } = {}) {
  const calls = [];
  let i = 0;
  const fn = async (args) => {
    calls.push(args);
    if (testAbs && !existsSync(testAbs)) {
      mkdirSync(path.dirname(testAbs), { recursive: true });
      writeFileSync(testAbs, '// authored acceptance test (fixture)\n');
    }
    const reply = replies ? replies[Math.min(i, replies.length - 1)] : JSON.stringify(manifest);
    i += 1;
    return { result: reply, session_id: 'author-sess' };
  };
  return { fn, calls };
}

// ── isTestFirstActive: default OFF, phase-only, per-phase kill switch ──────────

test('isTestFirstActive is false by default (config absent / enabled !== true)', () => {
  assert.equal(isTestFirstActive({ cfg: {}, phaseMeta: { n: 1 } }), false);
  assert.equal(isTestFirstActive({ cfg: { test_first: {} }, phaseMeta: { n: 1 } }), false);
  assert.equal(isTestFirstActive({ cfg: { test_first: { enabled: false } }, phaseMeta: { n: 1 } }), false);
  assert.equal(isTestFirstActive({}), false);
});

test('isTestFirstActive is true only when test_first.enabled === true (and the phase has not opted out)', () => {
  assert.equal(isTestFirstActive({ cfg: { test_first: { enabled: true } }, phaseMeta: { n: 1 } }), true);
});

test('isTestFirstActive is false for fixes and single-call fix batches (phase-only)', () => {
  const cfg = { test_first: { enabled: true } };
  assert.equal(isTestFirstActive({ cfg, fix: { round: 1, n: 1 } }), false);
  assert.equal(isTestFirstActive({ cfg, isBatch: true }), false);
});

test('isTestFirstActive respects the per-phase plan.test_first === false kill switch', () => {
  const cfg = { test_first: { enabled: true } };
  assert.equal(isTestFirstActive({ cfg, phaseMeta: { n: 1, test_first: false } }), false);
  // Any other value (true / absent) does not opt out.
  assert.equal(isTestFirstActive({ cfg, phaseMeta: { n: 1, test_first: true } }), true);
  assert.equal(isTestFirstActive({ cfg, phaseMeta: { n: 1 } }), true);
});

// ── isJsWorkspace: real temp fixtures ─────────────────────────────────────────

test('isJsWorkspace is true when a package.json is present (short-circuit)', async () => {
  const ws = tmpWorkspace('pkg');
  writeFileSync(path.join(ws, 'package.json'), '{"name":"x"}');
  assert.equal(await isJsWorkspace(ws), true);
});

test('isJsWorkspace is true when a JS/TS source exists without package.json', async () => {
  const ws = tmpWorkspace('src');
  mkdirSync(path.join(ws, 'src'));
  writeFileSync(path.join(ws, 'src', 'index.ts'), 'export const x = 1;\n');
  assert.equal(await isJsWorkspace(ws), true);
});

test('isJsWorkspace is FALSE for a non-JS workspace (no package.json, no JS/TS sources)', async () => {
  const ws = tmpWorkspace('non-js');
  writeFileSync(path.join(ws, 'main.py'), 'print("hi")\n');
  writeFileSync(path.join(ws, 'README.md'), '# not js\n');
  assert.equal(await isJsWorkspace(ws), false);
});

test('isJsWorkspace ignores node_modules and dot-dirs when scanning for sources', async () => {
  const ws = tmpWorkspace('nm-only');
  mkdirSync(path.join(ws, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(path.join(ws, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
  mkdirSync(path.join(ws, '.cache'));
  writeFileSync(path.join(ws, '.cache', 'x.js'), '1;\n');
  // Only JS lives under node_modules / a dot-dir → not a JS *project*.
  assert.equal(await isJsWorkspace(ws), false);
});

// ── redCheck: exit code → pass/fail, ZERO real spawns ─────────────────────────

test('redCheck returns pass:true when the runner exits 0 (green)', async () => {
  const spy = fakeSpawn({ code: 0, timedOut: false });
  const r = await redCheck(
    { filePath: '/abs/x.test.mjs', workspaceDir: '/abs/ws', projectDir: '/abs/proj' },
    { resolveTestRunner: async () => ({ cmd: 'node', args: ['/abs/x.test.mjs'] }), spawnFile: spy.fn },
  );
  assert.deepEqual(r, { ran: true, pass: true, exitCode: 0, timedOut: false, infraFailed: false, error: null });
  assert.equal(spy.calls.length, 1);
});

test('redCheck flags infraFailed when the runner cannot execute (code -1, not a timeout)', async () => {
  const spy = fakeSpawn({ code: -1, timedOut: false, error: 'spawn node ENOENT' });
  const r = await redCheck(
    { filePath: '/abs/x.test.mjs', workspaceDir: '/abs/ws' },
    { resolveTestRunner: async () => ({ cmd: 'node', args: ['/abs/x.test.mjs'] }), spawnFile: spy.fn },
  );
  assert.equal(r.pass, false);
  assert.equal(r.infraFailed, true);
  assert.equal(r.error, 'spawn node ENOENT');
});

test('redCheck returns pass:false when the runner exits non-zero (red)', async () => {
  const spy = fakeSpawn({ code: 1, timedOut: false });
  const r = await redCheck(
    { filePath: '/abs/x.test.mjs', workspaceDir: '/abs/ws' },
    { resolveTestRunner: async () => ({ cmd: 'node', args: ['/abs/x.test.mjs'] }), spawnFile: spy.fn },
  );
  assert.equal(r.pass, false);
  assert.equal(r.exitCode, 1);
});

test('redCheck treats a timeout as a failure (pass:false, timedOut:true)', async () => {
  const spy = fakeSpawn({ code: -1, timedOut: true });
  const r = await redCheck(
    { filePath: '/abs/x.test.mjs', workspaceDir: '/abs/ws' },
    { resolveTestRunner: async () => ({ cmd: 'node', args: ['/abs/x.test.mjs'] }), spawnFile: spy.fn },
  );
  assert.equal(r.pass, false);
  assert.equal(r.timedOut, true);
});

test('redCheck routes through resolveTestRunner and passes its cmd/args to the spawn seam', async () => {
  let seenResolveArgs = null;
  const spy = fakeSpawn({ code: 0, timedOut: false });
  await redCheck(
    { filePath: '/abs/foo.smoke.mjs', workspaceDir: '/abs/ws', projectDir: '/abs/proj', timeoutMs: 1234 },
    {
      resolveTestRunner: async (fp, pd) => { seenResolveArgs = [fp, pd]; return { cmd: 'npx', args: ['tsx', fp] }; },
      spawnFile: spy.fn,
    },
  );
  assert.deepEqual(seenResolveArgs, ['/abs/foo.smoke.mjs', '/abs/proj']);
  assert.deepEqual(spy.calls[0].args, ['tsx', '/abs/foo.smoke.mjs']);
  assert.equal(spy.calls[0].cmd, 'npx');
  assert.equal(spy.calls[0].cwd, '/abs/ws');    // spawn runs in the workspace
  assert.equal(spy.calls[0].timeoutMs, 1234);
});

test('redCheck uses the REAL resolveTestRunner (plain node for a non-TS file) with only the spawn faked', async () => {
  const ws = tmpWorkspace('redcheck-real');
  const file = path.join(ws, 'anchor.test.mjs');
  writeFileSync(file, 'process.exit(0);\n'); // no .ts import → plain node
  const spy = fakeSpawn({ code: 0, timedOut: false });
  const r = await redCheck({ filePath: file, workspaceDir: ws, projectDir: ws }, { spawnFile: spy.fn });
  assert.equal(r.pass, true);
  assert.equal(spy.calls[0].cmd, process.execPath); // resolveTestRunner picked plain node
  assert.deepEqual(spy.calls[0].args, [file]);
});

// ── runTestFirstPreDev: skip path (dim log, committed:false, phase proceeds) ───

test('runTestFirstPreDev skips a non-JS workspace with a dim log and committed:false', async () => {
  const ws = tmpWorkspace('predev-nonjs');
  writeFileSync(path.join(ws, 'main.rs'), 'fn main() {}\n');
  const logs = [];
  const r = await runTestFirstPreDev({ workspaceDir: ws }, { log: (m) => logs.push(m) });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'non-js-stack');
  assert.equal(r.committed, false);
  assert.ok(logs.some((l) => /non-JS workspace/i.test(l)), 'a skip log was emitted');
});

test('runTestFirstPreDev: a JS workspace with NO acceptance criteria skips — nothing to author, no spawn', async () => {
  const author = fakeAuthorRunClaude({ manifest: { covered: [], uncovered: [] } });
  const r = await runTestFirstPreDev(
    { cfg: {}, workspaceDir: '/abs/ws', phaseMeta: { n: 1, acceptance_criteria: [] } },
    { isJsWorkspace: async () => true, runClaude: author.fn, log: () => {} },
  );
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'no-criteria');
  assert.equal(r.committed, false);
  assert.equal(author.calls.length, 0, 'no author spawn when there is nothing to cover');
});

// ── runTestFirstPreDev: P4b full flow (author → manifest → red → commit) ───────

function baseCtx(ws, { n = 5, title = 'Thing', criteria = ['does X'] } = {}) {
  return {
    cfg: { models: { 'acceptance-test-author': 'claude-sonnet-5' }, tools: { allowed_default: ['Read'] } },
    projectName: 'p', projDir: '/proj', workspaceDir: ws,
    phaseMeta: { n, title, acceptance_criteria: criteria },
  };
}

test('runTestFirstPreDev: the author spawn uses Write but NO Bash, role:null / sessionId:null, task acceptance-test-author', async () => {
  const ws = tmpWorkspace('author-args');
  const testAbs = path.join(ws, 'tests', 'acceptance', 'phase-5.test.mjs');
  const author = fakeAuthorRunClaude({ testAbs, manifest: { covered: [1], uncovered: [] } });
  const r = await runTestFirstPreDev(
    baseCtx(ws),
    {
      isJsWorkspace: async () => true,
      runClaude: author.fn,
      redCheck: async () => ({ ran: true, pass: false, exitCode: 1, timedOut: false }),
      commitAll: async () => ({ ok: true, committed: true, sha: 'abc1234' }),
      log: () => {},
    },
  );
  assert.equal(r.committed, true);
  const call = author.calls[0];
  assert.deepEqual(call.cfg.tools.allowed_default, [...TEST_AUTHOR_ALLOWED_TOOLS]);
  assert.ok(call.cfg.tools.allowed_default.includes('Write'), 'Write is allowed');
  assert.ok(!call.cfg.tools.allowed_default.some((t) => /Bash/i.test(t)), 'no Bash tool is allowed');
  assert.equal(call.role, null, 'role:null — never touches guide/dev session bookkeeping');
  assert.equal(call.sessionId, null, 'sessionId:null — a fresh session');
  assert.equal(call.task, 'acceptance-test-author');
  assert.equal(call.cfg.model, 'claude-sonnet-5', 'routed to models[acceptance-test-author]');
});

test('runTestFirstPreDev: the manifest is validated via the reply contract with EXACTLY one re-ask on invalid JSON', async () => {
  const ws = tmpWorkspace('reask');
  const testAbs = path.join(ws, 'tests', 'acceptance', 'phase-2.test.mjs');
  const author = fakeAuthorRunClaude({
    testAbs,
    replies: ['not json at all', JSON.stringify({ covered: [1], uncovered: [2] })],
  });
  const r = await runTestFirstPreDev(
    baseCtx(ws, { n: 2, criteria: ['a', 'b'] }),
    {
      isJsWorkspace: async () => true, runClaude: author.fn,
      redCheck: async () => ({ pass: false }),
      commitAll: async () => ({ ok: true, committed: true, sha: 'deadbee' }),
      log: () => {},
    },
  );
  assert.equal(author.calls.length, 2, 'one initial call + exactly one re-ask');
  assert.equal(r.committed, true);
  assert.deepEqual(r.covered, [1]);
});

test('runTestFirstPreDev: an author that never returns valid JSON falls back to LLM-checked (fail-open) and cleans up', async () => {
  const ws = tmpWorkspace('authorfail');
  const testAbs = path.join(ws, 'tests', 'acceptance', 'phase-4.test.mjs');
  const author = fakeAuthorRunClaude({ testAbs, replies: ['nope', 'still nope'] });
  const r = await runTestFirstPreDev(
    baseCtx(ws, { n: 4, criteria: ['a'] }),
    {
      isJsWorkspace: async () => true, runClaude: author.fn,
      redCheck: async () => ({ pass: false }),
      commitAll: async () => ({ ok: true, committed: true, sha: 'aaaaaaa' }),
      log: () => {},
    },
  );
  assert.equal(author.calls.length, 2, 'initial + one re-ask, then gives up');
  assert.equal(r.committed, false);
  assert.equal(r.reason, 'author-failed');
  assert.equal(existsSync(testAbs), false, 'the partial authored file is cleaned up on fallback');
});

test('runTestFirstPreDev: a green-before-dev authored file is DELETED and the phase falls back to LLM-checked', async () => {
  const ws = tmpWorkspace('green');
  const testAbs = path.join(ws, 'tests', 'acceptance', 'phase-3.test.mjs');
  const author = fakeAuthorRunClaude({ testAbs, manifest: { covered: [1], uncovered: [] } });
  let commitCalled = false;
  const r = await runTestFirstPreDev(
    baseCtx(ws, { n: 3, criteria: ['x'] }),
    {
      isJsWorkspace: async () => true, runClaude: author.fn,
      redCheck: async () => ({ ran: true, pass: true, exitCode: 0, timedOut: false }), // GREEN — vacuous
      commitAll: async () => { commitCalled = true; return { ok: true, committed: true, sha: 'aaaaaaa' }; },
      log: () => {},
    },
  );
  assert.equal(r.committed, false);
  assert.equal(r.reason, 'green-before-dev');
  assert.equal(existsSync(testAbs), false, 'the vacuous authored file was deleted');
  assert.equal(commitCalled, false, 'a green (vacuous) file is never committed');
});

test('runTestFirstPreDev: a RED authored file is committed as "phase-N-tests: <title>" and returns the gate wiring + covered + postTestsSha', async () => {
  const ws = tmpWorkspace('red');
  const testAbs = path.join(ws, 'tests', 'acceptance', 'phase-7.test.mjs');
  const author = fakeAuthorRunClaude({ testAbs, manifest: { covered: [1, 2], uncovered: [3] } });
  let commitMsg = null;
  const r = await runTestFirstPreDev(
    baseCtx(ws, { n: 7, title: 'Widget API', criteria: ['a', 'b', 'c'] }),
    {
      isJsWorkspace: async () => true, runClaude: author.fn,
      redCheck: async () => ({ ran: true, pass: false, exitCode: 1, timedOut: false }), // RED
      commitAll: async (dir, msg) => { commitMsg = msg; return { ok: true, committed: true, sha: 'beefbee' }; },
      log: () => {},
    },
  );
  assert.equal(r.committed, true);
  assert.ok(commitMsg.startsWith('phase-7-tests:'), `commit message must start with 'phase-7-tests:' (got: ${commitMsg})`);
  assert.equal(r.postTestsSha, 'beefbee', 'postTestsSha is the sha commitAll returned (== HEAD after the test commit)');
  assert.deepEqual(r.covered, [1, 2]);
  assert.deepEqual(r.uncovered, [3]);
  assert.equal(r.testRel, path.join('tests', 'acceptance', 'phase-7.test.mjs'));
  // Synthetic gate wiring the phase-runner injects into runValidatorGate.
  assert.equal(r.extraRules.length, 1);
  assert.deepEqual(r.extraRules[0].run, [TEST_FIRST_VALIDATOR_NAME]);
  assert.ok(r.extraValidators[TEST_FIRST_VALIDATOR_NAME], 'the companion synthetic validator is defined');
  assert.equal(r.extraValidators[TEST_FIRST_VALIDATOR_NAME].script, testAbs, 'the validator runs the authored test by absolute path');
});

test('runTestFirstPreDev: a commit that stages nothing falls back to LLM-checked (fail-open)', async () => {
  const ws = tmpWorkspace('nocommit');
  const testAbs = path.join(ws, 'tests', 'acceptance', 'phase-9.test.mjs');
  const author = fakeAuthorRunClaude({ testAbs, manifest: { covered: [1], uncovered: [] } });
  const r = await runTestFirstPreDev(
    baseCtx(ws, { n: 9, criteria: ['q'] }),
    {
      isJsWorkspace: async () => true, runClaude: author.fn,
      redCheck: async () => ({ pass: false }),
      commitAll: async () => ({ ok: true, committed: false }), // nothing staged
      log: () => {},
    },
  );
  assert.equal(r.committed, false);
  assert.equal(r.reason, 'commit-failed');
});
