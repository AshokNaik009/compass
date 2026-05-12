/**
 * SPEC.md §5.1 — analysis.json read/write contract.
 *
 *  - load returns the validated typed object
 *  - load on a missing file returns null (caller decides whether to scan)
 *  - save is atomic (tmp + rename)
 *  - save normalizes component ordering by id (so diffs are stable across runs — Open Q4)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { loadAnalysis, saveAnalysis } from '../../../src/lib/analysis.js';
import { makeTmpRepo, type TmpRepo } from '../../helpers/tmp.js';

let r: TmpRepo;
beforeEach(() => { r = makeTmpRepo(); });
afterEach(() => r.cleanup());

const sampleAnalysis = (root: string) => ({
  schema_version: 1,
  run_id: '2026-05-12-103000',
  generated_at: '2026-05-12T10:30:00Z',
  depth: 1,
  precision: 'imports-only' as const,
  project: { name: 'tiny', root, languages: ['typescript'], file_count: 1, loc: 1 },
  components: [
    {
      id: 'C1', name: 'A', description: 'desc', rationale: 'r',
      files: ['src/a.ts'], symbols: ['x'], depth: 1, subgraph_ref: null, confidence: 'high' as const,
    },
  ],
  edges: [],
  subgraphs: {},
  llm: { model: 'claude-opus-4-7', calls: [] },
});

describe('loadAnalysis', () => {
  it('returns null when the file does not exist', () => {
    expect(loadAnalysis(r.path('.compass/analysis.json'))).toBeNull();
  });

  it('returns a typed object on a valid file', () => {
    saveAnalysis(r.path('.compass/analysis.json'), sampleAnalysis(r.root));
    const a = loadAnalysis(r.path('.compass/analysis.json'));
    expect(a?.components[0].id).toBe('C1');
  });

  it('throws on a malformed analysis.json (callers should treat this as catastrophic)', () => {
    r.write('.compass/analysis.json', '{ not json');
    expect(() => loadAnalysis(r.path('.compass/analysis.json'))).toThrow();
  });

  it('throws on a schema-mismatched analysis.json (forces /compass-scan to rebuild)', () => {
    r.write('.compass/analysis.json', JSON.stringify({ schema_version: 999 }));
    expect(() => loadAnalysis(r.path('.compass/analysis.json'))).toThrow();
  });
});

describe('saveAnalysis', () => {
  it('writes via tmp + rename (no .tmp leftover after success)', () => {
    saveAnalysis(r.path('.compass/analysis.json'), sampleAnalysis(r.root));
    expect(existsSync(r.path('.compass/analysis.json'))).toBe(true);
    expect(existsSync(r.path('.compass/analysis.json.tmp'))).toBe(false);
  });

  it('refuses to write an invalid analysis (zod throws before disk touch)', () => {
    const bad = { ...sampleAnalysis(r.root) };
    (bad as any).components[0].confidence = 'unsure';
    expect(() => saveAnalysis(r.path('.compass/analysis.json'), bad as any)).toThrow();
    expect(existsSync(r.path('.compass/analysis.json'))).toBe(false);
  });

  it('normalizes component order by id so diffs are stable across runs', () => {
    const a = sampleAnalysis(r.root);
    a.components.push({
      id: 'C2', name: 'B', description: '', rationale: 'r',
      files: ['b.ts'], symbols: [], depth: 1, subgraph_ref: null, confidence: 'high',
    });
    // intentionally pass in reverse order
    a.components.reverse();
    saveAnalysis(r.path('.compass/analysis.json'), a);
    const reloaded = loadAnalysis(r.path('.compass/analysis.json'))!;
    expect(reloaded.components.map((c) => c.id)).toEqual(['C1', 'C2']);
  });

  it('keeps an existing analysis.json unchanged when the new payload is byte-identical (idempotency)', () => {
    saveAnalysis(r.path('.compass/analysis.json'), sampleAnalysis(r.root));
    const before = readFileSync(r.path('.compass/analysis.json'), 'utf8');
    saveAnalysis(r.path('.compass/analysis.json'), sampleAnalysis(r.root));
    const after = readFileSync(r.path('.compass/analysis.json'), 'utf8');
    expect(after).toBe(before);
  });
});
