import type { Role } from '../contracts/members';

/** Every permission, as `<resource>:<action>`. For keys and OAuth grants they are called scopes. */
export const PERMISSIONS = [
  'accounts:read',
  'accounts:write',
  'people:read',
  'people:write',
  'signals:write',
  'arrivals:write',
  'arrivals:read',
  'imports:run',
  'sources:manage',
  'enrichment:request',
  'enrichment:approve',
  'review:act',
  'assign:act',
  'assignments:respond',
  'playbooks:read',
  'playbooks:write',
  'playbooks:manage',
  'offers:read',
  'offers:manage',
  'scoring:manage',
  'crm:push',
  'campaigns:read',
  'campaigns:manage',
  'searches:manage',
  'warm_intro:declare',
  'analytics:read',
  'costs:write',
  'integrations:manage',
  'members:read',
  'members:manage',
  'keys:manage',
  'webhooks:manage',
  'settings:manage',
  'status:read',
  'audit:read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL: Permission[] = [...PERMISSIONS];
const ACCOUNT_GROUP: Permission[] = ['accounts:read', 'accounts:write', 'people:read', 'people:write', 'signals:write'];
const COMMON: Permission[] = [
  'enrichment:request',
  'warm_intro:declare',
  'campaigns:read',
  'analytics:read',
  'offers:read',
  'status:read',
];
const LEADER_LACKS: Permission[] = [
  'offers:manage',
  'campaigns:manage',
  'integrations:manage',
  'members:manage',
  'keys:manage',
  'webhooks:manage',
  'settings:manage',
  'audit:read',
];

/**
 * Default permission sets, from the roles table. A Seller's "own" rows grant the permission and the
 * data limit narrows the rows. Operators hold review:act by default (web-ui W6). "Grantable"
 * (review:act for Seller) is not here: it is added as an extra permission on a membership.
 */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: ALL,
  leader: ALL.filter((p) => !LEADER_LACKS.includes(p)),
  seller: [...ACCOUNT_GROUP, 'arrivals:write', 'assignments:respond', 'playbooks:read', 'playbooks:write', ...COMMON],
  operator: [
    ...ACCOUNT_GROUP,
    'arrivals:write',
    'arrivals:read',
    'imports:run',
    'sources:manage',
    'review:act',
    'scoring:manage',
    'playbooks:read',
    'playbooks:manage',
    'offers:manage',
    'campaigns:manage',
    'searches:manage',
    'costs:write',
    ...COMMON,
  ],
  // Read-only pipeline and scorecard (web-ui Decision 17).
  viewer: ['accounts:read', 'offers:read', 'analytics:read', 'status:read'],
};

export function isPermission(v: unknown): v is Permission {
  return typeof v === 'string' && (PERMISSIONS as readonly string[]).includes(v);
}

/** A workspace's saved permission list per role; a role with no entry uses its default. */
export type RoleSets = Partial<Record<Role, readonly Permission[]>>;

/** What a role holds in a workspace: Owner always everything, else the saved list (unknown strings dropped) or the default. */
export function roleSet(role: Role, sets: RoleSets): Permission[] {
  if (role === 'owner') return [...PERMISSIONS];
  const saved = sets[role];
  return saved ? saved.filter(isPermission) : ROLE_PERMISSIONS[role];
}

/** Effective permissions: the workspace's role set plus extras. Platform admins get everything. */
export function permissionsFor(role: Role, extra: Permission[], platformAdmin: boolean, sets: RoleSets = {}): Permission[] {
  if (platformAdmin) return [...PERMISSIONS];
  const set = new Set<Permission>([...roleSet(role, sets), ...extra]);
  return PERMISSIONS.filter((p) => set.has(p));
}
