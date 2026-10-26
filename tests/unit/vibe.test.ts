import { describe, expect, it } from "vitest";
import { exclusionFor, mapEvent, rangeMid, topicLabel, vibeSignals } from "@/integrations/prospects/vibe";
import { matchAccount } from "@/lib/matching";
import { DEFAULT_SIGNAL_RULES } from "@/lib/signalRules";

const NOW = new Date("2026-10-15T12:00:00Z");

describe("ranges", () => {
  it("takes the geometric middle of a range", () => {
    expect(rangeMid("501-1000")).toBe(708);
    expect(rangeMid("75M-200M")).toBe(122474487);
    expect(rangeMid("10001+")).toBe(10001);
    expect(rangeMid(null)).toBeNull();
  });
});

describe("topics", () => {
  it("drops the category and fixes capitals", () => {
    expect(topicLabel("machine learning & artificial intelligence: ai risk management")).toBe("AI risk management");
    expect(topicLabel("it management: legacy system modernization")).toBe("Legacy system modernization");
  });
});

describe("events", () => {
  it("maps Vibe events to our signal types", () => {
    expect(mapEvent({ type: "hiring_in_operations_department", date: "2026-10-01" })).toEqual({ type: "hiring", title: "Hiring in operations" });
    expect(mapEvent({ type: "increase_in_operations_department", date: "2026-10-01" })?.type).toBe("workforce");
    expect(mapEvent({ type: "merger_and_acquisitions", date: "2026-10-01", title: "Acquires Acme" })).toEqual({ type: "news", title: "Acquisition or merger: Acquires Acme" });
    expect(mapEvent({ type: "outages_and_security_breaches", date: "2026-10-01" })?.type).toBe("risk");
    expect(mapEvent({ type: "lawsuits_and_legal_issues", date: "2026-10-01" })?.type).toBe("risk");
    expect(mapEvent({ type: "new_funding_round", date: "2026-10-01", title: "Raised $40M Series C" })).toEqual({ type: "funding", title: "Raised $40M Series C" });
    expect(mapEvent({ type: "decrease_in_sales_department", date: "2026-10-01" })?.title).toMatch(/^Cost cutting/);
  });
  it("only counts a new hire as a leadership change when it's an executive", () => {
    expect(mapEvent({ type: "employee_joined_company", date: "2026-10-01", title: "Jane Doe, Chief Operating Officer" })?.type).toBe("leadership");
    expect(mapEvent({ type: "employee_joined_company", date: "2026-10-01", title: "Sam Lee, Staff Accountant" })).toBeNull();
  });
});

describe("signals from a Vibe company", () => {
  const sigs = vibeSignals(
    {
      businessId: "b1", name: "Sentral", domain: "sentral.com",
      intent: [{ topic: "machine learning & artificial intelligence: ai risk management", score: 84 }, { topic: "x: noise", score: 30 }],
      workforce: { share: { operations: 0.21 }, change: { operations: 6, sales: 1 } },
      events: [{ type: "outages_and_security_breaches", date: "2026-09-20" }, { type: "company_award", date: "2026-09-01", title: "Best place to work" }],
    },
    NOW,
  );
  it("keeps intent of 50 or more with its score", () => {
    const intent = sigs.filter((s) => s.type === "intent");
    expect(intent).toHaveLength(1);
    expect(intent[0]).toMatchObject({ title: "Researching: AI risk management", value: 0.84 });
  });
  it("adds team makeup and growth", () => {
    expect(sigs.find((s) => s.externalId === "workforce:ops-share")?.title).toBe("Operations is 21% of staff");
    expect(sigs.some((s) => s.title.startsWith("Operations team growing: 6"))).toBe(true);
    expect(sigs.some((s) => s.title.startsWith("Sales team growing"))).toBe(false);
  });
  it("dates events", () => {
    expect(sigs.find((s) => s.type === "risk")?.occurredAt.toISOString()).toBe("2026-09-20T00:00:00.000Z");
  });
});

