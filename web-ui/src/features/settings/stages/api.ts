import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../../api/client';

// Pipeline stages (src/http/routes/v1/stages, settings/stages): `GET /stages` for anyone who reads accounts,
// `PUT /settings/stages` (settings:manage) replaces the whole list. Words, triggers and limits are the API's.

export type TriggerLimit = 'first' | 'won' | 'one' | 'many';

export type Trigger = { key: string; label: string; limit: TriggerLimit };

export type Stage = {
  key: string;
  name: string;
  description: string | null;
  kind: 'flow' | 'exit';
  position: number;
  trigger: string;
  trigger_label: string;
  hubspot_stage: string | null;
  quarter_target: number | null;
  locked: 'first' | 'won' | null;
};

export type StagesView = { stages: Stage[]; defaults: Stage[]; triggers: Trigger[] };

/** One stage as the save sends it: `key` for a stage that exists, none for a new one. */
export type StageEdit = {
  key?: string;
  name: string;
  description: string | null;
  kind: 'flow' | 'exit';
  trigger: string;
  hubspot_stage: string | null;
  quarter_target: number | null;
};

export const stagesQuery = (tenant: string) =>
  queryOptions({
    queryKey: ['stages', tenant],
    queryFn: () => apiFetch<StagesView>('/stages', { tenant }),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

/** The editor's copy (settings:manage): the same view as `GET /stages`, for someone who may not read accounts. */
export const settingsStagesQuery = (tenant: string) =>
  queryOptions({
    queryKey: ['settings-stages', tenant],
    queryFn: () => apiFetch<StagesView>('/settings/stages', { tenant }),
    refetchOnWindowFocus: false,
  });

export const saveStages = (tenant: string, stages: StageEdit[]) => apiFetch<StagesView>('/settings/stages', { tenant, method: 'PUT', body: { stages } });

/** After a save: the editor shows what the API saved, and every screen that reads stages reads them again. */
export function afterSave(qc: QueryClient, tenant: string, saved: StagesView) {
  qc.setQueryData(['settings-stages', tenant], saved);
  qc.setQueryData(['stages', tenant], saved);
  for (const key of ['account', 'review-queue', 'accounts', 'overview', 'sources']) void qc.invalidateQueries({ queryKey: [key, tenant] });
}
