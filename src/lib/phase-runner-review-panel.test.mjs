// Phase 36 (panel review) — fixture tests for runGuide()'s panel path:
// task:'review' + reviewMode:'panel' spawns lens 1 (the existing full review
// call, targeting after-N-lens-1.md), then lenses 2/3 SEQUENTIALLY as fresh,
// roleless, tool-scoped calls, then merges all three into the SAME
// reviewPath a full/light review would use. Mirrors
// phase-runner-review-light.test.mjs's fixture-project + deps.runClaude seam
// pattern so assertions read the REAL args passed to the mocked runClaude —
// and the merged file is verified against the REAL tryReviewAutoProceed.
//
// Run with: node --test src/lib/phase-runner-review-panel.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DB_PATH = ':memory:';

const { runGuide, buildReviewContextBlock, buildBugPlanContextBlock } = await import('./phase-runner.js');
const { reviewPath, reviewLensPath, phaseReportPath, phaseLedgerPath, bugsFilePath, bugRoundDir } = await import('./guide-paths.js');
const { upsertProject, deleteProject, setGuideSessionId, getProject, parseProjectMetadata } = await import('../state.js');
const { tryReviewAutoProceed } = await import('../auto-runner.js');
const { execFileSync } = await import('node:child_process');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

async function makeFixture(label) {
  const name = `test-review-panel-${label}-${randomUUID()}`;
  const projDir = path.join(PROJECTS_DIR, name);
  const guideDir = path.join(projDir, '.guide');
  await fs.mkdir(guideDir, { recursive: true });
  await fs.writeFile(path.join(guideDir, 'plan.json'), JSON.stringify({
    phases: [
      { n: 1, title: 'Phase One' },
      { n: 2, title: 'Phase Two' },
      { n: 3, title: 'Phase Three' },
    ],
  }), 'utf-8');
  await fs.writeFile(path.join(guideDir, 'brief.md'), '# Brief\n\nTest brief.\n', 'utf-8');
  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
    $schema_version: 1, name, created_at: new Date(0).toISOString(),
    overrides: { repo_map: { enabled: false } },
  }), 'utf-8');

  upsertProject({ name, tech_stack: 'node', total_phases: 3 });
  return { name, projDir };
}

async function cleanup(projDir, name) {
  await fs.rm(projDir, { recursive: true, force: true }).catch(() => {});
  try { deleteProject(name); } catch { /* ignore */ }
}

// The stub's job is to simulate what each real spawn's own Write tool call
// would do: lens 1 (a normal role:'guide' call) and lenses 2/3 (role:null,
// Write in their tools allowlist) each write their OWN lens file — the
// orchestrator never writes lens content itself, only the deterministic merge.
function makeStub({ writeLens1 = true, writeLens2 = true, writeLens3 = true } = {}) {
  const calls = [];
  const runClaude = async (opts) => {
    calls.push(opts);
    if (opts.task === '3-phase-review' && writeLens1) {
      const m = opts.prompt.match(/Write to: (.+)/);
      const out = path.resolve(opts.cwd, m[1].trim());
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, 'Lens 1 guide review looks solid, decisions logged.\n\nverdict: continue\nscore: 90\n', 'utf-8');
      return { result: 'ok', session_id: 'lens-1-session-id', is_error: false, last_turn_context_tokens: null };
    }
    if (opts.task === 'review-lens') {
      const m = opts.prompt.match(/Write to: (.+)/);
      const out = path.resolve(opts.cwd, m[1].trim());
      const isLens2 = opts.systemPromptExtra.includes('SECURITY');
      const shouldWrite = isLens2 ? writeLens2 : writeLens3;
      if (shouldWrite) {
        await fs.mkdir(path.dirname(out), { recursive: true });
        const body = isLens2
          ? 'No security issues found.\n\nverdict: continue\nscore: 88\n'
          : 'Consistent with brief conventions.\n\nverdict: continue\nscore: 92\n';
        await fs.writeFile(out, body, 'utf-8');
      }
      // Lens 2/3 spawns are role:null/sessionId:null — a returned session_id
      // here (as claude-runner would forward) must never be recorded, since
      // role is null.
      return { result: 'ok', session_id: `lens-spawn-session-${opts.task}-${isLens2 ? 2 : 3}`, is_error: false, last_turn_context_tokens: null };
    }
    throw new Error(`unexpected task in panel test stub: ${opts.task}`);
  };
  return { calls, runClaude };
}

