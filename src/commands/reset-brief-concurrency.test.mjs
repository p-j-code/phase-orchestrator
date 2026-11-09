// Tests for the nb:go concurrency guard in handleNewbriefCallback.
//
// Verifies:
//   (a) rejection path — when getActiveAutoRun returns a running row, the handler
//       answers the callback with a "already running" alert and returns early.
//   (b) proceed path — when no active run exists, the handler calls
//       answerCallbackQuery('Resetting brief…') and editMessageText with the
//       "Resetting brief for" text before firing the pipeline fire-and-forget.
//
// Run with: node --test src/commands/reset-brief-concurrency.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Isolate DB per test run
const dbDir = mkdtempSync(path.join(tmpdir(), 'aorch-nb-concurrency-db-'));
process.env.DB_PATH = path.join(dbDir, 'test.db');
const projectsDir = mkdtempSync(path.join(tmpdir(), 'aorch-nb-concurrency-projects-'));

const { upsertProject, startAutoRun, getActiveAutoRun } = await import('../state.js');
const { handleNewbriefCallback } = await import('../server/telegram-parity-handlers.js');
const { nbSessions } = await import('../server/telegram-handlers.js');

let nextChatId = 9_000;

async function stageBrief(project) {
  const inputsDir = path.join(projectsDir, project, 'inputs');
  await mkdir(inputsDir, { recursive: true });
  await writeFile(path.join(inputsDir, 'brief.md'), '# Updated brief\n\nBuild the requested feature.\n');
}

function makeCtx(project) {
  const calls = { answerCallbackQuery: [], editMessageText: [], reply: [] };
  const chatId = nextChatId++;
  nbSessions.set(chatId, { projectName: project });
  return {
    chat: { id: chatId },
    from: { id: chatId },
    calls,
    answerCallbackQuery: async (opts) => { calls.answerCallbackQuery.push(opts); },
    editMessageText: async (text, opts) => { calls.editMessageText.push({ text, opts }); },
    reply: async (text, opts) => { calls.reply.push({ text, opts }); },
  };
}

test('rejection path: answerCallbackQuery with show_alert when pipeline already running', async () => {
  const project = 'nb-guard-reject';
  upsertProject({ name: project, tech_stack: 'node', profile: 'default', total_phases: 3, status: 'paused' });
  startAutoRun({ project, unattended: 0 });
  await stageBrief(project);

  // Confirm the DB lock is in place
  const activeRun = getActiveAutoRun(project);
  assert.ok(activeRun, 'getActiveAutoRun should return a running row');
  assert.equal(activeRun.status, 'running');

  const resetCalls = [];
  const ctx = makeCtx(project);
  await handleNewbriefCallback(ctx, ['go'], {
    projectsDir,
    resetBrief: async (...args) => { resetCalls.push(args); },
  });

  // answerCallbackQuery must have been called with show_alert
  assert.equal(ctx.calls.answerCallbackQuery.length, 1);
  const aqCall = ctx.calls.answerCallbackQuery[0];
  assert.equal(aqCall.show_alert, true);
  assert.ok(
    /already running/i.test(aqCall.text),
    `expected "already running" in answerCallbackQuery text, got: ${aqCall.text}`,
  );

  // editMessageText must have been called with the rejection message (not "Resetting brief")
  assert.equal(ctx.calls.editMessageText.length, 1);
  const emCall = ctx.calls.editMessageText[0];
  assert.ok(
    /already running/i.test(emCall.text),
    `expected "already running" in editMessageText, got: ${emCall.text}`,
  );
  assert.ok(
    !/resetting brief/i.test(emCall.text),
    'editMessageText should NOT contain "Resetting brief" on rejection path',
  );
  assert.equal(resetCalls.length, 0, 'rejection must not invoke resetBrief');
});

test('proceed path: answerCallbackQuery with "Resetting brief…" when no active run', async () => {
  const project = 'nb-guard-proceed';
  upsertProject({ name: project, tech_stack: 'node', profile: 'default', total_phases: 3, status: 'paused' });
  await stageBrief(project);

  // Confirm no active run
  const activeRun = getActiveAutoRun(project);
  assert.ok(!activeRun, 'should have no active run for clean project');

  const resetCalls = [];
  const ctx = makeCtx(project);
  await handleNewbriefCallback(ctx, ['go'], {
    projectsDir,
    resetBrief: async (...args) => { resetCalls.push(args); },
  });

  // answerCallbackQuery must have been called with "Resetting brief…" (the non-rejection path)
  assert.equal(ctx.calls.answerCallbackQuery.length, 1);
  const aqCall = ctx.calls.answerCallbackQuery[0];
  assert.ok(
    /resetting brief/i.test(aqCall.text),
    `expected "Resetting brief" in answerCallbackQuery text, got: ${aqCall.text}`,
  );
  assert.ok(!aqCall.show_alert, 'proceed path should NOT use show_alert');

  // editMessageText must reference the project and "Resetting brief"
  assert.equal(ctx.calls.editMessageText.length, 1);
  const emCall = ctx.calls.editMessageText[0];
  assert.ok(
    /resetting brief/i.test(emCall.text),
    `expected "Resetting brief" in editMessageText, got: ${emCall.text}`,
  );
  assert.deepEqual(resetCalls, [[project, { go: true, noArchive: false }]]);
});
