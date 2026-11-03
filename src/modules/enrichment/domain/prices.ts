import type { EnrichmentKind } from '../contracts/types';

// Credits and operations per kind (Ruling 4). Code constants for now: the spec's `provider_price` table is deferred.

/** Money per credit when the connection's settings set none (Ruling 5). */
export const DEFAULT_CENTS_PER_CREDIT: Record<string, number> = { apollo: 10, vibe: 10 };

/** Credits a person found by `people_for_roles` may cost, per role, at most. */
export const PEOPLE_PER_ROLE = 3;

/** Apollo's operations per kind. Vibe's sample adapter answers the same operations. */
const CREDIT_OPERATIONS: Partial<Record<EnrichmentKind, readonly string[]>> = {
  company_firmographics: ['organizations/enrich'],
  // The search is free; each person it finds is matched for 1 credit.
  people_for_roles: ['mixed_people/api_search', 'people/match'],
  email_reveal: ['people/match'],
  signals_refresh: ['organizations/job_postings', 'news_articles/search'],
};

export const OPERATIONS: Record<string, Partial<Record<EnrichmentKind, readonly string[]>>> = {
  apollo: CREDIT_OPERATIONS,
  vibe: CREDIT_OPERATIONS,
  website: { website_read: ['website.read'] },
};
