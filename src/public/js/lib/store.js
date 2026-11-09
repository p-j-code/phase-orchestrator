// Global reactive store. Components read store.state and call store methods —
// no $root coupling, no per-component fetch plumbing.

import { reactive } from '../../vendor/vue.esm-browser.prod.js';
import { api, getToken, setToken, clearToken, onUnauthorized } from './api.js';
import { openStream } from './sse.js';
import { router, navigate } from './router.js';
import { forecastSummary } from './format.js';

let toastSeq = 0;
let stream = null;
let ticker = null;
const debounceTimers = {};
const RESTART_PROJECTS_KEY = 'ashmero_restart_projects';

const debounceFirstAt = {};
const requestSeq = {};

function beginRequest(key) {
  requestSeq[key] = (requestSeq[key] || 0) + 1;
  return requestSeq[key];
}

function isLatestRequest(key, seq) { return requestSeq[key] === seq; }

// Debounce with an optional maxWait: a stream of events that never pauses (a busy
// run emitting calls faster than `ms`) would starve a plain trailing debounce, so
// once maxWait has elapsed since the first pending call we fire anyway.
function debounce(key, ms, fn, maxWait = 0) {
  const now = Date.now();
  if (!debounceTimers[key]) debounceFirstAt[key] = now;
  if (maxWait && now - debounceFirstAt[key] >= maxWait) {
    if (debounceTimers[key]) { clearTimeout(debounceTimers[key]); delete debounceTimers[key]; }
    delete debounceFirstAt[key];
    fn();
    return;
  }
  if (debounceTimers[key]) clearTimeout(debounceTimers[key]);
  debounceTimers[key] = setTimeout(() => {
    delete debounceTimers[key];
    delete debounceFirstAt[key];
    fn();
  }, ms);
}

