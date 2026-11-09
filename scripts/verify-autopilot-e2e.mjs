#!/usr/bin/env node
// verify-autopilot-e2e.mjs — THE cycle keystone (Phase 86, P7b).
//
// Demonstrates the FULL nightly portfolio-autopilot loop end-to-end UNATTENDED:
//   fixture project with a queued brief
//     → autopilotTick at start_hour (INJECTED CLOCK)
//       → gatherPortfolioState sees the queued brief
//       → plan() emits the brief job
//       → execute() enqueues it (tg_jobs, via enqueueJob only)
//     → the job-runner (real executeJob dispatch) processes it to completion
//     → autopilotTick at digest_hour
//       → a morning-digest row lands in notify_outbox
// against an ISOLATED DB_PATH (a throwaway temp file — nothing touches the
// operator's real state DB) and an isolated projects/ fixture dir.
//
// FAKE-RUNNER SEAM (CI / this script): the ONE live-Claude touch point — the
// 'brief' job's runGuide('brief-author') spawn — is stubbed via executeJob's
// deps.runGuide seam, and the tiny fixture keeps the deterministic digest under
// the ~30-line polish threshold, so NO real LLM call is made. That is the whole
// point: "unattended" is about the ORCHESTRATION wiring draining with zero
// operator input, which this exercises faithfully.
//
// REAL INVOCATION (run once before declaring the cycle done): start a real
// bot server (`npm run server`) with `autopilot.enabled: true` and
// `autopilot.start_hour` set to the current local hour, drop a real
// `.guide/raw-thoughts.md` into a project with no brief yet, and let the
// scheduler tick fire the real runGuide('brief-author') spawn — then read the
// morning digest off the notify_outbox delivery loop. The deny-rule sandbox
// (config security.deny_rules) MUST be present or startAutopilot fails closed.
//
// Run: node scripts/verify-autopilot-e2e.mjs   (exit 0 = all pass, 1 = a failure)

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Isolated DB + skip the workspace-trust prompt — MUST be set BEFORE importing
// state.js (getDb reads process.env.DB_PATH once, on first open).
const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-e2e-'));
process.env.DB_PATH = path.join(tmpBase, 'e2e.db');
process.env.ORCHESTRATOR_SKIP_TRUST = '1';

