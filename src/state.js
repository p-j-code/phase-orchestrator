// State — SQLite-backed orchestrator state.
//
// v0.2 adds: auto_runs table, bug_rounds table, project.status column, helpers.

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DB_PATH = path.join(REPO_ROOT, 'state', 'orchestrator.db');

let _db = null;
let _dbSuspensionReason = null;

// `PRAGMA journal_mode=WAL` can return SQLITE_BUSY immediately when two fresh
// orchestrator processes open the same file at once (the connection timeout is
// not honored consistently by this mode-changing pragma). State APIs are
// synchronous by design, so perform a short bounded synchronous retry only at
// first connection instead of letting one overnight worker crash at startup.
function enableWalWithRetry(db, { attempts = 200, delayMs = 25 } = {}) {
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt += 1) {
    try {
      db.pragma('journal_mode = WAL');
      return;
    } catch (err) {
      if (!/SQLITE_BUSY|database is locked/i.test(String(err?.message || err)) || attempt >= attempts - 1) {
        throw err;
      }
      Atomics.wait(waiter, 0, 0, delayMs);
    }
  }
}

function getDb() {
  if (_dbSuspensionReason) {
    const err = new Error(`SQLite state access is temporarily suspended: ${_dbSuspensionReason}`);
    err.code = 'STATE_DB_SUSPENDED';
    throw err;
  }
  if (_db) return _db;
  const dbPath = process.env.DB_PATH || DEFAULT_DB_PATH;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  _db = new Database(dbPath);
  enableWalWithRetry(_db);
  // better-sqlite3 installs a 5s busy timeout by default for ordinary
  // statements. The explicit value documents the cross-process lease contract
  // and protects it if the dependency default changes.
  _db.pragma('busy_timeout = 5000');
  _db.pragma('foreign_keys = ON');
  migrate(_db);
  return _db;
}

