// Live-progress tracker — the pure, unit-testable core of Phase 59's live run
// telemetry. claude-runner's stream parser feeds every parsed stream-json event
// to a ProgressTracker; the tracker accumulates the turn count, the current
// pending tool (+ its start time), a bounded files-touched set, and the last
// assistant text, then writes a THROTTLED (>=3s) snapshot to the live_progress
// table through an injected writer. Kept out of claude-runner.js so the parser
// seam can be exercised without spawning a real `claude` (see
// live-progress.test.mjs).
//
// Every write is best-effort: the tracker swallows writer errors so live
// telemetry can never fail a run (the never-throw NFR). ETA is deterministic
// and nullable — no clock jitter, no LLM call.

export const FILES_TOUCHED_CAP = 50;
export const PROGRESS_THROTTLE_MS = 3000;
const LAST_TEXT_MAX_CHARS = 200;

// tool_use input keys that name a file we surface as "touched".
const FILE_INPUT_KEYS = ['file_path', 'path', 'notebook_path'];

/** Short, header-ready label for a tool_use: "Bash: npm test", "Edit: src/state.js". */
function toolLabel(name, input) {
  const n = name || 'tool';
  if (!input || typeof input !== 'object') return n;
  if (typeof input.command === 'string' && input.command.trim()) {
    return `${n}: ${input.command.replace(/\s+/g, ' ').trim().slice(0, 60)}`;
  }
  for (const k of FILE_INPUT_KEYS) {
    if (typeof input[k] === 'string' && input[k]) {
      const base = input[k].split('/').slice(-2).join('/');
      return `${n}: ${base}`;
    }
  }
  return n;
}

/** The file path or command string a tool_use touched, or null. */
function touchedValue(input) {
  if (!input || typeof input !== 'object') return null;
  for (const k of FILE_INPUT_KEYS) {
    if (typeof input[k] === 'string' && input[k]) return input[k];
  }
  if (typeof input.command === 'string' && input.command.trim()) {
    return input.command.replace(/\s+/g, ' ').trim().slice(0, 100);
  }
  return null;
}

/**
 * Deterministic, nullable ETA for the remaining run, blending two signals:
 *   - observed turn rate: elapsed/turns × remaining turns (needs maxTurns and
 *     at least one completed turn), and
 *   - historical AVG(duration_ms) for this (model, task): avg − elapsed.
 * Both present → their mean; one present → that one; neither → null. Never
 * negative. Pure — no Date.now(), so it is safe under workflow/replay.
 */
export function computeEtaMs({ now, startedAt, turns, maxTurns, historicalAvgMs } = {}) {
  const elapsed = (Number.isFinite(now) && Number.isFinite(startedAt)) ? Math.max(0, now - startedAt) : 0;
  let observed = null;
  if (Number.isFinite(maxTurns) && maxTurns > 0 && Number.isFinite(turns) && turns >= 1 && elapsed > 0) {
    const msPerTurn = elapsed / turns;
    observed = Math.max(0, maxTurns - turns) * msPerTurn;
  }
  let historical = null;
  if (Number.isFinite(historicalAvgMs) && historicalAvgMs > 0) {
    historical = Math.max(0, historicalAvgMs - elapsed);
  }
  if (observed != null && historical != null) return Math.round((observed + historical) / 2);
  if (observed != null) return Math.round(observed);
  if (historical != null) return Math.round(historical);
  return null;
}

