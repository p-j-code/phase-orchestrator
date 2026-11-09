// Phase 20 (brief P3, tracking + handoff-anchor halves) —
// src/lib/phase-runner-guide-head-delta.test.mjs
//
// Two independent pieces:
//
// 1. loadGuideHeadDeltaBlock — fail-open wrapper, mirrors loadContextDeltaBlock
//    (phase 18) but diffs from the GUIDE's own last-seen HEAD
//    (metadata_json.last_guide_head_sha, tracked by setProjectMetadataField at
//    the tail of runGuide()/runTwoStageAudit() — see state.test.mjs for the
//    metadata-patch helper's own round-trip tests) rather than
//    project-context.md's stamp.
//
// 2. appendHandoffAnchor — deterministic, orchestrator-side "Generated at
//    commit: {sha}" line appended to a handoff file after the guide call that
//    wrote it succeeds. Idempotent.
//
// Neither function's own behavior requires a live DB/git/subprocess fixture,
// so both are exercised directly via injected deps / real temp files — same
// convention as phase-runner-context-freshness.test.mjs.
//
// Source-assertion tests at the bottom cover placement/ordering in
// phase-runner.js that would otherwise need a live runGuide() fixture to
// observe (session-id continuity, handoff-path reuse).
//
// Run with: node --test src/lib/phase-runner-guide-head-delta.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DB_PATH = ':memory:';

const { loadGuideHeadDeltaBlock, appendHandoffAnchor } = await import('./phase-runner.js');

function makeProjDir(label) {
  const d = mkdtempSync(path.join(tmpdir(), `aorch-guide-head-delta-${label}-`));
  mkdirSync(path.join(d, '.guide'), { recursive: true });
  return d;
}

// ─── loadGuideHeadDeltaBlock ─────────────────────────────────────────────────

test('loadGuideHeadDeltaBlock: no last_guide_head_sha (never tracked yet) → null, contextDelta never called', async () => {
  const projDir = makeProjDir('none-tracked');
  const workspaceDir = path.join(projDir, 'workspace');
  let called = false;
  const block = await loadGuideHeadDeltaBlock(workspaceDir, null, {
    contextDelta: async () => { called = true; return { drift: 'unknown' }; },
  });
  assert.equal(block, null);
  assert.equal(called, false, 'nothing to diff against — contextDelta must not even be invoked');
});

test('loadGuideHeadDeltaBlock: small drift (2 external commits) → classified block, matches the phase-20 fixture scenario', async () => {
  const projDir = makeProjDir('small-drift');
  const workspaceDir = path.join(projDir, 'workspace');
  const block = await loadGuideHeadDeltaBlock(workspaceDir, 'lastseen01', {
    contextDelta: async ({ workspaceDir: ws, sinceSha }) => {
      assert.equal(ws, workspaceDir);
      assert.equal(sinceSha, 'lastseen01');
      return {
        drift: 'some',
        commits: [
          { sha: 'ext0000001', subject: 'Manual hotfix #1', classification: 'external' },
          { sha: 'ext0000002', subject: 'Manual hotfix #2', classification: 'external' },
        ],
        overflowLine: null,
      };
    },
  });
  assert.ok(block.includes('<context_delta>'));
  assert.ok(block.includes('[EXTERNAL] Manual hotfix #1'));
  assert.ok(block.includes('[EXTERNAL] Manual hotfix #2'));
});

test('loadGuideHeadDeltaBlock: drift "none" → null (nothing changed since the guide last looked)', async () => {
  const projDir = makeProjDir('drift-none');
  const workspaceDir = path.join(projDir, 'workspace');
  const block = await loadGuideHeadDeltaBlock(workspaceDir, 'lastseen01', {
    contextDelta: async () => ({ drift: 'none', commits: [], overflowLine: null }),
  });
  assert.equal(block, null);
});

test('loadGuideHeadDeltaBlock: drift "unknown" (garbage/rewritten sha) → caution block, not the classified list', async () => {
  const projDir = makeProjDir('drift-unknown');
  const workspaceDir = path.join(projDir, 'workspace');
  const block = await loadGuideHeadDeltaBlock(workspaceDir, 'gone-after-rebase', {
    contextDelta: async () => ({ drift: 'unknown', commits: [], overflowLine: null }),
  });
  assert.ok(block.includes('<context_delta>'));
  assert.ok(block.includes('could not be verified'));
  assert.ok(!block.includes('EXTERNAL = pushed outside this pipeline'));
});

