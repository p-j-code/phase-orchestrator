// Workspace Skills (Phase 10) — materializes the fixed, version-controlled
// skill templates under prompts/skills/ into a project's workspace/.claude/
// and merges a git-push deny rule into workspace/.claude/settings.json.
//
// Deterministic on purpose: byte-for-byte template fidelity and safe JSON-key
// preservation are exactly the kind of mechanical operation an LLM guide task
// can silently get wrong (paraphrase, reformat, drop a pre-existing key) — so
// this runs as plain Node fs code, called from both the `workspace-claude-md`
// guide task (fresh projects, src/lib/phase-runner.js) and the one-shot
// backfill (existing projects, scripts/migrate-skills.mjs). Only workspace/
// CLAUDE.md's own bespoke content stays LLM-authored.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DECISION_TYPES, parseDecisionsJsonl, renderDecisionLine } from './decisions-schema.js';
import { sanitiseContent } from './sanitise-content.js';
import { guideRoot, lessonsDistilledPath, projectConventionsPath, projectConventionsStampPath } from './guide-paths.js';

export const SKILL_NAMES = ['phase-report', 'commit-conventions', 'orchestrator-context'];

// The rule ALWAYS merged into workspace/.claude/settings.json's permissions.deny,
// regardless of config. Matches Claude Code's Bash tool permission-pattern
// syntax (verb + glob). Kept as its own export (not folded into the config
// deny_rules list) because it is a hard invariant — a dev session must never be
// able to push — that no config layer is allowed to switch off.
export const PUSH_DENY_RULE = 'Bash(git push*)';

// Phase 45 — filesystem deny-rule sandbox.
//
// DEFENSE-IN-DEPTH, NOT A JAIL. The deny_rules merged here (config-driven,
// security.deny_rules) close the HIGH-PROBABILITY Read-tool paths a spawned dev
// session would use to read secrets that live OUTSIDE its workspace — the real
// secrets are files three directories up from every workspace (config/*.json),
// plus the operator's ~/.ssh, ~/.aws, ~/.gnupg and Claude credentials. A
// determined agent can still reach the same bytes another way: e.g.
// `Bash(cat ../../../config/telegram.json)` is NOT covered by a `Read()` rule.
// That residual is closed by the OTHER layers (P3's env allowlist, phase-44's
// ship gate), not by pretending this ruleset is a sandbox boundary. See
// docs/ARCHITECTURE.md.
//
// A relative filesystem rule (`Read(../../../config/**)`) only holds if the
// spawned session's CWD is exactly the workspace and reaches config/ by the
// literal `../../../` walk. Under a symlinked or nested checkout that walk can
// resolve elsewhere, so for every relative-path Read/Edit/Write rule we ALSO
// emit an absolute-path twin in Claude Code's `//<abs-path>` form, computed
// once from the real install location. The twin is stable per install, so
// re-merging is a byte-for-byte no-op (the merge stays idempotent).

/**
 * Compute the absolute-path twin of a relative-path filesystem deny rule, in
 * Claude Code's `//<abs>` absolute-rule form. Returns null for a rule that is
 * not a relative-path Read/Edit/Write rule (Bash verb rules and `~`-anchored
 * home-dir rules resolve on their own and need no twin). Pure/deterministic —
 * `path.resolve` is lexical, so the same (rule, workspaceDir) always yields the
 * same twin, which is what keeps the merge idempotent.
 *
 * @param {string} rule
 * @param {string} workspaceDir - absolute path the relative rule is anchored to
 * @returns {string|null}
 */
export function absoluteDenyTwin(rule, workspaceDir) {
  if (typeof rule !== 'string' || !workspaceDir) return null;
  const m = /^([A-Za-z]+)\((\.\.?\/[^)]+)\)$/.exec(rule);
  if (!m) return null;
  const [, tool, relPath] = m;
  // Lexical resolution against the real workspace path → the real target dir;
  // prefixing one extra '/' turns the leading '/' into Claude Code's '//'
  // absolute-rule marker (e.g. /repo/config/** → //repo/config/**).
  const abs = path.resolve(workspaceDir, relPath);
  return `${tool}(/${abs})`;
}

