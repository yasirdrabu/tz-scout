// R3a Rulings 1 and 2: the items each paid provider is priced by, their defaults from list prices, and the rounding.
import { DEFAULT_CENTS_PER_CREDIT } from '../contracts/costs';

/** Claude's list prices in cents per million tokens. Cache reads are billed at a tenth of the input price. */
export const CLAUDE_LIST_PRICES: Record<string, { input: number; output: number }> = {
  'claude-opus-5-5': { input: 1500, output: 7500 },
  'claude-sonnet-5-5': { input: 300, output: 1500 },
  'claude-haiku-5-5': { input: 100, output: 500 },
};

export type Rate = { item: string; centsPerUnit: number };
export type UsageItem = { item: string; units: number };

export const RATE_NEGATIVE = "A rate can't be negative.";
/** The most `numeric(14,6)` holds. */
export const MAX_RATE = 99_999_999;

/** The provider's items with their default cents per unit; `settings` is the connection's (`cents_per_credit`). */
export function defaultRates(provider: string, settings: Record<string, unknown>): Rate[] {
  if (provider === 'anthropic') {
    return Object.entries(CLAUDE_LIST_PRICES).flatMap(([model, p]) => [
      { item: `${model}:input`, centsPerUnit: p.input / 1_000_000 },
      { item: `${model}:output`, centsPerUnit: p.output / 1_000_000 },
    ]);
  }
  const fallback = DEFAULT_CENTS_PER_CREDIT[provider];
  if (fallback === undefined) return [];
  const set = settings.cents_per_credit;
  return [{ item: 'credit', centsPerUnit: typeof set === 'number' && Number.isFinite(set) && set >= 0 ? set : fallback }];
}

/** Whole cents, half up. An item with no rate costs 0. */
export function priceOf(rates: ReadonlyMap<string, number>, usage: readonly UsageItem[]): number {
  const raw = usage.reduce((sum, u) => sum + u.units * (rates.get(u.item) ?? 0), 0);
  // The small nudge keeps a product like 0.5 that floats down to 0.49999... rounding up.
  return raw <= 0 ? 0 : Math.floor(raw + 0.5 + 1e-9);
}
