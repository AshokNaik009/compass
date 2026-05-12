import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export interface ResolveOpts {
  from: string;
  specifier: string | null;
  root: string;
}

// Order matters: .ts wins over .tsx (and over JS) when both exist. SPEC tests pin this.
const EXTENSION_ORDER = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

const NODE_BUILTINS = new Set([
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'dns',
  'domain',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'sys',
  'timers',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
]);

// Specifiers that the resolver answers as `external:<name>` when not found in
// node_modules. Keeps a small allowlist of MERN-stack-relevant packages so the
// test fixture distinguishes "known external" from "never-installed".
const KNOWN_EXTERNALS = new Set([
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'next',
  'next/link',
  'next/image',
  'next/navigation',
  'next/router',
  'vue',
  'svelte',
  'express',
  'fastify',
  'koa',
  'lodash',
  'lodash-es',
  'axios',
  'zod',
  'mongoose',
  'mongodb',
  'pg',
  'mysql',
  'redis',
  'graphql',
  'apollo-server',
  '@apollo/client',
]);

function existsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function existsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function tryExtensions(basePath: string): string | null {
  // exact match wins
  if (existsFile(basePath)) return basePath;

  // strip .js / .mjs / .cjs extension when explicit — TS allows this for .ts files
  const m = basePath.match(/\.(m|c)?js$/);
  if (m) {
    const stripped = basePath.slice(0, -m[0].length);
    for (const ext of EXTENSION_ORDER) {
      const cand = stripped + ext;
      if (existsFile(cand)) return cand;
    }
  }

  for (const ext of EXTENSION_ORDER) {
    const cand = basePath + ext;
    if (existsFile(cand)) return cand;
  }
  if (existsDir(basePath)) {
    for (const ext of EXTENSION_ORDER) {
      const cand = join(basePath, 'index' + ext);
      if (existsFile(cand)) return cand;
    }
  }
  return null;
}

function isWithinRoot(p: string, root: string): boolean {
  const norm = resolve(p);
  const r = resolve(root);
  return norm === r || norm.startsWith(r + '/');
}

// Strip /* line comments and trailing commas → JSON.parse can swallow most tsconfig files.
function parseJsonc(text: string): unknown {
  let stripped = text
    // block comments
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // line comments
    .replace(/(^|[^:\/])\/\/.*$/gm, '$1');
  // trailing commas
  stripped = stripped.replace(/,(\s*[\]}])/g, '$1');
  return JSON.parse(stripped);
}

interface TsConfig {
  baseUrl: string;
  paths: Record<string, string[]>;
}

const tsconfigCache = new Map<string, TsConfig | null>();

function loadTsConfig(root: string): TsConfig | null {
  if (tsconfigCache.has(root)) return tsconfigCache.get(root)!;
  const p = join(root, 'tsconfig.json');
  if (!existsFile(p)) {
    tsconfigCache.set(root, null);
    return null;
  }
  try {
    const cfg = parseJsonc(readFileSync(p, 'utf8')) as {
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
    };
    const baseUrl = cfg.compilerOptions?.baseUrl ?? '.';
    const paths = cfg.compilerOptions?.paths ?? {};
    const result: TsConfig = { baseUrl, paths };
    tsconfigCache.set(root, result);
    return result;
  } catch {
    tsconfigCache.set(root, null);
    return null;
  }
}

function tryTsconfigPaths(specifier: string, root: string): string | null {
  const cfg = loadTsConfig(root);
  if (!cfg) return null;
  const base = resolve(root, cfg.baseUrl);
  for (const [pattern, targets] of Object.entries(cfg.paths)) {
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -1); // 'foo/'
      if (specifier.startsWith(prefix)) {
        const suffix = specifier.slice(prefix.length);
        for (const tgt of targets) {
          const tgtPath = tgt.endsWith('/*') ? tgt.slice(0, -1) + suffix : join(tgt, suffix);
          const abs = resolve(base, tgtPath);
          const hit = tryExtensions(abs);
          if (hit) return hit;
        }
      }
    } else if (pattern === specifier) {
      for (const tgt of targets) {
        const abs = resolve(base, tgt);
        const hit = tryExtensions(abs);
        if (hit) return hit;
      }
    }
  }
  return null;
}

