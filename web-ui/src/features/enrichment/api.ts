import { queryOptions } from '@tanstack/react-query';
import { apiFetch } from '../../api/client';

// Enrichment requests (src/http/routes/v1/enrichment-requests, accounts/[id]/enrichment-*). Labels,
// status words and estimate text are the API's (C6).

export type EnrichmentKind = 'company_firmographics' | 'people_for_roles' | 'email_reveal' | 'website_read' | 'signals_refresh';

export type EnrichmentStatus = 'flagged' | 'approved' | 'running' | 'completed' | 'partial' | 'failed' | 'declined' | 'cancelled';

export type EnrichmentRequest = {
  id: string;
  account_id: string;
  account_name: string | null;
  kind: EnrichmentKind;
  kind_label: string;
  provider_key: string;
  provider_name: string;
  status: EnrichmentStatus;
  status_text: string;
  requested_by_label: string | null;
  reason: string | null;
  estimate: { credits: number; cost_cents: number; text: string } | null;
  created_at: string;
  decided_by_label: string | null;
  decided_at: string | null;
  decline_reason: string | null;
  result: unknown;
  error: { kind: string; message: string } | null;
  waiting_reason: string | null;
  sample: boolean;
};

export type Estimate = { credits: number; cost_cents: number; currency: string; sample: boolean; text: string };

export type NewRequest = { kind: EnrichmentKind; provider_key: string; roles?: string[]; person_ids?: string[]; reason?: string };

/** While a request is approved or running, the account's requests refetch this often. */
export const RUNNING_REFRESH_MS = 10_000;

const path = (id: string, rest: string) => `/accounts/${encodeURIComponent(id)}${rest}`;

/** Keyed on every choice, so a change in the dialog asks again. */
export const estimateQuery = (tenant: string, id: string, req: Omit<NewRequest, 'reason'>) => {
  const q = new URLSearchParams({ kind: req.kind, provider_key: req.provider_key });
  if (req.roles) q.set('roles', req.roles.join(','));
  if (req.person_ids) q.set('person_ids', req.person_ids.join(','));
  return queryOptions({
    queryKey: ['account', tenant, id, 'enrichment-estimate', req.kind, req.provider_key, req.roles ?? null, req.person_ids ?? null],
    queryFn: () => apiFetch<Estimate>(path(id, `/enrichment-estimate?${q.toString()}`), { tenant }),
  });
};

/** The account's requests, newest first. Under the account's key, so a change to the account refetches it. */
export const accountRequestsQuery = (tenant: string, id: string) =>
  queryOptions({
    queryKey: ['account', tenant, id, 'enrichment-requests'],
    queryFn: () => apiFetch<{ data: EnrichmentRequest[]; next_cursor: string | null }>(`/enrichment-requests?account_id=${encodeURIComponent(id)}`, { tenant }),
  });

/** 201 for a new request; 200 with `joined` when it joined the open one of the same kind. */
export const createRequest = (tenant: string, id: string, body: NewRequest) =>
  apiFetch<EnrichmentRequest & { joined: boolean }>(path(id, '/enrichment-requests'), { tenant, method: 'POST', body });
