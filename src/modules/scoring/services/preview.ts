import { and, eq, gte, inArray } from 'drizzle-orm';
import { accountNames } from '@/modules/accounts';
import type { ModuleContext } from '@/platform/context';
import { TIERS, type Match, type Tier } from '../contracts/types';
import { accountScore, offerMatch } from '../db/schema';
import { bestOffer } from '../domain/best-offer';
import { matchScore } from '../domain/combine';
import { tierFor } from '../domain/tiers';
import { draftProfile, getProfile, type ProfilePatch } from './profile';

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 90;
const SAMPLES = 8;

export type PreviewSample = {
  accountId: string;
  name: string;
  fit: number;
  intent: number;
  revenue: number;
  trust: number;
  scoreBefore: number;
  scoreAfter: number;
  tierBefore: Tier;
  tierAfter: Tier;
};

export type ProfilePreview = { before: Record<Tier, number>; after: Record<Tier, number>; samples: PreviewSample[] };

const counts = (): Record<Tier, number> => Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<Tier, number>;

/**
 * What `draft` would do to the accounts scored in the last 90 days: tier counts now and after, and up to 8 sample
 * accounts (those whose tier changes first, then the highest priority). It re-blends the stored per-match scores and
 * writes nothing: no score, no history, no event. A tier set by hand and a tier a floor lifted to stay as they are.
 */
export async function previewProfile(ctx: ModuleContext, draft: ProfilePatch, now: Date = new Date()): Promise<ProfilePreview> {
  const current = await getProfile(ctx);
  const profile = draftProfile(current, draft);
  const scores = await ctx.tx
    .select()
    .from(accountScore)
    .where(and(eq(accountScore.tenantId, ctx.tenantId), gte(accountScore.computedAt, new Date(now.getTime() - WINDOW_DAYS * DAY_MS))));
  const matches = scores.length === 0
    ? []
    : await ctx.tx
        .select()
        .from(offerMatch)
        .where(and(eq(offerMatch.tenantId, ctx.tenantId), inArray(offerMatch.accountId, scores.map((s) => s.accountId))));
  const byAccount = Map.groupBy(matches, (m) => m.accountId);
  const neutralTrust = Math.round(profile.trustNeutral * 100);

  const before = counts();
  const after = counts();
  const rows = scores.map((s) => {
    const tierBefore = s.tier as Tier;
    const scored = (byAccount.get(s.accountId) ?? []).map((m) => {
      const parts = { fit: m.fit, intent: m.intent, revenue: m.revenueScore ?? 50, trust: m.trustScore ?? neutralTrust };
      const { score } = matchScore(parts, profile);
      const hasResearchOrTrigger = (m.ruleHits as { kind: string }[]).some((h) => h.kind !== 'pain');
      const tier = tierFor({ score, disqualifiedReason: m.disqualifiedReason, hasResearchOrTrigger }, profile);
      const match: Match = { offerId: m.offerId, fit: m.fit, intent: m.intent, score, tier };
      return { m, parts, match };
    });
    const best = bestOffer(scored.map((x) => x.match), s.bestOfferId ? [s.bestOfferId] : []);
    const top = scored.find((x) => x.match.offerId === best?.offerId);
    let tierAfter = tierBefore;
    if (best && top) {
      // A floor (research, warm intro) that lifted the scored tier still holds; a hand-set tier is kept as is.
      const floored = s.tierReason !== 'computed' && top.m.disqualifiedReason === null && TIERS.indexOf(s.scoredTier as Tier) > TIERS.indexOf(best.tier);
      tierAfter = (s.tierOverride as Tier | null) ?? (floored ? (s.scoredTier as Tier) : best.tier);
    }
    before[tierBefore]++;
    after[tierAfter]++;
    return { s, top, tierBefore, tierAfter, scoreAfter: best?.score ?? s.matchTotal };
  });

  const picked = rows
    .sort((a, b) => Number(b.tierAfter !== b.tierBefore) - Number(a.tierAfter !== a.tierBefore) || b.s.priority - a.s.priority)
    .slice(0, SAMPLES);
  const names = await accountNames(ctx, picked.map((r) => r.s.accountId));
  const samples = picked.flatMap((r): PreviewSample[] => {
    const name = names.get(r.s.accountId);
    if (name === undefined) return [];
    const parts = r.top?.parts ?? { fit: r.s.fit, intent: r.s.intent, revenue: r.s.revenueScore ?? 50, trust: r.s.trustScore ?? neutralTrust };
    return [{ accountId: r.s.accountId, name, ...parts, scoreBefore: r.s.matchTotal, scoreAfter: r.scoreAfter, tierBefore: r.tierBefore, tierAfter: r.tierAfter }];
  });
  return { before, after, samples };
}