test('panel review: THREE SEQUENTIAL spawns — lens 1 (3-phase-review, resumed guide), then lens 2, then lens 3 (review-lens, roleless/scoped)', async () => {
  const { name, projDir } = await makeFixture('sequential');
  try {
    const { calls, runClaude } = makeStub();
    const result = await runGuide({
      projectName: name,
      task: 'review',
      reviewMode: 'panel',
      reviewBatch: [
        { n: 1, title: 'Phase One', verifyVerdict: 'fail' },
        { n: 2, title: 'Phase Two', verifyVerdict: 'pass' },
      ],
      reviewChangedFiles: Array.from({ length: 45 }, (_, i) => `workspace/file-${i}.js`),
    }, { runClaude });

    assert.equal(result.is_error, false);
    assert.equal(calls.length, 3, 'exactly three spawns: lens 1 + lens 2 + lens 3');
    assert.equal(calls[0].task, '3-phase-review');
    assert.equal(calls[1].task, 'review-lens');
    assert.equal(calls[2].task, 'review-lens');

    // Sequential, not parallel: each call must have been made (and its
    // stub side effect — writing its own lens file — completed) before the
    // next one was invoked. We assert this indirectly: lens 2's prompt asks
    // about security, lens 3's about consistency, and they arrive in that
    // fixed order every time (a Promise.all-based implementation could still
    // produce this order by luck once, but never deterministically across
    // multiple runs with real async spawns — the source-level check below
    // pins the actual code path).
    assert.match(calls[1].systemPromptExtra, /SECURITY/);
    assert.match(calls[2].systemPromptExtra, /CONSISTENCY/);

    // Lens 2/3: role:null + sessionId:null + read-mostly + Write allowlist.
    for (const c of [calls[1], calls[2]]) {
      assert.equal(c.role, null);
      assert.equal(c.sessionId, null);
      assert.equal(c.systemPromptFile, null);
      const tools = c.cfg.tools.allowed_default;
      assert.ok(tools.includes('Write'), 'lens 2/3 need Write to author their own lens file');
      assert.ok(!tools.includes('Edit'), 'no Edit tool for lens 2/3');
      assert.ok(!tools.some((t) => t === 'Bash' || t === 'Bash(*)'), 'no unrestricted Bash for lens 2/3');
      assert.deepEqual([...tools].sort(), ['Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Glob', 'Grep', 'Read', 'Write'].sort());
    }

    // The merged file exists at the SAME reviewPath a full/light review uses.
    const mergedPath = reviewPath(projDir, 0);
    const mergedContent = await fs.readFile(mergedPath, 'utf-8');
    assert.match(mergedContent, /## Lens 1/);
    assert.match(mergedContent, /## Lens 2/);
    assert.match(mergedContent, /## Lens 3/);
    const trailerLines = mergedContent.trim().split('\n').slice(-2);
    assert.match(trailerLines[0], /^verdict: continue$/);
    assert.match(trailerLines[1], /^score: 88$/, 'merged score is the MIN of 90/88/92');
  } finally {
    await cleanup(projDir, name);
  }
});

// guide_session_id (the DB column claude-runner.js's `--resume` continuity
// depends on) is only ever written by claude-runner.js's own internal
// `if (returnedSessionId && role && project) { ...; if (role === 'guide')
// setGuideSessionId(...) }` gate — role is the ENTIRE mechanism. Stubbing
// runClaude (this fixture's seam) bypasses that internal write for every
// call, including lens 1, so the only thing provable here (without spawning
// a real subprocess) is the regression this criterion cares about: lens 2/3
// carry role:null, so even if their stubbed result carries a fresh
// session_id, nothing in this call chain can route it into guide_session_id.
// A pre-set sentinel staying unchanged after the panel run is exactly that
// proof — mirrors phase-runner-review-light.test.mjs's identical pattern for
// the light-review path.
test('panel review: guide_session_id is left UNCHANGED by lens 2/3 (role:null) — only a role:"guide" call (lens 1) could ever touch it', async () => {
  const { name, projDir } = await makeFixture('session-id');
  try {
    setGuideSessionId(name, 'sentinel-should-not-change');
    const { calls, runClaude } = makeStub();
    await runGuide({
      projectName: name,
      task: 'review',
      reviewMode: 'panel',
      reviewBatch: [{ n: 1, title: 'Phase One', verifyVerdict: 'fail' }],
      reviewChangedFiles: ['workspace/a.js'],
    }, { runClaude });

    assert.equal(calls[1].role, null, 'lens 2 is roleless');
    assert.equal(calls[2].role, null, 'lens 3 is roleless');
    const after = getProject(name);
    assert.equal(after.guide_session_id, 'sentinel-should-not-change',
      'guide_session_id must be untouched by the roleless lens 2/3 spawns');
  } finally {
    await cleanup(projDir, name);
  }
});

test('panel review: only lens 1s prompt contains the decisions-append literal; lens 3s prompt/system-prompt explicitly says do NOT append to decisions.jsonl', async () => {
  const { name, projDir } = await makeFixture('decisions-contract');
  try {
    const { calls, runClaude } = makeStub();
    await runGuide({
      projectName: name,
      task: 'review',
      reviewMode: 'panel',
      reviewBatch: [{ n: 1, title: 'Phase One', verifyVerdict: 'fail' }],
      reviewChangedFiles: ['workspace/a.js'],
    }, { runClaude });

    const [lens1, lens2, lens3] = calls;
    assert.match(lens1.prompt, /ALSO maintain the rolling decisions log at \.guide\/decisions\.jsonl/,
      'lens 1 (the existing full review) keeps the decisions-append instruction');
    assert.doesNotMatch(lens2.prompt, /ALSO maintain the rolling decisions log/);
    assert.doesNotMatch(lens2.systemPromptExtra, /ALSO maintain the rolling decisions log/);
    assert.doesNotMatch(lens3.prompt, /ALSO maintain the rolling decisions log/);

    const lens3Text = `${lens3.systemPromptExtra}\n${lens3.prompt}`;
    assert.match(lens3Text, /do NOT append to decisions\.jsonl/i,
      'lens 3 explicitly disclaims appending to decisions.jsonl');
  } finally {
    await cleanup(projDir, name);
  }
});

test('panel review: a merged file passes tryReviewAutoProceed above threshold and is blocked below threshold', async () => {
  const { name, projDir } = await makeFixture('auto-proceed');
  try {
    const { runClaude } = makeStub();
    const result = await runGuide({
      projectName: name,
      task: 'review',
      reviewMode: 'panel',
      reviewBatch: [{ n: 1, title: 'Phase One', verifyVerdict: 'fail' }],
      reviewChangedFiles: ['workspace/a.js'],
    }, { runClaude });
    assert.equal(result.is_error, false);

    const action = { task: 'review', phaseN: 0 };
    const proceedAbove = await tryReviewAutoProceed({
      action, projDir, cfg: { auto_run: { review_auto_proceed_score_threshold: 80 } },
    });
    assert.equal(proceedAbove, true, 'merged score 88 >= threshold 80 -> auto-proceed');

    const proceedBelow = await tryReviewAutoProceed({
      action, projDir, cfg: { auto_run: { review_auto_proceed_score_threshold: 95 } },
    });
    assert.equal(proceedBelow, false, 'merged score 88 < threshold 95 -> pause');
  } finally {
    await cleanup(projDir, name);
  }
});

test('panel review: a missing lens 2 file (spawn produced nothing) merges as pause-and-fix/0 with a warning, and the panel never throws past lens 1', async () => {
  const { name, projDir } = await makeFixture('missing-lens');
  try {
    const { calls, runClaude } = makeStub({ writeLens2: false });
    const result = await runGuide({
      projectName: name,
      task: 'review',
      reviewMode: 'panel',
      reviewBatch: [{ n: 1, title: 'Phase One', verifyVerdict: 'fail' }],
      reviewChangedFiles: ['workspace/a.js'],
    }, { runClaude });

    assert.equal(result.is_error, false, 'a missing lens 2 file must not fail the review action — lens 1 already succeeded');
    assert.equal(calls.length, 3, 'lens 3 still runs even though lens 2 produced no file');

    const mergedContent = await fs.readFile(reviewPath(projDir, 0), 'utf-8');
    assert.match(mergedContent, /WARNING/);
    const trailerLines = mergedContent.trim().split('\n').slice(-2);
    assert.match(trailerLines[0], /^verdict: pause-and-fix$/);
    assert.match(trailerLines[1], /^score: 0$/);
  } finally {
    await cleanup(projDir, name);
  }
});

// ─── Phase 40 (CE-5): fresh, task-scoped review + bug-plan sessions ─────────

// A minimal fixture whose review is NOT a panel — a plain full/roleless review
// spawn. `overrides` lets a test flip guide_context.fresh_task_sessions off.
async function makeReviewFixture(label, overrides = {}) {
  const name = `test-p40-${label}-${randomUUID()}`;
  const projDir = path.join(PROJECTS_DIR, name);
  const guideDir = path.join(projDir, '.guide');
  await fs.mkdir(guideDir, { recursive: true });
  await fs.writeFile(path.join(guideDir, 'plan.json'), JSON.stringify({
    phases: [{ n: 1, title: 'Phase One' }, { n: 2, title: 'Phase Two' }],
  }), 'utf-8');
  await fs.writeFile(path.join(guideDir, 'brief.md'), '# Brief\n', 'utf-8');
  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
    $schema_version: 1, name, created_at: new Date(0).toISOString(),
    overrides: { repo_map: { enabled: false }, ...overrides },
  }), 'utf-8');
  upsertProject({ name, tech_stack: 'node', total_phases: 2 });
  return { name, projDir };
}

