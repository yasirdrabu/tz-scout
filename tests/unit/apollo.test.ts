// The live Apollo adapter against a stubbed fetch: request shape (endpoint, header, query params)
// and response parsing, so the live path is checked before a key exists.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApolloAdapter } from "@/integrations/prospects/apollo";
import { emptyFilters } from "@/integrations/prospects/types";

type Call = { url: URL; init: RequestInit };
let calls: Call[] = [];

function stub(responses: Record<string, unknown>, status = 200) {
  calls = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    const url = new URL(input);
    calls.push({ url, init });
    const key = Object.keys(responses).find((k) => url.pathname.endsWith(k));
    return new Response(JSON.stringify(key ? responses[key] : {}), { status, headers: { "content-type": "application/json" } });
  });
}

beforeEach(() => {
  process.env.APOLLO_API_KEY = "test-key";
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.APOLLO_API_KEY;
});

describe("Apollo adapter", () => {
  it("searches companies with Apollo's parameter names and the key header", async () => {
    stub({ "/mixed_companies/search": { organizations: [{ id: "o1", name: "Northgate Freight", primary_domain: "northgate-freight.com" }, { id: "o2", name: "No Domain" }], pagination: { total_entries: 2 } } });
    const a = createApolloAdapter();
    const r = await a.searchCompanies({ ...emptyFilters(), industries: ["Logistics"], employeeMin: 100, employeeMax: 2500, revenueMinCents: 5_000_000_000, locations: ["United States"], hiringTitles: ["Microsoft Access Developer"], technologies: ["Microsoft Access"] }, 25);
    expect(r.companies).toEqual([{ externalId: "o1", name: "Northgate Freight", domain: "northgate-freight.com", websiteUrl: null, linkedinUrl: null, foundedYear: null }]);
    expect(r.credits).toBe(1);
    const c = calls[0]!;
    expect(c.url.origin + c.url.pathname).toBe("https://api.apollo.io/api/v1/mixed_companies/search");
    expect(c.init.method).toBe("POST");
    expect((c.init.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
    const q = c.url.searchParams;
    expect(q.getAll("organization_num_employees_ranges[]")).toEqual(["100,2500"]);
    expect(q.get("revenue_range[min]")).toBe("50000000");
    expect(q.getAll("organization_locations[]")).toEqual(["United States"]);
    expect(q.getAll("organization_industries[]")).toEqual(["logistics & supply chain", "transportation/trucking/railroad", "package/freight delivery", "warehousing"]);
    expect(q.getAll("q_organization_keyword_tags[]")).toEqual([]);
    expect(q.getAll("q_organization_job_titles[]")).toEqual(["Microsoft Access Developer"]);
    expect(q.getAll("currently_using_any_of_technology_uids[]")).toEqual(["microsoft_access"]);
    expect(q.get("per_page")).toBe("25");
  });

  it("parses enrichment into firmographics, tech and funding", async () => {
    stub({
      "/organizations/enrich": {
        organization: {
          id: "o1", name: "Northgate Freight", primary_domain: "northgate-freight.com", industry: "transportation/trucking/railroad", estimated_num_employees: 420, annual_revenue: 95000000,
          city: "Columbus", state: "Ohio", country: "United States", technology_names: ["Microsoft Access", "QuickBooks"], organization_headcount_six_month_growth: 0.12,
          funding_events: [{ id: "f1", date: "2026-05-01", type: "Private equity", amount: "20000000", news_url: "https://x" }],
        },
      },
    });
    const r = await createApolloAdapter().enrichCompany({ externalId: "o1", domain: "northgate-freight.com" });
    expect(calls[0]!.url.searchParams.get("domain")).toBe("northgate-freight.com");
    expect(r.detail).toMatchObject({ employees: 420, revenueCents: 9_500_000_000, technologies: ["Microsoft Access", "QuickBooks"], headcountGrowth6m: 0.12, city: "Columbus" });
    expect(r.detail!.funding[0]).toMatchObject({ amountCents: 2_000_000_000, type: "Private equity" });
  });

  it("reads job postings and news", async () => {
    stub({
      "/job_postings": { organization_job_postings: [{ id: "j1", title: "Microsoft Access Developer", url: "https://jobs", city: "Columbus", state: "Ohio", country: "United States", posted_at: "2026-10-01T00:00:00Z" }] },
      "/news_articles/search": { news_articles: [{ id: "n1", title: "Northgate names new COO", published_at: "2026-09-20", event_categories: ["hires"], organization_ids: ["o1"] }] },
    });
    const a = createApolloAdapter();
    const j = await a.jobPostings("o1", "northgate-freight.com");
    expect(calls[0]!.url.pathname).toBe("/api/v1/organizations/o1/job_postings");
    expect(j.jobs[0]).toMatchObject({ title: "Microsoft Access Developer", location: "Columbus, Ohio, United States" });
    const n = await a.news([{ externalId: "o1", domain: "x" }], "2026-04-01T00:00:00Z");
    expect(calls[1]!.url.searchParams.getAll("organization_ids[]")).toEqual(["o1"]);
    expect(calls[1]!.url.searchParams.get("published_at[min]")).toBe("2026-04-01");
    expect(n.items[0]).toMatchObject({ title: "Northgate names new COO", orgIds: ["o1"], categories: ["hires"] });
  });

  it("people search filters to buyer seniorities and costs nothing", async () => {
    stub({ "/mixed_people/api_search": { people: [{ id: "p1", first_name: "Lee", last_name_obfuscated: "O***r", title: "VP Operations", has_email: true }] } });
    const r = await createApolloAdapter().searchPeople({ externalId: "o1", domain: "x" }, ["VP Operations"]);
    expect(r.credits).toBe(0);
    expect(r.people[0]).toMatchObject({ firstName: "Lee", lastName: "O***r", title: "VP Operations" });
    expect(calls[0]!.url.searchParams.getAll("person_seniorities[]")).toContain("c_suite");
  });

  it("turns a rejected key into a not connected error", async () => {
    stub({}, 401);
    await expect(createApolloAdapter().enrichCompany({ externalId: "o1", domain: "x.com" })).rejects.toThrow(/not connected/);
  });

  it("recognises an out-of-credits answer", async () => {
    calls = [];
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "You have insufficient credits! <a href='x'>Upgrade your plan</a>" }), { status: 422 }));
    await expect(createApolloAdapter().enrichCompany({ externalId: "o1", domain: "x.com" })).rejects.toThrow(/out of API credits/);
  });

  it("refuses to call without a key", async () => {
    delete process.env.APOLLO_API_KEY;
    await expect(createApolloAdapter().searchCompanies(emptyFilters(), 5)).rejects.toThrow(/APOLLO_API_KEY/);
  });

  it("estimates credits: search page + enrich + jobs per company + news pages", () => {
    expect(createApolloAdapter().estimateCredits(25)).toBe(1 + 25 + 25 + 1);
  });
});
