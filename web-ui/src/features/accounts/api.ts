import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { API_BASE, apiFetch, newCorrelationId } from '../../api/client';
import { errorFrom } from '../../api/errors';
import type { FacetOption, LeadOffer, SourceRef } from '../review/api';

// My accounts (src/http/routes/v1/assignments) and All accounts (accounts, accounts/facets, accounts/export).

/** My accounts refreshes every 30 seconds while visible (C14). */
export const MY_REFRESH_MS = 30_000;

export type Activity = { kind: string; at: string };

/** A CRM activity in words. */
export const ACTIVITY: Record<string, string> = {
  email: 'Email sent',
  reply: 'Email reply',
  call: 'Call',
  meeting: 'Meeting held',
  task_done: 'Task done',
};
export const activityText = (a: Activity) => ACTIVITY[a.kind] ?? a.kind;

/** The next open step of the account's running playbook. `due_date` is a plain "YYYY-MM-DD". */
export type NextStep = { title: string; due_date: string; overdue: boolean; due_today: boolean };

export type Assignment = {
  id: string;
  account_id: string;
  account_name: string | null;
  seller_user_id: string;
  seller_name: string | null;
  assigned_by: string;
  assigned_by_name: string | null;
  assigned_at: string;
  status: 'pending' | 'accepted' | 'declined' | 'withdrawn' | 'replaced';
  responded_at: string | null;
  accepted_how: 'seller' | 'crm_activity' | 'auto_timeout' | null;
  notes: string | null;
  offer_id: string | null;
  offer_name: string | null;
  playbook_name: string | null;
  next_step: NextStep | null;
  stage: string | null;
  stage_label: string | null;
  last_activity: Activity | null;
  handoff: { state: string; at: string } | null;
};

type Page<T> = { data: T[]; next_cursor: string | null };

export const myAssignmentsQuery = (tenant: string, status: 'pending' | 'accepted') =>
  infiniteQueryOptions({
    queryKey: ['my-assignments', tenant, status],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      apiFetch<Page<Assignment>>(`/assignments?mine=true&status=${status}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`, { tenant }),
    getNextPageParam: (last) => last.next_cursor,
    refetchInterval: MY_REFRESH_MS,
  });

export const acceptAssignment = (tenant: string, id: string) => apiFetch<Assignment>(`/assignments/${encodeURIComponent(id)}:accept`, { tenant, method: 'POST' });

export const declineAssignment = (tenant: string, id: string, body: { reason_key: string; note?: string }) =>
  apiFetch<Assignment>(`/assignments/${encodeURIComponent(id)}:decline`, { tenant, method: 'POST', body });

/** Opening an assigned account clears its "New from {source}" flag. */
export const markSeen = (tenant: string, accountId: string) => apiFetch<unknown>(`/accounts/${encodeURIComponent(accountId)}:seen`, { tenant, method: 'POST' });

export type AccountRow = {
  account_id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  hq_city: string | null;
  hq_state: string | null;
  priority: number | null;
  stage: string | null;
  stage_label: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  practice_name: string | null;
  lead_offer: LeadOffer | null;
  source: SourceRef | null;
  next_step?: NextStep | null;
  last_activity: Activity | null;
  value: { amount_cents: number | null; currency: string | null; kind: 'won' | 'open_deal' | 'estimated'; deal_name: string | null } | null;
};

export type AccountFacets = {
  total: number;
  won_this_year: number;
  stages: { key: string; label: string; count: number }[];
  owners: FacetOption[];
  practices: FacetOption[];
  sources: FacetOption[];
};

/** All accounts' URL search params (C10). `owner` is a user id or `unassigned`. */
export type AccountsFilters = { stage?: string; q?: string; owner?: string; practice?: string; source?: string; offer?: string };

export function accountsParams(f: AccountsFilters): URLSearchParams {
  const p = new URLSearchParams({ sort: 'stage_priority' });
  if (f.stage) p.set('stage', f.stage);
  if (f.q) p.set('q', f.q);
  if (f.owner === 'unassigned') p.set('unassigned', 'true');
  else if (f.owner) p.set('owner_user_id', f.owner);
  if (f.practice) p.set('practice_id', f.practice);
  if (f.source) p.set('source_id', f.source);
  if (f.offer) p.set('offer_id', f.offer);
  return p;
}

export const accountsQuery = (tenant: string, f: AccountsFilters) =>
  infiniteQueryOptions({
    queryKey: ['accounts', tenant, 'list', f],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const p = accountsParams(f);
      if (pageParam) p.set('cursor', pageParam);
      return apiFetch<Page<AccountRow> & { total: number }>(`/accounts?${p}`, { tenant });
    },
    getNextPageParam: (last) => last.next_cursor,
  });

export const accountFacetsQuery = (tenant: string, f: AccountsFilters) =>
  queryOptions({
    queryKey: ['accounts', tenant, 'facets', f],
    queryFn: () => apiFetch<AccountFacets>(`/accounts/facets?${accountsParams(f)}`, { tenant }),
  });

/**
 * `Export CSV`: the file for the same filters, and how many rows it holds (`x-scout-row-count`).
 * A plain fetch, since the answer is CSV, not JSON; a failure is the API's problem as an ApiError.
 */
export async function exportAccounts(tenant: string, f: AccountsFilters): Promise<{ blob: Blob; count: number }> {
  const p = accountsParams(f);
  const ref = newCorrelationId();
  const res = await fetch(`${API_BASE}/accounts/export?${p}`, { credentials: 'include', headers: { 'x-scout-tenant': tenant, 'x-correlation-id': ref, accept: 'text/csv, application/problem+json' } });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    throw errorFrom(res.status, body, res.headers.get('x-correlation-id') ?? ref);
  }
  return { blob: await res.blob(), count: Number(res.headers.get('x-scout-row-count') ?? 0) };
}
