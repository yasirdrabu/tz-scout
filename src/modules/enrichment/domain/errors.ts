import { isCapWait } from '@/modules/integrations';
import { COST_CATEGORIES, categoryLabel, type CostCategory } from '@/modules/integrations/contracts/costs';
import type { EnrichmentErrorKind } from '../contracts/types';

// What a failed provider call means (Ruling 9). `retry` says the run should rethrow for the job's backoff.
// A cap wait is not a retry: the run rethrows it only before any result, and the worker waits for the limit.

export type ClassifiedError = { kind: EnrichmentErrorKind; message: string; retry: boolean };

export const SOMETHING_WRONG = 'Something went wrong. Try again.';

/** The cost category a budget pause (R3a Ruling 9) refused the call for, or null for any other error. */
export function pausedCategoryOf(e: unknown): CostCategory | null {
  if (!isCapWait(e)) return null;
  const category = e.extensions?.category;
  return COST_CATEGORIES.some((c) => c.key === category) ? (category as CostCategory) : null;
}

/** What a request waiting on a paused budget reads (R3a Ruling 9). */
export const budgetWaiting = (category: CostCategory): string => `Waiting for budget: ${categoryLabel(category)} is over its monthly budget`;

type Shape = { name?: unknown; message?: unknown; status?: unknown; statusCode?: unknown; kind?: unknown; slug?: unknown };

export function classifyError(e: unknown, providerName: string): ClassifiedError {
  const fail = (kind: EnrichmentErrorKind, message: string): ClassifiedError => ({ kind, message, retry: false });
  const retry = (kind: EnrichmentErrorKind, message: string): ClassifiedError => ({ kind, message, retry: true });
  const paused = pausedCategoryOf(e);
  if (paused) return fail('cap_reached', `Stopped: ${categoryLabel(paused)} is over its monthly budget.`);
  if (isCapWait(e)) return fail('cap_reached', `Stopped at the ${providerName} monthly limit.`);
  const o = (e && typeof e === 'object' ? e : {}) as Shape;
  const message = typeof o.message === 'string' ? o.message : '';
  // As the gateway's `statusCodeOf`: `status`, else `statusCode`.
  const status = o.status ?? o.statusCode;
  // The gateway refusing the connection (review I1): no retry can change it until an owner acts, so fail at once.
  if (o.slug === 'connection_disabled') return fail('bad_request', `${providerName} is turned off. An owner can turn it on in Integrations.`);
  if (o.slug === 'connection_not_ready') {
    return fail('bad_request', `${providerName} is set to live but is not ready. An owner needs to save a key and test it in Integrations.`);
  }
  if (o.slug === 'adapter-missing') return fail('bad_request', `${providerName} is not available yet.`);
  if (status === 401) return fail('auth', `${providerName} rejected the key. An owner needs to update it in Integrations.`);
  if (o.name === 'RateLimitedError' || status === 429) return retry('rate_limited', `${providerName} asked us to slow down.`);
  // Before 400/422: Apollo sends its credits error as a 422.
  if (o.kind === 'out_of_credits' || /insufficient credits/i.test(message)) return fail('out_of_credits', `${providerName} is out of credits.`);
  if (o.name === 'AbortError' || o.name === 'TimeoutError') return retry('timeout', `${providerName} took too long to answer.`);
  // A 403 is this key not allowed this endpoint (Apollo: people search needs a master key): a retry cannot change it,
  // and the key still works elsewhere, so it is not `auth`. A departure from Ruling 9's "400 or 422".
  if (status === 400 || status === 403 || status === 422) return fail('bad_request', message || `${providerName} refused the request.`);
  return retry('unknown', SOMETHING_WRONG);
}
