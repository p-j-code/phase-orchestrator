// Runtime QA agent core (brief 05 / P5a) — unit tests via fake-runner seams.
// No real `claude` spawn anywhere: callFn is injected. The orphan-backstop test
// is the one place a REAL child process is spawned (a `sleep`) to prove the
// signal path actually reaps it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  runRuntimeQa,
  RUNTIME_QA_SYSTEM_PROMPT,
  RUNTIME_QA_ALLOWED_TOOLS,
  RUNTIME_QA_SCHEMA,
  resolveSandbox,
  detectEntrypoint,
  cleanupOrphanPids,
  buildRuntimeQaPrompt,
  loadJourneysBlock,
  extractDefinitionOfDone,
} from './runtime-qa.js';
import { PUSH_DENY_RULE } from './workspace-skills.js';
import { buildGuidePrompt } from './phase-runner.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function mkProject({ startScript = true, journeys = null, briefDod = null } = {}) {
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rqa-'));
  const workspaceDir = path.join(projDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(path.join(projDir, '.guide'), { recursive: true });
  const pkg = { name: 'fixture-app', version: '1.0.0' };
  if (startScript) pkg.scripts = { start: 'node server.js' };
  fs.writeFileSync(path.join(workspaceDir, 'package.json'), JSON.stringify(pkg, null, 2));
  if (journeys) fs.writeFileSync(path.join(projDir, '.guide', 'qa-journeys.json'), JSON.stringify(journeys));
  if (briefDod) fs.writeFileSync(path.join(projDir, '.guide', 'brief.md'), briefDod);
  return { projDir, workspaceDir };
}

function baseCfg(overrides = {}) {
  return {
    models: { 'runtime-qa': 'claude-sonnet-5' },
    security: { deny_rules: ['Read(../../../config/**)', 'Bash(curl:*)', 'Bash(wget:*)'] },
    runtime_qa: { enabled: true, mode: 'report', skip_when_no_entrypoint: true },
    ...overrides,
  };
}

// Fake runClaude seam. `replies` is an array of { result, session_id } consumed
// in order (last one repeats). Records every call's args.
function makeFakeRunner(replies) {
  const calls = [];
  let i = 0;
  const fn = async (callArgs) => {
    calls.push(callArgs);
    const r = Array.isArray(replies) ? replies[Math.min(i, replies.length - 1)] : replies;
    i += 1;
    return typeof r === 'function' ? r(callArgs, i - 1) : r;
  };
  fn.calls = calls;
  return fn;
}

const VALID_VERDICT = {
  journeys: [{ name: 'boot', status: 'pass', evidence: 'started, curl :3000 → 200' }],
  blockers: [],
  notes: 'app boots and serves',
};

// ─── Criterion 1 + 2: parse + persist verbatim, roleless, deny rules on spawn ─

test('runRuntimeQa: parses the verdict, persists it VERBATIM, spawn is roleless + Bash-tooled + deny-ruled', async () => {
  const { projDir, workspaceDir } = mkProject({ journeys: [{ name: 'boot', steps: ['launch', 'curl /'] }] });
  const cfg = baseCfg();
  const runner = makeFakeRunner([{ result: JSON.stringify(VALID_VERDICT), session_id: 'sess-1' }]);

  const res = await runRuntimeQa({ projectName: 'demo', workspaceDir, cfg, callFn: runner });

  assert.equal(res.status, 'ok');
  assert.equal(res.spawned, true);
  assert.equal(runner.calls.length, 1, 'exactly one spawn on a valid first reply');

  // Persisted VERBATIM.
  const persisted = JSON.parse(fs.readFileSync(path.join(projDir, '.guide', 'runtime-qa.json'), 'utf-8'));
  assert.deepEqual(persisted, VALID_VERDICT);

  // Roleless / sessionless invariant (guide_session_id / last_dev_session_id can
  // never move because role:null and sessionId:null on every call).
  const call = runner.calls[0];
  assert.equal(call.role, null, 'role must be null');
  assert.equal(call.sessionId, null, 'sessionId must be null on the initial call');
  assert.equal(call.task, 'runtime-qa');
  assert.equal(path.resolve(call.cwd), path.resolve(workspaceDir));

  // Tool profile: Read/Glob/Grep + Bash (the checker has NO Bash).
  assert.deepEqual([...call.allowedToolsOverride], ['Read', 'Glob', 'Grep', 'Bash']);
  assert.ok(call.allowedToolsOverride.includes('Bash'), 'runtime-qa must have Bash');

  // Static instruction block is the fixed literal.
  assert.equal(call.systemPromptExtra, RUNTIME_QA_SYSTEM_PROMPT);

  // Deny rules are present ON THE SPAWN — the real mergeWorkspaceDenyRules wrote
  // them into the workspace .claude/settings.json the Bash session reads.
  const settings = JSON.parse(fs.readFileSync(path.join(workspaceDir, '.claude', 'settings.json'), 'utf-8'));
  for (const rule of cfg.security.deny_rules) {
    assert.ok(settings.permissions.deny.includes(rule), `deny rule present on spawn: ${rule}`);
  }
  assert.ok(settings.permissions.deny.includes(PUSH_DENY_RULE), 'always-on push guard present');
});