export { getDb };
// Phase 31: exposed so state.test.mjs can assert migrate() is idempotent
// (running it twice against the same db must not throw — every ALTER TABLE
// ADD COLUMN goes through the addCol duplicate-column-swallowing helper).
export { migrate };

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      name TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      tech_stack TEXT,
      profile TEXT,
      current_phase INTEGER NOT NULL DEFAULT 0,
      total_phases INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'planning',
      guide_session_id TEXT,
      last_dev_session_id TEXT,
      metadata_json TEXT
    );

    -- A deletion fence shared by every process. deleteProject writes this row
    -- before removing queue/state rows; queue enqueue/claim paths refuse a
    -- tombstoned slug until an explicit upsert recreates the project.
    CREATE TABLE IF NOT EXISTS project_tombstones (
      project    TEXT PRIMARY KEY,
      deleted_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS phases (
      project TEXT NOT NULL,
      n INTEGER NOT NULL,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      model_used TEXT,
      session_id TEXT,
      commit_sha TEXT,
      started_at TEXT,
      completed_at TEXT,
      interruption_kind TEXT,
      interruption_reason TEXT,
      interrupted_at TEXT,
      PRIMARY KEY (project, n),
      FOREIGN KEY (project) REFERENCES projects(name) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('guide', 'dev')),
      started_at TEXT NOT NULL,
      last_resumed_at TEXT,
      total_calls INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (project) REFERENCES projects(name) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      project TEXT,
      phase INTEGER,
      task TEXT NOT NULL,
      model TEXT NOT NULL,
      started_at TEXT NOT NULL,
      duration_ms INTEGER,
      cost_usd REAL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_creation_tokens INTEGER,
      is_error INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE SET NULL,
      FOREIGN KEY (project) REFERENCES projects(name) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS context_manifests (
      manifest_id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      phase INTEGER,
      task_kind TEXT NOT NULL,
      base_sha TEXT,
      provider TEXT NOT NULL,
      mode TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      duration_ms INTEGER,
      token_estimate INTEGER,
      confidence REAL,
      candidate_files INTEGER,
      candidate_symbols INTEGER,
      package_scopes TEXT,
      predicted_files TEXT,
      actual_files TEXT,
      precision REAL,
      recall REAL,
      manifest_path TEXT,
      status TEXT NOT NULL DEFAULT 'compiled',
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS context_compile_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      phase INTEGER,
      task_kind TEXT NOT NULL,
      requested_mode TEXT NOT NULL,
      provider TEXT NOT NULL,
      started_at TEXT NOT NULL,
      duration_ms INTEGER,
      status TEXT NOT NULL,
      manifest_id TEXT,
      compiler_fingerprint TEXT,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS context_compiler_rollouts (
      project TEXT PRIMARY KEY,
      configured_mode TEXT NOT NULL,
      effective_mode TEXT NOT NULL,
      recommendation TEXT NOT NULL,
      stage_id TEXT,
      evidence_json TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS context_compiler_rollout_events (
      stage_id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      configured_mode TEXT NOT NULL,
      effective_mode TEXT NOT NULL,
      recommendation TEXT NOT NULL,
      evidence_json TEXT,
      created_at TEXT NOT NULL
    );

    -- Per-execution phase-size features. These rows close the loop between
    -- plan-time phase sizing and the turns actually consumed by dev calls.
    -- They are intentionally generic across projects/stacks; provider-limit
    -- outcomes are retained for diagnostics but excluded by the predictor.
    -- Hoisted from migrate-validators.js (same precedent as the tg_* tables):
    -- state.js migrate() is the ONLY schema pass a fresh getDb()-bootstrapped
    -- DB ever runs — the deploy scripts never invoke migrate-all.js, so a
    -- rebuilt NAS DB was missing this one table (inserts swallowed, reads threw).
    CREATE TABLE IF NOT EXISTS validator_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      phase INTEGER,
      fix_round INTEGER,
      fix_n INTEGER,
      validator_name TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_ms INTEGER,
      exit_code INTEGER,
      status TEXT NOT NULL DEFAULT 'running',
      stdout_excerpt TEXT,
      stderr_excerpt TEXT,
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_validator_project ON validator_runs(project, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_validator_status ON validator_runs(status, started_at DESC);

    CREATE TABLE IF NOT EXISTS phase_execution_features (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      phase INTEGER,
      task_kind TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      execution_started_at TEXT,
      criteria_count INTEGER NOT NULL DEFAULT 0,
      files_count INTEGER NOT NULL DEFAULT 0,
      high_risk INTEGER NOT NULL DEFAULT 0,
      dependency_count INTEGER NOT NULL DEFAULT 0,
      text_chars INTEGER NOT NULL DEFAULT 0,
      actual_turns INTEGER,
      context_tokens INTEGER,
      max_turn_error INTEGER NOT NULL DEFAULT 0,
      provider_error INTEGER NOT NULL DEFAULT 0,
      success INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS auto_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      pause_reason TEXT,
      unattended INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (project) REFERENCES projects(name) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS bug_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      round INTEGER NOT NULL,
      bugs_file TEXT,
      fix_plan_file TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL DEFAULT 'in-progress',
      fixes_completed INTEGER NOT NULL DEFAULT 0,
      total_fixes INTEGER NOT NULL DEFAULT 0,
      UNIQUE (project, round),
      FOREIGN KEY (project) REFERENCES projects(name) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_calls_started ON calls(started_at);
    CREATE INDEX IF NOT EXISTS idx_calls_project ON calls(project);
    CREATE INDEX IF NOT EXISTS idx_context_manifests_project ON context_manifests(project, generated_at);
    CREATE INDEX IF NOT EXISTS idx_context_compile_events_project ON context_compile_events(project, id);
    CREATE INDEX IF NOT EXISTS idx_context_rollout_events_project ON context_compiler_rollout_events(project, created_at);
    CREATE INDEX IF NOT EXISTS idx_phase_execution_features_recent ON phase_execution_features(recorded_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_phase_execution_features_project ON phase_execution_features(project, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_phases_project ON phases(project);
    CREATE INDEX IF NOT EXISTS idx_auto_runs_project ON auto_runs(project, started_at);
    CREATE INDEX IF NOT EXISTS idx_bug_rounds_project ON bug_rounds(project, round);

    CREATE TABLE IF NOT EXISTS requirements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      refined_text TEXT,
      source TEXT,
      priority TEXT NOT NULL DEFAULT 'unassigned',
      scope TEXT NOT NULL DEFAULT 'unassigned',
      status TEXT NOT NULL DEFAULT 'inbox',
      tags TEXT,
      promoted_to TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_req_project ON requirements(project, status);
    CREATE INDEX IF NOT EXISTS idx_req_status ON requirements(status);

    CREATE TABLE IF NOT EXISTS bug_inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      refined_text TEXT,
      severity TEXT NOT NULL DEFAULT 'unassigned',
      status TEXT NOT NULL DEFAULT 'inbox',
      source TEXT,
      reported_by INTEGER,
      tags TEXT,
      promoted_to_round INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bug_inbox_project  ON bug_inbox(project);
    CREATE INDEX IF NOT EXISTS idx_bug_inbox_status   ON bug_inbox(status);
    CREATE INDEX IF NOT EXISTS idx_bug_inbox_severity ON bug_inbox(severity);

    CREATE TABLE IF NOT EXISTS tg_capture_modes (
      telegram_user_id INTEGER PRIMARY KEY,
      project TEXT NOT NULL,
      started_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS healing_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      project      TEXT,
      error_kind   TEXT NOT NULL,
      error_message TEXT,
      context_json  TEXT,
      strategy      TEXT,
      status        TEXT NOT NULL DEFAULT 'pending',
      resolved_at   TEXT,
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_healing_log_project ON healing_log(project, created_at);
    CREATE INDEX IF NOT EXISTS idx_healing_log_kind    ON healing_log(error_kind, created_at);

    CREATE TABLE IF NOT EXISTS suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      project_type TEXT NOT NULL,
      scan_snapshot_json TEXT NOT NULL,
      suggestions_json TEXT NOT NULL,
      selected_json TEXT,
      pipeline_plan_json TEXT,
      pipeline_passes INTEGER NOT NULL DEFAULT 1,
      next_pass INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'draft',
      FOREIGN KEY (project) REFERENCES projects(name) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_suggestions_project ON suggestions(project, status);

    CREATE TABLE IF NOT EXISTS running_jobs (
      project TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      started_at TEXT NOT NULL
    );

    -- Shared account/provider admission breaker. Every orchestrator process
    -- uses the same SQLite row, so the first observed provider quota failure
    -- prevents sibling projects from launching another known-doomed call.
    CREATE TABLE IF NOT EXISTS provider_circuit_breakers (
      provider       TEXT NOT NULL,
      account        TEXT NOT NULL,
      blocked_until  TEXT NOT NULL,
      reason         TEXT,
      source_project TEXT,
      source_task    TEXT,
      opened_at      TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      PRIMARY KEY (provider, account)
    );
    CREATE INDEX IF NOT EXISTS idx_provider_breakers_until
      ON provider_circuit_breakers(blocked_until);

    -- FIFO cross-process admission for costly provider calls. Waiting rows
    -- have state='waiting' + wait_until; active rows have state='active' +
    -- lease_until. Expired rows are reclaimed atomically by the next claimant,
    -- so a crashed orchestrator cannot strand the account semaphore.
    CREATE TABLE IF NOT EXISTS provider_call_leases (
      token          TEXT PRIMARY KEY,
      provider       TEXT NOT NULL,
      account        TEXT NOT NULL,
      owner          TEXT NOT NULL,
      state          TEXT NOT NULL CHECK (state IN ('waiting', 'active')),
      project        TEXT,
      task           TEXT,
      pid            INTEGER,
      requested_at   TEXT NOT NULL,
      acquired_at    TEXT,
      lease_until    TEXT,
      wait_until     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_provider_call_leases_scope
      ON provider_call_leases(provider, account, state, requested_at, token);
    CREATE INDEX IF NOT EXISTS idx_provider_call_leases_expiry
      ON provider_call_leases(state, lease_until, wait_until);

    -- Human-in-the-loop confirmation gate (Phase 13). One row per pending
    -- requireConfirmation() call. The nonce (crypto.randomBytes(4) → 8 hex)
    -- is embedded in Telegram callback data (cf:<id>:<nonce>:<optIdx>, well
    -- under the 64-byte limit) and used to resolve the correct row.
    -- ttl_ms NULL + expires_at NULL = wait indefinitely (self-heal). A numeric
    -- ttl with default_option auto-expires to that option (brief-append → discard).
    CREATE TABLE IF NOT EXISTS pending_confirmations (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      nonce          TEXT NOT NULL UNIQUE,
      action         TEXT NOT NULL,
      project        TEXT,
      summary        TEXT,
      options_json   TEXT NOT NULL,
      default_option TEXT,
      status         TEXT NOT NULL DEFAULT 'pending',
      chosen_option  TEXT,
      resolved_by    INTEGER,
      ttl_ms         INTEGER,
      created_at     TEXT NOT NULL,
      expires_at     TEXT,
      resolved_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pending_conf_status ON pending_confirmations(status);

    -- Phase 48: non-blocking operator question channel (ask_operator MCP
    -- tool). blocking is recorded but ALWAYS treated as non-blocking in v1 —
    -- see src/mcp/state-server.mjs's askOperator. notified_at is set by a
    -- future poller (phase 49); NULL means "not yet notified".
    CREATE TABLE IF NOT EXISTS operator_questions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      project       TEXT NOT NULL,
      phase         INTEGER,
      question      TEXT NOT NULL,
      options       TEXT,
      assumption    TEXT NOT NULL,
      blocking      INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'open',
      answer        TEXT,
      answered_by   INTEGER,
      notified_at   TEXT,
      created_at    TEXT NOT NULL,
      answered_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_operator_questions_project ON operator_questions(project);
    CREATE INDEX IF NOT EXISTS idx_operator_questions_status  ON operator_questions(status);
  `);

  // tg_* tables — hoisted from migrate-bot.js so a fresh state.db is fully
  // bootstrapped by the first state.js touch, without a separate migrate-bot run.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tg_users (
      telegram_user_id INTEGER PRIMARY KEY,
      telegram_handle TEXT,
      allowlisted_at TEXT NOT NULL,
      label TEXT
    );

    CREATE TABLE IF NOT EXISTS tg_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      action TEXT NOT NULL,
      args_json TEXT,
      requested_by INTEGER,
      requested_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      result_summary TEXT,
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tg_jobs_status  ON tg_jobs(status, id);
    CREATE INDEX IF NOT EXISTS idx_tg_jobs_project ON tg_jobs(project);

    CREATE TABLE IF NOT EXISTS tg_auth_codes (
      code TEXT PRIMARY KEY,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      label TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tg_auth_codes_expires ON tg_auth_codes(expires_at);

    CREATE TABLE IF NOT EXISTS tg_pinned_projects (
      telegram_user_id INTEGER PRIMARY KEY,
      project TEXT NOT NULL,
      pinned_at TEXT NOT NULL
    );
  `);

  // Idempotent column adds for schema evolution (SQLite ALTER TABLE ADD
  // COLUMN throws if the column already exists — wrap each in try/catch).
  const addCol = (sql) => {
    try { db.exec(sql); } catch (e) {
      if (!String(e.message).includes('duplicate column')) throw e;
    }
  };
  addCol(`ALTER TABLE projects ADD COLUMN git_branch TEXT`);
  addCol(`ALTER TABLE projects ADD COLUMN git_remote TEXT`);
  addCol(`ALTER TABLE auto_runs ADD COLUMN pause_kind TEXT`);
  // Phase 62 — the structured failure autopsy (src/lib/autopsy.js), stored as
  // the validated JSON string (LLM path) or the deterministic-fallback JSON.
  addCol(`ALTER TABLE auto_runs ADD COLUMN autopsy TEXT`);
  // v0.14.44: deferred transient retries — jobs invisible to the picker until due.
  addCol(`ALTER TABLE tg_jobs ADD COLUMN not_before TEXT`);
  addCol(`ALTER TABLE tg_jobs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`);
  // Durable worker leases. A claimed queue row records the owning server PID
  // and a renewable expiry so another server instance can distinguish a live
  // worker from a row stranded by SIGKILL/power loss. recovery_count is
  // observability for at-least-once startup recovery (not an execution retry
  // budget — transient provider retries continue to use retry_count).
  addCol(`ALTER TABLE tg_jobs ADD COLUMN worker_pid INTEGER`);
  // Per-claim fencing token. A stale worker may keep running briefly after its
  // lease is reclaimed; terminal writes must not finalize the new owner's job.
  addCol(`ALTER TABLE tg_jobs ADD COLUMN lease_token TEXT`);
  addCol(`ALTER TABLE tg_jobs ADD COLUMN lease_expires_at TEXT`);
  addCol(`ALTER TABLE tg_jobs ADD COLUMN cancel_requested_at TEXT`);
  addCol(`ALTER TABLE tg_jobs ADD COLUMN recovery_count INTEGER NOT NULL DEFAULT 0`);
  // Phase 79 (P2): window-aware job scheduling — how many times the picker has
  // deferred this HEAVY job because the billing window was merely 'warn'. The
  // starvation guard admits a heavy job regardless of warn once deferred_count>=1
  // (a heavy job defers at most once). Old rows without the column read as 0.
  // Fresh DBs get it here; src/migrate-window-scheduling.js backfills existing DBs.
  addCol(`ALTER TABLE tg_jobs ADD COLUMN deferred_count INTEGER NOT NULL DEFAULT 0`);
  // Web/operator queue ordering. Existing rows retain their insertion order;
  // explicit reorder operations assign dense positions without rewriting job
  // ids (ids are durable audit references used by notifications and logs).
  addCol(`ALTER TABLE tg_jobs ADD COLUMN queue_position INTEGER`);
  db.prepare(`UPDATE tg_jobs SET queue_position = id WHERE queue_position IS NULL`).run();
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tg_jobs_queue ON tg_jobs(status, queue_position, id)`);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS tg_jobs_default_queue_position
    AFTER INSERT ON tg_jobs
    WHEN NEW.queue_position IS NULL
    BEGIN
      UPDATE tg_jobs SET queue_position = NEW.id WHERE id = NEW.id;
    END;
  `);
  // Explicit provenance for safe same-session continuation. A bare
  // status='in-progress' is ambiguous (validator/capability failures also
  // leave that status), so phase-runner resumes only rows marked as a real
  // external/provider/process interruption on the same model.
  addCol(`ALTER TABLE phases ADD COLUMN interruption_kind TEXT`);
  addCol(`ALTER TABLE phases ADD COLUMN interruption_reason TEXT`);
  addCol(`ALTER TABLE phases ADD COLUMN interrupted_at TEXT`);
  addCol(`ALTER TABLE tg_capture_modes ADD COLUMN kind TEXT NOT NULL DEFAULT 'req'`);
  addCol(`ALTER TABLE suggestions ADD COLUMN next_pass INTEGER NOT NULL DEFAULT 1`);
  addCol(`ALTER TABLE projects ADD COLUMN audit_runs_completed INTEGER NOT NULL DEFAULT 0`);
  // Phase 13: discussion #N whose conclusions were appended to the brief via the
  // "Accept Brief Only" gate and are awaiting operator review. The next go reads
  // and clears it. NULL = nothing pending.
  addCol(`ALTER TABLE projects ADD COLUMN discuss_brief_pending INTEGER`);
  // v0.17: per-call turn count from the stream-json result event — the
  // calibration data for phases.turn_budget_by_complexity (complexity-tiered
  // turn budgets). NULL on legacy rows and on errored calls with no result.
  addCol(`ALTER TABLE calls ADD COLUMN num_turns INTEGER`);
  // v0.17 (OBS-2): persist the ROUTING DECISION and attempt/escalation state
  // alongside num_turns, so "why did this model run" and "did it take a
  // retry to get here" are queryable instead of living only in the terminal
  // log (show_reasoning_in_log) or the ephemeral escalate-opus.marker files.
  // max_turns is the resolveMaxTurns() budget the call actually ran under —
  // paired with num_turns this reveals turn-cap proximity per tier/task.
  addCol(`ALTER TABLE calls ADD COLUMN max_turns INTEGER`);
  // routeModel()'s chosen tier ('haiku'|'sonnet'|'opus'|'fable') for this call.
  addCol(`ALTER TABLE calls ADD COLUMN routing_tier TEXT`);
  // routeModel()'s reasoning[] array, newline-joined — the human-readable
  // "why this tier" trail that show_reasoning_in_log already prints and
  // discards. Kept as plain text (not JSON) since it's read-only/display.
  addCol(`ALTER TABLE calls ADD COLUMN routing_reason TEXT`);
  // 1-based attempt number for this phase/fix within the current auto-run
  // (1 = first try, 2 = the one escalated retry escalateRetryDone allows).
  // NULL on legacy rows and on calls with no attempt concept (e.g. guide
  // tasks outside the dev/fix escalation ladder).
  addCol(`ALTER TABLE calls ADD COLUMN attempt INTEGER`);
  // One runClaude() invocation is a logical call, but its internal retry loop
  // can launch more than one billable Claude subprocess. Keep that identity
  // separate from `attempt` above (which is the caller's routing/escalation
  // attempt): every actual spawn gets one calls row, sharing logical_call_id
  // and carrying a monotonically increasing subprocess_attempt. Legacy and
  // directly-recorded rows remain NULL, preserving the existing API.
  addCol(`ALTER TABLE calls ADD COLUMN logical_call_id TEXT`);
  addCol(`ALTER TABLE calls ADD COLUMN subprocess_attempt INTEGER`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_calls_logical_call_id ON calls(logical_call_id)`);
  // 1 iff this call is running because a prior attempt failed and an
  // escalate-opus.marker (or acceptance-gate refine bump) routed it to a
  // higher tier / boosted effort. Defaults 0 so legacy rows read as
  // "not escalated" rather than NULL/unknown.
  addCol(`ALTER TABLE calls ADD COLUMN escalated INTEGER NOT NULL DEFAULT 0`);
  // Phase 31: last assistant turn's per-request context size (input +
  // cache_read + cache_creation tokens), NOT the cumulative result.usage sum
  // — see claude-runner.js's lastTurnContextTokens. Calibration data for
  // phases.handoff_when_context_tokens_exceed and what the guide-session
  // compaction trigger thresholds on. NULL on legacy rows and on calls where
  // no assistant usage event was ever seen.
  addCol(`ALTER TABLE calls ADD COLUMN context_tokens INTEGER`);
  // Schema 19: Hybrid Context Compiler call attribution. The manifest table
  // stores one row per deterministic compilation; these nullable call columns
  // tie actual Claude consumption to the exact shadow/assist/enforce manifest
  // that preceded it. Resumed rows may represent retained replay exposure,
  // not a second literal injection. Legacy calls remain NULL.
  addCol(`ALTER TABLE calls ADD COLUMN context_manifest_id TEXT`);
  addCol(`ALTER TABLE calls ADD COLUMN context_provider TEXT`);
  addCol(`ALTER TABLE calls ADD COLUMN context_mode TEXT`);
  addCol(`ALTER TABLE calls ADD COLUMN context_injected_tokens INTEGER`);
  addCol(`ALTER TABLE context_manifests ADD COLUMN predicted_files TEXT`);
  addCol(`ALTER TABLE context_manifests ADD COLUMN actual_files TEXT`);
  addCol(`ALTER TABLE context_manifests ADD COLUMN precision REAL`);
  addCol(`ALTER TABLE context_manifests ADD COLUMN recall REAL`);
  addCol(`ALTER TABLE context_manifests ADD COLUMN package_scopes TEXT`);
  addCol(`ALTER TABLE context_compile_events ADD COLUMN compiler_fingerprint TEXT`);
  // Phase 34: audit yield telemetry. What did each audit actually BUY —
  // how many findings it promoted into this bugs round, whether it came
  // back clean, which model ran it, its scope ('full'|'incremental'|
  // 'full-clean-skip' — phase 32/33's result field), and a sha256
  // fingerprint of the promoted bug titles (the recurring-findings stop
  // compares consecutive rounds' fingerprints to detect fixes that are
  // not landing). All NULL on legacy rows — recordAuditYield() fills them
  // best-effort from the audit auto-chain only.
  addCol(`ALTER TABLE bug_rounds ADD COLUMN audit_findings_promoted INTEGER`);
  addCol(`ALTER TABLE bug_rounds ADD COLUMN audit_clean INTEGER`);
  addCol(`ALTER TABLE bug_rounds ADD COLUMN audit_model TEXT`);
  addCol(`ALTER TABLE bug_rounds ADD COLUMN audit_scope TEXT`);
  addCol(`ALTER TABLE bug_rounds ADD COLUMN audit_fingerprint TEXT`);

  // Phase 60 (P4 quality dashboard): raw bugs-found count for this round —
  // distinct from audit_findings_promoted (which only the audit auto-chain
  // fills). found_count is set by startBugRound (whenever the caller can
  // derive it, e.g. re-parsing bugs.md at the auto-detected bridging path)
  // AND best-effort updated right after promoteAuditToBugs (setBugRoundFoundCount,
  // a no-op when the row doesn't exist yet) — same "both call sites, row may
  // not exist yet at promote time" shape as audit_findings_promoted/
  // recordAuditYield above. NULL on legacy/manually-dropped rounds (bug-cycle.js's
  // CLI path never derives it) — getQualityReport renders those as 'n/a'.
  addCol(`ALTER TABLE bug_rounds ADD COLUMN found_count INTEGER`);

  // ─── Multi-agent discussions ─────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS discussions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      project       TEXT NOT NULL,
      topic         TEXT NOT NULL,
      mode          TEXT NOT NULL DEFAULT 'auto',
      status        TEXT NOT NULL DEFAULT 'pending',
      rounds_planned INTEGER NOT NULL DEFAULT 2,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at  TEXT,
      FOREIGN KEY (project) REFERENCES projects(name) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_discussions_project ON discussions(project, created_at);

    CREATE TABLE IF NOT EXISTS disc_agents (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      disc_id      INTEGER NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
      agent_key    TEXT NOT NULL,
      role         TEXT NOT NULL,
      expertise    TEXT NOT NULL,
      mission      TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      session_id   TEXT
    );

    CREATE TABLE IF NOT EXISTS disc_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      disc_id    INTEGER NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
      agent_key  TEXT NOT NULL,
      round      INTEGER NOT NULL,
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_disc_messages_disc ON disc_messages(disc_id, round);

    CREATE TABLE IF NOT EXISTS disc_conclusions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      disc_id     INTEGER NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
      synthesis   TEXT NOT NULL,
      brief_patch TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ─── Chat control plane (v0.16) ───────────────────────────────────────────
  // chat_threads.project is deliberately NOT a foreign key: a thread can focus
  // a project that later gets removed, and the conversation history should
  // survive that. session_id is the claude CLI session resumed per message.
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_threads (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      title          TEXT,
      project        TEXT,
      session_id     TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      last_active_at TEXT
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id  INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      role       TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      content    TEXT NOT NULL,
      meta_json  TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, id);

    -- v0.18 chat autopilot: a CROSS-PROCESS turn lock. The old per-process
    -- _busyThreads Set could not stop the auto-healer's issue-bridge (a
    -- different process) from --resume-ing the same session the web-UI engine
    -- was mid-turn on, corrupting it. One row per in-flight thread; the pid lets
    -- a crashed holder's lock be reclaimed (pidAlive check, same discipline as
    -- running_jobs).
    CREATE TABLE IF NOT EXISTS chat_locks (
      thread_id INTEGER PRIMARY KEY,
      pid       INTEGER NOT NULL,
      locked_at TEXT NOT NULL
    );

    -- v0.18 chat autopilot: a ledger of every detached orchestrator command the
    -- chat control plane spawns (stdio is 'ignore', so without this a child that
    -- dies at startup leaves zero trace). The autopilot loop and the chat agent
    -- read this to answer "is my last launch still alive?" — the completion
    -- signal a fire-and-forget spawn otherwise never provides.
    CREATE TABLE IF NOT EXISTS detached_spawns (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      project    TEXT,
      thread_id  INTEGER,
      action     TEXT NOT NULL,
      pid        INTEGER,
      started_at TEXT NOT NULL,
      source     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_detached_spawns_project ON detached_spawns(project, id);
  `);

  // v0.18 chat autopilot — per-thread drive-to-done state (see chat-autopilot.js).
  // These ALTERs must run AFTER the chat_threads CREATE above, so they live here
  // rather than in the addCol block near the top (which executes earlier).
  //   autopilot        0|1  — is this thread being driven unattended
  //   autopilot_goal   TEXT — the operator's goal (what "done" means for the loop)
  //   autopilot_status TEXT — active | waiting | escalated | done | off
  //   autopilot_attempts INT — consecutive loop re-triggers since the last human
  //     message or real progress; the cap that stops a spin
  //   autopilot_spend_usd REAL — chat-turn cost attributed to the loop (soft cap)
  //   autopilot_next_at TEXT — backoff: the loop won't re-trigger before this
  //   autopilot_sig    TEXT — last observed focus-project state signature; a
  //     change since the last loop turn is the "something happened, act" signal
  addCol(`ALTER TABLE chat_threads ADD COLUMN autopilot INTEGER NOT NULL DEFAULT 0`);
  addCol(`ALTER TABLE chat_threads ADD COLUMN autopilot_goal TEXT`);
  addCol(`ALTER TABLE chat_threads ADD COLUMN autopilot_status TEXT`);
  addCol(`ALTER TABLE chat_threads ADD COLUMN autopilot_attempts INTEGER NOT NULL DEFAULT 0`);
  addCol(`ALTER TABLE chat_threads ADD COLUMN autopilot_spend_usd REAL NOT NULL DEFAULT 0`);
  addCol(`ALTER TABLE chat_threads ADD COLUMN autopilot_next_at TEXT`);
  addCol(`ALTER TABLE chat_threads ADD COLUMN autopilot_sig TEXT`);
  // autopilot_error_streak — consecutive ERRORED loop ticks. Separate from
  // autopilot_attempts (which progress legitimately resets): the loop's own
  // failed actions churn the state signature, so a spin of pure errors could
  // reset the attempt cap forever. The streak only clears on a SUCCESSFUL turn.
  addCol(`ALTER TABLE chat_threads ADD COLUMN autopilot_error_streak INTEGER NOT NULL DEFAULT 0`);

  // ─── Run events (Phase 57 — append-only per-run timeline) ─────────────────
  // One row per notable auto_runs transition — "what happened during run N?"
  // in one query instead of stitching together auto_runs.status, .guide
  // verdict files, escalation markers, and healing_log. Single writer per run
  // (autoRun() is one process per project), so ordering by `id` is
  // authoritative — no sequence column needed. No FK to auto_runs on purpose:
  // recordRunEvent must be able to insert even if the auto_runs row write
  // ordering ever changes, and legacy/cross-run queries never need a join.
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id  INTEGER NOT NULL,
      project TEXT NOT NULL,
      ts      TEXT NOT NULL,
      kind    TEXT NOT NULL,
      phase   INTEGER,
      detail  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_run_events_run         ON run_events(run_id);
    CREATE INDEX IF NOT EXISTS idx_run_events_project_ts  ON run_events(project, ts);
  `);

  // ─── Notify outbox (Phase 58 — pings independent of launch surface) ───────
  // A bare detached CLI (spawnOrchestrator in web-ui.js, spawnDetached in
  // chat/control-actions.js) runs autoRun() with notifier:null, so every
  // notifier.notify call site in auto-runner.js was previously a silent
  // no-op for those launches. queueNotify() durably logs the message
  // regardless of whether a live notifier is in scope; server-discord.js's
  // 10s delivery loop is the fallback deliverer for whatever the live
  // notifier (when present) didn't already mark delivered as a fast path.
  // No FK to projects — a queued notice must survive even if the project
  // row is deleted mid-flight.
  db.exec(`
    CREATE TABLE IF NOT EXISTS notify_outbox (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      project      TEXT,
      text         TEXT NOT NULL,
      reply_markup TEXT,
      created_at   TEXT NOT NULL,
      delivered_at TEXT,
      attempts     INTEGER NOT NULL DEFAULT 0,
      status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed'))
    );
    CREATE INDEX IF NOT EXISTS idx_notify_outbox_status ON notify_outbox(status, id);
  `);

  // ─── Live progress (Phase 59 — one row per project, live run telemetry) ───
  // Surfaces what a run is doing RIGHT NOW (turn count vs cap, current tool +
  // elapsed, files touched, ETA) so the UI/chat don't reconstruct it from a
  // 256KB log tail. One row per project (PRIMARY KEY), UPSERTed on a >=3s
  // throttle by claude-runner's stream parser and DELETEd in runClaude's
  // cleanup paths, so a completed / failed / retried run never leaves a ghost
  // row. WAL mode (set in getDb) makes the web-ui SSE loop's cross-process read
  // safe against the writer. files_touched is a JSON array capped at 50 entries.
  // The *_at columns are epoch-ms INTEGERs, not ISO strings: they exist purely
  // for elapsed/ETA arithmetic and updated_at-change detection (mirroring
  // claude-runner's Date.now() liveness clocks), never as user-facing dates.
  // Every column except project is nullable so a partially-observed run still
  // renders.
  db.exec(`
    CREATE TABLE IF NOT EXISTS live_progress (
      project                 TEXT PRIMARY KEY,
      pid                     INTEGER,
      task                    TEXT,
      phase                   INTEGER,
      model                   TEXT,
      turns                   INTEGER,
      max_turns               INTEGER,
      current_tool            TEXT,
      current_tool_started_at INTEGER,
      files_touched           TEXT,
      last_text               TEXT,
      started_at              INTEGER,
      eta_ms                  INTEGER,
      updated_at              INTEGER
    );
  `);

  // ─── Verify results (Phase 60 — P4 quality dashboard) ──────────────────────
  // One row per acceptance-check verdict, written at verify-loop.js's
  // persistVerdict site (the same place the .guide verify.json is written) —
  // makes quality signal queryable the way calls already makes cost queryable.
  // `run_id` is out of scope at that call site (P1's run_events carries the
  // run linkage instead) and is always NULL — never joined to auto_runs.
  // criteria_met/criteria_unmet/unverifiable are counted straight from the
  // already-parsed verdict's `criteria` array; a phase can have MULTIPLE rows
  // (gate-mode refine re-checks, report-mode async retries) — getQualityReport
  // reads the FIRST row per phase (MIN(id)) as the first-pass verdict.
  db.exec(`
    CREATE TABLE IF NOT EXISTS verify_results (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      project         TEXT NOT NULL,
      phase           INTEGER NOT NULL,
      run_id          INTEGER,
      verdict         TEXT NOT NULL,
      criteria_met    INTEGER,
      criteria_unmet  INTEGER,
      unverifiable    INTEGER,
      created_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_verify_results_project_phase ON verify_results(project, phase);
  `);

  // ─── Phase lanes (Phase 65 — Execution DAG P1, inert scaffolding) ──────────
  // One row per attempted parallel-lane git worktree (a phase, a fix, or one
  // leg of a speculative duo). No scheduler creates a worktree or writes to
  // this table yet — auto_run.max_parallel_phases/bug_cycle.max_parallel_fixes
  // both default to 1 (today's serial path), so this table stays empty on any
  // shipped-default project. `n`/`round` are nullable since a duo leg may not
  // map to either. `status` starts 'running'; a lane left 'running' after a
  // crashed process is an orphan for a future run-start sweep to clean up.
  db.exec(`
    CREATE TABLE IF NOT EXISTS phase_lanes (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      project        TEXT NOT NULL,
      kind           TEXT NOT NULL,
      n              INTEGER,
      round          INTEGER,
      branch         TEXT,
      worktree_path  TEXT,
      base_sha       TEXT,
      head_sha       TEXT,
      status         TEXT NOT NULL DEFAULT 'running',
      started_at     TEXT,
      ended_at       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_phase_lanes_project ON phase_lanes(project);
    CREATE INDEX IF NOT EXISTS idx_phase_lanes_status ON phase_lanes(project, status);
  `);

  // ─── Autopilot approvals (Phase 85 — Portfolio autopilot P7a) ──────────────
  // Standing, ALWAYS-EXPIRING approvals for autopilot actions that
  // require_operator_approval_for (default ['brief']). A row is written by
  // `ashmero autopilot approve <project> <action>` and consumed by
  // portfolio-autopilot.js execute() — the ONLY gate that lets an autonomous
  // overnight 'brief' job enqueue. Every row carries an expiry: EITHER a
  // remaining_nights count (decremented on each night's use; default 1 =
  // single-use) OR an expires_at ISO timestamp (invalid once passed). An
  // approval with BOTH bounds null is treated as INVALID — an approval is never
  // a permanent silent bypass of the guard. consumed_nights is a running count;
  // last_consumed_night ('YYYY-MM-DD') makes a single night's consumption
  // idempotent (a second execute() in the same calendar night neither
  // re-enqueues nor re-decrements). No FK to projects because the table was
  // introduced independently; deleteProject removes approvals explicitly so a
  // recreated slug never inherits authorization from an earlier generation.
  db.exec(`
    CREATE TABLE IF NOT EXISTS autopilot_approvals (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      project             TEXT NOT NULL,
      action              TEXT NOT NULL,
      scope               TEXT NOT NULL DEFAULT 'all',
      remaining_nights    INTEGER,           -- night-count expiry (NULL when expires_at is used)
      expires_at          TEXT,              -- ISO timestamp expiry (NULL when remaining_nights is used)
      consumed_nights     INTEGER NOT NULL DEFAULT 0,
      last_consumed_night TEXT,              -- 'YYYY-MM-DD' of last consumption (per-night idempotency)
      created_at          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_autopilot_approvals_lookup ON autopilot_approvals(project, action);
  `);

  // ─── Autopilot scheduler cursor (Phase 86 — Portfolio autopilot P7b) ────────
  // A SINGLETON (id=1) row holding the nightly scheduler's restart-safe cursors.
  // last_planned_date / last_digest_date ('YYYY-MM-DD', LOCAL calendar day) make
  // the plan+execute pass and the morning digest fire AT MOST once per calendar
  // night — a mid-night process restart re-reads these and does NOT double-plan.
  // last_planned_at (ISO) is the "since night start" cutoff the digest gathers
  // auto_runs/healing_log/tg_jobs rows from; last_plan_json snapshots that night's
  // execute() result so the morning digest can list the actions that reverted to
  // approval recommendations. Absence never breaks a run (backward-compat NFR) —
  // getAutopilotState() returns an all-null default when the row is missing.
  db.exec(`
    CREATE TABLE IF NOT EXISTS autopilot (
      id                INTEGER PRIMARY KEY CHECK (id = 1),
      last_planned_date TEXT,
      last_planned_at   TEXT,
      last_plan_json    TEXT,
      last_digest_date  TEXT,
      last_digest_at    TEXT
    );
    INSERT OR IGNORE INTO autopilot (id) VALUES (1);
  `);

  // Latest provider-side window telemetry, one row per (provider, account,
  // rate_limit_type). The CLI streams a rate_limit_event with utilization +
  // resetsAt on essentially every call; persisting the freshest observation
  // lets billing-guard's windowStatus track the provider's ACTUAL meter
  // (account-wide, all hosts) instead of the local heavy-call-unit proxy.
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_window_observations (
      provider        TEXT NOT NULL,
      account         TEXT NOT NULL,
      rate_limit_type TEXT NOT NULL,
      status          TEXT,
      utilization     REAL,
      resets_at_ms    INTEGER,
      observed_at_ms  INTEGER NOT NULL,
      PRIMARY KEY (provider, account, rate_limit_type)
    );
  `);

  // Idle worker liveness cannot be inferred from tg_jobs: a healthy worker has
  // no lease row while the queue is empty. Each headless worker process updates
  // this small heartbeat row, allowing the UI to distinguish "idle" from
  // "nothing is consuming jobs" without shelling out to PM2.
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_heartbeats (
      pid          INTEGER PRIMARY KEY,
      started_at   TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      capacity     INTEGER NOT NULL DEFAULT 1,
      active_jobs  TEXT NOT NULL DEFAULT '[]',
      host_id      TEXT,
      role         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_worker_heartbeats_seen
      ON worker_heartbeats(last_seen_at);
  `);

  // Schema fingerprint. Bump STATE_SCHEMA_VERSION whenever migrate() gains a
  // table/column, so doctor.js can detect a DB whose schema pass predates the
  // running code (Mac/NAS drift was previously invisible except by hand-diffing
  // .schema output). Read back via getStateSchemaVersion().
  db.pragma(`user_version = ${STATE_SCHEMA_VERSION}`);
}

// Bump on every migrate() shape change (v1 = 2026-07-20 baseline: 44 tables
// incl. the hoisted validator_runs + chat_threads.autopilot_error_streak;
// v2 = provider_window_observations).
export const STATE_SCHEMA_VERSION = 2;

/** The user_version stamped by the last migrate() pass that ran on this DB. */
export function getStateSchemaVersion() {
  return Number(getDb().pragma('user_version', { simple: true })) || 0;
}

// ─── Projects ───────────────────────────────────────────────────────────────

export function upsertProject({ name, tech_stack, profile, total_phases = 0, status = 'planning', metadata = {} }) {
  const db = getDb();
  db.transaction(() => {
    const existing = db.prepare('SELECT name FROM projects WHERE name = ?').get(name);
    const tombstone = db.prepare(`SELECT deleted_at FROM project_tombstones WHERE project = ?`).get(name);
    // A reservation while the old project row still exists is an in-progress
    // deletion, not a recreation. Refuse updates so they cannot clear the
    // fence between filesystem staging and the final delete transaction.
    if (existing && tombstone) {
      const err = new Error(`Project '${name}' is being deleted; refusing to update it`);
      err.code = 'PROJECT_DELETING';
      throw err;
    }
    if (existing) {
      db.prepare(`
        UPDATE projects SET tech_stack = ?, profile = ?, total_phases = ?, status = ?, metadata_json = ?
        WHERE name = ?
      `).run(tech_stack || null, profile || null, total_phases, status, JSON.stringify(metadata), name);
    } else {
      // Clearing the old-generation tombstone and inserting the replacement
      // project are one transaction, so queue producers cannot observe a
      // half-recreated slug.
      db.prepare(`DELETE FROM project_tombstones WHERE project = ?`).run(name);
      db.prepare(`
        INSERT INTO projects (name, created_at, tech_stack, profile, total_phases, status, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(name, new Date().toISOString(), tech_stack || null, profile || null, total_phases, status, JSON.stringify(metadata));
    }
  }).immediate();
}

export function getProject(name) {
  return getDb().prepare('SELECT * FROM projects WHERE name = ?').get(name);
}

/** Reserve a project slug against every queue/runner claim before disk staging. */
export function reserveProjectDeletion(name) {
  const db = getDb();
  return db.transaction(() => {
    if (!db.prepare(`SELECT 1 FROM projects WHERE name = ?`).get(name)) {
      const err = new Error(`Project not found: ${name}`);
      err.code = 'PROJECT_NOT_FOUND';
      throw err;
    }
    if (db.prepare(`SELECT 1 FROM project_tombstones WHERE project = ?`).get(name)) {
      const err = new Error(`Project '${name}' is already being deleted`);
      err.code = 'PROJECT_DELETING';
      throw err;
    }
    db.prepare(`INSERT INTO project_tombstones (project, deleted_at) VALUES (?, ?)`)
      .run(name, new Date().toISOString());

    const autoRun = db.prepare(`SELECT id FROM auto_runs WHERE project = ? AND status = 'running' LIMIT 1`).get(name);
    const queueJobs = db.prepare(`
      SELECT id, action, status FROM tg_jobs
      WHERE project = ? AND status IN ('pending','running') ORDER BY id
    `).all(name);
    const owner = db.prepare(`SELECT pid FROM running_jobs WHERE project = ?`).get(name);
    const detached = db.prepare(`SELECT id, action, pid FROM detached_spawns WHERE project = ? AND pid IS NOT NULL`).all(name)
      .filter((row) => pidAlive(row.pid));
    const liveOwner = owner?.pid && pidAlive(owner.pid) ? owner.pid : null;
    if (autoRun || queueJobs.length || liveOwner || detached.length) {
      const err = new Error(`Project '${name}' has active or queued work; stop/cancel it before removal`);
      err.code = 'PROJECT_BUSY';
      err.details = { autoRunId: autoRun?.id ?? null, queueJobs, runningPid: liveOwner, detached };
      throw err;
    }
    return { project: name, reserved: true };
  }).immediate();
}

/** Roll back a deletion reservation when filesystem staging/database delete fails. */
export function releaseProjectDeletion(name) {
  return getDb().prepare(`DELETE FROM project_tombstones WHERE project = ?`).run(name).changes === 1;
}

export function deleteProject(name) {
  const db = getDb();
  db.transaction(() => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO project_tombstones (project, deleted_at) VALUES (?, ?)
      ON CONFLICT(project) DO UPDATE SET deleted_at = excluded.deleted_at
    `).run(name, now);

    // removeProject performs an early user-facing busy check. Repeat the live
    // portion under the same write lock as deletion so a worker that won a
    // claim race cannot have its row erased while still writing project files.
    const liveQueue = db.prepare(`
      SELECT id, action FROM tg_jobs WHERE project = ? AND status = 'running' ORDER BY id
    `).all(name);
    const owner = db.prepare(`SELECT pid FROM running_jobs WHERE project = ?`).get(name);
    const liveDetached = db.prepare(`
      SELECT id, pid FROM detached_spawns WHERE project = ? AND pid IS NOT NULL
    `).all(name).filter((row) => pidAlive(row.pid));
    if (liveQueue.length || (owner?.pid && pidAlive(owner.pid)) || liveDetached.length) {
      const err = new Error(`Project '${name}' became busy while deletion was starting`);
      err.code = 'PROJECT_BUSY';
      err.details = {
        queueJobs: liveQueue,
        runningPid: owner?.pid && pidAlive(owner.pid) ? owner.pid : null,
        detached: liveDetached,
      };
      throw err;
    }

    db.prepare(`DELETE FROM requirements WHERE project = ?`).run(name);
    db.prepare(`DELETE FROM bug_inbox WHERE project = ?`).run(name);
    db.prepare(`DELETE FROM healing_log WHERE project = ?`).run(name);
    db.prepare(`DELETE FROM tg_capture_modes WHERE project = ?`).run(name);
    db.prepare(`DELETE FROM tg_pinned_projects WHERE project = ?`).run(name);
    db.prepare(`DELETE FROM context_compile_events WHERE project = ?`).run(name);
    db.prepare(`DELETE FROM context_manifests WHERE project = ?`).run(name);
    db.prepare(`DELETE FROM context_compiler_rollouts WHERE project = ?`).run(name);
    db.prepare(`DELETE FROM context_compiler_rollout_events WHERE project = ?`).run(name);
    db.prepare(`DELETE FROM phase_execution_features WHERE project = ?`).run(name);
    // These tables intentionally have no project FK. Clean every generation,
    // including terminal jobs and old approvals, so recreating the same slug
    // cannot retry old work or inherit prior autonomous authorization.
    db.prepare(`DELETE FROM tg_jobs WHERE project = ?`).run(name);
    db.prepare(`DELETE FROM operator_questions WHERE project = ?`).run(name);
    db.prepare(`DELETE FROM autopilot_approvals WHERE project = ?`).run(name);
    db.prepare(`DELETE FROM running_jobs WHERE project = ?`).run(name);
    db.prepare(`DELETE FROM detached_spawns WHERE project = ?`).run(name);
    // cascades: phases, sessions, auto_runs, bug_rounds
    db.prepare(`DELETE FROM projects WHERE name = ?`).run(name);
  }).immediate();
  // Compiler artifacts live outside projects/<name>, so the projects-table
  // cascade cannot remove them. Best-effort cleanup prevents a deleted and
  // later recreated project name from inheriting stale task context.
  const contextRoot = path.resolve(process.env.AORCH_CONTEXT_STATE_DIR || path.join(REPO_ROOT, 'state', 'context'));
  const contextDir = path.resolve(contextRoot, String(name || ''));
  if (contextDir.startsWith(`${contextRoot}${path.sep}`)) {
    try { fs.rmSync(contextDir, { recursive: true, force: true }); } catch { /* deletion already succeeded */ }
  }
}

export function listProjects() {
  return getDb().prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
}

export function setCurrentPhase(name, n) {
  getDb().prepare('UPDATE projects SET current_phase = ? WHERE name = ?').run(n, name);
}

export function setTotalPhases(name, n) {
  getDb().prepare('UPDATE projects SET total_phases = ? WHERE name = ?').run(n, name);
}

export function getAuditRunsCompleted(name) {
  const row = getDb().prepare('SELECT audit_runs_completed FROM projects WHERE name = ?').get(name);
  return row?.audit_runs_completed ?? 0;
}

export function incrementAuditRunsCompleted(name) {
  getDb().prepare('UPDATE projects SET audit_runs_completed = audit_runs_completed + 1 WHERE name = ?').run(name);
}

export function resetAuditRunsCompleted(name) {
  getDb().prepare('UPDATE projects SET audit_runs_completed = 0 WHERE name = ?').run(name);
}

// Called when a new plan.json replaces a previous one. Atomically:
//   - Resets current_phase, total_phases, status
//   - Clears guide_session_id so the next guide call starts a fresh context
//     instead of resuming stale conversation from the old plan
//   - Aborts stale paused auto_runs (and running ones with no live owner) so the
//     Resume button doesn't surface an old run
//   - Deletes old phase rows so the auto-runner tracks the new plan cleanly
//
// A genuinely-live run for this project (its running_jobs claim pid is alive)
// keeps its 'running' auto_runs row. Without this guard, a plan regenerated
// mid-run (auto-runner.js executeAction, which calls this after a fresh
// guide:plan) or a concurrent `guide --task plan` would flip the live run to
// 'aborted' while it keeps executing — hiding it from getActiveAutoRun() and the
// web UI, and corrupting the run ledger. Mirrors sweepInterruptedAutoRuns()'s
// pidAlive() discipline. (startAutoRun's own blind abort stays unguarded on
// purpose: it runs while WE hold the claim, so any prior 'running' row is stale.)
export function resetProjectForNewPlan(name, totalPhases = 0) {
  const db = getDb();
  const now = new Date().toISOString();
  db.transaction(() => {
    const claim = getRunningJob(name);
    const liveRunActive = !!(claim && pidAlive(claim.pid));
    db.prepare(
      'UPDATE projects SET current_phase = 0, total_phases = ?, status = \'in-progress\', guide_session_id = NULL, audit_runs_completed = 0 WHERE name = ?',
    ).run(totalPhases, name);
    db.prepare('DELETE FROM phases WHERE project = ?').run(name);
    // Paused rows are always cleared — their plan is being replaced, so their
    // Resume button must go away.
    db.prepare(
      "UPDATE auto_runs SET status = 'aborted', ended_at = ? WHERE project = ? AND status = 'paused'",
    ).run(now, name);
    // Running rows are cleared ONLY when no live process owns the project.
    if (!liveRunActive) {
      db.prepare(
        "UPDATE auto_runs SET status = 'aborted', ended_at = ? WHERE project = ? AND status = 'running'",
      ).run(now, name);
    }
  })();
}

const VALID_STATUSES = new Set(['planning', 'in-progress', 'paused', 'completed', 'ready-for-qa', 'cancelled']);

export function setProjectStatus(name, status) {
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`[state] setProjectStatus: unknown status '${status}' for project '${name}' — valid: ${[...VALID_STATUSES].join(', ')}`);
  }
  getDb().prepare('UPDATE projects SET status = ? WHERE name = ?').run(status, name);
}

export function setGuideSessionId(name, sessionId) {
  getDb().prepare('UPDATE projects SET guide_session_id = ? WHERE name = ?').run(sessionId, name);
}

export function setLastDevSessionId(name, sessionId) {
  getDb().prepare('UPDATE projects SET last_dev_session_id = ? WHERE name = ?').run(sessionId, name);
}

// ─── Project metadata (single-key patch) ───────────────────────────────────
// Phase 20 (brief P3): upsertProject() above does a FULL REPLACE of
// metadata_json (JSON.stringify(metadata), not a merge) and requires
// tech_stack/profile/total_phases/status too — routing a single new key
// (e.g. last_guide_head_sha) through it would silently wipe every other
// metadata key already stored. This is the only sanctioned way to add/update
// ONE metadata_json key without touching the rest: a real
// SELECT → JSON.parse → set one key → JSON.stringify → single UPDATE.

export function parseProjectMetadata(metadataJson) {
  if (!metadataJson) return {};
  try { return JSON.parse(metadataJson) || {}; } catch { return {}; }
}

export function setProjectMetadataField(name, key, value) {
  const db = getDb();
  const row = db.prepare('SELECT metadata_json FROM projects WHERE name = ?').get(name);
  const metadata = parseProjectMetadata(row?.metadata_json);
  metadata[key] = value;
  db.prepare('UPDATE projects SET metadata_json = ? WHERE name = ?').run(JSON.stringify(metadata), name);
  return metadata;
}

export function setProjectGitConfig(name, { git_branch, git_remote }) {
  const db = getDb();
  if (git_branch !== undefined) {
    db.prepare('UPDATE projects SET git_branch = ? WHERE name = ?').run(git_branch, name);
  }
  if (git_remote !== undefined) {
    db.prepare('UPDATE projects SET git_remote = ? WHERE name = ?').run(git_remote, name);
  }
}

// ─── Phases ─────────────────────────────────────────────────────────────────

export function upsertPhase({ project, n, title, status = 'pending' }) {
  const db = getDb();
  const existing = db.prepare('SELECT n FROM phases WHERE project = ? AND n = ?').get(project, n);
  if (existing) {
    db.prepare('UPDATE phases SET title = ?, status = ? WHERE project = ? AND n = ?')
      .run(title || null, status, project, n);
  } else {
    db.prepare('INSERT INTO phases (project, n, title, status) VALUES (?, ?, ?, ?)')
      .run(project, n, title || null, status);
  }
}

export function markPhaseStarted({ project, n, model_used, session_id }) {
  getDb().prepare(`
    UPDATE phases SET status = 'in-progress', model_used = ?, session_id = ?, started_at = ?,
      interruption_kind = NULL, interruption_reason = NULL, interrupted_at = NULL
    WHERE project = ? AND n = ?
  `).run(model_used, session_id, new Date().toISOString(), project, n);
}

export function markPhaseInterrupted({ project, n, kind, reason = null, now = new Date() }) {
  return getDb().prepare(`
    UPDATE phases SET interruption_kind = ?, interruption_reason = ?, interrupted_at = ?
    WHERE project = ? AND n = ? AND status = 'in-progress'
  `).run(kind || 'process', reason ? String(reason).slice(0, 1000) : null, now.toISOString(), project, n);
}

export function markInProgressPhasesInterrupted(project, { kind, reason = null, now = new Date() } = {}) {
  return getDb().prepare(`
    UPDATE phases SET interruption_kind = ?, interruption_reason = ?, interrupted_at = ?
    WHERE project = ? AND status = 'in-progress'
  `).run(kind || 'process', reason ? String(reason).slice(0, 1000) : null, now.toISOString(), project);
}

export function backfillPhaseSessionId({ project, n, session_id }) {
  getDb().prepare(`
    UPDATE phases SET session_id = ? WHERE project = ? AND n = ?
  `).run(session_id, project, n);
}

export function markPhaseCompleted({ project, n, commit_sha }) {
  getDb().prepare(`
    UPDATE phases SET status = 'completed', commit_sha = ?, completed_at = ?,
      interruption_kind = NULL, interruption_reason = NULL, interrupted_at = NULL
    WHERE project = ? AND n = ?
  `).run(commit_sha || null, new Date().toISOString(), project, n);
}

export function getPhases(project) {
  return getDb().prepare('SELECT * FROM phases WHERE project = ? ORDER BY n ASC').all(project);
}

export function skipPhase(project, n) {
  return getDb().prepare(
    `UPDATE phases SET status='skipped', completed_at=datetime('now')
     WHERE project=? AND n=? AND status='pending'`,
  ).run(project, n);
}

// ─── Sessions ───────────────────────────────────────────────────────────────

export function upsertSession({ session_id, project, role }) {
  const db = getDb();
  const existing = db.prepare('SELECT session_id FROM sessions WHERE session_id = ?').get(session_id);
  if (existing) {
    db.prepare('UPDATE sessions SET last_resumed_at = ? WHERE session_id = ?')
      .run(new Date().toISOString(), session_id);
  } else {
    db.prepare(`
      INSERT INTO sessions (session_id, project, role, started_at)
      VALUES (?, ?, ?, ?)
    `).run(session_id, project, role, new Date().toISOString());
  }
}

// ─── Calls ──────────────────────────────────────────────────────────────────

export function recordCall({
  session_id, project, phase, task, model,
  duration_ms, cost_usd, input_tokens, output_tokens,
  cache_read_tokens, cache_creation_tokens, num_turns, is_error, error_message,
  // v0.17 (OBS-2): max_turns is the resolveMaxTurns() budget this call ran
  // under; the rest come from the optional `routing` object callers thread
  // through runClaude (routeModel()'s {tier, reasoning} plus the caller's own
  // attempt/escalated bookkeeping). All optional — omitting them (every
  // pre-OBS-2 call site) records NULL/0, never throws.
  max_turns, routing_tier, routing_reason, attempt, escalated,
  // Internal runClaude retry attribution. These are deliberately distinct
  // from `attempt`, whose public meaning is the phase routing attempt.
  logical_call_id, subprocess_attempt,
  // Phase 31: last assistant turn's per-request context size — optional,
  // omitting it (every pre-phase-31 call site) records NULL, never throws.
  context_tokens,
  // Schema 19: optional Hybrid Context Compiler attribution.
  context_manifest_id, context_provider, context_mode, context_injected_tokens,
}) {
  const db = getDb();
  db.prepare(`
    INSERT INTO calls (
      session_id, project, phase, task, model,
      started_at, duration_ms, cost_usd, input_tokens, output_tokens,
      cache_read_tokens, cache_creation_tokens, num_turns, is_error, error_message,
      max_turns, routing_tier, routing_reason, attempt, escalated,
      logical_call_id, subprocess_attempt, context_tokens,
      context_manifest_id, context_provider, context_mode, context_injected_tokens
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    session_id || null, project || null, phase || null, task, model,
    new Date().toISOString(), duration_ms || null, cost_usd || null,
    input_tokens || null, output_tokens || null,
    cache_read_tokens || null, cache_creation_tokens || null,
    Number.isFinite(num_turns) ? num_turns : null,
    is_error ? 1 : 0, error_message || null,
    Number.isFinite(max_turns) ? max_turns : null,
    routing_tier || null, routing_reason || null,
    Number.isFinite(attempt) ? attempt : null,
    escalated ? 1 : 0,
    logical_call_id || null,
    Number.isFinite(subprocess_attempt) ? subprocess_attempt : null,
    Number.isFinite(context_tokens) ? context_tokens : null,
    context_manifest_id || null,
    context_provider || null,
    context_mode || null,
    Number.isFinite(context_injected_tokens) ? context_injected_tokens : null,
  );

  if (session_id) {
    db.prepare(`
      UPDATE sessions
      SET total_calls = total_calls + 1,
          total_cost_usd = total_cost_usd + COALESCE(?, 0),
          total_input_tokens = total_input_tokens + COALESCE(?, 0),
          total_output_tokens = total_output_tokens + COALESCE(?, 0)
      WHERE session_id = ?
    `).run(cost_usd, input_tokens, output_tokens, session_id);
  }
}

/** Latest compiler attribution for a resumable Claude session (ownership is proven by the caller). */
export function getLatestSessionContext(sessionId) {
  if (!sessionId) return null;
  return getDb().prepare(`
    SELECT
      context_manifest_id AS manifest_id,
      context_provider AS provider,
      context_mode AS mode,
      context_injected_tokens AS injected_tokens
    FROM calls
    WHERE session_id = ? AND context_manifest_id IS NOT NULL
    ORDER BY id DESC
    LIMIT 1
  `).get(sessionId) || null;
}

// ─── Hybrid Context Compiler telemetry (schema 19) ─────────────────────────

export function recordContextManifest(manifest) {
  if (!manifest?.manifest_id || !manifest?.project) return false;
  const db = getDb();
  db.prepare(`
    INSERT INTO context_manifests (
      manifest_id, project, phase, task_kind, base_sha, provider, mode,
      generated_at, duration_ms, token_estimate, confidence,
      candidate_files, candidate_symbols, package_scopes, predicted_files,
      manifest_path, status, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(manifest_id) DO UPDATE SET
      generated_at = excluded.generated_at,
      duration_ms = excluded.duration_ms,
      token_estimate = excluded.token_estimate,
      confidence = excluded.confidence,
      candidate_files = excluded.candidate_files,
      candidate_symbols = excluded.candidate_symbols,
      package_scopes = excluded.package_scopes,
      predicted_files = excluded.predicted_files,
      actual_files = NULL,
      precision = NULL,
      recall = NULL,
      manifest_path = excluded.manifest_path,
      status = excluded.status,
      error_message = excluded.error_message
  `).run(
    manifest.manifest_id,
    manifest.project,
    Number.isInteger(manifest.phase) ? manifest.phase : null,
    manifest.task_kind || 'phase',
    manifest.base_sha || null,
    manifest.provider || 'unknown',
    manifest.mode || 'shadow',
    manifest.generated_at || new Date().toISOString(),
    Number.isFinite(manifest.duration_ms) ? manifest.duration_ms : null,
    Number.isFinite(manifest.injected_token_estimate) ? manifest.injected_token_estimate : null,
    Number.isFinite(manifest.confidence) ? manifest.confidence : null,
    Number.isFinite(manifest.candidate_counts?.files) ? manifest.candidate_counts.files : null,
    Number.isFinite(manifest.candidate_counts?.symbols) ? manifest.candidate_counts.symbols : null,
    JSON.stringify(Array.isArray(manifest.package_scopes) ? manifest.package_scopes : []),
    JSON.stringify((manifest.ranked_files || []).map((file) => file.path)),
    manifest.manifest_path || null,
    manifest.status || 'compiled',
    manifest.error_message || null,
  );
  return true;
}

export function recordContextOutcome({ manifest_id, actual_files } = {}) {
  if (!manifest_id) return null;
  const db = getDb();
  const row = db.prepare('SELECT predicted_files FROM context_manifests WHERE manifest_id = ?').get(manifest_id);
  if (!row) return null;
  let predicted = [];
  try { predicted = JSON.parse(row.predicted_files || '[]'); } catch { predicted = []; }
  const predictedSet = new Set(predicted);
  const actual = [...new Set((Array.isArray(actual_files) ? actual_files : []).map(String))];
  const actualSet = new Set(actual);
  const intersection = [...predictedSet].filter((file) => actualSet.has(file)).length;
  // Define empty-set cases instead of dropping the worst misses from rollout
  // metrics: predicting nothing for real edits is precision=0/recall=0;
  // predicting files for no actual edits is likewise 0/0. Both empty is the
  // only exact empty-set match.
  const precision = predictedSet.size ? intersection / predictedSet.size : actualSet.size ? 0 : 1;
  const recall = actualSet.size ? intersection / actualSet.size : predictedSet.size ? 0 : 1;
  db.prepare(`
    UPDATE context_manifests
    SET actual_files = ?, precision = ?, recall = ?
    WHERE manifest_id = ?
  `).run(JSON.stringify(actual), precision, recall, manifest_id);
  return { predicted: predictedSet.size, actual: actualSet.size, intersection, precision, recall };
}

export function recordContextCompileEvent({
  project, phase = null, task_kind = 'phase', requested_mode = 'shadow', provider = 'unknown',
  started_at = new Date().toISOString(), duration_ms = null, status, manifest_id = null,
  compiler_fingerprint = null, error_message = null,
} = {}) {
  if (!project || !['compiled', 'failed', 'timeout'].includes(status)) return null;
  const info = getDb().prepare(`
    INSERT INTO context_compile_events (
      project, phase, task_kind, requested_mode, provider, started_at,
      duration_ms, status, manifest_id, compiler_fingerprint, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    project,
    Number.isInteger(phase) ? phase : null,
    task_kind || 'phase', requested_mode || 'shadow', provider || 'unknown', started_at,
    Number.isFinite(duration_ms) ? duration_ms : null,
    status, manifest_id || null, compiler_fingerprint || null, error_message || null,
  );
  return Number(info.lastInsertRowid);
}

export function recentContextCompileEvents(project, limit = 20) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 20;
  return getDb().prepare(`
    SELECT * FROM context_compile_events
    WHERE project = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(project, safeLimit);
}

export function contextCompilerRolloutWindow(project, limit = 20) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 20;
  return getDb().prepare(`
    SELECT * FROM (
      SELECT
        CASE
          WHEN e.status = 'compiled' AND e.manifest_id IS NOT NULL THEN e.manifest_id
          ELSE 'compile-event:' || e.id
        END AS manifest_id,
        e.manifest_id AS artifact_manifest_id,
        e.started_at AS generated_at,
        e.status,
        e.error_message,
        e.requested_mode AS mode,
        e.provider,
        e.compiler_fingerprint,
        m.confidence,
        m.precision,
        m.recall,
        m.package_scopes,
        m.candidate_files,
        CASE WHEN m.manifest_id IS NULL THEN 0 ELSE 1 END AS artifact_found
      FROM context_compile_events e
      LEFT JOIN context_manifests m ON m.manifest_id = e.manifest_id
      WHERE e.project = ?

      UNION ALL

      SELECT
        m.manifest_id AS manifest_id,
        m.manifest_id AS artifact_manifest_id,
        m.generated_at AS generated_at,
        'untracked-artifact' AS status,
        'compiled artifact has no matching compile-attempt event' AS error_message,
        m.mode AS mode,
        m.provider AS provider,
        NULL AS compiler_fingerprint,
        m.confidence,
        m.precision,
        m.recall,
        m.package_scopes,
        m.candidate_files,
        1 AS artifact_found
      FROM context_manifests m
      WHERE m.project = ?
        AND NOT EXISTS (
          SELECT 1 FROM context_compile_events e2
          WHERE e2.manifest_id = m.manifest_id AND e2.status = 'compiled'
        )
    )
    ORDER BY generated_at DESC
    LIMIT ?
  `).all(project, project, safeLimit);
}

export function getContextCompilerRollout(project) {
  return getDb().prepare('SELECT * FROM context_compiler_rollouts WHERE project = ?').get(project) || null;
}

export function saveContextCompilerRollout({
  project, configured_mode, effective_mode, recommendation = 'hold', stage_id = null, evidence = null,
} = {}) {
  if (!project || !configured_mode || !effective_mode) return false;
  const db = getDb();
  const now = new Date().toISOString();
  const evidenceJson = evidence == null ? null : JSON.stringify(evidence);
  db.transaction(() => {
    db.prepare(`
      INSERT INTO context_compiler_rollouts (
        project, configured_mode, effective_mode, recommendation, stage_id, evidence_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project) DO UPDATE SET
        configured_mode = excluded.configured_mode,
        effective_mode = excluded.effective_mode,
        recommendation = excluded.recommendation,
        stage_id = excluded.stage_id,
        evidence_json = excluded.evidence_json,
        updated_at = excluded.updated_at
    `).run(project, configured_mode, effective_mode, recommendation, stage_id, evidenceJson, now);
    if (stage_id && [
      'promote-to-assist', 'rollback-to-shadow', 'disabled', 'automation-disabled',
    ].includes(recommendation)) {
      db.prepare(`
        INSERT OR IGNORE INTO context_compiler_rollout_events (
          stage_id, project, configured_mode, effective_mode, recommendation, evidence_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(stage_id, project, configured_mode, effective_mode, recommendation, evidenceJson, now);
    }
  })();
  return true;
}

export function listContextCompilerRolloutEvents(project, limit = 50) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
  return getDb().prepare(`
    SELECT * FROM context_compiler_rollout_events
    WHERE project = ? ORDER BY created_at DESC LIMIT ?
  `).all(project, safeLimit);
}

export function recentContextManifests(project, limit = 20) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 20;
  return getDb().prepare(`
    SELECT * FROM context_manifests
    WHERE project = ?
    ORDER BY generated_at DESC
    LIMIT ?
  `).all(project, safeLimit);
}

// ─── Historical phase-size calibration ────────────────────────────────────

/**
 * Persist one dev/fix execution's plan-size features and measured call cost.
 * When actual_turns/context_tokens are omitted, the values are derived from
 * every matching calls row created since execution_started_at, which includes
 * bounded continuations and fresh compact recovery calls without mutating the
 * runner result object. This function is sync/best-effort like other state
 * telemetry: invalid input returns null and never invents a zero-turn sample.
 */
export function recordPhaseExecutionFeature({
  project, phase = null, task_kind = 'dev-execution', execution_started_at = null,
  criteria_count = 0, files_count = 0, high_risk = 0, dependency_count = 0,
  text_chars = 0, actual_turns = null, context_tokens = null,
  max_turn_error = false, provider_error = false, success = false,
} = {}) {
  if (!project) return null;
  const db = getDb();
  let measuredTurns = actual_turns != null && Number.isFinite(Number(actual_turns)) ? Number(actual_turns) : null;
  let measuredContext = context_tokens != null && Number.isFinite(Number(context_tokens)) ? Number(context_tokens) : null;
  if (execution_started_at && (measuredTurns == null || measuredContext == null)) {
    const metrics = db.prepare(`
      SELECT SUM(num_turns) AS actual_turns, MAX(context_tokens) AS context_tokens
      FROM calls
      WHERE project = ? AND phase IS ? AND task = ? AND started_at >= ?
    `).get(project, Number.isInteger(phase) ? phase : null, task_kind, execution_started_at);
    if (measuredTurns == null && Number(metrics?.actual_turns) > 0) measuredTurns = Number(metrics.actual_turns);
    if (measuredContext == null && Number(metrics?.context_tokens) > 0) measuredContext = Number(metrics.context_tokens);
  }
  const info = db.prepare(`
    INSERT INTO phase_execution_features (
      project, phase, task_kind, recorded_at, execution_started_at,
      criteria_count, files_count, high_risk, dependency_count, text_chars,
      actual_turns, context_tokens, max_turn_error, provider_error, success
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    project, Number.isInteger(phase) ? phase : null, task_kind || 'dev-execution',
    new Date().toISOString(), execution_started_at || null,
    Math.max(0, Number(criteria_count) || 0), Math.max(0, Number(files_count) || 0),
    high_risk ? 1 : 0, Math.max(0, Number(dependency_count) || 0),
    Math.max(0, Number(text_chars) || 0), measuredTurns, measuredContext,
    max_turn_error ? 1 : 0, provider_error ? 1 : 0, success ? 1 : 0,
  );
  return Number(info.lastInsertRowid);
}

/** Recent samples across the portfolio by default, so future projects learn. */
export function recentPhaseExecutionFeatures({ project = null, taskKind = null, limit = 200 } = {}) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 2000) : 200;
  if (project && taskKind) {
    return getDb().prepare(`
      SELECT * FROM phase_execution_features
      WHERE project = ? AND task_kind = ? ORDER BY id DESC LIMIT ?
    `).all(project, taskKind, safeLimit);
  }
  if (project) {
    return getDb().prepare(`
      SELECT * FROM phase_execution_features WHERE project = ? ORDER BY id DESC LIMIT ?
    `).all(project, safeLimit);
  }
  if (taskKind) {
    return getDb().prepare(`
      SELECT * FROM phase_execution_features WHERE task_kind = ? ORDER BY id DESC LIMIT ?
    `).all(taskKind, safeLimit);
  }
  return getDb().prepare(`
    SELECT * FROM phase_execution_features ORDER BY id DESC LIMIT ?
  `).all(safeLimit);
}

function collectContextEvidenceStrings(raw, target) {
  if (!raw) return;
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { return; }
  }
  const visit = (item) => {
    if (typeof item === 'string') {
      target.add(item);
    } else if (Array.isArray(item)) {
      for (const child of item) visit(child);
    } else if (item && typeof item === 'object') {
      for (const child of Object.values(item)) visit(child);
    }
  };
  visit(value);
}

function pathIsInside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/**
 * Remove one compiler artifact only when its path is exactly the managed
 * state/context/<project>/<manifest-id>.json location. The real parent check
 * also rejects a project-directory symlink that escapes the context root.
 */
function removeManagedContextArtifact(row, contextRoot) {
  const root = path.resolve(contextRoot);
  const projectDir = path.resolve(root, String(row.project || ''));
  const expected = path.resolve(projectDir, `${row.manifest_id}.json`);
  const candidate = path.resolve(row.manifest_path || expected);
  if (!pathIsInside(root, projectDir)
      || !pathIsInside(projectDir, candidate)
      || candidate !== expected) {
    return { databaseSafe: true, removed: false, unsafe: true };
  }

  let stat;
  try {
    stat = fs.lstatSync(candidate);
  } catch (err) {
    if (err?.code === 'ENOENT') return { databaseSafe: true, removed: false, unsafe: false };
    return { databaseSafe: false, removed: false, unsafe: false, error: err };
  }
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    return { databaseSafe: false, removed: false, unsafe: false, error: new Error('artifact path is not a regular file') };
  }

  try {
    const realRoot = fs.realpathSync(root);
    const realParent = fs.realpathSync(path.dirname(candidate));
    if (!pathIsInside(realRoot, realParent)) {
      return { databaseSafe: true, removed: false, unsafe: true };
    }
    fs.unlinkSync(candidate);
    return { databaseSafe: true, removed: true, unsafe: false };
  } catch (err) {
    if (err?.code === 'ENOENT') return { databaseSafe: true, removed: false, unsafe: false };
    return { databaseSafe: false, removed: false, unsafe: false, error: err };
  }
}

function refreshContextLatestPointers(db, contextRoot, deletedRows) {
  const root = path.resolve(contextRoot);
  const projects = new Set(deletedRows.map((row) => row.project).filter(Boolean));
  // Also revisit prior failed refreshes. A manifest row may already have been
  // deleted before a transient filesystem failure left latest.json stale.
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() || entry.isSymbolicLink()) projects.add(entry.name);
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') return { repaired: 0, removed: 0, errors: 1 };
  }
  let repaired = 0;
  let removed = 0;
  let errors = 0;
  for (const project of projects) {
    const projectDir = path.resolve(root, String(project || ''));
    const latestPath = path.resolve(projectDir, 'latest.json');
    if (!pathIsInside(root, projectDir) || !pathIsInside(projectDir, latestPath)) {
      errors += 1;
      continue;
    }
    try {
      const realRoot = fs.realpathSync(root);
      const realProjectDir = fs.realpathSync(projectDir);
      if (!pathIsInside(realRoot, realProjectDir)) {
        errors += 1;
        continue;
      }
      let latestStat;
      try { latestStat = fs.lstatSync(latestPath); } catch (err) {
        if (err?.code === 'ENOENT') continue;
        throw err;
      }
      // The compiler always writes a regular latest.json. Replacing a symlink
      // by unlinking the link itself avoids following an attacker-controlled
      // destination while also removing a pointer we cannot safely inspect.
      if (!latestStat.isFile()) {
        if (latestStat.isSymbolicLink()) {
          fs.unlinkSync(latestPath);
          removed += 1;
        } else {
          errors += 1;
        }
        continue;
      }
      let latest = null;
      try { latest = JSON.parse(fs.readFileSync(latestPath, 'utf8')); } catch {
        // latest.json is a managed convenience pointer, never source evidence.
        // A malformed regular pointer can therefore be repaired from the
        // newest retained exact manifest (or removed when none remains).
      }
      const latestTracked = latest?.manifest_id
        ? db.prepare(`SELECT 1 FROM context_manifests WHERE project = ? AND manifest_id = ?`).get(project, latest.manifest_id)
        : null;
      if (latestTracked) continue;

      const replacement = db.prepare(`
        SELECT manifest_id, project, manifest_path
        FROM context_manifests
        WHERE project = ? ORDER BY generated_at DESC LIMIT 1
      `).get(project);
      let replacementPath = null;
      if (replacement) {
        const expected = path.resolve(projectDir, `${replacement.manifest_id}.json`);
        const candidate = path.resolve(replacement.manifest_path || expected);
        if (candidate === expected && pathIsInside(projectDir, candidate)) {
          const stat = fs.lstatSync(candidate);
          if (stat.isFile()) replacementPath = candidate;
        }
      }
      if (!replacementPath) {
        fs.unlinkSync(latestPath);
        removed += 1;
        continue;
      }

      const tempPath = path.join(projectDir, `.latest.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
      try {
        fs.writeFileSync(tempPath, fs.readFileSync(replacementPath));
        fs.renameSync(tempPath, latestPath);
        repaired += 1;
      } catch (err) {
        try { fs.unlinkSync(tempPath); } catch { /* best-effort temp cleanup */ }
        throw err;
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') errors += 1;
      else {
        try {
          fs.unlinkSync(latestPath);
          removed += 1;
        } catch { /* already absent */ }
      }
    }
  }
  return { repaired, removed, errors };
}

/**
 * Best-effort bounded retention for Hybrid Context Compiler telemetry.
 *
 * The existing cleanup.calls_retention_days control is deliberately reused by
 * auto-runner rather than adding another config key. Artifacts cited by any
 * retained call, recent compile attempt, current rollout state, or retained
 * rollout-history row are protected. For a protected/young manifest, the most
 * recent compiled attempt is retained as its tracking link; older duplicates
 * may still be pruned.
 */
export function pruneOldContextCompilerTelemetry(days, { contextRoot = null } = {}) {
  const retentionDays = Number(days);
  const empty = {
    events: 0,
    manifests: 0,
    rollout_events: 0,
    files: 0,
    file_errors: 0,
    unsafe_paths: 0,
    protected_manifests: 0,
    latest_repaired: 0,
    latest_removed: 0,
  };
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return empty;

  const db = getDb();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const root = path.resolve(contextRoot || process.env.AORCH_CONTEXT_STATE_DIR || path.join(REPO_ROOT, 'state', 'context'));
  const allManifests = db.prepare(`
    SELECT manifest_id, project, generated_at, manifest_path
    FROM context_manifests
  `).all();
  const manifestIds = new Set(allManifests.map((row) => row.manifest_id));
  const protectedIds = new Set();

  for (const row of db.prepare(`
    SELECT DISTINCT context_manifest_id AS manifest_id
    FROM calls WHERE context_manifest_id IS NOT NULL
  `).all()) {
    protectedIds.add(row.manifest_id);
  }
  for (const row of db.prepare(`
    SELECT DISTINCT manifest_id FROM context_compile_events
    WHERE started_at >= ? AND manifest_id IS NOT NULL
  `).all(cutoff)) {
    protectedIds.add(row.manifest_id);
  }

  const currentRollouts = db.prepare(`
    SELECT stage_id, evidence_json FROM context_compiler_rollouts
  `).all();
  const currentStageIds = new Set(currentRollouts.map((row) => row.stage_id).filter(Boolean));
  for (const row of currentRollouts) collectContextEvidenceStrings(row.evidence_json, protectedIds);
  const rolloutHistory = db.prepare(`
    SELECT stage_id, evidence_json, created_at FROM context_compiler_rollout_events
  `).all();
  for (const row of rolloutHistory) {
    if (row.created_at >= cutoff || currentStageIds.has(row.stage_id)) {
      collectContextEvidenceStrings(row.evidence_json, protectedIds);
    }
  }

  const expiredManifests = allManifests.filter((row) => row.generated_at < cutoff);
  const deletableManifests = [];
  let files = 0;
  let fileErrors = 0;
  let unsafePaths = 0;
  let protectedManifests = 0;
  for (const row of expiredManifests) {
    if (protectedIds.has(row.manifest_id)) {
      protectedManifests += 1;
      continue;
    }
    const result = removeManagedContextArtifact(row, root);
    if (result.removed) files += 1;
    if (result.unsafe) unsafePaths += 1;
    if (!result.databaseSafe) {
      fileErrors += 1;
      continue;
    }
    deletableManifests.push(row);
  }

  const deletingManifestIds = new Set(deletableManifests.map((row) => row.manifest_id));
  const remainingManifestIds = new Set([...manifestIds].filter((id) => !deletingManifestIds.has(id)));
  const allEvents = db.prepare(`
    SELECT id, status, manifest_id, started_at
    FROM context_compile_events ORDER BY id ASC
  `).all();
  const newestCompiledEvent = new Map();
  for (const row of allEvents) {
    if (row.status === 'compiled' && row.manifest_id && remainingManifestIds.has(row.manifest_id)) {
      newestCompiledEvent.set(row.manifest_id, row.id);
    }
  }
  const eventIdsToDelete = allEvents
    .filter((row) => row.started_at < cutoff)
    .filter((row) => !(row.status === 'compiled'
      && row.manifest_id
      && remainingManifestIds.has(row.manifest_id)
      && newestCompiledEvent.get(row.manifest_id) === row.id))
    .map((row) => row.id);
  const rolloutStageIdsToDelete = rolloutHistory
    .filter((row) => row.created_at < cutoff && !currentStageIds.has(row.stage_id))
    .map((row) => row.stage_id);

  const deleteEvent = db.prepare('DELETE FROM context_compile_events WHERE id = ?');
  const deleteManifest = db.prepare('DELETE FROM context_manifests WHERE manifest_id = ?');
  const deleteRolloutEvent = db.prepare('DELETE FROM context_compiler_rollout_events WHERE stage_id = ?');
  const deleted = db.transaction(() => {
    let events = 0;
    let manifests = 0;
    let rolloutEvents = 0;
    for (const id of eventIdsToDelete) events += deleteEvent.run(id).changes;
    for (const row of deletableManifests) manifests += deleteManifest.run(row.manifest_id).changes;
    for (const stageId of rolloutStageIdsToDelete) rolloutEvents += deleteRolloutEvent.run(stageId).changes;
    return { events, manifests, rollout_events: rolloutEvents };
  })();
  const latest = refreshContextLatestPointers(db, root, deletableManifests);

  return {
    ...deleted,
    files,
    file_errors: fileErrors + latest.errors,
    unsafe_paths: unsafePaths,
    protected_manifests: protectedManifests,
    latest_repaired: latest.repaired,
    latest_removed: latest.removed,
  };
}

export function callsInLastHours(hours) {
  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  return getDb().prepare('SELECT * FROM calls WHERE started_at >= ? ORDER BY started_at DESC').all(cutoff);
}

// Phase 54 (par-07): the per-project slice of callsInLastHours — same trailing
// window, filtered to one project. Powers billing-guard.js's fairShareStatus so
// fair-share admission asks "how much of the shared window has THIS project
// burned", not the global pool (which callsInLastHours already answers).
export function callsInLastHoursForProject(hours, project) {
  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  return getDb()
    .prepare('SELECT * FROM calls WHERE started_at >= ? AND project = ? ORDER BY started_at DESC')
    .all(cutoff, project);
}

export function pruneOldCalls(days) {
  return getDb()
    .prepare(`DELETE FROM calls WHERE started_at < datetime('now', '-' || ? || ' days')`)
    .run(days).changes;
}

// Phase 56 (MI-5): the newest `limit` calls for one project × task, ordered
// started_at DESC (newest first) — the read-only telemetry window that
// routing-telemetry.js's computeRoutingAdjustment learns escalation floors from.
// SELECT-only: the module and its auto-run preflight never write the calls table.
export function recentCallsForProjectTask(project, task, limit) {
  return getDb()
    .prepare('SELECT * FROM calls WHERE project = ? AND task = ? ORDER BY started_at DESC LIMIT ?')
    .all(project, task, limit);
}

// ─── Spend / cache-hit reporting ────────────────────────────────────────────
// Single shared aggregation query for the /spend report (P1). cost-report.js
// (CLI + Telegram/Discord parity handlers) and web-ui.js both call
// getSpendReport() instead of each hand-rolling the same SQL, per the brief's
// "one aggregation query helper in state.js" rule.

/**
 * cache_read_tokens / (input_tokens + cache_read_tokens + cache_creation_tokens),
 * as a percentage rounded to one decimal. Guards the denominator: a row with
 * no token data at all (e.g. an errored call recorded before usage came back)
 * returns 0 instead of NaN/Infinity.
 *
 * @param {{input_tokens?:number, cache_read_tokens?:number, cache_creation_tokens?:number}} [row]
 * @returns {number}
 */
export function cacheHitPct(row = {}) {
  const input = row.input_tokens || 0;
  const read = row.cache_read_tokens || 0;
  const creation = row.cache_creation_tokens || 0;
  const denom = input + read + creation;
  if (denom <= 0) return 0;
  return Math.round((read / denom) * 1000) / 10;
}

/**
 * Spend grouped by task+model over a trailing window, with cache_hit_pct
 * attached to every row and to the totals row.
 *
 * @param {object} [o]
 * @param {number} [o.days=30]      trailing window in days (clamped 1..365)
 * @param {string} [o.project=null] limit to one project (null = all)
 * @returns {{
 *   days: number, project: string|null,
 *   rows: Array<{task:string, model:string, n:number, errors:number, usd:number,
 *                input_tokens:number, output_tokens:number, cache_read_tokens:number,
 *                cache_creation_tokens:number, cache_hit_pct:number}>,
 *   byProject: Array<{project:string, n:number, usd:number}>,
 *   totals: { n:number, usd:number, errors:number, uncosted:number,
 *             input_tokens:number, output_tokens:number, cache_read_tokens:number,
 *             cache_creation_tokens:number, cache_hit_pct:number },
 *   audit_yield: { findings:number, audit_usd:number, usd_per_finding:number|null },
 * }}
 */
export function getSpendReport({ days = 30, project = null } = {}) {
  const db = getDb();
  const d = Math.max(1, Math.min(365, Number(days) || 30));
  const since = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();

  const where = project ? 'started_at >= ? AND project = ?' : 'started_at >= ?';
  const params = project ? [since, project] : [since];

  const rows = db.prepare(`
    SELECT task, model,
           COUNT(*)                               AS n,
           SUM(is_error)                          AS errors,
           ROUND(COALESCE(SUM(cost_usd),0), 4)    AS usd,
           COALESCE(SUM(input_tokens),0)          AS input_tokens,
           COALESCE(SUM(output_tokens),0)         AS output_tokens,
           COALESCE(SUM(cache_read_tokens),0)     AS cache_read_tokens,
           COALESCE(SUM(cache_creation_tokens),0) AS cache_creation_tokens
    FROM calls
    WHERE ${where}
    GROUP BY task, model
    ORDER BY usd DESC, n DESC
  `).all(...params).map((r) => ({ ...r, cache_hit_pct: cacheHitPct(r) }));

  const byProject = db.prepare(`
    SELECT COALESCE(project, '(none)') AS project,
           COUNT(*)                           AS n,
           ROUND(COALESCE(SUM(cost_usd),0), 4) AS usd
    FROM calls
    WHERE ${where}
    GROUP BY COALESCE(project, '(none)')
    ORDER BY usd DESC
  `).all(...params);

  const totalsRow = db.prepare(`
    SELECT COUNT(*)                                AS n,
           ROUND(COALESCE(SUM(cost_usd),0), 4)     AS usd,
           COALESCE(SUM(is_error),0)               AS errors,
           SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS uncosted,
           COALESCE(SUM(input_tokens),0)           AS input_tokens,
           COALESCE(SUM(output_tokens),0)          AS output_tokens,
           COALESCE(SUM(cache_read_tokens),0)      AS cache_read_tokens,
           COALESCE(SUM(cache_creation_tokens),0)  AS cache_creation_tokens
    FROM calls
    WHERE ${where}
  `).get(...params);
  const totals = { ...totalsRow, cache_hit_pct: cacheHitPct(totalsRow) };

  // Phase 34: $-per-finding. Findings come from bug_rounds.audit_findings_promoted
  // (recordAuditYield, NULL on legacy rows → COALESCE'd away by SUM); the $
  // numerator is every call whose task is one of the three audit task ids
  // (see defaults.json models: 'audit', 'audit-scan', 'audit-incremental').
  // Same trailing window + project filter as the rest of the report —
  // bug_rounds.started_at plays the role calls.started_at plays above.
  // usd_per_finding is null (never Infinity/NaN) when the window promoted
  // zero findings; renderers show 'n/a (0 findings)'.
  const auditUsdRow = db.prepare(`
    SELECT ROUND(COALESCE(SUM(cost_usd),0), 4) AS usd
    FROM calls
    WHERE ${where} AND task IN ('audit', 'audit-scan', 'audit-incremental')
  `).get(...params);
  const findingsRow = db.prepare(`
    SELECT COALESCE(SUM(audit_findings_promoted),0) AS findings
    FROM bug_rounds
    WHERE ${where}
  `).get(...params);
  const findings = findingsRow.findings || 0;
  const auditUsd = auditUsdRow.usd || 0;
  const audit_yield = {
    findings,
    audit_usd: auditUsd,
    usd_per_finding: findings > 0 ? Math.round((auditUsd / findings) * 10000) / 10000 : null,
  };

  return { days: d, project, rows, byProject, totals, audit_yield };
}

// ─── Auto-runs ──────────────────────────────────────────────────────────────

export function startAutoRun({ project, unattended = 0 }) {
  const db = getDb();
  // Cancel any prior 'running' run for this project (only one active at a time)
  db.prepare(`UPDATE auto_runs SET status = 'aborted', ended_at = ? WHERE project = ? AND status = 'running'`)
    .run(new Date().toISOString(), project);
  const info = db.prepare(`
    INSERT INTO auto_runs (project, started_at, status, unattended)
    VALUES (?, ?, 'running', ?)
  `).run(project, new Date().toISOString(), unattended);
  return info.lastInsertRowid;
}

export function pauseAutoRun(id, reason, pauseKind = null) {
  getDb().prepare(`
    UPDATE auto_runs SET status = 'paused', pause_reason = ?, pause_kind = ?, ended_at = ?
    WHERE id = ?
  `).run(reason, pauseKind ?? null, new Date().toISOString(), id);
}

export function completeAutoRun(id) {
  getDb().prepare(`
    UPDATE auto_runs SET status = 'completed', ended_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), id);
}

/**
 * Terminal end for failed / cancelled runs. Historically these were written
 * through pauseAutoRun (status='paused' + a "failed: "/"cancelled: " reason
 * prefix, later flipped to 'aborted' by resetProjectForNewPlan) — so the
 * ledger literally contained no failed rows and every consumer had to
 * reverse-engineer the outcome from string prefixes. The real status is now
 * queryable; the "<status>: reason" prefix is KEPT in pause_reason so
 * prefix-reading consumers (classifyLastRun, autopsy, dashboards) behave
 * identically on old and new rows.
 */
export function endAutoRunTerminal(id, status, reason, pauseKind = null) {
  if (!['failed', 'cancelled'].includes(status)) {
    throw new Error(`endAutoRunTerminal: unsupported terminal status '${status}'`);
  }
  getDb().prepare(`
    UPDATE auto_runs SET status = ?, pause_reason = ?, pause_kind = ?, ended_at = ?
    WHERE id = ?
  `).run(status, `${status}: ${reason}`, pauseKind ?? null, new Date().toISOString(), id);
}

export function getActiveAutoRun(project) {
  return getDb().prepare(`SELECT * FROM auto_runs WHERE project = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1`).get(project);
}

export function getLastAutoRun(project) {
  return getDb().prepare(`SELECT * FROM auto_runs WHERE project = ? ORDER BY started_at DESC LIMIT 1`).get(project);
}

// Phase 62 — one run by id (the autopsy needs pause_reason/pause_kind/started_at
// /ended_at for the run finalize() just persisted). undefined for an unknown id.
export function getAutoRunById(id) {
  return getDb().prepare(`SELECT * FROM auto_runs WHERE id = ?`).get(id);
}

// Phase 62 — persist the structured autopsy JSON on the run row. Sync,
// NEVER-THROWING: the autopsy path is best-effort and must never fail a run.
export function setAutopsy(runId, json) {
  try {
    if (runId == null) return;
    getDb().prepare(`UPDATE auto_runs SET autopsy = ? WHERE id = ?`).run(json ?? null, runId);
  } catch (err) {
    console.warn(`[state] setAutopsy failed (non-fatal, runId=${runId}): ${err.message}`);
  }
}

// Phase 62 — errored calls (is_error=1) for a project inside the run window
// [since, until]. Feeds the autopsy's "what failed" deterministic context.
// Newest-first, capped. `until` null → open-ended (still-running/no ended_at).
export function erroredCallsInWindow({ project, since, until = null, limit = 20 } = {}) {
  if (!project || !since) return [];
  const db = getDb();
  if (until) {
    return db.prepare(
      `SELECT * FROM calls WHERE project = ? AND is_error = 1 AND started_at >= ? AND started_at <= ?
       ORDER BY started_at DESC LIMIT ?`,
    ).all(project, since, until, limit);
  }
  return db.prepare(
    `SELECT * FROM calls WHERE project = ? AND is_error = 1 AND started_at >= ?
     ORDER BY started_at DESC LIMIT ?`,
  ).all(project, since, limit);
}

// Phase 62 — the most recent acceptance-check verdict row for a project (any
// phase), for the autopsy's "latest verify verdict counts". undefined when the
// project has no verify_results rows (legacy/never-checked).
export function getLatestVerifyResult(project) {
  return getDb().prepare(
    `SELECT * FROM verify_results WHERE project = ? ORDER BY id DESC LIMIT 1`,
  ).get(project);
}

export function listAutoRuns(project, limit = 20) {
  return getDb().prepare(`SELECT * FROM auto_runs WHERE project = ? ORDER BY started_at DESC LIMIT ?`).all(project, limit);
}

// True when a pid is a live process. A hard-killed orchestrator (SIGKILL) never
// runs its releaseRunningJob() cleanup, so a stale running_jobs row can outlive
// the process — shared by web-ui.js (per-project display) and
// sweepInterruptedAutoRuns() below (crash-recovery sweep) so both agree on what
// counts as "alive". EPERM (exists, unsignalable) counts as alive; ESRCH is dead.
export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== 'ESRCH'; }
}

/**
 * Crash-recovery sweep: a killed orchestrator never reaches pauseAutoRun() /
 * completeAutoRun(), so its auto_runs row is stuck at status='running',
 * ended_at=null forever — status displays lie after a crash. Called on server
 * start (web-ui.js) and CLI go/resume entry (orchestrator.js); one shared
 * implementation so both call sites agree on what counts as "crashed".
 *
 * A running row is crashed when there is no running_jobs claim for its
 * project, or the claim's pid is no longer alive. Only touches auto_runs —
 * running_jobs stale-claim handling is untouched (claimRunningJob /
 * releaseRunningJob semantics are out of scope here).
 *
 * @returns {Array} the auto_runs rows that were swept (post-update shape), so
 *   callers can log one line each.
 */
export function sweepInterruptedAutoRuns() {
  const db = getDb();
  const running = db.prepare(`SELECT * FROM auto_runs WHERE status = 'running'`).all();
  const now = new Date().toISOString();
  const reason = 'orchestrator crashed or was killed mid-run';
  const swept = [];
  for (const row of running) {
    const claim = getRunningJob(row.project);
    if (claim && pidAlive(claim.pid)) continue; // live, correctly-claimed run — leave it
    db.prepare(`UPDATE auto_runs SET status = 'interrupted', pause_reason = ?, ended_at = ? WHERE id = ?`)
      .run(reason, now, row.id);
    swept.push({ ...row, status: 'interrupted', pause_reason: reason, ended_at: now });
  }
  return swept;
}

// ─── Bug rounds ─────────────────────────────────────────────────────────────

// found_count (Phase 60 — P4): optional, defaults to null (byte-identical to
// pre-phase-60 behavior for callers that never derive it, e.g. bug-cycle.js's
// manually-dropped-bugs.md CLI path). COALESCE on the UPDATE branch means a
// caller that doesn't know the count (found_count: null/omitted) never
// clobbers a value setBugRoundFoundCount already wrote for this round.
export function startBugRound({ project, round, bugs_file, total_fixes, found_count = null }) {
  const db = getDb();
  const existing = db.prepare(`SELECT id FROM bug_rounds WHERE project = ? AND round = ?`).get(project, round);
  if (existing) {
    db.prepare(`UPDATE bug_rounds SET total_fixes = ?, status = 'in-progress', found_count = COALESCE(?, found_count) WHERE id = ?`)
      .run(total_fixes, found_count, existing.id);
    return existing.id;
  }
  const info = db.prepare(`
    INSERT INTO bug_rounds (project, round, bugs_file, started_at, status, fixes_completed, total_fixes, found_count)
    VALUES (?, ?, ?, ?, 'in-progress', 0, ?, ?)
  `).run(project, round, bugs_file, new Date().toISOString(), total_fixes, found_count);
  return info.lastInsertRowid;
}

export function setBugRoundFixPlan({ project, round, fix_plan_file, total_fixes }) {
  getDb().prepare(`UPDATE bug_rounds SET fix_plan_file = ?, total_fixes = ? WHERE project = ? AND round = ?`)
    .run(fix_plan_file, total_fixes, project, round);
}

export function recordFixCompletion({ project, round, fixN }) {
  getDb().prepare(`UPDATE bug_rounds SET fixes_completed = fixes_completed + 1 WHERE project = ? AND round = ?`)
    .run(project, round);
}

export function setBugRoundStatus(project, round, status) {
  getDb().prepare(`UPDATE bug_rounds SET status = ?, ended_at = ? WHERE project = ? AND round = ?`)
    .run(status, new Date().toISOString(), project, round);
}

/**
 * Phase 34: attach audit-yield telemetry to an existing bug_rounds row.
 * UPDATE by (project, round) — deliberately a no-op when the row doesn't
 * exist yet (the auto-chain records best-effort both right after promote,
 * when the row usually doesn't exist, and again after the fix round's
 * autoRun created it via startBugRound). Never throws on a missing row.
 *
 * @param {string} project
 * @param {number} round
 * @param {{promoted?:number|null, clean?:boolean|number|null, model?:string|null,
 *          scope?:string|null, fingerprint?:string|null}} [yieldMeta]
 * @returns {number} rows updated (0 = row not found → no-op)
 */
export function recordAuditYield(project, round, { promoted, clean, model, scope, fingerprint } = {}) {
  const info = getDb().prepare(`
    UPDATE bug_rounds
    SET audit_findings_promoted = ?, audit_clean = ?, audit_model = ?, audit_scope = ?, audit_fingerprint = ?
    WHERE project = ? AND round = ?
  `).run(
    promoted ?? null,
    clean == null ? null : (clean ? 1 : 0),
    model ?? null, scope ?? null, fingerprint ?? null,
    project, round,
  );
  return info.changes;
}

export function getCurrentBugRound(project) {
  return getDb().prepare(`SELECT * FROM bug_rounds WHERE project = ? AND status = 'in-progress' ORDER BY round DESC LIMIT 1`).get(project);
}

export function getBugRound(project, round) {
  return getDb().prepare(`SELECT * FROM bug_rounds WHERE project = ? AND round = ?`).get(project, round);
}

export function listBugRounds(project) {
  return getDb().prepare(`SELECT * FROM bug_rounds WHERE project = ? ORDER BY round ASC`).all(project);
}

// ─── Requirements inbox ─────────────────────────────────────────────────────

export function addRequirement({ project, raw_text, source = 'cli', created_by = null }) {
  const now = new Date().toISOString();
  const info = getDb().prepare(
    `INSERT INTO requirements (project, raw_text, source, created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(project, raw_text, source, now, now, created_by);
  return info.lastInsertRowid;
}

export function getRequirement(id) {
  return getDb().prepare(`SELECT * FROM requirements WHERE id = ?`).get(id);
}

export function listRequirements({ project = null, status = null, priority = null, scope = null } = {}) {
  const where = [];
  const params = [];
  if (project) { where.push('project = ?'); params.push(project); }
  if (status)  { where.push('status = ?');  params.push(status);  }
  if (priority){ where.push('priority = ?');params.push(priority);}
  if (scope)   { where.push('scope = ?');   params.push(scope);   }
  const sql = `SELECT * FROM requirements ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id ASC`;
  return getDb().prepare(sql).all(...params);
}

export function updateRequirement(id, fields) {
  const allowed = ['raw_text', 'refined_text', 'priority', 'scope', 'status', 'tags', 'promoted_to'];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) { sets.push(`${k} = ?`); params.push(fields[k]); }
  }
  if (!sets.length) return 0;
  sets.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);
  return getDb().prepare(`UPDATE requirements SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes;
}

export function deleteRequirement(id) {
  return getDb().prepare(`DELETE FROM requirements WHERE id = ?`).run(id).changes;
}

export function countRequirements(project) {
  return getDb().prepare(
    `SELECT status, scope, COUNT(*) AS n FROM requirements WHERE project = ? GROUP BY status, scope`,
  ).all(project);
}

export function listProjectsWithRequirements() {
  return getDb().prepare(
    `SELECT project, COUNT(*) AS n FROM requirements GROUP BY project ORDER BY project`,
  ).all();
}

// ─── Bug inbox (v0.12.0) ────────────────────────────────────────────────────
//
// Mirror of the requirements inbox, but with severity-based triage instead of
// priority + scope. Bugs flow: inbox → refined (optional AI structuring) →
// promoted (folded into a bug round's bugs.md) → dropped.

export function addBug({ project, raw_text, severity = 'unassigned', source = 'cli', reported_by = null }) {
  const now = new Date().toISOString();
  const info = getDb().prepare(
    `INSERT INTO bug_inbox (project, raw_text, severity, source, reported_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(project, raw_text, severity, source, reported_by, now, now);
  return info.lastInsertRowid;
}

// Phase 44 (ship gate): insert a bug only if no OPEN (inbox/refined) row with
// the same (project, source, raw_text) already exists — so re-running the gate
// on the same unchanged workspace never accumulates duplicate rows. Returns
// { id, inserted }.
export function addDedupedBug({ project, raw_text, severity = 'unassigned', source = 'cli', reported_by = null }) {
  const db = getDb();
  const existing = db.prepare(
    `SELECT id FROM bug_inbox WHERE project = ? AND source = ? AND raw_text = ? AND status IN ('inbox', 'refined')`,
  ).get(project, source, raw_text);
  if (existing) return { id: existing.id, inserted: false };
  const now = new Date().toISOString();
  const info = db.prepare(
    `INSERT INTO bug_inbox (project, raw_text, severity, source, reported_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(project, raw_text, severity, source, reported_by, now, now);
  return { id: info.lastInsertRowid, inserted: true };
}

export function getBug(id) {
  return getDb().prepare(`SELECT * FROM bug_inbox WHERE id = ?`).get(id);
}

export function listBugs({ project = null, status = null, severity = null } = {}) {
  const where = [];
  const params = [];
  if (project)  { where.push('project = ?');  params.push(project);  }
  if (status)   { where.push('status = ?');   params.push(status);   }
  if (severity) { where.push('severity = ?'); params.push(severity); }
  const sql = `SELECT * FROM bug_inbox ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY
    CASE severity WHEN 'critical' THEN 0 WHEN 'major' THEN 1 WHEN 'minor' THEN 2 ELSE 3 END,
    id ASC`;
  return getDb().prepare(sql).all(...params);
}

export function updateBug(id, fields) {
  const allowed = ['raw_text', 'refined_text', 'severity', 'status', 'tags', 'promoted_to_round', 'notes'];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) { sets.push(`${k} = ?`); params.push(fields[k]); }
  }
  if (!sets.length) return 0;
  sets.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);
  return getDb().prepare(`UPDATE bug_inbox SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes;
}

export function deleteBug(id) {
  return getDb().prepare(`DELETE FROM bug_inbox WHERE id = ?`).run(id).changes;
}

export function countBugs(project) {
  return getDb().prepare(
    `SELECT status, severity, COUNT(*) AS n FROM bug_inbox WHERE project = ? GROUP BY status, severity`,
  ).all(project);
}

export function listProjectsWithBugs() {
  return getDb().prepare(
    `SELECT project, COUNT(*) AS n FROM bug_inbox WHERE status IN ('inbox', 'refined') GROUP BY project ORDER BY project`,
  ).all();
}

/** Mark a set of bug rows as promoted to a specific bug round. */
export function markBugsPromoted(ids, round) {
  const now = new Date().toISOString();
  const stmt = getDb().prepare(
    `UPDATE bug_inbox SET status = 'promoted', promoted_to_round = ?, updated_at = ? WHERE id = ? AND status IN ('inbox', 'refined')`,
  );
  let changed = 0;
  const tx = getDb().transaction((rows) => {
    for (const id of rows) {
      changed += stmt.run(round, now, id).changes;
    }
  });
  tx(ids);
  return changed;
}

// ─── Telegram capture-mode state ────────────────────────────────────────────

export function setCaptureMode(telegramUserId, project, kind = 'req') {
  // Try with `kind` column first; fall back to legacy schema if column missing.
  try {
    getDb().prepare(
      `INSERT INTO tg_capture_modes (telegram_user_id, project, kind, started_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(telegram_user_id) DO UPDATE SET project = excluded.project, kind = excluded.kind, started_at = excluded.started_at`,
    ).run(telegramUserId, project, kind, new Date().toISOString());
  } catch (err) {
    // Legacy schema (kind column not present)
    getDb().prepare(
      `INSERT INTO tg_capture_modes (telegram_user_id, project, started_at)
       VALUES (?, ?, ?)
       ON CONFLICT(telegram_user_id) DO UPDATE SET project = excluded.project, started_at = excluded.started_at`,
    ).run(telegramUserId, project, new Date().toISOString());
  }
}

export function clearCaptureMode(telegramUserId) {
  return getDb().prepare(`DELETE FROM tg_capture_modes WHERE telegram_user_id = ?`).run(telegramUserId).changes;
}

export function getCaptureMode(telegramUserId) {
  const row = getDb().prepare(`SELECT * FROM tg_capture_modes WHERE telegram_user_id = ?`).get(telegramUserId);
  if (row && !row.kind) row.kind = 'req'; // legacy default
  return row;
}

// ─── Suggestions ─────────────────────────────────────────────────────────────

export function saveSuggestions(project, { projectType, scanSnapshot, suggestions }) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO suggestions (project, generated_at, project_type, scan_snapshot_json, suggestions_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    project,
    new Date().toISOString(),
    projectType,
    JSON.stringify(scanSnapshot),
    JSON.stringify(suggestions),
  );
  return result.lastInsertRowid;
}

export function acceptSuggestions(id, { selected, pipelinePlan, pipelinePasses, nextPass }) {
  const db = getDb();
  const accept = db.transaction(() => {
    const row = db.prepare('SELECT project FROM suggestions WHERE id = ?').get(id);
    if (!row) throw new Error(`suggestions row ${id} not found`);
    const lowestPass = Object.keys(pipelinePlan).map(Number).sort((a, b) => a - b)
      .find(p => (pipelinePlan[String(p)] || []).length > 0) ?? 1;
    const resolvedNextPass = (Number.isInteger(nextPass) && nextPass >= 1) ? nextPass : lowestPass;
    db.prepare(`
      UPDATE suggestions
      SET status = 'accepted', selected_json = ?, pipeline_plan_json = ?, pipeline_passes = ?, next_pass = ?
      WHERE id = ?
    `).run(JSON.stringify(selected), JSON.stringify(pipelinePlan), pipelinePasses, resolvedNextPass, id);
    db.prepare(`
      UPDATE suggestions SET status = 'stale'
      WHERE project = ? AND id != ? AND status != 'stale'
    `).run(row.project, id);
  });
  accept();
}

export function setSuggestionNextPass(project, pass) {
  getDb().prepare(
    "UPDATE suggestions SET next_pass = ? WHERE project = ? AND status = 'accepted'"
  ).run(pass, project);
}

export function getLatestSuggestions(project) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM suggestions
    WHERE project = ? AND status IN ('accepted', 'draft')
    ORDER BY (status = 'accepted') DESC, id DESC
    LIMIT 1
  `).get(project) ?? null;
}

export function getFreshestSuggestions(project) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM suggestions
    WHERE project = ? AND status IN ('accepted', 'draft')
    ORDER BY (status = 'draft') DESC, id DESC
    LIMIT 1
  `).get(project) ?? null;
}

export function staleAllSuggestions(project) {
  const db = getDb();
  db.prepare(`UPDATE suggestions SET status = 'stale' WHERE project = ?`).run(project);
}

export function staleDraftSuggestions(project) {
  const db = getDb();
  db.prepare(`UPDATE suggestions SET status = 'stale' WHERE project = ? AND status = 'draft'`).run(project);
}

export function getSuggestionsProject(id) {
  const row = getDb().prepare('SELECT project FROM suggestions WHERE id = ?').get(id);
  return row?.project ?? null;
}

export function getSuggestionsById(id) {
  return getDb().prepare('SELECT * FROM suggestions WHERE id = ?').get(id) ?? null;
}

/**
 * Return all suggestion titles that were previously generated for a project.
 * Includes: (a) selected_json from the current accepted plan so the AI avoids
 * repeating already-accepted items even on a web re-scan that does not pre-stale;
 * (b) selected_json / suggestions_json from the last 5 stale rows.
 * Used by the AI scanner to avoid repeating suggestions on re-suggest.
 * @param {string} project
 * @returns {string[]}
 */
export function getEarlierSuggestionTitles(project) {
  const db = getDb();
  const titles = new Set();

  // Include the currently-accepted plan's selected titles so web re-scans that
  // don't pre-stale the accepted row still have the right avoid-list.
  const accepted = db.prepare(
    "SELECT selected_json FROM suggestions WHERE project = ? AND status = 'accepted' LIMIT 1",
  ).get(project);
  if (accepted?.selected_json) {
    try {
      const list = JSON.parse(accepted.selected_json || '[]');
      for (const s of list) { if (s.title) titles.add(s.title); }
    } catch { /* best-effort */ }
  }

  // Fetch both selected_json (accepted-then-staled rows) and suggestions_json (staled draft rows).
  // Staled draft rows have selected_json=NULL but suggestions_json holds the full generated list;
  // reading both ensures repeated re-scans inform the AI dedup history even when no plan was accepted.
  const rows = db.prepare(`
    SELECT selected_json, suggestions_json FROM suggestions
    WHERE project = ? AND status = 'stale'
    ORDER BY id DESC LIMIT 5
  `).all(project);
  for (const row of rows) {
    try {
      if (row.selected_json != null) {
        const list = JSON.parse(row.selected_json || '[]');
        for (const s of list) { if (s.title) titles.add(s.title); }
      } else if (row.suggestions_json != null) {
        const list = JSON.parse(row.suggestions_json || '[]');
        for (const s of list) { if (s.title) titles.add(s.title); }
      }
    } catch { /* best-effort */ }
  }
  return [...titles];
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/**
 * Prevent another request/timer in this process from lazily reopening the old
 * SQLite inode while nas-sync atomically replaces it. The suspension window is
 * intentionally tiny and callers must release it in finally.
 */
export function suspendDbAccess(reason = 'state database replacement') {
  if (_dbSuspensionReason) {
    const err = new Error(`SQLite state access is already suspended: ${_dbSuspensionReason}`);
    err.code = 'STATE_DB_SUSPENDED';
    throw err;
  }
  _dbSuspensionReason = String(reason);
  closeDb();
}

export function resumeDbAccess() {
  _dbSuspensionReason = null;
}

// ─── Provider/account circuit breaker ───────────────────────────────────────

function normalizeBreakerScope(provider, account) {
  return {
    provider: String(provider || 'anthropic').trim() || 'anthropic',
    account: String(account || 'default').trim() || 'default',
  };
}

/** Return the persisted breaker row plus whether it is currently open. */
export function getProviderCircuitBreaker(provider, account, { nowMs = Date.now() } = {}) {
  const scope = normalizeBreakerScope(provider, account);
  const row = getDb().prepare(`
    SELECT provider, account, blocked_until, reason, source_project, source_task,
           opened_at, updated_at
    FROM provider_circuit_breakers
    WHERE provider = ? AND account = ?
  `).get(scope.provider, scope.account);
  if (!row) return null;
  const blockedUntilMs = Date.parse(row.blocked_until);
  return {
    ...row,
    blocked_until_ms: Number.isFinite(blockedUntilMs) ? blockedUntilMs : null,
    open: Number.isFinite(blockedUntilMs) && blockedUntilMs > nowMs,
  };
}

/**
 * Open/extend a provider breaker atomically. A concurrent, shorter cooldown
 * can never shorten a longer authoritative reset timestamp already recorded.
 */
export function tripProviderCircuitBreaker({
  provider, account, blockedUntilMs, reason = null, project = null, task = null,
  nowMs = Date.now(),
}) {
  const scope = normalizeBreakerScope(provider, account);
  if (!Number.isFinite(blockedUntilMs) || blockedUntilMs <= nowMs) {
    throw new Error('tripProviderCircuitBreaker requires a future blockedUntilMs');
  }
  const nowIso = new Date(nowMs).toISOString();
  const blockedUntilIso = new Date(blockedUntilMs).toISOString();
  getDb().prepare(`
    INSERT INTO provider_circuit_breakers (
      provider, account, blocked_until, reason, source_project, source_task,
      opened_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, account) DO UPDATE SET
      blocked_until = CASE
        WHEN excluded.blocked_until > provider_circuit_breakers.blocked_until
          THEN excluded.blocked_until
        ELSE provider_circuit_breakers.blocked_until
      END,
      reason = CASE
        WHEN excluded.blocked_until >= provider_circuit_breakers.blocked_until
          THEN excluded.reason
        ELSE provider_circuit_breakers.reason
      END,
      source_project = CASE
        WHEN excluded.blocked_until >= provider_circuit_breakers.blocked_until
          THEN excluded.source_project
        ELSE provider_circuit_breakers.source_project
      END,
      source_task = CASE
        WHEN excluded.blocked_until >= provider_circuit_breakers.blocked_until
          THEN excluded.source_task
        ELSE provider_circuit_breakers.source_task
      END,
      updated_at = excluded.updated_at
  `).run(
    scope.provider, scope.account, blockedUntilIso, reason ? String(reason).slice(0, 1000) : null,
    project || null, task || null, nowIso, nowIso,
  );
  return getProviderCircuitBreaker(scope.provider, scope.account, { nowMs });
}

/** Explicit operator/test reset. Expired rows need no cleanup to stop gating. */
export function clearProviderCircuitBreaker(provider, account) {
  const scope = normalizeBreakerScope(provider, account);
  return getDb().prepare(
    'DELETE FROM provider_circuit_breakers WHERE provider = ? AND account = ?',
  ).run(scope.provider, scope.account).changes > 0;
}

/**
 * Upsert the latest provider window observation for (provider, account,
 * rate_limit_type). Sync, never-throwing — called from the hot stream-event
 * path on every rate_limit_event.
 */
export function recordProviderWindowObservation({
  provider, account, rateLimitType, status = null, utilization = null,
  resetsAtMs = null, observedAtMs = Date.now(),
}) {
  try {
    const scope = normalizeBreakerScope(provider, account);
    getDb().prepare(`
      INSERT INTO provider_window_observations
        (provider, account, rate_limit_type, status, utilization, resets_at_ms, observed_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, account, rate_limit_type) DO UPDATE SET
        status = excluded.status, utilization = excluded.utilization,
        resets_at_ms = excluded.resets_at_ms, observed_at_ms = excluded.observed_at_ms
    `).run(scope.provider, scope.account, String(rateLimitType || 'unknown'),
      status, Number.isFinite(utilization) ? utilization : null,
      Number.isFinite(resetsAtMs) ? resetsAtMs : null, observedAtMs);
  } catch (err) {
    console.warn(`[state] recordProviderWindowObservation failed (non-fatal): ${err.message}`);
  }
}

/** Latest observation for one window type, or null. */
export function getProviderWindowObservation(provider, account, rateLimitType) {
  try {
    const scope = normalizeBreakerScope(provider, account);
    return getDb().prepare(
      'SELECT * FROM provider_window_observations WHERE provider = ? AND account = ? AND rate_limit_type = ?',
    ).get(scope.provider, scope.account, String(rateLimitType)) || null;
  } catch {
    return null;
  }
}

// ─── Provider/account heavy-call lease ──────────────────────────────────────

/**
 * Join the provider/account FIFO and atomically claim one active lease slot.
 * Reusing the same token is idempotent across polling iterations.
 */
export function tryAcquireProviderCallLease({
  provider, account, token, owner, project = null, task = null, pid = null,
  maxConcurrent = 1, ttlMs, waiterTtlMs = ttlMs, waitUntilMs, nowMs = Date.now(),
}) {
  if (!token || !owner) throw new Error('provider call lease requires token and owner');
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('provider call lease requires ttlMs > 0');
  if (!Number.isFinite(waiterTtlMs) || waiterTtlMs <= 0) {
    throw new Error('provider call lease requires waiterTtlMs > 0');
  }
  const scope = normalizeBreakerScope(provider, account);
  const capacity = Math.max(1, Math.trunc(Number(maxConcurrent) || 1));
  const db = getDb();
  const nowIso = new Date(nowMs).toISOString();

  if (!Number.isFinite(waitUntilMs) || waitUntilMs <= nowMs) {
    db.prepare('DELETE FROM provider_call_leases WHERE token = ? AND owner = ?').run(token, owner);
    return { acquired: false, timed_out: true, position: null, active: null, capacity };
  }

  const waitUntilIso = new Date(waitUntilMs).toISOString();
  const leaseUntilIso = new Date(nowMs + ttlMs).toISOString();
  const waiterStaleBeforeIso = new Date(nowMs - waiterTtlMs).toISOString();
  const acquire = db.transaction(() => {
    // Crash/stall recovery is part of the same IMMEDIATE transaction as the
    // capacity check, so two processes cannot both reclaim/count/insert slot 1.
    // Reaping is scoped to THIS (provider, account) — capacity/position are
    // counted per-scope, so a caller must only reap its own scope. Critically,
    // the stale-WAITER cut uses this caller's waiterTtlMs; applying it to a
    // foreign scope (which may run a longer TTL) would prematurely evict that
    // scope's waiters and starve its FIFO.
    db.prepare(`
      DELETE FROM provider_call_leases
      WHERE provider = ? AND account = ?
        AND state = 'active' AND (lease_until IS NULL OR lease_until <= ?)
    `).run(scope.provider, scope.account, nowIso);
    db.prepare(`
      DELETE FROM provider_call_leases
      WHERE provider = ? AND account = ?
        AND state = 'waiting' AND (wait_until <= ? OR updated_at <= ?)
    `).run(scope.provider, scope.account, nowIso, waiterStaleBeforeIso);

    db.prepare(`
      INSERT INTO provider_call_leases (
        token, provider, account, owner, state, project, task, pid,
        requested_at, acquired_at, lease_until, wait_until, updated_at
      ) VALUES (?, ?, ?, ?, 'waiting', ?, ?, ?, ?, NULL, NULL, ?, ?)
      ON CONFLICT(token) DO NOTHING
    `).run(
      token, scope.provider, scope.account, owner, project || null, task || null,
      Number.isInteger(pid) ? pid : null, nowIso, waitUntilIso, nowIso,
    );

    // Polling is the waiting-ticket heartbeat. A process that dies before it
    // acquires cannot remain at the FIFO head for the full admission timeout;
    // another claimant reaps it after waiterTtlMs. requested_at stays fixed so
    // a healthy waiter keeps its place.
    db.prepare(`
      UPDATE provider_call_leases SET updated_at = ?
      WHERE token = ? AND owner = ? AND state = 'waiting'
    `).run(nowIso, token, owner);

    const own = db.prepare('SELECT * FROM provider_call_leases WHERE token = ?').get(token);
    if (!own) return { acquired: false, timed_out: true, position: null, active: null, capacity };
    if (own.owner !== owner || own.provider !== scope.provider || own.account !== scope.account) {
      throw new Error('provider call lease token collision');
    }
    if (own.state === 'active') {
      return {
        acquired: true, timed_out: false, position: 0, capacity,
        active: db.prepare(`
          SELECT COUNT(*) AS n FROM provider_call_leases
          WHERE provider = ? AND account = ? AND state = 'active'
        `).get(scope.provider, scope.account).n,
        lease: own,
      };
    }

    const active = db.prepare(`
      SELECT COUNT(*) AS n FROM provider_call_leases
      WHERE provider = ? AND account = ? AND state = 'active'
    `).get(scope.provider, scope.account).n;
    const position = db.prepare(`
      SELECT COUNT(*) AS n FROM provider_call_leases
      WHERE provider = ? AND account = ? AND state = 'waiting'
        AND (requested_at < ? OR (requested_at = ? AND token <= ?))
    `).get(scope.provider, scope.account, own.requested_at, own.requested_at, token).n;

    if (active < capacity && position <= (capacity - active)) {
      db.prepare(`
        UPDATE provider_call_leases
        SET state = 'active', acquired_at = ?, lease_until = ?, updated_at = ?
        WHERE token = ? AND owner = ? AND state = 'waiting'
      `).run(nowIso, leaseUntilIso, nowIso, token, owner);
      const lease = db.prepare('SELECT * FROM provider_call_leases WHERE token = ?').get(token);
      return { acquired: true, timed_out: false, position: 0, active: active + 1, capacity, lease };
    }

    return { acquired: false, timed_out: false, position, active, capacity, lease: own };
  });

  return acquire.immediate();
}

/** Extend an active lease heartbeat. False means the lease was lost/reclaimed. */
export function renewProviderCallLease({ token, owner, ttlMs, nowMs = Date.now() }) {
  if (!token || !owner || !Number.isFinite(ttlMs) || ttlMs <= 0) return false;
  const result = getDb().prepare(`
    UPDATE provider_call_leases
    SET lease_until = ?, updated_at = ?
    WHERE token = ? AND owner = ? AND state = 'active'
  `).run(new Date(nowMs + ttlMs).toISOString(), new Date(nowMs).toISOString(), token, owner);
  return result.changes === 1;
}

/** Release either a waiting ticket or an active lease; owner prevents theft. */
export function releaseProviderCallLease({ token, owner }) {
  if (!token || !owner) return false;
  return getDb().prepare(
    'DELETE FROM provider_call_leases WHERE token = ? AND owner = ?',
  ).run(token, owner).changes === 1;
}

export function listProviderCallLeases(provider, account) {
  const scope = normalizeBreakerScope(provider, account);
  return getDb().prepare(`
    SELECT * FROM provider_call_leases
    WHERE provider = ? AND account = ?
    ORDER BY CASE state WHEN 'active' THEN 0 ELSE 1 END, requested_at, token
  `).all(scope.provider, scope.account);
}

/** Hot-path-safe cancellation probe used by an in-flight Claude subprocess. */
export function isQueueJobCancellationRequested(jobId) {
  if (!Number.isInteger(Number(jobId))) return false;
  const row = getDb().prepare(
    'SELECT cancel_requested_at FROM tg_jobs WHERE id = ?',
  ).get(Number(jobId));
  return Boolean(row?.cancel_requested_at);
}

// ─── Running jobs mutex ───────────────────────────────────────────────────────
// Cross-process lock: one live autoRun per project at a time.
// INSERT OR FAIL semantics — plain INSERT throws on UNIQUE constraint violation.

export function claimRunningJob(project, pid) {
  const db = getDb();
  db.transaction(() => {
    if (db.prepare(`SELECT deleted_at FROM project_tombstones WHERE project = ?`).get(project)) {
      const err = new Error(`Project '${project}' is being deleted; refusing to start work`);
      err.code = 'PROJECT_DELETING';
      throw err;
    }
    db.prepare(
      `INSERT INTO running_jobs (project, pid, started_at) VALUES (?, ?, ?)`,
    ).run(project, pid, new Date().toISOString());
  }).immediate();
}

export function releaseRunningJob(project) {
  getDb().prepare(`DELETE FROM running_jobs WHERE project = ?`).run(project);
}

export function getRunningJob(project) {
  return getDb().prepare(`SELECT * FROM running_jobs WHERE project = ?`).get(project);
}

// Phase 54 (par-07): every live running_jobs claim, across all projects. Named
// plural to distinguish it from server/job-queue.js's own listRunningJobs()
// (which lists tg_jobs rows, a different table). fairShareStatus reads these,
// keeps the pidAlive() ones, and always folds in the asking project to size the
// active set that shares the billing window.
export function getRunningJobs() {
  return getDb().prepare(`SELECT * FROM running_jobs`).all();
}

// ─── Pending confirmations (requireConfirmation gate) ─────────────────────────
// Source of truth for the human-in-the-loop gate. The poll loop in
// require-confirmation.js reads getPendingConfirmation(id); the Telegram cf:*
// handler (or CLI readline) resolves the row by nonce. Same-process, single
// better-sqlite3 connection — a resolve is visible to the very next poll read.

export function createPendingConfirmation({ action, project = null, summary = '', options, defaultOption = null, ttlMs = null }) {
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error('createPendingConfirmation: options must be a non-empty array');
  }
  const nonce = randomBytes(4).toString('hex'); // 8 hex chars, 32-bit
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = ttlMs != null ? new Date(now + ttlMs).toISOString() : null;
  const info = getDb().prepare(`
    INSERT INTO pending_confirmations
      (nonce, action, project, summary, options_json, default_option, status, ttl_ms, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).run(
    nonce, action, project ?? null, summary ?? '',
    JSON.stringify(options), defaultOption ?? null, ttlMs ?? null, createdAt, expiresAt,
  );
  return { id: Number(info.lastInsertRowid), nonce, expiresAt };
}

export function getPendingConfirmation(id) {
  return getDb().prepare('SELECT * FROM pending_confirmations WHERE id = ?').get(id) ?? null;
}

export function getPendingConfirmationByNonce(nonce) {
  return getDb().prepare('SELECT * FROM pending_confirmations WHERE nonce = ?').get(nonce) ?? null;
}

/**
 * Resolve a still-pending row to chosenOption. Returns the updated row, or null
 * when the nonce is unknown or the row is already resolved/expired — so a late
 * or double Telegram tap (or a tap after TTL expiry) is a safe no-op.
 */
export function resolvePendingConfirmation(nonce, chosenOption, resolvedBy = null) {
  const db = getDb();
  const info = db.prepare(`
    UPDATE pending_confirmations
       SET status = 'resolved', chosen_option = ?, resolved_by = ?, resolved_at = ?
     WHERE nonce = ? AND status = 'pending'
  `).run(chosenOption, resolvedBy ?? null, new Date().toISOString(), nonce);
  if (info.changes === 0) return null;
  return getPendingConfirmationByNonce(nonce);
}

/** Mark a still-pending row expired (TTL elapsed). No-op if already settled. */
export function expirePendingConfirmation(id) {
  const info = getDb().prepare(`
    UPDATE pending_confirmations SET status = 'expired', resolved_at = ?
     WHERE id = ? AND status = 'pending'
  `).run(new Date().toISOString(), id);
  return info.changes > 0;
}

/**
 * Bulk-expire pending rows whose expires_at has passed — housekeeping for rows
 * orphaned by a crash mid-wait. Indefinite rows (expires_at IS NULL) are never
 * swept. Returns the number of rows expired.
 */
export function expireStalePendingConfirmations(nowIso = new Date().toISOString()) {
  const info = getDb().prepare(`
    UPDATE pending_confirmations SET status = 'expired', resolved_at = ?
     WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?
  `).run(nowIso, nowIso);
  return info.changes;
}

// ─── Discussion brief-pending flag ────────────────────────────────────────────
// Set by the "Accept Brief Only" gate option (Phase 13). Stores the discussion
// id whose conclusions were appended to the brief and await operator review.

export function setDiscussBriefPending(project, discId) {
  getDb().prepare('UPDATE projects SET discuss_brief_pending = ? WHERE name = ?').run(discId ?? null, project);
}

export function getDiscussBriefPending(project) {
  const row = getDb().prepare('SELECT discuss_brief_pending FROM projects WHERE name = ?').get(project);
  return row?.discuss_brief_pending ?? null;
}

export function clearDiscussBriefPending(project) {
  getDb().prepare('UPDATE projects SET discuss_brief_pending = NULL WHERE name = ?').run(project);
}

// ─── Discussions ─────────────────────────────────────────────────────────────

export function createDiscussion({ project, topic, mode = 'auto', rounds_planned = 2 }) {
  const result = getDb().prepare(
    `INSERT INTO discussions (project, topic, mode, status, rounds_planned)
     VALUES (?, ?, ?, 'pending', ?)`,
  ).run(project, topic, mode, rounds_planned);
  return result.lastInsertRowid;
}

export function updateDiscussionStatus(id, status) {
  const extra = status === 'done' ? `, completed_at = datetime('now')` : '';
  getDb().prepare(`UPDATE discussions SET status = ?${extra} WHERE id = ?`).run(status, id);
}

export function getDiscussion(id) {
  return getDb().prepare('SELECT * FROM discussions WHERE id = ?').get(id) ?? null;
}

export function listDiscussions(project, limit = 20) {
  return getDb().prepare(
    'SELECT * FROM discussions WHERE project = ? ORDER BY created_at DESC LIMIT ?',
  ).all(project, limit);
}

export function saveDiscAgent({ disc_id, agent_key, role, expertise, mission, system_prompt }) {
  const result = getDb().prepare(
    `INSERT INTO disc_agents (disc_id, agent_key, role, expertise, mission, system_prompt)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(disc_id, agent_key, role, expertise, mission, system_prompt);
  return result.lastInsertRowid;
}

export function updateDiscAgentSession(id, session_id) {
  getDb().prepare('UPDATE disc_agents SET session_id = ? WHERE id = ?').run(session_id, id);
}

export function getDiscAgents(disc_id) {
  return getDb().prepare('SELECT * FROM disc_agents WHERE disc_id = ? ORDER BY id').all(disc_id);
}

export function saveDiscMessage({ disc_id, agent_key, round, content }) {
  getDb().prepare(
    `INSERT INTO disc_messages (disc_id, agent_key, round, content) VALUES (?, ?, ?, ?)`,
  ).run(disc_id, agent_key, round, typeof content === 'string' ? content : JSON.stringify(content));
}

export function getDiscMessages(disc_id, round = null) {
  if (round != null) {
    return getDb().prepare(
      'SELECT * FROM disc_messages WHERE disc_id = ? AND round = ? ORDER BY id',
    ).all(disc_id, round);
  }
  return getDb().prepare(
    'SELECT * FROM disc_messages WHERE disc_id = ? ORDER BY round, id',
  ).all(disc_id);
}

export function saveDiscConclusion({ disc_id, synthesis, brief_patch }) {
  getDb().prepare(
    `INSERT INTO disc_conclusions (disc_id, synthesis, brief_patch) VALUES (?, ?, ?)`,
  ).run(disc_id, typeof synthesis === 'string' ? synthesis : JSON.stringify(synthesis), brief_patch);
}

export function getDiscConclusion(disc_id) {
  return getDb().prepare(
    'SELECT * FROM disc_conclusions WHERE disc_id = ? ORDER BY id DESC LIMIT 1',
  ).get(disc_id) ?? null;
}

// ─── Healing Log ─────────────────────────────────────────────────────────────

export function recordHealingAttempt({ project, error_kind, error_message, context_json, strategy }) {
  const result = getDb().prepare(`
    INSERT INTO healing_log (project, error_kind, error_message, context_json, strategy, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(project ?? null, error_kind, (error_message ?? '').slice(0, 500), context_json ?? null, strategy ?? null, new Date().toISOString());
  return result.lastInsertRowid;
}

export function updateHealingStatus(id, status, resolved_at = null) {
  getDb().prepare('UPDATE healing_log SET status = ?, resolved_at = ? WHERE id = ?')
    .run(status, resolved_at ?? null, id);
}

/**
 * Return healing attempts for a project+kind within the last `withinMinutes`.
 * Pass project=null to match orchestrator-level (project IS NULL) rows only.
 */
export function getRecentHealingAttempts(project, error_kind, withinMinutes = 60) {
  const since = new Date(Date.now() - withinMinutes * 60 * 1000).toISOString();
  if (project == null) {
    return getDb().prepare(`
      SELECT * FROM healing_log
      WHERE project IS NULL AND error_kind = ? AND created_at > ?
      ORDER BY created_at DESC
    `).all(error_kind, since);
  }
  return getDb().prepare(`
    SELECT * FROM healing_log
    WHERE project = ? AND error_kind = ? AND created_at > ?
    ORDER BY created_at DESC
  `).all(project, error_kind, since);
}

export function listHealingLog(project, limit = 50) {
  if (project == null) {
    return getDb().prepare('SELECT * FROM healing_log ORDER BY created_at DESC LIMIT ?').all(limit);
  }
  return getDb().prepare('SELECT * FROM healing_log WHERE project = ? ORDER BY created_at DESC LIMIT ?').all(project, limit);
}

/**
 * Count FAILED healing attempts for a project whose error_kind is in `errorKinds`,
 * within the last `withinMinutes`. Powers the auto-runner's proactive
 * network-failure pause (a sustained outage silently burns heal attempts).
 *
 * Indexed: served by idx_healing_log_kind (error_kind, created_at) /
 * idx_healing_log_project (project, created_at). The `since` cutoff is built in
 * JS as an ISO-8601 string so it sorts lexicographically against created_at
 * (also stored via Date.toISOString) — exactly like getRecentHealingAttempts.
 * Do NOT substitute datetime('now',...): its space separator sorts below the
 * stored 'T', silently breaking the range comparison.
 */
export function countRecentFailedHealingByKinds(project, errorKinds, withinMinutes = 30) {
  const kinds = Array.from(new Set(errorKinds || [])).filter((k) => typeof k === 'string' && k);
  if (kinds.length === 0) return 0;
  const since = new Date(Date.now() - withinMinutes * 60 * 1000).toISOString();
  const placeholders = kinds.map(() => '?').join(', ');
  if (project == null) {
    const row = getDb().prepare(`
      SELECT COUNT(*) AS n FROM healing_log
      WHERE project IS NULL AND status = 'failed'
        AND error_kind IN (${placeholders}) AND created_at > ?
    `).get(...kinds, since);
    return row?.n ?? 0;
  }
  const row = getDb().prepare(`
    SELECT COUNT(*) AS n FROM healing_log
    WHERE project = ? AND status = 'failed'
      AND error_kind IN (${placeholders}) AND created_at > ?
  `).get(project, ...kinds, since);
  return row?.n ?? 0;
}

// ─── Chat threads (control-plane chat, v0.16) ───────────────────────────────

export function createChatThread({ title = null, project = null } = {}) {
  const result = getDb().prepare(`
    INSERT INTO chat_threads (title, project, created_at, last_active_at)
    VALUES (?, ?, ?, ?)
  `).run(title, project, new Date().toISOString(), new Date().toISOString());
  return result.lastInsertRowid;
}

export function getChatThread(id) {
  return getDb().prepare('SELECT * FROM chat_threads WHERE id = ?').get(id);
}

export function listChatThreads(limit = 30) {
  return getDb().prepare(`
    SELECT t.*, (SELECT COUNT(*) FROM chat_messages m WHERE m.thread_id = t.id) AS message_count
    FROM chat_threads t ORDER BY t.last_active_at DESC LIMIT ?
  `).all(limit);
}

export function setChatThreadSession(id, sessionId) {
  getDb().prepare('UPDATE chat_threads SET session_id = ? WHERE id = ?').run(sessionId, id);
}

export function setChatThreadProject(id, project) {
  getDb().prepare('UPDATE chat_threads SET project = ? WHERE id = ?').run(project, id);
}

export function setChatThreadTitle(id, title) {
  getDb().prepare('UPDATE chat_threads SET title = ? WHERE id = ?').run(title, id);
}

export function touchChatThread(id) {
  getDb().prepare('UPDATE chat_threads SET last_active_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
}

export function deleteChatThread(id) {
  // chat_messages cascades via FK
  return getDb().prepare('DELETE FROM chat_threads WHERE id = ?').run(id);
}

export function addChatMessage({ thread_id, role, content, meta = null }) {
  const result = getDb().prepare(`
    INSERT INTO chat_messages (thread_id, role, content, meta_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(thread_id, role, content, meta ? JSON.stringify(meta) : null, new Date().toISOString());
  return result.lastInsertRowid;
}

export function listChatMessages(threadId, limit = 200) {
  return getDb().prepare(`
    SELECT * FROM (
      SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?
    ) ORDER BY id ASC
  `).all(threadId, limit);
}

// ─── Chat turn lock (v0.18 — cross-process, replaces per-process _busyThreads) ─
// One in-flight turn per thread, enforced across processes so the auto-healer's
// issue-bridge and the web-UI/CLI engine can never --resume the same session
// concurrently. Returns true iff the lock was acquired. A lock held by a dead
// pid (crashed mid-turn) is reclaimed, same discipline as running_jobs.

// A real chat turn is bounded well under this by runClaude's wall-clock/idle
// watchdogs. Past it, the lock is stale regardless of pidAlive: after days, OS
// pid reuse can make a dead holder's pid "alive" as an unrelated process
// (pidAlive also treats EPERM as alive), permanently bricking the thread —
// and on a nas-sync'd DB the recorded pids belong to another host entirely.
const CHAT_LOCK_TTL_MS = 90 * 60 * 1000;

function chatLockStale(row, nowMs = Date.now()) {
  if (!row) return true;
  const lockedAt = Date.parse(row.locked_at || '');
  if (Number.isFinite(lockedAt) && nowMs - lockedAt > CHAT_LOCK_TTL_MS) return true;
  return !pidAlive(row.pid);
}

export function acquireChatLock(threadId, pid = process.pid) {
  const db = getDb();
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM chat_locks WHERE thread_id = ?').get(threadId);
    if (existing) {
      if (!chatLockStale(existing)) return false;     // a live turn owns it
      db.prepare('DELETE FROM chat_locks WHERE thread_id = ?').run(threadId); // stale — reclaim
    }
    db.prepare('INSERT INTO chat_locks (thread_id, pid, locked_at) VALUES (?, ?, ?)')
      .run(threadId, pid, new Date().toISOString());
    return true;
  })();
}

export function releaseChatLock(threadId) {
  getDb().prepare('DELETE FROM chat_locks WHERE thread_id = ?').run(threadId);
}

export function isChatThreadLocked(threadId) {
  const row = getDb().prepare('SELECT pid, locked_at FROM chat_locks WHERE thread_id = ?').get(threadId);
  return !!(row && !chatLockStale(row));
}

/**
 * Boot-time sweep (same discipline as sweepInterruptedAutoRuns): remove lock
 * rows held by dead or TTL-expired turns so a crashed/restarted holder can
 * never strand a thread. Lazy per-thread reclaim in acquireChatLock still
 * handles the mid-flight case; this keeps the table honest between turns.
 * @returns {number} rows removed
 */
export function sweepStaleChatLocks() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM chat_locks').all();
  let removed = 0;
  for (const row of rows) {
    if (chatLockStale(row)) {
      db.prepare('DELETE FROM chat_locks WHERE thread_id = ?').run(row.thread_id);
      removed += 1;
    }
  }
  return removed;
}

// ─── Detached-spawn ledger (v0.18 — completion signal for fire-and-forget) ────

export function recordDetachedSpawn({ project = null, thread_id = null, action, pid = null, source = null }) {
  const info = getDb().prepare(`
    INSERT INTO detached_spawns (project, thread_id, action, pid, started_at, source)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(project, thread_id, action, pid, new Date().toISOString(), source);
  return info.lastInsertRowid;
}

/** Most recent detached spawn for a project, annotated with pid liveness. */
export function recentDetachedSpawn(project) {
  const row = getDb().prepare(
    'SELECT * FROM detached_spawns WHERE project = ? ORDER BY id DESC LIMIT 1',
  ).get(project);
  if (!row) return null;
  const age_s = Math.round((Date.now() - new Date(row.started_at).getTime()) / 1000);
  return { ...row, alive: pidAlive(row.pid), age_s };
}

// ─── Chat autopilot state (v0.18) ─────────────────────────────────────────────

export function setThreadAutopilot(threadId, { enabled, goal = null } = {}) {
  const db = getDb();
  if (enabled) {
    db.prepare(`
      UPDATE chat_threads
         SET autopilot = 1, autopilot_goal = ?, autopilot_status = 'active',
             autopilot_attempts = 0, autopilot_spend_usd = 0,
             autopilot_next_at = NULL, autopilot_sig = NULL
       WHERE id = ?
    `).run(goal, threadId);
  } else {
    db.prepare(`UPDATE chat_threads SET autopilot = 0, autopilot_status = 'off' WHERE id = ?`)
      .run(threadId);
  }
  return getChatThread(threadId);
}

/** Threads the autopilot loop should consider this tick (on + not terminal). */
export function getAutopilotThreads() {
  return getDb().prepare(`
    SELECT * FROM chat_threads
     WHERE autopilot = 1 AND COALESCE(autopilot_status, 'active') IN ('active', 'waiting')
     ORDER BY id ASC
  `).all();
}

export function setAutopilotStatus(threadId, status) {
  getDb().prepare('UPDATE chat_threads SET autopilot_status = ? WHERE id = ?').run(status, threadId);
}

/** Record that the loop fired a turn: bump attempts + spend, arm the backoff, store the signature. */
export function recordAutopilotTurn(threadId, { spendDelta = 0, nextAt = null, sig = null, status = null, errored = false } = {}) {
  getDb().prepare(`
    UPDATE chat_threads
       SET autopilot_attempts = autopilot_attempts + 1,
           autopilot_spend_usd = autopilot_spend_usd + ?,
           autopilot_next_at = ?,
           autopilot_sig = COALESCE(?, autopilot_sig),
           autopilot_status = COALESCE(?, autopilot_status),
           autopilot_error_streak = CASE WHEN ? THEN autopilot_error_streak + 1 ELSE 0 END
     WHERE id = ?
  `).run(spendDelta || 0, nextAt, sig, status, errored ? 1 : 0, threadId);
}

/** Progress or a human message resets the spin counter (but keeps autopilot on). */
export function resetAutopilotAttempts(threadId, { sig = null } = {}) {
  getDb().prepare(`
    UPDATE chat_threads
       SET autopilot_attempts = 0, autopilot_status = 'active',
           autopilot_error_streak = 0,
           autopilot_sig = COALESCE(?, autopilot_sig)
     WHERE id = ?
  `).run(sig, threadId);
}

// ─── Operator questions (Phase 48 — non-blocking ask_operator MCP tool) ────
//
// A mid-phase dev/fix agent's question + the assumption it proceeded on.
// Always inserted with status 'open'; blocking is stored but never gates
// control flow in v1 (see src/mcp/state-server.mjs's askOperator).

export function addOperatorQuestion({ project, phase = null, question, options = null, assumption, blocking = false }) {
  const now = new Date().toISOString();
  const info = getDb().prepare(
    `INSERT INTO operator_questions (project, phase, question, options, assumption, blocking, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
  ).run(project, phase, question, options ? JSON.stringify(options) : null, assumption, blocking ? 1 : 0, now);
  return info.lastInsertRowid;
}

export function listOperatorQuestions({ project = null, status = null } = {}) {
  const where = [];
  const params = [];
  if (project) { where.push('project = ?'); params.push(project); }
  if (status)  { where.push('status = ?');  params.push(status);  }
  const sql = `SELECT * FROM operator_questions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id ASC`;
  return getDb().prepare(sql).all(...params);
}

export function answerOperatorQuestion(id, { answer, answered_by = null }) {
  const now = new Date().toISOString();
  return getDb().prepare(
    `UPDATE operator_questions SET status = 'answered', answer = ?, answered_by = ?, answered_at = ? WHERE id = ? AND status = 'open'`,
  ).run(answer, answered_by, now, id).changes;
}

/**
 * Compensate a failed decisions.jsonl append. The answered_at/answer fence
 * ensures we never reopen a row that a later resolver legitimately changed.
 */
export function reopenOperatorQuestion(id, { answer, answered_at }) {
  return getDb().prepare(`
    UPDATE operator_questions
       SET status = 'open', answer = NULL, answered_by = NULL, answered_at = NULL
     WHERE id = ? AND status = 'answered' AND answer = ? AND answered_at = ?
  `).run(id, answer, answered_at).changes;
}

export function markOperatorQuestionNotified(id) {
  return getDb().prepare(`UPDATE operator_questions SET notified_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id).changes;
}

// ─── Run events (Phase 57 — append-only per-run timeline) ──────────────────
//
// Documented kind vocabulary, one-line call sites in auto-runner.js:
//   run-started, plan-created, phase-started, dev-completed, dev-failed,
//   reprompt, escalated, heal-attempt, validator-failed, acceptance-pass,
//   acceptance-fail (detail: unmet count), review-verdict (detail: score),
//   fix-started, fix-completed, fix-parked, audit-completed, bugs-promoted
//   (detail: count), checkpoint-pause, budget-pause, run-paused, run-completed.

const RUN_EVENT_DETAIL_MAX_CHARS = 2000; // ~2KB cap (brief-specified)

/**
 * Best-effort, NEVER-THROWING insert — telemetry failure must never fail a
 * run. A missing/undefined runId warns and writes no row (never inserts a
 * garbage run_id); any other failure (locked db, serialization error) is
 * caught and logged, never propagated.
 *
 * @param {number|null|undefined} runId
 * @param {string} kind - one of the documented kinds above
 * @param {{project?: string, phase?: number|null, [x: string]: any}} [ctx]
 *   `project`/`phase` map to their own columns; every other key is folded
 *   into `detail` as a JSON string, truncated to ~2KB. Omitting ctx entirely,
 *   or passing one with no extra keys, stores detail as NULL.
 */
/**
 * Cross-run reprompt budget: how many 'reprompt' events this phase has burned
 * since the current plan was created. The in-run counter is an in-memory Map
 * that every run restart resets — with the watchdog auto-resuming phase-stuck
 * pauses, a phase whose failure survives reprompting looped forever (aoa
 * phase 134: 8 dev attempts across 3 runs, each run granting a fresh budget).
 */
export function countPhaseRepromptsSincePlan(project, phaseN) {
  try {
    const row = getDb().prepare(`
      SELECT COUNT(*) AS n FROM run_events
       WHERE project = ? AND kind = 'reprompt' AND phase = ?
         AND ts > COALESCE((SELECT MAX(ts) FROM run_events WHERE project = ? AND kind = 'plan-created'), '')
    `).get(project, phaseN, project);
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

export function recordRunEvent(runId, kind, ctx = {}) {
  try {
    if (runId == null) {
      console.warn(`[state] recordRunEvent: missing runId for kind '${kind}' — skipping (no row written)`);
      return;
    }
    const { project = null, phase = null, ...detail } = ctx || {};
    let detailStr = null;
    if (Object.keys(detail).length > 0) {
      detailStr = JSON.stringify(detail);
      if (detailStr.length > RUN_EVENT_DETAIL_MAX_CHARS) detailStr = detailStr.slice(0, RUN_EVENT_DETAIL_MAX_CHARS);
    }
    getDb().prepare(`
      INSERT INTO run_events (run_id, project, ts, kind, phase, detail)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(runId, project, new Date().toISOString(), kind, phase, detailStr);
  } catch (err) {
    console.warn(`[state] recordRunEvent failed (non-fatal, kind='${kind}'): ${err.message}`);
  }
}

/** id-ordered timeline for one run. [] for an unknown/legacy run — never throws by construction (plain SELECT). */
export function listRunEvents(runId) {
  return getDb().prepare(`SELECT * FROM run_events WHERE run_id = ? ORDER BY id ASC`).all(runId);
}

// Best-effort retention sweep — mirrors pruneOldCalls's shape, called from
// auto-runner.js's per-run preflight (not the server-wide log-cleanup.js
// sweep) since run_events is scoped to auto_runs, not logs/outputs/calls.
export function pruneOldRunEvents(days) {
  return getDb()
    .prepare(`DELETE FROM run_events WHERE ts < datetime('now', '-' || ? || ' days')`)
    .run(days).changes;
}

// ─── Notify outbox (Phase 58) ───────────────────────────────────────────────
// See migrate()'s notify_outbox CREATE TABLE for why this exists: a bare
// detached CLI launch (web/chat) runs autoRun() with notifier:null, so a
// synchronous, never-throwing queueNotify() insert is the ONLY durable trace
// of a run-lifecycle notice for those launches — server-discord.js's 10s
// delivery loop is the fallback deliverer.

const NOTIFY_OUTBOX_MAX_ATTEMPTS = 5;

/**
 * Queue one notification. Sync, NEVER-THROWING — a telemetry/notify failure
 * must never fail a run. Returns the new row's id, or null if nothing was
 * written (missing text, or a DB error).
 *
 * @param {{project?: string|null, text: string, replyMarkup?: object|null}} args
 * @returns {number|null}
 */
export function queueNotify({ project = null, text, replyMarkup = null } = {}) {
  try {
    if (!text) return null;
    const info = getDb().prepare(`
      INSERT INTO notify_outbox (project, text, reply_markup, created_at, attempts, status)
      VALUES (?, ?, ?, ?, 0, 'pending')
    `).run(project ?? null, text, replyMarkup ? JSON.stringify(replyMarkup) : null, new Date().toISOString());
    return info.lastInsertRowid;
  } catch (err) {
    console.warn(`[state] queueNotify failed (non-fatal): ${err.message}`);
    return null;
  }
}

/** Mark a queued row delivered (the fast path — a live notifier's `notify()` resolved). Never throws. */
export function markOutboxDelivered(id) {
  try {
    if (id == null) return;
    getDb().prepare(`UPDATE notify_outbox SET status = 'delivered', delivered_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  } catch (err) {
    console.warn(`[state] markOutboxDelivered failed (non-fatal, id=${id}): ${err.message}`);
  }
}

/**
 * Record one failed delivery attempt. At `NOTIFY_OUTBOX_MAX_ATTEMPTS` (5)
 * the row flips to `status: 'failed'` and drops out of listPendingOutbox's
 * `pending` filter; below that it stays `pending` for the next tick to
 * retry. Never throws.
 */
export function recordOutboxFailure(id) {
  try {
    if (id == null) return;
    getDb().prepare(`
      UPDATE notify_outbox
      SET attempts = attempts + 1,
          status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE status END
      WHERE id = ?
    `).run(NOTIFY_OUTBOX_MAX_ATTEMPTS, id);
  } catch (err) {
    console.warn(`[state] recordOutboxFailure failed (non-fatal, id=${id}): ${err.message}`);
  }
}

/** Oldest-first pending rows, capped — the delivery loop's per-tick batch. */
export function listPendingOutbox(limit = 20) {
  return getDb().prepare(`SELECT * FROM notify_outbox WHERE status = 'pending' ORDER BY id ASC LIMIT ?`).all(limit);
}

/**
 * Flip pending rows older than `maxAgeHours` to 'failed' (the schema's CHECK
 * has no 'expired' value). A ping about a run from days ago is noise, not a
 * notification: on a host with no live transport (web-ui-only Mac) the outbox
 * accumulates pending rows indefinitely, and the first server-discord start
 * would flood-deliver the entire stale backlog. Called from the delivery tick
 * and from web-ui boot. @returns {number} rows expired
 */
export function expireStaleOutbox(maxAgeHours = 24) {
  try {
    const cutoff = new Date(Date.now() - maxAgeHours * 3600 * 1000).toISOString();
    return getDb().prepare(
      `UPDATE notify_outbox SET status = 'failed' WHERE status = 'pending' AND created_at < ?`,
    ).run(cutoff).changes;
  } catch (err) {
    console.warn(`[state] expireStaleOutbox failed (non-fatal): ${err.message}`);
    return 0;
  }
}

/** Retention: delete terminal (delivered/failed) rows older than `days`. */
export function pruneOldNotifyOutbox(days = 30) {
  try {
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
    return getDb().prepare(
      `DELETE FROM notify_outbox WHERE status IN ('delivered', 'failed') AND created_at < ?`,
    ).run(cutoff).changes;
  } catch (err) {
    console.warn(`[state] pruneOldNotifyOutbox failed (non-fatal): ${err.message}`);
    return 0;
  }
}

/** Every row (any status) inserted after `lastId` — the SSE tick's "new since last poll" read. */
export function listOutboxSince(lastId) {
  return getDb().prepare(`SELECT * FROM notify_outbox WHERE id > ? ORDER BY id ASC`).all(lastId);
}

/** Current high-water mark — the SSE tick's starting cursor on first connect. */
export function getMaxOutboxId() {
  return getDb().prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM notify_outbox`).get().m;
}

// ─── Autopilot scheduler state (Phase 86 — Portfolio autopilot P7b) ───────────
// The restart-safe cursor the nightly scheduler (src/lib/portfolio-autopilot.js
// startAutopilot) reads to guarantee at-most-once-per-night planning and a
// once-per-day morning digest. See migrate()'s `autopilot` table.

/** The singleton scheduler-state row (all-null default when the row is absent). */
export function getAutopilotState() {
  const row = getDb().prepare(`SELECT * FROM autopilot WHERE id = 1`).get();
  return row || {
    id: 1, last_planned_date: null, last_planned_at: null,
    last_plan_json: null, last_digest_date: null, last_digest_at: null,
  };
}

/** Stamp the night's plan+execute pass (calendar day + ISO time + result snapshot). */
export function recordAutopilotPlanned({ date, at, planJson = null }) {
  getDb().prepare(`
    INSERT INTO autopilot (id, last_planned_date, last_planned_at, last_plan_json)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      last_planned_date = excluded.last_planned_date,
      last_planned_at   = excluded.last_planned_at,
      last_plan_json    = excluded.last_plan_json
  `).run(date ?? null, at ?? null, planJson ?? null);
}

/** Stamp the morning digest (calendar day + ISO time). */
export function recordAutopilotDigest({ date, at }) {
  getDb().prepare(`
    INSERT INTO autopilot (id, last_digest_date, last_digest_at)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      last_digest_date = excluded.last_digest_date,
      last_digest_at   = excluded.last_digest_at
  `).run(date ?? null, at ?? null);
}

// Digest source readers — every row since the night's plan timestamp. Each is a
// plain since-cutoff SELECT; the digest composer (autopilot-digest.js) classifies
// them into ran / finished / paused sections.
export function listAutoRunsSince(sinceIso) {
  return getDb().prepare(`SELECT * FROM auto_runs WHERE started_at >= ? ORDER BY started_at ASC`).all(sinceIso);
}
export function listHealingLogSince(sinceIso) {
  return getDb().prepare(`SELECT * FROM healing_log WHERE created_at >= ? ORDER BY created_at ASC`).all(sinceIso);
}
export function listJobsSince(sinceIso) {
  return getDb().prepare(`SELECT * FROM tg_jobs WHERE requested_at >= ? ORDER BY id ASC`).all(sinceIso);
}

// ─── Live progress (Phase 59) ───────────────────────────────────────────────
// One row per project describing the IN-FLIGHT claude spawn. Written by
// claude-runner's stream parser on a >=3s throttle (upsertLiveProgress) and
// removed in runClaude's cleanup paths (deleteLiveProgress). Reads — the web-ui
// SSE loop, the get_live_progress chat tool, buildContextSnapshot — are
// cross-process-safe thanks to WAL. Every writer is best-effort NEVER-THROWING:
// live telemetry must never fail a run.

/**
 * UPSERT the single live_progress row for `row.project`. Sync, never-throwing.
 * `files_touched` accepts an array (JSON-encoded + capped here) or a
 * pre-encoded string. No-op when project is falsy (a CLI/no-project spawn owns
 * no row). Called at most every ~3s per spawn (the ProgressTracker throttle),
 * so better-sqlite3's per-connection statement cache keeps this to one compiled
 * prepared statement on the hot path.
 *
 * @param {Object} row - a ProgressTracker snapshot (project + telemetry fields)
 */
export function upsertLiveProgress(row = {}) {
  try {
    const project = row.project;
    if (!project) return;
    const files = Array.isArray(row.files_touched)
      ? JSON.stringify(row.files_touched.slice(0, 50))
      : (typeof row.files_touched === 'string' ? row.files_touched : null);
    getDb().prepare(`
      INSERT INTO live_progress
        (project, pid, task, phase, model, turns, max_turns, current_tool,
         current_tool_started_at, files_touched, last_text, started_at, eta_ms, updated_at)
      VALUES
        (@project, @pid, @task, @phase, @model, @turns, @max_turns, @current_tool,
         @current_tool_started_at, @files_touched, @last_text, @started_at, @eta_ms, @updated_at)
      ON CONFLICT(project) DO UPDATE SET
        pid = excluded.pid, task = excluded.task, phase = excluded.phase, model = excluded.model,
        turns = excluded.turns, max_turns = excluded.max_turns, current_tool = excluded.current_tool,
        current_tool_started_at = excluded.current_tool_started_at, files_touched = excluded.files_touched,
        last_text = excluded.last_text, started_at = excluded.started_at, eta_ms = excluded.eta_ms,
        updated_at = excluded.updated_at
    `).run({
      project,
      pid: Number.isFinite(row.pid) ? row.pid : null,
      task: row.task ?? null,
      phase: Number.isFinite(row.phase) ? row.phase : null,
      model: row.model ?? null,
      turns: Number.isFinite(row.turns) ? row.turns : null,
      max_turns: Number.isFinite(row.max_turns) ? row.max_turns : null,
      current_tool: row.current_tool ?? null,
      current_tool_started_at: Number.isFinite(row.current_tool_started_at) ? row.current_tool_started_at : null,
      files_touched: files,
      last_text: row.last_text ?? null,
      started_at: Number.isFinite(row.started_at) ? row.started_at : null,
      eta_ms: Number.isFinite(row.eta_ms) ? row.eta_ms : null,
      updated_at: Number.isFinite(row.updated_at) ? row.updated_at : Date.now(),
    });
  } catch (err) {
    console.warn(`[state] upsertLiveProgress failed (non-fatal): ${err.message}`);
  }
}

/** Remove the live_progress row for `project` (run ended / failed / retrying). Never throws. */
/**
 * Boot-time sweep: remove live_progress rows whose recording pid is dead or
 * whose updated_at is stale. The table's contract ("a completed / failed /
 * retried run never leaves a ghost row") only holds for clean exits — a
 * crashed orchestrator strands its row forever, and the dashboard shows a
 * week-old "live" spinner. @returns {number} rows removed
 */
export function sweepStaleLiveProgress({ maxAgeMinutes = 10 } = {}) {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT project, pid, updated_at FROM live_progress').all();
    let removed = 0;
    for (const row of rows) {
      const updatedAt = Number(row.updated_at); // epoch ms (see table DDL)
      const stale = !pidAlive(row.pid)
        || (Number.isFinite(updatedAt) && updatedAt > 0 && Date.now() - updatedAt > maxAgeMinutes * 60 * 1000);
      if (stale) {
        db.prepare('DELETE FROM live_progress WHERE project = ?').run(row.project);
        removed += 1;
      }
    }
    return removed;
  } catch (err) {
    console.warn(`[state] sweepStaleLiveProgress failed (non-fatal): ${err.message}`);
    return 0;
  }
}

export function deleteLiveProgress(project) {
  try {
    if (!project) return;
    getDb().prepare('DELETE FROM live_progress WHERE project = ?').run(project);
  } catch (err) {
    console.warn(`[state] deleteLiveProgress failed (non-fatal): ${err.message}`);
  }
}

/**
 * Read the live_progress row for `project`, with files_touched decoded to an
 * array. Returns null when no row exists (idle). Plain read, but wrapped so a
 * malformed files_touched JSON can never throw at a call site.
 */
export function getLiveProgress(project) {
  try {
    if (!project) return null;
    const row = getDb().prepare('SELECT * FROM live_progress WHERE project = ?').get(project);
    if (!row) return null;
    let files = [];
    try { files = row.files_touched ? JSON.parse(row.files_touched) : []; } catch { files = []; }
    return { ...row, files_touched: Array.isArray(files) ? files : [] };
  } catch {
    return null;
  }
}

/**
 * Historical mean successful-call duration for a (model, task) pair — the
 * historical half of the live-progress ETA blend. null when there is no prior
 * successful sample (a legacy/first run just uses the observed turn rate).
 */
export function avgCallDurationMs(model, task) {
  try {
    if (!model || !task) return null;
    const r = getDb().prepare(
      `SELECT AVG(duration_ms) AS avg FROM calls
       WHERE model = ? AND task = ? AND is_error = 0 AND duration_ms IS NOT NULL`,
    ).get(model, task);
    return (r && Number.isFinite(r.avg)) ? r.avg : null;
  } catch {
    return null;
  }
}

// ─── Verify results / quality report (Phase 60 — P4) ───────────────────────

/**
 * Insert one verify_results row from an already-decided checker verdict.
 * Best-effort, NEVER-THROWING — a persisted .guide verdict file must never be
 * undone by a telemetry failure. `run_id` is out of scope at verify-loop.js's
 * persist site and is always NULL (P1's run_events carries run linkage
 * instead); callers pass the counts straight from the parsed verdict object.
 */
export function recordVerifyResult({ project, phase, run_id = null, verdict, criteria_met = null, criteria_unmet = null, unverifiable = null }) {
  try {
    getDb().prepare(`
      INSERT INTO verify_results (project, phase, run_id, verdict, criteria_met, criteria_unmet, unverifiable, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(project, phase, run_id ?? null, verdict, criteria_met, criteria_unmet, unverifiable, new Date().toISOString());
  } catch (err) {
    console.warn(`[state] recordVerifyResult failed (non-fatal): ${err.message}`);
  }
}

/**
 * Best-effort UPDATE of found_count on an existing bug_rounds row. A no-op
 * (never throws) when the row doesn't exist yet — startBugRound's own
 * found_count param is the write that lands the count when promote happens
 * before the round's SQL row exists (the common case for the auto-detected
 * chain); this is the companion write for when the row is already there
 * (e.g. an append/re-promote into an existing round).
 */
export function setBugRoundFoundCount(project, round, foundCount) {
  try {
    if (foundCount == null) return;
    getDb().prepare(`UPDATE bug_rounds SET found_count = ? WHERE project = ? AND round = ?`)
      .run(foundCount, project, round);
  } catch (err) {
    console.warn(`[state] setBugRoundFoundCount failed (non-fatal): ${err.message}`);
  }
}

/**
 * Quality report: acceptance first-pass rate, per-task escalation % + avg
 * turns vs cap, bug-round convergence (found_count series), and 7d-vs-30d
 * cache-hit trend per task. Every section div-by-zero-guards to null/0
 * instead of NaN/Infinity, mirroring getSpendReport's guard discipline.
 * Read-only. `days` clamps like getSpendReport (1..365, default 30) and
 * scopes the acceptance + task sections; the cache trend section always
 * compares a fixed trailing 7d vs 30d window (independent of `days`, per the
 * brief's "7- vs 30-day" wording); bug_rounds convergence is unwindowed —
 * full round history, matching listBugRounds().
 *
 * @param {{project: string, days?: number}} o
 */
function roundMetric(value, places = 1) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const power = 10 ** places;
  return Math.round(Number(value) * power) / power;
}

/** Zero-LLM compiler effectiveness and safety report. Token values are proxies. */
export function getContextCompilerReport({ project, days = 30 } = {}) {
  const db = getDb();
  const d = Math.max(1, Math.min(365, Number(days) || 30));
  const since = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
  const events = db.prepare(`
    SELECT * FROM context_compile_events WHERE project = ? AND started_at >= ? ORDER BY id DESC
  `).all(project, since);
  const artifacts = db.prepare(`
    SELECT * FROM context_manifests WHERE project = ? AND generated_at >= ? ORDER BY generated_at DESC
  `).all(project, since);
  const calls = db.prepare(`
    SELECT id, session_id, phase, task, model, num_turns, max_turns,
           routing_tier, attempt, is_error,
           input_tokens, cache_read_tokens, cache_creation_tokens,
           context_manifest_id, context_provider, context_mode, context_injected_tokens
    FROM calls
    WHERE project = ? AND started_at >= ? AND context_manifest_id IS NOT NULL
    ORDER BY id ASC
  `).all(project, since);

  const measured = artifacts.filter((row) => row.precision != null && row.recall != null);
  const average = (rows, field) => rows.length
    ? rows.reduce((sum, row) => sum + Number(row[field] || 0), 0) / rows.length
    : null;
  const percentAverage = (rows, field) => {
    const value = average(rows, field);
    return value == null ? null : roundMetric(value * 100, 1);
  };
  const taskKinds = new Map();
  for (const row of measured) {
    const bucket = taskKinds.get(row.task_kind) || [];
    bucket.push(row);
    taskKinds.set(row.task_kind, bucket);
  }

  const modeMap = new Map();
  const providerMap = new Map();
  const oneTimeSeen = new Set();
  let injectedPromptTokens = 0;
  let replayExposureTokens = 0;
  const contextWork = (row) => Number(row.input_tokens || 0) + Number(row.cache_read_tokens || 0) + Number(row.cache_creation_tokens || 0);
  for (const row of calls) {
    const mode = row.context_mode || 'unknown';
    const bucket = modeMap.get(mode) || { mode, calls: 0, errors: 0, prompt_tokens_est: 0, turns: 0 };
    bucket.calls += 1;
    bucket.errors += row.is_error ? 1 : 0;
    bucket.turns += Number(row.num_turns || 0);
    const injection = Number(row.context_injected_tokens || 0);
    const injectionKey = `${row.session_id || `call:${row.id}`}|${row.context_manifest_id}`;
    if (!oneTimeSeen.has(injectionKey)) {
      oneTimeSeen.add(injectionKey);
      bucket.prompt_tokens_est += injection;
      injectedPromptTokens += injection;
    }
    replayExposureTokens += injection * Math.max(Number(row.num_turns || 0), 1);
    modeMap.set(mode, bucket);
    const provider = row.context_provider || 'unknown';
    providerMap.set(provider, (providerMap.get(provider) || 0) + 1);
  }

  // Compare complete execution workloads rather than cherry-picking successful
  // individual calls. A workload is one task/model/mode within a resumed
  // session + phase + attempt + manifest. This folds max-turn continuations
  // and errored calls into the same amount of work the operator actually paid.
  // routing_tier is the best persisted phase-complexity proxy; legacy rows fall
  // back to their resolved max-turn cap, then an explicit unknown bucket.
  const complexityProxy = (row) => row.routing_tier
    ? `routing:${row.routing_tier}`
    : Number.isFinite(Number(row.max_turns)) && Number(row.max_turns) > 0
      ? `turn-cap:${Number(row.max_turns)}`
      : 'unknown';
  const workloadsByKey = new Map();
  for (const row of calls) {
    const mode = row.context_mode || 'unknown';
    const proxy = complexityProxy(row);
    const cohortKey = JSON.stringify([row.task || 'unknown', row.model || 'unknown', proxy]);
    const executionKey = JSON.stringify([
      row.session_id || `call:${row.id}`,
      row.phase ?? null,
      row.attempt ?? null,
      row.context_manifest_id || null,
    ]);
    const key = `${mode}\u0000${cohortKey}\u0000${executionKey}`;
    const workload = workloadsByKey.get(key) || {
      mode,
      cohort_key: cohortKey,
      calls: 0,
      error_calls: 0,
      context_work_tokens: 0,
      attempt: row.attempt ?? null,
    };
    workload.calls += 1;
    workload.error_calls += row.is_error ? 1 : 0;
    workload.context_work_tokens += contextWork(row);
    workloadsByKey.set(key, workload);
  }
  const workloads = [...workloadsByKey.values()];
  const shadowByCohort = new Map();
  for (const workload of workloads.filter((item) => item.mode === 'shadow')) {
    const values = shadowByCohort.get(workload.cohort_key) || [];
    values.push(workload);
    shadowByCohort.set(workload.cohort_key, values);
  }
  const matched = workloads.filter((workload) => ['assist', 'enforce'].includes(workload.mode)
    && shadowByCohort.has(workload.cohort_key));
  let baselineTotal = 0;
  let actualTotal = 0;
  const matchedCohorts = new Set();
  for (const workload of matched) {
    const baselines = shadowByCohort.get(workload.cohort_key);
    baselineTotal += baselines.reduce((sum, item) => sum + item.context_work_tokens, 0) / baselines.length;
    actualTotal += workload.context_work_tokens;
    matchedCohorts.add(workload.cohort_key);
  }
  const matchedShadowWorkloads = [...matchedCohorts].flatMap((key) => shadowByCohort.get(key));
  const matchedAssistCallN = matched.reduce((sum, workload) => sum + workload.calls, 0);
  const matchedShadowCallN = matchedShadowWorkloads.reduce((sum, workload) => sum + workload.calls, 0);
  const comparisonErrorCalls = [...matched, ...matchedShadowWorkloads]
    .reduce((sum, workload) => sum + workload.error_calls, 0);
  const comparisonContinuationCalls = [...matched, ...matchedShadowWorkloads]
    .reduce((sum, workload) => sum + Math.max(workload.calls - 1, 0), 0);
  const comparisonRetryWorkloads = [...matched, ...matchedShadowWorkloads]
    .filter((workload) => Number(workload.attempt) > 1).length;
  const enoughComparison = matched.length >= 5 && matchedShadowWorkloads.length >= 5 && baselineTotal > 0;
  const linkedCompiled = new Set(events.filter((event) => event.status === 'compiled' && event.manifest_id).map((event) => event.manifest_id));
  const artifactIds = new Set(artifacts.map((artifact) => artifact.manifest_id));
  const failureTelemetryComplete = events.length > 0
    && artifacts.every((artifact) => linkedCompiled.has(artifact.manifest_id))
    && events.filter((event) => event.status === 'compiled').every((event) => event.manifest_id && artifactIds.has(event.manifest_id));
  const rolloutRow = getContextCompilerRollout(project);

  const modeRows = [...modeMap.values()].map((row) => ({
    mode: row.mode, calls: row.calls, errors: row.errors,
    prompt_tokens_est: row.prompt_tokens_est,
    avg_turns: row.calls ? roundMetric(row.turns / row.calls, 1) : null,
  })).sort((a, b) => b.calls - a.calls || a.mode.localeCompare(b.mode));
  const hasActive = modeRows.some((row) => ['assist', 'enforce'].includes(row.mode));
  return {
    status: events.length === 0 ? 'no-data' : hasActive ? 'assist-evaluating' : 'shadow-baseline',
    rollout: rolloutRow ? {
      configured_mode: rolloutRow.configured_mode,
      effective_mode: rolloutRow.effective_mode,
      recommendation: rolloutRow.recommendation,
      stage_id: rolloutRow.stage_id,
      updated_at: rolloutRow.updated_at,
    } : null,
    samples: {
      compile_attempts: events.length,
      artifacts: artifacts.length,
      attributed_calls: calls.length,
      measured_outcomes: measured.length,
      compile_errors: events.filter((event) => event.status === 'failed').length,
      compile_timeouts: events.filter((event) => event.status === 'timeout').length,
      attributed_call_errors: calls.filter((row) => row.is_error).length,
      failure_telemetry_complete: failureTelemetryComplete,
    },
    observed_modes: modeRows,
    providers: [...providerMap].map(([provider, count]) => ({ provider, calls: count })).sort((a, b) => b.calls - a.calls),
    accuracy: {
      edit_precision_pct: percentAverage(measured, 'precision'),
      edit_recall_pct: percentAverage(measured, 'recall'),
      measured_n: measured.length,
      outcome_coverage_pct: artifacts.length ? roundMetric((measured.length / artifacts.length) * 100, 1) : null,
      by_task_kind: [...taskKinds].map(([task_kind, rows]) => ({
        task_kind, n: rows.length,
        edit_precision_pct: percentAverage(rows, 'precision'),
        edit_recall_pct: percentAverage(rows, 'recall'),
      })).sort((a, b) => b.n - a.n || a.task_kind.localeCompare(b.task_kind)),
    },
    tokens: {
      injected_prompt_tokens_est: injectedPromptTokens,
      replay_exposure_tokens_est: replayExposureTokens,
      matched_shadow_delta_tokens: enoughComparison ? roundMetric(baselineTotal - actualTotal, 0) : null,
      matched_shadow_delta_pct: enoughComparison ? roundMetric(((baselineTotal - actualTotal) / baselineTotal) * 100, 1) : null,
      // Backward-compatible call-count fields; unlike the old implementation,
      // these intentionally include failed and continuation calls.
      matched_assist_n: matchedAssistCallN,
      matched_shadow_n: matchedShadowCallN,
      matched_assist_workload_n: matched.length,
      matched_shadow_workload_n: matchedShadowWorkloads.length,
      matched_cohort_n: matchedCohorts.size,
      attributed_workload_n: workloads.length,
      comparison_error_call_n: comparisonErrorCalls,
      comparison_continuation_call_n: comparisonContinuationCalls,
      comparison_retry_workload_n: comparisonRetryWorkloads,
      comparison_unit: 'session-attempt-workload',
      comparison_method: 'cohort-matched mean shadow workload scaled to active workloads; cohort=task+model+routing-tier-or-turn-cap',
      confidence: matched.length >= 20 && matchedShadowWorkloads.length >= 20 ? 'indicative' : enoughComparison ? 'directional' : 'insufficient',
      note: 'Token values are advisory context-work proxies, not a causal A/B estimate or conversion to Claude Max quota.',
    },
    recent: events.slice(0, 10),
  };
}

export function getQualityReport({ project, days = 30 } = {}) {
  const db = getDb();
  const d = Math.max(1, Math.min(365, Number(days) || 30));
  const since = new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
  const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // ── Acceptance first-pass % — the FIRST verify_results row per phase ──────
  const firstPassRows = db.prepare(`
    SELECT vr.phase, vr.verdict
    FROM verify_results vr
    INNER JOIN (
      SELECT phase, MIN(id) AS first_id
      FROM verify_results
      WHERE project = ? AND created_at >= ?
      GROUP BY phase
    ) f ON vr.phase = f.phase AND vr.id = f.first_id
    WHERE vr.project = ?
  `).all(project, since, project);
  const firstPassN = firstPassRows.length;
  const firstPassPassN = firstPassRows.filter((r) => r.verdict === 'pass').length;
  const acceptance = {
    n: firstPassN,
    pass_n: firstPassPassN,
    first_pass_pct: firstPassN > 0 ? Math.round((firstPassPassN / firstPassN) * 1000) / 10 : null,
  };

  // ── Per-task escalation % + avg num_turns vs cap ───────────────────────────
  // AVG() already ignores NULLs and returns NULL over an all-NULL/empty group,
  // so legacy rows with no num_turns/max_turns/escalated degrade to null
  // without any extra guard code here.
  const tasks = db.prepare(`
    SELECT task,
           COUNT(*)                        AS n,
           COALESCE(SUM(escalated), 0)     AS escalated_n,
           AVG(num_turns)                  AS avg_num_turns,
           AVG(max_turns)                  AS avg_max_turns
    FROM calls
    WHERE project = ? AND started_at >= ?
    GROUP BY task
    ORDER BY n DESC
  `).all(project, since).map((r) => ({
    task: r.task,
    n: r.n,
    escalation_pct: r.n > 0 ? Math.round((r.escalated_n / r.n) * 1000) / 10 : null,
    avg_num_turns: r.avg_num_turns != null ? Math.round(r.avg_num_turns * 10) / 10 : null,
    avg_max_turns: r.avg_max_turns != null ? Math.round(r.avg_max_turns * 10) / 10 : null,
  }));

  // ── Bug-round convergence: found_count series ──────────────────────────────
  const rounds = db.prepare(`
    SELECT round, found_count, status, started_at, ended_at
    FROM bug_rounds
    WHERE project = ?
    ORDER BY round ASC
  `).all(project);

  // ── 7d vs 30d cache_hit_pct per task ────────────────────────────────────────
  const cacheAgg = (sinceCutoff) => db.prepare(`
    SELECT task, COALESCE(SUM(input_tokens),0) AS input_tokens,
           COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
           COALESCE(SUM(cache_creation_tokens),0) AS cache_creation_tokens
    FROM calls WHERE project = ? AND started_at >= ?
    GROUP BY task
  `).all(project, sinceCutoff);
  const cache7ByTask = new Map(cacheAgg(since7).map((r) => [r.task, cacheHitPct(r)]));
  const cache30ByTask = new Map(cacheAgg(since30).map((r) => [r.task, cacheHitPct(r)]));
  const allCacheTasks = new Set([...cache7ByTask.keys(), ...cache30ByTask.keys()]);
  const cache_trend = [...allCacheTasks].sort().map((task) => ({
    task,
    cache_hit_pct_7d: cache7ByTask.has(task) ? cache7ByTask.get(task) : null,
    cache_hit_pct_30d: cache30ByTask.has(task) ? cache30ByTask.get(task) : null,
  }));

  const context_compiler = getContextCompilerReport({ project, days: d });
  return { project, days: d, acceptance, tasks, rounds, cache_trend, context_compiler };
}

// ─── Routing transparency (Phase 61 — P5) ──────────────────────────────────

/**
 * Pure READ join over foundations telemetry: a phase's `calls` rows
 * (started_at-ordered) carrying model/task/routing_tier/routing_reason/
 * attempt/escalated/num_turns/max_turns/is_error, the phase's own status/
 * title, and the LATEST verify_results verdict for that phase (Phase 60/P4).
 * Zero new routing logic and zero writes — this only displays what the
 * foundations cycle (routing columns) and brief 05 (routing outcomes)
 * already record. Pre-foundations calls have NULL routing_tier/reason/
 * attempt (escalated defaults 0) — callers/UI render those as "no routing
 * recorded"; this function itself just passes the nulls through, it never
 * throws or crashes on them. Unknown project/phase resolves to an empty
 * `calls` array and `status: null` (never throws) — the web-ui route layers
 * the actual 404-on-unknown-project check via getProject(), matching every
 * other /api/projects/:name/... endpoint's convention.
 *
 * @param {{project: string, phase: number}} o
 */
export function getPhaseRoutingChain({ project, phase }) {
  const db = getDb();
  const phaseN = Number(phase);
  const calls = db.prepare(`
    SELECT id, task, model, started_at, duration_ms, num_turns, max_turns,
           routing_tier, routing_reason, attempt, escalated, is_error, error_message
    FROM calls
    WHERE project = ? AND phase = ?
    ORDER BY started_at ASC, id ASC
  `).all(project, phaseN);

  const phaseRow = db.prepare(`SELECT status, title FROM phases WHERE project = ? AND n = ?`)
    .get(project, phaseN) || null;

  const verdict = db.prepare(`
    SELECT verdict, criteria_met, criteria_unmet, unverifiable, created_at
    FROM verify_results
    WHERE project = ? AND phase = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(project, phaseN) || null;

  return {
    project,
    phase: phaseN,
    status: phaseRow ? phaseRow.status : null,
    title: phaseRow ? phaseRow.title : null,
    calls,
    verdict,
  };
}

// ─── Phase lanes (Phase 65 — Execution DAG P1, inert scaffolding) ──────────
// Sync accessors over the phase_lanes table (see migrate()'s DDL above). No
// scheduler calls these yet — this is the DB read/write surface a future
// parallel-lane phase in this cycle wires up.

export function createPhaseLane({ project, kind, n = null, round = null, branch = null, worktree_path = null, base_sha = null }) {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO phase_lanes (project, kind, n, round, branch, worktree_path, base_sha, status, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)
  `).run(project, kind, n, round, branch, worktree_path, base_sha, new Date().toISOString());
  return info.lastInsertRowid;
}

export function getPhaseLane(id) {
  return getDb().prepare('SELECT * FROM phase_lanes WHERE id = ?').get(id);
}

export function listPhaseLanesForProject(project, { status = null } = {}) {
  const db = getDb();
  if (status) {
    return db.prepare('SELECT * FROM phase_lanes WHERE project = ? AND status = ? ORDER BY id').all(project, status);
  }
  return db.prepare('SELECT * FROM phase_lanes WHERE project = ? ORDER BY id').all(project);
}

/** Across all projects when `project` is omitted — the shape a run-start orphan sweep needs. */
export function listRunningPhaseLanes(project = null) {
  const db = getDb();
  if (project) {
    return db.prepare(`SELECT * FROM phase_lanes WHERE project = ? AND status = 'running' ORDER BY id`).all(project);
  }
  return db.prepare(`SELECT * FROM phase_lanes WHERE status = 'running' ORDER BY id`).all();
}

export function updatePhaseLaneStatus(id, status, { head_sha = null } = {}) {
  const db = getDb();
  const terminal = status !== 'running';
  db.prepare(`
    UPDATE phase_lanes
    SET status = ?, head_sha = COALESCE(?, head_sha), ended_at = CASE WHEN ? THEN ? ELSE ended_at END
    WHERE id = ?
  `).run(status, head_sha, terminal ? 1 : 0, new Date().toISOString(), id);
}
