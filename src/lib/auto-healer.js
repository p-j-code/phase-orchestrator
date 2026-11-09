// Auto-Healer — detects and resolves common orchestrator + project blockers.
//
// Error kinds and their strategies:
//   provider-limit   → no LLM/heal; shared breaker + durable scheduler own reset
//   network          → no nested retry; durable scheduler owns delayed resume
//   git-diverged     → stash, pull --rebase, pop stash
//   git-dirty        → stash uncommitted changes
//   dependency       → npm install in workspace
//   phase-stuck      → reset stuck phase to 'pending' (timeout/stall only)
//   orchestrator-bug → spawn Claude to fix, commit, push (self-heal-agent)
//   validation/budget/unknown → not auto-recoverable; escalate to human
//
// Each attempt is recorded in the `healing_log` SQLite table so the healer
// can enforce per-kind attempt limits and prevent infinite retry loops.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import chalk from 'chalk';
import { classifyError } from './error-classifier.js';
import { isProviderRateLimitError } from './transient-errors.js';
import { runGit, workspaceStatus } from './git.js';
import { selfHealOrchestrator } from './self-heal-agent.js';
import { recordLesson } from './lessons.js';
import {
  recordHealingAttempt, updateHealingStatus, getRecentHealingAttempts,
  upsertPhase, setCurrentPhase,
} from '../state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function npmInstall(cwd) {
  return new Promise((resolve) => {
    const proc = spawn('npm', ['install'], { cwd, stdio: 'ignore' });
    const t    = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } resolve({ ok: false }); }, 120_000);
    proc.on('exit',  (code) => { clearTimeout(t); resolve({ ok: code === 0 }); });
    proc.on('error', ()     => { clearTimeout(t); resolve({ ok: false }); });
  });
}

// ─── AutoHealer class ────────────────────────────────────────────────────────

export class AutoHealer {
  /**
   * @param {object} opts
   * @param {string|null}  opts.projectName   null for orchestrator-level errors
   * @param {string|null}  opts.workspaceDir  project workspace path
   * @param {object|null}  opts.cfg           resolved config (for auto_heal.*  sub-keys)
   * @param {object|null}  opts.notifier      optional notifier for Telegram alerts
   */
  constructor({ projectName = null, workspaceDir = null, cfg = null, notifier = null } = {}) {
    this.projectName  = projectName;
    this.workspaceDir = workspaceDir;
    this.cfg          = cfg;
    this.notifier     = notifier;
  }

  _log(msg)  { console.log(chalk.cyan(`  🔧 auto-heal: ${msg}`)); }
  _warn(msg) { console.log(chalk.yellow(`  ⚠  auto-heal: ${msg}`)); }

  // Issue bridge (chat control plane): when healing gives up, open a chat
  // thread pre-seeded with the error so the operator can just type "fix it".
  // Fire-and-forget by contract — openIssueThread never throws, and the lazy
  // import is guarded too, so this can never worsen the original failure.
  async _openIssue(err, kind, detail) {
    try {
      const { openIssueThread } = await import('../chat/issue-bridge.js');
      openIssueThread({
        project: this.projectName,
        kind,
        error: String(err?.message ?? err ?? '').slice(0, 800),
        detail,
        // Preserve the diagnostic thread, but do not let a provider quota
        // failure trigger a same-window chat "fix it" call.
        // Classification bugs must not turn a provider exhaustion event into a
        // same-window autopsy/self-heal cascade. Suppress from the raw payload,
        // independently of whichever kind the classifier returned.
        suppressAutoFix: isProviderRateLimitError(err?.message ?? err) || kind === 'network',
      });
    } catch { /* bridge is best-effort */ }
  }

