import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BUYER_DEFINITION_WARNING,
  approveOffer,
  archiveOffer,
  createOffer,
  createPractice,
  getOffer,
  listOffers,
  updateOffer,
} from '@/modules/offers';
import { adminDb } from '@/platform/db/client';
import { auditLog } from '@/platform/db/schema';
import { completeOffer, freshTenant, memberWith } from './helpers';
import { inTenant } from '../tenancy/helpers';

let t: Awaited<ReturnType<typeof freshTenant>>;
let practiceId: string;

beforeAll(async () => {
  t = await freshTenant();
  practiceId = (await t.run((ctx) => createPractice(ctx, { name: 'Main Practice' }))).id;
});

const events = async (type: string) =>
  (await adminDb.execute(
    sql`select payload from platform.outbox where tenant_id = ${t.tenantId} and payload->>'type' = ${type} order by seq`,
  )) as unknown as { payload: { data: Record<string, unknown> } }[];

const draft = (name: string, extra: Record<string, unknown> = {}) =>
  t.run((ctx) => createOffer(ctx, { name, practiceId, ...completeOffer, ...extra }));

describe('OFF-E2-S1 create, edit, archive', () => {
  it('AC1: needs name, practice and promise', async () => {
    await expect(t.run((ctx) => createOffer(ctx, { name: '', practiceId, promise: 'x' }))).rejects.toMatchObject({ status: 400 });
    await expect(t.run((ctx) => createOffer(ctx, { name: 'N', practiceId: '', promise: 'x' }))).rejects.toMatchObject({ status: 400 });
    await expect(t.run((ctx) => createOffer(ctx, { name: 'N', practiceId, promise: ' ' }))).rejects.toMatchObject({ status: 400 });
    await expect(t.run((ctx) => createOffer(ctx, { name: 'N', practiceId: 'prc_nope', promise: 'x' }))).rejects.toMatchObject({ status: 404 });
  });

  it('AC1: saves a draft with every field, defaults to manual origin', async () => {
    const o = await t.run((ctx) =>
      createOffer(ctx, {
        name: 'Full Offer',
        practiceId,
        promise: 'A promise.',
        description: 'Long text',
        priceMinCents: 1_000_000,
        priceMaxCents: 9_000_000,
        grossMargin: 0.55,
        typicalDealCents: 5_000_000,
        expansionRate: 0.2,
        expansionValueCents: 2_000_000,
        salesCycleDays: 90,
        targetTitles: ['CTO'],
        targetBuyingRoles: ['technical_buyer'],
        companySizeMin: 50,
        companySizeMax: 500,
        revenueMinCents: 100_000_000,
        revenueMaxCents: 900_000_000,
        industries: ['logistics'],
        regions: ['US'],
        excludedDomains: ['example.org'],
        excludedCategories: ['agency'],
        proofPoints: ['Cut cost 30%'],
      }),
    );
    expect(o.id).toMatch(/^off_/);
    expect(o.slug).toBe('full-offer');
    expect(o.status).toBe('draft');
    expect(o.origin).toBe('manual');
    const got = await t.run((ctx) => getOffer(ctx, o.id));
    expect(got).toMatchObject({ grossMargin: 0.55, priceMaxCents: 9_000_000, targetBuyingRoles: ['technical_buyer'], proofPoints: ['Cut cost 30%'] });
  });

  it('a duplicate offer slug throws "That short name is taken."', async () => {
    await draft('Slug One', { slug: 'same-slug' });
    await expect(draft('Slug Two', { slug: 'same-slug' })).rejects.toMatchObject({ message: 'That short name is taken.' });
  });

  it('AC3: archiving publishes offers.offer.archived and keeps the row', async () => {
    const o = await draft('To Archive');
    const done = await t.run((ctx) => archiveOffer(ctx, o.id));
    expect(done.status).toBe('archived');
    const evs = await events('offers.offer.archived');
    expect(evs.some((e) => e.payload.data.offerId === o.id && e.payload.data.practiceId === practiceId)).toBe(true);
    expect((await t.run((ctx) => getOffer(ctx, o.id))).status).toBe('archived');
  });

  it('lists by practice and status', async () => {
    const o = await draft('Listed');
    const rows = await t.run((ctx) => listOffers(ctx, { practiceId, status: 'draft' }));
    expect(rows.map((r) => r.id)).toContain(o.id);
    expect(rows.every((r) => r.status === 'draft')).toBe(true);
  });

  it('getOffer on a missing id is a 404', async () => {
    await expect(t.run((ctx) => getOffer(ctx, 'off_missing'))).rejects.toMatchObject({ status: 404 });
  });
});

