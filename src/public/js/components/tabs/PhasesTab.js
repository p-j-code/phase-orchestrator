// Phases tab — vertical stepper with per-phase expand: calls, report viewer,
// promote-findings (completed audit phases), skip (pending phases).

import { store } from '../../lib/store.js';
import { router } from '../../lib/router.js';
import { api } from '../../lib/api.js';
import { renderMarkdown } from '../../lib/markdown.js';
import { fmtDur, fmtDate, modelShort, statusMeta, pct, routingStepLabel } from '../../lib/format.js';
import CallsTable from '../widgets/CallsTable.js';

export default {
  name: 'PhasesTab',
  components: { CallsTable },
  data() {
    return {
      expanded: {},   // phase n → true
      reports: {},    // phase n → {loading, html, error, notFound, shown} (cached per phase)
      routing: {},    // phase n → {loading, error, data} (Phase 61 — decision chain, cached per phase)
      auditFiles: null,
      auditFilesLoading: false,
      auditFilesError: '',
      selectedAudits: {},
      auditErrors: {},
      reportRequestIds: {},
      routingRequestIds: {},
      auditRequestId: 0,
    };
  },
  computed: {
    name() { return router.project; },
    detail() { return store.state.detail; },
    loading() { return store.state.detailLoading; },
    loadError() { return store.state.detailError; },
    ready() { return !!(this.detail && this.detail.name === this.name); },
    phases() {
      if (!this.ready || !Array.isArray(this.detail.phases)) return [];
      return [...this.detail.phases].sort((a, b) => a.n - b.n);
    },
    counts() {
      const c = { completed: 0, inProgress: 0, skipped: 0, failed: 0, pending: 0 };
      for (const p of this.phases) {
        if (p.status === 'completed') c.completed++;
        else if (p.status === 'in-progress') c.inProgress++;
        else if (p.status === 'skipped') c.skipped++;
        else if (p.status === 'failed') c.failed++;
        else c.pending++;
      }
      return c;
    },
    donePct() {
      return pct(this.counts.completed + this.counts.skipped, this.phases.length);
    },
    busy() { return store.state.busy; },
    mutationLocked() {
      return !!(this.ready && (this.detail.processAlive ||
        this.detail.autoRun?.status === 'running' || this.detail.pendingJob));
    },
  },
  watch: {
    // Tab instance can survive a project switch — drop per-phase local state.
    name() {
      this.auditRequestId++;
      this.expanded = {};
      this.reports = {};
      this.routing = {};
      this.reportRequestIds = {};
      this.routingRequestIds = {};
      this.auditFiles = null;
      this.auditFilesLoading = false;
      this.auditFilesError = '';
      this.selectedAudits = {};
      this.auditErrors = {};
    },
    detail(d) {
      if (d?.name === this.name && (d.phases || []).some((p) => this.isAudit(p))) this.ensureAuditFiles();
    },
  },
  mounted() {
    if (this.phases.some((p) => this.isAudit(p))) this.ensureAuditFiles();
  },
  beforeUnmount() {
    this.auditRequestId++;
    this.reportRequestIds = {};
    this.routingRequestIds = {};
  },
  methods: {
    fmtDur, fmtDate, modelShort, statusMeta, pct,
    retryDetail() { store.loadDetail(this.name); },
    toggle(n) {
      this.expanded[n] = !this.expanded[n];
      if (this.expanded[n] && !this.routing[n]) this.fetchRouting(n);
      const phase = this.phases.find((p) => p.n === n);
      if (this.expanded[n] && phase && this.isAudit(phase)) this.ensureAuditFiles();
    },
    async fetchRouting(n) {
      const name = this.name;
      const requestId = (this.routingRequestIds[n] || 0) + 1;
      this.routingRequestIds[n] = requestId;
      this.routing[n] = { loading: true, error: '', data: null };
      try {
        const r = await api('GET', '/projects/' + encodeURIComponent(name) + '/phases/' + n + '/routing');
        if (this.name !== name || this.routingRequestIds[n] !== requestId) return;
        this.routing[n] = { loading: false, error: '', data: r };
      } catch (e) {
        if (this.name !== name || this.routingRequestIds[n] !== requestId) return;
        this.routing[n] = { loading: false, error: e.message, data: null };
      }
    },
    // One step per call in the phase's decision chain — the empty array (no
    // calls, or pre-foundations rows) renders as "no routing recorded".
    routingSteps(n) {
      const d = this.routing[n] && this.routing[n].data;
      if (!d || !Array.isArray(d.calls)) return [];
      return d.calls.map(routingStepLabel).filter(Boolean);
    },
    routingVerdictText(n) {
      const d = this.routing[n] && this.routing[n].data;
      if (!d) return '';
      if (d.verdict) return 'acceptance ' + d.verdict.verdict;
      return d.status === 'completed' ? 'completed, no acceptance check recorded' : '';
    },
    routingVerdictColor(n) {
      const d = this.routing[n] && this.routing[n].data;
      const v = d && d.verdict && d.verdict.verdict;
      if (v === 'pass') return 'var(--ok)';
      if (v === 'fail') return 'var(--err)';
      return 'var(--muted)';
    },
    isAudit(p) { return p.status === 'completed' && /audit/i.test(p.title || ''); },
    clearAuditError(n) { delete this.auditErrors[n]; },
    async ensureAuditFiles() {
      if (this.auditFiles !== null || this.auditFilesLoading || !this.name) return;
      const name = this.name;
      const requestId = ++this.auditRequestId;
      this.auditFilesLoading = true;
      this.auditFilesError = '';
      try {
        const rows = await api('GET', '/projects/' + encodeURIComponent(name) + '/artifacts');
        if (this.name !== name || this.auditRequestId !== requestId) return;
        this.auditFiles = (Array.isArray(rows) ? rows : [])
          // The promotion API intentionally accepts a basename directly under
          // .guide/audits/. Do not offer audit-named files from reports or a
          // nested folder that the backend will correctly reject.
          .filter((f) => f.group === 'audits'
            && f.path === 'audits/' + f.name
            && /^audit-[a-zA-Z0-9_.-]+\.md$/.test(f.name || ''))
          .sort((a, b) => new Date(b.mtime || 0) - new Date(a.mtime || 0));
        // A single exact artifact is unambiguous; multiple audit artifacts must
        // be chosen explicitly instead of silently selecting "latest".
        if (this.auditFiles.length === 1) {
          for (const phase of this.phases.filter((p) => this.isAudit(p))) {
            this.selectedAudits[phase.n] = this.auditFiles[0].name;
          }
        }
      } catch (e) {
        if (this.name === name && this.auditRequestId === requestId) this.auditFilesError = e.message;
      } finally {
        if (this.name === name && this.auditRequestId === requestId) this.auditFilesLoading = false;
      }
    },
    dotStyle(status) {
      if (status === 'in-progress') return { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' };
      if (status === 'completed')   return { borderColor: 'var(--ok)',  color: 'var(--ok)',  background: 'var(--ok-soft)' };
      if (status === 'failed')      return { borderColor: 'var(--err)', color: 'var(--err)', background: 'var(--err-soft)' };
      if (status === 'skipped')     return { color: 'var(--muted)' };
      return {};
    },
    duration(p) {
      return fmtDur(new Date(p.completed_at) - new Date(p.started_at));
    },
    elapsed(p) {
      if (!p.started_at) return '';
      return fmtDur(store.state.now - new Date(p.started_at).getTime());
    },
    reportBtnLabel(n) {
      const r = this.reports[n];
      return r && r.shown && !r.loading ? 'Hide report' : 'View report';
    },
    async toggleReport(n) {
      const cur = this.reports[n];
      if (cur && cur.loading) return;
      if (cur && cur.shown) { cur.shown = false; return; }
      if (cur && (cur.html || cur.notFound)) { cur.shown = true; return; }
      await this.fetchReport(n);
    },
    async fetchReport(n) {
      const name = this.name;
      const requestId = (this.reportRequestIds[n] || 0) + 1;
      this.reportRequestIds[n] = requestId;
      this.reports[n] = { loading: true, html: '', error: '', notFound: false, shown: true };
      try {
        const r = await api('GET', '/projects/' + encodeURIComponent(name) + '/phases/' + n + '/report');
        if (this.name !== name || this.reportRequestIds[n] !== requestId) return;
        this.reports[n] = { loading: false, html: renderMarkdown(r && r.content), error: '', notFound: false, shown: true };
      } catch (e) {
        if (this.name !== name || this.reportRequestIds[n] !== requestId) return;
        const notFound = /not found|not written/i.test(e.message);
        this.reports[n] = { loading: false, html: '', error: notFound ? '' : e.message, notFound, shown: true };
      }
    },
    async promote(p) {
      if (this.mutationLocked) {
        store.toast('Wait for the active or queued project job to finish before promoting findings.', 'warn');
        return;
      }
      const name = this.name;
      const auditFile = this.selectedAudits[p.n];
      if (!auditFile) {
        this.auditErrors[p.n] = this.auditFilesError || 'Choose the exact audit artifact to promote.';
        store.toast(this.auditErrors[p.n], 'warn');
        return;
      }
      delete this.auditErrors[p.n];
      const yes = await store.confirmAction({
        title: 'Promote audit findings?',
        body: `Findings from “${auditFile}” will be promoted into a bug-fix round.`,
        confirmLabel: 'Promote findings',
      });
      if (!yes || this.name !== name || this.mutationLocked) return;
      const r = await store.act('promote-audit:' + name + ':' + p.n, 'POST',
        '/projects/' + encodeURIComponent(name) + '/promote-audit', { auditFile },
        { errPrefix: 'Promote failed' });
      if (r) {
        let msg = 'Findings promoted → fix round ' + r.round + (r.appended ? ' (appended)' : '');
        if (r.warning) msg += ' — ' + r.warning;
        store.toast(msg, 'ok');
        if (this.name === name) store.loadDetail(name);
      }
    },
    async skip(p) {
      if (this.mutationLocked) {
        store.toast('Wait for the active or queued project job to finish before skipping a phase.', 'warn');
        return;
      }
      const name = this.name;
      const yes = await store.confirmAction({
        title: `Skip phase ${p.n}?`,
        body: 'Phase will be marked skipped and the run will move past it.',
        danger: true,
        confirmLabel: 'Skip phase',
      });
      if (!yes || this.name !== name || this.mutationLocked) return;
      const r = await store.act('skip:' + name + ':' + p.n, 'POST',
        '/projects/' + encodeURIComponent(name) + '/phases/' + p.n + '/skip', undefined,
        { okMsg: `Phase ${p.n} skipped`, errPrefix: 'Skip failed' });
      if (r && this.name === name) store.loadDetail(name);
    },
  },
  template: `
    <div class="col" style="gap: var(--sp-4)">

      <div v-if="!ready && loadError" class="banner banner-err">
        {{ loadError }}
        <button class="btn btn-sm right" @click="retryDetail">Retry</button>
      </div>

      <div v-else-if="!ready" class="col">
        <div class="skeleton" style="height: 72px"></div>
        <div class="skeleton" style="height: 240px"></div>
      </div>

      <div v-else-if="!phases.length" class="card">
        <div class="empty">
          <span class="empty-icon">◇</span>
          <span>No phases planned yet</span>
          <span class="empty-hint">The guide agent creates the phase plan during planning</span>
        </div>
      </div>

      <template v-else>
        <div class="card">
          <div class="card-header">
            <span class="card-title">Progress</span>
            <span class="right xs mono muted">{{ counts.completed + counts.skipped }}/{{ phases.length }}</span>
          </div>
          <div class="row-wrap">
            <span class="badge" style="--badge-c: var(--ok)">{{ counts.completed }} done</span>
            <span v-if="counts.inProgress" class="badge" style="--badge-c: var(--accent)">{{ counts.inProgress }} in progress</span>
            <span v-if="counts.skipped" class="badge" style="--badge-c: var(--muted)">{{ counts.skipped }} skipped</span>
            <span v-if="counts.failed" class="badge" style="--badge-c: var(--err)">{{ counts.failed }} failed</span>
            <span v-if="counts.pending" class="badge" style="--badge-c: var(--muted)">{{ counts.pending }} pending</span>
          </div>
          <div class="progress progress-lg" style="margin-top: var(--sp-3)" role="progressbar"
               aria-label="Phase progress" aria-valuemin="0" :aria-valuemax="phases.length"
               :aria-valuenow="counts.completed + counts.skipped">
            <div class="progress-fill" :style="{ width: donePct + '%', '--fill-c': 'var(--accent)' }"></div>
          </div>
        </div>

        <div class="card">
          <div class="stepper">
            <div v-for="p in phases" :key="p.n" class="step">
              <div class="step-rail">
                <div class="step-dot" :style="dotStyle(p.status)">
                  <span v-if="p.status === 'in-progress'" class="spinner"></span>
                  <span v-else-if="p.status === 'completed'">✓</span>
                  <span v-else-if="p.status === 'failed'">✗</span>
                  <span v-else-if="p.status === 'skipped'">⤼</span>
                  <span v-else>{{ p.n }}</span>
                </div>
                <div class="step-line"></div>
              </div>

              <div class="step-body">
                <div class="row" role="button" tabindex="0" style="cursor: pointer"
                     :aria-expanded="!!expanded[p.n]"
                     :aria-label="'Toggle phase ' + p.n + ' details'"
                     @click="toggle(p.n)" @keydown.enter.prevent="toggle(p.n)" @keydown.space.prevent="toggle(p.n)">
                  <span class="bold truncate">{{ p.title || ('Phase ' + p.n) }}</span>
                  <span class="badge nowrap" :style="{ '--badge-c': statusMeta(p.status).color }">{{ statusMeta(p.status).label }}</span>
                  <span v-if="p.status === 'in-progress' && p.started_at" class="xs mono nowrap" style="color: var(--accent)">{{ elapsed(p) }}</span>
                  <span class="right muted xs" aria-hidden="true">{{ expanded[p.n] ? '▾' : '▸' }}</span>
                </div>

                <div class="row-wrap" style="margin-top: 5px">
                  <span v-if="p.model_used" class="chip mono">{{ modelShort(p.model_used) }}</span>
                  <span v-if="p.commit_sha" class="chip mono" :title="p.commit_sha">{{ p.commit_sha.slice(0, 7) }}</span>
                  <span v-if="p.session_id" class="chip mono" :title="'session ' + p.session_id">{{ p.session_id.slice(0, 8) }}</span>
                  <span v-if="p.started_at" class="xs muted nowrap">
                    {{ fmtDate(p.started_at) }}<template v-if="p.completed_at"> → {{ fmtDate(p.completed_at) }}</template>
                  </span>
                  <span v-if="p.started_at && p.completed_at" class="xs muted nowrap">({{ duration(p) }})</span>
                  <button v-if="p.status === 'pending'" class="btn btn-ghost btn-sm right"
                          :disabled="mutationLocked || busy['skip:' + name + ':' + p.n]"
                          :title="mutationLocked ? 'A project job is active or queued' : 'Skip this phase'"
                          @click.stop="skip(p)">
                    <span v-if="busy['skip:' + name + ':' + p.n]" class="spinner"></span> Skip
                  </button>
                </div>

                <div v-if="expanded[p.n]" style="margin-top: var(--sp-3)">
                  <div class="xs muted" style="margin-bottom: var(--sp-2)">Routing decisions</div>
                  <div v-if="routing[p.n] && routing[p.n].loading" class="skeleton" style="height: 24px; margin-bottom: var(--sp-3)"></div>
                  <div v-else-if="routing[p.n] && routing[p.n].error" class="xs muted" style="margin-bottom: var(--sp-3)">
                    Routing unavailable: {{ routing[p.n].error }}
                  </div>
                  <div v-else class="row-wrap" style="margin-bottom: var(--sp-3)" aria-label="Routing decision chain">
                    <span v-if="!routingSteps(p.n).length" class="xs muted">no routing recorded</span>
                    <template v-for="(s, i) in routingSteps(p.n)" :key="s.id">
                      <span v-if="i > 0" class="xs muted" aria-hidden="true">→</span>
                      <span class="chip mono" :style="s.isError ? 'color: var(--err)' : ''">
                        <template v-if="!s.hasRouting">no routing recorded ({{ modelShort(s.model) }})</template>
                        <template v-else>{{ i === 0 ? 'baseline' : 'escalated' }} {{ modelShort(s.tier || s.model) }}<template v-if="s.attempt && i > 0"> (attempt {{ s.attempt }})</template></template>
                      </span>
                      <span v-if="s.reason" class="xs muted truncate" style="max-width: 40ch" :title="s.reason">— {{ s.reason }}</span>
                      <span class="xs" :style="s.isError ? 'color: var(--err)' : 'color: var(--ok)'">{{ s.outcome }}</span>
                    </template>
                    <template v-if="routingSteps(p.n).length">
                      <span class="xs muted" aria-hidden="true">→</span>
                      <span class="badge" :style="{ '--badge-c': routingVerdictColor(p.n) }">{{ routingVerdictText(p.n) || 'no acceptance check recorded' }}</span>
                    </template>
                  </div>

                  <CallsTable :project="name" :phase="p.n" compact />

                  <div class="row-wrap" style="margin-top: var(--sp-3)">
                    <button class="btn btn-sm" :disabled="reports[p.n] && reports[p.n].loading" @click="toggleReport(p.n)">
                      <span v-if="reports[p.n] && reports[p.n].loading" class="spinner"></span>
                      {{ reportBtnLabel(p.n) }}
                    </button>
                    <select v-if="isAudit(p) && auditFiles && auditFiles.length" v-model="selectedAudits[p.n]"
                            class="select" style="width: auto; max-width: 100%" :aria-label="'Audit artifact for phase ' + p.n"
                            @change="clearAuditError(p.n)">
                      <option value="" disabled>Choose audit artifact…</option>
                      <option v-for="audit in auditFiles" :key="audit.path" :value="audit.name">{{ audit.name }}</option>
                    </select>
                    <span v-if="isAudit(p) && auditFilesLoading" class="xs muted"><span class="spinner"></span> Loading audit artifacts…</span>
                    <button v-if="isAudit(p)" class="btn btn-sm btn-primary"
                            :disabled="mutationLocked || auditFilesLoading || !selectedAudits[p.n] || busy['promote-audit:' + name + ':' + p.n]"
                            :title="mutationLocked ? 'A project job is active or queued' : (selectedAudits[p.n] ? 'Promote ' + selectedAudits[p.n] : 'Choose an exact audit artifact first')"
                            @click="promote(p)">
                      <span v-if="busy['promote-audit:' + name + ':' + p.n]" class="spinner"></span>
                      ⬆ Promote findings
                    </button>
                  </div>

                  <div v-if="isAudit(p) && (auditFilesError || (auditFiles && !auditFiles.length) || auditErrors[p.n])"
                       class="banner banner-err" style="margin-top: var(--sp-2)">
                    <span class="grow">{{ auditErrors[p.n] || auditFilesError || 'No audit-*.md artifacts are available.' }}</span>
                    <button v-if="auditFilesError" class="btn btn-sm" @click="auditFiles = null; ensureAuditFiles()">Retry</button>
                  </div>

                  <div v-if="reports[p.n] && reports[p.n].shown && !reports[p.n].loading" style="margin-top: var(--sp-2)">
                    <div v-if="reports[p.n].error" class="banner banner-err">
                      {{ reports[p.n].error }}
                      <button class="btn btn-sm right" @click="fetchReport(p.n)">Retry</button>
                    </div>
                    <div v-else-if="reports[p.n].notFound" class="empty">
                      <span class="empty-icon">▤</span>
                      <span>No report yet</span>
                      <span class="empty-hint">The dev agent has not written report.md for this phase</span>
                    </div>
                    <div v-else class="md card-flat scroll-y" style="max-height: 420px" v-html="reports[p.n].html"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>
  `,
};
