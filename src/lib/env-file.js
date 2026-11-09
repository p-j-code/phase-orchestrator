// env-file.js — minimal .env loader (no dotenv dep; repo takes no new deps).
//
// setup-nas.sh writes REPO_ROOT/.env (CLAUDE_BIN, CLAUDE_CODE_OAUTH_TOKEN,
// LOG_LEVEL) but nothing ever loaded it — pm2 starts `node src/orchestrator.js
// web` with a bare env, so on the NAS the resolved claude_bin fell back to
// PATH lookup and the OAuth token never existed for spawned sessions.
// orchestrator.js calls loadDotEnv() at startup, so every entry path (CLI,
// web UI, chat, and everything web-ui spawns — children inherit process.env)
// sees the file.
//
// Real environment always wins: a key already present in process.env is never
// overridden, so `CLAUDE_BIN=x node src/orchestrator.js …` behaves as before.

import fsp from 'node:fs/promises';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Load KEY=VALUE pairs from a .env file into process.env (non-overriding).
 * Missing file is a silent no-op. Lines starting with `#`, blank lines, and
 * malformed keys are skipped. A leading `export ` and one layer of matching
 * single/double quotes around the value are stripped.
 *
 * @param {string} envPath - absolute path to the .env file
 * @returns {Promise<Record<string, string>>} the keys actually set
 */
export async function loadDotEnv(envPath) {
  let text;
  try {
    text = await fsp.readFile(envPath, 'utf-8');
  } catch {
    return {};
  }
  const loaded = {};
  for (const rawLine of text.split('\n')) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!KEY_RE.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded[key] = value;
    }
  }
  return loaded;
}
