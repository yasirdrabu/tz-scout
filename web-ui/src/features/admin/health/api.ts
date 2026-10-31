import { queryOptions } from '@tanstack/react-query';
import { apiFetch } from '../../../api/client';

// System health (src/app/v1/admin/health, jobs, schedules, test-event). Platform admins only.

export type Queue = { name: string; pending: number; ack_pending: number; oldest_age_ms: number | null };

export type DeadJob = {
  id: string;
  tenant_id: string;
  tenant_name: string | null;
  /** The queue (consumer) or job that gave up. */
  name: string;
  last_error: string | null;
  attempts: number;
  dead_at: string;
};

export type Schedule = {
  id: string;
  tenant_id: string;
  tenant_name: string | null;
  job_name: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
};

export type Health = {
  relay_lag_ms: number;
  /** False when the queues did not answer: `queues` is then empty. */
  queues_available: boolean;
  pending_total: number;
  queues: Queue[];
  dead_job_count: number;
  /** The newest 100. */
  dead_jobs: DeadJob[];
  schedules: Schedule[];
  ai_spend_today_cents: number;
};

/** Refreshed every 15 seconds while the page is visible (C14); TanStack Query pauses it in the background. */
export const REFRESH_MS = 15_000;

export const healthQuery = () =>
  queryOptions({
    queryKey: ['admin', 'health'],
    queryFn: () => apiFetch<Health>('/admin/health'),
    refetchInterval: REFRESH_MS,
  });

const path = (kind: 'jobs' | 'schedules', id: string, action: string) => `/admin/${kind}/${encodeURIComponent(id)}:${action}`;

export const retryJob = (id: string) => apiFetch<{ sent_id: string }>(path('jobs', id, 'retry'), { method: 'POST' });
export const discardJob = (id: string) => apiFetch<void>(path('jobs', id, 'discard'), { method: 'POST' });
export const pauseSchedule = (id: string) => apiFetch<void>(path('schedules', id, 'pause'), { method: 'POST' });
export const resumeSchedule = (id: string) => apiFetch<void>(path('schedules', id, 'resume'), { method: 'POST' });
export const runScheduleNow = (id: string) => apiFetch<{ job_id: string }>(path('schedules', id, 'run-now'), { method: 'POST' });
export const sendTestEvent = () => apiFetch<{ round_trip_ms: number }>('/admin/test-event', { method: 'POST' });
