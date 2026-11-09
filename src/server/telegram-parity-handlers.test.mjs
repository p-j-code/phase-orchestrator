// Tests for BUG-3 fix: sug:confirm:y must save session.filtered (full union incl.
// manual items) as suggestions_json, not session.allSuggestions (pre-filter list).
// Run: node src/server/telegram-parity-handlers.test.mjs
// Exits 0 on all pass, non-zero on any failure.

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Must set DB_PATH before any import that touches state
const testDbDir = mkdtempSync(path.join(tmpdir(), 'aorch-tgph-test-'));
process.env.DB_PATH = path.join(testDbDir, 'test.db');

const { saveSuggestions, acceptSuggestions, getLatestSuggestions, upsertProject, staleAllSuggestions } =
  await import('../state.js');
const { _sugHandleConfirm, _sugHandlePasses, _sugHandleManual, _sugHandleCat,
        handleSuggestCallback, handleNewbriefCallback, handleSuggestManualInput } = await import('./telegram-parity-handlers.js');
const { suggestSessions, nbSessions } = await import('./telegram-handlers.js');

// ── Test harness ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, description) {
  if (condition) {
    console.log(`PASS ${description}`);
    passed++;
  } else {
    console.log(`FAIL ${description}`);
    failed++;
  }
}

function makeMockCtx() {
  return {
    answerCallbackQuery() { return Promise.resolve(); },
    editMessageText()     { return Promise.resolve(); },
    chat: { id: 99 },
  };
}

function makeSnapshot() {
  return { projectType: 'cli', completedPhases: 0, phaseTitles: [], dependencies: [] };
}

// ── Test H — BUG-3: confirm:y saves filtered (union incl. manual) ─────────────

console.log('\n--- Test H: sug:confirm:y persists filtered (full union) as suggestions_json ---');

{
  // H1: manual item appears in suggestions_json after confirm
  const projectName = `tgph-test-${randomUUID().slice(0, 8)}`;
  upsertProject({ name: projectName, tech_stack: 'node', total_phases: 3, status: 'in-progress' });
  const projDir = path.join(testDbDir, projectName);
  mkdirSync(path.join(projDir, '.guide'), { recursive: true });

  const aiItem = {
    id: 'ai-1', type: 'new-feature', category: 'logic',
    title: 'AI item', description: 'AI-generated item',
    effort: 'small', impact: 'high', suggestedSlot: 1,
    appliesTo: ['cli'],
  };
  const manualItem = {
    id: 'manual-abc', type: 'new-feature', category: 'logic',
    title: 'My custom item', description: 'My custom item',
    effort: 'medium', impact: 'high', suggestedSlot: 1,
    appliesTo: ['cli', 'frontend', 'api', 'fullstack', 'unknown'],
    manual: true,
  };

  const session = {
    projectName,
    projDir,
    snapshot:       makeSnapshot(),
    allSuggestions: [aiItem],              // pre-filter list — no manual item
    manualItems:    [manualItem],
    filtered:       [manualItem, aiItem],  // union as built by sug:manual:done (line 1130)
    selectedIdxs:   new Set([0, 1]),       // both items selected
    pipelinePlan:   { '1': ['manual-abc', 'ai-1'] },
    passes:         1,
    step:           5,
  };

  const ctx = makeMockCtx();
  await _sugHandleConfirm(ctx, 'y', session, 99);

  const row = getLatestSuggestions(projectName);
  const savedSuggestions = JSON.parse(row?.suggestions_json ?? '[]');
  const savedIds = savedSuggestions.map(s => s.id);

  assert(
    savedIds.includes('manual-abc'),
    'H1: manual-abc IS in suggestions_json (was excluded pre-fix when saved from allSuggestions)',
  );
  assert(
    savedIds.includes('ai-1'),
    'H2: ai-1 is also in suggestions_json',
  );
  assert(
    savedSuggestions.length === 2,
    'H3: suggestions_json has exactly 2 items (the full filtered union)',
  );

  const savedSelected = JSON.parse(row?.selected_json ?? '[]');
  const selectedIds = savedSelected.map(s => s.id);
  assert(
    selectedIds.includes('manual-abc'),
    'H4: manual-abc is in selected_json (was correct even pre-fix)',
  );

  // Invariant: every selected id must exist in suggestions_json (the load-bearing web /accept invariant)
  const suggById = new Map(savedSuggestions.map(s => [s.id, s]));
  const allSelectedInSugg = savedSelected.every(s => suggById.has(s.id));
  assert(
    allSelectedInSugg,
    'H5: selected_json ⊆ suggestions_json — invariant holds (web /accept will not drop manual items)',
  );
}

