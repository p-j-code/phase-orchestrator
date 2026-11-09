// Reusable calls table. Full mode (RunsTab): search + errors-only + page size.
// Compact mode (per-phase expand in PhasesTab): just the rows, limit 30.

import { store } from '../../lib/store.js';
import { api } from '../../lib/api.js';
import { fmtMoney, fmtTokens, fmtDur, fmtTime, modelShort } from '../../lib/format.js';

export default {
  name: 'CallsTable',
  props: {
    project: { type: String, required: true },
    phase:   { type: Number, default: null },
    compact: { type: Boolean, default: false },
  },
  data() {
    return {
      rows: [],
      loading: true,
      error: '',
      search: '',
      errorsOnly: false,
      pageSize: this.compact ? 30 : 50,
      requestId: 0,
    };
  },
  computed: {
    filtered() {
      let list = this.rows;
      if (this.errorsOnly) list = list.filter((r) => r.is_error);
      const q = this.search.trim().toLowerCase();
      if (q) {
        list = list.filter((r) =>
          (r.task || '').toLowerCase().includes(q) ||
          (r.model || '').toLowerCase().includes(q) ||
          (r.error_message || '').toLowerCase().includes(q));
      }
      return list;
    },
    isFiltered() {
      return !!this.search.trim() || this.errorsOnly;
    },
  },
  watch: {
    project() { this.fetchRows(); },
    phase() { this.fetchRows(); },
    pageSize() { this.fetchRows(); },
  },
  mounted() { this.fetchRows(); },
  beforeUnmount() { this.requestId++; },
  methods: {
    fmtMoney, fmtTokens, fmtDur, fmtTime, modelShort,
    async fetchRows() {
      const project = this.project;
      const phase = this.phase;
      const pageSize = this.pageSize;
      if (!project) {
        this.rows = [];
        this.loading = false;
        return;
      }
      const requestId = ++this.requestId;
      this.loading = true;
      this.error = '';
      try {
        let path = '/projects/' + encodeURIComponent(project) + '/calls?limit=' + pageSize;
        if (phase != null) path += '&phase=' + phase;
        const rows = await api('GET', path);
        if (requestId !== this.requestId || this.project !== project ||
            this.phase !== phase || this.pageSize !== pageSize) return;
        this.rows = Array.isArray(rows) ? rows : [];
      } catch (e) {
        if (requestId !== this.requestId || this.project !== project ||
            this.phase !== phase || this.pageSize !== pageSize) return;
        this.error = e.message;
      } finally {
        if (requestId === this.requestId && this.project === project &&
            this.phase === phase && this.pageSize === pageSize) {
          this.loading = false;
        }
      }
    },
    open(c) {
      // CallDetailModal shows the project chip — make sure the row carries it.
      store.state.callDetail = c.project ? c : { ...c, project: this.project };
    },
  },
  template: `
    <div class="col">
      <div class="row">
        <template v-if="!compact">
          <input v-model="search" class="input" style="max-width: 240px"
                 placeholder="Search task / model / error…" aria-label="Search calls">
          <label class="checkbox nowrap">
            <input type="checkbox" v-model="errorsOnly"> Errors only
          </label>
        </template>
        <span class="right xs muted nowrap">{{ isFiltered ? filtered.length + ' of ' + rows.length : '' }}</span>
        <select v-if="!compact" v-model.number="pageSize" class="select" style="width: 76px" aria-label="Rows to fetch">
          <option :value="50">50</option>
          <option :value="100">100</option>
          <option :value="200">200</option>
        </select>
        <button class="btn btn-ghost btn-sm" @click="fetchRows" :disabled="loading"
                title="Refresh calls" aria-label="Refresh calls">↻</button>
      </div>

      <div v-if="loading" class="col">
        <div class="skeleton" style="height: 28px"></div>
        <div class="skeleton" style="height: 28px"></div>
        <div class="skeleton" style="height: 28px"></div>
      </div>

      <div v-else-if="error" class="banner banner-err">
        {{ error }}
        <button class="btn btn-sm right" @click="fetchRows">Retry</button>
      </div>

      <div v-else-if="!rows.length" class="empty">
        <span class="empty-icon">≡</span>
        <span>No calls yet</span>
        <span class="empty-hint">Calls appear here as agents run</span>
      </div>

      <div v-else-if="!filtered.length" class="empty">
        <span class="empty-icon">⌕</span>
        <span>No matches</span>
        <span class="empty-hint">Try a different search or clear the filters</span>
      </div>

      <div v-else class="table-scroll">
      <table class="table">
        <thead>
          <tr>
            <th>Time</th><th>Task</th><th>Model</th><th>Cost</th><th>Tokens</th><th>Dur</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="c in filtered" :key="c.id">
            <tr class="row-click" tabindex="0" role="button"
                :aria-label="'Open call detail: ' + (c.task || '')"
                :style="c.is_error ? 'color: var(--err)' : ''"
                @click="open(c)" @keydown.enter.prevent="open(c)" @keydown.space.prevent="open(c)">
              <td class="nowrap xs mono muted">{{ fmtTime(c.started_at) }}</td>
              <td><span class="truncate" style="display: block; max-width: 60ch" :title="c.task">{{ c.task }}</span></td>
              <td><span class="chip mono">{{ modelShort(c.model) }}</span></td>
              <td class="nowrap">{{ fmtMoney(c.cost_usd) }}</td>
              <td class="nowrap muted">{{ fmtTokens((c.input_tokens || 0) + (c.output_tokens || 0)) }}</td>
              <td class="nowrap muted">{{ fmtDur(c.duration_ms) }}</td>
            </tr>
            <tr v-if="c.error_message" class="row-click" @click="open(c)">
              <td></td>
              <td colspan="5" class="xs" style="color: var(--err)">
                <span class="truncate" style="display: block; max-width: 80ch" :title="c.error_message">✗ {{ c.error_message }}</span>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
      </div>
    </div>
  `,
};
