// The score explanation: every point of a priority as a line a person can check (SCO-E4).

import type { RuleHit, ScoreCause, ScoringAccount, ScoringOffer, ScoringProfile, ScoringSignal, ScoringSignalKind, Tier, TierReason } from '../contracts/types';
import type { FitResult } from './fit';
import { CURRENT_STATE, recency, signalDate } from './intent';

const HARD_MISS_CAP = 45;
const DAY_MS = 86_400_000;
export const NO_OFFER_TEXT = 'No approved offer to match against.';
const TIER_TITLE: Record<Tier, string> = { not_fit: 'Not a fit', watch: 'Watch', good_fit: 'Good fit', act_now: 'Act now' };

export type ExplanationLine = {
  group: 'fit' | 'intent' | 'combine' | 'adjust';
  label: string;
  points?: number;
  max?: number;
  text?: string;
  /** Intent lines only. */
  ruleId?: string;
  signalIds?: string[];
  kind?: ScoringSignalKind;
  /** Intent lines only: days since the strongest signal, when it has a date that counts. */
  ageDays?: number;
};

export type Explanation = {
  priority: number;
  tier: Tier;
  tierReason: TierReason;
  /** Null when the tenant has no approved offer to match against. */
  bestOffer: { id: string; name: string } | null;
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
  /** The signals the hits matched, for dates and recency. */
  signals: ScoringSignal[];
  now: Date;
  combine: { total: number; cappedAtFit: boolean };
  profile: Pick<ScoringProfile, 'fitWeight' | 'intentWeight' | 'warmIntroCap' | 'trustModifierMax' | 'halfLifeDays' | 'maxSignalAgeDays'>;
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
const ago = (days: number) => (days === 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`);
const dateText = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** Unknown parts earned a middle share, so the most they can move is the larger side of it. The name comes from the note ("Headcount unknown."). */
export function missingInputs(parts: FitResult['parts']): string[] {
  return parts
    .filter((p) => p.unknown)
    .map((p) => `${p.note.replace(/ unknown\.$/, '')} unknown: adding it could change fit by up to ${Math.round(Math.max(p.points, p.max - p.points))} points.`);
}

/** "News from Sep 25, 2026 (30 days ago, counts 63%)." from the hit's strongest signal. Current-state types say "on file"; hits with no signal say what matched. */
function intentText(h: RuleHit, input: ExplanationInput): { text: string; ageDays?: number } {
  const s = input.signals.find((x) => x.id === h.signalIds[0]);
  if (!s) return { text: h.why ?? `Matched ${h.matched.join(', ')}.` };
  const what = (s.type ?? 'signal').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  if (s.type && CURRENT_STATE.has(s.type)) return { text: `${what} on file.` };
  const at = signalDate(s);
  const ageDays = Math.max(0, Math.round((input.now.getTime() - at.getTime()) / DAY_MS));
  const counts = Math.round(recency(s.type ?? '', at, input.now, input.profile) * 100);
  return { text: `${what} from ${dateText(at)} (${ago(ageDays)}, counts ${counts}%).`, ageDays };
}

export function buildExplanation(input: ExplanationInput): Explanation {
  const { fit, profile, priority } = input;
  const lines: ExplanationLine[] = [];

  // Fit lines sum uncapped; the Hard miss line below corrects them when the cap applies.
  // A disqualified account gets the one Excluded line instead of five parts repeating the reason.
  if (fit.disqualifiedReason !== null) lines.push({ group: 'fit', label: 'Excluded', points: 0, max: 0, text: fit.disqualifiedReason });
  else for (const p of fit.parts) lines.push({ group: 'fit', label: p.label, points: oneDecimal(p.points), max: p.max, text: p.note });

  for (const h of input.hits) {
    const { text, ageDays } = intentText(h, input);
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

  const rawFit = fit.parts.reduce((sum, p) => sum + p.points, 0);
  if (fit.hardMiss && rawFit > HARD_MISS_CAP) lines.push({ group: 'combine', label: 'Hard miss', points: fit.fit, text: `Hard miss: fit capped at ${HARD_MISS_CAP}.` });
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

  if (priority.warmPoints > 0) {
    lines.push({
      group: 'adjust',
      label: input.warmIntroFrom === null ? 'Warm intro' : `Warm intro from ${input.warmIntroFrom}`,
      points: priority.warmPoints,
      max: profile.warmIntroCap,
    });
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
  const met = new Set(explanation.lines.filter((l) => l.group === 'intent').map((l) => l.ruleId));
  const unmet = offer.rules
    .filter((r) => r.enabled && !met.has(r.id))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 2);
  for (const r of unmet) out.push(`A signal for ${r.label}`);
  for (const role of offer.targetBuyingRoles) {
    if (!account.people.some((p) => p.roleKeys.includes(role))) out.push(`A ${role.replace(/_/g, ' ')} on file`);
  }
  return out;
}

export function summarySentence(explanation: Explanation): string {
  if (!explanation.bestOffer) return NO_OFFER_TEXT;
  const group = (g: ExplanationLine['group']) => explanation.lines.filter((l) => l.group === g);
  const capped = explanation.lines.find((l) => l.label === 'Hard miss' || l.label === 'Low fit');
  const fitPoints = capped?.points ?? group('fit').reduce((s, l) => s + (l.points ?? 0), 0);
  const reasons = [fitPoints >= 80 ? 'strong fit' : fitPoints >= 60 ? 'decent fit' : 'weak fit'];
  const top = group('intent')[0];
  if (top) reasons.push(top.ageDays === undefined ? top.label : `${top.label} ${ago(top.ageDays)}`);
  const warm = group('adjust').find((l) => l.label.startsWith('Warm intro'));
  if (warm) reasons.push(warm.label === 'Warm intro' ? 'a warm intro' : `a warm intro from ${warm.label.slice('Warm intro from '.length)}`);
  const list = reasons.length > 1 ? `${reasons.slice(0, -1).join(', ')}, and ${reasons[reasons.length - 1]}` : reasons[0];
  return `${TIER_TITLE[explanation.tier]} for ${explanation.bestOffer.name} (priority ${explanation.priority}): ${list}.`;
}

const CAUSE_WORDS: Record<ScoreCause, string> = {
  new_signal: 'A new signal arrived.',
  new_fact: 'New details arrived for the account.',
  rules_changed: 'The scoring settings changed.',
  offer_changed: 'An offer changed.',
  trust_changed: 'Source trust changed.',
  warm_intro: 'A warm intro was recorded.',
  manual_rescore: 'A rescore was requested.',
  ageing: 'Signals got older.',
};

/** A score change's cause as a sentence for the history list (SCO-E4-S3-AC1). */
export const causeInWords = (cause: string): string => CAUSE_WORDS[cause as ScoreCause] ?? 'The score was recomputed.';