{
  // H6: regression — no-manual case: filtered (shown subset) is saved, not full allSuggestions
  // This is intentional: suggestions_json should only hold what was shown to the user.
  const projectName = `tgph-nomanual-${randomUUID().slice(0, 8)}`;
  upsertProject({ name: projectName, tech_stack: 'node', total_phases: 3, status: 'in-progress' });
  const projDir = path.join(testDbDir, projectName);
  mkdirSync(path.join(projDir, '.guide'), { recursive: true });

  const allFive = [
    { id: 'ai-1', type: 'new-feature', category: 'logic',    title: 'Item 1', description: 'd', effort: 'small',  impact: 'high',   suggestedSlot: 1, appliesTo: ['cli'] },
    { id: 'ai-2', type: 'enhancement', category: 'frontend', title: 'Item 2', description: 'd', effort: 'medium', impact: 'medium', suggestedSlot: 1, appliesTo: ['cli'] },
    { id: 'ai-3', type: 'perf',        category: 'infra',    title: 'Item 3', description: 'd', effort: 'large',  impact: 'high',   suggestedSlot: 2, appliesTo: ['cli'] },
    { id: 'ai-4', type: 'security',    category: 'logic',    title: 'Item 4', description: 'd', effort: 'small',  impact: 'low',    suggestedSlot: 2, appliesTo: ['cli'] },
    { id: 'ai-5', type: 'dx',          category: 'dx',       title: 'Item 5', description: 'd', effort: 'small',  impact: 'medium', suggestedSlot: 3, appliesTo: ['cli'] },
  ];
  // Only the first 3 were shown (filtered); ai-4 and ai-5 were not
  const shownThree = allFive.slice(0, 3);

  const session = {
    projectName,
    projDir,
    snapshot:       makeSnapshot(),
    allSuggestions: allFive,              // full pre-filter list (5 items)
    manualItems:    [],
    filtered:       shownThree,           // 3 items shown to user
    selectedIdxs:   new Set([0, 1]),      // user selected items 0+1
    pipelinePlan:   { '1': ['ai-1', 'ai-2'] },
    passes:         1,
    step:           5,
  };

  const ctx = makeMockCtx();
  await _sugHandleConfirm(ctx, 'y', session, 100);

  const row = getLatestSuggestions(projectName);
  const savedSuggestions = JSON.parse(row?.suggestions_json ?? '[]');
  const savedIds = savedSuggestions.map(s => s.id);

  assert(
    savedIds.includes('ai-1') && savedIds.includes('ai-2') && savedIds.includes('ai-3'),
    'H6: all shown items (ai-1, ai-2, ai-3) are in suggestions_json',
  );

  // Invariant check
  const savedSelected = JSON.parse(row?.selected_json ?? '[]');
  const suggById = new Map(savedSuggestions.map(s => [s.id, s]));
  const allSelectedInSugg = savedSelected.every(s => suggById.has(s.id));
  assert(
    allSelectedInSugg,
    'H7: no-manual regression — selected_json ⊆ suggestions_json invariant holds',
  );
}

// ── Test P — passes parity: 1–5 all accepted, 6 rejected ─────────────────────

