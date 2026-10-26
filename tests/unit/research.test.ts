import { describe, expect, it } from "vitest";
import { bestResearch, bucketFor, detectResearch, emailFor, groupResearchRows, parseDecisionMakers, placeOf, researchEmployees, researchOf, researchTier, signalTypeOf } from "@/lib/research";
import { buildHubSpotContext } from "@/lib/hubspotContext";

// Three of the research agents' layouts, trimmed to the columns that matter.
const MARKETING = ["report_date", "agent", "account", "account_key", "official_website", "hq", "industry", "employees", "signal_date", "signal", "signal_source_url", "decision_makers", "public_business_contact_route", "personalized_outreach_hook", "proposed_30_day_audit_or_pilot", "abm_score", "intent_score_0_100", "abm_tier", "qualification_caveat", "estimated_service_fee_usd"];
const TRANSFORMATION = ["report_date", "account", "official_website", "hq", "industry", "signal_date", "signal", "signal_source", "decision_makers", "decision_maker_roles", "public_business_contact", "outreach_hook", "paid_discovery_or_pilot", "abm_score_100", "abm_tier", "dedupe_key"];
const PLATFORMS = ["report_date", "account", "official_website", "hq", "signal_date", "verified_signal", "signal_source_url", "verified_decision_makers", "public_business_contact_path", "personalized_ABM_outreach_hook", "proposed_paid_discovery_or_pilot", "abm_score", "abm_tier", "known_incumbent_or_partner"];

const row = (headers: string[], v: Record<string, string>) => headers.map((h) => v[h] ?? "");

