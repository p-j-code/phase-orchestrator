// LLM output contract (brief 08 / P1 — MI-11). Generalizes verify-loop's
// bespoke "tolerant-parse → validate → ONE session-resumed re-ask" ladder into
// a single reusable entrypoint, `runWithContract(opts)`, that later adoption
// sites (P1b bug-plan/project-context/lessons-distill/plan-creation, P4
// test-author manifest, P5 runtime-qa) and the P6 eval harness all build on.
//
// Two seams, because most adoption targets WRITE A FILE rather than reply with
// the artifact inline (the verdict-mandated correction):
//
//   1. REPLY seam — for write-blocked callers whose final REPLY TEXT *is* the
//      artifact (acceptance-check; P5 runtime-qa). `result.result` is run
//      through `tolerantJsonParse` and then a `schema` (AJV) or a `validate`
//      fn. Re-ask resumes the SAME session with the validation errors.
//
//   2. ARTIFACT seam — for callers who write a file the orchestrator later
//      reads (fix-plan.json, project-context.md, plan.json). `artifactReader`
//      runs AFTER the call and validates whatever landed on disk; on failure
//      the re-ask resumes the SAME session with the errors + the file path,
//      then re-reads.
//
// Common behavior: exactly ONE re-ask by default (`maxReasks`); an optional
// `escalateOnSecondFail` that re-runs ONCE on the next tier up — resolved via
// src/model-router.js's landed TIER_ORDER (never a hardcoded tier symbol) — so
// the escalated call records the REAL model it used in the calls table (runClaude
// reads cfg.model → recordCall). A spawn error at any step aborts immediately
// (never retried, never escalated) — only validation failures trigger a re-ask
// or an escalation, mirroring verify-loop's runCheckerCall ladder.
//
// Cache discipline (foundations cache-stable layout): the static instruction
// block a caller ships lives in `baseCall.systemPromptExtra` and stays
// byte-identical across every attempt here (this module never mutates it). The
// re-ask prompts below are per-call USER prompts (volatile — they interpolate
// the validation errors), so they carry no cache-stability constraint, exactly
// like verify-loop's own buildReaskPrompt.

import Ajv from 'ajv';
import { runClaude } from '../claude-runner.js';
import { TIER_ORDER, tierIndex, modelToTier } from '../model-router.js';

const ajv = new Ajv({ allErrors: true, strict: false });

// ─── Tolerant JSON parsing (moved here from verify-loop.js — P1) ─────────────
//
// Some replies may still arrive wrapped in a markdown fence or trailing prose
// despite the instruction not to — tolerate it the same way claude-runner's
// own stream-json parser tolerates stray text around the JSON object. This is
// the SINGLE definition; verify-loop.js imports it from here (parseVerdict /
// parsePrescanReply delegate to it) so the two can never drift.
export function tolerantJsonParse(text) {
  const trimmed = String(text ?? '').trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }

  const start = trimmed.indexOf('{');
  if (start < 0) throw new Error('no JSON object found in reply');
  // Brace-scan must skip string literals: a verdict whose `evidence` quotes a
  // code snippet with an unbalanced brace used to mis-slice here, throw, and
  // cost a paid re-ask.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(trimmed.slice(start, i + 1));
    }
  }
  throw new Error('unterminated JSON in reply');
}

// ─── Default re-ask prompt builders ──────────────────────────────────────────
//
// Pure functions of their inputs (no Date/randomness) — a caller may override
// either via opts.reaskPrompt when the wording needs to match a specific task.

function defaultReplyReaskPrompt(errors) {
  const errList = (errors || []).map((e) => `- ${e}`).join('\n') || '- (validation failed)';
  return `Your previous reply did not pass validation. Errors:
${errList}

Reply again with EXACTLY one JSON object matching the required schema — no markdown fence, no extra prose.`;
}

function defaultArtifactReaskPrompt(errors, filePath) {
  const errList = (errors || []).map((e) => `- ${e}`).join('\n') || '- (validation failed)';
  const where = filePath ? ` you wrote (${filePath})` : '';
  return `The file${where} did not pass validation. Errors:
${errList}

Rewrite the file so it satisfies the required structure, then confirm you are done. Change nothing else.`;
}

