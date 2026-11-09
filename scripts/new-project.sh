#!/bin/bash
# Convenience wrapper. Prefer: npm run new -- <name> --profile <profile>
set -e
NAME="$1"
if [ -z "$NAME" ]; then
  echo "Usage: $0 <project-name> [profile]"
  exit 1
fi
PROFILE="${2:-}"
cd "$(dirname "$0")/.."
if [ -n "$PROFILE" ]; then
  npm run new -- "$NAME" --profile "$PROFILE"
else
  npm run new -- "$NAME"
fi
