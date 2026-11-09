// Per-worker AsyncLocalStorage context.
//
// v0.14.5 added ALS-based console prefixing inline in src/server.js. With the
// addition of the multi-spinner live status area (v0.14.9), other modules
// (notably src/claude-runner.js and src/lib/validators.js) also need to read
// the worker context so their spinner entries can be labelled `[wN project]`.
//
// We host the ALS instance here so importers don't pull in src/server.js
// (which would create circular import problems with anything server.js itself
// imports). server.js imports from this module instead of defining the ALS
// inline.

import { AsyncLocalStorage } from 'node:async_hooks';

export const workerContext = new AsyncLocalStorage();

export function getWorkerContext() {
  return workerContext.getStore() || null;
}

// par-01-jobkeys: mint a stable tracking key for one LOGICAL job (a whole
// runClaude call, including every retry attempt inside it) and carry it via
// ALS for the duration of `fn`. This is the CLI-path analogue of what the
// worker pool already does at server-telegram.js/server-discord.js's
// `workerContext.run({..., jobId: job.id}, ...)` call sites — those wrap an
// entire job (which may itself invoke runClaude more than once) in ONE ALS
// frame, so claude-runner's currentJobKey() sees the same jobId across every
// attempt of every spawn inside that job.
//
// Why the key must be minted ONCE per job and NOT per spawn: claude-runner's
// spawnClaude() runs once PER RETRY ATTEMPT inside runClaude's own retry loop
// (up to 3 attempts, with backoff sleeps in between), and the retry-backoff
// cancel path deliberately depends on the SAME key surviving from one attempt
// to the next — a cancel that lands during the backoff sleep must still be
// honored when the next attempt spawns (see claude-runner.js's
// `_cancelRequested.has(jobKey)` check right after trackProcess in
// spawnClaude). A per-spawn key would silently drop that guarantee, and would
// also break killCurrent()'s no-arg default (it re-derives the "current" key
// via currentJobKey() — a fresh mint there would never match the key the
// running spawn was tracked under).
//
// Nested calls: if a jobId is already present in the ALS store (e.g. code
// already running inside a worker-pool job, or a nested withJobKey), we reuse
// it rather than minting a new one — the outermost caller owns the identity.
let _seq = 0;
export function withJobKey(key, fn) {
  const existing = getWorkerContext();
  const jobId = key ?? existing?.jobId ?? `cli:${process.pid}:${++_seq}`;
  const store = { ...(existing || {}), jobId };
  return workerContext.run(store, fn);
}
