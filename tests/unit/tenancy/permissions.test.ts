import { describe, expect, it } from 'vitest';
import { ScoutError } from '@/platform/errors';
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  can,
  defaultDataLimit,
  describeAccess,
  permissionsFor,
  requirePermission,
  roleSet,
  type Permission,
  type Principal,
} from '@/modules/tenancy';

const has = (role: keyof typeof ROLE_PERMISSIONS, p: Permission) => ROLE_PERMISSIONS[role].includes(p);

describe('permissions', () => {
  it('has 37 permissions', () => {
    expect(PERMISSIONS.length).toBe(37);
    expect(new Set(PERMISSIONS).size).toBe(37);
  });

  it.each([
    ['review:act', { owner: true, leader: true, seller: false, operator: true }],
    ['assign:act', { owner: true, leader: true, seller: false, operator: false }],
    ['offers:manage', { owner: true, leader: false, seller: false, operator: true }],
    ['integrations:manage', { owner: true, leader: false, seller: false, operator: false }],
    ['members:read', { owner: true, leader: true, seller: false, operator: false }],
    ['members:manage', { owner: true, leader: false, seller: false, operator: false }],
    ['assignments:respond', { owner: true, leader: true, seller: true, operator: false }],
    ['arrivals:write', { owner: true, leader: true, seller: true, operator: true }],
    ['arrivals:read', { owner: true, leader: true, seller: false, operator: true }],
    ['imports:run', { owner: true, leader: true, seller: false, operator: true }],
    ['analytics:read', { owner: true, leader: true, seller: true, operator: true }],
    ['costs:write', { owner: true, leader: true, seller: false, operator: true }],
    ['costs:read', { owner: true, leader: true, seller: false, operator: true }],
    ['budgets:write', { owner: true, leader: true, seller: false, operator: false }],
    ['playbooks:write', { owner: true, leader: true, seller: true, operator: true }],
    ['playbooks:manage', { owner: true, leader: true, seller: false, operator: true }],
    ['offers:read', { owner: true, leader: true, seller: true, operator: true }],
    ['status:read', { owner: true, leader: true, seller: true, operator: true }],
    ['signals:write', { owner: true, leader: true, seller: true, operator: true }],
  ] as [Permission, Record<keyof typeof ROLE_PERMISSIONS, boolean>][])('%s by role', (perm, expected) => {
    for (const role of ['owner', 'leader', 'seller', 'operator'] as const) {
      expect(has(role, perm), `${role} ${perm}`).toBe(expected[role]);
    }
  });

  it('owner has everything', () => {
    expect([...ROLE_PERMISSIONS.owner].sort()).toEqual([...PERMISSIONS].sort());
  });

  it('permissionsFor adds extras without duplicates and gives platform admins everything', () => {
    const p = permissionsFor('seller', ['review:act', 'accounts:read'], false);
    expect(p).toContain('review:act');
    expect(p.filter((x) => x === 'accounts:read')).toHaveLength(1);
    expect(permissionsFor('operator', [], true).length).toBe(37);
  });

  it('the Viewer role holds exactly the four read permissions', () => {
    expect([...ROLE_PERMISSIONS.viewer].sort()).toEqual(['accounts:read', 'analytics:read', 'offers:read', 'status:read']);
    expect(defaultDataLimit('user', 'viewer')).toEqual({ kind: 'all' });
  });

  it('roleSet: owner is always everything, a saved set drops unknown strings, no row means the default', () => {
    expect(roleSet('owner', { owner: [] })).toEqual([...PERMISSIONS]);
    expect(roleSet('seller', { seller: ['accounts:read', 'nope' as never] })).toEqual(['accounts:read']);
    expect(roleSet('seller', {})).toEqual(ROLE_PERMISSIONS.seller);
    expect(roleSet('seller', { seller: [] })).toEqual([]);
  });

  it('permissionsFor uses the workspace set plus extras, in PERMISSIONS order', () => {
    expect(permissionsFor('seller', ['review:act'], false, { seller: ['accounts:read'] })).toEqual(['accounts:read', 'review:act']);
  });

  const principal = (over: Partial<Principal>): Principal => ({
    tenantId: 't_1',
    kind: 'user',
    id: 'usr_1',
    permissions: ['accounts:read'],
    dataLimit: { kind: 'all' },
    platformAdmin: false,
    supportAccess: false,
    ...over,
  });

  it('can and requirePermission', () => {
    expect(can(principal({}), 'accounts:read')).toBe(true);
    expect(can(principal({}), 'accounts:write')).toBe(false);
    expect(can(principal({ platformAdmin: true }), 'accounts:write')).toBe(true);
    expect(() => requirePermission(principal({}), 'accounts:read')).not.toThrow();
    try {
      requirePermission(principal({}), 'accounts:write');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ScoutError);
      expect((e as ScoutError).status).toBe(403);
      expect((e as ScoutError).slug).toBe('forbidden');
      expect((e as ScoutError).detail).toBe("You don't have access to that.");
    }
    try {
      requirePermission(principal({ kind: 'api_key' }), 'accounts:write');
      expect.unreachable();
    } catch (e) {
      expect((e as ScoutError).detail).toBe("This key can't do that. It needs the `accounts:write` scope.");
    }
  });

  it('describeAccess explains a seller in plain words', () => {
    const lines = describeAccess(principal({ dataLimit: { kind: 'own_accounts' } }));
    expect(lines.some((l) => l.includes('accounts assigned to you'))).toBe(true);
    expect(describeAccess(principal({ dataLimit: { kind: 'all' } }))).toContain(
      'You can see every account in this workspace.',
    );
  });
});
