import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '@/entry/compose';
import { upsertFromArrival, type ArrivalForAccounts } from '@/modules/accounts';
import { accountCreated, accountUpdated, personAdded, personUpdated } from '@/modules/accounts/contracts/events';
import { accountAlias, personAlias } from '@/modules/accounts/db/schema';
import { adminDb, closeDbs } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { newId } from '@/platform/ids';
import { domain, routingTenant, type Tenant } from '../routing/helpers';

let t: Tenant;
beforeAll(async () => {
  t = await routingTenant();
});
afterAll(closeDbs);

const arrival = (d: string, over: Partial<ArrivalForAccounts> = {}): ArrivalForAccounts => ({
  arrivalId: newId('evt').replace('evt_', 'arr_'),
  receivedAt: new Date(),
  sourceChain: {},
  account: { name: 'Linked Co', domain: d },
  people: [],
  signals: [],
  facts: [],
  research: {},
  soleProprietor: false,
  externalIds: [],
  ...over,
});

const eventsFor = async (type: string, arrivalId: string) =>
  (await adminDb.select().from(outbox).where(eq(outbox.tenantId, t.tenantId)).orderBy(outbox.seq))
    .map((r) => r.payload as { type: string; data: Record<string, unknown> })
    .filter((e) => e.type === type && e.data.arrivalId === arrivalId)
    .map((e) => e.data);

describe('external ids through upsert (Ruling 13)', () => {
  it('writes account and person aliases and lists the added ids on the created events', async () => {
    const d = domain();
    const a = arrival(d, {
      externalIds: [{ system: 'hubspot', id: 'co-1' }],
      people: [{ firstName: 'Pat', lastName: 'Lee', email: `pat@${d}`, externalIds: [{ system: 'hubspot', id: 'ct-1' }] }],
    });
    const r = await t.run((ctx) => upsertFromArrival(ctx, a));

    const aliases = await t.run((ctx) => ctx.tx.select().from(accountAlias).where(and(eq(accountAlias.accountId, r.accountId), eq(accountAlias.kind, 'external_id'))));
    expect(aliases.map((x) => [x.system, x.value])).toEqual([['hubspot', 'co-1']]);
    const people = await t.run((ctx) => ctx.tx.select().from(personAlias).where(and(eq(personAlias.personId, r.personIds[0]!), eq(personAlias.kind, 'external_id'))));
    expect(people.map((x) => [x.system, x.value])).toEqual([['hubspot', 'ct-1']]);

    expect((await eventsFor(accountCreated.type, a.arrivalId))[0]).toMatchObject({ externalIds: [{ system: 'hubspot', id: 'co-1' }] });
    expect((await eventsFor(personAdded.type, a.arrivalId))[0]).toMatchObject({ externalIds: [{ system: 'hubspot', id: 'ct-1' }] });
  });

  it('a later write lists only the ids it added', async () => {
    const d = domain();
    const email = `sam@${d}`;
    const first = arrival(d, {
      externalIds: [{ system: 'hubspot', id: 'co-2' }],
      people: [{ firstName: 'Sam', email, externalIds: [{ system: 'hubspot', id: 'ct-2' }] }],
    });
    await t.run((ctx) => upsertFromArrival(ctx, first));

    const same = arrival(d, { externalIds: [{ system: 'hubspot', id: 'co-2' }], people: [{ firstName: 'Sam', email, externalIds: [{ system: 'hubspot', id: 'ct-2' }] }] });
    await t.run((ctx) => upsertFromArrival(ctx, same));
    expect((await eventsFor(accountUpdated.type, same.arrivalId)).every((e) => e.externalIds === undefined)).toBe(true);
    expect((await eventsFor(personUpdated.type, same.arrivalId)).every((e) => e.externalIds === undefined)).toBe(true);

    const more = arrival(d, {
      externalIds: [{ system: 'hubspot', id: 'co-2' }, { system: 'hubspot', id: 'co-3' }],
      people: [{ firstName: 'Sam', email, externalIds: [{ system: 'hubspot', id: 'ct-2' }, { system: 'hubspot', id: 'ct-3' }] }],
    });
    await t.run((ctx) => upsertFromArrival(ctx, more));
    expect(await eventsFor(accountUpdated.type, more.arrivalId)).toEqual([expect.objectContaining({ externalIds: [{ system: 'hubspot', id: 'co-3' }] })]);
    expect(await eventsFor(personUpdated.type, more.arrivalId)).toEqual([expect.objectContaining({ externalIds: [{ system: 'hubspot', id: 'ct-3' }] })]);
  });
});
