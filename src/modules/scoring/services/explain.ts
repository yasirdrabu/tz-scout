import { getAccountForScoring } from '@/modules/accounts';
import { listApprovedOffers } from '@/modules/offers';
import type { ModuleContext } from '@/platform/context';
import type { FitPart, RuleHit, ScoringProfile, ScoringSignal } from '../contracts/types';
import { matchTotal } from '../domain/combine';
import { HARD_MISS_CAP, intentText, matchText, missingInputs, summarySentence, wouldRaise, type Explanation, type ExplanationLine } from '../domain/explain';
import { getMatches, getScore } from './read';
import { getProfile } from './profile';
import { toScoringAccount, toScoringOffer, toScoringSignals } from './score';

/** One factor of the `explain_score` tool: a fit, intent or adjust line. `max` of an adjust line is its cap. */
export type ScoreFactor = { name: string; points: number | null; max: number | null; reason: string | null };

/** The `explain_score` object (agent-tools.md) with the full explanation kept as additions. */
export type ScoreExplanation = Explanation & {
  accountId: string;
  /** The explained offer's name: the best offer unless `offerId` asked for another. */
  offer: string | null;
  offerId: string | null;
  fit: number;
  intent: number;
  factors: ScoreFactor[];
  warmIntroPoints: number;
  wouldRaise: string[];
  summary: string;
};

const oneDecimal = (n: number) => Math.round(n * 10) / 10;

/**
 * Lines for a non-best offer, from its stored match: no warm or trust adjustments. Fit and intent come from the match row;
 * a capped fit or total gets the same combine lines as the stored explanation, so the lines add up (SCO-E4-S1-AC1).
 */
function matchLines(
  m: { fit: number; intent: number; matchTotal: number; fitParts: unknown; ruleHits: unknown; disqualifiedReason: string | null; computedAt: Date },
  signals: ScoringSignal[],
  profile: ScoringProfile,
): ExplanationLine[] {
  const lines: ExplanationLine[] = [];
  const parts = m.fitParts as FitPart[];
  if (m.disqualifiedReason !== null) lines.push({ group: 'fit', label: 'Excluded', points: 0, max: 0, text: m.disqualifiedReason });
  else for (const p of parts) lines.push({ group: 'fit', label: p.label, points: oneDecimal(p.points), max: p.max, text: p.note });
  for (const h of m.ruleHits as RuleHit[]) {
    const { text, ageDays } = intentText(h, { signals, now: m.computedAt, profile });
    lines.push({
      group: 'intent',
      label: h.label,
      points: h.points,
      max: h.max,
      text,
      ruleId: h.ruleId,
      signalIds: h.signalIds,
      kind: h.kind,
      ...(ageDays === undefined ? {} : { ageDays }),
    });
  }
  const rawFit = parts.reduce((sum, p) => sum + p.points, 0);
  if (m.disqualifiedReason === null && Math.round(rawFit) > m.fit) {
    lines.push({ group: 'combine', label: 'Hard miss', points: m.fit, text: `Hard miss: fit capped at ${HARD_MISS_CAP}.` });
  }
  if (matchTotal(m.fit, m.intent, profile).cappedAtFit) {
    lines.push({ group: 'combine', label: 'Low fit', points: m.fit, text: `Fit below 50: total capped at fit (${m.fit}).` });
  }
  lines.push({ group: 'combine', label: 'Match', points: m.matchTotal, text: matchText(m.fit, m.intent, profile) });
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
      lines: matchLines(m, toScoringSignals(view), await getProfile(ctx)),
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
    offer: offer?.name ?? null,
    offerId: offer?.id ?? null,
    fit,
    intent,
    factors: explanation.lines
      .filter((l) => l.group !== 'combine')
      .map((l) => ({ name: l.label, points: l.points ?? null, max: l.max ?? null, reason: l.text ?? null })),
    warmIntroPoints,
    wouldRaise: scoringOffer ? wouldRaise(explanation, toScoringOffer(scoringOffer), account) : [],
    summary: summarySentence(explanation),
  };
}
