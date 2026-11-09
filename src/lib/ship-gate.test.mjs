// Phase 44 (P1 ship gate) — deterministic secret / dependency / license scan.
//
// Run with: node --test src/lib/ship-gate.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.DB_PATH = ':memory:';

const {
  scanSecrets, deriveBaseline, diffDependencies, classifyAuditOutput,
  runShipGate, EMPTY_TREE_SHA,
} = await import('./ship-gate.js');
const { shipProject } = await import('../commands/ship.js');
const { getDb, upsertProject, setProjectGitConfig } = await import('../state.js');
const { shipGateReportPath } = await import('./guide-paths.js');

// Minimal ship_gate cfg injected into shipProject so the test doesn't depend on
// a real projects/<name>/project.json on disk (config-resolver reads that).
const GATE_CFG = { ship_gate: { enabled: true, audit_level: 'high', license_allowlist: ['MIT', 'ISC'] } };

// ─── git fixture helpers ─────────────────────────────────────────────────────

function git(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function initRepo(dir, { branch = 'main' } = {}) {
  git(dir, ['init', '-q', '-b', branch]);
  git(dir, ['config', 'user.email', 'test@ashmero.dev']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
}

async function commit(dir, file, content, message) {
  await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await fs.writeFile(path.join(dir, file), content, 'utf-8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

// ─── scanSecrets ─────────────────────────────────────────────────────────────

// One ADDED line per secret kind, each crafted so exactly one rule fires and
// no line contains a placeholder token. The Slack prefix is assembled at
// runtime so hosting-side secret scanners don't flag this fake fixture.
const SECRET_DIFF = `diff --git a/src/config.js b/src/config.js
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/config.js
+const aws = 'AKIA1234567890ABCDEF';
+fetch('ghp_0123456789abcdefghijABCDEFGHIJ012345');
+const pat = 'github_pat_11ABCDE0000aaaaBBBBccccDDeeee';
+const slack = '${'xo' + 'xb'}-123456789012-abcdefABCDEFghij';
+const tg = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ012345678';
+const pem = '-----BEGIN RSA PRIVATE KEY-----';
+const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
+password = 'sup3rSecretV4lue';
+const good = process.env.GITHUB_TOKEN;
+const apiKey = 'YOUR_API_KEY_HERE';
`;

test('scanSecrets: catches one fixture per secret kind, redacted to 6 chars + ellipsis', () => {
  const findings = scanSecrets(SECRET_DIFF);
  const kinds = new Set(findings.map((f) => f.kind));
  for (const k of ['aws-access-key', 'github-token', 'github-pat', 'slack-token', 'telegram-bot-token', 'private-key', 'jwt', 'generic-secret']) {
    assert.ok(kinds.has(k), `expected a ${k} finding, got kinds: ${[...kinds].join(', ')}`);
  }
  // Every excerpt is redacted: at most 6 leading chars + a single ellipsis.
  for (const f of findings) {
    assert.ok(f.excerpt.endsWith('…'), `excerpt not redacted: ${f.excerpt}`);
    const head = f.excerpt.slice(0, -1);
    assert.ok(head.length <= 6, `excerpt head too long (${head.length}): ${f.excerpt}`);
  }
});

test('scanSecrets: does NOT flag placeholder or process.env lines', () => {
  const findings = scanSecrets(SECRET_DIFF);
  // The YOUR_API_KEY_HERE and process.env lines must produce no finding.
  assert.ok(!findings.some((f) => f.excerpt.startsWith('YOUR_')), 'placeholder YOUR_ leaked');
  assert.ok(!findings.some((f) => /process/i.test(f.excerpt)), 'process.env reference flagged');
  // Exactly the 8 real kinds — the two negatives add nothing.
  assert.equal(findings.length, 8, `expected 8 findings, got ${findings.length}: ${JSON.stringify(findings)}`);
});

test('scanSecrets: skips lockfiles', () => {
  const diff = `diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
+  "integrity": "AKIA1234567890ABCDEF"
`;
  assert.equal(scanSecrets(diff).length, 0);
});

// ─── deriveBaseline ──────────────────────────────────────────────────────────

test('deriveBaseline: step 1 — merge-base when target branch exists', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aorch-baseline-mb-'));
  initRepo(dir, { branch: 'main' });
  const base = await commit(dir, 'a.txt', 'a', 'phase-1: init');
  // Branch develop off main, add a commit only develop has.
  git(dir, ['checkout', '-q', '-b', 'develop']);
  await commit(dir, 'b.txt', 'b', 'phase-2: feature');
  const baseline = await deriveBaseline({ workspaceDir: dir, source: 'develop', target: 'main' });
  assert.equal(baseline, base, 'merge-base(main, develop) must be the shared phase-1 commit');
});

test('deriveBaseline: step 2 — earliest phase-1 commit when no target', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aorch-baseline-p1-'));
  initRepo(dir, { branch: 'develop' });
  const p1 = await commit(dir, 'a.txt', 'a', 'phase-1: init');
  await commit(dir, 'b.txt', 'b', 'phase-2: more');
  const baseline = await deriveBaseline({ workspaceDir: dir, source: 'HEAD', target: null });
  assert.equal(baseline, p1);
});

test('deriveBaseline: step 2 — ^phase-1: does not match phase-10:', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aorch-baseline-p10-'));
  initRepo(dir, { branch: 'develop' });
  await commit(dir, 'a.txt', 'a', 'chore: seed');
  const p10 = await commit(dir, 'b.txt', 'b', 'phase-10: unrelated');
  // No phase-1: commit exists → falls through to empty tree, never picks phase-10.
  const baseline = await deriveBaseline({ workspaceDir: dir, source: 'HEAD', target: null });
  assert.notEqual(baseline, p10);
  assert.equal(baseline, EMPTY_TREE_SHA);
});

test('deriveBaseline: step 3 — empty tree when no target and no phase-1', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aorch-baseline-empty-'));
  initRepo(dir, { branch: 'develop' });
  await commit(dir, 'a.txt', 'a', 'initial commit');
  const baseline = await deriveBaseline({ workspaceDir: dir, source: 'HEAD', target: null });
  assert.equal(baseline, EMPTY_TREE_SHA);
});

