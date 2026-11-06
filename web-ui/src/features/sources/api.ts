import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { apiFetch } from '../../api/client';
import type { AccountFacets, AccountRow } from '../accounts/api';

// Sources (§10), the Source page (§11) and Add a source (§12): src/http/routes/v1/sources/**,
// members/directory, feedback?source_id, accounts?source_id and batches?source_id. Every number,
// label and percentage comes from the API (C6 to C8).

export type SourceKind = 'person' | 'agent' | 'vendor' | 'list' | 'partner' | 'crm' | 'web_form' | 'scheduled_pull';

export type ActiveKey = { id: string; prefix: string; last_used_at: string | null; created_at: string };

export type Source = {
  id: string;
  name: string;
  kind: SourceKind;
  kind_label: string;
  status: 'active' | 'paused' | 'archived';
  status_label: string;
  parent_id: string | null;
  parent: { id: string; name: string; kind: string } | null;
  owner: { user_id: string; name: string } | null;
  method: 'api_key' | 'through_parent' | 'through_children' | 'file_upload' | 'hubspot_sync' | 'none';
  method_label: string;
  active_key: ActiveKey | null;
  created_at: string;
  last_sent_at: string | null;
  has_sent: boolean;
  arrivals_last_30_days: number;
  trust: null;
  trust_label: string;
  children_count: number;
  is_new: boolean;
  can_remove: boolean;
  can_archive: boolean;
};

export type SourcesMeta = { counts_by_kind: Record<string, number>; kind_labels: Record<string, string>; can_add_crm: boolean };
export type SourcesPage = { data: Source[]; next_cursor: string | null; meta: SourcesMeta };

export type SourceDetail = Source & {
  breadcrumb: { id: string; name: string }[];
  daily_arrival_cap: number;
  initial_review_status_key: string;
  sync: { last_polled_at: string | null; last_error: string | null; connected: boolean } | null;
};

export type SourceStat = {
  source_id: string;
  sent: number;
  reviewed: number;
  assigned: number;
  won: number;
  reviewed_pct: number | null;
  assigned_pct: number | null;
  won_pct: number | null;
  by_stage: { key: string; label: string; count: number }[];
  is_new: boolean;
  /** All-time spend and spend / won: null without costs:read (the second is also null with no wins). */
  spend_cents: number | null;
  cost_per_won_cents: number | null;
};

export type SourceKey = { id: string; name: string; prefix: string; mask: string; created_at: string; last_used_at: string | null; revoked_at: string | null };

export type NewKey = { id: string; prefix: string; secret: string; environment: 'live' | 'test'; created_at: string };

export type Feedback = { id: string; kind: string; account_id: string; account_name: string | null; summary: string; note: string | null; created_at: string };

export type Member = { user_id: string; name: string };

export type SourceAccount = AccountRow & {
  tier: string | null;
  tier_label: string | null;
  created_at: string;
  first_arrival: { at: string; batch_id: string | null; batch_name: string | null; source_id: string; source_name: string } | null;
};

/** The Sources screen's search params (C10): `kind` comma separated. */
export type SourcesFilters = { kind?: string; q?: string };

/** Every source the caller can see, in tree order: the list is short, so one page of 200. */
export const sourcesQuery = (tenant: string, f: SourcesFilters = {}) =>
  queryOptions({
    queryKey: ['sources', tenant, 'list', f],
    queryFn: () => {
      const p = new URLSearchParams({ limit: '200' });
      if (f.kind) p.set('kind', f.kind);
      if (f.q) p.set('q', f.q);
      return apiFetch<SourcesPage>(`/sources?${p}`, { tenant });
    },
  });

export const statsQuery = (tenant: string) =>
  queryOptions({
    queryKey: ['sources', tenant, 'stats'],
    queryFn: () => apiFetch<{ data: SourceStat[] }>('/sources/stats', { tenant }).then((r) => new Map(r.data.map((s) => [s.source_id, s]))),
  });

export const sourceQuery = (tenant: string, id: string) =>
  queryOptions({
    queryKey: ['sources', tenant, 'one', id],
    queryFn: () => apiFetch<SourceDetail>(`/sources/${encodeURIComponent(id)}`, { tenant }),
  });

