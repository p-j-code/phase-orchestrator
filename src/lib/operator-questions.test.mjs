// Tests for Phase 49 (P6 operator answer loop) — src/lib/operator-questions.js.
//
// Run with: node --test src/lib/operator-questions.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DB_PATH = ':memory:';

const {
  addOperatorQuestion, listOperatorQuestions, upsertProject, upsertPhase, markPhaseCompleted,
} = await import('../state.js');
const {
  buildOqCallbackData, renderOperatorQuestionText, buildOperatorQuestionKeyboard,
  operatorQuestionsTick, startOperatorQuestionsPoller, stopOperatorQuestionsPoller,
  isOperatorQuestionsPollerRunning, getOperatorQuestionById, resolveAnswerFromToken,
  resolveOperatorQuestion, findPhasesSinceQuestion, buildContradictionFollowupText,
  OQ_ASSUME_TOKEN, OPERATOR_ANSWER_MAX_CHARS,
} = await import('./operator-questions.js');
const { validateDecision, parseDecisionsJsonl } = await import('./decisions-schema.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeFakeNotifier() {
  const calls = [];
  return {
    calls,
    async notify(payload) { calls.push(payload); return { delivered: 1 }; },
  };
}

async function makeFixtureProjectsDir() {
  const projectsDir = mkdtempSync(path.join(tmpdir(), 'aorch-oq-'));
  return projectsDir;
}

function setupProject(name, projectsDir) {
  upsertProject({ name, tech_stack: 'node', total_phases: 3 });
  mkdirSync(path.join(projectsDir, name, '.guide'), { recursive: true });
}

// ─── buildOqCallbackData ────────────────────────────────────────────────────

test('buildOqCallbackData: oq:<id>:<index> form, well under 64 bytes', () => {
  const data = buildOqCallbackData(42, 0);
  assert.equal(data, 'oq:42:0');
  assert.ok(Buffer.byteLength(data, 'utf8') <= 64);
});

test('buildOqCallbackData: oq:<id>:assume form', () => {
  assert.equal(buildOqCallbackData(42, OQ_ASSUME_TOKEN), 'oq:42:assume');
});

test('buildOqCallbackData: throws when a pathological token pushes past 64 bytes', () => {
  assert.throws(() => buildOqCallbackData(1, 'x'.repeat(70)));
});

// ─── renderOperatorQuestionText / buildOperatorQuestionKeyboard ────────────

test('buildOperatorQuestionKeyboard: one button per option + trailing Confirm assumption, all callback_data <=64 bytes', () => {
  const row = { id: 7, options: JSON.stringify(['Option A', 'Option B']), assumption: 'proceeding as X' };
  const kb = buildOperatorQuestionKeyboard(row);
  assert.equal(kb.inline_keyboard.length, 3); // 2 options + assume
  assert.equal(kb.inline_keyboard[0][0].callback_data, 'oq:7:0');
  assert.equal(kb.inline_keyboard[1][0].callback_data, 'oq:7:1');
  assert.equal(kb.inline_keyboard[2][0].callback_data, 'oq:7:assume');
  for (const [btn] of kb.inline_keyboard) {
    assert.ok(Buffer.byteLength(btn.callback_data, 'utf8') <= 64);
  }
});

test('renderOperatorQuestionText: HTML-escapes question/assumption/project', () => {
  const row = { id: 1, project: '<proj>', phase: 3, question: 'Use <b>X</b>?', assumption: 'Yes & proceeding' };
  const text = renderOperatorQuestionText(row);
  assert.ok(text.includes('&lt;proj&gt;'));
  assert.ok(text.includes('&lt;b&gt;X&lt;/b&gt;'));
  assert.ok(text.includes('Yes &amp; proceeding'));
});

// ─── operatorQuestionsTick ──────────────────────────────────────────────────

test('operatorQuestionsTick: notifies each open question exactly once; second tick sends nothing', async () => {
  const project = `oq-tick-${Date.now()}`;
  upsertProject({ name: project, tech_stack: 'node', total_phases: 1 });
  addOperatorQuestion({ project, phase: 1, question: 'Q1?', assumption: 'A1' });
  addOperatorQuestion({ project, phase: 1, question: 'Q2?', assumption: 'A2' });

  const notifier = makeFakeNotifier();
  const notified1 = await operatorQuestionsTick({ cfg: {}, notifier });
  assert.equal(notified1.length, 2);
  assert.equal(notifier.calls.length, 2);

  const rows = listOperatorQuestions({ project });
  assert.ok(rows.every((r) => !!r.notified_at));

  const notified2 = await operatorQuestionsTick({ cfg: {}, notifier });
  assert.equal(notified2.length, 0);
  assert.equal(notifier.calls.length, 2); // unchanged — no new sends
});

