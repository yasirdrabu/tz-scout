import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { adminDb } from '@/platform/db/client';
import { ScoutError } from '@/platform/errors';
import type { Role } from '../contracts/members';
import { membership, tenant, user } from '../db/schema';

export type Workspace = { id: string; slug: string; name: string; role: Role | null; memberCount: number };

/**
 * The workspaces a person can switch to, by name: active tenants where they hold an active
 * membership, or every active tenant for a platform admin. `role` is their own (null when an
 * admin is not a member); `memberCount` counts invited and active members. Platform-wide, so it
 * uses `adminDb`.
 */
export async function workspacesFor(userId: string, platformAdmin: boolean): Promise<Workspace[]> {
  const mine = and(eq(membership.tenantId, tenant.id), eq(membership.userId, userId), eq(membership.status, 'active'));
  const base = adminDb.select({ id: tenant.id, slug: tenant.slug, name: tenant.name, role: membership.role }).from(tenant);
  const rows = await (platformAdmin ? base.leftJoin(membership, mine) : base.innerJoin(membership, mine))
    .where(eq(tenant.status, 'active'))
    .orderBy(asc(tenant.name), asc(tenant.slug));
  if (rows.length === 0) return [];
  const counts = await adminDb
    .select({ tenantId: membership.tenantId, n: count() })
    .from(membership)
    .where(and(inArray(membership.tenantId, rows.map((r) => r.id)), inArray(membership.status, ['invited', 'active'])))
    .groupBy(membership.tenantId);
  const n = new Map(counts.map((c) => [c.tenantId, c.n]));
  return rows.map((r) => ({ ...r, role: (r.role as Role | null) ?? null, memberCount: n.get(r.id) ?? 0 }));
}

/** Who a user is, for `/me`: id, name, email and the platform admin flag, or null. */
export async function personSummary(
  userId: string,
): Promise<{ id: string; name: string; email: string; platformAdmin: boolean } | null> {
  const [u] = await adminDb
    .select({ id: user.id, name: user.name, email: user.email, platformAdmin: user.platformAdmin })
    .from(user)
    .where(eq(user.id, userId));
  return u ?? null;
}

/**
 * Makes `slug` the person's last used workspace (`user.last_tenant_id`), where sign-in and `/me`
 * land next time. 404 unless it is one of `workspacesFor` the person.
 */
export async function setLastWorkspace(userId: string, platformAdmin: boolean, slug: string): Promise<void> {
  const target = (await workspacesFor(userId, platformAdmin)).find((w) => w.slug === slug);
  if (!target) throw new ScoutError({ slug: 'not-found', status: 404, title: 'That workspace was not found.' });
  await adminDb.update(user).set({ lastTenantId: target.id, updatedAt: new Date() }).where(eq(user.id, userId));
}
