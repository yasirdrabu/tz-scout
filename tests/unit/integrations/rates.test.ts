import { describe, expect, it } from 'vitest';
import { CATEGORY_OF_PROVIDER, COST_CATEGORIES, PAUSABLE } from '@/modules/integrations/contracts/costs';
import { defaultRates, priceOf } from '@/modules/integrations/domain/rates';

const rates = (provider: string, settings: Record<string, unknown> = {}) =>
  new Map(defaultRates(provider, settings).map((r) => [r.item, r.centsPerUnit]));

describe('default rates (Ruling 1)', () => {
  it('Claude: input and output per token from the list prices', () => {
    const r = rates('anthropic');
    expect(r.get('claude-sonnet-5-5:input')).toBeCloseTo(0.0003, 10);
    expect(r.get('claude-sonnet-5-5:output')).toBeCloseTo(0.0015, 10);
    expect(r.get('claude-haiku-5-5:input')).toBeCloseTo(0.0001, 10);
    expect(r.get('claude-opus-5-5:output')).toBeCloseTo(0.0075, 10);
  });

  it('Apollo and Vibe: 10 cents a credit, or the connection setting', () => {
    expect(defaultRates('apollo', {})).toEqual([{ item: 'credit', centsPerUnit: 10 }]);
    expect(defaultRates('vibe', {})).toEqual([{ item: 'credit', centsPerUnit: 10 }]);
    expect(defaultRates('apollo', { cents_per_credit: 12 })).toEqual([{ item: 'credit', centsPerUnit: 12 }]);
    expect(defaultRates('apollo', { cents_per_credit: -1 })).toEqual([{ item: 'credit', centsPerUnit: 10 }]);
  });

  it('a provider with no money has no rates', () => {
    expect(defaultRates('hubspot', {})).toEqual([]);
    expect(defaultRates('website', {})).toEqual([]);
  });
});

describe('priceOf (Ruling 2)', () => {
  it('rounds to whole cents, half up', () => {
    const r = rates('anthropic');
    // 1,500 input tokens at $3 per million is 0.45 cents.
    expect(priceOf(r, [{ item: 'claude-sonnet-5-5:input', units: 1500 }])).toBe(0);
    expect(priceOf(r, [{ item: 'claude-sonnet-5-5:input', units: 2_000_000 }])).toBe(600);
    expect(priceOf(new Map([['credit', 0.5]]), [{ item: 'credit', units: 1 }])).toBe(1);
    expect(priceOf(new Map([['credit', 0.49]]), [{ item: 'credit', units: 1 }])).toBe(0);
  });

  it('sums the items before rounding; an item with no rate costs 0', () => {
    const r = rates('anthropic');
    expect(
      priceOf(r, [
        { item: 'claude-sonnet-5-5:input', units: 1000 },
        { item: 'claude-sonnet-5-5:output', units: 1000 },
      ]),
    ).toBe(2);
    expect(priceOf(r, [{ item: 'nope:input', units: 9_000_000 }])).toBe(0);
    expect(priceOf(rates('apollo'), [{ item: 'credit', units: 3 }])).toBe(30);
  });
});

describe('cost categories (Ruling 4)', () => {
  it('keys, labels, providers and the pausable ones', () => {
    expect(COST_CATEGORIES).toEqual([
      { key: 'partner_fees', label: 'Partner fees' },
      { key: 'data_vendors', label: 'Data vendors' },
      { key: 'agents_hosting', label: 'Agents and hosting' },
      { key: 'lists_events', label: 'Lists and events' },
      { key: 'ai_usage', label: 'AI usage' },
    ]);
    expect(CATEGORY_OF_PROVIDER).toEqual({ anthropic: 'ai_usage', apollo: 'data_vendors', vibe: 'data_vendors' });
    expect([...PAUSABLE].sort()).toEqual(['ai_usage', 'data_vendors']);
  });
});
