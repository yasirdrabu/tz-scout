import { queryOptions } from '@tanstack/react-query';
import { apiFetch } from '../../../api/client';
import type { AiRun, RunStatus } from '../../admin/ai-runs/api';

// This workspace's AI runs (src/http/routes/v1/ai-runs, settings:manage): the admin list's rows without the
// tenant name, newest first, and this month's totals per task.

export type WorkspaceRun = Omit<AiRun, 'tenant_name'>;

export type TaskTotal = { task: string; runs: number; input_tokens: number; output_tokens: number; cost_cents: number };

export type WorkspaceRunFilters = { status: RunStatus | ''; task: string };

export const workspaceRunsQuery = (tenant: string, f: WorkspaceRunFilters) =>
  queryOptions({
    queryKey: ['ai-runs', tenant, f],
    queryFn: () => {
      const p = new URLSearchParams();
      if (f.status) p.set('status', f.status);
      if (f.task) p.set('task', f.task);
      const qs = p.toString();
      return apiFetch<{ data: WorkspaceRun[]; totals: TaskTotal[] }>(`/ai-runs${qs ? `?${qs}` : ''}`, { tenant });
    },
  });
