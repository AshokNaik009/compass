/**
 * SPEC.md §3.4 — operational contract for the `claude -p` shell-out.
 *  - 60s timeout → CompassTimeoutError
 *  - 80k token cap → drop lowest-weight inter-cluster edges, log to state.stats
 *  - JSON-mode: prompt ends with schema, instruction to return only JSON
 *  - one retry on parse failure with stricter prompt; then fail loudly
 *  - per-call token counts recorded
 *  - cost summary printed by the skill (caller responsibility, not tested here)
 *  - COMPASS_FAKE_CLAUDE bypass for tests
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { claudeJson, CompassTimeoutError, CompassLLMError } from '../../../src/lib/claude.js';
import { fakeClaudeReset, setFakeClaude, scriptFakeClaude, fakeClaudeMalformed, fakeClaudeTimeout } from '../../helpers/fakeClaude.js';

beforeEach(() => fakeClaudeReset());
afterEach(() => fakeClaudeReset());

const tinySchema = z.object({ components: z.array(z.string()) });

describe('claudeJson — happy path via COMPASS_FAKE_CLAUDE', () => {
  it('returns the parsed JSON when the fake response matches the schema', async () => {
    setFakeClaude({ components: ['C1', 'C2'] });
    const r = await claudeJson({ prompt: 'cluster these...', schema: tinySchema });
    expect(r.data.components).toEqual(['C1', 'C2']);
  });

  it('records tokens_in and tokens_out (per §3.4)', async () => {
    setFakeClaude({ components: ['C1'] });
    const r = await claudeJson({ prompt: 'tiny prompt', schema: tinySchema });
    expect(r.tokensIn).toBeGreaterThan(0);
    expect(r.tokensOut).toBeGreaterThan(0);
  });

  it('records duration_ms (used by analysis.llm.calls[].duration_ms)', async () => {
    setFakeClaude({ components: ['C1'] });
    const r = await claudeJson({ prompt: 'x', schema: tinySchema });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('claudeJson — JSON-mode contract (§3.4)', () => {
  it('appends a JSON schema instruction at prompt tail (verifiable via inspected prompt)', async () => {
    setFakeClaude({ components: ['C1'] });
    const r = await claudeJson({ prompt: 'tell me clusters', schema: tinySchema });
    // the wrapper exposes the rendered prompt for tests + telemetry
    expect(r.renderedPrompt).toMatch(/return only valid JSON/i);
    expect(r.renderedPrompt).toMatch(/components/);
  });

  it("trims surrounding prose around a JSON blob (handles 'Here is the JSON:\\n{...}')", async () => {
    setFakeClaude(`Here is the JSON you asked for:\n\n{"components":["C1","C2"]}\n\nLet me know if you need anything else.`);
    const r = await claudeJson({ prompt: 'x', schema: tinySchema });
    expect(r.data.components).toEqual(['C1', 'C2']);
  });

  it('handles fenced code blocks (```json {...} ```)', async () => {
    setFakeClaude('```json\n{"components":["C1"]}\n```');
    const r = await claudeJson({ prompt: 'x', schema: tinySchema });
    expect(r.data.components).toEqual(['C1']);
  });
});

describe('claudeJson — retry-once-then-fail (§3.4)', () => {
  it('retries with a stricter prompt on JSON parse failure, then succeeds', async () => {
    scriptFakeClaude([
      '{ this is not json',                // attempt 1 fails
      { components: ['C1'] },              // attempt 2 succeeds
    ]);
    const r = await claudeJson({ prompt: 'x', schema: tinySchema });
    expect(r.data.components).toEqual(['C1']);
    expect(r.retried).toBe(true);
  });

  it('includes the failed response and the zod error in the retry prompt', async () => {
    scriptFakeClaude([
      'totally not json',
      { components: ['C1'] },
    ]);
    const r = await claudeJson({ prompt: 'x', schema: tinySchema });
    expect(r.retryPromptUsed).toContain('totally not json');
    expect(r.retryPromptUsed).toMatch(/zod|invalid|expected/i);
  });

  it('retries on a schema-validation failure (parses as JSON but wrong shape)', async () => {
    scriptFakeClaude([
      { unexpected: true },                // valid JSON, invalid shape
      { components: ['C1'] },
    ]);
    const r = await claudeJson({ prompt: 'x', schema: tinySchema });
    expect(r.data.components).toEqual(['C1']);
  });

  it('throws CompassLLMError after the single retry also fails', async () => {
    scriptFakeClaude([
      'garbage one',
      'garbage two',
    ]);
    await expect(claudeJson({ prompt: 'x', schema: tinySchema })).rejects.toBeInstanceOf(CompassLLMError);
  });

  it('does NOT retry indefinitely (exactly one retry, total <= 2 attempts)', async () => {
    scriptFakeClaude([
      'garbage', 'garbage', 'garbage', { components: ['C1'] },
    ]);
    await expect(claudeJson({ prompt: 'x', schema: tinySchema })).rejects.toBeInstanceOf(CompassLLMError);
  });
});

describe('claudeJson — timeout (§3.4)', () => {
  it('throws CompassTimeoutError when the fake driver simulates a hung process', async () => {
    fakeClaudeTimeout();
    await expect(claudeJson({ prompt: 'x', schema: tinySchema, timeoutMs: 50 })).rejects.toBeInstanceOf(CompassTimeoutError);
  });

  it('default timeout is 60s when not specified (pin contract)', async () => {
    // verify via the resolved options exposed for testing
    setFakeClaude({ components: ['C1'] });
    const r = await claudeJson({ prompt: 'x', schema: tinySchema });
    expect(r.timeoutMsUsed).toBe(60_000);
  });

  it('CompassTimeoutError includes which step (phase) timed out, so /compass-recover can resume cleanly', async () => {
    fakeClaudeTimeout();
    await expect(
      claudeJson({ prompt: 'x', schema: tinySchema, timeoutMs: 10, phase: 'critique' })
    ).rejects.toThrow(/critique/);
  });
});

describe('claudeJson — input token cap (§3.4: 80k chars, drop lowest-weight edges first)', () => {
  it('passes prompts under the cap through unchanged', async () => {
    setFakeClaude({ components: ['C1'] });
    const small = 'tiny prompt';
    const r = await claudeJson({ prompt: small, schema: tinySchema });
    expect(r.renderedPrompt).toContain(small);
  });

  it('truncates the structured edges section by dropping the lowest-weight edges first', async () => {
    setFakeClaude({ components: ['C1'] });
    // structured prompt: caller passes edges separately so the wrapper can prune
    const edges = Array.from({ length: 1000 }, (_, i) => ({ from: 'A', to: 'B', weight: i + 1 }));
    const r = await claudeJson({
      prompt: 'long prompt with structured payload',
      structuredPayload: { edges },
      schema: tinySchema,
    });
    // dropped edges are reported to the caller for stats
    expect(r.droppedEdges).toBeGreaterThan(0);
    expect(r.renderedPrompt.length).toBeLessThan(80_000 * 4); // rough char heuristic
  });

  it('keeps the highest-weight edges in priority order', async () => {
    setFakeClaude({ components: ['C1'] });
    const edges = [
      { from: 'A', to: 'B', weight: 1 },
      { from: 'C', to: 'D', weight: 999 },
      { from: 'E', to: 'F', weight: 500 },
    ];
    const r = await claudeJson({
      prompt: 'pad',
      structuredPayload: { edges },
      schema: tinySchema,
      forceCapForTest: 100, // hint: tiny cap to force pruning
    });
    // highest weight must survive; lowest must be dropped first
    expect(r.renderedPrompt).toContain('999');
    expect(r.renderedPrompt).not.toContain('weight":1,');
  });
});

describe('claudeJson — process plumbing', () => {
  it('does NOT spawn an actual process when COMPASS_FAKE_CLAUDE is set (no real claude binary in CI)', async () => {
    setFakeClaude({ components: ['C1'] });
    // resolved via env shortcut — no execSync call
    const r = await claudeJson({ prompt: 'x', schema: tinySchema });
    expect(r.usedFakeDriver).toBe(true);
  });

  it('surfaces a clear error when the claude binary is missing and no fake driver is set', async () => {
    // explicit env override that forces the wrapper to attempt the real binary
    process.env.COMPASS_FORCE_REAL_CLAUDE = '1';
    process.env.PATH = ''; // can't find binary
    await expect(claudeJson({ prompt: 'x', schema: tinySchema })).rejects.toThrow(/claude.*not found|ENOENT/i);
    delete process.env.COMPASS_FORCE_REAL_CLAUDE;
  });

  it('quote-escapes the prompt when shelling out (no injection via prompt content)', async () => {
    // contract test — implementation passes prompt via stdin or argv with proper escaping
    setFakeClaude({ components: ['C1'] });
    const malicious = `"; rm -rf / #`;
    const r = await claudeJson({ prompt: malicious, schema: tinySchema });
    expect(r.data.components).toEqual(['C1']);
    expect(r.renderedPrompt).toContain('rm -rf /');
  });
});

describe('claudeJson — empty / boundary inputs', () => {
  it('rejects empty prompts (every call must say something)', async () => {
    await expect(claudeJson({ prompt: '', schema: tinySchema })).rejects.toThrow(/empty/i);
  });

  it('handles a fake response that is the empty string (parser failure → retry → fail)', async () => {
    scriptFakeClaude(['', '']);
    await expect(claudeJson({ prompt: 'x', schema: tinySchema })).rejects.toBeInstanceOf(CompassLLMError);
  });

  it('handles a fake response that is just whitespace (parser failure)', async () => {
    scriptFakeClaude(['   \n  \t  ', '   ']);
    await expect(claudeJson({ prompt: 'x', schema: tinySchema })).rejects.toBeInstanceOf(CompassLLMError);
  });
});
