/** How an offer is priced (Decision 16). */
export const PRICE_MODELS = ['fixed', 'starting_at', 'per_month', 'custom'] as const;
export type PriceModel = (typeof PRICE_MODELS)[number];

/** The screens' words for an offer status: approved offers are Active, archived ones Retired. */
const STATUS_LABELS: Record<string, string> = { approved: 'Active', draft: 'Draft', archived: 'Retired' };

export function offerStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

type PriceFields = {
  priceModel: string | null;
  priceMinCents: number | null;
  priceMaxCents: number | null;
  lengthWeeks: number | null;
};

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(cents / 100);

/**
 * The price line (Ruling 13): "Fixed fee · 6 weeks", "Starting at $40,000", "$8,000 per month", "Custom quote".
 * The amount is `price_min_cents` (the form sends it as both min and max); a range shows only without a model.
 * Null when nothing about the price is set.
 */
export function priceLabel(o: PriceFields, currency: string): string | null {
  const min = o.priceMinCents ?? o.priceMaxCents;
  const amount = min === null ? null : money(min, currency);
  const length = o.lengthWeeks ? `${o.lengthWeeks} ${o.lengthWeeks === 1 ? 'week' : 'weeks'}` : null;
  let price: string | null;
  switch (o.priceModel) {
    case 'fixed':
      price = amount ? `Fixed fee · ${amount}` : 'Fixed fee';
      break;
    case 'starting_at':
      price = amount ? `Starting at ${amount}` : 'Starting price not set';
      break;
    case 'per_month':
      price = amount ? `${amount} per month` : 'Monthly price not set';
      break;
    case 'custom':
      price = 'Custom quote';
      break;
    default: {
      const max = o.priceMaxCents;
      price = amount && max !== null && max !== min ? `${amount} to ${money(max, currency)}` : amount;
    }
  }
  const parts = [price, length].filter((p): p is string => !!p);
  return parts.length ? parts.join(' · ') : null;
}
