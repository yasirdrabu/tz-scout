import { describe, expect, it } from "vitest";
import { verdict } from "@/lib/verdict";

const targets = { targetCtr: 0.01, targetCpcCents: 350, minImpressions: 1000 };

describe("verdict", () => {
  it("passes when clickthrough is at or above target AND cost per click at or below target", () => {
    // 2,000 impressions, 20 clicks (1.0%), $70 spend -> $3.50 per click
    const v = verdict({ impressions: 2000, clicks: 20, spendCents: 7000 }, targets);
    expect(v.status).toBe("pass");
    expect(v.ctr).toBe(0.01);
    expect(v.cpcCents).toBe(350);
  });

  it("fails on clickthrough alone", () => {
    const v = verdict({ impressions: 2000, clicks: 19, spendCents: 1900 }, targets);
    expect(v.status).toBe("fail");
    expect(v.ctrPass).toBe(false);
    expect(v.cpcPass).toBe(true);
  });

  it("fails on cost per click alone", () => {
    const v = verdict({ impressions: 2000, clicks: 30, spendCents: 10501 }, targets);
    expect(v.status).toBe("fail");
    expect(v.ctrPass).toBe(true);
    expect(v.cpcPass).toBe(false);
  });

  it("needs the minimum impressions before any verdict", () => {
    expect(verdict({ impressions: 999, clicks: 50, spendCents: 100 }, targets).status).toBe("not_enough_data");
    expect(verdict({ impressions: 1000, clicks: 50, spendCents: 100 }, targets).status).toBe("pass");
  });

  it("no clicks after enough impressions is a fail, not a divide by zero", () => {
    const v = verdict({ impressions: 5000, clicks: 0, spendCents: 9000 }, targets);
    expect(v.status).toBe("fail");
    expect(v.cpcCents).toBeNull();
  });

  it("no result yet is not enough data", () => {
    expect(verdict(null, targets).status).toBe("not_enough_data");
  });

  it("defaults the minimum to 1,000 impressions", () => {
    expect(verdict({ impressions: 900, clicks: 20, spendCents: 100 }, { targetCtr: 0.01, targetCpcCents: 350 }).status).toBe("not_enough_data");
  });
});
