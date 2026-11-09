// Tiny hash router. Routes: #/ (dashboard) · #/chat · #/p/<name> · #/p/<name>/<tab>
// Last route persists in localStorage so a refresh restores context.

import { reactive } from '../../vendor/vue.esm-browser.prod.js';

const ROUTE_KEY = 'ashmero_route';
const navigationGuards = new Set();
let lastAppliedHash = '#/';
let approvedHash = null;

export const TABS = ['overview', 'phases', 'runs', 'inbox', 'brief', 'artifacts', 'suggestions', 'operations', 'config'];

export const router = reactive({
  view: 'dashboard',   // 'dashboard' | 'project' | 'chat'
  project: null,       // project name when view === 'project'
  tab: 'overview',
});

function parse(hash) {
  const parts = (hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'chat') {
    return { view: 'chat', project: null, tab: 'overview' };
  }
  if (parts[0] === 'p' && parts[1]) {
    const tab = TABS.includes(parts[2]) ? parts[2] : 'overview';
    try { return { view: 'project', project: decodeURIComponent(parts[1]), tab }; }
    catch { return { view: 'dashboard', project: null, tab: 'overview' }; }
  }
  return { view: 'dashboard', project: null, tab: 'overview' };
}

function apply(hash) {
  const r = parse(hash);
  router.view = r.view;
  router.project = r.project;
  router.tab = r.tab;
  try { localStorage.setItem(ROUTE_KEY, hash || '#/'); } catch { /* private mode */ }
  lastAppliedHash = hash || '#/';
}

export function navigate(hash) {
  if (location.hash === hash) return;
  if (!canNavigate(hash)) return false;
  approvedHash = hash;
  location.hash = hash; // hashchange listener applies it
  return true;
}

// Non-route actions such as logging out also unmount editors. Let them honor
// the same dirty-state contract before they discard the current view.
export function canNavigate(destination = '#/') {
  for (const guard of navigationGuards) {
    try { if (guard(destination) === false) return false; }
    catch { return false; }
  }
  return true;
}

// Register a synchronous navigation blocker. This intentionally mirrors the
// browser's beforeunload contract: editors can ask the user before a tab,
// project, browser-back, or direct hash navigation discards unsaved work.
export function registerNavigationGuard(guard) {
  navigationGuards.add(guard);
  return () => navigationGuards.delete(guard);
}

export function projectHash(name, tab = null) {
  // Opening a project from the dashboard/sidebar should return to that
  // project's last tab. Callers that need a specific destination (for example
  // Next Actions → Brief) still pass it explicitly.
  if (tab == null) {
    try {
      const saved = localStorage.getItem('ashmero_tab_' + name);
      tab = TABS.includes(saved) ? saved : 'overview';
    } catch {
      tab = 'overview';
    }
  }
  return tab && tab !== 'overview'
    ? `#/p/${encodeURIComponent(name)}/${tab}`
    : `#/p/${encodeURIComponent(name)}`;
}

export function initRouter() {
  window.addEventListener('hashchange', () => {
    const next = location.hash || '#/';
    if (approvedHash === next) {
      approvedHash = null;
      apply(next);
      return;
    }
    if (!canNavigate(next)) {
      history.replaceState(null, '', lastAppliedHash || '#/');
      return;
    }
    apply(next);
  });
  if (!location.hash || location.hash === '#/' || location.hash === '#') {
    let saved = null;
    try { saved = localStorage.getItem(ROUTE_KEY); } catch { /* noop */ }
    if (saved && saved !== '#/') {
      location.hash = saved;
      // hashchange fires and applies; but apply now too in case it doesn't (same hash)
      apply(saved);
      return;
    }
  }
  apply(location.hash);
}