test('loadGuideHeadDeltaBlock: fail-open — a throwing injected contextDelta is caught, returns null, logs a [guide-head-delta]-tagged warning', async () => {
  const projDir = makeProjDir('throw');
  const workspaceDir = path.join(projDir, 'workspace');
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (msg) => { warnings.push(String(msg)); };
  let block;
  try {
    block = await loadGuideHeadDeltaBlock(workspaceDir, 'lastseen01', {
      contextDelta: async () => { throw new Error('injected git failure'); },
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(block, null);
  assert.ok(warnings.some((w) => w.includes('guide-head-delta')));
});

test('loadGuideHeadDeltaBlock: byte-identical across calls for unchanged inputs', async () => {
  const projDir = makeProjDir('stable');
  const workspaceDir = path.join(projDir, 'workspace');
  const deps = {
    contextDelta: async () => ({
      drift: 'some',
      commits: [{ sha: 'ext0000001', subject: 'Manual hotfix', classification: 'external' }],
      overflowLine: null,
    }),
  };
  const a = await loadGuideHeadDeltaBlock(workspaceDir, 'lastseen01', deps);
  const b = await loadGuideHeadDeltaBlock(workspaceDir, 'lastseen01', deps);
  assert.equal(a, b);
});

// ─── appendHandoffAnchor ─────────────────────────────────────────────────────

test('appendHandoffAnchor: appends the commit anchor line when absent', async () => {
  const projDir = makeProjDir('anchor-append');
  const handoffFile = path.join(projDir, '.guide', 'handoff-test.md');
  writeFileSync(handoffFile, '# Handoff\n\nState: phase 3 complete.\n');

  const changed = await appendHandoffAnchor(handoffFile, 'deadbeef1234');
  assert.equal(changed, true);

  const contents = readFileSync(handoffFile, 'utf-8');
  assert.ok(contents.endsWith('Generated at commit: deadbeef1234\n'));
  assert.ok(contents.includes('State: phase 3 complete.'), 'original body is preserved');
});

test('appendHandoffAnchor: idempotent — a second call for the same sha does not duplicate the line', async () => {
  const projDir = makeProjDir('anchor-idempotent');
  const handoffFile = path.join(projDir, '.guide', 'handoff-test.md');
  writeFileSync(handoffFile, '# Handoff\n\nState: phase 3 complete.\n');

  await appendHandoffAnchor(handoffFile, 'deadbeef1234');
  const secondChanged = await appendHandoffAnchor(handoffFile, 'deadbeef1234');
  assert.equal(secondChanged, false, 'anchor already present — no-op');

  const contents = readFileSync(handoffFile, 'utf-8');
  const occurrences = contents.split('Generated at commit: deadbeef1234').length - 1;
  assert.equal(occurrences, 1, 'the anchor line must appear exactly once');
});

test('appendHandoffAnchor: file does not exist → false, no throw', async () => {
  const projDir = makeProjDir('anchor-missing');
  const handoffFile = path.join(projDir, '.guide', 'never-written.md');
  const changed = await appendHandoffAnchor(handoffFile, 'deadbeef1234');
  assert.equal(changed, false);
});

test('appendHandoffAnchor: missing sha or path → false, no throw', async () => {
  const projDir = makeProjDir('anchor-no-sha');
  const handoffFile = path.join(projDir, '.guide', 'handoff-test.md');
  writeFileSync(handoffFile, 'body');
  assert.equal(await appendHandoffAnchor(handoffFile, null), false);
  assert.equal(await appendHandoffAnchor(null, 'deadbeef1234'), false);
});

// ─── Source assertions — placement/ordering in phase-runner.js ─────────────
//
// Same convention as phase-runner-cache-discipline.test.mjs's tail: a full
// runGuide() call needs a live git+DB+billing fixture, so placement is
// asserted directly against the source instead.

const _phaseRunnerSrc = readFileSync(fileURLToPath(new URL('./phase-runner.js', import.meta.url)), 'utf-8');

test('runGuide(): guideHeadDelta is computed from metadata_json.last_guide_head_sha BEFORE the freshSessionTasks/sessionId decision', () => {
  const guideDeltaIdx = _phaseRunnerSrc.indexOf('const guideHeadDelta = await computeGuideHeadDelta(workspaceDir, lastGuideHeadSha);');
  const sessionIdIdx = _phaseRunnerSrc.indexOf('const sessionId = shouldReground ? null : (freshSessionTasks.includes(task) ? null : project.guide_session_id);');
  assert.ok(guideDeltaIdx > -1 && sessionIdIdx > -1, 'both anchors found in source');
  assert.ok(guideDeltaIdx < sessionIdIdx, 'guide-head delta must be computed before sessionId is chosen — the reground gate below it needs the same raw delta for its threshold decision');
});

test('runGuide(): phase 22 landed reground — sessionId is forced null on shouldReground regardless of freshSessionTasks/guide_session_id, exactly once', () => {
  const matches = _phaseRunnerSrc.match(/const sessionId = shouldReground \? null : \(freshSessionTasks\.includes\(task\) \? null : project\.guide_session_id\);/g) || [];
  assert.equal(matches.length, 1, 'exactly one sessionId computation, gated by shouldReground ahead of the pre-existing freshSessionTasks/guide_session_id branch');
});

test('runGuide(): shouldReground gate is derived from buildGuideRegroundReason over the same guideHeadDelta, and is skipped entirely for freshSessionTasks', () => {
  assert.match(_phaseRunnerSrc, /const regroundReason = freshSessionTasks\.includes\(task\)\s*\n\s*\? null\s*\n\s*: buildGuideRegroundReason\(\{ delta: guideHeadDelta, cfg: cfg\.guide_reground \}\);/);
  assert.match(_phaseRunnerSrc, /const shouldReground = !!regroundReason && !!guideHeadDelta\?\.headSha && guideHeadDelta\.headSha !== lastRegroundSha;/);
});

test('runGuide(): a reground clears guide_session_id, stamps metadata_json.last_reground_sha, and generates a handoff before the prompt is built', () => {
  const regroundIdx = _phaseRunnerSrc.indexOf('if (shouldReground) {');
  const setSessionIdx = _phaseRunnerSrc.indexOf("setGuideSessionId(projectName, null);");
  const stampRegroundIdx = _phaseRunnerSrc.indexOf("await setProjectMetadataField(projectName, 'last_reground_sha', guideHeadDelta.headSha);");
  const handoffCallIdx = _phaseRunnerSrc.indexOf("const handoffResult = await runGuide({ projectName, task: 'handoff', slot }, deps);");
  const promptIdx = _phaseRunnerSrc.indexOf('const prompt = await buildGuidePrompt({');
  assert.ok(regroundIdx > -1 && setSessionIdx > -1 && stampRegroundIdx > -1 && handoffCallIdx > -1 && promptIdx > -1, 'all anchors found in source');
  assert.ok(regroundIdx < handoffCallIdx && handoffCallIdx < setSessionIdx && setSessionIdx < stampRegroundIdx && stampRegroundIdx < promptIdx,
    'reground action order: generate handoff, clear session, stamp last_reground_sha — all before the prompt (which needs handoffCtx) is built');
});

test('runGuide(): the returned result attaches _guide_reground (reason + notifyText) so auto-runner.js can deliver the Telegram notice', () => {
  // Phase 31: the field composition gained a fallback to the (independent)
  // token-based compaction trigger's own reason/notifyText, used only when
  // the drift-based reground above didn't already populate them — drift
  // still wins outright. See phase-runner-guide-compaction.test.mjs for the
  // end-to-end behavior this composition enables.
  assert.match(_phaseRunnerSrc, /_guide_reground: \{\s*reason: regroundReason \|\| compactionReason,\s*notifyText: regroundNotifyText \|\| compactionNotifyText,\s*\},/);
});

test('runGuide(): handoffOutPath is computed exactly once and passed into buildGuidePrompt, reused (not recomputed) for the post-call anchor append', () => {
  const computeIdx = _phaseRunnerSrc.indexOf("const handoffOutPath = task === 'handoff' ? handoffPath(projDir) : null;");
  // Phase 32 threads the once-detected incremental-audit result (auditIncremental)
  // into buildGuidePrompt so its 'audit' case consumes it instead of re-detecting.
  // Phase 52 reformatted this call onto multiple lines (reviewPhaseN/pinnedWorktree added).
  const passIdx = _phaseRunnerSrc.indexOf('const prompt = await buildGuidePrompt({\n    task, projectName, projDir, project, plan, brief, round, fix, cfg, handoffOutPath, auditIncremental,');
  const appendIdx = _phaseRunnerSrc.indexOf("if (task === 'handoff' && !result.is_error && handoffOutPath) {");
  assert.ok(computeIdx > -1 && passIdx > -1 && appendIdx > -1, 'all three anchors found in source');
  assert.ok(computeIdx < passIdx && passIdx < appendIdx, 'computed once, passed to the prompt builder, then reused post-call');

  // handoffPath(projDir) must be CALLED exactly once inside runGuide() — the
  // handoffOutPath assignment itself. A second call anywhere else in
  // runGuide() would mint a mismatched timestamp. Only counts actual code
  // lines (skips comment prose that happens to mention the call).
  const runGuideStart = _phaseRunnerSrc.indexOf('export async function runGuide(');
  const runGuideEnd = _phaseRunnerSrc.indexOf('\nasync function runTwoStageAudit(', runGuideStart);
  const runGuideBody = _phaseRunnerSrc.slice(runGuideStart, runGuideEnd);
  const codeCalls = runGuideBody
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .filter((line) => line.includes('handoffPath(projDir)'));
  assert.equal(codeCalls.length, 1, 'handoffPath(projDir) must be called exactly once in runGuide() (only in the handoffOutPath assignment)');
});

test('runGuide(): last_guide_head_sha tracking runs for role==="guide" successes only (excludes the roleless lessons-distill call)', () => {
  assert.match(_phaseRunnerSrc, /if \(!result\.is_error && role === 'guide'\) \{\s*\n\s*try \{\s*\n\s*if \(await isGitRepo\(workspaceDir\)\) \{\s*\n\s*const sha = await getHeadSha\(workspaceDir\);\s*\n\s*if \(sha\) await setProjectMetadataField\(projectName, 'last_guide_head_sha', sha\);/);
});

test('runTwoStageAudit(): also tracks last_guide_head_sha on a successful full audit (a two-stage audit is a guide-role call too)', () => {
  const fnStart = _phaseRunnerSrc.indexOf('async function runTwoStageAudit(');
  const fnEnd = _phaseRunnerSrc.indexOf('\nexport async function runDev(', fnStart);
  const body = _phaseRunnerSrc.slice(fnStart, fnEnd);
  assert.match(body, /setProjectMetadataField\(projectName, 'last_guide_head_sha', sha\)/);
});
