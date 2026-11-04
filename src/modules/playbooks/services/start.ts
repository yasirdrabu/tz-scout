import { and, asc, eq, inArray } from 'drizzle-orm';
import { accountNames, getSummaries, listPeople, resolveAccountId } from '@/modules/accounts';
import { getOffer } from '@/modules/offers';
import type { z } from 'zod';
import type { assignmentAccepted } from '@/modules/routing/contracts/events';
import { tenantTimezone, userNames } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { planCreated, planNotStarted } from '../contracts/events';
import { accountPlan, planStep, playbookTemplate, templateStep } from '../db/schema';
import { buildPlan, type OwnerRole, type StepChannel, type StopWhen, type Tier } from '../domain/plan';
import { MAPPED_TIERS, playbookFor } from './offer-playbooks';
import { publishChanged, recordChange, snapshot } from './plans';

type Accepted = z.output<typeof assignmentAccepted.data>;
type NotStarted = 'no_playbook_chosen' | 'no_offer_playbook' | 'template_unavailable' | 'superseded';

const OPEN = ['active', 'paused'];

async function notStarted(ctx: ModuleContext, d: Accepted, reason: NotStarted): Promise<void> {
  await publish(ctx, planNotStarted, { accountId: d.accountId, assignmentId: d.assignmentId, reason }, { type: 'account', id: d.accountId });
}

/** The template row with a share lock, so a delete (which locks it for update) waits until this plan is written. */
async function lockedTemplate(ctx: ModuleContext, id: string) {
  const [t] = await ctx.tx.select().from(playbookTemplate).where(and(eq(playbookTemplate.tenantId, ctx.tenantId), eq(playbookTemplate.id, id))).for('share');
  return t && t.status === 'active' ? t : null;
}

/**
 * An accepted assignment reaches an account whose open plan belongs to another assignment (Ruling 10). A paused plan
 * resumes (the accept came back after a withdrawal). An active one is taken over: the accept for the new assignment
 * arrived before the old one's withdrawal, and routing allows one open assignment per account, so the old one is no
 * longer open. Either way the plan points at the new assignment, open seller steps go to the new seller and open
 * leader steps to the new assigner. Due dates stay: a resumed plan shows its late steps as overdue.
 */
async function takeOver(ctx: ModuleContext, plan: typeof accountPlan.$inferSelect, d: Accepted, acceptedAt: Date): Promise<void> {
  const resuming = plan.status === 'paused';
  const [row] = await ctx.tx
    .update(accountPlan)
    .set({ status: 'active', statusReason: null, sellerUserId: d.sellerUserId, assignmentId: d.assignmentId, acceptedAt, updatedAt: new Date() })
    .where(eq(accountPlan.id, plan.id))
    .returning();
  const open = and(eq(planStep.tenantId, ctx.tenantId), eq(planStep.planId, plan.id), inArray(planStep.status, ['todo', 'in_progress']));
  const moved = await ctx.tx.update(planStep).set({ ownerUserId: d.sellerUserId }).where(and(open, eq(planStep.ownerRole, 'seller'))).returning();
  if (d.assignedBy) moved.push(...(await ctx.tx.update(planStep).set({ ownerUserId: d.assignedBy }).where(and(open, eq(planStep.ownerRole, 'leader'))).returning()));
  const detail = { reason: 'accepted', assignmentId: d.assignmentId, previousAssignmentId: plan.assignmentId, sellerUserId: d.sellerUserId };
  await recordChange(ctx, plan.id, resuming ? 'resumed' : 'taken_over', detail);
  await publishChanged(ctx, row!, resuming ? ['status', 'owners'] : ['owners'], undefined, { steps: moved.map(snapshot) });
}

/**
 * `routing.assignment.accepted` (Ruling 2): starts the account's plan. A redelivery is a no-op (one plan per assignment).
 * An open plan (paused or active) of another assignment is taken over instead of a new one starting. Which playbook: the assignment's choice, else the
 * lead offer's playbook for the account's tier (Ruling 3).
 */