const {
  getDb, upsertProject, listPendingOutbox,
} = await import('../src/state.js');
const {
  autopilotTick, gatherPortfolioState,
} = await import('../src/lib/portfolio-autopilot.js');
const { executeJob } = await import('../src/server/job-runner.js');
const { listPendingJobs, tryClaimJob, getJob } = await import('../src/server/job-queue.js');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); pass += 1; }
  else { console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`); fail += 1; }
}

async function main() {
  console.log('\nverify-autopilot-e2e — nightly autopilot, end-to-end unattended\n');

  getDb(); // opens the isolated DB + runs migrate() (autopilot tables present)

  // ── 1. Fixture: a project with an authored-and-waiting (queued) brief ───────
  const projectsDir = path.join(tmpBase, 'projects');
  const projName = 'e2e-nightly';
  const projDir = path.join(projectsDir, projName);
  await fs.mkdir(path.join(projDir, '.guide'), { recursive: true });
  // raw-thoughts present, NO brief.md → gatherPortfolioState → queuedBriefs = 1.
  await fs.writeFile(path.join(projDir, '.guide', 'raw-thoughts.md'), '# raw thoughts\nBuild a one-phase widget.\n');
  upsertProject({ name: projName, status: 'in-progress' });

  // ── 2. Config: autopilot ENABLED, approval override [], REAL deny-rule sandbox ─
  const cfg = {
    autopilot: {
      enabled: true, start_hour: 1, digest_hour: 8, max_projects_per_night: 3,
      priority_order: ['resume', 'brief', 'bugs', 'audit', 'suggestions'],
      require_operator_approval_for: [], // test override — the brief enqueues directly
    },
    billing: { window_headroom_min_calls: 4, pause_at_calls: 80, warn_at_calls: 50, window_reset_hours: 5 },
    // brief 04's sandbox present → startAutopilot/runNightlyPlan do NOT fail closed.
    security: { deny_rules: ['Read(../../../config/**)', 'Bash(curl:*)'] },
    tools: { allowed_default: [] },
  };

  // A fixed PAST calendar day for the injected clock, so the digest's
  // "since night start" cutoff (last_planned_at) is guaranteed before the
  // real-wall-clock timestamps enqueueJob stamps — independent of when this runs.
  const nightNow = new Date('2020-06-15T01:30:00');   // local 01:30 → start_hour 1
  const morningNow = new Date('2020-06-15T08:15:00'); // local 08:15 → digest_hour 8, same day

  const gathered = await gatherPortfolioState({ cfg, projectsDir, now: nightNow });
  check('gatherPortfolioState sees the fixture as a queued brief',
    gathered.some((p) => p.name === projName && p.queuedBriefs === 1), JSON.stringify(gathered));

  // ── 3. Night tick (injected clock) → plan() emits → execute() enqueues ──────
  const t1 = await autopilotTick({ cfg, notifier: null, now: nightNow, projectsDir });
  check('tick planned this night', t1.planned === true, JSON.stringify({ planned: t1.planned }));
  check('runNightlyPlan ran (sandbox resolved)', t1.plan?.ranPlan === true && t1.plan?.sandboxOk === true, JSON.stringify(t1.plan));
  check('plan() emitted the brief job',
    (t1.plan?.nightPlan || []).some((j) => j.project === projName && j.action === 'brief'),
    JSON.stringify(t1.plan?.nightPlan));

  const briefJob = listPendingJobs().find((j) => j.project === projName && j.action === 'brief');
  check('execute() enqueued the brief job onto tg_jobs (via enqueueJob)', !!briefJob, JSON.stringify(listPendingJobs()));

  // Once-per-night: a second tick the SAME night must NOT double-plan.
  const t2 = await autopilotTick({ cfg, notifier: null, now: nightNow, projectsDir });
  check('a second tick the same night does not double-plan', t2.planned === false);
  check('still exactly one pending brief job',
    listPendingJobs().filter((j) => j.project === projName && j.action === 'brief').length === 1);

  // ── 4. Job-runner processes it UNATTENDED (real dispatch, stubbed guide) ─────
  const fakeNotifier = { platform: 'telegram', notify: async () => ({ delivered: 1, total: 1 }) };
  const fakeGuide = async () => ({ is_error: false, result: 'brief drafted (fake-runner)', session_id: 'fake' });
  check('the queued job was claimed for processing', tryClaimJob(briefJob.id) === true);
  await executeJob(getJob(briefJob.id), fakeNotifier, { runGuide: fakeGuide });
  const done = getJob(briefJob.id);
  check('job-runner processed the brief job to completion (unattended)', done.status === 'completed', JSON.stringify(done));

  // ── 5. Morning tick (injected clock) → a digest row lands in notify_outbox ──
  const t3 = await autopilotTick({ cfg, notifier: fakeNotifier, now: morningNow, projectsDir });
  check('tick produced the morning digest', t3.digested === true);
  const digestText = t3.digest?.text || '';
  check('digest was enqueued THROUGH notify_outbox', t3.digest?.outboxId != null, JSON.stringify({ outboxId: t3.digest?.outboxId }));

  const digestRow = listPendingOutbox(50).find((r) => r.text && r.text.includes('Overnight autopilot digest'));
  check('a digest row landed in notify_outbox', !!digestRow);
  for (const section of ['Ran', 'Finished', 'Paused', 'Needs approval']) {
    check(`digest text contains the "${section}" section`, digestText.includes(section), digestText.slice(0, 400));
  }
  check('digest lists the finished brief job', /brief\s+e2e-nightly/.test(digestText), digestText.slice(0, 400));

  // Once-per-day: a second morning tick the same day does NOT re-digest.
  const t4 = await autopilotTick({ cfg, notifier: fakeNotifier, now: morningNow, projectsDir });
  check('a second morning tick the same day does not re-digest', t4.digested === false);

  await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {});

  console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('harness error:', e);
  await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
});
