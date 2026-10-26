// Labels and display-unit conversions for the funnel model. No funnel math here: every cost, profit and
// volume comes from computeFunnel in src/lib/funnel.ts.

import type { FunnelInputs, FunnelRates, StageKey, StageResult } from "@/lib/funnel";
import { money, pct } from "@/lib/format";

export type RateField = keyof FunnelRates;

export const COST_LABEL: Record<StageKey, string> = {
  impressions: "Cost per 1,000 impressions",
  clicks: "Cost per click",
  formFills: "Cost per form fill",
  validatedLeads: "Cost per validated lead",
  discoveryHeld: "Cost per discovery call",
  qualified: "Cost per qualified lead",
  salesHeld: "Cost per sales call",
  won: "Cost per won client",
};

export const VOLUME_LABEL: Record<StageKey, string> = {
  impressions: "impressions",
  clicks: "clicks",
  formFills: "form fills",
  validatedLeads: "validated leads",
  discoveryHeld: "discovery calls held",
  qualified: "sales-qualified leads",
  salesHeld: "sales calls held",
  won: "won clients",
};

/** What the history sample for each rate counts. */
export const SAMPLE_LABEL: Record<RateField, string> = {
  cpmCents: "impressions",
  ctr: "impressions",
  formRate: "clicks",
  validationRate: "form fills",
  discoveryShowRate: "discovery calls booked",
  qualificationRate: "discovery calls held",
  salesShowRate: "sales calls booked",
  closeRate: "sales calls held",
};

/** Slider range in display units (dollars for stage 1, percent for the rest). */
export const SLIDER: Record<RateField, { max: number; step: number; digits: number }> = {
  cpmCents: { max: 100, step: 0.5, digits: 2 },
  ctr: { max: 3, step: 0.01, digits: 2 },
  formRate: { max: 15, step: 0.05, digits: 2 },
  validationRate: { max: 100, step: 1, digits: 1 },
  discoveryShowRate: { max: 100, step: 1, digits: 1 },
  qualificationRate: { max: 100, step: 1, digits: 1 },
  salesShowRate: { max: 100, step: 1, digits: 1 },
  closeRate: { max: 100, step: 1, digits: 1 },
};

/** Stored value (cents or decimal) to what a person types (dollars or percent). */
export const toDisplay = (k: RateField, v: number) => (k === "cpmCents" ? v / 100 : v * 100);
export const fromDisplay = (k: RateField, d: number) => (k === "cpmCents" ? d * 100 : d / 100);

export function fmtRate(k: RateField, v: number | null | undefined, currency: string) {
  if (v == null) return "n/a";
  return k === "cpmCents" ? money(v, currency, { precise: true }) : pct(v, SLIDER[k].digits);
}

/** Cost per unit as shown to people: stage 1 per 1,000 impressions (the rate itself), others per unit. */
export function shownCost(s: StageResult): number | null {
  if (s.costPerUnitCents == null) return null;
  return s.key === "impressions" ? s.rate : s.costPerUnitCents;
}

/** Rows for the scenario comparison table. */
export const INPUT_ROWS: { label: string; get: (i: FunnelInputs) => number | null | undefined; fmt: "money" | "rate" | "moneyPrecise" | "count" }[] = [
  { label: "Cost per 1,000 impressions", get: (i) => i.cpmCents, fmt: "moneyPrecise" },
  { label: "Clickthrough rate", get: (i) => i.ctr, fmt: "rate" },
  { label: "Form conversion rate", get: (i) => i.formRate, fmt: "rate" },
  { label: "Validation pass rate", get: (i) => i.validationRate, fmt: "rate" },
  { label: "Discovery show-up rate", get: (i) => i.discoveryShowRate, fmt: "rate" },
  { label: "Qualification rate", get: (i) => i.qualificationRate, fmt: "rate" },
  { label: "Sales call show-up rate", get: (i) => i.salesShowRate, fmt: "rate" },
  { label: "Close rate", get: (i) => i.closeRate, fmt: "rate" },
  { label: "Deal value", get: (i) => i.dealValueCents, fmt: "money" },
  { label: "Gross margin", get: (i) => i.margin, fmt: "rate" },
  { label: "Clients who buy more", get: (i) => i.expansion?.rate ?? null, fmt: "rate" },
  { label: "Follow-on value", get: (i) => i.expansion?.valueCents ?? null, fmt: "money" },
  { label: "Won clients wanted per month", get: (i) => i.targetWonPerMonth ?? null, fmt: "count" },
  { label: "Monthly budget", get: (i) => i.budgetCents ?? null, fmt: "money" },
];
