import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { adminDb } from '@/platform/db/client';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { memberAdded, memberRemoved, memberRoleChanged } from '../contracts/events';
import { ROLES, CRM_OWNER_TAKEN, type DataLimit, type Member, type Role } from '../contracts/members';
import { DataLimitSchema } from '../domain/data-limit';
import { isPermission, permissionsFor, type Permission } from '../domain/permissions';
import { membership, tenant, user } from '../db/schema';

const LAST_OWNER = 'A tenant needs at least one owner.';
const notFound = () => new ScoutError({ slug: 'not-found', status: 404, title: 'That member was not found.' });
const lastOwner = () => new ScoutError({ slug: 'last-owner', status: 409, title: LAST_OWNER });
const invalidRole = () => new ScoutError({ slug: 'invalid-role', status: 400, title: 'That role does not exist.' });
const invalidPermission = () =>
  new ScoutError({ slug: 'invalid-permission', status: 400, title: 'That permission does not exist.' });
const crmTaken = () => new ScoutError({ slug: 'crm-owner-taken', status: 409, title: CRM_OWNER_TAKEN });

function assertRole(role: unknown): asserts role is Role {
  if (typeof role !== 'string' || !(ROLES as readonly string[]).includes(role)) throw invalidRole();
}

function assertPermissions(perms: unknown): asserts perms is Permission[] {
  if (!Array.isArray(perms) || !perms.every(isPermission)) throw invalidPermission();
}

/** Serialises changes that must see each other: owner counts and CRM owner ids, per tenant. */
async function lockTenant(ctx: ModuleContext, what: 'owners' | 'crm'): Promise<void> {
  await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${what}:${ctx.tenantId}`}))`);
}

async function load(ctx: ModuleContext, membershipId: string) {
  const [m] = await ctx.tx
    .select()
    .from(membership)
    .where(
      and(eq(membership.id, membershipId), eq(membership.tenantId, ctx.tenantId), ne(membership.status, 'removed')),
    );
  if (!m) throw notFound();
  return m;
}

/** Refuses when `ids` holds a CRM owner id that another live membership in this tenant already holds. */
async function assertCrmIdsFree(ctx: ModuleContext, ids: Record<string, string>, selfId?: string): Promise<void> {
  for (const [crm, ownerId] of Object.entries(ids)) {
    const rows = await ctx.tx
      .select({ id: membership.id })
      .from(membership)
      .where(
        and(
          eq(membership.tenantId, ctx.tenantId),
          ne(membership.status, 'removed'),
          sql`${membership.crmOwnerIds} ->> ${crm} = ${ownerId}`,
          selfId ? ne(membership.id, selfId) : undefined,
        ),
      );
    if (rows.length > 0) throw crmTaken();
  }
}

function cleanCrmIds(ids: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [crm, id] of Object.entries(ids)) {
    const v = typeof id === 'string' ? id.trim() : '';
    if (!crm.trim() || !v) {
      throw new ScoutError({ slug: 'validation', status: 400, title: 'Check the CRM user ids.' });
    }
    out[crm.trim()] = v;
  }
  return out;
}

/** True when `m` is an active owner and no other active owner exists. Call after `lockTenant(ctx, 'owners')`. */
async function isLastActiveOwner(ctx: ModuleContext, m: typeof membership.$inferSelect): Promise<boolean> {
  if (m.role !== 'owner' || m.status !== 'active') return false;
  const others = await ctx.tx
    .select({ id: membership.id })
    .from(membership)
    .where(
      and(
        eq(membership.tenantId, ctx.tenantId),
        eq(membership.role, 'owner'),
        eq(membership.status, 'active'),
        ne(membership.id, m.id),
      ),
    )
    .limit(1);
  return others.length === 0;
}

/**
 * Adds a person to the tenant. Status is `invited` until they have signed in once, else `active`.
 * A removed member is brought back on the same membership row. Returns the membership id.
 */
