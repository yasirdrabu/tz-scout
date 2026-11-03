import { z } from 'zod';
import { RateLimitedError, type LiveCredentials, type TestResult } from '@/modules/integrations';
import type { CompanyFacts, EmailStatus, EnrichmentAdapter, Person, Signal } from '../../contracts/adapter';
import { OutOfCreditsError, ProviderError, cantDo, retryAfterMs } from '../errors';

// Live Apollo, ported from v1 `apollo.ts`. Endpoints and parameter names per docs.apollo.io (checked Oct 2026):
//   GET  /organizations/enrich            1 credit per company
//   GET  /organizations/{id}/job_postings 1 credit per page
//   POST /news_articles/search            1 credit per page of up to 25
//   POST /mixed_people/api_search         0 credits, no emails
//   POST /people/match                    1 credit when it reveals an email
// Apollo documents parameters as query parameters even on POST, so everything goes in the query string.
// The key comes only from `LiveCredentials`; this file reads no environment variables.

const BASE = 'https://api.apollo.io/api/v1';
const TIMEOUT_MS = 30_000;
const PROVIDER = 'Apollo';
const BUYER_SENIORITIES = ['owner', 'founder', 'c_suite', 'partner', 'vp', 'head', 'director'];
/** How far back news is read. */
const NEWS_DAYS = 180;

export const KEY_REJECTED = 'Apollo rejected the key. An owner needs to update it in Integrations.';
export const MASTER_KEY_NEEDED = "Apollo says this key can't use that endpoint. People search needs a master API key.";

type Params = Record<string, string | number | boolean | (string | number)[] | null | undefined>;

function query(params: Params): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue;
    if (Array.isArray(v)) for (const x of v) q.append(k.endsWith('[]') ? k : `${k}[]`, String(x));
    else q.append(k, String(v));
  }
  return q.toString();
}

// Response shapes. Everything Apollo sends is parsed before use.
const s = z.string().nullish();
const orgSchema = z.object({
  id: z.string(),
  name: z.string(),
  primary_domain: s,
  website_url: s,
  linkedin_url: s,
  industry: s,
  estimated_num_employees: z.number().nullish(),
  annual_revenue: z.number().nullish(),
  city: s,
  state: s,
  country: s,
  short_description: s,
  technology_names: z.array(z.string()).nullish(),
  keywords: z.array(z.string()).nullish(),
});
const enrichSchema = z.object({ organization: orgSchema.nullish() });
const jobsSchema = z.object({
  organization_job_postings: z
    .array(z.object({ id: z.string(), title: z.string(), url: s, city: s, state: s, country: s, posted_at: s, last_seen_at: s }))
    .nullish(),
});
const newsSchema = z.object({
  news_articles: z
    .array(z.object({ id: z.string(), title: z.string(), url: s, snippet: s, published_at: z.string(), event_categories: z.array(z.string()).nullish() }))
    .nullish(),
});
const searchSchema = z.object({
  people: z.array(z.object({ id: z.string(), first_name: z.string(), last_name_obfuscated: s, title: s, seniority: s })).nullish(),
});
const matchSchema = z.object({
  person: z
    .object({ id: z.string(), first_name: s, last_name: s, name: s, title: s, email: s, email_status: s, seniority: s, linkedin_url: s })
    .nullish(),
});

