// Standalone route tests for the new phase-9 endpoints.
// Run: node src/web-ui-routes.test.mjs
// Exits 0 on all pass, non-zero on any failure.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PROJECTS_DIR = path.join(REPO_ROOT, 'projects');
const OUTPUTS_DIR = path.join(REPO_ROOT, 'outputs');

// Must set DB_PATH before any import that touches state
const testDbDir = mkdtempSync(path.join(tmpdir(), 'aorch-test-'));
process.env.DB_PATH = path.join(testDbDir, 'test.db');

const { createWebUiApp } = await import('./web-ui.js');
const { upsertProject, addBug, addRequirement, closeDb, getDb, recordCall, saveSuggestions, acceptSuggestions, getSuggestionsProject, getLatestSuggestions, getSuggestionsById, staleDraftSuggestions, getEarlierSuggestionTitles, startAutoRun, pauseAutoRun, claimRunningJob, releaseRunningJob, getBug, getRequirement } = await import('./state.js');
const { enqueueJob, markJobRunning, getJob, dequeuePendingJob } = await import('./server/job-queue.js');

// ── Test harness ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, description) {
  if (condition) {
    console.log(`PASS ${description}`);
    passed++;
  } else {
    console.log(`FAIL ${description}`);
    failed++;
  }
}

// ── Test project setup ─────────────────────────────────────────────────────────

const TEST_PROJECT = `test-routes-${Date.now()}`;
const PROJ_DIR = path.join(PROJECTS_DIR, TEST_PROJECT);
const PROJECT_JSON_PATH = path.join(PROJ_DIR, 'project.json');

function currentConfigVersion() {
  return createHash('sha256').update(readFileSync(PROJECT_JSON_PATH)).digest('hex');
}

const app = createWebUiApp({ authToken: null });
const server = await new Promise((resolve) => {
  const s = app.listen(0, () => resolve(s));
});
const port = server.address().port;
const base = `http://localhost:${port}`;

const AUTH_TOKEN = 'test-auth-token-round17-fix3-xyz';
const authApp = createWebUiApp({ authToken: AUTH_TOKEN });
const authServer = await new Promise((resolve) => {
  const s = authApp.listen(0, () => resolve(s));
});
const authPort = authServer.address().port;
const authBase = `http://localhost:${authPort}`;

// Seed DB
upsertProject({ name: TEST_PROJECT, tech_stack: 'test', total_phases: 5, status: 'in-progress' });

// Create project dir + project.json (required by PATCH /config)
mkdirSync(PROJ_DIR, { recursive: true });
writeFileSync(
  PROJECT_JSON_PATH,
  JSON.stringify({
    $schema_version: 4,
    name: TEST_PROJECT,
    created_at: new Date().toISOString(),
    overrides: {
      billing: { pause_at_calls: 50, max_total_cost_usd: 5.00 },
    },
  }, null, 2),
);

// Seed bugs and requirements (one per action so state is clean per test)
const promoBugId  = addBug({ project: TEST_PROJECT, raw_text: 'Promote me',      severity: 'major', source: 'test' });
const dropBugId   = addBug({ project: TEST_PROJECT, raw_text: 'Drop me',         severity: 'minor', source: 'test' });
const promoBugId2 = addBug({ project: TEST_PROJECT, raw_text: 'Promote me too',  severity: 'minor', source: 'test' });
const promoReqId  = addRequirement({ project: TEST_PROJECT, raw_text: 'Promote req', source: 'test' });
const dropReqId   = addRequirement({ project: TEST_PROJECT, raw_text: 'Drop req',    source: 'test' });
// Dedicated seeds for idempotency tests
const idemBugId = addBug({ project: TEST_PROJECT, raw_text: 'Idem bug', severity: 'minor', source: 'test' });
const idemReqId = addRequirement({ project: TEST_PROJECT, raw_text: 'Idem req', source: 'test' });

// Synthetic stdout log written into <repo>/logs during the log-tail tests —
// tracked here so the finally block always removes it.
let syntheticLogFile = null;
const syntheticReleaseFiles = [];

// ── Tests ──────────────────────────────────────────────────────────────────────

