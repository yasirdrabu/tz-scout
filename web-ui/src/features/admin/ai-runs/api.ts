import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { apiFetch } from '../../../api/client';

// Every tenant's AI runs (src/http/routes/v1/admin/ai-runs, Decision 24). Platform admins only.

export type RunStatus = 'succeeded' | 'failed' | 'stopped_by_limit';

/** The statuses the API filters by, as the screen names them (screens.md §23). */
export const STATUSES: { status: RunStatus; label: string }[] = [
  { status: 'succeeded', label: 'Succeeded' },
  { status: 'failed', label: 'Failed' },
  { status: 'stopped_by_limit', label: 'Stopped by limit' },
];

export const statusLabel = (s: RunStatus) => STATUSES.find((x) => x.status === s)?.label ?? s;

export type AiRun = {
  id: string;
  tenant_id: string;
  tenant_name: string | null;
  task: string;
  prompt_version: string;
  mode: string;
  /** Null for runs Scout answered by rules, without the model. */
  model: string | null;
  status: RunStatus;
  /** The stored outcome: `invalid_output` is a failed run whose answer Scout rejected. */
  outcome: string;
  subject: { type: string; id: string } | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_cents: number;
  duration_ms: number;
  created_at: string;
};

export type AiRunDetail = AiRun & { input_hash: string | null; output: unknown; error: string | null };

export type RunsSummary = {
  runs_today: number;
  /** 0 to 100 with one decimal; null with no runs today. */
  failed_pct: number | null;
  median_ms: number | null;
  slowest_task: string | null;
  spend_today_cents: number;
  failed_last_hour: number;
};

export type RunFilters = { q: string; status: RunStatus | ''; task: string; tenant: string };

type Page = { data: AiRun[]; next_cursor: string | null; summary: RunsSummary };

export const runsQuery = (f: RunFilters) =>
  infiniteQueryOptions({
    queryKey: ['admin', 'ai-runs', f],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams();
      if (f.q) p.set('q', f.q);
      if (f.status) p.set('status', f.status);
      if (f.task) p.set('task', f.task);
      if (f.tenant) p.set('tenant', f.tenant);
      // The cursor is opaque: it goes back exactly as the API sent it.
      if (pageParam) p.set('cursor', pageParam);
      const qs = p.toString();
      return apiFetch<Page>(`/admin/ai-runs${qs ? `?${qs}` : ''}`);
    },
    getNextPageParam: (last) => last.next_cursor,
  });

/** One run: any tenant's (platform admins), or with `tenant` one of that workspace's (`settings:manage`). */
export const runQuery = (id: string, tenant?: string) =>
  queryOptions({
    queryKey: tenant ? ['ai-run', tenant, id] : ['admin', 'ai-run', id],
    queryFn: () =>
      tenant
        ? apiFetch<AiRunDetail>(`/ai-runs/${encodeURIComponent(id)}`, { tenant })
        : apiFetch<AiRunDetail>(`/admin/ai-runs/${encodeURIComponent(id)}`),
    staleTime: Infinity,
  });

/** A task key as words: `csv_column_mapping` is "Csv column mapping". The API sends no labels. */
export const taskLabel = (task: string) => {
  const words = task.replace(/[_-]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : task;
};
