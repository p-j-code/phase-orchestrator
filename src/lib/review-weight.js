// Review weight (phase-35, review-cadence-yield-gating / QL-6) — classifies a
// review-eligible batch of completed phases into 'light' | 'full' | 'panel'
// from evidence the orchestrator already holds on disk/in the DB: per-phase
// verify verdicts, escalation/validation/reprompt markers, and the number of
// files changed since the previous review's boundary phase.
//
// This module NEVER decides whether to skip a review — auto-runner.js's
// needsReview gate still fires purely on the review FILE not existing. A
// 'light' classification only changes which prompt/model writes
// reviews/after-N.md (a cheap haiku one-shot instead of the full guide
// session) — see runGuide's light-review branch in src/lib/phase-runner.js.
// A 'panel' classification fans the batch out to three scoped review lenses
// instead — see the merge half of this module below, and runGuide's panel
// branch in src/lib/phase-runner.js for the spawn side.
//
// Pure and fail-safe: gating disabled, or any input missing/unreadable, falls
// back to 'full' — the unconditional pre-phase-35 behavior.

import fs from 'node:fs/promises';
import path from 'node:path';

function riskSets(cfg) {
  const cadence = cfg?.verify?.cadence || {};
  return {
    complexities: new Set(Array.isArray(cadence.always_complexities)
      ? cadence.always_complexities
      : ['high', 'critical']),
    checkpoints: new Set(Array.isArray(cadence.always_checkpoints)
      ? cadence.always_checkpoints
      : ['architecture', 'schema', 'external-integration', 'destructive']),
  };
}

/**
 * Schedule fewer but meaningful reviews: a periodic full backstop plus an
 * immediate review at explicit risk boundaries. Final review remains a
 * separate unconditional gate in auto-runner.
 */
export function shouldScheduleReview({ completedPhase, phaseMeta, reviewEveryN = 6, cfg } = {}) {
  if (!Number.isInteger(completedPhase) || completedPhase < 1) return { run: false, reason: 'no completed phase' };
  const interval = Number.isInteger(reviewEveryN) && reviewEveryN > 0 ? reviewEveryN : 6;
  const { complexities, checkpoints } = riskSets(cfg);
  const complexity = String(phaseMeta?.complexity || '').toLowerCase();
  const checkpoint = String(phaseMeta?.checkpoint || '').toLowerCase();
  if (complexities.has(complexity)) return { run: true, reason: `${complexity} complexity boundary` };
  if (checkpoints.has(checkpoint)) return { run: true, reason: `${checkpoint} checkpoint boundary` };
  if (completedPhase % interval === 0) return { run: true, reason: `periodic review every ${interval} phases` };
  return { run: false, reason: `routine phase between ${interval}-phase review checkpoints` };
}

/**
 * @param {Object} args
 * @param {Array<{n:number, verifyVerdict:'pass'|'fail'|'missing', escalated:boolean,
 *   validationFailed:boolean, reprompted:boolean, criteriaCount:number}>|null} args.batch
 *   One entry per phase in the review window (every plan phase after the
 *   previous review's last-covered phase, through the phase that triggered
 *   this review). null/non-array means the batch could not be computed.
 * @param {string[]|null} args.changedFiles - files changed since the PREVIOUS
 *   batch's last phase commit — the caller's already-unwrapped
 *   changedFilesSince(...).files, never the raw { ok, files } envelope. null
 *   means "unknown" (no baseline commit sha, or the git diff itself failed)
 *   and fail-safes to 'full'.
 * @param {Object|null} args.cfg - resolved config; reads cfg.review_gating.
 * @returns {{ mode: 'light'|'full'|'panel', signals: string[] }}
 */