// ─── Deterministic markdown validators (P1b — cheap, no AJV) ─────────────────
//
// The haiku/sonnet-authored narrative artifacts (project-context.md,
// lessons-distilled.md) have no JSON schema — a structure check on them is a
// pure, deterministic scan of required headings + length bounds, NOT an LLM
// call and NOT AJV (the brief's explicit correction). Returns the same
// {ok:true,value}|{ok:false,errors} contract the artifact seam consumes, so a
// caller pairs it with a file read to build an `artifactReader`.
function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Build a deterministic markdown validator.
 *
 * @param {Object} [o]
 * @param {string[]} [o.requiredHeadings=[]] - phrases that must each appear on
 *   an ATX heading line (`#`..`######`), case-insensitively. When empty, the
 *   validator instead requires the doc to carry AT LEAST ONE heading (a totally
 *   heading-less markdown artifact is structurally broken).
 * @param {number} [o.minNonEmptyLines=1] - floor on non-blank lines (catches a
 *   stub of bare headings / an empty file).
 * @param {number} [o.maxLines=Infinity] - ceiling on total lines (catches a
 *   runaway artifact). Keep generous where a downstream capper exists.
 * @returns {(content:string)=>({ok:true,value:string}|{ok:false,errors:string[]})}
 */
export function markdownContractValidator({ requiredHeadings = [], minNonEmptyLines = 1, maxLines = Infinity } = {}) {
  return (content) => {
    const text = String(content ?? '');
    const lines = text.split('\n');
    const nonEmpty = lines.filter((l) => l.trim()).length;
    const headingCount = lines.filter((l) => /^#{1,6}\s+\S/.test(l)).length;
    const errors = [];
    for (const h of requiredHeadings) {
      const re = new RegExp(`^#{1,6}\\s+.*${escapeRegExp(h)}`, 'im');
      if (!re.test(text)) errors.push(`missing required heading: "${h}"`);
    }
    if (requiredHeadings.length === 0 && headingCount === 0) {
      errors.push('no markdown headings found — the artifact has no section structure');
    }
    if (nonEmpty < minNonEmptyLines) {
      errors.push(`too short: ${nonEmpty} non-empty line(s), need at least ${minNonEmptyLines}`);
    }
    if (lines.length > maxLines) {
      errors.push(`too long: ${lines.length} lines, exceeds the ${maxLines}-line bound`);
    }
    return errors.length ? { ok: false, errors } : { ok: true, value: text };
  };
}

// ─── Artifact contract over an ALREADY-MADE call (P1b adoption adapter) ───────
//
// Every P1b adoption site (bug-plan fix-plan.json, project-context.md,
// lessons-distilled.md, plan.json) validates a file the guide ALREADY wrote as
// part of a call the orchestrator dispatched moments earlier — the initial
// spawn is not ours to make; it already happened. This helper wires
// runWithContract's artifact seam onto that existing result: the "initial
// attempt" reuses `existingResult` (ZERO extra spawns, so a valid artifact
// costs nothing), and the ONE re-ask resumes that call's OWN session
// (existingResult.session_id) with the validation errors + file path — exactly
// the "session-resumed re-ask" the acceptance criteria require.
//
// escalateOnSecondFail is deliberately unavailable here: escalation re-runs the
// ORIGINAL prompt on a fresh session, but the artifact-writing context lives in
// the resumed session, not in a prompt we hold — so these sites always run
// fail-open (their callers log a warning and proceed).
//
// @param {Object} opts
// @param {Object} opts.existingResult - the result of the call that wrote the
//   artifact (must carry session_id for the re-ask to resume it).
// @param {Object} opts.baseCall - runClaude args for the re-ask (cfg/cwd/role/
//   project/task/systemPromptFile/systemPromptExtra); prompt+sessionId supplied
//   internally.
// @param {()=>Promise<{ok,value}|{ok:false,errors}>} opts.artifactReader
// @param {string|null} [opts.filePath]
// @param {number} [opts.maxReasks=1]
// @param {Function} [opts.runClaude] - injectable spawn seam (tests pass a fake).
// @returns {Promise<{ok,value?,errors?,result,reasks,escalated,spawnError?}>}
export async function runArtifactContractOnExistingCall(opts) {
  const {
    existingResult, baseCall, artifactReader, filePath = null, maxReasks = 1,
  } = opts || {};
  const runClaudeFn = opts?.runClaude ?? runClaude;

  let firstAttempt = true;
  const seam = async (callArgs) => {
    if (firstAttempt) {
      firstAttempt = false;
      return existingResult; // reuse the call that already wrote the artifact
    }
    return runClaudeFn(callArgs); // the re-ask: resume the same session
  };

  return runWithContract({
    baseCall,
    prompt: '(artifact already written by the preceding call)',
    sessionId: null,
    artifactReader,
    filePath,
    maxReasks,
    escalateOnSecondFail: false,
    runClaude: seam,
  });
}

// ─── Reply-seam validation ───────────────────────────────────────────────────
//
// Parse result.result via tolerantJsonParse, then apply the caller's seam:
// a `validate` fn (given the PARSED object) wins when supplied, else the
// AJV-compiled `schema`. Both return the verify-loop-style
// {ok:true,value}|{ok:false,errors} contract.
function validateReply(rawText, { validate, ajvValidateFn }) {
  let parsed;
  try {
    parsed = tolerantJsonParse(rawText);
  } catch (err) {
    return { ok: false, errors: [`invalid JSON: ${err.message}`] };
  }
  if (typeof validate === 'function') {
    return validate(parsed);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errors: ['reply is not a JSON object'] };
  }
  if (!ajvValidateFn(parsed)) {
    const errors = (ajvValidateFn.errors || []).map((e) => `${e.instancePath || '(root)'} ${e.message}`);
    return { ok: false, errors };
  }
  return { ok: true, value: parsed };
}

