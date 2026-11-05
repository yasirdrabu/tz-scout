import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '@/entry/compose';
import { editPerson, upsertFromArrival } from '@/modules/accounts';
import { seedMockCrm, syncOwners, syncPlanTasks } from '@/modules/crm';
import { handoff, link, mockTask, taskLink } from '@/modules/crm/db/schema';
import { dueAtOn } from '@/modules/crm/domain/tasks';
import { mockCompleteTask } from '@/modules/crm/fixtures';
import { callLog } from '@/modules/integrations/db/schema';
import { abandonPlan, addStep, completePlan, createTemplate, removeStep, stopPlan, updateStep } from '@/modules/playbooks';
import { accountPlan, planStep } from '@/modules/playbooks/db/schema';
import { accept, assign, withdraw } from '@/modules/routing';
import { tenantSummary, tenantTimezone } from '@/modules/tenancy';
import { config } from '@/platform/config';
import { adminDb, closeDbs } from '@/platform/db/client';
import { runOutbox } from '../helpers/run-outbox';
import { arrival, runPlaybooks } from '../playbooks/helpers';
import { asPerson, domain, member, resolved, routingTenant, type Tenant } from '../routing/helpers';

let t: Tenant;
let seller: string;
let seller2: string;
let leader: string;
let templateId: string;
let timezone: string;
let slug: string;

const PLAYBOOK = 'Plan tasks';
const steps = [
  { day: 0, channel: 'email' as const, ownerRole: 'seller' as const, title: 'Intro email', targetBuyingRoles: ['business_owner'], subject: 'Hello {person.first_name}', body: 'Hi {person.first_name}' },
  { day: 3, channel: 'call' as const, ownerRole: 'seller' as const, title: 'Call', detail: 'Ask about the pilot.' },
  { day: 5, channel: 'task' as const, ownerRole: 'operator' as const, title: 'Research' },
  { day: 7, channel: 'task' as const, ownerRole: 'seller' as const, title: 'Internal', crmTask: false },
];

beforeAll(async () => {
  t = await routingTenant();
  seller = await member(t, 'seller');
  seller2 = await member(t, 'seller');
  leader = await member(t, 'leader');
  await t.run((ctx) => seedMockCrm(ctx));
  await t.run((ctx) => syncOwners(ctx));
  templateId = (await t.run((ctx) => createTemplate(ctx, { name: PLAYBOOK, status: 'active', steps }))).id;
  timezone = await t.run((ctx) => tenantTimezone(ctx));
  slug = (await t.run((ctx) => tenantSummary(ctx))).slug;
});
afterAll(closeDbs);

type Made = { accountId: string; assignmentId: string; personId: string };

/** An account with Ana (business owner) assigned to the seller with the playbook and pushed to the mock; not yet accepted. */
async function handedOff(name = 'Plan Co'): Promise<Made> {
  const d = domain();
  const a = arrival({ account: { name, domain: d }, people: [{ firstName: 'Ana', lastName: 'Act', title: 'CTO', email: `ana@${d}` }] });
  const { accountId, personIds } = await t.run((ctx) => upsertFromArrival(ctx, a));
  await resolved(t, accountId, { arrivalId: a.arrivalId, resolution: 'created' });
  await asPerson(t, (ctx) => editPerson(ctx, personIds[0]!, { roleKeys: ['business_owner'] }));
  const made = await asPerson(t, (ctx) => assign(ctx, accountId, { sellerUserId: seller, templateId }), { userId: leader });
  await runOutbox(t.tenantId);
  return { accountId, assignmentId: made.id, personId: personIds[0]! };
}

const acceptAs = async (assignmentId: string, userId = seller) => {
  await asPerson(t, (ctx) => accept(ctx, assignmentId), { userId, dataLimit: { kind: 'own_accounts' } });
  await runOutbox(t.tenantId);
};

/** Handed off and accepted: the plan and its tasks exist. */
async function planned(name?: string): Promise<Made & { planId: string; stepIds: string[] }> {
  const made = await handedOff(name);
  await acceptAs(made.assignmentId);
  const plan = await planOf(made.accountId);
  return { ...made, planId: plan.id, stepIds: (await stepsOf(plan.id)).map((s) => s.id) };
}

