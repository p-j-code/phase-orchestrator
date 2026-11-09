import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { discoverRelatedTestFiles, runDefaultGate } from './validators.js';

async function workspace(scripts) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aorch-target-gate-'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module', scripts }, null, 2));
  return dir;
}

test('executable code under docs/ and test fixtures never classify as documentation-only', async () => {
  const dir = await workspace({ test: 'node --test' });
  const codeUnderDocs = await discoverRelatedTestFiles({ workspaceDir: dir, changedFiles: ['docs/generate-sidebar.js'] });
  assert.notEqual(codeUnderDocs.scope, 'skip', 'a .js file under docs/ is code, not documentation');
  const fixture = await discoverRelatedTestFiles({ workspaceDir: dir, changedFiles: ['test/fixtures/expected-output.txt'] });
  assert.notEqual(fixture.scope, 'skip', 'a fixture under test/ affects the suite and must gate');
  const pureDocs = await discoverRelatedTestFiles({ workspaceDir: dir, changedFiles: ['docs/guide.md', 'README.txt'] });
  assert.equal(pureDocs.scope, 'skip', 'genuinely doc-only changes still skip');
});

test('tests/-mirror layout maps a source to its mirrored test (cap applies after existence checks)', async () => {
  const dir = await workspace({ test: 'node --test' });
  await fs.mkdir(path.join(dir, 'src', 'services'), { recursive: true });
  await fs.mkdir(path.join(dir, 'tests', 'services'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'services', 'user.ts'), 'export const u = 1;\n');
  await fs.writeFile(path.join(dir, 'tests', 'services', 'user.test.ts'), "import test from 'node:test'; test('u', () => {});\n");
  const discovery = await discoverRelatedTestFiles({ workspaceDir: dir, changedFiles: ['src/services/user.ts'] });
  assert.equal(discovery.scope, 'targeted', 'mirror candidates past index 25 must still be examined');
  assert.deepEqual(discovery.test_files, ['tests/services/user.test.ts']);
});

test('embedded full-suite glob is replaced: targeted passing test does not run unrelated failing test', async () => {
  const dir = await workspace({ test: "node --test 'tests/*.test.js'" });
  await fs.mkdir(path.join(dir, 'tests'));
  await fs.writeFile(path.join(dir, 'tests', 'good.test.js'), "import test from 'node:test'; test('good', () => {});\n");
  await fs.writeFile(path.join(dir, 'tests', 'bad.test.js'), "import test from 'node:test'; test('bad', () => { throw new Error('must not run'); });\n");
  const result = await runDefaultGate({
    workspaceDir: dir,
    testPlan: { scope: 'targeted', test_files: ['tests/good.test.js'], compiler_managed: true, reason: 'routine phase' },
    testTimeoutMs: 10000,
  });
  assert.equal(result.hasFailures, false);
  assert.equal(result.test_scope, 'targeted');
  assert.deepEqual(result.test_files, ['tests/good.test.js']);
});

test('missing targeted path forces the full historical command', async () => {
  const dir = await workspace({ test: 'node --test tests/good.test.js' });
  await fs.mkdir(path.join(dir, 'tests'));
  await fs.writeFile(path.join(dir, 'tests', 'good.test.js'), "import test from 'node:test'; test('good', () => {});\n");
  const result = await runDefaultGate({
    workspaceDir: dir,
    testPlan: { scope: 'targeted', test_files: ['tests/missing.test.js'], compiler_managed: true, reason: 'routine phase' },
    testTimeoutMs: 10000,
  });
  assert.equal(result.test_scope, 'full');
  assert.match(result.test_scope_reason, /routine phase|missing|unsafe/);
});

test('legacy compound scripts can run compiler-selected direct Node test entries only', async () => {
  const dir = await workspace({
    test: 'npm run test:gate',
    'test:gate': 'node test-one.mjs && node test-two.mjs',
    'test:unit': 'node test-one.mjs && node test-two.mjs',
  });
  await fs.writeFile(path.join(dir, 'test-one.mjs'), 'process.exitCode = 0;\n');
  await fs.writeFile(path.join(dir, 'test-two.mjs'), "throw new Error('must not run');\n");
  const result = await runDefaultGate({
    workspaceDir: dir,
    testPlan: { scope: 'targeted', test_files: ['test-one.mjs'], compiler_managed: true, reason: 'routine phase' },
    testTimeoutMs: 10000,
  });
  assert.equal(result.hasFailures, false);
  assert.equal(result.test_scope, 'targeted');
  assert.equal(result.results.length, 1);
});

