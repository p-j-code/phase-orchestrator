// Tests for Phase 49 (P6 operator answer loop) — the oq:<id>:<index|assume>
// callback branch in handleCallback and the /oq <id> <answer…> free-text
// command, both in src/server/telegram-handlers.js.
//
// Run with: node --test src/server/telegram-handlers.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DB_PATH = ':memory:';

const { addOperatorQuestion, upsertProject } = await import('../state.js');
const { addUser } = await import('./job-queue.js');
const { handleCallback, handleOperatorQuestion } = await import('./telegram-handlers.js');
const { validateDecision } = await import('../lib/decisions-schema.js');

const USER_ID = 424242;
addUser({ telegramUserId: USER_ID, handle: 'oq-tester', label: 'test' });

function makeCallbackCtx(data) {
  const calls = { answerCallbackQuery: [], editMessageText: [], reply: [] };
  return {
    _calls: calls,
    from: { id: USER_ID },
    callbackQuery: { data },
    answerCallbackQuery(opts) { calls.answerCallbackQuery.push(opts); return Promise.resolve(); },
    editMessageText(text, opts) { calls.editMessageText.push({ text, opts }); return Promise.resolve(); },
    reply(text, opts) { calls.reply.push({ text, opts }); return Promise.resolve(); },
  };
}

function makeCommandCtx(text) {
  const calls = { reply: [] };
  return {
    _calls: calls,
    from: { id: USER_ID },
    message: { text },
    reply(t, opts) { calls.reply.push({ text: t, opts }); return Promise.resolve(); },
  };
}

// telegram-handlers.js resolves .guide/decisions.jsonl relative to its own
// hardcoded REPO_ROOT/projects — but operator-questions.js's resolveOperatorQuestion
// (which it delegates to) uses that SAME real PROJECTS_DIR with no override seam
// exposed at the handler layer. So we exercise these tests against a REAL,
// disposable project folder under projects/ and remove it afterward, rather
// than a temp dir outside the repo.
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

async function setupProject(name) {
  upsertProject({ name, tech_stack: 'node', total_phases: 1 });
  const projDir = path.join(PROJECTS_DIR, name);
  await fs.mkdir(path.join(projDir, '.guide'), { recursive: true });
  return projDir;
}

async function cleanupProject(name) {
  await fs.rm(path.join(PROJECTS_DIR, name), { recursive: true, force: true }).catch(() => {});
}

async function readDecisions(projDir) {
  try {
    return (await fs.readFile(path.join(projDir, '.guide', 'decisions.jsonl'), 'utf-8')).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

test('oq callback: button answer marks the question answered, appends one schema-valid decision, edits the message', async () => {
  const project = `tgh-oq-${Date.now()}`;
  const projDir = await setupProject(project);
  try {
    const id = addOperatorQuestion({ project, phase: 3, question: 'Proceed with plan A?', assumption: 'plan A', options: ['plan A', 'plan B'] });

    const ctx = makeCallbackCtx(`oq:${id}:0`); // answers with options[0] = 'plan A' (matches assumption)
    await handleCallback(ctx);

    assert.equal(ctx._calls.answerCallbackQuery.length, 1);
    assert.equal(ctx._calls.answerCallbackQuery[0].text, '✓ Recorded');
    assert.equal(ctx._calls.editMessageText.length, 1);
    assert.ok(ctx._calls.editMessageText[0].text.includes('Resolved'));

    const lines = await readDecisions(projDir);
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(validateDecision(entry), true);
    assert.ok(entry.decision.includes(`OPERATOR ANSWER to question #${id}: plan A`));
  } finally {
    await cleanupProject(project);
  }
});

test('oq callback: a second click on the same question does not double-append and reports already answered', async () => {
  const project = `tgh-oq-double-${Date.now()}`;
  const projDir = await setupProject(project);
  try {
    const id = addOperatorQuestion({ project, phase: 1, question: 'Q?', assumption: 'A' });

    const ctx1 = makeCallbackCtx(`oq:${id}:assume`);
    await handleCallback(ctx1);
    const linesAfterFirst = await readDecisions(projDir);
    assert.equal(linesAfterFirst.length, 1);

    const ctx2 = makeCallbackCtx(`oq:${id}:assume`);
    await handleCallback(ctx2);
    assert.equal(ctx2._calls.answerCallbackQuery[0].text, 'Already answered.');
    const linesAfterSecond = await readDecisions(projDir);
    assert.equal(linesAfterSecond.length, 1); // unchanged
  } finally {
    await cleanupProject(project);
  }
});

test('oq callback: contradiction (answer != assumption) sends exactly one follow-up reply containing retry-phase; a matching answer sends none', async () => {
  const project = `tgh-oq-contra-${Date.now()}`;
  await setupProject(project);
  try {
    const idMatch = addOperatorQuestion({ project, phase: 1, question: 'Q1?', assumption: 'same text' });
    const ctxMatch = makeCallbackCtx(`oq:${idMatch}:assume`); // 'assume' always equals the assumption
    await handleCallback(ctxMatch);
    assert.equal(ctxMatch._calls.reply.length, 0);

    const idDiff = addOperatorQuestion({ project, phase: 1, question: 'Q2?', assumption: 'assumption text', options: ['a different answer'] });
    const ctxDiff = makeCallbackCtx(`oq:${idDiff}:0`);
    await handleCallback(ctxDiff);
    assert.equal(ctxDiff._calls.reply.length, 1);
    assert.ok(ctxDiff._calls.reply[0].text.includes('retry-phase'));
  } finally {
    await cleanupProject(project);
  }
});

test('oq callback: unknown question id answers with an alert, not a throw', async () => {
  const ctx = makeCallbackCtx('oq:999999999:0');
  await handleCallback(ctx);
  assert.equal(ctx._calls.answerCallbackQuery[0].show_alert, true);
});

test('/oq command: free-text answer records and confirms', async () => {
  const project = `tgh-oq-cmd-${Date.now()}`;
  const projDir = await setupProject(project);
  try {
    const id = addOperatorQuestion({ project, phase: 2, question: 'Q?', assumption: 'A' });
    const ctx = makeCommandCtx(`/oq ${id} free text answer here`);
    await handleOperatorQuestion(ctx);
    assert.ok(ctx._calls.reply[0].text.includes(`#${id}`));
    const lines = await readDecisions(projDir);
    assert.equal(lines.length, 1);
    assert.ok(JSON.parse(lines[0]).decision.includes('free text answer here'));
  } finally {
    await cleanupProject(project);
  }
});

test('/oq command: usage message on missing args', async () => {
  const ctx = makeCommandCtx('/oq');
  await handleOperatorQuestion(ctx);
  assert.ok(ctx._calls.reply[0].text.startsWith('Usage:'));
});
