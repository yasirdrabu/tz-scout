import { and, desc, eq, max } from 'drizzle-orm';
import { filterVisibleAccountIds } from '@/modules/accounts';
import { connectionSettings } from '@/modules/integrations';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import type { HandoffUndone } from '../contracts/types';
import { activity, deal, followThrough, handoff } from '../db/schema';
import { followThroughCounts, type FollowThroughCounts } from '../domain/batch';
import { getLinks, type AccountLinks } from './links';
import { latestRow } from './push';

const visible = async (ctx: ModuleContext, accountId: string) => (await filterVisibleAccountIds(ctx, [accountId])).length > 0;

export type HandoffRow = {
  id: string;
  status: string;
  ownershipAction: string;
  takenFromOwner: string | null;
  attempts: number;
  lastError: string | null;
  undone: HandoffUndone | null;
  queuedAt: Date;
  completedAt: Date | null;
};

export type HandoffsView = {
  links: AccountLinks;
  /** Newest first. */
  handoffs: HandoffRow[];
  /** For the latest completed handoff, or null. */
  followThrough: { handoffId: string; counts: FollowThroughCounts; stage: string | null; checkedAt: Date | null } | null;
  deals: { id: string; name: string; stage: string | null; status: string; amountCents: number | null; currency: string | null; openedAt: Date | null; closedAt: Date | null }[];
  /** Two companies are linked: a person has to say which one is right. */
  conflict: boolean;
};

/** Everything the account page shows about the account's handoffs. Not found when the caller can't see the account. */
export async function getHandoffs(ctx: ModuleContext, accountId: string): Promise<HandoffsView> {
  if (!(await visible(ctx, accountId))) throw new ScoutError({ slug: 'not-found', status: 404, title: 'That account was not found.' });
  const links = await getLinks(ctx, accountId);
  const rows = await ctx.tx
    .select()
    .from(handoff)
    .where(and(eq(handoff.tenantId, ctx.tenantId), eq(handoff.accountId, accountId)))
    .orderBy(desc(handoff.queuedAt), desc(handoff.id));
  const completed = rows.find((r) => r.status === 'completed');
  const [ft] = completed
    ? await ctx.tx.select().from(followThrough).where(and(eq(followThrough.tenantId, ctx.tenantId), eq(followThrough.handoffId, completed.id)))
    : [];
  const deals = await ctx.tx
    .select({
      id: deal.id,
      name: deal.name,
      stage: deal.stage,
      status: deal.status,
      amountCents: deal.amountCents,
      currency: deal.currency,
      openedAt: deal.openedAt,
      closedAt: deal.closedAt,
    })
    .from(deal)
    .where(and(eq(deal.tenantId, ctx.tenantId), eq(deal.accountId, accountId)))
    .orderBy(desc(deal.openedAt), deal.id);
  return {
    links,
    handoffs: rows.map((r) => ({
      id: r.id,
      status: r.status,
      ownershipAction: r.ownershipAction,
      takenFromOwner: r.takenFromOwner,
      attempts: r.attempts,
      lastError: r.lastError,
      undone: r.undone,
      queuedAt: r.queuedAt,
      completedAt: r.completedAt,
    })),
    followThrough: ft ? { handoffId: ft.handoffId, counts: followThroughCounts(ft), stage: ft.stage, checkedAt: ft.checkedAt } : null,
    deals,
    conflict: links.conflict,
  };
}

/** The account's latest handoff for its status (Ruling 19), with the HubSpot company link once the portal is known; null when none or not visible. */
export async function latestHandoff(
  ctx: ModuleContext,
  accountId: string,
): Promise<{ id: string; status: string; ownershipAction: string; crmUrl: string | null } | null> {
  if (!(await visible(ctx, accountId))) return null;
  const h = await latestRow(ctx, accountId);
  if (!h) return null;
  const portal = h.system === 'hubspot' ? (await connectionSettings(ctx, 'hubspot')).portal_id : undefined;
  const crmUrl =
    (typeof portal === 'string' || typeof portal === 'number') && portal !== '' && h.companyExternalId
      ? `https://app.hubspot.com/contacts/${portal}/record/0-2/${h.companyExternalId}`
      : null;
  return { id: h.id, status: h.status, ownershipAction: h.ownershipAction, crmUrl };
}

/** When the latest CRM activity on the account happened; null when none or not visible. */
export async function lastActivityAt(ctx: ModuleContext, accountId: string): Promise<Date | null> {
  if (!(await visible(ctx, accountId))) return null;
  const [row] = await ctx.tx
    .select({ at: max(activity.occurredAt) })
    .from(activity)
    .where(and(eq(activity.tenantId, ctx.tenantId), eq(activity.accountId, accountId)));
  return row?.at ?? null;
}