test('operatorQuestionsTick: includeButtons true attaches replyMarkup, false omits it', async () => {
  const project = `oq-buttons-${Date.now()}`;
  upsertProject({ name: project, tech_stack: 'node', total_phases: 1 });
  addOperatorQuestion({ project, phase: 1, question: 'Q?', assumption: 'A', options: ['x', 'y'] });

  const withButtons = makeFakeNotifier();
  await operatorQuestionsTick({ cfg: {}, notifier: withButtons, includeButtons: true });
  assert.ok(withButtons.calls[0].replyMarkup);

  const project2 = `oq-nobuttons-${Date.now()}`;
  upsertProject({ name: project2, tech_stack: 'node', total_phases: 1 });
  addOperatorQuestion({ project: project2, phase: 1, question: 'Q?', assumption: 'A', options: ['x', 'y'] });
  const noButtons = makeFakeNotifier();
  await operatorQuestionsTick({ cfg: {}, notifier: noButtons, includeButtons: false });
  assert.equal(noButtons.calls[0].replyMarkup, undefined);
});

test('operatorQuestionsTick: operator_questions.enabled:false sends nothing', async () => {
  const project = `oq-disabled-${Date.now()}`;
  upsertProject({ name: project, tech_stack: 'node', total_phases: 1 });
  addOperatorQuestion({ project, phase: 1, question: 'Q?', assumption: 'A' });
  const notifier = makeFakeNotifier();
  const notified = await operatorQuestionsTick({ cfg: { operator_questions: { enabled: false } }, notifier });
  assert.equal(notified.length, 0);
  assert.equal(notifier.calls.length, 0);
});

// ─── poller lifecycle ───────────────────────────────────────────────────────

test('startOperatorQuestionsPoller: enabled:false registers no interval', () => {
  stopOperatorQuestionsPoller();
  startOperatorQuestionsPoller({ cfg: { operator_questions: { enabled: false } }, notifier: makeFakeNotifier() });
  assert.equal(isOperatorQuestionsPollerRunning(), false);
});

test('startOperatorQuestionsPoller: default/enabled registers an interval; stop clears it', () => {
  stopOperatorQuestionsPoller();
  startOperatorQuestionsPoller({ intervalMs: 3_600_000, cfg: {}, notifier: makeFakeNotifier() });
  assert.equal(isOperatorQuestionsPollerRunning(), true);
  stopOperatorQuestionsPoller();
  assert.equal(isOperatorQuestionsPollerRunning(), false);
});

// ─── resolveAnswerFromToken ─────────────────────────────────────────────────

test('resolveAnswerFromToken: numeric index resolves option text; assume resolves the assumption; unknown → null', () => {
  const row = { options: JSON.stringify(['Alpha', 'Beta']), assumption: 'the assumption text' };
  assert.equal(resolveAnswerFromToken(row, '0'), 'Alpha');
  assert.equal(resolveAnswerFromToken(row, '1'), 'Beta');
  assert.equal(resolveAnswerFromToken(row, OQ_ASSUME_TOKEN), 'the assumption text');
  assert.equal(resolveAnswerFromToken(row, '5'), null);
  assert.equal(resolveAnswerFromToken(row, 'garbage'), null);
});

// ─── resolveOperatorQuestion (answer round-trip + idempotence + contradiction) ──

