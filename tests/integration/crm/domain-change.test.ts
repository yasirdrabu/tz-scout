import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { editAccount, upsertFromArrival } from '@/modules/accounts';
import { companyChecks, getLinks, seedMockCrm } from '@/modules/crm';
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
type Payload = { type: string; data: { accountId?: string } & Record<string, unknown> };
const checkedEvents = async (accountId: string) =>
  (await adminDb.select().from(outbox).where(eq(outbox.tenantId, t.tenantId)).orderBy(outbox.seq))
    .map((r) => r.payload as Payload)
    .filter((p) => p.type === 'crm.company.checked' && p.data.accountId === accountId);

describe('a domain change', () => {
  it('keeps one company link, the new one, and publishes a new check', async () => {
    const { accountId } = await arrive({ name: 'Mover', domain: 'owned-elsewhere.example' });
    await runOutbox(t.tenantId);
    const old = (await t.run((ctx) => getLinks(ctx, accountId))).company?.externalId;
    expect(old).toBeTruthy();
    await t.run((ctx) => editAccount({ ...ctx, access: { userId: ctx.actor.id, dataLimit: { kind: 'all' } } }, accountId, { domain: 'open-deal.example' }));
    await runOutbox(t.tenantId);
    const links = await t.run((ctx) => getLinks(ctx, accountId));
    expect(links.conflict).toBe(false);
    expect(links.company?.externalId).not.toBe(old);
    const [check] = await t.run((ctx) => companyChecks(ctx, [accountId]));
    expect(links.company?.externalId).toBe(check!.companyExternalId);
    const events = await checkedEvents(accountId);
    expect(events).toHaveLength(2);
    expect(events[1]!.data).toMatchObject({ companyLifecycle: 'open_deal' });
  });
});
