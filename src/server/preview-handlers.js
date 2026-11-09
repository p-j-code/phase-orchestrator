// Preview Handlers v0.11.4 — Telegram commands to read project artifacts away from the Mac.
//
// /preview <project> <artifact>    Inline read (split into messages if >4000 chars)
// /files <project>                 Index of every readable artifact for a project
// /file <project> <path-or-shortcut>   DM the file as a Document (markdown)
//
// Artifact shortcuts:
//   roadmap, audit, plan, brief, brief-questions, raw-thoughts, project-context
//   audit:<date>            specific audit
//   phase:<n>               phase report
//   bugs:<n>                bugs.md for round n
//   plan:<n>                fix plan for round n
//   fix:<n>:<m>             fix report
//   review:<n>              review after phase n
//   qa, qa:<n>              latest QA handoff (overall or for round n)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InputFile } from 'grammy';

import {
  guideRoot, briefPath, briefQuestionsPath, planMdPath, planJsonPath,
  rawThoughtsPath, projectContextPath,
  auditDir, roadmapDir,
  phaseDir, bugRoundDir,
  reviewPath, fixReportPath, bugsFilePath, fixPlanMdPath,
  qaHandoffsDir, detectHighestBugRound,
} from '../lib/guide-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

const TELEGRAM_MAX_CHARS = 3200; // 4096 actual; reserve ~900 for HTML-entity expansion (<,>,& → up to 5x) and per-message "part N/M" headers

// ─── Path resolution ────────────────────────────────────────────────────────

async function listDir(dir) { try { return await fs.readdir(dir); } catch { return []; } }
async function fileExists(p) { try { await fs.access(p); return true; } catch { return false; } }

// Guard against path traversal: return true only if `candidate` resolves to a
// file at or below `baseDir`. Used for any artifact path built from unconstrained
// user input (e.g. the `audit:<ts>` shortcut, where <ts> is a free-form capture).
function isWithinDir(baseDir, candidate) {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(candidate);
  return resolved === base || resolved.startsWith(base + path.sep);
}

async function findLatest(dir, prefix) {
  const entries = await listDir(dir);
  const matching = entries.filter((e) => e.startsWith(prefix)).sort();
  return matching.length ? path.join(dir, matching[matching.length - 1]) : null;
}

/**
 * Resolves an artifact shortcut into an absolute file path.
 * Returns { path, label } or null if no match.
 */
