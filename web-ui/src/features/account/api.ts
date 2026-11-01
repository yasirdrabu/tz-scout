import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { apiFetch } from '../../api/client';

// The account page (screens.md §4): the account, its score, facts, brief, HubSpot check, handoffs
// and activity (src/http/routes/v1/accounts/[id]/..., buying-roles). Every word, number and label is
// the API's (C6 to C8). The review, notes and dialogs come from features/review.

/** The review and the brief refetch every 30 seconds while the page is visible (C14). */
export const PAGE_REFRESH_MS = 30_000;
/** While Scout drafts the brief, or the HubSpot send runs, every 5 seconds. */
export const BUSY_REFRESH_MS = 5_000;

const path = (id: string, rest = '') => `/accounts/${encodeURIComponent(id)}${rest}`;

export type Person = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  email?: string | null;
  is_primary: boolean;
  decision_note: string | null;
  roles: { key: string; origin: string; label: string }[];
};

export type AccountSignal = {
  id: string;
  type: string | null;
  kind: string;
  title: string;
  detail: string | null;
  url: string | null;
  occurred_at: string | null;
  /** The source that found it (the nearest of vendor, agent and person), or null. */
  source_name: string | null;
};

export type AccountDetail = {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  hq_city: string | null;
  hq_state: string | null;
  people: Person[];
  signals: AccountSignal[];
};

/** Same key as the peek's signals, so both read one answer. */
export const accountQuery = (tenant: string, id: string) =>
  queryOptions({
    queryKey: ['account', tenant, id, 'detail'],
    queryFn: () => apiFetch<AccountDetail>(path(id), { tenant }),
  });

export type Tile = { key: string; label: string; value: number | null; max: number | null; note: string };

export type AccountScore = { tiles: Tile[]; warm_intro: { introducer_name: string | null; points: number } | null };

/** A 404 here means Scout has not scored the account yet. */
export const scoreQuery = (tenant: string, id: string) =>
  queryOptions({
    queryKey: ['account', tenant, id, 'score'],
    queryFn: () => apiFetch<AccountScore>(path(id, '/score'), { tenant }),
  });

export type Fact = {
  id: string;
  person_id: string | null;
  key: string;
  /** The fact's name, from the API (C6). */
  label: string;
  value: unknown;
  observed_at: string;
  source_names: { person: string | null; agent: string | null; vendor: string | null };
};

export const factsQuery = (tenant: string, id: string) =>
  queryOptions({
    queryKey: ['account', tenant, id, 'facts'],
    queryFn: () => apiFetch<{ data: Fact[]; next_cursor: string | null }>(path(id, '/facts'), { tenant }),
  });

export type WrittenBy = 'claude' | 'sample' | 'rules' | 'person';

export type BriefSection = {
  key: string;
  title: string;
  body: string | null;
  citations: string[];
  written_by: WrittenBy | null;
  label: string | null;
  edited_by_name: string | null;
  edited_at: string | null;
  written_for_offer_name: string | null;
  version: number | null;
};

export type Brief = {
  account_id: string;
  offer_id: string | null;
  offer_name: string | null;
  state: 'not_drafted' | 'drafting' | 'ready';
  last_drafted_at: string | null;
  recommendation: { headline: string; detail: string; written_by: WrittenBy; label: string } | null;
  sections: BriefSection[];
};

export const briefQuery = (tenant: string, id: string) =>
  queryOptions({
    queryKey: ['account', tenant, id, 'brief'],
    queryFn: () => apiFetch<Brief>(path(id, '/brief'), { tenant }),
    refetchInterval: (q) => (q.state.data?.state === 'drafting' ? BUSY_REFRESH_MS : PAGE_REFRESH_MS),
  });

export const saveSection = (tenant: string, id: string, key: string, body: string, ifVersion: number | null) =>
  apiFetch<BriefSection>(path(id, `/brief/sections/${encodeURIComponent(key)}`), {
    tenant,
    method: 'PUT',
    body: { body, ...(ifVersion !== null ? { if_version: ifVersion } : {}) },
  });

export const draftBrief = (tenant: string, id: string, includeEdited: string[]) =>
  apiFetch<{ state: 'drafting' }>(path(id, ':draft-brief'), { tenant, method: 'POST', body: { include_edited: includeEdited } });

export type CrmCheck =
  | { exists: null; checked_at: null }
  | {
      exists: boolean;
      owner_name: string | null;
      lifecycle: 'none' | 'open_deal' | 'customer';
      open_deals: number;
      open_deal: { name: string; amount_cents: number | null; currency: string | null; last_activity_at: string | null } | null;
      checked_at: string;
      hubspot_url: string | null;
    };

export const crmCheckQuery = (tenant: string, id: string) =>
  queryOptions({
    queryKey: ['account', tenant, id, 'crm-check'],
    queryFn: () => apiFetch<CrmCheck>(path(id, '/crm-check'), { tenant }),
  });

export const checkCrm = (tenant: string, id: string) => apiFetch<CrmCheck>(path(id, ':check-crm'), { tenant, method: 'POST' });

export type Handoffs = {
  handoffs: { id: string; status: string; crm_url: string | null; queued_at: string; completed_at: string | null }[];
  follow_through: { counts: { emails: number; replies: number }; checked_at: string | null } | null;
  deals: { id: string; name: string; status: string; amount_cents: number | null; currency: string | null }[];
  conflict: boolean;
};

export const handoffsQuery = (tenant: string, id: string) =>
  queryOptions({
    queryKey: ['account', tenant, id, 'handoffs'],
    queryFn: () => apiFetch<Handoffs>(path(id, '/handoffs'), { tenant }),
    refetchInterval: PAGE_REFRESH_MS,
  });

export type ActivityRow = { id: string; kind: string; at: string; summary: string };

export const activityQuery = (tenant: string, id: string) =>
  infiniteQueryOptions({
    queryKey: ['account', tenant, id, 'activity'],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      apiFetch<{ data: ActivityRow[]; next_cursor: string | null; synced_at: string | null }>(
        path(id, `/activity${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`),
        { tenant },
      ),
    getNextPageParam: (last) => last.next_cursor,
  });

export const buyingRolesQuery = (tenant: string) =>
  queryOptions({
    queryKey: ['buying-roles', tenant],
    queryFn: () => apiFetch<{ data: { key: string; label: string }[] }>('/buying-roles', { tenant }),
    staleTime: 5 * 60_000,
  });

export type NewPerson = { name: string; title?: string; email?: string; buying_role?: string };

export const addPerson = (tenant: string, id: string, person: NewPerson) =>
  apiFetch<{ person_id: string }>(path(id, '/people'), { tenant, method: 'POST', body: person });

export const personName = (p: Pick<Person, 'first_name' | 'last_name'>) => [p.first_name, p.last_name].filter(Boolean).join(' ') || 'Someone';
