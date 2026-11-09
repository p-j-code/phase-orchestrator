#!/bin/bash
# Preflight — manual sanity check before starting work.
# Run this once at the start of a session to confirm you're on Max plan.

set -e

echo "═══════════════════════════════════════════════════════════"
echo "  Ashmero Orchestrator — Preflight Check"
echo "═══════════════════════════════════════════════════════════"
echo

# 1. ANTHROPIC_API_KEY not set
if [ -n "$ANTHROPIC_API_KEY" ]; then
  echo "✗  ANTHROPIC_API_KEY is set in your environment."
  echo "   This would bypass Max plan billing. Unset it:"
  echo "   unset ANTHROPIC_API_KEY"
  echo
  exit 1
else
  echo "✓  ANTHROPIC_API_KEY not in environment"
fi

# 2. claude binary present
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
if ! command -v "$CLAUDE_BIN" >/dev/null 2>&1 && [ ! -x "$CLAUDE_BIN" ]; then
  echo "✗  claude binary not found"
  echo "   Set CLAUDE_BIN env or fix your PATH"
  exit 1
fi
VERSION=$("$CLAUDE_BIN" --version 2>/dev/null || echo "unknown")
echo "✓  claude available ($VERSION)"

# 3. Confirm Max/subscription billing (manual)
echo
echo "──────────────────────────────────────────────"
echo "  MANUAL CHECK — open claude and run /status"
echo "──────────────────────────────────────────────"
echo "  You should see: 'Subscription' (Max plan)"
echo "  You should NOT see: 'API' or 'Pay-as-you-go'"
echo
echo "  If wrong: run 'claude /logout' then 'claude /login',"
echo "  decline API credit offers during auth."
echo

# 4. Config self-test
cd "$(dirname "$0")/.."
node src/config-resolver.js --selftest

echo
echo "═══════════════════════════════════════════════════════════"
echo "  Preflight complete. You're clear to run the orchestrator."
echo "═══════════════════════════════════════════════════════════"