export async function resolveArtifact(projectName, shortcut) {
  const projDir = path.join(PROJECTS_DIR, projectName);
  const s = shortcut.trim().toLowerCase();

  // Direct mappings (latest-of-kind)
  switch (s) {
    case 'brief':           return { path: briefPath(projDir), label: 'Brief' };
    case 'brief-questions':
    case 'brief_questions':
    case 'bq':             return { path: briefQuestionsPath(projDir), label: 'Brief questions' };
    case 'plan':            return { path: planMdPath(projDir), label: 'Plan' };
    case 'raw-thoughts':
    case 'raw_thoughts':
    case 'rawthoughts':     return { path: rawThoughtsPath(projDir), label: 'Raw thoughts' };
    case 'project-context':
    case 'context':         return { path: projectContextPath(projDir), label: 'Project context' };
    case 'audit': {
      const p = await findLatest(auditDir(projDir), 'audit-');
      return p ? { path: p, label: 'Audit (latest)' } : null;
    }
    case 'roadmap': {
      const p = await findLatest(roadmapDir(projDir), 'roadmap-');
      return p ? { path: p, label: 'Roadmap (latest)' } : null;
    }
    case 'qa': {
      // latest QA handoff overall
      const p = await findLatest(qaHandoffsDir(projDir), 'qa-handoff-');
      return p ? { path: p, label: 'QA handoff (latest)' } : null;
    }
  }

  // Patterned shortcuts
  let m;

  if ((m = s.match(/^audit:(.+)$/))) {
    const ts = m[1];
    // `ts` is a free-form capture (unlike the \d+-constrained shortcuts below),
    // so reject any traversal before building the path, then verify containment.
    if (/[\\/]|\.\./.test(ts)) return null;
    const dir = auditDir(projDir);
    const p = path.join(dir, `audit-${ts}.md`);
    if (!isWithinDir(dir, p)) return null;
    return (await fileExists(p)) ? { path: p, label: `Audit ${ts}` } : null;
  }

  if ((m = s.match(/^phase:(\d+)$/))) {
    const n = Number(m[1]);
    const phasesDir = path.join(guideRoot(projDir), 'phases');
    const entries = await listDir(phasesDir);
    const padded = String(n).padStart(2, '0');
    const matchingDir = entries.find((e) => e.startsWith(padded + '-'));
    if (!matchingDir) return null;
    const p = path.join(phasesDir, matchingDir, 'report.md');
    return (await fileExists(p)) ? { path: p, label: `Phase ${n} report` } : null;
  }

  if ((m = s.match(/^bugs:(\d+)$/))) {
    const n = Number(m[1]);
    const p = bugsFilePath(projDir, n);
    return (await fileExists(p)) ? { path: p, label: `Bugs.md (round ${n})` } : null;
  }

  if ((m = s.match(/^plan:(\d+)$/))) {
    const n = Number(m[1]);
    const p = fixPlanMdPath(projDir, n);
    return (await fileExists(p)) ? { path: p, label: `Fix plan (round ${n})` } : null;
  }

  if ((m = s.match(/^fix:(\d+):(\d+)$/))) {
    const round = Number(m[1]);
    const fixN = Number(m[2]);
    const fixesDir = path.join(bugRoundDir(projDir, round), 'fixes');
    const entries = await listDir(fixesDir);
    const padded = String(fixN).padStart(2, '0');
    const matchingDir = entries.find((e) => e.startsWith(padded + '-'));
    if (!matchingDir) return null;
    const p = path.join(fixesDir, matchingDir, 'report.md');
    return (await fileExists(p)) ? { path: p, label: `Fix r${round}.${fixN} report` } : null;
  }

  if ((m = s.match(/^review:(\d+)$/))) {
    const n = Number(m[1]);
    const p = reviewPath(projDir, n);
    return (await fileExists(p)) ? { path: p, label: `Review after phase ${n}` } : null;
  }

  if ((m = s.match(/^qa:(\d+)$/))) {
    const n = Number(m[1]);
    const p = await findLatest(qaHandoffsDir(projDir), `qa-handoff-round-${n}-`);
    return p ? { path: p, label: `QA handoff (round ${n})` } : null;
  }

  // Bare tokens (no :N suffix) — resolve to "latest of kind"
  if (s === 'phase') {
    const phasesDir = path.join(guideRoot(projDir), 'phases');
    const entries = await listDir(phasesDir);
    // Sort by the numeric phase prefix, not lexically — '100-' sorts before
    // '99-' as a string, which would pick phase 99 as "latest" past 99 phases.
    const dirs = entries
      .filter((e) => /^\d+-/.test(e))
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    if (!dirs.length) return null;
    return { path: path.join(phasesDir, dirs[dirs.length - 1], 'report.md'), label: 'Phase report (latest)' };
  }

  if (s === 'review') {
    const reviewsDir = path.join(guideRoot(projDir), 'reviews');
    const entries = await listDir(reviewsDir);
    const nums = entries
      .map((e) => { const mm = e.match(/^after-(\d+)\.md$/); return mm ? Number(mm[1]) : null; })
      .filter(Boolean)
      .sort((a, b) => b - a);
    if (!nums.length) return null;
    return { path: reviewPath(projDir, nums[0]), label: `Review after phase ${nums[0]}` };
  }

  if (s === 'bugs') {
    const round = await detectHighestBugRound(projDir);
    if (!round) return null;
    return { path: bugsFilePath(projDir, round), label: `Bugs.md (round ${round})` };
  }

  return null;
}

// ─── Index (for /files) ─────────────────────────────────────────────────────

