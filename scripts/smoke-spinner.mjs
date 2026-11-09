// Boot-time integration check. Imports the same modules the real server
// would in the same order, exercises the ALS+liveStatus boundary, and
// asserts no crash. Doesn't spawn claude — just the spinner plumbing.

import chalk from 'chalk';
import { workerContext, getWorkerContext } from '../src/lib/worker-context.js';
import { liveStatus, formatElapsed, makeLiveKey } from '../src/lib/live-status.js';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function runFakeClaudeCall(label) {
  const ctx = getWorkerContext();
  if (!ctx) throw new Error(`expected worker context for ${label}, got null`);
  const key = makeLiveKey(ctx.workerId, `${label}:${Date.now()}`);
  liveStatus.set(key, {
    workerId: ctx.workerId,
    project: ctx.project,
    task: label,
    startedAt: Date.now(),
    state: 'running',
    maxAttempts: 3,
  });

  // Emit a log mid-run to exercise the stdout-write interception
  await sleep(120);
  console.log(chalk.green(`[w${ctx.workerId} ${ctx.project}] ✓ ${label} pushed mid-run`));
  await sleep(120);

  // Flip into retry-wait briefly
  liveStatus.update(key, { state: 'retry-wait', attempt: 1 });
  await sleep(150);
  liveStatus.update(key, { state: 'running' });
  await sleep(120);

  liveStatus.delete(key);
  console.log(chalk.green(`[w${ctx.workerId} ${ctx.project}] ✓ ${label} done in ${formatElapsed(Date.now() - (Date.now() - 500))}`));
}

async function worker(workerId, project, jobs) {
  await workerContext.run({ workerId, project, jobId: workerId * 100 }, async () => {
    for (const j of jobs) await runFakeClaudeCall(j);
  });
}

async function main() {
  liveStatus.enable();
  console.log(chalk.bold.cyan('═══ Integration smoke ═══'));

  await Promise.all([
    worker(1, 'billflow-tds', ['dev-execution', 'fix-execution']),
    worker(2, 'reelchain', ['3-phase-review']),
  ]);

  // Verify no entries linger
  const active = liveStatus.active();
  if (active.length !== 0) {
    console.error(chalk.red(`✗ Leftover entries: ${JSON.stringify(active)}`));
    process.exit(1);
  }

  liveStatus.disable();
  console.log(chalk.bold.green('═══ Smoke PASS ═══'));
}

main().catch((err) => {
  console.error(chalk.red('Smoke FAIL:'), err);
  process.exit(1);
});
