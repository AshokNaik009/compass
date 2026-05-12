import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AnalysisSchema, type Analysis } from '../schema/analysis.ts';

function ensureDir(path: string) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function sortComponents(a: Analysis): Analysis {
  const numericId = (id: string) => {
    const m = id.match(/^C(\d+)(?:\.(\d+))?$/);
    if (!m) return [Number.POSITIVE_INFINITY, 0] as const;
    return [Number(m[1]), m[2] ? Number(m[2]) : 0] as const;
  };
  const cmp = (a1: string, b1: string) => {
    const [a0, a1n] = numericId(a1);
    const [b0, b1n] = numericId(b1);
    return a0 - b0 || a1n - b1n;
  };
  return {
    ...a,
    components: [...a.components].sort((x, y) => cmp(x.id, y.id)),
  };
}

export function loadAnalysis(analysisPath: string): Analysis | null {
  if (!existsSync(analysisPath)) return null;
  const raw = readFileSync(analysisPath, 'utf8');
  const parsed = JSON.parse(raw); // throw on syntax error — analysis corruption is catastrophic
  return AnalysisSchema.parse(parsed);
}

export function saveAnalysis(analysisPath: string, analysis: Analysis): void {
  const validated = AnalysisSchema.parse(analysis);
  const normalized = sortComponents(validated);
  ensureDir(analysisPath);
  const tmp = `${analysisPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(normalized, null, 2));
  renameSync(tmp, analysisPath);
}
