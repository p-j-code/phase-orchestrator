// ChatView — the control-plane chat: talk to the orchestrator agent, which can
// inspect every project and start work through its MCP control tools. Threads
// persist server-side (chat_threads); each send uses SSE streaming to show
// live tool-use events, with long-poll fallback.

import { store } from '../lib/store.js';
import { api, getToken } from '../lib/api.js';
import { renderMarkdown } from '../lib/markdown.js';
import { focusContained, handleContainedKey, isolateForOverlay } from '../lib/modal-a11y.js';

const QUICK_PROMPTS = [
  { label: 'What\'s running?', text: 'What\'s actively running right now across all projects? Show phases in progress, queued work, and anything that needs my attention.' },
  { label: 'Status', text: 'Give me a one-line status for every project — flag anything paused, failed, or waiting on me.' },
  { label: 'Run dev', text: 'Run dev on {p}.' },
  { label: 'Next phase', text: 'Run just the next phase of {p}.' },
  { label: 'Brief → run all', text: 'I have these features for {p}: \n- \n- \nQueue brief(s) for them and run the whole chain.' },
  { label: 'Log a bug', text: 'Bug in {p}: ' },
  { label: 'Audit & fix', text: 'Audit {p} and auto-fix what it finds until clean.' },
  { label: 'Discuss', text: 'Run a multi-agent discussion on {p} about: ' },
  { label: 'What next?', text: 'Scan {p} and suggest what we should improve or build next.' },
];

const LS_PROJECT = 'chatProject';
const LS_MODEL = 'chatModelTier';
const LS_COMPOSERS = 'chatComposerDraftsV1';
const LS_UPLOAD_GC = 'chatUploadCleanupV1';
const NEW_COMPOSER_KEY = 'new';
const MAX_PERSISTED_DRAFT_CHARS = 100000;

function emptyComposer() {
  return { input: '', pendingFiles: [], messageQueue: [] };
}

