/**
 * SPEC.md §6.3 — /compass-expand <component-id> [--depth N].
 *
 *  - validates the component exists
 *  - scopes the file graph to just that component, then re-runs cluster +
 *    propose + critique within that scope
 *  - writes analysis.subgraphs[<id>] so future incremental runs can reuse it
 *  - updates the component's .md page with the embedded sub-Mermaid
 *  - depth cap (2) is honored
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildExpressTiny } from '../helpers/fixtures.js';
import { scriptFakeClaude, fakeClaudeReset } from '../helpers/fakeClaude.js';
import type { TmpRepo } from '../helpers/tmp.js';

let r: TmpRepo;
const scriptsDir = join(__dirname, '..', '..', 'scripts');
const runScript = (file: string, args: string[] = []) =>
  execFileSync('npx', ['tsx', join(scriptsDir, file), ...args], { cwd: r.root, encoding: 'utf8' });

const fakeTopLevel = {
  components: [
    { id: 'C1', name: 'API', description: '', rationale: 'r', files: ['src/api/users.ts', 'src/api/billing.ts'], symbols: [], depth: 1, subgraph_ref: null, confidence: 'high' },
    { id: 'C2', name: 'Services', description: '', rationale: 'r', files: ['src/services/user.ts', 'src/services/billing.ts'], symbols: [], depth: 1, subgraph_ref: null, confidence: 'high' },
    { id: 'C3', name: 'Repos', description: '', rationale: 'r', files: ['src/repositories/user.ts', 'src/repositories/billing.ts'], symbols: [], depth: 1, subgraph_ref: null, confidence: 'high' },
    { id: 'C4', name: 'Utils', description: '', rationale: 'r', files: ['src/utils/auth.ts', 'src/utils/logger.ts'], symbols: [], depth: 1, subgraph_ref: null, confidence: 'medium' },
  ],
  edges: [],
  rationale: ['x'],
};
const fakeSubgraph = {
  components: [
    { id: 'C1.1', name: 'User Routes', description: '', rationale: 'r', files: ['src/api/users.ts'], symbols: [], depth: 2, subgraph_ref: null, confidence: 'high' },
    { id: 'C1.2', name: 'Billing Routes', description: '', rationale: 'r', files: ['src/api/billing.ts'], symbols: [], depth: 2, subgraph_ref: null, confidence: 'high' },
  ],
  edges: [],
  rationale: ['route-per-resource'],
};

const fullScan = () => {
  runScript('scan-init.ts', ['--depth', '1']);
  runScript('scan-walk.ts');
  runScript('scan-parse.ts');
  runScript('scan-cluster.ts');
  scriptFakeClaude([fakeTopLevel, fakeTopLevel]);
  runScript('scan-propose.ts');
  runScript('scan-critique.ts');
  runScript('scan-render.ts');
};

beforeEach(() => { r = buildExpressTiny(); fakeClaudeReset(); fullScan(); });
afterEach(() => { r.cleanup(); fakeClaudeReset(); });

describe('expand — happy path', () => {
  it('writes analysis.subgraphs[<id>] and updates the component .md', () => {
    runScript('expand-init.ts', ['--component', 'C1', '--depth', '2']);
    runScript('expand-scope.ts', ['--component', 'C1']);
    runScript('scan-cluster.ts', ['--scope', 'C1']);
    scriptFakeClaude([fakeSubgraph, fakeSubgraph]);
    runScript('scan-propose.ts', ['--scope', 'C1']);
    runScript('scan-critique.ts', ['--scope', 'C1']);
    runScript('scan-render.ts', ['--component', 'C1', '--depth', '2']);
    const a = JSON.parse(readFileSync(r.path('.compass/analysis.json'), 'utf8'));
    expect(a.subgraphs.C1).toBeDefined();
    expect(a.subgraphs.C1.components.map((c: any) => c.id).sort()).toEqual(['C1.1', 'C1.2']);
    const md = readFileSync(r.path('.compass/API.md'), 'utf8');
    expect(md).toContain('C1.1');
    expect(md).toContain('C1.2');
  });

  it("rejects --depth 3 (v1 cap is 2, per §6.3 step 1)", () => {
    expect(() => runScript('expand-init.ts', ['--component', 'C1', '--depth', '3'])).toThrow();
  });

  it("errors clearly when the component id doesn't exist", () => {
    expect(() => runScript('expand-init.ts', ['--component', 'C99', '--depth', '2'])).toThrow(/C99|not found/i);
  });

  it('does not touch components other than the requested one', () => {
    const before = readFileSync(r.path('.compass/Services.md'), 'utf8');
    runScript('expand-init.ts', ['--component', 'C1', '--depth', '2']);
    runScript('expand-scope.ts', ['--component', 'C1']);
    runScript('scan-cluster.ts', ['--scope', 'C1']);
    scriptFakeClaude([fakeSubgraph, fakeSubgraph]);
    runScript('scan-propose.ts', ['--scope', 'C1']);
    runScript('scan-critique.ts', ['--scope', 'C1']);
    runScript('scan-render.ts', ['--component', 'C1', '--depth', '2']);
    const after = readFileSync(r.path('.compass/Services.md'), 'utf8');
    expect(after).toBe(before);
  });
});

describe('expand — depth 2 cost confirmation', () => {
  it('prints the predicted LLM-call count before depth=2 work (SPEC §6.1 step 7 / §13 Open Q6)', () => {
    const out = runScript('expand-init.ts', ['--component', 'C1', '--depth', '2']);
    expect(out).toMatch(/LLM call|expected call|cost/i);
  });
});
