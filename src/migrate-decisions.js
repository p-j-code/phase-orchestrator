#!/usr/bin/env node
// migrate-decisions (Phase 14) — convert legacy free-form `.guide/decisions.md`
// into the schema-validated `.guide/decisions.jsonl`.
//
// Idempotent and best-effort:
//   • Each Markdown bullet under an `## After phase N` heading becomes one typed
//     decision object (type defaults to "convention", rationale notes the source).
//   • Every produced object is validated against the schema before it is written;
//     anything that can't be converted is REPORTED, never silently dropped.
//   • The original decisions.md is preserved as `decisions.md.bak` (so no operator
//     or agent history is destroyed, and the loader — which now reads only the
//     .jsonl — won't see a stale parallel source).
//   • A project that already has decisions.jsonl is skipped (no overwrite).
//
// Usage:
//   node src/migrate-decisions.js            # migrate all projects
//   (also runs as part of `npm run migrate-all`)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { DECISION_LIMITS, validateDecision } from './lib/decisions-schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

/**
 * Best-effort parse of a legacy decisions.md into schema-valid decision objects.
 * Headings of the form `## After phase N` (any level, "phase N" anywhere in the
 * heading) set the current phase label; `-`/`*` bullets become decisions. A bullet
 * shaped "label: detail" splits into title=label, decision=full bullet; otherwise
 * title is the bullet's leading slice. Returns { entries, skipped } where `skipped`
 * holds non-empty lines that were neither heading nor convertible bullet, so the
 * caller can report them.
 *
 * @param {string} md
 * @returns {{ entries: object[], skipped: string[] }}
 */
export function parseDecisionsMarkdown(md) {
  const entries = [];
  const skipped = [];
  if (!md || typeof md !== 'string') return { entries, skipped };

  let currentPhase = 'pre-jsonl';
  for (const rawLine of md.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;

    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      const text = heading[1].trim();
      const phaseMatch = text.match(/phase\s+(\d+)/i);
      currentPhase = String(phaseMatch ? phaseMatch[1] : text).slice(0, DECISION_LIMITS.phase) || 'pre-jsonl';
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      const body = bullet[1].trim();
      if (!body) continue;
      // A "label: detail" bullet splits into title=label, decision=detail (so the
      // rendered "- title: decision" reads cleanly, not "- label: label: detail").
      // Fall back to the full bullet when there is no usable split.
      const colon = body.indexOf(':');
      let title, decision;
      if (colon > 0 && colon <= DECISION_LIMITS.title) {
        title = body.slice(0, colon).trim();
        decision = body.slice(colon + 1).trim() || body;
      } else {
        title = body.slice(0, DECISION_LIMITS.title).trim();
        decision = body;
      }
      const entry = {
        phase: currentPhase,
        title: (title || body).slice(0, DECISION_LIMITS.title),
        decision: decision.slice(0, DECISION_LIMITS.decision),
        rationale: 'Migrated from free-form decisions.md (pre-schema rolling log).'.slice(0, DECISION_LIMITS.rationale),
        type: 'convention',
      };
      if (validateDecision(entry)) entries.push(entry);
      else skipped.push(line);
      continue;
    }

    // Non-empty line that is neither a heading nor a bullet (e.g. prose). It is
    // preserved verbatim in decisions.md.bak; record it so the run can report it.
    skipped.push(line);
  }

  return { entries, skipped };
}

/**
 * Migrate a single project directory. Returns a status object describing what
 * happened (no-source / already-migrated / migrated).
 */
export async function migrateProjectDecisions(projDir) {
  const guideDir = path.join(projDir, '.guide');
  const mdPath = path.join(guideDir, 'decisions.md');
  const jsonlPath = path.join(guideDir, 'decisions.jsonl');

  if (!(await exists(mdPath))) return { status: 'no-source' };
  if (await exists(jsonlPath)) return { status: 'already-migrated' };

  const md = await fs.readFile(mdPath, 'utf-8');
  const { entries, skipped } = parseDecisionsMarkdown(md);

  const lines = entries.map((e) => JSON.stringify(e));
  // Write the .jsonl even when empty — establishes the format and keeps the run
  // idempotent; the loader treats an empty file as "no decisions".
  await fs.writeFile(jsonlPath, lines.length ? lines.join('\n') + '\n' : '', 'utf-8');

  // Preserve the original. Renaming (rather than leaving it) means a re-run sees
  // no decisions.md and is a clean no-op, and the loader never reads stale data.
  await fs.rename(mdPath, path.join(guideDir, 'decisions.md.bak'));

  return { status: 'migrated', converted: entries.length, skipped };
}

export async function runMigrateDecisions({ projectsDir = PROJECTS_DIR } = {}) {
  console.log(chalk.bold('Decisions migration — decisions.md → decisions.jsonl (Phase 14)'));

  let names;
  try {
    names = (await fs.readdir(projectsDir)).filter((e) => !e.startsWith('.'));
  } catch {
    console.log(chalk.dim(`  (no projects dir at ${projectsDir} — nothing to migrate)`));
    return;
  }

  let migrated = 0;
  for (const name of names) {
    const projDir = path.join(projectsDir, name);
    try {
      const stat = await fs.stat(projDir);
      if (!stat.isDirectory()) continue;
      const res = await migrateProjectDecisions(projDir);
      if (res.status === 'migrated') {
        migrated += 1;
        console.log(chalk.green(
          `  ✓ ${name}: ${res.converted} decision(s) → decisions.jsonl (original kept as decisions.md.bak)`,
        ));
        if (res.skipped.length) {
          console.log(chalk.yellow(
            `    ⚠ ${res.skipped.length} line(s) not converted (preserved in decisions.md.bak):`,
          ));
          for (const s of res.skipped.slice(0, 5)) console.log(chalk.yellow(`      · ${s.slice(0, 100)}`));
          if (res.skipped.length > 5) console.log(chalk.yellow(`      · …and ${res.skipped.length - 5} more`));
        }
      } else if (res.status === 'already-migrated') {
        console.log(chalk.dim(`  ${name}: decisions.jsonl already exists, skipping`));
      }
      // 'no-source' → silent (most projects never had a decisions.md)
    } catch (err) {
      console.error(chalk.red(`  ${name}: ${err.message}`));
    }
  }

  console.log(chalk.green(`\n✓ Decisions migration complete (${migrated} project(s) migrated).`));
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runMigrateDecisions().catch((err) => {
    console.error(chalk.red(`\nmigrate-decisions failed: ${err.message}`));
    process.exit(1);
  });
}
