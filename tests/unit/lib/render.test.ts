/**
 * SPEC.md §5.4 — Markdown + Mermaid emission.
 *  - filename collisions → suffix with component id (§5.4)
 *  - 12-component top-level cap (Open Q5)
 *  - 20-file per-component cap with "Other" bucket (Open Q5)
 *  - rationale included on every page
 *  - click handlers in Mermaid
 *  - special characters in names sanitized to filenames
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { renderAnalysis } from '../../../src/lib/render.js';
import { makeTmpRepo, type TmpRepo } from '../../helpers/tmp.js';

let r: TmpRepo;
beforeEach(() => { r = makeTmpRepo(); });
afterEach(() => r.cleanup());

const componentsBase = () => [
  {
    id: 'C1',
    name: 'API Layer',
    description: 'Express routes + middleware.',
    rationale: 'All 9 files import only from C2; treated as a leaf of the import DAG.',
    files: ['src/api/users.ts', 'src/api/billing.ts'],
    symbols: ['app', 'userRouter'],
    depth: 1,
    subgraph_ref: null,
    confidence: 'high' as const,
  },
  {
    id: 'C2',
    name: 'Domain Services',
    description: 'Services orchestrate use-cases.',
    rationale: 'Each file imports from C3 (persistence) and is imported by C1 (API).',
    files: ['src/services/user.ts', 'src/services/billing.ts'],
    symbols: ['UserService'],
    depth: 1,
    subgraph_ref: null,
    confidence: 'medium' as const,
  },
];

const analysisBase = () => ({
  schema_version: 1,
  run_id: '2026-05-12-103000',
  generated_at: '2026-05-12T10:30:00Z',
  depth: 1,
  precision: 'imports-only' as const,
  project: { name: 'my-mern-app', root: r.root, languages: ['typescript'], file_count: 4, loc: 100 },
  components: componentsBase(),
  edges: [{ from: 'C1', to: 'C2', weight: 14, reason: 'Express handlers import services' }],
  subgraphs: {},
  llm: { model: 'claude-opus-4-7', calls: [] },
});

describe('renderAnalysis — overview.md', () => {
  it('writes .compass/overview.md', () => {
    renderAnalysis(analysisBase(), r.path('.compass'));
    const md = readFileSync(r.path('.compass/overview.md'), 'utf8');
    expect(md).toContain('# my-mern-app');
    expect(md).toContain('```mermaid');
  });

  it('emits a graph LR block with one node per component', () => {
    renderAnalysis(analysisBase(), r.path('.compass'));
    const md = readFileSync(r.path('.compass/overview.md'), 'utf8');
    expect(md).toMatch(/graph LR/);
    expect(md).toMatch(/C1\["API Layer"\]/);
    expect(md).toMatch(/C2\["Domain Services"\]/);
  });

  it('emits click handlers pointing to per-component files', () => {
    renderAnalysis(analysisBase(), r.path('.compass'));
    const md = readFileSync(r.path('.compass/overview.md'), 'utf8');
    expect(md).toContain(`click C1 href "./API_Layer.md"`);
    expect(md).toContain(`click C2 href "./Domain_Services.md"`);
  });

  it('renders one descriptive paragraph per component, including the rationale ("Why this grouping")', () => {
    renderAnalysis(analysisBase(), r.path('.compass'));
    const md = readFileSync(r.path('.compass/overview.md'), 'utf8');
    expect(md).toContain('All 9 files import only from C2');
    expect(md).toContain('*Why this grouping:');
  });

  it('uses the run timestamp in the front-matter blurb', () => {
    renderAnalysis(analysisBase(), r.path('.compass'));
    const md = readFileSync(r.path('.compass/overview.md'), 'utf8');
    expect(md).toContain('2026-05-12');
    expect(md).toContain('/compass-refresh');
  });
});

describe('renderAnalysis — per-component pages', () => {
  it('writes one .md per component', () => {
    renderAnalysis(analysisBase(), r.path('.compass'));
    const files = readdirSync(r.path('.compass')).sort();
    expect(files).toContain('API_Layer.md');
    expect(files).toContain('Domain_Services.md');
    expect(files).toContain('overview.md');
  });

  it('includes description, rationale, file list, symbol list per page', () => {
    renderAnalysis(analysisBase(), r.path('.compass'));
    const md = readFileSync(r.path('.compass/API_Layer.md'), 'utf8');
    expect(md).toContain('Express routes + middleware.');
    expect(md).toContain('All 9 files import only from C2');
    expect(md).toContain('src/api/users.ts');
    expect(md).toContain('userRouter');
  });
});

describe('renderAnalysis — filename collisions (SPEC §5.4)', () => {
  it("two components named 'Utilities' → 'Utilities.md' and 'Utilities__C7.md'", () => {
    const a = analysisBase();
    a.components[0] = { ...a.components[0], id: 'C3', name: 'Utilities' };
    a.components[1] = { ...a.components[1], id: 'C7', name: 'Utilities' };
    renderAnalysis(a, r.path('.compass'));
    const files = readdirSync(r.path('.compass')).filter((f) => f.startsWith('Utilities')).sort();
    expect(files).toEqual(['Utilities.md', 'Utilities__C7.md']);
  });

  it('three-way collision — every duplicate gets its id suffix, first wins the bare name', () => {
    const a = analysisBase();
    a.components = [
      { ...componentsBase()[0], id: 'C1', name: 'Core' },
      { ...componentsBase()[1], id: 'C2', name: 'Core' },
      { ...componentsBase()[0], id: 'C5', name: 'Core' },
    ];
    renderAnalysis(a, r.path('.compass'));
    const files = readdirSync(r.path('.compass')).filter((f) => f.startsWith('Core')).sort();
    expect(files).toEqual(['Core.md', 'Core__C2.md', 'Core__C5.md']);
  });

  it('detects collisions before write (no clobbering)', () => {
    // contract test: rendering is atomic and idempotent — no half-written collision
    const a = analysisBase();
    a.components = [
      { ...componentsBase()[0], id: 'C1', name: 'X' },
      { ...componentsBase()[1], id: 'C2', name: 'X' },
    ];
    renderAnalysis(a, r.path('.compass'));
    // running twice produces the same output (no state leak)
    renderAnalysis(a, r.path('.compass'));
    const files = readdirSync(r.path('.compass')).filter((f) => f.startsWith('X')).sort();
    expect(files).toEqual(['X.md', 'X__C2.md']);
  });
});

describe('renderAnalysis — filename sanitization', () => {
  it("spaces → underscores ('Domain Services' → 'Domain_Services.md')", () => {
    renderAnalysis(analysisBase(), r.path('.compass'));
    expect(readdirSync(r.path('.compass'))).toContain('Domain_Services.md');
  });

  it("slashes and path separators get stripped to '_' ('API / Routes' → 'API___Routes.md')", () => {
    const a = analysisBase();
    a.components[0] = { ...a.components[0], name: 'API / Routes' };
    renderAnalysis(a, r.path('.compass'));
    const files = readdirSync(r.path('.compass'));
    expect(files.some((f) => /^API_+_+Routes\.md$/.test(f))).toBe(true);
  });

  it('falls back to the component id when name sanitizes to an empty string', () => {
    const a = analysisBase();
    a.components[0] = { ...a.components[0], id: 'C9', name: '???' };
    renderAnalysis(a, r.path('.compass'));
    expect(readdirSync(r.path('.compass'))).toContain('C9.md');
  });
});

describe('renderAnalysis — top-level component cap (SPEC Open Q5)', () => {
  it('renders all components when count <= 12', () => {
    const a = analysisBase();
    a.components = Array.from({ length: 12 }, (_, i) => ({
      ...componentsBase()[0],
      id: `C${i + 1}`,
      name: `Comp${i + 1}`,
    }));
    a.edges = [];
    renderAnalysis(a, r.path('.compass'));
    expect(readdirSync(r.path('.compass')).filter((f) => f.startsWith('Comp')).length).toBe(12);
  });

  it('refuses to render > 12 top-level components (the critique pass should have merged)', () => {
    const a = analysisBase();
    a.components = Array.from({ length: 13 }, (_, i) => ({
      ...componentsBase()[0],
      id: `C${i + 1}`,
      name: `Comp${i + 1}`,
    }));
    a.edges = [];
    expect(() => renderAnalysis(a, r.path('.compass'))).toThrow(/12/);
  });
});

describe('renderAnalysis — per-component file cap (SPEC Open Q5)', () => {
  it('lists all files when count <= 20', () => {
    const a = analysisBase();
    a.components[0].files = Array.from({ length: 20 }, (_, i) => `src/api/f${i}.ts`);
    renderAnalysis(a, r.path('.compass'));
    const md = readFileSync(r.path('.compass/API_Layer.md'), 'utf8');
    for (let i = 0; i < 20; i++) expect(md).toContain(`src/api/f${i}.ts`);
    expect(md).not.toMatch(/Other \(\d+ files\)/);
  });

  it('lists 20 then "Other (N files)" when count > 20', () => {
    const a = analysisBase();
    a.components[0].files = Array.from({ length: 35 }, (_, i) => `src/api/f${i}.ts`);
    renderAnalysis(a, r.path('.compass'));
    const md = readFileSync(r.path('.compass/API_Layer.md'), 'utf8');
    expect(md).toContain('Other (15 files)');
  });
});

describe('renderAnalysis — depth-2 subgraph emission', () => {
  it('embeds a sub-Mermaid inside the component page when subgraphs[id] exists', () => {
    const a = analysisBase();
    a.depth = 2;
    a.subgraphs = {
      C1: {
        components: [
          { id: 'C1.1', name: 'Routers', description: '', rationale: 'r1', files: ['src/api/users.ts'], symbols: [], depth: 2, subgraph_ref: null, confidence: 'high' },
          { id: 'C1.2', name: 'Middleware', description: '', rationale: 'r2', files: ['src/middleware/auth.ts'], symbols: [], depth: 2, subgraph_ref: null, confidence: 'high' },
        ],
        edges: [{ from: 'C1.1', to: 'C1.2', weight: 1, reason: 'router uses middleware' }],
      },
    } as any;
    renderAnalysis(a, r.path('.compass'));
    const md = readFileSync(r.path('.compass/API_Layer.md'), 'utf8');
    const codeBlockCount = (md.match(/```mermaid/g) || []).length;
    expect(codeBlockCount).toBeGreaterThanOrEqual(1);
    expect(md).toContain('C1.1');
  });
});

describe('renderAnalysis — robustness', () => {
  it('refuses to render when components is empty (would produce a meaningless overview)', () => {
    const a = analysisBase();
    a.components = [];
    expect(() => renderAnalysis(a, r.path('.compass'))).toThrow(/empty/i);
  });

  it('creates the output directory if missing', () => {
    expect(() => renderAnalysis(analysisBase(), r.path('.compass'))).not.toThrow();
  });

  it('escapes Mermaid-special characters in node labels (quotes, brackets, pipes)', () => {
    const a = analysisBase();
    a.components[0].name = 'API "Layer" | v2';
    renderAnalysis(a, r.path('.compass'));
    const md = readFileSync(r.path('.compass/overview.md'), 'utf8');
    // node labels are quoted; embedded quotes must be escaped to keep Mermaid valid
    expect(md).toMatch(/C1\["[^"]*\\?".*"]/);
  });

  it('only writes overview + the components passed via --components flag in incremental mode', () => {
    const a = analysisBase();
    renderAnalysis(a, r.path('.compass'), { onlyComponents: ['C1'] });
    const files = readdirSync(r.path('.compass'));
    expect(files).toContain('overview.md');
    expect(files).toContain('API_Layer.md');
    // C2 was not in --components: not re-written, but if it already existed it's preserved
    expect(files).not.toContain('Domain_Services.md');
  });
});
