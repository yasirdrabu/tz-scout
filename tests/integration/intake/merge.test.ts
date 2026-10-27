import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mergeAccounts } from '@/modules/accounts';
import { getArrival, getWarmIntro, intakeSourceInfo, submitArrival } from '@/modules/intake';
import { arrival } from '@/modules/intake/db/schema';
import { closeDbs } from '@/platform/db/client';
import { runOutbox } from '../helpers/run-outbox';
import { asSource, freshTenant, personAndAgent, validArrival, type Tenant } from './helpers';

let t: Tenant;
let ash: { personId: string; agentId: string };
let bo: { personId: string; agentId: string };

afterAll(closeDbs);

beforeAll(async () => {
  t = await freshTenant();
  await runOutbox(t.tenantId);
  ash = await personAndAgent(t, 'Ash');
  bo = await personAndAgent(t, 'Bo');
});

const send = (sourceId: string, body: unknown) => asSource(t, sourceId, (ctx) => submitArrival(ctx, body, { channel: 'api' }));
const accountOf = async (arrivalId: string) => (await t.run((ctx) => getArrival(ctx, arrivalId)))!.accountId!;

describe('account merges (intake.account_merged)', () => {
  it("repoints arrivals, warm intros and duplicate candidates to the survivor, so the merged account's sources and intro carry over", async () => {
    const survivor = await send(ash.agentId, validArrival());
    const merged = await send(bo.agentId, {
      ...validArrival(),
      warm_intro: { introducer_name: 'Bo', relationship_key: 'customer_referral' },
    });
    await runOutbox(t.tenantId);
    const survivorId = await accountOf(survivor.arrivalId);
    const mergedId = await accountOf(merged.arrivalId);
    expect(await t.run((ctx) => getWarmIntro(ctx, survivorId))).toBeNull();
    const mergedIntro = (await t.run((ctx) => getWarmIntro(ctx, mergedId)))!;

    // An arrival that had considered the merged account a possible duplicate.
    const waiting = await send(ash.agentId, validArrival());
    await t.run((ctx) =>
      ctx.tx
        .update(arrival)
        .set({ duplicateCandidates: [{ accountId: mergedId, name: 'Merged', domain: null, score: 0.9 }, { accountId: 'acc_other', name: 'Other', domain: null, score: 0.9 }] })
        .where(eq(arrival.id, waiting.arrivalId)),
    );

    await t.run((ctx) => mergeAccounts({ ...ctx, access: { userId: 'usr_leader', sourceId: ash.personId, dataLimit: { kind: 'all' } } }, survivorId, mergedId));
    await runOutbox(t.tenantId);

    expect(await accountOf(merged.arrivalId)).toBe(survivorId);
    expect(await t.run((ctx) => getWarmIntro(ctx, survivorId))).toMatchObject({ warmIntroId: mergedIntro.warmIntroId, relationshipKey: 'customer_referral' });
    expect(await t.run((ctx) => getWarmIntro(ctx, mergedId))).toBeNull();
    const sources = await t.run((ctx) => intakeSourceInfo.sourcesForAccount(ctx, survivorId));
    expect(sources).toEqual(expect.arrayContaining([ash.agentId, bo.agentId, bo.personId]));
    const [row] = await t.run((ctx) => ctx.tx.select().from(arrival).where(eq(arrival.id, waiting.arrivalId)));
    expect((row!.duplicateCandidates as { accountId: string }[]).map((c) => c.accountId)).toEqual([survivorId, 'acc_other']);
  });
});
