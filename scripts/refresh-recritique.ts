#!/usr/bin/env -S npx tsx
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LlmProposalSchema, AnalysisSchema } from '../src/schema/analysis.ts';
import type { Component } from '../src/schema/analysis.ts';
import { claudeJson } from '../src/lib/claude.ts';
import { loadAnalysis, saveAnalysis } from '../src/lib/analysis.ts';
import { analysisPath, statePath, printCostLine } from '../src/lib/paths.ts';
import { saveState } from '../src/lib/state.ts';
import { withLock, loadStateOrThrow, markFailed } from '../src/lib/runner.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const root = process.cwd();
const argv = process.argv.slice(2);

function parseList(name: string): string[] {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return [];
  return (argv[idx + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

const components = parseList('components');
const PROMPT_TEMPLATE = readFileSync(join(__dirname, '..', 'src', 'prompts', 'refresh-recritique.md'), 'utf8');

withLock(root, async () => {
  try {
    const start = Date.now();
    const s = loadStateOrThrow(root);
    const existing = loadAnalysis(analysisPath(root));
    if (!existing) throw new Error('refresh-recritique: no analysis.json — run /compass-scan first');

    const affected = existing.components.filter((c) => components.includes(c.id));
    if (affected.length === 0) {
      console.log('[compass] refresh-recritique: no matching components');
      return;
    }

    const promptInput = {
      affected_components: affected,
      frozen_components: existing.components.filter((c) => !components.includes(c.id)).map((c) => ({ id: c.id, name: c.name })),
      edges: existing.edges,
    };
    const prompt = `${PROMPT_TEMPLATE}\n\n--- input ---\n${JSON.stringify(promptInput, null, 2)}`;

    const result = await claudeJson({ prompt, schema: LlmProposalSchema, phase: 'critique' });

    const byId = new Map(existing.components.map((c) => [c.id, c]));
    for (const lc of result.data.components) {
      byId.set(lc.id, { ...lc, depth: existing.depth } as Component);
    }
    const updated = {
      ...existing,
      generated_at: new Date().toISOString(),
      components: Array.from(byId.values()),
      llm: {
        model: existing.llm.model,
        calls: [
          ...existing.llm.calls,
          { phase: 'critique' as const, tokens_in: result.tokensIn, tokens_out: result.tokensOut, duration_ms: result.durationMs },
        ],
      },
    };

    saveAnalysis(analysisPath(root), AnalysisSchema.parse(updated));
    s.stats.llm_calls += 1;
    s.stats.tokens_in_total += result.tokensIn;
    s.stats.tokens_out_total += result.tokensOut;
    s.stats.duration_ms += Date.now() - start;
    saveState(statePath(root), s);
    console.log(`[compass] refresh-recritique: revised ${result.data.components.length} components`);
    printCostLine('refresh-recritique', result.tokensIn, result.tokensOut, result.durationMs);
  } catch (err) {
    markFailed(root, err as Error);
    throw err;
  }
});