// ─── Criterion 1: invalid JSON → EXACTLY ONE session-resumed re-ask → inconclusive

test('runRuntimeQa: invalid verdict JSON → exactly one session-resumed re-ask → inconclusive fail-open', async () => {
  const { projDir, workspaceDir } = mkProject({ journeys: [{ name: 'boot', steps: ['launch'] }] });
  const cfg = baseCfg();
  // Both the initial and the re-ask reply are unparseable.
  const runner = makeFakeRunner([
    { result: 'not json at all', session_id: 'sess-A' },
    { result: 'still not json', session_id: 'sess-B' },
  ]);

  const res = await runRuntimeQa({ projectName: 'demo', workspaceDir, cfg, callFn: runner });

  assert.equal(runner.calls.length, 2, 'exactly one re-ask (2 calls total)');
  assert.equal(runner.calls[0].sessionId, null, 'initial call is session-less');
  assert.equal(runner.calls[1].sessionId, 'sess-A', 're-ask RESUMES the initial call session');
  assert.equal(res.status, 'inconclusive');
  assert.equal(res.reasks, 1);

  const persisted = JSON.parse(fs.readFileSync(path.join(projDir, '.guide', 'runtime-qa.json'), 'utf-8'));
  assert.equal(persisted._status, 'inconclusive');
  assert.deepEqual(persisted.journeys, []);
  assert.deepEqual(persisted.blockers, []);
});

// ─── Criterion 3: sandbox absent → FAIL CLOSED, no spawn ─────────────────────

test('runRuntimeQa: unresolvable deny-rule sandbox → FAILS CLOSED (skipped, no Bash spawn)', async () => {
  const { projDir, workspaceDir } = mkProject({ journeys: [{ name: 'boot', steps: ['launch'] }] });
  const cfg = baseCfg({ security: {} }); // no deny_rules array → sandbox unresolvable
  const runner = makeFakeRunner([{ result: JSON.stringify(VALID_VERDICT), session_id: 'x' }]);

  const res = await runRuntimeQa({ projectName: 'demo', workspaceDir, cfg, callFn: runner });

  assert.equal(res.status, 'skipped');
  assert.equal(res.spawned, false);
  assert.match(res.reason, /sandbox unresolvable/i);
  assert.equal(runner.calls.length, 0, 'NO Bash spawn is made when the sandbox is unresolvable');
  // No verdict file written on a fail-closed skip.
  assert.equal(fs.existsSync(path.join(projDir, '.guide', 'runtime-qa.json')), false);
});

test('resolveSandbox: ok only when deny_rules is an array + the merge primitive is importable', () => {
  assert.equal(resolveSandbox(baseCfg()).ok, true);
  assert.equal(resolveSandbox({ security: {} }).ok, false);
  assert.equal(resolveSandbox({ security: { deny_rules: 'nope' } }).ok, false);
  assert.equal(resolveSandbox({}).ok, false);
  assert.equal(resolveSandbox(null).ok, false);
});

// ─── Criterion 5: no entrypoint → skipped ────────────────────────────────────

test('runRuntimeQa: no start script / CLI entrypoint → skipped (skip_when_no_entrypoint)', async () => {
  const { projDir, workspaceDir } = mkProject({ startScript: false }); // package.json with no scripts/bin
  const cfg = baseCfg();
  const runner = makeFakeRunner([{ result: JSON.stringify(VALID_VERDICT), session_id: 'x' }]);

  const res = await runRuntimeQa({ projectName: 'demo', workspaceDir, cfg, callFn: runner });

  assert.equal(res.status, 'skipped');
  assert.equal(res.spawned, false);
  assert.match(res.reason, /entrypoint/i);
  assert.equal(runner.calls.length, 0);
  assert.equal(fs.existsSync(path.join(projDir, '.guide', 'runtime-qa.json')), false);
});

