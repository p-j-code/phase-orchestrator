// Self-Heal Agent — spawns a Claude subprocess to fix orchestrator-level bugs.
//
// Flow:
//   0. requireConfirmation gate (Phase 13) — NO edit/commit/push happens until
//      the operator approves. Triggered by ordinary operational events (parse
//      errors, null derefs, import failures), an autonomous edit of the LIVE
//      orchestrator source + push is the highest-severity unmitigated risk, so
//      a human checkpoint sits in front of it. TTL is indefinite (the operator
//      may be asleep). If the notifier can't reach anyone, we write a pending
//      log and pause instead of waiting forever or silently disabling. The
//      confirmation wait is bounded so one sleeping operator cannot occupy the
//      only durable worker and stop every other project overnight.
//   1. Parse the failing file + line from the stack trace
//   2. Feed the error location to Claude through the shared instrumented runner
//   3. Claude uses Edit/Read to apply a minimal fix
//   4. Verify: `npm run test:config` when a config file changed
//   5. Git add + commit on the orchestrator branch
//   6. Git push origin HEAD

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGit, getCurrentBranch, workspaceStatus } from './git.js';
import { requireConfirmation } from './require-confirmation.js';
import { escapeHtml } from './telegram-fmt.js';
import { runClaude } from '../claude-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = path.resolve(__dirname, '..', '..');

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Extract the first orchestrator source file + line from an error stack. */
function parseStackLocation(stack = '') {
  for (const line of stack.split('\n')) {
    // Matches both "(/.../src/foo.js:12:5)" and "at /.../src/foo.js:12:5"
    const m = line.match(/\(?(\/[^):\s]+\.js):(\d+)/);
    if (!m) continue;
    const file = m[1];
    // Must be inside REPO_ROOT/src and not inside node_modules or /projects/
    if (
      file.startsWith(REPO_ROOT) &&
      file.includes('/src/') &&
      !file.includes('node_modules') &&
      !file.includes('/projects/')
    ) {
      return { file, line: parseInt(m[2], 10) };
    }
  }
  return null;
}

/** Spawn a child process, capture stdout/stderr, resolve when it exits. */
function spawnCapture(cmd, args, cwd, timeoutMs = 180_000) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const proc = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });

    const t = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);

    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    proc.on('exit', (code) => {
      clearTimeout(t);
      resolve({
        ok: !timedOut && code === 0,
        code,
        stdout: stdout.trim(),
        stderr: (stderr + (timedOut ? '\n[timed out]' : '')).trim(),
      });
    });

    proc.on('error', (e) => {
      clearTimeout(t);
      resolve({ ok: false, code: -1, stdout: '', stderr: e.message });
    });
  });
}

/**
 * When the operator can't be reached (no notifier, or it delivered to nobody),
 * persist everything needed to act on the pending auto-heal by hand, and return
 * the file's repo-relative path so the pause reason can name it.
 */
async function writePendingLog({ relPath, line, errorSummary, stack }) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const relLog = path.join('logs', `auto-heal-pending-${ts}.md`);
  const absLog = path.join(REPO_ROOT, relLog);
  const body = [
    `# Auto-heal pending confirmation — ${new Date().toISOString()}`,
    '',
    'An orchestrator bug triggered self-heal, but the confirmation gate could',
    'not reach an operator (no allowlisted Telegram user, send failed, or no',
    'interactive terminal). **No source was edited and nothing was committed or',
    'pushed.** Review the proposed fix target below and run the heal manually.',
    '',
    `## File to fix: ${relPath} (crash near line ${line})`,
    '',
    '## Error',
    '```',
    errorSummary,
    '```',
    '',
    '## Stack (first 12 lines)',
    '```',
    (stack ?? '').split('\n').slice(0, 12).join('\n'),
    '```',
    '',
  ].join('\n');
  try {
    await fs.mkdir(path.dirname(absLog), { recursive: true });
    await fs.writeFile(absLog, body, 'utf-8');
  } catch { /* best-effort — the pause reason still names the intended path */ }
  return relLog;
}

