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

describe('confirming a match keeps the member other CRM ids', () => {
  it('keeps other_crm and refuses an owner another member holds', async () => {
    const { crmOwnerId: idOf } = await import('@/modules/tenancy');
    const a = await seedUser({ signedIn: true });
    const b = await seedUser({ signedIn: true });
    const aId = await t.run((ctx) => addMember(ctx, { email: a.email, role: 'seller', crmOwnerIds: { other_crm: 'x' } }));
    await t.run((ctx) => addMember(ctx, { email: b.email, role: 'seller' }));
    await withTenant(t.tenantId, (tx) =>
      tx.insert(mockOwner).values([
        { tenantId: t.tenantId, externalId: 'mock-ow-910', name: 'A Person', email: a.email, active: true },
        { tenantId: t.tenantId, externalId: 'mock-ow-911', name: 'B Person', email: b.email, active: true },
      ]),
    );
    await withTenant(t.tenantId, (tx) => tx.update(connection).set({ lastTestResult: null }).where(eq(connection.provider, 'hubspot')));
    await t.run((ctx) => syncOwners(ctx));
    const ms = await t.run((ctx) => ownerMatches(ctx));
    const mine = ms.find((m) => m.externalOwnerId === 'mock-ow-910')!;
    await t.run((ctx) => confirmOwnerMatch(ctx, { userId: mine.userId, externalOwnerId: 'mock-ow-910' }));
    expect(await t.run((ctx) => idOf(ctx, mine.userId, 'other_crm'))).toBe('x');
    expect(await t.run((ctx) => idOf(ctx, mine.userId, 'hubspot'))).toBe('mock-ow-910');
    void aId;
    // B's match is for an owner nobody else holds, so it is allowed; B pointing at A's owner is not offered and is refused.
    const theirs = ms.find((m) => m.externalOwnerId === 'mock-ow-911')!;
    await expect(t.run((ctx) => confirmOwnerMatch(ctx, { userId: theirs.userId, externalOwnerId: 'mock-ow-910' }))).rejects.toBeTruthy();
  });
});