/** Compact human duration: "42s", "6m", "1h 12m". null for non-finite/negative. */
export function formatDurationShort(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

function filesCount(files) {
  if (Array.isArray(files)) return files.length;
  if (typeof files === 'string' && files) {
    try { const a = JSON.parse(files); return Array.isArray(a) ? a.length : 0; } catch { return 0; }
  }
  return 0;
}

/**
 * Render a live_progress row (or a { type:'progress' } SSE event / tracker
 * snapshot) into the one-line header:
 *   "turn 34/150 · tool Bash: npm test (42s) · 12 files · ETA ~6m"
 * Returns null for a falsy row so callers fall back to their non-live view.
 * `now` drives the tool-elapsed segment (defaults to Date.now()).
 */
export function formatProgressHeader(row, { now = Date.now() } = {}) {
  if (!row) return null;
  const parts = [];
  const turns = Number.isFinite(row.turns) ? row.turns : null;
  const maxT = Number.isFinite(row.max_turns) ? row.max_turns : null;
  if (turns != null) parts.push(maxT != null ? `turn ${turns}/${maxT}` : `turn ${turns}`);
  if (row.current_tool) {
    const started = Number.isFinite(row.current_tool_started_at) ? row.current_tool_started_at : null;
    const el = started != null ? formatDurationShort(now - started) : null;
    parts.push(`tool ${row.current_tool}${el ? ` (${el})` : ''}`);
  }
  const files = filesCount(row.files_touched);
  if (files) parts.push(`${files} file${files === 1 ? '' : 's'}`);
  const eta = formatDurationShort(row.eta_ms);
  if (eta) parts.push(`ETA ~${eta}`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * Accumulates live telemetry from a claude stream and emits throttled snapshots.
 * Injectable `now`/`write` make it fully deterministic and DB-free for tests.
 *
 * @param {Object} opts
 * @param {string}  opts.project           - live_progress PRIMARY KEY (required to write)
 * @param {number}  [opts.pid]
 * @param {string}  [opts.task]
 * @param {number}  [opts.phase]
 * @param {string}  [opts.model]
 * @param {number}  [opts.maxTurns]        - resolveMaxTurns() value; lands in max_turns
 * @param {number}  [opts.startedAt]       - epoch ms; defaults to now()
 * @param {number}  [opts.historicalAvgMs] - AVG(duration_ms) for (model,task) for ETA
 * @param {number}  [opts.throttleMs]      - min ms between writes (default 3000)
 * @param {Function}[opts.now]             - () => epoch ms
 * @param {Function}[opts.write]           - (snapshot) => void
 */
export class ProgressTracker {
  constructor({
    project, pid = null, task = null, phase = null, model = null, maxTurns = null,
    startedAt, historicalAvgMs = null,
    throttleMs = PROGRESS_THROTTLE_MS,
    now = () => Date.now(),
    write = () => {},
  } = {}) {
    this.project = project;
    this.pid = pid;
    this.task = task;
    this.phase = phase;
    this.model = model;
    this.maxTurns = Number.isFinite(maxTurns) ? maxTurns : null;
    this.historicalAvgMs = Number.isFinite(historicalAvgMs) ? historicalAvgMs : null;
    this.throttleMs = throttleMs;
    this._now = now;
    this._write = write;
    this.startedAt = Number.isFinite(startedAt) ? startedAt : now();

    this.turns = 0;
    this.filesTouched = new Set();
    this.lastText = null;
    // pending tool calls: toolUseId -> { label, startedAt }
    this._pending = new Map();
    this._lastWriteAt = -Infinity; // first event always writes
  }

  /** Feed one parsed stream-json event. Never throws. */
  onEvent(ev) {
    if (!ev || typeof ev.type !== 'string') return;
    if (ev.type === 'assistant') {
      const content = ev.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_use' && block.id) {
            this._pending.set(block.id, { label: toolLabel(block.name, block.input), startedAt: this._now() });
            const val = touchedValue(block.input);
            if (val && this.filesTouched.size < FILES_TOUCHED_CAP) this.filesTouched.add(val);
          } else if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            this.lastText = block.text.replace(/\s+/g, ' ').trim().slice(0, LAST_TEXT_MAX_CHARS);
          }
        }
      }
      this._maybeWrite();
    } else if (ev.type === 'user') {
      const content = ev.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_result' && block.tool_use_id) this._pending.delete(block.tool_use_id);
        }
      }
      // Count turns on user-turn events (the tool-result round trips that
      // advance the agentic loop against --max-turns).
      this.turns += 1;
      this._maybeWrite();
    } else if (ev.type === 'result') {
      this._pending.clear();
      this.finalize(); // final write on result (bypasses the throttle)
    }
  }

  /** Oldest pending tool is "current" (mirrors the smart-health hint). null when none pending. */
  currentTool() {
    const first = this._pending.values().next();
    return first.done ? null : first.value;
  }

  /** Build the live_progress row object for the current state. */
  snapshot() {
    const now = this._now();
    const cur = this.currentTool();
    return {
      project: this.project,
      pid: this.pid,
      task: this.task,
      phase: this.phase,
      model: this.model,
      turns: this.turns,
      max_turns: this.maxTurns,
      current_tool: cur ? cur.label : null,
      current_tool_started_at: cur ? cur.startedAt : null,
      files_touched: [...this.filesTouched],
      last_text: this.lastText,
      started_at: this.startedAt,
      eta_ms: computeEtaMs({
        now, startedAt: this.startedAt, turns: this.turns,
        maxTurns: this.maxTurns, historicalAvgMs: this.historicalAvgMs,
      }),
      updated_at: now,
    };
  }

  /** Throttled write — no more than one per throttleMs. */
  _maybeWrite() {
    const now = this._now();
    if (now - this._lastWriteAt < this.throttleMs) return;
    this._lastWriteAt = now;
    try { this._write(this.snapshot()); } catch { /* never-throw */ }
  }

  /** Forced write, bypassing the throttle (final write on result / on demand). */
  finalize() {
    this._lastWriteAt = this._now();
    try { this._write(this.snapshot()); } catch { /* never-throw */ }
  }
}
