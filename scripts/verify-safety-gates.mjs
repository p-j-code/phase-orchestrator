#!/usr/bin/env node
// verify-safety-gates.mjs — one smoke script for the P44→P49 safety-gate cycle.
// Exercises each layer end-to-end, offline and deterministic (no LLM, no
// network, no real state DB — an in-memory DB + temp dirs):
//
//   1. Ship gate (phase-44)        — a hardcoded secret in a diff is flagged a
//                                     blocker; a process.env placeholder is not.
//   2. Deny-rule merge (phase-45)  — config rules + the always-on git-push rule
//                                     merge additively, foreign keys preserved,
//                                     and a re-merge is byte-identical (idempotent).
//   3. Brief conformance (phase-47)— two runs on an UNCHANGED brief persist a
//                                     stable brief_hash (the key auto-runner skips
//                                     on) and never accumulate duplicate bug rows.
//   4. Operator answer loop (P48/49)— a recorded question answered via
//                                     resolveOperatorQuestion marks the row
//                                     answered, appends ONE schema-valid decision,
//                                     flags the assumption contradiction, and a
//                                     second resolve is a no-op.
//
// Run: node scripts/verify-safety-gates.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Isolate: a throwaway in-memory DB, set BEFORE any state.js import so getDb()
// never opens (or migrates) the real orchestrator database.
process.env.DB_PATH = ':memory:';

let pass = 0, fail = 0;
const ok  = (l) => { console.log('OK  ', l); pass++; };
const bad = (l, e) => { console.log('FAIL', l + (e ? `\n     ${e?.stack || e?.message || e}` : '')); fail++; };

const { scanSecrets } = await import('../src/lib/ship-gate.js');
const { mergeDenyRules, PUSH_DENY_RULE } = await import('../src/lib/workspace-skills.js');
const { runBriefConformance } = await import('../src/lib/brief-conformance.js');
const { addOperatorQuestion, listBugs, upsertProject } = await import('../src/state.js');
const { resolveOperatorQuestion } = await import('../src/lib/operator-questions.js');
const { validateDecision } = await import('../src/lib/decisions-schema.js');

// ── 1. Ship gate: fixture secret is a blocker; placeholder is not ────────────
try {
  const diff = [
    'diff --git a/config.js b/config.js',
    '+++ b/config.js',
    '+const AWS_KEY = "AKIAJQ4PZ2R9WL6XN3KT";', // AKIA + 16 = an aws-access-key
  ].join('\n');
  const findings = scanSecrets(diff);
  assert.ok(findings.some((f) => f.kind === 'aws-access-key'), 'expected an aws-access-key finding');

  const placeholder = '+++ b/config.js\n+const AWS_KEY = process.env.AWS_KEY;\n';
  assert.equal(scanSecrets(placeholder).length, 0, 'process.env placeholder must not trip the scan');
  ok('1: ship gate flags a hardcoded AWS key and ignores a process.env placeholder');
} catch (e) { bad('1: ship gate secret scan', e); }

// ── 2. Deny-rule merge: additive, foreign-key-preserving, idempotent ─────────
try {
  const existing = { permissions: { deny: ['Bash(rm -rf /*)'] }, hooks: { keep: true } };
  const workspaceDir = '/tmp/aorch-vsg-ws';
  const merged = mergeDenyRules(existing, ['Read(../../config/**)'], { workspaceDir });

  assert.ok(merged.permissions.deny.includes('Bash(rm -rf /*)'), 'foreign deny rule preserved');
  assert.ok(merged.permissions.deny.includes('Read(../../config/**)'), 'config deny rule appended');
  assert.ok(merged.permissions.deny.includes(PUSH_DENY_RULE), 'always-on git-push rule present');
  assert.deepEqual(merged.hooks, { keep: true }, 'unrelated keys untouched');

  const twice = mergeDenyRules(merged, ['Read(../../config/**)'], { workspaceDir });
  assert.deepEqual(twice, merged, 're-merge must be byte-identical (idempotent)');
  ok('2: deny-rule merge is additive, preserves foreign keys, and is idempotent');
} catch (e) { bad('2: deny-rule merge', e); }

