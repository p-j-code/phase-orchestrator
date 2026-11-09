import { store } from '../../lib/store.js';
import { navigate, projectHash } from '../../lib/router.js';
import { fmtMoney, fmtAgo, modelShort } from '../../lib/format.js';

export default {
  name: 'ActivityFeed',
  props: {
    project: { type: String, default: null },
  },
  computed: {
    now() { return store.state.now; },
    error() { return store.state.activityError; },
    items() {
      const all = this.project
        ? store.state.activity.filter((a) => a.project === this.project)
        : store.state.activity;
      return all.slice(0, 60);
    },
  },
  methods: {
    fmtMoney, fmtAgo, modelShort,
    refresh() { store.loadActivity(); },
    trunc(s, n) {
      const t = String(s || '');
      return t.length > n ? t.slice(0, n) + '…' : t;
    },
    itemKey(it, i) {
      return (it.row && it.row.id != null) ? 'c' + it.row.id : 's' + it.at + ':' + i;
    },
    goProject(name) {
      if (!name) return;
      navigate(projectHash(name));
    },
    open(it) {
      store.state.callDetail = it.row || {
        task: it.task,
        model: it.model,
        cost_usd: it.cost_usd,
        is_error: it.is_error,
        phase: it.phase,
        project: it.project,
        started_at: new Date(it.at).toISOString(),
        input_tokens: null,
        output_tokens: null,
      };
    },
  },
  template: `
    <div class="card">
      <div class="card-header">
        <span class="card-title">Activity</span>
        <span v-if="items.length" class="chip right">{{ items.length }}</span>
        <button class="btn btn-ghost btn-sm" @click="refresh" aria-label="Refresh activity" title="Refresh activity">↻</button>
      </div>

      <div v-if="error" class="banner banner-err">
        <span class="grow">{{ error }}</span>
        <button class="btn btn-sm" @click="refresh">Retry</button>
      </div>

      <div v-else-if="!items.length" class="empty">
        <span class="empty-icon">⚡</span>
        <span>No activity yet</span>
        <span class="empty-hint">Agent calls will appear here as they complete</span>
      </div>

      <div v-else class="scroll-y" style="max-height: 420px">
        <div v-for="(it, i) in items" :key="itemKey(it, i)"
             class="feed-item row-click" tabindex="0" role="button"
             :aria-label="'Call detail: ' + trunc(it.task, 48)"
             @click="open(it)" @keydown.enter.prevent="open(it)" @keydown.space.prevent="open(it)">
          <span class="xs muted nowrap" style="width: 62px; flex: none">{{ fmtAgo(it.at, now) }}</span>
          <button v-if="!project && it.project" class="chip" :title="'Open ' + it.project"
                  @click.stop="goProject(it.project)">{{ it.project }}</button>
          <span v-else-if="!project" class="chip muted" title="This activity is not scoped to a project">Unscoped</span>
          <span :style="{ color: it.is_error ? 'var(--err)' : 'var(--ok)' }">{{ it.is_error ? '✗' : '✓' }}</span>
          <span class="grow truncate" :title="it.task">{{ trunc(it.task, 48) }}</span>
          <span class="chip mono">{{ modelShort(it.model) }}</span>
          <span class="xs mono muted nowrap">{{ fmtMoney(it.cost_usd) }}</span>
        </div>
      </div>
    </div>
  `,
};
