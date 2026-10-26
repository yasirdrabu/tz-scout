// Segment scoring. Pure functions only: the UI and the AI tasks both read from here.
// Each factor is rated 0 to 10. "Inverted" factors are rated as the raw measure (10 = very complex,
// very long, very crowded) and count as 10 minus that value toward the score.

export type FactorHalf = "market" | "fit";
export type FactorSource = "ai" | "data" | "offering";

export type FactorDef = {
  key: FactorKey;
  label: string;
  half: FactorHalf;
  defaultWeight: number;
  source: FactorSource;
  inverted: boolean;
  help: string;
};

export const FACTOR_KEYS = [
  "pain",
  "urgency",
  "audience",
  "ability_to_pay",
  "competition",
  "proof",
  "delivery_fit",
  "deal_size",
  "committee",
  "cycle",
] as const;
export type FactorKey = (typeof FACTOR_KEYS)[number];

export const FACTORS: FactorDef[] = [
  { key: "pain", label: "Pain severity", half: "market", defaultWeight: 12, source: "ai", inverted: false, help: "How much the problem costs the buyer today." },
  { key: "urgency", label: "Urgency or trigger events", half: "market", defaultWeight: 10, source: "ai", inverted: false, help: "Events that force a decision this quarter." },
  { key: "audience", label: "Reachable audience size", half: "market", defaultWeight: 10, source: "data", inverted: false, help: "LinkedIn audience size for the buyer and company filters." },
  { key: "ability_to_pay", label: "Ability to pay", half: "market", defaultWeight: 10, source: "ai", inverted: false, help: "Budget authority and revenue band." },
  { key: "competition", label: "Competition for attention", half: "market", defaultWeight: 8, source: "data", inverted: true, help: "Average cost per click. Higher means more crowded." },
  { key: "proof", label: "Proof we have", half: "fit", defaultWeight: 14, source: "data", inverted: false, help: "Matching case studies for this buyer and industry." },
  { key: "delivery_fit", label: "Delivery fit", half: "fit", defaultWeight: 12, source: "ai", inverted: false, help: "How well our team and offer fit the work." },
  { key: "deal_size", label: "Deal size vs target", half: "fit", defaultWeight: 10, source: "offering", inverted: false, help: "Likely first deal compared with the offering's target deal size." },
  { key: "committee", label: "Buying committee complexity", half: "fit", defaultWeight: 7, source: "ai", inverted: true, help: "How many people must say yes." },
  { key: "cycle", label: "Sales cycle length", half: "fit", defaultWeight: 7, source: "ai", inverted: true, help: "Expected time from first call to signature." },
];

export const FACTOR_BY_KEY: Record<FactorKey, FactorDef> = Object.fromEntries(FACTORS.map((f) => [f.key, f])) as Record<FactorKey, FactorDef>;

export type Weights = Record<FactorKey, number>;
export const DEFAULT_WEIGHTS: Weights = Object.fromEntries(FACTORS.map((f) => [f.key, f.defaultWeight])) as Weights;

export function normalizeWeights(input: Partial<Record<string, number>> | null | undefined): Weights {
  const w = { ...DEFAULT_WEIGHTS };
  for (const k of FACTOR_KEYS) {
    const v = input?.[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) w[k] = v;
  }
  return w;
}

export type FactorInput = { factor: string; value: number; overrideValue?: number | null };

const clamp10 = (n: number) => Math.max(0, Math.min(10, n));

/** The value actually used: the override if one exists, else the proposed value. */
export function effectiveValue(f: FactorInput): number {
  return clamp10(f.overrideValue ?? f.value);
}

/** The 0 to 10 value oriented so that higher is always better. */
export function orientedValue(key: FactorKey, raw: number): number {
  return FACTOR_BY_KEY[key].inverted ? 10 - clamp10(raw) : clamp10(raw);
}

export type ScoreBreakdown = {
  total: number; // 0..100
  market: number;
  fit: number;
  marketMax: number;
  fitMax: number;
  factors: { key: FactorKey; label: string; half: FactorHalf; raw: number; oriented: number; weight: number; points: number; overridden: boolean }[];
};

/**
 * Score = sum(oriented / 10 x weight), scaled so the weights always total 100.
 * Missing factors count as 0.
 */
export function scoreSegment(factors: FactorInput[], weightsIn?: Partial<Weights>): ScoreBreakdown {
  const weights = normalizeWeights(weightsIn);
  const totalWeight = FACTOR_KEYS.reduce((s, k) => s + weights[k], 0) || 1;
  const scale = 100 / totalWeight;
  const byKey = new Map(factors.map((f) => [f.factor, f]));
  const rows = FACTORS.map((def) => {
    const f = byKey.get(def.key);
    const raw = f ? effectiveValue(f) : 0;
    const oriented = f ? orientedValue(def.key, raw) : 0;
    const weight = weights[def.key] * scale;
    return {
      key: def.key,
      label: def.label,
      half: def.half,
      raw,
      oriented,
      weight,
      points: (oriented / 10) * weight,
      overridden: f?.overrideValue != null,
    };
  });
  const sum = (half: FactorHalf, field: "points" | "weight") => rows.filter((r) => r.half === half).reduce((s, r) => s + r[field], 0);
  const market = sum("market", "points");
  const fit = sum("fit", "points");
  return {
    total: round1(market + fit),
    market: round1(market),
    fit: round1(fit),
    marketMax: round1(sum("market", "weight")),
    fitMax: round1(sum("fit", "weight")),
    factors: rows,
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

// ---------- Data factors: turning enrichment numbers into 0 to 10 ratings ----------

/** LinkedIn audience size to 0..10 on a log scale: about 2,000 people is 0, 1,000,000 or more is 10. */
export function audienceRating(size: number | null | undefined): number {
  if (!size || size <= 0) return 0;
  const lo = Math.log10(2000);
  const hi = Math.log10(1_000_000);
  return round1(clamp10(((Math.log10(size) - lo) / (hi - lo)) * 10));
}

/** Cost per click to a 0..10 crowding rating: $1 or less is 1, $16 or more is 10. Inverted when scored. */
export function competitionRating(cpcCents: number | null | undefined): number {
  if (cpcCents == null) return 5;
  const dollars = cpcCents / 100;
  return round1(clamp10(1 + ((dollars - 1) / 15) * 9));
}

/** Matching case studies to a proof rating. */
export function proofRating(count: number): number {
  return [0, 5, 7, 9][count] ?? 10;
}

/** Likely first deal vs the offering's target deal size. At or above target is 10. */
export function dealSizeRating(expectedCents: number | null | undefined, targetCents: number | null | undefined): number {
  if (!expectedCents || !targetCents) return 5;
  return round1(clamp10((expectedCents / targetCents) * 10));
}

/** Rank segments by total score, highest first. Ties keep name order. */
export function rankSegments<T extends { name: string; score: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}
