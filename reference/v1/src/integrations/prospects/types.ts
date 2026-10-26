// Prospect data: find companies that look like our buyers, enrich them, read their hiring and news,
// and find the people to contact. Apollo is the first live source; Vibe Prospecting can be a second.

export type ProspectFilters = {
  /** Plain industry words, matched as company keywords by the source. */
  industries: string[];
  employeeMin?: number | null;
  employeeMax?: number | null;
  revenueMinCents?: number | null;
  revenueMaxCents?: number | null;
  /** Headquarters locations: cities, states or countries. */
  locations: string[];
  /** Extra company keywords. */
  keywords: string[];
  /** Only companies currently hiring for any of these titles (a buying signal used as a filter). */
  hiringTitles: string[];
  /** Only companies using any of these technologies. */
  technologies: string[];
  /** Buyer titles to look for at each company. */
  titles: string[];
  excludeDomains: string[];
};

export const emptyFilters = (): ProspectFilters => ({ industries: [], locations: [], keywords: [], hiringTitles: [], technologies: [], titles: [], excludeDomains: [] });

export type ProspectCompany = { externalId: string; name: string; domain: string; websiteUrl?: string | null; linkedinUrl?: string | null; foundedYear?: number | null };

export type FundingEvent = { id: string; date: string; type: string | null; amountCents: number | null; url: string | null };

export type CompanyDetail = ProspectCompany & {
  industry: string | null;
  employees: number | null;
  revenueCents: number | null;
  city: string | null;
  state: string | null;
  country: string | null;
  description: string | null;
  technologies: string[];
  keywords: string[];
  headcountGrowth6m: number | null; // decimal
  funding: FundingEvent[];
};

export type JobPosting = { id: string; title: string; url: string | null; postedAt: string; location: string | null };
export type NewsItem = { id: string; title: string; url: string | null; snippet: string | null; publishedAt: string; categories: string[]; orgIds: string[] };
export type ProspectPerson = { externalId: string; firstName: string; lastName: string | null; title: string | null; seniority: string | null; linkedinUrl: string | null; hasEmail: boolean };

export type Paid<T> = T & { credits: number };

export interface ProspectAdapter {
  readonly provider: "apollo" | "mock";
  readonly mode: "mock" | "live";
  /** Credits a pull of up to n companies would spend at most (search pages + enrichment + jobs + news). */
  estimateCredits(n: number): number;
  searchCompanies(f: ProspectFilters, max: number): Promise<Paid<{ companies: ProspectCompany[]; total: number }>>;
  enrichCompany(c: { externalId: string; domain: string }): Promise<Paid<{ detail: CompanyDetail | null }>>;
  jobPostings(externalId: string, domain: string): Promise<Paid<{ jobs: JobPosting[] }>>;
  news(orgs: { externalId: string; domain: string }[], sinceIso: string): Promise<Paid<{ items: NewsItem[] }>>;
  searchPeople(org: { externalId: string; domain: string }, titles: string[]): Promise<Paid<{ people: ProspectPerson[] }>>;
  revealEmail(p: { externalId: string; firstName: string; lastName: string | null; domain: string }): Promise<Paid<{ email: string | null; status: string | null }>>;
}