// Init a real git repo under workspace/ so runGuide's last_review_sha stamp
// (isGitRepo + getHeadSha) has something to read. No git_branch is set on the
// project, so runGuide's preflight/sync is skipped — this repo is only for the
// HEAD-sha stamp.
function initWorkspaceGit(projDir) {
  const ws = path.join(projDir, 'workspace');
  execFileSync('git', ['init', '-q', ws]);
  execFileSync('git', ['-C', ws, 'config', 'user.email', 't@t.t']);
  execFileSync('git', ['-C', ws, 'config', 'user.name', 't']);
  execFileSync('git', ['-C', ws, 'commit', '-q', '--allow-empty', '-m', 'init']);
  return execFileSync('git', ['-C', ws, 'rev-parse', 'HEAD']).toString().trim();
}

function makeReviewStub({ isError = false } = {}) {
  const calls = [];
  const runClaude = async (opts) => {
    calls.push(opts);
    const m = opts.prompt.match(/Write to: (.+)/);
    if (m) {
    const out = path.resolve(opts.cwd, m[1].trim());
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, 'Full review body.\n\nverdict: continue\nscore: 90\n', 'utf-8');
    }
    return { result: 'ok', session_id: 'fresh-review-session', is_error: isError, last_turn_context_tokens: null };
  };
  return { calls, runClaude };
}

