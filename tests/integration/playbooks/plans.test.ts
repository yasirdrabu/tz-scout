import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { editPerson, upsertFromArrival } from '@/modules/accounts';
import { accountMerged } from '@/modules/accounts/contracts/events';
import { approveOffer, createOffer, createPractice } from '@/modules/offers';
import {
  abandonPlan,
  archiveTemplate,
  completePlan,
  createTemplate,
  deleteTemplate,
  getPlan,
  pausePlan,
  resumePlan,
  setOfferPlaybook,
  stopPlan,
  updateStep,
  updateTemplate,
} from '@/modules/playbooks';
import { accountPlan, planChange, planStep } from '@/modules/playbooks/db/schema';
import { accept, assign, assignmentAccepted, withdraw } from '@/modules/routing';
import { adminDb, closeDbs } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { newId } from '@/platform/ids';
import { publishTestEvent } from '../helpers/publish';
import { completeOffer } from '../offers/helpers';
import { arrivedAccount, asPerson, member, setSummary, type Tenant } from '../routing/helpers';
import { arrival, domain, routingTenant, runPlaybooks } from './helpers';

let t: Tenant;
let seller: string;
let seller2: string;
let leader: string;
let offerId: string;
let templateId: string;

const steps = [
  { day: 0, channel: 'email' as const, ownerRole: 'seller' as const, title: 'Intro', targetBuyingRoles: ['business_owner'], subject: 'Hello {person.first_name} at {account.name}', body: 'From {seller.first_name} about {offer.name}.' },
  { day: 3, channel: 'call' as const, ownerRole: 'leader' as const, title: 'Leader call', detail: 'Call {person.first_name}.' },
  { day: 5, channel: 'task' as const, ownerRole: 'operator' as const, title: 'Research', crmTask: false },
  { day: 7, channel: 'email' as const, ownerRole: 'seller' as const, title: 'Follow up', subject: 'Following up', body: 'Hi again' },
];

beforeAll(async () => {
  t = await routingTenant();
  seller = await member(t, 'seller');
  seller2 = await member(t, 'seller');
  leader = await member(t, 'leader');
  const practice = await t.run((ctx) => createPractice(ctx, { name: 'Main' }));
  offerId = (await t.run(async (ctx) => approveOffer(ctx, (await createOffer(ctx, { name: 'Pilot', practiceId: practice.id, ...completeOffer })).id))).id;
  templateId = (await t.run((ctx) => createTemplate(ctx, { name: 'Act now flow', status: 'active', steps }))).id;
  await t.run((ctx) => setOfferPlaybook(ctx, offerId, 'act_now', templateId));
});
afterAll(closeDbs);

type Made = { accountId: string; assignmentId: string };
/** A seller before the account summary consumers have run is not yet its owner, so only accepting uses the own-accounts limit. */
const asSeller = <T,>(fn: Parameters<typeof asPerson<T>>[1], userId = seller) => asPerson(t, fn, { userId });
const acceptAs = (assignmentId: string, userId: string) => asPerson(t, (ctx) => accept(ctx, assignmentId), { userId, dataLimit: { kind: 'own_accounts' } });
const asLeader = <T,>(fn: Parameters<typeof asPerson<T>>[1]) => asPerson(t, fn, { userId: leader });

/** A scored account with a lead offer and tier, a person holding business_owner, assigned and (unless `acceptIt` is false) accepted. */
async function account(opts: { tier?: string; sellerId?: string; noPlaybook?: boolean; templateId?: string; acceptIt?: boolean; name?: string } = {}): Promise<Made> {
  const accountId = await arrivedAccount(t, { name: opts.name ?? 'Acme' });
  const d = domain();
  const out = await t.run((ctx) => upsertFromArrival(ctx, arrival({ account: { name: opts.name ?? 'Acme', domain: d }, people: [{ firstName: 'Dana', lastName: 'Lee', email: `dana@${d}`, title: 'Manager' }] }), accountId));
  await asPerson(t, (ctx) => editPerson(ctx, out.personIds[0]!, { roleKeys: ['business_owner'] }));
  await setSummary(t, accountId, { tier: opts.tier ?? 'act_now', bestOfferId: offerId });
  const made = await asLeader((ctx) =>
    assign(ctx, accountId, { sellerUserId: opts.sellerId ?? seller, ...(opts.noPlaybook ? { noPlaybook: true } : {}), ...(opts.templateId ? { templateId: opts.templateId } : {}) }),
  );
  if (opts.acceptIt !== false) await acceptAs(made.id, opts.sellerId ?? seller);
  await runPlaybooks(t.tenantId);
  return { accountId, assignmentId: made.id };
}

