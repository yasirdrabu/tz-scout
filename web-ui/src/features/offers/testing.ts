import { http, HttpResponse } from 'msw';
import { exactly, problem } from '../../test/http';
import { serveMe } from '../../test/renderApp';
import { server } from '../../test/server';
import type { Offer, OfferDetail, OfferStat, Practice } from './api';

// Fixtures in the API's shapes (snake_case) for the Offers tests. Price lines, status words, counts and
// win rates are ones the browser could not derive (C8).

export const MANAGER = ['offers:read', 'offers:manage', 'members:read', 'accounts:read'];
export const READER = ['offers:read', 'accounts:read'];

export const practice = (p: Partial<Practice> & Pick<Practice, 'id' | 'name'>): Practice => ({
  description: null,
  status: 'active',
  lead_user_id: null,
  lead_name: null,
  offer_count: 0,
  ...p,
});

export const offer = (o: Partial<Offer> & Pick<Offer, 'id' | 'name' | 'practice_id'>): Offer => ({
  status: 'approved',
  status_label: 'Active',
  promise: 'A promise.',
  description: null,
  key_offer: null,
  why_us: null,
  why_now: null,
  price_model: null,
  price_min_cents: null,
  price_max_cents: null,
  price_label: null,
  length_weeks: null,
  typical_deal_cents: 5_000_000,
  sales_cycle_days: 60,
  target_titles: ['CTO'],
  target_buying_roles: [],
  industries: ['logistics'],
  company_size_min: null,
  company_size_max: null,
  proof_points: [],
  updated_at: '2026-10-20T12:00:00Z',
  ...o,
});

export const AI = practice({ id: 'prc_ai', name: 'AI Transformation', lead_user_id: 'usr_ash', lead_name: 'Ash Patel', offer_count: 2, description: 'Plans that get funded.' });
export const DATA = practice({ id: 'prc_data', name: 'Data Readiness', offer_count: 1 });

export const BLUEPRINT = offer({
  id: 'off_mb',
  name: 'Modernization Blueprint',
  practice_id: 'prc_ai',
  promise: 'A funded plan in six weeks.',
  description: 'Agencies with a mandate.',
  price_model: 'fixed',
  price_min_cents: 8_500_000,
  price_max_cents: 8_500_000,
  length_weeks: 6,
  price_label: 'Fixed fee · $85,000 · 6 weeks',
  proof_points: ['Plan approved in 7 weeks'],
});
export const SPRINT = offer({ id: 'off_sprint', name: 'Campaign Engine Sprint', practice_id: 'prc_ai', status: 'draft', status_label: 'Draft', price_model: 'custom', price_label: 'Custom quote' });
export const ASSESS = offer({ id: 'off_assess', name: 'Data Readiness Assessment', practice_id: 'prc_data' });

export const STATS: OfferStat[] = [
  { offer_id: 'off_mb', practice_id: 'prc_ai', matched: 38, won: 7, win_rate: 18 },
  { offer_id: 'off_sprint', practice_id: 'prc_ai', matched: 0, won: 0, win_rate: null },
  { offer_id: 'off_assess', practice_id: 'prc_data', matched: 21, won: 2, win_rate: 10 },
];

export const MEMBERS = [
  { user_id: 'usr_ash', name: 'Ash Patel' },
  { user_id: 'usr_maya', name: 'Maya Chen' },
];

type Seen = { method: string; url: URL; body: unknown };
type Opts = {
  scopes?: string[];
  practices?: Practice[];
  offers?: Offer[];
  /** Overrides on the offer read by id. */
  detail?: Record<string, Partial<OfferDetail>>;
  /** Answers for one action, by path suffix such as `off_mb:approve` or `DELETE off_mb`. */
  answer?: Record<string, () => Response>;
};

