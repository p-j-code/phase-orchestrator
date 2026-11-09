import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveContextTestPlan, resolveTargetedTestCommand, supportsTargetedTestArgs } from './context-test-cadence.js';

const manifest = {
  test_plan: { targeted_files: ['tests/z.test.js', '../escape.test.js', 'tests/a.test.js', 'tests/a.test.js'], requires_full_suite: false },
};
const assist = { context_compiler: { enabled: true, mode: 'assist', targeted_tests: true, full_suite_every_checkpoints: 3 } };

test('shadow mode preserves the historical full gate', () => {
  assert.equal(resolveContextTestPlan({ cfg: { context_compiler: { enabled: true, mode: 'shadow', targeted_tests: true } }, manifest }).scope, 'full');
});

test('development-focused cadence asks for conservative path discovery between checkpoints even in shadow mode', () => {
  const cfg = {
    context_compiler: { enabled: true, mode: 'shadow', targeted_tests: true },
    verify: { cadence: { mode: 'checkpoints', every_n_phases: 3, always_complexities: ['high', 'critical'], always_checkpoints: ['schema'] } },
  };
  const routine = resolveContextTestPlan({ cfg, manifest, phaseOrdinal: 2, changedFiles: ['src/a.js', 'tests/a.test.js'] });
  assert.equal(routine.scope, 'candidate');
  assert.deepEqual(routine.test_files, ['tests/a.test.js']);
  assert.equal(resolveContextTestPlan({ cfg, manifest, phaseOrdinal: 3, changedFiles: ['src/a.js'] }).scope, 'full');
  assert.equal(resolveContextTestPlan({ cfg, manifest, phaseOrdinal: 2, complexity: 'high', changedFiles: ['src/a.js'] }).scope, 'full');
  assert.equal(resolveContextTestPlan({ cfg, manifest, phaseOrdinal: 2, checkpoint: 'schema', changedFiles: ['src/a.js'] }).scope, 'full');
});

test('assist mode selects safe, unique targeted tests on a routine phase', () => {
  assert.deepEqual(resolveContextTestPlan({ cfg: assist, manifest, phaseOrdinal: 2 }), {
    scope: 'targeted',
    test_files: ['tests/a.test.js', 'tests/z.test.js'],
    compiler_managed: true,
    reason: 'routine phase between full-suite checkpoints (every 3 acceptance checkpoints)',
  });
});

test('periodic, final, high-risk, compiler-risk, and degraded enforce checks require full suite', () => {
  assert.equal(resolveContextTestPlan({ cfg: assist, manifest, phaseOrdinal: 3 }).scope, 'full');
  assert.equal(resolveContextTestPlan({ cfg: assist, manifest, phaseOrdinal: 2, isFinalPhase: true }).scope, 'full');
  assert.equal(resolveContextTestPlan({ cfg: assist, manifest, phaseOrdinal: 2, complexity: 'high' }).scope, 'full');
  assert.equal(resolveContextTestPlan({ cfg: assist, manifest: { test_plan: { targeted_files: ['x.test.js'], requires_full_suite: true } } }).scope, 'full');
  assert.equal(resolveContextTestPlan({ cfg: assist, manifest, enforceDegraded: true }).scope, 'full');
});

test('unmapped production changes force full while changed tests join the targeted set', () => {
  const mapped = { ...manifest, ranked_files: [{ path: 'src/a.js' }] };
  assert.equal(resolveContextTestPlan({ cfg: assist, manifest: mapped, phaseOrdinal: 2, changedFiles: ['src/unexpected.js'] }).scope, 'full');
  assert.deepEqual(
    resolveContextTestPlan({ cfg: assist, manifest: mapped, phaseOrdinal: 2, changedFiles: ['src/a.js', 'tests/new.test.js'] }).test_files,
    ['tests/a.test.js', 'tests/new.test.js', 'tests/z.test.js'],
  );
});

test('full-suite interval counts configured acceptance checkpoints', () => {
  const cfg = {
    ...assist,
    verify: { cadence: { mode: 'checkpoints', every_n_phases: 2, always_complexities: [], always_checkpoints: [] } },
  };
  assert.equal(resolveContextTestPlan({ cfg, manifest, phaseOrdinal: 4 }).scope, 'targeted', 'checkpoint 2 is not the third checkpoint');
  assert.equal(resolveContextTestPlan({ cfg, manifest, phaseOrdinal: 6 }).scope, 'full', 'phase 6 is checkpoint 3');
});

test('fix cadence counts fix ordinals independently of phase acceptance cadence', () => {
  const cfg = {
    ...assist,
    verify: { cadence: { mode: 'checkpoints', every_n_phases: 4, always_complexities: [], always_checkpoints: [] } },
  };
  assert.equal(resolveContextTestPlan({ cfg, manifest, phaseOrdinal: 2, fix: true }).scope, 'targeted');
  assert.equal(resolveContextTestPlan({ cfg, manifest, phaseOrdinal: 3, fix: true }).scope, 'full',
    'the third fix is the third fix checkpoint even though phase checks run every four phases');
});

test('repair may use mapped tests without a phase ordinal', () => {
  assert.equal(resolveContextTestPlan({ cfg: assist, manifest, repair: true }).scope, 'targeted');
});

test('targeted runner detection rejects compound or unknown scripts', () => {
  assert.equal(supportsTargetedTestArgs('node --test'), true);
  assert.equal(supportsTargetedTestArgs('vitest run'), true);
  assert.equal(supportsTargetedTestArgs('jest --runInBand'), true);
  assert.equal(supportsTargetedTestArgs('npm run unit'), false);
  assert.equal(supportsTargetedTestArgs('vitest && npm run integration'), false);
});

test('Node test command replaces an embedded glob and preserves loader flags', () => {
  const command = resolveTargetedTestCommand("node --import tsx --test 'src/**/*.test.ts'", ['src/jobs/one.test.ts']);
  assert.equal(command.cmd, process.execPath);
  assert.deepEqual(command.args, ['--import', 'tsx', '--test', 'src/jobs/one.test.ts']);
  assert.equal(command.args.some((arg) => arg.includes('**')), false);
});

test('Node test command preserves separated option values after --test', () => {
  const command = resolveTargetedTestCommand(
    "node --test --test-reporter spec 'src/**/*.test.js'",
    ['src/jobs/one.test.js'],
  );
  assert.ok(command);
  assert.deepEqual(command.args, ['--test', '--test-reporter', 'spec', 'src/jobs/one.test.js']);
});

test('command builder rejects shell syntax and option-like target paths', () => {
  assert.equal(resolveTargetedTestCommand('vitest && echo unsafe', ['x.test.js']), null);
  assert.equal(resolveTargetedTestCommand('node --test', ['--test-reporter=evil']), null);
});