export async function getArtifactIndex(projectName) {
  const projDir = path.join(PROJECTS_DIR, projectName);
  const sections = [];

  // Core
  const core = [];
  for (const [s, label] of [
    ['brief', briefPath(projDir)],
    ['brief-questions', briefQuestionsPath(projDir)],
    ['plan', planMdPath(projDir)],
    ['raw-thoughts', rawThoughtsPath(projDir)],
    ['project-context', projectContextPath(projDir)],
  ]) {
    if (await fileExists(label)) core.push(s);
  }
  if (core.length) sections.push({ name: 'Core', shortcuts: core });

  // Audits
  const auditFiles = (await listDir(auditDir(projDir))).filter((e) => e.startsWith('audit-')).sort();
  if (auditFiles.length) {
    const auditEntries = ['audit (latest)'];
    auditEntries.push(...auditFiles.slice(0, -1).map((f) => `audit:${f.replace(/^audit-/, '').replace(/\.md$/, '')}`));
    sections.push({ name: `Audits (${auditFiles.length})`, shortcuts: auditEntries });
  }

  // Roadmaps
  const roadmapFiles = (await listDir(roadmapDir(projDir))).filter((e) => e.startsWith('roadmap-')).sort();
  if (roadmapFiles.length) {
    sections.push({ name: `Roadmaps (${roadmapFiles.length})`, shortcuts: ['roadmap (latest)'] });
  }

  // Phases
  const phasesDir = path.join(guideRoot(projDir), 'phases');
  const phaseEntries = (await listDir(phasesDir)).filter((e) => /^\d+-/.test(e));
  if (phaseEntries.length) {
    const phases = phaseEntries
      .map((e) => Number(e.split('-')[0]))
      .filter((n) => !isNaN(n))
      .sort((a, b) => a - b)
      .map((n) => `phase:${n}`);
    sections.push({ name: `Phases (${phases.length})`, shortcuts: phases });
  }

  // Reviews
  const reviewsDir = path.join(guideRoot(projDir), 'reviews');
  const reviewEntries = (await listDir(reviewsDir)).filter((e) => /^after-\d+/.test(e));
  if (reviewEntries.length) {
    const reviews = reviewEntries
      .map((e) => Number(e.match(/after-(\d+)/)[1]))
      .sort((a, b) => a - b)
      .map((n) => `review:${n}`);
    sections.push({ name: `Reviews (${reviews.length})`, shortcuts: reviews });
  }

  // Bug rounds
  const bugRoundsDir = path.join(guideRoot(projDir), 'bug-rounds');
  const roundEntries = (await listDir(bugRoundsDir)).filter((e) => /^round-\d+/.test(e));
  if (roundEntries.length) {
    const rounds = roundEntries
      .map((e) => Number(e.match(/round-(\d+)/)[1]))
      .sort((a, b) => a - b);
    const items = [];
    for (const r of rounds) {
      items.push(`bugs:${r}`);
      items.push(`plan:${r}`);
      // Count fixes
      const fixesDir = path.join(bugRoundsDir, `round-${r}`, 'fixes');
      const fixEntries = (await listDir(fixesDir)).filter((e) => /^\d+-/.test(e));
      if (fixEntries.length) {
        const fixNums = fixEntries.map((e) => Number(e.split('-')[0])).filter((n) => !isNaN(n)).sort((a, b) => a - b);
        for (const n of fixNums) items.push(`fix:${r}:${n}`);
      }
    }
    sections.push({ name: `Bug rounds (${rounds.length})`, shortcuts: items });
  }

  // QA handoffs
  const qaFiles = (await listDir(qaHandoffsDir(projDir))).filter((e) => e.startsWith('qa-handoff-'));
  if (qaFiles.length) {
    const rounds = new Set();
    for (const f of qaFiles) {
      const m = f.match(/qa-handoff-round-(\d+)/);
      if (m) rounds.add(Number(m[1]));
    }
    const items = ['qa (latest)'];
    for (const r of [...rounds].sort((a, b) => a - b)) items.push(`qa:${r}`);
    sections.push({ name: `QA handoffs (${qaFiles.length})`, shortcuts: items });
  }

  return sections;
}

