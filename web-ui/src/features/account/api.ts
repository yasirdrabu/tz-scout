import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { apiFetch } from '../../api/client';
import type { OwnerRole, StepChannel } from '../playbooks/api';

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
  /** Who wrote the note and when; null when a source wrote it. */
  decision_note_by?: { id: string; name: string | null } | null;
  decision_note_at?: string | null;
  roles: { key: string; origin: string; label: string; set_by_name?: string | null; set_at?: string | null }[];
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

export type CommitteeRole = {
  key: string;
  label: string;
  required: boolean;
  status: 'covered' | 'guessed' | 'gap';
  people: { id: string; name: string; title: string | null; origin: string }[];
};

/** Which buying roles the lead offer needs and who covers them (the API's words). */
export type Committee = {
  offer: { id: string; name: string } | null;
  roles: CommitteeRole[];
  summary: { covered: number; required: number; text: string };
  gaps: string[];
  core_roles: boolean;
};

/** Under `['account', tenant, id]`, so a finished enrichment request refreshes it with the rest. */
export const committeeQuery = (tenant: string, id: string) =>
  queryOptions({
    queryKey: ['account', tenant, id, 'committee'],
    queryFn: () => apiFetch<Committee>(path(id, '/committee'), { tenant }),
  });

function joinWith(items: string[], word: string) {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${word} ${items.at(-1)}`;
}
const article = (label: string) => `${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label.toLowerCase()}`;
/** "a business owner, a commercial buyer and a technical buyer". */
export const listWithAnd = (labels: string[]) => joinWith(labels.map(article), 'and');
/** "commercial buyer or technical buyer" (no article). */
export const listWithOr = (labels: string[]) => joinWith(labels.map((l) => l.toLowerCase()), 'or');

export type Tile = { key: string; label: string; value: number | null; max: number | null; note: string };

export type WarmIntro = {
  warm_intro_id: string;
  introducer_name: string | null;
  relationship_key: string;
  relationship_label: string;
  /** What counts now: half of `full_points` until someone confirms. */
  points: number;
  full_points: number;
  confirmed: boolean;
  can_confirm: boolean;
};

export type AccountScore = { tiles: Tile[]; warm_intro: WarmIntro | null };

/** Confirms an agent-declared warm intro so it counts in full. */
export const confirmWarmIntro = (tenant: string, warmIntroId: string) =>
  apiFetch<{ warm_intro: WarmIntro }>(`/warm-intros/${encodeURIComponent(warmIntroId)}:confirm`, { tenant, method: 'POST' });

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

export type ConflictFact = {
  id: string;
  value: unknown;
  observed_at: string;
  source_names: Fact['source_names'];
  trust: number;
  status: string;
};

/** Sources that disagree on one fact (Rulings 4 to 7): open, or resolved in the last 30 days. */
export type Conflict = {
  id: string;
  key: string;
  label: string;
  person_id: string | null;
  status: 'open' | 'resolved';
  resolution: 'kept' | 'edited' | null;
  kept_fact_id: string | null;
  resolved_by_name: string | null;
  resolved_at: string | null;
  note: string | null;
  /** One line on why the sources may differ, or null (none in rules or mock mode). */
  explanation: string | null;
  facts: ConflictFact[];
};

export const conflictsQuery = (tenant: string, id: string) =>
  queryOptions({
    queryKey: ['account', tenant, id, 'conflicts'],
    queryFn: () => apiFetch<{ data: Conflict[]; next_cursor: string | null }>(path(id, '/conflicts'), { tenant }),
  });

/** Keeps one value; on a resolved conflict it changes the kept value (Ruling 6). */
export const resolveConflict = (tenant: string, conflictId: string, keptFactId: string, note?: string) =>
  apiFetch<Conflict>(`/conflicts/${encodeURIComponent(conflictId)}:resolve`, {
    tenant,
    method: 'POST',
    body: { kept_fact_id: keptFactId, ...(note ? { note } : {}) },
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
  follow_through: {
    counts: { emails: number; replies: number; meetings: number };
    meetings_held: number;
    /** The earliest meeting still to come; `with` is null when there is no title or named attendee. */
    next_meeting: { at: string; with: string | null } | null;
    checked_at: string | null;
  } | null;
  deals: { id: string; name: string; status: string; amount_cents: number | null; currency: string | null }[];
  conflict: boolean;
};

export const handoffsQuery = (tenant: string, id: string) =>
  queryOptions({
    queryKey: ['account', tenant, id, 'handoffs'],
    queryFn: () => apiFetch<Handoffs>(path(id, '/handoffs'), { tenant }),
    refetchInterval: PAGE_REFRESH_MS,
  });

export type ActivityRow = {
  id: string;
  kind: string;
  at: string;
  /** Who did it (the API's words), or null. */
  who: string | null;
  actor: 'person' | 'contact' | 'scout';
  /** What happened. */
  summary: string;
};

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

export type EngagementState = 'met' | 'replied' | 'emailed' | 'not_contacted';

/** Per person, from the CRM activity since the handoff; `gap_role` names the first required role nobody covers. */
export type Engagement = {
  people: { person_id: string; state: EngagementState; at: string | null }[];
  engaged: number;
  total: number;
  gap_role: string | null;
};

export const engagementQuery = (tenant: string, id: string) =>
  queryOptions({
    queryKey: ['account', tenant, id, 'engagement'],
    queryFn: () => apiFetch<Engagement>(path(id, '/engagement'), { tenant }),
    refetchInterval: PAGE_REFRESH_MS,
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

export type PersonPatch = { role_keys?: string[]; confirm_role_keys?: string[]; decision_note?: string };

/** An empty `decision_note` clears it: the API takes a string, not null. */
export const editPerson = (tenant: string, personId: string, body: PersonPatch) =>
  apiFetch<Person>(`/people/${encodeURIComponent(personId)}`, { tenant, method: 'PATCH', body });

export const personName = (p: Pick<Person, 'first_name' | 'last_name'>) => [p.first_name, p.last_name].filter(Boolean).join(' ') || 'Someone';

export type PlanStatus = 'active' | 'paused' | 'completed' | 'stopped' | 'abandoned';
export type StepStatus = 'todo' | 'in_progress' | 'done' | 'skipped';

export type PlanStep = {
  id: string;
  order: number;
  day: number;
  channel: StepChannel;
  owner_role: OwnerRole;
  owner_user_id: string | null;
  owner_name: string | null;
  title: string;
  detail: string | null;
  subject: string | null;
  body: string | null;
  status: StepStatus;
  note: string | null;
  due_date: string | null;
  done_at: string | null;
  done_by: string | null;
  origin: 'template' | 'added' | 'edited';
  crm_task: boolean;
  target_buying_roles: string[];
  /** The account's people who hold a target role (stated or set by a person), read live. */
  people: { id: string; name: string }[];
  /** Target roles nobody holds. */
  missing_roles: string[];
  overdue: boolean;
  due_today: boolean;
};

export type PlanHistory = { id: string; kind: string; step_id: string | null; detail: unknown; by: string | null; by_name: string | null; at: string };

export type Plan = {
  id: string;
  account_id: string;
  status: PlanStatus;
  status_reason: string | null;
  playbook: { id: string; name: string; version: number };
  newer_version: boolean;
  customised: boolean;
  start_date: string;
  /** Days since the plan started, and the last step's day. */
  day: number;
  days: number;
  steps: PlanStep[];
  history: PlanHistory[];
};

/** Under `['account', tenant, id]`, so what refreshes the account refreshes the plan. A 404 means no plan. */
export const planQuery = (tenant: string, id: string) =>
  queryOptions({
    queryKey: ['account', tenant, id, 'plan'],
    queryFn: () => apiFetch<Plan>(path(id, '/plan'), { tenant }),
  });

export type StepPatch = {
  status?: StepStatus;
  note?: string | null;
  owner_user_id?: string | null;
  due_date?: string;
  title?: string;
  detail?: string | null;
  day?: number;
  channel?: StepChannel;
  subject?: string | null;
  body?: string | null;
  crm_task?: boolean;
  target_buying_roles?: string[];
};

export type NewStep = {
  day: number;
  channel: StepChannel;
  owner_role: OwnerRole;
  title: string;
  detail?: string | null;
  subject?: string | null;
  body?: string | null;
  target_buying_roles?: string[];
  crm_task?: boolean;
};

/** Returns the whole plan. */
export const addStep = (tenant: string, planId: string, body: NewStep) =>
  apiFetch<Plan>(`/plans/${encodeURIComponent(planId)}/steps`, { tenant, method: 'POST', body });

/** Returns the whole plan. A done step is a 409: skip it instead. */
export const removeStep = (tenant: string, planId: string, stepId: string) =>
  apiFetch<Plan>(`/plans/${encodeURIComponent(planId)}/steps/${encodeURIComponent(stepId)}`, { tenant, method: 'DELETE' });

/** Returns the whole plan. */
export const patchStep = (tenant: string, planId: string, stepId: string, body: StepPatch) =>
  apiFetch<Plan>(`/plans/${encodeURIComponent(planId)}/steps/${encodeURIComponent(stepId)}`, { tenant, method: 'PATCH', body });

export type PlanActionName = 'pause' | 'resume' | 'complete' | 'abandon';

/** Returns the whole plan; `reason` is for abandon. */
export const planAction = (tenant: string, planId: string, action: PlanActionName, reason?: string) =>
  apiFetch<Plan>(`/plans/${encodeURIComponent(planId)}:${action}`, { tenant, method: 'POST', body: reason ? { reason } : {} });
