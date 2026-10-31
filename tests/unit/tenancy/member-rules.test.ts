import { describe, expect, it } from 'vitest';
import { memberActionRefusal } from '@/modules/tenancy/domain/member-rules';

const seller = { userId: 'usr_b', role: 'seller' as const, status: 'active' as const };
const owner = { userId: 'usr_o', role: 'owner' as const, status: 'active' as const };

describe('memberActionRefusal', () => {
  it('lets a manager change, suspend and remove someone else', () => {
    expect(memberActionRefusal('change_role', 'usr_a', seller)).toBeNull();
    expect(memberActionRefusal('suspend', 'usr_a', seller)).toBeNull();
    expect(memberActionRefusal('remove', 'usr_a', seller)).toBeNull();
  });

  it('refuses changing your own role, suspending or removing yourself', () => {
    for (const action of ['change_role', 'change_permissions', 'suspend', 'remove'] as const) {
      expect(memberActionRefusal(action, 'usr_b', seller)).toBe('self');
    }
  });

  it('refuses suspending or removing an active owner; their role can still change', () => {
    expect(memberActionRefusal('suspend', 'usr_a', owner)).toBe('owner');
    expect(memberActionRefusal('remove', 'usr_a', owner)).toBe('owner');
    expect(memberActionRefusal('change_role', 'usr_a', owner)).toBeNull();
    expect(memberActionRefusal('change_permissions', 'usr_a', owner)).toBeNull();
  });

  it('lets an invited owner be removed (that revokes the invite)', () => {
    expect(memberActionRefusal('remove', 'usr_a', { ...owner, status: 'invited' })).toBeNull();
  });
});
