// Funnel math. The only place cost-per-stage, profit and budget are computed. Pure and unit tested.
// Money is in cents (fractional cents are allowed mid-calculation; round only for display).

export const STAGES = [
  { key: "impressions", label: "Impressions", rateKey: "cpmCents", rateLabel: "Cost per 1,000 impressions" },
  { key: "clicks", label: "Clicks", rateKey: "ctr", rateLabel: "Clickthrough rate" },
  { key: "formFills", label: "Form fills", rateKey: "formRate", rateLabel: "Form conversion rate" },
  { key: "validatedLeads", label: "Validated leads", rateKey: "validationRate", rateLabel: "Validation pass rate" },
  { key: "discoveryHeld", label: "Discovery calls held", rateKey: "discoveryShowRate", rateLabel: "Show-up rate" },
  { key: "qualified", label: "Sales-qualified", rateKey: "qualificationRate", rateLabel: "Qualification rate" },
  { key: "salesHeld", label: "Sales calls held", rateKey: "salesShowRate", rateLabel: "Show-up rate" },
  { key: "won", label: "Won", rateKey: "closeRate", rateLabel: "Close rate" },
] as const;

export type StageKey = (typeof STAGES)[number]["key"];
export type RateKey = Exclude<(typeof STAGES)[number]["rateKey"], "cpmCents">;
export const RATE_KEYS: RateKey[] = ["ctr", "formRate", "validationRate", "discoveryShowRate", "qualificationRate", "salesShowRate", "closeRate"];

export type FunnelRates = { cpmCents: number } & Record<RateKey, number>;

export type FunnelInputs = FunnelRates & {
  dealValueCents: number;
  margin: number; // 0.55 = 55%
  expansion?: { rate: number; valueCents: number; margin: number } | null;
  targetWonPerMonth?: number | null;
  budgetCents?: number | null;
};

export type StageResult = {
  key: StageKey;
  label: string;
  rate: number; // CPM in cents for stage 1, decimal rate otherwise
  costPerUnitCents: number | null; // null when an upstream rate is zero
  volumeFromBudget: number | null;
};

export type FunnelResult = {
  stages: StageResult[];
  costPerClickCents: number | null;
  costPerWonCents: number | null;
  grossProfitPerDealCents: number;
  expansionProfitCents: number;
  profitPerClientCents: number | null;
  returnMultiple: number | null;
  budgetNeededCents: number | null;
  clientsFromBudget: number | null;
};

const finite = (n: number) => (Number.isFinite(n) ? n : null);

export function computeFunnel(input: FunnelInputs): FunnelResult {
  const stages: StageResult[] = [];
  // Stage 1: cost per single impression. Shown to users as cost per 1,000.
  let cost: number | null = input.cpmCents > 0 ? input.cpmCents / 1000 : null;
  stages.push({ key: "impressions", label: STAGES[0].label, rate: input.cpmCents, costPerUnitCents: cost, volumeFromBudget: null });

  for (const def of STAGES.slice(1)) {
    const rate = input[def.rateKey as RateKey];
    cost = cost != null && rate > 0 ? cost / rate : null;
    stages.push({ key: def.key, label: def.label, rate, costPerUnitCents: cost != null ? finite(cost) : null, volumeFromBudget: null });
  }

  // cost per click = CPM / 1000 / CTR
  const costPerClickCents = stages[1]!.costPerUnitCents;
  const costPerWonCents = stages[7]!.costPerUnitCents;

  const grossProfitPerDealCents = input.dealValueCents * input.margin;
  const exp = input.expansion;
  const expansionProfitCents = exp ? exp.rate * exp.valueCents * exp.margin : 0;
  const valuePerClient = grossProfitPerDealCents + expansionProfitCents;

  const profitPerClientCents = costPerWonCents != null ? valuePerClient - costPerWonCents : null;
  const returnMultiple = costPerWonCents != null && costPerWonCents > 0 ? valuePerClient / costPerWonCents : null;
  const budgetNeededCents = costPerWonCents != null && input.targetWonPerMonth != null ? input.targetWonPerMonth * costPerWonCents : null;
  const clientsFromBudget = costPerWonCents != null && costPerWonCents > 0 && input.budgetCents != null ? input.budgetCents / costPerWonCents : null;

  if (input.budgetCents != null) {
    for (const s of stages) s.volumeFromBudget = s.costPerUnitCents ? input.budgetCents / s.costPerUnitCents : null;
  }

  return {
    stages,
    costPerClickCents,
    costPerWonCents,
    grossProfitPerDealCents,
    expansionProfitCents,
    profitPerClientCents,
    returnMultiple,
    budgetNeededCents,
    clientsFromBudget,
  };
}

/** Merge partial history over defaults: any stage with history wins, the rest fall back. */
export function mergeRates(defaults: FunnelRates, history: Partial<FunnelRates>): { rates: FunnelRates; fromHistory: Partial<Record<keyof FunnelRates, boolean>> } {
  const rates = { ...defaults };
  const fromHistory: Partial<Record<keyof FunnelRates, boolean>> = {};
  for (const k of Object.keys(defaults) as (keyof FunnelRates)[]) {
    const v = history[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      rates[k] = v;
      fromHistory[k] = true;
    }
  }
  return { rates, fromHistory };
}

/** Safe ratio for building rates from counts. Returns undefined when the sample is too small. */
export function ratio(numerator: number, denominator: number, minDenominator = 1): number | undefined {
  if (denominator < minDenominator || denominator <= 0) return undefined;
  return numerator / denominator;
}
