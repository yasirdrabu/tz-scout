import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { TAAZAA_OFFERS, TAAZAA_PRACTICES, listOffers, listPractices, seedOffers } from '@/modules/offers';
import { offer, practice } from '@/modules/offers/db/schema';
import { freshTenant } from './helpers';

let t: Awaited<ReturnType<typeof freshTenant>>;
beforeAll(async () => {
  t = await freshTenant();
});

describe('Taazaa catalogue seed', () => {
  it('twice leaves 4 practices and the same offers, with Modernization Blueprint approved', async () => {
    await t.run((ctx) => seedOffers(ctx));
    const first = await t.run((ctx) => listOffers(ctx));
    await t.run((ctx) => seedOffers(ctx));
    const second = await t.run((ctx) => listOffers(ctx));
    expect(TAAZAA_PRACTICES).toHaveLength(4);
    expect(await t.run((ctx) => listPractices(ctx))).toHaveLength(4);
    expect(second).toHaveLength(TAAZAA_OFFERS.length);
    expect(second.map((o) => o.id).sort()).toEqual(first.map((o) => o.id).sort());

    const rows = await t.run((ctx) =>
      ctx.tx
        .select({ name: offer.name, status: offer.status, practice: practice.slug })
        .from(offer)
        .innerJoin(practice, eq(practice.id, offer.practiceId))
        .where(and(eq(offer.tenantId, ctx.tenantId), eq(offer.slug, 'modernization-blueprint'))),
    );
    expect(rows).toEqual([{ name: 'Modernization Blueprint', status: 'approved', practice: 'ai-operating-platforms' }]);
  });

  it('keeps the draft offers draft and links each case study once', async () => {
    const drafts = await t.run((ctx) => listOffers(ctx, { status: 'draft' }));
    expect(drafts.map((o) => o.slug).sort()).toEqual([
      'ai-data-readiness-assessment',
      'company-brain',
      'gtm-audit-pilot',
    ]);
    const rows = (await t.run((ctx) =>
      ctx.tx.execute(sql`select count(*)::int as n from offers.offer_case_study where tenant_id = ${ctx.tenantId}`),
    )) as unknown as { n: number }[];
    expect(rows[0]!.n).toBe(TAAZAA_OFFERS.reduce((sum, o) => sum + o.cases.length, 0));
  });
});
