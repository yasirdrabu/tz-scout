import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '@/entry/compose';
import { editPerson, upsertFromArrival } from '@/modules/accounts';
import { activityObserved, push, seedMockCrm, syncAccount, syncOwners, syncPlanTasks } from '@/modules/crm';
import { followThrough as followThroughTable, handoff, link, mockTask, taskLink } from '@/modules/crm/db/schema';
import { dueAtOn } from '@/modules/crm/domain/tasks';
import { mockAddActivity, mockCompleteTask } from '@/modules/crm/fixtures';
import { callLog } from '@/modules/integrations/db/schema';
import { abandonPlan, addStep, completePlan, createTemplate, removeStep, stopPlan, updateStep } from '@/modules/playbooks';
import { accountPlan, planStep } from '@/modules/playbooks/db/schema';
import { accept, assign, withdraw } from '@/modules/routing';
import { accountReview } from '@/modules/routing/db/schema';
import { tenantSummary, tenantTimezone } from '@/modules/tenancy';
import { config } from '@/platform/config';
import { adminDb, closeDbs } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
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

type Made = { accountId: string; assignmentId: string; personId: string; personIds: string[] };

/**
 * An account with Ana (the primary person) assigned to the seller with the playbook and pushed to the mock; not yet
 * accepted. Ana holds business_owner, unless `ben` adds Ben as a second person who holds it instead.
 */
async function handedOff(name = 'Plan Co', opts: { ben?: boolean } = {}): Promise<Made> {
  const d = domain();
  const people = [{ firstName: 'Ana', lastName: 'Act', title: 'CTO', email: `ana@${d}` }, ...(opts.ben ? [{ firstName: 'Ben', lastName: 'Buy', title: 'COO', email: `ben@${d}` }] : [])];
  const a = arrival({ account: { name, domain: d }, people });
  const { accountId, personIds } = await t.run((ctx) => upsertFromArrival(ctx, a));
  await resolved(t, accountId, { arrivalId: a.arrivalId, resolution: 'created' });
  await asPerson(t, (ctx) => editPerson(ctx, personIds[opts.ben ? 1 : 0]!, { roleKeys: ['business_owner'] }));
  const made = await asPerson(t, (ctx) => assign(ctx, accountId, { sellerUserId: seller, templateId }), { userId: leader });
  await runOutbox(t.tenantId);
  return { accountId, assignmentId: made.id, personId: personIds[0]!, personIds };
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
    await t.run((ctx) => syncPlanTasks(ctx, accountId));
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
    await t.run((ctx) => syncPlanTasks(ctx, accountId));
    expect(await calls()).toBe(before);
    expect(await linksOf(plan.id)).toEqual([]);
  });
});

const deleteMockTask = (externalId: string) => adminDb.delete(mockTask).where(and(eq(mockTask.tenantId, t.tenantId), eq(mockTask.externalId, externalId)));

