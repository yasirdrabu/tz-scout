import { describe, expect, it } from 'vitest';
import { scrubError } from '@/platform/scrub-error';

describe('scrubError', () => {
  it('removes credentials from connection strings', () => {
    expect(scrubError('connect postgres://scout_app:hunter2@db:5432/scout failed')).toBe(
      'connect postgres://[redacted]@db:5432/scout failed',
    );
    expect(scrubError('nats://user:pw@host:4222 down')).toBe('nats://[redacted]@host:4222 down');
  });
  it('removes query strings from urls', () => {
    expect(scrubError('GET https://api.x.com/v1/a?api_key=abc&b=1 gave 500')).toBe('GET https://api.x.com/v1/a?[redacted] gave 500');
  });
  it('removes bearer tokens and scout keys', () => {
    expect(scrubError('Authorization: Bearer abc.def-123')).toBe('Authorization: Bearer [redacted]');
    expect(scrubError('bad key scout_live_ab12cd34EFGH56')).toBe('bad key [redacted key]');
  });
  it('removes long token-like runs but keeps ordinary words', () => {
    const t = 'a1'.repeat(20);
    expect(scrubError(`token ${t} rejected`)).toBe('token [redacted] rejected');
    expect(scrubError('The service did not answer')).toBe('The service did not answer');
  });
  it('keeps long words and paths without digits', () => {
    const s = 'internationalization-and-localization-of/the/configuration';
    expect(scrubError(s)).toBe(s);
  });
  it('truncates to 500 characters', () => {
    expect(scrubError('word '.repeat(300)).length).toBeLessThanOrEqual(500);
  });
});