export async function startPlan(ctx: ModuleContext, e: { data: Accepted; occurredAt: string }): Promise<void> {
  // A late event for an account that was merged away starts (or resumes) the plan on the survivor.
  const d = { ...e.data, accountId: (await resolveAccountId(ctx, e.data.accountId))?.id ?? e.data.accountId };
  const [again] = await ctx.tx.select({ id: accountPlan.id }).from(accountPlan).where(and(eq(accountPlan.tenantId, ctx.tenantId), eq(accountPlan.assignmentId, d.assignmentId)));
  if (again) return;

  const [open] = await ctx.tx
    .select()
    .from(accountPlan)
    .where(and(eq(accountPlan.tenantId, ctx.tenantId), eq(accountPlan.accountId, d.accountId), inArray(accountPlan.status, OPEN)))
    .for('update');
  // A retried older accept can arrive after a later one: only a later accept takes an open plan over.
  if (open) return new Date(e.occurredAt) > open.acceptedAt ? takeOver(ctx, open, d, new Date(e.occurredAt)) : notStarted(ctx, d, 'superseded');

  if (d.noPlaybook) return notStarted(ctx, d, 'no_playbook_chosen');
  const [summary] = await getSummaries(ctx, [d.accountId]);
  const leadOfferId = summary ? (summary.leadOfferOverrideId ?? summary.bestOfferId) : null;
  const tier = (MAPPED_TIERS as readonly string[]).includes(summary?.tier ?? '') ? (summary!.tier as Tier) : null;

  let templateId: string;
  if (d.templateId) {
    templateId = d.templateId;
  } else {
    const mapped = leadOfferId && tier ? await playbookFor(ctx, leadOfferId, tier) : null;
    if (!mapped) return notStarted(ctx, d, 'no_offer_playbook');
    templateId = mapped.templateId;
  }
  const template = await lockedTemplate(ctx, templateId);
  if (!template) return notStarted(ctx, d, 'template_unavailable');
  const steps = await ctx.tx
    .select()
    .from(templateStep)
    .where(and(eq(templateStep.tenantId, ctx.tenantId), eq(templateStep.templateId, template.id), eq(templateStep.templateVersion, template.version)))
    .orderBy(asc(templateStep.order));

  const offer = leadOfferId
    ? await getOffer(ctx, leadOfferId).catch((err: unknown) => {
        if (err instanceof ScoutError && err.status === 404) return null;
        throw err;
      })
    : null;
  const names = await userNames(ctx, [d.sellerUserId]);
  const draft = buildPlan({
    template: { id: template.id, version: template.version, stopWhen: template.stopWhen as StopWhen },
    steps: steps.map((s) => ({ ...s, channel: s.channel as StepChannel, ownerRole: s.ownerRole as OwnerRole })),
    startAt: new Date(e.occurredAt),
    timezone: await tenantTimezone(ctx),
    sellerUserId: d.sellerUserId,
    leaderUserId: d.assignedBy,
    people: (await listPeople(ctx, d.accountId)).map((p) => ({ id: p.id, firstName: p.firstName, roles: p.roles.map((r) => ({ key: r.key, origin: r.origin })) })),
    account: { name: (await accountNames(ctx, [d.accountId])).get(d.accountId) ?? '' },
    offer: offer ? { id: offer.id, name: offer.name, promise: offer.promise } : null,
    tier,
    seller: { firstName: names.get(d.sellerUserId)?.trim().split(/\s+/)[0] ?? null },
  });

  const planId = newId('pln');
  await ctx.tx.insert(accountPlan).values({
    id: planId,
    tenantId: ctx.tenantId,
    accountId: d.accountId,
    offerId: draft.offerId,
    tier: draft.tier,
    templateId: draft.templateId,
    templateVersion: draft.templateVersion,
    assignmentId: d.assignmentId,
    sellerUserId: d.sellerUserId,
    stopWhen: draft.stopWhen,
    startDate: draft.startDate,
    acceptedAt: new Date(e.occurredAt),
  });
  const rows = draft.steps.map((s) => ({ ...s, id: newId('stp'), tenantId: ctx.tenantId, planId }));
  if (rows.length > 0) await ctx.tx.insert(planStep).values(rows);
  await recordChange(ctx, planId, 'created', { templateId: draft.templateId, templateVersion: draft.templateVersion, assignmentId: d.assignmentId });
  await publish(
    ctx,
    planCreated,
    {
      planId,
      accountId: d.accountId,
      offerId: draft.offerId,
      tier: draft.tier,
      templateId: draft.templateId,
      templateVersion: draft.templateVersion,
      assignmentId: d.assignmentId,
      sellerUserId: d.sellerUserId,
      stopWhen: draft.stopWhen,
      steps: rows.map((r) => ({
        id: r.id,
        order: r.order,
        day: r.day,
        channel: r.channel,
        title: r.title,
        ownerUserId: r.ownerUserId,
        dueDate: r.dueDate,
        crmTask: r.crmTask,
        subject: r.subject,
        body: r.body,
      })),
    },
    { type: 'account', id: d.accountId },
  );
}

