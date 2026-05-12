#!/usr/bin/env -S npx tsx
import { statSync, readFileSync, existsSync } from 'node:fs';
import { relative, join } from 'node:path';
import { walk, hashFile } from '../src/lib/walk.ts';
import { isGitRepo, diffNames } from '../src/lib/git.ts';
import { loadState, saveState, forcePhase } from '../src/lib/state.ts';
import { statePath, graphSidecarPath } from '../src/lib/paths.ts';
import { withLock, loadStateOrThrow, markFailed } from '../src/lib/runner.ts';
import { parseSource } from '../src/lib/parse.ts';
import { resolveImport } from '../src/lib/resolve.ts';

const root = process.cwd();

function lookupComponent(rel: string, s: ReturnType<typeof loadStateOrThrow>): string | null {
  return s.files[rel]?.component_id ?? null;
}

withLock(root, () => {
  try {
    const s = loadStateOrThrow(root);
    // Detect changes vs last_commit_sha (preferred) OR via hash diff.
    const currentFiles = walk(root);
    const currentByRel = new Map<string, string>();
    for (const abs of currentFiles) currentByRel.set(relative(root, abs), abs);

    const changed = new Set<string>();
    const added = new Set<string>();
    const deleted = new Set<string>();

    // Hash-based diff for anything tracked
    for (const [rel, entry] of Object.entries(s.files)) {
      if (!currentByRel.has(rel)) {
        deleted.add(rel);
        continue;
      }
      const abs = currentByRel.get(rel)!;
      const newHash = hashFile(abs);
      if (newHash !== entry.sha256) changed.add(rel);
    }
    for (const rel of currentByRel.keys()) {
      if (!s.files[rel]) added.add(rel);
    }

    // Git diff overlay if available
    if (s.last_commit_sha && isGitRepo(root)) {
      try {
        const names = diffNames(root, s.last_commit_sha, 'HEAD');
        for (const n of names) {
          if (currentByRel.has(n)) {
            if (!s.files[n]) added.add(n);
            else changed.add(n);
          } else if (s.files[n]) {
            deleted.add(n);
          }
        }
        const workNames = diffNames(root, 'HEAD', 'WORKDIR');
        for (const n of workNames) {
          if (currentByRel.has(n)) {
            if (!s.files[n]) added.add(n);
            else changed.add(n);
          } else if (s.files[n]) {
            deleted.add(n);
          }
        }
      } catch {
        // ignore — hash diff already populated
      }
    }

    const anyChange = changed.size + added.size + deleted.size;
    if (anyChange === 0) {
      console.log('[compass] refresh-diff: up to date');
      return;
    }

    // Classify
    const affected = new Set<string>();
    for (const c of changed) {
      const cid = lookupComponent(c, s);
      if (cid) affected.add(cid);
    }

    // Neighbour-profile check: if a changed file's cross-component import set changes, UNSAFE.
    let neighbourUnsafe = false;
    if (changed.size > 0) {
      // Load old graph sidecar to get baseline imports
      const sidecarPath = graphSidecarPath(root);
      let oldImportsByFile: Map<string, Set<string>> = new Map();
      if (existsSync(sidecarPath)) {
        try {
          const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as {
            fileImports: Array<{ from: string; to: string | null }>;
          };
          for (const fi of sidecar.fileImports) {
            if (!fi.to || fi.to.startsWith('external:')) continue;
            const toCid = lookupComponent(fi.to, s);
            if (!toCid) continue;
            const fromCid = lookupComponent(fi.from, s);
            if (!fromCid || fromCid === toCid) continue;
            if (!oldImportsByFile.has(fi.from)) oldImportsByFile.set(fi.from, new Set());
            oldImportsByFile.get(fi.from)!.add(toCid);
          }
        } catch { /* ignore */ }
      }

      for (const rel of changed) {
        const abs = currentByRel.get(rel);
        if (!abs) continue;
        const fileCid = lookupComponent(rel, s);
        if (!fileCid) continue;
        // Parse new imports for this file
        const newCrossComponents = new Set<string>();
        try {
          const parsed = parseSource(abs);
          for (const imp of parsed.imports) {
            if (!imp.specifier) continue;
            const resolved = resolveImport({ from: abs, specifier: imp.specifier, root });
            if (!resolved || resolved.startsWith('external:')) continue;
            const resolvedRel = relative(root, resolved);
            const targetCid = lookupComponent(resolvedRel, s);
            if (targetCid && targetCid !== fileCid) newCrossComponents.add(targetCid);
          }
        } catch { continue; }

        const oldCross = oldImportsByFile.get(rel) ?? new Set<string>();
        // Check if cross-component import set changed
        const added2 = [...newCrossComponents].filter((c) => !oldCross.has(c));
        const removed2 = [...oldCross].filter((c) => !newCrossComponents.has(c));
        if (added2.length > 0 || removed2.length > 0) {
          neighbourUnsafe = true;
          break;
        }
      }
    }

    const unsafe = added.size > 0 || deleted.size > 0 || neighbourUnsafe;

    if (unsafe) {
      console.log(`[compass] refresh-diff: UNSAFE`);
      for (const f of changed) console.log(`  changed: ${f}`);
      for (const f of added) console.log(`  added:   ${f}`);
      for (const f of deleted) console.log(`  deleted: ${f}`);
      console.log('  → falling through to full re-cluster (run scan-cluster, scan-propose, scan-critique, scan-render).');
      // Mark state for full re-cluster
      const next = forcePhase({ ...s }, 'clustering');
      // Update file manifest to reflect current state
      for (const rel of currentByRel.keys()) {
        const abs = currentByRel.get(rel)!;
        const st = statSync(abs);
        next.files[rel] = {
          sha256: hashFile(abs),
          mtime: st.mtime.toISOString(),
          component_id: next.files[rel]?.component_id ?? null,
        };
      }
      for (const rel of deleted) delete next.files[rel];
      saveState(statePath(root), next);
    } else {
      console.log(`[compass] refresh-diff: SAFE`);
      for (const c of changed) console.log(`  changed: ${c} (component=${lookupComponent(c, s) ?? '?'})`);
      console.log(`  affected components: ${Array.from(affected).join(',') || '(none)'}`);
    }
  } catch (err) {
    markFailed(root, err as Error);
    throw err;
  }
});

