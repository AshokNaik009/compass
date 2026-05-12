#!/usr/bin/env -S npx tsx
import { loadAnalysis } from '../src/lib/analysis.ts';
import { saveState, forcePhase } from '../src/lib/state.ts';
import { analysisPath, statePath, parseScopeArg, parseDepth, printCostLine } from '../src/lib/paths.ts';
import { withLock, loadStateOrThrow, markFailed } from '../src/lib/runner.ts';

const root = process.cwd();
const argv = process.argv.slice(2);
const componentId = parseScopeArg(argv, 'component');
const depth = parseDepth(argv);

withLock(root, () => {
  try {
    if (!componentId) throw new Error('expand-init: --component <id> is required');
    if (depth < 2) throw new Error(`expand-init: --depth must be >= 2 (got ${depth})`);
    const s = loadStateOrThrow(root);
    const analysis = loadAnalysis(analysisPath(root));
    if (!analysis) throw new Error('expand-init: no analysis.json — run /compass-scan first');
    const target = analysis.components.find((c) => c.id === componentId);
    if (!target) throw new Error(`expand-init: component ${componentId} not found in analysis.components`);

    // Predict cost: 2 LLM calls (propose + critique). SPEC §6.1 step 7.
    const fileCount = target.files.length;
    console.log(`[compass] expand-init: ${componentId} has ${fileCount} files; depth=${depth}`);
    console.log(`[compass] expected LLM calls: 2 (propose + critique). Continue? [auto-confirm in tests]`);

    const next = { ...forcePhase(s, 'clustering'), depth: depth as 1 | 2 };
    saveState(statePath(root), next);
    printCostLine('expand-init', 0, 0, 0);
  } catch (err) {
    markFailed(root, err as Error);
    throw err;
  }
});
