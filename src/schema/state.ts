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

const SHA256_RE = /^[0-9a-f]{64}$/;
const SHORT_HEX_RE = /^[0-9a-f]{8}$/;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;
const COMPONENT_ID_RE = /^C\d+(?:\.\d+)?$/;
const SEMVER_PKG_RE = /^[^@]+@\d+\.\d+\.\d+/;
const ISO_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

export const FileEntrySchema = z.object({
  sha256: z.string().regex(SHA256_RE),
  mtime: z.string().regex(ISO_RE),
  component_id: z
    .string()
    .regex(COMPONENT_ID_RE)
    .nullable(),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

export const LockHolderSchema = z
  .object({
    pid: z.number().int().positive(),
    started_at: z.string().regex(ISO_RE),
  })
  .strict()
  .nullable();

export const StatsSchema = z
  .object({
    files_parsed: z.number().int().nonnegative(),
    files_skipped_ignore: z.number().int().nonnegative(),
    files_skipped_unchanged: z.number().int().nonnegative(),
    clusters_pre_llm: z.number().int().nonnegative(),
    components_post_llm: z.number().int().nonnegative(),
    llm_calls: z.number().int().nonnegative(),
    tokens_in_total: z.number().int().nonnegative(),
    tokens_out_total: z.number().int().nonnegative(),
    duration_ms: z.number().int().nonnegative(),
  })
  .strict();
export type Stats = z.infer<typeof StatsSchema>;

export const StateSchema = z
  .object({
    schema_version: z.literal(1),
    last_run_id: z.string().nullable(),
    last_run_at: z.string().nullable(),
    last_commit_sha: z.string().regex(COMMIT_SHA_RE).nullable(),
    depth: z.union([z.literal(1), z.literal(2)]),
    phase: PhaseSchema,
    phase_started_at: z.string().regex(ISO_RE),
    last_error: z.string().min(1).nullable(),
    lock_holder: LockHolderSchema,
    files: z.record(z.string(), FileEntrySchema),
    pins: z
      .object({
        louvain_pkg: z.string().regex(SEMVER_PKG_RE),
        louvain_seed: z.string().regex(SHORT_HEX_RE),
      })
      .strict(),
    stats: StatsSchema,
  })
  .strict()
  .refine(
    (s) => (s.phase === 'failed' ? typeof s.last_error === 'string' && s.last_error.length > 0 : s.last_error === null),
    {
      message:
        "phase=failed requires last_error to be a non-empty string; otherwise last_error must be null",
      path: ['last_error'],
    },
  );
export type State = z.infer<typeof StateSchema>;

export const LOUVAIN_PKG = 'graphology-communities-louvain@2.0.2';
