/**
 * SPEC.md §6.4 — /compass-status (read-only, NEVER acquires the lock).
 *
 *  - "no analysis yet" when state.json is missing
 *  - "did not finish — run /compass-recover" when phase != 'done'
 *  - diff: changed, new, deleted files
 *  - stale_components = union of components owning those files
 *  - prints suggestion to run /compass-refresh when stale_components nonempty
 *  - does NOT mutate state.json, .compass/.lock, or analysis.json
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, statSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { buildExpressTiny } from '../helpers/fixtures.js';
import { scriptFakeClaude, fakeClaudeReset } from '../helpers/fakeClaude.js';
import type { TmpRepo } from '../helpers/tmp.js';

let r: TmpRepo;
const scriptsDir = join(__dirname, '..', '..', 'scripts');
const runScript = (file: string, args: string[] = []) =>
  execFileSync('npx', ['tsx', join(scriptsDir, file), ...args], { cwd: r.root, encoding: 'utf8' });

const fakeProposal = {
  components: [
    { id: 'C1', name: 'API', description: '', rationale: 'r', files: ['src/api/users.ts', 'src/api/billing.ts'], symbols: [], depth: 1, subgraph_ref: null, confidence: 'high' },
    { id: 'C2', name: 'Services', description: '', rationale: 'r', files: ['src/services/user.ts', 'src/services/billing.ts'], symbols: [], depth: 1, subgraph_ref: null, confidence: 'high' },
    { id: 'C3', name: 'Repos', description: '', rationale: 'r', files: ['src/repositories/user.ts', 'src/repositories/billing.ts'], symbols: [], depth: 1, subgraph_ref: null, confidence: 'high' },
    { id: 'C4', name: 'Utils', description: '', rationale: 'r', files: ['src/utils/auth.ts', 'src/utils/logger.ts'], symbols: [], depth: 1, subgraph_ref: null, confidence: 'medium' },
  ],
  edges: [],
  rationale: ['x'],
};

beforeEach(() => { r = buildExpressTiny(); fakeClaudeReset(); });
afterEach(() => { r.cleanup(); fakeClaudeReset(); });

describe('status — no analysis yet', () => {
  it("suggests /compass-scan when state.json is absent", () => {
    const out = runScript('status.ts');
    expect(out).toMatch(/no analysis yet/i);
    expect(out).toMatch(/\/compass-scan/);
  });

  it('returns exit code 0 (it is informational, not an error)', () => {
    expect(() => runScript('status.ts')).not.toThrow();
  });
});

describe('status — incomplete previous run', () => {
  it("suggests /compass-recover when phase != 'done'", () => {
    runScript('scan-init.ts', ['--depth', '1']);
    runScript('scan-walk.ts');
    // leave phase=parsing — never finished
    const out = runScript('status.ts');
    expect(out).toMatch(/did not finish|recover/i);
    expect(out).toMatch(/\/compass-recover/);
  });
});

describe('status — working-tree drift detection', () => {
  const doFullScan = () => {
    runScript('scan-init.ts', ['--depth', '1']);
    runScript('scan-walk.ts');
    runScript('scan-parse.ts');
    runScript('scan-cluster.ts');
    scriptFakeClaude([fakeProposal, fakeProposal]);
    runScript('scan-propose.ts');
    runScript('scan-critique.ts');
    runScript('scan-render.ts');
  };

  it('reports clean working tree when nothing changed', () => {
    doFullScan();
    const out = runScript('status.ts');
    expect(out).toMatch(/up to date|no stale/i);
  });

  it('reports a single changed file → 1 stale component (C2)', () => {
    doFullScan();
    writeFileSync(r.path('src/services/user.ts'), readFileSync(r.path('src/services/user.ts'), 'utf8') + '\n// noop');
    const out = runScript('status.ts');
    expect(out).toContain('src/services/user.ts');
    expect(out).toContain('C2');
    expect(out).toMatch(/1 component/i);
  });

  it('reports new files (added on disk, not in state)', () => {
    doFullScan();
    writeFileSync(r.path('src/services/newthing.ts'), 'export const x = 1;');
    const out = runScript('status.ts');
    expect(out).toMatch(/new/i);
    expect(out).toContain('src/services/newthing.ts');
  });

  it('reports deleted files (in state, not on disk)', () => {
    doFullScan();
    unlinkSync(r.path('src/utils/logger.ts'));
    const out = runScript('status.ts');
    expect(out).toMatch(/deleted/i);
    expect(out).toContain('src/utils/logger.ts');
  });

  it('suggests /compass-refresh when any stale component exists', () => {
    doFullScan();
    writeFileSync(r.path('src/services/user.ts'), readFileSync(r.path('src/services/user.ts'), 'utf8') + '\n// x');
    const out = runScript('status.ts');
    expect(out).toMatch(/\/compass-refresh/);
  });
});

describe('status — read-only invariants', () => {
  it('does NOT acquire .compass/.lock (read-only — SPEC §6.4)', () => {
    runScript('scan-init.ts', ['--depth', '1']);
    runScript('status.ts');
    expect(existsSync(r.path('.compass/.lock'))).toBe(false);
  });

  it('does NOT mutate state.json (file mtime stays unchanged)', () => {
    runScript('scan-init.ts', ['--depth', '1']);
    const m1 = statSync(r.path('.compass/state.json')).mtimeMs;
    runScript('status.ts');
    const m2 = statSync(r.path('.compass/state.json')).mtimeMs;
    expect(m2).toBe(m1);
  });
});