/** A withdrawn (or declined) assignment pauses its running plan; the next acceptance resumes it. No plan, no effect. */
export async function pauseOnWithdrawn(ctx: ModuleContext, assignmentId: string): Promise<void> {
  const [plan] = await ctx.tx
    .select()
    .from(accountPlan)
    .where(and(eq(accountPlan.tenantId, ctx.tenantId), eq(accountPlan.assignmentId, assignmentId), eq(accountPlan.status, 'active')))
    .for('update');
  if (!plan) return;
  const [row] = await ctx.tx.update(accountPlan).set({ status: 'paused', statusReason: 'withdrawn', updatedAt: new Date() }).where(eq(accountPlan.id, plan.id)).returning();
  await recordChange(ctx, plan.id, 'paused', { reason: 'withdrawn', assignmentId });
  await publishChanged(ctx, row!, ['status'], 'withdrawn');
}

/**
 * `accounts.account.merged`: the merged account's plans move to the survivor. When both have an open plan, the survivor's
 * stays and the merged account's is abandoned with reason 'merged'.
 */
export async function plansOnMerge(ctx: ModuleContext, survivorId: string, mergedId: string): Promise<void> {
  const mine = await ctx.tx.select().from(accountPlan).where(and(eq(accountPlan.tenantId, ctx.tenantId), eq(accountPlan.accountId, mergedId))).for('update');
  if (mine.length === 0) return;
  const [kept] = await ctx.tx
    .select({ id: accountPlan.id })
    .from(accountPlan)
    .where(and(eq(accountPlan.tenantId, ctx.tenantId), eq(accountPlan.accountId, survivorId), inArray(accountPlan.status, OPEN)));
  const loser = mine.find((p) => OPEN.includes(p.status));
  if (kept && loser) {
    await ctx.tx.update(accountPlan).set({ status: 'abandoned', statusReason: 'merged', updatedAt: new Date() }).where(eq(accountPlan.id, loser.id));
    await recordChange(ctx, loser.id, 'abandoned', { reason: 'merged', survivorId });
  }
  await ctx.tx.update(accountPlan).set({ accountId: survivorId }).where(and(eq(accountPlan.tenantId, ctx.tenantId), eq(accountPlan.accountId, mergedId)));
  for (const p of mine) {
    const abandoned = kept && loser && p.id === loser.id;
    await publishChanged(ctx, { id: p.id, accountId: survivorId, status: abandoned ? 'abandoned' : p.status }, abandoned ? ['status', 'account'] : ['account'], abandoned ? 'merged' : undefined, {
      previousAccountId: mergedId,
    });
  }
}
