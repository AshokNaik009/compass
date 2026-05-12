/**
 * SPEC.md §5.2 — state.json shape.
 *
 * State is the durable spine of the pipeline and the recovery contract. Every
 * field has a downstream consumer: phase drives /compass-recover (§6.5),
 * lock_holder mirrors the pidfile (§6 step 1), pins lock cluster determinism
 * (Open Q4), files[] is the incremental manifest.
 */
import { describe, it, expect } from 'vitest';
import { StateSchema } from '../../../src/schema/state.js';

const baseValid = () => ({
  schema_version: 1,
  last_run_id: '2026-05-12-103000',
  last_run_at: '2026-05-12T10:30:00Z',
  last_commit_sha: 'abc123def456abc123def456abc123def456abcd',
  depth: 1,
  phase: 'done',
  phase_started_at: '2026-05-12T10:29:51Z',
  last_error: null,
  lock_holder: null,
  files: {
    'src/api/users.ts': {
      sha256: 'a'.repeat(64),
      mtime: '2026-05-10T14:22:00Z',
      component_id: 'C1',
    },
  },
  pins: {
    louvain_pkg: 'graphology-communities-louvain@2.0.2',
    louvain_seed: '9f7c1a2b',
  },
  stats: {
    files_parsed: 142,
    files_skipped_ignore: 1204,
    files_skipped_unchanged: 0,
    clusters_pre_llm: 18,
    components_post_llm: 7,
    llm_calls: 2,
    tokens_in_total: 17539,
    tokens_out_total: 2082,
    duration_ms: 9421,
  },
});

describe('StateSchema — happy path', () => {
  it('accepts the canonical document from SPEC §5.2', () => {
    expect(() => StateSchema.parse(baseValid())).not.toThrow();
  });

  it('accepts a freshly-initialized state (phase=walking, no files yet)', () => {
    const doc = baseValid();
    doc.phase = 'walking';
    doc.files = {};
    doc.stats.files_parsed = 0;
    doc.stats.clusters_pre_llm = 0;
    doc.stats.components_post_llm = 0;
    doc.stats.llm_calls = 0;
    expect(() => StateSchema.parse(doc)).not.toThrow();
  });
});

describe('StateSchema — phase enum (SPEC §5.2)', () => {
  const phases = ['walking', 'parsing', 'clustering', 'proposing', 'critiquing', 'rendering', 'done', 'failed'];
  for (const p of phases) {
    it(`accepts phase='${p}'`, () => {
      expect(() => StateSchema.parse({ ...baseValid(), phase: p })).not.toThrow();
    });
  }
  it('rejects unknown phase (catches drift between recover.ts and the schema)', () => {
    expect(() => StateSchema.parse({ ...baseValid(), phase: 'analyzing' })).toThrow();
  });

  it("when phase='failed', last_error must be a non-empty string (§5.2 invariant)", () => {
    const doc = baseValid();
    doc.phase = 'failed';
    doc.last_error = 'parse step blew up on src/x.ts: unexpected token';
    expect(() => StateSchema.parse(doc)).not.toThrow();

    // failed phase with null last_error is contradictory — recover.ts has nothing to log
    doc.last_error = null;
    expect(() => StateSchema.parse(doc)).toThrow();
  });

  it("when phase != 'failed', last_error must be null", () => {
    const doc = baseValid();
    doc.phase = 'done';
    (doc as any).last_error = 'lingering message from a previous failure';
    expect(() => StateSchema.parse(doc)).toThrow();
  });
});

describe('StateSchema — lock_holder mirror', () => {
  it('accepts null lock_holder (no run in flight)', () => {
    expect(() => StateSchema.parse({ ...baseValid(), lock_holder: null })).not.toThrow();
  });

  it('accepts a populated lock_holder during a live run', () => {
    const doc = baseValid();
    doc.lock_holder = { pid: 12345, started_at: '2026-05-12T10:29:51Z' } as any;
    expect(() => StateSchema.parse(doc)).not.toThrow();
  });

  it('rejects negative or zero pid', () => {
    const doc = baseValid();
    doc.lock_holder = { pid: 0, started_at: '2026-05-12T10:29:51Z' } as any;
    expect(() => StateSchema.parse(doc)).toThrow();
    doc.lock_holder = { pid: -3, started_at: '2026-05-12T10:29:51Z' } as any;
    expect(() => StateSchema.parse(doc)).toThrow();
  });

  it('rejects non-ISO started_at', () => {
    const doc = baseValid();
    doc.lock_holder = { pid: 42, started_at: 'a while ago' } as any;
    expect(() => StateSchema.parse(doc)).toThrow();
  });
});

describe('StateSchema — files manifest', () => {
  it('sha256 must be 64 hex chars (no upper-case, no whitespace)', () => {
    const doc = baseValid();
    doc.files['src/api/users.ts'].sha256 = 'a'.repeat(63);
    expect(() => StateSchema.parse(doc)).toThrow();

    doc.files['src/api/users.ts'].sha256 = 'A'.repeat(64);
    expect(() => StateSchema.parse(doc)).toThrow();

    doc.files['src/api/users.ts'].sha256 = 'g'.repeat(64); // not hex
    expect(() => StateSchema.parse(doc)).toThrow();
  });

  it('component_id must match the id pattern', () => {
    const doc = baseValid();
    doc.files['src/api/users.ts'].component_id = 'invalid';
    expect(() => StateSchema.parse(doc)).toThrow();
  });

  it('rejects negative file_count / loc / token counts', () => {
    const doc = baseValid();
    doc.stats.files_parsed = -1;
    expect(() => StateSchema.parse(doc)).toThrow();
  });

  it('component_id may be null for an orphan file (e.g. a deleted-then-untracked file mid-recover)', () => {
    const doc = baseValid();
    (doc.files['src/api/users.ts'] as any).component_id = null;
    expect(() => StateSchema.parse(doc)).not.toThrow();
  });
});

describe('StateSchema — pins (SPEC Open Q4: cluster stability)', () => {
  it("louvain_seed must be 8 lowercase hex chars (sha256(root)[:8])", () => {
    const doc = baseValid();
    doc.pins.louvain_seed = 'ABCDEF12';
    expect(() => StateSchema.parse(doc)).toThrow();
    doc.pins.louvain_seed = 'abcd';
    expect(() => StateSchema.parse(doc)).toThrow();
  });

  it("louvain_pkg must look like 'name@semver'", () => {
    const doc = baseValid();
    doc.pins.louvain_pkg = 'graphology-communities-louvain';
    expect(() => StateSchema.parse(doc)).toThrow();
  });
});

describe('StateSchema — schema_version', () => {
  it("rejects schema_version != 1", () => {
    const doc = baseValid() as any;
    doc.schema_version = 2;
    expect(() => StateSchema.parse(doc)).toThrow();
  });
});

describe('StateSchema — last_commit_sha', () => {
  it("accepts null commit (no git repo case)", () => {
    const doc = baseValid();
    (doc as any).last_commit_sha = null;
    expect(() => StateSchema.parse(doc)).not.toThrow();
  });

  it("rejects malformed commit shas", () => {
    const doc = baseValid();
    (doc as any).last_commit_sha = 'xyz';
    expect(() => StateSchema.parse(doc)).toThrow();
  });
});

describe('StateSchema — strictness', () => {
  it('rejects unknown top-level fields (forward-compat: bump schema_version)', () => {
    const doc = baseValid() as any;
    doc.cosmic_ray_count = 0;
    expect(() => StateSchema.parse(doc)).toThrow();
  });
});
