// R3b-2 final review I3: the whole chain, with the real consumers. Accounts won -> computeTrust -> trust_changed -> rescore -> the Source trust tile.
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import '@/entry/compose';
import { computeTrust, getArrival, registerSource, submitArrival } from '@/modules/intake';
import { approveOffer, createOffer, createPractice } from '@/modules/offers';
import { stageChange } from '@/modules/routing/db/schema';
import { explainScore } from '@/modules/scoring';
import { accountScore, scoreChange } from '@/modules/scoring/db/schema';
import { closeDbs } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { completeOffer, freshTenant } from '../offers/helpers';

afterAll(closeDbs);

describe('learned trust reaches the score', () => {
  it('won accounts move the source trust, rescore the source accounts and set the tile note and breakdown', async () => {
    const t = await freshTenant();
    await runOutbox(t.tenantId);
    const practice = await t.run((ctx) => createPractice(ctx, { name: 'Chain Practice', slug: `p-${newId('prc').slice(-8).toLowerCase()}` }));
    const offer = await t.run((ctx) => createOffer(ctx, { name: 'Lead', practiceId: practice.id, ...completeOffer }));
    await t.run((ctx) => approveOffer(ctx, offer.id));
    await runOutbox(t.tenantId);

    const [person, agent] = await t.run(async (ctx) => {
      const p = await registerSource(ctx, { kind: 'person', name: 'Chain Ash' });
      const a = await registerSource(ctx, { kind: 'agent', name: 'Chain agent', parentId: p.id });
      return [p.id, a.id] as const;
    });
    const accounts: string[] = [];
    for (let i = 0; i < 3; i++) {
      const sent = await t.run((ctx) =>
        submitArrival(
          { ...ctx, access: { sourceId: agent, dataLimit: { kind: 'own_source' } } },
          { account: { name: `Chain Co ${i}`, domain: `${newId('acc').slice(-10).toLowerCase()}-example.com`, industry: 'Logistics' } },
          { channel: 'api' },
        ),
      );
      await runOutbox(t.tenantId);
      accounts.push((await t.run((ctx) => getArrival(ctx, sent.arrivalId)))!.accountId!);
    }
    const current = (id: string) =>
      t.run(async (ctx) => (await ctx.tx.select().from(accountScore).where(and(eq(accountScore.tenantId, ctx.tenantId), eq(accountScore.accountId, id))))[0]!);
    expect((await current(accounts[0]!)).trustScore).toBe(60);

    const after = new Date(Date.now() + 1_000);
    for (const accountId of accounts) {
      await t.run((ctx) => ctx.tx.insert(stageChange).values({ id: newId('stc'), tenantId: ctx.tenantId, accountId, fromStage: 'arrived', toStage: 'won', causeEventId: newId('evt'), at: after }));
    }
    const results = await t.run((ctx) => computeTrust(ctx, { cause: 'outcomes', sourceIds: [agent, person], now: new Date(after.getTime() + 1_000) }));
    const res = results.find((r) => r.sourceId === agent)!;
    expect(res).toMatchObject({ sampleSize: 3, published: true });
    expect(res.to).toBeGreaterThan(0.65);

    await runOutbox(t.tenantId);
    const scored = await current(accounts[0]!);
    expect(scored.trustScore).toBe(Math.round(res.to * 100));
    expect(scored.trustSourceId).toBe(agent);
    const changes = await t.run((ctx) => ctx.tx.select().from(scoreChange).where(eq(scoreChange.accountId, accounts[0]!)));
    expect(changes.some((c) => c.cause === 'trust_changed')).toBe(true);

    const tile = (await t.run((ctx) => explainScore(ctx, accounts[0]!)))!.tiles.find((x) => x.key === 'source_trust')!;
    expect(tile.note).toBe('Chain agent: 3 won of 3 sent');
    expect(tile.breakdown).toBeTruthy();
  });
});
