import { isCapWait } from '@/modules/integrations';
import type { EnrichmentErrorKind } from '../contracts/types';

// What a failed provider call means (Ruling 9). `retry` says the run should rethrow for the job's backoff.
// A cap wait is not a retry: the run rethrows it only before any result, and the worker waits for the limit.

export type ClassifiedError = { kind: EnrichmentErrorKind; message: string; retry: boolean };

export const SOMETHING_WRONG = 'Something went wrong. Try again.';

type Shape = { name?: unknown; message?: unknown; status?: unknown; statusCode?: unknown; kind?: unknown };

export function classifyError(e: unknown, providerName: string): ClassifiedError {
  const fail = (kind: EnrichmentErrorKind, message: string): ClassifiedError => ({ kind, message, retry: false });
  const retry = (kind: EnrichmentErrorKind, message: string): ClassifiedError => ({ kind, message, retry: true });
  if (isCapWait(e)) return fail('cap_reached', `Stopped at the ${providerName} monthly limit.`);
  const o = (e && typeof e === 'object' ? e : {}) as Shape;
  const message = typeof o.message === 'string' ? o.message : '';
  // As the gateway's `statusCodeOf`: `status`, else `statusCode`.
  const status = o.status ?? o.statusCode;
  if (status === 401) return fail('auth', `${providerName} rejected the key. An owner needs to update it in Integrations.`);
  if (o.name === 'RateLimitedError' || status === 429) return retry('rate_limited', `${providerName} asked us to slow down.`);
  // Before 400/422: Apollo sends its credits error as a 422.
  if (o.kind === 'out_of_credits' || /insufficient credits/i.test(message)) return fail('out_of_credits', `${providerName} is out of credits.`);
  if (o.name === 'AbortError' || o.name === 'TimeoutError') return retry('timeout', `${providerName} took too long to answer.`);
  if (status === 400 || status === 422) return fail('bad_request', message || `${providerName} refused the request.`);
  return retry('unknown', SOMETHING_WRONG);
}
