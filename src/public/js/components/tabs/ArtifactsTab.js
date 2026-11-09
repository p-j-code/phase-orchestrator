import { store } from '../../lib/store.js';
import { router } from '../../lib/router.js';
import { api } from '../../lib/api.js';
import { fmtAgo } from '../../lib/format.js';
import { renderMarkdown } from '../../lib/markdown.js';

const GROUP_ORDER = ['plan', 'brief', 'reviews', 'audits', 'reports', 'bug-rounds', 'handoffs', 'decisions', 'other'];
const GROUP_LABELS = {
  'plan': 'Plan',
  'brief': 'Brief',
  'reviews': 'Reviews',
  'audits': 'Audits',
  'reports': 'Reports',
  'bug-rounds': 'Bug rounds',
  'handoffs': 'Handoffs',
  'decisions': 'Decisions',
  'other': 'Other',
};

function toMs(mtime) {
  if (mtime == null) return 0;
  const t = typeof mtime === 'number' ? mtime : new Date(mtime).getTime();
  return isNaN(t) ? 0 : t;
}

export default {
  name: 'ArtifactsTab',
  data() {
    return {
      list: null,          // [{path, name, group, size, mtime}] | null before first load
      listLoading: false,
      listError: '',
      query: '',
      collapsed: {},       // group key → true when collapsed
      selectedPath: null,
      file: null,          // {path, content, mtime}
      fileLoading: false,
      fileError: '',
      cache: {},           // path → {path, content, mtime} for component lifetime
      listRequestId: 0,    // fences stale list responses across refresh/project changes
      fileRequestId: 0,    // fences stale viewer responses across rapid selections
    };
  },
  computed: {
    projectName() { return router.project; },
    now() { return store.state.now; },
    groups() {
      if (!this.list) return [];
      const query = this.query.trim().toLowerCase();
      const byKey = new Map();
      for (const f of this.list) {
        if (query && !String(f.path || f.name || '').toLowerCase().includes(query)) continue;
        const key = GROUP_ORDER.includes(f.group) ? f.group : 'other';
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(f);
      }
      return GROUP_ORDER
        .filter((k) => byKey.has(k))
        .map((k) => ({
          key: k,
          label: GROUP_LABELS[k] || k,
          items: byKey.get(k).slice().sort((a, b) => toMs(b.mtime) - toMs(a.mtime)),
        }));
    },
    viewerKind() {
      const p = this.selectedPath || '';
      if (p.endsWith('.md')) return 'md';
      if (p.endsWith('.jsonl')) return 'jsonl';
      if (p.endsWith('.json')) return 'json';
      return 'text';
    },
    renderedMd() {
      return this.file ? renderMarkdown(this.file.content) : '';
    },
    prettyContent() {
      const f = this.file;
      if (!f) return '';
      const content = f.content == null ? '' : String(f.content);
      if (this.viewerKind === 'json') {
        try { return JSON.stringify(JSON.parse(content), null, 2); }
        catch { return content; }
      }
      if (this.viewerKind === 'jsonl') {
        return content
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => {
            try { return JSON.stringify(JSON.parse(line), null, 2); }
            catch { return line; }
          })
          .join('\n\n');
      }
      return content;
    },
  },
  watch: {
    projectName() {
      this.listRequestId++;
      this.fileRequestId++;
      this.list = null;
      this.listLoading = false;
      this.listError = '';
      this.collapsed = {};
      this.selectedPath = null;
      this.file = null;
      this.fileLoading = false;
      this.fileError = '';
      this.cache = {};
      if (this.projectName) this.loadList();
    },
  },
  mounted() {
    if (this.projectName) this.loadList();
  },
  beforeUnmount() {
    this.listRequestId++;
    this.fileRequestId++;
  },
  methods: {
    fmtAgo,
    humanSize(bytes) {
      if (bytes == null || isNaN(bytes)) return '–';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    },
    toggleGroup(key) {
      this.collapsed[key] = !this.collapsed[key];
    },
    async loadList() {
      const project = this.projectName;
      if (!project) return;
      const requestId = ++this.listRequestId;
      this.listError = '';
      this.listLoading = true;
      try {
        const rows = await api('GET', '/projects/' + encodeURIComponent(project) + '/artifacts');
        if (requestId !== this.listRequestId || this.projectName !== project) return;
        this.list = Array.isArray(rows) ? rows : [];
      } catch (e) {
        if (requestId !== this.listRequestId || this.projectName !== project) return;
        this.listError = e.message;
      } finally {
        if (requestId === this.listRequestId && this.projectName === project) {
          this.listLoading = false;
        }
      }
    },
    selectFile(path) {
      this.selectedPath = path;
      this.loadFile(path);
    },
    async loadFile(path, { force = false } = {}) {
      const project = this.projectName;
      if (!project || !path) return;
      const requestId = ++this.fileRequestId;
      this.fileError = '';
      if (!force && this.cache[path]) {
        this.file = this.cache[path];
        this.fileLoading = false;
        return;
      }
      this.file = null;
      this.fileLoading = true;
      try {
        const r = await api('GET', '/projects/' + encodeURIComponent(project) +
          '/artifacts/file?path=' + encodeURIComponent(path));
        if (requestId !== this.fileRequestId || this.projectName !== project || this.selectedPath !== path) return;
        this.cache[path] = r;
        this.file = r;
      } catch (e) {
        if (requestId === this.fileRequestId && this.projectName === project && this.selectedPath === path) {
          this.fileError = e.message;
        }
      } finally {
        if (requestId === this.fileRequestId && this.projectName === project && this.selectedPath === path) {
          this.fileLoading = false;
        }
      }
    },
    refreshFile() {
      if (this.selectedPath) this.loadFile(this.selectedPath, { force: true });
    },
    retryFile() {
      if (this.selectedPath) this.loadFile(this.selectedPath, { force: true });
    },
    async copyFile() {
      if (!this.file) return;
      try {
        await navigator.clipboard.writeText(String(this.file.content || ''));
        store.toast('Artifact copied', 'ok');
      } catch {
        store.toast('Copy failed — clipboard permission was denied', 'err');
      }
    },
    downloadFile() {
      if (!this.file) return;
      const blob = new Blob([String(this.file.content || '')], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = (this.selectedPath || 'artifact.txt').split('/').pop() || 'artifact.txt';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    },
  },
  template: `
    <div v-if="projectName" class="artifacts-layout">

      <div class="card" style="padding: var(--sp-2)">
        <div class="row" style="padding: var(--sp-1) var(--sp-2) var(--sp-2)">
          <span class="card-title">Artifacts</span>
          <span v-if="list && list.length" class="chip">{{ list.length }}</span>
          <button class="btn btn-ghost btn-sm right" @click="loadList" :disabled="listLoading"
                  title="Refresh list" aria-label="Refresh artifact list">
            <span v-if="listLoading" class="spinner"></span><span v-else>↻</span>
          </button>
        </div>
        <input v-if="list && list.length" v-model="query" type="search" class="input input-sm artifact-search"
               placeholder="Search artifacts…" aria-label="Search artifacts">

        <div v-if="!list && !listError" class="col" style="padding: var(--sp-2)">
          <div class="skeleton" style="height: 34px"></div>
          <div class="skeleton" style="height: 34px"></div>
          <div class="skeleton" style="height: 34px"></div>
          <div class="skeleton" style="height: 34px"></div>
        </div>

        <div v-else-if="listError" class="banner banner-err" style="margin: var(--sp-2)">
          <span class="grow">{{ listError }}</span>
          <button class="btn btn-sm" @click="loadList">Retry</button>
        </div>

        <div v-else-if="!list.length" class="empty">
          <span class="empty-icon">▤</span>
          <span>No artifacts yet</span>
          <span class="empty-hint">They appear as the guide/dev agents produce plan, reviews, audits…</span>
        </div>

        <div v-else-if="query && !groups.length" class="empty">
          <span class="empty-icon">⌕</span>
          <span>No matching artifacts</span>
          <button class="btn btn-sm" @click="query = ''">Clear search</button>
        </div>

        <div v-else class="scroll-y" style="max-height: 70vh">
          <div v-for="g in groups" :key="g.key">
            <button class="row" style="width: 100%; padding: 6px 8px; text-align: left"
                    @click="toggleGroup(g.key)"
                    :aria-expanded="!collapsed[g.key] ? 'true' : 'false'">
              <span class="label">{{ collapsed[g.key] ? '▸' : '▾' }} {{ g.label }}</span>
              <span class="chip right">{{ g.items.length }}</span>
            </button>
            <template v-if="!collapsed[g.key]">
              <button v-for="f in g.items" :key="f.path" class="proj-row"
                      :class="{'proj-row-active': selectedPath === f.path}"
                      @click="selectFile(f.path)" :title="f.path"
                      :aria-pressed="selectedPath === f.path">
                <div class="row" style="width: 100%">
                  <span class="truncate grow">{{ f.name }}</span>
                  <span class="xs muted nowrap">{{ humanSize(f.size) }}</span>
                </div>
                <div class="xs muted" style="margin-top: 2px">{{ fmtAgo(f.mtime, now) }}</div>
              </button>
            </template>
          </div>
        </div>
      </div>

      <div class="card">
        <div v-if="!selectedPath" class="empty">
          <span class="empty-icon">☰</span>
          <span>Select a file</span>
          <span class="empty-hint">Pick an artifact from the list to view it here</span>
        </div>

        <template v-else>
          <div class="card-header">
            <span class="chip mono truncate" :title="selectedPath">{{ selectedPath }}</span>
            <span v-if="file" class="xs muted nowrap">{{ fmtAgo(file.mtime, now) }}</span>
            <button v-if="file" class="btn btn-ghost btn-sm" @click="copyFile" title="Copy artifact" aria-label="Copy artifact">Copy</button>
            <button v-if="file" class="btn btn-ghost btn-sm" @click="downloadFile" title="Download artifact" aria-label="Download artifact">Download</button>
            <button class="btn btn-ghost btn-sm right" @click="refreshFile" :disabled="fileLoading"
                    title="Refresh file" aria-label="Refresh file">
              <span v-if="fileLoading" class="spinner"></span><span v-else>↻</span>
            </button>
          </div>

          <div v-if="fileLoading && !file" class="col">
            <div class="skeleton" style="height: 16px; width: 60%"></div>
            <div class="skeleton" style="height: 16px; width: 90%"></div>
            <div class="skeleton" style="height: 16px; width: 75%"></div>
            <div class="skeleton" style="height: 16px; width: 85%"></div>
            <div class="skeleton" style="height: 16px; width: 40%"></div>
          </div>

          <div v-else-if="fileError" class="banner banner-err">
            <span class="grow">{{ fileError }}</span>
            <button class="btn btn-sm" @click="retryFile">Retry</button>
          </div>

          <template v-else-if="file">
            <div v-if="viewerKind === 'md'" class="md scroll-y" style="max-height: 70vh" v-html="renderedMd"></div>
            <div v-else class="term" style="max-height: 70vh">{{ prettyContent }}</div>
          </template>
        </template>
      </div>

    </div>
  `,
};
