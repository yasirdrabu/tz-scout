import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../../api/client';
import type { Color } from '../../review/api';

// Settings > Review statuses (src/http/routes/v1/settings/review, settings:manage): the statuses,
// every reason and auto-accept with their counts, saved in one PUT (Ruling 19). Words, colors and
// counts come from the API (C6 to C8).

export type SettingsStatus = {
  key: string;
  label: string;
  order: number;
  color: Color;
  description: string;
  set_by: 'scout' | 'reviewer';
  flag_after_hours: number | null;
  is_initial: boolean;
  is_final: boolean;
  required: boolean;
  archived: boolean;
  in_status_count: number | null;
  late_count: number | null;
};

export type ReasonList = 'review' | 'assignment' | 'both' | 'send_back';

export type SettingsReason = {
  key: string;
  label: string;
  applies_to: ReasonList;
  note_required: boolean;
  order: number;
  archived: boolean;
  used_this_quarter: number | null;
};

export type ReviewSettings = {
  statuses: SettingsStatus[];
  decline_reasons: SettingsReason[];
  auto_accept_working_days: number | null;
  colors: { value: Color; label: string }[];
};

export type StatusEdit = { key: string | null; label: string; color: string; description: string; set_by: string; flag_after_hours: number | null; archived: boolean };
export type ReasonEdit = { key: string | null; label: string; applies_to: ReasonList; note_required: boolean; archived: boolean };
export type ReviewSettingsSave = { statuses?: StatusEdit[]; reasons?: ReasonEdit[]; auto_accept_working_days?: number | null };

export const reviewSettingsQuery = (tenant: string) =>
  queryOptions({
    queryKey: ['review-settings', tenant],
    queryFn: () => apiFetch<ReviewSettings>('/settings/review', { tenant }),
    // The editor starts from what it loaded; a refetch on focus would throw away unsaved changes.
    staleTime: Infinity,
  });

export const saveReviewSettings = (tenant: string, body: ReviewSettingsSave) => apiFetch<ReviewSettings>('/settings/review', { tenant, method: 'PUT', body });

export const restoreReviewDefaults = (tenant: string) => apiFetch<ReviewSettings>('/settings/review:reset', { tenant, method: 'POST', body: {} });

/** After a save: the editor shows what the API saved, and the queue, its filters and the dialogs read the new words. */
export function afterSave(qc: QueryClient, tenant: string, saved: ReviewSettings) {
  qc.setQueryData(['review-settings', tenant], saved);
  for (const key of ['review-statuses', 'review-reasons', 'review-queue', 'account']) void qc.invalidateQueries({ queryKey: [key, tenant] });
}