export const store = {
  state: reactive({
    authed: false,
    authChecked: false,
    loginError: '',

    stats: null,
    statsError: '',
    windowInfo: null,
    windowError: '',
    jobs: null,
    jobsError: '',
    systemHealth: null,
    systemHealthError: '',
    projects: [],
    projectsLoaded: false,
    projectsError: '',
    detail: null,
    detailLoading: false,
    detailError: '',
    activity: [],
    activityError: '',
    healing: [],
    healingError: '',

    sse: 'connecting',
    now: Date.now(),

    toasts: [],
    confirm: null,       // {title, body, danger, confirmLabel, _resolve}
    callDetail: null,
    showNewProject: false,
    showTerminal: false,
    showNasSync: false,
    terminalChatContext: null,  // { project, prefill } — set before navigating to chat
    sidebarOpen: false,  // mobile drawer

    busy: {},            // actionKey → true while in flight
    previouslyRunning: [],  // project names captured by stop-all-running, cleared on restart
  }),

  // ── auth ──────────────────────────────────────────────────────────────────

  async init() {
    onUnauthorized(() => this.logout(true));
    if (!getToken()) {
      this.state.authChecked = true;
      return;
    }
    try {
      await api('GET', '/stats');
      this.state.authed = true;
      this.state.authChecked = true;
      this.start();
    } catch (e) {
      this.state.authChecked = true;
      if (e.message !== 'Unauthorized') this.state.loginError = e.message;
    }
  },

  async login(token) {
    this.state.loginError = '';
    setToken(token.trim());
    try {
      await api('GET', '/stats');
      this.state.authed = true;
      this.start();
      return true;
    } catch (e) {
      clearToken();
      this.state.loginError = e.message === 'Unauthorized' ? 'Invalid token' : e.message;
      return false;
    }
  },

  logout(expired = false) {
    // Flip auth first so components unmount before any late in-flight loader
    // result can be rendered under the login screen.
    this.state.authed = false;
    clearToken();
    // Never leave an action suspended behind a dialog that is about to be
    // unmounted. Without resolving it, logging back in could resurrect the
    // old confirm and execute a stale operation minutes later.
    if (this.state.confirm?._resolve) this.state.confirm._resolve(false);
    this.state.confirm = null;
    this.state.callDetail = null;
    this.state.showNewProject = false;
    this.state.showTerminal = false;
    this.state.showNasSync = false;
    this.state.sidebarOpen = false;
    this.state.terminalChatContext = null;
    this.state.stats = null;
    this.state.windowInfo = null;
    this.state.jobs = null;
    this.state.systemHealth = null;
    this.state.projects = [];
    this.state.projectsLoaded = false;
    this.state.detail = null;
    this.state.detailLoading = false;
    this.state.activity = [];
    this.state.healing = [];
    this.state.busy = {};
    this.state.sse = 'disconnected';
    // Debounced SSE refreshes otherwise fire after logout and immediately make
    // another unauthorized request, which can obscure the original expiry.
    for (const key of Object.keys(debounceTimers)) {
      clearTimeout(debounceTimers[key]);
      delete debounceTimers[key];
      delete debounceFirstAt[key];
    }
    for (const key of Object.keys(requestSeq)) requestSeq[key] += 1;
    if (expired) this.state.loginError = 'Session expired — paste the token again';
    if (stream) { stream.close(); stream = null; }
    if (ticker) { clearInterval(ticker); ticker = null; }
  },

  // ── lifecycle ─────────────────────────────────────────────────────────────

  start() {
    try {
      const remembered = JSON.parse(localStorage.getItem(RESTART_PROJECTS_KEY) || '[]');
      this.state.previouslyRunning = Array.isArray(remembered)
        ? remembered.filter((name) => typeof name === 'string' && name)
        : [];
    } catch {
      this.state.previouslyRunning = [];
    }
    this.loadAll();
    this.openSse();
    if (!ticker) ticker = setInterval(() => { this.state.now = Date.now(); }, 1000);
  },

  openSse() {
    if (stream) stream.close();
    // The server resets its SSE cursors to the DB head on each connect, so any
    // call/status/window change that happened while the stream was DOWN is never
    // replayed. On a RE-connect (every 'live' after the first) do a full refetch
    // so the dashboard catches up instead of silently showing stale state.
    let everLive = false;
    stream = openStream('/stream', {
      onStatus: (s) => {
        this.state.sse = s;
        if (s === 'live') {
          if (everLive) this.loadAll();
          everLive = true;
        }
      },
      onEvent: (evt) => this.handleEvent(evt),
    });
  },

  handleEvent(evt) {
    if (!evt || !evt.type) return;
    if (evt.type === 'hello') {
      // Server-asset fingerprint, sent first on every (re)connect. The first one
      // this tab sees is the version it booted on. If a later reconnect reports a
      // different fingerprint, the server shipped new client code while this tab
      // was open — reload to swap the whole ES-module graph atomically. Running a
      // mix of old + new modules corrupts Vue's component tree (null instances →
      // blank screen), which no soft refresh reliably clears.
      const v = evt.assetVersion;
      if (v) {
        if (this._assetVersion == null) this._assetVersion = v;
        else if (this._assetVersion !== v && !this._reloading) {
          this._reloading = true;
          try { location.reload(); } catch { /* noop */ }
        }
      }
      return;
    }
    if (evt.type === 'call') {
      this.state.activity.unshift({ ...evt, at: Date.now() });
      if (this.state.activity.length > 200) this.state.activity.length = 200;
      if (router.project && evt.project === router.project) {
        debounce('detail', 800, () => this.loadDetail(router.project, { silent: true }), 4000);
      }
      // maxWait so a continuously-busy run still refreshes the sidebar/KPIs.
      debounce('stats', 3000, () => { this.loadStats(); this.loadProjects({ silent: true }); }, 9000);
      debounce('window', 5000, () => this.loadWindow(), 12000);
      // The job queue and healing feed used to load once and then only on manual
      // refresh — keep them fresh on a longer debounce so the dashboard cards
      // aren't stale snapshots next to the live widgets.
      debounce('queues', 6000, () => { this.loadJobs(); this.loadHealing(); }, 20000);
    } else if (evt.type === 'status') {
      const p = this.state.projects.find((x) => x.name === evt.project);
      if (p) { p.status = evt.status; p.current_phase = evt.current_phase; }
      if (router.project === evt.project) {
        debounce('detail', 300, () => this.loadDetail(router.project, { silent: true }));
      }
      debounce('stats', 1500, () => { this.loadStats(); this.loadProjects({ silent: true }); });
      // A status flip usually marks a job enqueue/claim/complete — refresh queues.
      debounce('queues', 2000, () => { this.loadJobs(); this.loadHealing(); }, 12000);
    } else if (evt.type === 'removed') {
      this.state.projects = this.state.projects.filter((x) => x.name !== evt.project);
      if (router.project === evt.project) navigate('#/');
    } else if (evt.type === 'window') {
      const { type, ...rest } = evt;
      this.state.windowInfo = rest;
    } else if (evt.type === 'notify') {
      // Phase 58 (notify_outbox): the browser is a READ-ONLY mirror of the
      // outbox — surface the queued run-lifecycle notice as a toast, but never
      // mark it delivered (server-discord.js's delivery loop owns delivery to
      // the phone). Longer-lived than an action toast since these are pings
      // (phase done / drift / pause) worth reading.
      if (evt.text) this.toast(evt.text, 'info', { project: evt.project, ttl: 6000 });
    }
  },

  // ── loaders ───────────────────────────────────────────────────────────────

  async loadAll() {
    await Promise.allSettled([
      this.loadStats(),
      this.loadWindow(),
      this.loadProjects(),
      this.loadActivity(),
      this.loadHealing(),
      this.loadJobs(),
      this.loadSystemHealth(),
      router.project ? this.loadDetail(router.project) : Promise.resolve(),
    ]);
  },

  async loadStats() {
    const seq = beginRequest('stats');
    this.state.statsError = '';
    try {
      const data = await api('GET', '/stats');
      if (isLatestRequest('stats', seq)) this.state.stats = data;
      return data;
    } catch (e) {
      if (isLatestRequest('stats', seq)) this.state.statsError = e.message;
      return null;
    }
  },

  async loadWindow() {
    const seq = beginRequest('window');
    this.state.windowError = '';
    try {
      const data = await api('GET', '/window');
      if (isLatestRequest('window', seq)) this.state.windowInfo = data;
      return data;
    } catch (e) {
      if (isLatestRequest('window', seq)) { this.state.windowInfo = null; this.state.windowError = e.message; }
      return null;
    }
  },

  async loadJobs() {
    const seq = beginRequest('jobs');
    this.state.jobsError = '';
    try {
      const data = await api('GET', '/jobs');
      if (isLatestRequest('jobs', seq)) this.state.jobs = data;
      return data;
    } catch (e) {
      if (isLatestRequest('jobs', seq)) { this.state.jobs = null; this.state.jobsError = e.message; }
      return null;
    }
  },

  async loadSystemHealth() {
    const seq = beginRequest('system-health');
    this.state.systemHealthError = '';
    try {
      const data = await api('GET', '/system/health');
      if (isLatestRequest('system-health', seq)) this.state.systemHealth = data;
      return data;
    } catch (e) {
      if (isLatestRequest('system-health', seq)) {
        this.state.systemHealth = null;
        this.state.systemHealthError = e.message;
      }
      return null;
    }
  },

  async loadProjects({ silent = false } = {}) {
    const seq = beginRequest('projects');
    if (!silent) this.state.projectsError = '';
    try {
      const data = await api('GET', '/projects');
      if (!Array.isArray(data)) throw new Error('Invalid projects response: expected an array');
      if (!isLatestRequest('projects', seq)) return data;
      this.state.projects = data;
      this.state.projectsError = '';
      this.state.projectsLoaded = true;
      return data;
    } catch (e) {
      if (isLatestRequest('projects', seq)) {
        if (!silent) this.state.projectsError = e.message;
        this.state.projectsLoaded = true;
      }
      return null;
    }
  },

  async loadActivity() {
    const seq = beginRequest('activity');
    this.state.activityError = '';
    try {
      const rows = await api('GET', '/activity');
      const mapped = rows.map((r) => ({
        type: 'call',
        project: r.project,
        phase: r.phase,
        task: r.task,
        model: r.model,
        tokens: (r.input_tokens || 0) + (r.output_tokens || 0),
        cost_usd: r.cost_usd,
        is_error: !!r.is_error,
        at: r.started_at ? new Date(r.started_at).getTime() : Date.now(),
        row: r,
      }));
      if (isLatestRequest('activity', seq)) this.state.activity = mapped;
      return mapped;
    } catch (e) {
      if (isLatestRequest('activity', seq)) this.state.activityError = e.message;
      return null;
    }
  },

  async loadHealing() {
    const seq = beginRequest('healing');
    this.state.healingError = '';
    try {
      const data = await api('GET', '/healing?limit=40');
      if (isLatestRequest('healing', seq)) this.state.healing = data;
      return data;
    } catch (e) {
      if (isLatestRequest('healing', seq)) this.state.healingError = e.message;
      return null;
    }
  },

  async loadDetail(name, { silent = false } = {}) {
    const seq = beginRequest('detail');
    if (!silent) { this.state.detailLoading = true; this.state.detailError = ''; }
    try {
      const d = await api('GET', `/projects/${encodeURIComponent(name)}`);
      // ignore stale responses after navigation
      if (router.project === name && isLatestRequest('detail', seq)) { this.state.detail = d; this.state.detailError = ''; }
      return d;
    } catch (e) {
      if (!silent && router.project === name && isLatestRequest('detail', seq)) this.state.detailError = e.message;
      return null;
    } finally {
      if (!silent && isLatestRequest('detail', seq)) this.state.detailLoading = false;
    }
  },

  // One admission view for every UI surface whose backend mutation requires
  // an idle project. Detail and list snapshots refresh independently, so treat
  // either one as authoritative when it reports active or queued work.
  projectMutationLockReason(name) {
    if (!name) return 'Choose a project first';
    const candidates = [];
    if (this.state.detail?.name === name) candidates.push(this.state.detail);
    const listed = this.state.projects.find((project) => project?.name === name);
    if (listed && listed !== this.state.detail) candidates.push(listed);

    const pending = candidates.find((project) => project?.pendingJob)?.pendingJob;
    if (pending) {
      const action = pending.action || pending.type || 'Project work';
      return `${action} is already queued — wait for it to finish`;
    }
    if (candidates.some((project) => project?.processAlive || project?.autoRun?.status === 'running')) {
      return 'Project work is running — stop it or wait for it to finish';
    }
    return '';
  },

  // Confirm dialogs and forecasts create enough time for another client or
  // worker to claim the project. Refresh both lock-bearing snapshots before a
  // mutation is dispatched instead of relying on the state shown at click time.
  async revalidateProjectMutationLock(name) {
    await Promise.allSettled([
      this.loadProjects({ silent: true }),
      router.project === name ? this.loadDetail(name, { silent: true }) : Promise.resolve(),
    ]);
    return this.projectMutationLockReason(name);
  },

  // ── actions ───────────────────────────────────────────────────────────────

  toast(text, kind = 'ok', { project = null, ttl } = {}) {
    const id = ++toastSeq;
    this.state.toasts.push({ id, kind, text, project });
    const life = ttl ?? (kind === 'err' ? 5000 : 3200);
    setTimeout(() => {
      this.state.toasts = this.state.toasts.filter((t) => t.id !== id);
    }, life);
  },

  confirmAction({ title, body, danger = false, confirmLabel = 'Confirm' }) {
    // One global modal is rendered. A second click while it is open must fail
    // closed; replacing the descriptor would strand the first Promise and can
    // later dispatch the wrong operation under the wrong confirmation text.
    if (this.state.confirm) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.state.confirm = { title, body, danger, confirmLabel, _resolve: resolve };
    });
  },

  resolveConfirm(answer) {
    const c = this.state.confirm;
    this.state.confirm = null;
    if (c && c._resolve) c._resolve(answer);
  },

  // Wrapped mutation: busy flag + toasts + error surfacing. Returns result or null.
  async act(key, method, path, body, { okMsg = '', errPrefix = '', onError = null } = {}) {
    if (this.state.busy[key]) return null;
    this.state.busy[key] = true;
    try {
      const result = await api(method, path, body);
      if (okMsg) this.toast(okMsg, 'ok');
      return result;
    } catch (e) {
      if (onError) onError(e);
      this.toast((errPrefix ? errPrefix + ': ' : '') + e.message, 'err');
      return null;
    } finally {
      delete this.state.busy[key];
    }
  },

  // Project verbs (shared by action bar, dashboard cards, keyboard shortcuts).
  // Callers that run their own confirm first (relaunch, fixAndResume) pass
  // { confirmed: true } to avoid a double prompt.
  async projectAction(name, verb, { confirmed = false } = {}) {
    const enc = encodeURIComponent(name);
    const pendingBlockedVerbs = ['go', 'resume', 'next', 'launch', 'next-brief', 'sync'];
    const project = (router.project === name && this.state.detail?.name === name)
      ? this.state.detail
      : this.state.projects.find((p) => p.name === name);
    if (project?.pendingJob && pendingBlockedVerbs.includes(verb)) {
      this.toast(`${project.pendingJob.action || 'Work'} is already queued for “${name}”`, 'warn');
      return null;
    }
    const refresh = () => {
      this.loadProjects({ silent: true });
      if (router.project === name) this.loadDetail(name, { silent: true });
      this.loadStats();
      this.loadJobs();
    };

    if (verb === 'abort') {
      if (!confirmed) {
        const yes = await this.confirmAction({
          title: 'Abort run?',
          body: `In-flight work on “${name}” will be lost and the project will be marked cancelled.`,
          danger: true,
          confirmLabel: 'Abort run',
        });
        if (!yes) return;
      }
      const r = await this.act(`abort:${name}`, 'POST', `/projects/${enc}/abort`, undefined, { okMsg: 'Run aborted' });
      if (r) refresh();
      return r;
    }

    if (verb === 'sync' && !confirmed) {
      if (project && (project.processAlive || project.autoRun?.status === 'running')) {
        this.toast(`Stop active work on “${name}” before syncing its branch`, 'warn');
        return null;
      }
      const yes = await this.confirmAction({
        title: 'Sync project branch?',
        body: `Fast-forward “${name}” from its configured remote. The server will refuse unsafe divergence or a dirty workspace.`,
        confirmLabel: 'Git sync',
      });
      if (!yes) return null;
    }

    // Every run-spawning verb consumes window budget, so confirm before
    // spawning. Full runs (go/resume/launch/next-brief) show the deterministic
    // pre-flight window forecast (predict × live 5h window) so the operator
    // decides run-now vs wait; `next` is a single phase and gets a plain
    // prompt. Best-effort — a forecast error falls back to a plain prompt and
    // never blocks the action. (Previously only go/resume confirmed — launch,
    // next-brief and next fired immediately.)
    const spawnTitles = {
      go: 'Start auto-run?', resume: 'Resume run?', launch: 'Launch full pipeline?',
      'next-brief': 'Run next brief?', next: 'Run next phase?',
    };
    if (!confirmed && spawnTitles[verb]) {
      const withForecast = verb !== 'next';
      let body = withForecast
        ? `Start work on “${name}”?`
        : `Run the next phase on “${name}”? This spawns a real phase run and consumes window budget.`;
      if (withForecast) {
        try { body = forecastSummary(await api('GET', `/projects/${enc}/forecast`)); }
        catch { /* forecast unavailable — proceed with the plain prompt */ }
      }
      const yes = await this.confirmAction({
        title: spawnTitles[verb],
        body,
        confirmLabel: verb === 'resume' ? 'Resume' : verb === 'next' ? 'Run phase' : 'Start',
      });
      if (!yes) return;
    }

    // A forecast or confirmation can remain open while an SSE event or another
    // control queues work for the same project. Re-read the project list after
    // that human delay and fail closed when the lock state cannot be verified.
    if (pendingBlockedVerbs.includes(verb)) {
      const rows = await this.loadProjects({ silent: true });
      if (!Array.isArray(rows)) {
        this.toast(`Could not verify current work for “${name}”; ${verb} was not submitted`, 'err');
        return null;
      }
      const latest = rows.find((entry) => entry?.name === name);
      if (!latest) {
        this.toast(`Project “${name}” is no longer available`, 'err');
        return null;
      }
      if (latest.pendingJob) {
        this.toast(`${latest.pendingJob.action || 'Work'} is already queued for “${name}”`, 'warn');
        return null;
      }
      if (verb === 'sync' && (latest.processAlive || latest.autoRun?.status === 'running')) {
        this.toast(`Stop active work on “${name}” before syncing its branch`, 'warn');
        return null;
      }
    }

    const verbs = {
      go:          { path: `/projects/${enc}/go`,               msg: 'Auto-run started' },
      resume:      { path: `/projects/${enc}/resume`,           msg: 'Resuming run' },
      next:        { path: `/projects/${enc}/next`,             msg: 'Next phase started' },
      launch:      { path: `/projects/${enc}/launch`,           msg: 'Unattended pipeline launched' },
      sync:        { path: `/projects/${enc}/sync`,             msg: 'Git sync started' },
      'next-brief': { path: `/projects/${enc}/next-brief/launch`, msg: 'Brief agent + auto-run launched' },
    };
    const v = verbs[verb];
    if (!v) return null;
    const r = await this.act(`${verb}:${name}`, 'POST', v.path, undefined, { okMsg: v.msg, errPrefix: verb });
    if (r) setTimeout(refresh, 900);
    return r;
  },

  async removeProject(name, keepFiles) {
    const q = keepFiles ? '?keepFiles=1' : '';
    const key = `remove:${name}`;
    if (this.state.busy[key]) return null;
    this.state.busy[key] = true;
    let result = null;
    try {
      result = await api('DELETE', `/projects/${encodeURIComponent(name)}${q}`);
    } catch (e) {
      // File cleanup happens after the DB removal. Preserve and surface that
      // partial-success contract instead of leaving a ghost project in the UI.
      if (e.data?.dbDeleted) result = e.data;
      else {
        this.toast(`${keepFiles ? 'Detach project' : 'Delete project'}: ${e.message}`, 'err', { ttl: 8000 });
        return null;
      }
    } finally {
      delete this.state.busy[key];
    }
    if (result) {
      this.state.projects = this.state.projects.filter((x) => x.name !== name);
      if (router.project === name) navigate('#/');
      this.loadStats();
      this.loadJobs();
      const cleanupError = result.filesError || result.cleanupError || result.warning;
      if (cleanupError) {
        const recovery = result.stagedDir ? ` Recoverable files remain at ${result.stagedDir}.` : '';
        this.toast(`“${name}” was detached, but its files could not be deleted: ${cleanupError}.${recovery}`, 'err', { ttl: 12000 });
      } else {
        this.toast(keepFiles ? `“${name}” detached; files kept` : `“${name}” and its files deleted`, 'ok');
      }
    }
    return result;
  },

  async stopAllRunning() {
    const yes = await this.confirmAction({
      title: 'Stop every running project?',
      body: 'This interrupts every live project and marks those runs cancelled. Their names are saved so you can explicitly start them again with Restart.',
      danger: true,
      confirmLabel: 'Stop all',
    });
    if (!yes) return;
    const result = await this.act('stop-all', 'POST', '/stop-all-running', undefined, { errPrefix: 'Stop all' });
    if (!result) return;
    const stopped = Array.isArray(result.stopped) ? result.stopped : [];
    if (stopped.length) {
      this.state.previouslyRunning = [...new Set([
        ...this.state.previouslyRunning,
        ...stopped,
      ])];
      this.persistRestartProjects();
      this.toast(`Stopped ${stopped.length} project(s) — ${this.state.previouslyRunning.length} saved for restart`, 'warn');
    } else {
      this.toast('No running projects to stop', 'info');
    }
    this.loadProjects({ silent: true });
    this.loadStats();
  },

  async restartPrevious() {
    const names = [...new Set(this.state.previouslyRunning.filter((name) => typeof name === 'string' && name))];
    if (!names.length) return;

    const forecastLines = await Promise.all(names.map(async (name) => {
      try {
        const forecast = await api('GET', `/projects/${encodeURIComponent(name)}/forecast`);
        return `• ${name} — ${forecastSummary(forecast)}`;
      } catch {
        return `• ${name} — forecast unavailable`;
      }
    }));
    const yes = await this.confirmAction({
      title: `Restart ${names.length} previous project${names.length === 1 ? '' : 's'}?`,
      body: `This queues a Resume job for each listed project. Current queue locks are checked again before submission.\n\n${forecastLines.join('\n')}`,
      confirmLabel: names.length === 1 ? 'Restart project' : `Restart ${names.length} projects`,
    });
    if (!yes) return;

    // The restart list is persisted across reloads and can be stale. Verify
    // existence and per-project queue locks after the confirmation rather than
    // sending the historical list blindly.
    const rows = await this.loadProjects({ silent: true });
    if (!Array.isArray(rows)) {
      this.toast('Could not verify current project locks; nothing was restarted', 'err');
      return;
    }
    const byName = new Map(rows.filter((entry) => entry?.name).map((entry) => [entry.name, entry]));
    const eligible = [];
    const blocked = [];
    for (const name of names) {
      const current = byName.get(name);
      if (!current) blocked.push(`${name} (not found)`);
      else if (current.pendingJob) blocked.push(`${name} (${current.pendingJob.action || 'work'} already queued)`);
      else eligible.push(name);
    }
    if (!eligible.length) {
      this.toast(`Nothing restarted${blocked.length ? ` — ${blocked.join(', ')}` : ''}`, 'warn', { ttl: 9000 });
      return;
    }

    const result = await this.act('restart-previous', 'POST', '/restart-previous', { names: eligible }, { errPrefix: 'Restart' });
    if (!result) return;
    const restarted = Array.isArray(result.restarted) ? result.restarted : [];
    const restartedNames = new Set(restarted.map((entry) => typeof entry === 'string' ? entry : (entry?.name || entry?.project)).filter(Boolean));
    const serverRemaining = Array.isArray(result.notRestarted) ? result.notRestarted
      : Array.isArray(result.skipped) ? result.skipped : null;
    const explicitRemaining = serverRemaining
      ? serverRemaining.map((entry) => typeof entry === 'string' ? entry : (entry?.name || entry?.project)).filter(Boolean)
      : [];
    this.state.previouslyRunning = [...new Set([
      ...blocked.map((entry) => entry.replace(/ \(.*\)$/, '')),
      ...explicitRemaining,
      ...eligible.filter((name) => !restartedNames.has(name)),
    ])];
    this.persistRestartProjects();
    const n = restarted.length;
    const remaining = this.state.previouslyRunning.length;
    this.toast(
      n ? `Restarted ${n} project(s)${remaining ? `; ${remaining} still need attention` : ''}` : 'No projects could be restarted; the list was kept',
      n && !remaining ? 'ok' : 'warn',
    );
    setTimeout(() => { this.loadProjects({ silent: true }); this.loadStats(); }, 900);
  },

  async restartUi() {
    if (this.state.systemHealth?.capabilities?.restartUi !== true) {
      const reason = this.state.systemHealthError
        ? `server capabilities could not be verified: ${this.state.systemHealthError}`
        : 'this server is not supervised by PM2';
      this.toast(`UI restart is unavailable because ${reason}`, 'warn');
      return null;
    }
    const yes = await this.confirmAction({
      title: 'Restart UI server?',
      body: 'The web process will exit and PM2 will bring it back (~5 s). You will lose the live stream briefly.',
      confirmLabel: 'Restart UI',
      danger: false,
    });
    if (!yes) return;
    const result = await this.act('restart-ui', 'POST', '/restart-ui', undefined, { errPrefix: 'Restart UI' });
    if (result) this.toast('UI restarting — reconnecting shortly…', 'warn');
    return result;
  },

  persistRestartProjects() {
    try {
      if (this.state.previouslyRunning.length) {
        localStorage.setItem(RESTART_PROJECTS_KEY, JSON.stringify(this.state.previouslyRunning));
      } else {
        localStorage.removeItem(RESTART_PROJECTS_KEY);
      }
    } catch { /* storage may be disabled; in-memory restart still works */ }
  },
};