export function computeReviewWeight({ batch, changedFiles, cfg }) {
  const signals = [];
  const gating = cfg?.review_gating;

  if (gating?.enabled === false) {
    signals.push("review_gating.enabled === false — always 'full'");
    return { mode: 'full', signals };
  }
  if (!Array.isArray(batch)) {
    signals.push('batch missing/unreadable — fail-safe to full');
    return { mode: 'full', signals };
  }
  if (!Array.isArray(changedFiles)) {
    signals.push('changedFiles unavailable (no baseline sha, or the git diff failed) — fail-safe to full');
    return { mode: 'full', signals };
  }

  const lightMax = gating?.light_max_changed_files ?? 25;
  const panelMin = gating?.panel_min_changed_files ?? 40;

  // A phase with an unknown/missing verify verdict is treated as an
  // UNREADABLE input (like a null changedFiles), not as a hard fail signal —
  // it fails safe to 'full' rather than escalating straight to 'panel', since
  // 'panel' is reserved for phases we can confidently say did NOT pass.
  let hasMissing = false;
  let hasFail = false;
  let hasMarker = false;
  let hasRiskBoundary = false;
  const { complexities: riskComplexities, checkpoints: riskCheckpoints } = riskSets(cfg);
  for (const p of batch) {
    if (!p || typeof p !== 'object' || p.verifyVerdict === 'missing') {
      hasMissing = true;
      continue;
    }
    if (p.verifyVerdict !== 'pass') hasFail = true;
    if (p.escalated || p.validationFailed || p.reprompted) hasMarker = true;
    if (riskComplexities.has(String(p.complexity || '').toLowerCase())
        || riskCheckpoints.has(String(p.checkpoint || '').toLowerCase())) hasRiskBoundary = true;
  }

  if (hasMissing) {
    signals.push('a phase in the batch has verifyVerdict: missing — fail-safe to full');
    return { mode: 'full', signals };
  }

  if (hasFail) signals.push('a phase in the batch has verifyVerdict !== pass');
  if (hasMarker) signals.push('a phase in the batch has an escalation/validation/reprompt marker');
  if (hasRiskBoundary) signals.push('a phase in the batch crosses a configured high-risk boundary');
  if (changedFiles.length >= panelMin) {
    signals.push(`changedFiles.length ${changedFiles.length} >= panel_min_changed_files ${panelMin}`);
  }

  // A panel is a costly three-call diagnostic. Reserve it for an explicitly
  // configured very-large-diff threshold. Failure/repair/risk signals need a
  // real full review, but do not by themselves justify two extra lenses.
  if (changedFiles.length >= panelMin) {
    return { mode: 'panel', signals };
  }

  if (hasFail || hasMarker || hasRiskBoundary) return { mode: 'full', signals };

  if (changedFiles.length <= lightMax) {
    signals.push(`all phases pass, zero markers, changedFiles.length ${changedFiles.length} <= light_max_changed_files ${lightMax}`);
    return { mode: 'light', signals };
  }

  signals.push(`changedFiles.length ${changedFiles.length} between light_max_changed_files (${lightMax}) and panel_min_changed_files (${panelMin}) — full`);
  return { mode: 'full', signals };
}

// ─── Panel review merge (Phase 36) ──────────────────────────────────────────
//
// A 'panel' classification fans a heavy batch out to THREE scoped review
// lenses instead of one generic pass: lens 1 is the guide's own resumed
// review (owns .guide/decisions.jsonl — the ONLY writer); lenses 2/3 are
// fresh, roleless, tool-scoped spawns (security/failure-modes, and
// consistency with brief conventions + decisions.jsonl) — see
// runGuide's panel branch in src/lib/phase-runner.js for the spawn side.
//
// This half is the deterministic (NO LLM) merge: read each lens's own
// verdict:/score: trailer, combine WORST-verdict/MIN-score (never let one
// good-looking lens paper over another lens's fail signal), and render the
// single reviews/after-N.md file tryReviewAutoProceed (src/auto-runner.js)
// already knows how to read identically regardless of which mode wrote it. A
// missing/unparseable lens fails safe to pause-and-fix/0 plus a visible
// warning line — never silently proceeds on incomplete evidence.