// ── 3. Brief conformance: stable hash + no duplicate bug rows on re-run ───────
try {
  const projectsDir = mkdtempSync(path.join(tmpdir(), 'aorch-vsg-conf-'));
  const project = 'vsg-conf';
  upsertProject({ name: project, tech_stack: 'node', total_phases: 1 });
  const projDir = path.join(projectsDir, project);
  await fs.mkdir(path.join(projDir, '.guide'), { recursive: true });
  await fs.writeFile(path.join(projDir, '.guide', 'brief.md'), '# Brief\n\nFR-1: do the thing\n', 'utf-8');

  const plan = { phases: [{ n: 1, title: 'phase one' }] };
  // Injected checker: no LLM, no network — always returns one MISSING FR.
  const verdictJson = JSON.stringify({
    frs: [{ id: 'FR-1', requirement: 'do the thing', status: 'missing', notes: 'no evidence in code' }],
    summary: 'one FR missing',
  });
  const deps = { runClaude: async () => ({ result: verdictJson, session_id: 's1' }), getPhases: () => [] };
  const cfg = { models: {}, tools: {}, brief_conformance: { enabled: true, block_on_missing: true, fail_open: true } };

  const r1 = await runBriefConformance({ cfg, projectName: project, projDir, workspaceDir: projDir, plan }, deps);
  const r2 = await runBriefConformance({ cfg, projectName: project, projDir, workspaceDir: projDir, plan }, deps);

  const persisted = JSON.parse(await fs.readFile(path.join(projDir, '.guide', 'brief-conformance.json'), 'utf-8'));
  assert.ok(typeof persisted.brief_hash === 'string' && persisted.brief_hash.length > 0, 'brief_hash persisted');
  assert.equal(r1.verdict.brief_hash, r2.verdict.brief_hash, 'brief_hash stable across runs on an unchanged brief');

  const bugs = listBugs({ project });
  assert.equal(bugs.length, 1, `two conformance runs must dedup to ONE bug row (got ${bugs.length})`);
  ok('3: brief conformance keeps a stable hash and never accumulates duplicate bug rows on re-run');
} catch (e) { bad('3: brief conformance skip-on-hash / dedup', e); }

// ── 4. Operator question insert → answer round-trip ──────────────────────────
try {
  const projectsDir = mkdtempSync(path.join(tmpdir(), 'aorch-vsg-oq-'));
  const project = 'vsg-oq';
  upsertProject({ name: project, tech_stack: 'node', total_phases: 1 });
  await fs.mkdir(path.join(projectsDir, project, '.guide'), { recursive: true });

  const id = addOperatorQuestion({ project, phase: 1, question: 'Proceed with X?', assumption: 'proceeding with X' });
  const first = await resolveOperatorQuestion({ id, answer: 'use Y instead', answeredBy: 7 }, { projectsDir });
  assert.equal(first.applied, true, 'first resolve applies');
  assert.equal(first.row.status, 'answered', 'row marked answered');
  assert.equal(first.row.answered_by, 7, 'answered_by recorded');
  assert.equal(first.contradiction, true, 'answer != assumption → contradiction flagged');
  assert.ok(first.followupText.includes('retry-phase'), 'contradiction followup recommends retry-phase');

  const decisionsPath = path.join(projectsDir, project, '.guide', 'decisions.jsonl');
  const lines = (await fs.readFile(decisionsPath, 'utf-8')).trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'exactly one decision appended');
  const entry = JSON.parse(lines[0]);
  assert.equal(validateDecision(entry), true, 'decision is schema-valid');
  assert.ok(entry.decision.includes(`OPERATOR ANSWER to question #${id}: use Y instead`), 'decision text shaped correctly');

  const second = await resolveOperatorQuestion({ id, answer: 'a different answer', answeredBy: 8 }, { projectsDir });
  assert.equal(second.applied, false, 'second resolve is a no-op');
  const linesAfter = (await fs.readFile(decisionsPath, 'utf-8')).trim().split('\n').filter(Boolean);
  assert.equal(linesAfter.length, 1, 'no second decision appended');
  ok('4: operator question round-trip records once, decision is schema-valid, second resolve is a no-op');
} catch (e) { bad('4: operator question round-trip', e); }

console.log(`\nverify-safety-gates: ${pass}/${pass + fail}`);
process.exit(fail > 0 ? 1 : 0);