test('phase-40 flag ON (default): a full review passes sessionId:null + role:null and leaves guide_session_id UNCHANGED (the clobber the verdict caught)', async () => {
  const { name, projDir } = await makeReviewFixture('flagon-session');
  try {
    setGuideSessionId(name, 'guide-sentinel-keepme');
    const { calls, runClaude } = makeReviewStub();
    await runGuide({ projectName: name, task: 'review', reviewMode: 'full' }, { runClaude });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].task, '3-phase-review');
    assert.equal(calls[0].sessionId, null, 'fresh review must pass sessionId:null');
    assert.equal(calls[0].role, null, 'fresh review must be roleless (role:null) — role:"guide" would clobber guide_session_id');
    assert.equal(getProject(name).guide_session_id, 'guide-sentinel-keepme',
      'guide_session_id must be UNCHANGED by the roleless fresh review');
    // The assembled context is actually WIRED into the review prompt (not just
    // buildable in isolation — see the buildReviewContextBlock fixture tests
    // below for its full content). This fixture has no last_review_sha, so the
    // block carries the documented first-review note instead of a diff-stat.
    assert.match(calls[0].prompt, /<review_context>/, 'assembled review context rides the per-call prompt');
    assert.match(calls[0].prompt, /First review/, 'no last_review_sha → the documented first-review note');
  } finally {
    await cleanup(projDir, name);
  }
});

