import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { editPerson, upsertFromArrival } from '@/modules/accounts';
import { activityObserved } from '@/modules/crm/contracts/events';
import { approveOffer, createOffer, createPractice } from '@/modules/offers';
import { abandonPlan, completePlan, createTemplate, pausePlan, recordOutcome, stopPlan, updateStep } from '@/modules/playbooks';
import { accountPlan, outcome, planStep } from '@/modules/playbooks/db/schema';
import { assign, accept } from '@/modules/routing';
import { adminDb, closeDbs } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { newId } from '@/platform/ids';
import { publishTestEvent } from '../helpers/publish';
import { completeOffer } from '../offers/helpers';
import { arrivedAccount, asPerson, member, setSummary, type Tenant } from '../routing/helpers';
import { arrival, domain, routingTenant, runPlaybooks } from './helpers';

const DAY = 86_400_000;

let t: Tenant;
let seller: string;
let leader: string;
let offerId: string;
let templateId: string;
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
  templateId = (await t.run((ctx) => createTemplate(ctx, { name: 'Standard', status: 'active', stopWhen: 'reply_or_meeting', steps }))).id;
  never = (await t.run((ctx) => createTemplate(ctx, { name: 'Never', status: 'active', stopWhen: 'never', steps }))).id;
});
afterAll(closeDbs);

const asSeller = <T,>(fn: Parameters<typeof asPerson<T>>[1]) => asPerson(t, fn, { userId: seller });

/** A plan written straight to the table, on an account id that needs nothing else, with steps done at the given times. */
async function rawPlan(accountId: string, acceptedAt: Date, status = 'active', done: { channel: 'email' | 'call'; status?: string; doneAt: Date | null }[] = []) {
  const planId = newId('pln');
  const stepIds = done.map(() => newId('stp'));
  await t.run(async (ctx) => {
    await ctx.tx.insert(accountPlan).values({
      id: planId, tenantId: ctx.tenantId, accountId, templateId, templateVersion: 1, assignmentId: newId('asg'), status, stopWhen: 'reply_or_meeting', startDate: '2026-11-01', acceptedAt,
    });
    for (const [i, s] of done.entries())
      await ctx.tx.insert(planStep).values({
        id: stepIds[i]!, tenantId: ctx.tenantId, planId, order: i + 1, day: i, channel: s.channel, ownerRole: 'seller', title: `Step ${i + 1}`, dueDate: '2026-11-01', status: s.status ?? 'done', doneAt: s.doneAt,
      });
  });
  return { planId, stepIds };
}

/** A real account with an accepted plan, for the finished_at paths that go through the plan services. */
async function account(template = templateId): Promise<{ accountId: string; planId: string; stepIds: string[] }> {
  const accountId = await arrivedAccount(t, { name: 'Acme' });
  const d = domain();
  const out = await t.run((ctx) => upsertFromArrival(ctx, arrival({ account: { name: 'Acme', domain: d }, people: [{ firstName: 'Dana', lastName: 'Lee', email: `dana@${d}`, title: 'Manager' }] }), accountId));
  await asPerson(t, (ctx) => editPerson(ctx, out.personIds[0]!, { roleKeys: ['business_owner'] }));
  await setSummary(t, accountId, { tier: 'act_now', bestOfferId: offerId });
  const made = await asPerson(t, (ctx) => assign(ctx, accountId, { sellerUserId: seller, templateId: template }), { userId: leader });
  await asPerson(t, (ctx) => accept(ctx, made.id), { userId: seller, dataLimit: { kind: 'own_accounts' } });
  await runPlaybooks(t.tenantId);
  const [plan] = await t.run((ctx) => ctx.tx.select().from(accountPlan).where(eq(accountPlan.accountId, accountId)));
  const rows = await t.run((ctx) => ctx.tx.select().from(planStep).where(eq(planStep.planId, plan!.id)).orderBy(planStep.order));
  return { accountId, planId: plan!.id, stepIds: rows.map((s) => s.id) };
}

const planRow = async (planId: string) => (await t.run((ctx) => ctx.tx.select().from(accountPlan).where(eq(accountPlan.id, planId))))[0]!;
const outcomes = (accountId: string) => t.run((ctx) => ctx.tx.select().from(outcome).where(eq(outcome.accountId, accountId)));
/* eslint-disable @typescript-eslint/no-explicit-any -- event payloads are checked field by field below */
const recorded = async (accountId: string) =>
  (await adminDb.select().from(outbox).where(eq(outbox.tenantId, t.tenantId)).orderBy(outbox.seq))
    .map((r) => r.payload as { type: string; data: Record<string, any>; subject: unknown })
    .filter((e) => e.type === 'playbooks.outcome.recorded' && e.data.accountId === accountId);
/* eslint-enable @typescript-eslint/no-explicit-any */

