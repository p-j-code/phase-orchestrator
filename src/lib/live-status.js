// Live Status — multi-row "spinner area" anchored at the bottom of stdout.
//
// PROBLEM (v0.14.8 and earlier):
//   `src/claude-runner.js` and `src/lib/validators.js` each construct a
//   per-call `ora()` spinner. `ora` is built for ONE active spinner per
//   terminal — it owns a single rewriting region via carriage return and
//   stdout.write monkey-patching. When the v0.14.x worker pool runs
//   concurrent jobs across projects, two or more `ora` instances fight over
//   the same TTY:
//
//     ∷ fix-execution running…   [5m 01s]✓ Pushed develop → origin (c193…)
//     ∷ fix-execution running…   [5m 03s]
//     ∷ fix-execution running…   [5m 27s]
//
//   The first line is an `ora` line that got the `git push` console.log
//   appended to it (ora's stdout patch fired on the wrong instance); the
//   second is a stranded ghost (other worker scrolled it out of the
//   "current line" before this one could clear it); only the third is live.
//   And none of them say WHICH worker / WHICH project they belong to.
//
// FIX:
//   Replace per-call `ora` with one shared LiveStatus singleton.
//
//   - Owns a fixed-height "live region" at the bottom of stdout, one row per
//     active worker entry.
//   - Each entry is keyed (typically by workerId) and rendered with its
//     project tag so parallel runs are visually distinct.
//   - Patches `process.stdout.write` and `process.stderr.write` once at
//     enable() time. Any write coming through them — including `console.log`
//     output, `ora`-emitted bytes, `git push` progress, whatever — first
//     clears the live region, lets the write land in scrollback, then
//     re-renders the live region underneath. So log lines scroll up while
//     the spinner area stays anchored.
//
// USAGE:
//   import { liveStatus } from './lib/live-status.js';
//   liveStatus.enable();                          // call once on server boot
//   const key = `runClaude:${jobId}:${task}`;
//   liveStatus.set(key, { project, task, startedAt: Date.now(), state: 'running' });
//   liveStatus.update(key, { state: 'retry-wait', attempt: 1, maxAttempts: 3 });
//   liveStatus.delete(key);
//
// DESIGN NOTES:
//   - We do NOT use ANSI alt-screen. The live region sits in the normal
//     scrollback, just like ora — we only ever clear and rewrite the last
//     `rendered` lines.
//   - Width clipping uses a small ANSI-aware visible-length count (chalk's
//     output is wrapped in ESC sequences which take 0 columns). Without
//     clipping a long task name wraps to multiple display rows but counts
//     as 1 logical line, and our \x1B[1A clear loop would leave debris.
//   - SIGWINCH (terminal resize) triggers a re-render so widths stay sane.
//   - Non-TTY (logs piped to file, CI) → enable() is a no-op. Spinner
//     entries still get set/deleted but render writes nothing. Job-runner
//     emits explicit start/finish console.logs in that mode (see
//     claude-runner.js fallback path) so the audit trail is preserved.
//   - The spinner FRAMES and tick interval are deliberately conservative
//     (10 frames, 100ms) so we don't burn CPU re-rendering on idle servers.

import chalk from 'chalk';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const TICK_MS = 100;

