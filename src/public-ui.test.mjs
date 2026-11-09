import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const publicRoot = new URL('./public/', import.meta.url);

async function source(relative) {
  return readFile(new URL(relative, publicRoot), 'utf8');
}

test('API errors preserve status and structured diagnostics', async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => 'token', setItem() {}, removeItem() {} };
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: 'NAS sync failed',
    code: 'NAS_DOWN',
    log: ['ssh: connection refused'],
    details: { target: 'tara' },
  }), { status: 502, headers: { 'content-type': 'application/json' } });

  try {
    const { api, ApiError, apiErrorLines } = await import('./public/js/lib/api.js');
    await assert.rejects(
      () => api('POST', '/nas/sync', { op: 'push-code' }),
      (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 502);
        assert.equal(error.code, 'NAS_DOWN');
        assert.deepEqual(error.log, ['ssh: connection refused']);
        assert.deepEqual(apiErrorLines(error), [
          'ssh: connection refused',
          JSON.stringify({ target: 'tara' }, null, 2),
        ]);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalStorage;
  }
});

test('config editor sends explicit nulls for touched inherited values', async () => {
  const config = await source('js/components/tabs/ConfigTab.js');
  assert.match(config, /body\[key\] = f\[key\] === '' \|\| f\[key\] === null \? null/);
  assert.match(config, /body\[key\] = \(f\[key\] \?\? ''\)\.trim\(\) \|\| null/);
  assert.match(config, /reset:\s*true/);
  assert.match(config, /if \(this\.dirty\[key\]\) body\[key\] = f\[key\]/);
  assert.match(config, /const expectedVersion = this\.loadedVersion/);
  assert.match(config, /expectedVersion,/);
  assert.match(config, /router\.project !== name/);
  assert.match(config, /const fresh = await store\.loadDetail\(name, \{ silent: true \}\)/);
  assert.match(config, /this\.mutationLocked/);
  assert.match(config, /e\?\.status === 409/);
  assert.match(config, /Number\.isInteger/);
});

test('global and suggested actions revalidate locks and retain accessible fallbacks', async () => {
  const storeSource = await source('js/lib/store.js');
  const header = await source('js/components/AppHeader.js');
  const next = await source('js/components/widgets/NextActions.js');
  assert.match(storeSource, /Invalid projects response: expected an array/);
  assert.match(storeSource, /const rows = await this\.loadProjects\(\{ silent: true \}\)/);
  assert.match(storeSource, /current queue locks are checked again/i);
  assert.match(header, /aria-label="Stop all running projects"/);
  assert.match(header, /Restart previous projects:/);
  assert.match(next, /aria-label="Command to copy manually"/);
  assert.match(next, /navigator\.clipboard\?\.writeText/);
});

test('brief editor protects concurrent and unsaved work', async () => {
  const brief = await source('js/components/tabs/BriefTab.js');
  const router = await source('js/lib/router.js');
  assert.match(brief, /expectedMtime/);
  assert.match(brief, /e\.status === 409/);
  assert.match(brief, /beforeunload/);
  assert.match(brief, /registerNavigationGuard/);
  assert.match(brief, /ashmero_brief_drafts_v1/);
  assert.match(brief, /persistDraft/);
  assert.match(router, /export function registerNavigationGuard/);
});

