// Phase 89 (brief 05 P5b) — runtime-QA insertion into the ready-for-qa transition.
//
// Seam/fixture coverage (all runtime-qa spawns faked — NO real LLM calls):
//   AC1 report mode (default, shipped ON) — runRuntimeQa runs ONCE, verdict
//        logged, EXACTLY ONE notifier line, transition proceeds EXACTLY as today
//        even when the verdict carries blockers (fail-open regression).
//   AC2 gate mode (default-off) — blockers promoted to bug_inbox via the
//        audit-promote precedent (promoteRuntimeQaBlockers → addDedupedBug), the
//        gate returns blocked with a clear runtime-qa-blockers reason, NO transition.
//   AC3 runs at most ONCE per completion; a skipped result → dim log + proceed.
//   AC4 guide_session_id / last_dev_session_id UNCHANGED (role:null invariant).
//   AC5 main-flow gating at ALL THREE sites — the two pickNextAction all-phases-
//        complete sites AND the pickBugAction fix-round-complete site each flip the
//        status in report mode and DEFER it in gate mode; backward-compat: no
//        runtime_qa config → gate no-op.
//   AC6 orphan safety — the gate returns cleanly in BOTH the success and error
//        branches (an unexpected throw fails open, never propagates) and relies on
//        runRuntimeQa's own pidfile backstop (no second cleanup path).
//
// Run: node --test src/auto-runner-runtime-qa.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Must be set before any module that calls getDb() is loaded.
process.env.DB_PATH = ':memory:';