// Strip ANSI escapes for visible-length measurement. Tight regex covers SGR
// (CSI ... m), cursor moves (CSI ... A/B/C/D/H/J/K), and the few other
// sequences chalk emits. Avoids pulling in `strip-ansi` as a new dep.
const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/g;
function visibleLen(s) {
  return s.replace(ANSI_RE, '').length;
}
function clipToWidth(s, width) {
  // We want to truncate by visible columns but keep ANSI sequences. Easy
  // path: if visibleLen <= width, return as-is. Otherwise, walk the string,
  // counting visible chars, and emit a hard cut at `width - 1`. We accept
  // that a truncation in the middle of an ANSI sequence is pathological;
  // chalk's color codes are short and wrap pairs, so we just look for the
  // common case and append a reset.
  if (visibleLen(s) <= width) return s;
  let out = '';
  let count = 0;
  let i = 0;
  while (i < s.length && count < width - 1) {
    if (s[i] === '\x1B' && s[i + 1] === '[') {
      const end = s.indexOf('m', i);
      if (end !== -1 && end - i < 16) {
        out += s.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    out += s[i];
    count += 1;
    i += 1;
  }
  return out + '…\x1B[0m';
}

function formatElapsed(ms) {
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

class LiveStatus {
  constructor() {
    this.entries = new Map();      // key -> entry
    this.rendered = 0;             // current lines occupied
    this.frame = 0;
    this.timer = null;
    this.enabled = false;
    this._origStdoutWrite = null;
    this._origStderrWrite = null;
    this._writingFromSelf = false; // re-entry guard for spinner writes
    this._sigwinchHandler = null;
    this._exitHandlers = null;
  }

  // Idempotent. Call once on server boot. No-ops in non-TTY or when the
  // ORCHESTRATOR_NO_SPINNER env var is set.
  enable() {
    if (this.enabled) return;
    if (!process.stdout.isTTY) return;
    if (process.env.ORCHESTRATOR_NO_SPINNER === '1') return;
    this.enabled = true;

    this._origStdoutWrite = process.stdout.write.bind(process.stdout);
    this._origStderrWrite = process.stderr.write.bind(process.stderr);

    const wrap = (orig) => (chunk, encoding, callback) => {
      if (this._writingFromSelf) {
        return orig(chunk, encoding, callback);
      }
      // Foreign write (console.log, ora bytes, anything). Clear the live
      // region first so it doesn't get pushed up and "ghosted" above the
      // log line.
      this._clear();
      const r = orig(chunk, encoding, callback);
      // Re-render the live region beneath the new log line. We schedule a
      // synchronous render to keep stdout coherent for the caller.
      this._render();
      return r;
    };
    process.stdout.write = wrap(this._origStdoutWrite);
    process.stderr.write = wrap(this._origStderrWrite);

    // Animation tick
    this.timer = setInterval(() => {
      if (this.entries.size === 0) return;
      this.frame = (this.frame + 1) % FRAMES.length;
      this._render();
    }, TICK_MS);
    this.timer.unref?.();

    // Hide cursor while we own the spinner region
    this._selfWrite('\x1B[?25l');

    // Re-render on resize so width clipping stays correct
    this._sigwinchHandler = () => this._render();
    process.stdout.on('resize', this._sigwinchHandler);

    // Restore on exit / signals
    this._exitHandlers = { exit: () => this.disable() };
    process.once('exit', this._exitHandlers.exit);
  }

  disable() {
    if (!this.enabled) return;
    this._clear();
    this.enabled = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Show cursor again
    if (this._origStdoutWrite) this._selfWrite('\x1B[?25h');
    // Unhook resize listener
    if (this._sigwinchHandler) {
      try { process.stdout.off('resize', this._sigwinchHandler); } catch { /* */ }
      this._sigwinchHandler = null;
    }
    // Restore stdout/stderr write
    if (this._origStdoutWrite) {
      process.stdout.write = this._origStdoutWrite;
      this._origStdoutWrite = null;
    }
    if (this._origStderrWrite) {
      process.stderr.write = this._origStderrWrite;
      this._origStderrWrite = null;
    }
    if (this._exitHandlers) {
      try { process.removeListener('exit', this._exitHandlers.exit); } catch { /* */ }
      this._exitHandlers = null;
    }
  }

  // Set or replace an entry. Fields:
  //   workerId?: number | string  (shown in tag)
  //   project: string             (shown in tag)
  //   task: string                (e.g. "dev-execution", "validator:eslint")
  //   startedAt: number           (Date.now() at start; drives elapsed)
  //   state?: 'running' | 'retry-wait'
  //   attempt?: number            (when state === 'retry-wait')
  //   maxAttempts?: number
  set(key, entry) {
    if (!key) return;
    const existing = this.entries.get(key);
    const merged = {
      workerId: '?',
      project: '?',
      task: '?',
      startedAt: Date.now(),
      state: 'running',
      ...existing,
      ...entry,
      key,
    };
    this.entries.set(key, merged);
    this._render();
  }

  // Patch a subset of fields on an existing entry. Useful for state
  // transitions (running ↔ retry-wait) without resetting startedAt.
  update(key, patch) {
    const existing = this.entries.get(key);
    if (!existing) return;
    this.entries.set(key, { ...existing, ...patch });
    this._render();
  }

  delete(key) {
    if (!this.entries.has(key)) return;
    this.entries.delete(key);
    this._render();
  }

  // For tests/debugging
  active() {
    return [...this.entries.values()];
  }

  // ─── internals ──────────────────────────────────────────────────────────

  _selfWrite(chunk) {
    if (!this._origStdoutWrite) return;
    this._writingFromSelf = true;
    try {
      this._origStdoutWrite(chunk);
    } finally {
      this._writingFromSelf = false;
    }
  }

  _clear() {
    if (!this.enabled || this.rendered === 0) return;
    // Cursor is one line below the last rendered line (after the trailing
    // \n from _render). Move up `rendered` lines, clearing each.
    let s = '\r';
    for (let i = 0; i < this.rendered; i += 1) {
      s += '\x1B[1A\x1B[2K';
    }
    this._selfWrite(s);
    this.rendered = 0;
  }

  _render() {
    if (!this.enabled) return;
    this._clear();
    if (this.entries.size === 0) return;

    const width = Math.max(20, process.stdout.columns || 80);
    const frameCh = chalk.cyan(FRAMES[this.frame]);
    const now = Date.now();

    // Stable sort: by workerId numerically when possible, then by key.
    const sorted = [...this.entries.values()].sort((a, b) => {
      const aw = Number(a.workerId);
      const bw = Number(b.workerId);
      if (Number.isFinite(aw) && Number.isFinite(bw) && aw !== bw) return aw - bw;
      return String(a.key).localeCompare(String(b.key));
    });

    // Two-column layout for the tag so worker rows align visually even
    // with project names of different lengths. We compute the max tag
    // width and pad.
    const tags = sorted.map((e) => `[w${e.workerId} ${e.project}]`);
    const tagWidth = Math.min(40, tags.reduce((m, t) => Math.max(m, t.length), 0));

    const lines = sorted.map((e, i) => {
      const elapsed = formatElapsed(now - (e.startedAt || now));
      const tagRaw = tags[i].padEnd(tagWidth, ' ');
      const tag = chalk.dim(tagRaw);
      let body;
      if (e.state === 'retry-wait') {
        body = chalk.yellow(
          `${e.task} retry ${e.attempt}/${(e.maxAttempts ?? 3) - 1} — waiting…  [${elapsed}]`,
        );
      } else {
        const hintStr = e.hint ? chalk.dim(` · ${e.hint}`) : '';
        body = `${e.task}${hintStr} running…  [${elapsed}]`;
      }
      const raw = `${frameCh} ${tag} ${body}`;
      return clipToWidth(raw, width);
    });

    this._selfWrite(lines.join('\n') + '\n');
    this.rendered = lines.length;
  }
}

export const liveStatus = new LiveStatus();

// Helper used by callers that want to derive a key + worker info from the
// current AsyncLocalStorage context. Importing this avoids forcing every
// callsite to repeat the same `getWorkerContext()` plumbing.
export function liveKeyForCurrentWorker(suffix) {
  // Lazy import to avoid circular dep with server.js
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return (async () => {
    const { getWorkerContext } = await import('./worker-context.js');
    const ctx = getWorkerContext();
    const wid = ctx?.workerId ?? '0';
    return `w${wid}:${suffix}`;
  })();
}

// Sync variant for hot paths (claude-runner, validators)
export function makeLiveKey(workerId, suffix) {
  return `w${workerId ?? '0'}:${suffix}`;
}

// Re-export elapsed formatter so callers don't reimplement it
export { formatElapsed };
