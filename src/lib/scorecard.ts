// Weekly scorecard: metric definitions, derived values and colour rules. Pure and unit tested.
// Weeks store raw counts only; every rate and cost here is derived from those counts.

export const RAW_KEYS = [
  "spendCents",
  "impressions",
  "clicks",
  "formFills",
  "validatedLeads",
  "discoveryBooked",
  "discoveryHeld",
  "qualified",
  "salesBooked",
  "salesHeld",
  "won",
  "revenueCents",
] as const;
export type RawKey = (typeof RAW_KEYS)[number];
export type RawCounts = Record<RawKey, number>;

export const emptyCounts = (): RawCounts => Object.fromEntries(RAW_KEYS.map((k) => [k, 0])) as RawCounts;

export type Format = "money" | "count" | "rate" | "moneyPrecise";
/** higher: more is better. lower: less is better. band: close to target is best (spend). */
export type Direction = "higher" | "lower" | "band";

export type MetricDef = {
  key: string;
  label: string;
  group: "Marketing" | "Sales";
  format: Format;
  direction: Direction;
  /** Returns the value and the sample size used to judge whether it is meaningful. */
  compute: (c: RawCounts) => { value: number | null; sample: number };
};

const div = (a: number, b: number) => (b > 0 ? a / b : null);
const cost = (c: RawCounts, n: number) => ({ value: div(c.spendCents, n), sample: n });
const rate = (a: number, b: number) => ({ value: div(a, b), sample: b });
const count = (n: number) => ({ value: n, sample: n });

export const METRICS: MetricDef[] = [
  { key: "spend", label: "Spend", group: "Marketing", format: "money", direction: "band", compute: (c) => ({ value: c.spendCents, sample: 1 }) },
  { key: "impressions", label: "Impressions", group: "Marketing", format: "count", direction: "higher", compute: (c) => count(c.impressions) },
  { key: "cpm", label: "Cost per 1,000 impressions", group: "Marketing", format: "moneyPrecise", direction: "lower", compute: (c) => ({ value: c.impressions > 0 ? (c.spendCents / c.impressions) * 1000 : null, sample: c.impressions }) },
  { key: "clicks", label: "Clicks", group: "Marketing", format: "count", direction: "higher", compute: (c) => count(c.clicks) },
  { key: "ctr", label: "Clickthrough rate", group: "Marketing", format: "rate", direction: "higher", compute: (c) => rate(c.clicks, c.impressions) },
  { key: "cpc", label: "Cost per click", group: "Marketing", format: "moneyPrecise", direction: "lower", compute: (c) => cost(c, c.clicks) },
  { key: "formFills", label: "Form fills", group: "Marketing", format: "count", direction: "higher", compute: (c) => count(c.formFills) },
  { key: "formRate", label: "Form conversion rate", group: "Marketing", format: "rate", direction: "higher", compute: (c) => rate(c.formFills, c.clicks) },
  { key: "costPerFormFill", label: "Cost per form fill", group: "Marketing", format: "money", direction: "lower", compute: (c) => cost(c, c.formFills) },
  { key: "validatedLeads", label: "Validated leads", group: "Marketing", format: "count", direction: "higher", compute: (c) => count(c.validatedLeads) },
  { key: "validationRate", label: "Validation rate", group: "Marketing", format: "rate", direction: "higher", compute: (c) => rate(c.validatedLeads, c.formFills) },
  { key: "costPerValidated", label: "Cost per validated lead", group: "Marketing", format: "money", direction: "lower", compute: (c) => cost(c, c.validatedLeads) },
  { key: "discoveryHeld", label: "Discovery calls held", group: "Sales", format: "count", direction: "higher", compute: (c) => count(c.discoveryHeld) },
  { key: "discoveryShowRate", label: "Discovery show-up rate", group: "Sales", format: "rate", direction: "higher", compute: (c) => rate(c.discoveryHeld, c.discoveryBooked) },
  { key: "costPerDiscovery", label: "Cost per discovery call", group: "Sales", format: "money", direction: "lower", compute: (c) => cost(c, c.discoveryHeld) },
  { key: "qualified", label: "Sales-qualified", group: "Sales", format: "count", direction: "higher", compute: (c) => count(c.qualified) },
  { key: "qualificationRate", label: "Qualification rate", group: "Sales", format: "rate", direction: "higher", compute: (c) => rate(c.qualified, c.discoveryHeld) },
  { key: "costPerQualified", label: "Cost per qualified lead", group: "Sales", format: "money", direction: "lower", compute: (c) => cost(c, c.qualified) },
  { key: "salesHeld", label: "Sales calls held", group: "Sales", format: "count", direction: "higher", compute: (c) => count(c.salesHeld) },
  { key: "salesShowRate", label: "Sales show-up rate", group: "Sales", format: "rate", direction: "higher", compute: (c) => rate(c.salesHeld, c.salesBooked) },
  { key: "costPerSalesCall", label: "Cost per sales call", group: "Sales", format: "money", direction: "lower", compute: (c) => cost(c, c.salesHeld) },
  { key: "won", label: "Won", group: "Sales", format: "count", direction: "higher", compute: (c) => count(c.won) },
  { key: "closeRate", label: "Close rate", group: "Sales", format: "rate", direction: "higher", compute: (c) => rate(c.won, c.salesHeld) },
  { key: "costPerWon", label: "Cost per won client", group: "Sales", format: "money", direction: "lower", compute: (c) => cost(c, c.won) },
  { key: "revenue", label: "Revenue closed", group: "Sales", format: "money", direction: "higher", compute: (c) => ({ value: c.revenueCents, sample: c.won }) },
];