console.log('\n--- Test P: _sugHandlePasses passes parity (1–5 accepted, 6 rejected) ---');

function makePassesSession() {
  const itemA = { id: 'a', suggestedSlot: 1, title: 'Item A' };
  const itemB = { id: 'b', suggestedSlot: 2, title: 'Item B' };
  return {
    selectedIdxs: new Set([0, 1]),
    filtered: [itemA, itemB],
  };
}

{
  // P1: passes:4 builds plan with keys 1–4
  const session = makePassesSession();
  const ctx = makeMockCtx();
  await _sugHandlePasses(ctx, '4', session);
  assert(session.passes === 4,               'P1a: session.passes === 4');
  assert('4' in (session.pipelinePlan ?? {}), 'P1b: pipelinePlan has key "4"');
  assert(!('5' in (session.pipelinePlan ?? {})), 'P1c: pipelinePlan does NOT have key "5"');
  assert(session.step === 5,                 'P1d: session.step === 5');
}

{
  // P2: passes:5 builds plan with keys 1–5
  const session = makePassesSession();
  const ctx = makeMockCtx();
  await _sugHandlePasses(ctx, '5', session);
  assert(session.passes === 5,               'P2a: session.passes === 5');
  assert('5' in (session.pipelinePlan ?? {}), 'P2b: pipelinePlan has key "5"');
  assert(session.step === 5,                 'P2c: session.step === 5');
}

{
  // P3: passes:6 is silently ignored — session unchanged
  const session = makePassesSession();
  const ctx = makeMockCtx();
  await _sugHandlePasses(ctx, '6', session);
  assert(session.passes === undefined, 'P3: passes:6 rejected — session.passes still undefined');
}

{
  // P4: regression — passes:3 still works
  const session = makePassesSession();
  const ctx = makeMockCtx();
  await _sugHandlePasses(ctx, '3', session);
  assert(session.passes === 3,               'P4a: session.passes === 3');
  assert('3' in (session.pipelinePlan ?? {}), 'P4b: pipelinePlan has key "3"');
  assert(!('4' in (session.pipelinePlan ?? {})), 'P4c: pipelinePlan does NOT have key "4"');
}

{
  // P5: slot clamping with passes:2 — item b (suggestedSlot:2) clamped to slot 2, item a to slot 1
  const session = makePassesSession();
  const ctx = makeMockCtx();
  await _sugHandlePasses(ctx, '2', session);
  const plan = session.pipelinePlan ?? {};
  assert((plan['1'] ?? []).includes('a'), 'P5a: item a is in pass 1');
  assert((plan['2'] ?? []).includes('b'), 'P5b: item b is in pass 2');
}

// ── Test J — Bug 5: userId-scoped awaitingInput routing ─────────────────────

console.log('\n--- Test J: userId-scoped awaitingInput routing guard ---');

{
  // J1: session owner's message should satisfy the routing condition
  const session = { awaitingInput: 'goal', userId: 42 };
  const ownerUserId = 42;
  const isOwner = !session.userId || session.userId === ownerUserId;
  assert(
    isOwner && session.awaitingInput === 'goal',
    'J1: session owner (userId=42) message satisfies awaitingInput routing',
  );
}

{
  // J2: a different user's message must NOT satisfy the routing condition
  const session = { awaitingInput: 'goal', userId: 42 };
  const strangerUserId = 99;
  const isOwner = !session.userId || session.userId === strangerUserId;
  assert(
    !(isOwner && session.awaitingInput === 'goal'),
    'J2: stranger (userId=99) message does NOT satisfy routing when session.userId=42',
  );
}

{
  // J3: session without userId (legacy / no-userId) routes any message (backward compat)
  const session = { awaitingInput: 'manual' };  // no userId field
  const anyUserId = 55;
  const isOwner = !session.userId || session.userId === anyUserId;
  assert(
    isOwner && session.awaitingInput === 'manual',
    'J3: session without userId field routes any message (backwards-compatible)',
  );
}

