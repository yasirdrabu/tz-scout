export const ROLES = ['owner', 'leader', 'seller', 'operator'] as const;
export type Role = (typeof ROLES)[number];

export type MembershipStatus = 'invited' | 'active' | 'removed';

/** One person in a tenant. `permissions` is filled in by the roles module (Task 10). */
export type Member = {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  role: Role;
  status: Exclude<MembershipStatus, 'removed'>;
  permissions: string[];
};

/** Task 10 defines the shape; until then it is an opaque JSON object. */
export type DataLimit = Record<string, unknown>;

export const CRM_OWNER_TAKEN = 'That CRM user is already linked to someone else.';
