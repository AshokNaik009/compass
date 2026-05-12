import { z } from 'zod';

export const PhaseSchema = z.enum([
  'walking',
  'parsing',
  'clustering',
  'proposing',
  'critiquing',
  'rendering',
  'done',
  'failed',
]);
export type Phase = z.infer<typeof PhaseSchema>;

export const FileEntrySchema = z.object({
  sha256: z.string(),
  mtime: z.string(),
  component_id: z.string().nullable(),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

export const LockHolderSchema = z
  .object({
    pid: z.number(),
    started_at: z.string(),
  })
  .nullable();

export const ImportEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  weight: z.number(),
  resolved: z.boolean(),
});
export type ImportEdge = z.infer<typeof ImportEdgeSchema>;

export const PreClusterSchema = z.object({
  cluster_id: z.string(),
  files: z.array(z.string()),
});
export type PreCluster = z.infer<typeof PreClusterSchema>;

export const StatsSchema = z.object({
  files_parsed: z.number().default(0),
  files_skipped_ignore: z.number().default(0),
  files_skipped_unchanged: z.number().default(0),
  clusters_pre_llm: z.number().default(0),
  components_post_llm: z.number().default(0),
  llm_calls: z.number().default(0),
  tokens_in_total: z.number().default(0),
  tokens_out_total: z.number().default(0),
  duration_ms: z.number().default(0),
});
export type Stats = z.infer<typeof StatsSchema>;

export const StateSchema = z.object({
  schema_version: z.literal(1),
  last_run_id: z.string().nullable(),
  last_run_at: z.string().nullable(),
  last_commit_sha: z.string().nullable(),
  depth: z.number().int().min(1).max(2),
  phase: PhaseSchema,
  phase_started_at: z.string(),
  last_error: z.string().nullable(),
  lock_holder: LockHolderSchema,
  files: z.record(z.string(), FileEntrySchema),
  pre_clusters: z.array(PreClusterSchema).default([]),
  import_edges: z.array(ImportEdgeSchema).default([]),
  pins: z.object({
    louvain_pkg: z.string(),
    louvain_seed: z.string(),
  }),
  stats: StatsSchema,
});
export type State = z.infer<typeof StateSchema>;

export const LOUVAIN_PKG = 'graphology-communities-louvain@2.0.2';
