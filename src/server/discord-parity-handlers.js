// Discord parity handlers — Discord surfaces for CLI commands that were
// previously only reachable from the Mac terminal (predict, budget, inspect,
// retry, qa-handoff, validate, validators, dashboard, package, promote).
//
// Kept in a separate file from discord-handlers.js so the parity batch can be
// reviewed and reverted as one unit, and so discord-handlers.js doesn't grow
// past 130KB. All handlers follow the same conventions as the main file:
//   - requireAuth wrapper
//   - resolveProject for the project arg with pin fallback
//   - escapeHtml for any string that lands in HTML
//   - confirmation buttons on anything destructive (retry-phase, promote)
//
// Callback prefixes used by this file:
//   prom:y:<project>     — promote --from-audit (yes button)
//   prom:n               — promote no
//   insp:d:<project>:<n> — inspect: show diffstat
//   insp:f:<project>:<n> — inspect: DM the full diff as a file
//   retry:y:<project>:<n> — retry-phase yes (destructive: deletes commit)
//   retry:n              — retry-phase no
//   rmproj:y:<project>  — remove-project yes (destructive)
//   rmproj:n            — remove-project no
//   nb:go       — newbrief: reset brief + auto-run (fire-and-forget)
//   nb:show     — newbrief: DM the staged inputs/brief.md as a file
//   nb:cancel   — newbrief: dismiss
//   cf:<id>:<nonce>:<optIdx> — requireConfirmation gate: resolve pending row by
//                              nonce to the chosen option (Phase 13). The id is
//                              carried for display only; the nonce is authoritative.
//
// All non-callback handlers below register one bot.command(...) in server.js.

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DiscordKeyboard as InlineKeyboard } from '../lib/discord-compat.js';

import { requireAuth, resolveProject, suggestSessions, nbSessions, _buildGoalKb, _sugTypeLabel } from './discord-handlers.js';
import { generateSuggestions, filterSuggestions, assignToPasses } from '../lib/suggestion-engine.js';
import { generateAISuggestions } from '../lib/ai-suggestion-scanner.js';
import {
  getProject, getPhases, getEarlierSuggestionTitles, getActiveAutoRun,
  getPendingConfirmationByNonce, resolvePendingConfirmation,
} from '../state.js';
import { getRunningJobsForProject } from './job-queue.js';
import { escapeMarkdown as escapeHtml, escapeMarkdown as sanitizeForTelegram } from '../lib/discord-fmt.js';
import { briefPath, briefQuestionsPath, phaseDir, planJsonPath } from '../lib/guide-paths.js';
import { runGitOrThrow } from '../lib/git.js';
import { QUESTIONS } from '../lib/suggest-prompts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');
export const ITEM_CAP = 12; // max combined (AI/rules + manual) items in the selection keyboard