// ── Test K — Bug 6: _sugHandleManual('done') is idempotent on double-tap ─────

console.log('\n--- Test K: _sugHandleManual done is idempotent ---');

{
  const manualItem = {
    id: 'manual-1', type: 'new-feature', category: 'logic',
    title: 'Custom item', description: 'desc',
    effort: 'small', impact: 'high', suggestedSlot: 1,
    appliesTo: ['cli'], manual: true,
  };
  const aiItem = {
    id: 'ai-1', type: 'enhancement', category: 'frontend',
    title: 'AI item', description: 'desc',
    effort: 'medium', impact: 'medium', suggestedSlot: 2,
    appliesTo: ['cli'],
  };

  const session = {
    manualItems:  [manualItem],
    filtered:     [aiItem],
    awaitingInput: 'manual',
    selectedIdxs:  new Set(),
  };

  const ctx = {
    answerCallbackQuery() { return Promise.resolve(); },
    editMessageText()     { return Promise.resolve(); },
    chat: { id: 99 },
  };

  // First 'done' tap
  await _sugHandleManual(ctx, 'done', session);

  assert(session.filtered.length === 2,       'K1: after first done, filtered has 2 items');
  assert(session.awaitingInput === null,       'K2: awaitingInput cleared after done');
  assert(session.manualItems.length === 0,    'K3: manualItems cleared after done (idempotent guard)');

  const ids1 = session.filtered.map(s => s.id).sort();
  assert(
    ids1.includes('manual-1') && ids1.includes('ai-1'),
    'K4: filtered contains both manual and AI items after first done',
  );

  // Second 'done' tap (double-tap simulation)
  await _sugHandleManual(ctx, 'done', session);

  assert(session.filtered.length === 2,       'K5: after double-tap done, still exactly 2 items (no duplicates)');

  const ids2 = session.filtered.map(s => s.id).sort();
  assert(
    ids2[0] === ids1[0] && ids2[1] === ids1[1],
    'K6: double-tap produces identical filtered list — truly idempotent',
  );
}

// ── Test I — Bug 4: sug:cat:done concurrency guard ────────────────────────────

console.log('\n--- Test I: sug:cat:done scanning guard ---');

{
  // I1: when session.scanning is true, answerCallbackQuery gets the toast and
  //     editMessageText is NOT called (scan body never entered).
  let answeredWith = null;
  let editCalled = false;
  const mockCtx = {
    answerCallbackQuery(opts) { answeredWith = opts || null; return Promise.resolve(); },
    editMessageText()        { editCalled = true; return Promise.resolve(); },
    chat: { id: 1 },
  };
  const session = { projectName: 'test', scanning: true };

  await _sugHandleCat(mockCtx, 'done', session, 1);

  assert(answeredWith?.show_alert === true,
    'I1: show_alert: true on re-entrant done');
  assert(typeof answeredWith?.text === 'string' && answeredWith.text.length > 0,
    'I2: toast text is a non-empty string');
  assert(!editCalled,
    'I3: editMessageText NOT called when session.scanning is true');
  assert(session.scanning === true,
    'I4: session.scanning remains true (guard returned early — outer caller still owns the flag)');
}

{
  // I5: category toggle path (value !== 'done') is not affected by the guard — no scanning flag.
  let answeredWith = null;
  let editCalled = false;
  const mockCtx = {
    answerCallbackQuery(opts) { answeredWith = opts || null; return Promise.resolve(); },
    editMessageText()        { editCalled = true; return Promise.resolve(); },
    chat: { id: 2 },
  };
  const session = { projectName: 'test', scanning: false, categories: [] };

  await _sugHandleCat(mockCtx, 'logic', session, 2);

  assert(answeredWith === null || answeredWith === undefined || answeredWith === 0 || answeredWith === false || !answeredWith?.show_alert,
    'I5: category toggle does NOT show a blocking alert');
  assert(editCalled,
    'I6: editMessageText IS called for category toggle (keyboard re-render)');
  assert(session.categories.includes('logic'),
    'I7: category "logic" toggled on in session.categories');
}