  /**
   * Main entry point. Classify the error, check attempt budget, dispatch strategy.
   *
   * @param {Error|string} err
   * @param {object} context  { action, projectName, workspaceDir, branch }
   * @returns {{ healed: boolean, action?: string, reason: string }}
   */
  async heal(err, context = {}) {
    const healCfg = this.cfg?.auto_heal ?? {};
    if (healCfg.enabled === false) return { healed: false, reason: 'auto-heal disabled' };

    const { kind, recoverable, maxAttempts, windowMinutes } = classifyError(err);

    // The raw stack never otherwise reaches a log: healing_log only persists
    // the message, and self-heal-agent's location parser silently swallows
    // a miss. Print it for orchestrator-bug specifically so the next
    // occurrence is actually diagnosable from the run log.
    if (kind === 'orchestrator-bug' && err?.stack) {
      console.error(chalk.red(`  🔍 auto-heal: orchestrator-bug raw stack:\n${err.stack}`));
    }

    // The durable scheduler + shared provider breaker own this recovery. Do
    // not sleep/retry, record a healing attempt, invoke self-heal, or drive an
    // issue thread with another Claude call while the account is exhausted.
    if (isProviderRateLimitError(err?.message ?? err)) {
      await this._openIssue(err, kind, 'provider account exhausted; waiting for reset');
      return { healed: false, reason: `${kind}: waiting for provider reset` };
    }

    if (!recoverable || maxAttempts === 0) {
      await this._openIssue(err, kind, 'not auto-recoverable');
      return { healed: false, reason: `${kind}: not auto-recoverable` };
    }

    // Enforce per-kind attempt rate-limit within rolling window
    const recent = getRecentHealingAttempts(this.projectName, kind, windowMinutes);
    if (recent.length >= maxAttempts) {
      this._warn(`${kind}: hit max ${maxAttempts} healing attempt(s) in the last ${windowMinutes} min — needs human review`);
      await this._openIssue(err, kind, `max healing attempts (${maxAttempts}) reached in ${windowMinutes} min`);
      return { healed: false, reason: `max healing attempts reached for ${kind}` };
    }

    this._log(`${kind} error detected — attempting recovery (try ${recent.length + 1}/${maxAttempts})`);
    this._notify(`🔧 auto-heal triggered for <b>${this.projectName || 'orchestrator'}</b>: ${kind}`);

    const id = recordHealingAttempt({
      project:       this.projectName,
      error_kind:    kind,
      error_message: String(err?.message ?? err ?? '').slice(0, 500),
      context_json:  JSON.stringify({
        action:  context.action?.kind,
        phaseN:  context.action?.phaseN,
      }),
      strategy: kind,
    });
    const lessonProject = this.projectName || context.projectName || null;
    if (lessonProject) recordLesson(path.join(PROJECTS_DIR, lessonProject), { kind: 'heal', phase: context.action?.phaseN ?? null, source: kind, lesson: String(err?.message ?? err ?? '').slice(0, 500), files: [] }, this.cfg);

    let result;
    try {
      result = await this._dispatch(kind, err, context);
    } catch (healErr) {
      this._warn(`strategy threw: ${healErr.message}`);
      result = { healed: false, reason: `strategy error: ${healErr.message}` };
    }

    updateHealingStatus(id, result.healed ? 'resolved' : 'failed', result.healed ? new Date().toISOString() : null);

    if (result.healed) {
      this._log(`✓ healed — ${result.reason}`);
      this._notify(`✅ auto-heal succeeded: ${result.reason}`);
    } else {
      this._warn(`failed — ${result.reason}`);
      await this._openIssue(err, kind, `heal failed: ${result.reason}`);
    }

    return result;
  }

  // ── Strategy dispatcher ────────────────────────────────────────────────────

  async _dispatch(kind, err, context) {
    switch (kind) {
      // Network/5xx retries are deliberately absent here. runClaude has one
      // bounded attempt loop; if it exhausts, the queue persists a delayed
      // resume. Retrying again inline used to multiply attempts and replay the
      // same large context before the external condition had changed.
      case 'network':          return { healed: false, reason: 'network recovery delegated to durable scheduler' };
      case 'git-diverged':     return this._healGitDivergence(context);
      case 'git-dirty':        return this._healGitDirty(context);
      case 'dependency':       return this._healDependency(context);
      case 'phase-stuck':      return this._healPhaseStuck(context);
      // Dev agent exited while waiting for a Monitor notification that never
      // arrived. Treat identically to phase-stuck: reset and retry. The phase-
      // runner idempotency gate will detect an already-committed phase/fix and
      // skip re-work, so there's no double-apply risk.
      case 'monitor-wait':     return this._healPhaseStuck(context);
      case 'orchestrator-bug': {
        const selfHealEnabled = this.cfg?.auto_heal?.self_heal_orchestrator_bugs !== false;
        if (!selfHealEnabled) return { healed: false, reason: 'self_heal_orchestrator_bugs disabled' };
        // Pass the notifier so the confirmation gate can reach the operator;
        // null notifier → self-heal falls back to a CLI readline prompt.
        return selfHealOrchestrator(err, { notifier: this.notifier, cfg: this.cfg });
      }
      default:
        return { healed: false, reason: `no strategy for error kind '${kind}'` };
    }
  }

