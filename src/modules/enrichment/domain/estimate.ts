import type { EnrichmentKind, Estimate } from '../contracts/types';
import { DEFAULT_CENTS_PER_CREDIT } from '@/modules/integrations/contracts/costs';
import { PEOPLE_PER_ROLE, SIGNALS_REFRESH_CREDITS } from './prices';

export type EstimateInput = {
  provider: string;
  kind: EnrichmentKind;
  roles?: readonly string[];
  personIds?: readonly string[];
  /** The provider's rate (R3a Ruling 1); else its default. */
  centsPerCredit?: number;
  /** Most a website read's Claude call could cost. */
  aiWorstCents?: number;
};

function credits(i: EstimateInput): number {
  switch (i.kind) {
    case 'company_firmographics':
      return 1;
    case 'people_for_roles':
      return (i.roles?.length ?? 0) * PEOPLE_PER_ROLE;
    case 'email_reveal':
      return i.personIds?.length ?? 0;
    case 'signals_refresh':
      return SIGNALS_REFRESH_CREDITS;
    case 'website_read':
      return 0;
  }
}

/** The most a request can cost (Rulings 4 and 5): credits × cents per credit, or the Claude worst case for a website read. */
export function estimate(i: EstimateInput): Estimate {
  if (i.kind === 'website_read') return { credits: 0, costCents: i.aiWorstCents ?? 0 };
  const n = credits(i);
  return { credits: n, costCents: Math.round(n * (i.centsPerCredit ?? DEFAULT_CENTS_PER_CREDIT[i.provider] ?? 0)) };
}

// Cents shown to the cent: estimates are small (offers' `money` rounds to whole units).
const money = (cents: number, currency: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);

/** "Up to 6 credits, about $0.60", or "Free. Claude usage up to $0.05"; " · Sample" on mock (Ruling 5). */
export function estimateText(est: Estimate, currency: string, sample: boolean): string {
  const text =
    est.credits === 0
      ? `Free. Claude usage up to ${money(est.costCents, currency)}`
      : `Up to ${est.credits} ${est.credits === 1 ? 'credit' : 'credits'}, about ${money(est.costCents, currency)}`;
  return sample ? `${text} · Sample` : text;
}
