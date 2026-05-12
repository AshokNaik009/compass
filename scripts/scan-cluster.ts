#!/usr/bin/env -S npx tsx
import { readFileSync, writeFileSync } from 'node:fs';
import { buildGraph, preCluster, mergeToCap } from '../src/lib/graph.ts';
import { transitionPhase, forcePhase, saveState } from '../src/lib/state.ts';
import {
  statePath,
  graphSidecarPath,
  clustersSidecarPath,
  parseScopeArg,
} from '../src/lib/paths.ts';
import { withLock, loadStateOrThrow, markFailed } from '../src/lib/runner.ts';
import { printCostLine } from '../src/lib/paths.ts';

const root = process.cwd();
const argv = process.argv.slice(2);
const scope = parseScopeArg(argv, 'scope'); // optional: cluster only files inside scope component

withLock(root, () => {
  try {
    const start = Date.now();
    let s = loadStateOrThrow(root);
    const side = JSON.parse(readFileSync(graphSidecarPath(root), 'utf8')) as {
      fileImports: Array<{ from: string; to: string | null; usedCount: number; typeOnly: boolean }>;
    };

    let imports = side.fileImports;
    if (scope) {
      const inScope = new Set<string>();
      for (const [rel, entry] of Object.entries(s.files)) {
        if (entry.component_id === scope) inScope.add(rel);
      }
      imports = imports.filter((i) => inScope.has(i.from) && (i.to == null || inScope.has(i.to)));
    }

    const graph = buildGraph(imports);
    let clusters = preCluster(graph, s.pins.louvain_seed);
    clusters = mergeToCap(clusters, graph, 12);

    writeFileSync(clustersSidecarPath(root), JSON.stringify(clusters, null, 2));

    s.stats.clusters_pre_llm = new Set(Object.values(clusters)).size;
    s = s.phase === 'clustering' ? transitionPhase(s, 'proposing') : forcePhase(s, 'proposing');
    s.stats.duration_ms = (s.stats.duration_ms ?? 0) + (Date.now() - start);
    saveState(statePath(root), s);
    console.log(`[compass] scan-cluster: ${s.stats.clusters_pre_llm} pre-LLM clusters`);
    printCostLine('scan-cluster', 0, 0, Date.now() - start);
  } catch (err) {
    markFailed(root, err as Error);
    throw err;
  }
});
