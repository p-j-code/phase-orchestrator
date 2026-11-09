// suggestion-slot.js — shared helper for go/resume slot resolution + multi-pass progression.
//
// Extracted from the duplicated cursor-read/advance blocks that existed in both
// the `go` and `resume` orchestrator actions. Single source of truth for:
//   1. Reading the next_pass cursor from the accepted suggestions row.
//   2. Detecting when a pass is fully done (status='ready-for-qa'|'completed') and
//      returning a `pendingAdvance` descriptor so the caller can commit the advance
//      AFTER any abort gates (suggest gate, cost-prediction confirm).
//   3. commitAdvance() — performs the three side effects: log, archive plan files,
//      persist cursor. Called by the orchestrator ONLY after both gates pass.
//   4. Resolving effectiveSlot (lowest non-empty pass when requestedSlot is empty).

import path from 'node:path';
import fs from 'node:fs/promises';
import chalk from 'chalk';
import { getProject as _getProject, getLatestSuggestions as _gls, setSuggestionNextPass as _ssnp } from '../state.js';
import { nextNonEmptyPass as _nep, resolveInjectionSlot as _ris } from './suggestion-engine.js';
import { planJsonPath as _pjp, planMdPath as _pmp } from './guide-paths.js';

/**
 * Resolve the suggestion slot for a `go` or `resume` run.
 *
 * PURE — makes no filesystem writes and no DB writes.
 * When an advance is warranted it returns a non-null `pendingAdvance` descriptor;
 * the caller must pass that to `commitAdvance` AFTER all abort gates have been
 * cleared (suggest gate + cost-prediction confirm).
 *
 * @param {string} projectName
 * @param {string} projDir        - absolute project directory
 * @param {{ slotExplicit: boolean, slotParsed: number|null, advance?: boolean }} options
 * @param {object} [deps]         - injectable overrides (for testing)
 * @returns {Promise<{ requestedSlot: number, effectiveSlot: number, pendingAdvance: object|null }>}
 */
export async function resolveSuggestionSlot(projectName, projDir, { slotExplicit, slotParsed, advance = false }, deps = {}) {
  const getLatestSuggestions  = deps.getLatestSuggestions  ?? _gls;
  const getProject             = deps.getProject             ?? _getProject;
  const nextNonEmptyPass       = deps.nextNonEmptyPass       ?? _nep;
  const resolveInjectionSlot   = deps.resolveInjectionSlot   ?? _ris;
  const planJsonPath           = deps.planJsonPath           ?? _pjp;
  const _chalk                 = deps.chalk                  ?? chalk;

  const accepted = getLatestSuggestions(projectName);
  let requestedSlot = 1; // fallback when no accepted plan
  let pendingAdvance = null;

  if (slotExplicit) {
    requestedSlot = slotParsed;
  } else if (accepted?.status === 'accepted') {
    const passes = accepted.pipeline_passes;
    const plan   = JSON.parse(accepted.pipeline_plan_json || '{}');
    let cursor   = accepted.next_pass ?? 1;

    if (passes > 1) {
      const proj = getProject(projectName);
      // Gate on actual pipeline status, not raw phase counts, to avoid advancing
      // during the brief window between last-phase-done and final-review-done.
      const fullyDone = proj?.status === 'ready-for-qa' || proj?.status === 'completed';
      if (fullyDone && advance) {
        const next = nextNonEmptyPass(plan, cursor, passes);
        if (next !== null && next !== cursor) {
          const guideDir = path.dirname(planJsonPath(projDir));
          // Return the descriptor; caller commits after all abort gates clear.
          pendingAdvance = { cursor, next, guideDir };
          cursor = next;
        }
      }
    }
    requestedSlot = cursor;
  }

  // Slot resolution — if requestedSlot has no items, fall back to the lowest non-empty pass.
  let effectiveSlot = requestedSlot;
  if (accepted?.status === 'accepted' && accepted.pipeline_passes) {
    const passes = accepted.pipeline_passes;
    if (!Number.isInteger(requestedSlot) || requestedSlot < 1 || requestedSlot > passes) {
      console.log(_chalk.yellow(
        `  ⚠ --slot ${requestedSlot} is out of range for the accepted suggestions plan (valid: 1–${passes}).\n` +
        `    The guide will run without a suggestions block for this slot.`
      ));
    } else {
      const plan = JSON.parse(accepted.pipeline_plan_json || '{}');
      effectiveSlot = resolveInjectionSlot(plan, requestedSlot, passes);
      if (effectiveSlot !== requestedSlot) {
        console.log(_chalk.dim(
          `  → Pass ${requestedSlot} has no items; running with Pass ${effectiveSlot} instead.\n` +
          `    To target a specific pass explicitly: npm run go -- ${projectName} --slot ${effectiveSlot}`
        ));
      }
    }
  }

  return { requestedSlot, effectiveSlot, pendingAdvance };
}

/**
 * Commit a pending multi-pass advance: log, archive plan files, persist cursor.
 *
 * Must only be called after all interactive abort gates (suggest gate +
 * cost-prediction confirm) have been cleared. The unattended path
 * (resolveAutoRunSlot) calls this immediately after resolveSuggestionSlot.
 *
 * @param {string} projectName
 * @param {{ cursor: number, next: number, guideDir: string }} pendingAdvance
 * @param {object} [deps] - injectable overrides (fs, chalk, setSuggestionNextPass)
 */
export async function commitAdvance(projectName, pendingAdvance, deps = {}) {
  const setSuggestionNextPass = deps.setSuggestionNextPass ?? _ssnp;
  const _fs                   = deps.fs                    ?? fs;
  const _chalk                = deps.chalk                 ?? chalk;

  const { cursor, next, guideDir } = pendingAdvance;

  // Print before touching the filesystem so the operator sees context for what
  // is about to happen, not after the fact.
  console.log(_chalk.dim(`  → Pass ${cursor} complete. Generating a Pass ${next} plan on this run.`));

  const isoStamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const [base, ext] of [['plan', 'json'], ['plan', 'md']]) {
    const src = path.join(guideDir, `${base}.${ext}`);
    const dst = path.join(guideDir, `${base}-archived-${isoStamp}.${ext}`);
    try { await _fs.copyFile(src, dst); } catch { /* not present — skip */ }
    try { await _fs.unlink(src); } catch { /* already gone — skip */ }
  }
  // Persist cursor only after archive succeeds so the DB reflects the pass
  // that is actually about to be built, not a phantom future pass.
  setSuggestionNextPass(projectName, next);
}
