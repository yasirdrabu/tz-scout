import { and, desc, eq, gte, inArray, max, ne, sql } from 'drizzle-orm';
import { filterVisibleAccountIds } from '@/modules/accounts';
import { gateway } from '@/modules/integrations';
import { userForCrmOwner } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { enqueueJob, publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import type { CrmAdapter } from '../contracts/adapter';
import { activityObserved } from '../contracts/events';
import { syncJob } from '../contracts/jobs';
import type { ActivityKind } from '../contracts/types';
import { activity, followThrough as followThroughTable, handoff, link, taskLink } from '../db/schema';
import { countsOfRow, type FollowThroughCounts } from '../domain/follow-through';
import { syncDeals } from './deals';
import { lockAccount } from './handoff';
import { crmSystem } from './owners';

type Handoff = typeof handoff.$inferSelect;

/** Most accounts one poll reads (Ruling 17). */
export const POLL_LIMIT = 200;
/** A handoff stops being polled this long after it completed. */
export const POLL_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;

const latestCompleted = async (ctx: ModuleContext, accountId: string): Promise<Handoff | undefined> =>
  (
    await ctx.tx
      .select()
      .from(handoff)
      .where(and(eq(handoff.tenantId, ctx.tenantId), eq(handoff.accountId, accountId), eq(handoff.status, 'completed')))
      .orderBy(desc(handoff.completedAt), desc(handoff.id))
      .limit(1)
  )[0];

/**
 * Reads one account's follow-through and activities now (Ruling 18) and records what is new. Never writes to the CRM.
 * Takes the account lock like every job that touches the account (Ruling 5). Reads the account's deals too, from its handoff company or else its company link.
 */
export async function syncAccount(ctx: ModuleContext, accountId: string, now: Date): Promise<void> {
  await lockAccount(ctx, accountId);
  const h = await latestCompleted(ctx, accountId);
  if (h?.companyExternalId) await syncFollowThrough(ctx, h, h.companyExternalId, now);
  const system = h?.system ?? (await crmSystem(ctx));
  // applyDeals keeps only deals whose company has an account link, so read by the linked companies; the handoff's company is the fallback.
  const linked = (
    await ctx.tx
      .select({ externalId: link.externalId })
      .from(link)
      .where(and(eq(link.tenantId, ctx.tenantId), eq(link.scoutType, 'account'), eq(link.scoutId, accountId), eq(link.system, system)))
  ).map((r) => r.externalId);
  const companies = linked.length ? linked : h?.companyExternalId ? [h.companyExternalId] : [];
  for (const company of companies) await syncDeals(ctx, system, company, now);
}

async function syncFollowThrough(ctx: ModuleContext, h: Handoff, companyExternalId: string, now: Date): Promise<void> {
  const call = <T>(op: string, fn: (a: CrmAdapter) => Promise<T>) => gateway.call(ctx, h.system, op, (a) => fn(a as CrmAdapter), { module: 'crm' });
  const taskIds = (
    await ctx.tx
      .select({ externalId: link.externalId })
      .from(link)
      .where(
        and(
          eq(link.tenantId, ctx.tenantId),
          eq(link.scoutType, 'task'),
          eq(link.system, h.system),
          sql`left(${link.scoutId}, ${h.assignmentId.length + 1}) = ${h.assignmentId + ':'}`,
        ),
      )
  ).map((r) => r.externalId);

  // Nothing before the handoff, and nothing already seen, is new. A task_done is stamped when we saw it, so it does not move this.
  const [seen] = await ctx.tx
    .select({ at: max(activity.occurredAt) })
    .from(activity)
    .where(and(eq(activity.tenantId, ctx.tenantId), eq(activity.accountId, h.accountId), ne(activity.kind, 'task_done')));
  const since = seen?.at && h.completedAt && seen.at > h.completedAt ? seen.at : (h.completedAt ?? now);

  const ft = await call('readFollowThrough', (a) => a.readFollowThrough({ companyExternalId, taskExternalIds: taskIds }));
  const found = await call('listActivities', (a) => a.listActivities({ companyExternalId, since: since.toISOString() }));

  const [stored] = await ctx.tx
    .select()
    .from(followThroughTable)
    .where(and(eq(followThroughTable.tenantId, ctx.tenantId), eq(followThroughTable.handoffId, h.id)));
  const wasDone = new Set((stored?.tasks ?? []).filter((t) => t.status.toUpperCase() === 'COMPLETED').map((t) => t.id));
  const turnedDone = ft.tasks.filter((t) => t.status.toUpperCase() === 'COMPLETED' && !wasDone.has(t.externalId));

  const users = new Map<string, string | null>();
  const userOf = async (owner: string | null) => {
    if (!owner) return null;
    if (!users.has(owner)) users.set(owner, await userForCrmOwner(ctx, h.system, owner));
    return users.get(owner) ?? null;
  };

  const observe = async (a: { externalId: string; kind: ActivityKind; occurredAt: Date; owner: string | null; taskExternalId?: string }) => {
    const inserted = await ctx.tx
      .insert(activity)
      .values({ id: newId('cac'), tenantId: ctx.tenantId, accountId: h.accountId, handoffId: h.id, system: h.system, externalId: a.externalId, kind: a.kind, occurredAt: a.occurredAt })
      .onConflictDoNothing()
      .returning({ id: activity.id });
    if (inserted.length === 0) return;
    const [step] = a.taskExternalId
      ? await ctx.tx
          .select({ stepId: taskLink.stepId })
          .from(taskLink)
          .where(and(eq(taskLink.tenantId, ctx.tenantId), eq(taskLink.system, h.system), eq(taskLink.externalTaskId, a.taskExternalId)))
      : [];
    await publish(
      ctx,
      activityObserved,
      {
        accountId: h.accountId,
        handoffId: h.id,
        system: h.system,
        externalId: a.externalId,
        kind: a.kind,
        occurredAt: a.occurredAt.toISOString(),
        actorCrmOwnerId: a.owner,
        actorUserId: await userOf(a.owner),
        ...(a.taskExternalId ? { taskExternalId: a.taskExternalId, stepId: step?.stepId ?? null } : {}),
      },
      { type: 'account', id: h.accountId },
    );
  };

  for (const a of found) await observe({ externalId: a.externalId, kind: a.kind, occurredAt: new Date(a.occurredAt), owner: a.actorOwnerExternalId });
  // The CRM does not say when a task was completed or by whom: it is stamped now, with no actor.
  for (const t of turnedDone) await observe({ externalId: t.externalId, kind: 'task_done', occurredAt: now, owner: null, taskExternalId: t.externalId });

  await ctx.tx
    .update(followThroughTable)
    .set({
      latest: { emails: ft.emails, calls: ft.calls, meetings: ft.meetings, deals: ft.deals, openDeals: ft.openDeals },
      tasks: ft.tasks.map((x) => ({ id: x.externalId, status: x.status, due: x.dueAt })),
      stage: ft.stage,
      ownerExternalId: ft.ownerExternalId,
      checkedAt: now,
    })
    .where(and(eq(followThroughTable.tenantId, ctx.tenantId), eq(followThroughTable.handoffId, h.id)));
}

/**
 * The `crm.activity.poll` job (Ruling 17, final review C1): a fan-out. It picks the accounts whose latest completed
 * handoff is under 180 days old, least recently checked or queued first, at most `limit`, stamps `sync_queued_at` on
 * them and queues one `crm.sync` per account. It takes no account lock and makes no CRM call: each sync runs in its own
 * job, with its own time limit. An account whose sync keeps failing moves to the back, since its queue stamp is newer
 * than the others' checks. Returns how many were queued.
 */
export async function pollActivity(ctx: ModuleContext, now: Date, limit: number = POLL_LIMIT): Promise<number> {
  const latest = ctx.tx
    .selectDistinctOn([handoff.accountId], { accountId: handoff.accountId, handoffId: handoff.id, completedAt: handoff.completedAt })
    .from(handoff)
    .where(and(eq(handoff.tenantId, ctx.tenantId), eq(handoff.status, 'completed')))
    .orderBy(handoff.accountId, desc(handoff.completedAt), desc(handoff.id))
    .as('latest');
  const due = await ctx.tx
    .select({ accountId: latest.accountId, handoffId: latest.handoffId })
    .from(latest)
    .leftJoin(followThroughTable, and(eq(followThroughTable.tenantId, ctx.tenantId), eq(followThroughTable.handoffId, latest.handoffId)))
    .where(gte(latest.completedAt, new Date(now.getTime() - POLL_WINDOW_MS)))
    .orderBy(
      sql`greatest(coalesce(${followThroughTable.checkedAt}, '-infinity'), coalesce(${followThroughTable.syncQueuedAt}, '-infinity')) asc`,
      latest.accountId,
    )
    .limit(limit);
  if (due.length === 0) return 0;
  await ctx.tx
    .update(followThroughTable)
    .set({ syncQueuedAt: now })
    .where(and(eq(followThroughTable.tenantId, ctx.tenantId), inArray(followThroughTable.handoffId, due.map((d) => d.handoffId))));
  for (const { accountId } of due) await enqueueJob(ctx, syncJob, { accountId });
  return due.length;
}

/** "Check follow-through" (CRM-E5-S1-AC2): the job reads the account now. */
export async function checkFollowThrough(ctx: ModuleContext, accountId: string): Promise<void> {
  await enqueueJob(ctx, syncJob, { accountId });
}

/** The counts for the account page, from the latest completed handoff; null when the account has none or is not visible. */
export async function followThrough(ctx: ModuleContext, accountId: string, now: Date = new Date()): Promise<FollowThroughCounts | null> {
  if ((await filterVisibleAccountIds(ctx, [accountId])).length === 0) return null;
  const h = await latestCompleted(ctx, accountId);
  if (!h) return null;
  const [row] = await ctx.tx
    .select()
    .from(followThroughTable)
    .where(and(eq(followThroughTable.tenantId, ctx.tenantId), eq(followThroughTable.handoffId, h.id)));
  if (!row) return null;
  const [last] = await ctx.tx
    .select({ at: max(activity.occurredAt) })
    .from(activity)
    .where(and(eq(activity.tenantId, ctx.tenantId), eq(activity.accountId, accountId)));
  return countsOfRow(row, last?.at ?? null, now);
}
