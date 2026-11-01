import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../../api/client';

// Settings > Scoring weights (src/http/routes/v1/scoring, scoring:manage): the four weights and three tier
// cutoffs, a preview of a draft, and one PUT that saves and rescores every account (Decision 22).

export type Weights = { fit: number; intent: number; revenue: number; trust: number };
export type Cutoffs = { act_now: number; good_fit: number; watch: number };

export type Profile = {
  weights: Weights;
  tier_cutoffs: Cutoffs;
  /** The default profile, for Restore defaults. */
  defaults: { weights: Weights; tier_cutoffs: Cutoffs };
  version: number;
};

export type Draft = { weights: Weights; tier_cutoffs: Cutoffs };

export type PreviewSample = {
  account_id: string;
  name: string;
  fit: number;
  intent: number;
  revenue: number;
  trust: number;
  score_before: number;
  score_after: number;
  tier_before: string;
  tier_after: string;
};

export type Preview = { before: Record<string, number>; after: Record<string, number>; samples: PreviewSample[] };

export const profileQuery = (tenant: string) =>
  queryOptions({
    queryKey: ['scoring-profile', tenant],
    queryFn: () => apiFetch<Profile>('/scoring/profile', { tenant }),
    refetchOnWindowFocus: false,
  });

export const previewQuery = (tenant: string, draft: Draft) =>
  queryOptions({
    queryKey: ['scoring-preview', tenant, draft],
    queryFn: () => apiFetch<Preview>('/scoring/profile:preview', { tenant, method: 'POST', body: draft }),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

export const saveProfile = (tenant: string, body: Partial<Draft>) => apiFetch<Profile>('/scoring/profile', { tenant, method: 'PUT', body });

/** After a save the queue, the accounts and the rescore banner read the new scores. */
export function afterSave(qc: QueryClient, tenant: string) {
  for (const key of ['scoring-profile', 'scoring-preview', 'review-queue', 'account', 'last-rescore']) void qc.invalidateQueries({ queryKey: [key, tenant] });
}
