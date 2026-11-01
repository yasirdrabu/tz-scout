import { queryOptions } from '@tanstack/react-query';
import { apiFetch } from '../../api/client';

// Offers and practices (§19): src/http/routes/v1/{offers,practices}/**. The price line, the status words,
// the counts and the win rate come from the API (C6 to C8). Drafts and retired offers come back only
// to people with offers:manage.

export type OfferStatus = 'draft' | 'approved' | 'archived';
export type PriceModel = 'fixed' | 'starting_at' | 'per_month' | 'custom';

export type Practice = {
  id: string;
  name: string;
  description: string | null;
  status: 'active' | 'archived';
  lead_user_id: string | null;
  lead_name: string | null;
  offer_count: number;
};

export type Offer = {
  id: string;
  practice_id: string;
  name: string;
  status: OfferStatus;
  status_label: string;
  promise: string;
  description: string | null;
  key_offer: string | null;
  why_us: string | null;
  why_now: string | null;
  price_model: PriceModel | null;
  price_min_cents: number | null;
  price_max_cents: number | null;
  price_label: string | null;
  length_weeks: number | null;
  typical_deal_cents: number | null;
  sales_cycle_days: number | null;
  target_titles: string[];
  target_buying_roles: string[];
  industries: string[];
  company_size_min: number | null;
  company_size_max: number | null;
  proof_points: string[];
  updated_at: string;
};

export type OfferDetail = Offer & { practice_lead_name: string | null; can_delete: boolean };

export type OfferStat = { offer_id: string; practice_id: string; matched: number; won: number; win_rate: number | null };

/** What the form sends: the fields a person can set (status goes through :approve and :unapprove). */
export type OfferBody = Partial<
  Pick<
    Offer,
    | 'practice_id'
    | 'name'
    | 'promise'
    | 'description'
    | 'key_offer'
    | 'why_us'
    | 'why_now'
    | 'price_model'
    | 'price_min_cents'
    | 'price_max_cents'
    | 'length_weeks'
    | 'typical_deal_cents'
    | 'sales_cycle_days'
    | 'target_titles'
    | 'industries'
    | 'company_size_min'
    | 'company_size_max'
    | 'proof_points'
  >
>;

export type PracticeBody = { name?: string; description?: string | null; lead_user_id?: string | null };

type Page<T> = { data: T[]; next_cursor: string | null };

export const practicesQuery = (tenant: string) =>
  queryOptions({
    queryKey: ['offers', tenant, 'practices'],
    queryFn: () => apiFetch<Page<Practice>>('/practices?limit=200', { tenant }).then((r) => r.data),
  });

export const practiceQuery = (tenant: string, id: string) =>
  queryOptions({
    queryKey: ['offers', tenant, 'practice', id],
    queryFn: () => apiFetch<Practice>(`/practices/${encodeURIComponent(id)}`, { tenant }),
  });

/** Every offer the caller may see, any status: the tree and the cards come from one list. */
export const offersQuery = (tenant: string) =>
  queryOptions({
    queryKey: ['offers', tenant, 'list'],
    queryFn: () => apiFetch<Page<Offer>>('/offers?limit=200', { tenant }).then((r) => r.data),
  });

export const offerQuery = (tenant: string, id: string) =>
  queryOptions({
    queryKey: ['offers', tenant, 'one', id],
    queryFn: () => apiFetch<OfferDetail>(`/offers/${encodeURIComponent(id)}`, { tenant }),
  });

export const offerStatsQuery = (tenant: string) =>
  queryOptions({
    queryKey: ['offers', tenant, 'stats'],
    queryFn: () => apiFetch<{ data: OfferStat[] }>('/offers/stats', { tenant }).then((r) => new Map(r.data.map((s) => [s.offer_id, s]))),
  });

const path = (id: string) => `/offers/${encodeURIComponent(id)}`;

/** A PATCH that moved an approved offer back to draft carries `warning`. */
export type Saved = Offer & { warning?: string };

export const createOffer = (tenant: string, body: OfferBody) => apiFetch<Offer>('/offers', { tenant, method: 'POST', body });
export const patchOffer = (tenant: string, id: string, body: OfferBody) => apiFetch<Saved>(path(id), { tenant, method: 'PATCH', body });
export const approveOffer = (tenant: string, id: string) => apiFetch<Offer>(`${path(id)}:approve`, { tenant, method: 'POST' });
export const unapproveOffer = (tenant: string, id: string) => apiFetch<Offer>(`${path(id)}:unapprove`, { tenant, method: 'POST' });
export const retireOffer = (tenant: string, id: string) => apiFetch<Offer>(`${path(id)}:archive`, { tenant, method: 'POST' });
export const deleteOffer = (tenant: string, id: string) => apiFetch<void>(path(id), { tenant, method: 'DELETE' });

export const createPractice = (tenant: string, body: PracticeBody) => apiFetch<Practice>('/practices', { tenant, method: 'POST', body });
export const patchPractice = (tenant: string, id: string, body: PracticeBody) => apiFetch<Practice>(`/practices/${encodeURIComponent(id)}`, { tenant, method: 'PATCH', body });
export const archivePractice = (tenant: string, id: string) => apiFetch<Practice>(`/practices/${encodeURIComponent(id)}:archive`, { tenant, method: 'POST' });

/** The status dot's tone for an offer status. */
export const statusTone = (s: OfferStatus) => (s === 'approved' ? 'good' : s === 'draft' ? 'near' : 'neutral');
