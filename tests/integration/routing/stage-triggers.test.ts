import { and, eq, gt, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activityObserved } from '@/modules/crm/contracts/events';
import { assign, stageChanged } from '@/modules/routing';
import { accountReview, pipelineStage, stageChange } from '@/modules/routing/db/schema';
import { adminDb, closeDbs } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { newId } from '@/platform/ids';
import { publishTestEvent } from '../helpers/publish';
import { runOutbox } from '../helpers/run-outbox';
import { arrivedAccount, asPerson, member, routingTenant, type Tenant } from './helpers';

let t: Tenant;
let seller: string;

/** This workspace's pipeline has a "Talking" stage that owns "a reply or meeting is logged" in place of Engaged (REV-E5-S2-AC2). */
beforeAll(async () => {
  t = await routingTenant();
  seller = await member(t, 'seller');
  await t.run(async (ctx) => {
    await ctx.tx.update(pipelineStage).set({ position: sql`${pipelineStage.position} + 1` }).where(and(eq(pipelineStage.kind, 'flow'), gt(pipelineStage.position, 3)));
    await ctx.tx.update(pipelineStage).set({ trigger: 'by_hand' }).where(eq(pipelineStage.key, 'engaged'));
    await ctx.tx.insert(pipelineStage).values({ id: newId('pst'), tenantId: ctx.tenantId, key: 'stg_talking', name: 'Talking', kind: 'flow', position: 4, trigger: 'reply_or_meeting' });
  });
});
afterAll(closeDbs);

const activity = async (accountId: string, kind: 'reply' | 'meeting', actorUserId: string | null) => {
  await publishTestEvent(t.tenantId, activityObserved, {
    accountId,
    handoffId: null,
    system: 'hubspot',
    externalId: newId('cac'),
    kind,
    occurredAt: new Date().toISOString(),
    actorCrmOwnerId: null,
    actorUserId,
  });
  await runOutbox(t.tenantId);
};
const stageOf = async (accountId: string) => (await t.run((ctx) => ctx.tx.select().from(accountReview).where(eq(accountReview.accountId, accountId))))[0]!.stage;
const moves = (accountId: string) => t.run((ctx) => ctx.tx.select().from(stageChange).where(eq(stageChange.accountId, accountId)));

describe('events move accounts by the workspace’s triggers (REV-E5-S2)', () => {
  it('AC2: the next reply moves the account to the stage that now owns the trigger, history keeping names', async () => {
    const a = await arrivedAccount(t);
    await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller }));
    await activity(a, 'reply', seller);
    expect(await stageOf(a)).toBe('stg_talking');
    const rows = (await moves(a)).sort((x, y) => x.at.getTime() - y.at.getTime());
    expect(rows.map((r) => [r.fromStage, r.toStage, r.fromName, r.toName])).toEqual([
      ['arrived', 'reviewed', 'Sent', 'Reviewed'],
      ['reviewed', 'assigned', 'Reviewed', 'Assigned'],
      ['assigned', 'stg_talking', 'Assigned', 'Talking'],
    ]);
    const events = (await adminDb.select().from(outbox).where(eq(outbox.tenantId, t.tenantId)))
      .map((r) => r.payload as { type: string; data: { accountId: string; to: string; toName?: string } })
      .filter((e) => e.type === stageChanged.type && e.data.accountId === a);
    expect(events.at(-1)!.data).toMatchObject({ to: 'stg_talking', toName: 'Talking' });
  });

  it('a meeting also fires "a meeting is booked"; with no stage on it, the same stage', async () => {
    const a = await arrivedAccount(t);
    await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller }));
    await activity(a, 'meeting', seller);
    expect(await stageOf(a)).toBe('stg_talking');
  });

  it('AC4: an account at Opportunity never moves back on a reply', async () => {
    const a = await arrivedAccount(t);
    await t.run((ctx) => ctx.tx.update(accountReview).set({ stage: 'opportunity' }).where(eq(accountReview.accountId, a)));
    await activity(a, 'reply', null);
    expect(await stageOf(a)).toBe('opportunity');
  });

  it('nothing breaks for an account on a stage the workspace has since deleted', async () => {
    const a = await arrivedAccount(t);
    await t.run((ctx) => ctx.tx.update(accountReview).set({ stage: 'stg_gone' }).where(eq(accountReview.accountId, a)));
    await activity(a, 'reply', null);
    expect(await stageOf(a)).toBe('stg_gone');
  });
});
