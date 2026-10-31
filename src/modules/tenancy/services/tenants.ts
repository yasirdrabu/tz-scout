import { asc, desc, eq, sql } from 'drizzle-orm';
import { platformAudit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { adminDb, adminTransaction } from '@/platform/db/client';
import type { Tx } from '@/platform/db/tenant';
import { ScoutError } from '@/platform/errors';
import type { Actor } from '@/platform/events/envelope';
import { publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { tenantCreated } from '../contracts/events';
import { membership, tenant, user } from '../db/schema';
import { forgetAccess } from './principal';

export type CreateTenantInput = {
  slug: string;
  name: string;
  currency: string;
  timezone: string;
  ownerEmail: string;
};

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const slugTaken = () => new ScoutError({ slug: 'slug-taken', status: 409, title: 'That short name is taken.' });

const isUniqueViolation = (e: unknown): boolean => {
  const err = (e as { code?: string; cause?: { code?: string } } | null) ?? {};
  return err.code === '23505' || err.cause?.code === '23505';
};

/**
 * Creates a tenant with its first owner (status invited). Platform admins only. Runs in one
 * `adminDb` transaction (a savepoint of `outer` when given); the creation is written to the platform
 * audit log, not the tenant's.
 */
export async function createTenant(
  actor: Actor,
  input: CreateTenantInput,
  outer?: Tx,
): Promise<{ tenantId: string; ownerMembershipId: string }> {
  const slug = input.slug.trim().toLowerCase();
  const email = input.ownerEmail.trim().toLowerCase();
  if (!SLUG.test(slug)) {
    throw new ScoutError({
      slug: 'validation',
      status: 400,
      title: 'Check the short name.',
      detail: 'Use lower case letters, numbers and dashes.',
    });
  }
  const correlationId = newId('cor');
  try {
    return await adminTransaction(outer, async (tx) => {
      const [admin] = await tx
        .select({ isAdmin: user.platformAdmin, disabledAt: user.disabledAt })
        .from(user)
        .where(eq(user.id, actor.id));
      if (!admin?.isAdmin || admin.disabledAt) {
        throw new ScoutError({ slug: 'forbidden', status: 403, title: 'Only platform admins can create tenants.' });
      }
      const [taken] = await tx.select({ id: tenant.id }).from(tenant).where(eq(tenant.slug, slug));
      if (taken) throw slugTaken();

      const tenantId = newId('t');
      await tx.insert(tenant).values({
        id: tenantId,
        slug,
        name: input.name.trim(),
        currency: input.currency.trim().toUpperCase(),
        timezone: input.timezone,
      });

      await tx
        .insert(user)
        .values({ id: newId('usr'), name: email.split('@')[0] ?? email, email })
        .onConflictDoNothing({ target: user.email });
      const [owner] = await tx.select({ id: user.id }).from(user).where(eq(user.email, email));

      // The membership and the event belong to the new tenant.
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      const ownerMembershipId = newId('mbr');
      await tx.insert(membership).values({
        id: ownerMembershipId,
        tenantId,
        userId: owner!.id,
        role: 'owner',
        status: 'invited',
        invitedBy: actor.id,
      });
      const ctx: ModuleContext = { tenantId, actor, correlationId, tx };
      await publish(ctx, tenantCreated, { tenantId, slug, createdBy: actor.id }, { type: 'tenant', id: tenantId });
      await platformAudit(
        {
          actor,
          correlationId,
          action: 'tenancy.tenant.created',
          subject: { type: 'tenant', id: tenantId },
          after: { slug, name: input.name, currency: input.currency, timezone: input.timezone, ownerEmail: email },
        },
        tx,
      );
      return { tenantId, ownerMembershipId };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw slugTaken();
    throw e;
  }
}

/** The id, slug, name, currency and timezone of the context's tenant. */
export async function tenantSummary(
  ctx: ModuleContext,
): Promise<{ id: string; slug: string; name: string; currency: string; timezone: string }> {
  const [t] = await ctx.tx
    .select({ id: tenant.id, slug: tenant.slug, name: tenant.name, currency: tenant.currency, timezone: tenant.timezone })
    .from(tenant)
    .where(eq(tenant.id, ctx.tenantId));
  if (!t) throw new ScoutError({ slug: 'not-found', status: 404, title: 'That workspace was not found.' });
  return t;
}

/** The context tenant's IANA timezone, for example `America/New_York`. */
export async function tenantTimezone(ctx: ModuleContext): Promise<string> {
  const [t] = await ctx.tx.select({ timezone: tenant.timezone }).from(tenant).where(eq(tenant.id, ctx.tenantId));
  if (!t) throw new ScoutError({ slug: 'not-found', status: 404, title: 'That workspace was not found.' });
  return t.timezone;
}

export type TenantRow = { id: string; slug: string; name: string; currency: string; timezone: string; status: string };

/** Every tenant, newest last. Platform-wide, so it uses `adminDb`; callers must be platform admins. */
export async function listTenants(tx?: Tx): Promise<TenantRow[]> {
  return (tx ?? adminDb)
    .select({
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      currency: tenant.currency,
      timezone: tenant.timezone,
      status: tenant.status,
    })
    .from(tenant)
    .orderBy(asc(tenant.name));
}

/** Makes (or finds) a platform admin by email. For seeding local data. Returns the user id. */
export async function ensurePlatformAdmin(email: string): Promise<string> {
  const e = email.trim().toLowerCase();
  await adminDb
    .insert(user)
    .values({ id: newId('usr'), name: e.split('@')[0] ?? e, email: e, platformAdmin: true })
    .onConflictDoUpdate({ target: user.email, set: { platformAdmin: true } });
  const [u] = await adminDb.select({ id: user.id }).from(user).where(eq(user.email, e));
  return u!.id;
}

/** The user id for an email, or null. */
export async function userIdForEmail(email: string): Promise<string | null> {
  const [u] = await adminDb
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email.trim().toLowerCase()));
  return u?.id ?? null;
}

export type AdminTenantRow = TenantRow & {
  createdAt: Date;
  /** Invited and active members, as the Members screen counts them. */
  memberCount: number;
  /** The first owner by invite date, or null. */
  owner: { name: string; email: string } | null;
};

/** Every tenant for the admin Tenants screen, newest first, with member count and owner. Platform admins only. */
export async function adminTenants(tx?: Tx): Promise<AdminTenantRow[]> {
  const counted = sql<number>`(select count(*)::int from ${membership} m where m.tenant_id = tenancy.tenant.id and m.status in ('invited', 'active'))`;
  const owner = sql<{ name: string; email: string } | null>`(
    select json_build_object('name', u.name, 'email', u.email) from ${membership} m join ${user} u on u.id = m.user_id
    where m.tenant_id = tenancy.tenant.id and m.role = 'owner' and m.status in ('invited', 'active')
    order by m.created_at, m.id limit 1)`;
  return (tx ?? adminDb)
    .select({
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      currency: tenant.currency,
      timezone: tenant.timezone,
      status: tenant.status,
      createdAt: tenant.createdAt,
      memberCount: counted,
      owner,
    })
    .from(tenant)
    .orderBy(desc(tenant.createdAt), desc(tenant.id));
}

/** A platform admin acting outside any tenant: who, the request's correlation id and its `adminDb` transaction, to work in. */
export type AdminActor = { actor: Actor; correlationId: string; tx?: Tx };

/**
 * Suspends or resumes a tenant. While suspended nobody in it can sign in to it and its API keys are
 * refused (`sessionPrincipal`, `authenticateKey`, `checkSignIn` already read the status). Written to
 * the platform audit log; this instance's cached principals are dropped after the commit.
 * 404 for an unknown tenant, 409 when it is already in that state.
 */
export async function setTenantStatus(by: AdminActor, tenantId: string, status: 'active' | 'suspended'): Promise<void> {
  await adminTransaction(by.tx, async (tx) => {
    const [t] = await tx.select({ status: tenant.status, slug: tenant.slug }).from(tenant).where(eq(tenant.id, tenantId)).for('update');
    if (!t) throw new ScoutError({ slug: 'not-found', status: 404, title: 'That tenant was not found.' });
    if (t.status === status) {
      throw status === 'suspended'
        ? new ScoutError({ slug: 'not-active', status: 409, title: 'That tenant is already suspended.' })
        : new ScoutError({ slug: 'not-suspended', status: 409, title: 'That tenant is not suspended.' });
    }
    await tx.update(tenant).set({ status }).where(eq(tenant.id, tenantId));
    await platformAudit(
      {
        actor: by.actor,
        correlationId: by.correlationId,
        action: status === 'suspended' ? 'tenancy.tenant.suspended' : 'tenancy.tenant.resumed',
        subject: { type: 'tenant', id: tenantId },
        before: { status: t.status },
        after: { status, slug: t.slug },
      },
      tx,
    );
  });
  forgetAccess({ tenantId });
}
