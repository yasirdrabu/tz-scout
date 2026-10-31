import type { Permission } from './permissions';

/** Plain words for each permission, for pages people read. Keys stay in API docs and key scopes. */
export const PERMISSION_LABELS: Record<Permission, string> = {
  'accounts:read': 'See accounts',
  'accounts:write': 'Edit accounts',
  'people:read': 'See people',
  'people:write': 'Edit people',
  'signals:write': 'Add signals',
  'arrivals:write': 'Add arrivals',
  'arrivals:read': 'See arrivals',
  'imports:run': 'Run imports',
  'sources:manage': 'Manage sources',
  'enrichment:request': 'Ask for enrichment',
  'enrichment:approve': 'Approve enrichment',
  'review:act': 'Work the review queue',
  'assign:act': 'Assign accounts',
  'assignments:respond': 'Respond to assignments',
  'playbooks:read': 'See playbooks',
  'playbooks:write': 'Edit playbooks',
  'playbooks:manage': 'Manage playbooks',
  'offers:read': 'See offers',
  'offers:manage': 'Manage offers',
  'scoring:manage': 'Manage scoring',
  'crm:push': 'Send updates to HubSpot',
  'campaigns:read': 'See campaigns',
  'campaigns:manage': 'Manage campaigns',
  'searches:manage': 'Manage saved searches',
  'warm_intro:declare': 'Mark warm introductions',
  'analytics:read': 'See reports',
  'costs:write': 'Record costs',
  'integrations:manage': 'Manage integrations',
  'members:read': 'See members',
  'members:manage': 'Manage members',
  'keys:manage': 'Manage access keys',
  'webhooks:manage': 'Manage webhooks',
  'settings:manage': 'Manage settings',
  'status:read': 'See system status',
  'audit:read': 'See the audit log',
};

export const permissionLabel = (p: Permission): string => PERMISSION_LABELS[p];

/** The groups of the roles and permissions matrix (screens.md §21a), in display order. */
export const PERMISSION_GROUP_NAMES = ['Accounts', 'Review and sources', 'Offers and playbooks', 'Pipeline and money', 'Workspace'] as const;
export type PermissionGroup = (typeof PERMISSION_GROUP_NAMES)[number];

const GROUPS: Record<PermissionGroup, Permission[]> = {
  Accounts: [
    'accounts:read',
    'accounts:write',
    'people:read',
    'people:write',
    'signals:write',
    'enrichment:request',
    'enrichment:approve',
    'warm_intro:declare',
    'searches:manage',
  ],
  'Review and sources': ['arrivals:write', 'arrivals:read', 'imports:run', 'sources:manage', 'review:act', 'assign:act', 'assignments:respond'],
  'Offers and playbooks': ['offers:read', 'offers:manage', 'playbooks:read', 'playbooks:write', 'playbooks:manage', 'scoring:manage', 'campaigns:read', 'campaigns:manage'],
  'Pipeline and money': ['crm:push', 'analytics:read', 'costs:write'],
  Workspace: ['members:read', 'members:manage', 'keys:manage', 'integrations:manage', 'webhooks:manage', 'settings:manage', 'status:read', 'audit:read'],
};

export function permissionGroup(p: Permission): PermissionGroup {
  return PERMISSION_GROUP_NAMES.find((g) => GROUPS[g].includes(p))!;
}
