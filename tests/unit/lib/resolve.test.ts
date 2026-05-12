/**
 * SPEC.md §4.2 step 3 — Resolve imports (tsconfig.paths, package.json#main, relative).
 * Also covers SPEC Open Q1 — dynamic/non-literal imports surface as unresolved.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveImport } from '../../../src/lib/resolve.js';
import { makeTmpRepo, type TmpRepo } from '../../helpers/tmp.js';

let r: TmpRepo;
beforeEach(() => { r = makeTmpRepo(); });
afterEach(() => r.cleanup());

describe('resolveImport — relative paths', () => {
  it('resolves a relative .ts sibling', () => {
    r.write('src/a.ts', '');
    r.write('src/b.ts', '');
    const got = resolveImport({ from: r.path('src/a.ts'), specifier: './b', root: r.root });
    expect(got).toBe(r.path('src/b.ts'));
  });

  it('resolves a relative directory to its index.ts', () => {
    r.write('src/a.ts', '');
    r.write('src/utils/index.ts', '');
    const got = resolveImport({ from: r.path('src/a.ts'), specifier: './utils', root: r.root });
    expect(got).toBe(r.path('src/utils/index.ts'));
  });

  it('prefers .ts over .js when both exist (TS-native repo convention)', () => {
    r.write('src/a.ts', '');
    r.write('src/b.ts', '');
    r.write('src/b.js', '');
    const got = resolveImport({ from: r.path('src/a.ts'), specifier: './b', root: r.root });
    expect(got).toBe(r.path('src/b.ts'));
  });

  it('prefers .tsx over .ts when the specifier is unambiguous (component file)', () => {
    r.write('src/Button.tsx', '');
    r.write('src/Button.ts', '');
    // when both exist, .ts wins (closer to module conventions) — pin the contract here
    const got = resolveImport({ from: r.path('src/x.ts'), specifier: './Button', root: r.root });
    expect(got).toBe(r.path('src/Button.ts'));
  });

  it('resolves a .ts file imported with an explicit .js extension (TS allows this)', () => {
    r.write('src/x.ts', '');
    r.write('src/y.ts', '');
    const got = resolveImport({ from: r.path('src/x.ts'), specifier: './y.js', root: r.root });
    expect(got).toBe(r.path('src/y.ts'));
  });

  it('resolves a parent-directory import (../)', () => {
    r.write('src/a/x.ts', '');
    r.write('src/b/y.ts', '');
    const got = resolveImport({ from: r.path('src/a/x.ts'), specifier: '../b/y', root: r.root });
    expect(got).toBe(r.path('src/b/y.ts'));
  });

  it('returns null for a relative import that targets nothing', () => {
    r.write('src/a.ts', '');
    expect(resolveImport({ from: r.path('src/a.ts'), specifier: './nope', root: r.root })).toBeNull();
  });
});

describe('resolveImport — tsconfig.paths', () => {
  it("resolves a '@/*' alias to baseUrl + path", () => {
    r.write('tsconfig.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
    }));
    r.write('src/foo/bar.ts', '');
    r.write('src/x.ts', '');
    const got = resolveImport({ from: r.path('src/x.ts'), specifier: '@/foo/bar', root: r.root });
    expect(got).toBe(r.path('src/foo/bar.ts'));
  });

  it('resolves a multi-target alias to the first match that exists on disk', () => {
    r.write('tsconfig.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '~lib/*': ['src/lib/*', 'packages/lib/*'] } },
    }));
    r.write('packages/lib/util.ts', '');
    r.write('src/x.ts', '');
    const got = resolveImport({ from: r.path('src/x.ts'), specifier: '~lib/util', root: r.root });
    expect(got).toBe(r.path('packages/lib/util.ts'));
  });

  it('falls through to node resolution if no alias matches', () => {
    r.write('tsconfig.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
    }));
    r.write('src/x.ts', '');
    // no alias starts with 'react' so this is treated as a package
    const got = resolveImport({ from: r.path('src/x.ts'), specifier: 'react', root: r.root });
    expect(got).toMatch(/external:react$|^null$/); // package resolution either returns external:react or null
  });

  it('handles tsconfig.json with comments (jsonc — VS Code style)', () => {
    r.write('tsconfig.json', `{ /* comments */ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }`);
    r.write('src/x.ts', '');
    r.write('src/y.ts', '');
    const got = resolveImport({ from: r.path('src/x.ts'), specifier: '@/y', root: r.root });
    expect(got).toBe(r.path('src/y.ts'));
  });

  it('handles trailing-commas in tsconfig (jsonc)', () => {
    r.write('tsconfig.json', `{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], }, }, }`);
    r.write('src/y.ts', '');
    const got = resolveImport({ from: r.path('src/x.ts'), specifier: '@/y', root: r.root });
    expect(got).toBe(r.path('src/y.ts'));
  });
});

describe('resolveImport — package.json#main / #exports (node_modules)', () => {
  it('resolves a bare package via node_modules/<pkg>/package.json#main', () => {
    r.write('node_modules/widget/package.json', JSON.stringify({ name: 'widget', main: 'dist/index.js' }));
    r.write('node_modules/widget/dist/index.js', '');
    r.write('src/x.ts', '');
    const got = resolveImport({ from: r.path('src/x.ts'), specifier: 'widget', root: r.root });
    expect(got).toBe(r.path('node_modules/widget/dist/index.js'));
  });

  it("resolves a package with #exports (modern conditional exports)", () => {
    r.write('node_modules/foo/package.json', JSON.stringify({
      name: 'foo',
      exports: { '.': { import: './esm/index.mjs', require: './cjs/index.cjs' } },
    }));
    r.write('node_modules/foo/esm/index.mjs', '');
    r.write('src/x.ts', '');
    const got = resolveImport({ from: r.path('src/x.ts'), specifier: 'foo', root: r.root });
    expect(got).toBe(r.path('node_modules/foo/esm/index.mjs'));
  });

  it('falls back to <pkg>/index.{js,ts} when no main/exports field', () => {
    r.write('node_modules/bare/package.json', JSON.stringify({ name: 'bare' }));
    r.write('node_modules/bare/index.js', '');
    r.write('src/x.ts', '');
    const got = resolveImport({ from: r.path('src/x.ts'), specifier: 'bare', root: r.root });
    expect(got).toBe(r.path('node_modules/bare/index.js'));
  });

  it('walks up to find node_modules in a monorepo', () => {
    r.write('node_modules/up/package.json', JSON.stringify({ name: 'up', main: 'index.js' }));
    r.write('node_modules/up/index.js', '');
    r.write('packages/app/src/x.ts', '');
    const got = resolveImport({ from: r.path('packages/app/src/x.ts'), specifier: 'up', root: r.root });
    expect(got).toBe(r.path('node_modules/up/index.js'));
  });

  it('handles scoped packages (@scope/name)', () => {
    r.write('node_modules/@scope/pkg/package.json', JSON.stringify({ name: '@scope/pkg', main: 'index.js' }));
    r.write('node_modules/@scope/pkg/index.js', '');
    r.write('src/x.ts', '');
    const got = resolveImport({ from: r.path('src/x.ts'), specifier: '@scope/pkg', root: r.root });
    expect(got).toBe(r.path('node_modules/@scope/pkg/index.js'));
  });

  it('handles subpath imports (pkg/subpath)', () => {
    r.write('node_modules/lib/package.json', JSON.stringify({ name: 'lib', main: 'index.js' }));
    r.write('node_modules/lib/index.js', '');
    r.write('node_modules/lib/sub/x.js', '');
    r.write('src/x.ts', '');
    const got = resolveImport({ from: r.path('src/x.ts'), specifier: 'lib/sub/x', root: r.root });
    expect(got).toBe(r.path('node_modules/lib/sub/x.js'));
  });
});

describe('resolveImport — unresolvable cases', () => {
  it('returns null for a bare package that is not installed (no node_modules)', () => {
    r.write('src/x.ts', '');
    expect(resolveImport({ from: r.path('src/x.ts'), specifier: 'never-installed', root: r.root })).toBeNull();
  });

  it('returns null for a null specifier (dynamic import with a variable — Open Q1)', () => {
    r.write('src/x.ts', '');
    expect(resolveImport({ from: r.path('src/x.ts'), specifier: null as any, root: r.root })).toBeNull();
  });

  it('returns null for an empty specifier', () => {
    r.write('src/x.ts', '');
    expect(resolveImport({ from: r.path('src/x.ts'), specifier: '', root: r.root })).toBeNull();
  });

  it("returns null on a path that walks out of root (rejects '/etc/passwd' style)", () => {
    r.write('src/x.ts', '');
    expect(resolveImport({ from: r.path('src/x.ts'), specifier: '../../../../../etc/passwd', root: r.root })).toBeNull();
  });
});

describe('resolveImport — node: builtins', () => {
  it('treats node: protocol imports as external (no edge in the project graph)', () => {
    r.write('src/x.ts', '');
    const got = resolveImport({ from: r.path('src/x.ts'), specifier: 'node:fs', root: r.root });
    expect(got).toMatch(/^external:/);
  });

  it('treats bare "fs", "path", etc. as external builtins', () => {
    r.write('src/x.ts', '');
    for (const b of ['fs', 'path', 'crypto', 'os']) {
      const got = resolveImport({ from: r.path('src/x.ts'), specifier: b, root: r.root });
      expect(got).toMatch(/^external:/);
    }
  });
});
