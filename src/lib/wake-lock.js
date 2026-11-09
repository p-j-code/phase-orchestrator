// Wake lock — keeps the host system awake during long-running orchestrator
// operations. On macOS uses `caffeinate -i -s` (prevents idle sleep + system
// sleep on AC). On non-Darwin platforms it's a no-op (NAS / Linux servers
// don't need this).
//
// Reference-counted singleton: multiple callers can preventSleep() concurrently;
// caffeinate runs as long as at least one ref is active.
//
// Safe to call from anywhere — never throws, never blocks.

import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import chalk from 'chalk';

const IS_DARWIN = platform() === 'darwin';

let _proc = null;
let _refCount = 0;
let _enabled = true;
let _warned = false;
let _registered = false;

/** Configure whether wake lock is allowed to engage at all. */
export function configureWakeLock({ enabled = true } = {}) {
  _enabled = enabled !== false;
}

/** Acquire a wake lock. Idempotent per-caller — call preventSleep() once,
 *  call allowSleep() once. */
export function preventSleep() {
  if (!IS_DARWIN || !_enabled) return;
  _refCount += 1;
  if (_proc) return;
  try {
    _proc = spawn('caffeinate', ['-i', '-s'], { stdio: 'ignore', detached: false });
    _proc.on('exit', () => { _proc = null; });
    _proc.on('error', (err) => {
      if (!_warned) {
        console.warn(chalk.yellow(`[wake-lock] caffeinate unavailable: ${err.message}`));
        _warned = true;
      }
      _proc = null;
    });
    if (!_registered) {
      _registered = true;
      const cleanup = () => { try { releaseAll(); } catch { /* ignore */ } };
      process.once('SIGINT', cleanup);
      process.once('SIGTERM', cleanup);
      process.once('exit', cleanup);
    }
  } catch (err) {
    if (!_warned) {
      console.warn(chalk.yellow(`[wake-lock] could not spawn caffeinate: ${err.message}`));
      _warned = true;
    }
  }
}

/** Release a wake lock. Decrements ref count; only kills caffeinate at zero. */
export function allowSleep() {
  if (!IS_DARWIN || !_enabled) return;
  if (_refCount <= 0) return;
  _refCount -= 1;
  if (_refCount === 0 && _proc) {
    try { _proc.kill('SIGTERM'); } catch { /* ignore */ }
    _proc = null;
  }
}

/** Force-release all refs and kill caffeinate. Used by exit handlers. */
export function releaseAll() {
  _refCount = 0;
  if (_proc) {
    try { _proc.kill('SIGTERM'); } catch { /* ignore */ }
    _proc = null;
  }
}

/** Inspect current state — for debugging / doctor command. */
export function wakeLockStatus() {
  return {
    supported: IS_DARWIN,
    enabled: _enabled,
    active: !!_proc,
    refCount: _refCount,
  };
}
