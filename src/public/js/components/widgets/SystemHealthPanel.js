import { fmtAgo } from '../../lib/format.js';
import { store } from '../../lib/store.js';

export default {
  name: 'SystemHealthPanel',
  data() {
    return { loading: !store.state.systemHealth, requestSeq: 0 };
  },
  computed: {
    now() { return store.state.now; },
    health() { return store.state.systemHealth; },
    error() { return store.state.systemHealthError; },
    worker() { return this.health?.worker || null; },
    hostLabel() {
      const host = this.health?.executionHost;
      if (!host) return '–';
      if (typeof host === 'string') return host;
      if (host.currentRole || host.activeRole) {
        const current = [host.currentRole, host.currentHostId].filter(Boolean).join('/');
        const active = [host.activeRole, host.activeHostId].filter(Boolean).join('/');
        return current === active ? (current || 'Configured') : `${current || 'unknown'} → ${active || 'unconfigured'}`;
      }
      return host.label || host.role || host.hostname || 'Configured';
    },
    hostColor() { return this.health?.executionHost?.allowed === false ? 'var(--err)' : 'var(--ok)'; },
    workerColor() {
      if (!this.worker) return 'var(--muted)';
      if (this.worker.alive && this.worker.leaseHealthy !== false) return 'var(--ok)';
      if (this.worker.alive) return 'var(--warn)';
      return 'var(--err)';
    },
  },
  mounted() { this.load(); this.timer = setInterval(() => this.load(true), 15000); },
  beforeUnmount() { if (this.timer) clearInterval(this.timer); },
  methods: {
    fmtAgo,
    async load(silent = false) {
      const seq = ++this.requestSeq;
      if (!silent) this.loading = true;
      await store.loadSystemHealth();
      if (seq === this.requestSeq) this.loading = false;
    },
  },
  template: `
    <section class="card" aria-label="Orchestrator system health">
      <div class="card-header">
        <span class="card-title">System health</span>
        <button class="btn btn-ghost btn-sm right" @click="load()" :disabled="loading" aria-label="Refresh system health">
          <span v-if="loading" class="spinner"></span><span v-else>↻</span>
        </button>
      </div>
      <div v-if="loading && !health" class="skeleton" style="height:64px"></div>
      <div v-else-if="error" class="banner banner-err">
        <span class="grow">{{ error }}</span><button class="btn btn-sm" @click="load()">Retry</button>
      </div>
      <template v-else-if="health">
        <div class="grid-3">
          <div class="kpi">
            <span class="kpi-value"><span class="dot" style="--dot-c:var(--ok)"></span> Web</span>
            <span class="kpi-label">PID {{ health.web?.pid || '–' }}<template v-if="health.web?.pm2Managed"> · supervised</template></span>
          </div>
          <div class="kpi">
            <span class="kpi-value" :style="{color:workerColor}"><span class="dot" :class="{'dot-pulse':worker?.alive}" :style="{'--dot-c':workerColor}"></span> {{ worker?.alive ? 'Worker live' : 'Worker down' }}</span>
            <span class="kpi-label">
              <template v-if="worker?.pid">PID {{ worker.pid }}</template>
              <template v-if="worker?.lastSeenAt"> · {{ fmtAgo(worker.lastSeenAt, now) }}</template>
              <template v-if="worker?.staleReason"> · {{ worker.staleReason }}</template>
            </span>
          </div>
          <div class="kpi">
            <span class="kpi-value" :style="{color:hostColor}">{{ hostLabel }}</span>
            <span class="kpi-label">Execution host<template v-if="health.executionHost?.override"> · multi-host override</template></span>
          </div>
        </div>
        <div v-if="!worker?.alive" class="banner banner-err" style="margin-top:var(--sp-3)">
          Jobs can be queued but will not run until the headless worker is started.
        </div>
        <div v-if="health.executionHost?.allowed === false" class="banner banner-err" style="margin-top:var(--sp-3)">
          <span class="grow"><b>This installation cannot execute work.</b> {{ health.executionHost.reason }}</span>
        </div>
      </template>
    </section>
  `,
};