function truncate(s, max) {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…(truncated, ${s.length - max} more chars)`;
}

async function readJson(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf-8')); } catch { return null; }
}

// ─── /predict <project> ─────────────────────────────────────────────────────
//
// Mirrors `npm run predict -- <project>`. Renders the compact form of the
// prediction (it's already designed for narrow displays).

export const handlePredict = requireAuth(async (ctx) => {
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  const project = await resolveProject(ctx, args);
  if (!project) return;

  await ctx.reply(`💰 Predicting cost for <b>${sanitizeForTelegram(project)}</b>…`, { parse_mode: 'HTML' });

  try {
    const { predictUpcoming, renderPrediction } = await import('../commands/predict.js');
    const pred = await predictUpcoming(project);

    // v0.14.25: when predict comes back with no upcoming work (the project
    // is at current_phase == total_phases and no active bug round), don't
    // just dump the CLI's terse "no upcoming work" line — surface the
    // actually-useful next moves with buttons. This is the same situation
    // /coach handles via the "paused but complete" rule; predict gets here
    // independently when the user runs it directly without /coach.
    const noWork = !pred || pred.mode === 'idle' || (pred.units && pred.units.length === 0);
    if (noWork) {
      const p = getProject(project);
      const phaseInfo = p && p.total_phases > 0
        ? `currently at phase ${p.current_phase}/${p.total_phases}`
        : 'no plan generated yet';

      const kb = new InlineKeyboard()
        .text('🐛 Capture a QA bug', `bug:start:${project}`)
        .text(`📥 See pending bugs`, `bug:list:${project}`)
        .row()
        .text('🔍 Final audit', `act:${project}:audit`)
        .text('📋 QA handoff', `qa:${project}`)
        .row()
        .text('🗺 Roadmap (what next?)', `act:${project}:roadmap`);
      if (p?.git_branch && p.git_branch !== 'main') {
        kb.text('🚢 Ship to main', `act:${project}:ship`);
      }

      return ctx.reply(
        `<b>💰 No upcoming work for ${sanitizeForTelegram(project)}.</b>\n` +
        `<i>${sanitizeForTelegram(phaseInfo)} · no active bug round</i>\n\n` +
        `The plan has been fully executed. From here you typically:\n` +
        `  • Capture QA findings as bugs (then <code>/bug_promote</code>)\n` +
        `  • Run a final audit (read-only sanity check)\n` +
        `  • Generate a QA handoff doc to share with a tester\n` +
        `  • Ship to main\n` +
        `  • Or run a roadmap to plan v2`,
        { parse_mode: 'HTML', reply_markup: kb },
      );
    }

    // Standard path: render the prediction table
    const raw = renderPrediction(pred, { compact: true });
    const plain = raw.replace(/\[[0-9;]*m/g, '');
    return ctx.reply(
      `<b>Predicted cost — ${sanitizeForTelegram(project)}</b>\n<pre>${escapeHtml(truncate(plain, 3500))}</pre>`,
      { parse_mode: 'HTML' },
    );
  } catch (err) {
    return ctx.reply(`✗ Predict failed: ${sanitizeForTelegram(err.message)}`, { parse_mode: 'HTML' });
  }
});

// ─── /spend [project] [days] ─────────────────────────────────────────────────
//
// v0.14.34: ACTUAL spend from the calls table, grouped task × model — the
// measurement counterpart to /predict (estimates) and /budget (lifetime cap).
// Both args optional and order-free: a bare number (or "45d") is the trailing
// window in days; any other token is a project name. Read-only.

export const handleSpend = requireAuth(async (ctx) => {
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  let days = 30;
  let project = null;
  for (const a of args) {
    const dm = /^(\d{1,3})d?$/.exec(a);
    if (dm) { days = parseInt(dm[1], 10); continue; }
    project = a;
  }
  if (project && !getProject(project)) {
    return ctx.reply(`✗ Unknown project: <code>${sanitizeForTelegram(project)}</code>`, { parse_mode: 'HTML' });
  }

  try {
    const { costReport, renderCostReport } = await import('../lib/cost-report.js');
    const report = await costReport({ days, project });
    const plain = renderCostReport(report);
    return ctx.reply(
      `<b>💸 Spend report</b>\n<pre>${escapeHtml(truncate(plain, 3500))}</pre>`,
      { parse_mode: 'HTML' },
    );
  } catch (err) {
    return ctx.reply(`✗ Spend report failed: ${sanitizeForTelegram(err.message)}`, { parse_mode: 'HTML' });
  }
});

// ─── /budget <project> ──────────────────────────────────────────────────────
//
// Lifetime per-project spend + cap. Distinct from /status which shows the
// 5h rolling window. Read-only — never modifies anything.

export const handleBudget = requireAuth(async (ctx) => {
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  const project = await resolveProject(ctx, args);
  if (!project) return;

  try {
    const { projectCallCount, projectCallCost, getProjectCallCap } = await import('../commands/budget-guard.js');
    const { resolve: resolveConfig } = await import('../config-resolver.js');
    const cfg = await resolveConfig();
    const count = projectCallCount(project);
    const cost = projectCallCost ? projectCallCost(project) : null;
    const cap = getProjectCallCap(cfg, project);

    const lines = [
      `<b>💰 Budget — ${sanitizeForTelegram(project)}</b>`,
      '',
      `Calls used: <b>${count}</b>${cap ? ` / ${cap}` : ''}`,
    ];
    if (cap) {
      const pct = Math.round((count / cap) * 100);
      const bar = '█'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5));
      lines.push(`<code>${bar}</code> ${pct}%`);
    }
    if (cost !== null && cost !== undefined) {
      lines.push(`Spend (USD): <b>$${Number(cost).toFixed(2)}</b>`);
    }
    return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  } catch (err) {
    return ctx.reply(`✗ Budget lookup failed: ${sanitizeForTelegram(err.message)}`, { parse_mode: 'HTML' });
  }
});

// ─── /inspect <project> <phase> ─────────────────────────────────────────────
//
// Shows the phase report and offers buttons for diffstat / full-diff-as-file.
// On mobile a full diff is unreadable, so we default to the markdown report
// and gate the diff behind a tap.

export const handleInspect = requireAuth(async (ctx) => {
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  // Try positional: /inspect <project> <phase> or just /inspect <phase> with pin
  let project, phaseArg;
  if (args.length >= 2) {
    project = args[0];
    phaseArg = args[1];
  } else if (args.length === 1) {
    // Could be project (need pin for phase) — but phase alone is more likely
    // if the user has a pin. Try parsing as integer.
    if (/^\d+$/.test(args[0])) {
      project = await resolveProject(ctx, []);
      phaseArg = args[0];
    } else {
      project = args[0];
    }
  } else {
    project = await resolveProject(ctx, []);
  }
  if (!project) return;
  if (!phaseArg) {
    // Show a phase picker — last completed phases as buttons
    const phases = getPhases(project).filter((p) => p.status === 'completed').slice(-8);
    if (phases.length === 0) {
      return ctx.reply(`No completed phases for <b>${sanitizeForTelegram(project)}</b>.`, { parse_mode: 'HTML' });
    }
    const kb = new InlineKeyboard();
    for (const ph of phases) {
      kb.text(`Phase ${ph.n}: ${(ph.title || '').slice(0, 30)}`, `insp:r:${project}:${ph.n}`);
    }
    return ctx.reply(`Pick a phase to inspect in <b>${sanitizeForTelegram(project)}</b>:`, { parse_mode: 'HTML', reply_markup: kb });
  }
  const phaseN = parseInt(phaseArg, 10);
  if (!Number.isInteger(phaseN)) {
    return ctx.reply(`Bad phase number: <code>${sanitizeForTelegram(phaseArg)}</code>`, { parse_mode: 'HTML' });
  }
  return renderInspectReport(ctx, project, phaseN);
});

async function renderInspectReport(ctx, project, phaseN) {
  try {
    const projDir = path.join(PROJECTS_DIR, project);
    const plan = await readJson(planJsonPath(projDir));
    const phaseTitle = plan?.phases?.find((p) => p.n === phaseN)?.title;
    const dir = await phaseDir(projDir, phaseN, phaseTitle);
    let body;
    try { body = await fs.readFile(path.join(dir, 'report.md'), 'utf8'); } catch { /* missing */ }
    if (!body) {
      return ctx.reply(`No report found for phase ${phaseN} of <b>${sanitizeForTelegram(project)}</b>.`, { parse_mode: 'HTML' });
    }
    const kb = new InlineKeyboard()
      .text('📊 Diffstat', `insp:d:${project}:${phaseN}`)
      .text('📄 Full diff as file', `insp:f:${project}:${phaseN}`);
    return ctx.reply(
      `<b>Phase ${phaseN} report — ${sanitizeForTelegram(project)}</b>\n\n${sanitizeForTelegram(truncate(body, 3500))}`,
      { parse_mode: 'HTML', reply_markup: kb },
    );
  } catch (err) {
    return ctx.reply(`✗ Inspect failed: ${sanitizeForTelegram(err.message)}`, { parse_mode: 'HTML' });
  }
}

// Callback router for /inspect buttons. Wired into handleCallback dispatcher.
export async function handleInspectCallback(ctx, rest) {
  const sub = rest[0]; // 'r' (re-show report from picker), 'd' (diffstat), 'f' (file)
  const project = rest[1];
  const phaseN = parseInt(rest[2], 10);
  if (!project || !Number.isInteger(phaseN)) {
    return ctx.answerCallbackQuery({ text: 'Bad inspect callback', show_alert: true });
  }
  if (sub === 'r') {
    await ctx.answerCallbackQuery();
    return renderInspectReport(ctx, project, phaseN);
  }
  if (sub === 'd') {
    await ctx.answerCallbackQuery({ text: 'Loading diffstat…' });
    try {
      const phases = getPhases(project);
      const commitSha = phases.find((p) => p.n === phaseN)?.commit_sha;
      if (!commitSha) {
        return ctx.reply(`(no commit recorded for phase ${phaseN})`, { parse_mode: 'HTML' });
      }
      const workspaceDir = path.join(PROJECTS_DIR, project, 'workspace');
      const text = await runGitOrThrow(workspaceDir, ['show', '--stat', '--format=', commitSha]);
      return ctx.reply(
        `<b>Diffstat — ${sanitizeForTelegram(project)} phase ${phaseN}</b>\n<pre>${escapeHtml(truncate(text, 3500))}</pre>`,
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      return ctx.reply(`✗ Diffstat failed: ${sanitizeForTelegram(err.message)}`, { parse_mode: 'HTML' });
    }
  }
  if (sub === 'f') {
    await ctx.answerCallbackQuery({ text: 'Generating diff file…' });
    try {
      const phases = getPhases(project);
      const commitSha = phases.find((p) => p.n === phaseN)?.commit_sha;
      if (!commitSha) {
        return ctx.reply(`(no commit recorded for phase ${phaseN})`, { parse_mode: 'HTML' });
      }
      const workspaceDir = path.join(PROJECTS_DIR, project, 'workspace');
      const text = await runGitOrThrow(workspaceDir, ['show', '--format=', commitSha]);
      const tmpDir = path.join(REPO_ROOT, 'logs', 'tg-tmp');
      await fs.mkdir(tmpDir, { recursive: true });
      const outFile = path.join(tmpDir, `inspect-${project}-phase-${phaseN}.diff`);
      await fs.writeFile(outFile, text);
      return ctx.replyWithDocument({ path: outFile }, {
        caption: `Phase ${phaseN} full diff — ${project}`,
      });
    } catch (err) {
      return ctx.reply(`✗ Diff file failed: ${sanitizeForTelegram(err.message)}`, { parse_mode: 'HTML' });
    }
  }
  return ctx.answerCallbackQuery({ text: 'Unknown inspect sub-action', show_alert: true });
}

// ─── /retry <project> <phase> ───────────────────────────────────────────────
//
// Destructive: resets a phase to pending AND reverts workspace to the parent
// commit. Always shows a confirmation button first. Mirrors the CLI safety:
// the underlying retryPhase function requires the user to opt in by passing
// force=true (we set force=true after the user taps Yes).

export const handleRetryPhase = requireAuth(async (ctx) => {
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  let project, phaseArg;
  if (args.length >= 2) { project = args[0]; phaseArg = args[1]; }
  else if (args.length === 1 && /^\d+$/.test(args[0])) {
    project = await resolveProject(ctx, []);
    phaseArg = args[0];
  } else if (args.length === 1) {
    project = args[0];
  } else {
    project = await resolveProject(ctx, []);
  }
  if (!project) return;
  if (!phaseArg) {
    return ctx.reply(`Usage: <code>/retry &lt;project&gt; &lt;phase&gt;</code>`, { parse_mode: 'HTML' });
  }
  const phaseN = parseInt(phaseArg, 10);
  if (!Number.isInteger(phaseN)) {
    return ctx.reply(`Bad phase number: <code>${sanitizeForTelegram(phaseArg)}</code>`, { parse_mode: 'HTML' });
  }
  // Dry-run first to surface what the user is about to lose
  try {
    const { retryPhase } = await import('../commands/retry-phase.js');
    const preview = await retryPhase({ projectName: project, phaseN, dryRun: true });
    const lossLine = preview?.parentSha
      ? `Will revert workspace to <code>${sanitizeForTelegram(preview.parentSha.slice(0, 8))}</code>.`
      : 'Workspace revert details unavailable (dry-run reported no parent SHA).';
    const kb = new InlineKeyboard()
      .text(`Yes, retry phase ${phaseN}`, `retry:y:${project}:${phaseN}`)
      .text('Cancel', 'retry:n');
    return ctx.reply(
      `⚠ <b>Retry phase ${phaseN} of ${sanitizeForTelegram(project)}?</b>\n\n` +
      `This resets the phase to pending and reverts the workspace.\n` +
      lossLine + `\n\nThis is destructive. Are you sure?`,
      { parse_mode: 'HTML', reply_markup: kb },
    );
  } catch (err) {
    return ctx.reply(`✗ Retry preview failed: ${sanitizeForTelegram(err.message)}`, { parse_mode: 'HTML' });
  }
});

export async function handleRetryCallback(ctx, rest) {
  if (rest[0] === 'n') {
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    return ctx.reply('Cancelled.');
  }
  if (rest[0] === 'y') {
    const project = rest[1];
    const phaseN = parseInt(rest[2], 10);
    if (!project || !Number.isInteger(phaseN)) {
      return ctx.answerCallbackQuery({ text: 'Bad retry callback', show_alert: true });
    }
    await ctx.answerCallbackQuery({ text: 'Retrying…' });
    try {
      const { retryPhase } = await import('../commands/retry-phase.js');
      const result = await retryPhase({ projectName: project, phaseN, force: true });
      if (result?.ok === false) {
        return ctx.reply(`✗ Retry failed: ${sanitizeForTelegram(result.error || 'unknown')}`, { parse_mode: 'HTML' });
      }
      return ctx.reply(
        `✓ Phase ${phaseN} of <b>${sanitizeForTelegram(project)}</b> reset.\n` +
        `Use <code>/run ${sanitizeForTelegram(project)} next</code> to re-run it, or <code>/run ${sanitizeForTelegram(project)} go</code> to resume from here.`,
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      return ctx.reply(`✗ Retry crashed: ${sanitizeForTelegram(err.message)}`, { parse_mode: 'HTML' });
    }
  }
  return ctx.answerCallbackQuery({ text: 'Unknown retry sub-action', show_alert: true });
}

// ─── /promote <project> ─────────────────────────────────────────────────────
//
// Audit-to-bug-round promotion. Reads the most recent audit, extracts the
// Promote section, writes bugs.md for the next round. Mirrors `npm run promote
// -- <project> --from-audit`. Confirmation required because it creates a file
// that the next /run bugs job will execute against.

export const handlePromote = requireAuth(async (ctx) => {
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  const project = await resolveProject(ctx, args);
  if (!project) return;

  try {
    const { findMostRecentAudit } = await import('../lib/guide-paths.js');
    const projDir = path.join(PROJECTS_DIR, project);
    const auditFile = await findMostRecentAudit(projDir);
    if (!auditFile) {
      return ctx.reply(
        `No audit file for <b>${sanitizeForTelegram(project)}</b>.\n` +
        `Run <code>/run ${sanitizeForTelegram(project)} audit</code> first.`,
        { parse_mode: 'HTML' },
      );
    }
    const { extractPromoteSection, promoteAuditToBugs } = await import('../lib/audit-promote.js');
    const extracted = await extractPromoteSection(auditFile);
    if (!extracted.found) {
      return ctx.reply(
        `✗ Could not extract Promote section from audit:\n` +
        `<code>${sanitizeForTelegram(path.basename(auditFile))}</code>\n\n` +
        `Reason: ${sanitizeForTelegram(extracted.reason || 'unknown')}\n\n` +
        `${sanitizeForTelegram('Open the file on the Mac and copy findings into bugs.md by hand.')}`,
        { parse_mode: 'HTML' },
      );
    }
    const dryResult = await promoteAuditToBugs({ projDir, projectName: project, dryRun: true });
    if (!dryResult.promoted) {
      const hint = /already promoted/i.test(dryResult.reason || '')
        ? `\n\nUse <code>npm run promote -- ${sanitizeForTelegram(project)} --from-audit --force</code> from the CLI to re-promote.`
        : '';
      return ctx.reply(
        `<b>Promote not available for ${sanitizeForTelegram(project)}</b>\n\n` +
        `Source: <code>${sanitizeForTelegram(path.basename(auditFile))}</code>\n\n` +
        sanitizeForTelegram(dryResult.reason || 'Cannot promote at this time.') + hint,
        { parse_mode: 'HTML' },
      );
    }
    const targetRound = dryResult.round;
    const kb = new InlineKeyboard()
      .text(`Yes — promote to round ${targetRound}`, `prom:y:${project}`)
      .text('Cancel', 'prom:n');
    return ctx.reply(
      `<b>Promote audit for ${sanitizeForTelegram(project)}?</b>\n\n` +
      `Source: <code>${sanitizeForTelegram(path.basename(auditFile))}</code>\n` +
      `Target: <code>bug-rounds/round-${targetRound}/bugs.md</code>\n\n` +
      `${dryResult.warning ? `⚠ ${sanitizeForTelegram(dryResult.warning)}\n\n` : ''}` +
      `After promotion you can: review the bugs file (preview/files), edit it on the Mac to strip false positives, then run <code>/run ${sanitizeForTelegram(project)} bugs</code>.`,
      { parse_mode: 'HTML', reply_markup: kb },
    );
  } catch (err) {
    return ctx.reply(`✗ Promote preview failed: ${sanitizeForTelegram(err.message)}`, { parse_mode: 'HTML' });
  }
});

export async function handlePromoteCallback(ctx, rest) {
  if (rest[0] === 'n') {
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    return ctx.reply('Cancelled.');
  }
  if (rest[0] !== 'y') {
    return ctx.answerCallbackQuery({ text: 'Unknown promote sub-action', show_alert: true });
  }
  const project = rest[1];
  if (!project) return ctx.answerCallbackQuery({ text: 'Bad promote callback', show_alert: true });

  await ctx.answerCallbackQuery({ text: 'Promoting…' });
  try {
    const projDir = path.join(PROJECTS_DIR, project);
    const { promoteAuditToBugs } = await import('../lib/audit-promote.js');
    const promo = await promoteAuditToBugs({ projDir, projectName: project });

    if (!promo.promoted) {
      return ctx.reply(
        `✗ ${sanitizeForTelegram(promo.reason)}`,
        { parse_mode: 'HTML' },
      );
    }
    return ctx.reply(
      `✓ Promoted audit for <b>${sanitizeForTelegram(project)}</b> → ` +
      `<code>bug-rounds/round-${promo.round}/bugs.md</code>\n\n` +
      `${promo.warning ? `⚠ ${sanitizeForTelegram(promo.warning)}\n\n` : ''}` +
      `<b>Next:</b> review the file on the Mac, strip any false positives (~20-30% typical), ` +
      `then run <code>/run ${sanitizeForTelegram(project)} bugs</code>.`,
      { parse_mode: 'HTML' },
    );
  } catch (err) {
    return ctx.reply(`✗ Promote failed: ${sanitizeForTelegram(err.message)}`, { parse_mode: 'HTML' });
  }
}

// ─── /qa_handoff <project> ──────────────────────────────────────────────────
//
// Generate the tester-facing markdown and DM it as a file. The CLI version
// has many flags (--with-steps, --round N, --phase range); the Telegram
// version takes the safe defaults and is one-shot.

export const handleQaHandoff = requireAuth(async (ctx) => {
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  const project = await resolveProject(ctx, args);
  if (!project) return;

  await ctx.reply(`📋 Generating QA handoff for <b>${sanitizeForTelegram(project)}</b>…`, { parse_mode: 'HTML' });
  try {
    const { generateQaHandoff } = await import('../commands/qa-handoff.js');
    const result = await generateQaHandoff(project, { withSteps: true });
    const outPath = result?.outputPath || result?.path;
    if (!outPath) {
      return ctx.reply(`✗ QA handoff generated nothing returnable. Check the Mac logs.`);
    }
    return ctx.replyWithDocument({ path: outPath }, {
      caption: `QA handoff — ${project}`,
    });
  } catch (err) {
    return ctx.reply(`✗ QA handoff failed: ${sanitizeForTelegram(err.message)}`, { parse_mode: 'HTML' });
  }
});

// ─── /validate <project> ────────────────────────────────────────────────────
//
// Runs registered validators against the current workspace. The CLI supports
// --phase N / --fix R.N / --all; on Telegram we expose --all because it's the
// most useful "run everything you've got" semantics for a phone-driven sanity
// check. Power users keep the CLI flags.

export const handleValidate = requireAuth(async (ctx) => {
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  const project = await resolveProject(ctx, args);
  if (!project) return;

  await ctx.reply(`🧪 Running validators for <b>${sanitizeForTelegram(project)}</b>…`, { parse_mode: 'HTML' });
  try {
    const { runValidators } = await import('../lib/validators.js');
    const result = await runValidators({
      projectName: project,
      event: { always: true },
      silent: true,
    });
    if (!result || !result.results || result.results.length === 0) {
      return ctx.reply(`No validators configured or matched for <b>${sanitizeForTelegram(project)}</b>.`, { parse_mode: 'HTML' });
    }
    const lines = [`<b>🧪 Validator results — ${sanitizeForTelegram(project)}</b>`, ''];
    for (const r of result.results) {
      const sym = r.exit_code === 0 ? '✓' : '✗';
      const dur = r.duration_ms ? `${Math.round(r.duration_ms / 1000)}s` : '—';
      lines.push(`${sym} <b>${sanitizeForTelegram(r.validator_name)}</b> (${dur})`);
      if (r.exit_code !== 0 && r.stderr) {
        lines.push(`  <code>${sanitizeForTelegram(truncate(r.stderr, 300))}</code>`);
      }
    }
    return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  } catch (err) {
    return ctx.reply(`✗ Validate failed: ${sanitizeForTelegram(err.message)}`, { parse_mode: 'HTML' });
  }
});

// ─── /validators <project> ──────────────────────────────────────────────────
//
// Show recent validator runs for a project (read-only history view).

export const handleValidators = requireAuth(async (ctx) => {
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  const project = await resolveProject(ctx, args);
  if (!project) return;
  try {
    const { getRecentValidatorRuns } = await import('../lib/validators.js');
    const rows = getRecentValidatorRuns(project, 15);
    if (!rows || rows.length === 0) {
      return ctx.reply(`No validator runs recorded for <b>${sanitizeForTelegram(project)}</b>.`, { parse_mode: 'HTML' });
    }
    const lines = [`<b>🧪 Recent validators — ${sanitizeForTelegram(project)}</b>`, ''];
    for (const r of rows) {
      const sym = r.exit_code === 0 ? '✓' : '✗';
      const where = r.phase != null ? `phase ${r.phase}` : r.fix_round != null ? `r${r.fix_round}.${r.fix_n}` : '—';
      const dur = r.duration_ms ? `${Math.round(r.duration_ms / 1000)}s` : '—';
      lines.push(`${sym} <code>${sanitizeForTelegram(r.validator_name)}</code> ${sanitizeForTelegram(where)} <i>${dur}</i>`);
    }
    return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  } catch (err) {
    return ctx.reply(`✗ Validators query failed: ${sanitizeForTelegram(err.message)}`, { parse_mode: 'HTML' });
  }
});

// ─── /dashboard ─────────────────────────────────────────────────────────────
//
// Generate the orchestrator-wide HTML telemetry dashboard and DM as a file.
// No project arg — it's a cross-project view. Read-only.

export const handleDashboard = requireAuth(async (ctx) => {
  await ctx.reply(`📊 Generating dashboard…`);
  try {
    const { generateDashboard } = await import('../commands/dashboard.js');
    const result = await generateDashboard({});
    const outPath = result?.outputPath || result?.path;
    if (!outPath) return ctx.reply(`✗ Dashboard returned no output path. Check Mac logs.`);
    return ctx.replyWithDocument({ path: outPath }, {
      caption: `Orchestrator dashboard — open the .html in a browser`,
    });
  } catch (err) {
    return ctx.reply(`✗ Dashboard failed: ${sanitizeForTelegram(err.message)}`, { parse_mode: 'HTML' });
  }
});

// ─── /coach [project] ──────────────────────────────────────────────────────
//
// State-aware "what should I do next?" suggestion. Looks at the entire
// current state of a project (file existence, SQLite state, inbox counts)
// and returns a single ranked recommendation as a sentence + buttons.
// Designed for "I forgot where I was" recovery.

export const handleCoach = requireAuth(async (ctx) => {
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  const project = await resolveProject(ctx, args);
  if (!project) return;

  try {
    const { getCoachView } = await import('../lib/coach.js');
    const view = await getCoachView(project);

    if (view.type === 'single') {
      const s = view;
      const kb = new InlineKeyboard();
      for (const b of s.buttons) kb.text(b.label, b.callback).row();
      const lines = [
        `<b>📍 ${sanitizeForTelegram(s.headline)}</b>`,
        '',
        `→ ${sanitizeForTelegram(s.suggestion)}`,
      ];
      if (s.why) {
        lines.push('');
        lines.push(`<i>Why: ${sanitizeForTelegram(s.why)}</i>`);
      }
      return ctx.reply(lines.join('\n'), {
        parse_mode: 'HTML',
        reply_markup: s.buttons.length ? kb : undefined,
      });
    }

    // type === 'multi'
    const kb = new InlineKeyboard();
    const sectionBlocks = [];

    for (const sec of view.sections) {
      const headerLine = `${sec.emoji} <b>${sanitizeForTelegram(sec.name)} — ${sec.count} pending</b>`;
      const previewLine = sanitizeForTelegram(sec.preview);
      sectionBlocks.push(`${headerLine}\n${previewLine}`);
      for (const b of sec.buttons) {
        kb.text(b.label, b.callback).row();
      }
    }

    let messageText = sectionBlocks.join('\n\n');

    // Length guard — Telegram rejects messages over 4096 chars; degrade gracefully.
    const HARD_LIMIT = 4000;

    if (messageText.length > HARD_LIMIT) {
      // Step 1: drop previews, keep only headers
      const headersOnly = view.sections.map(
        (sec) => `${sec.emoji} <b>${sanitizeForTelegram(sec.name)} — ${sec.count} pending</b>`,
      );
      messageText = headersOnly.join('\n');
    }

    if (messageText.length > HARD_LIMIT) {
      // Step 2: truncate trailing sections and note the count
      const shown = [];
      let len = 0;
      for (const line of messageText.split('\n')) {
        if (len + line.length + 1 > HARD_LIMIT - 20) break;
        shown.push(line);
        len += line.length + 1;
      }
      const omitted = view.sections.length - shown.length;
      if (omitted > 0) shown.push(`…(${omitted} more stream${omitted > 1 ? 's' : ''})`);
      messageText = shown.join('\n');
    }

    return ctx.reply(messageText, {
      parse_mode: 'HTML',
      reply_markup: kb,
    });
  } catch (err) {
    return ctx.reply(`✗ Coach failed: ${sanitizeForTelegram(err.message)}`, { parse_mode: 'HTML' });
  }
});

// ─── /package <project> ─────────────────────────────────────────────────────
//
// Zip a project (workspace + .guide) for download/sharing. Different from
// /download which DMs job logs.

export const handlePackage = requireAuth(async (ctx) => {
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  const project = await resolveProject(ctx, args);
  if (!project) return;

  await ctx.reply(`📦 Packaging <b>${sanitizeForTelegram(project)}</b>…`, { parse_mode: 'HTML' });
  try {
    const { packageProject } = await import('../commands/package-project.js');
    const result = await packageProject({ projectName: project, quiet: true });
    const outPath = result?.outputPath || result?.zipPath || result?.path;
    if (!outPath) return ctx.reply(`✗ Package returned no path.`);
    // Discord has an 8 MB bot upload cap. Surface size and bail gracefully.
    const stat = await fs.stat(outPath);
    if (stat.size > 8 * 1024 * 1024) {
      return ctx.reply(
        `⚠ Zip is ${(stat.size / 1024 / 1024).toFixed(1)} MB — over Discord's 8 MB upload limit.\n` +
        `Find it on the Mac at: <code>${sanitizeForTelegram(outPath)}</code>`,
        { parse_mode: 'HTML' },
      );
    }
    return ctx.replyWithDocument({ path: outPath }, {
      caption: `${project} — packaged zip`,
    });
  } catch (err) {
    return ctx.reply(`✗ Package failed: ${sanitizeForTelegram(err.message)}`, { parse_mode: 'HTML' });
  }
});

// ─── /extend <project> ──────────────────────────────────────────────────────
//
// v0.14.28: interactive decision tree for "I want to add new work to an
// existing project." Bridges the three real paths (refinements / new phases /
// new project) that previously required the user to know which to pick.
//
// Why this exists: a recurring confusion is that adding requirements via
// /req_promote --plan doesn't necessarily grow the phase count — the model
// often folds new reqs into existing phases or treats them as refinements.
// When the project is already at current_phase == total_phases, the folded
// work never runs. /extend surfaces this honestly and routes the user to
// the path that actually matches their situation.
//
// Callback prefixes used:
//   extend:bugs:<project>      — same as bug:start:<project> (capture mode)
//   extend:phases:<project>    — show "edit brief + regenerate" instructions
//   extend:regen:<project>     — queue a `guide` job after brief edit
//   extend:newproj:<project>   — show /new_project instructions
//   extend:help:<project>      — show decision-tree text

export const handleExtend = requireAuth(async (ctx) => {
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  const project = await resolveProject(ctx, args);
  if (!project) return;

  const p = getProject(project);
  if (!p) {
    return ctx.reply(`Project not found: <code>${sanitizeForTelegram(project)}</code>`, { parse_mode: 'HTML' });
  }

  const planPhases = p.total_phases || 0;
  const currentPhase = p.current_phase || 0;
  const phaseStatus = planPhases === 0
    ? 'no plan yet — run guide first'
    : currentPhase >= planPhases
      ? `${currentPhase}/${planPhases} (complete)`
      : `${currentPhase}/${planPhases} (mid-build)`;

  const lines = [
    `<b>🔧 Extend ${sanitizeForTelegram(project)}</b>`,
    '',
    `<i>Current state: ${sanitizeForTelegram(phaseStatus)}</i>`,
    '',
    `What kind of new work do you want to add?`,
  ];

  const kb = new InlineKeyboard()
    .text('🐛 Small refinements / QA fixes', `extend:bugs:${project}`).row()
    .text('📈 New features (extend this project)', `extend:phases:${project}`).row()
    .text('🆕 Big new direction (new project)', `extend:newproj:${project}`).row()
    .text('❓ Help me decide', `extend:help:${project}`).row();

  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb });
});

