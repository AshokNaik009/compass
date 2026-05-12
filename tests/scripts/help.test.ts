/**
 * SPEC.md §6.6 — /compass-help prints commands + a README link.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const scriptsDir = join(__dirname, '..', '..', 'scripts');
const runScript = () => execFileSync('npx', ['tsx', join(scriptsDir, 'help.ts')], { encoding: 'utf8' });

describe('help', () => {
  it('lists every command from §7.1 with a one-liner', () => {
    const out = runScript();
    for (const cmd of ['compass-scan', 'compass-refresh', 'compass-expand', 'compass-status', 'compass-recover', 'compass-help']) {
      expect(out).toContain(cmd);
    }
  });

  it('includes the README link', () => {
    const out = runScript();
    expect(out).toMatch(/README|github\.com\/.+\/compass/);
  });

  it('does not invoke claude -p (no LLM calls)', () => {
    const out = runScript();
    expect(out).not.toMatch(/tokens?_in|tokens?_out/i);
  });
});
