import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { editPerson, upsertFromArrival } from '@/modules/accounts';
import { activityObserved } from '@/modules/crm/contracts/events';
import { approveOffer, createOffer, createPractice } from '@/modules/offers';
import { abandonPlan, completePlan, createTemplate, removeStep, resumePlan, pausePlan, updateStep } from '@/modules/playbooks';
import { accountPlan, planChange, planStep } from '@/modules/playbooks/db/schema';
import { assign, accept, withdraw } from '@/modules/routing';
import { adminDb, closeDbs } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { publishTestEvent } from '../helpers/publish';
import { completeOffer } from '../offers/helpers';
import { arrivedAccount, asPerson, member, setSummary, type Tenant } from '../routing/helpers';
import { arrival, domain, routingTenant, runPlaybooks } from './helpers';

let t: Tenant;
let seller: string;
let leader: string;
let offerId: string;
let replyOrMeeting: string;
let meetingOnly: string;
let never: string;

const steps = [
  { day: 0, channel: 'email' as const, ownerRole: 'seller' as const, title: 'Intro', subject: 'Hello', body: 'Hi' },
  { day: 3, channel: 'call' as const, ownerRole: 'seller' as const, title: 'Call' },
  { day: 7, channel: 'email' as const, ownerRole: 'seller' as const, title: 'Follow up', subject: 'Again', body: 'Hi again' },
];

beforeAll(async () => {
  t = await routingTenant();
  seller = await member(t, 'seller');
  leader = await member(t, 'leader');
  const practice = await t.run((ctx) => createPractice(ctx, { name: 'Main' }));
  offerId = (await t.run(async (ctx) => approveOffer(ctx, (await createOffer(ctx, { name: 'Pilot', practiceId: practice.id, ...completeOffer })).id))).id;
  const make = (name: string, stopWhen: 'reply_or_meeting' | 'meeting' | 'never') => t.run((ctx) => createTemplate(ctx, { name, status: 'active', stopWhen, steps })).then((x) => x.id);
  replyOrMeeting = await make('Reply or meeting', 'reply_or_meeting');
  meetingOnly = await make('Meeting only', 'meeting');
  never = await make('Never', 'never');
});
afterAll(closeDbs);

const asSeller = <T,>(fn: Parameters<typeof asPerson<T>>[1]) => asPerson(t, fn, { userId: seller });

/** A scored account with an accepted plan on the given template. */
async function account(templateId = replyOrMeeting): Promise<{ accountId: string; assignmentId: string; planId: string; stepIds: string[] }> {
  const accountId = await arrivedAccount(t, { name: 'Acme' });
  const d = domain();
  const out = await t.run((ctx) => upsertFromArrival(ctx, arrival({ account: { name: 'Acme', domain: d }, people: [{ firstName: 'Dana', lastName: 'Lee', email: `dana@${d}`, title: 'Manager' }] }), accountId));
  await asPerson(t, (ctx) => editPerson(ctx, out.personIds[0]!, { roleKeys: ['business_owner'] }));
  await setSummary(t, accountId, { tier: 'act_now', bestOfferId: offerId });
  const made = await asPerson(t, (ctx) => assign(ctx, accountId, { sellerUserId: seller, templateId }), { userId: leader });
  await asPerson(t, (ctx) => accept(ctx, made.id), { userId: seller, dataLimit: { kind: 'own_accounts' } });
  await runPlaybooks(t.tenantId);
  const [plan] = await planOf(accountId);
  const rows = await stepsOf(plan!.id);
  return { accountId, assignmentId: made.id, planId: plan!.id, stepIds: rows.map((s) => s.id) };
}

const planOf = (accountId: string) => t.run((ctx) => ctx.tx.select().from(accountPlan).where(eq(accountPlan.accountId, accountId)));
const stepsOf = (planId: string) => t.run((ctx) => ctx.tx.select().from(planStep).where(eq(planStep.planId, planId)).orderBy(planStep.order));
const historyOf = (planId: string) => t.run((ctx) => ctx.tx.select().from(planChange).where(eq(planChange.planId, planId)).orderBy(planChange.at));
/* eslint-disable @typescript-eslint/no-explicit-any -- event payloads are checked field by field below */
const events = async (type: string, accountId: string) =>
  (await adminDb.select().from(outbox).where(eq(outbox.tenantId, t.tenantId)).orderBy(outbox.seq))
    .map((r) => r.payload as { type: string; data: Record<string, any> })
    .filter((e) => e.type === type && e.data.accountId === accountId);
