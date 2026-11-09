// Tests for phase-52 (P3 / par-03) — concurrent advisory 3-phase reviews.
// Stops a mid-stream 3-phase review from blocking phase N+1's dispatch. Covers:
//   A. spawnDetachedReview   — worktree pinning against a REAL temp git repo:
//      pins to phase N's OWN commit (phaseCommitSha) even after the main tree
//      has advanced to N+1/N+2; falls back to the live HEAD when no phase-N
//      commit message exists; falls back to pinnedWorktree:null when NO sha
//      resolves at all (empty repo); worktree removed after settle on BOTH
//      success and a runGuide throw; the returned promise NEVER rejects.
//   B. runGuide() phaseN + pinnedWorktree (verdict corrections 1+2) — the
//      review's reviewPath/prompt/reviewLensPath target the EXPLICIT phaseN,
//      not project.current_phase (which may have advanced past it by the
//      time this call runs); a pinned call skips git preflight/sync entirely
//      (proven against a project.git_branch that would otherwise throw); the
//      prompt's code root points at the pinned dir, never literal 'workspace/'.
//   C. pickNextAction        — pendingReviewPhaseN treats an in-flight
//      background review's phase as already satisfied, returning the NEXT
//      phase's dev action instead of re-firing the review.
//   D. settleReviewOutcome   — BLOCKER pauses; a passing score auto-proceeds;
//      an is_error result the healer fixes retries; one the healer can't fix
//      routes through the SAME phase-error pause a synchronous guide failure
//      gets; a successful review still persists reviewNextConsecutiveLight.
//   E. source assertions     — loop wiring order: the pendingVerify barrier
//      settles BEFORE a review ever fires; isFinalReview is never deferred;
//      cap-1 (a second due review awaits the first); finalize() awaits
//      pendingReview on every terminal path.
//
// No real `claude` subprocess is ever spawned.
//
// Run with: node --test src/lib/review-async.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.env.DB_PATH = ':memory:';

