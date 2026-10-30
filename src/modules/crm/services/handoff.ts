import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { getAccount, getFacts, type PersonView } from '@/modules/accounts';
import { gateway } from '@/modules/integrations';
import type { assignmentCreated } from '@/modules/routing/contracts/events';
import { crmOwnerId, members, tenantSummary, tenantTimezone } from '@/modules/tenancy';
import { config } from '@/platform/config';
import type { ModuleContext } from '@/platform/context';
import { TransactionClosedError } from '@/platform/db/guarded-tx';
import { withTenant } from '@/platform/db/tenant';
import { enqueueJob, publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { log } from '@/platform/log';
import type { CrmAdapter } from '../contracts/adapter';
import { handoffCancelled, handoffCompleted, handoffFailed, handoffNeedsDecision } from '../contracts/events';
import { handoffPushJob, PUSH_MAX_ATTEMPTS } from '../contracts/jobs';
import { handoffPackageProvider } from '../contracts/ports';
import { DEFAULT_FOLLOW_UP_DAYS } from '../contracts/types';
import { crmSetting, fieldMapping, followThrough, handoff } from '../db/schema';
import { propertyValues } from '../domain/fields';
import { buildNote } from '../domain/note';
import { classifyPushError, NO_CRM_OWNER, NO_DOMAIN, NotPushable, OWNER_INACTIVE, REASON_LIMIT, RETRIES_FAILED } from '../domain/push-errors';
import { buildTasks } from '../domain/tasks';
import { batchFor, refreshBatch } from './batches';
import { getLinks, recordLink } from './links';
import { isOwnerActive } from './owners';
import { recheckOwnership, stopReason } from './preflight';

/** Runs that may do CRM work; the job keeps one delivery more for giving up (Ruling 4). */
export const MAX_ATTEMPTS = PUSH_MAX_ATTEMPTS;
/** At most this many people go with a push, primary first. */
export const PUSH_PEOPLE_LIMIT = 10;

type Created = z.infer<typeof assignmentCreated.data>;
type Handoff = typeof handoff.$inferSelect;

/** A cancel was requested (Ruling 6): stop before the next write. */
class Cancelled extends Error {}

export const byId = (ctx: ModuleContext, id: string) => and(eq(handoff.tenantId, ctx.tenantId), eq(handoff.id, id));
export const OPEN = ['queued', 'running'];

/** The handler's transaction was closed under it (time limit): stop now, record nothing; the platform redelivers. */
const transactionClosed = (e: unknown): boolean =>
  e instanceof TransactionClosedError || (e as { cause?: unknown } | null)?.cause instanceof TransactionClosedError;

/** Queues one handoff per assignment (CRM-E3-S1-AC1) and its push job. */
export async function queueHandoff(ctx: ModuleContext, e: Created): Promise<void> {
  const [have] = await ctx.tx
    .select({ id: handoff.id })
    .from(handoff)
    .where(and(eq(handoff.tenantId, ctx.tenantId), eq(handoff.assignmentId, e.assignmentId)));
  if (have) return;
  const [setting] = await ctx.tx.select({ system: crmSetting.system }).from(crmSetting).where(eq(crmSetting.tenantId, ctx.tenantId));
  const id = newId('hof');
  const inserted = await ctx.tx
    .insert(handoff)
    .values({
      id,
      tenantId: ctx.tenantId,
      accountId: e.accountId,
      assignmentId: e.assignmentId,
      sellerUserId: e.sellerUserId,
      assignedBy: e.assignedBy,
      assignmentNote: e.notes,
      handoffBatchId: await batchFor(ctx, e.bulkId ?? null, e.assignedBy),
      system: setting?.system ?? 'hubspot',
      ownershipAction: e.ownershipDecision,
    })
    .onConflictDoNothing()
    .returning({ id: handoff.id });
  if (inserted.length > 0) await enqueueJob(ctx, handoffPushJob, { handoffId: id });
}

/** Every job that writes to the CRM for an account takes this first (Ruling 5). */
export async function lockAccount(ctx: ModuleContext, accountId: string): Promise<void> {
  await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`crm:${ctx.tenantId}:${accountId}`}))`);
}

/**
 * The `crm.handoff.push` job (CRM-E3 Flow, Rulings 3 to 6 and 9). A retryable error is rethrown so the platform
 * retries it, until the run that reaches MAX_ATTEMPTS; that run, and any non-retryable error, marks the handoff
 * failed and returns. A run that finds MAX_ATTEMPTS already used (earlier runs died before they could say so)
 * does no CRM work and marks it failed.
 */
export async function runPush(ctx: ModuleContext, handoffId: string, now: Date = new Date()): Promise<void> {
  // Counted in its own transaction before the lock, so a run that dies, waits too long or rolls back still counts.
  const run = await withTenant(ctx.tenantId, async (tx) => {
    const [row] = await tx.select().from(handoff).where(and(byId(ctx, handoffId), inArray(handoff.status, OPEN))).for('update');
    if (!row) return null; // already finished
    if (row.attempts >= MAX_ATTEMPTS) return { h: row, giveUp: true };
    const [h] = await tx.update(handoff).set({ attempts: sql`${handoff.attempts} + 1`, status: 'running' }).where(byId(ctx, handoffId)).returning();
    return { h: h!, giveUp: false };
  });
  if (!run) return;
  const { h } = run;
  if (run.giveUp) return fail(ctx, h, h.lastError ?? RETRIES_FAILED, true);
  try {
    await lockAccount(ctx, h.accountId);
    if (h.cancelRequestedAt) throw new Cancelled();
    await push(ctx, h, now);
  } catch (e) {
    if (transactionClosed(e)) throw e;
    if (e instanceof Cancelled) {
      await cancelHandoff(ctx, h, now);
      return;
    }
    const f = classifyPushError(e);
    if (f.unexpected) log.error({ err: e, tenantId: ctx.tenantId, handoffId }, 'crm: handoff push failed unexpectedly');
    if (f.retryable && h.attempts < MAX_ATTEMPTS) throw e;
    await fail(ctx, h, f.retryable ? RETRIES_FAILED : f.reason, f.retryable);
  }
}

const ids = (h: Handoff) => ({ handoffId: h.id, accountId: h.accountId, assignmentId: h.assignmentId });
const subject = (h: Handoff) => ({ type: 'account', id: h.accountId });

/** Ends a handoff still queued or running as `cancelled` and publishes `crm.handoff.cancelled` (Ruling 6); one already final is left alone. */
export async function cancelHandoff(ctx: ModuleContext, h: Handoff, now: Date): Promise<void> {
  await settle(ctx, h, { status: 'cancelled' }, (c) => publish(c, handoffCancelled, { ...ids(h), at: now.toISOString() }, subject(h)));
}

async function fail(ctx: ModuleContext, h: Handoff, reason: string, retryable: boolean): Promise<void> {
  const text = reason.slice(0, REASON_LIMIT);
  await settle(ctx, h, { status: 'failed', lastError: text }, (c) =>
    publish(c, handoffFailed, { ...ids(h), system: h.system, attempt: h.attempts, retryable, reason: text }, subject(h)),
  );
}

/**
 * Sets a final status, publishes its event and refreshes the batch, in a transaction of its own so a run whose
 * transaction was aborted still records it, and so the push transaction never holds the handoff row. Only a
 * handoff still queued or running is changed; one already final elsewhere is left alone (`final`) and nothing
 * is published. `unlessCancelled` also skips the write when a cancel was requested (`cancelled`).
 */
async function settle(
  ctx: ModuleContext,
  h: Handoff,
  set: Partial<Handoff>,
  announce: (c: ModuleContext) => Promise<unknown>,
  unlessCancelled = false,
): Promise<'written' | 'cancelled' | 'final'> {
  return withTenant(ctx.tenantId, async (tx) => {
    const c = { ...ctx, tx };
    const done = await tx
      .update(handoff)
      .set(set)
      .where(and(byId(c, h.id), inArray(handoff.status, OPEN), unlessCancelled ? isNull(handoff.cancelRequestedAt) : undefined))
      .returning({ id: handoff.id });
    if (done.length === 0) {
      const [row] = await tx.select({ status: handoff.status }).from(handoff).where(byId(c, h.id));
      return row && OPEN.includes(row.status) ? 'cancelled' : 'final';
    }
    await announce(c);
    if (h.handoffBatchId) await refreshBatch(c, h.handoffBatchId);
    return 'written';
  });
}

const personName = (p: PersonView) => [p.firstName, p.lastName].filter(Boolean).join(' ') || p.email || '';

async function push(ctx: ModuleContext, h: Handoff, now: Date): Promise<void> {
  const system = h.system;
  const sellerOwner = h.sellerUserId ? await crmOwnerId(ctx, h.sellerUserId, system) : null;
  if (!sellerOwner) throw new NotPushable(NO_CRM_OWNER);
  if ((await isOwnerActive(ctx, system, sellerOwner)) === false) throw new NotPushable(OWNER_INACTIVE);
  const account = await getAccount(ctx, h.accountId);
  if (!account?.domain) throw new NotPushable(NO_DOMAIN);

  const re = await recheckOwnership(ctx, account.id, sellerOwner, h.ownershipAction === 'keep');
  if (re.decision.action === 'stop') {
    const reason = stopReason(re.check!);
    const written = await settle(
      ctx,
      h,
      { status: 'needs_decision', decisionReason: reason },
      (c) => publish(c, handoffNeedsDecision, { ...ids(h), reason, currentOwnerName: re.currentOwnerName }, subject(h)),
      true,
    );
    if (written === 'cancelled') throw new Cancelled();
    return;
  }
  const take = re.decision.action === 'assign';
  const takenFrom = re.decision.action === 'assign' ? re.decision.takenFrom : null;
  // Recorded before the first write, so the undo of a push stopped midway knows whom to give the company back to (Ruling 7).
  if (takenFrom) await withTenant(ctx.tenantId, (tx) => tx.update(handoff).set({ takenFromOwner: takenFrom }).where(byId(ctx, h.id)));

  const call = <T>(op: string, fn: (a: CrmAdapter) => Promise<T>) => gateway.call(ctx, system, op, (a) => fn(a as CrmAdapter), { module: 'crm' });
  /** Every CRM write first re-reads the committed cancel flag (Ruling 6). */
  const write = async <T>(op: string, fn: (a: CrmAdapter) => Promise<T>) => {
    const [row] = await ctx.tx.select({ at: handoff.cancelRequestedAt }).from(handoff).where(byId(ctx, h.id));
    if (row?.at) throw new Cancelled();
    return call(op, fn);
  };
  const pkg = await handoffPackageProvider().package(ctx, account.id, h.assignmentId);
  const links = await getLinks(ctx, account.id);
  const scoutUrl = `${config.publicUrl}/t/${(await tenantSummary(ctx)).slug}/accounts/${account.id}`;

  // Company, with the mapped properties the CRM has; empty values are not sent (CRM-E3-S3-AC3).
  const mappings = await ctx.tx
    .select()
    .from(fieldMapping)
    .where(and(eq(fieldMapping.tenantId, ctx.tenantId), eq(fieldMapping.system, system), eq(fieldMapping.crmObject, 'company')));
  const existing = new Set(await call('existingProperties', (a) => a.existingProperties({})));
  const company = await write('upsertCompany', (a) =>
    a.upsertCompany({
      externalId: links.company?.externalId ?? re.check?.companyExternalId ?? undefined,
      domain: account.domain!,
      name: account.name,
      website: account.websiteUrl,
      location: [account.hqCity, account.hqState, account.hqCountry].filter(Boolean).join(', ') || null,
      employees: account.employees,
      description: account.description,
      ownerExternalId: sellerOwner,
      replaceableOwner: take,
      properties: propertyValues(mappings, { ...(pkg?.properties ?? {}), scout_link: scoutUrl }, existing, now),
    }),
  );
  await recordLink(ctx, { scoutType: 'account', scoutId: account.id, system, externalId: company.externalId });

  // People get the same owner decision as the company (CRM-E3-S2-AC3).
  const people = [...account.people].sort((x, y) => Number(y.isPrimary) - Number(x.isPrimary)).filter((p) => personName(p)).slice(0, PUSH_PEOPLE_LIMIT);
  const pushed: { externalId: string; isPrimary: boolean }[] = [];
  for (const p of people) {
    const linked = links.people.find((l) => l.scoutId === p.id && l.system === system);
    const r = await write('upsertPerson', (a) =>
      a.upsertPerson({
        externalId: linked?.externalId,
        name: personName(p),
        title: p.title,
        email: p.email,
        phones: [p.phone, p.mobilePhone].filter((x): x is string => !!x),
        linkedin: p.linkedinUrl,
        ownerExternalId: company.ownerExternalId,
        takeOverOwner: take,
        companyExternalId: company.externalId,
      }),
    );
    await recordLink(ctx, { scoutType: 'person', scoutId: p.id, system, externalId: r.externalId });
    pushed.push({ externalId: r.externalId, isPrimary: p.isPrimary });
  }
  const primaryExternalId = pushed.find((p) => p.isPrimary)?.externalId ?? null;

  // The note; a fingerprint that no longer matches means a person edited it, so the CRM adds a new one.
  const sellerName = (await members(ctx)).find((m) => m.userId === h.sellerUserId)?.name ?? 'the seller';
  const ownerLine = take ? `Owner: ${sellerName}${takenFrom ? ` (reassigned from ${re.currentOwnerName})` : ''}` : `Owner: ${re.currentOwnerName}`;
  const facts = await getFacts(ctx, account.id);
  const { html } = buildNote({
    account,
    people: account.people,
    assignmentNote: h.assignmentNote,
    ownerLine,
    scoutUrl,
    dataAsOf: facts.reduce<Date | null>((m, f) => (!m || f.observedAt > m ? f.observedAt : m), null),
    pkg,
  });
  const note = await write('upsertNote', (a) =>
    a.upsertNote({
      externalId: links.note?.externalId,
      expectedFingerprint: links.note?.fingerprint ?? null,
      companyExternalId: company.externalId,
      personExternalIds: pushed.map((p) => p.externalId),
      html,
      ownerExternalId: sellerOwner,
    }),
  );
  await recordLink(ctx, { scoutType: 'note', scoutId: account.id, system, externalId: note.externalId, fingerprint: note.fingerprint });

  // First touch and follow-ups, keyed by assignment so a re-push updates them in place (Ruling 3).
  const [setting] = await ctx.tx.select({ days: crmSetting.followUpDays }).from(crmSetting).where(eq(crmSetting.tenantId, ctx.tenantId));
  const primary = account.people.find((p) => p.isPrimary && personName(p));
  const best = pkg?.properties.best_offer;
  const tasks = buildTasks({
    account,
    buyer: primary ? { name: personName(primary), title: primary.title, email: primary.email } : null,
    offerName: typeof best === 'string' && best.trim() ? best : null,
    followUpDays: setting?.days ?? DEFAULT_FOLLOW_UP_DAYS,
    handoffAt: now,
    timezone: await tenantTimezone(ctx),
    pkg,
  });
  const keyed = [
    { key: `${h.assignmentId}:first_touch`, spec: tasks.firstTouch },
    ...tasks.followUps.map((f) => ({ key: `${h.assignmentId}:follow_up:${f.day}`, spec: f })),
  ];
  const taskIds: string[] = [];
  for (const { key, spec } of keyed) {
    const linked = links.tasks.find((l) => l.scoutId === key && l.system === system);
    const r = await write('upsertTask', (a) =>
      a.upsertTask({
        externalId: linked?.externalId,
        companyExternalId: company.externalId,
        personExternalId: primaryExternalId,
        subject: spec.subject,
        body: spec.body,
        ownerExternalId: sellerOwner,
        dueAt: spec.dueAt,
      }),
    );
    await recordLink(ctx, { scoutType: 'task', scoutId: key, system, externalId: r.externalId });
    taskIds.push(r.externalId);
  }

  const ft = await call('readFollowThrough', (a) => a.readFollowThrough({ companyExternalId: company.externalId, taskExternalIds: taskIds }));

  // Completion, its baseline, event and batch refresh in one transaction of its own (Ruling 6: only with no cancel).
  const outcome = await settle(
    ctx,
    h,
    { status: 'completed', completedAt: now, ownerExternalId: company.ownerExternalId, companyExternalId: company.externalId, takenFromOwner: takenFrom, lastError: null },
    async (c) => {
      await storeBaseline(c, h.id, ft);
      await publish(
        c,
        handoffCompleted,
        {
          ...ids(h),
          handoffBatchId: h.handoffBatchId,
          system,
          companyExternalId: company.externalId,
          personExternalIds: pushed.map((p) => p.externalId),
          ownerExternalId: company.ownerExternalId,
          ownershipAction: h.ownershipAction as 'assign' | 'keep',
          takenFromOwner: takenFrom,
          taskCount: taskIds.length,
          companyLifecycle: re.check?.lifecycle ?? 'none',
          observedAt: (re.check?.checkedAt ?? now).toISOString(),
        },
        subject(h),
      );
    },
    true,
  );
  if (outcome === 'cancelled') throw new Cancelled();
}

/** What the company already had before the handoff, so follow-through counts only what came after. */
async function storeBaseline(ctx: ModuleContext, handoffId: string, ft: Awaited<ReturnType<CrmAdapter['readFollowThrough']>>): Promise<void> {
  const baseline = { emails: ft.emails, calls: ft.calls, meetings: ft.meetings, deals: ft.deals, openDeals: ft.openDeals };
  const values = {
    baseline,
    latest: baseline,
    tasks: ft.tasks.map((x) => ({ id: x.externalId, status: x.status, due: x.dueAt })),
    stage: ft.stage,
    ownerExternalId: ft.ownerExternalId,
  };
  await ctx.tx
    .insert(followThrough)
    .values({ tenantId: ctx.tenantId, handoffId, ...values })
    .onConflictDoUpdate({ target: [followThrough.tenantId, followThrough.handoffId], set: values });
}
