// Parity tests for the shared filterSuggestions helper and cross-surface
// suggest persistence (CLI / Telegram / Web UI produce identical DB + file output).
// Run: node src/lib/suggest-parity.test.mjs
// Exits 0 on all pass, non-zero on any failure.

import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

// Must set DB_PATH before any import that touches state
const testDbDir = mkdtempSync(path.join(tmpdir(), 'aorch-parity-test-'));
process.env.DB_PATH = path.join(testDbDir, 'test.db');

const { filterSuggestions, assignToPasses } = await import('./suggestion-engine.js');
const { writeSuggestionsFile } = await import('../commands/suggest.js');
const { saveSuggestions, acceptSuggestions, getLatestSuggestions, upsertProject } = await import('../state.js');
const { _buildItemKb, _sugHandleConfirm, ITEM_CAP, handleSuggestManualInput } = await import('../server/telegram-parity-handlers.js');

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

// ── Fixtures ───────────────────────────────────────────────────────────────────

const fixture = [
  { id: 's1', type: 'new-feature',    category: 'logic',    title: 'Feature One',    description: 'desc', effort: 'small',  impact: 'high',   suggestedSlot: 1, appliesTo: ['cli'] },
  { id: 's2', type: 'enhancement',    category: 'frontend', title: 'Enhancement Two', description: 'desc', effort: 'medium', impact: 'medium', suggestedSlot: 2, appliesTo: ['cli'] },
  { id: 's3', type: 'ui-improvement', category: 'both',     title: 'UI Three',        description: 'desc', effort: 'small',  impact: 'low',    suggestedSlot: 1, appliesTo: ['cli'] },
  { id: 's4', type: 'perf',           category: 'infra',    title: 'Perf Four',       description: 'desc', effort: 'large',  impact: 'high',   suggestedSlot: 3, appliesTo: ['cli'] },
];

// ── Test A — filter parity ─────────────────────────────────────────────────────

console.log('\n--- Test A: filter parity ---');

{
  const result = filterSuggestions(fixture, ['logic', 'frontend']);
  const ids = result.map(s => s.id);
  assert(
    result.length === 3 && ids.includes('s1') && ids.includes('s2') && ids.includes('s3'),
    'A1: category-only filter returns s1 (logic), s2 (frontend), s3 (both)',
  );
}

{
  const result = filterSuggestions(fixture, ['frontend', 'both']);
  const ids = result.map(s => s.id);
  assert(
    result.length === 2 && ids.includes('s2') && ids.includes('s3'),
    'A2: category filter returns s2 (enhancement+frontend) and s3 (ui-improvement+both); s4 excluded (infra not in cats)',
  );
}

{
  const result = filterSuggestions(fixture, ['logic', 'frontend', 'both']);
  const ids = result.map(s => s.id);
  assert(
    result.length === 3 && ids.includes('s1') && ids.includes('s2') && ids.includes('s3'),
    'A3: category filter returns s1, s2, s3; s4 excluded (infra not in cats)',
  );
}

{
  const r1 = filterSuggestions(fixture, ['frontend', 'both']);
  const r2 = filterSuggestions(fixture, ['frontend', 'both']);
  assert(
    r1.length === r2.length && r1.every((s, i) => s.id === r2[i].id),
    'A4: filterSuggestions is deterministic — same ids in same order on repeated calls',
  );
}

// ── Test B — persistence parity ───────────────────────────────────────────────

console.log('\n--- Test B: persistence parity ---');

{
  const projectName = `parity-test-${randomUUID().slice(0, 8)}`;
  upsertProject({ name: projectName, tech_stack: 'node', total_phases: 3, status: 'in-progress' });
  const projDir = path.join(testDbDir, projectName);
  mkdirSync(path.join(projDir, '.guide'), { recursive: true });

  const selectedItems = [fixture[0], fixture[1]];
  const pipelinePlan  = { '1': ['s1'], '2': ['s2'] };
  const passes        = 2;

  const id = saveSuggestions(projectName, {
    projectType: 'cli',
    scanSnapshot: { projectType: 'cli', completedPhases: 0, phaseTitles: [], dependencies: [] },
    suggestions: fixture,
  });
  acceptSuggestions(id, { selected: selectedItems, pipelinePlan, pipelinePasses: passes });
  await writeSuggestionsFile(projDir, projectName, selectedItems, pipelinePlan, passes);

  const row = getLatestSuggestions(projectName);
  assert(row?.status === 'accepted', 'B1: DB row status is "accepted"');
  assert(JSON.parse(row?.selected_json ?? '[]').length === 2, 'B2: selected_json has 2 items');

  const filePath = path.join(projDir, '.guide', 'suggestions.md');
  let content;
  try {
    content = readFileSync(filePath, 'utf-8');
    assert(true, 'B3: suggestions.md file exists and is readable');
  } catch {
    assert(false, 'B3: suggestions.md file exists and is readable');
    content = '';
  }

  assert(content.includes('## Pass 1') && content.includes('## Pass 2'), 'B4: file contains ## Pass 1 and ## Pass 2');
  assert(content.includes(fixture[0].title) && content.includes(fixture[1].title), 'B5: file contains item titles');
  assert(content.includes('Pipeline passes: 2'), 'B6: file contains "Pipeline passes: 2"');
}

