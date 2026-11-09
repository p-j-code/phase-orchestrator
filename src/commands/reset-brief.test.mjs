// Tests for reset-brief — copies inputs/brief.md → .guide/brief.md, archives
// the old brief + plan, rewinds current_phase to 0, optionally auto-runs.
//
// Run with: node --test src/commands/reset-brief.test.mjs
//
// Isolation: DB_PATH points at a tmp sqlite file (set before importing state.js,
// which lazily opens the DB on first use). resetBrief takes an injected
// projectsDir so it operates on a tmp projects tree, and an injected autoRun so
// the --go path can be observed without spawning the real pipeline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dbDir = mkdtempSync(path.join(tmpdir(), 'aorch-resetbrief-db-'));
process.env.DB_PATH = path.join(dbDir, 'test.db');

const { upsertProject, setProjectStatus, setCurrentPhase, getProject } = await import('../state.js');
const { resetBrief } = await import('./reset-brief.js');

// Build an isolated projects tree with one project's inputs/ + .guide/ seeded.
function makeProject(name, { inputsBrief, guideBrief = 'OLD GUIDE BRIEF', plan = true } = {}) {
  const projectsDir = mkdtempSync(path.join(tmpdir(), 'aorch-resetbrief-'));
  const projDir = path.join(projectsDir, name);
  mkdirSync(path.join(projDir, 'inputs'), { recursive: true });
  mkdirSync(path.join(projDir, '.guide'), { recursive: true });
  writeFileSync(path.join(projDir, 'inputs', 'brief.md'), inputsBrief);
  writeFileSync(path.join(projDir, '.guide', 'brief.md'), guideBrief);
  if (plan) {
    writeFileSync(path.join(projDir, '.guide', 'plan.json'), JSON.stringify({ phases: [{ n: 1 }] }));
    writeFileSync(path.join(projDir, '.guide', 'plan.md'), '# Old plan');
  }
  upsertProject({ name, tech_stack: 'node', profile: 'default', total_phases: 3, status: 'paused' });
  setCurrentPhase(name, 2);
  return { projectsDir, projDir };
}

test('archives old brief + plan, refreshes .guide/brief.md, rewinds phase to 0', async () => {
  const name = 'proj-archive';
  const { projectsDir, projDir } = makeProject(name, { inputsBrief: 'FRESH BRIEF CONTENT' });

  const res = await resetBrief(name, { projectsDir });

  // .guide/brief.md now mirrors the staged inputs brief
  assert.equal(readFileSync(path.join(projDir, '.guide', 'brief.md'), 'utf-8'), 'FRESH BRIEF CONTENT');

  // plan.json / plan.md deleted so the guide replans from scratch
  assert.ok(!existsSync(path.join(projDir, '.guide', 'plan.json')), 'plan.json removed');
  assert.ok(!existsSync(path.join(projDir, '.guide', 'plan.md')), 'plan.md removed');

  // archives of the previous brief + plan exist (never deletes originals first)
  const guideFiles = readdirSync(path.join(projDir, '.guide'));
  assert.ok(guideFiles.some(f => /^brief-archived-.*\.md$/.test(f)), 'archived brief present');
  assert.ok(guideFiles.some(f => /^plan-archived-.*\.json$/.test(f)), 'archived plan.json present');
  assert.ok(guideFiles.some(f => /^plan-archived-.*\.md$/.test(f)), 'archived plan.md present');
  assert.equal(res.archived.length, 3);

  // current_phase rewound to 0; total_phases untouched (NOT resetProjectForNewPlan)
  const p = getProject(name);
  assert.equal(p.current_phase, 0);
  assert.equal(p.total_phases, 3);
});

test('aborts on unresolved [NEEDS USER INPUT] markers without mutating state', async () => {
  const name = 'proj-unresolved';
  const { projectsDir, projDir } = makeProject(name, {
    inputsBrief: 'Intro\n[NEEDS USER INPUT: target market?]\nmore',
    guideBrief: 'UNTOUCHED GUIDE BRIEF',
  });

  await assert.rejects(resetBrief(name, { projectsDir }), /unresolved marker/i);

  // No mutation: guide brief unchanged, plan still present, phase still 2
  assert.equal(readFileSync(path.join(projDir, '.guide', 'brief.md'), 'utf-8'), 'UNTOUCHED GUIDE BRIEF');
  assert.ok(existsSync(path.join(projDir, '.guide', 'plan.json')), 'plan.json untouched');
  assert.equal(getProject(name).current_phase, 2);
});

test('aborts when the pipeline is in-progress without mutating state', async () => {
  const name = 'proj-inprogress';
  const { projectsDir, projDir } = makeProject(name, {
    inputsBrief: 'CLEAN BRIEF',
    guideBrief: 'UNTOUCHED GUIDE BRIEF',
  });
  setProjectStatus(name, 'in-progress');

  await assert.rejects(resetBrief(name, { projectsDir }), /currently running/i);

  assert.equal(readFileSync(path.join(projDir, '.guide', 'brief.md'), 'utf-8'), 'UNTOUCHED GUIDE BRIEF');
  assert.ok(existsSync(path.join(projDir, '.guide', 'plan.json')), 'plan.json untouched');
  assert.equal(getProject(name).current_phase, 2);
});

