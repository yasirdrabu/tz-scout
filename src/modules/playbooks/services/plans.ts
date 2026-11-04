import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { filterVisibleAccountIds, resolveAccountId } from '@/modules/accounts';
import { memberDirectory, tenantTimezone, userNames } from '@/modules/tenancy';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { planChanged, stepCompleted } from '../contracts/events';
import { accountPlan, planChange, planStep, playbookTemplate } from '../db/schema';
import { dueFlags } from '../domain/next-step';
import { localDate } from '../domain/plan';

export const PLAN_ENDED = 'This plan has ended.';
export const FINISH_STEPS = 'Finish or skip every step first.';
export const NEEDS_REASON = "Say why you're abandoning it.";
export const STEP_STATUSES = ['todo', 'in_progress', 'done', 'skipped'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];
export const MAX_NOTE = 2000;

export type Plan = typeof accountPlan.$inferSelect;
export type Step = typeof planStep.$inferSelect;
type Changed = ('status' | 'steps' | 'owners')[];

const OPEN_STEP = ['todo', 'in_progress'];
const CLOSED = ['completed', 'stopped', 'abandoned'];

const notFound = () => new ScoutError({ slug: 'not-found', status: 404, title: 'That plan was not found.' });
const ended = () => new ScoutError({ slug: 'plan-ended', status: 409, title: PLAN_ENDED });
const invalid = (path: string, message: string) => new ScoutError({ slug: 'validation', status: 400, title: message, errors: [{ path, message }] });

/** Records one change in the plan's history. */
export async function recordChange(ctx: ModuleContext, planId: string, kind: string, detail: unknown, stepId: string | null = null): Promise<void> {
  await ctx.tx.insert(planChange).values({ id: newId('pch'), tenantId: ctx.tenantId, planId, stepId, kind, detail: detail ?? null, by: ctx.actor.id });
}

/** Publishes `playbooks.plan.changed` for a plan row. */
export async function publishChanged(ctx: ModuleContext, plan: Pick<Plan, 'id' | 'accountId' | 'status'>, changed: Changed, reason?: string): Promise<void> {
  await publish(
    ctx,
    planChanged,
    { planId: plan.id, accountId: plan.accountId, status: plan.status as 'active', changed, ...(reason ? { reason } : {}) },
    { type: 'account', id: plan.accountId },
  );
}

/** A plan by id with its row locked. A plan on an account the caller cannot see is a 404. */
async function loadPlan(ctx: ModuleContext, planId: string): Promise<Plan> {
  const [plan] = await ctx.tx.select().from(accountPlan).where(and(eq(accountPlan.tenantId, ctx.tenantId), eq(accountPlan.id, planId))).for('update');
  if (!plan || (await filterVisibleAccountIds(ctx, [plan.accountId])).length === 0) throw notFound();
  return plan;
}

const stepsOf = (ctx: ModuleContext, planId: string) =>
  ctx.tx.select().from(planStep).where(and(eq(planStep.tenantId, ctx.tenantId), eq(planStep.planId, planId))).orderBy(asc(planStep.order), asc(planStep.id));

export type StepView = Omit<Step, 'tenantId' | 'planId'> & { ownerName: string | null; overdue: boolean; dueToday: boolean };
export type HistoryView = { id: string; kind: string; stepId: string | null; detail: unknown; by: string | null; byName: string | null; at: Date };
export type PlanView = {
  id: string;
  accountId: string;
  status: string;
  statusReason: string | null;
  playbook: { id: string; name: string; version: number };
  /** The template has been edited since the plan started. The plan keeps the version it started with. */
  newerVersion: boolean;
  offerId: string | null;
  tier: string | null;
  assignmentId: string;
  sellerUserId: string | null;
  startDate: string;
  stopWhen: string;
  /** Days since the start date in the workspace timezone (0 on the start day). */
  day: number;
  /** The last step's day. */
  days: number;
  steps: StepView[];
  history: HistoryView[];
};

const daysBetween = (from: string, to: string) => {
  const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
  return Math.max(0, Math.round((ms(to) - ms(from)) / 86_400_000));
};

