import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '@/entry/compose';
import { mergeAccounts } from '@/modules/accounts';
import { getLinks, recordLink } from '@/modules/crm';
import { activity, companyCheck, deal, followThrough, handoff, link } from '@/modules/crm/db/schema';
import { moveCrmToSurvivor } from '@/modules/crm/services/merge';
import { getArrival, submitArrival } from '@/modules/intake';
import { assign } from '@/modules/routing';
import { accountReview } from '@/modules/routing/db/schema';
import { closeDbs } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { asSource, personAndAgent, validArrival } from '../intake/helpers';
import { arrivedAccount, asPerson, member, routingTenant, type Tenant } from '../routing/helpers';

let t: Tenant;
beforeAll(async () => {
  t = await routingTenant();
});
afterAll(closeDbs);

const linkCompany = (accountId: string, externalId: string) =>
  t.run((ctx) => recordLink(ctx, { scoutType: 'account', scoutId: accountId, system: 'hubspot', externalId }));
const merge = (survivor: string, mergedId: string) => asPerson(t, (ctx) => mergeAccounts(ctx, survivor, mergedId));

describe('merging accounts that are in the CRM', () => {
  it('refuses two accounts linked to different HubSpot companies', async () => {
    const a = await arrivedAccount(t, { name: 'A Co' });
    const b = await arrivedAccount(t, { name: 'B Co' });
    await linkCompany(a, 'mock-co-100');
    await linkCompany(b, 'mock-co-101');
    await expect(merge(a, b)).rejects.toMatchObject({ status: 409, message: 'Two HubSpot companies are linked' });
  });

  it('merges accounts linked to the same company and drops the duplicate link', async () => {
    const a = await arrivedAccount(t, { name: 'Same A' });
    const b = await arrivedAccount(t, { name: 'Same B' });
    await linkCompany(a, 'mock-co-110');
    await linkCompany(b, 'mock-co-110');
    await merge(a, b);
    await runOutbox(t.tenantId);
    const rows = await t.run((ctx) => ctx.tx.select().from(link).where(eq(link.externalId, 'mock-co-110')));
    expect(rows.map((r) => r.scoutId)).toEqual([a]);
  });

  it('moves links, handoffs, deals, activities, checks and follow-through to the survivor, and the other modules follow', async () => {
    const seller = await member(t, 'seller');
    const survivor = await arrivedAccount(t, { name: 'Survivor Co' });
    const merged = await arrivedAccount(t, { name: 'Merged Co' });
    const dealId = newId('dea');
    const made = await asPerson(t, (ctx) => assign(ctx, merged, { sellerUserId: seller }));
    await runOutbox(t.tenantId);
    const pushedCompany = (await t.run((ctx) => getLinks(ctx, merged))).company?.externalId; // the push linked it
    expect(pushedCompany).toBeTruthy();
    const hofId = await t.run(async (ctx) => {
      const [h] = await ctx.tx.select().from(handoff).where(eq(handoff.accountId, merged));
      await ctx.tx.insert(followThrough).values({ tenantId: ctx.tenantId, handoffId: h!.id }).onConflictDoNothing();
      await ctx.tx.insert(deal).values({ id: dealId, tenantId: ctx.tenantId, accountId: merged, system: 'hubspot', externalId: 'mock-dl-120', name: 'D', status: 'open' });
      await ctx.tx.insert(activity).values({ id: newId('cac'), tenantId: ctx.tenantId, accountId: merged, handoffId: h!.id, system: 'hubspot', externalId: 'act-120', kind: 'email', occurredAt: new Date() });
      await ctx.tx.insert(companyCheck).values({ tenantId: ctx.tenantId, accountId: merged, system: 'hubspot', exists: true, companyExternalId: 'mock-co-120' }).onConflictDoNothing();
      return h!.id;
    });

    await t.run((ctx) => recordLink(ctx, { scoutType: 'deal', scoutId: dealId, system: 'hubspot', externalId: 'mock-dl-120' }));
    // Intake: an arrival for the merged account resolves to the survivor afterwards.
    const { agentId } = await personAndAgent(t, 'Cy');
    const sent = await asSource(t, agentId, (ctx) => submitArrival(ctx, validArrival(), { channel: 'api' }));
    await runOutbox(t.tenantId);
    const arrivedAt = (await t.run((ctx) => getArrival(ctx, sent.arrivalId)))!.accountId!;
    await merge(survivor, arrivedAt);
    await merge(survivor, merged);
    await runOutbox(t.tenantId);

    const links = await t.run((ctx) => getLinks(ctx, survivor));
    expect(links.company?.externalId).toBe(pushedCompany);
    expect(links.deals).toHaveLength(1);
    expect(links.conflict).toBe(false);
    expect((await t.run((ctx) => getLinks(ctx, merged))).company).toBeNull();
    expect((await t.run((ctx) => ctx.tx.select().from(handoff).where(eq(handoff.id, hofId))))[0]!.accountId).toBe(survivor);
    const count = async (table: typeof deal | typeof activity | typeof companyCheck) =>
      (await t.run((ctx) => ctx.tx.select().from(table).where(and(eq(table.accountId, survivor))))).length;
    expect([await count(deal), await count(activity), await count(companyCheck)]).toEqual([1, 1, 1]);
    expect(await t.run((ctx) => ctx.tx.select().from(followThrough).where(eq(followThrough.handoffId, hofId)))).toHaveLength(1);

    const [review] = await t.run((ctx) => ctx.tx.select().from(accountReview).where(eq(accountReview.accountId, survivor)));
    expect(review).toMatchObject({ currentAssignmentId: made.id, mergedInto: null });
    expect((await t.run((ctx) => getArrival(ctx, sent.arrivalId)))!.accountId).toBe(survivor);
  });

  it('keeps both links when the guard was bypassed, and getLinks reports the conflict', async () => {
    const a = await arrivedAccount(t, { name: 'Bypass A' });
    const b = await arrivedAccount(t, { name: 'Bypass B' });
    await linkCompany(a, 'mock-co-130');
    await linkCompany(b, 'mock-co-131');
    await t.run((ctx) => moveCrmToSurvivor(ctx, a, b));
    expect((await t.run((ctx) => getLinks(ctx, a))).conflict).toBe(true);
  });
});
