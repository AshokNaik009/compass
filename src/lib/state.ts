import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { StateSchema, type State, type Phase, LOUVAIN_PKG } from '../schema/state.ts';

export const COMPASS_DIR = '.compass';
export const STATE_PATH = join(COMPASS_DIR, 'state.json');
export const ANALYSIS_PATH = join(COMPASS_DIR, 'analysis.json');
export const LOCK_PATH = join(COMPASS_DIR, '.lock');
export const STATE_BROKEN_PATH = join(COMPASS_DIR, 'state.broken.json');

export function ensureCompassDir(root: string) {
  const dir = join(root, COMPASS_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function statePath(root: string) {
  return join(root, STATE_PATH);
}

export function analysisPath(root: string) {
  return join(root, ANALYSIS_PATH);
}

export function lockPath(root: string) {
  return join(root, LOCK_PATH);
}

export function loadState(root: string): State {
  const p = statePath(root);
  if (!existsSync(p)) throw new Error(`no compass state found at ${p}`);
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  const parsed = StateSchema.safeParse(raw);
  if (!parsed.success) {
    // Archive the broken state so the user can inspect.
    const broken = join(root, STATE_BROKEN_PATH);
    writeFileSync(broken, JSON.stringify(raw, null, 2));
    throw new Error(
      `state.json failed schema validation, archived to ${broken}: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

export function loadStateOrNull(root: string): State | null {
  try {
    return loadState(root);
  } catch {
    return null;
  }
}

export function saveState(root: string, state: State) {
  ensureCompassDir(root);
  const p = statePath(root);
  const tmp = `${p}.tmp`;
  const parsed = StateSchema.parse(state); // throws on invalid
  writeFileSync(tmp, JSON.stringify(parsed, null, 2));
  renameSync(tmp, p); // atomic on POSIX
}

export function projectSeed(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 8);
}

export function initialState(root: string, depth: number): State {
  return {
    schema_version: 1,
    last_run_id: null,
    last_run_at: null,
    last_commit_sha: null,
    depth: Math.max(1, Math.min(2, depth)) as 1 | 2,
    phase: 'walking',
    phase_started_at: new Date().toISOString(),
    last_error: null,
    lock_holder: null,
    files: {},
    pre_clusters: [],
    import_edges: [],
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

export function setPhase(state: State, phase: Phase, error?: string | null): State {
  return {
    ...state,
    phase,
    phase_started_at: new Date().toISOString(),
    last_error: phase === 'failed' ? error ?? state.last_error : null,
  };
}

export function generateRunId(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

export function relativeFromRoot(root: string, abs: string): string {
  if (abs.startsWith(root + '/')) return abs.slice(root.length + 1);
  return abs;
}

// Re-export helpers for scripts.
export { dirname };
