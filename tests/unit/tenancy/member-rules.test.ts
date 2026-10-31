import { describe, expect, it } from 'vitest';
import { memberActionRefusal } from '@/modules/tenancy/domain/member-rules';

const seller = { userId: 'usr_b', role: 'seller' as const, status: 'active' as const };
const owner = { userId: 'usr_o', role: 'owner' as const, status: 'active' as const };
/** A member manager who is not an owner or platform admin. */
const manager = { userId: 'usr_a', makesOwners: false, platformAdmin: false };
const anOwner = { userId: 'usr_a', makesOwners: true, platformAdmin: false };
const anAdmin = { userId: 'usr_a', makesOwners: true, platformAdmin: true };

describe('memberActionRefusal', () => {
  it('lets a manager change, suspend, remove and sign out someone else', () => {
    for (const action of ['change_role', 'suspend', 'remove', 'sign_out'] as const) {
      expect(memberActionRefusal(action, manager, seller)).toBeNull();
    }
  });

  it('refuses changing your own role, suspending or removing yourself', () => {
    for (const action of ['change_role', 'change_permissions', 'suspend', 'remove'] as const) {
      expect(memberActionRefusal(action, { ...manager, userId: 'usr_b' }, seller)).toBe('self');
    }
  });

  it('lets you sign yourself out everywhere', () => {
    expect(memberActionRefusal('sign_out', { ...manager, userId: 'usr_b' }, seller)).toBeNull();
  });

  it('refuses suspending or removing an active owner; their role can still change', () => {
    expect(memberActionRefusal('suspend', anOwner, owner)).toBe('owner');
    expect(memberActionRefusal('remove', anOwner, owner)).toBe('owner');
    expect(memberActionRefusal('change_role', anOwner, owner)).toBeNull();
    expect(memberActionRefusal('change_permissions', anOwner, owner)).toBeNull();
  });

  it("refuses changing an owner's role unless you can make owners", () => {
    expect(memberActionRefusal('change_role', manager, owner)).toBe('owners_only');
  });

  it('lets an invited owner be removed (that revokes the invite)', () => {
    expect(memberActionRefusal('remove', anOwner, { ...owner, status: 'invited' })).toBeNull();
  });

  it('refuses signing out an owner unless you can make owners', () => {
    expect(memberActionRefusal('sign_out', manager, owner)).toBe('owners_only');
    expect(memberActionRefusal('sign_out', anOwner, owner)).toBeNull();
  });

  it('refuses signing out a platform admin unless you are one', () => {
    const adminTarget = { ...seller, platformAdmin: true };
    expect(memberActionRefusal('sign_out', manager, adminTarget)).toBe('platform_admin');
    expect(memberActionRefusal('sign_out', anOwner, adminTarget)).toBe('platform_admin');
    expect(memberActionRefusal('sign_out', anAdmin, adminTarget)).toBeNull();
  });
});