// ─── diffDependencies (licenses) ─────────────────────────────────────────────

async function makeDepFixture(label, { newDepLicense, installNodeModules }) {
  const dir = mkdtempSync(path.join(tmpdir(), `aorch-deps-${label}-`));
  initRepo(dir, { branch: 'develop' });
  // Baseline package.json: no deps.
  const base = await commit(dir, 'package.json', JSON.stringify({ name: 'demo', dependencies: {} }, null, 2), 'phase-1: init');
  // HEAD adds one new direct dependency.
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { widget: '^1.0.0' } }, null, 2));
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'phase-2: add widget']);
  if (installNodeModules) {
    const nm = path.join(dir, 'node_modules', 'widget');
    await fs.mkdir(nm, { recursive: true });
    await fs.writeFile(path.join(nm, 'package.json'), JSON.stringify({ name: 'widget', license: newDepLicense }));
  }
  return { dir, base };
}

test('diffDependencies: disallowed license on a new dep is a blocker', async () => {
  const { dir, base } = await makeDepFixture('gpl', { newDepLicense: 'GPL-3.0', installNodeModules: true });
  const r = await diffDependencies({ workspaceDir: dir, baseline: base, briefText: 'widget is expected', allowlist: ['MIT', 'ISC'] });
  assert.ok(r.blockers.some((b) => b.kind === 'license' && /widget/.test(b.message)), `expected a license blocker, got ${JSON.stringify(r)}`);
});

test('diffDependencies: an allowlisted license on a new dep is NOT a blocker', async () => {
  const { dir, base } = await makeDepFixture('mit', { newDepLicense: 'MIT', installNodeModules: true });
  const r = await diffDependencies({ workspaceDir: dir, baseline: base, briefText: 'widget is expected', allowlist: ['MIT', 'ISC'] });
  assert.equal(r.blockers.length, 0, `expected no blockers, got ${JSON.stringify(r.blockers)}`);
});

