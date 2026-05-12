/**
 * SPEC.md §6.2 step 2 — git diff between last_commit_sha and HEAD.
 *
 * No-git repos and missing-base-sha cases are first-class: /compass-refresh
 * has to keep working even when the repo isn't a git repo (Open Q on
 * non-git workflows is implicit — the spec mentions falling back to hashes).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { revParseHEAD, diffNames, isGitRepo } from '../../../src/lib/git.js';
import { makeTmpRepo, type TmpRepo } from '../../helpers/tmp.js';
import { gitInit, gitCommit } from '../../helpers/fixtures.js';

let r: TmpRepo;
beforeEach(() => { r = makeTmpRepo(); });
afterEach(() => r.cleanup());

describe('isGitRepo', () => {
  it('returns true for a freshly-init repo', () => {
    r.write('a.ts', 'x');
    gitInit(r.root);
    expect(isGitRepo(r.root)).toBe(true);
  });

  it('returns false for a non-git dir', () => {
    r.write('a.ts', 'x');
    expect(isGitRepo(r.root)).toBe(false);
  });
});

describe('revParseHEAD', () => {
  it('returns the 40-char SHA of HEAD on a populated repo', () => {
    r.write('a.ts', 'x');
    const sha = gitInit(r.root);
    expect(revParseHEAD(r.root)).toBe(sha);
    expect(revParseHEAD(r.root)).toMatch(/^[0-9a-f]{40}$/);
  });

  it('returns null on an empty (no commits) repo', () => {
    execSync('git init -q', { cwd: r.root });
    expect(revParseHEAD(r.root)).toBeNull();
  });

  it('returns null on a non-git dir (caller falls back to hashes-only diff)', () => {
    expect(revParseHEAD(r.root)).toBeNull();
  });
});

describe('diffNames', () => {
  it('lists files added between two commits', () => {
    r.write('a.ts', 'x');
    const c1 = gitInit(r.root);
    r.write('b.ts', 'x');
    const c2 = gitCommit(r.root, 'add b');
    expect(diffNames(r.root, c1, c2)).toEqual(['b.ts']);
  });

  it('lists files modified between two commits', () => {
    r.write('a.ts', 'one');
    const c1 = gitInit(r.root);
    writeFileSync(r.path('a.ts'), 'two');
    const c2 = gitCommit(r.root, 'edit a');
    expect(diffNames(r.root, c1, c2)).toEqual(['a.ts']);
  });

  it('lists files deleted between two commits', () => {
    r.write('a.ts', 'x');
    r.write('b.ts', 'x');
    const c1 = gitInit(r.root);
    unlinkSync(r.path('b.ts'));
    const c2 = gitCommit(r.root, 'delete b');
    expect(diffNames(r.root, c1, c2)).toEqual(['b.ts']);
  });

  it('honors a renames-as-modify (the diff lists both the old and new path)', () => {
    r.write('a.ts', 'export const x = 1;');
    const c1 = gitInit(r.root);
    execSync('git mv a.ts renamed.ts', { cwd: r.root });
    const c2 = gitCommit(r.root, 'rename');
    const names = diffNames(r.root, c1, c2).sort();
    // git diff --name-only with rename detection will list either old+new or just new.
    // The wrapper normalizes to "both" so the refresh classifier sees the delete + add.
    expect(names).toEqual(['a.ts', 'renamed.ts']);
  });

  it('returns [] when the two SHAs are identical', () => {
    r.write('a.ts', 'x');
    const sha = gitInit(r.root);
    expect(diffNames(r.root, sha, sha)).toEqual([]);
  });

  it('returns [] for a base SHA that is unreachable (e.g. force-pushed branch)', () => {
    r.write('a.ts', 'x');
    gitInit(r.root);
    const stranger = '0'.repeat(40);
    // contract: instead of throwing, return [] and let the caller fall back to hashes.
    expect(diffNames(r.root, stranger, 'HEAD')).toEqual([]);
  });

  it('throws a clear error on a non-git dir (caller should have checked isGitRepo first)', () => {
    expect(() => diffNames(r.root, 'HEAD~1', 'HEAD')).toThrow(/git/i);
  });

  it('also surfaces uncommitted-but-tracked modifications when called with HEAD..workdir sentinel', () => {
    r.write('a.ts', 'x');
    gitInit(r.root);
    writeFileSync(r.path('a.ts'), 'modified');
    // contract: passing 'WORKDIR' as the right side compares HEAD vs working tree.
    expect(diffNames(r.root, 'HEAD', 'WORKDIR')).toEqual(['a.ts']);
  });

  it("ignores files inside .git/", () => {
    r.write('a.ts', 'x');
    const c1 = gitInit(r.root);
    writeFileSync(r.path('a.ts'), 'changed');
    const c2 = gitCommit(r.root, 'm');
    const names = diffNames(r.root, c1, c2);
    expect(names.every((n) => !n.startsWith('.git/'))).toBe(true);
  });
});
