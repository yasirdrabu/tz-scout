import { queryOptions } from '@tanstack/react-query';
import { apiFetch } from '../../api/client';

// Funnel by source (§16, R3b-1): src/http/routes/v1/analytics/funnel/route.ts. Money is integer cents. Every spend
// field is null for a caller without costs:read.

export type PeriodKey = '30d' | '90d' | 'quarter' | 'year';
export const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: '30d', label: 'Last 30 days' },
  { key: '90d', label: 'Last 90 days' },
  { key: 'quarter', label: 'This quarter' },
  { key: 'year', label: 'This year' },
];
export const DEFAULT_PERIOD: PeriodKey = '90d';

export type CostStatus = 'good' | 'amber' | 'red' | 'not_enough_data' | 'no_wins' | 'no_target';

export type FunnelRow = {
  source_id: string;
  name: string;
  kind: string;
  counts: number[];
  step_pct: (number | null)[];
  cost_per_account_cents: (number | null)[] | null;
  spend_cents: number | null;
  cost_per_won_cents: number | null;
  status: CostStatus | null;
  win_rate_pct: number | null;
};

export type Funnel = {
  period: { key: PeriodKey; from: string; to: string };
  stages: { key: string; name: string }[];
  target_cost_per_won_cents: number | null;
  totals: { sent: number; sources: number; won: number; won_pct: number | null; spend_cents: number | null; cost_per_won_cents: number | null };
  rows: FunnelRow[];
  shared_spend_cents: number | null;
  updated_at: string | null;
};

/** The screen's filters, as the URL carries them (C10). */
export type FunnelFilters = { period?: string; practice?: string; offer?: string; batch?: string };

export const funnelParams = (f: FunnelFilters) => {
  const p = new URLSearchParams({ period: f.period || DEFAULT_PERIOD });
  if (f.practice) p.set('practice', f.practice);
  if (f.offer) p.set('offer', f.offer);
  if (f.batch) p.set('batch', f.batch);
  return p;
};

export const funnelQuery = (tenant: string, f: FunnelFilters) =>
  queryOptions({
    queryKey: ['funnel', tenant, 'list', f],
    queryFn: () => apiFetch<Funnel>(`/analytics/funnel?${funnelParams(f)}`, { tenant }),
  });

/** The batches to filter by. */
export const batchOptionsQuery = (tenant: string) =>
  queryOptions({
    queryKey: ['funnel', tenant, 'batches'],
    queryFn: () => apiFetch<{ data: { id: string; name: string }[] }>('/batches?limit=100', { tenant }).then((r) => r.data),
  });

/** What a cost per won cell reads when there is no figure to colour. */
export const STATUS_WORD: Partial<Record<CostStatus, string>> = {
  not_enough_data: 'Not enough data',
  no_wins: 'No wins yet',
  no_target: 'No target set',
};
