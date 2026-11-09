// Runs tab — auto-run history (GET /projects/:name/runs), full calls table,
// and the project-scoped auto-heal feed. Each run row expands to a vertical
// run_events timeline (Phase 57 — GET /projects/:name/runs/:id/events).

import { store } from '../../lib/store.js';
import { router } from '../../lib/router.js';
import { api } from '../../lib/api.js';
import { fmtDate, fmtDur, fmtTime, statusMeta, pauseKindMeta } from '../../lib/format.js';
import CallsTable from '../widgets/CallsTable.js';
import HealingFeed from '../widgets/HealingFeed.js';

// Documented run_events kind vocabulary → tone (reusing the existing badge
// palette) + a short label. Unknown kinds degrade to the raw kind, muted.
const EVENT_META = {
  'run-started':      { tone: 'info', label: 'run started' },
  'plan-created':     { tone: 'info', label: 'plan created' },
  'phase-started':    { tone: 'info', label: 'phase started' },
  'dev-completed':    { tone: 'ok',   label: 'dev completed' },
  'dev-failed':       { tone: 'err',  label: 'dev failed' },
  'reprompt':         { tone: 'warn', label: 'reprompt' },
  'escalated':        { tone: 'warn', label: 'escalated' },
  'heal-attempt':     { tone: 'warn', label: 'heal attempt' },
  'validator-failed': { tone: 'err',  label: 'validator failed' },
  'acceptance-pass':  { tone: 'ok',   label: 'acceptance pass' },
  'acceptance-fail':  { tone: 'err',  label: 'acceptance fail' },
  'review-verdict':   { tone: 'info', label: 'review verdict' },
  'fix-started':      { tone: 'info', label: 'fix started' },
  'fix-completed':    { tone: 'ok',   label: 'fix completed' },
  'fix-parked':       { tone: 'warn', label: 'fix parked' },
  'audit-completed':  { tone: 'ok',   label: 'audit completed' },
  'bugs-promoted':    { tone: 'warn', label: 'bugs promoted' },
  'checkpoint-pause': { tone: 'info', label: 'checkpoint pause' },
  'budget-pause':     { tone: 'warn', label: 'budget pause' },
  'run-paused':       { tone: 'warn', label: 'run paused' },
  'run-completed':    { tone: 'ok',   label: 'run completed' },
};

