import { expect, it } from 'vitest';
import { PERMISSIONS } from '@/modules/tenancy/domain/permissions';
import { PERMISSION_GROUP_NAMES, PERMISSION_LABELS, permissionGroup, permissionLabel } from '@/modules/tenancy/domain/permission-labels';

it('every permission has a plain-words label', () => {
  expect(PERMISSIONS).toHaveLength(35);
  for (const p of PERMISSIONS) {
    const label = permissionLabel(p);
    expect(label, p).toBeTruthy();
    expect(label, p).not.toContain(':');
    expect(label, p).not.toContain('—');
    expect(label, p).not.toContain('_');
  }
  expect(Object.keys(PERMISSION_LABELS).sort()).toEqual([...PERMISSIONS].sort());
});

it('labels are unique', () => {
  const labels = PERMISSIONS.map(permissionLabel);
  expect(new Set(labels).size).toBe(labels.length);
});

it('every permission has a group of the roles matrix', () => {
  expect(PERMISSION_GROUP_NAMES).toEqual(['Accounts', 'Review and sources', 'Offers and playbooks', 'Pipeline and money', 'Workspace']);
  for (const p of PERMISSIONS) expect(PERMISSION_GROUP_NAMES, p).toContain(permissionGroup(p));
});
