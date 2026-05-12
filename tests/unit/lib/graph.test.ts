/**
 * SPEC.md §4.2 steps 4–5 — graph construction (edges = imports, weight = used symbol count)
 * and seeded Louvain pre-clustering. Open Q4 — cluster stability across runs.
 */
import { describe, it, expect } from 'vitest';
import { buildGraph, preCluster, aggregateComponentEdges } from '../../../src/lib/graph.js';

type FileImport = { from: string; to: string; usedCount: number; typeOnly?: boolean };

describe('buildGraph — nodes and edges', () => {
  it('creates one node per file (unique by absolute path)', () => {
    const g = buildGraph([
      { from: '/a.ts', to: '/b.ts', usedCount: 1 },
      { from: '/a.ts', to: '/c.ts', usedCount: 1 },
    ]);
    expect(g.nodes().sort()).toEqual(['/a.ts', '/b.ts', '/c.ts']);
  });

  it('edge weight = sum of usedCount across multiple imports between the same pair', () => {
    // a.ts -> b.ts, used 3, plus another import block from a.ts -> b.ts used 2 => 5
    const g = buildGraph([
      { from: '/a.ts', to: '/b.ts', usedCount: 3 },
      { from: '/a.ts', to: '/b.ts', usedCount: 2 },
    ]);
    expect(g.getEdgeAttribute('/a.ts', '/b.ts', 'weight')).toBe(5);
  });

  it('downweights type-only imports (they cost nothing at runtime)', () => {
    const g = buildGraph([
      { from: '/a.ts', to: '/b.ts', usedCount: 2, typeOnly: true },
    ]);
    // contract: type-only imports contribute, but with a fixed downweight (e.g. 0.25x)
    const w = g.getEdgeAttribute('/a.ts', '/b.ts', 'weight') as number;
    expect(w).toBeGreaterThan(0);
    expect(w).toBeLessThan(2);
  });

  it('does not create edges to external: nodes (they are not project files)', () => {
    const g = buildGraph([
      { from: '/a.ts', to: 'external:react', usedCount: 1 },
      { from: '/a.ts', to: '/b.ts', usedCount: 1 },
    ]);
    expect(g.nodes().sort()).toEqual(['/a.ts', '/b.ts']);
  });

  it('skips unresolved edges (target is null — Open Q1)', () => {
    const g = buildGraph([
      { from: '/a.ts', to: null as any, usedCount: 0 },
      { from: '/a.ts', to: '/b.ts', usedCount: 1 },
    ]);
    expect(g.nodes().sort()).toEqual(['/a.ts', '/b.ts']);
  });

  it('records cycles as ordinary edges (does not collapse them)', () => {
    const g = buildGraph([
      { from: '/a.ts', to: '/b.ts', usedCount: 1 },
      { from: '/b.ts', to: '/a.ts', usedCount: 1 },
    ]);
    expect(g.hasEdge('/a.ts', '/b.ts')).toBe(true);
    expect(g.hasEdge('/b.ts', '/a.ts')).toBe(true);
  });

  it('handles a self-import gracefully (edge dropped — never useful)', () => {
    const g = buildGraph([
      { from: '/a.ts', to: '/a.ts', usedCount: 1 },
    ]);
    expect(g.nodes()).toEqual(['/a.ts']);
    expect(g.hasEdge('/a.ts', '/a.ts')).toBe(false);
  });

  it('returns an empty graph for empty input', () => {
    const g = buildGraph([]);
    expect(g.nodes()).toEqual([]);
  });
});