export function buildSelfHealPrompt({ relPath, line, errorSummary, stackLines }) {
  return [
    '## Crashed with this error',
    `Message: ${errorSummary}`,
    '',
    'Stack (first 12 lines):',
    '```',
    stackLines,
    '```',
    '',
    `## File to fix: ${relPath}  (crash near line ${line})`,
    '',
    'Your job:',
    `1. Read ${relPath} around line ${line} and identify the root cause from the error and stack.`,
    '2. Apply the minimal correct fix using the Edit tool.',
    '3. Do NOT refactor, add features, add comments, or change unrelated code.',
    '4. Do NOT write tests.',
    '5. After editing, briefly state what you changed and why (one sentence).',
  ].join('\n');
}

export function buildSelfHealRunnerCfg(cfg = {}) {
  const healCfg = {
    ...cfg,
    model: cfg?.models?.['self-heal'] || cfg?.models?.['dev-execution'] || 'claude-sonnet-5',
    tools: { ...cfg?.tools, allowed_default: ['Read', 'Edit'], permission_mode: 'acceptEdits' },
    phases: {
      ...cfg?.phases,
      task_max_turns: { ...(cfg?.phases?.task_max_turns || {}), 'self-heal': 8 },
      task_timeout_ms: { ...(cfg?.phases?.task_timeout_ms || {}), 'self-heal': 300_000 },
    },
  };
  delete healCfg._effort_override;
  return healCfg;
}

/**
 * Restore a repository that was clean before the self-heal model call.
 *
 * The self-heal agent is intentionally allowed to edit only one approved
 * source file, but a failed or misbehaving invocation can still leave tracked,
 * staged, or newly-created files behind. Because the caller proves the tree is
 * clean immediately before invoking Claude, every dirty path here belongs to
 * that invocation and can be removed without touching operator work.
 */
export async function cleanupSelfHealChanges(repoRoot = REPO_ROOT) {
  const failures = [];

  const changed = new Set();
  for (const args of [
    ['diff', '--name-only', '--diff-filter=ACDMRTUXB'],
    ['diff', '--cached', '--name-only', '--diff-filter=ACDMRTUXB'],
  ]) {
    const result = await runGit(repoRoot, args);
    if (!result.ok) {
      failures.push(`git ${args.slice(0, 2).join(' ')}: ${result.stderr || 'failed'}`);
      continue;
    }
    for (const rel of result.stdout.split('\n').map((v) => v.trim()).filter(Boolean)) changed.add(rel);
  }

  if (changed.size > 0) {
    const paths = [...changed];
    const reset = await runGit(repoRoot, ['reset', '--', ...paths]);
    if (!reset.ok) failures.push(`git reset: ${reset.stderr || 'failed'}`);

    // Restore every tracked path after the reset. Supplying a mixed list of
    // tracked and newly-added paths makes git reject the whole checkout when
    // one new path is absent from HEAD. The tree was proven clean before the
    // model ran, so restoring all tracked paths is both safe and complete.
    const restore = await runGit(repoRoot, ['checkout', '--', '.']);
    if (!restore.ok) {
      failures.push(`git checkout: ${restore.stderr || 'failed'}`);
    }
  }

  const untracked = await runGit(repoRoot, ['ls-files', '--others', '--exclude-standard']);
  if (!untracked.ok) {
    failures.push(`git ls-files: ${untracked.stderr || 'failed'}`);
  } else {
    const root = path.resolve(repoRoot);
    for (const rel of untracked.stdout.split('\n').map((v) => v.trim()).filter(Boolean)) {
      const abs = path.resolve(root, rel);
      if (abs === root || !abs.startsWith(`${root}${path.sep}`)) {
        failures.push(`refused unsafe cleanup path: ${rel}`);
        continue;
      }
      try {
        await fs.rm(abs, { recursive: true, force: true });
      } catch (e) {
        failures.push(`remove ${rel}: ${e.message}`);
      }
    }
  }

  const finalStatus = await workspaceStatus(repoRoot);
  if (!finalStatus.clean) {
    failures.push(`worktree still dirty: ${finalStatus.dirty.join(', ') || finalStatus.error || 'unknown'}`);
  }
  return { ok: failures.length === 0, failures };
}

