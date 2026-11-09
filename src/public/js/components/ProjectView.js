import { store } from '../lib/store.js';
import { router, navigate, projectHash } from '../lib/router.js';
import { fmtAgo, runStateOf, runStateMeta, runIsStale, pauseKindMeta, pendingJobLabel, pendingJobWaitReason } from '../lib/format.js';

import ErrorBoundary from './ErrorBoundary.js';
import OverviewTab from './tabs/OverviewTab.js';
import PhasesTab from './tabs/PhasesTab.js';
import RunsTab from './tabs/RunsTab.js';
import InboxTab from './tabs/InboxTab.js';
import BriefTab from './tabs/BriefTab.js';
import ArtifactsTab from './tabs/ArtifactsTab.js';
import SuggestionsTab from './tabs/SuggestionsTab.js';
import OperationsTab from './tabs/OperationsTab.js';
import ConfigTab from './tabs/ConfigTab.js';

const TAB_COMPONENTS = {
  overview: OverviewTab,
  phases: PhasesTab,
  runs: RunsTab,
  inbox: InboxTab,
  brief: BriefTab,
  artifacts: ArtifactsTab,
  suggestions: SuggestionsTab,
  operations: OperationsTab,
  config: ConfigTab,
};

const TAB_DEFS = [
  { id: 'overview',    label: 'Overview' },
  { id: 'phases',      label: 'Phases' },
  { id: 'runs',        label: 'Runs' },
  { id: 'inbox',       label: 'Inbox' },
  { id: 'brief',       label: 'Brief' },
  { id: 'artifacts',   label: 'Artifacts' },
  { id: 'suggestions', label: 'Suggestions' },
  { id: 'operations',  label: 'Operations' },
  { id: 'config',      label: 'Config' },
];