describe('OFF-E2-S2 approve', () => {
  it('AC2: an incomplete offer cannot be approved and the copy lists what is missing', async () => {
    const o = await t.run((ctx) => createOffer(ctx, { name: 'Thin', practiceId, promise: 'Only a promise.' }));
    const err = await t.run((ctx) => approveOffer(ctx, o.id)).catch((e) => e);
    expect(err).toMatchObject({ status: 400 });
    expect(err.errors.map((e: { message: string }) => e.message)).toEqual([
      'Add at least one target title or buying role before approving.',
      'Add industries or a company size range before approving.',
      'Add a typical deal size before approving.',
      'Add the sales cycle in days before approving.',
    ]);
    expect((await t.run((ctx) => getOffer(ctx, o.id))).status).toBe('draft');
  });

  it('AC1: an owner approves, and offers.offer.approved is published', async () => {
    const o = await draft('To Approve');
    const done = await t.run((ctx) => approveOffer(ctx, o.id));
    expect(done).toMatchObject({ status: 'approved', approvedBy: t.actor.id });
    expect(done.approvedAt).toBeInstanceOf(Date);
    const evs = await events('offers.offer.approved');
    expect(evs.some((e) => e.payload.data.offerId === o.id && e.payload.data.approvedBy === t.actor.id)).toBe(true);
    const audits = await adminDb.select().from(auditLog).where(eq(auditLog.subjectId, o.id));
    expect(audits.map((a) => a.action)).toContain('offers.offer.approved');
  });

  it('AC1: a leader gets the owner copy', async () => {
    const leader = await memberWith(t.tenantId, t.actor, 'leader');
    const o = await draft('Leader Tries');
    await expect(inTenant(t.tenantId, leader, (ctx) => approveOffer(ctx, o.id))).rejects.toMatchObject({
      status: 403,
      message: 'Only an owner can approve an offer.',
    });
  });

  it('AC1: an API key (agent actor) cannot approve', async () => {
    const o = await draft('Key Tries');
    await expect(
      inTenant(t.tenantId, { kind: 'agent', id: 'key_1' }, (ctx) => approveOffer(ctx, o.id)),
    ).rejects.toMatchObject({ status: 403, message: 'Only an owner can approve an offer.' });
  });

  it('approving twice is quiet and publishes once', async () => {
    const o = await draft('Twice');
    await t.run((ctx) => approveOffer(ctx, o.id));
    await t.run((ctx) => approveOffer(ctx, o.id));
    const evs = (await events('offers.offer.approved')).filter((e) => e.payload.data.offerId === o.id);
    expect(evs).toHaveLength(1);
  });

  it('an archived offer cannot be approved', async () => {
    const o = await draft('Archived First');
    await t.run((ctx) => archiveOffer(ctx, o.id));
    await expect(t.run((ctx) => approveOffer(ctx, o.id))).rejects.toMatchObject({ status: 409 });
  });

  it('AC3: editing the buyer definition of an approved offer returns the warning and sends it back to draft', async () => {
    const o = await draft('Approved Then Edited');
    await t.run((ctx) => approveOffer(ctx, o.id));
    const r = await t.run((ctx) => updateOffer(ctx, o.id, { industries: ['retail'] }));
    expect(r.warning).toBe(BUYER_DEFINITION_WARNING);
    expect(BUYER_DEFINITION_WARNING).toBe('This sends the offer back to draft until an owner approves it.');
    expect(r.offer).toMatchObject({ status: 'draft', approvedBy: null, approvedAt: null, industries: ['retail'] });
    const ev = (await events('offers.offer.changed')).filter((e) => e.payload.data.offerId === o.id);
    expect(ev.at(-1)!.payload.data).toMatchObject({ changed: ['industries', 'status'], affectsMatching: true });
  });

  it('editing a non-buyer field keeps it approved, publishes changed without affectsMatching', async () => {
    const o = await draft('Approved Stays');
    await t.run((ctx) => approveOffer(ctx, o.id));
    const r = await t.run((ctx) => updateOffer(ctx, o.id, { promise: 'A sharper promise.' }));
    expect(r.warning).toBeUndefined();
    expect(r.offer).toMatchObject({ status: 'approved', promise: 'A sharper promise.' });
    const ev = (await events('offers.offer.changed')).filter((e) => e.payload.data.offerId === o.id);
    expect(ev.at(-1)!.payload.data).toMatchObject({ changed: ['promise'], affectsMatching: false });
  });

  it('editing the buyer definition of a draft gives no warning', async () => {
    const o = await draft('Draft Edited');
    const r = await t.run((ctx) => updateOffer(ctx, o.id, { regions: ['EU'] }));
    expect(r.warning).toBeUndefined();
    expect(r.offer.status).toBe('draft');
  });

  it('an update that changes nothing publishes nothing', async () => {
    const o = await draft('No Change');
    const before = (await events('offers.offer.changed')).length;
    await t.run((ctx) => updateOffer(ctx, o.id, { promise: completeOffer.promise }));
    expect((await events('offers.offer.changed')).length).toBe(before);
  });
});

describe('slug race', () => {
  it('a concurrent duplicate offer slug gets the friendly error, not a 500', async () => {
    const results = await Promise.allSettled([draft('Race A', { slug: 'offer-race' }), draft('Race B', { slug: 'offer-race' })]);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toMatchObject({ status: 409, message: 'That short name is taken.' });
  });
});

describe('isolation', () => {
  it('another tenant cannot read or list the offer', async () => {
    const o = await draft('Private');
    const other = await freshTenant();
    await expect(other.run((ctx) => getOffer(ctx, o.id))).rejects.toMatchObject({ status: 404 });
    expect((await other.run((ctx) => listOffers(ctx))).map((r) => r.id)).not.toContain(o.id);
  });
});
