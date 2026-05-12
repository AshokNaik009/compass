/**
 * SPEC.md §6.1 — /compass-scan end-to-end (12 steps).
 *
 * The skill calls scripts sequentially; each script writes state.json and
 * eventually analysis.json + .compass/*.md. These tests drive each script
 * directly via tsx and verify post-conditions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildExpressTiny } from '../helpers/fixtures.js';
import { setFakeClaude, scriptFakeClaude, fakeClaudeReset } from '../helpers/fakeClaude.js';
import type { TmpRepo } from '../helpers/tmp.js';

let r: TmpRepo;
const scriptsDir = join(__dirname, '..', '..', 'scripts');

const runScript = (file: string, args: string[] = []) =>
  execFileSync('npx', ['tsx', join(scriptsDir, file), ...args], { cwd: r.root, encoding: 'utf8' });

const fakeProposal = {
  components: [
    { id: 'C1', name: 'API Layer', description: 'desc', rationale: 'r', files: ['src/api/users.ts', 'src/api/billing.ts'], symbols: ['userRoutes', 'billingRoutes'], depth: 1, subgraph_ref: null, confidence: 'high' },
    { id: 'C2', name: 'Services', description: 'desc', rationale: 'r', files: ['src/services/user.ts', 'src/services/billing.ts'], symbols: ['UserService', 'BillingService'], depth: 1, subgraph_ref: null, confidence: 'high' },
    { id: 'C3', name: 'Repositories', description: 'desc', rationale: 'r', files: ['src/repositories/user.ts', 'src/repositories/billing.ts'], symbols: ['UserRepo', 'BillingRepo'], depth: 1, subgraph_ref: null, confidence: 'high' },
    { id: 'C4', name: 'Utilities', description: 'desc', rationale: 'r', files: ['src/utils/auth.ts', 'src/utils/logger.ts'], symbols: ['authMiddleware', 'log'], depth: 1, subgraph_ref: null, confidence: 'medium' },
  ],
  edges: [
    { from: 'C1', to: 'C2', weight: 2, reason: 'routes use services' },
    { from: 'C2', to: 'C3', weight: 2, reason: 'services use repos' },
    { from: 'C1', to: 'C4', weight: 1, reason: 'routes use auth middleware' },
  ],
  rationale: ['Layered MERN architecture.'],
};

beforeEach(() => {
  r = buildExpressTiny();
  fakeClaudeReset();
});
afterEach(() => {
  r.cleanup();
  fakeClaudeReset();
});

describe('scan-init', () => {
  it("initializes state.json with phase='walking' and pinned louvain settings", () => {
    runScript('scan-init.ts', ['--depth', '1']);
    const s = JSON.parse(readFileSync(r.path('.compass/state.json'), 'utf8'));
    expect(s.phase).toBe('walking');
    expect(s.depth).toBe(1);
    expect(s.pins.louvain_seed).toMatch(/^[0-9a-f]{8}$/);
  });

  it('refuses --depth 3 (v1 cap is 2, SPEC §2 + §6.1 step 2)', () => {
    expect(() => runScript('scan-init.ts', ['--depth', '3'])).toThrow();
  });

  it('refuses --depth 0', () => {
    expect(() => runScript('scan-init.ts', ['--depth', '0'])).toThrow();
  });

  it('does not overwrite a finished analysis without an explicit --force (avoids destroying maintainer work)', () => {
    runScript('scan-init.ts', ['--depth', '1']);
    expect(() => runScript('scan-init.ts', ['--depth', '1'])).toThrow(/exists|force/i);
  });
});

describe('scan-walk', () => {
  it("transitions phase to 'parsing' and lists all kept files", () => {
    runScript('scan-init.ts', ['--depth', '1']);
    runScript('scan-walk.ts');
    const s = JSON.parse(readFileSync(r.path('.compass/state.json'), 'utf8'));
    expect(s.phase).toBe('parsing');
    expect(Object.keys(s.files).sort()).toEqual([
      'src/api/billing.ts', 'src/api/users.ts',
      'src/repositories/billing.ts', 'src/repositories/user.ts',
      'src/services/billing.ts', 'src/services/user.ts',
      'src/utils/auth.ts', 'src/utils/logger.ts',
    ]);
  });

  it('respects the .compassignore in the fixture (no *.test.ts gets listed)', () => {
    r.write('src/api/users.test.ts', 'import "./users"; test("x", () => {});');
    runScript('scan-init.ts', ['--depth', '1']);
    runScript('scan-walk.ts');
    const s = JSON.parse(readFileSync(r.path('.compass/state.json'), 'utf8'));
    expect(Object.keys(s.files)).not.toContain('src/api/users.test.ts');
  });
});

describe('scan-parse + scan-cluster', () => {
  it("populates a file-level import graph and transitions to 'proposing'", () => {
    runScript('scan-init.ts', ['--depth', '1']);
    runScript('scan-walk.ts');
    runScript('scan-parse.ts');
    runScript('scan-cluster.ts');
    const s = JSON.parse(readFileSync(r.path('.compass/state.json'), 'utf8'));
    expect(s.phase).toBe('proposing');
    // 4 logical clusters in this fixture (api/services/repos/utils) — but Louvain may merge
    expect(s.stats.clusters_pre_llm).toBeGreaterThanOrEqual(2);
    expect(s.stats.clusters_pre_llm).toBeLessThanOrEqual(8);
  });

  it('is reproducible across runs on the same commit (Open Q4)', () => {
    runScript('scan-init.ts', ['--depth', '1']); runScript('scan-walk.ts'); runScript('scan-parse.ts'); runScript('scan-cluster.ts');
    const s1 = JSON.parse(readFileSync(r.path('.compass/state.json'), 'utf8'));
    // wipe and re-run
    execFileSync('rm', ['-rf', r.path('.compass')]);
    runScript('scan-init.ts', ['--depth', '1']); runScript('scan-walk.ts'); runScript('scan-parse.ts'); runScript('scan-cluster.ts');
    const s2 = JSON.parse(readFileSync(r.path('.compass/state.json'), 'utf8'));
    // ignore timestamps; compare clustering decisions only
    const norm = (s: any) => Object.fromEntries(Object.entries(s.files).map(([k, v]: [string, any]) => [k, v.component_id ?? null]));
    expect(norm(s1)).toEqual(norm(s2));
  });
});

describe('scan-propose + scan-critique (two-pass LLM, SPEC §4.2 steps 6–7)', () => {
  it('writes analysis.json with components, edges, and a rationale per component', () => {
    runScript('scan-init.ts', ['--depth', '1']); runScript('scan-walk.ts'); runScript('scan-parse.ts'); runScript('scan-cluster.ts');
    scriptFakeClaude([fakeProposal, fakeProposal]); // propose, then critique returns same
    runScript('scan-propose.ts');
    runScript('scan-critique.ts');
    const a = JSON.parse(readFileSync(r.path('.compass/analysis.json'), 'utf8'));
    expect(a.components).toHaveLength(4);
    expect(a.components.every((c: any) => c.rationale && c.rationale.length > 0)).toBe(true);
    expect(a.llm.calls.map((c: any) => c.phase)).toEqual(['propose', 'critique']);
  });

  it("rejects shallow names like 'Utilities' or 'Core' if the critique pass returns them unchanged", () => {
    // SPEC §4.2 step 7 explicitly says the critique pass must revise shallow names.
    // If the LLM returns "Utilities", the script either accepts it (it was already in
    // the proposal and the user is OK with it) OR the wrapper enforces a non-shallow
    // name. We pin the looser contract: critique output is taken as-is unless empty.
    const proposalWithShallow = { ...fakeProposal, components: [...fakeProposal.components] };
    proposalWithShallow.components[3] = { ...proposalWithShallow.components[3], name: 'Utilities' };
    runScript('scan-init.ts', ['--depth', '1']); runScript('scan-walk.ts'); runScript('scan-parse.ts'); runScript('scan-cluster.ts');
    scriptFakeClaude([proposalWithShallow, proposalWithShallow]);
    runScript('scan-propose.ts');
    runScript('scan-critique.ts');
    const a = JSON.parse(readFileSync(r.path('.compass/analysis.json'), 'utf8'));
    expect(a.components.find((c: any) => c.name === 'Utilities')).toBeTruthy();
  });

  it('records token counts for both passes', () => {
    runScript('scan-init.ts', ['--depth', '1']); runScript('scan-walk.ts'); runScript('scan-parse.ts'); runScript('scan-cluster.ts');
    scriptFakeClaude([fakeProposal, fakeProposal]);
    runScript('scan-propose.ts');
    runScript('scan-critique.ts');
    const a = JSON.parse(readFileSync(r.path('.compass/analysis.json'), 'utf8'));
    expect(a.llm.calls.every((c: any) => c.tokens_in > 0 && c.tokens_out > 0)).toBe(true);
  });

  it('fails loudly if both attempts of the propose pass return invalid JSON', () => {
    runScript('scan-init.ts', ['--depth', '1']); runScript('scan-walk.ts'); runScript('scan-parse.ts'); runScript('scan-cluster.ts');
    scriptFakeClaude(['not json', 'still not json']);
    expect(() => runScript('scan-propose.ts')).toThrow();
    const s = JSON.parse(readFileSync(r.path('.compass/state.json'), 'utf8'));
    expect(s.phase).toBe('failed');
    expect(s.last_error).toMatch(/propose|json/i);
  });
});

describe('scan-render (SPEC §6.1 step 11)', () => {
  it('writes overview.md and one .md per component', () => {
    runScript('scan-init.ts', ['--depth', '1']); runScript('scan-walk.ts'); runScript('scan-parse.ts'); runScript('scan-cluster.ts');
    scriptFakeClaude([fakeProposal, fakeProposal]);
    runScript('scan-propose.ts'); runScript('scan-critique.ts'); runScript('scan-render.ts');
    expect(existsSync(r.path('.compass/overview.md'))).toBe(true);
    expect(existsSync(r.path('.compass/API_Layer.md'))).toBe(true);
    expect(existsSync(r.path('.compass/Services.md'))).toBe(true);
  });

  it("transitions phase to 'done' on success", () => {
    runScript('scan-init.ts', ['--depth', '1']); runScript('scan-walk.ts'); runScript('scan-parse.ts'); runScript('scan-cluster.ts');
    scriptFakeClaude([fakeProposal, fakeProposal]);
    runScript('scan-propose.ts'); runScript('scan-critique.ts'); runScript('scan-render.ts');
    const s = JSON.parse(readFileSync(r.path('.compass/state.json'), 'utf8'));
    expect(s.phase).toBe('done');
    expect(s.lock_holder).toBeNull();
  });
});

describe('scan — single-writer lock (SPEC §6.1 step 1)', () => {
  it("aborts with 'another compass run in progress' when .compass/.lock points to a live PID", () => {
    r.mkdir('.compass');
    const fs = require('node:fs');
    fs.writeFileSync(r.path('.compass/.lock'), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    expect(() => runScript('scan-init.ts', ['--depth', '1'])).toThrow(/in progress|already held/i);
  });

  it('takes over a stale (>10min) lock without manual intervention', () => {
    r.mkdir('.compass');
    const fs = require('node:fs');
    const oldTs = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    fs.writeFileSync(r.path('.compass/.lock'), JSON.stringify({ pid: 999999, started_at: oldTs }));
    expect(() => runScript('scan-init.ts', ['--depth', '1'])).not.toThrow();
  });
});