  // ── Strategies ─────────────────────────────────────────────────────────────

  async _healGitDivergence(context) {
    const dir    = context.workspaceDir || this.workspaceDir;
    const branch = context.branch || null;

    if (!dir) return { healed: false, reason: 'workspaceDir unknown — cannot reconcile git divergence' };

    // Stash first so we don't lose partial work
    const stash    = await runGit(dir, ['stash', 'push', '--include-untracked', '-m', 'auto-heal: pre-rebase stash']);
    const hasStash = stash.ok && !stash.stdout.includes('No local changes');

    // Pull with rebase
    const pullArgs = branch ? ['pull', '--rebase', 'origin', branch] : ['pull', '--rebase'];
    const pull     = await runGit(dir, pullArgs, { timeout: 120_000 });
    if (!pull.ok) {
      await runGit(dir, ['rebase', '--abort']);
      if (hasStash) await runGit(dir, ['stash', 'pop']);
      return { healed: false, reason: `rebase pull failed: ${pull.stderr.slice(0, 200)}` };
    }

    // Restore stash
    if (hasStash) {
      const pop = await runGit(dir, ['stash', 'pop']);
      if (!pop.ok) this._warn(`stash pop failed (stash preserved): ${pop.stderr}`);
    }

    return { healed: true, action: 'continue', reason: 'git divergence resolved via rebase pull' };
  }

  async _healGitDirty(context) {
    const dir = context.workspaceDir || this.workspaceDir;
    if (!dir) return { healed: false, reason: 'workspaceDir unknown — cannot stash dirty workspace' };

    const status = await workspaceStatus(dir);
    if (status.clean) return { healed: true, action: 'continue', reason: 'workspace was already clean' };

    const stash = await runGit(dir, ['stash', 'push', '--include-untracked', '-m', 'auto-heal: dirty workspace']);
    if (!stash.ok) return { healed: false, reason: `git stash failed: ${stash.stderr.slice(0, 200)}` };

    return { healed: true, action: 'continue', reason: `stashed ${status.dirty.length} dirty file(s)` };
  }

  async _healDependency(context) {
    const dir = context.workspaceDir || this.workspaceDir || REPO_ROOT;
    this._log('running npm install…');
    const result = await npmInstall(dir);
    if (!result.ok) return { healed: false, reason: 'npm install failed' };
    return { healed: true, action: 'retry', reason: 'npm install succeeded' };
  }

  async _healPhaseStuck(context) {
    const projectName = context.projectName || this.projectName;
    const action      = context.action;

    if (!projectName || !action?.phaseN) {
      return { healed: false, reason: 'cannot reset phase: missing projectName or phaseN in context' };
    }

    const maxPhaseRetries = this.cfg?.auto_heal?.max_phase_retries ?? 2;
    const phaseKind       = `phase-stuck-${action.phaseN}`;

    const recentPhase = getRecentHealingAttempts(projectName, phaseKind, 120);
    if (recentPhase.length >= maxPhaseRetries) {
      return {
        healed: false,
        reason: `phase ${action.phaseN} has been auto-retried ${maxPhaseRetries}× — needs human review`,
      };
    }

    // Timed-out phases don't commit, so it's safe to reset status without a git reset.
    upsertPhase({
      project: projectName,
      n:       action.phaseN,
      title:   action.phaseTitle ?? `phase-${action.phaseN}`,
      status:  'pending',
    });
    setCurrentPhase(projectName, action.phaseN - 1);

    // Track per-phase attempts separately so they don't consume the global phase-stuck bucket
    recordHealingAttempt({
      project:       projectName,
      error_kind:    phaseKind,
      error_message: 'phase timed-out or stalled',
      context_json:  JSON.stringify({ phaseN: action.phaseN }),
      strategy:      'phase-reset',
    });
    recordLesson(path.join(PROJECTS_DIR, projectName), { kind: 'heal', phase: action.phaseN, source: phaseKind, lesson: 'phase timed-out or stalled', files: [] }, this.cfg);

    return {
      healed: true,
      action: 'continue',
      reason: `reset phase ${action.phaseN} to pending for retry`,
    };
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  _notify(text) {
    if (this.notifier) this.notifier.notify({ text }).catch(() => {});
  }
}
