import { spawnSync } from 'node:child_process';
import type { z } from 'zod';

export class CompassTimeoutError extends Error {
  constructor(public phase: string, public timeoutMs: number) {
    super(`compass step "${phase}" exceeded ${timeoutMs}ms`);
    this.name = 'CompassTimeoutError';
  }
}

export class CompassLLMError extends Error {
  constructor(message: string, public attempts: number, public lastResponse?: string) {
    super(message);
    this.name = 'CompassLLMError';
  }
}

export interface ClaudeJsonInput<T> {
  prompt: string;
  schema: z.ZodType<T>;
  timeoutMs?: number;
  phase?: string;
  structuredPayload?: { edges?: Array<{ from: string; to: string; weight: number; [k: string]: unknown }>; [k: string]: unknown };
  forceCapForTest?: number;
}

export interface ClaudeJsonResult<T> {
  data: T;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  renderedPrompt: string;
  retried: boolean;
  retryPromptUsed: string;
  timeoutMsUsed: number;
  droppedEdges: number;
  usedFakeDriver: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_TOKEN_CAP = 80_000;
const APPROX_CHARS_PER_TOKEN = 4;

function approxTokens(s: string): number {
  return Math.max(1, Math.ceil(s.length / APPROX_CHARS_PER_TOKEN));
}

interface FakeOutcome {
  text: string;
  timedOut: boolean;
}

function pickFakeResponse(): FakeOutcome | null {
  if (process.env.COMPASS_FORCE_REAL_CLAUDE === '1') return null;
  if (process.env.COMPASS_FAKE_CLAUDE_MODE === 'timeout') {
    return { text: '', timedOut: true };
  }
  const queue = process.env.COMPASS_FAKE_CLAUDE_QUEUE;
  if (queue) {
    const idxStr = process.env.COMPASS_FAKE_CLAUDE_QUEUE_INDEX ?? '0';
    let idx = parseInt(idxStr, 10);
    if (!Number.isFinite(idx) || idx < 0) idx = 0;
    let arr: string[];
    try {
      arr = JSON.parse(queue) as string[];
    } catch {
      return null;
    }
    const text = arr[idx] ?? arr[arr.length - 1] ?? '';
    process.env.COMPASS_FAKE_CLAUDE_QUEUE_INDEX = String(idx + 1);
    return { text, timedOut: false };
  }
  const single = process.env.COMPASS_FAKE_CLAUDE;
  if (single !== undefined) {
    return { text: single, timedOut: false };
  }
  return null;
}

function extractJson(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Fenced code block
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    return fence[1].trim();
  }

  // Find first `{` or `[` and matching close — handles "Here is the JSON: {...}".
  for (const opener of ['{', '[']) {
    const start = trimmed.indexOf(opener);
    if (start === -1) continue;
    const closer = opener === '{' ? '}' : ']';
    let depth = 0;
    let inStr: string | null = null;
    let escape = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (inStr) {
        if (escape) escape = false;
        else if (ch === '\\') escape = true;
        else if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inStr = ch;
        continue;
      }
      if (ch === opener) depth += 1;
      else if (ch === closer) {
        depth -= 1;
        if (depth === 0) return trimmed.slice(start, i + 1);
      }
    }
  }
  // As a last resort, return the trimmed input — JSON.parse will throw clearly.
  return trimmed;
}

function describeSchema(schema: unknown): string {
  // Best-effort: walk a zod object schema's shape to surface field names.
  const s = schema as { _def?: { typeName?: string; shape?: () => Record<string, unknown> } };
  try {
    const tn = s?._def?.typeName;
    if (tn === 'ZodObject' && s._def?.shape) {
      const shape = s._def.shape();
      const fields = Object.keys(shape);
      return `Expected fields: ${fields.join(', ')}.`;
    }
  } catch {
    // ignore
  }
  return '';
}

function buildJsonModeTail(schema?: unknown): string {
  const fields = schema ? describeSchema(schema) : '';
  return [
    '',
    '---',
    '',
    'Return ONLY valid JSON. No prose, no fences, no comments.',
    'The response must be a single JSON object that conforms to the schema you were given.',
    fields,
  ]
    .filter((l) => l.length > 0 || l === '')
    .join('\n');
}

const HARD_EDGE_LIMIT = 200; // cap before token-budget pruning; keeps prompts tractable