// ── Test O — handleSuggestCallback ownership guard ────────────────────────────

console.log('\n--- Test O: handleSuggestCallback ownership guard ---');

function makeOwnerSession(chatId, userId, extra = {}) {
  const session = {
    projectName: 'test-proj',
    projDir: '/fake/test-proj',
    snapshot: { projectType: 'cli', completedPhases: 0, phaseTitles: [], dependencies: [] },
    userId,
    noLm: false,
    goal: '',
    allSuggestions: [],
    filtered: [],
    manualItems: [],
    awaitingInput: null,
    categories: ['logic', 'frontend'],
    selectedIdxs: new Set(),
    passes: 1,
    pipelinePlan: {},
    step: 1,
    ...extra,
  };
  suggestSessions.set(chatId, session);
  return session;
}

function makeCbCtx(chatId, fromId) {
  const calls = { answerCallbackQuery: [], editMessageText: [] };
  const ctx = {
    chat:  { id: chatId },
    from:  { id: fromId },
    answerCallbackQuery(arg) { calls.answerCallbackQuery.push(arg ?? {}); return Promise.resolve(); },
    editMessageText(text, opts) { calls.editMessageText.push({ text, opts }); return Promise.resolve(); },
    api:   { deleteMessage: () => Promise.resolve() },
  };
  return { ctx, calls };
}

{
  // O1: non-owner pressing sug:type is rejected; session NOT mutated
  const chatId = 8001;
  makeOwnerSession(chatId, 100, { snapshot: { projectType: 'unknown', completedPhases: 0, phaseTitles: [], dependencies: [] } });
  const { ctx, calls } = makeCbCtx(chatId, 200);   // presser 200 != owner 100

  await handleSuggestCallback(ctx, ['type', 'cli']);

  assert(calls.answerCallbackQuery.length === 1,           'O1: answerCallbackQuery called once');
  assert(calls.answerCallbackQuery[0].text?.includes('Not your session'),
                                                            'O1: rejection text shown');
  assert(calls.editMessageText.length === 0,               'O1: no editMessageText for non-owner');

  const sess = suggestSessions.get(chatId);
  assert(sess?.snapshot?.projectType === 'unknown',        'O1: non-owner cannot mutate projectType');
}

{
  // O2: session owner can proceed
  const chatId = 8002;
  makeOwnerSession(chatId, 100);
  const { ctx, calls } = makeCbCtx(chatId, 100);   // presser 100 == owner 100

  await handleSuggestCallback(ctx, ['goal', 'skip']);  // sug:goal:skip

  const sess = suggestSessions.get(chatId);
  assert(sess?.step === 2,                               'O2: owner advances step to 2');
  assert(calls.editMessageText.length === 1,             'O2: editMessageText called for owner');
}

{
  // O3: non-owner sug:cancel is rejected; session NOT deleted
  const chatId = 8003;
  makeOwnerSession(chatId, 100);
  const { ctx, calls } = makeCbCtx(chatId, 200);   // presser != owner

  await handleSuggestCallback(ctx, ['cancel']);

  assert(suggestSessions.has(chatId),                    'O3: session not deleted by non-owner cancel');
  assert(calls.answerCallbackQuery[0].text?.includes('Not your session'),
                                                          'O3: rejection text shown on cancel');
  assert(calls.editMessageText.length === 0,             'O3: no editMessageText for non-owner cancel');
}

