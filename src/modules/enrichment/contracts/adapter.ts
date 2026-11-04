import type { Adapter } from '@/modules/integrations';
import type { ArrivalV1 } from '@/modules/intake';

// One contract for every enrichment provider (Apollo, Vibe, the company website). Values are arrival-shaped, so a
// run hands them to intake as one `arrival.v1`. `provider_ref` is the provider's own id (an Apollo organization or
// person id): it lets a later call find the same record and is dropped before the arrival is submitted.

/** The accounts fact values for a person's email (Ruling 12). */
export const EMAIL_STATUSES = ['verified', 'guessed', 'unavailable', 'bounced'] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

type ArrivalAccount = NonNullable<ArrivalV1['account']>;

/** `arrival.v1` account fields. `external_ref` and `notes` are the run's to set. */
export type CompanyFacts = Omit<ArrivalAccount, 'external_ref' | 'notes'> & { provider_ref?: string | null };

/** An `arrival.v1` person (with Ruling 12's `email_status` and `seniority`) and the provider's own id for them. */
export type Person = ArrivalV1['people'][number] & { provider_ref?: string | null };

export type Signal = ArrivalV1['signals'][number];

/** One page read from a company's website. `html` is capped at 2 MB; `text` is the visible text. */
export type SitePage = { url: string; title: string; text: string; html: string };

/** A result with the credits the provider charged for it. */
export type Paid<T> = { value: T; creditsUsed: number };

/**
 * Each adapter implements the operations its provider has; the others throw `bad_request` "{Provider} can't do that."
 * Errors carry what `classifyError` reads: `status` (401, 400...), `RateLimitedError`, `kind: 'out_of_credits'`, and
 * `TimeoutError`/`AbortError`.
 */
export type EnrichmentAdapter = Adapter & {
  /** `null` when the provider has no such company. */
  companyEnrich(input: { domain: string }): Promise<Paid<CompanyFacts | null>>;
  /** Free at Apollo: names and titles only, no emails. Reveal each person to get the rest. */
  peopleSearch(input: { domain: string; titles: string[]; max: number }): Promise<Paid<Person[]>>;
  /** Matches one person (by `provider_ref`, else name and `domain`) and returns them with their email. */
  revealEmail(input: { person: Person; domain?: string }): Promise<Paid<Person>>;
  /** `orgId` is the company's `provider_ref`; without it the adapter looks the company up first, which can cost a credit. */
  jobPostings(input: { domain: string; orgId?: string }): Promise<Paid<Signal[]>>;
  news(input: { domain: string; orgId?: string }): Promise<Paid<Signal[]>>;
  /** The home page and up to 4 linked pages. Free. */
  readSite(input: { domain: string }): Promise<{ pages: SitePage[] }>;
};
