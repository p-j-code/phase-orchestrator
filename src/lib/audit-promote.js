// Audit Promote — extracts the "Promote to bugs-round-N" section from
// an audit markdown file and prepares it for insertion into a bugs.md.
//
// Two-level detection + content cleanup, so this survives model drift:
//
//   Level 1 — broad header regex ("Promote[\s-]+to")
//   Level 2 — position heuristic: first ##+ heading after known terminal sections
//   Cleanup  — strip wrapping code fences and trailing Out-of-scope sections

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  findMostRecentAudit, detectHighestBugRound, bugRoundDir, bugsFilePath, auditDir, findingHistoryPath,
} from './guide-paths.js';
import { addDedupedBug } from '../state.js';

// ─── Level 1: header regex ───────────────────────────────────────────────────
// Matches any ##+ heading "Promote to <bug/round reference>". Requires "bug" or
// "round" after "to" to reject unrelated headings like "## Promote to fix-list".
// Observed model drift variants:
//   "## Promote to bugs-round-9"                   (correct)
//   "## Promote to `bugs-round-7`"                 (code-formatted)
//   "## Promote to **bugs-round-7**"               (bold)
//   "## Promote to bugs round 7"                   (spaces instead of hyphens)
//   "### Promote to bugs-round-12"                 (deeper heading)
//   "## Promote-to-bugs-round-8.md"                (fully hyphenated + .md suffix)
//   "## Promote to `bug-rounds/round-9/bugs.md`"   (path-style slug)
//   "## Promote to round 1"                        (compact round-only)
const SECTION_HEADER_RE = /^#{2,}\s+[`*_]*Promote[\s\-]+to\b\s+[`*_]*(?:bugs?[\s\-/]*round|round)/im;

// ─── Level 2: BUG-N entry scan ───────────────────────────────────────────────
// Matches any ##+ heading that starts with a BUG-N identifier (case-insensitive).
// Handles: "### BUG-1: title", "### BUG 1:", "### Bug-1:", "### BUG-N:", "#### BUG-1:"
// Requires the heading marker (##) at the start of a line — rejects mid-prose mentions.
export const BUG_ENTRY_REGEX = /^#{2,}\s+bug[-\s]?(?:\d+|N)(?:\s|:|$)/im;

// ─── Level 3: position heuristic ─────────────────────────────────────────────
// Sections that reliably appear immediately before the Promote section.
// We find the rightmost match of any of these, then take the first ##+ heading
// that follows — that heading IS the promote section (or close to it).
const PRE_PROMOTE_SECTION_RES = [
  /^#{2,}\s+Top[\s\-]?\s*3\s+recommendations/im,
  /^#{2,}\s+What\s+I\s+could(?:n't|n't| not)\s+verify/im,
  /^#{2,}\s+Independently\s+verified/im,
  /^#{2,}\s+Verified[\s\-]claims/im,
];

// Sections we must not mistake for the promote section.
const SKIP_SECTION_RE = /^#{2,}\s+Out[\s\-]of[\s\-]scope/im;

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Extract the "Promote to bugs-round-N" section from an audit file.
 *
 * Three-level detection:
 *   1. SECTION_HEADER_RE — explicit "Promote to bugs-round-N" heading
 *   2. BUG_ENTRY_REGEX   — no explicit heading but structured BUG-N entries present
 *   3. positionFallback  — last-resort position heuristic
 *
 * @param {string} auditFilePath - absolute path to audit markdown
 * @returns {Promise<{found: boolean, source?: string, content: string|null, reason?: string, warning?: string}>}
 */
export async function extractPromoteSection(auditFilePath) {
  let content;
  try {
    content = await fs.readFile(auditFilePath, 'utf-8');
  } catch (err) {
    return { found: false, content: null, reason: `Cannot read audit file: ${err.message}` };
  }

  // Level 1: explicit "Promote to bugs-round-N" heading
  const m = SECTION_HEADER_RE.exec(content);
  if (m) return { ...buildResult(content, m.index, null), source: 'explicit-heading' };

  // Level 2: BUG-N entry scan — no explicit Promote heading, but BUG-N entries present
  const bugResult = bugEntriesFallback(content);
  if (bugResult) return bugResult;

  // Level 3: position heuristic — last resort for severe template drift
  const fuzzy = positionFallback(content);
  if (fuzzy) return { ...buildResult(content, fuzzy.index, fuzzy.warning), source: 'position-heuristic' };

  return { found: false, content: null, reason: buildFailureReason(content) };
}

/**
 * Format extracted content as a fresh bugs.md.
 */
