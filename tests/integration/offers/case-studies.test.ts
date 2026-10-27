import { beforeAll, describe, expect, it } from 'vitest';
import {
  archiveCaseStudy,
  createCaseStudy,
  createOffer,
  createPractice,
  linkCaseStudy,
  listCaseStudies,
  listOffers,
  matchCaseStudies,
  unlinkCaseStudy,
  updateCaseStudy,
} from '@/modules/offers';
import { completeOffer, freshTenant } from './helpers';

let t: Awaited<ReturnType<typeof freshTenant>>;
let offerId: string;
let otherOfferId: string;

beforeAll(async () => {
  t = await freshTenant();
  const p = await t.run((ctx) => createPractice(ctx, { name: 'Proof Practice' }));
  offerId = (await t.run((ctx) => createOffer(ctx, { name: 'Offer A', practiceId: p.id, ...completeOffer }))).id;
  otherOfferId = (await t.run((ctx) => createOffer(ctx, { name: 'Offer B', practiceId: p.id, ...completeOffer }))).id;
});

describe('OFF-E3-S1 case studies', () => {
  it('AC1: public defaults to false', async () => {
    const cs = await t.run((ctx) => createCaseStudy(ctx, { title: 'Fleet routing', clientName: 'Acme', industry: 'logistics' }));
    expect(cs.id).toMatch(/^cs_/);
    expect(cs.public).toBe(false);
    expect(cs.archivedAt).toBeNull();
    const shown = await t.run((ctx) => updateCaseStudy(ctx, cs.id, { public: true, result: 'Cut cost 30%' }));
    expect(shown).toMatchObject({ public: true, result: 'Cut cost 30%' });
  });

  it('a case study needs a title', async () => {
    await expect(t.run((ctx) => createCaseStudy(ctx, { title: ' ' }))).rejects.toMatchObject({ status: 400 });
  });

  it('AC2: links to many offers and lists from both sides; linking twice is harmless', async () => {
    const cs = await t.run((ctx) => createCaseStudy(ctx, { title: 'Two offers' }));
    await t.run((ctx) => linkCaseStudy(ctx, offerId, cs.id));
    await t.run((ctx) => linkCaseStudy(ctx, offerId, cs.id));
    await t.run((ctx) => linkCaseStudy(ctx, otherOfferId, cs.id));
    expect((await t.run((ctx) => listCaseStudies(ctx, { offerId }))).map((c) => c.id)).toContain(cs.id);
    expect((await t.run((ctx) => listCaseStudies(ctx, { offerId: otherOfferId }))).map((c) => c.id)).toContain(cs.id);
    const offers = await t.run((ctx) => listOffers(ctx, { caseStudyId: cs.id }));
    expect(offers.map((o) => o.id).sort()).toEqual([offerId, otherOfferId].sort());
    await t.run((ctx) => unlinkCaseStudy(ctx, offerId, cs.id));
    expect((await t.run((ctx) => listCaseStudies(ctx, { offerId }))).map((c) => c.id)).not.toContain(cs.id);
  });

  it('link refuses an offer or case study that is not in the tenant', async () => {
    const cs = await t.run((ctx) => createCaseStudy(ctx, { title: 'Mine' }));
    await expect(t.run((ctx) => linkCaseStudy(ctx, 'off_missing', cs.id))).rejects.toMatchObject({ status: 404 });
    await expect(t.run((ctx) => linkCaseStudy(ctx, offerId, 'cs_missing'))).rejects.toMatchObject({ status: 404 });
  });

  it('AC3: archiving removes it from lists and future matches but keeps the row and links', async () => {
    const cs = await t.run((ctx) => createCaseStudy(ctx, { title: 'Soon archived', industry: 'retail' }));
    await t.run((ctx) => linkCaseStudy(ctx, offerId, cs.id));
    await t.run((ctx) => archiveCaseStudy(ctx, cs.id));
    expect((await t.run((ctx) => listCaseStudies(ctx, { offerId }))).map((c) => c.id)).not.toContain(cs.id);
    expect((await t.run((ctx) => matchCaseStudies(ctx, offerId, 'retail', 10))).map((c) => c.id)).not.toContain(cs.id);
    const all = await t.run((ctx) => listCaseStudies(ctx, { includeArchived: true }));
    expect(all.find((c) => c.id === cs.id)?.archivedAt).toBeInstanceOf(Date);
  });
});

describe('OFF-E3-S2 matchCaseStudies', () => {
  let t2: Awaited<ReturnType<typeof freshTenant>>;
  let o: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    t2 = await freshTenant();
    const p = await t2.run((ctx) => createPractice(ctx, { name: 'P' }));
    o = (await t2.run((ctx) => createOffer(ctx, { name: 'O', practiceId: p.id, ...completeOffer }))).id;
    // Created oldest to newest.
    for (const [key, industry, isPublic] of [
      ['retail', 'Retail', true],
      ['logistics', 'Logistics', false],
      ['finance', 'Finance', true],
      ['gone', 'Logistics', true],
    ] as const) {
      const cs = await t2.run((ctx) => createCaseStudy(ctx, { title: key, industry, public: isPublic }));
      ids[key] = cs.id;
      await t2.run((ctx) => linkCaseStudy(ctx, o, cs.id));
    }
    await t2.run((ctx) => archiveCaseStudy(ctx, ids.gone!));
  });

  it('AC1: the logistics case study comes first, then the most recent; an archived one is left out', async () => {
    const rows = await t2.run((ctx) => matchCaseStudies(ctx, o, 'logistics', 10));
    expect(rows.map((r) => r.id)).toEqual([ids.logistics, ids.finance, ids.retail]);
  });

  it('respects the limit', async () => {
    const rows = await t2.run((ctx) => matchCaseStudies(ctx, o, 'logistics', 2));
    expect(rows.map((r) => r.id)).toEqual([ids.logistics, ids.finance]);
  });

  it('AC2: buyerVisibleOnly returns only public case studies', async () => {
    const rows = await t2.run((ctx) => matchCaseStudies(ctx, o, 'logistics', 10, { buyerVisibleOnly: true }));
    expect(rows.map((r) => r.id)).toEqual([ids.finance, ids.retail]);
  });

  it('a missing industry just orders by recency', async () => {
    const rows = await t2.run((ctx) => matchCaseStudies(ctx, o, null, 10));
    expect(rows.map((r) => r.id)).toEqual([ids.finance, ids.logistics, ids.retail]);
  });

  it('another tenant gets nothing', async () => {
    const other = await freshTenant();
    expect(await other.run((ctx) => matchCaseStudies(ctx, o, 'logistics', 10))).toEqual([]);
  });
});
