import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = ':memory:';

const { buildSelfHealPrompt, buildSelfHealRunnerCfg, cleanupSelfHealChanges } = await import('./self-heal-agent.js');
const { runGit, workspaceStatus } = await import('./git.js');

test('self-heal prompt points the agent at one file without embedding the full source', () => {
  const prompt = buildSelfHealPrompt({
    relPath: 'src/example.js',
    line: 42,
    errorSummary: 'boom',
    stackLines: 'Error: boom\n    at src/example.js:42:1',
  });
  assert.match(prompt, /Read src\/example\.js around line 42/);
  assert.match(prompt, /minimal correct fix/);
  assert.doesNotMatch(prompt, /```js/);
});

test('self-heal uses the normal runner configuration with bounded tools, turns, and timeout', () => {
  const source = {
    models: { 'dev-execution': 'claude-sonnet-5' },
    tools: { allowed_default: ['Read', 'Edit', 'Write', 'Bash'] },
    phases: { task_max_turns: { chat: 30 }, task_timeout_ms: { chat: 10 } },
    _effort_override: 'xhigh',
  };
  const cfg = buildSelfHealRunnerCfg(source);
  assert.equal(cfg.model, 'claude-sonnet-5');
  assert.deepEqual(cfg.tools.allowed_default, ['Read', 'Edit']);
  assert.equal(cfg.phases.task_max_turns['self-heal'], 8);
  assert.equal(cfg.phases.task_timeout_ms['self-heal'], 300000);
  assert.equal(cfg._effort_override, undefined);
  assert.deepEqual(source.tools.allowed_default, ['Read', 'Edit', 'Write', 'Bash'], 'caller config is not mutated');
});

test('self-heal cleanup restores tracked and removes newly-created model changes', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'ashmero-self-heal-cleanup-'));
  try {
    assert.equal((await runGit(repo, ['init'])).ok, true);
    await runGit(repo, ['config', 'user.email', 'test@example.invalid']);
    await runGit(repo, ['config', 'user.name', 'Ashmero Test']);
    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
    await fs.writeFile(path.join(repo, 'src', 'tracked.js'), 'export const value = 1;\n');
    await runGit(repo, ['add', '--', 'src/tracked.js']);
    assert.equal((await runGit(repo, ['commit', '-m', 'initial'])).ok, true);

    await fs.writeFile(path.join(repo, 'src', 'tracked.js'), 'export const value = 2;\n');
    await fs.writeFile(path.join(repo, 'src', 'extra.js'), 'unexpected\n');
    await runGit(repo, ['add', '--', 'src/extra.js']);
    await fs.mkdir(path.join(repo, 'scratch'), { recursive: true });
    await fs.writeFile(path.join(repo, 'scratch', 'nested.txt'), 'unexpected\n');

    const cleanup = await cleanupSelfHealChanges(repo);
    assert.deepEqual(cleanup, { ok: true, failures: [] });
    assert.equal(await fs.readFile(path.join(repo, 'src', 'tracked.js'), 'utf8'), 'export const value = 1;\n');
    await assert.rejects(fs.access(path.join(repo, 'src', 'extra.js')));
    await assert.rejects(fs.access(path.join(repo, 'scratch', 'nested.txt')));
    assert.equal((await workspaceStatus(repo)).clean, true);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});