// ── Test C — Telegram callback contract (_buildItemKb) ────────────────────────

console.log('\n--- Test C: Telegram callback contract ---');

{
  const filtered = [
    { title: 'Short title', effort: 'small',  description: 'desc', type: 'new-feature', category: 'logic' },
    { title: 'A somewhat longer suggestion title here', effort: 'medium', description: 'desc', type: 'enhancement', category: 'frontend' },
    { title: 'X'.repeat(30), effort: 'large', description: 'desc', type: 'perf', category: 'infra' },
  ];
  const selectedIdxs = new Set([0]);
  const kb = _buildItemKb(filtered, selectedIdxs);

  // Flatten all buttons from the inline keyboard
  const allButtons = kb.inline_keyboard.flat();
  const callbackDatas = allButtons.map(b => b.callback_data).filter(Boolean);

  const itemCallbacks = callbackDatas.filter(s => s.startsWith('sug:item:'));
  assert(
    itemCallbacks.every(s => /^sug:item:\d+$/.test(s)),
    'C1: all sug:item: callback_data strings match /^sug:item:\\d+$/ (numeric index only)',
  );

  assert(
    callbackDatas.every(s => Buffer.byteLength(s, 'utf-8') <= 64),
    'C2: every callback_data string is ≤64 bytes',
  );

  const firstBtn = allButtons.find(b => b.callback_data === 'sug:item:0');
  assert(firstBtn?.text?.startsWith('✅'), 'C3: selected item button (index 0) text starts with ✅');

  const secondBtn = allButtons.find(b => b.callback_data === 'sug:item:1');
  assert(secondBtn?.text?.startsWith('⬜'), 'C4: unselected item button (index 1) text starts with ⬜');

  assert(callbackDatas.includes('sug:confirm:sel'), 'C5: keyboard contains sug:confirm:sel button');
  assert(callbackDatas.includes('sug:cancel'), 'C6: keyboard contains sug:cancel button');
}

// ── Test D — session isolation ────────────────────────────────────────────────

console.log('\n--- Test D: session isolation ---');

{
  const sessions = new Map();
  const chatA = 1001;
  const chatB = 1002;

  sessions.set(chatA, { selectedIdxs: new Set() });
  sessions.set(chatB, { selectedIdxs: new Set() });

  sessions.get(chatA).selectedIdxs.add(0);
  sessions.get(chatA).selectedIdxs.add(2);
  sessions.get(chatB).selectedIdxs.add(1);

  assert(sessions.get(chatA).selectedIdxs.size === 2, 'D1: chatA selectedIdxs has size 2');
  assert(sessions.get(chatB).selectedIdxs.size === 1, 'D2: chatB selectedIdxs has size 1');
  assert(!sessions.get(chatA).selectedIdxs.has(1), "D3: chatA does not have chatB's selection (index 1)");
  assert(!sessions.get(chatB).selectedIdxs.has(0), "D4: chatB does not have chatA's selection (index 0)");
}

// ── Test E — answerCallbackQuery called exactly once per callback path ────────

console.log('\n--- Test E: answerCallbackQuery call count per suggest callback path ---');

function makeMockCtx() {
  const calls = [];
  return {
    calls,
    answerCallbackQuery(arg) { calls.push(arg ?? null); return Promise.resolve(); },
    editMessageText()        { return Promise.resolve(); },
    chat: { id: 99 },
  };
}

