// Tests for Phase 10's workspace-skills materialization (deterministic
// copy of prompts/skills/*/SKILL.md into workspace/.claude/skills/, plus
// merging a git-push deny rule into workspace/.claude/settings.json).
//
// Run with: node --test src/lib/workspace-skills.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SKILL_NAMES, PUSH_DENY_RULE, mergeDenyRule, mergeDenyRules, mergeWorkspaceDenyRules,
  absoluteDenyTwin, materializeWorkspaceSkills,
  hasWorkspaceSkills, workspaceSkillPath, workspaceSettingsPath,
  renderProjectConventions, materializeProjectConventions,
} from './workspace-skills.js';
import { projectConventionsPath, projectConventionsStampPath } from './guide-paths.js';
import { workspaceStatus } from './git.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_PROMPTS_DIR = path.resolve(__dirname, '..', '..', 'prompts');

async function mkWorkspaceDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'aorch-workspace-skills-test-'));
}

test('mergeDenyRule: no existing settings → creates permissions.deny with just the rule', () => {
  const merged = mergeDenyRule(null);
  assert.deepEqual(merged, { permissions: { deny: [PUSH_DENY_RULE] } });
});

test('mergeDenyRule: preserves pre-existing hand-authored keys (model, permissions.allow, other deny entries)', () => {
  const existing = {
    model: 'claude-sonnet-4-6',
    permissions: {
      allow: ['Read(./**)', 'Bash(git:*)'],
      deny: ['Write(/etc/**)'],
    },
  };
  const merged = mergeDenyRule(existing);
  assert.equal(merged.model, 'claude-sonnet-4-6');
  assert.deepEqual(merged.permissions.allow, ['Read(./**)', 'Bash(git:*)']);
  assert.deepEqual(merged.permissions.deny, ['Write(/etc/**)', PUSH_DENY_RULE]);
});

test('mergeDenyRule: idempotent — re-merging an already-present rule does not duplicate it', () => {
  const once = mergeDenyRule(null);
  const twice = mergeDenyRule(once);
  assert.deepEqual(twice.permissions.deny, [PUSH_DENY_RULE]);
});

// ─── Phase 45: config-driven filesystem deny-rule sandbox ───────────────────

// Mirror of config/defaults.json's security.deny_rules — the config layer
// supplies these; workspace-skills.js merges them + always PUSH_DENY_RULE.
const CONFIG_DENY_RULES = [
  'Read(../../../config/**)',
  'Read(~/.ssh/**)',
  'Read(~/.aws/**)',
  'Read(~/.gnupg/**)',
  'Read(~/.claude/.credentials.json)',
  'Bash(curl:*)',
  'Bash(wget:*)',
];

test('mergeDenyRules: ALWAYS includes Bash(git push*) even when the config deny_rules list is []', () => {
  const merged = mergeDenyRules(null, []);
  assert.deepEqual(merged.permissions.deny, [PUSH_DENY_RULE]);
  // Same when rules is omitted entirely.
  assert.deepEqual(mergeDenyRules(null).permissions.deny, [PUSH_DENY_RULE]);
});

test('mergeDenyRules: idempotent — a double-merge with the same inputs is byte-identical, and dedupes', () => {
  const workspaceDir = '/tmp/x/projects/aorch/workspace';
  const once = mergeDenyRules(null, CONFIG_DENY_RULES, { workspaceDir });
  const twice = mergeDenyRules(once, CONFIG_DENY_RULES, { workspaceDir });
  assert.equal(JSON.stringify(twice), JSON.stringify(once), 'second merge must be byte-identical');
  // No entry appears more than once.
  const deny = twice.permissions.deny;
  assert.equal(new Set(deny).size, deny.length, 'deny array must be deduped');
});

