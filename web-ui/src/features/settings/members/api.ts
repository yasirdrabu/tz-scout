import { queryOptions } from '@tanstack/react-query';
import { apiFetch } from '../../../api/client';
import type { DataLimit } from '../../../api/me';

// Members, roles and invites (src/http/routes/v1/members, src/http/routes/v1/roles). Member ids are membership ids.

export type MemberStatus = 'invited' | 'active' | 'suspended';

export type Member = {
  id: string;
  user_id: string;
  name: string;
  email: string;
  role: string;
  status: MemberStatus;
  last_active_at: string | null;
  sign_in_method: 'microsoft' | 'dev' | null;
  /** Null means the role's default. */
  data_limit: DataLimit | null;
  crm_owner_ids: Record<string, string>;
  extra_permissions: string[];
  open_account_count: number;
  /** What you may do to this member, from your own powers; `lock_reasons` says why not (null where allowed). */
  can_change_role: boolean;
  can_suspend: boolean;
  can_remove: boolean;
  can_sign_out: boolean;
  lock_reasons: Record<'change_role' | 'suspend' | 'remove' | 'sign_out', MemberLock | null>;
};

/** Why an action on a member is locked. */
export type MemberLock = 'self' | 'owner' | 'owners_only' | 'platform_admin' | 'last_owner' | 'no_permission';

/** Members per status, and active members per sign-in method (counted by the API, C8). */
export type MemberCounts = {
  all: number;
  active: number;
  invited: number;
  suspended: number;
  active_by_sign_in_method: { microsoft: number; dev: number };
};

export type MembersList = { data: Member[]; counts: MemberCounts };

export type Roles = {
  roles: { role: string; permissions: string[] }[];
  permissions: { key: string; label: string; group: string }[];
};

export type Practice = { id: string; name: string };

export const membersQuery = (tenant: string) =>
  queryOptions({
    queryKey: ['members', tenant],
    queryFn: () => apiFetch<MembersList>('/members', { tenant }),
  });

export const rolesQuery = (tenant: string) =>
  queryOptions({ queryKey: ['roles', tenant], queryFn: () => apiFetch<Roles>('/roles', { tenant }), staleTime: 5 * 60_000 });

export const practicesQuery = (tenant: string) =>
  queryOptions({
    queryKey: ['practices', tenant],
    queryFn: () => apiFetch<{ data: Practice[] }>('/practices?limit=200', { tenant }).then((r) => r.data),
    staleTime: 5 * 60_000,
  });

export type MemberPatch = { role?: string; data_limit?: DataLimit | null; crm_owner_ids?: Record<string, string> };

export const updateMember = (tenant: string, id: string, patch: MemberPatch) =>
  apiFetch<Member>(`/members/${encodeURIComponent(id)}`, { tenant, method: 'PATCH', body: patch });

export type MemberAction = 'suspend' | 'reactivate' | 'sign-out-everywhere';

export const memberAction = (tenant: string, id: string, action: MemberAction) =>
  apiFetch<Member | undefined>(`/members/${encodeURIComponent(id)}:${action}`, { tenant, method: 'POST' });

export const removeMember = (tenant: string, id: string) =>
  apiFetch<void>(`/members/${encodeURIComponent(id)}`, { tenant, method: 'DELETE' });

export type InviteResult =
  | { email: string; ok: true; membership_id: string; status: 'invited' | 'active' }
  | { email: string; ok: false; error: { slug: string; title: string } };

// The response's sign_in_url is not used: the link is this app's own sign-in page (signInAddress).
export const inviteMembers = (tenant: string, body: { emails: string[]; role: string; data_limit?: DataLimit | null }) =>
  apiFetch<{ results: InviteResult[] }>('/members', { tenant, method: 'POST', body });