test('--go triggers autoRun unattended after a successful reset', async () => {
  const name = 'proj-go';
  const { projectsDir } = makeProject(name, { inputsBrief: 'GO BRIEF' });

  const calls = [];
  await resetBrief(name, {
    projectsDir,
    go: true,
    autoRun: async (args) => { calls.push(args); return { status: 'completed' }; },
  });

  assert.equal(calls.length, 1, 'autoRun called exactly once');
  assert.equal(calls[0].projectName, name);
  assert.equal(calls[0].unattended, true);
});

test('archives and removes suggestions.md when it exists', async () => {
  const name = 'proj-suggestions-archive';
  const { projectsDir, projDir } = makeProject(name, { inputsBrief: 'FRESH BRIEF' });
  writeFileSync(path.join(projDir, '.guide', 'suggestions.md'), '## Pass 1\n- old item');

  const res = await resetBrief(name, { projectsDir });

  // suggestions.md is gone
  assert.ok(!existsSync(path.join(projDir, '.guide', 'suggestions.md')), 'suggestions.md removed');

  // archived copy exists
  const guideFiles = readdirSync(path.join(projDir, '.guide'));
  assert.ok(
    guideFiles.some(f => /^suggestions-archived-.*\.md$/.test(f)),
    'suggestions-archived-*.md present',
  );

  // brief + plan.json + plan.md + suggestions.md = 4
  assert.equal(res.archived.length, 4);
});

test('--no-archive leaves suggestions.md in place (stale-file warning path)', async () => {
  const name = 'proj-no-archive-suggest';
  const { projectsDir, projDir } = makeProject(name, { inputsBrief: 'BRIEF' });
  writeFileSync(path.join(projDir, '.guide', 'suggestions.md'), '## Pass 1\n- old item');

  await resetBrief(name, { projectsDir, noArchive: true });

  // File is left in place — no backup was made so deletion would be unrecoverable
  assert.ok(
    existsSync(path.join(projDir, '.guide', 'suggestions.md')),
    'suggestions.md left in place with --no-archive',
  );

  // No archive file was created
  const guideFiles = readdirSync(path.join(projDir, '.guide'));
  assert.ok(
    !guideFiles.some(f => /^suggestions-archived/.test(f)),
    'no archived suggestions with --no-archive',
  );
});

test('--no-archive skips archiving and leaves plan files in place (not deleted)', async () => {
  const name = 'proj-no-archive';
  const { projectsDir, projDir } = makeProject(name, { inputsBrief: 'NO ARCHIVE BRIEF' });

  await resetBrief(name, { projectsDir, noArchive: true });

  // Brief was refreshed — the command's primary purpose still works
  assert.equal(
    readFileSync(path.join(projDir, '.guide', 'brief.md'), 'utf-8'),
    'NO ARCHIVE BRIEF',
  );

  // Plan files must still exist — --no-archive created no backup, so deletion would be unrecoverable
  assert.ok(
    existsSync(path.join(projDir, '.guide', 'plan.json')),
    'plan.json survives --no-archive (no backup was made)',
  );
  assert.ok(
    existsSync(path.join(projDir, '.guide', 'plan.md')),
    'plan.md survives --no-archive (no backup was made)',
  );

  // No archive files were created
  const guideFiles = readdirSync(path.join(projDir, '.guide'));
  assert.ok(
    !guideFiles.some(f => /^brief-archived/.test(f)),
    'no archived brief with --no-archive',
  );
  assert.ok(
    !guideFiles.some(f => /^plan-archived/.test(f)),
    'no archived plan with --no-archive',
  );

  // Phase counter was still reset — the command's core function unaffected
  assert.equal(getProject(name).current_phase, 0);
});

test('--no-archive + --go + stale plan throws before any mutation', async () => {
  const name = 'proj-noarchive-go-stale';
  const { projectsDir, projDir } = makeProject(name, {
    inputsBrief: 'FRESH BRIEF',
    guideBrief:  'OLD GUIDE BRIEF',
    // plan: true (default) — plan.json + plan.md exist
  });
  // Ensure current_phase is non-zero so we can verify it was NOT reset
  setCurrentPhase(name, 3);

  await assert.rejects(
    resetBrief(name, { projectsDir, noArchive: true, go: true }),
    /no-archive.*go|stale plan/i,
    'throws with a message mentioning --no-archive + --go or stale plan',
  );

  // .guide/brief.md must not have been overwritten (throw was pre-write)
  assert.equal(
    readFileSync(path.join(projDir, '.guide', 'brief.md'), 'utf-8'),
    'OLD GUIDE BRIEF',
    '.guide/brief.md unchanged after early throw',
  );

  // plan.json still exists (was not deleted)
  assert.ok(
    existsSync(path.join(projDir, '.guide', 'plan.json')),
    'plan.json still exists after early throw',
  );

  // current_phase was not reset (no DB mutation)
  assert.equal(getProject(name).current_phase, 3, 'current_phase not reset');
});

test('--no-archive + --go with no stale plan proceeds and calls autoRun', async () => {
  const name = 'proj-noarchive-go-noplan';
  const { projectsDir } = makeProject(name, {
    inputsBrief: 'FRESH BRIEF',
    plan: false,  // no plan.json — no stale file to block on
  });

  const calls = [];
  await resetBrief(name, {
    projectsDir,
    noArchive: true,
    go:        true,
    autoRun:   async (args) => { calls.push(args); return { status: 'completed' }; },
  });

  assert.equal(calls.length, 1, 'autoRun called once when no stale plan exists');
  assert.equal(calls[0].projectName, name);
  assert.equal(calls[0].unattended, true);
});
