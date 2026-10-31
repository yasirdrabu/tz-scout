import { queryOptions } from '@tanstack/react-query';
import { apiFetch } from '../../../api/client';
import type { DataLimit } from '../../../api/me';

// Members, roles and invites (src/app/v1/members, src/app/v1/roles). Member ids are membership ids.

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
};

export type Roles = {
  roles: { role: string; permissions: string[] }[];
  permissions: { key: string; label: string; group: string }[];
};

export type Practice = { id: string; name: string };

export const membersQuery = (tenant: string) =>
  queryOptions({
    queryKey: ['members', tenant],
    queryFn: () => apiFetch<{ data: Member[] }>('/members', { tenant }).then((r) => r.data),
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

export const inviteMembers = (tenant: string, body: { emails: string[]; role: string; data_limit?: DataLimit | null }) =>
  apiFetch<{ results: InviteResult[]; sign_in_url: string }>('/members', { tenant, method: 'POST', body });