export const sourceKeysQuery = (tenant: string, id: string) =>
  queryOptions({
    queryKey: ['sources', tenant, 'keys', id],
    queryFn: () => apiFetch<{ data: SourceKey[] }>(`/sources/${encodeURIComponent(id)}/keys`, { tenant }).then((r) => r.data.filter((k) => !k.revoked_at)),
  });

export const feedbackQuery = (tenant: string, id: string) =>
  queryOptions({
    queryKey: ['sources', tenant, 'feedback', id],
    queryFn: () => apiFetch<{ data: Feedback[] }>(`/feedback?source_id=${encodeURIComponent(id)}&limit=10`, { tenant }).then((r) => r.data),
  });

export const directoryQuery = (tenant: string) =>
  queryOptions({
    queryKey: ['members', tenant, 'directory'],
    queryFn: () => apiFetch<{ data: Member[] }>('/members/directory', { tenant }).then((r) => r.data),
    staleTime: 60_000,
  });

/** The Accounts tab's search params (C10). */
export type SourceAccountsFilters = { q?: string; stage?: string; tier?: string };

function accountParams(sourceId: string, f: SourceAccountsFilters) {
  const p = new URLSearchParams({ source_id: sourceId, sort: 'created' });
  if (f.q) p.set('q', f.q);
  if (f.stage) p.set('stage', f.stage);
  if (f.tier) p.set('tier', f.tier);
  return p;
}

export const sourceAccountsQuery = (tenant: string, sourceId: string, f: SourceAccountsFilters) =>
  infiniteQueryOptions({
    queryKey: ['sources', tenant, 'accounts', sourceId, f],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const p = accountParams(sourceId, f);
      if (pageParam) p.set('cursor', pageParam);
      return apiFetch<{ data: SourceAccount[]; next_cursor: string | null; total: number }>(`/accounts?${p}`, { tenant });
    },
    getNextPageParam: (last) => last.next_cursor,
  });

export const sourceAccountFacetsQuery = (tenant: string, sourceId: string, f: SourceAccountsFilters) =>
  queryOptions({
    queryKey: ['sources', tenant, 'account-facets', sourceId, f],
    queryFn: () => apiFetch<AccountFacets & { tiers: { value: string; label: string; count: number }[] }>(`/accounts/facets?${accountParams(sourceId, f)}`, { tenant }),
  });

export type SourcePatch = { status?: 'active' | 'paused' | 'archived'; owner_user_id?: string | null; name?: string };

export const patchSource = (tenant: string, id: string, body: SourcePatch) => apiFetch<SourceDetail>(`/sources/${encodeURIComponent(id)}`, { tenant, method: 'PATCH', body });

export const removeSource = (tenant: string, id: string) => apiFetch<void>(`/sources/${encodeURIComponent(id)}`, { tenant, method: 'DELETE' });

export const syncSource = (tenant: string, id: string) => apiFetch<{ queued: true }>(`/sources/${encodeURIComponent(id)}:sync`, { tenant, method: 'POST' });

export const createSourceKey = (tenant: string, id: string, name: string) =>
  apiFetch<NewKey & { name: string }>(`/sources/${encodeURIComponent(id)}/keys`, { tenant, method: 'POST', body: { name } });

export const rotateKey = (tenant: string, id: string, keyId: string) =>
  apiFetch<NewKey>(`/sources/${encodeURIComponent(id)}/keys/${encodeURIComponent(keyId)}:rotate`, { tenant, method: 'POST' });

export const revokeKey = (tenant: string, id: string, keyId: string) =>
  apiFetch<void>(`/sources/${encodeURIComponent(id)}/keys/${encodeURIComponent(keyId)}`, { tenant, method: 'DELETE' });

export type NewSource = { kind: SourceKind; name: string; parent_id?: string; owner_user_id?: string | null; create_key?: boolean };

export const createSource = (tenant: string, body: NewSource) => apiFetch<SourceDetail & { api_key?: NewKey }>('/sources', { tenant, method: 'POST', body });

/** The Source page's tabs; the children tab is "Runs" under a person and "Pulls from" otherwise. */
export const childTab = (kind: string) => (kind === 'person' ? { id: 'runs', label: 'Runs' } : { id: 'pulls-from', label: 'Pulls from' });
