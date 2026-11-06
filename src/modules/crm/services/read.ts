import { and, count, desc, eq, inArray, lte, max } from 'drizzle-orm';
import { filterVisibleAccountIds, getAccount } from '@/modules/accounts';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import type { HandoffUndone } from '../contracts/types';
import { activity, deal, followThrough, handoff } from '../db/schema';
import { meetingHeld, nextMeeting } from '../domain/engagement';
import { countsOfRow, type FollowThroughCounts } from '../domain/follow-through';
import { latestRow } from './handoff';
import { companyChecks, refreshCheck, type CompanyCheck, type OpenDeal } from './checks';
import { companyLink, crmCompanyUrl, getLinks, type AccountLinks } from './links';
import { CRM_UNAVAILABLE } from './preflight';

const visible = async (ctx: ModuleContext, accountId: string) => (await filterVisibleAccountIds(ctx, [accountId])).length > 0;

export type HandoffRow = {
  id: string;
  status: string;
  /** The company in HubSpot, once pushed and the portal is known. */
  crmUrl: string | null;
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
  /** For the latest completed handoff, or null. `meetingsHeld` and `nextMeeting` are R2d Rulings 1, 2 and 7. */
  followThrough: {
    handoffId: string;
    counts: FollowThroughCounts & { replies: number };
    stage: string | null;
    checkedAt: Date | null;
    meetingsHeld: number;
    nextMeeting: { at: string; with: string | null } | null;
  } | null;
  deals: { id: string; name: string; stage: string | null; status: string; amountCents: number | null; currency: string | null; openedAt: Date | null; closedAt: Date | null }[];
  /** Two companies are linked: a person has to say which one is right. */
  conflict: boolean;
};