test('phase-40 flag OFF: review RESUMES the guide session (sessionId = guide_session_id, role:"guide") and its prompt carries NO <review_context> (byte-identical mode isolation)', async () => {
  const { name, projDir } = await makeReviewFixture('flagoff-review', { guide_context: { fresh_task_sessions: false } });
  try {
    setGuideSessionId(name, 'resumed-guide-session');
    const { calls, runClaude } = makeReviewStub();
    await runGuide({ projectName: name, task: 'review', reviewMode: 'full' }, { runClaude });

    assert.equal(calls[0].sessionId, 'resumed-guide-session', 'flag off resumes the guide session');
    assert.equal(calls[0].role, 'guide', 'flag off keeps role:"guide"');
    assert.doesNotMatch(calls[0].prompt, /<review_context>/, 'flag off injects no assembled review context');
  } finally {
    await cleanup(projDir, name);
  }
});

test('phase-40 flag OFF: bug-plan RESUMES (role:"guide") and its prompt carries NO <bug_plan_context> and NO repo map', async () => {
  const { name, projDir } = await makeReviewFixture('flagoff-bugplan', { guide_context: { fresh_task_sessions: false }, repo_map: { enabled: true } });
  try {
    setGuideSessionId(name, 'resumed-guide-session');
    await fs.mkdir(bugRoundDir(projDir, 1), { recursive: true });
    await fs.writeFile(bugsFilePath(projDir, 1), '# Bugs\n- BUG-1: thing broke\n', 'utf-8');
    const calls = [];
    const runClaude = async (opts) => { calls.push(opts); return { result: 'ok', session_id: 's', is_error: false, last_turn_context_tokens: null }; };
    await runGuide({ projectName: name, task: 'bug-plan', round: 1 }, { runClaude });

    assert.equal(calls[0].role, 'guide', 'flag off keeps bug-plan on role:"guide"');
    assert.equal(calls[0].sessionId, 'resumed-guide-session');
    assert.doesNotMatch(calls[0].prompt, /<bug_plan_context>/, 'flag off injects no assembled bug-plan context');
    assert.doesNotMatch(calls[0].prompt, /<repo_map>/, 'flag off suppresses the bug-plan repo-map injection');
  } finally {
    await cleanup(projDir, name);
  }
});

test('phase-40 flag ON: bug-plan runs roleless/fresh and inlines bugs.md verbatim', async () => {
  const { name, projDir } = await makeReviewFixture('flagon-bugplan');
  try {
    setGuideSessionId(name, 'guide-sentinel-keepme');
    await fs.mkdir(bugRoundDir(projDir, 1), { recursive: true });
    await fs.writeFile(bugsFilePath(projDir, 1), '# Bugs\n- BUG-1: the widget explodes on save\n', 'utf-8');
    const calls = [];
    const runClaude = async (opts) => { calls.push(opts); return { result: 'ok', session_id: 's', is_error: false, last_turn_context_tokens: null }; };
    await runGuide({ projectName: name, task: 'bug-plan', round: 1 }, { runClaude });

    assert.equal(calls[0].role, null, 'fresh bug-plan is roleless');
    assert.equal(calls[0].sessionId, null, 'fresh bug-plan is sessionless');
    assert.match(calls[0].prompt, /<bug_plan_context>/);
    assert.match(calls[0].prompt, /the widget explodes on save/, 'bugs.md is inlined verbatim');
    assert.equal(getProject(name).guide_session_id, 'guide-sentinel-keepme', 'guide_session_id untouched by roleless bug-plan');
  } finally {
    await cleanup(projDir, name);
  }
});