async function view(ctx: ModuleContext, plan: Plan): Promise<PlanView> {
  const [template] = await ctx.tx.select().from(playbookTemplate).where(eq(playbookTemplate.id, plan.templateId));
  const steps = await stepsOf(ctx, plan.id);
  const history = await ctx.tx
    .select()
    .from(planChange)
    .where(and(eq(planChange.tenantId, ctx.tenantId), eq(planChange.planId, plan.id)))
    .orderBy(desc(planChange.at), desc(planChange.id))
    .limit(200);
  const ids = [...steps.map((s) => s.ownerUserId), ...history.map((h) => h.by)].filter((x): x is string => !!x);
  const names = ids.length ? await userNames(ctx, ids) : new Map<string, string>();
  const today = localDate(Date.now(), await tenantTimezone(ctx));
  return {
    id: plan.id,
    accountId: plan.accountId,
    status: plan.status,
    statusReason: plan.statusReason,
    playbook: { id: plan.templateId, name: template?.name ?? '', version: plan.templateVersion },
    newerVersion: !!template && template.version > plan.templateVersion,
    offerId: plan.offerId,
    tier: plan.tier,
    assignmentId: plan.assignmentId,
    sellerUserId: plan.sellerUserId,
    startDate: plan.startDate,
    stopWhen: plan.stopWhen,
    day: daysBetween(plan.startDate, today),
    days: steps.reduce((m, s) => Math.max(m, s.day), 0),
    steps: steps.map(({ tenantId: _t, planId: _p, ...s }) => ({
      ...s,
      ownerName: s.ownerUserId ? (names.get(s.ownerUserId) ?? null) : null,
      ...(OPEN_STEP.includes(s.status) ? dueFlags(s.dueDate, today) : { overdue: false, dueToday: false }),
    })),
    history: history.map((h) => ({ id: h.id, kind: h.kind, stepId: h.stepId, detail: h.detail, by: h.by, byName: h.by ? (names.get(h.by) ?? null) : null, at: h.at })),
  };
}

/**
 * The account's open plan, else its latest plan, else null. Follows a merged account id; null too for an account the
 * caller cannot see (the route answers 404).
 */
export async function getPlan(ctx: ModuleContext, accountId: string): Promise<PlanView | null> {
  const found = await resolveAccountId(ctx, accountId);
  if (!found || (await filterVisibleAccountIds(ctx, [found.id])).length === 0) return null;
  const rows = await ctx.tx
    .select()
    .from(accountPlan)
    .where(and(eq(accountPlan.tenantId, ctx.tenantId), eq(accountPlan.accountId, found.id)))
    .orderBy(desc(accountPlan.createdAt), desc(accountPlan.id));
  const plan = rows.find((p) => !CLOSED.includes(p.status)) ?? rows[0];
  return plan ? view(ctx, plan) : null;
}

export type StepPatch = { status?: StepStatus; note?: string | null; ownerUserId?: string | null; dueDate?: string };

/** Changes a step: status, note, owner (a workspace member, or null for no one) or due date. Done publishes `playbooks.step.completed`. */
export async function updateStep(ctx: ModuleContext, planId: string, stepId: string, patch: StepPatch): Promise<PlanView> {
  const plan = await loadPlan(ctx, planId);
  if (CLOSED.includes(plan.status)) throw ended();
  const [step] = await ctx.tx.select().from(planStep).where(and(eq(planStep.tenantId, ctx.tenantId), eq(planStep.planId, planId), eq(planStep.id, stepId))).for('update');
  if (!step) throw notFound();
  const set: Partial<Step> = {};
  const changes: [string, unknown][] = [];
  let completed = false;

  if (patch.status !== undefined && patch.status !== step.status) {
    set.status = patch.status;
    changes.push(['step_status', { from: step.status, to: patch.status }]);
    if (patch.status === 'done') {
      set.doneAt = new Date();
      set.doneBy = ctx.actor.id;
      completed = true;
    } else if (step.status === 'done') {
      set.doneAt = null;
      set.doneBy = null;
    }
  }
  if (patch.note !== undefined) {
    const note = patch.note === null ? null : patch.note.trim() || null;
    if (note !== null && note.length > MAX_NOTE) throw invalid('note', `Keep this under ${MAX_NOTE.toLocaleString('en-US')} characters.`);
    if (note !== step.note) {
      set.note = note;
      changes.push(['note', { from: step.note, to: note }]);
    }
  }
  if (patch.ownerUserId !== undefined && patch.ownerUserId !== step.ownerUserId) {
    if (patch.ownerUserId !== null && !(await memberDirectory(ctx)).some((m) => m.userId === patch.ownerUserId)) {
      throw invalid('owner_user_id', 'Pick someone from this workspace.');
    }
    set.ownerUserId = patch.ownerUserId;
    changes.push(['owner', { from: step.ownerUserId, to: patch.ownerUserId }]);
  }
  if (patch.dueDate !== undefined && patch.dueDate !== step.dueDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(patch.dueDate) || Number.isNaN(Date.parse(`${patch.dueDate}T00:00:00Z`))) throw invalid('due_date', 'Use a date like 2026-12-31.');
    set.dueDate = patch.dueDate;
    changes.push(['due_date', { from: step.dueDate, to: patch.dueDate }]);
  }

  if (changes.length > 0) {
    await ctx.tx.update(planStep).set(set).where(eq(planStep.id, stepId));
    await ctx.tx.update(accountPlan).set({ updatedAt: new Date() }).where(eq(accountPlan.id, planId));
    for (const [kind, detail] of changes) await recordChange(ctx, planId, kind, detail, stepId);
    await publishChanged(ctx, plan, changes.some(([k]) => k === 'owner') ? ['steps', 'owners'] : ['steps']);
    if (completed) {
      await publish(
        ctx,
        stepCompleted,
        { planId, stepId, accountId: plan.accountId, channel: step.channel as 'email', doneBy: ctx.actor.id, doneAt: (set.doneAt as Date).toISOString() },
        { type: 'account', id: plan.accountId },
      );
    }
    await audit(ctx, { action: 'playbooks.plan_step.updated', subject: { type: 'account_plan', id: planId }, after: { stepId, changed: changes.map(([k]) => k) } });
  }
  const [fresh] = await ctx.tx.select().from(accountPlan).where(eq(accountPlan.id, planId));
  return view(ctx, fresh!);
}