/** Everything the account page shows about the account's handoffs. Not found when the caller can't see the account. */
export async function getHandoffs(ctx: ModuleContext, accountId: string, now: Date = new Date()): Promise<HandoffsView> {
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
  const replies = completed
    ? ((
        await ctx.tx
          .select({ n: count() })
          .from(activity)
          .where(and(eq(activity.tenantId, ctx.tenantId), eq(activity.handoffId, completed.id), eq(activity.kind, 'reply')))
      )[0]?.n ?? 0)
    : 0;
  const meetings = completed
    ? await ctx.tx
        .select()
        .from(activity)
        .where(and(eq(activity.tenantId, ctx.tenantId), eq(activity.handoffId, completed.id), eq(activity.kind, 'meeting')))
    : [];
  const company = await companyLink(ctx, accountId, rows[0]?.system ?? 'hubspot');
  const urls = new Map<string, string | null>();
  for (const r of rows) urls.set(r.id, await crmCompanyUrl(ctx, r.system, r.companyExternalId ?? company));
  return {
    links,
    handoffs: rows.map((r) => ({
      id: r.id,
      status: r.status,
      crmUrl: urls.get(r.id) ?? null,
      ownershipAction: r.ownershipAction,
      takenFromOwner: r.takenFromOwner,
      attempts: r.attempts,
      lastError: r.lastError,
      undone: r.undone,
      queuedAt: r.queuedAt,
      completedAt: r.completedAt,
    })),
    followThrough: ft
      ? {
          handoffId: ft.handoffId,
          counts: { ...countsOfRow(ft, null, now), replies },
          stage: ft.stage,
          checkedAt: ft.checkedAt,
          meetingsHeld: meetings.filter((m) => meetingHeld(m, now)).length,
          nextMeeting: nextMeeting(meetings, now),
        }
      : null,
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
  // A re-push still in flight has no company yet: the company link has it.
  const crmUrl = await crmCompanyUrl(ctx, h.system, h.companyExternalId ?? (await companyLink(ctx, accountId, h.system)));
  return { id: h.id, status: h.status, ownershipAction: h.ownershipAction, crmUrl };
}

/** When the latest CRM activity on the account happened, not counting rows dated after now (a booked meeting); null when none or not visible. */
export async function lastActivityAt(ctx: ModuleContext, accountId: string, now: Date = new Date()): Promise<Date | null> {
  if (!(await visible(ctx, accountId))) return null;
  const [row] = await ctx.tx
    .select({ at: max(activity.occurredAt) })
    .from(activity)
    .where(and(eq(activity.tenantId, ctx.tenantId), eq(activity.accountId, accountId), lte(activity.occurredAt, now)));
  return row?.at ?? null;
}

/** What a list row shows from the CRM: the latest activity, and the value of a won deal, else an open one. */
export type AccountCrmFacts = {
  lastActivity: { kind: string; at: Date } | null;
  value: { amountCents: number | null; currency: string | null; kind: 'won' | 'open_deal'; dealName: string } | null;
};

/** CRM facts for list rows; the latest activity is at or before now. The caller has already limited `accountIds` to accounts the principal can see. */
export async function crmFacts(ctx: ModuleContext, accountIds: string[], now: Date = new Date()): Promise<Map<string, AccountCrmFacts>> {
  if (accountIds.length === 0) return new Map();
  const activities = await ctx.tx
    .selectDistinctOn([activity.accountId], { accountId: activity.accountId, kind: activity.kind, at: activity.occurredAt })
    .from(activity)
    .where(and(eq(activity.tenantId, ctx.tenantId), inArray(activity.accountId, accountIds), lte(activity.occurredAt, now)))
    .orderBy(activity.accountId, desc(activity.occurredAt), desc(activity.id));
  const deals = await ctx.tx
    .select({ accountId: deal.accountId, name: deal.name, status: deal.status, amountCents: deal.amountCents, currency: deal.currency, openedAt: deal.openedAt, closedAt: deal.closedAt })
    .from(deal)
    .where(and(eq(deal.tenantId, ctx.tenantId), inArray(deal.accountId, accountIds), inArray(deal.status, ['open', 'won'])))
    .orderBy(desc(deal.closedAt), desc(deal.openedAt), deal.id);
  const out = new Map<string, AccountCrmFacts>(accountIds.map((id) => [id, { lastActivity: null, value: null }]));
  for (const a of activities) out.get(a.accountId)!.lastActivity = { kind: a.kind, at: a.at };
  for (const id of accountIds) {
    const mine = deals.filter((d) => d.accountId === id);
    const pick = mine.find((d) => d.status === 'won') ?? mine.find((d) => d.status === 'open');
    if (pick) out.get(id)!.value = { amountCents: pick.amountCents, currency: pick.currency, kind: pick.status === 'won' ? 'won' : 'open_deal', dealName: pick.name };
  }
  return out;
}

/** The account page's In HubSpot card (screens.md §4a). `exists` and `checkedAt` are null when the account was never checked. */
export type CrmCheckCard =
  | { exists: null; checkedAt: null }
  | {
      exists: boolean;
      ownerName: string | null;
      lifecycle: CompanyCheck['lifecycle'];
      openDeals: number;
      openDeal: OpenDeal | null;
      checkedAt: Date;
      hubspotUrl: string | null;
    };

/**
 * The stored CRM check of the account, or with `refresh` a new one asked of the CRM now (a CRM that does not
 * answer is a 503 `crm_unavailable`). Not found when the caller can't see the account.
 */
export async function crmCheckCard(ctx: ModuleContext, accountId: string, opts: { refresh?: boolean } = {}): Promise<CrmCheckCard> {
  const account = await getAccount(ctx, accountId);
  if (!account) throw new ScoutError({ slug: 'not-found', status: 404, title: 'That account was not found.' });
  let check: CompanyCheck | null = null;
  if (opts.refresh) {
    try {
      check = await refreshCheck(ctx, account.id);
    } catch (e) {
      if (e instanceof ScoutError) throw e;
      throw new ScoutError({ status: 503, slug: 'crm_unavailable', title: CRM_UNAVAILABLE });
    }
  }
  check ??= (await companyChecks(ctx, [account.id]))[0] ?? null;
  if (!check) return { exists: null, checkedAt: null };
  return {
    exists: check.exists,
    ownerName: check.ownerName,
    lifecycle: check.lifecycle,
    openDeals: check.openDeals,
    openDeal: check.openDeal,
    checkedAt: check.checkedAt,
    hubspotUrl: await crmCompanyUrl(ctx, check.system, check.companyExternalId),
  };
}

/** Every cached deal in the workspace, for the analytics journey backfill. Background context only. */
export async function listDeals(
  ctx: ModuleContext,
): Promise<{ accountId: string; system: string; externalId: string; status: 'open' | 'won' | 'lost'; amountCents: number | null; closedAt: Date | null; syncedAt: Date }[]> {
  const rows = await ctx.tx
    .select({ accountId: deal.accountId, system: deal.system, externalId: deal.externalId, status: deal.status, amountCents: deal.amountCents, closedAt: deal.closedAt, syncedAt: deal.syncedAt })
    .from(deal)
    .where(eq(deal.tenantId, ctx.tenantId))
    .orderBy(deal.id);
  return rows.map((r) => ({ ...r, status: r.status as 'open' | 'won' | 'lost' }));
}
