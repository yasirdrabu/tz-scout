import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { API_BASE, apiFetch, newCorrelationId } from '../../api/client';
import { errorFrom } from '../../api/errors';

// Batches and imports (§13), Batch detail (§14) and Import a list (§15): src/http/routes/v1/batches/**,
// imports/** and arrivals/{id}:supply-*. The status, issue, progress words, outcome words and every count
// come from the API (C6 to C8).

export type BatchStatusKey = 'complete' | 'in_progress' | 'needs_attention' | 'failed';
export type Stages = { received: number; resolving: number; waiting: number; resolved: number; rejected: number };

export type BatchFile = { id: string; file_name: string; size_bytes: number; content_type: string };

export type Batch = {
  id: string;
  name: string;
  notes: string | null;
  run_at: string;
  completed_at: string | null;
  status: string;
  status_key: BatchStatusKey;
  status_label: string;
  issue: string | null;
  item_count: number;
  stages: Stages;
  progress_label: string;
  source: { id: string; name: string; kind: string } | null;
  sent_by: { kind: 'user' | 'api_key' | 'system'; id: string; name: string };
  files: BatchFile[];
  import: { id: string; status: string; error: string | null } | null;
  retryable: number;
};

export type BatchesMeta = {
  counts_by_status: Record<BatchStatusKey, number>;
  status_labels: Record<BatchStatusKey, string>;
  attention: { count: number; issues: string[] };
};

export type BatchesPage = { data: Batch[]; next_cursor: string | null; total: number; meta: BatchesMeta };

export type BatchDetail = Batch & { in_queue: number | null };

export type ItemOutcome = 'new_account' | 'matched' | 'rejected' | 'waiting' | 'resolving';
export type WaitingOn = 'needs_website' | 'needs_company' | 'possible_duplicate';

export type BatchItem = {
  id: string;
  status: string;
  waiting_on: WaitingOn | null;
  company_name: string | null;
  website: string | null;
  account_id: string | null;
  account_name: string | null;
  priority: number | null;
  tier_label: string | null;
  outcome: ItemOutcome;
  outcome_label: string;
  duplicate_candidates: { account_id: string; name: string; domain: string | null }[];
};

export type ItemTab = 'all' | 'waiting' | 'resolved' | 'rejected';

/** The Batches screen's search params (C10): `status` keys comma separated, `runDate` 7, 14 or 30 days. */
export type BatchesFilters = { status?: string; source?: string; sentBy?: string; runDate?: string; q?: string };

/** The day `runDate` days ago, as the API's `since`. */
export function sinceFor(runDate: string | undefined, now = new Date()): string | undefined {
  const days = Number(runDate);
  if (!runDate || !Number.isFinite(days) || days <= 0) return undefined;
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

function batchesParams(f: BatchesFilters, now?: Date) {
  const p = new URLSearchParams({ limit: '50' });
  for (const k of f.status?.split(',') ?? []) if (k) p.append('status_key', k);
  if (f.source) p.set('source_id', f.source);
  if (f.sentBy) p.set('sent_by', f.sentBy);
  const since = sinceFor(f.runDate, now);
  if (since) p.set('since', since);
  if (f.q) p.set('q', f.q);
  return p;
}

const anyInProgress = (pages: BatchesPage[] | undefined) => !!pages?.some((p) => p.data.some((b) => b.status_key === 'in_progress'));

/** The batch list; it polls every 30 s while any batch is in progress (C14). */
export const batchesQuery = (tenant: string, f: BatchesFilters) =>
  infiniteQueryOptions({
    queryKey: ['batches', tenant, 'list', f],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const p = batchesParams(f);
      if (pageParam) p.set('cursor', pageParam);
      return apiFetch<BatchesPage>(`/batches?${p}`, { tenant });
    },
    getNextPageParam: (last) => last.next_cursor,
    refetchInterval: (query) => (anyInProgress(query.state.data?.pages) ? 30_000 : false),
  });

/** The batches of one source and the sources under it (the Source page's Batches tab). */
export const sourceBatchesQuery = (tenant: string, sourceId: string) => batchesQuery(tenant, { source: sourceId });

export const batchQuery = (tenant: string, id: string) =>
  queryOptions({
    queryKey: ['batches', tenant, 'one', id],
    queryFn: () => apiFetch<BatchDetail>(`/batches/${encodeURIComponent(id)}`, { tenant }),
  });

export const batchItemsQuery = (tenant: string, id: string, tab: ItemTab) =>
  infiniteQueryOptions({
    queryKey: ['batches', tenant, 'items', id, tab],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ status: tab, limit: '50' });
      if (pageParam) p.set('cursor', pageParam);
      return apiFetch<{ data: BatchItem[]; next_cursor: string | null; total: number }>(`/batches/${encodeURIComponent(id)}/items?${p}`, { tenant });
    },
    getNextPageParam: (last) => last.next_cursor,
  });

