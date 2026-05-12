# compass-scan

Walk the repo, build the import graph, run two-pass LLM clustering, and render the architectural map into `.compass/`.

## Arguments

- `--depth N` (optional, default 1, max 2) — at depth 2 each top-level component gets its own sub-diagram.
- `--force` — overwrite an existing `.compass/state.json` without prompting.

## Steps

Run these bash commands in order. Use the `$CLAUDE_PLUGIN_DIR` environment variable for the plugin scripts directory. The working directory is the repo root.

```bash
# 1. Initialise state (refuses if state.json already exists unless --force)
npx tsx "$CLAUDE_PLUGIN_DIR/scripts/scan-init.ts" [--depth N] [--force]

# 2. Walk the repo and record file hashes
npx tsx "$CLAUDE_PLUGIN_DIR/scripts/scan-walk.ts"

# 3. Parse all files with tree-sitter, build graph.json sidecar
npx tsx "$CLAUDE_PLUGIN_DIR/scripts/scan-parse.ts"

# 4. Seeded Louvain pre-clustering into clusters.json sidecar
npx tsx "$CLAUDE_PLUGIN_DIR/scripts/scan-cluster.ts"

# 5. Show cost estimate and ask user to confirm (skipped if COMPASS_AUTO_CONFIRM=1)
npx tsx "$CLAUDE_PLUGIN_DIR/scripts/scan-confirm-cost.ts"

# 6. LLM propose pass — calls claude -p to name components
npx tsx "$CLAUDE_PLUGIN_DIR/scripts/scan-propose.ts"

# 7. LLM critique pass — calls claude -p to revise and strengthen
npx tsx "$CLAUDE_PLUGIN_DIR/scripts/scan-critique.ts"

# 8. Render Mermaid diagrams + Markdown pages into .compass/
npx tsx "$CLAUDE_PLUGIN_DIR/scripts/scan-render.ts"
```

## After completion

Tell the user:
- How many components were found (`state.stats.components_post_llm`)
- Where to find the output (`ls .compass/*.md`)
- The token cost printed by the scripts
- That `/compass-refresh` keeps the map in sync going forward

## Error handling

If any script exits non-zero, the phase is recorded in `state.json`. Tell the user to run `/compass-recover` to resume from where it failed.
