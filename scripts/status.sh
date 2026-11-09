#!/bin/bash
# Quick status check
set -e
cd "$(dirname "$0")/.."
npm run status -- "$@"
