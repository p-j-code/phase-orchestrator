// Guide-task registry — the single source of truth for which guide tasks exist
// and which are safe to run through the worker-pool queue.
//
// Kept dependency-free on purpose: both the Telegram handler (which parses
// `/run <project> guide --task <type>`) and the verify harness import from here
// without dragging in grammy / chalk / better-sqlite3.

// Every task `buildGuidePrompt()` in src/lib/phase-runner.js understands.
// Keep in sync with the switch there.
export const KNOWN_GUIDE_TASKS = new Set([
  'plan',
  'next-prompt',
  'review',
  'handoff',
  'bug-plan',
  'fix-prompt',
  'workspace-claude-md',
  'brief-author',
  'audit',
  'roadmap',
  'project-context-gen',
  'requirement-refine',
  'lessons-distill',
]);

// Tasks safe to dispatch over the queue: they need only project state +
// on-disk files, so the worker can run them with nothing but `{ task }`.
//
// Deliberately EXCLUDED (need context that can't cross the queue boundary):
//   bug-plan         — needs a bug-round number
//   fix-prompt       — needs round + fix id
//   requirement-refine — needs the requirement text
//   project-context-gen — unverified arg surface; route via CLI until checked
// (audit / roadmap / brief-author already have their own /run actions.)
//   lessons-distill  — needs no extra args, but it's an autonomous maintenance
//     task auto-triggered by auto-runner.js's pickNextAction (once
//     .guide/lessons.jsonl crosses lessons.distill_after_entries), not
//     something an operator dispatches on demand. Keeping it off the queue
//     matches the audit/roadmap/brief-author precedent (their own trigger
//     path, not manual queue dispatch) and avoids an operator forcing a
//     premature distillation via `/run <project> guide --task lessons-distill`
//     while the backlog is still small.
export const QUEUE_SAFE_GUIDE_TASKS = new Set([
  'plan',
  'next-prompt',
  'review',
  'handoff',
  'workspace-claude-md',
]);

/**
 * Extract a flag value from a token array. Accepts both `--flag value` and
 * `--flag=value`. Returns the string value, or null if the flag is absent
 * (or present with no value). Pure — no side effects.
 *
 *   parseFlagValue(['--task', 'review'], '--task')  -> 'review'
 *   parseFlagValue(['--task=review'], '--task')      -> 'review'
 *   parseFlagValue(['--unattended'], '--task')       -> null
 */
export function parseFlagValue(tokens, flag) {
  if (!Array.isArray(tokens)) return null;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === flag) {
      const next = tokens[i + 1];
      return (next && !next.startsWith('--')) ? next : null;
    }
    if (t.startsWith(`${flag}=`)) {
      const v = t.slice(flag.length + 1);
      return v || null;
    }
  }
  return null;
}

/**
 * Classify a requested guide task for the queue path. Returns one of:
 *   { ok: true, task }                              — enqueue with args.task
 *   { ok: false, reason: 'unsafe', task }           — known but needs CLI context
 *   { ok: false, reason: 'unknown', task }          — not a guide task at all
 * `task` of null/undefined means "no --task given" → caller uses the default.
 */
export function classifyGuideTask(task) {
  if (!task) return { ok: true, task: null };
  if (QUEUE_SAFE_GUIDE_TASKS.has(task)) return { ok: true, task };
  if (KNOWN_GUIDE_TASKS.has(task)) return { ok: false, reason: 'unsafe', task };
  return { ok: false, reason: 'unknown', task };
}
