import { store } from '../lib/store.js';
import { router, navigate, canNavigate } from '../lib/router.js';
import { fmtMoney, fmtTokens, fmtUntil } from '../lib/format.js';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default {
  name: 'AppHeader',
  data() {
    return { showOverflow: false };
  },
  computed: {
    router() { return router; },
    stats() { return store.state.stats; },
    sse() { return store.state.sse; },
    windowInfo() { return store.state.windowInfo; },
    systemHealth() { return store.state.systemHealth; },
    previouslyRunning() { return store.state.previouslyRunning; },
    stopAllBusy() { return !!store.state.busy['stop-all']; },
    restartBusy() { return !!store.state.busy['restart-previous']; },
    restartUiBusy() { return !!store.state.busy['restart-ui']; },
    runningCount() {
      const names = new Set(
        store.state.projects
          .filter((p) => p?.processAlive || p?.autoRun?.status === 'running')
          .map((p) => p.name),
      );
      for (const job of store.state.jobs?.running || []) {
        if (job?.project) names.add(job.project);
      }
      return names.size;
    },
    workerMeta() {
      const worker = this.systemHealth?.worker;
      if (!worker) return { color: 'var(--muted)', label: 'Worker unknown', title: 'Worker health unavailable' };
      if (!worker.alive) return {
        color: 'var(--err)', label: 'Worker down',
        title: worker.staleReason || 'Jobs can queue, but no worker is available to execute them',
      };
      if (worker.leaseHealthy === false) return {
        color: 'var(--warn)', label: 'Worker degraded', title: worker.staleReason || 'Worker lease is unhealthy',
      };
      return { color: 'var(--ok)', label: 'Worker live', title: `Worker PID ${worker.pid || 'unknown'}` };
    },
    canRestartUi() { return this.systemHealth?.capabilities?.restartUi === true; },
    canUseTerminal() { return this.systemHealth?.capabilities?.terminal === true; },
    canUseNas() { return this.systemHealth?.capabilities?.nas === true; },
    sidebarOpen() { return store.state.sidebarOpen; },
    sseMeta() {
      return {
        live:       { c: 'var(--ok)',   label: 'Live' },
        connecting: { c: 'var(--warn)', label: 'Connecting' },
        down:       { c: 'var(--err)',  label: 'Reconnecting' },
      }[this.sse] || { c: 'var(--muted)', label: this.sse };
    },
    windowPct() {
      const w = this.windowInfo;
      if (!w || !w.pauseThreshold) return null;
      return Math.min(100, Math.round((w.callsInWindow / w.pauseThreshold) * 100));
    },
    windowColor() {
      const w = this.windowInfo;
      if (!w) return 'var(--muted)';
      return w.state === 'pause' ? 'var(--err)' : w.state === 'warn' ? 'var(--warn)' : 'var(--ok)';
    },
    // "+1.25u/5a in 34m" — next batch of attempts aging out of the 5h window
    reclaimLabel() {
      const r = this.windowInfo?.reclaim;
      if (!r?.inMs || !r.count) return null;
      const target = r.next ? r.next : Date.now() + r.inMs;
      return `+${r.units ?? r.count}u/${r.count}a in ${fmtUntil(target)}`;
    },
    // weekly calls count
    weeklyCallCount() {
      return this.windowInfo?.weekly?.callsThisWeek ?? null;
    },
    // "Mon" — short weekday of the next weekly reset
    weeklyResetDay() {
      const at = this.windowInfo?.weekly?.nextResetAt;
      if (!at) return null;
      return DAY_NAMES[new Date(at).getUTCDay()];
    },
    // "in 2d" — countdown to the weekly reset
    weeklyResetIn() {
      const ms = this.windowInfo?.weekly?.nextResetInMs;
      if (!ms || ms <= 0) return null;
      const h = Math.floor(ms / 3600000);
      if (h < 1) return 'in < 1h';
      if (h < 24) return `in ${h}h`;
      return `in ${Math.floor(h / 24)}d`;
    },
    // Full tooltip shown on hover over the usage panel
    windowTooltip() {
      const w = this.windowInfo;
      if (!w) return '';
      const pct = this.windowPct ?? 0;
      const rawCalls = w.rawCallsInWindow ?? w.callsInWindow;
      const windowHours = w.windowHours ?? 5;
      const lines = [
        `── ${windowHours}h rolling window ──`,
        `Units:   ${w.callsInWindow} / ${w.pauseThreshold} heavy-eq  (${pct}%)`,
        `Attempts:${rawCalls} raw subprocess calls`,
        `Cost:    $${(w.totalCostInWindow ?? 0).toFixed(2)} / $${w.pauseCostThreshold} ${w.costThresholdsEnforced ? 'enforced' : 'monitor-only'}`,
        `State:   ${(w.state ?? 'ok').toUpperCase()}`,
      ];
      if (w.reclaim?.inMs && w.reclaim.count) {
        const reclaimTarget = w.reclaim.next ? w.reclaim.next : Date.now() + w.reclaim.inMs;
        lines.push(`Reclaim: +${w.reclaim.units ?? w.reclaim.count} units (${w.reclaim.count} attempts) in ${fmtUntil(reclaimTarget)}`);
      }
      if (w.weekly) {
        const resetDay = this.weeklyResetDay;
        const resetIn  = this.weeklyResetIn;
        lines.push('');
        lines.push(`── Weekly (Max plan) ──`);
        lines.push(`Calls:   ${w.weekly.callsThisWeek}`);
        lines.push(`Cost:    $${(w.weekly.costThisWeek ?? 0).toFixed(2)}`);
        lines.push(`Resets:  ${resetDay}${resetIn ? '  (' + resetIn + ')' : ''}`);
      }
      return lines.join('\n');
    },
  },
  mounted() {
    document.addEventListener('pointerdown', this.onDocumentPointer);
    document.addEventListener('keydown', this.onDocumentKey);
  },
  beforeUnmount() {
    document.removeEventListener('pointerdown', this.onDocumentPointer);
    document.removeEventListener('keydown', this.onDocumentKey);
  },
  methods: {
    fmtMoney, fmtTokens,
    goHome() { navigate('#/'); },
    openChat() { navigate('#/chat'); },
    openTerminal() { store.state.showTerminal = true; },
    openNasSync() { store.state.showNasSync = true; },
    async refresh() {
      await store.loadAll();
      const failures = [
        store.state.statsError, store.state.windowError, store.state.projectsError,
        store.state.jobsError, store.state.activityError, store.state.healingError,
        store.state.systemHealthError,
      ].filter(Boolean);
      store.toast(failures.length ? `Refresh finished with ${failures.length} error(s)` : 'Refreshed', failures.length ? 'warn' : 'info');
    },
    newProject() { store.state.showNewProject = true; },
    toggleSidebar() { store.state.sidebarOpen = !store.state.sidebarOpen; },
    stopAllRunning() { store.stopAllRunning(); },
    restartPrevious() { store.restartPrevious(); },
    restartUi() { store.restartUi(); },
    logout() {
      if (canNavigate('#/logout')) store.logout();
    },
    toggleOverflow() {
      this.showOverflow = !this.showOverflow;
      if (this.showOverflow) {
        this.$nextTick(() => this.$refs.overflowPanel?.querySelector('button:not([disabled])')?.focus());
      }
    },
    closeOverflow({ restoreFocus = false } = {}) {
      if (!this.showOverflow) return;
      this.showOverflow = false;
      if (restoreFocus) this.$nextTick(() => this.$refs.overflowButton?.focus());
    },
    runOverflow(action) {
      this.closeOverflow();
      action();
    },
    onDocumentPointer(event) {
      if (this.showOverflow && !this.$refs.overflowWrap?.contains(event.target)) this.closeOverflow();
    },
    onDocumentKey(event) {
      if (event.key === 'Escape' && this.showOverflow) {
        event.preventDefault();
        event.stopPropagation();
        this.closeOverflow({ restoreFocus: true });
      }
    },
  },
  template: `
    <header class="app-header">
      <button class="btn btn-ghost only-mobile" @click="toggleSidebar" aria-label="Toggle project list"
              aria-controls="project-sidebar" :aria-expanded="sidebarOpen ? 'true' : 'false'">☰</button>
      <button class="app-logo" @click="goHome" aria-label="Dashboard">
        <span class="app-logo-mark">◆</span> Ashmero
      </button>

      <div class="row hide-mobile" style="gap: var(--sp-4); margin-left: var(--sp-4)" v-if="stats">
        <span class="hdr-stat"><b>{{ stats.projectCount }}</b> projects</span>
        <span class="hdr-stat" :style="runningCount ? 'color: var(--ok)' : ''">
          <span v-if="runningCount" class="dot dot-pulse" style="--dot-c: var(--ok)"></span>
          <b>{{ runningCount }}</b> running
        </span>
        <span class="hdr-stat" v-if="stats.pausedRuns" style="color: var(--warn)"><b>{{ stats.pausedRuns }}</b> paused</span>
        <span class="hdr-stat"><b>{{ fmtMoney(stats.total_cost) }}</b></span>
        <span class="hdr-stat" v-if="stats.bugCount" style="color: var(--err)"><b>{{ stats.bugCount }}</b> bugs</span>
        <span class="hdr-stat" v-if="stats.reqCount" style="color: var(--info)"><b>{{ stats.reqCount }}</b> reqs</span>
      </div>

      <div class="right row">

        <!-- Claude usage panel: 5h window + weekly Max plan info -->
        <div v-if="windowInfo" class="hdr-window hide-mobile" :title="windowTooltip" style="gap: 6px; cursor: default">
          <!-- 5h rolling window -->
          <span class="xs muted nowrap">5h:</span>
          <div class="progress" style="width: 48px">
            <div class="progress-fill" :style="{ width: windowPct + '%', '--fill-c': windowColor }"></div>
          </div>
          <span class="xs mono nowrap" :style="{ color: windowColor }">{{ windowInfo.callsInWindow }}/{{ windowInfo.pauseThreshold }}u · {{ windowInfo.rawCallsInWindow ?? windowInfo.callsInWindow }}a</span>
          <span v-if="reclaimLabel" class="xs muted nowrap" style="opacity:.7">↻ {{ reclaimLabel }}</span>

          <!-- Divider -->
          <span class="xs muted" style="opacity:.4; padding: 0 2px">|</span>

          <!-- Weekly Max plan usage -->
          <span class="xs muted nowrap">7d:</span>
          <span class="xs mono nowrap" v-if="weeklyCallCount !== null">{{ weeklyCallCount }}</span>
          <span class="xs muted nowrap" v-if="weeklyResetDay">
            ↻ {{ weeklyResetDay }}
            <span v-if="weeklyResetIn" style="opacity:.7"> {{ weeklyResetIn }}</span>
          </span>
        </div>

        <!-- Stop-all / Restart-previous -->
        <button
          v-if="previouslyRunning.length"
          class="btn btn-sm"
          style="color: var(--ok); border-color: var(--ok);"
          @click="restartPrevious"
          :disabled="restartBusy"
          :aria-label="'Restart previous projects: ' + previouslyRunning.join(', ')"
          :title="'Restart: ' + previouslyRunning.join(', ')">
          ▶ <span class="hide-mobile">Restart </span>{{ previouslyRunning.length }}
        </button>
        <button
          v-if="runningCount"
          class="btn btn-ghost btn-sm"
          @click="stopAllRunning"
          :disabled="stopAllBusy"
          aria-label="Stop all running projects"
          title="Stop all running projects (remembers them for restart)">
          ⏸ <span class="hide-mobile">Stop All</span>
        </button>

        <!-- SSE indicator -->
        <span class="chip header-status" :title="workerMeta.title" :aria-label="workerMeta.label + ': ' + workerMeta.title" aria-live="polite">
          <span class="dot" :class="{'dot-pulse': systemHealth?.worker?.alive}" :style="{'--dot-c': workerMeta.color}"></span>
          <span class="hide-mobile">{{ workerMeta.label }}</span>
        </span>
        <span class="chip header-status" :title="'Stream: ' + sseMeta.label">
          <span class="dot" :class="{'dot-pulse': sse !== 'live'}" :style="{'--dot-c': sseMeta.c}"></span>
          <span class="hide-mobile">{{ sseMeta.label }}</span>
        </span>

        <button class="btn btn-sm" :class="router.view === 'chat' ? 'btn-primary' : 'btn-ghost'" @click="openChat" title="Control chat (C)" aria-label="Chat">◆ <span class="hide-mobile">Chat</span></button>
        <button v-if="canUseTerminal" class="btn btn-ghost btn-sm header-secondary" @click="openTerminal" title="Terminal (T)" aria-label="Terminal">⬛ <span class="hide-mobile">Terminal</span></button>
        <button v-if="canUseNas" class="btn btn-ghost btn-sm hide-mobile header-secondary" @click="openNasSync" title="Sync Mac ⇄ NAS" aria-label="NAS sync">⇄ NAS</button>
        <button v-if="canRestartUi" class="btn btn-ghost btn-sm hide-mobile header-secondary" @click="restartUi" :disabled="restartUiBusy" title="Restart supervised UI server" aria-label="Restart UI">⟳ UI</button>
        <button class="btn btn-ghost btn-sm header-secondary" @click="refresh" title="Refresh all (R)" aria-label="Refresh">↻</button>
        <button class="btn btn-primary btn-sm" @click="newProject" title="New project" aria-label="New project">＋<span class="hide-mobile"> New</span></button>
        <button class="btn btn-ghost btn-sm header-secondary" @click="logout" title="Forget this browser session token" aria-label="Log out">⎋<span class="hide-mobile"> Log out</span></button>

        <div ref="overflowWrap" class="header-overflow">
          <button ref="overflowButton" type="button" class="btn btn-ghost btn-sm" @click="toggleOverflow"
                  aria-label="More controls" aria-controls="header-overflow-panel"
                  :aria-expanded="showOverflow ? 'true' : 'false'">⋯</button>
          <div v-if="showOverflow" ref="overflowPanel" id="header-overflow-panel" class="header-overflow-panel"
               aria-label="System status and controls">
            <div class="header-overflow-status small">
              <span><span class="dot" :style="{'--dot-c': workerMeta.color}"></span> {{ workerMeta.label }}</span>
              <span><span class="dot" :style="{'--dot-c': sseMeta.c}"></span> Stream {{ sseMeta.label }}</span>
              <span v-if="runningCount">{{ runningCount }} running</span>
            </div>
            <button v-if="canUseTerminal" type="button" class="btn btn-ghost" @click="runOverflow(openTerminal)">⬛ Terminal</button>
            <button v-if="canUseNas" type="button" class="btn btn-ghost" @click="runOverflow(openNasSync)">⇄ NAS sync</button>
            <button v-if="canRestartUi" type="button" class="btn btn-ghost" :disabled="restartUiBusy" @click="runOverflow(restartUi)">⟳ Restart UI</button>
            <button type="button" class="btn btn-ghost" @click="runOverflow(refresh)">↻ Refresh all</button>
            <button type="button" class="btn btn-ghost" @click="runOverflow(logout)">⎋ Log out</button>
          </div>
        </div>
      </div>
    </header>
  `,
};
