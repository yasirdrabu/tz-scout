import { RateLimitedError } from '@/modules/integrations';
import { OutOfCreditsError, ProviderError } from './errors';

// Failures the sample adapters (Apollo, Vibe, website) can be told to throw, for tests of how a run handles them.
// Held in memory: it applies to this process only, which is where tests run their jobs.

export type MockFailureKind = '401' | '403' | '429' | '500' | 'timeout' | 'out_of_credits';

let failure: { kind: MockFailureKind; after: number } | null = null;

/** Every sample call fails with `kind` after `after` more calls succeed, until `setMockFailure(null)`. */
export function setMockFailure(kind: MockFailureKind | null, after = 0): void {
  failure = kind ? { kind, after } : null;
}

/** Throws the failure a test asked for, as the live adapter would. */
export function failIfAsked(provider: string): void {
  if (!failure) return;
  if (failure.after > 0) {
    failure.after--;
    return;
  }
  const kind = failure.kind;
  if (kind === '401') throw new ProviderError(401, `${provider} rejected the key (sample data).`);
  if (kind === '403') throw new ProviderError(403, `${provider} says this key can't use that (sample data).`);
  if (kind === '429') throw new RateLimitedError(`${provider} asked us to slow down (sample data).`, 60_000);
  if (kind === '500') throw new ProviderError(500, `${provider} returned 500 (sample data).`);
  if (kind === 'timeout') throw Object.assign(new Error(`${provider} timed out (sample data).`), { name: 'TimeoutError' });
  throw new OutOfCreditsError(provider);
}
