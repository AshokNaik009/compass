#!/usr/bin/env -S npx tsx
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { LlmProposalSchema, AnalysisSchema } from '../src/schema/analysis.ts';
import type { Analysis, Component, ComponentEdge } from '../src/schema/analysis.ts';
import { claudeJson } from '../src/lib/claude.ts';
import { transitionPhase, forcePhase, saveState, generateRunId } from '../src/lib/state.ts';
import { saveAnalysis, loadAnalysis } from '../src/lib/analysis.ts';
import {
  statePath,
  analysisPath,
  proposalSidecarPath,
  parseScopeArg,
  printCostLine,
} from '../src/lib/paths.ts';
import { withLock, loadStateOrThrow, markFailed } from '../src/lib/runner.ts';

const root = process.cwd();
const argv = process.argv.slice(2);
const scope = parseScopeArg(argv, 'scope');
const PROMPT_TEMPLATE = readFileSync(join(__dirname, '..', 'src', 'prompts', 'critique-clusters.md'), 'utf8');

withLock(root, async () => {
  try {
    const start = Date.now();
    let s = loadStateOrThrow(root);
    const proposal = JSON.parse(readFileSync(proposalSidecarPath(root), 'utf8'));

    const prompt = `${PROMPT_TEMPLATE}\n\nScope: ${scope ?? 'top-level'}\n\n--- propose pass output (draft) ---\n${JSON.stringify(proposal, null, 2)}`;
    const result = await claudeJson({
      prompt,
      schema: LlmProposalSchema,
      phase: 'critique',
    });

    // Compose analysis.json: merge with existing for sub-scope cases (expand).
    const existing = existsSync(analysisPath(root)) ? loadAnalysis(analysisPath(root)) : null;

    const llmComponents = result.data.components;
    const llmEdges = result.data.edges;

    let analysis: Analysis;
    if (scope && existing) {
      // expand path: write subgraphs[scope]
      const subComponents: Component[] = llmComponents.map((c) => ({
        ...c,
        depth: 2,
      }));
      const subEdges: ComponentEdge[] = llmEdges.map((e) => ({
        from: e.from,
        to: e.to,
        weight: e.weight ?? 1,
        reason: e.reason,
      }));
      analysis = {
        ...existing,
        generated_at: new Date().toISOString(),
        depth: 2,
        subgraphs: { ...existing.subgraphs, [scope]: { components: subComponents, edges: subEdges } },
        llm: {
          model: existing.llm.model,
          calls: [
            ...existing.llm.calls,
            { phase: 'critique', tokens_in: result.tokensIn, tokens_out: result.tokensOut, duration_ms: result.durationMs },
          ],
        },
      };
      // Mark parent component subgraph_ref
      analysis.components = analysis.components.map((c) =>
        c.id === scope ? { ...c, subgraph_ref: scope } : c,
      );
    } else if (existing && scope == null && argv.includes('--components')) {
      // refresh recritique: merge revised components by id; keep others.
      const byId = new Map(existing.components.map((c) => [c.id, c]));
      for (const lc of llmComponents) byId.set(lc.id, { ...lc, depth: existing.depth });
      analysis = {
        ...existing,
        generated_at: new Date().toISOString(),
        components: Array.from(byId.values()),
        edges: llmEdges.map((e) => ({ from: e.from, to: e.to, weight: e.weight ?? 1, reason: e.reason })),
        llm: {
          model: existing.llm.model,
          calls: [
            ...existing.llm.calls,
            { phase: 'critique', tokens_in: result.tokensIn, tokens_out: result.tokensOut, duration_ms: result.durationMs },
          ],
        },
      };
    } else {
      // Full scan path: write fresh analysis with both propose+critique calls.
      const components: Component[] = llmComponents.map((c) => ({
        ...c,
        depth: s.depth,
      }));
      const edges: ComponentEdge[] = llmEdges.map((e) => ({
        from: e.from,
        to: e.to,
        weight: e.weight ?? 1,
        reason: e.reason,
      }));
      analysis = {
        schema_version: 1,
        run_id: s.last_run_id ?? generateRunId(),
        generated_at: new Date().toISOString(),
        depth: s.depth,
        precision: 'imports-only',
        project: {
          name: basename(root),
          root,
          languages: ['typescript', 'javascript'],
          file_count: Object.keys(s.files).length,
          loc: 0,
        },
        components,
        edges,
        subgraphs: {},
        llm: {
          model: 'claude-opus-4-7',
          calls: [
            // The propose pass tokens are already captured in stats; the propose
            // step writes a sidecar without persisting an LlmCall, so we synthesize
            // an approximate entry from the stats delta.
            { phase: 'propose', tokens_in: Math.max(1, s.stats.tokens_in_total), tokens_out: Math.max(1, s.stats.tokens_out_total), duration_ms: Math.max(0, s.stats.duration_ms) },
            { phase: 'critique', tokens_in: result.tokensIn, tokens_out: result.tokensOut, duration_ms: result.durationMs },
          ],
        },
      };
    }

    saveAnalysis(analysisPath(root), AnalysisSchema.parse(analysis));

    // Update state.files[].component_id from the final analysis
    const fileToComp: Record<string, string> = {};
    for (const c of analysis.components) {
      for (const f of c.files) fileToComp[f] = c.id;
    }
    for (const rel of Object.keys(s.files)) {
      const cid = fileToComp[rel] ?? null;
      s.files[rel] = { ...s.files[rel], component_id: cid };
    }

    s.stats.components_post_llm = analysis.components.length;
    s.stats.llm_calls += 1;
    s.stats.tokens_in_total += result.tokensIn;
    s.stats.tokens_out_total += result.tokensOut;
    s = s.phase === 'critiquing' ? transitionPhase(s, 'rendering') : forcePhase(s, 'rendering');
    s.stats.duration_ms = (s.stats.duration_ms ?? 0) + (Date.now() - start);
    saveState(statePath(root), s);
    console.log(`[compass] scan-critique: ${analysis.components.length} final components`);
    printCostLine('scan-critique', result.tokensIn, result.tokensOut, result.durationMs);
  } catch (err) {
    markFailed(root, err as Error);
    throw err;
  }
});
