import { z } from 'zod';

export const ConfidenceSchema = z.enum(['high', 'medium', 'low']);

export const ComponentSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  rationale: z.string(),
  files: z.array(z.string()),
  symbols: z.array(z.string()),
  depth: z.number().int().min(1).max(2),
  subgraph_ref: z.string().nullable(),
  confidence: ConfidenceSchema,
});
export type Component = z.infer<typeof ComponentSchema>;

export const ComponentEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  weight: z.number(),
  reason: z.string(),
});
export type ComponentEdge = z.infer<typeof ComponentEdgeSchema>;

export const SubgraphSchema = z.object({
  components: z.array(ComponentSchema),
  edges: z.array(ComponentEdgeSchema),
});
export type Subgraph = z.infer<typeof SubgraphSchema>;

export const LlmCallSchema = z.object({
  phase: z.enum(['propose', 'critique', 'refresh-critique', 'expand-propose', 'expand-critique']),
  tokens_in: z.number(),
  tokens_out: z.number(),
  duration_ms: z.number(),
});
export type LlmCall = z.infer<typeof LlmCallSchema>;

export const ProjectSchema = z.object({
  name: z.string(),
  root: z.string(),
  languages: z.array(z.string()),
  file_count: z.number(),
  loc: z.number(),
});

export const AnalysisSchema = z.object({
  schema_version: z.literal(1),
  run_id: z.string(),
  generated_at: z.string(),
  depth: z.number().int().min(1).max(2),
  precision: z.enum(['imports-only', 'imports+lsp']),
  project: ProjectSchema,
  components: z.array(ComponentSchema),
  edges: z.array(ComponentEdgeSchema),
  subgraphs: z.record(z.string(), SubgraphSchema).default({}),
  llm: z.object({
    model: z.string(),
    calls: z.array(LlmCallSchema),
  }),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

// Schema used to validate the LLM's propose/critique output.
export const LlmProposalSchema = z.object({
  components: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      rationale: z.string(),
      file_ids: z.array(z.string()),
      confidence: ConfidenceSchema,
    }),
  ),
  edges: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      reason: z.string(),
    }),
  ),
});
export type LlmProposal = z.infer<typeof LlmProposalSchema>;