test('mergeDenyRules: preserves unrelated settings keys and pre-existing foreign deny entries', () => {
  const existing = {
    model: 'claude-sonnet-4-6',
    permissions: {
      allow: ['Read(./**)'],
      deny: ['Write(/etc/**)'],
    },
    hooks: { PreToolUse: [] },
  };
  const merged = mergeDenyRules(existing, CONFIG_DENY_RULES, { workspaceDir: '/tmp/x/projects/aorch/workspace' });
  assert.equal(merged.model, 'claude-sonnet-4-6');
  assert.deepEqual(merged.permissions.allow, ['Read(./**)']);
  assert.deepEqual(merged.hooks, { PreToolUse: [] });
  // Foreign deny entry stays first, in place.
  assert.equal(merged.permissions.deny[0], 'Write(/etc/**)');
  assert.ok(merged.permissions.deny.includes(PUSH_DENY_RULE));
});

test('absoluteDenyTwin: only relative-path filesystem rules get a // absolute twin', () => {
  const workspaceDir = '/tmp/x/projects/aorch/workspace';
  const expectedConfigAbs = `/${path.resolve(workspaceDir, '../../../config/**')}`; // leading // marker
  assert.equal(absoluteDenyTwin('Read(../../../config/**)', workspaceDir), `Read(${expectedConfigAbs})`);
  assert.ok(absoluteDenyTwin('Read(../../../config/**)', workspaceDir).startsWith('Read(//'));
  // `~`-anchored and Bash verb rules resolve on their own — no twin.
  assert.equal(absoluteDenyTwin('Read(~/.ssh/**)', workspaceDir), null);
  assert.equal(absoluteDenyTwin('Bash(curl:*)', workspaceDir), null);
  assert.equal(absoluteDenyTwin(PUSH_DENY_RULE, workspaceDir), null);
  // No workspaceDir → no twin possible.
  assert.equal(absoluteDenyTwin('Read(../../../config/**)', null), null);
});

test('mergeDenyRules: merged deny holds the config-dir rule in BOTH relative and absolute forms + ~/.ssh, and NOTHING covering ../.guide', () => {
  const workspaceDir = '/tmp/x/projects/aorch/workspace';
  const deny = mergeDenyRules(null, CONFIG_DENY_RULES, { workspaceDir }).permissions.deny;

  // config-dir rule — relative form.
  assert.ok(deny.includes('Read(../../../config/**)'), 'relative config-dir rule present');
  // config-dir rule — absolute twin (Claude Code // form).
  const expectedAbs = `Read(/${path.resolve(workspaceDir, '../../../config/**')})`;
  assert.ok(deny.includes(expectedAbs), `absolute config-dir twin present (${expectedAbs})`);
  assert.ok(deny.some((r) => r.startsWith('Read(//')), 'at least one // absolute rule present');
  // ssh rule present.
  assert.ok(deny.includes('Read(~/.ssh/**)'), '~/.ssh rule present');

  // Do-not-break invariant: NO rule may match or cover ../.guide (dev agents
  // must keep reading ../.guide decisions/reports), and no blanket ../** rule.
  assert.ok(deny.every((r) => !r.includes('.guide')), `no deny rule may reference .guide, found: ${deny.filter((r) => r.includes('.guide')).join(', ')}`);
  assert.ok(!deny.includes('Read(../**)'), 'no blanket Read(../**) rule');
  assert.ok(deny.every((r) => !/\(\.\.\/\*\*\)/.test(r)), 'no blanket parent-glob rule');
});

