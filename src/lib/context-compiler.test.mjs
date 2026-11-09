import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const {
  compileContextManifest,
  contextCompilerConfigFingerprint,
  contextCompilerInjects,
  extractTaskTerms,
  filterContextManifest,
  inferTaskPackageScopes,
  loadContextManifest,
  persistContextManifest,
  prioritizeContextCandidatePaths,
  renderCompiledContextBlock,
  resolveCompiledContextUse,
  resolveContextCompilerConfig,
} = await import('./context-compiler.js');

test('monorepo scope inference and candidate ordering keep the active package ahead of scan truncation', () => {
  const explicit = ['packages/consent/src/capture.js'];
  assert.deepEqual(inferTaskPackageScopes(explicit), ['packages/consent/']);
  assert.deepEqual(inferTaskPackageScopes(['src/capture.js']), [], 'ordinary src tree is not misclassified as a package');
  const ordered = prioritizeContextCandidatePaths([
    'packages/unrelated/src/consent-cache.js',
    'apps/web/src/home.js',
    'packages/consent/tests/capture.test.js',
    'packages/consent/src/capture.js',
  ], { explicitPaths: explicit, terms: ['consent'], packageScopes: ['packages/consent/'] });
  assert.equal(ordered[0], 'packages/consent/src/capture.js');
  assert.equal(ordered[1], 'packages/consent/tests/capture.test.js');
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aorch-context-compiler-'));
  const projDir = path.join(root, 'sample');
  const workspaceDir = path.join(projDir, 'workspace');
  await fs.mkdir(path.join(workspaceDir, 'src', 'replies'), { recursive: true });
  await fs.mkdir(path.join(workspaceDir, 'tests', 'replies'), { recursive: true });
  await fs.mkdir(path.join(workspaceDir, 'config'), { recursive: true });
  const files = [
    {
      path: 'src/replies/capture-consent.js', lang: 'javascript',
      content: `export function captureConsent(reply, auditTrail) {\n  return auditTrail.record(reply.channel);\n}\n`,
    },
    {
      path: 'src/replies/channel-selector.js', lang: 'javascript',
      content: `import { captureConsent } from './capture-consent.js';\nexport function selectReplyChannel(reply) { return captureConsent(reply); }\n`,
    },
    {
      path: 'tests/replies/capture-consent.test.js', lang: 'javascript',
      content: `import { captureConsent } from '../../src/replies/capture-consent.js';\ntest('captures consent audit trail', () => captureConsent({ channel: 'sms' }, audit));\n`,
    },
    {
      path: 'config/consent.schema.json', lang: 'json',
      content: `{"captureOnReply":{"type":"boolean"}}`,
    },
    {
      path: 'src/unrelated.js', lang: 'javascript',
      content: `export function unrelatedCacheCleanup() { return true; }\n`,
    },
  ];
  for (const file of files) {
    const target = path.join(workspaceDir, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content);
  }
  return { root, projDir, workspaceDir, files };
}

function compilerCfg(mode = 'shadow') {
  return {
    context_compiler: {
      enabled: true,
      mode,
      provider: 'hybrid-lexical',
      max_files: 4,
      max_symbols: 8,
      min_confidence: 0.5,
      token_budget: { low: 300, medium: 500, high: 700, critical: 700, fix: 300, repair: 350, hard_max: 800 },
    },
  };
}

async function compileAssociationFixture({
  sourcePath = 'src/accounts/index.js',
  testPath = 'tests/index.test.js',
  testContent = "test('unrelated entrypoint', () => {});\n",
  relations = [],
} = {}) {
  const baseSha = 'f'.repeat(40);
  const contextProvider = {
    name: 'association-fixture',
    collectCandidates: async () => ({
      cacheSha: baseSha,
      files: [
        { path: sourcePath, lang: path.extname(sourcePath).slice(1), content: 'export function accountRegistry() { return true; }\n' },
        { path: testPath, lang: path.extname(testPath).slice(1), content: testContent },
      ],
      relations,
    }),
  };
  const cfg = compilerCfg();
  cfg.context_compiler.max_files = 8;
  cfg.context_compiler.min_confidence = 0;
  return compileContextManifest({
    workspaceDir: '/tmp',
    projDir: '/tmp',
    projectName: 'association-fixture',
    baseSha,
    task: {
      task_kind: 'phase',
      title: 'Account registry behavior',
      explicit_paths: [sourcePath],
    },
    cfg,
    throwOnError: true,
  }, {
    contextProvider,
    persistContextManifest: async () => '/tmp/association-fixture.json',
  });
}

test('extractTaskTerms finds explicit paths, identifiers, and normalized criteria', () => {
  const result = extractTaskTerms({
    title: 'Capture consent through `captureConsent`',
    acceptance_criteria: ['Write an audit trail'],
    files_expected: ['src/replies/capture-consent.js'],
  });
  assert.ok(result.exactIdentifiers.includes('captureconsent'));
  assert.ok(result.terms.includes('consent'));
  assert.ok(result.explicitPaths.includes('src/replies/capture-consent.js'));
  assert.equal(result.criteria[0].id, 'AC-1');
});

test('compileContextManifest ranks explicit production code and its importing test, maps criteria, and persists bounded context', async () => {
  const fx = await fixture();
  const persisted = new Map();
  const task = {
    task_kind: 'phase', phase: 4, complexity: 'medium',
    title: 'Opt-in capture on reply and consent audit trail',
    goal: 'Call captureConsent and enforce suppression during channel selection',
    criteria: [
      { id: 'AC-1', text: 'Capture consent when a valid reply arrives' },
      { id: 'AC-2', text: 'Record the consent action in the audit trail' },
    ],
    explicit_paths: ['src/replies/capture-consent.js'],
  };
  const manifest = await compileContextManifest({
    workspaceDir: fx.workspaceDir, projDir: fx.projDir, projectName: 'sample',
    task, cfg: compilerCfg(), baseSha: 'abc123',
  }, {
    readRepoMapCache: async () => ({ sha: 'abc123', tree: '', files: fx.files }),
    persistContextManifest: async (value) => { persisted.set(value.manifest_id, value); return `/tmp/${value.manifest_id}.json`; },
  });

  assert.ok(manifest);
  assert.equal(manifest.ranked_files[0].path, 'src/replies/capture-consent.js');
  assert.ok(manifest.ranked_files.some((file) => file.path === 'tests/replies/capture-consent.test.js'));
  assert.ok(manifest.ranked_symbols.some((symbol) => symbol.name === 'captureConsent'));
  assert.ok(manifest.criteria_map.every((criterion) => criterion.production_files.includes('src/replies/capture-consent.js')));
  assert.ok(manifest.test_plan.targeted_files.includes('tests/replies/capture-consent.test.js'));
  assert.ok(manifest.confidence >= 0.5);
  assert.ok(persisted.has(manifest.manifest_id));

  const block = renderCompiledContextBlock(manifest, { maxTokens: 220 });
  assert.match(block, /compiled_context/);
  assert.match(block, /capture-consent\.js/);
  assert.ok(Math.ceil(block.length / 4) <= 220, 'rendered prompt obeys the requested token budget');
});

test('related-test inference rejects a generic basename without path, package, or import evidence', async () => {
  const manifest = await compileAssociationFixture();
  const source = manifest.ranked_files.find((file) => file.path === 'src/accounts/index.js');
  assert.ok(source);
  assert.deepEqual(source.related_tests, []);
  assert.equal(manifest.test_plan.targeted_files.includes('tests/index.test.js'), false);
});

test('related-test inference accepts mirrored path affinity without requiring an import', async () => {
  const manifest = await compileAssociationFixture({ testPath: 'tests/accounts/index.test.js' });
  const source = manifest.ranked_files.find((file) => file.path === 'src/accounts/index.js');
  assert.deepEqual(source.related_tests, ['tests/accounts/index.test.js']);
  assert.ok(manifest.test_plan.targeted_files.includes('tests/accounts/index.test.js'));
});

test('related-test inference accepts resolved import evidence despite a generic test path', async () => {
  const manifest = await compileAssociationFixture({
    testContent: "import { accountRegistry } from '../src/accounts/index.js';\ntest('registry', () => accountRegistry());\n",
  });
  const source = manifest.ranked_files.find((file) => file.path === 'src/accounts/index.js');
  assert.deepEqual(source.related_tests, ['tests/index.test.js']);
});

test('related-test inference accepts descriptive same-package tests in flattened monorepo layouts', async () => {
  const sourcePath = 'packages/api/src/services/user.js';
  const testPath = 'packages/api/tests/user.test.js';
  const manifest = await compileAssociationFixture({ sourcePath, testPath });
  const source = manifest.ranked_files.find((file) => file.path === sourcePath);
  assert.deepEqual(source.related_tests, [testPath]);
});

test('task fingerprint is deterministic for the same task and SHA', async () => {
  const fx = await fixture();
  const deps = {
    readRepoMapCache: async () => ({ sha: 'same-sha', tree: '', files: fx.files }),
    persistContextManifest: async () => '/tmp/manifest.json',
  };
  const args = {
    workspaceDir: fx.workspaceDir, projDir: fx.projDir, projectName: 'sample',
    task: { task_kind: 'phase', phase: 1, title: 'Capture consent', criteria: ['Consent is captured'] },
    cfg: compilerCfg(), baseSha: 'same-sha',
  };
  const first = await compileContextManifest(args, deps);
  const second = await compileContextManifest(args, deps);
  assert.equal(first.manifest_id, second.manifest_id);
  const changedMode = await compileContextManifest({
    ...args,
    cfg: { ...args.cfg, context_compiler: { ...args.cfg.context_compiler, mode: 'assist' } },
  }, deps);
  assert.notEqual(first.manifest_id, changedMode.manifest_id, 'effective compiler config participates in the artifact fingerprint');

  const changedTask = await compileContextManifest({
    ...args,
    task: { ...args.task, complexity: 'high', checkpoint: 'architecture', explicit_symbols: ['captureConsent'] },
  }, deps);
  assert.notEqual(first.manifest_id, changedTask.manifest_id, 'complexity/checkpoint/symbol inputs cannot collide');

  const changedScan = await compileContextManifest({
    ...args,
    cfg: {
      ...args.cfg,
      context_compiler: { ...args.cfg.context_compiler, max_scan_files: 999, timeout_ms: { warm: 5000, cold: 15000 } },
    },
  }, deps);
  assert.notEqual(first.manifest_id, changedScan.manifest_id, 'scan and timeout settings participate in the artifact fingerprint');
});

test('compiler evidence fingerprint changes when timeout behavior changes', () => {
  const base = { enabled: true, provider: 'hybrid-lexical', timeout_ms: { warm: 10000, cold: 45000 } };
  assert.notEqual(
    contextCompilerConfigFingerprint(base),
    contextCompilerConfigFingerprint({ ...base, timeout_ms: { warm: 12000, cold: 45000 } }),
  );
});

test('compiler evidence fingerprint changes when rollout measurement policy changes', () => {
  const base = {
    enabled: true,
    provider: 'hybrid-lexical',
    rollout: { window_size: 20, promotion: { min_recall: 0.8 } },
  };
  assert.notEqual(
    contextCompilerConfigFingerprint(base),
    contextCompilerConfigFingerprint({
      ...base,
      rollout: { ...base.rollout, promotion: { min_recall: 0.9 } },
    }),
  );
});

test('max_reference_depth bounds provider relation expansion', async () => {
  const fx = await fixture();
  const provider = {
    name: 'semantic-fixture',
    collectCandidates: async () => ({
      cacheSha: 'chain-sha',
      files: [
        { path: 'src/target.js', content: 'export function exactTarget() {}' },
        { path: 'src/middle.js', content: 'export function middle() {}' },
        { path: 'src/outer.js', content: 'export function outer() {}' },
      ],
      relations: [
        { type: 'calls', from: 'src/middle.js', to: 'src/target.js' },
        { type: 'calls', from: 'src/outer.js', to: 'src/middle.js' },
      ],
    }),
  };
  const compile = (depth) => compileContextManifest({
    workspaceDir: fx.workspaceDir, projDir: fx.projDir, projectName: 'sample', baseSha: 'chain-sha',
    task: { task_kind: 'phase', title: 'exactTarget', explicit_paths: ['src/target.js'] },
    cfg: {
      context_compiler: {
        enabled: true, provider: 'semantic-fixture', fallback: [], max_reference_depth: depth,
        max_files: 10, min_confidence: 0, token_budget: { medium: 300, hard_max: 300 },
      },
    },
  }, { contextProvider: provider, persistContextManifest: async () => '/tmp/chain.json' });

  const oneHop = await compile(1);
  const twoHops = await compile(2);
  assert.ok(oneHop.ranked_files.some((file) => file.path === 'src/middle.js'));
  assert.ok(!oneHop.ranked_files.some((file) => file.path === 'src/outer.js'));
  assert.ok(twoHops.ranked_files.some((file) => file.path === 'src/outer.js'));
});

test('provider candidates enforce relative-path, byte-size, and scan-count bounds', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-provider-bounds-'));
  const workspaceDir = path.join(root, 'workspace');
  await fs.mkdir(workspaceDir, { recursive: true });
  const provider = {
    name: 'bounded-fixture',
    collectCandidates: async () => ({
      files: [
        { path: '../escape.js', content: 'export const secret = true;' },
        { path: '/absolute.js', content: 'export const absolute = true;' },
        { path: 'src/oversized.js', content: `export const huge = '${'x'.repeat(5000)}';` },
        { path: 'src/kept.js', content: 'export function keptFeature() {}' },
        { path: 'src/past-limit.js', content: 'export function pastLimit() {}' },
      ],
      relations: [
        { type: 'imports', from: '../escape.js', to: 'src/kept.js' },
        { type: 'imports', from: 'src/kept.js', to: 'src/past-limit.js' },
      ],
    }),
  };
  try {
    const manifest = await compileContextManifest({
      workspaceDir,
      projDir: root,
      projectName: 'bounded-provider',
      baseSha: 'b'.repeat(40),
      task: { task_kind: 'phase', title: 'kept feature', explicit_paths: ['src/kept.js'] },
      cfg: {
        context_compiler: {
          enabled: true,
          mode: 'shadow',
          provider: 'bounded-fixture',
          fallback: [],
          max_scan_files: 4,
          max_file_bytes: 1024,
        },
      },
    }, {
      contextProvider: provider,
      persistContextManifest: async () => '/tmp/bounded-manifest.json',
      warn: () => {},
    });
    assert.deepEqual(manifest.ranked_files.map((file) => file.path), ['src/kept.js']);
    assert.deepEqual(manifest.relations, []);
    assert.equal(manifest.candidate_counts.files, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('built-in scans do not follow tracked or explicit symlinks outside the workspace', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-symlink-bounds-'));
  const workspaceDir = path.join(root, 'workspace');
  const outsideDir = path.join(root, 'outside');
  await fs.mkdir(path.join(workspaceDir, 'src'), { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });
  const outsideFile = path.join(outsideDir, 'secret.js');
  await fs.writeFile(outsideFile, 'export function leakedSecret() { return true; }\n');
  await fs.symlink(outsideFile, path.join(workspaceDir, 'src', 'linked-secret.js'));
  try {
    const manifest = await compileContextManifest({
      workspaceDir,
      projDir: root,
      projectName: 'symlink-bounds',
      baseSha: 'c'.repeat(40),
      task: {
        task_kind: 'phase',
        title: 'leakedSecret',
        explicit_paths: ['src/linked-secret.js'],
      },
      cfg: compilerCfg(),
    }, {
      readRepoMapCache: async () => null,
      listTrackedFiles: async () => ({ ok: true, files: ['src/linked-secret.js'] }),
      persistContextManifest: async () => '/tmp/symlink-bounds.json',
      warn: () => {},
    });
    assert.equal(manifest.candidate_counts.files, 0);
    assert.deepEqual(manifest.ranked_files, []);
    assert.ok(manifest.warnings.some((warning) => warning.includes('explicit paths not found')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('compiler is disabled unless explicitly enabled; shadow never injects and assist does', async () => {
  assert.equal(resolveContextCompilerConfig({}).enabled, false);
  assert.equal(contextCompilerInjects({ context_compiler: { enabled: true, mode: 'shadow' } }), false);
  assert.equal(contextCompilerInjects({ context_compiler: { enabled: true, mode: 'assist' } }), true);
  assert.equal(contextCompilerInjects({ context_compiler: { enabled: false, mode: 'assist' } }), false);
});

test('enforce injects only complete, confident evidence and otherwise degrades to full verification', () => {
  const cfg = { context_compiler: { enabled: true, mode: 'enforce', min_confidence: 0.7 } };
  const complete = {
    confidence: 0.9,
    criteria_map: [{ criterion_id: 'AC-1', production_files: ['src/a.js'], production_symbols: [] }],
    test_plan: { requires_full_suite: false },
  };
  assert.deepEqual(resolveCompiledContextUse(cfg, complete), {
    inject: true,
    degraded: false,
    force_full_verification: false,
    reason: 'enforce-evidence-complete',
    criterion_coverage: 1,
  });

  const incomplete = { ...complete, confidence: 0.6, criteria_map: [{ criterion_id: 'AC-1', production_files: [], production_symbols: [] }] };
  const use = resolveCompiledContextUse(cfg, incomplete);
  assert.equal(use.inject, false);
  assert.equal(use.degraded, true);
  assert.equal(use.force_full_verification, true);
  assert.equal(use.reason, 'enforce-low-confidence');
});

test('compile failures fail open to null rather than stopping execution', async () => {
  const warnings = [];
  const manifest = await compileContextManifest({
    workspaceDir: '/missing/workspace', projDir: '/missing/project', projectName: 'sample',
    task: { title: 'anything' }, cfg: compilerCfg(), baseSha: null,
  }, {
    readRepoMapCache: async () => { throw new Error('index unavailable'); },
    listTrackedFiles: async () => { throw new Error('git unavailable'); },
    warn: (message) => warnings.push(message),
  });
  assert.equal(manifest, null);
  assert.match(warnings[0], /compile failed/);
});

test('persisted manifest loading is project-scoped and criterion filtering removes unrelated paths', async () => {
  const fx = await fixture();
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aorch-context-state-'));
  const previous = process.env.AORCH_CONTEXT_STATE_DIR;
  process.env.AORCH_CONTEXT_STATE_DIR = stateRoot;
  try {
    const manifest = await compileContextManifest({
      workspaceDir: fx.workspaceDir, projDir: fx.projDir, projectName: 'sample',
      task: {
        task_kind: 'phase', phase: 2, title: 'Consent capture',
        criteria: [{ id: 'AC-1', text: 'capture consent' }],
        explicit_paths: ['src/replies/capture-consent.js'],
      },
      cfg: compilerCfg(), baseSha: 'persist-sha',
    }, { readRepoMapCache: async () => ({ sha: 'persist-sha', tree: '', files: fx.files }) });
    const loaded = await loadContextManifest('sample', manifest.manifest_id);
    assert.equal(loaded.manifest_id, manifest.manifest_id);
    const filtered = filterContextManifest(loaded, { criterionId: 'AC-1' });
    assert.equal(filtered.criteria_map.length, 1);
    assert.ok(filtered.ranked_files.every((file) => filtered.criteria_map[0].production_files.includes(file.path) || filtered.criteria_map[0].tests.includes(file.path)));
    await assert.rejects(() => loadContextManifest('sample', '../../escape'), /64-character lowercase sha256/);
  } finally {
    if (previous == null) delete process.env.AORCH_CONTEXT_STATE_DIR;
    else process.env.AORCH_CONTEXT_STATE_DIR = previous;
  }
});

test('manifest persistence rejects a project state directory symlink that escapes the context root', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'aorch-context-persist-project-link-'));
  const stateRoot = path.join(temp, 'state');
  const outsideDir = path.join(temp, 'outside');
  await fs.mkdir(stateRoot);
  await fs.mkdir(outsideDir);
  await fs.symlink(outsideDir, path.join(stateRoot, 'escaped-project'));
  const previous = process.env.AORCH_CONTEXT_STATE_DIR;
  process.env.AORCH_CONTEXT_STATE_DIR = stateRoot;
  try {
    await assert.rejects(
      () => persistContextManifest({
        manifest_id: '7'.repeat(64), project: 'escaped-project', ranked_files: [],
      }),
      /unsafe context state path.*symbolic link/,
    );
    assert.deepEqual(await fs.readdir(outsideDir), [], 'no manifest or latest file may be written through the project symlink');
  } finally {
    if (previous == null) delete process.env.AORCH_CONTEXT_STATE_DIR;
    else process.env.AORCH_CONTEXT_STATE_DIR = previous;
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('manifest persistence rejects manifest and latest leaf symlinks without partial or outside writes', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'aorch-context-persist-leaf-link-'));
  const stateRoot = path.join(temp, 'state');
  await fs.mkdir(stateRoot);
  const previous = process.env.AORCH_CONTEXT_STATE_DIR;
  process.env.AORCH_CONTEXT_STATE_DIR = stateRoot;
  try {
    for (const [kind, digit] of [['manifest', '8'], ['latest', '9']]) {
      const project = `leaf-${kind}`;
      const manifestId = digit.repeat(64);
      const projectDir = path.join(stateRoot, project);
      const outsideFile = path.join(temp, `${kind}-outside.json`);
      const linkedLeaf = kind === 'manifest' ? `${manifestId}.json` : 'latest.json';
      const otherLeaf = kind === 'manifest' ? 'latest.json' : `${manifestId}.json`;
      await fs.mkdir(projectDir);
      await fs.writeFile(outsideFile, 'outside-sentinel');
      await fs.symlink(outsideFile, path.join(projectDir, linkedLeaf));

      await assert.rejects(
        () => persistContextManifest({ manifest_id: manifestId, project, ranked_files: [] }),
        /unsafe context state path.*destination must not be a symbolic link/,
      );
      assert.equal(await fs.readFile(outsideFile, 'utf8'), 'outside-sentinel');
      const otherExists = await fs.stat(path.join(projectDir, otherLeaf)).then(() => true, () => false);
      assert.equal(otherExists, false, 'both destinations are validated before the first artifact write');
    }
  } finally {
    if (previous == null) delete process.env.AORCH_CONTEXT_STATE_DIR;
    else process.env.AORCH_CONTEXT_STATE_DIR = previous;
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('manifest loading rejects project and leaf symlinks outside the context root', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'aorch-context-load-links-'));
  const stateRoot = path.join(temp, 'state');
  const outsideDir = path.join(temp, 'outside');
  await fs.mkdir(stateRoot);
  await fs.mkdir(outsideDir);
  const outsideManifest = path.join(outsideDir, 'manifest.json');
  await fs.writeFile(outsideManifest, JSON.stringify({ manifest_id: 'a'.repeat(64), leaked: true }));
  const previous = process.env.AORCH_CONTEXT_STATE_DIR;
  process.env.AORCH_CONTEXT_STATE_DIR = stateRoot;
  try {
    await fs.symlink(outsideDir, path.join(stateRoot, 'project-link'));
    await assert.rejects(
      () => loadContextManifest('project-link'),
      /unsafe context state path.*project directory must not be a symbolic link/,
    );

    const leafProject = path.join(stateRoot, 'leaf-link');
    await fs.mkdir(leafProject);
    await fs.symlink(outsideManifest, path.join(leafProject, 'latest.json'));
    await assert.rejects(
      () => loadContextManifest('leaf-link'),
      /unsafe context state path.*destination must not be a symbolic link/,
    );

    const manifestId = 'b'.repeat(64);
    const idProject = path.join(stateRoot, 'id-link');
    await fs.mkdir(idProject);
    await fs.symlink(outsideManifest, path.join(idProject, `${manifestId}.json`));
    await assert.rejects(
      () => loadContextManifest('id-link', manifestId),
      /unsafe context state path.*destination must not be a symbolic link/,
    );
  } finally {
    if (previous == null) delete process.env.AORCH_CONTEXT_STATE_DIR;
    else process.env.AORCH_CONTEXT_STATE_DIR = previous;
    await fs.rm(temp, { recursive: true, force: true });
  }
});