// ─── Tier escalation (via model-router's landed TIER_ORDER) ──────────────────
//
// Resolve the model ONE tier above the cfg's current model, using
// src/model-router.js's exported ladder — never a hardcoded tier symbol, so a
// future ladder change (the 'fable' rung was itself a late addition) needs no
// edit here. Returns { tier: null, model: undefined } when already at the top
// rung OR when tier_models has no entry for the next rung (a stripped/legacy
// cfg) — the caller then simply skips escalation and returns the failure,
// exactly as verify-loop's opus fallback fails open onto the resolved model.
function resolveNextTierModel(cfg) {
  const tierModels = cfg?.model_routing?.tier_models || {};
  const currentTier = modelToTier(cfg?.model, tierModels);
  const idx = tierIndex(currentTier);
  if (idx < 0 || idx >= TIER_ORDER.length - 1) return { tier: null, model: undefined };
  const nextTier = TIER_ORDER[idx + 1];
  return { tier: nextTier, model: tierModels[nextTier] };
}

/**
 * Run a Claude call under an output contract with a bounded re-ask ladder.
 *
 * @param {Object} opts
 * @param {Object} opts.baseCall - the runClaude args shared by every attempt
 *   (cfg, cwd, role, task, project, phase, systemPromptExtra, systemPromptFile,
 *   …) MINUS prompt/sessionId, which this function supplies per attempt. Its
 *   `cfg.model` is the model of the initial (and re-ask) calls, and the anchor
 *   escalation measures "one tier up" from.
 * @param {string} opts.prompt - the initial task prompt. Re-ask prompts are
 *   derived internally; an escalation re-runs this ORIGINAL prompt on a fresh
 *   session (mirrors verify-loop's opus fallback).
 * @param {string|null} [opts.sessionId] - initial session id (default null —
 *   a fresh session, the roleless-checker convention).
 *
 *   ── Reply seam (exactly one of schema | validate) ──
 * @param {Object} [opts.schema] - a JSON Schema; compiled with ajv here and
 *   applied to the tolerantJsonParse'd `result.result`.
 * @param {(parsed:any)=>({ok:true,value:any}|{ok:false,errors:string[]})} [opts.validate] -
 *   a validator given the PARSED reply object (wins over `schema` if both set).
 *
 *   ── Artifact seam ──
 * @param {()=>Promise<{ok:true,value:any}|{ok:false,errors:string[]}>} [opts.artifactReader] -
 *   reads + validates the artifact the call wrote to disk, AFTER the call. When
 *   present this is the artifact seam and `schema`/`validate` are ignored.
 * @param {string|null} [opts.filePath] - artifact path, named in the artifact
 *   re-ask prompt (informational only).
 *
 *   ── Common ──
 * @param {number} [opts.maxReasks=1] - re-ask budget; the re-ask count never
 *   exceeds this. (Escalation is a separate fresh call, not a re-ask.)
 * @param {boolean} [opts.escalateOnSecondFail=false] - after the re-ask budget
 *   is exhausted and still failing, re-run ONCE on the next tier up.
 * @param {(errors:string[], ctx:{filePath:string|null, seam:'reply'|'artifact'})=>string} [opts.reaskPrompt] -
 *   optional re-ask prompt override.
 * @param {Function} [opts.runClaude] - injectable spawn seam (tests pass a fake);
 *   defaults to the real runClaude.
 * @returns {Promise<{ok:boolean, value?:any, errors?:string[], result:object|null,
 *   usedModel:string|undefined, reasks:number, escalated:boolean, spawnError?:boolean}>}
 */