test('resolveOperatorQuestion: marks answered, appends one schema-valid decision, second resolve is a no-op', async () => {
  const projectsDir = await makeFixtureProjectsDir();
  const project = `oq-resolve-${Date.now()}`;
  setupProject(project, projectsDir);

  const id = addOperatorQuestion({ project, phase: 5, question: 'Proceed with X?', assumption: 'proceeding with X' });

  const first = await resolveOperatorQuestion({ id, answer: 'proceeding with X', answeredBy: 555 }, { projectsDir });
  assert.equal(first.found, true);
  assert.equal(first.applied, true);
  assert.equal(first.row.status, 'answered');
  assert.equal(first.row.answered_by, 555);
  assert.equal(first.contradiction, false);

  const decisionsPath = path.join(projectsDir, project, '.guide', 'decisions.jsonl');
  const content = await fs.readFile(decisionsPath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(validateDecision(entry), true);
  assert.ok(entry.decision.includes(`OPERATOR ANSWER to question #${id}: proceeding with X`));

  // Second resolve on the same (now-answered) question: no double-write.
  const second = await resolveOperatorQuestion({ id, answer: 'a different answer', answeredBy: 999 }, { projectsDir });
  assert.equal(second.applied, false);
  const contentAfter = await fs.readFile(decisionsPath, 'utf-8');
  assert.equal(contentAfter, content); // byte-identical — no second append
  const rowAfter = getOperatorQuestionById(id);
  assert.equal(rowAfter.answer, 'proceeding with X'); // unchanged by the second call
});

test('resolveOperatorQuestion: contradiction (answer != assumption) is flagged with a retry-phase followup; matching answer is not', async () => {
  const projectsDir = await makeFixtureProjectsDir();
  const project = `oq-contradict-${Date.now()}`;
  setupProject(project, projectsDir);

  const idMatch = addOperatorQuestion({ project, phase: 1, question: 'Q?', assumption: '  same answer  ' });
  const matchResult = await resolveOperatorQuestion({ id: idMatch, answer: 'same answer' }, { projectsDir });
  assert.equal(matchResult.contradiction, false);
  assert.equal(matchResult.followupText, null);

  const idDiff = addOperatorQuestion({ project, phase: 1, question: 'Q2?', assumption: 'assumption A' });
  await sleep(5);
  upsertPhase({ project, n: 2, title: 'phase two', status: 'completed' });
  markPhaseCompleted({ project, n: 2, commit_sha: 'deadbeef' });
  const diffResult = await resolveOperatorQuestion({ id: idDiff, answer: 'assumption B' }, { projectsDir });
  assert.equal(diffResult.contradiction, true);
  assert.ok(diffResult.followupText.includes('retry-phase'));
  assert.ok(diffResult.followupText.includes(String(2)));
});

test('resolveOperatorQuestion: rejects oversized answers without closing the question', async () => {
  const projectsDir = await makeFixtureProjectsDir();
  const project = `oq-long-${Date.now()}`;
  setupProject(project, projectsDir);
  const id = addOperatorQuestion({ project, question: 'Q?', assumption: 'A' });
  await assert.rejects(
    resolveOperatorQuestion({ id, answer: 'x'.repeat(OPERATOR_ANSWER_MAX_CHARS + 1) }, { projectsDir }),
    (err) => err.code === 'OPERATOR_ANSWER_TOO_LONG',
  );
  assert.equal(getOperatorQuestionById(id).status, 'open');
});

test('resolveOperatorQuestion: a decision-file failure compensates the DB answer', async () => {
  const projectsDir = await makeFixtureProjectsDir();
  const project = `oq-compensate-${Date.now()}`;
  upsertProject({ name: project, tech_stack: 'node', total_phases: 1 });
  // Deliberately do not create projects/<name>/.guide, so the durable decision
  // append fails after the conditional DB update.
  const id = addOperatorQuestion({ project, question: 'Q?', assumption: 'A' });
  await assert.rejects(
    resolveOperatorQuestion({ id, answer: 'B' }, { projectsDir }),
    (err) => err.compensated === true,
  );
  const row = getOperatorQuestionById(id);
  assert.equal(row.status, 'open');
  assert.equal(row.answer, null);
  assert.equal(row.answered_at, null);
});

test('findPhasesSinceQuestion: only phases completed AFTER created_at are included', async () => {
  const project = `oq-phases-${Date.now()}`;
  upsertProject({ name: project, tech_stack: 'node', total_phases: 3 });

  upsertPhase({ project, n: 1, title: 'before', status: 'completed' });
  markPhaseCompleted({ project, n: 1, commit_sha: 'aaa' });
  await sleep(5);

  const createdAt = new Date().toISOString();
  await sleep(5);

  upsertPhase({ project, n: 2, title: 'after', status: 'completed' });
  markPhaseCompleted({ project, n: 2, commit_sha: 'bbb' });

  const since = findPhasesSinceQuestion(project, createdAt);
  assert.deepEqual(since, [2]);
});

test('buildContradictionFollowupText: names the project, the assumption, and a retry-phase command per affected phase', () => {
  const row = { id: 9, project: 'demo', assumption: 'X' };
  const text = buildContradictionFollowupText(row, [3, 4]);
  assert.ok(text.includes('retry-phase'));
  assert.ok(text.includes('demo'));
  assert.ok(text.includes('3'));
  assert.ok(text.includes('4'));
});

test('validateDecision / parseDecisionsJsonl accept the resolveOperatorQuestion-authored entry shape', async () => {
  const projectsDir = await makeFixtureProjectsDir();
  const project = `oq-schema-${Date.now()}`;
  setupProject(project, projectsDir);
  const id = addOperatorQuestion({ project, phase: 2, question: 'Q?', assumption: 'Ass.' });
  await resolveOperatorQuestion({ id, answer: 'Ass.' }, { projectsDir });
  const content = await fs.readFile(path.join(projectsDir, project, '.guide', 'decisions.jsonl'), 'utf-8');
  const parsed = parseDecisionsJsonl(content);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].type, 'deferral');
});
