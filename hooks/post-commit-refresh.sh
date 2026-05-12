#!/usr/bin/env bash
# Receives Claude Code PostToolUse JSON on stdin.
# Runs compass refresh automatically after any git commit made via Claude Code.
set -euo pipefail

INPUT=$(cat)

# Only act on git commit commands
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')
if ! echo "$COMMAND" | grep -qE 'git\s+commit'; then
  exit 0
fi

# Only act if a compass state.json exists — repo must have been scanned first
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')
STATE="$CWD/.compass/state.json"
if [ ! -f "$STATE" ]; then
  exit 0
fi

# Resolve plugin dir (same dir as this script's parent)
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[compass] git commit detected — running incremental refresh..." >&2

# Step 1: classify changes
DIFF_OUT=$(npx tsx "$PLUGIN_DIR/scripts/refresh-diff.ts" 2>&1) || true
echo "$DIFF_OUT" >&2

if echo "$DIFF_OUT" | grep -q "up to date"; then
  echo "[compass] map is up to date." >&2
  exit 0
fi

if echo "$DIFF_OUT" | grep -q "SAFE"; then
  # Extract affected component IDs (e.g. "C2,C4")
  COMPONENTS=$(echo "$DIFF_OUT" | grep -oE 'component=[A-Z][0-9]+(\.[0-9]+)?' | grep -oE '[A-Z][0-9]+(\.[0-9]+)?' | sort -u | tr '\n' ',' | sed 's/,$//')
  if [ -z "$COMPONENTS" ]; then
    echo "[compass] SAFE but no component IDs found — skipping refresh." >&2
    exit 0
  fi
  echo "[compass] SAFE refresh for components: $COMPONENTS" >&2
  npx tsx "$PLUGIN_DIR/scripts/refresh-reparse.ts" --components "$COMPONENTS" 2>&1 >&2 || true
  COMPASS_AUTO_CONFIRM=1 npx tsx "$PLUGIN_DIR/scripts/refresh-recritique.ts" --components "$COMPONENTS" 2>&1 >&2 || true
  npx tsx "$PLUGIN_DIR/scripts/scan-render.ts" --components "$COMPONENTS" 2>&1 >&2 || true
  echo "[compass] map updated (SAFE path)." >&2
elif echo "$DIFF_OUT" | grep -q "UNSAFE"; then
  echo "[compass] UNSAFE — re-clustering..." >&2
  npx tsx "$PLUGIN_DIR/scripts/scan-cluster.ts" 2>&1 >&2 || true
  COMPASS_AUTO_CONFIRM=1 npx tsx "$PLUGIN_DIR/scripts/scan-propose.ts" 2>&1 >&2 || true
  COMPASS_AUTO_CONFIRM=1 npx tsx "$PLUGIN_DIR/scripts/scan-critique.ts" 2>&1 >&2 || true
  npx tsx "$PLUGIN_DIR/scripts/scan-render.ts" 2>&1 >&2 || true
  echo "[compass] map updated (UNSAFE path — full re-cluster)." >&2
fi

exit 0
