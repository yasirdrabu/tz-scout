import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import '@/entry/compose';
import {
  approveOffer,
  createCaseStudy,
  createOffer,
  createPractice,
  deleteOffer,
  getOffer,
  linkCaseStudy,
  listSignalRules,
  offerCanDelete,
} from '@/modules/offers';
import { offerCaseStudy, signalRule } from '@/modules/offers/db/schema';
import { setLeadOffer } from '@/modules/routing';
import { accountReview, leadOfferChange } from '@/modules/routing/db/schema';
import { offerMatch, scoreChange } from '@/modules/scoring/db/schema';
import { adminDb } from '@/platform/db/client';
import { auditLog } from '@/platform/db/schema';
import { newId } from '@/platform/ids';
import { arrivedAccount, asPerson, routingTenant } from '../routing/helpers';
import { inTenant } from '../tenancy/helpers';
import { completeOffer, freshTenant } from './helpers';

let t: Awaited<ReturnType<typeof freshTenant>>;
let practiceId: string;

beforeAll(async () => {
  t = await freshTenant();
  practiceId = (await t.run((ctx) => createPractice(ctx, { name: 'Deletes' }))).id;
});

const draft = (name: string) => t.run((ctx) => createOffer(ctx, { name, practiceId, ...completeOffer }));
const events = async (type: string) =>
  (await adminDb.execute(
    sql`select payload from platform.outbox where tenant_id = ${t.tenantId} and payload->>'type' = ${type} order by seq`,
  )) as unknown as { payload: { data: Record<string, unknown> } }[];

describe('DELETE an offer (Ruling 12)', () => {
  it('a fresh draft deletes with its signal rules and case-study links, and is audited', async () => {
    const o = await draft('Fresh draft');
    const cs = await t.run((ctx) => createCaseStudy(ctx, { title: 'Proof' }));
    await t.run((ctx) => linkCaseStudy(ctx, o.id, cs.id));
    expect((await t.run((ctx) => listSignalRules(ctx, o.id))).length).toBeGreaterThan(0);
    expect(await t.run((ctx) => offerCanDelete(ctx, o.id))).toBe(true);

    await t.run((ctx) => deleteOffer(ctx, o.id));

    await expect(t.run((ctx) => getOffer(ctx, o.id))).rejects.toMatchObject({ status: 404 });
    expect(await adminDb.select().from(signalRule).where(eq(signalRule.offerId, o.id))).toHaveLength(0);
    expect(await adminDb.select().from(offerCaseStudy).where(eq(offerCaseStudy.offerId, o.id))).toHaveLength(0);
    const audits = await adminDb.select().from(auditLog).where(and(eq(auditLog.subjectId, o.id), eq(auditLog.action, 'offers.offer.deleted')));
    expect(audits).toHaveLength(1);
  });

  it('an approved offer that never matched deletes, and scoring hears it is gone', async () => {
    const o = await draft('Approved, never matched');
    await t.run((ctx) => approveOffer(ctx, o.id));
    await t.run((ctx) => deleteOffer(ctx, o.id));
    expect((await events('offers.offer.archived')).some((e) => e.payload.data.offerId === o.id)).toBe(true);
  });

  it('an offer with an offer_match is 409 offer-has-history', async () => {
    const o = await draft('Matched');
    await adminDb.insert(offerMatch).values({
      id: newId('om'),
      tenantId: t.tenantId,
      accountId: 'acc_x',
      offerId: o.id,
      fit: 10,
      intent: 10,
      matchTotal: 10,
      tier: 'not_fit',
      fitParts: {},
      ruleHits: [],
      profileVersion: 1,
    });
    expect(await t.run((ctx) => offerCanDelete(ctx, o.id))).toBe(false);
    await expect(t.run((ctx) => deleteOffer(ctx, o.id))).rejects.toMatchObject({
      status: 409,
      slug: 'offer-has-history',
      message: 'Matched has matched accounts, so it can only be retired.',
    });
    expect((await t.run((ctx) => getOffer(ctx, o.id))).id).toBe(o.id);
  });

  it('an offer named by a score change (and no match now) is 409', async () => {
    const o = await draft('Was best once');
    await adminDb.insert(scoreChange).values({ id: newId('scc'), tenantId: t.tenantId, accountId: 'acc_x', toPriority: 1, toTier: 'watch', fromOfferId: o.id, cause: 'rules_changed' });
    await expect(t.run((ctx) => deleteOffer(ctx, o.id))).rejects.toMatchObject({ status: 409 });
  });

  it('an offer that was a lead offer once (and has no match now) is 409', async () => {
    const o = await draft('Lead once');
    await adminDb.insert(leadOfferChange).values({ id: newId('loc'), tenantId: t.tenantId, accountId: 'acc_x', fromOfferId: o.id, toOfferId: null, by: t.actor.id });
    expect(await t.run((ctx) => offerCanDelete(ctx, o.id))).toBe(false);
    await expect(t.run((ctx) => deleteOffer(ctx, o.id))).rejects.toMatchObject({ status: 409, slug: 'offer-has-history' });
  });

  it("another tenant's offer is 404", async () => {
    const other = await freshTenant();
    const p = await other.run((ctx) => createPractice(ctx, { name: 'Other' }));
    const o = await other.run((ctx) => createOffer(ctx, { name: 'Theirs', practiceId: p.id, promise: 'x' }));
    await expect(t.run((ctx) => deleteOffer(ctx, o.id))).rejects.toMatchObject({ status: 404 });
    expect((await other.run((ctx) => getOffer(ctx, o.id))).id).toBe(o.id);
  });
});

