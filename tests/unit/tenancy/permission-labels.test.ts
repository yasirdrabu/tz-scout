import { expect, it } from 'vitest';
import { PERMISSIONS } from '@/modules/tenancy/domain/permissions';
import { PERMISSION_LABELS, permissionLabel } from '@/modules/tenancy/domain/permission-labels';

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
