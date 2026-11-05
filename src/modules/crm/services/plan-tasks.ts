import { createHash } from 'node:crypto';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { getAccount } from '@/modules/accounts';
import { gateway } from '@/modules/integrations';
import { crmOwnerId, tenantSummary, tenantTimezone } from '@/modules/tenancy';
import { config } from '@/platform/config';
import type { ModuleContext } from '@/platform/context';
import { withTenant } from '@/platform/db/tenant';
import type { CrmAdapter } from '../contracts/adapter';
import { handoffPackageProvider } from '../contracts/ports';
import type { PlanTasks } from '../contracts/types';
import { link, taskLink } from '../db/schema';
import { dueAtOn, planTaskSpec } from '../domain/tasks';
import { latestCompleted } from './follow-through';
import { lockAccount } from './handoff';
import { recordLink } from './links';

/** A fixed handoff task the plan sync has dealt with (closed, or found done or gone), keyed by assignment, so it is read once. */
const REPLACED_TASK = 'replaced_task';
const OPEN_STEP = ['todo', 'in_progress'];

type Step = PlanTasks['steps'][number];
type TaskLinkRow = typeof taskLink.$inferSelect;

/** Close notes (Ruling 8). */
const STEP_NOTE = { done: 'Marked done in Scout.', skipped: 'Skipped in Scout.' } as const;
const takenOut = (playbook: string) => `Taken out of the ${playbook} playbook.`;
type PlanState = Pick<PlanTasks, 'playbookName' | 'status' | 'statusReason'>;
/** The note for a task whose plan is no longer active or paused. */
function planNote(plan: PlanState): string {
  if (plan.status === 'stopped') return `The ${plan.playbookName} playbook stopped: ${plan.statusReason ?? 'no reason given'}.`;
  if (plan.status === 'completed') return `The ${plan.playbookName} playbook was completed.`;
  if (plan.status === 'abandoned') return `The ${plan.playbookName} playbook was abandoned.`;
  return takenOut(plan.playbookName);
}

/** The CRM answered that the task is not there (deleted in HubSpot): both adapters say so with status 404. */
const notFound = (e: unknown) => typeof e === 'object' && e !== null && (e as { status?: unknown }).status === 404;

/** Ruling 11: what Scout wrote, so an unchanged task makes no CRM call. */
const fingerprintOf = (t: { subject: string; body: string; owner: string | null; person: string | null; dueAt: string }) =>
  createHash('sha1').update(JSON.stringify([t.subject, t.body, t.owner, t.person, t.dueAt])).digest('hex');

/** Upserts a step's link in its own transaction, right after its CRM call, like `recordLink`. */
async function saveLink(ctx: ModuleContext, row: Omit<TaskLinkRow, 'tenantId'>): Promise<void> {
  const { stepId: _s, system: _y, ...set } = row;
  await withTenant(ctx.tenantId, (tx) =>
    tx
      .insert(taskLink)
      .values({ tenantId: ctx.tenantId, ...row })
      .onConflictDoUpdate({ target: [taskLink.tenantId, taskLink.system, taskLink.stepId], set }),
  );
}

/**
 * The `crm.plan.sync` job (R2c-3b Rulings 3 to 12): makes the account's HubSpot tasks match its plan as it is now. A
 * `crm_task` step that is open on an active or paused plan has an open task, created or updated in place; every other
 * linked open task is closed with its note, and a step reopened after its task closed gets a new one. While the plan
 * stands for the latest handoff, that handoff's open fixed tasks are closed as replaced. Nothing happens before a
 * handoff completed: the push queues the sync. Errors are left to the platform, as for `crm.sync`.
 */
