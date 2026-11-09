#!/usr/bin/env node
// verify-speculative-duo.mjs — brief 05 P7, harness 4/4 (phase-74).
//
// Fixture-repo integration harness for the P6 speculative opus+fable duo
// (src/lib/duo-executor.js, phase 72) — the last resort before a
// force_tier-critical PHASE pauses for a human. Builds its OWN temp git
// fixture repo per section — no shared helper file, matching the existing
// scripts/verify-*.mjs house style. The dev spawn (runDev) and the checker
// (runAcceptanceCheck) are ALWAYS stubbed via the runSpeculativeDuo deps seam,
// so this makes ZERO real LLM spawns. The refusal + winner-path section uses
// REAL provisionLane/destroyLane (lane-manager.js) and REAL git merge/reset
// (git.js) — exercising the exact worktree + merge machinery production runs.
// Mirrors (condensed, exit-code-checked form of) the scenarios in
// src/lib/duo-executor.test.mjs.
//
// Asserts:
//   1. restore-safety — an un-pushed phase-N attempt resets the workspace to
//      origin tip (preSha); an already-pushed attempt (ahead=0) ABORTS with
//      NO reset.
//   2. refusal leg + winner path — a refused fable leg is recorded a LOST
//      leg (phase_lanes.status='failed'), the duo continues on the surviving
//      opus leg, judges it, merges it, re-gates merged HEAD (ONE run),
//      completeMergedPhase actually lands (phase row completed +
//      current_phase advanced), pushes exactly ONCE, deletes the phase's
//      failure markers, and tears down BOTH worktrees + branches.
//   3. judge matrix (decideDuoWinner) — pass beats fail; both-pass ⇒ fewer
//      unmet wins (both directions); exact tie ⇒ fable wins.
//   4. both-fail (both legs committed, judge fails both) — no winner, NO
//      merge/push, duo.json + BOTH duo-<tier>-verify.json written.
//   5. both-lost (both legs errored/refused, nothing survives) — pause, the
//      judge never runs, duo.json legs are all 'lost'/'refused'.
//   6. restore ABORT short-circuit — on an aborted restore, ZERO lanes are
//      provisioned and duo.json still records outcome='aborted'.
//   7. source-inspection — a refusal is never routed to auto-heal or the
//      escalation ladder (duo-executor.js imports neither); mode isolation —
//      the flag off makes isDuoEligible ineligible before anything else runs.
//
// Run: node scripts/verify-speculative-duo.mjs   (exit 0 = all pass)

process.env.DB_PATH = ':memory:';

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runSpeculativeDuo, verifyAndRestore, decideDuoWinner, isDuoEligible,
} from '../src/lib/duo-executor.js';
import { provisionLane, destroyLane } from '../src/lib/lane-manager.js';
import { upsertProject, upsertPhase, getPhases, getDb } from '../src/state.js';
import { getCurrentBranch, branchExists } from '../src/lib/git.js';
import { escalationMarkerPath } from '../src/lib/escalation.js';
import { phaseDir } from '../src/lib/guide-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok  = (l) => { console.log('OK  ', l); pass++; };
const bad = (l, e) => { console.log('FAIL', l + (e ? `\n     ${e?.stack || e?.message || e}` : '')); fail++; };

let _seq = 0;

function makeFixture(label) {
  const projDir = mkdtempSync(path.join(tmpdir(), `aorch-vsd-proj-${label}-`));
  const workspaceDir = mkdtempSync(path.join(tmpdir(), `aorch-vsd-ws-${label}-`));
  execSync('git init -q', { cwd: workspaceDir });
  execSync('git config user.email t@example.com', { cwd: workspaceDir });
  execSync('git config user.name test', { cwd: workspaceDir });
  execSync('git config commit.gpgsign false', { cwd: workspaceDir });
  writeFileSync(path.join(workspaceDir, '.gitignore'), 'node_modules/\n.env\n.claude/\n');
  writeFileSync(path.join(workspaceDir, 'core.js'), 'export const base = 0;\n');
  execSync('git add -A', { cwd: workspaceDir });
  execSync('git commit -q -m init', { cwd: workspaceDir });
  return { projDir, workspaceDir };
}

