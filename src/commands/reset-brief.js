// reset-brief — copy inputs/brief.md → .guide/brief.md, archive the old brief
// and plan, reset the phase counter, and (optionally) restart the pipeline.
//
// Use this when the operator drops a fresh brief into inputs/ and wants the
// guide to re-plan from scratch. Unlike resetProjectForNewPlan, this does NOT
// delete the phases table — it only rewinds current_phase to 0 and archives
// the stale plan so the guide replans.
//
// Guard failures THROW (rather than process.exit) so the function is safe to
// call from three contexts: the CLI action wrapper (catches → exit 1), the
// Telegram /run job-runner dispatch (catches → markJobFailed, never kills the
// server), and node:test (which cannot intercept process.exit).

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';

import { getProject, setCurrentPhase, staleAllSuggestions } from '../state.js';
import { briefPath, planJsonPath, planMdPath, guideRoot, suggestionsPath } from '../lib/guide-paths.js';
import { autoRun } from '../auto-runner.js';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = path.resolve(__dirname, '../../projects');

export async function resetBrief(projectName, opts = {}) {
  // opts: { go?: boolean, noArchive?: boolean, projectsDir?: string }
  // projectsDir overrides the default projects/ root — injected by tests so the
  // command can run against a tmpdir instead of the real projects tree.

  // 1. Resolve project
  const project = getProject(projectName);
  if (!project) {
    throw new Error(`project "${projectName}" not found. Run: ashmero list`);
  }
  const projDir = path.join(opts.projectsDir || PROJECTS_DIR, projectName);

  // 2. Read inputs/brief.md
  const inputsBriefPath = path.join(projDir, 'inputs', 'brief.md');
  let inputsContent;
  try {
    inputsContent = await fs.readFile(inputsBriefPath, 'utf-8');
  } catch {
    throw new Error(`inputs/brief.md not found for "${projectName}". Drop your brief at: ${inputsBriefPath}`);
  }
  if (!inputsContent.trim()) {
    throw new Error(`inputs/brief.md is empty for "${projectName}".`);
  }

  // 3. Unresolved-input guard (same pattern as auto-runner G4)
  const unresolved = (inputsContent.match(/\[NEEDS USER INPUT[^\]]*\]/g) || []);
  if (unresolved.length > 0) {
    throw new Error(
      `inputs/brief.md has ${unresolved.length} unresolved marker(s): ${unresolved.join(', ')}. `
      + 'Answer the open questions, then retry.',
    );
  }

  // 4. In-progress guard
  if (project.status === 'in-progress') {
    throw new Error(`pipeline is currently running for "${projectName}". Abort it first: ashmero abort ${projectName}`);
  }

  // 4b. --no-archive + --go conflict guard: if a stale plan exists and we have no backup,
  //     autoRun would silently build the old plan against the new brief. Refuse early.
  if (opts.noArchive && opts.go) {
    const planFiles = [planJsonPath(projDir), planMdPath(projDir)];
    const staleExisting = [];
    for (const p of planFiles) {
      try { await fs.access(p); staleExisting.push(path.relative(projDir, p)); } catch { /* absent */ }
    }
    if (staleExisting.length > 0) {
      throw new Error(
        `--no-archive + --go refused: stale plan file(s) found (${staleExisting.join(', ')}).\n`
        + `  Remedy 1: re-run without --no-archive (archives and deletes the plan so the guide replans).\n`
        + `  Remedy 2: delete the stale plan manually, then re-run.`,
      );
    }
  }

  // 5. Archive existing .guide/brief.md and plan files (unless --no-archive)
  const isoStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const guideDir = guideRoot(projDir);
  const archivePaths = [];

  const filesToArchive = [
    { src: briefPath(projDir),       dst: path.join(guideDir, `brief-archived-${isoStamp}.md`) },
    { src: planJsonPath(projDir),    dst: path.join(guideDir, `plan-archived-${isoStamp}.json`) },
    { src: planMdPath(projDir),      dst: path.join(guideDir, `plan-archived-${isoStamp}.md`) },
    { src: suggestionsPath(projDir), dst: path.join(guideDir, `suggestions-archived-${isoStamp}.md`) },
  ];

  if (!opts.noArchive) {
    for (const { src, dst } of filesToArchive) {
      try {
        await fs.copyFile(src, dst);
        archivePaths.push({ src, dst });
      } catch {
        // File doesn't exist — skip silently
      }
    }
  }

  // 6. Copy inputs/brief.md → .guide/brief.md (overwrite)
  const destBriefPath = briefPath(projDir);
  await fs.mkdir(guideDir, { recursive: true });
  await fs.writeFile(destBriefPath, inputsContent, 'utf-8');

  // Delete plan.json/plan.md so the guide re-plans from scratch.
  // Skip when --no-archive: no backup exists, so deletion is unrecoverable.
  // Warn the operator instead so they know stale plan files remain.
  if (!opts.noArchive) {
    for (const { src } of filesToArchive) {
      if (src === planJsonPath(projDir) || src === planMdPath(projDir)
          || src === suggestionsPath(projDir)) {
        try { await fs.unlink(src); } catch { /* already gone */ }
      }
    }
  } else {
    // Check which stale files still exist and warn about each one.
    const planFiles = [planJsonPath(projDir), planMdPath(projDir), suggestionsPath(projDir)];
    const staleFiles = [];
    for (const p of planFiles) {
      try { await fs.access(p); staleFiles.push(path.relative(projDir, p)); } catch { /* absent */ }
    }
    if (staleFiles.length > 0) {
      console.log(chalk.yellow(
        `  ⚠ --no-archive: stale file(s) left in place — delete manually or re-run without --no-archive:\n` +
        staleFiles.map(f => `    ${f}`).join('\n'),
      ));
    }
  }

  // 7. Reset current_phase to 0 in DB
  //    (project.status is NOT 'in-progress' — verified above)
  setCurrentPhase(projectName, 0);

  // 8. Stale all suggestions (table may not exist on older installs)
  try {
    staleAllSuggestions(projectName);
  } catch { /* suggestions table absent — skip */ }

  // 9. Print confirmation
  console.log(chalk.green(`✓ Brief reset for ${projectName}`));
  if (archivePaths.length > 0) {
    archivePaths.forEach(({ dst }) => {
      const rel = path.relative(projDir, dst);
      console.log(chalk.dim(`  Archived → ${rel}`));
    });
  }
  console.log(chalk.dim(`  current_phase reset to 0`));

  // 10. Optionally start pipeline (opts.autoRun overridable for tests)
  if (opts.go) {
    console.log(chalk.dim(`  Starting pipeline (unattended)…`));
    const runAuto = opts.autoRun || autoRun;
    const runResult = await runAuto({ projectName, unattended: true });
    if (runResult?.status === 'failed') {
      throw new Error(`pipeline failed for "${projectName}": ${runResult.reason}`);
    }
  }

  return { archived: archivePaths.map(({ dst }) => dst), briefPath: destBriefPath };
}
