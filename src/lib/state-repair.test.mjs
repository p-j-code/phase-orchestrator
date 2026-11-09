import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = ':memory:';

const { upsertProject, getProject } = await import('../state.js');
const { repairProjectStates } = await import('./state-repair.js');

async function writePlan(root, project, lastPhase) {
  const guide = path.join(root, project, '.guide');
  await fs.mkdir(guide, { recursive: true });
  await fs.writeFile(
    path.join(guide, 'plan.json'),
    JSON.stringify({ phases: [{ n: lastPhase, title: 'remaining' }] }),
    'utf-8',
  );
}

test('state repair preserves paused waiting state but repairs stale ready-for-qa', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'state-repair-'));
  try {
    upsertProject({ name: 'waiting-project', status: 'paused', total_phases: 1 });
    upsertProject({ name: 'stale-ready-project', status: 'ready-for-qa', total_phases: 1 });
    await writePlan(root, 'waiting-project', 3);
    await writePlan(root, 'stale-ready-project', 3);

    await repairProjectStates({ projectsDir: root });

    assert.equal(getProject('waiting-project').status, 'paused',
      'boot repair must not make a sleeping resume appear active');
    assert.equal(getProject('waiting-project').total_phases, 3,
      'independent total_phases repair still applies');
    assert.equal(getProject('stale-ready-project').status, 'in-progress',
      'a genuinely stale completion status is still repaired');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
