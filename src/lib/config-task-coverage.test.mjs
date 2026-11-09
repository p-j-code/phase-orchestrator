import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Resolve repo root relative to this file's location (src/lib/ → ../../)
const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');

async function collectJsFiles(dir) {
  const files = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJsFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

// Returns Map<taskString, firstFilePath>
async function extractResolveConfigTasks(srcDir) {
  const files = await collectJsFiles(srcDir);
  const found = new Map();
  const TASK_RE = /resolveConfig\s*\(\s*\{[^}]*task\s*:\s*'([^']+)'/g;
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    let m;
    while ((m = TASK_RE.exec(content)) !== null) {
      if (!found.has(m[1])) {
        found.set(m[1], file);
      }
    }
  }
  return found;
}

test('every resolveConfig task string has a matching key in defaults.models', async () => {
  const srcDir = path.join(repoRoot, 'src');
  const defaultsPath = path.join(repoRoot, 'config', 'defaults.json');

  const defaults = JSON.parse(await readFile(defaultsPath, 'utf8'));
  const modelKeys = new Set(Object.keys(defaults.models ?? {}));

  const taskMap = await extractResolveConfigTasks(srcDir);

  const missing = [];
  for (const [task, file] of taskMap) {
    if (!modelKeys.has(task)) {
      missing.push(`task '${task}' (found in ${path.relative(repoRoot, file)}) is missing from defaults.models`);
    }
  }

  assert.equal(
    missing.length,
    0,
    `Config-task coverage gaps found:\n${missing.join('\n')}`,
  );
});