// ─── Telegram message splitter ─────────────────────────────────────────────

/**
 * Splits content into Telegram-sized chunks. Splits on line boundaries when
 * possible; falls back to hard char-split for pathological single lines
 * larger than maxChars.
 *
 * Earlier versions had a `!inCodeBlock` guard intended to keep markdown
 * ``` fences intact across messages. That was both wrong (Telegram <pre>
 * doesn't parse markdown, so fences are just opaque text) and unsafe (a
 * code block longer than maxChars would never get split, producing a
 * single oversize chunk and a 400 from sendMessage). Removed.
 */
export function splitForTelegram(content, maxChars = TELEGRAM_MAX_CHARS) {
  if (content.length <= maxChars) return [content];

  const chunks = [];
  const lines = content.split('\n');
  let buf = '';

  for (const line of lines) {
    // Flush whenever adding this line would overflow — regardless of any
    // markdown structural context. Telegram messages are flat strings.
    if ((buf + line + '\n').length > maxChars && buf.length > 0) {
      chunks.push(buf);
      buf = '';
    }
    buf += line + '\n';
  }
  if (buf.length > 0) chunks.push(buf);

  // Last-resort safety: a single line longer than maxChars (minified JSON,
  // long URLs, base64 blobs) can't be line-split — hard char-split it.
  const safe = [];
  for (const c of chunks) {
    if (c.length <= maxChars) {
      safe.push(c);
    } else {
      for (let i = 0; i < c.length; i += maxChars) {
        safe.push(c.slice(i, i + maxChars));
      }
    }
  }
  return safe;
}

// ─── Telegram handlers ──────────────────────────────────────────────────────

import { getProject } from '../state.js';
import { isAllowlisted } from './job-queue.js';
import { getNextActions, renderNextActionsTelegram } from '../lib/next-actions.js';
import { escapeHtml, sanitizeForTelegram } from '../lib/telegram-fmt.js';
import { resolveProject } from './telegram-handlers.js';

function requireAuth(handler) {
  return async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isAllowlisted(userId)) {
      return ctx.reply('Unauthorized. Send /start to learn how to authenticate.');
    }
    return handler(ctx);
  };
}