function* walkUpNodeModules(fromDir: string, root: string): Generator<string> {
  let cur = resolve(fromDir);
  const top = resolve(root);
  while (true) {
    yield join(cur, 'node_modules');
    if (cur === top) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  // One more above root for monorepo cases
  yield join(top, 'node_modules');
}

interface PackageJson {
  main?: string;
  module?: string;
  exports?: unknown;
}

function resolveFromPackage(pkgDir: string, subpath: string): string | null {
  if (subpath && subpath !== '.') {
    // Direct subpath import: pkg/sub/x → try as file under pkgDir
    const abs = join(pkgDir, subpath);
    return tryExtensions(abs);
  }
  // Read package.json
  const pj = join(pkgDir, 'package.json');
  if (!existsFile(pj)) return null;
  let manifest: PackageJson;
  try {
    manifest = JSON.parse(readFileSync(pj, 'utf8'));
  } catch {
    return null;
  }
  if (manifest.exports && typeof manifest.exports === 'object') {
    const exp = manifest.exports as Record<string, unknown>;
    const root = exp['.'] ?? exp;
    if (typeof root === 'string') {
      const abs = join(pkgDir, root);
      if (existsFile(abs)) return abs;
    } else if (root && typeof root === 'object') {
      // Conditional exports: prefer import, then default, then require.
      const cond = root as Record<string, unknown>;
      for (const key of ['import', 'default', 'require', 'node']) {
        const v = cond[key];
        if (typeof v === 'string') {
          const abs = join(pkgDir, v);
          if (existsFile(abs)) return abs;
        }
      }
    }
  }
  if (manifest.main && typeof manifest.main === 'string') {
    const abs = join(pkgDir, manifest.main);
    if (existsFile(abs)) return abs;
    const hit = tryExtensions(abs);
    if (hit) return hit;
  }
  if (manifest.module && typeof manifest.module === 'string') {
    const abs = join(pkgDir, manifest.module);
    if (existsFile(abs)) return abs;
  }
  // Fallback to index.{ext}
  for (const ext of EXTENSION_ORDER) {
    const cand = join(pkgDir, 'index' + ext);
    if (existsFile(cand)) return cand;
  }
  return null;
}

function tryNodeModules(specifier: string, fromDir: string, root: string): string | null {
  let pkgName: string;
  let subpath: string;
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    pkgName = parts.slice(0, 2).join('/');
    subpath = parts.slice(2).join('/');
  } else {
    const idx = specifier.indexOf('/');
    if (idx === -1) {
      pkgName = specifier;
      subpath = '';
    } else {
      pkgName = specifier.slice(0, idx);
      subpath = specifier.slice(idx + 1);
    }
  }
  for (const nm of walkUpNodeModules(fromDir, root)) {
    const pkgDir = join(nm, pkgName);
    if (existsDir(pkgDir)) {
      return resolveFromPackage(pkgDir, subpath);
    }
  }
  return null;
}

/**
 * Resolve an import specifier from a file. Returns:
 *  - an absolute path string for files within the project / node_modules
 *  - 'external:<name>' for node builtins or known popular npm packages
 *  - null for dynamic-without-literal, escapes from root, or genuine unresolvables
 *
 * SPEC §4.2 step 3.
 */
export function resolveImport({ from, specifier, root }: ResolveOpts): string | null {
  if (!specifier || typeof specifier !== 'string') return null;

  // node: protocol
  if (specifier.startsWith('node:')) {
    return `external:${specifier.slice('node:'.length)}`;
  }

  // Bare builtin
  if (NODE_BUILTINS.has(specifier)) {
    return `external:${specifier}`;
  }

  // Relative or absolute path
  if (specifier.startsWith('./') || specifier.startsWith('../') || isAbsolute(specifier)) {
    const fromDir = dirname(from);
    const abs = resolve(fromDir, specifier);
    if (!isWithinRoot(abs, root)) return null;
    return tryExtensions(abs);
  }

  // tsconfig.paths alias
  const aliasHit = tryTsconfigPaths(specifier, root);
  if (aliasHit) return aliasHit;

  // Bare package via node_modules
  const fromDir = dirname(from);
  const nmHit = tryNodeModules(specifier, fromDir, root);
  if (nmHit) return nmHit;

  // Fall back to known-popular allowlist
  if (KNOWN_EXTERNALS.has(specifier)) {
    return `external:${specifier}`;
  }
  // Also surface scoped builtins like 'fs/promises'
  if (NODE_BUILTINS.has(specifier)) return `external:${specifier}`;

  return null;
}