/**
 * Handles all extend:<sub>:<project> callbacks. Called from the central
 * dispatcher in discord-handlers.js.
 */
export async function handleExtendCallback(ctx, rest) {
  const sub = rest[0];
  const project = rest.slice(1).join(':');
  const userId = ctx.from?.id;

  if (sub === 'bugs') {
    // Activate bug-capture mode — same effect as the bug:start callback.
    const { setCaptureMode } = await import('../state.js');
    if (!getProject(project)) {
      return ctx.answerCallbackQuery({ text: 'Project not found', show_alert: true });
    }
    setCaptureMode(userId, project, 'bug');
    await ctx.answerCallbackQuery({ text: 'Bug capture ON' });
    return ctx.reply(
      `🔴 <b>Bug capture mode ON for ${sanitizeForTelegram(project)}.</b>\n\n` +
      `Send each refinement / fix as a separate message. Optional prefix:\n` +
      `  <code>critical: login redirects in loop</code>\n` +
      `  <code>major: settings page slow to save</code>\n` +
      `  <code>minor: tooltip alignment off</code>\n\n` +
      `When done capturing: send <code>/bug_done</code>, then ` +
      `<code>/bug_promote ${sanitizeForTelegram(project)}</code> to run the fix round.`,
      { parse_mode: 'HTML' },
    );
  }

  if (sub === 'phases') {
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard()
      .text('♻️ Brief updated — regenerate plan now', `extend:regen:${project}`).row()
      .text('✗ Cancel', 'confirm-no').row();
    return ctx.reply(
      `<b>📈 Extending ${sanitizeForTelegram(project)} with new phases</b>\n\n` +
      `New phases get added when the brief describes <i>new functional surface ` +
      `area</i> — files/screens/endpoints/modules that don't exist yet. The ` +
      `model won't grow the plan for refinements (those are the bugs path).\n\n` +
      `<b>Two ways to update the brief:</b>\n\n` +
      `<b>A) Telegram-only</b> — capture each new feature with <code>/req</code>:\n` +
      `  <code>/req ${sanitizeForTelegram(project)} Build notifications-v2 service. ` +
      `Email + push, retry with backoff, SQLite delivery log.</code>\n` +
      `  <code>/req ${sanitizeForTelegram(project)} Add multi-tenant support. ` +
      `Each user belongs to an org; data scoped per org.</code>\n\n` +
      `  When done: <code>/req_promote ${sanitizeForTelegram(project)} --plan</code> ` +
      `(this regenerates brief.md and plan.json together).\n\n` +
      `<b>B) Mac edit</b> — directly edit ` +
      `<code>projects/${sanitizeForTelegram(project)}/.guide/brief.md</code>. ` +
      `Add each feature as its own <code>##</code> heading with 2-3 sentences ` +
      `describing the new functional surface. Then tap the button below to ` +
      `queue a fresh guide run.\n\n` +
      `<i>After regen, I'll compare phase counts. If the new plan grew, ` +
      `<code>/run ${sanitizeForTelegram(project)} go</code> picks up from phase ${(getProject(project)?.current_phase || 0) + 1}.</i>`,
      { parse_mode: 'HTML', reply_markup: kb },
    );
  }

  if (sub === 'regen') {
    // Path B from the phases path — user edited brief on Mac, now wants to
    // queue a guide regen. After regen, user uses /preview to see phase
    // count and /predict to confirm new work is queueable.
    const { enqueueJob } = await import('./job-queue.js');
    if (!getProject(project)) {
      return ctx.answerCallbackQuery({ text: 'Project not found', show_alert: true });
    }
    await ctx.answerCallbackQuery({ text: 'Queueing guide regen…' });

    // Snapshot old phase count so the follow-up message can mention it.
    const planPath = path.join(PROJECTS_DIR, project, '.guide', 'plan.json');
    let oldPhases = 0;
    try {
      const plan = JSON.parse(await fs.readFile(planPath, 'utf-8'));
      oldPhases = plan?.phases?.length || 0;
    } catch { /* no prior plan */ }

    const jobId = enqueueJob({
      project,
      action: 'guide',
      args: { task: 'plan' },
      requestedBy: userId,
    });

    return ctx.reply(
      `✓ Queued: <code>guide ${sanitizeForTelegram(project)}</code> (job #${jobId})\n` +
      `<i>Current plan has ${oldPhases} phases. After regen, check the new count:</i>\n\n` +
      `  <code>/preview ${sanitizeForTelegram(project)} plan</code> — read the new plan\n` +
      `  <code>/predict ${sanitizeForTelegram(project)}</code> — see if there's new work to run\n\n` +
      `If the new plan grew, <code>/run ${sanitizeForTelegram(project)} go</code> picks up ` +
      `from phase ${(getProject(project)?.current_phase || 0) + 1}.\n` +
      `If it didn't grow, the new reqs got folded into existing phases — use the ` +
      `bugs path instead.`,
      { parse_mode: 'HTML' },
    );
  }

  if (sub === 'newproj') {
    await ctx.answerCallbackQuery();
    const inferredV2 = `${project}-v2`;
    return ctx.reply(
      `<b>🆕 Spin up a new project</b>\n\n` +
      `If reqs are fundamentally different architecture, dataset, or user-base ` +
      `from <code>${sanitizeForTelegram(project)}</code>, a separate project is the right ` +
      `move. Same repo, fresh slate.\n\n` +
      `<b>One command:</b>\n` +
      `  <code>/new_project ${sanitizeForTelegram(inferredV2)} ` +
      `git@github.com:&lt;you&gt;/${sanitizeForTelegram(project)}.git</code>\n\n` +
      `<i>Tip: add <code>--branch v2</code> to start on a different branch ` +
      `(otherwise it clones <code>main</code>).</i>\n\n` +
      `After it's created, capture reqs the normal way:\n` +
      `  <code>/req ${sanitizeForTelegram(inferredV2)} &lt;each feature&gt;</code>\n` +
      `  <code>/req_promote ${sanitizeForTelegram(inferredV2)} --plan</code>\n` +
      `  <code>/run ${sanitizeForTelegram(inferredV2)} go</code>`,
      { parse_mode: 'HTML' },
    );
  }

  if (sub === 'help') {
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard()
      .text('🐛 Use bugs path', `extend:bugs:${project}`).row()
      .text('📈 Use phases path', `extend:phases:${project}`).row()
      .text('🆕 Use new-project path', `extend:newproj:${project}`).row();
    return ctx.reply(
      `<b>❓ Quick decision tree</b>\n\n` +
      `<b>If you wouldn't open a PR for it</b> (it's a behaviour fix to ` +
      `something that already works):\n` +
      `  → 🐛 <b>Bugs path.</b> Capture as bug, run fix round.\n\n` +
      `<b>If you'd open a new file</b> (a new screen, endpoint, module, ` +
      `feature that doesn't exist yet):\n` +
      `  → 📈 <b>Phases path.</b> Update brief with new functional surface, ` +
      `regenerate plan.\n\n` +
      `<b>If you'd open a new repo</b> (different architecture, users, or ` +
      `core technology):\n` +
      `  → 🆕 <b>New project path.</b>\n\n` +
      `<b>Edge cases:</b>\n` +
      `• "Make X faster" → bugs (performance is a property of existing code)\n` +
      `• "Add a settings page" → phases (new UI surface)\n` +
      `• "Replace REST with GraphQL" → likely new project (architectural)\n` +
      `• "Add dark mode" → phases if it's pervasive UI, bugs if 2-3 components\n` +
      `• "Add multi-tenancy" → new project (touches data model + auth + every read)`,
      { parse_mode: 'HTML', reply_markup: kb },
    );
  }

  return ctx.answerCallbackQuery({ text: `Unknown extend sub-action: ${sub}` });
}

