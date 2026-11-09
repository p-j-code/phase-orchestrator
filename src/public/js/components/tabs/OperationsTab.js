import { store } from '../../lib/store.js';
import { router } from '../../lib/router.js';
import { api, apiDownload } from '../../lib/api.js';
import { forecastSummary, fmtDate } from '../../lib/format.js';
import SpendPanel from '../widgets/SpendPanel.js';
import SystemHealthPanel from '../widgets/SystemHealthPanel.js';
import AttentionPanel from '../widgets/AttentionPanel.js';

const ACTION_GROUPS = [
  {
    label: 'Lifecycle',
    actions: [
      { id: 'pipeline', label: 'Full pipeline', icon: '🚀', heavy: true, description: 'Intake → brief → build → audit/fix → QA gate.' },
      { id: 'audit', label: 'Audit', icon: '🔎', heavy: true, description: 'Run the project audit workflow.' },
      { id: 'bugs', label: 'Fix bugs', icon: '🐞', heavy: true, description: 'Plan and execute the next bug-fix round.' },
      { id: 'review', label: 'Review', icon: '✓', heavy: true, description: 'Run an implementation review.' },
      { id: 'handoff', label: 'Handoff', icon: '⇢', heavy: true, description: 'Generate a development handoff.' },
      { id: 'qa-handoff', label: 'Generate QA handoff', icon: '📋', heavy: true, description: 'Generate the QA handoff artifact and optional journey steps.' },
      { id: 'qa', label: 'Mark ready for QA', icon: '🧪', description: 'Move the project to the ready-for-QA lifecycle state.' },
      { id: 'validate', label: 'Validate', icon: '🛡', description: 'Run deterministic project validators.' },
      { id: 'ship', label: 'Ship gate', icon: '📦', danger: true, description: 'Run the guarded ship workflow. Never bypasses its safety gate.' },
      { id: 'package', label: 'Create release ZIP', icon: '⬇', description: 'Create a guarded portable ZIP in outputs/ and record its exact path.' },
    ],
  },
  {
    label: 'Planning & improvement',
    actions: [
      { id: 'brief', label: 'Regenerate brief', icon: '📝', heavy: true, description: 'Run the brief agent from current raw thoughts.' },
      { id: 'guide', label: 'Plan & start', icon: '📐', heavy: true, description: 'Generate a fresh phase plan from the current brief, then auto-queue execution.' },
      { id: 'roadmap', label: 'Roadmap', icon: '🗺', heavy: true, description: 'Generate or refresh the project roadmap.' },
      { id: 'retro', label: 'Retrospective', icon: '↶', heavy: true, description: 'Analyze recent project execution.' },
      { id: 'discuss', label: 'Discuss', icon: '◆', heavy: true, needsInput: true, description: 'Run a scoped multi-agent discussion.' },
      { id: 'eval', label: 'Evaluate', icon: '◈', heavy: true, description: 'Run the evaluation workflow.' },
      { id: 'reset-brief', label: 'Reset brief state', icon: '↺', danger: true, description: 'Reset brief execution state through the guarded backend action.' },
    ],
  },
  {
    label: 'Recovery & source control',
    actions: [
      { id: 'retry-phase', label: 'Prepare phase retry', icon: '⟳', danger: true, needsPhase: true, description: 'Stash local edits, hard-reset the phase commit, and mark that phase pending for a later Resume.' },
      { id: 'sync', label: 'Git sync', icon: '⇅', danger: true, description: 'Fast-forward the configured workspace branch from its remote.' },
    ],
  },
];

