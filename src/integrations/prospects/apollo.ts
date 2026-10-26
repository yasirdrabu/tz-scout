// Live Apollo adapter. Endpoints and parameter names per docs.apollo.io (checked Oct 2026):
//   POST /mixed_companies/search        1 credit per page of up to 100
//   GET  /organizations/enrich          1 credit per company
//   GET  /organizations/{id}/job_postings 1 credit per page
//   POST /news_articles/search          1 credit per page of up to 25
//   POST /mixed_people/api_search       0 credits, no emails
//   POST /people/match                  1+ credits, reveals the email
// Apollo documents parameters as query parameters even on POST, so everything goes in the query string.

import { NotConnectedError } from "../mode";
import { toApolloIndustries } from "./apolloIndustries";
import type { CompanyDetail, JobPosting, NewsItem, ProspectAdapter, ProspectCompany, ProspectFilters, ProspectPerson } from "./types";

const BASE = "https://api.apollo.io/api/v1";
const BUYER_SENIORITIES = ["owner", "founder", "c_suite", "partner", "vp", "head", "director"];

type Params = Record<string, string | number | boolean | (string | number)[] | null | undefined>;

function query(params: Params): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === "") continue;
    if (Array.isArray(v)) for (const x of v) q.append(k.endsWith("[]") ? k : `${k}[]`, String(x));
    else q.append(k, String(v));
  }
  return q.toString();
}

class ApolloError extends Error {}

/** Apollo has no credits left. A pull stops at the first one rather than failing company by company. */
export class ApolloCreditsError extends Error {
  constructor() {
    super("Apollo is out of API credits. Ask your Apollo admin to add credits or move to a plan with API credits, then run the pull again.");
    this.name = "ApolloCreditsError";
  }
}

