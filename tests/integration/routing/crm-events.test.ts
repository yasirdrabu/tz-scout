import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activityObserved, dealChanged, handoffCancelled, handoffCompleted, handoffFailed, handoffNeedsDecision } from '@/modules/crm/contracts/events';
import { assign, decline } from '@/modules/routing';
import { accountReview, assignment, stageChange } from '@/modules/routing/db/schema';
import { closeDbs } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { publishTestEvent } from '../helpers/publish';
import { runOutbox } from '../helpers/run-outbox';
import { arrivedAccount, asPerson, member, routingTenant, summaryOf, type Tenant } from './helpers';

let t: Tenant;
let seller: string;
let other: string;

beforeAll(async () => {
  t = await routingTenant();
  seller = await member(t, 'seller');
  other = await member(t, 'seller');
});
afterAll(closeDbs);

const reviewOf = async (accountId: string) => (await t.run((ctx) => ctx.tx.select().from(accountReview).where(eq(accountReview.accountId, accountId))))[0]!;
const assignmentOf = async (accountId: string) => (await t.run((ctx) => ctx.tx.select().from(assignment).where(eq(assignment.accountId, accountId))))[0]!;
const moves = (accountId: string) => t.run((ctx) => ctx.tx.select().from(stageChange).where(eq(stageChange.accountId, accountId)));

async function assigned(): Promise<string> {
  const a = await arrivedAccount(t);
  await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller }));
  return a;
}

const activity = async (accountId: string, kind: 'email' | 'reply' | 'call' | 'meeting' | 'task_done', actorUserId: string | null) => {
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

const deal = async (accountId: string, status: 'open' | 'won' | 'lost', dealExternalId = 'd1') => {
  await publishTestEvent(t.tenantId, dealChanged, {
    accountId,
    system: 'hubspot',
    dealExternalId,
    status,
    previousStatus: null,
    stage: null,
    amountCents: null,
    currency: null,
    openedAt: null,
    closedAt: null,
    companyLifecycle: 'open_deal',
    observedAt: new Date().toISOString(),
  });
  await runOutbox(t.tenantId);
};

describe('implied acceptance and engagement (REV-E4-S1, REV-E2)', () => {
  it('the assigned seller email accepts the assignment with crm_activity and moves the stage to assigned', async () => {
    const a = await assigned();
    await activity(a, 'email', seller);
    expect(await assignmentOf(a)).toMatchObject({ status: 'accepted', acceptedHow: 'crm_activity' });
    expect((await reviewOf(a)).stage).toBe('assigned');
  });

  it('another rep activity does not accept', async () => {
    const a = await assigned();
    await activity(a, 'email', other);
    await activity(a, 'email', null);
    expect(await assignmentOf(a)).toMatchObject({ status: 'pending', acceptedHow: null });
    expect((await reviewOf(a)).stage).toBe('reviewed');
  });

  it('a reply engages once, and a repeat moves nothing (AC2)', async () => {
    const a = await assigned();
    await activity(a, 'reply', seller);
    expect(await assignmentOf(a)).toMatchObject({ status: 'accepted', acceptedHow: 'crm_activity' });
    expect((await reviewOf(a)).stage).toBe('engaged');
    const before = (await moves(a)).length;
    await activity(a, 'reply', seller);
    await activity(a, 'meeting', seller);
    expect((await moves(a)).length).toBe(before);
    expect((await reviewOf(a)).stage).toBe('engaged');
  });

  it('an email from the seller after they declined accepts nothing', async () => {
    const a = await assigned();
    const asg = await assignmentOf(a);
    await asPerson(t, (ctx) => decline(ctx, asg.id, { reasonKey: 'not_a_fit' }), { userId: seller, dataLimit: { kind: 'own_accounts' } });
    await activity(a, 'email', seller);
    expect((await assignmentOf(a)).status).toBe('declined');
  });
});

describe('deals', () => {
  it('open, won and lost move the stage, and a new open deal after lost gives opportunity', async () => {
    const a = await assigned();
    await deal(a, 'open');
    expect((await reviewOf(a)).stage).toBe('opportunity');
    await deal(a, 'lost', 'd1');
    expect((await reviewOf(a)).stage).toBe('lost');
    await deal(a, 'open', 'd2');
    expect((await reviewOf(a)).stage).toBe('opportunity');
    await deal(a, 'won', 'd2');
    expect((await reviewOf(a)).stage).toBe('won');
  });
});

describe('handoff state (Ruling 19)', () => {
  it('assign sets sending; needs_decision sets the flag and the reason', async () => {
    const a = await assigned();
    expect((await reviewOf(a)).flags.handoff).toMatchObject({ state: 'sending' });
    await runOutbox(t.tenantId); // the real push has said its piece; later events win
    await publishTestEvent(t.tenantId, handoffNeedsDecision, { handoffId: 'hof_1', accountId: a, assignmentId: 'asg_x', reason: 'open_deal', currentOwnerName: 'Vijay Kumar' });
    await runOutbox(t.tenantId);
    expect((await reviewOf(a)).flags.handoff).toMatchObject({ handoffId: 'hof_1', state: 'needs_decision', reason: 'open_deal', currentOwnerName: 'Vijay Kumar' });
    expect((await summaryOf(t, a)).reviewFlags).toContain('handoff_needs_decision');
  });

  it('completed after failed with a later at gives in_crm, and an older event is ignored', async () => {
    const a = await assigned();
    await runOutbox(t.tenantId);
    await publishTestEvent(t.tenantId, handoffFailed, { handoffId: 'hof_2', accountId: a, assignmentId: 'asg_x', system: 'hubspot', attempt: 3, retryable: false, reason: 'Token refused' });
    await runOutbox(t.tenantId);
    expect((await reviewOf(a)).flags.handoff).toMatchObject({ state: 'failed', reason: 'Token refused' });
    expect((await summaryOf(t, a)).reviewFlags).toContain('handoff_failed');

    await publishTestEvent(t.tenantId, handoffCompleted, {
      handoffId: 'hof_2',
      accountId: a,
      assignmentId: 'asg_x',
      handoffBatchId: null,
      system: 'hubspot',
      companyExternalId: 'c1',
      personExternalIds: [],
      ownerExternalId: null,
      ownershipAction: 'assign',
      takenFromOwner: null,
      taskCount: 0,
      companyLifecycle: 'none',
      observedAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await runOutbox(t.tenantId);
    expect((await reviewOf(a)).flags.handoff).toMatchObject({ state: 'in_crm' });
    expect((await summaryOf(t, a)).reviewFlags).not.toContain('handoff_failed');

    await publishTestEvent(t.tenantId, handoffCancelled, { handoffId: 'hof_2', accountId: a, assignmentId: 'asg_x', at: new Date(Date.now() - 3_600_000).toISOString() });
    await runOutbox(t.tenantId);
    expect((await reviewOf(a)).flags.handoff).toMatchObject({ state: 'in_crm' });

    await publishTestEvent(t.tenantId, handoffCancelled, { handoffId: 'hof_2', accountId: a, assignmentId: 'asg_x', at: new Date(Date.now() + 120_000).toISOString() });
    await runOutbox(t.tenantId);
    expect((await reviewOf(a)).flags.handoff).toMatchObject({ state: 'cancelled' });
  });
});