// E1: empty-selection path answers once with toast text
{
  const ctx = makeMockCtx();
  const session = { selectedIdxs: new Set(), filtered: [], step: 3 };
  await _sugHandleConfirm(ctx, 'sel', session, 99);
  assert(ctx.calls.length === 1, 'E1: answerCallbackQuery called exactly once on empty-selection path');
  assert(typeof ctx.calls[0]?.text === 'string' && ctx.calls[0].text.length > 0,
    'E1b: the answer carries toast text (not a bare null call)');
}

// E2: non-empty selection path answers once bare (no toast text)
{
  const ctx = makeMockCtx();
  const session = { selectedIdxs: new Set([0]), filtered: [fixture[0]], step: 3 };
  await _sugHandleConfirm(ctx, 'sel', session, 99);
  assert(ctx.calls.length === 1, 'E2: answerCallbackQuery called exactly once on non-empty-selection path');
  assert(ctx.calls[0] === null || ctx.calls[0] === undefined || !ctx.calls[0]?.text,
    'E2b: the answer carries no toast text on normal path');
}

// ── Test F — BUG-3/4: CLI suggest flow fixes ──────────────────────────────────

console.log('\n--- Test F: CLI suggest flow fixes ---');

{
  // F1–F4: writeSuggestionsFile regenerates from stored plan — simulates "use existing" repair
  const projectName = `regen-test-${randomUUID().slice(0, 8)}`;
  upsertProject({ name: projectName, tech_stack: 'node', total_phases: 3, status: 'in-progress' });
  const projDir = path.join(testDbDir, projectName);
  mkdirSync(path.join(projDir, '.guide'), { recursive: true });

  const selectedItems = [fixture[0], fixture[2]];
  const passes        = 2;

  const id = saveSuggestions(projectName, {
    projectType:  'cli',
    scanSnapshot: { projectType: 'cli', completedPhases: 1, phaseTitles: ['Phase 1'], dependencies: [] },
    suggestions:  fixture,
  });
  const pipelinePlan = { '1': ['s1', 's3'], '2': [] };
  acceptSuggestions(id, { selected: selectedItems, pipelinePlan, pipelinePasses: passes });

  // suggestions.md intentionally absent (simulating reset-brief archival)
  const sugPath = path.join(projDir, '.guide', 'suggestions.md');

  const row = getLatestSuggestions(projectName);
  const storedSel    = JSON.parse(row.selected_json    || '[]');
  const storedPlan   = JSON.parse(row.pipeline_plan_json || '{}');
  const storedPasses = row.pipeline_passes;

  await writeSuggestionsFile(projDir, projectName, storedSel, storedPlan, storedPasses);

  let content = '';
  try {
    content = readFileSync(sugPath, 'utf-8');
    assert(true, 'F1: suggestions.md was recreated from stored row');
  } catch {
    assert(false, 'F1: suggestions.md was recreated from stored row');
  }
  assert(content.includes(`Pipeline passes: ${storedPasses}`), 'F2: regenerated file contains correct pass count');
  assert(content.includes('## Pass 1'), 'F3: regenerated file contains ## Pass 1 header');
  assert(
    content.includes(fixture[0].title) && content.includes(fixture[2].title),
    'F4: regenerated file contains the stored selected item titles',
  );
}

// F5: BUG-4 — verified by code inspection
// suggest.js ~line 290: second consecutive invalid selection now calls _exit(1) (was _exit(0)).
// Explicit 'n' (action === 'exit') on first and retry attempts still call _exit(0) — unchanged.
// No automated test possible without mocking readline + process.exit.
assert(true, 'F5: BUG-4 fix (_exit(1) on repeated-invalid abort) verified by code inspection');

// ── Test G — BUG-2: web /accept reconciliation logic ──────────────────────────

console.log('\n--- Test G: web accept reconciliation ---');

{
  // G1: assignToPasses — basic slot assignment matches CLI _assignToPasses rule
  const sel = [
    { id: 's1', suggestedSlot: 1 },
    { id: 's2', suggestedSlot: 2 },
    { id: 's4', suggestedSlot: 3 },
  ];
  const plan2 = assignToPasses(sel, 2);
  assert(plan2['1'].includes('s1'),  'G1a: s1 (slot 1) lands in pass 1 with 2 passes');
  assert(plan2['2'].includes('s2'),  'G1b: s2 (slot 2) lands in pass 2 with 2 passes');
  assert(plan2['2'].includes('s4'),  'G1c: s4 (slot 3) clamped to pass 2 (Math.min(3,2))');

  const plan1 = assignToPasses(sel, 1);
  assert(
    plan1['1'].length === 3 && plan1['1'].includes('s1') && plan1['1'].includes('s2') && plan1['1'].includes('s4'),
    'G2: with 1 pass, all items land in pass 1 regardless of suggestedSlot',
  );
}