export const retryBatch = (tenant: string, id: string) => apiFetch<{ retried: number }>(`/batches/${encodeURIComponent(id)}:retry`, { tenant, method: 'POST' });

export const skipWaiting = (tenant: string, id: string) => apiFetch<{ skipped: number }>(`/batches/${encodeURIComponent(id)}:skip-waiting`, { tenant, method: 'POST' });

export const supplyWebsite = (tenant: string, arrivalId: string, website: string) =>
  apiFetch<unknown>(`/arrivals/${encodeURIComponent(arrivalId)}:supply-website`, { tenant, method: 'POST', body: { website } });

export type CompanyAnswer = { name: string; website?: string } | { sole_proprietor: true; person_name?: string };

export const supplyCompany = (tenant: string, arrivalId: string, body: CompanyAnswer) =>
  apiFetch<unknown>(`/arrivals/${encodeURIComponent(arrivalId)}:supply-company`, { tenant, method: 'POST', body });

export const chooseDuplicate = (tenant: string, arrivalId: string, body: { same_as: string } | { new_company: true }) =>
  apiFetch<unknown>(`/arrivals/${encodeURIComponent(arrivalId)}:choose`, { tenant, method: 'POST', body });

/** A file the API sends as an attachment, as a Blob; a failure is the API's problem as an ApiError. */
async function download(tenant: string, path: string, accept: string): Promise<Blob> {
  const ref = newCorrelationId();
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: { 'x-scout-tenant': tenant, 'x-correlation-id': ref, accept: `${accept}, application/problem+json` },
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    throw errorFrom(res.status, body, res.headers.get('x-correlation-id') ?? ref);
  }
  return res.blob();
}

export const downloadRejections = (tenant: string, id: string) => download(tenant, `/batches/${encodeURIComponent(id)}/rejections?format=csv`, 'text/csv');

export const downloadFile = (tenant: string, id: string, fileId: string) =>
  download(tenant, `/batches/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}`, '*/*');

/** Hands a file to the browser as a download. */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---- Imports ----

export type MappingColumn = { header: string; target: string | null; confidence: number; reason?: string };

export type ImportView = {
  id: string;
  batch_id: string;
  status: 'needs_confirm' | 'queued' | 'imported' | 'failed' | 'cancelled' | string;
  layout: string | null;
  headers: string[];
  row_count: number;
  mapping: MappingColumn[];
  mapping_origin: string | null;
  file: { name: string; type: string; size_bytes: number; sheet: string | null };
  sample_rows: string[][];
  targets: { key: string | null; label: string }[];
  uploaded_by: { user_id: string | null; name: string };
  source: { id: string; name: string; kind: string } | null;
  notes: string | null;
  suggested_count: number;
  stats: { error: string | null };
};

export type UploadAnswer =
  | { status: 'needs_sheet'; sheets: string[] }
  | { import_id: string; batch_id: string; status: 'needs_confirm' | 'queued'; needs_confirm: boolean };

export type UploadInput = { file: File; sourceId?: string; notes?: string; sheet?: string };

/** `POST /imports` as multipart: the file and the fields the API takes. */
export async function uploadImport(tenant: string, input: UploadInput): Promise<UploadAnswer> {
  const form = new FormData();
  form.set('file', input.file);
  if (input.sourceId) form.set('source_id', input.sourceId);
  if (input.notes) form.set('notes', input.notes);
  if (input.sheet) form.set('sheet', input.sheet);
  const ref = newCorrelationId();
  const res = await fetch(`${API_BASE}/imports`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'x-scout-tenant': tenant, 'x-correlation-id': ref, 'idempotency-key': crypto.randomUUID(), accept: 'application/json, application/problem+json' },
    body: form,
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw errorFrom(res.status, body, res.headers.get('x-correlation-id') ?? ref);
  return body as UploadAnswer;
}

/** The import; `poll` asks again every 2 s until it has run (the Resolve step, C14). */
export const importQuery = (tenant: string, id: string, poll = false) =>
  queryOptions({
    queryKey: ['imports', tenant, id],
    queryFn: () => apiFetch<ImportView>(`/imports/${encodeURIComponent(id)}`, { tenant }),
    refetchInterval: (query) => (poll && !['imported', 'failed'].includes(query.state.data?.status ?? '') ? 2_000 : false),
  });

export type ImportPreview = { total: number; without_website: number; go_ahead: number };

export const previewImport = (tenant: string, id: string, mapping: MappingColumn[]) =>
  apiFetch<ImportPreview>(`/imports/${encodeURIComponent(id)}:preview`, { tenant, method: 'POST', body: { mapping } });

export const confirmImport = (tenant: string, id: string, mapping: MappingColumn[]) =>
  apiFetch<{ import_id: string; status: 'queued' }>(`/imports/${encodeURIComponent(id)}:confirm`, { tenant, method: 'POST', body: { mapping } });

export const discardImport = (tenant: string, id: string) => apiFetch<void>(`/imports/${encodeURIComponent(id)}`, { tenant, method: 'DELETE' });
