import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backfillR1b } from '@/entry/seed';
import { upsertFromArrival } from '@/modules/accounts';
import { submitArrival } from '@/modules/intake';
import { approveOffer, createOffer, createPractice } from '@/modules/offers';
import { accept, assign, getAccountStatus, listQueue, reviewChanged } from '@/modules/routing';
import { stageChange } from '@/modules/routing/db/schema';
import { explainScore, getScore, rescorePageJob } from '@/modules/scoring';
import { members } from '@/modules/tenancy';
import { adminDb, closeDbs } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { freshTenant as bareTenant } from '../integrations/helpers';
import { asSource, personAndAgent } from '../intake/helpers';
import { completeOffer } from '../offers/helpers';
import { asPerson, domain, member, routingTenant, summaryOf } from './helpers';

afterAll(closeDbs);

let n = 0;
const uniqueDomain = () => `${Date.now().toString(36)}${++n}-example.com`;

describe('R1b exit path', () => {
  let t: Awaited<ReturnType<typeof routingTenant>>;
  beforeAll(async () => {
    t = await routingTenant();
  });

  it('an agent sends an account; it is scored, queued as Unvetted, approved and assigned, accepted and read back with the owner name', async () => {
    const seller = await member(t, 'seller');
    const { agentId } = await personAndAgent(t, 'Exit');
    const practice = await t.run((ctx) => createPractice(ctx, { name: 'Exit Practice', slug: `exit-${Date.now().toString(36)}` }));
    const offer = await t.run((ctx) => createOffer(ctx, { name: 'Exit Offer', practiceId: practice.id, ...completeOffer }));
    await t.run((ctx) => approveOffer(ctx, offer.id));

    const sent = await asSource(t, agentId, (ctx) =>
      submitArrival(
        ctx,
        { account: { name: 'Exit Logistics', domain: uniqueDomain(), industry: 'logistics', employees: 2400 }, people: [{ name: 'Pat Lee', title: 'CTO' }] },
        { channel: 'api', canDeclareWarmIntro: false },
      ),
    );
    await runOutbox(t.tenantId);

    // The agent reads its arrival's status: it resolved to an account, waiting for review.
    const status = () => asSource(t, agentId, (ctx) => getAccountStatus(ctx, sent.arrivalId));
    const first = (await status())!;
    const accountId = first.accountId!;
    expect(first).toMatchObject({ stage: 'arrived', reviewStatus: 'unvetted', summary: 'Waiting for review.' });

    // Scored and explained.
    const score = await asPerson(t, (ctx) => getScore(ctx, accountId));
    expect(score).not.toBeNull();
    expect((await asPerson(t, (ctx) => explainScore(ctx, accountId)))?.summary).toBeTruthy();

    // In the queue as Unvetted with its priority.
    const queue = await asPerson(t, (ctx) => listQueue(ctx));
    expect(queue.data.find((r) => r.accountId === accountId)).toMatchObject({
      reviewStatusKey: 'unvetted',
      reviewStatusLabel: 'Unvetted',
      priority: score!.priority,
    });

    // A leader approves and assigns; the seller accepts.
    const made = await asPerson(t, (ctx) => assign(ctx, accountId, { sellerUserId: seller }));
    await asPerson(t, (ctx) => accept(ctx, made.id), { userId: seller });
    await runOutbox(t.tenantId);

    const sellerName = (await t.run((ctx) => members(ctx))).find((m) => m.userId === seller)!.name;
    const after = (await status())!;
    expect(after).toMatchObject({ stage: 'assigned', reviewStatus: 'reviewed', ownerName: sellerName });
    expect(after.summary).toMatch(new RegExp(`^Assigned to ${sellerName.split(' ')[0]} on `));
    expect(await summaryOf(t, accountId)).toMatchObject({ reviewStatusKey: 'reviewed', ownerUserId: seller, stage: 'assigned' });

    // The stage history: arrived, reviewed, assigned.
    const history = await t.run((ctx) =>
      ctx.tx.select().from(stageChange).where(and(eq(stageChange.tenantId, t.tenantId), eq(stageChange.accountId, accountId))).orderBy(asc(stageChange.at), asc(stageChange.id)),
    );
    expect([history[0]!.fromStage, ...history.map((h) => h.toStage)]).toEqual(['arrived', 'reviewed', 'assigned']);
  }, 60_000);
});