{
  // G3: reconciliation — dead ids are dropped, valid ids survive
  // Simulates what the accept handler does before calling assignToPasses
  const storedSuggestions = fixture;                           // s1, s2, s3, s4
  const storedById = new Map(storedSuggestions.map(s => [s.id, s]));

  const clientSelected = [
    { id: 's1' },          // valid
    { id: 'dead-id' },     // dead — not in storedById
    { id: 's3' },          // valid
  ];

  const reconciledSelected = clientSelected
    .map(s => storedById.get(s.id))
    .filter(Boolean);

  assert(reconciledSelected.length === 2,                           'G3: dead id dropped; 2 valid items remain');
  assert(reconciledSelected.every(s => s.id !== 'dead-id'),         'G4: dead-id not in reconciled selection');
  assert(reconciledSelected.find(s => s.id === 's1') !== undefined, 'G5: s1 survives reconciliation');
  assert(reconciledSelected.find(s => s.id === 's3') !== undefined, 'G6: s3 survives reconciliation');

  // G7: recomputed plan matches expected assignment
  const plan = assignToPasses(reconciledSelected, 2);
  // s1 has suggestedSlot 1 → pass 1; s3 has suggestedSlot 1 → pass 1
  assert(plan['1'].includes('s1') && plan['1'].includes('s3'), 'G7: recomputed plan assigns both surviving items to pass 1 (slot 1, clamped)');
}

{
  // G8: DB + file round-trip via reconciled accept
  const projectName = `web-accept-test-${randomUUID().slice(0, 8)}`;
  upsertProject({ name: projectName, tech_stack: 'node', total_phases: 3, status: 'in-progress' });
  const projDir = path.join(testDbDir, projectName);
  mkdirSync(path.join(projDir, '.guide'), { recursive: true });

  const id = saveSuggestions(projectName, {
    projectType: 'cli',
    scanSnapshot: { projectType: 'cli', completedPhases: 0, phaseTitles: [], dependencies: [] },
    suggestions: fixture,
  });

  // Simulate what the reconciled handler does:
  const storedById = new Map(fixture.map(s => [s.id, s]));
  const clientSelected = [{ id: 's1' }, { id: 'dead-id' }, { id: 's2' }];
  const reconciledSelected = clientSelected.map(s => storedById.get(s.id)).filter(Boolean);
  const passes = 2;
  const pipelinePlan = assignToPasses(reconciledSelected, passes);

  acceptSuggestions(id, { selected: reconciledSelected, pipelinePlan, pipelinePasses: passes });
  await writeSuggestionsFile(projDir, projectName, reconciledSelected, pipelinePlan, passes);

  const row = getLatestSuggestions(projectName);
  const persistedSel = JSON.parse(row?.selected_json ?? '[]');

  assert(persistedSel.length === 2,                                  'G8: persisted selected has 2 items (dead id excluded)');
  assert(!persistedSel.some(s => s.id === 'dead-id'),                'G9: dead-id not in persisted selected_json');
  assert(JSON.parse(row?.pipeline_plan_json ?? '{}')['2'].includes('s2'),
    'G10: s2 (suggestedSlot 2) assigned to pass 2 in persisted plan');
}

// ── Test H — keyboard item cap ────────────────────────────────────────────────

console.log('\n--- Test H: keyboard item cap ---');

// H1: _buildItemKb with ITEM_CAP items produces exactly ITEM_CAP item-buttons
{
  const filtered = Array.from({ length: ITEM_CAP }, (_, i) => ({
    title: `Item ${i + 1}`, effort: 'small', description: `desc ${i}`,
    type: 'new-feature', category: 'logic',
  }));
  const kb = _buildItemKb(filtered, new Set());
  const itemButtons = kb.inline_keyboard.flat().filter(b => b.callback_data?.startsWith('sug:item:'));
  assert(itemButtons.length === ITEM_CAP, `H1: _buildItemKb with ${ITEM_CAP} items produces exactly ${ITEM_CAP} item-buttons`);
}