const plansOf = (accountId: string) => t.run((ctx) => ctx.tx.select().from(accountPlan).where(eq(accountPlan.accountId, accountId)));
const stepsOf = (planId: string) => t.run((ctx) => ctx.tx.select().from(planStep).where(eq(planStep.planId, planId)).orderBy(planStep.order));
/* eslint-disable @typescript-eslint/no-explicit-any -- event payloads are checked field by field below */
const events = async (type: string, accountId: string) =>
  (await adminDb.select().from(outbox).where(eq(outbox.tenantId, t.tenantId)).orderBy(outbox.seq))
    .map((r) => r.payload as { type: string; data: Record<string, any> })
    .filter((e) => e.type === type && e.data.accountId === accountId);
/* eslint-enable @typescript-eslint/no-explicit-any */
const rejects = (p: Promise<unknown>) => p.then(() => null, (e: { status?: number; message: string }) => ({ status: e.status, title: e.message }));

describe('a plan starts on accept', () => {
  it('creates the plan from the lead offer and tier, with rendered drafts, owners and due dates, and publishes plan.created', async () => {
    const { accountId, assignmentId } = await account();
    const [plan] = await plansOf(accountId);
    expect(plan).toMatchObject({ status: 'active', templateId, templateVersion: 1, offerId, tier: 'act_now', assignmentId, sellerUserId: seller, stopWhen: 'reply_or_meeting' });
    const rows = await stepsOf(plan!.id);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      subject: 'Hello Dana at Acme',
      ownerRole: 'seller',
      ownerUserId: seller,
      origin: 'template',
      status: 'todo',
      body: expect.stringContaining('about Pilot.'),
    });
    expect(rows[0]!.targetPersonIds).toHaveLength(1);
    expect(rows[1]).toMatchObject({ ownerUserId: leader, detail: 'Call the contact.' });
    expect(rows[2]).toMatchObject({ ownerUserId: null, crmTask: false });
    expect(rows[0]!.dueDate >= plan!.startDate).toBe(true);
    const [created] = await events('playbooks.plan.created', accountId);
    expect(created!.data).toMatchObject({ planId: plan!.id, offerId, tier: 'act_now', templateId, templateVersion: 1, assignmentId, sellerUserId: seller, stopWhen: 'reply_or_meeting' });
    expect(created!.data.steps).toHaveLength(4);
    expect(created!.data.steps[0]).toMatchObject({ id: rows[0]!.id, order: 1, day: 0, channel: 'email', ownerUserId: seller, crmTask: true, subject: 'Hello Dana at Acme' });
    const history = await t.run((ctx) => ctx.tx.select().from(planChange).where(eq(planChange.planId, plan!.id)));
    expect(history.map((h) => h.kind)).toEqual(['created']);
  });

  it('accepted twice (a redelivery) leaves exactly one plan and one plan.created', async () => {
    const { accountId, assignmentId } = await account();
    const [plan] = await plansOf(accountId);
    await publishTestEvent(t.tenantId, assignmentAccepted, {
      assignmentId,
      accountId,
      sellerUserId: seller,
      acceptedHow: 'seller',
      templateId: null,
      noPlaybook: false,
      assignedBy: leader,
    });
    await runPlaybooks(t.tenantId);
    expect(await plansOf(accountId)).toHaveLength(1);
    expect((await plansOf(accountId))[0]!.id).toBe(plan!.id);
    expect(await events('playbooks.plan.created', accountId)).toHaveLength(1);
    expect(await events('playbooks.plan.not_started', accountId)).toHaveLength(0);
  });

  it('a rescore to another tier after accept leaves the plan on its template and version; an edit reads newer_version', async () => {
    const own = (await t.run((ctx) => createTemplate(ctx, { name: 'Editable', status: 'active', steps: [steps[0]!] }))).id;
    const { accountId } = await account({ templateId: own });
    const [plan] = await plansOf(accountId);
    await setSummary(t, accountId, { tier: 'watch' });
    await t.run((ctx) => updateTemplate(ctx, own, { steps: [steps[0]!, steps[1]!] }));
    const view = await asLeader((ctx) => getPlan(ctx, accountId));
    expect(view).toMatchObject({ id: plan!.id, newerVersion: true, playbook: { id: own, version: 1 }, tier: 'act_now' });
    expect(view!.steps).toHaveLength(1);
    expect((await plansOf(accountId))[0]).toMatchObject({ templateId: own, templateVersion: 1 });
  });

  it('publishes plan.not_started with the reason when no plan starts', async () => {
    const none = await account({ noPlaybook: true, name: 'None Co' });
    expect(await plansOf(none.accountId)).toHaveLength(0);
    expect((await events('playbooks.plan.not_started', none.accountId))[0]!.data).toMatchObject({ assignmentId: none.assignmentId, reason: 'no_playbook_chosen' });

    const nurture = await account({ tier: 'nurture', name: 'Nurture Co' });
    expect(await plansOf(nurture.accountId)).toHaveLength(0);
    expect((await events('playbooks.plan.not_started', nurture.accountId))[0]!.data.reason).toBe('no_offer_playbook');

    const old = (await t.run((ctx) => createTemplate(ctx, { name: 'Soon archived', status: 'active', steps: [steps[0]!] }))).id;
    await t.run((ctx) => archiveTemplate(ctx, old));
    const explicit = await account({ templateId: old, name: 'Archived Co' });
    expect(await plansOf(explicit.accountId)).toHaveLength(0);
    expect((await events('playbooks.plan.not_started', explicit.accountId))[0]!.data.reason).toBe('template_archived');

    const mapped = (await t.run((ctx) => createTemplate(ctx, { name: 'Mapped then archived', status: 'active', steps: [steps[0]!] }))).id;
    await t.run((ctx) => setOfferPlaybook(ctx, offerId, 'good_fit', mapped));
    await t.run((ctx) => archiveTemplate(ctx, mapped));
    const viaOffer = await account({ tier: 'good_fit', name: 'Mapped Co' });
    expect((await events('playbooks.plan.not_started', viaOffer.accountId))[0]!.data.reason).toBe('template_archived');
    await t.run((ctx) => setOfferPlaybook(ctx, offerId, 'good_fit', null));
  });

  it('a template deleted after it was chosen starts no plan (template_archived), without an error', async () => {
    const gone = (await t.run((ctx) => createTemplate(ctx, { name: 'Deleted before accept', steps: [steps[0]!] }))).id;
    const made = await account({ templateId: gone, acceptIt: false, name: 'Gone Co' });
    await t.run((ctx) => deleteTemplate(ctx, gone));
    await acceptAs(made.assignmentId, seller);
    await runPlaybooks(t.tenantId);
    expect(await plansOf(made.accountId)).toHaveLength(0);
    expect((await events('playbooks.plan.not_started', made.accountId))[0]!.data.reason).toBe('template_archived');
  });

  it('an active plan blocks a second one (plan_open)', async () => {
    const { accountId } = await account({ name: 'Open Co' });
    await publishTestEvent(t.tenantId, assignmentAccepted, {
      assignmentId: newId('asg'),
      accountId,
      sellerUserId: seller2,
      acceptedHow: 'seller',
      templateId: null,
      noPlaybook: false,
      assignedBy: leader,
    });
    await runPlaybooks(t.tenantId);
    expect(await plansOf(accountId)).toHaveLength(1);
    expect((await events('playbooks.plan.not_started', accountId))[0]!.data.reason).toBe('plan_open');
  });

  it('a withdrawal pauses the plan, and a new acceptance resumes it with the new seller on the open seller steps', async () => {
    const { accountId, assignmentId } = await account({ name: 'Withdraw Co' });
    const [plan] = await plansOf(accountId);
    const first = (await stepsOf(plan!.id))[0]!;
    await asSeller((ctx) => updateStep(ctx, plan!.id, first.id, { status: 'done' }));

    await asLeader((ctx) => withdraw(ctx, assignmentId));
    await runPlaybooks(t.tenantId);
    expect((await plansOf(accountId))[0]).toMatchObject({ status: 'paused', statusReason: 'withdrawn' });

    const again = await asLeader((ctx) => assign(ctx, accountId, { sellerUserId: seller2 }));
    await acceptAs(again.id, seller2);
    await runPlaybooks(t.tenantId);

    const plans = await plansOf(accountId);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ id: plan!.id, status: 'active', statusReason: null, sellerUserId: seller2, assignmentId: again.id });
    const rows = await stepsOf(plan!.id);
    expect(rows[0]).toMatchObject({ status: 'done', ownerUserId: seller });
    expect(rows[1]).toMatchObject({ ownerRole: 'leader', ownerUserId: leader });
    expect(rows[3]).toMatchObject({ ownerRole: 'seller', ownerUserId: seller2 });
    const changed = (await events('playbooks.plan.changed', accountId)).map((e) => ({ status: e.data.status, changed: e.data.changed }));
    expect(changed).toContainEqual({ status: 'paused', changed: ['status'] });
    expect(changed).toContainEqual({ status: 'active', changed: ['status', 'owners'] });
    expect(await events('playbooks.plan.created', accountId)).toHaveLength(1);
  });

  it('a merged account keeps one open plan: the survivor\'s stays, the other is abandoned; a lone plan moves over', async () => {
    const survivor = await account({ name: 'Survivor Co' });
    const loser = await account({ name: 'Loser Co' });
    const lone = await account({ name: 'Lone Co' });
    const empty = await arrivedAccount(t, { name: 'Empty Co' });
    const merge = async (from: string, into: string) => {
      await publishTestEvent(t.tenantId, accountMerged, { survivorId: into, mergedId: from, mergedBy: leader });
      await runPlaybooks(t.tenantId);
    };
    const [loserPlan] = await plansOf(loser.accountId);
    await merge(loser.accountId, survivor.accountId);
    const after = await plansOf(survivor.accountId);
    expect(after).toHaveLength(2);
    expect(after.find((p) => p.id === loserPlan!.id)).toMatchObject({ status: 'abandoned', statusReason: 'merged' });
    expect(after.filter((p) => p.status === 'active')).toHaveLength(1);
    expect(await plansOf(loser.accountId)).toHaveLength(0);

    const [lonePlan] = await plansOf(lone.accountId);
    await merge(lone.accountId, empty);
    expect(await plansOf(empty)).toEqual([expect.objectContaining({ id: lonePlan!.id, status: 'active' })]);
  });
});

