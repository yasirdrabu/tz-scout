import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '@/entry/compose';
import { upsertFromArrival } from '@/modules/accounts';
import { getHandoffs, lastActivityAt, latestHandoff, seedMockCrm, syncOwners } from '@/modules/crm';
import { activity } from '@/modules/crm/db/schema';
import { setConnectionSettings } from '@/modules/integrations';
import { assign } from '@/modules/routing';
import { closeDbs } from '@/platform/db/client';
import { ScoutError } from '@/platform/errors';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { asPerson, domain, member, resolved, routingTenant, type Tenant } from '../routing/helpers';

let t: Tenant;
let seller: string;

beforeAll(async () => {
  t = await routingTenant();
  seller = await member(t, 'seller');
  await t.run((ctx) => seedMockCrm(ctx));
  await t.run((ctx) => syncOwners(ctx));
});
afterAll(closeDbs);

const hidden = { dataLimit: { kind: 'sources' as const, ids: [] } };

async function handedOff(): Promise<string> {
  const arrivalId = newId('evt').replace('evt_', 'arr_');
  const { accountId } = await t.run((ctx) =>
    upsertFromArrival(ctx, {
      arrivalId,
      receivedAt: new Date(),
      sourceChain: {},
      account: { name: 'Read Co', domain: domain() },
      people: [{ firstName: 'Ana', lastName: 'Read', title: 'CTO', email: `ana.${newId('acc').slice(-6).toLowerCase()}@read.example` }],
      signals: [],
      facts: [],
      research: {},
      soleProprietor: false,
      externalIds: [],
    }),
  );
  await resolved(t, accountId, { arrivalId, resolution: 'created' });
  await asPerson(t, (ctx) => assign(ctx, accountId, { sellerUserId: seller }));
  await runOutbox(t.tenantId);
  return accountId;
}

describe('handoff reads', () => {
  it('getHandoffs returns the links, handoffs, follow-through, deals and conflict', async () => {
    const a = await handedOff();
    const r = await asPerson(t, (ctx) => getHandoffs(ctx, a));
    expect(r.links.company?.externalId).toMatch(/^mock-co-/);
    expect(r.links.people).toHaveLength(1);
    expect(r.links.tasks).toHaveLength(4);
    expect(r.handoffs).toHaveLength(1);
    expect(Object.keys(r.handoffs[0]!).sort()).toEqual(
      ['attempts', 'completedAt', 'id', 'lastError', 'ownershipAction', 'queuedAt', 'status', 'takenFromOwner', 'undone'].sort(),
    );
    expect(r.handoffs[0]).toMatchObject({ status: 'completed', ownershipAction: 'assign', attempts: 1, lastError: null, undone: null });
    expect(r.followThrough).toMatchObject({ handoffId: r.handoffs[0]!.id, counts: { tasksTotal: 4, tasksDone: 0, emails: 0 } });
    expect(r.deals).toEqual([]);
    expect(r.conflict).toBe(false);
  });

  it('is not found outside the data limit', async () => {
    const a = await handedOff();
    const e = await asPerson(t, (ctx) => getHandoffs(ctx, a), hidden).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(ScoutError);
    expect((e as ScoutError).status).toBe(404);
    expect(await asPerson(t, (ctx) => latestHandoff(ctx, a), hidden)).toBeNull();
    expect(await asPerson(t, (ctx) => lastActivityAt(ctx, a), hidden)).toBeNull();
  });

  it('latestHandoff gives the status, ownership action and the HubSpot link once the portal is known', async () => {
    const a = await handedOff();
    expect(await asPerson(t, (ctx) => latestHandoff(ctx, a))).toMatchObject({ status: 'completed', ownershipAction: 'assign', crmUrl: null });
    await t.run((ctx) => setConnectionSettings(ctx, 'hubspot', { portal_id: '123' }));
    const h = await asPerson(t, (ctx) => latestHandoff(ctx, a));
    expect(h!.crmUrl).toMatch(/^https:\/\/app\.hubspot\.com\/contacts\/123\/record\/0-2\/mock-co-\d+$/);
  });

  it('lastActivityAt is the latest activity seen, or null', async () => {
    const a = await handedOff();
    expect(await asPerson(t, (ctx) => lastActivityAt(ctx, a))).toBeNull();
    const at = new Date('2026-10-20T10:00:00Z');
    await t.run((ctx) =>
      ctx.tx.insert(activity).values([
        { id: newId('cac'), tenantId: ctx.tenantId, accountId: a, system: 'hubspot', externalId: newId('cac'), kind: 'email', occurredAt: new Date('2026-10-19T10:00:00Z') },
        { id: newId('cac'), tenantId: ctx.tenantId, accountId: a, system: 'hubspot', externalId: newId('cac'), kind: 'call', occurredAt: at },
      ]),
    );
    expect(await asPerson(t, (ctx) => lastActivityAt(ctx, a))).toEqual(at);
  });
});
