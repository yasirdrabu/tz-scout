import { log } from '@/platform/log';

/** Cents per million tokens. Cache reads are billed at a tenth of the input price. */
type Price = { input: number; output: number; cacheRead: number };

export const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { input: 1500, output: 7500, cacheRead: 150 },
  'claude-sonnet-5-5': { input: 300, output: 1500, cacheRead: 30 },
  'claude-haiku-5-5': { input: 100, output: 500, cacheRead: 10 },
};

export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number };

/** Cost in whole cents, rounded up. An unknown model costs 0 and logs a warning. */
export function costCents(model: string, u: Usage): number {
  const p = PRICES[model];
  if (!p) {
    log.warn({ model }, 'ai: no price for model, cost recorded as 0');
    return 0;
  }
  const raw = (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead) / 1_000_000;
  return raw <= 0 ? 0 : Math.ceil(raw - 1e-9);
}

/** Most this call could cost: the estimated input plus a full output allowance. */
export const worstCaseCents = (model: string, inputTokens: number, maxTokens: number): number =>
  PRICES[model] ? costCents(model, { inputTokens, outputTokens: maxTokens, cacheReadTokens: 0 }) : 0;
