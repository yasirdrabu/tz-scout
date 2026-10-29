import { and, desc, eq } from 'drizzle-orm';
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