test('detectEntrypoint: finds start/serve/dev scripts and bin entries; nothing when none', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rqa-ep-'));
  const write = (pkg) => fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));

  write({ name: 'a', scripts: { start: 'node s.js' } });
  assert.equal((await detectEntrypoint(dir)).found, true);
  assert.equal((await detectEntrypoint(dir)).kind, 'server');

  write({ name: 'b', bin: { mycli: 'cli.js' } });
  const bin = await detectEntrypoint(dir);
  assert.equal(bin.found, true);
  assert.equal(bin.kind, 'cli');

  write({ name: 'c', version: '1.0.0' });
  assert.equal((await detectEntrypoint(dir)).found, false);

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rqa-noep-'));
  assert.equal((await detectEntrypoint(empty)).found, false, 'no package.json → not found');
});

// ─── Criterion 4: orphan backstop kills a REAL process; never throws on garbage

test('cleanupOrphanPids: SIGTERMs a real background process group and removes the pidfile', async () => {
  const pidfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rqa-pf-')), 'pids.txt');
  // detached:true → the child is its OWN process-group leader (pgid == pid), so
  // the negative-pid group kill in cleanup targets exactly it (mirrors how a
  // well-behaved background server is launched, and claude-runner's own idiom).
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  child.unref();
  await fsp.writeFile(pidfile, `${child.pid}\n`, 'utf-8');

  const result = await cleanupOrphanPids(pidfile, { graceMs: 50 });
  assert.ok(result.killed.includes(child.pid), 'the live pid was signalled');

  // Poll (bounded) until the process is gone.
  let gone = false;
  for (let i = 0; i < 40; i += 1) {
    try { process.kill(child.pid, 0); } catch { gone = true; break; }
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(gone, 'the background process is gone after cleanup');
  assert.equal(fs.existsSync(pidfile), false, 'pidfile deleted');
});

test('cleanupOrphanPids: never throws on a garbage / empty / missing pidfile', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rqa-pf2-'));

  const garbage = path.join(dir, 'garbage.txt');
  await fsp.writeFile(garbage, 'not-a-pid\nfoo bar\n-5\n0\n1\n', 'utf-8');
  await assert.doesNotReject(() => cleanupOrphanPids(garbage, { graceMs: 5 }));
  assert.equal(fs.existsSync(garbage), false, 'garbage pidfile still deleted');

  const empty = path.join(dir, 'empty.txt');
  await fsp.writeFile(empty, '', 'utf-8');
  await assert.doesNotReject(() => cleanupOrphanPids(empty, { graceMs: 5 }));

  const missing = path.join(dir, 'does-not-exist.txt');
  await assert.doesNotReject(() => cleanupOrphanPids(missing, { graceMs: 5 }));
});

test('cleanupOrphanPids: never signals our own pid or pid<=1 (garbage-safety)', async () => {
  const pidfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rqa-pf3-')), 'pids.txt');
  await fsp.writeFile(pidfile, `${process.pid}\n1\n0\n`, 'utf-8');
  const signalled = [];
  await cleanupOrphanPids(pidfile, {
    graceMs: 5,
    kill: (pid, sig) => { signalled.push([pid, sig]); },
  });
  // process.pid, 1 and 0 must never be touched (probe or signal).
  assert.equal(signalled.length, 0, 'no signal to self / init / pgid-0');
});

// ─── Criterion 6: journeys injection + DoD fallback + byte-identical static block

test('loadJourneysBlock: injects qa-journeys.json when present', async () => {
  const { projDir } = mkProject({ journeys: [{ name: 'Login flow', steps: ['POST /login', 'expect 200'] }] });
  const block = await loadJourneysBlock({ projDir, cfg: baseCfg() });
  assert.equal(block.source, 'qa-journeys');
  assert.match(block.text, /Login flow/);
  assert.match(block.text, /POST \/login/);
});

