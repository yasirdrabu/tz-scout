import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { apiFetch } from '../../api/client';

// The review queue, the peek drawer, Send back and Assign (src/http/routes/v1/review-queue,
// accounts/{id}/..., settings/review/statuses and reasons, assignable-sellers). Words, colors,
// counts and the best match come from the API (C6 to C8).

/** Every 30 seconds while the page is visible (C14). */
export const QUEUE_REFRESH_MS = 30_000;

export type Color = 'plum' | 'amber' | 'green' | 'red' | 'gray';

export type HandoffState = 'sending' | 'in_crm' | 'needs_decision' | 'failed' | 'cancelled';

export type RowFlags = {
  declined_by_seller?: { assignment_id: string; seller_user_id: string; seller_name: string; reason_key: string; reason_label: string; at: string };
  new_from?: { source_id: string; at: string; source_name: string | null };
  handoff?: { handoff_id: string | null; state: HandoffState; reason?: string; current_owner_name?: string | null; at: string };
};

export type LeadOffer = { offer_id: string; name: string | null; practice_id: string | null; practice_name: string | null; chosen: boolean };

export type SourceRef = { source_id: string; name: string; kind: string; via: string | null };

/** What the Send-back and Assign dialogs read of an account: a queue row, or the account page's own. */
export type DialogAccount = { account_id: string; name: string; lead_offer: LeadOffer | null; source: SourceRef | null };

export type QueueRow = {
  account_id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  hq_city: string | null;
  hq_state: string | null;
  tier: string | null;
  priority: number | null;
  fit: number | null;
  intent: number | null;
  best_offer_id: string | null;
  practice_id: string | null;
  practice_name: string | null;
  review_status_key: string | null;
  review_status_label: string | null;
  review_status_color: Color | null;
  status_changed_at: string | null;
  status_changed_by_name: string | null;
  stage: string | null;
  created_at: string;
  flags: RowFlags;
  conflict_count: number;
  enrichment_requested: boolean;
  source: SourceRef | null;
  lead_offer: LeadOffer | null;
  previous_tier: string | null;
  scored_tier: string | null;
  tier_set_by_name: string | null;
  tier_set_at: string | null;
  tier_note: string | null;
  warm_intro: { introducer_name: string | null; points: number } | null;
  note_count: number;
};

export type FacetOption = { value: string; label: string; count: number };

export type QueueFacets = {
  total: number;
  /** The "All" tab: the total with every filter but the tier. */
  total_all_tiers: number;
  /** "Loading accounts from {n} sources". */
  source_count: number;
  oldest_arrived_at: string | null;
  last_reviewed_at: string | null;
  tiers: FacetOption[];
  practices: FacetOption[];
  offers: FacetOption[];
  sources: FacetOption[];
  statuses: (FacetOption & { color: Color })[];
};

/** What the queue is filtered by: the URL's search params (C10). `status` keys are comma separated. */
export type QueueFilters = { tier?: string; practice?: string; offer?: string; source?: string; status?: string };

function queueParams(f: QueueFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.tier) p.set('tier', f.tier);
  if (f.practice) p.set('practice_id', f.practice);
  if (f.offer) p.set('offer_id', f.offer);
  if (f.source) p.set('source_id', f.source);
  if (f.status) p.set('status', f.status);
  return p;
}

const withQuery = (path: string, p: URLSearchParams) => {
  const qs = p.toString();
  return qs ? `${path}?${qs}` : path;
};

type Page<T> = { data: T[]; next_cursor: string | null };

export const queueQuery = (tenant: string, f: QueueFilters) =>
  infiniteQueryOptions({
    queryKey: ['review-queue', tenant, 'rows', f],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const p = queueParams(f);
      if (pageParam) p.set('cursor', pageParam);
      return apiFetch<Page<QueueRow>>(withQuery('/review-queue', p), { tenant });
    },
    getNextPageParam: (last) => last.next_cursor,
    refetchInterval: QUEUE_REFRESH_MS,
  });

export const facetsQuery = (tenant: string, f: QueueFilters) =>
  queryOptions({
    queryKey: ['review-queue', tenant, 'facets', f],
    queryFn: () => apiFetch<QueueFacets>(withQuery('/review-queue/facets', queueParams(f)), { tenant }),
    refetchInterval: QUEUE_REFRESH_MS,
  });

/** The last scoring settings change in the last 7 days, for the banner (Ruling 16); null when there is none. */
export type LastRescore = {
  version: number;
  changed_at: string;
  changed_by_name: string | null;
  summary: string;
  weights_text: string;
  tier_changed_count: number;
};

export const lastRescoreQuery = (tenant: string) =>
  queryOptions({
    queryKey: ['review-queue', tenant, 'last-rescore'],
    queryFn: () => apiFetch<{ data: LastRescore | null }>('/scoring/last-rescore', { tenant }),
    select: (r) => r.data,
    staleTime: 5 * 60_000,
  });

