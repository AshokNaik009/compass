import { acquireLock, releaseLock } from './lock.ts';
import { loadState, saveState, forcePhase } from './state.ts';
import { lockPath, statePath } from './paths.ts';
import type { State } from '../schema/state.ts';

export interface Runner {
  root: string;
  /** Save state with `phase=failed` and exit non-zero. */
  fail(error: Error): never;
  done(): void;
}

export function withLock<T>(root: string, run: (release: () => void) => T): T {
  const lock = acquireLock(lockPath(root));
  if (!lock.acquired) {
    throw new Error(lock.reason ?? 'failed to acquire lock');
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      releaseLock(lockPath(root));
    } catch {
      // ignore
    }
  };
  try {
    return run(release);
  } finally {
    release();
  }
}

export function markFailed(root: string, error: Error): void {
  try {
    const s = loadState(statePath(root));
    if (!s) return;
    const next = forcePhase(s, 'failed', { error: error.message.slice(0, 500) });
    saveState(statePath(root), next);
  } catch {
    // ignore — best-effort persistence
  }
}

export function loadStateOrThrow(root: string): State {
  const s = loadState(statePath(root));
  if (!s) throw new Error(`no compass state at ${statePath(root)} — run /compass-scan first`);
  return s;
}
