// Runtime rollout controller for the Hybrid Context Compiler.
// Explicit config (`rollout.auto_promote`) authorizes shadow→assist application;
// enforce is never entered automatically. Rollback is fail-safe and auditable.

import { createHash } from 'node:crypto';
import {
  contextCompilerRolloutWindow,
  getContextCompilerRollout,
  saveContextCompilerRollout,
} from '../state.js';
import {
  createContextCompilerRolloutStage,
  evaluateContextCompilerRollout,
  resolveContextCompilerRolloutPolicy,
} from './context-compiler-policy.js';
import { contextCompilerConfigFingerprint } from './context-compiler.js';

function transitionStageId({ project, recommendation, fromMode, toMode, at, compilerFingerprint }) {
  return createHash('sha256').update(JSON.stringify({
    project, recommendation, from_mode: fromMode, to_mode: toMode, at,
    compiler_fingerprint: compilerFingerprint,
  })).digest('hex');
}

function configWithEffectiveMode(configuredCfg, configuredMode, effectiveMode) {
  return effectiveMode === configuredMode
    ? configuredCfg
    : {
        ...configuredCfg,
        context_compiler: {
          ...configuredCfg.context_compiler,
          mode: effectiveMode,
          _configured_mode: configuredMode,
        },
      };
}

