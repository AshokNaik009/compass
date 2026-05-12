import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const LOCK_STALE_MS = 10 * 60 * 1000;

export interface LockHolder {
  pid: number;
  started_at: string;
}

export interface AcquireResult {
  acquired: boolean;
  holder?: LockHolder;
  reason?: string;
}

function ensureDir(path: string) {
  const d = dirname(path);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // EPERM means a process exists we can't signal — still alive.
    return e.code === 'EPERM';
  }
}

function readHolder(lockPath: string): LockHolder | null {
  if (!existsSync(lockPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.pid === 'number' &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.started_at === 'string' &&
      parsed.started_at.length > 0 &&
      !Number.isNaN(Date.parse(parsed.started_at))
    ) {
      return { pid: parsed.pid, started_at: parsed.started_at };
    }
    return null;
  } catch {
    return null;
  }
}

export function isLockStale(holder: LockHolder): boolean {
  if (!isPidAlive(holder.pid)) return true;
  const age = Date.now() - new Date(holder.started_at).getTime();
  return age >= LOCK_STALE_MS;
}

export function acquireLock(lockPath: string): AcquireResult {
  ensureDir(lockPath);
  const existing = readHolder(lockPath);
  if (existing && !isLockStale(existing)) {
    return {
      acquired: false,
      reason: `another compass run in progress (pid ${existing.pid}, started_at ${existing.started_at}) — already held by a live PID`,
    };
  }
  const holder: LockHolder = { pid: process.pid, started_at: new Date().toISOString() };
  writeFileSync(lockPath, JSON.stringify(holder, null, 2));
  return { acquired: true, holder };
}

export function releaseLock(lockPath: string): void {
  if (!existsSync(lockPath)) return;
  const holder = readHolder(lockPath);
  if (holder && holder.pid !== process.pid) {
    throw new Error(
      `releaseLock: not our lock (held by pid ${holder.pid}, we are ${process.pid}) — foreign lock, refusing to clobber`,
    );
  }
  try {
    unlinkSync(lockPath);
  } catch {
    // ignore
  }
}
