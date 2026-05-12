# compass-refresh

Incrementally update the architectural map — only re-analyze files that changed since the last run.

## Steps

```bash
# 1. Classify changes as SAFE (in-component edits) or UNSAFE (new/deleted files, neighbour-profile shifts)
npx tsx "$CLAUDE_PLUGIN_DIR/scripts/refresh-diff.ts"
```

Read the output:

**If output contains `up to date`** — nothing changed, tell the user and stop.

**If output contains `SAFE`** — extract the affected component IDs (e.g. `C2,C4`) from the output, then:

```bash
# 2a. Re-parse only the changed files
npx tsx "$CLAUDE_PLUGIN_DIR/scripts/refresh-reparse.ts" --components <ids>

# 2b. LLM critique pass for the affected components (one claude -p call)
npx tsx "$CLAUDE_PLUGIN_DIR/scripts/refresh-recritique.ts" --components <ids>

# 2c. Re-render only the affected component pages
npx tsx "$CLAUDE_PLUGIN_DIR/scripts/scan-render.ts" --components <ids>
```

**If output contains `UNSAFE`** — component boundaries may have changed; fall through to full re-cluster:

```bash
# 3a. Re-cluster from the existing walk (no re-walk needed)
npx tsx "$CLAUDE_PLUGIN_DIR/scripts/scan-cluster.ts"

# 3b–d. Full propose + critique + render
npx tsx "$CLAUDE_PLUGIN_DIR/scripts/scan-propose.ts"
npx tsx "$CLAUDE_PLUGIN_DIR/scripts/scan-critique.ts"
npx tsx "$CLAUDE_PLUGIN_DIR/scripts/scan-render.ts"
```

## After completion

Tell the user which components were updated and the token cost from the scripts.

## Error handling

On any script failure, tell the user to run `/compass-recover`.
