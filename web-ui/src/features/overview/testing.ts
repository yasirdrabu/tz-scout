import { http, HttpResponse } from 'msw';
import { serveMe } from '../../test/renderApp';
import { server } from '../../test/server';
import type { Overview } from './api';

// Fixtures in the API's shape (snake_case) for the Overview tests.

export const ANALYST = ['analytics:read'];
export const ADMIN = ['analytics:read', 'settings:manage'];

export const overview = (o: Partial<Overview> = {}): Overview => ({
  quarter: { label: 'Q4 2026', from: '2026-10-01', to: '2026-11-06', week: 6, weeks: 14, pace_pct: 40 },
  first_stage: { key: 'sent', name: 'Sent' },
  opportunity_stage: { key: 'opportunity', name: 'Opportunity' },
  won_stage: { key: 'won', name: 'Won' },
  kpis: { pipeline_value_cents: 12_500_000, pipeline_accounts: 7, won_value_cents: 4_000_000, won_accounts: 3, sent_to_won_pct: 8.5, days_to_win: 41 },
  stages: [
    { key: 'sent', name: 'Sent', count: 100, pct_of_previous: null, value_cents: null, target: null, expected: null, pace: null },
    { key: 'reviewed', name: 'Reviewed', count: 62, pct_of_previous: 62, value_cents: null, target: 100, expected: 40, pace: 'ahead' },
    { key: 'opportunity', name: 'Opportunity', count: 30, pct_of_previous: 48, value_cents: 12_500_000, target: 100, expected: 40, pace: 'behind' },
    { key: 'won', name: 'Won', count: 3, pct_of_previous: 10, value_cents: 4_000_000, target: 5, expected: 2, pace: 'on' },
  ],
  exits: [
    { key: 'rejected', name: 'Rejected', count: 12 },
    { key: 'lost', name: 'Lost', count: 4 },
  ],
  updated_at: '2026-11-06T10:00:00Z',
  ...o,
});

export const emptyOverview = (): Overview =>
  overview({
    kpis: { pipeline_value_cents: 0, pipeline_accounts: 0, won_value_cents: 0, won_accounts: 0, sent_to_won_pct: null, days_to_win: null },
    stages: overview().stages.map((s) => ({ ...s, count: 0, pct_of_previous: null, value_cents: s.value_cents === null ? null : 0, expected: s.target === null ? null : 0, pace: s.target === null ? null : 'behind' })),
    exits: overview().exits.map((e) => ({ ...e, count: 0 })),
  });

type Opts = { scopes?: string[]; data?: Overview; fail?: boolean };

/** The Overview screen answered from fixtures. */
export function serveOverview(opts: Opts = {}) {
  serveMe({ taazaa: { scopes: opts.scopes ?? ANALYST, tenant: { id: 't1', slug: 'taazaa', name: 'Taazaa', currency: 'USD', timezone: 'America/New_York' } } });
  server.use(
    http.get('/api/v1/analytics/overview', () =>
      opts.fail
        ? HttpResponse.json({ title: 'Something broke.', status: 500 }, { status: 500, headers: { 'content-type': 'application/problem+json' } })
        : HttpResponse.json(opts.data ?? overview()),
    ),
  );
}
