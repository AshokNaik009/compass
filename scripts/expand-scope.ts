#!/usr/bin/env -S npx tsx
import { readFileSync, writeFileSync } from 'node:fs';
import { loadAnalysis } from '../src/lib/analysis.ts';
import { saveState } from '../src/lib/state.ts';
import { analysisPath, statePath, graphSidecarPath, parseScopeArg } from '../src/lib/paths.ts';
import { withLock, loadStateOrThrow, markFailed } from '../src/lib/runner.ts';

const root = process.cwd();
const argv = process.argv.slice(2);
const componentId = parseScopeArg(argv, 'component');

withLock(root, () => {
  try {
    if (!componentId) throw new Error('expand-scope: --component <id> is required');
    const s = loadStateOrThrow(root);
    const analysis = loadAnalysis(analysisPath(root));
    if (!analysis) throw new Error('expand-scope: no analysis.json');
    const target = analysis.components.find((c) => c.id === componentId);
    if (!target) throw new Error(`expand-scope: ${componentId} not found`);

    // Make sure state.files[*].component_id reflects the analysis (so scan-cluster --scope sees membership).
    for (const f of target.files) {
      if (s.files[f]) s.files[f] = { ...s.files[f], component_id: componentId };
    }
    saveState(statePath(root), s);

    // Filter graph.json to just edges within the scope
    const side = JSON.parse(readFileSync(graphSidecarPath(root), 'utf8')) as {
      fileImports: Array<{ from: string; to: string | null; usedCount: number; typeOnly: boolean }>;
      exportsByFile: Record<string, string[]>;
    };
    const scoped = side.fileImports.filter((fi) => target.files.includes(fi.from));
    // No write — scan-cluster --scope reads state.files and filters using component_id.
    console.log(`[compass] expand-scope: scoped ${target.files.length} files (${scoped.length} edges)`);
  } catch (err) {
    markFailed(root, err as Error);
    throw err;
  }
});
