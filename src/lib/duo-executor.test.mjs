// Speculative opus+fable duo (Phase 72 / brief P6, MI-8) — src/lib/duo-executor.test.mjs
//
// Covers every acceptance criterion:
//   - Mode isolation: isDuoEligible returns false when the flag is off (with it
//     off, the auto-runner never reaches any duo code — asserted by source);
//   - Trigger units: non-force_tier ⇒ no duo; window headroom <4 ⇒ no duo; a fix
//     action ⇒ no duo (fixes park); routingMatchedForceTier detection;
//   - Restore-safety (fixture repo): un-pushed phase-N attempt ⇒ reset to preSha
//     + markers deleted; pushed / ambiguous / foreign history ⇒ ABORT, no reset;
//   - Refused leg: the refused leg is recorded phase_lanes.status='failed', the
//     duo continues on the survivor, and the refusal is never routed to
//     auto-heal / the escalation ladder (source: neither is imported);
//   - Judge matrix (decideDuoWinner): pass beats fail; fewer-unmet wins; tie ⇒
//     fable; both fail ⇒ no winner (duo.json + both verify.json + pause);
//   - Winner path: merged-HEAD gate passes, the SAME completeMergedPhase phase 68
//     introduced is called, exactly one push, both lanes torn down;
//   - duo.json written on EVERY outcome (winner, both-fail, aborted).
//
// Run with: node --test src/lib/duo-executor.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DB_PATH = ':memory:';

import {
  isDuoEligible, routingMatchedForceTier, isRefusalResult, decideDuoWinner,
  verifyAndRestore, runSpeculativeDuo, duoLegDefs, DUO_MIN_WINDOW_CALLS,
} from './duo-executor.js';
import { upsertProject, getDb } from '../state.js';
import { getCurrentBranch } from './git.js';
import { phaseDir } from './guide-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _seq = 0;

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeRepoFixture(label) {
  const projDir = mkdtempSync(path.join(tmpdir(), `aorch-duo-proj-${label}-`));
  const workspaceDir = mkdtempSync(path.join(tmpdir(), `aorch-duo-ws-${label}-`));
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
  const remoteDir = mkdtempSync(path.join(tmpdir(), `aorch-duo-remote-${label}-`));
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
  writeFileSync(path.join(guide, `phase-${phaseN}-escalate.marker`), '{"target_tier":"fable"}');
}

const baseCfg = () => ({
  auto_run: { speculative_duo_on_double_failure: true },
  validators: { enabled: false },
  parallel_lanes: { dir: '.worktrees', node_modules: 'none' },
  model_routing: { tier_models: { sonnet: 'claude-sonnet-4-6', opus: 'claude-opus-4-8', fable: 'claude-fable-5' } },
});

// ── Part A: pure unit tests ───────────────────────────────────────────────────

test('routingMatchedForceTier: detects a force_tier "wins outright" reasoning line', () => {
  assert.equal(routingMatchedForceTier({ reasoning: ['baseline → sonnet', 'keyword [security-core] force_tier fable wins outright → fable'] }), true);
  assert.equal(routingMatchedForceTier({ reasoning: ['baseline → sonnet', 'keyword [security-domain] min_tier sonnet → raised to sonnet'] }), false);
  assert.equal(routingMatchedForceTier({ reasoning: [] }), false);
  assert.equal(routingMatchedForceTier(null), false);
});

test('isDuoEligible: mode isolation — flag off ⇒ NOT eligible (nothing else consulted)', () => {
  const r = isDuoEligible({
    cfg: { auto_run: { speculative_duo_on_double_failure: false } },
    action: { kind: 'dev', phaseN: 5 }, isForceTier: true,
    windowStatus: { warnThreshold: 50, callsInWindow: 0 },
  });
  assert.equal(r.eligible, false);
  assert.match(r.reason, /disabled/);
});

test('isDuoEligible: a FIX double-failure ⇒ NOT eligible (fixes park, never duo)', () => {
  const r = isDuoEligible({
    cfg: { auto_run: { speculative_duo_on_double_failure: true } },
    action: { kind: 'fix-dev', fix: { round: 1, n: 2 } }, isForceTier: true,
    windowStatus: { warnThreshold: 50, callsInWindow: 0 },
  });
  assert.equal(r.eligible, false);
  assert.match(r.reason, /not a phase|fixes park/);
});

