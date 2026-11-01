import { describe, expect, it } from 'vitest';
import { offerStatusLabel, priceLabel } from '@/modules/offers/domain/price';

const none = { priceModel: null, priceMinCents: null, priceMaxCents: null, lengthWeeks: null };

describe('priceLabel (Ruling 13)', () => {
  it.each([
    [{ priceModel: 'fixed', lengthWeeks: 6 }, 'Fixed fee · 6 weeks'],
    [{ priceModel: 'fixed', priceMinCents: 4_000_000, priceMaxCents: 4_000_000, lengthWeeks: 6 }, 'Fixed fee · $40,000 · 6 weeks'],
    [{ priceModel: 'fixed', lengthWeeks: 1 }, 'Fixed fee · 1 week'],
    [{ priceModel: 'starting_at', priceMinCents: 4_000_000, priceMaxCents: 4_000_000 }, 'Starting at $40,000'],
    [{ priceModel: 'per_month', priceMinCents: 800_000, priceMaxCents: 800_000 }, '$8,000 per month'],
    [{ priceModel: 'per_month', priceMinCents: 800_000, lengthWeeks: 12 }, '$8,000 per month · 12 weeks'],
    [{ priceModel: 'custom' }, 'Custom quote'],
    [{ priceModel: 'custom', lengthWeeks: 8 }, 'Custom quote · 8 weeks'],
    [{ priceMinCents: 1_000_000, priceMaxCents: 9_000_000 }, '$10,000 to $90,000'],
    [{ lengthWeeks: 4 }, '4 weeks'],
    [{ priceModel: 'starting_at' }, 'Starting price not set'],
    [{ priceModel: 'per_month' }, 'Monthly price not set'],
  ])('%o is %s', (fields, label) => {
    expect(priceLabel({ ...none, ...fields }, 'USD')).toBe(label);
  });

  it('is null with nothing set', () => {
    expect(priceLabel(none, 'USD')).toBeNull();
  });

  it('uses the workspace currency', () => {
    expect(priceLabel({ ...none, priceModel: 'starting_at', priceMinCents: 4_000_000 }, 'EUR')).toBe('Starting at €40,000');
  });
});

describe('offerStatusLabel', () => {
  it.each([
    ['approved', 'Active'],
    ['draft', 'Draft'],
    ['archived', 'Retired'],
  ])('%s is %s', (status, label) => {
    expect(offerStatusLabel(status)).toBe(label);
  });
});
