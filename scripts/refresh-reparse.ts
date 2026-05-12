#!/usr/bin/env -S npx tsx
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseSource } from '../src/lib/parse.ts';
import { resolveImport } from '../src/lib/resolve.ts';
import { hashFile } from '../src/lib/walk.ts';
import { saveState } from '../src/lib/state.ts';
import { statePath, graphSidecarPath, parseScopeArg } from '../src/lib/paths.ts';
import { withLock, loadStateOrThrow, markFailed } from '../src/lib/runner.ts';

const root = process.cwd();
const argv = process.argv.slice(2);

function parseList(name: string): string[] {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return [];
  const v = argv[idx + 1] ?? '';
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

const components = parseList('components');

withLock(root, () => {
  try {
    const s = loadStateOrThrow(root);
    const side = JSON.parse(readFileSync(graphSidecarPath(root), 'utf8')) as {
      fileImports: Array<{ from: string; to: string | null; usedCount: number; typeOnly: boolean }>;
      exportsByFile: Record<string, string[]>;
    };

    const targetFiles = new Set<string>();
    for (const [rel, entry] of Object.entries(s.files)) {
      if (components.includes(entry.component_id ?? '__none__')) targetFiles.add(rel);
    }

    // Re-parse those files
    const newImports = side.fileImports.filter((fi) => !targetFiles.has(fi.from));
    for (const rel of targetFiles) {
      const abs = join(root, rel);
      const parsed = parseSource(abs);
      side.exportsByFile[rel] = parsed.exports;
      for (const imp of parsed.imports) {
        const resolved = resolveImport({ from: abs, specifier: imp.specifier, root });
        let toRel: string | null = null;
        if (resolved && resolved.startsWith('external:')) toRel = resolved;
        else if (resolved) toRel = resolved.startsWith(root + '/') ? resolved.slice(root.length + 1) : resolved;
        newImports.push({ from: rel, to: toRel, usedCount: imp.usedCount, typeOnly: imp.typeOnly });
      }
      const st = statSync(abs);
      s.files[rel] = {
        sha256: hashFile(abs),
        mtime: st.mtime.toISOString(),
        component_id: s.files[rel]?.component_id ?? null,
      };
    }

    side.fileImports = newImports;
    writeFileSync(graphSidecarPath(root), JSON.stringify(side, null, 2));
    saveState(statePath(root), s);
    console.log(`[compass] refresh-reparse: re-parsed ${targetFiles.size} files for components=${components.join(',')}`);
  } catch (err) {
    markFailed(root, err as Error);
    throw err;
  }
});

void parseScopeArg;
