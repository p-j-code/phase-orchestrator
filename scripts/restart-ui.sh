#!/usr/bin/env bash
# Stops and restarts the Ashmero Web UI so all in-repo changes take effect.
# Works in two modes:
#   pm2  — if pm2 is running an 'ashmero-web' process, do a pm2 restart.
#   bare — kill whatever process owns port 4242 then re-exec the web command.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${ASHMERO_PORT:-4242}"

# ── pm2 path ──────────────────────────────────────────────────────────────────
if command -v pm2 &>/dev/null 2>&1; then
  if pm2 list 2>/dev/null | grep -q 'ashmero-web'; then
    echo "↻  Restarting ashmero-web via pm2..."
    pm2 restart ashmero-web || true
    echo "✓  Done. (run: pm2 logs ashmero-web)"
    exit 0
  fi
fi

# ── bare-process path ─────────────────────────────────────────────────────────
PID=$(lsof -ti "tcp:${PORT}" 2>/dev/null || true)
if [ -n "$PID" ]; then
  echo "⏹  Stopping UI (pid ${PID} on port ${PORT})..."
  kill -TERM "$PID" 2>/dev/null || true
  # Give it up to 5 s to exit cleanly (matches the kill_timeout in ecosystem.config)
  for i in $(seq 1 10); do
    sleep 0.5
    kill -0 "$PID" 2>/dev/null || break
  done
  # Force-kill if still alive
  kill -KILL "$PID" 2>/dev/null || true
else
  echo "ℹ  No process found on port ${PORT}."
fi

echo "▶  Starting UI..."
cd "$REPO_ROOT"
exec node src/orchestrator.js web