// ─── /brief_questions <project> ─────────────────────────────────────────────
//
// Shows .guide/brief-questions.md with an unresolved-marker count, plus
// action buttons to re-run the brief-author or view brief.md. When all
// questions are answered (no [NEEDS USER INPUT] markers remain), offers a
// direct "Start planning (go)" button so the user can kick off auto-run
// without leaving Telegram.

export const handleBriefQuestions = requireAuth(async (ctx) => {
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  const project = await resolveProject(ctx, args);
  if (!project) return;

  const projDir = path.join(PROJECTS_DIR, project);

  let questionsText = null;
  try {
    questionsText = await fs.readFile(briefQuestionsPath(projDir), 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Check if brief.md exists to give a more helpful message
      let hasBrief = false;
      try { await fs.access(briefPath(projDir)); hasBrief = true; } catch { /* missing */ }
      const msg = hasBrief
        ? `<b>${sanitizeForTelegram(project)}</b>: No <code>brief-questions.md</code> yet.\n\nThe brief looks complete — no open questions were generated.\n\nRun <code>/run ${sanitizeForTelegram(project)} go</code> to start planning.`
        : `<b>${sanitizeForTelegram(project)}</b>: No <code>brief-questions.md</code> or <code>brief.md</code> found.\n\nAdd your raw thoughts to <code>.guide/raw-thoughts.md</code>, then run:\n<code>/run ${sanitizeForTelegram(project)} brief</code>`;
      const kb = new InlineKeyboard()
        .text('📝 Run brief-author', `act:${project}:brief`);
      if (hasBrief) kb.row().text('▶ Go (start planning)', `run:a:${project}:go`);
      return ctx.reply(msg, { parse_mode: 'HTML', reply_markup: kb });
    }
    return ctx.reply(`Error reading brief-questions.md: ${sanitizeForTelegram(err.message)}`, { parse_mode: 'HTML' });
  }

  const unresolved = (questionsText.match(/\[NEEDS USER INPUT[^\]]*\]/g) || []).length;
  const statusLine = unresolved > 0
    ? `⚠️ <b>${unresolved} unresolved section(s)</b> — answer these before running <code>go</code>`
    : `✅ All questions answered — brief is plan-ready`;

  const header = `❓ <b>Brief questions — ${sanitizeForTelegram(project)}</b>\n${statusLine}\n\n`;

  const kb = new InlineKeyboard()
    .text('📄 View brief.md', `preview:${project}:brief`)
    .text('📝 Re-run brief-author', `act:${project}:brief`);
  if (unresolved === 0) {
    kb.row().text('▶ Start planning (go)', `run:a:${project}:go`);
  }

  const body = truncate(questionsText.trim(), 3400);
  return ctx.reply(header + sanitizeForTelegram(body), { parse_mode: 'HTML', reply_markup: kb });
});

