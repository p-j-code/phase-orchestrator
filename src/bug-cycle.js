// Bug Cycle v0.3 — uses new bug-rounds/ layout.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import {
  getProject, setProjectStatus,
  startBugRound, setBugRoundFixPlan,
  listBugRounds, getBugRound,
} from './state.js';
import { runGuide } from './lib/phase-runner.js';
import { bugRoundDir, bugsFilePath, fixPlanJsonPath } from './lib/guide-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

async function readJson(p) { try { return JSON.parse(await fs.readFile(p, 'utf-8')); } catch { return null; } }
async function fileExists(p) { try { await fs.access(p); return true; } catch { return false; } }

// Find the lowest bug round that has a bugs.md on disk but is NOT yet completed
// in SQL. Processes rounds in ascending order so round-10 is fixed before round-11.
async function detectLowestUnprocessedBugRound(projDir, projectName) {
  const rounds = new Set();
  const bugRoundsDir = path.join(projDir, '.guide', 'bug-rounds');
  try {
    const entries = await fs.readdir(bugRoundsDir);
    for (const e of entries) {
      const m = e.match(/^round-(\d+)$/);
      if (m) rounds.add(parseInt(m[1], 10));
    }
  } catch { /* no bug-rounds dir yet */ }
  // Legacy: .guide/bugs-round-N.md files at the guide root
  const guideDir = path.join(projDir, '.guide');
  try {
    const entries = await fs.readdir(guideDir);
    for (const e of entries) {
      const m = e.match(/^bugs-round-(\d+)\.md$/);
      if (m) rounds.add(parseInt(m[1], 10));
    }
  } catch { /* ignore */ }

  const sorted = [...rounds].sort((a, b) => a - b);
  for (const n of sorted) {
    // Accept EITHER the new-layout bugs.md OR a legacy .guide/bugs-round-N.md —
    // a round discovered only via the legacy filename has no new-layout path yet,
    // and checking bugsFilePath() alone would skip it and make startBugCycle fail.
    const legacyPath = path.join(projDir, '.guide', `bugs-round-${n}.md`);
    if (!(await fileExists(bugsFilePath(projDir, n))) && !(await fileExists(legacyPath))) continue;
    const row = getBugRound(projectName, n);
    if (row && row.status === 'completed') continue;
    return n;
  }
  return null;
}

export async function startBugCycle({ projectName }) {
  const project = getProject(projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);

  const projDir = path.join(PROJECTS_DIR, projectName);
  const round = await detectLowestUnprocessedBugRound(projDir, projectName);
  if (!round) {
    throw new Error(
      `No bugs file found. Drop a markdown file at:\n  ${bugsFilePath(projDir, 1)}\nOr legacy:\n  ${path.join(projDir, '.guide', 'bugs-round-1.md')}`,
    );
  }

  // Ensure round folder exists
  await fs.mkdir(bugRoundDir(projDir, round), { recursive: true });

  // If user dropped legacy bugs-round-N.md at .guide/ root, copy to new location
  const legacyPath = path.join(projDir, '.guide', `bugs-round-${round}.md`);
  const newPath = bugsFilePath(projDir, round);
  if (await fileExists(legacyPath) && !(await fileExists(newPath))) {
    await fs.rename(legacyPath, newPath);
    console.log(chalk.dim(`Moved legacy bugs file to ${path.relative(projDir, newPath)}`));
  }

  console.log(chalk.cyan(`Starting bug round ${round}`));

  startBugRound({ project: projectName, round, bugs_file: newPath, total_fixes: 0 });
  // v0.14.8 / BUG-4: previously wrote a status value that wasn't in
  // project.schema.json's status enum. The "in-progress" enum value is the
  // correct semantic for a project mid-bug-round (not a distinct phase).
  setProjectStatus(projectName, 'in-progress');

  console.log(chalk.cyan('Generating fix plan...'));
  await runGuide({ projectName, task: 'bug-plan', round });

  const fixPlanPath = fixPlanJsonPath(projDir, round);
  const fixPlan = await readJson(fixPlanPath);
  if (!fixPlan || !Array.isArray(fixPlan.fixes)) {
    throw new Error(`Fix plan missing or malformed at ${fixPlanPath}`);
  }
  setBugRoundFixPlan({ project: projectName, round, fix_plan_file: fixPlanPath, total_fixes: fixPlan.fixes.length });

  console.log(chalk.green(`✓ Fix plan ready: ${fixPlan.fixes.length} fix(es) planned for round ${round}.`));
  console.log(chalk.dim('Run: npm run go -- ' + projectName + ' to start executing fixes.'));

  return { round, fixCount: fixPlan.fixes.length };
}

export function statusForProject(projectName) {
  const rounds = listBugRounds(projectName);
  return rounds.map((r) => ({
    round: r.round,
    status: r.status,
    fixes: `${r.fixes_completed}/${r.total_fixes}`,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  }));
}