export default {
  name: 'ProjectView',
  components: { ErrorBoundary },
  data() {
    // On mobile the header (title + chips + action bar) is tall; start it
    // collapsed so the tabs + table are reachable with little scrolling.
    return { headerCollapsed: true };
  },
  computed: {
    name() { return router.project; },
    tab() { return router.tab; },
    now() { return store.state.now; },
    error() { return store.state.detailError; },
    // detail may lag router.project while loading — only render when it matches
    d() {
      const d = store.state.detail;
      return d && d.name === router.project ? d : null;
    },
    runState() { return runStateOf(this.d); },
    meta() { return runStateMeta(this.runState); },
    stale() { return runIsStale(this.d); },
    pk() { return pauseKindMeta(this.d && this.d.autoRun ? this.d.autoRun.pause_kind : null); },
    pendingJob() { return this.d && this.d.pendingJob; },
    hasActiveWork() {
      return this.runState === 'running' || this.runState === 'paused' || !!this.pendingJob;
    },
    pendingLabel() { return pendingJobLabel(this.pendingJob); },
    pendingReason() { return pendingJobWaitReason(this.pendingJob, this.now); },
    techChips() {
      return String((this.d && this.d.tech_stack) || '')
        .split(',').map((s) => s.trim()).filter(Boolean);
    },
    inboxCount() {
      return ((this.d && this.d.bugInbox) || 0) + ((this.d && this.d.reqInbox) || 0);
    },
    tabDefs() { return TAB_DEFS; },
    activeTabComponent() { return TAB_COMPONENTS[router.tab] || OverviewTab; },
  },
  watch: {
    tab(v) {
      try { localStorage.setItem('ashmero_tab_' + this.name, v); } catch { /* private mode */ }
    },
  },
  methods: {
    fmtAgo,
    retry() { store.loadDetail(router.project); },
    isBusy(verb) { return !!store.state.busy[verb + ':' + this.name]; },
    isSpawnDisabled(verb) { return this.isBusy(verb) || !!this.pendingJob; },
    act(verb) { store.projectAction(this.name, verb); },
    selectTab(id) {
      return navigate(projectHash(this.name, id));
    },
    onTabKey(e, id) {
      const tabs = this.tabDefs.map((t) => t.id);
      const at = tabs.indexOf(id);
      let next = null;
      if (e.key === 'ArrowRight') next = tabs[(at + 1) % tabs.length];
      else if (e.key === 'ArrowLeft') next = tabs[(at - 1 + tabs.length) % tabs.length];
      else if (e.key === 'Home') next = tabs[0];
      else if (e.key === 'End') next = tabs[tabs.length - 1];
      if (!next) return;
      e.preventDefault();
      if (this.selectTab(next) === false) return;
      this.$nextTick(() => document.getElementById('project-tab-' + next)?.focus());
    },
    async relaunch() {
      const yes = await store.confirmAction({
        title: 'Relaunch pipeline?',
        body: `”${this.name}” is ${this.runState}. This starts a new unattended pipeline run on top of the current state.`,
        confirmLabel: 'Relaunch',
      });
      if (yes) store.projectAction(this.name, 'launch', { confirmed: true });
    },
    async fixAndResume() {
      const yes = await store.confirmAction({
        title: 'Fix stale run & resume?',
        body: 'The auto-run row is stale (process died). This will abort the stale run and queue a fresh resume.',
        confirmLabel: 'Fix & Resume',
      });
      if (!yes) return;
      const r = await store.act('recover-stale:' + this.name, 'POST',
        '/projects/' + encodeURIComponent(this.name) + '/recover-stale', undefined,
        { okMsg: 'Stale run repaired and resume queued', errPrefix: 'Recover stale run' });
      if (r) {
        store.loadJobs();
        store.loadProjects({ silent: true });
        store.loadDetail(this.name, { silent: true });
      }
    },
    async remove(keepFiles) {
      const name = this.name;
      const yes = await store.confirmAction({
        title: keepFiles ? 'Detach project?' : 'Delete project and files?',
        body: keepFiles
          ? `Remove “${name}” from Ashmero while leaving its workspace and guide files on disk.`
          : `Permanently delete “${name}” from Ashmero and remove its workspace and guide files from disk. This cannot be undone.`,
        danger: true,
        confirmLabel: keepFiles ? 'Detach project' : 'Delete project',
      });
      if (!yes) return;
      await store.removeProject(name, keepFiles);
    },
  },
  template: `
    <div class="col" style="gap: var(--sp-4)">
      <div v-if="error" class="banner banner-err">
        {{ error }}
        <button class="btn btn-sm right" @click="retry">Retry</button>
      </div>

      <div v-if="!d && !error" class="col" style="gap: var(--sp-3)">
        <div class="skeleton" style="height: 34px; width: 40%"></div>
        <div class="skeleton" style="height: 20px; width: 65%"></div>
        <div class="skeleton" style="height: 36px"></div>
        <div class="skeleton" style="height: 220px"></div>
      </div>

      <template v-if="d">
        <div class="proj-header" :class="{'proj-header-collapsed': headerCollapsed}">
          <div class="row-wrap">
            <span class="proj-title">{{ d.name }}</span>
            <span class="badge" :style="{'--badge-c': meta.color}">
              <span class="dot" :class="{'dot-pulse': meta.pulse}" :style="{'--dot-c': meta.color}"></span>
              {{ meta.label }}
            </span>
            <span v-if="stale" class="chip" style="color: var(--warn)"
                  title="auto-run row says running but no live process — the run likely died hard; abort or resume to recover">⚠ stale</span>
            <button class="btn btn-ghost btn-sm only-mobile proj-header-toggle"
                    @click="headerCollapsed = !headerCollapsed"
                    :aria-expanded="headerCollapsed ? 'false' : 'true'"
                    :title="headerCollapsed ? 'Show details & actions' : 'Hide details & actions'">
              {{ headerCollapsed ? '⋯ Actions' : '▲ Hide' }}
            </button>
          </div>
          <div class="row-wrap small dim proj-tech">
            <span v-for="t in techChips" :key="t" class="chip">{{ t }}</span>
            <span v-if="d.profile" class="chip">{{ d.profile }}</span>
            <span v-if="d.git_branch" class="chip mono">{{ d.git_branch }}</span>
            <span class="chip" :title="d.created_at">created {{ fmtAgo(d.created_at, now) }}</span>
          </div>

          <div v-if="runState === 'paused'" class="banner banner-warn">
            <span>{{ pk.icon }}</span>
            <span class="grow"><b>{{ pk.label }}</b><template v-if="d.autoRun && d.autoRun.pause_reason"> — {{ d.autoRun.pause_reason }}</template></span>
          </div>

          <div v-if="runState === 'plan-ready'" class="banner banner-info">
            <span>📋</span>
            <span class="grow"><b>Plan ready</b> — {{ d.total_phases }} phases defined. Click <b>Start Execution</b> to begin.</span>
          </div>

          <div v-if="pendingJob" class="banner banner-info">
            <span>⏳</span>
            <span class="grow"><b>{{ pendingLabel }} queued</b> — {{ pendingReason }} (queued {{ fmtAgo(pendingJob.requested_at, now) }})</span>
          </div>

          <div class="action-bar">
            <template v-if="stale">
              <button class="btn btn-primary" :disabled="isBusy('recover-stale')" @click="fixAndResume" title="Repair stale run atomically and queue a fresh resume">
                <span v-if="isBusy('recover-stale')" class="spinner"></span> ⚡ Fix &amp; Resume
              </button>
              <button class="btn btn-danger" :disabled="isBusy('abort')" @click="act('abort')">
                <span v-if="isBusy('abort')" class="spinner"></span> ■ Abort
              </button>
            </template>

            <template v-else-if="runState === 'running'">
              <button class="btn btn-danger" :disabled="isBusy('abort')" @click="act('abort')">
                <span v-if="isBusy('abort')" class="spinner"></span> ■ Abort
              </button>
            </template>

            <template v-else-if="runState === 'paused'">
              <button class="btn btn-primary" :disabled="isSpawnDisabled('resume')" @click="act('resume')">
                <span v-if="isBusy('resume')" class="spinner"></span> ▶ Resume
              </button>
              <button class="btn btn-danger" :disabled="isBusy('abort')" @click="act('abort')">
                <span v-if="isBusy('abort')" class="spinner"></span> ■ Abort
              </button>
              <button v-if="d.hasNextBrief" class="btn" :disabled="isSpawnDisabled('next-brief')" @click="act('next-brief')"
                      title="Run the brief agent on the queued next brief, then auto-run">
                <span v-if="isBusy('next-brief')" class="spinner"></span> ⏭ Run Next Brief
              </button>
            </template>

            <template v-else-if="runState === 'plan-ready'">
              <button class="btn btn-primary" :disabled="isSpawnDisabled('resume')" @click="act('resume')"
                      title="Plan is ready — start executing dev phases">
                <span v-if="isBusy('resume')" class="spinner"></span> ▶ Start Execution
              </button>
              <button class="btn" :disabled="isSpawnDisabled('next')" @click="act('next')" title="Run just the first phase">
                <span v-if="isBusy('next')" class="spinner"></span> ⏵ Next Phase
              </button>
              <button v-if="d.hasNextBrief" class="btn" :disabled="isSpawnDisabled('next-brief')" @click="act('next-brief')"
                      title="Run the brief agent on the queued next brief, then auto-run">
                <span v-if="isBusy('next-brief')" class="spinner"></span> ⏭ Run Next Brief
              </button>
            </template>

            <template v-else-if="runState === 'completed' || runState === 'ready-for-qa'">
              <button class="btn" @click="selectTab('operations')">
                {{ runState === 'ready-for-qa' ? '🧪 QA & Ship controls' : '⚙ Operations' }}
              </button>
              <button class="btn btn-primary" :disabled="isSpawnDisabled('launch')" @click="relaunch">
                <span v-if="isBusy('launch')" class="spinner"></span> ↻ Relaunch
              </button>
            </template>

            <template v-else>
              <button class="btn btn-primary" :disabled="isSpawnDisabled('go')" @click="act('go')">
                <span v-if="isBusy('go')" class="spinner"></span> ▶ Start Auto-Run
              </button>
              <button class="btn" :disabled="isSpawnDisabled('next')" @click="act('next')">
                <span v-if="isBusy('next')" class="spinner"></span> ⏵ Next Phase
              </button>
              <button class="btn" :disabled="isSpawnDisabled('launch')" @click="act('launch')" title="Unattended pipeline: intake → brief → build → audit/fix → QA gate">
                <span v-if="isBusy('launch')" class="spinner"></span> 🚀 Launch Pipeline
              </button>
              <button v-if="d.hasNextBrief" class="btn" :disabled="isSpawnDisabled('next-brief')" @click="act('next-brief')"
                      title="Run the brief agent on the queued next brief, then auto-run">
                <span v-if="isBusy('next-brief')" class="spinner"></span> ⏭ Run Next Brief
              </button>
            </template>

            <span class="grow"></span>

            <button v-if="d.git_branch" class="btn" :disabled="hasActiveWork || isBusy('sync')" @click="act('sync')"
                    :title="hasActiveWork ? 'Stop/cancel active or queued project work before syncing' : 'Fast-forward the configured project branch'">
              <span v-if="isBusy('sync')" class="spinner"></span> ⇅ Git Sync
            </button>
            <button class="btn btn-ghost" :disabled="hasActiveWork || isBusy('remove')" @click="remove(true)"
                    :title="hasActiveWork ? 'Stop/cancel all project work before detaching' : 'Remove from Ashmero but keep files'">
              <span v-if="isBusy('remove')" class="spinner"></span> Detach
            </button>
            <button class="btn btn-danger" :disabled="hasActiveWork || isBusy('remove')" @click="remove(false)"
                    :title="hasActiveWork ? 'Stop/cancel all project work before deletion' : 'Delete project and all files'">
              <span v-if="isBusy('remove')" class="spinner"></span> ✕ Delete
            </button>
          </div>
        </div>

        <div class="tabs" role="tablist" aria-label="Project sections">
          <button v-for="t in tabDefs" :key="t.id" class="tab" :class="{'tab-active': tab === t.id}"
                  :id="'project-tab-' + t.id" role="tab" :aria-selected="tab === t.id"
                  :aria-controls="'project-panel-' + t.id" :tabindex="tab === t.id ? 0 : -1"
                  @keydown="onTabKey($event, t.id)" @click="selectTab(t.id)">
            {{ t.label }}
            <span v-if="t.id === 'inbox' && inboxCount" class="chip">{{ inboxCount }}</span>
          </button>
        </div>

        <div :id="'project-panel-' + tab" role="tabpanel" :aria-labelledby="'project-tab-' + tab">
          <ErrorBoundary :label="tab + ' tab'" :key="'eb-' + tab">
            <component :is="activeTabComponent" :key="tab" />
          </ErrorBoundary>
        </div>
      </template>
    </div>
  `,
};
