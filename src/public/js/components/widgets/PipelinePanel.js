// Pipeline / execution queue panel — derived entirely from store.state.detail
// (no fetching of its own). Rows in order: active phase → paused banner →
// pending phases (collapsible past 5) → active bug round → queued next-brief →
// completed audit passes. Empty when nothing is running or queued.

import { store } from '../../lib/store.js';
import { router } from '../../lib/router.js';
import { api } from '../../lib/api.js';
import { fmtDur, modelShort, pct, runStateOf, pauseKindMeta, routingStepLabel } from '../../lib/format.js';

export default {
  name: 'PipelinePanel',
  data() {
    // routing: the active phase's routing chain (Phase 61), fetched by this
    // widget itself (PipelinePanel has no SSE of its own) — routingPhaseN
    // tracks which phase it belongs to so a stale response never overwrites
    // a newer fetch after the active phase changes mid-flight.
    return { showAllPending: false, routing: null, routingPhaseN: null, routingError: '', routingRequestId: 0 };
  },
  computed: {
    name() { return router.project; },
    // detail may be null or lag router.project while loading — guard everything
    d() {
      const d = store.state.detail;
      return d && d.name === this.name ? d : null;
    },
    now() { return store.state.now; },
    runState() { return runStateOf(this.d); },
    headerRight() {
      if (this.runState === 'running') {
        const started = this.d && this.d.autoRun && this.d.autoRun.started_at;
        return started ? 'running · ' + fmtDur(this.now - new Date(started).getTime()) : 'running';
      }
      if (this.runState === 'paused') return 'paused';
      return 'idle';
    },
    activePhase() {
      const ph = (this.d && Array.isArray(this.d.phases)) ? this.d.phases : [];
      return ph.find((p) => p.status === 'in-progress') || null;
    },
    // "Why this model" chip (Phase 61 — P5): the LATEST call row for the
    // active phase (has the actual routing tier/reason), falling back to P3's
    // live_progress row (Phase 59) when no call has landed yet — a spawn
    // still in flight has no `calls` row (recordCall only fires on finish)
    // but does have a live_progress.model.
    whyChip() {
      const p = this.activePhase;
      if (!p) return null;
      if (this.routingPhaseN === p.n && this.routing && Array.isArray(this.routing.calls) && this.routing.calls.length) {
        return routingStepLabel(this.routing.calls[this.routing.calls.length - 1]);
      }
      const lp = this.d && this.d.liveProgress;
      if (lp && lp.model && lp.phase === p.n) {
        return { model: lp.model, tier: null, reason: null, attempt: null, escalated: false, outcome: null, isError: false, hasRouting: false };
      }
      return null;
    },
    paused() {
      return !!(this.d && this.d.autoRun && this.d.autoRun.status === 'paused');
    },
    pk() {
      return pauseKindMeta(this.d && this.d.autoRun ? this.d.autoRun.pause_kind : null);
    },
    pending() {
      const ph = (this.d && Array.isArray(this.d.phases)) ? this.d.phases : [];
      return ph.filter((p) => p.status === 'pending').sort((a, b) => a.n - b.n);
    },
    shownPending() {
      return this.showAllPending ? this.pending : this.pending.slice(0, 5);
    },
    hiddenPendingCount() { return this.pending.length - 5; },
    activeBugRound() {
      const rounds = (this.d && Array.isArray(this.d.bugRounds)) ? this.d.bugRounds : [];
      return rounds.find((r) => r.status === 'in-progress') || null;
    },
    bugRoundPct() {
      const r = this.activeBugRound;
      return r ? pct(r.fixes_completed, r.total_fixes) : 0;
    },
    hasNextBrief() { return !!(this.d && this.d.hasNextBrief); },
    auditsDone() { return (this.d && this.d.audit_runs_completed) || 0; },
    hasRows() {
      return !!(this.activePhase || this.paused || this.pending.length ||
        this.activeBugRound || this.hasNextBrief || this.auditsDone > 0);
    },
    busy() { return store.state.busy; },
    pendingJob() { return this.d?.pendingJob || null; },
    mutationLocked() { return this.runState === 'running' || !!this.pendingJob; },
    // A stable primitive (not the whole object) so the routing fetch only
    // re-fires when the ACTIVE PHASE actually changes, not on every
    // store.state.detail refresh that returns the same phase.
    activePhaseN() { return this.activePhase ? this.activePhase.n : null; },
  },
  watch: {
    name() {
      this.routingRequestId++;
      this.routing = null;
      this.routingPhaseN = null;
      this.routingError = '';
    },
    activePhaseN(n) {
      if (n == null) { this.routing = null; this.routingPhaseN = null; return; }
      this.fetchRouting(n);
    },
  },
  mounted() {
    if (this.activePhaseN != null) this.fetchRouting(this.activePhaseN);
  },
  beforeUnmount() { this.routingRequestId++; },
  methods: {
    modelShort,
    async fetchRouting(n) {
      const name = this.name;
      const requestId = ++this.routingRequestId;
      this.routingPhaseN = n;
      this.routingError = '';
      try {
        const r = await api('GET', '/projects/' + encodeURIComponent(name) + '/phases/' + n + '/routing');
        if (this.name === name && this.routingPhaseN === n && this.routingRequestId === requestId) this.routing = r;
      } catch (e) {
        if (this.name === name && this.routingPhaseN === n && this.routingRequestId === requestId) {
          this.routing = null;
          this.routingError = e.message;
        }
      }
    },
    phaseLabel(p) {
      return 'Phase ' + p.n + (p.title ? ' — ' + p.title : '');
    },
    phaseElapsed(p) {
      if (!p.started_at) return '';
      return fmtDur(store.state.now - new Date(p.started_at).getTime());
    },
    resume() { store.projectAction(this.name, 'resume'); },
    runNextBrief() { store.projectAction(this.name, 'next-brief'); },
    async skip(p) {
      if (this.mutationLocked) {
        store.toast('Wait for active or queued project work to finish before skipping a phase.', 'warn');
        return;
      }
      const name = this.name;
      const yes = await store.confirmAction({
        title: 'Skip phase ' + p.n + '?',
        body: (p.title || 'Phase ' + p.n) + ' will be marked skipped.',
        danger: true,
        confirmLabel: 'Skip phase',
      });
      if (!yes || this.name !== name || this.mutationLocked) return;
      const r = await store.act('skip:' + name + ':' + p.n, 'POST',
        '/projects/' + encodeURIComponent(name) + '/phases/' + p.n + '/skip', undefined,
        { okMsg: 'Phase ' + p.n + ' skipped' });
      if (r && this.name === name) store.loadDetail(name);
    },
    async clearNextBrief() {
      if (this.mutationLocked) {
        store.toast('Wait for active or queued project work to finish before clearing the queued brief.', 'warn');
        return;
      }
      const name = this.name;
      const yes = await store.confirmAction({
        title: 'Clear queued brief?',
        body: 'The queued next brief will be deleted. This cannot be undone.',
        danger: true,
        confirmLabel: 'Clear brief',
      });
      if (!yes || this.name !== name || this.mutationLocked) return;
      const r = await store.act('clear-next-brief:' + name, 'DELETE',
        '/projects/' + encodeURIComponent(name) + '/brief/next', undefined,
        { okMsg: 'Queued brief cleared' });
      if (r && this.name === name) store.loadDetail(name);
    },
  },
  template: `
    <div class="card">
      <div class="card-header">
        <span class="card-title">Pipeline</span>
        <span class="right xs mono muted">{{ headerRight }}</span>
      </div>

      <div v-if="!hasRows" class="empty">
        <span class="empty-icon">▷</span>
        <span>Nothing queued</span>
        <span class="empty-hint">Start a run or queue a brief.</span>
      </div>

      <div v-else class="col">
        <div v-if="activePhase" class="card-flat row">
          <span class="spinner" style="color: var(--accent)"></span>
          <span class="bold truncate grow">{{ phaseLabel(activePhase) }}</span>
          <span v-if="whyChip" class="chip mono" :title="whyChip.reason || 'why this model ran'"
                style="min-width: 0; max-width: 45%; overflow: hidden; text-overflow: ellipsis;">
            {{ modelShort(whyChip.tier || whyChip.model) }}<template v-if="whyChip.reason"> · {{ whyChip.reason }}</template>
          </span>
          <span v-else-if="activePhase.model_used" class="chip mono">{{ modelShort(activePhase.model_used) }}</span>
          <span v-if="activePhase.started_at" class="xs mono nowrap" style="color: var(--accent)">{{ phaseElapsed(activePhase) }}</span>
        </div>
        <div v-if="activePhase && routingError" class="banner banner-warn">
          <span class="grow">Routing detail unavailable: {{ routingError }}</span>
          <button class="btn btn-sm" @click="fetchRouting(activePhase.n)">Retry</button>
        </div>

        <div v-if="paused" class="banner banner-warn">
          <span>{{ pk.icon }}</span>
          <span class="grow"><b>{{ pk.label }}</b><template v-if="d.autoRun.pause_reason"> — {{ d.autoRun.pause_reason }}</template></span>
          <button class="btn btn-sm btn-primary nowrap" :disabled="busy['resume:' + name] || !!pendingJob" @click="resume"
                  :title="pendingJob ? 'A project job is already queued' : 'Resume the paused run'">
            <span v-if="busy['resume:' + name]" class="spinner"></span> ▶ Resume
          </button>
        </div>

        <div v-for="p in shownPending" :key="p.n" class="row">
          <span class="dot" style="--dot-c: var(--muted)"></span>
          <span class="truncate grow">{{ phaseLabel(p) }}</span>
          <span class="xs muted nowrap">Queued</span>
          <button class="btn btn-ghost btn-sm right nowrap" :disabled="busy['skip:' + name + ':' + p.n] || mutationLocked"
                  :title="mutationLocked ? 'Wait for active or queued project work to finish' : 'Skip phase ' + p.n" @click="skip(p)">
            <span v-if="busy['skip:' + name + ':' + p.n]" class="spinner"></span> × Skip
          </button>
        </div>
        <button v-if="pending.length > 5" class="btn btn-ghost btn-sm"
                style="align-self: flex-start" @click="showAllPending = !showAllPending">
          {{ showAllPending ? 'Show fewer' : hiddenPendingCount + ' more queued…' }}
        </button>

        <div v-if="activeBugRound" class="row">
          <span class="nowrap">🐛 Bug round {{ activeBugRound.round }}</span>
          <div class="progress" role="progressbar" aria-label="Bug round fix progress" aria-valuemin="0"
               :aria-valuemax="activeBugRound.total_fixes" :aria-valuenow="activeBugRound.fixes_completed">
            <div class="progress-fill" :style="{ width: bugRoundPct + '%', '--fill-c': 'var(--orange)' }"></div>
          </div>
          <span class="xs mono muted nowrap">{{ activeBugRound.fixes_completed }}/{{ activeBugRound.total_fixes }}</span>
        </div>

        <div v-if="hasNextBrief" class="row">
          <span class="dot" style="--dot-c: var(--orange)"></span>
          <span class="grow">Next brief queued</span>
          <button class="btn btn-sm nowrap" :disabled="busy['next-brief:' + name] || mutationLocked" @click="runNextBrief"
                  :title="mutationLocked ? 'Wait for active or queued project work to finish' : 'Run the brief agent on the queued brief, then auto-run'">
            <span v-if="busy['next-brief:' + name]" class="spinner"></span> ▶ Run
          </button>
          <button class="btn btn-ghost btn-sm nowrap" :disabled="busy['clear-next-brief:' + name] || mutationLocked"
                  @click="clearNextBrief" :title="mutationLocked ? 'Wait for active or queued project work to finish' : 'Delete the queued brief'">
            <span v-if="busy['clear-next-brief:' + name]" class="spinner"></span> × Clear
          </button>
        </div>

        <div v-if="auditsDone > 0" class="xs muted">audit passes completed: {{ auditsDone }}</div>
      </div>
    </div>
  `,
};
