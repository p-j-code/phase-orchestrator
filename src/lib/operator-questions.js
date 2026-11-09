// Operator-questions notification + answer loop (Phase 49 / P6) — closes the
// loop the phase-48 `ask_operator` MCP tool opened. Two halves:
//
//   1. A notification POLLER (mirrors src/lib/project-watchdog.js's unref'd
//      setInterval precedent): every tick, finds `operator_questions` rows
//      that are still `open` and haven't been notified yet, sends them via
//      the platform notifier, then marks them notified. Telegram gets an
//      inline keyboard (one button per option + "Confirm assumption");
//      Discord is TEXT-ONLY per the brief (inline buttons out of scope this
//      cycle) — `includeButtons: false` skips the replyMarkup.
//   2. Answer RESOLUTION (`resolveOperatorQuestion`) — shared by the Telegram
//      inline-button callback and the `/oq <id> <answer…>` free-text command
//      (src/server/telegram-handlers.js). Idempotent (a second resolve on an
//      already-answered row is a no-op), appends a superseding
//      `OPERATOR ANSWER to question #<id>: <answer>` decision to the
//      project's .guide/decisions.jsonl (riding the EXISTING
//      decisions-injection into future prompts — zero prompt-assembly
//      changes), and surfaces (inform-only, never automates) a contradiction
//      with the originally recorded assumption by recommending
//      `retry-phase` on the phase(s) that ran since the question was asked.
//
// Pure/testable: no bot/transport types appear anywhere in this module —
// callers pass a plain `{ notify({text, replyMarkup}) }` notifier.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  listOperatorQuestions, answerOperatorQuestion, reopenOperatorQuestion,
  markOperatorQuestionNotified, getPhases,
} from '../state.js';
import { guideRoot, assertInsideDir } from './guide-paths.js';
import { DECISION_LIMITS } from './decisions-schema.js';
import { sanitizeForTelegram } from './telegram-fmt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');

const TELEGRAM_CALLBACK_LIMIT = 64; // bytes — hard Telegram API limit
export const OQ_PREFIX = 'oq';
export const OQ_ASSUME_TOKEN = 'assume';
export const OPERATOR_ANSWER_MAX_CHARS = 400;

/**
 * Build the Telegram callback_data for one operator-question option:
 * `oq:<id>:<index>`, or `oq:<id>:assume` for the "Confirm assumption" button.
 * Indices only — never the option text — keeps this well under the 64-byte
 * limit regardless of option label length.
 */
export function buildOqCallbackData(id, token) {
  const data = `${OQ_PREFIX}:${id}:${token}`;
  if (Buffer.byteLength(data, 'utf8') > TELEGRAM_CALLBACK_LIMIT) {
    throw new Error(`oq callback_data exceeds ${TELEGRAM_CALLBACK_LIMIT} bytes: ${data}`);
  }
  return data;
}

function parseOptions(row) {
  if (!row?.options) return [];
  try {
    const arr = JSON.parse(row.options);
    return Array.isArray(arr) ? arr.filter((o) => typeof o === 'string') : [];
  } catch {
    return [];
  }
}

/** Render the notification text (HTML) for an open operator question. */
export function renderOperatorQuestionText(row) {
  const phaseTxt = row.phase != null ? `phase ${row.phase}` : 'phase unspecified';
  return (
    `❓ <b>Operator question #${row.id}</b> — ${sanitizeForTelegram(row.project)} (${phaseTxt})\n\n` +
    `${sanitizeForTelegram(row.question)}\n\n` +
    `<i>Recorded assumption — run is proceeding on this:</i>\n${sanitizeForTelegram(row.assumption)}`
  );
}

/** Render the resolved/edited version of the message after an answer lands. */
export function renderOperatorQuestionResolvedText(row) {
  const base = renderOperatorQuestionText(row);
  const who = row.status === 'answered' ? sanitizeForTelegram(String(row.answer ?? '')) : '(pending)';
  return `${base}\n\n— <b>Resolved:</b> ${who}`;
}