test('diffDependencies: absent node_modules yields a warning, not a blocker', async () => {
  const { dir, base } = await makeDepFixture('nonm', { installNodeModules: false });
  const r = await diffDependencies({ workspaceDir: dir, baseline: base, briefText: 'widget is expected', allowlist: ['MIT'] });
  assert.equal(r.blockers.length, 0, 'absent node_modules must not block');
  assert.ok(r.warnings.some((w) => w.kind === 'license' && /unknown/.test(w.message)), `expected an unknown-license warning, got ${JSON.stringify(r.warnings)}`);
});

// ─── auditDependencies classifier ────────────────────────────────────────────

test('classifyAuditOutput: registry/network failure (non-JSON) yields a warning, never a blocker', () => {
  const r = classifyAuditOutput({ stdout: 'npm ERR! network ENOTFOUND registry.npmjs.org', stderr: 'network', level: 'high' });
  assert.equal(r.blockers.length, 0);
  assert.ok(r.warnings.some((w) => w.kind === 'audit'), `expected an audit warning, got ${JSON.stringify(r)}`);
});

test('classifyAuditOutput: an error field in the JSON yields a warning, not a blocker', () => {
  const r = classifyAuditOutput({ stdout: JSON.stringify({ error: { code: 'ENETUNREACH', summary: 'offline' } }), level: 'high' });
  assert.equal(r.blockers.length, 0);
  assert.equal(r.warnings.length, 1);
});

test('classifyAuditOutput: vulns at/above level are a blocker; below level are not', () => {
  const meta = { metadata: { vulnerabilities: { info: 0, low: 3, moderate: 1, high: 2, critical: 0 } } };
  const blocked = classifyAuditOutput({ stdout: JSON.stringify(meta), level: 'high' });
  assert.equal(blocked.blockers.length, 1, 'high:2 must block at level high');
  const clean = classifyAuditOutput({ stdout: JSON.stringify({ metadata: { vulnerabilities: { info: 0, low: 3, moderate: 1, high: 0, critical: 0 } } }), level: 'high' });
  assert.equal(clean.blockers.length, 0, 'no high/critical → no blocker at level high');
});

// ─── runShipGate config validation ───────────────────────────────────────────

test('runShipGate: a bad audit_level errors naming the config layer that produced it', async () => {
  await assert.rejects(
    runShipGate({
      workspaceDir: tmpdir(), projDir: tmpdir(),
      cfg: { ship_gate: { enabled: true, audit_level: 'bogus' } },
    }),
    /\[config: ship_gate\.audit_level\].*'bogus'/,
  );
});

// ─── shipProject integration ─────────────────────────────────────────────────

// Shared fixture: bare origin + workspace with main pushed and develop carrying
// one commit ahead. `leak: true` puts a real AWS-key-shaped secret on develop.
async function makeShipFixture(name, { leak }) {
  const root = mkdtempSync(path.join(tmpdir(), `aorch-ship-${name}-`));
  const originDir = path.join(root, 'origin.git');
  await fs.mkdir(originDir, { recursive: true });
  git(originDir, ['init', '-q', '--bare', '-b', 'main']);

  const projectsDir = path.join(root, 'projects');
  const workspaceDir = path.join(projectsDir, name, 'workspace');
  await fs.mkdir(workspaceDir, { recursive: true });
  initRepo(workspaceDir, { branch: 'main' });
  git(workspaceDir, ['remote', 'add', 'origin', originDir]);

  await commit(workspaceDir, 'README.md', `# ${name}\n`, 'phase-1: init');
  git(workspaceDir, ['push', '-q', '-u', 'origin', 'main']);

  git(workspaceDir, ['checkout', '-q', '-b', 'develop']);
  const content = leak ? "const k = 'AKIA1234567890ABCDEF';\n" : "export const ok = true;\n";
  await commit(workspaceDir, 'src/feature.js', content, 'phase-2: add feature');
  git(workspaceDir, ['push', '-q', '-u', 'origin', 'develop']);

  upsertProject({ name });
  setProjectGitConfig(name, { git_branch: 'develop' });
  return { projectsDir, workspaceDir };
}

