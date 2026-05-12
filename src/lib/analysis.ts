import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { AnalysisSchema, type Analysis } from '../schema/analysis.ts';
import { analysisPath, ensureCompassDir } from './state.ts';

export function loadAnalysis(root: string): Analysis {
  const p = analysisPath(root);
  if (!existsSync(p)) throw new Error(`no analysis found at ${p}`);
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  return AnalysisSchema.parse(raw);
}

export function loadAnalysisOrNull(root: string): Analysis | null {
  try {
    return loadAnalysis(root);
  } catch {
    return null;
  }
}

export function saveAnalysis(root: string, analysis: Analysis) {
  ensureCompassDir(root);
  const p = analysisPath(root);
  const tmp = `${p}.tmp`;
  const parsed = AnalysisSchema.parse(analysis);
  writeFileSync(tmp, JSON.stringify(parsed, null, 2));
  renameSync(tmp, p);
}
