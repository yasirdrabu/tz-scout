import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { GET as statsRoute } from '@/http/routes/v1/offers/stats/route';
import { accountSummary } from '@/modules/accounts/db/schema';
import { approveOffer, createOffer, createPractice } from '@/modules/offers';
import { offerMatch } from '@/modules/scoring/db/schema';
import { adminDb } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { workspace, type Workspace } from '../v1/review-helpers';
import { completeOffer } from './helpers';

let w: Workspace;
let p1: string;
let p2: string;
let a: string;
let b: string;
let d: string;
let seller: string;

type Row = { offer_id: string; practice_id: string; matched: number; won: number; win_rate: number | null };
const statsOf = async (userId: string, query = '') => {
  const res = await w.as(userId, statsRoute, `offers/stats${query}`);
  expect(res.status).toBe(200);
  const { data } = (await res.json()) as { data: Row[] };
  return new Map(data.map((r) => [r.offer_id, r]));
};

beforeAll(async () => {
  w = await workspace('Stats Co');
  p1 = (await w.run((ctx) => createPractice(ctx, { name: 'One' }))).id;
  p2 = (await w.run((ctx) => createPractice(ctx, { name: 'Two' }))).id;
  const offer = (name: string, practiceId: string) => w.run((ctx) => createOffer(ctx, { name, practiceId, ...completeOffer }));
  a = (await offer('A', p1)).id;
  b = (await offer('B', p2)).id;
  d = (await offer('D draft', p1)).id;
  for (const id of [a, b]) await w.run((ctx) => approveOffer(ctx, id));
  const acc1 = await w.account('Won One');
  const acc2 = await w.account('Open One');
  const acc3 = await w.account('Won Two');
  const acc4 = await w.account('Won, picked, no match');
  await w.deliver();
  seller = await w.person('seller', { dataLimit: { kind: 'practices', ids: [p1] } });

  // Fix the scores by hand: nothing is delivered after this.
  await adminDb.delete(offerMatch).where(eq(offerMatch.tenantId, w.tenantId));
  const summary = (accountId: string, set: Partial<typeof accountSummary.$inferInsert>) =>
    adminDb.update(accountSummary).set(set).where(eq(accountSummary.accountId, accountId));
  await summary(acc1, { practiceIds: [p1], practiceId: p1, stage: 'won', bestOfferId: a, leadOfferOverrideId: null });
  await summary(acc2, { practiceIds: [p1], practiceId: p1, stage: 'arrived', bestOfferId: a, leadOfferOverrideId: null });
  await summary(acc3, { practiceIds: [p2], practiceId: p2, stage: 'won', bestOfferId: b, leadOfferOverrideId: null });
  // Won with A as the pick, but no current match for A: it is not counted, so won never exceeds matched.
  await summary(acc4, { practiceIds: [p1], practiceId: p1, stage: 'won', bestOfferId: null, leadOfferOverrideId: a });
  const match = (accountId: string, offerId: string, tier: string) => ({
    id: newId('om'),
    tenantId: w.tenantId,
    accountId,
    offerId,
    fit: 50,
    intent: 50,
    matchTotal: 50,
    tier,
    fitParts: {},
    ruleHits: [],
    profileVersion: 1,
  });
  await adminDb.insert(offerMatch).values([match(acc1, a, 'good_fit'), match(acc2, a, 'watch'), match(acc3, a, 'not_fit'), match(acc3, b, 'act_now')]);
});

describe('GET /api/v1/offers/stats (Ruling 14)', () => {
  it('counts current matches (not not_fit) and won accounts by lead offer, with win_rate from the API', async () => {
    const s = await statsOf(w.owner);
    expect(s.get(a)).toEqual({ offer_id: a, practice_id: p1, matched: 2, won: 1, win_rate: 50 });
    expect(s.get(b)).toEqual({ offer_id: b, practice_id: p2, matched: 1, won: 1, win_rate: 100 });
    expect(s.get(d)).toEqual({ offer_id: d, practice_id: p1, matched: 0, won: 0, win_rate: null });
  });

  it('filters by practice_id', async () => {
    const s = await statsOf(w.owner, `?practice_id=${p2}`);
    expect([...s.keys()]).toEqual([b]);
  });

  it('a seller with a practice data limit counts only their accounts, and sees no drafts', async () => {
    const s = await statsOf(seller);
    expect(s.get(a)).toMatchObject({ matched: 2, won: 1 });
    expect(s.get(b)).toMatchObject({ matched: 0, won: 0, win_rate: null });
    expect(s.has(d)).toBe(false);
  });

  it("another workspace's practice id gives nothing", async () => {
    const other = await workspace('Other Stats Co');
    const theirs = (await other.run((ctx) => createPractice(ctx, { name: 'Theirs' }))).id;
    expect((await statsOf(w.owner, `?practice_id=${theirs}`)).size).toBe(0);
  });
});
