// State Repair — detects and fixes DB/plan.json drift at server startup.
//
// Problems prevented:
//
//   1. total_phases out of sync — plan.json grows (new phases added) or
//      resetProjectForNewPlan stored the count instead of the last N.
//      Symptom: auto-runner exits early ("All N phases complete") when
//      current_phase == count but last phase N is higher.
//
//   2. status stuck at 'ready-for-qa' after plan extension — when phases
//      are added to an existing plan, the project keeps its old status and
//      the auto-runner refuses to run new phases.
//
//   3. current_phase ahead of plan — plan was shortened after some phases
//      ran. Logged as a warning; not auto-repaired (too risky).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { listProjects, getDb } from '../state.js';
import { planJsonPath } from './guide-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

export async function repairProjectStates({
  verbose = false,
  projectsDir = PROJECTS_DIR,
  readFile = fs.readFile,
} = {}) {
  const projects = listProjects();
  const repairs = [];
  const warnings = [];
  const db = getDb();

  for (const proj of projects) {
    let planPhases = null;
    try {
      const raw = await readFile(planJsonPath(path.join(projectsDir, proj.name)), 'utf-8');
      planPhases = JSON.parse(raw)?.phases || null;
    } catch { /* no plan.json yet — nothing to sync */ }

    if (!planPhases || planPhases.length === 0) continue;

    const lastPhaseN = planPhases[planPhases.length - 1].n;
    const completedPhase = proj.current_phase || 0;
    const changes = {};
    const notes = [];

    // Fix 1: total_phases should equal last phase's N value (not count).
    // Plans can start at n>1 (continuation plans), and count != max N.
    if (proj.total_phases !== lastPhaseN) {
      changes.total_phases = lastPhaseN;
      notes.push(`total_phases ${proj.total_phases} → ${lastPhaseN}`);
    }

    // Fix 2: status='ready-for-qa' but phases remain — plan was extended
    // after the previous plan completed, or the completion check fired early
    // due to the count-vs-lastN bug.
    // `paused` is now a legitimate durable waiting state (provider/window
    // reset, checkpoint, or operator gate). Do not make it look live at boot;
    // autoRun flips it to in-progress only when a resume is actually claimed.
    if (proj.status === 'ready-for-qa' && completedPhase < lastPhaseN) {
      changes.status = 'in-progress';
      notes.push(`status '${proj.status}' → 'in-progress' (phases ${completedPhase + 1}..${lastPhaseN} remain)`);
    }

    // Warn only: current_phase beyond the last phase in the plan.
    // Could mean phases were removed from the plan after running.
    if (completedPhase > lastPhaseN) {
      warnings.push(
        `${proj.name}: current_phase=${completedPhase} > plan's last phase n=${lastPhaseN} — ` +
        `plan may have been shortened. Verify plan.json and reset manually if needed.`,
      );
    }

    if (Object.keys(changes).length === 0) continue;

    const sets = Object.keys(changes).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE projects SET ${sets} WHERE name = ?`).run(...Object.values(changes), proj.name);
    repairs.push({ project: proj.name, notes });
  }

  if (repairs.length > 0) {
    console.log(chalk.cyan(`[state-repair] Repaired ${repairs.length} project(s):`));
    for (const r of repairs) {
      console.log(chalk.cyan(`  ${r.project}: ${r.notes.join(' · ')}`));
    }
  } else if (verbose) {
    console.log(chalk.dim('[state-repair] All projects consistent.'));
  }

  for (const w of warnings) {
    console.warn(chalk.yellow(`[state-repair] ⚠ ${w}`));
  }

  return { repairs, warnings };
}