// Roleless single-shot guide tasks (`role: null` — see docs/ARCHITECTURE.md's
// "session-safety class" note) never run inside a phase, so they don't
// inherit max_turns_per_phase/max_turns_per_opus_phase or any phase-scoped
// wall-clock budget. Without an explicit per-task override each would fall
// back to the much larger phase-oriented defaults (max_turns_per_phase: 150,
// subprocess_timeout_ms: 30min) for what's meant to be a single bounded
// reply over data the caller already assembled — so, unlike other tasks,
// these MUST carry an explicit entry in both dicts. This list is
// intentionally static (not source-scanned): it's the set of tasks the
// project has deliberately assigned to the roleless/session-safety class,
// not every task that happens to call resolveConfig.
// phase-35: 'review-slim' (the light-review path in src/lib/review-weight.js /
// runGuide's light-review branch) is roleless/sessionless (role:null,
// sessionId:null) by the same design as acceptance-check et al. above.
// phase-36: 'review-lens' (panel-review lenses 2/3, src/lib/phase-runner.js's
// spawnReviewLens) is the same roleless/sessionless class — a fresh, scoped
// spawn that must never touch guide_session_id.
// phase-37: 'ledger-extract' (the Tier-2 haiku fallback in src/lib/ledger.js's
// extractBulletsViaHaiku) is the same class — role:null, sessionId:null, no
// projectDir (MCP-free), tools narrowed to ['Read'] via a cfg clone.
// phase-47: 'brief-conformance' (src/lib/brief-conformance.js's
// runBriefConformance, dispatched via phase-runner.js's runGuide early-return
// bypass) is the same class — a single bounded read-only spawn over the whole
// brief + code, never resumed, never escalated.
// phase-55: 'phase-scout' (src/auto-runner.js's spawnPhaseScout) is the same
// class — role:null, sessionId:null, a read-only CHECKER_ALLOWED_TOOLS
// sandbox, never resumed, never escalated (also absent from model-routing's
// escalation_tasks — the scout never escalates).
// phase-62: 'autopsy' (src/lib/autopsy.js's runAutopsy) is the same class — a
// single tool-less (allowed_default:[]) haiku JSON reply over deterministic
// context, role:null, sessionId:null, never resumed, never escalated.
// phase-82: 'acceptance-test-author' (src/lib/test-first.js's
// authorAcceptanceTests) is the same class — a DEV-SIDE roleless spawn
// (role:null, sessionId:null) that never runs inside a phase's turn/wall-clock
// budget, so it MUST carry its own explicit task_timeout_ms/task_max_turns
// rather than inherit the phase-oriented defaults. Its ONLY departure from the
// checker's sandbox is Write in tools.allowed_default; it is not passed through
// resolveConfig (the caller hands it an already-resolved cfg), so — like the
// others here — it is listed statically rather than source-scanned.
// phase-84: 'prompt-eval-judge' (the prompt-eval harness's checklist judge,
// scripts/eval-prompts.mjs) is the same class — a roleless (role:null,
// sessionId:null), tool-less (allowed_default:[]) single-shot sonnet reply that
// grades one produced artifact against a rubric, never inside a phase's
// turn/wall-clock budget, so it MUST carry its own task_timeout_ms/task_max_turns
// rather than inherit the phase-oriented defaults. It lives in scripts/ (not
// src/), so the source-scan test above never sees it — this static list is its
// registration. No hard_floors/escalation_tasks entry in config/model-routing.json
// on purpose (one re-ask via the P1 llm-contract, never a tier escalation).
// phase-86: 'autopilot-digest' (the OPTIONAL morning-digest polish call,
// src/lib/autopilot-digest.js maybePolishDigest) is the same class — a roleless
// (role:null, sessionId:null), tool-less (allowed_default:[]) single haiku reply
// that tightens the deterministic digest prose, never inside a phase's
// turn/wall-clock budget, so it MUST carry its own task_timeout_ms/task_max_turns.
// It is invoked via runClaude({ task: 'autopilot-digest' }) (not resolveConfig —
// the scheduler hands it the already-resolved cfg), so the source-scan test never
// sees it; this static list is its registration. No hard_floors/escalation_tasks
// entry in config/model-routing.json on purpose (it never escalates).
// phase-87: 'runtime-qa' (the runtime-QA agent, src/lib/runtime-qa.js's
// runRuntimeQa) is the same class — a roleless (role:null, sessionId:null),
// cwd=workspaceDir spawn that runs once per RUN, never inside a phase's
// turn/wall-clock budget, so it MUST carry its own task_timeout_ms/task_max_turns
// rather than inherit the phase-oriented defaults. It is not passed through
// resolveConfig (the caller hands it an already-resolved cfg), so — like the
// others here — it is listed statically rather than source-scanned. It is the
// ONLY roleless task whose tool profile includes Bash (Read/Glob/Grep + Bash);
// that Bash is fenced by brief 04's deny-rule sandbox (fail-closed when absent).
// No hard_floors/escalation_tasks entry in config/model-routing.json on purpose
// (one re-ask via the P1 llm-contract, never a tier escalation).
const ROLELESS_TASKS_REQUIRING_EXPLICIT_BUDGET = ['acceptance-check', 'acceptance-test-author', 'verify-prescan', 'verify-adjudicate', 'lessons-distill', 'ledger-extract', 'retrospective', 'review-slim', 'review-lens', 'brief-conformance', 'phase-scout', 'autopsy', 'prompt-eval-judge', 'autopilot-digest', 'runtime-qa'];

test('roleless session-safety tasks have explicit task_timeout_ms and task_max_turns overrides', async () => {
  const defaultsPath = path.join(repoRoot, 'config', 'defaults.json');
  const defaults = JSON.parse(await readFile(defaultsPath, 'utf8'));
  const timeoutKeys = new Set(Object.keys(defaults.phases?.task_timeout_ms ?? {}));
  const turnsKeys = new Set(Object.keys(defaults.phases?.task_max_turns ?? {}));

  const missing = [];
  for (const task of ROLELESS_TASKS_REQUIRING_EXPLICIT_BUDGET) {
    if (!timeoutKeys.has(task)) missing.push(`'${task}' is missing from phases.task_timeout_ms`);
    if (!turnsKeys.has(task)) missing.push(`'${task}' is missing from phases.task_max_turns`);
  }

  assert.equal(
    missing.length,
    0,
    `Roleless-task budget coverage gaps found:\n${missing.join('\n')}`,
  );
});

