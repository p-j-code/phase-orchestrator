// Issue bridge — when the orchestrator hits an error it can't heal, open a
// chat thread pre-seeded with the error context and auto-trigger the chat
// agent to diagnose and route it immediately. Called fire-and-forget from
// auto-healer.js (every call is wrapped so a bridge failure can never
// worsen the original error).
//
// The seeded context is stored as a 'system' chat message; chat-engine.js
// includes any system messages the agent hasn't seen yet in an
// <issue_context> block on the next turn, so the agent starts with the full
// error picture without the operator having to paste anything.

import { createChatThread, getChatThread, listChatThreads, addChatMessage, touchChatThread, setThreadAutopilot } from '../state.js';
import { resolve as resolveConfig } from '../config-resolver.js';

const DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000; // one thread per (project, kind) per 6h

export function shouldAutoFixIssue({ cfg = {}, suppressAutoFix = false, env = process.env } = {}) {
  return !suppressAutoFix
    && env.ASHMERO_DISABLE_ISSUE_AUTOFIX !== '1'
    && cfg.chat?.issue_bridge?.auto_fix === true;
}

/**
 * Opens (or reuses) an issue thread and seeds it with error context.
 * Never throws. Returns the threadId or null.
 *
 * @param {Object} opts
 * @param {string|null} opts.project - project name (null = orchestrator-level)
 * @param {string} opts.kind - error kind (error-classifier kind or a label)
 * @param {string} opts.error - the error message
 * @param {string} [opts.detail] - extra context (heal reason, phase, action)
 * @param {boolean} [opts.suppressAutoFix] - log the issue without spending a chat turn
 */
export function openIssueThread({ project = null, kind = 'error', error = '', detail = '', suppressAutoFix = false } = {}) {
  try {
    const title = `Issue: ${project || 'orchestrator'} — ${kind}`.slice(0, 64);

    // Dedupe: reuse a recent thread with the same title so a flapping error
    // doesn't flood the chat list; each occurrence appends a new context block.
    const existing = listChatThreads(30).find((t) =>
      t.title === title && t.last_active_at && (Date.now() - new Date(t.last_active_at).getTime()) < DEDUPE_WINDOW_MS);
    const threadId = existing ? existing.id : createChatThread({ title, project });

    const lines = [
      `🔴 The orchestrator hit an issue it could not auto-heal (${new Date().toISOString()}):`,
      '',
      `- project: ${project || '(orchestrator-level)'}`,
      `- kind: ${kind}`,
      `- error: ${String(error).slice(0, 800)}`,
    ];
    if (detail) lines.push(`- detail: ${String(detail).slice(0, 400)}`);
    lines.push('', 'The issue has been logged. Reply with “fix it” when you want the chat agent to diagnose and route it.');

    addChatMessage({ thread_id: threadId, role: 'system', content: lines.join('\n'), meta: { issue: true, kind } });
    touchChatThread(threadId);

    // Drive the resolution. Two modes:
    //  - Autopilot ENABLED: flag the thread autopilot=1 and let chat-autopilot.js
    //    drive it to done as a BOUNDED loop (diagnose → fix → verify → resolve or
    //    escalate). Single-driver: the web-ui daemon owns every turn, so this
    //    process (the healer) never races it on the session.
    //  - Autopilot DISABLED: preserve the original one-shot "fix it" diagnose.
    //    This is now race-safe — the cross-process chat_locks lock serializes it
    //    against any concurrent engine turn — and the outcome is LOGGED, never
    //    swallowed (a self-heal that silently fails is worse than a loud one).
    // Both are scheduled async so openIssueThread stays synchronous and never
    // throws into the original error path.
    setImmediate(async () => {
      try {
        const cfg = await resolveConfig({ project: null, task: 'chat' });
        // Operator kill-switch. The reactive "fix it" turn is itself an LLM call
        // that draws from the same 5-hour account window as real runs — and under
        // rate-limit errors it cascades (error → fix-it → error). When the window
        // is scarce, disable it: the issue thread is still opened + logged, just
        // not auto-driven. Env wins so a single run can opt out without config edits.
        // Opt-in by design. Error handling must not silently spend another
        // Sonnet turn; this was especially damaging when the original error
        // was an exhausted provider window. The issue remains fully logged and
        // can still be driven by the operator with “fix it”.
        if (!shouldAutoFixIssue({ cfg, suppressAutoFix })) {
          console.error(`[issue-bridge] thread ${threadId} opened; auto-fix disabled (${kind}) — logged, not driven`);
          return;
        }
        const autopilotOn = cfg.chat?.autopilot?.enabled === true;
        if (autopilotOn) {
          setThreadAutopilot(threadId, {
            enabled: true,
            goal: `Resolve issue on ${project || 'the orchestrator'} (${kind}): diagnose the seeded error, drive the fix to done, and verify. Escalate ship / orchestrator_dev / abort to the operator.`,
          });
          console.error(`[issue-bridge] thread ${threadId} handed to autopilot (${kind})`);
        } else {
          const { sendChatMessage } = await import('./chat-engine.js');
          const r = await sendChatMessage({ threadId, message: 'fix it', project: project ?? undefined });
          if (r?.error) console.error(`[issue-bridge] one-shot auto-fix turn errored for thread ${threadId}`);
        }
      } catch (e) {
        console.error(`[issue-bridge] auto-resolve failed for thread ${threadId}: ${e.message}`);
      }
    });

    return threadId;
  } catch {
    return null; // the bridge must never make a bad situation worse
  }
}

export function isIssueThread(threadId) {
  try {
    const t = getChatThread(threadId);
    return !!t?.title?.startsWith('Issue: ');
  } catch {
    return false;
  }
}
