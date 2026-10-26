import { describe, expect, it } from "vitest";
import { buildScorecard, colourFor, emptyCounts, METRIC_BY_KEY, rollingValue, weekStart, type RawCounts } from "@/lib/scorecard";

const higher = { direction: "higher" as const };
const lower = { direction: "lower" as const };
const band = { direction: "band" as const };

describe("colourFor", () => {
  it("higher is better: green at or above, amber within 15% worse, red beyond", () => {
    expect(colourFor(higher, 0.7, 0.7, 50)).toBe("green");
    expect(colourFor(higher, 0.8, 0.7, 50)).toBe("green");
    expect(colourFor(higher, 0.595, 0.7, 50)).toBe("amber"); // exactly 15% worse
    expect(colourFor(higher, 0.6, 0.7, 50)).toBe("amber");
    expect(colourFor(higher, 0.594, 0.7, 50)).toBe("red");
  });

  it("lower is better (costs): green at or below, amber up to 15% above, red beyond", () => {
    expect(colourFor(lower, 10000, 10000, 5)).toBe("green");
    expect(colourFor(lower, 9000, 10000, 5)).toBe("green");
    expect(colourFor(lower, 11500, 10000, 5)).toBe("amber");
    expect(colourFor(lower, 11501, 10000, 5)).toBe("red");
  });

  it("grey when the sample is below the minimum", () => {
    expect(colourFor(higher, 0.9, 0.7, 4, 5)).toBe("grey");
    expect(colourFor(higher, null, 0.7, 10, 5)).toBe("grey");
  });

  it("no colour without a target", () => {
    expect(colourFor(higher, 0.9, null, 100)).toBe("none");
  });

  it("band (spend): within 5% green, within 15% amber, beyond red, either side", () => {
    expect(colourFor(band, 3100, 3000, 1)).toBe("green");
    expect(colourFor(band, 2600, 3000, 1)).toBe("amber");
    expect(colourFor(band, 3500, 3000, 1)).toBe("red");
  });
});

const week = (o: Partial<RawCounts>): RawCounts => ({ ...emptyCounts(), ...o });

describe("derived metrics", () => {
  it("costs divide spend by the stage count", () => {
    const w = week({ spendCents: 300000, clicks: 1000, formFills: 30, won: 2 });
    expect(METRIC_BY_KEY.cpc!.compute(w).value).toBe(300);
    expect(METRIC_BY_KEY.costPerFormFill!.compute(w).value).toBe(10000);
    expect(METRIC_BY_KEY.costPerWon!.compute(w)).toEqual({ value: 150000, sample: 2 });
  });

  it("rates carry their denominator as the sample", () => {
    expect(METRIC_BY_KEY.discoveryShowRate!.compute(week({ discoveryHeld: 7, discoveryBooked: 10 }))).toEqual({ value: 0.7, sample: 10 });
    expect(METRIC_BY_KEY.closeRate!.compute(week({ won: 0, salesHeld: 0 })).value).toBeNull();
  });
});

describe("rollingValue", () => {
  it("rates use the ratio of summed counts, not the average of weekly rates", () => {
    const weeks = [week({ discoveryHeld: 1, discoveryBooked: 1 }), week({ discoveryHeld: 1, discoveryBooked: 9 })];
    // average of rates would be (100% + 11.1%) / 2 = 55.6%; ratio of totals is 2 / 10 = 20%
    expect(rollingValue(METRIC_BY_KEY.discoveryShowRate!, weeks).value).toBe(0.2);
  });

  it("counts are averaged per week", () => {
    expect(rollingValue(METRIC_BY_KEY.formFills!, [week({ formFills: 40 }), week({ formFills: 60 })]).value).toBe(50);
  });
});

describe("buildScorecard", () => {
  it("colours each week and the rolling average against targets", () => {
    const rows = buildScorecard([week({ won: 1 }), week({ won: 3 })], { won: { target: 2 } });
    const won = rows.find((r) => r.def.key === "won")!;
    expect(won.weeks.map((c) => c.colour)).toEqual(["red", "green"]);
    expect(won.rolling.value).toBe(2);
    expect(won.rolling.colour).toBe("green");
  });
});

describe("weekStart", () => {
  it("returns Monday 00:00 UTC", () => {
    expect(weekStart(new Date("2026-10-13T15:00:00Z")).toISOString()).toBe("2026-10-12T00:00:00.000Z"); // Tuesday
    expect(weekStart(new Date("2026-10-18T23:59:00Z")).toISOString()).toBe("2026-10-12T00:00:00.000Z"); // Sunday
    expect(weekStart(new Date("2026-10-12T00:00:00Z")).toISOString()).toBe("2026-10-12T00:00:00.000Z"); // Monday
  });
});
