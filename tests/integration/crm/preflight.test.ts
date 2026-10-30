import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '@/entry/compose';
import { upsertFromArrival } from '@/modules/accounts';
import { crmOwnershipPreflight, preflightOwnership, seedMockCrm, syncOwners } from '@/modules/crm';
import { companyCheck, crmSetting, handoff } from '@/modules/crm/db/schema';
import { user } from '@/modules/tenancy/db/schema';
import { addMember } from '@/modules/tenancy';
import { adminDb, closeDbs } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { routingTenant, type Tenant } from '../routing/helpers';
import { seedUser } from '../tenancy/helpers';

let t: Tenant;
let ash: string;
let bo: string; // no HubSpot owner id
let rahulSeller: string; // linked to the inactive Rahul
let vijaySeller: string; // linked to Vijay
let vijayId: string;

const seller = async (name: string, owner?: string) => {
  const u = await seedUser();
  await adminDb.update(user).set({ name: `${name} Seller` }).where(eq(user.id, u.id));
  await t.run((ctx) => addMember(ctx, { email: u.email, role: 'seller', ...(owner ? { crmOwnerIds: { hubspot: owner } } : {}) }));
  return u.id;
};

beforeAll(async () => {
  t = await routingTenant();
  ash = await seller('Ash', 'mock-ow-701');
  bo = await seller('Bo');
  const seeded = await t.run((ctx) => seedMockCrm(ctx));
  vijayId = seeded.vijay;
  rahulSeller = await seller('Rahul', seeded.rahul);
  vijaySeller = await seller('Vijay', seeded.vijay);
  await t.run((ctx) => syncOwners(ctx));
});
afterAll(closeDbs);

const arrive = async (domain: string) =>
  (
    await t.run((ctx) =>
      upsertFromArrival(ctx, {
        arrivalId: newId('evt').replace('evt_', 'arr_'),
        receivedAt: new Date(),
        sourceChain: {},
        account: { name: domain, domain },
        people: [],
        signals: [],
        facts: [],
        research: {},
        soleProprietor: false,
        externalIds: [],
      }),
    )
  ).accountId;
const check = async (domain: string, userId = ash) => {
  const id = await arrive(domain);
  return t.run((ctx) => preflightOwnership(ctx, id, userId));
};

describe('ownership preflight with the mock CRM', () => {
  it('a company that is not in the CRM is new', async () => {
    expect(await check('nobody-home.example')).toMatchObject({ result: 'new', message: 'New in the CRM', reason: null });
  });
  it('a company with no owner moves to the seller', async () => {
    expect(await check('qualified.example')).toMatchObject({ result: 'assign', message: 'In the CRM with no owner: will move to Ash' });
  });
  it('owned-elsewhere moves to the seller', async () => {
    expect(await check('owned-elsewhere.example')).toMatchObject({ result: 'assign', message: 'Owned by Vijay Kumar: will move to Ash', currentOwnerName: 'Vijay Kumar', takenFrom: vijayId });
  });
  it('an inactive owner is named as such', async () => {
    expect(await check('inactive-owner.example')).toMatchObject({ result: 'assign', message: 'Owned by Rahul Mehta (inactive): will move to Ash' });
  });
  it('an open deal stops', async () => {
    expect(await check('open-deal.example')).toMatchObject({ result: 'stop', message: 'Open deal owned by Vijay Kumar: will not change owner', reason: 'open_deal' });
  });
  it('a customer stops', async () => {
    expect(await check('customer.example')).toMatchObject({ result: 'stop', message: 'Customer owned by Vijay Kumar: will not change owner', reason: 'customer' });
  });
  it('someone else owns it and taking over is off: stop', async () => {
    const setTakeOver = (v: boolean) => t.run((ctx) => ctx.tx.update(crmSetting).set({ takeOverStaleOwnership: v }).where(eq(crmSetting.tenantId, ctx.tenantId)));
    await setTakeOver(false);
    try {
      expect(await check('owned-elsewhere.example')).toMatchObject({ result: 'stop', message: 'Owned by Vijay Kumar: will not change owner', reason: 'owned_elsewhere' });
    } finally {
      await setTakeOver(true);
    }
  });
  it('the seller already owns it', async () => {
    expect(await check('owned-elsewhere.example', vijaySeller)).toMatchObject({ result: 'assign', message: 'Already owned by Vijay' });
  });
  it('owned by the owner we set last time moves even with an open deal', async () => {
    const id = await arrive('open-deal.example');
    await t.run((ctx) =>
      ctx.tx.insert(handoff).values({ id: newId('hof'), tenantId: ctx.tenantId, accountId: id, assignmentId: newId('asg'), system: 'hubspot', status: 'completed', ownershipAction: 'assign', ownerExternalId: vijayId, completedAt: new Date() }),
    );
    expect(await t.run((ctx) => preflightOwnership(ctx, id, ash))).toMatchObject({ result: 'assign', message: 'Owned by Vijay Kumar: will move to Ash' });
  });
  it('a seller with no owner id is blocked', async () => {
    expect(await check('owned-elsewhere.example', bo)).toMatchObject({ result: 'blocked', message: 'Bo has no HubSpot owner set. Set it in Members first.', reason: 'no_owner' });
  });
  it('a seller linked to an inactive roster owner is blocked', async () => {
    expect(await check('owned-elsewhere.example', rahulSeller)).toMatchObject({ result: 'blocked', message: 'Link this person to a HubSpot owner first' });
  });
  it('calls the CRM now and refreshes the stored check; the port shape is result and message', async () => {
    const id = await arrive('owned-elsewhere.example');
    await t.run((ctx) => preflightOwnership(ctx, id, ash));
    await t.run((ctx) => ctx.tx.update(companyCheck).set({ ownerName: 'Stale Name', exists: false }).where(eq(companyCheck.accountId, id)));
    expect(await t.run((ctx) => crmOwnershipPreflight.check(ctx, id, ash))).toEqual({ result: 'assign', message: 'Owned by Vijay Kumar: will move to Ash' });
    const [row] = await t.run((ctx) => ctx.tx.select().from(companyCheck).where(eq(companyCheck.accountId, id)));
    expect(row).toMatchObject({ exists: true, ownerName: 'Vijay Kumar' });
  });
});
