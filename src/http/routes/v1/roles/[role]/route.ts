import { z } from 'zod';
import { ROLES, forgetAccess, setRolePermissions, type Permission, type Role } from '@/modules/tenancy';
import { ScoutError } from '@/platform/errors';
import { parseBody } from '../../_lib/body';
import { idAndAction, notFound } from '../../_lib/path';
import { v1Route } from '../../_lib/v1-route';

const body = z.strictObject({ permissions: z.array(z.string()) });

const roleOf = (req: Request): Role => {
  const { id, action } = idAndAction(req, 'roles');
  if (action) throw notFound();
  if (!(ROLES as readonly string[]).includes(id)) {
    throw new ScoutError({ slug: 'role-not-found', status: 404, title: 'That role was not found.' });
  }
  return id as Role;
};

/**
 * Replaces one role's permissions for this workspace (Decision 17). Owner is locked (409), and you
 * can add or remove only permissions you hold (403). Cached principals are dropped once the save has
 * committed, so the next request on this instance sees the new set.
 */
export const PUT = async (req: Request): Promise<Response> => {
  let tenantId: string | undefined;
  const res = await v1Route({ permission: 'members:manage', peopleOnly: true }, async (r, principal, ctx) => {
    tenantId = principal.tenantId;
    const role = roleOf(r);
    const { permissions } = await parseBody<{ permissions: string[] }>(r, body);
    return setRolePermissions(ctx, principal, role, permissions as Permission[]);
  })(req);
  if (res.ok && tenantId) forgetAccess({ tenantId });
  return res;
};
