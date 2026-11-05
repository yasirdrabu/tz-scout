import type { EnrichmentKind } from '../contracts/types';

// Credits and operations per kind (Ruling 4). Code constants for now: the spec's `provider_price` table is deferred.

/** Credits a person found by `people_for_roles` may cost, per role, at most. */
export const PEOPLE_PER_ROLE = 3;

/** People one request may find or reveal: one arrival (`arrival.v1`) takes at most 25. */
export const MAX_PEOPLE = 25;

/** Apollo's operations per kind. Vibe's sample adapter answers the same operations. */
const CREDIT_OPERATIONS: Partial<Record<EnrichmentKind, readonly string[]>> = {
  company_firmographics: ['organizations/enrich'],
  // The search is free; each person it finds is matched for 1 credit.
  people_for_roles: ['mixed_people/api_search', 'people/match'],
  email_reveal: ['people/match'],
  // The company is looked up once for its organization id (1 credit), so job postings and news cost 1 each.
  signals_refresh: ['organizations/enrich', 'organizations/job_postings', 'news_articles/search'],
};

/** A signals refresh: the organization lookup, job postings and news, 1 credit each. */
export const SIGNALS_REFRESH_CREDITS = 3;

export const OPERATIONS: Record<string, Partial<Record<EnrichmentKind, readonly string[]>>> = {
  apollo: CREDIT_OPERATIONS,
  vibe: CREDIT_OPERATIONS,
  website: { website_read: ['website.read'] },
};

/** The most a website read's Claude call may cost, in cents: the `read_website` task's per-run cap. */
export const WEBSITE_READ_WORST_CENTS = 5;
