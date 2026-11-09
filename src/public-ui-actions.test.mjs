import test from 'node:test';
import assert from 'node:assert/strict';

import {
  commandTokens,
  tabOf,
  verbOf,
} from './public/js/components/widgets/NextActions.js';
import { normalizeQualityReport } from './public/js/components/tabs/OverviewTab.js';
import RunsTab from './public/js/components/tabs/RunsTab.js';
import { store } from './public/js/lib/store.js';

test('next-action routing reads exact action tokens, never project names or option text', () => {
  assert.equal(verbOf('/run alpha go --auto'), 'go');
  assert.equal(verbOf('/run "project with spaces" resume'), 'resume');
  assert.equal(verbOf('npm run next -- alpha --note abort'), 'next');
  assert.equal(verbOf('npm run pipeline -- alpha'), 'launch');

  assert.equal(verbOf('/run resume-dashboard audit --note next'), null);
  assert.equal(verbOf('/run next-release roadmap --reason abort'), null);
  assert.equal(verbOf('npm run inspect -- resume-project'), null);
  assert.equal(verbOf('please go sync the project'), null);
  assert.equal(verbOf('/cancel'), null);
});

test('next-action tab routing is based on exact commands and parsed options', () => {
  assert.equal(tabOf('/preview resume-project plan'), 'artifacts');
  assert.equal(tabOf('/run config-dashboard audit --auto'), 'operations');
  assert.equal(tabOf('npm run guide -- next-project --task plan'), 'operations');
  assert.equal(tabOf('npm run guide -- alpha --task=plan'), 'operations');
  assert.equal(tabOf('npm run guide -- alpha --task bug-plan'), null);
  assert.equal(tabOf('npm run inspect -- audit-project'), null);
  assert.equal(tabOf('/project audit-resume-next'), 'overview');
  assert.equal(tabOf('random text mentioning config and inbox'), null);
});

test('next-action tokenizer keeps quoted project names and escaped spaces intact', () => {
  assert.deepEqual(commandTokens('/run "release next" go --note=resume'), [
    '/run', 'release next', 'go', '--note=resume',
  ]);
  assert.deepEqual(commandTokens('npm run go -- release\\ candidate'), [
    'npm', 'run', 'go', '--', 'release candidate',
  ]);
});

test('overview quality normalization makes partial legacy payloads safe to render', () => {
  const normalized = normalizeQualityReport({
    acceptance: null,
    tasks: null,
    rounds: 'legacy',
    cache_trend: {},
    context_compiler: { samples: null, accuracy: null, tokens: null, rollout: [] },
  });
  assert.deepEqual(normalized.acceptance, {});
  assert.deepEqual(normalized.tasks, []);
  assert.deepEqual(normalized.rounds, []);
  assert.deepEqual(normalized.cache_trend, []);
  assert.deepEqual(normalized.context_compiler.samples, {});
  assert.deepEqual(normalized.context_compiler.accuracy, {});
  assert.deepEqual(normalized.context_compiler.tokens, {});
  assert.equal(normalized.context_compiler.rollout, null);
  assert.equal(normalizeQualityReport(null), null);
  assert.equal(normalizeQualityReport([]), null);
});

test('run event detail tolerates JSON null and primitive legacy details', () => {
  assert.equal(RunsTab.methods.eventDetail({ detail: 'null' }), 'null');
  assert.equal(RunsTab.methods.eventDetail({ detail: '42' }), '42');
  assert.equal(RunsTab.methods.eventDetail({ detail: '{"phase":2,"reason":"pause"}' }), 'reason: pause');
  assert.equal(RunsTab.methods.eventDetail(null), '');
});

test('project action rechecks queue state after confirmation before POST', async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  const originalConfirm = store.confirmAction;
  const originalToast = store.toast;
  const originalProjects = store.state.projects;
  const originalLoaded = store.state.projectsLoaded;
  const requests = [];
  globalThis.localStorage = { getItem: () => 'token', setItem() {}, removeItem() {} };
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET' });
    if (url.endsWith('/forecast')) {
      return new Response(JSON.stringify({ project: 'alpha', mode: 'idle', totalUnits: 0 }), { status: 200 });
    }
    if (url === '/api/projects') {
      return new Response(JSON.stringify([{ name: 'alpha', pendingJob: { action: 'audit' } }]), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  store.confirmAction = async () => true;
  store.toast = () => {};
  store.state.projects = [{ name: 'alpha', pendingJob: null }];

  try {
    const result = await store.projectAction('alpha', 'go');
    assert.equal(result, null);
    assert.equal(requests.some((request) => request.method === 'POST'), false);
    assert.equal(requests.filter((request) => request.url === '/api/projects').length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalStorage;
    store.confirmAction = originalConfirm;
    store.toast = originalToast;
    store.state.projects = originalProjects;
    store.state.projectsLoaded = originalLoaded;
  }
});
