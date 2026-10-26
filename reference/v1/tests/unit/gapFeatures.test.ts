import { describe, expect, it } from "vitest";
import { mockOutreachSequence } from "@/ai/outreachSequence";
import { combineReadiness, measuredFactors, bandFor } from "@/lib/offerReadiness";
import { mockOfferJudgement } from "@/ai/offerReadiness";
import { QUALIFICATION, qualificationScore } from "@/lib/qualification";
import { mockCallReview } from "@/ai/callReview";
import { mockCallPrep } from "@/ai/callPrep";
import { mockProposal, proposalText } from "@/ai/proposal";
import { titleFunction, winStats } from "@/lib/wins";
import { mockWinFindings } from "@/ai/winAnalysis";
import { buildHubSpotContext } from "@/lib/hubspotContext";

const offer = { name: "Modernization Blueprint", promise: "A current-state map, target architecture and a fixed price for Release 1 in two weeks, or the Blueprint is free.", proof: ["Guarantee: if Release 1 can't be fixed-priced, the Blueprint is free"] };

describe("outbound follow-up sequence", () => {
  const seq = mockOutreachSequence({
    account: { name: "Grinnell Mutual", industry: "Insurance", location: "Grinnell, Iowa" },
    buyer: { name: "Kevin Kies", title: "VP Direct Claims" },
    signals: [
      { type: "leadership", title: "New leader joined: Vice President And Chief Information Officer", when: "6 months ago" },
      { type: "tech", title: "Uses IBM AS/400", when: "current stack" },
      { type: "intent", title: "Researching: Legacy system modernization", when: "this week" },
    ],
    offer,
    opener: "Hi Kevin, I noticed Grinnell Mutual just brought on a new Vice President And Chief Information Officer. We map the old system and put a fixed price on replacing it in two weeks.",
    angle: null,
    sender: "Zach Wiant",
  });
  it("four emails on days 0, 3, 7 and 14", () => {
    expect(seq.steps.map((s) => s.day)).toEqual([0, 3, 7, 14]);
    expect(seq.steps.map((s) => s.purpose)).toEqual(["Opener", "New angle", "Proof", "Close the loop"]);
  });
  it("addresses the buyer, signs as the owner, and never quotes research data or uses em dashes", () => {
    for (const s of seq.steps) {
      expect(s.body).toMatch(/^Hi Kevin,/);
      expect(s.body.trim().endsWith("Zach")).toBe(true);
      expect(s.body).not.toMatch(/research|—/i);
      expect(s.subject).not.toMatch(/—/);
    }
    expect(seq.steps[1]!.body).toMatch(/runs IBM AS\/400/);
    expect(seq.steps[2]!.body).toMatch(/our guarantee/);
  });
});

describe("offer readiness", () => {
  const facts = { caseStudies: 2, proofPoints: 1, priceMinCents: 1_000_000, matchedAccounts: 14, actNow: 7, withBuyer: 12, wins: null };
  const judged = Object.fromEntries(Object.entries(mockOfferJudgement({ name: offer.name, promise: offer.promise, price: "$10,000", salesCycleDays: 30, targetTitles: ["CIO"], industries: [], proofPoints: offer.proof, caseStudies: [] })).filter(([k]) => k !== "fixes").map(([k, v]) => [k, { ...(v as { value: number; reason: string }), source: "rules" as const }]));
  it("measures the market half from our accounts", () => {
    const m = measuredFactors(facts);
    expect(m.demand!.value).toBe(7);
    expect(m.urgency!.value).toBe(6);
    expect(m.reachable!.value).toBe(9);
    expect(m.firstStep!.value).toBe(10);
    expect(m.wins!.reason).toMatch(/half credit/);
  });
  it("adds up to a score out of 100 with a band", () => {
    const r = combineReadiness(judged, measuredFactors(facts));
    expect(r.score).toBe(r.offerScore + r.marketScore);
    expect(r.score).toBeGreaterThan(50);
    expect(r.band).toBe(bandFor(r.score));
    expect(r.factors.find((f) => f.key === "risk")!.value).toBe(8); // the guarantee was read from the promise
  });
  it("an override wins, and the original value is kept to restore it", () => {
    const r = combineReadiness(judged, measuredFactors(facts), { different: { value: 9, note: "Only fixed-price modernization in market" } });
    const f = r.factors.find((x) => x.key === "different")!;
    expect(f.value).toBe(9);
    expect(f.base).toBe(5);
    expect(f.source).toBe("override");
  });
  it("bands at 75 and 60", () => {
    expect([bandFor(80), bandFor(65), bandFor(40)]).toEqual(["ready", "fix_first", "rework"]);
  });
});

const transcript = `Thanks for making time. Honestly the problem is our claims system is twenty years old and everything is manual. It takes us three days to close a simple claim. That costs us about 400 hours a month in overtime. Our new CIO started this year and the board wants a plan by the end of Q2. Any change like this would need CFO approval and the board signs off on anything over 100k. We have budget set aside this year for modernization. That sounds like exactly what we need. Let's set a next meeting on Tuesday with the CIO.`;

