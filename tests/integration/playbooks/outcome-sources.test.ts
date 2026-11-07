import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { editPerson, mergeAccounts, upsertFromArrival } from '@/modules/accounts';
import { activityObserved, dealChanged } from '@/modules/crm/contracts/events';
import { approveOffer, createOffer, createPractice } from '@/modules/offers';
import { completePlan, createTemplate, updateStep } from '@/modules/playbooks';
import { accountPlan, outcome, planStep } from '@/modules/playbooks/db/schema';
import { assign, accept } from '@/modules/routing';
import { closeDbs } from '@/platform/db/client';
import { publishTestEvent } from '../helpers/publish';
import { completeOffer } from '../offers/helpers';
import { arrivedAccount, asPerson, member, setSummary, type Tenant } from '../routing/helpers';
import { arrival, domain, routingTenant, runPlaybooks } from './helpers';

let t: Tenant;
let seller: string;
let leader: string;
let offerId: string;
let never: string;

const steps = [
  { day: 0, channel: 'email' as const, ownerRole: 'seller' as const, title: 'Intro', subject: 'Hello', body: 'Hi' },
  { day: 3, channel: 'call' as const, ownerRole: 'seller' as const, title: 'Call' },
];

beforeAll(async () => {
  t = await routingTenant();
  seller = await member(t, 'seller');
  leader = await member(t, 'leader');
  const practice = await t.run((ctx) => createPractice(ctx, { name: 'Main' }));
  offerId = (await t.run(async (ctx) => approveOffer(ctx, (await createOffer(ctx, { name: 'Pilot', practiceId: practice.id, ...completeOffer })).id))).id;
  never = (await t.run((ctx) => createTemplate(ctx, { name: 'Never', status: 'active', stopWhen: 'never', steps }))).id;
});
afterAll(closeDbs);

const asSeller = <T,>(fn: Parameters<typeof asPerson<T>>[1]) => asPerson(t, fn, { userId: seller });

/** A scored account with an accepted plan on the never-stop template. */
async function account(): Promise<{ accountId: string; planId: string; stepIds: string[] }> {
  const accountId = await arrivedAccount(t, { name: 'Acme' });
  const d = domain();
  const out = await t.run((ctx) => upsertFromArrival(ctx, arrival({ account: { name: 'Acme', domain: d }, people: [{ firstName: 'Dana', lastName: 'Lee', email: `dana@${d}`, title: 'Manager' }] }), accountId));
  await asPerson(t, (ctx) => editPerson(ctx, out.personIds[0]!, { roleKeys: ['business_owner'] }));
  await setSummary(t, accountId, { tier: 'act_now', bestOfferId: offerId });
  const made = await asPerson(t, (ctx) => assign(ctx, accountId, { sellerUserId: seller, templateId: never }), { userId: leader });
  await asPerson(t, (ctx) => accept(ctx, made.id), { userId: seller, dataLimit: { kind: 'own_accounts' } });
  await runPlaybooks(t.tenantId);
  const [plan] = await t.run((ctx) => ctx.tx.select().from(accountPlan).where(eq(accountPlan.accountId, accountId)));
  const rows = await t.run((ctx) => ctx.tx.select().from(planStep).where(eq(planStep.planId, plan!.id)).orderBy(planStep.order));
  return { accountId, planId: plan!.id, stepIds: rows.map((s) => s.id) };
}

const outcomes = (accountId: string) => t.run((ctx) => ctx.tx.select().from(outcome).where(eq(outcome.accountId, accountId)).orderBy(outcome.kind));
const kinds = async (accountId: string) => (await outcomes(accountId)).map((o) => o.kind);

type Kind = 'email' | 'reply' | 'call' | 'meeting' | 'task_done';
async function observe(accountId: string, kind: Kind, over: { externalId?: string; occurredAt?: Date } = {}): Promise<void> {
  await publishTestEvent(t.tenantId, activityObserved, {
    accountId,
    handoffId: null,
    system: 'hubspot',
    externalId: over.externalId ?? `act_${Math.random().toString(36).slice(2)}`,
    kind,
    occurredAt: (over.occurredAt ?? new Date()).toISOString(),
    actorCrmOwnerId: null,
    actorUserId: null,
    taskExternalId: kind === 'task_done' ? 'task_1' : null,
    stepId: null,
  });
  await runPlaybooks(t.tenantId);
}

type Deal = Partial<{ id: string; status: 'open' | 'won' | 'lost'; previousStatus: 'open' | 'won' | 'lost' | null; amountCents: number | null; openedAt: Date | null; closedAt: Date | null }>;
async function deal(accountId: string, d: Deal = {}): Promise<void> {
  await publishTestEvent(t.tenantId, dealChanged, {
    accountId,
    system: 'hubspot',
    dealExternalId: `${accountId}_${d.id ?? 'deal_1'}`,
    status: d.status ?? 'open',
    previousStatus: d.previousStatus ?? null,
    stage: null,
    amountCents: d.amountCents === undefined ? null : d.amountCents,
    currency: 'USD',
    openedAt: d.openedAt?.toISOString() ?? null,
    closedAt: d.closedAt?.toISOString() ?? null,
    companyLifecycle: 'none',
    observedAt: new Date().toISOString(),
  });
  await runPlaybooks(t.tenantId);
}

