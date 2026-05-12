import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

export interface TmpRepo {
  root: string;
  write(rel: string, body: string): string;
  mkdir(rel: string): string;
  path(rel: string): string;
  cleanup(): void;
}

export function makeTmpRepo(prefix = 'compass-test-'): TmpRepo {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return {
    root,
    write(rel, body) {
      const p = join(root, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body, 'utf8');
      return p;
    },
    mkdir(rel) {
      const p = join(root, rel);
      mkdirSync(p, { recursive: true });
      return p;
    },
    path(rel) {
      return join(root, rel);
    },
    cleanup() {
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    },
  };
}