const record = (input: Parameters<typeof recordOutcome>[1]) => t.run((ctx) => recordOutcome(ctx, input));

describe('recordOutcome', () => {
  it('records a reply on the plan accepted before it and credits its recent steps', async () => {
    const accountId = newId('acc');
    const now = Date.now();
    const { planId, stepIds } = await rawPlan(accountId, new Date(now - 30 * DAY), 'active', [
      { channel: 'call', doneAt: new Date(now - 20 * DAY) },
      { channel: 'email', doneAt: new Date(now - 3 * DAY) },
      { channel: 'email', status: 'skipped', doneAt: null },
    ]);
    const occurredAt = new Date(now - DAY);
    const out = await record({ accountId, kind: 'reply', ref: 'hubspot:act_1', occurredAt, source: 'crm' });
    expect(out).toEqual({ id: expect.stringMatching(/^out_/) });
    const [row] = await outcomes(accountId);
    expect(row).toMatchObject({ id: out!.id, planId, templateId, kind: 'reply', ref: 'hubspot:act_1', source: 'crm', amountCents: null, creditedStepIds: [stepIds[1]] });
    expect(row!.occurredAt.toISOString()).toBe(occurredAt.toISOString());
    const events = await recorded(accountId);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({
      outcomeId: out!.id, accountId, planId, templateId, kind: 'reply', occurredAt: occurredAt.toISOString(), source: 'crm', amountCents: null,
      creditedStepIds: [stepIds[1]],
    });
    expect(events[0]!.data.creditedSteps[0].channel).toBe('email');
    expect(events[0]!.subject).toEqual({ type: 'account', id: accountId });
  });

  it('the same kind and ref twice records once and publishes once', async () => {
    const accountId = newId('acc');
    await rawPlan(accountId, new Date(Date.now() - 10 * DAY));
    const input = { accountId, kind: 'won' as const, ref: 'hubspot:deal_1', occurredAt: new Date(), source: 'crm' as const, amountCents: 125_000 };
    expect(await record(input)).not.toBeNull();
    expect(await record(input)).toBeNull();
    const rows = await outcomes(accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amountCents: 125_000, creditedStepIds: [] });
    expect(await recorded(accountId)).toHaveLength(1);
    expect((await recorded(accountId))[0]!.data).toMatchObject({ amountCents: 125_000, creditedStepIds: [], creditedSteps: [] });
  });

  it('no plan accepted before occurredAt records nothing', async () => {
    const accountId = newId('acc');
    await rawPlan(accountId, new Date());
    expect(await record({ accountId, kind: 'reply', ref: 'hubspot:act_2', occurredAt: new Date(Date.now() - 3_600_000), source: 'crm' })).toBeNull();
    expect(await record({ accountId: newId('acc'), kind: 'reply', ref: 'hubspot:act_3', occurredAt: new Date(), source: 'crm' })).toBeNull();
    expect(await outcomes(accountId)).toHaveLength(0);
    expect(await recorded(accountId)).toHaveLength(0);
  });

  it('picks the later of two plans by accepted_at', async () => {
    const accountId = newId('acc');
    const now = Date.now();
    const older = await rawPlan(accountId, new Date(now - 10 * DAY), 'completed');
    const later = await rawPlan(accountId, new Date(now - 2 * DAY), 'active');
    await record({ accountId, kind: 'reply', ref: 'hubspot:act_4', occurredAt: new Date(now - DAY), source: 'crm' });
    await record({ accountId, kind: 'meeting', ref: 'hubspot:act_5', occurredAt: new Date(now - 5 * DAY), source: 'crm' });
    const rows = await outcomes(accountId);
    expect(rows.find((r) => r.kind === 'reply')!.planId).toBe(later.planId);
    expect(rows.find((r) => r.kind === 'meeting')!.planId).toBe(older.planId);
  });

  it('follows the plan by its first accept: a resume that moved accepted_at forward does not orphan an earlier reply', async () => {
    const accountId = newId('acc');
    const now = Date.now();
    const { planId } = await rawPlan(accountId, new Date(now - 30 * DAY), 'active');
    // Accepted on day 1, resumed on day 10: accepted_at moved, created_at did not.
    await t.run((ctx) => ctx.tx.update(accountPlan).set({ createdAt: new Date(now - 30 * DAY), acceptedAt: new Date(now - 20 * DAY) }).where(eq(accountPlan.id, planId)));
    expect(await record({ accountId, kind: 'reply', ref: 'hubspot:act_resume', occurredAt: new Date(now - 25 * DAY), source: 'crm' })).not.toBeNull();
    expect((await outcomes(accountId))[0]!.planId).toBe(planId);
  });

  it('with two plans, the later-started one still wins', async () => {
    const accountId = newId('acc');
    const now = Date.now();
    const first = await rawPlan(accountId, new Date(now - 30 * DAY), 'completed');
    await t.run((ctx) => ctx.tx.update(accountPlan).set({ createdAt: new Date(now - 30 * DAY), acceptedAt: new Date(now - 5 * DAY) }).where(eq(accountPlan.id, first.planId)));
    const second = await rawPlan(accountId, new Date(now - 10 * DAY), 'active');
    await t.run((ctx) => ctx.tx.update(accountPlan).set({ createdAt: new Date(now - 10 * DAY) }).where(eq(accountPlan.id, second.planId)));
    await record({ accountId, kind: 'reply', ref: 'hubspot:act_two', occurredAt: new Date(now - 2 * DAY), source: 'crm' });
    expect((await outcomes(accountId))[0]!.planId).toBe(second.planId);
  });

  it('a second opportunity on the same plan records nothing', async () => {
    const accountId = newId('acc');
    await rawPlan(accountId, new Date(Date.now() - 10 * DAY));
    expect(await record({ accountId, kind: 'opportunity', ref: 'hubspot:deal_2', occurredAt: new Date(), source: 'crm' })).not.toBeNull();
    expect(await record({ accountId, kind: 'opportunity', ref: 'hubspot:deal_3', occurredAt: new Date(), source: 'crm' })).toBeNull();
    expect(await outcomes(accountId)).toHaveLength(1);
    expect(await recorded(accountId)).toHaveLength(1);
  });

  it('RLS: another tenant cannot read outcome rows', async () => {
    const accountId = newId('acc');
    await rawPlan(accountId, new Date(Date.now() - DAY));
    await record({ accountId, kind: 'reply', ref: 'hubspot:act_6', occurredAt: new Date(), source: 'crm' });
    expect(await outcomes(accountId)).toHaveLength(1);
    const other = await routingTenant();
    expect(await other.run((ctx) => ctx.tx.select().from(outcome))).toHaveLength(0);
  });
});

