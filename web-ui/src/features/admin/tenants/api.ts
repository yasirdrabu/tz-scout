import { queryOptions } from '@tanstack/react-query';
import { apiFetch } from '../../../api/client';

// Tenants and platform admins (src/app/v1/admin/tenants, platform-admins). Platform admins only.

export type AdminTenant = {
  id: string;
  slug: string;
  name: string;
  currency: string;
  timezone: string;
  status: 'active' | 'suspended';
  created_at: string;
  /** Invited and active members. */
  member_count: number;
  owner: { name: string; email: string } | null;
};

export type TenantsList = { data: AdminTenant[]; summary: { total: number; active: number; suspended: number } };

export const tenantsQuery = () =>
  queryOptions({
    queryKey: ['admin', 'tenants'],
    queryFn: () => apiFetch<TenantsList>('/admin/tenants'),
  });

export type NewTenant = { name: string; slug: string; owner_email: string; currency: string; timezone: string };

export const createTenant = (body: NewTenant) => apiFetch<AdminTenant>('/admin/tenants', { method: 'POST', body });

export const setTenantStatus = (id: string, action: 'suspend' | 'resume') =>
  apiFetch<AdminTenant>(`/admin/tenants/${encodeURIComponent(id)}:${action}`, { method: 'POST' });

export type PlatformAdmin = { user_id: string; name: string; email: string; last_sign_in_at: string | null };

export const platformAdminsQuery = () =>
  queryOptions({
    queryKey: ['admin', 'platform-admins'],
    queryFn: () => apiFetch<{ data: PlatformAdmin[] }>('/admin/platform-admins').then((r) => r.data),
  });

export const addPlatformAdmin = (email: string) => apiFetch<PlatformAdmin>('/admin/platform-admins', { method: 'POST', body: { email } });

export const removePlatformAdmin = (userId: string) =>
  apiFetch<void>(`/admin/platform-admins/${encodeURIComponent(userId)}`, { method: 'DELETE' });

/** Where a workspace lives in this app. */
export const workspaceHost = (slug: string) => `${window.location.host}/t/${slug}`;

/** A slug from a company name: lowercase letters, numbers and dashes, up to 40 characters. */
export const slugFrom = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
