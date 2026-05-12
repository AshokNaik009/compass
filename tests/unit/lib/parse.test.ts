/**
 * SPEC.md §4.2 step 2 / §6.1 step 5 — tree-sitter parsers for TS, TSX, JS, JSX.
 *
 * What parse.ts returns per file: imports, exports, top-level decls. The graph
 * builder consumes only these, so the test surface is the same.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseSource } from '../../../src/lib/parse.js';
import { makeTmpRepo, type TmpRepo } from '../../helpers/tmp.js';

let r: TmpRepo;
beforeEach(() => { r = makeTmpRepo(); });
afterEach(() => r.cleanup());

describe('parseSource — language detection by extension', () => {
  it('parses .ts with the typescript grammar', () => {
    const p = r.write('a.ts', `import { foo } from './x'; export const bar: number = 1;`);
    const out = parseSource(p);
    expect(out.imports.map((i) => i.specifier)).toEqual(['./x']);
    expect(out.exports).toContain('bar');
  });

  it('parses .tsx with the tsx grammar (JSX in expression position)', () => {
    const p = r.write('a.tsx', `
import React from 'react';
import { Button } from './Button';
export const App = () => <Button>hi</Button>;
`);
    const out = parseSource(p);
    expect(out.imports.map((i) => i.specifier).sort()).toEqual(['./Button', 'react']);
    expect(out.exports).toContain('App');
  });

  it('parses .js with the javascript grammar', () => {
    const p = r.write('a.js', `const { foo } = require('./x'); module.exports = { foo };`);
    const out = parseSource(p);
    expect(out.imports.map((i) => i.specifier)).toEqual(['./x']);
  });

  it('parses .jsx with the JSX-capable javascript grammar', () => {
    const p = r.write('a.jsx', `import React from 'react'; export default () => <div/>;`);
    const out = parseSource(p);
    expect(out.imports.map((i) => i.specifier)).toEqual(['react']);
  });

  it('parses .mjs as ESM', () => {
    const p = r.write('a.mjs', `import foo from './x.mjs'; export const y = 1;`);
    const out = parseSource(p);
    expect(out.imports.map((i) => i.specifier)).toEqual(['./x.mjs']);
  });

  it('parses .cjs as CommonJS', () => {
    const p = r.write('a.cjs', `const foo = require('./x'); module.exports.y = foo;`);
    const out = parseSource(p);
    expect(out.imports.map((i) => i.specifier)).toEqual(['./x']);
  });
});

describe('parseSource — import variants', () => {
  it('extracts named imports', () => {
    const p = r.write('a.ts', `import { foo, bar as baz } from './x';`);
    const imps = parseSource(p).imports;
    expect(imps).toHaveLength(1);
    expect(imps[0].symbols.sort()).toEqual(['bar', 'foo']);
  });

  it('extracts default imports', () => {
    const p = r.write('a.ts', `import React from 'react';`);
    const imps = parseSource(p).imports;
    expect(imps[0].symbols).toContain('default');
  });

  it('extracts namespace imports', () => {
    const p = r.write('a.ts', `import * as utils from './utils';`);
    const imps = parseSource(p).imports;
    expect(imps[0].symbols).toContain('*');
  });

  it('extracts side-effect imports (no symbols)', () => {
    const p = r.write('a.ts', `import './polyfill';`);
    const imps = parseSource(p).imports;
    expect(imps[0].specifier).toBe('./polyfill');
    expect(imps[0].symbols).toEqual([]);
  });

  it('extracts dynamic imports with literal specifier', () => {
    const p = r.write('a.ts', `const m = await import('./lazy');`);
    const imps = parseSource(p).imports;
    expect(imps[0].specifier).toBe('./lazy');
    expect(imps[0].dynamic).toBe(true);
  });

  it('marks dynamic imports with a non-literal specifier as unresolved (SPEC Open Q1)', () => {
    const p = r.write('a.ts', `const name = 'x'; const m = await import(\`./\${name}\`);`);
    const imps = parseSource(p).imports;
    expect(imps).toHaveLength(1);
    expect(imps[0].specifier).toBeNull();
    expect(imps[0].dynamic).toBe(true);
  });

  it('marks require(variable) the same way (Open Q1)', () => {
    const p = r.write('a.cjs', `const name = 'x'; const m = require(name);`);
    const imps = parseSource(p).imports;
    expect(imps[0].specifier).toBeNull();
  });

  it('captures type-only imports but flags them so the graph can downweight', () => {
    const p = r.write('a.ts', `import type { Foo } from './types';`);
    const imps = parseSource(p).imports;
    expect(imps[0].specifier).toBe('./types');
    expect(imps[0].typeOnly).toBe(true);
  });

  it('captures mixed value+type imports (import { type X, y } from ...)', () => {
    const p = r.write('a.ts', `import { type Foo, bar } from './x';`);
    const imps = parseSource(p).imports;
    expect(imps[0].symbols.sort()).toEqual(['Foo', 'bar']);
    // mixed → flagged as not pure-type
    expect(imps[0].typeOnly).toBe(false);
  });

  it('does NOT confuse JSX attribute "import" with an actual import', () => {
    const p = r.write('a.tsx', `export const X = () => <div data-import="oops"/>;`);
    expect(parseSource(p).imports).toEqual([]);
  });

  it('strips block- and line-comments containing import-like strings', () => {
    const p = r.write('a.ts', `
// import { x } from './nope';
/* import 'also-nope'; */
import { y } from './real';
`);
    const specs = parseSource(p).imports.map((i) => i.specifier);
    expect(specs).toEqual(['./real']);
  });

  it('captures re-exports as edges, with target specifier preserved', () => {
    const p = r.write('a.ts', `export { foo } from './x'; export * from './y';`);
    const out = parseSource(p);
    expect(out.imports.map((i) => i.specifier).sort()).toEqual(['./x', './y']);
  });
});

describe('parseSource — exports / top-level decls (used for symbol field in §5.1)', () => {
  it('captures named exports', () => {
    const p = r.write('a.ts', `export const foo = 1; export function bar() {} export class Baz {}`);
    const out = parseSource(p);
    expect(out.exports.sort()).toEqual(['Baz', 'bar', 'foo']);
  });

  it("captures default exports as 'default'", () => {
    const p = r.write('a.ts', `export default function quux() {}`);
    expect(parseSource(p).exports).toContain('default');
  });

  it('captures export-from re-exports', () => {
    const p = r.write('a.ts', `export { foo, bar as baz } from './x';`);
    expect(parseSource(p).exports.sort()).toEqual(['baz', 'foo']);
  });

  it('captures CommonJS module.exports shapes', () => {
    const p = r.write('a.cjs', `module.exports = { foo: 1, bar: () => {} };`);
    const out = parseSource(p);
    // shape captured best-effort; the renderer uses these for the "symbols" list
    expect(out.exports.sort()).toEqual(['bar', 'foo']);
  });

  it('captures exports.X = ... pattern', () => {
    const p = r.write('a.cjs', `exports.foo = 1; exports.bar = () => {};`);
    expect(parseSource(p).exports.sort()).toEqual(['bar', 'foo']);
  });
});

describe('parseSource — robustness (single bad file must not poison a run)', () => {
  it('returns a best-effort partial result on a syntax error rather than throwing', () => {
    const p = r.write('a.ts', `import { foo } from './x'; this is not valid !!!`);
    const out = parseSource(p);
    expect(out.imports.map((i) => i.specifier)).toEqual(['./x']);
    expect(out.parseErrors.length).toBeGreaterThan(0);
  });

  it('returns empty arrays on a completely garbage file', () => {
    const p = r.write('a.ts', '!@#$%^&*()_+}{":?><');
    const out = parseSource(p);
    expect(out.imports).toEqual([]);
    expect(out.exports).toEqual([]);
    expect(out.parseErrors.length).toBeGreaterThan(0);
  });

  it('handles empty files', () => {
    const p = r.write('a.ts', '');
    const out = parseSource(p);
    expect(out.imports).toEqual([]);
    expect(out.exports).toEqual([]);
    expect(out.parseErrors).toEqual([]);
  });

  it('handles files with only comments', () => {
    const p = r.write('a.ts', `// just a comment\n/* and another */\n`);
    expect(parseSource(p).imports).toEqual([]);
  });

  it('handles BOM-prefixed files (utf-8 BOM is common from Windows editors)', () => {
    const p = r.write('a.ts', '﻿import { x } from "./y";');
    expect(parseSource(p).imports[0].specifier).toBe('./y');
  });
});

describe('parseSource — usage count (edge weight = # imported symbols actually used, SPEC §4.2 step 4)', () => {
  it('counts unique used symbols at the import site', () => {
    const p = r.write('a.ts', `
import { foo, bar, baz } from './x';
foo(); foo(); bar();   // baz unused
`);
    const out = parseSource(p);
    expect(out.imports[0].usedCount).toBe(2);
  });

  it('counts default import as 1 if referenced, 0 if not', () => {
    const used = r.write('a.ts', `import React from 'react'; React.createElement('div');`);
    const unused = r.write('b.ts', `import React from 'react';`);
    expect(parseSource(used).imports[0].usedCount).toBe(1);
    expect(parseSource(unused).imports[0].usedCount).toBe(0);
  });

  it('side-effect imports always have usedCount = 0 (no symbols bound)', () => {
    const p = r.write('a.ts', `import './polyfill';`);
    expect(parseSource(p).imports[0].usedCount).toBe(0);
  });
});