/** The Offers screen answered from fixtures; writes change the fixtures. Returns the request log. */
export function serveOffers(opts: Opts = {}) {
  const seen: Seen[] = [];
  const practices = [...(opts.practices ?? [AI, DATA])];
  let offers = [...(opts.offers ?? [BLUEPRINT, SPRINT, ASSESS])];
  const manage = (opts.scopes ?? MANAGER).includes('offers:manage');
  const log = async (request: Request) => {
    const body = request.method === 'GET' || request.method === 'DELETE' ? undefined : await request.clone().json().catch(() => undefined);
    seen.push({ method: request.method, url: new URL(request.url), body });
  };
  serveMe({ taazaa: { scopes: opts.scopes ?? MANAGER, tenant: { id: 't1', slug: 'taazaa', name: 'Taazaa', currency: 'USD', timezone: 'America/New_York' } } });
  const visible = () => (manage ? offers : offers.filter((o) => o.status === 'approved'));
  const read = (id: string): OfferDetail | undefined => {
    const o = visible().find((x) => x.id === id);
    if (!o) return undefined;
    const p = practices.find((x) => x.id === o.practice_id);
    return { ...o, practice_lead_name: p?.lead_name ?? null, can_delete: (STATS.find((s) => s.offer_id === id)?.matched ?? 0) === 0, ...opts.detail?.[id] };
  };
  const update = (id: string, patch: Partial<Offer>) => {
    offers = offers.map((o) => (o.id === id ? { ...o, ...patch } : o));
    return offers.find((o) => o.id === id)!;
  };
  const override = (key: string) => opts.answer?.[key]?.();
  server.use(
    http.get('/api/v1/practices', () => HttpResponse.json({ data: practices, next_cursor: null })),
    http.get('/api/v1/practices/:id', ({ params }) => {
      const p = practices.find((x) => x.id === params.id);
      return p ? HttpResponse.json(p) : problem(404, 'That practice was not found.');
    }),
    http.get('/api/v1/offers', async ({ request }) => {
      await log(request);
      return HttpResponse.json({ data: visible(), next_cursor: null });
    }),
    http.get('/api/v1/offers/stats', () => HttpResponse.json({ data: STATS.filter((s) => visible().some((o) => o.id === s.offer_id)) })),
    http.get('/api/v1/offers/:id', ({ params }) => {
      const o = read(String(params.id));
      return o ? HttpResponse.json(o) : problem(404, 'That offer was not found.');
    }),
    http.get('/api/v1/members/directory', () => HttpResponse.json({ data: MEMBERS })),
    http.post('/api/v1/offers', async ({ request }) => {
      await log(request);
      const body = (await request.clone().json()) as Partial<Offer>;
      const made = offer({ ...body, id: 'off_new', name: body.name!, practice_id: body.practice_id!, status: 'draft', status_label: 'Draft' } as Offer);
      offers = [...offers, made];
      return HttpResponse.json(made, { status: 201 });
    }),
    http.patch('/api/v1/offers/:id', async ({ request, params }) => {
      await log(request);
      const o = override(`PATCH ${String(params.id)}`);
      if (o) return o;
      const body = (await request.clone().json()) as Partial<Offer>;
      const before = offers.find((x) => x.id === params.id)!;
      const buyer = JSON.stringify(body.industries ?? before.industries) !== JSON.stringify(before.industries);
      const saved = update(String(params.id), { ...body, ...(buyer && before.status === 'approved' ? { status: 'draft', status_label: 'Draft' } : {}) });
      return HttpResponse.json(buyer && before.status === 'approved' ? { ...saved, warning: 'This sends the offer back to draft until an owner approves it.' } : saved);
    }),
    http.post(/\/api\/v1\/offers\/[^/]+:approve$/, async ({ request }) => {
      await log(request);
      const id = new URL(request.url).pathname.split('/').pop()!.split(':')[0]!;
      return override(`${id}:approve`) ?? HttpResponse.json(update(id, { status: 'approved', status_label: 'Active' }));
    }),
    http.post(/\/api\/v1\/offers\/[^/]+:unapprove$/, async ({ request }) => {
      await log(request);
      const id = new URL(request.url).pathname.split('/').pop()!.split(':')[0]!;
      return HttpResponse.json(update(id, { status: 'draft', status_label: 'Draft' }));
    }),
    http.post(/\/api\/v1\/offers\/[^/]+:archive$/, async ({ request }) => {
      await log(request);
      const id = new URL(request.url).pathname.split('/').pop()!.split(':')[0]!;
      return HttpResponse.json(update(id, { status: 'archived', status_label: 'Retired' }));
    }),
    http.delete('/api/v1/offers/:id', async ({ request, params }) => {
      await log(request);
      offers = offers.filter((o) => o.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post('/api/v1/practices', async ({ request }) => {
      await log(request);
      const body = (await request.clone().json()) as Partial<Practice>;
      const made = practice({ ...body, id: 'prc_new', name: body.name! });
      practices.push(made);
      return HttpResponse.json(made, { status: 201 });
    }),
    http.patch('/api/v1/practices/:id', async ({ request, params }) => {
      await log(request);
      const body = (await request.clone().json()) as Partial<Practice>;
      const i = practices.findIndex((p) => p.id === params.id);
      practices[i] = { ...practices[i]!, ...body, lead_name: MEMBERS.find((m) => m.user_id === body.lead_user_id)?.name ?? null };
      return HttpResponse.json(practices[i]);
    }),
    http.post(exactly('/api/v1/practices/prc_ai:archive'), async ({ request }) => {
      await log(request);
      return override('prc_ai:archive') ?? HttpResponse.json({ ...AI, status: 'archived' });
    }),
  );
  return seen;
}
