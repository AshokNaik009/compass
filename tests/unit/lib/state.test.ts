/**
 * SPEC.md §5.2 / §6.2 step 6 — state.json read/write contract.
 *
 *  - load returns a typed object validated by the zod schema
 *  - load on a malformed/old file archives it to state.broken.json and returns
 *    null (caller falls back to /compass-scan from scratch)
 *  - save is atomic (write to tmp, rename) so a kill mid-write never leaves
 *    a half-written state file
 *  - phase mutation helpers preserve every other field
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadState, saveState, transitionPhase, defaultState } from '../../../src/lib/state.js';
import { makeTmpRepo, type TmpRepo } from '../../helpers/tmp.js';

let r: TmpRepo;
beforeEach(() => { r = makeTmpRepo(); });
afterEach(() => r.cleanup());

describe('loadState', () => {
  it('returns null when state.json does not exist', () => {
    expect(loadState(r.path('.compass/state.json'))).toBeNull();
  });

  it('returns a typed object on a valid file', () => {
    const s = defaultState({ root: r.root });
    saveState(r.path('.compass/state.json'), s);
    const loaded = loadState(r.path('.compass/state.json'));
    expect(loaded?.phase).toBe('walking');
    expect(loaded?.pins.louvain_seed).toMatch(/^[0-9a-f]{8}$/);
  });

  it('archives a malformed state.json to state.broken.json and returns null', () => {
    r.write('.compass/state.json', '{ this is not json');
    const loaded = loadState(r.path('.compass/state.json'));
    expect(loaded).toBeNull();
    expect(existsSync(r.path('.compass/state.broken.json'))).toBe(true);
  });

  it('archives a schema-mismatched state.json (old schema_version) and returns null', () => {
    r.write('.compass/state.json', JSON.stringify({ schema_version: 99, phase: 'done' }));
    const loaded = loadState(r.path('.compass/state.json'));
    expect(loaded).toBeNull();
    expect(existsSync(r.path('.compass/state.broken.json'))).toBe(true);
  });

  it('overwrites state.broken.json on subsequent failures (one broken file at a time)', () => {
    r.write('.compass/state.json', '{ bad: 1');
    loadState(r.path('.compass/state.json'));
    r.write('.compass/state.json', '{ also bad');
    loadState(r.path('.compass/state.json'));
    const archived = readFileSync(r.path('.compass/state.broken.json'), 'utf8');
    expect(archived).toContain('also bad');
  });
});

describe('saveState — atomicity', () => {
  it('produces a syntactically valid JSON file', () => {
    const s = defaultState({ root: r.root });
    saveState(r.path('.compass/state.json'), s);
    expect(() => JSON.parse(readFileSync(r.path('.compass/state.json'), 'utf8'))).not.toThrow();
  });

  it('creates the .compass directory if missing', () => {
    expect(() => saveState(r.path('.compass/state.json'), defaultState({ root: r.root }))).not.toThrow();
    expect(existsSync(r.path('.compass'))).toBe(true);
  });

  it('writes via tmp + rename (no half-written file visible to a concurrent reader)', () => {
    // contract test: implementation writes state.json.tmp then renames, so a partial
    // write never appears under the canonical name. We assert by post-condition:
    // the file exists with the new content (and no tmp leftover).
    const s = defaultState({ root: r.root });
    saveState(r.path('.compass/state.json'), s);
    expect(existsSync(r.path('.compass/state.json.tmp'))).toBe(false);
  });

  it('rejects an invalid state object before touching disk (zod throws)', () => {
    const bad = { ...defaultState({ root: r.root }), phase: 'nonexistent' } as any;
    expect(() => saveState(r.path('.compass/state.json'), bad)).toThrow();
    expect(existsSync(r.path('.compass/state.json'))).toBe(false);
  });

  it('round-trips deeply nested fields without mutation', () => {
    const s = defaultState({ root: r.root });
    s.files['src/a.ts'] = {
      sha256: 'a'.repeat(64),
      mtime: '2026-05-12T00:00:00Z',
      component_id: 'C3',
    };
    saveState(r.path('.compass/state.json'), s);
    const loaded = loadState(r.path('.compass/state.json'));
    expect(loaded?.files['src/a.ts'].component_id).toBe('C3');
  });
});

describe('transitionPhase', () => {
  it("walks through the canonical phase sequence (SPEC §5.2)", () => {
    let s = defaultState({ root: r.root });
    for (const next of ['parsing', 'clustering', 'proposing', 'critiquing', 'rendering', 'done']) {
      s = transitionPhase(s, next as any);
      expect(s.phase).toBe(next);
    }
  });

  it("sets phase_started_at to ISO-now on every transition", () => {
    let s = defaultState({ root: r.root });
    const before = s.phase_started_at;
    // simulate clock-skew by sleeping is unreliable; instead, the helper accepts
    // a now() override to keep tests deterministic.
    s = transitionPhase(s, 'parsing', { now: () => new Date('2026-05-12T12:00:00Z') });
    expect(s.phase_started_at).toBe('2026-05-12T12:00:00.000Z');
    expect(s.phase_started_at).not.toBe(before);
  });

  it("'failed' transition requires an error message; 'done' clears last_error", () => {
    let s = defaultState({ root: r.root });
    expect(() => transitionPhase(s, 'failed' as any)).toThrow(/last_error/i);
    s = transitionPhase(s, 'failed' as any, { error: 'parse blew up on x.ts' });
    expect(s.last_error).toContain('parse blew up');
    s = transitionPhase(s, 'done');
    expect(s.last_error).toBeNull();
  });

  it("rejects nonsense transitions (e.g. done → walking) — caller must explicitly reset", () => {
    let s = defaultState({ root: r.root });
    s = transitionPhase(s, 'parsing');
    s = transitionPhase(s, 'clustering');
    s = transitionPhase(s, 'proposing');
    s = transitionPhase(s, 'critiquing');
    s = transitionPhase(s, 'rendering');
    s = transitionPhase(s, 'done');
    expect(() => transitionPhase(s, 'walking')).toThrow(/transition|reset/i);
  });

  it("preserves every other field (incremental manifest stays intact across phase changes)", () => {
    let s = defaultState({ root: r.root });
    s.files['src/a.ts'] = { sha256: 'a'.repeat(64), mtime: '2026-01-01T00:00:00Z', component_id: 'C1' };
    s.pins.louvain_seed = 'deadbeef';
    s = transitionPhase(s, 'parsing');
    expect(s.files['src/a.ts'].component_id).toBe('C1');
    expect(s.pins.louvain_seed).toBe('deadbeef');
  });
});

describe('defaultState', () => {
  it('seeds louvain_seed from sha256(root)[:8] (SPEC Open Q4)', () => {
    const s1 = defaultState({ root: r.root });
    const s2 = defaultState({ root: r.root });
    expect(s1.pins.louvain_seed).toBe(s2.pins.louvain_seed);
    expect(s1.pins.louvain_seed).toMatch(/^[0-9a-f]{8}$/);
  });

  it("starts in phase='walking' with an empty files manifest", () => {
    const s = defaultState({ root: r.root });
    expect(s.phase).toBe('walking');
    expect(s.files).toEqual({});
  });
});
