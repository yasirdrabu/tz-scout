import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '@/entry/compose';
import { upsertFromArrival } from '@/modules/accounts';
import { dealsPollJob, handleCrmWebhook, hubspotMock, leadQualified, recordLink, seedMockCrm, syncAccount, syncJob } from '@/modules/crm';
import { crmSetting, deal, webhookReceipt } from '@/modules/crm/db/schema';
import { mockAddDeal } from '@/modules/crm/fixtures';
import { adminDb, closeDbs } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { newId } from '@/platform/ids';
import { domain, routingTenant, type Tenant } from '../routing/helpers';

let t: Tenant;
beforeAll(async () => {
  t = await routingTenant();
  await t.run((ctx) => seedMockCrm(ctx));
});
afterAll(closeDbs);

const sent = async () => (await adminDb.select().from(outbox).where(eq(outbox.tenantId, t.tenantId)).orderBy(outbox.seq)).map((r) => r.payload as { type: string; data: Record<string, unknown> });

describe('handleCrmWebhook (Ruling 15)', () => {
  it('a deal and a lifecycle event enqueue one sync, publish one qualified lead and store the receipt', async () => {
    const d = domain();
    const { accountId } = await t.run((ctx) =>
      upsertFromArrival(ctx, {
        arrivalId: newId('evt').replace('evt_', 'arr_'),
        receivedAt: new Date(),
        sourceChain: {},
        account: { name: 'Hook Co', domain: d },
        people: [],
        signals: [],
        facts: [],
        research: {},
        soleProprietor: false,
        externalIds: [],
      }),
    );
    const co = await t.run((ctx) => hubspotMock(ctx).upsertCompany({ domain: d, name: d, ownerExternalId: null, replaceableOwner: true, properties: {} }));
    await t.run((ctx) => recordLink(ctx, { scoutType: 'account', scoutId: accountId, system: 'hubspot', externalId: co.externalId }));
    const dealExt = await t.run((ctx) => mockAddDeal(ctx, { companyExternalId: co.externalId, name: 'Hooked' }));
    // The deal is known to Scout once synced.
    await t.run((ctx) => syncAccount(ctx, accountId, new Date()));
    expect(await t.run((ctx) => ctx.tx.select().from(deal).where(eq(deal.externalId, dealExt)))).toHaveLength(1);

    const before = (await sent()).length;
    const body = JSON.stringify([
      { subscriptionType: 'deal.propertyChange', objectId: dealExt, propertyName: 'dealstage', propertyValue: 'x' },
      { subscriptionType: 'deal.propertyChange', objectId: dealExt, propertyName: 'amount', propertyValue: '5' },
      { subscriptionType: 'contact.propertyChange', objectId: 77, propertyName: 'lifecyclestage', propertyValue: 'marketingqualifiedlead' },
      { subscriptionType: 'contact.propertyChange', objectId: 78, propertyName: 'lifecyclestage', propertyValue: 'lead' },
    ]);
    const out = await t.run((ctx) => handleCrmWebhook(ctx, 'con_x', body));
    expect(out).toEqual({ syncs: 1, leads: 1 });
    const added = (await sent()).slice(before);
    expect(added.filter((e) => e.type === `jobs.${syncJob.name}`)).toHaveLength(1);
    expect(added.filter((e) => e.type === `jobs.${dealsPollJob.name}`)).toHaveLength(0);
    expect(added.filter((e) => e.type === leadQualified.type).map((e) => e.data)).toEqual([{ connectionId: 'con_x', contactId: '77' }]);
    const receipts = await t.run((ctx) => ctx.tx.select().from(webhookReceipt).where(eq(webhookReceipt.connectionId, 'con_x')));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.body).toBe(body);
    expect(receipts[0]!.processedAt).not.toBeNull();
  });

  it('a deal Scout has not seen queues one deals poll instead', async () => {
    const before = (await sent()).length;
    const body = JSON.stringify([
      { subscriptionType: 'deal.creation', objectId: 9001 },
      { subscriptionType: 'deal.creation', objectId: 9002 },
    ]);
    expect(await t.run((ctx) => handleCrmWebhook(ctx, 'con_y', body))).toEqual({ syncs: 0, leads: 0 });
    expect((await sent()).slice(before).filter((e) => e.type === `jobs.${dealsPollJob.name}`)).toHaveLength(1);
  });

  it('two webhooks with unknown deals within 5 minutes queue one deals poll; one after that queues another (final review I5)', async () => {
    const t2 = await routingTenant();
    await t2.run((ctx) => seedMockCrm(ctx));
    const polls = async () =>
      (await adminDb.select().from(outbox).where(eq(outbox.tenantId, t2.tenantId)))
        .map((r) => r.payload as { type: string })
        .filter((e) => e.type === `jobs.${dealsPollJob.name}`).length;
    const hook = (id: number) => t2.run((ctx) => handleCrmWebhook(ctx, 'con_z', JSON.stringify([{ subscriptionType: 'deal.creation', objectId: id }])));
    await hook(9101);
    await hook(9102);
    expect(await polls()).toBe(1);
    await t2.run((ctx) => ctx.tx.update(crmSetting).set({ dealsPollRequestedAt: new Date(Date.now() - 6 * 60_000) }).where(eq(crmSetting.tenantId, ctx.tenantId)));
    await hook(9103);
    expect(await polls()).toBe(2);
  });
});
