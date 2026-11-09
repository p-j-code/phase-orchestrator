#!/usr/bin/env bash
# build-release-zip.sh — reproducible release-zip builder for Ashmero
# Orchestrator. Replaces the ad-hoc `zip -r` flow that produced the defective
# v0.13.0 → v0.14.5 zips.
#
# Usage:  bash scripts/build-release-zip.sh <version>
# Output: dist/orchestrator-v<version>-complete.zip
#
# Guarantees:
#   1. <version> must match package.json's version field exactly. Prevents
#      shipping a zip whose filename lies about the contents.
#   2. The staged tree honours .releaseignore — config/telegram.json and
#      projects/* (except .gitkeep) cannot leak in.
#   3. Output zip has the same `orchestrator-v06-complete/` subfolder shape
#      every prior release used, so existing apply recipes keep working.
#   4. Cross-platform (Mac dev box, Linux NAS). stat and shasum are
#      auto-detected.

set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "Usage: bash scripts/build-release-zip.sh <version>" >&2
  echo "Example: bash scripts/build-release-zip.sh 0.14.6" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# ─── Version check ──────────────────────────────────────────────────────────
# Refuse to build if the caller's version arg doesn't match package.json.
# This is the cheapest possible "did you forget to bump package.json?"
# guard — without it, you can ship a v0.14.6 zip whose package.json says
# 0.14.5 and discover the lie only when the operator's `node -e
# "require('./package.json').version"` step in the apply recipe fails.
PKG_VERSION="$(node -e "console.log(require('./package.json').version)")"
if [[ "$VERSION" != "$PKG_VERSION" ]]; then
  echo "✗ Version mismatch: arg='$VERSION', package.json='$PKG_VERSION'" >&2
  echo "  Bump package.json or fix the arg. Refusing to ship a mislabelled zip." >&2
  exit 2
fi

# ─── .releaseignore guard ───────────────────────────────────────────────────
if [[ ! -f "$REPO_ROOT/.releaseignore" ]]; then
  echo "✗ .releaseignore is missing. This file is required — it's the source" >&2
  echo "  of truth for what NEVER ships in a release zip. Aborting." >&2
  exit 3
fi

# ─── Staging ────────────────────────────────────────────────────────────────
# Per the Phase 1 spec, stage at a known location (/tmp/orchestrator-release-stage)
# so it's predictable and inspectable on failure. The script always cleans up
# its own staging dir at start to be idempotent.
STAGE_PARENT="/tmp/orchestrator-release-stage"
STAGE_DIR="$STAGE_PARENT/orchestrator-v06-complete"
OUT_DIR="$REPO_ROOT/dist"
OUT_FILE="$OUT_DIR/orchestrator-v${VERSION}-complete.zip"

rm -rf "$STAGE_PARENT"
mkdir -p "$STAGE_DIR" "$OUT_DIR"

echo "▶ Staging at $STAGE_DIR (excludes from .releaseignore)"

# Preferred path: rsync — available on Mac and on Linux. The cp -a
# fallback exists for ultra-minimal containers (CI runners, sandboxes) that
# don't have rsync. Same end-state either way.
if command -v rsync > /dev/null; then
  # Belt-and-braces: --exclude-from is the source of truth, but we ALSO pass the
  # critical excludes explicitly so a missing/typo'd line in .releaseignore can
  # never leak the live DB or token. This makes the rsync path's safety floor
  # identical to the cp fallback below (previously the rsync path trusted
  # .releaseignore alone, which was the C2 leak vector).
  rsync -a \
    --exclude-from="$REPO_ROOT/.releaseignore" \
    --exclude='/state/' --exclude='/logs/' --exclude='/outputs/' \
    --exclude='/dist/' --exclude='/node_modules/' --exclude='/.git/' \
    --exclude='/config/telegram.json' \
    "$REPO_ROOT/" "$STAGE_DIR/"
else
  echo "  (rsync not found — falling back to cp -a + prune)"
  # cp -a copies everything (including hidden files), then we apply the
  # .releaseignore exclusions post-hoc. Less elegant than rsync's pattern
  # support but functionally equivalent for the patterns we use.
  for entry in $(ls -A "$REPO_ROOT"); do
    cp -a "$REPO_ROOT/$entry" "$STAGE_DIR/"
  done
  # Apply exclusions matching the .releaseignore patterns we actually use.
  # If you extend .releaseignore with novel patterns, extend this block too.
  rm -f  "$STAGE_DIR/config/telegram.json"
  rm -rf "$STAGE_DIR/state" "$STAGE_DIR/logs" "$STAGE_DIR/node_modules" \
         "$STAGE_DIR/.git" "$STAGE_DIR/dist"
  if [[ -d "$STAGE_DIR/projects" ]]; then
    find "$STAGE_DIR/projects" -mindepth 1 -not -name '.gitkeep' -delete 2>/dev/null || true
  fi
  find "$STAGE_DIR" \( -name '.DS_Store' -o -name '*.swp' -o -name '*.swo' \
                       -o -name 'Thumbs.db' -o -name '*.log' \) -delete 2>/dev/null || true
