import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertFromArrival } from '@/modules/accounts';
import { checkCompany, companyChecks, getLinks, lookupCompany, seedMockCrm } from '@/modules/crm';
import { callLog } from '@/modules/integrations/db/schema';
import { adminDb, closeDbs } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { routingTenant, type Tenant } from '../routing/helpers';

let t: Tenant;
beforeAll(async () => {
  t = await routingTenant();
  await t.run((ctx) => seedMockCrm(ctx));
});
afterAll(closeDbs);

const arrive = (account: { name: string; domain?: string }) =>
  t.run((ctx) =>
    upsertFromArrival(ctx, {
      arrivalId: newId('evt').replace('evt_', 'arr_'),
      receivedAt: new Date(),
      sourceChain: {},
      account,
      people: [],
      signals: [],
      facts: [],
      research: {},
      soleProprietor: false,
      externalIds: [],
    }),
  );
const finds = () => t.run((ctx) => ctx.tx.select().from(callLog).where(and(eq(callLog.provider, 'hubspot'), eq(callLog.operation, 'findCompany'))));
type Payload = { type: string; data: { accountId?: string } & Record<string, unknown> };
const checkedEvents = async (accountId: string) =>
  (await adminDb.select().from(outbox).where(eq(outbox.tenantId, t.tenantId)))
    .map((r) => r.payload as Payload)
    .filter((p) => p.type === 'crm.company.checked' && p.data.accountId === accountId);

describe('the CRM check before review', () => {
  it('checks a new account at open-deal.example, links it and publishes once', async () => {
    const { accountId } = await arrive({ name: 'Open Deal', domain: 'open-deal.example' });
    await runOutbox(t.tenantId);
    const [check] = await t.run((ctx) => companyChecks(ctx, [accountId]));
    expect(check).toMatchObject({ accountId, exists: true, ownerName: 'Vijay Kumar', lifecycle: 'open_deal' });
    expect((await t.run((ctx) => getLinks(ctx, accountId))).company?.externalId).toBe(check!.companyExternalId);
    const events = await checkedEvents(accountId);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ exists: true, ownerName: 'Vijay Kumar', companyLifecycle: 'open_deal' });
  });

  it('makes no CRM call for a second lookup inside 24 hours', async () => {
    const { accountId } = await arrive({ name: 'Customer', domain: 'customer.example' });
    await runOutbox(t.tenantId);
    const before = (await finds()).length;
    const again = await t.run((ctx) => lookupCompany(ctx, 'Customer.example'));
    await t.run((ctx) => checkCompany(ctx, accountId));
    expect((await finds()).length).toBe(before);
    expect(again).toMatchObject({ exists: true, lifecycle: 'customer' });
    expect(await checkedEvents(accountId)).toHaveLength(1);
  });

  it('records a company that is not in the CRM, and skips a shell with no domain', async () => {
    const { accountId } = await arrive({ name: 'Nowhere', domain: `${newId('acc').slice(-8).toLowerCase()}.example` });
    const shell = await arrive({ name: 'No Domain' });
    await runOutbox(t.tenantId);
    const rows = await t.run((ctx) => companyChecks(ctx, [accountId, shell.accountId]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ accountId, exists: false, ownerName: null, lifecycle: 'none' });
    expect(await checkedEvents(shell.accountId)).toHaveLength(0);
  });
});

describe('lookups by domain', () => {
  it('two lookups by domain alone make one CRM call', async () => {
    const before = (await finds()).length;
    const first = await t.run((ctx) => lookupCompany(ctx, 'owned-elsewhere.example'));
    const second = await t.run((ctx) => lookupCompany(ctx, 'OWNED-elsewhere.example'));
    expect(first.exists).toBe(true);
    expect(second.exists).toBe(true);
    expect((await finds()).length).toBe(before + 1);
  });
});
