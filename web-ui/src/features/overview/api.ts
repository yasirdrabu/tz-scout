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

/** What a click on a number asks the detail drawer to show (Task 7 fills the slot). */
export type Selection = { key: 'pipeline_value' | 'won_value' | 'sent_to_won' | 'days_to_win' | 'stage' | 'exit'; scope?: { stage: string } };

export const overviewQuery = (tenant: string) =>
  queryOptions({
    queryKey: ['overview', tenant],
    queryFn: () => apiFetch<Overview>('/analytics/overview', { tenant }),
  });
