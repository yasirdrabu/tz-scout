import type { DataLimit } from '../domain/data-limit';
import type { Permission } from '../domain/permissions';

export const ROLES = ['owner', 'leader', 'seller', 'operator'] as const;
export type Role = (typeof ROLES)[number];

export type MembershipStatus = 'invited' | 'active' | 'removed';

/** One person in a tenant. `permissions` is the effective set: role defaults plus extras. */
export type Member = {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  role: Role;
  status: Exclude<MembershipStatus, 'removed'>;
  permissions: Permission[];
};

export type { DataLimit };

export const CRM_OWNER_TAKEN = 'That CRM user is already linked to someone else.';