async function call<T>(method: "GET" | "POST", path: string, params: Params): Promise<T> {
  const key = process.env.APOLLO_API_KEY;
  if (!key) throw new NotConnectedError("prospects", "set APOLLO_API_KEY");
  const res = await fetch(`${BASE}${path}?${query(params)}`, {
    method,
    headers: { "x-api-key": key, "Content-Type": "application/json", "Cache-Control": "no-cache", accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401) throw new NotConnectedError("prospects", "Apollo rejected the API key");
  if (res.status === 403) throw new ApolloError("Apollo says this key can't use that endpoint. People search needs a master API key.");
  if (res.status === 429) throw new ApolloError("Apollo rate limit reached. Try again in an hour.");
  if (!res.ok) {
    const body = await res.text();
    if (/insufficient credits/i.test(body)) throw new ApolloCreditsError();
    throw new ApolloError(`Apollo returned ${res.status}: ${body.replace(/<[^>]+>/g, "").slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

const domainOf = (o: { primary_domain?: string | null; website_url?: string | null }) =>
  (o.primary_domain || (o.website_url ?? "").replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] || "").toLowerCase();

type ApolloOrg = { id: string; name: string; primary_domain?: string | null; website_url?: string | null; linkedin_url?: string | null; founded_year?: number | null };

export function createApolloAdapter(): ProspectAdapter {
  return {
    provider: "apollo",
    mode: "live",

    estimateCredits(n) {
      // search pages + enrich each + one job page each + news pages (25 orgs per call)
      return Math.ceil(n / 100) + n + n + Math.ceil(n / 25);
    },

    async searchCompanies(f: ProspectFilters, max) {
      const perPage = Math.min(100, Math.max(1, max));
      const out: ProspectCompany[] = [];
      let total = 0;
      let credits = 0;
      // Industries go to Apollo's exact industry filter; anything we can't map stays a keyword.
      const ind = toApolloIndustries(f.industries);
      for (let page = 1; out.length < max && page <= 5; page++) {
        const r = await call<{ organizations?: ApolloOrg[]; accounts?: ApolloOrg[]; pagination?: { total_entries?: number } }>("POST", "/mixed_companies/search", {
          "organization_num_employees_ranges[]": f.employeeMin != null || f.employeeMax != null ? [`${f.employeeMin ?? 1},${f.employeeMax ?? 1000000}`] : undefined,
          "revenue_range[min]": f.revenueMinCents != null ? Math.round(f.revenueMinCents / 100) : undefined,
          "revenue_range[max]": f.revenueMaxCents != null ? Math.round(f.revenueMaxCents / 100) : undefined,
          "organization_locations[]": f.locations,
          "organization_industries[]": ind.mapped,
          "q_organization_keyword_tags[]": [...ind.unmapped, ...f.keywords].map((s) => s.toLowerCase()),
          "q_organization_job_titles[]": f.hiringTitles,
          "currently_using_any_of_technology_uids[]": f.technologies.map((t) => t.toLowerCase().replace(/[ .]/g, "_")),
          "not_organization_websites_list[]": f.excludeDomains,
          page,
          per_page: perPage,
        });
        credits++;
        total = r.pagination?.total_entries ?? total;
        const orgs = [...(r.organizations ?? []), ...(r.accounts ?? [])];
        if (orgs.length === 0) break;
        for (const o of orgs) {
          const domain = domainOf(o);
          if (!domain || out.some((x) => x.domain === domain)) continue;
          out.push({ externalId: o.id, name: o.name, domain, websiteUrl: o.website_url ?? null, linkedinUrl: o.linkedin_url ?? null, foundedYear: o.founded_year ?? null });
          if (out.length >= max) break;
        }
        // A short page means there are no more results; don't spend another credit asking.
        if (orgs.length < perPage || (total && page * perPage >= total)) break;
      }
      return { companies: out, total, credits };
    },

    async enrichCompany(c) {
      type Org = ApolloOrg & {
        industry?: string | null; estimated_num_employees?: number | null; annual_revenue?: number | null; city?: string | null; state?: string | null; country?: string | null;
        short_description?: string | null; technology_names?: string[] | null; keywords?: string[] | null; organization_headcount_six_month_growth?: number | null;
        funding_events?: { id: string; date: string; type?: string | null; amount?: string | number | null; news_url?: string | null }[] | null;
      };
      const r = await call<{ organization?: Org | null }>("GET", "/organizations/enrich", { domain: c.domain });
      const o = r.organization;
      if (!o) return { detail: null, credits: 1 };
      const detail: CompanyDetail = {
        externalId: o.id ?? c.externalId,
        name: o.name,
        domain: domainOf(o) || c.domain,
        websiteUrl: o.website_url ?? null,
        linkedinUrl: o.linkedin_url ?? null,
        foundedYear: o.founded_year ?? null,
        industry: o.industry ?? null,
        employees: o.estimated_num_employees ?? null,
        revenueCents: o.annual_revenue != null ? Math.round(o.annual_revenue * 100) : null,
        city: o.city ?? null,
        state: o.state ?? null,
        country: o.country ?? null,
        description: o.short_description ?? null,
        technologies: o.technology_names ?? [],
        keywords: (o.keywords ?? []).slice(0, 40),
        // Apollo reports growth as a decimal fraction (0.12 = 12%).
        headcountGrowth6m: o.organization_headcount_six_month_growth ?? null,
        funding: (o.funding_events ?? []).map((e) => ({ id: e.id, date: e.date, type: e.type ?? null, amountCents: e.amount != null && !Number.isNaN(Number(e.amount)) ? Math.round(Number(e.amount) * 100) : null, url: e.news_url ?? null })),
      };
      return { detail, credits: 1 };
    },

    async jobPostings(externalId) {
      const r = await call<{ organization_job_postings?: { id: string; title: string; url?: string | null; city?: string | null; state?: string | null; country?: string | null; posted_at?: string | null; last_seen_at?: string | null }[] }>(
        "GET",
        `/organizations/${encodeURIComponent(externalId)}/job_postings`,
        { page: 1, per_page: 50 },
      );
      const jobs: JobPosting[] = (r.organization_job_postings ?? []).map((j) => ({
        id: j.id,
        title: j.title,
        url: j.url ?? null,
        postedAt: j.posted_at ?? j.last_seen_at ?? new Date().toISOString(),
        location: [j.city, j.state, j.country].filter(Boolean).join(", ") || null,
      }));
      return { jobs, credits: 1 };
    },

    async news(orgs, sinceIso) {
      const items: NewsItem[] = [];
      let credits = 0;
      for (let i = 0; i < orgs.length; i += 25) {
        const chunk = orgs.slice(i, i + 25);
        const r = await call<{ news_articles?: { id: string; url?: string | null; title: string; snippet?: string | null; published_at: string; event_categories?: string[] | null; organization_ids?: string[] | null }[] }>("POST", "/news_articles/search", {
          "organization_ids[]": chunk.map((o) => o.externalId),
          "published_at[min]": sinceIso.slice(0, 10),
          page: 1,
          per_page: 25,
        });
        credits++;
        for (const a of r.news_articles ?? []) items.push({ id: a.id, title: a.title, url: a.url ?? null, snippet: a.snippet ?? null, publishedAt: a.published_at, categories: a.event_categories ?? [], orgIds: a.organization_ids ?? [] });
      }
      return { items, credits };
    },

    async searchPeople(org, titles) {
      const r = await call<{ people?: { id: string; first_name: string; last_name_obfuscated?: string | null; title?: string | null; has_email?: boolean }[] }>("POST", "/mixed_people/api_search", {
        "organization_ids[]": [org.externalId],
        "person_titles[]": titles.slice(0, 50),
        "person_seniorities[]": BUYER_SENIORITIES,
        page: 1,
        per_page: 10,
      });
      const people: ProspectPerson[] = (r.people ?? []).map((p) => ({ externalId: p.id, firstName: p.first_name, lastName: p.last_name_obfuscated ?? null, title: p.title ?? null, seniority: null, linkedinUrl: null, hasEmail: Boolean(p.has_email) }));
      return { people, credits: 0 };
    },

    async revealEmail(p) {
      const r = await call<{ person?: { email?: string | null; email_status?: string | null; last_name?: string | null; linkedin_url?: string | null } | null }>("POST", "/people/match", { id: p.externalId, reveal_personal_emails: false });
      return { email: r.person?.email ?? null, status: r.person?.email_status ?? null, credits: r.person?.email ? 1 : 0 };
    },
  };
}
