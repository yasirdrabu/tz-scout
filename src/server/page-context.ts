import '@/entry/compose';
import { cache } from 'react';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { sourceAccessProvider } from '@/modules/accounts';
import { accessWithSources } from '@/platform/access';
import { withTenant } from '@/platform/db/tenant';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { newId } from '@/platform/ids';
import {
  actorFor,
  can as canDo,
  listTenants,
  requirePermission,
  sessionPrincipal,
  sessionUser,
  tenantsFor,
  type Permission,
  type Principal,
  type SessionUser,
} from '@/modules/tenancy';

export type TenantRef = { id: string; slug: string; name: string };

export type PageContext = {
  principal: Principal;
  user: SessionUser;
  tenant: TenantRef;
  /** Tenants the switcher offers: memberships for people, every active tenant for platform admins. */
  tenants: TenantRef[];
  can: (p: Permission) => boolean;
};

/**
 * Who is looking at the tenant `tenantSlug`. Sends people who are not signed in to `/signin`;
 * someone signed in without access to that tenant gets a plain not-found page.
 */
export const pageContext = cache(async (tenantSlug: string): Promise<PageContext> => {
  const h = await headers();
  const user = await sessionUser(h);
  if (!user) redirect('/signin');
  const principal = await sessionPrincipal(h, tenantSlug);
  if (!principal) notFound();
  const tenants = user.platformAdmin
    ? (await listTenants()).filter((t) => t.status === 'active').map(({ id, slug, name }) => ({ id, slug, name }))
    : await tenantsFor(user.userId);
  const tenant = tenants.find((t) => t.slug === tenantSlug);
  if (!tenant) notFound();
  return { principal, user, tenant, tenants, can: (p) => canDo(principal, p) };
});

/** The signed-in platform admin, or a redirect to sign in, or a not-found page for anyone else. */
export async function adminContext(): Promise<SessionUser> {
  const user = await sessionUser(await headers());
  if (!user) redirect('/signin');
  if (!user.platformAdmin) notFound();
  return user;
}

/**
 * For server actions: re-checks the permission for the signed-in person in `tenantSlug` and runs `fn`
 * in a tenant transaction with a context built from them.
 */
export async function tenantAction<T>(
  tenantSlug: string,
  permission: Permission,
  fn: (ctx: ModuleContext, principal: Principal) => Promise<T>,
): Promise<T> {
  const principal = await sessionPrincipal(await headers(), tenantSlug);
  if (!principal) {
    throw new ScoutError({ slug: 'forbidden', status: 403, title: 'Forbidden', detail: "You don't have access to that." });
  }
  requirePermission(principal, permission);
  return withTenant(principal.tenantId, async (tx) => {
    const ctx: ModuleContext = { tenantId: principal.tenantId, actor: actorFor(principal), correlationId: newId('cor'), tx };
    return fn({ ...ctx, access: await accessWithSources(ctx, principal, sourceAccessProvider()) }, principal);
  });
}
