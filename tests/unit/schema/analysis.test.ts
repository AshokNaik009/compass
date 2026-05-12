/**
 * SPEC.md §5.1 — analysis.json shape.
 *
 * The zod schema is the contract for everything downstream (renderer, refresh,
 * status). These tests pin every documented field, enum, and version number so
 * an accidental loosening is caught at PR time.
 */
import { describe, it, expect } from 'vitest';
import { AnalysisSchema } from '../../../src/schema/analysis.js';

const baseValid = () => ({
  schema_version: 1,
  run_id: '2026-05-12-103000',
  generated_at: '2026-05-12T10:30:00Z',
  depth: 1,
  precision: 'imports-only',
  project: {
    name: 'my-mern-app',
    root: '/abs/path/to/repo',
    languages: ['typescript', 'javascript'],
    file_count: 142,
    loc: 18734,
  },
  components: [
    {
      id: 'C1',
      name: 'API Layer',
      description: 'Express routes + middleware.',
      rationale: 'All 9 files import only from C2; leaf of import DAG.',
      files: ['src/api/**'],
      symbols: ['app', 'userRouter'],
      depth: 1,
      subgraph_ref: null,
      confidence: 'high',
    },
  ],
  edges: [{ from: 'C1', to: 'C2', weight: 14, reason: 'Express handlers import services' }],
  subgraphs: {},
  llm: {
    model: 'claude-opus-4-7',
    calls: [
      { phase: 'propose', tokens_in: 8421, tokens_out: 1209, duration_ms: 4302 },
      { phase: 'critique', tokens_in: 9118, tokens_out: 873, duration_ms: 3811 },
    ],
  },
});

describe('AnalysisSchema — happy path', () => {
  it('accepts the canonical document from SPEC §5.1', () => {
    expect(() => AnalysisSchema.parse(baseValid())).not.toThrow();
  });

  it('preserves component ordering (array, not Set)', () => {
    const doc = baseValid();
    doc.components.push({ ...doc.components[0], id: 'C2', name: 'Domain Services' });
    doc.components.push({ ...doc.components[0], id: 'C3', name: 'Persistence' });
    const parsed = AnalysisSchema.parse(doc);
    expect(parsed.components.map((c) => c.id)).toEqual(['C1', 'C2', 'C3']);
  });

  it('allows empty edges array (single-component repos)', () => {
    const doc = baseValid();
    doc.edges = [];
    expect(() => AnalysisSchema.parse(doc)).not.toThrow();
  });

  it('allows empty subgraphs object at depth=1', () => {
    const doc = baseValid();
    doc.subgraphs = {};
    expect(() => AnalysisSchema.parse(doc)).not.toThrow();
  });
});

describe('AnalysisSchema — version and identity', () => {
  it('rejects schema_version != 1 (v1 contract)', () => {
    const doc = baseValid();
    (doc as any).schema_version = 2;
    expect(() => AnalysisSchema.parse(doc)).toThrow();
  });

  it('rejects missing schema_version (must be explicit)', () => {
    const doc = baseValid();
    delete (doc as any).schema_version;
    expect(() => AnalysisSchema.parse(doc)).toThrow();
  });

  it('requires run_id to be a string (timestamp format documented but not enforced beyond type)', () => {
    const doc = baseValid();
    (doc as any).run_id = 1234;
    expect(() => AnalysisSchema.parse(doc)).toThrow();
  });

  it('rejects non-ISO generated_at strings', () => {
    const doc = baseValid();
    doc.generated_at = 'last tuesday';
    expect(() => AnalysisSchema.parse(doc)).toThrow();
  });
});

describe('AnalysisSchema — depth caps (SPEC §4.2 step 10, §6.1 step 2)', () => {
  it('accepts depth=1', () => {
    expect(() => AnalysisSchema.parse({ ...baseValid(), depth: 1 })).not.toThrow();
  });
  it('accepts depth=2 (v1 cap)', () => {
    expect(() => AnalysisSchema.parse({ ...baseValid(), depth: 2 })).not.toThrow();
  });
  it('rejects depth=3 (above v1 cap)', () => {
    expect(() => AnalysisSchema.parse({ ...baseValid(), depth: 3 })).toThrow();
  });
  it('rejects depth=0 (analysis must have at least one level)', () => {
    expect(() => AnalysisSchema.parse({ ...baseValid(), depth: 0 })).toThrow();
  });
  it('rejects negative depth', () => {
    expect(() => AnalysisSchema.parse({ ...baseValid(), depth: -1 })).toThrow();
  });
  it('rejects fractional depth', () => {
    expect(() => AnalysisSchema.parse({ ...baseValid(), depth: 1.5 })).toThrow();
  });
});

describe('AnalysisSchema — precision enum (SPEC §5.1)', () => {
  it("accepts 'imports-only' (v1)", () => {
    expect(() => AnalysisSchema.parse({ ...baseValid(), precision: 'imports-only' })).not.toThrow();
  });
  it("accepts 'imports+lsp' (v0.2 forward-compat — comment in spec)", () => {
    expect(() => AnalysisSchema.parse({ ...baseValid(), precision: 'imports+lsp' })).not.toThrow();
  });
  it('rejects arbitrary precision strings', () => {
    expect(() => AnalysisSchema.parse({ ...baseValid(), precision: 'lsp-only' })).toThrow();
    expect(() => AnalysisSchema.parse({ ...baseValid(), precision: '' })).toThrow();
  });
});

