// Context Freshness (Phase 17 stamping/delta + Phase 18 injection rendering +
// Phase 19 auto-refresh/notice decisions + Phase 21 guide-reground decisions,
// brief P2/P3) — src/lib/context-freshness.js
//
// Standalone, unit-testable sibling to repo-map.js (same phase-15/16 split
// rationale — verify in isolation before anything depends on it). Six
// deliverables live here:
//
// 1. stampArtifact() — the ORCHESTRATOR (never the LLM) prepends/updates
//    `{ generated_at_sha, generated_at }` front-matter on a narrative context
//    artifact (project-context.md, workspace/CLAUDE.md) right after the guide
//    call that authored it succeeds. Mirrors stampLastAudit's precedent
//    (phase-runner.js) — correctness-critical bookkeeping never goes through
//    a prompt (same reasoning as workspace-skills.js's deterministic
//    materialization).
//
// 2. contextDelta() — pure git/static analysis (zero LLM cost) that lists and
//    classifies commits landed since a given sha, via runGit (array args,
//    timeout, never throws — src/claude-runner.js:32-39).
//
// 3. renderContextDeltaBlock() — Phase 18: wraps a contextDelta() result into
//    the injectable prompt block. The fail-open wrapper that reads the
//    artifact's stamp and calls both of the above (loadContextDeltaBlock)
//    lives in phase-runner.js, mirroring loadRepoMapBlock's split between
//    "generate the data" (this module / repo-map.js) and "wire it into a
//    spawn" (phase-runner.js).
//
// 4. shouldEnqueueContextRefresh() / shouldNotifyContextDrift() — Phase 19:
//    pure threshold decisions over a contextDelta() result and
//    cfg.context_freshness. The fail-open wrapper that reads the stamp, calls
//    contextDelta AGAIN (independent of loadContextDeltaBlock's own call —
//    cheap, zero-LLM-cost, keeps render vs decide decoupled), enqueues via
//    src/server/job-queue.js's enqueueContextRefreshJob, and persists the
//    last-noticed sha (guide-paths.js's contextFreshnessStatePath) lives in
//    phase-runner.js (loadContextFreshnessCheck).
//
// 5. buildContextDriftNotifyText() — pure Telegram-line builder, mirrors
//    auto-runner.js's buildPhaseCompletionNotifyText.
//
// 6. buildGuideRegroundReason() / buildGuideRegroundNotifyText() — Phase 21:
//    pure threshold decision + Telegram-line builder over a contextDelta()
//    result and cfg.guide_reground, diffed from the GUIDE's own last-seen
//    HEAD rather than project-context.md's stamp. The fail-open wrapper that
//    fetches this delta (computeGuideHeadDelta) and the reground ACTION
//    itself (generate a handoff, clear guide_session_id, track
//    metadata_json.last_reground_sha for same-HEAD idempotency) live in
//    phase-runner.js's runGuide().
//
// Failure = degrade, never throw into a spawn: contextDelta wraps every git
// read in a try/catch and resolves to `drift: 'unknown'` on any failure —
// callers always treat 'unknown' as "say nothing definitive," never as a
// thrown error that could fail a spawn. stampArtifact itself does NOT catch —
// like stampLastAudit, the try/catch lives at the phase-runner.js call site so
// a stamping failure warns and the guide result still returns normally.

import fsp from 'node:fs/promises';

import { runGit } from '../claude-runner.js';

// ─── Front-matter (two known fields — generated_at_sha, generated_at) ──────
//
// Deliberately a narrower sibling of repo-map.js's renderFrontMatter/
// parseFrontMatter (which carries 5 fields for a different artifact schema)
// rather than a shared generic parser — the two artifacts this module stamps
// only ever need these two fields.

/**
 * @param {{generated_at_sha: string, generated_at: string}} attrs
 * @returns {string}
 */
export function renderStampFrontMatter(attrs) {
  return [
    '---',
    `generated_at_sha: ${attrs.generated_at_sha}`,
    `generated_at: ${attrs.generated_at}`,
    '---',
  ].join('\n');
}

