import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';

const { reconcileProjectGitConfig } = await import('./phase-runner.js');
const { upsertProject, getProject, setProjectGitConfig } = await import('../state.js');

test('reconcileProjectGitConfig fills legacy blank state from project metadata', () => {
  const projectName = 'git-state-reconcile-empty';
  upsertProject({ name: projectName, tech_stack: 'node', total_phases: 1 });
  const writes = [];

  const effective = reconcileProjectGitConfig({
    projectName,
    project: getProject(projectName),
    configuredProject: { git_branch: 'develop', git_remote: 'origin' },
    setGitConfig: (name, patch) => {
      writes.push({ name, patch });
      setProjectGitConfig(name, patch);
    },
  });

  assert.deepEqual(writes, [{ name: projectName, patch: { git_branch: 'develop', git_remote: 'origin' } }]);
  assert.equal(effective.git_branch, 'develop');
  assert.equal(effective.git_remote, 'origin');
  assert.equal(getProject(projectName).git_branch, 'develop');
  assert.equal(getProject(projectName).git_remote, 'origin');
});

test('reconcileProjectGitConfig never overwrites populated state', () => {
  const projectName = 'git-state-reconcile-existing';
  upsertProject({ name: projectName, tech_stack: 'node', total_phases: 1 });
  setProjectGitConfig(projectName, { git_branch: 'release', git_remote: 'upstream' });
  const writes = [];

  const effective = reconcileProjectGitConfig({
    projectName,
    project: getProject(projectName),
    configuredProject: { git_branch: 'develop', git_remote: 'origin' },
    setGitConfig: (...args) => writes.push(args),
  });

  assert.deepEqual(writes, []);
  assert.equal(effective.git_branch, 'release');
  assert.equal(effective.git_remote, 'upstream');
});