describe('finished_at', () => {
  const tick = (planId: string, stepIds: string[], status: 'done' | 'skipped' | 'todo' = 'done') =>
    stepIds.reduce((p, id) => p.then(() => asSeller((ctx) => updateStep(ctx, planId, id, { status })).then(() => undefined)), Promise.resolve());

  it('finished_at is set on complete and on stop, and once', async () => {
    // Complete: the steps close while paused, so it is the completion that finishes it.
    const a = await account();
    await asSeller((ctx) => pausePlan(ctx, a.planId));
    await tick(a.planId, a.stepIds);
    expect((await planRow(a.planId)).finishedAt).toBeNull();
    await asSeller((ctx) => completePlan(ctx, a.planId));
    expect((await planRow(a.planId)).finishedAt).toEqual(expect.any(Date));

    // Stop: from an open plan.
    const b = await account();
    await t.run((ctx) => stopPlan(ctx, b.planId, 'They replied'));
    expect(await planRow(b.planId)).toMatchObject({ status: 'stopped', finishedAt: expect.any(Date) });

    // Once: finished by the last step closing, a later stop keeps the first time.
    const c = await account();
    await tick(c.planId, c.stepIds);
    const first = (await planRow(c.planId)).finishedAt;
    expect(first).toEqual(expect.any(Date));
    await t.run((ctx) => stopPlan(ctx, c.planId, 'They replied'));
    expect((await planRow(c.planId)).finishedAt).toEqual(first);
  });

  it('finished_at is set when the last open step closes on an active engaged plan', async () => {
    const { accountId, planId, stepIds } = await account(never);
    await publishTestEvent(t.tenantId, activityObserved, {
      accountId, handoffId: null, system: 'hubspot', externalId: 'act_eng', kind: 'reply', occurredAt: new Date().toISOString(),
      actorCrmOwnerId: null, actorUserId: null, taskExternalId: null, stepId: null,
    });
    await runPlaybooks(t.tenantId);
    expect(await planRow(planId)).toMatchObject({ status: 'active', engagedAt: expect.any(Date), finishedAt: null });
    await tick(planId, [stepIds[0]!]);
    expect((await planRow(planId)).finishedAt).toBeNull();
    await tick(planId, [stepIds[1]!], 'skipped');
    const first = (await planRow(planId)).finishedAt;
    expect(first).toEqual(expect.any(Date));
    expect((await planRow(planId)).noReplyAt).toBeNull();
    // Reopening a step does not clear it.
    await tick(planId, [stepIds[1]!], 'todo');
    expect((await planRow(planId)).finishedAt).toEqual(first);
  });

  it('abandon leaves finished_at null', async () => {
    const { planId, stepIds } = await account();
    await tick(planId, [stepIds[0]!]);
    await asSeller((ctx) => abandonPlan(ctx, planId, 'Wrong account'));
    expect(await planRow(planId)).toMatchObject({ status: 'abandoned', finishedAt: null });
  });
});
