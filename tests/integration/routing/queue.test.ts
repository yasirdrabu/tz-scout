import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { submitArrival, submitBatch } from '@/modules/intake';
import { arrival } from '@/modules/intake/db/schema';
import { assign, changeStatus, countQueue, listQueue, setInsights } from '@/modules/routing';
import { accountReview } from '@/modules/routing/db/schema';
import { closeDbs } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { asSource, personAndAgent } from '../intake/helpers';
import { arrivedAccount, asPerson, domain, member, routingTenant, setSummary, type Tenant } from './helpers';

let t: Tenant;
let seller: string;

beforeAll(async () => {
  t = await routingTenant();
  seller = await member(t, 'seller');
});
afterAll(closeDbs);

const ids = (page: { data: { accountId: string }[] }) => page.data.map((r) => r.accountId);

describe('the queue (REV-E1-S1)', () => {
  it('an account from an agent arrival shows as Unvetted (AC1)', async () => {
    const { agentId } = await personAndAgent(t, 'Yasir');
    const sent = await asSource(t, agentId, (ctx) => submitArrival(ctx, { account: { name: 'Agent Co', domain: domain() } }, { channel: 'api' }));
    await runOutbox(t.tenantId);
    const [row] = await t.run((ctx) => ctx.tx.select().from(arrival).where(eq(arrival.id, sent.arrivalId)));
    const page = await asPerson(t, (ctx) => listQueue(ctx, { sourceId: agentId }));
    expect(page.data).toEqual([expect.objectContaining({ accountId: row!.accountId, reviewStatusKey: 'unvetted', reviewStatusLabel: 'Unvetted' })]);
  });

  it('by default shows unassigned accounts not yet reviewed, and ones a seller declined, by priority then newest', async () => {
    const tag = newId('src');
    const chain = { personSourceId: tag };
    const low = await arrivedAccount(t, { sourceChain: chain });
    const highOld = await arrivedAccount(t, { sourceChain: chain });
    const highNew = await arrivedAccount(t, { sourceChain: chain });
    const reviewed = await arrivedAccount(t, { sourceChain: chain });
    const assigned = await arrivedAccount(t, { sourceChain: chain });
    const bounced = await arrivedAccount(t, { sourceChain: chain });
    await setSummary(t, low, { priority: 40 });
    await setSummary(t, highOld, { priority: 80 });
    await setSummary(t, highNew, { priority: 80 });
    await asPerson(t, (ctx) => changeStatus(ctx, reviewed, { to: 'reviewed' }));
    await asPerson(t, (ctx) => assign(ctx, assigned, { sellerUserId: seller }));
    await asPerson(t, (ctx) => changeStatus(ctx, bounced, { to: 'reviewed' }));
    await t.run((ctx) =>
      ctx.tx
        .update(accountReview)
        .set({ flags: { declinedBySeller: { assignmentId: 'asg_x', sellerUserId: seller, sellerName: 'Mike', reasonKey: 'not_my_territory', reasonLabel: 'Not my territory', at: new Date().toISOString() } } })
        .where(eq(accountReview.accountId, bounced)),
    );
    await asPerson(t, (ctx) => setInsights(ctx, bounced, 'Knows us'));
    await runOutbox(t.tenantId);

    const page = await asPerson(t, (ctx) => listQueue(ctx, { sourceId: tag }));
    expect(ids(page)).toEqual([highNew, highOld, low, bounced]);
    expect(page.data[3]).toMatchObject({ insights: 'Knows us', flags: { declinedBySeller: { sellerName: 'Mike', reasonLabel: 'Not my territory' } } });
    expect(await asPerson(t, (ctx) => countQueue(ctx, { sourceId: tag }))).toBe(4);
    const paged: string[] = [];
    let cursor: string | undefined;
    do {
      const p = await asPerson(t, (ctx) => listQueue(ctx, { sourceId: tag, limit: 1, cursor }));
      paged.push(...ids(p));
      cursor = p.nextCursor ?? undefined;
    } while (cursor);
    expect(paged).toEqual(ids(page));

    expect(ids(await asPerson(t, (ctx) => listQueue(ctx, { sourceId: tag, statusKeys: ['reviewed'] }))).sort()).toEqual([reviewed, assigned, bounced].sort());
    expect(ids(await asPerson(t, (ctx) => listQueue(ctx, { sourceId: tag, flag: 'declined_by_seller' })))).toEqual([bounced]);
  });

  it('filters by practice, offer, tier, batch and arrived date (AC2)', async () => {
    const tag = newId('src');
    const chain = { personSourceId: tag };
    const a = await arrivedAccount(t, { sourceChain: chain });
    const b = await arrivedAccount(t, { sourceChain: chain });
    await setSummary(t, a, { practiceIds: ['prc_p'], bestOfferId: 'off_a', tier: 'act_now' });
    await setSummary(t, b, { practiceIds: ['prc_q'], bestOfferId: 'off_b', tier: 'good_fit' });
    const q = (f: Parameters<typeof listQueue>[1]) => asPerson(t, (ctx) => listQueue(ctx, { sourceId: tag, ...f })).then(ids);
    expect(await q({ practiceId: 'prc_p' })).toEqual([a]);
    expect(await q({ offerId: 'off_b' })).toEqual([b]);
    expect(await q({ tier: 'act_now' })).toEqual([a]);
    expect(await q({ arrivedSince: new Date(Date.now() + 60_000) })).toEqual([]);
    expect((await q({ arrivedSince: new Date(Date.now() - 600_000) })).sort()).toEqual([a, b].sort());

    const { agentId } = await personAndAgent(t, 'Batcher');
    const { batchId } = await asSource(t, agentId, (ctx) =>
      submitBatch(ctx, { name: 'Queue batch', items: [{ external_ref: 'r1', account: { name: 'Batch Co', domain: domain() } }] }, { channel: 'api' }),
    );
    await runOutbox(t.tenantId);
    const [item] = await t.run((ctx) => ctx.tx.select().from(arrival).where(eq(arrival.batchId, batchId)));
    expect(ids(await asPerson(t, (ctx) => listQueue(ctx, { batchId })))).toEqual([item!.accountId]);
    expect(await q({ batchId: newId('bat') })).toEqual([]);
  });

  it('a reviewer limited to practice P sees only P in the queue and the count (AC4)', async () => {
    const tag = newId('src');
    const chain = { personSourceId: tag };
    const inP = await arrivedAccount(t, { sourceChain: chain });
    const outside = await arrivedAccount(t, { sourceChain: chain });
    await setSummary(t, inP, { practiceIds: ['prc_limit'] });
    await setSummary(t, outside, { practiceIds: ['prc_other'] });
    const limited = { dataLimit: { kind: 'practices' as const, ids: ['prc_limit'] } };
    expect(ids(await asPerson(t, (ctx) => listQueue(ctx, { sourceId: tag }), limited))).toEqual([inP]);
    expect(await asPerson(t, (ctx) => countQueue(ctx, { sourceId: tag }), limited)).toBe(1);
  });
});