export async function runWithContract(opts) {
  const {
    baseCall,
    prompt,
    sessionId = null,
    schema,
    validate,
    artifactReader,
    filePath = null,
    maxReasks = 1,
    escalateOnSecondFail = false,
    reaskPrompt,
  } = opts || {};

  const runClaudeFn = opts?.runClaude ?? runClaude;
  const isArtifactSeam = typeof artifactReader === 'function';

  if (!isArtifactSeam && !schema && typeof validate !== 'function') {
    throw new TypeError('runWithContract: provide a reply seam (schema | validate) or an artifact seam (artifactReader)');
  }

  const cfg = baseCall?.cfg || {};
  const ajvValidateFn = (!isArtifactSeam && !validate && schema) ? ajv.compile(schema) : null;

  // Resolve the current attempt's outcome to the {ok,value}|{ok,errors} contract.
  const evaluate = async (result) => {
    if (isArtifactSeam) {
      try {
        return await artifactReader();
      } catch (err) {
        return { ok: false, errors: [`artifact read failed: ${err.message}`] };
      }
    }
    return validateReply(result?.result, { validate, ajvValidateFn });
  };

  const buildReask = (errors) => {
    if (typeof reaskPrompt === 'function') {
      return reaskPrompt(errors, { filePath, seam: isArtifactSeam ? 'artifact' : 'reply' });
    }
    return isArtifactSeam ? defaultArtifactReaskPrompt(errors, filePath) : defaultReplyReaskPrompt(errors);
  };

  let usedModel = cfg.model;

  // ── Initial attempt ──
  let result;
  try {
    result = await runClaudeFn({ ...baseCall, prompt, sessionId });
  } catch (err) {
    return { ok: false, errors: [err.message], spawnError: true, result: null, usedModel, reasks: 0, escalated: false };
  }

  let outcome = await evaluate(result);
  let reasks = 0;

  // ── Re-ask ladder (resume the SAME session, carry the exact errors) ──
  while (!outcome.ok && reasks < maxReasks) {
    reasks += 1;
    let reaskResult;
    try {
      reaskResult = await runClaudeFn({
        ...baseCall,
        prompt: buildReask(outcome.errors),
        sessionId: result?.session_id || null,
      });
    } catch (err) {
      return { ok: false, errors: [err.message], spawnError: true, result, usedModel, reasks, escalated: false };
    }
    result = reaskResult;
    outcome = await evaluate(result);
  }

  if (outcome.ok) {
    return { ok: true, value: outcome.value, result, usedModel, reasks, escalated: false };
  }

  // ── Escalation: exactly one fresh call, one tier up, ORIGINAL prompt ──
  if (escalateOnSecondFail) {
    const next = resolveNextTierModel(cfg);
    if (next.model) {
      let escResult;
      try {
        escResult = await runClaudeFn({
          ...baseCall,
          cfg: { ...cfg, model: next.model },
          prompt,
          sessionId: null,
        });
      } catch (err) {
        return { ok: false, errors: [err.message], spawnError: true, result, usedModel: next.model, reasks, escalated: true };
      }
      usedModel = next.model;
      result = escResult;
      outcome = await evaluate(result);
      return outcome.ok
        ? { ok: true, value: outcome.value, result, usedModel, reasks, escalated: true }
        : { ok: false, errors: outcome.errors, result, usedModel, reasks, escalated: true };
    }
  }

  return { ok: false, errors: outcome.errors, result, usedModel, reasks, escalated: false };
}
