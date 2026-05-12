#!/usr/bin/env -S npx tsx
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseSource } from '../src/lib/parse.ts';
import { resolveImport } from '../src/lib/resolve.ts';
import { transitionPhase, forcePhase, saveState } from '../src/lib/state.ts';
import { statePath, graphSidecarPath } from '../src/lib/paths.ts';
import { withLock, loadStateOrThrow, markFailed } from '../src/lib/runner.ts';
import { printCostLine } from '../src/lib/paths.ts';

interface FileImportRecord {
  from: string;
  to: string | null;
  usedCount: number;
  typeOnly: boolean;
}

const root = process.cwd();

withLock(root, () => {
  try {
    const start = Date.now();
    let s = loadStateOrThrow(root);

    const fileImports: FileImportRecord[] = [];
    const exportsByFile: Record<string, string[]> = {};
    for (const rel of Object.keys(s.files)) {
      const abs = join(root, rel);
      const parsed = parseSource(abs);
      exportsByFile[rel] = parsed.exports;
      for (const imp of parsed.imports) {
        const resolved = resolveImport({ from: abs, specifier: imp.specifier, root });
        let toRel: string | null = null;
        if (resolved && resolved.startsWith('external:')) {
          toRel = resolved; // keep as-is so the graph drops it
        } else if (resolved) {
          toRel = resolved.startsWith(root + '/') ? resolved.slice(root.length + 1) : resolved;
        }
        fileImports.push({
          from: rel,
          to: toRel,
          usedCount: imp.usedCount,
          typeOnly: imp.typeOnly,
        });
      }
    }

    const sideDir = dirname(graphSidecarPath(root));
    if (!existsSync(sideDir)) mkdirSync(sideDir, { recursive: true });
    writeFileSync(
      graphSidecarPath(root),
      JSON.stringify({ fileImports, exportsByFile }, null, 2),
    );

    s = s.phase === 'parsing' ? transitionPhase(s, 'clustering') : forcePhase(s, 'clustering');
    s.stats.duration_ms = (s.stats.duration_ms ?? 0) + (Date.now() - start);
    saveState(statePath(root), s);
    console.log(`[compass] scan-parse: ${fileImports.length} file-level imports`);
    printCostLine('scan-parse', 0, 0, Date.now() - start);
  } catch (err) {
    markFailed(root, err as Error);
    throw err;
  }
});