export function resolveEffectiveContextCompilerMode({ projectName, cfg }, deps = {}) {
  const compiler = cfg?.context_compiler || {};
  const configuredMode = ['shadow', 'assist', 'enforce'].includes(compiler.mode) ? compiler.mode : 'shadow';
  const configuredCfg = compiler.mode === configuredMode
    ? cfg
    : { ...cfg, context_compiler: { ...compiler, mode: configuredMode } };
  const rollout = compiler.rollout || {};
  const compilerFingerprint = contextCompilerConfigFingerprint(compiler);
  const getState = deps.getState ?? getContextCompilerRollout;
  const getWindow = deps.getWindow ?? contextCompilerRolloutWindow;
  const saveState = deps.saveState ?? saveContextCompilerRollout;
  if (compiler.enabled !== true || rollout.enabled === false) {
    // A kill switch is also a rollout-evidence boundary. Persist the reset and
    // its timestamp so re-enabling the same compiler fingerprint cannot reuse
    // pre-disable shadow samples and silently resurrect a stale assist overlay.
    // This is best-effort: compiler/rollout disablement itself must work even
    // when telemetry is unavailable.
    const disabledAt = new Date().toISOString();
    let previousMode = configuredMode;
    let disabledState = null;
    try {
      disabledState = getState(projectName);
      previousMode = disabledState?.effective_mode || configuredMode;
    } catch { /* fail safe */ }
    // Write-once: without this guard every phase run of a compiler-disabled
    // project rewrites the row, and the persisted "disabled at" timestamp
    // always equals the latest run instead of when disablement happened.
    const alreadyDisabled = disabledState?.recommendation === 'disabled'
      && disabledState?.configured_mode === configuredMode
      && disabledState?.effective_mode === configuredMode;
    if (alreadyDisabled) {
      return {
        cfg: configuredCfg,
        configured_mode: configuredMode,
        effective_mode: configuredMode,
        recommendation: 'disabled',
        changed: false,
      };
    }
    try {
      const changed = previousMode !== configuredMode;
      saveState({
        project: projectName,
        configured_mode: configuredMode,
        effective_mode: configuredMode,
        recommendation: 'disabled',
        stage_id: changed ? transitionStageId({
          project: projectName,
          recommendation: 'disabled',
          fromMode: previousMode,
          toMode: configuredMode,
          at: disabledAt,
          compilerFingerprint,
        }) : null,
        evidence: {
          compiler_fingerprint: compilerFingerprint,
          metrics: null,
          blockers: [],
          thresholds: null,
          transition: {
            recommendation: 'disabled',
            from_mode: previousMode,
            to_mode: configuredMode,
            at: disabledAt,
          },
        },
      });
    } catch { /* a kill switch never depends on telemetry persistence */ }
    return {
      cfg: configuredCfg,
      configured_mode: configuredMode,
      effective_mode: configuredMode,
      recommendation: 'disabled',
      changed: previousMode !== configuredMode,
    };
  }
  let existing;
  try {
    existing = getState(projectName);
  } catch (err) {
    return {
      cfg: configuredCfg, configured_mode: configuredMode, effective_mode: configuredMode,
      recommendation: 'telemetry-unavailable', changed: false, error: err.message,
    };
  }
  let priorEvidence = null;
  try {
    priorEvidence = typeof existing?.evidence_json === 'string'
      ? JSON.parse(existing.evidence_json)
      : existing?.evidence_json || null;
  } catch { priorEvidence = null; }
  const evidenceMatches = existing?.configured_mode === configuredMode
    && priorEvidence?.compiler_fingerprint === compilerFingerprint;
  let currentMode = evidenceMatches ? existing.effective_mode : configuredMode;
  if (!['shadow', 'assist', 'enforce'].includes(currentMode)) currentMode = configuredMode;

  // Turning automatic behavior off is an explicit request to return to the
  // configured mode rather than leaving a previous dynamic overlay latched.
  if ((configuredMode === 'shadow' && rollout.auto_promote !== true)
      || (['assist', 'enforce'].includes(configuredMode) && rollout.auto_rollback === false)) {
    const alreadyBounded = evidenceMatches
      && existing?.recommendation === 'automation-disabled'
      && priorEvidence?.transition?.recommendation === 'automation-disabled';
    if (!alreadyBounded) {
      const disabledAt = new Date().toISOString();
      const changed = currentMode !== configuredMode;
      try {
        saveState({
          project: projectName,
          configured_mode: configuredMode,
          effective_mode: configuredMode,
          recommendation: 'automation-disabled',
          stage_id: changed ? transitionStageId({
            project: projectName,
            recommendation: 'automation-disabled',
            fromMode: currentMode,
            toMode: configuredMode,
            at: disabledAt,
            compilerFingerprint,
          }) : null,
          evidence: {
            compiler_fingerprint: compilerFingerprint,
            metrics: null,
            blockers: [],
            thresholds: null,
            transition: {
              recommendation: 'automation-disabled',
              from_mode: currentMode,
              to_mode: configuredMode,
              at: disabledAt,
            },
          },
        });
      } catch { /* rollout telemetry must never block phase execution */ }
    }
    return { cfg: configuredCfg, configured_mode: configuredMode, effective_mode: configuredMode, recommendation: 'automation-disabled', changed: currentMode !== configuredMode };
  }

  const policy = resolveContextCompilerRolloutPolicy(rollout);
  let rows;
  try {
    rows = getWindow(projectName, policy.window_size);
  } catch (err) {
    // `currentMode` may be a persisted shadow rollback beneath an explicitly
    // configured assist/enforce mode. Losing the telemetry window must not
    // undo that safe-mode latch for this invocation.
    return {
      cfg: configWithEffectiveMode(configuredCfg, configuredMode, currentMode),
      configured_mode: configuredMode,
      effective_mode: currentMode,
      recommendation: 'telemetry-unavailable',
      changed: false,
      error: err.message,
    };
  }
  const rawRows = Array.isArray(rows) ? rows : [];
  const failureTelemetryComplete = rawRows.length > 0
    && !rawRows.some((row) => row.status === 'untracked-artifact'
      || (row.status === 'compiled' && row.artifact_found !== 1 && row.artifact_found !== true));
  rows = rawRows.filter((row) => row.compiler_fingerprint === compilerFingerprint);
  const priorTransition = evidenceMatches ? priorEvidence?.transition || null : null;
  // After an automatic transition, evaluate the new mode only on evidence
  // collected after that transition. In particular, an assist→shadow rollback
  // must not immediately re-promote from the same old healthy shadow rows.
  if (priorTransition?.to_mode === currentMode && Date.parse(priorTransition.at)) {
    const transitionMs = Date.parse(priorTransition.at);
    rows = (Array.isArray(rows) ? rows : []).filter((row) => Date.parse(row.generated_at) >= transitionMs);
  }
  const decision = evaluateContextCompilerRollout({
    manifests: rows,
    currentMode,
    provider: compiler.provider || null,
    policy,
    // The event window is an exhaustive attempt log from the runtime wrapper;
    // an empty window cannot promote because the sample gates still fail.
    failureTelemetryComplete: failureTelemetryComplete && rows.length > 0,
    // A mode above configured shadow is a dynamic, auto-promoted overlay. It
    // may remain active only while failure-attempt evidence stays complete.
    autoPromoted: evidenceMatches && configuredMode === 'shadow' && currentMode !== 'shadow',
  });

  let effectiveMode = currentMode;
  let stage = null;
  if (decision.recommendation === 'promote-to-assist' && rollout.auto_promote === true) {
    effectiveMode = 'assist';
    stage = createContextCompilerRolloutStage(decision, { project: projectName });
  } else if (decision.recommendation === 'rollback-to-shadow'
             && (rollout.auto_rollback !== false || (configuredMode === 'shadow' && currentMode !== 'shadow'))) {
    // Fail-safe: a rollback of an AUTO-PROMOTED overlay (configured shadow, but
    // dynamically elevated) always applies — auto_rollback:false is meant only to
    // suppress rollback of a MANUALLY-configured assist/enforce mode (already
    // short-circuited earlier). Otherwise a degraded overlay would stick forever.
    effectiveMode = 'shadow';
    stage = createContextCompilerRolloutStage(decision, { project: projectName });
  }

  const transition = stage ? {
    recommendation: stage.recommendation,
    from_mode: stage.from_mode,
    to_mode: stage.to_mode,
    at: new Date().toISOString(),
  } : priorTransition;
  try {
    saveState({
      project: projectName,
      configured_mode: configuredMode,
      effective_mode: effectiveMode,
      recommendation: decision.recommendation,
      // A stage id belongs to the evidence/config cohort that created it. Do
      // not carry an old cohort's id across a compiler-fingerprint change.
      stage_id: stage?.stage_id || (evidenceMatches ? existing?.stage_id : null) || null,
      evidence: {
        compiler_fingerprint: compilerFingerprint,
        metrics: decision.metrics, blockers: decision.blockers, thresholds: decision.thresholds, transition,
      },
    });
  } catch (err) {
    // Do not apply an unaudited promotion. A rollback remains effective for
    // this invocation because shadow is the safe behavior even if persistence
    // is temporarily unavailable.
    if (stage?.recommendation === 'promote-to-assist') {
      effectiveMode = configuredMode;
      stage = null;
    }
    const fallbackCfg = configWithEffectiveMode(configuredCfg, configuredMode, effectiveMode);
    return {
      cfg: fallbackCfg, configured_mode: configuredMode, effective_mode: effectiveMode,
      recommendation: 'telemetry-write-failed', changed: effectiveMode !== currentMode,
      decision, stage, error: err.message,
    };
  }
  const effectiveCfg = configWithEffectiveMode(configuredCfg, configuredMode, effectiveMode);
  return {
    cfg: effectiveCfg,
    configured_mode: configuredMode,
    effective_mode: effectiveMode,
    recommendation: decision.recommendation,
    changed: effectiveMode !== currentMode,
    decision,
    stage,
  };
}
