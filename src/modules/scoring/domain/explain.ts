// The score explanation: every point of a priority as a line a person can check (SCO-E4).

import type { RuleHit, ScoringAccount, ScoringOffer, ScoringProfile, ScoringSignalKind, Tier, TierReason } from '../contracts/types';
import type { FitResult } from './fit';

const HARD_MISS_CAP = 45;
const TIER_TITLE: Record<Tier, string> = { not_fit: 'Not a fit', watch: 'Watch', good_fit: 'Good fit', act_now: 'Act now' };
const UNKNOWN_NOTE = /unknown\.$/;

export type ExplanationLine = {
  group: 'fit' | 'intent' | 'combine' | 'adjust';
  label: string;
  points?: number;
  max?: number;
  text?: string;
  signalIds?: string[];
  kind?: ScoringSignalKind;
};

export type Explanation = {
  priority: number;
  tier: Tier;
  tierReason: TierReason;
  bestOffer: { id: string; name: string };
  lines: ExplanationLine[];
  otherOffers: { id: string; name: string; total: number; tier: Tier }[];
  missing: string[];
  computedAt: string;
  profileVersion: number;
};

/** What the scoring service hands over after running the domain functions for the best offer. */
export type ExplanationInput = {
  offer: { id: string; name: string };
  fit: FitResult;
  hits: RuleHit[];
  intent: number;
  combine: { total: number; cappedAtFit: boolean };
  profile: Pick<ScoringProfile, 'fitWeight' | 'intentWeight' | 'warmIntroCap' | 'trustModifierMax'>;
  tier: Tier;
  tierReason: TierReason;
  tierText?: string;
  priority: { priority: number; warmPoints: number; trustModifier: number };
  warmIntroFrom: string | null;
  trust: { value: number; sourceName: string } | null;
  otherOffers: Explanation['otherOffers'];
  computedAt: Date;
  profileVersion: number;
};

const oneDecimal = (n: number) => Math.round(n * 10) / 10;

function missingInputs(parts: FitResult['parts']): string[] {
  return parts
    .filter((p) => UNKNOWN_NOTE.test(p.note))
    .map((p) => `${p.label} unknown: adding it could change fit by up to ${Math.round(Math.max(p.points, p.max - p.points))} points.`);
}

export function buildExplanation(input: ExplanationInput): Explanation {
  const { fit, profile, priority } = input;
  const lines: ExplanationLine[] = [];

  if (fit.disqualifiedReason !== null) lines.push({ group: 'fit', label: 'Excluded', points: 0, max: 0, text: fit.disqualifiedReason });
  for (const p of fit.parts) lines.push({ group: 'fit', label: p.label, points: oneDecimal(p.points), max: p.max, text: p.note });

  for (const h of input.hits) {
    lines.push({
      group: 'intent',
      label: h.label,
      points: h.points,
      max: h.max,
      text: h.why ?? `Matched ${h.matched.join(', ')}.`,
      signalIds: h.signalIds,
      kind: h.kind,
    });
  }

  if (fit.hardMiss) lines.push({ group: 'combine', label: 'Hard miss', points: fit.fit, text: `Hard miss: fit capped at ${HARD_MISS_CAP}.` });
  if (input.combine.cappedAtFit) lines.push({ group: 'combine', label: 'Low fit', points: fit.fit, text: `Fit below 50: total capped at fit (${fit.fit}).` });
  const weights = profile.fitWeight + profile.intentWeight || 1;
  const fitShare = Math.round((profile.fitWeight / weights) * 100);
  lines.push({
    group: 'combine',
    label: 'Match',
    points: input.combine.total,
    text: `${fitShare}% fit (${fit.fit}) and ${100 - fitShare}% intent (${input.intent}).`,
  });
  if (input.tierText) lines.push({ group: 'combine', label: 'Tier', text: input.tierText });

  if (input.warmIntroFrom !== null && priority.warmPoints > 0) {
    lines.push({ group: 'adjust', label: `Warm intro from ${input.warmIntroFrom}`, points: priority.warmPoints, max: profile.warmIntroCap });
  }
  if (input.trust !== null && priority.trustModifier !== 0) {
    lines.push({
      group: 'adjust',
      label: `Source trust ${input.trust.value.toFixed(2)} (${input.trust.sourceName})`,
      points: priority.trustModifier,
      max: profile.trustModifierMax,
    });
  }

  return {
    priority: priority.priority,
    tier: input.tier,
    tierReason: input.tierReason,
    bestOffer: input.offer,
    lines,
    otherOffers: input.otherOffers,
    missing: fit.disqualifiedReason === null ? missingInputs(fit.parts) : [],
    computedAt: input.computedAt.toISOString(),
    profileVersion: input.profileVersion,
  };
}

/** Short phrases for what would raise the score: unknown inputs, the two biggest unmet rules, a buying role nobody fills. */
export function wouldRaise(explanation: Explanation, offer: ScoringOffer, account: ScoringAccount): string[] {
  const out = explanation.missing.map((m) => `${m.split(' unknown:')[0]} on file`);
  const met = new Set(explanation.lines.filter((l) => l.group === 'intent').map((l) => l.label));
  const unmet = offer.rules
    .filter((r) => r.enabled && !met.has(r.label))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 2);
  for (const r of unmet) out.push(`A signal for ${r.label}`);
  for (const role of offer.targetBuyingRoles) {
    if (!account.people.some((p) => p.roleKeys.includes(role))) out.push(`A ${role.replace(/_/g, ' ')} on file`);
  }
  return out;
}

export function summarySentence(explanation: Explanation): string {
  const group = (g: ExplanationLine['group']) => explanation.lines.filter((l) => l.group === g);
  const capped = explanation.lines.find((l) => l.label === 'Hard miss' || l.label === 'Low fit');
  const fitPoints = capped?.points ?? group('fit').reduce((s, l) => s + (l.points ?? 0), 0);
  const reasons = [fitPoints >= 80 ? 'strong fit' : fitPoints >= 60 ? 'decent fit' : 'weak fit'];
  const top = group('intent')[0];
  if (top) reasons.push(top.label);
  const warm = group('adjust').find((l) => l.label.startsWith('Warm intro from '));
  if (warm) reasons.push(`a warm intro from ${warm.label.slice('Warm intro from '.length)}`);
  const list = reasons.length > 1 ? `${reasons.slice(0, -1).join(', ')}, and ${reasons[reasons.length - 1]}` : reasons[0];
  return `${TIER_TITLE[explanation.tier]} for ${explanation.bestOffer.name} (priority ${explanation.priority}): ${list}.`;
}
