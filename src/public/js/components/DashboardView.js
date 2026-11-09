import { store } from '../lib/store.js';
import { navigate, projectHash } from '../lib/router.js';
import {
  fmtMoney, fmtTokens, pct, fmtAgo,
  runStateOf, runStateMeta, runIsStale, pauseKindMeta, pendingJobLabel, pendingJobWaitReason,
} from '../lib/format.js';

import WindowGauge from './widgets/WindowGauge.js';
import JobQueuePanel from './widgets/JobQueuePanel.js';
import ActivityFeed from './widgets/ActivityFeed.js';
import HealingFeed from './widgets/HealingFeed.js';
import SystemHealthPanel from './widgets/SystemHealthPanel.js';
import AttentionPanel from './widgets/AttentionPanel.js';
import SpendPanel from './widgets/SpendPanel.js';

export default {
  name: 'DashboardView',
  components: { WindowGauge, JobQueuePanel, ActivityFeed, HealingFeed, SystemHealthPanel, AttentionPanel, SpendPanel },
  computed: {
    stats() { return store.state.stats; },
    statsError() { return store.state.statsError; },
    projects() { return store.state.projects; },
    projectsLoaded() { return store.state.projectsLoaded; },
    projectsError() { return store.state.projectsError; },
    jobs() { return store.state.jobs; },
    busy() { return store.state.busy; },
    now() { return store.state.now; },
    kpis() {
      const s = this.stats;
      if (!s) return [];
      const runningNow = this.projects.filter((p) => p.processAlive).length;
      return [
        { label: 'Projects',     value: s.projectCount ?? 0,        color: null },
        { label: 'Running now',  value: runningNow,                 color: null },
        { label: 'Paused',       value: s.pausedRuns ?? 0,          color: s.pausedRuns > 0 ? 'var(--warn)' : null },
        { label: 'Total cost',   value: fmtMoney(s.total_cost),     color: null },
        { label: 'Total tokens', value: fmtTokens(s.total_tokens),  color: null },
        { label: 'Total calls',  value: s.total_calls ?? 0,         color: null },
        { label: 'Bugs inbox',   value: s.bugCount ?? 0,            color: s.bugCount > 0 ? 'var(--err)' : null },
        { label: 'Reqs inbox',   value: s.reqCount ?? 0,            color: s.reqCount > 0 ? 'var(--info)' : null },
      ];
    },
  },
  methods: {
    fmtMoney, pct, fmtAgo, runStateOf, runStateMeta, runIsStale, pauseKindMeta, pendingJobLabel, pendingJobWaitReason,
    trunc(s, n) {
      const t = String(s || '');
      return t.length > n ? t.slice(0, n) + '…' : t;
    },
    open(p) { navigate(projectHash(p.name)); },
    openOperations(p) { navigate(projectHash(p.name, 'operations')); },
    isBusy(verb, name) { return !!store.state.busy[verb + ':' + name]; },
    doAction(p, verb) { store.projectAction(p.name, verb); },
    async recoverStale(p) {
      const yes = await store.confirmAction({
        title: 'Fix stale run & resume?',
        body: `Repair the stale run record for “${p.name}” and atomically queue Resume?`,
        confirmLabel: 'Fix & Resume',
      });
      if (!yes) return;
      const r = await store.act('recover-stale:' + p.name, 'POST',
        '/projects/' + encodeURIComponent(p.name) + '/recover-stale', undefined,
        { okMsg: 'Stale run repaired and resume queued', errPrefix: 'Recover stale run' });
      if (r) { store.loadJobs(); store.loadProjects({ silent: true }); }
    },
    retryStats() { store.loadStats(); },
    retryProjects() { store.loadProjects(); },
    newProject() { store.state.showNewProject = true; },
  },
  template: `
    <div class="col" style="gap: var(--sp-4)">

      <SystemHealthPanel />
      <AttentionPanel />

      <div v-if="statsError" class="banner banner-err">
        <span class="grow">Could not refresh summary: {{ statsError }}</span>
        <button class="btn btn-sm" @click="retryStats">Retry</button>
      </div>

      <!-- KPI row -->
      <div class="grid-4">
        <template v-if="stats">
          <div v-for="k in kpis" :key="k.label" class="kpi">
            <span class="kpi-value" :style="k.color ? { color: k.color } : null">{{ k.value }}</span>
            <span class="kpi-label">{{ k.label }}</span>
          </div>
        </template>
        <template v-else>
          <div v-for="i in 8" :key="'sk' + i" class="kpi">
            <div class="skeleton" style="height: 24px; width: 60%"></div>
            <div class="skeleton" style="height: 10px; width: 80%"></div>
          </div>
        </template>
      </div>

      <!-- 5h window gauge -->
      <WindowGauge />

      <!-- Projects -->
      <div v-if="!projectsLoaded" class="grid-3">
        <div v-for="i in 3" :key="'psk' + i" class="card col">
          <div class="skeleton" style="height: 20px; width: 55%"></div>
          <div class="skeleton" style="height: 12px; width: 80%"></div>
          <div class="skeleton" style="height: 6px"></div>
          <div class="skeleton" style="height: 26px; width: 45%"></div>
        </div>
      </div>

      <div v-else-if="projectsError" class="banner banner-err">
        <span class="grow">{{ projectsError }}</span>
        <button class="btn btn-sm" @click="retryProjects">Retry</button>
      </div>

      <div v-else-if="!projects.length" class="card">
        <div class="empty">
          <span class="empty-icon">▢</span>
          <span>No projects yet</span>
          <span class="empty-hint">Create one and let the agents build it phase by phase</span>
          <button class="btn btn-primary" @click="newProject">＋ New project</button>
        </div>
      </div>

      <div v-else class="grid-3">
        <div v-for="p in projects" :key="p.name" class="card col" style="gap: var(--sp-2)">
          <div class="row">
            <span class="dot" :class="{'dot-pulse': runStateMeta(runStateOf(p)).pulse}"
                  :style="{'--dot-c': runStateMeta(runStateOf(p)).color}"></span>
            <button class="bold truncate grow" style="text-align: left; font-size: var(--fs-lg)"
                    @click="open(p)" :title="'Open ' + p.name">{{ p.name }}</button>
            <span v-if="p.hasNextBrief" class="dot" style="--dot-c: var(--orange)" title="Next brief queued"></span>
          </div>

          <div class="row">
            <span class="xs nowrap" :style="{ color: runStateMeta(runStateOf(p)).color }">
              {{ runStateMeta(runStateOf(p)).label }}<span v-if="runIsStale(p)" title="auto-run row says running but no live process"> ⚠</span>
            </span>
            <span v-if="p.bugInbox > 0" class="chip">🐞 {{ p.bugInbox }}</span>
            <span v-if="p.reqInbox > 0" class="chip">📋 {{ p.reqInbox }}</span>
            <span class="xs muted right nowrap">{{ fmtMoney(p.cost?.total_cost) }}</span>
          </div>

          <div v-if="p.total_phases" class="row">
            <div class="progress" role="progressbar" aria-label="Project phase progress" aria-valuemin="0"
                 :aria-valuemax="p.total_phases" :aria-valuenow="p.current_phase">
              <div class="progress-fill" :style="{
                width: pct(p.current_phase, p.total_phases) + '%',
                '--fill-c': runStateMeta(runStateOf(p)).color }"></div>
            </div>
            <span class="xs muted nowrap">{{ p.current_phase }}/{{ p.total_phases }}</span>
          </div>

          <div v-if="runStateOf(p) === 'paused'" class="xs muted truncate"
               :title="p.autoRun?.pause_reason || pauseKindMeta(p.autoRun?.pause_kind).label">
            {{ pauseKindMeta(p.autoRun?.pause_kind).icon }}
            {{ p.autoRun?.pause_reason ? trunc(p.autoRun.pause_reason, 90) : pauseKindMeta(p.autoRun?.pause_kind).label }}
          </div>

          <div v-if="p.pendingJob" class="xs truncate" style="color: var(--info)"
               :title="'Queued ' + fmtAgo(p.pendingJob.requested_at, now)">
            ⏳ {{ pendingJobLabel(p.pendingJob) }} queued — {{ pendingJobWaitReason(p.pendingJob, now) }}
          </div>

          <div class="row" style="margin-top: auto">
            <button v-if="runIsStale(p)" class="btn btn-primary btn-sm"
                    :disabled="isBusy('recover-stale', p.name) || !!p.pendingJob" @click="recoverStale(p)"
                    :title="p.pendingJob ? 'A recovery or project job is already queued' : 'Repair the stale run and queue Resume'">
              <span v-if="isBusy('recover-stale', p.name)" class="spinner"></span> Fix &amp; Resume
            </button>
            <button v-else-if="runStateOf(p) === 'running'" class="btn btn-danger btn-sm"
                    :disabled="isBusy('abort', p.name)" @click="doAction(p, 'abort')">
              <span v-if="isBusy('abort', p.name)" class="spinner"></span> Abort
            </button>
            <button v-else-if="runStateOf(p) === 'paused'" class="btn btn-sm"
                    :disabled="isBusy('resume', p.name) || !!p.pendingJob" @click="doAction(p, 'resume')">
              <span v-if="isBusy('resume', p.name)" class="spinner"></span> Resume
            </button>
            <button v-else-if="runStateOf(p) === 'plan-ready'" class="btn btn-sm"
                    :disabled="isBusy('resume', p.name) || !!p.pendingJob" @click="doAction(p, 'resume')">
              <span v-if="isBusy('resume', p.name)" class="spinner"></span> Start execution
            </button>
            <button v-else-if="runStateOf(p) === 'completed' || runStateOf(p) === 'ready-for-qa'" class="btn btn-sm"
                    @click="openOperations(p)">QA &amp; operations</button>
            <button v-else class="btn btn-sm"
                    :disabled="isBusy('go', p.name) || !!p.pendingJob" @click="doAction(p, 'go')">
              <span v-if="isBusy('go', p.name)" class="spinner"></span> Go
            </button>
            <button class="btn btn-ghost btn-sm right" @click="open(p)">Open</button>
          </div>
        </div>
      </div>

      <!-- Bot job queue (only when the endpoint answered) -->
      <JobQueuePanel />

      <SpendPanel compact />

      <!-- Feeds -->
      <div class="grid-2">
        <ActivityFeed />
        <HealingFeed />
      </div>

    </div>
  `,
};