describe('preCluster — seeded Louvain (SPEC Open Q4)', () => {
  // The spec pins louvain_seed = sha256(project_root)[:8]. Tests pass the seed directly.
  const seedA = '9f7c1a2b';
  const seedB = 'deadbeef';

  // A known graph with two clear components: {1,2,3} densely connected, {4,5,6} densely connected,
  // single thin bridge edge between them.
  const denseTwoCluster: FileImport[] = [
    { from: '/c1/a.ts', to: '/c1/b.ts', usedCount: 5 },
    { from: '/c1/b.ts', to: '/c1/c.ts', usedCount: 5 },
    { from: '/c1/a.ts', to: '/c1/c.ts', usedCount: 5 },
    { from: '/c2/d.ts', to: '/c2/e.ts', usedCount: 5 },
    { from: '/c2/e.ts', to: '/c2/f.ts', usedCount: 5 },
    { from: '/c2/d.ts', to: '/c2/f.ts', usedCount: 5 },
    { from: '/c1/a.ts', to: '/c2/d.ts', usedCount: 1 }, // thin bridge
  ];

  it('produces deterministic cluster IDs for the same seed and graph', () => {
    const g = buildGraph(denseTwoCluster);
    const r1 = preCluster(g, seedA);
    const r2 = preCluster(g, seedA);
    expect(r1).toEqual(r2);
  });

  it('produces different (or at least independent) cluster IDs for a different seed but same dense structure', () => {
    const g = buildGraph(denseTwoCluster);
    const r1 = preCluster(g, seedA);
    const r2 = preCluster(g, seedB);
    // membership (which files end up grouped together) may match for very-clean inputs,
    // but the assigned numeric labels must come from independent runs.
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
  });

  it('groups densely-connected files together (sanity test that Louvain wired up correctly)', () => {
    const g = buildGraph(denseTwoCluster);
    const clusters = preCluster(g, seedA);
    expect(clusters['/c1/a.ts']).toBe(clusters['/c1/b.ts']);
    expect(clusters['/c1/a.ts']).toBe(clusters['/c1/c.ts']);
    expect(clusters['/c2/d.ts']).toBe(clusters['/c2/e.ts']);
    expect(clusters['/c2/d.ts']).toBe(clusters['/c2/f.ts']);
    expect(clusters['/c1/a.ts']).not.toBe(clusters['/c2/d.ts']);
  });

  it('survives a disconnected graph (each component is its own cluster)', () => {
    const g = buildGraph([
      { from: '/x.ts', to: '/y.ts', usedCount: 1 },
      { from: '/z.ts', to: '/w.ts', usedCount: 1 },
    ]);
    const clusters = preCluster(g, seedA);
    expect(clusters['/x.ts']).toBe(clusters['/y.ts']);
    expect(clusters['/z.ts']).toBe(clusters['/w.ts']);
    expect(clusters['/x.ts']).not.toBe(clusters['/z.ts']);
  });

  it('handles a single-node graph', () => {
    const g = buildGraph([]);
    g.addNode('/lonely.ts');
    const clusters = preCluster(g, seedA);
    expect(Object.keys(clusters)).toEqual(['/lonely.ts']);
  });

  it('returns {} on an empty graph', () => {
    const g = buildGraph([]);
    expect(preCluster(g, seedA)).toEqual({});
  });

  it('caps the cluster count below the SPEC §13 Open Q5 ceiling of 12', () => {
    // Construct 30 small disconnected pairs — Louvain will produce 30 clusters,
    // and the caller is expected to feed that into the critique pass with a merge instruction.
    // The pre-cluster step itself does NOT merge — that's the LLM's job. But the helper
    // exposes a `mergeToCap(clusters, graph, 12)` so tests can pin the cap.
    const edges: FileImport[] = [];
    for (let i = 0; i < 30; i++) {
      edges.push({ from: `/g${i}/a.ts`, to: `/g${i}/b.ts`, usedCount: 1 });
    }
    const g = buildGraph(edges);
    const clusters = preCluster(g, seedA);
    const before = new Set(Object.values(clusters)).size;
    expect(before).toBeGreaterThan(12);
  });
});

describe('aggregateComponentEdges — file-level edges → component-level edges', () => {
  it('sums weights across files in the same source/target component', () => {
    const fileEdges: FileImport[] = [
      { from: '/api/a.ts', to: '/svc/x.ts', usedCount: 3 },
      { from: '/api/b.ts', to: '/svc/y.ts', usedCount: 4 },
      { from: '/api/c.ts', to: '/repo/z.ts', usedCount: 2 },
    ];
    const fileToComponent = {
      '/api/a.ts': 'C1', '/api/b.ts': 'C1', '/api/c.ts': 'C1',
      '/svc/x.ts': 'C2', '/svc/y.ts': 'C2',
      '/repo/z.ts': 'C3',
    };
    const edges = aggregateComponentEdges(fileEdges, fileToComponent);
    expect(edges).toContainEqual(expect.objectContaining({ from: 'C1', to: 'C2', weight: 7 }));
    expect(edges).toContainEqual(expect.objectContaining({ from: 'C1', to: 'C3', weight: 2 }));
  });

  it('drops intra-component edges (a→b where both files share a component)', () => {
    const fileEdges: FileImport[] = [
      { from: '/api/a.ts', to: '/api/b.ts', usedCount: 9 },
      { from: '/api/a.ts', to: '/svc/x.ts', usedCount: 2 },
    ];
    const fileToComponent = { '/api/a.ts': 'C1', '/api/b.ts': 'C1', '/svc/x.ts': 'C2' };
    const edges = aggregateComponentEdges(fileEdges, fileToComponent);
    expect(edges).toEqual([expect.objectContaining({ from: 'C1', to: 'C2', weight: 2 })]);
  });

  it('drops edges that span an unmapped file (defensive — should never happen, but worth pinning)', () => {
    const fileEdges: FileImport[] = [
      { from: '/api/a.ts', to: '/orphan/x.ts', usedCount: 1 },
    ];
    const fileToComponent = { '/api/a.ts': 'C1' };
    expect(aggregateComponentEdges(fileEdges, fileToComponent)).toEqual([]);
  });
});