export default {
  name: 'RunsTab',
  components: { CallsTable, HealingFeed },
  data() {
    return {
      runs: [],
      loading: true,
      error: '',
      // run id → { loading, error, events }; only populated when expanded.
      timelines: {},
      requestId: 0,
      timelineRequestIds: {},
    };
  },
  computed: {
    name() { return router.project; },
  },
  watch: {
    name(v) {
      this.requestId++;
      this.timelineRequestIds = {};
      this.timelines = {};
      this.runs = [];
      this.error = '';
      if (v) this.fetchRuns();
      else this.loading = false;
    },
  },
  mounted() { this.fetchRuns(); },
  beforeUnmount() {
    this.requestId++;
    this.timelineRequestIds = {};
  },
  methods: {
    fmtDate, fmtDur, fmtTime, statusMeta, pauseKindMeta,
    async fetchRuns() {
      const name = this.name;
      if (!name) return;
      const requestId = ++this.requestId;
      this.loading = true;
      this.error = '';
      try {
        const rows = (await api('GET', '/projects/' + encodeURIComponent(name) + '/runs?limit=50')) || [];
        if (requestId !== this.requestId || this.name !== name) return;
        this.runs = Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object') : [];
      } catch (e) {
        if (requestId !== this.requestId || this.name !== name) return;
        this.error = e.message;
      } finally {
        if (requestId === this.requestId && this.name === name) this.loading = false;
      }
    },
    // ended_at may be null while a run is live — elapsed then ticks off store.state.now.
    elapsed(r) {
      if (!r.started_at) return '–';
      return fmtDur(new Date(r.ended_at || store.state.now) - new Date(r.started_at));
    },
    toneColor(tone) {
      const map = { ok: 'var(--ok)', warn: 'var(--warn)', err: 'var(--err)', info: 'var(--info)' };
      return map[tone] || 'var(--muted)';
    },
    eventMeta(kind) {
      return EVENT_META[kind] || { tone: 'muted', label: kind };
    },
    // Compact one-line summary of an event's JSON detail (phase omitted — it
    // has its own column/pill). Best-effort: a malformed/legacy detail string
    // renders raw rather than throwing.
    eventDetail(ev) {
      if (!ev?.detail) return '';
      let obj;
      try { obj = JSON.parse(ev.detail); } catch { return String(ev.detail); }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return String(ev.detail);
      const parts = [];
      for (const [k, v] of Object.entries(obj)) {
        if (k === 'phase' || v == null) continue;
        parts.push(k + ': ' + (typeof v === 'string' ? v : JSON.stringify(v)));
      }
      return parts.join(' · ');
    },
    isOpen(r) { return !!this.timelines[r.id]; },
    async toggleTimeline(r) {
      const name = this.name;
      const runId = r.id;
      if (this.timelines[r.id]) {
        this.timelineRequestIds[runId] = (this.timelineRequestIds[runId] || 0) + 1;
        // Collapse — drop the entry (Vue 3 reactive delete via reassignment).
        const next = { ...this.timelines };
        delete next[r.id];
        this.timelines = next;
        return;
      }
      const requestId = (this.timelineRequestIds[runId] || 0) + 1;
      this.timelineRequestIds[runId] = requestId;
      this.timelines = { ...this.timelines, [r.id]: { loading: true, error: '', events: [] } };
      try {
        const response = await api('GET',
          '/projects/' + encodeURIComponent(name) + '/runs/' + encodeURIComponent(runId) + '/events');
        const events = Array.isArray(response) ? response.filter((event) => event && typeof event === 'object') : [];
        if (this.name !== name || this.timelineRequestIds[runId] !== requestId || !this.timelines[runId]) return;
        this.timelines = { ...this.timelines, [r.id]: { loading: false, error: '', events } };
      } catch (e) {
        if (this.name !== name || this.timelineRequestIds[runId] !== requestId || !this.timelines[runId]) return;
        this.timelines = { ...this.timelines, [r.id]: { loading: false, error: e.message, events: [] } };
      }
    },
  },
  template: `
    <div class="col" style="gap: var(--sp-4)">

      <div class="card">
        <div class="card-header">
          <span class="card-title">Run history</span>
          <span v-if="!loading && !error && runs.length" class="right xs mono muted">{{ runs.length }}</span>
          <button class="btn btn-ghost btn-sm" :class="{ right: loading || error || !runs.length }"
                  @click="fetchRuns" :disabled="loading"
                  title="Refresh runs" aria-label="Refresh runs">↻</button>
        </div>

        <div v-if="loading" class="col">
          <div class="skeleton" style="height: 44px"></div>
          <div class="skeleton" style="height: 44px"></div>
          <div class="skeleton" style="height: 44px"></div>
        </div>

        <div v-else-if="error" class="banner banner-err">
          {{ error }}
          <button class="btn btn-sm right" @click="fetchRuns">Retry</button>
        </div>

        <div v-else-if="!runs.length" class="empty">
          <span class="empty-icon">▷</span>
          <span>No runs yet</span>
          <span class="empty-hint">Start one from Overview</span>
        </div>

        <div v-else class="col" style="gap: var(--sp-3)">
          <div v-for="r in runs" :key="r.id" class="col" style="gap: 4px">
            <div class="row-wrap">
              <button class="btn btn-ghost btn-sm nowrap" @click="toggleTimeline(r)"
                      :title="isOpen(r) ? 'Hide timeline' : 'Show timeline'"
                      :aria-expanded="isOpen(r) ? 'true' : 'false'">
                {{ isOpen(r) ? '▾' : '▸' }}
              </button>
              <span class="badge nowrap" :style="{ '--badge-c': statusMeta(r.status).color }">
                {{ statusMeta(r.status).label }}
              </span>
              <span class="xs muted nowrap">
                {{ fmtDate(r.started_at) }} → {{ r.ended_at ? fmtDate(r.ended_at) : 'running' }}
              </span>
              <span class="xs mono muted nowrap">{{ elapsed(r) }}</span>
              <span v-if="r.unattended == 1" class="chip">unattended</span>
              <span v-if="r.pause_kind" class="badge nowrap"
                    :style="{ '--badge-c': toneColor(pauseKindMeta(r.pause_kind).tone) }">
                {{ pauseKindMeta(r.pause_kind).icon }} {{ pauseKindMeta(r.pause_kind).label }}
              </span>
            </div>
            <div v-if="r.pause_reason" class="small dim" style="white-space: pre-line">{{ r.pause_reason }}</div>

            <div v-if="isOpen(r)" class="col" style="gap: 0; margin-left: var(--sp-4); padding-left: var(--sp-3); border-left: 1px solid var(--border)">
              <div v-if="timelines[r.id].loading" class="skeleton" style="height: 60px"></div>
              <div v-else-if="timelines[r.id].error" class="small" style="color: var(--err)">{{ timelines[r.id].error }}</div>
              <div v-else-if="!timelines[r.id].events.length" class="small dim" style="padding: var(--sp-2) 0">
                No timeline recorded (a legacy/pre-0.18 run).
              </div>
              <div v-else v-for="ev in timelines[r.id].events" :key="ev.id" class="row-wrap"
                   style="gap: var(--sp-2); padding: 3px 0; align-items: baseline">
                <span class="dot" :style="{ background: toneColor(eventMeta(ev.kind).tone) }"
                      style="display: inline-block; width: 7px; height: 7px; border-radius: 50%; flex: none"></span>
                <span class="xs mono muted nowrap">{{ fmtTime(ev.ts) }}</span>
                <span class="badge nowrap" :style="{ '--badge-c': toneColor(eventMeta(ev.kind).tone) }">
                  {{ eventMeta(ev.kind).label }}
                </span>
                <span v-if="ev.phase != null" class="chip nowrap">P{{ ev.phase }}</span>
                <span v-if="eventDetail(ev)" class="xs muted">{{ eventDetail(ev) }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <span class="card-title">Calls</span>
        </div>
        <CallsTable v-if="name" :project="name" />
      </div>

      <HealingFeed :project="name" />
    </div>
  `,
};
