// Overview tab — composition of the "what's happening" widgets: next-action
// suggestions, KPI grid, project budget + window gauge, pipeline queue, live
// log, a quality dashboard card, and a last-run summary card (own fetch;
// hides silently on error).

import { store } from '../../lib/store.js';
import { router } from '../../lib/router.js';
import { api } from '../../lib/api.js';
import { fmtMoney, fmtTokens, fmtDur, fmtDate, statusMeta, pauseKindMeta, sparklineSvg } from '../../lib/format.js';
import NextActions from '../widgets/NextActions.js';
import PipelinePanel from '../widgets/PipelinePanel.js';
import WindowGauge from '../widgets/WindowGauge.js';
import LiveLog from '../widgets/LiveLog.js';

const TONE_COLORS = {
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  err: 'var(--err)',
  info: 'var(--info)',
};

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// Quality reports have evolved across releases. Normalize every nested value
// used by the template so a partial/legacy payload degrades to dashes instead
// of taking down the entire Overview tab.
export function normalizeQualityReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return null;
  const context = report.context_compiler && typeof report.context_compiler === 'object' && !Array.isArray(report.context_compiler)
    ? report.context_compiler
    : null;
  return {
    ...report,
    acceptance: objectOrEmpty(report.acceptance),
    rounds: Array.isArray(report.rounds) ? report.rounds.filter((row) => row && typeof row === 'object') : [],
    tasks: Array.isArray(report.tasks) ? report.tasks.filter((row) => row && typeof row === 'object') : [],
    cache_trend: Array.isArray(report.cache_trend) ? report.cache_trend.filter((row) => row && typeof row === 'object') : [],
    context_compiler: context ? {
      ...context,
      rollout: context.rollout && typeof context.rollout === 'object' && !Array.isArray(context.rollout)
        ? context.rollout : null,
      samples: objectOrEmpty(context.samples),
      accuracy: objectOrEmpty(context.accuracy),
      tokens: objectOrEmpty(context.tokens),
    } : null,
  };
}

