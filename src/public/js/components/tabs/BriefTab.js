// BriefTab — ports every feature of the legacy BriefModal onto the new store/css
// as three cards: current brief editor · next-brief raw thoughts · brief queue.

import { store } from '../../lib/store.js';
import { registerNavigationGuard, router } from '../../lib/router.js';
import { api } from '../../lib/api.js';
import { fmtDate } from '../../lib/format.js';

const BRIEF_DRAFTS_KEY = 'ashmero_brief_drafts_v1';

function readDrafts() {
  try {
    const value = JSON.parse(localStorage.getItem(BRIEF_DRAFTS_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function writeDrafts(drafts) {
  try {
    const entries = Object.entries(drafts)
      .sort((a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0))
      .slice(0, 20);
    localStorage.setItem(BRIEF_DRAFTS_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* private mode / quota — navigation guard still protects this mount */ }
}

export default {
  name: 'BriefTab',
  data() {
    return {
      loadedProject: null,

      // current brief (brief.md)
      briefLoading: true,
      briefError: '',
      briefContent: '',
      briefOriginal: '',
      briefMtime: null,
      briefConflict: '',
      alreadyGenerated: false,

      // next brief (raw-thoughts.md)
      rawLoading: true,
      rawError: '',
      rawContent: '',
      rawOriginal: '',
      rawMtime: null,
      rawConflict: '',

      // brief queue (inputs/queue/*.md)
      queueLoading: true,
      queueError: '',
      queue: [],
      newFilename: '',
      newContent: '',
      filenameEdited: false,
    };
  },
  computed: {
    projectName() { return router.project; },
    base() { return '/projects/' + encodeURIComponent(this.projectName || ''); },
    hasNextBrief() {
      const d = store.state.detail;
      return !!(d && d.name === this.projectName && d.hasNextBrief);
    },
    pendingJob() {
      const d = store.state.detail;
      return d?.name === this.projectName ? d.pendingJob : null;
    },
    mutationLocked() {
      const d = store.state.detail;
      return !!(d?.name === this.projectName && (d.processAlive || d.autoRun?.status === 'running' || d.pendingJob));
    },
    briefDirty() { return this.briefContent !== this.briefOriginal; },
    rawDirty() { return this.rawContent !== this.rawOriginal; },
    queueDraftDirty() { return !!this.newContent.trim() || this.filenameEdited; },
    hasUnsavedChanges() { return this.briefDirty || this.rawDirty || this.queueDraftDirty; },
    // "Save & run agent" locked while brief.md was already generated from the
    // current raw-thoughts and nothing changed — editing unlocks (old-UI rule).
    runAgentLocked() { return this.alreadyGenerated && !this.briefDirty; },
    launchLocked() { return this.alreadyGenerated && !this.rawDirty; },
    launchBusy() {
      return this.busy(this.k('rawlaunch')) || this.busy('next-brief:' + this.projectName);
    },
  },
  watch: {
    projectName(name) {
      this.persistDraft(this.loadedProject);
      if (name) this.loadAllCards();
    },
  },
  mounted() {
    window.addEventListener('beforeunload', this.onBeforeUnload);
    this.removeNavigationGuard = registerNavigationGuard(() => {
      if (!this.hasUnsavedChanges) return true;
      return window.confirm('You have unsaved brief changes. Leave this page? A browser-local draft will be restored when you return (unless browser storage is unavailable).');
    });
    if (this.projectName && this.loadedProject !== this.projectName) this.loadAllCards();
  },
  beforeUnmount() {
    this.persistDraft(this.loadedProject);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    this.removeNavigationGuard?.();
  },
  activated() {
    if (this.projectName && this.loadedProject !== this.projectName) this.loadAllCards();
  },
  methods: {
    fmtDate,
    k(sub) { return 'brief-' + sub + ':' + this.projectName; },
    busy(key) { return !!store.state.busy[key]; },
    truncate(s, n = 100) {
      const t = String(s || '').replace(/\s+/g, ' ');
      return t.length > n ? t.slice(0, n) + '…' : t;
    },
    onBeforeUnload(e) {
      if (!this.hasUnsavedChanges) return;
      e.preventDefault();
      e.returnValue = '';
    },
    draftChanged() { this.$nextTick(() => this.persistDraft()); },
    onQueueFilenameInput() {
      this.filenameEdited = true;
      this.draftChanged();
    },
    persistDraft(project = this.loadedProject) {
      if (!project) return;
      const all = readDrafts();
      const entry = {};
      if (this.briefDirty) entry.brief = {
        content: this.briefContent,
        original: this.briefOriginal,
        mtime: this.briefMtime,
      };
      if (this.rawDirty) entry.raw = {
        content: this.rawContent,
        original: this.rawOriginal,
        mtime: this.rawMtime,
      };
      if (this.queueDraftDirty) entry.queue = {
        filename: this.newFilename,
        content: this.newContent,
        filenameEdited: this.filenameEdited,
      };
      if (Object.keys(entry).length) all[project] = { ...entry, updatedAt: Date.now() };
      else delete all[project];
      writeDrafts(all);
    },
    clearDraftKind(project, kind) {
      const all = readDrafts();
      if (!all[project]) return;
      delete all[project][kind];
      if (!all[project].brief && !all[project].raw && !all[project].queue) delete all[project];
      writeDrafts(all);
    },

    async writeFile({ key, path, content, expectedMtime, okMsg, errPrefix, conflictField }) {
      if (store.state.busy[key]) return null;
      store.state.busy[key] = true;
      this[conflictField] = '';
      try {
        const result = await api('POST', path, { content, expectedMtime });
        if (okMsg) store.toast(okMsg, 'ok');
        return result;
      } catch (e) {
        const isVersionConflict = e.status === 409 && (
          e.data?.currentMtime !== undefined || e.data?.currentVersion !== undefined ||
          /changed since it was loaded/i.test(e.message || '')
        );
        if (isVersionConflict) {
          this[conflictField] = e.message || 'This file changed on disk after you opened it.';
          store.toast('Save blocked: file changed on disk', 'warn', { ttl: 6000 });
        } else {
          store.toast(errPrefix + ': ' + e.message, 'err');
        }
        return null;
      } finally {
        delete store.state.busy[key];
      }
    },

    loadAllCards() {
      // Clear the previous project's editor values before assigning the new
      // identity so an old dirty buffer can never be persisted under a new name.
      this.briefContent = this.briefOriginal = '';
      this.rawContent = this.rawOriginal = '';
      this.newFilename = '';
      this.newContent = '';
      this.filenameEdited = false;
      this.loadedProject = this.projectName;
      this.loadBrief();
      this.loadRaw();
      this.loadQueue();
    },

    // ── current brief ─────────────────────────────────────────────────────

    async loadBrief({ silent = false } = {}) {
      const name = this.projectName;
      const base = this.base;
      if (!silent) { this.briefLoading = true; this.briefError = ''; }
      try {
        const r = await api('GET', base + '/brief');
        if (this.projectName !== name) return;
        const serverMtime = r.briefMtime || null;
        const draft = readDrafts()[name]?.brief;
        this.briefMtime = draft ? (draft.mtime ?? null) : serverMtime;
        this.briefConflict = '';
        this.alreadyGenerated = !!r.alreadyGenerated;
        if (draft && typeof draft.content === 'string') {
          this.briefContent = draft.content;
          this.briefOriginal = typeof draft.original === 'string' ? draft.original : (r.content || '');
          if ((draft.mtime ?? null) !== serverMtime) {
            this.briefConflict = 'brief.md changed on disk while this local draft was saved.';
          }
        } else if (!silent || !this.briefDirty) {
          this.briefContent = r.content || '';
          this.briefOriginal = r.content || '';
        }
      } catch (e) {
        if (this.projectName === name && !silent) this.briefError = e.message;
      } finally {
        if (this.projectName === name && !silent) this.briefLoading = false;
      }
    },

    async saveBrief() {
      const content = this.briefContent;
      const r = await this.writeFile({
        key: this.k('save'), path: this.base + '/brief', content,
        expectedMtime: this.briefMtime, okMsg: 'Brief saved', errPrefix: 'Save brief',
        conflictField: 'briefConflict',
      });
      if (r) {
        this.briefOriginal = content;
        this.briefMtime = r.briefMtime || r.mtime || this.briefMtime;
        this.clearDraftKind(this.projectName, 'brief');
        this.loadBrief({ silent: true }); // refresh mtime + alreadyGenerated
      }
    },

    async saveAndRunBrief() {
      const key = this.k('saverun');
      const content = this.briefContent;
      const saved = await this.writeFile({
        key, path: this.base + '/brief', content, expectedMtime: this.briefMtime,
        errPrefix: 'Save brief', conflictField: 'briefConflict',
      });
      if (!saved) return;
      this.briefOriginal = content;
      this.briefMtime = saved.briefMtime || saved.mtime || this.briefMtime;
      this.clearDraftKind(this.projectName, 'brief');
      const ran = await store.act(key, 'POST', this.base + '/brief/run', undefined,
        { okMsg: 'Brief agent launched — watch Overview live log', errPrefix: 'Run brief agent' });
      if (ran) {
        this.alreadyGenerated = true;
        this.loadBrief({ silent: true });
      }
    },

    // ── next brief (raw thoughts) ─────────────────────────────────────────

    async loadRaw({ silent = false } = {}) {
      const name = this.projectName;
      const base = this.base;
      if (!silent) { this.rawLoading = true; this.rawError = ''; }
      try {
        const r = await api('GET', base + '/raw-thoughts');
        if (this.projectName !== name) return;
        const serverMtime = r.mtime || null;
        const draft = readDrafts()[name]?.raw;
        this.rawMtime = draft ? (draft.mtime ?? null) : serverMtime;
        this.rawConflict = '';
        if (draft && typeof draft.content === 'string') {
          this.rawContent = draft.content;
          this.rawOriginal = typeof draft.original === 'string' ? draft.original : (r.content || '');
          if ((draft.mtime ?? null) !== serverMtime) {
            this.rawConflict = 'raw-thoughts.md changed on disk while this local draft was saved.';
          }
        } else if (!silent || !this.rawDirty) {
          this.rawContent = r.content || '';
          this.rawOriginal = r.content || '';
        }
      } catch (e) {
        if (this.projectName === name && !silent) this.rawError = e.message;
      } finally {
        if (this.projectName === name && !silent) this.rawLoading = false;
      }
    },

    async saveRaw() {
      const content = this.rawContent;
      const r = await this.writeFile({
        key: this.k('rawsave'), path: this.base + '/raw-thoughts', content,
        expectedMtime: this.rawMtime, okMsg: 'Next-brief draft saved', errPrefix: 'Save draft',
        conflictField: 'rawConflict',
      });
      if (r) {
        this.rawOriginal = content;
        this.rawMtime = r.mtime || this.rawMtime;
        this.clearDraftKind(this.projectName, 'raw');
        this.loadRaw({ silent: true });
        this.loadBrief({ silent: true });                       // alreadyGenerated may flip
        store.loadDetail(this.projectName, { silent: true });   // hasNextBrief dot
      }
    },

    async saveAndLaunchRaw() {
      if (!this.rawContent.trim()) { store.toast('Write your next requirements first', 'err'); return; }
      const content = this.rawContent;
      const saved = await this.writeFile({
        key: this.k('rawlaunch'), path: this.base + '/raw-thoughts', content,
        expectedMtime: this.rawMtime, errPrefix: 'Save draft', conflictField: 'rawConflict',
      });
      if (!saved) return;
      this.rawOriginal = content;
      this.rawMtime = saved.mtime || this.rawMtime;
      this.clearDraftKind(this.projectName, 'raw');
      // 409s when a run is active — store.act inside projectAction toasts the server error.
      await store.projectAction(this.projectName, 'next-brief');
      this.loadRaw({ silent: true });
      this.loadBrief({ silent: true });
    },

    // ── brief queue ───────────────────────────────────────────────────────

    async loadQueue({ silent = false } = {}) {
      const name = this.projectName;
      const base = this.base;
      if (!silent) { this.queueLoading = true; this.queueError = ''; }
      try {
        const items = await api('GET', base + '/brief-queue');
        if (this.projectName !== name) return;
        this.queue = Array.isArray(items) ? items : [];
        this.queueError = '';
        const draft = readDrafts()[name]?.queue;
        if (draft && typeof draft.content === 'string') {
          this.newFilename = typeof draft.filename === 'string' ? draft.filename : this.suggestName();
          this.newContent = draft.content;
          this.filenameEdited = draft.filenameEdited === true;
        } else if (!this.filenameEdited || !this.newFilename.trim()) {
          this.newFilename = this.suggestName();
          this.filenameEdited = false;
        }
      } catch (e) {
        if (this.projectName === name && !silent) this.queueError = e.message;
      } finally {
        if (this.projectName === name && !silent) this.queueLoading = false;
      }
    },

    suggestName() {
      let max = 0;
      for (const item of this.queue) {
        const m = /^(\d+)/.exec(item.filename || '');
        if (m) max = Math.max(max, parseInt(m[1], 10));
      }
      return String(max + 1).padStart(2, '0') + '-brief.md';
    },

    async addToQueue() {
      const filename = this.newFilename.trim();
      if (!filename) { store.toast('Filename required', 'err'); return; }
      if (!this.newContent.trim()) { store.toast('Write the brief content first', 'err'); return; }
      const r = await store.act(this.k('qadd'), 'POST', this.base + '/brief-queue',
        { filename, content: this.newContent },
        { okMsg: 'Added to queue: ' + filename, errPrefix: 'Add to queue' });
      if (r) {
        this.newContent = '';
        this.filenameEdited = false;
        this.clearDraftKind(this.projectName, 'queue');
        await this.loadQueue({ silent: true });
      }
    },

    async discardAndReload(kind) {
      const yes = await store.confirmAction({
        title: 'Discard local edits and reload?',
        body: 'The version currently in this editor will be replaced by the newer file on disk. Copy anything you need before continuing.',
        danger: true,
        confirmLabel: 'Discard and reload',
      });
      if (!yes) return;
      this.clearDraftKind(this.projectName, kind);
      if (kind === 'brief') await this.loadBrief();
      else await this.loadRaw();
    },

    async removeFromQueue(item) {
      const yes = await store.confirmAction({
        title: 'Delete queued brief?',
        body: '“' + item.filename + '” will be removed from the queue. This cannot be undone.',
        danger: true,
        confirmLabel: 'Delete',
      });
      if (!yes) return;
      const r = await store.act(this.k('qdel-' + item.filename), 'DELETE',
        this.base + '/brief-queue/' + encodeURIComponent(item.filename), undefined,
        { okMsg: item.filename + ' removed', errPrefix: 'Delete' });
      if (r) this.loadQueue({ silent: true });
    },

    async runChain() {
      const n = this.queue.length;
      if (!n) return;
      const yes = await store.confirmAction({
        title: 'Run brief queue (' + n + ')?',
        body: 'All ' + n + ' queued brief' + (n === 1 ? '' : 's') +
          ' will run unattended, one after another. This can take a long time and consume budget.',
        confirmLabel: 'Run queue',
      });
      if (!yes) return;
      const r = await store.act(this.k('chain'), 'POST', this.base + '/brief-chain', undefined,
        { okMsg: 'Chain queued durably — it will recover after restart/reset', errPrefix: 'Run queue' });
      if (r) this.loadQueue({ silent: true });
    },
  },
  template: `
    <div class="col" style="gap: var(--sp-4)">

      <!-- ── Card 1: current brief ─────────────────────────────────────── -->
      <section class="card" aria-label="Current brief">
        <div class="card-header">
          <span class="card-title">Current brief</span>
          <span class="xs muted mono">brief.md</span>
          <span v-if="briefMtime" class="chip" title="brief.md last modified">{{ fmtDate(briefMtime) }}</span>
          <span v-if="briefDirty" class="xs right" style="color: var(--warn)">unsaved changes</span>
        </div>

        <div v-if="briefLoading" class="col">
          <div class="skeleton" style="height: 220px"></div>
        </div>

        <div v-else-if="briefError" class="banner banner-err">
          {{ briefError }}
          <button class="btn btn-sm right" @click="loadBrief()">Retry</button>
        </div>

        <template v-else>
          <div v-if="runAgentLocked" class="banner banner-info" style="margin-bottom: var(--sp-3)">
            This brief was already generated from raw-thoughts — edit it below to unlock “Save &amp; run brief agent”.
          </div>
          <div v-if="briefConflict" class="banner banner-warn" style="margin-bottom: var(--sp-3)" role="alert">
            <span class="grow"><b>Save blocked:</b> {{ briefConflict }} Your edits are still in the editor.</span>
            <button class="btn btn-sm" @click="discardAndReload('brief')">Discard &amp; reload</button>
          </div>
          <div v-if="!briefContent && !briefDirty" class="empty" style="padding: var(--sp-3)">
            <span class="empty-icon">📝</span>
            <span>No brief.md yet</span>
            <span class="empty-hint">Write the brief below, or draft raw thoughts and run the brief agent.</span>
          </div>
          <p class="xs muted" style="margin: 0 0 var(--sp-2)">
            The brief driving the current implementation. Edit and re-run the brief agent to refine the plan.
          </p>
          <textarea v-model="briefContent" class="textarea textarea-mono" style="width: 100%"
                    @input="draftChanged"
                    placeholder="## What I want to build&#10;&#10;- Feature 1&#10;…"
                    aria-label="Current brief content"></textarea>
          <div class="row" style="margin-top: var(--sp-3)">
            <button class="btn right" :disabled="!briefDirty || mutationLocked || busy(k('save')) || busy(k('saverun'))" @click="saveBrief">
              <span v-if="busy(k('save'))" class="spinner"></span> Save
            </button>
            <button class="btn btn-primary"
                    :disabled="runAgentLocked || mutationLocked || busy(k('saverun')) || busy(k('save'))"
                    :title="mutationLocked ? 'Wait for active or queued project work to finish' : runAgentLocked ? 'Brief already generated — edit to unlock' : 'Save brief.md, then run the brief agent'"
                    @click="saveAndRunBrief">
              <span v-if="busy(k('saverun'))" class="spinner"></span>
              💾+🤖 Save &amp; run brief agent
            </button>
          </div>
        </template>
      </section>

      <!-- ── Card 2: next brief (raw thoughts) ─────────────────────────── -->
      <section class="card" aria-label="Next brief raw thoughts">
        <div class="card-header">
          <span class="card-title">Next brief (raw thoughts)</span>
          <span class="xs muted mono">raw-thoughts.md</span>
          <span v-if="hasNextBrief" class="dot" style="--dot-c: var(--orange)" title="Next brief queued"></span>
          <span v-if="hasNextBrief" class="xs" style="color: var(--orange)">next brief queued</span>
          <span v-if="rawMtime" class="chip" title="raw-thoughts.md last modified">{{ fmtDate(rawMtime) }}</span>
          <span v-if="rawDirty" class="xs right" style="color: var(--warn)">unsaved changes</span>
        </div>

        <div v-if="rawLoading" class="col">
          <div class="skeleton" style="height: 180px"></div>
        </div>

        <div v-else-if="rawError" class="banner banner-err">
          {{ rawError }}
          <button class="btn btn-sm right" @click="loadRaw()">Retry</button>
        </div>

        <template v-else>
          <div v-if="rawConflict" class="banner banner-warn" style="margin-bottom: var(--sp-3)" role="alert">
            <span class="grow"><b>Save blocked:</b> {{ rawConflict }} Your edits are still in the editor.</span>
            <button class="btn btn-sm" @click="discardAndReload('raw')">Discard &amp; reload</button>
          </div>
          <div v-if="!rawContent && !rawDirty" class="empty" style="padding: var(--sp-3)">
            <span class="empty-icon">💭</span>
            <span>No raw thoughts yet</span>
            <span class="empty-hint">Draft the next requirements below to queue the next brief.</span>
          </div>
          <p class="xs muted" style="margin: 0 0 var(--sp-2)">
            This queues the NEXT brief — once saved and newer than brief.md the project shows
            “next brief queued” (orange dot). Save &amp; launch refines it into a new brief.md, then auto-runs.
          </p>
          <textarea v-model="rawContent" class="textarea textarea-mono" style="width: 100%"
                    @input="draftChanged"
                    placeholder="## Next features&#10;&#10;- New feature A&#10;…"
                    aria-label="Next brief raw thoughts content"></textarea>
          <div class="row" style="margin-top: var(--sp-3)">
            <span v-if="launchLocked" class="xs" style="color: var(--ok)">✓ Already generated from these notes — edit to unlock launch</span>
            <button class="btn right" :disabled="!rawDirty || mutationLocked || busy(k('rawsave')) || launchBusy" @click="saveRaw">
              <span v-if="busy(k('rawsave'))" class="spinner"></span> Save draft
            </button>
            <button class="btn btn-primary"
                    :disabled="launchLocked || mutationLocked || launchBusy || busy(k('rawsave'))"
                    :title="mutationLocked ? 'Wait for active or queued project work to finish' : launchLocked ? 'Brief already generated — edit to unlock' : 'Save raw-thoughts, run brief agent, then auto-run'"
                    @click="saveAndLaunchRaw">
              <span v-if="launchBusy" class="spinner"></span>
              ▶ Save &amp; launch
            </button>
          </div>
        </template>
      </section>

      <!-- ── Card 3: brief queue ───────────────────────────────────────── -->
      <section class="card" aria-label="Brief queue">
        <div class="card-header">
          <span class="card-title">Brief queue</span>
          <span class="chip mono">{{ queue.length }}</span>
          <button class="btn btn-ghost btn-sm right" @click="loadQueue()" title="Refresh queue" aria-label="Refresh queue">↻</button>
          <button v-if="queue.length" class="btn btn-primary btn-sm"
                  :disabled="busy(k('chain')) || mutationLocked" @click="runChain"
                  :title="mutationLocked ? 'Wait for active or queued project work to finish' : 'Run every queued brief unattended, in order'">
            <span v-if="busy(k('chain'))" class="spinner"></span>
            🚀 Run queue ({{ queue.length }})
          </button>
        </div>

        <div v-if="queueLoading" class="col">
          <div class="skeleton" style="height: 34px"></div>
          <div class="skeleton" style="height: 34px"></div>
          <div class="skeleton" style="height: 34px"></div>
        </div>

        <div v-else-if="queueError" class="banner banner-err">
          {{ queueError }}
          <button class="btn btn-sm right" @click="loadQueue()">Retry</button>
        </div>

        <template v-else>
          <div v-if="!queue.length" class="empty">
            <span class="empty-icon">🗂</span>
            <span>Queue is empty</span>
            <span class="empty-hint">Add numbered briefs below — “Run queue” executes them one after another.</span>
          </div>

          <div v-else>
            <div v-for="(item, i) in queue" :key="item.filename" class="row"
                 style="padding: 7px 0; border-bottom: 1px solid var(--border)">
              <span class="xs muted mono nowrap" style="width: 22px; text-align: right">{{ i + 1 }}.</span>
              <span class="mono small nowrap">{{ item.filename }}</span>
              <span class="xs muted truncate grow">{{ truncate(item.preview) }}</span>
              <button class="btn btn-ghost btn-sm"
                      :disabled="busy(k('qdel-' + item.filename)) || mutationLocked"
                      :aria-label="'Delete ' + item.filename"
                      title="Delete from queue"
                      @click="removeFromQueue(item)">
                <span v-if="busy(k('qdel-' + item.filename))" class="spinner"></span>
                <span v-else>×</span>
              </button>
            </div>
          </div>

          <div class="col" style="margin-top: var(--sp-3); gap: var(--sp-2)">
            <div class="field">
              <span class="label">Filename</span>
              <input v-model="newFilename" class="input mono" style="max-width: 220px"
                     @input="onQueueFilenameInput"
                     placeholder="01-brief.md" aria-label="Queued brief filename">
            </div>
            <div class="field">
              <span class="label">Content</span>
              <textarea v-model="newContent" class="textarea textarea-mono" style="min-height: 120px"
                        @input="draftChanged"
                        placeholder="## Brief&#10;&#10;- What to build next…"
                        aria-label="Queued brief content"></textarea>
            </div>
            <div class="row">
              <button class="btn btn-primary right" :disabled="busy(k('qadd')) || mutationLocked" @click="addToQueue">
                <span v-if="busy(k('qadd'))" class="spinner"></span> Add to queue
              </button>
            </div>
          </div>
        </template>
      </section>

    </div>
  `,
};