export type Column = { key: string; label: string; visible: boolean };
export type Columns = { columns: Column[]; shown: number; total: number; is_default: boolean };

export const columnsQuery = (tenant: string) =>
  queryOptions({
    queryKey: ['review-queue-columns', tenant],
    queryFn: () => apiFetch<Columns>('/me/preferences/review-queue-columns', { tenant }),
    staleTime: Infinity,
  });

export const saveColumns = (tenant: string, columns: Column[]) =>
  apiFetch<Columns>('/me/preferences/review-queue-columns', {
    tenant,
    method: 'PUT',
    body: { columns: columns.map((c) => ({ key: c.key, visible: c.visible })) },
  });

export const resetColumns = (tenant: string) => apiFetch<Columns>('/me/preferences/review-queue-columns', { tenant, method: 'DELETE' });

export type ReviewStatus = {
  key: string;
  label: string;
  color: Color;
  description: string | null;
  set_by: 'scout' | 'reviewer';
  is_declined: boolean;
  is_initial: boolean;
  returns_to_source: boolean;
  counts_as_reviewed: boolean;
  archived: boolean;
};

export type Reason = { key: string; label: string; applies_to: 'review' | 'assignment' | 'both' | 'send_back'; note_required: boolean; archived: boolean };

export const statusesQuery = (tenant: string) =>
  queryOptions({
    queryKey: ['review-statuses', tenant],
    queryFn: () => apiFetch<{ data: ReviewStatus[] }>('/settings/review/statuses', { tenant }),
    staleTime: 5 * 60_000,
  });

export const reasonsQuery = (tenant: string) =>
  queryOptions({
    queryKey: ['review-reasons', tenant],
    queryFn: () => apiFetch<{ data: Reason[] }>('/settings/review/reasons', { tenant }),
    staleTime: 5 * 60_000,
  });

/** The live reasons of one list: send backs, review declines (Not pursued) or a seller's decline. */
export function reasonsFor(reasons: Reason[], list: 'send_back' | 'review' | 'assignment'): Reason[] {
  return reasons.filter((r) => !r.archived && (r.applies_to === list || (list !== 'send_back' && r.applies_to === 'both')));
}

export type Offer = { id: string; name: string; practice_id: string | null; status: string };

export const offersQuery = (tenant: string) =>
  queryOptions({
    queryKey: ['offers', tenant, 'approved'],
    queryFn: () => apiFetch<Page<Offer>>('/offers?status=approved&limit=200', { tenant }),
    staleTime: 5 * 60_000,
  });

export type CurrentAssignment = {
  id: string;
  seller_user_id: string;
  seller_name: string | null;
  assigned_by_name: string | null;
  assigned_at: string;
  notes: string | null;
  status: string;
  accepted_how: 'seller' | 'crm_activity' | 'auto_timeout' | null;
  responded_at: string | null;
};

export type AccountReview = {
  account_id: string;
  status: { key: string; label: string; color: Color; set_by: string; changed_at: string | null; changed_by_name: string | null } | null;
  stage: string | null;
  stage_label: string | null;
  /** One step per pipeline stage, names and order from the API (C6). */
  stages?: { key: string; label: string; at: string | null; current: boolean }[];
  flags?: RowFlags;
  current_assignment?: CurrentAssignment | null;
  approved?: { by_name: string | null; at: string } | null;
  sources: {
    source_id: string;
    name: string;
    kind: string;
    via: string | null;
    owner_user_id: string | null;
    owner_name: string | null;
    batch_id?: string | null;
    arrived_at: string | null;
  }[];
  lead_offer?: LeadOffer | null;
  version: number;
};

export const reviewQuery = (tenant: string, id: string) =>
  queryOptions({
    queryKey: ['account', tenant, id, 'review'],
    queryFn: () => apiFetch<AccountReview>(`/accounts/${encodeURIComponent(id)}/review`, { tenant }),
  });

export type Signal = { id: string; title: string; detail: string | null; url: string | null; occurred_at: string | null };

export const signalsQuery = (tenant: string, id: string) =>
  queryOptions({
    queryKey: ['account', tenant, id, 'detail'],
    queryFn: () => apiFetch<{ id: string; signals: Signal[] }>(`/accounts/${encodeURIComponent(id)}`, { tenant }),
    select: (a) => a.signals,
  });

export type Note = { id: string; body: string; by_user_id: string; by_name: string | null; at: string };

export const notesQuery = (tenant: string, id: string) =>
  queryOptions({
    queryKey: ['account', tenant, id, 'notes'],
    queryFn: () => apiFetch<{ data: Note[]; total: number }>(`/accounts/${encodeURIComponent(id)}/notes`, { tenant }),
  });