// Same anchored, case-insensitive parser tryReviewAutoProceed
// (src/auto-runner.js) uses for `score:` — global + last-match-wins, so the
// merged score means exactly what that function will later re-parse. `verdict:`
// has no existing machine consumer (tryReviewAutoProceed never parses it) —
// this merge is the first/only one, so its parser is introduced here.
const LENS_VERDICT_RE = /^verdict:\s*(continue|pause-and-fix|replan)\s*$/im;
const LENS_SCORE_RE = /^\s*score:\s*(\d+)\b/gim;

const VERDICT_RANK = { continue: 0, 'pause-and-fix': 1, replan: 2 };

function parseLensTrailer(content) {
  if (typeof content !== 'string' || !content.trim()) return null;
  const verdictMatch = content.match(LENS_VERDICT_RE);
  const scoreMatches = [...content.matchAll(LENS_SCORE_RE)];
  if (!verdictMatch || !scoreMatches.length) return null;
  return {
    verdict: verdictMatch[1].toLowerCase(),
    score: parseInt(scoreMatches[scoreMatches.length - 1][1], 10),
  };
}

function isLensTrailerLine(line) {
  return /^verdict:\s*(continue|pause-and-fix|replan)\s*$/i.test(line)
    || /^\s*score:\s*\d+\b/i.test(line);
}

// Strips the trailer line(s) so the merged file carries exactly ONE
// verdict/score pair (the merged one), not one per lens — everything else in
// a lens's body, including any BLOCKER: line, survives verbatim so it still
// suppresses tryReviewAutoProceed after concatenation.
function stripLensTrailer(content) {
  return content
    .split('\n')
    .filter((line) => !isLensTrailerLine(line))
    .join('\n')
    .trim();
}

/**
 * Deterministic (no LLM) merge of a panel review's three lens outputs.
 *
 * @param {Array<{name: string, content: string|null}>} lensResults - one entry
 *   per lens, in display order (lens 1 first). `content` is the raw file text
 *   read from disk, or null/absent when the lens file is missing/unreadable.
 * @returns {{ verdict: 'continue'|'pause-and-fix'|'replan', score: number,
 *   warnings: string[], body: string }}
 */
export function mergeLensReviews(lensResults) {
  const warnings = [];
  const lenses = (lensResults || []).map((lens, i) => {
    const name = lens?.name || `lens ${i + 1}`;
    const parsed = parseLensTrailer(lens?.content);
    if (!parsed) {
      warnings.push(`WARNING: ${name} review is missing or its verdict/score trailer could not be parsed — treated as pause-and-fix/0 (fail-safe).`);
      return {
        name,
        verdict: 'pause-and-fix',
        score: 0,
        body: lens?.content ? stripLensTrailer(lens.content) : '(no content — lens spawn failed or produced no file)',
      };
    }
    return { name, verdict: parsed.verdict, score: parsed.score, body: stripLensTrailer(lens.content) };
  });

  const verdict = lenses.reduce((worst, l) => (VERDICT_RANK[l.verdict] > VERDICT_RANK[worst] ? l.verdict : worst), 'continue');
  const score = lenses.length ? Math.min(...lenses.map((l) => l.score)) : 0;

  const sections = lenses.map((l, i) => `## Lens ${i + 1} — ${l.name}\n\n${l.body}`);
  const warningBlock = warnings.length ? `${warnings.join('\n')}\n\n` : '';
  const body = `${warningBlock}${sections.join('\n\n')}\n\nverdict: ${verdict}\nscore: ${score}\n`;

  return { verdict, score, warnings, body };
}

/**
 * Persists mergeLensReviews()'s output. The caller passes the SAME
 * reviewPath(projDir, N) a full/light review would write to, so
 * tryReviewAutoProceed reads it identically regardless of which review mode
 * produced it.
 */
export async function writeMergedLensReview(reviewOutPath, merged) {
  await fs.mkdir(path.dirname(reviewOutPath), { recursive: true });
  await fs.writeFile(reviewOutPath, merged.body, 'utf-8');
  return reviewOutPath;
}
