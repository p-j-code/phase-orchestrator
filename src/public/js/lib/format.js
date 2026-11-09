// Formatters + status metadata. Single source of truth for how statuses render.

export function fmtMoney(n) {
  if (n == null || isNaN(n)) return '–';
  return '$' + (n < 0.01 ? n.toFixed(4) : n < 1 ? n.toFixed(3) : n.toFixed(2));
}

export function fmtTokens(n) {
  if (n == null || isNaN(n)) return '–';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

export function fmtDur(ms) {
  if (ms == null || isNaN(ms) || ms < 0) return '–';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function fmtTime(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  if (isNaN(d)) return '–';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtDate(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  if (isNaN(d)) return '–';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function fmtAgo(input, now = Date.now()) {
  if (input == null) return '–';
  const t = typeof input === 'number' ? input : new Date(input).getTime();
  if (isNaN(t)) return '–';
  const diff = Math.max(0, now - t);
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Phase 63 (P7) — "in 48m" / "in 2h 05m" until a future instant. Mirror of
// fmtAgo for the forward direction (WindowGauge's reclaim line). Past/now → 'now'.
export function fmtUntil(input, now = Date.now()) {
  if (input == null) return '–';
  const t = typeof input === 'number' ? input : new Date(input).getTime();
  if (isNaN(t)) return '–';
  const diff = t - now;
  if (diff <= 0) return 'now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

export function modelShort(model) {
  if (!model) return '–';
  return String(model)
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-(latest|\d+)$/, (m, g) => (g === 'latest' ? '' : m));
}

export function pct(a, b) {
  if (!b) return 0;
  return Math.min(100, Math.round((a / b) * 100));
}

// Tiny inline-SVG sparkline (Phase 60 — quality dashboard) — no chart
// dependency. Plots `values` as a single polyline scaled into
// [0,width] x [height,0]; null/undefined entries are skipped (gaps in the
// series, e.g. a legacy round with no found_count). An empty/all-null series
// or a flat one (every value equal) still renders a valid, non-throwing SVG
// (empty canvas / flat mid-line) rather than dividing by zero. Output is
// built from numeric values only — safe to inject with v-html.
export function sparklineSvg(values, { width = 120, height = 28, color = 'var(--accent)' } = {}) {
  const nums = (Array.isArray(values) ? values : [])
    .map((v) => (v == null ? null : Number(v)))
    .filter((v) => v != null && !isNaN(v));
  if (nums.length === 0) {
    return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true"></svg>`;
  }
  const plot = nums.length === 1 ? [nums[0], nums[0]] : nums;
  const min = Math.min(...plot);
  const max = Math.max(...plot);
  const range = max - min || 1;
  const stepX = width / (plot.length - 1);
  const points = plot.map((v, i) => {
    const x = Math.round(i * stepX * 100) / 100;
    const y = Math.round((height - ((v - min) / range) * height) * 100) / 100;
    return `${x},${y}`;
  }).join(' ');
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">` +
    `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>` +
    `</svg>`;
}

// Phase 61 (P5 routing transparency) — pure per-call step for the decision
// chain: PhasesTab renders one of these per call in a phase (baseline →
// escalated → …); PipelinePanel renders just the LATEST one as a "why this
// model" chip. `call` is one row from GET /phases/:n/routing's `calls` array
// (foundations columns: routing_tier/routing_reason/attempt/escalated/
// is_error/error_message) — a pre-foundations row has routing_tier,
// routing_reason, and attempt all null, which is exactly `hasRouting: false`
// below ("no routing recorded"). Returns null for a null/undefined call so
// callers can chain `steps[steps.length - 1]` without a length check.
export function routingStepLabel(call) {
  if (!call) return null;
  const hasRouting = call.routing_tier != null || call.routing_reason != null || call.attempt != null;
  const outcome = call.is_error
    ? (/max.?turns/i.test(call.error_message || '') ? 'error_max_turns' : 'error')
    : 'completed';
  return {
    id: call.id,
    model: call.model || null,
    tier: call.routing_tier || null,
    reason: call.routing_reason || null,
    attempt: Number.isFinite(call.attempt) ? call.attempt : null,
    escalated: !!call.escalated,
    outcome,
    isError: !!call.is_error,
    hasRouting,
  };
}

// Phase 63 (P7) — human one-liner from a GET /forecast object, shown in the
// Go/Resume confirm dialog before a run spawns. Pure; tolerates a null/partial
// forecast (returns a neutral proceed message) so the confirm never blocks on
// bad data.
export function forecastSummary(f) {
  if (!f) return 'Forecast unavailable — proceed anyway?';
  const lc = f.lowConfidence ? ' (rough estimate — sparse history)' : '';
  const units = Math.ceil(f.totalExpectedAdmissionUnits ?? f.totalExpectedCalls ?? 0);
  const eta = fmtDur(f.etaMs);
  if (f.mode === 'idle' || !f.totalUnits) return `No upcoming run to size for “${f.project}”. Start anyway?`;
  if (f.fitsInWindow) {
    return `Fits the ${f.windowHours}h window — ~${units} heavy-eq units, ETA ~${eta}${lc}. Start?`;
  }
  const where = f.pauseAtPhase != null ? `phase ${f.pauseAtPhase}` : 'mid-run';
  if (typeof f.recommendation === 'string' && f.recommendation.startsWith('wait-')) {
    const mins = Math.max(1, Math.round((f.waitForFullFitMs || 0) / 60000));
    return `Won't fit the ${f.windowHours}h window now — will pause at ${where}. Wait ~${mins}m for reclaim, or start partial now${lc}?`;
  }
  return `Won't fit — will pause at ${where} (${f.pauseReason || 'calls'}); ~${units} heavy-eq units needed, ${f.windowCallsLeft} left${lc}. Start partial?`;
}

// ── status metadata ──────────────────────────────────────────────────────────

const STATUS_META = {
  // project lifecycle
  'planning':     { label: 'Planning',    color: 'var(--info)' },
  'in-progress':  { label: 'In progress', color: 'var(--accent)' },
  'paused':       { label: 'Paused',      color: 'var(--warn)' },
  'completed':    { label: 'Completed',   color: 'var(--ok)' },
  'ready-for-qa': { label: 'Ready for QA',color: 'var(--purple)' },
  'cancelled':    { label: 'Cancelled',   color: 'var(--muted)' },
  // phases / runs / jobs
  'pending':      { label: 'Pending',     color: 'var(--muted)' },
  'skipped':      { label: 'Skipped',     color: 'var(--muted)' },
  'failed':       { label: 'Failed',      color: 'var(--err)' },
  'running':      { label: 'Running',     color: 'var(--ok)' },
  'aborted':      { label: 'Aborted',     color: 'var(--muted)' },
  // inbox items
  'inbox':        { label: 'Inbox',       color: 'var(--info)' },
  'promoted':     { label: 'Promoted',    color: 'var(--ok)' },
  'dropped':      { label: 'Dropped',     color: 'var(--muted)' },
  'refined':      { label: 'Refined',     color: 'var(--purple)' },
  // healing
  'resolved':     { label: 'Resolved',    color: 'var(--ok)' },
  // states
  'idle':         { label: 'Idle',        color: 'var(--muted)' },
  'ok':           { label: 'OK',          color: 'var(--ok)' },
  'warn':         { label: 'Warning',     color: 'var(--warn)' },
  'pause':        { label: 'Pause',       color: 'var(--err)' },
};

export function statusMeta(status) {
  return STATUS_META[status] || { label: status || 'Unknown', color: 'var(--muted)' };
}

const PAUSE_KIND_META = {
  'all-phases-complete': { label: 'All phases complete', icon: '🏁', tone: 'ok' },
  'fix-round-complete':  { label: 'Fix round complete',  icon: '🔧', tone: 'ok' },
  'budget':              { label: 'Budget pause',        icon: '⏳', tone: 'warn' },
  'validator-failed':    { label: 'Validator failed',    icon: '🚨', tone: 'err' },
  'review-checkpoint':   { label: 'Review checkpoint',   icon: '🔍', tone: 'info' },
  'max-actions':         { label: 'Max actions hit',     icon: '🛑', tone: 'warn' },
  'mid-build':           { label: 'Paused mid-build',    icon: '⏸', tone: 'warn' },
  'other':               { label: 'Paused',              icon: '⏸', tone: 'warn' },
};

export function pauseKindMeta(kind) {
  return PAUSE_KIND_META[kind] || PAUSE_KIND_META['other'];
}

const PENDING_ACTION_LABEL = {
  resume: 'Resume', go: 'Start Auto-Run', next: 'Next Phase', launch: 'Launch Pipeline',
  'next-brief': 'Next Brief', 'brief-chain': 'Brief Chain', guide: 'Guide',
};

// A tg_jobs row still 'pending' means the queue FIFO picker hasn't admitted it
// yet — most commonly because the project already has a running job/auto_run.
// Surfaced so a Resume/Go click doesn't look like a silent no-op.
export function pendingJobLabel(job) {
  if (!job) return null;
  return PENDING_ACTION_LABEL[job.action] || job.action;
}

// SQLite writes tg_jobs.not_before as "YYYY-MM-DD HH:MM:SS" (UTC, no zone
// marker); other timestamps on the row are ISO strings. Normalize both.
export function toUtcMs(value) {
  if (!value) return NaN;
  const s = String(value);
  const t = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(' ', 'T') + 'Z' : s).getTime();
  return t;
}

// A heavy job (resume/go/next/…) deferred by the warn-window admission gate
// (job-queue.js nextPendingJobForFreeProject) carries a future not_before —
// the billing window's projected reset, which can be hours away, not a short
// retry. Distinguish that from an ordinary "waiting for a free slot" queue.
export function pendingJobWaitReason(job, now = Date.now()) {
  if (!job) return null;
  const notBeforeMs = toUtcMs(job.not_before);
  if (job.not_before && !isNaN(notBeforeMs) && notBeforeMs > now) {
    return `deferred until the billing window clears (in ${fmtUntil(notBeforeMs, now)})`;
  }
  return 'waiting for a free worker slot';
}

// Derived truth for "is this project actually doing something right now".
// NEVER test project.status === 'running' — that value does not exist in the DB.
export function runStateOf(project) {
  if (!project) return 'idle';
  if (project.processAlive) return 'running';
  const run = project.autoRun;
  if (run && run.status === 'running') return 'running'; // possibly stale — see runIsStale
  if (run && run.status === 'paused') return 'paused';
  if (project.status === 'completed') return 'completed';
  if (project.status === 'ready-for-qa') return 'ready-for-qa';
  if (project.status === 'cancelled') return 'cancelled';
  if (project.status === 'planning') return 'planning';
  // Plan exists but execution hasn't started yet (e.g. guide:plan job completed
  // but no run was queued — or was just queued and hasn't fired yet).
  if (project.status === 'in-progress' && project.current_phase === 0 && project.total_phases > 0) return 'plan-ready';
  return 'idle';
}

// autoRun says running but no live process → the run row is stale (process died hard).
export function runIsStale(project) {
  return !!(project && project.processAlive === false &&
    project.autoRun && project.autoRun.status === 'running');
}

export function runStateMeta(state) {
  const map = {
    'running':      { label: 'Running',      color: 'var(--ok)',     pulse: true },
    'paused':       { label: 'Paused',       color: 'var(--warn)',   pulse: false },
    'completed':    { label: 'Completed',    color: 'var(--ok)',     pulse: false },
    'ready-for-qa': { label: 'Ready for QA', color: 'var(--purple)', pulse: false },
    'cancelled':    { label: 'Cancelled',    color: 'var(--muted)',  pulse: false },
    'planning':     { label: 'Planning',     color: 'var(--info)',   pulse: false },
    'plan-ready':   { label: 'Plan Ready',   color: 'var(--info)',   pulse: false },
    'idle':         { label: 'Idle',         color: 'var(--muted)',  pulse: false },
  };
  return map[state] || map.idle;
}