function pruneByTokenCap(input: ClaudeJsonInput<unknown>, cap: number, schema: unknown): { rendered: string; dropped: number } {
  const tail = buildJsonModeTail(schema);
  const headerWithPayload = (edges: Array<{ from: string; to: string; weight: number; [k: string]: unknown }>) => {
    const obj = { ...input.structuredPayload, edges };
    return `${input.prompt}\n\n--- structured payload (JSON) ---\n${JSON.stringify(obj)}${tail}`;
  };
  if (!input.structuredPayload?.edges) {
    return { rendered: `${input.prompt}${tail}`, dropped: 0 };
  }
  // Always sort high → low so the lowest-weight edges are the first to fall.
  let edges = [...input.structuredPayload.edges].sort((a, b) => b.weight - a.weight);
  let dropped = 0;
  if (edges.length > HARD_EDGE_LIMIT) {
    dropped += edges.length - HARD_EDGE_LIMIT;
    edges = edges.slice(0, HARD_EDGE_LIMIT);
  }
  let rendered = headerWithPayload(edges);
  const charCap = cap * APPROX_CHARS_PER_TOKEN;
  while (rendered.length > charCap && edges.length > 1) {
    edges = edges.slice(0, -1);
    dropped += 1;
    rendered = headerWithPayload(edges);
  }
  return { rendered, dropped };
}

function runReal(prompt: string, timeoutMs: number, phase: string): { text: string; timedOut: boolean; missing: boolean; stderr: string } {
  const result = spawnSync('claude', ['-p'], {
    input: prompt,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
    return { text: '', timedOut: false, missing: true, stderr: '' };
  }
  if (result.signal === 'SIGTERM' || (result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT')) {
    return { text: '', timedOut: true, missing: false, stderr: result.stderr ?? '' };
  }
  if (result.status !== 0) {
    return { text: '', timedOut: false, missing: false, stderr: result.stderr ?? `exit ${result.status}` };
  }
  return { text: result.stdout ?? '', timedOut: false, missing: false, stderr: '' };
}

export async function claudeJson<T>(input: ClaudeJsonInput<T>): Promise<ClaudeJsonResult<T>> {
  if (!input.prompt || input.prompt.trim().length === 0) {
    throw new Error('claudeJson: empty prompt — every call must say something');
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const phase = input.phase ?? 'claude-oneshot';
  const cap = input.forceCapForTest ?? DEFAULT_TOKEN_CAP;
  const pruned = pruneByTokenCap(input, cap, input.schema);

  const baseRendered = pruned.rendered;
  let renderedPrompt = baseRendered;
  let retryPromptUsed = '';
  let retried = false;
  let attempt = 0;
  let lastResponse = '';
  const start = Date.now();
  let tokensIn = 0;
  let tokensOut = 0;
  let usedFakeDriver = false;

  while (attempt < 2) {
    attempt += 1;
    const promptThisAttempt = attempt === 1 ? baseRendered : renderedPrompt;
    tokensIn = approxTokens(promptThisAttempt);

    const fake = pickFakeResponse();
    let text = '';
    let timedOut = false;

    if (fake) {
      usedFakeDriver = true;
      if (fake.timedOut) {
        throw new CompassTimeoutError(phase, timeoutMs);
      }
      text = fake.text;
    } else {
      const real = runReal(promptThisAttempt, timeoutMs, phase);
      if (real.missing) {
        throw new Error(`claude binary not found on PATH (ENOENT)`);
      }
      if (real.timedOut) {
        throw new CompassTimeoutError(phase, timeoutMs);
      }
      if (real.stderr && !real.text) {
        throw new Error(`claude -p failed: ${real.stderr}`);
      }
      text = real.text;
      timedOut = false;
    }

    lastResponse = text;
    tokensOut = approxTokens(text);

    // Try parse + validate
    let parsed: unknown;
    let parseErr: Error | null = null;
    try {
      const blob = extractJson(text);
      if (!blob || !blob.trim()) throw new Error('empty response from claude');
      parsed = JSON.parse(blob);
    } catch (e) {
      parseErr = e as Error;
    }
    let schemaErr: { message: string } | null = null;
    if (!parseErr) {
      const result = input.schema.safeParse(parsed);
      if (result.success) {
        return {
          data: result.data,
          tokensIn,
          tokensOut,
          durationMs: Math.max(0, Date.now() - start),
          renderedPrompt: promptThisAttempt,
          retried,
          retryPromptUsed,
          timeoutMsUsed: timeoutMs,
          droppedEdges: pruned.dropped,
          usedFakeDriver,
        };
      }
      schemaErr = { message: result.error.message };
    }

    if (attempt < 2) {
      retried = true;
      const errMsg = parseErr ? parseErr.message : schemaErr!.message;
      retryPromptUsed = [
        baseRendered,
        '',
        '--- prior attempt failed validation ---',
        `Previous response (invalid):`,
        text,
        '',
        `Zod error / parse error: ${errMsg}`,
        '',
        'Return ONLY valid JSON matching the schema. No prose, no markdown fences.',
      ].join('\n');
      renderedPrompt = retryPromptUsed;
      continue;
    }
    throw new CompassLLMError(
      `claudeJson: ${parseErr ? 'JSON parse failed' : 'schema validation failed'} after 2 attempts: ${parseErr ? parseErr.message : schemaErr!.message}`,
      attempt,
      lastResponse,
    );
  }

  // unreachable
  throw new CompassLLMError('claudeJson: unexpected loop exit', attempt, lastResponse);
}
