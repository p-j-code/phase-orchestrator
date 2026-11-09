// requireConfirmation — human-in-the-loop gate for consequential, hard-to-undo
// actions that would otherwise fire autonomously on ordinary operational events
// (self-heal editing live orchestrator source + git push; appending an
// AI-synthesised discussion conclusion to the active brief).
//
// Design (Phase 13):
//   - A pending_confirmations SQLite row is the source of truth (src/state.js).
//     The nonce (crypto.randomBytes(4) → 8 hex) is embedded in Telegram callback
//     data (cf:<id>:<nonce>:<optIdx>) and used to resolve the correct row.
//   - When a notifier is present, post the summary + an inline keyboard and POLL
//     the row until it is resolved (Telegram cf:* handler) or its TTL expires.
//   - Differentiated TTLs are mandatory (a global TTL was explicitly rejected):
//       • self-heal   → caller supplies a bounded timeout so a sleeping
//                        operator never occupies the only overnight worker.
//       • brief-append→ ttlMs 5 min → expire to the default option (Discard); a
//                        stale 4-hour-old brief confirmation is worse than none.
//   - When the notifier is null (CLI-only run) fall back to a synchronous
//     readline/promises prompt — never silently disable the gate, never block.
//   - When a notifier exists but delivered to nobody (no allowlisted users /
//     send failed), return reason:'undelivered' WITHOUT waiting — the caller
//     decides (self-heal writes a fallback log + pauses; brief discards).

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  createPendingConfirmation,
  getPendingConfirmation,
  resolvePendingConfirmation,
  expirePendingConfirmation,
} from '../state.js';

export const CONFIRM_PREFIX = 'cf';
const TELEGRAM_CALLBACK_LIMIT = 64; // bytes — hard Telegram API limit
const DEFAULT_POLL_MS = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Build the Telegram callback_data for one confirmation option. Stays well
 * under the 64-byte limit: short prefix + numeric id + 8-hex nonce + numeric
 * index (e.g. "cf:1234:ab12cd34:2" → 18 bytes). Throws if a pathological id
 * ever pushes it over the limit so the violation surfaces in tests, not in a
 * silently-dropped Telegram button.
 */
export function buildConfirmCallbackData(id, nonce, optIdx) {
  const data = `${CONFIRM_PREFIX}:${id}:${nonce}:${optIdx}`;
  if (Buffer.byteLength(data, 'utf8') > TELEGRAM_CALLBACK_LIMIT) {
    throw new Error(`confirm callback_data exceeds ${TELEGRAM_CALLBACK_LIMIT} bytes: ${data}`);
  }
  return data;
}

/** Inline keyboard: one button per option, stacked vertically. */
function buildKeyboard(id, nonce, options) {
  return {
    inline_keyboard: options.map((o, idx) => [
      { text: o.label, callback_data: buildConfirmCallbackData(id, nonce, idx) },
    ]),
  };
}

/**
 * Default CLI prompt (readline/promises). Returns the chosen option id, or
 * `undefined` when no interactive TTY is attached (headless/detached process
 * with no notifier) so requireConfirmation can fall back to the default option
 * rather than hang on a dead stdin.
 */
async function defaultCliPrompt({ summary, options, defaultOption }) {
  if (!input.isTTY) return undefined; // cannot prompt — caller uses default
  const rl = readline.createInterface({ input, output });
  try {
    const lines = [
      '',
      summary,
      '',
      ...options.map((o, idx) => `  ${idx + 1}. ${o.label}`),
      '',
    ];
    output.write(lines.join('\n'));
    const defIdx = defaultOption != null ? options.findIndex((o) => o.id === defaultOption) : -1;
    const hint = defIdx >= 0 ? ` [default ${defIdx + 1}]` : '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const answer = (await rl.question(`Choose 1-${options.length}${hint}: `)).trim();
      if (!answer && defIdx >= 0) return options[defIdx].id;
      const n = Number.parseInt(answer, 10);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].id;
      output.write('Invalid choice.\n');
    }
    // Exhausted attempts — fall back to the safe default if one exists.
    return defIdx >= 0 ? options[defIdx].id : null;
  } finally {
    rl.close();
  }
}

