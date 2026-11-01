import { and, eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { v1Route } from '@/http/routes/v1/_lib/v1-route';
import { addMember, createTenant, handleDevSignIn, setPrincipalCacheTtl } from '@/modules/tenancy';
import { membership } from '@/modules/tenancy/db/schema';
import { adminDb } from '@/platform/db/client';
import { auditLog } from '@/platform/db/schema';
import { seedUser, uniqueSlug } from './helpers';

async function signedIn(userId: string): Promise<Headers> {
  const res = await handleDevSignIn(
    new Request('http://localhost:4240/api/dev/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    }),
    { enabled: true },
  );
  expect(res.status).toBe(200);
  return new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]!).join('; ') });
}

let tenantId: string;
let slug: string;
let ownerId: string;

beforeAll(async () => {
  const creator = await seedUser({ admin: true });
  const owner = await seedUser({ signedIn: true });
  slug = uniqueSlug();
  const t = await createTenant(creator.actor, { slug, name: 'Support Co', currency: 'USD', timezone: 'UTC', ownerEmail: owner.email });
  await adminDb.update(membership).set({ status: 'active' }).where(eq(membership.id, t.ownerMembershipId));
  tenantId = t.tenantId;
  ownerId = (await adminDb.select().from(membership).where(eq(membership.id, t.ownerMembershipId)))[0]!.userId;
});
beforeEach(() => setPrincipalCacheTtl(0));

const auditsBy = (actorId: string) =>
  adminDb.select().from(auditLog).where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.actorId, actorId)));

describe('support access is audited', () => {
  it('a write by a platform admin without membership is marked support access (/api/v1)', async () => {
    const admin = await seedUser({ admin: true, signedIn: true });
    const headers = await signedIn(admin.id);
    headers.set('x-scout-tenant', slug);
    const route = v1Route({ permission: 'members:manage' }, async (_req, _p, ctx) => {
      await addMember(ctx, { email: `${uniqueSlug()}@example.com`, role: 'seller' });
      return { ok: true };
    });
    const res = await route(new Request('http://localhost:4240/api/v1/test', { headers }));
    expect(res.status).toBe(200);
    const rows = await auditsBy(admin.id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.supportAccess)).toBe(true);
  });

  it('a write by a member is not marked', async () => {
    const headers = await signedIn(ownerId);
    headers.set('x-scout-tenant', slug);
    const route = v1Route({ permission: 'members:manage' }, async (_req, _p, ctx) => {
      await addMember(ctx, { email: `${uniqueSlug()}@example.com`, role: 'seller' });
      return { ok: true };
    });
    expect((await route(new Request('http://localhost:4240/api/v1/test', { headers }))).status).toBe(200);
    const rows = await auditsBy(ownerId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.supportAccess)).toBe(false);
  });
});
