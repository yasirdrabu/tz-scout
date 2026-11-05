import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activityObserved } from '@/modules/crm/contracts/events';
import { planNoReply } from '@/modules/playbooks/contracts/events';
import { accept, assign, stageChanged } from '@/modules/routing';
import { onPlanNoReply } from '@/modules/routing/services/crm-events';
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
    const events = (await adminDb.select().from(outbox).where(eq(outbox.tenantId, t.tenantId)).orderBy(asc(outbox.seq)))
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

describe('a playbook ending with no reply moves the account to the exit that owns the trigger', () => {
  const noReply = async (tenant: Tenant, accountId: string) => {
    await publishTestEvent(tenant.tenantId, planNoReply, { planId: newId('pln'), accountId, assignmentId: newId('asg'), at: new Date().toISOString() });
    await runOutbox(tenant.tenantId);
  };
  const stageIn = async (tenant: Tenant, accountId: string) => (await tenant.run((ctx) => ctx.tx.select().from(accountReview).where(eq(accountReview.accountId, accountId))))[0]!.stage;
  const movesIn = (tenant: Tenant, accountId: string) => tenant.run((ctx) => ctx.tx.select().from(stageChange).where(eq(stageChange.accountId, accountId)));
  const accepted = async (tenant: Tenant, sellerId: string) => {
    const a = await arrivedAccount(tenant);
    const made = await asPerson(tenant, (ctx) => assign(ctx, a, { sellerUserId: sellerId }));
    await asPerson(tenant, (ctx) => accept(ctx, made.id), { userId: sellerId });
    await runOutbox(tenant.tenantId);
    return a;
  };

  it('an accepted account goes to Back to nurture', async () => {
    const d = await routingTenant();
    const a = await accepted(d, await member(d, 'seller'));
    const before = (await movesIn(d, a)).length;
    await noReply(d, a);
    expect(await stageIn(d, a)).toBe('back_to_nurture');
    expect(await movesIn(d, a)).toHaveLength(before + 1);
  });

  it('the same event delivered twice moves the account once', async () => {
    const d = await routingTenant();
    const a = await accepted(d, await member(d, 'seller'));
    const before = (await movesIn(d, a)).length;
    const at = new Date().toISOString();
    const e = { id: newId('evt'), type: planNoReply.type, schemaVersion: 1, tenantId: d.tenantId, occurredAt: at, actor: { kind: 'system' as const, id: 'test' }, correlationId: newId('cor'), data: { planId: newId('pln'), accountId: a, assignmentId: newId('asg'), at } };
    await d.run((ctx) => onPlanNoReply(e, ctx));
    await d.run((ctx) => onPlanNoReply(e, ctx));
    expect(await stageIn(d, a)).toBe('back_to_nurture');
    const rows = await movesIn(d, a);
    expect(rows).toHaveLength(before + 1);
    expect(rows.filter((r) => r.causeEventId === e.id)).toHaveLength(1);
  });

  it('an account already in the exit stays put when another plan ends with no reply', async () => {
    const d = await routingTenant();
    const a = await accepted(d, await member(d, 'seller'));
    await noReply(d, a);
    const after = (await movesIn(d, a)).length;
    await noReply(d, a);
    expect(await stageIn(d, a)).toBe('back_to_nurture');
    expect(await movesIn(d, a)).toHaveLength(after);
  });

  it('an Engaged account stays where it is', async () => {
    const d = await routingTenant();
    const s = await member(d, 'seller');
    const a = await accepted(d, s);
    await publishTestEvent(d.tenantId, activityObserved, { accountId: a, handoffId: null, system: 'hubspot', externalId: newId('cac'), kind: 'reply', occurredAt: new Date().toISOString(), actorCrmOwnerId: null, actorUserId: s });
    await runOutbox(d.tenantId);
    expect(await stageIn(d, a)).toBe('engaged');
    await noReply(d, a);
    expect(await stageIn(d, a)).toBe('engaged');
  });

  it('a reply after it went back to nurture moves the account to Engaged', async () => {
    const d = await routingTenant();
    const s = await member(d, 'seller');
    const a = await accepted(d, s);
    await noReply(d, a);
    expect(await stageIn(d, a)).toBe('back_to_nurture');
    await publishTestEvent(d.tenantId, activityObserved, { accountId: a, handoffId: null, system: 'hubspot', externalId: newId('cac'), kind: 'reply', occurredAt: new Date().toISOString(), actorCrmOwnerId: null, actorUserId: s });
    await runOutbox(d.tenantId);
    expect(await stageIn(d, a)).toBe('engaged');
  });

  it('a workspace that gave the trigger to another exit moves there, whatever its key', async () => {
    const w = await routingTenant();
    await w.run(async (ctx) => {
      await ctx.tx.update(pipelineStage).set({ trigger: 'by_hand' }).where(eq(pipelineStage.key, 'back_to_nurture'));
      await ctx.tx.insert(pipelineStage).values({ id: newId('pst'), tenantId: ctx.tenantId, key: 'stg_cold', name: 'Gone cold', kind: 'exit', position: 5, trigger: 'playbook_no_reply' });
    });
    const a = await accepted(w, await member(w, 'seller'));
    await noReply(w, a);
    expect(await stageIn(w, a)).toBe('stg_cold');
  });
});