/* eslint-enable @typescript-eslint/no-explicit-any */

type Kind = 'email' | 'reply' | 'call' | 'meeting' | 'task_done';
async function observe(accountId: string, kind: Kind, over: { occurredAt?: Date; stepId?: string | null } = {}): Promise<void> {
  await publishTestEvent(t.tenantId, activityObserved, {
    accountId,
    handoffId: null,
    system: 'hubspot',
    externalId: `act_${Math.random().toString(36).slice(2)}`,
    kind,
    occurredAt: (over.occurredAt ?? new Date()).toISOString(),
    actorCrmOwnerId: null,
    actorUserId: null,
    taskExternalId: kind === 'task_done' ? 'task_1' : null,
    stepId: over.stepId ?? null,
  });
  await runPlaybooks(t.tenantId);
}

const plan = async (planId: string) => (await t.run((ctx) => ctx.tx.select().from(accountPlan).where(eq(accountPlan.id, planId))))[0]!;

describe('the stop rule', () => {
  it('a reply stops a reply_or_meeting plan', async () => {
    const { accountId, planId } = await account();
    await observe(accountId, 'reply');
    expect(await plan(planId)).toMatchObject({ status: 'stopped', statusReason: 'They replied' });
    expect((await stepsOf(planId)).map((s) => s.status)).toEqual(['skipped', 'skipped', 'skipped']);
    expect((await historyOf(planId)).map((h) => h.kind)).toContain('stopped');
    expect((await plan(planId)).engagedAt).not.toBeNull();
  });

  it('a meeting stops a meeting plan; a reply does not', async () => {
    const { accountId, planId } = await account(meetingOnly);
    await observe(accountId, 'reply');
    expect(await plan(planId)).toMatchObject({ status: 'active', engagedAt: expect.any(Date) });
    await observe(accountId, 'meeting');
    expect(await plan(planId)).toMatchObject({ status: 'stopped', statusReason: 'They booked a meeting' });
  });

  it('a meeting stops a reply_or_meeting plan', async () => {
    const { accountId, planId } = await account();
    await observe(accountId, 'meeting');
    expect(await plan(planId)).toMatchObject({ status: 'stopped', statusReason: 'They booked a meeting' });
  });

  it('a never plan is not stopped but records engaged_at', async () => {
    const { accountId, planId } = await account(never);
    await observe(accountId, 'reply');
    await observe(accountId, 'meeting');
    expect(await plan(planId)).toMatchObject({ status: 'active', engagedAt: expect.any(Date) });
    expect((await stepsOf(planId)).every((s) => s.status === 'todo')).toBe(true);
  });

  it('a paused plan is stopped too', async () => {
    const { accountId, planId } = await account();
    await asSeller((ctx) => pausePlan(ctx, planId));
    await observe(accountId, 'reply');
    expect(await plan(planId)).toMatchObject({ status: 'stopped', statusReason: 'They replied' });
  });

  it('activity before accept is ignored', async () => {
    const { accountId, planId } = await account();
    const p = await plan(planId);
    await observe(accountId, 'reply', { occurredAt: new Date(p.acceptedAt.getTime() - 60_000) });
    await observe(accountId, 'meeting', { occurredAt: new Date(p.acceptedAt.getTime() - 60_000) });
    expect(await plan(planId)).toMatchObject({ status: 'active', engagedAt: null });
  });

  it('engaged_at is the time of the reply, not of delivery', async () => {
    const { accountId, planId } = await account(never);
    const at = new Date(Date.now() + 5000);
    await observe(accountId, 'reply', { occurredAt: at });
    expect((await plan(planId)).engagedAt!.toISOString()).toBe(at.toISOString());
  });

  it('an email or call does not stop or engage the plan', async () => {
    const { accountId, planId } = await account();
    await observe(accountId, 'email');
    await observe(accountId, 'call');
    expect(await plan(planId)).toMatchObject({ status: 'active', engagedAt: null });
  });
});

