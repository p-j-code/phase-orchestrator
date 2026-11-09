// Concurrent-worker simulation. Two workers each post a few console.log
// lines while their spinner is live, exactly mirroring the failure pattern
// from the screen recording (push line during a running spinner).
//
// Run with TTY mode forced so we can capture rendered bytes:
//   node --experimental-vm-modules scripts/demo-spinner.mjs 2>&1 | cat -v | head -80
// Or just run on a real terminal:
//   node scripts/demo-spinner.mjs

import chalk from 'chalk';
import { liveStatus } from '../src/lib/live-status.js';
import { workerContext } from '../src/lib/worker-context.js';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function worker(workerId, project, jobs) {
  await workerContext.run({ workerId, project }, async () => {
    for (const j of jobs) {
      const key = `w${workerId}:${j.task}`;
      liveStatus.set(key, {
        workerId,
        project,
        task: j.task,
        startedAt: Date.now(),
        state: 'running',
      });
      // Simulate some console.log interleaving during the run (like git push)
      for (let i = 0; i < j.logs; i += 1) {
        await sleep(j.duration / (j.logs + 1));
        console.log(chalk.green(`✓ ${project} log ${i + 1}: pushed develop → origin (abc${i})`));
      }
      await sleep(j.duration / (j.logs + 1));
      liveStatus.delete(key);
      console.log(chalk.green(`✓ ${project} — ${j.task} done`));
    }
  });
}

async function main() {
  liveStatus.enable();
  console.log(chalk.bold.cyan('═══ Live-status concurrent demo ═══'));
  await Promise.all([
    worker(1, 'billflow-tds', [
      { task: 'dev-execution', duration: 1500, logs: 2 },
      { task: 'fix-execution', duration: 1200, logs: 1 },
    ]),
    worker(2, 'reelchain', [
      { task: '3-phase-review', duration: 2000, logs: 3 },
    ]),
    worker(3, 'orchestrator', [
      { task: 'audit', duration: 1000, logs: 0 },
    ]),
  ]);
  liveStatus.disable();
  console.log(chalk.bold.cyan('═══ Demo complete ═══'));
}

main().catch((err) => { console.error(err); process.exit(1); });