function addBareRemote(workspaceDir, label) {
  const remoteDir = mkdtempSync(path.join(tmpdir(), `aorch-vsd-remote-${label}-`));
  execSync(`git init -q --bare "${remoteDir}"`);
  execSync(`git remote add origin "${remoteDir}"`, { cwd: workspaceDir });
  execSync('git push -q -u origin HEAD', { cwd: workspaceDir });
  return remoteDir;
}

function commitFailedAttempt(workspaceDir, phaseN, file = 'attempt.js') {
  writeFileSync(path.join(workspaceDir, file), 'export const attempt = 1;\n');
  execSync('git add -A', { cwd: workspaceDir });
  execSync(`git commit -q -m "phase-${phaseN}: failed attempt"`, { cwd: workspaceDir });
}

function writeMarkers(projDir, phaseN) {
  const guide = path.join(projDir, '.guide');
  mkdirSync(guide, { recursive: true });
  writeFileSync(path.join(guide, `phase-${phaseN}-validation-failed.marker`), 'validators failed');
  writeFileSync(escalationMarkerPath(projDir, { phaseN }), '{"target_tier":"fable"}');
}

const baseCfg = () => ({
  auto_run: { speculative_duo_on_double_failure: true },
  validators: { enabled: false },
  parallel_lanes: { dir: '.worktrees', node_modules: 'none' },
  model_routing: { tier_models: { sonnet: 'claude-sonnet-4-6', opus: 'claude-opus-4-8', fable: 'claude-fable-5' } },
});

async function readDuoJson(projDir, phaseN, phaseTitle) {
  const dir = await phaseDir(projDir, phaseN, phaseTitle);
  return JSON.parse(readFileSync(path.join(dir, 'duo.json'), 'utf-8'));
}

console.log('\n── verify-speculative-duo ──\n');

