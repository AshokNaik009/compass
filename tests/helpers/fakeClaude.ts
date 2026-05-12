/**
 * Helpers for controlling the `claude -p` boundary in tests.
 *
 * The implementation reads COMPASS_FAKE_CLAUDE (per SPEC.md §11) and short-circuits
 * the shell-out. These helpers set/clear/script the env var so tests stay deterministic.
 */

const ENV = 'COMPASS_FAKE_CLAUDE';

export function setFakeClaude(payload: unknown): void {
  process.env[ENV] = typeof payload === 'string' ? payload : JSON.stringify(payload);
}

export function clearFakeClaude(): void {
  delete process.env[ENV];
}

/**
 * Queue a deterministic sequence of fake responses. The scripts call `claude -p`
 * twice (propose then critique); some scripts call it once. The fake driver pops
 * from the queue with each invocation.
 */
export function scriptFakeClaude(responses: unknown[]): void {
  process.env[`${ENV}_QUEUE`] = JSON.stringify(responses.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))));
  process.env[`${ENV}_QUEUE_INDEX`] = '0';
}

export function fakeClaudeMalformed(): void {
  process.env[ENV] = '{ this is not json';
}

export function fakeClaudeTimeout(): void {
  process.env[`${ENV}_MODE`] = 'timeout';
}

export function fakeClaudeReset(): void {
  for (const k of [ENV, `${ENV}_QUEUE`, `${ENV}_QUEUE_INDEX`, `${ENV}_MODE`]) {
    delete process.env[k];
  }
}
