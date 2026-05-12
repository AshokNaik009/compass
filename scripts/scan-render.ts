#!/usr/bin/env -S npx tsx
import { renderAnalysis } from '../src/lib/render.ts';
import { loadAnalysis } from '../src/lib/analysis.ts';
import { transitionPhase, forcePhase, saveState } from '../src/lib/state.ts';
import { analysisPath, compassDir, statePath, parseScopeArg, printCostLine } from '../src/lib/paths.ts';
import { withLock, loadStateOrThrow, markFailed } from '../src/lib/runner.ts';

const root = process.cwd();
const argv = process.argv.slice(2);

function parseList(name: string): string[] | undefined {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  const v = argv[idx + 1];
  if (!v) return undefined;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

const onlyComponents = parseList('components');
const componentFlag = parseScopeArg(argv, 'component'); // used by expand
const only = onlyComponents ?? (componentFlag ? [componentFlag] : undefined);

withLock(root, () => {
  try {
    const start = Date.now();
    let s = loadStateOrThrow(root);
    const analysis = loadAnalysis(analysisPath(root));
    if (!analysis) throw new Error('no analysis.json — run /compass-scan first');
    renderAnalysis(analysis, compassDir(root), only ? { onlyComponents: only } : undefined);
    s = s.phase === 'rendering' ? transitionPhase(s, 'done') : forcePhase(s, 'done');
    s.lock_holder = null;
    s.last_run_id = analysis.run_id;
    s.last_run_at = analysis.generated_at;
    s.stats.duration_ms = (s.stats.duration_ms ?? 0) + (Date.now() - start);
    saveState(statePath(root), s);
    console.log(`[compass] scan-render: wrote .compass/overview.md + ${analysis.components.length} component pages`);
    printCostLine('scan-render', 0, 0, Date.now() - start);
  } catch (err) {
    markFailed(root, err as Error);
    throw err;
  }
});
