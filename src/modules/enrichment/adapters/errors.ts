// Errors the enrichment adapters throw, shaped for `classifyError` (Ruling 9) and the gateway's call log.

/** A provider answer that failed, with its HTTP status (401 is a rejected key, 400 a refused request). */
export class ProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** The provider has no credits left; a run keeps what it found and stops. */
export class OutOfCreditsError extends Error {
  readonly kind = 'out_of_credits';
  constructor(
    provider: string,
    readonly status = 422,
  ) {
    super(`${provider} is out of credits.`);
    this.name = 'OutOfCreditsError';
  }
}

/** For an operation the provider does not have. */
export const cantDo = (provider: string): ProviderError => new ProviderError(400, `${provider} can't do that.`);

/** A `Retry-After` header (seconds or an HTTP date) in milliseconds, or undefined. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const s = Number(header);
  if (Number.isFinite(s) && s >= 0) return Math.round(s * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}