const {
  runReadyForQaRuntimeGate, isRuntimeQaGateMode, pickNextAction,
} = await import('./auto-runner.js');
const { promoteRuntimeQaBlockers } = await import('./lib/audit-promote.js');
const { summarizeRuntimeQaVerdict, cleanupOrphanPids } = await import('./lib/runtime-qa.js');
const { fixPlanJsonPath, bugRoundDir } = await import('./lib/guide-paths.js');
const {
  upsertProject, getProject, setCurrentPhase,
  upsertPhase, markPhaseCompleted, setGuideSessionId, setLastDevSessionId,
  startBugRound, recordFixCompletion,
  listBugs,
} = await import('./state.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

// ─── helpers ─────────────────────────────────────────────────────────────────

// Mirrors auto-runner.test.mjs MINIMAL_CFG — reaches the site-1 all-phases-done
// ready-for-qa transition without tripping review / skip-analyze / conformance.
const MINIMAL_CFG = {
  auto_run: {
    run_final_review_before_qa: false,
    audit_runs_after_completion: 0,
    warn_on_missing_phase_report: false,
    auto_pause_after_phase_1: false,
  },
  phases: { review_every_n_phases: 999 },
  paths: { workspace_subdir: 'workspace' },
  workspace_claude_md: { auto_generate_during_autorun: false },
  skip_analyze: { enabled: false },
  brief_conformance: { enabled: false },
};

const WORKSPACE = (name) => path.join(PROJECTS_DIR, name, 'workspace');

async function writePlanJson(projectName, plan) {
  const projDir = path.join(PROJECTS_DIR, projectName);
  const guideDir = path.join(projDir, '.guide');
  await fs.mkdir(guideDir, { recursive: true });
  await fs.writeFile(path.join(guideDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf-8');
  const briefFile = path.join(guideDir, 'brief.md');
  try { await fs.access(briefFile); } catch { await fs.writeFile(briefFile, '# Test brief\n', 'utf-8'); }
  const ctxFile = path.join(guideDir, 'project-context.md');
  try { await fs.access(ctxFile); } catch { await fs.writeFile(ctxFile, '# Context\n', 'utf-8'); }
}

async function allDoneProject(name) {
  const plan = { phases: [{ n: 1, title: 'Only phase', acceptance_criteria: ['a'] }] };
  await writePlanJson(name, plan);
  upsertProject({ name, tech_stack: 'node', total_phases: 1, status: 'in-progress' });
  setCurrentPhase(name, 1);
  upsertPhase({ project: name, n: 1, title: 'Only phase', status: 'pending' });
  markPhaseCompleted({ project: name, n: 1, commit_sha: 'sha1' });
}

async function cleanupProject(projectName) {
  const projDir = path.join(PROJECTS_DIR, projectName);
  try { await fs.rm(projDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function verdict({ pass = 1, blockers = [] } = {}) {
  const journeys = [];
  for (let i = 0; i < pass; i += 1) journeys.push({ name: `j${i}`, status: 'pass', evidence: 'ok' });
  return { journeys, blockers };
}

// ─── AC1 — report mode (default): fail-open, one spawn, one notifier line ──────

test('report mode (default): runRuntimeQa runs ONCE, verdict logged, exactly one notifier line, and the transition proceeds even with blockers (fail-open regression)', async () => {
  const name = 'rqa-report';
  try {
    upsertProject({ name, tech_stack: 'node', total_phases: 1, status: 'in-progress' });

    let calls = 0;
    const runRuntimeQa = async () => {
      calls += 1;
      return {
        status: 'ok',
        verdict: verdict({ pass: 2, blockers: [{ title: 'crash', detail: 'boom', severity: 'blocker' }] }),
        verdictPath: 'x',
      };
    };
    let notifyCount = 0;
    const notifier = { notify: async () => { notifyCount += 1; } };
    const logs = [];
    const cfg = { runtime_qa: { enabled: true, mode: 'report' } };

    const gate = await runReadyForQaRuntimeGate(
      { projectName: name, workspaceDir: WORKSPACE(name), cfg, notifier },
      { runRuntimeQa, log: (m) => logs.push(m) },
    );

    assert.equal(calls, 1, 'runRuntimeQa invoked exactly once (per run, not per phase)');
    assert.equal(notifyCount, 1, 'exactly one notifier line');
    assert.equal(gate.ran, true);
    assert.equal(gate.blocked, false, 'report mode NEVER blocks — fail-open even with blockers');
    assert.equal(gate.status, 'ok');
    assert.ok(logs.some((l) => /runtime-qa ran/.test(l)), 'the verdict summary is logged');
    assert.equal(listBugs({ project: name }).length, 0, 'report mode does NOT promote blockers to the inbox');
  } finally {
    await cleanupProject(name);
  }
});

// ─── AC2 — gate mode (default-off): promote + block ───────────────────────────

test('gate mode (default-off): every blocker is promoted to bug_inbox (source runtime-qa) and the gate returns blocked with a runtime-qa-blockers reason — NO transition', async () => {
  const name = 'rqa-gate';
  try {
    upsertProject({ name, tech_stack: 'node', total_phases: 1, status: 'in-progress' });

    const runRuntimeQa = async () => ({
      status: 'ok',
      verdict: verdict({
        pass: 0,
        blockers: [
          { title: 'server 500', detail: 'GET / returns 500', severity: 'blocker' },
          { title: 'missing route', detail: '/health 404', severity: 'major' },
        ],
      }),
      verdictPath: 'x',
    });
    let notifyCount = 0;
    const notifier = { notify: async () => { notifyCount += 1; } };
    const cfg = { runtime_qa: { enabled: true, mode: 'gate' } };

    const gate = await runReadyForQaRuntimeGate(
      { projectName: name, workspaceDir: WORKSPACE(name), cfg, notifier },
      { runRuntimeQa, log: () => {} },
    );

    assert.equal(gate.blocked, true, 'gate mode with blockers BLOCKS the transition');
    assert.match(gate.reason, /runtime-qa-blockers/, 'clear pause_reason');
    assert.equal(notifyCount, 1, 'still exactly one notifier line in gate mode');

    const bugs = listBugs({ project: name });
    assert.equal(bugs.length, 2, 'both blockers promoted to bug_inbox');
    assert.ok(bugs.every((b) => b.source === 'runtime-qa'), 'promoted with source runtime-qa');
    assert.deepEqual(bugs.map((b) => b.severity).sort(), ['critical', 'major'], 'severity map: blocker→critical, major→major');
    // The gate itself never flips status; the caller (autoRun) skips the flip on block.
    assert.equal(getProject(name).status, 'in-progress', 'gate does not transition when blocked');
  } finally {
    await cleanupProject(name);
  }
});

test('gate mode with NO blockers proceeds (not blocked) and promotes nothing', async () => {
  const name = 'rqa-gate-clean';
  try {
    upsertProject({ name, tech_stack: 'node', total_phases: 1, status: 'in-progress' });
    const runRuntimeQa = async () => ({ status: 'ok', verdict: verdict({ pass: 2, blockers: [] }), verdictPath: 'x' });
    const cfg = { runtime_qa: { enabled: true, mode: 'gate' } };
    const gate = await runReadyForQaRuntimeGate(
      { projectName: name, workspaceDir: WORKSPACE(name), cfg, notifier: null },
      { runRuntimeQa, log: () => {} },
    );
    assert.equal(gate.blocked, false, 'gate mode with no blockers proceeds');
    assert.equal(listBugs({ project: name }).length, 0);
  } finally {
    await cleanupProject(name);
  }
});

// ─── AC3 — skipped result → dim log + proceed (even in gate mode) ──────────────

test('a skipped result (no entrypoint / fail-closed sandbox) emits a dim log and lets the transition proceed — no notifier line, no block, even in gate mode', async () => {
  const name = 'rqa-skip';
  try {
    upsertProject({ name, tech_stack: 'node', total_phases: 1, status: 'in-progress' });
    let calls = 0;
    const runRuntimeQa = async () => {
      calls += 1;
      return { status: 'skipped', reason: 'no start script or CLI entrypoint detected', verdict: null };
    };
    let notifyCount = 0;
    const notifier = { notify: async () => { notifyCount += 1; } };
    const logs = [];
    const cfg = { runtime_qa: { enabled: true, mode: 'gate' } }; // gate mode STILL proceeds on skip

    const gate = await runReadyForQaRuntimeGate(
      { projectName: name, workspaceDir: WORKSPACE(name), cfg, notifier },
      { runRuntimeQa, log: (m) => logs.push(m) },
    );

    assert.equal(calls, 1, 'runRuntimeQa invoked at most once');
    assert.equal(gate.blocked, false, 'a skip never blocks (even in gate mode)');
    assert.equal(gate.status, 'skipped');
    assert.equal(notifyCount, 0, 'no notifier line on skip');
    assert.ok(logs.some((l) => /skipped/.test(l)), 'a dim skip log is emitted');
    assert.equal(listBugs({ project: name }).length, 0, 'skip promotes nothing');
  } finally {
    await cleanupProject(name);
  }
});

// ─── AC4 — role:null session invariant ────────────────────────────────────────

test('the runtime-qa gate never touches guide_session_id / last_dev_session_id (role:null invariant) and passes no role to runRuntimeQa', async () => {
  const name = 'rqa-session';
  try {
    upsertProject({ name, tech_stack: 'node', total_phases: 1, status: 'in-progress' });
    setGuideSessionId(name, 'guide-abc');
    setLastDevSessionId(name, 'dev-xyz');

    let seen = null;
    const runRuntimeQa = async (args) => { seen = args; return { status: 'ok', verdict: verdict({ pass: 1 }), verdictPath: 'x' }; };
    const cfg = { runtime_qa: { enabled: true, mode: 'report' } };

    await runReadyForQaRuntimeGate(
      { projectName: name, workspaceDir: WORKSPACE(name), cfg, notifier: null },
      { runRuntimeQa, log: () => {} },
    );

    const proj = getProject(name);
    assert.equal(proj.guide_session_id, 'guide-abc', 'guide session unchanged across the runtime-qa insertion');
    assert.equal(proj.last_dev_session_id, 'dev-xyz', 'dev session unchanged across the runtime-qa insertion');
    assert.ok(seen && seen.role === undefined, 'the gate passes no role to runRuntimeQa (roleless)');
  } finally {
    await cleanupProject(name);
  }
});

// ─── AC5 — backward compat (no config) + pickNextAction main-flow gating ───────

test('backward-compat: no runtime_qa config → gate is a no-op (no spawn), run still completes', async () => {
  const name = 'rqa-nocfg';
  try {
    upsertProject({ name, tech_stack: 'node', total_phases: 1, status: 'in-progress' });
    let calls = 0;
    const runRuntimeQa = async () => { calls += 1; return { status: 'ok', verdict: verdict(), verdictPath: 'x' }; };
    const gate = await runReadyForQaRuntimeGate(
      { projectName: name, workspaceDir: WORKSPACE(name), cfg: {}, notifier: null },
      { runRuntimeQa, log: () => {} },
    );
    assert.equal(calls, 0, 'no runtime_qa block → NO spawn');
    assert.equal(gate.ran, false);
    assert.equal(gate.blocked, false);
  } finally {
    await cleanupProject(name);
  }
});

test('backward-compat: runtime_qa.enabled:false → gate is a no-op (no spawn)', async () => {
  const name = 'rqa-disabled';
  try {
    upsertProject({ name, tech_stack: 'node', total_phases: 1, status: 'in-progress' });
    let calls = 0;
    const runRuntimeQa = async () => { calls += 1; return { status: 'ok', verdict: verdict(), verdictPath: 'x' }; };
    const gate = await runReadyForQaRuntimeGate(
      { projectName: name, workspaceDir: WORKSPACE(name), cfg: { runtime_qa: { enabled: false, mode: 'gate' } }, notifier: null },
      { runRuntimeQa, log: () => {} },
    );
    assert.equal(calls, 0, 'enabled:false → NO spawn');
    assert.equal(gate.ran, false);
    assert.equal(gate.blocked, false, 'a disabled gate never blocks even if mode is gate');
  } finally {
    await cleanupProject(name);
  }
});

test('isRuntimeQaGateMode: only enabled:true + mode:gate is a blocking gate; report / disabled / absent are not', () => {
  assert.equal(isRuntimeQaGateMode({ runtime_qa: { enabled: true, mode: 'gate' } }), true);
  assert.equal(isRuntimeQaGateMode({ runtime_qa: { enabled: true, mode: 'report' } }), false);
  assert.equal(isRuntimeQaGateMode({ runtime_qa: { enabled: false, mode: 'gate' } }), false);
  assert.equal(isRuntimeQaGateMode({}), false);
  assert.equal(isRuntimeQaGateMode(null), false);
});

test('pickNextAction (report mode / no gate): main-flow completion DEFERS the flip — status stays in-progress and tags readyForQaTransition:true, deferredReadyForQa:true (autoRun flips only after the gate runs)', async () => {
  const name = 'rqa-pna-report';
  try {
    await allDoneProject(name);
    const result = await pickNextAction(name, MINIMAL_CFG);
    assert.equal(result.kind, 'wait-for-human');
    assert.equal(result.readyForQaTransition, true, 'tagged so autoRun runs the runtime-qa gate once');
    assert.equal(result.deferredReadyForQa, true, 'report mode ALSO defers — the flip lands in autoRun after the gate, so runtime-qa.json exists before ready-for-qa');
    assert.notEqual(getProject(name).status, 'ready-for-qa', 'pickNextAction does NOT flip inline — the transition is deferred to autoRun');
  } finally {
    await cleanupProject(name);
  }
});

test('pickNextAction (gate mode): main-flow completion DEFERS the flip — status stays in-progress and deferredReadyForQa:true (so a blocker verdict can block)', async () => {
  const name = 'rqa-pna-gate';
  try {
    await allDoneProject(name);
    const cfg = { ...MINIMAL_CFG, runtime_qa: { enabled: true, mode: 'gate' } };
    const result = await pickNextAction(name, cfg);
    assert.equal(result.kind, 'wait-for-human');
    assert.equal(result.readyForQaTransition, true);
    assert.equal(result.deferredReadyForQa, true, 'gate mode defers the flip to autoRun');
    assert.notEqual(getProject(name).status, 'ready-for-qa', 'gate mode does NOT flip in pickNextAction — no transition yet');
  } finally {
    await cleanupProject(name);
  }
});

// ─── supporting units: promote dedup + summary ────────────────────────────────

test('promoteRuntimeQaBlockers dedups via addDedupedBug: re-promoting the same blocker inserts no duplicate row', async () => {
  const name = 'rqa-dedup';
  try {
    upsertProject({ name, tech_stack: 'node', total_phases: 1, status: 'in-progress' });
    const blockers = [{ title: 'boom', detail: 'x', severity: 'blocker' }];
    const first = promoteRuntimeQaBlockers({ projectName: name, blockers });
    const second = promoteRuntimeQaBlockers({ projectName: name, blockers });
    assert.equal(first.inserted, 1);
    assert.equal(second.inserted, 0, 'a re-run inserts no duplicate (dedup precedent)');
    assert.equal(listBugs({ project: name }).length, 1);
  } finally {
    await cleanupProject(name);
  }
});

test('summarizeRuntimeQaVerdict: pure one-liner reports passed/total journeys + blocker count, and flags inconclusive', () => {
  const s = summarizeRuntimeQaVerdict({
    status: 'ok',
    verdict: { journeys: [{ status: 'pass' }, { status: 'fail' }], blockers: [{ title: 'x' }] },
  });
  assert.match(s, /1\/2 journeys passed/);
  assert.match(s, /1 blocker/);
  const inc = summarizeRuntimeQaVerdict({ status: 'inconclusive', verdict: { journeys: [], blockers: [] } });
  assert.match(inc, /inconclusive/);
  assert.match(inc, /no blockers/);
});

// ─── AC5 (third site) — pickBugAction fix-round-complete gating ────────────────
//
// The third gated setProjectStatus('ready-for-qa') site lives in pickBugAction.
// A completed bug round (fixes_completed >= total, a fix plan on disk, NO
// git_branch so the self-heal walk is skipped) reaches it through pickNextAction's
// bug-round precedence. Proves all THREE main-flow sites are wired, not just the
// two in pickNextAction.

async function completedBugRoundProject(name) {
  const projDir = path.join(PROJECTS_DIR, name);
  await fs.mkdir(bugRoundDir(projDir, 1), { recursive: true });
  await fs.writeFile(fixPlanJsonPath(projDir, 1), JSON.stringify({ round: 1, fixes: [{ n: 1, title: 'fix a' }] }), 'utf-8');
  upsertProject({ name, tech_stack: 'node', total_phases: 1, status: 'in-progress' });
  startBugRound({ project: name, round: 1, bugs_file: 'bugs.md', total_fixes: 1 });
  recordFixCompletion({ project: name, round: 1, fixN: 1 }); // fixes_completed = 1 >= total 1
}

test('pickBugAction (report mode): the fix-round-complete site (the THIRD gated ready-for-qa transition) DEFERS the flip and tags readyForQaTransition:true, deferredReadyForQa:true — all three sites wired', async () => {
  const name = 'rqa-pba-report';
  try {
    await completedBugRoundProject(name);
    const result = await pickNextAction(name, { paths: { workspace_subdir: 'workspace' } });
    assert.equal(result.kind, 'wait-for-human');
    assert.match(result.reason, /Fix round 1 complete/);
    assert.equal(result.readyForQaTransition, true, 'the fix-round-complete site tags the runtime-qa gate');
    assert.equal(result.deferredReadyForQa, true, 'report mode ALSO defers — the flip lands in autoRun after the gate');
    assert.notEqual(getProject(name).status, 'ready-for-qa', 'pickBugAction does NOT flip inline — the transition is deferred to autoRun');
  } finally {
    await cleanupProject(name);
  }
});

test('pickBugAction (gate mode): the fix-round-complete site DEFERS the flip — status stays in-progress, deferredReadyForQa:true', async () => {
  const name = 'rqa-pba-gate';
  try {
    await completedBugRoundProject(name);
    const cfg = { paths: { workspace_subdir: 'workspace' }, runtime_qa: { enabled: true, mode: 'gate' } };
    const result = await pickNextAction(name, cfg);
    assert.equal(result.kind, 'wait-for-human');
    assert.equal(result.readyForQaTransition, true);
    assert.equal(result.deferredReadyForQa, true, 'gate mode defers the flip to autoRun');
    assert.notEqual(getProject(name).status, 'ready-for-qa', 'gate mode does NOT flip at the pickBugAction site — no transition yet');
  } finally {
    await cleanupProject(name);
  }
});

// ─── AC6 — orphan safety: success AND error branches, no second cleanup path ────

test('orphan safety: the gate returns cleanly in BOTH the success and error branches (an unexpected throw fails open) and the module cleanup leaves no PID behind', async () => {
  const name = 'rqa-orphan';
  try {
    upsertProject({ name, tech_stack: 'node', total_phases: 1, status: 'in-progress' });
    const cfg = { runtime_qa: { enabled: true, mode: 'report' } };

    // A runRuntimeQa stand-in that mirrors the real module: it owns a pidfile and
    // runs the module's own cleanupOrphanPids in a finally (success OR throw). An
    // out-of-range, already-dead pid (kill(pid,0) → throws) is skipped and the
    // pidfile unlinked — deterministic, no real signal. The gate must NOT add its
    // own cleanup; it relies entirely on this backstop.
    const makeFake = ({ throws }) => {
      const pidfile = path.join(os.tmpdir(), `rqa-orphan-${name}-${throws ? 'err' : 'ok'}-${Date.now()}.txt`);
      const run = async () => {
        await fs.writeFile(pidfile, '2147483646\n', 'utf-8'); // a pid that cannot exist
        try {
          if (throws) throw new Error('runtime-qa spawn blew up');
          return { status: 'ok', verdict: verdict({ pass: 1 }), verdictPath: 'x' };
        } finally {
          await cleanupOrphanPids(pidfile, { log: () => {} });
        }
      };
      return { pidfile, run };
    };

    // success branch — gate returns, not blocked, pidfile cleaned up.
    const ok = makeFake({ throws: false });
    const gateOk = await runReadyForQaRuntimeGate(
      { projectName: name, workspaceDir: WORKSPACE(name), cfg, notifier: null },
      { runRuntimeQa: ok.run, log: () => {} },
    );
    assert.equal(gateOk.blocked, false, 'success branch: gate returns, not blocked');
    await assert.rejects(() => fs.access(ok.pidfile), 'success branch: pidfile cleaned up — no PID left');

    // error branch — the gate must CATCH the throw and fail open (return, not throw).
    const err = makeFake({ throws: true });
    let gateErr;
    await assert.doesNotReject(async () => {
      gateErr = await runReadyForQaRuntimeGate(
        { projectName: name, workspaceDir: WORKSPACE(name), cfg, notifier: null },
        { runRuntimeQa: err.run, log: () => {} },
      );
    }, 'error branch: the gate does not propagate the throw (fail-open)');
    assert.equal(gateErr.blocked, false, 'error branch: fail-open, never blocks');
    assert.equal(gateErr.status, 'error');
    await assert.rejects(() => fs.access(err.pidfile), 'error branch: pidfile cleaned up — no PID left');
  } finally {
    await cleanupProject(name);
  }
});