describe('done in HubSpot', () => {
  it('task_done marks its step done', async () => {
    const { accountId, planId, stepIds } = await account();
    const at = new Date(Date.now() + 1000);
    await observe(accountId, 'task_done', { stepId: stepIds[0]!, occurredAt: at });
    const [first] = await stepsOf(planId);
    expect(first).toMatchObject({ status: 'done', doneBy: null });
    expect(first!.doneAt!.toISOString()).toBe(at.toISOString());
    const done = (await events('playbooks.step.completed', accountId)).filter((e) => e.data.stepId === stepIds[0]);
    expect(done).toHaveLength(1);
    expect(done[0]!.data).toMatchObject({ planId, doneBy: null, doneAt: at.toISOString() });
    const change = (await historyOf(planId)).find((h) => h.kind === 'step_status');
    expect(change).toMatchObject({ stepId: stepIds[0], detail: { from: 'todo', to: 'done', source: 'crm' } });
    const changed = (await events('playbooks.plan.changed', accountId)).at(-1)!;
    expect(changed.data).toMatchObject({ changed: ['steps'], steps: [expect.objectContaining({ id: stepIds[0], status: 'done' })] });
  });

  it('a second task_done for the same step changes nothing', async () => {
    const { accountId, stepIds } = await account();
    await observe(accountId, 'task_done', { stepId: stepIds[0]! });
    await observe(accountId, 'task_done', { stepId: stepIds[0]! });
    expect((await events('playbooks.step.completed', accountId)).filter((e) => e.data.stepId === stepIds[0])).toHaveLength(1);
  });

  it('task_done for a skipped step or a closed plan changes nothing, and so does a null stepId', async () => {
    const a = await account();
    await asSeller((ctx) => updateStep(ctx, a.planId, a.stepIds[1]!, { status: 'skipped' }));
    await observe(a.accountId, 'task_done', { stepId: a.stepIds[1]! });
    await observe(a.accountId, 'task_done', { stepId: null });
    expect((await stepsOf(a.planId)).map((s) => s.status)).toEqual(['todo', 'skipped', 'todo']);

    const b = await account(never);
    await asSeller((ctx) => updateStep(ctx, b.planId, b.stepIds[0]!, { status: 'in_progress' }));
    await observe(b.accountId, 'task_done', { stepId: b.stepIds[0]! });
    expect((await stepsOf(b.planId))[0]!.status).toBe('done');

    const c = await account();
    await observe(c.accountId, 'reply');
    const before = (await events('playbooks.plan.changed', c.accountId)).length;
    await observe(c.accountId, 'task_done', { stepId: c.stepIds[0]! });
    expect((await stepsOf(c.planId))[0]!.status).toBe('skipped');
    expect((await events('playbooks.plan.changed', c.accountId)).length).toBe(before);
  });
});