describe('plan tasks, edge cases', () => {
  it('a task deleted in HubSpot counts as closed when its step closes', async () => {
    const { planId, stepIds } = await planned();
    await deleteMockTask((await linkOf(stepIds[1]!))!.externalTaskId);
    await setStep(planId, stepIds[1]!, { status: 'skipped' });
    expect((await linkOf(stepIds[1]!))!.status).toBe('closed');
    // The rest of the plan still syncs.
    await setStep(planId, stepIds[0]!, { status: 'done' });
    expect((await taskOf(stepIds[0]!)).status).toBe('completed');
  });

  it('a task deleted in HubSpot is made again when its open step changes', async () => {
    const { planId, stepIds } = await planned();
    const old = (await linkOf(stepIds[1]!))!.externalTaskId;
    await deleteMockTask(old);
    await setStep(planId, stepIds[1]!, { title: 'Call again' });
    const l = (await linkOf(stepIds[1]!))!;
    expect(l.externalTaskId).not.toBe(old);
    expect(l.status).toBe('open');
    expect((await taskOf(stepIds[1]!)).subject).toBe('Call again (Plan Co)');
  });

  it('open tasks an earlier plan left are closed with that plan note when a new plan starts', async () => {
    const first = await handedOff();
    await acceptAs(first.assignmentId);
    const a = await planOf(first.accountId);
    expect((await linksOf(a.id)).filter((l) => l.status === 'open')).toHaveLength(3);
    // Plan A ends and plan B starts before A's sync runs.
    await asSeller((ctx) => abandonPlan(ctx, a.id, 'Wrong fit'));
    await asPerson(t, (ctx) => withdraw(ctx, first.assignmentId), { userId: leader });
    const again = await asPerson(t, (ctx) => assign(ctx, first.accountId, { sellerUserId: seller, templateId }), { userId: leader });
    await asPerson(t, (ctx) => accept(ctx, again.id), { userId: seller, dataLimit: { kind: 'own_accounts' } });
    await runOutbox(t.tenantId);

    const plans = await t.run((ctx) => ctx.tx.select().from(accountPlan).where(eq(accountPlan.accountId, first.accountId)));
    const b = plans.find((p) => p.id !== a.id)!;
    expect(b.status).toBe('active');
    for (const l of await linksOf(a.id)) {
      expect(l.status).toBe('closed');
      expect((await mockTaskById(l.externalTaskId)).body!.endsWith(`\n\nThe ${PLAYBOOK} playbook was abandoned.`)).toBe(true);
    }
    expect((await linksOf(b.id)).filter((l) => l.status === 'open')).toHaveLength(3);
  });

  it('the step person beats the primary person (Ruling 7)', async () => {
    const made = await handedOff('Two People Co', { ben: true });
    await acceptAs(made.assignmentId);
    const rows = await stepsOf((await planOf(made.accountId)).id);
    const ana = await personLink(made.personIds[0]!);
    const ben = await personLink(made.personIds[1]!);
    expect(ana).not.toBe(ben);
    expect((await taskOf(rows[0]!.id)).personExternalId).toBe(ben); // targets business_owner: Ben
    expect((await taskOf(rows[1]!.id)).personExternalId).toBe(ana); // no target: the primary person
  });

  it('a step owner with no CRM owner falls back to the plan seller (Ruling 6)', async () => {
    const { planId, stepIds } = await planned();
    await setStep(planId, stepIds[1]!, { ownerUserId: leader });
    expect((await stepsOf(planId))[1]!.ownerUserId).toBe(leader);
    expect((await taskOf(stepIds[1]!)).ownerExternalId).toBe(`mock-${seller}`);
  });

  it('a plan that ended before its first sync still replaces the fixed tasks of its assignment (Ruling 10)', async () => {
    const made = await handedOff();
    const fixed = await fixedLinks(made.assignmentId);
    await asPerson(t, (ctx) => accept(ctx, made.assignmentId), { userId: seller, dataLimit: { kind: 'own_accounts' } });
    await runPlaybooks(t.tenantId); // the plan starts; CRM has not seen it yet
    const plan = await planOf(made.accountId);
    await asSeller((ctx) => abandonPlan(ctx, plan.id, 'Wrong fit'));
    await t.run((ctx) => syncPlanTasks(ctx, made.accountId));
    for (const l of fixed) expect((await mockTaskById(l.externalId)).body!.endsWith(`\n\nReplaced by the ${PLAYBOOK} playbook.`)).toBe(true);
    expect(await linksOf(plan.id)).toEqual([]);
  });
});

const companyTasks = async (company: string) => adminDb.select().from(mockTask).where(and(eq(mockTask.tenantId, t.tenantId), eq(mockTask.companyExternalId, company)));
const sync = async (accountId: string) => {
  await t.run((ctx) => syncAccount(ctx, accountId, new Date()));
  await runOutbox(t.tenantId);
};
const taskDone = async (taskExternalId: string) =>
  (await adminDb.select().from(outbox).where(eq(outbox.tenantId, t.tenantId)))
    .map((r) => r.payload as { type: string; data: { kind?: string; taskExternalId?: string } })
    .filter((e) => e.type === activityObserved.type && e.data.kind === 'task_done' && e.data.taskExternalId === taskExternalId);
const stageOf = async (accountId: string) => (await t.run((ctx) => ctx.tx.select().from(accountReview).where(eq(accountReview.accountId, accountId))))[0]!.stage;

