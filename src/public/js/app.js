import { store } from './lib/store.js';
import { router, navigate, projectHash } from './lib/router.js';
import { runStateOf } from './lib/format.js';

import AppHeader from './components/AppHeader.js';
import Sidebar from './components/Sidebar.js';
import DashboardView from './components/DashboardView.js';
import ProjectView from './components/ProjectView.js';
import ChatView from './components/ChatView.js';
import Toasts from './components/Toasts.js';
import ErrorBoundary from './components/ErrorBoundary.js';
import ConfirmModal from './components/modals/ConfirmModal.js';
import CallDetailModal from './components/modals/CallDetailModal.js';
import NewProjectModal from './components/modals/NewProjectModal.js';
import TerminalModal from './components/modals/TerminalModal.js';
import NasSyncModal from './components/modals/NasSyncModal.js';

export default {
  name: 'App',
  components: {
    AppHeader, Sidebar, DashboardView, ProjectView, ChatView,
    Toasts, ErrorBoundary, ConfirmModal, CallDetailModal, NewProjectModal, TerminalModal, NasSyncModal,
  },
  data() {
    return { loginInput: '', showKeys: false };
  },
  computed: {
    s() { return store.state; },
    router() { return router; },
  },
  watch: {
    'router.project'(name) {
      if (name && store.state.authed) store.loadDetail(name);
    },
  },
  mounted() {
    document.addEventListener('keydown', this.onKey);
    if (router.project && store.state.authed) store.loadDetail(router.project);
  },
  beforeUnmount() {
    document.removeEventListener('keydown', this.onKey);
  },
  methods: {
    async doLogin() {
      if (!this.loginInput.trim()) return;
      const ok = await store.login(this.loginInput);
      if (ok) this.loginInput = '';
    },
    onKey(e) {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!store.state.authed) return;

      // Dialogs own the keyboard while they are open. Without this guard a
      // single-key shortcut such as G/N/T could start work behind a confirm or
      // terminal modal, even though the operator could not see the affected
      // control. Escape is handled by the active modal itself.
      if (document.querySelector('.modal-backdrop')) return;

      if (e.key === 'Escape') {
        this.showKeys = false;
        if (store.state.sidebarOpen) store.state.sidebarOpen = false;
        return;
      }
      if (e.key === '?') { this.showKeys = !this.showKeys; return; }
      if (e.key === 'r' || e.key === 'R') { store.loadAll(); return; }
      if (e.key === 'c' || e.key === 'C') { navigate('#/chat'); return; }
      if ((e.key === 't' || e.key === 'T') && store.state.systemHealth?.capabilities?.terminal === true) {
        store.state.showTerminal = true;
        return;
      }

      const name = router.project;
      const proj = name && store.state.projects.find((p) => p.name === name);
      if (!proj) return;
      const state = runStateOf(proj);
      const canStart = !proj.pendingJob && ['idle', 'planning', 'cancelled'].includes(state);
      const canRunNext = !proj.pendingJob && ['idle', 'planning', 'cancelled', 'plan-ready'].includes(state);

      if ((e.key === 'g' || e.key === 'G') && canStart) store.projectAction(name, 'go');
      else if ((e.key === 'n' || e.key === 'N') && canRunNext) store.projectAction(name, 'next');
      else if (e.key === 'a' || e.key === 'A') { if (state === 'running' || state === 'paused') store.projectAction(name, 'abort'); }
      else if (e.key === 'b' || e.key === 'B') navigate(projectHash(name, 'brief'));
    },
  },
  template: `
    <!-- login gate -->
    <div v-if="!s.authed" class="login-wrap">
      <div class="card login-card" v-if="s.authChecked">
        <div class="login-logo"><span class="app-logo-mark">◆</span> Ashmero</div>
        <p class="dim small">Paste the auth token printed in the server console.</p>
        <input v-model="loginInput" type="password" class="input" placeholder="Auth token"
               @keydown.enter="doLogin" autofocus aria-label="Auth token">
        <div v-if="s.loginError" class="error-text">{{ s.loginError }}</div>
        <button class="btn btn-primary" style="width: 100%" @click="doLogin" :disabled="!loginInput.trim()">Connect</button>
      </div>
    </div>

    <!-- app shell -->
    <template v-else>
      <AppHeader />
      <div class="app-body">
        <div v-if="s.sidebarOpen" class="sidebar-scrim only-mobile" @click="s.sidebarOpen = false"></div>
        <Sidebar />
        <main class="app-main scroll-y" :class="{'app-main-chat': router.view === 'chat'}">
          <ErrorBoundary :label="router.view + ' view'" :key="'eb-' + router.view">
            <DashboardView v-if="router.view === 'dashboard'" />
            <ChatView v-else-if="router.view === 'chat'" />
            <ProjectView v-else :key="router.project" />
          </ErrorBoundary>
        </main>
      </div>

      <Toasts />
      <ConfirmModal v-if="s.confirm" />
      <CallDetailModal v-if="s.callDetail" />
      <NewProjectModal v-if="s.showNewProject" />
      <TerminalModal v-if="s.showTerminal" />
      <NasSyncModal v-if="s.showNasSync" />

      <div v-if="showKeys" class="keys-hint card" @click="showKeys = false">
        <div class="card-title" style="margin-bottom: var(--sp-2)">Keyboard shortcuts</div>
        <div class="small dim col" style="gap: 4px">
          <span><b class="mono">G</b> — start auto-run</span>
          <span><b class="mono">N</b> — next phase</span>
          <span><b class="mono">A</b> — abort run</span>
          <span><b class="mono">B</b> — brief tab</span>
          <span><b class="mono">C</b> — control chat</span>
          <span v-if="s.systemHealth?.capabilities?.terminal"><b class="mono">T</b> — terminal</span>
          <span><b class="mono">R</b> — refresh all</span>
          <span><b class="mono">?</b> — toggle this help</span>
        </div>
      </div>
    </template>
  `,
};
