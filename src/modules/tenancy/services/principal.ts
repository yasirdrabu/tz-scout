import { and, eq, sql } from 'drizzle-orm';
import { adminDb } from '@/platform/db/client';
import { log } from '@/platform/log';
import { SESSION_MAX_SECONDS, SESSION_UPDATE_AGE_SECONDS, auth } from '../auth';
import type { Principal } from '../contracts/principal';
import type { Role } from '../contracts/members';
import { DataLimitSchema, defaultDataLimit, type DataLimit } from '../domain/data-limit';
import { PERMISSIONS, isPermission, permissionsFor } from '../domain/permissions';
import { membership, session, tenant, user } from '../db/schema';
import { landingPathFor } from './sign-in';
import { authenticateKey, setKeyCacheTtl } from './api-keys';

/** A session with no activity for this long is over (global constraint: 12 hours). */
export const SESSION_IDLE_MS = 12 * 3600_000;

type Access = {
  disabled: boolean;
  platformAdmin: boolean;
  tenantId: string | null;
  tenantActive: boolean;
  role: string | null;
  status: string | null;
  extra: string[] | null;
  dataLimit: unknown;
};

let ttlMs = 60_000;
const cache = new Map<string, { at: number; value: Access | null }>();

/** Test hook: how long membership, disabled and verified-key lookups are cached (at most 60 seconds). Clears the caches. */
export function setPrincipalCacheTtl(ms: number): void {
  ttlMs = Math.min(Math.max(ms, 0), 60_000);
  cache.clear();
  setKeyCacheTtl(ms);
}

async function loadAccess(userId: string, tenantSlug: string): Promise<Access | null> {
  const [row] = await adminDb
    .select({
      disabledAt: user.disabledAt,
      platformAdmin: user.platformAdmin,
      tenantId: tenant.id,
      tenantStatus: tenant.status,
      role: membership.role,
      status: membership.status,
      extra: membership.extraPermissions,
      dataLimit: membership.dataLimit,
    })
    .from(user)
    .leftJoin(tenant, eq(tenant.slug, tenantSlug))
    .leftJoin(membership, and(eq(membership.tenantId, tenant.id), eq(membership.userId, user.id)))
    .where(eq(user.id, userId));
  if (!row) return null;
  return {
    disabled: row.disabledAt !== null,
    platformAdmin: row.platformAdmin,
    tenantId: row.tenantId,
    tenantActive: row.tenantStatus === 'active',
    role: row.role,
    status: row.status,
    extra: row.extra,
    dataLimit: row.dataLimit,
  };
}

async function access(userId: string, tenantSlug: string): Promise<Access | null> {
  const key = `${userId}\u0000${tenantSlug}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await loadAccess(userId, tenantSlug);
  if (ttlMs > 0) {
    if (cache.size >= 10_000) cache.clear(); // bound memory; entries are cheap to reload
    cache.set(key, { at: Date.now(), value });
  }
  return value;
}

function limitFor(a: Access, role: Role): DataLimit | null {
  if (a.dataLimit === null || a.dataLimit === undefined) return defaultDataLimit('user', role);
  const parsed = DataLimitSchema.safeParse(a.dataLimit);
  return parsed.success ? parsed.data : null;
}

/**
 * The signed-in person acting in the tenant `tenantSlug`, or null: no session, idle more than 12
 * hours, older than 7 days, disabled user, suspended tenant, or no active membership. Platform
 * admins get every active tenant with `supportAccess` and every permission. Membership and
 * disabled checks are cached for at most 60 seconds (TEN-E1-S2-AC2, TEN-E2-S3-AC1).
 */
export async function sessionPrincipal(headers: Headers, tenantSlug: string): Promise<Principal | null> {
  const found = await auth.api.getSession({ headers, query: { disableRefresh: true } });
  if (!found) return null;
  const now = Date.now();
  const lastActive = new Date(found.session.updatedAt).getTime();
  const started = new Date(found.session.createdAt).getTime();
  if (now - lastActive > SESSION_IDLE_MS || now - started > SESSION_MAX_SECONDS * 1000) return null;

  const userId = found.user.id;
  const a = await access(userId, tenantSlug);
  if (!a || a.disabled || !a.tenantId || !a.tenantActive) return null;

  let principal: Principal;
  const isMember = a.status === 'active' && a.role !== null;
  if (a.platformAdmin) {
    const dataLimit = isMember ? limitFor(a, a.role as Role) : { kind: 'all' as const };
    if (!dataLimit) return null;
    principal = {
      tenantId: a.tenantId,
      kind: 'user',
      id: userId,
      userId,
      permissions: [...PERMISSIONS],
      dataLimit,
      platformAdmin: true,
      supportAccess: true,
    };
  } else {
    if (!isMember) return null;
    const role = a.role as Role;
    const dataLimit = limitFor(a, role);
    if (!dataLimit) {
      log.error({ userId, tenantId: a.tenantId }, 'membership has an invalid data limit');
      return null;
    }
    principal = {
      tenantId: a.tenantId,
      kind: 'user',
      id: userId,
      userId,
      permissions: permissionsFor(role, (a.extra ?? []).filter(isPermission), false),
      dataLimit,
      platformAdmin: false,
      supportAccess: false,
    };
  }

  // Record activity at most once per update age, so the idle clock restarts.
  if (now - lastActive > SESSION_UPDATE_AGE_SECONDS * 1000) {
    await adminDb
      .update(session)
      .set({ updatedAt: sql`now()` })
      .where(eq(session.id, found.session.id));
  }
  return principal;
}

function clientIp(req: Request): string | null {
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || req.headers.get('x-real-ip') || null;
}

/**
 * Who is calling. A bearer token is an API key: it gives a key principal, or null when invalid
 * (throws 401 key-revoked or key-expired for a correct but unusable key). With no bearer token,
 * the cookie session is used for tenantSlug; without a slug, the x-scout-tenant header, then the
 * person's last used tenant.
 */
export async function resolvePrincipal(req: Request, tenantSlug?: string): Promise<Principal | null> {
  const authorization = req.headers.get('authorization');
  if (authorization !== null) {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
    if (!m) return null;
    return authenticateKey(m[1]!, clientIp(req));
  }
  let slug = tenantSlug ?? req.headers.get('x-scout-tenant')?.trim();
  if (!slug) {
    const found = await auth.api.getSession({ headers: req.headers, query: { disableRefresh: true } });
    if (!found) return null;
    const path = await landingPathFor(found.user.id);
    slug = /^\/t\/([^/]+)$/.exec(path)?.[1];
    if (!slug) return null;
  }
  return sessionPrincipal(req.headers, slug);
}

export type SessionUser = { userId: string; name: string; email: string; platformAdmin: boolean };

/** The signed-in person regardless of tenant (same idle and age rules), or null. */
export async function sessionUser(headers: Headers): Promise<SessionUser | null> {
  const found = await auth.api.getSession({ headers, query: { disableRefresh: true } });
  if (!found) return null;
  const now = Date.now();
  if (now - new Date(found.session.updatedAt).getTime() > SESSION_IDLE_MS) return null;
  if (now - new Date(found.session.createdAt).getTime() > SESSION_MAX_SECONDS * 1000) return null;
  const [u] = await adminDb
    .select({ id: user.id, name: user.name, email: user.email, platformAdmin: user.platformAdmin, disabledAt: user.disabledAt })
    .from(user)
    .where(eq(user.id, found.user.id));
  if (!u || u.disabledAt) return null;
  return { userId: u.id, name: u.name, email: u.email, platformAdmin: u.platformAdmin };
}