export const METRIC_BY_KEY = Object.fromEntries(METRICS.map((m) => [m.key, m])) as Record<string, MetricDef>;

export type Colour = "green" | "amber" | "red" | "grey" | "none";

/** Amber band: within 15% worse than target. Spend uses a 5% green band and 15% amber band either side. */
export const AMBER_BAND = 0.15;

export function colourFor(
  def: Pick<MetricDef, "direction">,
  value: number | null,
  target: number | null | undefined,
  sample: number,
  minSample = 0,
): Colour {
  if (target == null) return "none";
  if (value == null || sample < minSample) return "grey";
  if (def.direction === "higher") {
    if (value >= target) return "green";
    if (value >= target * (1 - AMBER_BAND)) return "amber";
    return "red";
  }
  if (def.direction === "lower") {
    if (value <= target) return "green";
    if (value <= target * (1 + AMBER_BAND)) return "amber";
    return "red";
  }
  const off = target === 0 ? (value === 0 ? 0 : Infinity) : Math.abs(value - target) / target;
  if (off <= 0.05) return "green";
  if (off <= AMBER_BAND) return "amber";
  return "red";
}

export function sumCounts(weeks: RawCounts[]): RawCounts {
  const out = emptyCounts();
  for (const w of weeks) for (const k of RAW_KEYS) out[k] += w[k] ?? 0;
  return out;
}

/**
 * Rolling average for the last n weeks. Counts are averaged per week; rates and costs are computed
 * from the summed counts (a ratio of totals, not an average of weekly ratios).
 */
export function rollingValue(def: MetricDef, weeks: RawCounts[]): { value: number | null; sample: number } {
  if (weeks.length === 0) return { value: null, sample: 0 };
  const total = sumCounts(weeks);
  const r = def.compute(total);
  const perWeek = def.format === "count" || def.key === "spend" || def.key === "revenue";
  return perWeek && r.value != null ? { value: r.value / weeks.length, sample: r.sample / weeks.length } : r;
}

export type ScorecardConfig = Record<string, { target?: number | null; minSample?: number }>;

export type ScorecardCell = { value: number | null; sample: number; colour: Colour };
export type ScorecardRow = { def: MetricDef; target: number | null; weeks: ScorecardCell[]; rolling: ScorecardCell };

export function buildScorecard(weeks: RawCounts[], config: ScorecardConfig, rollingWindow = 4): ScorecardRow[] {
  const recent = weeks.slice(-rollingWindow);
  return METRICS.map((def) => {
    const cfg = config[def.key] ?? {};
    const target = cfg.target ?? null;
    const min = cfg.minSample ?? 0;
    const cells = weeks.map((w) => {
      const r = def.compute(w);
      return { ...r, colour: colourFor(def, r.value, target, r.sample, min) };
    });
    const roll = rollingValue(def, recent);
    return { def, target, weeks: cells, rolling: { ...roll, colour: colourFor(def, roll.value, target, roll.sample, min) } };
  });
}

/** Monday 00:00 UTC of the week containing d. */
export function weekStart(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (x.getUTCDay() + 6) % 7; // Monday = 0
  x.setUTCDate(x.getUTCDate() - dow);
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}
