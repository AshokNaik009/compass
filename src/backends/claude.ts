import { execSync } from 'node:child_process';
import type { Backend, OneShotOpts, OneShotResult } from './types.ts';

export class CompassTimeoutError extends Error {
  constructor(public step: string, public timeoutMs: number) {
    super(`compass step "${step}" exceeded ${timeoutMs}ms`);
    this.name = 'CompassTimeoutError';
  }
}

export class CompassBackendError extends Error {
  constructor(message: string, public stderr?: string) {
    super(message);
    this.name = 'CompassBackendError';
  }
}

const APPROX_TOKENS_PER_CHAR = 0.25; // 4 chars/token rough heuristic
const DEFAULT_TIMEOUT_MS = 60_000;

export function approxTokens(text: string): number {
  return Math.ceil(text.length * APPROX_TOKENS_PER_CHAR);
}

// Allow tests to short-circuit `claude -p` calls by exporting
// COMPASS_FAKE_CLAUDE='{...}' — the value is returned as the text.
function fakeResponse(): string | null {
  const v = process.env.COMPASS_FAKE_CLAUDE;
  return v && v.length > 0 ? v : null;
}

export class ClaudeBackend implements Backend {
  name = 'claude' as const;

  async oneShot(prompt: string, opts: OneShotOpts = {}): Promise<OneShotResult> {
    const fake = fakeResponse();
    if (fake) {
      return { text: fake, tokensIn: approxTokens(prompt), tokensOut: approxTokens(fake) };
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      const stdout = execSync('claude -p', {
        input: prompt,
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 50 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const text = stdout.toString();
      return { text, tokensIn: approxTokens(prompt), tokensOut: approxTokens(text) };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { signal?: string; stderr?: Buffer };
      if (e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT') {
        throw new CompassTimeoutError('claude-oneShot', timeoutMs);
      }
      const stderr = e.stderr ? e.stderr.toString() : undefined;
      throw new CompassBackendError(`claude -p failed: ${e.message}`, stderr);
    }
  }

  capabilities() {
    return { maxContextTokens: 200_000 };
  }
}
