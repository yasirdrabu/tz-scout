import { http, HttpResponse } from 'msw';
import { serveMe } from '../../test/renderApp';
import { server } from '../../test/server';
import type { MetricDetail, Overview, Scorecard } from './api';

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

const c = (value: number | null, tone: 'good' | 'neutral' | 'attention' | null = null, sub?: string) => ({ value, tone, ...(sub ? { sub } : {}) });

export const sellersView = (): Scorecard => ({
  tab: 'sellers',
  quarter_label: 'Q4 2026',
  team: { accepted: 80, time_to_accept: 6, steps_on_time: 70, win_rate: 20 },
  rows: [
    { seller_user_id: 'u1', name: 'Priya Shah', assigned: 14, accepted: c(90, 'good', '9 of 10'), time_to_accept: c(4, 'good', 'Average'), steps_on_time: c(null, null, 'Playbook steps'), meetings: c(7), opportunities: c(5), won: c(2), pipeline_cents: c(3_000_000), win_rate: c(40, 'good', 'Of opportunities') },
    { seller_user_id: 'u2', name: 'Sam Lee', assigned: 3, accepted: c(50, 'attention', '1 of 2'), time_to_accept: c(20, 'attention', 'Average'), steps_on_time: c(60, 'neutral', 'Playbook steps'), meetings: c(9), opportunities: c(2), won: c(1), pipeline_cents: c(500_000), win_rate: c(10, 'neutral', 'Of opportunities') },
  ],
});

export const offersView = (): Scorecard => ({
  tab: 'offers',
  quarter_label: 'Q4 2026',
  team: null,
  rows: [
    { offer_id: 'o1', name: 'Cloud Migration', practice_name: 'Cloud', price_label: '$20k–$40k', matched: c(20), opportunities: c(8), won: c(3), win_rate: c(15, 'good', 'Of matched'), won_value_cents: c(9_000_000), pipeline_cents: c(1_200_000) },
  ],
});

export const practicesView = (): Scorecard => ({
  tab: 'practices',
  quarter_label: 'Q4 2026',
  team: null,
  rows: [
    { practice_id: 'p1', name: 'Cloud', lead_name: 'Maya Chen', offers: 4, active_offers: 3, matched: c(30), opportunities: c(10), won: c(4), win_rate: c(8, 'attention', 'Of matched'), won_value_cents: c(10_000_000), pipeline_cents: c(2_000_000) },
  ],
});

export const metricDetail = (m: Partial<MetricDetail> = {}): MetricDetail => ({
  eyebrow: 'Priya Shah · seller',
  title: 'Accepted',
  value: '90%',
  change_pct: 20,
  definition: 'Share of assigned accounts this seller accepted.',
  notes: [{ label: 'Assigned', value: '10' }],
  breakdowns: [{ label: 'By offer', items: Array.from({ length: 10 }, (_, i) => ({ name: `Offer ${i + 1}`, count: 10 - i, value: String(10 - i) })) }],
  accounts: [{ account_id: 'a1', name: 'Northwind', meta: 'Cloud Migration · Referral', at: '2026-11-02T10:00:00Z' }],
  total: 14,
  see_all: { owner: 'u1' },
  ...m,
});

/** The scorecard tabs and the metric drawer answered from fixtures; `seen` collects the metric requests' paths. */
export function serveScorecard(seen: string[] = [], detail: MetricDetail = metricDetail()) {
  server.use(
    http.get('/api/v1/analytics/scorecard', ({ request }) => {
      const tab = new URL(request.url).searchParams.get('tab');
      return HttpResponse.json(tab === 'offers' ? offersView() : tab === 'practices' ? practicesView() : sellersView());
    }),
    http.get('/api/v1/analytics/metrics/:key', ({ request }) => {
      const u = new URL(request.url);
      seen.push(u.pathname + u.search);
      return HttpResponse.json(detail);
    }),
  );
}

type Opts = { scopes?: string[]; data?: Overview; fail?: boolean };

/** The Overview screen answered from fixtures. */
export function serveOverview(opts: Opts = {}) {
  serveMe({ taazaa: { scopes: opts.scopes ?? ANALYST, tenant: { id: 't1', slug: 'taazaa', name: 'Taazaa', currency: 'USD', timezone: 'America/New_York' } } });
  serveScorecard();
  server.use(
    http.get('/api/v1/analytics/overview', () =>
      opts.fail
        ? HttpResponse.json({ title: 'Something broke.', status: 500 }, { status: 500, headers: { 'content-type': 'application/problem+json' } })
        : HttpResponse.json(opts.data ?? overview()),
    ),
  );
}
