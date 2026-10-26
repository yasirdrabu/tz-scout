import { describe, expect, it } from "vitest";
import { bestMatch, fitScore, industryMatches, matchAccount, recency, signalScore, tierFor, titleMatches, type MatchAccount, type MatchOffering, type SignalRule } from "@/lib/matching";
import { DEFAULT_SIGNAL_RULES } from "@/lib/signalRules";

const NOW = new Date("2026-10-14T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400_000);
const M = 100_000_000;

const offering = (o: Partial<MatchOffering> = {}): MatchOffering => ({
  id: "o1",
  industries: ["Commercial real estate", "Healthcare services", "Logistics"],
  excludedCategories: ["Gambling"],
  excludedDomains: ["taazaa.com"],
  companySizeMin: 100,
  companySizeMax: 2500,
  revenueMinCents: 50 * M,
  revenueMaxCents: 500 * M,
  regions: ["United States"],
  targetTitles: ["CEO", "COO", "VP Operations"],
  signalRules: [],
  ...o,
});
const account = (a: Partial<MatchAccount> = {}): MatchAccount => ({ domain: "acme.com", industry: "Logistics", employees: 400, revenueCents: 90 * M, country: "United States", technologies: [], ...a });

describe("fitScore", () => {
  it("a perfect fit with a buyer on file scores 100", () => {
    expect(fitScore(account(), offering(), [{ title: "Chief Operating Officer" }]).score).toBe(100);
  });
  it("no buyer contact yet costs 15", () => {
    expect(fitScore(account(), offering(), []).score).toBe(85);
  });
  it("unknowns earn half credit", () => {
    const r = fitScore(account({ industry: null, employees: null, revenueCents: null, country: null }), offering(), []);
    expect(r.score).toBe(15 + 12 + 10 + 5);
  });
  it("wrong industry and out-of-range size lose those points", () => {
    const r = fitScore(account({ industry: "Retail", employees: 40 }), offering(), []);
    expect(r.parts.find((p) => p.key === "industry")!.points).toBe(0);
    expect(r.parts.find((p) => p.key === "size")!.points).toBe(0);
  });
  it("a known wrong industry caps fit at 45 even when everything else fits", () => {
    expect(fitScore(account({ industry: "Retail" }), offering(), [{ title: "COO" }]).score).toBe(45);
    expect(fitScore(account({ employees: 9000 }), offering(), [{ title: "COO" }]).score).toBe(45);
  });
  it("just outside the size range gets partial credit", () => {
    expect(fitScore(account({ employees: 80 }), offering(), []).parts.find((p) => p.key === "size")!.points).toBe(10);
  });
  it("excluded category or domain disqualifies", () => {
    expect(fitScore(account({ industry: "Gambling" }), offering(), []).disqualified).toMatch(/excluded/);
    expect(fitScore(account({ domain: "taazaa.com" }), offering(), []).disqualified).toMatch(/excluded/);
  });
});

describe("helpers", () => {
  it("industry matching is loose", () => {
    expect(industryMatches("Commercial real estate", "Real estate")).toBe(true);
    expect(industryMatches("Healthcare services", "Hospital and healthcare")).toBe(true);
    expect(industryMatches("Logistics", "Retail")).toBe(false);
  });
  it("title matching by function", () => {
    expect(titleMatches("Chief Operating Officer", ["COO"])).toBe(true);
    expect(titleMatches("VP of Operations", ["VP Operations"])).toBe(true);
    expect(titleMatches("VP Sales", ["COO", "VP Operations"])).toBe(false);
  });
  it("recency halves every 45 days; tech and growth don't decay; older than a year counts zero", () => {
    expect(recency("hiring", NOW, NOW)).toBe(1);
    expect(recency("hiring", daysAgo(45), NOW)).toBeCloseTo(0.5, 6);
    expect(recency("hiring", daysAgo(90), NOW)).toBeCloseTo(0.25, 6);
    expect(recency("tech", daysAgo(900), NOW)).toBe(1);
    expect(recency("news", daysAgo(400), NOW)).toBe(0);
  });
});

const rules: SignalRule[] = [
  { id: "h", type: "hiring", label: "Hiring AI", weight: 30, match: ["ai", "machine learning"] },
  { id: "t", type: "tech", label: "Legacy", weight: 40, match: ["microsoft access"] },
  { id: "g", type: "growth", label: "Growth", weight: 20, match: [], min: 0.1 },
];

describe("signalScore", () => {
  it("a fresh matching signal earns the rule's full weight", () => {
    const s = signalScore(account(), [{ id: "1", type: "hiring", title: "Hiring: Director of AI", occurredAt: NOW }], rules, NOW);
    expect(s.score).toBe(30);
    expect(s.hits[0]!.signalIds).toEqual(["1"]);
  });
  it("short keywords match whole words only", () => {
    const s = signalScore(account(), [{ id: "1", type: "hiring", title: "Hiring: Maintenance Planner", occurredAt: NOW }], rules, NOW);
    expect(s.score).toBe(0);
  });
  it("older signals count less", () => {
    const s = signalScore(account(), [{ id: "1", type: "hiring", title: "AI Product Manager", occurredAt: daysAgo(45) }], rules, NOW);
    expect(s.score).toBe(15);
  });
  it("more of the same adds a little, capped at the rule weight", () => {
    const s = signalScore(account(), [
      { id: "1", type: "hiring", title: "AI Engineer", occurredAt: daysAgo(45) },
      { id: "2", type: "hiring", title: "Machine Learning Engineer", occurredAt: daysAgo(45) },
    ], rules, NOW);
    expect(s.score).toBe(Math.round(30 * (0.5 + 0.3 * 0.5)));
  });
  it("tech rules read the account's stack", () => {
    expect(signalScore(account({ technologies: ["Microsoft Access", "Salesforce"] }), [], rules, NOW).score).toBe(40);
  });
  it("numeric rules respect the minimum", () => {
    expect(signalScore(account(), [{ id: "g", type: "growth", title: "Headcount up 8%", value: 0.08, occurredAt: NOW }], rules, NOW).score).toBe(0);
    expect(signalScore(account(), [{ id: "g", type: "growth", title: "Headcount up 18%", value: 0.18, occurredAt: NOW }], rules, NOW).score).toBe(20);
  });
  it("research intent scales with the research score: 60 is half, a spike of 80 or more is full", () => {
    const ir: SignalRule[] = [{ id: "i", type: "intent", label: "Researching AI", weight: 40, match: ["ai"], min: 0.6 }];
    const at = (v: number) => signalScore(account(), [{ id: "i", type: "intent", title: "Researching: AI strategy", value: v, occurredAt: NOW }], ir, NOW).score;
    expect(at(0.55)).toBe(0);
    expect(at(0.6)).toBe(20);
    expect(at(0.7)).toBe(30);
    expect(at(0.84)).toBe(40);
  });
  it("related research topics don't stack: the strongest one counts", () => {
    const ir: SignalRule[] = [{ id: "i", type: "intent", label: "Researching AI", weight: 40, match: ["ai"], min: 0.6 }];
    const s = signalScore(account(), ["strategy", "readiness", "transformation"].map((t, i) => ({ id: `${i}`, type: "intent", title: `Researching: AI ${t}`, value: 0.65, occurredAt: NOW })), ir, NOW);
    expect(s.score).toBe(25);
    expect(s.hits[0]!.signalIds).toHaveLength(3);
  });
  it("caps at 100", () => {
    const big: SignalRule[] = [1, 2, 3].map((i) => ({ id: `${i}`, type: "funding" as const, label: "f", weight: 50, match: [] }));
    expect(signalScore(account(), [{ id: "x", type: "funding", title: "Raised", occurredAt: NOW }], big, NOW).score).toBe(100);
  });
});

describe("matchAccount and tiers", () => {
  it("blends 55% fit and 45% signals", () => {
    const m = matchAccount(account({ technologies: ["Microsoft Access"] }), [], [{ title: "COO" }], offering({ signalRules: rules }), undefined, NOW);
    expect(m.fit).toBe(100);
    expect(m.signal).toBe(40);
    expect(m.total).toBe(Math.round(100 * 0.55 + 40 * 0.45));
    // A tech stack is visible pain, not a reason to buy now: good fit until research or a trigger shows up.
    expect(m.tier).toBe("good_fit");
  });
  it("a poor fit can't be lifted by signals", () => {
    const m = matchAccount(account({ industry: "Retail", employees: 20, revenueCents: 1 * M, technologies: ["Microsoft Access"] }), [], [], offering({ signalRules: rules }), undefined, NOW);
    expect(m.total).toBeLessThanOrEqual(m.fit);
    expect(m.tier).toBe("not_fit");
  });
  it("tier rules", () => {
    expect(tierFor(80, 50, 70, null)).toBe("act_now");
    expect(tierFor(80, 10, 50, null)).toBe("good_fit");
    expect(tierFor(50, 80, 50, null)).toBe("watch");
    expect(tierFor(30, 80, 30, null)).toBe("not_fit");
    expect(tierFor(90, 90, 90, "excluded")).toBe("not_fit");
  });
  it("bestMatch picks the highest total, then tier, then fit", () => {
    const b = bestMatch([
      { id: "a", total: 70, fit: 90, tier: "good_fit" as const },
      { id: "b", total: 70, fit: 70, tier: "act_now" as const },
      { id: "c", total: 60, fit: 100, tier: "good_fit" as const },
    ]);
    expect(b!.id).toBe("b");
  });
});

describe("default rules map signals to the right offer", () => {
  const legacyCarrier = account({ technologies: ["Microsoft Access", "QuickBooks"] });
  const signals = [{ id: "j", type: "hiring", title: "Hiring: Microsoft Access Developer", occurredAt: daysAgo(10) }];
  const contacts = [{ title: "VP Operations" }];
  const score = (slug: string) => matchAccount(legacyCarrier, signals, contacts, offering({ signalRules: DEFAULT_SIGNAL_RULES[slug]!, targetTitles: ["COO", "VP Operations", "CIO"] }), undefined, NOW).total;
  it("a carrier on Access hiring an Access developer is a Modernization Blueprint buyer", () => {
    const mb = score("modernization-blueprint");
    for (const other of ["ai-opportunity-map", "agentready-diagnostic", "smart-space-poc", "company-brain"]) expect(mb).toBeGreaterThan(score(other));
  });
  it("a healthcare group hiring an AI governance lead and using Copilot is an AgentReady buyer", () => {
    const a = account({ industry: "Healthcare services", technologies: ["Microsoft Copilot", "Epic"] });
    const s = [{ id: "j", type: "hiring", title: "Hiring: AI Governance Lead", occurredAt: daysAgo(5) }];
    const t = (slug: string) => matchAccount(a, s, [{ title: "CIO" }], offering({ signalRules: DEFAULT_SIGNAL_RULES[slug]!, targetTitles: ["CIO", "COO"] }), undefined, NOW).total;
    expect(t("agentready-diagnostic")).toBeGreaterThan(t("modernization-blueprint"));
    expect(t("agentready-diagnostic")).toBeGreaterThan(t("ai-opportunity-map"));
  });
});
