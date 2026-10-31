import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { adminDb } from '@/platform/db/client';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { memberAdded, memberRemoved, memberRoleChanged } from '../contracts/events';
import { ROLES, CRM_OWNER_TAKEN, type DataLimit, type Member, type MembershipStatus, type Role } from '../contracts/members';
import { DataLimitSchema } from '../domain/data-limit';
import { memberActionRefusal, type MemberAction } from '../domain/member-rules';
import { PERMISSIONS, isPermission, permissionsFor, type Permission } from '../domain/permissions';
import { membership, tenant, user } from '../db/schema';
import { endSessions, signInFacts, type SignInMethod } from './sessions';

const LAST_OWNER = 'A tenant needs at least one owner.';
const notFound = () => new ScoutError({ slug: 'not-found', status: 404, title: 'That member was not found.' });
const lastOwner = () => new ScoutError({ slug: 'last-owner', status: 409, title: LAST_OWNER });
const invalidRole = () => new ScoutError({ slug: 'invalid-role', status: 400, title: 'That role does not exist.' });
const invalidPermission = () =>
  new ScoutError({ slug: 'invalid-permission', status: 400, title: 'That permission does not exist.' });
const crmTaken = () => new ScoutError({ slug: 'crm-owner-taken', status: 409, title: CRM_OWNER_TAKEN });

const SELF: Record<MemberAction, string> = {
  change_role: "You can't change your own role.",
  change_permissions: "You can't change your own permissions.",
  suspend: "You can't suspend yourself.",
  remove: "You can't remove yourself.",
};

/** Throws when the member rules refuse `action` on `m` by the context's actor. */
function assertAllowed(ctx: ModuleContext, action: MemberAction, m: typeof membership.$inferSelect): void {
  const target = { userId: m.userId, role: m.role as Role, status: m.status as MembershipStatus };
  const refusal = memberActionRefusal(action, ctx.actor.id, target);
  if (refusal === 'self') throw new ScoutError({ slug: 'not-yourself', status: 403, title: SELF[action] });
  if (refusal === 'owner') {
    throw new ScoutError({
      slug: 'owner-protected',
      status: 409,
      title: "Owners can't be suspended or removed. Change their role first.",
    });
  }
}

/** What the actor may hand out: owners and platform admins (and the platform itself) may make owners. */
type Powers = { makesOwners: boolean; permissions: readonly Permission[] };

/** The actor's own powers in this tenant, read fresh: nobody grants more than they hold. */
async function actorPowers(ctx: ModuleContext): Promise<Powers> {
  if (ctx.actor.kind === 'system') return { makesOwners: true, permissions: PERMISSIONS };
  if (ctx.actor.kind !== 'user') return { makesOwners: false, permissions: [] };
  const [u] = await ctx.tx.select({ platformAdmin: user.platformAdmin }).from(user).where(eq(user.id, ctx.actor.id));
  if (u?.platformAdmin) return { makesOwners: true, permissions: PERMISSIONS };
  const [m] = await ctx.tx
    .select({ role: membership.role, extra: membership.extraPermissions })
    .from(membership)
    .where(and(eq(membership.tenantId, ctx.tenantId), eq(membership.userId, ctx.actor.id), eq(membership.status, 'active')));
  if (!m) return { makesOwners: false, permissions: [] };
  const role = m.role as Role;
  return { makesOwners: role === 'owner', permissions: permissionsFor(role, (m.extra ?? []).filter(isPermission), false) };
}

const ownersOnly = () =>
  new ScoutError({
    slug: 'owners-only',
    status: 403,
    title: "Only an owner can make someone an owner or change an owner's role.",
  });

function assertGrantable(powers: Powers, perms: readonly Permission[]): void {
  const missing = perms.find((p) => !powers.permissions.includes(p));
  if (missing) {
    throw new ScoutError({
      slug: 'permission-not-yours',
      status: 403,
      title: 'Not available to you',
      detail: `You can't give the \`${missing}\` permission because you don't have it.`,
    });
  }
}

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
  if (input.role === 'owner' && !(await actorPowers(ctx)).makesOwners) throw ownersOnly();
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

/**
 * Removes a member (history stays); `tenancy.member.removed` sends their open accounts back to the
 * review queue. The last active owner, any other active owner and yourself cannot be removed.
 */