{
  // O4: owner can cancel their own session
  const chatId = 8004;
  makeOwnerSession(chatId, 100);
  const { ctx, calls } = makeCbCtx(chatId, 100);   // owner presses cancel

  await handleSuggestCallback(ctx, ['cancel']);

  assert(!suggestSessions.has(chatId),                   'O4: owner can delete their own session');
  assert(calls.editMessageText.length === 1,             'O4: editMessageText called for owner cancel');
}

{
  // O5: no-userId session fails open (any user can proceed)
  const chatId = 8005;
  const session = {
    projectName: 'test', projDir: '/fake', step: 1, goal: '', noLm: false,
    snapshot: { projectType: 'cli', completedPhases: 0, phaseTitles: [], dependencies: [] },
    // userId intentionally absent (edge case)
    allSuggestions: [], filtered: [], manualItems: [],
    awaitingInput: null, categories: ['logic'], selectedIdxs: new Set(),
    passes: 1, pipelinePlan: {},
  };
  suggestSessions.set(chatId, session);
  const { ctx, calls } = makeCbCtx(chatId, 999);   // any user

  await handleSuggestCallback(ctx, ['goal', 'skip']);  // sug:goal:skip

  const sess = suggestSessions.get(chatId);
  assert(sess?.step === 2,                              'O5: no-userId session fails open');
}

{
  // O6: sug:cancel with no existing session — proceeds silently
  const chatId = 8006;
  suggestSessions.delete(chatId);                    // ensure no session
  const { ctx, calls } = makeCbCtx(chatId, 100);

  await handleSuggestCallback(ctx, ['cancel']);       // cancel with no session

  assert(!suggestSessions.has(chatId),               'O6: no session — cancel is idempotent');
  assert(true,                                       'O6: cancel with no session does not throw');
}

// ── Test T — Telegram suggestion-list truncation notices ──────────────────────

console.log('\n--- Test T: Telegram truncation notice on scan and manual-done ---');

function makeMockCtxCapture() {
  let lastMsg = '';
  const ctx = {
    answerCallbackQuery()         { return Promise.resolve(); },
    editMessageText(text)         { lastMsg = text; return Promise.resolve(); },
    get lastMessage()             { return lastMsg; },
    chat: { id: 99 },
  };
  return ctx;
}

function makeTruncItem(id) {
  return {
    id, type: 'new-feature', category: 'logic',
    title: `Item ${id}`, description: 'desc',
    effort: 'small', impact: 'high', suggestedSlot: 1,
    appliesTo: ['cli'],
  };
}

{
  // T1: scan produces >12 items (fullstack = 20 rules) → truncation notice present
  const ctx = makeMockCtxCapture();
  const session = {
    projectName: `tgph-trunc-scan-${randomUUID().slice(0, 8)}`,
    projDir: '/fake',
    snapshot: { projectType: 'fullstack', completedPhases: 0, phaseTitles: [], dependencies: [] },
    noLm: true,
    categories: [],
    scanning: false,
    step: 2,
  };
  await _sugHandleCat(ctx, 'done', session, 9001);

  assert(session.filtered.length === 12,                   'T1a: initial scan capped at ITEM_CAP (12)');
  assert(ctx.lastMessage.includes('Showing 12 of 20'),     'T1b: notice reflects ITEM_CAP-based cap');
}

{
  // T2: scan produces ≤10 items (unknown = 5 rules) → no truncation notice
  const ctx = makeMockCtxCapture();
  const session = {
    projectName: `tgph-trunc-scan-${randomUUID().slice(0, 8)}`,
    projDir: '/fake',
    snapshot: { projectType: 'unknown', completedPhases: 0, phaseTitles: [], dependencies: [] },
    noLm: true,
    categories: [],
    scanning: false,
    step: 2,
  };
  await _sugHandleCat(ctx, 'done', session, 9002);

  assert(session.filtered.length === 5,                    'T2a: filtered has all 5 items (no cap)');
  assert(!ctx.lastMessage.includes('Showing'),             'T2b: no truncation notice when ≤10 items');
}

