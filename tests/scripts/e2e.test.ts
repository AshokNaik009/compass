/**
 * End-to-end smoke against the express-tiny fixture.
 *
 * Pins the user-visible contracts the skill is responsible for:
 *  - cost summary line at end of every command (§3.4)
 *  - --depth >= 2 confirmation prompt with predicted call count (§6.1 step 7)
 *  - components_post_llm <= 12 (Open Q5)
 *  - state.json + analysis.json + overview.md all present after /compass-scan
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
  edges: [
    { from: 'C1', to: 'C2', weight: 2, reason: 'r' },
    { from: 'C2', to: 'C3', weight: 2, reason: 'r' },
    { from: 'C1', to: 'C4', weight: 1, reason: 'r' },
  ],
  rationale: ['layered MERN'],
};

beforeEach(() => { r = buildExpressTiny(); fakeClaudeReset(); });
afterEach(() => { r.cleanup(); fakeClaudeReset(); });

describe('end-to-end /compass-scan on express-tiny', () => {
  it('produces the expected file set', () => {
    runScript('scan-init.ts', ['--depth', '1']);
    runScript('scan-walk.ts');
    runScript('scan-parse.ts');
    runScript('scan-cluster.ts');
    scriptFakeClaude([fakeProposal, fakeProposal]);
    runScript('scan-propose.ts');
    runScript('scan-critique.ts');
    const out = runScript('scan-render.ts');

    for (const f of [
      '.compass/state.json',
      '.compass/analysis.json',
      '.compass/overview.md',
      '.compass/API.md',
      '.compass/Services.md',
      '.compass/Repos.md',
      '.compass/Utils.md',
    ]) {
      expect(existsSync(r.path(f))).toBe(true);
    }

    // cost summary line (SPEC §3.4)
    expect(out).toMatch(/tokens?_in/i);
    expect(out).toMatch(/tokens?_out/i);
  });

  it('keeps components_post_llm <= 12 (SPEC Open Q5)', () => {
    runScript('scan-init.ts', ['--depth', '1']);
    runScript('scan-walk.ts');
    runScript('scan-parse.ts');
    runScript('scan-cluster.ts');
    scriptFakeClaude([fakeProposal, fakeProposal]);
    runScript('scan-propose.ts');
    runScript('scan-critique.ts');
    runScript('scan-render.ts');
    const s = JSON.parse(readFileSync(r.path('.compass/state.json'), 'utf8'));
    expect(s.stats.components_post_llm).toBeLessThanOrEqual(12);
  });

  it("prompts for confirmation at depth=2 with a predicted call count (SPEC §6.1 step 7)", () => {
    // The script writes the expected-cost line to stdout and reads stdin for y/N.
    // In test mode, COMPASS_AUTO_CONFIRM=1 short-circuits to "yes" so the test can
    // assert the prompt appeared.
    process.env.COMPASS_AUTO_CONFIRM = '1';
    try {
      runScript('scan-init.ts', ['--depth', '2']);
      runScript('scan-walk.ts');
      runScript('scan-parse.ts');
      runScript('scan-cluster.ts');
      const out = runScript('scan-confirm-cost.ts'); // helper script that emits the prompt
      expect(out).toMatch(/LLM call|expected|Continue/i);
      expect(out).toMatch(/\d+\s*calls?/i);
    } finally {
      delete process.env.COMPASS_AUTO_CONFIRM;
    }
  });

  it('emits two LLM calls (propose + critique) and records them in analysis.llm.calls', () => {
    runScript('scan-init.ts', ['--depth', '1']);
    runScript('scan-walk.ts'); runScript('scan-parse.ts'); runScript('scan-cluster.ts');
    scriptFakeClaude([fakeProposal, fakeProposal]);
    runScript('scan-propose.ts');
    runScript('scan-critique.ts');
    runScript('scan-render.ts');
    const a = JSON.parse(readFileSync(r.path('.compass/analysis.json'), 'utf8'));
    expect(a.llm.calls).toHaveLength(2);
    expect(a.llm.calls.map((c: any) => c.phase)).toEqual(['propose', 'critique']);
  });
});