describe("call review and prep", () => {
  it("scores the checklist from what was said", () => {
    const r = mockCallReview({ account: "Grinnell Mutual", offer: offer.name, buyer: "Kevin Kies", checklist: [...QUALIFICATION], transcript });
    const st = Object.fromEntries(r.qualification.map((q) => [q.key, q.status]));
    expect(st.problem).toBe("met");
    expect(st.decision).not.toBe("missing");
    expect(st.budget).not.toBe("missing");
    expect(st.nextStep).not.toBe("missing");
    expect(r.recommendedStatus).toBe("QUALIFIED");
    expect(r.followUpEmail).toMatch(/^Hi Kevin/);
    expect(qualificationScore(r.qualification)).toBeGreaterThan(60);
  });
  it("an empty call isn't qualified", () => {
    const r = mockCallReview({ account: "A", offer: "B", buyer: null, checklist: [...QUALIFICATION], transcript: "We talked about the weather for a while and then said goodbye to each other." });
    expect(r.recommendedStatus).not.toBe("QUALIFIED");
    expect(qualificationScore(r.qualification)).toBe(0);
  });
  it("the prep covers the whole checklist and asks for a next step", () => {
    const p = mockCallPrep({ account: { name: "Grinnell Mutual", industry: "Insurance", size: "501-1000 employees", location: null, description: null }, buyer: { name: "Kevin Kies", title: "VP" }, signals: [{ type: "leadership", title: "New CIO", when: "6 months ago" }], offer: { ...offer, price: "$10,000", targetTitles: ["CIO"] }, brief: { whyNow: null, angle: null } });
    expect(p.listenFor.map((l) => l.key)).toEqual(QUALIFICATION.map((q) => q.key));
    expect(p.questions.length).toBeGreaterThanOrEqual(6);
    expect(p.questions[2]!.question).toMatch(/new leadership/);
    expect(JSON.stringify(p)).not.toMatch(/—/);
  });
});

