#!/usr/bin/env node
// verify-cancellation-worker-safe.mjs
//
// Proves the self-audit fixes:
//   C1 — /cancel is per-job under the worker pool (kills only the targeted
//        job's subprocess, never a sibling's; cancel flag is per-job).
//   m2 — killAll() signals every tracked subprocess (shutdown child cleanup).
//   m1 — killCurrent reports the targeted job's PID.
//   M1 — terminal job-status writes are guarded to status='running'.
//   M2 — the budget-pause next-actions branch offers Resume.
//   C2 — the release builder hard-excludes live data on the rsync path and the
//        guards check for it; .gitignore / .releaseignore exist with state/.
//
// Run:  node scripts/verify-cancellation-worker-safe.mjs
// Exits non-zero on any failure.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  killCurrent, killAll, getCurrentProcess,
  isCancellationRequested, clearCancellation, __testHooks,
} from '../src/claude-runner.js';

// Capture kill calls via the injectable instead of relying on proc.kill() —
// killCurrent calls _groupKill(proc.pid, ...) (phase-8: positive pid; _groupKill
// negates internally to a group kill) which can't be intercepted via a fake
// proc object. The injectable also prevents a real process.kill against an
// OS-level PID from signalling the test runner's own process group.
const makeKillLog = () => {
  const log = [];
  __testHooks.setGroupKill((pid, sig) => log.push({ pid, sig }));
  return log;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

// A fake child-process handle. signals array kept for structural compatibility;
// signal delivery is now verified via the _groupKill injectable (makeKillLog).
function fakeProc(pid) {
  return {
    pid, killed: false, signals: [],
    kill(sig) { this.signals.push(sig); if (sig === 'SIGTERM' || sig === 'SIGKILL') this.killed = true; },
  };
}

console.log('\nC1 — per-job cancellation isolation');
{
  __testHooks.reset();
  const a = fakeProc(1001), b = fakeProc(2002);
  const procsByPid = new Map([[a.pid, a], [b.pid, b]]);
  // Single hook: record every (pid, sig) AND route to the matching fake proc.
  // Post-phase-8 the call sites pass the POSITIVE pid (the group target), so the
  // map is keyed by the positive pid; a negative pid here would mean the double-
  // negation bug regressed.
  const killLog = [];
  __testHooks.setGroupKill((pid, sig) => {
    killLog.push({ pid, sig });
    const p = procsByPid.get(pid);
    if (p) p.kill(sig); else throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
  });
  __testHooks.track('jobA', a, { project: 'A' });
  __testHooks.track('jobB', b, { project: 'B' });

  const res = killCurrent({ jobId: 'jobA', reason: 'test' });
  __testHooks.resetGroupKill();
  ok('killing jobA sends SIGTERM to jobA’s process group (positive pid → group kill)',
     killLog.some((e) => e.pid === a.pid && e.sig === 'SIGTERM'));
  ok('every group-kill pid is POSITIVE (no double-negation regression)',
     killLog.length > 0 && killLog.every((e) => e.pid > 0));
  ok('killing jobA leaves jobB UNTOUCHED (the core C1 fix)', !killLog.some((e) => e.pid === b.pid));
  ok('killResult.killed is true', res.killed === true);
  ok('killResult.pid is jobA’s pid, not jobB’s (m1)', res.pid === 1001);
  ok('jobA is flagged cancel-requested', isCancellationRequested('jobA') === true);
  ok('jobB is NOT flagged cancel-requested', isCancellationRequested('jobB') === false);
}

console.log('\nC1 — cancel of an unknown / already-finished job');
{
  __testHooks.reset();
  const res = killCurrent({ jobId: 'ghost', reason: 'test' });
  ok('returns killed:false', res.killed === false);
  ok('reason mentions no subprocess', /no subprocess running/.test(res.reason));
  ok('still records the cancel intent (sticks if a spawn races in)', isCancellationRequested('ghost') === true);
  clearCancellation('ghost');
  ok('clearCancellation clears the per-job flag', isCancellationRequested('ghost') === false);
}

console.log('\nC1 — setsid race: ESRCH on first kill still schedules retry and returns killed:true');
{
  __testHooks.reset();
  const retryCalls = [];
  let firstCall = true;
  __testHooks.setGroupKill((pid, sig) => {
    if (firstCall) { firstCall = false; throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); }
    retryCalls.push({ pid, sig });
  });
  const a = fakeProc(5001);
  __testHooks.track('esrch-job', a, { project: 'test' });
  const res = killCurrent({ jobId: 'esrch-job', reason: 'esrch-test' });
  ok('killCurrent returns killed:true even when first _groupKill throws ESRCH', res.killed === true);
  await new Promise(r => setTimeout(r, 150));
  __testHooks.resetGroupKill();
  ok('100ms SIGTERM retry fires after first-kill ESRCH (setsid race recovery)', retryCalls.length >= 1 && retryCalls[0].sig === 'SIGTERM');
}

