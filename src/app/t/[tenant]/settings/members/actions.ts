'use server';

import {
  addMember,
  changeMember,
  isPermission,
  removeMember,
  setCrmOwnerIds,
  type DataLimit,
  type Role,
} from '@/modules/tenancy';
import { act, str, type ActionResult } from '@/server/action';
import { tenantAction } from '@/server/page-context';

const HUBSPOT = 'hubspot';

const role = (fd: FormData): Role => str(fd, 'role') as Role;

function limitFrom(fd: FormData): DataLimit | null {
  const v = str(fd, 'dataLimit');
  if (v === 'all') return { kind: 'all' };
  if (v === 'own_accounts') return { kind: 'own_accounts' };
  return null; // the role's default
}

function crmIds(fd: FormData): Record<string, string> {
  const id = str(fd, 'hubspotOwnerId');
  return id ? { [HUBSPOT]: id } : {};
}

export async function addMemberAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const email = str(fd, 'email');
  return act(
    () =>
      tenantAction(str(fd, 'tenant'), 'members:manage', (ctx) =>
        addMember(ctx, { email, role: role(fd), crmOwnerIds: crmIds(fd) }),
      ),
    { revalidate: `/t/${str(fd, 'tenant')}/settings/members`, message: `Added ${email}.` },
  );
}

export async function changeMemberAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const membershipId = str(fd, 'membershipId');
  const extraPermissions = fd.getAll('extra').filter((v): v is string => typeof v === 'string' && isPermission(v));
  return act(
    () =>
      tenantAction(str(fd, 'tenant'), 'members:manage', async (ctx) => {
        await changeMember(ctx, membershipId, { role: role(fd), extraPermissions, dataLimit: limitFrom(fd) });
        await setCrmOwnerIds(ctx, membershipId, crmIds(fd));
      }),
    { revalidate: `/t/${str(fd, 'tenant')}/settings/members`, message: 'Saved.' },
  );
}

export async function removeMemberAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const membershipId = str(fd, 'membershipId');
  return act(() => tenantAction(str(fd, 'tenant'), 'members:manage', (ctx) => removeMember(ctx, membershipId)), {
    revalidate: `/t/${str(fd, 'tenant')}/settings/members`,
    message: 'Removed.',
  });
}