export async function addMember(
  ctx: ModuleContext,
  input: { email: string; role: Role; crmOwnerIds?: Record<string, string> },
): Promise<string> {
  assertRole(input.role);
  const email = input.email.trim().toLowerCase();
  const crmIds = cleanCrmIds(input.crmOwnerIds ?? {});
  await lockTenant(ctx, 'crm');

  await ctx.tx
    .insert(user)
    .values({ id: newId('usr'), name: email.split('@')[0] ?? email, email })
    .onConflictDoNothing({ target: user.email });
  const [u] = await ctx.tx.select().from(user).where(eq(user.email, email));
  const status = u!.lastSignInAt ? 'active' : 'invited';

  const [existing] = await ctx.tx
    .select()
    .from(membership)
    .where(and(eq(membership.tenantId, ctx.tenantId), eq(membership.userId, u!.id)));
  if (existing && existing.status !== 'removed') {
    throw new ScoutError({ slug: 'already-member', status: 409, title: 'That person is already a member.' });
  }
  await assertCrmIdsFree(ctx, crmIds, existing?.id);

  let id: string;
  if (existing) {
    id = existing.id;
    await ctx.tx
      .update(membership)
      .set({
        role: input.role,
        status,
        crmOwnerIds: crmIds,
        extraPermissions: [],
        dataLimit: null,
        invitedBy: ctx.actor.id,
        updatedAt: new Date(),
      })
      .where(eq(membership.id, id));
  } else {
    id = newId('mbr');
    await ctx.tx.insert(membership).values({
      id,
      tenantId: ctx.tenantId,
      userId: u!.id,
      role: input.role,
      status,
      crmOwnerIds: crmIds,
      invitedBy: ctx.actor.id,
    });
  }
  const subject = { type: 'membership', id };
  await publish(ctx, memberAdded, { userId: u!.id, role: input.role, invitedBy: ctx.actor.id }, subject);
  await audit(ctx, {
    action: 'tenancy.member.added',
    subject,
    after: { userId: u!.id, email, role: input.role, status, crmOwnerIds: crmIds },
  });
  return id;
}

/** Removes a member (history stays). The last active owner cannot be removed. */
export async function removeMember(ctx: ModuleContext, membershipId: string): Promise<void> {
  await lockTenant(ctx, 'owners');
  const m = await load(ctx, membershipId);
  if (await isLastActiveOwner(ctx, m)) throw lastOwner();
  await ctx.tx
    .update(membership)
    .set({ status: 'removed', updatedAt: new Date() })
    .where(eq(membership.id, membershipId));
  const subject = { type: 'membership', id: membershipId };
  await publish(ctx, memberRemoved, { userId: m.userId, removedBy: ctx.actor.id }, subject);
  await audit(ctx, {
    action: 'tenancy.member.removed',
    subject,
    before: { userId: m.userId, role: m.role, status: m.status },
    after: { status: 'removed' },
  });
}

