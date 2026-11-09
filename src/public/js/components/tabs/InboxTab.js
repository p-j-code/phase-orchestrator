import { store } from '../../lib/store.js';
import { api } from '../../lib/api.js';
import { router } from '../../lib/router.js';
import { fmtAgo, statusMeta } from '../../lib/format.js';

const SEV_COLORS = {
  critical:   'var(--err)',
  major:      'var(--orange)',
  minor:      'var(--info)',
  high:       'var(--err)',
  medium:     'var(--orange)',
  low:        'var(--info)',
  unassigned: 'var(--muted)',
};

// Shared bug/requirement inbox section (internal to this file — not a routed tab).
export const InboxSection = {
  name: 'InboxSection',
  props: {
    kind: { type: String, required: true }, // 'bug' | 'req'
  },
  data() {
    return {
      items: null,      // null = not loaded yet
      loading: false,
      error: '',
      text: '',
      severity: 'unassigned',
      selected: {},     // id → true (inbox rows only)
      expanded: {},     // id → true (full text shown)
      bulkBusy: false,
      rowErrors: {},    // id → bulk-operation failure detail
      requestId: 0,     // fences stale list responses
      bulkRequestId: 0, // fences bulk follow-up UI across project changes
    };
  },
  computed: {
    projectName() { return router.project; },
    now() { return store.state.now; },
    cfg() {
      if (this.kind === 'bug') {
        return {
          icon: '🐛', title: 'Bugs', noun: 'bug', nounPlural: 'bugs',
          placeholder: 'Describe the bug… prefix critical:/major:/minor: also works',
          hint: 'Bugs arrive from the capture form above, Telegram /bug, or the CLI.',
        };
      }
      return {
        icon: '📋', title: 'Requirements', noun: 'requirement', nounPlural: 'requirements',
        placeholder: 'Requirement…',
        hint: 'Requirements arrive from the capture form above, Telegram /req, or the CLI.',
      };
    },
    base() {
      const seg = this.kind === 'bug' ? 'bugs' : 'requirements';
      return '/projects/' + encodeURIComponent(this.projectName || '') + '/' + seg;
    },
    addKey() { return 'inbox-add:' + this.kind + ':' + this.projectName; },
    addBusy() { return !!store.state.busy[this.addKey]; },
    mutationLockReason() { return store.projectMutationLockReason(this.projectName); },
    mutationLocked() { return !!this.mutationLockReason; },
    inboxCount() {
      const d = store.state.detail;
      if (d && d.name === this.projectName) {
        return this.kind === 'bug' ? (d.bugInbox || 0) : (d.reqInbox || 0);
      }
      return this.items ? this.selectable.length : 0;
    },
    selectable() {
      return (this.items || []).filter((it) => it.status === 'inbox');
    },
    selectedIds() {
      return this.selectable.filter((it) => this.selected[it.id]).map((it) => it.id);
    },
    selectedCount() { return this.selectedIds.length; },
    allSelected() {
      return this.selectable.length > 0 && this.selectedIds.length === this.selectable.length;
    },
  },
  watch: {
    text() { this.persistDraft(); },
    severity() { this.persistDraft(); },
    projectName(nv, ov) {
      if (nv !== ov) {
        this.persistDraft(ov);
        this.requestId++;
        this.bulkRequestId++;
        this.items = null;
        this.loading = false;
        this.selected = {};
        this.expanded = {};
        this.rowErrors = {};
        this.bulkBusy = false;
        this.error = '';
        this.restoreDraft(nv);
        if (nv) this.reload();
      }
    },
  },
  mounted() {
    this.restoreDraft(this.projectName);
    this.reload();
  },
  beforeUnmount() {
    this.persistDraft(this.projectName);
    this.requestId++;
    this.bulkRequestId++;
  },
  methods: {
    fmtAgo, statusMeta,

    draftKey(project = this.projectName) {
      return project ? 'ashmero:inbox-draft:v1:' + encodeURIComponent(project) + ':' + this.kind : '';
    },
    persistDraft(project = this.projectName) {
      const key = this.draftKey(project);
      if (!key) return;
      try {
        if (!this.text.trim()) {
          localStorage.removeItem(key);
          return;
        }
        localStorage.setItem(key, JSON.stringify({
          text: this.text,
          severity: this.kind === 'bug' ? this.severity : 'unassigned',
        }));
      } catch {
        // Storage can be unavailable (private mode/quota); capture still works in-memory.
      }
    },
    restoreDraft(project = this.projectName) {
      this.text = '';
      this.severity = 'unassigned';
      const key = this.draftKey(project);
      if (!key) return;
      try {
        const draft = JSON.parse(localStorage.getItem(key) || 'null');
        if (!draft || typeof draft.text !== 'string') return;
        this.text = draft.text;
        if (this.kind === 'bug' && ['unassigned', 'critical', 'major', 'minor'].includes(draft.severity)) {
          this.severity = draft.severity;
        }
      } catch {
        // Ignore malformed or inaccessible storage and start with an empty form.
      }
    },
    clearDraft(project = this.projectName) {
      const key = this.draftKey(project);
      if (!key) return;
      try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
    },

    sevLabel(item) {
      return this.kind === 'bug'
        ? (item.severity || 'unassigned')
        : (item.priority || 'unassigned');
    },
    sevColor(v) { return SEV_COLORS[v] || 'var(--muted)'; },
    isInbox(item) { return item.status === 'inbox'; },
    displayText(item) {
      const t = item.raw_text || '';
      if (this.expanded[item.id] || t.length <= 140) return t;
      return t.slice(0, 140) + '…';
    },
    textStyle(item) {
      return item.status === 'dropped'
        ? { textDecoration: 'line-through', color: 'var(--muted)' }
        : null;
    },
    toggleExpand(id) {
      if (this.expanded[id]) delete this.expanded[id];
      else this.expanded[id] = true;
    },
    toggleSelect(id) {
      if (this.selected[id]) delete this.selected[id];
      else this.selected[id] = true;
    },
    toggleAll() {
      if (this.allSelected) { this.selected = {}; return; }
      const s = {};
      for (const it of this.selectable) s[it.id] = true;
      this.selected = s;
    },
    rowBusy(item) {
      return this.mutationLocked || this.bulkBusy ||
        !!store.state.busy['inbox-promote:' + this.kind + ':' + item.id] ||
        !!store.state.busy['inbox-drop:' + this.kind + ':' + item.id];
    },

    async reload(options = {}) {
      const project = this.projectName;
      if (!project) return;
      const base = this.base;
      const requestId = ++this.requestId;
      if (options?.preserveRowErrors !== true) this.rowErrors = {};
      this.loading = true;
      this.error = '';
      try {
        const rows = await api('GET', base);
        if (requestId !== this.requestId || this.projectName !== project) return;
        this.items = Array.isArray(rows) ? rows : [];
        this.selected = {};
      } catch (e) {
        if (requestId !== this.requestId || this.projectName !== project) return;
        this.error = e.message;
      } finally {
        if (requestId === this.requestId && this.projectName === project) {
          this.loading = false;
        }
      }
    },
    refreshCounts(project = this.projectName) {
      if (!project || this.projectName !== project) return;
      store.loadDetail(project, { silent: true });
      store.loadStats();
    },

    async add() {
      const text = this.text.trim();
      if (!text || !this.projectName || this.addBusy) return;
      const project = this.projectName;
      const base = this.base;
      const addKey = this.addKey;
      const body = this.kind === 'bug' && this.severity !== 'unassigned'
        ? { raw_text: text, severity: this.severity }
        : { raw_text: text };
      const r = await store.act(addKey, 'POST', base, body, {
        okMsg: this.kind === 'bug' ? 'Bug captured' : 'Requirement captured',
        errPrefix: 'Add ' + this.cfg.noun,
      });
      if (r) {
        this.clearDraft(project);
        if (this.projectName !== project) return;
        this.text = '';
        this.severity = 'unassigned';
        this.reload();
        this.refreshCounts(project);
      }
    },

    async promoteOne(item) {
      const project = this.projectName;
      const initialLock = store.projectMutationLockReason(project);
      if (initialLock) {
        store.toast(initialLock, 'warn', { project });
        return;
      }
      const base = this.base;
      const yes = await store.confirmAction({
        title: 'Promote ' + this.cfg.noun + '?',
        body: this.kind === 'bug'
          ? 'Append this bug to the next fix round? This changes the durable bug-round artifact.'
          : 'Append this requirement to raw-thoughts.md for the next brief?',
        confirmLabel: 'Promote',
      });
      if (!yes || this.projectName !== project) return;
      const lockReason = await store.revalidateProjectMutationLock(project);
      if (this.projectName !== project) return;
      if (lockReason) {
        store.toast(lockReason, 'warn', { project });
        return;
      }
      const r = await store.act('inbox-promote:' + this.kind + ':' + item.id, 'POST',
        base + '/' + item.id + '/promote', undefined, {
          okMsg: this.kind === 'bug' ? 'Bug promoted to next fix round' : 'Requirement promoted',
          errPrefix: 'Promote',
        });
      if (r && this.projectName === project) {
        const current = (this.items || []).find((candidate) => candidate.id === item.id);
        if (current) current.status = r.status || 'promoted';
        delete this.selected[item.id];
        delete this.rowErrors[item.id];
        this.refreshCounts(project);
      }
    },

    async dropOne(item) {
      const project = this.projectName;
      const initialLock = store.projectMutationLockReason(project);
      if (initialLock) {
        store.toast(initialLock, 'warn', { project });
        return;
      }
      const base = this.base;
      const snippet = (item.raw_text || '').slice(0, 80);
      const yes = await store.confirmAction({
        title: 'Drop ' + this.cfg.noun + '?',
        body: '“' + snippet + '” will be marked dropped and excluded from future rounds.',
        danger: true,
        confirmLabel: 'Drop',
      });
      if (!yes || this.projectName !== project) return;
      const lockReason = await store.revalidateProjectMutationLock(project);
      if (this.projectName !== project) return;
      if (lockReason) {
        store.toast(lockReason, 'warn', { project });
        return;
      }
      const r = await store.act('inbox-drop:' + this.kind + ':' + item.id, 'POST',
        base + '/' + item.id + '/drop', undefined, {
          okMsg: this.cfg.title.slice(0, -1) + ' dropped',
          errPrefix: 'Drop',
        });
      if (r && this.projectName === project) {
        const current = (this.items || []).find((candidate) => candidate.id === item.id);
        if (current) current.status = r.status || 'dropped';
        delete this.selected[item.id];
        delete this.rowErrors[item.id];
        this.refreshCounts(project);
      }
    },

    async bulkPromote() {
      const ids = this.selectedIds.slice();
      if (!ids.length || this.bulkBusy) return;
      const project = this.projectName;
      const initialLock = store.projectMutationLockReason(project);
      if (initialLock) {
        store.toast(initialLock, 'warn', { project });
        return;
      }
      const base = this.base;
      const yes = await store.confirmAction({
        title: 'Promote ' + ids.length + ' ' + (ids.length === 1 ? this.cfg.noun : this.cfg.nounPlural) + '?',
        body: this.kind === 'bug'
          ? 'Append the selected bugs to the next fix round in order? Completed rows remain promoted if a later row fails.'
          : 'Append the selected requirements to raw-thoughts.md in order? Completed rows remain promoted if a later row fails.',
        confirmLabel: 'Promote ' + ids.length,
      });
      if (!yes || this.projectName !== project) return;
      const lockReason = await store.revalidateProjectMutationLock(project);
      if (this.projectName !== project) return;
      if (lockReason) {
        store.toast(lockReason, 'warn', { project });
        return;
      }
      const operationId = ++this.bulkRequestId;
      this.bulkBusy = true;
      const results = [];
      // Promotions are deliberately serialized: bug promotion performs a
      // read/append/write sequence, so parallel requests could race numbering.
      for (const id of ids) {
        try {
          const value = await api('POST', base + '/' + id + '/promote');
          results.push({ id, status: 'fulfilled', value });
        } catch (reason) {
          results.push({ id, status: 'rejected', reason });
        }
      }
      await this.finishBulk(results, 'promoted', { project, operationId });
    },

    async bulkDrop() {
      const ids = this.selectedIds.slice();
      if (!ids.length || this.bulkBusy) return;
      const project = this.projectName;
      const initialLock = store.projectMutationLockReason(project);
      if (initialLock) {
        store.toast(initialLock, 'warn', { project });
        return;
      }
      const base = this.base;
      const yes = await store.confirmAction({
        title: 'Drop ' + ids.length + ' ' + (ids.length === 1 ? this.cfg.noun : this.cfg.nounPlural) + '?',
        body: 'Dropped items are kept for history but excluded from future rounds.',
        danger: true,
        confirmLabel: 'Drop ' + ids.length,
      });
      if (!yes || this.projectName !== project) return;
      const lockReason = await store.revalidateProjectMutationLock(project);
      if (this.projectName !== project) return;
      if (lockReason) {
        store.toast(lockReason, 'warn', { project });
        return;
      }
      const operationId = ++this.bulkRequestId;
      this.bulkBusy = true;
      const settled = await Promise.allSettled(
        ids.map((id) => api('POST', base + '/' + id + '/drop')));
      const results = settled.map((result, index) => ({ id: ids[index], ...result }));
      await this.finishBulk(results, 'dropped', { project, operationId });
    },

    async finishBulk(results, verb, { project, operationId }) {
      if (operationId !== this.bulkRequestId || this.projectName !== project) return;
      const successful = results.filter((result) => result.status === 'fulfilled');
      const failed = results.filter((result) => result.status === 'rejected');
      const rowErrors = { ...this.rowErrors };
      for (const result of results) delete rowErrors[result.id];
      for (const result of failed) {
        rowErrors[result.id] = result.reason?.message || 'Request failed';
      }
      this.rowErrors = rowErrors;
      for (const result of successful) {
        const item = (this.items || []).find((candidate) => candidate.id === result.id);
        if (item) item.status = result.value?.status || verb;
      }
      const ok = successful.length;
      const fail = failed.length;
      store.toast(fail ? ok + ' ' + verb + ', ' + fail + ' failed — see highlighted rows' : ok + ' ' + verb,
        fail ? 'err' : 'ok');
      this.selected = {};
      await this.reload({ preserveRowErrors: fail > 0 });
      if (operationId !== this.bulkRequestId || this.projectName !== project) return;
      this.bulkBusy = false;
      this.refreshCounts(project);
    },
  },
  template: `
    <section class="card">
      <div class="card-header">
        <span class="card-title">{{ cfg.icon }} {{ cfg.title }}</span>
        <span v-if="inboxCount > 0" class="chip">{{ inboxCount }} in inbox</span>
        <button class="btn btn-ghost btn-sm right" :disabled="loading" @click="reload"
                title="Refresh list" aria-label="Refresh list">↻</button>
      </div>

      <!-- capture form -->
      <div class="col" style="margin-bottom: var(--sp-3)">
        <textarea v-model="text" class="textarea" rows="2" style="min-height: 0"
                  :placeholder="cfg.placeholder" :disabled="addBusy"
                  :aria-label="'New ' + cfg.noun"
                  @keydown.enter.meta.prevent="add" @keydown.enter.ctrl.prevent="add"></textarea>
        <div class="row">
          <select v-if="kind === 'bug'" v-model="severity" class="select" style="width: 130px"
                  :disabled="addBusy" aria-label="Severity">
            <option value="unassigned">Unassigned</option>
            <option value="critical">Critical</option>
            <option value="major">Major</option>
            <option value="minor">Minor</option>
          </select>
          <button class="btn btn-primary btn-sm right" :disabled="addBusy || !text.trim()" @click="add">
            <span v-if="addBusy" class="spinner"></span> Add
          </button>
        </div>
      </div>

      <!-- loading -->
      <div v-if="loading && items === null" class="col">
        <div class="skeleton" style="height: 38px"></div>
        <div class="skeleton" style="height: 38px"></div>
        <div class="skeleton" style="height: 38px"></div>
      </div>

      <!-- error -->
      <div v-else-if="error" class="banner banner-err">
        {{ error }}
        <button class="btn btn-sm right" @click="reload">Retry</button>
      </div>

      <!-- empty -->
      <div v-else-if="items && !items.length" class="empty">
        <span class="empty-icon">🎉</span>
        <span>Inbox zero</span>
        <span class="empty-hint">{{ cfg.hint }}</span>
      </div>

      <!-- list -->
      <template v-else-if="items">
        <div v-if="selectable.length" class="row card-flat inbox-bulk" style="padding: var(--sp-2) var(--sp-3); margin-bottom: var(--sp-2)">
          <label class="checkbox small">
            <input type="checkbox" :checked="allSelected" @change="toggleAll"
                   :aria-label="'Select all inbox ' + cfg.nounPlural">
            <span>{{ selectedCount ? selectedCount + ' selected' : 'Select all' }}</span>
          </label>
          <template v-if="selectedCount">
            <button class="btn btn-sm right" :disabled="bulkBusy || mutationLocked" @click="bulkPromote"
                    :title="mutationLockReason || 'Promote selected items'">
              <span v-if="bulkBusy" class="spinner"></span> Promote {{ selectedCount }}
            </button>
            <button class="btn btn-sm btn-danger" :disabled="bulkBusy || mutationLocked" @click="bulkDrop"
                    :title="mutationLockReason || 'Drop selected items'">
              Drop {{ selectedCount }}
            </button>
          </template>
        </div>

        <div v-for="item in items" :key="item.id" class="feed-item inbox-row"
             :style="item.status === 'dropped' ? { opacity: 0.5, alignItems: 'flex-start' } : { alignItems: 'flex-start' }">
          <label v-if="isInbox(item)" class="checkbox" style="margin-top: 2px">
            <input type="checkbox" :checked="!!selected[item.id]" @change="toggleSelect(item.id)"
                   :aria-label="'Select ' + cfg.noun + ' ' + item.id">
          </label>
          <span v-else style="width: 14px; flex: none"></span>

          <span class="badge" :style="{ '--badge-c': sevColor(sevLabel(item)) }">{{ sevLabel(item) }}</span>

          <button class="grow small" :title="item.raw_text"
                  style="text-align: left; padding: 0; white-space: pre-wrap; word-break: break-word"
                  :style="textStyle(item)"
                  :aria-expanded="!!expanded[item.id]"
                  @click="toggleExpand(item.id)">{{ displayText(item) }}</button>

          <span class="badge nowrap" :style="{ '--badge-c': statusMeta(item.status).color }">{{ statusMeta(item.status).label }}</span>
          <span class="xs muted nowrap">{{ fmtAgo(item.created_at, now) }}</span>

          <div v-if="isInbox(item)" class="col inbox-actions" style="gap: 4px; flex: none; align-items: flex-end">
            <span v-if="rowErrors[item.id]" class="xs" style="color: var(--err); max-width: 240px"
                  role="alert" :title="rowErrors[item.id]">Failed: {{ rowErrors[item.id] }}</span>
            <div class="row nowrap" style="gap: 4px">
              <button class="btn btn-sm" :disabled="rowBusy(item)" :title="mutationLockReason || 'Promote item'" @click="promoteOne(item)">Promote</button>
              <button class="btn btn-sm btn-danger" :disabled="rowBusy(item)" :title="mutationLockReason || 'Drop item'" @click="dropOne(item)">Drop</button>
            </div>
          </div>
        </div>
      </template>
    </section>
  `,
};

export default {
  name: 'InboxTab',
  components: { InboxSection },
  template: `
    <div class="col" style="gap: var(--sp-4)">
      <InboxSection kind="bug" />
      <InboxSection kind="req" />
    </div>
  `,
};
