import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '@/entry/compose';
import { getAccount } from '@/modules/accounts';
import { account } from '@/modules/accounts/db/schema';
import { companyChecked, dealChanged, seedMockCrm } from '@/modules/crm';
import { adminDb, closeDbs } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { publishTestEvent } from '../helpers/publish';
import { runOutbox } from '../helpers/run-outbox';
import { arrivedAccount, routingTenant, type Tenant } from '../routing/helpers';

let t: Tenant;
beforeAll(async () => {
  t = await routingTenant();
  await t.run((ctx) => seedMockCrm(ctx));
});
afterAll(closeDbs);

const row = async (accountId: string) => (await t.run((ctx) => ctx.tx.select().from(account).where(eq(account.id, accountId))))[0]!;
const exclusionEvents = async (accountId: string) =>
  (await adminDb.select().from(outbox).where(eq(outbox.tenantId, t.tenantId)))
    .map((r) => r.payload as { type: string; data: Record<string, unknown> })
    .filter((p) => p.type === 'accounts.account.exclusion_changed' && p.data.accountId === accountId);

const checked = (accountId: string, companyLifecycle: 'none' | 'open_deal' | 'customer', observedAt: string) =>
  publishTestEvent(t.tenantId, companyChecked, { accountId, system: 'hubspot', exists: true, companyExternalId: 'mock-co-1', ownerName: null, companyLifecycle, observedAt });

describe('crm_status from CRM events (Ruling 12)', () => {
  it('an account checked at customer.example is a customer, excluded and announced', async () => {
    const accountId = await arrivedAccount(t, { name: 'Customer Co', domain: 'customer.example' });
    await runOutbox(t.tenantId);
    expect(await row(accountId)).toMatchObject({ crmStatus: 'customer', excludedReasonKey: 'existing_customer' });
    const acc = (await t.run((ctx) => getAccount(ctx, accountId)))!;
    expect(JSON.stringify(acc)).toContain('existing_customer');
    expect((await exclusionEvents(accountId)).map((e) => e.data.excludedReasonKey)).toEqual(['existing_customer']);
  });

  it('an older observedAt after a newer one changes nothing', async () => {
    const accountId = await arrivedAccount(t, { name: 'Order Co' });
    await checked(accountId, 'customer', '2027-10-27T12:00:00.000Z');
    await runOutbox(t.tenantId);
    await checked(accountId, 'none', '2027-10-27T11:00:00.000Z');
    await runOutbox(t.tenantId);
    expect(await row(accountId)).toMatchObject({ crmStatus: 'customer', excludedReasonKey: 'existing_customer' });
    await checked(accountId, 'none', '2027-10-27T13:00:00.000Z');
    await runOutbox(t.tenantId);
    expect(await row(accountId)).toMatchObject({ crmStatus: 'none', excludedReasonKey: null });
  });

  it('a deal change sets open_deal and excludes with open_deal', async () => {
    const accountId = await arrivedAccount(t, { name: 'Deal Co' });
    await publishTestEvent(t.tenantId, dealChanged, {
      accountId,
      system: 'hubspot',
      dealExternalId: 'mock-dl-1',
      status: 'open',
      previousStatus: null,
      stage: null,
      amountCents: null,
      currency: null,
      openedAt: null,
      closedAt: null,
      companyLifecycle: 'open_deal',
      observedAt: '2027-10-27T12:00:00.000Z',
    });
    await runOutbox(t.tenantId);
    expect(await row(accountId)).toMatchObject({ crmStatus: 'open_deal', excludedReasonKey: 'open_deal' });
  });
});
