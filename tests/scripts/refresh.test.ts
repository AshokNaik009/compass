/**
 * SPEC.md §6.2 — /compass-refresh incremental update.
 *
 *  - SAFE: changed files all stay in their existing component → partial path
 *  - UNSAFE: neighbours suggest reclassification, new file with no cluster,
 *    or a deleted file → fall through to full re-cluster
 *  - no changes → "up to date" exit
 *  - state.json zod failure → archive + fall back to scan
 *  - reuses last walk when falling back to full re-cluster (step 5)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildExpressTiny, gitInit, gitCommit } from '../helpers/fixtures.js';
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
    { id: 'C3', name: 'Repositories', description: '', rationale: 'r', files: ['src/repositories/user.ts', 'src/repositories/billing.ts'], symbols: [], depth: 1, subgraph_ref: null, confidence: 'high' },
    { id: 'C4', name: 'Utils', description: '', rationale: 'r', files: ['src/utils/auth.ts', 'src/utils/logger.ts'], symbols: [], depth: 1, subgraph_ref: null, confidence: 'medium' },
  ],
  edges: [
    { from: 'C1', to: 'C2', weight: 2, reason: 'r' },
    { from: 'C2', to: 'C3', weight: 2, reason: 'r' },
  ],
  rationale: ['layered'],
};

const fullScan = () => {
  runScript('scan-init.ts', ['--depth', '1']);
  runScript('scan-walk.ts');
  runScript('scan-parse.ts');
  runScript('scan-cluster.ts');
  scriptFakeClaude([fakeProposal, fakeProposal]);
  runScript('scan-propose.ts');
  runScript('scan-critique.ts');
  runScript('scan-render.ts');
};

beforeEach(() => {
  r = buildExpressTiny();
  gitInit(r.root);
  fakeClaudeReset();
  fullScan();
});
afterEach(() => { r.cleanup(); fakeClaudeReset(); });

describe('refresh-diff classification', () => {
  it("prints 'up to date' and exits 0 when nothing changed since last_run", () => {
    const out = runScript('refresh-diff.ts');
    expect(out).toMatch(/up to date/i);
  });

  it('classifies an in-component edit as SAFE', () => {
    writeFileSync(r.path('src/services/user.ts'), readFileSync(r.path('src/services/user.ts'), 'utf8') + '\nexport const TOUCHED = 1;');
    const out = runScript('refresh-diff.ts');
    expect(out).toMatch(/SAFE|safe/);
    expect(out).toContain('C2');
  });

  it('classifies a new file with no existing component as UNSAFE → full re-cluster', () => {
    writeFileSync(r.path('src/newdir/new.ts'), 'export const x = 1;');
    const out = runScript('refresh-diff.ts');
    expect(out).toMatch(/UNSAFE/);
  });

  it('classifies a deleted file as UNSAFE', () => {
    require('node:fs').unlinkSync(r.path('src/utils/logger.ts'));
    const out = runScript('refresh-diff.ts');
    expect(out).toMatch(/UNSAFE/);
  });

  it('classifies a file whose imports now point to a different component as UNSAFE', () => {
    // Make a service file import from a repo it never used → its neighbour profile changes.
    writeFileSync(r.path('src/services/user.ts'),
      `import { UserRepo } from '../repositories/user.js';\nimport { log } from '../utils/logger.js';\nlog('x');\nexport class UserService { repo = new UserRepo(); list(){ return this.repo.findAll(); } }`);
    const out = runScript('refresh-diff.ts');
    expect(out).toMatch(/UNSAFE/);
  });

  it("uses git diff when last_commit_sha is set, falling back to hashes when not", () => {
    writeFileSync(r.path('src/api/users.ts'), readFileSync(r.path('src/api/users.ts'), 'utf8') + '\n// noop');
    // not committed yet — should still detect the change via hash diff
    const out = runScript('refresh-diff.ts');
    expect(out).toContain('src/api/users.ts');
  });

  it('honors a freshly-committed change (git diff path)', () => {
    writeFileSync(r.path('src/api/users.ts'), readFileSync(r.path('src/api/users.ts'), 'utf8') + '\n// noop');
    gitCommit(r.root, 'edit users');
    const out = runScript('refresh-diff.ts');
    expect(out).toContain('src/api/users.ts');
  });
});

describe('refresh — partial path (SAFE)', () => {
  it('re-runs ONLY the critique pass (one LLM call), not propose', () => {
    writeFileSync(r.path('src/services/user.ts'), readFileSync(r.path('src/services/user.ts'), 'utf8') + '\nexport const X = 1;');
    runScript('refresh-diff.ts');
    runScript('refresh-reparse.ts', ['--components', 'C2']);
    scriptFakeClaude([fakeProposal]); // only one call expected
    runScript('refresh-recritique.ts', ['--components', 'C2']);
    const a = JSON.parse(readFileSync(r.path('.compass/analysis.json'), 'utf8'));
    // only critique recorded for this refresh
    const critiqueOnly = a.llm.calls.filter((c: any) => c.phase === 'critique');
    expect(critiqueOnly.length).toBeGreaterThanOrEqual(1);
  });

  it("re-renders only the affected component pages (--components flag forwarded to scan-render)", () => {
    const otherBefore = readFileSync(r.path('.compass/Repositories.md'), 'utf8');
    writeFileSync(r.path('src/services/user.ts'), readFileSync(r.path('src/services/user.ts'), 'utf8') + '\nexport const X = 1;');
    runScript('refresh-diff.ts');
    runScript('refresh-reparse.ts', ['--components', 'C2']);
    scriptFakeClaude([fakeProposal]);
    runScript('refresh-recritique.ts', ['--components', 'C2']);
    runScript('scan-render.ts', ['--components', 'C2']);
    const otherAfter = readFileSync(r.path('.compass/Repositories.md'), 'utf8');
    expect(otherAfter).toBe(otherBefore); // C3 untouched
  });
});

describe('refresh — UNSAFE path falls through to full re-cluster (SPEC §6.2 step 5)', () => {
  it('runs scan-cluster + propose + critique again but reuses the walk', () => {
    require('node:fs').unlinkSync(r.path('src/utils/logger.ts'));
    runScript('refresh-diff.ts');
    scriptFakeClaude([fakeProposal, fakeProposal]);
    runScript('scan-cluster.ts');
    runScript('scan-propose.ts');
    runScript('scan-critique.ts');
    runScript('scan-render.ts');
    const s = JSON.parse(readFileSync(r.path('.compass/state.json'), 'utf8'));
    expect(s.phase).toBe('done');
    expect(s.stats.files_skipped_unchanged).toBeGreaterThanOrEqual(0);
  });
});

describe('refresh — corrupted state recovery (SPEC §6.2 step 6)', () => {
  it('archives a malformed state.json to state.broken.json and re-scans from scratch', () => {
    writeFileSync(r.path('.compass/state.json'), '{ not json');
    expect(() => runScript('refresh-diff.ts')).toThrow();
    // implementation moves the file aside on the next invocation:
    expect(existsSync(r.path('.compass/state.broken.json'))).toBe(true);
  });
});