/**
 * Gate an action behind operator confirmation.
 *
 * @param {object}   opts
 * @param {string}   opts.action          short action kind, e.g. 'self-heal' | 'brief-append'
 * @param {string|null} [opts.project]    project name (null = orchestrator-level)
 * @param {string}   opts.summary         human-readable summary (HTML-safe; goes to Telegram + CLI + DB)
 * @param {Array<{id:string,label:string}>} opts.options  choices (≥1)
 * @param {string|null} [opts.defaultOption]  option id applied on TTL expiry / CLI fallback
 * @param {number|null} [opts.ttlMs]      expiry in ms; null = wait indefinitely
 * @param {object|null} [opts.notifier]   Notifier instance; null = CLI readline fallback
 * @param {number}   [opts.pollIntervalMs]
 * @param {function} [opts.promptFn]      override the CLI prompt (tests)
 * @returns {Promise<{resolved:boolean, option:string|null, reason:string, id:number, nonce:string}>}
 *   reason ∈ 'telegram' | 'cli' | 'expired' | 'undelivered' | 'no-tty' | 'gone'
 */
export async function requireConfirmation({
  action,
  project = null,
  summary = '',
  options,
  defaultOption = null,
  ttlMs = null,
  notifier = null,
  pollIntervalMs = DEFAULT_POLL_MS,
  promptFn = defaultCliPrompt,
}) {
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error('requireConfirmation: options must be a non-empty array');
  }

  const { id, nonce, expiresAt } = createPendingConfirmation({
    action, project, summary, options, defaultOption, ttlMs,
  });

  // ── CLI-only path (no notifier) ────────────────────────────────────────────
  if (!notifier) {
    let chosen;
    try {
      chosen = await promptFn({ action, summary, options, defaultOption });
    } catch {
      chosen = undefined;
    }
    if (chosen === undefined) {
      // No interactive TTY — cannot block on a dead stdin. Fall back to default.
      expirePendingConfirmation(id);
      return { resolved: false, option: defaultOption, reason: 'no-tty', id, nonce };
    }
    const optionId = chosen ?? defaultOption ?? null;
    resolvePendingConfirmation(nonce, optionId, null);
    return { resolved: optionId != null, option: optionId, reason: 'cli', id, nonce };
  }

  // ── Notifier path: post the gate, then poll the row ──────────────────────────
  let delivered = 1;
  try {
    const res = await notifier.notify({
      text: summary,
      replyMarkup: buildKeyboard(id, nonce, options),
    });
    // Newer Notifier reports { delivered }. Unknown notifiers that return
    // nothing are assumed reachable (avoid a false "unreachable").
    if (res && typeof res.delivered === 'number') delivered = res.delivered;
  } catch {
    delivered = 0;
  }

  if (delivered === 0) {
    // Nobody can answer — do not wait. Caller handles per-action fallback.
    return { resolved: false, option: null, reason: 'undelivered', id, nonce };
  }

  const expiryMs = expiresAt != null ? Date.parse(expiresAt) : null;
  for (;;) {
    const row = getPendingConfirmation(id);
    if (!row) return { resolved: false, option: defaultOption, reason: 'gone', id, nonce };
    if (row.status === 'resolved') {
      return { resolved: true, option: row.chosen_option, reason: 'telegram', id, nonce };
    }
    if (row.status === 'expired') {
      return { resolved: false, option: defaultOption, reason: 'expired', id, nonce };
    }
    if (expiryMs != null && Date.now() >= expiryMs) {
      expirePendingConfirmation(id);
      return { resolved: false, option: defaultOption, reason: 'expired', id, nonce };
    }
    await sleep(pollIntervalMs);
  }
}
