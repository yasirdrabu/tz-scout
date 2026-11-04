import { describe, expect, it } from 'vitest';
import { classifyError } from '@/modules/enrichment/domain/errors';
import { RateLimitedError } from '@/modules/integrations/gateway';
import { ScoutError } from '@/platform/errors';

const withProps = (message: string, props: Record<string, unknown>) => Object.assign(new Error(message), props);

describe('classifyError (Ruling 9)', () => {
  it('a usage limit refusal is cap_reached', () => {
    const e = new ScoutError({ slug: 'blocked_by_cap', status: 429, title: 'Apollo reached its monthly limit.', extensions: { resets_at: '2026-12-01T00:00:00Z' } });
    expect(classifyError(e, 'Apollo')).toEqual({ kind: 'cap_reached', message: 'Stopped at the Apollo monthly limit.', retry: false });
  });

  it('a 401 is auth, no retry', () => {
    expect(classifyError(withProps('Unauthorized', { status: 401 }), 'Apollo')).toEqual({
      kind: 'auth',
      message: 'Apollo rejected the key. An owner needs to update it in Integrations.',
      retry: false,
    });
  });

  it('reads `statusCode` as the gateway does', () => {
    expect(classifyError(withProps('Unauthorized', { statusCode: 401 }), 'Apollo')).toMatchObject({ kind: 'auth', retry: false });
    expect(classifyError(withProps('Too many', { statusCode: 429 }), 'Apollo')).toMatchObject({ kind: 'rate_limited', retry: true });
    expect(classifyError(withProps('Bad domain', { statusCode: 422 }), 'Apollo')).toMatchObject({ kind: 'bad_request', message: 'Bad domain' });
  });

  it('a rate limit retries', () => {
    expect(classifyError(new RateLimitedError(), 'Apollo')).toMatchObject({ kind: 'rate_limited', retry: true });
    expect(classifyError(withProps('Too many', { status: 429 }), 'Apollo')).toMatchObject({ kind: 'rate_limited', retry: true });
  });

  it('insufficient credits is out_of_credits', () => {
    expect(classifyError(withProps('Insufficient credits for this request', { status: 422 }), 'Apollo')).toEqual({
      kind: 'out_of_credits',
      message: 'Apollo is out of credits.',
      retry: false,
    });
    expect(classifyError(withProps('nope', { kind: 'out_of_credits' }), 'Vibe Prospecting')).toMatchObject({ kind: 'out_of_credits', retry: false });
  });

  it('an abort or timeout retries', () => {
    expect(classifyError(withProps('aborted', { name: 'AbortError' }), 'Company website')).toMatchObject({ kind: 'timeout', retry: true });
    expect(classifyError(withProps('timed out', { name: 'TimeoutError' }), 'Company website')).toMatchObject({ kind: 'timeout', retry: true });
  });

  it("a 400 or 422 fails with the provider's message", () => {
    expect(classifyError(withProps('domain is not valid', { status: 422 }), 'Apollo')).toEqual({ kind: 'bad_request', message: 'domain is not valid', retry: false });
    expect(classifyError(withProps('bad', { status: 400 }), 'Apollo')).toMatchObject({ kind: 'bad_request', retry: false });
  });

  it('the gateway refusing the connection fails at once (review I1)', () => {
    const refused = (slug: string, status: number) => new ScoutError({ slug, status, title: 'x' });
    expect(classifyError(refused('connection_disabled', 409), 'Apollo')).toEqual({
      kind: 'bad_request',
      message: 'Apollo is turned off. An owner can turn it on in Integrations.',
      retry: false,
    });
    expect(classifyError(refused('connection_not_ready', 409), 'Apollo')).toEqual({
      kind: 'bad_request',
      message: 'Apollo is set to live but is not ready. An owner needs to save a key and test it in Integrations.',
      retry: false,
    });
    expect(classifyError(refused('adapter-missing', 501), 'Apollo')).toEqual({ kind: 'bad_request', message: 'Apollo is not available yet.', retry: false });
  });

  it('anything else is unknown and retries', () => {
    expect(classifyError(new Error('boom'), 'Apollo')).toEqual({ kind: 'unknown', message: 'Something went wrong. Try again.', retry: true });
    expect(classifyError('not an error', 'Apollo')).toMatchObject({ kind: 'unknown', retry: true });
  });
});