const { runGuide } = await import('./phase-runner.js');
const { reviewPath, worktreesRoot } = await import('./guide-paths.js');
const { getHeadSha, addDetachedWorktree } = await import('./git.js');
const {
  upsertProject, deleteProject, setProjectGitConfig, setCurrentPhase,
  upsertPhase, markPhaseCompleted, getProject, parseProjectMetadata,
} = await import('../state.js');
const { spawnDetachedReview, settleReviewOutcome, pickNextAction } = await import('../auto-runner.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

// ─── shared fixture helpers ─────────────────────────────────────────────────

function makeProjDir(label) {
  const d = mkdtempSync(path.join(tmpdir(), `aorch-review-async-${label}-`));
  mkdirSync(path.join(d, '.guide'), { recursive: true });
  return d;
}

function makeRepo(label) {
  const projDir = makeProjDir(label);
  const workspaceDir = mkdtempSync(path.join(tmpdir(), `aorch-review-async-ws-${label}-`));
  execSync('git init -q', { cwd: workspaceDir });
  execSync('git config user.email t@example.com', { cwd: workspaceDir });
  execSync('git config user.name test', { cwd: workspaceDir });
  return { projDir, workspaceDir };
}

function commitPhase(workspaceDir, n, file, content) {
  writeFileSync(path.join(workspaceDir, file), content);
  execSync('git add -A', { cwd: workspaceDir });
  execSync(`git commit -q -m ${JSON.stringify(`phase-${n}: did stuff`)}`, { cwd: workspaceDir });
}

async function cleanupProjDir(name) {
  await fs.rm(path.join(PROJECTS_DIR, name), { recursive: true, force: true }).catch(() => {});
  try { deleteProject(name); } catch { /* may not exist */ }
}

// ─── A. spawnDetachedReview — worktree pinning (real git repo) ─────────────

test('spawnDetachedReview: pins the worktree to phase N\'s OWN commit (phaseCommitSha) even after the main tree has advanced to N+1', async () => {
  const { projDir, workspaceDir } = makeRepo('pin');
  commitPhase(workspaceDir, 5, 'a.js', 'const a = 1;\n');
  const phase5Sha = await getHeadSha(workspaceDir);
  // Phase N+1 lands on the live workspace WHILE phase 5's review is in flight.
  commitPhase(workspaceDir, 6, 'a.js', 'const a = 2;\n');
  const phase6Sha = await getHeadSha(workspaceDir);
  assert.notEqual(phase5Sha, phase6Sha);

  let seenPinnedWorktree = null;
  let headDuringCall = null;
  let existedDuringCall = false;
  const { promise, phaseN, action, state } = spawnDetachedReview(
    { cfg: {}, projectName: 'demo', projDir, workspaceDir, action: { kind: 'guide', task: 'review', phaseN: 5, label: 'Run review after phase 5' } },
    {
      runGuide: async (args) => {
        seenPinnedWorktree = args.pinnedWorktree;
        headDuringCall = await getHeadSha(args.pinnedWorktree);
        existedDuringCall = existsSync(args.pinnedWorktree);
        assert.equal(args.phaseN, 5);
        assert.equal(args.task, 'review');
        return { result: 'ok', is_error: false };
      },
    },
  );
  assert.equal(phaseN, 5);
  assert.equal(action.phaseN, 5);
  assert.equal(state.settled, false, 'not settled synchronously — the whole point is NOT to block on this');

  const result = await promise;
  assert.equal(result.is_error, false);
  assert.equal(state.settled, true);
  assert.equal(headDuringCall, phase5Sha, 'the pinned worktree reads phase 5\'s commit, NOT the advanced live HEAD');
  assert.equal(existedDuringCall, true, 'worktree existed while runGuide ran');
  const wtDir = path.join(worktreesRoot(projDir), `review-5-${phase5Sha.slice(0, 8)}`);
  assert.equal(seenPinnedWorktree, wtDir);
  assert.ok(!existsSync(wtDir), 'worktree removed after the review settles');
});

test('spawnDetachedReview: falls back to the live HEAD when no phase-N commit message exists', async () => {
  const { projDir, workspaceDir } = makeRepo('fallback');
  execSync('git commit -q --allow-empty -m "some unrelated commit"', { cwd: workspaceDir });
  const head = await getHeadSha(workspaceDir);

  let seenHead = null;
  const { promise } = spawnDetachedReview(
    { cfg: {}, projectName: 'demo', projDir, workspaceDir, action: { kind: 'guide', task: 'review', phaseN: 9, label: 'x' } },
    { runGuide: async (args) => { seenHead = await getHeadSha(args.pinnedWorktree); return { is_error: false }; } },
  );
  const result = await promise;
  assert.equal(result.is_error, false);
  assert.equal(seenHead, head, 'falls back to the current live HEAD when phaseCommitSha finds nothing');
});

test('spawnDetachedReview: no sha resolves at all (empty repo) — runs with pinnedWorktree:null instead of throwing', async () => {
  const { projDir, workspaceDir } = makeRepo('empty');
  let seenPinned = 'unset';
  const { promise } = spawnDetachedReview(
    { cfg: {}, projectName: 'demo', projDir, workspaceDir, action: { kind: 'guide', task: 'review', phaseN: 1, label: 'x' } },
    { runGuide: async (args) => { seenPinned = args.pinnedWorktree; return { is_error: false }; } },
  );
  const result = await promise;
  assert.equal(seenPinned, null, 'no commit at all to pin to — falls back to a best-effort live read');
  assert.equal(result.is_error, false);
});

test('spawnDetachedReview: the worktree is removed even when runGuide THROWS, and the returned promise never rejects', async () => {
  const { projDir, workspaceDir } = makeRepo('throw');
  commitPhase(workspaceDir, 2, 'a.js', 'x\n');
  const sha = await getHeadSha(workspaceDir);
  const wtDir = path.join(worktreesRoot(projDir), `review-2-${sha.slice(0, 8)}`);

  const { promise } = spawnDetachedReview(
    { cfg: {}, projectName: 'demo', projDir, workspaceDir, action: { kind: 'guide', task: 'review', phaseN: 2, label: 'x' } },
    { runGuide: async () => { throw new Error('guide boom'); } },
  );
  const settled = await promise; // must NOT throw — advisory-only, barrier-safe
  assert.equal(settled.is_error, true);
  assert.match(settled.error_message, /guide boom/);
  assert.ok(!existsSync(wtDir), 'worktree removed despite the throw (finally still ran)');
});

// ─── B. runGuide() phaseN + pinnedWorktree ─────────────────────────────────

async function makeReviewFixture(label, overrides = {}) {
  const name = `test-review-async-${label}-${randomUUID()}`;
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
  upsertProject({ name, tech_stack: 'node', total_phases: 6 });
  return { name, projDir };
}

function makeReviewStub({ isError = false } = {}) {
  const calls = [];
  const runClaude = async (opts) => {
    calls.push(opts);
    const m = opts.prompt.match(/Write to: (.+)/);
    if (m) {
      const requested = m[1].trim();
      const out = path.isAbsolute(requested) ? requested : path.join(opts.cwd, requested);
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, 'Full review body.\n\nverdict: continue\nscore: 90\n', 'utf-8');
    }
    return { result: 'ok', session_id: 'fresh-review-session', is_error: isError, last_turn_context_tokens: null };
  };
  return { calls, runClaude };
}

