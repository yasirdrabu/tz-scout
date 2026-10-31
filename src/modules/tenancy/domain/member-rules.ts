import type { MembershipStatus, Role } from '../contracts/members';

export type MemberAction = 'change_role' | 'suspend' | 'remove';

/**
 * Why `actorUserId` may not do `action` to the member, or null when the rules allow it
 * (screens.md §21a): nobody changes their own role, suspends or removes themselves, and an active
 * owner cannot be suspended or removed (change their role first). Removing an invited owner revokes
 * the invite and is allowed. The last-owner rule needs the other members and is checked by the service.
 */
export function memberActionRefusal(
  action: MemberAction,
  actorUserId: string,
  target: { userId: string; role: Role; status: MembershipStatus },
): 'self' | 'owner' | null {
  if (target.userId === actorUserId) return 'self';
  if (action !== 'change_role' && target.role === 'owner' && target.status !== 'invited') return 'owner';
  return null;
}
