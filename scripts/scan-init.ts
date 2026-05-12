#!/usr/bin/env -S npx tsx
import { existsSync } from 'node:fs';
import { defaultState, saveState } from '../src/lib/state.ts';
import { parseDepth, hasFlag, statePath } from '../src/lib/paths.ts';
import { withLock } from '../src/lib/runner.ts';
import { loadState } from '../src/lib/state.ts';
import { printCostLine } from '../src/lib/paths.ts';

const root = process.cwd();
const argv = process.argv.slice(2);
const depth = parseDepth(argv);
const force = hasFlag(argv, 'force');

withLock(root, () => {
  if (existsSync(statePath(root)) && !force) {
    throw new Error(
      `a compass analysis already exists at ${statePath(root)} — pass --force to overwrite`,
    );
  }
  const s = defaultState({ root, depth });
  saveState(statePath(root), s);
  console.log(`[compass] scan-init: phase=walking, depth=${depth}, seed=${s.pins.louvain_seed}`);
  printCostLine('scan-init', 0, 0, 0);
});