export async function removeMember(ctx: ModuleContext, membershipId: string): Promise<void> {
  await lockTenant(ctx, 'owners');
  const m = await load(ctx, membershipId);
  assertAllowed(ctx, 'remove', m);
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

/** Changes role, extra permissions and/or data limit. The last active owner cannot be demoted; nobody changes their own role. */
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
  const roleChanges = change.role !== undefined && change.role !== m.role;
  const current = new Set<string>(m.extraPermissions ?? []);
  const added = (change.extraPermissions ?? []).filter((p) => !current.has(p)) as Permission[];
  const extrasChange =
    change.extraPermissions !== undefined && (added.length > 0 || new Set(change.extraPermissions).size !== current.size);
  if (roleChanges) assertAllowed(ctx, 'change_role', m);
  if (extrasChange) assertAllowed(ctx, 'change_permissions', m);
  if ((roleChanges && (change.role === 'owner' || m.role === 'owner')) || added.length > 0) {
    const powers = await actorPowers(ctx);
    if (roleChanges && (change.role === 'owner' || m.role === 'owner') && !powers.makesOwners) throw ownersOnly();
    assertGrantable(powers, added);
  }
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

/** Sets one CRM's owner id on a membership and leaves the other CRMs' ids as they are. */
export async function setCrmOwnerId(ctx: ModuleContext, membershipId: string, crm: string, ownerId: string): Promise<void> {
  const clean = cleanCrmIds({ [crm]: ownerId });
  await lockTenant(ctx, 'crm');
  const m = await load(ctx, membershipId);
  await assertCrmIdsFree(ctx, clean, membershipId);
  const merged = { ...(m.crmOwnerIds ?? {}), ...clean };
  await ctx.tx
    .update(membership)
    .set({ crmOwnerIds: sql`coalesce(${membership.crmOwnerIds}, '{}'::jsonb) || ${JSON.stringify(clean)}::jsonb`, updatedAt: new Date() })
    .where(eq(membership.id, membershipId));
  await audit(ctx, {
    action: 'tenancy.member.crm_owner_ids_changed',
    subject: { type: 'membership', id: membershipId },
    before: { crmOwnerIds: m.crmOwnerIds },
    after: { crmOwnerIds: merged },
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

/** The user's role in this tenant (invited or active membership), or null. */
export async function memberRole(ctx: ModuleContext, userId: string): Promise<Role | null> {
  const [row] = await ctx.tx
    .select({ role: membership.role })
    .from(membership)
    .where(
      and(
        eq(membership.tenantId, ctx.tenantId),
        eq(membership.userId, userId),
        inArray(membership.status, ['invited', 'active']),
      ),
    );
  return (row?.role as Role | undefined) ?? null;
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

/**
 * Active tenants where the user has an active membership; nothing for a disabled user. Platform-wide
 * lookup, so it uses `adminDb`.
 */
export async function tenantsFor(userId: string): Promise<{ id: string; slug: string; name: string }[]> {
  return adminDb
    .select({ id: tenant.id, slug: tenant.slug, name: tenant.name })
    .from(membership)
    .innerJoin(tenant, eq(tenant.id, membership.tenantId))
    .innerJoin(user, eq(user.id, membership.userId))
    .where(
      and(
        eq(membership.userId, userId),
        eq(membership.status, 'active'),
        eq(tenant.status, 'active'),
        isNull(user.disabledAt),
      ),
    )
    .orderBy(asc(tenant.name));
}

export type MemberAccess = {
  crmOwnerIds: Record<string, string>;
  extraPermissions: Permission[];
  /** null means the role's default limit. */
  dataLimit: DataLimit | null;
};

/** CRM owner ids, extra permissions and data limit per membership id, for the members screen. */
export async function memberAccess(ctx: ModuleContext): Promise<Record<string, MemberAccess>> {
  const rows = await ctx.tx
    .select({
      id: membership.id,
      crm: membership.crmOwnerIds,
      extra: membership.extraPermissions,
      dataLimit: membership.dataLimit,
    })
    .from(membership)
    .where(and(eq(membership.tenantId, ctx.tenantId), inArray(membership.status, ['invited', 'active'])));
  const out: Record<string, MemberAccess> = {};
  for (const r of rows) {
    const parsed = r.dataLimit === null ? null : DataLimitSchema.safeParse(r.dataLimit);
    out[r.id] = {
      crmOwnerIds: (r.crm ?? {}) as Record<string, string>,
      extraPermissions: (r.extra ?? []).filter(isPermission),
      dataLimit: parsed && parsed.success ? parsed.data : null,
    };
  }
  return out;
}

/** One row of the Members screen (§21a). */
export type MemberRow = {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: Role;
  status: Exclude<MembershipStatus, 'removed'>;
  lastActiveAt: Date | null;
  signInMethod: SignInMethod;
  /** null means the role's default limit. */
  dataLimit: DataLimit | null;
  crmOwnerIds: Record<string, string>;
  extraPermissions: Permission[];
};

/** Invited, active and suspended members by name, with sign-in facts; or just `membershipId` (404 when not one). */
export async function memberList(ctx: ModuleContext, membershipId?: string): Promise<MemberRow[]> {
  const rows = await ctx.tx
    .select({ m: membership, name: user.name, email: user.email })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(
      and(
        eq(membership.tenantId, ctx.tenantId),
        inArray(membership.status, ['invited', 'active', 'suspended']),
        membershipId ? eq(membership.id, membershipId) : undefined,
      ),
    )
    .orderBy(asc(user.name), asc(user.email));
  if (membershipId && rows.length === 0) throw notFound();
  const facts = await signInFacts(ctx.tx, rows.map((r) => r.m.userId));
  return rows.map(({ m, name, email }) => {
    const limit = m.dataLimit === null ? null : DataLimitSchema.safeParse(m.dataLimit);
    const f = facts.get(m.userId);
    return {
      id: m.id,
      userId: m.userId,
      name,
      email,
      role: m.role as Role,
      status: m.status as MemberRow['status'],
      lastActiveAt: f?.lastActiveAt ?? null,
      signInMethod: f?.signInMethod ?? null,
      dataLimit: limit && limit.success ? limit.data : null,
      crmOwnerIds: (m.crmOwnerIds ?? {}) as Record<string, string>,
      extraPermissions: (m.extraPermissions ?? []).filter(isPermission),
    };
  });
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type InviteResult =
  | { email: string; ok: true; membershipId: string; status: 'invited' | 'active' }
  | { email: string; ok: false; error: { slug: string; title: string } };

/**
 * Invites each address with the role and practice access (R1, Decision 18: a membership row, no
 * email; they get in the first time they sign in). One address failing does not stop the others.
 */
export async function inviteMembers(
  ctx: ModuleContext,
  input: { emails: string[]; role: Role; dataLimit?: DataLimit | null },
): Promise<InviteResult[]> {
  assertRole(input.role);
  // Checked once for the whole request; addMember checks it again per address.
  if (input.role === 'owner' && !(await actorPowers(ctx)).makesOwners) throw ownersOnly();
  if (input.dataLimit && !DataLimitSchema.safeParse(input.dataLimit).success) {
    throw new ScoutError({ slug: 'validation', status: 400, title: 'Check the data limit.' });
  }
  const emails = [...new Set(input.emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const out: InviteResult[] = [];
  for (const email of emails) {
    if (!EMAIL.test(email)) {
      out.push({ email, ok: false, error: { slug: 'invalid-email', title: 'That is not an email address.' } });
      continue;
    }
    try {
      // A savepoint, so one refused address leaves the others' work in place.
      const id = await ctx.tx.transaction(async (sp) => {
        const c = { ...ctx, tx: sp };
        const added = await addMember(c, { email, role: input.role });
        if (input.dataLimit) await changeMember(c, added, { dataLimit: input.dataLimit });
        return added;
      });
      const [m] = await ctx.tx.select({ status: membership.status }).from(membership).where(eq(membership.id, id));
      out.push({ email, ok: true, membershipId: id, status: m!.status as 'invited' | 'active' });
    } catch (e) {
      if (!(e instanceof ScoutError)) throw e;
      out.push({ email, ok: false, error: { slug: e.slug, title: e.slug === 'already-member' ? 'Already a member' : e.message } });
    }
  }
  return out;
}

async function setStatus(
  ctx: ModuleContext,
  membershipId: string,
  from: 'active' | 'suspended',
  to: 'active' | 'suspended',
): Promise<void> {
  await lockTenant(ctx, 'owners');
  const m = await load(ctx, membershipId);
  if (to === 'suspended') assertAllowed(ctx, 'suspend', m);
  if (m.status !== from) {
    throw new ScoutError({
      slug: to === 'suspended' ? 'not-active' : 'not-suspended',
      status: 409,
      title: to === 'suspended' ? 'Only active members can be suspended.' : 'That member is not suspended.',
    });
  }
  await ctx.tx.update(membership).set({ status: to, updatedAt: new Date() }).where(eq(membership.id, membershipId));
  await audit(ctx, {
    action: to === 'suspended' ? 'tenancy.member.suspended' : 'tenancy.member.reactivated',
    subject: { type: 'membership', id: membershipId },
    before: { status: from },
    after: { status: to },
  });
}

/**
 * Suspends an active member: they keep their membership but cannot use this workspace (sign-in and
 * every request refuse a suspended membership) until reactivated. Owners and yourself cannot be
 * suspended. Takes effect within the 60-second principal cache.
 */
export async function suspendMember(ctx: ModuleContext, membershipId: string): Promise<void> {
  await setStatus(ctx, membershipId, 'active', 'suspended');
}

export async function reactivateMember(ctx: ModuleContext, membershipId: string): Promise<void> {
  await setStatus(ctx, membershipId, 'suspended', 'active');
}

/** Ends every session of the member's person: on every device and in every workspace. */
export async function signOutMemberEverywhere(ctx: ModuleContext, membershipId: string): Promise<void> {
  const m = await load(ctx, membershipId);
  const ended = await endSessions(ctx.tx, m.userId);
  await audit(ctx, {
    action: 'tenancy.member.signed_out_everywhere',
    subject: { type: 'membership', id: membershipId },
    after: { userId: m.userId, sessionsEnded: ended },
  });
}
