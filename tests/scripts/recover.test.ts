/**
 * SPEC.md §6.5 — /compass-recover.
 *
 *  - phase='done' → "nothing to recover" exit
 *  - lock held by a live PID → refuse
 *  - walking | parsing | clustering → resume from the failed step (idempotent)
 *  - proposing | critiquing → re-run scan from the pre-cluster snapshot
 *  - rendering → re-run scan-render only
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
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

const mutateState = (mut: (s: any) => void) => {
  const p = r.path('.compass/state.json');
  const s = JSON.parse(readFileSync(p, 'utf8'));
  mut(s);
  writeFileSync(p, JSON.stringify(s));
};

beforeEach(() => { r = buildExpressTiny(); fakeClaudeReset(); });
afterEach(() => { r.cleanup(); fakeClaudeReset(); });

describe("recover — nothing to do (phase='done')", () => {
  it("prints 'nothing to recover' when state.phase === 'done'", () => {
    runScript('scan-init.ts', ['--depth', '1']);
    runScript('scan-walk.ts'); runScript('scan-parse.ts'); runScript('scan-cluster.ts');
    scriptFakeClaude([fakeProposal, fakeProposal]);
    runScript('scan-propose.ts'); runScript('scan-critique.ts'); runScript('scan-render.ts');
    const out = runScript('recover.ts');
    expect(out).toMatch(/nothing to recover/i);
  });
});

describe('recover — refuses when a live run holds the lock', () => {
  it('refuses to resume while .compass/.lock points to a live PID (SPEC §6.5 step 2)', () => {
    runScript('scan-init.ts', ['--depth', '1']);
    mutateState((s) => { s.phase = 'parsing'; });
    writeFileSync(r.path('.compass/.lock'), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    expect(() => runScript('recover.ts')).toThrow(/still running|in progress|live pid/i);
  });

  it('proceeds when the lock is stale (>10min) or PID is dead', () => {
    runScript('scan-init.ts', ['--depth', '1']);
    mutateState((s) => { s.phase = 'parsing'; });
    writeFileSync(r.path('.compass/.lock'), JSON.stringify({ pid: 999999, started_at: new Date(Date.now() - 11 * 60 * 1000).toISOString() }));
    scriptFakeClaude([fakeProposal, fakeProposal]);
    expect(() => runScript('recover.ts')).not.toThrow();
  });
});

describe('recover — resumes from each phase (SPEC §6.5 step 3)', () => {
  it("phase=walking → re-runs walk + everything after", () => {
    runScript('scan-init.ts', ['--depth', '1']);
    mutateState((s) => { s.phase = 'walking'; });
    scriptFakeClaude([fakeProposal, fakeProposal]);
    runScript('recover.ts');
    const s = JSON.parse(readFileSync(r.path('.compass/state.json'), 'utf8'));
    expect(s.phase).toBe('done');
  });

  it("phase=parsing → resumes from parse (deterministic and idempotent)", () => {
    runScript('scan-init.ts', ['--depth', '1']);
    runScript('scan-walk.ts');
    mutateState((s) => { s.phase = 'parsing'; }); // simulate a kill mid-parse
    scriptFakeClaude([fakeProposal, fakeProposal]);
    runScript('recover.ts');
    expect(JSON.parse(readFileSync(r.path('.compass/state.json'), 'utf8')).phase).toBe('done');
  });

  it("phase=clustering → resumes from cluster", () => {
    runScript('scan-init.ts', ['--depth', '1']);
    runScript('scan-walk.ts'); runScript('scan-parse.ts');
    mutateState((s) => { s.phase = 'clustering'; });
    scriptFakeClaude([fakeProposal, fakeProposal]);
    runScript('recover.ts');
    expect(JSON.parse(readFileSync(r.path('.compass/state.json'), 'utf8')).phase).toBe('done');
  });

  it("phase=proposing → re-runs propose + critique, reusing the pre-cluster snapshot (no re-walk)", () => {
    runScript('scan-init.ts', ['--depth', '1']);
    runScript('scan-walk.ts'); runScript('scan-parse.ts'); runScript('scan-cluster.ts');
    const beforeFiles = JSON.parse(readFileSync(r.path('.compass/state.json'), 'utf8')).files;
    mutateState((s) => { s.phase = 'proposing'; });
    scriptFakeClaude([fakeProposal, fakeProposal]);
    runScript('recover.ts');
    const afterFiles = JSON.parse(readFileSync(r.path('.compass/state.json'), 'utf8')).files;
    // file hashes preserved across recovery (no re-walk)
    expect(Object.keys(afterFiles)).toEqual(Object.keys(beforeFiles));
    for (const k of Object.keys(beforeFiles)) {
      expect(afterFiles[k].sha256).toBe(beforeFiles[k].sha256);
    }
  });

  it("phase=critiquing → re-runs critique only (one LLM call)", () => {
    runScript('scan-init.ts', ['--depth', '1']);
    runScript('scan-walk.ts'); runScript('scan-parse.ts'); runScript('scan-cluster.ts');
    scriptFakeClaude([fakeProposal]); runScript('scan-propose.ts');
    mutateState((s) => { s.phase = 'critiquing'; });
    scriptFakeClaude([fakeProposal]);
    runScript('recover.ts');
    const s = JSON.parse(readFileSync(r.path('.compass/state.json'), 'utf8'));
    expect(s.phase).toBe('done');
  });

  it("phase=rendering → re-runs scan-render only (no LLM call)", () => {
    runScript('scan-init.ts', ['--depth', '1']);
    runScript('scan-walk.ts'); runScript('scan-parse.ts'); runScript('scan-cluster.ts');
    scriptFakeClaude([fakeProposal, fakeProposal]);
    runScript('scan-propose.ts'); runScript('scan-critique.ts');
    mutateState((s) => { s.phase = 'rendering'; });
    // no fake claude needed; recover should NOT call the LLM here
    fakeClaudeReset();
    runScript('recover.ts');
    expect(existsSync(r.path('.compass/overview.md'))).toBe(true);
  });

  it("phase=failed → re-tries the failed step (last_error cleared on success)", () => {
    runScript('scan-init.ts', ['--depth', '1']);
    runScript('scan-walk.ts');
    mutateState((s) => { s.phase = 'failed'; s.last_error = 'parse exploded'; });
    scriptFakeClaude([fakeProposal, fakeProposal]);
    runScript('recover.ts');
    const s = JSON.parse(readFileSync(r.path('.compass/state.json'), 'utf8'));
    expect(s.phase).toBe('done');
    expect(s.last_error).toBeNull();
  });
});

describe('recover — does not change the cluster seed (Open Q4)', () => {
  it('uses the same louvain_seed from the previous run (stable clusters across recovery)', () => {
    runScript('scan-init.ts', ['--depth', '1']);
    const seedBefore = JSON.parse(readFileSync(r.path('.compass/state.json'), 'utf8')).pins.louvain_seed;
    mutateState((s) => { s.phase = 'walking'; });
    scriptFakeClaude([fakeProposal, fakeProposal]);
    runScript('recover.ts');
    const seedAfter = JSON.parse(readFileSync(r.path('.compass/state.json'), 'utf8')).pins.louvain_seed;
    expect(seedAfter).toBe(seedBefore);
  });
});

describe('recover — duration accounting (cost line, §3.4)', () => {
  it("prints a 'recovered to phase=done in Ms' line including cost", () => {
    runScript('scan-init.ts', ['--depth', '1']);
    runScript('scan-walk.ts'); runScript('scan-parse.ts'); runScript('scan-cluster.ts');
    mutateState((s) => { s.phase = 'proposing'; });
    scriptFakeClaude([fakeProposal, fakeProposal]);
    const out = runScript('recover.ts');
    expect(out).toMatch(/recovered.*phase=done/i);
    expect(out).toMatch(/tokens?_in.*tokens?_out|cost/i);
  });
});