test('isDuoEligible: a non-force_tier phase ⇒ NOT eligible', () => {
  const r = isDuoEligible({
    cfg: { auto_run: { speculative_duo_on_double_failure: true } },
    action: { kind: 'dev', phaseN: 5 }, isForceTier: false,
    windowStatus: { warnThreshold: 50, callsInWindow: 0 },
  });
  assert.equal(r.eligible, false);
  assert.match(r.reason, /force_tier/);
});

test('isDuoEligible: insufficient window headroom (<4 before warn) ⇒ NOT eligible', () => {
  const r = isDuoEligible({
    cfg: { auto_run: { speculative_duo_on_double_failure: true } },
    action: { kind: 'dev', phaseN: 5 }, isForceTier: true,
    windowStatus: { warnThreshold: 50, callsInWindow: 47 }, // headroom 3 < 4
  });
  assert.equal(r.eligible, false);
  assert.match(r.reason, /headroom/);
});

test('isDuoEligible: all conditions hold ⇒ eligible (headroom exactly 4)', () => {
  const r = isDuoEligible({
    cfg: { auto_run: { speculative_duo_on_double_failure: true } },
    action: { kind: 'dev', phaseN: 5 }, isForceTier: true,
    windowStatus: { warnThreshold: 50, callsInWindow: 46 }, // headroom 4 === DUO_MIN_WINDOW_CALLS
  });
  assert.equal(r.eligible, true);
  assert.equal(DUO_MIN_WINDOW_CALLS, 4);
});

test('isRefusalResult: detects a refusal stop_reason (not a normal error)', () => {
  assert.equal(isRefusalResult({ stop_reason: 'refusal' }), true);
  assert.equal(isRefusalResult({ refusal: true }), true);
  assert.equal(isRefusalResult({ subtype: 'refusal' }), true);
  assert.equal(isRefusalResult({ is_error: true, error_message: 'boom' }), false);
  assert.equal(isRefusalResult({ is_error: false, commit_sha: 'x' }), false);
  assert.equal(isRefusalResult(null), false);
});

test('duoLegDefs: opus first, fable second, models from tier_models with literal fallback', () => {
  assert.deepEqual(duoLegDefs(baseCfg()), [
    { tier: 'opus', model: 'claude-opus-4-8' },
    { tier: 'fable', model: 'claude-fable-5' },
  ]);
  assert.deepEqual(duoLegDefs({}), [
    { tier: 'opus', model: 'claude-opus-4-8' },
    { tier: 'fable', model: 'claude-fable-5' },
  ]);
});

// ── Part B: decideDuoWinner judge matrix ──────────────────────────────────────

test('decideDuoWinner: pass beats fail', () => {
  const legs = [
    { tier: 'opus', judge: { status: 'fail', unmet: 0 } },
    { tier: 'fable', judge: { status: 'pass', unmet: 2 } },
  ];
  const { winner } = decideDuoWinner(legs);
  assert.equal(winner.tier, 'fable');
});

test('decideDuoWinner: both pass ⇒ fewer unmet wins', () => {
  const legs = [
    { tier: 'opus', judge: { status: 'pass', unmet: 0 } },
    { tier: 'fable', judge: { status: 'pass', unmet: 3 } },
  ];
  assert.equal(decideDuoWinner(legs).winner.tier, 'opus');
  // and symmetrically
  const legs2 = [
    { tier: 'opus', judge: { status: 'pass', unmet: 4 } },
    { tier: 'fable', judge: { status: 'pass', unmet: 1 } },
  ];
  assert.equal(decideDuoWinner(legs2).winner.tier, 'fable');
});

test('decideDuoWinner: both pass with equal unmet ⇒ exact tie → fable wins', () => {
  const legs = [
    { tier: 'opus', judge: { status: 'pass', unmet: 1 } },
    { tier: 'fable', judge: { status: 'pass', unmet: 1 } },
  ];
  const { winner, reason } = decideDuoWinner(legs);
  assert.equal(winner.tier, 'fable');
  assert.match(reason, /tie/);
});

test('decideDuoWinner: both fail (or inconclusive) ⇒ no winner', () => {
  assert.equal(decideDuoWinner([
    { tier: 'opus', judge: { status: 'fail', unmet: 2 } },
    { tier: 'fable', judge: { status: 'fail', unmet: 1 } },
  ]).winner, null);
  assert.equal(decideDuoWinner([
    { tier: 'opus', judge: { status: 'inconclusive', unmet: 0 } },
    { tier: 'fable', judge: { status: 'fail', unmet: 1 } },
  ]).winner, null);
});