test('phase-40: a SUCCESSFUL review stamps last_review_sha (workspace HEAD); a FAILED review does NOT', async () => {
  // Success case
  const ok = await makeReviewFixture('stamp-ok');
  try {
    const head = initWorkspaceGit(ok.projDir);
    const { runClaude } = makeReviewStub();
    await runGuide({ projectName: ok.name, task: 'review', reviewMode: 'full' }, { runClaude });
    const meta = parseProjectMetadata(getProject(ok.name).metadata_json);
    assert.equal(meta.last_review_sha, head, 'a successful review stamps last_review_sha = workspace HEAD');
  } finally { await cleanup(ok.projDir, ok.name); }

  // Failure case
  const bad = await makeReviewFixture('stamp-fail');
  try {
    initWorkspaceGit(bad.projDir);
    const { runClaude } = makeReviewStub({ isError: true });
    await runGuide({ projectName: bad.name, task: 'review', reviewMode: 'full' }, { runClaude });
    const meta = parseProjectMetadata(getProject(bad.name).metadata_json);
    assert.equal(meta.last_review_sha, undefined, 'a failed review must NOT stamp last_review_sha');
  } finally { await cleanup(bad.projDir, bad.name); }
});

// buildReviewContextBlock fixture tests (the assembled per-call review context).
async function seedReviewArtifacts(projDir) {
  const guideDir = path.join(projDir, '.guide');
  await fs.mkdir(guideDir, { recursive: true });
  await fs.writeFile(phaseLedgerPath(projDir),
    JSON.stringify({ n: 1, title: 'Phase One built the ledger', commit_sha: 'aaaa1111', bullets: ['added X', 'added Y', 'added Z'] }) + '\n'
    + JSON.stringify({ n: 2, title: 'Phase Two built the cache', commit_sha: 'bbbb2222', bullets: ['cache A', 'cache B', 'cache C'] }) + '\n', 'utf-8');
  await fs.writeFile(path.join(guideDir, 'decisions.jsonl'),
    JSON.stringify({ phase: '1', title: 'error envelope', decision: 'always use {error:{code}}', rationale: 'clients branch on code', type: 'convention' }) + '\n', 'utf-8');
  await fs.mkdir(path.join(guideDir, 'reviews'), { recursive: true });
  await fs.writeFile(reviewPath(projDir, 2), 'Prior review body.\n\nverdict: continue\nscore: 77\n', 'utf-8');
  const rp1 = await phaseReportPath(projDir, 1, 'Phase One');
  await fs.mkdir(path.dirname(rp1), { recursive: true });
  await fs.writeFile(rp1, 'PHASE ONE REPORT LINE\nmore detail here\n', 'utf-8');
}

test('phase-40 buildReviewContextBlock: WITH last_review_sha → contains diff-stat, batch ledger, decisions tail, and prior verdict', async () => {
  const { name, projDir } = await makeReviewFixture('ctx-withsha');
  try {
    await seedReviewArtifacts(projDir);
    const project = { metadata_json: JSON.stringify({ last_review_sha: 'deadbeefcafe1234' }), current_phase: 3 };
    const block = await buildReviewContextBlock(
      { projDir, project, plan: null, cfg: { paths: { workspace_subdir: 'workspace' } },
        reviewBatch: [{ n: 1, title: 'Phase One' }, { n: 2, title: 'Phase Two' }] },
      { diffStatDetailedSince: async () => ({ ok: true, text: 'src/a.js | 5 +++--\n 1 file changed, 3 insertions(+), 2 deletions(-)' }) },
    );
    assert.match(block, /<review_context>/);
    assert.match(block, /git diff --stat deadbeef\.\.HEAD/, 'diff-stat header present');
    assert.match(block, /1 file changed, 3 insertions/, 'diff-stat body present');
    assert.match(block, /Phase One built the ledger/, 'batch ledger entry present');
    assert.match(block, /error envelope/, 'decisions tail present');
    assert.match(block, /Prior review \(after phase 2\)/, 'prior review outcome present');
    assert.match(block, /score: 77/, 'prior review score parsed');
    assert.match(block, /PHASE ONE REPORT LINE/, 'per-phase report excerpt present');
  } finally {
    await cleanup(projDir, name);
  }
});

