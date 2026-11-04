// Types other modules may see. They never see this module's tables.

/** What a request finds (Ruling 4), in the order the dialog lists them. */
export const KINDS = ['company_firmographics', 'people_for_roles', 'email_reveal', 'website_read', 'signals_refresh'] as const;
export type EnrichmentKind = (typeof KINDS)[number];

/** A request's statuses (Ruling 7). */
export const REQUEST_STATUSES = ['flagged', 'approved', 'declined', 'cancelled', 'running', 'completed', 'partial', 'failed'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** How a provider call failed (Ruling 9). */
export const ERROR_KINDS = ['cap_reached', 'auth', 'out_of_credits', 'rate_limited', 'timeout', 'bad_request', 'unknown'] as const;
export type EnrichmentErrorKind = (typeof ERROR_KINDS)[number];

export type Estimate = { credits: number; costCents: number };