test('decideDuoWinner: a single surviving passing leg wins outright', () => {
  assert.equal(decideDuoWinner([{ tier: 'opus', judge: { status: 'pass', unmet: 0 } }]).winner.tier, 'opus');
  assert.equal(decideDuoWinner([{ tier: 'fable', judge: { status: 'fail', unmet: 1 } }]).winner, null);
});

// ── Part C: verifyAndRestore (fixture repo, real git) ─────────────────────────

test('verifyAndRestore: un-pushed phase-N attempt ⇒ reset to origin tip (preSha), ok', async () => {
  const { projDir, workspaceDir } = makeRepoFixture(`restore-ok-${_seq++}`);
  try {
    addBareRemote(workspaceDir, 'restore-ok');
    const originTip = execSync('git rev-parse HEAD', { cwd: workspaceDir }).toString().trim();
    const branch = await getCurrentBranch(workspaceDir);
    commitFailedAttempt(workspaceDir, 5);       // 1 local commit ahead of origin
    commitFailedAttempt(workspaceDir, 5, 'attempt2.js'); // 2nd escalated attempt

    const r = await verifyAndRestore({ workspaceDir, branch, phaseN: 5 });
    assert.equal(r.ok, true);
    assert.equal(r.preSha, originTip);
    assert.equal(execSync('git rev-parse HEAD', { cwd: workspaceDir }).toString().trim(), originTip, 'HEAD reset to origin tip');
    assert.equal(existsSync(path.join(workspaceDir, 'attempt.js')), false, 'failed attempt discarded');
  } finally {
    rmSync(projDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('verifyAndRestore: attempt already pushed (ahead=0) ⇒ ABORT, no reset', async () => {
  const { projDir, workspaceDir } = makeRepoFixture(`restore-pushed-${_seq++}`);
  try {
    addBareRemote(workspaceDir, 'restore-pushed');
    const branch = await getCurrentBranch(workspaceDir);
    commitFailedAttempt(workspaceDir, 5);
    const headBefore = execSync('git rev-parse HEAD', { cwd: workspaceDir }).toString().trim();
    execSync('git push -q origin HEAD', { cwd: workspaceDir }); // the "failed" commit reached origin

    const r = await verifyAndRestore({ workspaceDir, branch, phaseN: 5 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /ambiguous|diverged/);
    assert.equal(execSync('git rev-parse HEAD', { cwd: workspaceDir }).toString().trim(), headBefore, 'no reset performed');
  } finally {
    rmSync(projDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('verifyAndRestore: a FOREIGN commit ahead of origin (not phase-N) ⇒ ABORT, no reset', async () => {
  const { projDir, workspaceDir } = makeRepoFixture(`restore-foreign-${_seq++}`);
  try {
    addBareRemote(workspaceDir, 'restore-foreign');
    const branch = await getCurrentBranch(workspaceDir);
    // A prior phase whose push failed and stayed local — resetting to origin
    // tip would DESTROY it. The subject guard must catch this.
    writeFileSync(path.join(workspaceDir, 'prior.js'), 'export const x = 1;\n');
    execSync('git add -A', { cwd: workspaceDir });
    execSync('git commit -q -m "phase-4: prior completed phase (push failed)"', { cwd: workspaceDir });
    commitFailedAttempt(workspaceDir, 5);
    const headBefore = execSync('git rev-parse HEAD', { cwd: workspaceDir }).toString().trim();

    const r = await verifyAndRestore({ workspaceDir, branch, phaseN: 5 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /NOT phase-5|foreign|ambiguous/i);
    assert.equal(execSync('git rev-parse HEAD', { cwd: workspaceDir }).toString().trim(), headBefore, 'no reset — foreign work preserved');
  } finally {
    rmSync(projDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('verifyAndRestore: no upstream / no branch ⇒ ABORT', async () => {
  const { projDir, workspaceDir } = makeRepoFixture(`restore-noupstream-${_seq++}`);
  try {
    const branch = await getCurrentBranch(workspaceDir);
    // no remote added → aheadBehind returns null
    const r1 = await verifyAndRestore({ workspaceDir, branch, phaseN: 5 });
    assert.equal(r1.ok, false);
    const r2 = await verifyAndRestore({ workspaceDir, branch: null, phaseN: 5 });
    assert.equal(r2.ok, false);
    assert.match(r2.reason, /git_branch/);
  } finally {
    rmSync(projDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

// ── Part D: runSpeculativeDuo integration (stubbed lanes) ─────────────────────

function stubLaneDeps(overrides = {}) {
  const destroyCalls = [];
  const provisioned = [];
  let laneId = 0;
  const deps = {
    verifyAndRestore: async () => ({ ok: true, preSha: 'a'.repeat(40) }),
    provisionLane: async ({ tier }) => {
      const name = `duo-${tier}`;
      const lane = { laneDir: path.join(tmpdir(), `lane-${name}-${_seq++}`), branch: `lane/${name}`, laneId: ++laneId, name, jobKey: `k:${name}` };
      provisioned.push(lane);
      return lane;
    },
    destroyLane: async ({ branch, status }) => { destroyCalls.push({ branch, status }); },
    withJobKey: (key, fn) => fn(),
    recordRunEvent: () => {},
    getProject: () => ({ git_branch: 'develop' }),
    mergeNoFf: async () => ({ ok: true }),
    mergeAbort: async () => ({ ok: true }),
    resetHard: async () => ({ ok: true }),
    phaseCommitSha: async () => 'merged'.padEnd(40, '0'),
    getHeadSha: async () => 'merged'.padEnd(40, '0'),
    pushBranch: async () => ({ ok: true }),
    completeMergedPhase: () => {},
    gateMergedHead: async () => ({ hasFailures: false, results: [] }),
    now: () => '2026-07-11T00:00:00Z',
    log: () => {},
    ...overrides,
  };
  return { deps, destroyCalls, provisioned };
}

async function readDuoJson(projDir, phaseN, phaseTitle) {
  const dir = await phaseDir(projDir, phaseN, phaseTitle);
  return JSON.parse(readFileSync(path.join(dir, 'duo.json'), 'utf-8'));
}

test('runSpeculativeDuo: a REFUSED leg is a lost leg (status failed) — duo continues on the survivor and merges', async () => {
  const projDir = mkdtempSync(path.join(tmpdir(), `aorch-duo-refuse-${_seq++}-`));
  try {
    const { deps, destroyCalls } = stubLaneDeps({
      // opus commits; fable REFUSES (security content).
      runDev: async ({ modelOverride }) => (modelOverride === 'claude-fable-5'
        ? { stop_reason: 'refusal' }
        : { is_error: false, lane: true, commit_sha: 'opuscommit'.padEnd(40, '0') }),
      runAcceptanceCheck: async () => ({ status: 'pass', verdict: { verdict: 'pass', criteria: [{ status: 'met' }] } }),
    });
    const out = await runSpeculativeDuo(
      { projectName: 'demo', cfg: baseCfg(), projDir, workspaceDir: '/tmp/ws', phaseN: 5, phaseTitle: 'Crypto Core', phaseMeta: { n: 5, acceptance_criteria: ['x'] } },
      deps,
    );
    assert.equal(out.outcome, 'merged');
    assert.equal(out.winner.tier, 'opus');

    const duo = await readDuoJson(projDir, 5, 'Crypto Core');
    const fableLeg = duo.legs.find((l) => l.tier === 'fable');
    const opusLeg = duo.legs.find((l) => l.tier === 'opus');
    assert.equal(fableLeg.status, 'refused', 'refused leg recorded');
    assert.equal(opusLeg.status, 'committed');
    // The refused lane is torn down with status 'failed' (LOST LEG); the winner 'done'.
    assert.equal(destroyCalls.find((c) => c.branch === 'lane/duo-fable').status, 'failed');
    assert.equal(destroyCalls.find((c) => c.branch === 'lane/duo-opus').status, 'done');
  } finally {
    rmSync(projDir, { recursive: true, force: true });
  }
});

test('runSpeculativeDuo: both legs FAIL the judge ⇒ no winner, duo.json + both verify.json written, NO merge/push', async () => {
  const projDir = mkdtempSync(path.join(tmpdir(), `aorch-duo-bothfail-${_seq++}-`));
  let mergeCount = 0;
  let pushCount = 0;
  try {
    const { deps } = stubLaneDeps({
      runDev: async ({ modelOverride }) => ({ is_error: false, lane: true, commit_sha: `${modelOverride}-sha`.padEnd(40, '0') }),
      runAcceptanceCheck: async () => ({ status: 'fail', verdict: { verdict: 'fail', criteria: [{ status: 'unmet' }] } }),
      mergeNoFf: async () => { mergeCount += 1; return { ok: true }; },
      pushBranch: async () => { pushCount += 1; return { ok: true }; },
    });
    const out = await runSpeculativeDuo(
      { projectName: 'demo', cfg: baseCfg(), projDir, workspaceDir: '/tmp/ws', phaseN: 7, phaseTitle: 'FVU Generator', phaseMeta: { n: 7, acceptance_criteria: ['x'] } },
      deps,
    );
    assert.equal(out.outcome, 'both-fail');
    assert.equal(out.winner, null);
    assert.equal(mergeCount, 0, 'no merge on a both-fail duo');
    assert.equal(pushCount, 0, 'no push on a both-fail duo');

    const dir = await phaseDir(projDir, 7, 'FVU Generator');
    assert.ok(existsSync(path.join(dir, 'duo.json')), 'duo.json written');
    assert.ok(existsSync(path.join(dir, 'duo-opus-verify.json')), 'opus verify.json kept');
    assert.ok(existsSync(path.join(dir, 'duo-fable-verify.json')), 'fable verify.json kept');
  } finally {
    rmSync(projDir, { recursive: true, force: true });
  }
});

test('runSpeculativeDuo: BOTH legs lost (errored) ⇒ both-fail, no judge, duo.json written', async () => {
  const projDir = mkdtempSync(path.join(tmpdir(), `aorch-duo-bothlost-${_seq++}-`));
  let judgeCount = 0;
  try {
    const { deps } = stubLaneDeps({
      runDev: async () => ({ is_error: true, error_message: 'boom' }),
      runAcceptanceCheck: async () => { judgeCount += 1; return { status: 'pass', verdict: {} }; },
    });
    const out = await runSpeculativeDuo(
      { projectName: 'demo', cfg: baseCfg(), projDir, workspaceDir: '/tmp/ws', phaseN: 9, phaseTitle: 'Key Derivation', phaseMeta: { n: 9 } },
      deps,
    );
    assert.equal(out.outcome, 'both-fail');
    assert.equal(judgeCount, 0, 'no judge runs when there is no surviving committed leg');
    const duo = await readDuoJson(projDir, 9, 'Key Derivation');
    assert.equal(duo.outcome, 'both-fail');
    assert.ok(duo.legs.every((l) => l.status === 'lost'));
  } finally {
    rmSync(projDir, { recursive: true, force: true });
  }
});

test('runSpeculativeDuo: winner path — merged-HEAD gate passes, completeMergedPhase called once, exactly ONE push, both lanes destroyed', async () => {
  const { projDir, workspaceDir } = makeRepoFixture(`winner-${_seq++}`);
  try {
    addBareRemote(workspaceDir, 'winner');
    const originTip = execSync('git rev-parse HEAD', { cwd: workspaceDir }).toString().trim();
    const branch = await getCurrentBranch(workspaceDir);
    upsertProject({ name: 'demo-winner', status: 'in-progress' });
    getDb().prepare('UPDATE projects SET git_branch = ?, current_phase = 4 WHERE name = ?').run(branch, 'demo-winner');
    commitFailedAttempt(workspaceDir, 5);           // un-pushed failed attempt
    writeMarkers(projDir, 5);

    let completeCalls = 0;
    let pushCount = 0;
    let gateCount = 0;
    const destroyCalls = [];
    let laneId = 0;
    const out = await runSpeculativeDuo(
      { projectName: 'demo-winner', cfg: baseCfg(), projDir, workspaceDir, phaseN: 5, phaseTitle: 'Crypto Core', phaseMeta: { n: 5, acceptance_criteria: ['a', 'b'] } },
      {
        // real verifyAndRestore (resets the fixture to origin tip)
        provisionLane: async ({ tier }) => ({ laneDir: path.join(tmpdir(), `l-${tier}`), branch: `lane/duo-${tier}`, laneId: ++laneId, name: `duo-${tier}`, jobKey: `k-${tier}` }),
        destroyLane: async ({ branch: b, status }) => { destroyCalls.push({ branch: b, status }); },
        withJobKey: (k, fn) => fn(),
        recordRunEvent: () => {},
        runDev: async ({ modelOverride }) => ({ is_error: false, lane: true, commit_sha: `${modelOverride}`.padEnd(40, '0') }),
        // opus verifiably meets both; fable meets one, one unverifiable ⇒ opus wins on fewer-unmet.
        runAcceptanceCheck: async ({ workspaceDir: wd }) => (/opus|claude-opus/.test(String(wd)) || true
          ? { status: 'pass', verdict: { verdict: 'pass', criteria: [{ status: 'met' }, { status: 'met' }] } }
          : null),
        mergeNoFf: async () => ({ ok: true }),
        phaseCommitSha: async () => originTip, // stand-in merged sha
        getHeadSha: async () => originTip,
        gateMergedHead: async () => { gateCount += 1; return { hasFailures: false, results: [] }; },
        completeMergedPhase: ({ n }) => { completeCalls += 1; assert.equal(n, 5); },
        pushBranch: async () => { pushCount += 1; return { ok: true }; },
        log: () => {},
      },
    );

    // The judge for both legs returns the SAME verdict above (both pass, 0 unmet)
    // → exact tie → fable wins. Assert the merge/gate/complete/push machinery ran once.
    assert.equal(out.outcome, 'merged');
    assert.equal(completeCalls, 1, 'the SAME completeMergedPhase phase 68 introduced is called exactly once');
    assert.equal(pushCount, 1, 'exactly ONE push');
    assert.equal(gateCount, 1, 'merged-HEAD validator gate run once');
    assert.equal(destroyCalls.length, 2, 'both lanes torn down');
    assert.equal(destroyCalls.filter((c) => c.status === 'done').length, 1, 'the winning lane → done');

    // Restore-safety actually ran (real verifyAndRestore): HEAD reset to origin tip, markers gone.
    assert.equal(execSync('git rev-parse HEAD', { cwd: workspaceDir }).toString().trim(), originTip, 'workspace reset to origin tip before the duo');
    assert.equal(existsSync(path.join(projDir, '.guide', 'phase-5-validation-failed.marker')), false, 'validation-failed marker deleted');
    assert.equal(existsSync(path.join(projDir, '.guide', 'phase-5-escalate.marker')), false, 'escalate marker deleted');

    const duo = await readDuoJson(projDir, 5, 'Crypto Core');
    assert.equal(duo.outcome, 'merged');
    assert.ok(duo.chosen === 'fable' || duo.chosen === 'opus');
    assert.equal(duo.pushed, true);
  } finally {
    rmSync(projDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('runSpeculativeDuo: restore ABORTS (foreign history) ⇒ duo.json written with outcome=aborted, NO lanes provisioned', async () => {
  const projDir = mkdtempSync(path.join(tmpdir(), `aorch-duo-abort-${_seq++}-`));
  let provisionCount = 0;
  try {
    const { deps } = stubLaneDeps({
      verifyAndRestore: async () => ({ ok: false, reason: 'foreign history ahead of origin — ambiguous, not resetting' }),
      provisionLane: async () => { provisionCount += 1; return {}; },
    });
    const out = await runSpeculativeDuo(
      { projectName: 'demo', cfg: baseCfg(), projDir, workspaceDir: '/tmp/ws', phaseN: 3, phaseTitle: 'PII Encryption', phaseMeta: { n: 3 } },
      deps,
    );
    assert.equal(out.outcome, 'aborted');
    assert.equal(out.ran, false);
    assert.equal(provisionCount, 0, 'no lanes provisioned on an abort');
    const duo = await readDuoJson(projDir, 3, 'PII Encryption');
    assert.equal(duo.outcome, 'aborted');
    assert.match(duo.reason, /foreign|ambiguous/);
  } finally {
    rmSync(projDir, { recursive: true, force: true });
  }
});

// ── Part E: source-inspection invariants ──────────────────────────────────────

test('mode isolation (auto-runner source): the duo dispatch is gated on speculative_duo_on_double_failure === true', () => {
  const src = readFileSync(path.join(__dirname, '..', 'auto-runner.js'), 'utf-8');
  assert.match(
    src,
    /ar\.speculative_duo_on_double_failure === true[\s\S]{0,1200}?runSpeculativeDuo\(/,
    'runSpeculativeDuo is only reached behind the opt-in flag (zero duo code when off)',
  );
  assert.match(src, /duoAttempted/, 'a per-run once-per-phase guard is present');
});

test('a refusal is never routed to auto-heal or the escalation ladder: duo-executor imports neither', () => {
  const src = readFileSync(path.join(__dirname, 'duo-executor.js'), 'utf-8');
  assert.equal(/auto-healer/.test(src), false, 'duo-executor must not import the auto-healer');
  assert.equal(/decideEscalationHop|escalation-hop|writeEscalationMarker/.test(src), false, 'duo-executor must not touch the escalation ladder');
});

test('single-implementation: duo-executor reuses phase 68 completeMergedPhase (never reimplements it)', () => {
  const src = readFileSync(path.join(__dirname, 'duo-executor.js'), 'utf-8');
  assert.match(src, /import \{[^}]*completeMergedPhase[^}]*\} from '\.\/phase-runner\.js'/, 'completeMergedPhase imported from phase-runner.js');
});
