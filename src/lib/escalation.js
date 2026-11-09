// Escalation ladder (phase 23) — one tier-relative, bounded, billing-gated hop.
//
// Before this module there were THREE divergent marker writers (auto-runner's
// timeout branch + executeAction's dev/fix is_error branches) each hard-coding
// the file name `*-escalate-opus.marker` and a plain-text body. That baked in a
// single opus-only hop: an opus-baseline failure got a wasted identical opus
// retry, and the fable rung above opus was unreachable.
//
// The unified marker is `phase-N-escalate.marker` / `fix-rR-N-escalate.marker`
// carrying JSON `{ target_tier, failed_tier, reason, at }`. `target_tier` is the
// rung immediately above the tier that failed (TIER_ORDER), so a sonnet failure
// targets opus, an opus failure targets fable, and a fable failure targets
// NOTHING (no marker → routing falls through to pause).
//
// Read-side (runDev) checks the new marker FIRST; a legacy
// `*-escalate-opus.marker` still on disk from a run that started before this
// phase is honored as `{ target_tier: 'opus' }`, and a new-format file whose
// body doesn't parse as JSON also defaults to opus — back-compat is mandatory
// because a live project may carry an old-format marker mid-run.

import fs from 'node:fs/promises';
import path from 'node:path';
import { TIER_ORDER, tierIndex, modelToTier } from '../model-router.js';
import { isProviderRateLimitError, isTransientError } from './transient-errors.js';

/** Unified (phase-23) marker path for a phase or a fix. */
export function escalationMarkerPath(projDir, { fix = null, phaseN = null } = {}) {
  const name = fix
    ? `fix-r${fix.round}-${fix.n}-escalate.marker`
    : `phase-${phaseN}-escalate.marker`;
  return path.join(projDir, '.guide', name);
}

/** Legacy (pre-phase-23) marker path — read-only back-compat; never written. */
export function legacyEscalationMarkerPath(projDir, { fix = null, phaseN = null } = {}) {
  const name = fix
    ? `fix-r${fix.round}-${fix.n}-escalate-opus.marker`
    : `phase-${phaseN}-escalate-opus.marker`;
  return path.join(projDir, '.guide', name);
}

/**
 * Tier-relative step: the rung immediately above `failedTier`, or null when
 * `failedTier` is already the top rung (fable) or unrecognized — in both cases
 * there is nowhere to escalate, so no marker is written and routing falls
 * through to pause.
 */
export function nextTier(failedTier) {
  const idx = tierIndex(failedTier);
  if (idx < 0) return null;            // unknown tier — no escalation
  return TIER_ORDER[idx + 1] ?? null;  // top rung → null
}

/**
 * The ONE escalation-marker writer. Computes the tier-relative target from
 * `failedTier`; when the failed tier is already the top rung, writes NOTHING
 * and returns { written: false, targetTier: null }. Otherwise writes the
 * unified JSON marker `{ target_tier, failed_tier, reason, at }`.
 *
 * `at` is passed in (never sourced from `new Date()` here) so the body is a
 * pure function of its inputs and unit tests get a byte-stable artifact.
 *
 * @returns {Promise<{written:boolean, targetTier:string|null, path:string|null}>}
 */
export async function writeEscalationMarker({
  projDir, phaseN = null, fix = null, failedTier, reason = '', at = '', deps = {},
}) {
  const mkdirFn = deps.mkdir ?? fs.mkdir;
  const writeFileFn = deps.writeFile ?? fs.writeFile;
  // A bigger model cannot fix the weather: provider limits and network blips
  // carry zero capability signal, yet marker writers used to escalate on ANY
  // is_error result — escalated retries failed ~45% of the time, much of it
  // doomed second attempts at higher tiers during the same outage.
  if (isProviderRateLimitError(reason) || isTransientError(reason)) {
    return { written: false, targetTier: null, path: null, skipped: 'environmental' };
  }
  const targetTier = nextTier(failedTier);
  if (!targetTier) return { written: false, targetTier: null, path: null };
  const markerPath = escalationMarkerPath(projDir, { fix, phaseN });
  const body = JSON.stringify(
    { target_tier: targetTier, failed_tier: failedTier ?? null, reason: String(reason), at: String(at) },
    null, 2,
  );
  await mkdirFn(path.dirname(markerPath), { recursive: true });
  await writeFileFn(markerPath, body + '\n', 'utf-8');
  return { written: true, targetTier, path: markerPath };
}

/**
 * Pure: derive the target tier from a marker file body. The unified format is
 * JSON with a string `target_tier`; anything that doesn't parse as JSON with a
 * string target_tier defaults to 'opus' — matching how a legacy plain-text
 * `escalate-opus.marker` body was always treated.
 */
export function parseEscalationTarget(body) {
  try {
    const obj = JSON.parse(body);
    if (obj && typeof obj.target_tier === 'string') return obj.target_tier;
  } catch { /* not JSON — legacy/garbage body → opus */ }
  return 'opus';
}

/**
 * Read-side resolution for runDev(): the NEW marker name is checked FIRST; only
 * if it is absent do we fall back to the legacy `*-escalate-opus.marker`
 * (treated as target opus). Returns { targetTier, legacy, path }; targetTier is
 * null when neither marker exists.
 *
 * @returns {Promise<{targetTier:string|null, legacy:boolean, path:string|null}>}
 */
export async function resolveEscalation({ projDir, phaseN = null, fix = null, deps = {} }) {
  const readFileFn = deps.readFile ?? fs.readFile;
  const newPath = escalationMarkerPath(projDir, { fix, phaseN });
  try {
    const body = await readFileFn(newPath, 'utf-8');
    return { targetTier: parseEscalationTarget(body), legacy: false, path: newPath };
  } catch { /* new-format marker absent — try legacy */ }
  const legacyPath = legacyEscalationMarkerPath(projDir, { fix, phaseN });
  try {
    await readFileFn(legacyPath, 'utf-8');
    return { targetTier: 'opus', legacy: true, path: legacyPath };
  } catch { /* neither present */ }
  return { targetTier: null, legacy: false, path: null };
}

/**
 * Re-derive the failed tier for a result. Prefers the routing tier the runner
 * attached (`result.routing.tier`); when absent (a thrown error, e.g. a
 * timeout, never reached the routing-annotated return path) falls back to the
 * model-id heuristic over `cfg.model`.
 *
 * phase-25: an acceptance-gate refine (runAcceptanceGateLoop) may have already
 * escalated the model one or more tiers above the dev run before the phase
 * ultimately failed. The tiers it tried ride on `result.verify_outcome.refine_tiers`
 * — fold them into the max (by tierIndex) so the "failed tier" reflects the
 * HIGHEST rung actually burned, and the next escalation target lands ABOVE it
 * (a lower target would wastefully re-run a tier we already spent). Absent/empty
 * refine_tiers → identical to the pre-phase-25 behavior.
 */
export function failedTierFromResult(result, cfg) {
  const fromRouting = result?.routing?.tier;
  let best = (typeof fromRouting === 'string' && fromRouting)
    ? fromRouting
    : modelToTier(cfg?.model, cfg?.model_routing?.tier_models);
  const refineTiers = Array.isArray(result?.verify_outcome?.refine_tiers) ? result.verify_outcome.refine_tiers : [];
  for (const t of refineTiers) {
    if (typeof t === 'string' && tierIndex(t) > tierIndex(best)) best = t;
  }
  return best;
}
