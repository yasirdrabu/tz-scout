import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../../api/client';

// Warm intros (src/http/routes/v1/settings/warm-intros): `GET` and `PUT /settings/warm-intros` (scoring:manage).
// The PUT replaces the whole tab: rules left out are deleted, rules without an id are created.

export type Relationship = { key: string; label: string; points: number; intro_count: number };

export type Rule = {
  id: string;
  introducer_user_id: string | null;
  introducer_email: string | null;
  introducer_name: string | null;
  relationship_key: string;
  points: number;
  intro_count: number;
};

export type Introducer = { user_id: string | null; email: string | null; name: string | null; intro_count: number };

export type WarmIntrosView = { relationships: Relationship[]; rules: Rule[]; introducers: Introducer[] };

export type SavedWarmIntros = WarmIntrosView & { rescoring_account_count: number };

/** One rule as the save sends it: `id` for a rule that exists, none for a new one. */
export type RuleEdit = {
  id?: string;
  introducer_user_id?: string;
  introducer_email?: string;
  introducer_name?: string;
  relationship_key: string;
  points: number;
};

export type WarmIntrosEdit = { relationships: { key: string; points: number }[]; rules: RuleEdit[] };

export const warmIntrosKey = (tenant: string) => ['settings', tenant, 'warm-intros'] as const;

export const warmIntrosQuery = (tenant: string) =>
  queryOptions({
    queryKey: warmIntrosKey(tenant),
    queryFn: () => apiFetch<WarmIntrosView>('/settings/warm-intros', { tenant }),
    refetchOnWindowFocus: false,
  });

export const saveWarmIntros = (tenant: string, body: WarmIntrosEdit) =>
  apiFetch<SavedWarmIntros>('/settings/warm-intros', { tenant, method: 'PUT', body });

/** After a save: the editor shows what the API saved, and the screens that show scores read them again. */
export function afterSave(qc: QueryClient, tenant: string, saved: SavedWarmIntros) {
  const { relationships, rules, introducers } = saved;
  qc.setQueryData(warmIntrosKey(tenant), { relationships, rules, introducers });
  for (const key of ['account', 'review-queue', 'accounts', 'overview']) void qc.invalidateQueries({ queryKey: [key, tenant] });
}

export const savedToast = (n: number) => (n === 0 ? 'Warm intros saved.' : `Warm intros saved. Rescoring ${n} ${n === 1 ? 'account' : 'accounts'}.`);