export function formatBugsFile(promotedContent, project, round, auditFilename) {
  const now = new Date().toISOString().slice(0, 10);
  return `# Bug Report — ${project} — Round ${round}

> Promoted from audit: \`${auditFilename}\` on ${now}
> Review each finding below. Remove false positives. Adjust severity if needed.
> Add manual findings (from QA, user reports, your own observations) as needed.
> When ready: \`npm run bugs -- ${project}\`

---

${promotedContent}
`;
}

/**
 * Format extracted content as an append block (when bugs.md already exists).
 */
export function formatAppendBlock(promotedContent, auditFilename) {
  const now = new Date().toISOString().slice(0, 10);
  return `

---

## Additional findings — promoted from audit \`${auditFilename}\` on ${now}

${promotedContent}
`;
}

// ─── runtime-QA blocker promotion (phase 89 / P5b) ────────────────────────────
//
// Gate-mode runtime-qa (default-off) promotes a verdict's blockers into the bug
// inbox before pausing. This reuses the SAME addDedupedBug precedent ship-gate.js
// and brief-conformance.js use — one deduped bug_inbox row per blocker, so a
// re-run of the gate on an unchanged workspace never accumulates duplicate rows —
// rather than hand-rolling an INSERT. Best-effort per row: a DB write failure on
// one blocker never aborts the rest (or the caller's pause). Pure aside from the
// injected insert; the addDedupedBug seam lets tests avoid a live DB.

// runtime-qa verdict severities ('blocker'|'major'|'minor', plus a defensive
// 'critical') → the bug_inbox severity vocabulary (critical|major|minor). A
// runtime 'blocker' is the highest bar, so it lands as 'critical'.
const RUNTIME_QA_SEVERITY_MAP = Object.freeze({
  blocker: 'critical', critical: 'critical', major: 'major', minor: 'minor',
});

/**
 * Promote runtime-QA verdict blockers into the bug inbox.
 *
 * @param {Object} o
 * @param {string} o.projectName
 * @param {Array<{title?:string, detail?:string, severity?:string}>} o.blockers
 * @param {{addDedupedBug?: Function}} [deps] - test seam (defaults to state.addDedupedBug)
 * @returns {{ inserted: number, ids: number[] }}
 */
export function promoteRuntimeQaBlockers({ projectName, blockers }, deps = {}) {
  const addBugFn = deps.addDedupedBug || addDedupedBug;
  const list = Array.isArray(blockers) ? blockers : [];
  const ids = [];
  let inserted = 0;
  for (const b of list) {
    if (!b || typeof b !== 'object') continue;
    const title = String(b.title || '').trim() || 'runtime-qa blocker';
    const detail = String(b.detail || '').trim();
    const raw_text = detail ? `${title} — ${detail}` : title;
    const severity = RUNTIME_QA_SEVERITY_MAP[String(b.severity || '').toLowerCase()] || 'major';
    try {
      const r = addBugFn({ project: projectName, raw_text, severity, source: 'runtime-qa' });
      if (r && r.inserted) inserted += 1;
      if (r && r.id != null) ids.push(r.id);
    } catch { /* best-effort — one bad row never aborts the pause */ }
  }
  return { inserted, ids };
}

// ─── internal helpers ─────────────────────────────────────────────────────────

/**
 * v0.14.34: deterministic clean-audit signal. The audit prompt instructs the
 * model to write "(nothing to promote — no CRITICAL or MAJOR findings)" inside
 * the promote section when an audit is clean. Recognizing that line here (vs.
 * relying on the section being absent) survives template drift AND keeps the
 * auto-chain's early-stop deterministic — a clean audit must never create a
 * junk bugs round out of its own placeholder text.
 */
const NOTHING_TO_PROMOTE_RE = /^\(?\s*(?:nothing|no\s+findings?)\s+to\s+promote\b/i;

/**
 * Slice content from startIndex, drop the heading line, clean up, and return a
 * result object.
 */
function buildResult(content, startIndex, extraWarning) {
  let extracted = content.slice(startIndex).trim();

  // Drop the section heading line itself
  const nl = extracted.indexOf('\n');
  extracted = (nl === -1 ? '' : extracted.slice(nl + 1)).trim();

  // Strip code fence wrappers and trailing out-of-scope sections
  extracted = cleanContent(extracted);

  const meaningful = extracted
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('<!--'));

  // Clean audit: every meaningful line is the nothing-to-promote marker (or
  // there are none at all and the marker appears) → NOT promotable.
  if (meaningful.length > 0 && meaningful.every((l) => NOTHING_TO_PROMOTE_RE.test(l))) {
    return {
      found: false,
      clean: true,
      content: null,
      reason: 'Audit reported nothing to promote (no CRITICAL/MAJOR findings) — clean audit.',
    };
  }

  const meaningfulLines = meaningful.length;

  let warning = extraWarning || undefined;
  if (meaningfulLines < 3) {
    const note = 'Section found but contains very little content — review the audit file manually.';
    warning = warning ? `${warning} ${note}` : note;
  }

  return { found: true, content: extracted, warning };
}

