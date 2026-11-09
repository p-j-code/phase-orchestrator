#!/usr/bin/env node
// Orchestrator Server — entry point. Reads bot.provider from the resolved config
// (defaults → ~/.ashmero-orchestrator/user.json cascade via config-resolver) and
// delegates to server-discord.js (Discord) or server-telegram.js (Telegram).
//
// Usage:  npm run server
// Switch: set "bot": { "provider": "telegram" } or "discord" in config/defaults.json
//         or override in ~/.ashmero-orchestrator/user.json (user layer takes precedence)

import { resolve } from './config-resolver.js';

let provider = 'discord';
try {
  const cfg = await resolve();
  provider = cfg?.bot?.provider || 'discord';
} catch { /* use discord as fallback */ }

if (provider === 'telegram') {
  await import('./server-telegram.js');
} else {
  await import('./server-discord.js');
}
