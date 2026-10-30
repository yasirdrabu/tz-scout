import { ScoutError } from '@/platform/errors';

// What a failed push run means (Ruling 4): retry it, or stop and show the reason in plain words. Pure and tested.

export const NO_CRM_OWNER = "This seller isn't linked to a CRM owner";
export const OWNER_INACTIVE = 'Link this person to a HubSpot owner first';
export const NO_DOMAIN = 'This account has no website, so HubSpot cannot match it.';
export const TOKEN_REFUSED = 'HubSpot refused the token. Enter a new one in Integrations.';
export const RETRIES_FAILED = 'HubSpot was busy and every retry failed.';
export const UNREADABLE_ANSWER = 'HubSpot sent an answer Scout could not read.';
export const SOMETHING_WRONG = 'Something went wrong sending this to HubSpot. Try again.';
export const REASON_LIMIT = 300;

/** A push that cannot go ahead; its message is the reason shown. */
export class NotPushable extends Error {}

export type PushFailure = {
  retryable: boolean;
  reason: string;
  /** Not an error the push expects; worth logging in full. */
  unexpected?: boolean;
};

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

type Shape = { name?: unknown; message?: unknown; status?: unknown; code?: unknown; cause?: { code?: unknown } };

/** Postgres errors that go away on their own: serialisation and deadlock (40), connection (08), admin shutdown, lock not available, a statement (lock wait) cancelled by its time limit. */
const transientSqlState = (code: string) => /^(40|08)/.test(code) || ['57P01', '55P03', '57014'].includes(code);
const isSqlState = (code: unknown): code is string => typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code);

export function classifyPushError(e: unknown): PushFailure {
  const retry: PushFailure = { retryable: true, reason: RETRIES_FAILED };
  if (e instanceof NotPushable || e instanceof ScoutError) return { retryable: false, reason: e.message.slice(0, REASON_LIMIT) };
  const o = (e && typeof e === 'object' ? e : {}) as Shape;
  const message = typeof o.message === 'string' ? o.message : '';
  if (o.name === 'RateLimitedError') return retry;
  if (typeof o.status === 'number') {
    if (o.status === 429 || o.status >= 500) return retry;
    if (o.status === 401) return { retryable: false, reason: TOKEN_REFUSED };
    // A 403 already says which permission ("HubSpot needs another permission: <scope>.").
    if (o.status >= 400) return { retryable: false, reason: message.slice(0, REASON_LIMIT) };
  }
  if (o.name === 'TimeoutError' || o.name === 'AbortError') return retry;
  const code = typeof o.code === 'string' ? o.code : typeof o.cause?.code === 'string' ? o.cause.code : null;
  if (code && NETWORK_CODES.has(code)) return retry;
  if (e instanceof TypeError && message === 'fetch failed') return retry;
  if (message.startsWith('HubSpot did not answer')) return retry; // the live connector's network failure
  // Drizzle wraps the driver's error, so the SQLSTATE may be on the cause.
  if (isSqlState(code) && transientSqlState(code)) return retry;
  if (message.startsWith('HubSpot sent an unexpected answer')) return { retryable: false, reason: UNREADABLE_ANSWER };
  return { retryable: false, reason: SOMETHING_WRONG, unexpected: true };
}
