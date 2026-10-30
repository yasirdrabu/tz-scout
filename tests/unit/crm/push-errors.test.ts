import { describe, expect, it } from 'vitest';
import {
  NotPushable,
  RETRIES_FAILED,
  SOMETHING_WRONG,
  TOKEN_REFUSED,
  UNREADABLE_ANSWER,
  classifyPushError,
} from '@/modules/crm/domain/push-errors';
import { RateLimitedError } from '@/modules/integrations/gateway';
import { ScoutError } from '@/platform/errors';

const withProps = (message: string, props: Record<string, unknown>, base: Error = new Error(message)) => Object.assign(base, props);
const retry = { retryable: true, reason: RETRIES_FAILED };

describe('classifyPushError (Ruling 4)', () => {
  it('retries rate limits, timeouts and 5xx', () => {
    expect(classifyPushError(new RateLimitedError())).toEqual(retry);
    expect(classifyPushError(withProps('slow', { status: 429 }))).toEqual(retry);
    expect(classifyPushError(withProps('boom', { status: 503 }))).toEqual(retry);
    expect(classifyPushError(withProps('HubSpot timed out', { name: 'TimeoutError' }))).toEqual(retry);
    expect(classifyPushError(withProps('aborted', { name: 'AbortError' }))).toEqual(retry);
  });

  it('retries network errors', () => {
    expect(classifyPushError(new TypeError('fetch failed'))).toEqual(retry);
    expect(classifyPushError(withProps('socket hang up', { code: 'ECONNRESET' }))).toEqual(retry);
    expect(classifyPushError(withProps('fetch failed', { cause: { code: 'ECONNREFUSED' } }))).toEqual(retry);
    expect(classifyPushError(new Error('HubSpot did not answer upsertCompany: other side closed'))).toEqual(retry);
  });

  it('retries Postgres errors that go away on their own', () => {
    for (const code of ['40001', '40P01', '08006', '57P01', '55P03', '57014']) expect(classifyPushError(withProps('pg', { code }))).toEqual(retry);
    // Drizzle wraps the driver error and keeps it as the cause.
    expect(classifyPushError(withProps('Failed query', { cause: { code: '40001' } }))).toEqual(retry);
  });

  it('does not retry other Postgres errors', () => {
    expect(classifyPushError(withProps('duplicate key', { code: '23505' }))).toEqual({ retryable: false, reason: SOMETHING_WRONG, unexpected: true });
  });

  it('keeps the statused mapping: 401 the token sentence, 403 and other 4xx their own message', () => {
    expect(classifyPushError(withProps('refused', { status: 401 }))).toEqual({ retryable: false, reason: TOKEN_REFUSED });
    expect(classifyPushError(withProps('HubSpot needs another permission: crm.objects.companies.write.', { status: 403 }))).toEqual({
      retryable: false,
      reason: 'HubSpot needs another permission: crm.objects.companies.write.',
    });
    expect(classifyPushError(withProps('Property x is invalid', { status: 400 }))).toEqual({ retryable: false, reason: 'Property x is invalid' });
  });

  it('does not retry an answer that does not validate', () => {
    expect(classifyPushError(new Error('HubSpot sent an unexpected answer to upsertCompany.'))).toEqual({ retryable: false, reason: UNREADABLE_ANSWER });
  });

  it('passes its own refusals and ScoutErrors through, cut to 300 characters', () => {
    expect(classifyPushError(new NotPushable("This seller isn't linked to a CRM owner"))).toEqual({ retryable: false, reason: "This seller isn't linked to a CRM owner" });
    expect(classifyPushError(new ScoutError({ slug: 'connection_disabled', status: 409, title: 'HubSpot is turned off.' }))).toEqual({ retryable: false, reason: 'HubSpot is turned off.' });
    expect(classifyPushError(new NotPushable('x'.repeat(400))).reason).toHaveLength(300);
  });

  it('anything else is not retried and is flagged as unexpected', () => {
    expect(classifyPushError(new Error('undefined is not a function'))).toEqual({ retryable: false, reason: SOMETHING_WRONG, unexpected: true });
    expect(classifyPushError('a string')).toEqual({ retryable: false, reason: SOMETHING_WRONG, unexpected: true });
  });
});
