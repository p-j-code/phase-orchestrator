// Live progress terminal — merges a 3s poll of GET /log-tail with the
// per-project SSE stream. Self-managing: polls only while the run state is
// 'running', keeps the last output visible after the run ends, reconnects SSE
// with backoff (handled by openStream), cleans up timer + stream on unmount.

import { store } from '../../lib/store.js';
import { router } from '../../lib/router.js';
import { api } from '../../lib/api.js';
import { openStream } from '../../lib/sse.js';
import { fmtTime, fmtMoney, modelShort, runStateOf } from '../../lib/format.js';

export default {
  name: 'LiveLog',
  data() {
    return {
      tail: null,        // {file, task, mtimeMs, active, entries:[{t,name,detail}]} | null
      tailError: '',
      sseLines: [],      // [{text, err}] cap 40, last 6 shown
      sseStatus: 'connecting',
      collapsed: false,
      pinned: true,      // auto-scroll pinned to bottom until the user scrolls up
      progress: null,    // Phase 59: latest { type:'progress' } row, or null (no live run)
      nowTick: Date.now(), // 1s ticker so the header's tool-elapsed stays live between SSE pushes
      tailRequestId: 0,
    };
  },
  computed: {
    name() { return router.project; },
    // detail may be null or lag router.project while loading — guard everything
    detail() {
      const d = store.state.detail;
      return d && d.name === this.name ? d : null;
    },
    visible() {
      if (runStateOf(this.detail) === 'running') return true;
      if (this.tailError) return true;
      // keep showing the last output after the run finishes
      return !!(this.tail && this.tail.entries && this.tail.entries.length);
    },
    entries() {
      return (this.tail && Array.isArray(this.tail.entries)) ? this.tail.entries : [];
    },
    feedLines() { return this.sseLines.slice(-6); },
    fresh() { return !!(this.tail && this.tail.active); },
    sseColor() {
      if (this.sseStatus === 'live') return 'var(--ok)';
      if (this.sseStatus === 'connecting') return 'var(--warn)';
      return 'var(--err)';
    },
    fileLabel() {
      if (!this.tail || !this.tail.file) return '';
      const base = String(this.tail.file).split('/').pop();
      return this.tail.task || base;
    },
    // Phase 59: one-line live header — "turn 34/150 · tool Bash: npm test (42s)
    // · 12 files · ETA ~6m". Mirrors src/lib/live-progress.js#formatProgressHeader
    // (the browser has no build step, so the server module can't be imported
    // here). Returns '' when there is no live row → the header strip hides and
    // the widget falls back to its pre-Phase-59 behavior.
    progressHeader() {
      const p = this.progress;
      if (!p || p.cleared) return '';
      const parts = [];
      const turns = Number.isFinite(p.turns) ? p.turns : null;
      const maxT = Number.isFinite(p.max_turns) ? p.max_turns : null;
      if (turns != null) parts.push(maxT != null ? 'turn ' + turns + '/' + maxT : 'turn ' + turns);
      if (p.current_tool) {
        const started = Number.isFinite(p.current_tool_started_at) ? p.current_tool_started_at : null;
        const el = started != null ? this.fmtDur(this.nowTick - started) : null;
        parts.push('tool ' + p.current_tool + (el ? ' (' + el + ')' : ''));
      }
      const files = Array.isArray(p.files_touched) ? p.files_touched.length : 0;
      if (files) parts.push(files + ' file' + (files === 1 ? '' : 's'));
      const eta = this.fmtDur(p.eta_ms);
      if (eta) parts.push('ETA ~' + eta);
      return parts.join(' · ');
    },
  },
  watch: {
    // widget instance can survive a project switch — reset and re-attach
    name() {
      this.tailRequestId++;
      this.tail = null;
      this.tailError = '';
      this.sseLines = [];
      this.progress = null; // Phase 59: drop the previous project's live header
      this.pinned = true;
      this.fetchTail();
      this.openSse();
    },
  },
  mounted() {
    this.fetchTail(); // first fetch immediately, regardless of run state
    this._timer = setInterval(() => {
      if (runStateOf(this.detail) === 'running') this.fetchTail();
    }, 3000);
    // Phase 59: 1s ticker so the header's tool-elapsed advances smoothly
    // between the (>=3s throttled) SSE progress pushes.
    this._nowTimer = setInterval(() => { this.nowTick = Date.now(); }, 1000);
    this.openSse();
  },
  beforeUnmount() {
    this.tailRequestId++;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._nowTimer) { clearInterval(this._nowTimer); this._nowTimer = null; }
    this.closeSse();
  },
  updated() {
    if (this.pinned && !this.collapsed) {
      const el = this.$refs.term;
      if (el) el.scrollTop = el.scrollHeight;
    }
  },
  methods: {
    async fetchTail() {
      if (!this.name) return;
      const name = this.name;
      const requestId = ++this.tailRequestId;
      try {
        const r = await api('GET', '/projects/' + encodeURIComponent(name) + '/log-tail?lines=80');
        if (this.name === name && this.tailRequestId === requestId) {
          this.tail = r; // replace wholesale
          this.tailError = '';
        }
      } catch (e) {
        if (this.name === name && this.tailRequestId === requestId) this.tailError = e.message;
      }
    },
    openSse() {
      this.closeSse();
      if (!this.name) return;
      const name = this.name;
      const generation = this._streamGeneration;
      this._stream = openStream('/projects/' + encodeURIComponent(name) + '/stream', {
        onStatus: (s) => {
          if (this.name === name && this._streamGeneration === generation) this.sseStatus = s;
        },
        onEvent: (evt) => {
          if (this.name === name && this._streamGeneration === generation) this.onSse(evt);
        },
      });
    },
    closeSse() {
      this._streamGeneration = (this._streamGeneration || 0) + 1;
      if (this._stream) { this._stream.close(); this._stream = null; }
    },
    onSse(evt) {
      if (!evt || !evt.type) return;
      if (evt.type === 'call') {
        const task = String(evt.task || '').slice(0, 60);
        this.pushLine({
          text: '[' + fmtTime(new Date().toISOString()) + '] ' + (evt.is_error ? '✗' : '✓') +
            ' ph-' + (evt.phase != null ? evt.phase : '?') + ' · ' + task +
            ' · ' + modelShort(evt.model) + ' · ' + fmtMoney(evt.cost_usd),
          err: !!evt.is_error,
        });
      } else if (evt.type === 'status') {
        this.pushLine({ text: '● status → ' + evt.status, err: false });
      } else if (evt.type === 'progress') {
        // Phase 59: a cleared event (run ended) drops the header; otherwise the
        // event IS the live_progress row — store it wholesale for the header.
        this.progress = evt.cleared ? null : evt;
        this.nowTick = Date.now();
      }
    },
    fmtDur(ms) {
      if (!Number.isFinite(ms) || ms < 0) return '';
      const sec = Math.round(ms / 1000);
      if (sec < 60) return sec + 's';
      const m = Math.floor(sec / 60);
      if (m < 60) return m + 'm';
      const h = Math.floor(m / 60);
      return h + 'h ' + String(m % 60).padStart(2, '0') + 'm';
    },
    pushLine(l) {
      this.sseLines.push(l);
      if (this.sseLines.length > 40) this.sseLines.splice(0, this.sseLines.length - 40);
    },
    entryText(e) {
      const d = e.detail == null ? '' : String(e.detail);
      if (e.t === 'tool') return '⚙ ' + (e.name || 'tool') + (d ? ' — ' + d : '');
      if (e.t === 'text') return '💬 ' + d;
      if (e.t === 'result') return '→ ' + d;
      if (e.t === 'init') return '▶ ' + d;
      return d;
    },
    onScroll(ev) {
      const el = ev.target;
      this.pinned = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
    },
    jump() {
      this.pinned = true;
      this.$nextTick(() => {
        const el = this.$refs.term;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },
  },
  template: `
    <div v-if="visible" class="card">
      <div class="card-header">
        <span class="card-title">Live output</span>
        <span class="dot" :class="{ 'dot-pulse': fresh }"
              :style="{ '--dot-c': fresh ? 'var(--ok)' : 'var(--muted)' }"
              :title="fresh ? 'log file active' : 'log file quiet'"></span>
        <span v-if="fileLabel" class="chip mono truncate" style="max-width: 320px"
              :title="tail.file">{{ fileLabel }}</span>
        <span class="dot right" :style="{ '--dot-c': sseColor }" :title="'stream: ' + sseStatus"></span>
        <button class="btn btn-ghost btn-sm" @click="collapsed = !collapsed"
                :aria-expanded="!collapsed ? 'true' : 'false'"
                :title="collapsed ? 'Expand live output' : 'Collapse live output'">
          {{ collapsed ? '▸' : '▾' }}
        </button>
      </div>

      <template v-if="!collapsed">
        <div v-if="tailError" class="banner banner-err" style="margin-bottom: var(--sp-2)">
          <span class="grow">Live log unavailable: {{ tailError }}</span>
          <button class="btn btn-sm" @click="fetchTail">Retry</button>
        </div>
        <div v-if="progressHeader" class="chip mono xs truncate" style="margin-bottom: var(--sp-2); max-width: 100%"
             :title="progress && progress.last_text ? progress.last_text : progressHeader">{{ progressHeader }}</div>

        <div v-if="!tailError && !entries.length && !feedLines.length" class="empty">
          <span class="empty-icon">≋</span>
          <span>Waiting for output…</span>
        </div>

        <template v-else>
          <div v-if="entries.length" ref="term" class="term" style="max-height: 320px" @scroll="onScroll">
            <div v-for="(e, i) in entries" :key="i">
              <span v-if="e.t === 'error'" :style="{ color: 'var(--err)' }">{{ e.detail }}</span>
              <span v-else>{{ entryText(e) }}</span>
            </div>
          </div>
          <div v-if="entries.length && !pinned" class="row" style="justify-content: flex-end; margin-top: 4px">
            <a class="small" href="#" @click.prevent="jump">Jump to latest ↓</a>
          </div>

          <div v-if="feedLines.length" :style="entries.length ? 'margin-top: var(--sp-3)' : ''">
            <div v-for="(l, i) in feedLines" :key="i" class="feed-item mono xs"
                 :style="l.err ? { color: 'var(--err)' } : {}">{{ l.text }}</div>
          </div>
        </template>
      </template>
    </div>
  `,
};