describe('DELETE and a lead offer pick', () => {
  it('an offer picked as lead offer with no change row yet is 409', async () => {
    const r = await routingTenant();
    // The account first: its arrival delivers the outbox, which would score it against an approved offer.
    const accountId = await arrivedAccount(r);
    const p = await r.run((ctx) => createPractice(ctx, { name: 'Picks' }));
    const o = await r.run((ctx) => createOffer(ctx, { name: 'Picked', practiceId: p.id, ...completeOffer }));
    await r.run((ctx) => approveOffer(ctx, o.id));
    await adminDb.update(accountReview).set({ leadOfferOverrideId: o.id }).where(eq(accountReview.accountId, accountId));
    expect(await adminDb.select().from(leadOfferChange).where(eq(leadOfferChange.accountId, accountId))).toHaveLength(0);
    await expect(r.run((ctx) => deleteOffer(ctx, o.id))).rejects.toMatchObject({ status: 409, slug: 'offer-has-history' });
  });

  it('a pick made while a delete holds the offer waits for it, then is refused; the offer is gone', async () => {
    const r = await routingTenant();
    // The account first: its arrival delivers the outbox, which would score it against an approved offer.
    const accountId = await arrivedAccount(r);
    const p = await r.run((ctx) => createPractice(ctx, { name: 'Race' }));
    const o = await r.run((ctx) => createOffer(ctx, { name: 'Raced', practiceId: p.id, ...completeOffer }));
    await r.run((ctx) => approveOffer(ctx, o.id));

    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    let deleted!: () => void;
    const holding = new Promise<void>((done) => (deleted = done));
    const del = inTenant(r.tenantId, r.actor, async (ctx) => {
      await deleteOffer(ctx, o.id);
      deleted();
      await gate;
    });
    await Promise.race([holding, del]);
    let settled = false;
    const pick = asPerson(r, (ctx) => setLeadOffer(ctx, accountId, o.id)).finally(() => (settled = true));
    await new Promise((done) => setTimeout(done, 500));
    expect(settled).toBe(false); // FOR SHARE waits on the delete's FOR UPDATE
    release();
    await del;
    await expect(pick).rejects.toMatchObject({ status: 400 });
    const [review] = await adminDb.select().from(accountReview).where(eq(accountReview.accountId, accountId));
    expect(review!.leadOfferOverrideId).toBeNull();
    await expect(r.run((ctx) => getOffer(ctx, o.id))).rejects.toMatchObject({ status: 404 });
  }, 20_000);
});
