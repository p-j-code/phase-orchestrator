#!/usr/bin/env node
// Verify SSE streaming endpoints added in phase 4.
// Run: node scripts/verify-sse.mjs

import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { rm } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Isolated DB so we never corrupt live data
const tmpDb = path.join(tmpdir(), `verify-sse-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;

const { createWebUiApp, uiEvents, ensureAuthToken } = await import('../src/web-ui.js');
const { getDb } = await import('../src/state.js');

// Bearer token: real bootstrap (idempotent — reuses config/web-auth-token.txt if present)
const { token: authToken } = await ensureAuthToken();
const authHeaders = { Authorization: `Bearer ${authToken}` };

const db = getDb();
// Seed a dummy project so the status poller has something to watch
db.prepare(
  `INSERT OR IGNORE INTO projects (name, created_at, status, current_phase, total_phases) VALUES (?,?,?,?,?)`
).run('verify-proj', new Date().toISOString(), 'planning', 0, 5);

const app = createWebUiApp({ authToken });
const server = app.listen(0);
await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();

let passed = 0;
const total = 10;

function get(urlPath, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${urlPath}`, { headers }, resolve).on('error', reject);
  });
}

// Read the full body of a (non-stream) response.
function getBody(res) {
  return new Promise((resolve) => {
    let body = '';
    res.on('data', c => { body += c.toString(); });
    res.on('end', () => resolve(body));
  });
}

function waitForSseEvent(res, predicate, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      res.removeListener('data', onData);
      reject(new Error(`Timeout (${timeoutMs}ms) waiting for matching SSE event`));
    }, timeoutMs);

    function onData(chunk) {
      buffer += chunk.toString();
      const frames = buffer.split('\n\n');
      buffer = frames.pop();
      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (line.startsWith('data: ')) {
            try {
              const evt = JSON.parse(line.slice(6));
              if (predicate(evt)) {
                clearTimeout(timer);
                res.removeListener('data', onData);
                resolve(evt);
                return;
              }
            } catch {}
          }
        }
      }
    }
    res.on('data', onData);
  });
}

// ── Test 1: SSE headers on /api/stream ───────────────────────────────────────
let sseRes;
try {
  sseRes = await get(`/api/stream?token=${authToken}`);
  const ct = sseRes.headers['content-type'] || '';
  const cc = sseRes.headers['cache-control'] || '';
  const conn = sseRes.headers['connection'] || '';
  if (!ct.includes('text/event-stream')) throw new Error(`Bad Content-Type: ${ct}`);
  if (!cc.includes('no-cache')) throw new Error(`Bad Cache-Control: ${cc}`);
  if (!conn.toLowerCase().includes('keep-alive')) throw new Error(`Bad Connection: ${conn}`);
  console.log('  ✓ 1/10  /api/stream headers correct (with ?token)');
  passed++;
} catch (e) {
  console.error(`  ✗ 1/10  /api/stream headers: ${e.message}`);
}