describe('the handoff with plan tasks (CRM-E3-S4, CRM-E5-S2-AC2)', () => {
  it('plan first, push later: no fixed tasks, the plan tasks appear once the push completes', async () => {
    const d = domain();
    const a = arrival({ account: { name: 'Late Push Co', domain: d }, people: [{ firstName: 'Ana', lastName: 'Act', email: `ana@${d}` }] });
    const { accountId } = await t.run((ctx) => upsertFromArrival(ctx, a));
    await resolved(t, accountId, { arrivalId: a.arrivalId, resolution: 'created' });
    const made = await asPerson(t, (ctx) => assign(ctx, accountId, { sellerUserId: seller, templateId }), { userId: leader });
    // Accepted before the push job ran.
    await asPerson(t, (ctx) => accept(ctx, made.id), { userId: seller, dataLimit: { kind: 'own_accounts' } });
    await runOutbox(t.tenantId);

    expect((await handoffsOf(accountId))[0]!.status).toBe('completed');
    expect(await fixedLinks(made.id)).toEqual([]);
    const plan = await planOf(accountId);
    const links = await linksOf(plan.id);
    expect(links.filter((l) => l.status === 'open')).toHaveLength(3);
    const tasks = await companyTasks(await companyOf(accountId));
    expect(tasks.map((x) => x.externalId).sort()).toEqual(links.map((l) => l.externalTaskId).sort());
  });

  it('a push with no plan still creates the fixed tasks', async () => {
    const made = await handedOff();
    const fixed = await fixedLinks(made.assignmentId);
    expect(fixed).toHaveLength(4);
    for (const l of fixed) expect((await mockTaskById(l.externalId)).status).toBe('open');
  });

  it('re-push after the plan ended creates no fixed tasks', async () => {
    const { accountId, planId, stepIds } = await planned();
    await asSeller(async (ctx) => {
      for (const s of stepIds) await updateStep(ctx, planId, s, { status: 'skipped' });
      await completePlan(ctx, planId);
    });
    await runOutbox(t.tenantId);
    const company = await companyOf(accountId);
    const shape = async () => (await companyTasks(company)).map((x) => ({ id: x.externalId, body: x.body, status: x.status })).sort((x, y) => x.id.localeCompare(y.id));
    const before = await shape();
    const upserts = await calls(['upsertTask']);

    const { handoffId } = await asPerson(t, (ctx) => push(ctx, accountId), { userId: leader });
    await runOutbox(t.tenantId);
    const again = (await handoffsOf(accountId)).find((h) => h.id === handoffId)!;
    expect(again).toMatchObject({ isRepush: true, status: 'completed' });
    expect(await calls(['upsertTask'])).toBe(upserts);
    expect(await shape()).toEqual(before);
  });

  it('a task done in HubSpot marks the step done', async () => {
    const { accountId, planId, stepIds } = await planned();
    const l = (await linkOf(stepIds[1]!))!;
    await t.run((ctx) => mockCompleteTask(ctx, l.externalTaskId));
    const closes = await calls(['closeTask']);
    await sync(accountId);

    expect((await stepsOf(planId))[1]!).toMatchObject({ status: 'done', doneBy: null });
    expect((await linkOf(stepIds[1]!))!.status).toBe('done');
    expect(await taskDone(l.externalTaskId)).toHaveLength(1);
    expect(await calls(['closeTask'])).toBe(closes);
    // Seen once: the next poll reports nothing new.
    await sync(accountId);
    expect(await taskDone(l.externalTaskId)).toHaveLength(1);
  });

  it('a task Scout closed is not reported done', async () => {
    const { accountId, planId, stepIds } = await planned();
    await setStep(planId, stepIds[1]!, { status: 'skipped' });
    const closed = (await linkOf(stepIds[1]!))!;
    expect(closed.status).toBe('closed');
    expect((await mockTaskById(closed.externalTaskId)).status).toBe('completed');
    // Another one done in HubSpot in the same poll is reported.
    const other = (await linkOf(stepIds[0]!))!;
    await t.run((ctx) => mockCompleteTask(ctx, other.externalTaskId));
    await sync(accountId);

    expect(await taskDone(closed.externalTaskId)).toEqual([]);
    expect(await taskDone(other.externalTaskId)).toHaveLength(1);
    const rows = await stepsOf(planId);
    expect(rows[1]!.status).toBe('skipped');
    expect(rows[0]!.status).toBe('done');
    expect((await linkOf(stepIds[1]!))!.status).toBe('closed');
  });

  it('full chain: a reply after accept stops the plan, closes every task and moves the account to Engaged', async () => {
    const { accountId, planId, stepIds } = await planned();
    expect(await stageOf(accountId)).not.toBe('engaged');
    const company = await companyOf(accountId);
    await t.run((ctx) => mockAddActivity(ctx, { companyExternalId: company, kind: 'reply' }));
    await sync(accountId);

    expect(await planOf(accountId)).toMatchObject({ id: planId, status: 'stopped', statusReason: 'They replied' });
    for (const s of stepIds.slice(0, 3)) {
      const task = await taskOf(s);
      expect(task.status).toBe('completed');
      expect(task.body!.endsWith(`\n\nThe ${PLAYBOOK} playbook stopped: They replied.`)).toBe(true);
      expect((await linkOf(s))!.status).toBe('closed');
    }
    expect(await stageOf(accountId)).toBe('engaged');
  });

  it('full chain, no reply: every step ticked done moves the account to Back to nurture', async () => {
    const { accountId, planId, stepIds } = await planned();
    for (const s of stepIds) await setStep(planId, s, { status: 'done' });
    expect((await planOf(accountId)).noReplyAt).not.toBeNull();
    expect(await stageOf(accountId)).toBe('back_to_nurture');
  });

  it('fixed tasks Scout replaced are not reported done; one a person completed before accept is, once', async () => {
    const made = await handedOff();
    const fixed = await fixedLinks(made.assignmentId);
    const first = fixed.find((l) => l.scoutId.endsWith(':first_touch'))!;
    await t.run((ctx) => mockCompleteTask(ctx, first.externalId));
    await acceptAs(made.assignmentId);
    await sync(made.accountId);
    await sync(made.accountId);

    expect(await taskDone(first.externalId)).toHaveLength(1);
    for (const l of fixed.filter((x) => x !== first)) {
      expect((await mockTaskById(l.externalId)).status).toBe('completed');
      expect(await taskDone(l.externalId)).toEqual([]);
    }
  });

  it('a re-push while the plan stands keeps the plan tasks in the baseline', async () => {
    const { accountId, planId } = await planned();
    const { handoffId } = await asPerson(t, (ctx) => push(ctx, accountId), { userId: leader });
    await runOutbox(t.tenantId);
    const [row] = await t.run((ctx) => ctx.tx.select().from(followThroughTable).where(eq(followThroughTable.handoffId, handoffId)));
    const ids = (await linksOf(planId)).map((l) => l.externalTaskId).sort();
    expect(row!.tasks.map((x) => x.id).sort()).toEqual(ids);
  });
});