export const handlePreview = requireAuth(async (ctx) => {
  const rawArgs = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  const userId = ctx.from?.id;
  const pinned = userId ? (await import('./job-queue.js')).getPinnedProject(userId) : null;

  // Resolve project + artifact from rawArgs:
  //   /preview <project> <artifact>     → explicit
  //   /preview <artifact>     (with pin) → use pinned as project
  //   /preview                  → show picker
  let projectName = null;
  let shortcut = null;

  if (rawArgs.length >= 2) {
    // Two or more args: first is project, rest is artifact
    projectName = rawArgs[0];
    shortcut = rawArgs.slice(1).join(' ');
  } else if (rawArgs.length === 1) {
    // One arg: if it matches a known project, it's the project (and artifact is missing)
    // Else if pinned exists, treat it as the artifact shortcut
    if (getProject(rawArgs[0])) {
      projectName = rawArgs[0];
    } else if (pinned) {
      projectName = pinned;
      shortcut = rawArgs[0];
    } else {
      projectName = rawArgs[0]; // assume project, will fail validation below
    }
  } else {
    // No args
    if (pinned) {
      projectName = pinned;
    } else {
      await showProjectPickerWrapper(ctx);
      return;
    }
  }

  if (!shortcut) {
    return ctx.reply(
      'Usage: <code>/preview &lt;project&gt; &lt;artifact&gt;</code>\n\n' +
      (pinned ? `Or with pinned project (${pinned}): <code>/preview &lt;artifact&gt;</code>\n\n` : '') +
      'Examples:\n' +
      '  <code>/preview roadmap</code>\n' +
      '  <code>/preview audit</code>\n' +
      '  <code>/preview bugs:4</code>\n' +
      '  <code>/preview fix:4:1</code>\n' +
      '  <code>/preview phase:5</code>\n' +
      '  <code>/preview qa:4</code>\n\n' +
      'See <code>/files</code> for the full index.',
      { parse_mode: 'HTML' },
    );
  }

  if (!getProject(projectName)) return ctx.reply(`Project not found: ${sanitizeForTelegram(projectName)}`, { parse_mode: 'HTML' });

  const resolved = await resolveArtifact(projectName, shortcut);
  if (!resolved) {
    return ctx.reply(
      `Artifact not found: <code>${sanitizeForTelegram(shortcut)}</code>\n\nUse <code>/files ${sanitizeForTelegram(projectName)}</code> to see what's available.`,
      { parse_mode: 'HTML' },
    );
  }

  let content;
  try {
    content = await fs.readFile(resolved.path, 'utf-8');
  } catch (err) {
    return ctx.reply(`Failed to read file: ${err.message}`);
  }

  const chunks = splitForTelegram(content);
  // Send header + first chunk
  const header = `📖 <b>${sanitizeForTelegram(resolved.label)}</b> — ${sanitizeForTelegram(projectName)}\n` +
                 `<i>${sanitizeForTelegram(path.relative(REPO_ROOT, resolved.path))}</i>${chunks.length > 1 ? ` · part 1/${chunks.length}` : ''}`;

  // Helper: send a chunk, and if Telegram still rejects (400 too long), split
  // and retry recursively. This is a defensive last line — splitForTelegram
  // should already have produced safe sizes, but escaping or future template
  // changes could push us over the line again.
  const sendChunk = async (text) => {
    try {
      await ctx.reply(text, { parse_mode: 'HTML' });
    } catch (err) {
      const tooLong = err?.error_code === 400 && /too long/i.test(err.description || '');
      if (tooLong && text.length > 200) {
        const mid = Math.floor(text.length / 2);
        // Split on a newline near the midpoint when possible
        const splitAt = text.lastIndexOf('\n', mid) > 0 ? text.lastIndexOf('\n', mid) : mid;
        await sendChunk(text.slice(0, splitAt));
        await sendChunk(text.slice(splitAt));
        return;
      }
      // Anything else (or already-tiny chunk) → surface a path-only fallback
      // and keep going. We log via re-throw so the bot's error handler still
      // sees it, but only after we've told the user what file to look at.
      try {
        await ctx.reply(
          `⚠ Could not render this chunk in Telegram (${sanitizeForTelegram(err?.description || err?.message || 'unknown')}).\n` +
          `Read directly:  <code>${sanitizeForTelegram(path.relative(REPO_ROOT, resolved.path))}</code>`,
          { parse_mode: 'HTML' },
        );
      } catch { /* swallow — we're already in an error path */ }
    }
  };

  await sendChunk(header + '\n\n<pre>' + escapeHtml(chunks[0]) + '</pre>');
  for (let i = 1; i < chunks.length; i += 1) {
    await sendChunk(`<i>part ${i + 1}/${chunks.length}</i>\n\n<pre>${escapeHtml(chunks[i])}</pre>`);
  }

  // Append next-actions
  const actions = getNextActions({ project: projectName, lastAction: 'preview-shown' });
  const { text: _t, keyboard } = await renderNextActionsTelegram(actions, { headerText: '', compact: true, contextId: `${projectName}|preview-shown` });
  if (keyboard) {
    await ctx.reply('What next:', { reply_markup: keyboard });
  }
});

// Wrapper to call the picker exported by telegram-handlers (avoids circular import)
async function showProjectPickerWrapper(ctx, hint) {
  const { showProjectPicker } = await import('./telegram-handlers.js');
  return showProjectPicker(ctx, hint);
}