export async function syncPlanTasks(ctx: ModuleContext, accountId: string): Promise<void> {
  await lockAccount(ctx, accountId);
  const h = await latestCompleted(ctx, accountId);
  if (!h?.companyExternalId) return;
  const plan = await handoffPackageProvider().planTasks?.(ctx, accountId);
  if (!plan) return;
  const system = h.system;
  const company = h.companyExternalId;
  const call = <T>(op: string, fn: (a: CrmAdapter) => Promise<T>) => gateway.call(ctx, system, op, (a) => fn(a as CrmAdapter), { module: 'crm' });
  const live = plan.status === 'active' || plan.status === 'paused';

  if (live || plan.assignmentId === h.assignmentId) await replaceFixedTasks(ctx, h.assignmentId, system, company, plan.playbookName, call);

  // This plan's links, and the open ones an earlier plan of the account left behind (its sync had not run when this plan started).
  const links = await ctx.tx
    .select()
    .from(taskLink)
    .where(
      and(
        eq(taskLink.tenantId, ctx.tenantId),
        eq(taskLink.system, system),
        or(eq(taskLink.planId, plan.planId), and(eq(taskLink.accountId, accountId), eq(taskLink.status, 'open'))),
      ),
    );
  /** A task already gone from the CRM counts as closed. */
  const close = async ({ tenantId: _t, ...l }: TaskLinkRow, note: string) => {
    try {
      await call('closeTask', (a) => a.closeTask({ externalId: l.externalTaskId, note }));
    } catch (e) {
      if (!notFound(e)) throw e;
    }
    await saveLink(ctx, { ...l, status: 'closed' });
  };

  const wanted = plan.steps.filter((s) => live && s.crmTask && OPEN_STEP.includes(s.status));
  if (wanted.length > 0) {
    const account = await getAccount(ctx, accountId);
    const scoutUrl = `${config.publicUrl}/t/${(await tenantSummary(ctx)).slug}/accounts/${accountId}`;
    const timezone = await tenantTimezone(ctx);
    const personOf = await personLinks(ctx, system, [...new Set([...wanted.flatMap((s) => s.personIds), ...(account?.people.map((p) => p.id) ?? [])])]);
    const primary = account?.people.find((p) => p.isPrimary);
    const owners = new Map<string, string | null>();
    const ownerOf = async (userId: string | null) => {
      if (!userId) return null;
      if (!owners.has(userId)) owners.set(userId, await crmOwnerId(ctx, userId, system));
      return owners.get(userId) ?? null;
    };
    const sellerOwner = await ownerOf(plan.sellerUserId);

    for (const step of wanted) {
      const spec = planTaskSpec({ step, accountName: account?.name ?? '', playbookName: plan.playbookName, scoutUrl });
      const owner = (await ownerOf(step.ownerUserId)) ?? sellerOwner;
      const person = step.personIds.map((id) => personOf.get(id)).find((x) => !!x) ?? (primary ? personOf.get(primary.id) : undefined) ?? null;
      const dueAt = dueAtOn(step.dueDate, timezone);
      const fingerprint = fingerprintOf({ ...spec, owner, person, dueAt });
      const l = links.find((x) => x.stepId === step.id && x.planId === plan.planId);
      if (l?.status === 'open' && l.fingerprint === fingerprint) continue;
      // A closed or done task is never reopened: a step back to open gets a new one (Ruling 9). A task deleted in the CRM
      // is made again by the adapter.
      const r = await call('upsertTask', (a) =>
        a.upsertTask({
          externalId: l?.status === 'open' ? l.externalTaskId : undefined,
          companyExternalId: company,
          personExternalId: person,
          subject: spec.subject,
          body: spec.body,
          ownerExternalId: owner,
          dueAt,
        }),
      );
      // A task finished in HubSpot stays open here: the follow-through poll reports it done.
      await saveLink(ctx, { stepId: step.id, system, externalTaskId: r.externalId, dueAt: new Date(dueAt), status: 'open', accountId, planId: plan.planId, fingerprint });
    }
  }

  const byId = new Map<string, Step>(plan.steps.map((s) => [s.id, s]));
  for (const l of links) {
    if (l.status !== 'open') continue;
    if (l.planId !== plan.planId) {
      const earlier = plan.otherPlans.find((x) => x.planId === l.planId);
      await close(l, earlier ? planNote(earlier) : takenOut(plan.playbookName));
      continue;
    }
    const step = byId.get(l.stepId);
    if (step && wanted.includes(step)) continue;
    if (!live) await close(l, planNote(plan));
    else if (step && (step.status === 'done' || step.status === 'skipped')) await close(l, STEP_NOTE[step.status]);
    else await close(l, takenOut(plan.playbookName));
  }
}

/** The external person id of each of these people that has a CRM link in `system`. */
async function personLinks(ctx: ModuleContext, system: string, personIds: string[]): Promise<Map<string, string>> {
  if (personIds.length === 0) return new Map();
  const rows = await ctx.tx
    .select({ scoutId: link.scoutId, externalId: link.externalId })
    .from(link)
    .where(and(eq(link.tenantId, ctx.tenantId), eq(link.scoutType, 'person'), eq(link.system, system), inArray(link.scoutId, personIds)))
    .orderBy(link.lastSyncedAt, link.id);
  const out = new Map<string, string>();
  for (const r of rows) if (!out.has(r.scoutId)) out.set(r.scoutId, r.externalId);
  return out;
}

/**
 * Ruling 10: the handoff's fixed tasks (first touch, follow-ups) still open in the CRM are closed as replaced by the
 * playbook; done ones are left as they are. Each is read once: what was dealt with is recorded.
 */
async function replaceFixedTasks(
  ctx: ModuleContext,
  assignmentId: string,
  system: string,
  company: string,
  playbook: string,
  call: <T>(op: string, fn: (a: CrmAdapter) => Promise<T>) => Promise<T>,
): Promise<void> {
  const rows = await ctx.tx
    .select({ type: link.scoutType, externalId: link.externalId })
    .from(link)
    .where(
      and(
        eq(link.tenantId, ctx.tenantId),
        eq(link.system, system),
        sql`((${link.scoutType} = 'task' and left(${link.scoutId}, ${assignmentId.length + 1}) = ${assignmentId + ':'}) or (${link.scoutType} = ${REPLACED_TASK} and ${link.scoutId} = ${assignmentId}))`,
      ),
    );
  const dealt = new Set(rows.filter((r) => r.type === REPLACED_TASK).map((r) => r.externalId));
  const todo = [...new Set(rows.filter((r) => r.type === 'task' && !dealt.has(r.externalId)).map((r) => r.externalId))];
  if (todo.length === 0) return;
  const ft = await call('readFollowThrough', (a) => a.readFollowThrough({ companyExternalId: company, taskExternalIds: todo }));
  for (const externalId of todo) {
    if (ft.tasks.find((x) => x.externalId === externalId)?.status === 'open') {
      await call('closeTask', (a) => a.closeTask({ externalId, note: `Replaced by the ${playbook} playbook.` }));
    }
    await recordLink(ctx, { scoutType: REPLACED_TASK, scoutId: assignmentId, system, externalId });
  }
}