test('audit promotion and terminal stop carry exact cancellation identities', async () => {
  const phases = await source('js/components/tabs/PhasesTab.js');
  const terminal = await source('js/components/modals/TerminalModal.js');
  assert.match(phases, /\{ auditFile \}/);
  assert.match(phases, /Choose audit artifact/);
  assert.doesNotMatch(phases, /promote-audit', undefined/);
  assert.match(terminal, /new AbortController\(\)/);
  assert.match(terminal, /\{ signal: controller\.signal \}/);
  assert.match(terminal, /controller\.abort\(\)/);
});

test('every modal uses the shared focus trap and restoration helper', async () => {
  const names = ['ConfirmModal', 'CallDetailModal', 'NewProjectModal', 'TerminalModal', 'NasSyncModal'];
  for (const name of names) {
    const modal = await source(`js/components/modals/${name}.js`);
    assert.match(modal, /openModal/);
    assert.match(modal, /handleModalKey/);
    assert.match(modal, /closeModal/);
    assert.match(modal, /ref="backdrop"/);
  }
});

test('responsive and accessibility styles retain critical safeguards', async () => {
  const tokens = await source('css/tokens.css');
  const base = await source('css/base.css');
  const components = await source('css/components.css');
  assert.match(tokens, /--radius: var\(--r-sm\)/);
  assert.match(base, /prefers-reduced-motion: reduce/);
  assert.match(components, /\.toast-warn/);
  assert.match(components, /\.artifacts-layout/);
  assert.match(components, /\.input:focus-visible/);
});

test('read surfaces fence stale responses and unscoped activity cannot navigate', async () => {
  const artifacts = await source('js/components/tabs/ArtifactsTab.js');
  const inbox = await source('js/components/tabs/InboxTab.js');
  const calls = await source('js/components/widgets/CallsTable.js');
  const healing = await source('js/components/widgets/HealingFeed.js');
  const activity = await source('js/components/widgets/ActivityFeed.js');
  const chat = await source('js/components/ChatView.js');

  assert.match(artifacts, /requestId !== this\.listRequestId \|\| this\.projectName !== project/);
  assert.match(artifacts, /requestId !== this\.fileRequestId \|\| this\.projectName !== project \|\| this\.selectedPath !== path/);
  assert.match(inbox, /requestId !== this\.requestId \|\| this\.projectName !== project/);
  assert.match(calls, /this\.phase !== phase \|\| this\.pageSize !== pageSize/);
  assert.match(healing, /requestId !== this\.requestId \|\| this\.project !== project/);
  assert.match(activity, /if \(!name\) return/);
  assert.match(activity, /v-if="!project && it\.project"/);
  assert.match(activity, />Unscoped<\/span>/);
  assert.match(chat, /requestId !== this\.threadsRequestId/);
  assert.match(chat, /requestId !== this\.openRequestId/);

  const phases = await source('js/components/tabs/PhasesTab.js');
  const runs = await source('js/components/tabs/RunsTab.js');
  assert.match(phases, /this\.routingRequestIds\[n\] !== requestId/);
  assert.match(phases, /this\.reportRequestIds\[n\] !== requestId/);
  assert.match(phases, /this\.auditRequestId !== requestId/);
  assert.match(runs, /requestId !== this\.requestId \|\| this\.name !== name/);
  assert.match(runs, /this\.timelineRequestIds\[runId\] !== requestId/);
});

test('inbox drafts persist per project and bulk promotion is sequential with row errors', async () => {
  const inboxSource = await source('js/components/tabs/InboxTab.js');
  assert.match(inboxSource, /ashmero:inbox-draft:v1:/);
  assert.match(inboxSource, /localStorage\.setItem\(key/);
  assert.match(inboxSource, /beforeUnmount\(\)[\s\S]*persistDraft/);
  assert.match(inboxSource, /item\.priority \|\| 'unassigned'/);
  assert.match(inboxSource, /for \(const id of ids\)[\s\S]*await api\('POST', base \+ '\/' \+ id \+ '\/promote'\)/);
  assert.match(inboxSource, /rowErrors\[result\.id\] = result\.reason\?\.message/);

  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  const storage = new Map();
  let restoreConfirm = null;
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };

  try {
    const { InboxSection } = await import('./public/js/components/tabs/InboxTab.js');
    const { store } = await import('./public/js/lib/store.js');
    const originalConfirm = store.confirmAction;
    const originalRevalidate = store.revalidateProjectMutationLock;
    store.confirmAction = async () => true;
    // bulkPromote re-checks the project mutation lock over HTTP before writing;
    // stub it so the fetch mock below only sees the two promote calls.
    store.revalidateProjectMutationLock = async () => null;
    restoreConfirm = () => {
      store.confirmAction = originalConfirm;
      store.revalidateProjectMutationLock = originalRevalidate;
    };
    const methods = InboxSection.methods;
    const draft = {
      kind: 'bug', projectName: 'alpha', text: 'keep this capture', severity: 'major',
      draftKey: methods.draftKey,
    };
    methods.persistDraft.call(draft, 'alpha');
    draft.text = '';
    draft.severity = 'unassigned';
    methods.restoreDraft.call(draft, 'alpha');
    assert.equal(draft.text, 'keep this capture');
    assert.equal(draft.severity, 'major');

    const pending = [];
    const calls = [];
    globalThis.fetch = (url) => new Promise((resolve) => {
      calls.push(url);
      pending.push(resolve);
    });
    let finished = null;
    const bulk = {
      selectedIds: [11, 12],
      bulkBusy: false,
      projectName: 'alpha',
      base: '/projects/alpha/bugs',
      bulkRequestId: 0,
      kind: 'bug',
      cfg: { noun: 'bug', nounPlural: 'bugs' },
      finishBulk: async (...args) => { finished = args; },
    };
    const operation = methods.bulkPromote.call(bulk);
    // confirm + lock revalidation run before the first request; let them settle.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1, 'second promotion must wait for the first response');
    pending[0](new Response(JSON.stringify({ status: 'promoted' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 2);
    pending[1](new Response(JSON.stringify({ status: 'promoted' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    await operation;
    assert.deepEqual(finished[0].map((result) => result.id), [11, 12]);
  } finally {
    restoreConfirm?.();
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalStorage;
  }
});

test('newer artifact, inbox, calls, and healing requests stay authoritative', async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

  const response = (value) => new Response(JSON.stringify(value), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  const pendingFetches = () => {
    const pending = [];
    globalThis.fetch = (url) => new Promise((resolve) => pending.push({ url, resolve }));
    return pending;
  };

  try {
    const [{ default: ArtifactsTab }, { InboxSection }, { default: CallsTable }, { default: HealingFeed }] =
      await Promise.all([
        import('./public/js/components/tabs/ArtifactsTab.js'),
        import('./public/js/components/tabs/InboxTab.js'),
        import('./public/js/components/widgets/CallsTable.js'),
        import('./public/js/components/widgets/HealingFeed.js'),
      ]);

    {
      const pending = pendingFetches();
      const vm = {
        ...ArtifactsTab.data(), ...ArtifactsTab.methods,
        projectName: 'alpha', selectedPath: 'a.md',
      };
      const first = vm.loadFile('a.md');
      vm.selectedPath = 'b.md';
      const second = vm.loadFile('b.md');
      assert.equal(pending.length, 2);
      pending[0].resolve(response({ path: 'a.md', content: 'stale' }));
      await first;
      assert.equal(vm.file, null);
      assert.equal(vm.fileLoading, true, 'stale finally must not clear the active spinner');
      pending[1].resolve(response({ path: 'b.md', content: 'current' }));
      await second;
      assert.equal(vm.file.content, 'current');
      assert.equal(vm.fileLoading, false);
    }

    {
      const pending = pendingFetches();
      const vm = {
        ...InboxSection.data(), ...InboxSection.methods,
        kind: 'bug', projectName: 'alpha', base: '/projects/alpha/bugs',
      };
      const first = vm.reload();
      vm.projectName = 'beta';
      vm.base = '/projects/beta/bugs';
      const second = vm.reload();
      pending[0].resolve(response([{ id: 1, raw_text: 'stale' }]));
      await first;
      assert.equal(vm.items, null);
      assert.equal(vm.loading, true);
      pending[1].resolve(response([{ id: 2, raw_text: 'current' }]));
      await second;
      assert.equal(vm.items[0].id, 2);
      assert.equal(vm.loading, false);
    }

    {
      const pending = pendingFetches();
      const vm = {
        ...CallsTable.data.call({ compact: false }), ...CallsTable.methods,
        compact: false, project: 'alpha', phase: null,
      };
      const first = vm.fetchRows();
      vm.project = 'beta';
      const second = vm.fetchRows();
      pending[0].resolve(response([{ id: 1, task: 'stale' }]));
      await first;
      assert.deepEqual(vm.rows, []);
      assert.equal(vm.loading, true);
      pending[1].resolve(response([{ id: 2, task: 'current' }]));
      await second;
      assert.equal(vm.rows[0].id, 2);
      assert.equal(vm.loading, false);
    }

    {
      const pending = pendingFetches();
      const vm = {
        ...HealingFeed.data(), ...HealingFeed.methods,
        project: 'alpha',
      };
      const first = vm.load();
      vm.project = 'beta';
      const second = vm.load();
      pending[0].resolve(response([{ id: 1, error_kind: 'stale' }]));
      await first;
      assert.equal(vm.rows, null);
      assert.equal(vm.loading, true);
      pending[1].resolve(response([{ id: 2, error_kind: 'current' }]));
      await second;
      assert.equal(vm.rows[0].id, 2);
      assert.equal(vm.loading, false);
    }
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalStorage;
  }
});
