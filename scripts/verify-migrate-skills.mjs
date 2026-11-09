// verify-migrate-skills.mjs — Phase 10 fixture verifier for
// scripts/migrate-skills.mjs. Creates small throwaway project directories
// under the REAL projects/ folder (resolveConfig's REPO_ROOT is not
// injectable, so per-project overrides can only be exercised against a real
// projects/<name>/project.json) with clearly-prefixed names, exercises
// migrateProjectDir() against them, then deletes the fixtures unconditionally
// in a finally block. Never touches any pre-existing project.
//
// Run with: node scripts/verify-migrate-skills.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { migrateProjectDir } from './migrate-skills.mjs';
import { hasWorkspaceSkills, workspaceSettingsPath, PUSH_DENY_RULE } from '../src/lib/workspace-skills.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');
const FIXTURE_PREFIX = 'zzfixture-migrate-skills-';

let passed = 0;
let failed = 0;
function check(label, ok, details) {
  if (ok) { console.log(chalk.green('  OK  '), label); passed += 1; }
  else { console.log(chalk.red('  FAIL'), label, details ? chalk.dim(`— ${details}`) : ''); failed += 1; }
}

async function mkFixtureProject(name, { overrides = {}, withWorkspace = true, preExistingSettings = null, preExistingSkills = false } = {}) {
  const projDir = path.join(PROJECTS_DIR, name);
  await fs.mkdir(projDir, { recursive: true });
  await fs.writeFile(projDir + '/project.json', JSON.stringify({
    $schema_version: 1,
    name,
    created_at: '2026-01-01T00:00:00.000Z',
    current_phase: 0,
    total_phases: 0,
    status: 'planning',
    overrides,
  }, null, 2));

  if (withWorkspace) {
    const workspaceDir = path.join(projDir, 'workspace');
    await fs.mkdir(workspaceDir, { recursive: true });
    if (preExistingSettings) {
      const claudeDir = path.join(workspaceDir, '.claude');
      await fs.mkdir(claudeDir, { recursive: true });
      await fs.writeFile(path.join(claudeDir, 'settings.json'), JSON.stringify(preExistingSettings, null, 2));
    }
    if (preExistingSkills) {
      await fs.mkdir(path.join(workspaceDir, '.claude', 'skills', 'phase-report'), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, '.claude', 'skills', 'phase-report', 'SKILL.md'), 'stale');
    }
  }
  return projDir;
}

async function rmFixtureProject(projDir) {
  await fs.rm(projDir, { recursive: true, force: true });
}

console.log(chalk.bold('\n── migrate-skills verifier ──\n'));

