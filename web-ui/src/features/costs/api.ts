import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { apiFetch } from '../../api/client';

// Costs (R3a): src/http/routes/v1/costs/** and integrations/{key}/rates. Money is integer cents in the workspace currency.

export type CostCategory = 'partner_fees' | 'data_vendors' | 'agents_hosting' | 'lists_events' | 'ai_usage';
export type BudgetLevel = 'ok' | 'alert' | 'over' | 'paused';

export type CategorySummary = {
  key: CostCategory;
  label: string;
  spend_90d_cents: number;
  spend_month_cents: number;
  budget_cents: number | null;
  level: BudgetLevel;
  pausable: boolean;
};

export type CostsSummary = {
  /** The current month, "YYYY-MM". */
  month: string;
  spend_month_cents: number;
  budget_month_cents: number;
  spend_90d_cents: number;
  categories: CategorySummary[];
  months: { month: string; spend_cents: number; budget_cents: number }[];
  /** Over the last 90 days (R3b-1 Ruling 12): null when there is nothing to divide by. */
  cost_per_sent_cents: number | null;
  cost_per_won_cents: number | null;
  return_ratio: number | null;
  target_cost_per_won_cents: number | null;
};

/** One top-level source in "Cost by source", or the Shared costs row (`source_id` null, with only spend and share). */
export type BySourceRow = {
  source_id: string | null;
  name: string;
  kind?: string;
  spend_cents: number;
  share_pct: number | null;
  per_sent_cents?: number | null;
  per_assigned_cents?: number | null;
  per_won_cents?: number | null;
  return_ratio?: number | null;
};
export type BySource = { rows: BySourceRow[]; total_spend_cents: number };

export type BudgetsView = {
  month: string;
  total_cents: number;
  budgets: { category: CostCategory; label: string; amount_cents: number | null; pausable: boolean }[];
};

export type CostLine = {
  id: string;
  occurred_on: string;
  category: CostCategory;
  provider: string | null;
  amount_cents: number;
  origin: 'usage' | 'manual';
  account_id: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
  voided_at: string | null;
  void_reason: string | null;
  voided_by: string | null;
  replaces_id: string | null;
  source_id: string | null;
  source_name: string | null;
};

export type LineBody = { occurred_on: string; category: CostCategory; amount_cents: number; note: string | null; source_id: string | null };

export type Rate = { item: string; cents_per_unit: number; is_default: boolean };

type LinesPage = { data: CostLine[]; next_cursor: string | null };

export const costsKey = (tenant: string) => ['costs', tenant] as const;

export const summaryQuery = (tenant: string, enabled = true) =>
  queryOptions({
    queryKey: [...costsKey(tenant), 'summary'],
    queryFn: () => apiFetch<CostsSummary>('/costs/summary', { tenant }),
    enabled,
  });

export const saveBudgets = (tenant: string, month: string, budgets: { category: CostCategory; amount_cents: number }[]) =>
  apiFetch<BudgetsView>('/costs/budgets', { tenant, method: 'PUT', body: { month, budgets } });

export const bySourceQuery = (tenant: string) =>
  queryOptions({
    queryKey: [...costsKey(tenant), 'by-source'],
    queryFn: () => apiFetch<BySource>('/costs/by-source', { tenant }),
  });

/** The one workspace target for cost per won account, in cents; null clears it. */
export const saveTarget = (tenant: string, cents: number | null) =>
  apiFetch<{ target_cost_per_won_cents: number | null }>('/costs/target', { tenant, method: 'PUT', body: { target_cost_per_won_cents: cents } });

/** Cost lines newest first, 50 a page; the next page by cursor. */
export const linesQuery = (tenant: string, includeVoided: boolean) =>
  infiniteQueryOptions({
    queryKey: [...costsKey(tenant), 'lines', includeVoided],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (includeVoided) params.set('include_voided', 'true');
      if (pageParam) params.set('cursor', pageParam);
      const query = params.toString();
      return apiFetch<LinesPage>(`/costs/lines${query ? `?${query}` : ''}`, { tenant });
    },
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });

export const addLine = (tenant: string, body: LineBody) => apiFetch<CostLine>('/costs/lines', { tenant, method: 'POST', body });
export const editLine = (tenant: string, id: string, body: LineBody) => apiFetch<CostLine>(`/costs/lines/${encodeURIComponent(id)}`, { tenant, method: 'PATCH', body });
export const voidLine = (tenant: string, id: string, reason: string) =>
  apiFetch<CostLine>(`/costs/lines/${encodeURIComponent(id)}:void`, { tenant, method: 'POST', body: { reason } });

export const ratesQuery = (tenant: string, provider: string) =>
  queryOptions({
    queryKey: ['integrations', tenant, 'rates', provider],
    queryFn: () => apiFetch<{ data: Rate[] }>(`/integrations/${encodeURIComponent(provider)}/rates`, { tenant }).then((r) => r.data),
  });

export const saveRates = (tenant: string, provider: string, rates: { item: string; cents_per_unit: number }[]) =>
  apiFetch<{ data: Rate[] }>(`/integrations/${encodeURIComponent(provider)}/rates`, { tenant, method: 'PUT', body: { rates } });

export const CATEGORY_WORD: Record<CostCategory, string> = {
  partner_fees: 'Partner fees',
  data_vendors: 'Data vendors',
  agents_hosting: 'Agents and hosting',
  lists_events: 'Lists and events',
  ai_usage: 'AI usage',
};
export const CATEGORIES = Object.keys(CATEGORY_WORD) as CostCategory[];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "2026-11" is "November"; `short` gives "Nov". */
export const monthName = (month: string, short = false) => {
  const name = MONTHS[Number(month.slice(5, 7)) - 1] ?? month;
  return short ? name.slice(0, 3) : name;
};

/** Whole percent, rounded down, so 99.9% reads 99%. */
export const percentOf = (part: number, whole: number) => Math.floor((part * 100) / whole);

/** The budget banners (Ruling 12), paused first. */
export function bannerLines(s: CostsSummary): { key: string; text: string; paused: boolean }[] {
  const month = monthName(s.month);
  return s.categories
    .filter((c) => c.level !== 'ok' && c.budget_cents)
    .map((c) => ({
      key: c.key,
      paused: c.level === 'paused',
      text:
        c.level === 'paused'
          ? `${c.label} is paused: it is over 110% of its ${month} budget. Raise the budget to resume.`
          : `${c.label} has used ${percentOf(c.spend_month_cents, c.budget_cents!)}% of its ${month} budget.`,
    }))
    .sort((a, b) => Number(b.paused) - Number(a.paused));
}
