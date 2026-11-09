import { store } from '../../lib/store.js';
import { api, apiErrorLines } from '../../lib/api.js';
import { closeModal, handleModalKey, openModal } from '../../lib/modal-a11y.js';

// NAS ⇄ Mac sync modal. Loads /api/nas/status on open, offers the two
// directional actions, and streams the collected log into the panel.
// On the NAS install itself /api/nas/status returns { role: 'nas' } and the
// actions are replaced by an explanation (the NAS can't ssh to a sleeping Mac).
export default {
  name: 'NasSyncModal',
  data() {
    return {
      status: null,
      loading: true,
      running: null,
      log: [],
      error: null,
      errorDetails: [],
      lastFailedOp: null,
      statusRequestId: 0,
    };
  },
  async mounted() {
    document.addEventListener('keydown', this.onKey);
    this.$nextTick(() => openModal(this.$refs.backdrop, this.$refs.closeBtn));
    await this.refresh();
  },
  beforeUnmount() {
    this.statusRequestId++;
    document.removeEventListener('keydown', this.onKey);
    closeModal(this.$refs.backdrop);
  },
  methods: {
    onKey(e) {
      handleModalKey(this.$refs.backdrop, e, {
        onEscape: this.close,
        escapeDisabled: !!this.running,
      });
    },
    close() { store.state.showNasSync = false; },
    async refresh() {
      const requestId = ++this.statusRequestId;
      this.loading = true;
      this.error = null;
      this.errorDetails = [];
      try {
        const status = await api('GET', '/nas/status');
        if (requestId !== this.statusRequestId) return;
        this.status = status;
      }
      catch (e) {
        if (requestId !== this.statusRequestId) return;
        this.error = e.message;
        this.errorDetails = apiErrorLines(e);
      }
      if (requestId === this.statusRequestId) this.loading = false;
    },
    fmtSide(side) {
      if (!side) return '—';
      if (side.error) return side.error;
      return `${side.projects} projects · ${side.phases_done}/${side.phases_total} phases done · ${side.calls} calls`;
    },
    async run(op) {
      const danger = op === 'pull-state'
        ? 'Pull state? This REPLACES this observer machine\'s DB with the validated NAS copy (a timestamped backup is kept). Active local work or another orchestrator process will make the pull refuse safely.'
        : op === 'push-state'
        ? 'Push EVERYTHING to the NAS? This replaces the NAS\'s DB, .guide, inputs, project.json, and workspace state with this machine\'s copy (a timestamped NAS backup is kept). Use only when this machine has run ahead of the NAS. Refuses if the NAS has live/queued work. Does not push workspace git commits to origin for you.'
        : 'Push code? This deploys this repo to the NAS and restarts its web UI and durable worker.';
      const ok = await store.confirmAction({
        title: op === 'pull-state' ? 'Pull state from NAS' : op === 'push-state' ? 'Push everything to NAS' : 'Push code to NAS',
        body: danger,
        confirmLabel: op === 'pull-state' ? 'Pull state' : op === 'push-state' ? 'Push everything' : 'Push code',
        danger: op === 'pull-state' || op === 'push-state',
      });
      if (!ok) return;
      this.running = op;
      this.log = [`▸ ${op} started…`];
      this.error = null;
      this.errorDetails = [];
      this.lastFailedOp = null;
      try {
        const res = await api('POST', '/nas/sync', { op });
        this.log = res.log || [];
        store.toast(`${op} complete`, 'ok');
        await this.refresh();
      } catch (e) {
        this.error = e.message;
        this.errorDetails = apiErrorLines(e);
        if (this.errorDetails.length) this.log = [...this.log, ...this.errorDetails];
        this.lastFailedOp = op;
        store.toast(`${op} failed`, 'err');
      }
      this.running = null;
    },
  },
  template: `
    <div ref="backdrop" class="modal-backdrop" @click.self="!running && close()" role="dialog" aria-modal="true" aria-labelledby="nas-sync-title">
      <div class="modal" style="max-width: 640px" tabindex="-1">
        <div id="nas-sync-title" class="modal-header">⇄ NAS Sync</div>
        <div class="modal-body col" style="gap: var(--sp-3)">
          <div v-if="loading" class="dim">Checking both sides…</div>

          <template v-else-if="status && status.role === 'nas'">
            <div class="dim">This install <b>is</b> the NAS. Sync runs from the Mac — it holds the SSH key
            (the NAS can't reach a sleeping Mac). Open the Mac's dashboard to sync, or run
            <span class="mono">node src/orchestrator.js nas-sync</span> there.</div>
          </template>

          <template v-else-if="status">
            <div class="small mono dim">{{ status.target }}</div>
            <div class="col" style="gap: 6px">
              <div class="row" style="gap: 8px">
                <span class="chip">This machine</span>
                <span class="small">{{ fmtSide(status.local) }}</span>
              </div>
              <div class="row" style="gap: 8px">
                <span class="chip" :style="status.reachable ? '' : 'color: var(--err)'">NAS {{ status.reachable ? '' : '(unreachable)' }}</span>
                <span class="small">{{ fmtSide(status.remote) }}</span>
              </div>
            </div>
            <div class="row" style="gap: var(--sp-2); flex-wrap: wrap">
              <button class="btn btn-primary btn-sm" :disabled="!!running || !status.reachable" @click="run('push-code')">
                {{ running === 'push-code' ? 'Pushing…' : '⬆ Push code → NAS' }}
              </button>
              <button class="btn btn-sm" :disabled="!!running || !status.reachable" @click="run('pull-state')">
                {{ running === 'pull-state' ? 'Pulling…' : '⬇ Pull state ← NAS' }}
              </button>
              <button class="btn btn-sm" style="border-color: var(--err)" :disabled="!!running || !status.reachable" @click="run('push-state')">
                {{ running === 'push-state' ? 'Pushing everything…' : '⬆⬆ Push everything → NAS' }}
              </button>
              <button class="btn btn-ghost btn-sm" :disabled="!!running || loading" @click="refresh" title="Re-check both sides">↻</button>
            </div>
            <div class="small dim">Push code = deploy code + project configs, restart and health-check NAS web + worker.
            Pull state = validated NAS DB + .guide files → this observer, with active-work refusal and an online local backup.
            Push everything = the reverse of pull state — this machine's full DB, .guide, inputs, and workspace state → the NAS
            (git + deps per workspace, node_modules excluded). For when this machine ran ahead of the NAS and needs to become
            the source of truth again; refuses if the NAS has live work.</div>
          </template>

          <div v-if="status && status.role !== 'nas'" class="banner banner-info small">
            <span v-if="running" class="spinner"></span>
            NAS sync is buffered and cannot be cancelled. Keep this dialog open; the operation log appears after the server finishes.
          </div>

          <div v-if="log.length" class="mono small scroll-y" role="log" aria-live="polite"
               style="max-height: 200px; background: var(--surface-2); border-radius: var(--r-sm); padding: var(--sp-2); white-space: pre-wrap">{{ log.join('\\n') }}</div>
          <div v-if="error" class="banner banner-err" role="alert">
            <span class="grow">{{ error }}</span>
            <button v-if="lastFailedOp" class="btn btn-sm" :disabled="!!running" @click="run(lastFailedOp)">Retry {{ lastFailedOp }}</button>
            <button v-else class="btn btn-sm" :disabled="loading" @click="refresh">Retry status</button>
          </div>
        </div>
        <div class="modal-footer">
          <button ref="closeBtn" data-modal-initial class="btn btn-ghost" :disabled="!!running" @click="close">Close</button>
        </div>
      </div>
    </div>
  `,
};