test('runGuide(): reviewPath/prompt target the EXPLICIT phaseN, not project.current_phase — even after current_phase has advanced past it', async () => {
  const { name, projDir } = await makeReviewFixture('explicit-phasen');
  setCurrentPhase(name, 6); // an overlapped dev already landed phase(s) past 5 while this review is still in flight
  try {
    const { calls, runClaude } = makeReviewStub();
    const result = await runGuide({ projectName: name, task: 'review', reviewMode: 'full', phaseN: 5 }, { runClaude });

    assert.equal(result.is_error, false);
    assert.equal(calls.length, 1);
    assert.match(calls[0].prompt, /Conduct a review for project "[^"]+" at phase 5\./);
    const m = calls[0].prompt.match(/Write to: (.+)/);
    const requested = m[1].trim();
    assert.equal(path.isAbsolute(requested) ? requested : path.join(projDir, requested), reviewPath(projDir, 5), 'writes to phase 5\'s review file, not phase 6\'s');
    const written = await fs.readFile(reviewPath(projDir, 5), 'utf-8');
    assert.match(written, /verdict: continue/);
  } finally {
    await cleanupProjDir(name);
  }
});

test('runGuide(): a pinnedWorktree call skips git preflight/sync entirely — the SAME project.git_branch that otherwise throws causes no error when pinned', async () => {
  const { name, projDir } = await makeReviewFixture('pinned-preflight-skip');
  setProjectGitConfig(name, { git_branch: 'develop' });
  const ws = path.join(projDir, 'workspace');
  execFileSync('git', ['init', '-q', ws]);
  execFileSync('git', ['-C', ws, 'config', 'user.email', 't@t.t']);
  execFileSync('git', ['-C', ws, 'config', 'user.name', 't']);
  execFileSync('git', ['-C', ws, 'commit', '-q', '--allow-empty', '-m', 'phase-5: work']);
  const sha5 = execFileSync('git', ['-C', ws, 'rev-parse', 'HEAD']).toString().trim();

  try {
    // Sanity check: WITHOUT pinnedWorktree, this exact setup (no origin
    // remote configured) throws at the preflight gate — proves the skip
    // below is caused by pinnedWorktree, not an accidental pass-through.
    const { runClaude: rc1 } = makeReviewStub();
    await assert.rejects(
      runGuide({ projectName: name, task: 'review', reviewMode: 'full' }, { runClaude: rc1 }),
      /Git pre-flight failed/,
    );

    const pinnedDir = path.join(projDir, '.worktrees', `review-5-${sha5.slice(0, 8)}`);
    execFileSync('git', ['-C', ws, 'worktree', 'add', '--detach', pinnedDir, sha5]);
    try {
      const { calls, runClaude } = makeReviewStub();
      const result = await runGuide({
        projectName: name, task: 'review', reviewMode: 'full', phaseN: 5, pinnedWorktree: pinnedDir,
      }, { runClaude });
      assert.equal(result.is_error, false, 'pinned call succeeds — preflight/sync were skipped, never attempted');
      assert.equal(calls.length, 1);
    } finally {
      execFileSync('git', ['-C', ws, 'worktree', 'remove', '--force', pinnedDir]);
    }
  } finally {
    await cleanupProjDir(name);
  }
});

