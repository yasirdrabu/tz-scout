import { and, desc, eq, inArray } from 'drizzle-orm';
import { getAccount } from '@/modules/accounts';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { accountScore, offerMatch, scoreChange } from '../db/schema';
import type { AccountScore } from './score';

export type OfferMatchView = typeof offerMatch.$inferSelect;
export type ScoreChangeView = typeof scoreChange.$inferSelect;

const MAX_HISTORY = 50;

/** The surviving account id, or null when the principal cannot see the account. */
async function visibleId(ctx: ModuleContext, accountId: string): Promise<string | null> {
  return (await getAccount(ctx, accountId))?.id ?? null;
}

/** The current score, with that offer's match when `offerId` is given. Null when there is none or the account is hidden. */
export async function getScore(
  ctx: ModuleContext,
  accountId: string,
  opts: { offerId?: string } = {},
): Promise<(AccountScore & { match?: OfferMatchView | null }) | null> {
  const id = await visibleId(ctx, accountId);
  if (!id) return null;
  const [score] = await ctx.tx
    .select()
    .from(accountScore)
    .where(and(eq(accountScore.tenantId, ctx.tenantId), eq(accountScore.accountId, id)));
  if (!score) return null;
  if (!opts.offerId) return score;
  const [match] = await ctx.tx
    .select()
    .from(offerMatch)
    .where(and(eq(offerMatch.tenantId, ctx.tenantId), eq(offerMatch.accountId, id), eq(offerMatch.offerId, opts.offerId)));
  return { ...score, match: match ?? null };
}

/** Every offer's match for the account, best total first. */
export async function getMatches(ctx: ModuleContext, accountId: string): Promise<OfferMatchView[]> {
  const id = await visibleId(ctx, accountId);
  if (!id) return [];
  return ctx.tx
    .select()
    .from(offerMatch)
    .where(and(eq(offerMatch.tenantId, ctx.tenantId), eq(offerMatch.accountId, id)))
    .orderBy(desc(offerMatch.matchTotal), desc(offerMatch.fit), offerMatch.offerId);
}

/** Score changes, newest first. `limit` is 1 to 50 (default 10). */
export async function getScoreHistory(ctx: ModuleContext, accountId: string, opts: { limit?: number } = {}): Promise<ScoreChangeView[]> {
  const limit = opts.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY) {
    throw new ScoutError({ slug: 'validation', status: 400, title: `Ask for 1 to ${MAX_HISTORY} changes at a time.` });
  }
  const id = await visibleId(ctx, accountId);
  if (!id) return [];
  return ctx.tx
    .select()
    .from(scoreChange)
    .where(and(eq(scoreChange.tenantId, ctx.tenantId), eq(scoreChange.accountId, id)))
    .orderBy(desc(scoreChange.at), desc(scoreChange.id))
    .limit(limit);
}

export type TierDetail = {
  /** "Was {old}": the tier before the latest change, when that change was a rescore that moved the tier. */
  previousTier: string | null;
  /** The tier Scout scored; differs from the account's tier when a person set one by hand. */
  scoredTier: string;
  /** Who set the tier by hand, when, and why; null while the tier is Scout's (Decision 4). */
  tierSetBy: string | null;
  tierSetAt: Date | null;
  tierNote: string | null;
  warmIntro: { introducerName: string | null; points: number } | null;
};

/** Causes that are a rescore of the whole tenant or a person's rescore, after which the queue shows "Was {old}". */
const RESCORES = ['rules_changed', 'manual_rescore'];

/** Tier and warm intro details for queue rows. The caller has already limited `accountIds` to accounts the principal can see. */
export async function tierDetails(ctx: ModuleContext, accountIds: string[]): Promise<Map<string, TierDetail>> {
  if (accountIds.length === 0) return new Map();
  const scores = await ctx.tx
    .select({
      accountId: accountScore.accountId,
      warmPoints: accountScore.warmPoints,
      warmIntroducerId: accountScore.warmIntroducerId,
      warmIntroducerName: accountScore.warmIntroducerName,
      scoredTier: accountScore.scoredTier,
      tierSetBy: accountScore.tierOverrideBy,
      tierSetAt: accountScore.tierOverrideAt,
      tierNote: accountScore.tierOverrideNote,
    })
    .from(accountScore)
    .where(and(eq(accountScore.tenantId, ctx.tenantId), inArray(accountScore.accountId, accountIds)));
  const latest = await ctx.tx
    .selectDistinctOn([scoreChange.accountId], { accountId: scoreChange.accountId, fromTier: scoreChange.fromTier, toTier: scoreChange.toTier, cause: scoreChange.cause })
    .from(scoreChange)
    .where(and(eq(scoreChange.tenantId, ctx.tenantId), inArray(scoreChange.accountId, accountIds)))
    .orderBy(scoreChange.accountId, desc(scoreChange.at), desc(scoreChange.id));
  const moved = new Map(latest.filter((c) => RESCORES.includes(c.cause) && c.fromTier && c.fromTier !== c.toTier).map((c) => [c.accountId, c.fromTier!]));
  return new Map(
    scores.map((s) => [
      s.accountId,
      {
        previousTier: moved.get(s.accountId) ?? null,
        scoredTier: s.scoredTier,
        tierSetBy: s.tierSetBy,
        tierSetAt: s.tierSetAt,
        tierNote: s.tierNote,
        warmIntro: s.warmPoints > 0 || s.warmIntroducerId ? { introducerName: s.warmIntroducerName, points: s.warmPoints } : null,
      },
    ]),
  );
}
