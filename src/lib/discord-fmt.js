// Discord formatting utilities — replaces telegram-fmt.js for Discord output.
// Discord uses Markdown, not HTML. All convert* functions are safe to call
// with null/undefined input (return '').

/**
 * Converts Telegram-style HTML to Discord Markdown.
 * Handles the subset used by handlers: <b>, <i>, <code>, <pre>, <a>.
 */
export function htmlToDiscord(html) {
  if (!html) return '';
  return String(html)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/<b>([\s\S]*?)<\/b>/g, '**$1**')
    .replace(/<strong>([\s\S]*?)<\/strong>/g, '**$1**')
    .replace(/<i>([\s\S]*?)<\/i>/g, '*$1*')
    .replace(/<em>([\s\S]*?)<\/em>/g, '*$1*')
    .replace(/<pre>([\s\S]*?)<\/pre>/g, '```\n$1\n```')
    .replace(/<code>([\s\S]*?)<\/code>/g, '`$1`')
    .replace(/<a href="([^"]*)">([\s\S]*?)<\/a>/g, '[$2]($1)')
    .replace(/<[^>]+>/g, ''); // strip remaining tags
}

/**
 * Escapes Discord Markdown special characters in user-supplied strings
 * that should appear as plain text (project names, file paths, etc.)
 */
export function escapeMarkdown(text) {
  if (!text) return '';
  return String(text).replace(/([*_`~|\\>#])/g, '\\$1');
}

// Alias used by handlers that previously imported escapeHtml/sanitizeForTelegram
export const escapeHtml = escapeMarkdown;
export const sanitizeForTelegram = escapeMarkdown;

/**
 * Splits content into Discord-safe chunks (≤1900 chars, leaving headroom for
 * code blocks and Discord's 2000-char message limit).
 * Splits on newline boundaries; falls back to hard split for long single lines.
 */
export function splitForDiscord(content, maxChars = 1900) {
  if (content.length <= maxChars) return [content];

  const chunks = [];
  const lines = content.split('\n');
  let buf = '';

  for (const line of lines) {
    if ((buf + line + '\n').length > maxChars && buf.length > 0) {
      chunks.push(buf);
      buf = '';
    }
    buf += line + '\n';
  }
  if (buf.length > 0) chunks.push(buf);

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

// Alias for code that imported splitForTelegram
export const splitForTelegram = splitForDiscord;

/**
 * Truncates a string to fit within Discord's 100-char customId limit.
 * Leaves some headroom for safety.
 */
export function truncateId(str, max = 90) {
  if (!str) return '';
  const s = String(str);
  return s.length <= max ? s : s.slice(0, max);
}
