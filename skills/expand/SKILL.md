# compass-expand

Drill one component deeper — generate a sub-diagram showing the internal structure of a single component.

## Arguments

- `<id>` (required) — the component ID to expand, e.g. `C2`. List available IDs with `/compass-status`.

## Steps

```bash
# 1. Validate the component exists and estimate cost (2 LLM calls)
npx tsx "$CLAUDE_PLUGIN_DIR/scripts/expand-init.ts" --component <id>

# 2. Scope state.files membership to the target component
npx tsx "$CLAUDE_PLUGIN_DIR/scripts/expand-scope.ts" --component <id>

# 3. Cluster the scoped file set
npx tsx "$CLAUDE_PLUGIN_DIR/scripts/scan-cluster.ts" --scope <id>

# 4. LLM propose pass for the scoped cluster
npx tsx "$CLAUDE_PLUGIN_DIR/scripts/scan-propose.ts" --scope <id>

# 5. LLM critique pass
npx tsx "$CLAUDE_PLUGIN_DIR/scripts/scan-critique.ts" --scope <id>

# 6. Render only the expanded component page
npx tsx "$CLAUDE_PLUGIN_DIR/scripts/scan-render.ts" --component <id>
```

## After completion

Tell the user where the sub-diagram was written (`.compass/<ComponentName>.md`) and the token cost.