async function move(ctx: ModuleContext, plan: Plan, status: string, statusReason: string | null, kind: string, detail: unknown, changed: Changed, reason?: string): Promise<Plan> {
  const [row] = await ctx.tx.update(accountPlan).set({ status, statusReason, updatedAt: new Date() }).where(eq(accountPlan.id, plan.id)).returning();
  await recordChange(ctx, plan.id, kind, detail);
  await publishChanged(ctx, row!, changed, reason);
  await audit(ctx, { action: `playbooks.plan.${kind}`, subject: { type: 'account_plan', id: plan.id }, after: { status, reason: statusReason } });
  return row!;
}

/** Pauses an active plan by hand. A plan already paused is returned as it is. */
export async function pausePlan(ctx: ModuleContext, planId: string): Promise<PlanView> {
  const plan = await loadPlan(ctx, planId);
  if (CLOSED.includes(plan.status)) throw ended();
  if (plan.status === 'paused') return view(ctx, plan);
  return view(ctx, await move(ctx, plan, 'paused', 'paused_by_hand', 'paused', { reason: 'by_hand' }, ['status']));
}

/** Resumes a paused plan by hand. Owners stay as they are. A plan already active is returned as it is. */
export async function resumePlan(ctx: ModuleContext, planId: string): Promise<PlanView> {
  const plan = await loadPlan(ctx, planId);
  if (CLOSED.includes(plan.status)) throw ended();
  if (plan.status === 'active') return view(ctx, plan);
  return view(ctx, await move(ctx, plan, 'active', null, 'resumed', { reason: 'by_hand' }, ['status']));
}

/** Completes a plan once every step is done or skipped (409 otherwise). */
export async function completePlan(ctx: ModuleContext, planId: string): Promise<PlanView> {
  const plan = await loadPlan(ctx, planId);
  if (CLOSED.includes(plan.status)) throw ended();
  const steps = await stepsOf(ctx, planId);
  if (steps.some((s) => OPEN_STEP.includes(s.status))) throw new ScoutError({ slug: 'steps-open', status: 409, title: FINISH_STEPS });
  return view(ctx, await move(ctx, plan, 'completed', null, 'completed', {}, ['status']));
}

/** Abandons a plan; `reason` is required (400). Open steps stay as they were. */
export async function abandonPlan(ctx: ModuleContext, planId: string, reason: string | null | undefined): Promise<PlanView> {
  const why = reason?.trim();
  if (!why) throw invalid('reason', NEEDS_REASON);
  const plan = await loadPlan(ctx, planId);
  if (CLOSED.includes(plan.status)) throw ended();
  return view(ctx, await move(ctx, plan, 'abandoned', why, 'abandoned', { reason: why }, ['status'], why));
}

/**
 * Stops a plan because the work is over (R2c-3: the buyer replied or booked). Open steps become `skipped`. Called by the
 * system, so there is no visibility check; a plan that already ended is left alone. Publishes `playbooks.plan.changed`.
 */
export async function stopPlan(ctx: ModuleContext, planId: string, reason: string): Promise<void> {
  const [plan] = await ctx.tx.select().from(accountPlan).where(and(eq(accountPlan.tenantId, ctx.tenantId), eq(accountPlan.id, planId))).for('update');
  if (!plan) throw notFound();
  if (CLOSED.includes(plan.status)) return;
  const open = await ctx.tx
    .update(planStep)
    .set({ status: 'skipped' })
    .where(and(eq(planStep.tenantId, ctx.tenantId), eq(planStep.planId, planId), inArray(planStep.status, OPEN_STEP)))
    .returning({ id: planStep.id });
  await move(ctx, plan, 'stopped', reason, 'stopped', { reason, skipped: open.map((s) => s.id) }, open.length > 0 ? ['status', 'steps'] : ['status'], reason);
}
