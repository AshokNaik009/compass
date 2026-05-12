# compass-status

Report which components are stale relative to the current working tree. Read-only — makes no changes.

## Steps

```bash
npx tsx "$CLAUDE_PLUGIN_DIR/scripts/status.ts"
```

## Reading the output

- `working tree up to date` — no changes detected, map is current.
- `STALE: N components affected by M changed files` — show the user the list of stale components and suggest running `/compass-refresh`.
- `last run did not finish (phase=...)` — a previous command was interrupted; suggest `/compass-recover`.
- `no analysis yet` — no scan has been run; suggest `/compass-scan`.