test('built-in test gates scrub inherited provider credentials', async () => {
  const dir = await workspace({ test: 'node credential-check.mjs' });
  await fs.writeFile(
    path.join(dir, 'credential-check.mjs'),
    "if (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) throw new Error('provider credential leaked');\n",
  );
  const previousOpenAi = process.env.OPENAI_API_KEY;
  const previousAnthropic = process.env.ANTHROPIC_API_KEY;
  process.env.OPENAI_API_KEY = 'must-not-leak';
  process.env.ANTHROPIC_API_KEY = 'must-not-leak';
  try {
    const result = await runDefaultGate({ workspaceDir: dir, testTimeoutMs: 10000 });
    assert.equal(result.hasFailures, false);
  } finally {
    if (previousOpenAi == null) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAi;
    if (previousAnthropic == null) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousAnthropic;
  }
});

test('built-in test gate output is bounded before it reaches logs or repair prompts', async () => {
  const dir = await workspace({ test: 'node noisy.mjs' });
  await fs.writeFile(path.join(dir, 'noisy.mjs'), "process.stdout.write('x'.repeat(1_200_000));\n");
  const result = await runDefaultGate({ workspaceDir: dir, testTimeoutMs: 10000 });
  assert.equal(result.hasFailures, false);
  assert.ok(Buffer.byteLength(result.results[0].stdout) <= 1024 * 1024 + 100);
  assert.match(result.results[0].stdout, /output truncated/);
});

test('candidate discovery targets direct tests only when every changed source maps safely', async () => {
  const dir = await workspace({ test: "node --test 'src/*.test.js'" });
  await fs.mkdir(path.join(dir, 'src'));
  await fs.writeFile(path.join(dir, 'src', 'user.js'), 'export const user = 1;\n');
  await fs.writeFile(path.join(dir, 'src', 'user.test.js'), "import test from 'node:test'; test('user', () => {});\n");
  const discovery = await discoverRelatedTestFiles({ workspaceDir: dir, changedFiles: ['src/user.js'] });
  assert.equal(discovery.scope, 'targeted');
  assert.deepEqual(discovery.test_files, ['src/user.test.js']);

  const result = await runDefaultGate({
    workspaceDir: dir,
    changedFiles: ['src/user.js'],
    testPlan: { scope: 'candidate', changed_files: ['src/user.js'], test_files: [], reason: 'routine phase' },
    testTimeoutMs: 10000,
  });
  assert.equal(result.test_scope, 'targeted');
});

test('candidate discovery fails closed to full suite on unmapped source or config changes', async () => {
  const dir = await workspace({ test: 'node --test tests.test.js' });
  await fs.writeFile(path.join(dir, 'tests.test.js'), "import test from 'node:test'; test('full', () => {});\n");
  await fs.mkdir(path.join(dir, 'src'));
  await fs.writeFile(path.join(dir, 'src', 'unmapped.js'), 'export default 1;\n');

  assert.equal((await discoverRelatedTestFiles({ workspaceDir: dir, changedFiles: ['src/unmapped.js'] })).scope, 'full');
  assert.equal((await discoverRelatedTestFiles({ workspaceDir: dir, changedFiles: ['package.json'] })).scope, 'full');
});

test('documentation-only candidate phase skips tests but later checkpoints remain full by policy', async () => {
  const dir = await workspace({ test: "node -e \"throw new Error('should not run')\"" });
  const result = await runDefaultGate({
    workspaceDir: dir,
    changedFiles: ['docs/guide.md'],
    testPlan: { scope: 'candidate', changed_files: ['docs/guide.md'], reason: 'routine phase' },
    testTimeoutMs: 10000,
  });
  assert.equal(result.test_scope, 'skipped');
  assert.match(result.skipped, /documentation-only/);
});
