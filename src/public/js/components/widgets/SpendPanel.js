import { api } from '../../lib/api.js';
import { fmtMoney, fmtTokens } from '../../lib/format.js';

export default {
  name: 'SpendPanel',
  props: {
    project: { type: String, default: null },
    compact: { type: Boolean, default: false },
  },
  data() {
    return { days: 30, report: null, loading: true, error: '', requestSeq: 0 };
  },
  watch: {
    project() { this.load(); },
    days() { this.load(); },
  },
  mounted() { this.load(); },
  methods: {
    fmtMoney, fmtTokens,
    shortModel(model) { return String(model || '?').replace(/^claude-/, ''); },
    async load() {
      const seq = ++this.requestSeq;
      this.loading = true;
      this.error = '';
      const project = this.project;
      const days = this.days;
      const query = new URLSearchParams({ days: String(days) });
      if (project) query.set('project', project);
      try {
        const report = await api('GET', '/spend?' + query.toString());
        if (this.project === project && this.days === days && seq === this.requestSeq) this.report = report;
      } catch (e) {
        if (this.project === project && this.days === days && seq === this.requestSeq) {
          this.report = null;
          this.error = e.message;
        }
      } finally {
        if (this.project === project && this.days === days && seq === this.requestSeq) this.loading = false;
      }
    },
  },
  template: `
    <section class="card" aria-label="Spend and model usage">
      <div class="card-header">
        <span class="card-title">Spend &amp; model usage</span>
        <span v-if="project" class="chip">{{ project }}</span>
        <select v-model.number="days" class="select right" style="width: 104px" aria-label="Spend window">
          <option :value="7">7 days</option>
          <option :value="30">30 days</option>
          <option :value="90">90 days</option>
          <option :value="365">365 days</option>
        </select>
        <button class="btn btn-ghost btn-sm" @click="load" :disabled="loading" aria-label="Refresh spend report" title="Refresh spend report">
          <span v-if="loading" class="spinner"></span><span v-else>↻</span>
        </button>
      </div>

      <div v-if="loading && !report" class="col">
        <div class="skeleton" style="height: 42px"></div>
        <div class="skeleton" style="height: 80px"></div>
      </div>
      <div v-else-if="error" class="banner banner-err">
        <span class="grow">{{ error }}</span>
        <button class="btn btn-sm" @click="load">Retry</button>
      </div>
      <template v-else-if="report">
        <div class="grid-4" style="margin-bottom: var(--sp-3)">
          <div class="kpi"><span class="kpi-value">{{ fmtMoney(report.totals?.usd) }}</span><span class="kpi-label">Equivalent cost</span></div>
          <div class="kpi"><span class="kpi-value">{{ report.totals?.n || 0 }}</span><span class="kpi-label">Calls</span></div>
          <div class="kpi"><span class="kpi-value" :style="report.totals?.errors ? {color:'var(--err)'} : null">{{ report.totals?.errors || 0 }}</span><span class="kpi-label">Errors</span></div>
          <div class="kpi"><span class="kpi-value">{{ report.totals?.cache_hit_pct || 0 }}%</span><span class="kpi-label">Cache hit</span></div>
        </div>
        <div v-if="report.rows?.length" class="table-scroll">
          <table class="table">
            <thead><tr><th>Task</th><th>Model</th><th>Calls</th><th>Cost</th><th>Tokens in/out</th><th>Cache</th></tr></thead>
            <tbody>
              <tr v-for="row in report.rows.slice(0, compact ? 6 : 20)" :key="row.task + ':' + row.model">
                <td>{{ row.task }}</td>
                <td class="mono xs">{{ shortModel(row.model) }}</td>
                <td>{{ row.n }}<span v-if="row.errors" style="color:var(--err)"> · {{ row.errors }} err</span></td>
                <td class="mono">{{ fmtMoney(row.usd) }}</td>
                <td class="mono xs muted">{{ fmtTokens(row.input_tokens) }} / {{ fmtTokens(row.output_tokens) }}</td>
                <td>{{ row.cache_hit_pct || 0 }}%</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="empty"><span>No calls in this window</span></div>
        <p v-if="report.totals?.uncosted" class="xs muted" style="margin-top:var(--sp-2)">
          {{ report.totals.uncosted }} call(s) had no cost data and are excluded from the equivalent-cost total.
        </p>
      </template>
    </section>
  `,
};