const planOf = async (accountId: string) => (await t.run((ctx) => ctx.tx.select().from(accountPlan).where(eq(accountPlan.accountId, accountId))))[0]!;
const stepsOf = (planId: string) => t.run((ctx) => ctx.tx.select().from(planStep).where(eq(planStep.planId, planId)).orderBy(asc(planStep.order)));
const handoffsOf = (accountId: string) => t.run((ctx) => ctx.tx.select().from(handoff).where(eq(handoff.accountId, accountId)).orderBy(asc(handoff.queuedAt)));
const companyOf = async (accountId: string) => (await handoffsOf(accountId))[0]!.companyExternalId!;
const linksOf = (planId: string) => t.run((ctx) => ctx.tx.select().from(taskLink).where(eq(taskLink.planId, planId)));
const linkOf = async (stepId: string) => (await t.run((ctx) => ctx.tx.select().from(taskLink).where(eq(taskLink.stepId, stepId))))[0];
const mockTaskById = async (externalId: string) => (await adminDb.select().from(mockTask).where(and(eq(mockTask.tenantId, t.tenantId), eq(mockTask.externalId, externalId))))[0]!;
const taskOf = async (stepId: string) => mockTaskById((await linkOf(stepId))!.externalTaskId);
const personLink = async (personId: string) =>
  (await t.run((ctx) => ctx.tx.select().from(link).where(and(eq(link.scoutType, 'person'), eq(link.scoutId, personId)))))[0]!.externalId;
const fixedLinks = async (assignmentId: string) =>
  (await t.run((ctx) => ctx.tx.select().from(link).where(eq(link.scoutType, 'task')))).filter((l) => l.scoutId.startsWith(`${assignmentId}:`));
const calls = async (ops: string[] = []) =>
  (await adminDb.select({ op: callLog.operation }).from(callLog).where(eq(callLog.tenantId, t.tenantId))).filter((c) => ops.length === 0 || ops.includes(c.op)).length;
const scoutUrl = (accountId: string) => `${config.publicUrl}/t/${slug}/accounts/${accountId}`;
const asSeller = <T,>(fn: Parameters<typeof asPerson<T>>[1], userId = seller) => asPerson(t, fn, { userId });
const setStep = async (planId: string, stepId: string, patch: Parameters<typeof updateStep>[3]) => {
  await asSeller((ctx) => updateStep(ctx, planId, stepId, patch));
  await runOutbox(t.tenantId);
};

