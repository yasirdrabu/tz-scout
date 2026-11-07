import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { filterVisibleAccountIds, listBuyingRoles, listPeople, resolveAccountId } from '@/modules/accounts';
import type { PlanTasks } from '@/modules/crm';
import { memberDirectory, tenantTimezone, userNames } from '@/modules/tenancy';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { planChanged, planNoReply, stepCompleted } from '../contracts/events';
import { accountPlan, planChange, planStep, playbookTemplate } from '../db/schema';
import { dueFlags, pickNextStep } from '../domain/next-step';
import { dueDateFor, insertOrder, linkedPeople, localDate, missingRoles, type PlanPerson, type StepChannel } from '../domain/plan';

export const PLAN_ENDED = 'This plan has ended.';
export const FINISH_STEPS = 'Finish or skip every step first.';
export const NEEDS_REASON = "Say why you're abandoning it.";
export const STEP_STATUSES = ['todo', 'in_progress', 'done', 'skipped'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];
export const MAX_NOTE = 2000;

export type Plan = typeof accountPlan.$inferSelect;
export type Step = typeof planStep.$inferSelect;
type Changed = ('status' | 'steps' | 'owners' | 'account')[];
type StepSnapshot =
  | {
      id: string;
      order: number;
      day: number;
      channel: StepChannel;
      title: string;
      detail: string | null;
      subject: string | null;
      body: string | null;
      status: StepStatus;
      ownerUserId: string | null;
      dueDate: string;
      crmTask: boolean;
    }
  | { id: string; removed: true };

export const OPEN_STEP = ['todo', 'in_progress'];
export const CLOSED = ['completed', 'stopped', 'abandoned'];

const notFound = () => new ScoutError({ slug: 'not-found', status: 404, title: 'That plan was not found.' });
const ended = () => new ScoutError({ slug: 'plan-ended', status: 409, title: PLAN_ENDED });
const invalid = (path: string, message: string) => new ScoutError({ slug: 'validation', status: 400, title: message, errors: [{ path, message }] });

/** Records one change in the plan's history. */
export async function recordChange(ctx: ModuleContext, planId: string, kind: string, detail: unknown, stepId: string | null = null): Promise<void> {
  await ctx.tx.insert(planChange).values({ id: newId('pch'), tenantId: ctx.tenantId, planId, stepId, kind, detail: detail ?? null, by: ctx.actor.id });
}

/** What `plan.changed` says about a step it touched. */
export const snapshot = (s: Pick<Step, 'id' | 'order' | 'day' | 'channel' | 'title' | 'detail' | 'subject' | 'body' | 'status' | 'ownerUserId' | 'dueDate' | 'crmTask'>): StepSnapshot => ({
  id: s.id,
  order: s.order,
  day: s.day,
  channel: s.channel as StepChannel,
  title: s.title,
  detail: s.detail,
  subject: s.subject,
  body: s.body,
  status: s.status as StepStatus,
  ownerUserId: s.ownerUserId,
  dueDate: s.dueDate,
  crmTask: s.crmTask,
});

/** Publishes `playbooks.plan.changed` for a plan row, with the steps the change touched (none for a status-only change). */
export async function publishChanged(
  ctx: ModuleContext,
  plan: Pick<Plan, 'id' | 'accountId' | 'status'>,
  changed: Changed,
  reason?: string,
  extra: { steps?: StepSnapshot[]; previousAccountId?: string } = {},
): Promise<void> {
  await publish(
    ctx,
    planChanged,
    {
      planId: plan.id,
      accountId: plan.accountId,
      status: plan.status as 'active',
      changed,
      ...(reason ? { reason } : {}),
      ...(extra.previousAccountId ? { previousAccountId: extra.previousAccountId } : {}),
      steps: extra.steps ?? [],
    },
    { type: 'account', id: plan.accountId },
  );
}

/**
 * Ruling 15: when the last open step of an active plan closes and nobody replied or booked since accept, publishes
 * `playbooks.plan.no_reply` once. The plan's status does not change. Called inside the transaction that closed the step.
 */
