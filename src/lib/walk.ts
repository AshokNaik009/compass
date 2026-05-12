import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';
import picomatch from 'picomatch';

const DEFAULT_EXCLUDES = [
  'node_modules/',
  'dist/',
  'build/',
  '.git/',
  '.next/',
  'coverage/',
  '.compass/',
];

const ALWAYS_SKIP_DIRS = new Set(['.git', '.compass']);

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

interface ParsedIgnore {
  excludes: string[];
  reincludes: string[];
}

function parseIgnore(text: string): ParsedIgnore {
  const excludes: string[] = [];
  const reincludes: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('!')) reincludes.push(line.slice(1));
    else excludes.push(line);
  }
  return { excludes, reincludes };
}

function normalizePattern(p: string): string[] {
  let pat = p.trim();
  if (!pat) return [];
  const anchored = pat.startsWith('/');
  if (anchored) pat = pat.slice(1);
  // Trailing slash → match dir and everything under it.
  const dirOnly = pat.endsWith('/');
  if (dirOnly) pat = pat.slice(0, -1);

  const containsSlash = pat.includes('/');
  const containsGlob = /[*?[]/.test(pat);

  const out: string[] = [];
  if (!containsSlash) {
    // A bare name (file or dir) matches anywhere in the tree.
    if (dirOnly) {
      out.push(`**/${pat}`);
      out.push(`**/${pat}/**`);
    } else if (containsGlob) {
      out.push(`**/${pat}`);
    } else {
      out.push(`**/${pat}`);
      out.push(`**/${pat}/**`);
    }
  } else {
    out.push(pat);
    if (dirOnly) out.push(`${pat}/**`);
  }
  return out;
}

interface CompiledRules {
  excludes: ((p: string) => boolean)[];
  reincludes: ((p: string) => boolean)[];
  reincludeRoots: string[]; // path prefixes we must descend into to evaluate reincludes
}

function compile(rules: ParsedIgnore): CompiledRules {
  const compileOne = (p: string) =>
    normalizePattern(p).map((pat) => picomatch(pat, { dot: true }));
  const flatten = (arr: string[]) => arr.flatMap(compileOne);
  // For every !-re-include pattern, capture the literal directory prefix that
  // we'll need to descend into. e.g. `!vendor/keepme/` → ['vendor', 'vendor/keepme'].
  const roots = new Set<string>();
  for (const p of rules.reincludes) {
    let pat = p.trim();
    if (pat.startsWith('/')) pat = pat.slice(1);
    if (pat.endsWith('/')) pat = pat.slice(0, -1);
    // Only the literal parts; stop at the first glob meta-char.
    const parts: string[] = [];
    for (const seg of pat.split('/')) {
      if (/[*?[]/.test(seg)) break;
      if (seg.length > 0) parts.push(seg);
    }
    for (let i = 1; i <= parts.length; i++) {
      roots.add(parts.slice(0, i).join('/'));
    }
  }
  return {
    excludes: flatten(rules.excludes),
    reincludes: flatten(rules.reincludes),
    reincludeRoots: Array.from(roots),
  };
}

function loadRules(root: string): CompiledRules {
  const compassIgnorePath = join(root, '.compassignore');
  const gitIgnorePath = join(root, '.gitignore');

  const hasCompass = existsSync(compassIgnorePath);
  const compass = hasCompass
    ? parseIgnore(readFileSync(compassIgnorePath, 'utf8'))
    : { excludes: [...DEFAULT_EXCLUDES], reincludes: [] as string[] };

  const git: ParsedIgnore = existsSync(gitIgnorePath)
    ? parseIgnore(readFileSync(gitIgnorePath, 'utf8'))
    : { excludes: [], reincludes: [] };

  // Per SPEC §5.3 precedence: union of excludes, with .compassignore's `!include`
  // overriding either source.
  return compile({
    excludes: [...git.excludes, ...compass.excludes],
    reincludes: compass.reincludes,
  });
}

function isSourceFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith('.d.ts')) return false;
  for (const ext of SOURCE_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

function isExcluded(relPath: string, isDir: boolean, rules: CompiledRules): boolean {
  // Normalize for picomatch: posix separators.
  const pPath = relPath.split(sep).join('/');
  const candidates = isDir ? [pPath, `${pPath}/`] : [pPath];

  // `!`-re-includes override exclusions, regardless of source.
  for (const c of candidates) {
    if (rules.reincludes.some((m) => m(c))) return false;
  }
  for (const c of candidates) {
    if (rules.excludes.some((m) => m(c))) return true;
  }
  return false;
}

/**
 * When a directory is excluded but a re-include pattern targets something under
 * it, we must still descend in order to evaluate that override. Mirrors
 * gitignore behavior for `dir/` + `!dir/keep/`.
 */
function mustDescend(relPath: string, rules: CompiledRules): boolean {
  const p = relPath.split(sep).join('/');
  for (const root of rules.reincludeRoots) {
    if (root === p) return true;
    if (root.startsWith(p + '/')) return true;
    if (p.startsWith(root + '/')) return true;
  }
  return false;
}

/**
 * Walk the repo and return absolute paths of all kept source files.
 * SPEC §5.3 / §6.1 step 4: respects .compassignore + .gitignore precedence.
 */
export function walk(root: string): string[] {
  const absRoot = resolve(root);
  const rules = loadRules(absRoot);
  const out: string[] = [];

  function recur(dir: string) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(absRoot, abs);
      // Refuse to follow symlinks (security: prevent escape outside root).
      let stat;
      try {
        stat = lstatSync(abs);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (ALWAYS_SKIP_DIRS.has(entry.name)) continue;
        const excluded = isExcluded(rel, true, rules);
        if (excluded && !mustDescend(rel, rules)) continue;
        recur(abs);
      } else if (entry.isFile()) {
        if (!isSourceFile(entry.name)) continue;
        if (isExcluded(rel, false, rules)) continue;
        out.push(abs);
      }
    }
  }

  recur(absRoot);
  return out;
}

/**
 * SHA256 hex of file contents. Streams via readFileSync (Node handles the
 * buffering internally; 5MB is well within bounds).
 */
export function hashFile(path: string): string {
  const buf = readFileSync(path);
  return createHash('sha256').update(buf).digest('hex');
}
