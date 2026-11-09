// Tests for phase-55 (P8 / par-08) — speculative Haiku scout for the NEXT
// phase, fired concurrently with the CURRENT phase's dev call. Covers:
//   A. buildPhaseScoutPrompt / PHASE_SCOUT_SYSTEM_PROMPT — pure prompt content
//   B. renderScoutNote / parseScoutNoteFiles / isScoutNoteStale — pure
//      front-matter + staleness-decision functions
//   C. loadPhaseScoutBlock — fail-open read/staleness-gate/consume-once
//      wrapper; default-off byte-identical regression
//   D. buildInlinePhasePrompt — scoutNote appended verbatim when present,
//      byte-identical output when absent (regression)
//   E. resolveScoutEligibility — enabled/next-phase/note-exists/baseSha gates
//   F. spawnPhaseScout — worktree pinning against a REAL temp git repo: spawn
//      args (read-only tools, role:null, sessionId:null, task/model), note
//      persistence with base_sha front-matter, worktree removed on both
//      success and a runClaude throw, the returned promise NEVER rejects,
//      empty reply writes no note
//   G. concurrency proof — spawnPhaseScout raced against a simulated slow dev
//      call via Promise.allSettled (the exact pattern auto-runner.js's main
//      loop uses) — timestamps prove overlap
//   H. source assertions — auto-runner.js's Promise.allSettled wiring order
//      and cfg.phases.scout.enabled gate; phase-runner.js's runDev call site
//
// No real `claude` subprocess is ever spawned.
//
// Run with: node --test src/lib/phase-scout.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.env.DB_PATH = ':memory:';

