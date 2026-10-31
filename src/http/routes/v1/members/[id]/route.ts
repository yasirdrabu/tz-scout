import { z } from 'zod';
import { openAssignmentCounts } from '@/modules/routing';
import {
  DataLimitSchema,
  ROLES,
  changeMember,
  memberList,
  reactivateMember,
  removeMember,
  setCrmOwnerIds,
  signOutMemberEverywhere,
  suspendMember,
  type DataLimit,
  type Role,
} from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { parseBody } from '../../_lib/body';
import { idAndAction, notFound } from '../../_lib/path';
import { byAction, noContent, v1Route } from '../../_lib/v1-route';

const MANAGE = { permission: 'members:manage', peopleOnly: true } as const;

/** The member as `GET /v1/members` lists them. */
async function view(ctx: ModuleContext, id: string) {
  const [m] = await memberList(ctx, id);
  return { ...m!, openAccountCount: (await openAssignmentCounts(ctx))[m!.userId] ?? 0 };
}

const memberId = (req: Request) => {
  const { id, action } = idAndAction(req, 'members');
  if (action) throw notFound();
  return id;
};

const patchBody = z
  .strictObject({
    role: z.enum(ROLES),
    data_limit: DataLimitSchema.nullable(),
    extra_permissions: z.array(z.string()),
    crm_owner_ids: z.record(z.string(), z.string()),
  })
  .partial();

type Patch = { role?: Role; dataLimit?: DataLimit | null; extraPermissions?: string[]; crmOwnerIds?: Record<string, string> };

/** Role, practice access (`data_limit`, null for the role default), extra permissions and CRM user ids. Nobody changes their own role. */
export const PATCH = v1Route(MANAGE, async (req, _principal, ctx) => {
  const id = memberId(req);
  const { crmOwnerIds, ...change } = await parseBody<Patch>(req, patchBody);
  if (Object.keys(change).length > 0) await changeMember(ctx, id, change);
  if (crmOwnerIds) await setCrmOwnerIds(ctx, id, crmOwnerIds);
  return view(ctx, id);
});

/** Removes the member; their open accounts go back to the review queue. Owners and yourself cannot be removed. */
export const DELETE = v1Route(MANAGE, async (req, _principal, ctx) => {
  await removeMember(ctx, memberId(req));
  return noContent();
});

// POST /v1/members/{id}:suspend, :reactivate and :sign-out-everywhere
export const POST = byAction('members', {
  suspend: v1Route(MANAGE, async (req, _principal, ctx) => {
    const { id } = idAndAction(req, 'members');
    await suspendMember(ctx, id);
    return view(ctx, id);
  }),
  reactivate: v1Route(MANAGE, async (req, _principal, ctx) => {
    const { id } = idAndAction(req, 'members');
    await reactivateMember(ctx, id);
    return view(ctx, id);
  }),
  // Sessions are platform-wide: this signs them out of every workspace on every device.
  'sign-out-everywhere': v1Route(MANAGE, async (req, _principal, ctx) => {
    await signOutMemberEverywhere(ctx, idAndAction(req, 'members').id);
    return noContent();
  }),
});
