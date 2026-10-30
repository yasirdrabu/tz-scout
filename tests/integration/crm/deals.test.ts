import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '@/entry/compose';
import { upsertFromArrival } from '@/modules/accounts';
import { checkCompany, companyChecked, dealChanged, hubspotMock, pollDeals, recordLink, refreshCheck, seedMockCrm, syncAccount } from '@/modules/crm';
import { deal, link } from '@/modules/crm/db/schema';
import { mockAddDeal, mockSetDeal } from '@/modules/crm/fixtures';
import { recentCalls } from '@/modules/integrations';
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

/** An account linked to a fresh mock company. */
async function linked(domainName?: string): Promise<{ accountId: string; company: string }> {
  const d = domainName ?? domain();
  const { accountId } = await t.run((ctx) =>
    upsertFromArrival(ctx, {
      arrivalId: newId('evt').replace('evt_', 'arr_'),
      receivedAt: new Date(),
      sourceChain: {},
      account: { name: 'Deal Co', domain: d },
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
  return { accountId, company: co.externalId };
}

const events = async (accountId: string) =>
  (await adminDb.select().from(outbox).where(eq(outbox.tenantId, t.tenantId)).orderBy(outbox.seq))
    .map((r) => r.payload as { type: string; data: Record<string, unknown> })
    .filter((e) => e.type === dealChanged.type && e.data.accountId === accountId)
    .map((e) => e.data);
const poll = () => t.run((ctx) => pollDeals(ctx, new Date()));

describe('deals (CRM-E5-S3)', () => {
  it('a new deal on a linked company publishes open, and closing it won publishes won with cents and closedAt (AC1, AC2)', async () => {
    const { accountId, company } = await linked();
    const ext = await t.run((ctx) => mockAddDeal(ctx, { companyExternalId: company, name: 'Big', amountCents: 100_000 }));
    await poll();
    expect(await events(accountId)).toMatchObject([{ dealExternalId: ext, status: 'open', previousStatus: null, amountCents: 100_000, companyLifecycle: 'open_deal', closedAt: null }]);
    await t.run((ctx) => mockSetDeal(ctx, ext, { status: 'won', amountCents: 120_000 }));
    await poll();
    const all = await events(accountId);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ status: 'won', previousStatus: 'open', amountCents: 120_000, companyLifecycle: 'customer' });
    expect(all[1]!.closedAt).toEqual(expect.any(String));
    const [row] = await t.run((ctx) => ctx.tx.select().from(deal).where(eq(deal.accountId, accountId)));
    expect(row).toMatchObject({ status: 'won', amountCents: 120_000 });
    const links = await t.run((ctx) => ctx.tx.select().from(link).where(and(eq(link.scoutType, 'deal'), eq(link.scoutId, row!.id))));
    expect(links).toHaveLength(1);
  });

  it('re-reading an unchanged deal publishes nothing (Review Focus 4)', async () => {
    const { accountId, company } = await linked();
    await t.run((ctx) => mockAddDeal(ctx, { companyExternalId: company, name: 'Same' }));
    await poll();
    await poll();
    await t.run((ctx) => syncAccount(ctx, accountId, new Date()));
    expect(await events(accountId)).toHaveLength(1);
  });

  it('a won deal that reverts stops counting as a customer (Ruling 12)', async () => {
    const { accountId, company } = await linked();
    const ext = await t.run((ctx) => mockAddDeal(ctx, { companyExternalId: company, name: 'Flip', amountCents: 1 }));
    await poll();
    await t.run((ctx) => mockSetDeal(ctx, ext, { status: 'won' }));
    await poll();
    await t.run((ctx) => mockSetDeal(ctx, ext, { status: 'open' }));
    await poll();
    await t.run((ctx) => mockSetDeal(ctx, ext, { status: 'lost' }));
    await poll();
    expect((await events(accountId)).map((e) => [e.status, e.companyLifecycle])).toEqual([['open', 'open_deal'], ['won', 'customer'], ['open', 'open_deal'], ['lost', 'none']]);
  });

  it('a stored check that folded a won deal does not keep the company a customer after the deal is lost (Ruling 12)', async () => {
    const d = domain();
    const { accountId, company } = await linked(d);
    const ext = await t.run((ctx) => mockAddDeal(ctx, { companyExternalId: company, name: 'Won once', status: 'won', amountCents: 9 }));
    const first = await t.run((ctx) => checkCompany(ctx, accountId));
    expect(first?.lifecycle).toBe('customer');
    await t.run((ctx) => mockSetDeal(ctx, ext, { status: 'lost' }));
    await poll();
    expect((await events(accountId)).map((e) => e.companyLifecycle)).toEqual(['none']);
    await t.run((ctx) => refreshCheck(ctx, accountId));
    const checked = (await adminDb.select().from(outbox).where(eq(outbox.tenantId, t.tenantId)).orderBy(outbox.seq))
      .map((r) => r.payload as { type: string; data: Record<string, unknown> })
      .filter((e) => e.type === companyChecked.type && e.data.accountId === accountId)
      .map((e) => e.data.companyLifecycle);
    expect(checked).toEqual(['customer', 'none']);
  });

  it('a company the CRM calls a customer stays one when its only deal is lost', async () => {
    const { accountId, company } = await linked('customer.example');
    await t.run((ctx) => checkCompany(ctx, accountId));
    const co = await t.run((ctx) => hubspotMock(ctx).findCompany({ domain: 'customer.example' }));
    await t.run((ctx) => mockAddDeal(ctx, { companyExternalId: co?.externalId ?? company, name: 'Lost', status: 'lost' }));
    await t.run((ctx) => recordLink(ctx, { scoutType: 'account', scoutId: accountId, system: 'hubspot', externalId: co!.externalId }));
    await poll();
    expect((await events(accountId)).map((e) => e.companyLifecycle)).toEqual(['customer']);
  });

  it('a stage change alone publishes nothing', async () => {
    const { accountId, company } = await linked();
    const ext = await t.run((ctx) => mockAddDeal(ctx, { companyExternalId: company, name: 'Stage', stage: 'a' }));
    await poll();
    await t.run((ctx) => mockSetDeal(ctx, ext, { stage: 'b' }));
    await poll();
    expect(await events(accountId)).toHaveLength(1);
  });

  it('a deal on an unlinked company is ignored', async () => {
    const co = await t.run((ctx) => hubspotMock(ctx).upsertCompany({ domain: domain(), name: 'x', ownerExternalId: null, replaceableOwner: true, properties: {} }));
    const ext = await t.run((ctx) => mockAddDeal(ctx, { companyExternalId: co.externalId, name: 'Stranger' }));
    await poll();
    expect(await t.run((ctx) => ctx.tx.select().from(deal).where(eq(deal.externalId, ext)))).toHaveLength(0);
  });

  it('syncAccount reads the account deals now', async () => {
    const { accountId, company } = await linked();
    await t.run((ctx) => mockAddDeal(ctx, { companyExternalId: company, name: 'Sync', status: 'lost', amountCents: 5 }));
    await t.run((ctx) => syncAccount(ctx, accountId, new Date()));
    expect(await events(accountId)).toMatchObject([{ status: 'lost', previousStatus: null, companyLifecycle: 'none' }]);
  });

  it('never writes a deal to the CRM (AC4)', async () => {
    const calls = await t.run((ctx) => recentCalls(ctx, 'hubspot', 200));
    const dealOps = calls.map((c) => c.operation).filter((o) => /deal/i.test(o));
    expect(dealOps.length).toBeGreaterThan(0);
    expect(dealOps.every((o) => o === 'listDeals')).toBe(true);
  });
});