export async function checkNoReply(ctx: ModuleContext, planId: string): Promise<void> {
  await checkFinished(ctx, planId);
  const [plan] = await ctx.tx.select().from(accountPlan).where(and(eq(accountPlan.tenantId, ctx.tenantId), eq(accountPlan.id, planId))).for('update');
  if (!plan || plan.status !== 'active' || plan.engagedAt || plan.noReplyAt) return;
  const steps = await ctx.tx.select({ status: planStep.status }).from(planStep).where(and(eq(planStep.tenantId, ctx.tenantId), eq(planStep.planId, planId)));
  if (steps.length === 0 || steps.some((s) => OPEN_STEP.includes(s.status))) return;
  const now = new Date();
  await ctx.tx.update(accountPlan).set({ noReplyAt: now, updatedAt: now }).where(eq(accountPlan.id, planId));
  await publish(ctx, planNoReply, { planId, accountId: plan.accountId, assignmentId: plan.assignmentId, at: now.toISOString() }, { type: 'account', id: plan.accountId });
}

/** Ruling 5: an active plan whose last open step closed is finished, once. Called from `checkNoReply`, so engaged plans finish too. */
async function checkFinished(ctx: ModuleContext, planId: string): Promise<void> {
  const [plan] = await ctx.tx.select().from(accountPlan).where(and(eq(accountPlan.tenantId, ctx.tenantId), eq(accountPlan.id, planId))).for('update');
  if (!plan || plan.status !== 'active' || plan.finishedAt) return;
  const steps = await ctx.tx.select({ status: planStep.status }).from(planStep).where(and(eq(planStep.tenantId, ctx.tenantId), eq(planStep.planId, planId)));
  if (steps.length === 0 || steps.some((s) => OPEN_STEP.includes(s.status))) return;
  await ctx.tx.update(accountPlan).set({ finishedAt: new Date() }).where(eq(accountPlan.id, planId));
}

/** A plan by id with its row locked. A plan on an account the caller cannot see is a 404. */
async function loadPlan(ctx: ModuleContext, planId: string): Promise<Plan> {
  const [plan] = await ctx.tx.select().from(accountPlan).where(and(eq(accountPlan.tenantId, ctx.tenantId), eq(accountPlan.id, planId))).for('update');
  if (!plan || (await filterVisibleAccountIds(ctx, [plan.accountId])).length === 0) throw notFound();
  return plan;
}

const stepsOf = (ctx: ModuleContext, planId: string) =>
  ctx.tx.select().from(planStep).where(and(eq(planStep.tenantId, ctx.tenantId), eq(planStep.planId, planId))).orderBy(asc(planStep.order), asc(planStep.id));

export type StepView = Omit<Step, 'tenantId' | 'planId'> & {
  ownerName: string | null;
  overdue: boolean;
  dueToday: boolean;
  /** The account's people who hold a target role as stated or set by a person, read live. */
  people: { id: string; name: string }[];
  /** Target roles nobody holds. */
  missingRoles: string[];
};
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
  /** A person added, edited or removed a step after the plan started. */
  customised: boolean;
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

const personName = (p: { firstName: string | null; lastName: string | null; email: string | null }) =>
  [p.firstName, p.lastName].filter(Boolean).join(' ').trim() || p.email || 'Unnamed';

/** One read of the account's people for a plan's steps (none when no step targets a role); roles Enrich or a person added after acceptance count. */
async function planPeople(ctx: ModuleContext, accountId: string, steps: Step[]): Promise<(PlanPerson & { name: string })[]> {
  if (!steps.some((s) => s.targetBuyingRoles.length > 0)) return [];
  return (await listPeople(ctx, accountId)).map((p) => ({ id: p.id, firstName: p.firstName, name: personName(p), roles: p.roles.map((r) => ({ key: r.key, origin: r.origin })) }));
}

/** The account's plans, newest first, and the one that counts: the open plan, else the latest. */
async function accountPlans(ctx: ModuleContext, accountId: string): Promise<{ plan: Plan | undefined; rows: Plan[] }> {
  const rows = await ctx.tx
    .select()
    .from(accountPlan)
    .where(and(eq(accountPlan.tenantId, ctx.tenantId), eq(accountPlan.accountId, accountId)))
    .orderBy(desc(accountPlan.createdAt), desc(accountPlan.id));
  return { plan: rows.find((p) => !CLOSED.includes(p.status)) ?? rows[0], rows };
}