/**
 * Parses a file written as `renderStampFrontMatter(attrs) + '\n\n' + body`
 * (the blank line is load-bearing, same convention as repo-map.js). Returns
 * null if raw has no front-matter block — legacy artifacts (generated before
 * this phase existed) fall into this case, distinctly from a body that just
 * happens to be empty.
 *
 * @param {string} raw
 * @returns {{attrs: {generated_at_sha: string|null, generated_at: string|null}, body: string}|null}
 */
export function parseStampFrontMatter(raw) {
  if (typeof raw !== 'string') return null;
  const m = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(raw);
  if (!m) return null;
  const [, fmBlock, body] = m;
  const rawAttrs = {};
  for (const line of fmBlock.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    rawAttrs[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return {
    attrs: {
      generated_at_sha: rawAttrs.generated_at_sha ?? null,
      generated_at: rawAttrs.generated_at ?? null,
    },
    body,
  };
}

/**
 * Prepend/update `{ generated_at_sha, generated_at }` front-matter on an
 * already-written artifact. Idempotent and non-duplicating: any existing
 * front-matter block (this schema or a legacy no-front-matter file) is
 * stripped before the body is re-written with fresh attrs — re-stamping never
 * accumulates blocks. `filePath` must already exist (the LLM writes the body
 * first; this only ever runs after a successful guide call).
 *
 * Does NOT catch errors — like stampLastAudit, the call site wraps this in a
 * try/catch so a read/write failure warns instead of failing the guide call.
 *
 * @param {string} filePath - absolute path to the artifact
 * @param {string} sha - HEAD sha to stamp
 * @param {{now?: string}} [opts] - `now` overrides generated_at (tests only)
 * @returns {Promise<{path: string, generated_at_sha: string, generated_at: string}>}
 */
export async function stampArtifact(filePath, sha, opts = {}) {
  const raw = await fsp.readFile(filePath, 'utf-8');
  const parsed = parseStampFrontMatter(raw);
  const body = parsed ? parsed.body : raw;
  const attrs = { generated_at_sha: sha, generated_at: opts.now ?? new Date().toISOString() };
  await fsp.writeFile(filePath, `${renderStampFrontMatter(attrs)}\n\n${body}`, 'utf-8');
  return { path: filePath, ...attrs };
}

// ─── Commit classification ───────────────────────────────────────────────────
//
// 'orchestrator' = this pipeline made the commit (phase-{n}:, fix-r{R}-{N}:,
// or either suffixed "(validator fix)" / "(acceptance fix)" — the exact
// strings phase-runner.js's post-commit-gate retry prompts use, read from the
// current source rather than guessed). Everything else — including a human
// pushing straight to the branch — is 'external'.
const ORCHESTRATOR_COMMIT_PATTERNS = Object.freeze([
  /^phase-\d+:/,
  /^fix-r\d+-\d+:/,
  /\(validator fix\)/,
  /\(acceptance fix\)/,
]);

/**
 * @param {string} subject - a commit's subject line
 * @returns {'orchestrator'|'external'}
 */
export function classifyCommit(subject) {
  const s = (subject || '').trim();
  return ORCHESTRATOR_COMMIT_PATTERNS.some((re) => re.test(s)) ? 'orchestrator' : 'external';
}

// ─── `git log --oneline --name-status` parsing ──────────────────────────────
//
// Verified against this repo's own history: with --oneline there is NO blank
// line between a commit's file-status lines and the next commit's header — so
// parsing can't rely on blank-line separators and instead distinguishes a
// header line (lowercase hex sha + SPACE) from a status line (uppercase
// status code + TAB). Git never emits a lowercase-hex-only status code and
// never abbreviates a sha to uppercase, so the two patterns cannot collide.

const LOG_HEADER_RE = /^([0-9a-f]{4,40}) (.*)$/;
const LOG_STATUS_RE = /^([A-Z]\d{0,3})\t(.+)$/;

/**
 * @param {string} raw - stdout of `git log --oneline --name-status <range>`
 * @returns {Array<{sha: string, subject: string, files: Array<{status: string, path: string}>}>}
 */
export function parseGitLogNameStatus(raw) {
  const commits = [];
  let current = null;
  for (const line of (raw || '').split('\n')) {
    if (!line) continue;
    const header = LOG_HEADER_RE.exec(line);
    if (header) {
      current = { sha: header[1], subject: header[2], files: [] };
      commits.push(current);
      continue;
    }
    const status = LOG_STATUS_RE.exec(line);
    if (status && current) current.files.push({ status: status[1], path: status[2] });
  }
  return commits;
}

// ─── contextDelta ────────────────────────────────────────────────────────────

const SHA_RE = /^[0-9a-f]{4,40}$/i;

/**
 * List and classify commits landed on `workspaceDir`'s HEAD since `sinceSha`.
 * Pure git read — zero LLM cost. Fail-open: any git error, a garbage/missing
 * `sinceSha`, or an unreadable repo resolves to `{ drift: 'unknown' }` rather
 * than throwing, so a broken git state never fails the spawn that wants this
 * data (phase 18's injection point). `sinceSha === HEAD` is the ordinary
 * "nothing changed" case — resolves to `{ drift: 'none' }` with no error.
 *
 * @param {Object} args
 * @param {string} args.workspaceDir - absolute path to the project's workspace/ (git repo root)
 * @param {string} args.sinceSha - the artifact's stamped generated_at_sha (or any commit-ish)
 * @param {number} [args.maxCommits=30] - cap on returned commits; overflow is reported, not silently dropped
 * @param {{runGit?: Function}} [deps] - injectable seam for tests
 * @returns {Promise<{drift: 'none'|'some'|'unknown', sinceSha: string|null, headSha: string|null, commits: Array, overflowCount: number, overflowLine: string|null}>}
 */
export async function contextDelta({ workspaceDir, sinceSha, maxCommits = 30 }, deps = {}) {
  const runGitFn = deps.runGit ?? runGit;
  const unknown = (extra = {}) => ({
    drift: 'unknown', sinceSha: sinceSha ?? null, headSha: null,
    commits: [], overflowCount: 0, overflowLine: null, ...extra,
  });

  try {
    const headSha = await runGitFn(['rev-parse', 'HEAD'], { cwd: workspaceDir });
    if (!headSha) return unknown();

    if (typeof sinceSha !== 'string' || !SHA_RE.test(sinceSha.trim())) return unknown({ headSha });
    const since = sinceSha.trim();

    if (since === headSha) {
      return { drift: 'none', sinceSha: since, headSha, commits: [], overflowCount: 0, overflowLine: null };
    }

    // Confirm `since` actually resolves to a commit in this repo before
    // trusting an empty log result as "no commits" rather than "bad sha" —
    // `runGit` collapses both a real error and a genuinely empty stdout to
    // null, so this check is what lets us tell them apart below.
    const kind = await runGitFn(['cat-file', '-t', since], { cwd: workspaceDir });
    if (kind !== 'commit') return unknown({ sinceSha: since, headSha });

    const raw = await runGitFn(['log', '--oneline', '--name-status', `${since}..HEAD`], { cwd: workspaceDir });
    const all = raw ? parseGitLogNameStatus(raw) : [];

    const overflowCount = Math.max(0, all.length - maxCommits);
    const commits = all.slice(0, maxCommits).map((c) => ({
      sha: c.sha,
      subject: c.subject,
      classification: classifyCommit(c.subject),
      files: c.files,
    }));

    return {
      drift: commits.length > 0 || overflowCount > 0 ? 'some' : 'none',
      sinceSha: since,
      headSha,
      commits,
      overflowCount,
      overflowLine: overflowCount > 0 ? `…and ${overflowCount} more` : null,
    };
  } catch {
    return unknown();
  }
}

// ─── Injection rendering (Phase 18, brief P2 delta-injection half) ──────────
//
// Wraps a contextDelta() result into the injectable prompt block that lands
// immediately after the narrative context block (loadProjectContextBlock's
// output) in devSystemPromptExtra/systemPromptExtra — see phase-runner.js's
// loadContextDeltaBlock, the fail-open wrapper that calls this. `stamp` is
// only used for drift:'some' (the sha/date actually being diffed from) —
// drift:'unknown' has no reliable sha/date to quote (that's exactly what
// makes it unknown), so it renders a short caution line instead of the full
// wording. drift:'none' (or no delta at all) renders nothing: the
// pre-phase-17 no-delta-support byte-identity baseline must hold whenever
// nothing changed.

/**
 * @param {{drift: 'none'|'some'|'unknown', commits: Array, overflowLine: string|null}|null} delta
 * @param {{sha?: string, date?: string}} [stamp] - the artifact's own front-matter values (drift:'some' only)
 * @returns {string|null}
 */
export function renderContextDeltaBlock(delta, stamp = {}) {
  if (!delta || delta.drift === 'none') return null;

  if (delta.drift === 'unknown') {
    return `<context_delta>
⚠ Freshness of the project context above could not be verified (no readable freshness stamp, or the stamped commit no longer exists in this repo) — treat it as potentially outdated and confirm against the current code before relying on it.
</context_delta>`;
  }

  const lines = delta.commits.map((c) => `- ${c.sha.slice(0, 8)} [${c.classification === 'external' ? 'EXTERNAL' : 'orchestrator'}] ${c.subject}`);
  if (delta.overflowLine) lines.push(delta.overflowLine);

  return `<context_delta>
The project context above was generated at ${stamp.sha} (${stamp.date}). Since then these commits landed — treat it as potentially outdated for the files they touch (EXTERNAL = pushed outside this pipeline):

${lines.join('\n')}
</context_delta>`;
}

// ─── Auto-refresh + drift-notice decisions (Phase 19, brief P2 remaining half) ─
//
// Three pure decision functions, evaluated at the SAME spawn-time contextDelta()
// call phase 18 already makes (see phase-runner.js's loadContextDeltaBlock call
// sites). All three are pure — no I/O, no job-queue/notifier imports — mirroring
// shouldInjectRepoMap's split in phase-runner.js: the DECISION lives here and is
// unit-testable with a plain delta object; the fail-open wrapper that actually
// reads a stamp, calls contextDelta, enqueues a job, and persists the
// last-noticed sha lives in phase-runner.js (loadContextFreshnessCheck).

/**
 * Should ONE project-context-gen refresh be enqueued for this delta?
 * drift:'unknown' (unstamped/corrupted artifact) always qualifies — there is
 * no better signal than "we can't tell how stale this is." drift:'none'
 * never does. drift:'some' qualifies once either threshold is crossed: total
 * commits (capped commits.length + overflowCount, i.e. the same total
 * contextDelta() itself reports) or distinct files touched by EXTERNAL
 * commits alone (overflow commits are never examined — their classification
 * is unknown by construction, and by the time overflow exists the total-commits
 * threshold has almost always already fired).
 *
 * @param {{delta: {drift: 'none'|'some'|'unknown', commits: Array, overflowCount?: number}|null, cfg?: {enabled?: boolean, regen_after_commits?: number, regen_after_external_files?: number}}} args
 * @returns {boolean}
 */
export function shouldEnqueueContextRefresh({ delta, cfg = {} }) {
  if (!delta) return false;
  if (cfg.enabled === false) return false;
  if (delta.drift === 'unknown') return true;
  if (delta.drift !== 'some') return false;

  const totalCommits = delta.commits.length + (delta.overflowCount || 0);
  if (totalCommits >= (cfg.regen_after_commits ?? 10)) return true;

  const externalFiles = new Set();
  for (const c of delta.commits) {
    if (c.classification !== 'external') continue;
    for (const f of c.files || []) externalFiles.add(f.path);
  }
  return externalFiles.size >= (cfg.regen_after_external_files ?? 5);
}

/**
 * Is this a NEW external-drift episode worth a one-time notice? Compares the
 * delta's headSha against the persisted last-noticed sha (phase-runner.js
 * reads/writes this via guide-paths.js's contextFreshnessStatePath) — a
 * repeat spawn at the SAME drifted HEAD must not re-fire. Only drift:'some'
 * with at least one EXTERNAL commit qualifies; drift:'unknown' has no sha to
 * key the notice on and no commit list to quote a count from.
 *
 * @param {{delta: {drift: string, commits: Array, headSha: string|null}|null, lastNoticedSha: string|null}} args
 * @returns {boolean}
 */
export function shouldNotifyContextDrift({ delta, lastNoticedSha }) {
  if (!delta || delta.drift !== 'some' || !delta.headSha) return false;
  const hasExternal = delta.commits.some((c) => c.classification === 'external');
  return hasExternal && delta.headSha !== lastNoticedSha;
}

/**
 * Pure builder for the drift Telegram line — mirrors auto-runner.js's
 * buildPhaseCompletionNotifyText (same "pure builder, thin call site" split).
 * Returns null when there's nothing external to report (defensive — callers
 * only invoke this after shouldNotifyContextDrift() already returned true).
 *
 * @param {{projectName: string, delta: {commits: Array}, refreshQueued: boolean}} args
 * @returns {string|null}
 */
export function buildContextDriftNotifyText({ projectName, delta, refreshQueued }) {
  const externalCount = (delta?.commits || []).filter((c) => c.classification === 'external').length;
  if (externalCount === 0) return null;
  return `⚠ ${projectName}: ${externalCount} external commit(s) detected since context was generated — refresh ${refreshQueued ? 'queued' : 'not needed'}`;
}

// ─── Guide re-grounding on large drift (Phase 21, brief P3 remaining half) ──
//
// A DIFFERENT threshold from shouldEnqueueContextRefresh above: that decides
// whether project-context.md needs a background refresh
// (context_freshness.regen_after_commits/regen_after_external_files); this
// decides whether a RESUMED guide session itself carries beliefs stale enough
// to discard and re-ground from a fresh handoff
// (guide_reground.after_commits/after_external_files — separate, higher
// default thresholds, since discarding a session is far more disruptive than
// refreshing a narrative doc). Operates on the same contextDelta() shape but
// diffed from a different anchor: the guide's own last-seen HEAD
// (metadata_json.last_guide_head_sha, phase 20) rather than
// project-context.md's stamp — see phase-runner.js's computeGuideHeadDelta,
// the fail-open wrapper that fetches this delta and feeds it here.
//
// A single function, not a separate boolean + reason pair: the returned
// reason STRING doubles as the decision (null = don't re-ground, a string =
// re-ground with this stated cause) — one source of truth for both the
// threshold check and the log/notify text, mirroring
// buildContextDriftNotifyText's null-means-nothing-to-report convention.

/**
 * @param {{delta: {drift: 'none'|'some'|'unknown', commits: Array, overflowCount?: number}|null, cfg?: {enabled?: boolean, after_commits?: number, after_external_files?: number}}} args
 * @returns {string|null}
 */
export function buildGuideRegroundReason({ delta, cfg = {} }) {
  if (!delta) return null;
  if (cfg.enabled === false) return null;
  if (delta.drift === 'unknown') {
    return "the guide's last-seen commit could not be resolved (unstamped or rewritten history) — session beliefs are unverifiable";
  }
  if (delta.drift !== 'some') return null;

  const totalCommits = delta.commits.length + (delta.overflowCount || 0);
  const afterCommits = cfg.after_commits ?? 15;
  if (totalCommits >= afterCommits) {
    return `${totalCommits} commit(s) landed since the guide last looked (threshold ${afterCommits})`;
  }

  const externalFiles = new Set();
  for (const c of delta.commits) {
    if (c.classification !== 'external') continue;
    for (const f of c.files || []) externalFiles.add(f.path);
  }
  const afterExternalFiles = cfg.after_external_files ?? 10;
  if (externalFiles.size >= afterExternalFiles) {
    return `${externalFiles.size} file(s) touched by external commits since the guide last looked (threshold ${afterExternalFiles})`;
  }

  return null;
}

/**
 * Pure builder for the re-ground Telegram line. Deliberately distinct wording
 * AND lead glyph (↺, matching the console log line) from
 * buildContextDriftNotifyText's ⚠ line — brief P3 requires the two notice
 * types to read as different episodes in a Telegram thread, not variations of
 * the same message.
 *
 * @param {{projectName: string, reason: string|null}} args
 * @returns {string|null}
 */
export function buildGuideRegroundNotifyText({ projectName, reason }) {
  if (!reason) return null;
  return `↺ ${projectName}: guide re-grounded — ${reason}`;
}
