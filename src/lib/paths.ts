import { join } from 'node:path';

export const COMPASS_DIR = '.compass';

export function compassDir(root: string): string {
  return join(root, COMPASS_DIR);
}

export function statePath(root: string): string {
  return join(root, COMPASS_DIR, 'state.json');
}

export function analysisPath(root: string): string {
  return join(root, COMPASS_DIR, 'analysis.json');
}

export function lockPath(root: string): string {
  return join(root, COMPASS_DIR, '.lock');
}

export function graphSidecarPath(root: string): string {
  return join(root, COMPASS_DIR, 'graph.json');
}

export function clustersSidecarPath(root: string): string {
  return join(root, COMPASS_DIR, 'clusters.json');
}

export function proposalSidecarPath(root: string): string {
  return join(root, COMPASS_DIR, 'proposal.json');
}

export function parseScopeArg(argv: string[], name: string): string | null {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  return argv[idx + 1] ?? null;
}

export function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

export function parseDepth(argv: string[]): 1 | 2 {
  const v = parseScopeArg(argv, 'depth');
  if (!v) return 1;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 2) {
    throw new Error(`--depth must be 1 or 2 (got ${v}); v1 caps depth at 2`);
  }
  return n as 1 | 2;
}

export function printCostLine(label: string, tokensIn: number, tokensOut: number, durationMs: number): void {
  // SPEC §3.4 — one-line cost summary at the end of every command.
  console.log(`[compass] ${label}: tokens_in=${tokensIn} tokens_out=${tokensOut} duration_ms=${durationMs}`);
}
