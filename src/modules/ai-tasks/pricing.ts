import { defaultRates, getRates, priceOf } from '@/modules/integrations';
import type { ModuleContext } from '@/platform/context';
import { log } from '@/platform/log';

export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number };

export type ClaudePrices = {
  /** Cost in whole cents, rounded half up (R3a Ruling 2). Cache reads are billed at a tenth of the input price. */
  cost: (u: Usage) => number;
  /** Most a call could cost: the estimated input plus a full output allowance. Rounded up, as it is held against limits. */
  worstCase: (inputTokens: number, maxTokens: number) => number;
};

/**
 * The tenant's Claude rates for `model` (R3a Ruling 1), read once before a call: pricing after it must not need the
 * caller's transaction, which a timed-out job has already lost. An unknown model costs 0. A mock run uses the list
 * prices (it only needs a worst case to hold against the limit), so it reads nothing and warns about nothing.
 */
export async function claudePrices(ctx: ModuleContext, model: string, mode: 'live' | 'mock'): Promise<ClaudePrices> {
  const list = mode === 'mock' ? defaultRates('anthropic', {}) : await getRates(ctx, 'anthropic');
  const rates = new Map(list.map((r) => [r.item, r.centsPerUnit]));
  const input = `${model}:input`;
  const output = `${model}:output`;
  if (mode === 'live' && !rates.has(input)) log.warn({ model }, 'ai: no price for model, cost recorded as 0');
  return {
    cost: (u) =>
      priceOf(rates, [
        { item: input, units: u.inputTokens + u.cacheReadTokens / 10 },
        { item: output, units: u.outputTokens },
      ]),
    worstCase: (inputTokens, maxTokens) => {
      const raw = inputTokens * (rates.get(input) ?? 0) + maxTokens * (rates.get(output) ?? 0);
      return raw <= 0 ? 0 : Math.ceil(raw - 1e-9);
    },
  };
}