/**
 * Pure — merges `rules` (the config-driven deny_rules) PLUS the always-on
 * PUSH_DENY_RULE into `existing` (a parsed .claude/settings.json object, or
 * null/undefined for "file doesn't exist yet") without touching any other key.
 *
 * Idempotent: the deny array is deduped (existing entries and foreign rules are
 * preserved in place, only genuinely-new entries are appended), so double-
 * merging the same inputs is byte-identical. When `workspaceDir` is supplied,
 * each relative-path rule also contributes its absolute-path twin
 * (absoluteDenyTwin) — inserted right after the rule it mirrors. PUSH_DENY_RULE
 * is appended last and ALWAYS, even when `rules` is empty, so a config that
 * sets `security.deny_rules: []` still cannot push.
 *
 * @param {object|null} existing
 * @param {string[]} [rules] - config deny rules (each a Tool(pattern) string)
 * @param {{ workspaceDir?: string|null }} [opts]
 * @returns {object}
 */
export function mergeDenyRules(existing, rules = [], { workspaceDir = null } = {}) {
  const settings = (existing && typeof existing === 'object' && !Array.isArray(existing)) ? { ...existing } : {};
  const permissions = { ...(settings.permissions || {}) };
  const deny = Array.isArray(permissions.deny) ? [...permissions.deny] : [];

  const toAdd = [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (typeof rule !== 'string' || !rule) continue;
    toAdd.push(rule);
    const twin = absoluteDenyTwin(rule, workspaceDir);
    if (twin) toAdd.push(twin);
  }
  toAdd.push(PUSH_DENY_RULE); // always, regardless of config

  for (const rule of toAdd) {
    if (!deny.includes(rule)) deny.push(rule);
  }
  permissions.deny = deny;
  settings.permissions = permissions;
  return settings;
}

export function skillTemplatePath(promptsDir, name) {
  return path.join(promptsDir, 'skills', name, 'SKILL.md');
}
export function workspaceSkillsDir(workspaceDir) {
  return path.join(workspaceDir, '.claude', 'skills');
}
export function workspaceSkillPath(workspaceDir, name) {
  return path.join(workspaceSkillsDir(workspaceDir), name, 'SKILL.md');
}
export function workspaceSettingsPath(workspaceDir) {
  return path.join(workspaceDir, '.claude', 'settings.json');
}

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

export async function hasWorkspaceSkills(workspaceDir) {
  return fileExists(workspaceSkillsDir(workspaceDir));
}

export async function readSkillTemplates(promptsDir) {
  const out = [];
  for (const name of SKILL_NAMES) {
    out.push({ name, content: await fs.readFile(skillTemplatePath(promptsDir, name), 'utf-8') });
  }
  return out;
}

/**
 * Back-compat thin wrapper over mergeDenyRules — merges only PUSH_DENY_RULE
 * (no config rules, no absolute twins). Retained so existing call sites/tests
 * that predate the config-driven ruleset keep working unchanged.
 */
export function mergeDenyRule(existing) {
  return mergeDenyRules(existing, []);
}

/**
 * Read-compare-maybe-write the deny ruleset into workspaceDir/.claude/settings.json.
 * Reads the current file (missing/invalid → treated as empty), merges the
 * config deny_rules + PUSH_DENY_RULE (+ absolute twins), and writes ONLY when
 * the serialized result differs — an unchanged file is never rewritten, so its
 * mtime and the workspace git tree stay untouched (this file is committed into
 * the project's own repo; a needless rewrite would dirty it and churn the
 * dev/heal git preflight). Safe to call every run: the same rules resolve to
 * the same bytes, so steady-state is a pure read.
 *
 * @param {string} workspaceDir
 * @param {string[]} [denyRules] - config-driven security.deny_rules
 * @returns {Promise<{ settingsPath: string, settingsChanged: boolean }>}
 */
