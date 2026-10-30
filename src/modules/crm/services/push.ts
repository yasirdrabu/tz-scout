import { and, desc, eq, isNull } from 'drizzle-orm';
import { filterVisibleAccountIds, getAccount, type PersonView } from '@/modules/accounts';
import { gateway } from '@/modules/integrations';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { enqueueJob } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import type { CrmAdapter } from '../contracts/adapter';
import { handoffPushJob, personPushJob } from '../contracts/jobs';
import { crmSetting, handoff } from '../db/schema';
import { batchFor } from './batches';
import { cancelRequested, latestRow, lockAccount, PUSH_PEOPLE_LIMIT } from './handoff';
import { companyLink, getLinks, recordLink } from './links';

export const ASSIGN_FIRST = 'Assign it before pushing.';

const notFound = () => new ScoutError({ slug: 'not-found', status: 404, title: 'That account was not found.' });
const personName = (p: PersonView) => [p.firstName, p.lastName].filter(Boolean).join(' ') || p.email || '';

/**
 * "Push again" and "Push anyway, keep their owner" (CRM-E3-S6, Ruling 20). A new handoff for the latest
 * handoff's assignment and seller, with its own batch, pushed by the same job: its tasks are keyed by the
 * assignment, so they update in place. The same call retries a failed handoff. Refused when the account was
 * never assigned or its assignment was declined or withdrawn, since CRM knows assignments only from events.
 */
export async function push(ctx: ModuleContext, accountId: string, opts: { keepCurrentOwner?: boolean } = {}): Promise<{ handoffId: string }> {
  if ((await filterVisibleAccountIds(ctx, [accountId])).length === 0) throw notFound();
  const latest = await latestRow(ctx, accountId);
  if (!latest || latest.status === 'cancelled' || (await cancelRequested(ctx, latest))) {
    throw new ScoutError({ slug: 'conflict', status: 409, title: ASSIGN_FIRST });
  }
  const id = newId('hof');
  await ctx.tx.insert(handoff).values({
    id,
    tenantId: ctx.tenantId,
    accountId,
    assignmentId: latest.assignmentId,
    sellerUserId: latest.sellerUserId,
    assignedBy: latest.assignedBy,
    assignmentNote: latest.assignmentNote,
    handoffBatchId: await batchFor(ctx, null, ctx.actor.id),
    system: latest.system,
    ownershipAction: opts.keepCurrentOwner ? 'keep' : 'assign',
    isRepush: true,
  });
  await enqueueJob(ctx, handoffPushJob, { handoffId: id });
  return { handoffId: id };
}

/** The latest completed handoff whose assignment still stands, or undefined. */
async function standingHandoff(ctx: ModuleContext, accountId: string) {
  const [row] = await ctx.tx
    .select()
    .from(handoff)
    .where(
      and(
        eq(handoff.tenantId, ctx.tenantId),
        eq(handoff.accountId, accountId),
        eq(handoff.status, 'completed'),
        isNull(handoff.cancelRequestedAt),
        isNull(handoff.undone),
      ),
    )
    .orderBy(desc(handoff.completedAt), desc(handoff.id))
    .limit(1);
  return row;
}

/** Whether the account can take one more linked person: fewer than the push limit linked in `system`. */
async function roomForPeople(ctx: ModuleContext, accountId: string, system: string, personId: string): Promise<boolean> {
  const people = (await getLinks(ctx, accountId)).people.filter((l) => l.system === system);
  return people.length < PUSH_PEOPLE_LIMIT && !people.some((l) => l.scoutId === personId);
}

/**
 * `accounts.person.added` (Ruling 22): a person added to a handed-off account is pushed when the setting is
 * on and the account has fewer than 10 people linked.
 */
export async function queuePersonPush(ctx: ModuleContext, accountId: string, personId: string): Promise<void> {
  const [setting] = await ctx.tx.select({ on: crmSetting.pushNewPeople }).from(crmSetting).where(eq(crmSetting.tenantId, ctx.tenantId));
  if (setting && !setting.on) return;
  const h = await standingHandoff(ctx, accountId);
  if (!h || !(await roomForPeople(ctx, accountId, h.system, personId))) return;
  await enqueueJob(ctx, personPushJob, { accountId, personId });
}

/** The `crm.person.push` job: pushes the person with the handoff's owner decision and links them. */
export async function runPersonPush(ctx: ModuleContext, accountId: string, personId: string): Promise<void> {
  await lockAccount(ctx, accountId);
  const h = await standingHandoff(ctx, accountId);
  if (!h || !(await roomForPeople(ctx, accountId, h.system, personId))) return;
  const companyId = h.companyExternalId ?? (await companyLink(ctx, accountId, h.system));
  const p = (await getAccount(ctx, accountId))?.people.find((x) => x.id === personId);
  if (!companyId || !p || !personName(p)) return;
  const r = await gateway.call(
    ctx,
    h.system,
    'upsertPerson',
    (a) =>
      (a as CrmAdapter).upsertPerson({
        name: personName(p),
        title: p.title,
        email: p.email,
        phones: [p.phone, p.mobilePhone].filter((x): x is string => !!x),
        linkedin: p.linkedinUrl,
        ownerExternalId: h.ownerExternalId,
        takeOverOwner: h.ownershipAction === 'assign',
        companyExternalId: companyId,
      }),
    { module: 'crm' },
  );
  await recordLink(ctx, { scoutType: 'person', scoutId: personId, system: h.system, externalId: r.externalId });
}
