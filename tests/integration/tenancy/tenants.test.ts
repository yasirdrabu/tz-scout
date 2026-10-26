import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTenant } from '@/modules/tenancy';
import { membership, user } from '@/modules/tenancy/db/schema';
import { adminDb } from '@/platform/db/client';
import { auditLog } from '@/platform/db/schema';
import { seedUser, uniqueSlug } from './helpers';

const input = (slug: string, ownerEmail: string) => ({
  slug,
  name: 'Acme',
  currency: 'USD',
  timezone: 'America/New_York',
  ownerEmail,
});

describe('createTenant', () => {
  it('creates the tenant, an invited owner and a tenant.created event (TEN-E1-S1-AC1)', async () => {
    const admin = await seedUser({ admin: true });
    const slug = uniqueSlug();
    const { tenantId, ownerMembershipId } = await createTenant(admin.actor, input(slug, 'Owner@Example.com'));
    const [m] = await adminDb.select().from(membership).where(eq(membership.id, ownerMembershipId));
    expect(m).toMatchObject({ tenantId, role: 'owner', status: 'invited' });
    const [u] = await adminDb.select().from(user).where(eq(user.email, 'owner@example.com'));
    expect(m!.userId).toBe(u!.id);
    const ev = await adminDb.execute(
      sql`select payload from platform.outbox where tenant_id = ${tenantId} and payload->>'type' = 'tenancy.tenant.created'`,
    );
    expect(ev).toHaveLength(1);
    expect((ev[0] as { payload: { data: unknown } }).payload.data).toEqual({
      tenantId,
      slug,
      createdBy: admin.id,
    });
  });

  it('reuses an existing user for the owner', async () => {
    const admin = await seedUser({ admin: true });
    const existing = await seedUser({ signedIn: true });
    const { ownerMembershipId } = await createTenant(admin.actor, input(uniqueSlug(), existing.email));
    const [m] = await adminDb.select().from(membership).where(eq(membership.id, ownerMembershipId));
    expect(m!.userId).toBe(existing.id);
  });

  it('refuses a slug already in use (TEN-E1-S1-AC2)', async () => {
    const admin = await seedUser({ admin: true });
    const slug = uniqueSlug();
    await createTenant(admin.actor, input(slug, 'a@example.com'));
    await expect(createTenant(admin.actor, input(slug, 'b@example.com'))).rejects.toThrow('That short name is taken.');
  });

  it('writes the platform audit log and no tenant audit row (TEN-E1-S1-AC3)', async () => {
    const admin = await seedUser({ admin: true });
    const { tenantId } = await createTenant(admin.actor, input(uniqueSlug(), 'c@example.com'));
    const platformRows = await adminDb
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, 't_platform'), eq(auditLog.subjectId, tenantId)));
    expect(platformRows).toHaveLength(1);
    expect(platformRows[0]).toMatchObject({ action: 'tenancy.tenant.created', actorId: admin.id });
    const tenantRows = await adminDb.select().from(auditLog).where(eq(auditLog.tenantId, tenantId));
    expect(tenantRows).toHaveLength(0);
  });

  it('is for platform admins only', async () => {
    const plain = await seedUser();
    await expect(createTenant(plain.actor, input(uniqueSlug(), 'd@example.com'))).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      createTenant({ kind: 'user', id: 'usr_nobody' }, input(uniqueSlug(), 'e@example.com')),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rolls everything back when the slug is taken', async () => {
    const admin = await seedUser({ admin: true });
    const slug = uniqueSlug();
    await createTenant(admin.actor, input(slug, 'f@example.com'));
    await expect(createTenant(admin.actor, input(slug, 'newperson@example.com'))).rejects.toThrow();
    const rows = await adminDb.select().from(user).where(eq(user.email, 'newperson@example.com'));
    expect(rows).toHaveLength(0);
  });
});
