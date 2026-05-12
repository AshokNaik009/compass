#!/usr/bin/env -S npx tsx
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { LlmProposalSchema } from '../src/schema/analysis.ts';
import { claudeJson } from '../src/lib/claude.ts';
import { transitionPhase, forcePhase, saveState } from '../src/lib/state.ts';
import {
  statePath,
  graphSidecarPath,
  clustersSidecarPath,
  proposalSidecarPath,
  parseScopeArg,
  printCostLine,
} from '../src/lib/paths.ts';
import { withLock, loadStateOrThrow, markFailed } from '../src/lib/runner.ts';

const root = process.cwd();
const argv = process.argv.slice(2);
const scope = parseScopeArg(argv, 'scope');
const PROMPT_TEMPLATE = readFileSync(join(__dirname, '..', 'src', 'prompts', 'propose-clusters.md'), 'utf8');

withLock(root, async () => {
  try {
    const start = Date.now();
    let s = loadStateOrThrow(root);
    const clusters: Record<string, number> = JSON.parse(
      readFileSync(clustersSidecarPath(root), 'utf8'),
    );
    const side = JSON.parse(readFileSync(graphSidecarPath(root), 'utf8')) as {
      fileImports: Array<{ from: string; to: string | null; usedCount: number; typeOnly: boolean }>;
      exportsByFile: Record<string, string[]>;
    };

    // Group files by cluster
    const byCluster = new Map<number, string[]>();
    for (const [rel, cid] of Object.entries(clusters)) {
      const arr = byCluster.get(cid) ?? [];
      arr.push(rel);
      byCluster.set(cid, arr);
    }

    // Inter-cluster edges
    const edgeAcc = new Map<string, { from: number; to: number; weight: number }>();
    for (const fi of side.fileImports) {
      if (!fi.to || fi.to.startsWith('external:')) continue;
      const a = clusters[fi.from];
      const b = clusters[fi.to];
      if (a == null || b == null || a === b) continue;
      const key = `${a}->${b}`;
      const prev = edgeAcc.get(key);
      if (prev) prev.weight += fi.usedCount;
      else edgeAcc.set(key, { from: a, to: b, weight: fi.usedCount });
    }

    const payload = {
      depth: s.depth,
      clusters: Array.from(byCluster.entries()).map(([cid, files], i) => ({
        cluster_label: `pre_cluster_${i}_${cid}`,
        files,
        sample_symbols: files.slice(0, 5).flatMap((f) => side.exportsByFile[f] ?? []).slice(0, 12),
      })),
      edges: Array.from(edgeAcc.values()),
    };
    const prompt = `${PROMPT_TEMPLATE}\n\nScope: ${scope ?? 'top-level'}\n\n--- pre-cluster snapshot ---\n${JSON.stringify(payload, null, 2)}`;
    const result = await claudeJson({
      prompt,
      schema: LlmProposalSchema,
      phase: 'propose',
    });

    writeFileSync(proposalSidecarPath(root), JSON.stringify(result.data, null, 2));
    s.stats.llm_calls += 1;
    s.stats.tokens_in_total += result.tokensIn;
    s.stats.tokens_out_total += result.tokensOut;
    s = s.phase === 'proposing' ? transitionPhase(s, 'critiquing') : forcePhase(s, 'critiquing');
    s.stats.duration_ms = (s.stats.duration_ms ?? 0) + (Date.now() - start);
    saveState(statePath(root), s);
    console.log(`[compass] scan-propose: ${result.data.components.length} draft components`);
    printCostLine('scan-propose', result.tokensIn, result.tokensOut, result.durationMs);
  } catch (err) {
    markFailed(root, err as Error);
    throw err;
  }
});
