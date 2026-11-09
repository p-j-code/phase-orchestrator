#!/usr/bin/env node
// Recover projects — sync projects/<name>/project.json files into SQLite.
// Run after restoring projects/ from a backup or recovery zip.
// Safe to run multiple times (upsert-based).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertProject, upsertPhase, setCurrentPhase, setProjectStatus } from './src/state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = path.join(__dirname, 'projects');

async function main() {
  let entries;
  try { entries = await fs.readdir(PROJECTS_DIR); }
  catch (err) { console.error(`Cannot read ${PROJECTS_DIR}: ${err.message}`); process.exit(1); }

  let recovered = 0;
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const projDir = path.join(PROJECTS_DIR, entry);
    let projectData;
    try { projectData = JSON.parse(await fs.readFile(path.join(projDir, 'project.json'), 'utf-8')); }
    catch { console.log(`  - skip ${entry} (no project.json)`); continue; }

    upsertProject({
      name: projectData.name,
      tech_stack: projectData.tech_stack,
      profile: projectData.profile,
      total_phases: projectData.total_phases || 0,
      status: projectData.status || 'planning',
      metadata: projectData.metadata || {},
    });
    setCurrentPhase(projectData.name, projectData.current_phase || 0);
    if (projectData.status) setProjectStatus(projectData.name, projectData.status);

    // Try v2 layout first (.guide/plan.json), fall back to legacy
    let plan = null;
    try { plan = JSON.parse(await fs.readFile(path.join(projDir, '.guide', 'plan.json'), 'utf-8')); }
    catch { /* no plan yet */ }

    if (plan?.phases) {
      for (const ph of plan.phases) {
        upsertPhase({ project: projectData.name, n: ph.n, title: ph.title, status: ph.status || 'pending' });
      }
      console.log(`  ✓ ${entry} — ${plan.phases.length} phases (current=${projectData.current_phase || 0})`);
    } else {
      console.log(`  ✓ ${entry} — synced (no plan yet)`);
    }
    recovered += 1;
  }

  console.log(`\nRecovered ${recovered} project(s). Run: npm run status to verify.`);
}

main().catch((err) => { console.error('Recovery failed:', err.message); process.exit(1); });
