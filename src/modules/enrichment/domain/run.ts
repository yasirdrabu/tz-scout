import type { EnrichmentKind } from '../contracts/types';

// Pure rules of the run (Ruling 8): which titles a role is searched by, and the words for finding nothing.

/** Each role's own titles. A role not listed here is searched by its label. */
const ROLE_TITLES: Record<string, readonly string[]> = {
  business_owner: ['Owner', 'CEO', 'President', 'Founder'],
  commercial_buyer: ['VP Sales', 'Head of Procurement', 'CFO'],
  technical_buyer: ['CTO', 'VP Engineering', 'IT Director', 'Head of IT'],
};

export type LeadOffer = { targetTitles: readonly string[]; targetBuyingRoles: readonly string[] };

/** The role's own titles (else its label), plus the lead offer's target titles when the offer targets this role. */
export function searchTitles(roleKey: string, roleLabel: string, offer: LeadOffer | null): string[] {
  const own = ROLE_TITLES[roleKey] ?? [roleLabel];
  const extra = offer?.targetBuyingRoles.includes(roleKey) ? offer.targetTitles : [];
  return [...new Set([...own, ...extra])];
}

/** "Apollo found no one for Technical buyer and Champion", or "Apollo found nothing new". */
export function nothingFound(providerName: string, kind: EnrichmentKind, roleLabels: readonly string[]): string {
  if (kind === 'people_for_roles') return `${providerName} found no one for ${roleLabels.join(' and ')}`;
  if (kind === 'email_reveal') return `${providerName} found no one for the people asked about`;
  return `${providerName} found nothing new`;
}