test('phase-40 buildReviewContextBlock: NO last_review_sha (first review) → omits the diff block and carries the documented first-review note', async () => {
  const { name, projDir } = await makeReviewFixture('ctx-nosha');
  try {
    await seedReviewArtifacts(projDir);
    const project = { metadata_json: JSON.stringify({}), current_phase: 3 };
    let diffCalled = false;
    const block = await buildReviewContextBlock(
      { projDir, project, plan: null, cfg: { paths: { workspace_subdir: 'workspace' } },
        reviewBatch: [{ n: 1, title: 'Phase One' }] },
      { diffStatDetailedSince: async () => { diffCalled = true; return { ok: true, text: 'x' }; } },
    );
    assert.match(block, /First review/, 'documented first-review note present');
    assert.doesNotMatch(block, /git diff --stat/, 'no diff block when there is no last_review_sha');
    assert.equal(diffCalled, false, 'the git diff is never even attempted without a baseline sha');
  } finally {
    await cleanup(projDir, name);
  }
});

test('panel review: reviewMode absent/"full" is unaffected — falls through to the normal single-review path (no lens spawns, no lens files)', async () => {
  const { name, projDir } = await makeFixture('full-fallthrough');
  try {
    const calls = [];
    const runClaude = async (opts) => {
      calls.push(opts);
      const m = opts.prompt.match(/Write to: (.+)/);
      const out = path.resolve(opts.cwd, m[1].trim());
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, 'Full review body.\n\nverdict: continue\nscore: 90\n', 'utf-8');
      return { result: 'ok', session_id: 'full-review-session', is_error: false, last_turn_context_tokens: null };
    };

    await runGuide({ projectName: name, task: 'review', reviewMode: 'full' }, { runClaude });

    assert.equal(calls.length, 1, 'full mode is still a single spawn — no panel fan-out');
    assert.equal(calls[0].task, '3-phase-review');
    const lens1Exists = await fs.access(reviewLensPath(projDir, 0, 1)).then(() => true, () => false);
    assert.equal(lens1Exists, false, 'full mode never writes a lens-1 file — Write to: targets the plain reviewPath');
  } finally {
    await cleanup(projDir, name);
  }
});

test('full review recovers a legacy artifact written under workspace/.guide and prevents a duplicate review', async () => {
  const { name, projDir } = await makeFixture('misplaced-review-recovery');
  try {
    const misplaced = path.join(projDir, 'workspace', '.guide', 'reviews', 'after-0.md');
    const canonical = reviewPath(projDir, 0);
    const runClaude = async () => {
      await fs.mkdir(path.dirname(misplaced), { recursive: true });
      await fs.writeFile(misplaced, 'Recovered review.\n\nverdict: continue\nscore: 91\n', 'utf-8');
      return { result: 'ok', session_id: 'misplaced-review-session', is_error: false, last_turn_context_tokens: null };
    };
    await runGuide({ projectName: name, task: 'review', reviewMode: 'full' }, { runClaude });
    assert.equal(await fs.readFile(canonical, 'utf-8'), 'Recovered review.\n\nverdict: continue\nscore: 91\n');
    assert.equal(await fs.access(misplaced).then(() => true, () => false), false, 'legacy file was moved, not copied');
  } finally {
    await cleanup(projDir, name);
  }
});