// ─── /remove_project <project> ──────────────────────────────────────────────
//
// Removes a project from the orchestrator: deletes all DB rows and the
// projects/<name>/ directory from disk. Confirmation required.

export const handleRemoveProject = requireAuth(async (ctx) => {
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  const project = await resolveProject(ctx, args);
  if (!project) return;

  const kb = new InlineKeyboard()
    .text('Yes, remove it', `rmproj:y:${project}`)
    .text('Cancel', 'rmproj:n');

  return ctx.reply(
    `⚠ <b>Remove project ${sanitizeForTelegram(project)}?</b>\n\n` +
    `This deletes all DB rows (phases, sessions, bugs, requirements, healing log) ` +
    `<b>and</b> the <code>projects/${sanitizeForTelegram(project)}/</code> directory from disk.\n\n` +
    `This cannot be undone. Are you sure?`,
    { parse_mode: 'HTML', reply_markup: kb },
  );
});

export async function handleRemoveProjectCallback(ctx, rest) {
  if (rest[0] === 'n') {
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    return ctx.reply('Cancelled.');
  }
  if (rest[0] === 'y') {
    const project = rest.slice(1).join(':');
    if (!project) {
      return ctx.answerCallbackQuery({ text: 'Bad remove callback', show_alert: true });
    }
    await ctx.answerCallbackQuery({ text: 'Removing…' });
    try {
      const { removeProject } = await import('../commands/remove-project.js');
      const result = await removeProject({ name: project });
      const note = result.filesDeleted
        ? `\nDirectory <code>projects/${sanitizeForTelegram(project)}/</code> deleted.`
        : result.filesError
          ? `\n⚠ Files not deleted: ${sanitizeForTelegram(result.filesError)}`
          : '';
      return ctx.reply(
        `✓ Project <b>${sanitizeForTelegram(project)}</b> removed. All DB rows deleted.${note}`,
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      return ctx.reply(`✗ Remove failed: ${sanitizeForTelegram(err.message)}`, { parse_mode: 'HTML' });
    }
  }
  return ctx.answerCallbackQuery({ text: 'Unknown sub-action', show_alert: true });
}

// ─── /suggest inline-keyboard flow ──────────────────────────────────────────
//
// sug:type:<cli|…>       Step 0: type override when projectType==='unknown'
// sug:cat:<value>        Step 1 → 2: category toggle or done
// sug:item:<n>           Step 2: suggestion toggle
// sug:confirm:sel        Step 2 → 3: confirm selections
// sug:passes:<n>         Step 3 → 4: pass count selection
// sug:confirm:y          Step 4: save plan
// sug:cancel             Any step: cancel and clear session


function _buildCategoryKb(selectedCats, catQ, noLm = false) {
  const kb = new InlineKeyboard();
  catQ.options.forEach((opt, i) => {
    const glyph = selectedCats.includes(opt.value) ? '✅' : '⬜';
    kb.text(`${glyph} ${opt.label}`, `sug:cat:${opt.value}`);
    if (i % 2 === 1) kb.row();
  });
  if (catQ.options.length % 2 !== 0) kb.row();
  kb.text(noLm ? '⚙️ Rules only ✓' : '⚙️ Rules only', 'sug:nolm').row()
    .text('✅ Done', 'sug:cat:done').row()
    .text('❌ Cancel', 'sug:cancel');
  return kb;
}

export function _buildItemKb(filtered, selectedIdxs) {
  const effortBadge = { small: 'S', medium: 'M', large: 'L' };
  const kb = new InlineKeyboard();
  filtered.forEach((s, i) => {
    const glyph  = selectedIdxs.has(i) ? '✅' : '⬜';
    const badge  = effortBadge[s.effort] ?? '?';
    const title  = s.title.length > 22 ? s.title.slice(0, 21) + '…' : s.title;
    kb.text(`${glyph} ${title} · ${badge}`, `sug:item:${i}`);
    if (i % 2 === 1) kb.row();
  });
  if (filtered.length % 2 !== 0) kb.row();
  kb.text('✅ Confirm selections', 'sug:confirm:sel').row()
    .text('❌ Cancel', 'sug:cancel');
  return kb;
}

function _sugItemSummary(filtered) {
  return filtered.map((s, i) => `${i + 1}. ${s.title}`).join('\n');
}


async function _sugHandleCat(ctx, value, session, chatId) {
  if (value === 'done' && session.scanning) {
    return ctx.answerCallbackQuery({ text: 'Scan already in progress…', show_alert: true });
  }

  await ctx.answerCallbackQuery();
  if (value === 'done') {
    session.scanning = true;
    try {
      await ctx.editMessageText(
        session.noLm ? '⚙️ Running rules engine…' : '🤖 Asking Claude to analyse your project…',
      );

      let allSuggestions;
      let aiScanFailed = false;
      if (!session.noLm) {
        const previousTitles = getEarlierSuggestionTitles(session.projectName);
        const { resolve: resolveConfig } = await import('../config-resolver.js');
        const cfg = await resolveConfig({ project: session.projectName, task: 'suggest-scan' });
        const projDir = path.join(PROJECTS_DIR, session.projectName);
        try {
          allSuggestions = await generateAISuggestions(
            session.snapshot, session.goal, session.categories, cfg, previousTitles, {}, session.projectName, projDir,
          );
        } catch (err) {
          console.error(`[suggest-scan] AI failed for ${session.projectName}: ${err.message}`);
          allSuggestions = generateSuggestions(session.snapshot);
          aiScanFailed = true;
        }
      } else {
        allSuggestions = generateSuggestions(session.snapshot);
      }

      session.allSuggestions = allSuggestions;
      // AI path: do NOT filter by category — selection UI is the gate (matches CLI/Web).
      // Rules fallback (including noLm): filter by categories to narrow a large deterministic list.
      const toShow = (!aiScanFailed && !session.noLm)
        ? allSuggestions
        : (session.categories.length > 0
            ? filterSuggestions(allSuggestions, session.categories)
            : allSuggestions);
      const totalCount = toShow.length;
      const filtered = toShow.slice(0, ITEM_CAP);

      if (filtered.length === 0) {
        suggestSessions.delete(chatId);
        return ctx.editMessageText(
          '⚠️ No suggestions found. Try again with broader filters.\n/suggest ' + session.projectName,
        );
      }

      session.filtered   = filtered;
      session.manualItems = [];
      session.step = 3;

      const kb = new InlineKeyboard()
        .text('➕ Add custom item', 'sug:manual:add').row()
        .text('✅ Continue to selection', 'sug:manual:done').row()
        .text('❌ Cancel', 'sug:cancel');

      await ctx.editMessageText(
        `🔍 Found ${filtered.length} suggestion${filtered.length !== 1 ? 's' : ''}.`
        + (aiScanFailed ? '\n⚠️ AI unavailable — showing rules-based suggestions.' : '')
        + (session.noLm && !aiScanFailed ? '\n⚙️ Rules engine used (AI skipped).' : '')
        // AI areas are advisory: show a hint when the user narrowed focus but AI may return items outside it.
        + (!aiScanFailed && !session.noLm && session.categories.length > 0 && session.categories.length < 5
            ? '\nℹ️ AI results may include items outside selected areas (areas are advisory).'
            : '')
        + (totalCount > filtered.length ? `\n⚠️ Showing ${filtered.length} of ${totalCount} — use CLI or Web to see all.` : '')
        + '\n\nWant to add custom items before selecting?',
        { reply_markup: kb },
      );
    } finally {
      session.scanning = false;
    }
  } else {
    const cats = session.categories;
    const idx  = cats.indexOf(value);
    if (idx >= 0) cats.splice(idx, 1);
    else cats.push(value);

    const catQ = QUESTIONS.find(q => q.id === 'areas');
    const kb   = _buildCategoryKb(cats, catQ, session.noLm);
    await ctx.editMessageText(
      `${catQ.text}\n(tap to toggle, then Done)`,
      { reply_markup: kb },
    );
  }
}

async function _sugHandleManual(ctx, sub, session) {
  if (sub === 'add') {
    await ctx.answerCallbackQuery();
    session.awaitingInput = 'manual';
    const count = session.manualItems.length;
    const header = count > 0
      ? `${count} custom item${count !== 1 ? 's' : ''} added so far.\n\n`
      : '';
    await ctx.editMessageText(
      `${header}Type your custom item description.\nTip: append [effort/impact] e.g. "Add dark mode [small/high]"\n\nTap Done when finished.`,
      { reply_markup: new InlineKeyboard().text('✅ Done adding', 'sug:manual:done') },
    );
    return;
  }
  if (sub === 'done') {
    await ctx.answerCallbackQuery();
    session.awaitingInput = null;
    // Prepend manual items so they appear first; indices are now stable for step 3.
    // Clear manualItems after merge so a re-tap of Done is idempotent (no re-prepend).
    const merged         = [...session.manualItems, ...session.filtered];
    session.filtered     = merged.slice(0, ITEM_CAP);
    const droppedByManualCap = merged.length > session.filtered.length;
    session.manualItems  = [];
    session.selectedIdxs = new Set();

    const kb = _buildItemKb(session.filtered, session.selectedIdxs);
    await ctx.editMessageText(
      `Select suggestions (tap to toggle):\n${_sugItemSummary(session.filtered)}`
      + (droppedByManualCap ? `\n⚠️ Showing ${session.filtered.length} of ${merged.length} — use CLI or Web to see all.` : ''),
      { reply_markup: kb },
    );
    return;
  }
  await ctx.answerCallbackQuery();
}

async function _sugHandleItem(ctx, idxStr, session) {
  const idx = parseInt(idxStr, 10);
  if (isNaN(idx) || idx < 0 || idx >= session.filtered.length) {
    return ctx.answerCallbackQuery();
  }

  await ctx.answerCallbackQuery();

  if (session.selectedIdxs.has(idx)) session.selectedIdxs.delete(idx);
  else session.selectedIdxs.add(idx);

  const kb = _buildItemKb(session.filtered, session.selectedIdxs);
  await ctx.editMessageText(
    `Select suggestions (tap to toggle):\n${_sugItemSummary(session.filtered)}`,
    { reply_markup: kb },
  );
}

async function _sugHandleConfirm(ctx, subValue, session, chatId) {
  if (subValue === 'sel') {
    if (session.selectedIdxs.size === 0) {
      return ctx.answerCallbackQuery({ text: 'Select at least one suggestion.' });
    }
    await ctx.answerCallbackQuery();
    session.step = 4;
    const passesQ = QUESTIONS.find(q => q.id === 'passes');
    const kb = new InlineKeyboard()
      .text('1x', 'sug:passes:1')
      .text('2x', 'sug:passes:2')
      .text('3x', 'sug:passes:3').row()
      .text('4x', 'sug:passes:4')
      .text('5x', 'sug:passes:5').row()
      .text('❌ Cancel', 'sug:cancel');
    await ctx.editMessageText(passesQ.text, { reply_markup: kb });
    return;
  }

  if (subValue === 'y') {
    await ctx.answerCallbackQuery();
    const selected = [...session.selectedIdxs].map(i => session.filtered[i]).filter(Boolean);
    try {
      const { writeSuggestionsFile } = await import('../commands/suggest.js');
      const { saveSuggestions, acceptSuggestions, staleAllSuggestions: _stale } = await import('../state.js');

      _stale(session.projectName);
      const id = saveSuggestions(session.projectName, {
        projectType:  session.snapshot.projectType,
        scanSnapshot: session.snapshot,
        suggestions:  session.filtered,
      });
      acceptSuggestions(id, {
        selected:       selected,
        pipelinePlan:   session.pipelinePlan,
        pipelinePasses: session.passes,
      });
      await writeSuggestionsFile(
        session.projDir,
        session.projectName,
        selected,
        session.pipelinePlan,
        session.passes,
      );
    } catch (err) {
      suggestSessions.delete(chatId);
      return ctx.editMessageText(`❌ Failed to save plan: ${err.message}`);
    }

    const plan = session.pipelinePlan;
    const selectedItems = [...session.selectedIdxs].map(i => session.filtered[i]);
    const total = selectedItems.length;
    const passes = session.passes;

    let lines = `✅ Plan saved — ${session.projectName} (${passes} pass${passes > 1 ? 'es' : ''}, ${total} items)\n`;
    for (let p = 1; p <= passes; p++) {
      const ids    = plan[String(p)] || [];
      const titles = ids.map(id => selectedItems.find(s => s.id === id)?.title ?? id);
      lines += `\nPass ${p}: ${titles.join(', ')}`;
    }
    lines += `\n\n/run ${session.projectName} to start.`;

    suggestSessions.delete(chatId);
    await ctx.editMessageText(lines);
    return;
  }

  await ctx.answerCallbackQuery();
}

async function _sugHandlePasses(ctx, nStr, session) {
  await ctx.answerCallbackQuery();
  const passes = parseInt(nStr, 10);
  if (![1, 2, 3, 4, 5].includes(passes)) return;

  session.passes = passes;

  const selectedItems = [...session.selectedIdxs].map(i => session.filtered[i]);
  const plan = assignToPasses(selectedItems, passes);
  session.pipelinePlan = plan;
  session.step = 5;

  let preview = `📋 Plan preview — ${passes} pass${passes > 1 ? 'es' : ''}:\n`;
  for (let p = 1; p <= passes; p++) {
    const ids    = plan[String(p)] || [];
    const titles = ids.map(id => selectedItems.find(s => s.id === id)?.title ?? id);
    preview += `\nPass ${p}: ${titles.join(', ')}`;
  }

  const kb = new InlineKeyboard()
    .text('✅ Save plan', 'sug:confirm:y').row()
    .text('❌ Cancel',   'sug:cancel');

  await ctx.editMessageText(preview + '\n\nSave this plan?', { reply_markup: kb });
}

export async function handleSuggestCallback(ctx, rest) {
  const sub     = rest[0];
  const chatId  = ctx.chat.id;
  const presser = ctx.from?.id;                          // who tapped the button
  const session = suggestSessions.get(chatId);

  // ── sug:cancel ────────────────────────────────────────────────────────────
  // Check ownership first (session may exist even for cancel).
  // If session has no userId (edge case), fail open and allow the cancel.
  if (sub === 'cancel') {
    if (session?.userId && presser !== session.userId) {
      return ctx.answerCallbackQuery({ text: 'Not your session.', show_alert: false });
    }
    await ctx.answerCallbackQuery();
    suggestSessions.delete(chatId);
    await ctx.editMessageText('❌ Suggest cancelled.').catch(() => {});
    return;
  }

  if (!session) {
    return ctx.answerCallbackQuery({ text: 'Session expired. Run /suggest again.' });
  }

  // ── Ownership guard ───────────────────────────────────────────────────────
  // session.userId is always set on /suggest start (see discord-handlers.js _baseSession).
  // If it is somehow absent, fail open so the operator is never locked out.
  if (session.userId && presser !== session.userId) {
    return ctx.answerCallbackQuery({ text: 'Not your session.', show_alert: false });
  }

  if (sub === 'type') {
    const chosenType = rest[1];
    if (!['cli', 'frontend', 'api', 'fullstack'].includes(chosenType)) {
      return ctx.answerCallbackQuery({ text: 'Unknown project type', show_alert: true });
    }
    await ctx.answerCallbackQuery();
    session.snapshot.projectType = chosenType;
    session.step = 1;
    session.awaitingInput = 'goal';

    const goalQ = QUESTIONS.find(q => q.id === 'goal');
    await ctx.editMessageText(
      `✅ Type set to: ${_sugTypeLabel(chosenType)}\n\n${goalQ.text}`,
      { reply_markup: _buildGoalKb() },
    );
    return;
  }

  if (sub === 'goal') {
    // sug:goal:skip — skip goal and go directly to category selection
    await ctx.answerCallbackQuery();
    session.goal = '';
    session.awaitingInput = null;
    session.step = 2;
    const catQ = QUESTIONS.find(q => q.id === 'areas');
    const kb   = _buildCategoryKb(session.categories, catQ, session.noLm);
    await ctx.editMessageText(`${catQ.text}\n(tap to toggle, then Done)`, { reply_markup: kb });
    return;
  }
  if (sub === 'nolm') {
    await ctx.answerCallbackQuery();
    session.noLm = !session.noLm;
    const catQ = QUESTIONS.find(q => q.id === 'areas');
    const kb   = _buildCategoryKb(session.categories, catQ, session.noLm);
    await ctx.editMessageText(`${catQ.text}\n(tap to toggle, then Done)`, { reply_markup: kb });
    return;
  }
  if (sub === 'cat')     return _sugHandleCat(ctx, rest[1], session, chatId);
  if (sub === 'manual')  return _sugHandleManual(ctx, rest[1], session);
  if (sub === 'item')    return _sugHandleItem(ctx, rest[1], session);
  if (sub === 'confirm') return _sugHandleConfirm(ctx, rest[1], session, chatId);
  if (sub === 'passes')  return _sugHandlePasses(ctx, rest[1], session);

  await ctx.answerCallbackQuery();
}

/**
 * Called from handleMessage when session.awaitingInput === 'goal'.
 * Stores the typed goal and transitions directly to category selection.
 */
export async function handleSuggestGoalInput(ctx, goalText, session) {
  session.goal = goalText;
  session.awaitingInput = null;
  session.step = 2;
  const catQ = QUESTIONS.find(q => q.id === 'areas');
  const kb   = _buildCategoryKb(session.categories, catQ, session.noLm);
  await ctx.reply(`✅ Goal saved: "${goalText.slice(0, 60)}"\n\n${catQ.text}\n(tap to toggle, then Done)`, {
    reply_markup: kb,
  });
}

/**
 * Called from handleMessage when session.awaitingInput === 'manual'.
 * Creates a manual suggestion item and queues it in session.manualItems.
 */
export async function handleSuggestManualInput(ctx, itemText, session) {
  const metaMatch = itemText.match(/\[(\w+)\/(\w+)\]\s*$/);
  const title  = (metaMatch ? itemText.slice(0, metaMatch.index) : itemText).trim().slice(0, 60);
  const effort = metaMatch && ['small', 'medium', 'large'].includes(metaMatch[1]) ? metaMatch[1] : 'medium';
  const impact = metaMatch && ['low', 'medium', 'high'].includes(metaMatch[2])    ? metaMatch[2] : 'high';

  if (!title) return ctx.reply('Item description cannot be empty.');

  if (session.manualItems.length + session.filtered.length >= ITEM_CAP) {
    const maxManual = Math.max(0, ITEM_CAP - session.filtered.length);
    return ctx.reply(
      `✋ All ${ITEM_CAP} suggestion slots are full (${maxManual} custom item${maxManual !== 1 ? 's' : ''} allowed with this scan). Tap Done adding to continue.`,
    );
  }

  const existingIds = new Set([
    ...session.allSuggestions.map(s => s.id),
    ...session.manualItems.map(s => s.id),
  ]);
  const baseId = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 44);
  let id = `manual-${baseId}`;
  let suffix = 1;
  while (existingIds.has(id)) id = `manual-${baseId}-${suffix++}`;

  session.manualItems.push({
    id, type: 'new-feature', category: 'logic',
    title, description: title,
    effort, impact, suggestedSlot: 1,
    appliesTo: ['cli', 'frontend', 'api', 'fullstack', 'unknown'],
    manual: true,
  });

  const count = session.manualItems.length;
  await ctx.reply(`✓ Added: "${title}" [${effort}/${impact}] — ${count} item${count !== 1 ? 's' : ''} total. Keep typing or tap Done adding.`);
}

