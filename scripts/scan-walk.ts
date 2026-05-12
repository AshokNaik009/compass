#!/usr/bin/env -S npx tsx
import { relative } from 'node:path';
import { statSync } from 'node:fs';
import { walk, hashFile } from '../src/lib/walk.ts';
import { transitionPhase, forcePhase, saveState } from '../src/lib/state.ts';
import { statePath } from '../src/lib/paths.ts';
import { withLock, loadStateOrThrow, markFailed } from '../src/lib/runner.ts';
import { printCostLine } from '../src/lib/paths.ts';
import { revParseHEAD, isGitRepo } from '../src/lib/git.ts';

const root = process.cwd();

withLock(root, () => {
  try {
    const start = Date.now();
    let s = loadStateOrThrow(root);
    const files = walk(root);
    s.files = {};
    for (const abs of files) {
      const rel = relative(root, abs);
      const st = statSync(abs);
      s.files[rel] = {
        sha256: hashFile(abs),
        mtime: st.mtime.toISOString(),
        component_id: null,
      };
    }
    s.stats.files_parsed = files.length;
    if (isGitRepo(root)) {
      s.last_commit_sha = revParseHEAD(root);
    }
    s = s.phase === 'walking' ? transitionPhase(s, 'parsing') : forcePhase(s, 'parsing');
    s.stats.duration_ms = (s.stats.duration_ms ?? 0) + (Date.now() - start);
    saveState(statePath(root), s);
    console.log(`[compass] scan-walk: ${files.length} files`);
    printCostLine('scan-walk', 0, 0, Date.now() - start);
  } catch (err) {
    markFailed(root, err as Error);
    throw err;
  }
});
