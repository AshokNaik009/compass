import { z } from 'zod';

export const ConfidenceSchema = z.enum(['high', 'medium', 'low']);

const COMPONENT_ID_RE = /^C\d+(?:\.\d+)?$/;
const ISO_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

export const ComponentSchema = z
  .object({
    id: z.string().regex(COMPONENT_ID_RE),
    name: z.string().min(1),
    description: z.string(),
    rationale: z.string().min(1),
    files: z.array(z.string()).nonempty(),
    symbols: z.array(z.string()),
    depth: z.union([z.literal(1), z.literal(2)]),
    subgraph_ref: z.string().regex(COMPONENT_ID_RE).nullable(),
    confidence: ConfidenceSchema,
  })
  .strict();
export type Component = z.infer<typeof ComponentSchema>;

export const ComponentEdgeSchema = z
  .object({
    from: z.string().regex(COMPONENT_ID_RE),
    to: z.string().regex(COMPONENT_ID_RE),
    weight: z.number().positive(),
    reason: z.string().min(1),
  })
  .strict()
  .refine((e) => e.from !== e.to, {
    message: 'edge from a component to itself is not allowed',
    path: ['to'],
  });
export type ComponentEdge = z.infer<typeof ComponentEdgeSchema>;

export const SubgraphSchema = z
  .object({
    components: z.array(ComponentSchema),
    edges: z.array(ComponentEdgeSchema),
  })
  .strict();
export type Subgraph = z.infer<typeof SubgraphSchema>;

export const LlmCallSchema = z
  .object({
    phase: z.enum(['propose', 'critique']),
    tokens_in: z.number().int().nonnegative(),
    tokens_out: z.number().int().nonnegative(),
    duration_ms: z.number().int().nonnegative(),
  })
  .strict();
export type LlmCall = z.infer<typeof LlmCallSchema>;

export const ProjectSchema = z
  .object({
    name: z.string(),
    root: z.string(),
    languages: z.array(z.string()),
    file_count: z.number().int().nonnegative(),
    loc: z.number().int().nonnegative(),
  })
  .strict();
export type Project = z.infer<typeof ProjectSchema>;

export const AnalysisSchema = z
  .object({
    schema_version: z.literal(1),
    run_id: z.string(),
    generated_at: z.string().regex(ISO_RE),
    depth: z.union([z.literal(1), z.literal(2)]),
    precision: z.enum(['imports-only', 'imports+lsp']),
    project: ProjectSchema,
    components: z.array(ComponentSchema),
    edges: z.array(ComponentEdgeSchema),
    subgraphs: z.record(z.string(), SubgraphSchema),
    llm: z
      .object({
        model: z.string(),
        calls: z.array(LlmCallSchema),
      })
      .strict(),
  })
  .strict();
export type Analysis = z.infer<typeof AnalysisSchema>;

// Schema used to validate raw LLM propose/critique output before mapping to
// the strict ComponentSchema. The LLM's payload mirrors ComponentSchema; the
// rationale-array on top is allowed but not required.
export const LlmComponentSchema = z.object({
  id: z.string().regex(COMPONENT_ID_RE),
  name: z.string().min(1),
  description: z.string(),
  rationale: z.string().min(1),
  files: z.array(z.string()).nonempty(),
  symbols: z.array(z.string()),
  depth: z.union([z.literal(1), z.literal(2)]),
  subgraph_ref: z.string().regex(COMPONENT_ID_RE).nullable(),
  confidence: ConfidenceSchema,
});

export const LlmProposalSchema = z
  .object({
    components: z.array(LlmComponentSchema).nonempty(),
    edges: z.array(
      z.object({
        from: z.string().regex(COMPONENT_ID_RE),
        to: z.string().regex(COMPONENT_ID_RE),
        weight: z.number().positive().optional(),
        reason: z.string().min(1),
      }),
    ),
    rationale: z.array(z.string()).optional(),
  })
  .passthrough();
export type LlmProposal = z.infer<typeof LlmProposalSchema>;
