# Ashmero Orchestrator — Repo Context

This repo orchestrates phase-based development by spawning Claude Code subprocesses. When you are running inside this repo's root, you are likely doing meta-work on the orchestrator itself — not on a user project.

## Critical rules when working in this repo

1. **Never modify `projects/<name>/workspace/`** from a root-level session. Those folders are owned by dev-agent sessions that get spawned with their own `cwd`.
2. **Never modify `projects/<name>/.guide/`** from a root-level session. Those are owned by guide-agent sessions.
3. **You may edit:** `src/`, `config/`, `prompts/`, `scripts/`, `docs/`, root files.
4. **Default model is Sonnet 4.6.** Opus is reserved for orchestrator-level planning if explicitly requested.

## Architecture in one paragraph

Orchestrator spawns `claude -p` subprocesses with different system prompts (guide vs dev) and different working directories (`.guide/` vs `workspace/`). Each subprocess has no shared context with others. The orchestrator persists `session_id` per role per project in SQLite, uses `--resume <id>` to maintain guide continuity across phase prompts, and tracks 5-hour window consumption to auto-pause before hitting Max plan limits.

## When making changes

- Run `npm run test:config` after touching anything in `config/` or `src/config-resolver.js`.
- Update `docs/ARCHITECTURE.md` if you add a new module or change the cascade order.
- Bump `$schema_version` in `config/defaults.json` if schema shape changes; add a migration in `src/config-migrator.js`.

## Tech stack

- Node 18+, ESM modules
- `commander` for CLI
- `better-sqlite3` for state (synchronous, fast, no server)
- `ajv` for JSON Schema validation
- `chalk` + `ora` for terminal output

## Conventions

- All paths use `path.join` / `path.resolve`. No string concatenation.
- All file IO is async (`fs/promises`) except SQLite (sync by design).
- Error messages include the config layer that produced the bad value, so debugging cascades is easy.
- Subprocess spawning goes through `src/claude-runner.js` only. Never spawn `claude` directly elsewhere.

## Headless deployment

The orchestrator can run 24/7 on an always-on machine under PM2 (`ecosystem.config.cjs`:
web UI and durable worker as separate processes). Only one install may execute work for a
given Claude account; `config/execution-host.json` names it (see docs/ARCHITECTURE.md).
