import { http, HttpResponse } from 'msw';
import { serveMe } from '../../test/renderApp';
import { server } from '../../test/server';
import type { Funnel, FunnelRow } from './api';

// Fixtures in the API's shapes (snake_case) for the Funnel tests.

export const ANALYST = ['analytics:read', 'costs:read'];
export const NO_COSTS = ['analytics:read'];

export const STAGES = [
  { key: 'arrived', name: 'Arrived' },
  { key: 'reviewed', name: 'Reviewed' },
  { key: 'won', name: 'Won' },
];

export const row = (r: Partial<FunnelRow> & Pick<FunnelRow, 'source_id' | 'name'>): FunnelRow => ({
  kind: 'agent',
  counts: [40, 20, 4],
  step_pct: [null, 50, 20],
  cost_per_account_cents: [1_000, 2_000, 10_000],
  spend_cents: 40_000,
  cost_per_won_cents: 10_000,
  status: 'good',
  win_rate_pct: 10,
  ...r,
});

export const ROWS: FunnelRow[] = [
  row({ source_id: 'src_rfp', name: 'RFP Watch' }),
  row({ source_id: 'src_part', name: 'Partner referrals', kind: 'partner', counts: [20, 10, 1], step_pct: [null, 50, 10], spend_cents: 30_000, cost_per_won_cents: 30_000, status: 'amber', win_rate_pct: 5 }),
  row({ source_id: 'src_list', name: 'Event list', kind: 'list', counts: [12, 3, 0], step_pct: [null, 25, 0], spend_cents: 5_000, cost_per_won_cents: null, status: 'no_wins', win_rate_pct: 0 }),
  row({ source_id: 'src_new', name: 'New feed', kind: 'agent', counts: [4, 1, 0], step_pct: [null, 25, 0], spend_cents: 0, cost_per_won_cents: null, status: 'not_enough_data', win_rate_pct: 0 }),
  row({ source_id: 'src_bad', name: 'Pricey vendor', kind: 'vendor', status: 'red', cost_per_won_cents: 90_000, win_rate_pct: 2 }),
  row({ source_id: 'src_none', name: 'No-target source', status: 'no_target' }),
];

export const funnel = (f: Partial<Funnel> = {}): Funnel => ({
  period: { key: '90d', from: '2026-08-08', to: '2026-11-06' },
  stages: STAGES,
  target_cost_per_won_cents: 20_000,
  totals: { sent: 76, sources: 6, won: 5, won_pct: 7, spend_cents: 100_000, cost_per_won_cents: 20_000 },
  rows: ROWS,
  shared_spend_cents: 25_000,
  updated_at: '2026-11-06T10:00:00Z',
  ...f,
});

/** Hides every spend field, as the API does for a caller without costs:read. */
export const withoutSpend = (f: Funnel): Funnel => ({
  ...f,
  target_cost_per_won_cents: null,
  totals: { ...f.totals, spend_cents: null, cost_per_won_cents: null },
  rows: f.rows.map((r) => ({ ...r, spend_cents: null, cost_per_won_cents: null, status: null, cost_per_account_cents: null })),
  shared_spend_cents: null,
});

type Opts = { scopes?: string[]; funnel?: Funnel };

/** The Funnel screen answered from fixtures. Returns the funnel request URLs. */
export function serveFunnel(opts: Opts = {}) {
  const seen: URL[] = [];
  const scopes = opts.scopes ?? ANALYST;
  serveMe({ taazaa: { scopes, tenant: { id: 't1', slug: 'taazaa', name: 'Taazaa', currency: 'USD', timezone: 'America/New_York' } } });
  const data = opts.funnel ?? (scopes.includes('costs:read') ? funnel() : withoutSpend(funnel()));
  server.use(
    http.get('/api/v1/analytics/funnel', ({ request }) => {
      seen.push(new URL(request.url));
      return HttpResponse.json(data);
    }),
    http.get('/api/v1/practices', () => HttpResponse.json({ data: [{ id: 'p1', name: 'Data and AI', description: null, status: 'active', lead_user_id: null, lead_name: null, offer_count: 1 }], next_cursor: null })),
    http.get('/api/v1/offers', () => HttpResponse.json({ data: [{ id: 'o1', practice_id: 'p1', name: 'Modernization Blueprint', status: 'approved' }], next_cursor: null })),
    http.get('/api/v1/batches', () => HttpResponse.json({ data: [{ id: 'b1', name: 'October list' }], next_cursor: null })),
  );
  return seen;
}