describe('AnalysisSchema — component fields', () => {
  const withComponent = (override: Record<string, unknown>) => {
    const doc = baseValid();
    doc.components[0] = { ...doc.components[0], ...override } as any;
    return doc;
  };

  it('requires id matching /^C\\d+$/', () => {
    expect(() => AnalysisSchema.parse(withComponent({ id: 'C1' }))).not.toThrow();
    expect(() => AnalysisSchema.parse(withComponent({ id: 'C42' }))).not.toThrow();
    expect(() => AnalysisSchema.parse(withComponent({ id: 'c1' }))).toThrow();
    expect(() => AnalysisSchema.parse(withComponent({ id: 'COMP-1' }))).toThrow();
    expect(() => AnalysisSchema.parse(withComponent({ id: '' }))).toThrow();
  });

  it('requires non-empty name', () => {
    expect(() => AnalysisSchema.parse(withComponent({ name: '' }))).toThrow();
  });

  it('requires non-empty rationale (the whole point of the critique pass — §4.2)', () => {
    expect(() => AnalysisSchema.parse(withComponent({ rationale: '' }))).toThrow();
  });

  it("confidence must be 'high' | 'medium' | 'low'", () => {
    for (const c of ['high', 'medium', 'low']) {
      expect(() => AnalysisSchema.parse(withComponent({ confidence: c }))).not.toThrow();
    }
    expect(() => AnalysisSchema.parse(withComponent({ confidence: 'unsure' }))).toThrow();
    expect(() => AnalysisSchema.parse(withComponent({ confidence: 'HIGH' }))).toThrow();
  });

  it('subgraph_ref is null at depth=1, non-null component id at depth>=2', () => {
    expect(() => AnalysisSchema.parse(withComponent({ subgraph_ref: null }))).not.toThrow();
    expect(() => AnalysisSchema.parse(withComponent({ subgraph_ref: 'C1' }))).not.toThrow();
    // forbids garbage refs (must look like a component id)
    expect(() => AnalysisSchema.parse(withComponent({ subgraph_ref: 'not-an-id' }))).toThrow();
  });

  it('files must be an array of strings (globs allowed verbatim — renderer expands)', () => {
    expect(() => AnalysisSchema.parse(withComponent({ files: [] }))).toThrow(); // empty component is malformed
    expect(() => AnalysisSchema.parse(withComponent({ files: ['src/x.ts', 'src/y.ts'] }))).not.toThrow();
    expect(() => AnalysisSchema.parse(withComponent({ files: [1, 2] }))).toThrow();
  });

  it('symbols may be empty (some components are pure structure)', () => {
    expect(() => AnalysisSchema.parse(withComponent({ symbols: [] }))).not.toThrow();
  });
});

describe('AnalysisSchema — edges', () => {
  const withEdges = (edges: unknown) => ({ ...baseValid(), edges } as any);

  it('rejects negative or zero weight (weight is symbol count, >= 1)', () => {
    expect(() => AnalysisSchema.parse(withEdges([{ from: 'C1', to: 'C2', weight: 0, reason: 'x' }]))).toThrow();
    expect(() => AnalysisSchema.parse(withEdges([{ from: 'C1', to: 'C2', weight: -1, reason: 'x' }]))).toThrow();
  });

  it('rejects edge from a node to itself (self-loops are clustering noise)', () => {
    expect(() => AnalysisSchema.parse(withEdges([{ from: 'C1', to: 'C1', weight: 1, reason: 'x' }]))).toThrow();
  });

  it('requires from and to to look like component ids', () => {
    expect(() => AnalysisSchema.parse(withEdges([{ from: 'foo', to: 'bar', weight: 1, reason: 'x' }]))).toThrow();
  });

  it('requires reason (the human-readable why for the edge)', () => {
    expect(() => AnalysisSchema.parse(withEdges([{ from: 'C1', to: 'C2', weight: 1 }]))).toThrow();
  });
});

describe('AnalysisSchema — llm.calls', () => {
  const withCalls = (calls: unknown) => {
    const doc = baseValid();
    doc.llm.calls = calls as any;
    return doc;
  };

  it("phase must be 'propose' or 'critique'", () => {
    expect(() => AnalysisSchema.parse(withCalls([{ phase: 'propose', tokens_in: 1, tokens_out: 1, duration_ms: 1 }]))).not.toThrow();
    expect(() => AnalysisSchema.parse(withCalls([{ phase: 'critique', tokens_in: 1, tokens_out: 1, duration_ms: 1 }]))).not.toThrow();
    expect(() => AnalysisSchema.parse(withCalls([{ phase: 'planning', tokens_in: 1, tokens_out: 1, duration_ms: 1 }]))).toThrow();
  });

  it('token counts cannot be negative', () => {
    expect(() => AnalysisSchema.parse(withCalls([{ phase: 'propose', tokens_in: -1, tokens_out: 0, duration_ms: 0 }]))).toThrow();
  });

  it('accepts a single-call (refresh recritique) shape', () => {
    expect(() => AnalysisSchema.parse(withCalls([{ phase: 'critique', tokens_in: 100, tokens_out: 50, duration_ms: 200 }]))).not.toThrow();
  });

  it('accepts empty calls array (fully-cached refresh that touched nothing)', () => {
    expect(() => AnalysisSchema.parse(withCalls([]))).not.toThrow();
  });
});

describe('AnalysisSchema — exhaustiveness', () => {
  it('rejects unknown top-level fields (catches typos that drift the contract)', () => {
    const doc = baseValid() as any;
    doc.surprise = true;
    expect(() => AnalysisSchema.parse(doc)).toThrow();
  });
});
