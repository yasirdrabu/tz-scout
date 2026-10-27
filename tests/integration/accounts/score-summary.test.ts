import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listPeople, mergeAccounts, pinPrimary, search, upsertFromArrival, type ArrivalForAccounts } from '@/modules/accounts';
import { accountSummary } from '@/modules/accounts/db/schema';
import { createOffer, createPractice } from '@/modules/offers';
import { accountScored } from '@/modules/scoring/contracts/events';
import { closeDbs } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { publishTestEvent } from '../helpers/publish';
import { runOutbox } from '../helpers/run-outbox';
import { completeOffer, freshTenant } from '../offers/helpers';

type Scored = z.infer<typeof accountScored.data>;

let t: Awaited<ReturnType<typeof freshTenant>>;
let offerId: string;

afterAll(closeDbs);

beforeAll(async () => {
  t = await freshTenant();
  await runOutbox(t.tenantId);
  const p = await t.run((ctx) => createPractice(ctx, { name: 'Score Practice', slug: 'score-practice' }));
  const o = await t.run((ctx) => createOffer(ctx, { name: 'Score Offer', practiceId: p.id, ...completeOffer, targetTitles: ['Head of Data'] }));
  offerId = o.id;
});

const domain = () => `${newId('acc').slice(-10).toLowerCase()}-example.com`;
const personAccess = { userId: 'usr_editor', sourceId: 'src_editor', dataLimit: { kind: 'all' as const } };

function arrival(over: Partial<ArrivalForAccounts> = {}): ArrivalForAccounts {
  return {
    arrivalId: newId('evt').replace('evt_', 'arr_'),
    receivedAt: new Date('2026-10-26T15:00:00Z'),
    sourceChain: { personSourceId: 'src_person1', agentSourceId: 'src_agent1' },
    account: {},
    people: [],
    signals: [],
    facts: [],
    research: {},
    soleProprietor: false,
    externalIds: [],
    ...over,
  };
}

const seed = (over: Partial<ArrivalForAccounts> = {}) => t.run((ctx) => upsertFromArrival(ctx, arrival(over)));

const scored = (accountId: string, version: number, over: Partial<Scored> = {}) =>
  publishTestEvent<Scored>(t.tenantId, accountScored, {
    accountId,
    priority: 70,
    fit: 80,
    intent: 55,
    tier: 'act_now',
    previousTier: null,
    bestOfferId: offerId,
    previousBestOfferId: null,
    practiceId: null,
    revenueBand: null,
    cause: 'new_fact',
    profileVersion: 1,
    version,
    ...over,
  });

const summaryOf = async (accountId: string) => {
  const [row] = await t.run((ctx) => ctx.tx.select().from(accountSummary).where(eq(accountSummary.accountId, accountId)));
  return row!;
};

const deliver = () => runOutbox(t.tenantId);

describe('account summary from scoring.account.scored', () => {
  it('fills the score columns and search finds the account by tier, priority and best offer', async () => {
    const out = await seed({ account: { name: 'Scored Co', domain: domain() } });
    await deliver();
    await scored(out.accountId, 1);
    await deliver();
    expect(await summaryOf(out.accountId)).toMatchObject({
      priority: 70,
      fit: 80,
      intent: 55,
      tier: 'act_now',
      bestOfferId: offerId,
      scoreVersion: 1,
    });
    const ids = async (q: Parameters<typeof search>[1]) => (await t.run((ctx) => search({ ...ctx, access: personAccess }, q))).data.map((r) => r.accountId);
    expect(await ids({ tier: 'act_now' })).toContain(out.accountId);
    expect(await ids({ tier: 'watch' })).not.toContain(out.accountId);
    expect(await ids({ priorityMin: 70 })).toContain(out.accountId);
    expect(await ids({ priorityMin: 71 })).not.toContain(out.accountId);
    expect(await ids({ bestOfferId: offerId })).toContain(out.accountId);
    expect(await ids({ bestOfferId: 'off_other' })).not.toContain(out.accountId);
  });

  it('re-picks the primary when the best offer changes (ACC-E1-S3-AC3)', async () => {
    const d = domain();
    const out = await seed({
      account: { name: 'Primary Co', domain: d },
      people: [
        { firstName: 'Cy', lastName: 'Chief', title: 'Chief Executive Officer', email: `cy@${d}` },
        { firstName: 'Dee', lastName: 'Data', title: 'Head of Data', email: `dee@${d}` },
      ],
    });
    await deliver();
    const primary = async () => (await t.run((ctx) => listPeople(ctx, out.accountId))).find((x) => x.isPrimary)?.firstName;
    expect(await primary()).toBe('Cy');
    await scored(out.accountId, 1);
    await deliver();
    expect(await primary()).toBe('Dee');
  });

  it('keeps a pinned primary when the best offer changes', async () => {
    const d = domain();
    const out = await seed({
      account: { name: 'Pinned Co', domain: d },
      people: [
        { firstName: 'Cy', lastName: 'Chief', title: 'Chief Executive Officer', email: `cy@${d}` },
        { firstName: 'Dee', lastName: 'Data', title: 'Head of Data', email: `dee@${d}` },
      ],
    });
    await deliver();
    const people = await t.run((ctx) => listPeople(ctx, out.accountId));
    await t.run((ctx) => pinPrimary({ ...ctx, access: personAccess }, out.accountId, people.find((x) => x.firstName === 'Cy')!.id));
    await deliver();
    await scored(out.accountId, 1);
    await deliver();
    expect((await t.run((ctx) => listPeople(ctx, out.accountId))).find((x) => x.isPrimary)?.firstName).toBe('Cy');
  });

  it('skips an older version published after a newer one', async () => {
    const out = await seed({ account: { name: 'Order Co', domain: domain() } });
    await deliver();
    await scored(out.accountId, 3, { priority: 90 });
    await deliver();
    await scored(out.accountId, 2, { priority: 10, tier: 'watch', bestOfferId: null });
    await deliver();
    expect(await summaryOf(out.accountId)).toMatchObject({ priority: 90, tier: 'act_now', bestOfferId: offerId, scoreVersion: 3 });
  });

  it('changes nothing on a replay of the same version', async () => {
    const out = await seed({ account: { name: 'Replay Co', domain: domain() } });
    await deliver();
    await scored(out.accountId, 1);
    await deliver();
    const before = await summaryOf(out.accountId);
    await scored(out.accountId, 1, { priority: 5, tier: 'watch' });
    await deliver();
    expect(await summaryOf(out.accountId)).toEqual(before);
  });

  it('ignores an event for an account that was merged away', async () => {
    const survivor = await seed({ account: { name: 'Survivor Co', domain: domain() } });
    const merged = await seed({ account: { name: 'Merged Co', domain: domain() } });
    await deliver();
    await t.run((ctx) => mergeAccounts({ ...ctx, access: personAccess }, survivor.accountId, merged.accountId));
    await deliver();
    const before = await summaryOf(survivor.accountId); // scoring has scored the survivor after the merge
    await scored(merged.accountId, 99);
    await deliver();
    expect(await summaryOf(survivor.accountId)).toEqual(before);
    expect((await summaryOf(merged.accountId)).scoreVersion).toBeNull();
  });
});
