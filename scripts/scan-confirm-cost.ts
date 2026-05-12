#!/usr/bin/env -S npx tsx
import { loadState } from '../src/lib/state.ts';
import { statePath } from '../src/lib/paths.ts';

const root = process.cwd();
const s = loadState(statePath(root));
if (!s) {
  console.error('no compass state — run /compass-scan first');
  process.exit(1);
}

const k = s.stats.clusters_pre_llm || 0;
const depth = s.depth;
// Top-level: 2 calls. depth=2: 2 + 2*K calls (one expand per component).
const calls = depth >= 2 ? 2 + 2 * k : 2;

console.log(`[compass] depth=${depth}: expected ${calls} calls to claude (propose + critique${depth >= 2 ? ` × ${k + 1} scopes` : ''}).`);
console.log(`[compass] Continue? [y/N]`);

if (process.env.COMPASS_AUTO_CONFIRM === '1') {
  console.log('[compass] auto-confirmed via COMPASS_AUTO_CONFIRM=1');
  process.exit(0);
} else {
  console.log('[compass] (no TTY in tests — defaulting to abort; set COMPASS_AUTO_CONFIRM=1 to skip)');
  process.exit(2);
}
