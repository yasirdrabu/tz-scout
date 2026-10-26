import { describe, expect, it } from "vitest";
import { computeFunnel, mergeRates, ratio, type FunnelInputs } from "@/lib/funnel";

// Hand-calculated case. CPM $30, clickthrough 1%, form 5%, validation 50%, discovery show-up 80%,
// qualification 50%, sales show-up 80%, close 25%. Deal $10,000 at 60% margin.
//   cost per impression = 3000 / 1000           = 3 cents
//   cost per click      = 3 / 0.01              = 300 cents  ($3)
//   cost per form fill  = 300 / 0.05            = 6,000      ($60)
//   per validated lead  = 6,000 / 0.5           = 12,000     ($120)
//   per discovery call  = 12,000 / 0.8          = 15,000     ($150)
//   per qualified       = 15,000 / 0.5          = 30,000     ($300)
//   per sales call      = 30,000 / 0.8          = 37,500     ($375)
//   per won client      = 37,500 / 0.25         = 150,000    ($1,500)
//   profit per client   = 1,000,000 x 0.6 - 150,000 = 450,000 ($4,500)
//   return              = 600,000 / 150,000     = 4x
const base: FunnelInputs = {
  cpmCents: 3000,
  ctr: 0.01,
  formRate: 0.05,
  validationRate: 0.5,
  discoveryShowRate: 0.8,
  qualificationRate: 0.5,
  salesShowRate: 0.8,
  closeRate: 0.25,
  dealValueCents: 1_000_000,
  margin: 0.6,
  targetWonPerMonth: 3,
  budgetCents: 1_500_000,
};

describe("computeFunnel", () => {
  const r = computeFunnel(base);

  it("computes cost at every stage", () => {
    expect(r.stages.map((s) => s.costPerUnitCents)).toEqual([3, 300, 6000, 12000, 15000, 30000, 37500, 150000]);
  });

  it("cost per click = CPM / 1000 / CTR", () => {
    expect(r.costPerClickCents).toBe(300);
  });

  it("cost per won client is the last stage", () => {
    expect(r.costPerWonCents).toBe(150000);
  });

  it("profit and return", () => {
    expect(r.grossProfitPerDealCents).toBe(600000);
    expect(r.profitPerClientCents).toBe(450000);
    expect(r.returnMultiple).toBe(4);
  });

  it("budget needed and clients from budget", () => {
    expect(r.budgetNeededCents).toBe(450000); // 3 x 150,000
    expect(r.clientsFromBudget).toBe(10); // 1,500,000 / 150,000
  });

  it("volumes the budget buys at each stage", () => {
    expect(r.stages[0]!.volumeFromBudget).toBe(500000); // impressions
    expect(r.stages[1]!.volumeFromBudget).toBe(5000); // clicks
    expect(r.stages[7]!.volumeFromBudget).toBe(10); // won
  });

  it("adds expansion to profit and return", () => {
    // expansion: 40% x $35,000 x 50% = $7,000 (700,000 cents)
    const e = computeFunnel({ ...base, expansion: { rate: 0.4, valueCents: 3_500_000, margin: 0.5 } });
    expect(e.expansionProfitCents).toBe(700000);
    expect(e.profitPerClientCents).toBe(1_150_000);
    expect(e.returnMultiple).toBeCloseTo(1_300_000 / 150_000, 10);
  });

  it("returns nulls instead of infinity when a rate is zero", () => {
    const z = computeFunnel({ ...base, closeRate: 0 });
    expect(z.costPerWonCents).toBeNull();
    expect(z.profitPerClientCents).toBeNull();
    expect(z.returnMultiple).toBeNull();
    expect(z.budgetNeededCents).toBeNull();
    expect(z.stages[6]!.costPerUnitCents).toBe(37500); // upstream unaffected
  });

  it("a zero clickthrough nulls everything downstream", () => {
    const z = computeFunnel({ ...base, ctr: 0 });
    expect(z.costPerClickCents).toBeNull();
    expect(z.stages.slice(1).every((s) => s.costPerUnitCents === null)).toBe(true);
  });

  it("improving any rate lowers cost per won client proportionally", () => {
    const better = computeFunnel({ ...base, discoveryShowRate: 0.4 * 2 * 1.25 }); // 0.8 -> 1.0
    expect(better.costPerWonCents).toBeCloseTo(150000 * 0.8, 6);
  });
});

describe("mergeRates", () => {
  it("history overrides defaults only where present and positive", () => {
    const defaults = { cpmCents: 3000, ctr: 0.01, formRate: 0.05, validationRate: 0.5, discoveryShowRate: 0.7, qualificationRate: 0.45, salesShowRate: 0.85, closeRate: 0.3 };
    const { rates, fromHistory } = mergeRates(defaults, { ctr: 0.013, closeRate: 0, discoveryShowRate: undefined });
    expect(rates.ctr).toBe(0.013);
    expect(rates.closeRate).toBe(0.3);
    expect(rates.discoveryShowRate).toBe(0.7);
    expect(fromHistory).toEqual({ ctr: true });
  });
});

describe("ratio", () => {
  it("needs a minimum sample", () => {
    expect(ratio(3, 4, 5)).toBeUndefined();
    expect(ratio(3, 6, 5)).toBe(0.5);
    expect(ratio(1, 0)).toBeUndefined();
  });
});
