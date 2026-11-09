// src/lib/telegram-fmt.js — sanitize user-controlled strings for Telegram HTML.
//
// Two responsibilities, both needed before any user-controlled string lands
// in a Telegram message with parse_mode: 'HTML':
//
//   1. Escape HTML special chars (& < >) — otherwise the message either
//      renders wrong or, worse, the entire send fails when Telegram's HTML
//      parser sees malformed tags.
//   2. Wrap filename-looking patterns in <code> tags so Telegram's
//      URL auto-detector doesn't turn `bugs-round-1.md` into a clickable
//      <https://bugs-round-1.md/> link. The .md TLD (Moldova) and .ai TLD
//      especially trip this; .json, .yml, etc. are at lower risk but still
//      look "wrong" when underlined as a URL.
//
// History: v0.14.20 fixed this in /req_promote's reply by adding the <code>
// wrap inline at that one site. v0.14.25 fixed the resume-loop on the same
// pause reason but kept the bare filename. v0.14.26 (this file) centralises
// the fix so every site that pulls auto-runner pause reasons into a Telegram
// message gets the same treatment automatically.
//
// Used by:
//   - src/server/telegram-parity-handlers.js (handleCoach)
//   - src/server/job-runner.js (pause / completion / failure notifies)
//   - src/server/notifier.js (any other future notifications)

// Filename extensions Telegram is known to mis-detect or that have ccTLD
// collisions. Keep this list narrow — broader patterns risk wrapping things
// that aren't filenames (e.g. version numbers).
const FILENAME_EXTS = [
  'md', 'json', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'yml', 'yaml', 'toml', 'lock',
  'html', 'css', 'sh', 'py', 'rb', 'go', 'rs', 'java',
  'sql', 'log', 'txt', 'csv', 'tsv',
];
const FILENAME_PATTERN = new RegExp(
  String.raw`\b([\w][\w.-]*\.(?:${FILENAME_EXTS.join('|')}))\b`,
  'g',
);

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function wrapFilenames(s) {
  return s.replace(FILENAME_PATTERN, '<code>$1</code>');
}

/**
 * The default sanitiser for any user-controlled string going to Telegram in
 * HTML parse mode. Escapes HTML first (so any `<` or `>` in the input becomes
 * harmless), then wraps recognised filenames in <code>. The escape step
 * cannot reintroduce <code>-like patterns into the input, so the regex below
 * runs against the escaped form safely.
 *
 * @param {string} s
 * @returns {string}
 */
export function sanitizeForTelegram(s) {
  return wrapFilenames(escapeHtml(s));
}