test('runGuide(): a pinnedWorktree call\'s prompt points its code root at the pinned dir (never literal "workspace/") and carries the pinned-phase note', async () => {
  const { name, projDir } = await makeReviewFixture('pinned-code-root');
  const pinnedDir = path.join(projDir, '.worktrees', 'review-5-deadbeef');
  await fs.mkdir(pinnedDir, { recursive: true });
  try {
    const { calls, runClaude } = makeReviewStub();
    await runGuide({
      projectName: name, task: 'review', reviewMode: 'full', phaseN: 5, pinnedWorktree: pinnedDir,
    }, { runClaude });

    assert.match(calls[0].prompt, /This review's code root is pinned to phase 5's commit/);
    assert.match(calls[0].prompt, /Read \.guide\/plan\.json, .*\.worktrees\/review-5-deadbeef\/, recent/);
    assert.doesNotMatch(calls[0].prompt, /Read \.guide\/plan\.json, .*workspace\/, recent/);
  } finally {
    await cleanupProjDir(name);
  }
});

test('runGuide(): NO pinnedWorktree (every existing caller) keeps the literal "workspace/" code root, byte-identical to before phase-52', async () => {
  const { name } = await makeReviewFixture('unpinned-unchanged');
  try {
    const { calls, runClaude } = makeReviewStub();
    await runGuide({ projectName: name, task: 'review', reviewMode: 'full' }, { runClaude });

    assert.doesNotMatch(calls[0].prompt, /pinned to phase/);
    assert.match(calls[0].prompt, /Read \.guide\/plan\.json, .*workspace\/, recent/);
  } finally {
    await cleanupProjDir(name);
  }
});

// ─── C. pickNextAction — pendingReviewPhaseN ────────────────────────────────

const PNA_CFG = {
  auto_run: { run_final_review_before_qa: false, audit_runs_after_completion: 0, warn_on_missing_phase_report: false },
  phases: { review_every_n_phases: 3 },
  paths: { workspace_subdir: 'workspace' },
  workspace_claude_md: { auto_generate_during_autorun: false },
  skip_analyze: { enabled: false },
  brief_conformance: { enabled: false },
};