const fixtures = [];
try {
  // A: default config, no workspace-claude-md overrides → eligible, not yet scaffolded.
  const aName = `${FIXTURE_PREFIX}eligible`;
  const aDir = await mkFixtureProject(aName);
  fixtures.push(aDir);
  const aResult = await migrateProjectDir(aName, aDir);
  check('eligible + not-yet-scaffolded project → status "migrated"', aResult.status === 'migrated', aResult.status);
  check('migrated project now has .claude/skills/', await hasWorkspaceSkills(path.join(aDir, 'workspace')));

  const aSecond = await migrateProjectDir(aName, aDir);
  check('second run on the same project → "already-scaffolded" (idempotent no-op)', aSecond.status === 'already-scaffolded', aSecond.status);

  // B: opted out via both flags false.
  const bName = `${FIXTURE_PREFIX}opted-out`;
  const bDir = await mkFixtureProject(bName, {
    overrides: { workspace_claude_md: { auto_generate_on_new: false, auto_generate_during_autorun: false } },
  });
  fixtures.push(bDir);
  const bResult = await migrateProjectDir(bName, bDir);
  check('auto_generate_on_new:false + auto_generate_during_autorun:false → "opted-out"', bResult.status === 'opted-out', bResult.status);
  check('opted-out project is NOT scaffolded', !(await hasWorkspaceSkills(path.join(bDir, 'workspace'))));

  // C: generate_skills:false kill-switch, independent of the auto_generate_* flags.
  const cName = `${FIXTURE_PREFIX}kill-switch`;
  const cDir = await mkFixtureProject(cName, { overrides: { workspace_claude_md: { generate_skills: false } } });
  fixtures.push(cDir);
  const cResult = await migrateProjectDir(cName, cDir);
  check('generate_skills:false → "opted-out" even though auto_generate_on_new defaults true', cResult.status === 'opted-out', cResult.status);

  // D: already scaffolded (pre-existing .claude/skills/) → skipped whole-cloth.
  const dName = `${FIXTURE_PREFIX}already-scaffolded`;
  const dDir = await mkFixtureProject(dName);
  fixtures.push(dDir);
  await fs.mkdir(path.join(dDir, 'workspace', '.claude', 'skills', 'phase-report'), { recursive: true });
  await fs.writeFile(path.join(dDir, 'workspace', '.claude', 'skills', 'phase-report', 'SKILL.md'), 'stale hand-authored');
  const dResult = await migrateProjectDir(dName, dDir);
  check('pre-existing .claude/skills/ → "already-scaffolded", untouched', dResult.status === 'already-scaffolded');
  const dContent = await fs.readFile(path.join(dDir, 'workspace', '.claude', 'skills', 'phase-report', 'SKILL.md'), 'utf-8');
  check('already-scaffolded workspace content is left byte-for-byte untouched', dContent === 'stale hand-authored', dContent);

  // E: no workspace/ dir at all.
  const eName = `${FIXTURE_PREFIX}no-workspace`;
  const eDir = await mkFixtureProject(eName, { withWorkspace: false });
  fixtures.push(eDir);
  const eResult = await migrateProjectDir(eName, eDir);
  check('project with no workspace/ dir → "no-workspace"', eResult.status === 'no-workspace', eResult.status);

  // F: hand-authored settings.json with pre-existing keys → merge preserves them.
  const fName = `${FIXTURE_PREFIX}preserve-settings`;
  const fDir = await mkFixtureProject(fName, {
    preExistingSettings: { model: 'claude-sonnet-4-6', permissions: { allow: ['Read(./**)'], deny: ['Write(/etc/**)'] } },
  });
  fixtures.push(fDir);
  const fResult = await migrateProjectDir(fName, fDir);
  check('migration with pre-existing settings.json → "migrated"', fResult.status === 'migrated', fResult.status);
  const fSettings = JSON.parse(await fs.readFile(workspaceSettingsPath(path.join(fDir, 'workspace')), 'utf-8'));
  check('pre-existing model + permissions.allow preserved', fSettings.model === 'claude-sonnet-4-6' && JSON.stringify(fSettings.permissions.allow) === JSON.stringify(['Read(./**)']));
  check('pre-existing deny entry kept AND push-deny rule appended alongside it',
    JSON.stringify(fSettings.permissions.deny) === JSON.stringify(['Write(/etc/**)', PUSH_DENY_RULE]), JSON.stringify(fSettings.permissions.deny));
} finally {
  for (const dir of fixtures) await rmFixtureProject(dir);
  // Belt-and-braces: sweep any stray fixture dirs left by a prior interrupted run.
  try {
    const entries = await fs.readdir(PROJECTS_DIR);
    for (const e of entries) {
      if (e.startsWith(FIXTURE_PREFIX)) await rmFixtureProject(path.join(PROJECTS_DIR, e));
    }
  } catch { /* ignore */ }
}

console.log('');
if (failed === 0) {
  console.log(chalk.green.bold(`✓ All ${passed} checks passed.`));
  process.exit(0);
} else {
  console.log(chalk.red.bold(`✗ ${failed} failed, ${passed} passed.`));
  process.exit(1);
}