describe('no reply', () => {
  const tick = (planId: string, stepIds: string[], status: 'done' | 'skipped' | 'todo' = 'done') =>
    stepIds.reduce((p, id) => p.then(() => asSeller((ctx) => updateStep(ctx, planId, id, { status })).then(() => undefined)), Promise.resolve());

  it('the last step closing with no reply publishes plan.no_reply once', async () => {
    const { accountId, assignmentId, planId, stepIds } = await account();
    await tick(planId, stepIds.slice(0, 2));
    expect(await events('playbooks.plan.no_reply', accountId)).toHaveLength(0);
    await asSeller((ctx) => updateStep(ctx, planId, stepIds[2]!, { status: 'skipped' }));
    const fired = await events('playbooks.plan.no_reply', accountId);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.data).toMatchObject({ planId, accountId, assignmentId });
    expect(await plan(planId)).toMatchObject({ status: 'active', noReplyAt: expect.any(Date) });
    // Reopen and close again: still one.
    await tick(planId, [stepIds[2]!], 'todo');
    await tick(planId, [stepIds[2]!], 'done');
    expect(await events('playbooks.plan.no_reply', accountId)).toHaveLength(1);
  });

  it('no no_reply after a reply', async () => {
    const { accountId, planId, stepIds } = await account(never);
    await observe(accountId, 'reply');
    await tick(planId, stepIds);
    expect(await events('playbooks.plan.no_reply', accountId)).toHaveLength(0);
  });

  it('none on a stop, an abandon (even when HubSpot reports a task after) or a complete', async () => {
    const stopped = await account();
    await observe(stopped.accountId, 'reply');
    expect(await events('playbooks.plan.no_reply', stopped.accountId)).toHaveLength(0);
    expect((await plan(stopped.planId)).noReplyAt).toBeNull();

    const abandoned = await account();
    await asSeller((ctx) => abandonPlan(ctx, abandoned.planId, 'Wrong fit'));
    await observe(abandoned.accountId, 'task_done', { stepId: abandoned.stepIds[0]! });
    expect(await events('playbooks.plan.no_reply', abandoned.accountId)).toHaveLength(0);
    expect((await plan(abandoned.planId)).noReplyAt).toBeNull();

    // Completing needs every step closed, which already fired once; the complete adds none.
    const completed = await account();
    await tick(completed.planId, completed.stepIds);
    expect(await events('playbooks.plan.no_reply', completed.accountId)).toHaveLength(1);
    await asSeller((ctx) => completePlan(ctx, completed.planId));
    expect(await events('playbooks.plan.no_reply', completed.accountId)).toHaveLength(1);
  });

  it('none while the plan is paused', async () => {
    const { accountId, planId, stepIds } = await account();
    await asSeller((ctx) => pausePlan(ctx, planId));
    await tick(planId, stepIds);
    expect(await events('playbooks.plan.no_reply', accountId)).toHaveLength(0);
    // It fires on resume, once.
    await asSeller((ctx) => resumePlan(ctx, planId));
    expect(await events('playbooks.plan.no_reply', accountId)).toHaveLength(1);
    await asSeller((ctx) => pausePlan(ctx, planId));
    await asSeller((ctx) => resumePlan(ctx, planId));
    expect(await events('playbooks.plan.no_reply', accountId)).toHaveLength(1);
  });

  it('a plan engaged while paused does not fire on resume', async () => {
    const { accountId, planId, stepIds } = await account(never);
    await asSeller((ctx) => pausePlan(ctx, planId));
    await tick(planId, stepIds);
    await observe(accountId, 'reply');
    await asSeller((ctx) => resumePlan(ctx, planId));
    expect(await events('playbooks.plan.no_reply', accountId)).toHaveLength(0);
  });

  it('a plan paused by a withdrawal fires once when the next acceptance resumes it', async () => {
    const { accountId, assignmentId, planId, stepIds } = await account();
    await asPerson(t, (ctx) => withdraw(ctx, assignmentId), { userId: leader });
    await runPlaybooks(t.tenantId);
    expect((await plan(planId)).status).toBe('paused');
    await tick(planId, stepIds);
    expect(await events('playbooks.plan.no_reply', accountId)).toHaveLength(0);

    const again = await asPerson(t, (ctx) => assign(ctx, accountId, { sellerUserId: seller }), { userId: leader });
    await asPerson(t, (ctx) => accept(ctx, again.id), { userId: seller, dataLimit: { kind: 'own_accounts' } });
    await runPlaybooks(t.tenantId);
    expect(await plan(planId)).toMatchObject({ status: 'active', assignmentId: again.id, noReplyAt: expect.any(Date) });
    const fired = await events('playbooks.plan.no_reply', accountId);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.data).toMatchObject({ planId, assignmentId: again.id });
  });

  it('removing the last open step fires no_reply', async () => {
    const { accountId, planId, stepIds } = await account();
    await tick(planId, stepIds.slice(0, 2));
    await asSeller((ctx) => removeStep(ctx, planId, stepIds[2]!));
    expect(await events('playbooks.plan.no_reply', accountId)).toHaveLength(1);
  });

  it('a done step by CRM closing the last step fires no_reply too', async () => {
    const { accountId, planId, stepIds } = await account();
    await tick(planId, stepIds.slice(0, 2));
    await observe(accountId, 'task_done', { stepId: stepIds[2]! });
    expect(await events('playbooks.plan.no_reply', accountId)).toHaveLength(1);
  });
});