export default {
  name: 'OperationsTab',
  components: { SpendPanel, SystemHealthPanel, AttentionPanel },
  data() {
    return {
      groups: ACTION_GROUPS,
      capabilities: null,
      capabilityError: '',
      git: null,
      gitLoading: true,
      gitError: '',
      releases: [],
      releasesLoading: true,
      releasesError: '',
      downloadingRelease: '',
      pipelineRounds: 3,
      pipelineStopAfter: 'qa',
      // Keep the review gate on by default. Enabling this explicitly allows a
      // freshly generated brief to flow straight into implementation.
      pipelineAutoBrief: false,
      qaWithSteps: true,
      discussionAutoStart: false,
      shipTarget: 'main',
      shipTag: '',
      packageIncludeGit: false,
      retryPhase: null,
      actionInput: '',
      capabilitySeq: 0,
      gitSeq: 0,
      releaseSeq: 0,
    };
  },
  computed: {
    name() { return router.project; },
    busy() { return store.state.busy; },
    detail() {
      const d = store.state.detail;
      return d?.name === this.name ? d : null;
    },
    mutationLockReason() { return store.projectMutationLockReason(this.name); },
  },
  watch: {
    name() {
      this.git = null;
      this.capabilities = null;
      this.releases = [];
      this.load();
    },
  },
  mounted() { this.load(); },
  methods: {
    fmtDate,
    async load() { await Promise.allSettled([this.loadCapabilities(), this.loadGit(), this.loadReleases()]); },
    async loadCapabilities() {
      const seq = ++this.capabilitySeq;
      const name = this.name;
      this.capabilityError = '';
      const health = await store.loadSystemHealth();
      if (seq !== this.capabilitySeq || this.name !== name) return;
      if (health?.capabilities) this.capabilities = health.capabilities;
      else { this.capabilities = null; this.capabilityError = store.state.systemHealthError || 'Capabilities unavailable'; }
    },
    async loadGit() {
      const seq = ++this.gitSeq;
      const name = this.name;
      this.gitLoading = true;
      this.gitError = '';
      try {
        const git = await api('GET', '/projects/' + encodeURIComponent(name) + '/git-status');
        if (seq === this.gitSeq && this.name === name) this.git = git;
      } catch (e) {
        if (seq === this.gitSeq && this.name === name) { this.git = null; this.gitError = e.message; }
      } finally {
        if (seq === this.gitSeq && this.name === name) this.gitLoading = false;
      }
    },
    async loadReleases() {
      const seq = ++this.releaseSeq;
      const name = this.name;
      this.releasesLoading = true;
      this.releasesError = '';
      try {
        const data = await api('GET', '/projects/' + encodeURIComponent(name) + '/releases');
        if (seq === this.releaseSeq && this.name === name) {
          this.releases = Array.isArray(data?.releases) ? data.releases : [];
        }
      } catch (e) {
        if (seq === this.releaseSeq && this.name === name) {
          this.releases = [];
          this.releasesError = e.message;
        }
      } finally {
        if (seq === this.releaseSeq && this.name === name) this.releasesLoading = false;
      }
    },
    formatBytes(value) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) return '–';
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
      return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
    },
    async downloadRelease(release) {
      if (!release?.filename || this.downloadingRelease) return;
      const name = this.name;
      this.downloadingRelease = release.filename;
      try {
        const result = await apiDownload(
          '/projects/' + encodeURIComponent(name) + '/releases/' + encodeURIComponent(release.filename),
        );
        if (this.name !== name) return;
        const url = URL.createObjectURL(result.blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = result.filename || release.filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1_000);
      } catch (e) {
        store.toast('Download release: ' + e.message, 'err');
      } finally {
        if (this.downloadingRelease === release.filename) this.downloadingRelease = '';
      }
    },
    supported(action) {
      const supported = this.capabilities?.actions;
      if (Array.isArray(supported)) return supported.includes(action.id);
      if (supported && typeof supported === 'object') return Object.prototype.hasOwnProperty.call(supported, action.id);
      return false;
    },
    disabledReason(action) {
      if (!this.supported(action)) return 'Not supported by this server version';
      if (this.mutationLockReason) return this.mutationLockReason;
      if (action.id === 'pipeline' || action.id === 'bugs') {
        const rounds = Number(this.pipelineRounds);
        if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) return 'Rounds must be a whole number from 1 to 10';
      }
      if (action.needsPhase && !(Number(this.retryPhase) >= 1)) return 'Choose a phase number (1 or greater)';
      if (action.needsPhase && !Number.isInteger(Number(this.retryPhase))) return 'Phase must be a whole number';
      if (action.needsInput && !this.actionInput.trim()) return 'Write the discussion goal';
      return '';
    },
    argsFor(action) {
      if (action.id === 'pipeline') return {
        rounds: Number(this.pipelineRounds) || 3,
        stopAfter: this.pipelineStopAfter,
        autoBrief: !!this.pipelineAutoBrief,
      };
      if (action.id === 'bugs') return { auto: true, rounds: Number(this.pipelineRounds) || 3 };
      if (action.id === 'retry-phase') return { phase: Number(this.retryPhase) };
      if (action.id === 'discuss') return {
        prompt: this.actionInput.trim(),
        autoStart: !!this.discussionAutoStart,
      };
      if (action.id === 'guide') return { task: 'plan' };
      if (action.id === 'qa-handoff') return { withSteps: !!this.qaWithSteps };
      if (action.id === 'ship') return { target: this.shipTarget.trim() || 'main', tag: this.shipTag.trim() || null };
      if (action.id === 'package') return { includeGit: !!this.packageIncludeGit };
      return {};
    },
    async run(action) {
      if (this.disabledReason(action)) return;
      const name = this.name;
      let body = action.description;
      if (action.heavy) {
        try { body = action.description + '\n\n' + forecastSummary(await api('GET', '/projects/' + encodeURIComponent(name) + '/forecast')); }
        catch { body += '\n\nThis action makes provider calls and consumes window budget.'; }
      }
      if (this.name !== name) return;
      const yes = await store.confirmAction({
        title: action.label + '?', body,
        danger: !!action.danger,
        confirmLabel: action.label,
      });
      if (!yes || this.name !== name) return;
      const lockReason = await store.revalidateProjectMutationLock(name);
      if (this.name !== name) return;
      if (lockReason) {
        store.toast(lockReason, 'warn', { project: name });
        return;
      }
      if (this.disabledReason(action)) return;
      const key = 'operation:' + name + ':' + action.id;
      const result = await store.act(key, 'POST',
        '/projects/' + encodeURIComponent(name) + '/actions/' + encodeURIComponent(action.id),
        { args: this.argsFor(action), confirmed: !!action.danger },
        { okMsg: action.label + ' queued', errPrefix: action.label });
      if (result) {
        store.loadJobs();
        store.loadProjects({ silent: true });
        if (this.name === name) store.loadDetail(name, { silent: true });
      }
    },
  },
  template: `
    <div class="col" style="gap:var(--sp-4)">
      <SystemHealthPanel />
      <AttentionPanel :project="name" />

      <section class="card" aria-label="Project operations">
        <div class="card-header">
          <span class="card-title">Operations</span>
          <span class="chip">All state-changing actions are confirmed and queued durably</span>
          <button class="btn btn-ghost btn-sm right" @click="loadCapabilities" aria-label="Refresh operation capabilities">↻</button>
        </div>
        <div v-if="capabilityError" class="banner banner-warn" style="margin-bottom:var(--sp-3)">
          Could not load server capabilities: {{ capabilityError }}. Controls remain visible and fail closed on the server.
        </div>

        <div class="grid-2">
          <div v-for="group in groups" :key="group.label" class="card-flat col">
            <span class="label">{{ group.label }}</span>
            <div v-for="action in group.actions" :key="action.id" class="row-wrap" style="padding:var(--sp-1) 0">
              <button class="btn" :class="action.danger ? 'btn-danger' : action.id === 'pipeline' ? 'btn-primary' : ''"
                      :disabled="!!disabledReason(action) || busy['operation:' + name + ':' + action.id]"
                      :title="disabledReason(action) || action.description" @click="run(action)">
                <span v-if="busy['operation:' + name + ':' + action.id]" class="spinner"></span>
                <span v-else>{{ action.icon }}</span> {{ action.label }}
              </button>
              <span class="grow small dim">{{ action.description }}</span>
            </div>
          </div>
        </div>

        <div class="grid-3" style="margin-top:var(--sp-3)">
          <label class="field"><span class="label">Pipeline audit/fix rounds</span><input v-model.number="pipelineRounds" type="number" min="1" max="10" class="input"></label>
          <label class="field"><span class="label">Pipeline stop gate</span><select v-model="pipelineStopAfter" class="select"><option value="build">Build</option><option value="fixes">Audit &amp; fixes</option><option value="qa">QA handoff</option></select></label>
          <label class="checkbox" style="align-self:end;min-height:34px"><input v-model="pipelineAutoBrief" type="checkbox"> Build immediately from a newly generated brief (skip review gate)</label>
          <label class="checkbox" style="align-self:end;min-height:34px"><input v-model="qaWithSteps" type="checkbox"> QA handoff: generate journey steps</label>
          <label class="field"><span class="label">Ship target branch</span><input v-model="shipTarget" class="input" placeholder="main"></label>
          <label class="field"><span class="label">Optional ship tag</span><input v-model="shipTag" class="input" placeholder="v1.0.0"></label>
          <label class="checkbox" style="align-self:end;min-height:34px"><input v-model="packageIncludeGit" type="checkbox"> Release ZIP: include Git metadata</label>
          <label class="field"><span class="label">Phase to retry</span><input v-model.number="retryPhase" type="number" min="1" class="input" placeholder="Phase number"></label>
          <label class="field" style="grid-column:span 2"><span class="label">Discussion goal</span><input v-model="actionInput" class="input" placeholder="What should the agents discuss?"></label>
          <label class="checkbox" style="align-self:end;min-height:34px"><input v-model="discussionAutoStart" type="checkbox"> Apply discussion conclusions and start execution</label>
        </div>
      </section>

      <section class="card" aria-label="Git status">
        <div class="card-header"><span class="card-title">Git &amp; release state</span><button class="btn btn-ghost btn-sm right" @click="loadGit" :disabled="gitLoading" aria-label="Refresh git status"><span v-if="gitLoading" class="spinner"></span><span v-else>↻</span></button></div>
        <div v-if="gitLoading && !git" class="skeleton" style="height:56px"></div>
        <div v-else-if="gitError" class="banner banner-err">{{ gitError }}</div>
        <div v-else-if="git" class="grid-4">
          <div class="kpi"><span class="kpi-value mono">{{ git.current_branch || git.configured_branch || detail?.git_branch || '–' }}</span><span class="kpi-label">Current branch</span></div>
          <div class="kpi"><span class="kpi-value" :style="!git.clean ? {color:'var(--warn)'} : {color:'var(--ok)'}">{{ git.clean ? 'Clean' : (git.dirty_count + ' dirty') }}</span><span class="kpi-label">Workspace</span></div>
          <div class="kpi"><span class="kpi-value">↑{{ git.ahead_behind?.ahead || 0 }} / ↓{{ git.ahead_behind?.behind || 0 }}</span><span class="kpi-label">Ahead / behind</span></div>
          <div class="kpi"><span class="kpi-value">{{ git.ship_lag == null ? '–' : git.ship_lag }}</span><span class="kpi-label">Commits not on main</span></div>
        </div>
        <div v-if="git?.last_commit" class="xs mono muted" style="margin-top:var(--sp-2)">{{ git.last_commit }}</div>
      </section>

      <section class="card" aria-label="Release archives">
        <div class="card-header">
          <span class="card-title">Release archives</span>
          <button class="btn btn-ghost btn-sm right" @click="loadReleases" :disabled="releasesLoading" aria-label="Refresh release archives">
            <span v-if="releasesLoading" class="spinner"></span><span v-else>↻</span>
          </button>
        </div>
        <div v-if="releasesLoading && !releases.length" class="skeleton" style="height:48px"></div>
        <div v-else-if="releasesError" class="banner banner-err"><span class="grow">{{ releasesError }}</span><button class="btn btn-sm" @click="loadReleases">Retry</button></div>
        <div v-else-if="!releases.length" class="empty small">No release ZIPs yet. Create one above, then refresh after the queued job completes.</div>
        <div v-else class="col" style="gap:var(--sp-2)">
          <div v-for="release in releases" :key="release.filename" class="row card-flat">
            <div class="grow" style="min-width:0">
              <div class="mono small truncate">{{ release.filename }}</div>
              <div class="xs muted">{{ formatBytes(release.size) }} · {{ fmtDate(release.mtime) }}</div>
            </div>
            <button class="btn btn-sm" :disabled="!!downloadingRelease" @click="downloadRelease(release)" :aria-label="'Download ' + release.filename">
              <span v-if="downloadingRelease === release.filename" class="spinner"></span><span v-else aria-hidden="true">↓</span> Download
            </button>
          </div>
        </div>
      </section>

      <SpendPanel :project="name" />
    </div>
  `,
};