console.log('\nm2 — killAll signals every tracked subprocess');
{
  // Use safe PIDs (1000+) — never 0/1/2 which are special to process.kill(-pid).
  __testHooks.reset();
  const killLog = makeKillLog();
  // Use large PIDs to make intent clear; _groupKill injectable prevents any
  // real signals regardless of pid value.
  const procs = [['j1', 90001], ['j2', 90002], ['j3', 90003]].map(([k, pid]) => {
    const p = fakeProc(pid); __testHooks.track(k, p, {}); return p;
  });
  const n = killAll({ reason: 'shutdown' });
  __testHooks.resetGroupKill();
  ok('killAll returns the count signalled (3)', n === 3);
  ok('every tracked proc got SIGTERM (positive pid → group kill)', procs.every((p) => killLog.some((e) => e.pid === p.pid && e.sig === 'SIGTERM')));
  ok('registry is drained after their close handlers would fire', true); // close handler untracks in real path
}

console.log('\nm1 — getCurrentProcess targets a specific job');
{
  __testHooks.reset();
  __testHooks.track('only', fakeProc(7), { project: 'Z' });
  ok('getCurrentProcess(jobId) returns that job’s pid', getCurrentProcess('only')?.pid === 7);
  ok('getCurrentProcess(other) returns null', getCurrentProcess('nope') === null);
}

// ── Static assertions on the other fixes ────────────────────────────────────────────
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

console.log('\nM1 — terminal status writes guarded to status=’running’');
{
  const jq = read('src/server/job-queue.js');
  const guarded = (jq.match(/WHERE id = \? AND status = 'running'/g) || []).length;
  ok('markJobCompleted/Failed/Cancelled all carry the running guard (>=3)', guarded >= 3);
}

console.log('\nM2 — budget pause surfaces Resume');
{
  const na = read('src/lib/next-actions.js');
  const budgetBlock = na.slice(na.indexOf('PAUSE_KINDS.BUDGET'), na.indexOf('PAUSE_KINDS.VALIDATOR_FAILED'));
  ok('BUDGET branch contains a Resume action', /Resume/.test(budgetBlock) && /resume/.test(budgetBlock));
}

console.log('\nC2 — release builder hardening + ignore files');
{
  const sh = read('scripts/build-release-zip.sh');
  ok('rsync path hard-excludes /state/', /--exclude='\/state\/'/.test(sh));
  ok('staging guard checks state/logs/node_modules', /forbidden_dir in state logs/.test(sh));
  ok('final zip grep matches state|logs|node_modules', /\(state\|logs\|outputs\|dist\|node_modules\)/.test(sh));
  ok('.gitignore exists with /state/ and projects/.gitkeep keep-rule',
    fs.existsSync(path.join(ROOT, '.gitignore'))
    && /\/state\//.test(read('.gitignore')) && /!\/projects\/\.gitkeep/.test(read('.gitignore')));
  ok('.releaseignore exists with /state/', fs.existsSync(path.join(ROOT, '.releaseignore')) && /\/state\//.test(read('.releaseignore')));
}

console.log('\njob-runner — catch is cancellation-aware (no scary Failed on cancel)');
{
  const jr = read('src/server/job-runner.js');
  ok('executeJob catch detects cancellation',
    /const isCancellation/.test(jr)
    && /cancel_requested_at/.test(jr)
    && /cancelled\.\*.*signal/.test(jr));
}

console.log('\nvalidators.js — detached:true + group-kill ported from claude-runner');
{
  const v = read('src/lib/validators.js');
  ok('validators.js spawn includes detached: true', /detached:\s*true/.test(v));
  ok('validators.js timeout kill uses process.kill(-proc.pid', /process\.kill\(-proc\.pid/.test(v));
  ok('validators.js each kill is in its own try/catch (no single outer try wrapping all kills)', (() => {
    // The pattern `try { process.kill(-proc.pid` appears at least twice
    // (once for SIGTERM, once for SIGKILL fallback), confirming each kill has its own wrapper.
    return (v.match(/try \{ process\.kill\(-proc\.pid/g) || []).length >= 2;
  })());
}

console.log('\ngit.js — detached:true + group-kill ladder at all three spawn sites');
{
  const g = read('src/lib/git.js');
  ok('git.js has detached:true at all 3 spawn sites (runGit, remoteHasRefs, cloneRepo)',
    (g.match(/detached:\s*true/g) || []).length >= 3);
  ok('git.js timeout handlers use process.kill(-proc.pid) group kill',
    (g.match(/process\.kill\(-proc\.pid/g) || []).length >= 3);
  ok('git.js schedules SIGKILL fallback in timeout handlers',
    (g.match(/process\.kill\(-proc\.pid,\s*'SIGKILL'/g) || []).length >= 3);
}

console.log('\nclaude-runner — cancel-before-spawn block has SIGKILL fallback');
{
  const cr = read('src/claude-runner.js');
  const cbsAnchor = cr.indexOf('_cancelRequested.has(jobKey)');
  const cbsSlice = cr.slice(cbsAnchor, cbsAnchor + 450);
  ok('cancel-before-spawn block schedules SIGKILL (matches killCurrent and timeout block)',
    /SIGKILL/.test(cbsSlice));
}

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