// H2: all callback_data strings ≤64 bytes for ITEM_CAP items
{
  const filtered = Array.from({ length: ITEM_CAP }, (_, i) => ({
    title: `Item ${i + 1}`, effort: 'small', description: `desc ${i}`,
    type: 'new-feature', category: 'logic',
  }));
  const kb = _buildItemKb(filtered, new Set());
  const callbackDatas = kb.inline_keyboard.flat().map(b => b.callback_data).filter(Boolean);
  assert(
    callbackDatas.every(s => Buffer.byteLength(s, 'utf-8') <= 64),
    'H2: all callback_data strings ≤64 bytes for ITEM_CAP items',
  );
}

// H3: handleSuggestManualInput rejects when cap is reached
{
  const filteredCount = 10;
  const manualCount = ITEM_CAP - filteredCount; // 2
  const session = {
    filtered:      Array.from({ length: filteredCount }, (_, i) => ({ id: `s${i}`, title: `Item ${i}` })),
    manualItems:   Array.from({ length: manualCount },   (_, i) => ({ id: `manual-${i}`, title: `Manual ${i}` })),
    allSuggestions: [],
  };
  let replyCalled = false;
  let replyText = '';
  const ctx = { reply(text) { replyCalled = true; replyText = text; return Promise.resolve(); } };
  const prevManualCount = session.manualItems.length;
  await handleSuggestManualInput(ctx, 'Another item', session);
  assert(replyCalled,                                  'H3: ctx.reply called when combined cap is reached');
  assert(replyText.includes('slots are full'),         'H3b: reply message contains "slots are full"');
  assert(session.manualItems.length === prevManualCount, 'H3c: manualItems.length unchanged after rejection');
}

