import { store } from '../lib/store.js';
import { router, navigate, projectHash } from '../lib/router.js';
import { fmtMoney, pct, runStateOf, runStateMeta, runIsStale } from '../lib/format.js';
import { focusContained, handleContainedKey, isolateForOverlay } from '../lib/modal-a11y.js';

const PREF_KEY = 'ashmero_sidebar';

export default {
  name: 'Sidebar',
  data() {
    let prefs = {};
    try { prefs = JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch { /* defaults */ }
    return {
      filter: prefs.filter || '',
      sort: prefs.sort || 'recent',
      mobile: false,
      drawerReturnFocus: null,
      restoreDrawerIsolation: null,
    };
  },
  computed: {
    router() { return router; },
    loaded() { return store.state.projectsLoaded; },
    error() { return store.state.projectsError; },
    open() { return store.state.sidebarOpen; },
    sorted() {
      const q = this.filter.trim().toLowerCase();
      let list = store.state.projects.filter((p) => !q || p.name.toLowerCase().includes(q));
      const bySort = {
        'name':   (a, b) => a.name.localeCompare(b.name),
        'cost':   (a, b) => (b.cost?.total_cost || 0) - (a.cost?.total_cost || 0),
        'recent': (a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0),
      };
      // running first, then chosen sort
      return [...list].sort((a, b) => {
        const ra = runStateOf(a) === 'running' ? 0 : 1;
        const rb = runStateOf(b) === 'running' ? 0 : 1;
        if (ra !== rb) return ra - rb;
        return (bySort[this.sort] || bySort.recent)(a, b);
      });
    },
  },
  watch: {
    filter() { this.savePrefs(); },
    sort() { this.savePrefs(); },
    open(value, oldValue) {
      if (!this.mobile || value === oldValue) return;
      if (value) this.$nextTick(() => this.activateDrawer());
      else this.deactivateDrawer();
    },
  },
  mounted() {
    this.mobileQuery = window.matchMedia('(max-width: 900px)');
    this.onViewportChange(this.mobileQuery);
    this.mobileQuery.addEventListener?.('change', this.onViewportChange);
    if (this.mobile && this.open) this.$nextTick(() => this.activateDrawer());
  },
  beforeUnmount() {
    this.mobileQuery?.removeEventListener?.('change', this.onViewportChange);
    this.deactivateDrawer({ restoreFocus: false });
  },
  methods: {
    fmtMoney, pct, runStateOf, runStateMeta, runIsStale,
    retryLoad() { store.loadProjects(); },
    onViewportChange(e) {
      const nextMobile = !!e.matches;
      if (this.mobile && !nextMobile) this.deactivateDrawer({ restoreFocus: false });
      this.mobile = nextMobile;
      if (!this.mobile) store.state.sidebarOpen = false;
      else if (this.open) this.$nextTick(() => this.activateDrawer());
    },
    activateDrawer() {
      if (!this.mobile || !this.open || this.restoreDrawerIsolation) return;
      this.drawerReturnFocus = document.activeElement;
      this.restoreDrawerIsolation = isolateForOverlay([
        document.querySelector('.app-header'),
        document.querySelector('.app-main'),
      ]);
      focusContained(this.$refs.sidebar, this.$refs.filterInput);
    },
    deactivateDrawer({ restoreFocus = true } = {}) {
      this.restoreDrawerIsolation?.();
      this.restoreDrawerIsolation = null;
      const target = this.drawerReturnFocus;
      this.drawerReturnFocus = null;
      if (restoreFocus && target?.isConnected) {
        this.$nextTick(() => target.focus?.({ preventScroll: true }));
      }
    },
    onDrawerKey(event) {
      if (!this.mobile || !this.open) return;
      event.stopPropagation();
      handleContainedKey(this.$refs.sidebar, event, { onEscape: this.closeDrawer });
    },
    closeDrawer() {
      if (this.mobile && this.open) store.state.sidebarOpen = false;
    },
    savePrefs() {
      try { localStorage.setItem(PREF_KEY, JSON.stringify({ filter: this.filter, sort: this.sort })); } catch { /* noop */ }
    },
    select(p) {
      navigate(projectHash(p.name));
      store.state.sidebarOpen = false;
    },
    phaseLabel(p) {
      if (!p.total_phases) return '';
      return `${p.current_phase}/${p.total_phases}`;
    },
  },
  template: `
    <aside id="project-sidebar" ref="sidebar" class="sidebar" :class="{'sidebar-open': open}" aria-label="Projects"
           :role="mobile ? 'dialog' : 'navigation'" :aria-modal="mobile && open ? 'true' : null"
           :inert="mobile && !open ? '' : null" :aria-hidden="mobile && !open ? 'true' : null"
           @keydown="onDrawerKey">
      <div class="sidebar-tools">
        <input ref="filterInput" v-model="filter" class="input" placeholder="Filter projects…" aria-label="Filter projects">
        <select v-model="sort" class="select" style="width: 92px" aria-label="Sort projects">
          <option value="recent">Recent</option>
          <option value="name">A–Z</option>
          <option value="cost">Cost</option>
        </select>
      </div>

      <div class="sidebar-list scroll-y">
        <div v-if="!loaded" class="col" style="padding: var(--sp-3)">
          <div class="skeleton" style="height: 52px"></div>
          <div class="skeleton" style="height: 52px"></div>
          <div class="skeleton" style="height: 52px"></div>
        </div>

        <div v-else-if="error" class="banner banner-err" style="margin: var(--sp-3)">
          {{ error }}
          <button class="btn btn-sm right" @click="retryLoad">Retry</button>
        </div>

        <div v-else-if="!sorted.length" class="empty">
          <span class="empty-icon">▢</span>
          <span>{{ filter ? 'No projects match' : 'No projects yet' }}</span>
          <span v-if="!filter" class="empty-hint">Create one with ＋ New</span>
        </div>

        <button v-for="p in sorted" :key="p.name" class="proj-row"
                :class="{'proj-row-active': router.project === p.name}"
                @click="select(p)">
          <div class="row" style="width: 100%">
            <span class="dot" :class="{'dot-pulse': runStateMeta(runStateOf(p)).pulse}"
                  :style="{'--dot-c': runStateMeta(runStateOf(p)).color}"></span>
            <span class="bold truncate grow">{{ p.name }}</span>
            <span v-if="p.hasNextBrief" class="dot" style="--dot-c: var(--orange)" title="Next brief queued"></span>
            <span class="xs muted nowrap">{{ phaseLabel(p) }}</span>
          </div>
          <div class="row" style="width: 100%; margin-top: 5px">
            <span class="xs nowrap" :style="{ color: runStateMeta(runStateOf(p)).color }">
              {{ runStateMeta(runStateOf(p)).label }}<span v-if="runIsStale(p)" title="auto-run row says running but no live process"> ⚠</span>
            </span>
            <span class="xs muted right nowrap">{{ fmtMoney(p.cost?.total_cost) }}</span>
          </div>
          <div class="progress" style="margin-top: 6px; height: 4px" v-if="p.total_phases"
               role="progressbar" aria-label="Project phase progress" aria-valuemin="0"
               :aria-valuemax="p.total_phases" :aria-valuenow="p.current_phase">
            <div class="progress-fill" :style="{
              width: pct(p.current_phase, p.total_phases) + '%',
              '--fill-c': runStateMeta(runStateOf(p)).color }"></div>
          </div>
        </button>
      </div>
    </aside>
  `,
};