test('loadJourneysBlock: falls back to the brief Definition-of-done section VERBATIM when qa-journeys.json is absent', async () => {
  const briefDod = `# Brief\n\n## Functional requirements\n- FR1\n\n## Definition of done\n- A run produces runtime-qa.json\n- Zero orphan processes\n\n## Non-functional\n- fast\n`;
  const { projDir } = mkProject({ journeys: null, briefDod });
  const block = await loadJourneysBlock({ projDir, cfg: baseCfg() });
  assert.equal(block.source, 'brief-dod');
  // Verbatim section: heading + its bullets, stopping before the next section.
  assert.match(block.text, /## Definition of done/);
  assert.match(block.text, /A run produces runtime-qa\.json/);
  assert.match(block.text, /Zero orphan processes/);
  assert.ok(!block.text.includes('Non-functional'), 'stops before the next same-level heading');
});

test('extractDefinitionOfDone: returns the section verbatim, empty when absent', () => {
  assert.equal(extractDefinitionOfDone('# X\n## Other\n- a\n'), '');
  const got = extractDefinitionOfDone('## Definition of done\n- one\n- two\n## Next\n- skip\n');
  assert.match(got, /- one/);
  assert.ok(!got.includes('skip'));
});

test('runRuntimeQa: static system block is byte-identical across calls; user prompt carries the volatile journeys', async () => {
  const a = mkProject({ journeys: [{ name: 'JOURNEY-ALPHA', steps: ['x'] }] });
  const b = mkProject({ journeys: [{ name: 'JOURNEY-BETA', steps: ['y'] }] });
  const runnerA = makeFakeRunner([{ result: JSON.stringify(VALID_VERDICT), session_id: '1' }]);
  const runnerB = makeFakeRunner([{ result: JSON.stringify(VALID_VERDICT), session_id: '2' }]);

  await runRuntimeQa({ projectName: 'a', workspaceDir: a.workspaceDir, cfg: baseCfg(), callFn: runnerA });
  await runRuntimeQa({ projectName: 'b', workspaceDir: b.workspaceDir, cfg: baseCfg(), callFn: runnerB });

  assert.equal(runnerA.calls[0].systemPromptExtra, runnerB.calls[0].systemPromptExtra, 'static block byte-identical');
  assert.equal(runnerA.calls[0].systemPromptExtra, RUNTIME_QA_SYSTEM_PROMPT);
  assert.notEqual(runnerA.calls[0].prompt, runnerB.calls[0].prompt, 'volatile journeys differ per call');
  assert.match(runnerA.calls[0].prompt, /JOURNEY-ALPHA/);
  assert.match(runnerB.calls[0].prompt, /JOURNEY-BETA/);
});

test('buildRuntimeQaPrompt: injects pidfile + verdict path but never mentions a Write tool', () => {
  const prompt = buildRuntimeQaPrompt({
    journeysBlock: '1. boot', journeysSource: 'qa-journeys',
    pidfilePath: '/tmp/pids.txt', entrypoint: { found: true, kind: 'server', command: 'npm start', detail: 's' },
    relVerdictPath: '.guide/runtime-qa.json',
  });
  assert.match(prompt, /\/tmp\/pids\.txt/);
  assert.match(prompt, /PIDFILE/);
  assert.match(prompt, /Do NOT write \.guide\/runtime-qa\.json/);
});

test('handoff-creation guide prompt ALSO instructs writing .guide/qa-journeys.json from the Definition of done', async () => {
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rqa-handoff-'));
  fs.mkdirSync(path.join(projDir, '.guide', 'handoffs'), { recursive: true });
  const prompt = await buildGuidePrompt({
    task: 'handoff',
    projectName: 'demo',
    projDir,
    project: { current_phase: 3 },
    plan: { phases: [] },
  });
  assert.match(prompt, /\.guide\/qa-journeys\.json/);
  assert.match(prompt, /Definition of done/i);
});

// ─── Criterion 7: schema exists + ajv-compiles at load ───────────────────────

test('runtime-qa.schema.json loaded + the constants are well-formed', () => {
  assert.equal(RUNTIME_QA_SCHEMA.title, 'Runtime QA Verdict');
  assert.deepEqual(RUNTIME_QA_SCHEMA.required, ['journeys', 'blockers']);
  assert.ok(Object.isFrozen(RUNTIME_QA_ALLOWED_TOOLS));
  assert.deepEqual([...RUNTIME_QA_ALLOWED_TOOLS], ['Read', 'Glob', 'Grep', 'Bash']);
  assert.equal(typeof RUNTIME_QA_SYSTEM_PROMPT, 'string');
  assert.ok(RUNTIME_QA_SYSTEM_PROMPT.length > 100);
});
