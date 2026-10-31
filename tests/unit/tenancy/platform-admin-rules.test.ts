import { describe, expect, it } from 'vitest';
import { adminRemovalRefusal, isStaffEmail } from '@/modules/tenancy/domain/platform-admin-rules';

describe('isStaffEmail', () => {
  it('accepts @taazaa.com addresses only', () => {
    expect(isStaffEmail('ana@taazaa.com')).toBe(true);
    expect(isStaffEmail(' Ana@TAAZAA.com ')).toBe(true);
    expect(isStaffEmail('ana@taazaa.com.evil.io')).toBe(false);
    expect(isStaffEmail('ana@nottaazaa.com')).toBe(false);
    expect(isStaffEmail('@taazaa.com')).toBe(false);
    expect(isStaffEmail('ana@example.com')).toBe(false);
  });
});

describe('adminRemovalRefusal', () => {
  it('refuses removing yourself, then the last admin', () => {
    expect(adminRemovalRefusal('u1', 'u1', 5)).toBe('not-yourself');
    expect(adminRemovalRefusal('u1', 'u2', 1)).toBe('last-admin');
    expect(adminRemovalRefusal('u1', 'u2', 2)).toBeNull();
  });
});
