/** Learned source trust: how an arrival's outcome scores and how a source's trust follows from its arrivals. Pure: no database. */

export const TRUST_PRIOR = 0.6;
export const PRIOR_WEIGHT = 10;
export const HALF_LIFE_DAYS = 180;
export const CONFLICT_DROP = 0.01;
/** A change of this much publishes `intake.source.trust_changed`. */
export const PUBLISH_STEP = 0.02;
/** An arrival with no decision is judged (as 0.10) once it is this old. */
export const JUDGE_AFTER_DAYS = 30;
/** Under this many judged arrivals the UI says "Not enough data". */
export const MIN_SAMPLE = 10;
/** Seller decline reasons that zero an arrival. */
export const ZERO_SELLER_REASONS = ['not_a_fit', 'bad_data'];

/** A flow stage's quality by its trigger (stages are configurable, so keys do not say). */
export const TRIGGER_QUALITY: Record<string, number> = {
  source_creates: 0.1,
  reviewer_sets_tier: 0.3,
  ae_accepts: 0.5,
  reply_or_meeting: 0.7,
  meeting_booked: 0.7,
  deal_created: 0.9,
  deal_reaches_stage: 0.9,
  deal_closed_won: 1,
};

const FLOOR = 0.1;
const DAY_MS = 86_400_000;

/** The part of a pipeline stage that trust needs. Defined here because intake must not import from routing. */
export type TrustStage = { key: string; kind: 'flow' | 'exit'; position: number; trigger: string };

/** Quality per flow stage key. A trigger with no quality (`by_hand`) takes the best of the flow stages at or before it. */
export function stageQualities(stages: TrustStage[]): Map<string, number> {
  const out = new Map<string, number>();
  let best = FLOOR;
  for (const s of stages.filter((x) => x.kind === 'flow').sort((a, b) => a.position - b.position)) {
    const own = TRIGGER_QUALITY[s.trigger];
    best = Math.max(best, own ?? 0);
    out.set(s.key, own ?? best);
  }
  return out;
}

type ArrivalInput = {
  resolvedAt: Date;
  /** The account's stage entries, any time. */
  entries: { stage: string; at: Date }[];
  /** When the account was zeroed by a decline (review or seller), already filtered by the caller. */
  declines: Date[];
  stages: TrustStage[];
  qualities: Map<string, number>;
  now: Date;
};

/** What an arrival scores, or null when it is not judged yet. A decline zeroes it unless a flow stage was entered after. */
export function arrivalQuality(a: ArrivalInput): number | null {
  const byKey = new Map(a.stages.map((s) => [s.key, s]));
  let best = FLOOR;
  let exited = false;
  let lastFlow = -Infinity;
  const declines = a.declines.map((d) => d.getTime());
  for (const e of a.entries) {
    const stage = byKey.get(e.stage);
    if (!stage) continue;
    const at = e.at.getTime();
    if (stage.kind === 'flow') {
      best = Math.max(best, a.qualities.get(stage.key) ?? 0);
      lastFlow = Math.max(lastFlow, at);
    } else {
      // Any exit decides the arrival; a reviewer rejection also zeroes it.
      exited = true;
      if (stage.trigger === 'reviewer_rejects') declines.push(at);
    }
  }
  if (declines.length > 0 && lastFlow <= Math.max(...declines)) return 0;
  if (best >= 0.3 || exited) return best;
  return (a.now.getTime() - a.resolvedAt.getTime()) / DAY_MS >= JUDGE_AFTER_DAYS ? FLOOR : null;
}

/** 1 for a fresh arrival, halving every `HALF_LIFE_DAYS`. */
export function decayWeight(ageDays: number): number {
  return 0.5 ** (ageDays / HALF_LIFE_DAYS);
}

/** A source's trust: the prior plus its judged arrivals weighted by age, less a step per conflict lost. 4 decimals. */
export function trustOf(judged: { quality: number; ageDays: number }[], conflictsLost: number): number {
  let sum = 0;
  let weights = 0;
  for (const j of judged) {
    const w = decayWeight(j.ageDays);
    sum += j.quality * w;
    weights += w;
  }
  const trust = (PRIOR_WEIGHT * TRUST_PRIOR + sum) / (PRIOR_WEIGHT + weights);
  return Math.round(Math.max(0, trust - CONFLICT_DROP * conflictsLost) * 1e4) / 1e4;
}

export type TrustBand = 'high' | 'mid' | 'low' | 'not_enough';

export function trustBand(trust: number, sample: number): TrustBand {
  if (sample < MIN_SAMPLE) return 'not_enough';
  return trust >= 0.8 ? 'high' : trust >= 0.6 ? 'mid' : 'low';
}
