import type { MembershipStatus, Role } from '../contracts/members';

export type MemberAction = 'change_role' | 'change_permissions' | 'suspend' | 'remove' | 'sign_out';

/** Why the rules refuse an action: `self`, an `owner` target, owners only, or a platform admin target. */
export type MemberRefusal = 'self' | 'owner' | 'owners_only' | 'platform_admin';

/** Who acts: owners and platform admins make owners. */
export type MemberActor = { userId: string; makesOwners: boolean; platformAdmin: boolean };

export type MemberTarget = { userId: string; role: Role; status: MembershipStatus; platformAdmin?: boolean };

/**
 * Why `actor` may not do `action` to the member, or null when the rules allow it (screens.md §21a):
 * nobody changes their own role or extra permissions, suspends or removes themselves; an active owner
 * cannot be suspended or removed (change their role first); only someone who makes owners changes an
 * owner's role. Removing an invited owner revokes the invite and is allowed. Sessions are platform-wide,
 * so signing out everywhere an owner needs someone who makes owners, and a platform admin needs a
 * platform admin; you may sign yourself out. The last-owner rule needs the other members and is
 * checked by the service.
 */
export function memberActionRefusal(action: MemberAction, actor: MemberActor, target: MemberTarget): MemberRefusal | null {
  if (action === 'sign_out') {
    if (target.role === 'owner' && !actor.makesOwners) return 'owners_only';
    if (target.platformAdmin && !actor.platformAdmin) return 'platform_admin';
    return null;
  }
  if (target.userId === actor.userId) return 'self';
  if ((action === 'suspend' || action === 'remove') && target.role === 'owner' && target.status !== 'invited') return 'owner';
  if (action === 'change_role' && target.role === 'owner' && !actor.makesOwners) return 'owners_only';
  return null;
}