// Phase 32 (MI-10): incremental re-audits are split onto their own resolveConfig
// task id 'audit-incremental' so they route on the sonnet baseline instead of
// inheriting 'audit's conditional opus hard floor (whose fail-safe-when-no-signals
// rule caught every single-call incremental re-audit). This pins the two halves
// of that split that live in config: 'audit-incremental' mirrors every PER-TASK
// 'audit' entry in defaults.json, and its DELIBERATE absence from model-routing's
// hard_floors + escalation_tasks (that absence IS the feature).
test('audit-incremental mirrors audit\'s per-task defaults entries and has NO opus floor / escalation (phase-32)', async () => {
  const repoRootLocal = repoRoot;
  const defaults = JSON.parse(await readFile(path.join(repoRootLocal, 'config', 'defaults.json'), 'utf8'));
  const routing = JSON.parse(await readFile(path.join(repoRootLocal, 'config', 'model-routing.json'), 'utf8'));

  // Baseline model: present and same tier baseline as 'audit' (sonnet), so the
  // split changes ONLY the floor behaviour, not the starting model.
  assert.equal(defaults.models['audit-incremental'], defaults.models['audit'],
    "models['audit-incremental'] must mirror models['audit'] (the split is about floors, not the baseline)");

  // Mirror every per-task 'audit' entry that exists in the per-task maps.
  const perTaskMaps = ['task_effort', 'task_max_turns', 'task_timeout_ms'];
  for (const mapName of perTaskMaps) {
    const map = defaults.phases?.[mapName] ?? {};
    if (Object.prototype.hasOwnProperty.call(map, 'audit')) {
      assert.equal(map['audit-incremental'], map['audit'],
        `phases.${mapName}['audit-incremental'] must mirror phases.${mapName}['audit']`);
    }
  }

  // repo_map.guide_tasks: incremental re-audits inject the repo map just like
  // the single-call 'audit' path they were split from.
  const guideTasks = defaults.repo_map?.guide_tasks ?? [];
  assert.ok(guideTasks.includes('audit'), "guide_tasks should list 'audit' (baseline for the mirror)");
  assert.ok(guideTasks.includes('audit-incremental'), "guide_tasks must also list 'audit-incremental'");

  // The whole point: NO hard floor for audit-incremental, and it is NOT an
  // escalation task — either would re-introduce the opus cost this phase removes.
  assert.ok(!Object.prototype.hasOwnProperty.call(routing.hard_floors ?? {}, 'audit-incremental'),
    'model-routing.hard_floors must NOT contain audit-incremental (that absence is the feature)');
  const escalationTasks = routing.escalation_tasks ?? [];
  assert.ok(!escalationTasks.includes('audit-incremental'),
    'audit-incremental must NOT be in escalation_tasks');
});

test('every phases.task_timeout_ms / task_max_turns key also has a defaults.models entry (no stale/renamed task keys)', async () => {
  const defaultsPath = path.join(repoRoot, 'config', 'defaults.json');
  const defaults = JSON.parse(await readFile(defaultsPath, 'utf8'));
  const modelKeys = new Set(Object.keys(defaults.models ?? {}));

  const orphaned = [];
  for (const task of Object.keys(defaults.phases?.task_timeout_ms ?? {})) {
    if (!modelKeys.has(task)) orphaned.push(`'${task}' in phases.task_timeout_ms has no defaults.models entry`);
  }
  for (const task of Object.keys(defaults.phases?.task_max_turns ?? {})) {
    if (!modelKeys.has(task)) orphaned.push(`'${task}' in phases.task_max_turns has no defaults.models entry`);
  }

  assert.equal(
    orphaned.length,
    0,
    `Orphaned per-task config keys found:\n${orphaned.join('\n')}`,
  );
});