test('shipProject: injected secret → ok:false BEFORE merge, writes report, one deduped bug across two runs', async () => {
  const { projectsDir, workspaceDir } = await makeShipFixture('demo', { leak: true });

  // Record the pre-ship main tip so we can prove main never moved.
  const mainBefore = git(workspaceDir, ['rev-parse', 'main']);

  const first = await shipProject({ projectName: 'demo', target: 'main', projectsDir, cfg: GATE_CFG });
  assert.equal(first.ok, false, `ship must be blocked by the secret, got ${JSON.stringify(first)}`);
  assert.match(first.error, /ship gate/i);

  // main did not move.
  assert.equal(git(workspaceDir, ['rev-parse', 'main']), mainBefore, 'main must not have advanced');

  // Report written.
  const report = await fs.readFile(shipGateReportPath(path.join(projectsDir, 'demo')), 'utf-8');
  assert.match(report, /BLOCKED/);

  const countBugs = () => getDb().prepare(
    `SELECT COUNT(*) AS n FROM bug_inbox WHERE project = 'demo' AND source = 'ship-gate'`,
  ).get().n;
  assert.equal(countBugs(), 1, 'exactly one ship-gate bug after first run');

  // Second consecutive run on the unchanged workspace → still exactly one (deduped).
  const second = await shipProject({ projectName: 'demo', target: 'main', projectsDir, cfg: GATE_CFG });
  assert.equal(second.ok, false);
  assert.equal(countBugs(), 1, 'still exactly one ship-gate bug after the second run (deduped)');
});

test('shipProject: --skip-gate bypasses the gate (loud path, no gate side effects)', async () => {
  const { projectsDir } = await makeShipFixture('demo2', { leak: true });

  // --skip-gate: the secret no longer blocks; the FF merge proceeds and succeeds.
  const r = await shipProject({ projectName: 'demo2', target: 'main', projectsDir, skipGate: true, cfg: GATE_CFG });
  assert.equal(r.ok, true, `--skip-gate must bypass the gate, got ${JSON.stringify(r)}`);
  // No ship-gate bug rows were written.
  const n = getDb().prepare(`SELECT COUNT(*) AS n FROM bug_inbox WHERE project = 'demo2' AND source = 'ship-gate'`).get().n;
  assert.equal(n, 0, 'skip-gate must not write bug rows');
});

test('shipProject: ship_gate.enabled:false bypasses the gate — no report, no bug rows, ship proceeds', async () => {
  const { projectsDir } = await makeShipFixture('demo3', { leak: true });

  const r = await shipProject({
    projectName: 'demo3', target: 'main', projectsDir,
    cfg: { ship_gate: { ...GATE_CFG.ship_gate, enabled: false } },
  });
  assert.equal(r.ok, true, `enabled:false must bypass the gate, got ${JSON.stringify(r)}`);
  // No gate side effects: no report file, no bug rows.
  await assert.rejects(fs.access(shipGateReportPath(path.join(projectsDir, 'demo3'))), 'enabled:false must not write a report');
  const n = getDb().prepare(`SELECT COUNT(*) AS n FROM bug_inbox WHERE project = 'demo3' AND source = 'ship-gate'`).get().n;
  assert.equal(n, 0, 'enabled:false must not write bug rows');
});

test('shipProject: a clean (no-findings) gate pass ships normally and writes a PASS report', async () => {
  const { projectsDir } = await makeShipFixture('demo4', { leak: false });

  const r = await shipProject({ projectName: 'demo4', target: 'main', projectsDir, cfg: GATE_CFG });
  assert.equal(r.ok, true, `a clean gate pass must ship, got ${JSON.stringify(r)}`);
  const report = await fs.readFile(shipGateReportPath(path.join(projectsDir, 'demo4')), 'utf-8');
  assert.match(report, /PASS/);
  const n = getDb().prepare(`SELECT COUNT(*) AS n FROM bug_inbox WHERE project = 'demo4' AND source = 'ship-gate'`).get().n;
  assert.equal(n, 0, 'a clean pass must not write bug rows');
});
