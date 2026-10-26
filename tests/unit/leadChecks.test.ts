import { describe, expect, it } from "vitest";
import { checkIndustry, checkNotExisting, checkRange, checkRole, checkTimeline, checkWorkEmail, CHECKS, decide } from "@/lib/leadChecks";

describe("work email", () => {
  it("fails free providers and unresolvable domains", () => {
    expect(checkWorkEmail("pat@gmail.com", true).result).toBe("FAIL");
    expect(checkWorkEmail("pat@acme.invalid", false).result).toBe("FAIL");
    expect(checkWorkEmail("pat@acme.com", null).result).toBe("UNKNOWN");
    expect(checkWorkEmail("pat@acme.com", true).result).toBe("PASS");
  });
});

describe("ranges", () => {
  const fmt = (n: number) => String(n);
  it("checks min and max, unknown when missing", () => {
    expect(checkRange("company_size", 50, 100, 2500, fmt).result).toBe("FAIL");
    expect(checkRange("company_size", 3000, 100, 2500, fmt).result).toBe("FAIL");
    expect(checkRange("company_size", 100, 100, 2500, fmt).result).toBe("PASS");
    expect(checkRange("company_size", null, 100, 2500, fmt).result).toBe("UNKNOWN");
    expect(checkRange("revenue", null, null, null, fmt).result).toBe("PASS");
  });
});

describe("industry", () => {
  const targets = ["Commercial real estate", "Healthcare services"];
  it("matches targets loosely, excludes categories and domains", () => {
    expect(checkIndustry("Real estate", "x.com", targets, [], []).result).toBe("PASS");
    expect(checkIndustry("Healthcare services", "x.com", targets, [], []).result).toBe("PASS");
    expect(checkIndustry("Retail", "x.com", targets, [], []).result).toBe("FAIL");
    expect(checkIndustry("Gambling", "x.com", targets, ["Gambling"], []).result).toBe("FAIL");
    expect(checkIndustry("Healthcare services", "rival.com", targets, [], ["rival.com"]).result).toBe("FAIL");
    expect(checkIndustry(null, "x.com", targets, [], []).result).toBe("UNKNOWN");
  });
});

describe("role", () => {
  const targets = ["CEO", "COO", "VP Operations", "Head of Data"];
  it("needs director level or above and a matching function", () => {
    expect(checkRole("Chief Operating Officer", targets).result).toBe("PASS");
    expect(checkRole("COO", targets).result).toBe("PASS");
    expect(checkRole("Vice President, Operations", targets).result).toBe("PASS");
    expect(checkRole("Director of Data Engineering", targets).result).toBe("PASS");
    expect(checkRole("Operations Analyst", targets).result).toBe("FAIL");
    expect(checkRole("VP Sales", targets).result).toBe("UNKNOWN");
    expect(checkRole("Founder", targets).result).toBe("PASS");
    expect(checkRole(null, targets).result).toBe("UNKNOWN");
  });
});

describe("timeline", () => {
  it("passes inside the window, fails beyond it or with no timeline", () => {
    expect(checkTimeline("now", 180).result).toBe("PASS");
    expect(checkTimeline("6m", 180).result).toBe("PASS");
    expect(checkTimeline("12m", 180).result).toBe("FAIL");
    expect(checkTimeline("research", 180).result).toBe("FAIL");
    expect(checkTimeline("Within 3 months", 90).result).toBe("PASS");
    expect(checkTimeline(null, 180).result).toBe("UNKNOWN");
  });
});

describe("existing customer or open deal", () => {
  it("fails either, unknown when the lookup failed", () => {
    expect(checkNotExisting({ existingCustomer: true, openDeal: false }).result).toBe("FAIL");
    expect(checkNotExisting({ existingCustomer: false, openDeal: true }).result).toBe("FAIL");
    expect(checkNotExisting({ existingCustomer: false, openDeal: false }).result).toBe("PASS");
    expect(checkNotExisting(null).result).toBe("UNKNOWN");
  });
});

describe("decide", () => {
  const pass = CHECKS.map((c) => ({ check: c.key, result: "PASS" as const, reason: "ok" }));
  it("all pass is validated", () => {
    expect(decide(pass).status).toBe("VALIDATED");
  });
  it("any fail is not qualified, and the reason names it", () => {
    const d = decide(pass.map((c) => (c.check === "timeline" ? { ...c, result: "FAIL" as const, reason: "Just researching." } : c)));
    expect(d).toEqual({ status: "NOT_QUALIFIED", reason: "Just researching." });
  });
  it("fail beats unknown", () => {
    const mixed = pass.map((c, i) => (i === 0 ? { ...c, result: "UNKNOWN" as const } : i === 1 ? { ...c, result: "FAIL" as const } : c));
    expect(decide(mixed).status).toBe("NOT_QUALIFIED");
  });
  it("any unknown without a fail goes to review", () => {
    expect(decide(pass.map((c, i) => (i === 2 ? { ...c, result: "UNKNOWN" as const, reason: "Revenue not found." } : c))).status).toBe("REVIEW");
  });
  it("missing checks go to review, never validated", () => {
    expect(decide(pass.slice(0, 5)).status).toBe("REVIEW");
  });
});