/** Changes role, extra permissions and/or data limit. The last active owner cannot be demoted. */
export async function changeMember(
  ctx: ModuleContext,
  membershipId: string,
  change: { role?: Role; extraPermissions?: string[]; dataLimit?: DataLimit | null },
): Promise<void> {
  if (change.role !== undefined) assertRole(change.role);
  if (change.extraPermissions !== undefined) assertPermissions(change.extraPermissions);
  if (change.dataLimit !== undefined && change.dataLimit !== null) {
    const parsed = DataLimitSchema.safeParse(change.dataLimit);
    if (!parsed.success) {
      throw new ScoutError({
        slug: 'validation',
        status: 400,
        title: 'Check the data limit.',
        errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
  }
  await lockTenant(ctx, 'owners');
  const m = await load(ctx, membershipId);
  if (change.role && change.role !== 'owner' && (await isLastActiveOwner(ctx, m))) throw lastOwner();

  const set: Partial<typeof membership.$inferInsert> = { updatedAt: new Date() };
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  if (change.role !== undefined) {
    set.role = change.role;
    before.role = m.role;
    after.role = change.role;
  }
  if (change.extraPermissions !== undefined) {
    set.extraPermissions = change.extraPermissions;
    before.extraPermissions = m.extraPermissions;
    after.extraPermissions = change.extraPermissions;
  }
  if (change.dataLimit !== undefined) {
    set.dataLimit = change.dataLimit;
    before.dataLimit = m.dataLimit;
    after.dataLimit = change.dataLimit;
  }
  await ctx.tx.update(membership).set(set).where(eq(membership.id, membershipId));
  const subject = { type: 'membership', id: membershipId };
  if (change.role !== undefined && change.role !== m.role) {
    await publish(ctx, memberRoleChanged, { userId: m.userId, from: m.role, to: change.role }, subject);
  }
  await audit(ctx, { action: 'tenancy.member.changed', subject, before, after });
}

/** Replaces the CRM owner ids of a membership, e.g. `{ hubspot: '123' }`. */
export async function setCrmOwnerIds(
  ctx: ModuleContext,
  membershipId: string,
  ids: Record<string, string>,
): Promise<void> {
  const clean = cleanCrmIds(ids);
  await lockTenant(ctx, 'crm');
  const m = await load(ctx, membershipId);
  await assertCrmIdsFree(ctx, clean, membershipId);
  await ctx.tx
    .update(membership)
    .set({ crmOwnerIds: clean, updatedAt: new Date() })
    .where(eq(membership.id, membershipId));
  await audit(ctx, {
    action: 'tenancy.member.crm_owner_ids_changed',
    subject: { type: 'membership', id: membershipId },
    before: { crmOwnerIds: m.crmOwnerIds },
    after: { crmOwnerIds: clean },
  });
}

/** The user's id in `crm` (for example the HubSpot owner id), or null. */
export async function crmOwnerId(ctx: ModuleContext, userId: string, crm: string): Promise<string | null> {
  const [row] = await ctx.tx
    .select({ id: sql<string | null>`${membership.crmOwnerIds} ->> ${crm}` })
    .from(membership)
    .where(
      and(
        eq(membership.tenantId, ctx.tenantId),
        eq(membership.userId, userId),
        inArray(membership.status, ['invited', 'active']),
      ),
    );
  return row?.id ?? null;
}

/** Reverse lookup: the user whose live (active or invited) membership holds this CRM owner id. */
export async function userForCrmOwner(ctx: ModuleContext, crm: string, ownerId: string): Promise<string | null> {
  const [row] = await ctx.tx
    .select({ userId: membership.userId })
    .from(membership)
    .where(
      and(
        eq(membership.tenantId, ctx.tenantId),
        inArray(membership.status, ['invited', 'active']),
        sql`${membership.crmOwnerIds} ->> ${crm} = ${ownerId}`,
      ),
    )
    .limit(1);
  return row?.userId ?? null;
}

/**
 * People in the tenant (invited and active). `roles` narrows by role; `permission` keeps only people
 * whose effective permissions (role defaults plus extras) include it.
 */
export async function members(
  ctx: ModuleContext,
  opts: { permission?: Permission; roles?: Role[] } = {},
): Promise<Member[]> {
  const rows = await ctx.tx
    .select({
      membershipId: membership.id,
      userId: membership.userId,
      name: user.name,
      email: user.email,
      role: membership.role,
      status: membership.status,
      extra: membership.extraPermissions,
    })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(
      and(
        eq(membership.tenantId, ctx.tenantId),
        inArray(membership.status, ['invited', 'active']),
        opts.roles?.length ? inArray(membership.role, opts.roles) : undefined,
      ),
    )
    .orderBy(asc(user.name), asc(user.email));
  const out: Member[] = rows.map(({ extra, ...r }) => {
    const role = r.role as Role;
    const extras = (extra ?? []).filter(isPermission);
    return { ...r, role, status: r.status as Member['status'], permissions: permissionsFor(role, extras, false) };
  });
  const wanted = opts.permission;
  return wanted ? out.filter((m) => m.permissions.includes(wanted)) : out;
}

/** Tenants where the user has an active membership. Platform-wide lookup, so it uses `adminDb`. */
export async function tenantsFor(userId: string): Promise<{ id: string; slug: string; name: string }[]> {
  return adminDb
    .select({ id: tenant.id, slug: tenant.slug, name: tenant.name })
    .from(membership)
    .innerJoin(tenant, eq(tenant.id, membership.tenantId))
    .where(and(eq(membership.userId, userId), eq(membership.status, 'active')))
    .orderBy(asc(tenant.name));
}
