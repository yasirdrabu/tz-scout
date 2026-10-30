import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { confirmOwnerMatch, isOwnerActive, listOwners, ownerMatches, ownerName, seedMockCrm, syncOwners } from '@/modules/crm';
import { mockOwner } from '@/modules/crm/db/schema';
import { connection } from '@/modules/integrations/db/schema';
import { addMember, crmOwnerId } from '@/modules/tenancy';
import { closeDbs } from '@/platform/db/client';
import { withTenant } from '@/platform/db/tenant';
import { routingTenant, type Tenant } from '../routing/helpers';
import { seedUser } from '../tenancy/helpers';

let t: Tenant;
let seed: { rahul: string; vijay: string };
beforeAll(async () => {
  t = await routingTenant();
  seed = await t.run((ctx) => seedMockCrm(ctx));
});
afterAll(closeDbs);

describe('owner roster', () => {
  it('syncs idempotently and marks Rahul inactive', async () => {
    const first = await t.run((ctx) => syncOwners(ctx));
    const second = await t.run((ctx) => syncOwners(ctx));
    expect(second.count).toBe(first.count);
    const owners = await t.run((ctx) => listOwners(ctx));
    expect(owners.filter((o) => o.name === 'Vijay Kumar')).toHaveLength(1);
    expect(owners.find((o) => o.externalOwnerId === seed.rahul)?.active).toBe(false);
    expect(await t.run((ctx) => ownerName(ctx, 'hubspot', seed.vijay))).toBe('Vijay Kumar');
    expect(await t.run((ctx) => isOwnerActive(ctx, 'hubspot', seed.vijay))).toBe(true);
    expect(await t.run((ctx) => isOwnerActive(ctx, 'hubspot', seed.rahul))).toBe(false);
    expect(await t.run((ctx) => isOwnerActive(ctx, 'hubspot', 'nope'))).toBeNull();
    expect(await t.run((ctx) => ownerName(ctx, 'hubspot', 'nope'))).toBeNull();
  });

  it('offers a member with the same email as a match and confirming writes the owner id', async () => {
    const u = await seedUser({ signedIn: true });
    await t.run((ctx) => addMember(ctx, { email: u.email, role: 'seller' }));
    await withTenant(t.tenantId, (tx) =>
      tx.insert(mockOwner).values({ tenantId: t.tenantId, externalId: 'mock-ow-900', name: 'Pat Seller', email: u.email.toUpperCase(), active: true }),
    );
    await t.run((ctx) => syncOwners(ctx));
    const matches = await t.run((ctx) => ownerMatches(ctx));
    const m = matches.find((x) => x.email.toLowerCase() === u.email.toLowerCase());
    expect(m).toMatchObject({ externalOwnerId: 'mock-ow-900' });
    await t.run((ctx) => confirmOwnerMatch(ctx, { userId: m!.userId, externalOwnerId: 'mock-ow-900' }));
    expect(await t.run((ctx) => crmOwnerId(ctx, m!.userId, 'hubspot'))).toBe('mock-ow-900');
    expect((await t.run((ctx) => ownerMatches(ctx))).find((x) => x.userId === m!.userId)).toBeUndefined();
  });
});

describe('owner list that can not be read', () => {
  it('refuses with the warning copy when the connection test showed no owners read', async () => {
    const warning = "Owner list can't be read, so Scout can't name who owns a company";
    await t.run((ctx) =>
      ctx.tx.update(connection).set({ lastTestResult: { ok: true, message: `Connected to HubSpot. ${warning}` } }).where(eq(connection.provider, 'hubspot')),
    );
    await expect(t.run((ctx) => syncOwners(ctx))).rejects.toMatchObject({ status: 409, message: warning });
  });
});