export { _sugHandleConfirm, _sugHandlePasses, _sugHandleManual, _sugHandleCat }; // exported for unit tests only

// ─── /newbrief callbacks (nb:*) ─────────────────────────────────────────────
//
// nb:go    — reset .guide/brief.md from inputs/ then auto-run the pipeline
//            (fire-and-forget so the callback returns fast).
// nb:show  — DM the full staged inputs/brief.md as a document.
// nb:cancel — dismiss the prompt.
//
// Project name is stored server-side in nbSessions (keyed by chatId) so that
// callback_data stays well under the 64-byte Bot API limit regardless of project
// name length. See fix-r33-2 for context.
export async function handleNewbriefCallback(ctx, rest) {
  const sub    = rest[0];
  const chatId = ctx.chat?.id ?? ctx.from?.id;

  if (sub === 'cancel') {
    nbSessions.delete(chatId);
    await ctx.editMessageText('❌ New brief cancelled — nothing changed.').catch(() => {});
    return;
  }

  // Resolve project from server-side session (never from callback_data).
  const session = nbSessions.get(chatId);
  if (!session?.projectName) {
    return ctx.answerCallbackQuery({
      text: 'Session expired — run /newbrief again.',
      show_alert: true,
    });
  }
  // Ownership guard: only the user who ran /newbrief may drive its buttons — a
  // channel-keyed session is otherwise a single slot any user in the channel can
  // hit (or overwrite). Mirrors the suggest callback ownership check.
  if (session.userId && ctx.from?.id !== session.userId) {
    return ctx.answerCallbackQuery({ text: 'Not your session.', show_alert: false });
  }
  const project = session.projectName;

  if (sub === 'show') {
    await ctx.answerCallbackQuery({ text: 'Loading brief…' });
    const inputsBriefPath = path.join(PROJECTS_DIR, project, 'inputs', 'brief.md');
    try {
      await fs.access(inputsBriefPath);
    } catch {
      return ctx.reply(
        `(no staged brief at inputs/brief.md for ${sanitizeForTelegram(project)})`,
        { parse_mode: 'HTML' },
      );
    }
    // Do NOT delete session here — user may tap 'Reset & run' after reviewing.
    return ctx.replyWithDocument({ path: inputsBriefPath }, {
      caption: `Staged brief — ${project}`,
    });
  }

  if (sub === 'go') {
    // Bug 5 fix: re-validate project still exists in the DB at callback time.
    // The session was set on /newbrief, but the project may have been removed since.
    if (!getProject(project)) {
      await ctx.answerCallbackQuery({ text: 'Project not found', show_alert: true });
      return;
    }

    // Concurrency guard (sync SQLite — must stay before any fire-and-forget).
    // Block if an auto_run OR a tg_job is actively running for this project.
    const activeRun = getActiveAutoRun(project);
    const activeJobs = getRunningJobsForProject(project);
    if (activeRun || activeJobs.length > 0) {
      await ctx.answerCallbackQuery({ text: '⚠ Pipeline already running', show_alert: true });
      await ctx.editMessageText(
        `⚠ Pipeline already running for <b>${escapeHtml(project)}</b>.\nLet it finish or abort it first.`,
        { parse_mode: 'HTML' },
      ).catch(() => {});
      return;
    }

    // Bug 6 fix: pre-flight the async guards that resetBrief will also check.
    // Show "Resetting…" only after all guards pass — so the status is always accurate.
    const inputsBriefPath = path.join(PROJECTS_DIR, project, 'inputs', 'brief.md');
    let inputsContent;
    try {
      inputsContent = await fs.readFile(inputsBriefPath, 'utf-8');
    } catch {
      await ctx.answerCallbackQuery({ text: '❌ No staged brief found', show_alert: true });
      await ctx.editMessageText(
        `❌ No staged brief at <code>inputs/brief.md</code> for <b>${escapeHtml(project)}</b>. Drop one there first.`,
        { parse_mode: 'HTML' },
      ).catch(() => {});
      return;
    }
    if (!inputsContent.trim()) {
      await ctx.answerCallbackQuery({ text: '❌ inputs/brief.md is empty', show_alert: true });
      await ctx.editMessageText(
        `❌ <code>inputs/brief.md</code> is empty for <b>${escapeHtml(project)}</b>.`,
        { parse_mode: 'HTML' },
      ).catch(() => {});
      return;
    }
    const unresolved = inputsContent.match(/\[NEEDS USER INPUT[^\]]*\]/g) || [];
    if (unresolved.length > 0) {
      await ctx.answerCallbackQuery({ text: '❌ Brief has unresolved markers', show_alert: true });
      await ctx.editMessageText(
        `❌ <code>inputs/brief.md</code> for <b>${escapeHtml(project)}</b> has ${unresolved.length} unresolved marker(s) — answer them, then retry.`,
        { parse_mode: 'HTML' },
      ).catch(() => {});
      return;
    }

    // All guards passed — now safe to show "Resetting…" and fire-and-forget.
    nbSessions.delete(chatId);
    await ctx.answerCallbackQuery({ text: 'Resetting brief…' });
    await ctx.editMessageText(
      `🔄 Resetting brief for <b>${escapeHtml(project)}</b> and starting the pipeline…`,
      { parse_mode: 'HTML' },
    ).catch(() => {});
    // Fire-and-forget: resetBrief(go:true) runs the full unattended pipeline,
    // which can take many minutes. Don't await it inside the callback (Telegram
    // would time out the callback query). Surface any remaining guard failures via reply.
    const { resetBrief } = await import('../commands/reset-brief.js');
    resetBrief(project, { go: true, noArchive: false }).catch(async (err) => {
      await ctx.reply(
        `✗ reset-brief failed: ${sanitizeForTelegram(err.message || String(err))}`,
        { parse_mode: 'HTML' },
      ).catch(() => {});
    });
    return;
  }

  return ctx.answerCallbackQuery({ text: 'Unknown newbrief sub-action', show_alert: true });
}