export const handleFiles = requireAuth(async (ctx) => {
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  const projectName = await resolveProject(ctx, args);
  if (!projectName) return; // picker shown
  if (!getProject(projectName)) return ctx.reply(`Project not found: ${sanitizeForTelegram(projectName)}`, { parse_mode: 'HTML' });

  const sections = await getArtifactIndex(projectName);
  if (sections.length === 0) {
    return ctx.reply(`No artifacts found under <code>projects/${sanitizeForTelegram(projectName)}/.guide/</code>`, { parse_mode: 'HTML' });
  }

  const lines = [`📁 <b>Available artifacts for ${sanitizeForTelegram(projectName)}</b>`, ''];
  for (const sec of sections) {
    lines.push(`<b>${sanitizeForTelegram(sec.name)}:</b>`);
    const display = sec.shortcuts.slice(0, 20);
    for (const s of display) {
      lines.push(`  • <code>${sanitizeForTelegram(s)}</code>`);
    }
    if (sec.shortcuts.length > display.length) {
      lines.push(`  • <i>… and ${sec.shortcuts.length - display.length} more</i>`);
    }
    lines.push('');
  }
  lines.push('<i>Tap-and-hold any shortcut to copy. Then:</i>');
  lines.push(`  <code>/preview ${sanitizeForTelegram(projectName)} &lt;shortcut&gt;</code>`);
  lines.push(`  <code>/file ${sanitizeForTelegram(projectName)} &lt;shortcut&gt;</code>  (downloads .md instead)`);

  const full = lines.join('\n');
  const chunks = splitForTelegram(full);
  for (const c of chunks) {
    await ctx.reply(c, { parse_mode: 'HTML' });
  }
});

export const handleFile = requireAuth(async (ctx) => {
  const rawArgs = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  const userId = ctx.from?.id;
  const pinned = userId ? (await import('./job-queue.js')).getPinnedProject(userId) : null;

  // Same shape as /preview
  let projectName = null;
  let shortcut = null;
  if (rawArgs.length >= 2) {
    projectName = rawArgs[0];
    shortcut = rawArgs.slice(1).join(' ');
  } else if (rawArgs.length === 1) {
    if (getProject(rawArgs[0])) {
      projectName = rawArgs[0];
    } else if (pinned) {
      projectName = pinned;
      shortcut = rawArgs[0];
    }
  } else if (pinned) {
    projectName = pinned;
  } else {
    await showProjectPickerWrapper(ctx);
    return;
  }
  if (!shortcut) {
    return ctx.reply('Usage: <code>/file &lt;project&gt; &lt;artifact-shortcut-or-path&gt;</code>' + (pinned ? `\nOr with pinned project (${sanitizeForTelegram(pinned)}): <code>/file &lt;artifact&gt;</code>` : ''), { parse_mode: 'HTML' });
  }
  if (!getProject(projectName)) return ctx.reply(`Project not found: ${sanitizeForTelegram(projectName)}`, { parse_mode: 'HTML' });

  let resolved = await resolveArtifact(projectName, shortcut);
  if (!resolved) {
    // Try as raw path relative to project dir
    const projDir = path.join(PROJECTS_DIR, projectName);
    const candidate = path.join(projDir, shortcut);
    const resolvedProjDir = path.resolve(projDir);
    const resolvedCandidate = path.resolve(candidate);
    if (
      resolvedCandidate.startsWith(resolvedProjDir + path.sep) &&
      await fileExists(candidate)
    ) {
      resolved = { path: candidate, label: path.basename(candidate) };
    }
  }
  if (!resolved) {
    return ctx.reply(
      `Artifact not found: <code>${sanitizeForTelegram(shortcut)}</code>\n\nUse <code>/files ${sanitizeForTelegram(projectName)}</code> to see shortcuts, or pass a literal path like <code>.guide/brief.md</code>.`,
      { parse_mode: 'HTML' },
    );
  }

  try {
    const stat = await fs.stat(resolved.path);
    if (stat.size > 50 * 1024 * 1024) {
      return ctx.reply(`File too large for bot upload (${(stat.size / 1024 / 1024).toFixed(1)} MB > 50 MB).`);
    }
    await ctx.replyWithDocument(new InputFile(resolved.path), {
      caption: `${resolved.label}  (${(stat.size / 1024).toFixed(1)} KB)`,
    });
  } catch (err) {
    return ctx.reply(`Failed to send file: ${err.message}`);
  }
});