async function cleanupFailure(reason) {
  const cleanup = await cleanupSelfHealChanges(REPO_ROOT);
  return cleanup.ok ? reason : `${reason}; cleanup incomplete: ${cleanup.failures.join('; ')}`;
}

// ─── Main export ────────────────────────────────────────────────────────────

/**
 * Attempt to fix an orchestrator bug using Claude, then commit + push — but ONLY
 * after the operator approves via the requireConfirmation gate.
 *
 * @param {Error}  err            The error that crashed the orchestrator
 * @param {object} [opts]
 * @param {object|null} [opts.notifier]  Notifier for the Telegram gate (null = CLI readline)
 * @returns {{ healed: boolean, reason: string, committed?: boolean, paused?: boolean }}
 */
export async function selfHealOrchestrator(err, { notifier = null, cfg = {}, runClaudeFn = runClaude } = {}) {
  const location = parseStackLocation(err?.stack ?? '');
  if (!location) {
    return { healed: false, reason: 'no orchestrator source file found in stack trace' };
  }

  const { file, line } = location;
  const relPath = path.relative(REPO_ROOT, file);

  try {
    await fs.access(file);
  } catch (e) {
    return { healed: false, reason: `could not read ${relPath}: ${e.message}` };
  }

  // Self-heal promises a one-file patch and commit. Enforce an entirely clean
  // orchestrator tree before spending a model call: otherwise we cannot safely
  // distinguish the agent's delta from the operator's existing work or revert
  // a failed fix without destroying user changes.
  const beforeStatus = await workspaceStatus(REPO_ROOT);
  if (!beforeStatus.clean) {
    return {
      healed: false,
      paused: true,
      reason: `auto-heal paused — orchestrator worktree is dirty (${beforeStatus.dirty.slice(0, 5).join(', ')}). No model call or source change was made.`,
    };
  }

  const errorSummary = (err?.message ?? 'unknown error').slice(0, 300).replace(/\n/g, ' ');
  const stackLines   = (err?.stack ?? '').split('\n').slice(0, 12).join('\n');
  const configuredConfirmMs = Number(cfg?.auto_heal?.self_heal_confirmation_timeout_ms);
  const confirmationTimeoutMs = Number.isFinite(configuredConfirmMs)
    ? Math.max(1_000, configuredConfirmMs)
    : 120_000;

  // ── Gate: no edit/commit/push until the operator approves ────────────────────
  const gate = await requireConfirmation({
    action: 'self-heal',
    project: null,
    summary:
      '🔧 <b>Auto-heal wants to patch the live orchestrator source</b>\n\n'
      + `File: <code>${escapeHtml(relPath)}</code> (crash near line ${line})\n`
      + `Error: ${escapeHtml(errorSummary)}\n\n`
      + 'Approving runs Claude to edit <code>src/</code>, then commits and pushes to the '
      + `orchestrator branch. This request expires safely after ${Math.ceil(confirmationTimeoutMs / 1000)} seconds so the overnight worker can continue other projects.`,
    options: [
      { id: 'approve', label: '✅ Approve auto-fix' },
      { id: 'reject',  label: '🛑 Reject (do nothing)' },
    ],
    defaultOption: 'reject', // safe fallback for CLI garbage input; never auto-applied (TTL is null)
    ttlMs: confirmationTimeoutMs,
    notifier,
  });

  if (gate.reason === 'undelivered' || gate.reason === 'no-tty' || gate.reason === 'expired') {
    const relLog = await writePendingLog({ relPath, line, errorSummary, stack: err?.stack });
    return {
      healed: false,
      paused: true,
      reason: `auto-heal paused — confirmation was ${gate.reason === 'expired' ? 'not answered before its bounded timeout' : 'unable to reach an operator'}. No changes made; the durable worker is free for other projects. See ${relLog}`,
    };
  }

  if (gate.option !== 'approve') {
    return { healed: false, reason: `auto-heal rejected by operator for ${relPath} — no changes made` };
  }

  const prompt = buildSelfHealPrompt({ relPath, line, errorSummary, stackLines });
  const healCfg = buildSelfHealRunnerCfg(cfg);

  let claudeResult;
  try {
    claudeResult = await runClaudeFn({
      cfg: healCfg,
      cwd: REPO_ROOT,
      prompt,
      systemPromptFile: null,
      systemPromptExtra: 'You repair one confirmed Ashmero Orchestrator bug. Read only the named source file, make the smallest correct edit, and never touch project workspaces or unrelated files.',
      sessionId: null,
      role: null,
      // This is orchestrator-level work, not a user project. Keeping project
      // null avoids a calls.project foreign-key failure after the paid call
      // succeeds (there is intentionally no synthetic "orchestrator" row).
      project: null,
      phase: null,
      projectDir: null,
      task: 'self-heal',
      routing: { tier: 'sonnet', reasoning: ['operator-approved orchestrator self-heal'], attempt: 1, escalated: false },
    });
  } catch (runErr) {
    return {
      healed: false,
      reason: await cleanupFailure(`instrumented Claude runner failed: ${runErr.message}`),
    };
  }

  if (claudeResult?.is_error) {
    return {
      healed: false,
      reason: await cleanupFailure(
        `Claude self-heal call failed: ${String(claudeResult.error_message || claudeResult.result || 'unknown error').slice(0, 200)}`,
      ),
    };
  }

  // Check whether Claude actually changed anything
  const status = await workspaceStatus(REPO_ROOT);
  if (status.clean) {
    return { healed: false, reason: 'claude made no file changes — bug may need manual review' };
  }
  const changedPaths = status.dirty.map((entry) => {
    const value = String(entry).slice(2).trim();
    return value.includes(' -> ') ? value.split(' -> ').pop() : value;
  });
  if (changedPaths.length !== 1 || changedPaths[0] !== relPath) {
    return {
      healed: false,
      paused: true,
      reason: await cleanupFailure(
        `auto-heal refused to commit — approved target was ${relPath}, but changed paths were: ${changedPaths.join(', ') || '(unknown)'}`,
      ),
    };
  }

  // If Claude touched a config-related file, run the config test suite only
  // after the one-file invariant is proven. The tree was clean before the call,
  // so reverting this exact target cannot destroy pre-existing user edits.
  const isConfigFile = /config/.test(relPath);
  if (isConfigFile) {
    const testResult = await spawnCapture('npm', ['run', 'test:config'], REPO_ROOT, 60_000);
    if (!testResult.ok) {
      return {
        healed: false,
        reason: await cleanupFailure(`test:config failed after auto-fix — reverted: ${testResult.stderr.slice(0, 200)}`),
      };
    }
  }

  // Commit exactly the approved file; never sweep unrelated src/ changes.
  const commitMsg = `fix(auto-heal): ${errorSummary.slice(0, 60)}`;
  await runGit(REPO_ROOT, ['add', '--', relPath]);
  const commit = await runGit(REPO_ROOT, ['commit', '-m', commitMsg]);
  if (!commit.ok) {
    return {
      healed: false,
      reason: await cleanupFailure(`git commit failed: ${commit.stderr.slice(0, 200)}`),
    };
  }

  // Push to the current branch
  const branch = await getCurrentBranch(REPO_ROOT);
  const push   = await runGit(REPO_ROOT, ['push', 'origin', branch || 'HEAD']);
  if (!push.ok) {
    // Committed locally — still useful, warn about push failure
    return {
      healed: true,
      committed: true,
      reason: `fix committed locally (push failed: ${push.stderr.slice(0, 100)}). Run 'git push' manually then restart.`,
    };
  }

  return {
    healed: true,
    committed: true,
    reason: `orchestrator bug auto-fixed, committed, and pushed to ${branch}. Restart to resume.`,
  };
}