// ─── /addbug <project> <title> ──────────────────────────────────────────────
//
// v0.14.45: create the next manual bugs round in the CORRECT path, atomically.
// The whole asp episode came from a hand-typed heredoc landing in the wrong
// cwd, so the round was never on disk and nothing picked it up. This removes
// the manual-path failure mode entirely: the orchestrator computes the next
// round number, makes projects/<p>/.guide/bug-rounds/round-N/, and writes a
// bugs.md stub with one canonical Bug #1 skeleton (and the title if given).
// Append more bugs by editing that file or calling /addbug again (same round
// until it runs). Then /run <p> go executes it. Never touches the DB.

export const handleAddBug = requireAuth(async (ctx) => {
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  const project = args.shift();
  const title = args.join(' ').trim();
  if (!project || !getProject(project)) {
    return ctx.reply(
      `Usage: <code>/addbug &lt;project&gt; &lt;short title&gt;</code>\n` +
      `Creates the next bugs round in the right place, then run <code>/run ${sanitizeForTelegram(project || '<project>')} go</code>.`,
      { parse_mode: 'HTML' },
    );
  }

  try {
    const { detectHighestBugRound, bugRoundDir, bugsFilePath } = await import('../lib/guide-paths.js');
    const projDir = path.join(PROJECTS_DIR, project);
    const highest = (await detectHighestBugRound(projDir)) || 0;
    const round = highest + 1;
    const dir = bugRoundDir(projDir, round);
    const bugsPath = bugsFilePath(projDir, round);

    // Refuse to clobber an existing round's bugs.md — point the operator at it.
    let exists = false;
    try { await fs.access(bugsPath); exists = true; } catch { /* good — doesn't exist */ }
    if (exists) {
      return ctx.reply(
        `⚠ <b>bugs round ${round}</b> already has a bugs.md.\n` +
        `Edit it (add more <code>### Bug #N</code> entries) or run <code>/run ${sanitizeForTelegram(project)} go</code> to execute it.`,
        { parse_mode: 'HTML' },
      );
    }

    await fs.mkdir(dir, { recursive: true });
    const stub =
`# ${project} — bugs round ${round}

### Bug #1 — ${title || '<one-line title>'}

**Steps to reproduce:** <how to trigger it>
**Expected:** <what should happen — this is the fix's acceptance criterion>
**Actual:** <what happens instead>
**Affected files:** <path/to/file.js[:line-range]>
`;
    await fs.writeFile(bugsPath, stub, 'utf-8');

    const kb = new InlineKeyboard().text(`▶ Run fixes (round ${round})`, `act:${project}:go`);
    return ctx.reply(
      `✅ Created <b>bugs round ${round}</b> at the correct path:\n` +
      `<code>projects/${escapeHtml(project)}/.guide/bug-rounds/round-${round}/bugs.md</code>\n\n` +
      `It has one Bug #1 skeleton${title ? ` titled "${escapeHtml(title)}"` : ''}. ` +
      `Fill in the details (or add more <code>### Bug #N</code> entries), then run the fixes. ` +
      `<code>go</code> will generate the fix plan and execute every bug through the validator gate.`,
      { parse_mode: 'HTML', reply_markup: kb },
    );
  } catch (err) {
    return ctx.reply(`✗ /addbug failed: ${sanitizeForTelegram(err.message)}`, { parse_mode: 'HTML' });
  }
});

