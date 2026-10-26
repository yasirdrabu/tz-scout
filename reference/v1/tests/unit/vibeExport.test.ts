import { describe, expect, it } from "vitest";
import { fromVibeExportRow, isParty, nameKey } from "@/integrations/prospects/vibeExport";
import { industryFor, mapEvent, topicLabel, vibeSignals } from "@/integrations/prospects/vibe";
import { mockAccountBrief, signalPhrase } from "@/ai/accountBrief";

const NOW = new Date("2026-10-15T12:00:00Z");
const ev = (o: Record<string, unknown>) => JSON.stringify([o]);

const row = {
  business_id: "b1",
  business_name: "Fortegra",
  business_domain: "fortegra.com",
  business_country_name: "united states",
  business_naics: "524",
  business_naics_description: "Insurance Carriers and Related Activities",
  business_number_of_employees_range: "[501-1000]",
  business_yearly_revenue_range: "[200M-500M]",
  business_business_intent_topics: JSON.stringify([{ topic: "machine learning & artificial intelligence: ai usage control (aiuc)", score: 73 }]),
  tech_full_tech_stack: JSON.stringify(["Microsoft Copilot", "Salesforce"]),
  work_trend_perc_operations_roles: "21",
  work_trend_perc_sales_roles: "",
  event_employee_joined_company: JSON.stringify([
    { event_name: "employee_joined_company", job_role_title: "Executive Vice President", full_name: "Pat Lee", job_department: "C-Suite", linkedin_url: "linkedin.com/in/pat", event_time: "2026-06-01T00:00:00+00:00" },
    { event_name: "employee_joined_company", job_role_title: "Claims Adjuster", full_name: "Sam Roe", event_time: "2026-06-01T00:00:00+00:00" },
  ]),
  event_merger_and_acquisitions: JSON.stringify([
    { event_name: "merger_and_acquisitions", title: "Fortegra Joins DB Insurance", description: "DB Insurance completed its acquisition of Fortegra Group Inc.", companies_involved: ["fortegra group", "db insurance"], event_time: "2026-05-01T00:00:00+00:00" },
    { event_name: "merger_and_acquisitions", title: "Bloomberg", description: "Someone else bought someone else.", companies_involved: ["go residential", "h and r reit"], event_time: "2026-08-01T00:00:00+00:00" },
  ]),
  event_lawsuits_and_legal_issues: JSON.stringify([
    { event_name: "lawsuits_and_legal_issues", case_type: "Breach of contract", title: "Property manager sues insurer", event_time: "2026-03-01T00:00:00+00:00" },
    { event_name: "lawsuits_and_legal_issues", case_type: "Murder", title: "DA charges man", event_time: "2026-03-02T00:00:00+00:00" },
  ]),
  event_increase_in_operations_department: JSON.stringify([
    { event_name: "increase_in_operations_department", department_change: 33, event_time: "2026-09-30T00:00:00+00:00" },
    { event_name: "increase_in_operations_department", department_change: 25, event_time: "2017-12-31T00:00:00+00:00" },
  ]),
  event_outages_and_security_breaches: ev({ event_name: "outages_and_security_breaches", incident_type: "unauthorized access", number_of_affected_customers: 3803750, title: "HIPAA Pulse", event_time: "2026-08-19T00:00:00+00:00" }),
  event_new_investment: ev({ event_name: "new_investment", title: "Breaks ground on a new campus", event_time: "2026-01-28T00:00:00+00:00" }),
};

describe("Vibe export rows", () => {
  const c = fromVibeExportRow(row, NOW);
  const sigs = vibeSignals(c, NOW);

  it("reads firmographics, unwrapping ranges", () => {
    expect(c).toMatchObject({ businessId: "b1", domain: "fortegra.com", employeesRange: "501-1000", revenueRange: "200M-500M", techStack: ["Microsoft Copilot", "Salesforce"] });
    expect(c.intent).toEqual([{ topic: "machine learning & artificial intelligence: ai usage control (aiuc)", score: 73 }]);
    expect(c.workforce?.share).toEqual({ operations: 0.21 });
  });
  it("drops events older than a year", () => {
    expect(c.events!.filter((e) => e.type === "increase_in_operations_department")).toHaveLength(1);
  });
  it("keeps M&A only when the company is a party, titled by the headline that names it", () => {
    const ma = sigs.filter((s) => s.title.startsWith("Acquisition"));
    expect(ma.map((s) => s.title)).toEqual(["Acquisition or merger: Fortegra Joins DB Insurance"]);
  });
  it("skips crime stories in the legal feed", () => {
    expect(sigs.filter((s) => s.type === "risk" && s.title.startsWith("Lawsuit")).map((s) => s.title)).toEqual(["Lawsuit: Property manager sues insurer"]);
  });
  it("describes breaches by what happened, not the newsletter headline", () => {
    expect(sigs.find((s) => s.title.startsWith("Security"))?.title).toBe("Security breach or outage: Unauthorized access, 3,803,750 people affected");
  });
  it("counts executive hires only", () => {
    expect(sigs.filter((s) => s.type === "leadership").map((s) => s.title)).toEqual(["New leader joined: Executive Vice President"]);
  });
  it("a company's own investment is news, not funding", () => {
    expect(sigs.some((s) => s.type === "funding")).toBe(false);
    expect(sigs.find((s) => s.title.startsWith("Investing"))?.type).toBe("news");
  });
  it("event ids are stable across imports", () => {
    expect(fromVibeExportRow(row, NOW).events!.map((e) => e.id)).toEqual(c.events!.map((e) => e.id));
  });
});

