import { queryOptions } from '@tanstack/react-query';
import { apiFetch } from '../../api/client';

// Overview (§9, R3c-1): src/http/routes/v1/analytics/overview/route.ts. Money is integer cents.

export type Pace = 'behind' | 'on' | 'ahead';
type Named = { key: string; name: string };

export type OverviewStage = Named & {
  count: number;
  pct_of_previous: number | null;
  value_cents: number | null;
  target: number | null;
  expected: number | null;
  pace: Pace | null;
};

export type Overview = {
  quarter: { label: string; from: string; to: string; week: number; weeks: number; pace_pct: number };
  first_stage: Named;
  opportunity_stage: Named;
  won_stage: Named;
  kpis: {
    pipeline_value_cents: number;
    pipeline_accounts: number;
    won_value_cents: number;
    won_accounts: number;
    sent_to_won_pct: number | null;
    days_to_win: number | null;
  };
  stages: OverviewStage[];
  exits: (Named & { count: number })[];
  updated_at: string | null;
};

export const PACE_WORD: Record<Pace, string> = { behind: 'Behind pace', on: 'On pace', ahead: 'Ahead' };

/** What a click on a number asks the detail drawer to show: the metric key and the row it belongs to. */
export type Scope = { stage?: string; seller?: string; offer?: string; practice?: string };
export type Selection = { key: string; scope?: Scope };

export const sameSelection = (a: Selection | null, b: Selection) => !!a && a.key === b.key && JSON.stringify(a.scope ?? {}) === JSON.stringify(b.scope ?? {});

export const overviewQuery = (tenant: string) =>
  queryOptions({
    queryKey: ['overview', tenant],
    queryFn: () => apiFetch<Overview>('/analytics/overview', { tenant }),
  });

// Scorecard (§9): src/modules/analytics/services/scorecard.ts. A cell's value is null when there is nothing to show.

export type Tone = 'good' | 'neutral' | 'attention';
export type Cell = { value: number | null; sub?: string; tone: Tone | null };
export type SellerRow = {
  seller_user_id: string;
  name: string;
  assigned: number;
  accepted: Cell;
  time_to_accept: Cell;
  steps_on_time: Cell;
  meetings: Cell;
  opportunities: Cell;
  won: Cell;
  pipeline_cents: Cell;
  win_rate: Cell;
};
export type OfferRow = {
  offer_id: string;
  name: string;
  practice_name: string | null;
  price_label: string | null;
  matched: Cell;
  opportunities: Cell;
  won: Cell;
  win_rate: Cell;
  won_value_cents: Cell;
  pipeline_cents: Cell;
};
export type PracticeRow = {
  practice_id: string;
  name: string;
  lead_name: string | null;
  offers: number;
  active_offers: number;
  matched: Cell;
  opportunities: Cell;
  won: Cell;
  win_rate: Cell;
  won_value_cents: Cell;
  pipeline_cents: Cell;
};
export type ScorecardTab = 'sellers' | 'offers' | 'practices';
export type Scorecard = { tab: ScorecardTab; quarter_label: string; rows: (SellerRow | OfferRow | PracticeRow)[]; team: Record<string, number | null> | null };

export const scorecardQuery = (tenant: string, tab: ScorecardTab) =>
  queryOptions({
    queryKey: ['overview', tenant, 'scorecard', tab],
    queryFn: () => apiFetch<Scorecard>(`/analytics/scorecard?tab=${tab}`, { tenant }),
  });

// The drawer behind a number: src/modules/analytics/services/metric-detail.ts. `value` and the breakdown values arrive formatted.

export type MetricDetail = {
  eyebrow: string;
  title: string;
  value: string;
  change_pct: number | null;
  definition: string;
  notes: { label: string; value: string }[];
  breakdowns: { label: string; items: { name: string; count: number; value: string }[] }[];
  accounts: { account_id: string; name: string; meta: string; at: string }[];
  total: number;
  see_all: { stage?: string; owner?: string; offer?: string; practice?: string } | null;
};

export const metricQuery = (tenant: string, { key, scope }: Selection) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(scope ?? {})) if (v) q.set(k, v);
  const qs = q.toString();
  return queryOptions({
    queryKey: ['overview', tenant, 'metric', key, scope ?? null],
    queryFn: () => apiFetch<MetricDetail>(`/analytics/metrics/${encodeURIComponent(key)}${qs ? `?${qs}` : ''}`, { tenant }),
  });
};
