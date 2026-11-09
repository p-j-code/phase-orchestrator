// Stream-json log parsing — shared by the web-ui LiveLog tail (src/web-ui.js)
// and the failure autopsy (src/lib/autopsy.js). Extracted from web-ui.js
// (phase 62) so the two consumers share ONE parser instead of duplicating it.
//
// Logs are written by claude-runner.js as
//   `${project}-${task}-${timestamp}.stdout.log`
// where each line is one claude stream-json event. Unparseable lines (partial
// writes, ANSI noise) are skipped by construction — every helper here is
// total and never throws on malformed input.

import fs from 'node:fs/promises';
import path from 'node:path';

// Compact one-line summary of a tool_use input — prefer the human-meaningful field.
export function summarizeToolInput(input) {
  if (input == null || typeof input !== 'object') return String(input ?? '').slice(0, 200);
  const key = ['command', 'file_path', 'description', 'path', 'pattern', 'prompt', 'url']
    .find(k => typeof input[k] === 'string' && input[k].length > 0);
  const raw = key ? input[key] : JSON.stringify(input);
  return String(raw).replace(/\s+/g, ' ').slice(0, 200);
}

// Extract plain text from a tool_result content field (string or content-block array).
export function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text).join(' ');
  }
  return '';
}

// One stream-json log line → zero or more UI entries {t, name?, detail}.
// Unparseable lines are skipped (partial writes, ANSI noise, etc.).
export function mapStreamJsonLine(line) {
  let obj;
  try { obj = JSON.parse(line); } catch { return []; }
  if (!obj || typeof obj !== 'object') return [];

  if (obj.type === 'system' && obj.subtype === 'init') {
    return [{ t: 'init', detail: `session started (model ${obj.model || 'unknown'})` }];
  }

  if (obj.type === 'assistant') {
    const content = obj.message?.content;
    if (!Array.isArray(content)) return [];
    const out = [];
    for (const item of content) {
      if (item?.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
        out.push({ t: 'text', detail: item.text.slice(0, 200) });
      } else if (item?.type === 'tool_use') {
        out.push({ t: 'tool', name: item.name || 'tool', detail: summarizeToolInput(item.input) });
      }
    }
    return out;
  }

  if (obj.type === 'user') {
    const content = obj.message?.content;
    if (!Array.isArray(content)) return [];
    const out = [];
    for (const item of content) {
      if (item?.type !== 'tool_result') continue;
      const text = toolResultText(item.content).trim();
      if (!text) continue; // skip empty results
      const entry = { t: 'result', detail: text.slice(0, 160) };
      if (typeof item.name === 'string' && item.name) entry.name = item.name; // rarely present
      out.push(entry);
    }
    return out;
  }

  if (obj.type === 'result') {
    const cost = obj.total_cost_usd ?? obj.cost_usd ?? obj.usage?.cost_usd ?? 0;
    return [{ t: 'result', detail: `done — ${obj.subtype || ''} cost $${Number(cost).toFixed(4)}` }];
  }

  return [];
}

// ─── Log-tail reader (phase 62) ──────────────────────────────────────────────
// Find the newest `${project}-*.stdout.log`, read its last ~maxBytes, parse it
// with mapStreamJsonLine, and return the last `maxEntries` UI entries. Purely
// best-effort — a missing logs dir, a raced deletion, or a truncated read all
// degrade to []. Never throws. Used by the autopsy's deterministic context
// assembly; the web-ui LiveLog route keeps its own cached inline reader.
export async function readRecentLogEntries(logsDir, project, { maxBytes = 256 * 1024, maxEntries = 30 } = {}) {
  if (!logsDir || !project) return [];
  const prefix = `${project}-`;
  let names;
  try { names = await fs.readdir(logsDir); } catch { return []; }

  let newest = null;
  for (const f of names) {
    if (!f.startsWith(prefix) || !f.endsWith('.stdout.log')) continue;
    try {
      const st = await fs.stat(path.join(logsDir, f));
      if (!newest || st.mtimeMs > newest.mtimeMs) newest = { file: f, mtimeMs: st.mtimeMs, size: st.size };
    } catch { /* raced deletion — skip */ }
  }
  if (!newest) return [];

  let text;
  let truncated = false;
  let fh = null;
  try {
    fh = await fs.open(path.join(logsDir, newest.file), 'r');
    const start = Math.max(0, newest.size - maxBytes);
    truncated = start > 0;
    const len = newest.size - start;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    text = buf.toString('utf-8');
  } catch { return []; }
  finally { try { await fh?.close(); } catch { /* already closed */ } }

  let rawLines = text.split('\n');
  if (truncated) rawLines = rawLines.slice(1); // drop the partial first line
  const entries = [];
  for (const line of rawLines) {
    if (!line.trim()) continue;
    entries.push(...mapStreamJsonLine(line));
  }
  return entries.slice(-maxEntries);
}