/** One button per option, plus a trailing "Confirm assumption" button. */
export function buildOperatorQuestionKeyboard(row) {
  const options = parseOptions(row);
  const rows = options.map((label, idx) => ([
    { text: label.length > 60 ? `${label.slice(0, 57)}…` : label, callback_data: buildOqCallbackData(row.id, idx) },
  ]));
  rows.push([{ text: 'Confirm assumption', callback_data: buildOqCallbackData(row.id, OQ_ASSUME_TOKEN) }]);
  return { inline_keyboard: rows };
}

// ─── Poller ─────────────────────────────────────────────────────────────────

/**
 * One poller tick: notify every `open` question that hasn't been notified
 * yet, then stamp `notified_at`. Exported standalone (no timers, no real
 * bot) so tests can drive it with a fake notifier.
 *
 * @param {{cfg?: object, notifier?: {notify: Function}, includeButtons?: boolean}} opts
 * @returns {Promise<number[]>} ids notified this tick
 */
export async function operatorQuestionsTick({ cfg = null, notifier = null, includeButtons = true } = {}) {
  if (!notifier) return [];
  if (cfg?.operator_questions?.enabled === false) return [];

  const open = listOperatorQuestions({ status: 'open' }).filter((r) => !r.notified_at);
  const notifiedIds = [];
  for (const row of open) {
    const payload = { text: renderOperatorQuestionText(row) };
    if (includeButtons) payload.replyMarkup = buildOperatorQuestionKeyboard(row);
    try {
      await notifier.notify(payload);
    } catch (err) {
      console.warn(`[operator-questions] notify failed for #${row.id}: ${err.message}`);
      continue; // leave notified_at null — retried next tick
    }
    markOperatorQuestionNotified(row.id);
    notifiedIds.push(row.id);
  }
  return notifiedIds;
}

let _timer = null;
let _running = false;

/**
 * Start the unref'd poller (project-watchdog.js precedent). No-op (and no
 * interval registered) when `cfg.operator_questions.enabled === false`.
 * @returns {() => void} stop function
 */
export function startOperatorQuestionsPoller({ intervalMs = 30_000, cfg = null, notifier = null, includeButtons = true } = {}) {
  if (cfg?.operator_questions?.enabled === false) return () => {};
  if (_timer) return () => stopOperatorQuestionsPoller(); // already running

  const tick = async () => {
    if (_running) return; // skip if previous tick still in progress
    _running = true;
    try {
      await operatorQuestionsTick({ cfg, notifier, includeButtons });
    } catch (e) {
      console.warn(`[operator-questions] tick error: ${e.message}`);
    } finally {
      _running = false;
    }
  };

  _timer = setInterval(tick, intervalMs);
  if (_timer.unref) _timer.unref(); // don't block process exit
  return () => stopOperatorQuestionsPoller();
}

export function stopOperatorQuestionsPoller() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    _running = false;
  }
}

/** Test/introspection seam only — true while the poller interval is registered. */
export function isOperatorQuestionsPollerRunning() {
  return _timer !== null;
}

// ─── Answer resolution ──────────────────────────────────────────────────────

/** Look up a single row by id. Table is small — a full scan is fine. */
export function getOperatorQuestionById(id) {
  return listOperatorQuestions({}).find((r) => r.id === id) ?? null;
}

/**
 * Resolve a callback token (`<index>` or `'assume'`) against a row's stored
 * options/assumption. Returns null for an out-of-range index or corrupt
 * options JSON — callers treat that as "unknown option".
 */
export function resolveAnswerFromToken(row, token) {
  if (token === OQ_ASSUME_TOKEN) return row.assumption;
  const idx = Number.parseInt(token, 10);
  if (!Number.isInteger(idx) || idx < 0) return null;
  const options = parseOptions(row);
  return options[idx] ?? null;
}

async function appendDecision(projectDir, entry) {
  const decisionsPath = await assertInsideDir(guideRoot(projectDir), path.join(guideRoot(projectDir), 'decisions.jsonl'));
  await fs.appendFile(decisionsPath, `${JSON.stringify(entry)}\n`, 'utf-8');
}

