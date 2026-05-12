# compass-recover

Resume a scan or refresh that was interrupted — picks up from the last completed phase with no repeated work.

## Steps

```bash
npx tsx "$CLAUDE_PLUGIN_DIR/scripts/recover.ts"
```

## Reading the output

- `resuming from phase=<phase>` — recovery is running; wait for it to finish.
- `nothing to recover (phase=done)` — the last run completed normally; no action needed.
- `no state.json` — no scan has ever been run; suggest `/compass-scan`.
- If the script fails again at the same phase, there may be a persistent error. Show the user the `last_error` field from `.compass/state.json` and suggest running `/compass-scan --force` to start fresh.