describe('CRM activity outcomes', () => {
  it('a reply after accept records reply with credit', async () => {
    const { accountId, planId, stepIds } = await account();
    await asSeller((ctx) => updateStep(ctx, planId, stepIds[0]!, { status: 'done' }));
    await observe(accountId, 'reply', { externalId: 'act_r1' });
    const [o] = await outcomes(accountId);
    expect(o).toMatchObject({ kind: 'reply', planId, ref: 'hubspot:act_r1', source: 'crm', creditedStepIds: [stepIds[0]] });
  });

  it('a reply before accept records nothing', async () => {
    const { accountId } = await account();
    await observe(accountId, 'reply', { occurredAt: new Date(Date.now() - 30 * 86_400_000) });
    expect(await kinds(accountId)).toEqual([]);
  });

  it('a reply on a completed plan still records on that plan', async () => {
    const { accountId, planId, stepIds } = await account();
    for (const id of stepIds) await asSeller((ctx) => updateStep(ctx, planId, id, { status: 'skipped' }));
    await asSeller((ctx) => completePlan(ctx, planId));
    await observe(accountId, 'reply');
    // Closing the last step also recorded the plan's no_response; the reply lands on the same plan.
    expect((await outcomes(accountId)).filter((o) => o.kind === 'reply')).toEqual([expect.objectContaining({ planId })]);
  });

  it('a meeting records meeting once even when its activity is observed again', async () => {
    const { accountId } = await account();
    await observe(accountId, 'meeting', { externalId: 'act_m1' });
    await observe(accountId, 'meeting', { externalId: 'act_m1' });
    expect(await kinds(accountId)).toEqual(['meeting']);
  });

  it('task_done and email record nothing', async () => {
    const { accountId } = await account();
    await observe(accountId, 'task_done');
    await observe(accountId, 'email');
    expect(await kinds(accountId)).toEqual([]);
  });
});

describe('deal outcomes', () => {
  it('first open deal records opportunity; a second deal does not', async () => {
    const { accountId, planId } = await account();
    const openedAt = new Date(Date.now() + 1000);
    await deal(accountId, { id: 'd1', openedAt });
    await deal(accountId, { id: 'd2' });
    const rows = await outcomes(accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'opportunity', planId, ref: `hubspot:${accountId}_d1`, occurredAt: openedAt });
  });

  it('a deal going open to won records won with amountCents and occurredAt = closedAt', async () => {
    const { accountId } = await account();
    const closedAt = new Date(Date.now() + 60_000);
    await deal(accountId, { id: 'd1' });
    await deal(accountId, { id: 'd1', status: 'won', previousStatus: 'open', amountCents: 500_000, closedAt });
    const rows = await outcomes(accountId);
    expect(rows.map((o) => o.kind)).toEqual(['opportunity', 'won']);
    expect(rows[1]).toMatchObject({ amountCents: 500_000, occurredAt: closedAt });
  });

  it('a deal open and then lost, never won, records opportunity and then lost', async () => {
    const { accountId } = await account();
    const closedAt = new Date(Date.now() + 60_000);
    await deal(accountId, { id: 'd1' });
    await deal(accountId, { id: 'd1', status: 'lost', previousStatus: 'open', closedAt });
    const rows = await outcomes(accountId);
    expect(rows.map((o) => o.kind)).toEqual(['lost', 'opportunity']);
    expect(rows.find((o) => o.kind === 'lost')).toMatchObject({ occurredAt: closedAt });
  });

  it('a deal arriving already won records opportunity and won', async () => {
    const { accountId } = await account();
    await deal(accountId, { id: 'd1', status: 'won', amountCents: 100, closedAt: new Date() });
    expect(await kinds(accountId)).toEqual(['opportunity', 'won']);
  });

  it('a redelivered won deal records won once', async () => {
    const { accountId } = await account();
    const closedAt = new Date();
    await deal(accountId, { id: 'd1', status: 'won', previousStatus: 'open', amountCents: 100, closedAt });
    await deal(accountId, { id: 'd1', status: 'won', previousStatus: 'open', amountCents: 100, closedAt });
    expect(await kinds(accountId)).toEqual(['opportunity', 'won']);
  });

  it('lost records lost', async () => {
    const { accountId } = await account();
    await deal(accountId, { id: 'd1', status: 'lost', previousStatus: 'open', closedAt: new Date() });
    expect(await kinds(accountId)).toEqual(['lost']);
  });
});

describe('no_response and merge', () => {
  it('the last step closing with no reply records no_response with ref = planId', async () => {
    const { accountId, planId, stepIds } = await account();
    for (const id of stepIds) await asSeller((ctx) => updateStep(ctx, planId, id, { status: 'done' }));
    const [o] = await outcomes(accountId);
    expect(o).toMatchObject({ kind: 'no_response', ref: planId, planId, source: 'playbooks' });
    const [p] = await t.run((ctx) => ctx.tx.select().from(accountPlan).where(eq(accountPlan.id, planId)));
    expect(o!.occurredAt).toEqual(p!.noReplyAt);
  });

  it('merge moves outcomes to the survivor', async () => {
    const a = await account();
    const b = await account();
    await observe(b.accountId, 'reply');
    await asPerson(t, (ctx) => mergeAccounts(ctx, a.accountId, b.accountId));
    await runPlaybooks(t.tenantId);
    expect(await kinds(b.accountId)).toEqual([]);
    expect(await kinds(a.accountId)).toEqual(['reply']);
  });
});