describe("research sheets", () => {
  it("recognises research layouts and not plain lead lists", () => {
    expect(detectResearch(MARKETING)).not.toBeNull();
    expect(detectResearch(TRANSFORMATION)).not.toBeNull();
    expect(detectResearch(PLATFORMS)!.signal).toEqual([5]);
    expect(detectResearch(["Company", "Website", "Name", "Email"])).toBeNull();
  });

  it("splits decision-makers in every format, ignoring source notes", () => {
    expect(parseDecisionMakers("Sam Lowe — Co-founder & CEO; Amy Martin — CMO")).toEqual([
      { firstName: "Sam", lastName: "Lowe", title: "Co-founder & CEO" },
      { firstName: "Amy", lastName: "Martin", title: "CMO" },
    ]);
    expect(parseDecisionMakers("Mel Hudson-Kerr (CTO); Tyson Hale (COO, oversees enterprise operations and technology)")).toEqual([
      { firstName: "Mel", lastName: "Hudson-Kerr", title: "CTO" },
      { firstName: "Tyson", lastName: "Hale", title: "COO" },
    ]);
    expect(parseDecisionMakers("Laurie Grant — SVP Marketing (reported 2024; reverify current)")).toEqual([{ firstName: "Laurie", lastName: "Grant", title: "SVP Marketing" }]);
    expect(parseDecisionMakers("Jae Moreno; Darrell Price", "Chief Digital & Information Officer; CFO").map((p) => p.title)).toEqual(["Chief Digital & Information Officer", "CFO"]);
    expect(parseDecisionMakers("Not publicly verified")).toEqual([]);
  });

  it("gives a published email only to the person it belongs to", () => {
    const route = "amartin@summit-services.example (published CMO business contact); info@summit-services.example";
    expect(emailFor({ firstName: "Amy", lastName: "Martin" }, route)).toBe("amartin@summit-services.example");
    expect(emailFor({ firstName: "Sean", lastName: "Kennedy" }, route)).toBeNull();
  });

  it("reads headcount without picking up years, and places from HQ", () => {
    expect(researchEmployees("~3,900 parent employees reported Jun 2025")).toBe(3900);
    expect(researchEmployees("300+ (reported Sep 2026)")).toBe(300);
    expect(researchEmployees("Not publicly verified")).toBeNull();
    expect(placeOf("Mountain View, CA")).toEqual({ city: "Mountain View", state: "CA" });
    expect(placeOf("Michigan (HQ unverified)")).toEqual({ city: null, state: "Michigan" });
  });

  it("classifies the signal", () => {
    expect(signalTypeOf("Named Stephanie Cho CMO and launched Move Care Forward")).toBe("leadership");
    expect(signalTypeOf("Acquired Newport Systems to unify maintenance")).toBe("news");
    expect(signalTypeOf("Closed $320M growth financing for enterprise GTM")).toBe("funding");
    expect(signalTypeOf("Selected Duck Creek Clarity ahead of go-live")).toBe("news");
  });

  it("turns rows into companies with research, people and signals; holds rows without a website", () => {
    const m = detectResearch(TRANSFORMATION)!;
    const rows = [
      row(TRANSFORMATION, { report_date: "2026-10-22", account: "Lakeshore General", official_website: "https://www.lakeshoregeneral.example/", hq: "Middleburg Heights, OH", signal_date: "2026-10-21", signal: "Expanded Oracle platform", signal_source: "https://oracle.com/x", decision_makers: "Jae Moreno; Darrell Price", decision_maker_roles: "CIO; CFO", outreach_hook: "What exceptions remain?", paid_discovery_or_pilot: "4-week pilot", abm_score_100: "94", abm_tier: "A", dedupe_key: "lakeshoregeneral.example" }),
      row(TRANSFORMATION, { report_date: "2026-10-23", account: "Lakeshore General", official_website: "lakeshoregeneral.example", signal_date: "2026-10-23", signal: "Named new CFO", abm_score_100: "95", abm_tier: "A" }),
      row(TRANSFORMATION, { account: "Harbor Health", signal: "Ensemble partnership", signal_date: "2026-03-11", abm_tier: "A", dedupe_key: "stamford health" }),
      row(TRANSFORMATION, { account: "Brightline", signal: "x", abm_tier: "B", public_business_contact: "Contact via https://www.brightline.example/contact" }),
    ];
    const { companies, skipped } = groupResearchRows(rows, m);
    expect(companies.map((c) => c.domain)).toEqual(["lakeshoregeneral.example", "brightline.example"]);
    const sw = companies[0]!;
    expect(sw.signals.map((s) => s.title)).toEqual(["Expanded Oracle platform", "Named new CFO"]);
    expect(sw.research.score).toBe(95); // the newest research wins
    expect(sw.people.map((p) => `${p.firstName} ${p.lastName}, ${p.title}`)).toEqual(["Jae Moreno, CIO", "Darrell Price, CFO"]);
    expect([sw.city, sw.state]).toEqual(["Middleburg Heights", "OH"]);
    expect(skipped).toEqual([expect.objectContaining({ row: 4, company: "Harbor Health", needsWebsite: true })]);
  });

  it("formats the price from the fee column or the pilot text", () => {
    const m = detectResearch(MARKETING)!;
    const r = researchOf(row(MARKETING, { account: "TRG", signal: "x", abm_tier: "A", estimated_service_fee_usd: "15000-35000 (Taazaa proposal, not customer budget)" }), m);
    expect(r.price).toBe("$15K to $35K");
    const p = researchOf(row(PLATFORMS, { account: "Keller", verified_signal: "x", abm_tier: "A", proposed_paid_discovery_or_pilot: "4-week $40k discovery; optional $90k 8-week pilot." }), detectResearch(PLATFORMS)!);
    expect(p.price).toBe("$40K + $90K");
  });

  it("files a sheet into its bucket from the agent column or file name", () => {
    const buckets = [
      { id: "t", slug: "ai-transformation", name: "AI Transformation", keywords: ["transformation"] },
      { id: "p", slug: "ai-operating-platforms", name: "AI Operating Platforms", keywords: ["operating platforms"] },
      { id: "d", slug: "data-engineering", name: "Data & Engineering for AI Readiness", keywords: ["data engineering"] },
      { id: "m", slug: "ai-marketing-studio", name: "AI Marketing Studio", keywords: ["marketing studio"] },
    ];
    expect(bucketFor("Taazaa_AI_Transformation_ABM_2026-10-22.csv", null, buckets)?.slug).toBe("ai-transformation");
    expect(bucketFor("Taazaa_AI_Operating_Platforms_ABM_2026-10-23.csv", null, buckets)?.slug).toBe("ai-operating-platforms");
    expect(bucketFor("Taazaa_Data_Engineering_ABM_2026-10-23.csv", "Data & Engineering for AI Readiness", buckets)?.slug).toBe("data-engineering");
    expect(bucketFor("export.csv", "AI Marketing Studio", buckets)?.slug).toBe("ai-marketing-studio");
    expect(bucketFor("leads.csv", null, buckets)).toBeNull();
  });

  it("reads the researcher's tier as a floor: A recent is act now, B good fit, C watch", () => {
    const now = new Date("2026-10-23");
    const e = (tier: "A" | "B" | "C", date: string) => researchOf(row(TRANSFORMATION, { account: "X", signal: "s", signal_date: date, abm_tier: tier }), detectResearch(TRANSFORMATION)!);
    expect(researchTier(e("A", "2026-09-01"), now)).toBe("act_now");
    expect(researchTier(e("A", "2025-10-01"), now)).toBe("good_fit");
    expect(researchTier(e("B", "2026-10-01"), now)).toBe("good_fit");
    expect(researchTier(e("C", "2026-10-01"), now)).toBe("watch");
    expect(bestResearch({ a: e("B", "2026-10-01"), b: e("A", "2026-10-01") }, now)?.entry.tier).toBe("A");
  });

  it("puts the research into the HubSpot note and fields when there's no approved offer", () => {
    const entry = researchOf(row(MARKETING, { account: "TRG", signal: "Four acquisitions in 3 months", signal_date: "2026-10-14", signal_source_url: "https://trg.example/news", personalized_outreach_hook: "Unify cross-sell messaging.", proposed_30_day_audit_or_pilot: "30-day GTM audit + pilot", abm_score: "91", abm_tier: "A", qualification_caveat: "No public agency search" }), detectResearch(MARKETING)!);
    const ctx = buildHubSpotContext({ account: { name: "TRG", domain: "trg.example", industry: null, employeesRange: null, revenueRange: null, location: null, description: null, technologies: [], source: "research" }, best: null, others: [], signals: [], contacts: [], owner: "Ash", tier: "act_now", research: [{ bucket: "AI Marketing Studio", entry }] });
    expect(ctx.html).toContain("The research: AI Marketing Studio, tier A (91 of 100)");
    expect(ctx.html).toContain("Suggested opening");
    expect(ctx.html).toContain("Watch out");
    expect(ctx.props).toMatchObject({ taazaa_bucket: "AI Marketing Studio", taazaa_tier: "Act now", taazaa_why_now: "Four acquisitions in 3 months (2026-10-14)" });
    expect(ctx.taskSubject).toBe("Reach out to TRG: AI Marketing Studio");
    expect(ctx.taskBody).toContain("Suggested opening: Unify cross-sell messaging.");
  });
});