describe('backfillR1b', () => {
  /** A tenant as R1a left it: no routing or scoring defaults delivered, and accounts with no review row. */
  async function r1aTenant(count: number) {
    const t = await bareTenant();
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const r = await t.run((ctx) =>
        upsertFromArrival(ctx, {
          arrivalId: newId('evt').replace('evt_', 'arr_'),
          receivedAt: new Date(),
          sourceChain: {},
          account: { name: `Backfill ${i}`, domain: `${i}${domain()}` },
          people: [],
          signals: [],
          facts: [],
          research: {},
          soleProprietor: false,
          externalIds: [],
        }),
      );
      ids.push(r.accountId);
    }
    return { t, ids };
  }

  const count = async (text: ReturnType<typeof sql>) => Number(((await adminDb.execute(text)) as unknown as { n: string }[])[0]!.n);
  const counts = async (tenantId: string) => {
    const sent = (await adminDb.select().from(outbox).where(eq(outbox.tenantId, tenantId))).map((r) => (r.payload as { type: string }).type);
    return {
      reviews: await count(sql`select count(*) n from routing.account_review where tenant_id = ${tenantId}`),
      statuses: await count(sql`select count(*) n from routing.review_status_def where tenant_id = ${tenantId}`),
      settings: await count(sql`select count(*) n from routing.routing_setting where tenant_id = ${tenantId}`),
      profiles: await count(sql`select count(*) n from scoring.scoring_profile where tenant_id = ${tenantId}`),
      schedules: await count(sql`select count(*) n from platform.schedule where tenant_id = ${tenantId}`),
      scores: await count(sql`select count(*) n from scoring.account_score where tenant_id = ${tenantId}`),
      snapshots: sent.filter((x) => x === reviewChanged.type).length,
      rescorePages: sent.filter((x) => x === `jobs.${rescorePageJob.name}`).length,
    };
  };

  it('gives R1a accounts defaults, a review row, a snapshot and a score, and a second run changes nothing', async () => {
    const { t, ids } = await r1aTenant(3);
    expect(await counts(t.tenantId)).toMatchObject({ reviews: 0, statuses: 0, profiles: 0, schedules: 0 });

    await t.run((ctx) => backfillR1b(ctx));
    expect(await counts(t.tenantId)).toMatchObject({ reviews: 3, statuses: 4, settings: 1, profiles: 1, schedules: 2, snapshots: 3, rescorePages: 1 });

    await runOutbox(t.tenantId);
    for (const id of ids) {
      expect(await summaryOf(t, id)).toMatchObject({ reviewStatusKey: 'unvetted', stage: 'arrived' });
    }
    expect((await asPerson(t, (ctx) => listQueue(ctx))).data.map((r) => r.accountId).sort()).toEqual([...ids].sort());
    const settled = await counts(t.tenantId);
    expect(settled.scores).toBe(3);

    await t.run((ctx) => backfillR1b(ctx));
    await runOutbox(t.tenantId);
    // Only the rescore request is new; reviews, snapshots, scores and schedules stay as they were.
    expect(await counts(t.tenantId)).toEqual({ ...settled, rescorePages: settled.rescorePages + 1 });
  }, 60_000);

  it('starts a review at the status of the first resolved arrival', async () => {
    const t = await routingTenant();
    const { personId } = await personAndAgent(t, 'Back');
    const sent = await asSource(t, personId, (ctx) =>
      submitArrival(ctx, { account: { name: 'From A Person', domain: uniqueDomain() } }, { channel: 'api', canDeclareWarmIntro: false }),
    );
    await runOutbox(t.tenantId);
    const accountId = (await asSource(t, personId, (ctx) => getAccountStatus(ctx, sent.arrivalId)))!.accountId!;
    // Forget the review, as an R1a account would have none.
    await adminDb.execute(sql`delete from routing.account_review where tenant_id = ${t.tenantId}`);
    await t.run((ctx) => backfillR1b(ctx));
    expect(await summaryOf(t, accountId)).toMatchObject({ stage: 'arrived' });
    const [row] = (await adminDb.execute(sql`select status_key from routing.account_review where account_id = ${accountId}`)) as unknown as { status_key: string }[];
    expect(row!.status_key).toBe('needs_review');
  }, 60_000);
});