/**
 * Clean extracted section content:
 *
 * 1. If a markdown code fence exists (```markdown or ````markdown), extract the
 *    inner content — models often wrap the bug list in a copyable code block.
 * 2. Otherwise, strip any trailing "Out-of-scope" section that got swept in.
 */
function cleanContent(text) {
  // Find the first ```markdown / ````markdown / ~~~markdown fence
  const fenceStartRe = /^(`{3,}|~{3,})[ \t]*markdown?[ \t]*$/m;
  const startMatch = fenceStartRe.exec(text);
  if (startMatch) {
    const fenceChar = startMatch[1][0];
    const fenceLen = startMatch[1].length;
    const afterOpen = text.slice(startMatch.index + startMatch[0].length + 1); // +1 skips the newline

    // Find matching closing fence (same char, same or greater length)
    const closingRe = new RegExp(`^[${fenceChar === '`' ? '`' : '~'}]{${fenceLen},}[ \\t]*$`, 'm');
    const endMatch = closingRe.exec(afterOpen);
    return (endMatch ? afterOpen.slice(0, endMatch.index) : afterOpen).trim();
  }

  // No code fence — strip trailing Out-of-scope section if present,
  // but only when it is the last ## heading and its body is short (boilerplate).
  const outOfScopeRe = /(?:\n---[ \t]*\n|\n)#{2,}\s+Out[\s\-]of[\s\-]scope/m;
  const osMatch = outOfScopeRe.exec(text);
  if (osMatch) {
    const afterMatch = text.slice(osMatch.index + osMatch[0].length);
    const hasLaterHeading = /\n#{2,}\s/.test(afterMatch);
    const bodyLines = afterMatch.trim().split('\n').filter((l) => l.trim()).length;
    if (!hasLaterHeading && bodyLines < 10) {
      return text.slice(0, osMatch.index).trim();
    }
  }

  return text;
}

/**
 * Returns a structured { found, source, content, warning } result built from
 * BUG-N heading matches. Keeps the first heading (unlike buildResult which
 * strips it) so the extracted content starts with "### BUG-1: ...".
 */
function bugEntriesFallback(content) {
  const allMatches = [...content.matchAll(new RegExp(BUG_ENTRY_REGEX.source, 'gim'))];
  if (allMatches.length === 0) return null;

  const firstMatch = allMatches[0];
  let extracted = content.slice(firstMatch.index).trim();
  extracted = cleanContent(extracted);

  const count = allMatches.length;
  const warning =
    `No "Promote to bugs-round-N" heading found. ${count} BUG-N entr${count === 1 ? 'y' : 'ies'} ` +
    `collected via fallback BUG-N scan. Review the generated bugs.md and adjust if needed.`;

  return { found: true, content: extracted, source: 'bug-entries-scan', warning };
}

/**
 * Phase 34: audit yield — findings count + title fingerprint for the promoted
 * section. Both derive from the SAME matches the promote parser extracts
 * (BUG_ENTRY_REGEX over the extracted promote content, mirroring
 * bugEntriesFallback) — never a parallel regex, so the count can't disagree
 * with what actually got promoted. A plain `### Bug #N`-only pattern would
 * UNDERCOUNT vs the parser (misses `#### Bug 1`, `### BUG-N:`, `### BUG-1:`).
 *
 * The fingerprint is sha256 over the sorted, lowercased, whitespace-collapsed
 * bug TITLES — the text AFTER each matched heading marker (the `— <title>` /
 * `: <title>` remainder of the heading line). Sorting makes it stable under
 * reordering; any title change produces a different hash. null when there are
 * no BUG-N entries (clean audit, or non-BUG-shaped heuristic extraction).
 *
 * @param {string|null} content - extracted promote-section content
 * @returns {{findings_count: number, fingerprint: string|null}}
 */
export function computeAuditYield(content) {
  if (!content) return { findings_count: 0, fingerprint: null };
  const matches = [...content.matchAll(new RegExp(BUG_ENTRY_REGEX.source, 'gim'))];
  if (matches.length === 0) return { findings_count: 0, fingerprint: null };
  const titles = matches.map((m) => {
    const nl = content.indexOf('\n', m.index);
    const line = content.slice(m.index, nl === -1 ? content.length : nl);
    return line
      .slice(m[0].length)          // drop the matched "### BUG-N" marker (incl. its trailing sep char)
      .replace(/^[\s:—–-]+/, '')   // strip leading separators: ": title", "— title", "- title"
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  });
  const fingerprint = createHash('sha256').update(titles.sort().join('\n')).digest('hex');
  return { findings_count: matches.length, fingerprint };
}

// ─── Phase 43 (P7): per-finding convergence detection ──────────────────────
//
// Unlike computeAuditYield's whole-section fingerprint (identical byte-for-byte
// re-promotion), this parses each INDIVIDUAL finding so a paraphrased or
// partially-fixed recurrence — the far more common real-world case — is still
// caught. Pure and zero-LLM-cost throughout; unparseable input fails open to
// `[]` (no history, no stall — behavior identical to pre-P7).

// Matches a "### Bug #N — <title>" heading, tolerating the same drift
// BUG_ENTRY_REGEX tolerates: "Bug N", "BUG-1:", bold/backtick wrapping, deeper
// heading levels. Captures the numeral (or literal template placeholder "N")
// so the rest of the line — the title — can be sliced off after the match.
const FINDING_HEADING_RE = /^#{2,}\s+[`*_]*Bug[\s#-]*(\d+|N)[`*_]*/gim;

// Matches an "Affected files" line, bold or plain, singular/plural, with a
// hyphen or space before "files" (mirrors the audit template's exact
// "**Affected files:** ..." plus any operator-typo variants).
const AFFECTED_FILES_LINE_RE = /^[ \t]*\*{0,2}affected[\s-]*files?\*{0,2}\s*:\s*(.*)$/im;

function splitFileList(raw) {
  return raw
    .split(/[,;]|\s+and\s+/i)
    .map((f) => f.replace(/[`*_]/g, '').trim())
    .filter(Boolean);
}

/**
 * Extract the "Affected files" list from one finding's block text. Handles
 * both the inline form ("**Affected files:** a.js, b.js") and a bullet-list
 * form immediately below an empty "Affected files:" line. Missing/unparseable
 * → [] (fail-open).
 */
function extractAffectedFiles(block) {
  const m = AFFECTED_FILES_LINE_RE.exec(block);
  if (!m) return [];
  const inline = (m[1] || '').trim();
  if (inline) return splitFileList(inline);

  // Empty inline value — look for a bullet list on the immediately-following
  // lines (stops at the first blank line or non-bullet line).
  const rest = block.slice(m.index + m[0].length).split('\n');
  const files = [];
  for (const line of rest) {
    const t = line.trim();
    if (!t) break;
    const bm = /^[-*]\s+(.*)$/.exec(t);
    if (!bm) break;
    files.push(...splitFileList(bm[1]));
  }
  return files;
}

/**
 * Parse a promoted "Bug #N" section into structured findings. Pure — no I/O.
 * Splits on FINDING_HEADING_RE, so each finding's block runs from its heading
 * to the next heading (or end of content). Unparseable/no BUG-N headings → [].
 *
 * @param {string} sectionText - the extracted "Promote to bugs-round-N" content
 * @returns {Array<{n: number, title: string, files: string[]}>}
 */
export function parsePromotedFindings(sectionText) {
  if (!sectionText || typeof sectionText !== 'string') return [];
  const matches = [...sectionText.matchAll(new RegExp(FINDING_HEADING_RE.source, FINDING_HEADING_RE.flags))];
  if (matches.length === 0) return [];

  const findings = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const nRaw = m[1];
    const n = /^\d+$/.test(nRaw) ? parseInt(nRaw, 10) : i + 1;
    const blockStart = m.index + m[0].length;
    const blockEnd = i + 1 < matches.length ? matches[i + 1].index : sectionText.length;
    const block = sectionText.slice(blockStart, blockEnd);

    const headingLineEnd = block.indexOf('\n');
    const titleLine = headingLineEnd === -1 ? block : block.slice(0, headingLineEnd);
    const title = titleLine.replace(/^[\s:—–-]+/, '').replace(/[`*_]+\s*$/, '').trim();

    findings.push({ n, title, files: extractAffectedFiles(block) });
  }
  return findings;
}

/**
 * Build a matchable fingerprint for one finding: sorted-unique lowercase
 * title tokens (>2 chars — drops "of", "to", "in", ...) plus normalized
 * affected files. Pure, deterministic.
 *
 * @param {string} title
 * @param {string[]} [files]
 * @returns {{tokens: string[], files: string[]}}
 */
export function fingerprintFinding(title, files = []) {
  const tokens = Array.from(new Set(
    String(title || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2),
  )).sort();
  const normFiles = Array.from(new Set(
    (files || []).map((f) => String(f).trim()).filter(Boolean),
  )).sort();
  return { tokens, files: normFiles };
}

function jaccard(a, b) {
  if (!a.length && !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection += 1;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Two findings are the "same" recurring finding when their titles are
 * substantially similar (Jaccard >= 0.6), OR they share >=1 affected file AND
 * their titles are at least loosely similar (Jaccard >= 0.4) — catches a
 * paraphrased re-audit finding that still points at the same file(s).
 *
 * @param {{tokens: string[], files: string[]}} a
 * @param {{tokens: string[], files: string[]}} b
 * @returns {boolean}
 */
export function findingsMatch(a, b) {
  const j = jaccard(a.tokens || [], b.tokens || []);
  if (j >= 0.6) return true;
  const sharedFile = (a.files || []).some((f) => (b.files || []).includes(f));
  return sharedFile && j >= 0.4;
}

const DEFAULT_CONVERGENCE_CFG = Object.freeze({ enabled: true, stall_min_recurring: 2 });

/**
 * Resolve auto_run.convergence for `projectName`. `cfgOverride` (a full
 * resolved-config-shaped object, e.g. `{ auto_run: { convergence: {...} } }`)
 * takes precedence and is used as-is (test/caller seam) — no fs/config-resolver
 * call happens when it's supplied. Otherwise resolves the project's real
 * config; any resolution error (unknown project, missing project.json, etc.)
 * fails open to DEFAULT_CONVERGENCE_CFG, exactly like every other fail-open
 * path in this module.
 */
async function resolveConvergenceCfg(projectName, cfgOverride) {
  if (cfgOverride) {
    return { ...DEFAULT_CONVERGENCE_CFG, ...(cfgOverride.auto_run?.convergence || {}) };
  }
  try {
    const { resolve: resolveConfigFn } = await import('../config-resolver.js');
    const resolved = await resolveConfigFn({ project: projectName, task: 'dev-execution' });
    return { ...DEFAULT_CONVERGENCE_CFG, ...(resolved?.auto_run?.convergence || {}) };
  } catch {
    return { ...DEFAULT_CONVERGENCE_CFG };
  }
}

function formatConvergenceWarningSection(recurring) {
  const lines = recurring.map((r) => {
    const filesNote = r.files.length ? `; files: ${r.files.join(', ')}` : '';
    return `- **${r.title}** — matches round ${r.matched_round} ("${r.matched_title}")${filesNote}`;
  });
  return '## ⚠ Recurring findings (convergence warning)\n\n' +
    'The following finding(s) in this round match findings already promoted in earlier round(s) — ' +
    'recurrence means the fix approach likely needs rethinking, not another attempt:\n\n' +
    `${lines.join('\n')}\n`;
}

/**
 * Human-readable convergence-stall reason, shared by both wiring sites
 * (job-runner's chain loop and auto-runner's FR20 pause) so the phrasing —
 * and the "how to override" hint — never drifts between them.
 *
 * @param {Array<{title: string, matched_round: number}>} recurring
 * @param {string} projectName
 * @returns {string}
 */
export function formatConvergenceStallReason(recurring, projectName) {
  const list = recurring || [];
  const titles = list.map((r) => `"${r.title}" (matches round ${r.matched_round})`).join(', ');
  return `convergence stall — ${list.length} finding(s) recurring across rounds: ${titles}; ` +
    `the fix approach needs rethinking — re-audit after adjusting the approach, or override with: npm run promote -- ${projectName} --from-audit --force`;
}

async function appendFindingHistory(projDir, historyLines) {
  if (!historyLines || historyLines.length === 0) return;
  try {
    await fs.mkdir(auditDir(projDir), { recursive: true });
    await fs.appendFile(findingHistoryPath(projDir), `${historyLines.join('\n')}\n`, 'utf-8');
  } catch (err) {
    console.warn(`[audit-promote] could not append finding-history.jsonl: ${err.message}`);
  }
}

/**
 * Core convergence computation: parse this round's findings, compare each
 * against the FULL cross-round history (before this round's own entries are
 * appended), and decide whether the chain should stall.
 *
 * `enabled: false` (or zero parsed findings) short-circuits before any fs
 * read — the caller's bugs.md content and return shape stay byte-identical to
 * pre-P7 behavior (mode isolation / brief non-functional requirement).
 *
 * @returns {Promise<{enabled: boolean, recurring: Array, convergence_stall: boolean, contentToWrite: string, historyLines: string[]}>}
 */
async function computeConvergence({ projDir, projectName, round, content, force, cfgOverride }) {
  const convergenceCfg = await resolveConvergenceCfg(projectName, cfgOverride);
  const findings = parsePromotedFindings(content);

  if (!convergenceCfg.enabled || findings.length === 0) {
    return { enabled: false, recurring: [], convergence_stall: false, contentToWrite: content, historyLines: [] };
  }

  let historyRaw = '';
  try { historyRaw = await fs.readFile(findingHistoryPath(projDir), 'utf-8'); } catch { /* no history yet */ }
  const historyEntries = historyRaw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  const recurring = [];
  for (const finding of findings) {
    const fp = fingerprintFinding(finding.title, finding.files);
    const matchedRounds = new Set();
    let best = null;
    for (const entry of historyEntries) {
      const entryFp = { tokens: entry.tokens || [], files: entry.files || [] };
      if (findingsMatch(fp, entryFp)) {
        matchedRounds.add(entry.round);
        if (best === null || entry.round > best.round) best = entry;
      }
    }
    if (best) {
      recurring.push({
        title: finding.title,
        files: finding.files,
        matched_round: best.round,
        matched_title: best.title,
        total_rounds_seen: matchedRounds.size + 1, // + this round
      });
    }
  }

  const stallMin = Number(convergenceCfg.stall_min_recurring) || DEFAULT_CONVERGENCE_CFG.stall_min_recurring;
  const stallByCount = recurring.length >= stallMin;
  const stallByPersistence = recurring.some((r) => r.total_rounds_seen >= 3);
  // force:true is the existing operator escape hatch (re-promote after manual
  // edits) — it suppresses the STALL decision only; recurring findings are
  // still surfaced in the return + annotated into bugs.md, so the operator
  // sees exactly what they're overriding.
  const convergence_stall = !force && (stallByCount || stallByPersistence);

  const contentToWrite = recurring.length > 0
    ? `${content}\n\n${formatConvergenceWarningSection(recurring)}`
    : content;

  const historyLines = findings.map((finding) => {
    const fp = fingerprintFinding(finding.title, finding.files);
    return JSON.stringify({
      round, ts: new Date().toISOString(), title: finding.title, files: finding.files, tokens: fp.tokens,
    });
  });

  return { enabled: true, recurring, convergence_stall, contentToWrite, historyLines };
}

/**
 * Lists the markdown headings present in an audit file, for operator-facing
 * failure messages.
 */
export function summarizeAuditStructure(content) {
  const headings = content.match(/^#{1,6}\s+.+/gm) || [];
  if (headings.length === 0) return 'No markdown headings found in audit.';
  return headings.map((h) => h.trim()).join('\n');
}

/**
 * Build a structured failure reason when all detection levels fail.
 */
function buildFailureReason(content) {
  const summary = summarizeAuditStructure(content);
  if (/No markdown headings/.test(summary)) {
    return 'No markdown headings found in the audit file — file may be empty or malformed.';
  }
  return (
    'No "Promote to bugs-round-N" section or BUG-N entries found.\n' +
    `Headings present in audit:\n${summary}\n\n` +
    'To fix: add a section like:\n' +
    '  ## Promote to bugs-round-1\n' +
    '  ### BUG-1: Description\n' +
    '  - Severity: major\n' +
    '  ...'
  );
}

/**
 * Level 3: find the first ##+ heading that follows the last known
 * pre-promote structural section. Returns { index, warning } or null.
 */
function positionFallback(content) {
  // Locate the rightmost occurrence of any known pre-promote section
  let anchorIndex = -1;
  for (const re of PRE_PROMOTE_SECTION_RES) {
    const g = new RegExp(re.source, 'gim');
    let m;
    while ((m = g.exec(content)) !== null) {
      if (m.index > anchorIndex) anchorIndex = m.index;
    }
  }

  // No anchor found → fall back to last 35 % of the document
  const searchFrom = anchorIndex >= 0
    ? (content.indexOf('\n', anchorIndex) + 1)
    : Math.floor(content.length * 0.65);

  if (searchFrom <= 0) return null;

  const tail = content.slice(searchFrom);
  const headingMatch = /^#{2,}\s+.+$/m.exec(tail);
  if (!headingMatch) return null;

  const heading = headingMatch[0];
  if (SKIP_SECTION_RE.test(heading)) return null;

  return {
    index: searchFrom + headingMatch.index,
    warning:
      `Promote section heading "${heading.trim()}" did not match expected "Promote to bugs-round-N" format ` +
      '— found by position heuristic. Review the generated bugs.md and adjust as needed.',
  };
}

// ─── full promote (find → extract → pick round → write) ───────────────────────
//
// Single source of truth for the *file-writing* half of promotion. This is the
// programmatic equivalent of `npm run promote -- <project> --from-audit`, used
// by the audit auto-chain (src/server/job-runner.js) so an unattended audit can
// flow straight into a bug round without a manual hop. The interactive CLI
// command and the Telegram /promote button keep their own UX (prompts, confirm
// buttons) but share the same extract/format primitives above.
//
// Contract: NEVER throws on the "expected" failure modes (no audit, no Promote
// section, file already exists) — those come back as { promoted: false, reason }
// so the caller can decide whether to stop the chain or surface a message. Only
// genuinely unexpected I/O errors propagate.

// Phase 41 (CE-9) — drop a pointer to the SOURCE audit that produced this
// bugs.md into the round dir, so the fix dev can read the finding's file:line
// evidence / failure scenario / suggested approach behind each bug rather than
// only the promoted summary. Writing it HERE (inside the single promote funnel)
// covers every caller — the auto-chain, FR20, and the CLI — in one site. The
// content is the audit path RELATIVE to projDir; runDev re-bases it to the
// dev's workspace CWD. Best-effort by design: a write failure is a warning, not
// a promote failure — the pointer is a convenience, the bugs.md is the contract.
async function writeSourceAuditPointer(targetDir, projDir, audit) {
  try {
    await fs.writeFile(path.join(targetDir, 'source-audit.txt'), `${path.relative(projDir, audit)}\n`, 'utf-8');
  } catch (err) {
    console.warn(`[audit-promote] could not write source-audit.txt pointer: ${err.message}`);
  }
}

/**
 * @param {object}  o
 * @param {string}  o.projDir       absolute path to the project dir (…/projects/<name>)
 * @param {string}  o.projectName   project slug (used in the bugs.md header)
 * @param {string} [o.auditFile]    explicit audit path; defaults to most-recent
 * @param {number} [o.round]        target round; defaults to next available
 * @param {boolean}[o.append=false] append to an existing bugs.md instead of refusing
 * @param {boolean}[o.force=false]  bypass the per-audit sentinel — use only when the operator
 *   manually edited the audit file and needs a fresh round
 * @returns {Promise<{
 *   promoted: boolean,
 *   round?: number,
 *   bugsPath?: string,    // absolute path to the bugs.md written/appended
 *   auditFile?: string,   // absolute path to the audit that was read
 *   appended?: boolean,
 *   warning?: string,     // non-fatal (e.g. heuristic-matched promote section)
 *   reason?: string,      // why promoted === false
 *   findings_count?: number,    // Phase 34: BUG-N entries in the promoted section (0 on clean)
 *   fingerprint?: string|null,  // Phase 34: sha256 of sorted bug titles (null on clean)
 *   recurring?: Array,          // Phase 43: per-finding matches against prior rounds (convergence.enabled only)
 *   convergence_stall?: boolean,// Phase 43: true when recurrence crosses the configured stall thresholds
 * }>}
 */
export async function promoteAuditToBugs({
  projDir, projectName, auditFile = null, round = null, append = false, force = false, dryRun = false, cfg = null,
}) {
  const audit = auditFile || await findMostRecentAudit(projDir);
  if (!audit) {
    return { promoted: false, reason: 'No audit file found to promote (run an audit first).' };
  }

  const extracted = await extractPromoteSection(audit);
  // Phase 34: yield telemetry — derived ONCE from the same extracted content
  // the promote writes, then spread into every post-extraction return below
  // (pure additions; existing keys unchanged). Clean/unparseable → 0/null.
  const auditYield = computeAuditYield(extracted.found ? extracted.content : null);
  if (!extracted.found) {
    // A clean audit (no actionable findings) or a drifted template lands here.
    // This is NOT an error — it just means there is nothing to run. `clean`
    // (Phase 33) distinguishes the two: true only when extractPromoteSection
    // matched the deterministic NOTHING_TO_PROMOTE_RE marker, false for a
    // drifted/unparseable template — callers use it to short-circuit an
    // auto-chain cleanly vs. surfacing a warning.
    return { promoted: false, auditFile: audit, reason: extracted.reason, clean: !!extracted.clean, ...auditYield };
  }

  // Per-audit sentinel: guard against duplicate auto-advance rounds when the same
  // audit is promoted twice without an explicit round number. Explicit-round calls
  // (round !== null) bypass this — they're guarded by the "bugs.md already exists"
  // check below. force:true is an operator escape hatch for re-promote after manual edits.
  const sentinelPath = path.join(auditDir(projDir), `.promoted-${path.basename(audit)}`);
  if (round === null && !force) {
    let sentinelContent;
    try { sentinelContent = await fs.readFile(sentinelPath, 'utf-8'); } catch { /* not yet promoted */ }
    if (sentinelContent) {
      const [roundLine, tsLine] = sentinelContent.trim().split('\n');
      const n = parseInt(roundLine, 10);
      const ts = (tsLine || '').trim();
      return {
        promoted: false,
        reason: `Audit already promoted to round ${n} on ${ts}.`,
        auditFile: audit,
        round: n,
        ...auditYield,
      };
    }
  }

  const targetRound = round || ((await detectHighestBugRound(projDir)) || 0) + 1;
  const targetDir = bugRoundDir(projDir, targetRound);
  const targetFile = bugsFilePath(projDir, targetRound);
  if (!dryRun) await fs.mkdir(targetDir, { recursive: true });

  let exists = false;
  try { await fs.access(targetFile); exists = true; } catch { /* fresh */ }

  if (exists && !append) {
    return {
      promoted: false,
      auditFile: audit,
      round: targetRound,
      bugsPath: targetFile,
      reason: `bugs.md already exists for round ${targetRound} — refusing to overwrite. ` +
        'Pass append:true, choose another round, or delete it first.',
    };
  }

  if (dryRun) {
    // Preflight: if a sentinel was just written by a concurrent promoter
    // (between the fast-path read above and now), signal that the real promote would fail.
    if (round === null && !force) {
      try {
        await fs.access(sentinelPath);
        return {
          promoted: false,
          reason: 'Concurrent promote completed first or audit already promoted.',
          auditFile: audit,
          round: targetRound,
        };
      } catch { /* sentinel absent — wx-open would succeed */ }
    }
    return {
      promoted: true,
      appended: exists && append,
      round: targetRound,
      bugsPath: targetFile,
      auditFile: audit,
      warning: extracted.warning,
      ...auditYield,
    };
  }

  const auditFilename = path.basename(audit);

  // Phase 43 (P7): computed once, before either write path, so the SAME
  // convergence-annotated content (and the SAME history lines) are used
  // whether this round is a fresh write or an append. enabled:false or zero
  // parsed findings short-circuits to contentToWrite === extracted.content
  // and historyLines === [] — byte-identical to pre-P7 behavior.
  const convergence = await computeConvergence({
    projDir, projectName, round: targetRound, content: extracted.content, force, cfgOverride: cfg,
  });
  const convergenceReturn = convergence.enabled
    ? { recurring: convergence.recurring, convergence_stall: convergence.convergence_stall }
    : {};

  if (exists && append) {
    try {
      await fs.appendFile(targetFile, formatAppendBlock(convergence.contentToWrite, auditFilename));
    } catch (err) {
      return { promoted: false, reason: `I/O failure appending to bugs.md: ${err.message}`, auditFile: audit, round: targetRound };
    }
    if (round === null) {
      try {
        await fs.writeFile(sentinelPath, `${targetRound}\n${new Date().toISOString()}\n`);
      } catch (err) {
        return { promoted: false, reason: `I/O failure writing sentinel after append: ${err.message}`, auditFile: audit, round: targetRound };
      }
    }
    await writeSourceAuditPointer(targetDir, projDir, audit);
    await appendFindingHistory(projDir, convergence.historyLines);
    return {
      promoted: true, appended: true, round: targetRound, bugsPath: targetFile, auditFile: audit,
      warning: extracted.warning, ...auditYield, ...convergenceReturn,
    };
  }

  // Claim the sentinel atomically before writing bugs.md.
  // 'wx' flag → exclusive create; EEXIST means another promoter won the race.
  if (round === null && !force) {
    await fs.mkdir(auditDir(projDir), { recursive: true });
    try {
      await fs.writeFile(sentinelPath, `${targetRound}\n${new Date().toISOString()}\n`, { flag: 'wx' });
    } catch (err) {
      if (err.code === 'EEXIST') {
        return {
          promoted: false,
          reason: 'Concurrent promote completed first or audit already promoted.',
          auditFile: audit,
          round: targetRound,
        };
      }
      return { promoted: false, reason: `I/O failure writing sentinel: ${err.message}`, auditFile: audit, round: targetRound };
    }
  }

  try {
    await fs.writeFile(targetFile, formatBugsFile(convergence.contentToWrite, projectName, targetRound, auditFilename));
  } catch (err) {
    if (round === null && !force) {
      try { await fs.unlink(sentinelPath); } catch { /* best-effort — orphan sentinel is recoverable by force:true */ }
    }
    return { promoted: false, reason: `I/O failure writing bugs.md: ${err.message}`, auditFile: audit, round: targetRound };
  }
  await writeSourceAuditPointer(targetDir, projDir, audit);
  await appendFindingHistory(projDir, convergence.historyLines);
  return {
    promoted: true, appended: false, round: targetRound, bugsPath: targetFile, auditFile: audit,
    warning: extracted.warning, ...auditYield, ...convergenceReturn,
  };
}
