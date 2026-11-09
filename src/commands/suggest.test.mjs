import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _reconcilePlan, writeSuggestionsFile, _parseManualMeta } from './suggest.js';

function items(...ids) {
  return ids.map(id => ({
    id, title: id, type: 'enhancement', category: 'logic',
    effort: 'small', impact: 'low', suggestedSlot: 1, appliesTo: [],
  }));
}

test('_reconcilePlan — no orphans: returns 0, plan unchanged', () => {
  const selected = items('a', 'b', 'c');
  const plan = { '1': ['a'], '2': ['b', 'c'] };
  const rescued = _reconcilePlan(selected, plan);
  assert.equal(rescued, 0);
  assert.deepEqual(plan['1'], ['a']);
  assert.deepEqual(plan['2'], ['b', 'c']);
});

test('_reconcilePlan — one orphan appended to pass 1', () => {
  const selected = items('a', 'b', 'c');
  const plan = { '1': ['a'], '2': ['b'] };
  const rescued = _reconcilePlan(selected, plan);
  assert.equal(rescued, 1);
  assert.ok(plan['1'].includes('c'), 'orphan "c" should land in pass 1');
  assert.equal(plan['2'].includes('c'), false, 'c should not also be in pass 2');
});

test('_reconcilePlan — multiple orphans all appended to pass 1', () => {
  const selected = items('a', 'b', 'c', 'd');
  const plan = { '1': ['a'], '2': ['b'] };
  const rescued = _reconcilePlan(selected, plan);
  assert.equal(rescued, 2);
  assert.ok(plan['1'].includes('c'));
  assert.ok(plan['1'].includes('d'));
});

test('_reconcilePlan — all items orphaned (empty passes): appended to lowest pass', () => {
  const selected = items('a', 'b');
  const plan = { '1': [], '2': [] };
  const rescued = _reconcilePlan(selected, plan);
  assert.equal(rescued, 2);
  assert.ok(plan['1'].includes('a'));
  assert.ok(plan['1'].includes('b'));
});

test('_reconcilePlan — repro: 4 items, 2 passes, user narrows pass 2', () => {
  const selected = items('A', 'B', 'C', 'D');
  const plan = { '1': ['A'], '2': ['B'] };
  const rescued = _reconcilePlan(selected, plan);
  assert.equal(rescued, 2);
  assert.ok(plan['1'].includes('C'));
  assert.ok(plan['1'].includes('D'));
  assert.ok(plan['1'].includes('A'));
  assert.ok(plan['2'].includes('B'));
  const all = new Set(Object.values(plan).flat());
  assert.equal(all.size, 4);
});

test('assignedCount matches plan after reconcile (Step N count check)', () => {
  const selected = items('a', 'b', 'c');
  const plan = { '1': ['a'], '2': ['b'] };
  _reconcilePlan(selected, plan);
  const assignedIds = new Set(Object.values(plan).flat());
  assert.equal(assignedIds.size, 3, 'after reconcile, assigned count must equal selected length');
});

// ─── writeSuggestionsFile — generatedAt ───────────────────────────────────────

const SAMPLE_SELECTED = [
  { id: 1, title: 'Export PDF', type: 'logic', effort: 'small', impact: 'high', manual: false },
  { id: 2, title: 'Dark Mode',  type: 'frontend', effort: 'small', impact: 'low',  manual: false },
];
const SAMPLE_PLAN  = { '1': [1], '2': [2] };
const SAMPLE_PASSES = 2;

function makeProjDir() {
  const root = mkdtempSync(path.join(tmpdir(), 'wsf-test-'));
  mkdirSync(path.join(root, '.guide'), { recursive: true });
  return root;
}

test('writeSuggestionsFile — no generatedAt → header uses current time', async () => {
  const dir = makeProjDir();
  const before = Date.now();
  await writeSuggestionsFile(dir, 'my-proj', SAMPLE_SELECTED, SAMPLE_PLAN, SAMPLE_PASSES);
  const after = Date.now();

  const content = readFileSync(path.join(dir, '.guide', 'suggestions.md'), 'utf-8');
  const match = content.match(/^# Suggestions Plan — my-proj — (.+)$/m);
  assert.ok(match, 'header line present');
  const headerDate = new Date(match[1]).getTime();
  assert.ok(headerDate >= before && headerDate <= after, 'header date is within the call window');

  rmSync(dir, { recursive: true });
});

test('writeSuggestionsFile — generatedAt provided → header uses that timestamp', async () => {
  const dir = makeProjDir();
  const fixedDate = '2026-01-15T10:00:00.000Z';
  await writeSuggestionsFile(dir, 'my-proj', SAMPLE_SELECTED, SAMPLE_PLAN, SAMPLE_PASSES, fixedDate);

  const content = readFileSync(path.join(dir, '.guide', 'suggestions.md'), 'utf-8');
  assert.ok(
    content.includes(`# Suggestions Plan — my-proj — ${fixedDate}`),
    'header contains the provided generatedAt timestamp',
  );

  rmSync(dir, { recursive: true });
});

test('writeSuggestionsFile — generatedAt=null → header uses current time (null is same as omitted)', async () => {
  const dir = makeProjDir();
  const before = Date.now();
  await writeSuggestionsFile(dir, 'my-proj', SAMPLE_SELECTED, SAMPLE_PLAN, SAMPLE_PASSES, null);
  const after = Date.now();

  const content = readFileSync(path.join(dir, '.guide', 'suggestions.md'), 'utf-8');
  const match = content.match(/^# Suggestions Plan — my-proj — (.+)$/m);
  assert.ok(match, 'header line present');
  const headerDate = new Date(match[1]).getTime();
  assert.ok(headerDate >= before && headerDate <= after, 'null generatedAt → header is current time');

  rmSync(dir, { recursive: true });
});

// ─── _parseManualMeta ──────────────────────────────────────────────────────────

test('_parseManualMeta — multi-bracket title keeps inner brackets intact', () => {
  const { title, effort, impact } = _parseManualMeta('Add [v2] dark mode [small/high]');
  assert.equal(title,  'Add [v2] dark mode');
  assert.equal(effort, 'small');
  assert.equal(impact, 'high');
});

test('_parseManualMeta — no meta token: title is the full input, defaults applied', () => {
  const { title, effort, impact } = _parseManualMeta('Refactor [legacy] parser');
  assert.equal(title,  'Refactor [legacy] parser');
  assert.equal(effort, 'medium');
  assert.equal(impact, 'high');
});

test('_parseManualMeta — basic single-bracket case still works', () => {
  const { title, effort, impact } = _parseManualMeta('Add dark mode [small/high]');
  assert.equal(title,  'Add dark mode');
  assert.equal(effort, 'small');
  assert.equal(impact, 'high');
});

test('_parseManualMeta — only meta token yields empty title (guard will reject it)', () => {
  const { title, effort, impact } = _parseManualMeta('[small/high]');
  assert.equal(title,  '');
  assert.equal(effort, 'small');
  assert.equal(impact, 'high');
});
