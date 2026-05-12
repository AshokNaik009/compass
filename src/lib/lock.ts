import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { lockPath, ensureCompassDir } from './state.ts';

interface LockFile {
  pid: number;
  started_at: string;
}

const STALE_MS = 10 * 60 * 1000;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return e.code === 'EPERM';
  }
}

export function readLock(root: string): LockFile | null {
  const p = lockPath(root);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as LockFile;
  } catch {
    return null;
  }
}

export class CompassLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompassLockError';
  }
}

export function acquireLock(root: string): LockFile {
  ensureCompassDir(root);
  const p = lockPath(root);
  const existing = readLock(root);
  if (existing) {
    const age = Date.now() - new Date(existing.started_at).getTime();
    if (isPidAlive(existing.pid) && age < STALE_MS) {
      throw new CompassLockError(
        `another compass run in progress (pid ${existing.pid}, started ${existing.started_at})`,
      );
    }
    // Stale or dead — take over.
  }
  const lock: LockFile = { pid: process.pid, started_at: new Date().toISOString() };
  writeFileSync(p, JSON.stringify(lock, null, 2));
  return lock;
}

export function releaseLock(root: string) {
  const p = lockPath(root);
  if (existsSync(p)) {
    try {
      unlinkSync(p);
    } catch {
      // ignore
    }
  }
}

export function isLockStale(lock: LockFile): boolean {
  const age = Date.now() - new Date(lock.started_at).getTime();
  return !isPidAlive(lock.pid) || age >= STALE_MS;
}
