import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { LOUVAIN_PKG, PhaseSchema, StateSchema, type Phase, type State } from '../schema/state.ts';

export interface DefaultStateOpts {
  root: string;
  depth?: 1 | 2;
}

export interface TransitionOpts {
  now?: () => Date;
  error?: string;
}

const CANONICAL_ORDER: Phase[] = [
  'walking',
  'parsing',
  'clustering',
  'proposing',
  'critiquing',
  'rendering',
  'done',
];

function isCanonical(p: Phase): boolean {
  return CANONICAL_ORDER.includes(p);
}

export function projectSeed(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 8);
}

export function defaultState({ root, depth = 1 }: DefaultStateOpts): State {
  return {
    schema_version: 1,
    last_run_id: null,
    last_run_at: null,
    last_commit_sha: null,
    depth,
    phase: 'walking',
    phase_started_at: new Date().toISOString(),
    last_error: null,
    lock_holder: null,
    files: {},
    pins: {
      louvain_pkg: LOUVAIN_PKG,
      louvain_seed: projectSeed(root),
    },
    stats: {
      files_parsed: 0,
      files_skipped_ignore: 0,
      files_skipped_unchanged: 0,
      clusters_pre_llm: 0,
      components_post_llm: 0,
      llm_calls: 0,
      tokens_in_total: 0,
      tokens_out_total: 0,
      duration_ms: 0,
    },
  };
}

function ensureDir(path: string) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function archiveBroken(statePath: string, raw: string) {
  ensureDir(statePath);
  const broken = join(dirname(statePath), 'state.broken.json');
  writeFileSync(broken, raw);
}

export function loadState(statePath: string): State | null {
  if (!existsSync(statePath)) return null;
  const raw = readFileSync(statePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    archiveBroken(statePath, raw);
    return null;
  }
  const result = StateSchema.safeParse(parsed);
  if (!result.success) {
    archiveBroken(statePath, raw);
    return null;
  }
  return result.data;
}

export function saveState(statePath: string, state: State): void {
  // zod throws if invalid — before any disk touch.
  const validated = StateSchema.parse(state);
  ensureDir(statePath);
  const tmp = `${statePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(validated, null, 2));
  renameSync(tmp, statePath);
}

export function transitionPhase(state: State, next: Phase, opts: TransitionOpts = {}): State {
  PhaseSchema.parse(next);

  if (next === 'failed') {
    if (!opts.error || opts.error.length === 0) {
      throw new Error('transitionPhase: phase=failed requires opts.error (last_error must be non-empty)');
    }
  }

  // Forbid the canonical-order backward jump that the spec singles out:
  // done → walking is a reset, which must be explicit (caller writes a fresh state).
  if (isCanonical(state.phase) && isCanonical(next)) {
    const from = CANONICAL_ORDER.indexOf(state.phase);
    const to = CANONICAL_ORDER.indexOf(next);
    if (state.phase === 'done' && next !== 'done') {
      throw new Error(`transitionPhase: refusing backward transition from done → ${next}; reset state explicitly`);
    }
    if (from > to && state.phase !== 'failed') {
      throw new Error(`transitionPhase: refusing backward transition from ${state.phase} → ${next}; reset state explicitly`);
    }
  }

  const now = (opts.now ?? (() => new Date()))().toISOString();
  return {
    ...state,
    phase: next,
    phase_started_at: now,
    last_error: next === 'failed' ? (opts.error as string) : null,
  };
}

// Bypass for /compass-recover: set phase without monotonic validation.
export function forcePhase(state: State, next: Phase, opts: TransitionOpts = {}): State {
  PhaseSchema.parse(next);
  if (next === 'failed' && (!opts.error || opts.error.length === 0)) {
    throw new Error('forcePhase: phase=failed requires opts.error');
  }
  const now = (opts.now ?? (() => new Date()))().toISOString();
  return {
    ...state,
    phase: next,
    phase_started_at: now,
    last_error: next === 'failed' ? (opts.error as string) : null,
  };
}

export function generateRunId(date: Date = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}
