import { queryOptions } from '@tanstack/react-query';
import { apiFetch } from '../../api/client';

// Playbooks (§20): src/http/routes/v1/playbooks/**. In the list `steps` is a count; in the detail it is the
// array. `days`, `channels`, `runs_on` and `running` describe the current version in both.

export type PlaybookStatus = 'draft' | 'active' | 'archived';
export type StepChannel = 'email' | 'linkedin' | 'call' | 'meeting' | 'task';
export type OwnerRole = 'seller' | 'leader' | 'operator';
export type StopWhen = 'reply_or_meeting' | 'meeting' | 'never';
export type Tier = 'act_now' | 'good_fit' | 'watch';

export type Playbook = {
  id: string;
  name: string;
  description: string | null;
  when_to_use: string | null;
  status: PlaybookStatus;
  stop_when: StopWhen;
  version: number;
  updated_at: string;
  /** How many steps the current version has. */
  steps: number;
  days: number;
  channels: Partial<Record<StepChannel, number>>;
  runs_on: { offer_id: string; tier: Tier }[];
  running: number;
};

export type PlaybookStep = {
  id: string;
  order: number;
  day: number;
  channel: StepChannel;
  owner_role: OwnerRole;
  title: string;
  detail: string | null;
  target_buying_roles: string[];
  crm_task: boolean;
  subject: string | null;
  body: string | null;
};

export type PlaybookDetail = Omit<Playbook, 'steps'> & {
  steps: PlaybookStep[];
  step_count: number;
  steps_version: number;
};

/** What create and patch accept. A step carries only these keys: the API refuses the others a GET returns. */
export type StepBody = Pick<PlaybookStep, 'day' | 'channel' | 'owner_role' | 'title'> &
  Partial<Pick<PlaybookStep, 'order' | 'detail' | 'target_buying_roles' | 'crm_task' | 'subject' | 'body'>>;

export type PlaybookBody = {
  name?: string;
  description?: string | null;
  when_to_use?: string | null;
  status?: PlaybookStatus;
  stop_when?: StopWhen;
  steps?: StepBody[];
};

type Page<T> = { data: T[]; next_cursor: string | null };

const path = (id: string) => `/playbooks/${encodeURIComponent(id)}`;

/** Every playbook, any status. */
export const playbooksQuery = (tenant: string) =>
  queryOptions({
    queryKey: ['playbooks', tenant, 'list'],
    queryFn: () => apiFetch<Page<Playbook>>('/playbooks?limit=200', { tenant }).then((r) => r.data),
  });

/** One playbook; `version` reads the steps of an earlier version. */
export const playbookQuery = (tenant: string, id: string, version?: number) =>
  queryOptions({
    queryKey: ['playbooks', tenant, 'one', id, version ?? 'current'],
    queryFn: () => apiFetch<PlaybookDetail>(version ? `${path(id)}?version=${version}` : path(id), { tenant }),
  });

export const createPlaybook = (tenant: string, body: PlaybookBody) => apiFetch<PlaybookDetail>('/playbooks', { tenant, method: 'POST', body });
export const patchPlaybook = (tenant: string, id: string, body: PlaybookBody) => apiFetch<PlaybookDetail>(path(id), { tenant, method: 'PATCH', body });
export const duplicatePlaybook = (tenant: string, id: string) => apiFetch<PlaybookDetail>(`${path(id)}:duplicate`, { tenant, method: 'POST' });
export const archivePlaybook = (tenant: string, id: string) => apiFetch<PlaybookDetail>(`${path(id)}:archive`, { tenant, method: 'POST' });
export const deletePlaybook = (tenant: string, id: string) => apiFetch<void>(path(id), { tenant, method: 'DELETE' });

// Words the API does not send for these (templates carry no label field).
export const STATUS_WORD: Record<PlaybookStatus, string> = { active: 'Active', draft: 'Draft', archived: 'Retired' };
export const statusTone = (s: PlaybookStatus) => (s === 'active' ? 'good' : s === 'draft' ? 'near' : 'neutral');
export const CHANNEL_WORD: Record<StepChannel, string> = { email: 'Email', linkedin: 'LinkedIn', call: 'Call', meeting: 'Meeting', task: 'Task' };
export const OWNER_WORD: Record<OwnerRole, string> = { seller: 'Seller', leader: 'Leader', operator: 'Operator' };
export const STOP_WORD: Record<StopWhen, string> = { reply_or_meeting: 'They reply or book a meeting', meeting: 'They book a meeting', never: 'Run every step' };
export const TIER_WORD: Record<Tier, string> = { act_now: 'Act now', good_fit: 'Good fit', watch: 'Watch' };
export const TIER_TONE = { act_now: 'good', good_fit: 'accent', watch: 'neutral' } as const;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** "{n} steps over {d} days"; `lastDay` is the last step's 0-based day, so a template with days 0..10 spans 11 days. */
export const span = (steps: number, lastDay: number) => `${plural(steps, 'step', 'steps')} over ${plural(lastDay + 1, 'day', 'days')}`;
/** "Email 2 · Call 1", in the order of the channels. */
export const mix = (channels: Playbook['channels']) =>
  (Object.keys(CHANNEL_WORD) as StepChannel[])
    .filter((c) => channels[c])
    .map((c) => `${CHANNEL_WORD[c]} ${channels[c]}`)
    .join(' · ');
