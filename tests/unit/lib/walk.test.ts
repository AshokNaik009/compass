/**
 * SPEC.md §5.3 — .compassignore + .gitignore precedence; §6.1 step 4 — sha256 of every kept file.
 *
 * The precedence table is reproduced row-for-row below. These tests are the
 * only place that table is operationalized — drift here means drifted-from-spec behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { walk, hashFile } from '../../../src/lib/walk.js';
import { makeTmpRepo, type TmpRepo } from '../../helpers/tmp.js';

let r: TmpRepo;
beforeEach(() => { r = makeTmpRepo(); });
afterEach(() => r.cleanup());

const sortRel = (paths: string[], root: string) =>
  paths.map((p) => p.replace(root + '/', '')).sort();

describe('walk — language filter (SPEC §2)', () => {
  it('keeps .ts, .tsx, .js, .jsx, .mjs, .cjs', () => {
    for (const ext of ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']) {
      r.write(`src/file.${ext}`, 'export const x = 1;');
    }
    const files = walk(r.root);
    expect(sortRel(files, r.root)).toEqual([
      'src/file.cjs', 'src/file.js', 'src/file.jsx', 'src/file.mjs', 'src/file.ts', 'src/file.tsx',
    ]);
  });

  it('drops .d.ts, .json, .md, .css, images, anything outside the JS/TS set', () => {
    r.write('src/types.d.ts', 'export {};');
    r.write('src/data.json', '{}');
    r.write('README.md', '# hi');
    r.write('src/styles.css', '.x{}');
    r.write('src/icon.png', 'binary');
    r.write('src/keep.ts', 'export const x = 1;');
    const files = walk(r.root);
    expect(sortRel(files, r.root)).toEqual(['src/keep.ts']);
  });

  it('handles a file with no extension as a skip (avoids parsing Makefiles, LICENSE, etc.)', () => {
    r.write('LICENSE', 'MIT');
    r.write('Makefile', 'all:');
    r.write('src/x.ts', 'export {}');
    expect(sortRel(walk(r.root), r.root)).toEqual(['src/x.ts']);
  });
});

describe('walk — default excludes when no .compassignore (SPEC §5.3 fallback)', () => {
  it('skips node_modules, dist, build, .git, .next, coverage by default', () => {
    for (const d of ['node_modules', 'dist', 'build', '.git', '.next', 'coverage']) {
      r.write(`${d}/oops.ts`, 'export {};');
    }
    r.write('src/keep.ts', 'export {};');
    expect(sortRel(walk(r.root), r.root)).toEqual(['src/keep.ts']);
  });

  it('falls through to .gitignore patterns when present', () => {
    r.write('.gitignore', 'private/\n');
    r.write('private/secret.ts', 'export const k = 1;');
    r.write('src/keep.ts', 'export {};');
    expect(sortRel(walk(r.root), r.root)).toEqual(['src/keep.ts']);
  });
});

describe('walk — precedence table (SPEC §5.3)', () => {
  // Row 1: not in either → included
  it('row 1: no match anywhere → included', () => {
    r.write('src/keep.ts', 'x');
    expect(walk(r.root).some((p) => p.endsWith('src/keep.ts'))).toBe(true);
  });

  // Row 2: gitignore yes, compassignore no → excluded
  it('row 2: matched by .gitignore only → excluded', () => {
    r.write('.gitignore', 'build/\n');
    r.write('build/x.ts', 'x');
    r.write('src/keep.ts', 'x');
    expect(sortRel(walk(r.root), r.root)).toEqual(['src/keep.ts']);
  });

  // Row 3: gitignore no, compassignore yes → excluded
  it('row 3: matched by .compassignore only → excluded', () => {
    r.write('.compassignore', 'fixtures/\n');
    r.write('fixtures/sample.ts', 'x');
    r.write('src/keep.ts', 'x');
    expect(sortRel(walk(r.root), r.root)).toEqual(['src/keep.ts']);
  });

  // Row 4: both → excluded
  it('row 4: matched by both → excluded (either reason fires)', () => {
    r.write('.gitignore', 'dist/\n');
    r.write('.compassignore', 'dist/\n');
    r.write('dist/oops.ts', 'x');
    r.write('src/keep.ts', 'x');
    expect(sortRel(walk(r.root), r.root)).toEqual(['src/keep.ts']);
  });

  // Row 5: gitignore yes, compassignore !include → included (compass override)
  it('row 5: .compassignore !include overrides .gitignore', () => {
    r.write('.gitignore', 'generated/\n');
    r.write('.compassignore', '!generated/\n');
    r.write('generated/api.ts', 'x');
    expect(walk(r.root).some((p) => p.endsWith('generated/api.ts'))).toBe(true);
  });

  // Row 6: previously excluded by .compassignore, then !-re-included in .compassignore
  it('row 6: .compassignore exclude then explicit !include — re-included', () => {
    r.write('.compassignore', 'vendor/\n!vendor/keepme/\n');
    r.write('vendor/drop.ts', 'x');
    r.write('vendor/keepme/keep.ts', 'x');
    const got = sortRel(walk(r.root), r.root);
    expect(got).toContain('vendor/keepme/keep.ts');
    expect(got).not.toContain('vendor/drop.ts');
  });
});

describe('walk — .compassignore syntax (gitignore-compatible)', () => {
  it('honors comments and blank lines', () => {
    r.write('.compassignore', '# vendored\nvendor/\n\n# tests\n*.spec.ts\n');
    r.write('vendor/x.ts', 'x');
    r.write('src/a.spec.ts', 'x');
    r.write('src/a.ts', 'x');
    expect(sortRel(walk(r.root), r.root)).toEqual(['src/a.ts']);
  });

  it('honors trailing-slash directory globs', () => {
    r.write('.compassignore', '__snapshots__/\n');
    r.write('src/__snapshots__/a.ts', 'x');
    r.write('src/a.ts', 'x');
    expect(sortRel(walk(r.root), r.root)).toEqual(['src/a.ts']);
  });

  it('honors glob patterns (e.g. *.test.ts)', () => {
    r.write('.compassignore', '*.test.ts\n*.spec.ts\n');
    r.write('src/a.test.ts', 'x');
    r.write('src/a.spec.ts', 'x');
    r.write('src/a.ts', 'x');
    expect(sortRel(walk(r.root), r.root)).toEqual(['src/a.ts']);
  });

  it('treats an empty .compassignore as "no compass excludes" (not "ignore everything")', () => {
    r.write('.compassignore', '');
    r.write('src/a.ts', 'x');
    expect(sortRel(walk(r.root), r.root)).toEqual(['src/a.ts']);
  });

  it('only the root .compassignore is honored (no nested files — explicit per §5.3 location)', () => {
    r.write('.compassignore', '');
    r.write('src/.compassignore', '*.ts\n'); // should NOT take effect
    r.write('src/a.ts', 'x');
    expect(walk(r.root).some((p) => p.endsWith('src/a.ts'))).toBe(true);
  });
});

describe('walk — edge inputs', () => {
  it('returns [] on an empty directory', () => {
    expect(walk(r.root)).toEqual([]);
  });

  it('does not traverse symlinks that point outside the root (security)', () => {
    const outside = makeTmpRepo('compass-out-');
    outside.write('leak.ts', 'export const SECRET = 1;');
    try {
      // best-effort: only test if the runner supports symlinks
      require('node:fs').symlinkSync(outside.root, r.path('link'));
    } catch {
      return; // skip if not supported (Windows CI without admin, etc.)
    }
    const files = walk(r.root);
    expect(files.find((p) => p.includes('link'))).toBeUndefined();
    outside.cleanup();
  });

  it('does not follow .git internals even when .git is not gitignored', () => {
    r.write('.git/index.ts', 'export const x = 1;'); // contrived but specific
    r.write('src/a.ts', 'x');
    expect(sortRel(walk(r.root), r.root)).toEqual(['src/a.ts']);
  });

  it('skips hidden directories that contain TS by default (.cache, .turbo, etc. via .gitignore)', () => {
    r.write('.gitignore', '.cache/\n.turbo/\n');
    r.write('.cache/a.ts', 'x');
    r.write('.turbo/b.ts', 'x');
    r.write('src/a.ts', 'x');
    expect(sortRel(walk(r.root), r.root)).toEqual(['src/a.ts']);
  });

  it('handles utf-8 filenames and paths with spaces', () => {
    r.write('src/π/файл.ts', 'export {}');
    r.write('src/has space/y.ts', 'export {}');
    const files = sortRel(walk(r.root), r.root);
    expect(files).toContain('src/π/файл.ts');
    expect(files).toContain('src/has space/y.ts');
  });
});

describe('hashFile — sha256 (SPEC §6.1 step 4)', () => {
  it('matches openssl/Node crypto on a fixed byte string', () => {
    const p = r.write('a.ts', 'export const x = 1;');
    const expected = createHash('sha256').update('export const x = 1;').digest('hex');
    expect(hashFile(p)).toBe(expected);
  });

  it('is content-based: same bytes in different files produce the same hash', () => {
    const a = r.write('a.ts', 'x');
    const b = r.write('b.ts', 'x');
    expect(hashFile(a)).toBe(hashFile(b));
  });

  it('changes on a single-byte edit (canary for the incremental diff)', () => {
    const p = r.write('a.ts', 'export const x = 1;');
    const before = hashFile(p);
    writeFileSync(p, 'export const x = 2;');
    expect(hashFile(p)).not.toBe(before);
  });

  it('is stable across reads (no time/uid drift)', () => {
    const p = r.write('a.ts', 'export const x = 1;');
    expect(hashFile(p)).toBe(hashFile(p));
  });

  it('throws a clear error for a missing file', () => {
    expect(() => hashFile(r.path('does-not-exist.ts'))).toThrow();
  });

  it('handles large files without buffering everything into memory (smoke: 5MB file)', () => {
    const big = 'x'.repeat(5 * 1024 * 1024);
    const p = r.write('big.ts', big);
    expect(hashFile(p)).toHaveLength(64);
  });
});
