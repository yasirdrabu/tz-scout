import { describe, expect, it } from 'vitest';
import { forwardedClientIp } from '@/modules/tenancy/domain/client-ip';

describe('forwardedClientIp', () => {
  it('ignores X-Forwarded-For with no trusted proxy (0 hops)', () => {
    expect(forwardedClientIp('203.0.113.7', 0)).toBeNull();
    expect(forwardedClientIp(null, 0)).toBeNull();
  });

  it('with 1 hop takes the right-most entry, the one our proxy added', () => {
    expect(forwardedClientIp('203.0.113.7', 1)).toBe('203.0.113.7');
    expect(forwardedClientIp('203.0.113.7, 10.0.0.1', 1)).toBe('10.0.0.1');
  });

  it('with 2 hops takes the second entry from the right', () => {
    expect(forwardedClientIp('203.0.113.7, 10.0.0.1', 2)).toBe('203.0.113.7');
    expect(forwardedClientIp('1.2.3.4, 203.0.113.7, 10.0.0.1', 2)).toBe('203.0.113.7');
  });

  it('does not let a client spoof its address by sending its own header', () => {
    // The client sent "6.6.6.6"; one trusted proxy appended the real address.
    expect(forwardedClientIp('6.6.6.6, 198.51.100.4', 1)).toBe('198.51.100.4');
    // Fewer entries than trusted hops: the request did not come through every proxy.
    expect(forwardedClientIp('6.6.6.6', 2)).toBeNull();
    expect(forwardedClientIp(' , ', 1)).toBeNull();
  });
});