try {
  // 1. GET /calls without phase — backward-compatible array response
  {
    const r = await fetch(`${base}/api/projects/${TEST_PROJECT}/calls`);
    const body = await r.json();
    assert(r.ok && Array.isArray(body), 'GET /calls without phase returns array');
  }

  // 2. GET /calls?phase=3 — returns only phase=3 rows (empty here, still array)
  {
    const r = await fetch(`${base}/api/projects/${TEST_PROJECT}/calls?phase=3`);
    const body = await r.json();
    assert(r.ok && Array.isArray(body), 'GET /calls?phase=3 returns array');
    assert(body.every(c => c.phase === 3), 'GET /calls?phase=3 all rows have phase===3 (vacuously true when empty)');
  }

  // 2b. GET /calls?phase=abc — non-integer phase returns 400
  {
    const r = await fetch(`${base}/api/projects/${TEST_PROJECT}/calls?phase=abc`);
    assert(r.status === 400, 'GET /calls?phase=abc returns 400');
  }

  // 2c. GET /calls returns cache_read_tokens and cache_creation_tokens when stored
  {
    recordCall({
      project: TEST_PROJECT,
      phase: 1,
      task: 'cache-token-test',
      model: 'claude-sonnet-4-6',
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_tokens: 1500,
      cache_creation_tokens: 300,
      is_error: false,
    });
    const r = await fetch(`${base}/api/projects/${TEST_PROJECT}/calls`);
    const body = await r.json();
    assert(r.ok && Array.isArray(body), 'GET /calls (cache test) returns array');
    const cacheCall = body.find(c => c.task === 'cache-token-test');
    assert(cacheCall !== undefined, 'GET /calls returns the seeded call with cache tokens');
    assert(cacheCall.cache_read_tokens === 1500, 'GET /calls row includes cache_read_tokens: 1500');
    assert(cacheCall.cache_creation_tokens === 300, 'GET /calls row includes cache_creation_tokens: 300');
  }

  // 13. GET /api/projects/:name returns billingConfig resolved through cascade
  {
    const r = await fetch(`${base}/api/projects/${TEST_PROJECT}`);
    const body = await r.json();
    assert(r.ok, 'GET /api/projects/:name returns 200');
    assert(body.billingConfig?.pause_at_calls === 50, 'billingConfig.pause_at_calls reflects cascade value (50 from project.json overrides)');
  }

  // 3. POST /bugs/:id/promote on unknown id → 404
  {
    const r = await fetch(`${base}/api/projects/${TEST_PROJECT}/bugs/99999/promote`, { method: 'POST' });
    assert(r.status === 404, 'POST /bugs/99999/promote returns 404');
  }

  // 4. POST /bugs/:id/promote on valid inbox bug → ok:true, promoted, bugs.md written
  let firstPromoteRound;
  {
    const r = await fetch(`${base}/api/projects/${TEST_PROJECT}/bugs/${promoBugId}/promote`, { method: 'POST' });
    const body = await r.json();
    assert(r.ok && body.ok === true && body.status === 'promoted', 'POST /bugs/:id/promote returns ok:true, status:promoted');
    assert(typeof body.promoted_to_round === 'number', 'POST /bugs/:id/promote returns numeric promoted_to_round');
    firstPromoteRound = body.promoted_to_round;
    const bugsFile = path.join(PROJ_DIR, '.guide', 'bug-rounds', `round-${body.promoted_to_round}`, 'bugs.md');
    let bugsMdContent;
    try { bugsMdContent = readFileSync(bugsFile, 'utf-8'); } catch { bugsMdContent = null; }
    assert(bugsMdContent !== null, 'POST /bugs/:id/promote writes bugs.md to disk');
    assert(bugsMdContent !== null && bugsMdContent.includes('Promote me'), 'bugs.md contains promoted bug text');
  }

  // 4b. POST /bugs/:id/promote on second bug → appends to same open round (no plan.json)
  {
    const r = await fetch(`${base}/api/projects/${TEST_PROJECT}/bugs/${promoBugId2}/promote`, { method: 'POST' });
    const body = await r.json();
    assert(r.ok && body.ok === true && body.status === 'promoted', 'POST /bugs/:id/promote (2nd) returns ok:true, status:promoted');
    assert(body.promoted_to_round === firstPromoteRound, 'POST /bugs/:id/promote (2nd) appends to same open round');
    const bugsFile = path.join(PROJ_DIR, '.guide', 'bug-rounds', `round-${body.promoted_to_round}`, 'bugs.md');
    let bugsMdContent;
    try { bugsMdContent = readFileSync(bugsFile, 'utf-8'); } catch { bugsMdContent = null; }
    assert(bugsMdContent !== null && bugsMdContent.includes('Promote me'), 'bugs.md still contains first bug text after append');
    assert(bugsMdContent !== null && bugsMdContent.includes('Promote me too'), 'bugs.md contains second bug text after append');
  }

  // 4c. POST /bugs/:id/promote on already-promoted bug → 409, no duplicate in bugs.md
  {
    const r1 = await fetch(`${base}/api/projects/${TEST_PROJECT}/bugs/${idemBugId}/promote`, { method: 'POST' });
    assert(r1.ok, 'Idempotency setup: first promote of idemBugId succeeds');
    const b1 = await r1.json();
    const bugsFile = path.join(PROJ_DIR, '.guide', 'bug-rounds', `round-${b1.promoted_to_round}`, 'bugs.md');

    const r2 = await fetch(`${base}/api/projects/${TEST_PROJECT}/bugs/${idemBugId}/promote`, { method: 'POST' });
    assert(r2.status === 409, 'POST /bugs/:id/promote on already-promoted bug returns 409');

    let bugsMd;
    try { bugsMd = readFileSync(bugsFile, 'utf-8'); } catch { bugsMd = ''; }
    const headings = (bugsMd.match(/^### Bug \d+ — Idem bug/gm) || []).length;
    assert(headings === 1, 'bugs.md contains the Idem bug section heading exactly once (no duplicate append)');
  }

  // 5. POST /bugs/:id/drop on valid bug → ok:true, dropped
  {
    const r = await fetch(`${base}/api/projects/${TEST_PROJECT}/bugs/${dropBugId}/drop`, { method: 'POST' });
    const body = await r.json();
    assert(r.ok && body.ok === true && body.status === 'dropped', 'POST /bugs/:id/drop returns ok:true, status:dropped');
  }

  // 5b. POST /bugs/:id/drop on already-dropped bug → 409
  {
    const drop2Id = addBug({ project: TEST_PROJECT, raw_text: 'Drop twice', severity: 'minor', source: 'test' });
    const r1 = await fetch(`${base}/api/projects/${TEST_PROJECT}/bugs/${drop2Id}/drop`, { method: 'POST' });
    assert(r1.ok, 'Idempotency setup: first drop succeeds');
    const r2 = await fetch(`${base}/api/projects/${TEST_PROJECT}/bugs/${drop2Id}/drop`, { method: 'POST' });
    assert(r2.status === 409, 'POST /bugs/:id/drop on already-dropped bug returns 409');
  }

  // 6. POST /requirements/:id/promote on valid req → ok:true, promoted
  {
    const r = await fetch(`${base}/api/projects/${TEST_PROJECT}/requirements/${promoReqId}/promote`, { method: 'POST' });
    const body = await r.json();
    assert(r.ok && body.ok === true && body.status === 'promoted', 'POST /requirements/:id/promote returns ok:true, status:promoted');
  }

  // 6b. POST /requirements/:id/promote on already-promoted requirement → 409
  {
    const r1 = await fetch(`${base}/api/projects/${TEST_PROJECT}/requirements/${idemReqId}/promote`, { method: 'POST' });
    assert(r1.ok, 'Idempotency setup: first requirement promote succeeds');
    const r2 = await fetch(`${base}/api/projects/${TEST_PROJECT}/requirements/${idemReqId}/promote`, { method: 'POST' });
    assert(r2.status === 409, 'POST /requirements/:id/promote on already-promoted req returns 409');
  }

  // 7. POST /requirements/:id/drop on valid req → ok:true, dropped
  {
    const r = await fetch(`${base}/api/projects/${TEST_PROJECT}/requirements/${dropReqId}/drop`, { method: 'POST' });
    const body = await r.json();
    assert(r.ok && body.ok === true && body.status === 'dropped', 'POST /requirements/:id/drop returns ok:true, status:dropped');
  }

  // 7b. POST /requirements/:id/drop on already-dropped requirement → 409
  {
    const drop2ReqId = addRequirement({ project: TEST_PROJECT, raw_text: 'Drop req twice', source: 'test' });
    const r1 = await fetch(`${base}/api/projects/${TEST_PROJECT}/requirements/${drop2ReqId}/drop`, { method: 'POST' });
    assert(r1.ok, 'Idempotency setup: first requirement drop succeeds');
    const r2 = await fetch(`${base}/api/projects/${TEST_PROJECT}/requirements/${drop2ReqId}/drop`, { method: 'POST' });
    assert(r2.status === 409, 'POST /requirements/:id/drop on already-dropped req returns 409');
  }

  // 8. Config reads expose an exact-byte SHA-256 optimistic version.
  {
    const r = await fetch(`${base}/api/projects/${TEST_PROJECT}`);
    const body = await r.json();
    assert(r.ok && body.configVersion === currentConfigVersion(), 'GET project returns SHA-256 configVersion of exact project.json bytes');
  }

  // 8a. A write without an optimistic version fails before touching disk.
  {
    const before = readFileSync(PROJECT_JSON_PATH, 'utf-8');
    const r = await fetch(`${base}/api/projects/${TEST_PROJECT}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pause_at_calls: 99 }),
    });
    const body = await r.json();
    assert(r.status === 428 && body.code === 'CONFIG_VERSION_REQUIRED', 'PATCH /config without expectedVersion returns 428');
    assert(readFileSync(PROJECT_JSON_PATH, 'utf-8') === before, 'missing expectedVersion leaves project.json unchanged');
  }

  // 8b. A stale version gets a machine-readable conflict and current version.
  {
    const before = readFileSync(PROJECT_JSON_PATH, 'utf-8');
    const r = await fetch(`${base}/api/projects/${TEST_PROJECT}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pause_at_calls: 99, expectedVersion: '0'.repeat(64) }),
    });
    const body = await r.json();
    assert(r.status === 409 && body.code === 'CONFIG_VERSION_CONFLICT', 'PATCH /config with stale expectedVersion returns version conflict');
    assert(body.currentVersion === currentConfigVersion(), 'version conflict returns the exact currentVersion');
    assert(readFileSync(PROJECT_JSON_PATH, 'utf-8') === before, 'stale expectedVersion leaves project.json unchanged');
  }

  // 8c. PATCH /config with pause_at_calls:100 — sibling value survives and
  // the response version matches the committed bytes.
  {
    const r = await fetch(`${base}/api/projects/${TEST_PROJECT}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pause_at_calls: 100, expectedVersion: currentConfigVersion() }),
    });
    const body = await r.json();
    assert(r.ok && body.ok === true, 'PATCH /config with pause_at_calls:100 returns ok:true');
    assert(body.config?.overrides?.billing?.pause_at_calls === 100, 'PATCH /config sets pause_at_calls to 100');
    assert(body.config?.overrides?.billing?.max_total_cost_usd === 5.00, 'PATCH /config preserves sibling max_total_cost_usd');
    assert(body.configVersion === currentConfigVersion(), 'PATCH /config returns version of exact committed bytes');
  }

  // 9. PATCH /config with invalid pause_at_calls → 400
  {
    const r = await fetch(`${base}/api/projects/${TEST_PROJECT}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pause_at_calls: 'abc', expectedVersion: currentConfigVersion() }),
    });
    assert(r.status === 400, 'PATCH /config with pause_at_calls:"abc" returns 400');
  }

  // 9a. PATCH /config with git_branch → persists to project.json on disk (not just response)
  {
    const r = await fetch(`${base}/api/projects/${TEST_PROJECT}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ git_branch: 'main', expectedVersion: currentConfigVersion() }),
    });
    const body = await r.json();
    assert(r.ok && body.ok === true, 'PATCH /config with git_branch returns ok:true');
    assert(body.config?.git_branch === 'main', 'PATCH /config response reflects git_branch');
    const diskJson = JSON.parse(readFileSync(path.join(PROJ_DIR, 'project.json'), 'utf-8'));
    assert(diskJson.git_branch === 'main', 'PATCH /config git_branch is written to project.json on disk');
  }

  // 9b. PATCH /config with git_branch + billing → both fields persist to disk in one write
  {
    const r = await fetch(`${base}/api/projects/${TEST_PROJECT}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ git_branch: 'develop', pause_at_calls: 77, expectedVersion: currentConfigVersion() }),
    });
    const body = await r.json();
    assert(r.ok && body.ok === true, 'PATCH /config with git_branch + billing returns ok:true');
    const diskJson = JSON.parse(readFileSync(path.join(PROJ_DIR, 'project.json'), 'utf-8'));
    assert(diskJson.git_branch === 'develop', 'PATCH /config mixed: git_branch on disk');
    assert(diskJson.overrides?.billing?.pause_at_calls === 77, 'PATCH /config mixed: pause_at_calls on disk');
  }

  // 9c. Pending, running, and live process work each block config mutation.
  {
    const pendingId = enqueueJob({ project: TEST_PROJECT, action: 'validate', args: {}, requestedBy: 'test' });
    const pendingResp = await fetch(`${base}/api/projects/${TEST_PROJECT}/config`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pause_at_calls: 76, expectedVersion: currentConfigVersion() }),
    });
    const pendingBody = await pendingResp.json();
    assert(pendingResp.status === 409 && pendingBody.code === 'PROJECT_BUSY', 'pending project job blocks PATCH /config');
    dequeuePendingJob(pendingId);

    const runningId = enqueueJob({ project: TEST_PROJECT, action: 'validate', args: {}, requestedBy: 'test' });
    markJobRunning(runningId);
    const runningResp = await fetch(`${base}/api/projects/${TEST_PROJECT}/config`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pause_at_calls: 76, expectedVersion: currentConfigVersion() }),
    });
    assert(runningResp.status === 409 && (await runningResp.json()).code === 'PROJECT_BUSY', 'running project job blocks PATCH /config');
    getDb().prepare('DELETE FROM tg_jobs WHERE id = ?').run(runningId);

    claimRunningJob(TEST_PROJECT, process.pid);
    const processResp = await fetch(`${base}/api/projects/${TEST_PROJECT}/config`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pause_at_calls: 76, expectedVersion: currentConfigVersion() }),
    });
    assert(processResp.status === 409 && (await processResp.json()).code === 'PROJECT_BUSY', 'live project process blocks PATCH /config');
    releaseRunningJob(TEST_PROJECT);
  }

  // 9d. Two writes based on the same version serialize; only one commits.
  {
    const expectedVersion = currentConfigVersion();
    const request = (pause_at_calls) => fetch(`${base}/api/projects/${TEST_PROJECT}/config`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pause_at_calls, expectedVersion }),
    });
    const responses = await Promise.all([request(75), request(74)]);
    const bodies = await Promise.all(responses.map((r) => r.json()));
    assert(responses.filter((r) => r.ok).length === 1, 'concurrent same-version PATCH requests commit exactly once');
    assert(responses.filter((r) => r.status === 409).length === 1, 'serialized competing PATCH returns one 409');
    const winner = bodies.find((_, i) => responses[i].ok);
    assert(winner?.configVersion === currentConfigVersion(), 'winning concurrent PATCH returns committed configVersion');
  }

  // 9e. Package is an allowlisted durable action and preserves includeGit.
  {
    const r = await fetch(`${base}/api/projects/${TEST_PROJECT}/actions/package`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: { includeGit: true } }),
    });
    const body = await r.json();
    const row = getJob(body.jobId);
    assert(r.status === 202 && body.action === 'package' && row?.action === 'package', 'POST actions/package creates a durable package job');
    assert(JSON.parse(row.args_json).includeGit === true, 'package durable job preserves includeGit argument');
    dequeuePendingJob(body.jobId);
  }

  // 9f. Release listing/download is authenticated and jailed to timestamped
  // project ZIPs under outputs/ (including symlink and prefix-collision denial).
  {
    mkdirSync(OUTPUTS_DIR, { recursive: true });
    const releaseName = `${TEST_PROJECT}-2026-07-19T10-20-30.zip`;
    const collisionName = `${TEST_PROJECT}-other-2026-07-19T10-20-31.zip`;
    const symlinkName = `${TEST_PROJECT}-2026-07-19T10-20-32.zip`;
    const releasePath = path.join(OUTPUTS_DIR, releaseName);
    const collisionPath = path.join(OUTPUTS_DIR, collisionName);
    const symlinkPath = path.join(OUTPUTS_DIR, symlinkName);
    const externalPath = path.join(testDbDir, 'outside-release.zip');
    writeFileSync(releasePath, 'real zip fixture');
    writeFileSync(collisionPath, 'belongs to a longer project-like prefix');
    writeFileSync(externalPath, 'must never be served');
    symlinkSync(externalPath, symlinkPath);
    syntheticReleaseFiles.push(releasePath, collisionPath, symlinkPath);

    const unauthList = await fetch(`${authBase}/api/projects/${TEST_PROJECT}/releases`);
    assert(unauthList.status === 401, 'GET releases requires Bearer authentication when auth is enabled');

    const authHeaders = { Authorization: `Bearer ${AUTH_TOKEN}` };
    const listResp = await fetch(`${authBase}/api/projects/${TEST_PROJECT}/releases`, { headers: authHeaders });
    const listBody = await listResp.json();
    assert(listResp.ok && Array.isArray(listBody.releases), 'authenticated GET releases returns a releases array');
    assert(listBody.releases.some((item) => item.filename === releaseName && item.size > 0), 'release listing exposes the matching regular ZIP');
    assert(!listBody.releases.some((item) => item.filename === collisionName), 'release listing rejects project-prefix collisions');
    assert(!listBody.releases.some((item) => item.filename === symlinkName), 'release listing excludes symlink ZIPs');

    const unauthDownload = await fetch(`${authBase}/api/projects/${TEST_PROJECT}/releases/${encodeURIComponent(releaseName)}`);
    assert(unauthDownload.status === 401, 'release ZIP download requires Bearer authentication');
    const download = await fetch(`${authBase}/api/projects/${TEST_PROJECT}/releases/${encodeURIComponent(releaseName)}`, { headers: authHeaders });
    assert(download.ok && await download.text() === 'real zip fixture', 'authenticated release download serves the selected ZIP');
    assert((download.headers.get('content-disposition') || '').includes(releaseName), 'release download uses attachment filename');

    const symlinkDownload = await fetch(`${authBase}/api/projects/${TEST_PROJECT}/releases/${encodeURIComponent(symlinkName)}`, { headers: authHeaders });
    assert(symlinkDownload.status === 404, 'release download rejects a symlink that escapes outputs');
    const collisionDownload = await fetch(`${authBase}/api/projects/${TEST_PROJECT}/releases/${encodeURIComponent(collisionName)}`, { headers: authHeaders });
    assert(collisionDownload.status === 404, 'release download rejects project-prefix collision filenames');
    const traversalDownload = await fetch(`${authBase}/api/projects/${TEST_PROJECT}/releases/${encodeURIComponent('../outside-release.zip')}`, { headers: authHeaders });
    assert(!traversalDownload.ok, 'release download rejects traversal input');
  }

  // 10. POST /promote-audit when no audit file exists → 409 with error field
  {
    const r = await fetch(`${base}/api/projects/${TEST_PROJECT}/promote-audit`, { method: 'POST' });
    const body = await r.json();
    assert(r.status === 409, 'POST /promote-audit with no audit file returns 409');
    assert(typeof body.error === 'string' && body.error.length > 0, 'POST /promote-audit 409 response has error string');
  }

  // 11. GET /bugs returns array
  {
    const r = await fetch(`${base}/api/projects/${TEST_PROJECT}/bugs`);
    const body = await r.json();
    assert(r.ok && Array.isArray(body), 'GET /bugs returns array');
    assert(body.length >= 2, 'GET /bugs returns seeded bug rows');
  }

  // 12. GET /requirements returns array
  {
    const r = await fetch(`${base}/api/projects/${TEST_PROJECT}/requirements`);
    const body = await r.json();
    assert(r.ok && Array.isArray(body), 'GET /requirements returns array');
    assert(body.length >= 2, 'GET /requirements returns seeded requirement rows');
  }

  // 14. POST /sse-ticket → returns a ticket string (no-auth mode: always accessible)
  {
    const r = await fetch(`${base}/api/sse-ticket`, { method: 'POST' });
    const body = await r.json();
    assert(r.ok, 'POST /api/sse-ticket returns 200');
    assert(typeof body.ticket === 'string' && body.ticket.length === 32, 'POST /api/sse-ticket returns 32-char hex ticket');
  }

  // 15. POST /sse-ticket twice → second ticket is different (no replay)
  {
    const r1 = await fetch(`${base}/api/sse-ticket`, { method: 'POST' });
    const r2 = await fetch(`${base}/api/sse-ticket`, { method: 'POST' });
    const b1 = await r1.json();
    const b2 = await r2.json();
    assert(b1.ticket !== b2.ticket, 'Each POST /api/sse-ticket returns a unique ticket');
  }

  // 16. GET /api/stream with ?token= in auth mode → 401 (fallback removed)
  {
    const r = await fetch(`${authBase}/api/stream?token=${AUTH_TOKEN}`);
    assert(r.status === 401, 'GET /api/stream?token= in auth mode returns 401 (no URL fallback)');
  }

  // 17. GET /api/stream with no params in auth mode → 401
  {
    const r = await fetch(`${authBase}/api/stream`);
    assert(r.status === 401, 'GET /api/stream with no auth returns 401');
  }

  // 18. POST /api/sse-ticket then GET /api/stream?ticket= in auth mode → not 401
  {
    const ticketResp = await fetch(`${authBase}/api/sse-ticket`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` },
    });
    assert(ticketResp.ok, 'POST /api/sse-ticket under auth returns 200');
    const { ticket } = await ticketResp.json();
    assert(typeof ticket === 'string' && ticket.length === 32, 'ticket is a 32-char hex string');

    const streamResp = await fetch(`${authBase}/api/stream?ticket=${encodeURIComponent(ticket)}`);
    assert(streamResp.status !== 401, 'GET /api/stream?ticket= passes auth (not 401)');
    await streamResp.body?.cancel().catch(() => {});
  }

  // ─── suggestions/accept ownership check ──────────────────────────────────────
  console.log('\nsuggestions/accept ownership:');

  {
    const projA = `sug-own-a-${Date.now()}`;
    const projB = `sug-own-b-${Date.now()}`;
    upsertProject({ name: projA, tech_stack: 'node', total_phases: 1, status: 'in-progress' });
    upsertProject({ name: projB, tech_stack: 'node', total_phases: 1, status: 'in-progress' });

    const idA = saveSuggestions(projA, {
      projectType: 'cli',
      scanSnapshot: {},
      suggestions: [],
    });

    // Test 1 — cross-project id → 404
    {
      const r = await fetch(`${base}/api/projects/${projB}/suggestions/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: idA, selected: [0], pipelinePasses: 1 }),
      });
      assert(r.status === 404, 'accept: posting projA id to projB route → 404');
      const body = await r.json();
      assert(typeof body.error === 'string', 'accept: 404 response has error string');
      assert(body.op === 'accept', 'accept: 404 response has op: accept');

      // Verify projA's row was NOT accepted (mutation never ran)
      const rowProject = getSuggestionsProject(idA);
      assert(rowProject === projA, 'accept: cross-project rejection — projA row still exists');
      const draft = getLatestSuggestions(projA);
      assert(draft?.status === 'draft', 'accept: cross-project rejection — projA row status still draft');
    }

    // Test 2 — nonexistent id → 404
    {
      const r = await fetch(`${base}/api/projects/${projA}/suggestions/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 999999, selected: [0], pipelinePasses: 1 }),
      });
      assert(r.status === 404, 'accept: nonexistent id → 404');
    }

    // Test 3 — valid accept (matching project) → 200 with accepted row
    {
      const projC = `sug-own-c-${Date.now()}`;
      upsertProject({ name: projC, tech_stack: 'node', total_phases: 1, status: 'in-progress' });
      const idC = saveSuggestions(projC, {
        projectType: 'api',
        scanSnapshot: {},
        suggestions: [{ id: 'own-c-sug', title: 'Test', type: 'enhancement', category: 'logic',
                        effort: 'small', impact: 'medium', suggestedSlot: 1, description: '', appliesTo: [] }],
      });

      const projCDir = path.join(PROJECTS_DIR, projC);
      mkdirSync(path.join(projCDir, '.guide'), { recursive: true });

      const r = await fetch(`${base}/api/projects/${projC}/suggestions/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: idC, selected: [{ id: 'own-c-sug' }], pipelinePasses: 1 }),
      });
      assert(r.status === 200, 'accept: correct project id → 200');
      const body = await r.json();
      assert(body?.status === 'accepted', 'accept: correct project → row status is accepted');

      try { rmSync(projCDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // ─── BUG-5 regression: /accept response selected_json reflects reconciled count ─
  console.log('\nBUG-5 regression: /accept selected_json is authoritative (reconciled) count:');

  {
    const projR = `sug-bug5-${Date.now()}`;
    upsertProject({ name: projR, tech_stack: 'node', total_phases: 3, status: 'in-progress' });
    const projRDir = path.join(PROJECTS_DIR, projR);
    mkdirSync(path.join(projRDir, '.guide'), { recursive: true });

    // Seed: 2 real suggestions in the stored set
    const idR = saveSuggestions(projR, {
      projectType: 'cli',
      scanSnapshot: {},
      suggestions: [
        { id: 'real-1', type: 'new-feature', category: 'logic',   title: 'Real 1', description: 'd', effort: 'small',  impact: 'high',   suggestedSlot: 1, appliesTo: ['cli'] },
        { id: 'real-2', type: 'enhancement', category: 'frontend', title: 'Real 2', description: 'd', effort: 'medium', impact: 'medium', suggestedSlot: 2, appliesTo: ['cli'] },
      ],
    });

    // Client posts 3 ids — one of which ('bogus-id') does not exist in the stored set
    const r = await fetch(`${base}/api/projects/${projR}/suggestions/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id:             idR,
        selected:       [{ id: 'real-1' }, { id: 'bogus-id' }, { id: 'real-2' }],
        pipelinePasses: 1,
      }),
    });
    assert(r.status === 200, 'BUG-5: valid accept (2 real + 1 bogus id) → 200');

    const body = await r.json();
    assert(body?.status === 'accepted', 'BUG-5: row status is accepted');

    // The response selected_json must contain only the 2 reconciled items, not 3
    const savedSelected = JSON.parse(body?.selected_json || '[]');
    assert(savedSelected.length === 2,
      'BUG-5: selected_json.length is 2 (reconciled), not 3 (client-sent count)');
    assert(savedSelected.some(s => s.id === 'real-1'),
      'BUG-5: real-1 is in selected_json');
    assert(savedSelected.some(s => s.id === 'real-2'),
      'BUG-5: real-2 is in selected_json');
    assert(!savedSelected.some(s => s.id === 'bogus-id'),
      'BUG-5: bogus-id is NOT in selected_json (reconciliation dropped it)');

    // Client-side fix reads selected_json.length (=2) not posted selected.length (=3)
    const bannerCount = savedSelected.length;
    assert(bannerCount === 2,
      'BUG-5: banner count derived from selected_json.length === 2 (correct), not 3 (wrong)');

    try { rmSync(projRDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // ─── suggestions/accept empty-selection guard ─────────────────────────────────
  console.log('\nsuggestions/accept empty-selection guard:');

  {
    const projE = `sug-empty-${Date.now()}`;
    upsertProject({ name: projE, tech_stack: 'node', total_phases: 1, status: 'in-progress' });
    const projEDir = path.join(PROJECTS_DIR, projE);
    mkdirSync(path.join(projEDir, '.guide'), { recursive: true });

    // Test A — selected: [] → 400 and row stays draft
    {
      const idE = saveSuggestions(projE, { projectType: 'cli', scanSnapshot: {}, suggestions: [] });
      const r = await fetch(`${base}/api/projects/${projE}/suggestions/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: idE, selected: [], pipelinePasses: 1 }),
      });
      assert(r.status === 400, 'accept: empty selected → 400');
      const body = await r.json();
      assert(typeof body.error === 'string' && /empty|cannot be empty/i.test(body.error), 'accept: empty selected 400 body mentions empty constraint');
      const draft = getLatestSuggestions(projE);
      assert(draft?.status === 'draft', 'accept: empty selected — DB row remains draft (acceptSuggestions not called)');
    }

    // Test B — selected with a valid suggestion id → 200 (success path unchanged)
    {
      const idE2 = saveSuggestions(projE, {
        projectType: 'cli',
        scanSnapshot: {},
        suggestions: [{ id: 'empty-sug-2', title: 'Test', type: 'enhancement', category: 'logic',
                        effort: 'small', impact: 'medium', suggestedSlot: 1, description: '', appliesTo: [] }],
      });
      const r = await fetch(`${base}/api/projects/${projE}/suggestions/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: idE2, selected: [{ id: 'empty-sug-2' }], pipelinePasses: 1 }),
      });
      assert(r.status === 200, 'accept: non-empty selected with valid id → 200');
      const body = await r.json();
      assert(body?.status === 'accepted', 'accept: non-empty selected → row status is accepted');
    }

    try { rmSync(projEDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // ─── Bug 2 regression: scan preserves accepted plan ─────────────────────────
  console.log('\nBug 2 regression: scan preserves accepted plan:');

  {
    const projScan = `sug-scan-preserve-${Date.now()}`;
    upsertProject({ name: projScan, tech_stack: 'node', total_phases: 1, status: 'in-progress' });

    const projScanDir = path.join(PROJECTS_DIR, projScan);
    mkdirSync(path.join(projScanDir, '.guide'), { recursive: true });

    const idScan = saveSuggestions(projScan, {
      projectType: 'cli',
      scanSnapshot: {},
      suggestions: [{ id: 'scan-preserve-sug', title: 'Test', type: 'enhancement', category: 'logic',
                      effort: 'small', impact: 'medium', suggestedSlot: 1, description: '', appliesTo: [] }],
    });

    // Accept the draft
    const acceptR = await fetch(`${base}/api/projects/${projScan}/suggestions/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: idScan, selected: [{ id: 'scan-preserve-sug' }], pipelinePasses: 3 }),
    });
    assert(acceptR.status === 200, 'Bug 2 setup: accept returns 200');
    const acceptBody = await acceptR.json();
    assert(acceptBody?.status === 'accepted', 'Bug 2 setup: row is accepted');

    // Trigger a scan (Bug 2: previously staled the accepted row)
    const scanR = await fetch(`${base}/api/projects/${projScan}/suggestions/scan`, { method: 'POST' });
    assert(scanR.status === 200, 'Bug 2: scan after accept returns 200');

    // The accepted row must survive the scan untouched
    const afterScan = getSuggestionsById(idScan);
    assert(afterScan?.status === 'accepted', 'Bug 2: accepted plan row survives scan (status still accepted)');

    try { rmSync(projScanDir, { recursive: true, force: true }); } catch {}
  }

  // ─── Bug 3 regression: pipelinePasses validation ─────────────────────────────
  console.log('\nBug 3 regression: pipelinePasses validation:');

  {
    // Helper to create a project with one suggestion for validation tests
    async function makePassesProject(suffix) {
      const projName = `sug-passes-${suffix}-${Date.now()}`;
      upsertProject({ name: projName, tech_stack: 'node', total_phases: 1, status: 'in-progress' });
      const suggId = saveSuggestions(projName, {
        projectType: 'cli',
        scanSnapshot: {},
        suggestions: [{ id: 'passes-sug', title: 'Test', type: 'enhancement', category: 'logic',
                        effort: 'small', impact: 'medium', suggestedSlot: 1, description: '', appliesTo: [] }],
      });
      return { projName, suggId };
    }

    // pipelinePasses:"abc" → NaN → 400
    {
      const { projName, suggId } = await makePassesProject('abc');
      const r = await fetch(`${base}/api/projects/${projName}/suggestions/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: suggId, selected: [{ id: 'passes-sug' }], pipelinePasses: 'abc' }),
      });
      assert(r.status === 400, 'Bug 3: pipelinePasses:"abc" returns 400');
    }

    // pipelinePasses:6 → out of range → 400
    {
      const { projName, suggId } = await makePassesProject('6');
      const r = await fetch(`${base}/api/projects/${projName}/suggestions/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: suggId, selected: [{ id: 'passes-sug' }], pipelinePasses: 6 }),
      });
      assert(r.status === 400, 'Bug 3: pipelinePasses:6 (out of range) returns 400');
    }

    // pipelinePasses:0 → falsy guard fires before new check → 400
    {
      const { projName, suggId } = await makePassesProject('0');
      const r = await fetch(`${base}/api/projects/${projName}/suggestions/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: suggId, selected: [{ id: 'passes-sug' }], pipelinePasses: 0 }),
      });
      assert(r.status === 400, 'Bug 3: pipelinePasses:0 returns 400');
    }

    // pipelinePasses:3 → valid → 200, row accepted
    {
      const { projName, suggId } = await makePassesProject('3');
      const projDir3 = path.join(PROJECTS_DIR, projName);
      mkdirSync(path.join(projDir3, '.guide'), { recursive: true });

      const r = await fetch(`${base}/api/projects/${projName}/suggestions/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: suggId, selected: [{ id: 'passes-sug' }], pipelinePasses: 3 }),
      });
      assert(r.status === 200, 'Bug 3: pipelinePasses:3 (valid) returns 200');
      const body = await r.json();
      assert(body?.status === 'accepted', 'Bug 3: pipelinePasses:3 — row status is accepted');

      try { rmSync(projDir3, { recursive: true, force: true }); } catch {}
    }
  }

  // ─── Test C: /scan-ai response always includes aiUsed boolean ────────────────
  console.log('\nTest C: /scan-ai response includes aiUsed boolean:');

  {
    const projC = `sug-ai-used-${Date.now()}`;
    upsertProject({ name: projC, tech_stack: 'node', total_phases: 1, status: 'in-progress' });
    const projCDir = path.join(PROJECTS_DIR, projC);
    mkdirSync(path.join(projCDir, '.guide'), { recursive: true });
    writeFileSync(path.join(projCDir, 'package.json'), JSON.stringify({ name: projC }));
    writeFileSync(
      path.join(projCDir, 'project.json'),
      JSON.stringify({ $schema_version: 4, name: projC, created_at: new Date().toISOString(), overrides: {} }, null, 2),
    );

    const r = await fetch(`${base}/api/projects/${projC}/suggestions/scan-ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: '', areas: [] }),
    });
    assert(r.status === 200, 'Test C: /scan-ai returns 200');
    const body = await r.json();
    assert(typeof body?.aiUsed === 'boolean', 'Test C: /scan-ai response body includes aiUsed as a boolean');

    try { rmSync(projCDir, { recursive: true, force: true }); } catch {}
  }

  // ─── Test A: draft staling — repeated scans leave ≤1 live draft ─────────────
  console.log('\nTest A: draft staling — repeated scans leave ≤1 live draft:');

  {
    const projA = `sug-draft-stale-${Date.now()}`;
    upsertProject({ name: projA, tech_stack: 'node', total_phases: 1, status: 'in-progress' });
    const projADir = path.join(PROJECTS_DIR, projA);
    mkdirSync(path.join(projADir, '.guide'), { recursive: true });
    writeFileSync(path.join(projADir, 'package.json'), JSON.stringify({ name: projA }));

    const r1 = await fetch(`${base}/api/projects/${projA}/suggestions/scan`, { method: 'POST' });
    assert(r1.status === 200, 'Test A: first scan returns 200');
    const row1 = await r1.json();
    assert(row1?.status === 'draft', 'Test A: first scan row is draft');

    const r2 = await fetch(`${base}/api/projects/${projA}/suggestions/scan`, { method: 'POST' });
    assert(r2.status === 200, 'Test A: second scan returns 200');
    const row2 = await r2.json();
    assert(row2?.status === 'draft', 'Test A: second scan row is draft');

    // Second scan must have created a new row
    assert(row1?.id !== row2?.id, 'Test A: second scan row has a different id from the first');

    // First row must now be stale
    const row1AfterScan = getSuggestionsById(row1.id);
    assert(row1AfterScan?.status === 'stale', 'Test A: first scan row is staled by the second scan');

    // getLatestSuggestions must point at the second (newest) draft
    const latest = getLatestSuggestions(projA);
    assert(latest?.id === row2?.id, 'Test A: getLatestSuggestions returns the newest draft (second scan)');

    try { rmSync(projADir, { recursive: true, force: true }); } catch {}
  }

  // ─── Test B: staled draft titles appear in dedup history ─────────────────────
  console.log('\nTest B: staled draft titles appear in dedup history:');

  {
    const projB = `sug-dedup-history-${Date.now()}`;
    upsertProject({ name: projB, tech_stack: 'node', total_phases: 1, status: 'in-progress' });

    // Insert a draft row with a known suggestion title in suggestions_json
    const draftTitle = 'Unique Draft Title For Dedup Test';
    saveSuggestions(projB, {
      projectType: 'cli',
      scanSnapshot: {},
      suggestions: [{ id: 'dedup-sug-1', title: draftTitle, type: 'enhancement', category: 'logic',
                      effort: 'small', impact: 'medium', suggestedSlot: 1, description: '', appliesTo: [] }],
    });

    // Stale the draft directly (simulating what _runScan now does before the next insert)
    staleDraftSuggestions(projB);

    // The draft row now has status='stale', selected_json=NULL, but suggestions_json has the title
    const titles = getEarlierSuggestionTitles(projB);
    assert(titles.includes(draftTitle), 'Test B: staled draft title appears in getEarlierSuggestionTitles (via suggestions_json)');
  }

  // ─── Test D: accepted plan wins over a newer draft ────────────────────────────
  console.log('\nTest D: accepted plan wins over a newer draft:');

  {
    const projD = `sug-accepted-wins-${Date.now()}`;
    upsertProject({ name: projD, tech_stack: 'node', total_phases: 1, status: 'in-progress' });

    // Step 1: create a draft and accept it
    const idA = saveSuggestions(projD, {
      projectType: 'cli',
      scanSnapshot: {},
      suggestions: [{ id: 'sug-d-1', title: 'First suggestion', type: 'enhancement', category: 'logic',
                      effort: 'small', impact: 'medium', suggestedSlot: 1, description: '', appliesTo: [] }],
    });
    acceptSuggestions(idA, { selected: [{ id: 'sug-d-1' }], pipelinePlan: [], pipelinePasses: 1 });

    // Step 2: simulate a re-scan (stale drafts only, then insert new draft)
    staleDraftSuggestions(projD);
    const idB = saveSuggestions(projD, {
      projectType: 'cli',
      scanSnapshot: {},
      suggestions: [{ id: 'sug-d-2', title: 'Second suggestion after rescan', type: 'enhancement', category: 'logic',
                      effort: 'small', impact: 'medium', suggestedSlot: 1, description: '', appliesTo: [] }],
    });

    // Step 3: accepted row must win — it has a lower id but higher priority
    const latest = getLatestSuggestions(projD);
    assert(latest?.status === 'accepted', 'Test D: getLatestSuggestions returns accepted row despite newer draft');
    assert(latest?.id === idA, 'Test D: getLatestSuggestions id matches the accepted row (not the newer draft)');

    // Step 4: the new draft is still readable by id
    const newDraft = getSuggestionsById(idB);
    assert(newDraft?.status === 'draft', 'Test D: newer draft row still exists and is readable by id');
  }

  // ─── Bug 4 regression: scan concurrency guard ─────────────────────────────
  console.log('\nBug 4 regression: scan concurrency guard:');

  {
    const projLock = `sug-lock-${Date.now()}`;
    upsertProject({ name: projLock, tech_stack: 'node', total_phases: 1, status: 'in-progress' });
    const projLockDir = path.join(PROJECTS_DIR, projLock);
    mkdirSync(path.join(projLockDir, '.guide'), { recursive: true });
    writeFileSync(path.join(projLockDir, 'package.json'), JSON.stringify({ name: projLock, dependencies: { express: '*', chalk: '*' } }));
    mkdirSync(path.join(projLockDir, 'src'), { recursive: true });

    // Fire two concurrent scan requests for the same project
    const [r1, r2] = await Promise.all([
      fetch(`${base}/api/projects/${projLock}/suggestions/scan`, { method: 'POST' }),
      fetch(`${base}/api/projects/${projLock}/suggestions/scan`, { method: 'POST' }),
    ]);
    const statuses = [r1.status, r2.status].sort();

    assert(statuses.includes(200), 'Bug 4: at least one concurrent scan succeeds (200)');
    assert(statuses.includes(409), 'Bug 4: second concurrent scan is rejected (409)');

    // Verify the 409 body has an error string
    const body409 = r1.status === 409 ? await r1.json() : await r2.json();
    assert(typeof body409.error === 'string', 'Bug 4: 409 response has error string');

    // After the lock is released, a subsequent scan must succeed (guard released by finally)
    const r3 = await fetch(`${base}/api/projects/${projLock}/suggestions/scan`, { method: 'POST' });
    assert(r3.status === 200, 'Bug 4: scan succeeds after in-flight lock is released');

    // Concurrent scans for DIFFERENT projects must both succeed
    const projLock2 = `sug-lock2-${Date.now()}`;
    upsertProject({ name: projLock2, tech_stack: 'node', total_phases: 1, status: 'in-progress' });
    const projLock2Dir = path.join(PROJECTS_DIR, projLock2);
    mkdirSync(path.join(projLock2Dir, '.guide'), { recursive: true });
    writeFileSync(path.join(projLock2Dir, 'package.json'), JSON.stringify({ name: projLock2 }));

    const [rA, rB] = await Promise.all([
      fetch(`${base}/api/projects/${projLock}/suggestions/scan`,  { method: 'POST' }),
      fetch(`${base}/api/projects/${projLock2}/suggestions/scan`, { method: 'POST' }),
    ]);
    assert(rA.status === 200, 'Bug 4: concurrent scans for different projects — project 1 succeeds');
    assert(rB.status === 200, 'Bug 4: concurrent scans for different projects — project 2 succeeds');

    try { rmSync(projLockDir,  { recursive: true, force: true }); } catch {}
    try { rmSync(projLock2Dir, { recursive: true, force: true }); } catch {}
  }

  // ─── fix-r35-2: scan-ai route uses canonical project name (noLm smoke test) ──
  console.log('\nfix-r35-2: scan-ai billing attribution — canonical project name:');

  {
    // package.json name intentionally differs from the route param to confirm
    // the route uses the canonical dir name, not the package.json name.
    const projName = `sug-scanai-billing-${Date.now()}`;
    upsertProject({ name: projName, tech_stack: 'node', total_phases: 1, status: 'in-progress' });
    const projDir = path.join(PROJECTS_DIR, projName);
    mkdirSync(path.join(projDir, '.guide'), { recursive: true });
    writeFileSync(path.join(projDir, 'package.json'), JSON.stringify({ name: 'some-other-package-name' }));

    // Billing attribution for the AI path (when noLm: false) is covered by the
    // callClaude dep-injection tests in src/lib/ai-suggestion-scanner.test.mjs:374-388.
    const r = await fetch(`${base}/api/projects/${projName}/suggestions/scan-ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'test goal', areas: [], noLm: true }),
    });
    assert(r.status === 200, 'fix-r35-2: scan-ai (noLm) returns 200');
    const row = await r.json();
    assert(row?.project === projName, `fix-r35-2: returned row.project equals route :name param ("${projName}")`);

    // Verify DB row also carries the canonical name
    const dbRow = getSuggestionsById(row.id);
    assert(dbRow?.project === projName, 'fix-r35-2: DB row project field equals canonical project name');

    try { rmSync(projDir, { recursive: true, force: true }); } catch {}
  }

  // ─── Phase-15: /api/window shape ─────────────────────────────────────────────
  console.log('\nPhase-15: /api/window:');

  {
    const r = await fetch(`${base}/api/window`);
    const body = await r.json();
    assert(r.ok, 'GET /api/window returns 200');
    assert(['ok', 'warn', 'pause'].includes(body.state), '/api/window state is ok|warn|pause');
    assert(typeof body.callsInWindow === 'number', '/api/window callsInWindow admission units is a number');
    assert(typeof body.rawCallsInWindow === 'number', '/api/window preserves raw subprocess attempt count');
    assert(typeof body.windowHours === 'number', '/api/window windowHours is a number');
    assert(typeof body.warnThreshold === 'number', '/api/window warnThreshold is a number');
    assert(typeof body.pauseThreshold === 'number', '/api/window pauseThreshold is a number');
    assert(typeof body.warnCostThreshold === 'number', '/api/window warnCostThreshold is a number');
    assert(typeof body.pauseCostThreshold === 'number', '/api/window pauseCostThreshold is a number');
    assert(typeof body.totalCostInWindow === 'number', '/api/window totalCostInWindow is a number');
    assert('oldestCallAt' in body, '/api/window includes oldestCallAt key');
  }

  // ─── Phase-15: /runs history ─────────────────────────────────────────────────
  console.log('\nPhase-15: /runs:');

  let runId1, runId2;
  {
    runId1 = startAutoRun({ project: TEST_PROJECT });
    pauseAutoRun(runId1, 'first test pause', 'other');
    await new Promise((r) => setTimeout(r, 10)); // distinct started_at for ordering
    runId2 = startAutoRun({ project: TEST_PROJECT });
    pauseAutoRun(runId2, 'review checkpoint reached', 'review-checkpoint');

    const r = await fetch(`${base}/api/projects/${TEST_PROJECT}/runs`);
    const body = await r.json();
    assert(r.ok && Array.isArray(body), 'GET /runs returns array');
    assert(body.length >= 2, 'GET /runs returns both seeded runs');
    assert(body[0].id === runId2, 'GET /runs is newest-first (row 0 is the latest run)');
    assert(body[0].status === 'paused', 'GET /runs row has status');
    assert(body[0].pause_reason === 'review checkpoint reached', 'GET /runs row has pause_reason');
    assert(body[0].pause_kind === 'review-checkpoint', 'GET /runs row has pause_kind');
    assert('started_at' in body[0] && 'ended_at' in body[0] && 'unattended' in body[0], 'GET /runs row has started_at/ended_at/unattended');

    const rLimit = await fetch(`${base}/api/projects/${TEST_PROJECT}/runs?limit=1`);
    const bodyLimit = await rLimit.json();
    assert(rLimit.ok && bodyLimit.length === 1, 'GET /runs?limit=1 returns exactly 1 row');

    const r404 = await fetch(`${base}/api/projects/no-such-project-xyz/runs`);
    assert(r404.status === 404, 'GET /runs on unknown project returns 404');
  }

  // ─── Phase-15: /log-tail ─────────────────────────────────────────────────────
  console.log('\nPhase-15: /log-tail:');

  {
    // No logs yet for this project → graceful empty shape, not 500
    const r = await fetch(`${base}/api/projects/${TEST_PROJECT}/log-tail`);
    const body = await r.json();
    assert(r.ok, 'GET /log-tail with no logs returns 200');
    assert(body.file === null && body.task === null && body.mtimeMs === null, 'GET /log-tail no logs: file/task/mtimeMs are null');
    assert(body.active === false && Array.isArray(body.entries) && body.entries.length === 0, 'GET /log-tail no logs: active:false, entries:[]');
  }

  {
    // Synthetic stream-json log in <repo>/logs
    const logsDir = path.join(REPO_ROOT, 'logs');
    mkdirSync(logsDir, { recursive: true });
    syntheticLogFile = path.join(logsDir, `${TEST_PROJECT}-dev-execution-${Date.now()}.stdout.log`);
    const logLines = [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on the fix now' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'all 12 tests passed' }] }] } }),
      'this line is not JSON and must be skipped',
      JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.1234 }),
    ];
    writeFileSync(syntheticLogFile, logLines.join('\n') + '\n');

    const r = await fetch(`${base}/api/projects/${TEST_PROJECT}/log-tail`);
    const body = await r.json();
    assert(r.ok, 'GET /log-tail with synthetic log returns 200');
    assert(body.file === path.basename(syntheticLogFile), 'GET /log-tail picks the synthetic log file');
    assert(body.task === 'dev-execution', 'GET /log-tail parses task from filename');
    assert(typeof body.mtimeMs === 'number', 'GET /log-tail returns numeric mtimeMs');
    assert(body.active === true, 'GET /log-tail freshly-written log is active');
    assert(body.entries.length === 5, 'GET /log-tail parses 5 entries (garbage line skipped)');
    assert(body.entries[0].t === 'init' && body.entries[0].detail.includes('claude-sonnet-4-6'), 'entry 0 is init with model');
    assert(body.entries[1].t === 'text' && body.entries[1].detail === 'Working on the fix now', 'entry 1 is assistant text');
    assert(body.entries[2].t === 'tool' && body.entries[2].name === 'Bash' && body.entries[2].detail === 'npm test', 'entry 2 is tool_use Bash → npm test');
    assert(body.entries[3].t === 'result' && body.entries[3].detail === 'all 12 tests passed', 'entry 3 is tool_result text');
    assert(body.entries[4].t === 'result' && body.entries[4].detail.startsWith('done — success cost $0.1234'), 'entry 4 is final result with cost');

    // ?lines=2 returns only the LAST two parseable entries
    const r2 = await fetch(`${base}/api/projects/${TEST_PROJECT}/log-tail?lines=2`);
    const body2 = await r2.json();
    assert(r2.ok && body2.entries.length === 2, 'GET /log-tail?lines=2 returns 2 entries');
    assert(body2.entries[1].detail.startsWith('done —'), 'GET /log-tail?lines=2 keeps the newest entries');
  }

  // ─── Phase-15: /next-actions ─────────────────────────────────────────────────
  console.log('\nPhase-15: /next-actions:');

  {
    // Last auto-run is paused (review-checkpoint) → engine should surface Resume
    const r = await fetch(`${base}/api/projects/${TEST_PROJECT}/next-actions`);
    const body = await r.json();
    assert(r.ok && Array.isArray(body) && body.length > 0, 'GET /next-actions returns non-empty array');
    assert(body.every(a => typeof a.id === 'number' && typeof a.label === 'string' && typeof a.kind === 'string'), 'every next-action has id/label/kind');
    assert(body.every(a => 'description' in a && 'cmd' in a && 'priority' in a), 'every next-action keeps description/cmd/priority (lossless)');
    assert(body.some(a => a.label.includes('Resume')), 'paused run surfaces a Resume action');

    const r404 = await fetch(`${base}/api/projects/no-such-project-xyz/next-actions`);
    assert(r404.status === 404, 'GET /next-actions on unknown project returns 404');
  }

  // ─── Phase-15: artifacts list + file read + traversal rejection ─────────────
  console.log('\nPhase-15: /artifacts:');

  {
    const guideDir = path.join(PROJ_DIR, '.guide');
    mkdirSync(path.join(guideDir, 'reviews'), { recursive: true });
    mkdirSync(path.join(guideDir, 'phases', '01-init'), { recursive: true });
    mkdirSync(path.join(guideDir, 'node_modules'), { recursive: true });
    mkdirSync(path.join(guideDir, '.hidden'), { recursive: true });
    writeFileSync(path.join(guideDir, 'plan.md'), '# Plan\n');
    writeFileSync(path.join(guideDir, 'brief.md'), '# Brief\n');
    writeFileSync(path.join(guideDir, 'decisions.jsonl'), '{"decision":"yes"}\n');
    writeFileSync(path.join(guideDir, 'reviews', 'after-2.md'), '# Review after phase 2\n');
    writeFileSync(path.join(guideDir, 'phases', '01-init', 'report.md'), '# Phase 1 report\n');
    writeFileSync(path.join(guideDir, 'notes.txt'), 'not an artifact\n');
    writeFileSync(path.join(guideDir, 'node_modules', 'skip.md'), 'skip me\n');
    writeFileSync(path.join(guideDir, '.hidden', 'secret.md'), 'hidden\n');

    const r = await fetch(`${base}/api/projects/${TEST_PROJECT}/artifacts`);
    const body = await r.json();
    assert(r.ok && Array.isArray(body), 'GET /artifacts returns array');
    const byPath = new Map(body.map(a => [a.path, a]));
    assert(byPath.get('plan.md')?.group === 'plan', 'plan.md → group plan');
    assert(byPath.get('brief.md')?.group === 'brief', 'brief.md → group brief');
    assert(byPath.get('reviews/after-2.md')?.group === 'reviews', 'reviews/after-2.md → group reviews (posix path)');
    assert(byPath.get('phases/01-init/report.md')?.group === 'reports', 'phases/**/report.md → group reports');
    assert(byPath.get('decisions.jsonl')?.group === 'decisions', 'decisions.jsonl → group decisions');
    assert(body.some(a => a.group === 'bug-rounds'), 'bug-rounds/** files (from promote tests) → group bug-rounds');
    assert(!body.some(a => a.path.endsWith('.txt')), 'non-allowlisted extensions excluded');
    assert(!body.some(a => a.path.includes('node_modules')), 'node_modules excluded');
    assert(!body.some(a => a.path.includes('.hidden')), 'hidden dirs excluded');
    assert(body.every(a => typeof a.name === 'string' && typeof a.size === 'number' && typeof a.mtime === 'string'), 'every artifact has name/size/mtime');
    assert(body.findIndex(a => a.path === 'plan.md') < body.findIndex(a => a.path === 'brief.md'), 'sorted by group: plan before brief');

    // File read
    const rf = await fetch(`${base}/api/projects/${TEST_PROJECT}/artifacts/file?path=plan.md`);
    const bf = await rf.json();
    assert(rf.ok && bf.path === 'plan.md' && bf.content === '# Plan\n' && typeof bf.mtime === 'string', 'GET /artifacts/file reads plan.md');

    const rn = await fetch(`${base}/api/projects/${TEST_PROJECT}/artifacts/file?path=reviews/after-2.md`);
    assert(rn.ok && (await rn.json()).content.includes('Review after phase 2'), 'GET /artifacts/file reads nested review');

    // Traversal rejection
    const rt = await fetch(`${base}/api/projects/${TEST_PROJECT}/artifacts/file?path=${encodeURIComponent('../../etc/passwd')}`);
    assert(rt.status === 400, 'GET /artifacts/file path=../../etc/passwd → 400');
    const rt2 = await fetch(`${base}/api/projects/${TEST_PROJECT}/artifacts/file?path=${encodeURIComponent('../project.json')}`);
    assert(rt2.status === 400, 'GET /artifacts/file path=../project.json (escapes .guide) → 400');
    const rext = await fetch(`${base}/api/projects/${TEST_PROJECT}/artifacts/file?path=notes.txt`);
    assert(rext.status === 400, 'GET /artifacts/file .txt extension → 400');
    const rmiss = await fetch(`${base}/api/projects/${TEST_PROJECT}/artifacts/file?path=missing.md`);
    assert(rmiss.status === 404, 'GET /artifacts/file missing file → 404');
    const rnopath = await fetch(`${base}/api/projects/${TEST_PROJECT}/artifacts/file`);
    assert(rnopath.status === 400, 'GET /artifacts/file without ?path → 400');
  }

  // ─── Phase-15: /api/jobs + DELETE /api/jobs/:id ─────────────────────────────
  console.log('\nPhase-15: /api/jobs:');

  {
    const pendingJobId = enqueueJob({ project: TEST_PROJECT, action: 'go', args: {}, requestedBy: 'test' });
    const runningJobId = enqueueJob({ project: TEST_PROJECT, action: 'audit', args: {}, requestedBy: 'test' });
    markJobRunning(runningJobId);

    const r = await fetch(`${base}/api/jobs`);
    const body = await r.json();
    assert(r.ok, 'GET /api/jobs returns 200');
    assert(Array.isArray(body.pending) && Array.isArray(body.running) && Array.isArray(body.recent), 'GET /api/jobs has pending/running/recent arrays');
    assert(body.pending.some(j => j.id === pendingJobId), 'pending array contains the queued job');
    assert(body.running.some(j => j.id === runningJobId), 'running array contains the running job');
    assert(body.recent.some(j => j.id === pendingJobId), 'recent array includes recent rows');

    // DELETE guards
    const r404 = await fetch(`${base}/api/jobs/999999`, { method: 'DELETE' });
    assert(r404.status === 404, 'DELETE /api/jobs/:id unknown id → 404');
    const r409 = await fetch(`${base}/api/jobs/${runningJobId}`, { method: 'DELETE' });
    assert(r409.status === 409, 'DELETE /api/jobs/:id on running job → 409');
    assert((await r409.json()).error === 'Job is not pending', 'DELETE 409 body says Job is not pending');

    const rok = await fetch(`${base}/api/jobs/${pendingJobId}`, { method: 'DELETE' });
    const bok = await rok.json();
    assert(rok.ok && bok.ok === true, 'DELETE /api/jobs/:id on pending job → {ok:true}');
    assert(getJob(pendingJobId) === undefined, 'dequeued pending job row is gone');
  }

  // ─── Phase-15: POST bugs + requirements capture ──────────────────────────────
  console.log('\nPhase-15: POST /bugs + /requirements capture:');

  {
    const r = await fetch(`${base}/api/projects/${TEST_PROJECT}/bugs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw_text: 'Web-captured bug', severity: 'major' }),
    });
    const body = await r.json();
    assert(r.ok && body.ok === true && typeof body.id === 'number', 'POST /bugs returns {ok:true, id}');
    const row = getBug(body.id);
    assert(row?.raw_text === 'Web-captured bug' && row?.severity === 'major' && row?.source === 'web', 'POST /bugs row lands with raw_text/severity/source:web');

    const rDefault = await fetch(`${base}/api/projects/${TEST_PROJECT}/bugs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw_text: 'No severity given' }),
    });
    const bDefault = await rDefault.json();
    assert(rDefault.ok && getBug(bDefault.id)?.severity === 'unassigned', 'POST /bugs without severity defaults to unassigned');

    const rEmpty = await fetch(`${base}/api/projects/${TEST_PROJECT}/bugs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw_text: '' }),
    });
    assert(rEmpty.status === 400, 'POST /bugs with empty raw_text → 400');

    const rBadSev = await fetch(`${base}/api/projects/${TEST_PROJECT}/bugs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw_text: 'x', severity: 'catastrophic' }),
    });
    assert(rBadSev.status === 400, 'POST /bugs with invalid severity → 400');

    const rNoProj = await fetch(`${base}/api/projects/no-such-project-xyz/bugs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw_text: 'x' }),
    });
    assert(rNoProj.status === 404, 'POST /bugs on unknown project → 404');
  }

  {
    const r = await fetch(`${base}/api/projects/${TEST_PROJECT}/requirements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw_text: 'Web-captured requirement' }),
    });
    const body = await r.json();
    assert(r.ok && body.ok === true && typeof body.id === 'number', 'POST /requirements returns {ok:true, id}');
    const row = getRequirement(body.id);
    assert(row?.raw_text === 'Web-captured requirement' && row?.source === 'web', 'POST /requirements row lands with raw_text/source:web');

    const rEmpty = await fetch(`${base}/api/projects/${TEST_PROJECT}/requirements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw_text: '   ' }),
    });
    assert(rEmpty.status === 400, 'POST /requirements with whitespace raw_text → 400');

    const rNoProj = await fetch(`${base}/api/projects/no-such-project-xyz/requirements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw_text: 'x' }),
    });
    assert(rNoProj.status === 404, 'POST /requirements on unknown project → 404');
  }

  // ─── Phase-15: processAlive/runningJob in project payload ────────────────────
  console.log('\nPhase-15: processAlive in project payload:');

  {
    const r1 = await fetch(`${base}/api/projects/${TEST_PROJECT}`);
    const b1 = await r1.json();
    assert(typeof b1.processAlive === 'boolean', 'project payload has boolean processAlive');
    assert(b1.processAlive === false && b1.runningJob === null, 'no running_jobs row → processAlive:false, runningJob:null');

    // Use this test process's own (live) pid: processAlive verifies the pid is
    // a running process, so a synthetic/dead pid would read as not-alive.
    claimRunningJob(TEST_PROJECT, process.pid);
    const r2 = await fetch(`${base}/api/projects/${TEST_PROJECT}`);
    const b2 = await r2.json();
    assert(b2.processAlive === true, 'running_jobs row with live pid → processAlive:true');
    assert(b2.runningJob?.pid === process.pid && typeof b2.runningJob?.started_at === 'string', 'runningJob carries {pid, started_at}');
    releaseRunningJob(TEST_PROJECT);

    // A stale row whose pid is dead (crashed orchestrator that never cleaned up)
    // must NOT report processAlive — otherwise the UI shows a phantom run forever.
    claimRunningJob(TEST_PROJECT, 2147483646); // pid that cannot be running
    const r3 = await fetch(`${base}/api/projects/${TEST_PROJECT}`);
    const b3 = await r3.json();
    assert(b3.processAlive === false && b3.runningJob === null, 'stale row with dead pid → processAlive:false');
    releaseRunningJob(TEST_PROJECT);

    // list endpoint carries the fields too
    const rList = await fetch(`${base}/api/projects`);
    const list = await rList.json();
    const mine = list.find(p => p.name === TEST_PROJECT);
    assert(mine && typeof mine.processAlive === 'boolean' && 'runningJob' in mine, 'GET /api/projects rows also carry processAlive/runningJob');
  }

} finally {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => authServer.close(resolve));
  closeDb();
  for (const releaseFile of syntheticReleaseFiles) {
    try { rmSync(releaseFile, { force: true }); } catch {}
  }
  try { rmSync(testDbDir, { recursive: true, force: true }); } catch {}
  try { rmSync(PROJ_DIR, { recursive: true, force: true }); } catch {}
  if (syntheticLogFile) { try { rmSync(syntheticLogFile, { force: true }); } catch {} }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