export const addNote = (tenant: string, id: string, body: string) =>
  apiFetch<Note>(`/accounts/${encodeURIComponent(id)}/notes`, { tenant, method: 'POST', body: { body } });

export type Change = {
  id: string;
  at: string;
  kind: 'arrived' | 'status' | 'stage' | 'assigned' | 'accepted' | 'declined_by_seller' | 'withdrawn' | 'scored' | 'tier' | 'lead_offer';
  field: string | null;
  from: string | null;
  to: string | null;
  by_name: string | null;
  note: string | null;
  reason: string | null;
  priority: number | null;
};

export const changesQuery = (tenant: string, id: string) =>
  queryOptions({
    queryKey: ['account', tenant, id, 'changes'],
    queryFn: () => apiFetch<Page<Change>>(`/accounts/${encodeURIComponent(id)}/changes?limit=20`, { tenant }),
  });

export const setTier = (tenant: string, id: string, tier: string | null, note: string | null) =>
  apiFetch<unknown>(`/accounts/${encodeURIComponent(id)}/tier`, { tenant, method: 'PUT', body: { tier, ...(note ? { note } : {}) } });

export const setLeadOffer = (tenant: string, id: string, offerId: string | null) =>
  apiFetch<unknown>(`/accounts/${encodeURIComponent(id)}/lead-offer`, { tenant, method: 'PUT', body: { offer_id: offerId } });

export type StatusChange = { to: string; reason_key?: string; note?: string };

export const changeStatus = (tenant: string, id: string, change: StatusChange) =>
  apiFetch<unknown>(`/accounts/${encodeURIComponent(id)}/review-status`, { tenant, method: 'PATCH', body: change });

export type BulkResult = { account_id: string; ok: true } | { account_id: string; ok: false; status: number; message: string };

export type BulkAction =
  | ({ action: 'status' } & StatusChange)
  | { action: 'assign'; seller_user_id: string; notes?: string; ownership_decision?: 'assign' | 'keep'; ownership_decisions?: Record<string, 'assign' | 'keep'> };

export const bulk = (tenant: string, accountIds: string[], action: BulkAction) =>
  apiFetch<{ results: BulkResult[] }>('/review-queue/bulk', { tenant, method: 'POST', body: { account_ids: accountIds, ...action } });

export type Seller = {
  user_id: string;
  name: string;
  practices: { id: string; name: string }[];
  all_practices: boolean;
  active_accounts: number;
  crm_owner_linked: boolean;
};

export type Sellers = { data: Seller[]; best_match: { user_id: string; reason: string } | null };

export const sellersQuery = (tenant: string, accountIds: string[]) =>
  queryOptions({
    queryKey: ['assignable-sellers', tenant, accountIds],
    queryFn: () => apiFetch<Sellers>(`/assignable-sellers?account_ids=${accountIds.map(encodeURIComponent).join(',')}`, { tenant }),
  });

export type Preflight = {
  result: 'new' | 'assign' | 'stop' | 'blocked';
  message: string;
  /** Why the CRM stops a takeover. */
  reason: 'open_deal' | 'customer' | 'owned_elsewhere' | 'no_owner' | null;
  current_owner_name: string | null;
  /** The top open deal, only when `reason` is `open_deal`. */
  deal: { name: string; amount_cents: number | null; currency: string | null; last_activity_at: string | null } | null;
};

export type Preview = {
  preflight: Preflight;
  approves_to: { key: string; label: string } | null;
  replaces: { assignment_id: string; seller_user_id: string } | null;
};

export const previewAssign = (tenant: string, id: string, sellerUserId: string) =>
  apiFetch<Preview>(`/accounts/${encodeURIComponent(id)}:assign-preview`, { tenant, method: 'POST', body: { seller_user_id: sellerUserId } });

export type BulkPreviewRow = ({ account_id: string; ok: true } & Preview) | { account_id: string; ok: false; status: number; message: string };

/** The bulk dialog's preview: one request for every account, from the stored HubSpot check (Ruling 17). */
export const previewBulkAssign = (tenant: string, accountIds: string[], sellerUserId: string) =>
  apiFetch<{ data: BulkPreviewRow[] }>('/review-queue/assign-preview', { tenant, method: 'POST', body: { account_ids: accountIds, seller_user_id: sellerUserId } });

export const assign = (tenant: string, id: string, body: { seller_user_id: string; notes?: string; ownership_decision?: 'assign' | 'keep' }) =>
  apiFetch<{ id: string }>(`/accounts/${encodeURIComponent(id)}:assign`, { tenant, method: 'POST', body });

/** Sends the account to the CRM again after a failed handoff (`crm:push`). */
export const retryPush = (tenant: string, id: string) => apiFetch<{ handoff_id: string }>(`/accounts/${encodeURIComponent(id)}:push`, { tenant, method: 'POST' });