describe("helpers", () => {
  it("industry from NAICS uses our words", () => {
    expect(industryFor("62", "Health Care and Social Assistance")).toBe("Healthcare services");
    expect(industryFor("622110")).toBe("Healthcare services: hospitals");
    expect(industryFor("493110")).toBe("Logistics: warehousing");
    expect(industryFor("999", "Something else")).toBe("Something else");
  });
  it("name keys ignore legal suffixes", () => {
    expect(nameKey("The Fortegra Group, Inc.")).toBe("fortegra");
    expect(isParty("Sentral", ["bukit jalil sentral property sdn bhd bjsp"])).toBe(false);
    expect(isParty("Kairoi Residential", ["stockdale capital partners", "kairoi residential"])).toBe(true);
  });
  it("topic labels drop vendor shorthand", () => {
    expect(topicLabel("machine learning & artificial intelligence: ai usage control (aiuc)")).toBe("AI usage control");
  });
  it("increase events read as a growing team", () => {
    expect(mapEvent({ type: "increase_in_operations_department", date: "2026-09-30" })?.title).toBe("Operations team growing");
  });
});

describe("brief phrasing for the new signal types", () => {
  it("reads naturally after the company name", () => {
    expect(signalPhrase("Sentral", { type: "intent", title: "Researching: AI risk management" })).toBe("is actively researching AI risk management");
    expect(signalPhrase("X", { type: "hiring", title: "Hiring in operations: director of operations, analyst" })).toBe("is hiring a director of operations in operations");
    expect(signalPhrase("X", { type: "leadership", title: "New leader joined: Chief Technology Officer" })).toBe("just brought on a new Chief Technology Officer");
    expect(signalPhrase("X", { type: "workforce", title: "Operations is 21% of staff" })).toBe("has 21% of its staff in operations");
  });
  it("never quotes research intent or legal trouble in the opener", () => {
    const b = mockAccountBrief({
      account: { name: "Fortegra", industry: "Insurance", employees: 708, revenue: null, location: null, description: null, technologies: [] },
      signals: [
        { type: "intent", title: "Researching: AI usage control", when: "this week" },
        { type: "risk", title: "Lawsuit: Property manager sues insurer", when: "March" },
        { type: "leadership", title: "New leader joined: Executive Vice President", when: "June" },
      ],
      offer: { name: "AgentReady Diagnostic", promise: "x", targetTitles: ["CIO"], proof: [] },
      segment: null,
      winners: [],
      contacts: [],
    });
    expect(b.whyNow).toMatch(/actively researching AI usage control/);
    expect(b.opener).toMatch(/just brought on a new Executive Vice President/);
    expect(b.opener).not.toMatch(/research|lawsuit/i);
  });
});

describe("people from a Vibe prospects export", () => {
  it("maps names, title, email and its status, and the LinkedIn link", async () => {
    const { fromVibeProspectRow, seniority } = await import("@/integrations/prospects/vibeExport");
    const p = fromVibeProspectRow({ prospect_id: "p1", business_id: "b1", prospect_first_name: "Priya", prospect_last_name: "Raman", prospect_job_title: "chief digital and information officer", contact_professional_email: "PRaman@lakeview-health.example", contact_professional_email_status: "valid", prospect_linkedin: "linkedin.com/in/x" });
    expect(p).toEqual({ prospectId: "p1", businessId: "b1", firstName: "Priya", lastName: "Raman", title: "Chief digital and information officer", email: "praman@lakeview-health.example", emailStatus: "valid", phone: null, linkedin: "https://linkedin.com/in/x" });
    expect(fromVibeProspectRow({ business_id: "b1" })).toBeNull();
    expect(seniority("Chief digital and information officer")).toBeGreaterThan(seniority("Vice president quality"));
    expect(seniority("Vice president quality")).toBeGreaterThan(seniority("Director, implementation"));
  });
});

describe("names Vibe splits badly", () => {
  it("reads the name from the full name when first and last look wrong", async () => {
    const { fromVibeProspectRow } = await import("@/integrations/prospects/vibeExport");
    const p = fromVibeProspectRow({ prospect_id: "p", business_id: "b", prospect_first_name: "Romito", prospect_last_name: "Romito, Chcio, Cdh-e, Misst", prospect_full_name: "Ed Romito, Chcio, Cdh-e, Misst" });
    expect([p!.firstName, p!.lastName]).toEqual(["Ed", "Romito"]);
    const ok = fromVibeProspectRow({ prospect_id: "p", business_id: "b", prospect_first_name: "Christi", prospect_last_name: "Barney", prospect_full_name: "Christi Barney" });
    expect([ok!.firstName, ok!.lastName]).toEqual(["Christi", "Barney"]);
  });
});