export async function mergeWorkspaceDenyRules(workspaceDir, denyRules = []) {
  const settingsPath = workspaceSettingsPath(workspaceDir);
  let existing = null;
  try { existing = JSON.parse(await fs.readFile(settingsPath, 'utf-8')); } catch { /* missing or invalid — start fresh */ }
  const merged = mergeDenyRules(existing, denyRules, { workspaceDir });
  const settingsChanged = JSON.stringify(merged) !== JSON.stringify(existing);
  if (settingsChanged) {
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);
  }
  return { settingsPath, settingsChanged };
}

/**
 * Copies the 3 skill templates verbatim into `workspaceDir/.claude/skills/`
 * and merges the git-push deny rule into `workspaceDir/.claude/settings.json`.
 *
 * @param {string} workspaceDir - absolute path to the project's workspace/
 * @param {string} promptsDir - absolute path to the repo's prompts/ (source of templates)
 * @param {{ preserveExisting?: boolean, denyRules?: string[] }} [opts] - when
 *   preserveExisting is true (default), an already-existing skill file is left
 *   untouched rather than overwritten (mirrors workspace_claude_md.preserve_existing's
 *   intent for CLAUDE.md itself). denyRules is the config-driven
 *   security.deny_rules list merged into settings.json alongside PUSH_DENY_RULE.
 * @returns {Promise<{ written: string[], skipped: string[], settingsPath: string, settingsChanged: boolean }>}
 */
export async function materializeWorkspaceSkills(workspaceDir, promptsDir, { preserveExisting = true, denyRules = [] } = {}) {
  const templates = await readSkillTemplates(promptsDir);
  const written = [];
  const skipped = [];
  for (const { name, content } of templates) {
    const dest = workspaceSkillPath(workspaceDir, name);
    if (preserveExisting && await fileExists(dest)) {
      skipped.push(name);
      continue;
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, content);
    written.push(name);
  }

  const { settingsPath, settingsChanged } = await mergeWorkspaceDenyRules(workspaceDir, denyRules);

  return { written, skipped, settingsPath, settingsChanged };
}

// ─── Project conventions materialization (Phase 42) ─────────────────────────
//
// Distilled lessons (.guide/lessons-distilled.md) used to ride every dev/fix
// spawn via loadLessonsBlock's DISTILLED section, even on phases that touch
// none of that material. This materializes the durable knowledge instead:
// one deterministic .guide/project-conventions.md, generated from the SAME
// two sources (.guide/decisions.jsonl + .guide/lessons-distilled.md) that
// already feed the injected blocks — grouped by decision type, plus the
// distilled anti-patterns text under its own heading. Lives in .guide/,
// NEVER workspace/ — a regenerated workspace file would leave the repo dirty
// and trip preflightForDev/auto-healer stash churn (see materializeWorkspaceSkills
// above, which owns a DIFFERENT lifecycle: hand-editable files inside the
// project's own git repo).

const CONVENTIONS_SECTION_TITLES = Object.freeze({
  arch: 'Architecture',
  convention: 'Conventions',
  constraint: 'Constraints',
  deferral: 'Deferrals',
});

// Matches the cap loadLessonsBlock already applies to the distilled section
// (phase-runner.js) — the conventions file replaces that injection, not a
// looser version of it.
const CONVENTIONS_DISTILLED_MAX_CHARS = 6000;

/**
 * Pure, deterministic render of project-conventions.md's body: durable
 * decisions grouped by type (DECISION_TYPES order: arch, convention,
 * constraint, deferral — decisions-schema.js), each rendered via
 * renderDecisionLine (same capped + XML-escaped rendering the injected
 * <decisions_log> block already uses), followed by an "Anti-patterns"
 * section holding the distilled-lessons text (capped + sanitised). No I/O,
 * no Date — byte-identical for the same inputs.
 *
 * @param {object[]} decisionsEntries - already schema-validated (parseDecisionsJsonl)
 * @param {string} distilledText - raw .guide/lessons-distilled.md content
 * @returns {string}
 */