const {
  buildPhaseScoutPrompt, PHASE_SCOUT_SYSTEM_PROMPT,
  renderScoutNote, renderScoutNoteBlock, parseScoutNoteFiles, isScoutNoteStale,
  loadPhaseScoutBlock, buildInlinePhasePrompt,
} = await import('./phase-runner.js');
const { phaseScoutPath, worktreesRoot } = await import('./guide-paths.js');
const { getHeadSha } = await import('./git.js');
const { CHECKER_ALLOWED_TOOLS } = await import('./verify-loop.js');
const { spawnPhaseScout, resolveScoutEligibility } = await import('../auto-runner.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ─── shared fixture helpers ─────────────────────────────────────────────────

function makeProjDir(label) {
  const d = mkdtempSync(path.join(tmpdir(), `aorch-phase-scout-${label}-`));
  mkdirSync(path.join(d, '.guide'), { recursive: true });
  return d;
}

function makeRepo(label) {
  const projDir = makeProjDir(label);
  const workspaceDir = mkdtempSync(path.join(tmpdir(), `aorch-phase-scout-ws-${label}-`));
  execSync('git init -q', { cwd: workspaceDir });
  execSync('git config user.email t@example.com', { cwd: workspaceDir });
  execSync('git config user.name test', { cwd: workspaceDir });
  return { projDir, workspaceDir };
}

function commitPhase(workspaceDir, n, file, content) {
  writeFileSync(path.join(workspaceDir, file), content);
  execSync('git add -A', { cwd: workspaceDir });
  execSync(`git commit -q -m ${JSON.stringify(`phase-${n}: did stuff`)}`, { cwd: workspaceDir });
}

const NEXT_PHASE_META = {
  n: 6,
  title: 'Widget exporter',
  goal: 'Build the widget CSV exporter.',
  acceptance_criteria: ['Exports a valid CSV', 'Rejects malformed rows'],
  files_expected: ['backend/services/widgetExporter.js'],
};

const SAMPLE_NOTE_BODY = `## Files
- backend/services/widgetExporter.js — this phase's new exporter
- backend/lib/csv.js — shared CSV encoding helper

## Patterns to follow
Match the existing service module shape in backend/services/.

## Integration points
Called from backend/routes/widgets.js.
`;

// ─── A. buildPhaseScoutPrompt / PHASE_SCOUT_SYSTEM_PROMPT ──────────────────

test('buildPhaseScoutPrompt: names the NEXT phase, its criteria, and files, and forbids code/tests/fixes', () => {
  const prompt = buildPhaseScoutPrompt({ phaseMeta: NEXT_PHASE_META });
  assert.match(prompt, /Phase 6: Widget exporter/);
  assert.match(prompt, /Exports a valid CSV/);
  assert.match(prompt, /backend\/services\/widgetExporter\.js/);
  assert.match(prompt, /Do NOT write code, run tests, or propose fixes/);
  assert.match(prompt, /## Files/);
  assert.match(prompt, /## Patterns to follow/);
  assert.match(prompt, /## Integration points/);
});

test('buildPhaseScoutPrompt: pure — identical input produces byte-identical output', () => {
  const a = buildPhaseScoutPrompt({ phaseMeta: NEXT_PHASE_META });
  const b = buildPhaseScoutPrompt({ phaseMeta: { ...NEXT_PHASE_META } });
  assert.equal(a, b);
});

test('PHASE_SCOUT_SYSTEM_PROMPT: fixed literal — read-only, no-Write framing', () => {
  assert.match(PHASE_SCOUT_SYSTEM_PROMPT, /strictly read-only/);
  assert.match(PHASE_SCOUT_SYSTEM_PROMPT, /no Write, Edit, or unrestricted Bash/);
});

// ─── B. renderScoutNote / parseScoutNoteFiles / isScoutNoteStale ───────────

test('renderScoutNote: wraps the body in base_sha front-matter', () => {
  const rendered = renderScoutNote('abc1234', 'hello world');
  assert.equal(rendered, '---\nbase_sha: abc1234\n---\n\nhello world');
});

test('renderScoutNoteBlock: exact header text (byte-for-byte)', () => {
  const block = renderScoutNoteBlock({ sha8: 'deadbeef', noteBody: 'the note' });
  assert.equal(
    block,
    'Advance scout notes (computed at deadbeef, one phase ago -- verify before relying on them; files may have moved):\n\nthe note',
  );
});

test('parseScoutNoteFiles: extracts bare paths from the "## Files" section, stripping bullets and " — reason"', () => {
  const files = parseScoutNoteFiles(SAMPLE_NOTE_BODY);
  assert.deepEqual(files, ['backend/services/widgetExporter.js', 'backend/lib/csv.js']);
});

test('parseScoutNoteFiles: missing "## Files" section returns []', () => {
  assert.deepEqual(parseScoutNoteFiles('## Patterns to follow\nnothing\n'), []);
});

test('isScoutNoteStale: changed.ok:false (unresolvable/garbage-collected base_sha) is ALWAYS stale', () => {
  assert.equal(isScoutNoteStale({ noteFiles: ['a.js'], changed: { ok: false }, maxStalenessPct: 30 }), true);
});

test('isScoutNoteStale: no note files at all is never stale (nothing to check)', () => {
  assert.equal(isScoutNoteStale({ noteFiles: [], changed: { ok: true, files: ['x.js'] }, maxStalenessPct: 30 }), false);
});

test('isScoutNoteStale: exactly at the threshold does NOT drop (only STRICTLY over drops)', () => {
  // 1 of 2 files changed = 50%; threshold 50 -> not stale (equal, not over)
  const stale = isScoutNoteStale({
    noteFiles: ['a.js', 'b.js'],
    changed: { ok: true, files: ['a.js'] },
    maxStalenessPct: 50,
  });
  assert.equal(stale, false);
});

test('isScoutNoteStale: over the threshold drops', () => {
  const stale = isScoutNoteStale({
    noteFiles: ['a.js', 'b.js'],
    changed: { ok: true, files: ['a.js', 'b.js'] },
    maxStalenessPct: 30,
  });
  assert.equal(stale, true);
});

test('isScoutNoteStale: default threshold is 30 when maxStalenessPct is not finite', () => {
  // 1 of 3 = 33.3% > 30 default -> stale
  const stale = isScoutNoteStale({
    noteFiles: ['a.js', 'b.js', 'c.js'],
    changed: { ok: true, files: ['a.js'] },
    maxStalenessPct: undefined,
  });
  assert.equal(stale, true);
});

// ─── C. loadPhaseScoutBlock ──────────────────────────────────────────────────

test('loadPhaseScoutBlock: scout.enabled:false (default) returns null with NO fs read attempted', async () => {
  const projDir = makeProjDir('disabled');
  // Deliberately no note file on disk — if this ever tried to read it, it
  // would still resolve to null (readText fails open), so this alone isn't
  // proof of "no read attempted"; the real proof is the enabled gate running
  // BEFORE any fs call, verified by the source read in section H below.
  const result = await loadPhaseScoutBlock(projDir, '/tmp/does-not-matter', 6, { phases: { scout: { enabled: false } } });
  assert.equal(result, null);
});

test('loadPhaseScoutBlock: no note on disk yet returns null', async () => {
  const projDir = makeProjDir('no-note');
  const result = await loadPhaseScoutBlock(projDir, '/tmp/does-not-matter', 6, { phases: { scout: { enabled: true } } });
  assert.equal(result, null);
});

test('loadPhaseScoutBlock: malformed front-matter (no base_sha) drops AND deletes the note', async () => {
  const projDir = makeProjDir('malformed');
  const notePath = phaseScoutPath(projDir, 6);
  await fs.writeFile(notePath, 'not a valid note at all', 'utf-8');
  const result = await loadPhaseScoutBlock(projDir, '/tmp/does-not-matter', 6, { phases: { scout: { enabled: true } } });
  assert.equal(result, null);
  assert.equal(existsSync(notePath), false, 'malformed note is deleted');
});

test('loadPhaseScoutBlock: a fresh note under the staleness threshold is injected with the exact header, then consumed (deleted)', async () => {
  const projDir = makeProjDir('fresh');
  const notePath = phaseScoutPath(projDir, 6);
  await fs.writeFile(notePath, renderScoutNote('deadbeef1234', SAMPLE_NOTE_BODY), 'utf-8');
  let seenSha = null;
  const changedFilesSince = async (ws, sha) => { seenSha = sha; return { ok: true, files: [] }; };
  const block = await loadPhaseScoutBlock(projDir, '/some/workspace', 6, { phases: { scout: { enabled: true, max_staleness_pct: 30 } } }, { changedFilesSince });
  assert.equal(seenSha, 'deadbeef1234');
  assert.match(block, /^Advance scout notes \(computed at deadbeef, one phase ago -- verify before relying on them; files may have moved\):\n\n/);
  assert.match(block, /widgetExporter\.js/);
  assert.equal(existsSync(notePath), false, 'consume-once — note deleted after successful injection');
});

test('loadPhaseScoutBlock: a stale note (over max_staleness_pct) is dropped AND deleted — no block returned', async () => {
  const projDir = makeProjDir('stale');
  const notePath = phaseScoutPath(projDir, 6);
  await fs.writeFile(notePath, renderScoutNote('cafebabe0000', SAMPLE_NOTE_BODY), 'utf-8');
  // Both note files reported changed -> 100% staleness, over any positive threshold.
  const changedFilesSince = async () => ({
    ok: true,
    files: ['backend/services/widgetExporter.js', 'backend/lib/csv.js'],
  });
  const block = await loadPhaseScoutBlock(projDir, '/some/workspace', 6, { phases: { scout: { enabled: true, max_staleness_pct: 30 } } }, { changedFilesSince });
  assert.equal(block, null);
  assert.equal(existsSync(notePath), false, 'stale note is deleted, never resurfaces on a later call');
});

// ─── D. buildInlinePhasePrompt — scoutNote injection / byte-identical regression ─

const PHASE_META = {
  n: 6, title: 'Widget exporter', goal: 'Build the widget CSV exporter.',
  acceptance_criteria: ['Exports a valid CSV'], files_expected: ['backend/services/widgetExporter.js'],
};
const PLAN = { phases: [PHASE_META] };

test('buildInlinePhasePrompt: scoutNote absent (omitted or null) is byte-identical', () => {
  const withoutParam = buildInlinePhasePrompt({
    projectName: 'demo', phaseMeta: PHASE_META, plan: PLAN, projDir: '/proj', workspaceDir: '/proj/workspace',
  });
  const withNull = buildInlinePhasePrompt({
    projectName: 'demo', phaseMeta: PHASE_META, plan: PLAN, projDir: '/proj', workspaceDir: '/proj/workspace', scoutNote: null,
  });
  assert.equal(withoutParam, withNull);
  assert.doesNotMatch(withoutParam, /Advance scout notes/);
});

test('buildInlinePhasePrompt: a present scoutNote is appended verbatim after the Commit line', () => {
  const note = 'Advance scout notes (computed at deadbeef, one phase ago -- verify before relying on them; files may have moved):\n\nsome note body';
  const withNote = buildInlinePhasePrompt({
    projectName: 'demo', phaseMeta: PHASE_META, plan: PLAN, projDir: '/proj', workspaceDir: '/proj/workspace', scoutNote: note,
  });
  assert.ok(withNote.endsWith(note));
  assert.ok(withNote.includes(`<one-line summary>\n\n${note}`));
});

// ─── E. resolveScoutEligibility ─────────────────────────────────────────────

async function makePlanDir(label, plan) {
  const projDir = makeProjDir(label);
  await fs.writeFile(path.join(projDir, '.guide', 'plan.json'), JSON.stringify(plan, null, 2), 'utf-8');
  return projDir;
}

test('resolveScoutEligibility: scout.enabled:false -> null (no plan/HEAD read needed)', async () => {
  const result = await resolveScoutEligibility({
    cfg: { phases: { scout: { enabled: false } } },
    projDir: '/does/not/exist', workspaceDir: '/does/not/exist', action: { kind: 'dev', phaseN: 5 },
  });
  assert.equal(result, null);
});

test('resolveScoutEligibility: no phase after action.phaseN in the plan -> null', async () => {
  const projDir = await makePlanDir('no-next', { phases: [{ n: 5, title: 'Last phase' }] });
  const result = await resolveScoutEligibility({
    cfg: { phases: { scout: { enabled: true } } },
    projDir, workspaceDir: '/does/not/matter', action: { kind: 'dev', phaseN: 5 },
  });
  assert.equal(result, null);
});

test('resolveScoutEligibility: a scout note already exists for the next phase -> null (never re-fires)', async () => {
  const projDir = await makePlanDir('note-exists', { phases: [{ n: 5 }, { n: 6, title: 'Next' }] });
  await fs.writeFile(phaseScoutPath(projDir, 6), renderScoutNote('deadbeef', 'x'), 'utf-8');
  const result = await resolveScoutEligibility({
    cfg: { phases: { scout: { enabled: true } } },
    projDir, workspaceDir: '/does/not/matter', action: { kind: 'dev', phaseN: 5 },
  });
  assert.equal(result, null);
});

test('resolveScoutEligibility: eligible — resolves nextPhaseMeta and the CURRENT (pre-dev) baseSha', async () => {
  const { projDir, workspaceDir } = makeRepo('eligible');
  commitPhase(workspaceDir, 5, 'a.js', 'x\n');
  const headSha = await getHeadSha(workspaceDir);
  await fs.writeFile(path.join(projDir, '.guide', 'plan.json'), JSON.stringify({
    phases: [{ n: 5 }, { n: 6, title: 'Next Phase' }],
  }), 'utf-8');

  const result = await resolveScoutEligibility({
    cfg: { phases: { scout: { enabled: true } } },
    projDir, workspaceDir, action: { kind: 'dev', phaseN: 5 },
  });
  assert.ok(result);
  assert.equal(result.phaseN, 5);
  assert.equal(result.nextPhaseMeta.n, 6);
  assert.equal(result.baseSha, headSha);
});

// ─── F. spawnPhaseScout — worktree pinning + persistence (real git repo) ───

test('spawnPhaseScout: pins the worktree to baseSha even if the live workspace advances mid-call, and passes a read-only/role-null/haiku spawn', async () => {
  const { projDir, workspaceDir } = makeRepo('spawn-args');
  commitPhase(workspaceDir, 5, 'a.js', 'const a = 1;\n');
  const baseSha = await getHeadSha(workspaceDir);

  let seenArgs = null;
  let headDuringCall = null;
  const runClaude = async (args) => {
    seenArgs = args;
    headDuringCall = await getHeadSha(args.cwd);
    // The live workspace advances WHILE the scout is "running".
    commitPhase(workspaceDir, 6, 'a.js', 'const a = 2;\n');
    return { result: SAMPLE_NOTE_BODY };
  };

  await spawnPhaseScout({
    cfg: { models: { 'phase-scout': 'claude-haiku-4-5' }, tools: { allowed_default: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'] } },
    projectName: 'demo', projDir, workspaceDir, phaseN: 5, baseSha, nextPhaseMeta: NEXT_PHASE_META,
  }, { runClaude });

  assert.equal(headDuringCall, baseSha, 'the pinned worktree reads baseSha, not any later commit');
  assert.equal(seenArgs.role, null);
  assert.equal(seenArgs.sessionId, null);
  assert.equal(seenArgs.task, 'phase-scout');
  assert.equal(seenArgs.phase, 6);
  assert.equal(seenArgs.systemPromptFile, null);
  assert.equal(seenArgs.cfg.model, 'claude-haiku-4-5');
  assert.deepEqual(seenArgs.cfg.tools.allowed_default, [...CHECKER_ALLOWED_TOOLS]);
  assert.ok(!seenArgs.cfg.tools.allowed_default.includes('Write'));
  assert.ok(!seenArgs.cfg.tools.allowed_default.includes('Edit'));

  const wtDir = path.join(worktreesRoot(projDir), `scout-6-${baseSha.slice(0, 8)}`);
  assert.ok(!existsSync(wtDir), 'worktree removed after settle');
});

test('spawnPhaseScout: persists the note with base_sha front-matter at phaseScoutPath(projDir, nextPhaseMeta.n)', async () => {
  const { projDir, workspaceDir } = makeRepo('persist');
  commitPhase(workspaceDir, 5, 'a.js', 'x\n');
  const baseSha = await getHeadSha(workspaceDir);

  await spawnPhaseScout({
    cfg: {}, projectName: 'demo', projDir, workspaceDir, phaseN: 5, baseSha, nextPhaseMeta: NEXT_PHASE_META,
  }, { runClaude: async () => ({ result: SAMPLE_NOTE_BODY }) });

  const notePath = phaseScoutPath(projDir, 6);
  const written = readFileSync(notePath, 'utf-8');
  assert.equal(written, renderScoutNote(baseSha, SAMPLE_NOTE_BODY.trim()));
});

test('spawnPhaseScout: the worktree is removed even when runClaude THROWS, and the returned promise never rejects', async () => {
  const { projDir, workspaceDir } = makeRepo('throw');
  commitPhase(workspaceDir, 5, 'a.js', 'x\n');
  const baseSha = await getHeadSha(workspaceDir);
  const wtDir = path.join(worktreesRoot(projDir), `scout-6-${baseSha.slice(0, 8)}`);

  await assert.doesNotReject(spawnPhaseScout({
    cfg: {}, projectName: 'demo', projDir, workspaceDir, phaseN: 5, baseSha, nextPhaseMeta: NEXT_PHASE_META,
  }, { runClaude: async () => { throw new Error('scout boom'); } }));

  assert.ok(!existsSync(wtDir), 'worktree removed despite the throw (finally still ran)');
  assert.ok(!existsSync(phaseScoutPath(projDir, 6)), 'no note written on failure');
});

test('spawnPhaseScout: an empty reply writes no note (and does not throw)', async () => {
  const { projDir, workspaceDir } = makeRepo('empty-reply');
  commitPhase(workspaceDir, 5, 'a.js', 'x\n');
  const baseSha = await getHeadSha(workspaceDir);

  await spawnPhaseScout({
    cfg: {}, projectName: 'demo', projDir, workspaceDir, phaseN: 5, baseSha, nextPhaseMeta: NEXT_PHASE_META,
  }, { runClaude: async () => ({ result: '   ' }) });

  assert.ok(!existsSync(phaseScoutPath(projDir, 6)));
});

test('spawnPhaseScout: a worktree-add failure (bogus baseSha) degrades — no throw, no note', async () => {
  const { projDir, workspaceDir } = makeRepo('bogus-sha');
  commitPhase(workspaceDir, 5, 'a.js', 'x\n');

  await assert.doesNotReject(spawnPhaseScout({
    cfg: {}, projectName: 'demo', projDir, workspaceDir, phaseN: 5, baseSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', nextPhaseMeta: NEXT_PHASE_META,
  }, { runClaude: async () => { throw new Error('should never be called'); } }));

  assert.ok(!existsSync(phaseScoutPath(projDir, 6)));
});

// ─── G. concurrency proof ───────────────────────────────────────────────────

test('spawnPhaseScout overlaps a concurrent "dev" call when raced via Promise.allSettled (the exact pattern auto-runner.js uses)', async () => {
  const { projDir, workspaceDir } = makeRepo('concurrency');
  commitPhase(workspaceDir, 5, 'a.js', 'x\n');
  const baseSha = await getHeadSha(workspaceDir);

  const events = [];
  const scoutRunClaude = async () => {
    events.push(['scout-start', Date.now()]);
    await new Promise((r) => setTimeout(r, 40));
    events.push(['scout-end', Date.now()]);
    return { result: SAMPLE_NOTE_BODY };
  };
  const fakeDevAction = async () => {
    events.push(['dev-start', Date.now()]);
    await new Promise((r) => setTimeout(r, 40));
    events.push(['dev-end', Date.now()]);
    return { is_error: false };
  };

  const [devSettled, scoutSettled] = await Promise.allSettled([
    fakeDevAction(),
    spawnPhaseScout({
      cfg: {}, projectName: 'demo', projDir, workspaceDir, phaseN: 5, baseSha, nextPhaseMeta: NEXT_PHASE_META,
    }, { runClaude: scoutRunClaude }),
  ]);

  assert.equal(devSettled.status, 'fulfilled');
  assert.equal(scoutSettled.status, 'fulfilled');
  const at = Object.fromEntries(events);
  assert.ok(at['scout-start'] < at['dev-end'], 'scout started before the dev action finished');
  assert.ok(at['dev-start'] < at['scout-end'], 'dev started before the scout finished — genuine overlap, not sequential');
});

test('a scout that THROWS never affects the dev result when raced via Promise.allSettled', async () => {
  const { projDir, workspaceDir } = makeRepo('scout-throws');
  commitPhase(workspaceDir, 5, 'a.js', 'x\n');
  const baseSha = await getHeadSha(workspaceDir);

  const fakeDevAction = async () => ({ is_error: false, result: 'phase 5 done' });
  const [devSettled, scoutSettled] = await Promise.allSettled([
    fakeDevAction(),
    spawnPhaseScout({
      cfg: {}, projectName: 'demo', projDir, workspaceDir, phaseN: 5, baseSha, nextPhaseMeta: NEXT_PHASE_META,
    }, { runClaude: async () => { throw new Error('scout boom'); } }),
  ]);

  assert.equal(devSettled.status, 'fulfilled');
  assert.equal(devSettled.value.result, 'phase 5 done');
  assert.equal(scoutSettled.status, 'fulfilled', 'spawnPhaseScout degrades internally — never rejects');
});

// ─── H. source assertions — wiring order ────────────────────────────────────

const autoRunnerSrc = readFileSync(fileURLToPath(new URL('../auto-runner.js', import.meta.url)), 'utf-8');
const phaseRunnerSrc = readFileSync(fileURLToPath(new URL('./phase-runner.js', import.meta.url)), 'utf-8');

test('auto-runner: dev action + scout fire via a single Promise.allSettled call (structural concurrency proof)', () => {
  const idx = autoRunnerSrc.indexOf('const [devSettled, scoutSettledResult] = await Promise.allSettled([');
  assert.ok(idx > -1, 'anchor found');
  const block = autoRunnerSrc.slice(idx, idx + 400);
  assert.match(block, /executeAction\(action, \{ projectName, brief, cfg, notifier, slot: resolvedSlot, runId \}\),/);
  assert.match(block, /spawnPhaseScout\(\{ cfg, projectName, projDir, workspaceDir, \.\.\.scoutEligibility \}\),/);
});

test('auto-runner: a dev action\'s own rejection is rethrown UNCHANGED from the scout race (same catch-block routing as before)', () => {
  const idx = autoRunnerSrc.indexOf("if (devSettled.status === 'rejected') throw devSettled.reason;");
  assert.ok(idx > -1);
});

test('auto-runner: scoutEligibility is resolved via cfg.phases.scout.enabled, gated to dev actions only', () => {
  assert.match(autoRunnerSrc, /const scoutEligibility = action\.kind === 'dev'\s*\n\s*\? await resolveScoutEligibility\(\{ cfg, projDir, workspaceDir, action \}\)\s*\n\s*: null;/);
});

test('auto-runner: resolveScoutEligibility gates on phases.scout.enabled === true (not truthy)', () => {
  assert.match(autoRunnerSrc, /if \(cfg\.phases\?\.scout\?\.enabled !== true\) return null;/);
});

test('auto-runner: a scout rejection is only ever logged, never thrown', () => {
  const idx = autoRunnerSrc.indexOf("if (scoutSettled?.status === 'rejected') {");
  assert.ok(idx > -1);
  const block = autoRunnerSrc.slice(idx, idx + 200);
  assert.match(block, /console\.log\(chalk\.dim/);
});

test('phase-runner.js: runDev\'s inline-prompt branch loads the scout note BEFORE building the prompt', () => {
  const idx = phaseRunnerSrc.indexOf('const scoutNote = await loadPhaseScoutBlock(projDir, workspaceDir, nextPhase, cfg);');
  assert.ok(idx > -1, 'anchor found');
  const block = phaseRunnerSrc.slice(idx, idx + 300);
  assert.match(block, /buildInlinePhasePrompt\(\{ projectName, phaseMeta, plan, projDir, workspaceDir, hasConventions, scoutNote \}\)/);
});

test('config/defaults.json: phases.scout ships enabled:false, models["phase-scout"] is haiku, and phase-scout is absent from model-routing escalation_tasks', async () => {
  const defaults = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'config', 'defaults.json'), 'utf-8'));
  assert.equal(defaults.phases.scout.enabled, false);
  assert.equal(typeof defaults.phases.scout.max_staleness_pct, 'number');
  assert.equal(defaults.models['phase-scout'], 'claude-haiku-4-5');
  assert.equal(defaults.phases.task_max_turns['phase-scout'], 15);
  assert.equal(defaults.phases.task_timeout_ms['phase-scout'], 240000);

  const routing = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'config', 'model-routing.json'), 'utf-8'));
  assert.ok(!(routing.escalation_tasks || []).includes('phase-scout'));
});
