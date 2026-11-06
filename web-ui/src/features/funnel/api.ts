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
  /** False when practice, offer or batch is set: spend isn't split that way, so every spend field is null. */
  spend_split: boolean;
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

// Funnel drill (§17, Ruling 11): src/http/routes/v1/analytics/sources/[id]/performance/route.ts.

export type DrillStage = {
  key: string;
  name: string;
  count: number;
  all_count: number;
  moved_on_pct: number | null;
  all_moved_on_pct: number | null;
  lost: number;
  cost_each_cents: number | null;
};

export type Drill = {
  source: { id: string; name: string; kind: string };
  period: { key: PeriodKey; from: string; to: string };
  rank: number | null;
  of: number;
  prev_id: string | null;
  next_id: string | null;
  /** This source's place among the funnel rows, null for a source that is not a row. */
  position: number | null;
  row_count: number | null;
  target_cost_per_won_cents: number | null;
  /** As the funnel's. */
  spend_split: boolean;
  totals: {
    sent: number;
    won: number;
    won_pct: number | null;
    all_won_pct: number | null;
    spend_cents: number | null;
    cost_per_sent_cents: number | null;
    cost_per_won_cents: number | null;
    status: CostStatus | null;
  };
  insight: string | null;
  stages: DrillStage[];
  batches: { batch_id: string; name: string; sent: number; won: number }[];
  won_accounts: { account_id: string; name: string; offer_name: string | null; value_cents: number | null }[];
};

export const drillQuery = (tenant: string, sourceId: string, f: FunnelFilters) =>
  queryOptions({
    queryKey: ['funnel', tenant, 'drill', sourceId, f],
    queryFn: () => apiFetch<Drill>(`/analytics/sources/${encodeURIComponent(sourceId)}/performance?${funnelParams(f)}`, { tenant }),
  });