fi

# Re-seed projects/.gitkeep so the directory exists in the zip even if the
# operator's local projects/ tree is sparse. Defensive: rsync's --include
# alongside --exclude='projects/*' is unreliable across older rsync versions.
mkdir -p "$STAGE_DIR/projects"
touch "$STAGE_DIR/projects/.gitkeep"

# ─── Sanity: refuse to build if forbidden files snuck through ───────────────
FORBIDDEN=()
if [[ -f "$STAGE_DIR/config/telegram.json" ]]; then
  FORBIDDEN+=("config/telegram.json")
fi
# Live-data / dev-only dirs that must never reach the zip. Previously the guard
# only inspected config/telegram.json + projects/, so a leaked state/ (the live
# DB) on the rsync path passed unnoticed. Check them explicitly now.
for forbidden_dir in state logs outputs dist node_modules .git; do
  if [[ -e "$STAGE_DIR/$forbidden_dir" ]]; then
    FORBIDDEN+=("$forbidden_dir/")
  fi
done
while IFS= read -r f; do
  rel="${f#$STAGE_DIR/}"
  if [[ "$rel" != "projects/.gitkeep" ]]; then
    FORBIDDEN+=("$rel")
  fi
done < <(find "$STAGE_DIR/projects" -type f 2>/dev/null || true)

if [[ ${#FORBIDDEN[@]} -gt 0 ]]; then
  echo "✗ Staging tree contains forbidden files (would clobber operator data):" >&2
  printf '   - %s\n' "${FORBIDDEN[@]}" >&2
  exit 4
fi

# ─── Zip ────────────────────────────────────────────────────────────────────
# Idempotent: overwrite any prior zip at the output path.
rm -f "$OUT_FILE"

echo "▶ Building $OUT_FILE"
(cd "$STAGE_PARENT" && zip -rq "$OUT_FILE" orchestrator-v06-complete)

# Cleanup. Leave the staging dir on a successful build for inspection? No —
# /tmp gets cleared on reboot anyway, and a stale staging dir from a previous
# version of this script could confuse future debugging. Wipe it.
rm -rf "$STAGE_PARENT"

# ─── Report ────────────────────────────────────────────────────────────────-
# Cross-platform SHA256: macOS has `shasum -a 256`, Linux has both `sha256sum`
# and `shasum -a 256` (the latter via Perl). Prefer sha256sum on Linux for
# speed, fall back to shasum elsewhere.
if command -v sha256sum > /dev/null; then
  SHA="$(sha256sum "$OUT_FILE" | awk '{print $1}')"
elif command -v shasum > /dev/null; then
  SHA="$(shasum -a 256 "$OUT_FILE" | awk '{print $1}')"
else
  SHA="(no sha256 tool available)"
fi

# Cross-platform size: Linux `stat -c %s`, macOS `stat -f %z`.
if SIZE_BYTES="$(stat -c '%s' "$OUT_FILE" 2>/dev/null)"; then :
elif SIZE_BYTES="$(stat -f '%z' "$OUT_FILE" 2>/dev/null)"; then :
else
  SIZE_BYTES=0
fi
SIZE_KB=$((SIZE_BYTES / 1024))

FILE_COUNT="$(unzip -l "$OUT_FILE" | tail -1 | awk '{print $2}')"

echo ""
echo "✓ Built $OUT_FILE"
echo "  Version: $VERSION"
echo "  Size:    ${SIZE_KB} KB"
echo "  Files:   $FILE_COUNT"
echo "  SHA256:  $SHA"
echo ""
echo "── Zip contents (top 20 entries) ──"
unzip -l "$OUT_FILE" | head -22
echo ""
echo "── Forbidden-path check ──"
# Match: the live token (but NOT telegram.json.example), any state/logs/outputs/
# dist/node_modules/.git dir, or a known operator project. The original check
# only looked for telegram.json + billflow-tds. We strip unzip's "Archive: <path>"
# header line first — the output zip lives under dist/, so that header would
# otherwise false-match the /dist/ pattern.
if unzip -l "$OUT_FILE" | grep -v '^Archive:' | grep -E '(config/telegram\.json([^.]|$)|/(state|logs|outputs|dist|node_modules)/|/\.git/|projects/billflow-tds)' ; then
  echo "✗ Forbidden paths in built zip — this should not happen, file a bug." >&2
  exit 5
else
  echo "✓ Clean: no live token, state, logs, .git, node_modules, or operator project dirs."
fi