const domainOf = (o: { primary_domain?: string | null; website_url?: string | null }) =>
  (o.primary_domain || (o.website_url ?? '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] || '').toLowerCase();

const day = (iso: string | null | undefined) => (iso ?? new Date().toISOString()).slice(0, 10);

/** Apollo's email statuses as the accounts fact values. */
function emailStatusOf(email: string | null | undefined, status: string | null | undefined): EmailStatus {
  if (!email) return 'unavailable';
  if (status === 'verified') return 'verified';
  if (status === 'bounced') return 'bounced';
  return 'guessed';
}

/** Apollo's news categories as our signal fine types. */
const newsType = (categories: string[]): string =>
  categories.includes('hires') ? 'leadership' : categories.some((c) => /investment|funding/.test(c)) ? 'funding' : 'news';

const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export function apolloLive(creds: LiveCredentials, fetchImpl: typeof fetch = fetch): EnrichmentAdapter {
  async function call<T>(schema: z.ZodType<T>, method: 'GET' | 'POST', path: string, params: Params): Promise<T> {
    const res = await fetchImpl(`${BASE}${path}?${query(params)}`, {
      method,
      headers: { 'x-api-key': creds.value, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) throw new ProviderError(401, KEY_REJECTED);
    if (res.status === 403) throw new ProviderError(403, MASTER_KEY_NEEDED);
    if (res.status === 429) throw new RateLimitedError('Apollo asked us to slow down.', retryAfterMs(res.headers.get('retry-after')));
    if (!res.ok) {
      const body = await res.text();
      if (/insufficient credits/i.test(body)) throw new OutOfCreditsError(PROVIDER, res.status);
      throw new ProviderError(res.status, `Apollo returned ${res.status}: ${body.replace(/<[^>]+>/g, '').trim().slice(0, 200)}`);
    }
    const parsed = schema.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success) throw new ProviderError(502, `Apollo sent an answer Scout could not read (${method} ${path.split('?')[0]}).`);
    return parsed.data;
  }

  async function enrich(domain: string): Promise<CompanyFacts | null> {
    const o = (await call(enrichSchema, 'GET', '/organizations/enrich', { domain })).organization;
    if (!o) return null;
    return {
      name: o.name,
      domain: domainOf(o) || domain,
      website: o.website_url ?? null,
      linkedin_url: o.linkedin_url ?? null,
      industry: o.industry ?? null,
      employees: o.estimated_num_employees ?? null,
      revenue_cents: o.annual_revenue != null ? Math.round(o.annual_revenue * 100) : null,
      city: o.city ?? null,
      region: o.state ?? null,
      country: o.country ?? null,
      description: o.short_description ?? null,
      technologies: o.technology_names ?? [],
      keywords: (o.keywords ?? []).slice(0, 40),
      provider_ref: o.id,
    };
  }

  /** The Apollo organization id: the one given, else looked up by domain for a credit. */
  async function orgIdFor(input: { domain: string; orgId?: string }): Promise<{ id: string | null; credits: number }> {
    if (input.orgId) return { id: input.orgId, credits: 0 };
    return { id: (await enrich(input.domain))?.provider_ref ?? null, credits: 1 };
  }

  return {
    async test(): Promise<TestResult> {
      try {
        await call(enrichSchema, 'GET', '/organizations/enrich', { domain: 'apollo.io' });
        return { ok: true, message: 'Connected to Apollo.' };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : 'The test failed.' };
      }
    },

    async companyEnrich({ domain }) {
      return { value: await enrich(domain), creditsUsed: 1 };
    },

    async peopleSearch({ domain, titles, max }) {
      const perPage = Math.min(100, Math.max(1, max));
      const r = await call(searchSchema, 'POST', '/mixed_people/api_search', {
        'q_organization_domains_list[]': [domain],
        'person_titles[]': titles.slice(0, 50),
        'person_seniorities[]': BUYER_SENIORITIES,
        page: 1,
        per_page: perPage,
      });
      // The search gives a first name and an obfuscated last name; the full person comes from `revealEmail`.
      const people: Person[] = (r.people ?? []).slice(0, perPage).map((p) =>
        defined({ name: p.first_name, first_name: p.first_name, title: p.title ?? undefined, seniority: p.seniority ?? undefined, provider_ref: p.id }),
      );
      return { value: people, creditsUsed: 0 };
    },

    async revealEmail({ person, domain }) {
      const byId = person.provider_ref ? { id: person.provider_ref } : null;
      const r = await call(matchSchema, 'POST', '/people/match', {
        ...(byId ?? {
          name: person.name,
          first_name: person.first_name,
          last_name: person.last_name,
          domain,
          linkedin_url: person.linkedin_url,
          email: person.email,
        }),
        reveal_personal_emails: false,
      });
      const p = r.person;
      if (!p) return { value: { ...person, email_status: emailStatusOf(person.email, null) }, creditsUsed: 0 };
      const name = p.name || [p.first_name, p.last_name].filter(Boolean).join(' ') || person.name;
      const value: Person = defined({
        name,
        first_name: p.first_name ?? person.first_name,
        last_name: p.last_name ?? person.last_name,
        title: p.title ?? person.title,
        email: p.email ?? null,
        email_status: emailStatusOf(p.email, p.email_status),
        seniority: p.seniority ?? person.seniority,
        linkedin_url: p.linkedin_url ?? person.linkedin_url,
        provider_ref: p.id,
      });
      return { value, creditsUsed: p.email ? 1 : 0 };
    },

    async jobPostings(input) {
      const org = await orgIdFor(input);
      if (!org.id) return { value: [], creditsUsed: org.credits };
      const r = await call(jobsSchema, 'GET', `/organizations/${encodeURIComponent(org.id)}/job_postings`, { page: 1, per_page: 50 });
      const value: Signal[] = (r.organization_job_postings ?? []).map((j) =>
        defined({
          type: 'pain' as const,
          fine_type: 'hiring',
          title: `Hiring: ${j.title}`,
          occurred_at: day(j.posted_at ?? j.last_seen_at),
          url: j.url ?? undefined,
          detail: [j.city, j.state, j.country].filter(Boolean).join(', ') || undefined,
        }),
      );
      return { value, creditsUsed: org.credits + 1 };
    },

    async news(input) {
      const org = await orgIdFor(input);
      if (!org.id) return { value: [], creditsUsed: org.credits };
      const since = new Date(Date.now() - NEWS_DAYS * 86400_000).toISOString().slice(0, 10);
      const r = await call(newsSchema, 'POST', '/news_articles/search', { 'organization_ids[]': [org.id], 'published_at[min]': since, page: 1, per_page: 25 });
      const value: Signal[] = (r.news_articles ?? []).map((a) =>
        defined({
          type: 'trigger' as const,
          fine_type: newsType(a.event_categories ?? []),
          title: a.title,
          occurred_at: day(a.published_at),
          url: a.url ?? undefined,
          detail: a.snippet ?? undefined,
        }),
      );
      return { value, creditsUsed: org.credits + 1 };
    },

    async readSite() {
      throw cantDo(PROVIDER);
    },
  };
}