async function makePlanFixture(name, plan) {
  const projDir = path.join(PROJECTS_DIR, name);
  const guideDir = path.join(projDir, '.guide');
  await fs.mkdir(guideDir, { recursive: true });
  await fs.writeFile(path.join(guideDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf-8');
  await fs.writeFile(path.join(guideDir, 'brief.md'), '# Brief\n\nTest brief.\n', 'utf-8');
  await fs.writeFile(path.join(guideDir, 'project-context.md'), '# Context\n\nTest.\n', 'utf-8');
  return projDir;
}

test('pickNextAction: pendingReviewPhaseN treats an in-flight background review as already satisfied — returns the NEXT phase\'s dev action instead of re-firing the review', async () => {
  const name = `pna-pending-review-${randomUUID()}`;
  const plan = {
    phases: [
      { n: 1, title: 'Phase 1', acceptance_criteria: ['a'] },
      { n: 2, title: 'Phase 2', acceptance_criteria: ['a'] },
      { n: 3, title: 'Phase 3', acceptance_criteria: ['a'] },
      { n: 4, title: 'Phase 4', acceptance_criteria: ['a'] },
    ],
  };
  const projDir = await makePlanFixture(name, plan);
  try {
    upsertProject({ name, tech_stack: 'node', total_phases: 4, status: 'in-progress' });
    setCurrentPhase(name, 3);
    for (const p of plan.phases.slice(0, 3)) {
      upsertPhase({ project: name, n: p.n, title: p.title, status: 'pending' });
      markPhaseCompleted({ project: name, n: p.n, commit_sha: `sha${p.n}` });
    }

    // Sanity: WITHOUT pendingReviewPhaseN, the review for phase 3 is due
    // (no review file on disk yet) — it would fire.
    const withoutPending = await pickNextAction(name, PNA_CFG);
    assert.equal(withoutPending.kind, 'guide');
    assert.equal(withoutPending.task, 'review');
    assert.equal(withoutPending.phaseN, 3);

    // A background review for phase 3 is already in flight — the SAME
    // phase's review must be treated as satisfied, and phase 4's dev action
    // returned instead, which is exactly what lets it dispatch immediately.
    const withPending = await pickNextAction(name, PNA_CFG, { pendingReviewPhaseN: 3 });
    assert.equal(withPending.kind, 'dev', 'phase 4 dispatches instead of re-firing phase 3\'s in-flight review');
    assert.equal(withPending.phaseN, 4);
  } finally {
    await fs.rm(projDir, { recursive: true, force: true }).catch(() => {});
    await cleanupProjDir(name);
  }
});

test('pickNextAction: a pendingReviewPhaseN for a DIFFERENT phase does not suppress the due review', async () => {
  const name = `pna-pending-review-diff-${randomUUID()}`;
  // A 4th phase must remain undone — otherwise completedPhase===lastPhaseN
  // routes into the "all phases done" branch (which precedes the mid-stream
  // review gate entirely), not the mid-stream review path this test targets.
  const plan = {
    phases: [
      { n: 1, title: 'Phase 1', acceptance_criteria: ['a'] },
      { n: 2, title: 'Phase 2', acceptance_criteria: ['a'] },
      { n: 3, title: 'Phase 3', acceptance_criteria: ['a'] },
      { n: 4, title: 'Phase 4', acceptance_criteria: ['a'] },
    ],
  };
  const projDir = await makePlanFixture(name, plan);
  try {
    upsertProject({ name, tech_stack: 'node', total_phases: 4, status: 'in-progress' });
    setCurrentPhase(name, 3);
    for (const p of plan.phases.slice(0, 3)) {
      upsertPhase({ project: name, n: p.n, title: p.title, status: 'pending' });
      markPhaseCompleted({ project: name, n: p.n, commit_sha: `sha${p.n}` });
    }

    // A background review is pending for a DIFFERENT phase (e.g. an earlier
    // cap-1 slot never applicable here since phase 3 is what's due) — the due
    // review for phase 3 must still fire.
    const result = await pickNextAction(name, PNA_CFG, { pendingReviewPhaseN: 999 });
    assert.equal(result.kind, 'guide');
    assert.equal(result.task, 'review');
    assert.equal(result.phaseN, 3);
  } finally {
    await fs.rm(projDir, { recursive: true, force: true }).catch(() => {});
    await cleanupProjDir(name);
  }
});

// ─── D. settleReviewOutcome — heal / auto-proceed / pause replay ───────────

test('settleReviewOutcome: a BLOCKER-marked review pauses (auto-proceed is suppressed)', async () => {
  const name = `settle-blocker-${randomUUID()}`;
  const projDir = path.join(PROJECTS_DIR, name);
  const rPath = reviewPath(projDir, 3);
  await fs.mkdir(path.dirname(rPath), { recursive: true });
  await fs.writeFile(rPath, 'BLOCKER: missing migration rollback.\n\nverdict: pause-and-fix\nscore: 95\n', 'utf-8');
  try {
    const outcome = await settleReviewOutcome({
      result: { is_error: false },
      action: { kind: 'guide', task: 'review', phaseN: 3 },
      cfg: { auto_run: { review_auto_proceed_score_threshold: 85, auto_pause_after_review: true } },
      unattended: false,
      projectName: name,
      workspaceDir: path.join(projDir, 'workspace'),
      healer: { heal: async () => ({ healed: false }) },
      project: { git_branch: null },
    });
    assert.equal(outcome.mode, 'pause');
  } finally {
    await fs.rm(projDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('settleReviewOutcome: a passing score with no BLOCKER auto-proceeds (no pause) — same threshold check a synchronous review gets', async () => {
  const name = `settle-proceed-${randomUUID()}`;
  const projDir = path.join(PROJECTS_DIR, name);
  const rPath = reviewPath(projDir, 3);
  await fs.mkdir(path.dirname(rPath), { recursive: true });
  await fs.writeFile(rPath, 'verdict: continue\nscore: 92\n', 'utf-8');
  try {
    const outcome = await settleReviewOutcome({
      result: { is_error: false },
      action: { kind: 'guide', task: 'review', phaseN: 3 },
      // auto_pause_after_review:true would still not fire — tryReviewAutoProceed
      // returning true short-circuits BEFORE evaluatePause is ever reached.
      cfg: { auto_run: { review_auto_proceed_score_threshold: 85, auto_pause_after_review: true } },
      unattended: false,
      projectName: name,
      workspaceDir: path.join(projDir, 'workspace'),
      healer: { heal: async () => ({ healed: false }) },
      project: { git_branch: null },
    });
    assert.equal(outcome.mode, 'proceed');
  } finally {
    await fs.rm(projDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('settleReviewOutcome: an is_error result the healer FIXES returns healed-retry (no pause, no auto-proceed lookup)', async () => {
  const name = `settle-heal-${randomUUID()}`;
  let healCalled = false;
  const outcome = await settleReviewOutcome({
    result: { is_error: true, result: 'guide crashed mid-review' },
    action: { kind: 'guide', task: 'review', phaseN: 3 },
    cfg: {},
    unattended: false,
    projectName: name,
    workspaceDir: '/tmp/does-not-matter',
    healer: {
      heal: async (err, ctx) => {
        healCalled = true;
        assert.equal(err.message, 'guide crashed mid-review');
        assert.equal(err._phase, 3);
        assert.equal(ctx.action.phaseN, 3);
        return { healed: true };
      },
    },
    project: { git_branch: 'develop' },
  });
  assert.equal(healCalled, true);
  assert.equal(outcome.mode, 'healed-retry');
});

test('settleReviewOutcome: an is_error result the healer CANNOT fix routes to the SAME phase-error pause a synchronous guide failure gets', async () => {
  const outcome = await settleReviewOutcome({
    result: { is_error: true, error_message: 'boom detail' },
    action: { kind: 'guide', task: 'review', phaseN: 3 },
    cfg: {},
    unattended: false,
    projectName: 'settle-unhealed',
    workspaceDir: '/tmp/does-not-matter',
    healer: { heal: async () => ({ healed: false }) },
    project: { git_branch: 'develop' },
  });
  assert.equal(outcome.mode, 'pause');
  assert.match(outcome.reason, /boom detail/);
  assert.equal(outcome.pauseKind, 'mid-build');
});

test('settleReviewOutcome: a successful review still persists reviewNextConsecutiveLight into project metadata (same bookkeeping a synchronous review gets)', async () => {
  const name = `settle-consec-${randomUUID()}`;
  upsertProject({ name, tech_stack: 'node', total_phases: 3 });
  const projDir = path.join(PROJECTS_DIR, name);
  const rPath = reviewPath(projDir, 2);
  await fs.mkdir(path.dirname(rPath), { recursive: true });
  await fs.writeFile(rPath, 'verdict: continue\nscore: 50\n', 'utf-8'); // below threshold, no BLOCKER
  try {
    const outcome = await settleReviewOutcome({
      result: { is_error: false },
      action: { kind: 'guide', task: 'review', phaseN: 2, reviewNextConsecutiveLight: 2 },
      cfg: { auto_run: { review_auto_proceed_score_threshold: 85, auto_pause_after_review: false }, billing: {} },
      unattended: false,
      projectName: name,
      workspaceDir: path.join(projDir, 'workspace'),
      healer: { heal: async () => ({ healed: false }) },
      project: { git_branch: null },
    });
    const meta = parseProjectMetadata(getProject(name).metadata_json);
    assert.equal(meta.consecutive_light_reviews, 2);
    assert.equal(outcome.mode, 'proceed', 'below-threshold score, no BLOCKER, auto_pause_after_review:false -> proceed');
  } finally {
    await fs.rm(projDir, { recursive: true, force: true }).catch(() => {});
    await cleanupProjDir(name);
  }
});

// ─── E. source assertions — loop wiring order ───────────────────────────────

const autoRunnerSrc = readFileSync(fileURLToPath(new URL('../auto-runner.js', import.meta.url)), 'utf-8');

test('auto-runner: pickNextAction is called with pendingReviewPhaseN sourced from the outstanding pendingReview slot', () => {
  assert.match(autoRunnerSrc, /pendingReviewPhaseN: pendingReview\?\.phaseN \?\? null/);
});

test('auto-runner: the pendingVerify barrier (phase-51) settles BEFORE a review is ever fired (P2\'s barrier runs first, ordering-checked)', () => {
  const verifyBarrierIdx = autoRunnerSrc.indexOf("if (action.kind === 'guide' && pendingVerify) {");
  const reviewFireIdx = autoRunnerSrc.indexOf("if (action.kind === 'guide' && action.task === 'review' && !action.isFinalReview && ar.async_reviews === true) {");
  assert.ok(verifyBarrierIdx > -1 && reviewFireIdx > -1, 'both anchors found');
  assert.ok(verifyBarrierIdx < reviewFireIdx, 'pendingVerify barrier precedes the review-fire site');
});

test('auto-runner: isFinalReview is excluded from the async-fire condition — the final review always stays synchronous', () => {
  assert.match(autoRunnerSrc, /action\.task === 'review' && !action\.isFinalReview && ar\.async_reviews === true/);
});

test('auto-runner: cap-1 — a second due review awaits (consumes) the outstanding one before firing', () => {
  const blockStart = autoRunnerSrc.indexOf("if (action.kind === 'guide' && action.task === 'review' && !action.isFinalReview && ar.async_reviews === true) {");
  const block = autoRunnerSrc.slice(blockStart, blockStart + 700);
  assert.match(block, /if \(pendingReview\) \{/);
  assert.match(block, /const consumed = await consumePendingReview\(\);/);
  assert.match(block, /pendingReview = spawnDetachedReview\(\{/);
});

test('auto-runner: finalize() awaits the pendingReview barrier on every terminal path', () => {
  assert.match(autoRunnerSrc, /async function finalize\(\{ runId, status, reason, pauseKind = null, projectName, runStartTime, pendingVerify = null, pendingReview = null, notifier = null \}\)/);
  const finalizeIdx = autoRunnerSrc.indexOf('async function finalize(');
  const body = autoRunnerSrc.slice(finalizeIdx, finalizeIdx + 1200);
  assert.match(body, /if \(pendingReview\?\.promise\) \{\s*\n\s*try \{ await pendingReview\.promise; \}/);
});

test('auto-runner: a non-review guide action barrier-awaits an outstanding pendingReview before dispatch (it may read decisions.jsonl/the review file mid-write)', () => {
  assert.match(autoRunnerSrc, /if \(action\.kind === 'guide' && action\.task !== 'review' && pendingReview\) \{/);
});