async function view(ctx: ModuleContext, plan: Plan): Promise<PlanView> {
  const [template] = await ctx.tx.select().from(playbookTemplate).where(and(eq(playbookTemplate.tenantId, ctx.tenantId), eq(playbookTemplate.id, plan.templateId)));
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
  const people = await planPeople(ctx, plan.accountId, steps);
  // An archived buying role is not something to go and find.
  const active = new Set(steps.some((s) => s.targetBuyingRoles.length > 0) ? (await listBuyingRoles(ctx)).map((r) => r.key) : []);
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
    customised: plan.customised,
    startDate: plan.startDate,
    stopWhen: plan.stopWhen,
    day: daysBetween(plan.startDate, today),
    days: steps.reduce((m, s) => Math.max(m, s.day), 0),
    steps: steps.map(({ tenantId: _t, planId: _p, ...s }) => ({
      ...s,
      people: linkedPeople(people, s.targetBuyingRoles).map((p) => ({ id: p.id, name: p.name })),
      missingRoles: missingRoles(people, s.targetBuyingRoles).filter((k) => active.has(k)),
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
  const { plan } = await accountPlans(ctx, found.id);
  return plan ? view(ctx, plan) : null;
}

/**
 * CRM's read of the plan for its HubSpot tasks (R2c-3b Ruling 1): the plan `getPlan` picks, with each step's people
 * worked out the same way, or null. A system read: no visibility check.
 */
export async function planTasks(ctx: ModuleContext, accountId: string): Promise<PlanTasks | null> {
  const found = await resolveAccountId(ctx, accountId);
  if (!found) return null;
  const { plan, rows } = await accountPlans(ctx, found.id);
  if (!plan) return null;
  const templates = await ctx.tx
    .select({ id: playbookTemplate.id, name: playbookTemplate.name })
    .from(playbookTemplate)
    .where(and(eq(playbookTemplate.tenantId, ctx.tenantId), inArray(playbookTemplate.id, [...new Set(rows.map((r) => r.templateId))])));
  const nameOf = (templateId: string) => templates.find((x) => x.id === templateId)?.name ?? '';
  const steps = await stepsOf(ctx, plan.id);
  const people = await planPeople(ctx, plan.accountId, steps);
  return {
    planId: plan.id,
    assignmentId: plan.assignmentId,
    playbookName: nameOf(plan.templateId),
    status: plan.status as PlanTasks['status'],
    statusReason: plan.statusReason,
    startedAt: plan.createdAt.toISOString(),
    sellerUserId: plan.sellerUserId,
    steps: steps.map((s) => ({
      id: s.id,
      channel: s.channel as StepChannel,
      title: s.title,
      detail: s.detail,
      subject: s.subject,
      body: s.body,
      status: s.status as StepStatus,
      ownerUserId: s.ownerUserId,
      dueDate: s.dueDate,
      crmTask: s.crmTask,
      personIds: linkedPeople(people, s.targetBuyingRoles).map((p) => p.id),
    })),
    otherPlans: rows
      .filter((r) => r.id !== plan.id)
      .map((r) => ({ planId: r.id, playbookName: nameOf(r.templateId), status: r.status as PlanTasks['status'], statusReason: r.statusReason, startedAt: r.createdAt.toISOString() })),
  };
}

/** 'YYYY-MM-DD' that is a real calendar day (2026-02-31 is not). */
const isRealDate = (s: string) => {
  const ms = Date.parse(`${s}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === s;
};

export const DONE_STEP_KEPT = "A done step can't be removed. Skip it instead.";
export const NEEDS_TITLE = 'Give the step a title.';

export type StepPatch = {
  status?: StepStatus;
  note?: string | null;
  ownerUserId?: string | null;
  dueDate?: string;
  title?: string;
  detail?: string | null;
  /** Moves the step and, unless `dueDate` is also given, recomputes its due date from the plan's start date. */
  day?: number;
  channel?: StepChannel;
  subject?: string | null;
  body?: string | null;
  crmTask?: boolean;
  targetBuyingRoles?: string[];
};
export type StepAdd = {
  day: number;
  channel: StepChannel;
  ownerRole: 'seller' | 'leader' | 'operator';
  title: string;
  detail?: string | null;
  subject?: string | null;
  body?: string | null;
  targetBuyingRoles?: string[];
  crmTask?: boolean;
  /** A workspace member; defaults from `ownerRole`. */
  ownerUserId?: string | null;
};

const isMember = async (ctx: ModuleContext, userId: string) => (await memberDirectory(ctx)).some((m) => m.userId === userId);

/** Target roles must be active buying roles, plus any the step already holds (a role archived since stays valid). */
async function checkRoles(ctx: ModuleContext, roles: string[], kept: string[] = []): Promise<void> {
  if (roles.length === 0) return;
  const known = new Set([...(await listBuyingRoles(ctx)).map((r) => r.key), ...kept]);
  const bad = roles.find((k) => !known.has(k));
  if (bad !== undefined) throw invalid('target_buying_roles', 'Unknown buying role: ' + bad);
}

const checkDay = (day: number) => {
  if (!Number.isInteger(day) || day < 0 || day > 365) throw invalid('day', 'Use a day from 0 to 365.');
};

const byOrder = (a: StepSnapshot, b: StepSnapshot) => ('order' in a && 'order' in b ? a.order - b.order : 0);

/** Moves the steps at or after `order` up by one to make room. Returns the steps it moved. */
async function makeRoom(ctx: ModuleContext, planId: string, order: number, exceptId?: string): Promise<Step[]> {
  const rows = await ctx.tx
    .update(planStep)
    .set({ order: sql`${planStep.order} + 1` })
    .where(and(eq(planStep.tenantId, ctx.tenantId), eq(planStep.planId, planId), sql`${planStep.order} >= ${order}`, exceptId ? sql`${planStep.id} <> ${exceptId}` : sql`true`))
    .returning();
  return rows.sort((a, b) => a.order - b.order);
}

/** Where a step on `day` goes: right after the last other step on that day or earlier (Ruling 8). */
async function orderFor(ctx: ModuleContext, planId: string, day: number, exceptId?: string): Promise<number> {
  return insertOrder((await stepsOf(ctx, planId)).filter((x) => x.id !== exceptId), day);
}

/**
 * Changes a step: status, note, owner (a workspace member, or null for no one), due date, or its content (title, detail,
 * day, channel, subject, body, HubSpot task, target roles). A content change makes the step `edited` and the plan
 * customised; a new day recomputes the due date unless one is given. Done publishes `playbooks.step.completed`.
 */
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
    if (patch.ownerUserId !== null && !(await isMember(ctx, patch.ownerUserId))) {
      throw invalid('owner_user_id', 'Pick someone from this workspace.');
    }
    set.ownerUserId = patch.ownerUserId;
    changes.push(['owner', { from: step.ownerUserId, to: patch.ownerUserId }]);
  }
  if (patch.dueDate !== undefined && patch.dueDate !== step.dueDate) {
    if (!isRealDate(patch.dueDate)) throw invalid('due_date', 'Use a date like 2026-12-31.');
    set.dueDate = patch.dueDate;
    changes.push(['due_date', { from: step.dueDate, to: patch.dueDate }]);
  }

  // Content. Anything that changes marks the step edited and is recorded as one `step_edited` entry.
  const edited: Record<string, { from: unknown; to: unknown }> = {};
  const edit = <K extends keyof Step>(key: K, to: Step[K], label: string = key) => {
    if (JSON.stringify(to) !== JSON.stringify(step[key])) {
      set[key] = to;
      edited[label] = { from: step[key], to };
    }
  };
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw invalid('title', NEEDS_TITLE);
    edit('title', title);
  }
  if (patch.detail !== undefined) edit('detail', patch.detail === null ? null : patch.detail.trim() || null);
  if (patch.channel !== undefined) edit('channel', patch.channel);
  const email = (set.channel ?? step.channel) === 'email';
  if (patch.subject !== undefined) edit('subject', email ? patch.subject?.trim() || null : null);
  if (patch.body !== undefined) edit('body', email ? patch.body?.trim() || null : null);
  // Leaving email drops its text.
  if (!email) {
    if (patch.subject === undefined) edit('subject', null);
    if (patch.body === undefined) edit('body', null);
  }
  if (patch.crmTask !== undefined) edit('crmTask', patch.crmTask, 'crm_task');
  if (patch.targetBuyingRoles !== undefined) {
    const roles = [...new Set(patch.targetBuyingRoles)];
    await checkRoles(ctx, roles, step.targetBuyingRoles);
    edit('targetBuyingRoles', roles, 'target_buying_roles');
  }
  if (patch.day !== undefined && patch.day !== step.day) {
    checkDay(patch.day);
    edit('day', patch.day);
    edit('order', await orderFor(ctx, planId, patch.day, stepId));
    const due = dueDateFor(plan.startDate, patch.day);
    if (patch.dueDate === undefined && due !== step.dueDate) {
      set.dueDate = due;
      edited.due_date = { from: step.dueDate, to: due };
    }
  }
  const customised = Object.keys(edited).length > 0;
  if (customised) {
    if (step.origin === 'template') set.origin = 'edited';
    changes.push(['step_edited', { changed: edited }]);
  }

  if (changes.length > 0) {
    const shifted = set.order !== undefined ? await makeRoom(ctx, planId, set.order, stepId) : [];
    await ctx.tx.update(planStep).set(set).where(eq(planStep.id, stepId));
    await ctx.tx.update(accountPlan).set({ updatedAt: new Date(), ...(customised ? { customised: true } : {}) }).where(eq(accountPlan.id, planId));
    for (const [kind, detail] of changes) await recordChange(ctx, planId, kind, detail, stepId);
    await publishChanged(ctx, plan, changes.some(([k]) => k === 'owner') ? ['steps', 'owners'] : ['steps'], undefined, {
      steps: [...shifted.map(snapshot), snapshot({ ...step, ...set })].sort(byOrder),
    });
    if (completed) {
      await publish(
        ctx,
        stepCompleted,
        { planId, stepId, accountId: plan.accountId, channel: step.channel as 'email', doneBy: ctx.actor.id, doneAt: (set.doneAt as Date).toISOString() },
        { type: 'account', id: plan.accountId },
      );
    }
    await audit(ctx, { action: 'playbooks.plan_step.updated', subject: { type: 'account_plan', id: planId }, after: { stepId, changed: changes.map(([k]) => k) } });
    if (set.status !== undefined) await checkNoReply(ctx, planId);
  }
  const [fresh] = await ctx.tx.select().from(accountPlan).where(eq(accountPlan.id, planId));
  return view(ctx, fresh!);
}

/**
 * Adds a step to an open (active or paused) plan. Its due date is the plan's start date plus its day, moved to a working
 * day; its owner follows its role (seller: the plan's seller, leader: the assigning leader when the plan knows one,
 * operator: no one) unless `ownerUserId` is given.
 */
export async function addStep(ctx: ModuleContext, planId: string, input: StepAdd): Promise<PlanView> {
  const plan = await loadPlan(ctx, planId);
  if (CLOSED.includes(plan.status)) throw ended();
  const title = input.title.trim();
  if (!title) throw invalid('title', NEEDS_TITLE);
  checkDay(input.day);
  const roles = [...new Set(input.targetBuyingRoles ?? [])];
  await checkRoles(ctx, roles);
  let ownerUserId: string | null = null;
  if (input.ownerUserId) {
    if (!(await isMember(ctx, input.ownerUserId))) throw invalid('owner_user_id', 'Pick someone from this workspace.');
    ownerUserId = input.ownerUserId;
  } else if (input.ownerRole === 'seller') {
    ownerUserId = plan.sellerUserId;
  } else if (input.ownerRole === 'leader') {
    ownerUserId = (await stepsOf(ctx, planId)).find((s) => s.ownerRole === 'leader' && s.ownerUserId)?.ownerUserId ?? null;
  }
  const email = input.channel === 'email';
  const order = await orderFor(ctx, planId, input.day);
  const shifted = await makeRoom(ctx, planId, order);
  const people = roles.length ? (await listPeople(ctx, plan.accountId)).map((p) => ({ id: p.id, firstName: p.firstName, roles: p.roles.map((r) => ({ key: r.key, origin: r.origin })) })) : [];
  const [row] = await ctx.tx
    .insert(planStep)
    .values({
      id: newId('stp'),
      tenantId: ctx.tenantId,
      planId,
      templateStepId: null,
      order,
      day: input.day,
      channel: input.channel,
      ownerRole: input.ownerRole,
      ownerUserId,
      title,
      detail: input.detail?.trim() || null,
      targetPersonIds: linkedPeople(people, roles).map((p) => p.id),
      targetBuyingRoles: roles,
      dueDate: dueDateFor(plan.startDate, input.day),
      status: 'todo',
      origin: 'added',
      crmTask: input.crmTask ?? true,
      subject: email ? input.subject?.trim() || null : null,
      body: email ? input.body?.trim() || null : null,
    })
    .returning();
  await ctx.tx.update(accountPlan).set({ updatedAt: new Date(), customised: true }).where(eq(accountPlan.id, planId));
  await recordChange(ctx, planId, 'step_added', { title, day: row!.day, channel: row!.channel, ownerRole: row!.ownerRole, ownerUserId, dueDate: row!.dueDate, order }, row!.id);
  await publishChanged(ctx, plan, ownerUserId ? ['steps', 'owners'] : ['steps'], undefined, { steps: [...shifted.map(snapshot), snapshot(row!)].sort(byOrder) });
  await audit(ctx, { action: 'playbooks.plan_step.added', subject: { type: 'account_plan', id: planId }, after: { stepId: row!.id } });
  const [fresh] = await ctx.tx.select().from(accountPlan).where(eq(accountPlan.id, planId));
  return view(ctx, fresh!);
}

/** Takes a step out of an open plan. A done step stays (409): skip it instead. */
export async function removeStep(ctx: ModuleContext, planId: string, stepId: string): Promise<PlanView> {
  const plan = await loadPlan(ctx, planId);
  if (CLOSED.includes(plan.status)) throw ended();
  const [step] = await ctx.tx.select().from(planStep).where(and(eq(planStep.tenantId, ctx.tenantId), eq(planStep.planId, planId), eq(planStep.id, stepId))).for('update');
  if (!step) throw notFound();
  if (step.status === 'done') throw new ScoutError({ slug: 'step-done', status: 409, title: DONE_STEP_KEPT });
  await ctx.tx.delete(planStep).where(eq(planStep.id, stepId));
  await ctx.tx.update(accountPlan).set({ updatedAt: new Date(), customised: true }).where(eq(accountPlan.id, planId));
  await recordChange(ctx, planId, 'step_removed', { title: step.title, day: step.day, channel: step.channel, status: step.status, dueDate: step.dueDate }, stepId);
  await publishChanged(ctx, plan, ['steps'], undefined, { steps: [{ id: stepId, removed: true }] });
  await audit(ctx, { action: 'playbooks.plan_step.removed', subject: { type: 'account_plan', id: planId }, after: { stepId } });
  await checkNoReply(ctx, planId);
  const [fresh] = await ctx.tx.select().from(accountPlan).where(eq(accountPlan.id, planId));
  return view(ctx, fresh!);
}

async function move(ctx: ModuleContext, plan: Plan, status: string, statusReason: string | null, kind: string, detail: unknown, changed: Changed, reason?: string, steps: StepSnapshot[] = []): Promise<Plan> {
  const now = new Date();
  // Ruling 5: completed or stopped finishes the plan, once; abandoned never does.
  const finishes = status === 'completed' || status === 'stopped';
  const [row] = await ctx.tx
    .update(accountPlan)
    .set({ status, statusReason, updatedAt: now, ...(finishes ? { finishedAt: sql`coalesce(${accountPlan.finishedAt}, ${now.toISOString()}::timestamptz)` } : {}) })
    .where(eq(accountPlan.id, plan.id))
    .returning();
  await recordChange(ctx, plan.id, kind, detail);
  await publishChanged(ctx, row!, changed, reason, { steps });
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
  const resumed = await move(ctx, plan, 'active', null, 'resumed', { reason: 'by_hand' }, ['status']);
  // Steps may have all closed while it was paused.
  await checkNoReply(ctx, planId);
  return view(ctx, resumed);
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
    .returning();
  await move(ctx, plan, 'stopped', reason, 'stopped', { reason, skipped: open.map((s) => s.id) }, open.length > 0 ? ['status', 'steps'] : ['status'], reason, open.sort((a, b) => a.order - b.order).map(snapshot));
}

export type NextStep = { title: string; dueDate: string; overdue: boolean; dueToday: boolean; ownerUserId: string | null };
export type PlanSummary = { planId: string; playbookName: string; nextStep: NextStep | null };

/**
 * For the lists (Ruling 15): each account with an open plan (`active` or `paused`) and that plan's playbook name,
 * plus its next step, the earliest `todo` or `in_progress` step by due date, then order. `nextStep` is null when the
 * plan is paused or has nothing left open, but the name still shows. One query for any number of ids. Accounts
 * without an open plan are absent. The caller passes ids its list already filtered for visibility.
 */
export async function nextSteps(ctx: ModuleContext, accountIds: string[]): Promise<Map<string, PlanSummary>> {
  const out = new Map<string, PlanSummary>();
  if (accountIds.length === 0) return out;
  const rows = await ctx.tx
    .select({ accountId: accountPlan.accountId, planId: accountPlan.id, status: accountPlan.status, playbookName: playbookTemplate.name, step: planStep })
    .from(accountPlan)
    .innerJoin(playbookTemplate, eq(playbookTemplate.id, accountPlan.templateId))
    .leftJoin(planStep, and(eq(planStep.tenantId, accountPlan.tenantId), eq(planStep.planId, accountPlan.id), inArray(planStep.status, OPEN_STEP)))
    .where(and(eq(accountPlan.tenantId, ctx.tenantId), inArray(accountPlan.status, ['active', 'paused']), inArray(accountPlan.accountId, accountIds)));
  const today = localDate(Date.now(), await tenantTimezone(ctx));
  const byAccount = new Map<string, typeof rows>();
  for (const r of rows) byAccount.set(r.accountId, [...(byAccount.get(r.accountId) ?? []), r]);
  for (const [accountId, list] of byAccount) {
    const first = list[0]!;
    const open = first.status === 'active' ? list.filter((r) => r.step) : [];
    const pick = pickNextStep(open.map((r) => ({ step: r.step!, status: r.step!.status, dueDate: r.step!.dueDate, order: r.step!.order })));
    out.set(accountId, {
      planId: first.planId,
      playbookName: first.playbookName,
      nextStep: pick
        ? { title: pick.step.title, dueDate: pick.step.dueDate, ...dueFlags(pick.step.dueDate, today), ownerUserId: pick.step.ownerUserId }
        : null,
    });
  }
  return out;
}

/** How many open steps the caller owns that are due today or overdue, in active plans (tenant timezone). One query. */
export async function myStepCounts(ctx: ModuleContext): Promise<{ dueToday: number; overdue: number }> {
  const today = localDate(Date.now(), await tenantTimezone(ctx));
  const [row] = await ctx.tx
    .select({
      dueToday: sql<number>`count(*) filter (where ${planStep.dueDate} = ${today})::int`,
      overdue: sql<number>`count(*) filter (where ${planStep.dueDate} < ${today})::int`,
    })
    .from(planStep)
    .innerJoin(accountPlan, and(eq(accountPlan.tenantId, planStep.tenantId), eq(accountPlan.id, planStep.planId)))
    .where(and(eq(planStep.tenantId, ctx.tenantId), eq(planStep.ownerUserId, ctx.actor.id), inArray(planStep.status, OPEN_STEP), eq(accountPlan.status, 'active')));
  return { dueToday: row?.dueToday ?? 0, overdue: row?.overdue ?? 0 };
}
