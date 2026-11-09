import { store } from '../../lib/store.js';
import { fmtDur, fmtAgo, statusMeta } from '../../lib/format.js';

// SQLite writes not_before as "YYYY-MM-DD HH:MM:SS" (UTC, no zone marker);
// started_at/ended_at are ISO strings. Normalize both defensively.
function toUtcMs(value) {
  if (!value) return NaN;
  const s = String(value);
  const t = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(' ', 'T') + 'Z' : s).getTime();
  return t;
}

export default {
  name: 'JobQueuePanel',
  computed: {
    now() { return store.state.now; },
    busy() { return store.state.busy; },
    error() { return store.state.jobsError; },
    jobs() { return store.state.jobs || { pending: [], running: [], recent: [] }; },
    running() { return this.jobs.running || []; },
    pending() { return this.jobs.pending || []; },
    recent() {
      // recent from the server is "last N jobs by id" — hide still-active rows
      // (they render in the sections above) and show the last 8 finished ones.
      return (this.jobs.recent || [])
        .filter((j) => j.status !== 'pending' && j.status !== 'running')
        .slice(0, 8);
    },
    allEmpty() {
      return !this.running.length && !this.pending.length && !this.recent.length;
    },
  },
  methods: {
    fmtDur, fmtAgo, statusMeta,
    trunc(s, n) {
      const t = String(s || '');
      return t.length > n ? t.slice(0, n) + '…' : t;
    },
    refresh() { store.loadJobs(); },
    elapsed(j) { return fmtDur(this.now - toUtcMs(j.started_at)); },
    retryIn(j) {
      if (!j.not_before) return '';
      const t = toUtcMs(j.not_before);
      if (isNaN(t) || t <= this.now) return '';
      return fmtDur(t - this.now);
    },
    canRetry(j) { return j.retryable === true; },
    canCancel(j) { return j.cancellable !== false; },
    cancelReason(j) { return j.cancel_block_reason || 'This action cannot be stopped safely after dispatch'; },
    retryReason(j) { return j.retry_block_reason || 'The server did not mark this job as replay-safe'; },
    async removeJob(j) {
      const yes = await store.confirmAction({
        title: 'Remove queued job?',
        body: `“${j.action}” on ${j.project} will be dropped from the bot queue.`,
        danger: true,
        confirmLabel: 'Remove',
      });
      if (!yes) return;
      await store.act('dq:' + j.id, 'DELETE', '/jobs/' + j.id, undefined, { okMsg: 'Job removed' });
      store.loadJobs();
    },
    async cancelRunning(j) {
      if (!this.canCancel(j)) return;
      const yes = await store.confirmAction({
        title: 'Cancel running job?',
        body: `“${j.action}” on ${j.project} will receive a cancellation request. The worker may take a moment to stop safely.`,
        danger: true,
        confirmLabel: 'Request cancellation',
      });
      if (!yes) return;
      const r = await store.act('cancel-job:' + j.id, 'POST', '/jobs/' + j.id + '/cancel', undefined, {
        okMsg: 'Cancellation requested', errPrefix: 'Cancel job',
      });
      if (r) setTimeout(() => store.loadJobs(), 500);
    },
    async retryJob(j) {
      if (!this.canRetry(j)) return;
      const yes = await store.confirmAction({
        title: 'Retry completed job?',
        body: `Queue a new replay of “${j.action}” on ${j.project}? The original job #${j.id} remains in history.`,
        confirmLabel: 'Queue retry',
      });
      if (!yes) return;
      const r = await store.act('retry-job:' + j.id, 'POST', '/jobs/' + j.id + '/retry', undefined, {
        okMsg: `Retry queued for ${j.action}`, errPrefix: 'Retry job',
      });
      if (r) store.loadJobs();
    },
    async moveJob(j, direction) {
      const r = await store.act('move-job:' + j.id, 'PATCH', '/jobs/' + j.id + '/reorder', { direction }, {
        errPrefix: 'Reorder job',
      });
      if (r) store.loadJobs();
    },
  },
  template: `
    <div class="card">
      <div class="card-header">
        <span class="card-title">Job queue</span>
        <span v-if="pending.length" class="chip">{{ pending.length }} queued</span>
        <button class="btn btn-ghost btn-sm right" @click="refresh"
                title="Refresh queue" aria-label="Refresh job queue">↻</button>
      </div>

      <div v-if="error" class="banner banner-err">
        <span class="grow">{{ error }}</span>
        <button class="btn btn-sm" @click="refresh">Retry</button>
      </div>

      <div v-else-if="allEmpty" class="empty">
        <span class="empty-icon">☰</span>
        <span>Queue idle</span>
      </div>

      <div v-else class="col" style="gap: var(--sp-1)">
        <template v-if="running.length">
          <span class="label">Running</span>
          <div v-for="j in running" :key="'run' + j.id" class="feed-item job-row">
            <span class="spinner" style="flex: none"></span>
            <span class="bold nowrap">{{ j.action }}</span>
            <span class="chip truncate">{{ j.project }}</span>
            <span class="xs muted right nowrap mono">{{ elapsed(j) }}</span>
            <button class="btn btn-sm btn-danger" :disabled="!canCancel(j) || !!j.cancel_requested_at || busy['cancel-job:' + j.id]"
                    @click="cancelRunning(j)" :title="canCancel(j) ? 'Request safe cancellation' : cancelReason(j)"
                    :aria-label="canCancel(j) ? ('Cancel running job ' + j.action) : (j.action + ' cannot be cancelled safely')">
              <span v-if="busy['cancel-job:' + j.id]" class="spinner"></span>
              <span v-else>{{ j.cancel_requested_at ? 'Cancelling…' : canCancel(j) ? 'Cancel' : 'Cannot stop' }}</span>
            </button>
          </div>
        </template>

        <template v-if="pending.length">
          <span class="label" :style="running.length ? 'margin-top: var(--sp-2)' : null">Pending</span>
          <div v-for="(j, i) in pending" :key="'pen' + j.id" class="feed-item job-row">
            <span class="xs muted nowrap" style="width: 18px; flex: none">{{ j.queue_position || i + 1 }}</span>
            <span class="bold nowrap">{{ j.action }}</span>
            <span class="chip truncate">{{ j.project }}</span>
            <span v-if="j.requested_by" class="xs muted nowrap">by {{ j.requested_by }}</span>
            <span v-if="retryIn(j)" class="xs muted nowrap">retries in {{ retryIn(j) }}</span>
            <div class="row job-reorder" style="gap: 2px">
              <button class="btn btn-ghost btn-sm" :disabled="i === 0 || busy['move-job:' + j.id]"
                      @click="moveJob(j, 'up')" :aria-label="'Move ' + j.action + ' up'" title="Move up">↑</button>
              <button class="btn btn-ghost btn-sm" :disabled="i === pending.length - 1 || busy['move-job:' + j.id]"
                      @click="moveJob(j, 'down')" :aria-label="'Move ' + j.action + ' down'" title="Move down">↓</button>
            </div>
            <button class="btn btn-ghost btn-sm right" :disabled="busy['dq:' + j.id]"
                    @click="removeJob(j)" :title="'Remove job #' + j.id" aria-label="Remove queued job">
              <span v-if="busy['dq:' + j.id]" class="spinner"></span><span v-else>×</span>
            </button>
          </div>
        </template>

        <template v-if="recent.length">
          <span class="label" :style="running.length || pending.length ? 'margin-top: var(--sp-2)' : null">Recent</span>
          <div v-for="j in recent" :key="'rec' + j.id" class="feed-item job-row">
            <span class="badge" :style="{'--badge-c': statusMeta(j.status).color}">{{ statusMeta(j.status).label }}</span>
            <span class="bold nowrap">{{ j.action }}</span>
            <span class="chip truncate">{{ j.project }}</span>
            <span class="grow truncate xs muted" :title="j.result_summary || j.error_message || ''">
              {{ trunc(j.result_summary || j.error_message, 60) }}
            </span>
            <span class="xs muted nowrap">{{ fmtAgo(j.ended_at, now) }}</span>
            <button v-if="j.status === 'failed' || j.status === 'cancelled'" class="btn btn-sm"
                    :disabled="!canRetry(j) || busy['retry-job:' + j.id]" @click="retryJob(j)"
                    :title="canRetry(j) ? 'Queue a safe replay of this job' : retryReason(j)"
                    :aria-label="'Retry ' + j.action + ' job'">
              <span v-if="busy['retry-job:' + j.id]" class="spinner"></span>
              <span v-else>Retry</span>
            </button>
          </div>
        </template>
      </div>

      <div class="xs muted" style="margin-top: var(--sp-2)">
        Shared durable queue — web, Telegram, and Discord actions (resume, go, next, launch, brief-chain…)
        all land here and wait for a free worker slot.
      </div>
    </div>
  `,
};
