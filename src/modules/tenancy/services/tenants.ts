import { asc, eq, sql } from 'drizzle-orm';
import { platformAudit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { adminDb } from '@/platform/db/client';
import { ScoutError } from '@/platform/errors';
import type { Actor } from '@/platform/events/envelope';
import { publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { tenantCreated } from '../contracts/events';
import { membership, tenant, user } from '../db/schema';

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
 * `adminDb` transaction; the creation is written to the platform audit log, not the tenant's.
 */
export async function createTenant(
  actor: Actor,
  input: CreateTenantInput,
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
    return await adminDb.transaction(async (tx) => {
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

/** The id, slug and name of the context's tenant. */
export async function tenantSummary(ctx: ModuleContext): Promise<{ id: string; slug: string; name: string }> {
  const [t] = await ctx.tx
    .select({ id: tenant.id, slug: tenant.slug, name: tenant.name })
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
export async function listTenants(): Promise<TenantRow[]> {
  return adminDb
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