export default {
  name: 'ChatView',
  data() {
    return {
      threads: [],
      threadsLoaded: false,
      activeId: null,
      messages: [],
      busy: false,
      input: '',
      project: '',
      sending: false,
      preparing: false,
      stopping: false,
      uploading: false,
      pendingFiles: [],  // [{name (stored), size, label (original), previewUrl?}]
      loadError: '',
      showThreads: false,
      threadDrawerMobile: false,
      threadDrawerReturnFocus: null,
      restoreThreadDrawerIsolation: null,
      abortCtrl: null,
      messageQueue: [],
      composerKey: NEW_COMPOSER_KEY,
      composerStates: {},
      unconfirmedSends: {}, // composer key -> text awaiting an accepted HTTP response
      inFlightFiles: [],   // retained until the server accepts ownership
      modelTier: 'auto',
      lastModel: null,
      searchQuery: '',
      renamingId: null,
      renameText: '',
      streamEvents: [],  // live tool names during a streaming turn
      threadsRequestId: 0,
      openRequestId: 0,
      openingId: null,
    };
  },
  computed: {
    projects() { return store.state.projects; },
    activeThread() { return this.threads.find((t) => t.id === this.activeId) || null; },
    quickPrompts() { return QUICK_PROMPTS; },
    hasInput() { return this.input.trim().length > 0; },
    isWorking() { return this.sending || this.busy || this.preparing; },
    canSend() { return !this.isWorking && this.openingId == null && !this.stopping && !this.uploading && this.hasInput; },
    workStatus() {
      if (this.stopping) return 'Stopping current turn…';
      if (this.preparing) return 'Preparing chat…';
      if (this.sending || this.busy) return 'Working…';
      return '';
    },
    assistantLabel() {
      if (this.project === '__self__') return '⚙ Orchestrator';
      if (this.project) return '⚙ ' + this.project;
      return '⚙ control';
    },
    filteredThreads() {
      const q = this.searchQuery.trim().toLowerCase();
      if (!q) return this.threads;
      return this.threads.filter((t) =>
        (t.title || '').toLowerCase().includes(q) ||
        (t.project || '').toLowerCase().includes(q)
      );
    },
    lastStreamEvent() {
      return this.streamEvents[this.streamEvents.length - 1] || null;
    },
  },
  watch: {
    project(val) { try { localStorage.setItem(LS_PROJECT, val); } catch { /* ignore */ } },
    modelTier(val) { try { localStorage.setItem(LS_MODEL, val); } catch { /* ignore */ } },
    showThreads(value, oldValue) {
      if (!this.threadDrawerMobile || value === oldValue) return;
      if (value) this.$nextTick(() => this.activateThreadDrawer());
      else this.deactivateThreadDrawer();
    },
  },
  async mounted() {
    this.threadDrawerQuery = window.matchMedia('(max-width: 900px)');
    this.onThreadViewportChange(this.threadDrawerQuery);
    this.threadDrawerQuery.addEventListener?.('change', this.onThreadViewportChange);
    try {
      const p = localStorage.getItem(LS_PROJECT);
      const m = localStorage.getItem(LS_MODEL);
      if (p !== null) this.project = p;
      if (m !== null) this.modelTier = m;
    } catch { /* ignore */ }
    this._loadPersistedComposers();
    this._activateComposer(null, { saveCurrent: false });
    void this._drainUploadCleanup();

    this._keyHandler = (e) => {
      if (!this.showThreads && e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        this.$refs.box?.focus();
      }
    };
    document.addEventListener('keydown', this._keyHandler);

    await this.loadThreads();
    if (this.threads.length) await this.open(this.threads[0].id);

    // Pick up context injected by the terminal "Open in Chat" button
    const ctx = store.state.terminalChatContext;
    if (ctx) {
      store.state.terminalChatContext = null;
      this._stopBusyPoll();
      this._revokeMessagePreviews(this.messages);
      this._activateComposer(null);
      if (ctx.project) this.project = ctx.project;
      if (ctx.prefill) {
        this.input = this.input.trim() ? `${this.input}\n\n${ctx.prefill}` : ctx.prefill;
        this._saveCurrentComposer();
      }
      this.messages = [];
      this.busy = false;
    }
  },
  beforeUnmount() {
    this._unmounted = true;
    this.threadsRequestId++;
    this.openRequestId++;
    if (this._keyHandler) document.removeEventListener('keydown', this._keyHandler);
    this.threadDrawerQuery?.removeEventListener?.('change', this.onThreadViewportChange);
    this.deactivateThreadDrawer({ restoreFocus: false });
    this._stopBusyPoll();
    this._saveCurrentComposer();
    this._revokeMessagePreviews(this.messages);
    void this._discardFiles(this._allComposerFiles(), { quiet: true });
  },
  methods: {
    md(text) { return renderMarkdown(text); },

    onThreadViewportChange(event) {
      const nextMobile = !!event.matches;
      if (this.threadDrawerMobile && !nextMobile) this.deactivateThreadDrawer({ restoreFocus: false });
      this.threadDrawerMobile = nextMobile;
      if (!this.threadDrawerMobile && this.showThreads) this.showThreads = false;
      else if (this.showThreads) this.$nextTick(() => this.activateThreadDrawer());
    },

    openThreadDrawer(event) {
      this.threadDrawerReturnFocus = event?.currentTarget || document.activeElement;
      this.showThreads = true;
    },

    closeThreadDrawer() { this.showThreads = false; },

    activateThreadDrawer() {
      if (!this.threadDrawerMobile || !this.showThreads || this.restoreThreadDrawerIsolation) return;
      if (!this.threadDrawerReturnFocus) this.threadDrawerReturnFocus = document.activeElement;
      this.restoreThreadDrawerIsolation = isolateForOverlay([
        document.querySelector('.app-header'),
        document.getElementById('project-sidebar'),
        this.$refs.chatMain,
      ]);
      focusContained(this.$refs.threadList, this.$refs.threadSearch);
    },

    deactivateThreadDrawer({ restoreFocus = true } = {}) {
      this.restoreThreadDrawerIsolation?.();
      this.restoreThreadDrawerIsolation = null;
      const target = this.threadDrawerReturnFocus;
      this.threadDrawerReturnFocus = null;
      if (restoreFocus && target?.isConnected) {
        this.$nextTick(() => target.focus?.({ preventScroll: true }));
      }
    },

    onThreadDrawerKey(event) {
      if (!this.threadDrawerMobile || !this.showThreads) return;
      event.stopPropagation();
      handleContainedKey(this.$refs.threadList, event, { onEscape: this.closeThreadDrawer });
    },

    _composerKeyFor(id) {
      return id == null ? NEW_COMPOSER_KEY : `thread:${Number(id)}`;
    },

    _ensureComposer(key) {
      if (!this.composerStates[key]) this.composerStates[key] = emptyComposer();
      return this.composerStates[key];
    },

    _saveCurrentComposer({ persist = true } = {}) {
      if (!this.composerKey) return;
      // Mutate the stable state object rather than replacing it. In-flight
      // uploads hold this identity so they can distinguish a switched thread
      // (still valid) from a composer that was actually deleted.
      const state = this._ensureComposer(this.composerKey);
      state.input = String(this.input || '');
      state.pendingFiles = this.pendingFiles;
      state.messageQueue = this.messageQueue;
      if (persist) this._persistComposerTexts();
    },

    _activateComposer(id, { saveCurrent = true } = {}) {
      if (saveCurrent) this._saveCurrentComposer();
      const key = this._composerKeyFor(id);
      const state = this._ensureComposer(key);
      this.activeId = id == null ? null : Number(id);
      this.composerKey = key;
      this.input = state.input;
      this.pendingFiles = state.pendingFiles;
      this.messageQueue = state.messageQueue;
    },

    _adoptNewComposer(threadId) {
      this._saveCurrentComposer({ persist: false });
      const targetKey = this._composerKeyFor(threadId);
      const state = this._ensureComposer(NEW_COMPOSER_KEY);
      delete this.composerStates[NEW_COMPOSER_KEY];
      this.composerStates[targetKey] = state;
      this.activeId = Number(threadId);
      this.composerKey = targetKey;
      this.input = state.input;
      this.pendingFiles = state.pendingFiles;
      this.messageQueue = state.messageQueue;
      this._persistComposerTexts();
    },

    _confirmAcceptedSend(key, files = []) {
      delete this.unconfirmedSends[key];
      this.inFlightFiles = [];
      const accepted = new Set(files.map((f) => f?.name).filter(Boolean));
      if (accepted.size) {
        this._writeUploadCleanup(this._readUploadCleanup().filter((name) => !accepted.has(name)));
      }
      this._persistComposerTexts();
    },

    _restoreUnacceptedSend(key, message, files, optimisticId) {
      // The server never accepted ownership, so return the exact text/upload
      // pair to its originating composer. If the operator already started a
      // new draft while the request was in flight, park the failed send as a
      // review-only queue item rather than merging attachments into that draft.
      const state = this._ensureComposer(key);
      const canRestoreDraft = !String(state.input || '').trim() && !(state.pendingFiles || []).length;
      if (canRestoreDraft) {
        state.input = message;
        state.pendingFiles = [...files];
      } else {
        state.messageQueue.unshift({ text: message, files: [...files], restored: true });
      }

      delete this.unconfirmedSends[key];
      this.inFlightFiles = [];
      if (this.composerKey === key) {
        this.input = state.input;
        this.pendingFiles = state.pendingFiles;
        this.messageQueue = state.messageQueue;
      }
      this.messages = this.messages.filter((item) => item.id !== optimisticId);
      this._persistComposerTexts();
    },

    _persistComposerTexts() {
      try {
        const payload = {};
        for (const [key, state] of Object.entries(this.composerStates)) {
          if (key !== NEW_COMPOSER_KEY && !/^thread:\d+$/.test(key)) continue;
          const input = String(state?.input || '').slice(0, MAX_PERSISTED_DRAFT_CHARS);
          const queue = (state?.messageQueue || [])
            .map((q) => String(q?.text || '').trim().slice(0, MAX_PERSISTED_DRAFT_CHARS))
            .filter(Boolean);
          const recovery = String(this.unconfirmedSends[key] || '')
            .trim().slice(0, MAX_PERSISTED_DRAFT_CHARS);
          if (input || queue.length || recovery) payload[key] = { input, queue, recovery };
        }
        if (Object.keys(payload).length) localStorage.setItem(LS_COMPOSERS, JSON.stringify(payload));
        else localStorage.removeItem(LS_COMPOSERS);
      } catch { /* storage may be unavailable/full — in-memory isolation still works */ }
    },

    _loadPersistedComposers() {
      let parsed = null;
      try { parsed = JSON.parse(localStorage.getItem(LS_COMPOSERS) || 'null'); }
      catch { /* malformed storage is ignored */ }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      for (const [key, raw] of Object.entries(parsed)) {
        if (key !== NEW_COMPOSER_KEY && !/^thread:\d+$/.test(key)) continue;
        const input = typeof raw?.input === 'string'
          ? raw.input.slice(0, MAX_PERSISTED_DRAFT_CHARS) : '';
        const queue = Array.isArray(raw?.queue) ? raw.queue : [];
        const recovery = typeof raw?.recovery === 'string' && raw.recovery.trim()
          ? [raw.recovery.slice(0, MAX_PERSISTED_DRAFT_CHARS)] : [];
        this.composerStates[key] = {
          input,
          pendingFiles: [],
          // Restored follow-ups are visible/editable but never enter the
          // automatic post-turn flush until the operator reviews them.
          messageQueue: [...recovery, ...queue]
            .filter((text) => typeof text === 'string' && text.trim())
            .map((text) => ({
              text: text.slice(0, MAX_PERSISTED_DRAFT_CHARS),
              files: [],
              restored: true,
            })),
        };
      }
    },

    _allComposerFiles() {
      const files = [];
      for (const state of Object.values(this.composerStates)) {
        files.push(...(state?.pendingFiles || []));
        for (const queued of state?.messageQueue || []) files.push(...(queued.files || []));
      }
      files.push(...this.inFlightFiles);
      return files;
    },

    async _dropComposer(key, { cleanupFiles = true } = {}) {
      const state = this.composerStates[key];
      if (!state) return;
      const files = [
        ...(state.pendingFiles || []),
        ...(state.messageQueue || []).flatMap((q) => q.files || []),
      ];
      delete this.composerStates[key];
      delete this.unconfirmedSends[key];
      this._persistComposerTexts();
      if (cleanupFiles) await this._discardFiles(files, { quiet: true });
    },

    _readUploadCleanup() {
      try {
        const parsed = JSON.parse(localStorage.getItem(LS_UPLOAD_GC) || '[]');
        return Array.isArray(parsed) ? parsed.filter((name) => typeof name === 'string' && name) : [];
      } catch { return []; }
    },

    _writeUploadCleanup(names) {
      try {
        const unique = [...new Set(names)];
        if (unique.length) localStorage.setItem(LS_UPLOAD_GC, JSON.stringify(unique));
        else localStorage.removeItem(LS_UPLOAD_GC);
      } catch { /* best effort */ }
    },

    _queueUploadCleanup(files) {
      const names = (files || []).map((f) => f?.name).filter(Boolean);
      if (names.length) this._writeUploadCleanup([...this._readUploadCleanup(), ...names]);
    },

    _markUploadCleaned(name) {
      this._writeUploadCleanup(this._readUploadCleanup().filter((item) => item !== name));
    },

    async _drainUploadCleanup() {
      await Promise.all(this._readUploadCleanup().map(async (name) => {
        try {
          await api('DELETE', `/chat/uploads/${encodeURIComponent(name)}`);
          this._markUploadCleaned(name);
        } catch { /* retry after the next authenticated mount */ }
      }));
    },

    async loadThreads() {
      const requestId = ++this.threadsRequestId;
      try {
        const rows = await api('GET', '/chat/threads');
        if (requestId !== this.threadsRequestId || this._unmounted) return;
        this.threads = Array.isArray(rows) ? rows : [];
        this.loadError = '';
      } catch (e) {
        if (requestId !== this.threadsRequestId || this._unmounted) return;
        this.loadError = e.message;
      }
      if (requestId === this.threadsRequestId && !this._unmounted) this.threadsLoaded = true;
    },

    async open(id) {
      if (this.sending || this.preparing || this.stopping) return;
      const requestId = ++this.openRequestId;
      this.openingId = Number(id);
      this._stopBusyPoll();
      this.showThreads = false;
      this.renamingId = null;
      try {
        const r = await api('GET', `/chat/threads/${id}`);
        if (requestId !== this.openRequestId || this._unmounted) return;
        this._revokeMessagePreviews(this.messages);
        this._activateComposer(id);
        this.messages = r.messages || [];
        this.busy = !!r.busy;
        this.project = r.thread?.project || '';
        const isIssue = (r.thread?.title || '').startsWith('Issue: ');
        const hasUserMsg = this.messages.some((m) => m.role === 'user');
        if (isIssue && !hasUserMsg && !this.input.trim()) {
          this.input = 'Fix this issue.';
          this._saveCurrentComposer();
        }
        this.scrollDown();
        this._startBusyPoll();
        if (!this.busy) await this._flushQueue();
      } catch (e) {
        if (requestId === this.openRequestId && !this._unmounted) {
          store.toast('Open thread: ' + e.message, 'err');
          this._startBusyPoll();
        }
      } finally {
        if (requestId === this.openRequestId) this.openingId = null;
      }
    },

    newThread() {
      if (this.sending || this.preparing || this.stopping) return;
      this.openRequestId++;
      this.openingId = null;
      this._stopBusyPoll();
      this._revokeMessagePreviews(this.messages);
      this._activateComposer(null);
      this.messages = [];
      this.busy = false;
      this.stopping = false;
      this.renamingId = null;
    },

    async removeThread(id) {
      const yes = await store.confirmAction({
        title: 'Delete chat thread?',
        body: 'The conversation history will be removed.',
        danger: true,
        confirmLabel: 'Delete',
      });
      if (yes) await this.doRemove(id);
    },

    async doRemove(id) {
      try {
        await api('DELETE', `/chat/threads/${id}`);
        this.threads = this.threads.filter((t) => t.id !== id);
        const key = this._composerKeyFor(id);
        if (this.activeId === id) this.newThread();
        await this._dropComposer(key);
      } catch (e) {
        store.toast('Delete: ' + e.message, 'err');
      }
    },

    startRename(t) {
      this.renamingId = t.id;
      this.renameText = t.title || '';
      this.$nextTick(() => this.$refs[`rename-${t.id}`]?.[0]?.select());
    },

    async finishRename(t) {
      const title = this.renameText.trim();
      this.renamingId = null;
      if (!title || title === t.title) return;
      try {
        await api('PATCH', `/chat/threads/${t.id}`, { title });
        t.title = title;
      } catch (e) {
        store.toast('Rename: ' + e.message, 'err');
      }
    },

    cancelRename() { this.renamingId = null; },

    onRenameKey(e, t) {
      if (e.key === 'Enter') { e.preventDefault(); this.finishRename(t); }
      if (e.key === 'Escape') this.cancelRename();
    },

    useQuick(q) {
      const p = this.project || store.state.projects[0]?.name || '<project>';
      const text = q.text.replaceAll('{p}', p);
      this.input = this.input.trim() ? `${this.input}\n\n${text}` : text;
      this._saveCurrentComposer();
      this.$refs.box?.focus();
    },

    onKeydown(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.send();
      }
    },

    onComposerInput(e) {
      // Use the event value explicitly so persistence never depends on the
      // ordering of Vue's native v-model handler and this listener.
      if (typeof e?.target?.value === 'string') this.input = e.target.value;
      this._saveCurrentComposer();
    },

    attachmentsOf(m) {
      try { return JSON.parse(m.meta_json || '{}').attachments || m._attachments || []; }
      catch { return m._attachments || []; }
    },

    pickFiles() { this.$refs.file?.click(); },

    // Uploads and streaming turns use binary/SSE bodies, so they cannot go
    // through api(). Keep their auth behavior identical: a 401 logs out and
    // returns the operator to the token screen instead of looking like a
    // generic upload or chat failure.
    async _authFetch(url, options = {}) {
      const headers = { ...(options.headers || {}) };
      const token = getToken();
      if (token) headers.Authorization = 'Bearer ' + token;
      let resp;
      try {
        resp = await fetch(url, { ...options, headers });
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        throw new Error('Cannot reach server');
      }
      if (resp.status === 401) {
        store.logout(true);
        throw new Error('Unauthorized');
      }
      return resp;
    },

    async onFiles(e) {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      if (!files.length) return;
      // Uploads may finish after the operator switches threads. Keep a stable
      // reference to the composer that initiated this batch so a late result
      // can never be attached to whichever thread happens to be visible then.
      const originKey = this.composerKey;
      const originComposer = this._ensureComposer(originKey);
      this.uploading = true;
      for (const f of files) {
        try {
          const resp = await this._authFetch('/api/chat/uploads?filename=' + encodeURIComponent(f.name), {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: f,
          });
          const data = await resp.json();
          if (!resp.ok) throw new Error(data.error || `Upload failed (${resp.status})`);
          const isImage = /\.(png|jpe?g|gif|webp)$/i.test(f.name);
          const previewUrl = isImage ? URL.createObjectURL(f) : null;
          const stored = { name: data.name, size: data.size, label: f.name, previewUrl };
          // Treat every completed upload as unsent until a message request is
          // accepted. This durable cleanup ledger also covers hard reloads,
          // where Vue unmount hooks are not guaranteed to run.
          this._queueUploadCleanup([stored]);
          if (this._unmounted || this.composerStates[originKey] !== originComposer) {
            await this._discardFiles([stored], { quiet: true });
          }
          else {
            originComposer.pendingFiles.push(stored);
            this._persistComposerTexts();
          }
        } catch (err) {
          store.toast(`Upload ${f.name}: ${err.message}`, 'err');
          if (err.message === 'Unauthorized') break;
        }
      }
      this.uploading = false;
    },

    async removePending(i) {
      const [f] = this.pendingFiles.splice(i, 1);
      this._saveCurrentComposer();
      if (f) await this._discardFiles([f]);
    },

    _revokeFiles(files) {
      for (const f of files || []) {
        if (f?.previewUrl) {
          URL.revokeObjectURL(f.previewUrl);
          f.previewUrl = null;
        }
      }
    },

    _revokeMessagePreviews(messages) {
      for (const m of messages || []) {
        for (const url of m?._previews || []) {
          if (url) URL.revokeObjectURL(url);
        }
      }
    },

    async _discardFiles(files, { quiet = false } = {}) {
      const unique = [...new Map((files || []).filter((f) => f?.name).map((f) => [f.name, f])).values()];
      this._queueUploadCleanup(unique);
      this._revokeFiles(unique);
      await Promise.all(unique.map(async (f) => {
        try {
          await api('DELETE', `/chat/uploads/${encodeURIComponent(f.name)}`);
          this._markUploadCleaned(f.name);
        } catch (err) {
          if (!quiet && err.message !== 'Unauthorized') {
            store.toast(`Remove upload ${f.label || f.name}: ${err.message}`, 'warn');
          }
        }
      }));
    },

    editMsg(m) {
      if (this.input.trim() || this.pendingFiles.length) {
        store.toast('Review or clear the current draft before editing another message.', 'warn');
        return;
      }
      this.input = m.content;
      this._saveCurrentComposer();
      this.$nextTick(() => this.$refs.box?.focus());
    },

    async copyMsg(content) {
      try {
        await navigator.clipboard.writeText(content);
        store.toast('Copied', 'ok');
      } catch {
        store.toast('Copy failed', 'err');
      }
    },

    async stopSend() {
      if ((!this.sending && !this.busy) || !this.activeId || this.stopping) return;
      this.stopping = true;
      await this.clearQueue();
      try {
        let result = null;
        // The Stop click can race the message request by a few milliseconds.
        // Retry only the idempotent not_busy response while our request is
        // still live so Stop cannot miss a turn that is just acquiring its
        // server-side lock.
        for (let attempt = 0; attempt < 4; attempt += 1) {
          result = await api('POST', `/chat/threads/${this.activeId}/cancel`, {});
          if (result?.cancelled || result?.reason !== 'not_busy' || !this.sending) break;
          await new Promise((resolve) => setTimeout(resolve, 125));
        }
        if (!result?.cancelled) {
          this.stopping = false;
          if (result?.reason === 'owned_by_another_process') {
            store.toast('This turn is owned by another orchestrator process and cannot be stopped here.', 'warn');
          } else {
            await this._pollBusy();
          }
          return;
        }
        store.toast('Stop requested — waiting for the current tool/process to exit.', 'ok');
        this._startBusyPoll();
      } catch (err) {
        this.stopping = false;
        store.toast('Stop chat: ' + err.message, 'err');
      }
    },

    async clearQueue() {
      const queued = this.messageQueue.splice(0);
      this._saveCurrentComposer();
      await this._discardFiles(queued.flatMap((q) => q.files || []), { quiet: true });
    },

    async _flushQueue() {
      if (!this.messageQueue.length || this.sending || this.busy || this.stopping || this.uploading) return;
      // Never overwrite a newer draft or attachment selection just because an
      // earlier queued item became runnable in the background.
      if (this.input.trim() || this.pendingFiles.length) return;
      // Reloaded follow-ups represent operator text, not renewed permission to
      // act. They stay parked until explicitly moved back to the composer.
      if (this.messageQueue[0]?.restored) return;
      const next = this.messageQueue.shift();
      this.input = next.text;
      this.pendingFiles = next.files || [];
      this._saveCurrentComposer();
      await this.send();
    },

    reviewQueued(i) {
      if (this.input.trim() || this.pendingFiles.length) {
        store.toast('Review or clear the current draft before opening a queued message.', 'warn');
        return;
      }
      const [queued] = this.messageQueue.splice(i, 1);
      if (!queued) return;
      this.input = queued.text || '';
      this.pendingFiles = queued.files || [];
      this._saveCurrentComposer();
      this.$nextTick(() => this.$refs.box?.focus());
    },

    _stopBusyPoll() {
      if (this._busyPollTimer) clearTimeout(this._busyPollTimer);
      this._busyPollTimer = null;
    },

    _startBusyPoll() {
      this._stopBusyPoll();
      if (!this.activeId || (!this.busy && !this.stopping)) return;
      this._busyPollTimer = setTimeout(async () => {
        this._busyPollTimer = null;
        await this._pollBusy();
        if (this.busy || this.stopping) this._startBusyPoll();
      }, 1500);
    },

    async _pollBusy() {
      const id = this.activeId;
      if (!id || this.sending || this._pollingBusy) return;
      this._pollingBusy = true;
      try {
        const r = await api('GET', `/chat/threads/${id}`);
        if (this.activeId !== id) return;
        const wasBusy = this.busy;
        this.busy = !!r.busy;
        if (!this.busy) this.stopping = false;
        this._revokeMessagePreviews(this.messages);
        this.messages = r.messages || [];
        const idx = this.threads.findIndex((t) => t.id === id);
        if (idx !== -1 && r.thread) this.threads.splice(idx, 1, { ...this.threads[idx], ...r.thread });
        this.scrollDown();
        if (wasBusy && !this.busy) {
          await this.loadThreads();
          await this._flushQueue();
        }
      } catch (err) {
        if (err.message !== 'Unauthorized') this.loadError = `Chat refresh: ${err.message}`;
      } finally {
        this._pollingBusy = false;
      }
    },

    async send() {
      if (!this.input.trim()) return;

      if (this.preparing || this.openingId != null || this.stopping || this.uploading) return;

      if (this.sending || this.busy) {
        this.messageQueue.push({ text: this.input.trim(), files: [...this.pendingFiles] });
        this.input = '';
        this.pendingFiles = [];
        this._saveCurrentComposer();
        return;
      }

      // Create a new thread before opening the streaming request. This gives
      // Stop a stable server-side id from the first provider call onward.
      if (!this.activeId) {
        this.preparing = true;
        try {
          const created = await api('POST', '/chat/threads', {
            project: this.project || null,
            title: this.input.trim().slice(0, 64),
          });
          this._adoptNewComposer(created.id);
          await this.loadThreads();
        } catch (err) {
          store.toast('Create chat: ' + err.message, 'err');
          return;
        } finally {
          this.preparing = false;
        }
      }

      const message = this.input.trim();
      const sendKey = this.composerKey;
      const sentFiles = [...this.pendingFiles];
      const attachments = sentFiles.map((f) => f.name);
      const attachLabels = sentFiles.map((f) => f.label);
      const attachPreviews = sentFiles.map((f) => f.previewUrl || null);
      // Keep an uncertain send in local storage until the server has accepted
      // the request. A 401 can unmount this component synchronously; on the
      // next login the text returns as a review-only queued item.
      this.unconfirmedSends[sendKey] = message;
      this.inFlightFiles = sentFiles;
      this.input = '';
      this.pendingFiles = [];
      this._saveCurrentComposer();
      this.sending = true;
      this.busy = true;
      this.streamEvents = [];

      const optimisticId = `tmp-u-${Date.now()}`;
      this.messages.push({
        id: optimisticId, role: 'user', content: message,
        created_at: new Date().toISOString(),
        _attachments: attachLabels, _previews: attachPreviews,
      });
      this.scrollDown();

      const ctrl = new AbortController();
      this.abortCtrl = ctrl;
      const url = `/api/chat/threads/${this.activeId}/messages`;
      const body = { message, project: this.project || null, attachments, modelTier: this.modelTier };
      let turnCompleted = false;
      let authExpired = false;
      let requestAccepted = false;

      try {
        const resp = await this._authFetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });

        if (!resp.ok) {
          const d = await resp.json().catch(() => ({}));
          throw new Error(d.error || `Request failed (${resp.status})`);
        }
        this._confirmAcceptedSend(sendKey, sentFiles);
        requestAccepted = true;

        let r;
        if (resp.headers.get('content-type')?.includes('text/event-stream')) {
          r = await this._readSSE(resp);
        } else {
          r = await resp.json();
        }

        if (r.threadId != null) this.activeId = Number(r.threadId);
        turnCompleted = true;
        if (r.model) this.lastModel = r.model;
        this.messages.push({
          id: `tmp-a-${Date.now()}`,
          role: (r.error || r.cancelled) ? 'system' : 'assistant',
          content: r.reply || (r.cancelled ? 'Turn stopped by operator.' : '(no response)'),
          created_at: new Date().toISOString(),
          _model: r.model || null,
        });
        await this.loadThreads();
      } catch (e) {
        if (!requestAccepted) {
          this._restoreUnacceptedSend(sendKey, message, sentFiles, optimisticId);
        }
        authExpired = e.message === 'Unauthorized';
        if (e.name !== 'AbortError' && !authExpired && !this._unmounted) {
          this.messages.push({ id: `tmp-e-${Date.now()}`, role: 'system', content: '⚠ ' + e.message, created_at: new Date().toISOString() });
        }
      }
      this.abortCtrl = null;
      this.sending = false;
      this.stopping = false;
      this.streamEvents = [];
      if (turnCompleted) {
        this.busy = false;
      } else if (!authExpired && !this._unmounted) {
        // A lost browser stream does not imply a stopped provider turn. Ask
        // the server, then keep polling/showing Stop until the lock clears.
        await this._pollBusy();
        if (this.busy) this._startBusyPoll();
      } else {
        this.busy = false;
      }
      if (!this._unmounted && !authExpired) {
        this.scrollDown();
        await this._flushQueue();
      }
    },

    async _readSSE(resp) {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let result = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop();
        for (const chunk of chunks) {
          const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          try {
            const ev = JSON.parse(dataLine.slice(6));
            if (ev.type === 'tool_use') {
              this.streamEvents.push(ev.name);
              this.scrollDown();
            } else if (ev.type === 'done' || ev.type === 'error') {
              result = ev;
            }
          } catch { /* malformed */ }
        }
      }
      return result || { reply: '(no response)', error: true };
    },

    scrollDown() {
      this.$nextTick(() => {
        const el = this.$refs.scroll;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },

    threadLabel(t) { return t.title || `Thread #${t.id}`; },

    modelShortName(modelId) {
      if (!modelId) return '';
      if (/haiku/i.test(modelId)) return 'haiku';
      if (/sonnet/i.test(modelId)) return 'sonnet';
      if (/opus/i.test(modelId)) return 'opus';
      if (/fable/i.test(modelId)) return 'fable';
      return modelId.split('-').slice(-1)[0];
    },
  },
  template: `
    <div class="chat-layout">
      <button v-if="showThreads" type="button" class="chat-thread-scrim" style="border:0" @click="closeThreadDrawer" aria-label="Close chat list"></button>

      <!-- Thread list -->
      <aside id="chat-thread-list" ref="threadList" class="card chat-threads" :class="{'chat-threads-mobile-open': showThreads}" aria-label="Chat threads"
             :role="threadDrawerMobile ? 'dialog' : 'navigation'" :aria-modal="threadDrawerMobile && showThreads ? 'true' : null"
             :inert="threadDrawerMobile && !showThreads ? '' : null" :aria-hidden="threadDrawerMobile && !showThreads ? 'true' : null"
             @keydown="onThreadDrawerKey">
        <div class="card-header">
          <span class="card-title">Chats</span>
          <button type="button" class="btn btn-ghost btn-sm only-mobile" style="margin-right: auto; margin-left: var(--sp-1)" @click="closeThreadDrawer" title="Close" aria-label="Close chat list">✕</button>
          <button type="button" class="btn btn-sm right" @click="newThread" :disabled="sending || preparing || stopping">＋ New</button>
        </div>
        <div style="padding: var(--sp-2) var(--sp-2) 0">
          <input ref="threadSearch" v-model="searchQuery" class="input chat-search" placeholder="Search chats…" type="search" aria-label="Search chats">
        </div>
        <div class="scroll-y grow" role="list" aria-label="Saved chat threads">
          <div v-if="!threadsLoaded" class="skeleton" style="height: 40px; margin: var(--sp-2)"></div>
          <div v-else-if="loadError" class="banner banner-err" style="margin: var(--sp-2)">{{ loadError }}</div>
          <div v-else-if="!filteredThreads.length" class="empty" style="padding: var(--sp-4)">
            <span class="empty-icon">💬</span><span>{{ searchQuery ? 'No matches' : 'No chats yet' }}</span>
          </div>
          <div v-for="t in filteredThreads" :key="t.id" class="proj-row" :class="{'proj-row-active': t.id === activeId}" role="listitem">
            <div class="row" style="width:100%; align-items:flex-start">
              <template v-if="renamingId === t.id">
                <div class="grow">
                  <input
                    :ref="'rename-' + t.id"
                    v-model="renameText"
                    class="chat-rename-input"
                    @blur="finishRename(t)"
                    @keydown="onRenameKey($event, t)"
                    maxlength="100"
                    :aria-label="'Rename ' + threadLabel(t)"
                  />
                  <div class="xs muted truncate">{{ t.project === '__self__' ? '⚙ orchestrator' : (t.project || 'all projects') }} · {{ t.message_count }} msg</div>
                </div>
              </template>
              <template v-else>
                <button
                  type="button"
                  class="grow"
                  style="display:flex; flex-direction:column; min-width:0; padding:0; border:0; background:none; color:inherit; text-align:left; cursor:pointer"
                  @click="open(t.id)"
                  @dblclick.stop="startRename(t)"
                  :aria-current="t.id === activeId ? 'true' : undefined"
                  :disabled="sending || preparing || stopping"
                  title="Open thread; double-click to rename"
                >
                  <span class="bold truncate" style="width:100%">{{ threadLabel(t) }}</span>
                  <span class="xs muted truncate" style="width:100%">{{ t.project === '__self__' ? '⚙ orchestrator' : (t.project || 'all projects') }} · {{ t.message_count }} msg</span>
                </button>
              </template>
              <button v-if="renamingId !== t.id" type="button" class="btn btn-ghost btn-sm" @click="startRename(t)" :disabled="sending" :aria-label="'Rename ' + threadLabel(t)" title="Rename thread">✎</button>
              <button type="button" class="btn btn-ghost btn-sm" @click="removeThread(t.id)" :disabled="(sending || busy) && t.id === activeId" :aria-label="'Delete ' + threadLabel(t)" title="Delete thread">✕</button>
            </div>
          </div>
        </div>
      </aside>

      <!-- Conversation -->
      <div ref="chatMain" class="card chat-main">
        <div class="only-mobile chat-mobile-bar">
          <button type="button" class="btn btn-ghost btn-sm" @click="openThreadDrawer" title="Show chat list"
                  aria-controls="chat-thread-list" :aria-expanded="showThreads ? 'true' : 'false'">☰ Chats</button>
          <span class="xs muted truncate" style="margin-left: var(--sp-2)">{{ activeThread ? threadLabel(activeThread) : 'New chat' }}</span>
        </div>
        <div class="chat-msgs scroll-y grow" ref="scroll" role="log" aria-live="polite" aria-relevant="additions" :aria-busy="isWorking ? 'true' : 'false'">
          <div v-if="!messages.length" class="chat-empty">
            <div class="empty-icon" style="font-size: 28px">◆</div>
            <div class="bold" style="margin: var(--sp-2) 0">Ashmero Control</div>
            <p class="dim small" style="max-width: 440px; text-align:center">
              Ask anything about your projects, or tell it what to do — capture bugs and requirements,
              queue briefs, plan, run dev phases, chain full builds, audit &amp; fix, resume paused runs.
              It sees live orchestrator state and acts through control tools.
            </p>
            <div class="row" style="flex-wrap: wrap; gap: var(--sp-2); justify-content:center; margin-top: var(--sp-2)">
              <button v-for="q in quickPrompts" :key="q.label" type="button" class="chip chat-chip" @click="useQuick(q)">{{ q.label }}</button>
            </div>
          </div>

          <article v-for="m in messages" :key="m.id" class="chat-msg" :class="'chat-msg-' + m.role" :aria-label="m.role === 'user' ? 'Your message' : m.role === 'assistant' ? 'Assistant message' : 'System message'">
            <div class="chat-msg-tag xs muted" :title="m.created_at ? new Date(m.created_at).toLocaleString() : ''">
              {{ m.role === 'user' ? 'you' : m.role === 'assistant' ? assistantLabel : 'system' }}
              <span v-if="m.role === 'assistant' && m._model" class="chat-model-badge">{{ modelShortName(m._model) }}</span>
              <button v-if="m.role === 'user'" type="button" class="btn btn-ghost chat-edit-btn" @click="editMsg(m)" aria-label="Copy this message to the input" title="Edit — copy to input">✏</button>
              <button v-if="m.role === 'assistant'" type="button" class="btn btn-ghost chat-copy-btn" @click="copyMsg(m.content)" aria-label="Copy assistant reply" title="Copy reply">⎘</button>
            </div>
            <div v-if="m.role === 'assistant'" class="md chat-bubble" v-html="md(m.content)"></div>
            <div v-else class="chat-bubble">{{ m.content }}</div>
            <div v-if="attachmentsOf(m).length" class="row" style="gap: 4px; margin-top: 4px; flex-wrap: wrap">
              <span v-for="(a, i) in attachmentsOf(m)" :key="a" class="chip xs" style="align-items:center">
                <img v-if="m._previews && m._previews[i]" :src="m._previews[i]" class="chat-img-thumb" alt="">
                <template v-else>📎 </template>{{ a }}
              </span>
            </div>
          </article>

          <div v-if="isWorking || stopping" class="chat-msg chat-msg-assistant" role="status" aria-live="polite">
            <div class="chat-msg-tag xs muted">{{ assistantLabel }}</div>
            <div class="chat-bubble dim">
              <span class="dot dot-pulse" style="--dot-c: var(--accent)"></span>
              {{ workStatus }}
              <div v-if="lastStreamEvent" class="chat-stream-tool">🔧 {{ lastStreamEvent }}</div>
            </div>
          </div>
        </div>

        <div class="chat-input-wrap">
          <div class="row" style="gap: var(--sp-2); flex-wrap: wrap; margin-bottom: var(--sp-2)" v-if="messages.length">
            <button v-for="q in quickPrompts" :key="q.label" type="button" class="chip chat-chip" @click="useQuick(q)">{{ q.label }}</button>
          </div>
          <div v-if="messageQueue.length" class="row chat-queue-bar xs">
            <span class="muted">{{ messageQueue.length }} queued</span>
            <button
              v-for="(q, i) in messageQueue"
              :key="i"
              type="button"
              class="chip xs truncate"
              style="max-width: 180px"
              @click="reviewQueued(i)"
              :title="q.restored ? 'Restored after reload — review before sending' : 'Move queued message back to the composer'"
              :aria-label="(q.restored ? 'Review restored queued message: ' : 'Edit queued message: ') + q.text"
            >{{ q.restored ? 'Review: ' : '' }}{{ q.text }}</button>
            <button type="button" class="btn btn-ghost btn-sm" style="margin-left: auto" @click="clearQueue" title="Clear queue">✕ Clear</button>
          </div>
          <div v-if="pendingFiles.length || uploading" class="row" style="gap: 4px; flex-wrap: wrap; margin-bottom: var(--sp-2)">
            <span v-for="(f, i) in pendingFiles" :key="f.name" class="chip xs" style="align-items:center">
              <img v-if="f.previewUrl" :src="f.previewUrl" class="chat-img-thumb" alt="">
              <template v-else>📎 </template>{{ f.label }}
              <button type="button" class="btn btn-ghost btn-sm" style="min-height: 16px; padding: 0 4px; margin-left: 2px" @click="removePending(i)" :aria-label="'Remove ' + f.label" title="Remove">✕</button>
            </span>
            <span v-if="uploading" class="chip xs dim">uploading…</span>
          </div>
          <div class="chat-input-row">
            <div class="chat-input-controls">
              <select v-model="project" class="select" style="width: 130px" title="Focus project" aria-label="Focus project" :disabled="isWorking || stopping">
                <option value="">all projects</option>
                <option value="__self__">⚙ Orchestrator</option>
                <option v-for="p in projects" :key="p.name" :value="p.name">{{ p.name }}</option>
              </select>
              <select v-model="modelTier" class="select chat-model-select" title="Model — Auto picks by task complexity" aria-label="Model" :disabled="isWorking || stopping">
                <option value="auto">✦ Auto</option>
                <option value="haiku">⚡ Haiku</option>
                <option value="sonnet">◆ Sonnet</option>
                <option value="opus">◈ Opus</option>
                <option value="fable">◉ Fable</option>
              </select>
              <button type="button" class="btn btn-ghost" @click="pickFiles" :disabled="uploading || stopping" title="Attach files (text or images)" aria-label="Attach files">📎</button>
              <input ref="file" type="file" multiple style="display: none" @change="onFiles"
                     accept=".md,.txt,.json,.jsonl,.csv,.js,.mjs,.ts,.html,.css,.yaml,.yml,.xml,.log,.sh,.py,.toml,.ini,.png,.jpg,.jpeg,.gif,.webp">
            </div>
            <textarea ref="box" v-model="input" class="textarea grow" rows="2"
                      :placeholder="isWorking ? 'Type to queue the next message…' : 'Tell the orchestrator what you want… (Enter to send, Shift+Enter for newline)'"
                      @input="onComposerInput" @keydown="onKeydown" aria-label="Chat message"></textarea>
            <template v-if="!isWorking && !stopping">
              <button type="button" class="btn btn-primary" @click="send" :disabled="!canSend">Send</button>
            </template>
            <template v-else>
              <button v-if="hasInput && !preparing" type="button" class="btn btn-accent" @click="send" :disabled="stopping" title="Queue — sends after current reply">＋ Queue</button>
              <button v-if="sending || busy" type="button" class="btn btn-danger" @click="stopSend" :disabled="stopping" :aria-label="stopping ? 'Stopping current chat turn' : 'Stop current chat turn and clear queued messages'" title="Stop the provider turn and clear queue">■ {{ stopping ? 'Stopping…' : 'Stop' }}</button>
              <button v-else type="button" class="btn" disabled>Preparing…</button>
            </template>
          </div>
        </div>
      </div>
    </div>
  `,
};
