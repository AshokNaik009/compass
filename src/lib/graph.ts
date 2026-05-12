import Graph from 'graphology';
// @ts-ignore — no shipped types
import louvain from 'graphology-communities-louvain';

export interface FileImport {
  from: string;
  to: string | null;
  usedCount: number;
  typeOnly?: boolean;
}

const TYPE_ONLY_WEIGHT = 0.25;

/**
 * SPEC §4.2 step 4 — build the file-level import graph. Nodes = files,
 * edges = imports, weight = sum of used-symbol counts (type-only imports
 * are downweighted because they cost nothing at runtime).
 */
export function buildGraph(fileImports: FileImport[]): Graph {
  const g = new Graph({ type: 'directed', multi: false, allowSelfLoops: false });

  const addNode = (n: string) => {
    if (!g.hasNode(n)) g.addNode(n);
  };

  for (const fi of fileImports) {
    if (!fi.from) continue;
    if (fi.to == null) {
      // unresolved (Open Q1) — keep `from` as a node, drop the edge
      addNode(fi.from);
      continue;
    }
    if (typeof fi.to === 'string' && fi.to.startsWith('external:')) {
      addNode(fi.from);
      continue;
    }
    if (fi.from === fi.to) {
      addNode(fi.from);
      continue;
    }
    addNode(fi.from);
    addNode(fi.to);
    const w = fi.typeOnly ? fi.usedCount * TYPE_ONLY_WEIGHT : fi.usedCount;
    if (g.hasEdge(fi.from, fi.to)) {
      const prev = g.getEdgeAttribute(fi.from, fi.to, 'weight') as number;
      g.setEdgeAttribute(fi.from, fi.to, 'weight', prev + w);
    } else {
      g.addEdge(fi.from, fi.to, { weight: w });
    }
  }

  return g;
}

/**
 * Seeded Louvain pre-clustering (SPEC §4.2 step 5, Open Q4).
 * Louvain operates on undirected graphs; we convert internally.
 */
export function preCluster(graph: Graph, seed: string): Record<string, number> {
  if (graph.order === 0) return {};
  const undirected = new Graph({ type: 'undirected', multi: false, allowSelfLoops: false });
  graph.forEachNode((n) => undirected.addNode(n));
  graph.forEachEdge((_e, attrs, source, target) => {
    if (source === target) return;
    const w = (attrs.weight as number) ?? 1;
    if (undirected.hasEdge(source, target)) {
      const prev = undirected.getEdgeAttribute(source, target, 'weight') as number;
      undirected.setEdgeAttribute(source, target, 'weight', prev + w);
    } else {
      undirected.addEdge(source, target, { weight: w });
    }
  });

  // Convert seed (hex) into a deterministic uint32 for the RNG.
  const seedInt = parseInt(seed, 16);
  let rngState = seedInt >>> 0;
  const rng = () => {
    // mulberry32
    rngState = (rngState + 0x6d2b79f5) >>> 0;
    let t = rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Louvain in graphology-communities-louvain returns mapping node → community id.
  // It uses Math.random unless `getEdgeWeight` and `rng` options pass through;
  // we wrap by temporarily replacing Math.random for reproducibility.
  const origRandom = Math.random;
  Math.random = rng;
  let mapping: Record<string, number>;
  try {
    mapping = louvain(undirected, { resolution: 1 }) as Record<string, number>;
  } finally {
    Math.random = origRandom;
  }
  return mapping;
}

/**
 * SPEC Open Q5 — top-level component cap (12). Pre-cluster output may exceed
 * this. The merge step folds the smallest clusters into the nearest neighbour
 * (highest-weight inter-cluster edge) until the count is at or below the cap.
 */
export function mergeToCap(
  clusters: Record<string, number>,
  graph: Graph,
  cap: number,
): Record<string, number> {
  if (cap <= 0) return clusters;
  const groups = new Map<number, string[]>();
  for (const [node, cid] of Object.entries(clusters)) {
    const arr = groups.get(cid) ?? [];
    arr.push(node);
    groups.set(cid, arr);
  }
  while (groups.size > cap) {
    // Find the smallest cluster
    let smallest: number | null = null;
    let smallestSize = Infinity;
    for (const [cid, nodes] of groups) {
      if (nodes.length < smallestSize) {
        smallest = cid;
        smallestSize = nodes.length;
      }
    }
    if (smallest == null) break;
    // Find best neighbour to merge into
    const neighbourWeight = new Map<number, number>();
    for (const node of groups.get(smallest)!) {
      graph.forEachEdge(node, (_e, attrs, src, tgt) => {
        const other = src === node ? tgt : src;
        const ocid = clusters[other];
        if (ocid == null || ocid === smallest) return;
        const w = (attrs.weight as number) ?? 1;
        neighbourWeight.set(ocid, (neighbourWeight.get(ocid) ?? 0) + w);
      });
    }
    let target: number | null = null;
    let best = -Infinity;
    for (const [cid, w] of neighbourWeight) {
      if (w > best) {
        target = cid;
        best = w;
      }
    }
    if (target == null) {
      // No neighbours — merge into the largest cluster.
      let largest: number | null = null;
      let largestSize = -1;
      for (const [cid, nodes] of groups) {
        if (cid === smallest) continue;
        if (nodes.length > largestSize) {
          largest = cid;
          largestSize = nodes.length;
        }
      }
      if (largest == null) break;
      target = largest;
    }
    // Merge smallest into target
    const merged = (groups.get(target!) ?? []).concat(groups.get(smallest!)!);
    groups.set(target!, merged);
    groups.delete(smallest!);
    for (const node of merged) clusters[node] = target!;
  }
  return clusters;
}

export interface AggregatedEdge {
  from: string;
  to: string;
  weight: number;
}

/**
 * Aggregate file-level edges into component-level edges.
 * SPEC §4.2 step 7 — drop intra-component edges (noise), drop edges to
 * unmapped files (defensive).
 */
export function aggregateComponentEdges(
  fileImports: FileImport[],
  fileToComponent: Record<string, string>,
): AggregatedEdge[] {
  const acc = new Map<string, AggregatedEdge>();
  for (const fi of fileImports) {
    if (!fi.from || !fi.to) continue;
    if (typeof fi.to === 'string' && fi.to.startsWith('external:')) continue;
    const a = fileToComponent[fi.from];
    const b = fileToComponent[fi.to];
    if (!a || !b) continue;
    if (a === b) continue;
    const key = `${a}${b}`;
    const prev = acc.get(key);
    if (prev) prev.weight += fi.usedCount;
    else acc.set(key, { from: a, to: b, weight: fi.usedCount });
  }
  return Array.from(acc.values());
}