function buildAnswerDecisionEntry(row, answer) {
  return {
    phase: row.phase != null ? String(row.phase) : 'ask_operator',
    title: `Operator answer #${row.id}`.slice(0, DECISION_LIMITS.title),
    decision: `OPERATOR ANSWER to question #${row.id}: ${answer}`.slice(0, DECISION_LIMITS.decision),
    rationale: row.question.slice(0, DECISION_LIMITS.rationale),
    type: 'deferral',
  };
}

/**
 * Phase numbers that completed AFTER the question was asked — these ran on
 * what is now (post-answer) a contradicted assumption.
 */
export function findPhasesSinceQuestion(project, createdAt, deps = {}) {
  const getPhasesFn = deps.getPhases ?? getPhases;
  const phases = getPhasesFn(project) || [];
  return phases
    .filter((p) => p.completed_at && createdAt && p.completed_at > createdAt)
    .map((p) => p.n)
    .sort((a, b) => a - b);
}

/** Inform-only contradiction notice — never triggers an automatic retry. */
export function buildContradictionFollowupText(row, phasesSince) {
  const project = sanitizeForTelegram(row.project);
  const phaseList = phasesSince.length ? phasesSince.join(', ') : '(none completed yet)';
  const retryHint = phasesSince.length
    ? phasesSince.map((n) => `npm run retry-phase -- ${row.project} ${n}`).join('\n')
    : `npm run retry-phase -- ${row.project} <phase>`;
  return (
    `⚠ <b>Contradicted assumption</b> — ${project}, question #${row.id}\n\n` +
    `Your answer differs from the recorded assumption ` +
    `(<i>"${sanitizeForTelegram(row.assumption)}"</i>). Phase(s) ${phaseList} ran on that now-contradicted ` +
    `assumption.\n\nRecommended — retry the affected phase(s):\n<code>${retryHint}</code>`
  );
}

/**
 * Resolve an operator question's answer end-to-end: idempotent DB update,
 * decisions.jsonl append, and contradiction detection. Never touches a
 * chat/bot API — callers (Telegram callback, `/oq` command) render the
 * returned `followupText` themselves.
 *
 * @param {{id:number, answer:string, answeredBy?:number|string|null}} args
 * @param {{getPhases?: Function, projectsDir?: string}} [deps] - injectable seam for tests
 * @returns {Promise<{found:boolean, applied?:boolean, row?:object, contradiction?:boolean, followupText?:string|null}>}
 */
export async function resolveOperatorQuestion({ id, answer, answeredBy = null }, deps = {}) {
  const normalizedAnswer = typeof answer === 'string' ? answer.trim() : '';
  if (!normalizedAnswer) throw new Error('Operator answer must be a non-empty string');
  if (normalizedAnswer.length > OPERATOR_ANSWER_MAX_CHARS) {
    const err = new Error(`Operator answer must be ${OPERATOR_ANSWER_MAX_CHARS} characters or fewer`);
    err.code = 'OPERATOR_ANSWER_TOO_LONG';
    throw err;
  }
  const row = getOperatorQuestionById(id);
  if (!row) return { found: false };
  if (row.status !== 'open') {
    return { found: true, applied: false, row };
  }

  const changes = answerOperatorQuestion(id, { answer: normalizedAnswer, answered_by: answeredBy });
  if (changes === 0) {
    // Raced with another resolver between our status check and the UPDATE.
    return { found: true, applied: false, row: getOperatorQuestionById(id) ?? row };
  }

  const updated = getOperatorQuestionById(id);
  const projectDir = path.join(deps.projectsDir ?? PROJECTS_DIR, updated.project);
  try {
    await appendDecision(projectDir, buildAnswerDecisionEntry(updated, normalizedAnswer));
  } catch (err) {
    const compensated = reopenOperatorQuestion(id, {
      answer: normalizedAnswer,
      answered_at: updated.answered_at,
    });
    err.code = err.code || 'OPERATOR_DECISION_WRITE_FAILED';
    err.compensated = compensated > 0;
    throw err;
  }

  const contradiction = normalizedAnswer !== String(updated.assumption).trim();
  let followupText = null;
  if (contradiction) {
    const phasesSince = findPhasesSinceQuestion(updated.project, updated.created_at, deps);
    followupText = buildContradictionFollowupText(updated, phasesSince);
  }
  return { found: true, applied: true, row: updated, contradiction, followupText };
}
