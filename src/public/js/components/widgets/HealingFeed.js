import { store } from '../../lib/store.js';
import { api } from '../../lib/api.js';
import { fmtAgo, statusMeta } from '../../lib/format.js';

export default {
  name: 'HealingFeed',
  props: {
    project: { type: String, default: null },
  },
  data() {
    return {
      rows: null,      // project mode: fetched rows | null before first load
      loading: false,
      error: '',
      expanded: {},    // id → true when the row detail is open
      requestId: 0,
    };
  },
  computed: {
    now() { return store.state.now; },
    effectiveError() { return this.project ? this.error : store.state.healingError; },
    items() {
      return this.project ? (this.rows || []) : store.state.healing;
    },
  },
  watch: {
    project() {
      this.requestId++;
      this.rows = null;
      this.loading = false;
      this.error = '';
      this.expanded = {};
      if (this.project) this.load();
    },
  },
  mounted() {
    if (this.project) this.load();
  },
  beforeUnmount() { this.requestId++; },
  methods: {
    fmtAgo, statusMeta,
    trunc(s, n) {
      const t = String(s || '');
      return t.length > n ? t.slice(0, n) + '…' : t;
    },
    emoji(status) {
      if (status === 'resolved') return '✅';
      if (status === 'failed') return '❌';
      return '🔧';
    },
    toggle(id) {
      this.expanded[id] = !this.expanded[id];
    },
    async load() {
      const project = this.project;
      if (!project) return;
      const requestId = ++this.requestId;
      this.error = '';
      this.loading = true;
      try {
        const rows = await api('GET', '/projects/' + encodeURIComponent(project) + '/healing');
        if (requestId !== this.requestId || this.project !== project) return;
        this.rows = Array.isArray(rows) ? rows : [];
      } catch (e) {
        if (requestId !== this.requestId || this.project !== project) return;
        this.error = e.message;
      } finally {
        if (requestId === this.requestId && this.project === project) {
          this.loading = false;
        }
      }
    },
    async refresh() {
      if (this.project) { this.load(); return; }
      const requestId = ++this.requestId;
      this.loading = true;
      try {
        await store.loadHealing();
      } finally {
        if (requestId === this.requestId && !this.project) this.loading = false;
      }
    },
    detailText(h) {
      const parts = [];
      if (h.error_message) parts.push(h.error_message);
      if (h.strategy) parts.push('strategy: ' + h.strategy);
      if (h.context_json) {
        try { parts.push(JSON.stringify(JSON.parse(h.context_json), null, 2)); }
        catch { parts.push(String(h.context_json)); }
      }
      return parts.join('\n\n') || '(no detail)';
    },
  },
  template: `
    <div class="card">
      <div class="card-header">
        <span class="card-title">Auto-heal</span>
        <span v-if="items.length" class="chip">{{ items.length }}</span>
        <button class="btn btn-ghost btn-sm right" @click="refresh" :disabled="loading"
                title="Refresh healing log" aria-label="Refresh healing log">
          <span v-if="loading" class="spinner"></span><span v-else>↻</span>
        </button>
      </div>

      <div v-if="project && !rows && !error" class="col">
        <div class="skeleton" style="height: 28px"></div>
        <div class="skeleton" style="height: 28px"></div>
        <div class="skeleton" style="height: 28px"></div>
      </div>

      <div v-else-if="effectiveError" class="banner banner-err">
        <span class="grow">{{ effectiveError }}</span>
        <button class="btn btn-sm" @click="refresh">Retry</button>
      </div>

      <div v-else-if="!items.length" class="empty">
        <span class="empty-icon">🔧</span>
        <span>No healing events</span>
        <span class="empty-hint">Auto-heal attempts show up here when errors get classified and retried</span>
      </div>

      <div v-else class="scroll-y" style="max-height: 420px">
        <template v-for="h in items" :key="h.id">
          <div class="feed-item row-click" tabindex="0" role="button"
               :aria-expanded="expanded[h.id] ? 'true' : 'false'"
               :aria-label="'Healing event: ' + h.error_kind"
               @click="toggle(h.id)"
               @keydown.enter.prevent="toggle(h.id)" @keydown.space.prevent="toggle(h.id)">
            <span style="flex: none">{{ emoji(h.status) }}</span>
            <span class="chip nowrap">{{ h.error_kind }}</span>
            <span class="badge" :style="{'--badge-c': statusMeta(h.status).color}">{{ statusMeta(h.status).label }}</span>
            <span class="grow truncate" :title="h.error_message || ''">{{ trunc(h.error_message, 110) }}</span>
            <span class="xs muted nowrap">{{ fmtAgo(h.created_at, now) }}</span>
          </div>
          <div v-if="expanded[h.id]" class="card-flat mono xs"
               style="white-space: pre-wrap; word-break: break-word; margin: var(--sp-1) 0 var(--sp-2)">{{ detailText(h) }}</div>
        </template>
      </div>
    </div>
  `,
};