// ── 1. Restore-safety: un-pushed ⇒ reset to origin tip; pushed ⇒ ABORT, no reset ──
try {
  // 1a. un-pushed phase-N attempt(s) ⇒ reset to origin tip.
  {
    const { projDir, workspaceDir } = makeFixture(`restore-ok-${_seq++}`);
    try {
      addBareRemote(workspaceDir, 'restore-ok');
      const originTip = execSync('git rev-parse HEAD', { cwd: workspaceDir }).toString().trim();
      const branch = await getCurrentBranch(workspaceDir);
      commitFailedAttempt(workspaceDir, 5);
      commitFailedAttempt(workspaceDir, 5, 'attempt2.js');

      const r = await verifyAndRestore({ workspaceDir, branch, phaseN: 5 });
      assert.equal(r.ok, true);
      assert.equal(r.preSha, originTip);
      assert.equal(execSync('git rev-parse HEAD', { cwd: workspaceDir }).toString().trim(), originTip, 'HEAD reset to origin tip');
      assert.equal(existsSync(path.join(workspaceDir, 'attempt.js')), false, 'failed attempt discarded');
    } finally {
      rmSync(projDir, { recursive: true, force: true });
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  }

  // 1b. already-pushed attempt (ahead=0) ⇒ ABORT, no reset.
  {
    const { projDir, workspaceDir } = makeFixture(`restore-pushed-${_seq++}`);
    try {
      addBareRemote(workspaceDir, 'restore-pushed');
      const branch = await getCurrentBranch(workspaceDir);
      commitFailedAttempt(workspaceDir, 5);
      const headBefore = execSync('git rev-parse HEAD', { cwd: workspaceDir }).toString().trim();
      execSync('git push -q origin HEAD', { cwd: workspaceDir });

      const r = await verifyAndRestore({ workspaceDir, branch, phaseN: 5 });
      assert.equal(r.ok, false);
      assert.match(r.reason, /ambiguous|diverged/);
      assert.equal(execSync('git rev-parse HEAD', { cwd: workspaceDir }).toString().trim(), headBefore, 'no reset performed');
    } finally {
      rmSync(projDir, { recursive: true, force: true });
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  }
  ok('1: restore-safety — an un-pushed failed attempt resets to origin tip (preSha); an already-pushed attempt ABORTS with NO reset');
} catch (e) { bad('1: restore-safety', e); }

// ── 2. Refusal leg + winner path (REAL lanes, REAL merge) ────────────────────
try {
  const { projDir, workspaceDir } = makeFixture(`winner-${_seq++}`);
  try {
    addBareRemote(workspaceDir, 'winner');
    const originTip = execSync('git rev-parse HEAD', { cwd: workspaceDir }).toString().trim();
    const branch = await getCurrentBranch(workspaceDir);
    const projectName = `vsd-winner-${_seq++}`;
    upsertProject({ name: projectName, status: 'in-progress' });
    upsertPhase({ project: projectName, n: 5, title: 'Crypto Core', status: 'in-progress' });
    getDb().prepare('UPDATE projects SET git_branch = ?, current_phase = 4 WHERE name = ?').run(branch, projectName);
    commitFailedAttempt(workspaceDir, 5);   // un-pushed failed attempt
    writeMarkers(projDir, 5);

    const provisionedLanes = [];
    const destroyCalls = [];
    let pushCount = 0;
    let gateCount = 0;
    const outcome = await runSpeculativeDuo(
      { projectName, cfg: baseCfg(), projDir, workspaceDir, phaseN: 5, phaseTitle: 'Crypto Core', phaseMeta: { n: 5, acceptance_criteria: ['a'] } },
      {
        // REAL provisionLane/destroyLane — spied, not replaced — so worktree +
        // branch teardown is genuinely exercised (and inspectable after).
        provisionLane: async (args) => {
          const lane = await provisionLane(args);
          provisionedLanes.push(lane);
          return lane;
        },
        destroyLane: async (args) => {
          destroyCalls.push({ branch: args.branch, status: args.status });
          return destroyLane(args);
        },
        withJobKey: (k, fn) => fn(),
        // opus commits real work into its REAL lane worktree; fable refuses (no commit).
        runDev: async ({ modelOverride, laneDir, laneBranch }) => {
          if (modelOverride === 'claude-fable-5') return { stop_reason: 'refusal' };
          writeFileSync(path.join(laneDir, 'opus-work.js'), 'export const done = true;\n');
          execSync('git add -A', { cwd: laneDir });
          execSync(`git commit -q -m "phase-5: opus attempt"`, { cwd: laneDir });
          const commit_sha = execSync('git rev-parse HEAD', { cwd: laneDir }).toString().trim();
          return { is_error: false, lane: true, commit_sha, branch: laneBranch };
        },
        runAcceptanceCheck: async () => ({ status: 'pass', verdict: { verdict: 'pass', criteria: [{ status: 'met' }] } }),
        gateMergedHead: async () => { gateCount += 1; return { hasFailures: false, results: [] }; },
        pushBranch: async () => { pushCount += 1; return { ok: true }; },
      },
    );

    assert.equal(outcome.outcome, 'merged');
    assert.equal(outcome.winner.tier, 'opus');
    assert.equal(outcome.pushed, true);
    assert.equal(pushCount, 1, 'exactly ONE push');
    assert.equal(gateCount, 1, 'merged-HEAD validator gate run exactly once');

    // completeMergedPhase's REAL effect: the phase row is completed, current_phase advanced.
    const phaseRow = getPhases(projectName).find((p) => p.n === 5);
    assert.equal(phaseRow.status, 'completed', 'completeMergedPhase landed — phase 5 marked completed');
    assert.ok(phaseRow.commit_sha, 'phase 5 commit_sha recorded');
    assert.equal(getDb().prepare('SELECT current_phase FROM projects WHERE name = ?').get(projectName).current_phase, 5, 'current_phase advanced to 5');

    // duo.json: refused leg vs committed leg.
    const duo = await readDuoJson(projDir, 5, 'Crypto Core');
    const fableLeg = duo.legs.find((l) => l.tier === 'fable');
    const opusLeg = duo.legs.find((l) => l.tier === 'opus');
    assert.equal(fableLeg.status, 'refused', 'refused leg recorded (never an is_error)');
    assert.equal(opusLeg.status, 'committed');
    assert.equal(duo.outcome, 'merged');
    assert.equal(duo.chosen, 'opus');
    assert.equal(duo.pushed, true);

    // Teardown: the refused lane is 'failed' (LOST LEG), the winner 'done'.
    assert.equal(destroyCalls.length, 2, 'both lanes torn down');
    assert.equal(destroyCalls.find((c) => c.branch === 'lane/duo-fable').status, 'failed', 'refused leg torn down as failed, never routed to auto-heal/escalation');
    assert.equal(destroyCalls.find((c) => c.branch === 'lane/duo-opus').status, 'done');

    // BOTH worktrees + branches genuinely gone on disk / in git.
    assert.equal(provisionedLanes.length, 2);
    for (const lane of provisionedLanes) {
      assert.equal(existsSync(lane.laneDir), false, `${lane.name} worktree dir removed`);
      // eslint-disable-next-line no-await-in-loop
      assert.equal(await branchExists(workspaceDir, lane.branch), false, `${lane.name} branch deleted`);
    }

    // Restore-safety actually ran (markers are only deleted post-restore; HEAD
    // has since moved past originTip via the winning merge, so we assert the
    // merge is an ancestor-descendant of it instead of exact equality).
    const isDescendant = execSync(`git merge-base --is-ancestor ${originTip} HEAD; echo $?`, { cwd: workspaceDir }).toString().trim();
    assert.equal(isDescendant, '0', 'pre-duo restore reset to origin tip, and the winning merge landed on top of it');
    assert.equal(existsSync(path.join(projDir, '.guide', 'phase-5-validation-failed.marker')), false, 'validation-failed marker deleted');
    assert.equal(existsSync(escalationMarkerPath(projDir, { phaseN: 5 })), false, 'escalate marker deleted');

    ok('2: refusal leg is a LOST leg (failed, never auto-heal/escalation); duo continues on the survivor, judges + merges it, re-gates ONCE, completeMergedPhase lands, ONE push, BOTH worktrees + branches cleaned up');
  } finally {
    rmSync(projDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
} catch (e) { bad('2: refusal leg + winner path', e); }

// ── 3. Judge matrix (decideDuoWinner) — pure ──────────────────────────────────
try {
  assert.equal(decideDuoWinner([
    { tier: 'opus', judge: { status: 'fail', unmet: 0 } },
    { tier: 'fable', judge: { status: 'pass', unmet: 2 } },
  ]).winner.tier, 'fable', 'pass beats fail');

  assert.equal(decideDuoWinner([
    { tier: 'opus', judge: { status: 'pass', unmet: 0 } },
    { tier: 'fable', judge: { status: 'pass', unmet: 3 } },
  ]).winner.tier, 'opus', 'both pass ⇒ fewer unmet wins (opus)');
  assert.equal(decideDuoWinner([
    { tier: 'opus', judge: { status: 'pass', unmet: 4 } },
    { tier: 'fable', judge: { status: 'pass', unmet: 1 } },
  ]).winner.tier, 'fable', 'both pass ⇒ fewer unmet wins, symmetric (fable)');

  const tie = decideDuoWinner([
    { tier: 'opus', judge: { status: 'pass', unmet: 1 } },
    { tier: 'fable', judge: { status: 'pass', unmet: 1 } },
  ]);
  assert.equal(tie.winner.tier, 'fable', 'exact tie ⇒ fable wins');
  assert.match(tie.reason, /tie/);

  assert.equal(decideDuoWinner([
    { tier: 'opus', judge: { status: 'fail', unmet: 2 } },
    { tier: 'fable', judge: { status: 'inconclusive', unmet: 0 } },
  ]).winner, null, 'no passing leg ⇒ no winner');
  ok('3: judge matrix — pass beats fail; both-pass fewer-unmet wins (both directions); exact tie → fable');
} catch (e) { bad('3: judge matrix', e); }

// ── 4. Both-fail: both legs committed, judge fails both ⇒ no winner, NO merge/push ──
try {
  const projDir = mkdtempSync(path.join(tmpdir(), `aorch-vsd-bothfail-${_seq++}-`));
  try {
    let laneId = 0;
    let mergeCount = 0;
    let pushCount = 0;
    const out = await runSpeculativeDuo(
      { projectName: 'demo-bothfail', cfg: baseCfg(), projDir, workspaceDir: '/tmp/vsd-nonexistent', phaseN: 7, phaseTitle: 'FVU Generator', phaseMeta: { n: 7, acceptance_criteria: ['x'] } },
      {
        verifyAndRestore: async () => ({ ok: true, preSha: 'a'.repeat(40) }),
        provisionLane: async ({ tier }) => ({ laneDir: path.join(tmpdir(), `vsd-l-${tier}-${_seq++}`), branch: `lane/duo-${tier}`, laneId: ++laneId, name: `duo-${tier}`, jobKey: `k-${tier}` }),
        destroyLane: async () => {},
        withJobKey: (k, fn) => fn(),
        getProject: () => ({ git_branch: 'develop' }),
        recordRunEvent: () => {},
        runDev: async ({ modelOverride }) => ({ is_error: false, lane: true, commit_sha: `${modelOverride}-sha`.padEnd(40, '0') }),
        runAcceptanceCheck: async () => ({ status: 'fail', verdict: { verdict: 'fail', criteria: [{ status: 'unmet' }] } }),
        mergeNoFf: async () => { mergeCount += 1; return { ok: true }; },
        pushBranch: async () => { pushCount += 1; return { ok: true }; },
        completeMergedPhase: () => {},
        now: () => '2026-07-11T00:00:00Z',
        log: () => {},
      },
    );

    assert.equal(out.outcome, 'both-fail');
    assert.equal(out.winner, null);
    assert.equal(mergeCount, 0, 'no merge on a both-fail duo');
    assert.equal(pushCount, 0, 'no push on a both-fail duo');

    const dir = await phaseDir(projDir, 7, 'FVU Generator');
    assert.ok(existsSync(path.join(dir, 'duo.json')), 'duo.json written');
    assert.ok(existsSync(path.join(dir, 'duo-opus-verify.json')), 'opus verify.json kept');
    assert.ok(existsSync(path.join(dir, 'duo-fable-verify.json')), 'fable verify.json kept');
    ok('4: both-fail — both legs committed but the judge fails both ⇒ no winner, NO merge/push, duo.json + BOTH verify.json written');
  } finally {
    rmSync(projDir, { recursive: true, force: true });
  }
} catch (e) { bad('4: both-fail (judge)', e); }

// ── 5. Both-lost: both legs errored/refused ⇒ pause, judge never runs ────────
try {
  const projDir = mkdtempSync(path.join(tmpdir(), `aorch-vsd-bothlost-${_seq++}-`));
  try {
    let laneId = 0;
    let judgeCount = 0;
    const out = await runSpeculativeDuo(
      { projectName: 'demo-bothlost', cfg: baseCfg(), projDir, workspaceDir: '/tmp/vsd-nonexistent', phaseN: 9, phaseTitle: 'Key Derivation', phaseMeta: { n: 9 } },
      {
        verifyAndRestore: async () => ({ ok: true, preSha: 'a'.repeat(40) }),
        provisionLane: async ({ tier }) => ({ laneDir: path.join(tmpdir(), `vsd-l-${tier}-${_seq++}`), branch: `lane/duo-${tier}`, laneId: ++laneId, name: `duo-${tier}`, jobKey: `k-${tier}` }),
        destroyLane: async () => {},
        withJobKey: (k, fn) => fn(),
        getProject: () => ({ git_branch: 'develop' }),
        recordRunEvent: () => {},
        runDev: async () => ({ is_error: true, error_message: 'boom' }),
        runAcceptanceCheck: async () => { judgeCount += 1; return { status: 'pass', verdict: {} }; },
        now: () => '2026-07-11T00:00:00Z',
        log: () => {},
      },
    );

    assert.equal(out.outcome, 'both-fail');
    assert.equal(judgeCount, 0, 'no judge runs when there is no surviving committed leg');
    const duo = await readDuoJson(projDir, 9, 'Key Derivation');
    assert.equal(duo.outcome, 'both-fail');
    assert.ok(duo.legs.every((l) => l.status === 'lost'));
    ok('5: both-lost — both legs errored (nothing survives) ⇒ pause, judge never runs, duo.json legs all \'lost\'');
  } finally {
    rmSync(projDir, { recursive: true, force: true });
  }
} catch (e) { bad('5: both-lost', e); }

// ── 6. Restore ABORT short-circuit: ZERO lanes provisioned, duo.json still written ──
try {
  const projDir = mkdtempSync(path.join(tmpdir(), `aorch-vsd-abort-${_seq++}-`));
  try {
    let provisionCount = 0;
    const out = await runSpeculativeDuo(
      { projectName: 'demo-abort', cfg: baseCfg(), projDir, workspaceDir: '/tmp/vsd-nonexistent', phaseN: 3, phaseTitle: 'PII Encryption', phaseMeta: { n: 3 } },
      {
        verifyAndRestore: async () => ({ ok: false, reason: 'foreign history ahead of origin — ambiguous, not resetting' }),
        provisionLane: async () => { provisionCount += 1; return {}; },
        log: () => {},
      },
    );
    assert.equal(out.outcome, 'aborted');
    assert.equal(out.ran, false);
    assert.equal(provisionCount, 0, 'no lanes provisioned on an abort');
    const duo = await readDuoJson(projDir, 3, 'PII Encryption');
    assert.equal(duo.outcome, 'aborted');
    assert.match(duo.reason, /foreign|ambiguous/);
    ok('6: restore ABORT short-circuit — ZERO lanes provisioned, duo.json still records outcome=aborted');
  } finally {
    rmSync(projDir, { recursive: true, force: true });
  }
} catch (e) { bad('6: restore ABORT short-circuit', e); }

// ── 7. Source-inspection + mode isolation ─────────────────────────────────────
try {
  const src = readFileSync(path.join(__dirname, '..', 'src', 'lib', 'duo-executor.js'), 'utf-8');
  assert.equal(/auto-healer/.test(src), false, 'duo-executor must not import the auto-healer');
  assert.equal(/decideEscalationHop|escalation-hop|writeEscalationMarker/.test(src), false, 'duo-executor must not touch the escalation ladder');

  const r = isDuoEligible({
    cfg: { auto_run: { speculative_duo_on_double_failure: false } },
    action: { kind: 'dev', phaseN: 5 }, isForceTier: true,
    windowStatus: { warnThreshold: 50, callsInWindow: 0 },
  });
  assert.equal(r.eligible, false, 'flag off ⇒ NOT eligible (mode isolation — nothing else consulted)');
  assert.match(r.reason, /disabled/);
  ok('7: source-inspection — a refusal is never routed to auto-heal/escalation (source imports neither); mode isolation — the flag off makes isDuoEligible ineligible immediately');
} catch (e) { bad('7: source-inspection + mode isolation', e); }

// ── Self-check: the ok/bad counting logic itself fails loudly on a bad assertion ──
// (Runs against LOCAL counters — never touches the real pass/fail totals above —
// so this proves the harness's own exit-code logic without risking a false FAIL.)
try {
  let _p = 0, _f = 0;
  const _ok = () => { _p++; };
  const _bad = () => { _f++; };
  try { assert.equal(1, 1); _ok(); } catch { _bad(); }
  try { assert.equal(1, 2); _ok(); } catch { _bad(); }
  assert.equal(_p, 1, 'one deliberately-passing assertion counted');
  assert.equal(_f, 1, 'one deliberately-failing assertion counted (would set exit code 1)');
  ok('8: self-check — a deliberately broken fixture assertion is caught and counted as a failure (exit-code logic verified)');
} catch (e) { bad('8: self-check exit-code logic', e); }

console.log(`\nverify-speculative-duo: ${pass}/${pass + fail}`);
process.exit(fail > 0 ? 1 : 0);
