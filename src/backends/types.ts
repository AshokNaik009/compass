export interface OneShotOpts {
  json?: boolean;
  timeoutMs?: number;
}

export interface OneShotResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

export interface Backend {
  name: 'claude' | 'codex' | 'openai' | string;
  oneShot(prompt: string, opts?: OneShotOpts): Promise<OneShotResult>;
  capabilities(): { maxContextTokens: number };
}
