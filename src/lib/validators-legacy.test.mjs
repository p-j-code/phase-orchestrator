import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEffectiveValidatorConfig, buildValidatorEnv, dedupeValidatorNames, matchValidators, relatedTestCandidates } from './validators.js';

test('legacy validators array is normalized into an always-run map without losing command metadata', () => {
  const effective = buildEffectiveValidatorConfig({
    validators: [
      { id: 'typecheck', command: 'npx tsc --noEmit', cwd: 'workspace', blocking: true },
      { id: 'informational', command: 'echo note', cwd: '.', blocking: false },
    ],
  });
  assert.equal(effective.validators.typecheck.command, 'npx tsc --noEmit');
  assert.equal(effective.validators.informational.blocking, false);
  assert.deepEqual(matchValidators(effective, { phase: 4 }), ['typecheck', 'informational']);
});

test('modern validator maps/rules and injected test-first validators remain unchanged', () => {
  const effective = buildEffectiveValidatorConfig({
    validators: { lint: { script: 'validators/lint.mjs' } },
    rules: [{ match: { phase: 2 }, run: ['lint'] }],
  }, {
    extraValidators: { acceptance: { script: '/tmp/acceptance.mjs' } },
    extraRules: [{ match: { always: true }, run: ['acceptance'] }],
  });
  assert.deepEqual(matchValidators(effective, { phase: 1 }), ['acceptance']);
  assert.deepEqual(matchValidators(effective, { phase: 2 }), ['lint', 'acceptance']);
});

test('a configured tsc emit validator is never silently dropped by a --noEmit sibling', () => {
  // `tsc --noEmit` skips the declaration/emit pipeline, so emit-only failures
  // (declaration-emit errors, TS5055, outDir problems) pass it. Dropping the
  // emitting `build` validator on that inferred equivalence deleted a
  // user-configured BLOCKING check (aoa's build) — configured validators only
  // dedupe on byte-identical execution signatures.
  const effective = buildEffectiveValidatorConfig({
    validators: [
      { id: 'typecheck', command: 'npx tsc --noEmit', cwd: 'workspace' },
      { id: 'build', command: 'npx tsc', cwd: 'workspace', cleanup_after: 'rm -rf workspace/dist' },
      { id: 'smoke', command: 'node smoke.mjs', cwd: 'workspace' },
    ],
  });
  assert.deepEqual(dedupeValidatorNames(effective, ['typecheck', 'build', 'smoke']), ['typecheck', 'build', 'smoke']);
});

test('tsc emit is retained when its output is not immediately discarded or duplicate execution is explicit', () => {
  const effective = buildEffectiveValidatorConfig({
    validators: [
      { id: 'typecheck', command: 'npx tsc --noEmit', cwd: 'workspace' },
      { id: 'build', command: 'npx tsc', cwd: 'workspace' },
      { id: 'intentional', command: 'npx tsc --noEmit', cwd: 'workspace', allow_duplicate: true },
    ],
  });
  assert.deepEqual(dedupeValidatorNames(effective, ['typecheck', 'build', 'intentional']), ['typecheck', 'build', 'intentional']);
});

test('duplicate commands retain distinct blocking, timeout, and cleanup semantics', () => {
  const effective = buildEffectiveValidatorConfig({
    validators: [
      { id: 'advisory', command: 'npm test', blocking: false, timeout_ms: 5_000 },
      { id: 'gate', command: 'npm test', blocking: true, timeout_ms: 30_000 },
      { id: 'cleanup', command: 'npm test', blocking: false, timeout_ms: 5_000, cleanup_after: 'rm -rf tmp' },
    ],
  });
  assert.deepEqual(
    dedupeValidatorNames(effective, ['advisory', 'gate', 'cleanup']),
    ['advisory', 'gate', 'cleanup'],
  );
});

test('related test candidates stay inside predictable source/test mirrors', () => {
  const candidates = relatedTestCandidates('packages/api/src/services/user.ts');
  assert.ok(candidates.includes('packages/api/src/services/user.test.ts'));
  assert.ok(candidates.includes('packages/api/tests/services/user.test.ts'));
  assert.equal(candidates.some((file) => file.includes('..')), false);
});

test('validator env strips provider billing credentials by default and preserves ordinary build env', () => {
  const env = buildValidatorEnv({
    projectName: 'demo',
    projDir: '/tmp/demo',
    event: { phase: 4, fixRound: 2, fixN: 3 },
  }, {
    PATH: '/bin', HOME: '/tmp/home', DATABASE_URL: 'sqlite:test',
    ANTHROPIC_API_KEY: 'secret-a', CLAUDE_CODE_OAUTH_TOKEN: 'secret-b',
    OPENAI_API_KEY: 'secret-c', CODEX_API_KEY: 'secret-d',
  });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.DATABASE_URL, 'sqlite:test');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CODEX_API_KEY, undefined);
  assert.equal(env.ORCHESTRATOR_PHASE, '4');
  assert.equal(env.ORCHESTRATOR_FIX_ROUND, '2');
  assert.equal(env.ORCHESTRATOR_FIX_N, '3');
});

test('validator env provider credential inheritance requires an explicit per-validator opt-in', () => {
  const env = buildValidatorEnv({
    projectName: 'demo', projDir: '/tmp/demo', inheritProviderCredentials: true,
  }, { ANTHROPIC_API_KEY: 'intentional', CLAUDE_CODE_OAUTH_TOKEN: 'oauth' });
  assert.equal(env.ANTHROPIC_API_KEY, 'intentional');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth');
});
