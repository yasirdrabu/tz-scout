import { getAccountForScoring } from '@/modules/accounts';
import { listApprovedOffers } from '@/modules/offers';
import type { ModuleContext } from '@/platform/context';
import type { FitPart, RuleHit } from '../contracts/types';
import { missingInputs, summarySentence, wouldRaise, type Explanation, type ExplanationLine } from '../domain/explain';
import { getMatches, getScore } from './read';
import { toScoringAccount, toScoringOffer } from './score';

export type ScoreExplanation = Explanation & {
  accountId: string;
  /** The offer explained: the best one unless `offerId` asked for another. */
  offer: { id: string; name: string } | null;
  fit: number;
  intent: number;
  warmIntroPoints: number;
  wouldRaise: string[];
  summary: string;
};

const oneDecimal = (n: number) => Math.round(n * 10) / 10;

/** Lines for a non-best offer, from its stored match: no signal dates, and no warm or trust adjustments. */
function matchLines(m: { fit: number; intent: number; matchTotal: number; fitParts: unknown; ruleHits: unknown; disqualifiedReason: string | null }): ExplanationLine[] {
  const lines: ExplanationLine[] = [];
  if (m.disqualifiedReason !== null) lines.push({ group: 'fit', label: 'Excluded', points: 0, max: 0, text: m.disqualifiedReason });
  else for (const p of m.fitParts as FitPart[]) lines.push({ group: 'fit', label: p.label, points: oneDecimal(p.points), max: p.max, text: p.note });
  for (const h of m.ruleHits as RuleHit[]) {
    lines.push({
      group: 'intent',
      label: h.label,
      points: h.points,
      max: h.max,
      text: h.why ?? `Matched ${h.matched.join(', ')}.`,
      ruleId: h.ruleId,
      signalIds: h.signalIds,
      kind: h.kind,
    });
  }
  lines.push({ group: 'combine', label: 'Match', points: m.matchTotal, text: `Fit ${m.fit} and intent ${m.intent}.` });
  return lines;
}

/**
 * The stored explanation with `wouldRaise` and `summary` (SCO-E4-S2). With `offerId` for an offer that is not the best,
 * explains that offer's match, where priority is the match total; `bestOffer` still names the best one.
 * Null when the account is hidden or missing, has no score, or the offer has no match on it.
 */
export async function explainScore(ctx: ModuleContext, accountId: string, opts: { offerId?: string } = {}): Promise<ScoreExplanation | null> {
  const score = await getScore(ctx, accountId);
  if (!score) return null;
  const stored = score.explanation as Explanation;
  const view = await getAccountForScoring(ctx, score.accountId);
  if (!view) return null;
  const account = toScoringAccount(view);
  const approved = await listApprovedOffers(ctx);

  let explanation: Explanation = stored;
  let offer = stored.bestOffer;
  let fit = score.fit;
  let intent = score.intent;
  let warmIntroPoints = score.warmPoints;
  if (opts.offerId && opts.offerId !== score.bestOfferId) {
    const matches = await getMatches(ctx, accountId);
    const m = matches.find((x) => x.offerId === opts.offerId);
    const named = approved.find((o) => o.id === opts.offerId);
    if (!m || !named) return null;
    offer = { id: named.id, name: named.name };
    fit = m.fit;
    intent = m.intent;
    warmIntroPoints = 0;
    explanation = {
      priority: m.matchTotal,
      tier: m.tier as Explanation['tier'],
      tierReason: 'computed',
      bestOffer: offer,
      lines: matchLines(m),
      otherOffers: matches
        .filter((x) => x !== m)
        .flatMap((x) => {
          const o = approved.find((a) => a.id === x.offerId);
          return o ? [{ id: o.id, name: o.name, total: x.matchTotal, tier: x.tier as Explanation['tier'] }] : [];
        }),
      missing: m.disqualifiedReason === null ? missingInputs(m.fitParts as FitPart[]) : [],
      computedAt: m.computedAt.toISOString(),
      profileVersion: m.profileVersion,
    };
  }

  const scoringOffer = offer && approved.find((o) => o.id === offer!.id);
  return {
    ...explanation,
    // The account's best offer, whichever offer is explained.
    bestOffer: stored.bestOffer,
    accountId: score.accountId,
    offer,
    fit,
    intent,
    warmIntroPoints,
    wouldRaise: scoringOffer ? wouldRaise(explanation, toScoringOffer(scoringOffer), account) : [],
    summary: summarySentence(explanation),
  };
}