describe('running a plan', () => {
  it('marking a step done publishes step.completed and records history; completing early is a 409', async () => {
    const { accountId } = await account({ name: 'Run Co' });
    const [plan] = await plansOf(accountId);
    const rows = await stepsOf(plan!.id);
    expect(await rejects(asLeader((ctx) => completePlan(ctx, plan!.id)))).toEqual({ status: 409, title: 'Finish or skip every step first.' });

    const view = await asSeller((ctx) => updateStep(ctx, plan!.id, rows[0]!.id, { status: 'done', note: 'Sent it' }));
    expect(view.steps[0]).toMatchObject({ status: 'done', note: 'Sent it', doneBy: seller });
    expect(view.steps[0]!.doneAt).toBeInstanceOf(Date);
    const [done] = await events('playbooks.step.completed', accountId);
    expect(done!.data).toMatchObject({ planId: plan!.id, stepId: rows[0]!.id, channel: 'email', doneBy: seller });
    expect(view.history.map((h) => h.kind)).toEqual(expect.arrayContaining(['step_status', 'note', 'created']));

    for (const s of rows.slice(1)) await asSeller((ctx) => updateStep(ctx, plan!.id, s.id, { status: 'skipped' }));
    expect((await asLeader((ctx) => completePlan(ctx, plan!.id))).status).toBe('completed');
    expect(await rejects(asSeller((ctx) => updateStep(ctx, plan!.id, rows[0]!.id, { note: 'late' })))).toEqual({ status: 409, title: 'This plan has ended.' });
    expect(await rejects(asLeader((ctx) => pausePlan(ctx, plan!.id)))).toEqual({ status: 409, title: 'This plan has ended.' });
  });

  it('owner must be a workspace member; due date and note are checked', async () => {
    const { accountId } = await account({ name: 'Owner Co' });
    const [plan] = await plansOf(accountId);
    const s = (await stepsOf(plan!.id))[0]!;
    expect(await rejects(asLeader((ctx) => updateStep(ctx, plan!.id, s.id, { ownerUserId: 'usr_nobody' })))).toMatchObject({ status: 400 });
    const moved = await asLeader((ctx) => updateStep(ctx, plan!.id, s.id, { ownerUserId: seller2, dueDate: '2030-01-15' }));
    expect(moved.steps[0]).toMatchObject({ ownerUserId: seller2, dueDate: '2030-01-15' });
    expect(await rejects(asLeader((ctx) => updateStep(ctx, plan!.id, s.id, { dueDate: 'soon' })))).toMatchObject({ status: 400 });
    expect(await rejects(asLeader((ctx) => updateStep(ctx, plan!.id, s.id, { note: 'x'.repeat(2001) })))).toMatchObject({ status: 400 });
    expect(await rejects(asLeader((ctx) => updateStep(ctx, plan!.id, 'stp_missing', { note: 'x' })))).toMatchObject({ status: 404 });
  });

  it('pause and resume by hand; abandon needs a reason', async () => {
    const { accountId } = await account({ name: 'Pause Co' });
    const [plan] = await plansOf(accountId);
    expect((await asLeader((ctx) => pausePlan(ctx, plan!.id))).status).toBe('paused');
    expect((await asLeader((ctx) => resumePlan(ctx, plan!.id))).status).toBe('active');
    expect(await rejects(asLeader((ctx) => abandonPlan(ctx, plan!.id, '  ')))).toEqual({ status: 400, title: "Say why you're abandoning it." });
    const gone = await asLeader((ctx) => abandonPlan(ctx, plan!.id, 'Not a fit'));
    expect(gone).toMatchObject({ status: 'abandoned', statusReason: 'Not a fit' });
    expect((await events('playbooks.plan.changed', accountId)).pop()!.data).toMatchObject({ status: 'abandoned', reason: 'Not a fit', changed: ['status'] });
  });

  it('stopPlan skips the open steps and publishes plan.changed; a closed plan is left alone', async () => {
    const { accountId } = await account({ name: 'Stop Co' });
    const [plan] = await plansOf(accountId);
    const first = (await stepsOf(plan!.id))[0]!;
    await asSeller((ctx) => updateStep(ctx, plan!.id, first.id, { status: 'done' }));
    await t.run((ctx) => stopPlan(ctx, plan!.id, 'replied'));
    expect((await plansOf(accountId))[0]).toMatchObject({ status: 'stopped', statusReason: 'replied' });
    expect((await stepsOf(plan!.id)).map((s) => s.status)).toEqual(['done', 'skipped', 'skipped', 'skipped']);
    expect((await events('playbooks.plan.changed', accountId)).pop()!.data).toMatchObject({ status: 'stopped', changed: ['status', 'steps'], reason: 'replied' });
    await t.run((ctx) => stopPlan(ctx, plan!.id, 'again'));
    expect((await plansOf(accountId))[0]!.statusReason).toBe('replied');
  });
});