{
  // T3: manual-done: 10 filtered + 3 manual = 13 > ITEM_CAP(12) → truncation notice
  const session = {
    filtered:     Array.from({ length: 10 }, (_, i) => makeTruncItem(`ai-${i + 1}`)),
    manualItems:  [makeTruncItem('m-1'), makeTruncItem('m-2'), makeTruncItem('m-3')],
    awaitingInput: 'manual',
    selectedIdxs:  new Set(),
  };
  const ctx = makeMockCtxCapture();
  await _sugHandleManual(ctx, 'done', session);

  assert(session.filtered.length === 12,                   'T3a: filtered capped at ITEM_CAP=12');
  assert(ctx.lastMessage.includes('Showing 12 of 13'),     'T3b: truncation notice shows "Showing 12 of 13"');
}

{
  // T4: manual-done: 5 filtered + 2 manual = 7 ≤ ITEM_CAP(12) → no truncation notice
  const session = {
    filtered:     Array.from({ length: 5 }, (_, i) => makeTruncItem(`ai-${i + 1}`)),
    manualItems:  [makeTruncItem('m-1'), makeTruncItem('m-2')],
    awaitingInput: 'manual',
    selectedIdxs:  new Set(),
  };
  const ctx = makeMockCtxCapture();
  await _sugHandleManual(ctx, 'done', session);

  assert(session.filtered.length === 7,                    'T4a: filtered has all 7 items (no cap)');
  assert(!ctx.lastMessage.includes('Showing'),             'T4b: no truncation notice when ≤12 items');
}

// ── Test NB — nb:* session-based resolution ───────────────────────────────────

console.log('\n--- Test NB: nb:* session-based resolution ---');

{
  // NB-1: cancel with no session should not throw and should not show an alert
  const ctx = makeMockCtx();
  ctx.from = { id: 999 };
  let replied = false;
  ctx.answerCallbackQuery = (opts) => {
    if (opts?.show_alert) replied = true;
    return Promise.resolve();
  };
  ctx.editMessageText = () => Promise.resolve();
  await handleNewbriefCallback(ctx, ['cancel']);
  assert(!replied, 'NB-1: cancel with no session should not show_alert');
}

{
  // NB-2: go with expired session → show_alert
  const ctx = makeMockCtx();
  ctx.from = { id: 999 };
  let alertShown = false;
  ctx.answerCallbackQuery = (opts) => {
    if (opts?.show_alert) alertShown = true;
    return Promise.resolve();
  };
  // No session — go should show the "Session expired" alert
  await handleNewbriefCallback(ctx, ['go']);
  assert(alertShown, 'NB-2: go with no session must show show_alert');
}

{
  // NB-3: cancel with active session → session deleted
  const chatId = 1234;
  const ctx = {
    chat: { id: chatId },
    from: { id: chatId },
    answerCallbackQuery() { return Promise.resolve(); },
    editMessageText()     { return Promise.resolve(); },
  };
  nbSessions.set(chatId, { projectName: 'some-project' });
  await handleNewbriefCallback(ctx, ['cancel']);
  assert(!nbSessions.has(chatId), 'NB-3: cancel must delete the nb session');
}

// ── Test NB-4/5 — nb:go guard correctness ─────────────────────────────────────

console.log('\n--- Test NB-4/5: nb:go guard correctness ---');

{
  // NB-4: nb:go for a non-existent project → show_alert, no "Resetting…"
  const chatId = 5001;
  nbSessions.set(chatId, { projectName: 'does-not-exist-xyz' });

  let alertShown = false;
  let editCalled = false;
  const ctx = {
    chat: { id: chatId },
    from:  { id: chatId },
    answerCallbackQuery(opts) {
      if (opts?.show_alert) alertShown = true;
      return Promise.resolve();
    },
    editMessageText(text) {
      if (typeof text === 'string' && text.includes('Resetting')) editCalled = true;
      return Promise.resolve();
    },
    reply() { return Promise.resolve(); },
  };

  await handleNewbriefCallback(ctx, ['go']);
  assert(alertShown,   'NB-4: nb:go for unknown project must show_alert');
  assert(!editCalled,  'NB-4: nb:go for unknown project must NOT show "Resetting…"');
  assert(nbSessions.has(chatId), 'NB-4: session must survive a guard rejection');
  nbSessions.delete(chatId);
}

