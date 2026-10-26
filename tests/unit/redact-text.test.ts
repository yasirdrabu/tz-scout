import { describe, expect, it } from 'vitest';
import { redactPersonalText } from '@/lib/redact-text';

describe('redactPersonalText', () => {
  it('replaces email addresses', () => {
    expect(redactPersonalText('Write to jane.doe+x@acme.co.uk today')).toBe('Write to [email] today');
  });
  it('replaces phone numbers in common formats', () => {
    expect(redactPersonalText('Call +1 (415) 555-0132 or 415-555-0132 or 4155550132')).toBe(
      'Call [phone] or [phone] or [phone]',
    );
  });
  it('leaves dates, ids, hashes and short numbers alone', () => {
    const s = 'run_01JABCDEF at 2026-10-25T10:00:00Z hash 12345678abcd 2026-10-25 total 1,250 and 42';
    expect(redactPersonalText(s)).toBe(s);
  });
  it('handles several in one string and empty input', () => {
    expect(redactPersonalText('a@b.io, c@d.io 555 123 4567')).toBe('[email], [email] [phone]');
    expect(redactPersonalText('')).toBe('');
  });
});
