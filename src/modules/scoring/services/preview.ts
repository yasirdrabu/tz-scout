import { and, eq, gte, inArray } from 'drizzle-orm';
import { accountNames, floorBasics } from '@/modules/accounts';
import { listApprovedOffers } from '@/modules/offers';
import type { ModuleContext } from '@/platform/context';
import { TIERS, type Match, type Tier } from '../contracts/types';
import { accountScore, offerMatch } from '../db/schema';
import { bestOffer } from '../domain/best-offer';
import { matchScore } from '../domain/combine';
import { applyFloors, tierFor } from '../domain/tiers';
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
  const approved = await listApprovedOffers(ctx);
  const basics = await floorBasics(ctx, scores.map((s) => s.accountId));
  const neutralTrust = Math.round(profile.trustNeutral * 100);

  const before = counts();
  const after = counts();
  const rows = scores.map((s) => {
    const tierBefore = s.tier as Tier;
    // As the scorer does: the approved offers for the account's practices, in approval order; a match for any other offer is stale.
    const b = basics.get(s.accountId);
    const practiceIds = b?.practiceIds ?? [];
    const offerIds = approved.filter((o) => practiceIds.length === 0 || practiceIds.includes(o.practiceId)).map((o) => o.id);
    const scored = (byAccount.get(s.accountId) ?? []).filter((m) => offerIds.includes(m.offerId)).map((m) => {
      const parts = { fit: m.fit, intent: m.intent, revenue: m.revenueScore ?? 50, trust: m.trustScore ?? neutralTrust };
      const { score } = matchScore(parts, profile);
      const hasResearchOrTrigger = (m.ruleHits as { kind: string }[]).some((h) => h.kind !== 'pain');
      const tier = tierFor({ score, disqualifiedReason: m.disqualifiedReason, hasResearchOrTrigger }, profile);
      const match: Match = { offerId: m.offerId, fit: m.fit, intent: m.intent, score, tier };
      return { m, parts, match };
    });
    const best = bestOffer(scored.map((x) => x.match), offerIds);
    const top = scored.find((x) => x.match.offerId === best?.offerId);
    let tierScored: Tier = 'not_fit';
    if (best && top) {
      tierScored = applyFloors(
        best.tier,
        {
          disqualified: top.m.disqualifiedReason !== null,
          researchTier: b?.researchTier ?? null,
          researchSignalAt: b?.researchTierSignalAt ?? null,
          warmIntro: s.warmIntroducerId !== null || s.warmIntroducerName !== null || s.warmPoints > 0,
          bestFit: best.fit,
        },
        profile,
        now,
      ).tier;
    }
    // A tier set by hand stays through every rescore.
    const tierAfter = (s.tierOverride as Tier | null) ?? tierScored;
    before[tierBefore]++;
    after[tierAfter]++;
    return { s, top, tierBefore, tierAfter, scoreAfter: best?.score ?? 0 };
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