describe('plan tasks follow the account plan (CRM-E3-S4)', () => {
  it('accept creates a task per crm_task step', async () => {
    const { accountId, personId, planId, stepIds } = await planned('Acme');
    const rows = await stepsOf(planId);
    const company = await companyOf(accountId);
    const person = await personLink(personId);
    const from = `From the ${PLAYBOOK} playbook in Scout: ${scoutUrl(accountId)}`;

    const intro = await taskOf(stepIds[0]!);
    expect(intro).toMatchObject({
      companyExternalId: company,
      personExternalId: person,
      subject: 'Intro email (Acme)',
      body: `Draft email (send it yourself)\n\nSubject: Hello Ana\n\nHi Ana\n\n${from}`,
      ownerExternalId: `mock-${seller}`,
      status: 'open',
    });
    expect(intro.dueAt!.toISOString()).toBe(dueAtOn(rows[0]!.dueDate, timezone));
    const call = await taskOf(stepIds[1]!);
    expect(call).toMatchObject({ subject: 'Call (Acme)', body: `Ask about the pilot.\n\n${from}`, ownerExternalId: `mock-${seller}`, status: 'open' });
    // No person of the step's own: the account's primary person.
    expect(call.personExternalId).toBe(person);

    const links = await linksOf(planId);
    expect(links).toHaveLength(3);
    for (const l of links) expect(l).toMatchObject({ accountId, planId, status: 'open', system: 'hubspot' });
    expect(await linkOf(stepIds[3]!)).toBeUndefined();
  });

  it('an operator step with no owner goes to the plan seller', async () => {
    const { planId, stepIds } = await planned();
    expect((await stepsOf(planId))[2]!.ownerUserId).toBeNull();
    expect((await taskOf(stepIds[2]!)).ownerExternalId).toBe(`mock-${seller}`);
  });

  it('accept closes the open fixed tasks; a fixed task completed before accept keeps its body', async () => {
    const made = await handedOff();
    const fixed = await fixedLinks(made.assignmentId);
    expect(fixed).toHaveLength(4);
    const first = fixed.find((l) => l.scoutId.endsWith(':first_touch'))!;
    await t.run((ctx) => mockCompleteTask(ctx, first.externalId));
    const firstBody = (await mockTaskById(first.externalId)).body;

    await acceptAs(made.assignmentId);
    expect(await mockTaskById(first.externalId)).toMatchObject({ status: 'completed', body: firstBody });
    for (const l of fixed.filter((x) => x !== first)) {
      const task = await mockTaskById(l.externalId);
      expect(task.status).toBe('completed');
      expect(task.body).toMatch(new RegExp(`\\n\\nReplaced by the ${PLAYBOOK} playbook\\.$`));
    }
  });

  it('step done, skipped, removed each close the task with its note', async () => {
    const { planId, stepIds } = await planned();
    await setStep(planId, stepIds[0]!, { status: 'done' });
    await setStep(planId, stepIds[1]!, { status: 'skipped' });
    await asSeller((ctx) => removeStep(ctx, planId, stepIds[2]!));
    await runOutbox(t.tenantId);

    const expectClosed = async (stepId: string, note: string) => {
      const task = await taskOf(stepId);
      expect(task.status).toBe('completed');
      expect(task.body!.endsWith(`\n\n${note}`)).toBe(true);
      expect((await linkOf(stepId))!.status).toBe('closed');
    };
    await expectClosed(stepIds[0]!, 'Marked done in Scout.');
    await expectClosed(stepIds[1]!, 'Skipped in Scout.');
    await expectClosed(stepIds[2]!, `Taken out of the ${PLAYBOOK} playbook.`);
  });

  it('turning crm_task off closes the task as taken out', async () => {
    const { planId, stepIds } = await planned();
    await setStep(planId, stepIds[1]!, { crmTask: false });
    const task = await taskOf(stepIds[1]!);
    expect(task.status).toBe('completed');
    expect(task.body!.endsWith(`\n\nTaken out of the ${PLAYBOOK} playbook.`)).toBe(true);
  });

  it('editing a step updates its task in place', async () => {
    const { planId, stepIds } = await planned('Edit Co');
    const before = (await linkOf(stepIds[1]!))!.externalTaskId;
    await setStep(planId, stepIds[1]!, { title: 'Call again', dueDate: '2027-01-15', ownerUserId: seller2 });
    expect((await linkOf(stepIds[1]!))!.externalTaskId).toBe(before);
    const task = await taskOf(stepIds[1]!);
    expect(task).toMatchObject({ subject: 'Call again (Edit Co)', ownerExternalId: `mock-${seller2}`, status: 'open' });
    expect(task.dueAt!.toISOString()).toBe(dueAtOn('2027-01-15', timezone));
  });

  it('a second sync with no change writes nothing', async () => {
    const { accountId } = await planned();
    const before = await calls();
    await t.run((ctx) => syncPlanTasks(ctx, accountId, new Date()));
    expect(await calls()).toBe(before);
    expect(await calls(['upsertTask', 'closeTask'])).toBeGreaterThan(0);
  });

  it('pause leaves tasks open; resume after reassignment moves them to the new seller', async () => {
    const { accountId, assignmentId, planId, stepIds } = await planned();
    const ids = await Promise.all(stepIds.slice(0, 3).map(async (s) => (await linkOf(s))!.externalTaskId));
    await asPerson(t, (ctx) => withdraw(ctx, assignmentId), { userId: leader });
    await runOutbox(t.tenantId);
    expect((await planOf(accountId)).status).toBe('paused');
    for (const id of ids) expect(await mockTaskById(id)).toMatchObject({ status: 'open', ownerExternalId: `mock-${seller}` });

    const again = await asPerson(t, (ctx) => assign(ctx, accountId, { sellerUserId: seller2 }), { userId: leader });
    await runOutbox(t.tenantId);
    await acceptAs(again.id, seller2);
    expect(await planOf(accountId)).toMatchObject({ id: planId, status: 'active', sellerUserId: seller2 });
    for (const [i, s] of stepIds.slice(0, 3).entries()) {
      expect((await linkOf(s))!.externalTaskId).toBe(ids[i]);
      expect(await taskOf(s)).toMatchObject({ status: 'open', ownerExternalId: `mock-${seller2}` });
    }
  });

  it('stop, complete and abandon close every open task with the plan note', async () => {
    const stopped = await planned();
    await t.run((ctx) => stopPlan(ctx, stopped.planId, 'They replied'));
    await runOutbox(t.tenantId);
    for (const s of stopped.stepIds.slice(0, 3)) {
      const task = await taskOf(s);
      expect(task.status).toBe('completed');
      expect(task.body!.endsWith(`\n\nThe ${PLAYBOOK} playbook stopped: They replied.`)).toBe(true);
    }

    const completed = await planned();
    // The steps close and the plan completes before the sync runs: the sync sees the plan as it is now.
    await asSeller(async (ctx) => {
      for (const s of completed.stepIds) await updateStep(ctx, completed.planId, s, { status: 'skipped' });
      await completePlan(ctx, completed.planId);
    });
    await runOutbox(t.tenantId);
    for (const s of completed.stepIds.slice(0, 3)) expect((await taskOf(s)).body!.endsWith(`\n\nThe ${PLAYBOOK} playbook was completed.`)).toBe(true);

    const abandoned = await planned();
    await asSeller((ctx) => abandonPlan(ctx, abandoned.planId, 'Wrong fit'));
    await runOutbox(t.tenantId);
    for (const s of abandoned.stepIds.slice(0, 3)) {
      const task = await taskOf(s);
      expect(task.status).toBe('completed');
      expect(task.body!.endsWith(`\n\nThe ${PLAYBOOK} playbook was abandoned.`)).toBe(true);
      expect((await linkOf(s))!.status).toBe('closed');
    }
  });

  it('a reopened step gets a new task', async () => {
    const { planId, stepIds } = await planned();
    await setStep(planId, stepIds[1]!, { status: 'skipped' });
    const old = (await linkOf(stepIds[1]!))!.externalTaskId;
    await setStep(planId, stepIds[1]!, { status: 'todo' });
    const l = (await linkOf(stepIds[1]!))!;
    expect(l.externalTaskId).not.toBe(old);
    expect(l.status).toBe('open');
    expect((await taskOf(stepIds[1]!)).status).toBe('open');
    expect((await mockTaskById(old)).status).toBe('completed');
  });

  it('a step added to the plan gets a task', async () => {
    const { planId } = await planned();
    const view = await asSeller((ctx) => addStep(ctx, planId, { day: 9, channel: 'call', ownerRole: 'seller', title: 'Extra call' }));
    await runOutbox(t.tenantId);
    const added = view.steps.find((s) => s.title === 'Extra call')!;
    expect(await taskOf(added.id)).toMatchObject({ status: 'open', ownerExternalId: `mock-${seller}` });
  });

  it('no completed handoff: the sync does nothing', async () => {
    const d = domain();
    const a = arrival({ account: { name: 'No Push Co', domain: d }, people: [{ firstName: 'Ana', lastName: 'Act', email: `ana@${d}` }] });
    const { accountId } = await t.run((ctx) => upsertFromArrival(ctx, a));
    await resolved(t, accountId, { arrivalId: a.arrivalId, resolution: 'created' });
    const made = await asPerson(t, (ctx) => assign(ctx, accountId, { sellerUserId: seller, templateId }), { userId: leader });
    await asPerson(t, (ctx) => accept(ctx, made.id), { userId: seller, dataLimit: { kind: 'own_accounts' } });
    await runPlaybooks(t.tenantId); // the plan starts; the push never runs
    const plan = await planOf(accountId);
    const before = await calls();
    await t.run((ctx) => syncPlanTasks(ctx, accountId, new Date()));
    expect(await calls()).toBe(before);
    expect(await linksOf(plan.id)).toEqual([]);
  });
});