test('mergeWorkspaceDenyRules: fixture with a pre-existing minimal settings.json — merges rules, keeps original keys, second run does not rewrite', async () => {
  const workspaceDir = await mkWorkspaceDir();
  try {
    const claudeDir = path.join(workspaceDir, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });
    const preExisting = { model: 'claude-sonnet-4-6', permissions: { allow: ['Read(./**)'] } };
    await fs.writeFile(workspaceSettingsPath(workspaceDir), JSON.stringify(preExisting, null, 2));

    const first = await mergeWorkspaceDenyRules(workspaceDir, CONFIG_DENY_RULES);
    assert.equal(first.settingsChanged, true);

    const settings = JSON.parse(await fs.readFile(workspaceSettingsPath(workspaceDir), 'utf-8'));
    // Original keys intact.
    assert.equal(settings.model, 'claude-sonnet-4-6');
    assert.deepEqual(settings.permissions.allow, ['Read(./**)']);
    // Rules present (incl. absolute twin + always-on push rule).
    assert.ok(settings.permissions.deny.includes('Read(../../../config/**)'));
    assert.ok(settings.permissions.deny.some((r) => r.startsWith('Read(//')));
    assert.ok(settings.permissions.deny.includes(PUSH_DENY_RULE));

    // Second run must be a pure no-op — content AND mtime unchanged.
    const mtimeBefore = (await fs.stat(workspaceSettingsPath(workspaceDir))).mtimeMs;
    const second = await mergeWorkspaceDenyRules(workspaceDir, CONFIG_DENY_RULES);
    assert.equal(second.settingsChanged, false, 'unchanged rules must not rewrite the file');
    const mtimeAfter = (await fs.stat(workspaceSettingsPath(workspaceDir))).mtimeMs;
    assert.equal(mtimeAfter, mtimeBefore, 'mtime must be untouched on a no-op re-merge');
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test('materializeWorkspaceSkills: writes all 3 skill files byte-identical to the templates + merges settings.json', async () => {
  const workspaceDir = await mkWorkspaceDir();
  try {
    const result = await materializeWorkspaceSkills(workspaceDir, REPO_PROMPTS_DIR);
    assert.deepEqual(result.written.sort(), [...SKILL_NAMES].sort());
    assert.deepEqual(result.skipped, []);
    assert.equal(result.settingsChanged, true);

    for (const name of SKILL_NAMES) {
      const written = await fs.readFile(workspaceSkillPath(workspaceDir, name), 'utf-8');
      const template = await fs.readFile(path.join(REPO_PROMPTS_DIR, 'skills', name, 'SKILL.md'), 'utf-8');
      assert.equal(written, template, `${name} SKILL.md must be byte-identical to its template`);
    }

    const settings = JSON.parse(await fs.readFile(workspaceSettingsPath(workspaceDir), 'utf-8'));
    assert.deepEqual(settings.permissions.deny, [PUSH_DENY_RULE]);
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test('materializeWorkspaceSkills: preserves hand-authored settings.json keys already on disk', async () => {
  const workspaceDir = await mkWorkspaceDir();
  try {
    const claudeDir = path.join(workspaceDir, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });
    const preExisting = {
      model: 'claude-sonnet-4-6',
      permissions: { allow: ['Read(./**)'], deny: ['Write(/etc/**)'] },
    };
    await fs.writeFile(workspaceSettingsPath(workspaceDir), JSON.stringify(preExisting, null, 2));

    await materializeWorkspaceSkills(workspaceDir, REPO_PROMPTS_DIR);

    const settings = JSON.parse(await fs.readFile(workspaceSettingsPath(workspaceDir), 'utf-8'));
    assert.equal(settings.model, 'claude-sonnet-4-6');
    assert.deepEqual(settings.permissions.allow, ['Read(./**)']);
    assert.deepEqual(settings.permissions.deny, ['Write(/etc/**)', PUSH_DENY_RULE]);
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test('materializeWorkspaceSkills: second run is a no-op (idempotent) — preserveExisting skips skill rewrites, settings merge detects no change', async () => {
  const workspaceDir = await mkWorkspaceDir();
  try {
    const first = await materializeWorkspaceSkills(workspaceDir, REPO_PROMPTS_DIR);
    assert.equal(first.written.length, SKILL_NAMES.length);

    const second = await materializeWorkspaceSkills(workspaceDir, REPO_PROMPTS_DIR);
    assert.deepEqual(second.written, []);
    assert.deepEqual(second.skipped.sort(), [...SKILL_NAMES].sort());
    assert.equal(second.settingsChanged, false);
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test('materializeWorkspaceSkills: preserveExisting:false overwrites a hand-edited skill file with the current template', async () => {
  const workspaceDir = await mkWorkspaceDir();
  try {
    const dest = workspaceSkillPath(workspaceDir, 'phase-report');
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, 'stale hand-edited content');

    const preserved = await materializeWorkspaceSkills(workspaceDir, REPO_PROMPTS_DIR, { preserveExisting: true });
    assert.ok(preserved.skipped.includes('phase-report'));
    assert.equal(await fs.readFile(dest, 'utf-8'), 'stale hand-edited content');

    const overwritten = await materializeWorkspaceSkills(workspaceDir, REPO_PROMPTS_DIR, { preserveExisting: false });
    assert.ok(overwritten.written.includes('phase-report'));
    const template = await fs.readFile(path.join(REPO_PROMPTS_DIR, 'skills', 'phase-report', 'SKILL.md'), 'utf-8');
    assert.equal(await fs.readFile(dest, 'utf-8'), template);
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test('hasWorkspaceSkills: false before materialization, true after', async () => {
  const workspaceDir = await mkWorkspaceDir();
  try {
    assert.equal(await hasWorkspaceSkills(workspaceDir), false);
    await materializeWorkspaceSkills(workspaceDir, REPO_PROMPTS_DIR);
    assert.equal(await hasWorkspaceSkills(workspaceDir), true);
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

// ─── renderProjectConventions / materializeProjectConventions (Phase 42) ────

const FOUR_TYPE_DECISIONS = [
  { phase: '1', title: 'Module boundary', decision: 'Billing lives in src/billing-guard.js only', rationale: 'single seam for spend checks', type: 'arch' },
  { phase: '2', title: 'Path joins', decision: 'All paths via path.join/path.resolve', rationale: 'no string concatenation', type: 'convention' },
  { phase: '3', title: 'No schema bump', decision: 'This cycle must not bump $schema_version', rationale: 'brief NFR', type: 'constraint' },
  { phase: '4', title: 'Suggestion merge', decision: 'Cross-project suggestion merging is out of scope', rationale: 'non-goal per project context', type: 'deferral' },
];
const DISTILLED_TEXT = '- Do not mock the database in integration tests.\n- Always sanitise agent-authored content before injection.\n';

test('renderProjectConventions: all four decision types + distilled text produce stable grouped markdown; two calls are byte-identical', () => {
  const a = renderProjectConventions(FOUR_TYPE_DECISIONS, DISTILLED_TEXT);
  const b = renderProjectConventions([...FOUR_TYPE_DECISIONS.map((e) => ({ ...e }))], DISTILLED_TEXT);
  assert.equal(a, b);

  assert.match(a, /^# Project Conventions/);
  assert.match(a, /## Architecture/);
  assert.match(a, /## Conventions/);
  assert.match(a, /## Constraints/);
  assert.match(a, /## Deferrals/);
  assert.match(a, /## Anti-patterns \(distilled from prior failures\)/);
  assert.ok(a.includes('Module boundary'));
  assert.ok(a.includes('Do not mock the database'));

  // Grouping order follows DECISION_TYPES (arch, convention, constraint, deferral).
  const archIdx = a.indexOf('## Architecture');
  const convIdx = a.indexOf('## Conventions');
  const constraintIdx = a.indexOf('## Constraints');
  const deferralIdx = a.indexOf('## Deferrals');
  const antiPatternsIdx = a.indexOf('## Anti-patterns');
  assert.ok(archIdx < convIdx && convIdx < constraintIdx && constraintIdx < deferralIdx && deferralIdx < antiPatternsIdx);
});

test('renderProjectConventions: an empty decisions array + empty distilled text renders just the header (no empty section headings)', () => {
  const out = renderProjectConventions([], '');
  assert.match(out, /^# Project Conventions/);
  assert.doesNotMatch(out, /## Architecture/);
  assert.doesNotMatch(out, /## Anti-patterns/);
});

async function mkProjDirWithGitWorkspace() {
  const projDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aorch-project-conventions-test-'));
  const { execSync } = await import('node:child_process');
  const workspaceDir = path.join(projDir, 'workspace');
  await fs.mkdir(workspaceDir, { recursive: true });
  execSync('git init -q', { cwd: workspaceDir });
  execSync('git config user.email t@example.com', { cwd: workspaceDir });
  execSync('git config user.name test', { cwd: workspaceDir });
  await fs.writeFile(path.join(workspaceDir, 'README.md'), '# demo\n');
  execSync('git add -A', { cwd: workspaceDir });
  execSync('git commit -q -m init', { cwd: workspaceDir });
  return { projDir, workspaceDir };
}

test('materializeProjectConventions: unchanged sources are a no-op (hash-stamp), changed decisions rewrite the file', async () => {
  const projDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aorch-project-conventions-test-'));
  try {
    await fs.mkdir(path.join(projDir, '.guide'), { recursive: true });
    await fs.writeFile(
      path.join(projDir, '.guide', 'decisions.jsonl'),
      JSON.stringify(FOUR_TYPE_DECISIONS[0]) + '\n',
    );

    const first = await materializeProjectConventions(projDir);
    assert.equal(first.written, true);
    const firstContent = await fs.readFile(projectConventionsPath(projDir), 'utf-8');
    const firstStamp = await fs.readFile(projectConventionsStampPath(projDir), 'utf-8');

    // Same sources, second call — must be a no-op (stamp hash matches).
    const second = await materializeProjectConventions(projDir);
    assert.equal(second.written, false);
    assert.equal(await fs.readFile(projectConventionsPath(projDir), 'utf-8'), firstContent);
    assert.equal(await fs.readFile(projectConventionsStampPath(projDir), 'utf-8'), firstStamp);

    // Changed decisions.jsonl — must rewrite.
    await fs.writeFile(
      path.join(projDir, '.guide', 'decisions.jsonl'),
      JSON.stringify(FOUR_TYPE_DECISIONS[0]) + '\n' + JSON.stringify(FOUR_TYPE_DECISIONS[1]) + '\n',
    );
    const third = await materializeProjectConventions(projDir);
    assert.equal(third.written, true);
    const thirdContent = await fs.readFile(projectConventionsPath(projDir), 'utf-8');
    assert.notEqual(thirdContent, firstContent);
    assert.ok(thirdContent.includes('Path joins'));
  } finally {
    await fs.rm(projDir, { recursive: true, force: true });
  }
});

test('materializeProjectConventions: fail-open on missing sources — no decisions.jsonl/lessons-distilled.md still writes a header-only file, never throws', async () => {
  const projDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aorch-project-conventions-test-'));
  try {
    const result = await materializeProjectConventions(projDir);
    assert.equal(result.written, true);
    const content = await fs.readFile(projectConventionsPath(projDir), 'utf-8');
    assert.match(content, /^# Project Conventions/);
  } finally {
    await fs.rm(projDir, { recursive: true, force: true });
  }
});

test('materializeProjectConventions: writes ONLY under .guide/ — the sibling workspace/ git tree stays completely clean', async () => {
  const { projDir, workspaceDir } = await mkProjDirWithGitWorkspace();
  try {
    await fs.mkdir(path.join(projDir, '.guide'), { recursive: true });
    await fs.writeFile(
      path.join(projDir, '.guide', 'decisions.jsonl'),
      JSON.stringify(FOUR_TYPE_DECISIONS[0]) + '\n',
    );
    await fs.writeFile(path.join(projDir, '.guide', 'lessons-distilled.md'), DISTILLED_TEXT);

    await materializeProjectConventions(projDir);

    assert.ok(await fs.readFile(projectConventionsPath(projDir), 'utf-8'));
    assert.ok(await fs.readFile(projectConventionsStampPath(projDir), 'utf-8'));

    const status = await workspaceStatus(workspaceDir);
    assert.equal(status.clean, true, `workspace/ must stay untouched, found: ${status.dirty.join(', ')}`);
  } finally {
    await fs.rm(projDir, { recursive: true, force: true });
  }
});