describe("exclusions", () => {
  it("rules out software and AI vendors", () => {
    expect(exclusionFor({ name: "Qventus", naics: "62", linkedinCategory: "hospitals and health care", description: "Qventus uses AI to intelligently automate operations across care settings" })).toMatch(/Sells software/);
    expect(exclusionFor({ name: "Navis", naics: "493110", linkedinCategory: "transportation", description: "Navis is the premier brand of TOS under the Kaleris supply chain execution software platform." })).toMatch(/Sells software/);
    expect(exclusionFor({ name: "X", naics: "541511", linkedinCategory: null, description: null })).toMatch(/Sells software/);
  });
  it("rules out units of larger companies, naming the parent", () => {
    expect(exclusionFor({ name: "Sunrise Hospital", naics: "62", linkedinCategory: null, description: "Sunrise Hospital and Medical Center is part of HCA Healthcare. HCA has been named..." })).toBe("Part of HCA Healthcare. Buying decisions likely sit with the parent company.");
    expect(exclusionFor({ name: "Allied Air", naics: "333415", linkedinCategory: null, description: "Allied Air is a Lennox International company that brings together six brands" })).toMatch(/Part of Lennox International/);
  });
  it("leaves operators alone", () => {
    expect(exclusionFor({ name: "Kairoi Residential", naics: "531", linkedinCategory: "real estate", description: "Kairoi Residential is a partner-led company with a unified approach to investing in, developing, and managing multifamily communities." })).toBeNull();
    expect(exclusionFor({ name: "Emerson Health", naics: "62", linkedinCategory: "hospitals and health care", description: "Emerson Hospital has proudly served our community for more than a century." })).toBeNull();
  });
});

describe("the framework end to end", () => {
  const offer = (slug: string) => ({
    id: slug, industries: ["Commercial real estate", "Real estate", "Healthcare services", "Hospitals and health care"], excludedCategories: [], excludedDomains: [],
    companySizeMin: 100, companySizeMax: 2500, revenueMinCents: 5e9, revenueMaxCents: 5e10, regions: ["United States"], targetTitles: ["CIO", "COO"], signalRules: DEFAULT_SIGNAL_RULES[slug]!,
  });
  const sentral = { domain: "sentral.com", industry: "Real estate", employees: 708, revenueCents: 12e9, country: "United States", technologies: ["Microsoft Copilot"] };
  const signals = vibeSignals({ businessId: "b", name: "Sentral", domain: "sentral.com", intent: [{ topic: "machine learning & artificial intelligence: ai risk management", score: 84 }, { topic: "machine learning & artificial intelligence: responsible ai", score: 84 }] }, NOW).map((s, i) => ({ ...s, id: `s${i}` }));

  it("a company researching AI risk while using Copilot is an act-now AgentReady lead", () => {
    const ar = matchAccount(sentral, signals, [{ title: "CIO" }], offer("agentready-diagnostic"), undefined, NOW);
    expect(ar.tier).toBe("act_now");
    expect(ar.hits[0]!.kind).toBe("research");
    expect(ar.hits[0]!.why).toMatch(/can we do this safely/);
    const mb = matchAccount(sentral, signals, [{ title: "CIO" }], offer("modernization-blueprint"), undefined, NOW);
    expect(ar.total).toBeGreaterThan(mb.total);
  });

  it("pain alone never makes act now", () => {
    const legacy = { ...sentral, technologies: ["Microsoft Access", "FoxPro"] };
    const m = matchAccount(legacy, [], [{ title: "CIO" }], offer("modernization-blueprint"), undefined, NOW);
    expect(m.signal).toBeGreaterThan(0);
    expect(m.tier).toBe("good_fit");
  });

  it("an excluded company is not a fit for any offer, with the reason", () => {
    const m = matchAccount({ ...sentral, excluded: "Sells software or AI to this market." }, signals, [], offer("agentready-diagnostic"), undefined, NOW);
    expect(m.tier).toBe("not_fit");
    expect(m.disqualified).toMatch(/Sells software/);
  });
});