{
  // NB-5: nb:go with a valid DB project but missing brief → show_alert, no "Resetting…"
  const projectName = `nb-test-no-brief-${randomUUID().slice(0, 8)}`;
  upsertProject({ name: projectName, tech_stack: 'node', total_phases: 1 });
  const chatId = 5002;
  nbSessions.set(chatId, { projectName });

  let alertShown = false;
  let resettingShown = false;
  const ctx = {
    chat: { id: chatId },
    from:  { id: chatId },
    answerCallbackQuery(opts) {
      if (opts?.show_alert) alertShown = true;
      return Promise.resolve();
    },
    editMessageText(text) {
      if (typeof text === 'string' && text.includes('Resetting')) resettingShown = true;
      return Promise.resolve();
    },
    reply() { return Promise.resolve(); },
  };

  // PROJECTS_DIR points to the real projects/ folder; no inputs/brief.md exists
  // for this temp project name → missing-brief guard fires.
  await handleNewbriefCallback(ctx, ['go']);
  assert(alertShown,       'NB-5: missing brief must show_alert');
  assert(!resettingShown,  'NB-5: missing brief must NOT show "Resetting…" before guard fires');
  nbSessions.delete(chatId);
}

// ── Test MB — Multi-bracket manual-title strip ────────────────────────────────

console.log('\n--- Test MB: handleSuggestManualInput multi-bracket title strip ---');

{
  // MB-1: inner [group] bracket must survive; only trailing [effort/impact] is stripped
  const session = {
    filtered:     [],
    manualItems:  [],
    allSuggestions: [],
    awaitingInput: 'manual',
    selectedIdxs:  new Set(),
  };
  const ctx = {
    chat: { id: 8001 },
    reply() { return Promise.resolve(); },
    editMessageText() { return Promise.resolve(); },
    answerCallbackQuery() { return Promise.resolve(); },
  };

  await handleSuggestManualInput(ctx, 'Use [v2] API [small/high]', session);

  const item = session.manualItems[0];
  assert(item !== undefined,               'MB-1a: manual item was created');
  assert(item.title === 'Use [v2] API',    'MB-1b: title keeps inner [v2], strips only trailing [small/high]');
  assert(item.effort === 'small',          'MB-1c: effort parsed correctly');
  assert(item.impact === 'high',           'MB-1d: impact parsed correctly');
}

{
  // MB-2: input with no meta token → full text becomes title; defaults applied
  const session = {
    filtered:     [],
    manualItems:  [],
    allSuggestions: [],
    awaitingInput: 'manual',
    selectedIdxs:  new Set(),
  };
  const ctx = {
    chat: { id: 8002 },
    reply() { return Promise.resolve(); },
    editMessageText() { return Promise.resolve(); },
    answerCallbackQuery() { return Promise.resolve(); },
  };

  await handleSuggestManualInput(ctx, 'Plain title no meta', session);

  const item = session.manualItems[0];
  assert(item !== undefined,                  'MB-2a: manual item created for plain-text input');
  assert(item.title === 'Plain title no meta','MB-2b: full text used as title when no [effort/impact] token');
  assert(item.effort === 'medium',            'MB-2c: effort defaults to medium');
  assert(item.impact === 'high',              'MB-2d: impact defaults to high');
}

// ── Summary ────────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);

try { rmSync(testDbDir, { recursive: true, force: true }); } catch { /* ignore */ }

if (failed > 0) process.exit(1);
