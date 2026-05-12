import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import picomatch from 'picomatch';

const DEFAULT_IGNORES = [
  'node_modules/',
  'dist/',
  'build/',
  '.git/',
  '.next/',
  'coverage/',
  '.compass/',
];

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

export interface IgnoreRules {
  excludes: string[];
  reincludes: string[]; // patterns starting with `!`
}

function parseIgnoreFile(text: string): IgnoreRules {
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

export function loadIgnoreRules(root: string): IgnoreRules {
  const compassIgnore = join(root, '.compassignore');
  const gitIgnore = join(root, '.gitignore');

  let excludes: string[] = [];
  let reincludes: string[] = [];

  if (existsSync(gitIgnore)) {
    const r = parseIgnoreFile(readFileSync(gitIgnore, 'utf8'));
    excludes.push(...r.excludes);
    // .gitignore `!` re-includes are not given compass-override status; only
    // .compassignore's `!` re-includes override.
  }
  if (existsSync(compassIgnore)) {
    const r = parseIgnoreFile(readFileSync(compassIgnore, 'utf8'));
    excludes.push(...r.excludes);
    reincludes.push(...r.reincludes);
  } else {
    // No .compassignore — fall back to defaults union'd with .gitignore.
    excludes.push(...DEFAULT_IGNORES);
  }

  return { excludes, reincludes };
}

function normalizePattern(p: string): string {
  // Treat a trailing slash as "match everything under this directory".
  if (p.endsWith('/')) return `${p.slice(0, -1)}/**`;
  // Bare directory name → match dir + contents.
  if (!p.includes('/') && !p.includes('*')) return `**/${p}/**`;
  return p;
}

export function makeMatcher(rules: IgnoreRules) {
  const excludePatterns = rules.excludes.map(normalizePattern);
  const reincludePatterns = rules.reincludes.map(normalizePattern);
  const excludeMatchers = excludePatterns.map((p) => picomatch(p, { dot: true }));
  const reincludeMatchers = reincludePatterns.map((p) => picomatch(p, { dot: true }));
  return (relPath: string) => {
    const path = relPath.split(sep).join('/');
    // Reinclude wins (covers the !path override in the precedence table).
    if (reincludeMatchers.some((m) => m(path))) return { excluded: false };
    if (excludeMatchers.some((m) => m(path))) return { excluded: true };
    return { excluded: false };
  };
}

export interface WalkResult {
  files: { rel: string; abs: string; sha256: string; mtime: string }[];
  skipped_ignore: number;
}

export function isSourceFile(name: string): boolean {
  const lower = name.toLowerCase();
  for (const ext of SOURCE_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

export function sha256OfFile(abs: string): string {
  const buf = readFileSync(abs);
  return createHash('sha256').update(buf).digest('hex');
}

export function walkRepo(root: string): WalkResult {
  const rules = loadIgnoreRules(root);
  const matcher = makeMatcher(rules);
  const files: WalkResult['files'] = [];
  let skipped = 0;

  function recur(dir: string) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs);
      const { excluded } = matcher(rel + (entry.isDirectory() ? '/' : ''));
      if (excluded) {
        skipped += 1;
        continue;
      }
      if (entry.isDirectory()) {
        recur(abs);
      } else if (entry.isFile() && isSourceFile(entry.name)) {
        const st = statSync(abs);
        files.push({
          rel,
          abs,
          sha256: sha256OfFile(abs),
          mtime: st.mtime.toISOString(),
        });
      }
    }
  }

  recur(root);
  return { files, skipped_ignore: skipped };
}
