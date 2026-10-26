import { describe, expect, it } from "vitest";
import { audienceRating, competitionRating, DEFAULT_WEIGHTS, dealSizeRating, FACTOR_KEYS, FACTORS, proofRating, rankSegments, scoreSegment, type FactorKey } from "@/lib/scoring";

const all = (v: Partial<Record<FactorKey, number>>, fill = 5) => FACTOR_KEYS.map((k) => ({ factor: k, value: v[k] ?? fill }));

describe("scoreSegment", () => {
  it("default weights total 100, split 50 market and 50 fit", () => {
    expect(Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    const r = scoreSegment(all({}));
    expect(r.marketMax).toBe(50);
    expect(r.fitMax).toBe(50);
  });

  it("perfect segment scores 100: inverted factors count as 10 minus their value", () => {
    const perfect = all({ pain: 10, urgency: 10, audience: 10, ability_to_pay: 10, competition: 0, proof: 10, delivery_fit: 10, deal_size: 10, committee: 0, cycle: 0 });
    expect(scoreSegment(perfect).total).toBe(100);
  });

  it("all fives score 50", () => {
    expect(scoreSegment(all({})).total).toBe(50);
  });

  it("score = sum(factor / 10 x weight)", () => {
    // pain 8 (w12) -> 9.6; everything else 0 except inverted at 10 (count as 0)
    const f = all({ pain: 8, urgency: 0, audience: 0, ability_to_pay: 0, competition: 10, proof: 0, delivery_fit: 0, deal_size: 0, committee: 10, cycle: 10 });
    expect(scoreSegment(f).total).toBe(9.6);
  });

  it("uses the override when present and flags it", () => {
    const f = all({}).map((x) => (x.factor === "pain" ? { ...x, overrideValue: 10 } : x));
    const r = scoreSegment(f);
    expect(r.total).toBe(56); // +5/10 x 12
    expect(r.factors.find((x) => x.key === "pain")!.overridden).toBe(true);
  });

  it("missing factors count as zero", () => {
    expect(scoreSegment([{ factor: "pain", value: 10 }]).total).toBe(12);
  });

  it("rescales custom weights to 100", () => {
    const weights = Object.fromEntries(FACTORS.map((f) => [f.key, f.defaultWeight * 2]));
    expect(scoreSegment(all({}), weights).total).toBe(50);
  });

  it("changing a weight changes the ranking", () => {
    const a = { name: "A", factors: all({ pain: 10, proof: 2 }) };
    const b = { name: "B", factors: all({ pain: 2, proof: 10 }) };
    const rank = (w?: Partial<Record<FactorKey, number>>) =>
      rankSegments([a, b].map((s) => ({ name: s.name, score: scoreSegment(s.factors, { ...DEFAULT_WEIGHTS, ...w }).total }))).map((s) => s.name);
    expect(rank()).toEqual(["B", "A"]); // proof weighs 14, pain 12
    expect(rank({ pain: 30 })).toEqual(["A", "B"]);
  });
});

describe("data factor ratings", () => {
  it("audience on a log scale", () => {
    expect(audienceRating(0)).toBe(0);
    expect(audienceRating(2000)).toBe(0);
    expect(audienceRating(1_000_000)).toBe(10);
    expect(audienceRating(50_000)).toBeGreaterThan(4);
    expect(audienceRating(50_000)).toBeLessThan(6);
  });
  it("competition rises with cost per click", () => {
    expect(competitionRating(100)).toBe(1);
    expect(competitionRating(1600)).toBe(10);
    expect(competitionRating(null)).toBe(5);
  });
  it("proof by matching case studies", () => {
    expect([0, 1, 2, 3, 4, 9].map(proofRating)).toEqual([0, 5, 7, 9, 10, 10]);
  });
  it("deal size relative to target, capped at 10", () => {
    expect(dealSizeRating(500_000, 1_000_000)).toBe(5);
    expect(dealSizeRating(2_000_000, 1_000_000)).toBe(10);
    expect(dealSizeRating(null, 1_000_000)).toBe(5);
  });
});
