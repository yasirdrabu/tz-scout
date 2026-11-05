import { http, HttpResponse } from 'msw';
import { exactly, problem } from '../../test/http';
import { serveMe } from '../../test/renderApp';
import { server } from '../../test/server';
import type { BudgetsView, CategorySummary, CostLine, CostsSummary, Rate } from './api';

// Fixtures in the API's shapes (snake_case) for the Costs tests.

export const LEADER = ['costs:read', 'costs:write', 'budgets:write'];
export const OPERATOR = ['costs:read', 'costs:write'];
export const READER = ['costs:read'];

export const category = (c: Partial<CategorySummary> & Pick<CategorySummary, 'key' | 'label'>): CategorySummary => ({
  spend_90d_cents: 0,
  spend_month_cents: 0,
  budget_cents: null,
  level: 'ok',
  pausable: false,
  ...c,
});

export const CATEGORIES: CategorySummary[] = [
  category({ key: 'partner_fees', label: 'Partner fees', spend_90d_cents: 50_000, spend_month_cents: 10_000, budget_cents: 100_000 }),
  category({ key: 'data_vendors', label: 'Data vendors', spend_90d_cents: 120_000, spend_month_cents: 40_000, budget_cents: 100_000, pausable: true }),
  category({ key: 'agents_hosting', label: 'Agents and hosting', spend_90d_cents: 20_000, spend_month_cents: 5_000, budget_cents: 50_000 }),
  category({ key: 'lists_events', label: 'Lists and events', spend_90d_cents: 10_000, spend_month_cents: 0, budget_cents: null }),
  category({ key: 'ai_usage', label: 'AI usage', spend_90d_cents: 100_000, spend_month_cents: 30_000, budget_cents: 50_000, pausable: true }),
];

export const MONTHS = [
  { month: '2026-06', spend_cents: 40_000, budget_cents: 300_000 },
  { month: '2026-07', spend_cents: 50_000, budget_cents: 300_000 },
  { month: '2026-08', spend_cents: 60_000, budget_cents: 300_000 },
  { month: '2026-09', spend_cents: 70_000, budget_cents: 100_000 },
  { month: '2026-10', spend_cents: 92_000, budget_cents: 100_000 },
  { month: '2026-11', spend_cents: 130_000, budget_cents: 100_000 },
];

export const summary = (s: Partial<CostsSummary> = {}): CostsSummary => ({
  month: '2026-11',
  spend_month_cents: 85_000,
  budget_month_cents: 300_000,
  spend_90d_cents: 300_000,
  categories: CATEGORIES,
  months: MONTHS,
  ...s,
});

export const line = (l: Partial<CostLine> & Pick<CostLine, 'id'>): CostLine => ({
  occurred_on: '2026-11-03',
  category: 'partner_fees',
  provider: null,
  amount_cents: 12_500,
  origin: 'manual',
  account_id: null,
  note: 'Referral fee',
  created_by: 'm1',
  created_at: '2026-11-03T15:00:00Z',
  voided_at: null,
  void_reason: null,
  voided_by: null,
  replaces_id: null,
  ...l,
});

export const MANUAL = line({ id: 'cst_manual' });
export const USAGE = line({ id: 'cst_usage', category: 'ai_usage', provider: 'anthropic', origin: 'usage', amount_cents: 340, note: null });
export const VOIDED = line({ id: 'cst_void', amount_cents: 999, note: 'Wrong month', voided_at: '2026-11-04T10:00:00Z', void_reason: 'Duplicate' });

export const CLAUDE_RATES: Rate[] = [
  { item: 'claude-sonnet-5-5:input', cents_per_unit: 0.0003, is_default: true },
  { item: 'claude-sonnet-5-5:output', cents_per_unit: 0.0015, is_default: true },
];
export const APOLLO_RATES: Rate[] = [{ item: 'credit', cents_per_unit: 2, is_default: true }];

type Seen = { method: string; url: URL; body: unknown };
type Opts = {
  scopes?: string[];
  summary?: CostsSummary;
  lines?: CostLine[];
  /** Answers for one request, such as `PUT budgets` or `POST lines`. */
  answer?: Record<string, () => Response>;
};

/** The Costs screen answered from fixtures. Returns the request log. */
export function serveCosts(opts: Opts = {}) {
  const seen: Seen[] = [];
  serveMe({ taazaa: { scopes: opts.scopes ?? LEADER, tenant: { id: 't1', slug: 'taazaa', name: 'Taazaa', currency: 'USD', timezone: 'America/New_York' } } });
  const log = async (request: Request) => {
    const body = request.method === 'GET' ? undefined : await request.clone().json().catch(() => undefined);
    seen.push({ method: request.method, url: new URL(request.url), body });
  };
  const all = opts.lines ?? [MANUAL, USAGE, VOIDED];
  server.use(
    http.get('/api/v1/costs/summary', () => HttpResponse.json(opts.summary ?? summary())),
    http.get('/api/v1/costs/lines', ({ request }) => {
      const voided = new URL(request.url).searchParams.get('include_voided') === 'true';
      return HttpResponse.json({ data: voided ? all : all.filter((l) => !l.voided_at), next_cursor: null });
    }),
    http.post(exactly('/api/v1/costs/lines'), async ({ request }) => {
      await log(request);
      const out = opts.answer?.['POST lines']?.();
      if (out) return out;
      const body = (await request.clone().json()) as Partial<CostLine>;
      return HttpResponse.json(line({ id: 'cst_new', ...body }), { status: 201 });
    }),
    http.patch('/api/v1/costs/lines/:id', async ({ request }) => {
      await log(request);
      const body = (await request.clone().json()) as Partial<CostLine>;
      return HttpResponse.json(line({ id: 'cst_edited', replaces_id: 'cst_manual', ...body }));
    }),
    http.post(/\/api\/v1\/costs\/lines\/[^/]+:void$/, async ({ request }) => {
      await log(request);
      return opts.answer?.['POST void']?.() ?? HttpResponse.json({ ...MANUAL, voided_at: '2026-11-05T10:00:00Z' });
    }),
    http.put('/api/v1/costs/budgets', async ({ request }) => {
      await log(request);
      const out = opts.answer?.['PUT budgets']?.();
      if (out) return out;
      const body = (await request.clone().json()) as { month: string; budgets: { category: string; amount_cents: number }[] };
      const view: BudgetsView = {
        month: body.month,
        total_cents: body.budgets.reduce((s, b) => s + b.amount_cents, 0),
        budgets: body.budgets.map((b) => ({ ...b, category: b.category as BudgetsView['budgets'][number]['category'], label: b.category, pausable: false })),
      };
      return HttpResponse.json(view);
    }),
  );
  return seen;
}

/** The prices endpoints for one provider: GET answers `rates`, PUT echoes what was sent. */
export function serveRates(provider: string, rates: Rate[], seen: Seen[] = []) {
  server.use(
    http.get(`/api/v1/integrations/${provider}/rates`, () => HttpResponse.json({ data: rates })),
    http.put(`/api/v1/integrations/${provider}/rates`, async ({ request }) => {
      const body = (await request.clone().json()) as { rates: { item: string; cents_per_unit: number }[] };
      seen.push({ method: 'PUT', url: new URL(request.url), body });
      if (body.rates.some((r) => r.cents_per_unit < 0)) return problem(400, "A rate can't be negative.");
      return HttpResponse.json({ data: rates.map((r) => ({ ...r, ...body.rates.find((x) => x.item === r.item), is_default: false })) });
    }),
  );
  return seen;
}
