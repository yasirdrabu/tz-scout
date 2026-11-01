import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  approveOffer,
  archiveOffer,
  archivePractice,
  createOffer,
  createPractice,
  getPractice,
  listPracticeViews,
  unapproveOffer,
  updateOffer,
  updatePractice,
} from '@/modules/offers';
import { adminDb } from '@/platform/db/client';
import { inTenant } from '../tenancy/helpers';
import { completeOffer, freshTenant, memberWith } from './helpers';

let t: Awaited<ReturnType<typeof freshTenant>>;
let practiceId: string;

beforeAll(async () => {
  t = await freshTenant();
  practiceId = (await t.run((ctx) => createPractice(ctx, { name: 'Lifecycle' }))).id;
});

const events = async (type: string) =>
  (await adminDb.execute(
    sql`select payload from platform.outbox where tenant_id = ${t.tenantId} and payload->>'type' = ${type} order by seq`,
  )) as unknown as { payload: { data: Record<string, unknown> } }[];

const draft = (name: string, extra: Record<string, unknown> = {}) =>
  t.run((ctx) => createOffer(ctx, { name, practiceId, ...completeOffer, ...extra }));

describe('offer content fields (Ruling 13)', () => {
  it('create and update round-trip the five new fields', async () => {
    const o = await draft('Content', { priceModel: 'fixed', lengthWeeks: 6, keyOffer: 'K', whyUs: 'U', whyNow: 'N' });
    expect(o).toMatchObject({ priceModel: 'fixed', lengthWeeks: 6, keyOffer: 'K', whyUs: 'U', whyNow: 'N' });
    const { offer } = await t.run((ctx) => updateOffer(ctx, o.id, { priceModel: 'per_month', lengthWeeks: 12, whyUs: 'Better' }));
    expect(offer).toMatchObject({ priceModel: 'per_month', lengthWeeks: 12, whyUs: 'Better', keyOffer: 'K' });
  });

  it('a content edit keeps an approved offer approved; a buyer edit sends it back to draft', async () => {
    const o = await draft('Stays active');
    await t.run((ctx) => approveOffer(ctx, o.id));
    const content = await t.run((ctx) => updateOffer(ctx, o.id, { whyUs: 'We did it before.', keyOffer: 'x', lengthWeeks: 4, priceModel: 'custom' }));
    expect(content.warning).toBeUndefined();
    expect(content.offer.status).toBe('approved');
    const changed = (await events('offers.offer.changed')).filter((e) => e.payload.data.offerId === o.id);
    expect(changed.at(-1)!.payload.data.affectsMatching).toBe(false);
    const buyer = await t.run((ctx) => updateOffer(ctx, o.id, { industries: ['retail'] }));
    expect(buyer.offer.status).toBe('draft');
    expect(buyer.warning).toBeDefined();
  });
});

describe('approve and unapprove (Ruling 12)', () => {
  it('an operator (offers:manage) approves a complete draft', async () => {
    const operator = await memberWith(t.tenantId, t.actor, 'operator');
    const o = await draft('Operator approves');
    const done = await inTenant(t.tenantId, operator, (ctx) => approveOffer(ctx, o.id));
    expect(done).toMatchObject({ status: 'approved', approvedBy: operator.id });
  });

  it('an API key cannot approve or unapprove', async () => {
    const o = await draft('Key approves');
    const key = { kind: 'agent', id: 'key_1' } as const;
    await expect(inTenant(t.tenantId, key, (ctx) => approveOffer(ctx, o.id))).rejects.toMatchObject({ status: 403 });
    await expect(inTenant(t.tenantId, key, (ctx) => unapproveOffer(ctx, o.id))).rejects.toMatchObject({ status: 403 });
  });

  it('unapprove moves active to draft, clears the approver and publishes offers.offer.changed', async () => {
    const o = await draft('Unapprove me');
    await t.run((ctx) => approveOffer(ctx, o.id));
    const back = await t.run((ctx) => unapproveOffer(ctx, o.id));
    expect(back).toMatchObject({ status: 'draft', approvedBy: null, approvedAt: null });
    const evs = (await events('offers.offer.changed')).filter((e) => e.payload.data.offerId === o.id);
    expect(evs.at(-1)!.payload.data).toMatchObject({ changed: ['status'], affectsMatching: true });
    // Again is quiet.
    await t.run((ctx) => unapproveOffer(ctx, o.id));
    expect((await events('offers.offer.changed')).filter((e) => e.payload.data.offerId === o.id)).toHaveLength(evs.length);
  });

  it('unapprove on a retired offer is 409', async () => {
    const o = await draft('Retired one');
    await t.run((ctx) => archiveOffer(ctx, o.id));
    await expect(t.run((ctx) => unapproveOffer(ctx, o.id))).rejects.toMatchObject({ status: 409 });
  });
});

describe('practice lead, offer count and read', () => {
  it('a lead must be a member; the view has lead_name and the non-archived offer count', async () => {
    const p = await t.run((ctx) => createPractice(ctx, { name: 'Led', leadUserId: t.actor.id }));
    await expect(t.run((ctx) => createPractice(ctx, { name: 'Bad lead', leadUserId: 'usr_nobody' }))).rejects.toMatchObject({
      status: 400,
      errors: [{ path: 'lead_user_id', message: 'That person is not a member of this workspace.' }],
    });
    await expect(t.run((ctx) => updatePractice(ctx, p.id, { leadUserId: 'usr_nobody' }))).rejects.toMatchObject({ status: 400 });
    await t.run((ctx) => createOffer(ctx, { name: 'Led one', practiceId: p.id, promise: 'x' }));
    const gone = await t.run((ctx) => createOffer(ctx, { name: 'Led two', practiceId: p.id, promise: 'x' }));
    await t.run((ctx) => archiveOffer(ctx, gone.id));
    const view = await t.run((ctx) => getPractice(ctx, p.id));
    expect(view).toMatchObject({ id: p.id, leadUserId: t.actor.id, offerCount: 1 });
    expect(view.leadName).toEqual(expect.any(String));
    const list = await t.run((ctx) => listPracticeViews(ctx));
    expect(list.find((x) => x.id === p.id)).toMatchObject({ offerCount: 1, leadName: view.leadName });
    const cleared = await t.run((ctx) => updatePractice(ctx, p.id, { leadUserId: null }));
    expect(cleared.leadUserId).toBeNull();
  });

  it('another tenant cannot read the practice', async () => {
    const other = await freshTenant();
    const p = await other.run((ctx) => createPractice(ctx, { name: 'Elsewhere' }));
    await expect(t.run((ctx) => getPractice(ctx, p.id))).rejects.toMatchObject({ status: 404 });
  });

  it('archiving a practice with an active offer gives the new copy', async () => {
    const p = await t.run((ctx) => createPractice(ctx, { name: 'Blocked' }));
    const o = await t.run((ctx) => createOffer(ctx, { name: 'Blocking', practiceId: p.id, ...completeOffer }));
    await t.run((ctx) => approveOffer(ctx, o.id));
    await expect(t.run((ctx) => archivePractice(ctx, p.id))).rejects.toMatchObject({
      status: 409,
      message: 'Retire or move its active offers first.',
    });
  });
});