export function renderProjectConventions(decisionsEntries, distilledText) {
  const entries = Array.isArray(decisionsEntries) ? decisionsEntries : [];
  const lines = [
    '# Project Conventions',
    '',
    '_Materialized from .guide/decisions.jsonl and .guide/lessons-distilled.md — regenerated automatically on every dev/fix spawn; do not hand-edit._',
  ];

  for (const type of DECISION_TYPES) {
    const group = entries.filter((e) => e?.type === type);
    if (!group.length) continue;
    lines.push('', `## ${CONVENTIONS_SECTION_TITLES[type]}`, '', ...group.map(renderDecisionLine));
  }

  const distilled = typeof distilledText === 'string' ? distilledText.trim() : '';
  if (distilled) {
    lines.push('', '## Anti-patterns (distilled from prior failures)', '', sanitiseContent(distilled, CONVENTIONS_DISTILLED_MAX_CHARS));
  }

  return `${lines.join('\n')}\n`;
}

async function readTextSafe(p) {
  try { return await fs.readFile(p, 'utf-8'); } catch { return null; }
}

// SHA-256 of the two raw sources, NUL-joined so a byte sequence split
// differently across the two inputs can never collide with a different
// split — mirrors brief-manager.js's briefHash content-hash-stamp pattern
// (content, never mtime), applied to two sources instead of one file.
function conventionsSourceHash(decisionsRaw, distilledRaw) {
  return createHash('sha256').update(`${decisionsRaw || ''}\u0000${distilledRaw || ''}`).digest('hex');
}

/**
 * Regenerates .guide/project-conventions.md from .guide/decisions.jsonl +
 * .guide/lessons-distilled.md, guarded by a content-hash stamp
 * (.guide/project-conventions.stamp.json) so an unchanged source pair is a
 * single-hash-comparison no-op per spawn — changed sources always overwrite
 * (regenerated, never preserved/merged; this file is orchestrator-owned,
 * unlike materializeWorkspaceSkills' preserveExisting skill files). Never
 * throws on missing sources (both fail open to '', matching every other
 * fail-open reader in this codebase) — I/O errors on the write itself DO
 * propagate, so the caller (runDev's pre-spawn path) can wrap this in its
 * own best-effort try/catch per the brief's "fail-open everywhere" NFR.
 *
 * @param {string} projDir
 * @returns {Promise<{ written: boolean, path: string }>}
 */
export async function materializeProjectConventions(projDir) {
  const decisionsRaw = await readTextSafe(path.join(guideRoot(projDir), 'decisions.jsonl'));
  const distilledRaw = await readTextSafe(lessonsDistilledPath(projDir));
  const sourceHash = conventionsSourceHash(decisionsRaw, distilledRaw);

  const stampPath = projectConventionsStampPath(projDir);
  const convPath = projectConventionsPath(projDir);

  let prevStamp = null;
  try { prevStamp = JSON.parse(await fs.readFile(stampPath, 'utf-8')); } catch { /* missing/invalid — no stamp yet */ }
  if (prevStamp?.source_hash === sourceHash) {
    return { written: false, path: convPath };
  }

  const entries = decisionsRaw ? parseDecisionsJsonl(decisionsRaw, 0) : [];
  const content = renderProjectConventions(entries, distilledRaw || '');
  await fs.mkdir(path.dirname(convPath), { recursive: true });
  await fs.writeFile(convPath, content, 'utf-8');
  await fs.writeFile(stampPath, `${JSON.stringify({ source_hash: sourceHash }, null, 2)}\n`, 'utf-8');
  return { written: true, path: convPath };
}
