/**
 * SPEC.md §5.2 / §6 step 1 — .compass/.lock pidfile, single-writer.
 *  - acquire creates the lock with my pid and ISO start time
 *  - acquire refuses when held by a live PID
 *  - acquire takes over a stale lock (> 10 minutes old) OR a dead PID
 *  - release deletes the file
 *  - acquireOrThrow surfaces a useful error message for the user
 *  - lock_holder is mirrored into state.json (state.json field)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { acquireLock, releaseLock, isLockStale, LOCK_STALE_MS } from '../../../src/lib/lock.js';
import { makeTmpRepo, type TmpRepo } from '../../helpers/tmp.js';

let r: TmpRepo;
beforeEach(() => { r = makeTmpRepo(); });
afterEach(() => r.cleanup());

const LOCK = () => r.path('.compass/.lock');

describe('acquireLock — happy path', () => {
  it('creates .compass/.lock with the current PID and started_at', () => {
    const got = acquireLock(LOCK());
    expect(got.acquired).toBe(true);
    const body = JSON.parse(readFileSync(LOCK(), 'utf8'));
    expect(body.pid).toBe(process.pid);
    expect(body.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns the parsed lock body so the caller can mirror to state.json', () => {
    const got = acquireLock(LOCK());
    expect(got.holder?.pid).toBe(process.pid);
  });

  it('creates the .compass directory if missing', () => {
    const got = acquireLock(LOCK());
    expect(got.acquired).toBe(true);
    expect(existsSync(r.path('.compass'))).toBe(true);
  });
});

describe('acquireLock — refusal on live holder', () => {
  it('refuses when the lock file holds a PID that is alive', () => {
    // process.pid is always alive
    writeFileSync(LOCK(), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    r.mkdir('.compass');
    const got = acquireLock(LOCK());
    expect(got.acquired).toBe(false);
    expect(got.reason).toMatch(/in progress|live pid|already held/i);
  });

  it('reports the conflicting PID in the refusal reason (helps the user diagnose)', () => {
    writeFileSync(LOCK(), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    r.mkdir('.compass');
    const got = acquireLock(LOCK());
    expect(got.reason).toContain(String(process.pid));
  });
});

describe('acquireLock — stale takeover (SPEC §6 step 1)', () => {
  it('takes over a lock older than the 10-minute threshold', () => {
    r.mkdir('.compass');
    const elevenMinAgo = new Date(Date.now() - (LOCK_STALE_MS + 1000)).toISOString();
    writeFileSync(LOCK(), JSON.stringify({ pid: 999999, started_at: elevenMinAgo }));
    const got = acquireLock(LOCK());
    expect(got.acquired).toBe(true);
    expect(got.holder?.pid).toBe(process.pid);
  });

  it('takes over a lock whose PID is no longer alive (even if recent)', () => {
    r.mkdir('.compass');
    const recentTs = new Date(Date.now() - 1000).toISOString();
    // 999999 is almost certainly not running
    writeFileSync(LOCK(), JSON.stringify({ pid: 999999, started_at: recentTs }));
    const got = acquireLock(LOCK());
    expect(got.acquired).toBe(true);
  });

  it("won't take over a recent lock with a live PID (the common 'another run in progress' case)", () => {
    r.mkdir('.compass');
    writeFileSync(LOCK(), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    const got = acquireLock(LOCK());
    expect(got.acquired).toBe(false);
  });
});

describe('acquireLock — malformed lock file', () => {
  it('treats a malformed lock as stale and takes over (no manual cleanup needed)', () => {
    r.mkdir('.compass');
    writeFileSync(LOCK(), 'definitely not json');
    const got = acquireLock(LOCK());
    expect(got.acquired).toBe(true);
  });

  it('treats a lock file with missing fields as stale', () => {
    r.mkdir('.compass');
    writeFileSync(LOCK(), JSON.stringify({ /* no pid */ started_at: 'x' }));
    const got = acquireLock(LOCK());
    expect(got.acquired).toBe(true);
  });
});

describe('releaseLock', () => {
  it('deletes the lock file', () => {
    acquireLock(LOCK());
    releaseLock(LOCK());
    expect(existsSync(LOCK())).toBe(false);
  });

  it('is a no-op when the lock file is missing (idempotent — safe in finally blocks)', () => {
    expect(() => releaseLock(LOCK())).not.toThrow();
  });

  it("only releases locks we hold; refuses to clobber a different PID's lock", () => {
    r.mkdir('.compass');
    writeFileSync(LOCK(), JSON.stringify({ pid: 123456, started_at: new Date().toISOString() }));
    expect(() => releaseLock(LOCK())).toThrow(/not our lock|foreign/i);
    expect(existsSync(LOCK())).toBe(true);
  });
});

describe('isLockStale', () => {
  it('returns true for a 10-min-1ms-old lock', () => {
    expect(isLockStale({ pid: process.pid, started_at: new Date(Date.now() - LOCK_STALE_MS - 1).toISOString() })).toBe(true);
  });

  it('returns false for a fresh lock with a live pid', () => {
    expect(isLockStale({ pid: process.pid, started_at: new Date().toISOString() })).toBe(false);
  });

  it('returns true when the pid is dead, regardless of age', () => {
    expect(isLockStale({ pid: 999999, started_at: new Date().toISOString() })).toBe(true);
  });
});

describe('LOCK_STALE_MS — pin the SPEC contract (>10min)', () => {
  it('is exactly 10 minutes in milliseconds', () => {
    expect(LOCK_STALE_MS).toBe(10 * 60 * 1000);
  });
});
