// The live Apollo adapter against a stubbed fetch, with v1's fixtures: request shape (endpoint, key header, query
// params), response parsing into arrival-shaped values, and the error mapping `classifyError` reads.
import { describe, expect, it } from 'vitest';
import { RateLimitedError } from '@/modules/integrations';
import { MASTER_KEY_NEEDED, apolloLive } from '@/modules/enrichment/adapters/apollo/live';
import { classifyError } from '@/modules/enrichment/domain/errors';

type Call = { url: URL; init: RequestInit };

function stub(responses: Record<string, unknown>, status = 200, headers: Record<string, string> = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string, init: RequestInit) => {
    const url = new URL(input);
    calls.push({ url, init });
    const key = Object.keys(responses).find((k) => url.pathname.endsWith(k));
    const body = key ? responses[key] : {};
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  }) as unknown as typeof fetch;
  return { calls, adapter: apolloLive({ kind: 'api_key', value: 'test-key', settings: {} }, fetchImpl) };
}

const header = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name];
const failure = async (p: Promise<unknown>) => p.then(() => { throw new Error('expected a failure'); }, (e: unknown) => e);

describe('Apollo live adapter', () => {
  it('enriches a company into arrival account fields, with the key header from the credential', async () => {
    const { calls, adapter } = stub({
      '/organizations/enrich': {
        organization: {
          id: 'o1', name: 'Northgate Freight', primary_domain: 'northgate-freight.com', website_url: 'https://northgate-freight.com', industry: 'transportation/trucking/railroad',
          estimated_num_employees: 420, annual_revenue: 95000000, city: 'Columbus', state: 'Ohio', country: 'United States', short_description: 'Freight carrier.',
          technology_names: ['Microsoft Access', 'QuickBooks'], keywords: ['freight'], organization_headcount_six_month_growth: 0.12,
          funding_events: [{ id: 'f1', date: '2026-05-01', type: 'Private equity', amount: '20000000', news_url: 'https://x' }],
        },
      },
    });
    const r = await adapter.companyEnrich({ domain: 'northgate-freight.com' });
    const c = calls[0]!;
    expect(c.url.origin + c.url.pathname).toBe('https://api.apollo.io/api/v1/organizations/enrich');
    expect(c.init.method).toBe('GET');
    expect(c.url.searchParams.get('domain')).toBe('northgate-freight.com');
    expect(header(c, 'x-api-key')).toBe('test-key');
    expect(r.creditsUsed).toBe(1);
    expect(r.value).toEqual({
      name: 'Northgate Freight', domain: 'northgate-freight.com', website: 'https://northgate-freight.com', linkedin_url: null, industry: 'transportation/trucking/railroad',
      employees: 420, revenue_cents: 9_500_000_000, city: 'Columbus', region: 'Ohio', country: 'United States', description: 'Freight carrier.',
      technologies: ['Microsoft Access', 'QuickBooks'], keywords: ['freight'], provider_ref: 'o1',
    });
  });

  it('returns no company, for its credit, when Apollo has none', async () => {
    const { adapter } = stub({ '/organizations/enrich': { organization: null } });
    expect(await adapter.companyEnrich({ domain: 'nobody.example' })).toEqual({ value: null, creditsUsed: 1 });
  });

  it('reads job postings and news as dated signals', async () => {
    const { calls, adapter } = stub({
      '/job_postings': { organization_job_postings: [{ id: 'j1', title: 'Microsoft Access Developer', url: 'https://jobs', city: 'Columbus', state: 'Ohio', country: 'United States', posted_at: '2026-10-01T00:00:00Z' }] },
      '/news_articles/search': { news_articles: [{ id: 'n1', title: 'Northgate names new COO', url: 'https://news', snippet: 'A new COO.', published_at: '2026-09-20', event_categories: ['hires'], organization_ids: ['o1'] }] },
    });
    const j = await adapter.jobPostings({ domain: 'northgate-freight.com', orgId: 'o1' });
    expect(calls[0]!.url.pathname).toBe('/api/v1/organizations/o1/job_postings');
    expect(j.creditsUsed).toBe(1);
    expect(j.value).toEqual([{ type: 'pain', fine_type: 'hiring', title: 'Hiring: Microsoft Access Developer', occurred_at: '2026-10-01', url: 'https://jobs', detail: 'Columbus, Ohio, United States' }]);
    const n = await adapter.news({ domain: 'northgate-freight.com', orgId: 'o1' });
    expect(calls[1]!.init.method).toBe('POST');
    expect(calls[1]!.url.searchParams.getAll('organization_ids[]')).toEqual(['o1']);
    expect(calls[1]!.url.searchParams.get('published_at[min]')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(n).toEqual({ value: [{ type: 'trigger', fine_type: 'leadership', title: 'Northgate names new COO', occurred_at: '2026-09-20', url: 'https://news', detail: 'A new COO.' }], creditsUsed: 1 });
  });

  it('looks the company up first when signals have no organization id, and counts that credit', async () => {
    const { calls, adapter } = stub({ '/organizations/enrich': { organization: { id: 'o9', name: 'X' } }, '/job_postings': { organization_job_postings: [] } });
    const j = await adapter.jobPostings({ domain: 'x.com' });
    expect(calls.map((c) => c.url.pathname)).toEqual(['/api/v1/organizations/enrich', '/api/v1/organizations/o9/job_postings']);
    expect(j).toEqual({ value: [], creditsUsed: 2 });
  });

  it('people search filters to buyer seniorities, by domain, and costs nothing', async () => {
    const { calls, adapter } = stub({ '/mixed_people/api_search': { people: [{ id: 'p1', first_name: 'Lee', last_name_obfuscated: 'O***r', title: 'VP Operations', has_email: true }] } });
    const r = await adapter.peopleSearch({ domain: 'northgate-freight.com', titles: ['VP Operations'], max: 3 });
    expect(r.creditsUsed).toBe(0);
    expect(r.value).toEqual([{ name: 'Lee', first_name: 'Lee', title: 'VP Operations', provider_ref: 'p1' }]);
    const q = calls[0]!.url.searchParams;
    expect(calls[0]!.init.method).toBe('POST');
    expect(q.getAll('person_seniorities[]')).toContain('c_suite');
    expect(q.getAll('q_organization_domains_list[]')).toEqual(['northgate-freight.com']);
    expect(q.getAll('person_titles[]')).toEqual(['VP Operations']);
    expect(q.get('per_page')).toBe('3');
  });

  it('reveals an email by Apollo id, with its status and seniority, for 1 credit', async () => {
    const { calls, adapter } = stub({
      '/people/match': { person: { id: 'p1', first_name: 'Lee', last_name: 'Oliver', name: 'Lee Oliver', title: 'VP Operations', email: 'lee@northgate-freight.com', email_status: 'verified', seniority: 'vp', linkedin_url: 'https://linkedin.com/in/lee' } },
    });
    const r = await adapter.revealEmail({ person: { name: 'Lee', provider_ref: 'p1' } });
    expect(calls[0]!.url.searchParams.get('id')).toBe('p1');
    expect(calls[0]!.url.searchParams.get('reveal_personal_emails')).toBe('false');
    expect(r).toEqual({
      value: { name: 'Lee Oliver', first_name: 'Lee', last_name: 'Oliver', title: 'VP Operations', email: 'lee@northgate-freight.com', email_status: 'verified', seniority: 'vp', linkedin_url: 'https://linkedin.com/in/lee', provider_ref: 'p1' },
      creditsUsed: 1,
    });
  });

  it('matches a named person by name and domain, and charges nothing when no email comes back', async () => {
    const { calls, adapter } = stub({ '/people/match': { person: { id: 'p2', first_name: 'Sam', last_name: 'Roe', email: null, email_status: 'unavailable' } } });
    const r = await adapter.revealEmail({ person: { name: 'Sam Roe', title: 'CFO' }, domain: 'acme.com' });
    const q = calls[0]!.url.searchParams;
    expect([q.get('name'), q.get('domain'), q.get('id')]).toEqual(['Sam Roe', 'acme.com', null]);
    expect(r.creditsUsed).toBe(0);
    expect(r.value).toMatchObject({ name: 'Sam Roe', title: 'CFO', email: null, email_status: 'unavailable' });
  });

  it('tests the key against organizations/enrich for apollo.io', async () => {
    const { calls, adapter } = stub({ '/organizations/enrich': { organization: { id: 'o', name: 'Apollo' } } });
    expect(await adapter.test()).toMatchObject({ ok: true });
    expect(calls[0]!.url.pathname).toBe('/api/v1/organizations/enrich');
    expect(calls[0]!.url.searchParams.get('domain')).toBe('apollo.io');
  });

  it('a rejected key throws status 401, read as auth', async () => {
    const e = await failure(stub({}, 401).adapter.companyEnrich({ domain: 'x.com' }));
    expect(e).toMatchObject({ status: 401 });
    expect(classifyError(e, 'Apollo').kind).toBe('auth');
    expect((await stub({}, 401).adapter.test()).ok).toBe(false);
  });

  it('a 403 says people search needs a master key: a bad request with that message, not retried', async () => {
    const e = await failure(stub({}, 403).adapter.peopleSearch({ domain: 'x.com', titles: [], max: 1 }));
    expect(e).toMatchObject({ status: 403, message: expect.stringMatching(/People search needs a master API key/) });
    expect(classifyError(e, 'Apollo')).toEqual({ kind: 'bad_request', message: MASTER_KEY_NEEDED, retry: false });
  });

  it('drops list items that do not parse and keeps the rest; a bad envelope still fails', async () => {
    const { adapter } = stub({
      '/job_postings': { organization_job_postings: [{ id: 'j1', title: null }, { id: 'j2', title: 'Dispatcher', posted_at: '2026-10-01' }, 'junk'] },
      '/mixed_people/api_search': { people: [{ id: 'p1', first_name: null }, { id: 'p2', first_name: 'Kai' }] },
      '/news_articles/search': { news_articles: 'not a list' },
    });
    expect((await adapter.jobPostings({ domain: 'x.com', orgId: 'o1' })).value.map((s) => s.title)).toEqual(['Hiring: Dispatcher']);
    expect((await adapter.peopleSearch({ domain: 'x.com', titles: [], max: 5 })).value.map((p) => p.provider_ref)).toEqual(['p2']);
    await expect(adapter.news({ domain: 'x.com', orgId: 'o1' })).rejects.toThrow(/could not read/);
  });

  it('cancels the body of an answer it refuses without reading', async () => {
    let cancelled = 0;
    const fetchImpl = (async () => {
      const body = new ReadableStream({ cancel: () => void cancelled++ });
      return new Response(body, { status: 401 });
    }) as unknown as typeof fetch;
    await expect(apolloLive({ kind: 'api_key', value: 'k', settings: {} }, fetchImpl).companyEnrich({ domain: 'x.com' })).rejects.toMatchObject({ status: 401 });
    expect(cancelled).toBe(1);
  });

  it('a 429 is a RateLimitedError with the Retry-After in milliseconds', async () => {
    const e = await failure(stub({}, 429, { 'retry-after': '30' }).adapter.companyEnrich({ domain: 'x.com' }));
    expect(e).toBeInstanceOf(RateLimitedError);
    expect((e as RateLimitedError).retryAfterMs).toBe(30_000);
    expect(classifyError(e, 'Apollo').kind).toBe('rate_limited');
  });

  it('recognises an out-of-credits answer', async () => {
    const { adapter } = stub({ '/organizations/enrich': { error: "You have insufficient credits! <a href='x'>Upgrade your plan</a>" } }, 422);
    const e = await failure(adapter.companyEnrich({ domain: 'x.com' }));
    expect(e).toMatchObject({ kind: 'out_of_credits', message: 'Apollo is out of credits.' });
    expect(classifyError(e, 'Apollo').kind).toBe('out_of_credits');
  });

  it('another refusal is a bad request with what Apollo said, tags removed', async () => {
    const { adapter } = stub({ '/organizations/enrich': '<b>domain is invalid</b>' }, 422);
    const e = await failure(adapter.companyEnrich({ domain: 'x' }));
    expect(e).toMatchObject({ status: 422, message: 'Apollo returned 422: domain is invalid' });
    expect(classifyError(e, 'Apollo').kind).toBe('bad_request');
  });

  it('an answer that does not parse is not trusted', async () => {
    const { adapter } = stub({ '/organizations/enrich': { organization: { name: 42 } } });
    await expect(adapter.companyEnrich({ domain: 'x.com' })).rejects.toThrow(/could not read/);
  });

  it("can't read websites", async () => {
    const e = await failure(stub({}).adapter.readSite({ domain: 'x.com' }));
    expect(e).toMatchObject({ status: 400, message: "Apollo can't do that." });
  });
});