// ── Test 2: call event arrives after DB insert ────────────────────────────────
try {
  if (!sseRes) throw new Error('SSE connection not open');
  const callPromise = waitForSseEvent(
    sseRes,
    e => e.type === 'call' && e.project === 'verify-proj',
    1500,
  );
  db.prepare(
    `INSERT INTO calls (project, phase, task, model, started_at, cost_usd, input_tokens, output_tokens, is_error)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run('verify-proj', 1, 'verify-task', 'claude-sonnet-4-6', new Date().toISOString(), 0.001, 100, 50, 0);
  const evt = await callPromise;
  if (evt.tokens !== 150) throw new Error(`Expected tokens=150, got ${evt.tokens}`);
  console.log('  ✓ 2/10  call event received within 1.5s');
  passed++;
} catch (e) {
  console.error(`  ✗ 2/10  call event: ${e.message}`);
}

// ── Test 3: status event arrives after DB update ──────────────────────────────
try {
  if (!sseRes) throw new Error('SSE connection not open');
  const statusPromise = waitForSseEvent(
    sseRes,
    e => e.type === 'status' && e.project === 'verify-proj' && e.status === 'running',
    1500,
  );
  db.prepare(`UPDATE projects SET status='running' WHERE name='verify-proj'`).run();
  await statusPromise;
  console.log('  ✓ 3/10  status event received within 1.5s');
  passed++;
} catch (e) {
  console.error(`  ✗ 3/10  status event: ${e.message}`);
}

// ── Test 4: per-project stream returns 404 for unknown project ────────────────
try {
  const r404 = await get(`/api/projects/nonexistent-xyz/stream?token=${authToken}`);
  if (r404.statusCode !== 404) throw new Error(`Expected 404, got ${r404.statusCode}`);
  r404.resume();
  console.log('  ✓ 4/10  per-project stream returns 404 for unknown project');
  passed++;
} catch (e) {
  console.error(`  ✗ 4/10  per-project 404: ${e.message}`);
}

// ── Test 5: no listener leak after disconnect ─────────────────────────────────
try {
  // Close the original SSE connection first
  if (sseRes) {
    sseRes.destroy();
    await new Promise(r => setTimeout(r, 150));
  }
  const baseline = uiEvents.listenerCount('status');

  // Open a new SSE connection
  const tmpRes = await get(`/api/stream?token=${authToken}`);
  const afterConnect = uiEvents.listenerCount('status');
  if (afterConnect !== baseline + 1) {
    throw new Error(`Expected listener count ${baseline + 1} after connect, got ${afterConnect}`);
  }

  tmpRes.destroy();
  await new Promise(r => setTimeout(r, 150));

  const afterDisconnect = uiEvents.listenerCount('status');
  if (afterDisconnect !== baseline) {
    throw new Error(`Listener leak: baseline=${baseline}, after disconnect=${afterDisconnect}`);
  }
  console.log('  ✓ 5/10  no listener leak after client disconnect');
  passed++;
} catch (e) {
  console.error(`  ✗ 5/10  listener cleanup: ${e.message}`);
}

// ── Test 6: non-stream /api route → 401 without token ─────────────────────────
try {
  const r = await get('/api/stats');
  if (r.statusCode !== 401) throw new Error(`Expected 401, got ${r.statusCode}`);
  const body = JSON.parse(await getBody(r));
  if (body.error !== 'Unauthorized') throw new Error(`Expected {error:'Unauthorized'}, got ${JSON.stringify(body)}`);
  console.log('  ✓ 6/10  /api/stats → 401 without token');
  passed++;
} catch (e) {
  console.error(`  ✗ 6/10  no-token 401: ${e.message}`);
}

// ── Test 7: non-stream /api route → 200 with correct Bearer token ─────────────
try {
  const r = await get('/api/stats', { headers: authHeaders });
  if (r.statusCode !== 200) throw new Error(`Expected 200, got ${r.statusCode}`);
  const body = JSON.parse(await getBody(r));
  if (typeof body.total_calls !== 'number') throw new Error(`Unexpected payload: ${JSON.stringify(body)}`);
  console.log('  ✓ 7/10  /api/stats → 200 with correct Bearer token');
  passed++;
} catch (e) {
  console.error(`  ✗ 7/10  bearer 200: ${e.message}`);
}

// ── Test 8: non-stream /api route → 401 with wrong token ──────────────────────
try {
  const wrong = 'f'.repeat(authToken.length);
  const r = await get('/api/stats', { headers: { Authorization: `Bearer ${wrong}` } });
  if (r.statusCode !== 401) throw new Error(`Expected 401, got ${r.statusCode}`);
  r.resume();
  console.log('  ✓ 8/10  /api/stats → 401 with wrong token');
  passed++;
} catch (e) {
  console.error(`  ✗ 8/10  wrong-token 401: ${e.message}`);
}

// ── Test 9: /api/stream → 401 without ?token (before any stream frame) ────────
try {
  const r = await get('/api/stream');
  if (r.statusCode !== 401) throw new Error(`Expected 401, got ${r.statusCode}`);
  const ct = r.headers['content-type'] || '';
  if (ct.includes('text/event-stream')) throw new Error('Stream opened before auth check');
  const body = JSON.parse(await getBody(r));
  if (body.error !== 'Unauthorized') throw new Error(`Expected {error:'Unauthorized'}, got ${JSON.stringify(body)}`);
  console.log('  ✓ 9/10  /api/stream → 401 without ?token (no stream opened)');
  passed++;
} catch (e) {
  console.error(`  ✗ 9/10  stream no-token 401: ${e.message}`);
}

// ── Test 10: ensureAuthToken is idempotent ────────────────────────────────────
try {
  const again = await ensureAuthToken();
  if (again.token !== authToken) throw new Error(`Token changed on second call: ${again.token} !== ${authToken}`);
  if (again.generated !== false) throw new Error(`Second call reports generated=true (should reuse)`);
  console.log('  ✓ 10/10  ensureAuthToken idempotent (same token, not rewritten)');
  passed++;
} catch (e) {
  console.error(`  ✗ 10/10  ensureAuthToken idempotency: ${e.message}`);
}

// ── Teardown ──────────────────────────────────────────────────────────────────
server.close();
await rm(tmpDb, { force: true });

console.log(`\n${passed === total ? 'OK' : 'FAIL'} verify-sse: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