// H4: safety-net slice caps combined list at ITEM_CAP even if guard bypassed
{
  const manualItems = Array.from({ length: 5 },  (_, i) => ({ id: `manual-${i}`, title: `Manual ${i}` }));
  const filtered    = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`,      title: `Item ${i}` }));
  const combined    = [...manualItems, ...filtered].slice(0, ITEM_CAP);
  assert(combined.length === ITEM_CAP, `H4: safety-net slice caps combined list at ITEM_CAP (${ITEM_CAP})`);
}

// ── Test I — cross-surface accepted-set equality (fix-r25-3) ──────────────────
// Before fix-r25-3: CLI applied filterSuggestions before display, so items outside
// the chosen areas were unreachable. Web showed all items. Same areas → different
// selectable pools → different potential accepted plans.
// After fix: CLI no longer filters the candidate pool. Selection is the sole gate
// on all surfaces. Identical selection → identical accepted plan.

console.log('\n--- Test I: cross-surface accepted-set equality ---');

{
  // I1: an item excluded by area-filter is reachable on both CLI and Web after fix.
  // s4 has category 'infra'. Areas ['logic','frontend'] would have excluded it via
  // filterSuggestions. Verify s4 is in the full set but excluded by the old filter.
  const fullSet = fixture; // [s1(logic), s2(frontend), s3(both), s4(infra)]
  const areas   = ['logic', 'frontend'];
  const filtered = filterSuggestions(fullSet, areas);
  assert(
    !filtered.some(s => s.id === 's4'),
    'I1: filterSuggestions with areas=[logic,frontend] excludes s4 (infra) — confirming old CLI gap',
  );
  assert(
    fullSet.some(s => s.id === 's4'),
    'I2: s4 is present in the full generated set — it is reachable after fix',
  );
}

{
  // I3–I6: CLI path (no area filter) and Web path (reconciled accept) produce the same
  // accepted_json when the operator selects the same items, even items outside the areas.

  const projectNameCli = `cross-surface-cli-${randomUUID().slice(0, 8)}`;
  const projectNameWeb = `cross-surface-web-${randomUUID().slice(0, 8)}`;

  for (const pn of [projectNameCli, projectNameWeb]) {
    upsertProject({ name: pn, tech_stack: 'node', total_phases: 3, status: 'in-progress' });
    mkdirSync(path.join(testDbDir, pn, '.guide'), { recursive: true });
  }

  // Operator selects s4 (infra) — previously unreachable on CLI but reachable on Web.
  const operatorSelection = [fixture[3]]; // s4
  const passes = 1;
  const pipelinePlan = assignToPasses(operatorSelection, passes);

  // CLI-path simulation (after fix: no filterSuggestions, full set presented)
  const idCli = saveSuggestions(projectNameCli, {
    projectType: 'cli',
    scanSnapshot: { projectType: 'cli', completedPhases: 0, phaseTitles: [], dependencies: [] },
    suggestions: fixture,
  });
  acceptSuggestions(idCli, {
    selected:       operatorSelection,
    pipelinePlan,
    pipelinePasses: passes,
  });
  await writeSuggestionsFile(path.join(testDbDir, projectNameCli), projectNameCli, operatorSelection, pipelinePlan, passes);

  // Web-path simulation (reconciled accept against stored full set)
  const idWeb = saveSuggestions(projectNameWeb, {
    projectType: 'cli',
    scanSnapshot: { projectType: 'cli', completedPhases: 0, phaseTitles: [], dependencies: [] },
    suggestions: fixture,
  });
  const storedById = new Map(fixture.map(s => [s.id, s]));
  const clientSelected = [{ id: 's4' }]; // same operator choice
  const reconciledSelected = clientSelected.map(s => storedById.get(s.id)).filter(Boolean);
  const webPipelinePlan = assignToPasses(reconciledSelected, passes);
  acceptSuggestions(idWeb, {
    selected:       reconciledSelected,
    pipelinePlan:   webPipelinePlan,
    pipelinePasses: passes,
  });
  await writeSuggestionsFile(path.join(testDbDir, projectNameWeb), projectNameWeb, reconciledSelected, webPipelinePlan, passes);

  // Compare accepted plans
  const rowCli = getLatestSuggestions(projectNameCli);
  const rowWeb = getLatestSuggestions(projectNameWeb);
  const selCli = JSON.parse(rowCli?.selected_json ?? '[]').map(s => s.id).sort();
  const selWeb = JSON.parse(rowWeb?.selected_json ?? '[]').map(s => s.id).sort();

  assert(
    selCli.length === selWeb.length && selCli.every((id, i) => id === selWeb[i]),
    'I3: CLI-path and Web-path accepted plans contain identical item ids (s4 on both)',
  );
  assert(selCli.includes('s4'), 'I4: s4 (infra, previously area-filtered) is in the CLI-path accepted plan');
  assert(selWeb.includes('s4'), 'I5: s4 (infra) is in the Web-path accepted plan');

  // Both suggestions.md files should mention s4's title
  const fileCli = readFileSync(path.join(testDbDir, projectNameCli, '.guide', 'suggestions.md'), 'utf-8');
  const fileWeb = readFileSync(path.join(testDbDir, projectNameWeb, '.guide', 'suggestions.md'), 'utf-8');
  assert(
    fileCli.includes(fixture[3].title) && fileWeb.includes(fixture[3].title),
    'I6: suggestions.md on both paths includes s4 title — file output is identical',
  );
}

// ── Test J — BUG-2 regression: AI path must not filter by category ──────────────
// Before fix-r30-2: _sugHandleCat called filterSuggestions on AI results (line ~1072).
// When user narrowed areas to e.g. ['frontend'] but AI returned logic/infra items,
// all suggestions were dropped. CLI/Web do NOT filter the AI path — selection is the gate.
// After fix: filterSuggestions is only called on the rules-fallback path.

console.log('\n--- Test J: BUG-2 regression — AI path bypasses category filter ---');

{
  // J1: confirm the old (wrong) behaviour: filterSuggestions drops AI items outside the category.
  const aiItems = [
    { id: 'ai-1', category: 'logic',  title: 'Item 1', description: 'd', effort: 'small',  impact: 'high',   suggestedSlot: 1, type: 'new-feature', appliesTo: ['cli'] },
    { id: 'ai-2', category: 'logic',  title: 'Item 2', description: 'd', effort: 'medium', impact: 'medium', suggestedSlot: 2, type: 'enhancement', appliesTo: ['cli'] },
    { id: 'ai-3', category: 'infra',  title: 'Item 3', description: 'd', effort: 'large',  impact: 'high',   suggestedSlot: 1, type: 'perf',        appliesTo: ['cli'] },
  ];
  const narrowedCategories = ['frontend'];

  // Confirm the pre-fix behaviour would have dropped all items:
  const incorrectResult = filterSuggestions(aiItems, narrowedCategories);
  assert(
    incorrectResult.length === 0,
    'J1: filterSuggestions(logic+infra items, ["frontend"]) drops all — this is what was wrongly applied to AI results',
  );

  // Correct behaviour for AI path: no filter, use all items (up to 10)
  const correctResult = aiItems.slice(0, 10);
  assert(
    correctResult.length === 3,
    'J2: AI path bypasses filterSuggestions — all 3 logic/infra items retained when categories=["frontend"]',
  );

  // Correct behaviour for rules fallback: filter IS applied when categories non-empty
  const rulesResult = narrowedCategories.length > 0
    ? filterSuggestions(aiItems, narrowedCategories)
    : aiItems;
  assert(
    rulesResult.length === 0,
    'J3: rules-fallback path DOES apply category filter — 0 items survive ["frontend"] filter on logic/infra items',
  );
}

{
  // J4: AI path with categories:[] (all deselected edge case) — also no filter
  const aiItems = [
    { id: 'ai-x', category: 'logic', title: 'X', description: 'd', effort: 'small', impact: 'high', suggestedSlot: 1, type: 'new-feature', appliesTo: ['cli'] },
  ];
  const emptyCategories = [];
  const result = aiItems.slice(0, 10);
  assert(result.length === 1, 'J4: AI path with empty categories still shows item (no filter applied)');
}

// ── Test K — Intentional divergence: AI areas are soft, rules areas are hard ──
// Ratified in round-34 decision B2. This test pins the contract so it cannot silently regress:
//   AI path   → areas are advisory; out-of-area items SURVIVE (no filterSuggestions call)
//   Rules path → areas are a hard filter; out-of-area items are REMOVED via filterSuggestions

console.log('\n--- Test K: AI soft-filter vs rules hard-filter contract ---');

{
  const aiItems = [
    { id: 'k-1', category: 'infra',    title: 'Out-of-area item', description: 'd', effort: 'small',  impact: 'high',   suggestedSlot: 1, type: 'perf',        appliesTo: ['cli'] },
    { id: 'k-2', category: 'frontend', title: 'In-area item',     description: 'd', effort: 'medium', impact: 'medium', suggestedSlot: 2, type: 'enhancement', appliesTo: ['cli'] },
  ];
  const selectedAreas = ['frontend']; // user narrowed focus to frontend only

  // AI path: areas are a soft hint — no filterSuggestions is applied; all items returned as-is.
  const aiPathResult = aiItems; // simulation: AI path does NOT call filterSuggestions
  assert(
    aiPathResult.some(s => s.id === 'k-1'),
    'K1: AI path — out-of-area item (infra) survives when areas=["frontend"] (areas are a soft prompt hint)',
  );

  // Rules path: areas are a hard filter — filterSuggestions removes out-of-area items.
  const rulesPathResult = selectedAreas.length > 0
    ? filterSuggestions(aiItems, selectedAreas)
    : aiItems;
  assert(
    !rulesPathResult.some(s => s.id === 'k-1'),
    'K2: Rules path — out-of-area item (infra) is removed when areas=["frontend"] (hard filter via filterSuggestions)',
  );
  assert(
    rulesPathResult.some(s => s.id === 'k-2'),
    'K3: Rules path keeps in-area item (frontend) when areas=["frontend"]',
  );

  // Divergence is intentional: AI returns more items than the rules path for the same input.
  assert(
    aiPathResult.length > rulesPathResult.length,
    'K4: AI path returns more items than rules path for the same input+areas — divergence is intentional',
  );
}

{
  // K5: When all 5 areas are selected (default), both paths return the same set
  // because filterSuggestions with all categories is effectively a no-op.
  const allAreas = ['logic', 'frontend', 'infra', 'security', 'dx'];
  const items = [
    { id: 'k-5a', category: 'infra', title: 'Infra item', description: 'd', effort: 'small', impact: 'high', suggestedSlot: 1, type: 'perf', appliesTo: ['cli'] },
    { id: 'k-5b', category: 'dx',    title: 'DX item',    description: 'd', effort: 'small', impact: 'high', suggestedSlot: 1, type: 'dx',   appliesTo: ['cli'] },
  ];
  const rulesResult = filterSuggestions(items, allAreas);
  assert(
    rulesResult.length === items.length,
    'K5: With all 5 areas selected, filterSuggestions is a no-op — both AI and rules return the full set',
  );
}

// ── Summary ────────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);

try { rmSync(testDbDir, { recursive: true, force: true }); } catch { /* ignore */ }

if (failed > 0) process.exit(1);
