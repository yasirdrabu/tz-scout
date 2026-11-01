import { and, eq, inArray } from 'drizzle-orm';
import { filterVisibleAccountIds, getSummaries, resolveAccountId } from '@/modules/accounts';
import { assignableMembers } from '@/modules/tenancy';
import type { DataLimit } from '@/platform/access';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { accountReview } from '../db/schema';
import { bestMatch, type SellerCandidate } from '../domain/best-match';
import { MAX_BULK } from './assign';
import { loadNames } from './lookups';
import { openAssignmentCounts } from './read';
import { requirePerson } from './review';

export type AssignableSeller = {
  userId: string;
  name: string;
  /** Their focus: the practices their data limit names. */
  practices: { id: string; name: string }[];
  /** Their data limit covers every practice. */
  allPractices: boolean;
  /** Open (pending or accepted) assignments: "{n} active accounts". */
  activeAccounts: number;
  /** Without a linked HubSpot user they can't be picked ("No HubSpot user linked"). */
  crmOwnerLinked: boolean;
  bestMatch: boolean;
};

/** The practices a data limit names; `all` when it covers every practice. Limits by source or own accounts name none. */
export function practicesOf(limit: DataLimit | null): string[] | 'all' {
  if (!limit) return [];
  if (limit.kind === 'all') return 'all';
  if (limit.kind === 'practices') return limit.ids;
  if (limit.kind === 'any_of') {
    const parts = limit.limits.map(practicesOf);
    return parts.includes('all') ? 'all' : [...new Set(parts.flat() as string[])];
  }
  return [];
}

/**
 * The sellers the Assign dialog lists for these accounts (1 to 50, each visible, else 404), with their
 * practices, active account count and HubSpot link, and the "Best match" by Decision 8 with its reason.
 */
export async function assignableSellers(ctx: ModuleContext, accountIds: string[]): Promise<{ data: AssignableSeller[]; bestMatch: { userId: string; reason: string } | null }> {
  requirePerson(ctx);
  const asked = [...new Set(accountIds)];
  if (asked.length === 0 || asked.length > MAX_BULK) {
    throw new ScoutError({ slug: 'validation', status: 400, title: 'Pick 1 to 50 accounts.', errors: [{ path: 'account_ids', message: 'Pick 1 to 50 accounts.' }] });
  }
  const ids: string[] = [];
  for (const id of asked) {
    const resolved = (await resolveAccountId(ctx, id))?.id;
    if (!resolved || (await filterVisibleAccountIds(ctx, [resolved])).length === 0) throw new ScoutError({ slug: 'not-found', status: 404, title: 'That account was not found.' });
    ids.push(resolved);
  }
  const names = await loadNames(ctx);
  const overrides = new Map(
    (
      await ctx.tx
        .select({ accountId: accountReview.accountId, id: accountReview.leadOfferOverrideId })
        .from(accountReview)
        .where(and(eq(accountReview.tenantId, ctx.tenantId), inArray(accountReview.accountId, ids)))
    ).map((r) => [r.accountId, r.id]),
  );
  const best = new Map((await getSummaries(ctx, ids)).map((s) => [s.accountId, s.bestOfferId]));
  // Every account needs a lead offer with a practice for a best match.
  const practiceIds = ids.map((id) => names.offer(overrides.get(id) ?? best.get(id) ?? null)?.practiceId ?? null);
  const needed = practiceIds.includes(null) ? [] : (practiceIds as string[]);

  const active = await openAssignmentCounts(ctx);
  const candidates: SellerCandidate[] = (await assignableMembers(ctx)).map((m) => ({
    userId: m.userId,
    name: m.name,
    practices: practicesOf(m.dataLimit),
    activeAccounts: active[m.userId] ?? 0,
    crmOwnerLinked: Object.values(m.crmOwnerIds).some(Boolean),
  }));
  const match = bestMatch(candidates, needed, (id) => names.practice(id) ?? id);
  return {
    data: candidates.map((c) => ({
      userId: c.userId,
      name: c.name,
      practices: c.practices === 'all' ? [] : c.practices.flatMap((id) => (names.practice(id) ? [{ id, name: names.practice(id)! }] : [])),
      allPractices: c.practices === 'all',
      activeAccounts: c.activeAccounts,
      crmOwnerLinked: c.crmOwnerLinked,
      bestMatch: match?.userId === c.userId,
    })),
    bestMatch: match,
  };
}