export default {
  name: 'OverviewTab',
  components: { NextActions, PipelinePanel, WindowGauge, LiveLog },
  data() {
    return {
      lastRun: null,      // newest auto_runs row | null
      runLoading: true,   // → skeleton card
      runHidden: false,   // no runs → hide the optional card
      runError: '',
      quality: null,      // getQualityReport() payload | null
      qualityLoading: true,
      qualityHidden: false, // no report → hide the optional card
      qualityError: '',
      runRequestSeq: 0,
      qualityRequestSeq: 0,
    };
  },
  computed: {
    name() { return router.project; },
    // detail may be null or lag router.project while loading — only render when it matches
    d() {
      const d = store.state.detail;
      return d && d.name === this.name ? d : null;
    },
    ready() { return !!this.d; },
    loadError() { return store.state.detailError; },
    now() { return store.state.now; },
    cost() { return (this.d && this.d.cost) || {}; },
    bugInbox() { return (this.d && this.d.bugInbox) || 0; },
    reqInbox() { return (this.d && this.d.reqInbox) || 0; },
    phaseText() {
      return ((this.d && this.d.current_phase) || 0) + ' / ' + ((this.d && this.d.total_phases) || 0);
    },
    runStatus() {
      const d = store.state.detail;
      return d && d.autoRun ? d.autoRun.status : null;
    },
    runMeta() { return statusMeta(this.lastRun ? this.lastRun.status : null); },
    runPk() {
      return this.lastRun && this.lastRun.pause_kind ? pauseKindMeta(this.lastRun.pause_kind) : null;
    },
    runPkColor() {
      return (this.runPk && TONE_COLORS[this.runPk.tone]) || 'var(--warn)';
    },
    runElapsed() {
      const r = this.lastRun;
      if (!r || !r.started_at) return '–';
      const start = new Date(r.started_at).getTime();
      if (r.status === 'running') return fmtDur(this.now - start);
      if (!r.ended_at) return '–';
      return fmtDur(new Date(r.ended_at).getTime() - start);
    },
    roundsSparkline() {
      const rounds = (this.quality && this.quality.rounds) || [];
      if (!rounds.length) return null;
      return sparklineSvg(rounds.map((r) => r.found_count), { width: 100, height: 24 });
    },
  },
  watch: {
    runStatus() { this.fetchLastRun(); this.fetchQuality(); },
    // tab instance can survive a project switch — reset and refetch
    name() {
      this.lastRun = null;
      this.runHidden = false;
      this.runError = '';
      this.runLoading = true;
      this.quality = null;
      this.qualityHidden = false;
      this.qualityError = '';
      this.qualityLoading = true;
      this.fetchLastRun();
      this.fetchQuality();
    },
  },
  mounted() { this.fetchLastRun(); this.fetchQuality(); },
  methods: {
    fmtMoney, fmtTokens, fmtDate,
    retry() { store.loadDetail(this.name); },
    async fetchLastRun() {
      if (!this.name) return;
      const name = this.name;
      const seq = ++this.runRequestSeq;
      this.runLoading = true;
      this.runError = '';
      try {
        const rows = await api('GET', '/projects/' + encodeURIComponent(name) + '/runs?limit=1');
        if (this.name !== name || seq !== this.runRequestSeq) return;
        this.lastRun = Array.isArray(rows)
          ? (rows.find((row) => row && typeof row === 'object') || null)
          : null;
        this.runHidden = !this.lastRun;
      } catch (e) {
        if (this.name !== name || seq !== this.runRequestSeq) return;
        this.lastRun = null;
        this.runHidden = false;
        this.runError = e.message;
      } finally {
        if (this.name === name && seq === this.runRequestSeq) this.runLoading = false;
      }
    },
    async fetchQuality() {
      if (!this.name) return;
      const name = this.name;
      const seq = ++this.qualityRequestSeq;
      this.qualityLoading = true;
      this.qualityError = '';
      try {
        const report = await api('GET', '/projects/' + encodeURIComponent(name) + '/quality');
        if (this.name !== name || seq !== this.qualityRequestSeq) return;
        this.quality = normalizeQualityReport(report);
        this.qualityHidden = !this.quality;
      } catch (e) {
        if (this.name !== name || seq !== this.qualityRequestSeq) return;
        this.quality = null;
        this.qualityHidden = false;
        this.qualityError = e.message;
      } finally {
        if (this.name === name && seq === this.qualityRequestSeq) this.qualityLoading = false;
      }
    },
    cacheTrendFor(task) {
      const rows = (this.quality && this.quality.cache_trend) || [];
      return rows.find((r) => r.task === task) || null;
    },
  },
  template: `
    <div class="col" style="gap: var(--sp-4)">

      <div v-if="!ready && loadError" class="banner banner-err">
        {{ loadError }}
        <button class="btn btn-sm right" @click="retry">Retry</button>
      </div>

      <div v-else-if="!ready" class="col" style="gap: var(--sp-3)">
        <div class="skeleton" style="height: 30px"></div>
        <div class="skeleton" style="height: 90px"></div>
        <div class="skeleton" style="height: 46px"></div>
        <div class="skeleton" style="height: 180px"></div>
      </div>

      <template v-else>
        <NextActions />

        <div class="grid-4">
          <div class="kpi">
            <span class="kpi-value">{{ fmtMoney(cost.total_cost) }}</span>
            <span class="kpi-label">Total cost</span>
          </div>
          <div class="kpi">
            <span class="kpi-value">{{ fmtTokens(cost.total_input) }} / {{ fmtTokens(cost.total_output) }}</span>
            <span class="kpi-label">Tokens in / out</span>
          </div>
          <div class="kpi">
            <span class="kpi-value">{{ cost.total_calls || 0 }}</span>
            <span class="kpi-label">Calls</span>
          </div>
          <div class="kpi">
            <span class="kpi-value">{{ phaseText }}</span>
            <span class="kpi-label">Phase</span>
          </div>
          <div class="kpi">
            <span class="kpi-value" :style="bugInbox > 0 ? { color: 'var(--err)' } : {}">{{ bugInbox }}</span>
            <span class="kpi-label">Bugs inbox</span>
          </div>
          <div class="kpi">
            <span class="kpi-value" :style="reqInbox > 0 ? { color: 'var(--info)' } : {}">{{ reqInbox }}</span>
            <span class="kpi-label">Reqs inbox</span>
          </div>
        </div>

        <div class="card">
          <WindowGauge :compact="true" />
        </div>

        <PipelinePanel />

        <LiveLog />

        <div v-if="qualityLoading" class="card">
          <div class="card-header"><span class="card-title">Quality</span></div>
          <div class="skeleton" style="height: 60px"></div>
        </div>
        <div v-else-if="qualityError" class="banner banner-err">
          <span class="grow">Quality data unavailable: {{ qualityError }}</span>
          <button class="btn btn-sm" @click="fetchQuality">Retry</button>
        </div>
        <div v-else-if="quality && !qualityHidden" class="card">
          <div class="card-header"><span class="card-title">Quality</span></div>
          <div class="grid-4">
            <div class="kpi">
              <span class="kpi-value">{{ quality.acceptance.first_pass_pct != null ? quality.acceptance.first_pass_pct + '%' : '–' }}</span>
              <span class="kpi-label">First-pass ({{ quality.acceptance.pass_n }}/{{ quality.acceptance.n }})</span>
            </div>
            <div class="kpi">
              <span class="kpi-value" v-if="roundsSparkline" v-html="roundsSparkline"></span>
              <span class="kpi-value" v-else>–</span>
              <span class="kpi-label">Bug-round convergence</span>
            </div>
          </div>
          <div v-if="quality.tasks.length" class="table-scroll" style="margin-top: var(--sp-3)">
          <table class="table">
            <thead>
              <tr><th>Task</th><th>N</th><th>Escalation</th><th>Turns / cap</th><th>Cache 7d</th><th>Cache 30d</th></tr>
            </thead>
            <tbody>
              <tr v-for="t in quality.tasks" :key="t.task">
                <td>{{ t.task }}</td>
                <td class="nowrap muted">{{ t.n }}</td>
                <td class="nowrap">{{ t.escalation_pct != null ? t.escalation_pct + '%' : '–' }}</td>
                <td class="nowrap muted">{{ t.avg_num_turns != null ? t.avg_num_turns : '–' }} / {{ t.avg_max_turns != null ? t.avg_max_turns : '–' }}</td>
                <td class="nowrap muted">{{ (cacheTrendFor(t.task) && cacheTrendFor(t.task).cache_hit_pct_7d != null) ? cacheTrendFor(t.task).cache_hit_pct_7d + '%' : '–' }}</td>
                <td class="nowrap muted">{{ (cacheTrendFor(t.task) && cacheTrendFor(t.task).cache_hit_pct_30d != null) ? cacheTrendFor(t.task).cache_hit_pct_30d + '%' : '–' }}</td>
              </tr>
            </tbody>
          </table>
          </div>
          <div v-if="quality.context_compiler" style="margin-top: var(--sp-4); padding-top: var(--sp-3); border-top: 1px solid var(--border)">
            <div class="row-wrap" style="margin-bottom: var(--sp-2)">
              <strong>Hybrid context compiler</strong>
              <span class="chip">{{ quality.context_compiler.status }}</span>
              <span v-if="quality.context_compiler.rollout" class="chip">
                {{ quality.context_compiler.rollout.configured_mode }} → {{ quality.context_compiler.rollout.effective_mode }}
              </span>
            </div>
            <div v-if="quality.context_compiler.status === 'no-data'" class="small dim">
              No compiler data yet — collecting the shadow baseline after the next orchestrator restart.
            </div>
            <template v-else>
              <div class="grid-4">
                <div class="kpi">
                  <span class="kpi-value">{{ quality.context_compiler.samples.compile_attempts }}</span>
                  <span class="kpi-label">Compile attempts</span>
                </div>
                <div class="kpi">
                  <span class="kpi-value">{{ quality.context_compiler.accuracy.edit_recall_pct != null ? quality.context_compiler.accuracy.edit_recall_pct + '%' : '–' }}</span>
                  <span class="kpi-label">Changed-file recall</span>
                </div>
                <div class="kpi">
                  <span class="kpi-value">{{ quality.context_compiler.accuracy.edit_precision_pct != null ? quality.context_compiler.accuracy.edit_precision_pct + '%' : '–' }}</span>
                  <span class="kpi-label">Edit-target precision</span>
                </div>
                <div class="kpi">
                  <span class="kpi-value">{{ quality.context_compiler.tokens.matched_shadow_delta_pct != null ? quality.context_compiler.tokens.matched_shadow_delta_pct + '%' : '–' }}</span>
                  <span class="kpi-label">Context-work reduction proxy</span>
                </div>
              </div>
              <div class="small dim" style="margin-top: var(--sp-2)">
                {{ quality.context_compiler.samples.compile_errors }} failures ·
                {{ quality.context_compiler.samples.compile_timeouts }} timeouts ·
                {{ quality.context_compiler.samples.measured_outcomes }} measured outcomes ·
                comparison confidence: {{ quality.context_compiler.tokens.confidence }}.
                These are advisory context-work estimates, not a causal A/B result or Claude Max quota conversion.
              </div>
            </template>
          </div>
        </div>

        <div v-if="runLoading" class="card">
          <div class="card-header"><span class="card-title">Last run</span></div>
          <div class="skeleton" style="height: 40px"></div>
        </div>
        <div v-else-if="runError" class="banner banner-err">
          <span class="grow">Run history unavailable: {{ runError }}</span>
          <button class="btn btn-sm" @click="fetchLastRun">Retry</button>
        </div>
        <div v-else-if="lastRun && !runHidden" class="card">
          <div class="card-header">
            <span class="card-title">Last run</span>
            <span class="badge" :style="{ '--badge-c': runMeta.color }">{{ runMeta.label }}</span>
            <span v-if="runPk" class="badge" :style="{ '--badge-c': runPkColor }">{{ runPk.icon }} {{ runPk.label }}</span>
            <span v-if="lastRun.unattended == 1" class="chip">unattended</span>
          </div>
          <div class="row-wrap small dim">
            <span>started {{ fmtDate(lastRun.started_at) }}</span>
            <span class="mono">· {{ runElapsed }}</span>
          </div>
          <div v-if="lastRun.pause_reason" class="small dim"
               style="white-space: pre-line; margin-top: var(--sp-2)">{{ lastRun.pause_reason }}</div>
        </div>
      </template>
    </div>
  `,
};
