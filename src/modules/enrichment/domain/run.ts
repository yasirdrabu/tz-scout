import type { EnrichmentKind } from '../contracts/types';

// Pure rules of the run (Ruling 8): which titles a role is searched by, and the words for finding nothing.

/** Titles to search by when the account's best offer names none. A role not listed here is searched by its label. */
const ROLE_TITLES: Record<string, readonly string[]> = {
  business_owner: ['Owner', 'CEO', 'President', 'Founder'],
  commercial_buyer: ['VP Sales', 'Head of Procurement', 'CFO'],
  technical_buyer: ['CTO', 'VP Engineering', 'IT Director', 'Head of IT'],
};

/** The best offer's target titles, else the role's default titles, else its label. */
export function searchTitles(roleKey: string, roleLabel: string, offerTitles: readonly string[]): string[] {
  if (offerTitles.length) return [...offerTitles];
  return [...(ROLE_TITLES[roleKey] ?? [roleLabel])];
}

/** "Apollo found no one for Technical buyer and Champion", or "Apollo found nothing new". */
export function nothingFound(providerName: string, kind: EnrichmentKind, roleLabels: readonly string[]): string {
  if (kind === 'people_for_roles') return `${providerName} found no one for ${roleLabels.join(' and ')}`;
  if (kind === 'email_reveal') return `${providerName} found no one for the people asked about`;
  return `${providerName} found nothing new`;
}