describe("proposal draft", () => {
  it("uses the offer's price and the buyer's words, and never invents a price", () => {
    const p = mockProposal({ account: { name: "Grinnell Mutual", industry: "Insurance", size: null }, buyer: null, whyNow: "Grinnell Mutual is actively researching Legacy system modernization.", offer: { ...offer, price: "$10,000", salesCycleDays: 30 }, calls: [{ title: "Discovery", summary: "", pains: ["It takes us three days to close a simple claim."], nextSteps: [] }] });
    expect(p.investment.price).toBe("$10,000");
    expect(p.situation).toMatch(/three days to close a simple claim/);
    // The buyer reads the proposal: our internal research never shows up in it.
    expect(JSON.stringify(p)).not.toMatch(/research/i);
    expect(p.phases.map((x) => x.name)).toEqual(["Discover", "Design and price"]);
    const none = mockProposal({ account: { name: "X", industry: null, size: null }, buyer: null, whyNow: null, offer: { ...offer, price: null, salesCycleDays: null }, calls: [] });
    expect(none.investment.price).toBe("To be confirmed");
    expect(proposalText(p)).toMatch(/Where you are[\s\S]*How we'll do it[\s\S]*Investment: \$10,000/);
  });
});

describe("win analysis", () => {
  const deal = (name: string, k: number, industry: string, employees: number, titles: string[], created: string, closed: string, description: string | null = null) => ({ id: name, name, amountCents: k * 100_000, createdAt: created, closedAt: closed, description, dealType: null, source: null, company: { name, domain: null, industry, employees, revenueCents: null, state: null, country: null }, buyerTitles: titles });
  const deals = [
    deal("A: legacy dispatch rebuild", 80, "LOGISTICS_AND_SUPPLY_CHAIN", 400, ["COO", "IT Director"], "2026-01-01", "2026-03-02"),
    deal("B: AI readiness review", 20, "HOSPITAL_HEALTH_CARE", 900, ["CIO", "Chief Information Officer"], "2026-02-01", "2026-02-21"),
    deal("C: claims modernization", 120, "INSURANCE", 700, ["VP Operations"], "2026-01-10", "2026-04-10"),
  ];
  it("computes the hard numbers", () => {
    const s = winStats(deals);
    expect(s.deals).toBe(3);
    expect(s.totalCents).toBe(22_000_000);
    expect(s.medianCents).toBe(8_000_000);
    expect(s.medianCycleDays).toBe(60);
    expect(s.titles.find((t) => t.title === "IT / Technology")!.deals).toBe(2); // counted once per deal
    expect(s.industries[0]!.name).toMatch(/logistics|hospital|insurance/);
  });
  it("groups titles by function", () => {
    expect(titleFunction("VP of Operations")).toBe("Operations");
    expect(titleFunction("Chief Information Officer")).toBe("IT / Technology");
    expect(titleFunction("President & CEO")).toBe("CEO / President");
    expect(titleFunction("Controller")).toBe("Finance");
  });
  it("maps wins to offers by what was bought", () => {
    const f = mockWinFindings({ stats: "", deals: [], offers: [{ slug: "modernization-blueprint", name: "Modernization Blueprint", promise: "" }, { slug: "agentready-diagnostic", name: "AgentReady Diagnostic", promise: "" }], raw: deals.map((d) => ({ name: d.name, description: d.description })) });
    expect(Object.fromEntries(f.winsByOffer.map((w) => [w.offerSlug, w.wins]))).toEqual({ "modernization-blueprint": 2, "agentready-diagnostic": 1 });
  });
});

describe("the HubSpot note carries the follow-up plan", () => {
  it("lists each email with its day", () => {
    const steps = [
      { step: 1, day: 0, purpose: "Opener", subject: "Hello", body: "Hi Kevin, one." },
      { step: 2, day: 3, purpose: "New angle", subject: "A quick question", body: "Hi Kevin, two." },
    ];
    const ctx = buildHubSpotContext({ account: { name: "A", domain: "a.com", industry: null, employeesRange: null, revenueRange: null, location: null, description: null, technologies: [], source: "vibe" }, best: null, others: [], signals: [], contacts: [], owner: null, sequence: steps });
    expect(ctx.html).toContain("Follow-up plan");
    expect(ctx.html).toContain("Day 3, New angle</strong>: \"A quick question\"");
    expect(ctx.taskBody).toContain("First email (send today)");
  });
});

describe("who owns it after a push (Zach's rule: take it over unless someone is working it)", async () => {
  const { decideOwnership } = await import("@/lib/ownership");
  const base = { ownerId: "ash", pushedOwnerId: null, currentOwnerActive: true, takeOver: true, allowOtherOwner: false };
  it("takes over a lead someone else owns, and records who had it", () => {
    expect(decideOwnership({ ...base, existing: { ownerId: "rahul", lifecycle: "lead", openDeals: 0 } })).toEqual({ action: "assign", replaceOwnerId: "rahul", takenFrom: "rahul" });
  });
  it("never takes an open deal or a customer without push anyway, which keeps their owner", () => {
    expect(decideOwnership({ ...base, existing: { ownerId: "vijay", lifecycle: "opportunity", openDeals: 1 } })).toMatchObject({ action: "stop", reason: "has an open deal" });
    expect(decideOwnership({ ...base, existing: { ownerId: "vijay", lifecycle: "customer", openDeals: 0 } })).toMatchObject({ action: "stop", reason: "is a customer" });
    expect(decideOwnership({ ...base, allowOtherOwner: true, existing: { ownerId: "vijay", lifecycle: "customer", openDeals: 0 } })).toMatchObject({ action: "keep" });
  });
  it("new companies, our own earlier pushes and owners who left are simply assigned", () => {
    expect(decideOwnership({ ...base, existing: null })).toMatchObject({ action: "assign", takenFrom: null });
    expect(decideOwnership({ ...base, pushedOwnerId: "zach", existing: { ownerId: "zach", lifecycle: "lead", openDeals: 0 } })).toMatchObject({ action: "assign", replaceOwnerId: "zach", takenFrom: null });
    expect(decideOwnership({ ...base, takeOver: false, currentOwnerActive: false, existing: { ownerId: "dick", lifecycle: "lead", openDeals: 0 } })).toMatchObject({ action: "assign" });
  });
  it("with take-over switched off, someone else's lead is left alone", () => {
    expect(decideOwnership({ ...base, takeOver: false, existing: { ownerId: "rahul", lifecycle: "lead", openDeals: 0 } })).toMatchObject({ action: "stop" });
  });
});

describe("sent batches and follow-through", async () => {
  const { batchName, followUpFrom } = await import("@/server/crm");
  const at = new Date("2026-10-22T15:00:00Z");
  it("names a batch by day and who got what", () => {
    expect(batchName([{ name: "A", seller: "Ashkan Eskandari" }, { name: "B", seller: "Ashkan Eskandari" }, { name: "C", seller: "Mike Hammerslag" }], at)).toBe("Oct 22 · 2 to Ashkan, 1 to Mike");
    expect(batchName([{ name: "Elmington", seller: "Mike Hammerslag" }], at)).toBe("Oct 22 · Elmington to Mike");
  });
  it("counts only what happened after the handoff, and flags overdue tasks", () => {
    const f = followUpFrom(
      { tasks: [{ id: "1", status: "COMPLETED", dueAt: "2026-10-17T00:00:00Z" }, { id: "2", status: "NOT_STARTED", dueAt: "2026-10-19T00:00:00Z" }, { id: "3", status: "NOT_STARTED", dueAt: "2026-10-30T00:00:00Z" }], emails: 18, calls: 1, meetings: 0, deals: 0, openDeals: 0, stage: "lead", ownerId: "ash", lastActivityAt: null },
      { emails: 16, calls: 0, meetings: 0, deals: 0 },
      at,
    );
    expect(f).toMatchObject({ tasksDone: 1, tasksTotal: 3, overdue: 1, emails: 2, calls: 1 });
  });
});