// ─── cf:<id>:<nonce>:<optIdx> — requireConfirmation gate (Phase 13) ──────────
//
// Resolves the pending_confirmations row identified by <nonce> to the option at
// <optIdx>. The poll loop in require-confirmation.js sees the resolved row on
// its next tick and returns the chosen option id, unblocking the gated action
// (self-heal edit/push, brief append). The nonce — not the id — is authoritative
// so a stale/forged id can't resolve the wrong row.
//
// Idempotent by construction: resolvePendingConfirmation only updates a row that
// is still 'pending', so a late or double tap (after another tap, after TTL
// expiry, or after the CLI fallback already settled it) is a safe no-op that
// just reflects the existing outcome back to the operator.
export async function handleConfirmCallback(ctx, rest) {
  const nonce = rest[1];
  const optIdx = Number.parseInt(rest[2], 10);
  if (!nonce || !Number.isInteger(optIdx)) {
    return ctx.answerCallbackQuery({ text: 'Bad confirmation callback', show_alert: true });
  }

  const row = getPendingConfirmationByNonce(nonce);
  if (!row) {
    return ctx.answerCallbackQuery({ text: 'This confirmation is no longer valid.', show_alert: true });
  }

  let options = [];
  try { options = JSON.parse(row.options_json); } catch { /* corrupt row — treated as no options below */ }
  const chosen = options[optIdx];
  if (!chosen) {
    return ctx.answerCallbackQuery({ text: 'Unknown option', show_alert: true });
  }

  // Already settled (resolved elsewhere / TTL-expired) — reflect, don't re-resolve.
  if (row.status !== 'pending') {
    await ctx.answerCallbackQuery({ text: 'Already handled.' });
    const prior = options.find((o) => o.id === row.chosen_option);
    const tail = `— <i>Already ${escapeHtml(row.status)}${prior ? `: ${escapeHtml(prior.label)}` : ''}.</i>`;
    try {
      await ctx.editMessageText(`${row.summary}\n\n${tail}`, { parse_mode: 'HTML' });
    } catch { /* message too old / identical / not editable */ }
    return;
  }

  const resolved = resolvePendingConfirmation(nonce, chosen.id, ctx.from?.id ?? null);
  await ctx.answerCallbackQuery({ text: resolved ? `✓ ${chosen.label}` : 'Already handled.' });
  try {
    await ctx.editMessageText(
      `${row.summary}\n\n— <b>You chose: ${escapeHtml(chosen.label)}</b>`,
      { parse_mode: 'HTML' },
    );
  } catch { /* message too old / identical / not editable */ }
}
